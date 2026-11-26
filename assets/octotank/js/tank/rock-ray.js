/* Rays against the rockwork's distance field: a few dozen field reads against the mesh's every triangle. THREE-free; the
   adapter builds its vectors from the raycaster's Vector3 class. */

const RELAX = 0.8;       // the trilinear field can read long between samples
const MIN_STEP = 5e-4;   // m
const MAX_STEPS = 4096;
const REFINE = 12;

/* First entry into rock along o + t·d (d unit) with t in [tMin, tMax], as a front-facing triangle would report it.
   Writes { t, point, normal } into `out` and returns t, or -1. A ray starting inside rock finds the next entry. */
export function traceRock(field, ox, oy, oz, dx, dy, dz, tMin = 0, tMax = Infinity, out = hitRecord()) {
  const n = out.normal;
  let t0 = Math.max(0, tMin), t1 = tMax;
  // The bake's bounds hold every rock sample; a centimeter wider covers the surface past the last one.
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz, d = a === 0 ? dx : a === 1 ? dy : dz, lo = field.lo[a] - 0.01, hi = field.hi[a] + 0.01;
    if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) return -1; continue; }
    const ta = (lo - o) / d, tb = (hi - o) / d;
    t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (!(t0 <= t1)) return -1;
  let t = t0, prevT = t0, prevD = field.distance(ox + dx * t, oy + dy * t, oz + dz * t, n);
  if (!(prevD === prevD)) return -1;
  for (let i = 0; i < MAX_STEPS && t <= t1; i++) {
    // Inside rock the same bound carries the ray out; only a crossing inward is a hit.
    t += Math.max(Math.abs(prevD) * RELAX, MIN_STEP);
    if (t > t1) t = t1;
    const d = field.distance(ox + dx * t, oy + dy * t, oz + dz * t, n);
    if (prevD > 0 && d <= 0) return refine(field, ox, oy, oz, dx, dy, dz, prevT, prevD, t, d, out);
    prevT = t; prevD = d;
    if (t >= t1) break;
  }
  return -1;
}

// Regula falsi with the Illinois fix, to a micrometer bracket.
function refine(field, ox, oy, oz, dx, dy, dz, ta, da, tb, db, out) {
  const n = out.normal;
  let side = 0, t = tb;
  for (let i = 0; i < REFINE && tb - ta > 1e-6; i++) {
    t = da === db ? (ta + tb) / 2 : ta + (tb - ta) * da / (da - db);
    if (!(t > ta && t < tb)) t = (ta + tb) / 2;
    const d = field.distance(ox + dx * t, oy + dy * t, oz + dz * t, n);
    if (d > 0) { ta = t; da = d; if (side === 1) db /= 2; side = 1; }
    else { tb = t; db = d; if (side === -1) da /= 2; side = -1; }
  }
  t = da === db ? (ta + tb) / 2 : ta + (tb - ta) * da / (da - db);
  out.t = t;
  out.point[0] = ox + dx * t; out.point[1] = oy + dy * t; out.point[2] = oz + dz * t;
  field.distance(out.point[0], out.point[1], out.point[2], n);
  return t;
}

export const hitRecord = () => ({ t: -1, point: [0, 0, 0], normal: [0, 0, 0] });

/* A stand-in for the rock mesh's raycast: `mesh.raycast = rockRaycast(field, positions)`. Pushes the nearest hit in
   Three's intersection shape; with the mesh's `positions`, `face` names its nearest vertex for vertex tracking. */
export function rockRaycast(field, positions = null) {
  const hit = hitRecord(), inv = new Float64Array(12);
  let near = null;
  return function raycast(raycaster, intersects) {
    const { origin: O, direction: D } = raycaster.ray, e = this.matrixWorld.elements;
    if (!invertAffine(e, inv)) return;
    const ox = inv[0] * O.x + inv[3] * O.y + inv[6] * O.z + inv[9], oy = inv[1] * O.x + inv[4] * O.y + inv[7] * O.z + inv[10], oz = inv[2] * O.x + inv[5] * O.y + inv[8] * O.z + inv[11];
    let dx = inv[0] * D.x + inv[3] * D.y + inv[6] * D.z, dy = inv[1] * D.x + inv[4] * D.y + inv[7] * D.z, dz = inv[2] * D.x + inv[5] * D.y + inv[8] * D.z;
    const s = Math.hypot(dx, dy, dz), w = Math.hypot(D.x, D.y, D.z);
    if (!(s > 0 && w > 0)) return;
    dx /= s; dy /= s; dz /= s;
    // Local length per world length, so near and far keep their world meaning.
    const k = s / w;
    if (traceRock(field, ox, oy, oz, dx, dy, dz, raycaster.near * k, raycaster.far * k, hit) < 0) return;
    const V = O.constructor, p = hit.point, m = hit.normal;
    const point = new V(e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]);
    // Normals go back through the inverse transpose.
    const normal = new V(inv[0] * m[0] + inv[1] * m[1] + inv[2] * m[2], inv[3] * m[0] + inv[4] * m[1] + inv[5] * m[2], inv[6] * m[0] + inv[7] * m[1] + inv[8] * m[2]).normalize();
    let face = null;
    if (positions) {
      near ??= vertexGrid(positions);
      const v = near(p[0], p[1], p[2]);
      if (v >= 0) face = { a: v, b: v, c: v, normal: normal.clone(), materialIndex: 0 };
    }
    intersects.push({ distance: point.distanceTo(O), point, normal, face, faceIndex: null, barycoord: null, object: this });
  };
}

// Column-major 4×4 → the 3×4 affine inverse, columns of three.
function invertAffine(e, o) {
  const a = e[0], b = e[4], c = e[8], d = e[1], f = e[5], g = e[9], h = e[2], i = e[6], j = e[10];
  const A = f * j - g * i, B = g * h - d * j, C = d * i - f * h, det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-18)) return false;
  const r = 1 / det;
  o[0] = A * r; o[3] = (c * i - b * j) * r; o[6] = (b * g - c * f) * r;
  o[1] = B * r; o[4] = (a * j - c * h) * r; o[7] = (c * d - a * g) * r;
  o[2] = C * r; o[5] = (b * h - a * i) * r; o[8] = (a * f - b * d) * r;
  const tx = e[12], ty = e[13], tz = e[14];
  o[9] = -(o[0] * tx + o[3] * ty + o[6] * tz); o[10] = -(o[1] * tx + o[4] * ty + o[7] * tz); o[11] = -(o[2] * tx + o[5] * ty + o[8] * tz);
  return true;
}

// Nearest mesh vertex within a 2 cm hash cell's neighbors; -1 past them.
function vertexGrid(P, cell = 0.02) {
  const map = new Map(), key = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  for (let v = 0; v < P.length / 3; v++) {
    const id = key(Math.floor(P[3 * v] / cell), Math.floor(P[3 * v + 1] / cell), Math.floor(P[3 * v + 2] / cell));
    let list = map.get(id);
    if (!list) map.set(id, list = []);
    list.push(v);
  }
  return (x, y, z) => {
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell), ck = Math.floor(z / cell);
    let best = -1, bd = Infinity;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (let k = ck - 1; k <= ck + 1; k++) {
      for (const v of map.get(key(i, j, k)) ?? []) {
        const d = (P[3 * v] - x) ** 2 + (P[3 * v + 1] - y) ** 2 + (P[3 * v + 2] - z) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best;
  };
}
