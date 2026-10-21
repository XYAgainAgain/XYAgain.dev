/* Neighbor awareness: where the other arms' bodies lie near each arm, so its programs steer off a crowded side before
   contact has to. Arm-on-arm contact (separateArms) stays the backstop; this only reads the chains. */

/* Which points of an n-point chain take part: idx[0] is `base` (the first point contact may move), where the chain the
   others feel starts; then `count` samples that feel them, evenly spaced by index from `from` of the way out to the tip. */
export function crowdSamples(n, count, from, base) {
  const last = n - 1, b = Math.max(0, Math.min(last - 1, base | 0));
  const first = Math.max(b + 1, Math.min(last, Math.round((Number.isFinite(from) ? from : 0) * last)));
  const K = Math.max(1, Math.min(last - first + 1, Math.floor(Number.isFinite(count) ? count : 1)));
  const idx = new Int32Array(K + 1);
  idx[0] = b;
  for (let s = 0; s < K; s++) idx[s + 1] = K === 1 ? last : Math.round(first + ((last - first) * s) / (K - 1));
  return idx;
}

export function makeCrowdState(count, V) {
  return { P: new Float64Array(count * V * 3), R: new Float64Array(count * V), ok: new Uint8Array(count * V), box: new Float64Array(count * 6) };
}

/* Each chain's push off the others: every sample against each other chain's polyline through idx, pushed straight off its
   nearest segment by (1 − gap/range)², summed and capped at 1, into out (x, y, z each); returns the point-segment tests. */
export function crowdPush(chains, idx, range, out, st = makeCrowdState(chains.length, idx.length)) {
  const N = chains.length, V = idx.length, P = st.P, R = st.R, ok = st.ok, box = st.box;
  out.fill(0);
  if (!(range > 0 && range < Infinity) || V < 2) return 0;
  const half = range / 2;
  for (let a = 0; a < N; a++) {
    const X = chains[a].X, rad = chains[a].rad, bo = a * 6;
    box[bo] = box[bo + 1] = box[bo + 2] = Infinity; box[bo + 3] = box[bo + 4] = box[bo + 5] = -Infinity;
    for (let s = 0; s < V; s++) {
      const i = idx[s], v = a * V + s, x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2], r = rad[i];
      ok[v] = Number.isFinite(x + y + z) && r >= 0 && r < Infinity ? 1 : 0;
      if (!ok[v]) continue;
      P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z; R[v] = r;
      // Grown by its own radius and half the range, two boxes that miss each other hold no pair within range.
      const g = r + half;
      if (x - g < box[bo]) box[bo] = x - g;
      if (y - g < box[bo + 1]) box[bo + 1] = y - g;
      if (z - g < box[bo + 2]) box[bo + 2] = z - g;
      if (x + g > box[bo + 3]) box[bo + 3] = x + g;
      if (y + g > box[bo + 4]) box[bo + 4] = y + g;
      if (z + g > box[bo + 5]) box[bo + 5] = z + g;
    }
  }
  let tests = 0;
  for (let a = 0; a < N; a++) {
    const ao = a * 6;
    let px = 0, py = 0, pz = 0;
    for (let b = 0; b < N; b++) {
      const bo = b * 6;
      if (b === a || box[ao] > box[bo + 3] || box[bo] > box[ao + 3] || box[ao + 1] > box[bo + 4] || box[bo + 1] > box[ao + 4] || box[ao + 2] > box[bo + 5] || box[bo + 2] > box[ao + 5]) continue;
      for (let s = 1; s < V; s++) {
        const va = a * V + s;
        if (!ok[va]) continue;
        const x = P[va * 3], y = P[va * 3 + 1], z = P[va * 3 + 2], ra = R[va];
        let best = Infinity, ax = 0, ay = 0, az = 0, ad = 0;
        for (let t = 0; t + 1 < V; t++) {
          const v0 = b * V + t, v1 = v0 + 1;
          if (!ok[v0] || !ok[v1]) continue;
          tests++;
          const qx = P[v0 * 3], qy = P[v0 * 3 + 1], qz = P[v0 * 3 + 2];
          const ex = P[v1 * 3] - qx, ey = P[v1 * 3 + 1] - qy, ez = P[v1 * 3 + 2] - qz, e2 = ex * ex + ey * ey + ez * ez;
          let u = e2 > 1e-18 ? ((x - qx) * ex + (y - qy) * ey + (z - qz) * ez) / e2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const dx = x - qx - ex * u, dy = y - qy - ey * u, dz = z - qz - ez * u, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const gap = d - ra - (R[v0] + (R[v1] - R[v0]) * u);
          if (gap < best) { best = gap; ax = dx; ay = dy; az = dz; ad = d; }
        }
        // Centers on top of each other have no side to push toward; contact sorts that out.
        if (!(best < range) || !(ad > 1e-9)) continue;
        const w = best <= 0 ? 1 : (1 - best / range) ** 2;
        px += (ax / ad) * w; py += (ay / ad) * w; pz += (az / ad) * w;
      }
    }
    const l = Math.sqrt(px * px + py * py + pz * pz), sc = l > 1 ? 1 / l : 1;
    out[a * 3] = px * sc; out[a * 3 + 1] = py * sc; out[a * 3 + 2] = pz * sc;
  }
  return tests;
}

export class ArmCrowd {
  constructor(arms) {
    this.arms = arms;
    this.tests = 0;
    this.ms = 0;
    this._key = null;
  }

  /* Each arm's crowd.push from the bodies as last tick left them, before any arm steps. */
  tick(dt) {
    const A = this.arms, k = A.knobs;
    if (!k.crowd) return;
    const t0 = performance.now(), arms = A.arms, n = arms[0]?.n ?? 0, key = `${n} ${k.crowdSamples} ${k.crowdFrom} ${k.pin}`;
    if (key !== this._key) {
      this._key = key;
      this.idx = crowdSamples(n, k.crowdSamples, k.crowdFrom, k.pin);
      this.st = makeCrowdState(arms.length, this.idx.length);
      this.out = new Float64Array(arms.length * 3);
    }
    const out = this.out;
    this.tests = crowdPush(A.bodies, this.idx, k.crowdRange, out, this.st);
    for (let a = 0; a < arms.length; a++) {
      const c = arms[a].crowd, p = c.push;
      p[0] = out[a * 3]; p[1] = out[a * 3 + 1]; p[2] = out[a * 3 + 2];
      // A driving rod is one body: a bend past its grip point still moves the grip point, so its reaches never steer.
      c.reach = !(A.rods?.[a] && !A.shadow);
    }
    this.ms = performance.now() - t0;
  }
}
