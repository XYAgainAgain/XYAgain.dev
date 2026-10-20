import { LOCO_KNOBS, surfaceMode, clamp } from './locomotion-core.js';

/* Climbing without THREE or Jolt: the pull stroke's rate and limits, where a reach ahead lands, the hand-over-hand
   safety rule, the support she hangs from, and arrival judged in a wall's plane. loco-climb.js runs it on her body. */

export { surfaceMode };

export const CLIMB_KNOBS = {
  reachAhead: 0.35,       // m from the crown along the travel a pull reaches (design; the arm is 0.65 m)
  holdTol: 0.06,          // m a sealed anchor may lie off the reach point and still plant (design)
  snapMax: 0.15,          // m the reach point may lie off a surface before there is nothing ahead to pull on (design)
  ellMinFloor: 0.08,      // m: a pull ends at the larger of this and ellMinShare of the arm out to the hold (design;
  ellMinShare: 0.4,       // a hold 0.3–0.4 m out on a bowed arm then gives a 0.14–0.18 m stroke, derived)
  behindTol: 0.02,        // m a hold may fall behind the travel before its pull ends (design)
  holdSafety: 3,          // what the holds left after a release must bear, in multiples of her in-water weight (design)
  minWallHolds: 2,        // holds kept on anything steeper than a floor (design)
  weightN: 0.39,          // N, her whole in-water weight (derived in the Water Report)
  domeWall: 0.25,         // the dome's share while she hangs on two or more wall holds (design)
  pullStallT: 3,          // s the stall's front-arm pull stays open on the floor after the stall asks for it (design)
  wallStandMax: 0.12,     // m off the spot along the wall's normal she may be and still have arrived on it (design, 2× her standoff)
  standH: 0.08,           // m under her crown a floor still holds her up; resting, her crown sits 2–5 cm up (measured in the sim)
  wallReach: 0.2,         // m out along a free arm's bearing that a hanging arm lays itself on the wall (design)
  spareHolds: 1,          // wall holds kept past minWallHolds while she hangs, against the flicker (design)
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* Where a pull ends: rest length down to the larger of a floor and a share of the arm's rest length out to the hold. */
export function ellMin(len0, seg, k = CLIMB_KNOBS) {
  let s = 0;
  for (let j = 0; j <= seg && j < len0.length; j++) s += len0[j];
  return Math.max(k.ellMinFloor, k.ellMinShare * s);
}

/* The rest length's rate for a body wanted at speed along the 3D travel d; u runs from the hold to the root, so a hold
   ahead gives a negative rate (she hauls herself in). */
export function pullRate(speed, d, u) { return speed * dot(d, u); }

/* How far a hold A lies ahead of the root p along the travel d; negative once it has fallen behind. */
export function holdAhead(A, p, d) { return (A[0] - p[0]) * d[0] + (A[1] - p[1]) * d[1] + (A[2] - p[2]) * d[2]; }

/* Why a planted pull ends, or null. Only 'lost' is forced; the rest are choices the safety rule may refuse. */
export function pullRelease({ ell, min, max = Infinity, ahead, lostT, grace, t, tMax }, k = CLIMB_KNOBS) {
  if (lostT > grace) return 'lost';
  if (ell <= min) return 'short';
  if (ell >= max) return 'full';
  if (ahead < -k.behindTol) return 'behind';
  if (t > tMax) return 'long';
  return null;
}

/* Hand over hand: arm a may let go only if the other holds still number minWallHolds and bear holdSafety × her weight.
   `force` and `holding` are per arm; with `steep` false (on a floor) any release is safe. */
export function releaseSafe(force, holding, a, steep = true, k = CLIMB_KNOBS) {
  if (!steep) return true;
  let n = 0, f = 0;
  for (let i = 0; i < holding.length; i++) {
    if (i === a || !holding[i]) continue;
    n++;
    f += Math.max(0, force[i] || 0);
  }
  return n >= k.minWallHolds && f >= k.holdSafety * k.weightN;
}

/* The mean outward normal of the holding arms' anchors (flat, 3 per arm), or the fallback when none hold. */
export function supportNormal(anchorN, holding, fallback, out) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < holding.length; i++) {
    if (!holding[i]) continue;
    x += anchorN[i * 3]; y += anchorN[i * 3 + 1]; z += anchorN[i * 3 + 2];
  }
  const l = Math.hypot(x, y, z);
  if (l > 1e-6 && Number.isFinite(l)) { out[0] = x / l; out[1] = y / l; out[2] = z / l; }
  else { out[0] = fallback[0]; out[1] = fallback[1]; out[2] = fallback[2]; }
  return out;
}

/* Holds on anything steeper than a floor: the walls, the lid, the undersides of ledges. */
export function wallHolds(anchorN, holding, k = LOCO_KNOBS) {
  let n = 0;
  for (let i = 0; i < holding.length; i++) if (holding[i] && !(anchorN[i * 3 + 1] > k.floorCos)) n++;
  return n;
}

/* Arrival on a wall, judged in its plane: her crown can't come nearer the glass than about 6 cm, so the offset along
   the wall's unit normal n is dropped before comparing with r, as long as it stays within nMax (she is on it). */
export function arrivedWall(c, t, n, r, nMax = Infinity) {
  const vx = c[0] - t[0], vy = c[1] - t[1], vz = c[2] - t[2], along = vx * n[0] + vy * n[1] + vz * n[2];
  if (Math.abs(along) > nMax) return false;
  return Math.hypot(vx - along * n[0], vy - along * n[1], vz - along * n[2]) <= r;
}

/* How much a root helps a pull along d: its outward bearing in her crown's plane (n with the up component removed)
   against the travel. Front arms on a climb, never the ones trailing. */
export function pullUsefulness(n, up, d) {
  const a = dot(n, up), bx = n[0] - a * up[0], by = n[1] - a * up[1], bz = n[2] - a * up[2], l = Math.hypot(bx, by, bz);
  if (!(l > 1e-6)) return 0;
  return (bx * d[0] + by * d[1] + bz * d[2]) / l;
}

/* The reach point: `reachAhead` from the crown c along d, dropped onto the nearest surface through
   `distance(x, y, z, normalOut)`. Null when that surface lies over snapMax away or behind the crown. */
export function reachPoint(c, d, distance, out, nrm, k = CLIMB_KNOBS) {
  out[0] = c[0] + d[0] * k.reachAhead; out[1] = c[1] + d[1] * k.reachAhead; out[2] = c[2] + d[2] * k.reachAhead;
  let moved = 0;
  for (let it = 0; it < 4; it++) {
    const s = distance(out[0], out[1], out[2], nrm);
    if (!Number.isFinite(s)) return null;
    out[0] -= nrm[0] * s; out[1] -= nrm[1] * s; out[2] -= nrm[2] * s;
    moved += Math.abs(s);
    if (Math.abs(s) < 1e-5) break;
  }
  if (moved > k.snapMax || !Number.isFinite(out[0] + out[1] + out[2])) return null;
  return holdAhead(out, c, d) > 0 ? out : null;
}

/* The share of the dome she keeps: domeWall while two or more holds are on the walls, all of it otherwise. */
export function domeShare(walls, k = CLIMB_KNOBS) { return walls >= 2 ? clamp(k.domeWall, 0, 1) : 1; }
