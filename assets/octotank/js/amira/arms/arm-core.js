/* Amira's arms without THREE or Jolt: a 24-point chain per arm posed from per-joint bends, stretch, and twist; the
   reach, grip, fetch, and idle programs; and the contact passes that make an arm drape instead of clip. */

import { plantTargets, makePlant, trailTargets, spreadTargets, tuckTargets, makeRecoil, recoilTargets } from './arm-plant-core.js';
import { MuscleArm, GROUPS } from './muscle-core.js';

export const ARM_KNOBS = {
  points: 24,
  length: 0.65,          // m at rest, root to tip, for every arm but the front pair
  frontArms: [0, 7],
  frontScale: 0.92,      // her first pair runs a little shorter than the rest
  tipLenRatio: 0.45,     // last segment's rest length over the first's
  rootRadius: 0.014,     // fuller than the measured arm scaled to her 1 kg (11.5 mm), still 4 mm clear of the next root
  tipRadius: 0.003,
  taperPow: 2,           // radius falls as (1 - s)^taperPow along the arc; arm mass isn't simulated, so this is a look
  bendBase: 0.32,        // rad per joint at the base, loosening toward the tip on a bendPow ramp
  bendTip: 1.1,
  bendPow: 1.5,
  rootBendMax: 1.3,      // rad off the body's outward direction at the root joint
  stretchMax: 1.8,       // longest a base segment gets; the ceiling falls linearly to 1 at the tip
  stretchMin: 0.8,
  stretchTau: 0.12,      // s for a segment's length to follow its program
  recoverRate: 0.5,      // per second, a lengthened segment's way back toward rest
  shortenSpeed: 0.0171,  // m/s over the whole arm, shortening below rest
  twistMax: 0.2,         // rad per segment, either way
  twistAmp: 0.05,
  aimTwistMax: 0.35,     // rad per segment a reach may twist to turn its suckers onto what it reaches for
  aimTau: 0.25,          // s for that twist to take up what it is missing
  aimFrom: 0.05,         // fraction along the arm where that twist starts to ramp in
  stiffTwist: 30,
  stiffIdle: 40,         // 1/s² springs pulling each joint's bend toward its program's target
  stiffAhead: 90,
  stiffBehind: 900,      // behind a reach's bend the arm straightens and stiffens
  stiffDrag: 25,         // past the bend the arm is soft and straightening
  stiffFetch: 500,
  stiffSlack: 4,         // past a fetch's grasp the arm goes limp
  stiffenTime: 0.35,     // s for a reach's base to reach full stiffness
  damping: 0.95,         // fraction of critical
  curlBase: 0.03,        // resting curl toward the sucker side, rad per joint at the root
  curlTip: 0.5,          // added by the tip, on a curlPow ramp
  curlPow: 2.2,
  awakeBase: 0.02,       // awake idle bend, rad per joint, in a direction re-picked with each wander target
  awakeTip: 0.3,
  oralShare: 0.12,       // share of awake bends toward the sucker side
  restTau: 1.5,          // s to settle into or out of rest
  restNoise: 0.35,       // noise and aim left while resting
  restAim: 0.3,
  noiseAmp: 0.07,
  noiseHz: 0.11,
  noiseHz2: 0.27,
  noiseWave: 4.5,        // rad of phase along the arm, so the noise is a slow traveling ripple
  idleAim: 0.55,         // how much of the turn toward the wander target the idle base takes
  wanderMin: 3,          // s between new exploration targets
  wanderMax: 7,
  wanderCone: 1.0,       // rad around the outward direction
  wanderReach: 0.6,      // fraction of the arm's length
  wanderSnap: 0.18,      // m: a target this near a surface is pulled onto it
  wanderGap: 0.015,
  wanderTau: 1.6,        // s, smoothing on the target the base actually follows
  aimShare: 0.7,         // fraction of a joint's limit each aiming joint may take
  reachSpeed: 0.35,      // m/s, the bend's peak speed unless a reach asks for another
  bendSpeedMax: 0.5,     // m/s the bend never passes
  reachMinDuration: 0.5,
  reachRise: 3,          // the speed profile's rise exponent: peak at rise / (rise + 1) of the reach
  reachRiseJitter: 0.8,
  reachStretch: 1.3,     // mean base lengthening a reach prefers before it moves the contact off the middle
  stretchFall: 0.5,      // share of the base's lengthening lost by the contact point (the base stretches most)
  contactMin: 0.33,      // the part of the arm a reach delivers to its target, as a fraction of its length
  contactMax: 0.67,
  reachAmplitude: 0.36,  // rad per joint at the traveling bend's peak
  reachWidth: 0.09,      // of the arm's length
  gripFrom: 0.7,         // reach progress where FABRIK starts placing the contact point
  holdTime: 1.6,
  dragTau: 0.18,         // s the trailing part of the arm lags behind its pose
  dragFree: 0.05,        // drag under this no longer counts, so contact's catch-up limit is back as a reach's drag fades
  weightRise: 0.2,       // s for a program's weight to come up
  release: 0.9,          // s for it to fade back to idle
  fabrikIters: 3,
  fetchGrasp: 0.5,       // grasp point, as a fraction of the length, when a fetch isn't told one
  fetchDuration: 1.2,
  fetchBase: 0.2,        // rad the base joint closes and opens again over the fetch
  fetchDistalFrom: 0.55, // fetch progress where the joint nearest the food starts to turn
  fetchSmear: 3,         // joints either side a pseudo-joint's fold spreads over
  fetchLimitSlack: 1.15, // a fold's joints may bend this much past their share of it
  fetchHold: 2.5,
  collideIters: 2,
  finishIters: 3,
  bodySkip: 3,           // points at each root whose radius ramps in for the body test (they grow out of her skin)
  bodyScale: 0.92,
  pin: 2,                // points at each root that arm-on-arm contact never moves
  selfSkip: 3,           // segments of one arm closer than this along the chain never touch
  contactMargin: 0.012,  // m: a pair this near is watched for crossing
  focusPad: 0.15,        // m around an arm's last chain where its contact looks for solids; more than a point moves in a tick
  foldSlack: 0.03,       // a segment squeezed shorter by this fraction may fold past the bend limit to keep its length
  foldJam: 0.85,         // and one squeezed under this share of its length folds the way the surfaces push
  contactFeedback: 1,    // share of the contact-solved shape the bends take where contact moved the arm
  feedbackRest: 1,       // how much of that a resting arm gives up, so its curl keeps pressing into what it wraps
  contactRelax: 1,       // s for what contact left in the bends to fade, so an arm leans back into its program's shape
  sweepStep: 0.5,        // a point's move is checked for contact every this many of its radii
  sweepMax: 16,          // checks per leg of a move at most; a longer one finishes next tick
  sweepLegs: 3,          // a stop and a slide along the surface it met make one leg
  sweepUnfold: 0.75,     // in the swept solve, only a segment squeezed under this share of its length is unfolded
  jumpReset: 0.05,       // m a root may move in one tick before the arm is seated afresh, as on its first tick
  stillTol: 2e-5,        // m a point may move in a finishing pass and still skip its contact check
  headOn: 0.9,           // a contact normal this square against a segment meets it head-on
  unfoldRate: 1.5,       // rad/s a fold contact forced past a joint's limit straightens at once contact lets go
  catchUp: 0.3,          // rad/s a segment may turn toward its pose beyond the pose's own turn, once contact lets it go
  muscle: 0,             // 1: the programs' bends, stretch, and twist go through the muscle map and come back as what it can make
  reachAct: 0.526,       // sucker-side longitudinal activation at a reach's traveling bend; reachAmplitude's bend at mid-arm
  braceMax: 0.4,         // co-contraction where a program stiffens the arm all the way, as behind a reach's bend
  curlAct: 0.62,         // sucker-side activation at the tip of a resting curl in muscle mode, rising from the base on curlActPow
  curlActPow: 2.5,
  crowd: 0,              // 1: each arm feels the other arms' bodies near it (arm-crowd.js) and its programs steer off the crowded side
  crowdRange: 0.05,      // m of clearance under which another arm crowds a sample; its push rises as (1 - gap/range)²
  crowdSamples: 6,       // points per arm that feel the crowd, evenly spaced from crowdFrom of the way out to the tip
  crowdFrom: 0.3,
  crowdTau: 1,           // s the idle lean follows the push over; it fades out while a program holds the arm
  crowdWander: 2,        // a wander or awake pick into the crowd mirrors toward the open side by this × the lean, at most all the way
  crowdAim: 0.6,         // share of the wander distance a full lean moves the target the idle aim follows
  crowdReach: 0.05,      // rad per joint past a reach's contact point a full push bends the trailing arm off the crowd
};

export function minJerk(u) {
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return u * u * u * (10 + u * (-15 + 6 * u));
}

/* The reach's bend position over normalized time: speed ∝ u^a (1 - u), a slow start and a peak late, at a / (a + 1). */
export function lateProfile(u, a) {
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ua = Math.pow(u, a + 1);
  return (a + 2) * ua - (a + 1) * ua * u;
}

export function lateSpeed(u, a) {
  if (u <= 0 || u >= 1) return 0;
  return (a + 1) * (a + 2) * Math.pow(u, a) * (1 - u);
}

/* Peak of lateSpeed over its mean, so a bend covering D in T peaks at latePeak(a) · D / T. */
export function latePeak(a) { return (a + 2) * Math.pow(a / (a + 1), a); }

export function reachTime(distance, speed, a, minDuration = 0) {
  return Math.max(minDuration, latePeak(a) * distance / Math.max(1e-6, speed));
}

/* Rest geometry of one arm: segment lengths on the tipLenRatio ramp and radii on the taper, by arc. */
export function restArm(points, length, tipLenRatio, rootRadius, tipRadius, taperPow, len, rad, arc) {
  const S = points - 1;
  let sum = 0;
  for (let j = 0; j < S; j++) { len[j] = 1 + (tipLenRatio - 1) * j / Math.max(1, S - 1); sum += len[j]; }
  arc[0] = 0;
  for (let j = 0; j < S; j++) { len[j] *= length / sum; arc[j + 1] = arc[j] + len[j]; }
  for (let i = 0; i < points; i++) rad[i] = tipRadius + (rootRadius - tipRadius) * Math.pow(Math.max(0, 1 - arc[i] / length), taperPow);
}

/* Volume of a chain of frustums (m³). */
export function armVolume(len, rad) {
  let v = 0;
  for (let j = 0; j < len.length; j++) v += Math.PI * len[j] / 3 * (rad[j] * rad[j] + rad[j] * rad[j + 1] + rad[j + 1] * rad[j + 1]);
  return v;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Rotate the frame (d, u, v), each a 3-array, by bend (ku, kv): d tips toward ku·u + kv·v by |k| radians. */
function bendFrame(d, u, v, ku, kv) {
  const phi = len2(ku, kv);
  if (phi < 1e-12) return;
  const ex = (ku * u[0] + kv * v[0]) / phi, ey = (ku * u[1] + kv * v[1]) / phi, ez = (ku * u[2] + kv * v[2]) / phi;
  const c = Math.cos(phi), s = Math.sin(phi);
  // u and v split into their e part, which turns with d, and their part along the hinge, which stays.
  const ue = ku / phi, ve = kv / phi;
  const nex = c * ex - s * d[0], ney = c * ey - s * d[1], nez = c * ez - s * d[2];
  d[0] = c * d[0] + s * ex; d[1] = c * d[1] + s * ey; d[2] = c * d[2] + s * ez;
  u[0] += ue * (nex - ex); u[1] += ue * (ney - ey); u[2] += ue * (nez - ez);
  v[0] += ve * (nex - ex); v[1] += ve * (ney - ey); v[2] += ve * (nez - ez);
}

/* The bends that reproduce chain P from root frame F (P[0] at its root) under twists tw, into out for the first `count`
   joints: poseFromBends run backward. d, u, and v are 3-array scratch. */
export function chainBends(F, tw, P, out, count, d, u, v) {
  d[0] = F.d[0]; d[1] = F.d[1]; d[2] = F.d[2];
  u[0] = F.u[0]; u[1] = F.u[1]; u[2] = F.u[2];
  v[0] = F.v[0]; v[1] = F.v[1]; v[2] = F.v[2];
  for (let j = 0; j < count; j++) {
    let qx = P[j * 3 + 3] - P[j * 3], qy = P[j * 3 + 4] - P[j * 3 + 1], qz = P[j * 3 + 5] - P[j * 3 + 2];
    const ql = len3(qx, qy, qz);
    out[j * 2] = 0; out[j * 2 + 1] = 0;
    if (ql >= 1e-12) {
      qx /= ql; qy /= ql; qz /= ql;
      const c = qx * d[0] + qy * d[1] + qz * d[2];
      let ex = qx - c * d[0], ey = qy - c * d[1], ez = qz - c * d[2];
      const el = len3(ex, ey, ez);
      let phi = 0;
      if (el < 1e-12) { if (c <= 0) { ex = u[0]; ey = u[1]; ez = u[2]; phi = Math.PI; } }
      else { ex /= el; ey /= el; ez /= el; phi = Math.atan2(el, c); }
      if (phi > 0) {
        const ku = phi * (ex * u[0] + ey * u[1] + ez * u[2]), kv = phi * (ex * v[0] + ey * v[1] + ez * v[2]);
        out[j * 2] = ku; out[j * 2 + 1] = kv;
        bendFrame(d, u, v, ku, kv);
      }
    }
    roll(u, v, tw[j]);
  }
  return out;
}

function normalize3(a, fx = 0, fy = 1, fz = 0) {
  const l = len3(a[0], a[1], a[2]);
  if (l < 1e-12 || !Number.isFinite(l)) { a[0] = fx; a[1] = fy; a[2] = fz; return a; }
  a[0] /= l; a[1] /= l; a[2] /= l;
  return a;
}

/* Clamp the unit vector at out[o..o+2] into the cone of half-angle `lim` around unit ref (rx, ry, rz). */
function coneClamp(out, o, rx, ry, rz, cosL, sinL) {
  const c = out[o] * rx + out[o + 1] * ry + out[o + 2] * rz;
  if (c >= cosL) return;
  let ex = out[o] - c * rx, ey = out[o + 1] - c * ry, ez = out[o + 2] - c * rz;
  let l = len3(ex, ey, ez);
  if (l < 1e-9) {
    // Folded straight back: any perpendicular will do.
    ex = Math.abs(ry) < 0.9 ? 0 : 1; ey = Math.abs(ry) < 0.9 ? 1 : 0; ez = 0;
    const k = ex * rx + ey * ry + ez * rz;
    ex -= k * rx; ey -= k * ry; ez -= k * rz;
    l = len3(ex, ey, ez);
  }
  out[o] = cosL * rx + sinL * ex / l;
  out[o + 1] = cosL * ry + sinL * ey / l;
  out[o + 2] = cosL * rz + sinL * ez / l;
}


/* FABRIK on a flat [x, y, z, ...] chain, root pinned. A `cone` keeps each joint in its limit on every pass: one `lim`
   for all, or `cos`/`sin` arrays per point, plus `rootLim` around the direction `root`. */
export function fabrik(pts, lens, n, tx, ty, tz, iters, cone = null) {
  const rx = pts[0], ry = pts[1], rz = pts[2];
  let reach = 0;
  for (let i = 0; i < n - 1; i++) reach += lens[i];
  const dist = len3(tx - rx, ty - ry, tz - rz);
  if (dist >= reach && !cone) {
    // Out of reach: lay the chain straight at it; the result is finite even for a target on the root.
    let dx = tx - rx, dy = ty - ry, dz = tz - rz;
    const l = dist > 1e-12 ? dist : 1;
    if (dist <= 1e-12) { dx = 0; dy = 1; dz = 0; }
    for (let i = 1; i < n; i++) {
      pts[i * 3] = pts[i * 3 - 3] + dx / l * lens[i - 1];
      pts[i * 3 + 1] = pts[i * 3 - 2] + dy / l * lens[i - 1];
      pts[i * 3 + 2] = pts[i * 3 - 1] + dz / l * lens[i - 1];
    }
    return len3(pts[n * 3 - 3] - tx, pts[n * 3 - 2] - ty, pts[n * 3 - 1] - tz);
  }
  const per = cone?.cos ?? null;
  const cL = cone && !per ? Math.cos(cone.lim) : -1, sL = cone && !per ? Math.sin(cone.lim) : 0;
  const cR = cone ? Math.cos(cone.rootLim) : -1, sR = cone ? Math.sin(cone.rootLim) : 0;
  for (let it = 0; it < iters; it++) {
    pts[n * 3 - 3] = tx; pts[n * 3 - 2] = ty; pts[n * 3 - 1] = tz;
    for (let i = n - 2; i >= 0; i--) {
      const j = i + 1;
      placeToward(pts, i, j, lens[i], cone && i + 2 < n ? i + 2 : -1, per ? per[j] : cL, per ? cone.sin[j] : sL);
    }
    pts[0] = rx; pts[1] = ry; pts[2] = rz;
    for (let i = 1; i < n; i++) {
      const j = i - 1;
      if (cone && i === 1) placeAlong(pts, 1, 0, lens[0], cone.root, cR, sR);
      else placeToward(pts, i, j, lens[i - 1], cone && i >= 2 ? i - 2 : -1, per ? per[j] : cL, per ? cone.sin[j] : sL);
    }
  }
  return len3(pts[n * 3 - 3] - tx, pts[n * 3 - 2] - ty, pts[n * 3 - 1] - tz);
}

const _dir = [0, 0, 0];

/* Put point i at distance len from j, toward where it already is; with k >= 0, inside the cone around k → j. */
function placeToward(pts, i, j, len, k, cL, sL) {
  _dir[0] = pts[i * 3] - pts[j * 3]; _dir[1] = pts[i * 3 + 1] - pts[j * 3 + 1]; _dir[2] = pts[i * 3 + 2] - pts[j * 3 + 2];
  let rx = 0, ry = 1, rz = 0;
  if (k >= 0) {
    rx = pts[j * 3] - pts[k * 3]; ry = pts[j * 3 + 1] - pts[k * 3 + 1]; rz = pts[j * 3 + 2] - pts[k * 3 + 2];
    const rl = len3(rx, ry, rz);
    if (rl < 1e-12) k = -1; else { rx /= rl; ry /= rl; rz /= rl; }
  }
  normalize3(_dir, rx, ry, rz);
  if (k >= 0) coneClamp(_dir, 0, rx, ry, rz, cL, sL);
  pts[i * 3] = pts[j * 3] + _dir[0] * len; pts[i * 3 + 1] = pts[j * 3 + 1] + _dir[1] * len; pts[i * 3 + 2] = pts[j * 3 + 2] + _dir[2] * len;
}

function placeAlong(pts, i, j, len, ref, cL, sL) {
  _dir[0] = pts[i * 3] - pts[j * 3]; _dir[1] = pts[i * 3 + 1] - pts[j * 3 + 1]; _dir[2] = pts[i * 3 + 2] - pts[j * 3 + 2];
  normalize3(_dir, ref[0], ref[1], ref[2]);
  coneClamp(_dir, 0, ref[0], ref[1], ref[2], cL, sL);
  pts[i * 3] = pts[j * 3] + _dir[0] * len; pts[i * 3 + 1] = pts[j * 3 + 1] + _dir[1] * len; pts[i * 3 + 2] = pts[j * 3 + 2] + _dir[2] * len;
}

/* Signed-distance world over boxes, spheres, capsules (local +Y axis, as Jolt's), and planes. A primitive's
   `q` is its world rotation; collide() returns the deepest penetration of a sphere and its outward normal. */
export function makeSdfWorld(prims, { fixed = prims.length } = {}) {
  const ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0];
  // Pose a primitive and its world-space bounds, so a probe far from it costs six compares.
  const place = (p, c, q) => {
    p.c[0] = c[0]; p.c[1] = c[1]; p.c[2] = c[2];
    p.q[0] = q[0]; p.q[1] = q[1]; p.q[2] = q[2]; p.q[3] = q[3];
    p.flat = Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2]) < 1e-9;
    if (p.type === 'plane' || p.type === 'field') return;
    rot(q, 1, 0, 0, ax); rot(q, 0, 1, 0, ay); rot(q, 0, 0, 1, az);
    // World up in the primitive's own axes, so a loose box knows which of its faces look down.
    if (p.up) { p.up[0] = ax[1]; p.up[1] = ay[1]; p.up[2] = az[1]; }
    for (let i = 0; i < 3; i++) {
      const e = p.type === 'box' ? Math.abs(ax[i]) * p.h[0] + Math.abs(ay[i]) * p.h[1] + Math.abs(az[i]) * p.h[2] : p.type === 'capsule' ? Math.abs(ay[i]) * p.hh + p.r : p.r;
      p.lo[i] = c[i] - e; p.hi[i] = c[i] + e;
    }
  };
  const P = prims.map((p, i) => {
    const o = { ...p, q: [0, 0, 0, 1], c: [0, 0, 0], flat: true, lo: [-Infinity, -Infinity, -Infinity], hi: [Infinity, Infinity, Infinity], sealed: null, loose: i >= fixed, up: [0, 1, 0] };
    place(o, p.c ?? [0, 0, 0], p.q ?? [0, 0, 0, 1]);
    return o;
  });
  const loc = [0, 0, 0], g = [0, 0, 0];
  // A loose thing rests on the floor, so it never pushes an arm down into it: a push that way turns sideways.
  const noDown = () => {
    if (g[1] >= -0.3) return;
    g[1] = 0;
    const l = len2(g[0], g[2]);
    if (l > 1e-6) { g[0] /= l; g[2] /= l; } else { g[0] = 1; g[2] = 0; }
  };
  // Distance from primitive p to (x, y, z), its world gradient written to g.
  const sdf = (p, x, y, z) => {
    if (p.type === 'field') return p.distance(x, y, z, g);
    if (p.type === 'plane') {
      g[0] = p.n[0]; g[1] = p.n[1]; g[2] = p.n[2];
      return x * p.n[0] + y * p.n[1] + z * p.n[2] - p.d;
    }
    const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2];
    if (p.type === 'sphere') {
      const l = len3(dx, dy, dz);
      if (l < 1e-12) { g[0] = 0; g[1] = 1; g[2] = 0; } else { g[0] = dx / l; g[1] = dy / l; g[2] = dz / l; }
      if (p.loose) noDown();
      return l - p.r;
    }
    if (p.flat) { loc[0] = dx; loc[1] = dy; loc[2] = dz; } else rotInv(p.q, dx, dy, dz, loc);
    let d;
    if (p.type === 'box') {
      const ax = Math.abs(loc[0]) - p.h[0], ay = Math.abs(loc[1]) - p.h[1], az = Math.abs(loc[2]) - p.h[2];
      const ox = ax > 0 ? ax : 0, oy = ay > 0 ? ay : 0, oz = az > 0 ? az : 0;
      const out = len3(ox, oy, oz);
      if (out > 0) {
        d = out;
        g[0] = (loc[0] < 0 ? -ox : ox) / out; g[1] = (loc[1] < 0 ? -oy : oy) / out; g[2] = (loc[2] < 0 ? -oz : oz) / out;
      } else {
        // Inside: leave by the nearest face that isn't sealed against another solid (a panel standing on the floor
        // must not push a point down into it, where the floor pushes it straight back).
        d = -Infinity;
        for (let k = 0; k < 3; k++) {
          for (let s = -1; s <= 1; s += 2) {
            if (p.sealed?.[k * 2 + (s > 0 ? 1 : 0)]) continue;
            if (p.loose && s * (p.flat ? (k === 1 ? 1 : 0) : p.up[k]) < -0.7) continue;
            const e = s * loc[k] - p.h[k];
            if (e > d) { d = e; g[0] = 0; g[1] = 0; g[2] = 0; g[k] = s; }
          }
        }
        if (d === -Infinity) {
          g[0] = 0; g[1] = 0; g[2] = 0;
          if (ax >= ay && ax >= az) { d = ax; g[0] = loc[0] < 0 ? -1 : 1; }
          else if (ay >= az) { d = ay; g[1] = loc[1] < 0 ? -1 : 1; }
          else { d = az; g[2] = loc[2] < 0 ? -1 : 1; }
        }
      }
    } else {
      // Past an end cap that butts against another solid the capsule is a plain cylinder: leave sideways, never into it.
      const cy = (loc[1] > p.hh && p.sealed?.[1]) || (loc[1] < -p.hh && p.sealed?.[0]) ? loc[1] : Math.max(-p.hh, Math.min(p.hh, loc[1]));
      const vx = loc[0], vy = loc[1] - cy, vz = loc[2];
      const l = len3(vx, vy, vz);
      if (l < 1e-12) { g[0] = 1; g[1] = 0; g[2] = 0; } else { g[0] = vx / l; g[1] = vy / l; g[2] = vz / l; }
      d = l - p.r;
    }
    if (!p.flat) rot(p.q, g[0], g[1], g[2], g);
    if (p.loose) noDown();
    return d;
  };
  // A box face, or a capsule's end cap, is sealed when the point just past its center lies inside another primitive.
  // Only the first `fixed` primitives seal or are sealed; the rest move.
  const face = [0, 0, 0], F = P.slice(0, fixed);
  for (const p of F) {
    if (p.type === 'capsule') {
      p.sealed = [-1, 1].map((sgn) => {
        face[0] = 0; face[1] = sgn * (p.hh + p.r + 1e-3); face[2] = 0;
        if (!p.flat) rot(p.q, face[0], face[1], face[2], face);
        return F.some((o) => o !== p && sdf(o, p.c[0] + face[0], p.c[1] + face[1], p.c[2] + face[2]) < 0);
      });
      continue;
    }
    if (p.type !== 'box') continue;
    p.sealed = [false, false, false, false, false, false];
    for (let k = 0; k < 3; k++) {
      for (let s = -1; s <= 1; s += 2) {
        face[0] = 0; face[1] = 0; face[2] = 0;
        face[k] = s * (p.h[k] + 1e-3);
        if (!p.flat) rot(p.q, face[0], face[1], face[2], face);
        const x = p.c[0] + face[0], y = p.c[1] + face[1], z = p.c[2] + face[2];
        p.sealed[k * 2 + (s > 0 ? 1 : 0)] = F.some((o) => o !== p && sdf(o, x, y, z) < 0);
      }
    }
  }
  // The primitives a probe looks at: all of them, or those near one arm after focus().
  const act = Int32Array.from(P, (_, i) => i);
  let nAct = P.length;
  const api = {
    prims: P,
    hit: -1,
    skip: -1,              // one primitive collide() ignores, such as the toy the probing arm holds.
    skipLo: 0, skipHi: Infinity, // for probes of these arm points only (a probe naming no point always skips it)
    /* Move primitive i, one past the fixed ones, to its pose this tick. */
    move(i, c, q) { place(P[i], c, q); },
    /* Narrow every collide() to the primitives whose bounds meet the box lo..hi, until the next focus or unfocus. */
    focus(lo, hi) {
      nAct = 0;
      for (let i = 0; i < P.length; i++) {
        const a = P[i].lo, b = P[i].hi;
        if (a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1] && a[2] <= hi[2] && b[2] >= lo[2]) act[nAct++] = i;
      }
    },
    unfocus() { nAct = P.length; for (let i = 0; i < P.length; i++) act[i] = i; },
    /* Deepest penetration of a sphere and its outward normal; `hit` is left on the primitive it came from, or -1. `pt`
       is the arm point probing, if any, for skip's range. */
    collide(x, y, z, r, out, pt) {
      let best = 0, bi = -1;
      const skip = pt === undefined || (pt >= api.skipLo && pt <= api.skipHi) ? api.skip : -1;
      for (let k = 0; k < nAct; k++) {
        if (act[k] === skip) continue;
        const p = P[act[k]], lo = p.lo, hi = p.hi;
        if (x < lo[0] - r || x > hi[0] + r || y < lo[1] - r || y > hi[1] + r || z < lo[2] - r || z > hi[2] + r) continue;
        const pen = r - sdf(p, x, y, z);
        if (pen > best) { best = pen; bi = act[k]; out[0] = g[0]; out[1] = g[1]; out[2] = g[2]; }
      }
      api.hit = bi;
      return best;
    },
    distance(x, y, z, out) {
      let best = Infinity;
      for (let i = 0; i < P.length; i++) {
        const p = P[i], lo = p.lo, hi = p.hi;
        const ox = x < lo[0] ? lo[0] - x : x > hi[0] ? x - hi[0] : 0;
        const oy = y < lo[1] ? lo[1] - y : y > hi[1] ? y - hi[1] : 0;
        const oz = z < lo[2] ? lo[2] - z : z > hi[2] ? z - hi[2] : 0;
        const lb = ox * ox + oy * oy + oz * oz;
        if (best <= 0 ? lb > 0 : lb >= best * best) continue;
        const d = sdf(p, x, y, z);
        if (d < best) { best = d; out[0] = g[0]; out[1] = g[1]; out[2] = g[2]; }
      }
      return best;
    },
  };
  return api;
}

function len3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

function orKnob(v, fallback) { return Number.isFinite(v) ? v : fallback; }

/* The radius the body test sees at point i: the arm grows out of her skin, so near the root only its center has to stay out. */
export function bodyRadius(r, i, ramp) { return i >= ramp ? r : (r * i) / ramp; }
function finite3(a) { return !!a && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]); }
function len2(x, y) { return Math.sqrt(x * x + y * y); }

function rot(q, x, y, z, out) {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

function rotInv(q, x, y, z, out) {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/* Her body as the arms see it: an axis-aligned ellipsoid fitted to the shell's spread, then shrunk until every
   root sits outside it, so an arm can leave the crown without being shoved off it. */
export class BodyEllipsoid {
  constructor() { this.c = [0, 0, 0]; this.R = [1, 1, 1]; this.active = false; }

  fit(positions, count, origin, roots, scale) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < count; i++) { x += positions[i * 3]; y += positions[i * 3 + 1]; z += positions[i * 3 + 2]; }
    x /= count; y /= count; z /= count;
    let vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < count; i++) {
      const a = positions[i * 3] - x, b = positions[i * 3 + 1] - y, c = positions[i * 3 + 2] - z;
      vx += a * a; vy += b * b; vz += c * c;
    }
    // A shell spread evenly over a sphere of radius r has variance r²/3 along each axis.
    const R = this.R, C = this.c;
    R[0] = Math.max(1e-3, Math.sqrt(3 * vx / count) * scale);
    R[1] = Math.max(1e-3, Math.sqrt(3 * vy / count) * scale);
    R[2] = Math.max(1e-3, Math.sqrt(3 * vz / count) * scale);
    C[0] = x + origin[0]; C[1] = y + origin[1]; C[2] = z + origin[2];
    let kMin = Infinity;
    for (let r = 0; r < roots.length; r += 3) {
      const k = len3((roots[r] - C[0]) / R[0], (roots[r + 1] - C[1]) / R[1], (roots[r + 2] - C[2]) / R[2]);
      if (k < kMin) kMin = k;
    }
    if (kMin < 1.02) { const f = Math.max(0.05, kMin / 1.02); R[0] *= f; R[1] *= f; R[2] *= f; }
    this.active = Number.isFinite(C[0] + C[1] + C[2] + R[0] + R[1] + R[2]);
    return this;
  }

  /* Signed distance (Inigo Quilez's ellipsoid bound: exact in sign, close near the surface); kept for `normal`. */
  distance(x, y, z) {
    if (!this.active) return Infinity;
    const C = this.c, R = this.R, g = this._g ??= [0, 0, 0];
    const dx = x - C[0], dy = y - C[1], dz = z - C[2];
    const k0 = len3(dx / R[0], dy / R[1], dz / R[2]);
    g[0] = dx / (R[0] * R[0]); g[1] = dy / (R[1] * R[1]); g[2] = dz / (R[2] * R[2]);
    const k1 = len3(g[0], g[1], g[2]);
    return k1 < 1e-12 ? -Math.min(R[0], R[1], R[2]) : (k0 * (k0 - 1)) / k1;
  }

  normal(out) {
    const g = this._g ?? [0, 1, 0], l = len3(g[0], g[1], g[2]);
    if (l > 1e-12) { out[0] = g[0] / l; out[1] = g[1] / l; out[2] = g[2] / l; } else { out[0] = 0; out[1] = -1; out[2] = 0; }
    return out;
  }

  /* Penetration of a sphere of radius r, outward normal into out; approximate off the axes, exact on them. */
  collide(x, y, z, r, out) {
    if (!this.active) return 0;
    const C = this.c, R = this.R;
    const dx = x - C[0], dy = y - C[1], dz = z - C[2];
    const ax = R[0] + r, ay = R[1] + r, az = R[2] + r;
    const k = len3(dx / ax, dy / ay, dz / az);
    if (k >= 1) return 0;
    if (k < 1e-9) { out[0] = 0; out[1] = -1; out[2] = 0; return Math.min(ay, ax, az); }
    // Gradient of the scaled radius, and the radial step that lands the point on the inflated surface.
    let gx = dx / (ax * ax), gy = dy / (ay * ay), gz = dz / (az * az);
    const gl = len3(gx, gy, gz);
    gx /= gl; gy /= gl; gz /= gl;
    const step = len3(dx, dy, dz) * (1 / k - 1);
    out[0] = gx; out[1] = gy; out[2] = gz;
    return step;
  }
}

/* Her body as the arms see it: the live shell, squashed or not. Skin vertices near a point, weighted by distance,
   give its depth along their blended normal; past the skin's reach a `core` answers (signed `distance(x, y, z)` and
   `normal(out)`), and the two blend by the skin's weight so depth never jumps between them. */
export class ShellBody {
  constructor(count, edge, core = new BodyEllipsoid()) {
    this.edge = edge;
    this.support2 = (2 * edge) ** 2;
    this.cell = Math.max(0.02, 2 * edge);
    this.W = new Float64Array(count * 3);
    this.N = new Float64Array(count * 3);
    this.hash = new SpatialHash(count, 2048);
    this.lo = [0, 0, 0]; this.hi = [0, 0, 0];
    this.core = core;
    this._n = [0, 0, 0];
    this.active = false;
  }

  fit(positions, faces, count, origin, roots, scale) {
    const W = this.W, N = this.N, lo = this.lo, hi = this.hi, cell = this.cell, h = this.hash;
    lo[0] = lo[1] = lo[2] = Infinity; hi[0] = hi[1] = hi[2] = -Infinity;
    for (let v = 0; v < count; v++) {
      for (let a = 0; a < 3; a++) {
        const p = W[v * 3 + a] = positions[v * 3 + a] + origin[a];
        if (p < lo[a]) lo[a] = p;
        if (p > hi[a]) hi[a] = p;
      }
    }
    N.fill(0);
    for (let f = 0; f < faces.length; f += 3) {
      const i = faces[f] * 3, j = faces[f + 1] * 3, k = faces[f + 2] * 3;
      const ux = W[j] - W[i], uy = W[j + 1] - W[i + 1], uz = W[j + 2] - W[i + 2];
      const vx = W[k] - W[i], vy = W[k + 1] - W[i + 1], vz = W[k + 2] - W[i + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      N[i] += cx; N[i + 1] += cy; N[i + 2] += cz;
      N[j] += cx; N[j + 1] += cy; N[j + 2] += cz;
      N[k] += cx; N[k + 1] += cy; N[k + 2] += cz;
    }
    for (let v = 0; v < count * 3; v += 3) {
      const l = len3(N[v], N[v + 1], N[v + 2]);
      if (l > 1e-18) { N[v] /= l; N[v + 1] /= l; N[v + 2] /= l; }
    }
    h.clear();
    this.active = Number.isFinite(lo[0] + lo[1] + lo[2] + hi[0] + hi[1] + hi[2]);
    if (this.active) for (let v = 0; v < count; v++) h.insert(v, Math.floor(W[v * 3] / cell), Math.floor(W[v * 3 + 1] / cell), Math.floor(W[v * 3 + 2] / cell));
    this.core.fit(positions, count, origin, roots, scale);
    return this;
  }

  /* Penetration of a sphere of radius r into her, outward normal into out. */
  collide(x, y, z, r, out) {
    if (!this.active) return 0;
    const lo = this.lo, hi = this.hi, m = r + this.edge;
    if (x < lo[0] - m || y < lo[1] - m || z < lo[2] - m || x > hi[0] + m || y > hi[1] + m || z > hi[2] + m) return 0;
    const W = this.W, N = this.N, h = this.hash, cell = this.cell, S2 = this.support2;
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell), iz = Math.floor(z / cell);
    let sw = 0, nx = 0, ny = 0, nz = 0, sd = 0;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
      for (let v = h.head[h.key(ix + ox, iy + oy, iz + oz)]; v !== -1; v = h.next[v]) {
        const dx = x - W[v * 3], dy = y - W[v * 3 + 1], dz = z - W[v * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= S2) continue;
        const q = 1 - d2 / S2, w = q * q, a = N[v * 3], b = N[v * 3 + 1], c = N[v * 3 + 2];
        sw += w; nx += w * a; ny += w * b; nz += w * c; sd += w * (dx * a + dy * b + dz * c);
      }
    }
    // The skin's share runs from 0 at the edge of its reach to 1 once a vertex's worth of weight is near.
    const l = len3(nx, ny, nz);
    const t = l > 1e-9 ? Math.min(1, sw) : 0;
    const d = t < 1 ? (t > 0 ? t * (sd / sw) : 0) + (1 - t) * this.core.distance(x, y, z) : sd / sw;
    const pen = r - d;
    if (!(pen > 0)) return 0;
    if (t > 0) { nx /= l; ny /= l; nz /= l; }
    if (t < 1) {
      const c = this.core.normal(this._n);
      nx = t * nx + (1 - t) * c[0]; ny = t * ny + (1 - t) * c[1]; nz = t * nz + (1 - t) * c[2];
    }
    const nl = len3(nx, ny, nz);
    if (!(nl > 1e-12)) return 0;
    out[0] = nx / nl; out[1] = ny / nl; out[2] = nz / nl;
    return pen;
  }
}

/* Uniform-grid hash over every arm point: heads per bucket, a next link per point. */
export class SpatialHash {
  constructor(capacity, buckets = 1024) {
    this.mask = buckets - 1;
    this.head = new Int32Array(buckets).fill(-1);
    this.next = new Int32Array(capacity);
    this.used = new Int32Array(capacity);
    this.nUsed = 0;
  }

  key(ix, iy, iz) { return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & this.mask; }

  clear() {
    for (let i = 0; i < this.nUsed; i++) this.head[this.used[i]] = -1;
    this.nUsed = 0;
  }

  insert(id, ix, iy, iz) {
    const k = this.key(ix, iy, iz);
    if (this.head[k] === -1) this.used[this.nUsed++] = k;
    this.next[id] = this.head[k];
    this.head[k] = id;
  }
}

/* Closest points between segments p0p1 and q0q1 (Ericson, Real-Time Collision Detection 5.1.9). Writes s and t,
   the parameters along each, into out[0], out[1]; returns the squared distance. */
export function segSegClosest(p0x, p0y, p0z, p1x, p1y, p1z, q0x, q0y, q0z, q1x, q1y, q1z, out) {
  const d1x = p1x - p0x, d1y = p1y - p0y, d1z = p1z - p0z;
  const d2x = q1x - q0x, d2y = q1y - q0y, d2z = q1z - q0z;
  const rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-14 && e <= 1e-14) { s = 0; t = 0; }
  else if (a <= 1e-14) { s = 0; t = clamp01(f / e); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-14) { t = 0; s = clamp01(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-14 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  out[0] = s; out[1] = t;
  const dx = p0x + d1x * s - q0x - d2x * t, dy = p0y + d1y * s - q0y - d2y * t, dz = p0z + d1z * s - q0z - d2z * t;
  return dx * dx + dy * dy + dz * dz;
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

const BLOCK = 4;

/* State for arm-on-arm contact: per-segment and per-block bounds, and for every segment pair the side each lay on
   last tick, which is what catches a crossing the closest points alone would read backward. */
export function makeArmContact(arms) {
  const count = arms.length, S = (arms[0]?.n ?? 1) - 1, NS = count * S, blocks = Math.ceil(S / BLOCK);
  return {
    count, S, NS, blocks,
    seg: new Float64Array(NS * 6), blk: new Float64Array(count * blocks * 6), box: new Float64Array(count * 6),
    side: new Int8Array(NS * NS), stamp: new Int32Array(NS * NS).fill(-2),
    // Segments whose sucker side lay against another arm (or another part of the same one) in the recording round.
    touch: new Uint8Array(NS), touchGap: 0.003, faceCos: 0,
    tick: 0, crossings: 0, pushes: 0, _st: [0, 0],
  };
}

function boundSegments(arms, st, pad) {
  const { S, blocks, seg, blk, box } = st;
  for (let a = 0; a < arms.length; a++) {
    const X = arms[a].X, R = arms[a].rad;
    const bo = a * 6;
    box[bo] = box[bo + 1] = box[bo + 2] = Infinity; box[bo + 3] = box[bo + 4] = box[bo + 5] = -Infinity;
    for (let b = 0; b < blocks; b++) {
      const k = (a * blocks + b) * 6;
      blk[k] = blk[k + 1] = blk[k + 2] = Infinity; blk[k + 3] = blk[k + 4] = blk[k + 5] = -Infinity;
    }
    for (let i = 0; i < S; i++) {
      const o = (a * S + i) * 6, r = Math.max(R[i], R[i + 1]) + pad, kb = (a * blocks + ((i / BLOCK) | 0)) * 6;
      for (let c = 0; c < 3; c++) {
        const p = X[i * 3 + c], q = X[i * 3 + 3 + c];
        const lo = (p < q ? p : q) - r, hi = (p > q ? p : q) + r;
        seg[o + c] = lo; seg[o + 3 + c] = hi;
        if (lo < blk[kb + c]) blk[kb + c] = lo;
        if (hi > blk[kb + 3 + c]) blk[kb + 3 + c] = hi;
        if (lo < box[bo + c]) box[bo + c] = lo;
        if (hi > box[bo + 3 + c]) box[bo + 3 + c] = hi;
      }
    }
  }
}

function overlaps(A, a, B, b) {
  return A[a] <= B[b + 3] && B[b] <= A[a + 3] && A[a + 1] <= B[b + 4] && B[b + 1] <= A[a + 4] && A[a + 2] <= B[b + 5] && B[b + 2] <= A[a + 5];
}

/* Touching segments are pushed apart along their closest points, so they slide; a pair that swapped sides since last
   tick goes back to its old side. mode 0 resolves, 1 also records sides, 2 only measures; returns the worst overlap. */
export function separateArms(arms, knobs, st, mode = 1) {
  const { S, NS, blocks, seg, blk, box, side, stamp } = st;
  const pin = knobs.pin, skip = knobs.selfSkip, margin = knobs.contactMargin, tick = st.tick, o = st._st;
  boundSegments(arms, st, margin / 2);
  if (mode === 1) st.touch.fill(0);
  let worst = 0;
  for (let a = 0; a < arms.length; a++) {
    const A = arms[a], X = A.X, RA = A.rad;
    for (let b = a; b < arms.length; b++) {
      if (!overlaps(box, a * 6, box, b * 6)) continue;
      const B = arms[b], Y = B.X, RB = B.rad;
      for (let ba = 0; ba < blocks; ba++) {
        for (let bb = a === b ? ba : 0; bb < blocks; bb++) {
          if (!overlaps(blk, (a * blocks + ba) * 6, blk, (b * blocks + bb) * 6)) continue;
          const i1 = Math.min(S, (ba + 1) * BLOCK), j1 = Math.min(S, (bb + 1) * BLOCK);
          for (let i = ba * BLOCK; i < i1; i++) {
            for (let j = bb * BLOCK; j < j1; j++) {
              if (a === b && j <= i + skip) continue;
              if (i < pin && j < pin) continue;
              if (!overlaps(seg, (a * S + i) * 6, seg, (b * S + j) * 6)) continue;
              const p = i * 3, q = j * 3;
              const d2 = segSegClosest(X[p], X[p + 1], X[p + 2], X[p + 3], X[p + 4], X[p + 5], Y[q], Y[q + 1], Y[q + 2], Y[q + 3], Y[q + 4], Y[q + 5], o);
              const s = o[0], t = o[1];
              const min = RA[i] * (1 - s) + RA[i + 1] * s + RB[j] * (1 - t) + RB[j + 1] * t;
              const d = Math.sqrt(d2);
              const near = d < min + margin;
              if (!near) continue;
              if (mode === 1 && d < min + st.touchGap && d > 1e-9) armTouch(st, A, a * S + i, i, X, p, B, b * S + j, j, Y, q, s, t, d);
              // The side B lies on across both segments' common normal: it flips only if one passed through the other.
              const ax = X[p + 3] - X[p], ay = X[p + 4] - X[p + 1], az = X[p + 5] - X[p + 2];
              const bx = Y[q + 3] - Y[q], by = Y[q + 4] - Y[q + 1], bz = Y[q + 5] - Y[q + 2];
              let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
              const cl = len3(cx, cy, cz), crossOk = cl > 0.05 * len3(ax, ay, az) * len3(bx, by, bz);
              if (crossOk) { cx /= cl; cy /= cl; cz /= cl; }
              const sd = crossOk ? (Y[q] - X[p]) * cx + (Y[q + 1] - X[p + 1]) * cy + (Y[q + 2] - X[p + 2]) * cz : 0;
              // Only an X, closest points inside both segments, has a side: two arms lying side by side flip the
              // normal just by turning through parallel, and a tip slipping past the other's line goes around it.
              const inside = s > 0.02 && s < 0.98 && t > 0.02 && t < 0.98;
              const sign = inside ? (sd > 0 ? 1 : sd < 0 ? -1 : 0) : 0;
              const gid = (a * S + i) * NS + (b * S + j);
              const was = stamp[gid] === tick - 1 ? side[gid] : 0;
              const crossed = mode !== 2 && was !== 0 && sign !== 0 && sign !== was;
              let nx, ny, nz, dist;
              const vx = Y[q] + bx * t - X[p] - ax * s, vy = Y[q + 1] + by * t - X[p + 1] - ay * s, vz = Y[q + 2] + bz * t - X[p + 2] - az * s;
              if (crossed) { nx = was * cx; ny = was * cy; nz = was * cz; dist = vx * nx + vy * ny + vz * nz; st.crossings++; }
              else if (d < min) {
                if (d > 1e-9) { nx = vx / d; ny = vy / d; nz = vz / d; }
                else if (crossOk) { nx = cx; ny = cy; nz = cz; }
                else { nx = 0; ny = 1; nz = 0; }
                dist = d;
              }
              if (mode === 1) { side[gid] = crossed ? was : sign; stamp[gid] = tick; }
              if (nx === undefined) continue;
              const over = min - dist;
              if (over > worst) worst = over;
              if (mode === 2) continue;
              const wa0 = i < pin ? 0 : 1, wa1 = i + 1 < pin ? 0 : 1, wb0 = j < pin ? 0 : 1, wb1 = j + 1 < pin ? 0 : 1;
              const ga0 = 1 - s, ga1 = s, gb0 = 1 - t, gb1 = t;
              const den = wa0 * ga0 * ga0 + wa1 * ga1 * ga1 + wb0 * gb0 * gb0 + wb1 * gb1 * gb1;
              // A contact sitting almost on a pinned end would need an enormous push on the free one.
              if (den < 0.05) continue;
              // No point moves farther than the overlap itself, or a push near one end could throw it through a wall.
              const lam = Math.min(over / den, over / Math.max(wa0 * ga0, wa1 * ga1, wb0 * gb0, wb1 * gb1));
              X[p] -= nx * lam * wa0 * ga0; X[p + 1] -= ny * lam * wa0 * ga0; X[p + 2] -= nz * lam * wa0 * ga0;
              X[p + 3] -= nx * lam * wa1 * ga1; X[p + 4] -= ny * lam * wa1 * ga1; X[p + 5] -= nz * lam * wa1 * ga1;
              Y[q] += nx * lam * wb0 * gb0; Y[q + 1] += ny * lam * wb0 * gb0; Y[q + 2] += nz * lam * wb0 * gb0;
              Y[q + 3] += nx * lam * wb1 * gb1; Y[q + 4] += ny * lam * wb1 * gb1; Y[q + 5] += nz * lam * wb1 * gb1;
              st.pushes++;
            }
          }
        }
      }
    }
  }
  return worst;
}

/* Flag either segment whose sucker side, squared off its solved direction, faces the other across their closest points. */
function armTouch(st, A, ga, i, X, p, B, gb, j, Y, q, s, t, d) {
  const ax = X[p + 3] - X[p], ay = X[p + 4] - X[p + 1], az = X[p + 5] - X[p + 2];
  const bx = Y[q + 3] - Y[q], by = Y[q + 4] - Y[q + 1], bz = Y[q + 5] - Y[q + 2];
  const nx = (Y[q] + bx * t - X[p] - ax * s) / d, ny = (Y[q + 1] + by * t - X[p + 1] - ay * s) / d, nz = (Y[q + 2] + bz * t - X[p + 2] - az * s) / d;
  if (facing(A.SK, i, ax, ay, az, nx, ny, nz) > st.faceCos) st.touch[ga] = 1;
  if (facing(B.SK, j, bx, by, bz, -nx, -ny, -nz) > st.faceCos) st.touch[gb] = 1;
}

/* Cosine between segment j's sucker side, with its component along the solved direction (dx, dy, dz) removed, and unit n. */
export function facing(SK, j, dx, dy, dz, nx, ny, nz) {
  let sx = SK[j * 3], sy = SK[j * 3 + 1], sz = SK[j * 3 + 2];
  const dl2 = dx * dx + dy * dy + dz * dz;
  if (dl2 > 1e-18) { const c = (sx * dx + sy * dy + sz * dz) / dl2; sx -= c * dx; sy -= c * dy; sz -= c * dz; }
  const sl = len3(sx, sy, sz);
  return sl > 1e-9 ? (sx * nx + sy * ny + sz * nz) / sl : -1;
}

function slerp3(a, b, t, out) {
  const c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const th = Math.acos(c);
  if (th < 1e-6) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return out; }
  let s = Math.sin(th);
  if (s < 1e-6) {
    // Opposite: turn through any perpendicular.
    const px = Math.abs(a[1]) < 0.9 ? -a[2] : 0, py = Math.abs(a[1]) < 0.9 ? 0 : a[2], pz = Math.abs(a[1]) < 0.9 ? a[0] : -a[1];
    const pl = len3(px, py, pz) || 1, ct = Math.cos(th * t), st = Math.sin(th * t);
    out[0] = a[0] * ct + px / pl * st; out[1] = a[1] * ct + py / pl * st; out[2] = a[2] * ct + pz / pl * st;
    return out;
  }
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  out[0] = a[0] * wa + b[0] * wb; out[1] = a[1] * wa + b[1] * wb; out[2] = a[2] * wa + b[2] * wb;
  return normalize3(out, b[0], b[1], b[2]);
}

function unitBetween(X, i, j, out) {
  out[0] = X[j * 3] - X[i * 3]; out[1] = X[j * 3 + 1] - X[i * 3 + 1]; out[2] = X[j * 3 + 2] - X[i * 3 + 2];
  return normalize3(out);
}

/* The contact pieces an arm's chain and a rod arm's body chain share, over a chain state c: knobs, X, rad, frame, and the
   scratch and flags below. None of them re-seats a length or clamps a bend, so a rod's own dynamics keep those. */

/* Tell a world that can narrow its search (focus) which part of it chain c can touch: its points X, grown by pad. */
export function focusChain(c, world, pad) {
  if (!world?.focus) return;
  const X = c.X, lo = c._lo ??= [0, 0, 0], hi = c._hi ??= [0, 0, 0], F = c.frame.p;
  for (let a = 0; a < 3; a++) { lo[a] = F[a]; hi[a] = F[a]; }
  for (let i = 0; i < X.length; i += 3) {
    for (let a = 0; a < 3; a++) { const v = X[i + a]; if (v < lo[a]) lo[a] = v; else if (v > hi[a]) hi[a] = v; }
  }
  if (!Number.isFinite(lo[0] + lo[1] + lo[2] + hi[0] + hi[1] + hi[2])) { world.unfocus(); return; }
  for (let a = 0; a < 3; a++) { lo[a] -= pad; hi[a] += pad; }
  world.focus(lo, hi);
}

function markTouched(c, i) { if (i < c._hit) c._hit = i; if (c._touched) c._touched[i] = 1; }

/* A loose thing (a toy) that moved into the point pushes it out no more than one check's step at a time: the arm
   yields over a few ticks, pushing the toy away meanwhile, instead of being thrown off it at once. */
function yieldPen(c, i, pen, world) { return pen > 0 && world.loose ? Math.min(pen, c.rad[i] * c.knobs.sweepStep) : pen; }

/* Deepest penetration of point i's sphere at (x, y, z) into the world or her body, its outward normal into out. */
function penAt(c, i, x, y, z, world, body, out) {
  let best = 0;
  if (world) { const p = yieldPen(c, i, world.collide(x, y, z, c.rad[i], out, i), world); if (p > 0) best = p; }
  if (body && i > 0) {
    const nb = c._nb ??= [0, 0, 0], p = body.collide(x, y, z, bodyRadius(c.rad[i], i, c.knobs.bodySkip), nb);
    if (p > best) { best = p; out[0] = nb[0]; out[1] = nb[1]; out[2] = nb[2]; }
  }
  return best;
}

/* Point i's sphere at (x, y, z) pushed out of every solid it is in, a few rounds for a corner, into q; whether it moved. */
function outOf(c, i, x, y, z, world, body, q) {
  const n = c._n;
  let moved = false;
  for (let round = 0; round < 3; round++) {
    const pen = penAt(c, i, x, y, z, world, body, n);
    if (!(pen > 0)) break;
    x += n[0] * pen; y += n[1] * pen; z += n[2] * pen; moved = true;
  }
  q[0] = x; q[1] = y; q[2] = z;
  return moved;
}

/* Push point i of chain c out of the world and her body; returns whether it moved, with the summed push direction in _push3. */
export function projectPoint(c, i, world, body) {
  const X = c.X, r = c.rad[i], nrm = c._n, acc = c._push3 ??= [0, 0, 0];
  acc[0] = 0; acc[1] = 0; acc[2] = 0;
  let any = false;
  for (let round = 0; round < 3; round++) {
    let moved = false;
    if (world) {
      const pen = yieldPen(c, i, world.collide(X[i * 3], X[i * 3 + 1], X[i * 3 + 2], r, nrm, i), world);
      if (pen > 0) {
        X[i * 3] += nrm[0] * pen; X[i * 3 + 1] += nrm[1] * pen; X[i * 3 + 2] += nrm[2] * pen;
        acc[0] += nrm[0]; acc[1] += nrm[1]; acc[2] += nrm[2]; moved = true;
      }
    }
    if (body && i > 0) {
      const pen = body.collide(X[i * 3], X[i * 3 + 1], X[i * 3 + 2], bodyRadius(r, i, c.knobs.bodySkip), nrm);
      if (pen > 0) { X[i * 3] += nrm[0] * pen; X[i * 3 + 1] += nrm[1] * pen; X[i * 3 + 2] += nrm[2] * pen; acc[0] += nrm[0]; acc[1] += nrm[1]; acc[2] += nrm[2]; moved = true; }
    }
    if (!moved) break;
    any = true;
  }
  if (any) markTouched(c, i);
  return any;
}

/* Carry point i of chain c from (x, y, z) toward the place now in X, never into a solid: sampled at sweepStep of its
   radius, stopped at the first penetration, then slid along that surface with what is left of the move. */
export function travelPoint(c, i, world, body, x, y, z) {
  const k = c.knobs, X = c.X, o = i * 3, n = c._n, r = c.rad[i], q = c._q3 ??= [0, 0, 0];
  const tx = X[o], ty = X[o + 1], tz = X[o + 2];
  // A start something moved into (her body, a toy) is met by the first check along the way, as shallow as its move.
  let mx = tx - x, my = ty - y, mz = tz - z, hit = false, pen = 0;
  const step = Math.max(1e-3, r * k.sweepStep);
  for (let leg = 0; leg < k.sweepLegs; leg++) {
    const m = len3(mx, my, mz);
    let cnt = Math.max(1, Math.ceil(m / step));
    // A move longer than sweepMax checks goes only as far as it was checked; the rest is next tick's.
    if (cnt > k.sweepMax) { const f = k.sweepMax * step / m; mx *= f; my *= f; mz *= f; cnt = k.sweepMax; c._short = true; }
    let stopped = false;
    for (let s = 1; s <= cnt; s++) {
      const f = s / cnt, sx = x + mx * f, sy = y + my * f, sz = z + mz * f;
      pen = penAt(c, i, sx, sy, sz, world, body, n);
      if (!(pen > 0)) continue;
      // Out on the side it came in, then the rest of the move loses its part into the surface.
      x = sx + n[0] * pen; y = sy + n[1] * pen; z = sz + n[2] * pen;
      if (outOf(c, i, x, y, z, world, body, q)) { x = q[0]; y = q[1]; z = q[2]; }
      const rx = mx * (1 - f), ry = my * (1 - f), rz = mz * (1 - f), into = rx * n[0] + ry * n[1] + rz * n[2];
      mx = rx; my = ry; mz = rz;
      if (into < 0) { mx -= into * n[0]; my -= into * n[1]; mz -= into * n[2]; }
      stopped = true; hit = true;
      break;
    }
    if (!stopped) { x += mx; y += my; z += mz; mx = my = mz = 0; break; }
  }
  X[o] = x; X[o + 1] = y; X[o + 2] = z;
  if (hit) markTouched(c, i);
  return hit;
}

/* One arm. Programs set a bend per joint (in the arm's own transported frame), a stretch and a twist per segment;
   springs relax them, the chain is integrated out from the root frame, then made to touch, not clip. */
export class Arm {
  constructor(index, knobs, seed = 1) {
    const k = this.knobs = knobs;
    this.index = index;
    const n = this.n = k.points, S = n - 1;
    this.len0 = new Float64Array(S);        // rest segment lengths
    this.rad0 = new Float64Array(n);        // rest radii
    this.arc0 = new Float64Array(n);        // rest arc length at each point
    this.len = new Float64Array(S);         // live, after stretch
    this.rad = new Float64Array(n);         // live: a segment thins as it lengthens, keeping its volume
    this.lam = new Float64Array(S).fill(1); // stretch per segment
    this.lamGoal = new Float64Array(S).fill(1);
    this.lamMax = new Float64Array(S);
    this.twist = new Float64Array(S);       // rad, the frame's roll after each segment
    this.twistV = new Float64Array(S);
    this.twistIdle = new Float64Array(S);
    this.twistAim = new Float64Array(S);    // what a reach adds to turn its suckers onto what it reaches for
    this.limBase = new Float64Array(n);     // bend limit of the joint at each point from the knobs; [0] is the root turn
    this.limRaise = new Float64Array(n);    // a fetch's pseudo-joints fold past it
    this.lim = new Float64Array(n);         // the limit in force this tick
    this.limCos = new Float64Array(n);
    this.limSin = new Float64Array(n);
    this.bend = new Float64Array(S * 2);
    this.vel = new Float64Array(S * 2);
    this.idleT = new Float64Array(S * 2);
    this.goalT = new Float64Array(S * 2);
    this.tgt = new Float64Array(S * 2);
    this.rest = new Float64Array(S * 2);    // where contact left the bends, added to every program's targets and relaxing
    this.stiffGoal = new Float64Array(S);
    this.dragGoal = new Float64Array(S);    // per segment: how much of it trails behind its pose
    this.drag = new Float64Array(S);
    this.actBump = new Float64Array(S);     // in muscle mode, a reach's bend as the sucker side's activation per segment
    this.actIdle = new Float64Array(S);     // and a resting curl's
    this.act = null;                        // in muscle mode, the activations (muscle-core.js) and what they make
    this.mus = null;
    this.gripB = new Float64Array(S * 2);
    this.out = new Float64Array(S * 2);
    this.D = new Float64Array(S * 3);       // posed segment directions
    this.Dp = new Float64Array(S * 3);      // last tick's posed segment directions
    this.Q = new Float64Array(n * 3);       // the chain as it last lay clear of every solid, where a finishing pass slides from
    this.SKp = new Float64Array(S * 3);     // posed sucker side per segment
    this.SK = new Float64Array(S * 3);      // the sucker side of the solved chain: SKp carried onto each solved segment
    this.X = new Float64Array(n * 3);       // the solved chain the capsules follow
    this.P = new Float64Array(n * 3);       // last tick's solved chain
    this.G = new Float64Array(n * 3);       // scratch chain for FABRIK and fetch
    this.frame = { p: [0, 0, 0], d: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], cu: 0, cv: 1 };
    this.rng = mulberry32((seed * 2654435761) ^ ((index + 1) * 0x9E3779B9));
    this.phase = Float64Array.from({ length: 6 }, () => this.rng() * Math.PI * 2);
    this.time = 0;
    this.goal = null;         // { kind: 'reach' | 'hold' | 'fetch' | 'lead', target, t, ... }
    this.w = 0;               // goal weight against idle, blended in bend space
    this.gw = 0;              // FABRIK grip weight
    this.gripAt = n - 1;      // the point FABRIK places on the target
    this.reachB = 0;          // where the traveling bend is, 0 at the root to 1 at the tip, by rest arc
    this.contact = 0.5;       // the last reach's contact point, as a fraction of the rest length
    this.resting = false;
    this.restW = 0;
    this.awake = [0, 0];      // the awake idle bend's direction in the root frame, smoothed
    this.awakePick = [1, 0];
    this.wander = [0, 0, 0];
    this.wanderPick = [0, 0, 0];
    this.wanderAt = 0;
    // World push off the other arms' bodies near this one (arm-crowd.js, |push| ≤ 1), the idle program's smoothed lean on it,
    // and whether a reach may steer too (not over a driving rod, whose grip point any bend can move).
    this.crowd = { push: [0, 0, 0], lean: [0, 0, 0], reach: true };
    this.started = false;
    this._dt = 0;
    this._t = [0, 0, 0]; this._n = [0, 0, 0];
    this._f = { d: [0, 0, 0], u: [0, 0, 0], v: [0, 0, 0] };
    this._a = [0, 0, 0]; this._b = [0, 0, 0]; this._c = [0, 0, 0];
    this._syncRest(true);
    this._syncLimits();
    this._syncLive();
  }

  get length() { return this._length; }

  /* Rest geometry follows the knobs live; a change rebuilds it in place. */
  _syncRest(force = false) {
    const k = this.knobs, front = Array.isArray(k.frontArms) && k.frontArms.includes(this.index);
    const L = k.length * (front ? k.frontScale : 1);
    if (!force && L === this._length && k.tipLenRatio === this._sr && k.rootRadius === this._srr && k.tipRadius === this._str && k.taperPow === this._stp) return false;
    this._length = L; this._sr = k.tipLenRatio; this._srr = k.rootRadius; this._str = k.tipRadius; this._stp = k.taperPow;
    restArm(this.n, L, k.tipLenRatio, k.rootRadius, k.tipRadius, k.taperPow, this.len0, this.rad0, this.arc0);
    this.restGen = (this.restGen ?? 0) + 1;
    return true;
  }

  _syncLimits() {
    const k = this.knobs, n = this.n, S = n - 1, B = this.limBase, R = this.limRaise, w = this.w;
    const raised = this._raised || (this.goal?.kind === 'fetch');
    if (!raised && k.bendBase === this._lb && k.bendTip === this._lt && k.bendPow === this._lp && k.rootBendMax === this._lr) return;
    this._lb = k.bendBase; this._lt = k.bendTip; this._lp = k.bendPow; this._lr = k.rootBendMax;
    B[0] = k.rootBendMax;
    for (let j = 1; j < n; j++) B[j] = k.bendBase + (k.bendTip - k.bendBase) * Math.pow(Math.min(1, j / Math.max(1, S - 1)), k.bendPow);
    // The raise fades with the program's weight, so letting go of a fetch never snaps a fold to the plain limit.
    let any = false;
    for (let j = 0; j < n; j++) {
      const l = Math.min(Math.PI, Math.max(B[j], R[j] * w));
      if (R[j] * w > B[j]) any = true;
      this.lim[j] = l; this.limCos[j] = Math.cos(l); this.limSin[j] = Math.sin(l);
    }
    this._raised = any;
    if (!any && this.goal?.kind !== 'fetch') R.fill(0);
  }

  _syncLive() {
    const S = this.n - 1, k = this.knobs;
    for (let j = 0; j < S; j++) {
      this.len[j] = this.len0[j] * this.lam[j];
      this.lamMax[j] = 1 + (k.stretchMax - 1) * Math.max(0, 1 - (this.arc0[j] + this.len0[j] / 2) / this._length);
    }
    for (let i = 0; i < this.n; i++) {
      const a = i > 0 ? this.lam[i - 1] : this.lam[0], b = i < S ? this.lam[i] : this.lam[S - 1];
      this.rad[i] = this.rad0[i] / Math.sqrt(Math.max(0.1, (a + b) / 2));
    }
  }

  /* The bend limit of the joint at point j (j = 0 is the turn off her body). */
  bendLimit(j) { return this.lim[j]; }

  /* Root position p, outward direction n, ring tangent t, and the sucker side o (all world, n and t unit). */
  setFrame(p, n, t, o) {
    const F = this.frame;
    // A frame from a body gone non-finite would poison the chain; the arm holds its last pose until it recovers.
    this.valid = finite3(p) && finite3(n) && finite3(t) && finite3(o);
    if (!this.valid) return;
    F.p[0] = p[0]; F.p[1] = p[1]; F.p[2] = p[2];
    F.d[0] = n[0]; F.d[1] = n[1]; F.d[2] = n[2];
    normalize3(F.d);
    const dt = t[0] * F.d[0] + t[1] * F.d[1] + t[2] * F.d[2];
    F.u[0] = t[0] - dt * F.d[0]; F.u[1] = t[1] - dt * F.d[1]; F.u[2] = t[2] - dt * F.d[2];
    if (len3(F.u[0], F.u[1], F.u[2]) < 1e-6) {
      // t parallel to n: any perpendicular keeps the frame valid.
      const ax = Math.abs(F.d[1]) < 0.9 ? 0 : 1, ay = 1 - ax;
      const c = ax * F.d[0] + ay * F.d[1];
      F.u[0] = ax - c * F.d[0]; F.u[1] = ay - c * F.d[1]; F.u[2] = -c * F.d[2];
    }
    normalize3(F.u, 1, 0, 0);
    F.v[0] = F.d[1] * F.u[2] - F.d[2] * F.u[1];
    F.v[1] = F.d[2] * F.u[0] - F.d[0] * F.u[2];
    F.v[2] = F.d[0] * F.u[1] - F.d[1] * F.u[0];
    let cu = o[0] * F.u[0] + o[1] * F.u[1] + o[2] * F.u[2], cv = o[0] * F.v[0] + o[1] * F.v[1] + o[2] * F.v[2];
    const cl = len2(cu, cv);
    if (cl < 1e-6) { cu = 0; cv = 1; } else { cu /= cl; cv /= cl; }
    F.cu = cu; F.cv = cv;
  }

  idle() {
    if (this.goal && this.goal.kind !== 'lead') this._letGo(true);
  }

  /* A program letting go. With `stay`, exploring carries on around where the arm ended up for a wander interval,
     so a reached-for spot keeps her interest (and her heading) instead of the arm swinging back to an old pick. */
  _letGo(stay) {
    this._lastKind = this.goal?.kind;
    this.goal = null;
    const k = this.knobs, X = this.X, i = Math.min(this.n - 1, Math.round(k.wanderReach * (this.n - 1)));
    if (stay && Number.isFinite(X[i * 3] + X[i * 3 + 1] + X[i * 3 + 2])) {
      for (let a = 0; a < 3; a++) this.wander[a] = this.wanderPick[a] = X[i * 3 + a];
      this.wanderAt = this.time + k.wanderMin;
    } else this.wanderAt = this.time;
  }

  /* Send the bend out to a target. The middle of the arm arrives on it unless `tip` asks for a tip grip (rims,
     handles, small things); `speed` is the bend's peak in m/s, and the duration follows from the distance. `face` is
     a world point (a toy's center) the suckers turn toward where the arm meets it. */
  reach(target, { duration, amplitude, hold, speed, tip = false, face = null, contactArc = null } = {}) {
    if (!finite3(target)) return false;
    const k = this.knobs, F = this.frame;
    // A NaN option would poison the bend springs for good, so each falls back to its knob.
    const rise = Math.max(0.5, k.reachRise + (this.rng() * 2 - 1) * k.reachRiseJitter);
    const v = Math.min(k.bendSpeedMax, Math.max(0.01, orKnob(speed, k.reachSpeed)));
    const D = len3(target[0] - F.p[0], target[1] - F.p[1], target[2] - F.p[2]);
    const T = Math.max(reachTime(D, v, rise, k.reachMinDuration), orKnob(duration, 0));
    this.goal = {
      kind: 'reach', target: [target[0], target[1], target[2]], t: 0, ht: 0, duration: T, rise, tip: !!tip,
      amplitude: orKnob(amplitude, k.reachAmplitude), hold: orKnob(hold, k.holdTime), cArc: 0, e: 0,
      face: finite3(face) ? [face[0], face[1], face[2]] : null,
      // A contact pinned at this fraction of the arm (a foot near the body) instead of the middle third.
      cFix: Number.isFinite(contactArc) ? Math.max(0.05, Math.min(1, contactArc)) * this._length : null,
    };
    this.reachB = 0;
    return true;
  }

  /* Hold segment seg still at surface point p (outward normal n) while the root moves: arm-plant-core.js. */
  plant(p, n, seg) {
    const g = makePlant(this, p, n, seg);
    if (!g) return false;
    this.goal = g;
    this.reachB = 0;
    return true;
  }

  /* Flinch off a noxious touch { seg, severity, normal } (arm-plant-core.js), replacing whatever goal the arm had. As in
     still(), the springs start from the chain as it lies, so a grip's blend dropped at once never pops the pose. */
  recoil(touch, opts) {
    const g = makeRecoil(this, touch, opts);
    if (!g) return false;
    this.goal = g;
    this.bend.set(g.from); this.vel.fill(0); this.twistV.fill(0);
    this.w = 1; this.gw = 0;
    // Outlives the goal, so the recoil's fade keeps the muscle-map choice it was made with.
    this._recoilMap = g.muscle === 'map';
    return g;
  }

  /* Bring what the arm grasped at `grasp` (fraction of its length; default where the last reach touched) to the
     mouth. Only ever started from outside: an arm never decides to fetch on its own. */
  fetch(mouth, { hold, grasp, duration } = {}) {
    if (!finite3(mouth)) return false;
    const k = this.knobs;
    const g = Math.max(0.15, Math.min(1, orKnob(grasp, this.goal?.kind === 'hold' ? this.contact : k.fetchGrasp)));
    this.goal = {
      kind: 'fetch', target: [mouth[0], mouth[1], mouth[2]], t: 0, grasp: g, duration: Math.max(0.2, orKnob(duration, k.fetchDuration)),
      hold: orKnob(hold, k.fetchHold), d0: null, lam0: Float64Array.from(this.lam), J: new Float64Array(9),
    };
    return true;
  }

  setLead(p) {
    if (p && finite3(p)) {
      if (this.goal?.kind !== 'lead') this.goal = { kind: 'lead', target: [0, 0, 0], t: 0 };
      this.goal.target[0] = p[0]; this.goal.target[1] = p[1]; this.goal.target[2] = p[2];
    } else if (this.goal?.kind === 'lead') this._letGo(true);
  }

  /* Hold the pose the arm has now, at idle stiffness: the chain's bends, stretch, and twist become the targets at full weight,
     the springs stop where they are, and what contact left in the bends is frozen, so only what touches the arm moves it. */
  still() {
    const S = this.n - 1, B = this.bend, Rb = this.rest, bend = new Float64Array(S * 2);
    // The chain as it lies, not the pose: a grip's blend or a dragged segment's lag would otherwise keep closing on it.
    if (this.started && Number.isFinite(this.X[this.n * 3 - 1])) { this.bendsFromPoints(this.X, B); this._clampBends(B, null); } else B.set(this.out);
    for (let a = 0; a < S * 2; a++) bend[a] = B[a] - Rb[a];
    this.goal = { kind: 'still', t: 0, bend, lam: Float64Array.from(this.lam), twist: Float64Array.from(this.twist) };
    this.vel.fill(0); this.twistV.fill(0);
    this.w = 1; this.gw = 0;
    return true;
  }

  get busy() { return !!this.goal; }

  /* A touch that's done: a reach or hold lets go and the arm looks elsewhere; an exploring arm picks a new spot now. */
  moveOn() {
    if (this.goal && this.goal.kind !== 'lead') this._letGo(false);
    else this.wanderAt = this.time;
  }

  /* Bends that turn the base from the root's outward direction toward world direction w, added into out. */
  _aim(wx, wy, wz, weight, out) {
    const k = this.knobs, F = this.frame, S = this.n - 1;
    const c = Math.max(-1, Math.min(1, wx * F.d[0] + wy * F.d[1] + wz * F.d[2]));
    let ex = wx - c * F.d[0], ey = wy - c * F.d[1], ez = wz - c * F.d[2];
    const el = len3(ex, ey, ez);
    if (el < 1e-9) return;
    ex /= el; ey /= el; ez /= el;
    const eu = ex * F.u[0] + ey * F.u[1] + ez * F.u[2], ev = ex * F.v[0] + ey * F.v[1] + ez * F.v[2];
    let theta = Math.acos(c) * weight;
    const at0 = Math.min(theta, k.rootBendMax * 0.8);
    out[0] += eu * at0; out[1] += ev * at0;
    theta -= at0;
    for (let j = 1; j < S && theta > 1e-6; j++) {
      const a = Math.min(theta, this.lim[j] * k.aimShare);
      out[j * 2] += eu * a; out[j * 2 + 1] += ev * a;
      theta -= a;
    }
  }

  /* A bend of magnitude c toward direction (du, dv) in the root frame, at joint j. */
  _push(j, out, du, dv, c) { out[j * 2] += du * c; out[j * 2 + 1] += dv * c; }

  _curl(j, out, scale) {
    const k = this.knobs, F = this.frame, s = j / (this.n - 2);
    this._push(j, out, F.cu, F.cv, (k.curlBase + k.curlTip * Math.pow(s, k.curlPow)) * scale);
  }

  /* Awake bends pick a direction around the arm, the sucker side least often (oralShare of picks). */
  _pickAwake() {
    const k = this.knobs, F = this.frame, r = this.rng();
    const center = r < k.oralShare ? 0 : Math.PI / 2 * (1 + Math.floor(this.rng() * 3));
    const phi = center + (this.rng() - 0.5) * Math.PI / 2;
    const c = Math.cos(phi), s = Math.sin(phi);
    this.awakePick[0] = F.cu * c - F.cv * s; this.awakePick[1] = F.cu * s + F.cv * c;
  }

  _idleTargets(dt, world) {
    const k = this.knobs, F = this.frame, S = this.n - 1, T = this.idleT, t = this.time, ph = this.phase;
    const rw = this.restW, noise = k.noiseAmp * (1 - rw * (1 - k.restNoise));
    const f = 1 - Math.exp(-dt / Math.max(1e-3, k.wanderTau));
    const A = this.awake, Ap = this.awakePick;
    if (!this.started) { this._pickAwake(); A[0] = Ap[0]; A[1] = Ap[1]; }
    A[0] += (Ap[0] - A[0]) * f; A[1] += (Ap[1] - A[1]) * f;
    // The lean off a crowded side (arm-crowd.js), across the arm in the root frame and never toward the suckers (from her crown,
    // down and in under her, where nothing has room); it fades under a program. A pick into it mirrors to the open side.
    let lu = 0, lv = 0, mirror = 0;
    if (k.crowd) {
      const p = this.crowd.push, L = this.crowd.lean, on = this.goal ? 0 : 1, fc = this.started ? 1 - Math.exp(-dt / Math.max(1e-3, k.crowdTau)) : 1;
      for (let i = 0; i < 3; i++) L[i] += (p[i] * on - L[i]) * fc;
      if (!Number.isFinite(L[0] + L[1] + L[2])) L[0] = L[1] = L[2] = 0;
      lu = L[0] * F.u[0] + L[1] * F.u[1] + L[2] * F.u[2]; lv = L[0] * F.v[0] + L[1] * F.v[1] + L[2] * F.v[2];
      const so = lu * F.cu + lv * F.cv;
      if (so > 0) { lu -= so * F.cu; lv -= so * F.cv; }
      const ll = len2(lu, lv);
      if (ll > 1e-9 && !this.goal) mirror = 2 * Math.min(1, ll * k.crowdWander) / (ll * ll);
      // The awake pick, every tick: the bend follows it at its own pace, so a curl into a neighbor swings off it, never whips.
      const q = mirror * Math.min(0, Ap[0] * lu + Ap[1] * lv);
      Ap[0] -= q * lu; Ap[1] -= q * lv;
    }
    T.fill(0);
    for (let j = 0; j < S; j++) {
      const s = j / (S - 1);
      // In muscle mode the resting curl is the sucker side contracting, so the girth shapes it; the root turn stays authored.
      if (k.muscle) this.actIdle[j] = rw * k.curlAct * Math.pow((this.arc0[j] + this.len0[j] / 2) / this._length, k.curlActPow);
      if (!k.muscle || j === 0) this._curl(j, T, rw);
      this._push(j, T, A[0], A[1], (k.awakeBase + k.awakeTip * Math.pow(s, k.curlPow)) * (1 - rw));
      const w = s * k.noiseWave;
      const amp = noise * (0.4 + s);
      T[j * 2] += amp * (Math.sin(2 * Math.PI * k.noiseHz * t + ph[0] - w) + 0.6 * Math.sin(2 * Math.PI * k.noiseHz2 * t + ph[1] - 1.7 * w));
      T[j * 2 + 1] += amp * (Math.sin(2 * Math.PI * k.noiseHz * 1.13 * t + ph[2] - w) + 0.6 * Math.sin(2 * Math.PI * k.noiseHz2 * 0.87 * t + ph[3] - 1.3 * w));
      // Twist lives in the middle and far end of the arm, never at the base.
      this.twistIdle[j] = k.twistAmp * smoothstep(0.2, 0.5, s) * Math.sin(2 * Math.PI * k.noiseHz * 0.7 * t + ph[4] - 0.8 * w) * (1 - rw * (1 - k.restNoise));
    }
    // The exploration target: a fresh pick every few seconds, pulled onto a nearby surface, followed smoothly.
    if (this.time >= this.wanderAt || !this.started) {
      this.wanderAt = this.time + k.wanderMin + this.rng() * (k.wanderMax - k.wanderMin);
      const cone = Math.min(1.4, k.wanderCone);
      const spin = this.rng() * 2 * Math.PI, off = Math.tan(cone * Math.sqrt(this.rng()));
      let a = off * Math.cos(spin), b = off * Math.sin(spin);
      if (mirror > 0) { const q = mirror * Math.min(0, a * lu + b * lv); a -= q * lu; b -= q * lv; }
      const dir = this._t;
      dir[0] = F.d[0] + a * F.u[0] + b * F.v[0];
      dir[1] = F.d[1] + a * F.u[1] + b * F.v[1];
      dir[2] = F.d[2] + a * F.u[2] + b * F.v[2];
      normalize3(dir, F.d[0], F.d[1], F.d[2]);
      const r = k.wanderReach * this._length;
      const P = this.wanderPick;
      P[0] = F.p[0] + dir[0] * r; P[1] = F.p[1] + dir[1] * r; P[2] = F.p[2] + dir[2] * r;
      if (world?.distance) {
        const g = this._n, d = world.distance(P[0], P[1], P[2], g);
        if (Number.isFinite(d) && d < k.wanderSnap) { P[0] -= g[0] * (d - k.wanderGap); P[1] -= g[1] * (d - k.wanderGap); P[2] -= g[2] * (d - k.wanderGap); }
      }
      if (!this.started) { this.wander[0] = P[0]; this.wander[1] = P[1]; this.wander[2] = P[2]; }
      if (this.started) this._pickAwake();
    }
    const W = this.wander, P = this.wanderPick;
    W[0] += (P[0] - W[0]) * f; W[1] += (P[1] - W[1]) * f; W[2] += (P[2] - W[2]) * f;
    const dir = this._t;
    dir[0] = W[0] - F.p[0]; dir[1] = W[1] - F.p[1]; dir[2] = W[2] - F.p[2];
    if (k.crowd) { const r = k.crowdAim * k.wanderReach * this._length; for (let i = 0; i < 3; i++) dir[i] += (lu * F.u[i] + lv * F.v[i]) * r; }
    const aim = k.idleAim * (1 - rw * (1 - k.restAim));
    if (len3(dir[0], dir[1], dir[2]) > 1e-6) { normalize3(dir); this._aim(dir[0], dir[1], dir[2], aim, T); }
  }

  /* The goal program's target bends, stiffness, lengths, and drag; returns the grip weight it wants. */
  _goalTargets(dt) {
    const k = this.knobs, S = this.n - 1, g = this.goal, T = this.goalT, K = this.stiffGoal;
    g.t += dt;
    T.fill(0); this.lamGoal.fill(1); this.dragGoal.fill(0); this.actBump.fill(0);
    if (g.kind === 'lead') {
      const dir = this._t, F = this.frame;
      dir[0] = g.target[0] - F.p[0]; dir[1] = g.target[1] - F.p[1]; dir[2] = g.target[2] - F.p[2];
      K.fill(k.stiffBehind * 0.3);
      if (len3(dir[0], dir[1], dir[2]) > 1e-6) { normalize3(dir); this._aim(dir[0], dir[1], dir[2], 1, T); }
      return 0;
    }
    if (g.kind === 'still') {
      T.set(g.bend); this.lamGoal.set(g.lam); this.twistAim.set(g.twist);
      K.fill(k.stiffIdle);
      return 0;
    }
    if (g.kind === 'fetch') return this._fetchTargets(T, K);
    if (g.kind === 'plant') return plantTargets(this, T, K, dt);
    if (g.kind === 'recoil') return recoilTargets(this, T, K);
    if (g.kind === 'trail' || g.kind === 'spread' || g.kind === 'tuck') return (g.kind === 'trail' ? trailTargets : g.kind === 'spread' ? spreadTargets : tuckTargets)(this, T, K);
    return this._reachTargets(T, K, dt);
  }

  /* Where along the arm the target lands and how much the base lengthens to put it there: the contact point stays in
     the middle third with the preferred stretch, slides off it only when lengthening can't make up the distance. */
  _solveContact(g, D) {
    const k = this.knobs, Lr = this._length, S = this.n - 1;
    const eAt = (c) => {
      let A = 0, Bw = 0, eMax = Infinity;
      for (let j = 0; j < S; j++) {
        const a = this.arc0[j];
        if (a >= c) break;
        const l = this.len0[j], fr = Math.min(1, (c - a) / l), mid = a + l / 2;
        if (mid >= c) { A += l * fr; continue; }
        const w = 1 - k.stretchFall * mid / c;
        A += l * fr; Bw += l * fr * w;
        eMax = Math.min(eMax, (this.lamMax[j] - 1) / w);
      }
      const eMin = k.stretchMin - 1;
      const e = Bw > 1e-9 ? Math.max(eMin, Math.min(eMax, (D - A) / Bw)) : 0;
      return { e, f: A + e * Bw - D };
    };
    if (g.cFix && !g.tip) { g.cArc = g.cFix; g.e = eAt(g.cFix).e; return; }
    let c = g.tip ? Lr : Math.max(k.contactMin, Math.min(k.contactMax, D / (Lr * Math.max(0.5, k.reachStretch)))) * Lr;
    let r = eAt(c);
    if (Math.abs(r.f) > 1e-4 && !g.tip) {
      // Bisect along the arm: farther out when even full lengthening falls short, closer in when it overshoots.
      let lo = r.f < 0 ? c : 0.1 * Lr, hi = r.f < 0 ? Lr : c;
      for (let it = 0; it < 18; it++) {
        const m = (lo + hi) / 2, rm = eAt(m);
        if (rm.f < 0) lo = m; else hi = m;
      }
      c = r.f < 0 ? hi : lo;
      r = eAt(c);
    }
    g.cArc = c; g.e = r.e;
  }

  _reachTargets(T, K, dt) {
    const k = this.knobs, F = this.frame, S = this.n - 1, g = this.goal, Lr = this._length;
    const dir = this._t;
    dir[0] = g.target[0] - F.p[0]; dir[1] = g.target[1] - F.p[1]; dir[2] = g.target[2] - F.p[2];
    const D = len3(dir[0], dir[1], dir[2]);
    if (D > 1e-6) normalize3(dir);
    const hold = g.kind === 'hold';
    if (hold) g.ht += dt;
    const u = hold ? 1 : Math.min(1, g.t / g.duration);
    const p = lateProfile(u, g.rise);
    this._solveContact(g, D);
    const cArc = g.cArc, e = g.e;
    this.contact = cArc / Lr;
    // The bend sits where the live arc behind it has covered p of the distance, so its speed is the profile's.
    let beta = 0, want = D * p;
    for (let j = 0; j < S; j++) {
      const a = this.arc0[j], l = this.len0[j], mid = a + l / 2;
      const ll = l * (1 + (mid < cArc ? e * p * (1 - k.stretchFall * mid / cArc) : 0));
      if (want <= ll || j === S - 1) { beta = a + l * Math.min(1, want / ll); break; }
      want -= ll;
    }
    beta = Math.min(beta, cArc);
    this.reachB = beta / Lr;
    for (let j = 0; j < S; j++) {
      const mid = this.arc0[j] + this.len0[j] / 2;
      if (mid < cArc) this.lamGoal[j] = 1 + e * p * (1 - k.stretchFall * mid / cArc);
    }
    const width = Math.max(0.02, k.reachWidth) * Lr;
    const amp = g.amplitude * (1 - smoothstep(0.85, 1, u));
    // The base stiffens over the reach's opening, so a retarget accelerates the arm instead of snapping it.
    const ramp = hold ? 1 : smoothstep(0, k.stiffenTime / g.duration, u);
    const aim = this.gripB;
    aim.fill(0);
    if (D > 1e-6) this._aim(dir[0], dir[1], dir[2], 1, aim);
    for (let j = 0; j < S; j++) {
      // m is 1 behind the bend (straight, aimed, stiff) and 0 past it, where the arm trails and straightens.
      const a = this.arc0[j];
      const m = j === 0 ? 1 : Math.max(0, Math.min(1, (beta - a) / width + 0.5));
      T[j * 2] = m * aim[j * 2]; T[j * 2 + 1] = m * aim[j * 2 + 1];
      // In muscle mode the bend is a contraction centered on the segments around β, so the girth sets its size; the
      // root turn, which no arm muscle makes, keeps the authored bend.
      if (k.muscle) { const z = (a + this.len0[j] / 2 - beta) / width; this.actBump[j] = k.reachAct * amp / Math.max(1e-6, k.reachAmplitude) * Math.exp(-z * z); }
      if (!k.muscle || j === 0) { const z = (a - beta) / width, bump = amp * Math.exp(-z * z); T[j * 2] += F.cu * bump; T[j * 2 + 1] += F.cv * bump; }
      K[j] = k.stiffDrag + (k.stiffBehind - k.stiffDrag) * m * ramp;
      const mn = Math.max(0, Math.min(1, (beta - this.arc0[j + 1]) / width + 0.5));
      this.dragGoal[j] = 1 - mn;
    }
    // FABRIK places the contact point: the point nearest the contact arc, the tip for a tip grip.
    let ci = this.n - 1;
    if (!g.tip) { ci = 2; for (let i = 2; i < this.n; i++) if (Math.abs(this.arc0[i] - cArc) < Math.abs(this.arc0[ci] - cArc)) ci = i; }
    this.gripAt = ci;
    // Past the contact point the trailing arm bends off a crowded side (never toward its suckers), in each joint's own frame
    // as last posed; no joint there poses the grip point or moves the bend. A pinned contact is locomotion's foot, left alone.
    if (k.crowd && this.crowd.reach && !g.tip && !g.cFix && this.started) {
      const q = this.crowd.push, Dp = this.D, Sp = this.SKp, c0 = this.arc0[ci];
      for (let j = ci + 1; j < S; j++) {
        const o = (j - 1) * 3, sx = Sp[o], sy = Sp[o + 1], sz = Sp[o + 2], dx = Dp[o], dy = Dp[o + 1], dz = Dp[o + 2];
        const ps = Math.min(0, q[0] * sx + q[1] * sy + q[2] * sz), pw = q[0] * (dy * sz - dz * sy) + q[1] * (dz * sx - dx * sz) + q[2] * (dx * sy - dy * sx);
        const c = k.crowdReach * smoothstep(0, width, this.arc0[j] - c0);
        T[j * 2] += (F.cu * ps - F.cv * pw) * c; T[j * 2 + 1] += (F.cv * ps + F.cu * pw) * c;
      }
    }
    if (g.face) this._aimSuckers(g.face, ci, dt);
    if (!hold && u >= 1) { g.kind = 'hold'; g.ht = 0; }
    if (hold && g.ht >= g.hold) this._letGo(true);
    return smoothstep(k.gripFrom, 1, u);
  }

  /* Turn the sucker side where the arm meets a thing toward its center f: the signed roll still missing at contact point
     ci, spread over the twist of the segments before it. */
  _aimSuckers(f, ci, dt) {
    const k = this.knobs, S = this.n - 1, X = this.X, D = this.D, SK = this.SK, Ta = this.twistAim;
    const sc = Math.max(1, Math.min(S - 1, ci - 1)), o = sc * 3;
    // The arm as it lies: the solved segment and the sucker side carried onto it.
    let dx = X[o + 3] - X[o], dy = X[o + 4] - X[o + 1], dz = X[o + 5] - X[o + 2];
    const dl = len3(dx, dy, dz);
    if (!(dl > 1e-9)) return;
    dx /= dl; dy /= dl; dz /= dl;
    let fx = f[0] - X[ci * 3], fy = f[1] - X[ci * 3 + 1], fz = f[2] - X[ci * 3 + 2];
    const fd = fx * dx + fy * dy + fz * dz;
    fx -= fd * dx; fy -= fd * dy; fz -= fd * dz;
    let sx = SK[o], sy = SK[o + 1], sz = SK[o + 2];
    const sd = sx * dx + sy * dy + sz * dz;
    sx -= sd * dx; sy -= sd * dy; sz -= sd * dz;
    if (!(len3(fx, fy, fz) > 1e-6 && len3(sx, sy, sz) > 1e-6) || !Number.isFinite(fx + sx)) return;
    // A positive twist turns every later segment's sucker side right-handed about the arm.
    const cx = sy * fz - sz * fy, cy = sz * fx - sx * fz, cz = sx * fy - sy * fx;
    const phi = Math.atan2(cx * dx + cy * dy + cz * dz, sx * fx + sy * fy + sz * fz);
    // Aiming may reach nearer the base than idle torsion does (Kennedy saw some proximal torsion, Bennice none), so
    // the roll is spread on a ramp from aimFrom, each segment's share capped and the rest passed to those with room.
    const Wt = this._aw ??= new Float64Array(S), A = this._ab ??= new Float64Array(S), tw = this.twist, cap = k.aimTwistMax;
    let left = phi;
    A.fill(0, 0, sc);
    for (let pass = 0; pass < 3 && Math.abs(left) > 1e-4; pass++) {
      let wsum = 0;
      for (let j = 0; j < sc; j++) {
        const room = left > 0 ? cap - tw[j] - A[j] : cap + tw[j] + A[j];
        Wt[j] = room > 1e-6 ? smoothstep(k.aimFrom, 0.35, j / (S - 1)) : 0;
        wsum += Wt[j];
      }
      if (!(wsum > 1e-6)) break;
      const share = left / wsum;
      left = 0;
      for (let j = 0; j < sc; j++) {
        if (!Wt[j]) continue;
        const want = A[j] + share * Wt[j], room = Math.max(-cap, Math.min(cap, tw[j] + want)) - tw[j];
        left += want - room; A[j] = room;
      }
    }
    // Aimed at the twist the arm has now plus what is missing, never at its own last aim, so the spring's lag can't wind it up.
    const f2 = Math.min(1, dt / Math.max(1e-3, k.aimTau));
    for (let j = 0; j < sc; j++) Ta[j] += (tw[j] + A[j] - Ta[j]) * f2;
    // Past the contact the twist has no say over it; a part aimed for an earlier contact lets its aim go.
    for (let j = sc; j < S; j++) Ta[j] -= Ta[j] * f2;
  }

  /* Point indices of the fetch's pseudo-joints and its grasp: the live arc from the base to the grasp in thirds. */
  fetchJoints(grasp = this.goal?.grasp ?? this.knobs.fetchGrasp) {
    const S = this.n - 1, out = this._fj ??= [0, 0, 0];
    let jg = 3;
    for (let i = 3; i < this.n; i++) if (Math.abs(this.arc0[i] - grasp * this._length) < Math.abs(this.arc0[jg] - grasp * this._length)) jg = i;
    let G = 0;
    for (let j = 0; j < jg; j++) G += this.len[j];
    let acc = 0, i1 = 0, i2 = 0;
    for (let j = 0; j < jg; j++) {
      acc += this.len[j];
      if (!i1 && acc >= G / 3 - 1e-9) i1 = j + 1;
      if (!i2 && acc >= 2 * G / 3 - 1e-9) i2 = j + 1;
    }
    out[0] = Math.max(1, Math.min(jg - 2, i1));
    out[1] = Math.max(out[0] + 1, Math.min(jg - 1, i2));
    out[2] = Math.min(S, jg);
    return out;
  }

  /* Fetch: base to grasp stiffens into three about-equal links and swings the grasp to the mouth. The middle joint
     does most of the turning, the base closes a little and opens again, the joint nearest the food turns late. */
  _fetchTargets(T, K) {
    const k = this.knobs, g = this.goal, S = this.n - 1, F = this.frame, X = this.X;
    const fj = this.fetchJoints(g.grasp), i1 = fj[0], i2 = fj[1], jg = fj[2];
    for (let j = 0; j < S; j++) this.lamGoal[j] = j < jg ? g.lam0[j] : 1;
    let l1 = 0, l2 = 0, l3 = 0;
    for (let j = 0; j < jg; j++) { if (j < i1) l1 += this.len[j]; else if (j < i2) l2 += this.len[j]; else l3 += this.len[j]; }
    if (!g.d0) {
      if (!Number.isFinite(X[jg * 3 + 2])) this.poseFromBends(this.bend, X, null);
      g.d0 = [unitBetween(X, 0, i1, [0, 0, 0]), unitBetween(X, i1, i2, [0, 0, 0]), unitBetween(X, i2, jg, [0, 0, 0])];
      // The suckers face into the fold, so the elbow bows to the arm's back; taken once, or the fold would chase itself.
      g.bow = [-this.SK[i1 * 3], -this.SK[i1 * 3 + 1], -this.SK[i1 * 3 + 2]];
    }
    const [d10, d20, d30] = g.d0, M = g.target, J = g.J;
    // Where the links end: the base keeps its line, then a two-link solve from the first joint into the mouth.
    const Ex = F.p[0] + d10[0] * l1, Ey = F.p[1] + d10[1] * l1, Ez = F.p[2] + d10[2] * l1;
    let mx = M[0] - Ex, my = M[1] - Ey, mz = M[2] - Ez;
    const Dm = len3(mx, my, mz);
    const d2f = this._a, d3f = this._b;
    if (Dm > 1e-9) {
      mx /= Dm; my /= Dm; mz /= Dm;
      let px = g.bow[0], py = g.bow[1], pz = g.bow[2];
      let c = px * mx + py * my + pz * mz;
      px -= c * mx; py -= c * my; pz -= c * mz;
      let pl = len3(px, py, pz);
      if (pl < 0.2) {
        px = F.d[0]; py = F.d[1]; pz = F.d[2];
        c = px * mx + py * my + pz * mz;
        px -= c * mx; py -= c * my; pz -= c * mz;
        pl = len3(px, py, pz) || 1;
      }
      px /= pl; py /= pl; pz /= pl;
      const cosA = Math.max(-1, Math.min(1, (l2 * l2 + Dm * Dm - l3 * l3) / (2 * Math.max(l2, 1e-9) * Dm)));
      const sinA = Math.sqrt(1 - cosA * cosA);
      J[0] = Ex + l2 * (cosA * mx + sinA * px); J[1] = Ey + l2 * (cosA * my + sinA * py); J[2] = Ez + l2 * (cosA * mz + sinA * pz);
      d2f[0] = (J[0] - Ex) / l2; d2f[1] = (J[1] - Ey) / l2; d2f[2] = (J[2] - Ez) / l2;
      d3f[0] = M[0] - J[0]; d3f[1] = M[1] - J[1]; d3f[2] = M[2] - J[2];
      normalize3(d3f, d2f[0], d2f[1], d2f[2]);
    } else { d2f[0] = d20[0]; d2f[1] = d20[1]; d2f[2] = d20[2]; d3f[0] = d30[0]; d3f[1] = d30[1]; d3f[2] = d30[2]; }
    const u = Math.min(1, g.t / g.duration);
    // Base: closes toward the mouth and opens again. Middle: the whole way, on a bell-shaped speed. Distal: late.
    const d1 = this._c, toM = this._n;
    toM[0] = M[0] - F.p[0]; toM[1] = M[1] - F.p[1]; toM[2] = M[2] - F.p[2];
    normalize3(toM, d10[0], d10[1], d10[2]);
    const tb = k.fetchBase * Math.sin(Math.PI * u), cb = Math.acos(Math.max(-1, Math.min(1, d10[0] * toM[0] + d10[1] * toM[1] + d10[2] * toM[2])));
    slerp3(d10, toM, cb > 1e-6 ? Math.min(1, tb / cb) : 0, d1);
    const d2 = slerp3(d20, d2f, minJerk(u), this._f.u), d3 = slerp3(d30, d3f, smoothstep(k.fetchDistalFrom, 1, u), this._f.v);
    const G = this.G;
    G[0] = F.p[0]; G[1] = F.p[1]; G[2] = F.p[2];
    for (let j = 0; j < jg; j++) {
      const d = j < i1 ? d1 : j < i2 ? d2 : d3;
      G[j * 3 + 3] = G[j * 3] + d[0] * this.len[j];
      G[j * 3 + 4] = G[j * 3 + 1] + d[1] * this.len[j];
      G[j * 3 + 5] = G[j * 3 + 2] + d[2] * this.len[j];
    }
    // FABRIK rounds the two sharp corners within loosened cones and keeps the grasp where the links put it.
    const R = this.limRaise, cone = this._fcone ??= { cos: new Float64Array(this.n), sin: new Float64Array(this.n), rootLim: 0, root: F.d };
    R.fill(0);
    const th1 = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2])));
    const th2 = Math.acos(Math.max(-1, Math.min(1, d2[0] * d3[0] + d2[1] * d3[1] + d2[2] * d3[2])));
    // Each fold gets its own run of joints, never sharing one with the other fold.
    const half = Math.max(0, Math.min(k.fetchSmear, Math.floor((i2 - i1 - 1) / 2)));
    for (let f = 0; f < 2; f++) {
      const pj = f ? i2 : i1, lo = Math.max(1, pj - half), hi = Math.min(jg - 1, pj + half);
      const need = k.fetchLimitSlack * (f ? th2 : th1) / (hi - lo + 1);
      for (let j = lo; j <= hi; j++) R[j] = Math.max(R[j], need);
    }
    for (let j = 0; j < this.n; j++) { const l = Math.min(Math.PI, Math.max(this.limBase[j], R[j])); cone.cos[j] = Math.cos(l); cone.sin[j] = Math.sin(l); }
    // It starts where the first fold does, so the proximal link keeps exactly the base's scheduled line.
    const r0 = Math.max(1, i1 - half), sub = this._fsub ??= {};
    if (sub.r0 !== r0) {
      sub.r0 = r0; sub.G = G.subarray(r0 * 3); sub.len = this.len.subarray(r0);
      sub.cone = { cos: cone.cos.subarray(r0), sin: cone.sin.subarray(r0), rootLim: 0, root: d1 };
    }
    sub.cone.rootLim = Math.acos(cone.cos[r0]);
    const gx = G[jg * 3], gy = G[jg * 3 + 1], gz = G[jg * 3 + 2];
    fabrik(sub.G, sub.len, jg - r0 + 1, gx, gy, gz, k.fabrikIters + 1, sub.cone);
    this.bendsFromPoints(G, T, jg);
    // Past the grasp the arm goes slack: nothing but its own give eases it straight while it trails in the water.
    for (let j = 0; j < S; j++) {
      if (j < jg) { K[j] = k.stiffFetch; continue; }
      T[j * 2] = 0; T[j * 2 + 1] = 0;
      K[j] = k.stiffSlack; this.dragGoal[j] = 1;
    }
    if (g.t >= g.duration + g.hold) this._letGo(false);
    return 0;
  }

  /* The bends that reproduce chain P from this arm's root frame (P[0] is assumed at the root), under the arm's
     current twist; joints from `count` on are left as they are. */
  bendsFromPoints(P, out, count = this.n - 1) { return chainBends(this.frame, this.twist, P, out, count, this._f.d, this._a, this._b); }

  /* Integrate bends B outward from the root frame into points P and segment directions D, with each segment's
     twist rolling the frame the next joint bends in. */
  poseFromBends(B, P, D) {
    const S = this.n - 1, F = this.frame, f = this._f, tw = this.twist, SK = this.SKp;
    const d = f.d, u = this._a, v = this._b;
    d[0] = F.d[0]; d[1] = F.d[1]; d[2] = F.d[2];
    u[0] = F.u[0]; u[1] = F.u[1]; u[2] = F.u[2];
    v[0] = F.v[0]; v[1] = F.v[1]; v[2] = F.v[2];
    P[0] = F.p[0]; P[1] = F.p[1]; P[2] = F.p[2];
    for (let j = 0; j < S; j++) {
      bendFrame(d, u, v, B[j * 2], B[j * 2 + 1]);
      if (D) {
        D[j * 3] = d[0]; D[j * 3 + 1] = d[1]; D[j * 3 + 2] = d[2];
        SK[j * 3] = F.cu * u[0] + F.cv * v[0]; SK[j * 3 + 1] = F.cu * u[1] + F.cv * v[1]; SK[j * 3 + 2] = F.cu * u[2] + F.cv * v[2];
      }
      P[j * 3 + 3] = P[j * 3] + d[0] * this.len[j];
      P[j * 3 + 4] = P[j * 3 + 1] + d[1] * this.len[j];
      P[j * 3 + 5] = P[j * 3 + 2] + d[2] * this.len[j];
      roll(u, v, tw[j]);
    }
  }

  /* Carry each segment's posed sucker side onto its solved direction by the smallest rotation between them, so
     everything that asks where the suckers face (touch, seals, taste, the view) reads the chain as it lies, keeping
     the program's twist. Past about 170° off its pose the turn has no clear axis; the segment keeps its last side. */
  _solveSK() {
    const S = this.n - 1, X = this.X, D = this.D, Sp = this.SKp, SK = this.SK;
    for (let j = 0; j < S; j++) {
      const o = j * 3;
      let xx = X[o + 3] - X[o], xy = X[o + 4] - X[o + 1], xz = X[o + 5] - X[o + 2];
      const xl = len3(xx, xy, xz);
      if (!(xl > 1e-9)) continue;
      xx /= xl; xy /= xl; xz /= xl;
      const dx = D[o], dy = D[o + 1], dz = D[o + 2], c = dx * xx + dy * xy + dz * xz;
      let sx, sy, sz;
      if (c > -0.985) {
        // Rodrigues with the unnormalized axis a = d × x: v' = v c + a × v + a (a · v) / (1 + c).
        const ax = dy * xz - dz * xy, ay = dz * xx - dx * xz, az = dx * xy - dy * xx;
        const vx = Sp[o], vy = Sp[o + 1], vz = Sp[o + 2], av = (ax * vx + ay * vy + az * vz) / (1 + c);
        sx = vx * c + (ay * vz - az * vy) + ax * av; sy = vy * c + (az * vx - ax * vz) + ay * av; sz = vz * c + (ax * vy - ay * vx) + az * av;
      } else { sx = SK[o]; sy = SK[o + 1]; sz = SK[o + 2]; }
      const k = sx * xx + sy * xy + sz * xz;
      sx -= k * xx; sy -= k * xy; sz -= k * xz;
      const sl = len3(sx, sy, sz);
      if (sl > 1e-9) { SK[o] = sx / sl; SK[o + 1] = sy / sl; SK[o + 2] = sz / sl; }
    }
  }

  /* The sucker side of segment j on the solved chain, a world unit vector. */
  suckerSide(j, out = [0, 0, 0]) {
    out[0] = this.SK[j * 3]; out[1] = this.SK[j * 3 + 1]; out[2] = this.SK[j * 3 + 2];
    return out;
  }

  _clampBends(B, V) {
    const S = this.n - 1, lim = this.lim;
    for (let j = 0; j < S; j++) {
      const m = len2(B[j * 2], B[j * 2 + 1]);
      if (m > lim[j]) {
        const f = lim[j] / m;
        B[j * 2] *= f; B[j * 2 + 1] *= f;
        if (V) { V[j * 2] *= f; V[j * 2 + 1] *= f; }
      }
    }
  }

  /* The muscle map on this arm's rest geometry, rebuilt when that changes. */
  _muscleArm() {
    if (this._musArm && this._musGen === this.restGen) return this._musArm;
    const S = this.n - 1;
    this._musArm = new MuscleArm({ len: this.len0, rad: this.rad0 });
    this._musGen = this.restGen;
    this.act ??= new Float64Array(GROUPS * S);
    this.mus ??= { lam: new Float64Array(S), bend: new Float64Array(S * 2), twist: new Float64Array(S), bendStiff: new Float64Array(S).fill(1), axialStiff: new Float64Array(S).fill(1) };
    this._mw ??= { bend: new Float64Array(S * 2), lam: new Float64Array(S), twist: new Float64Array(S), brace: new Float64Array(S) };
    this._oral ??= [0, 1];
    return this._musArm;
  }

  /* Muscle mode: the programs' blended bends, stretch, and twist become activations and come back as what the muscles
     can make, braced wherever a program stiffens the arm; joint 0, the turn off her body, stays the program's. */
  _muscles() {
    const k = this.knobs, S = this.n - 1, w = this.w, m = this._muscleArm(), W = this._mw, A = this.act, M = this.mus;
    const iT = this.idleT, gT = this.goalT, G = this.lamGoal, Ta = this.twistAim, kb = Math.max(1e-6, k.stiffBehind - k.stiffIdle);
    for (let j = 0; j < S; j++) {
      W.bend[j * 2] = iT[j * 2] + (gT[j * 2] - iT[j * 2]) * w;
      W.bend[j * 2 + 1] = iT[j * 2 + 1] + (gT[j * 2 + 1] - iT[j * 2 + 1]) * w;
      W.lam[j] = Math.max(k.stretchMin, Math.min(this.lamMax[j], 1 + (G[j] - 1) * w));
      W.twist[j] = this.twistIdle[j] * (1 - w) + Ta[j] * w;
      W.brace[j] = k.braceMax * Math.max(0, Math.min(1, (this.stiffGoal[j] - k.stiffIdle) * w / kb));
    }
    this._oral[0] = this.frame.cu; this._oral[1] = this.frame.cv;
    m.allocate(W, this._oral, A);
    // A reach's bend and a resting curl ride on top as the sucker-side longitudinal (group L0) contracting.
    for (let j = 0; j < S; j++) A[S + j] = Math.min(1, A[S + j] + this.actBump[j] * w + this.actIdle[j] * (1 - w));
    m.equilibrium(A, this._oral, M);
    // A fetch's folds, a plant's held foot, and a recoil's flinch are placed geometry, past what the map lets a joint bend;
    // they keep their bends, fading out with their weight, and the map only braces them (a recoil may ask for the map).
    const kind = this.goal?.kind ?? (w > 1e-3 ? this._lastKind : null);
    if (kind === 'fetch' || kind === 'plant' || (kind === 'recoil' && !this._recoilMap)) M.bend.set(W.bend);
    // A held pose is the one the muscles already made; the map's nearest pose to it would drift the arm off.
    else if (kind === 'still') { M.bend.set(W.bend); M.lam.set(W.lam); M.twist.set(W.twist); }
    else { M.bend[0] = W.bend[0]; M.bend[1] = W.bend[1]; }
  }

  /* Lengths follow their program (in muscle mode, what the muscles make of it) but come back slowly: a lengthened segment recovers at recoverRate, and going
     below rest is muscle shortening, which runs at shortenSpeed over the whole arm. */
  _stepStretch(dt) {
    const k = this.knobs, S = this.n - 1, L = this.lam, G = this.lamGoal, w = this.w;
    const f = 1 - Math.exp(-dt / Math.max(1e-3, k.stretchTau));
    const shorten = k.shortenSpeed / Math.max(1e-3, this._length);
    const plant = this.goal?.kind === 'plant' ? this.goal.lamTo : -1, M = k.muscle ? this.mus.lam : null;
    const rc = this.goal?.kind === 'recoil' ? this.goal : null;
    for (let j = 0; j < S; j++) {
      // A plant's length is the geometry's, set outright, or its anchored suckers would slide.
      if (j <= plant) { L[j] = Math.max(k.stretchMin, Math.min(this.lamMax[j], G[j])); continue; }
      const want = Math.max(k.stretchMin, Math.min(this.lamMax[j], M ? M[j] : 1 + (G[j] - 1) * w));
      let d = (want - L[j]) * f;
      // A recoil's flinching segments shorten at its own pace, which a reflex needs and a program's shortening never would.
      const r = L[j] > 1 ? k.recoverRate : shorten;
      if (d < 0) d = Math.max(d, -(rc && j >= rc.lo && j <= rc.seg ? Math.max(r, rc.rate) : r) * dt);
      L[j] = !this.started ? want : Math.max(k.stretchMin, Math.min(Math.max(this.lamMax[j], L[j]), L[j] + d));
    }
  }

  /* The aim fades with the program, unless the program faces something or holds still (a recoil holds its twist, since
     its held bends live in frames the twist rolls); with none it relaxes away on its own. */
  _fadeAim(dt) {
    if (this.goal?.face || this.goal?.kind === 'still' || this.goal?.kind === 'recoil') return;
    const f = Math.exp(-dt / Math.max(1e-3, this.knobs.release)), Ta = this.twistAim;
    for (let j = 0; j < Ta.length; j++) Ta[j] *= f;
  }

  _stepTwist(dt) {
    const k = this.knobs, S = this.n - 1, tw = this.twist, V = this.twistV, w = this.w;
    const kk = k.stiffTwist, c = 2 * k.damping * Math.sqrt(kk);
    const Ta = this.twistAim, lim = Math.max(k.twistMax, k.aimTwistMax * w), M = k.muscle ? this.mus.twist : null;
    for (let j = 0; j < S; j++) {
      const want = M ? M[j] : this.twistIdle[j] * (1 - w) + Ta[j] * w;
      if (!this.started) { tw[j] = want; V[j] = 0; continue; }
      V[j] = (V[j] + dt * kk * (want - tw[j])) / (1 + dt * c + dt * dt * kk);
      tw[j] = Math.max(-lim, Math.min(lim, tw[j] + V[j] * dt));
    }
  }

  _focus(world, pad) { focusChain(this, world, pad); }

  /* Programs, relaxation, the grip, the pose, then the contact sweep. world and body are collide callbacks. */
  step(dt, world, body) {
    const k = this.knobs, S = this.n - 1;
    if (this.valid === false) return;
    if (!(dt >= 0) || !Number.isFinite(dt)) dt = 0;
    this._dt = dt;
    this.time += dt;
    this._syncRest();
    this._syncLimits();
    if (Number.isFinite(this.X[this.n * 3 - 1])) this.P.set(this.X);
    // A root that jumped farther than any move (a reset, a teleport) has no side to keep: seated from the pose afresh.
    const Fp = this.frame.p;
    this._jumped = this.started && !(len3(Fp[0] - this.P[0], Fp[1] - this.P[1], Fp[2] - this.P[2]) <= k.jumpReset);
    const restRate = dt / Math.max(1e-3, k.restTau);
    this.restW = !this.started ? (this.resting ? 1 : 0) : Math.max(0, Math.min(1, this.restW + (this.resting ? restRate : -restRate)));
    this._idleTargets(dt, world);
    let gripWant = 0;
    if (this.goal) gripWant = this._goalTargets(dt);
    else { this.lamGoal.fill(1); this.dragGoal.fill(0); }
    const wantW = this.goal ? 1 : 0;
    const rate = wantW > this.w ? dt / Math.max(1e-3, k.weightRise) : dt / Math.max(1e-3, k.release);
    this.w += Math.max(-rate, Math.min(rate, wantW - this.w));
    const gRate = gripWant > this.gw ? dt / Math.max(1e-3, k.weightRise) : dt / Math.max(1e-3, k.release);
    this.gw += Math.max(-gRate, Math.min(gRate, gripWant - this.gw));
    // Drag follows its program in, and fades with the program's weight on the way out.
    for (let j = 0; j < S; j++) this.drag[j] = this.goal ? this.dragGoal[j] * this.w : this.drag[j] * Math.max(0, 1 - rate);
    this._fadeAim(dt);
    if (k.muscle) this._muscles();
    this._stepStretch(dt);
    this._stepTwist(dt);
    this._syncLive();
    const w = this.w, T = this.tgt, B = this.bend, V = this.vel, MB = k.muscle ? this.mus.bend : null;
    // A held pose (still, a recoil) keeps what contact bent into it; a fetch places the grasp at her mouth exactly,
    // where what contact left in the bends would hold it short.
    const Rb = this.rest, relax = this.goal?.kind === 'still' || this.goal?.kind === 'recoil' ? 1 : Math.exp(-dt / Math.max(1e-3, k.contactRelax)), rw = this.goal?.kind === 'fetch' ? 1 - w : 1;
    for (let j = 0; j < S; j++) {
      Rb[j * 2] *= relax; Rb[j * 2 + 1] *= relax;
      T[j * 2] = (MB ? MB[j * 2] : this.idleT[j * 2] + (this.goalT[j * 2] - this.idleT[j * 2]) * w) + Rb[j * 2] * rw;
      T[j * 2 + 1] = (MB ? MB[j * 2 + 1] : this.idleT[j * 2 + 1] + (this.goalT[j * 2 + 1] - this.idleT[j * 2 + 1]) * w) + Rb[j * 2 + 1] * rw;
    }
    if (!this.started) {
      B.set(T); V.fill(0);
    } else if (dt > 0) {
      for (let j = 0; j < S; j++) {
        const kk = k.stiffIdle + (this.stiffGoal[j] - k.stiffIdle) * w;
        const c = 2 * k.damping * Math.sqrt(kk);
        // Implicit spring-damper: stable at any stiffness the knobs allow.
        for (let a = j * 2; a < j * 2 + 2; a++) {
          V[a] = (V[a] + dt * kk * (T[a] - B[a])) / (1 + dt * c + dt * dt * kk);
          B[a] += V[a] * dt;
        }
      }
    }
    this._clampBends(B, V);
    const O = this.out;
    O.set(B);
    // The grip: FABRIK on the chain up to the contact point, warm-started from the last solved chain, read back as
    // bends and blended in bend space. Once the grip's goal is gone, it fades on its last answer.
    const gripping = this.goal && (this.goal.kind === 'reach' || this.goal.kind === 'hold' || this.goal.kind === 'plant');
    if (this.gw > 1e-4 && this.started && (gripping || this._lastGrip)) {
      if (gripping) {
        const G = this.G, tg = this.goal.target, gi = this.gripAt;
        if (Number.isFinite(this.X[this.n * 3 - 1])) G.set(this.X); else this.poseFromBends(O, G, null);
        G[0] = this.frame.p[0]; G[1] = this.frame.p[1]; G[2] = this.frame.p[2];
        const cone = this._cone ??= { cos: this.limCos, sin: this.limSin, rootLim: 0, root: this.frame.d };
        cone.rootLim = k.rootBendMax;
        fabrik(G, this.len, gi + 1, tg[0], tg[1], tg[2], k.fabrikIters, cone);
        const L = this._lastGrip ??= new Float64Array(S * 2);
        L.set(O);
        this.bendsFromPoints(G, L, gi);
      }
      const src = this._lastGrip, gw = this.gw;
      for (let a = 0; a < S * 2; a++) O[a] += (src[a] - O[a]) * gw;
      this._clampBends(O, null);
    }
    this.poseFromBends(O, this.G, this.D);
    // The new pose lies within one tick's travel of the last solved chain (or anywhere, before the first).
    if (this.started) this._focus(world, k.focusPad); else world?.unfocus?.();
    this._hit = this.n;
    (this._was ??= new Uint8Array(this.n)).set(this._touched ??= new Uint8Array(this.n));
    this._folded ??= new Uint8Array(this.n);
    this._touched.fill(0);
    this._sweep(world, body);
    // Next tick measures the pose's own turn from this one.
    this.Dp.set(this.D);
    this.Q.set(this.X);
    this._solveSK();
    this.started = true;
  }

  _project(i, world, body) { return projectPoint(this, i, world, body); }
  _pen(i, x, y, z, world, body, out) { return penAt(this, i, x, y, z, world, body, out); }
  _travel(i, world, body, x, y, z) { return travelPoint(this, i, world, body, x, y, z); }

  /* Turn segment i - 1 about its solved start from where point i is now toward (tx, ty, tz), in steps of sweepStep of
     its radius: each step that meets a surface is pushed out and put back at length, so a segment driven into a
     surface folds along it, keeping its length and its side. Returns 0 if it met nothing, 1 if it ended clear, 2 if not. */
  _swing(i, world, body, tx, ty, tz) {
    const k = this.knobs, X = this.X, o = i * 3, n = this._n, L = this.len[i - 1], c = this._f.d, g = this._f.u;
    const px = X[o - 3], py = X[o - 2], pz = X[o - 1];
    c[0] = X[o] - px; c[1] = X[o + 1] - py; c[2] = X[o + 2] - pz;
    g[0] = tx - px; g[1] = ty - py; g[2] = tz - pz;
    normalize3(g, 0, 1, 0);
    normalize3(c, g[0], g[1], g[2]);
    let total = Math.acos(Math.max(-1, Math.min(1, c[0] * g[0] + c[1] * g[1] + c[2] * g[2])));
    const dth = Math.max(1e-3, this.rad[i] * k.sweepStep / L);
    let cnt = Math.max(1, Math.ceil(total / dth));
    // A turn longer than sweepMax checks goes only as far as it was checked; the rest is next tick's.
    if (cnt > k.sweepMax) { slerp3(c, g, k.sweepMax * dth / total, g); total = k.sweepMax * dth; cnt = k.sweepMax; }
    let hit = false, inside = false;
    for (let s = 1; s <= cnt; s++) {
      if (cnt === 1) { c[0] = g[0]; c[1] = g[1]; c[2] = g[2]; } else {
        const left = Math.acos(Math.max(-1, Math.min(1, c[0] * g[0] + c[1] * g[1] + c[2] * g[2])));
        if (left > 1e-9) slerp3(c, g, Math.min(1, total / cnt / left), c);
      }
      let x = px + c[0] * L, y = py + c[1] * L, z = pz + c[2] * L;
      inside = true;
      for (let it = 0; it < 2; it++) {
        const pen = this._pen(i, x, y, z, world, body, n);
        if (!(pen > 0)) { inside = false; break; }
        hit = true;
        // Met head-on, the push runs back along the segment and gives no way around: it tips over a step toward its
        // posed suckers, as a tip curls onto what it meets (the solved side turns with the fold and would chase itself).
        const cn = c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
        if (cn < -k.headOn) {
          const sk = this.SKp, j = i - 1;
          let ux = sk[j * 3], uy = sk[j * 3 + 1], uz = sk[j * 3 + 2];
          const un = ux * n[0] + uy * n[1] + uz * n[2];
          ux -= un * n[0]; uy -= un * n[1]; uz -= un * n[2];
          const ul = len3(ux, uy, uz);
          if (ul > 1e-6) { x += ux / ul * dth * L; y += uy / ul * dth * L; z += uz / ul * dth * L; }
        }
        x += n[0] * pen; y += n[1] * pen; z += n[2] * pen;
        c[0] = x - px; c[1] = y - py; c[2] = z - pz;
        normalize3(c, g[0], g[1], g[2]);
        x = px + c[0] * L; y = py + c[1] * L; z = pz + c[2] * L;
      }
    }
    X[o] = px + c[0] * L; X[o + 1] = py + c[1] * L; X[o + 2] = pz + c[2] * L;
    if (hit) { if (i < this._hit) this._hit = i; if (this._touched) this._touched[i] = 1; }
    return hit ? (inside ? 2 : 1) : 0;
  }

  /* Re-seat point i at its segment length from i - 1, along dir (x, y, z), inside the bend cone. */
  _seat(i, x, y, z, widen = 1) {
    const X = this.X, a = (i - 1) * 3, F = this.frame;
    let rx, ry, rz;
    if (i === 1) { rx = F.d[0]; ry = F.d[1]; rz = F.d[2]; }
    else {
      rx = X[a] - X[a - 3]; ry = X[a + 1] - X[a - 2]; rz = X[a + 2] - X[a - 1];
      const l = len3(rx, ry, rz);
      if (l < 1e-12) { rx = F.d[0]; ry = F.d[1]; rz = F.d[2]; } else { rx /= l; ry /= l; rz /= l; }
    }
    const t = this._t;
    t[0] = x; t[1] = y; t[2] = z;
    normalize3(t, rx, ry, rz);
    const lim = Math.min(Math.PI, this.lim[i - 1] * widen);
    coneClamp(t, 0, rx, ry, rz, Math.cos(lim), Math.sin(lim));
    const L = this.len[i - 1];
    X[i * 3] = X[a] + t[0] * L; X[i * 3 + 1] = X[a + 1] + t[1] * L; X[i * 3 + 2] = X[a + 2] + t[2] * L;
  }

  /* Root to tip. Each segment turns from where it pointed last tick toward where the pose aims it, by as much as the
     pose itself turned it plus a slow catch-up, and its end point slides there around whatever it meets: it stays on
     the side of a solid it came from, and a part contact held back never snaps the rest of the way at once. A trailing
     segment leans toward where it pointed last tick, so the part past a reach's bend is dragged along. */
  _sweep(world, body) {
    const k = this.knobs, X = this.X, D = this.D, F = this.frame, P = this.P, dr = this.drag;
    const lag = this.started ? Math.exp(-this._dt / Math.max(1e-3, k.dragTau)) : 0, dir = this._c;
    const swept = this.started && !this._jumped && k.sweepStep > 0 && Number.isFinite(P[this.n * 3 - 1]);
    X[0] = F.p[0]; X[1] = F.p[1]; X[2] = F.p[2];
    for (let i = 1; i < this.n; i++) {
      const j = i - 1, gd = dr[j] * lag;
      dir[0] = D[j * 3]; dir[1] = D[j * 3 + 1]; dir[2] = D[j * 3 + 2];
      if (gd > 1e-4) {
        const px = P[i * 3] - P[j * 3], py = P[i * 3 + 1] - P[j * 3 + 1], pz = P[i * 3 + 2] - P[j * 3 + 2], pl = len3(px, py, pz);
        if (pl > 1e-9) { dir[0] += (px / pl - dir[0]) * gd; dir[1] += (py / pl - dir[1]) * gd; dir[2] += (pz / pl - dir[2]) * gd; }
      }
      if (!swept) {
        this._seat(i, dir[0], dir[1], dir[2]);
        for (let it = 0; it < k.collideIters; it++) {
          this._project(i, world, body);
          const a = (i - 1) * 3;
          this._seat(i, X[i * 3] - X[a], X[i * 3 + 1] - X[a + 1], X[i * 3 + 2] - X[a + 2]);
        }
        this._project(i, world, body);
        this._unfold(i, world, body);
        continue;
      }
      // A dragged segment's lag is its program's, already smooth; every other gap closes no faster than catchUp.
      this._held = gd < k.dragFree;
      // Two legs, as the arm moves: carried along with the point before, then turned about it.
      const o = i * 3, sd = this._turn(i, dir, world, body), L = this.len[j], tx = X[o], ty = X[o + 1], tz = X[o + 2];
      X[o] = X[o - 3] + sd[0] * L; X[o + 1] = X[o - 2] + sd[1] * L; X[o + 2] = X[o - 1] + sd[2] * L;
      // A carry shorter than the point's radius can't cross anything (her breathing moves every point a little each
      // tick); the swing's first check meets whatever it ends in.
      this._short = false;
      if (len3(X[o] - P[o], X[o + 1] - P[o + 1], X[o + 2] - P[o + 2]) > this.rad[i]) this._travel(i, world, body, P[o], P[o + 1], P[o + 2]);
      // A carry cut short leaves the point behind its segment's start; turning it from there would re-seat it unchecked.
      if (this._short) continue;
      const met = this._swing(i, world, body, tx, ty, tz);
      if (met < 2) continue;
      // Back to length from the solved point before; what that leaves inside a surface is a sliver, so it leaves as it came.
      for (let it = 0; it < k.collideIters; it++) {
        const a = (i - 1) * 3;
        this._seat(i, X[i * 3] - X[a], X[i * 3 + 1] - X[a + 1], X[i * 3 + 2] - X[a + 2], Infinity);
        if (!this._project(i, world, body)) break;
      }
      // Wedged where no direction at full length is clear and squeezed well short, it folds the way the cone and the
      // surfaces allow; a sliver short is left alone, since the fold jumps.
      const a = j * 3;
      if (len3(X[o] - X[a], X[o + 1] - X[a + 1], X[o + 2] - X[a + 2]) < this.len[j] * k.sweepUnfold) this._unfold(i, world, body);
    }
  }

  /* Point i's new place for the swept solve: segment i - 1 turns from last tick's solved direction toward dir (clamped
     into the bend cone off the solved segment before), by the pose's own turn of it this tick plus catchUp. Returns
     last tick's direction. */
  _turn(i, dir, world, body) {
    const k = this.knobs, X = this.X, P = this.P, D = this.D, Dp = this.Dp, F = this.frame, j = i - 1, o = i * 3, L = this.len[j];
    normalize3(dir, D[j * 3], D[j * 3 + 1], D[j * 3 + 2]);
    let rx, ry, rz;
    if (i === 1) { rx = F.d[0]; ry = F.d[1]; rz = F.d[2]; }
    else {
      rx = X[o - 3] - X[o - 6]; ry = X[o - 2] - X[o - 5]; rz = X[o - 1] - X[o - 4];
      const l = len3(rx, ry, rz);
      if (l < 1e-12) { rx = F.d[0]; ry = F.d[1]; rz = F.d[2]; } else { rx /= l; ry /= l; rz /= l; }
    }
    // Only a pose driving the segment into something may fold it past the joint's limit: contact then stops it there.
    const inCone = dir[0] * rx + dir[1] * ry + dir[2] * rz >= this.limCos[j];
    const pressed = !inCone && this._pen(i, X[o - 3] + dir[0] * L, X[o - 2] + dir[1] * L, X[o - 1] + dir[2] * L, world, body, this._n) > 0;
    if (!pressed) coneClamp(dir, 0, rx, ry, rz, this.limCos[j], this.limSin[j]);
    const s = this._a;
    s[0] = P[o] - P[o - 3]; s[1] = P[o + 1] - P[o - 2]; s[2] = P[o + 2] - P[o - 1];
    normalize3(s, dir[0], dir[1], dir[2]);
    // How far the joint was bent last tick, and whether contact put it past its limit: such a fold is kept, unfolding at
    // unfoldRate, until it is back within the limit. Compared as cosines; the angles are only taken when needed.
    let qx = F.d[0], qy = F.d[1], qz = F.d[2];
    if (i > 1) { qx = P[o - 3] - P[o - 6]; qy = P[o - 2] - P[o - 5]; qz = P[o - 1] - P[o - 4]; const ql = len3(qx, qy, qz) || 1; qx /= ql; qy /= ql; qz /= ql; }
    const foldCos = s[0] * qx + s[1] * qy + s[2] * qz, W = this._was, Fd = this._folded;
    if (foldCos >= this.limCos[j]) Fd[i] = 0; else if (W[i] || W[j]) Fd[i] = 1;
    const gapCos = Math.max(-1, Math.min(1, s[0] * dir[0] + s[1] * dir[1] + s[2] * dir[2]));
    let allow = Infinity;
    if (this._held) {
      const posedCos = D[j * 3] * Dp[j * 3] + D[j * 3 + 1] * Dp[j * 3 + 1] + D[j * 3 + 2] * Dp[j * 3 + 2];
      allow = (posedCos > 1 - 1e-12 ? 0 : Math.acos(Math.max(-1, posedCos))) + k.catchUp * this._dt;
    }
    const gap = allow < Math.PI && gapCos < Math.cos(allow) ? Math.acos(gapCos) : 0;
    if (gap > allow) {
      const fold = Math.acos(Math.max(-1, Math.min(1, foldCos)));
      slerp3(s, dir, allow / gap, dir);
      // A held-back segment bends no farther than its joint allows off the one before, or than contact already folded it:
      // a fold unfolds at the turn's pace, never at once.
      const keep = Fd[i] ? Math.min(Math.PI, fold - k.unfoldRate * this._dt) : 0;
      if (pressed) { /* contact, not the cone, stops it */ }
      else if (keep > this.lim[j]) coneClamp(dir, 0, rx, ry, rz, Math.cos(keep), Math.sin(keep));
      else coneClamp(dir, 0, rx, ry, rz, this.limCos[j], this.limSin[j]);
    }
    X[o] = X[o - 3] + dir[0] * L; X[o + 1] = X[o - 2] + dir[1] * L; X[o + 2] = X[o - 1] + dir[2] * L;
    return s;
  }

  /* Met head-on, the cone and the contact disagree and the segment collapses; a wider cone folds it instead. Driven
     into a corner, every widening still aims into it, so the last try folds the way the surfaces push. */
  _unfold(i, world, body) {
    const X = this.X, a = (i - 1) * 3, L = this.len[i - 1] * (1 - this.knobs.foldSlack), push = this._push3;
    for (let widen = 1.5; widen <= 3.76; widen += 0.75) {
      let dx = X[i * 3] - X[a], dy = X[i * 3 + 1] - X[a + 1], dz = X[i * 3 + 2] - X[a + 2];
      if (len3(dx, dy, dz) > L) return;
      if (widen > 3.01) {
        // Only a real jam folds along the push: taken on a hair's margin it flips tick to tick and throws the arm.
        if (len3(dx, dy, dz) > this.len[i - 1] * this.knobs.foldJam) return;
        if (!push || !(len3(push[0], push[1], push[2]) > 1e-6)) return;
        dx = push[0]; dy = push[1]; dz = push[2];
      }
      this._seat(i, dx, dy, dz, widen);
      this._project(i, world, body);
    }
  }

  /* One round after the arm-on-arm push: bend limits as minimum spans across each triple, so a kink pressed into a
     surface rounds off by lifting the points before it; then lengths from the root, then contact has the last word.
     `feed` off leaves the contact hold to whoever calls _feedback with another chain's contact (a rod arm's body). */
  finishPass(world, body, last = false, feed = true) {
    if (this.valid === false) return;
    this._focus(world, this.knobs.focusPad);
    const X = this.X, n = this.n, F = this.frame, len = this.len, lim = this.limCos;
    const Q = this.started && !this._jumped && this.knobs.sweepStep > 0 ? this.Q : null;
    X[0] = F.p[0]; X[1] = F.p[1]; X[2] = F.p[2];
    const Tc = Q ? this._touched : null, Fd = this._folded;
    for (let j = 0; j < n - 1; j++) {
      // Where contact holds the arm, or folded a joint that is still unfolding, it may bend past the limit: lifted back
      // here, it would be pushed in again next tick, and a touch flickering on and off would make them take turns.
      if (Tc && (Tc[j + 1] || Tc[j] || (j > 0 && Tc[j - 1]) || Fd[j + 1])) continue;
      // Joint 0 bends against a pinned virtual point one segment back along the root's outward direction.
      let ax, ay, az, la;
      if (j === 0) { la = len[0]; ax = F.p[0] - F.d[0] * la; ay = F.p[1] - F.d[1] * la; az = F.p[2] - F.d[2] * la; }
      else { la = len[j - 1]; ax = X[j * 3 - 3]; ay = X[j * 3 - 2]; az = X[j * 3 - 1]; }
      const span = Math.sqrt(la * la + len[j] * len[j] + 2 * la * len[j] * lim[j]);
      const c = (j + 1) * 3;
      let ux = X[c] - ax, uy = X[c + 1] - ay, uz = X[c + 2] - az;
      const d = len3(ux, uy, uz);
      if (d >= span || d < 1e-9) continue;
      ux /= d; uy /= d; uz /= d;
      const wa = j <= 1 ? 0 : 1, corr = (span - d) / (wa + 1);
      X[c] += ux * corr; X[c + 1] += uy * corr; X[c + 2] += uz * corr;
      if (wa) { X[j * 3 - 3] -= ux * corr; X[j * 3 - 2] -= uy * corr; X[j * 3 - 1] -= uz * corr; }
    }
    for (let i = 1; i < n; i++) {
      const a = (i - 1) * 3;
      let dx = X[i * 3] - X[a], dy = X[i * 3 + 1] - X[a + 1], dz = X[i * 3 + 2] - X[a + 2];
      const l = len3(dx, dy, dz);
      if (l < 1e-12) { dx = F.d[0]; dy = F.d[1]; dz = F.d[2]; } else { dx /= l; dy /= l; dz /= l; }
      X[i * 3] = X[a] + dx * len[i - 1]; X[i * 3 + 1] = X[a + 1] + dy * len[i - 1]; X[i * 3 + 2] = X[a + 2] + dz * len[i - 1];
      // Re-seated off a point the passes before moved, it slides there from where it last lay clear, keeping its side; a
      // move shorter than one check can't cross anything, so a plain push-out does.
      const m = Q ? len3(X[i * 3] - Q[i * 3], X[i * 3 + 1] - Q[i * 3 + 1], X[i * 3 + 2] - Q[i * 3 + 2]) : Infinity;
      // Not moved since it last lay clear, it is still clear (by a hair: stillTol) and needs no check, unless the last round
      // finds it touching; the last round still checks its segment's middle.
      const still = m < this.knobs.stillTol && !(last && this._touched[i]);
      if (still && !last) continue;
      let moved = still ? false : Q && m > this.rad[i] * this.knobs.sweepStep ? this._travel(i, world, body, Q[i * 3], Q[i * 3 + 1], Q[i * 3 + 2]) : this._project(i, world, body);
      if (!last) continue;
      // A long segment can cut the corner of a lip or a small toy between its two points: swing its end to lift its middle.
      if (world) {
        const nrm = this._n, pen = world.collide((X[a] + X[i * 3]) / 2, (X[a + 1] + X[i * 3 + 1]) / 2, (X[a + 2] + X[i * 3 + 2]) / 2, (this.rad[i - 1] + this.rad[i]) / 2, nrm, i);
        if (pen > 0) {
          const fx = X[i * 3], fy = X[i * 3 + 1], fz = X[i * 3 + 2];
          X[i * 3] += 2 * pen * nrm[0]; X[i * 3 + 1] += 2 * pen * nrm[1]; X[i * 3 + 2] += 2 * pen * nrm[2];
          if (Q) { this._seat(i, X[i * 3] - X[a], X[i * 3 + 1] - X[a + 1], X[i * 3 + 2] - X[a + 2], Infinity); this._travel(i, world, body, fx, fy, fz); continue; }
          moved = true;
        }
      }
      if (!moved || Q) continue;
      for (let c = 0; c < this.knobs.collideIters; c++) {
        this._seat(i, X[i * 3] - X[a], X[i * 3 + 1] - X[a + 1], X[i * 3 + 2] - X[a + 2], 3);
        if (!this._project(i, world, body)) break;
      }
    }
    if (Q) Q.set(X);
    this._solveSK();
    if (last && feed) this._feedback();
  }

  /* The pose ignores contact and would drive on through what the arm lies on. Where contact holds the arm, the springs'
     targets take the shape it left, touched segments as solved and free ones keeping their posed world direction, so
     the bends follow through the springs (nothing in the pose jumps) and come to rest against it; then it relaxes.
     The contact is this chain's own unless src ({ X, touched, hit }) brings another's. */
  _feedback(src = null) {
    // A held pose bakes nothing in: its contact offsets are frozen with it. A recoil holds its flinch the same way, or
    // contact would press it back onto the thing it flinched from.
    if (this.goal?.kind === 'still' || this.goal?.kind === 'recoil') return;
    // A resting curl keeps pressing into what it wraps, so feedback fades out with rest.
    const k = this.knobs, w = k.contactFeedback * (1 - this.restW * k.feedbackRest), S = this.n - 1;
    const X = src ? src.X : this.X, h = src ? src.hit : this._hit, Tc = src ? src.touched : this._touched;
    if (!(w > 0) || !this.started || h >= this.n || !Number.isFinite(X[this.n * 3 - 1])) return;
    const D = this.D, H = this._fh ??= new Float64Array(this.n * 3), Fb = this._fb ??= new Float64Array(S * 2), d = this._t;
    H[0] = X[0]; H[1] = X[1]; H[2] = X[2];
    for (let s = 0; s < S; s++) {
      d[0] = D[s * 3]; d[1] = D[s * 3 + 1]; d[2] = D[s * 3 + 2];
      if (s + 1 >= h && Tc[s + 1]) { d[0] = X[s * 3 + 3] - X[s * 3]; d[1] = X[s * 3 + 4] - X[s * 3 + 1]; d[2] = X[s * 3 + 5] - X[s * 3 + 2]; normalize3(d, D[s * 3], D[s * 3 + 1], D[s * 3 + 2]); }
      H[s * 3 + 3] = H[s * 3] + d[0]; H[s * 3 + 4] = H[s * 3 + 1] + d[1]; H[s * 3 + 5] = H[s * 3 + 2] + d[2];
    }
    this.bendsFromPoints(H, Fb);
    // A shape the joints can't hold is never asked for, or the offset would grow by the unreachable part every tick.
    this._clampBends(Fb, null);
    const V = this.vel, T = this.tgt, Rb = this.rest;
    for (let j = Math.max(0, h - 1); j < S; j++) {
      // Only joints contact bent, and the one after each such run that keeps the free part's direction: elsewhere the pose
      // is the program's own (a grip, a spring still on its way), not contact's to bake in.
      if (!Tc[j + 1] && !Tc[j]) continue;
      const du = (Fb[j * 2] - T[j * 2]) * w, dv = (Fb[j * 2 + 1] - T[j * 2 + 1]) * w;
      if (!Number.isFinite(du + dv)) continue;
      Rb[j * 2] += du; Rb[j * 2 + 1] += dv;
      if (!Tc[j + 1]) continue;
      // Speed that drove the bend into the contact is spent there, never returned as a bounce.
      const c = V[j * 2] * du + V[j * 2 + 1] * dv;
      if (c < 0) { const l2 = du * du + dv * dv; V[j * 2] -= c / l2 * du; V[j * 2 + 1] -= c / l2 * dv; }
    }
  }

  finish(world, body) { for (let it = 0; it < this.knobs.finishIters; it++) this.finishPass(world, body, it === this.knobs.finishIters - 1); }

  /* NaN count, worst length error against the live lengths (fraction), worst bend (rad), how far any joint
     bends past its own limit (rad), and the stretch and twist extremes. */
  health() {
    const X = this.X, lim = this.lim;
    let nan = 0, lenErr = 0, bend = 0, over = -Infinity, smax = 0, smin = Infinity, tmax = 0;
    for (let i = 0; i < X.length; i++) if (!Number.isFinite(X[i])) nan++;
    let px = 0, py = 0, pz = 0;
    for (let j = 0; j < this.n - 1; j++) {
      let dx = X[j * 3 + 3] - X[j * 3], dy = X[j * 3 + 4] - X[j * 3 + 1], dz = X[j * 3 + 5] - X[j * 3 + 2];
      const l = len3(dx, dy, dz);
      lenErr = Math.max(lenErr, Math.abs(l - this.len[j]) / this.len[j]);
      if (l > 1e-12) { dx /= l; dy /= l; dz /= l; }
      if (j > 0) {
        const b = Math.acos(Math.max(-1, Math.min(1, dx * px + dy * py + dz * pz)));
        bend = Math.max(bend, b); over = Math.max(over, b - lim[j]);
      }
      px = dx; py = dy; pz = dz;
      smax = Math.max(smax, this.lam[j]); smin = Math.min(smin, this.lam[j]); tmax = Math.max(tmax, Math.abs(this.twist[j]));
    }
    return { nan, lenErr, bend, bendOver: over, stretchMax: smax, stretchMin: smin, twistMax: tmax };
  }
}

/* Roll the frame's (u, v) about its axis by a. */
function roll(u, v, a) {
  if (a === 0) return;
  const c = Math.cos(a), s = Math.sin(a);
  const ux = u[0] * c + v[0] * s, uy = u[1] * c + v[1] * s, uz = u[2] * c + v[2] * s;
  v[0] = v[0] * c - u[0] * s; v[1] = v[1] * c - u[1] * s; v[2] = v[2] * c - u[2] * s;
  u[0] = ux; u[1] = uy; u[2] = uz;
}
