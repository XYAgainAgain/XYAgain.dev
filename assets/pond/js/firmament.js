import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, texture, vec2, vec3, float, uint, uvec3, floor, fract, sin, cos, exp, log, dot, length, mix, smoothstep, step, If } from 'three/tsl';
import { createRng, deriveSeed } from './rng.js';
import { valueNoise2 } from './shading.js';
import {
  CELL_BIAS, METEOR_SALT, SESSION_CELLS, FLASH_SLOTS, FLASH_TIME, SKY_LOOP, GAL_SLOW, GAL_FAST, uvToSample, toUniverse,
  createSkyClock, stepSkyClock, skyFrame, sceneDelta, twinklePhases, createSessionSky, addSessionStar, rainPasses, createFlashRing, pushFlash, flashLevel, quietFlashes,
  createMeteorSky, stepMeteors, meteorState, stepCometPhase, nearestGalaxy, startWave, waveState,
} from './void-sky-core.js';

/* The universe Sam's body is a window onto. Seeded 420 and never from ?seed, so every visitor sees the
   same sky; nothing here is ever read by a decision, which is what keeps it out of the trace hash. */
export const FIRMAMENT_SEED = 420;

const TAU = Math.PI * 2;
const tmpS = {}, tmpP = {}, tmpM = {}, tmpW = {}, tmpT = {};
const num = (d, dflt) => (Number.isFinite(d?.value) ? d.value : dflt);

/* Three tiers, because one was the field that failed: a sub-pixel dust nobody can count, a sparse tier
   of real dots, and a handful of bright ones. `cells` is per screen height, so the tiers scale together
   and `mag` is the magnitude exponent, steep on purpose. */
const DUST = { cells: 150, density: 0.62, alpha: 0.60, mag: 6.0 };
const MID = { cells: 34, density: 0.34, alphaLo: 0.74, alphaHi: 1.45, mag: 4.2 };
const BRIGHT = { cells: 9, density: 0.36, alphaLo: 1.15, alphaHi: 2.50, mag: 2.3 };

/* pcg3d (Jarzynski and Olano), Cosmorph's workhorse: three decorrelated floats from one integer lattice
   point, and integer math so both backends agree where a float hash drifts. */
const pcg3d = Fn(([vIn]) => {
  const v = vIn.toVar();
  v.assign(v.mul(uint(1664525)).add(uint(1013904223)));
  v.x.addAssign(v.y.mul(v.z));
  v.y.addAssign(v.z.mul(v.x));
  v.z.addAssign(v.x.mul(v.y));
  // WGSL rejects vecN >> scalar, so the shift amount has to be a matching vector.
  v.assign(v.bitXor(v.shiftRight(uvec3(uint(16), uint(16), uint(16)))));
  v.x.addAssign(v.y.mul(v.z));
  v.y.addAssign(v.z.mul(v.x));
  v.z.addAssign(v.x.mul(v.y));
  return v;
});

export const hash3 = Fn(([ip]) => {
  const h = pcg3d(uvec3(uint(ip.x), uint(ip.y), uint(ip.z)));
  return vec3(h.x.toFloat(), h.y.toFloat(), h.z.toFloat()).mul(2.3283064365386963e-10);
});

/* Moffat beta=2 point spread, flux-preserving: a star narrower than a texel is dimmed rather than
   shrunk, or the whole field shimmers and pops as the universe drifts across the pixel grid. */
const moffat = Fn(([d, aTrue]) => {
  const aC = aTrue.max(0.72);
  const a2 = aC.mul(aC);
  const x = float(1).div(dot(d, d).div(a2).add(1));
  return x.mul(x).mul(aTrue.mul(aTrue).div(a2));
});

/* Temperature ramp: red dwarf through orange and white to blue-white, the white plateau wide because
   that is where most of a real field sits. */
const starTint = Fn(([t]) => {
  const warm = mix(vec3(1.00, 0.46, 0.28), vec3(1.00, 0.80, 0.52), smoothstep(0.01, 0.14, t));
  const pale = mix(warm, vec3(1.00, 1.00, 1.00), smoothstep(0.12, 0.42, t));
  return mix(pale, vec3(0.70, 0.80, 1.00), smoothstep(0.55, 0.92, t));
});

/* Two temporal octaves, amplitude only: a star dims by at most `amt` and never brightens, so scintillation
   cannot inflate the field's total flux. `tw` holds both octaves' phases, whole cycles per sky loop. */
const twinkleMod = Fn(([tw, phase, amt]) => {
  const w = sin(tw.x.add(phase).mul(TAU)).mul(0.62)
    .add(sin(tw.y.add(phase.mul(2.7)).mul(TAU)).mul(0.38));
  return float(1).sub(amt).add(amt.mul(w.mul(0.5).add(0.5)));
});

export class Firmament {
  /* U and V are the scene uniforms and the void dials; the CPU needs both to put a drop, a touch, or a
     streak at the same universe point the body shader will sample there. */
  constructor({ seed = FIRMAMENT_SEED, U = null, V = null } = {}) {
    // Integer lattice offsets, one per hashed field, so the four cannot share a cell grid. Exactly four
    // draws: one more would move every star in the sky.
    const rng = createRng(seed);
    this.off = [0, 1, 2, 3].map(() => rng.int(0, 4096) * 8 + 1);
    this.ready = true;
    this.U = U;
    this.V = V;
    // The render target's aspect, written by the body material's own per-render uniform.
    this.aspect = 0;
    this.clock = 0;

    // The sky's own loop (void-sky-core): nothing on the GPU reads the scene clock, only these phases.
    const t0 = U ? U.time.value : 0;
    this.loop = createSkyClock(t0, U ? U.motionScale.value : 1, {
      spin: num(V?.spin, 0), drift: num(V?.drift, 0), galSpin: num(V?.galSpin, 1), nebDrift: num(V?.nebDrift, 0),
    });
    this.loopAt = t0;
    this.stepOptsLoop = { live: true, spin: 0, drift: 0, galSpin: 1, nebDrift: 0 };
    // The twinkle's two octave phases, the galaxies' turn of the loop, and the nebula's scroll in tile units.
    this.uTwinkle = uniform(new THREE.Vector2());
    this.uGalPhase = uniform(0);
    this.uNebScroll = uniform(new THREE.Vector2());
    this.publish();

    // Session stars: a slot table in universe cells, one texel a star, uploaded whole on a frame that
    // added one. Nearest filtering and explicit level 0, so a texel is read exactly and never blended.
    this.sky = createSessionSky();
    const tex = new THREE.DataTexture(this.sky.bytes, this.sky.res, this.sky.res, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.skyTex = tex;
    this.uSessionOn = uniform(0);
    this.flashes = createFlashRing();
    // (x, y) in the universe, level, unused.
    this.uFlash = uniformArray(Array.from({ length: FLASH_SLOTS }, () => new THREE.Vector4()));
    this.uFlashOn = uniform(0);

    // Meteors: their own stream off the same seed, on the frame clock, never a sim generator.
    this.meteors = createMeteorSky(createRng(deriveSeed(seed, METEOR_SALT)));
    // A: head xy, heading xy. B: trail length, width in pixels, level, comet flag. C: tail direction xy,
    // the comet tail's length, and its noise phase.
    this.uMetA = uniform(new THREE.Vector4());
    this.uMetB = uniform(new THREE.Vector4());
    this.uMetC = uniform(new THREE.Vector4());
    this.comet = { streak: null, phase: 0 };

    // The gravity wave: center xy in the universe, crest radius, and displacement at the crest.
    this.wave = null;
    this.uWave = uniform(new THREE.Vector4());
  }

  /* The CPU's copy of this render's sampling transform: the body's rot uniform reads this same function. */
  frame(out = tmpS) {
    return skyFrame(this.loop, num(this.V?.driftAngle, 0), out);
  }

  /* One frame of the loop, whether or not he is on screen, off the scene clock's delta. Idempotent within
     a frame, since a second call sees no delta. */
  advance() {
    const U = this.U, V = this.V;
    if (!U || !V) return;
    const now = U.time.value;
    const dt = sceneDelta(this.loopAt, now);
    this.loopAt = now;
    const o = this.stepOptsLoop;
    o.live = U.motionScale.value >= 0.5;
    o.spin = num(V.spin, 0); o.drift = num(V.drift, 0); o.galSpin = num(V.galSpin, 1); o.nebDrift = num(V.nebDrift, 0);
    stepSkyClock(this.loop, dt, o);
    this.publish();
  }

  /* The loop's per-pixel clocks as uniforms, each a phase that is back at its start when T wraps. */
  publish() {
    const c = this.loop;
    const tw = twinklePhases(num(this.V?.twinkleRate, 1.75), c.T, tmpT);
    this.uTwinkle.value.set(tw.a, tw.b);
    this.uGalPhase.value = c.gal / SKY_LOOP;
    this.uNebScroll.value.set(c.nebX, c.nebY);
  }

  /* A screen uv (top-left origin) to the universe point the body samples there, rim lens aside. The
     aspect falls back to the view's until the body has rendered once. */
  uvToUniverse(u, v, fallbackAspect = 16 / 9, out = tmpP) {
    const aspect = this.aspect > 0 ? this.aspect : fallbackAspect;
    const sp = uvToSample(u, v, aspect, out);
    return toUniverse(sp.x, sp.y, this.frame(), out);
  }

  worldToUniverse(x, z, view, out = tmpP) {
    const w = view?.w > 0 ? view.w : 1, h = view?.h > 0 ? view.h : 1;
    return this.uvToUniverse(x / w + 0.5, z / h + 0.5, w / h, out);
  }

  /* A new star at screen uv (u, v), permanent for the session: one texel written, one pinprick flash.
     Returns the star's universe position, or null when there was no room within reach of the drop. */
  addStar(u, v, brightness = 1, warm = true, fallbackAspect) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    const p = this.uvToUniverse(u, v, fallbackAspect);
    const at = addSessionStar(this.sky, p.x, p.y, brightness, warm);
    if (!at) return null;
    this.uSessionOn.value = 1;
    pushFlash(this.flashes, at.x, at.y, Math.min(1, Math.max(0, brightness)), this.clock);
    return at;
  }

  /* The rain variant: one drop in four, at a third of the brightness. */
  addRainStar(u, v, warm = true, fallbackAspect) {
    if (!rainPasses(this.sky)) return null;
    return this.addStar(u, v, 1 / 3, warm, fallbackAspect);
  }

  /* One upload a frame at most, however many stars that frame added. */
  flush() {
    if (!this.sky.dirty) return;
    this.sky.dirty = false;
    this.skyTex.needsUpdate = true;
  }

  galaxyNear(x, y) {
    const V = this.V;
    if (!V) return null;
    const dens = num(V.galDensity, 0.55) * num(V.galaxies, 6) / 6 * (num(V.showGal, 1) > 0.5 ? 1 : 0);
    return nearestGalaxy(x, y, { cells: num(V.galCells, 5), dens, off: this.off[3] });
  }

  /* A touch at universe (x, y); `span` is the far end of his body from it, in screen heights. */
  startWave(x, y, span) {
    const V = this.V;
    this.wave = startWave(x, y, span, num(V?.waveCross, 0.6), num(V?.waveSettle, 0.4));
  }

  /* The frame-clock side, run only while he is on screen: flash levels, the meteor schedule, the wave.
     `anchor` is his midpoint in the universe and `span` his length, both in screen heights. */
  tick(dt, anchor, span) {
    const V = this.V, U = this.U;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.clock += step;
    let on = 0;
    const recs = this.flashes.recs;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const lvl = flashLevel(this.clock - r.born, FLASH_TIME) * r.gain;
      this.uFlash.array[i].set(r.x, r.y, lvl, 0);
      if (lvl > 0) on = 1;
    }
    this.uFlashOn.value = on;

    const reduced = !!U && U.motionScale.value < 0.5;
    // One options object for the life of the sky: this runs every frame he is on screen.
    const o = (this.stepOpts ??= { galaxyNear: (x, y) => this.galaxyNear(x, y) });
    o.every = num(V?.meteors, 40); o.reduced = reduced; o.anchor = anchor; o.span = span;
    const m = stepMeteors(this.meteors, step, o);
    if (m) {
      const s = meteorState(m, tmpM);
      this.uMetA.value.set(s.hx, s.hy, s.dx, s.dy);
      this.uMetB.value.set(s.trail, s.comet ? num(V?.cometComa, 2.4) : num(V?.meteorWidth, 1.1), s.level, s.comet ? 1 : 0);
      const ph = stepCometPhase(this.comet, m, step, reduced);
      this.uMetC.value.set(s.tx, s.ty, s.comet ? num(V?.cometTail, 0.09) : 0, ph);
    } else this.uMetB.value.z = 0;

    if (this.wave) {
      this.wave.age += step;
      const w = waveState(this.wave, tmpW);
      // Dropped by age, not by level: a wave is also at level 0 on the frame it starts.
      if (this.wave.age < this.wave.cross + this.wave.settle) this.uWave.value.set(this.wave.x, this.wave.y, w.r, num(V?.waveAmp, 0.02) * w.level);
      else { this.wave = null; this.uWave.value.w = 0; }
    }
  }

  /* Everything in flight ends: a park, a swap to Eleanor, or the pond switched off. The stars stay. */
  quiet() {
    this.meteors.live = null;
    this.uMetB.value.z = 0;
    this.wave = null;
    this.uWave.value.w = 0;
    quietFlashes(this.flashes);
    for (const v of this.uFlash.array) v.z = 0;
    this.uFlashOn.value = 0;
  }

  /* The gravity wave, applied to the universe point in place before anything samples it, so every
     layer (stars, galaxies, nebula, session stars, a streak) rides the same ring. */
  warp(p, V) {
    const W = this.uWave;
    If(W.w.mul(V.showWave).greaterThan(0), () => {
      const dv = p.sub(W.xy).toVar();
      const d = length(dv).toVar();
      const x = d.sub(W.z).div(V.waveWidth.max(1e-4));
      // Sampling inward is what shows the stars pushed outward as the crest goes by.
      p.assign(p.sub(dv.div(d.max(1e-5)).mul(W.w.mul(exp(x.mul(x).negate())))));
    });
  }

  /* Session stars and their flashes. A star's cell reads one texel, and only a matching tag draws, so a
     cell a table's width away never borrows it. Twinkle phase comes off the cell, which is fresh per star. */
  session(p, px, V, motion) {
    const acc = vec3(0).toVar();
    If(this.uSessionOn.mul(V.showSession).greaterThan(0.5), () => {
      // The field's own twinkle, depth and rate, so a new star scintillates like its neighbors.
      const amt = V.twinkle.mul(mix(float(0.5), float(1), motion)).clamp(0, 1);
      const tw = this.uTwinkle;
      const R = float(this.sky.res), C = float(SESSION_CELLS);
      const g = p.mul(C).toVar();
      const cell = floor(g).toVar();
      const c = cell.add(CELL_BIAS).toVar();
      const hi = floor(c.div(R)).toVar();
      const slot = c.sub(hi.mul(R));
      const tag = hi.sub(floor(hi.div(256)).mul(256)).toVar();
      const t = texture(this.skyTex, slot.add(0.5).div(R)).level(0).mul(255).add(0.5).floor().toVar();
      const match = step(0.5, t.w).mul(step(tag.x.sub(t.x).abs(), 0.5)).mul(step(tag.y.sub(t.y).abs(), 0.5));
      If(match.greaterThan(0.5), () => {
        const nx = floor(t.z.div(16)), ny = t.z.sub(nx.mul(16));
        const at = cell.add(vec2(nx, ny).div(15).mul(0.5).add(0.25));
        const d = g.sub(at).mul(px.div(C));
        const warm = step(127.5, t.w);
        const lvl = t.w.sub(warm.mul(128)).div(127).toVar();
        const phase = fract(c.x.mul(0.618034).add(c.y.mul(0.414214)));
        const lit = lvl.mul(V.sessionGain).mul(twinkleMod(tw, phase, amt));
        // starTint at 0.45 and 0.07, precomputed: a literal through it folds to an abstract smoothstep naga rejects.
        const col = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.61, 0.386), warm);
        acc.addAssign(col.mul(lit).mul(moffat(d, mix(float(0.9), float(1.5), lvl))));
      });
    });
    // Sixteen unrolled records, each behind its own uniform test, so a quiet slot costs one compare.
    If(this.uFlashOn.mul(V.showFlash).greaterThan(0.5), () => {
      for (let i = 0; i < FLASH_SLOTS; i++) {
        const r = this.uFlash.element(i);
        If(r.z.greaterThan(0), () => {
          const d = p.sub(r.xy).mul(px);
          acc.addAssign(vec3(1.0, 0.9, 0.74).mul(moffat(d, V.flashSize.max(0.3))).mul(r.z).mul(V.flashGain));
        });
      }
    });
    return acc;
  }

  /* A meteor is a thin line behind its head, brightest at the head and gone at the trail's end; a comet
     is a coma with a feathered tail, pointing away from the nearest galaxy or back along its path with none. */
  meteor(p, px, V) {
    const acc = vec3(0).toVar();
    const A = this.uMetA, B = this.uMetB, Cm = this.uMetC;
    If(B.z.mul(mix(V.showMeteor, V.showComet, B.w)).greaterThan(0), () => {
      const q = p.sub(A.xy).toVar();
      If(B.w.lessThan(0.5), () => {
        const w = B.y.max(0.3).toVar();
        const behind = dot(q, A.zw).negate().toVar();
        const across = q.x.mul(A.w).sub(q.y.mul(A.z)).mul(px).div(w);
        const ahead = behind.min(0).mul(px).div(w);
        const along = behind.div(B.x.max(1e-5)).clamp(0, 1).oneMinus().max(1e-4).pow(1.6);
        const k = along.mul(exp(ahead.mul(ahead).add(across.mul(across)).negate()));
        acc.assign(mix(vec3(1.0, 0.86, 0.66), vec3(1.0, 0.97, 0.92), along).mul(k).mul(B.z).mul(V.meteorGain));
      }).Else(() => {
        const reach = Cm.z.mul(1.3).add(0.02);
        // Only the few pixels near the comet pay for its noise.
        If(dot(q, q).lessThan(reach.mul(reach)), () => {
          const coma = moffat(q.mul(px), B.y.max(0.5));
          const ta = dot(q, Cm.xy).toVar();
          const tc = q.x.mul(Cm.y).sub(q.y.mul(Cm.x));
          const u = ta.div(Cm.z.max(1e-5)).toVar();
          const spread = mix(float(0.003), V.cometSpread.max(1e-4), u.clamp(0, 1));
          const side = tc.div(spread);
          const feather = valueNoise2(vec2(u.mul(7).sub(Cm.w), side.mul(0.9).add(3.1)));
          const tail = exp(side.mul(side).negate()).mul(u.clamp(0, 1).oneMinus().max(1e-4).pow(1.3))
            .mul(smoothstep(0.0, 0.06, u)).mul(mix(float(0.3), float(1.25), feather));
          acc.assign(vec3(0.62, 0.86, 1.0).mul(tail).add(vec3(0.85, 0.95, 1.0).mul(coma)).mul(B.z).mul(V.cometGain));
        });
      });
    });
    return acc;
  }

  /* Screen point to universe point: one slow rotation about screen center and one slow drift around a
     circle, both frozen under reduced motion. `rot` carries (cos, sin, offset), computed once a render on
     the CPU, since every fragment would get the same four transcendentals. */
  uv(sp, rot) {
    const rp = vec2(sp.x.mul(rot.x).sub(sp.y.mul(rot.y)), sp.x.mul(rot.y).add(sp.y.mul(rot.x)));
    return rp.add(rot.zw);
  }

  /* One tier of hashed-cell stars, Cosmorph's faintStarLayer with the neighbor search cut to what each
     tier's wings actually reach. `px` is the screen height in pixels, which is what sizes a star; the
     brightness is a steep power of the roll, because a flat one is the loudest tell of a fake field. */
  tier(p, px, seed, mag, cells, dens, gain, alpha, spikes, V, tw, amt, spikeAxis) {
    const g = p.mul(cells).toVar();
    const pxScale = px.div(cells);
    const acc = vec3(0).toVar();
    // Only the bright tier's halo and spikes cross a cell wall, so only it pays for a 2×2 search.
    const base = spikes ? floor(g.sub(0.5)).toVar() : floor(g).toVar();
    const span = spikes ? 2 : 1;
    // The spike axis's cos and sin, a per-frame constant the CPU hands over in `spikeAxis`.
    const ca = spikes ? spikeAxis.x : null;
    const sa = spikes ? spikeAxis.y : null;
    for (let dx = 0; dx < span; dx++) {
      for (let dy = 0; dy < span; dy++) {
        const c = base.add(vec2(dx, dy)).toVar();
        const h1 = hash3(vec3(c.add(CELL_BIAS), seed)).toVar();
        // Bright stars sit in the middle half of their cell, which is what makes the 2×2 sufficient.
        const at = spikes ? c.add(h1.xy.mul(0.5).add(0.25)) : c.add(h1.xy);
        const d = g.sub(at).mul(pxScale).toVar();
        // Most cells are empty and an empty one should pay for neither the second hash nor the shading.
        If(step(h1.z, dens).greaterThan(0.5), () => {
          // Dust and mid live off the occupancy roll: below dens it is still uniform, a free brightness,
          // and its far digits carry tint and twinkle. Only the bright tier pays for a second hash.
          const h2 = spikes ? hash3(vec3(c.add(CELL_BIAS), seed + 2)).toVar()
            : vec3(h1.z.div(dens.max(1e-4)), fract(h1.z.mul(173.37)), fract(h1.z.mul(419.71))).toVar();
          const L = h2.x.pow(mag).mul(gain).toVar();
          // Twinkle is a share of the field, not all of it; twinkleMin is the rung-6 thinner over it.
          // The phase is folded off the same roll, or every live star would share the roll's high tail.
          const on = step(V.twinkleShare.oneMinus().max(V.twinkleMin), h2.z);
          const lit = L.mul(mix(float(1), twinkleMod(tw, fract(h2.z.mul(7.0)), amt), on)).toVar();
          const col = mix(vec3(1), starTint(h2.y), smoothstep(0.0, 0.10, h2.x)).toVar();
          const core = moffat(d, alpha(h2.x)).toVar();
          if (!spikes) { acc.addAssign(col.mul(lit).mul(core)); return; }
          // Two taps at geometric scales: a single Moffat visibly terminates where a real bright star
          // keeps a scattering skirt going for tens of pixels.
          const halo = moffat(d, float(BRIGHT.alphaHi).mul(4.7)).mul(0.13);
          const q = vec2(d.x.mul(ca).sub(d.y.mul(sa)), d.x.mul(sa).add(d.y.mul(ca))).toVar();
          const len = V.spikeLen.max(1e-3).mul(mix(float(0.7), float(1.3), h2.y)).toVar();
          const w2 = float(2.6);
          const bar = exp(q.x.abs().negate().div(len)).mul(exp(q.y.mul(q.y).negate().div(w2)))
            .add(exp(q.y.abs().negate().div(len.mul(0.82))).mul(exp(q.x.mul(q.x).negate().div(w2))));
          // Diffraction only redistributes a saturated core's light, so the steep gate keeps spikes to
          // the top of the flux distribution; they carry the instrument's blue-white, not the star's.
          const amp = L.sub(V.spikeAt).mul(5.0).clamp(0, 1).mul(V.spikeGain);
          const spike = bar.mul(cos(q.x.abs().add(q.y.abs()).mul(0.22)).mul(0.2).add(0.8))
            .mul(amp).mul(lit);
          // Clipped core: the middle of a bright star burns white, the wings keep the spectral tint.
          const hot = mix(col, vec3(1), smoothstep(0.18, 0.70, lit.mul(core)));
          acc.addAssign(hot.mul(lit).mul(core.add(halo)).add(vec3(0.86, 0.91, 1.0).mul(spike)));
        });
      }
    }
    return acc;
  }

  /* Three tiers summed. Typical cost is one hash3 for the dust, one for the mid tier, and four for the
     bright tier's 2×2, with every second hash and all the shading behind the occupancy branch. */
  stars(p, px, V, motion, spikeAxis) {
    // Reduced motion keeps the twinkle at half amplitude: a frozen sky reads as a broken one.
    const amt = V.twinkle.mul(mix(float(0.5), float(1), motion)).clamp(0, 1);
    const tw = this.uTwinkle;
    const s = V.starScale.max(1e-3), dn = V.starDensity;
    const dust = this.tier(p, px, this.off[0], DUST.mag, float(DUST.cells).mul(s),
      dn.mul(DUST.density), V.dustGain, () => float(DUST.alpha), false, V, tw, amt, spikeAxis);
    const mid = this.tier(p, px, this.off[1], MID.mag, float(MID.cells).mul(s),
      dn.mul(MID.density), V.midGain,
      (h) => mix(float(MID.alphaLo), float(MID.alphaHi), h), false, V, tw, amt, spikeAxis);
    const bright = this.tier(p, px, this.off[2], BRIGHT.mag, float(BRIGHT.cells).mul(s),
      dn.mul(BRIGHT.density), V.brightGain,
      (h) => mix(float(BRIGHT.alphaLo), float(BRIGHT.alphaHi), h), true, V, tw, amt, spikeAxis);
    return dust.add(mid).add(bright).mul(V.starGain);
  }

  /* A deep field on a hashed cell grid, Cosmorph's fieldGalaxies: a tilted ellipse with a bright core
     and a diffuse disc, some of them wearing two soft log-spiral arms. Two arms and noise-broken, which
     is the whole reason the old four-arm pinwheel had to go. */
  galaxies(p, V) {
    const acc = vec3(0).toVar();
    const cells = V.galCells.max(1e-3);
    const scale = V.galScale.max(1e-4);
    const g = p.mul(cells).toVar();
    const base = floor(g.sub(0.5)).toVar();
    const reach = scale.mul(1.35).toVar();
    const dens = V.galDensity.mul(V.galaxies.mul(1 / 6)).toVar();
    // showGal is its own switch because the ladder rewrites galaxies on every rung change.
    If(V.galaxies.mul(V.showGal).greaterThan(0), () => {
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 2; dy++) {
        const c = base.add(vec2(dx, dy)).toVar();
        const h1 = hash3(vec3(c.add(CELL_BIAS), this.off[3])).toVar();
        const at = c.add(h1.xy.mul(0.5).add(0.25));
        const d = g.sub(at).div(cells).toVar();
        // The cheap bound takes the largest radius a galaxy can draw, so the size hash stays inside it.
        const near = step(dot(d, d), reach.mul(reach));
        If(step(h1.z, dens).mul(near).greaterThan(0.5), () => {
          const h2 = hash3(vec3(c.add(CELL_BIAS), this.off[3] + 2)).toVar();
          const h3 = hash3(vec3(c.add(CELL_BIAS), this.off[3] + 4)).toVar();
          const ra = scale.mul(mix(float(0.45), float(1.35), h2.x)).toVar();
          // The axis ratio is the inclination: 1 is face-on, 0.2 an edge-on sliver.
          const rb = ra.mul(mix(float(0.20), float(1.00), h2.y)).toVar();
          // A full turn in 8 to 20 minutes, either way round, snapped to whole turns per sky loop so the
          // loop's wrap is silent; galSpin scales the loop's galaxy clock on the CPU, never the turn count.
          const turns = h3.z.sub(0.5).sign().mul(mix(float(SKY_LOOP / GAL_SLOW), float(SKY_LOOP / GAL_FAST), h3.z).add(0.5).floor());
          const ang = h2.z.mul(TAU).add(this.uGalPhase.mul(turns).mul(TAU)).toVar();
          const cs = cos(ang), sn = sin(ang);
          const q = vec2(d.x.mul(cs).sub(d.y.mul(sn)), d.x.mul(sn).add(d.y.mul(cs))).toVar();
          const u = length(vec2(q.x.div(ra), q.y.div(rb))).max(1e-3).toVar();

          // No atan: cos and sin of 2θ come straight off the normalized direction, so the arm phase has
          // no branch cut to tear along and the pattern can only ever be two-fold.
          const dir = q.div(length(q).max(1e-5)).toVar();
          const A = log(u).mul(mix(float(4.5), float(11.0), h3.y)).toVar();
          const armCos = dir.x.mul(dir.x).mul(2).sub(1).mul(cos(A))
            .add(dir.x.mul(dir.y).mul(2).mul(sin(A)));
          const arm = armCos.mul(0.5).add(0.5).max(1e-4).pow(V.galArmSharp.max(0)).toVar();
          // The break noise raises the floor an arm has to clear, chewing it into flocculent fragments
          // instead of leaving a crisp pinwheel.
          const lo = valueNoise2(q.div(ra).mul(4.0).add(h3.x.mul(40))).mul(V.galArmBreak).toVar();
          const armK = arm.sub(lo).div(float(1).sub(lo).max(0.12)).clamp(0, 1);
          const spiral = step(0.42, h3.x).mul(V.galArm);
          const disk = exp(u.mul(V.galDiskFall.max(0)).negate())
            .mul(float(1).sub(spiral.mul(armK.oneMinus()))).toVar();
          const core = exp(u.mul(V.galCoreFall.max(0)).negate()).mul(V.galCore);
          // Exponential wings never reach zero; without the cut every galaxy leaves a faint box.
          const env = float(1).sub(smoothstep(0.72, 1.00, u));
          const tint = mix(vec3(1.00, 0.86, 0.64), vec3(0.66, 0.78, 1.00), smoothstep(0.10, 0.80, u));
          // One roll walks gold, blue, rose, and mint, so a field of them reads as different stellar populations.
          const pal = mix(mix(vec3(1.00, 0.78, 0.50), vec3(0.60, 0.75, 1.00), smoothstep(0.0, 0.33, h3.y)),
            mix(vec3(1.00, 0.60, 0.75), vec3(0.70, 1.00, 0.90), smoothstep(0.66, 1.0, h3.y)), smoothstep(0.33, 0.66, h3.y));
          const fam = mix(vec3(1), pal, V.galColor);
          // h1.z survived the occupancy test and is still uniform below `dens`: a free brightness roll.
          const rel = h1.z.div(dens.max(1e-4));
          const L = mix(float(0.28), float(1.00), rel.mul(rel)).mul(V.galGain);
          acc.addAssign(tint.mul(fam).mul(core.add(disk)).mul(env).mul(L));
        });
        }
      }
    });
    return acc;
  }

  dispose() { this.ready = false; this.skyTex.dispose(); }
}
