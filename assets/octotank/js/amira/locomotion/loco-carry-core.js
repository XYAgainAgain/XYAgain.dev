/* Holds on loose things, THREE-free: which of her and a gripped thing moves when she pulls, judged by in-water
   weight, the floor's friction toll, and mass; whether a toy is wedged; how big it is; and who owns an arm. */

export const CARRY_KNOBS = {
  webCarryMax: 0.06,      // m, the largest full extent that rides under her web; the crown ring is 8.5 cm across
  stowStand: 0,           // of the toy's size, how far below her mouth a stowed toy hangs; flat on the floor she has no room
  stowOut: 0.5,           // of the toy's size past the crown ring's edge toward the arm's base, in the web; 0 keeps it at the mouth
  stowSlack: 0.03,        // m a stowed grip may drift from where the fetch holds it before the fetch is planned again
  stowReset: 0.25,        // s it must stay that far off first
  refetchTime: 0.4,       // s a replanned fold takes, against the first fetch's 1.2 s: the arm is already folded
  wedgeN: 20,             // N a wedged thing holds with: more than any arm pulls, so she hauls herself to it
  wedgeGap: 0.005,        // m past the toy's own surface that furniture still counts as pinching it
  wedgeDot: -0.5,         // two pinching surfaces must face each other at least this squarely
  floorGap: 0.005,        // m between a toy's lowest point and the floor under which it rests on it
  floorCos: 0.7,          // a surface whose normal is this near up is a floor
  floorMu: 0.55,          // toy on floor, √(0.5 × 0.6) by Jolt's geometric mean
  bodyWeight: 0.39,       // N, her whole animal in water
  bodyToll: 0.1,          // N to drag her soft body along the floor: 0.49 × 0.196 N
  bodyMass: 1,            // kg
  verticalCos: 0.5,       // a pull this steep is a lift, judged by weight in water
  feelGrips: true,        // what she carries pulls on the patch of the arm carrying it
  feelCap: 1.5,           // N the most a carry's pull on her patch gets
  feelTau: 0.1,           // s the felt pull is smoothed over, so a grip's first jerk doesn't kick her
  haulDone: 0.12,         // m of chord at which a haul has brought her to the thing
  haulMax: 15,            // s a haul may run
  haulMin: 0.02,          // m the rest length never goes under
  haulLead: 0.04,         // m the rest length may run ahead of the chord
  reelHold: 3,            // s a reeled-in thing that is too big for the web is held at the mouth
};

// A reflex takes an arm from attention or a stroke, never from a jet's mode or a hold.
export const CLAIM_TIERS = { idle: 0, attend: 1, stroke: 2, reflex: 3, mode: 4, held: 5 };

/* Whether a claim at `tier` takes an arm `owner` holds: never from a stronger tier, always from its own or a weaker. */
export function claimWins(owner, tier, T = CLAIM_TIERS) {
  if (!(tier in T)) return false;
  return T[tier] >= (T[owner] ?? 0);
}

/* The owner an arm falls back to once nothing holds it: idle, unless a whole-body mode still claims it. */
export function settleOwner(owner, busy) {
  return busy || owner === 'mode' ? owner : 'idle';
}

/* Quaternion [x, y, z, w] applied to v (or its inverse with inv), into out. */
export function rotate(q, v, out, inv = false) {
  const x = inv ? -q[0] : q[0], y = inv ? -q[1] : q[1], z = inv ? -q[2] : q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  out[0] = v[0] + w * tx + (y * tz - z * ty);
  out[1] = v[1] + w * ty + (z * tx - x * tz);
  out[2] = v[2] + w * tz + (x * ty - y * tx);
  return out;
}

/* How far a shape reaches from its center along unit world direction d: box (half extents), sphere ([r]), capsule
   and cylinder ([halfHeight, r], along local y). */
export function supportDist(kind, size, q, d, tmp = [0, 0, 0]) {
  const l = rotate(q, d, tmp, true);
  if (kind === 'sphere') return size[0];
  if (kind === 'box') return Math.abs(l[0]) * size[0] + Math.abs(l[1]) * size[1] + Math.abs(l[2]) * size[2];
  const ay = Math.abs(l[1]);
  if (kind === 'capsule') return size[1] + size[0] * ay;
  return size[1] * Math.sqrt(Math.max(0, 1 - ay * ay)) + size[0] * ay;
}

/* The largest full extent of a shape: what decides whether it fits under her web. */
export function extent(kind, size) {
  if (kind === 'sphere') return 2 * size[0];
  if (kind === 'box') return 2 * Math.max(size[0], size[1], size[2]);
  if (kind === 'capsule') return 2 * (size[0] + size[1]);
  return 2 * Math.max(size[0], size[1]);
}

export function isSmall(kind, size, k = CARRY_KNOBS) { return extent(kind, size) < k.webCarryMax; }

const DIRS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
  if (!x && !y && !z) continue;
  const l = Math.hypot(x, y, z);
  DIRS.push([x / l, y / l, z / l]);
}

/* Furniture within the toy's own reach plus wedgeGap, probed in 26 directions through `distance(x, y, z, nrmOut)`
   (signed, the furniture's outward normal). Wedged when two such surfaces face each other: dot under wedgeDot. */
export function isWedged(center, kind, size, q, distance, k = CARRY_KNOBS, normals = null) {
  const found = normals ?? [], nrm = [0, 0, 0], tmp = [0, 0, 0];
  found.length = 0;
  for (const d of DIRS) {
    const r = supportDist(kind, size, q, d, tmp);
    const dist = distance(center[0] + d[0] * r, center[1] + d[1] * r, center[2] + d[2] * r, nrm);
    if (!(dist <= k.wedgeGap) || !Number.isFinite(nrm[0] + nrm[1] + nrm[2])) continue;
    // Only a surface the probe direction runs into, not one it merely grazes.
    if (nrm[0] * d[0] + nrm[1] * d[1] + nrm[2] * d[2] > -0.3) continue;
    for (const m of found) if (m[0] * nrm[0] + m[1] * nrm[1] + m[2] * nrm[2] < k.wedgeDot) return true;
    found.push([nrm[0], nrm[1], nrm[2]]);
  }
  return false;
}

/* Whether a toy rests on the floor: the furniture straight below its lowest point is within floorGap and faces up. */
export function onFloor(center, kind, size, q, distance, k = CARRY_KNOBS) {
  const down = [0, -1, 0], nrm = [0, 0, 0], r = supportDist(kind, size, q, down);
  const dist = distance(center[0], center[1] - r, center[2], nrm);
  return dist <= k.floorGap && nrm[1] > k.floorCos;
}

/* What a loose thing holds with: wedgeN wedged, the friction toll resting on the floor, nothing adrift. */
export function objectHold({ wedged = false, resting = false, weightInWater = 0 } = {}, k = CARRY_KNOBS) {
  if (wedged) return k.wedgeN;
  return resting ? k.floorMu * Math.max(0, weightInWater) : 0;
}

/* Which moves when she pulls on a gripped thing: 'object' (she reels it in) or 'body' (she hauls herself to it).
   anchor is her other arms' sealed hold on the furniture; up is |pull · up|. Returns { who, why }. */
export function whoMovesInWater({
  anchor = 0, wedged = false, resting = false, weightInWater = 0, up = 0, bodyOnFloor = true, objectMass = 0,
} = {}, k = CARRY_KNOBS) {
  const hold = objectHold({ wedged, resting, weightInWater }, k);
  if (anchor > 0 || wedged) {
    if (anchor > hold) return { who: 'object', why: 'anchored' };
    return { who: 'body', why: wedged ? 'wedged' : 'held harder' };
  }
  // Neither is held. A lift goes to whichever weighs less in water; she weighs her whole animal.
  if (up > k.verticalCos) return weightInWater < k.bodyWeight ? { who: 'object', why: 'lighter' } : { who: 'body', why: 'heavier' };
  const tollO = resting ? k.floorMu * Math.max(0, weightInWater) : 0, tollB = bodyOnFloor ? k.bodyToll : 0;
  if (tollO !== tollB) return tollO < tollB ? { who: 'object', why: 'toll' } : { who: 'body', why: 'toll' };
  return objectMass <= k.bodyMass ? { who: 'object', why: 'mass' } : { who: 'body', why: 'mass' };
}

/* Toy-local offset of world point p for a body at c turned by q, into out; and back. */
export function toLocalPoint(p, c, q, out) {
  const v = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  return rotate(q, v, out, true);
}

export function toWorldPoint(o, c, q, out) {
  rotate(q, o, out);
  out[0] += c[0]; out[1] += c[1]; out[2] += c[2];
  return out;
}

/* One haul tick's rest length: shortening at `speed` toward the hold, never under haulMin nor more than haulLead ahead
   of the chord, so a pinned body never winds the spring up. */
export function haulStep(ell, chord, speed, dt, k = CARRY_KNOBS) {
  const next = ell - Math.max(0, speed) * dt;
  return Math.min(Math.max(next, chord - k.haulLead, k.haulMin), Math.max(chord, k.haulMin));
}
