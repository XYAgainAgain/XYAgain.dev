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

export const LEAP_G = 3;   // stylized gravity; the real number sends the eel out of frame

/* apexY is measured from the film and y0 sits just under it, so the rise is always positive and the
   sqrt never sees a negative even if a caller hands in a silly form. */
export function leapArc(leapSkill, formHeight, y0, g = LEAP_G) {
  const fh = Number.isFinite(formHeight) && formHeight > 0 ? formHeight : 1;
  const apexY = (0.35 + 0.25 * clamp01(leapSkill)) * fh;
  const rise = Math.max(1e-4, apexY - (Number.isFinite(y0) ? y0 : 0));
  const v = Math.sqrt(2 * g * rise);
  return { apexY, v, T: 2 * v / g, g };
}

export function leapDistance(length, formDistance) { return 1.2 * length * formDistance; }

export function segDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const ox = px - ax - dx * t, oz = pz - az - dz * t;
  return ox * ox + oz * oz;
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
