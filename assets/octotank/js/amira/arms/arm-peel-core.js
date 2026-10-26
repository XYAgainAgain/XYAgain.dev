/* How a sealed arm lets go (Gracefulness Plan, item 2), THREE-free: the two stretch measures, the emergency release's
   timing, the tip-first ripple's order, and drag relax's per-segment lengthening. arms.js drives the rod's peel with them. */

/* Anatomical elongation: the chain X's arc from the root to point i over that span's unextended rest length, the 1.5×
   anyone watching sees. 1 when degenerate. */
export function anatStretch(X, len0, i) {
  let x = 0, r = 0;
  for (let j = 0, p = 0; j < i; j++, p += 3) {
    x += Math.hypot(X[p + 3] - X[p], X[p + 4] - X[p + 1], X[p + 5] - X[p + 2]);
    r += len0[j];
  }
  const s = x / r;
  return r > 1e-9 && Number.isFinite(s) ? s : 1;
}

/* anatStretch at every point i of an n-point chain into out, in one pass. */
export function anatSpans(X, len0, n, out) {
  let x = 0, r = 0;
  out[0] = 1;
  for (let i = 1, p = 0; i < n; i++, p += 3) {
    x += Math.hypot(X[p + 3] - X[p], X[p + 4] - X[p + 1], X[p + 5] - X[p + 2]);
    r += len0[i - 1];
    out[i] = r > 1e-9 && Number.isFinite(x / r) ? x / r : 1;
  }
  return out;
}

/* Both measures at the far point of every segment j whose sealed[j] is set, the worst of each, in one pass: unexpected
   strain (arc over the intent chain I's, so a commanded elongation cancels) into out[0], anatomical into out[1], and the
   segment of the worst anatomical span into out[2] (-1 with none). */
export function worstStretches(X, I, len0, sealed, S, out) {
  let x = 0, y = 0, r = 0, ws = 1, wa = 1, ja = -1;
  for (let j = 0, p = 0; j < S; j++, p += 3) {
    x += Math.hypot(X[p + 3] - X[p], X[p + 4] - X[p + 1], X[p + 5] - X[p + 2]);
    y += Math.hypot(I[p + 3] - I[p], I[p + 4] - I[p + 1], I[p + 5] - I[p + 2]);
    r += len0[j];
    if (!sealed[j]) continue;
    if (y > 1e-6 && x / y > ws) ws = x / y;
    if (r > 1e-9 && x / r > wa) { wa = x / r; ja = j; }
  }
  out[0] = ws; out[1] = wa; out[2] = ja;
  return out;
}

/* The emergency release's peel time (s) at unexpected strain s rising at rate (per second): gone by halfway to popStretch
   at this pace, never slower than peelTime, never faster than peelFast ticks of dt. */
export function emergencyTime(s, rate, dt, k) {
  const fast = Math.max(1, k.peelFast) * dt;
  const t = rate > 0 ? (0.5 * (k.popStretch - s)) / rate : Infinity;
  return Math.max(fast, Math.min(k.peelTime, t));
}

/* A group of segments letting go together, tip first: each one's start after t0, peelStagger apart by rank from the
   tip. segs (length n) is reordered in place, starts land in at (indexed like segs). */
export function rippleOrder(segs, n, t0, stagger, at) {
  for (let a = 1; a < n; a++) {
    const v = segs[a];
    let b = a - 1;
    while (b >= 0 && segs[b] < v) { segs[b + 1] = segs[b]; b--; }
    segs[b + 1] = v;
  }
  for (let r = 0; r < n; r++) at[r] = t0 + r * Math.max(0, stagger);
  return segs;
}

/* One tick of drag relax on relaxGoal R: segments 0..hi rise at dragRate while rise holds, each no farther than its
   lamMax can use; every other segment, and all of them once nothing drags, falls at dragRecover. True while any is up. */
export function relaxStep(R, lamMax, hi, rise, dt, k) {
  let on = false;
  const up = Math.max(0, k.dragRate) * dt, down = Math.max(0, k.dragRecover) * dt;
  for (let s = 0; s < R.length; s++) {
    if (s <= hi && rise) R[s] = Math.min(Math.max(0, lamMax[s] - 1), R[s] + up);
    else if (s > hi) R[s] = Math.max(0, R[s] - down);
    if (R[s] > 0) on = true;
  }
  return on;
}

/* The commanded elongation of the span to point i: segment stretches lam over their rest lengths. */
export function commandedStretch(lam, len0, i) {
  let x = 0, r = 0;
  for (let j = 0; j < i; j++) { x += len0[j] * lam[j]; r += len0[j]; }
  return r > 1e-9 ? x / r : 1;
}
