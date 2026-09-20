import { Fn, vec2, vec3, float, uint, uvec3, floor, fract, sin, cos, exp, log, dot, length, mix, smoothstep, step, If } from 'three/tsl';
import { createRng } from './rng.js';
import { valueNoise2 } from './shading.js';

/* The universe Sam's body is a window onto. Seeded 420 and never from ?seed, so every visitor sees the
   same sky; nothing here is ever read by a decision, which is what keeps it out of the trace hash. */
export const FIRMAMENT_SEED = 420;

const TAU = Math.PI * 2;
/* Cell indices go negative near screen center and the drift carries them thousands of cells out; the
   bias keeps both ends inside the positive range hash3's uint cast needs. */
const CELL_BIAS = 65536;

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

const hash3 = Fn(([ip]) => {
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

/* Two temporal octaves on incommensurate rates, amplitude only: a star dims by at most `amt` and never
   brightens, so scintillation cannot inflate the field's total flux. */
const twinkleMod = Fn(([t, phase, amt]) => {
  const w = sin(t.add(phase).mul(TAU)).mul(0.62)
    .add(sin(t.mul(0.41).add(phase.mul(2.7)).mul(TAU)).mul(0.38));
  return float(1).sub(amt).add(amt.mul(w.mul(0.5).add(0.5)));
});

export class Firmament {
  constructor({ seed = FIRMAMENT_SEED } = {}) {
    // Integer lattice offsets, one per hashed field, so the four cannot share a cell grid.
    const rng = createRng(seed);
    this.off = [0, 1, 2, 3].map(() => rng.int(0, 4096) * 8 + 1);
    this.ready = true;
  }

  /* Screen point to universe point: one slow rotation about screen center and one slow translation,
     both on the frame clock and both frozen flat under reduced motion (live 0). */
  uv(sp, V, time, live) {
    const ang = time.mul(V.spin).mul(live);
    const cs = cos(ang), sn = sin(ang);
    const rot = vec2(sp.x.mul(cs).sub(sp.y.mul(sn)), sp.x.mul(sn).add(sp.y.mul(cs)));
    const d = time.mul(V.drift).mul(live);
    return rot.add(vec2(cos(V.driftAngle), sin(V.driftAngle)).mul(d));
  }

  /* One tier of hashed-cell stars, Cosmorph's faintStarLayer with the neighbor search cut to what each
     tier's wings actually reach. `px` is the screen height in pixels, which is what sizes a star; the
     brightness is a steep power of the roll, because a flat one is the loudest tell of a fake field. */
  tier(p, px, seed, mag, cells, dens, gain, alpha, spikes, V, tw, amt) {
    const g = p.mul(cells).toVar();
    const pxScale = px.div(cells);
    const acc = vec3(0).toVar();
    // Only the bright tier's halo and spikes cross a cell wall, so only it pays for a 2×2 search.
    const base = spikes ? floor(g.sub(0.5)).toVar() : floor(g).toVar();
    const span = spikes ? 2 : 1;
    const ca = spikes ? cos(V.spikeAngle).toVar() : null;
    const sa = spikes ? sin(V.spikeAngle).toVar() : null;
    for (let dx = 0; dx < span; dx++) {
      for (let dy = 0; dy < span; dy++) {
        const c = base.add(vec2(dx, dy)).toVar();
        const h1 = hash3(vec3(c.add(CELL_BIAS), seed)).toVar();
        // Bright stars sit in the middle half of their cell, which is what makes the 2×2 sufficient.
        const at = spikes ? c.add(h1.xy.mul(0.5).add(0.25)) : c.add(h1.xy);
        const d = g.sub(at).mul(pxScale).toVar();
        // Most cells are empty and an empty one should pay for neither the second hash nor the shading.
        If(step(h1.z, dens).greaterThan(0.5), () => {
          const h2 = hash3(vec3(c.add(CELL_BIAS), seed + 2)).toVar();
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
  stars(p, px, V, time, motion) {
    // Reduced motion keeps the twinkle at half amplitude: a frozen sky reads as a broken one.
    const amt = V.twinkle.mul(mix(float(0.5), float(1), motion)).clamp(0, 1);
    const tw = time.mul(V.twinkleRate).mul(0.16);
    const s = V.starScale.max(1e-3), dn = V.starDensity;
    const dust = this.tier(p, px, this.off[0], DUST.mag, float(DUST.cells).mul(s),
      dn.mul(DUST.density), V.dustGain, () => float(DUST.alpha), false, V, tw, amt);
    const mid = this.tier(p, px, this.off[1], MID.mag, float(MID.cells).mul(s),
      dn.mul(MID.density), V.midGain,
      (h) => mix(float(MID.alphaLo), float(MID.alphaHi), h), false, V, tw, amt);
    const bright = this.tier(p, px, this.off[2], BRIGHT.mag, float(BRIGHT.cells).mul(s),
      dn.mul(BRIGHT.density), V.brightGain,
      (h) => mix(float(BRIGHT.alphaLo), float(BRIGHT.alphaHi), h), true, V, tw, amt);
    return dust.add(mid).add(bright).mul(V.starGain);
  }

  /* A deep field on a hashed cell grid, Cosmorph's fieldGalaxies: a tilted ellipse with a bright core
     and a diffuse disc, some of them wearing two soft log-spiral arms. Two arms and noise-broken, which
     is the whole reason the old four-arm pinwheel had to go. */
  galaxies(p, V, time) {
    const acc = vec3(0).toVar();
    const cells = V.galCells.max(1e-3);
    const scale = V.galScale.max(1e-4);
    const g = p.mul(cells).toVar();
    const base = floor(g.sub(0.5)).toVar();
    const reach = scale.mul(1.35).toVar();
    const dens = V.galDensity.mul(V.galaxies.mul(1 / 6)).toVar();
    If(V.galaxies.greaterThan(0), () => {
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
          // A full turn in 8 to 20 minutes, either way round: visible if you watch, restful if you don't.
          const rate = h3.z.sub(0.5).sign().mul(mix(float(TAU / 1200), float(TAU / 480), h3.z));
          const ang = h2.z.mul(TAU).add(time.mul(rate).mul(V.galSpin)).toVar();
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

  dispose() { this.ready = false; }
}
