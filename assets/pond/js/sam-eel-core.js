/* The THREE-free half of Sam the Space Eel: the spaghettification mapping and the log-etiquette
   predicates. Pure numbers and plain objects, so the unit tests can drive them without a renderer. */

// Stretch exponent. Under 1 the gaps widen toward the horizon, which is the whole look; 0.7 is the
// shallowest curve that still reads as "thinnest at the hole" at 24 points.
export const SPAGHETTI_P = 0.7;

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/* Distance from the horizon for normalized progress u (0 head, 1 tail). Exactly 0 at the tail, strictly
   decreasing in u, and its adjacent gaps grow toward u = 1 because the exponent sits under one. */
export function spaghettiDist(u, L, p = SPAGHETTI_P) {
  const uu = Math.min(1, Math.max(0, num(u)));
  const len = Math.max(0, num(L));
  return len * Math.pow(1 - uu, num(p, SPAGHETTI_P));
}

/* Where every spine point of a swallowed chain belongs. `s` is the eaten front in u, running the meal
   from 1 to 0; anything past it has already gone through the horizon. Writes into `out` when given. */
export function spaghettiPoints(chain, mouth, dir, L, s = 1, out = null) {
  const n = chain?.length | 0;
  const res = out ?? Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0 }));
  if (!n) return res;
  const last = Math.max(1, n - 1);
  const mx = num(mouth?.x), my = num(mouth?.y), mz = num(mouth?.z);
  const dx = num(dir?.x), dy = num(dir?.y), dz = num(dir?.z);
  const front = Math.min(1, Math.max(0, num(s, 1)));
  for (let i = 0; i < n; i++) {
    const u = i / last;
    const d = u >= front ? 0 : spaghettiDist(u, L);
    const p = res[i] ?? (res[i] = { x: 0, y: 0, z: 0 });
    p.x = mx + dx * d;
    p.y = my + dy * d;
    p.z = mz + dz * d;
  }
  return res;
}

function seg2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/* Inside the bore, not merely near the wood: the inner radius is the passage a body actually occupies. */
export function insideBore(pt, log) {
  if (!pt || !log) return false;
  // The plan view alone counts every eel swimming over the bark as a tenant, so height has to agree too.
  const axisY = (num(log.a.y) + num(log.b.y)) / 2;
  if (Number.isFinite(pt.y) && Math.abs(pt.y - axisY) > num(log.rInner)) return false;
  return seg2D(num(pt.x), num(pt.z), log.a.x, log.a.z, log.b.x, log.b.z) <= num(log.rInner);
}

/* A live run's entry or exit sitting on one of this log's mouths is a claim on it. */
export function claimsLog(tunnel, log) {
  if (!tunnel || !log) return false;
  const reach = num(log.rOuter, num(log.rInner)) + 0.3;
  const at = (p) => !!p && (Math.hypot(num(p.x) - log.a.x, num(p.z) - log.a.z) <= reach ||
    Math.hypot(num(p.x) - log.b.x, num(p.z) - log.b.z) <= reach);
  return at(tunnel.entry) || at(tunnel.exit);
}

/* He never evicts and never contests, so a log is his only when nobody has run dibs on it and nobody
   is lying in it. `except` skips the guest's own body when he is already the one inside. */
export function logTaken(log, residents, except = null) {
  if (!log) return true;
  for (const r of residents ?? []) {
    if (!r || r === except) continue;
    if (claimsLog(r.tunnel, log)) return true;
    // A resident holding this log's crest perch has it too; a run or a nap beneath a napper is an eviction.
    const c = r.coverSpot;
    if (c?.type === 'ridge' && seg2D(num(c.x), num(c.z), log.a.x, log.a.z, log.b.x, log.b.z) <= num(log.rOuter, num(log.rInner)) + 0.3) return true;
    for (const p of r.pts ?? []) if (insideBore(p, log)) return true;
  }
  return false;
}

/* The lair fit test, Eleanor's: a den, not a squeeze. */
export function logFitsGuest(log, radius) {
  return !!log && num(log.rInner) >= num(radius) * 1.6;
}

/* B4's run etiquette: a resident who claims the log or climbs into it while he is still swimming to the
   approach point wins. Once he is lined up in the bore (stage 1 on) the run is committed, like a flop. */
export function runYields(tunnel, log, residents, self = null) {
  if (!tunnel || !log || (tunnel.stage | 0) !== 0) return false;
  return logTaken(log, residents, self);
}

// The tail perch: slot anchors sit this many spine points in from the tip, beside the cloud's core.
export const TAIL_SLOT_IN = 3;
export const TAIL_SLOT_GAP = 0.35;   // clear water between his flank and a napper's snout

/* Where the two nappers lie: either side of the lit tail, outside the bore he sleeps in. Walks from
   TAIL_SLOT_IN toward the tip until a point is out of the wood; null when the whole tail is inside. */
export function tailSlots(pts, radius, log, out = null) {
  const n = pts?.length | 0;
  if (n < 3) return null;
  let i = Math.max(1, n - 1 - TAIL_SLOT_IN);
  while (i < n - 1 && log && insideBore(pts[i], log)) i++;
  if (log && insideBore(pts[i], log)) return null;
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], p = pts[i];
  let tx = num(b.x) - num(a.x), tz = num(b.z) - num(a.z);
  const tl = Math.hypot(tx, tz);
  if (tl < 1e-6) { tx = 1; tz = 0; } else { tx /= tl; tz /= tl; }
  const off = num(radius) + TAIL_SLOT_GAP;
  const res = out ?? { x: 0, y: 0, z: 0, index: 0, slots: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }] };
  res.x = num(p.x); res.y = num(p.y); res.z = num(p.z); res.index = i;
  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? 1 : -1, s = res.slots[k];
    s.x = res.x - tz * side * off; s.y = res.y; s.z = res.z + tx * side * off;
  }
  return res;
}

// The self-swallow's clock: two seconds in all, the first 30% spent curling the tail round to the snout.
export const COLLAPSE = Object.freeze({ dur: 2, curl: 0.3, lead: 0.02 });

const smooth01 = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/* One sim tick of the collapse. `w` blends the frozen pose onto the loop, `s` is spaghettiPoints' eaten
   front. The tick the last point goes in is the flash tick (flash 1); the next one is 'done', flash 0. */
export function collapseStep(c, dt, dur = COLLAPSE.dur, curl = COLLAPSE.curl) {
  c.flash = 0;
  if (c.phase === 'flash' || c.phase === 'done') { c.phase = 'done'; return c; }
  c.phase = 'swallow';
  const span = num(dur, COLLAPSE.dur) > 0 ? num(dur, COLLAPSE.dur) : COLLAPSE.dur;
  const cf = Math.min(0.95, Math.max(0.05, num(curl, COLLAPSE.curl)));
  c.t = Math.min(span, num(c.t) + Math.max(0, num(dt)));
  const k = c.t / span;
  c.w = smooth01(k / cf);
  c.s = k <= cf ? 1 : Math.max(0, 1 - (k - cf) / (1 - cf));
  if (c.t >= span) { c.phase = 'flash'; c.flash = 1; c.s = 0; c.w = 1; }
  return c;
}

/* The ouroboros: spaghettiPoints' distances (`dists[i].x`, tail at zero) laid round a loop of length L
   tangent to his heading at the mouth. The head stays put, the tail curls into his own mouth first, and
   the stretch is widest where the body meets the hole. */
export function ouroborosPoints(dists, L, mouth, fwd, side, out) {
  const n = dists?.length | 0;
  const len = Math.max(1e-4, num(L));
  const R = len / (Math.PI * 2);
  let fx = num(fwd?.x), fz = num(fwd?.z);
  const fl = Math.hypot(fx, fz);
  if (fl < 1e-6) { fx = 1; fz = 0; } else { fx /= fl; fz /= fl; }
  const sd = num(side) < 0 ? -1 : 1;
  const px = -fz, pz = fx;
  const mx = num(mouth?.x), my = num(mouth?.y), mz = num(mouth?.z);
  const ox = mx + sd * R * px, oz = mz + sd * R * pz;
  const th0 = Math.atan2(mz - oz, mx - ox);
  for (let i = 0; i < n; i++) {
    const p = out[i] ?? (out[i] = { x: 0, y: 0, z: 0 });
    // Arc from the mouth, backward along his body: the head at 0, a fully drained point all the way round.
    const sigma = Math.min(len, Math.max(0, len - num(dists[i]?.x)));
    const th = th0 - sd * sigma / R;
    p.x = ox + R * Math.cos(th); p.y = my; p.z = oz + R * Math.sin(th);
  }
  // A hair ahead of the hole, so the renderer's snout-to-neck heading never collapses to zero length.
  if (n) { out[0].x = mx + fx * COLLAPSE.lead; out[0].y = my; out[0].z = mz + fz * COLLAPSE.lead; }
  return out;
}

/* Which way the loop bulges: toward the side his tail already lies on, so the curl starts as a bend. */
export function curlSide(pts, fwd) {
  const n = pts?.length | 0;
  if (n < 2) return 1;
  const h = pts[0], t = pts[n - 1];
  const cross = num(fwd?.x) * (num(t.z) - num(h.z)) - num(fwd?.z) * (num(t.x) - num(h.x));
  return cross < 0 ? -1 : 1;
}

/* Nearest of a chain to a point in xz, every `step`th point plus the tip. */
export function chainNear(pts, x, z, step = 2) {
  let best = Infinity;
  const n = pts?.length | 0, st = Math.max(1, step | 0);
  for (let i = 0; i < n; i += st) best = Math.min(best, Math.hypot(num(pts[i].x) - x, num(pts[i].z) - z));
  if (n) best = Math.min(best, Math.hypot(num(pts[n - 1].x) - x, num(pts[n - 1].z) - z));
  return best;
}

/* The lean-in's hold point: `gap` short of the finger along the line from it to his snout. */
export function leanPoint(head, finger, gap, out = { x: 0, z: 0 }) {
  let dx = num(head?.x) - num(finger?.x), dz = num(head?.z) - num(finger?.z);
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { out.x = num(head?.x); out.z = num(head?.z); return out; }
  dx /= d; dz /= d;
  const g = Math.max(0, num(gap));
  out.x = num(finger.x) + dx * g;
  out.z = num(finger.z) + dz * g;
  return out;
}

/* What a guest running steer may do: off unless the identity opts in. The numbers exist because the
   resident formulas scale with body length, and ten units of void breaks every one of them. */
export const GUEST_POLICY = Object.freeze({
  food: false,        // crumb racing, food-memory trips, the anticipation phantom
  fear: false,        // scatter, refuge contests, the overit tells
  spooks: false,      // pokes pass through: no flinch, no startle, no poke meter
  tunnels: false,     // bore runs, under the log etiquette and knobs.tunnel.samCool
  rockCover: false,   // a crevice carries a refuge id, which is what a contest locks on
  ridges: false,      // a log crest perch is a habitat claim on a log, so it takes the etiquette too
  lean: false,        // the finger lean-in: a touch on the body draws the snout in, never a flinch
  pads: true,
  naps: false,        // no hold bouts in open water; he naps in the lair
  twine: false,
  social: false,      // the crush gag and the life bond
  speedCap: 1.25,     // hard ceiling on speedBL, as a multiple of his (world-paced) cruise
  lookCap: 4,         // world units: how far the danger ring and the neighbor writers reach
  homeReach: 4,       // world units around the home anchor a wander draw lands in
  depth: [0.1, 0.15], // center height above the floor band; the top leaves room for steer's 0.07 swim bob
  airPace: 0.3,       // peek rise and creep, scaled down from a resident's body-length rate
  flopReach: 2.5,     // a voluntary flop starts only this close to the crossing
  flopLead: 0.8,      // the flop's lead-in past the bark, instead of 0.4 body lengths
  logEtiquette: true, // no flop, run, or crest perch on a log a resident claims or lies in
  leanTouch: 0.5,     // units past his flank that still count as a touch on the body
  leanKeep: 5,        // units from his snout: a finger farther than this has left him
  leanGap: 2,         // body radii between the finger and his snout while he holds
  defer: false,       // B5: a crumb nobody wants after samDefer seconds is his, pulled in through the singularity
  sweep: false,       // B5: crossing a duckweed mat opens the small singularity and sucks the specks in
});

// B5's two small meals, in units and seconds. The horizon scales are body radii, as the renderer reads them.
export const MEALS = Object.freeze({
  crumbHorizon: 0.4, sweepHorizon: 0.6,
  crumbReach: 0.9,     // the crumb-scale singularity opens this close, in xz, from his snout
  crumbPull: 0.5,      // seconds from the opening to the horizon
  crumbTurn: 3,        // radians of the crumb's spiral: 12 rad/s at the horizon under the u² ease
  crumbGiveUp: 20,     // seconds of approach before he lets a crumb go for good
  crumbStretch: [1.6, 0.6],   // along and across the pull
  deferReach: 2,       // a resident this close and heading at the crumb still wants it
  deferHeading: 0.5,   // cosine of the widest angle that still counts as heading at it
  sweepGrace: 0.6,     // seconds the mouth stays open past the last mat contact, so a ragged edge is one crossing
});

/* A live claim: the counter, or a resident actually holding the crumb in case the counter drifted. This
   alone is what makes him stand down mid-approach; a resident merely passing by does not. */
export function crumbClaimed(crumb, residents) {
  if (!crumb) return false;
  if (num(crumb.claims) > 0) return true;
  for (const r of residents ?? []) if (r && !r.slurpedBy && r.food === crumb) return true;
  return false;
}

/* Whether anyone still wants a landed crumb: a claim, or a resident within `reach` heading at it. */
export function crumbWanted(crumb, residents, reach = MEALS.deferReach, cosHead = MEALS.deferHeading) {
  if (!crumb) return false;
  if (crumbClaimed(crumb, residents)) return true;
  for (const r of residents ?? []) {
    if (!r || r.slurpedBy) continue;
    const dx = num(crumb.x) - num(r.head?.x), dz = num(crumb.z) - num(r.head?.z);
    const d = Math.hypot(dx, dz);
    if (d > reach) continue;
    if (d < 1e-4 || (num(r.heading?.x) * dx + num(r.heading?.z) * dz) / d >= cosHead) return true;
  }
  return false;
}

/* The defer clock, one per crumb on the sim clock: reset by any want, first stamped at the splash. Returns
   how long the crumb has sat unwanted. */
export function deferClock(crumb, now, wanted) {
  if (!Number.isFinite(crumb.samIdle) || wanted) crumb.samIdle = wanted ? now : num(crumb.landedAt, now);
  return now - crumb.samIdle;
}

/* The defer predicate: a landed crumb on open water, uneaten, unwanted for `defer` seconds. */
export function deferReady(crumb, now, residents, defer = 4) {
  if (!crumb || !(num(crumb.amount) > 0) || crumb.airborne || crumb.onPad || crumb.samRefused) return false;
  const wanted = crumbWanted(crumb, residents);
  return deferClock(crumb, now, wanted) >= defer && !wanted;
}

/* The accretion spiral (S4 item 4): the radius closes to the horizon as 1 − u² while the angle turns as u²,
   so it spins up on the way down and sits exactly on the horizon at t = T. */
export function spiralStart(px, pz, cx, cz, turn, out = {}) {
  out.r0 = Math.hypot(num(px) - num(cx), num(pz) - num(cz));
  out.a0 = Math.atan2(num(pz) - num(cz), num(px) - num(cx));
  out.turn = num(turn);
  return out;
}

export function spiralAt(cap, t, T, cx, cz, rh, out = {}) {
  const span = num(T) > 0 ? num(T) : 0.5;
  const u = Math.min(1, Math.max(0, num(t) / span)), u2 = u * u;
  const r1 = Math.max(0, num(rh));
  // Already inside the hole: it turns where it is rather than being pushed back out to the rim.
  const r0 = Math.max(0, num(cap.r0));
  out.r = r0 <= r1 ? r0 : r1 + (r0 - r1) * (1 - u2);
  out.a = num(cap.a0) + num(cap.turn) * u2;
  out.x = num(cx) + Math.cos(out.a) * out.r;
  out.z = num(cz) + Math.sin(out.a) * out.r;
  out.u = u;
  out.done = u >= 1;
  return out;
}

/* Where the horizon sits: half a radius ahead of the snout, as the renderer places the black sphere. */
export function horizonAt(head, heading, radius, out = {}) {
  out.x = num(head?.x) + num(heading?.x) * num(radius) * 0.5;
  out.y = num(head?.y);
  out.z = num(head?.z) + num(heading?.z) * num(radius) * 0.5;
  return out;
}

/* Which spine points stand in open water: not hidden, not in the wood of any bore. The drop-through, the
   rain stars, and the vacuum all read this one mask, so a body in a log is covered by the bark. */
export function openMask(pts, logs, open, out) {
  const n = pts?.length | 0;
  const m = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let o = open ? 1 : 0;
    if (o) for (const l of logs ?? []) if (num(l.rInner) > 0 && insideBore(pts[i], l)) { o = 0; break; }
    m[i] = o;
  }
  return m;
}

/* The nearest open stretch of his spine to (x, z) within `reach`, as the closest point on a segment between
   two open neighbors (a lone open point counts too). `minY` keeps only what reaches the film, for rain. */
export function drainPoint(pts, mask, x, z, reach, out = null, minY = -Infinity) {
  const n = pts?.length | 0;
  let best = reach, hit = false;
  const res = out ?? { x: 0, y: 0, z: 0, d: 0 };
  for (let i = 0; i < n; i++) {
    if (!mask?.[i]) continue;
    const a = pts[i];
    const b = i + 1 < n && mask[i + 1] ? pts[i + 1] : a;
    const ay = num(a.y), by = num(b.y);
    if (ay < minY && by < minY) continue;
    // Clip to the stretch at or above minY: a peek lifts the head, not the neck the segment dips into.
    let t0 = 0, t1 = 1;
    if (ay < minY) t0 = (minY - ay) / (by - ay);
    else if (by < minY) t1 = (minY - ay) / (by - ay);
    const ex = num(b.x) - num(a.x), ez = num(b.z) - num(a.z), l2 = ex * ex + ez * ez;
    const t = l2 > 1e-12 ? Math.max(t0, Math.min(t1, ((x - num(a.x)) * ex + (z - num(a.z)) * ez) / l2)) : t0;
    const qx = num(a.x) + ex * t, qz = num(a.z) + ez * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d > best) continue;
    best = d; hit = true;
    res.x = qx; res.z = qz; res.y = num(a.y) + (num(b.y) - num(a.y)) * t; res.d = d;
  }
  return hit ? res : null;
}

const posNum = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

/* Frozen, built once per identity. `guestSteer: true` takes the defaults; an object overrides them key
   by key, and anything malformed falls back to the default rather than into a gate. */
export function buildGuestPolicy(id) {
  const s = id?.guestSteer;
  if (!s) return null;
  const over = s === true ? {} : s;
  if (typeof over !== 'object') return null;
  const p = { ...GUEST_POLICY };
  for (const k of Object.keys(GUEST_POLICY)) {
    if (!(k in over)) continue;
    const d = GUEST_POLICY[k], v = over[k];
    if (typeof d === 'boolean') p[k] = typeof v === 'boolean' ? v : d;
    else if (Array.isArray(d)) {
      const ok = Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[0] >= 0 && v[0] <= v[1];
      p[k] = ok ? [v[0], v[1]] : d;
    } else p[k] = posNum(v, d);
  }
  p.depth = Object.freeze(p.depth.slice());
  return Object.freeze(p);
}
