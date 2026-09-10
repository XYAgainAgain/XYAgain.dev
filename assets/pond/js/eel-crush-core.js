/* THREE-free half of the crush gag: Jaz's lane, the miss test, the fluster meter, and the huffy exit
   point. Points and headings are plain { x, z }, so all of it is testable without a renderer. */

const ok = (v) => typeof v === 'number' && Number.isFinite(v);

export const LANE_CHECK = 0.9;    // seconds after a corner the overshoot is measured
export const CLEAN_BACK = 0.5;    // a corner taken cleanly gives back half a miss
export const MISS_DOT = 0.5;      // heading agreement with Jaz below this is a miss on its own
export const PUNCH_NEAR = 0.8;    // body lengths from Jaz's mid-body the punchline may fire inside
export const PUNCH_DOT = 0.5;
export const EXIT_AHEAD = 2.5, EXIT_SIDE = 1.4;   // body lengths ahead of and beside Jaz the bypass sits
export const EXIT_BURST = 1.2;    // seconds of the exit that run at the speed multiplier

/* Unit heading, or null for a zero-length or junk one. Every consumer treats null as "no lane this
   tick" rather than handing an eel a NaN target. */
export function unitHeading(hx, hz) {
  if (!ok(hx) || !ok(hz)) return null;
  const len = Math.hypot(hx, hz);
  if (len < 1e-6) return null;
  return { x: hx / len, z: hz / len };
}

const pt = (p) => (p && ok(p.x) && ok(p.z) ? p : null);

/* Where a member swims: one gap of its own body lengths per queue position, straight back down the
   lane Jaz is on. Later joiners sit further back, so a bout queues single-file. */
export function lanePoint(jazHead, jazHeading, gap, memberIndex, len) {
  const j = pt(jazHead), h = jazHeading ? unitHeading(jazHeading.x, jazHeading.z) : null;
  if (!j || !h || !ok(gap) || !ok(len)) return null;
  const back = gap * (Math.max(0, Math.floor(ok(memberIndex) ? memberIndex : 0)) + 1) * len;
  return { x: j.x - h.x * back, z: j.z - h.z * back };
}

/* Signed distance from the lane, positive toward the (h.z, −h.x) perpendicular. The sign is the side
   the follower drifted to, which is the side the exit passes on. */
export function laneOffset(head, jazHead, jazHeading) {
  const p = pt(head), j = pt(jazHead), h = jazHeading ? unitHeading(jazHeading.x, jazHeading.z) : null;
  if (!p || !j || !h) return 0;
  return (p.x - j.x) * h.z - (p.z - j.z) * h.x;
}

export function sideOf(off) {
  return ok(off) && off < 0 ? -1 : 1;
}

/* The armed sample after a corner: too far off the lane, or no longer going the way Jaz went. `off` is
   signed for the exit's benefit; the tolerance is compared against its magnitude. */
export function missTest(head, heading, jazHead, jazHeading, laneTol, len) {
  const eh = heading ? unitHeading(heading.x, heading.z) : null;
  const jh = jazHeading ? unitHeading(jazHeading.x, jazHeading.z) : null;
  if (!eh || !jh || !ok(len)) return { off: 0, dot: 1, miss: false };
  const off = laneOffset(head, jazHead, jazHeading);
  const dot = eh.x * jh.x + eh.z * jh.z;
  const tol = (ok(laneTol) ? laneTol : 0.6) * len;
  return { off, dot, miss: Math.abs(off) > tol || dot < MISS_DOT };
}

/* One step of the 0–1 annoyance meter, moved by corners rather than by the clock: a fumbled corner adds
   `per`, a clean one gives back half of that, and between corners the meter holds whatever it holds. */
export function stepFluster(fluster, { missed = false, per = 0.34, clean = CLEAN_BACK } = {}) {
  const f = ok(fluster) ? fluster : 0;
  const step = ok(per) ? per : 0;
  const back = ok(clean) ? clean : CLEAN_BACK;
  return Math.min(1, Math.max(0, f + (missed ? step : -step * back)));
}

/* The bypass: up Jaz's lane and out to the side they already drifted toward. */
export function exitPoint(jazHead, jazHeading, side, len) {
  const j = pt(jazHead), h = jazHeading ? unitHeading(jazHeading.x, jazHeading.z) : null;
  if (!j || !h || !ok(len)) return null;
  const s = sideOf(side);
  return {
    x: j.x + h.x * EXIT_AHEAD * len + h.z * s * EXIT_SIDE * len,
    z: j.z + h.z * EXIT_AHEAD * len - h.x * s * EXIT_SIDE * len,
  };
}

/* The per-roll chance, cold or joining: watching a friend attempt the grid is more contagious than
   deciding to try it, so a join carries the boost. Clamped, since it is a probability. */
export function entryOdds(odds, perEel, joinBoost, joining) {
  const boost = joining ? (ok(joinBoost) ? joinBoost : 1) : 1;
  const p = (ok(odds) ? odds : 0) * (ok(perEel) ? perEel : 0) * boost;
  return ok(p) ? Math.min(1, Math.max(0, p)) : 0;
}

/* Close enough to a running bout to catch it. An empty member list is a bout with nobody left in it,
   which nobody can see. */
export function withinJoin(head, memberPts, radius) {
  const p = pt(head);
  if (!p || !Array.isArray(memberPts) || !ok(radius)) return false;
  for (const m of memberPts) {
    const q = pt(m);
    if (q && Math.hypot(q.x - p.x, q.z - p.z) <= radius) return true;
  }
  return false;
}

/* The nose-first punchline's geometry: inside PUNCH_NEAR body lengths of Jaz's mid-body and pointed
   at it. */
export function punchline(head, heading, jazMid, len) {
  const p = pt(head), m = pt(jazMid), h = heading ? unitHeading(heading.x, heading.z) : null;
  if (!p || !m || !h || !ok(len)) return false;
  const dx = m.x - p.x, dz = m.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d > PUNCH_NEAR * len || d < 1e-4) return false;
  return (dx / d) * h.x + (dz / d) * h.z > PUNCH_DOT;
}
