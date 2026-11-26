import { ROLE, lerp } from './locomotion-core.js';
import { ellMin, releaseSafe, holdAhead, CLIMB_KNOBS } from './loco-climb-core.js';
import {
  SQUEEZE_KNOBS, routeThrough, threadScore, pickThreaders, lipPoint, farHoldPoint, nearHoldPoint, isNearHold, isFarHold,
  faceCounts, weightedAxis, lengthAlong, lengthenGain, lengthenField, turnField, cavityHold,
  restSection, passageFit, tunnelRoute, sigmaOf, sOfSigma, boreHold, boreCounts,
} from './loco-squeeze-core.js';
import { passageAt, passageTangent, passageProject, passageOut } from './loco-passage-core.js';
import { register, until } from '../../diag/scenarios.js';
import { tunnel } from './loco-tunnel-scenario.js';

/* The real squeeze, through the divider's slot or a passage in the rock: she lines up with her mantle trailing straight back, sends three or
   four arms through to seal beyond, empties her cavity and lengthens as far as the gap asks, and hauls herself through while the near holds push. */

const { idle: IDLE, seek: SEEK, planted: PLANTED, station: STATION } = ROLE;
const NEAR = 1, FAR = 2;
const NOOP = { name: 'squeeze-wait', usefulness: () => 0 };
const VOLUNTARY = new Set(['short', 'behind', 'long', 'full']);

export class Squeeze {
  constructor(loco, { apertures = [], passages = null } = {}) {
    const n = loco.n, m = loco.mantle, sh = m.shell;
    this.name = 'squeeze';
    this.loco = loco;
    for (const key in SQUEEZE_KNOBS) loco.knobs[key] ??= SQUEEZE_KNOBS[key];
    for (const key in CLIMB_KNOBS) loco.knobs[key] ??= CLIMB_KNOBS[key];
    this.k = loco.knobs;
    this.apertures = apertures;
    this.passages = passages ?? loco.arms.phys?.rockwork?.passages ?? [];
    this.way = null;
    this.desire = null;
    this.failed = null;
    this.stage = 'off';
    this.kind = new Uint8Array(n);
    this.holding = new Uint8Array(n);
    this.scores = new Float64Array(n);
    this.free = new Uint8Array(n);
    this.stageT = 0;
    this.times = {};
    this.timedOut = false;
    this._held = false;
    this._hold = null;
    this._angPrev = null;
    this.ratio = 1;
    // Her rest length along her head-to-mantle line, which the lengthening reads against.
    const wHead = Float32Array.from(m.vertexMass, (v, i) => v * sh.regions[i * 3 + 1]);
    const wMantle = Float32Array.from(m.vertexMass, (v, i) => v * sh.regions[i * 3]);
    const restAxis = weightedAxis(sh.positions, wHead, wMantle, sh.count);
    this.rest = lengthAlong(sh.positions, m.vertexMass, sh.count, restAxis, { extent: 0, rms: 0 });
    this._restAxis = restAxis;
    this._section = null;
    this._acc = new Float32Array(sh.count * 3);
    // What swings when she turns her mantle onto the slot's line: the mantle, never the crown her holds keep on the face.
    this._swing = Float32Array.from({ length: sh.count }, (_, i) => sh.regions[i * 3]);
    this._len = { extent: 0, rms: 0 };
    this._faces = { behind: 0, past: 0, inside: 0, lead: 0 };
    this._rf = { p: [0, 0, 0], n: [0, 0, 0], t: [0, 0, 0] };
    this._p = [0, 0, 0]; this._a = [0, 0, 0]; this._t = [0, 0, 0]; this._ax = [0, 0, 0]; this._want = [0, 0, 0];
    this._t3 = [0, 0, 0]; this._td = [0, 0, 0]; this._hn = [0, 0, 0]; this._pr = { s: 0, d: 0, i: 0 }; this._pa = { s: 0, d: 0, i: 0 };
    this.stats = { farHolds: 0, nearHolds: 0, refused: 0, haulPeak: 0, sends: { near: 0, thread: 0, far: 0 }, releases: { short: 0, behind: 0, long: 0, full: 0, lost: 0 } };
    this._listen = (dt) => this._tick(dt);
    loco.listeners.add(this._listen);
  }

  get active() { return this.stage === 'center' || this.stage === 'thread' || this.stage === 'haul'; }

  /* Her rest silhouette's area across her head-to-mantle line, what a passage's narrowest section is weighed against. */
  get section() { const sh = this.loco.mantle.shell; return this._section ??= restSection(sh.positions, sh.count, this._restAxis); }

  /* Through the slot to target, or just there when no panel is in the way: one desire, routed by the hook below. */
  go(target, { urgency = 0.6, via = undefined } = {}) {
    const d = this.loco.want(target, { urgency, source: 'squeeze' });
    if (d && via !== undefined) d.via = via;
    return d ? d.done : Promise.resolve({ arrived: false, failed: 'refused' });
  }

  /* The controller's waypoint hook: a desire whose straight line crosses a panel climbs to the slot first, lines up and
     threads there, then hauls through; once she is out, the travel is the target's own again. */
  route(loco, d, T) {
    if (d !== this.desire) this._plan(loco, d);
    if (!this.way) return;
    const r = this.way;
    if (r.kind === 'tunnel') return this._routeTunnel(T);
    if (this.stage === 'approach' || this.stage === 'center' || this.stage === 'thread') { T[0] = r.near[0]; T[1] = r.near[1]; T[2] = r.near[2]; }
    else if (this.stage === 'haul') for (let i = 0; i < 3; i++) T[i] = r.exit[i] + r.dir[i] * this.k.haulLead;
  }

  _plan(loco, d) {
    this._end();
    this.desire = d;
    const k = this.k, pull = loco.modes.has('pull');
    const r = (pull ? routeThrough(loco.c, d.point, this.apertures, k) : null) ?? (pull && this.passages.length ? this._tunnelPlan(loco, d) : null);
    if (!r) return;
    this.way = r;
    this.times = { start: loco.time };
    this.timedOut = false;
    // Too small: her hard parts decide, and she doesn't try.
    if (!r.fits) { this.failed = r.kind === 'tunnel' ? `too small: ${r.fit.why}` : 'too small'; this._setStage('refused'); return; }
    this._setStage(r.inside ? 'thread' : 'approach');
  }

  /* A desire that asks for a passage (d.via: one, or true for any) while passages are on, or any desire while she is in a
     bore: the route through it, weighed by her volume. */
  _tunnelPlan(loco, d) {
    let best = null, bd = Infinity;
    // In a bore she can't turn or reach behind her, so she goes on out the way her head faces: against her mantle.
    const ax = loco.mantle.mantleAxis(this._ax), head = this._want;
    head[0] = -ax[0]; head[1] = -ax[1]; head[2] = -ax[2];
    for (const P of this.passages) {
      const r = tunnelRoute(loco.c, d.point, P, this.k, head);
      if (!r || !(r.inside || (this.k.tunnels && (d.via === true || d.via === P)))) continue;
      const m = P.mouths[r.e].p, dd = r.inside ? -1 : Math.hypot(loco.c[0] - m[0], loco.c[1] - m[1], loco.c[2] - m[2]);
      if (dd < bd) { bd = dd; best = r; }
    }
    if (!best) return null;
    best.fit = passageFit(best.P, this.section, this.k);
    // From inside a bore she goes on out, fit or not.
    best.fits = best.fit.fits || best.inside;
    best.tight = best.fit.tight;
    best.lk = { lengthenTarget: 1 + (this.k.lengthenTarget - 1) * best.tight, lengthenK: this.k.lengthenK };
    return best;
  }

  /* How far past the entry mouth p lies along the centerline; out gets its projection. */
  _sigma(p, out = this._pr) { passageProject(this.way.P, p, out); return sigmaOf(this.way, out.s); }

  /* The centerline's unit tangent at sig, signed along the travel. */
  _tan(sig, out) {
    const r = this.way;
    passageTangent(r.P, sOfSigma(r, sig), out);
    out[0] *= r.sign; out[1] *= r.sign; out[2] *= r.sign;
    return out;
  }

  /* Approaching, the line-up point; after, the centerline a lead ahead of her crown, out to just past the exit. */
  _routeTunnel(T) {
    const r = this.way;
    if (this.stage === 'approach') { T[0] = r.near[0]; T[1] = r.near[1]; T[2] = r.near[2]; return; }
    if (!this.active) return;
    const sig = Math.min(r.L + this.k.exitPast, Math.max(0, this._sigma(this.loco.c)) + this.k.haulLead);
    if (sig <= r.L) passageAt(r.P, sOfSigma(r, sig), T); else passageOut(r.P, r.to, sig - r.L, T);
  }

  /* Every free arm rides her through a passage's whole desire, as on the squeeze's own errands. */
  carries(loco, d) { return !!d && d === this.desire && this.way?.kind === 'tunnel'; }

  _end() {
    if (this.stage !== 'off') this._setStage('off');
    this.desire = null;
    if (this.way) this.lastWay = this.way;
    this.way = null;
    this.failed = null;
    this._breath(false);
  }

  _setStage(s) { this.stage = s; this.stageT = 0; this.times[s] = this.loco.time; this._angPrev = null; }

  _speed() { const d = this.loco.desire; return d ? lerp(this.k.speedCalm, this.k.speedHurried, d.urgency) : 0; }

  _breath(on) {
    const m = this.loco.mantle;
    if (on) { if (!this._held || m.breathHold === null) m.breathHold = this._hold = this.way?.kind === 'tunnel' ? this._tunnelHold() : cavityHold(this.k); this._held = true; }
    else if (this._held) {
      // A jet that starts mid-haul keeps this hold; its pulse takes over here.
      if (m.breathHold === this._hold) m.breathHold = this.loco.jetMode?._hold ?? null;
      this._hold = null; this._held = false;
    }
  }

  // The controller's hooks, live only while this mode runs a passage.

  usefulness() { return 0; }

  /* While she threads, nothing else starts a stroke: this mode sends its own arms. */
  choose(loco, a, n, mode) { return this.active && loco.desire === this.desire ? NOOP : mode; }

  accept(loco, a, o) {
    const r = this.way;
    if (!r) return false;
    if (r.kind === 'tunnel') {
      const ahead = this._sigma(o.p, this._pa) - this._sigma(loco.c);
      return this.kind[a] === FAR ? ahead > this.k.farAhead : this.kind[a] === NEAR && ahead < -this.k.farAhead;
    }
    if (this.kind[a] === NEAR) return isNearHold(o.n, r);
    return isFarHold(o.p, r, this.k.farTol);
  }

  /* Every hold stands still until the haul; then each runs the one law along the slot's travel, so a far hold hauls
     her in and a near one, once she is past it, pushes. */
  rate(loco, a, u) {
    if (this.stage !== 'haul') return 0;
    if (this.way?.kind === 'tunnel') { const t = this._tan(this._sigma(loco.mantle.rootWorld(a, this._p)), this._t); return this._speed() * (t[0] * u[0] + t[1] * u[1] + t[2] * u[2]); }
    const d = this.way?.dir;
    return d ? this._speed() * (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) : 0;
  }

  max(loco, a) {
    const arm = loco.arms.arms[a];
    let s = 0;
    for (let j = 0; j <= loco.anchorSeg[a] && j < arm.len0.length; j++) s += arm.len0[j] * arm.lamMax[j];
    return loco.knobs.extend * s;
  }

  release(loco, a, chord) {
    const k = this.k, arm = loco.arms.arms[a];
    if (loco.lostT[a] > k.anchorGrace) return this._released(a, 'lost');
    if (this.stage !== 'haul') return null;
    const min = ellMin(arm.len0, loco.anchorSeg[a], k);
    loco.ell[a] = Math.min(Math.max(loco.ell[a], min, chord - k.leadMax), loco.max[a]);
    const A = this._a, p = loco.mantle.rootWorld(a, this._p);
    for (let i = 0; i < 3; i++) A[i] = loco.anchorP[a * 3 + i];
    let why = null;
    const tunnel = this.way.kind === 'tunnel', dir = tunnel ? this._tan(this._sigma(A, this._pa), this._t3) : this.way.dir;
    if (loco.ell[a] <= min + 1e-9) why = 'short';
    else if (loco.ell[a] >= loco.max[a] - 1e-9) why = 'full';
    else if (holdAhead(A, p, dir) < -k.behindTol && this.kind[a] === FAR) why = 'behind';
    else if (loco.roleT[a] > k.strokeMax) why = 'long';
    if (!why) return null;
    // Hand over hand: she lets go only while the rest still bear her; level in a bore, one other hold will do.
    const safe = tunnel ? this.holding.some((h, i) => h && i !== a) : releaseSafe(loco.holdF, this.holding, a, true, k);
    if (VOLUNTARY.has(why) && !safe) { this.stats.refused++; return null; }
    return this._released(a, why);
  }

  _released(a, why) {
    this.stats.releases[why] = (this.stats.releases[why] ?? 0) + 1;
    this.holding[a] = 0;
    return why;
  }

  /* Threading and lining up are not stalls: the stall clock reads her speed along the slot only while she hauls. */
  travel(loco, sp) {
    if (!this.active || loco.desire !== this.desire) return undefined;
    if (this.stage !== 'haul') return sp;
    const v = loco.v, d = this.way.kind === 'tunnel' ? this._tan(this._sigma(loco.c), this._t3) : this.way.dir;
    return v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
  }

  arrived(loco, d) { return d === this.desire && (this.active || this.stage === 'approach') ? false : undefined; }

  /* Lined up and threading, the near holds stay; the haul lets them go by the safety rule like any wall hold. */
  holdStation(loco, a) { return this.active && this.stage !== 'haul' && loco.desire === this.desire; }

  /* However the desire ends, the passage ends with it. */
  finish() { this._end(); }

  /* A far hold hauls at capHaul, never past what its seal safely bears; through a passage every hold of this mode pulls or
     pushes only as hard as its narrowest section asks. */
  cap(loco, a) {
    if (this.stage !== 'haul' || loco.role[a] !== PLANTED || loco.strokeMode[a] !== this) return undefined;
    if (this.kind[a] !== FAR && !(this.way.kind === 'tunnel' && this.kind[a] === NEAR)) return undefined;
    const k = this.k, haul = this.way.kind === 'tunnel' ? k.capEasy + (k.capHaul - k.capEasy) * this.way.tight : k.capHaul;
    return Math.min(haul, k.anchorSafety * Math.max(0, loco.holdF[a]));
  }

  /* After the controller each tick: the stage, the arms this mode sends, the haul's cap, the breath, and the muscles. */
  _tick(dt) {
    const L = this.loco, st = L.state.mode;
    if (this.desire && L.desire !== this.desire) { this._end(); return; }
    // Held (a jet), off, or rigid, her holds are gone and a flight moves her: the passage ends, and a desire still standing replans once she is live.
    if (st === 'off' || st === 'held' || st.startsWith('rigid')) { if (this.stage !== 'off') this._end(); return; }
    if (this.stage === 'refused') { L.stop(this.failed); return; }
    if (this.way?.kind === 'tunnel' && (this.stage === 'approach' || this.active)) { const why = this._stale(); if (why) { L.stop(why); return; } }
    if (this.stage === 'approach') return this.way.kind === 'tunnel' ? this._approachTunnel(dt) : this._approach();
    if (!this.active) return;
    this.stageT += dt;
    L.state.mode = `squeeze (${this.stage})`;
    if (this.way.kind === 'tunnel') return this._tickTunnel(dt);
    let near = 0, nearSeek = 0, far = 0, reaching = 0;
    for (let a = 0; a < L.n; a++) {
      const role = L.role[a], mine = L.strokeMode[a] === this;
      this.holding[a] = role === PLANTED || role === STATION ? 1 : 0;
      if (!this.holding[a] && role !== SEEK) this.kind[a] = 0;
      if (this.holding[a] && this._near(a)) near++;
      if (mine && role === SEEK && this.kind[a] === NEAR) nearSeek++;
      if (role === PLANTED && mine && this.kind[a] === FAR) far++;
      if (mine && (role === SEEK || role === PLANTED) && this.kind[a] === FAR) reaching++;
    }
    this.stats.nearHolds = near; this.stats.farHolds = far;
    if (this.stage === 'center') this._center(dt, near, nearSeek);
    else if (this.stage === 'thread') { this._turn(dt, near + far); this._thread(far, reaching); }
    else if (this.stage === 'haul') { this._turn(dt, near + far); this._haul(dt, reaching); }
  }

  /* Arrived at the slot, judged in the face's plane; her holds on the face stand still as stations. */
  _approach() {
    const L = this.loco, r = this.way, c = L.c, n = r.dir, k = this.k;
    const vx = c[0] - r.near[0], vy = c[1] - r.near[1], vz = c[2] - r.near[2], al = vx * n[0] + vy * n[1] + vz * n[2];
    if (Math.hypot(vx - al * n[0], vy - al * n[1], vz - al * n[2]) > k.approachR) return;
    for (let a = 0; a < L.n; a++) {
      if (L.role[a] !== PLANTED || !this._near(a)) continue;
      L.ell[a] = L.chord[a];
      L._set(a, STATION);
    }
    this._setStage('center');
  }

  _near(a) {
    const n = this._n3 ??= [0, 0, 0], N = this.loco.anchorN;
    n[0] = N[a * 3]; n[1] = N[a * 3 + 1]; n[2] = N[a * 3 + 2];
    return isNearHold(n, this.way);
  }

  /* Her mantle turned onto the slot's line, behind her, while two holds give her something to turn against; the field
     stands in for those arms twisting her body. Returns the cosine she has reached. */
  _turn(dt, holds, dir = this.way.dir, K = this.k.turnK) {
    const k = this.k, m = this.loco.mantle, ax = m.mantleAxis(this._ax), w = this._want;
    w[0] = -dir[0]; w[1] = -dir[1]; w[2] = -dir[2];
    const ang = Math.acos(Math.max(-1, Math.min(1, ax[0] * w[0] + ax[1] * w[1] + ax[2] * w[2])));
    const spin = this._angPrev === null ? 0 : (this._angPrev - ang) / dt;
    this._angPrev = ang;
    if (holds >= 2 && K > 0) m.addAccel(turnField(m.positions, m.vertexMass, m.shell.count, ax, w, K, k.turnDamp, spin, this._acc, this._swing), { neutral: 'force' });
    return Math.cos(ang);
  }

  _center(dt, near, nearSeek) {
    const k = this.k;
    if (near + nearSeek < k.nearHoldsMin) this._send(NEAR, k.nearHoldsMin - near - nearSeek);
    const cos = this._turn(dt, near), aligned = cos > k.alignCos;
    if ((aligned && near >= k.nearHoldsMin) || this.stageT > k.centerMax) {
      this.timedOut = !(aligned && near >= k.nearHoldsMin);
      this.times.alignCos = +cos.toFixed(3);
      this._setStage('thread');
    }
  }

  _thread(far, reaching) {
    const k = this.k;
    if (reaching < k.threadMax) this._send(FAR, k.threadMax - reaching, true);
    if (far >= k.farHoldsMin) {
      this._setStage('haul');
      this._breath(true);
      // Every near hold becomes a stroke on the one law along the slot.
      const L = this.loco;
      for (let a = 0; a < L.n; a++) {
        if (L.role[a] !== STATION || !this._near(a)) continue;
        L.strokeMode[a] = this; this.kind[a] = NEAR;
        L.max[a] = this.max(L, a);
        L._set(a, PLANTED);
      }
    }
  }

  _haul(dt, reaching) {
    const L = this.loco, k = this.k, m = L.mantle, r = this.way;
    this._breath(true);
    if (reaching < k.threadMax) this._send(FAR, k.threadMax - reaching, false);
    for (let a = 0; a < L.n; a++) if (L.role[a] === PLANTED && L.strokeMode[a] === this && this.kind[a] === FAR) this.stats.haulPeak = Math.max(this.stats.haulPeak, m.armForce[a]);
    const n = m.shell.count, len = lengthAlong(m.positions, m.vertexMass, n, r.dir, this._len);
    this.ratio = this.rest.rms > 0 ? len.rms / this.rest.rms : 1;
    const g = lengthenGain(this.ratio, k);
    if (g > 0) m.addAccel(lengthenField(m.positions, m.vertexMass, n, r.dir, g, this._acc), { neutral: 'both' });
    const f = faceCounts(m.positions, m.origin, n, r, this._faces);
    if (f.behind === 0 && f.inside === 0) this._out();
  }

  /* Through: the breath and the lengthening let go, and her holds carry on as the climb's pulls toward the target. */
  _out() {
    const L = this.loco, pull = L.modes.get('pull') ?? L.modes.get('push');
    this._breath(false);
    for (let a = 0; a < L.n; a++) {
      if (L.strokeMode[a] !== this) continue;
      this.kind[a] = 0;
      if (pull) L.strokeMode[a] = pull;
    }
    this._setStage('out');
    // A target in the bore is no place to crawl back into: out of it, that trip is over.
    if (this.way?.tIn) L.stop('the target is in the bore');
  }

  /* At the line-up point, or already at the mouth: whatever her feet hold stands still while her first arms go in. */
  _approachTunnel(dt) {
    const L = this.loco, r = this.way, c = L.c, k = this.k, d = Math.hypot(c[0] - r.near[0], c[1] - r.near[1], c[2] - r.near[2]);
    // Close in, she turns onto the line on her feet, so she reaches the mouth head first.
    if (d < k.tunnelTurn) {
      let holds = 0;
      for (let a = 0; a < L.n; a++) if (L.role[a] === PLANTED || L.role[a] === STATION) holds++;
      this._turn(dt, holds, r.dir, k.tunnelTurnK);
    }
    if (d > k.tunnelR && !(this._sigma(c) >= -k.tunnelR && this._onLine(c))) return;
    for (let a = 0; a < L.n; a++) {
      if (L.role[a] !== PLANTED) continue;
      L.ell[a] = L.chord[a];
      L._set(a, STATION);
    }
    this._setStage('thread');
  }

  /* Her crown c beside the centerline at this._pr (the last _sigma) with no rock between them, so she is at the mouth and
     not on the far side of a wall from it. */
  _onLine(c) {
    const r = this.way, pr = this._pr, dist = this.loco.arms.sdf?.distance;
    if (pr.d > this.k.tunnelSide) return false;
    if (!dist) return true;
    const q = passageAt(r.P, pr.s, this._p), n = Math.ceil(pr.d / 0.01), nrm = this._hn;
    for (let j = 1; j < n; j++) {
      const f = j / n;
      if (!(dist(c[0] + (q[0] - c[0]) * f, c[1] + (q[1] - c[1]) * f, c[2] + (q[2] - c[2]) * f, nrm) > 0)) return false;
    }
    return true;
  }

  /* Why a crossing not yet in the bore stops (passages off, or the passage fails her fit); null to go on. */
  _stale() {
    const r = this.way, k = this.k;
    if (r.inside || this.stage === 'haul' || this._sigma(this.loco.c) >= 0) return null;
    if (!k.tunnels) return 'passages off';
    const fit = passageFit(r.P, this.section, k);
    return fit.fits ? null : `too small: ${fit.why}`;
  }

  /* The bore's stages: first reaches go in and she turns onto the line on them, then she hauls on holds ahead of her,
     exhaling and lengthening only as far as the narrowest section asks, until all of her is past the exit mouth. */
  _tickTunnel(dt) {
    const L = this.loco, k = this.k, m = L.mantle, r = this.way;
    let holds = 0, far = 0, reaching = 0, pushing = 0;
    for (let a = 0; a < L.n; a++) {
      const role = L.role[a], mine = L.strokeMode[a] === this;
      this.holding[a] = role === PLANTED || role === STATION ? 1 : 0;
      if (!this.holding[a] && role !== SEEK) this.kind[a] = 0;
      holds += this.holding[a];
      if (role === PLANTED && mine && this.kind[a] === FAR) far++;
      if (mine && (role === SEEK || role === PLANTED) && this.kind[a] === FAR) reaching++;
      if (mine && (role === SEEK || role === PLANTED) && this.kind[a] === NEAR) pushing++;
    }
    this.stats.nearHolds = holds - far; this.stats.farHolds = far;
    const sig = this._sigma(L.c), td = this._tan(Math.max(0, sig), this._td);
    const cos = this._turn(dt, holds, td, k.tunnelTurnK);
    if (this.stage === 'thread') {
      if (reaching < k.threadMax) this._sendTunnel(k.threadMax - reaching, sig);
      const aligned = cos > k.alignCos;
      if (far >= k.farHoldsMin && (aligned || this.stageT > k.alignMax)) {
        this.timedOut = !aligned;
        this.times.alignCos = +cos.toFixed(3);
        this._setStage('haul');
        // Every station hold pushes along the line from behind, as the slot's near holds do.
        for (let a = 0; a < L.n; a++) {
          if (L.role[a] !== STATION) continue;
          L.strokeMode[a] = this; this.kind[a] = NEAR;
          L.max[a] = this.max(L, a);
          L._set(a, PLANTED);
        }
      } else if (this.stageT > k.centerMax + k.alignMax && far < k.farHoldsMin) { L.stop('no holds in the bore'); return; }
      return;
    }
    if (r.tight > 0) this._breath(true);
    if (reaching < k.threadMax) this._sendTunnel(k.threadMax - reaching, sig);
    if (pushing < k.pushMax) this._sendTunnel(k.pushMax - pushing, sig, NEAR);
    for (let a = 0; a < L.n; a++) if (L.role[a] === PLANTED && L.strokeMode[a] === this && this.kind[a] === FAR) this.stats.haulPeak = Math.max(this.stats.haulPeak, m.armForce[a]);
    const n = m.shell.count, len = lengthAlong(m.positions, m.vertexMass, n, td, this._len);
    this.ratio = this.rest.rms > 0 ? len.rms / this.rest.rms : 1;
    const g = r.tight > 0 ? lengthenGain(this.ratio, r.lk) : 0;
    if (g > 0) m.addAccel(lengthenField(m.positions, m.vertexMass, n, td, g, this._acc), { neutral: 'both' });
    const f = boreCounts(m.positions, r.P, m.origin, n, r, this._faces);
    if (f.behind === 0 && f.inside === 0) this._out();
  }

  _tunnelHold() { return { exhale: 1, depth: 2 * this.k.cavityShare * this.way.tight, outflow: 0 }; }

  /* Up to `count` idle arms reach ahead into the bore (or past its exit), each to the wall on its own side of the line,
     the best-placed along the travel first. sig is her crown's distance past the entry mouth. */
  _sendTunnel(count, sig, kind = FAR) {
    const L = this.loco, A = L.arms, r = this.way, k = this.k, dist = A.sdf?.distance;
    if (!(count > 0) || !L.desire || !dist) return 0;
    const td = this._tan(Math.max(0, sig), this._t3);
    for (let a = 0; a < L.n; a++) {
      const rf = L.mantle.rootFrame(a, this._rf);
      this.scores[a] = threadScore(rf.n, td);
      this.free[a] = L.role[a] === IDLE && !A.arms[a].goal && L.freeFor(a, 'squeeze') ? 1 : 0;
    }
    const first = this.stage === 'thread' && kind === FAR;
    let pick;
    if (kind === FAR) pick = pickThreaders(this.scores, this.free, count, k);
    else {
      // The trailing arms push from behind: the worst threaders.
      pick = [];
      for (let a = 0; a < L.n; a++) if (this.free[a]) pick.push(a);
      pick.sort((x, y) => this.scores[x] - this.scores[y] || x - y);
      pick = pick.slice(0, count);
    }
    let sent = 0;
    for (const a of pick) {
      const rf = L.mantle.rootFrame(a, this._rf), t = this._t, nrm = this._hn;
      const sg = kind === NEAR ? sig - k.pushBack - 0.015 * sent : Math.min(r.L + k.exitPast, Math.max(0, sig) + (first ? k.reachIn : k.reachAhead) + 0.015 * sent), s = sOfSigma(r, sg);
      // Across the line toward the side of it her root is on, leaning along its bearing, so the arms spread round the bore.
      const c = passageAt(r.P, s, this._p), side = this._a;
      for (let i = 0; i < 3; i++) side[i] = rf.p[i] - c[i] + rf.n[i] * 0.03;
      if (!boreHold(r.P, s, side, dist, k, t, nrm)) continue;
      const face = this._f3 ??= [0, 0, 0];
      for (let i = 0; i < 3; i++) face[i] = t[i] - nrm[i] * 0.05;
      if (A.claim && !A.claim(a, 'stroke')) continue;
      const arm = A.arms[a], speed = lerp(arm.knobs.reachSpeed, arm.knobs.bendSpeedMax, L.desire.urgency);
      if (!A.reach(a, t, { speed, hold: k.seekMax + 1, face })) { A.unclaim?.(a, 'stroke'); continue; }
      A.arms[a].goal.loco = L;
      L.strokeMode[a] = this;
      this.kind[a] = kind;
      L._set(a, SEEK);
      const why = kind === NEAR ? 'near' : first ? 'thread' : 'far';
      L.grant(a, 'squeeze', why);
      this.stats.sends[why]++;
      sent++;
    }
    return sent;
  }

  /* Send up to `count` idle arms for holds: the best-placed threaders for the far side, the worst for the near face. */
  _send(kind, count, first = false) {
    const L = this.loco, A = L.arms, r = this.way, k = this.k;
    if (!(count > 0) || !L.desire) return 0;
    for (let a = 0; a < L.n; a++) {
      const rf = L.mantle.rootFrame(a, this._rf);
      this.scores[a] = threadScore(rf.n, r.dir);
      this.free[a] = L.role[a] === IDLE && !A.arms[a].goal && L.freeFor(a, 'squeeze') ? 1 : 0;
    }
    let pick;
    if (kind === FAR) pick = pickThreaders(this.scores, this.free, count, k);
    else {
      pick = [];
      for (let a = 0; a < L.n; a++) if (this.free[a]) pick.push(a);
      pick.sort((x, y) => this.scores[x] - this.scores[y] || x - y);
      pick = pick.slice(0, count);
    }
    let sent = 0;
    for (const a of pick) {
      const rf = L.mantle.rootFrame(a, this._rf), t = this._t;
      if (kind === NEAR) nearHoldPoint(r, rf.p, rf.n, k, t);
      else if (first) lipPoint(r, rf.p, k, t);
      else farHoldPoint(r, rf.p, k, t);
      // Suckers turn into what the hold lies on: the near face, the lip's round (toward its center), or the far face.
      const face = this._f3 ??= [0, 0, 0];
      if (kind === FAR && first) {
        face[0] = r.center[0]; face[1] = r.center[1] - r.ap.halfH - r.ap.thick / 2; face[2] = t[2];
      } else {
        const s = kind === NEAR ? 1 : -1;
        for (let i = 0; i < 3; i++) face[i] = t[i] + s * r.dir[i] * 0.05;
      }
      if (A.claim && !A.claim(a, 'stroke')) continue;
      const arm = A.arms[a], speed = lerp(arm.knobs.reachSpeed, arm.knobs.bendSpeedMax, L.desire.urgency);
      // A first reach puts its contact where the chord to the lip ends, so the arm lies along the slot's floor.
      const chord = Math.hypot(t[0] - rf.p[0], t[1] - rf.p[1], t[2] - rf.p[2]);
      const opts = { speed, hold: k.seekMax + 1, face };
      if (kind === FAR && first) opts.contactArc = Math.min(0.5, Math.max(0.1, (chord * k.lipArc) / arm.length));
      if (!A.reach(a, t, opts)) { A.unclaim?.(a, 'stroke'); continue; }
      A.arms[a].goal.loco = L;
      L.strokeMode[a] = this;
      this.kind[a] = kind;
      L._set(a, SEEK);
      L.grant(a, 'squeeze', kind === NEAR ? 'near' : first ? 'thread' : 'far');
      this.stats.sends[kind === NEAR ? 'near' : first ? 'thread' : 'far']++;
      sent++;
    }
    return sent;
  }

  destroy() {
    this._breath(false);
    this.loco.listeners.delete(this._listen);
    this.loco.modes.delete('squeeze');
    this.loco._modeList = [...this.loco.modes.values()];
  }
}

/* Register after the climb: the controller asks `choose`, `travel`, and `route` last-wins, `arrived` first-wins. */
export function installSqueeze(loco, opts) {
  const sq = new Squeeze(loco, opts);
  loco.registerMode('squeeze', sq);
  register('squeeze', { label: 'Squeeze slot', key: '4', run: squeeze, world: 'divider' });
  register('tunnel', { label: 'Through the tunnel', run: tunnel, world: 'rockwork' });
  return sq;
}

const r3 = (v) => +(+v).toFixed(3);

/* Through the slot to a floor point beyond the panel: she passes with every shell vertex past the far face within the limit.
   Form sits beside that, since a rough passage is still one: arms first, turned first, exhaled, lengthened, then strain and volume after 2 s still. */
export async function squeeze(ctx, { to = [0.45, 0, 0], urgency = 0.6, limit = SQUEEZE_KNOBS.squeezeLimit, settle = 2, after = 3 } = {}) {
  const { loco, mantle: m } = ctx, sq = loco.modes.get('squeeze');
  if (!loco.canPlant) return { passed: false, failed: 'no plant support in the arms yet' };
  if (!sq) return { passed: false, failed: 'no squeeze mode registered' };
  if (!loco.modes.has('pull')) return { passed: false, failed: 'no pull mode registered' };
  const n = m.shell.count, sh = m.shell, k = sq.k;
  // Her mantle's far end: the rest shell's vertex farthest along her head-to-mantle line.
  const wHead = Float32Array.from(m.vertexMass, (v, i) => v * sh.regions[i * 3 + 1]), wMantle = Float32Array.from(m.vertexMass, (v, i) => v * sh.regions[i * 3]);
  const ax0 = weightedAxis(sh.positions, wHead, wMantle, n);
  let tip = 0, best = -Infinity;
  for (let i = 0; i < n; i++) { const s = sh.positions[i * 3] * ax0[0] + sh.positions[i * 3 + 1] * ax0[1] + sh.positions[i * 3 + 2] * ax0[2]; if (s > best) { best = s; tip = i; } }
  const w = {
    t: 0, way: null, firstIn: null, lastOut: null, farAtFirstIn: null, alignAtFirstIn: null, crownCross: null, tipCross: null,
    notExhaled: 0, insideTicks: 0, preLead: -Infinity, lengthMax: 0, volMinInside: Infinity, volMaxInside: 0, track: [], acc: 0, faces: { behind: 0, past: 0, inside: 0, lead: 0 },
  };
  const ax = [0, 0, 0], tp = [0, 0, 0], len = { extent: 0, rms: 0 };
  const watch = (dt) => {
    w.t += dt;
    // The mode drops its route as it ends, and she can still be on her way out of the slot then.
    if (sq.way) w.way = sq.way;
    const r = w.way, live = sq.stage !== 'off';
    if (!r || sq.stage === 'approach') return;
    const f = faceCounts(m.positions, m.origin, n, r, w.faces);
    // How far she bulged past the near face before the haul: a crown cupped into the gap, or a real entry.
    if (live && sq.stage !== 'haul' && sq.stage !== 'out') w.preLead = Math.max(w.preLead, f.lead);
    if (w.firstIn !== null && w.lastOut === null && f.behind === 0 && f.inside === 0) w.lastOut = r3(loco.time - sq.times.start);
    const crossing = f.behind < n && w.lastOut === null;
    if (crossing && w.firstIn === null) {
      w.firstIn = r3(loco.time - sq.times.start);
      w.farAtFirstIn = sq.stats.farHolds;
      m.mantleAxis(ax);
      w.alignAtFirstIn = r3(-(ax[0] * r.dir[0] + ax[1] * r.dir[1] + ax[2] * r.dir[2]));
    }
    if (crossing && live) {
      w.insideTicks++;
      const hold = m.breathHold;
      if (!hold || hold.exhale !== 1) w.notExhaled++;
      lengthAlong(m.positions, m.vertexMass, n, r.dir, len);
      w.lengthMax = Math.max(w.lengthMax, len.extent / sq.rest.extent);
      const v = m.health().volume;
      w.volMinInside = Math.min(w.volMinInside, v); w.volMaxInside = Math.max(w.volMaxInside, v);
    }
    if (w.crownCross === null && dirSide(loco.c, r) > 0) w.crownCross = r3(loco.time - sq.times.start);
    for (let i = 0; i < 3; i++) tp[i] = m.positions[tip * 3 + i] + m.origin[i];
    if (w.tipCross === null && dirSide(tp, r) > 0) w.tipCross = r3(loco.time - sq.times.start);
    w.acc += dt;
    if (w.acc >= 0.5) {
      w.acc = 0;
      w.track.push({ t: r3(loco.time - sq.times.start), stage: sq.stage, c: loco.c.map(r3), near: sq.stats.nearHolds, far: sq.stats.farHolds, behind: f.behind, past: f.past, ratio: r3(sq.ratio), vol: r3(m.health().volume) });
    }
  };
  loco.listeners.add(watch);
  let res;
  try {
    try {
      let over = false;
      const timer = until(loco, () => over || w.lastOut !== null, limit).then(() => ({ arrived: false, failed: w.lastOut !== null ? null : 'timeout' }));
      res = await Promise.race([sq.go(to, { urgency }), timer]);
      over = true;
      // Through, she carries on toward the target a little while, then everything stops for the still check.
      if (w.lastOut !== null && loco.desire) await until(loco, () => !loco.desire, after);
    } finally { loco.stop('scenario over'); }
    await until(loco, () => false, settle);
  } finally { loco.listeners.delete(watch); }
  const end = m.health(), r = sq.way ?? sq.lastWay;
  const out = {
    to, urgency, gapH: r ? r3(2 * r.ap.halfH) : null, fits: r ? r.fits : null, failed: res?.failed ?? null, arrived: !!res?.arrived,
    times: Object.fromEntries(Object.entries(sq.times).map(([key, v]) => [key, key === 'alignCos' ? v : r3(v - (sq.times.start ?? 0))])),
    centerTimedOut: sq.timedOut, firstIn: w.firstIn, lastOut: w.lastOut, farAtFirstIn: w.farAtFirstIn, alignAtFirstIn: w.alignAtFirstIn,
    preLead: r3(Number.isFinite(w.preLead) ? w.preLead : 0), crownCross: w.crownCross, tipCross: w.tipCross, notExhaled: w.notExhaled, insideTicks: w.insideTicks, lengthMax: r3(w.lengthMax),
    volMinInside: r3(Number.isFinite(w.volMinInside) ? w.volMinInside : 0), volMaxInside: r3(w.volMaxInside),
    endStrain: r3(end.strainMax), endVolume: r3(end.volume), haulPeak: r3(sq.stats.haulPeak), sends: { ...sq.stats.sends },
    releases: { ...sq.stats.releases }, refused: sq.stats.refused, track: w.track,
  };
  out.turnedFirst = w.alignAtFirstIn !== null && w.alignAtFirstIn > Math.cos(0.4) && w.crownCross !== null && (w.tipCross === null || w.crownCross <= w.tipCross);
  out.armsFirst = w.farAtFirstIn !== null && w.farAtFirstIn >= k.farHoldsMin;
  const form = [];
  if (!out.armsFirst) form.push('not arms first');
  if (!out.turnedFirst) form.push('not turned first');
  if (w.notExhaled > 0) form.push('not exhaled');
  if (!(w.lengthMax >= 1.15)) form.push(`lengthened ${r3(w.lengthMax)}×`);
  if (!(end.strainMax < 0.5)) form.push(`strain ${r3(end.strainMax)}`);
  if (!(end.volume > 0.85)) form.push(`volume ${r3(end.volume)}`);
  out.passed = w.lastOut !== null && w.lastOut <= limit;
  out.formPassed = form.length === 0;
  out.note = !out.passed ? out.failed ?? (w.firstIn === null ? 'never in' : 'not through') : form.length ? `form: ${form.join(', ')}` : 'good form';
  return out;
}

function dirSide(p, r) {
  const c = r.center, d = r.dir;
  return (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1] + (p[2] - c[2]) * d[2];
}
