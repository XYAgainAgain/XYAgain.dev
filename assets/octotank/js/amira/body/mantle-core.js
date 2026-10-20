/* Her body's shell, THREE-free: the spherified cube shrink-wrapped onto a smooth union of a mantle, a head with two
   eye bulges, and a flattened arm crown, then relaxed so its triangles stay even. Faces wind counter-clockwise from
   outside, which Jolt's pressure needs (an inverted shell gets no pressure and no error). */

export const SHELL_LEVELS = { 150: 6, 300: 8, 500: 10 };

/* She faces +x and +y is up, so +z (toward the glass) is her right side. Lengths are full sizes in meters,
   centers are offsets from the head's center. */
export const SHAPE_KNOBS = {
  mantleLength: 0.15,
  mantleHeight: 0.084,
  mantleWidth: 0.092,
  mantleTilt: 0.6,        // radians the mantle's long axis rises from straight back
  mantleSet: 0.08,        // head center to mantle center along that axis
  headLength: 0.062,
  headHeight: 0.056,
  headWidth: 0.07,
  neckBlend: 0.012,       // smooth-min radius between head and mantle; smaller pinches the neck in
  eyeBulge: 0.0125,       // radius of each eye's bump
  eyeSpread: 0.03,
  eyeRise: 0.016,
  eyeForward: 0.006,
  eyeBlend: 0.008,
  crownWidth: 0.088,
  crownHeight: 0.028,
  crownDrop: 0.028,
  crownForward: 0.008,
  crownBlend: 0.032,
  ringDrop: 0.35,         // the arm ring sits this fraction of the crown's half-height below its rim
  siphonBack: 0.05,       // the funnel's base, on her underside this far behind the crown's center, on the midline
  siphonRise: 0,
  wrapSet: 0.018,         // the wrap center, along the mantle axis and up from the head center
  wrapRise: 0,
  relax: 16,
  relaxStep: 0.5,
  qualityMin: 0.45,       // worst triangle shape a relaxing move may leave (1 is equilateral)
  creaseMax: 1.1,         // radians two neighboring faces may turn against each other before a relaxing move is refused
  regionBlend: 0.008,     // meters of distance over which a vertex's region weight fades
};

export const ARM_COUNT = 8;

/* `shell.eyes` order: her right eye (+z, toward the glass) first, then her left, the one she favors. */
export const EYE = { right: 0, left: 1 };

// Each face: outward axis, then the two tangents in the order whose cross product points outward.
const FACES = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];

/* Cube point to sphere point, the "spherified cube" mapping: far more even triangles than plain normalization. */
function spherify(x, y, z) {
  const x2 = x * x, y2 = y * y, z2 = z * z;
  return [
    x * Math.sqrt(1 - y2 / 2 - z2 / 2 + y2 * z2 / 3),
    y * Math.sqrt(1 - z2 / 2 - x2 / 2 + z2 * x2 / 3),
    z * Math.sqrt(1 - x2 / 2 - y2 / 2 + x2 * y2 / 3),
  ];
}

/* The sphere's topology: unit directions and outward-wound faces, 6(n−1)²+2 vertices. */
export function sphereMesh(n) {
  if (!(Number.isInteger(n) && n >= 2)) throw new Error(`sphereMesh: n must be an integer >= 2, got ${n}`);
  const keyOf = (x, y, z) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
  const index = new Map();
  const dirs = [];
  const faces = [];
  const vertexAt = (x, y, z) => {
    const k = keyOf(x, y, z);
    let i = index.get(k);
    if (i === undefined) {
      i = dirs.length / 3;
      index.set(k, i);
      dirs.push(...spherify(x, y, z));
    }
    return i;
  };
  for (const [d, u, v] of FACES) {
    const grid = new Uint32Array(n * n);
    for (let j = 0; j < n; j++) {
      const t = -1 + (2 * j) / (n - 1);
      for (let i = 0; i < n; i++) {
        const s = -1 + (2 * i) / (n - 1);
        grid[j * n + i] = vertexAt(d[0] + u[0] * s + v[0] * t, d[1] + u[1] * s + v[1] * t, d[2] + u[2] * s + v[2] * t);
      }
    }
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = grid[j * n + i], b = grid[j * n + i + 1], c = grid[(j + 1) * n + i + 1], e = grid[(j + 1) * n + i];
        // Alternate the quad diagonal so the mesh has no long bias lines across a face.
        if ((i + j) & 1) faces.push(a, b, c, a, c, e);
        else faces.push(a, b, e, b, c, e);
      }
    }
  }
  return { dirs: new Float64Array(dirs), faces: new Uint32Array(faces) };
}

/* Inigo Quilez's ellipsoid bound: the sign is exact, the distance close near the surface. */
function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 < 1e-12 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/* The body as signed distance fields in head-centered coordinates. `parts` gives each region's own distance. */
export function bodyField(knobs = {}) {
  const k = { ...SHAPE_KNOBS, ...knobs };
  const ux = -Math.cos(k.mantleTilt), uy = Math.sin(k.mantleTilt);
  const M = [ux * k.mantleSet, uy * k.mantleSet, 0];
  const ma = k.mantleLength / 2, mb = k.mantleHeight / 2, mc = k.mantleWidth / 2;
  const ha = k.headLength / 2, hb = k.headHeight / 2, hc = k.headWidth / 2;
  const ca = k.crownWidth / 2, cb = k.crownHeight / 2;
  const C = [k.crownForward, -k.crownDrop, 0];
  const eyes = [[k.eyeForward, k.eyeRise, k.eyeSpread], [k.eyeForward, k.eyeRise, -k.eyeSpread]];
  const mantle = (x, y, z) => {
    // Into the mantle's frame: its long axis along u, its height along u rotated a quarter turn up.
    const dx = x - M[0], dy = y - M[1];
    return sdEllipsoid(dx * ux + dy * uy, -dx * uy + dy * ux, z - M[2], ma, mb, mc);
  };
  const head = (x, y, z) => {
    let d = sdEllipsoid(x, y, z, ha, hb, hc);
    for (const e of eyes) d = smin(d, Math.hypot(x - e[0], y - e[1], z - e[2]) - k.eyeBulge, k.eyeBlend);
    return d;
  };
  const crown = (x, y, z) => sdEllipsoid(x - C[0], y - C[1], z - C[2], ca, cb, ca);
  const sdf = (x, y, z) => smin(smin(mantle(x, y, z), head(x, y, z), k.neckBlend), crown(x, y, z), k.crownBlend);
  // A wrap center inside both the head and the mantle, so every ray out of it crosses the skin once.
  const wrap = [ux * k.wrapSet, uy * k.wrapSet + k.wrapRise, 0];
  const reach = k.mantleSet + ma + mb + k.crownWidth + k.headLength;
  return { knobs: k, sdf, parts: { mantle, head, crown }, M, C, eyes, wrap, reach, axis: [ux, uy, 0] };
}

/* Outermost skin crossing along o + t·d (unit d), and how many times the ray crossed it on the way out. */
function rayHit(sdf, o, d, tMax, step = 0.002) {
  let crossings = 0, inside = sdf(o[0], o[1], o[2]) < 0, last = -1;
  for (let t = step; t <= tMax; t += step) {
    const now = sdf(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t) < 0;
    if (now !== inside) { if (inside) { crossings++; last = t; } inside = now; }
  }
  if (last < 0) return { t: 0, crossings };
  let lo = last - step, hi = last;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (sdf(o[0] + d[0] * mid, o[1] + d[1] * mid, o[2] + d[2] * mid) < 0) lo = mid; else hi = mid;
  }
  return { t: (lo + hi) / 2, crossings };
}

function gradient(sdf, x, y, z, out, e = 1e-4) {
  out[0] = sdf(x + e, y, z) - sdf(x - e, y, z);
  out[1] = sdf(x, y + e, z) - sdf(x, y - e, z);
  out[2] = sdf(x, y, z + e) - sdf(x, y, z - e);
  const l = Math.hypot(out[0], out[1], out[2]);
  if (l > 1e-12) { out[0] /= l; out[1] /= l; out[2] /= l; } else { out[0] = 0; out[1] = 1; out[2] = 0; }
  return out;
}

export function vertexNeighbors(faces, count) {
  const sets = Array.from({ length: count }, () => new Set());
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f + k], b = faces[f + ((k + 1) % 3)];
      sets[a].add(b); sets[b].add(a);
    }
  }
  return sets.map((s) => Int32Array.from([...s].sort((a, b) => a - b)));
}

function incidentFaces(faces, count) {
  const out = Array.from({ length: count }, () => []);
  for (let f = 0; f < faces.length; f += 3) for (let k = 0; k < 3; k++) out[faces[f + k]].push(f);
  return out;
}

/* For each face edge k, the face across it. */
function acrossFaces(faces) {
  const byEdge = new Map(), out = new Int32Array(faces.length);
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f + k], b = faces[f + ((k + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      const other = byEdge.get(key);
      if (other === undefined) byEdge.set(key, f + k);
      else { out[f + k] = other - (other % 3); out[other] = f; }
    }
  }
  return out;
}

function faceNormal(P, faces, f, out) {
  const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
  const bx = P[b] - P[a], by = P[b + 1] - P[a + 1], bz = P[b + 2] - P[a + 2];
  const cx = P[c] - P[a], cy = P[c + 1] - P[a + 1], cz = P[c + 2] - P[a + 2];
  out[0] = by * cz - bz * cy; out[1] = bz * cx - bx * cz; out[2] = bx * cy - by * cx;
  const l = Math.hypot(out[0], out[1], out[2]);
  if (l > 0) { out[0] /= l; out[1] /= l; out[2] /= l; }
  return l;
}

/* 1 for an equilateral triangle, 0 for a sliver. */
function faceQuality(P, faces, f, twiceArea) {
  const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
  const e = (i, j) => (P[i] - P[j]) ** 2 + (P[i + 1] - P[j + 1]) ** 2 + (P[i + 2] - P[j + 2]) ** 2;
  const sum = e(a, b) + e(b, c) + e(c, a);
  return sum > 0 ? (2 * Math.sqrt(3) * twiceArea) / sum : 0;
}

/* How the skin around vertex i is doing: the smallest cosine between any of its faces and the face across each
   of their edges, its worst triangle, and whether every face still faces away from the wrap center. */
const _n1 = [0, 0, 0], _n2 = [0, 0, 0];
function foldAround(P, faces, across, around, w) {
  let minCos = 1, minQ = 1, star = true;
  for (const f of around) {
    const area = faceNormal(P, faces, f, _n1);
    minQ = Math.min(minQ, faceQuality(P, faces, f, area));
    const a = faces[f] * 3;
    if (area === 0 || _n1[0] * (P[a] - w[0]) + _n1[1] * (P[a + 1] - w[1]) + _n1[2] * (P[a + 2] - w[2]) <= 0) star = false;
    for (let k = 0; k < 3; k++) {
      faceNormal(P, faces, across[f + k], _n2);
      minCos = Math.min(minCos, _n1[0] * _n2[0] + _n1[1] * _n2[1] + _n1[2] * _n2[2]);
    }
  }
  return { minCos, minQ, star };
}

/* Edge springs toward the mean edge length, sliding each vertex along the skin by re-hitting its wrap ray. A plain
   Laplacian drains vertices off a sparse tip; springs pull them into it. Vertices with a goal walk toward it instead.
   A move that turns a face toward the center, sharpens a crease, or makes a sliver is halved, then refused. */
function relax(P, nbr, around, across, faces, goals, field, iters, step, creaseCos, qualityMin) {
  const { sdf, wrap, reach } = field;
  const count = P.length / 3, d = [0, 0, 0], old = [0, 0, 0];
  for (let it = 0; it < iters; it++) {
    let sum = 0, edges = 0;
    for (let i = 0; i < count; i++) {
      for (const j of nbr[i]) {
        if (j < i) continue;
        sum += Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 1] - P[i * 3 + 1], P[j * 3 + 2] - P[i * 3 + 2]);
        edges++;
      }
    }
    const L = sum / edges;
    for (let i = 0; i < count; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      let qx = 0, qy = 0, qz = 0, s0 = step;
      const goal = goals.get(i);
      if (goal) { qx = goal[0] - x; qy = goal[1] - y; qz = goal[2] - z; s0 = 1; }
      else {
        const nb = nbr[i];
        for (const j of nb) {
          const ex = P[j * 3] - x, ey = P[j * 3 + 1] - y, ez = P[j * 3 + 2] - z;
          const len = Math.hypot(ex, ey, ez);
          if (len < 1e-12) continue;
          const f = (len - L) / len;
          qx += ex * f; qy += ey * f; qz += ez * f;
        }
        qx /= nb.length; qy /= nb.length; qz /= nb.length;
      }
      if (Math.hypot(qx, qy, qz) < 1e-9) continue;
      old[0] = x; old[1] = y; old[2] = z;
      const before = foldAround(P, faces, across, around[i], wrap);
      let moved = false;
      for (let s = s0; s > s0 / 16 && !moved; s /= 2) {
        d[0] = x + s * qx - wrap[0]; d[1] = y + s * qy - wrap[1]; d[2] = z + s * qz - wrap[2];
        const l = Math.hypot(d[0], d[1], d[2]);
        if (l < 1e-9) continue;
        d[0] /= l; d[1] /= l; d[2] /= l;
        const t = rayHit(sdf, wrap, d, reach).t;
        P[i * 3] = wrap[0] + d[0] * t; P[i * 3 + 1] = wrap[1] + d[1] * t; P[i * 3 + 2] = wrap[2] + d[2] * t;
        const after = foldAround(P, faces, across, around[i], wrap);
        // A goal may leave a crease or a sliver behind; its neighbors relax it away on the next passes.
        moved = after.star && (goal || ((after.minCos >= creaseCos || after.minCos >= before.minCos)
          && (after.minQ >= qualityMin || after.minQ >= before.minQ)));
      }
      if (!moved) { P[i * 3] = old[0]; P[i * 3 + 1] = old[1]; P[i * 3 + 2] = old[2]; }
    }
  }
}

function nearestFree(P, target, taken) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < P.length / 3; i++) {
    if (taken.has(i)) continue;
    const dd = (P[i * 3] - target[0]) ** 2 + (P[i * 3 + 1] - target[1]) ** 2 + (P[i * 3 + 2] - target[2]) ** 2;
    if (dd < bestD) { bestD = dd; best = i; }
  }
  return best;
}

/* The body shell at n points per cube edge. Positions are local to the bounding box's center, which is the point
   a posture steers; `dirs` are the unit wrap rays from `center`. */
export function buildShell(n = 8, knobs = {}) {
  const field = bodyField(knobs);
  const k = field.knobs, { sdf, wrap, reach } = field;
  const { dirs: sphere, faces } = sphereMesh(n);
  const count = sphere.length / 3;
  const P = new Float64Array(count * 3);
  let crossMax = 0;
  for (let i = 0; i < count; i++) {
    const d = [sphere[i * 3], sphere[i * 3 + 1], sphere[i * 3 + 2]];
    const h = rayHit(sdf, wrap, d, reach);
    if (!(h.t > 0)) throw new Error('buildShell: a wrap ray found no skin; the shape knobs put the wrap center outside her');
    crossMax = Math.max(crossMax, h.crossings);
    for (let a = 0; a < 3; a++) P[i * 3 + a] = wrap[a] + d[a] * h.t;
  }
  const nbr = vertexNeighbors(faces, count);
  const around = incidentFaces(faces, count);
  const across = acrossFaces(faces);
  const creaseCos = Math.cos(k.creaseMax);

  // The arm ring and the beak walk onto exact targets while the rest relaxes around them.
  const C = field.C, cb = k.crownHeight / 2;
  const ringY = C[1] - k.ringDrop * cb;
  const ringTargets = [];
  for (let r = 0; r < ARM_COUNT; r++) {
    // Arms come in mirrored pairs, so none points dead ahead: r = 0 is front-right, r grows toward her right side.
    const az = (2 * Math.PI * (r + 0.5)) / ARM_COUNT;
    const o = [C[0], ringY, C[2]], d = [Math.cos(az), 0, Math.sin(az)];
    const t = rayHit(sdf, o, d, reach).t;
    ringTargets.push([o[0] + d[0] * t, o[1], o[2] + d[2] * t]);
  }
  const beakT = rayHit(sdf, C, [0, -1, 0], reach).t;
  const beakTarget = [C[0], C[1] - beakT, C[2]];
  const taken = new Set();
  const goals = new Map();
  const roots = new Int32Array(ARM_COUNT);
  ringTargets.forEach((tg, r) => {
    const i = nearestFree(P, tg, taken);
    taken.add(i); roots[r] = i; goals.set(i, tg);
  });
  const beak = nearestFree(P, beakTarget, taken);
  taken.add(beak); goals.set(beak, beakTarget);
  relax(P, nbr, around, across, faces, goals, field, k.relax, k.relaxStep, creaseCos, k.qualityMin);

  // The eyes' outward poles and the siphon's spot on the near flank, as the vertices nearest them.
  const H = [0, 0, 0];
  const surfaceToward = (from, p) => {
    const d = [p[0] - from[0], p[1] - from[1], p[2] - from[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    // Anatomy knobs that put an anchor on the head's center leave no direction; she faces +x, so aim there.
    if (l < 1e-9) { d[0] = 1; d[1] = 0; d[2] = 0; } else { d[0] /= l; d[1] /= l; d[2] /= l; }
    const t = rayHit(sdf, from, d, reach).t;
    return [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
  };
  const eyeAt = field.eyes.map((e) => surfaceToward(H, [e[0], e[1], e[2] * 1.5]));
  const eyes = eyeAt.map((p) => { const i = nearestFree(P, p, taken); taken.add(i); return i; });
  // The funnel is ventral: it leaves the mantle opening under her head, behind the arm crown, on her midline.
  const siphonPoint = surfaceToward(H, [C[0] - k.siphonBack, C[1] + k.siphonRise, 0]);
  const siphon = nearestFree(P, siphonPoint, taken);

  // Region weights: how much of each vertex is mantle, head (eyes included), and crown.
  const regions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const w = [field.parts.mantle(x, y, z), field.parts.head(x, y, z), field.parts.crown(x, y, z)].map((d) => Math.exp(-Math.max(0, d) / k.regionBlend));
    const s = w[0] + w[1] + w[2];
    for (let a = 0; a < 3; a++) regions[i * 3 + a] = w[a] / s;
  }

  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[i * 3 + a]); hi[a] = Math.max(hi[a], P[i * 3 + a]); }
  const shift = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0];
  const positions = new Float32Array(count * 3);
  const dirs = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) positions[i * 3 + a] = P[i * 3 + a] - shift[a];
    const dx = P[i * 3] - wrap[0], dy = P[i * 3 + 1] - wrap[1], dz = P[i * 3 + 2] - wrap[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    dirs[i * 3] = dx / l; dirs[i * 3 + 1] = dy / l; dirs[i * 3 + 2] = dz / l;
  }
  return {
    n, count, positions, dirs, faces, regions, roots, beak, eyes, siphon, crossMax,
    siphonPoint: siphonPoint.map((v, a) => v - shift[a]),
    radii: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2],
    center: wrap.map((v, a) => v - shift[a]),
    crown: C.map((v, a) => v - shift[a]),
    shift,
    knobs: k,
  };
}

/* Six times the signed volume of a closed shell; positive means the winding faces outward. */
export function signedVolume6(positions, faces) {
  let v = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b] - ax, by = positions[b + 1] - ay, bz = positions[b + 2] - az;
    const cx = positions[c] - ax, cy = positions[c + 1] - ay, cz = positions[c + 2] - az;
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v;
}

/* Unique undirected edges as pairs [lo, hi], with how many faces use each. */
export function edgeUse(faces) {
  const use = new Map();
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f + k], b = faces[f + ((k + 1) % 3)];
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
}

export function uniqueEdges(faces) {
  const out = [];
  for (const key of edgeUse(faces).keys()) out.push([Math.floor(key / 1e6), key % 1e6]);
  return out;
}

/* The skin one arm base grips: every vertex within `radius` meters of its root at rest, plus the root's ring of
   neighbors so even the coarsest shell gives each arm a real patch. */
export function rootPatches(positions, roots, radius, neighbors) {
  const r2 = radius * radius;
  return Array.from(roots, (r) => {
    const out = new Set([r, ...(neighbors?.[r] ?? [])]);
    for (let i = 0; i < positions.length / 3; i++) {
      const dd = (positions[i * 3] - positions[r * 3]) ** 2 + (positions[i * 3 + 1] - positions[r * 3 + 1]) ** 2 + (positions[i * 3 + 2] - positions[r * 3 + 2]) ** 2;
      if (dd <= r2) out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  });
}

/* Edge strain stats for a live shell against its rest lengths: how far the solver is from its own settings. */
export function edgeStrain(positions, rest, edges) {
  let max = 0, sum = 0;
  for (let e = 0; e < edges.length; e++) {
    const a = edges[e][0] * 3, b = edges[e][1] * 3;
    const len = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
    const s = Math.abs(len / rest[e] - 1);
    sum += s;
    if (s > max) max = s;
  }
  return { max, mean: edges.length ? sum / edges.length : 0 };
}

export function restLengths(positions, edges) {
  const out = new Float32Array(edges.length);
  for (let e = 0; e < edges.length; e++) {
    const a = edges[e][0] * 3, b = edges[e][1] * 3;
    out[e] = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
  }
  return out;
}

/* Lift weights for the buoyant dome: linear in rest position, zero net force over the vertex masses, and aimed so
   their moment points straight up at rest, which makes her rest pose the upright equilibrium, not a pitched one. */
export function domeWeights(positions, masses) {
  const n = positions.length / 3;
  const mass = masses ?? new Float32Array(n).fill(1);
  let total = 0;
  const m = [0, 0, 0];
  for (let i = 0; i < n; i++) { total += mass[i]; for (let a = 0; a < 3; a++) m[a] += mass[i] * positions[i * 3 + a]; }
  for (let a = 0; a < 3; a++) m[a] /= total;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const d = [positions[i * 3] - m[0], positions[i * 3 + 1] - m[1], positions[i * 3 + 2] - m[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (mass[i] / total) * d[a] * d[b];
  }
  // v = C⁻¹ŷ scaled so the lift's moment matches what plain height above the center of mass would give.
  const v = solve3(C, [0, C[1][1], 0]);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = (positions[i * 3] - m[0]) * v[0] + (positions[i * 3 + 1] - m[1]) * v[1] + (positions[i * 3 + 2] - m[2]) * v[2];
  return w;
}

function solve3(A, b) {
  const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-30) return [0, 1, 0];
  const inv = [
    [(e * i - f * h) / det, (c * h - bb * i) / det, (bb * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (bb * g - a * h) / det, (a * e - bb * d) / det],
  ];
  return inv.map((row) => row[0] * b[0] + row[1] * b[1] + row[2] * b[2]);
}

/* Her crown frame: c the ring's center, axes forward (toward the front pair), up (out of her back), and side (her
   right), with the shell's extent along each axis measured from c. Roots run clockwise seen from above. */
export function crownFrame(P, count, roots, o, F) {
  const m = roots.length;
  let cx = 0, cy = 0, cz = 0;
  for (const i of roots) { cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2]; }
  cx /= m; cy /= m; cz /= m;
  let dx = 0, dy = 0, dz = 0;
  for (let k = 0; k < m; k++) {
    const a = roots[k] * 3, b = roots[(k + 1) % m] * 3;
    const ax = P[a] - cx, ay = P[a + 1] - cy, az = P[a + 2] - cz, bx = P[b] - cx, by = P[b + 1] - cy, bz = P[b + 2] - cz;
    dx += ay * bz - az * by; dy += az * bx - ax * bz; dz += ax * by - ay * bx;
  }
  let l = Math.hypot(dx, dy, dz);
  F.ok = l > 1e-12;
  if (!F.ok) return F;
  const ux = -dx / l, uy = -dy / l, uz = -dz / l;
  const a = roots[0] * 3, b = roots[m - 1] * 3;
  let fx = (P[a] + P[b]) / 2 - cx, fy = (P[a + 1] + P[b + 1]) / 2 - cy, fz = (P[a + 2] + P[b + 2]) / 2 - cz;
  const along = fx * ux + fy * uy + fz * uz;
  fx -= along * ux; fy -= along * uy; fz -= along * uz;
  l = Math.hypot(fx, fy, fz);
  F.ok = l > 1e-12;
  if (!F.ok) return F;
  fx /= l; fy /= l; fz /= l;
  const A = F.axes;
  A[0][0] = fx; A[0][1] = fy; A[0][2] = fz;
  A[1][0] = ux; A[1][1] = uy; A[1][2] = uz;
  A[2][0] = fy * uz - fz * uy; A[2][1] = fz * ux - fx * uz; A[2][2] = fx * uy - fy * ux;
  const lo = F.lo, hi = F.hi;
  lo[0] = lo[1] = lo[2] = Infinity; hi[0] = hi[1] = hi[2] = -Infinity;
  for (let i = 0; i < count; i++) {
    const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz;
    for (let k = 0; k < 3; k++) {
      const v = rx * A[k][0] + ry * A[k][1] + rz * A[k][2];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  for (let k = 0; k < 3; k++) { F.mid[k] = (lo[k] + hi[k]) / 2; F.half[k] = Math.max(1e-4, (hi[k] - lo[k]) / 2); }
  F.c[0] = cx + o[0]; F.c[1] = cy + o[1]; F.c[2] = cz + o[2];
  F.ok = Number.isFinite(F.c[0] + F.c[1] + F.c[2] + lo[0] + lo[1] + lo[2] + hi[0] + hi[1] + hi[2]);
  return F;
}

const newFrame = () => ({ ok: false, c: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], lo: [0, 0, 0], hi: [0, 0, 0], mid: [0, 0, 0], half: [1, 1, 1] });

/* Her authored body as a signed distance in world space, for points too deep in her for skin samples to reach: the
   rest field, fitted per axis to the live shell's extents in her crown frame, so it turns, inflates, and squashes
   with her. Exact at rest and close when deformed. */
export class BodyFieldFit {
  constructor(shell) {
    this.sdf = bodyField(shell.knobs).sdf;
    this.shift = shell.shift;
    this.roots = shell.roots;
    this.rest = crownFrame(shell.positions, shell.count, shell.roots, [0, 0, 0], newFrame());
    this.live = newFrame();
    this.sig = [1, 1, 1];
    this.q = [0, 0, 0];
    this.active = false;
  }

  prepare(positions, count, origin) {
    const L = crownFrame(positions, count, this.roots, origin, this.live), R = this.rest;
    this.active = L.ok && R.ok;
    for (let k = 0; k < 3; k++) this.sig[k] = L.half[k] / R.half[k];
    return this;
  }

  /* Signed distance at a world point (negative inside); the point is kept for `normal`. */
  distance(x, y, z) {
    if (!this.active) return Infinity;
    const L = this.live, R = this.rest, s = this.sig, q = this.q;
    const dx = x - L.c[0], dy = y - L.c[1], dz = z - L.c[2];
    q[0] = R.c[0] + this.shift[0]; q[1] = R.c[1] + this.shift[1]; q[2] = R.c[2] + this.shift[2];
    for (let k = 0; k < 3; k++) {
      const e = L.axes[k], e0 = R.axes[k];
      const a0 = R.mid[k] + (dx * e[0] + dy * e[1] + dz * e[2] - L.mid[k]) / s[k];
      q[0] += a0 * e0[0]; q[1] += a0 * e0[1]; q[2] += a0 * e0[2];
    }
    return this.sdf(q[0], q[1], q[2]) * Math.min(s[0], s[1], s[2]);
  }

  /* Outward unit normal at the last `distance` point: the field's gradient, stretched back through the fit. */
  normal(out) {
    const f = this.sdf, q = this.q, h = 1e-4, L = this.live, R = this.rest, s = this.sig;
    const a = f(q[0] + h, q[1] - h, q[2] - h), b = f(q[0] - h, q[1] - h, q[2] + h), c = f(q[0] - h, q[1] + h, q[2] - h), d = f(q[0] + h, q[1] + h, q[2] + h);
    const gx = a - b - c + d, gy = -a - b + c + d, gz = -a + b - c + d;
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) {
      const e0 = R.axes[k], e = L.axes[k], g = (gx * e0[0] + gy * e0[1] + gz * e0[2]) / s[k];
      nx += g * e[0]; ny += g * e[1]; nz += g * e[2];
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-12) { out[0] = nx / l; out[1] = ny / l; out[2] = nz / l; }
    else { out[0] = L.axes[1][0]; out[1] = L.axes[1][1]; out[2] = L.axes[1][2]; }
    return out;
  }
}

/* Her breathing, shaped like the real thing: resting O. vulgaris take 17.7 ± 3.3 breaths a minute, and the inhale is
   under a third of the cycle. Effort deepens breaths more than it speeds them, and arousal speeds them. */
export const BREATH_KNOBS = {
  breathRate: 18,         // breaths a minute at rest
  breathRateMax: 33,      // the hypoxic maximum measured, 33.3 ± 5.9 a minute; no state takes her past it
  breathDepth: 0.035,     // share of her volume a resting breath moves, about 3–4%; 0 holds her breath
  breathInhale: 0.3,      // the inhale's share of a cycle
  breathShow: 1,          // readability: multiplies the depth so the breath reads from the glass; 1 is real size
  effort: 0,              // 0–1, set by the brain later: work deepens breaths
  arousal: 0,             // 0–1, set by the brain later: a startle or a new smell speeds them
  effortDepth: 2.5,       // depth and rate at full effort; their product is the 3× ventilation measured after exercise
  effortRate: 1.2,
  arousalRate: 1.85,      // full arousal lands at the measured maximum rate
  breathFull: -0.6,       // along the mantle's axis (−1 its front end at the opening, +1 its tip), full weight up to here
  breathStart: 0,         // and none from here back: the breath lives in the front half of the mantle
};

/* The rate (breaths a minute) and depth (share of her volume) her state asks for right now. */
export function breathPace(k, out = { rate: 0, depth: 0 }) {
  const e = clamp01(k.effort), a = clamp01(k.arousal);
  out.rate = Math.max(0, Math.min(k.breathRateMax, k.breathRate * (1 + (k.effortRate - 1) * e) * (1 + (k.arousalRate - 1) * a)));
  out.depth = Math.max(0, k.breathDepth * (1 + (k.effortDepth - 1) * e) * k.breathShow);
  return out;
}

/* The inhale's share of a cycle, kept sane: a NaN here would reach every vertex's velocity. */
export function inhaleShare(inhale) { return Number.isFinite(inhale) ? Math.min(0.9, Math.max(0.1, inhale)) : 0.3; }

/* 0 drawn in, 1 breathed out, at phase u of a cycle that inhales over its first `inhale` share. */
export function exhaleAt(u, inhale) {
  const a = inhaleShare(inhale);
  u -= Math.floor(u);
  return u < a ? 1 - smoothstep01(u / a) : smoothstep01((u - a) / (1 - a));
}

/* How much each vertex's own muscle works in a breath: the mantle's front half, strongest at its opening by the
   neck, and nothing in the head, the crown, or the back of the mantle. */
export function breathWeights(shell, knobs = {}) {
  const k = { ...BREATH_KNOBS, ...knobs };
  const f = bodyField(shell.knobs), [ux, uy] = f.axis, half = f.knobs.mantleLength / 2;
  const span = Math.max(1e-6, k.breathStart - k.breathFull);
  const out = new Float32Array(shell.count);
  for (let i = 0; i < shell.count; i++) {
    const x = shell.positions[i * 3] + shell.shift[0] - f.M[0], y = shell.positions[i * 3 + 1] + shell.shift[1] - f.M[1];
    const t = (x * ux + y * uy) / half;
    // Region weights fade over a few millimeters, so the eyes and roots keep a trace of mantle; only real mantle breathes.
    out[i] = smoothstep01((shell.regions[i * 3] - 0.25) / 0.5) * smoothstep01((k.breathStart - t) / span);
  }
  return out;
}

/* Per-vertex outward area vectors (a third of each face's area along its normal), the skin a pressure pushes on. */
export function vertexAreas(P, faces, out) {
  out.fill(0);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const bx = P[b] - P[a], by = P[b + 1] - P[a + 1], bz = P[b + 2] - P[a + 2];
    const cx = P[c] - P[a], cy = P[c + 1] - P[a + 1], cz = P[c + 2] - P[a + 2];
    const nx = (by * cz - bz * cy) / 6, ny = (bz * cx - bx * cz) / 6, nz = (bx * cy - by * cx) / 6;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  return out;
}

/* The rigid spin ω with I·ω = L for points P (masses m) about center c, solved by the inertia tensor's adjugate. */
export function spinFor(P, m, n, cx, cy, cz, lx, ly, lz, out) {
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < n; i++) {
    const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz, w = m[i];
    xx += w * rx * rx; yy += w * ry * ry; zz += w * rz * rz; xy += w * rx * ry; xz += w * rx * rz; yz += w * ry * rz;
  }
  const a = yy + zz, b = -xy, c = -xz, d = xx + zz, e = -yz, f = xx + yy;
  const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-30)) { out[0] = out[1] = out[2] = 0; return out; }
  out[0] = (A * lx + B * ly + C * lz) / det;
  out[1] = (B * lx + (a * f - c * c) * ly + (b * c - a * e) * lz) / det;
  out[2] = (C * lx + (b * c - a * e) * ly + (a * d - b * b) * lz) / det;
  return out;
}

/* Make per-point accelerations A internal in place: 'force' takes out their net force, 'both' their net torque about
   the center of mass as well, so a muscle field can deform her but never walk or spin her. */
export function neutralizeAccel(A, P, m, n, mode, spin = [0, 0, 0]) {
  if (mode !== 'force' && mode !== 'both') return A;
  let fx = 0, fy = 0, fz = 0, M = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const w = m[i];
    fx += w * A[i * 3]; fy += w * A[i * 3 + 1]; fz += w * A[i * 3 + 2]; M += w;
    cx += w * P[i * 3]; cy += w * P[i * 3 + 1]; cz += w * P[i * 3 + 2];
  }
  if (!(M > 0)) return A;
  fx /= M; fy /= M; fz /= M; cx /= M; cy /= M; cz /= M;
  let tx = 0, ty = 0, tz = 0;
  for (let i = 0; i < n; i++) {
    const ax = (A[i * 3] -= fx), ay = (A[i * 3 + 1] -= fy), az = (A[i * 3 + 2] -= fz);
    const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz, w = m[i];
    tx += w * (ry * az - rz * ay); ty += w * (rz * ax - rx * az); tz += w * (rx * ay - ry * ax);
  }
  if (mode !== 'both') return A;
  const s = spinFor(P, m, n, cx, cy, cz, tx, ty, tz, spin);
  for (let i = 0; i < n; i++) {
    const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz;
    A[i * 3] -= s[1] * rz - s[2] * ry; A[i * 3 + 1] -= s[2] * rx - s[0] * rz; A[i * 3 + 2] -= s[0] * ry - s[1] * rx;
  }
  return A;
}

/* Her eyes. Pupils are W-shaped, a cuttlefish trait kept as an Osminoki one: a W in bright light, round in the dark. */
export const EYE_KNOBS = {
  light: 0.6,             // 0 dark to 1 bright, until the tank has a lighting cycle
  pupilHalf: 0.8,         // s to close or open halfway; the measured half-constriction is 0.5–1.3 s
  pupilRound: 0.45,       // the dark pupil's radius, as a fraction of the eye's
  pupilW: 0.62,           // the bright W's half-width, its rise, and its stroke, as fractions of the eye's radius
  pupilWRise: 0.12,
  pupilWStroke: 0.07,
  eyeTurn: 1.4,           // rad each eye turns from rest on its own: about 80° measured
  eyeAhead: 0.15,         // rad each eye's resting aim turns forward from straight out to its side
  levelLag: 0.35,         // s: the statocysts' catch-up once the error is past the dead band (gain and lag unmeasured)
  levelDead: 0.06,        // rad of tilt the eyes let stand; tracking stops again under a third of it
  levelGain: 0.9,         // share of a tilt the eyes take back
  gazeTime: 0.06,         // s: how quickly an eye swings to a new aim
  saccadeMin: 0.8,        // s between idle glances, at random in this range
  saccadeMax: 3.2,
  saccadeCone: 0.45,      // rad an idle glance strays from the eye's rest aim
  favor: 0.6,             // rad: how much farther she will turn her left eye than her right before switching
};

/* The pupil as a band across the eye: column j's top and bottom points (x, y in eye radii), from a W at open 0 to
   a disk at open 1. A disk is a band whose half-height is a semicircle, so one mesh morphs between them. */
export function pupilBand(open, columns, k = EYE_KNOBS, out = new Float32Array((columns + 1) * 4)) {
  const o = clamp01(open);
  for (let j = 0; j <= columns; j++) {
    const s = -1 + (2 * j) / columns;
    const wy = k.pupilWRise * Math.cos(2 * Math.PI * s) * (0.75 + 0.25 * s * s);
    const wh = k.pupilWStroke * Math.sqrt(Math.max(0, 1 - s ** 6));
    const dh = k.pupilRound * Math.sqrt(Math.max(0, 1 - s * s));
    const x = (k.pupilW + (k.pupilRound - k.pupilW) * o) * s, y = wy * (1 - o), h = wh + (dh - wh) * o;
    out[j * 4] = x; out[j * 4 + 1] = y + h; out[j * 4 + 2] = x; out[j * 4 + 3] = y - h;
  }
  return out;
}

/* The statocysts' sense of up, in her body frame: it holds still inside the dead band and, past it, catches up with
   a lag until it is within a third of the band, so tilting one way and back leaves it on the side it came from. */
export function levelStep(st, up, dt, k = EYE_KNOBS) {
  const e = st.est, dot = e[0] * up[0] + e[1] * up[1] + e[2] * up[2];
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (angle > k.levelDead) st.tracking = true;
  else if (angle < k.levelDead / 3) st.tracking = false;
  if (st.tracking && dt > 0) {
    const s = 1 - Math.exp(-dt / Math.max(1e-3, k.levelLag));
    for (let a = 0; a < 3; a++) e[a] += (up[a] - e[a]) * s;
    const l = Math.hypot(e[0], e[1], e[2]);
    if (l > 1e-9) for (let a = 0; a < 3; a++) e[a] /= l; else { e[0] = up[0]; e[1] = up[1]; e[2] = up[2]; }
  }
  return st;
}

/* `want` pulled back inside a cone of `max` radians around `rest` (both unit). */
export function clampCone(rest, want, max, out = [0, 0, 0]) {
  const dot = rest[0] * want[0] + rest[1] * want[1] + rest[2] * want[2];
  if (dot >= Math.cos(max)) { out[0] = want[0]; out[1] = want[1]; out[2] = want[2]; return out; }
  let px = want[0] - rest[0] * dot, py = want[1] - rest[1] * dot, pz = want[2] - rest[2] * dot;
  let l = Math.hypot(px, py, pz);
  if (l < 1e-9) {
    // Straight behind the eye: any side will do, so take the one nearest her up.
    px = -rest[0] * rest[1]; py = 1 - rest[1] * rest[1]; pz = -rest[2] * rest[1];
    l = Math.hypot(px, py, pz);
    if (l < 1e-9) { px = 1; py = 0; pz = 0; l = 1; }
  }
  const c = Math.cos(max), s = Math.sin(max) / l;
  out[0] = rest[0] * c + px * s; out[1] = rest[1] * c + py * s; out[2] = rest[2] * c + pz * s;
  return out;
}

function clamp01(v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
function smoothstep01(u) { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); }
