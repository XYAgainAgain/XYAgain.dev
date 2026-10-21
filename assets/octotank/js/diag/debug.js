import { penetration } from '../tank/layout.js';
import { TANK } from '../config.js';
import { runScenario } from './scenarios.js';

/* window.tank: live knobs, step stats, and the squeeze test. The test drives the posture through the hole and
   watches the shell every tick; the result is the spike's acceptance record. */

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
    squeeze: (opts) => squeeze(ctx, opts),
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

/* Run the posture from the near side, through the hole, to the far side; sample the shell each fixed tick. */
async function squeeze(ctx, { approach = 3, through = 5, settle = 2, reach = 0.32 } = {}) {
  const { mantle, pose, panel, layoutKnobs: L } = ctx;
  if (ctx.watch) throw new Error('squeeze: one is already running');
  // A NaN duration would freeze the posture on its first key and poison her targets, so nothing starts.
  if (![approach, through, reach].every((v) => Number.isFinite(v) && v > 0) || !(Number.isFinite(settle) && settle >= 0)) {
    throw new RangeError('squeeze: approach, through, and reach must be positive numbers, settle zero or more');
  }
  const dir = pose.center[0] > L.panelX ? -1 : 1;
  const startX = L.panelX - dir * reach, exitX = L.panelX + dir * reach, y = L.gapY;
  const sample = { ticks: 0, nan: 0, penetration: 0, edgePenetration: 0, strainMax: 0, strainTicks: 0, volumeMin: Infinity, volumeMax: 0, escaped: 0, behindAtEnd: 0, firstBad: null };
  const p = [0, 0, 0];
  ctx.watch = () => {
    const h = mantle.health();
    sample.ticks++;
    sample.nan += h.nan;
    sample.strainMax = Math.max(sample.strainMax, h.strainMax);
    if (h.strainMax > 1) sample.strainTicks++;
    if (!sample.firstBad && (h.strainMax > 1 || h.nan || h.volume < 0.2)) sample.firstBad = { tick: sample.ticks, strain: +h.strainMax.toFixed(2), volume: +h.volume.toFixed(2), center: [...pose.center].map((v) => +v.toFixed(3)) };
    sample.volumeMin = Math.min(sample.volumeMin, h.volume);
    sample.volumeMax = Math.max(sample.volumeMax, h.volume);
    const pos = mantle.positions, o = mantle.origin;
    for (let i = 0; i < mantle.shell.count; i++) {
      p[0] = pos[i * 3] + o[0]; p[1] = pos[i * 3 + 1] + o[1]; p[2] = pos[i * 3 + 2] + o[2];
      sample.penetration = Math.max(sample.penetration, penetration(p, panel));
      if (p[0] < -TANK.w / 2 - 0.01 || p[0] > TANK.w / 2 + 0.01 || p[1] < -0.01 || p[1] > TANK.h + 0.01 || Math.abs(p[2]) > TANK.d / 2 + 0.01) sample.escaped++;
    }
    // Edge midpoints too: a face can bridge a lip with all three of its vertices clear.
    for (const [a, b] of mantle.edges) {
      p[0] = (pos[a * 3] + pos[b * 3]) / 2 + o[0]; p[1] = (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2 + o[1]; p[2] = (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2 + o[2];
      sample.edgePenetration = Math.max(sample.edgePenetration, penetration(p, panel));
    }
  };
  // The posture flattens so every root target clears the hole's edges; pinned roots never collide.
  const squash = Math.max(0.15, Math.min(1, (L.gapH / 2 - 0.012) / pose.rootDrop));
  const t0 = performance.now();
  ctx.arms.lead = [exitX + dir * 0.3, y, 0];
  try {
    await pose.follow([
      [0, pose.center[0], pose.center[1], pose.center[2], 1],
      [approach, startX, y, 0, 1],
      [approach + 1.5, startX, y, 0, squash],
      [approach + 1.5 + through, exitX, y, 0, squash],
      [approach + 1.5 + through + 1, exitX, y, 0, 1],
      [approach + 1.5 + through + 1 + settle, exitX, y, 0, 1],
    ]);
  } finally {
    ctx.arms.lead = null;
  }
  // The path resolves inside a tick's posture update, before that tick's step; judge the stepped shell.
  mantle.sync();
  ctx.watch();
  ctx.watch = null;
  const pos = mantle.positions, o = mantle.origin, farFace = L.panelX + dir * L.panelT / 2;
  for (let i = 0; i < mantle.shell.count; i++) if ((pos[i * 3] + o[0] - farFace) * dir < 0) sample.behindAtEnd++;
  const c = mantle.centroid();
  const end = mantle.health();
  sample.endStrain = end.strainMax;
  sample.endVolume = end.volume;
  const result = {
    verts: mantle.shell.count, drive: mantle.drive, direction: dir, iterations: mantle.knobs.iterations, pressurePa: mantle.knobs.pressurePa,
    gapH: L.gapH, bullnose: L.bullnose, restDiameter: 2 * mantle.shell.radii[1], squash: +squash.toFixed(2),
    ...sample, centroid: c.map((v) => +v.toFixed(3)), wallMs: Math.round(performance.now() - t0), step: ctx.phys.stats(),
  };
  // Through, unclipped at every vertex and edge midpoint each tick, and recovered; a brief stretch at the lip is squish,
  // an unbounded one is an explosion.
  result.passed = sample.nan === 0 && sample.behindAtEnd === 0 && sample.escaped === 0 && Math.max(sample.penetration, sample.edgePenetration) < 0.012
    && sample.volumeMin > 0.25 && sample.volumeMax < 1.6 && sample.strainMax < 3 && end.strainMax < 0.5 && end.volume > 0.85;
  return result;
}
