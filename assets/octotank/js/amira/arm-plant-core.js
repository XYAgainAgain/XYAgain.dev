/* The plant goal, THREE-free: an arm whose foot holds still on a surface while her body moves on it. arm-core.js
   dispatches to these; the arm's length from root to anchor follows the chord, so planted suckers never slide. */

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
