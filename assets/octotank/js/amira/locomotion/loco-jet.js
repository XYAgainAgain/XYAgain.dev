import { JET_KNOBS, OxygenDebt, jetSpeed, swimSpeed, jetThrust, steerAlpha, steerAccel, domeCancel, adrift, stopDistance, rayHit, smoothstep, clamp } from './loco-jet-core.js';
import { register, until } from '../../diag/scenarios.js';

/* Her jets: mantle-first at 45 cm/s to 1 m/s with her arms trailing, and the slower head-first swim. Thrust is one uniform acceleration on every
   skin vertex (no torque, no tearing), steered by a force-free turn of her mantle onto the course; she holds the locomotion controller off while it
   runs, then sinks on spread arms and owes an oxygen debt. Ticks as a listener after the gait and before the mantle steps. */

const FLOOR_COS = 0.7;

export class Jet {
  constructor(loco, { parts = null } = {}) {
    this.loco = loco;
    this.mantle = loco.mantle;
    this.arms = loco.arms;
    this.parts = parts;
    for (const key in JET_KNOBS) loco.knobs[key] ??= JET_KNOBS[key];
    this.k = loco.knobs;
    this.debt = new OxygenDebt(this.k);
    this.phase = 'off';        // 'thrust', 'glide', or 'off'
    this.kind = 'jet';         // or 'swim', head-first
    this.reason = '';
    this.dir = [0, 0, -1];     // the course, unit, or read from `to` each tick
    this.to = null;
    this.vWant = 0;
    this.stopAtWalls = true;
    this.heartStopped = false;
    this.siphonDir = null;     // world direction the funnel blows while thrusting, null otherwise
    this.t = 0;
    this.owned = new Uint8Array(loco.n);
    this.coasting = false;
    this.lastClick = null;
    this.adriftClock = { t: 0 };
    const n = this.mantle.shell.count;
    this._thrust = new Float32Array(n * 3);
    this._turn = new Float32Array(n * 3);
    this.c = [0, 0, 0]; this._cPrev = [0, 0, 0]; this.v = [0, 0, 0]; this.speed = 0;
    this.axis = [0, 1, 0]; this._axisPrev = [0, 1, 0]; this.w = [0, 0, 0]; this.apex = [0, 0, 0];
    this._alpha = [0, 0, 0]; this._d = [0, 0, 0]; this._n = [0, 0, 0]; this._p = [0, 0, 0];
    this._hold = null;
    this._read = false;
    this.last = null;          // how the last jet went, for scenarios and the panel
    this.listeners = new Set();
    this._listen = (dt) => this._tick(dt);
    this._listen.reset = () => this.reset();
    loco.listeners.add(this._listen);
  }

  /* A scenario's setup or teardown: any jet in flight ends where she is. The oxygen debt stays owed. */
  reset() {
    if (this.phase === 'thrust') this._endThrust('reset');
    if (this.phase !== 'off') this._land(false);
    this.adriftClock.t = 0;
  }

  get busy() { return this.phase !== 'off'; }

  /* A jet (or with kind 'swim', the head-first swim) along dir, or toward point `to`. speed overrides urgency's. Returns
     true, or a string saying why not. */
  start({ dir = null, to = null, speed = null, urgency = 1, reason = 'command', kind = 'jet', stopAtWalls = true } = {}) {
    const L = this.loco, k = this.k, m = this.mantle;
    if (this.phase !== 'off') return 'already moving';
    if (L.hold) return 'held by a probe';
    if (this.arms.lead) return 'the scripted squeeze has the arms';
    if (!k.enabled || L.pose.rigid || m.drive !== 'force') return 'no soft drive';
    if (kind === 'jet' && !this.debt.ready) return this.debt.debt > k.jetReady ? 'oxygen debt' : 'resting';
    this._body(0);
    const c = this.c, d = this._d;
    if (to && [0, 1, 2].every((i) => Number.isFinite(+to[i]))) { d[0] = to[0] - c[0]; d[1] = to[1] - c[1]; d[2] = to[2] - c[2]; }
    else if (dir && [0, 1, 2].every((i) => Number.isFinite(+dir[i]))) { d[0] = +dir[0]; d[1] = +dir[1]; d[2] = +dir[2]; }
    else return 'no course';
    const l = Math.hypot(d[0], d[1], d[2]);
    if (!(l > 1e-6)) return 'no course';
    for (let i = 0; i < 3; i++) this.dir[i] = d[i] / l;
    this.to = to ? [+to[0], +to[1], +to[2]] : null;
    this.kind = kind === 'swim' ? 'swim' : 'jet';
    const u = clamp(Number.isFinite(urgency) ? urgency : 1, 0, 1);
    this.vWant = Number.isFinite(speed) && speed > 0 ? Math.min(speed, k.vJetMax) : this.kind === 'jet' ? jetSpeed(u, k) : swimSpeed(u, k);
    if (this.kind === 'jet') this.debt.start();
    this.reason = reason;
    this.stopAtWalls = stopAtWalls !== false;
    // The crawl stands down: strokes and stations let go, the stance lets go, every patch is left free.
    L.standDown(0);
    L.hold = true;
    this._claimArms();
    this._hold = { exhale: 0.5, depth: 0, outflow: 1 };
    if (!m.breathHold) m.breathHold = this._hold;
    this.phase = 'thrust';
    this.t = 0;
    this.last = { kind: this.kind, reason, v: +this.vWant.toFixed(3), from: c.map((x) => +x.toFixed(3)), peak: 0, meters: 0, thrustT: 0, ended: null, glideT: 0, landed: false };
    this._emit('start');
    return true;
  }

  /* Away from a point: a startle this urgent jets, a gentler one crawls off. */
  startle(point, strength = 1) {
    const L = this.loco, c = L.mantle.ring().c, s = clamp(Number.isFinite(strength) ? strength : 1, 0, 1);
    let fx = c[0] - point[0], fz = c[2] - point[2];
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-6) { fx /= fl; fz /= fl; } else { fx = 0; fz = -1; }
    if (s >= this.k.jetUrgency) {
      const r = this.start({ dir: [fx, 0.3, fz], urgency: s, reason: 'startle' });
      if (r === true) return 'jet';
    }
    L.want([c[0] + fx * 0.4, 0, c[2] + fz * 0.4], { urgency: s, source: 'startle' });
    return 'crawl';
  }

  /* End the jet now; the glide and landing follow. */
  stop(why = 'stopped') { if (this.phase === 'thrust') this._endThrust(why); }

  _claimArms() {
    const A = this.arms;
    this.owned.fill(0);
    for (let a = 0; a < A.arms.length; a++) {
      // A gripping arm keeps its prize; everything else trails (or tucks, for the swim).
      if (A.episodes?.[a]?.h || A.owner?.[a] === 'held') continue;
      if (A.claim && !A.claim(a, 'mode')) continue;
      this.owned[a] = 1;
      if (this.kind === 'swim') this._arm(a, 'tuck');
      else this._arm(a, 'trail');
    }
  }

  /* Set or refresh arm a's goal through the arms' wrappers; without them the arm is left to its own program. */
  _arm(a, kind) {
    const A = this.arms, arm = A.arms[a], g = arm.goal;
    if (kind === 'trail') {
      const v = this.speed > 0.1 ? this._unitV() : this.axisThrust();
      if (g?.kind === 'trail') { g.v[0] = v[0]; g.v[1] = v[1]; g.v[2] = v[2]; return; }
      if (typeof A.trail === 'function') A.trail(a, v, this.k.jetSpread, this.k.trailStiff, this.k.trailTip);
    } else if (kind === 'spread') {
      if (g?.kind !== 'spread' && typeof A.spread === 'function') A.spread(a, this.k.spreadDown);
    } else if (kind === 'tuck') {
      if (g?.kind !== 'tuck' && typeof A.tuck === 'function') A.tuck(a);
    }
  }

  _unitV() { const s = this.speed || 1; this._p[0] = this.v[0] / s; this._p[1] = this.v[1] / s; this._p[2] = this.v[2] / s; return this._p; }

  /* The way the thrust pushes her: head toward mantle for a jet, the reverse for the swim. */
  axisThrust(out = this._n) {
    const s = this.kind === 'swim' ? -1 : 1;
    out[0] = this.axis[0] * s; out[1] = this.axis[1] * s; out[2] = this.axis[2] * s;
    return out;
  }

  /* Her mass centroid and its velocity, the mantle axis and its swing rate, and the vertex leading along the thrust. */
  _body(dt) {
    const m = this.mantle, P = m.positions, o = m.origin, w = m.vertexMass, n = m.shell.count, c = this.c;
    let M = 0, x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) { M += w[i]; x += w[i] * P[i * 3]; y += w[i] * P[i * 3 + 1]; z += w[i] * P[i * 3 + 2]; }
    c[0] = x / M + o[0]; c[1] = y / M + o[1]; c[2] = z / M + o[2];
    const a = m.mantleAxis(this.axis), ap = this._axisPrev;
    if (this._read && dt > 0) {
      for (let i = 0; i < 3; i++) this.v[i] = (c[i] - this._cPrev[i]) / dt;
      // The axis's swing: ω = a_prev × a / dt, smoothed over the breathing pulses' jitter.
      const f = 1 - Math.exp(-dt / 0.05);
      const wx = (ap[1] * a[2] - ap[2] * a[1]) / dt, wy = (ap[2] * a[0] - ap[0] * a[2]) / dt, wz = (ap[0] * a[1] - ap[1] * a[0]) / dt;
      this.w[0] += (wx - this.w[0]) * f; this.w[1] += (wy - this.w[1]) * f; this.w[2] += (wz - this.w[2]) * f;
    } else { this.v.fill(0); this.w.fill(0); }
    this.speed = Math.hypot(this.v[0], this.v[1], this.v[2]);
    for (let i = 0; i < 3; i++) { this._cPrev[i] = c[i]; ap[i] = a[i]; }
    this._read = true;
    const t = this.axisThrust();
    let best = -Infinity, bi = 0;
    for (let i = 0; i < n; i++) { const s = P[i * 3] * t[0] + P[i * 3 + 1] * t[1] + P[i * 3 + 2] * t[2]; if (s > best) { best = s; bi = i; } }
    this.apex[0] = P[bi * 3] + o[0]; this.apex[1] = P[bi * 3 + 1] + o[1]; this.apex[2] = P[bi * 3 + 2] + o[2];
  }

  _tick(dt) {
    if (!(dt > 0)) return;
    const L = this.loco;
    this.debt.tick(dt);
    if (L.desire?.source === 'click') this.lastClick = [...L.desire.point];
    if (this.phase === 'off') { this._read = false; return this._watchAdrift(dt); }
    this.t += dt;
    this._body(dt);
    if (this.phase === 'thrust') this._thrustTick(dt);
    else this._glideTick(dt);
  }

  /* Adrift with somewhere to go: swim to a near target when calm, jet otherwise. */
  _watchAdrift(dt) {
    const L = this.loco, d = L.desire, A = this.arms, k = this.k;
    if (!d || L.hold || L.state.mode !== 'crawl') { this.adriftClock.t = 0; return; }
    let anchors = 0;
    for (let a = 0; a < L.n; a++) anchors += A.anchorCount?.[a] ?? 0;
    const sdf = A.sdf;
    if (!sdf) return;
    sdf.unfocus?.();
    const c = L.mantle.ring().c, dist = sdf.distance(c[0], c[1], c[2], this._n);
    if (!adrift(this.adriftClock, dist, anchors, dt, k)) return;
    this.adriftClock.t = 0;
    const far = Math.hypot(d.point[0] - c[0], d.point[1] - c[1], d.point[2] - c[2]);
    const kind = far <= k.swimDist && d.urgency < k.jetUrgency ? 'swim' : 'jet';
    this.start({ to: d.point, urgency: d.urgency, reason: 'adrift', kind });
  }

  _thrustTick(dt) {
    const k = this.k, m = this.mantle, L = this.last, M = m.knobs.mass, drag = m.knobs.damping, n = m.shell.count;
    const d = this._d;
    if (this.to) {
      d[0] = this.to[0] - this.c[0]; d[1] = this.to[1] - this.c[1]; d[2] = this.to[2] - this.c[2];
      const l = Math.hypot(d[0], d[1], d[2]);
      if (l <= this.loco.knobs.arriveR) return this._endThrust('arrived');
      for (let i = 0; i < 3; i++) d[i] /= l;
    } else for (let i = 0; i < 3; i++) d[i] = this.dir[i];
    const t = this.axisThrust(), along = this.v[0] * t[0] + this.v[1] * t[1] + this.v[2] * t[2];
    // Thrust waits until the funnel's push points near enough the course, so she turns before she goes.
    const gate = smoothstep(k.jetAlign0, k.jetAlign1, t[0] * d[0] + t[1] * d[1] + t[2] * d[2]);
    const F = jetThrust(M, drag, this.vWant, along, k) * gate, a = F / M;
    const T = this._thrust;
    for (let i = 0; i < n; i++) { T[i * 3] = t[0] * a; T[i * 3 + 1] = t[1] * a; T[i * 3 + 2] = t[2] * a; }
    m.addAccel(T, { neutral: false });
    const R = this._turn;
    steerAccel(m.positions, m.vertexMass, n, steerAlpha(t, d, this.w, k, this._alpha), R);
    domeCancel(m.dome, m.knobs.righting, k.jetDome, R);
    m.addAccel(R, { neutral: 'force' });
    // The visible stroke: the breathing muscles pulsed at jetHz, water leaving through the funnel the whole time.
    if (m.breathHold === this._hold) {
      this._hold.exhale = 0.5 + 0.5 * Math.sin(2 * Math.PI * k.jetHz * this.t);
      this._hold.depth = (this.kind === 'jet' ? k.jetDepth : k.swimDepth) * gate;
      this._hold.outflow = 1;
    }
    this.heartStopped = this.kind === 'jet';
    this.siphonDir = this.siphonDir ?? [0, 0, 0];
    this.siphonDir[0] = -t[0]; this.siphonDir[1] = -t[1]; this.siphonDir[2] = -t[2];
    this.parts?.aimSiphon?.(this.siphonDir);
    const step = this.speed * dt;
    L.meters += step; L.thrustT += dt; L.peak = Math.max(L.peak, this.speed);
    const spent = this.debt.add(step, this.kind === 'jet' ? 1 : k.swimDebt);
    for (let a = 0; a < this.owned.length; a++) if (this.owned[a]) this._arm(a, this.kind === 'swim' ? 'tuck' : 'trail');
    this._emit('thrust', dt);
    if (spent) return this._endThrust('spent');
    if (this.t >= k.jetMaxT) return this._endThrust('time');
    if (this.stopAtWalls && this.arms.sdf) {
      this.arms.sdf.unfocus?.();
      // Along the course, not her velocity: the launch's first ticks can point her motion into the floor she leaves.
      const stop = stopDistance(this.speed, drag, k);
      if (rayHit(this.arms.sdf.distance, this.apex, d, stop + 0.05) <= stop) return this._endThrust('wall');
    }
  }

  _endThrust(why) {
    const m = this.mantle;
    this.last.ended = why;
    this.last.peak = +this.last.peak.toFixed(3); this.last.meters = +this.last.meters.toFixed(3); this.last.thrustT = +this.last.thrustT.toFixed(3);
    this.debt.end();
    this.heartStopped = false;
    this.siphonDir = null;
    this.parts?.aimSiphon?.(null);
    if (m.breathHold === this._hold) m.breathHold = null;
    this._hold = null;
    this.phase = 'glide';
    this.t = 0;
    this.coasting = this.kind === 'jet';
    this._emit('end');
  }

  /* Sinking after a jet on spread arms: landed once an arm holds the floor, or the crown rests near it, or at landMax. */
  _glideTick(dt) {
    const k = this.k, A = this.arms, L = this.loco;
    this.last.glideT += dt;
    // Still coasting fast, the arms keep trailing; once she slows they open into the parachute.
    if (this.coasting && this.speed < k.spreadSpeed) this.coasting = false;
    for (let a = 0; a < this.owned.length; a++) if (this.owned[a]) this._arm(a, this.kind === 'swim' ? 'tuck' : this.coasting ? 'trail' : 'spread');
    if (this.coasting) this._emit('coast', dt);
    let floorHold = false;
    for (let a = 0; a < L.n && !floorHold; a++) {
      const list = A.anchorList?.[a], cnt = A.anchorCount?.[a] ?? 0;
      for (let i = 0; i < cnt; i++) if (list[i].n[1] > FLOOR_COS) { floorHold = true; break; }
    }
    let near = false;
    if (A.sdf) {
      A.sdf.unfocus?.();
      const c = L.mantle.ring().c, nrm = this._n, dist = A.sdf.distance(c[0], c[1], c[2], nrm);
      near = dist <= k.landGap && nrm[1] > FLOOR_COS;
    }
    if (((floorHold || near) && this.speed < k.landSpeed) || this.t >= k.landMax) this._land(floorHold || near);
  }

  _land(onFloor) {
    const A = this.arms, L = this.loco;
    for (let a = 0; a < this.owned.length; a++) {
      if (!this.owned[a]) continue;
      const g = A.arms[a].goal;
      if (g && (g.kind === 'trail' || g.kind === 'spread' || g.kind === 'tuck')) A.arms[a].idle();
      A.unclaim?.(a, 'mode');
    }
    this.owned.fill(0);
    this.phase = 'off';
    L.hold = false;
    // Arms sealed on the floor as she settles become stations, so she lands planted.
    const stations = L.canPlant ? L.anchorDown() : 0;
    Object.assign(this.last, { landed: !!onFloor, glideT: +this.last.glideT.toFixed(3), stations });
    this._emit('land');
  }

  _emit(what, dt = 0) { for (const f of this.listeners) f(what, this, dt); }

  describe() {
    if (this.phase === 'off') return this.debt.debt > 0.01 ? `debt ${this.debt.debt.toFixed(2)}${this.debt.ready ? '' : ', resting'}` : '';
    return `${this.kind} ${this.phase} (${this.reason})  ${(this.speed * 100).toFixed(0)} cm/s  debt ${this.debt.debt.toFixed(2)}${this.heartStopped ? '  heart stopped' : ''}`;
  }

  destroy() {
    if (this.phase !== 'off') { if (this.phase === 'thrust') this._endThrust('destroyed'); this._land(false); }
    this.loco.listeners.delete(this._listen);
  }
}

const r3 = (v) => +(+v).toFixed(3);

/* The bearing with the longest clear run from c, rising `rise` per unit across the floor: room to reach speed and stop. */
export function longestCourse(sdf, c, rise = 0.3, bearings = 24) {
  let best = null, bestL = -1;
  const nrm = [0, 0, 0];
  sdf.unfocus?.();
  for (let i = 0; i < bearings; i++) {
    const th = (i / bearings) * 2 * Math.PI, d = [Math.cos(th), rise, Math.sin(th)], l = Math.hypot(...d);
    for (let a = 0; a < 3; a++) d[a] /= l;
    const run = rayHit(sdf.distance, [c[0], c[1] + 0.04, c[2]], d, 2, 0.05, nrm);
    const len = Number.isFinite(run) ? run : 2;
    if (len > bestL) { bestL = len; best = d; }
  }
  return { dir: best, run: bestL };
}

/* The jet check: from the floor, a full-urgency jet. The mantle leads, six or more arm tips trail 0.2 m behind the
   crown at some point while she thrusts or coasts, it stops by its debt or short of a wall, a second jet soon after is refused, and she lands and plants within
   10 s. Variant 'wall' jets straight into the back glass at 1 m/s with no stop, for the stability bar alone. */
export async function jetScenario(ctx, { dir = null, urgency = 1, variant = null, settle = 1 } = {}) {
  const { loco, arms: A, mantle: m } = ctx, jet = loco.jetMode;
  if (!jet) return { passed: false, failed: 'no jet installed' };
  await until(loco, () => false, settle);
  const wall = variant === 'wall';
  let course = dir, run = null;
  if (wall) course = [0, 0, -1];
  else if (!course) ({ dir: course, run } = longestCourse(A.sdf, m.ring().c));
  const w = { ticks: 0, lead: 0, leadTicks: 0, trailAtPeak: 0, trailMax: 0, peak: 0, p: [0, 0, 0] };
  const watch = (what) => {
    if (what !== 'thrust' && what !== 'coast') return;
    const v = jet.v, sp = jet.speed, thrust = what === 'thrust';
    w.ticks++;
    if (thrust && sp > 0.05) {
      w.leadTicks++;
      const a = jet.axis;
      if ((a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) / sp > 0.8) w.lead++;
    }
    // Arm tips behind the crown along the travel by 0.2 m or more.
    const c = m.ring().c;
    let behind = 0;
    const backs = [];
    if (sp > 0.05) for (const arm of A.arms) {
      const X = arm.X, i = (arm.n - 1) * 3, back = -((X[i] - c[0]) * v[0] + (X[i + 1] - c[1]) * v[1] + (X[i + 2] - c[2]) * v[2]) / sp;
      backs.push(`${arm.goal?.kind ?? '-'}:${r3(arm.w)}:${r3(back)}`);
      if (back >= 0.2) behind++;
    }
    w.trailMax = Math.max(w.trailMax, behind);
    if (thrust && sp >= w.peak) { w.peak = sp; w.trailAtPeak = behind; w.arms = backs; }
  };
  jet.listeners.add(watch);
  try {
    const started = jet.start({ dir: course, urgency, speed: wall ? 1 : null, reason: 'scenario', stopAtWalls: !wall });
    if (started !== true) return { passed: false, failed: `refused: ${started}` };
    await until(loco, () => jet.phase !== 'thrust', 20);
    const last = { ...jet.last };
    await until(loco, () => false, 1);
    const second = jet.start({ dir: course, urgency, reason: 'scenario' });
    if (second === true) jet.stop('second');
    let landT = 0;
    await until(loco, () => { landT += 1 / 60; return jet.phase === 'off'; }, 15);
    const planted = await until(loco, () => loco.state.stations + loco.state.planted > 0 || jet.last.stations > 0, 1);
    const out = {
      variant, course: course.map(r3), run: run === null ? null : r3(run), ...last, landed: jet.last.landed, landT: r3(landT + 1), stations: jet.last.stations ?? 0,
      leadShare: r3(w.lead / Math.max(1, w.leadTicks)), trailAtPeak: w.trailAtPeak, armsAtPeak: w.arms, trailMax: w.trailMax, secondRefused: second !== true, second: second === true ? 'started' : second,
      planted, debt: r3(jet.debt.debt),
    };
    if (wall) { out.passed = null; return out; }
    out.passed = out.peak >= 0.45 && out.peak <= 1.0 && out.leadShare >= 0.8 && out.trailMax >= 6 && (out.ended === 'spent' || out.ended === 'wall')
      && out.secondRefused && out.landed && out.landT <= 10 && planted;
    return out;
  } finally {
    jet.listeners.delete(watch);
    if (jet.phase === 'thrust') jet.stop('scenario over');
  }
}

/* J: jet away from the camera's glass toward the back, or toward the last clicked point if there is one. */
export async function jetKey(ctx) {
  const jet = ctx.loco.jetMode;
  if (!jet) return { passed: null, failed: 'no jet installed' };
  const to = jet.lastClick;
  const r = jet.start(to ? { to, urgency: 1, reason: 'key' } : { dir: [0, 0.3, -1], urgency: 1, reason: 'key' });
  if (r !== true) return { passed: null, refused: r };
  jet.lastClick = null;
  await until(ctx.loco, () => jet.phase === 'off', 20);
  return { passed: null, ...jet.last };
}

/* Install on a Locomotion: loco.jet(opts), loco.startle(point, strength), loco.heartStopped, and the scenarios. */
export function installJet(loco, opts = {}) {
  const jet = new Jet(loco, opts);
  loco.jetMode = jet;
  // Registered for its Gait line while it holds her; it has none of a stroke mode's hooks, so it is never chosen.
  loco.registerMode('jet', jet);
  loco.jet = (o) => jet.start(o);
  loco.startle = (p, s) => jet.startle(p, s);
  Object.defineProperty(loco, 'heartStopped', { get: () => jet.heartStopped, configurable: true });
  register('jet', { label: 'Jet', key: 'j', run: jetKey });
  register('jetCheck', { label: 'Jet check', run: jetScenario });
  return jet;
}
