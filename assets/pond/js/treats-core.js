/* THREE-free ballistics for the falling crumb. Nothing here rolls a die: every quantity comes off the
   simulation clock, the cursor history, or a hash of the crumb's own dropId, so a replay reproduces. */

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/* One toss, solved once at spawn. Gravity is the knob, not 9.8: real gravity at pond scale drops the
   crumb in under two tenths of a second and reads as a teleport. */
export function flightFor(x, z, vx, vz, h, g) {
  // A non-finite launch or velocity is not a flight to be salvaged into one at the origin; it voids.
  // Height and gravity are knobs rather than inputs, so those keep their sane floors.
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(vx) || !Number.isFinite(vz)) return null;
  const h0 = Math.max(1e-4, num(h));
  const gg = Math.max(1e-4, num(g, 1));
  const tFall = Math.sqrt((2 * h0) / gg);
  return {
    tFall, h0, g: gg, vx, vz,
    x: x + vx * tFall,
    z: z + vz * tFall,
    vHoriz: Math.hypot(vx, vz),
    vFall: Math.sqrt(2 * gg * h0),
  };
}

/* The hand's speed over the whole buffered window. input.js zeroes the live snapshot's vx/vz at the
   moment of a press, so the first crumb of a click has to read the ticks from just before it. */
export function recentFingerSpeed(vHist) {
  if (!Array.isArray(vHist) || vHist.length < 2) return { vx: 0, vz: 0 };
  const a = vHist[0], b = vHist[vHist.length - 1];
  const span = num(b?.t) - num(a?.t);
  if (!(span > 1e-6)) return { vx: 0, vz: 0 };
  return { vx: (num(b.x) - num(a.x)) / span, vz: (num(b.z) - num(a.z)) / span };
}

/* One cursor sample per fixed tick. A second write on the same tick corrects that tick's sample in
   place rather than adding one, which is how a replayed gesture overrides the live sample under it. */
export function pushFingerSample(out, x, z, t, want) {
  const cap = Math.max(2, Math.min(32, (want | 0) || 6));
  const last = out.length ? out[out.length - 1] : null;
  if (last && last.t === t) { last.x = x; last.z = z; }
  else out.push({ x, z, t });
  while (out.length > cap) out.shift();
  return out;
}

/* Rewrite a history so recentFingerSpeed reads back exactly (vx, vz). The recorded-input vocabulary
   has no pre-press hover sample, so a replayed fast click has to be handed its velocity outright. */
export function seedFingerHistory(out, x, z, vx, vz, t, span) {
  const s = Math.max(1e-6, num(span, 1e-6));
  const px = num(x), pz = num(z), dx = num(vx), dz = num(vz), now = num(t);
  out.length = 0;
  out.push({ x: px - dx * s, z: pz - dz * s, t: now - s });
  out.push({ x: px, z: pz, t: now });
  return out;
}

/* Ground point → shadow point, away from the moon. treats.js mirrors this in TSL so the offset stays
   smooth between fixed ticks; this copy is the CPU reference the unit test pins. */
export function shadowOffset(h, moonX, moonZ, elev) {
  const tan = Math.tan(num(elev, Math.PI / 4));
  const mx = num(moonX), mz = num(moonZ);
  const m = Math.hypot(mx, mz);
  if (!(m > 1e-6) || !(Math.abs(tan) > 1e-6)) return { dx: 0, dz: 0 };
  const len = Math.max(0, num(h)) / tan;
  return { dx: (-mx / m) * len, dz: (-mz / m) * len };
}

/* The pool is the sim's real box, twice the view: a hard flick landing off-screen is an ordinary crumb
   sitting where nobody is looking. Only past the pool does the treat stop existing at all. */
export function clampImpact(pool, x, z) {
  const hw = Math.max(0, num(pool?.hw)), hh = Math.max(0, num(pool?.hh));
  const ok = Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) <= hw && Math.abs(z) <= hh;
  return { x, z, ok };
}

/* Where a doomed trajectory crosses the pool wall, so the far-off plip comes from the boundary rather
   than from wherever the arithmetic said it would have landed. */
export function poolExit(pool, x, z, vx, vz, tMax) {
  const hw = Math.max(0, num(pool?.hw)), hh = Math.max(0, num(pool?.hh));
  const px = num(x), pz = num(z), dx = num(vx), dz = num(vz);
  const span = Math.max(0, num(tMax));
  if (Math.abs(px) > hw || Math.abs(pz) > hh) return { x: px, z: pz, t: 0 };
  let t = Infinity;
  if (Math.abs(dx) > 1e-9) {
    const a = (hw - px) / dx, b = (-hw - px) / dx;
    if (a > 0 && a < t) t = a;
    if (b > 0 && b < t) t = b;
  }
  if (Math.abs(dz) > 1e-9) {
    const a = (hh - pz) / dz, b = (-hh - pz) / dz;
    if (a > 0 && a < t) t = a;
    if (b > 0 && b < t) t = b;
  }
  if (!(t <= span)) return null;
  return { x: px + dx * t, z: pz + dz * t, t };
}

/* A crumb's silhouette goes as the two-thirds power of its mass, so a click treat (1) reads about
   twice a held one (0.35). The falling sprite and the landed mesh both size from this, or the crumb
   changes size at the splash; the floor keeps a nearly eaten one visible. */
export function crumbScale(amount) {
  return Math.max(0.2, Math.pow(Math.max(0, Math.min(1, num(amount, 1))), 2 / 3));
}

/* Three real outcomes on a lily pad, gated by how the crumb arrives rather than by a die roll: the
   fall speed is the same for every crumb, so horizontal speed alone says steep, glancing, or flat. */
export function padContact(vHoriz, padBounceV, padRestV) {
  const v = Math.max(0, num(vHoriz));
  if (v > num(padBounceV, 1.2)) return 'bounce';
  if (v > num(padRestV, 0.3)) return 'roll';
  return 'rest';
}

/* The sprite's only random-looking quantity. Hashed off dropId rather than drawn from an rng stream,
   so the number of treats in the air can never shift another system's draws. */
export function tumbleFor(dropId) {
  let h = Math.imul(num(dropId) | 0, 0x27d4eb2d) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  const a = (h >>> 0) / 4294967296;
  const b = (Math.imul(h ^ 0x5bf03635, 0xc2b2ae35) >>> 0) / 4294967296;
  return { phase: a * Math.PI * 2, rate: 1.2 + b * 2.4 };
}
