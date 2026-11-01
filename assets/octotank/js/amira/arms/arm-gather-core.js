/* The gathered rest (Ruling 1), without THREE or Jolt. Resting, a rod's rest shape lets go of the intent chain and creeps onto
   the rod's own bends, as relaxed tissue does: the arm holds no shape of its own, so it drapes on whatever it lies on and stops shoving it. */

/* How far a resting arm's rest shape has gone over to its relaxed one: 0 awake, 1 settled, smooth between from and to of restW. */
export function gatherWeight(restW, from = 0.3, to = 0.9) {
  if (!(restW > from)) return 0;
  if (!(to > from) || restW >= to) return 1;
  const t = (restW - from) / (to - from);
  return t * t * (3 - 2 * t);
}

/* Each joint's live bend (ku, kv) from a rod's element quaternions q (x, y, z, w per element) and its root frame g, in the
   frame jointQuat builds a rest bend in: rolled by twist[j − 1], the root joint unrolled. */
export function liveBends(q, g, twist, n, out) {
  for (let j = 0; j < n; j++) {
    const a = 4 * (j - 1), b = 4 * j;
    const ax = j ? q[a] : g[0], ay = j ? q[a + 1] : g[1], az = j ? q[a + 2] : g[2], aw = j ? q[a + 3] : g[3];
    const bx = q[b], by = q[b + 1], bz = q[b + 2], bw = q[b + 3];
    const rx = aw * bx - ax * bw - ay * bz + az * by, ry = aw * by + ax * bz - ay * bw - az * bx, rz = aw * bz - ax * by + ay * bx - az * bw, rw = aw * bw + ax * bx + ay * by + az * bz;
    const dz = 1 - 2 * (rx * rx + ry * ry), dx = 2 * (rx * rz + rw * ry), dy = 2 * (ry * rz - rw * rx), h = Math.sqrt(dx * dx + dy * dy);
    if (!(h > 1e-9)) { out[2 * j] = 0; out[2 * j + 1] = 0; continue; }
    const phi = Math.atan2(h, dz), roll = j && twist ? twist[j - 1] : 0, c = Math.cos(roll), s = Math.sin(roll);
    out[2 * j] = phi * (dx * c + dy * s) / h; out[2 * j + 1] = phi * (dy * c - dx * s) / h;
  }
  return out;
}

/* R creeps a share f of the way onto the live bends L, each joint's target cut to its limit lim[j] (none when lim is null). */
export function relaxBends(R, L, lim, f, n) {
  for (let j = 0; j < n; j++) {
    let u = L[2 * j], v = L[2 * j + 1];
    if (lim) { const m = Math.sqrt(u * u + v * v); if (m > lim[j]) { u *= lim[j] / m; v *= lim[j] / m; } }
    R[2 * j] += (u - R[2 * j]) * f; R[2 * j + 1] += (v - R[2 * j + 1]) * f;
  }
  return R;
}

/* out = a + (b − a)·w per entry; w 0 copies a exactly, w 1 b. */
export function blendBends(a, b, w, out) {
  if (!(w > 0)) { if (out !== a) out.set(a); return out; }
  if (w >= 1) { if (out !== b) out.set(b); return out; }
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * w;
  return out;
}
