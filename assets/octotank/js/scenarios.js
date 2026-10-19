import { crawlAngle, wrap } from './amira/locomotion-core.js';

/* The scenario registry: each scenario has a label, an optional key, and run(ctx, opts) resolving to a result with
   `passed`. The panel builds its buttons from this list and the headless harness runs the same entries through
   tank.scenario(name), so the two never drift. Later slices register theirs from their own modules. */

const registry = new Map(), watchers = new Set();
let running = null;

export function register(name, { label = name, key = null, run = null } = {}) {
  registry.set(name, { name, label, key, run });
  for (const fn of watchers) fn();
}

/* Calls fn after every registration, so a panel built first still picks up late scenarios; returns the unsubscribe. */
export function onRegister(fn) { watchers.add(fn); return () => watchers.delete(fn); }

export function list() { return [...registry.values()]; }

export function isRunning() { return running; }

export async function runScenario(name, ctx, opts = {}) {
  const s = registry.get(name);
  if (!s?.run) throw new Error(`scenario ${name}: not built yet`);
  if (running) throw new Error(`scenario ${running} is already running`);
  if (!ctx.loco) throw new Error('scenario: no locomotion');
  running = name;
  const k = ctx.loco.knobs, wander = k.wander;
  k.wander = false;
  ctx.loco.reset('scenario');
  try { return await s.run(ctx, opts); }
  finally { ctx.loco.reset('scenario over'); k.wander = wander; running = null; }
}

/* Resolves true once pred() holds on a fixed tick, false after `seconds` of sim time. */
export function until(loco, pred, seconds = Infinity) {
  return new Promise((resolve) => {
    let t = 0;
    const f = (dt) => {
      t += dt;
      const ok = pred();
      if (ok || t >= seconds) { loco.listeners.delete(f); resolve(!!ok); }
    };
    loco.listeners.add(f);
  });
}

export const simWait = (loco, seconds) => until(loco, () => false, seconds);

const r3 = (v) => +(+v).toFixed(3);
const stats = (a) => {
  if (!a.length) return { n: 0, mean: 0, cv: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / a.length, sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  return { n: a.length, mean: r3(mean), cv: r3(mean > 0 ? sd / mean : 0) };
};

/* Every tick: whether the posture ever went rigid, any arm springing without a hold, and the longest stall. At 10 Hz:
   the crown's path and the crawl direction against her body axis. */
function crawlWatch(ctx) {
  const { loco, mantle, pose } = ctx, w = { rigid: 0, unanchored: 0, stallMax: 0, path: 0, angles: [], ticks: 0 };
  const last = [...loco.c], f = { f: [1, 0, 0], u: [0, 1, 0], s: [0, 0, 1] };
  let acc = 0;
  w.fn = (dt) => {
    w.ticks++;
    if (pose.rigid) w.rigid++;
    for (let a = 0; a < mantle.armMode.length; a++) if (mantle.armMode[a] === 1 && loco.state.roles[a] !== 'planted' && loco.state.roles[a] !== 'station' && loco.state.roles[a] !== 'stance') w.unanchored++;
    w.stallMax = Math.max(w.stallMax, loco.state.stallT);
    acc += dt;
    if (acc < 0.1) return;
    const c = loco.c, v = [(c[0] - last[0]) / acc, 0, (c[2] - last[2]) / acc];
    w.path += Math.hypot(c[0] - last[0], c[2] - last[2]);
    if (Math.hypot(v[0], v[2]) > 0.02) w.angles.push(Math.abs(crawlAngle(v, mantle.bodyFrame(f).f)));
    last[0] = c[0]; last[1] = c[1]; last[2] = c[2];
    acc = 0;
  };
  loco.listeners.add(w.fn);
  return w;
}

async function leg(ctx, to, urgency, limit) {
  const { loco } = ctx, st = loco.state;
  const rel0 = { ...st.releases }, w = crawlWatch(ctx), push0 = st.pushT, floor0 = st.floorT, pull0 = st.pullT, pairs0 = [...st.pairPushT], strokes0 = st.strokeDur.length;
  const d = loco.want(to, { urgency, source: 'scenario' });
  if (!d) { loco.listeners.delete(w.fn); return { to, urgency, arrived: false, failed: 'refused' }; }
  let over = false;
  const timer = until(loco, () => over, limit).then(() => ({ arrived: false, failed: 'timeout' }));
  const res = await Promise.race([d.done, timer]);
  over = true;
  if (loco.desire === d) loco.stop('timeout');
  loco.listeners.delete(w.fn);
  const t = Math.max(1e-6, res.t ?? limit), pushT = st.pushT - push0, floorT = st.floorT - floor0;
  const pairs = Array.from(st.pairPushT, (v, i) => r3((v - pairs0[i]) / Math.max(1e-9, pushT)));
  const ang = w.angles.sort((a, b) => a - b), bins = new Array(12).fill(0);
  for (const a of ang) bins[Math.min(11, Math.floor(a / (Math.PI / 12)))]++;
  return {
    releases: Object.fromEntries(Object.entries(st.releases).map(([k, v]) => [k, v - rel0[k]])),
    to, urgency, arrived: res.arrived, failed: res.failed, t: r3(t), speed: r3(w.path / t), rigidTicks: w.rigid, unanchoredSpringTicks: w.unanchored,
    stallMax: r3(w.stallMax), pushShare: r3(floorT > 0 ? pushT / floorT : 0), pullT: r3(st.pullT - pull0), pairShare: pairs,
    strokes: stats(st.strokeDur.slice(strokes0)), angleMedianDeg: ang.length ? Math.round((ang[ang.length >> 1] * 180) / Math.PI) : null,
    angleModeDeg: ang.length ? bins.indexOf(Math.max(...bins)) * 15 + 7.5 : null,
  };
}

/* Across her side of the wall and back: a hurried run to the panel side, the scored calm crossing, a hurried return. */
async function crawl(ctx, { variant = null } = {}) {
  if (!ctx.loco.canPlant) return { passed: false, failed: 'no plant support in the arms yet' };
  if (variant === 'boulder') return { variant, leg: await leg(ctx, [-0.7, 0, -0.28], 0.3, 40), passed: null };
  const setup = await leg(ctx, [-0.05, 0, -0.2], 0.9, 20);
  const calm = await leg(ctx, [-0.88, 0, 0.2], 0.3, 40);
  const hurried = await leg(ctx, [-0.3, 0, 0.0], 0.9, 12);
  const legs = [calm, hurried];
  const pushT = legs.reduce((s, l) => s + l.pushShare, 0) / 2;
  const passed = calm.arrived && calm.t <= 40 && hurried.arrived && hurried.t <= 12 && calm.speed >= 0.03 && calm.speed <= 0.08
    && hurried.speed >= 0.12 && hurried.speed <= 0.24 && legs.every((l) => l.pushShare >= 0.7 && l.rigidTicks === 0 && l.unanchoredSpringTicks === 0 && l.stallMax <= 3);
  return { setup, calm, hurried, pushShareMean: r3(pushT), passed };
}

/* One arm hauled hard against the other seven held where they are, then all let go: the crown ring's span, as a share of
   its rest span, under the pull and on the way back. Uses the mantle's drive alone, so it needs no arm support. */
async function pull(ctx, { arm = 2, newtons = 8, reach = 0.5, hold = 3, recover = 3, settle = 1 } = {}) {
  const { loco, mantle: m } = ctx, k = loco.knobs, n = m.roots.length;
  await simWait(loco, settle);
  const rest = m.ringSpan(true).mean, before = m.ringSpan().mean, p = [0, 0, 0], rf = { p: [0, 0, 0], n: [0, 0, 0], t: [0, 0, 0] };
  loco.hold = true;
  const out = { arm, newtons, reach, restSpan: r3(rest), startSpan: r3(before / rest), minSpan: Infinity, maxSpan: 0, peakN: 0, meanN: 0, strainMax: 0, recoverT: null };
  try {
    for (let a = 0; a < n; a++) { m.rootWorld(a, p); m.armTarget.set(p, a * 3); m.armMode[a] = 1; m.armCap[a] = k.capHurried; }
    m.rootFrame(arm, rf);
    const fl = Math.hypot(rf.n[0], rf.n[2]) || 1;
    m.armTarget.set([rf.p[0] + (rf.n[0] / fl) * reach, rf.p[1], rf.p[2] + (rf.n[2] / fl) * reach], arm * 3);
    m.armCap[arm] = newtons;
    let t = 0, sumN = 0, cnt = 0;
    ctx.phase = 'pulling';
    await until(loco, () => {
      t += 1 / 60;
      const s = m.ringSpan(), h = m.health();
      out.minSpan = Math.min(out.minSpan, s.min / rest); out.maxSpan = Math.max(out.maxSpan, s.max / rest);
      out.peakN = Math.max(out.peakN, m.armForce[arm]); out.strainMax = Math.max(out.strainMax, h.strainMax);
      if (t > hold - 1) { sumN += m.armForce[arm]; cnt++; }
      return false;
    }, hold);
    out.meanN = r3(sumN / Math.max(1, cnt));
    m.armMode.fill(0);
    m.armCap.fill(Infinity);
    ctx.phase = 'recovering';
    let r = 0;
    await until(loco, () => {
      r += 1 / 60;
      const s = m.ringSpan();
      if (out.recoverT === null && s.min / rest >= 0.9 * Math.min(1, before / rest) && s.max / rest <= 1.1 * Math.max(1, before / rest)) out.recoverT = r3(r);
      return out.recoverT !== null;
    }, recover);
  } finally { loco.hold = false; ctx.phase = null; }
  out.minSpan = r3(out.minSpan); out.maxSpan = r3(out.maxSpan); out.peakN = r3(out.peakN); out.strainMax = r3(out.strainMax);
  out.passed = out.minSpan >= 0.7 && out.maxSpan <= 1.4 && out.recoverT !== null && out.recoverT <= 2;
  return out;
}

/* Her yaw from the whole crown ring: the circular mean of each root's bearing from the ring's center against its
   rest bearing, so a crown deformed by its holds can't fake a turn the way a two-root front can. */
function ringYaw(m) {
  const c = m.ring().c, P = m.positions, R = m.shell.positions, o = m.origin;
  let sx = 0, sz = 0;
  for (const i of m.roots) {
    const live = Math.atan2(P[i * 3 + 2] + o[2] - c[2], P[i * 3] + o[0] - c[0]), rest = Math.atan2(R[i * 3 + 2], R[i * 3]);
    sx += Math.cos(live - rest); sz += Math.sin(live - rest);
  }
  return Math.atan2(sz, sx);
}

/* A commanded turn on the spot, on stations: how long her whole crown takes to come within 0.1 rad of it. */
async function turn(ctx, { angle = 1, limit = 6, wait = 8 } = {}) {
  const { loco, pose } = ctx;
  if (!loco.canPlant) return { passed: false, failed: 'no plant support in the arms yet' };
  await until(loco, () => loco.anchorDown() >= 0 && loco.state.stations >= 3, wait);
  const held = loco.state.stations, rel0 = Object.values(loco.state.releases).reduce((a, b) => a + b, 0);
  const y0 = ringYaw(ctx.mantle);
  pose.command = wrap(pose.yaw + angle);
  let t = 0;
  // Turning toward +yaw (from +x to +z) turns the ring the same way.
  const ok = await until(loco, () => { t += 1 / 60; return Math.abs(wrap(ringYaw(ctx.mantle) - y0 - angle)) < 0.1; }, limit);
  pose.command = null;
  const releases = Object.values(loco.state.releases).reduce((a, b) => a + b, 0) - rel0;
  // 1.5× the time the turn-rate cap allows.
  const budget = 1.5 * Math.abs(angle) / pose.knobs.turnRate;
  return { angle, stations: held, arrived: ok, t: r3(t), budget: r3(budget), releases, passed: held >= 3 && ok && t <= budget && releases === 0 };
}

register('ball', { label: 'Ball', key: '1' });
register('crawl', { label: 'Crawl', key: '2', run: crawl });
register('climb', { label: 'Climb', key: '3' });
register('squeeze', { label: 'Squeeze slot', key: '4' });
register('pull', { label: 'One-arm pull', run: pull });
register('turn', { label: 'Turn 1 rad', run: turn });
