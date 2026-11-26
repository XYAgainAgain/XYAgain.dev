import { neutralizeAccel } from '../body/mantle-core.js';
import { passageAt, passageTangent, passageValue, passageProject, passageOut } from './loco-passage-core.js';

/* The squeeze without THREE or Jolt: whether she fits a slot or a passage, the route through either, which arms thread
   it, where its holds land, and the lengthening muscle field. loco-squeeze.js runs it on her body. */

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
  capHaul: 14,            // N a far hold hauls with (design: the visible stretch that recovers, Body Rework Report)
  threadSpread: 0.1,      // m across the slot's width each threading arm's target leads its root by, along its bearing (design)
  squeezeLimit: 90,       // s the scenario allows for the whole passage (design)
  tunnels: true,          // passages fitted from the layout's squeeze zones route a desire that asks for one
  fitKeep: 0.8,           // share of her settled volume a passage's narrowest section must let her keep (KEEP_TABLE)
  easyKeep: 0.95,         // a section that keeps this much asks no exhale and no lengthening of her
  tunnelBack: 0.12,       // m outside the entry mouth along the centerline she lines up at, about half her length
  tunnelR: 0.05,          // m from that point that counts as there
  tunnelTurn: 0.2,        // m from it she starts turning onto the line on her feet
  tunnelSide: 0.15,       // m her crown may lie off the line at a mouth to thread from there (low tunnel: 0.097 measured)
  reachIn: 0.08,          // m into the bore a first reach lands, ahead of her crown
  reachAhead: 0.1,        // m ahead of her crown a re-reach lands while she hauls
  exitPast: 0.1,          // m past the exit mouth her haul aims, along the centerline
  holdFace: 0.012,        // m off the rock a tunnel hold aims, about an arm's radius
  alignMax: 6,            // s she turns onto the line on her first holds before hauling anyway
  tunnelTurnK: 40,        // 1/s² per radian turning her onto a passage's line
  farAhead: 0.01,         // m ahead of her crown along the centerline a tunnel hold must lie to haul
  pushMax: 2,             // trailing arms pushing her along a bore from behind while she hauls
  pushBack: 0.05,         // m behind her crown along the centerline a push lands
  capEasy: 3,             // N a hold hauls with through a passage that asks nothing of her; capHaul at its tightest
};

/* Her kept share of settled volume hauled through a hole 14 cm long, by the hole's area over her rest section across her
   head-to-mantle line (Node, 488 vertices, round holes 5–11 cm and 12 × 9 cm boxes, 2–14 N). */
export const KEEP_TABLE = [[0.25, 0.36], [0.37, 0.49], [0.5, 0.59], [0.65, 0.77], [0.83, 0.9], [1.02, 0.96], [1.24, 0.965]];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export function keepShare(ratio, table = KEEP_TABLE) {
  if (!(ratio > 0)) return 0;
  if (ratio <= table[0][0]) return table[0][1] * ratio / table[0][0];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (ratio <= x1) { const [x0, y0] = table[i - 1]; return y0 + (y1 - y0) * (ratio - x0) / (x1 - x0); }
  }
  return table[table.length - 1][1];
}

/* The area of her silhouette across `axis`: the convex hull of the points projected on the plane normal to it, m². */
export function restSection(P, n, axis) {
  let b = [0, 1, 0];
  const d = dot(b, axis);
  b = [b[0] - d * axis[0], b[1] - d * axis[1], b[2] - d * axis[2]];
  const bl = Math.hypot(b[0], b[1], b[2]);
  if (!(bl > 1e-6)) b = [1, 0, 0]; else b = [b[0] / bl, b[1] / bl, b[2] / bl];
  const c = [axis[1] * b[2] - axis[2] * b[1], axis[2] * b[0] - axis[0] * b[2], axis[0] * b[1] - axis[1] * b[0]];
  const pts = [];
  for (let i = 0; i < n; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; pts.push([x * b[0] + y * b[1] + z * b[2], x * c[0] + y * c[1] + z * c[2]]); }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cr = (o, a, q) => (a[0] - o[0]) * (q[1] - o[1]) - (a[1] - o[1]) * (q[0] - o[0]), lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  let A = 0;
  for (let i = 0; i < h.length; i++) { const a = h[i], q = h[(i + 1) % h.length]; A += a[0] * q[1] - a[1] * q[0]; }
  return Math.abs(A) / 2;
}

/* Whether she can pass a passage honestly: its narrowest section by area keeps fitKeep of her volume and its narrowest
   ball clears her hard parts. `tight` (0–1) is how much exhale and lengthening it asks of her. */
export function passageFit(P, section, k = SQUEEZE_KNOBS) {
  const ratio = P.narrow.area / Math.max(1e-9, section), keep = keepShare(ratio);
  const hard = hardFit(2 * P.narrow.r, k), fits = hard && keep >= k.fitKeep;
  const tight = clamp((k.easyKeep - keep) / Math.max(1e-6, k.easyKeep - k.fitKeep), 0, 1);
  return { fits, keep, ratio, tight, why: fits ? null : !hard ? 'too small for her hard parts' : `keeps ${keep.toFixed(2)} of her volume` };
}

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

/* The route through passage P from crown c to target t; null when both share a side or, from outside, t lies in the bore.
   Inside, out the way `head` points along the line at c (else toward t). sigma(s) is how far past the entry mouth. */
export function tunnelRoute(c, t, P, k = SQUEEZE_KNOBS, head = null) {
  const m0 = P.mouths[0], m1 = P.mouths[1], pc = passageProject(P, c), pt = passageProject(P, t);
  const within = (q) => q.s > m0.s && q.s < m1.s && q.d < passageValue(P, 'reach', q.s) + 0.02;
  const near = (p) => (Math.hypot(p[0] - m0.p[0], p[1] - m0.p[1], p[2] - m0.p[2]) <= Math.hypot(p[0] - m1.p[0], p[1] - m1.p[1], p[2] - m1.p[2]) ? 0 : 1);
  const inside = within(pc), tIn = within(pt);
  let to;
  if (inside) to = head ? (dot(head, passageTangent(P, pc.s, [0, 0, 0])) >= 0 ? 1 : 0) : tIn ? (pt.s >= pc.s ? 1 : 0) : near(t);
  else if (tIn || near(c) === (to = near(t))) return null;
  const e = 1 - to, sign = e === 0 ? 1 : -1, s0 = P.mouths[e].s, L = Math.abs(P.mouths[to].s - s0);
  const dir = passageTangent(P, s0, [0, 0, 0]).map((v) => v * sign + 0);
  return { kind: 'tunnel', P, sign, e, to, s0, L, inside, tIn, dir, near: passageOut(P, e, k.tunnelBack), exit: passageOut(P, to, k.exitPast) };
}

export function sigmaOf(way, s) { return way.sign * (s - way.s0); }
export function sOfSigma(way, sig) { return way.s0 + way.sign * sig; }

/* A tunnel hold: from the centerline at s, out across the section along dir's part across it, to holdFace off the first
   surface dist(x, y, z, n) finds within range. Writes the point and the surface's outward normal; false with none. */
export function boreHold(P, s, dir, dist, k, out, nrm, range = 0.15) {
  const c = passageAt(P, s, [0, 0, 0]), t = passageTangent(P, s, [0, 0, 0]);
  let d = dir ? [dir[0], dir[1], dir[2]] : [0, -1, 0], a = dot(d, t);
  d = [d[0] - a * t[0], d[1] - a * t[1], d[2] - a * t[2]];
  let l = Math.hypot(d[0], d[1], d[2]);
  if (!(l > 1e-6)) { a = -t[1]; d = [t[0] * a, -1 - t[1] * a, t[2] * a]; l = Math.hypot(d[0], d[1], d[2]); }
  if (!(l > 1e-6)) return false;
  d = [d[0] / l, d[1] / l, d[2] / l];
  const f = (m) => dist(c[0] + d[0] * m, c[1] + d[1] * m, c[2] + d[2] * m, nrm) - k.holdFace;
  if (!(f(0) > 0)) return false;
  let lo = 0, hi = -1;
  for (let m = 0.002; m <= range; m += 0.002) { if (f(m) <= 0) { hi = m; break; } lo = m; }
  if (hi < 0) return false;
  for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
  out[0] = c[0] + d[0] * lo; out[1] = c[1] + d[1] * lo; out[2] = c[2] + d[2] * lo;
  dist(out[0], out[1], out[2], nrm);
  return Number.isFinite(out[0] + out[1] + out[2]);
}

/* Shell vertices behind the entry mouth, inside the bore, and past the exit mouth along the travel, and `lead`, the
   farthest any lies past the entry; each vertex projected near the last one's place. */
export function boreCounts(X, P, origin, n, way, out = { behind: 0, past: 0, inside: 0, lead: 0 }) {
  const q = [0, 0, 0], pr = { s: 0, d: 0, i: 0 };
  out.behind = 0; out.past = 0; out.inside = 0;
  let lead = -Infinity, hint = -1;
  for (let i = 0; i < n; i++) {
    q[0] = X[i * 3] + origin[0]; q[1] = X[i * 3 + 1] + origin[1]; q[2] = X[i * 3 + 2] + origin[2];
    passageProject(P, q, pr, hint);
    // A vertex far along the shell from the last may sit far along the line too: a miss at the window's edge rescans.
    if (hint >= 0 && (pr.i === Math.max(0, hint - 6) || pr.i === Math.min(P.points.length - 2, hint + 5))) passageProject(P, q, pr);
    hint = pr.i;
    const sg = sigmaOf(way, pr.s);
    if (sg < 0) out.behind++; else if (sg > way.L) out.past++; else out.inside++;
    if (sg > lead) lead = sg;
  }
  out.lead = n > 0 ? lead : 0;
  return out;
}
