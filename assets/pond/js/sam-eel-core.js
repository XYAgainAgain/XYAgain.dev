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
    for (const p of r.pts ?? []) if (insideBore(p, log)) return true;
  }
  return false;
}

/* The lair fit test, Eleanor's: a den, not a squeeze. */
export function logFitsGuest(log, radius) {
  return !!log && num(log.rInner) >= num(radius) * 1.6;
}
