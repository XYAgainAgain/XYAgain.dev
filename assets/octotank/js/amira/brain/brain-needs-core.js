import { METERS, lineTable } from './brain-tuning-core.js';

/* Her six meters as pure functions over a plain { meter: value } object: drift, line crossings, and need pressure. */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const isAsleep = (sleep) => sleep === 'half' || sleep === 'full';

export function freshMeters(T) {
  const m = {};
  for (const k of METERS) m[k] = T.start[k];
  return m;
}

/* Clamped 0–1; returns what actually changed, 0 for a non-finite delta. */
export function applyDelta(m, meter, d) {
  if (!Number.isFinite(d) || !(meter in m)) return 0;
  const v = m[meter], next = clamp01(v + d);
  m[meter] = next;
  return next - v;
}

/* Never below pressureFloor; the curve per meter is in the tuning. */
export function pressure(meter, value, T) {
  const gap = 1 - clamp01(value), f = T.pressureFloor;
  return T.curve[meter] === 'square' ? f + (1 - f) * gap * gap : f + (1 - f) * gap;
}

/* Pressure on every meter, times the relief multiplier of each active line. */
export function pressures(m, flags, T, rows = lineTable(T), out = {}) {
  for (const k of METERS) out[k] = pressure(k, m[k], T);
  for (const id in rows) if (rows[id].relief && flags[id]) out[rows[id].meter] *= rows[id].relief;
  return out;
}

/* Updates `flags` in place: a line enters below its value (at or below for an inclusive one) and holds until the meter
   is back at its clear point. Contentment mirrors it upward. */
export function updateLines(m, flags, T, rows = lineTable(T)) {
  for (const id in rows) {
    const r = rows[id], v = m[r.meter];
    flags[id] = flags[id] ? v < r.clear : r.inclusive ? v <= r.at : v < r.at;
  }
  const up = T.content.above, down = up - T.clearGap;
  flags.content = flags.content ? m.fullness >= down && m.energy >= down : m.fullness > up && m.energy > up;
  return flags;
}

/* Any meter past a hard or crisis line. */
export function pastRedLine(flags, rows) {
  for (const id in rows) if (rows[id].level !== 'soft' && flags[id]) return true;
  return false;
}

/* What the clock alone does over dt seconds. state: sleep ('awake', 'curled', 'half', 'full'), crawl 0–1, target (the
   place's comfort target), displaying. Passive floors stop drift, never real events. */
export function driftDeltas(m, dt, state, T, out = {}) {
  const min = dt / 60, asleep = isAsleep(state.sleep);
  for (const k in T.drift) {
    const v = m[k], floor = T.floor[k] ?? 0;
    out[k] = (asleep && T.awakeOnly.includes(k)) || v <= floor ? 0 : Math.max(floor, v + T.drift[k] * min) - v;
  }
  const E = T.energy, s = state.sleep;
  const rate = s === 'full' ? E.full : s === 'half' ? E.half : s === 'curled' ? E.curled
    : (E.awake + E.crawl * clamp01(state.crawl ?? 0)) * (state.displaying ? E.display : 1);
  out.energy = clamp01(m.energy + rate * min) - m.energy;
  const target = state.target ?? T.comfort.targets.ordinary;
  out.comfort = target + (m.comfort - target) * Math.pow(0.5, dt / T.comfort.halfLife) - m.comfort;
  return out;
}

/* Social lift halves every halfLife without company; with it, Julia's relaxed time adds up to juliaPerMin. */
export function liftStep(lift, dt, company, T) {
  if (company === 'julia') return clamp01(lift + T.lift.juliaPerMin * dt / 60);
  if (company) return lift;
  return lift * Math.pow(0.5, dt / T.lift.halfLife);
}
