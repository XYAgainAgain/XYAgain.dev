/* Goals past the reach, THREE-free, which arm-core.js dispatches to: the plant (a foot held still while her body moves
   on it, its length following the chord so planted suckers never slide), the jet's three, and the recoil. */

import { REFLEX_KNOBS, recoilTime } from './reflex-core.js';

function finite3(p) { return !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]); }

/* A plant goal on segment seg at surface point p with outward normal n, or null if any of it is junk. */
export function makePlant(arm, p, n, seg) {
  const S = arm.n - 1, nl = finite3(n) ? Math.hypot(n[0], n[1], n[2]) : 0;
  if (!finite3(p) || !(nl > 1e-9) || !Number.isInteger(seg) || seg < 0 || seg >= S) return null;
  const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
  return {
    kind: 'plant', t: 0, seg, point: [p[0], p[1], p[2]], normal: [nx, ny, nz], target: [0, 0, 0],
    // A point under the surface, so turning the sucker side toward it turns it into the surface.
    face: [p[0] - nx * 0.05, p[1] - ny * 0.05, p[2] - nz * 0.05], lamTo: seg, e: 0, init: false, span0: 0, c0: 0,
  };
}

/* Stretch from the root to the anchor's segment so the chain spans `chord`: lam = 1 + e·w on the reach's ramp (the
   base stretches most), each within stretchMin and its lamMax. Below stretchMin all over, the slack goes into the
   bends. Writes lamGoal for segments 0..seg and returns e. */
export function plantStretch(arm, chord, seg = arm.goal?.seg ?? 0) {
  const k = arm.knobs, len0 = arm.len0, arc0 = arm.arc0, lamMax = arm.lamMax, G = arm.lamGoal;
  const S = arm.n - 1, top = Math.max(0, Math.min(S - 1, seg)), end = arc0[top + 1] || 1e-9;
  const span = (e) => {
    let s = 0;
    for (let j = 0; j <= top; j++) {
      const w = 1 - k.stretchFall * (arc0[j] + len0[j] / 2) / end;
      s += len0[j] * Math.max(k.stretchMin, Math.min(lamMax[j], 1 + e * w));
    }
    return s;
  };
  // The span grows with e (each clamp is monotone), so bisect between all-shortened and all-stretched.
  let lo = -2, hi = 2 * Math.max(1, k.stretchMax ?? 2), e;
  const c = Number.isFinite(chord) ? chord : span(0);
  if (c <= span(lo)) e = lo;
  else if (c >= span(hi)) e = hi;
  else {
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if (span(m) < c) lo = m; else hi = m; }
    e = (lo + hi) / 2;
  }
  for (let j = 0; j <= top; j++) {
    const w = 1 - k.stretchFall * (arc0[j] + len0[j] / 2) / end;
    G[j] = Math.max(k.stretchMin, Math.min(lamMax[j], 1 + e * w));
  }
  if (arm.goal?.kind === 'plant') arm.goal.e = e;
  return e;
}

/* Turn the sucker side at point ci toward world point f: one adapter, so the aiming API can change under it. */
export function aimSuckersAt(arm, f, ci, dt) {
  if (typeof arm.aimSuckers === 'function') return arm.aimSuckers(f, ci, dt);
  if (typeof arm._aimSuckers === 'function') return arm._aimSuckers(f, ci, dt);
}

/* The plant's program: the base aimed at the anchor and stiff behind it, the point at the end of the anchor's segment
   placed by FABRIK at full weight at once (the chain already lies there when the seal forms), the length from the
   chord, and the suckers turned into the surface. Past the anchor the arm drapes under contact. Returns the grip weight. */
export function plantTargets(arm, T, K, dt) {
  const g = arm.goal, k = arm.knobs, F = arm.frame, S = arm.n - 1;
  const seg = Math.max(0, Math.min(S - 1, g.seg)), gi = seg + 1, r = arm.rad[seg], X = arm.X, n = g.normal;
  if (!g.init) {
    // The foot is where the end of its segment lies now, dropped onto the surface, so nothing jumps when it plants;
    // and the length keeps the slack it has, changing only as the chord does.
    const qx = X[gi * 3], qy = X[gi * 3 + 1], qz = X[gi * 3 + 2];
    if (Number.isFinite(qx + qy + qz)) {
      const h = (qx - g.point[0]) * n[0] + (qy - g.point[1]) * n[1] + (qz - g.point[2]) * n[2];
      g.point[0] = qx - n[0] * h; g.point[1] = qy - n[1] * h; g.point[2] = qz - n[2] * h;
    }
    let span = 0;
    for (let j = 0; j <= seg; j++) span += arm.len0[j] * arm.lam[j];
    g.span0 = span;
    g.c0 = Math.hypot(g.point[0] + n[0] * r - F.p[0], g.point[1] + n[1] * r - F.p[1], g.point[2] + n[2] * r - F.p[2]);
    g.init = true;
  }
  // On the surface by the segment's own radius, so contact never fights the target; the radius thins as it stretches.
  g.target[0] = g.point[0] + n[0] * r; g.target[1] = g.point[1] + n[1] * r; g.target[2] = g.point[2] + n[2] * r;
  arm.gripAt = gi;
  const dx = g.target[0] - F.p[0], dy = g.target[1] - F.p[1], dz = g.target[2] - F.p[2], D = Math.hypot(dx, dy, dz);
  plantStretch(arm, Math.max(D, g.span0 + D - g.c0), seg);
  if (D > 1e-6 && typeof arm._aim === 'function') arm._aim(dx / D, dy / D, dz / D, 1, T);
  for (let j = 0; j < S; j++) K[j] = j <= seg ? k.stiffBehind : k.stiffDrag;
  aimSuckersAt(arm, g.face, gi, dt);
  arm.w = 1;
  arm.gw = 1;
  return 1;
}

/* The jet's arm goals: trailing behind a jet, spread like a parachute as she sinks after one, and tucked under her (the
   swim, a bound arm). None of them grips; the base aims, the rest lags. */

function unit3(x, y, z, out, fx = 0, fy = -1, fz = 0) {
  const l = Math.hypot(x, y, z);
  if (l > 1e-9 && Number.isFinite(l)) { out[0] = x / l; out[1] = y / l; out[2] = z / l; }
  else { out[0] = fx; out[1] = fy; out[2] = fz; }
  return out;
}

/* Where a trailing arm's base points: straight back along −v, turned `spread` radians toward the root's own outward
   direction d, so the crown opens a little instead of bunching into one rope. */
export function trailDir(d, v, spread, out) {
  const b = unit3(-v[0], -v[1], -v[2], out);
  const bx = b[0], by = b[1], bz = b[2], c = d[0] * bx + d[1] * by + d[2] * bz;
  let ox = d[0] - c * bx, oy = d[1] - c * by, oz = d[2] - c * bz, ol = Math.hypot(ox, oy, oz);
  if (!(ol > 1e-6)) {
    // A root pointing straight back has no outward side of its own; any perpendicular will do.
    ox = Math.abs(by) < 0.9 ? -bz : 0; oy = Math.abs(by) < 0.9 ? 0 : bz; oz = Math.abs(by) < 0.9 ? bx : -by;
    ol = Math.hypot(ox, oy, oz) || 1;
  }
  const cs = Math.cos(spread), sn = Math.sin(spread);
  return unit3(bx * cs + (ox / ol) * sn, by * cs + (oy / ol) * sn, bz * cs + (oz / ol) * sn, out);
}

/* The parachute: out along the root's flat bearing and `down` radians below level, in world terms, since she sinks. */
export function spreadDir(d, down, out) {
  const l = Math.hypot(d[0], d[2]);
  if (!(l > 1e-6)) { out[0] = 0; out[1] = -1; out[2] = 0; return out; }
  const c = Math.cos(down), s = Math.sin(down);
  out[0] = (d[0] / l) * c; out[1] = -s; out[2] = (d[2] / l) * c;
  return out;
}

/* stiff and tip are shares of stiffBehind for the base and the distal half; a null tip leaves the distal half soft. */
export function makeTrail(v, spread = 0.35, stiff = 0.3, tip = null) {
  return { kind: 'trail', t: 0, v: [v[0], v[1], v[2]], spread, stiff, tip };
}

export function makeSpread(down = 0.5) {
  return { kind: 'spread', t: 0, down };
}

export function makeTuck(curl = 2) {
  return { kind: 'tuck', t: 0, curl };
}

const _dir = [0, 0, 0];

/* Stiff at the base, soft and lagging past `from` of the arm's length, so the tips stream behind. */
function trailingStiffness(arm, K, base, from, tip = arm.knobs.stiffDrag) {
  const S = arm.n - 1, L = arm.length, D = arm.dragGoal;
  for (let j = 0; j < S; j++) {
    const s = (arm.arc0[j] + arm.len0[j] / 2) / L, distal = s >= from;
    K[j] = distal ? tip : base;
    D[j] = distal ? 1 : 0;
  }
}

/* The jet's trailing arms: the base aimed back along the travel, turned out by the goal's spread. */
export function trailTargets(arm, T, K) {
  const g = arm.goal, k = arm.knobs;
  trailDir(arm.frame.d, g.v, g.spread, _dir);
  arm._aim(_dir[0], _dir[1], _dir[2], 1, T);
  trailingStiffness(arm, K, k.stiffBehind * g.stiff, 0.5, Number.isFinite(g.tip) ? k.stiffBehind * g.tip : k.stiffDrag);
  return 0;
}

/* After a jet, arms out wide and down while she sinks onto them. */
export function spreadTargets(arm, T, K) {
  const g = arm.goal, k = arm.knobs;
  spreadDir(arm.frame.d, g.down, _dir);
  arm._aim(_dir[0], _dir[1], _dir[2], 1, T);
  trailingStiffness(arm, K, k.stiffBehind * 0.2, 0.6);
  return 0;
}

/* Curled in toward the suckers, under her: the resting curl, held harder. */
export function tuckTargets(arm, T, K) {
  const g = arm.goal, k = arm.knobs, S = arm.n - 1;
  for (let j = 0; j < S; j++) { arm._curl(j, T, g.curl); K[j] = k.stiffIdle * 2; }
  return 0;
}

/* The recoil: the arm holds the pose it has, and the joints at and behind a noxious touch bend so the touched segment
   leaves along the touch's outward normal (from the thing into the arm). */

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const share = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);

function midDot(P, s, nx, ny, nz) {
  const o = s * 3;
  return ((P[o] + P[o + 3]) * nx + (P[o + 1] + P[o + 4]) * ny + (P[o + 2] + P[o + 5]) * nz) / 2;
}

/* A recoil goal off touch { seg, severity in (0, 1], normal, point? }, shaped by REFLEX_KNOBS unless opts overrides
   them (opts.duration, else the recoil law); null on junk. A zero normal falls back to off the solved sucker side. */
export function makeRecoil(arm, touch, opts = {}) {
  const S = arm.n - 1, n = arm.n, seg = touch?.seg, sv = touch?.severity;
  if (!Number.isInteger(seg) || seg < 0 || seg >= S || !(sv > 0) || !Number.isFinite(sv)) return null;
  const k = { ...REFLEX_KNOBS, ...opts }, s = Math.min(1, sv), X = arm.X, N = touch.normal;
  let nl = finite3(N) ? Math.hypot(N[0], N[1], N[2]) : 0, nx, ny, nz;
  if (nl > 1e-9) { nx = N[0] / nl; ny = N[1] / nl; nz = N[2] / nl; }
  else {
    nx = -arm.SK[seg * 3]; ny = -arm.SK[seg * 3 + 1]; nz = -arm.SK[seg * 3 + 2]; nl = Math.hypot(nx, ny, nz);
    if (!(nl > 1e-9)) return null;
    nx /= nl; ny /= nl; nz /= nl;
  }
  // The pose it holds is the chain as it lies, as still() takes it.
  const from = new Float64Array(S * 2);
  if (arm.started && Number.isFinite(X[n * 3 - 1])) { arm.bendsFromPoints(X, from); arm._clampBends(from, null); } else from.set(arm.out);
  if (!from.every(Number.isFinite)) return null;
  // Each joint's bends live in a frame carried down the bent, twisted chain, so the way to bend is read off the pose
  // itself: the gradient of the segment's height along n, its length over the lever being how much a bend there helps.
  const B = Float64Array.from(from), P = new Float64Array(n * 3), delta = new Float64Array(S * 2), lim = arm.lim;
  const lo = Math.max(0, seg - Math.max(1, Math.round(k.smear) || 1) + 1), amp = k.bend * (1 + k.gain * s), eps = 1e-6;
  arm.poseFromBends(B, P, null);
  const mx = (P[seg * 3] + P[seg * 3 + 3]) / 2, my = (P[seg * 3 + 1] + P[seg * 3 + 4]) / 2, mz = (P[seg * 3 + 2] + P[seg * 3 + 5]) / 2;
  for (let j = lo; j <= seg; j++) {
    const lever = Math.hypot(mx - P[j * 3], my - P[j * 3 + 1], mz - P[j * 3 + 2]), gr = [0, 0];
    if (!(lever > 1e-9)) continue;
    for (let c = 0; c < 2; c++) {
      const a = j * 2 + c, b0 = B[a];
      B[a] = b0 + eps; arm.poseFromBends(B, P, null); const up = midDot(P, seg, nx, ny, nz);
      B[a] = b0 - eps; arm.poseFromBends(B, P, null); gr[c] = (up - midDot(P, seg, nx, ny, nz)) / (2 * eps);
      B[a] = b0;
    }
    const du = amp * gr[0] / lever, dv = amp * gr[1] / lever;
    // Kept inside the joint's limit along its own direction: |from + t·delta| = lim for the largest t up to 1.
    const fu = from[j * 2], fv = from[j * 2 + 1], dd = du * du + dv * dv, fd = fu * du + fv * dv, L2 = lim[j] * lim[j];
    if (!(dd > 1e-24) || !Number.isFinite(dd)) continue;
    const tt = Math.max(0, Math.min(1, (-fd + Math.sqrt(Math.max(0, fd * fd - dd * (fu * fu + fv * fv - L2)))) / dd));
    delta[j * 2] = du * tt; delta[j * 2 + 1] = dv * tt;
  }
  // Springs' targets have what contact left in the bends added back each tick, so the held pose is taken without it.
  const base = new Float64Array(S * 2);
  for (let a = 0; a < S * 2; a++) base[a] = from[a] - arm.rest[a];
  const dur = Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration : recoilTime(s, k);
  const shorten = Math.min(0.5, k.shorten * (1 + k.gain * s));
  return {
    kind: 'recoil', t: 0, seg, lo, severity: s, normal: [nx, ny, nz], point: finite3(touch.point) ? [touch.point[0], touch.point[1], touch.point[2]] : null,
    entry: touch.entry ?? null, duration: dur > 0 ? dur : REFLEX_KNOBS.recoilBase, hold: k.hold >= 0 ? k.hold : REFLEX_KNOBS.hold,
    from, base, delta, lam: Float64Array.from(arm.lam), twist: Float64Array.from(arm.twist),
    stiff: share(k.stiff, REFLEX_KNOBS.stiff), baseStiff: share(k.baseStiff, REFLEX_KNOBS.baseStiff),
    shorten: shorten >= 0 ? shorten : 0, rate: share(k.shortenRate, REFLEX_KNOBS.shortenRate), muscle: k.muscle === 'map' ? 'map' : 'pass',
    pulseIn: Math.max(1e-3, Math.min(1, share(k.shortenIn, REFLEX_KNOBS.shortenIn))), pulseOut: Math.min(0.999, share(k.shortenOut, REFLEX_KNOBS.shortenOut)),
  };
}

/* The held pose plus the flinch, stiff where it bends and before it holding, the part past the touch soft and trailing
   in the water; the flinching part shortens early on and lengthens back, and the twist holds. */
export function recoilTargets(arm, T, K) {
  const g = arm.goal, k = arm.knobs, S = arm.n - 1, G = arm.lamGoal, D = arm.dragGoal, A = g.base, F = g.delta;
  const u = g.duration > 0 ? g.t / g.duration : 1, sh = g.shorten * smooth(0, g.pulseIn, u) * (1 - smooth(g.pulseOut, 1, u));
  for (let j = 0; j < S; j++) {
    const at = j >= g.lo && j <= g.seg;
    T[j * 2] = A[j * 2] + F[j * 2]; T[j * 2 + 1] = A[j * 2 + 1] + F[j * 2 + 1];
    K[j] = at ? k.stiffBehind * g.stiff : j < g.lo ? k.stiffBehind * g.baseStiff : k.stiffDrag;
    D[j] = j > g.seg ? 1 : 0;
    G[j] = at ? Math.max(k.stretchMin, g.lam[j] * (1 - sh)) : g.lam[j];
  }
  arm.twistAim.set(g.twist);
  if (g.t >= g.duration + g.hold) arm._letGo(false);
  return 0;
}
