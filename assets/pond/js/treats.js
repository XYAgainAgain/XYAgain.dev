import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, uv, vec2, vec3, vec4, float, varying, length, sin, cos, smoothstep, normalize, mix, step, fwidth, positionGeometry } from 'three/tsl';
import { DEPTH, POOL_SCALE, MOON_ELEVATION } from './config.js';
import { moonBrightAt } from './eel-air-core.js';
import { flightFor, recentFingerSpeed, clampImpact, poolExit, padContact, tumbleFor, crumbScale } from './treats-core.js';

const SLIDE_V = 0.6;       // units/s a crumb rolls or skips off a pad rim
const RIM_CLEAR = 0.12;    // how far past the rim a roll-off lands
const PAD_Y = 0.03;        // a crumb sitting on a leaf, just above the film
const SHADOW_SPREAD = 2.2; // shadow half-size high up, relative to its size at the splash
const SHADOW_FADE = 0.35;  // shadow strength high up, relative to its strength at the splash
const CRUMB_HALF = 0.045;  // a whole treat's sprite half-size; the food mesh's sphere radius exactly
const CRUMB_LONG = 1.7;    // how much longer than wide a tumbling flake reads; 1 is one lying flat

/* The falling crumb. eels.js keeps the crumb object because feed() is the one factory; this owns the
   flight, the two over-water draws, and everything a landing has to decide. */
class TreatSystem {
  constructor(sys, { overScene, pads, view, motion, U }) {
    this.sys = sys;
    this.pads = pads ?? null;
    this.view = view;
    this.motion = motion ?? { reduced: false };
    this.U = U;
    this.live = [];
    this.rests = 0;
    const k = sys.knobs.treat;
    // Sized once: the knobs may be dialed down live, never up past the buffers already allocated.
    this.pool = Math.max(1, (k.airborneMax | 0) || 8) + Math.max(1, (k.restMax | 0) || 8);
    this.build(overScene, U);
  }

  get knobs() { return this.sys.knobs.treat; }

  /* Half-extents of the sim's box, live: a resize moves the wall a hard flick can throw a crumb past. */
  poolBox() {
    return { hw: (POOL_SCALE * this.view.w) / 2, hh: (POOL_SCALE * this.view.h) / 2 };
  }

  build(overScene, U) {
    const n = this.pool;
    // xyz launch point and launch time; horizontal velocity, gravity, and the time the flight ends;
    // half-size, tumble phase, tumble rate, and the alive flag.
    this.aA = new Float32Array(n * 4);
    this.aB = new Float32Array(n * 4);
    this.aC = new Float32Array(n * 4);
    this.uTime = uniform(0);
    this.uH0 = uniform(Math.max(1e-4, this.knobs.height * DEPTH));
    this.uScale = uniform(this.knobs.scale);
    this.uShadow = uniform(this.knobs.shadow);
    this.uTanElev = uniform(Math.tan(MOON_ELEVATION));

    const mk = (arr) => {
      const a = new THREE.InstancedBufferAttribute(arr, 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.bA = mk(this.aA); this.bB = mk(this.aB); this.bC = mk(this.aC);

    this.crumbMesh = this.buildMesh(false);
    this.shadowMesh = this.buildMesh(true);
    this.crumbMesh.renderOrder = 44;
    this.shadowMesh.renderOrder = 43;
    overScene.add(this.shadowMesh, this.crumbMesh);
  }

  /* One geometry and one node graph per draw, sharing the three instanced attributes. The flight is
     integrated in the vertex stage off the simulation clock so it stays smooth between fixed ticks. */
  buildMesh(isShadow) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aTreatA', this.bA);
    geo.setAttribute('aTreatB', this.bB);
    geo.setAttribute('aTreatC', this.bC);
    geo.instanceCount = this.pool;

    const tag = isShadow ? 'Sh' : 'Cr';
    const vSpin = varying(float(0), `vTreatSpin${tag}`);
    const vHigh = varying(float(0), `vTreatHigh${tag}`);
    const vFlat = varying(float(0), `vTreatFlat${tag}`);
    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const a = attribute('aTreatA', 'vec4');
      const b = attribute('aTreatB', 'vec4');
      const c = attribute('aTreatC', 'vec4');
      const span = b.w.sub(a.w).max(1e-4);
      const age = this.uTime.sub(a.w).max(0).min(span).toVar();
      const y = a.y.sub(b.z.mul(age).mul(age).mul(0.5)).toVar();
      // c.w is the slot's state: 0 free, 1 in the air, 2 lying on a leaf. A parked crumb is settled,
      // so it takes the splash silhouette and casts nothing.
      const live = step(float(0.5), c.w).toVar();
      const flat = step(float(1.5), c.w).toVar();
      // Height as a fraction of the launch height drives both the sprite ease and the shadow spread,
      // so a crumb re-aimed off a pad rim reads correctly without carrying a second progress term.
      const high = y.div(this.uH0).clamp(0, 1).mul(flat.oneMinus()).toVar();
      // Each material carries only the varying its own fragment stage reads; an assigned-but-unused
      // one is dead weight the WGSL builder still has to plumb.
      if (isShadow) vHigh.assign(high);
      else { vSpin.assign(c.y.add(c.z.mul(this.uTime))); vFlat.assign(flat); }
      const x = a.x.add(b.x.mul(age)).toVar();
      const z = a.z.add(b.y.mul(age)).toVar();
      const q = positionGeometry.xy;
      if (isShadow) {
        // The camera looks straight down, so height alone is invisible: the converging gap between
        // crumb and shadow is the whole animation.
        const mw = normalize(vec2(this.U.moonDir.x, this.U.moonDir.z));
        const off = mw.mul(y.div(this.uTanElev)).negate();
        // A crumb sitting on a leaf casts nothing; the disc under it is what made it read as floating.
        const half = c.x.mul(live).mul(flat.oneMinus()).mul(mix(float(1), float(SHADOW_SPREAD), high));
        return vec3(x.add(off.x).add(q.x.mul(half)), 0.02, z.add(off.y).add(q.y.mul(half)));
      }
      const half = c.x.mul(live).mul(mix(float(1), this.uScale, high));
      return vec3(x.add(q.x.mul(half)), y.max(PAD_Y), z.add(q.y.mul(half)));
    })();

    mat.fragmentNode = Fn(() => {
      const q = uv().sub(0.5).mul(2);
      if (isShadow) {
        const d = length(q);
        const dark = smoothstep(1.0, 0.15, d).mul(this.uShadow).mul(mix(float(1), float(SHADOW_FADE), vHigh));
        // Multiply blending: rgb 1 outside the disc is a no-op, so only the disc darkens the water.
        const keep = dark.oneMinus().toVar();
        return vec4(keep, keep, keep, 1);
      }
      const s = sin(vSpin), co = cos(vSpin);
      // A crumb is a flake, not a ball: a squashed lozenge turning end over end, until it settles on a
      // leaf and shows its full face.
      const r = vec2(q.x.mul(co).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(co)));
      const d = length(vec2(r.x, r.y.mul(mix(float(CRUMB_LONG), float(1), vFlat)))).toVar();
      // A pixel-wide edge instead of a fade over half the radius: the sprite is only a dozen pixels
      // across, and a held crumb is half that again, so a fixed band reads as blur at one size or
      // aliasing at the other. Uniform control flow here, so no uniformFlow() guard is needed.
      const band = fwidth(d).mul(1.2).clamp(0.02, 0.4);
      const alpha = smoothstep(1.0, float(1).sub(band), d).toVar();
      // Premultiplied, so the lozenge's transparent rim contributes nothing instead of a pale fringe.
      return vec4(vec3(0.95, 0.85, 0.6).mul(alpha), alpha);
    })();

    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    // Both blends are spelled out rather than taken from a preset, so the two backends cannot disagree.
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    if (isShadow) {
      // Multiply: rgb becomes destination × source, and the destination's alpha is left alone. The
      // fragment emits alpha 1, so the node stage's own premultiply is a no-op over it.
      mat.premultipliedAlpha = true;
      mat.blendSrc = THREE.ZeroFactor;
      mat.blendDst = THREE.SrcColorFactor;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
    } else {
      // The fragment already emits premultiplied color, so the node stage must not do it again.
      mat.premultipliedAlpha = false;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    if (isShadow) this.shadowMat = mat; else this.crumbMat = mat;
    return mesh;
  }

  /* The one entry point. Returns the crumb, airborne or (reduced motion, eels off) already landed.
     Console form: toss(x, z, vx, vz) throws with a velocity of its own instead of the hand's. */
  toss(x, z, amount = 1, opts = null) {
    if (typeof opts === 'number') { opts = { vx: amount, vz: opts }; amount = 1; }
    // A corrupted cursor coordinate voids before anything exists: no crumb, no scent, no sound.
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const sys = this.sys, k = this.knobs;
    const t0 = Number.isFinite(opts?.t0) ? opts.t0 : sys.time;
    const held = !!opts?.held;
    const base = { origin: opts?.origin ?? 'click', gestureId: opts?.gestureId ?? sys.finger.gestureId };
    // A high-contrast object crossing the screen twice a second during a held feed is exactly what
    // reduced motion is for; with the eels off nothing advances the flight, so it cannot fly either.
    if (this.motion.reduced || !sys.enabled) {
      const crumb = sys.feed(x, z, amount, { ...base, t: t0 });
      sys.emitAt('drop', crumb.x, crumb.y, crumb.z, { detail: { amount, held, tossed: false }, dropId: crumb.dropId, t: crumb.t });
      return crumb;
    }
    let vx = opts?.vx, vz = opts?.vz;
    if (!Number.isFinite(vx) || !Number.isFinite(vz)) {
      const s = recentFingerSpeed(sys.finger.vHist);
      vx = s.vx * k.toss; vz = s.vz * k.toss;
    }
    const h0 = Math.max(0.01, k.height * DEPTH);
    const f = flightFor(x, z, vx, vz, h0, k.gravity);
    if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.z)) return null;
    const box = this.poolBox();
    const hit = clampImpact(box, f.x, f.z);
    // feed() takes the impact point, not the cursor: that runs its rock slide where the crumb will
    // actually land, and puts the anticipatory scent where the eels should be waiting.
    const crumb = sys.feed(hit.x, hit.z, amount, { ...base, t: t0 + f.tFall, air: { y: h0 } });
    // Before anything can sense it: feed() stamps the landed radius, and the braincell's prepass runs
    // ahead of this module's, so a click crumb would otherwise be smelled once at full strength.
    crumb.plop = this.tellRadius(0);
    const tumble = tumbleFor(crumb.dropId);
    // The rock slide may have moved the landing; re-aim so the sprite ends where the crumb ends.
    const vAx = f.tFall > 1e-6 ? (crumb.x - x) / f.tFall : 0;
    const vAz = f.tFall > 1e-6 ? (crumb.z - z) / f.tFall : 0;
    const tr = {
      crumb, state: 'fall', slot: -1, held, half: CRUMB_HALF * crumbScale(amount),
      x0: x, y0: h0, z0: z, vx: vAx, vz: vAz, g: f.g,
      t0, tEnd: t0 + f.tFall, vHoriz: f.vHoriz, tumble, pad: null, padDX: 0, padDZ: 0,
      shoveSeq: 0, voidAt: null,
    };
    if (!hit.ok) {
      // Thrown clean off the pool: the plip comes from the wall it crossed, not from a landing.
      const exit = poolExit(box, x, z, vAx, vAz, f.tFall);
      tr.voidAt = exit ?? { x: crumb.x, z: crumb.z, t: f.tFall };
      tr.tEnd = t0 + Math.max(0, tr.voidAt.t);
      crumb.t = tr.tEnd;
    }
    this.admit(tr);
    sys.emitAt('toss', x, h0, z, { detail: { amount, held, tossed: true }, dropId: crumb.dropId, t: tr.tEnd });
    return crumb;
  }

  /* Caps, both of them: too many in flight lands the oldest early, and a full draw pool retires the
     oldest treat of any state rather than dropping the newcomer on the floor. */
  admit(tr) {
    const cap = Math.max(1, this.knobs.airborneMax | 0);
    let flying = 0;
    for (const t of this.live) if (t.state !== 'rest') flying++;
    while (flying >= cap) { if (!this.forceOldest((t) => t.state !== 'rest')) break; flying--; }
    while (this.live.length >= this.pool) { if (!this.forceOldest(() => true)) break; }
    tr.slot = this.freeSlot();
    this.live.push(tr);
    this.writeSlot(tr);
  }

  forceOldest(pick) {
    for (const t of this.live) {
      if (!pick(t)) continue;
      this.arrive(t, this.sys.time, true);
      return true;
    }
    return false;
  }

  freeSlot() {
    const used = new Set(this.live.map((t) => t.slot));
    for (let i = 0; i < this.pool; i++) if (!used.has(i)) return i;
    return 0;
  }

  prepass(sys, dt) {
    const now = sys.time;
    this.uScale.value = this.knobs.scale;
    this.uH0.value = Math.max(1e-4, this.knobs.height * DEPTH);
    // The pads own the shove count but not the dial that says what counts; published live so the knob
    // still tunes it. pads.update() runs later in the frame than this, so it is never a tick behind.
    if (this.pads) this.pads.shoveMin = this.knobs.padShedThreshold;
    // A dim quarter of the orbit should not cast a hard shadow, so the moon's own brightness scales it.
    this.uShadow.value = this.knobs.shadow * moonBrightAt(this.U.moonPhase.value, 0, sys.pins?.moon ?? null);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const tr = this.live[i];
      if (!(tr.crumb.amount > 0)) { sys.unfeed(tr.crumb); this.retire(tr); continue; }
      if (tr.state === 'rest') { this.stepRest(tr, now); continue; }
      if (now >= tr.tEnd) { this.arrive(tr, now, false); continue; }
      this.tell(tr, now);
    }
    this.writeAll();
  }

  /* The anticipatory scent: a radius that grows through the fall, wider when the pond has been busy.
     It rides the sensed set like any other smell, so claims, eats weights, and sulk lists all hold. */
  tellRadius(p) {
    const k = this.knobs;
    const recency = Math.min(1, Math.max(0, this.sys.feedRecent / Math.max(1e-3, k.tellNorm)));
    return k.tell * (0.4 + 0.6 * Math.min(1, Math.max(0, p))) * (1 + k.tellRecent * recency);
  }

  tell(tr, now) {
    const span = Math.max(1e-4, tr.tEnd - tr.t0);
    tr.crumb.plop = this.tellRadius((now - tr.t0) / span);
  }

  /* A parked crumb rides its pad's stalk swing, and only a real shove lets it go. Rain never does:
     every term in the pad's disturbance signal is a body or a finger, rain only changes wetness. */
  stepRest(tr, now) {
    const pad = tr.pad;
    // land() and unfeed() both clear onPad, so a crumb taken out from under the rest lets go here.
    if (!pad || tr.crumb.onPad !== pad) { this.release(tr, now); return; }
    tr.crumb.x = pad.x + pad.swingX + tr.padDX;
    tr.crumb.z = pad.z + pad.swingZ + tr.padDZ;
    tr.x0 = tr.crumb.x; tr.z0 = tr.crumb.z;
    if (pad.shoveSeq !== tr.shoveSeq) this.release(tr, now);
  }

  /* Off the rim on the pad's own shed heading, at a roll's pace, into open water for real. */
  release(tr, now) {
    const pad = tr.pad;
    const crumb = tr.crumb;
    crumb.onPad = null;
    this.rests = Math.max(0, this.rests - 1);
    // State first: retire() reads it to undo the park, and release() has already done that itself.
    tr.state = 'fall';
    if (!pad) { crumb.airborne = true; this.arrive(tr, now, true); return; }
    const a = pad.shedDir ?? 0;
    this.slide(tr, now, pad.x + Math.cos(a) * (pad.r + RIM_CLEAR), pad.z + Math.sin(a) * (pad.r + RIM_CLEAR));
  }

  /* Skidding along the film at a fixed pace: a re-aimed flight with no gravity, so one vertex path
     draws the fall, the skip, and the roll-off alike. */
  slide(tr, now, ex, ez) {
    const crumb = tr.crumb;
    const sx = crumb.x, sz = crumb.z;
    const d = Math.hypot(ex - sx, ez - sz);
    const span = Math.max(1e-3, d / SLIDE_V);
    tr.state = 'slide';
    tr.x0 = sx; tr.z0 = sz; tr.y0 = PAD_Y; tr.g = 0;
    tr.vx = (ex - sx) / span; tr.vz = (ez - sz) / span;
    tr.t0 = now; tr.tEnd = now + span;
    tr.pad = null;
    // The scent moves with the plan, not with the sprite: the eels should be waiting where it ends up.
    crumb.airborne = true;
    crumb.x = ex; crumb.z = ez;
    crumb.t = tr.tEnd;
    this.writeSlot(tr);
  }

  /* Whatever the flight was aiming at, arrived. `forced` is a cap eviction or the eels being switched
     off: simulation time keeps running, and a crumb suspended over an empty pond is a bug report. */
  arrive(tr, now, forced) {
    const sys = this.sys;
    // Drained to zero before it ever lands: nothing guarantees every sensed-set consumer will skip an
    // airborne crumb, so it leaves the same way a voided one does rather than assuming it can't happen.
    if (!(tr.crumb.amount > 0)) { sys.unfeed(tr.crumb); this.retire(tr); return; }
    if (tr.voidAt && !forced) {
      sys.emitAt('void', tr.voidAt.x, 0, tr.voidAt.z, { detail: { dropId: tr.crumb.dropId } });
      sys.unfeed(tr.crumb);
      this.retire(tr);
      return;
    }
    if (tr.voidAt) { sys.unfeed(tr.crumb); this.retire(tr); return; }
    const pad = tr.state === 'slide' ? null : this.pads?.padAt(tr.crumb.x, tr.crumb.z) ?? null;
    // A forced resolve has to end here: nothing will step a re-aimed skid once the eels are switched
    // off, so a crumb over a pad is set down just outside its rim rather than dropped through it.
    if (forced) {
      if (pad) this.toRim(tr, pad);
      this.touchdown(tr);
      return;
    }
    if (!pad) { this.touchdown(tr); return; }
    const mode = padContact(tr.vHoriz, this.knobs.padBounceV, this.knobs.padRestV);
    // A flat, fast arrival skips off the rim without the pad ever registering the hit.
    if (mode === 'bounce') { this.skip(tr, now, pad); return; }
    if (mode === 'rest') { this.park(tr, pad); return; }
    // Medium: a dip, a shed of beads, a tap, and off the rim it goes.
    this.pads.disturb(tr.crumb.x, tr.crumb.z, 0.15);
    sys.emitAt('drop', tr.crumb.x, PAD_Y, tr.crumb.z, {
      detail: { amount: tr.crumb.amount, held: tr.held, tossed: true, pad: true }, dropId: tr.crumb.dropId, t: now,
    });
    this.skip(tr, now, pad);
  }

  /* The nearest open water outside a pad's rim, straight out through wherever the crumb met it. */
  rimExit(tr, pad) {
    const dx = tr.crumb.x - pad.x, dz = tr.crumb.z - pad.z;
    const d = Math.hypot(dx, dz);
    // Dead center has no outward direction of its own, so the throw's heading decides which way it goes.
    const th = d > 1e-4 ? Math.atan2(dz, dx) : Math.atan2(tr.vz, tr.vx);
    const a = Number.isFinite(th) ? th : 0;
    return { x: pad.x + Math.cos(a) * (pad.r + RIM_CLEAR), z: pad.z + Math.sin(a) * (pad.r + RIM_CLEAR) };
  }

  skip(tr, now, pad) {
    const e = this.rimExit(tr, pad);
    this.slide(tr, now, e.x, e.z);
  }

  toRim(tr, pad) {
    const e = this.rimExit(tr, pad);
    tr.crumb.x = e.x; tr.crumb.z = e.z;
  }

  park(tr, pad) {
    // A slow, steep crumb always gets its rest. Capacity works like the airborne cap instead of a
    // fourth contact outcome: the crumb that has sat longest rolls off as though something shoved it.
    const cap = Math.max(1, this.knobs.restMax | 0);
    while (this.rests >= cap) {
      const old = this.live.find((t) => t !== tr && t.state === 'rest');
      if (!old) break;
      this.release(old, this.sys.time);
    }
    const crumb = tr.crumb;
    crumb.airborne = false;
    crumb.onPad = pad;
    crumb.y = PAD_Y;
    crumb.t = this.sys.time;
    this.rests++;
    tr.state = 'rest';
    tr.pad = pad;
    // Where this crumb came in on the pad's shove count. A shove already under way when it landed is
    // not one it has to answer for; the next one is.
    tr.shoveSeq = pad.shoveSeq;
    // A crumb sitting on a leaf has stopped moving; left spinning it reads as a pinwheel.
    tr.tumble = { phase: tr.tumble.phase, rate: 0 };
    tr.padDX = crumb.x - pad.x - pad.swingX;
    tr.padDZ = crumb.z - pad.z - pad.swingZ;
    tr.g = 0; tr.vx = 0; tr.vz = 0; tr.y0 = PAD_Y;
    // With no velocity and no gravity the vertex age is inert, so the clock is set once here rather
    // than rewritten on every tick of the rest.
    tr.t0 = this.sys.time; tr.tEnd = tr.t0 + 60;
    this.writeSlot(tr);
  }

  touchdown(tr) {
    this.sys.land(tr.crumb);
    this.retire(tr);
  }

  retire(tr) {
    const i = this.live.indexOf(tr);
    if (i >= 0) this.live.splice(i, 1);
    if (tr.state === 'rest') this.rests = Math.max(0, this.rests - 1);
    this.clearSlot(tr.slot);
  }

  /* The eels toggle: every flight resolves to its impact at once instead of hanging in the sky. */
  resolveAll() {
    for (const tr of this.live.slice()) if (tr.state !== 'rest') this.arrive(tr, this.sys.time, true);
  }

  /* Only a parked crumb moves between ticks on the CPU; every other slot's launch state was written
     once and the vertex stage integrates the rest, so nothing else needs re-uploading. */
  writeAll() { for (const tr of this.live) if (tr.state === 'rest') this.writeRest(tr); }

  /* The pad swing only moves a parked crumb's origin: velocity, gravity, clock, size, tumble, and state
     were all frozen by park, so re-uploading B and C would just write back the bytes already there. */
  writeRest(tr) {
    const i = tr.slot;
    if (i < 0 || i >= this.pool) return;
    const o = i * 4;
    this.aA[o] = tr.x0; this.aA[o + 1] = tr.y0; this.aA[o + 2] = tr.z0; this.aA[o + 3] = tr.t0;
    this.bA.needsUpdate = true;
  }

  writeSlot(tr) {
    const i = tr.slot;
    if (i < 0 || i >= this.pool) return;
    const o = i * 4;
    this.aA[o] = tr.x0; this.aA[o + 1] = tr.y0; this.aA[o + 2] = tr.z0; this.aA[o + 3] = tr.t0;
    this.aB[o] = tr.vx; this.aB[o + 1] = tr.vz; this.aB[o + 2] = tr.g; this.aB[o + 3] = tr.tEnd;
    this.aC[o] = tr.half; this.aC[o + 1] = tr.tumble.phase; this.aC[o + 2] = tr.tumble.rate;
    this.aC[o + 3] = tr.state === 'rest' ? 2 : 1;
    this.bA.needsUpdate = this.bB.needsUpdate = this.bC.needsUpdate = true;
  }

  clearSlot(i) {
    if (i < 0 || i >= this.pool) return;
    this.aC[i * 4 + 3] = 0;
    this.bC.needsUpdate = true;
  }

  /* main's frame clock, carried past the fixed tick so a hard-flicked crumb does not step at 90 Hz. */
  setTime(t) { this.uTime.value = t; }

  /* Rung 4's decorative bundle. The flight itself never degrades: the anticipation is a real change
     in how the eels move, and a pond that behaves differently at rung 5 is a bug. */
  setQuality({ shadow = true } = {}) { this.shadowMesh.visible = !!shadow; }

  debug() {
    return this.live.map((tr) => ({
      dropId: tr.crumb.dropId, state: tr.state, x: +tr.crumb.x.toFixed(3), z: +tr.crumb.z.toFixed(3),
      vHoriz: +tr.vHoriz.toFixed(3), plop: +(tr.crumb.plop ?? 0).toFixed(2),
      left: +(tr.tEnd - this.sys.time).toFixed(3), pad: tr.pad?.idx ?? null, void: !!tr.voidAt,
    }));
  }

  dispose() {
    this.crumbMesh.geometry.dispose();
    this.shadowMesh.geometry.dispose();
    this.crumbMat.dispose();
    this.shadowMat.dispose();
  }
}

export function attachTreats(sys, opts) {
  const treats = new TreatSystem(sys, opts);
  sys.treats = treats;
  sys.addModule(treats);
  return treats;
}
