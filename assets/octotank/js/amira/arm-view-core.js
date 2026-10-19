/* The arm look without THREE: a smooth tube over each solved chain (centripetal Catmull-Rom, rotation-minimizing
   frames rolled onto the sucker side), the sucker cups' frames on it, and the web between neighboring arms. */

export const VIEW_KNOBS = {
  girth: 1,              // drawn radius over the collision radius
  previewRoot: 0,        // m: draw the arms on a candidate taper with this root radius (0 off)
  previewPow: 0,         // and this exponent (0 keeps the arm's own)
  sub: 4,                // rings per chain segment
  sides: 16,             // vertices around each ring
  capRings: 4,           // rings rounding the tip, apex included
  rootSink: 1.3,         // root radii the first ring sinks into her along the root's inward direction
  rowAngle: Math.atan2(0.4, 0.9),   // rad either side of the sucker line, where suckerPoint puts the two rows
  cupSink: 0.15,         // cup radii a cup's base sits under the skin
  webDeep: 0.175,        // deepest sector (C) over the longest arm, mouth to margin along its midline
  webOrder: { A: 0.6, B: 0.84, C: 1, D: 0.92, E: 0.72 },   // every sector's depth over C's
  scallop: 0.3,          // how far the free edge's middle rides up toward the mouth, over the depth on the arms
  fullness: 1,           // the web's rest width over a flat star's chord at the same depth
  webInset: 0.75,        // tube radii from the arm's axis where the web joins it, inside the skin
  webU: 8,               // web quads across a sector, and along it; read once, when the view is built
  webV: 8,
};

/* Sector letter between roots r and r + 1 (mod count) in Jereb et al.'s scheme: A between the dorsal pair, then B, C, D
   down each side, E between the ventral pair. Roots run 0 front-right round her right side to 7 front-left. */
export function sectorName(r, count = 8) {
  const half = count / 2, b = (r + 1) % count;
  if (r === count - 1 && b === 0) return 'A';
  if (r === half - 1) return 'E';
  const k = r < half ? r : count - 2 - r;
  return 'BCD'[k] ?? 'D';
}

/* Square root of the distance between two points, floored so repeated points still give a usable knot. */
function knot(A, i, j) {
  const x = A[j] - A[i], y = A[j + 1] - A[i + 1], z = A[j + 2] - A[i + 2];
  return Math.sqrt(Math.sqrt(Math.max(1e-20, x * x + y * y + z * z)));
}

/* Centripetal Catmull-Rom (Barry and Goldman's pyramid) between P1 and P2 at f in [0, 1]; P0 and P3 are the neighbors.
   Reads and writes flat xyz arrays at the given offsets. */
export function centripetal(A, i0, i1, i2, i3, f, out, o) {
  const d01 = knot(A, i0, i1), d12 = knot(A, i1, i2), d23 = knot(A, i2, i3);
  const t1 = d01, t2 = t1 + d12, t3 = t2 + d23, t = t1 + f * d12;
  for (let c = 0; c < 3; c++) {
    const p0 = A[i0 + c], p1 = A[i1 + c], p2 = A[i2 + c], p3 = A[i3 + c];
    const a1 = ((t1 - t) * p0 + t * p1) / t1;
    const a2 = ((t2 - t) * p1 + (t - t1) * p2) / d12;
    const a3 = ((t3 - t) * p2 + (t - t2) * p3) / d23;
    const b1 = ((t2 - t) * a1 + t * a2) / t2;
    const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
    out[o + c] = ((t2 - t) * b1 + (t - t1) * b2) / d12;
  }
}

/* Segment j's posed sucker side carried by the shortest rotation from its posed direction D onto (tx, ty, tz). Squaring the
   side off the solved direction alone would flip it once contact turns the segment past its own sucker side. */
function carrySide(SK, D, j, tx, ty, tz, out) {
  const i = j * 3;
  let sx = SK[i], sy = SK[i + 1], sz = SK[i + 2];
  if (D) {
    const ax = D[i], ay = D[i + 1], az = D[i + 2], c = ax * tx + ay * ty + az * tz;
    if (c > -0.9 && Math.abs(ax * ax + ay * ay + az * az - 1) < 1e-3) {
      const kx = ay * tz - az * ty, ky = az * tx - ax * tz, kz = ax * ty - ay * tx;
      const cx = ky * sz - kz * sy, cy = kz * sx - kx * sz, cz = kx * sy - ky * sx;
      const ccx = ky * cz - kz * cy, ccy = kz * cx - kx * cz, ccz = kx * cy - ky * cx, w = 1 / (1 + c);
      sx += cx + ccx * w; sy += cy + ccy * w; sz += cz + ccz * w;
    }
  }
  out[0] = sx; out[1] = sy; out[2] = sz;
}

function len3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }
function len2(x, y) { return Math.sqrt(x * x + y * y); }

function cross(ax, ay, az, bx, by, bz, out, o) {
  out[o] = ay * bz - az * by; out[o + 1] = az * bx - ax * bz; out[o + 2] = ax * by - ay * bx;
}

/* Any unit vector square to unit t, written to out[o..]. */
function anyPerp(t, ti, out, o) {
  const x = t[ti], y = t[ti + 1], z = t[ti + 2];
  const ax = Math.abs(x) < 0.6 ? 1 : 0, ay = ax ? 0 : 1;
  const d = ax * x + ay * y;
  let px = ax - d * x, py = ay - d * y, pz = -d * z;
  const l = len3(px, py, pz) || 1;
  out[o] = px / l; out[o + 1] = py / l; out[o + 2] = pz / l;
}

/* One arm's tube: ring centers C, unit tangents T, unit sucker directions O, the cross direction B = T × O, and the
   drawn radius per ring. Body rings run k = 0..S·sub, ring k = j·sub + i sitting at fraction i/sub of segment j. */
export class ArmTube {
  constructor(points, knobs = VIEW_KNOBS) {
    this.n = points;
    this.sub = Math.max(1, knobs.sub | 0);
    this.sides = Math.max(3, knobs.sides | 0);
    this.capRings = Math.max(1, knobs.capRings | 0);
    const S = points - 1, R = this.rings = S * this.sub + 1;
    this.C = new Float64Array(R * 3);
    this.T = new Float64Array(R * 3);
    this.O = new Float64Array(R * 3);
    this.B = new Float64Array(R * 3);
    this.r = new Float64Array(R);
    this.ds = new Float64Array(R);     // the radius's slope along the arc, for the normals
    this.ref = new Float64Array(R * 3); // the rotation-minimizing reference
    this.phi = new Float64Array(S);    // roll from that reference onto the sucker side, at each segment's middle
    this.ext = new Float64Array(points * 3 + 6); // the chain with a mirrored phantom point at each end
    this.valid = false;
  }

  /* Vertices this tube writes: a disc closing the sunk root, the sunk root ring, a ring a radius back along the arm,
     the body rings, and the cap rings (the last of them the apex). */
  get ringCount() { return this.rings + this.capRings + 3; }
  get vertexCount() { return this.ringCount * this.sides; }

  /* Rebuild from the chain X, its radii, the posed sucker sides SK and directions D, and the twist after each segment;
     `root` stands in for the first point. False, with nothing touched, if the chain isn't finite. */
  update(X, rad, SK, girth = 1, root = null, D = null, twist = null) {
    const n = this.n, S = n - 1, sub = this.sub, R = this.rings, E = this.ext, C = this.C, T = this.T;
    let sum = 0;
    for (let i = 0; i < n * 3; i++) sum += X[i];
    for (let i = 0; i < n; i++) sum += rad[i];
    if (!Number.isFinite(sum) || !Number.isFinite(girth)) return (this.valid = false);
    for (let i = 0; i < n * 3; i++) E[i + 3] = X[i];
    // The root as her skin is drawn this frame, which can be a physics step on from the chain's.
    if (root && Number.isFinite(root[0] + root[1] + root[2])) { E[3] = root[0]; E[4] = root[1]; E[5] = root[2]; }
    for (let c = 0; c < 3; c++) {
      E[c] = 2 * E[3 + c] - E[6 + c];
      E[(n + 1) * 3 + c] = 2 * X[S * 3 + c] - X[(S - 1) * 3 + c];
    }
    for (let j = 0; j < S; j++) {
      const i0 = j * 3, i1 = i0 + 3, i2 = i0 + 6, i3 = i0 + 9;
      for (let i = 0; i < sub; i++) centripetal(E, i0, i1, i2, i3, i / sub, C, (j * sub + i) * 3);
    }
    C[(R - 1) * 3] = X[S * 3]; C[(R - 1) * 3 + 1] = X[S * 3 + 1]; C[(R - 1) * 3 + 2] = X[S * 3 + 2];
    // Radius: uniform Catmull-Rom on the per-point radii, ends clamped, never under a tenth of a millimeter.
    for (let k = 0; k < R; k++) {
      const j = Math.min(S - 1, Math.floor(k / sub)), f = k / sub - j;
      const r0 = rad[Math.max(0, j - 1)], r1 = rad[j], r2 = rad[j + 1], r3 = rad[Math.min(S, j + 2)];
      const f2 = f * f, f3 = f2 * f;
      const r = 0.5 * (2 * r1 + (r2 - r0) * f + (2 * r0 - 5 * r1 + 4 * r2 - r3) * f2 + (3 * r1 - r0 - 3 * r2 + r3) * f3);
      this.r[k] = Math.max(1e-4, r * girth);
    }
    // Tangents by central differences; a zero-length stretch keeps its neighbor's.
    for (let k = 0; k < R; k++) {
      const a = Math.max(0, k - 1) * 3, b = Math.min(R - 1, k + 1) * 3;
      let tx = C[b] - C[a], ty = C[b + 1] - C[a + 1], tz = C[b + 2] - C[a + 2];
      const l = len3(tx, ty, tz);
      if (l > 1e-9) { T[k * 3] = tx / l; T[k * 3 + 1] = ty / l; T[k * 3 + 2] = tz / l; }
      else if (k > 0) { T[k * 3] = T[k * 3 - 3]; T[k * 3 + 1] = T[k * 3 - 2]; T[k * 3 + 2] = T[k * 3 - 1]; }
      else { T[0] = 0; T[1] = -1; T[2] = 0; }
      const span = Math.max(1e-9, l);
      this.ds[k] = (this.r[Math.min(R - 1, k + 1)] - this.r[Math.max(0, k - 1)]) / span;
    }
    this._frames(SK, D, twist);
    return (this.valid = true);
  }

  /* Double-reflection frames (Wang et al. 2008) seeded from the root's sucker side, rolled per segment by the summed
     twist: the posed frame bends by shortest rotations too, so only its twist turns it. Without twists, it's measured. */
  _frames(SK, D, twist) {
    const R = this.rings, S = this.n - 1, sub = this.sub, C = this.C, T = this.T, F = this.ref, O = this.O, B = this.B, phi = this.phi, q = this._q ??= [0, 0, 0];
    carrySide(SK, D, 0, T[0], T[1], T[2], q);
    let sx = q[0], sy = q[1], sz = q[2];
    let d = sx * T[0] + sy * T[1] + sz * T[2];
    sx -= d * T[0]; sy -= d * T[1]; sz -= d * T[2];
    let l = len3(sx, sy, sz);
    if (l > 1e-6) { F[0] = sx / l; F[1] = sy / l; F[2] = sz / l; } else anyPerp(T, 0, F, 0);
    for (let k = 0; k < R - 1; k++) {
      const a = k * 3, b = a + 3;
      const v1x = C[b] - C[a], v1y = C[b + 1] - C[a + 1], v1z = C[b + 2] - C[a + 2], c1 = v1x * v1x + v1y * v1y + v1z * v1z;
      let rx = F[a], ry = F[a + 1], rz = F[a + 2], tx = T[a], ty = T[a + 1], tz = T[a + 2];
      if (c1 > 1e-18) {
        const q = 2 / c1, kr = q * (v1x * rx + v1y * ry + v1z * rz), kt = q * (v1x * tx + v1y * ty + v1z * tz);
        rx -= kr * v1x; ry -= kr * v1y; rz -= kr * v1z;
        tx -= kt * v1x; ty -= kt * v1y; tz -= kt * v1z;
      }
      const v2x = T[b] - tx, v2y = T[b + 1] - ty, v2z = T[b + 2] - tz, c2 = v2x * v2x + v2y * v2y + v2z * v2z;
      if (c2 > 1e-18) {
        const k2 = (2 / c2) * (v2x * rx + v2y * ry + v2z * rz);
        rx -= k2 * v2x; ry -= k2 * v2y; rz -= k2 * v2z;
      }
      // Squared back onto the plane of the next tangent, so rounding never lets the reference drift into it.
      d = rx * T[b] + ry * T[b + 1] + rz * T[b + 2];
      rx -= d * T[b]; ry -= d * T[b + 1]; rz -= d * T[b + 2];
      l = len3(rx, ry, rz);
      if (l > 1e-9) { F[b] = rx / l; F[b + 1] = ry / l; F[b + 2] = rz / l; } else anyPerp(T, b, F, b);
    }
    let prev = 0;
    const half = sub / 2, km0 = Math.floor(half), fm = half - km0;
    if (twist) {
      phi[0] = 0;
      for (let j = 1; j < S; j++) phi[j] = phi[j - 1] + (Number.isFinite(twist[j - 1]) ? twist[j - 1] : 0);
    }
    // Measured roll at each segment's middle: the posed side carried onto the solved direction, then squared off it.
    for (let j = 0; j < S && !twist; j++) {
      const k = Math.min(R - 1, j * sub + km0), a = k * 3;
      let tx = T[a], ty = T[a + 1], tz = T[a + 2];
      if (fm > 0 && k + 1 < R) { tx += fm * (T[a + 3] - tx); ty += fm * (T[a + 4] - ty); tz += fm * (T[a + 5] - tz); }
      carrySide(SK, D, j, tx, ty, tz, q);
      sx = q[0]; sy = q[1]; sz = q[2];
      d = sx * tx + sy * ty + sz * tz;
      sx -= d * tx; sy -= d * ty; sz -= d * tz;
      const rx = F[a], ry = F[a + 1], rz = F[a + 2];
      const bx = T[a + 1] * rz - T[a + 2] * ry, by = T[a + 2] * rx - T[a] * rz, bz = T[a] * ry - T[a + 1] * rx;
      const cu = sx * rx + sy * ry + sz * rz, cv = sx * bx + sy * by + sz * bz;
      let p = len2(cu, cv) > 1e-6 ? Math.atan2(cv, cu) : prev;
      p = prev + wrapPi(p - prev);
      phi[j] = prev = p;
    }
    for (let k = 0; k < R; k++) {
      const u = k / sub - 0.5, j0 = Math.max(0, Math.min(S - 1, Math.floor(u))), j1 = Math.min(S - 1, j0 + 1);
      const f = Math.max(0, Math.min(1, u - j0));
      const p = j0 === j1 ? phi[j0] : phi[j0] + (phi[j1] - phi[j0]) * f;
      const cs = Math.cos(p), sn = Math.sin(p), a = k * 3;
      const rx = F[a], ry = F[a + 1], rz = F[a + 2];
      const bx = T[a + 1] * rz - T[a + 2] * ry, by = T[a + 2] * rx - T[a] * rz, bz = T[a] * ry - T[a + 1] * rx;
      O[a] = cs * rx + sn * bx; O[a + 1] = cs * ry + sn * by; O[a + 2] = cs * rz + sn * bz;
      cross(T[a], T[a + 1], T[a + 2], O[a], O[a + 1], O[a + 2], B, a);
    }
  }

  /* Write this tube's vertices and unit normals into pos and nor from vertex v0. Angle 0 of every ring is the sucker
     line, so the ring's vertex m sits at 2πm/sides round from it toward B. */
  write(pos, nor, v0, sink = 1.3, inward = null) {
    const R = this.rings, K = this.capRings, C = this.C, T = this.T, M = this.sides;
    this._cs ??= Float64Array.from({ length: M }, (_, m) => Math.cos((2 * Math.PI * m) / M));
    this._sn ??= Float64Array.from({ length: M }, (_, m) => Math.sin((2 * Math.PI * m) / M));
    let v = v0 * 3;
    // Sunk straight into her, not back along the arm: an arm leaving along her skin would pull its root ring out of it.
    const s = sink * this.r[0], ix = inward ? inward[0] : -T[0], iy = inward ? inward[1] : -T[1], iz = inward ? inward[2] : -T[2];
    const sx = C[0] + ix * s, sy = C[1] + iy * s, sz = C[2] + iz * s;
    v = this._ring(pos, nor, v, 0, sx, sy, sz, 0, 0, 1);
    v = this._ring(pos, nor, v, 0, sx, sy, sz, this.r[0], 1, 0);
    // A ring straight back along the arm, so the root's own neighborhood stays inside the tube however steeply the sink turns.
    const r0 = this.r[0];
    v = this._ring(pos, nor, v, 0, C[0] - T[0] * r0, C[1] - T[1] * r0, C[2] - T[2] * r0, r0, 1, 0);
    for (let k = 0; k < R; k++) v = this._ring(pos, nor, v, k, C[k * 3], C[k * 3 + 1], C[k * 3 + 2], this.r[k], 1, this.ds[k]);
    const e = (R - 1) * 3, re = this.r[R - 1];
    for (let c = 1; c <= K; c++) {
      const al = (c / K) * (Math.PI / 2), h = Math.sin(al) * re;
      v = this._ring(pos, nor, v, R - 1, C[e] + T[e] * h, C[e + 1] + T[e + 1] * h, C[e + 2] + T[e + 2] * h, Math.cos(al) * re, Math.cos(al), -Math.sin(al));
    }
    return v / 3;
  }

  _ring(pos, nor, v, k, cx, cy, cz, r, along, slope) {
    const M = this.sides, cs = this._cs, sn = this._sn, T = this.T, O = this.O, B = this.B, a = k * 3;
    // A radial direction leaned back along the arc by the radius's slope (or forward over the cap): the true normal.
    // The radial part is unit and square to the tangent, so every normal on a ring has the same length.
    const il = 1 / (Math.sqrt(along * along + slope * slope) || 1), al = along * il, tx = T[a] * slope * il, ty = T[a + 1] * slope * il, tz = T[a + 2] * slope * il;
    for (let m = 0; m < M; m++) {
      const nx = cs[m] * O[a] + sn[m] * B[a], ny = cs[m] * O[a + 1] + sn[m] * B[a + 1], nz = cs[m] * O[a + 2] + sn[m] * B[a + 2];
      pos[v] = cx + nx * r; pos[v + 1] = cy + ny * r; pos[v + 2] = cz + nz * r;
      nor[v] = nx * al - tx; nor[v + 1] = ny * al - ty; nor[v + 2] = nz * al - tz;
      v += 3;
    }
    return v;
  }

  /* Frame at fractional body ring u: center, unit tangent t, unit sucker direction o, b = t × o, and radius. */
  frameAt(u, out) {
    const R = this.rings, k0 = Math.max(0, Math.min(R - 1, Math.floor(u))), k1 = Math.min(R - 1, k0 + 1);
    const f = Math.max(0, Math.min(1, u - k0)), a = k0 * 3, b = k1 * 3, C = this.C, T = this.T, O = this.O;
    const { c, t, o, b: bb } = out;
    for (let i = 0; i < 3; i++) {
      c[i] = C[a + i] + (C[b + i] - C[a + i]) * f;
      t[i] = T[a + i] + (T[b + i] - T[a + i]) * f;
      o[i] = O[a + i] + (O[b + i] - O[a + i]) * f;
    }
    let l = len3(t[0], t[1], t[2]);
    if (l < 1e-9) { t[0] = T[a]; t[1] = T[a + 1]; t[2] = T[a + 2]; l = 1; }
    t[0] /= l; t[1] /= l; t[2] /= l;
    const d = o[0] * t[0] + o[1] * t[1] + o[2] * t[2];
    o[0] -= d * t[0]; o[1] -= d * t[1]; o[2] -= d * t[2];
    l = len3(o[0], o[1], o[2]);
    if (l < 1e-9) { o[0] = this.O[a]; o[1] = this.O[a + 1]; o[2] = this.O[a + 2]; l = 1; }
    o[0] /= l; o[1] /= l; o[2] /= l;
    cross(t[0], t[1], t[2], o[0], o[1], o[2], bb, 0);
    out.r = this.r[k0] + (this.r[k1] - this.r[k0]) * f;
    return out;
  }
}

export function newFrame() { return { c: [0, 0, 0], t: [0, 0, 0], o: [0, 0, 0], b: [0, 0, 0], r: 0 }; }

/* Fractional body ring at rest arc s along an arm with rest lengths len0 and arcs arc0 (the skin rides the stretch). */
export function ringAtArc(s, len0, arc0, sub) {
  const S = len0.length;
  if (!(s > 0)) return 0;
  let j = 0;
  while (j < S - 1 && arc0[j + 1] <= s) j++;
  const f = Math.max(0, Math.min(1, (s - arc0[j]) / len0[j]));
  return (j + f) * sub;
}

/* Triangle indices for tubes laid end to end, each `rings` rings of `sides` vertices; wound so faces point out. */
export function tubeIndex(tubes, rings, sides) {
  const out = new Uint32Array(tubes * (rings - 1) * sides * 6);
  let w = 0;
  for (let a = 0; a < tubes; a++) {
    const base = a * rings * sides;
    for (let k = 0; k < rings - 1; k++) {
      for (let m = 0; m < sides; m++) {
        const m1 = (m + 1) % sides, p = base + k * sides, q = p + sides;
        out[w++] = p + m; out[w++] = p + m1; out[w++] = q + m;
        out[w++] = p + m1; out[w++] = q + m1; out[w++] = q + m;
      }
    }
  }
  return out;
}

/* Grid indices for `count` patches of (U + 1) × (V + 1) vertices. */
export function gridIndex(count, U, V) {
  const out = new Uint32Array(count * U * V * 6);
  let w = 0;
  for (let s = 0; s < count; s++) {
    const base = s * (U + 1) * (V + 1);
    for (let j = 0; j < V; j++) for (let i = 0; i < U; i++) {
      const p = base + j * (U + 1) + i, q = p + U + 1;
      out[w++] = p; out[w++] = q; out[w++] = p + 1;
      out[w++] = p + 1; out[w++] = q; out[w++] = q + 1;
    }
  }
  return out;
}

/* Fold sag of a sheet of rest width w0 pinned at points w apart: two straight halves meeting at the middle, so it
   is flat once stretched and hangs half its width when the points meet. */
export function foldSag(w0, w) { return w >= w0 ? 0 : 0.5 * Math.sqrt(w0 * w0 - w * w); }

/* Depth along the arms of a sector's web, from its midline depth measured at the mouth: the margin's middle sits
   `scallop` higher than where it meets the arms, and the arms start `mouthGap` out from the mouth. */
export function webArmDepth(midFromMouth, mouthGap, scallop) {
  return Math.max(0, midFromMouth - mouthGap) / Math.max(0.05, 1 - scallop);
}

/* The web between two tubes. Each vertex (i, j) is a fiber across the sector at arm depth s = j/V · depth · scallop
   profile, i/U of the way from arm a to arm b, sagging toward the oral side by how slack its rest width leaves it. */
export class WebSector {
  constructor(U, V) {
    this.U = U; this.V = V;
    this.ua = new Float64Array((U + 1) * (V + 1));   // fractional body ring on each arm, per vertex
    this.ub = new Float64Array((U + 1) * (V + 1));
    this.s = new Float64Array((U + 1) * (V + 1));    // arm depth per vertex, m of rest arc
    this.dir = new Float64Array((U + 1) * 3);        // last good across direction per column, carried when arms touch
    this.fa = newFrame(); this.fb = newFrame();
  }

  /* Rest-arc depths and ring params for this sector's two arms. */
  layout(depth, scallop, armA, armB, sub) {
    const U = this.U, V = this.V;
    for (let j = 0; j <= V; j++) for (let i = 0; i <= U; i++) {
      const x = i / U, s = (j / V) * depth * (1 - scallop * 4 * x * (1 - x)), w = j * (U + 1) + i;
      this.s[w] = s;
      this.ua[w] = ringAtArc(s, armA.len0, armA.arc0, sub);
      this.ub[w] = ringAtArc(s, armB.len0, armB.arc0, sub);
    }
    this.depth = depth;
  }

  /* Write positions and normals from vertex v0. `count` arms around her set the flat-star spread; `down` is her
     oral direction, the fallback for the sag. */
  write(ta, tb, pos, nor, v0, { inset = 0.75, fullness = 1, count = 8, down = [0, -1, 0] } = {}) {
    const U = this.U, V = this.V, fa = this.fa, fb = this.fb, dir = this.dir, spread = 2 * Math.sin(Math.PI / count);
    let chord = 0;
    this.sag = 0; this.stretch = 0;
    for (let j = 0; j <= V; j++) {
      for (let i = 0; i <= U; i++) {
        const w = j * (U + 1) + i, x = i / U;
        ta.frameAt(this.ua[w], fa); tb.frameAt(this.ub[w], fb);
        let dx = fb.c[0] - fa.c[0], dy = fb.c[1] - fa.c[1], dz = fb.c[2] - fa.c[2];
        // Across direction squared off arm a's tangent; arms lying together have none, so the column keeps its last.
        const da = dx * fa.t[0] + dy * fa.t[1] + dz * fa.t[2];
        let ax = dx - da * fa.t[0], ay = dy - da * fa.t[1], az = dz - da * fa.t[2];
        let al = len3(ax, ay, az);
        if (al > 1e-4) { ax /= al; ay /= al; az /= al; dir[i * 3] = ax; dir[i * 3 + 1] = ay; dir[i * 3 + 2] = az; }
        else if (j > 0) { ax = dir[i * 3]; ay = dir[i * 3 + 1]; az = dir[i * 3 + 2]; }
        else { ax = fa.b[0]; ay = fa.b[1]; az = fa.b[2]; dir[i * 3] = ax; dir[i * 3 + 1] = ay; dir[i * 3 + 2] = az; }
        // Arm b's rail mirrors arm a's: back across toward a, squared off b's own tangent.
        const db = -(dx * fb.t[0] + dy * fb.t[1] + dz * fb.t[2]);
        let bx = -dx - db * fb.t[0], by = -dy - db * fb.t[1], bz = -dz - db * fb.t[2];
        const bl = len3(bx, by, bz);
        if (bl > 1e-4) { bx /= bl; by /= bl; bz /= bl; } else { bx = -ax; by = -ay; bz = -az; }
        const ra = fa.r * inset, rb = fb.r * inset;
        const Ax = fa.c[0] + ax * ra, Ay = fa.c[1] + ay * ra, Az = fa.c[2] + az * ra;
        const Bx = fb.c[0] + bx * rb, By = fb.c[1] + by * rb, Bz = fb.c[2] + bz * rb;
        const wx = Bx - Ax, wy = By - Ay, wz = Bz - Az, width = len3(wx, wy, wz);
        if (j === 0 && i === 0) chord = width;
        const rest = fullness * (chord + this.s[w] * spread);
        const h = foldSag(rest, width) * 4 * x * (1 - x);
        if (h > this.sag) this.sag = h;
        if (j === V && i === U >> 1) this.stretch = width / Math.max(1e-9, rest);
        // Sag toward the two arms' sucker side, squared off the fiber.
        let gx = fa.o[0] + fb.o[0], gy = fa.o[1] + fb.o[1], gz = fa.o[2] + fb.o[2];
        if (width > 1e-6) { const g = (gx * wx + gy * wy + gz * wz) / (width * width); gx -= g * wx; gy -= g * wy; gz -= g * wz; }
        let gl = len3(gx, gy, gz);
        if (gl < 1e-6) { gx = down[0]; gy = down[1]; gz = down[2]; gl = len3(gx, gy, gz) || 1; }
        const p = (v0 + w) * 3;
        pos[p] = Ax + wx * x + (gx / gl) * h;
        pos[p + 1] = Ay + wy * x + (gy / gl) * h;
        pos[p + 2] = Az + wz * x + (gz / gl) * h;
      }
    }
    // Normals from the grid's own differences: one-sided at the borders.
    for (let j = 0; j <= V; j++) for (let i = 0; i <= U; i++) {
      const w = v0 + j * (U + 1) + i, iu0 = v0 + j * (U + 1) + Math.max(0, i - 1), iu1 = v0 + j * (U + 1) + Math.min(U, i + 1);
      const iv0 = v0 + Math.max(0, j - 1) * (U + 1) + i, iv1 = v0 + Math.min(V, j + 1) * (U + 1) + i;
      const ux = pos[iu1 * 3] - pos[iu0 * 3], uy = pos[iu1 * 3 + 1] - pos[iu0 * 3 + 1], uz = pos[iu1 * 3 + 2] - pos[iu0 * 3 + 2];
      const vx = pos[iv1 * 3] - pos[iv0 * 3], vy = pos[iv1 * 3 + 1] - pos[iv0 * 3 + 1], vz = pos[iv1 * 3 + 2] - pos[iv0 * 3 + 2];
      let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
      const l = len3(nx, ny, nz);
      if (l > 1e-14) { nx /= l; ny /= l; nz /= l; } else { nx = down[0]; ny = down[1]; nz = down[2]; }
      nor[w * 3] = nx; nor[w * 3 + 1] = ny; nor[w * 3 + 2] = nz;
    }
    return v0 + (U + 1) * (V + 1);
  }
}

export function wrapPi(a) { return a - 2 * Math.PI * Math.round(a / (2 * Math.PI)); }
