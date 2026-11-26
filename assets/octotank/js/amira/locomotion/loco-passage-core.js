/* Passages through the rock without THREE or Jolt: a squeeze zone's box fitted from the distance field into a centerline,
   the sections along it, its enclosed bore, and the bore's two mouths, plus lookups along it for the squeeze. */

export const PASSAGE_KNOBS = {
  grid: 0.005,      // m between clearance samples in the zone's box
  open: 0.012,      // m of clearance a gap in the box's faces needs to count as an opening
  step: 0.01,       // m between centerline samples
  window: 0.09,     // m half-width of a section's probe: a section that reaches it is open water
  cell: 0.0025,     // m, the section raster
  smooth: 12,       // smoothing passes over the cell path
  minBore: 0.02,    // m of enclosed stretch that makes a passage
  most: 3,          // passages fitted per zone
  maxCells: 300000, // clearance samples per zone: a bigger box is sampled coarser
  maxOpenings: 8,   // the widest openings on a box that are paired up
  lineClear: 0.005, // m of clearance a smoothed centerline point keeps, or as much as its cell had
  outClear: 0.02,   // m of clearance a waypoint out of a mouth keeps from rock, sand, glass, and lid
};

const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/* The nearest of the rock, the substrate's top, the glass, and the lid. */
export function clearanceOf(distance, { w = 2, h = 1, d = 1 } = {}, floor = 0) {
  const n = [0, 0, 0];
  return (x, y, z) => Math.min(distance(x, y, z, n), y - floor, w / 2 - Math.abs(x), d / 2 - Math.abs(z), h - y);
}

/* Every passage a zone's box holds, widest first, and notes on why there are no more. `distance(x, y, z, out)` is the
   rock's signed distance; `tank` its size { w, h, d }; `floor` the substrate's top. */
export function fitZone(distance, zone, { tank = { w: 2, h: 1, d: 1 }, floor = 0, k = PASSAGE_KNOBS } = {}) {
  const clr = clearanceOf(distance, tank, floor), b = zone?.bounds, notes = [], passages = [];
  if (!b) return { passages, notes: ['no bounds'] };
  if (![b.x, b.y, b.z].every((r) => Number.isFinite(r?.[0]) && Number.isFinite(r?.[1]))) return { passages, notes: ['bounds not finite'] };
  const lo = [Math.max(b.x[0], -tank.w / 2), Math.max(b.y[0], 0), Math.max(b.z[0], -tank.d / 2)];
  const hi = [Math.min(b.x[1], tank.w / 2), Math.min(b.y[1], tank.h), Math.min(b.z[1], tank.d / 2)];
  if (hi.some((v, a) => !(v - lo[a] >= 2 * k.grid))) return { passages, notes: [`box under ${2 * k.grid * 1000} mm on a side inside the tank`] };
  const cells = (g) => hi.reduce((n, v, a) => n * (Math.round((v - lo[a]) / g) + 1), 1);
  let h = k.grid;
  if (cells(h) > k.maxCells) {
    h = Math.cbrt(hi.reduce((n, v, a) => n * (v - lo[a]), 1) / k.maxCells);
    while (cells(h) > k.maxCells) h *= 1.05;
    notes.push(`sampled every ${(h * 1000).toFixed(1)} mm, the box holding over ${k.maxCells} samples at ${k.grid * 1000} mm`);
  }
  const nx = Math.round((hi[0] - lo[0]) / h) + 1, ny = Math.round((hi[1] - lo[1]) / h) + 1, nz = Math.round((hi[2] - lo[2]) / h) + 1;
  const N = nx * ny * nz, C = new Float32Array(N), at = (c) => { const i = c % nx, j = ((c / nx) | 0) % ny, l = (c / (nx * ny)) | 0; return [lo[0] + i * h, lo[1] + j * h, lo[2] + l * h]; };
  for (let c = 0; c < N; c++) { const p = at(c); C[c] = clr(p[0], p[1], p[2]); }
  const grid = { nx, ny, nz, N, C, at, lo, h };
  for (let round = 0; round < k.most; round++) {
    let ops = openings(grid, k.open);
    // Once a passage is fitted, running out of others is no news.
    if (ops.length < 2) { if (!round) notes.push(`${ops.length} opening${ops.length === 1 ? '' : 's'} on the box`); break; }
    if (ops.length > k.maxOpenings) {
      if (!round) notes.push(`the widest ${k.maxOpenings} of ${ops.length} openings paired`);
      ops = ops.sort((x, y) => y.top - x.top).slice(0, k.maxOpenings);
    }
    const cands = [];
    for (let i = 0; i < ops.length; i++) {
      const { best, prev } = maximin(grid, ops[i].cells);
      for (let j = i + 1; j < ops.length; j++) {
        let t = -1;
        for (const c of ops[j].cells) if (t < 0 || best[c] > best[t]) t = c;
        if (best[t] > 0) cands.push({ i, j, neck: best[t], path: trace(prev, t, at) });
      }
    }
    cands.sort((x, y) => y.neck - x.neck);
    let got = null;
    const why = new Set();
    for (const cd of cands) { got = buildPassage(clr, cd.path, k); if (typeof got !== 'string') break; why.add(got); got = null; }
    if (!got) { if (!round) notes.push(cands.length ? [...why].join('; ') : 'the openings are not connected'); break; }
    got.zone = zone.name ?? '';
    got.name = `${got.zone || 'passage'}${round ? ` ${round + 1}` : ''}`;
    passages.push(got);
    // Its bore sealed off, the next round finds another passage or none.
    for (let i = got.bore[0]; i <= got.bore[1]; i++) block(grid, got.points[i], got.reach[i] + 2 * h);
  }
  return { passages, notes };
}

/* The box's faces' free cells grouped into openings, each with at least `open` m of clearance somewhere. */
function openings({ nx, ny, nz, C }, open) {
  const face = (i, j, l) => i === 0 || j === 0 || l === 0 || i === nx - 1 || j === ny - 1 || l === nz - 1;
  const seen = new Uint8Array(C.length), out = [];
  for (let c = 0; c < C.length; c++) {
    const i = c % nx, j = ((c / nx) | 0) % ny, l = (c / (nx * ny)) | 0;
    if (seen[c] || !(C[c] > 0) || !face(i, j, l)) continue;
    const cells = [], st = [c];
    seen[c] = 1;
    let top = 0;
    while (st.length) {
      const q = st.pop(), qi = q % nx, qj = ((q / nx) | 0) % ny, ql = (q / (nx * ny)) | 0;
      cells.push(q); top = Math.max(top, C[q]);
      for (const [a, bb, cc] of NB) {
        const ii = qi + a, jj = qj + bb, ll = ql + cc;
        if (ii < 0 || jj < 0 || ll < 0 || ii >= nx || jj >= ny || ll >= nz || !face(ii, jj, ll)) continue;
        const v = ii + nx * (jj + ny * ll);
        if (!seen[v] && C[v] > 0) { seen[v] = 1; st.push(v); }
      }
    }
    if (top >= open) out.push({ cells, top });
  }
  return out;
}

/* The widest-ball path from a set of cells to every other: each cell's best bottleneck clearance, ties to the shorter. */
function maximin({ nx, ny, nz, N, C }, from) {
  const best = new Float32Array(N).fill(-1), len = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const heap = [];
  const less = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] < b[1]);
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  for (const c of from) if (C[c] > 0) { best[c] = C[c]; len[c] = 0; push([C[c], 0, c]); }
  while (heap.length) {
    const [bn, L, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    const i = u % nx, j = ((u / nx) | 0) % ny, l = (u / (nx * ny)) | 0;
    for (const [a, b2, c2] of NB) {
      const ii = i + a, jj = j + b2, ll = l + c2;
      if (ii < 0 || jj < 0 || ll < 0 || ii >= nx || jj >= ny || ll >= nz) continue;
      const v = ii + nx * (jj + ny * ll);
      if (done[v] || !(C[v] > 0)) continue;
      const nb = Math.min(bn, C[v]), nl = L + 1;
      if (nb > best[v] || (nb === best[v] && nl < len[v])) { best[v] = nb; len[v] = nl; prev[v] = u; push([nb, nl, v]); }
    }
  }
  return { best, prev };
}

function trace(prev, t, at) {
  const path = [];
  for (let u = t; u !== -1; u = prev[u]) path.push(at(u));
  return path.reverse();
}

function block({ nx, ny, nz, C, lo, h }, p, r) {
  const span = (a, n) => [Math.max(0, Math.floor((p[a] - r - lo[a]) / h)), Math.min(n - 1, Math.ceil((p[a] + r - lo[a]) / h))];
  const [i0, i1] = span(0, nx), [j0, j1] = span(1, ny), [l0, l1] = span(2, nz);
  for (let l = l0; l <= l1; l++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = i + nx * (j + ny * l);
    if (C[c] > 0 && Math.hypot(lo[0] + i * h - p[0], lo[1] + j * h - p[1], lo[2] + l * h - p[2]) <= r) C[c] = -1;
  }
}

/* A cell path smoothed and resampled every `step`, its sections, and its bore: the longest run of enclosed sections.
   A string saying why when there is none: no run reaches minBore, the run meets the box, or the line cuts the rock. */
function buildPassage(clr, raw, k) {
  if (raw.length < 3) return 'no enclosed stretch between the openings';
  let p = raw.map((v) => [...v]);
  for (let r = 0; r < k.smooth; r++) p = p.map((v, i) => (i === 0 || i === p.length - 1 ? v : v.map((c, a) => (p[i - 1][a] + 2 * c + p[i + 1][a]) / 4)));
  // Smoothing can cut a bend's inner wall: a point that loses its clearance slides back toward its cell.
  const q = (v) => clr(v[0], v[1], v[2]), mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  for (let i = 1; i < p.length - 1; i++) {
    const need = Math.min(k.lineClear, q(raw[i]));
    if (q(p[i]) >= need) continue;
    let lo = 0, hi = 1;
    for (let it = 0; it < 10; it++) { const m = (lo + hi) / 2; if (q(mix(raw[i], p[i], m)) >= need) lo = m; else hi = m; }
    p[i] = mix(raw[i], p[i], lo);
  }
  for (let i = 1; i < p.length; i++) if (!(q(mix(p[i - 1], p[i], 0.5)) > 0)) { p[i - 1] = [...raw[i - 1]]; p[i] = [...raw[i]]; }
  const pts = resample(p, k.step), n = pts.length;
  if (n < 3) return 'no enclosed stretch between the openings';
  const tan = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)], t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...t) || 1;
    return [t[0] / l, t[1] / l, t[2] / l];
  });
  const S = pts.map((c, i) => section(clr, c, tan[i], k));
  if (S.some((s) => s.blocked)) return 'its centerline cuts the rock';
  let run = null;
  for (let i = 0; i < n;) {
    if (!S[i].closed) { i++; continue; }
    let j = i;
    while (j + 1 < n && S[j + 1].closed) j++;
    if (!run || j - i > run[1] - run[0]) run = [i, j];
    i = j + 1;
  }
  if (!run || (run[1] - run[0]) * k.step < k.minBore) return 'no enclosed stretch between the openings';
  // A bore whose end has no open water past it inside the box may run on beyond it, or end blind.
  if (run[0] === 0 || run[1] === n - 1) return 'clipped: the bore runs out of the box';
  let narrow = run[0], tight = run[0];
  for (let i = run[0]; i <= run[1]; i++) { if (S[i].r < S[narrow].r) narrow = i; if (S[i].area < S[tight].area) tight = i; }
  const mouth = (i, sgn) => ({ s: i * k.step, p: [...pts[i]], t: tan[i].map((v) => v * sgn), r: S[i].r, area: S[i].area });
  return {
    step: k.step, points: pts, tangents: tan, radius: S.map((s) => s.r), area: S.map((s) => s.area), reach: S.map((s) => s.reach), closed: S.map((s) => s.closed),
    total: (n - 1) * k.step, bore: run, length: (run[1] - run[0]) * k.step,
    mouths: [mouth(run[0], -1), mouth(run[1], 1)],
    narrow: { r: S[narrow].r, s: narrow * k.step, area: S[tight].area, areaS: tight * k.step },
    clear: clr, outClear: k.outClear,
  };
}

function resample(p, step) {
  const out = [p[0]];
  let carry = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let t = step - carry;
    while (t <= l) { const f = t / l; out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]); t += step; }
    carry = l - (t - step);
  }
  return out;
}

/* The free region around c in the plane across t, flooded from c: its area, whether it stays inside the window, the
   widest ball centered in it (max clearance), and how far it reaches from c. `blocked` when c itself is not free. */
export function section(clr, c, t, k = PASSAGE_KNOBS) {
  let u = [-t[2], 0, t[0]], l = Math.hypot(u[0], u[2]);
  u = l < 1e-6 ? [1, 0, 0] : [u[0] / l, 0, u[2] / l];
  const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  const g = k.cell, R = Math.round(k.window / g), W = 2 * R + 1, F = new Float32Array(W * W), seen = new Uint8Array(W * W);
  for (let bb = 0; bb < W; bb++) for (let a = 0; a < W; a++) {
    const s = (a - R) * g, w = (bb - R) * g;
    F[a + W * bb] = clr(c[0] + u[0] * s + v[0] * w, c[1] + u[1] * s + v[1] * w, c[2] + u[2] * s + v[2] * w);
  }
  const seed = R + W * R;
  if (!(F[seed] > 0)) return { area: 0, closed: false, r: 0, reach: 0, blocked: true };
  const st = [seed];
  seen[seed] = 1;
  let cells = 0, closed = true, r = 0, reach = 0;
  while (st.length) {
    const q = st.pop(), a = q % W, bb = (q / W) | 0;
    cells++; r = Math.max(r, F[q]); reach = Math.max(reach, Math.hypot(a - R, bb - R) * g);
    if (a === 0 || bb === 0 || a === W - 1 || bb === W - 1) closed = false;
    for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const aa = a + da, b2 = bb + db;
      if (aa < 0 || b2 < 0 || aa >= W || b2 >= W) continue;
      const nq = aa + W * b2;
      if (!seen[nq] && F[nq] > 0) { seen[nq] = 1; st.push(nq); }
    }
  }
  return { area: cells * g * g, closed, r, reach };
}

/* The centerline's point at arc length s, past either end along that end's tangent. Written into out. */
export function passageAt(P, s, out = [0, 0, 0]) {
  const n = P.points.length, x = s / P.step;
  if (x <= 0 || x >= n - 1) {
    const e = x <= 0 ? 0 : n - 1, d = s - e * P.step, p = P.points[e], t = P.tangents[e];
    out[0] = p[0] + t[0] * d; out[1] = p[1] + t[1] * d; out[2] = p[2] + t[2] * d;
    return out;
  }
  const i = Math.floor(x), f = x - i, a = P.points[i], b = P.points[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f;
  return out;
}

/* A point `dist` out of mouth i (0 or 1): along the centerline within 45° of the mouth's outward line (past the bore it
   only finds the box's face), then straight on along that line, stopped short where P.clear finds the world. */
export function passageOut(P, i, dist, out = [0, 0, 0]) {
  if (!P.clear || !(dist > 0)) return outAlong(P, i, dist, out);
  const m = P.mouths[i].p, need = Math.min(P.outClear ?? PASSAGE_KNOBS.outClear, P.clear(m[0], m[1], m[2])), n = Math.ceil(dist / 0.005);
  let ok = 0;
  for (let j = 1; j <= n; j++) {
    outAlong(P, i, (dist * j) / n, out);
    if (!(P.clear(out[0], out[1], out[2]) >= need)) break;
    ok = j;
  }
  return outAlong(P, i, (dist * ok) / n, out);
}

function outAlong(P, i, dist, out) {
  const m = P.mouths[i], t = m.t, step = i === 0 ? -1 : 1, pts = P.points;
  let j = Math.round(m.s / P.step), left = dist;
  out[0] = m.p[0]; out[1] = m.p[1]; out[2] = m.p[2];
  while (left > 0 && j + step >= 0 && j + step < pts.length) {
    const a = pts[j], b = pts[j + step], ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], l = Math.hypot(ex, ey, ez);
    if (!(l > 0) || (ex * t[0] + ey * t[1] + ez * t[2]) / l < Math.SQRT1_2) break;
    const f = Math.min(1, left / l);
    out[0] = a[0] + ex * f; out[1] = a[1] + ey * f; out[2] = a[2] + ez * f;
    left -= l * f; j += step;
  }
  out[0] += t[0] * left; out[1] += t[1] * left; out[2] += t[2] * left;
  return out;
}

/* The unit tangent at s, along increasing s, held at the ends past them. */
export function passageTangent(P, s, out = [0, 0, 0]) {
  const n = P.points.length, x = Math.max(0, Math.min(n - 1, s / P.step)), i = Math.min(n - 2, Math.floor(x)), f = x - i;
  const a = P.tangents[i], b = P.tangents[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

/* A sampled value (radius, area, reach) at s, held at the ends. */
export function passageValue(P, key, s) {
  const A = P[key], n = A.length, x = Math.max(0, Math.min(n - 1, s / P.step)), i = Math.min(n - 2, Math.floor(x)), f = x - i;
  return A[i] + (A[i + 1] - A[i]) * f;
}

/* The nearest point of the centerline to p: its arc length s (unclamped past the ends, along their tangents) and the
   distance d off the line. `hint` (a sample index) narrows the scan to its neighbors. */
export function passageProject(P, p, out = { s: 0, d: 0, i: 0 }, hint = -1) {
  const pts = P.points, n = pts.length, lo = hint >= 0 ? Math.max(0, hint - 6) : 0, hi = hint >= 0 ? Math.min(n - 1, hint + 6) : n - 1;
  let bd = Infinity, bs = 0, bi = 0;
  for (let i = lo; i < hi; i++) {
    const a = pts[i], b = pts[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], ll = ex * ex + ey * ey + ez * ez;
    let f = ll > 0 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey + (p[2] - a[2]) * ez) / ll : 0;
    if (!(i === 0 && f < 0) && !(i === n - 2 && f > 1)) f = Math.max(0, Math.min(1, f));
    const qx = a[0] + ex * f - p[0], qy = a[1] + ey * f - p[1], qz = a[2] + ez * f - p[2], d = qx * qx + qy * qy + qz * qz;
    if (d < bd) { bd = d; bs = (i + f) * P.step; bi = i; }
  }
  out.s = bs; out.d = Math.sqrt(bd); out.i = bi;
  return out;
}
