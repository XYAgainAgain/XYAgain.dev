import { neutralizeAccel } from '../body/mantle-core.js';

/* The squeeze without THREE or Jolt: whether her hard parts fit a slot, the route through an aperture, which arms
   thread it, where a far hold lands, and the lengthening muscle field. loco-squeeze.js runs it on her body. */

export const SQUEEZE_KNOBS = {
  eyeD: 0.017,            // m, measured 15–20 mm (Hanke and Kelber 2020); eyes lie along a horizontal slot's width
  capsuleD: 0.020,        // m, the brain capsule (design: unmeasured for a 1 kg O. vulgaris)
  beakD: 0.012,           // m (design: unmeasured here)
  skinMin: 0.003,         // m of soft tissue kept over a hard part on each side (design)
  approachOff: 0.02,      // m off the near face she climbs to: on the face's plane the climb's reaches find rock (design)
  approachR: 0.04,        // m: centered over the slot when her crown is this close to it in the face's plane (design)
  haulLead: 0.25,         // m past the exit point her travel aims while she hauls, about her length, so it never arrives early (design)
  exitOff: 0.08,          // m past the far face the first reaches aim for (design)
  edgeMargin: 0.1,        // m kept from the slot's ends across its width (design)
  alignCos: 0.921,        // cos 0.4: her mantle trails straight back from the slot once mantleAxis · −normal passes this (design)
  nearHoldsMin: 3,        // holds on the near face before threading starts (design)
  centerMax: 8,           // s she waits to line up before threading anyway (design)
  turnK: 20,               // 1/s² per radian turning her mantle onto the slot's line, only while two arms hold (design)
  turnDamp: 3,            // 1/s on her spin about that turn (design)
  threadMax: 4,           // arms through the slot at once: 3–4 fit a 70 mm slot at the 14 mm root (derived)
  threadMin: -0.2,        // an arm whose bearing scores under this never threads (design)
  farHoldsMin: 2,         // far holds planted before she exhales and hauls (design)
  farDrop: 0.07,          // m below the slot's lower edge a re-reach lands on the far face (design)
  lipArc: 1.15,           // a first reach's contact sits this many chords out along the arm, so it bows over the lip (design)
  lipAngle: 0.7,          // rad from the lower lip's top toward the far side where a first reach lands (design)
  faceOff: 0.01,          // m off the far face a re-reach aims, about an arm's radius, so the target never sits in rock (design)
  nearDrop: 0.05,         // m outside the slot's band a near-face hold lands (design)
  farTol: 0.0,            // m past the slot's center plane a hold must lie to count as far (design)
  cavityShare: 0.06,      // of her volume the full exhale sends out (design: a breath moves 3–4%, the cavity is unmeasured)
  lengthenTarget: 1.2,    // her length along the slot, over rest, while inside (design; thins her to 0.91× across, derived)
  lengthenK: 150,         // 1/s² at full drive (design, tuned by measurement)
  capHaul: 8,             // N a far hold hauls with (design: the visible stretch that recovers, Body Rework Report)
  threadSpread: 0.1,      // m across the slot's width each threading arm's target leads its root by, along its bearing (design)
  squeezeLimit: 90,       // s the scenario allows for the whole passage (design)
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/* The widest hard part plus skin on both sides, against the slot's height. A 1e-9 m slack keeps 26 mm exactly passing. */
export function hardMin(k = SQUEEZE_KNOBS) { return Math.max(k.eyeD, k.capsuleD, k.beakD) + 2 * k.skinMin; }
export function hardFit(gapH, k = SQUEEZE_KNOBS) { return Number.isFinite(gapH) && hardMin(k) <= gapH + 1e-9; }

/* Signed distance of p from an aperture's center plane along its normal. */
export function planeSide(p, ap) {
  const c = ap.center, n = ap.normal;
  return (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2];
}

/* The route from her crown c to target t when they lie on opposite sides of a full-span panel: the nearest aperture,
   the travel normal `dir` (its normal, signed toward t), and the waypoints at her own spot across the slot's width.
   `near` is where she climbs to, `center` the slot's middle there, `exit` just past the far face. Null with none. */
export function routeThrough(c, t, apertures, k = SQUEEZE_KNOBS) {
  let best = null, bd = Infinity;
  for (const ap of apertures ?? []) {
    const sc = planeSide(c, ap), st = planeSide(t, ap);
    if (!(Number.isFinite(sc) && Number.isFinite(st)) || sc * st >= 0) continue;
    const d = Math.abs(sc) + Math.abs(c[1] - ap.center[1]);
    if (d < bd) { bd = d; best = ap; }
  }
  if (!best) return null;
  const s = planeSide(t, best) > 0 ? 1 : -1, n = best.normal, ctr = best.center;
  const dir = [n[0] * s + 0, n[1] * s + 0, n[2] * s + 0];
  // Across the slot's width (horizontal, perpendicular to the normal) she keeps her own place, short of its ends.
  const wx = -n[2], wz = n[0], wl = Math.hypot(wx, wz) || 1, w = [wx / wl, 0, wz / wl];
  const off = clamp((c[0] - ctr[0]) * w[0] + (c[2] - ctr[2]) * w[2], -best.halfW + k.edgeMargin, best.halfW - k.edgeMargin);
  const center = [ctr[0] + w[0] * off, ctr[1], ctr[2] + w[2] * off];
  const at = (m) => [center[0] + dir[0] * m, center[1] + dir[1] * m, center[2] + dir[2] * m];
  return { ap: best, dir, width: w, center, near: at(-(best.thick / 2 + k.approachOff)), exit: at(best.thick / 2 + k.exitOff), fits: hardFit(2 * best.halfH, k) };
}

/* How well an arm with outward bearing n threads a slot: along the travel, never across the lips (height axis h). */
export function threadScore(n, dir, h = [0, 1, 0]) { return dot(n, dir) - Math.abs(dot(n, h)); }

/* The arms that thread: the best `count` scores at or over threadMin, among those `free` allows. */
export function pickThreaders(scores, free, count, k = SQUEEZE_KNOBS) {
  const idx = [];
  for (let a = 0; a < scores.length; a++) if (free[a] && scores[a] >= k.threadMin && Number.isFinite(scores[a])) idx.push(a);
  idx.sort((x, y) => scores[y] - scores[x] || x - y);
  return idx.slice(0, Math.max(0, count));
}

/* A first reach: the exit point at the root's own place across the width, led along the arm's bearing so threading
   arms fan out instead of piling up. */
export function threadTarget(route, root, n, k, out) {
  const w = route.width, half = route.ap.halfW - k.edgeMargin;
  const off = clamp((root[0] - route.center[0]) * w[0] + (root[2] - route.center[2]) * w[2] + dot(n, w) * k.threadSpread, -half, half);
  out[0] = route.exit[0] + w[0] * off; out[1] = route.exit[1]; out[2] = route.exit[2] + w[2] * off;
  return out;
}

/* A first reach: the far shoulder of the slot's lower lip, at the root's place across the width; the arm lies along the
   slot's floor and its suckers seal over the lip's far side. The lip is the bullnose round of the panel's half thickness. */
export function lipPoint(route, root, k, out) {
  threadTarget(route, root, [0, 0, 0], k, out);
  const r = route.ap.thick / 2, R = r + k.faceOff, s = Math.sin(k.lipAngle), c = Math.cos(k.lipAngle), back = route.ap.thick / 2 + k.exitOff;
  out[0] += route.dir[0] * (s * R - back); out[1] = route.center[1] - route.ap.halfH - r + c * R; out[2] += route.dir[2] * (s * R - back);
  return out;
}

/* A re-reach: on the far face below the slot at that same place across the width, so the haul runs through and down. */
export function farHoldPoint(route, root, k, out) {
  threadTarget(route, root, [0, 0, 0], k, out);
  const m = k.faceOff - k.exitOff;
  out[0] += route.dir[0] * m; out[1] = route.center[1] - route.ap.halfH - k.farDrop; out[2] += route.dir[2] * m;
  return out;
}

/* A hold on the near face to line up on: the root's own spot carried along its bearing, kept off the slot's band so it
   lands on rock, not in the gap. */
export function nearHoldPoint(route, root, n, k, out) {
  const w = route.width, half = route.ap.halfW - k.edgeMargin, m = -(route.ap.thick / 2 + k.faceOff);
  const off = clamp((root[0] - route.center[0]) * w[0] + (root[2] - route.center[2]) * w[2] + dot(n, w) * k.threadSpread, -half, half);
  let dy = root[1] - route.center[1] + n[1] * k.threadSpread;
  const band = route.ap.halfH + k.nearDrop;
  if (Math.abs(dy) < band) dy = dy < 0 ? -band : band;
  out[0] = route.center[0] + route.dir[0] * m + w[0] * off; out[1] = route.center[1] + dy; out[2] = route.center[2] + route.dir[2] * m + w[2] * off;
  return out;
}

/* A hold on the near face, whose outward normal faces back against the travel. */
export function isNearHold(nrm, route, cos = 0.7) { return -dot(nrm, route.dir) > cos; }

/* A hold counts as far once it lies past the slot's center plane along the travel. */
export function isFarHold(p, route, tol = 0) {
  const c = route.center, d = route.dir;
  return (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1] + (p[2] - c[2]) * d[2] > tol;
}

/* Shell vertices (local positions P plus origin) behind the near face and past the far face along dir, and `lead`, how
   far her foremost vertex lies past the near face (negative while she is all behind it). */
export function faceCounts(P, origin, n, route, out = { behind: 0, past: 0, inside: 0, lead: 0 }) {
  const c = route.center, d = route.dir, h = route.ap.thick / 2;
  out.behind = 0; out.past = 0; out.inside = 0;
  let lead = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = (P[i * 3] + origin[0] - c[0]) * d[0] + (P[i * 3 + 1] + origin[1] - c[1]) * d[1] + (P[i * 3 + 2] + origin[2] - c[2]) * d[2];
    if (s < -h) out.behind++; else if (s > h) out.past++; else out.inside++;
    if (s > lead) lead = s;
  }
  out.lead = n > 0 ? lead + h : 0;
  return out;
}

/* The unit axis between two weightings of the same points (from wFrom's centroid to wTo's), as mantleAxis derives it. */
export function weightedAxis(P, wFrom, wTo, n, out = [0, 0, 0]) {
  let ax = 0, ay = 0, az = 0, A = 0, bx = 0, by = 0, bz = 0, B = 0;
  for (let i = 0; i < n; i++) {
    const a = wFrom[i], b = wTo[i], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    ax += a * x; ay += a * y; az += a * z; A += a;
    bx += b * x; by += b * y; bz += b * z; B += b;
  }
  if (!(A > 0 && B > 0)) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  const dx = bx / B - ax / A, dy = by / B - ay / A, dz = bz / B - az / A, l = Math.hypot(dx, dy, dz);
  if (l > 1e-9) { out[0] = dx / l; out[1] = dy / l; out[2] = dz / l; } else { out[0] = 0; out[1] = 1; out[2] = 0; }
  return out;
}

/* Her length along an axis, two ways: the full extent (max − min) and the mass-weighted RMS spread, which a few stray
   vertices can't jolt. */
export function lengthAlong(P, m, n, axis, out = { extent: 0, rms: 0 }) {
  let M = 0, s1 = 0;
  for (let i = 0; i < n; i++) { M += m[i]; s1 += m[i] * (P[i * 3] * axis[0] + P[i * 3 + 1] * axis[1] + P[i * 3 + 2] * axis[2]); }
  const mean = M > 0 ? s1 / M : 0;
  let lo = Infinity, hi = -Infinity, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = P[i * 3] * axis[0] + P[i * 3 + 1] * axis[1] + P[i * 3 + 2] * axis[2];
    lo = Math.min(lo, s); hi = Math.max(hi, s); s2 += m[i] * (s - mean) ** 2;
  }
  out.extent = n > 0 ? hi - lo : 0;
  out.rms = M > 0 ? Math.sqrt(s2 / M) : 0;
  return out;
}

/* The lengthening drive: full until she is half way to lengthenTarget, easing to none at it. ratio is length over rest. */
export function lengthenGain(ratio, k = SQUEEZE_KNOBS) {
  const span = Math.max(1e-6, k.lengthenTarget - 1);
  return k.lengthenK * clamp(2 * (k.lengthenTarget - ratio) / span, 0, 1);
}

/* The lengthening muscle: outward along the axis in proportion to each vertex's offset along it, inward across it at
   half the rate, about the mass centroid. Axial strain ε with two transverse −ε/2 sums to zero, so the field has no
   divergence and moves no volume to first order; neutralized, it carries no net force or torque either. */
export function lengthenField(P, m, n, axis, K, out, neutral = true) {
  let M = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { M += m[i]; cx += m[i] * P[i * 3]; cy += m[i] * P[i * 3 + 1]; cz += m[i] * P[i * 3 + 2]; }
  if (!(M > 0) || !(K > 0)) { out.fill(0, 0, n * 3); return out; }
  cx /= M; cy /= M; cz /= M;
  const ax = axis[0], ay = axis[1], az = axis[2];
  for (let i = 0; i < n; i++) {
    const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz, s = rx * ax + ry * ay + rz * az;
    out[i * 3] = K * (1.5 * s * ax - 0.5 * rx); out[i * 3 + 1] = K * (1.5 * s * ay - 0.5 * ry); out[i * 3 + 2] = K * (1.5 * s * az - 0.5 * rz);
  }
  return neutral ? neutralizeAccel(out, P, m, n, 'both') : out;
}

/* A turn about her mass centroid carrying her mantle axis toward `want` at K per radian, less `damp` times her spin about
   that same line (`spin`, rad/s); with per-vertex weights w only those parts swing (her mantle on her neck), and the
   caller takes the net force out. A stand-in for her holding arms and her own muscles turning her. */
export function turnField(P, m, n, axis, want, K, damp, spin, out, w = null) {
  out.fill(0, 0, n * 3);
  const kx = axis[1] * want[2] - axis[2] * want[1], ky = axis[2] * want[0] - axis[0] * want[2], kz = axis[0] * want[1] - axis[1] * want[0];
  const s = Math.hypot(kx, ky, kz), c = dot(axis, want);
  if (!(s > 1e-6) || !(K > 0)) return out;
  const ang = Math.atan2(s, c), ux = kx / s, uy = ky / s, uz = kz / s;
  const alpha = K * ang - damp * (Number.isFinite(spin) ? spin : 0);
  let M = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { M += m[i]; cx += m[i] * P[i * 3]; cy += m[i] * P[i * 3 + 1]; cz += m[i] * P[i * 3 + 2]; }
  if (!(M > 0)) return out;
  cx /= M; cy /= M; cz /= M;
  for (let i = 0; i < n; i++) {
    const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz;
    const g = w ? alpha * w[i] : alpha;
    out[i * 3] = g * (uy * rz - uz * ry); out[i * 3 + 1] = g * (uz * rx - ux * rz); out[i * 3 + 2] = g * (ux * ry - uy * rx);
  }
  return out;
}

/* The breath held at a full exhale: depth is a breath's peak-to-peak swing, and a full exhale holds half of it below
   the middle, so emptying cavityShare from rest takes twice that depth (derived from the breath's calibration). */
export function cavityHold(k = SQUEEZE_KNOBS) { return { exhale: 1, depth: 2 * k.cavityShare, outflow: 0 }; }
