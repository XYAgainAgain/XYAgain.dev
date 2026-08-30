import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, varying, vec2, vec3, vec4, float, Loop, sin, cos, atan, mod, length, normalize, dot, smoothstep, mix, pow, abs, fract, floor, step, hash, fwidth, texture, sign, uv, positionGeometry, PI, TWO_PI, select } from 'three/tsl';
import { DEPTH, INF_SLOTS, MOON_ORBIT_SECONDS } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { capsuleWeight, capsuleInfluence, capsuleWeightCPU, capsuleInfluenceCPU, makeSwell, makeCurrent, fbm2 } from './shading.js';
import { segDist } from './eel-physics.js';

/* Lily pads, their petioles, and the night lilies. One instanced draw each; every pad is the same
   parametric disc carved in the vertex shader, riding a footprint-sized sample of the water. */

export const PAD_POOL = 26;
export const LILY_POOL = 8;
// Seven rings, dense toward the center, so a snoot lifts the middle as a dome rather than a 48-spoke cone.
const RINGS = [0, 0.16, 0.32, 0.5, 0.68, 0.82, 0.92, 1.0], SEG = 48;
const AGE = { emerging: 0, young: 1 / 3, mature: 2 / 3, old: 1 };
const RIM_TAPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const TWO_PI_CPU = Math.PI * 2;
const STALK_V = [0.3, 0.6, 0.85];
const DRIP_STRENGTH = 0.02, DRIP_RADIUS = 3;
// Beads roll: a steady creep toward the notch, faster downhill when a body lifts a rim or the stalk swings.
const BEAD_FLOW = 0.12, BEAD_LIFT_ROLL = 0.8, BEAD_SWING_ROLL = 0.6, BEAD_RUN = 1.1, ROLL_CAP = 6;
// Beads shed off a disturbed pad as a short burst of small drops, biased to the side they roll toward.
const SHED_TIME = 0.7, SHED_RATE = 9, SHED_STRENGTH = 0.012, SHED_RADIUS = 2.5, SHED_THRESHOLD = 0.35;
const MASS_RADIUS = 0.1;   // a resident's radius: a stalk shove scales by body radius over this, capped at 4×

function makePadGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  const count = 1 + (RINGS.length - 1) * SEG;
  const aRR = new Float32Array(count), aTh = new Float32Array(count);
  let k = 1;
  for (let r = 1; r < RINGS.length; r++) {
    for (let s = 0; s < SEG; s++) { aRR[k] = RINGS[r]; aTh[k] = (s / SEG) * Math.PI * 2; k++; }
  }
  // Winding is chosen for a +y front face under the straight-down camera (screen up is -z).
  const idx = [];
  const at = (r, s) => 1 + (r - 1) * SEG + (s % SEG);
  for (let s = 0; s < SEG; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < RINGS.length - 1; r++) {
    for (let s = 0; s < SEG; s++) {
      idx.push(at(r, s), at(r + 1, s + 1), at(r + 1, s));
      idx.push(at(r, s), at(r, s + 1), at(r + 1, s + 1));
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  // A texture node's default uv is still resolved even when every sample passes its own; WebGL2 warns without it.
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  // One vec2 for (rr, th): WebGPU binds 8 vertex buffers at most and the pad carries five instanced ones.
  const aFan = [];
  for (let i = 0; i < aRR.length; i++) aFan.push(aRR[i], aTh[i]);
  geo.setAttribute('aFan', new THREE.Float32BufferAttribute(aFan, 2));
  geo.setIndex(idx);
  return geo;
}

/* Ribbon (4 rows × 2) plus a knob (center + 6) per instance: aSV is v along the stalk or the knob
   angle, aSS the ribbon side or the knob ring flag, aSK 0 for ribbon and 1 for knob. */
function makeStalkGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  const aSV = [], aSS = [], aSK = [];
  for (let r = 0; r < 4; r++) for (const s of [-1, 1]) { aSV.push(r / 3); aSS.push(s); aSK.push(0); }
  aSV.push(0); aSS.push(0); aSK.push(1);
  for (let s = 0; s < 6; s++) { aSV.push((s / 6) * Math.PI * 2); aSS.push(1); aSK.push(1); }
  const idx = [];
  for (let r = 0; r < 3; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, d, a, d, c);
  }
  const kc = 8;
  for (let s = 0; s < 6; s++) idx.push(kc, kc + 1 + ((s + 1) % 6), kc + 1 + s);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(aSV.length * 3), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(aSV.length * 2), 2));   // shade() texture nodes, see the pad fan
  geo.setAttribute('aSV', new THREE.Float32BufferAttribute(aSV, 1));
  geo.setAttribute('aSS', new THREE.Float32BufferAttribute(aSS, 1));
  geo.setAttribute('aSK', new THREE.Float32BufferAttribute(aSK, 1));
  geo.setIndex(idx);
  return geo;
}

/* One billboard quad per flower; the petals are an analytic field in the fragment shader, so the
   silhouette is a smooth curve at any size instead of a pile of polygon strips. */
function makeLilyGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

export class PadSystem {
  /* events: { drip(x, z), settle(x, z) }; main routes them into the audio. */
  constructor({ underScene, overScene, U, shading, sim, wake, seed, view, colliders, habitat, leaf, motion, events }) {
    this.U = U;
    this.sim = sim;
    this.wake = wake;
    this.habitat = habitat;
    this.motion = motion;
    this.events = events;
    this.pads = [];
    this.crowns = [];
    this.flowers = [];
    this.dripBudget = 4;
    this.plopAt = 0;
    this.dripTmp = { x: 0, z: 0 };
    this.drops = [];
    this.bloomDebug = null;   // 'cycle' runs the whole open/close every 40 s; a number pins the bloom
    this.layout(seed, view, colliders);
    this.buildPads(U, shading, sim, leaf);
    this.buildStalks(U, shading, sim);
    this.buildLilies(U, sim);
    overScene.add(this.padMesh, this.lilyMesh);
    underScene.add(this.stalkMesh);
    for (const p of this.pads) {
      p.habitatId = habitat.addPad({ x: p.x, z: p.z, r: p.r }).id;
      habitat.addPerch({ x: p.x, y: 0.01, z: p.z, type: 'pad', radius: p.r * 0.7 });
    }
    habitat.addCoverSource((discs) => { for (const p of this.pads) discs.push({ x: p.x, z: p.z, r: p.r, strength: 1 }); });
    U.coverStrength.value = 0.85;
  }

  /* Crowns by Poisson disc over the boot view plus a margin; pads on tethers around each crown. */
  layout(seed, view, colliders) {
    const rng = createRng(deriveSeed(seed, 1100));
    const ex = view.w / 2 + 1, ez = view.h / 2 + 1;
    const clear = (x, z) => colliders.spheres.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + 0.3)
      && colliders.logs.every((l) => segDist(x, z, l.a.x, l.a.z, l.b.x, l.b.z) > l.rOuter + 0.6);
    const place = (minSep) => {
      for (let tries = 0; tries < 40; tries++) {
        const x = rng.range(-ex, ex), z = rng.range(-ez, ez);
        if (clear(x, z) && this.crowns.every((c) => Math.hypot(x - c.x, z - c.z) > minSep)) return { x, z, y: -DEPTH + 0.02, pads: [], lone: false };
      }
      return null;
    };
    const crownCount = rng.int(4, 5), loneCount = rng.int(1, 3);
    let oldBudget = Math.max(0, 2 - loneCount);
    const addPad = (crown, cls, diameter) => {
      if (this.pads.length >= PAD_POOL) return;
      // Petioles run 0.5–1.4 out; of a few candidate spots the one crowding its neighbors least wins,
      // so a rosette fans out instead of stacking.
      let x = crown.x, z = crown.z, best = Infinity;
      for (let tries = 0; tries < 10; tries++) {
        const dist = rng.range(0.5, 1.4), ang = rng.range(0, Math.PI * 2);
        const cx = crown.x + Math.cos(ang) * dist, cz = crown.z + Math.sin(ang) * dist;
        let crowd = 0;
        for (const q of this.pads) crowd += Math.max(0, q.r + diameter / 2 - Math.hypot(q.x - cx, q.z - cz));
        if (crowd < best) { best = crowd; x = cx; z = cz; }
        if (crowd === 0) break;
      }
      const roll = rng.next();
      // Notch: a quarter of pads cross their lobes into a slit, a tenth gape; old pads tear theirs.
      const notchHalf = roll < 0.25 ? 0.03 : roll < 0.35 ? rng.range(25, 35) * Math.PI / 180 : rng.range(8, 25) * Math.PI / 180;
      const curl = cls === 'emerging' ? 0.9 : cls === 'young' ? rng.range(0.3, 0.45) : cls === 'old' ? rng.range(0.25, 0.4) : rng.range(0.12, 0.25);
      const p = {
        x, z, r: diameter / 2, rot: Math.atan2(crown.z - z, crown.x - x), crown, cls, age: AGE[cls],
        notchHalf, notchDepth: rng.range(0.35, 0.5), curl, seed: rng.range(0, 100),
        biteSeed: cls === 'old' ? rng.range(1, 100) : 0, restY: 0, liftGain: 1, raised: false,
        wet: 0, swingX: 0, swingZ: 0, swingVX: 0, swingVZ: 0, lastLift: 0, lastPlop: 0, lastPush: 0, cooldownAt: 0, flower: null,
        shedUntil: 0, shedDir: 0, disturbed: 0, rollX: 0, rollZ: 0, rollS: 0,
      };
      // A pad whose center falls under an earlier pad rides on top: raised, stiff, and deaf to the eels.
      if (this.pads.some((q) => Math.hypot(q.x - x, q.z - z) < q.r)) { p.raised = true; p.restY = 0.02; p.liftGain = 0; }
      this.pads.push(p);
      crown.pads.push(p);
      return p;
    };
    for (let i = 0; i < crownCount; i++) {
      const crown = place(3.5);
      if (!crown) continue;
      this.crowns.push(crown);
      const n = rng.int(3, 5);
      for (let k = 0; k < n && this.pads.length < 22; k++) {
        const roll = rng.next();
        let cls = roll < 0.15 ? 'emerging' : roll < 0.40 ? 'young' : roll < 0.90 ? 'mature' : 'old';
        if (cls === 'old' && oldBudget <= 0) cls = 'mature';
        if (cls === 'old') oldBudget--;
        const d = cls === 'emerging' ? rng.range(0.25, 0.5) : cls === 'young' ? rng.range(0.5, 0.85) : cls === 'mature' ? rng.range(0.9, 1.4) : rng.range(1.4, 2.0);
        addPad(crown, cls, d);
      }
    }
    // Rosettes land in 13–22 pads: top up the thinnest crown, or stop early, before the lone pads.
    while (this.pads.length < 13 && this.crowns.length) {
      const crown = this.crowns.slice().sort((a, b) => a.pads.length - b.pads.length)[0];
      if (!addPad(crown, 'mature', rng.range(0.9, 1.4))) break;
    }
    // Lone pads: always old, always big, on a crown of their own well away from the rosettes.
    for (let i = 0; i < loneCount; i++) {
      const crown = place(4.0);
      if (!crown) continue;
      crown.lone = true;
      this.crowns.push(crown);
      addPad(crown, 'old', rng.range(1.75, 2.0));
    }
    // Lilies: one per rosette, on its largest pad past the emerging stage (salt 1200).
    const lrng = createRng(deriveSeed(seed, 1200));
    for (const crown of this.crowns) {
      if (crown.lone || this.flowers.length >= LILY_POOL) continue;
      const host = crown.pads.filter((p) => p.cls !== 'emerging').sort((a, b) => b.r - a.r)[0];
      if (!host) continue;
      const life = lrng.range(3, 4);
      const f = {
        pad: host, size: Math.min(lrng.range(0.55, 1.1), host.r * 1.5), offset: lrng.range(-0.08, 0.08), seed: lrng.range(0, 6.28),
        life, born: -lrng.range(0, life * 0.8), lifeScale: 1, bloom: 0, closeLevel: 1, heavyFor: 0, rng: lrng,
      };
      host.flower = f;
      this.flowers.push(f);
    }
  }

  /* The five-tap ride every floating thing shares: (height, dh/dx, dh/dz, swell height) at a center
     for a footprint of the given radius, ripples and swell together, tilt clamped. */
  makeRide(U, sim) {
    const swell = makeSwell(U);
    this.uPadExtent = uniform(sim.extent);
    this.uPadMinTap = uniform(sim.texelWorld * 2);
    this.uPadTiltGain = uniform(1.6);
    this.uPadSwellGain = uniform(1.0);
    this.uPadTiltMax = uniform(0.30);
    this.uPadWander = uniform(0.1);
    this.uPadFloat = uniform(0.012);
    this.uPadLift = uniform(0.12);
    return Fn(([center, radius]) => {
      const s = radius.mul(0.6).max(this.uPadMinTap);
      const c = center.div(this.uPadExtent).add(0.5);
      const su = s.div(this.uPadExtent);
      const hC = sim.read.sample(c).r;
      const hL = sim.read.sample(c.sub(vec2(su, 0))).r;
      const hR = sim.read.sample(c.add(vec2(su, 0))).r;
      const hD = sim.read.sample(c.sub(vec2(0, su))).r;
      const hU = sim.read.sample(c.add(vec2(0, su))).r;
      const sw = swell(center, U.time);
      const h = hC.add(hL).add(hR).add(hD).add(hU).mul(0.2).add(sw.x);
      const g = vec2(hR.sub(hL).div(s.mul(2)).mul(this.uPadTiltGain).add(sw.y.mul(this.uPadSwellGain)),
        hU.sub(hD).div(s.mul(2)).mul(this.uPadTiltGain).add(sw.z.mul(this.uPadSwellGain))).toVar();
      const gl = length(g);
      g.assign(g.mul(this.uPadTiltMax.div(gl.max(1e-5)).min(1)));
      return vec4(h, g.x, g.y, sw.x);
    });
  }

  buildPads(U, shading, sim, leaf) {
    const geo = makePadGeometry();
    const n = PAD_POOL;
    this.padA = new Float32Array(n * 4); this.padB = new Float32Array(n * 4);
    this.padC = new Float32Array(n * 4); this.padD = new Float32Array(n * 4); this.padE = new Float32Array(n * 4);
    this.pads.forEach((p, i) => {
      const o = i * 4;
      this.padA.set([p.x, p.z, p.r, p.rot], o);
      this.padB.set([p.notchHalf, p.notchDepth, p.curl, p.seed], o);
      this.padC.set([p.age, p.biteSeed, p.restY, p.liftGain], o);
    });
    const mk = (arr, dynamic) => {
      const a = new THREE.InstancedBufferAttribute(arr, 4);
      if (dynamic) a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPadA = mk(this.padA); this.aPadB = mk(this.padB); this.aPadC = mk(this.padC); this.aPadD = mk(this.padD, true);
    this.aPadE = mk(this.padE, true);
    geo.setAttribute('aPadA', this.aPadA); geo.setAttribute('aPadB', this.aPadB);
    geo.setAttribute('aPadC', this.aPadC); geo.setAttribute('aPadD', this.aPadD); geo.setAttribute('aPadE', this.aPadE);
    geo.instanceCount = this.pads.length;

    this.ride = this.makeRide(U, sim);
    const current = makeCurrent(U);
    const uPadWarp = uniform(1.5), uPadWander = this.uPadWander, uPadFloat = this.uPadFloat;
    const uPadLift = this.uPadLift, uPadLiftEps = uniform(0.12), uPadCurl = uniform(0.10), uPadSwingTilt = uniform(0.6);
    const uPadRim = uniform(0.25);
    // A wake (finger or body) scrunches a pad: the downstream rim folds up in creases and slides inward.
    const uPadWakeK = uniform(0.7), uPadFold = uniform(0.10), uPadScrunch = uniform(0.20), uPadCrease = uniform(14.0);
    const uPadTileC = uniform(1.4), uPadVeins = uniform(9.0), uPadBump = uniform(leaf.bump);
    const uPadGain = uniform(1.0), uPadSheen = uniform(0.6), uPadTransGain = uniform(1.0), uPadBeadFreq = uniform(5.0);
    const uPadTransTint = uniform(new THREE.Vector3(0.30, 1.0, 0.48));
    const uPadUnder = uniform(new THREE.Vector3(0.28, 0.09, 0.14));
    const uPadBronze = uniform(new THREE.Vector3(1.35, 0.72, 0.45));
    const uPadStraw = uniform(new THREE.Vector3(0.62, 0.60, 0.22));
    const tex = {
      albedo: leaf.albedo ? texture(leaf.albedo) : null,
      normal: leaf.normal ? texture(leaf.normal) : null,
      arm: leaf.arm ? texture(leaf.arm) : null,
    };

    const vPadN = varying(vec3(0), 'vPadN');
    const vPadRad = varying(vec3(0), 'vPadRad');
    const vPadTan = varying(vec3(0), 'vPadTan');
    const vPadTrans = varying(vec3(0), 'vPadTrans');
    const vPadPolar = varying(vec4(0), 'vPadPolar');   // rr, thRel, radius, tilt
    const vPadInfo = varying(vec4(0), 'vPadInfo');     // seed, age, biteSeed, wet
    const vPadLily = varying(float(0), 'vPadLily');
    const vPadRot = varying(float(0), 'vPadRot');
    const vPadRoll = varying(vec4(0), 'vPadRoll');   // in pad radii: downhill roll (xy), creep toward the sink (z), notch apex (w)
    const uBeadPool = uniform(0.15);                   // beads slow and pool this close to a sink instead of vanishing into it
    const uBeadRun = uniform(BEAD_RUN);                // pad radii one bead layer travels before it drains and the other takes over
    const uLilyShadowLen = uniform(0.16);   // world units the lily's shadow travels at 52°: its 0.2 height over tan(52°)

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const A = attribute('aPadA', 'vec4'), B = attribute('aPadB', 'vec4'), C = attribute('aPadC', 'vec4'), D = attribute('aPadD', 'vec4');
      const E = attribute('aPadE', 'vec4'), fan = attribute('aFan', 'vec2');
      const rr = fan.x, th0 = fan.y;
      const radius = A.z;
      // Angle relative to the notch, warped toward it so the rim spends half its vertices there.
      const d0 = th0.sub(PI);
      const thRel = sign(d0).mul(PI).mul(pow(abs(d0).div(PI), uPadWarp));
      const th = A.w.add(thRel);
      // Notch as a V collapsed from the rim toward the center; old pads tear the cut ragged.
      const tear = sin(thRel.mul(37).add(B.w)).mul(0.06).mul(smoothstep(0.8, 1.0, C.x));
      const wedge = smoothstep(B.x, B.x.mul(0.35), abs(thRel).add(tear));
      const undulate = sin(thRel.mul(9).add(B.w)).mul(0.012).add(sin(thRel.mul(23).add(B.w.mul(3))).mul(0.006)).add(1);
      const rEff = rr.mul(undulate).mul(wedge.mul(B.y).oneMinus()).mul(radius);
      const radial = vec2(cos(th), sin(th));
      const wander = current(A.xy, U.time).mul(uPadWander).mul(U.motionScale);
      const center = A.xy.add(D.xy).add(wander);
      const xz = center.add(radial.mul(rEff));
      const ride = this.ride(center, radius);
      // A pad riding on top of another is stiff: a third of the bob and tilt, no lift, no swing.
      const bob = mix(1.0, 0.3, step(0.001, C.z));
      // The rigid plane: water tilt plus the tether swing tipping the pad toward the push.
      const gw = vec2(ride.y, ride.z).mul(bob).sub(D.xy.mul(uPadSwingTilt));
      const g = gw.toVar();
      // Snoot lift about the tether anchor: the far rim rises, the notch side stays down.
      const pivot = cos(thRel).oneMinus().mul(0.5).mul(0.65).add(0.35);
      const p3 = vec3(xz.x, 0, xz.y);
      const pEps = vec3(xz.x.add(radial.x.mul(uPadLiftEps)), 0, xz.y.add(radial.y.mul(uPadLiftEps)));
      const w = float(0).toVar(), wEps = float(0).toVar();
      Loop(INF_SLOTS, ({ i }) => {
        const a = U.infA.element(i), b = U.infB.element(i);
        w.addAssign(capsuleWeight(p3, a, b).mul(b.w));
        wEps.addAssign(capsuleWeight(pEps, a, b).mul(b.w));
      });
      const liftK = uPadLift.mul(pivot).mul(C.w);
      const lift = w.min(1).mul(liftK);
      g.addAssign(radial.mul(wEps.min(1).sub(w.min(1)).div(uPadLiftEps).mul(liftK)));
      // Rim curl with its closed-form slope.
      const t = rr.sub(0.78).div(0.22).clamp(0, 1);
      const cs = t.mul(t).mul(t.mul(-2).add(3));
      const curlH = B.z.mul(uPadCurl).mul(radius).mul(cs).mul(cs);
      const curlSlope = B.z.mul(uPadCurl).mul(2).mul(cs).mul(t.mul(t.oneMinus()).mul(6).div(0.22));
      g.addAssign(radial.mul(curlSlope));
      // Rigid plane from the center, with a little rim conformance so it is a leaf, not a plate.
      const off = radial.mul(rEff);
      const planeY = ride.x.mul(bob).add(gw.x.mul(off.x)).add(gw.y.mul(off.y));
      const hV = sim.read.sample(xz.div(this.uPadExtent).add(0.5)).r.add(ride.w).mul(bob);
      const conform = rr.mul(rr).mul(rr).mul(uPadRim).mul(U.motionScale);
      // Scrunch from the wake memory: a leaf folds rather than sliding rigidly out of the way.
      const wk = this.wake.wakeAt(xz, uPadWakeK);
      const wm = length(wk).min(1);
      const wd = wk.div(length(wk).max(1e-5));
      const facing = dot(radial, wd).max(0);
      const crease = sin(dot(off, vec2(wd.y.negate(), wd.x)).mul(uPadCrease)).mul(0.35).add(1);
      const foldH = wm.mul(uPadFold).mul(facing).mul(rr).mul(rr).mul(crease);
      g.addAssign(wd.mul(wm).mul(uPadFold).mul(facing).mul(rr).mul(2).div(radius.max(0.1)));
      const scrunch = wd.mul(wm).mul(uPadScrunch).mul(facing).mul(rr);
      const y = mix(planeY, hV, conform).add(curlH).add(lift).add(foldH).add(C.z).add(uPadFloat);
      vPadN.assign(normalize(vec3(g.x.negate(), 1, g.y.negate())));
      vPadRad.assign(vec3(radial.x, 0, radial.y));
      vPadTan.assign(vec3(radial.y.negate(), 0, radial.x));
      vPadTrans.assign(shading.eelGlowAt(p3).mul(uPadTransTint));
      // Pad-space xy goes across as the varying, never the angle: the fan's apex would carry one angle
      // and interpolate it along the radius, and everything downstream would whorl.
      vPadPolar.assign(vec4(rr.mul(cos(thRel)), rr.mul(sin(thRel)), radius, length(g)));
      vPadInfo.assign(vec4(B.w, C.x, C.y, D.z));
      vPadLily.assign(D.w);
      vPadRot.assign(A.w);
      const cr0 = cos(A.w), sr0 = sin(A.w);
      vPadRoll.assign(vec4(E.x.mul(cr0).add(E.y.mul(sr0)), E.x.negate().mul(sr0).add(E.y.mul(cr0)), E.z, 0).div(radius).add(vec4(0, 0, 0, B.y.mul(-0.9).add(1))));
      return vec3(xz.x.sub(scrunch.x), y, xz.y.sub(scrunch.y));
    })();

    mat.fragmentNode = Fn(() => {
      const local = vPadPolar.xy, radius = vPadPolar.z, tilt = vPadPolar.w;
      const rr = length(local), thRel = atan(local.y, local.x);
      const seed = vPadInfo.x, age = vPadInfo.y, bite = vPadInfo.z, wet = vPadInfo.w;
      const n0 = normalize(vPadN);
      const ew = fwidth(rr).mul(1.2);
      const rimA = smoothstep(float(1).add(ew), float(1).sub(ew), rr);
      // One planar map in pad space: the leaf tile is isotropic, so a polar stretch bought nothing but a pinch.
      const padUV = local.mul(uPadTileC).add(seed.mul(0.37));
      const alb0 = tex.albedo ? tex.albedo.sample(padUV).rgb : vec3(0.18, 0.42, 0.16);
      const arm = tex.arm ? tex.arm.sample(padUV) : vec4(1, 0.55, 0, 1);
      // Integer harmonics keep the ±π seam of atan invisible; the fwidth fade stops veins sparkling
      // where they pack under a pixel at the hub.
      const fan = thRel.mul(uPadVeins).add(sin(thRel.mul(4).add(seed)).mul(0.5)).add(rr.mul(sin(thRel.mul(7).add(seed.mul(2)))).mul(0.6));
      const veinAA = smoothstep(1.6, 0.5, fwidth(fan));
      const vein = smoothstep(0.86, 1.0, abs(sin(fan))).mul(smoothstep(0.06, 0.35, rr)).mul(veinAA);
      const albedo = alb0.mul(vein.mul(0.25).oneMinus()).mul(arm.r.mul(0.5).add(0.5)).toVar();
      // Age: bronze new pads, straw-edged old ones.
      albedo.assign(mix(albedo, albedo.mul(uPadBronze), smoothstep(0.2, 0.0, age)));
      albedo.assign(mix(albedo, uPadStraw.mul(albedo.g.add(0.3)), smoothstep(0.7, 1.0, rr).mul(smoothstep(0.8, 1.0, age)).mul(0.7)));
      albedo.mulAssign(mix(1.0, 0.75, wet));
      const rough = arm.g.sub(vein.mul(0.2)).sub(wet.mul(0.35)).clamp(0.05, 1).toVar();
      // Exact TBN from the polar frame; map u runs around the pad, v outward.
      // The map's tangent frame is the pad's own axes, so its normal is re-expressed in the polar frame.
      const tnRaw = tex.normal ? tex.normal.sample(padUV).rgb.mul(2).sub(1) : vec3(0, 0, 1);
      const ct = cos(thRel), st = sin(thRel);
      const tn = vec3(tnRaw.x.mul(st.negate()).add(tnRaw.y.mul(ct)), tnRaw.x.mul(ct).add(tnRaw.y.mul(st)), tnRaw.z);
      const n = normalize(vPadTan.mul(tn.x.mul(uPadBump)).add(vPadRad.mul(tn.y.mul(uPadBump))).add(n0.mul(tn.z))).toVar();
      // Beads: hashed spherical caps that run off past a modest tilt; free when dry.
      // Bite-outs on old pads only: up to four hashed holes. Each one is also a sink the beads run to.
      const hole = float(0).toVar();
      const sink = vec2(vPadRoll.w, 0).toVar();
      const sinkD = length(local.sub(sink)).toVar();
      Loop(4, ({ i }) => {
        const k = float(i);
        // The first hole is certain on an old pad; each further one is a coin toss.
        const on = smoothstep(0.8, 1.0, age).mul(step(k.min(1).mul(0.5), hash(bite.mul(1.7).add(k.mul(3.1)))));
        const hr = hash(bite.add(k.mul(7.3))).mul(0.5).add(0.3);
        const ha = hash(bite.add(k.mul(11.9))).mul(TWO_PI);
        const hs = hash(bite.add(k.mul(5.1))).mul(0.09).add(0.03).div(radius);
        const hc = vec2(hr.mul(cos(ha)), hr.mul(sin(ha)));
        const dh = length(local.sub(hc)).div(hs);
        hole.addAssign(smoothstep(1.0, 0.75, dh).mul(on));
        const dk = length(local.sub(hc)).add(on.oneMinus().mul(10));
        sink.assign(select(dk.lessThan(sinkD), hc, sink));
        sinkD.assign(dk.min(sinkD));
      });
      // The lattice is read s radii farther from the sink than the fragment, so every bead runs the
      // straight line to it; the softened divide pools them at the lip instead of a vanishing point.
      // Two bead layers, each bounded to uBeadRun then fading out and handing off: unbounded travel
      // through a converging field squeezes the lattice near the sink without limit, which shrank beads over time.
      const toSink = sink.sub(local);
      const flowDir = toSink.div(length(toSink).add(uBeadPool));
      const phase = vPadRoll.z.div(uBeadRun);
      const beadMask = float(0).toVar();
      const beadLayer = (shift, salt) => {
        const ph = fract(phase.add(shift));
        const creep = flowDir.mul(ph.mul(uBeadRun));
        const beadUV = local.sub(vPadRoll.xy).sub(creep).mul(uPadTileC).add(seed.mul(0.37)).add(salt);
        const cell = beadUV.mul(uPadBeadFreq);
        const cid = floor(cell).add(4096);   // hash() takes a uint; the pad's own half-plane of negative cells would all read alike
        const f = fract(cell).sub(0.5);
        const jit = vec2(hash(dot(cid, vec2(19.1, 47.3))), hash(dot(cid, vec2(71.7, 13.9)))).sub(0.5).mul(0.7);
        const bd = length(f.sub(jit)).div(hash(dot(cid, vec2(5.3, 91.1))).mul(0.30).add(0.14));
        const cap = bd.mul(bd).oneMinus().max(0).sqrt();
        const life = ph.mul(2).sub(1).abs().oneMinus();   // triangle: 0 at the wrap, 1 mid-run
        const m = smoothstep(1.0, 0.82, bd).mul(wet).mul(smoothstep(0.35, 0.10, tilt)).mul(smoothstep(0.0, 0.35, life));
        const bn = normalize(vec3(f.sub(jit).x, cap.mul(0.6), f.sub(jit).y));
        n.assign(normalize(mix(n, vPadTan.mul(bn.x).add(n0.mul(bn.y)).add(vPadRad.mul(bn.z)), m)));
        beadMask.assign(beadMask.max(m));
      };
      beadLayer(float(0), vec2(0, 0));
      beadLayer(float(0.5), vec2(3.7, 1.9));
      // Red-purple underside where the curl turns the rim away from the moon.
      const under = smoothstep(0.86, 1.0, rr).mul(smoothstep(0.93, 0.6, n0.y));
      albedo.assign(mix(albedo, uPadUnder, under));
      // Direct moon, above the water: the same air-side lobe shade() gives rock tops.
      const ndl = dot(n, U.moonDir).max(0);
      const col = albedo.mul(U.moonColor).mul(ndl.mul(2.9).add(0.25)).mul(U.moonStrength).mul(uPadGain).toVar();
      const H = normalize(U.moonDir.add(vec3(0, 1, 0)));
      const cosH = dot(n, H).max(0);
      const gloss = mix(0.25, 1.0, wet).mul(rough.oneMinus().add(0.15));
      const F = float(0.04).add(float(0.96).mul(dot(n, vec3(0, 1, 0)).max(0).oneMinus().pow(5)));
      const sheen = pow(cosH, 90).mul(gloss).add(pow(cosH, 12).mul(gloss).mul(0.25)).mul(F.add(0.5)).mul(uPadSheen).mul(U.moonStrength);
      col.addAssign(U.moonColor.mul(sheen));
      col.addAssign(U.moonColor.mul(pow(cosH, 400).mul(beadMask).mul(0.4)));
      // Meniscus, the lily's contact shadow, and the eels' light from beneath.
      col.mulAssign(smoothstep(0.95, 1.0, rr).mul(0.35).oneMinus());
      // The lily's shadow falls away from the moon: its azimuth is brought into pad space, where local
      // is the pad's own frame rotated by A.w, so the blob slides around the flower as the moon orbits.
      const cr = cos(vPadRot), sr = sin(vPadRot);
      const mw = normalize(vec2(U.moonDir.x, U.moonDir.z));
      const ml = vec2(mw.x.mul(cr).add(mw.y.mul(sr)), mw.x.negate().mul(sr).add(mw.y.mul(cr)));
      const shR = vPadLily.div(radius).mul(0.45).max(1e-3);
      const shC = vec2(0.25, 0).sub(ml.mul(uLilyShadowLen.div(radius)));
      const shV = local.sub(shC);
      // Stretched along the light so it reads as cast, with a penumbra that widens away from the flower.
      const shD = length(vec2(dot(shV, ml).mul(0.8), dot(shV, vec2(ml.y.negate(), ml.x)))).div(shR);
      const lilyShade = smoothstep(1.15, 0.45, shD).mul(0.55).mul(smoothstep(0.0, 0.02, vPadLily));
      col.mulAssign(lilyShade.oneMinus());
      col.addAssign(albedo.mul(vPadTrans).mul(uPadTransGain));
      return vec4(col, rimA.mul(hole.min(1).oneMinus()));
    })();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.blending = THREE.NormalBlending;
    mat.side = THREE.DoubleSide;
    mat.forceSinglePass = true;
    this.padMaterial = mat;
    this.padMesh = new THREE.Mesh(geo, mat);
    this.padMesh.frustumCulled = false;
    this.padMesh.renderOrder = 40;
  }

  buildStalks(U, shading, sim) {
    const geo = makeStalkGeometry();
    this.stalkArr = new Float32Array(PAD_POOL * 4);
    // w flags the one stalk per crown that draws the knob; the rest collapse theirs to a point.
    this.pads.forEach((p, i) => this.stalkArr.set([p.crown.x, p.crown.y, p.crown.z, p.crown.pads[0] === p ? 1 : 0], i * 4));
    geo.setAttribute('aPadA', this.aPadA);
    geo.setAttribute('aPadC', this.aPadC);
    geo.setAttribute('aPadD', this.aPadD);
    geo.setAttribute('aStalk', new THREE.InstancedBufferAttribute(this.stalkArr, 4));
    geo.instanceCount = this.pads.length;
    const current = makeCurrent(U);
    const swell = makeSwell(U);
    const uStalkGive = uniform(0.25), uStalkHalf = uniform(0.015), uStalkBow = uniform(0.05), uStalkKnob = uniform(0.06);
    const uStalkMass = uniform(1 / MASS_RADIUS);
    // Petioles go from green on a new pad to red-purple on an old one.
    const uStalkYoung = uniform(new THREE.Vector3(0.16, 0.30, 0.09)), uStalkOld = uniform(new THREE.Vector3(0.34, 0.07, 0.13)), uStalkRough = uniform(0.6);
    const uPadWander = this.uPadWander, uPadFloat = this.uPadFloat;
    const vStalkP = varying(vec3(0), 'vStalkP');
    const vStalkN = varying(vec3(0), 'vStalkN');
    const vStalkAge = varying(float(0), 'vStalkAge');
    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const A = attribute('aPadA', 'vec4'), C = attribute('aPadC', 'vec4'), D = attribute('aPadD', 'vec4'), S = attribute('aStalk', 'vec4');
      const v = attribute('aSV', 'float'), side = attribute('aSS', 'float'), knob = attribute('aSK', 'float');
      const base = S.xyz;
      const wander = current(A.xy, U.time).mul(uPadWander).mul(U.motionScale);
      const center = A.xy.add(D.xy).add(wander);
      const c = center.div(this.uPadExtent).add(0.5);
      const bob = mix(1.0, 0.3, step(0.001, C.z));
      const yTop = sim.read.sample(c).r.add(swell(center, U.time).x).mul(bob).add(C.z).add(uPadFloat).sub(0.01);
      const top = vec3(center.x, yTop, center.y);
      const dir = top.sub(base);
      const horiz = normalize(vec2(dir.x, dir.z).add(vec2(1e-4, 0)));
      const p = mix(base, top, v).toVar();
      p.addAssign(vec3(horiz.x, 0, horiz.y).mul(sin(v.mul(PI)).mul(uStalkBow)));
      // A body brushing the stalk bows it; the ends stay pinned to crown and pad.
      const push = vec2(0).toVar();
      Loop(INF_SLOTS, ({ i }) => {
        const a = U.infA.element(i), b = U.infB.element(i), vel = U.infC.element(i);
        // A body's shove scales with its girth: Eleanor's three-times radius lays the stalk over.
        push.addAssign(capsuleInfluence(p, a, b, vel).mul(b.w).mul(a.w.mul(uStalkMass).min(4)));
      });
      const give = v.mul(v.oneMinus()).mul(uStalkGive).mul(C.w);
      p.addAssign(vec3(push.x, 0, push.y).mul(give));
      const sideV = vec3(horiz.y.negate(), 0, horiz.x);
      const ribbon = p.add(sideV.mul(side).mul(uStalkHalf));
      const ribbonN = normalize(vec3(horiz.x.negate().mul(dir.y), length(vec2(dir.x, dir.z)), horiz.y.negate().mul(dir.y)));
      // The knob: a small dark boss on the floor at the crown, shared by every stalk of the rosette.
      const kp = base.add(vec3(cos(v).mul(side), 0.35, sin(v).mul(side)).mul(uStalkKnob).mul(S.w));
      const out = mix(ribbon, kp, knob);
      vStalkP.assign(out.xyz);
      vStalkN.assign(mix(ribbonN, vec3(0, 1, 0), knob).xyz);
      vStalkAge.assign(C.x);
      return out;
    })();
    mat.fragmentNode = Fn(() => {
      const lit = shading.shade(mix(uStalkYoung, uStalkOld, smoothstep(0.1, 1.0, vStalkAge)), normalize(vStalkN), vStalkP, uStalkRough);
      return vec4(lit, vStalkP.y.negate().div(DEPTH).clamp(0, 1));
    })();
    mat.side = THREE.DoubleSide;
    this.stalkMaterial = mat;
    this.stalkMesh = new THREE.Mesh(geo, mat);
    this.stalkMesh.frustumCulled = false;
  }

  buildLilies(U, sim) {
    const geo = makeLilyGeometry();
    this.lilyA = new Float32Array(LILY_POOL * 4); this.lilyB = new Float32Array(LILY_POOL * 4); this.lilyC = new Float32Array(LILY_POOL * 4);
    this.flowers.forEach((f, i) => {
      const o = i * 4, p = f.pad;
      this.lilyA.set([p.x, p.z, f.size, f.seed], o);
      // Offset toward the crown (the notch direction), a quarter radius in; w carries the pad radius for the ride.
      this.lilyC.set([Math.cos(p.rot) * p.r * 0.25, Math.sin(p.rot) * p.r * 0.25, p.restY, p.r], o);
    });
    this.aLilyA = new THREE.InstancedBufferAttribute(this.lilyA, 4);
    this.aLilyB = new THREE.InstancedBufferAttribute(this.lilyB, 4);
    this.aLilyB.setUsage(THREE.DynamicDrawUsage);
    this.aLilyC = new THREE.InstancedBufferAttribute(this.lilyC, 4);
    geo.setAttribute('aLilyA', this.aLilyA); geo.setAttribute('aLilyB', this.aLilyB); geo.setAttribute('aLilyC', this.aLilyC);
    geo.instanceCount = this.flowers.length;
    const current = makeCurrent(U);
    const uPadWander = this.uPadWander, uPadFloat = this.uPadFloat, uPadLift = this.uPadLift;
    const uLilyHeight = uniform(0.2), uLilyPetal = uniform(new THREE.Vector3(0.93, 0.90, 0.86)), uLilyGold = uniform(new THREE.Vector3(1.0, 0.72, 0.20));
    // Per ring (outer, middle, inner): petal count, phase, and the closed → open lobe length and width.
    const uLilyCount = uniform(new THREE.Vector3(8, 6, 5)), uLilyPhase = uniform(new THREE.Vector3(0, 0.37, 0.74));
    const uLilyLenClosed = uniform(new THREE.Vector3(0.25, 0.22, 0.19)), uLilyLenOpen = uniform(new THREE.Vector3(0.94, 0.72, 0.52));
    const uLilyWidClosed = uniform(new THREE.Vector3(0.13, 0.12, 0.11)), uLilyWidOpen = uniform(new THREE.Vector3(0.16, 0.17, 0.16));
    const uLilyOpenStart = uniform(new THREE.Vector3(0.03, 0.16, 0.30)), uLilyOpenEnd = uniform(new THREE.Vector3(0.78, 0.90, 1.00));
    const uLilyRingTone = uniform(new THREE.Vector3(0.96, 1.0, 1.04));
    // (bud aspect, warp amplitude, stamen radius, stamen scallop), (ambient, moon gain, moon tint, channel cap).
    const uLilyShape = uniform(new THREE.Vector4(0.78, 0.025, 0.14, 0.08));
    const uLilyLight = uniform(new THREE.Vector4(0.20, 3.0, 0.35, 0.90));
    const uLilyNormal = uniform(new THREE.Vector4(0.78, 0.22, 0.16, 1.0));   // bud slope, open slope, ridge slope, up
    const uLilyEps = uniform(1e-4);
    const vLilyUv = varying(vec2(0), 'vLilyUv');
    const vLilyInfo = varying(vec4(0), 'vLilyInfo');   // bloom, seed, slope x, slope z
    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const A = attribute('aLilyA', 'vec4'), B = attribute('aLilyB', 'vec4'), C = attribute('aLilyC', 'vec4');
      const wander = current(A.xy, U.time).mul(uPadWander).mul(U.motionScale);
      const padCenter = A.xy.add(B.zw).add(wander);
      const ride = this.ride(padCenter, C.w);
      const center = padCenter.add(C.xy);
      // Mean lift of the pad under it, so the flower rises with a snoot beneath.
      const p3 = vec3(center.x, 0, center.y);
      const w = float(0).toVar();
      Loop(INF_SLOTS, ({ i }) => {
        const a = U.infA.element(i), b = U.infB.element(i);
        w.addAssign(capsuleWeight(p3, a, b).mul(b.w));
      });
      const centerY = ride.x.add(ride.y.mul(C.x)).add(ride.z.mul(C.y)).add(C.z).add(uPadFloat).add(w.min(1).mul(uPadLift).mul(0.6)).add(uLilyHeight);
      // The quad lies in the pad's tilted plane; life scale shrinks it to nothing when the flower is gone.
      const half = A.z.mul(0.52).mul(B.y);
      const local = positionGeometry.xy.mul(half);
      vLilyUv.assign(uv());
      vLilyInfo.assign(vec4(B.x, A.w, ride.y, ride.z));
      return vec3(center.x.add(local.x), centerY.add(ride.y.mul(local.x)).add(ride.z.mul(local.y)), center.y.add(local.y));
    })();
    mat.fragmentNode = Fn(() => {
      const b = vLilyInfo.x.clamp(0, 1), seed = vLilyInfo.y, slope = vLilyInfo.zw;
      const q = vLilyUv.sub(0.5).mul(2);
      // Rotate by the seed, squeeze the bud into an oval, and warp the angle a little so no petal is a clock hand.
      const cs = cos(seed), sn = sin(seed);
      const p = vec2(q.x.mul(cs).add(q.y.mul(sn)), q.y.mul(cs).sub(q.x.mul(sn)).div(mix(uLilyShape.x, 1.0, b)));
      const theta0 = atan(p.y, p.x);
      const theta = theta0.add(sin(theta0.mul(3).add(seed)).mul(uLilyShape.y));
      const petalTint = mix(uLilyPetal, U.moonColor, uLilyLight.z);
      const premul = vec3(0).toVar(), alpha = float(0).toVar();
      // One tapered-ellipse lobe field per ring, composited outer → inner in premultiplied color.
      const sw = (u, k) => (k === 0 ? u.x : k === 1 ? u.y : u.z);
      const ring = (k) => {
        const count = sw(uLilyCount, k), phase = sw(uLilyPhase, k);
        const open = smoothstep(sw(uLilyOpenStart, k), sw(uLilyOpenEnd, k), b);
        const len = mix(sw(uLilyLenClosed, k), sw(uLilyLenOpen, k), open).max(uLilyEps);
        const wid = mix(sw(uLilyWidClosed, k), sw(uLilyWidOpen, k), open).max(uLilyEps);
        const base = open.mul(0.02);
        const sector = TWO_PI.div(count), halfSec = sector.mul(0.5);
        const localA = mod(theta.sub(phase).add(halfSec), sector).sub(halfSec);
        const axisA = theta.sub(localA);
        const axis = vec2(cos(axisA), sin(axisA)), tang = vec2(axis.y.negate(), axis.x);
        const axial = dot(p, axis), lateral = dot(p, tang);
        const petalT = axial.sub(base).div(len).clamp(0, 1);
        const x = axial.sub(base.add(len.mul(0.5))).div(len.mul(0.5));
        const widthShape = mix(1.08, 0.62, petalT);
        const latN = lateral.div(wid);
        const y = latN.div(widthShape);
        const field = length(vec2(x, y)).sub(1);
        const aa = fwidth(field).mul(0.7).add(uLilyEps);
        const cov = smoothstep(aa, aa.negate(), field);
        // A thin darker rim and a crease down the middle keep each petal legible against its neighbors.
        const rim = smoothstep(-0.22, 0.0, field).mul(0.22).oneMinus();
        const crease = smoothstep(0.08, 0.0, abs(latN)).mul(0.10).oneMinus();
        // A fake cupped normal: a dome while closed, shallow petals with a center ridge once open.
        const radialSlope = mix(uLilyNormal.x, uLilyNormal.y, open);
        const nx = axis.x.mul(radialSlope).mul(petalT).add(tang.x.mul(uLilyNormal.z).mul(latN));
        const nz = axis.y.mul(radialSlope).mul(petalT).add(tang.y.mul(uLilyNormal.z).mul(latN));
        const n = normalize(vec3(nx.sub(slope.x.mul(uLilyNormal.w)), uLilyNormal.w, nz.sub(slope.y.mul(uLilyNormal.w))));
        const ndl = dot(n, U.moonDir).max(0);
        const irr = uLilyLight.x.add(U.moonStrength.mul(uLilyLight.y).mul(ndl));
        const tone = mix(0.82, 1.04, petalT).mul(abs(latN).clamp(0, 1).oneMinus().mul(0.08).add(1)).mul(sw(uLilyRingTone, k));
        const col = petalTint.mul(irr).mul(tone).mul(rim).mul(crease).min(uLilyLight.w);
        premul.assign(col.mul(cov).add(premul.mul(cov.oneMinus())));
        alpha.assign(cov.add(alpha.mul(cov.oneMinus())));
      };
      ring(0); ring(1); ring(2);
      // The gold heart shows only once the inner ring has parted.
      const sr = uLilyShape.z.mul(mix(0.65, 1.0, b)).mul(sin(theta.mul(18).add(seed)).mul(uLilyShape.w).add(1));
      const sField = length(p).sub(sr);
      const sAA = fwidth(sField).mul(0.7).add(uLilyEps);
      const sCov = smoothstep(sAA, sAA.negate(), sField).mul(smoothstep(0.55, 0.82, b));
      const sN = normalize(vec3(p.x.mul(0.34).sub(slope.x), 1, p.y.mul(0.34).sub(slope.y)));
      const sIrr = uLilyLight.x.add(U.moonStrength.mul(uLilyLight.y).mul(dot(sN, U.moonDir).max(0)));
      const sCol = uLilyGold.mul(sIrr).mul(1.12).min(uLilyLight.w);
      premul.assign(sCol.mul(sCov).add(premul.mul(sCov.oneMinus())));
      alpha.assign(sCov.add(alpha.mul(sCov.oneMinus())));
      return vec4(premul.div(alpha.max(uLilyEps)), alpha);
    })();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.blending = THREE.NormalBlending;
    mat.side = THREE.DoubleSide;
    mat.forceSinglePass = true;
    this.lilyMaterial = mat;
    this.lilyMesh = new THREE.Mesh(geo, mat);
    this.lilyMesh.frustumCulled = false;
    this.lilyMesh.renderOrder = 42;
  }

  /* Public: a creature climbing onto a pad transfers water onto it; drips fire when it leaves. */
  wet(idx, amount) {
    const p = this.pads[idx];
    if (p) p.wet = Math.max(0, Math.min(1, p.wet + amount));
  }

  /* After eels.update and before sim.update: this frame's pose feeds the drips, plops, and swings,
     and the drips land in the water the sim is about to step. */
  update(dt, now, rain, injector) {
    const U = this.U, env = rain.envelope, gust = rain.wind.gust;
    const reduced = this.motion.reduced;
    this.dripBudget = Math.min(4, this.dripBudget + 4 * dt);
    const drops = this.drops;
    drops.length = 0;
    const tmp = this.dripTmp;
    let plopBest = 0, plopX = 0, plopZ = 0;
    this.pads.forEach((p, i) => {
      // Wetness: rain soaks it quickly, evaporation is slow and a little quicker in a breeze.
      if (env > p.wet) p.wet = Math.min(env, p.wet + 0.5 * dt);
      else p.wet = Math.max(0, p.wet - dt / 40 * (1 + gust * 0.5));

      // Lift at the center and four rim points; the lowest rim point is where the water runs off.
      let lift = 0, low = 0, lowLift = Infinity, speed = 0;
      for (let k = 0; k < 4; k++) {
        const px = p.x + RIM_TAPS[k][0] * p.r * 0.85, pz = p.z + RIM_TAPS[k][1] * p.r * 0.85;
        let wsum = 0;
        for (let s = 0; s < INF_SLOTS; s++) {
          const b = U.infB.array[s];
          if (b.w <= 0) continue;
          const w = capsuleWeightCPU(U, px, 0, pz, s) * b.w;
          if (w > 0) { wsum += w; const v = U.infC.array[s]; speed = Math.max(speed, Math.hypot(v.x, v.z) * w); }
        }
        if (wsum > lift) lift = wsum;
        if (wsum < lowLift) { lowLift = wsum; low = k; }
      }
      if (p.liftGain === 0) lift = 0;
      const thr = p.wet > 0.2 ? 0.5 : 0.8;
      if (lift > thr && p.lastLift <= thr && now > p.cooldownAt && this.dripBudget >= 1) {
        this.dripBudget -= 1;
        p.cooldownAt = now + 1.5;
        p.wet = Math.max(0, p.wet - 0.15);
        let count = Math.max(1, Math.min(3, 1 + Math.round(speed * 0.8)));
        if (reduced) count = Math.ceil(count / 2);
        const scatter = 0.1 * (0.5 + Math.min(1, speed) * 0.5);
        const dx = p.x + RIM_TAPS[low][0] * p.r, dz = p.z + RIM_TAPS[low][1] * p.r;
        for (let k = 0; k < count; k++) {
          const [u, v] = this.sim.toUV(dx + (Math.random() - 0.5) * 2 * scatter, dz + (Math.random() - 0.5) * 2 * scatter);
          if (u >= 0 && u <= 1 && v >= 0 && v <= 1) drops.push({ u, v, s: DRIP_STRENGTH, r: DRIP_RADIUS });
        }
        this.events?.drip?.(dx, dz);
      }
      p.lastLift = lift;
      // Settle plop: the strongest speed × weight crossing this frame, one per second pond-wide.
      const plop = speed * Math.min(1, lift);
      if (plop > 0.8 && p.lastPlop <= 0.8 && plop > plopBest) { plopBest = plop; plopX = p.x; plopZ = p.z; }
      p.lastPlop = plop;

      // Stalk bumps: three points along the stalk, pushed by whatever brushes them, drive a spring.
      let pushX = 0, pushZ = 0;
      const c = p.crown;
      if (!p.raised) for (const v of STALK_V) {
        const sx = c.x + (p.x - c.x) * v, sy = c.y + (0 - c.y) * v, sz = c.z + (p.z - c.z) * v;
        for (let s = 0; s < INF_SLOTS; s++) {
          const b = U.infB.array[s];
          if (b.w <= 0) continue;
          if (capsuleInfluenceCPU(U, sx, sy, sz, s, tmp) > 0) {
            const mass = Math.min(4, U.infA.array[s].w / MASS_RADIUS);
            pushX += tmp.x * b.w * mass; pushZ += tmp.z * b.w * mass;
          }
        }
      }
      const pushMag = Math.hypot(pushX, pushZ);
      if (pushMag > 1.2 && p.lastPush <= 1.2 && pushMag * 0.7 > plopBest) { plopBest = pushMag * 0.7; plopX = p.x; plopZ = p.z; }
      p.lastPush = pushMag;
      // A wet pad that gets shoved sheds its beads: a short burst of randomized small drops off the rim,
      // thrown the way the pad tipped (or away from the push), and the pad reads dry until it rains again.
      const disturb = Math.max(lift, pushMag * 0.5, p.disturbed);
      if (p.wet > 0.15 && disturb > SHED_THRESHOLD && now > p.shedUntil + 1.0) {
        p.shedUntil = now + SHED_TIME;
        p.wet = Math.max(0, p.wet - 0.35);
        p.shedDir = pushMag * 0.5 >= lift ? Math.atan2(pushZ, pushX) : p.disturbed > lift ? Math.random() * TWO_PI_CPU : Math.atan2(RIM_TAPS[low][1], RIM_TAPS[low][0]);
      }
      p.disturbed = 0;
      if (now < p.shedUntil && Math.random() < SHED_RATE * dt * (reduced ? 0.5 : 1)) {
        const a = p.shedDir + (Math.random() - 0.5) * 2.4, rr = p.r * (1.05 + Math.random() * 0.5);
        const [u, v] = this.sim.toUV(p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr);
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) drops.push({ u, v, s: SHED_STRENGTH * (0.6 + Math.random() * 0.8), r: SHED_RADIUS });
      }
      p.swingVX += (pushX * 0.4 - p.swingX * 4 - p.swingVX * 2.4) * dt;
      p.swingVZ += (pushZ * 0.4 - p.swingZ * 4 - p.swingVZ * 2.4) * dt;
      p.swingX += p.swingVX * dt;
      p.swingZ += p.swingVZ * dt;
      // Bead roll is integrated here because the water tilt lives on the GPU; the notch, a lifted rim, and
      // the stalk swing are the three slopes the CPU does know. A dry pad resets so the offset never grows.
      if (p.wet > 0.01) {
        const ms = reduced ? 0.1 : 1;
        const down = Math.min(1, lift) * BEAD_LIFT_ROLL * p.r;
        // Both bead layers repeat every BEAD_RUN radii of creep, so the phase wraps there and a night-long
        // shower never pushes the attribute out of float precision; the downhill slide is capped instead.
        p.rollS = (p.rollS + BEAD_FLOW * p.r * ms * dt) % (BEAD_RUN * p.r);
        p.rollX += (RIM_TAPS[low][0] * down + p.swingX * BEAD_SWING_ROLL) * dt;
        p.rollZ += (RIM_TAPS[low][1] * down + p.swingZ * BEAD_SWING_ROLL) * dt;
        const rm = Math.hypot(p.rollX, p.rollZ), rCap = ROLL_CAP * p.r;
        if (rm > rCap) { p.rollX *= rCap / rm; p.rollZ *= rCap / rm; }
      } else { p.rollX = 0; p.rollZ = 0; p.rollS = 0; }
      const sm = Math.hypot(p.swingX, p.swingZ);
      if (sm > 0.2) { const k = 0.2 / sm; p.swingX *= k; p.swingZ *= k; p.swingVX *= k; p.swingVZ *= k; }

      const o = i * 4;
      this.padD[o] = p.swingX; this.padD[o + 1] = p.swingZ; this.padD[o + 2] = p.wet;
      this.padD[o + 3] = p.flower ? p.flower.lifeScale * p.flower.size : 0;
      this.padE[o] = p.rollX; this.padE[o + 1] = p.rollZ; this.padE[o + 2] = p.rollS;
    });
    this.aPadD.needsUpdate = true;
    this.aPadE.needsUpdate = true;
    if (plopBest > 0 && now > this.plopAt) { this.plopAt = now + 1; this.events?.settle?.(plopX, plopZ); }
    if (drops.length && injector?.available) injector.inject(drops);
    this.updateLilies(dt, now, env);
  }

  /* A hand (or anything the CPU knows about) brushing a pad: its beads fling off on the next update. */
  disturb(x, z, r = 0.3) {
    for (const p of this.pads) if (Math.hypot(x - p.x, z - p.z) < p.r + r) p.disturbed = 1;
  }

  updateLilies(dt, now, env) {
    const cyc = now / MOON_ORBIT_SECONDS;
    const phase = this.U.moonPhase.value;
    this.flowers.forEach((f, i) => {
      const age = cyc - f.born;
      const fadeC = 30 / MOON_ORBIT_SECONDS, growC = 20 / MOON_ORBIT_SECONDS;
      if (age < f.life) f.lifeScale = Math.min(1, age / growC);
      else if (age < f.life + fadeC) f.lifeScale = 1 - (age - f.life) / fadeC;
      else if (age < f.life + 1) f.lifeScale = 0;
      else { f.born = cyc; f.life = f.rng.range(3, 4); f.lifeScale = 0; }
      // Open for ~55% of the orbit; heavy rain for 20 s shuts it, and it takes a minute to trust the sky again.
      const clock = this.bloomDebug === 'cycle' ? now / 40 : phase;
      const s = ((clock + f.offset) % 1 + 1) % 1;
      const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      const pinned = Number.isFinite(+this.bloomDebug) && this.bloomDebug !== null ? +this.bloomDebug : null;
      const bloom = pinned ?? ss(0.10, 0.14, s) * ss(0.66, 0.62, s);
      f.heavyFor = env > 0.7 ? f.heavyFor + dt : Math.max(0, f.heavyFor - dt);
      const target = f.heavyFor > 20 ? 0.15 : 1;
      f.closeLevel += (target - f.closeLevel) * Math.min(1, dt / (target < f.closeLevel ? 10 : 60));
      f.bloom = bloom * f.closeLevel;
      const o = i * 4, p = f.pad;
      this.lilyB[o] = f.bloom; this.lilyB[o + 1] = f.lifeScale; this.lilyB[o + 2] = p.swingX; this.lilyB[o + 3] = p.swingZ;
    });
    this.aLilyB.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.padMesh, this.stalkMesh, this.lilyMesh]) { m.geometry.dispose(); m.material.dispose(); }
  }
}
