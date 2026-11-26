// The mesh and the distance query read one stored grid, so they agree by construction.
const MAGIC = [0x52, 0x4b, 0x57, 0x00];
export const HEADER_BYTES = 112;

export function readHeader(file) {
  const b = file instanceof Uint8Array ? file : new Uint8Array(file);
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) throw new Error('rockwork: bad magic');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), f = (o) => v.getFloat64(o, true);
  const version = v.getUint16(4, true);
  if (version !== 1) throw new Error(`rockwork: unknown version ${version}`);
  return {
    nx: v.getUint16(8, true), ny: v.getUint16(10, true), nz: v.getUint16(12, true),
    x0: f(16), y0: f(24), z0: f(32), h: f(40), q: f(48),
    lo: [f(56), f(64), f(72)], hi: [f(80), f(88), f(96)], bodyBytes: v.getUint32(104, true),
  };
}

// Mirrors the bake's encodeLorenzo; integer-only, so every engine decodes identical codes.
export function decodeCodes(body, nx, ny, nz) {
  const n = nx * ny * nz, out = new Int16Array(n), sxy = nx * ny;
  if (body.length !== 2 * n) throw new Error('rockwork: body size mismatch');
  for (let k = 0, p = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++) {
    const z = body[p] | (body[n + p] << 8), r = (z >>> 1) ^ -(z & 1);
    const a = i ? out[p - 1] : 0, b = j ? out[p - nx] : 0, c = k ? out[p - sxy] : 0;
    const ab = i && j ? out[p - 1 - nx] : 0, ac = i && k ? out[p - 1 - sxy] : 0, bc = j && k ? out[p - nx - sxy] : 0, abc = i && j && k ? out[p - 1 - nx - sxy] : 0;
    out[p] = ((a + b + c - ab - ac - bc + abc + r) << 16) >> 16;
  }
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchFile(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`rockwork: ${url} ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function loadRockwork(src) {
  const file = typeof src === 'string' || src instanceof URL ? await fetchFile(src) : src instanceof Uint8Array ? src : new Uint8Array(src);
  const head = readHeader(file);
  return decodeRockwork(file, await inflate(file.subarray(HEADER_BYTES, HEADER_BYTES + head.bodyBytes)));
}

// `body` is the inflated payload; inflation is the only async step, so callers holding it can stay sync.
export function decodeRockwork(file, body) {
  const head = readHeader(file);
  return new Rockwork(head, decodeCodes(body, head.nx, head.ny, head.nz));
}

const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

function grow(arr, need) {
  if (need <= arr.length) return arr;
  const next = new arr.constructor(Math.max(need, arr.length * 2));
  next.set(arr);
  return next;
}

export class Rockwork {
  constructor(head, codes) {
    Object.assign(this, { nx: head.nx, ny: head.ny, nz: head.nz, x0: head.x0, y0: head.y0, z0: head.z0, h: head.h, q: head.q });
    this.lo = head.lo; this.hi = head.hi;
    this.codes = codes;
    this.scratch = [0, 0, 0];
    this.cachedMesh = null; this.columns = null;
  }

  distance(x, y, z, out) {
    const { nx, ny, nz, h } = this;
    const fx = (x - this.x0) / h, fy = (y - this.y0) / h, fz = (z - this.z0) / h;
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= nx - 1 && fy <= ny - 1 && fz <= nz - 1)) return this.offGrid(x, y, z, out);
    const f = this.codes, sxy = nx * ny;
    const i = fx < nx - 1 ? fx | 0 : nx - 2, j = fy < ny - 1 ? fy | 0 : ny - 2, k = fz < nz - 1 ? fz | 0 : nz - 2;
    const u = fx - i, w = fy - j, t = fz - k, b = i + nx * (j + ny * k);
    const c000 = f[b], c100 = f[b + 1], c010 = f[b + nx], c110 = f[b + nx + 1];
    const c001 = f[b + sxy], c101 = f[b + sxy + 1], c011 = f[b + sxy + nx], c111 = f[b + sxy + nx + 1];
    const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u, x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * w, y1 = x01 + (x11 - x01) * w, val = y0 + (y1 - y0) * t;
    // Central differences at the eight corners, blended trilinearly, so the normal stays continuous across cell faces.
    const im = i > 0 ? i - 1 : 0, ip = i < nx - 2 ? i + 2 : nx - 1, jm = j > 0 ? j - 1 : 0, jp = j < ny - 2 ? j + 2 : ny - 1, km = k > 0 ? k - 1 : 0, kp = k < nz - 2 ? k + 2 : nz - 1;
    const dxa = 1 / (i + 1 - im), dxb = 1 / (ip - i), dya = 1 / (j + 1 - jm), dyb = 1 / (jp - j), dza = 1 / (k + 1 - km), dzb = 1 / (kp - k);
    const ox = im - i, px = ip - i, oy = (jm - j) * nx, py = (jp - j) * nx, oz = (km - k) * sxy, pz = (kp - k) * sxy, bz = b + sxy, by = b + nx;
    const gx00 = (c100 - f[b + ox]) * dxa, gx10 = (f[b + px] - c000) * dxb, gx01 = (c110 - f[by + ox]) * dxa, gx11 = (f[by + px] - c010) * dxb;
    const gx02 = (c101 - f[bz + ox]) * dxa, gx12 = (f[bz + px] - c001) * dxb, gx03 = (c111 - f[bz + nx + ox]) * dxa, gx13 = (f[bz + nx + px] - c011) * dxb;
    const gy00 = (c010 - f[b + oy]) * dya, gy10 = (c110 - f[b + 1 + oy]) * dya, gy01 = (f[b + py] - c000) * dyb, gy11 = (f[b + 1 + py] - c100) * dyb;
    const gy02 = (c011 - f[bz + oy]) * dya, gy12 = (c111 - f[bz + 1 + oy]) * dya, gy03 = (f[bz + py] - c001) * dyb, gy13 = (f[bz + 1 + py] - c101) * dyb;
    const gz00 = (c001 - f[b + oz]) * dza, gz10 = (c101 - f[b + 1 + oz]) * dza, gz01 = (c011 - f[by + oz]) * dza, gz11 = (c111 - f[by + 1 + oz]) * dza;
    const gz02 = (f[b + pz] - c000) * dzb, gz12 = (f[b + 1 + pz] - c100) * dzb, gz03 = (f[by + pz] - c010) * dzb, gz13 = (f[by + 1 + pz] - c110) * dzb;
    const U = 1 - u, W = 1 - w, T = 1 - t;
    const gx = ((gx00 * U + gx10 * u) * W + (gx01 * U + gx11 * u) * w) * T + ((gx02 * U + gx12 * u) * W + (gx03 * U + gx13 * u) * w) * t;
    const gy = ((gy00 * U + gy10 * u) * W + (gy01 * U + gy11 * u) * w) * T + ((gy02 * U + gy12 * u) * W + (gy03 * U + gy13 * u) * w) * t;
    const gz = ((gz00 * U + gz10 * u) * W + (gz01 * U + gz11 * u) * w) * T + ((gz02 * U + gz12 * u) * W + (gz03 * U + gz13 * u) * w) * t;
    // Between surfaces a sample apart the wide differences can point into rock; the cell's slope never does.
    const tx = ((c100 - c000) * W + (c110 - c010) * w) * T + ((c101 - c001) * W + (c111 - c011) * w) * t, ty = (x10 - x00) * T + (x11 - x01) * t, tz = y1 - y0;
    const own = gx * tx + gy * ty + gz * tz <= 0, nx1 = own ? tx : gx, ny1 = own ? ty : gy, nz1 = own ? tz : gz;
    const l2 = nx1 * nx1 + ny1 * ny1 + nz1 * nz1;
    if (l2 > 1e-12) { const l = Math.sqrt(l2); out[0] = nx1 / l; out[1] = ny1 / l; out[2] = nz1 / l; }
    else { out[0] = 0; out[1] = 1; out[2] = 0; }
    return val * this.q;
  }

  // The nearest grid point's reading plus the way to it: continuous at the grid's edge, and never a contact off it.
  offGrid(x, y, z, out) {
    if (x !== x || y !== y || z !== z) { out[0] = 0; out[1] = 1; out[2] = 0; return Infinity; }
    // A hair inside, so rounding can't put the clamped point back off the grid.
    const h = this.h, e = h * 1e-6, xa = this.x0 + e, ya = this.y0 + e, za = this.z0 + e, xb = this.x0 + (this.nx - 1) * h - e, yb = this.y0 + (this.ny - 1) * h - e, zb = this.z0 + (this.nz - 1) * h - e;
    const cx = x < xa ? xa : x > xb ? xb : x, cy = y < ya ? ya : y > yb ? yb : y, cz = z < za ? za : z > zb ? zb : z;
    const off = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz));
    if (!(off < Infinity)) { out[0] = 0; out[1] = 1; out[2] = 0; return Infinity; }
    const d = this.distance(cx, cy, cz, out);
    return (d > 0 ? d : 0) + off;
  }

  inside(x, y, z) { return this.distance(x, y, z, this.scratch) < 0; }

  // Lowest and highest rock y over a floor point, from the grid column nearest it; false where no rock stands.
  heightAt(x, z, out) {
    if (!this.columns) this.columns = this.buildColumns();
    const i = Math.round((x - this.x0) / this.h), k = Math.round((z - this.z0) / this.h);
    if (!(i >= 0 && k >= 0 && i < this.nx && k < this.nz)) return false;
    const c = i + this.nx * k, a = this.columns[2 * c];
    if (a !== a) return false;
    out[0] = a; out[1] = this.columns[2 * c + 1];
    return true;
  }

  buildColumns() {
    const { nx, ny, nz, codes: f } = this, cols = new Float32Array(2 * nx * nz).fill(NaN);
    const cross = (j, a, b) => this.y0 + (j + a / (a - b)) * this.h;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const base = i + nx * ny * k;
      let first = -1, last = -1;
      for (let j = 0; j < ny; j++) if (f[base + nx * j] < 0) { if (first < 0) first = j; last = j; }
      if (first < 0) continue;
      const c = 2 * (i + nx * k);
      cols[c] = first > 0 ? cross(first - 1, f[base + nx * (first - 1)], f[base + nx * first]) : this.y0;
      cols[c + 1] = last < ny - 1 ? cross(last, f[base + nx * last], f[base + nx * (last + 1)]) : this.y0 + (ny - 1) * this.h;
    }
    return cols;
  }

  // Only +, ×, ÷, and sqrt (IEEE-exact), so every engine builds the same mesh.
  mesh() {
    if (this.cachedMesh) return this.cachedMesh;
    const { nx, ny, nz, codes: f, h } = this, sxy = nx * ny, cx = nx - 1, cy = ny - 1, cz = nz - 1;
    // Past this, no corner of the cell (√3 cells away at most) can change sign.
    const far = Math.ceil(2.5 * h / this.q);
    const cellVert = new Int32Array(cx * cy * cz).fill(-1), v = new Float64Array(8), off = CORNERS.map(([a, b, c]) => a + nx * (b + ny * c));
    let pos = new Float64Array(1 << 18), np = 0;
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      const base = i + nx * (j + ny * k), f0 = f[base];
      if (f0 > far || f0 < -far) continue;
      let mask = 0;
      for (let c = 0; c < 8; c++) { v[c] = f[base + off[c]]; if (v[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let e = 0; e < 12; e++) {
        const a = EDGES[e][0], b = EDGES[e][1];
        if ((v[a] < 0) === (v[b] < 0)) continue;
        const t = v[a] / (v[a] - v[b]), A = CORNERS[a], B = CORNERS[b];
        sx += A[0] + t * (B[0] - A[0]); sy += A[1] + t * (B[1] - A[1]); sz += A[2] + t * (B[2] - A[2]); n++;
      }
      cellVert[i + cx * (j + cy * k)] = np / 3;
      pos = grow(pos, np + 3);
      pos[np++] = i + sx / n; pos[np++] = j + sy / n; pos[np++] = k + sz / n;
    }
    let idx = new Uint32Array(1 << 19), ni = 0;
    const cell = (i, j, k) => cellVert[i + cx * (j + cy * k)];
    const quad = (inP, a, b, c, d) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      idx = grow(idx, ni + 6);
      if (inP) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
      else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
    };
    // Per-axis bounds: an x edge on the first x layer has all four cells, so it closes.
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = i + nx * (j + ny * k), fp = f[p];
      if (fp > far || fp < -far) continue;
      const inP = fp < 0;
      const iIn = i > 0 && i < cx, jIn = j > 0 && j < cy, kIn = k > 0 && k < cz;
      if (i < cx && jIn && kIn && (f[p + 1] < 0) !== inP) quad(inP, cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k));
      if (j < cy && iIn && kIn && (f[p + nx] < 0) !== inP) quad(inP, cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1));
      if (k < cz && iIn && jIn && (f[p + sxy] < 0) !== inP) quad(inP, cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k));
    }
    pos = pos.subarray(0, np); idx = idx.subarray(0, ni);
    this.project(pos);
    shortDiagonals(pos, idx);
    const positions = new Float32Array(np), normals = new Float32Array(np), n3 = this.scratch;
    for (let p = 0; p < np; p += 3) {
      const x = this.x0 + pos[p] * h, y = this.y0 + pos[p + 1] * h, z = this.z0 + pos[p + 2] * h;
      positions[p] = x; positions[p + 1] = y; positions[p + 2] = z;
      this.distance(x, y, z, n3);
      normals[p] = n3[0]; normals[p + 1] = n3[1]; normals[p + 2] = n3[2];
    }
    // Projection can fold a sliver; a one-sided collider reads a back-facing triangle as a hole.
    for (let n = 0; n < ni; n += 3) {
      const a = 3 * idx[n], b = 3 * idx[n + 1], c = 3 * idx[n + 2];
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      if (fx * (normals[a] + normals[b] + normals[c]) + fy * (normals[a + 1] + normals[b + 1] + normals[c + 1]) + fz * (normals[a + 2] + normals[b + 2] + normals[c + 2]) >= 0) continue;
      const t = idx[n + 1]; idx[n + 1] = idx[n + 2]; idx[n + 2] = t;
    }
    this.cachedMesh = { positions, indices: new Uint32Array(idx), normals };
    return this.cachedMesh;
  }

  /* Closed pieces on a `size` m grid (`size` or `height` 0 for no cut along it). Each runs `pad` samples into its neighbors: true for
     one, sunk `bevel` m per sample after, then a box face, all inside the neighbor's true rock so the union stays exact. */
  chunks({ size = 0.25, height = 0.25, pad = 3, bevel = 0.003 } = {}) {
    // Under three samples the caps have no room to close inside the neighbor.
    pad = Math.max(3, Math.round(pad));
    const { nx, ny, nz, h, codes: f } = this, dims = [nx, ny, nz], cell = h / this.q;
    const cuts = (n, len) => {
      const m = len > 0 ? Math.min(n - 1, Math.max(1, Math.round((n - 1) * h / len))) : 1, out = [];
      for (let c = 0; c <= m; c++) out.push(Math.round(c * (n - 1) / m));
      return out;
    };
    const axes = [cuts(nx, size), cuts(ny, height), cuts(nz, size)], ramp = Math.round(bevel / this.q), list = [];
    // A lone piece has no neighbor to cap against, so it is the cached mesh itself.
    if (axes.every((c) => c.length === 2)) { const m = this.mesh(); return m.indices.length ? [{ positions: m.positions, indices: m.indices }] : []; }
    const s0 = [0, 0, 0], s1 = [0, 0, 0], a0 = [0, 0, 0], a1 = [0, 0, 0], g = [0, 0, 0];
    for (let cz = 0; cz < axes[2].length - 1; cz++) for (let cy = 0; cy < axes[1].length - 1; cy++) for (let cx = 0; cx < axes[0].length - 1; cx++) {
      const c = [cx, cy, cz];
      for (let a = 0; a < 3; a++) {
        s0[a] = axes[a][c[a]]; s1[a] = axes[a][c[a] + 1];
        a0[a] = Math.max(0, s0[a] - pad); a1[a] = Math.min(dims[a] - 1, s1[a] + pad);
      }
      const mx = a1[0] - a0[0] + 1, my = a1[1] - a0[1] + 1, mz = a1[2] - a0[2] + 1, sub = new Int16Array(mx * my * mz);
      let rock = false;
      for (let k = 0, p = 0; k < mz; k++) for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++, p++) {
        g[0] = a0[0] + i; g[1] = a0[1] + j; g[2] = a0[2] + k;
        let v = f[g[0] + nx * (g[1] + ny * g[2])], sink = 0, box = -32768;
        for (let a = 0; a < 3; a++) {
          const d = g[a] < s0[a] ? s0[a] - g[a] : g[a] > s1[a] ? g[a] - s1[a] : 0;
          if (d > 1) sink += d - 1;
          // A true distance to the box face, so mesh() reads clean normals and never skips a cap cell as deep rock.
          if (d) box = Math.max(box, Math.round((d - pad + 0.5) * cell));
        }
        if (box === -32768 && v < 0) rock = true;
        v = Math.min(32767, Math.max(v + ramp * sink, box));
        sub[p] = v;
      }
      if (!rock) continue;
      const piece = new Rockwork({ nx: mx, ny: my, nz: mz, x0: this.x0 + a0[0] * h, y0: this.y0 + a0[1] * h, z0: this.z0 + a0[2] * h, h, q: this.q, lo: this.lo, hi: this.hi }, sub);
      const m = piece.mesh();
      if (m.indices.length) list.push({ positions: m.positions, indices: m.indices });
    }
    return list;
  }

  // Steps capped at half a cell, so a vertex near a kink can't jump to another sheet.
  project(pos, steps = 3) {
    const { nx, ny, nz, codes: f } = this, sxy = nx * ny;
    for (let p = 0; p < pos.length; p += 3) for (let it = 0; it < steps; it++) {
      const fx = pos[p], fy = pos[p + 1], fz = pos[p + 2];
      const i = Math.min(nx - 2, Math.max(0, Math.floor(fx))), j = Math.min(ny - 2, Math.max(0, Math.floor(fy))), k = Math.min(nz - 2, Math.max(0, Math.floor(fz)));
      const u = fx - i, w = fy - j, t = fz - k, b = i + nx * (j + ny * k);
      const c000 = f[b], c100 = f[b + 1], c010 = f[b + nx], c110 = f[b + nx + 1], c001 = f[b + sxy], c101 = f[b + sxy + 1], c011 = f[b + sxy + nx], c111 = f[b + sxy + nx + 1];
      const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u, x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
      const y0 = x00 + (x10 - x00) * w, y1 = x01 + (x11 - x01) * w, val = y0 + (y1 - y0) * t;
      if (val === 0) break;
      const gz = y1 - y0, gy = (x10 - x00) * (1 - t) + (x11 - x01) * t;
      const gx = ((c100 - c000) * (1 - w) + (c110 - c010) * w) * (1 - t) + ((c101 - c001) * (1 - w) + (c111 - c011) * w) * t;
      const l2 = gx * gx + gy * gy + gz * gz;
      if (l2 < 1e-9) break;
      let s = val / l2;
      const m = Math.abs(s) * Math.sqrt(l2);
      if (m > 0.5) s *= 0.5 / m;
      pos[p] = fx - s * gx; pos[p + 1] = fy - s * gy; pos[p + 2] = fz - s * gz;
    }
  }
}

// The shorter diagonal keeps curved lips from faceting into teeth.
function shortDiagonals(pos, idx) {
  const d2 = (a, b) => { const x = pos[3 * a] - pos[3 * b], y = pos[3 * a + 1] - pos[3 * b + 1], z = pos[3 * a + 2] - pos[3 * b + 2]; return x * x + y * y + z * z; };
  for (let n = 0; n < idx.length; n += 6) {
    const a = idx[n], out = idx[n + 4] === idx[n + 2], c = out ? idx[n + 2] : idx[n + 1], b = out ? idx[n + 1] : idx[n + 2], d = out ? idx[n + 5] : idx[n + 4];
    if (d2(b, d) >= d2(a, c)) continue;
    if (out) { idx[n] = a; idx[n + 1] = b; idx[n + 2] = d; idx[n + 3] = b; idx[n + 4] = c; idx[n + 5] = d; }
    else { idx[n] = a; idx[n + 1] = d; idx[n + 2] = b; idx[n + 3] = b; idx[n + 4] = d; idx[n + 5] = c; }
  }
}
