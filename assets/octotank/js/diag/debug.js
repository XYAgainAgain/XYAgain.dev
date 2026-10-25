import { penetration } from '../tank/layout.js';
import { TANK } from '../config.js';
import { runScenario, register, until, simWait } from './scenarios.js';
import { createRng, deriveSeed, seedFromUrl } from '../../../pond/js/rng.js';

/* window.tank: live knobs, step stats, scenarios, and the harness probe. This module also registers the lip, her own
   passage through the rock wall's slot with the shell watched every tick. */

export function attachDebug(ctx) {
  const { phys, mantle, arms, pose, panel, layoutKnobs } = ctx;
  const tank = {
    phys, mantle, arms, pose, toys: ctx.toys,
    knobs: { mantle: mantle.knobs, arms: arms.knobs, pose: pose?.knobs, layout: layoutKnobs, suckers: arms.suckerKnobs, rod: arms.rodKnobs, reflexes: arms.reflexes.knobs, blocked: arms.blocked.knobs },
    get stats() { return { step: phys.stats(), sim: phys.time, verts: mantle.shell.count, drive: mantle.drive, iterations: mantle.knobs.iterations, backend: document.documentElement.dataset.backend }; },
    resetStats: () => phys.resetStats(),
    setPressure: (pa) => mantle.setPressurePa(pa),
    setIterations: (n) => mantle.setIterations(n),
    setDrive: (mode) => mantle.setDrive(mode),
    health: () => mantle.health(),
    tip: (angle, axis) => mantle.tip(angle, axis),
    up: () => mantle.up(),
    // What a sucker tastes on toy i, so food, spoiled, slick, and noxious (with a severity in (0, 1]) can be tried without new art.
    taste: (i, taste = 'toy', severity) => {
      const t = ctx.toys[i];
      if (!t) return null;
      t.taste = String(taste);
      if (severity !== undefined) t.severity = +severity;
      return t.taste;
    },
    loco: ctx.loco ?? null,
    scenario: (name, opts) => runScenario(name, ctx, opts),
    get scenarioPhase() { return ctx.phase ?? null; },
    // One per-tick callback after the rest of the pre-step tick, for harness watches; null clears it.
    setProbe: (fn) => { ctx.probe = typeof fn === 'function' ? fn : null; },
  };
  if (ctx.loco) tank.knobs.loco = ctx.loco.knobs;
  return tank;
}

export const LIP_KNOBS = {
  lipRetryRest: 2,    // seconds she rests after a send ends short, before she is sent again
  lipLimit: 120,      // seconds for the whole passage
  armThrough: 0.5,    // share of an arm's arc length, root to tip, past the far face for it to count as through
  armsThrough: 3,
  hold: 2,            // seconds the done condition holds unbroken; also the still wait before the end health
  past: 0.35,         // the goal's distance beyond the far face
  depth: 0.2,         // the goal's seeded depth, within ± this
  rockClear: 0.12,    // a goal this close to a rock's footprint is rerolled
};

const STAGES = ['off', 'refused', 'approach', 'center', 'thread', 'haul', 'out'];
const r3 = (v) => +(+v).toFixed(3);

/* Share of a chain's arc length past the plane x = far on the dir side; the crossing segment counts its own part. */
function sharePast(X, far, dir) {
  let all = 0, past = 0;
  for (let i = 3; i < X.length; i += 3) {
    const l = Math.hypot(X[i] - X[i - 3], X[i + 1] - X[i - 2], X[i + 2] - X[i - 1]), s0 = (X[i - 3] - far) * dir, s1 = (X[i] - far) * dir;
    all += l;
    if (s0 > 0 && s1 > 0) past += l;
    else if (s0 > 0 || s1 > 0) past += (l * Math.max(s0, s1)) / (Math.abs(s1 - s0) || 1);
  }
  return all > 0 ? past / all : 0;
}

/* A floor point past the far face at a seeded depth, rerolled off any rock's footprint (the box past the wall sits in
   the band). Its own stream off the run's seed, so nothing of hers draws differently. */
function lipGoal(ctx, dir, far, k, seed) {
  const rng = createRng(deriveSeed(seed, 0x11b)), x = far + dir * k.past;
  const clear = (z) => (ctx.rocks ?? []).every((r) => Math.hypot(x - r.pos[0], z - r.pos[2]) > (r.kind === 'sphere' ? r.size[0] : Math.hypot(r.size[0], r.size[2])) + k.rockClear);
  let z = 0, tries = 0;
  do { z = rng.range(-k.depth, k.depth); tries++; } while (!clear(z) && tries < 32);
  return { goal: [x, 0, z], tries, clear: clear(z) };
}

/* The lip: from wherever she settled, one desire to a floor point past the rock wall, routed by her own modes; a send
   that ends short rests and goes again. Done when her center of mass and three arms are through, held 2 s. */
async function lip(ctx, opts = {}) {
  const k = { ...LIP_KNOBS, ...opts }, urgency = opts.urgency ?? 0.6;
  const { loco, mantle: m, arms, panel, layoutKnobs: L } = ctx, sq = loco.modes.get('squeeze'), att = ctx.attention?.knobs;
  if (!loco.canPlant) return { passed: false, failed: 'no plant support in the arms yet' };
  if (ctx.watch) throw new Error('lip: a watch is already running');
  const seed = Number.isFinite(opts.seed) ? opts.seed | 0 : seedFromUrl();
  const n = m.shell.count, vm = m.vertexMass, nA = arms.bodies.length;
  let mass = 0;
  for (let i = 0; i < n; i++) mass += vm[i];
  const com = () => {
    const P = m.positions, o = m.origin;
    let x = 0;
    for (let i = 0; i < n; i++) x += vm[i] * (P[i * 3] + o[0]);
    return x / mass;
  };
  const dir = com() > L.panelX ? -1 : 1, far = L.panelX + dir * L.panelT / 2;
  const { goal, tries, clear } = lipGoal(ctx, dir, far, k, seed);
  const w = {
    nan: 0, penetration: 0, edgePenetration: 0, volumeMin: Infinity, volumeMax: 0, escaped: 0, strainMax: 0,
    centerShareBest: 0, centerPastBest: -Infinity, armBest: new Array(nA).fill(0), armsThroughBest: 0, stage: 0, exceptionT: 0, passageT: 0,
  };
  const t0 = loco.time, p = [0, 0, 0];
  let heldFrom = null, doneAt = null, judging = true, tPrev = t0;
  ctx.watch = () => {
    const P = m.positions, o = m.origin, h = m.health(), t = loco.time, dt = t - tPrev;
    tPrev = t;
    w.nan += h.nan; w.strainMax = Math.max(w.strainMax, h.strainMax);
    w.volumeMin = Math.min(w.volumeMin, h.volume); w.volumeMax = Math.max(w.volumeMax, h.volume);
    let past = 0, x = 0;
    for (let i = 0; i < n; i++) {
      p[0] = P[i * 3] + o[0]; p[1] = P[i * 3 + 1] + o[1]; p[2] = P[i * 3 + 2] + o[2];
      w.penetration = Math.max(w.penetration, penetration(p, panel));
      if (p[0] < -TANK.w / 2 - 0.01 || p[0] > TANK.w / 2 + 0.01 || p[1] < -0.01 || p[1] > TANK.h + 0.01 || Math.abs(p[2]) > TANK.d / 2 + 0.01) w.escaped++;
      x += vm[i] * p[0];
      if ((p[0] - far) * dir > 0) past += vm[i];
    }
    // Edge midpoints too: a face can bridge a lip with all three of its vertices clear.
    for (const [a, b] of m.edges) {
      p[0] = (P[a * 3] + P[b * 3]) / 2 + o[0]; p[1] = (P[a * 3 + 1] + P[b * 3 + 1]) / 2 + o[1]; p[2] = (P[a * 3 + 2] + P[b * 3 + 2]) / 2 + o[2];
      w.edgePenetration = Math.max(w.edgePenetration, penetration(p, panel));
    }
    if (!judging) return;
    const comPast = (x / mass - far) * dir;
    w.centerShareBest = Math.max(w.centerShareBest, past / mass); w.centerPastBest = Math.max(w.centerPastBest, comPast);
    let through = 0;
    for (let a = 0; a < nA; a++) {
      const s = sharePast(arms.bodies[a].X, far, dir);
      w.armBest[a] = Math.max(w.armBest[a], s);
      if (s >= k.armThrough) through++;
    }
    w.armsThroughBest = Math.max(w.armsThroughBest, through);
    if (sq) {
      w.stage = Math.max(w.stage, STAGES.indexOf(sq.stage));
      // The one-way carry keys on the desire's own source; this records whether it ever applied to the passage.
      if (sq.active) { w.passageT += dt; if (loco.desire?.source === 'squeeze') w.exceptionT += dt; }
    }
    if (doneAt !== null) return;
    if (comPast > 0 && through >= k.armsThrough) { heldFrom ??= t; if (t - heldFrom >= k.hold) doneAt = t - t0; } else heldFrom = null;
  };
  const curious = att?.curious;
  if (att) att.curious = false;
  const ends = [];
  let sends = 0, refusals = 0, quit = false;
  try {
    const stop = () => doneAt !== null;
    let timedOut = false;
    // quit, set on every exit, lets each wait's listener drop itself on the next tick even after a throw.
    until(loco, () => quit || stop(), k.lipLimit).then((ok) => { timedOut = !ok; });
    while (!stop() && !timedOut) {
      const d = loco.want(goal, { urgency, source: 'lip' });
      if (d) {
        sends++;
        let over = false;
        const cut = until(loco, () => quit || over || stop() || timedOut).then(() => null);
        const res = await Promise.race([d.done, cut]);
        over = true;
        if (res) ends.push({ arrived: res.arrived, failed: res.failed, t: r3(loco.time - t0) });
      } else refusals++;
      if (stop() || timedOut) break;
      await until(loco, () => quit || stop() || timedOut, k.lipRetryRest);
    }
    judging = false;
    loco.stop('scenario over');
    await simWait(loco, k.hold);
  } finally {
    quit = true;
    ctx.watch = null;
    if (att) att.curious = curious;
  }
  const end = m.health();
  const result = {
    seed, direction: dir, goal: goal.map(r3), goalTries: tries, goalClear: clear, urgency, limit: k.lipLimit,
    done: doneAt !== null, tDone: doneAt === null ? null : r3(doneAt), sends, refusals, ends,
    stage: STAGES[w.stage], centerShareBest: r3(w.centerShareBest), centerPastBest: r3(w.centerPastBest), armBest: w.armBest.map(r3), armsThroughBest: w.armsThroughBest,
    squeezeException: { applied: w.exceptionT > 0, seconds: r3(w.exceptionT), passageSeconds: r3(w.passageT) },
    nan: w.nan, penetration: +w.penetration.toFixed(5), edgePenetration: +w.edgePenetration.toFixed(5), volumeMin: r3(w.volumeMin), volumeMax: r3(w.volumeMax),
    escaped: w.escaped, strainMax: r3(w.strainMax), endStrain: r3(end.strainMax), endVolume: r3(end.volume),
  };
  result.stable = w.nan === 0 && Math.max(w.penetration, w.edgePenetration) < 0.012 && w.volumeMin >= 0.6 && w.volumeMax <= 1.6 && w.escaped === 0
    && end.strainMax < 0.5 && end.volume > 0.85;
  result.passed = result.done && doneAt <= k.lipLimit && result.stable;
  return result;
}

register('lip', { label: 'Over the lip', run: lip });
