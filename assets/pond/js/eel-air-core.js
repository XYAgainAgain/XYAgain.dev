/* The air states' pure math: the moon mood curve, the leap's ballistics, the landing clearance test,
   and the nose-first burrow's closure front. No THREE, no pond, so the unit tests can sweep it in Node. */

/* NaN clamps to 0 rather than through: this gate sits upstream of sqrt, of the moon curve's power,
   and of every trigger rate, and a NaN there poisons an eel's whole night. */
export function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* A live knob or multiplier: any finite non-negative number, otherwise the default. Not finite01,
   because knobs.air.leap = 3 is a legitimate "leap three times as often". */
export function knob(v, fallback = 1) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/* A guest's air gate. `true` admits every state, an array only its own, anything else none. The state
   is required: an omitted one is a caller bug, never "any", so it throws under debug and refuses otherwise. */
export function airAllows(list, state, strict = false) {
  if (typeof state !== 'string' || !state) {
    if (strict) throw new Error('[air] a guest air check was made without naming the state');
    return false;
  }
  if (list === true) return true;
  return Array.isArray(list) && list.includes(state);
}

/* Brightness from the orbit clock, per eel. The wrap and the max() are load-bearing: an unwrapped
   offset takes sin negative at the boundary, and a negative base to the 1.5 power is NaN. */
export function moonBrightAt(phase01, moonOff = 0, pin = null) {
  if (typeof pin === 'number' && Number.isFinite(pin)) return clamp01(pin);
  const raw = typeof phase01 === 'number' && Number.isFinite(phase01) ? phase01 : 0;
  const off = typeof moonOff === 'number' && Number.isFinite(moonOff) ? moonOff : 0;
  const p = (((raw + off) % 1) + 1) % 1;
  return clamp01(0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(Math.PI * p)), 1.5));
}

/* Form is wits, will is `leap`: a dim eel jumps lower and further and lands on its belly. */
export function leapForm(wits) {
  const w = typeof wits === 'number' && Number.isFinite(wits) ? wits : 0.5;
  return w < 0.4 ? { formHeight: 0.6, formDistance: 1.3, belly: true } : { formHeight: 1, formDistance: 1, belly: false };
}

export const LEAP_G = 3;   // the pre-plan gravity; the live one is knobs.air.leapG
// knobs.air's defaults for the arc and the follow-through; eels.js spreads these into its block.
export const LEAP_KNOBS = Object.freeze({ leapApex: 1.5, leapApexPersonal: 0.12, leapApexSpread: 0.25, leapG: 3.4, followThrough: 1 });
// Seconds above the film no leap may pass: ready() refuses past 2 s of stamina, and this keeps a tuned
// arc from ever reaching it. Gravity rises to meet it; the landing distance never moves.
export const AIRTIME_CAP = 1.9;
export const ARC_SALT = 3150;   // + slot index: the per-leap apex draws, and the identity hash's salt

/* apexY is measured from the film and y0 sits just under it, so the rise is always positive and the
   sqrt never sees a negative even if a caller hands in a silly form. */
export function leapArc(leapSkill, formHeight, y0, g = LEAP_G, apexMul = 1) {
  const fh = Number.isFinite(formHeight) && formHeight > 0 ? formHeight : 1;
  const m = Number.isFinite(apexMul) && apexMul > 0 ? apexMul : 1;
  const apexY = (0.35 + 0.25 * clamp01(leapSkill)) * fh * m;
  const g0 = Number.isFinite(g) && g > 0 ? g : LEAP_G;
  // Airtime above y = 0 is 2·sqrt(2·apexY/g): the smallest g under the cap, handed back so v and T agree.
  const gEff = Math.max(g0, 8 * apexY / (AIRTIME_CAP * AIRTIME_CAP));
  const rise = Math.max(1e-4, apexY - (Number.isFinite(y0) ? y0 : 0));
  const v = Math.sqrt(2 * gEff * rise);
  return { apexY, v, T: 2 * v / gEff, g: gEff };
}

/* The seconds the head spends above y = 0, which is what the stamina counter charges. */
export function leapAirtime(arc) {
  const a = arc?.apexY, g = arc?.g;
  if (!Number.isFinite(a) || !(a > 0) || !Number.isFinite(g) || !(g > 0)) return 0;
  return 2 * Math.sqrt(2 * a / g);
}

/* A name's fixed hopping style in [-1, 1]: FNV-1a folded with the salt, then one Mulberry32 step. No
   stream and no seed, so an eel keeps its style across nights, slots, and swaps. */
export function nameUnit(name, salt = ARC_SALT) {
  if (typeof name !== 'string' || !name) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  let a = (h ^ Math.imul(salt | 0, 0x9E3779B1)) + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
}

/* leapApex × personal × perLeap. a + b − 1 is triangular on [-1, 1], so the extremes are rarer than
   the middle. Each factor floors at 0.1: a spread knob past 1 must not turn a leap upside down. */
export function leapApexMul(uId, a, b, apex = LEAP_KNOBS.leapApex, personal = LEAP_KNOBS.leapApexPersonal, spread = LEAP_KNOBS.leapApexSpread) {
  const u = Number.isFinite(uId) ? Math.max(-1, Math.min(1, uId)) : 0;
  const w = (Number.isFinite(a) ? clamp01(a) : 0.5) + (Number.isFinite(b) ? clamp01(b) : 0.5) - 1;
  const c = Number.isFinite(apex) && apex > 0 ? apex : LEAP_KNOBS.leapApex;
  const p = Number.isFinite(personal) && personal >= 0 ? personal : 0;
  const s = Number.isFinite(spread) && spread >= 0 ? spread : 0;
  return c * Math.max(0.1, 1 + p * u) * Math.max(0.1, 1 + s * w);
}

/* Exactly two draws, whatever the knobs say, so a retuned spread never shifts later leaps' rolls. */
export function drawApexMul(rng, uId, apex, personal, spread) {
  const a = rng.next(), b = rng.next();
  return leapApexMul(uId, a, b, apex, personal, spread);
}

export function leapDistance(length, formDistance) { return 1.2 * length * formDistance; }

/* The share of 24 spine points above the film when the head is `progress` of the way along a leap's
   ground distance (1 is the landing), with the body sliding along the head's path in 3D. */
export function airborneFraction(progress, L, apex, r = 0.1, n = 24) {
  if (![progress, L, apex, r].every(Number.isFinite) || !(L > 0) || !(n >= 2)) return 0;
  const y0 = -0.5 * r, D = 1.2 * L, sp = L / (n - 1);
  const y = (s) => (s <= 0 || s >= D ? y0 : y0 + 4 * (apex - y0) * (s / D) * (1 - s / D));
  const ds = Math.min(0.002, sp / 20);
  let s = progress * D, py = y(s), walked = 0, up = py > 0 ? 1 : 0, i = 1;
  while (i < n) {
    s -= ds;
    const ny = y(s);
    walked += Math.hypot(ds, ny - py);
    py = ny;
    while (i < n && walked >= i * sp) { if (ny > 0) up++; i++; }
  }
  return up / n;
}

export function segDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const ox = px - ax - dx * t, oz = pz - az - dz * t;
  return ox * ox + oz * oz;
}

/* Squared distance between segments ab and cd in the plane: zero if they cross, otherwise the nearest
   endpoint-to-segment pair. Zero-length, parallel, and touching segments all fall through correctly. */
export function segSegDistSq(ax, az, bx, bz, cx, cz, dx, dz) {
  const cross = (ox, oz, px, pz, qx, qz) => (px - ox) * (qz - oz) - (pz - oz) * (qx - ox);
  const d1 = cross(cx, cz, dx, dz, ax, az), d2 = cross(cx, cz, dx, dz, bx, bz);
  const d3 = cross(ax, az, bx, bz, cx, cz), d4 = cross(ax, az, bx, bz, dx, dz);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(
    segDistSq(ax, az, cx, cz, dx, dz), segDistSq(bx, bz, cx, cz, dx, dz),
    segDistSq(cx, cz, ax, az, bx, bz), segDistSq(dx, dz, ax, az, bx, bz),
  );
}

/* The lowest a point of radius r may sit at horizontal distance d from a rock and clear its envelope:
   the same inflated ellipsoid collide() pushes against, read from above. -Infinity when beside it. */
export function rockClearY(s, d, r) {
  const sr = s.rHit ?? s.r, ry = s.ryHit ?? sr, R = sr + r;
  if (!(d < R) || !(sr > 0)) return -Infinity;
  return s.y + Math.sqrt(R * R - d * d) * ry / sr;
}

/* The same for a log wall: a circle of rOuter + r around the axis. A hollow log's open mouths are not
   walls (collide() skips them), so past either end only a solid stub's rounded tip counts. */
export function logClearY(l, x, z, r) {
  const ax = l.b.x - l.a.x, az = l.b.z - l.a.z, l2 = ax * ax + az * az || 1e-9;
  const t = ((x - l.a.x) * ax + (z - l.a.z) * az) / l2;
  if (l.rInner > 0 && (t <= 0 || t >= 1)) return -Infinity;
  const tc = Math.max(0, Math.min(1, t));
  const dx = x - l.a.x - ax * tc, dz = z - l.a.z - az * tc, R = l.rOuter + r, d2 = dx * dx + dz * dz;
  if (!(d2 < R * R)) return -Infinity;
  return l.a.y + (l.b.y - l.a.y) * tc + Math.sqrt(R * R - d2);
}

/* How high a leaping head must be at (x, z) to pass over everything there. The flight holds at least
   this, so a leap whose arc would pass through a raised log or rock hops it instead of stalling. */
export function hopClearY(x, z, r, spheres = [], logs = []) {
  let y = -Infinity;
  for (const s of spheres) { const c = rockClearY(s, Math.hypot(x - s.x, z - s.z), r); if (c > y) y = c; }
  for (const l of logs) { const c = logClearY(l, x, z, r); if (c > y) y = c; }
  return y;
}

/* How far a capsule of radius r can sweep along (hx, hz), up to len, before touching a rock, a log
   wall, or the inset box. The sweep only grows, so each collider's first hit is found by bisection. */
export function followClear(x, z, hx, hz, len, r, spheres = [], logs = [], limX = Infinity, limZ = Infinity, minY = -Infinity) {
  if (![x, z, hx, hz, len, r].every(Number.isFinite) || !(len > 0)) return 0;
  const hl = Math.hypot(hx, hz);
  if (!(hl > 1e-9)) return 0;
  const ux = hx / hl, uz = hz / hl;
  if (Math.abs(x) > limX || Math.abs(z) > limZ) return 0;
  let cap = len;
  if (ux > 1e-9) cap = Math.min(cap, (limX - x) / ux); else if (ux < -1e-9) cap = Math.min(cap, (-limX - x) / ux);
  if (uz > 1e-9) cap = Math.min(cap, (limZ - z) / uz); else if (uz < -1e-9) cap = Math.min(cap, (-limZ - z) / uz);
  const first = (hit) => {
    if (hit(0)) return 0;
    if (!hit(cap)) return cap;
    let lo = 0, hi = cap;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) * 0.5; if (hit(m)) hi = m; else lo = m; }
    return lo;
  };
  for (const s of spheres) {
    const sr = s.rHit ?? s.r, rr = sr + r;
    // Wholly under the run's lowest point (minY); a surface-band rock is a column to a swimmer, never skipped.
    if (s.y + sr <= -r * 2 && rockClearY(s, 0, r) <= minY) continue;
    cap = first((t) => segDistSq(s.x, s.z, x, z, x + ux * t, z + uz * t) < rr * rr);
    if (cap <= 0) return 0;
  }
  for (const l of logs) {
    const rr = l.rOuter + r;
    if (Math.max(l.a.y ?? 0, l.b.y ?? 0) + rr <= minY) continue;
    cap = first((t) => segSegDistSq(x, z, x + ux * t, z + uz * t, l.a.x, l.a.z, l.b.x, l.b.z) < rr * rr);
    if (cap <= 0) return 0;
  }
  return Math.max(0, cap);
}

/* Validated from the actual launch position, with an r margin: inflated rocks, log walls (stubs are
   ordinary entries with rOuter), and the same 0.7 view line the wander force turns back at. */
export function landingClear(x, z, r, spheres = [], logs = [], limX = Infinity, limZ = Infinity) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (Math.abs(x) > limX || Math.abs(z) > limZ) return false;
  for (const s of spheres) {
    const rr = (s.rHit ?? s.r) + r;
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz < rr * rr) return false;
  }
  for (const l of logs) {
    const rr = l.rOuter + r;
    if (segDistSq(x, z, l.a.x, l.a.z, l.b.x, l.b.z) < rr * rr) return false;
  }
  return true;
}

/* The flop's semicircle, read off the signed crossing coordinate s. The radius is rOuter + r rather
   than rOuter (they agree at the crest) because the wider circle keeps the head outside the collider
   on the way in; a path that only starts climbing at |s| = rOuter stalls on the near flank. */
export function crestHeight(s, rOuter, crestY, r) {
  const R = rOuter + r;
  const a = Math.min(Math.abs(s), R);
  return crestY - rOuter + Math.sqrt(Math.max(0, R * R - a * a));
}

/* The lowest a point may sit once the dig lets go: the flat floor plus its shoal mound, capped under
   the ceiling exactly like the solver's mound ride, so a tall crest cannot demand the impossible. */
export function burrowClearY(floor, ceil, r, mound) {
  return Math.min(floor + Math.max(0, mound), ceil - r * 0.5);
}

/* The released floor, lowered by the worst point's deficit and walked back up as k runs 0 → 1, so a
   tail still inside a mound at the deadline climbs out over the lift instead of popping in one tick. */
export function liftFloor(base, gap0, k) {
  return base + (Number.isFinite(gap0) ? Math.min(0, gap0) : 0) * (1 - clamp01(k));
}

// The nose-first burrow

export const BURY_SOFT = 2;    // spine points the sand takes to close: the collar around the hole
export const BURY_FLOOR = 1.9; // the solver's own sand floor, in radii; a run below it reads as a stall
// The cap keeps the tube's top 0.4 radii under the analytic sand: the floor mesh is triangulated, and a
// body grazing it pokes its ring joints through in flickering slivers as it wiggles.
export const BURY_CAP = 1.4, BURY_DEPTH = 1.6;

/* Point i of the chain trails the snout by i × spacing, so the arc the head has covered since the
   snout went under is, measured in point indices, exactly how far back the sand has closed. */
export function burrowFront(adv, spacing) {
  if (!Number.isFinite(adv) || adv < 0) return 0;
  if (!Number.isFinite(spacing) || !(spacing > 1e-6)) return 0;
  return adv / spacing;
}

/* How buried point i is: 1 well behind the front, 0 ahead of it, a ramp across the collar. A soft of
   0 is a hard line, which is what a caller asking for no collar means. */
export function buryWeight(i, front, soft = BURY_SOFT) {
  if (!Number.isFinite(i) || !Number.isFinite(front) || front < 0) return 0;
  const s = Number.isFinite(soft) ? soft : BURY_SOFT;
  if (!(s > 0)) return i <= front ? 1 : 0;
  return clamp01((front - i) / s);
}

/* A burrowed body runs this far under the local sand, in radii, capped clear of the solver's floor. */
export function buryDepth(v) {
  const d = Number.isFinite(v) && v > 0 ? v : BURY_DEPTH;
  return Math.min(d, BURY_FLOOR - 0.05);
}

/* Which spine points heave the sand and by how much. A point still in the water stamps nothing, so
   the mound only ever grows tailward behind the snout. `out` is reused; the return is its length. */
export function digStamps(pts, front, o, out = []) {
  const ridge = o?.ridge, sandAt = o?.sandAt;
  if (!Array.isArray(pts) && !pts?.length) return 0;
  if (!Number.isFinite(front) || front < 0) return 0;
  if (!Number.isFinite(ridge) || !(ridge > 0) || typeof sandAt !== 'function') return 0;
  const step = Math.max(1, Math.floor(o?.step ?? 1) || 1);
  let n = 0;
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    const w = buryWeight(i, front, o?.soft);
    if (!(w > 0) || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const sand = sandAt(p.x, p.z);
    if (!Number.isFinite(sand) || !Number.isFinite(p.y) || p.y > sand) continue;
    const s = (out[n] ??= { x: 0, z: 0, h: 0 });
    s.x = p.x; s.z = p.z; s.h = ridge * w;
    n++;
  }
  return n;
}
