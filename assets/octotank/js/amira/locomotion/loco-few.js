import { ROLE, releaseReason, strokeRate } from './locomotion-core.js';
import { PUSH } from './locomotion.js';
import { FEW_KNOBS, overlapHolds } from './loco-jet-core.js';
import { register, until } from '../../diag/scenarios.js';

/* Walking short of arms. Two free arms alternate push strokes, each holding its plant until the other has planted, and an arm busy at attention may
   dab down for balance; one arm hops (a hard hurried push, a glide, another plant). With none she sets down the least interesting thing she holds, or jets if hurried enough. */

const { planted: PLANTED, station: STATION, idle: IDLE } = ROLE;
const FREE_OWNERS = new Set(['idle', 'stroke']);

export class Few {
  constructor(loco, { carry = null } = {}) {
    this.name = 'few';
    this.loco = loco;
    this.carry = carry;
    for (const key in FEW_KNOBS) loco.knobs[key] ??= FEW_KNOBS[key];
    this.k = loco.knobs;
    const n = loco.n;
    this.free = [];
    this.active = false;
    this.bound = new Map();     // arm → the tier it was bound at
    this.held = new Uint8Array(n);
    this.dab = null;            // { arm, phase: 'seek' | 'down', t }
    this.stats = { hops: 0, vetoes: 0, dabs: 0, setDown: 0, jets: 0 };
    this._at = -1;
    this._up = [0, 1, 0]; this._p = [0, 0, 0]; this._f = [0, 0, 0]; this._n = [0, 0, 0];
    this._listen = (dt) => this._tick(dt);
    this._listen.reset = () => this.reset();
    loco.listeners.add(this._listen);
  }

  /* Free arms this tick: owned by nobody stronger than a stroke, with no one else's goal and no grip. */
  _refresh() {
    const L = this.loco, A = L.arms;
    if (this._at === L.time) return;
    this._at = L.time;
    this.free.length = 0;
    for (let a = 0; a < L.n; a++) {
      const g = A.arms[a].goal;
      if (this.bound.has(a) || this.dab?.arm === a || !FREE_OWNERS.has(A.owner?.[a] ?? 'idle') || (g && g.loco !== L) || A.episodes?.[a]?.h) continue;
      this.free.push(a);
    }
    this.active = !!L.desire && this.free.length >= 1 && this.free.length <= 2;
  }

  // The controller's hooks: a free arm walking short-handed strokes as 'few'.
  choose(loco, a) { this._refresh(); return this.active && this.free.includes(a) ? this : undefined; }

  usefulness(loco, a, n) { return Math.max(PUSH.usefulness(loco, a, n), loco.knobs.helpMin) * this.k.fewHaste; }

  seek(loco, a, root, n, out) { return PUSH.seek(loco, a, root, n, out); }

  accept(loco, a, o) { return PUSH.accept(loco, a, o); }

  max(loco, a) { return PUSH.max(loco, a); }

  /* A lone arm pushes at the hurried rate whatever the urgency; one waiting on its partner holds still at full stretch. */
  rate(loco, a, u) {
    this._refresh();
    if (this.held[a] || loco.ell[a] >= loco.max[a]) return 0;
    if (this.free.length === 1) {
      const v = this._f, s = loco.knobs.speedHurried;
      v[0] = loco.dFlat[0] * s; v[1] = 0; v[2] = loco.dFlat[2] * s;
      return strokeRate(v, u);
    }
    return strokeRate(loco.vWant, u);
  }

  release(loco, a) {
    this._refresh();
    const why = releaseReason(loco._why);
    if (this.free.length === 2) {
      const b = this.free[0] === a ? this.free[1] : this.free[0];
      const partnerT = loco.role[b] === PLANTED ? loco.roleT[b] : 0;
      if (overlapHolds(why, partnerT, this.k)) { if (!this.held[a]) this.stats.vetoes++; this.held[a] = 1; return null; }
    }
    this.held[a] = 0;
    if (why && why !== 'lost' && this.free.length === 1 && loco.roleT[a] >= this.k.hopMinT) this.stats.hops++;
    return why;
  }

  /* A dab holds its touch as a real spring for dabTime; the controller's passive station rule takes it after. */
  holdStation(loco, a) { return this.dab?.arm === a && this.dab.phase === 'down' && this.dab.t < this.k.dabTime; }

  /* A lone arm hops at the hurried cap whatever the urgency, within what its hold bears. */
  cap(loco, a, cap) {
    if (this.free.length !== 1 || loco.strokeMode[a] !== this || loco.role[a] !== PLANTED) return undefined;
    return Math.min(loco.knobs.capHurried, loco.knobs.anchorSafety * Math.max(0, loco.holdF[a]));
  }

  finish() { this.held.fill(0); }

  /* After every tick: the dab, and the case of no free arms at all. */
  _tick(dt) {
    const L = this.loco, st = L.state.mode;
    if (!(dt > 0) || st === 'off' || st === 'held' || st.startsWith('rigid')) return;
    this._at = -1;
    this._refresh();
    this._dabTick(dt);
    if (L.desire && this.free.length === 0) this._noArms();
  }

  _dabTick(dt) {
    const L = this.loco, A = L.arms, k = this.k, D = this.dab;
    if (D) {
      D.t += dt;
      if (D.phase === 'seek') {
        const list = A.anchorList?.[D.arm], cnt = A.anchorCount?.[D.arm] ?? 0;
        let o = null;
        for (let i = 0; i < cnt; i++) if (list[i].n[1] > k.floorCos) { o = list[i]; break; }
        // The reach lets go first; the controller sees the arm idle on its next tick, and only then can it plant.
        if (o && A.arms[D.arm].goal) A.arms[D.arm].idle();
        else if (o && L.role[D.arm] === IDLE) {
          if (L.plantStation(D.arm, o)) { D.phase = 'down'; D.t = 0; this.stats.dabs++; } else this._endDab();
        } else if (D.t > k.dabSeek || (o && L.role[D.arm] !== ROLE.busy)) { A.arms[D.arm].idle(); this._endDab(); }
      } else if (L.role[D.arm] !== STATION) this._endDab();
      return;
    }
    if (!this.active || this.free.length !== 2) return;
    const up = m3up(L.mantle, this._up);
    if (Math.acos(Math.max(-1, Math.min(1, up[1]))) <= k.dabTilt) return;
    // The arm at attention whose root sits lowest, on the side she is tipping toward.
    let best = -1, low = Infinity;
    for (let a = 0; a < L.n; a++) {
      if (A.owner?.[a] !== 'attend' || this.bound.get(a) === 'held' || A.episodes?.[a]?.h) continue;
      const y = L.mantle.rootWorld(a, this._p)[1];
      if (y < low) { low = y; best = a; }
    }
    if (best < 0) return;
    A.unclaim(best, 'attend');
    if (!A.claim(best, 'stroke')) return;
    const root = L.mantle.rootWorld(best, this._p), foot = [root[0], root[1], root[2]], sdf = A.sdf;
    if (sdf) {
      sdf.unfocus?.();
      const nrm = this._n;
      for (let it = 0; it < 3; it++) { const s = sdf.distance(foot[0], foot[1], foot[2], nrm); if (!Number.isFinite(s)) break; for (let i = 0; i < 3; i++) foot[i] -= nrm[i] * s; }
    }
    const arm = A.arms[best];
    if (!A.reach(best, foot, { contactArc: k.footArc / arm.length, speed: arm.knobs.bendSpeedMax, hold: k.dabSeek + 0.5 })) { A.unclaim(best, 'stroke'); return; }
    this.dab = { arm: best, phase: 'seek', t: 0, tier: 'attend' };
  }

  _endDab() {
    const D = this.dab, A = this.loco.arms;
    this.dab = null;
    if (!D) return;
    A.unclaim(D.arm, 'stroke');
    // A bound arm goes back under her; without a goal its claim would settle to idle and it would walk.
    const tier = this.bound.get(D.arm);
    if (tier && this.loco.role[D.arm] !== STATION) { A.tuck(D.arm); A.claim(D.arm, tier); }
  }

  /* No free arm: put down the least interesting thing held, or jet if hurried and able. */
  _noArms() {
    const L = this.loco, A = L.arms, d = L.desire, k = this.k;
    if (d.urgency >= (k.jetUrgency ?? Infinity) && typeof L.jet === 'function' && L.jet({ to: d.point, urgency: d.urgency, reason: 'no arms' }) === true) { this.stats.jets++; return; }
    let best = -1, low = Infinity;
    const wt = A.suckerKnobs?.tasteWeight ?? {};
    for (let a = 0; a < L.n; a++) {
      const ep = A.episodes?.[a];
      if (!ep?.h) continue;
      const s = wt[ep.taste] ?? wt.toy ?? 1;
      if (s < low) { low = s; best = a; }
    }
    if (best < 0 || typeof this.carry?.letGo !== 'function') { L.state.note = 'no free arms'; return; }
    this.carry.letGo(best);
    this.stats.setDown++;
  }

  /* Hold arms out of the gait, curled under her, at `tier` ('held', or 'attend' for an arm that may dab). */
  bind(list, tier = 'held') {
    const A = this.loco.arms;
    for (const i of list) {
      if (!(i >= 0 && i < this.loco.n) || !A.claim(i, tier)) continue;
      this.bound.set(i, tier);
      const arm = A.arms[i];
      if (typeof A.tuck === 'function') A.tuck(i);
      else arm.idle();
      arm.resting = true;
    }
    this._at = -1;
    return [...this.bound.keys()];
  }

  unbind(list = [...this.bound.keys()]) {
    const A = this.loco.arms;
    for (const i of list) {
      const tier = this.bound.get(i);
      if (!tier) continue;
      this.bound.delete(i);
      A.unclaim(i, tier);
      const arm = A.arms[i];
      if (arm.goal?.kind === 'tuck') arm.idle();
      arm.resting = A.resting;
    }
    this._at = -1;
  }

  /* A scenario's setup or teardown: every bound arm back, any dab over. */
  reset() {
    if (this.dab) { const a = this.dab.arm; if (this.loco.arms.arms[a].goal && this.dab.phase === 'seek') this.loco.arms.arms[a].idle(); this._endDab(); }
    this.held.fill(0);
    this.unbind();
  }

  destroy() { this.unbind(); this.loco.listeners.delete(this._listen); }
}

function m3up(mantle, out) { return mantle.up(out); }

export function installFew(loco, opts = {}) {
  const few = new Few(loco, opts);
  loco.registerMode('few', few);
  loco.fewMode = few;
  loco.bind = (list, tier) => few.bind(list, tier);
  loco.unbind = (list) => few.unbind(list);
  register('few', { label: 'Few arms', run: fewScenario });
  return few;
}

const r3 = (v) => +(+v).toFixed(3);

/* A spot `dist` m along the way the free arms push (back through her body from their bases), nudged around until it
   lies clear of the furniture. */
function aheadOf(loco, arms, dist) {
  const m = loco.mantle, c = m.ring().c, rf = { p: [0, 0, 0], n: [0, 0, 0], t: [0, 0, 0] };
  let dx = 0, dz = 0;
  for (const a of arms) { m.rootFrame(a, rf); dx -= rf.n[0]; dz -= rf.n[2]; }
  const base = Math.atan2(dz, dx), sdf = loco.arms.sdf, nrm = [0, 0, 0], ground = loco.arms.phys?.terrain?.field;
  sdf?.unfocus?.();
  for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
    const p = [c[0] + dist * Math.cos(base + off), 0, c[2] + dist * Math.sin(base + off)];
    // Sampled 12 cm over the ground here, sand included, so only walls, rocks, and the panel count against a spot.
    const y = (ground?.sample(p[0], p[2]) ?? 0) + 0.12;
    if (!sdf || sdf.distance(p[0], y, p[2], nrm) > 0.1) return p;
  }
  return null;
}

/* Few arms: six bound, a 0.3 m walk on arms 3 and 4 alone within 60 s; variant 'hop' binds seven for a 0.2 m hop
   with at least three hops; variant 'dab' leaves arm 2 at attention to dab (report only). */
export async function fewScenario(ctx, { variant = null, urgency = 0.3, limit = 60 } = {}) {
  const { loco } = ctx, few = loco.fewMode;
  if (!few) return { passed: false, failed: 'no few-arm mode installed' };
  if (!loco.canPlant) return { passed: false, failed: 'no plant support in the arms yet' };
  const hop = variant === 'hop', walkers = hop ? [4] : [3, 4];
  const bindHeld = hop ? [0, 1, 2, 3, 5, 6, 7] : variant === 'dab' ? [0, 1, 5, 6, 7] : [0, 1, 2, 5, 6, 7];
  const s0 = { ...few.stats };
  few.bind(bindHeld, 'held');
  if (variant === 'dab') few.bind([2], 'attend');
  const w = { ticks: 0, foreign: 0, planted: new Array(loco.n).fill(0), bare: 0, started: false };
  const watch = () => {
    w.ticks++;
    let down = 0;
    for (let a = 0; a < loco.n; a++) {
      const r = loco.state.roles[a];
      if ((r === 'seek' || r === 'planted') && !walkers.includes(a) && few.dab?.arm !== a) w.foreign++;
      if (r === 'planted') { w.planted[a]++; down++; w.started = true; }
    }
    if (w.started && !down) w.bare++;
  };
  loco.listeners.add(watch);
  try {
    await until(loco, () => false, 0.5);
    const to = aheadOf(loco, walkers, hop ? 0.2 : 0.3);
    if (!to) return { passed: false, failed: 'no clear spot ahead' };
    const d = loco.want(to, { urgency, source: 'scenario' });
    if (!d) return { passed: false, failed: 'refused' };
    let over = false;
    const res = await Promise.race([d.done, until(loco, () => over, limit).then(() => ({ arrived: false, failed: 'timeout' }))]);
    over = true;
    if (loco.desire === d) loco.stop('timeout');
    const stats = Object.fromEntries(Object.entries(few.stats).map(([key, v]) => [key, v - s0[key]]));
    const out = {
      variant, to: to.map(r3), arrived: !!res.arrived, failed: res.failed ?? null, t: r3(res.t ?? limit), foreignStrokeTicks: w.foreign,
      duty: walkers.map((a) => r3(w.planted[a] / Math.max(1, w.ticks))), bareShare: r3(w.bare / Math.max(1, w.ticks)), ...stats,
    };
    if (variant === 'dab') { out.passed = null; return out; }
    out.passed = out.arrived && out.t <= limit && out.foreignStrokeTicks === 0 && (!hop || out.hops >= 3);
    return out;
  } finally {
    loco.listeners.delete(watch);
    few.unbind();
  }
}
