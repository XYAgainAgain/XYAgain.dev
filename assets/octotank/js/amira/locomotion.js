import {
  LOCO_KNOBS, ROLE, ROLE_NAMES, lerp, clamp, wrap, springTarget, strokeRate, ellMax, segAtArc, flatDir, footTarget, usefulness,
  wantPushers, crowd, hazard, fires, releaseReason, surfaceMode, capFor, arrivedPlace, arrivedEpisode, stallStep, yawTerm, toneAccel,
} from './locomotion-core.js';
import { createRng, deriveSeed } from '../../../pond/js/rng.js';

/* Her locomotion: a desire (a target and an urgency) solved by her arms alone. Each arm runs its own stroke machine on
   its own seeded clock; a planted arm drives its skin patch with one spring along its own line, pushing on the floor.
   Ticks after the pose and before the mantle, reading the arms one tick stale. */

const WINDOW = 1800;
const { idle: IDLE, seek: SEEK, planted: PLANTED, recover: RECOVER, station: STATION, busy: BUSY, cool: COOL } = ROLE;

/* The floor push: a foot near the body behind the travel, a rest length that grows, a release at full extension.
   Other modes (the climb's pull) register beside it with the same five calls, plus optional hooks: choose, release,
   travel, arrived, finish, holdStation, cap (a planted arm's cap), and describe (the Gait line while a mode holds her). */
export const PUSH = {
  name: 'push',
  usefulness: (loco, a, n) => usefulness(n, loco.dFlat, loco.knobs.pairWeights[a] ?? 1, loco.lat, loco.knobs.steer),
  seek(loco, a, root, n, out) {
    const k = loco.knobs, arm = loco.arms.arms[a], nrm = loco._n3;
    const f = footTarget(root, n, loco.dFlat, k, out, loco.arms.sdf?.distance ?? null, nrm);
    if (!f) return null;
    const r = arm.rad0[segAtArc(arm.arc0, k.footArc) + 1] ?? arm.rad0[0];
    for (let i = 0; i < 3; i++) out[i] += nrm[i] * r * (1 - k.footPress);
    return { contactArc: k.footArc / arm.length };
  },
  accept(loco, a, o) {
    const k = loco.knobs, arm = loco.arms.arms[a], mid = arm.arc0[o.seg] + arm.len0[o.seg] / 2;
    if (!(Math.abs(mid - k.footArc) <= k.footTol)) return false;
    // Any furniture face will do, the floor or a wall she's backed against, as long as the foot lies behind her: its line
    // to the root must point along the travel.
    const p = loco.mantle.rootWorld(a, loco._p3), ux = p[0] - o.p[0], uy = p[1] - o.p[1], uz = p[2] - o.p[2], l = Math.hypot(ux, uy, uz);
    return l > 1e-6 && (ux * loco.dFlat[0] + uz * loco.dFlat[2]) / l >= k.helpMin;
  },
  rate: (loco, a, u) => strokeRate(loco.vWant, u),
  max: (loco, a) => ellMax(loco.arms.arms[a].len0, loco.arms.arms[a].lamMax, loco.anchorSeg[a], loco.knobs.extend),
};

export class Locomotion {
  constructor({ mantle, arms, pose, attention = null, toys = [] }, { seed = 1, knobs = {} } = {}) {
    this.mantle = mantle;
    this.arms = arms;
    this.pose = pose;
    this.attention = attention;
    this.toys = toys;
    this.knobs = { ...LOCO_KNOBS, ...knobs };
    this.knobs.pairWeights = [...this.knobs.pairWeights];
    const n = this.n = mantle.roots.length;
    this.modes = new Map([['push', PUSH]]);
    this._modeList = [PUSH];
    this._why = { ell: 0, max: 0, chord: 0, along: 0, helpMin: 0, lostT: 0, grace: 0, t: 0, tMax: 0 };
    this.rng = Array.from({ length: n }, (_, a) => createRng(deriveSeed(seed, 5501 + a)));
    this.role = new Uint8Array(n);
    this.roleT = new Float64Array(n);
    this.strokeMode = new Array(n).fill(PUSH);
    this.ell = new Float64Array(n);
    this.chord = new Float64Array(n);
    this.max = new Float64Array(n);
    this.rate = new Float64Array(n);
    this.lostT = new Float64Array(n);
    this.holdF = new Float64Array(n);
    this.anchorP = new Float64Array(n * 3);
    this.anchorN = new Float64Array(n * 3);
    this.anchorSeg = new Int32Array(n).fill(-1);
    this.anchorEntry = new Array(n).fill(null);
    this.anchorTaste = new Array(n).fill(null);
    this.desire = null;
    this.hold = false;        // a probe holds the mantle's arm modes; the controller keeps its hands off them
    this.time = 0;
    this.c = [0, 0, 0]; this._cPrev = [0, 0, 0]; this._started = false;
    this.v = [0, 0, 0];
    this.dFlat = [0, 0, 0]; this.d3 = [0, 0, 0]; this.vWant = [0, 0, 0];
    this.travel = [0, 0, 0];
    this.lat = [0, 0, 0];     // her sideways velocity across the travel, over the wanted speed
    this.stall = { t: 0, ema: 0 };
    this.phase = 0;
    this.listeners = new Set();
    this.stanceP = new Float64Array(n * 3);
    this.stanceOn = false;
    this.settleT = 0;
    this._calmT = 0;
    this.wander = null;
    this._live = false;
    this._recoverBase = null;
    this._rf = { p: [0, 0, 0], n: [0, 0, 0], t: [0, 0, 0] };
    this._bf = { f: [1, 0, 0], u: [0, 1, 0], s: [0, 0, 1] };
    this._p3 = [0, 0, 0]; this._u3 = [0, 0, 0]; this._t3 = [0, 0, 0]; this._y3 = [0, 0, 0]; this._n3 = [0, 1, 0]; this._f3 = [0, 0, 0];
    this._nf = [0, 0, 0];
    this._toneAcc = null;
    // The rest crown's center, which the tone's rest offsets hang from.
    const R = mantle.roots, P = mantle.shell.positions;
    this._c0 = [0, 0, 0];
    for (const i of R) for (let a = 0; a < 3; a++) this._c0[a] += P[i * 3 + a] / R.length;
    this.msBuf = new Float32Array(WINDOW);
    this.msCount = 0;
    this.ms = 0;
    this.state = {
      mode: 'idle', desire: null, arrived: false, failed: null, speed: 0, along: 0, roles: Array.from({ length: n }, () => 'idle'),
      planted: 0, seeking: 0, stations: 0, pushT: 0, pullT: 0, floorT: 0, pairPushT: new Float64Array(4), stallT: 0, strokes: 0,
      strokeDur: [], releases: { full: 0, blocked: 0, help: 0, lost: 0, long: 0, done: 0, taken: 0 }, note: '',
    };
  }

  /* A mode beside the push (the climb's pull): an object with the same calls as PUSH. */
  registerMode(name, mode) { this.modes.set(name, mode); this._modeList = [...this.modes.values()]; }

  get canPlant() { return typeof this.arms.plant === 'function' && typeof this.arms.unplant === 'function'; }

  /* Want a place ([x, y, z] or {x, y, z}), a toy (entry or index), or a piece of furniture. Urgency 0–1 sets speed,
     caps, recruitment, and recovery. Returns the desire, whose `done` resolves with how it ended. */
  want(target, { urgency = 0.3, arriveR = null, source = 'call' } = {}) {
    const t = this._resolve(target);
    if (!t) return null;
    if (this.desire) this._finish(false, 'replaced');
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const u = clamp(Number.isFinite(urgency) ? urgency : 0.3, 0, 1);
    const d = { ...t, urgency: u, arriveR: Number.isFinite(arriveR) && arriveR > 0 ? arriveR : this.knobs.arriveR, source, t0: this.time, done, resolve, arrived: false, failed: null };
    this.desire = d;
    this.stall.t = 0; this.stall.ema = 0;
    this.state.arrived = false; this.state.failed = null;
    this._recoverBase ??= this.arms.knobs.recoverRate;
    const att = this.attention;
    if (!(att && (att.toy >= 0 || att.reach))) this.pose.attend(d.point);
    return d;
  }

  stop(why = 'stopped') { if (this.desire) this._finish(false, why); }

  _resolve(target) {
    if (typeof target === 'number') target = this.toys[target];
    if (target == null) return null;
    if (Array.isArray(target) || ArrayBuffer.isView(target)) {
      const p = [+target[0], +target[1], +target[2]];
      return p.every(Number.isFinite) ? { kind: 'place', entry: null, point: p, fixed: [...p] } : null;
    }
    if (target.body && target.tag) {
      const kind = target.tag === 'toy' ? 'toy' : 'furniture', point = [0, 0, 0];
      this._entryPoint(target, point);
      return point.every(Number.isFinite) ? { kind, entry: target, point, fixed: null } : null;
    }
    if (Number.isFinite(target.x + target.y + target.z)) return this._resolve([target.x, target.y, target.z]);
    return null;
  }

  _entryPoint(e, out) {
    if (e.motion === 'static') { out[0] = e.pos[0]; out[1] = e.pos[1]; out[2] = e.pos[2]; return out; }
    const p = e.body.GetPosition();
    out[0] = p.GetX(); out[1] = p.GetY(); out[2] = p.GetZ();
    return out;
  }

  _finish(arrived, failed) {
    const d = this.desire;
    if (!d) return;
    this.desire = null;
    for (const m of this._modeList) m.finish?.(this, arrived);
    d.arrived = arrived; d.failed = failed;
    this.state.arrived = arrived; this.state.failed = failed;
    if (this.pose.focus?.point === d.point) this.pose.attend(null);
    for (let a = 0; a < this.n; a++) if (this.role[a] === PLANTED || this.role[a] === SEEK) this._release(a, 'done');
    if (this._recoverBase !== null) { this.arms.knobs.recoverRate = this._recoverBase; this._recoverBase = null; }
    d.resolve({ arrived, failed, t: +(this.time - d.t0).toFixed(3), source: d.source });
  }

  tick(dt) {
    const t0 = performance.now();
    this._tick(dt);
    this.ms = performance.now() - t0;
    if (dt > 0) this.msBuf[this.msCount++ % WINDOW] = this.ms;
    if (dt > 0) for (const f of this.listeners) f(dt);
  }

  _tick(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    const k = this.knobs, m = this.mantle, st = this.state;
    if (this.hold) { st.mode = 'held'; this._started = false; return; }
    if (this.pose.rigid || m.drive !== 'force') {
      if (this._live) this._standDown(2);
      this._live = false;
      st.mode = this.pose.path ? 'rigid (path)' : 'rigid';
      return;
    }
    if (!k.enabled) {
      if (this._live) this._standDown(0);
      m.armMode.fill(0);
      this._live = false;
      st.mode = 'off';
      return;
    }
    this._live = true;
    this._readBody(dt);
    this.wander?.tick(dt);
    this._desire(dt);
    this._arms(dt);
    this._tone();
    st.mode = this.desire ? 'crawl' : st.stations ? 'station' : 'idle';
  }

  /* Off the body: everything planted lets go and the patches go back to the posture (2) or loose (0). */
  _standDown(mode) {
    for (let a = 0; a < this.n; a++) if (this.role[a] !== IDLE && this.role[a] !== BUSY) this._release(a, 'done');
    this.role.fill(IDLE);
    this.mantle.armMode.fill(mode);
    this._started = false;
    this.stanceOn = false;
  }

  _readBody(dt) {
    const m = this.mantle, c = m.ring().c, P = this._cPrev;
    for (let i = 0; i < 3; i++) this.c[i] = c[i];
    if (this._started) for (let i = 0; i < 3; i++) this.v[i] = (c[i] - P[i]) / dt;
    else this.v.fill(0);
    for (let i = 0; i < 3; i++) P[i] = c[i];
    this._started = true;
    this.state.speed += (Math.hypot(this.v[0], this.v[2]) - this.state.speed) * (1 - Math.exp(-dt / 0.3));
    this.settleT = Math.hypot(this.v[0], this.v[1], this.v[2]) < this.knobs.stanceSpeed ? this.settleT + dt : 0;
  }

  _desire(dt) {
    const d = this.desire, k = this.knobs, st = this.state;
    this.vWant.fill(0); this.dFlat.fill(0); this.d3.fill(0);
    this.phase = 0;
    if (!d) { st.stallT = 0; return; }
    if (d.entry) this._entryPoint(d.entry, d.point);
    if (!d.point.every(Number.isFinite)) return this._finish(false, 'lost target');
    const wall = d.kind === 'place' && d.point[1] > 0.05, climb = this.modes.has('pull');
    // Up a wall with no climb registered, she goes to the floor below it and stops a standoff short.
    const T = this.travel;
    T[0] = d.point[0]; T[1] = wall && !climb ? 0 : d.point[1]; T[2] = d.point[2];
    const flat = flatDir(this.c, T, this.dFlat);
    if (this._arrived(d, T, flat, wall && climb)) return this._finish(true, null);
    const dx = T[0] - this.c[0], dy = T[1] - this.c[1], dz = T[2] - this.c[2], l = Math.hypot(dx, dy, dz);
    if (l > 1e-6) { this.d3[0] = dx / l; this.d3[1] = dy / l; this.d3[2] = dz / l; }
    const sp = lerp(k.speedCalm, k.speedHurried, d.urgency);
    for (let i = 0; i < 3; i++) this.vWant[i] = this.dFlat[i] * sp;
    st.along = this.v[0] * this.dFlat[0] + this.v[2] * this.dFlat[2];
    for (const m of this._modeList) { const al = m.travel?.(this, sp); if (Number.isFinite(al)) st.along = al; }
    // Smoothed like the stall's speed, so one jolt doesn't swing the choice of pushers.
    const f = 1 - Math.exp(-dt / Math.max(1e-3, k.stallTau));
    this.lat[0] += ((this.v[0] - st.along * this.dFlat[0]) / sp - this.lat[0]) * f;
    this.lat[2] += ((this.v[2] - st.along * this.dFlat[2]) / sp - this.lat[2]) * f;
    this.phase = stallStep(this.stall, st.along, sp, dt, k);
    st.stallT = this.stall.t;
    if (this.phase >= 2) this.modes.get('pull')?.onStall?.(this);
    if (this.phase === 3) return this._finish(false, 'stall');
    this.arms.knobs.recoverRate = lerp(k.recoverCalm, k.recoverHurried, d.urgency);
  }

  _arrived(d, T, flat, wall) {
    const k = this.knobs, A = this.arms;
    // A thing arrives only when a sucker tastes that very thing: a taste episode on it, or any segment's sucker side
    // touching it. Never by nearness; one she can't reach runs into the stall's give-up instead.
    if (d.kind === 'toy' || d.kind === 'furniture') return arrivedEpisode(A.episodes ?? [], d.entry) >= 0 || this._touching(d.entry);
    for (const m of this._modeList) { const r = m.arrived?.(this, d, T); if (r !== undefined) return r; }
    const up = d.point[1] > 0.05;
    return arrivedPlace(this.c, T, d.arriveR + (up && !wall ? k.wallStandoff : 0), !wall);
  }

  _touching(entry) {
    const K = this.arms.touchKind, E = this.arms.touchEntry;
    if (!entry || !K || !E) return false;
    for (let g = 0; g < K.length; g++) if (K[g] && E[g] === entry) return true;
    return false;
  }

  _arms(dt) {
    const k = this.knobs, m = this.mantle, A = this.arms, d = this.desire, st = this.state, pose = this.pose;
    const widen = this.phase >= 1, helpMin = widen ? k.helpMin / 2 : k.helpMin, urgency = d ? d.urgency : 0;
    let active = 0;
    for (let a = 0; a < this.n; a++) if (this.role[a] === SEEK || this.role[a] === PLANTED) active++;
    const want = wantPushers(urgency, k), crowdF = crowd(active, want, k.crowdFall);
    const up = m.up(this._f3), level = up[1] > 0.7;
    const eYaw = level ? wrap(pose.yawCmd - pose.yaw) : 0;
    const band = pose.knobs?.deadband ?? 0.3, turning = Math.abs(eYaw) > band * 0.3;
    // Standing, she turns only when told to (pose.command), on stations planted from the arms sealed on the floor;
    // attention and the idle drift leave the turning to her eyes, which keeps a resting body still.
    this._calmT = turning ? 0 : this._calmT + dt;
    if (!d && level && Number.isFinite(pose.command) && Math.abs(eYaw) > band * 0.3 && this.canPlant) { if (this.anchorDown() > 0) this.stanceOn = false; }
    // The stance: with nowhere to go and nothing planted, each patch holds where she settled, until a stroke plants.
    if (d ? st.planted > 0 : st.stations > 0) this.stanceOn = false;
    else if (!this.stanceOn && !d && this.settleT >= k.stanceSettle) {
      for (let a = 0; a < this.n; a++) m.rootWorld(a, this._p3), this.stanceP.set(this._p3, a * 3);
      this.stanceOn = true;
    }
    let planted = 0, seeking = 0, stations = 0;
    for (let a = 0; a < this.n; a++) {
      const arm = A.arms[a], g = arm.goal, mine = !!g && g.loco === this;
      let role = this.role[a];
      this.roleT[a] += dt;
      if (g && !mine) {
        if (role !== BUSY) { if (role === PLANTED || role === STATION) st.releases.taken++; this._set(a, BUSY); }
      } else if (A.episodes?.[a]?.h) {
        // A grip outranks a stroke: whatever this arm was doing for her gait, it lets go.
        if (role !== BUSY) { if (mine) this._release(a, 'taken'); this._set(a, BUSY); }
      } else if (role === BUSY) this._set(a, IDLE);
      else if ((role === SEEK || role === PLANTED || role === STATION) && !mine) {
        st.releases.taken++;
        this._set(a, role === SEEK ? COOL : RECOVER);
      }
      role = this.role[a];
      if (role === IDLE) this._idle(a, dt, d, helpMin, crowdF, widen);
      else if (role === SEEK) this._seek(a, d);
      else if (role === PLANTED) this._planted(a, dt, d, helpMin);
      else if (role === STATION) this._station(a, d, dt, turning);
      else if (role === RECOVER) {
        const arm2 = A.arms[a], top = Math.max(0, this.anchorSeg[a]);
        let rested = true;
        for (let j = 0; j <= top; j++) if (arm2.lam[j] > 1 + k.recoverTol) { rested = false; break; }
        if (rested || this.roleT[a] >= k.recoverMax) this._set(a, IDLE);
      } else if (role === COOL && this.roleT[a] >= k.seekCool) this._set(a, IDLE);
      role = this.role[a];
      const springy = role === PLANTED || role === STATION;
      m.armMode[a] = springy ? 1 : 0;
      if (springy) {
        let cap = role === STATION ? (turning ? Math.max(k.stationN, k.turnCap) : k.stationN) : capFor(urgency, this.holdF[a], k);
        for (const mo of this._modeList) cap = mo.cap?.(this, a, cap) ?? cap;
        this._spring(a, eYaw, cap);
        if (role === PLANTED) planted++; else stations++;
      } else if (this.stanceOn) {
        m.armMode[a] = 1;
        m.armTarget[a * 3] = this.stanceP[a * 3]; m.armTarget[a * 3 + 1] = this.stanceP[a * 3 + 1]; m.armTarget[a * 3 + 2] = this.stanceP[a * 3 + 2];
        m.armAxis[a * 3] = 0; m.armAxis[a * 3 + 1] = 0; m.armAxis[a * 3 + 2] = 0;
        m.armVel[a * 3] = 0; m.armVel[a * 3 + 1] = 0; m.armVel[a * 3 + 2] = 0;
        m.armCap[a] = k.stanceN;
      } else m.armCap[a] = Infinity;
      if (role === SEEK) seeking++;
      st.roles[a] = springy || !this.stanceOn ? ROLE_NAMES[role] : 'stance';
    }
    st.planted = planted; st.seeking = seeking; st.stations = stations;
  }

  /* Any role outside a stroke gives the arm's claim back, however the stroke ended. */
  _set(a, role) {
    this.role[a] = role; this.roleT[a] = 0;
    if (role !== SEEK && role !== PLANTED && role !== STATION) this.arms.unclaim?.(a, 'stroke');
  }

  _idle(a, dt, d, helpMin, crowdF, widen) {
    const k = this.knobs, A = this.arms;
    if (!this.canPlant) return;
    if (!d) {
      // Settled: an idle arm sealed on the furniture may hold her where she is.
      if (this.state.stations >= k.stations || !(A.anchorCount?.[a] > 0) || !fires(this.rng[a], k.stationRate, dt)) return;
      const o = A.anchorList[a][0];
      if (this._plant(a, o)) { this.ell[a] = this.chord[a]; this._set(a, STATION); this.state.stations++; }
      return;
    }
    const rf = this.mantle.rootFrame(a, this._rf), n = this._nf, nl = Math.hypot(rf.n[0], rf.n[2]);
    if (!(nl > 1e-6)) return;
    n[0] = rf.n[0] / nl; n[1] = 0; n[2] = rf.n[2] / nl;
    let mode = this.modes.get('push');
    for (const m of this._modeList) mode = m.choose?.(this, a, n, mode) ?? mode;
    const use = mode.usefulness(this, a, n);
    if (!(use >= helpMin) || !fires(this.rng[a], hazard(d.urgency, use, crowdF, k, widen), dt)) return;
    const foot = this._t3, opts = mode.seek(this, a, rf.p, n, foot);
    if (!opts) { this._set(a, COOL); return; }
    // A stroke never takes an arm a stronger owner holds.
    if (A.claim && !A.claim(a, 'stroke')) return;
    const arm = A.arms[a];
    const speed = lerp(arm.knobs.reachSpeed, arm.knobs.bendSpeedMax, d.urgency);
    if (!A.reach(a, foot, { ...opts, speed, hold: k.seekMax + 1 })) { this._set(a, COOL); return; }
    arm.goal.loco = this;
    this.strokeMode[a] = mode;
    this._set(a, SEEK);
  }

  _seek(a, d) {
    const A = this.arms, k = this.knobs, mode = this.strokeMode[a];
    if (!d) return this._release(a, 'done');
    const list = A.anchorList?.[a], cnt = A.anchorCount?.[a] ?? 0;
    for (let i = 0; i < cnt; i++) {
      const o = list[i];
      if (!mode.accept(this, a, o) || !this._plant(a, o)) continue;
      this.ell[a] = this.chord[a];
      this.max[a] = mode.max(this, a);
      this._set(a, PLANTED);
      return;
    }
    if (this.roleT[a] > k.seekMax) { A.arms[a].idle(); this._set(a, COOL); }
  }

  _plant(a, o) {
    const A = this.arms;
    if (!this.canPlant || (A.claim && !A.claim(a, 'stroke'))) return false;
    if (!A.plant(a, o)) { if (this.role[a] !== SEEK) A.unclaim?.(a, 'stroke'); return false; }
    const g = A.arms[a].goal;
    if (g) g.loco = this;
    for (let i = 0; i < 3; i++) { this.anchorP[a * 3 + i] = o.p[i]; this.anchorN[a * 3 + i] = o.n[i]; }
    this.anchorSeg[a] = o.seg;
    this.anchorEntry[a] = A.touchEntry?.[a * A.S + o.seg] ?? null;
    this.anchorTaste[a] = o.taste ?? null;
    this.holdF[a] = o.force ?? 0;
    this.lostT[a] = 0;
    this.chord[a] = this._chordNow(a);
    return true;
  }

  _chordNow(a) {
    const p = this.mantle.rootWorld(a, this._p3);
    return Math.hypot(p[0] - this.anchorP[a * 3], p[1] - this.anchorP[a * 3 + 1], p[2] - this.anchorP[a * 3 + 2]);
  }

  /* The anchor's segment and its two neighbors: lost only when none of them has a sealed sucker for anchorGrace. */
  _anchorHold(a, dt) {
    const A = this.arms, list = A.anchorList?.[a], cnt = A.anchorCount?.[a] ?? 0, s = this.anchorSeg[a];
    let f = 0;
    for (let i = 0; i < cnt; i++) if (Math.abs(list[i].seg - s) <= 1) f += list[i].force;
    if (f > 0) { this.holdF[a] = f; this.lostT[a] = 0; } else this.lostT[a] += dt;
  }

  _planted(a, dt, d, helpMin) {
    const k = this.knobs, mode = this.strokeMode[a];
    this._anchorHold(a, dt);
    const p = this.mantle.rootWorld(a, this._p3), A = this._y3;
    for (let i = 0; i < 3; i++) A[i] = this.anchorP[a * 3 + i];
    const u = this._u3, c = springTarget(p, A, this.ell[a], this._t3, u, this._anchorN(a));
    this.chord[a] = c;
    if (!d) return this._release(a, 'done');
    const rate = mode.rate(this, a, u);
    this.rate[a] = rate;
    this.ell[a] = clamp(this.ell[a] + rate * dt, 0.02, c + k.leadMax);
    const along = u[0] * this.dFlat[0] + u[1] * this.dFlat[1] + u[2] * this.dFlat[2];
    const W = this._why;
    W.ell = this.ell[a]; W.max = this.max[a]; W.chord = c; W.along = along; W.helpMin = helpMin; W.lostT = this.lostT[a];
    W.grace = k.anchorGrace; W.t = this.roleT[a]; W.tMax = k.strokeMax;
    const why = mode.release ? mode.release(this, a, c) : releaseReason(W);
    if (why) return this._release(a, why);
    const st = this.state;
    if (this.anchorN[a * 3 + 1] > k.floorCos) {
      st.floorT += dt;
      if (rate > 0) { st.pushT += dt; st.pairPushT[Math.min(a, this.n - 1 - a)] += dt; }
    }
    if (rate < 0) st.pullT += dt;
  }

  _station(a, d, dt, turning) {
    const k = this.knobs;
    this._anchorHold(a, dt);
    this.chord[a] = this._chordNow(a);
    for (const m of this._modeList) if (m.holdStation?.(this, a)) return this.lostT[a] > k.anchorGrace ? this._release(a, 'lost') : undefined;
    // Turning, a station's line gives way and only its tangential term pulls; at rest it holds its length.
    if (turning) this.ell[a] = this.chord[a];
    // With somewhere to go a station passes no force (its rest length is the chord) and soon lets go.
    if (d) { this.ell[a] = this.chord[a]; if (this.roleT[a] > 0.3) this._release(a, 'done'); return; }
    if (this.lostT[a] > k.anchorGrace) return this._release(a, 'lost');
    if (this.roleT[a] > k.stationMax || (this._calmT > k.stationLinger && !this.pose.command)) return this._release(a, 'done');
    if (this.anchorN[a * 3 + 1] > k.floorCos) this.state.floorT += dt;
  }

  _anchorN(a) { const n = this._n3; n[0] = this.anchorN[a * 3]; n[1] = this.anchorN[a * 3 + 1]; n[2] = this.anchorN[a * 3 + 2]; return n; }

  /* The root target A + u·ℓ*, plus the heading's tangential term, into the mantle with this arm's cap. */
  _spring(a, eYaw, cap) {
    const m = this.mantle, k = this.knobs, p = m.rootWorld(a, this._p3), A = this._y3;
    for (let i = 0; i < 3; i++) A[i] = this.anchorP[a * 3 + i];
    const out = this._t3, u = this._u3;
    springTarget(p, A, this.ell[a], out, u, this._anchorN(a));
    if (eYaw) {
      const y = yawTerm(p[0] - this.c[0], p[2] - this.c[2], eYaw, k, this._f3);
      out[0] += y[0]; out[2] += y[2];
    }
    m.armTarget[a * 3] = out[0]; m.armTarget[a * 3 + 1] = out[1]; m.armTarget[a * 3 + 2] = out[2];
    m.armAxis[a * 3] = u[0]; m.armAxis[a * 3 + 1] = u[1]; m.armAxis[a * 3 + 2] = u[2];
    // A stroke's target runs along the line at the rest length's rate; a station's stands still.
    const r = this.role[a] === PLANTED ? this.rate[a] : 0;
    m.armVel[a * 3] = u[0] * r; m.armVel[a * 3 + 1] = u[1] * r; m.armVel[a * 3 + 2] = u[2] * r;
    m.armCap[a] = Math.max(0, cap);
  }

  _release(a, why) {
    const A = this.arms, role = this.role[a], st = this.state;
    if (role === PLANTED) {
      st.strokes++;
      if (st.strokeDur.length < 2000) st.strokeDur.push(+this.roleT[a].toFixed(3));
    }
    if (why in st.releases) st.releases[why]++;
    const arm = A.arms[a];
    if (arm.goal?.loco === this) {
      if (arm.goal.kind === 'plant' && this.canPlant) A.unplant(a);
      else arm.idle();
    }
    this.mantle.armMode[a] = 0;
    this._set(a, role === SEEK ? COOL : role === STATION ? IDLE : RECOVER);
  }

  /* Tone: free patches pulled toward their rest shape in her live body frame, momentum-neutral. */
  _tone() {
    const k = this.knobs, m = this.mantle;
    if (!(k.toneK > 0)) return;
    const acc = this._toneAcc ??= new Float32Array(m.shell.count * 3);
    toneAccel(m.positions, m.origin, m.shell.positions, this._c0, m.ring().c, m.bodyFrame(this._bf), m.driven, m.drivenArm, m.armMode, k.toneK, acc);
    m.addAccel(acc, { neutral: 'both' });
  }

  /* Let go of everything and leave the patches loose (0) or on the posture (2): for a mode that takes the whole body. */
  standDown(mode = 0) { this._standDown(mode); this._live = false; }

  /* Hold arm a on one of its anchors ({ seg, p, n, force, taste }) as a station; false if the arm can't be had. */
  plantStation(a, anchor) {
    if (!anchor || this.role[a] !== IDLE || !this._plant(a, anchor)) return false;
    this.ell[a] = this.chord[a];
    this._set(a, STATION);
    this.state.stations++;
    return true;
  }

  /* Plant every arm already sealed on the furniture as a station, up to max; for a turn on the spot. */
  anchorDown(max = this.knobs.stations) {
    let n = 0;
    for (let a = 0; a < this.n && this.state.stations + n < max; a++) {
      if (this.role[a] !== IDLE || !(this.arms.anchorCount?.[a] > 0) || this.arms.arms[a].goal) continue;
      const list = this.arms.anchorList[a];
      let o = null;
      for (let i = 0; i < this.arms.anchorCount[a]; i++) if (list[i].n[1] > this.knobs.floorCos) { o = list[i]; break; }
      if (o && this._plant(a, o)) { this.ell[a] = this.chord[a]; this._set(a, STATION); n++; }
    }
    this.state.stations += n;
    return n;
  }

  stats() {
    const n = Math.min(this.msCount, WINDOW);
    if (!n) return { n: 0, mean: 0, p95: 0, max: 0 };
    const s = Array.from(this.msBuf.subarray(0, n)).sort((x, y) => x - y);
    return { n, mean: s.reduce((x, y) => x + y, 0) / n, p95: s[Math.min(n - 1, Math.floor(n * 0.95))], max: s[n - 1] };
  }

  resetStats() { this.msCount = 0; }

  /* One line for the panel. */
  describe() {
    const st = this.state, d = this.desire;
    if (st.mode === 'held') for (const mo of this._modeList) { const t = mo.describe?.(this); if (t) return t; }
    if (st.mode === 'off' || st.mode === 'held' || st.mode.startsWith('rigid')) return st.mode;
    const arms = st.roles.map((r, a) => (r === 'planted' ? a : -1)).filter((a) => a >= 0);
    const what = d ? `${d.source} → ${d.kind === 'toy' ? `toy ${this.toys.indexOf(d.entry)}` : d.kind === 'furniture' ? d.entry.taste : d.point.map((v) => v.toFixed(2)).join(', ')}` : this.wander?.describe() ?? 'idle';
    const move = d ? `  ${(st.speed * 100).toFixed(1)} cm/s, urgency ${d.urgency.toFixed(2)}${st.stallT > 0.5 ? `, stalled ${st.stallT.toFixed(1)} s` : ''}` : '';
    const note = this.canPlant ? '' : '  (no plant support yet)';
    return `${what}${move}  planted ${arms.join(',') || '–'}${st.seeking ? `  seeking ${st.seeking}` : ''}${st.stations ? `  stations ${st.stations}` : ''}${st.failed && !d ? `  last: ${st.failed}` : ''}${note}`;
  }
}

/* A loose or fixed thing's reach from its center, so wander skips one she is already beside. */
export function sizeOf(e) {
  if (!e?.size) return 0;
  return e.kind === 'box' ? Math.max(e.size[0], e.size[1], e.size[2]) : e.kind === 'sphere' ? e.size[0] : e.size[0] + e.size[1];
}
