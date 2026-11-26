import { ROLE } from './locomotion-core.js';
import { SQUEEZE_KNOBS, passageFit, sigmaOf, sOfSigma, boreCounts, weightedAxis, lengthAlong } from './loco-squeeze-core.js';
import { passageTangent, passageProject, passageOut } from './loco-passage-core.js';
import { until } from '../../diag/scenarios.js';

// Her least volume inside a passage over her settled volume, the slot squeeze's on the low tunnel (0.73–0.82, median 0.79).
export const TUNNEL_BAR = 0.8;

const r3 = (v) => +(+v).toFixed(3);

/* Through a squeeze zone's passage and, with legs 2, back. Per leg: all of her past the far mouth, her least volume inside
   over settled, mantle and arm points in the rock, the time, and form along the centerline; `plain` crawls there instead. */
export async function tunnel(ctx, { passage = 0, urgency = 0.6, limit = SQUEEZE_KNOBS.squeezeLimit, legs = 2, settle = 1, bar = TUNNEL_BAR, plain = false } = {}) {
  const { loco, arms } = ctx, sq = loco.modes.get('squeeze'), field = arms.phys.rockwork?.field;
  if (!sq) return { passed: false, failed: 'no squeeze mode registered' };
  if (!sq.k.tunnels && !plain) return { passed: null, failed: 'passages off (?tunnel=0)', note: 'passages off' };
  const list = sq.passages, P = typeof passage === 'number' ? list[passage] : list.find((q) => q.name === passage);
  if (!P) { const why = list.length ? `no passage ${passage}` : 'the layout has no zone with the role squeeze'; return { passed: null, failed: why, note: why }; }
  const fit = passageFit(P, sq.section, sq.k), out = { passage: P.name, fit: { fits: fit.fits, keep: r3(fit.keep), ratio: r3(fit.ratio), tight: r3(fit.tight) }, legs: [] };
  await until(loco, () => false, settle);
  for (let leg = 0; leg < legs; leg++) {
    const one = await tunnelLeg(ctx, sq, P, field, { urgency, limit, plain });
    out.legs.push(one);
    if (!one.through) break;
  }
  const first = out.legs[0];
  if (!fit.fits && !plain) { out.passed = !!first?.refused; out.note = first?.refused ? `refused: ${fit.why}` : 'not refused'; return out; }
  out.passed = out.legs.length === legs && out.legs.every((g) => g.through && g.volRel >= bar && g.mantleInRock.count === 0 && g.nan === 0);
  const form = [...new Set(out.legs.flatMap((g) => g.form))];
  out.note = out.passed ? (form.length ? `through; form: ${form.join(', ')}` : 'through, good form') : out.legs.map((g) => g.note).join('; ');
  return out;
}

/* One way through, from whichever mouth she is nearer. */
async function tunnelLeg(ctx, sq, P, field, { urgency, limit, plain }) {
  const { loco, mantle: m, arms } = ctx, n = m.shell.count, k = sq.k, nrm = [0, 0, 0], pr = { s: 0, d: 0, i: 0 };
  const c0 = loco.c, d0 = P.mouths.map((q) => Math.hypot(c0[0] - q.p[0], c0[1] - q.p[1], c0[2] - q.p[2]));
  const from = d0[0] <= d0[1] ? 0 : 1, to = 1 - from, sign = from === 0 ? 1 : -1;
  const way = { P, sign, s0: P.mouths[from].s, L: P.length };
  // The floor a body length out of the far mouth, pulled back along its line while the rock crowds it.
  const target = [0, 0, 0];
  for (let back = 0; back <= 0.2; back += 0.02) {
    passageOut(P, to, 0.22 - back, target);
    if (!field || field.distance(target[0], target[1], target[2], nrm) > 0.04) break;
  }
  target[1] = 0;
  const vol0 = m.health().volume, t0 = loco.time, S = m.shell.positions;
  const wHead = Float32Array.from(m.vertexMass, (v, i) => v * m.shell.regions[i * 3 + 1]), wMantle = Float32Array.from(m.vertexMass, (v, i) => v * m.shell.regions[i * 3]);
  const ax0 = weightedAxis(S, wHead, wMantle, n);
  let tip = 0, best = -Infinity;
  for (let i = 0; i < n; i++) { const s = S[i * 3] * ax0[0] + S[i * 3 + 1] * ax0[1] + S[i * 3 + 2] * ax0[2]; if (s > best) { best = s; tip = i; } }
  const w = { firstIn: null, lastOut: null, volMin: Infinity, mantle: 0, mantleMm: 0, armN: 0, armMm: 0, armNear: 0, armNearMm: 0, nan: 0, holdsAtIn: null, alignAtIn: null, crownIn: null, tipIn: null, notExhaled: 0, lenMax: 0, ticks: 0, stages: new Set(), track: [], acc: 0 };
  const f = { behind: 0, past: 0, inside: 0, lead: 0 }, ax = [0, 0, 0], tp = [0, 0, 0], td = [0, 0, 0], len = { extent: 0, rms: 0 }, A = [0, 0, 0];
  const sigma = (p) => { passageProject(P, p, pr); return sigmaOf(way, pr.s); };
  const watch = (dt) => {
    w.ticks++; w.stages.add(sq.stage); w.acc += dt;
    boreCounts(m.positions, P, m.origin, n, way, f);
    const t = loco.time - t0;
    if (w.firstIn === null && f.inside > 0) {
      w.firstIn = r3(t);
      let h = 0;
      for (let a = 0; a < loco.n; a++) {
        if (loco.role[a] !== ROLE.planted && loco.role[a] !== ROLE.station) continue;
        A[0] = loco.anchorP[a * 3]; A[1] = loco.anchorP[a * 3 + 1]; A[2] = loco.anchorP[a * 3 + 2];
        if (sigma(A) > 0) h++;
      }
      w.holdsAtIn = h;
      m.mantleAxis(ax); passageTangent(P, way.s0, td);
      w.alignAtIn = r3(-(ax[0] * td[0] + ax[1] * td[1] + ax[2] * td[2]) * sign);
    }
    if (w.firstIn !== null && w.lastOut === null && f.behind === 0 && f.inside === 0) w.lastOut = r3(t);
    const crown = sigma(loco.c);
    if (w.firstIn !== null && w.lastOut === null) {
      w.volMin = Math.min(w.volMin, m.health().volume);
      if (sq.way?.tight > 0 && m.breathHold?.exhale !== 1) w.notExhaled++;
      passageTangent(P, sOfSigma(way, Math.max(0, Math.min(way.L, crown))), td);
      lengthAlong(m.positions, m.vertexMass, n, td, len);
      w.lenMax = Math.max(w.lenMax, len.extent / sq.rest.extent);
    }
    if (w.crownIn === null && crown > 0) w.crownIn = r3(t);
    for (let i = 0; i < 3; i++) tp[i] = m.positions[tip * 3 + i] + m.origin[i];
    if (w.tipIn === null && sigma(tp) > 0) w.tipIn = r3(t);
    if (w.ticks % 6 === 0 && field) {
      const near = Math.abs(crown - way.L / 2) < way.L / 2 + 0.15, Q = m.positions, o = m.origin;
      for (let i = 0; i < n; i++) {
        const x = Q[i * 3] + o[0], y = Q[i * 3 + 1] + o[1], z = Q[i * 3 + 2] + o[2];
        if (!Number.isFinite(x + y + z)) { w.nan++; continue; }
        const dd = field.distance(x, y, z, nrm);
        if (dd < 0) { w.mantle++; w.mantleMm = Math.max(w.mantleMm, -dd * 1000); }
      }
      for (const B of arms.bodies) for (let i = 0; i < B.n; i++) {
        const x = B.X[i * 3], y = B.X[i * 3 + 1], z = B.X[i * 3 + 2];
        if (!Number.isFinite(x + y + z)) { w.nan++; continue; }
        const pen = B.rad[i] - field.distance(x, y, z, nrm);
        if (pen > 0) { w.armN++; w.armMm = Math.max(w.armMm, pen * 1000); if (near) { w.armNear++; w.armNearMm = Math.max(w.armNearMm, pen * 1000); } }
      }
    }
    if (w.acc >= 0.5) { w.acc = 0; w.track.push({ t: r3(t), stage: sq.stage, sig: r3(crown), far: sq.stats.farHolds, behind: f.behind, inside: f.inside, past: f.past, vol: r3(m.health().volume / vol0) }); }
  };
  loco.listeners.add(watch);
  let res, over = false;
  try {
    const done = until(loco, () => over || w.lastOut !== null, limit).then(() => ({ arrived: false, failed: w.lastOut !== null ? null : 'timeout' }));
    const go = plain ? (loco.want(target, { urgency, source: 'scenario' })?.done ?? Promise.resolve({ failed: 'refused' })) : sq.go(target, { urgency, via: P });
    res = await Promise.race([go, done]);
    over = true;
    // Through, she carries on a moment toward the target.
    if (w.lastOut !== null && loco.desire) await until(loco, () => !loco.desire, 3);
  } finally { over = true; loco.stop('leg over'); loco.listeners.delete(watch); }
  await until(loco, () => false, 1);
  const h = m.health(), refused = /^too small/.test(res?.failed ?? '');
  const form = [];
  if (!(w.holdsAtIn >= k.farHoldsMin)) form.push(`${w.holdsAtIn ?? 0} holds in at entry`);
  if (!(w.alignAtIn > Math.cos(0.4) && w.crownIn !== null && (w.tipIn === null || w.crownIn <= w.tipIn))) form.push('not turned first');
  if (w.notExhaled > 0) form.push('not exhaled');
  return {
    from: `mouth ${from}`, target: target.map(r3), through: w.lastOut !== null, refused, failed: res?.failed ?? null,
    time: w.lastOut, firstIn: w.firstIn, volRel: r3(Number.isFinite(w.volMin) ? w.volMin / vol0 : 1), vol0: r3(vol0),
    mantleInRock: { count: w.mantle, worstMm: r3(w.mantleMm) }, armsInRock: { count: w.armN, worstMm: r3(w.armMm), nearCount: w.armNear, nearWorstMm: r3(w.armNearMm) },
    nan: w.nan + h.nan, endStrain: r3(h.strainMax), lengthMax: r3(w.lenMax), holdsAtIn: w.holdsAtIn, alignAtIn: w.alignAtIn, centerTimedOut: sq.timedOut,
    times: Object.fromEntries(Object.entries(sq.times).map(([key, v]) => [key, key === 'alignCos' ? v : r3(v - (sq.times.start ?? 0))])),
    sends: { ...sq.stats.sends }, releases: { ...sq.stats.releases }, stages: [...w.stages], form, track: w.track,
    note: refused ? res.failed : w.lastOut === null ? (res?.failed ?? 'not through') : form.length ? `form: ${form.join(', ')}` : 'good form',
  };
}
