import { crawlAngle, wrap } from '../amira/locomotion/locomotion-core.js';
import { TANK } from '../config.js';

/* The scenario registry: each scenario has a label, an optional key, and run(ctx, opts) resolving to a result with
   `passed`. The panel builds its buttons from this list and the headless harness runs the same entries through
   tank.scenario(name), so the two never drift. Later slices register theirs from their own modules. */

const registry = new Map(), watchers = new Set();
let running = null;

/* `bench` marks a scenario for the bench (?bench=arm), which runs without her body or locomotion. */
export function register(name, { label = name, key = null, run = null, bench = false } = {}) {
  registry.set(name, { name, label, key, run, bench });
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
  if (s.bench !== !!ctx.bench) throw new Error(`scenario ${name}: ${s.bench ? 'needs the bench (?bench=arm)' : 'not on the bench'}`);
  if (s.bench) {
    running = name;
    try { return await s.run(ctx, opts); } finally { running = null; }
  }
  if (!ctx.loco) throw new Error('scenario: no locomotion');
  running = name;
  const k = ctx.loco.knobs, wander = k.wander;
  k.wander = false;
  ctx.loco.reset('scenario');
  try { return await s.run(ctx, opts); }
  finally { ctx.loco.reset('scenario over'); k.wander = wander; running = null; }
}

/* Resolves true once pred() holds on a fixed tick, false after `seconds` of sim time; `loco` is anything whose
   `listeners` are called every tick (locomotion, or the bench). */
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

/* Her arms at their worst while a check runs, every `every` ticks as health() measures them: NaN, the furniture (how deep,
   and any center inside it), her body, arm on arm, and her skin's strain; done() adds the crossings and stops watching. */
export function armWatch(ctx, every = 3) {
  const { arms, mantle, loco } = ctx, c0 = arms.contact.crossings;
  const w = { nan: 0, pen: 0, center: 0, body: 0, armOnArm: 0, strain: 0, crossings: 0 };
  let n = 0;
  const fn = () => {
    if (n++ % every) return;
    const h = arms.health();
    w.nan += h.nan; w.pen = Math.max(w.pen, h.penetration); w.center = Math.max(w.center, h.centerPenetration);
    w.body = Math.max(w.body, h.bodyPenetration, h.bodyMidPenetration); w.armOnArm = Math.max(w.armOnArm, h.armPenetration);
    w.strain = Math.max(w.strain, mantle.health().strainMax);
  };
  loco.listeners.add(fn);
  return () => {
    loco.listeners.delete(fn);
    w.crossings = arms.contact.crossings - c0;
    for (const k of ['pen', 'center', 'body', 'armOnArm', 'strain']) w[k] = +w[k].toFixed(4);
    return w;
  };
}

const bodyOk = (w) => w.nan === 0 && w.strain < 1.6;

/* All her arms curled in under her at once and held, then let go into her resting curl: the densest her arms pile. */
async function pile(ctx, { curl = 2, hold = 5, rest = 6 } = {}) {
  const { loco, arms } = ctx, n = arms.arms.length, was = arms.resting, done = armWatch(ctx);
  let w;
  loco.hold = true;
  try {
    for (let a = 0; a < n; a++) if (arms.claim(a, 'mode')) arms.tuck(a, curl);
    await simWait(loco, hold);
    for (let a = 0; a < n; a++) arms.unclaim(a, 'mode');
    arms.idle();
    arms.resting = true;
    await simWait(loco, rest);
  } finally {
    w = done();
    loco.hold = false; arms.resting = was;
    for (let a = 0; a < n; a++) arms.unclaim(a, 'mode');
  }
  return { curl, ...w, passed: bodyOk(w) };
}

/* The heaviest toy thrown at one arm after another, from in front and above a point along each as it lies: an arm should be
   shoved aside, never passed through. met counts ticks the solve found an arm inside the toy before pushing it out. */
async function throwToy(ctx, { speed = 1.5, throws = 4, seconds = 2, along = 0.5 } = {}) {
  const { loco, arms, phys, toys } = ctx;
  let toy = null;
  for (const t of toys ?? []) if (t.motion === 'dynamic' && (!toy || phys.inverseMass(t) < phys.inverseMass(toy))) toy = t;
  if (!toy) return { passed: null, failed: 'no toys' };
  const ti = arms.loose.indexOf(toy), w = arms.allSdf, nrm = [0, 0, 0], big = Math.max(...toy.size), n = arms.arms.length;
  const o = { toy: toy.kind, kg: r3(1 / phys.inverseMass(toy)), speed, throws: [], met: 0, deepest: 0, inToy: 0, closest: Infinity, nan: 0 };
  const done = armWatch(ctx), dir = [0, -0.55, -0.83], dl = Math.hypot(...dir), back = 0.06 + big;
  let wa;
  try {
    await simWait(loco, 1);
    for (let k = 0; k < throws; k++) {
      const a = (1 + 3 * k) % n, body = arms.bodies[a], at = Math.round(along * (body.n - 1)), p = body.X.slice(at * 3, at * 3 + 3);
      // From inside the tank, whatever wall the arm lies along.
      const room = big + 0.02, inside = (v, half) => Math.max(-half + room, Math.min(half - room, v));
      const from = [inside(p[0] - dir[0] / dl * back, TANK.w / 2), Math.max(big + 0.01, p[1] - dir[1] / dl * back), inside(p[2] - dir[2] / dl * back, TANK.d / 2)];
      phys.teleport(toy, from[0], from[1], from[2], 0, 0, 0, 1);
      phys.stopKinematic(toy); // a teleport keeps the last throw's rebound, so zero it (works on a dynamic body too)
      phys.wake(toy);
      const J = speed / Math.max(1e-9, phys.inverseMass(toy)) / dl;
      phys.impulseAt(toy, dir[0] * J, dir[1] * J, dir[2] * J, from[0], from[1], from[2]);
      const one = { arm: a, met: 0, inToy: 0 };
      await until(loco, () => {
        const met = arms.pushPen[a * arms.loose.length + ti];
        if (met > 0) { one.met++; o.deepest = Math.max(o.deepest, met); }
        const c = toy.body.GetPosition(), cx = c.GetX(), cy = c.GetY(), cz = c.GetZ();
        w.unfocus();
        for (const b of arms.bodies) {
          const X = b.X;
          for (let i = 1; i < b.n; i++) {
            if (!Number.isFinite(X[i * 3] + X[i * 3 + 1] + X[i * 3 + 2])) { o.nan++; continue; }
            const pen = w.collide(X[i * 3], X[i * 3 + 1], X[i * 3 + 2], b.rad[i], nrm);
            if (pen > 0 && w.hit === arms._looseAt + ti) { one.inToy = Math.max(one.inToy, pen); o.inToy = Math.max(o.inToy, pen); }
            o.closest = Math.min(o.closest, Math.hypot(X[i * 3] - cx, X[i * 3 + 1] - cy, X[i * 3 + 2] - cz) - big - b.rad[i]);
          }
        }
        return false;
      }, seconds);
      o.met += one.met; one.inToy = r3(one.inToy);
      o.throws.push(one);
    }
  } finally { wa = done(); }
  o.deepest = r3(o.deepest); o.inToy = r3(o.inToy); o.closest = r3(o.closest);
  return { ...o, watch: wa, passed: o.nan === 0 && bodyOk(wa) && o.met > 0 };
}

/* Resting where she is until she has dug in and lies snug in her den (or the time runs out), then a few seconds more. */
async function denRest(ctx, { limit = 40, after = 5 } = {}) {
  const { loco, arms, den } = ctx;
  if (!den) return { passed: null, failed: 'no den (?den=0, or no sand)' };
  const was = arms.resting, done = armWatch(ctx);
  arms.resting = true;
  let snug = false, w;
  try {
    snug = await until(loco, () => den.state === 'snug', limit);
    await simWait(loco, after);
  } finally { w = done(); arms.resting = was; }
  return { snug, den: den.last, ...w, passed: snug && bodyOk(w) };
}

register('ball', { label: 'Ball', key: '1' });
register('crawl', { label: 'Crawl', key: '2', run: crawl });
register('climb', { label: 'Climb', key: '3' });
register('squeeze', { label: 'Squeeze slot', key: '4' });
register('pull', { label: 'One-arm pull', run: pull });
register('turn', { label: 'Turn 1 rad', run: turn });
register('pile', { label: 'Arm pile', run: pile });
register('throw', { label: 'Toy thrown', run: throwToy });
register('den', { label: 'Den rest', run: denRest });
