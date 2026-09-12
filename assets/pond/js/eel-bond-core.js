/* THREE-free half of the life bond: the graph's name math, the missing meter, and the three points a
   bout steers at. Points and headings are plain { x, z }, so all of it is testable without a renderer. */

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' && v.length ? v : '');
const pt = (p) => (p && ok(p.x) && ok(p.z) ? p : null);

export const NEAR_FILL = 0.7;    // the meter's fill rate while the couple is within farDist, as a share of apart
export const BOOP_GAP = 1.1;     // radius sums in front of the other's nose the boop point sits
export const CATCH_AT = 1.5;     // body lengths behind the lane point a follower starts hurrying
export const CATCH_UP = 1.3, EASE_OFF = 0.7;

/* Unit heading, or null for a zero-length or junk one. Every consumer treats null as "no point this
   tick" rather than handing an eel a NaN target. */
export function unitHeading(hx, hz) {
  if (!ok(hx) || !ok(hz)) return null;
  const len = Math.hypot(hx, hz);
  if (len < 1e-6) return null;
  return { x: hx / len, z: hz / len };
}

/* One key per couple, whichever way round the pair is read, so an undirected edge has one record. */
export function pairKey(a, b) {
  const x = str(a), y = str(b);
  if (!x || !y || x === y) return '';
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/* The partners of one eel who are actually in the pond right now. `lifeBond` is a name, a list of
   names, or missing; the caller adds the other direction, since either side naming the other is an edge. */
export function partnersOf(name, lifeBond, rosterNames) {
  const self = str(name);
  if (!self) return [];
  const want = typeof lifeBond === 'string' ? [lifeBond] : Array.isArray(lifeBond) ? lifeBond : [];
  const roster = rosterNames instanceof Set ? rosterNames
    : new Set(Array.isArray(rosterNames) ? rosterNames.filter((n) => str(n)) : []);
  const out = [];
  for (const raw of want) {
    const p = str(raw);
    if (!p || p === self || !roster.has(p) || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

/* The pining meter: one second per second while the gap is open, a slower trickle while they are merely
   near. Only a shared rest empties it; a drain here would let a couple who orbit each other never miss anyone. */
export function stepMissing(missing, dt, apart, nearMul = NEAR_FILL) {
  const m = ok(missing) && missing > 0 ? missing : 0;
  const step = ok(dt) && dt > 0 ? dt : 0;
  const near = ok(nearMul) && nearMul >= 0 ? nearMul : NEAR_FILL;
  return m + (apart ? step : step * near);
}

/* Where the follower swims: abreast of the leader, out to one side and however far ahead its own
   character wants to be. `side` is ±1 and picks which flank. */
export function strollPoint(leadHead, leadHeading, side, gap, ahead) {
  const l = pt(leadHead), h = leadHeading ? unitHeading(leadHeading.x, leadHeading.z) : null;
  if (!l || !h || !ok(gap)) return null;
  const s = ok(side) && side < 0 ? -1 : 1;
  const fwd = ok(ahead) ? ahead : 0;
  return {
    x: l.x + h.x * fwd + h.z * s * gap,
    z: l.z + h.z * fwd - h.x * s * gap,
  };
}

/* The snoot-boop's meeting point: just off the other eel's nose, on the line between the two heads, so
   both of them aim at the same gap and neither swims through the other. */
export function boopPoint(headOther, headSelf, rSum) {
  const o = pt(headOther), s = pt(headSelf);
  if (!o || !s || !ok(rSum)) return null;
  const dx = s.x - o.x, dz = s.z - o.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return null;
  const gap = Math.max(0, rSum) * BOOP_GAP;
  return { x: o.x + (dx / d) * gap, z: o.z + (dz / d) * gap };
}

/* The pair's pace: whoever is quicker throttles to the other, and nobody is ever asked to go faster
   than they swim. A junk or dead-stopped pair is left alone at 1. */
export function paceMul(ownBL, otherBL) {
  if (!ok(ownBL) || ownBL <= 0) return 1;
  if (!ok(otherBL) || otherBL <= 0) return 1;
  return Math.min(1, otherBL / ownBL);
}

/* Lagging or overshooting the lane point, as a scale on the follower's pace. */
export function catchUpMul(dist, len, ahead) {
  if (ahead === true) return EASE_OFF;
  if (!ok(dist) || !ok(len) || len <= 0) return 1;
  return dist > CATCH_AT * len ? CATCH_UP : 1;
}

/* A two-way weighted coin: 0 picks the first side, 1 the second. Two junk or empty weights fall back
   to an even coin rather than always answering the same way. */
export function pickWeighted(u, wA, wB) {
  const r = ok(u) && u >= 0 && u < 1 ? u : 0;
  const a = ok(wA) && wA > 0 ? wA : 0;
  const b = ok(wB) && wB > 0 ? wB : 0;
  const total = a + b;
  if (total <= 0) return r < 0.5 ? 0 : 1;
  return r * total < a ? 0 : 1;
}

/* Station-keeping behind something much longer than you: straight back off its tail, down its own axis. */
export function vigilPoint(tail, heading, gap) {
  const t = pt(tail), h = heading ? unitHeading(heading.x, heading.z) : null;
  if (!t || !h || !ok(gap)) return null;
  return { x: t.x - h.x * gap, z: t.z - h.z * gap };
}
