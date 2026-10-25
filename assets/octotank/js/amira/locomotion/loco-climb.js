import { TANK } from '../../config.js';
import { ROLE, lerp } from './locomotion-core.js';
import {
  CLIMB_KNOBS, surfaceMode, ellMin, pullRate, holdAhead, pullRelease, releaseSafe, supportNormal, wallHolds, arrivedWall,
  pullUsefulness, reachPoint, wallAt, wallReachPoint, domeShare, stationSpare,
} from './loco-climb-core.js';
import { until, register } from '../../diag/scenarios.js';

/* The climb: on walls, under the lid, and wherever her travel is steep, an arm reaches ahead, seals, and shortens its spring's rest
   length to haul her to the hold; holds let go hand over hand, never below the safety rule, and stay as stations she hangs from on arrival. */

const { idle: IDLE, seek: SEEK, planted: PLANTED, station: STATION } = ROLE;
const VOLUNTARY = new Set(['short', 'behind', 'long', 'full']);
const UP = [0, 1, 0];

export class Pull {
  constructor(loco) {
    const n = loco.n;
    this.name = 'pull';
    this.loco = loco;
    for (const key in CLIMB_KNOBS) loco.knobs[key] ??= CLIMB_KNOBS[key];
    this.k = loco.knobs;
    this.seekP = new Float64Array(n * 3);
    this.hangP = new Float64Array(n * 3);
    this.hangSet = new Uint8Array(n);
    this.made = new Uint8Array(n);
    this.madeT = new Float64Array(n);           // the arm's role time when last seen as Pull's station: a restart means a new station
    this.wallReachAt = new Float64Array(n);
    this.freedT = new Float64Array(n).fill(-Infinity);   // when a stalled hang last let this arm's station go to pull
    this._pullerAt = -1; this._pullerA = -1;
    this._pinned = false;
    this.holding = new Uint8Array(n);
    this.support = [0, 1, 0];
    this.up = [0, 1, 0];
    this.steep = false;       // she hangs: held, off the floor, on a support steeper than a floor
    this.standing = true;
    this.walls = 0;
    this.pullOn = false;       // the travel is steep, or a stall asked the front arms to pull
    this.stallUntil = -Infinity;
    this.dome = 1;
    this._domeBase = loco.mantle.knobs.righting;
    this._domeSet = this._domeBase;
    this._at = -1;
    this._rf = { p: [0, 0, 0], n: [0, 0, 0], t: [0, 0, 0] };
    this._n = [0, 1, 0]; this._nb = [0, 1, 0]; this._p = [0, 0, 0]; this._a = [0, 0, 0];
    this._wallP = [0, 0, 0]; this._wallN = [0, 0, 1]; this._appr = [0, 0, 0]; this._apprOn = false;
    this.stats = { wallT: 0, wallPullT: 0, refused: 0, unsafeLost: 0, reanchored: 0, toppedUp: 0, wallReaches: 0, releases: { short: 0, behind: 0, long: 0, full: 0, lost: 0 } };
    this._listen = (dt) => this._tick(dt);
    // A finished climb scenario leaves her hanging on the glass; the next scenario's opening reset lets her go.
    this._listen.reset = (why) => { if (why !== 'scenario over') this.reset(); };
    loco.listeners.add(this._listen);
  }

  /* A scenario's reset, after the stop's finish has hung her: the stations this mode made let go, wall reaches lapse, and
     the hang, the stall's pull, and the dome start fresh, so nothing pins her toward the old setup. */
  reset() {
    const L = this.loco, A = L.arms;
    for (let a = 0; a < L.n; a++) {
      if (this.made[a] && L.role[a] === STATION) L._release(a, 'reset');
      if (this.wallReachAt[a] > 0 && L.role[a] === IDLE) { if (A.arms[a].goal?.loco === L) A.arms[a].idle(); A.unclaim?.(a, 'stroke'); }
    }
    this.made.fill(0); this.hangSet.fill(0); this.wallReachAt.fill(0); this.freedT.fill(-Infinity);
    this._pinned = false; this.stallUntil = -Infinity; this._at = -1; this._pullerAt = -1; this.dome = 1;
    L.mantle.knobs.righting = this._domeSet = this._domeBase;
  }

  /* Holds, support, and whether pulling is open, once per tick (the controller's hooks share them). */
  _refresh() {
    const L = this.loco, k = this.k;
    if (this._at === L.time) return;
    this._at = L.time;
    for (let a = 0; a < L.n; a++) this.holding[a] = L.role[a] === PLANTED || L.role[a] === STATION ? 1 : 0;
    L.mantle.up(this.up);
    // With nothing held, the support is the surface nearest her crown.
    const nrm = this._n, dist = L.arms.sdf?.distance, s = dist ? dist(L.c[0], L.c[1], L.c[2], nrm) : NaN;
    if (Number.isFinite(s)) supportNormal(L.anchorN, this.holding, nrm, this.support);
    else supportNormal(L.anchorN, this.holding, this.up, this.support);
    // Something solid within standH under her crown means she stands, whatever her arms hold: a rock face beside her
    // isn't a climb. Probed straight down, since the nearest surface may be that rock face.
    const below = dist ? dist(L.c[0], L.c[1] - k.standH, L.c[2], this._nb) : NaN;
    this.standing = Number.isFinite(below) && below <= 0;
    this.walls = wallHolds(L.anchorN, this.holding, k);
    // Holds on opposed faces (a chimney) average to a normal that can read as a floor, so enough wall holds alone count.
    this.steep = !this.standing && this.holding.some(Boolean) && (!(this.support[1] > k.floorCos) || this.walls >= k.minWallHolds);
    const d = L.desire;
    // Standing, only the travel's own slope opens a pull: rock beside her mustn't turn a floor crawl into hauling.
    this.pullOn = !!d && (this.steep || L.time < this.stallUntil || surfaceMode(this.standing ? UP : this.support, L.d3, k) === 'pull');
  }

  _speed() { const d = this.loco.desire, k = this.k; return d ? lerp(k.speedCalm, k.speedHurried, d.urgency) : 0; }

  /* Which stroke an idle arm starts: on a wall only pulls; on a steep travel or a stall, the arm takes whichever of the
     push and the pull it helps more, so back arms still push off the floor while front ones reach for the glass. */
  choose(loco, a, n, mode) {
    this._refresh();
    if (!this.pullOn) return mode;
    if (this.steep) return this;
    return this.usefulness(loco, a, n) > mode.usefulness(loco, a, n) ? this : mode;
  }

  usefulness(loco, a) {
    this._refresh();
    if (!this.pullOn) return 0;
    const rf = loco.mantle.rootFrame(a, this._rf);
    return pullUsefulness(rf.n, this.up, loco.d3);
  }

  /* A place up a wall is approached at her standoff off the wall it sits on, so once she is there the travel runs in its plane. */
  route(loco, d, T) {
    this._apprOn = false;
    const dist = loco.arms.sdf?.distance;
    if (d.kind !== 'place' || !(d.point[1] > 0.05) || !dist || !wallAt(d.point, dist, this._wallP, this._wallN, this.k)) return;
    for (let i = 0; i < 3; i++) T[i] = this._appr[i] = this._wallP[i] + this._wallN[i] * this.k.wallStandoff;
    this._apprOn = true;
  }

  /* A point reachAhead from her crown on the surface there: up the wall along its tangent while the travel is this mode's own
     approach and the wall is in reach, else along the 3D travel. Middle-of-arm contact, suckers turned in. */
  seek(loco, a, root, n, out) {
    const dist = loco.arms.sdf?.distance, nrm = this._n, T = loco.travel, w = this._appr;
    const up = this._apprOn && T[0] === w[0] && T[1] === w[1] && T[2] === w[2];
    if (!dist || !((up && wallReachPoint(loco.c, T, this._wallP, this._wallN, dist, out, nrm, this.k)) || reachPoint(loco.c, loco.d3, dist, out, nrm, this.k))) return null;
    this.seekP[a * 3] = out[0]; this.seekP[a * 3 + 1] = out[1]; this.seekP[a * 3 + 2] = out[2];
    return { face: [out[0] - nrm[0] * 0.05, out[1] - nrm[1] * 0.05, out[2] - nrm[2] * 0.05] };
  }

  /* A sealed anchor near the reach point, far enough out that the pull has somewhere to go. */
  accept(loco, a, o) {
    const s = this.seekP, p = loco.mantle.rootWorld(a, this._p);
    if (Math.hypot(o.p[0] - s[a * 3], o.p[1] - s[a * 3 + 1], o.p[2] - s[a * 3 + 2]) > this.k.holdTol) return false;
    return Math.hypot(o.p[0] - p[0], o.p[1] - p[1], o.p[2] - p[2]) > ellMin(loco.arms.arms[a].len0, o.seg, this.k) + this.k.leadMax;
  }

  rate(loco, a, u) { return pullRate(this._speed(), loco.d3, u); }

  /* A hold below her on a wall lengthens like a push; this is how far. */
  max(loco, a) {
    const arm = loco.arms.arms[a];
    let s = 0;
    for (let j = 0; j <= loco.anchorSeg[a] && j < arm.len0.length; j++) s += arm.len0[j] * arm.lamMax[j];
    return loco.knobs.extend * s;
  }

  /* Why a planted pull ends, after its rest length has moved this tick. The spring never winds up past leadMax, a pull
     never shortens past ellMin, and on a wall a voluntary release waits until the other holds can bear her. */
  release(loco, a, chord) {
    this._refresh();
    const k = this.k, arm = loco.arms.arms[a], min = ellMin(arm.len0, loco.anchorSeg[a], k);
    loco.ell[a] = Math.min(Math.max(loco.ell[a], min, chord - k.leadMax), loco.max[a]);
    const A = this._a, p = loco.mantle.rootWorld(a, this._p);
    for (let i = 0; i < 3; i++) A[i] = loco.anchorP[a * 3 + i];
    const why = pullRelease({ ell: loco.ell[a], min: min + 1e-9, max: loco.max[a] - 1e-9, ahead: holdAhead(A, p, loco.d3), lostT: loco.lostT[a], grace: k.anchorGrace, t: loco.roleT[a], tMax: k.strokeMax }, k);
    if (!why) return null;
    const safe = releaseSafe(loco.holdF, this.holding, a, this.steep, k);
    if (VOLUNTARY.has(why) && !safe) { this.stats.refused++; return null; }
    // A hold whose suckers all let go moves to another sealed patch of the same arm on the wall, if it has one.
    if (!safe && this._reanchor(loco, a)) { loco._set(a, STATION); this.made[a] = 1; this.madeT[a] = loco.roleT[a]; this.stats.reanchored++; return null; }
    if (!safe) this.stats.unsafeLost++;
    this.stats.releases[why]++;
    // Later arms this tick judge their own release without this hold.
    if (this.holding[a] && !(loco.anchorN[a * 3 + 1] > k.floorCos)) this.walls--;
    this.holding[a] = 0;
    return why;
  }

  /* The travel's speed along the 3D line for the stall clock while she climbs; flat otherwise. */
  travel(loco, sp) {
    this._refresh();
    if (!this.pullOn) return undefined;
    const v = loco.v, d = loco.d3;
    return v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
  }

  /* A place up a wall arrives in the wall's own plane, read off the surface nearest the spot. */
  arrived(loco, d, T) {
    if (d.kind !== 'place' || !(d.point[1] > 0.05)) return undefined;
    const dist = loco.arms.sdf?.distance, n = this._n;
    if (!dist || !Number.isFinite(dist(T[0], T[1], T[2], n))) return undefined;
    // Up there she arrives only once she has the holds to hang from.
    return arrivedWall(loco.c, T, n, d.arriveR, this.k.wallStandMax) && (this.walls >= this.k.minWallHolds || !this.steep);
  }

  /* However a desire ends, planted arms on a wall stay as stations so she hangs where she got to. */
  finish(loco) {
    this._refresh();
    for (let a = 0; a < loco.n; a++) {
      if (loco.role[a] !== PLANTED) continue;
      if (!this.steep && loco.anchorN[a * 3 + 1] > this.k.floorCos) continue;
      loco._set(a, STATION);
      this.made[a] = 1; this.madeT[a] = loco.roleT[a];
    }
    this._settle();
  }

  /* Every station's rest length to its chord now, so a hang's holds agree on where she is instead of each pulling
     toward wherever she was when it planted; pinned, each also keeps its root where it is now (see _tick). A hold added
     to a pinned hang settles alone, so the others keep where they were and she never ratchets down. */
  _settle(only = -1) {
    const L = this.loco, p = this._p;
    for (let a = 0; a < L.n; a++) {
      if (L.role[a] !== STATION || (only >= 0 && a !== only)) continue;
      L.ell[a] = L.chord[a];
      L.mantle.rootWorld(a, p);
      this.hangP[a * 3] = p[0]; this.hangP[a * 3 + 1] = p[1]; this.hangP[a * 3 + 2] = p[2];
      this.hangSet[a] = 1;
    }
  }

  /* While she hangs a station outlasts the linger and the station clock. With somewhere to go and the other holds bearing her, a spare lets
     go once a pull has taken its place; stalled with nothing pulling or reaching, the station best placed to pull does, hand over hand. */
  holdStation(loco, a) {
    this._refresh();
    if (!this.steep) return false;
    // A squeeze threading a slot sets its stations' lines and lets them go by its own rule, so the hang's rules wait outside it.
    const k = this.k, sq = loco.modes.get('squeeze'), own = !(sq?.active && loco.desire === sq.desire);
    let pulls = 0, reaching = false;
    for (let b = 0; b < loco.n; b++) {
      if (loco.role[b] === PLANTED && this.holding[b] && !(loco.anchorN[b * 3 + 1] > k.floorCos)) pulls++;
      if (loco.role[b] === SEEK && loco.strokeMode[b] === this) reaching = true;
    }
    // While a pull hauls her, a held station's line gives way to its chord rather than holding her back; _settle pins it after.
    if (own && pulls > 0 && loco.desire) loco.ell[a] = loco.chord[a];
    if (!loco.desire || loco.roleT[a] <= 0.3 || !releaseSafe(loco.holdF, this.holding, a, true, k)) return true;
    const free = own && !pulls && !reaching && loco.phase >= 1 && this.walls > k.minWallHolds && a === this._puller(loco);
    if (own && !free && !stationSpare(this.walls, pulls, k)) return true;
    if (free) this.freedT[a] = loco.time;
    this.holding[a] = 0;
    if (!(loco.anchorN[a * 3 + 1] > k.floorCos)) this.walls--;
    return false;
  }

  /* The wall station past the controller's 0.3 s whose root bears most along the travel, once a tick; -1 if none helps. */
  _puller(loco) {
    if (this._pullerAt === loco.time) return this._pullerA;
    let best = -1, use = 0;
    for (let b = 0; b < loco.n; b++) {
      if (loco.role[b] !== STATION || loco.roleT[b] <= 0.3 || loco.anchorN[b * 3 + 1] > this.k.floorCos) continue;
      const u = pullUsefulness(loco.mantle.rootFrame(b, this._rf).n, this.up, loco.d3);
      if (u > use) { use = u; best = b; }
    }
    this._pullerAt = loco.time;
    return (this._pullerA = best);
  }

  /* A sealed patch of arm a on a wall, off its current anchor, or null. */
  _wallAnchor(a, skip = -9) {
    const A = this.loco.arms, list = A.anchorList?.[a], cnt = A.anchorCount?.[a] ?? 0;
    for (let i = 0; i < cnt; i++) if (!(list[i].n[1] > this.k.floorCos) && Math.abs(list[i].seg - skip) > 1) return list[i];
    return null;
  }

  _reanchor(loco, a) {
    const o = this._wallAnchor(a, loco.anchorSeg[a]);
    if (!o || !loco._plant(a, o)) return false;
    loco.ell[a] = loco.chord[a];
    return true;
  }

  /* Hanging, idle arms already sealed on the wall become holds until she has minWallHolds and a spare; with somewhere
     to go, holdStation lets the spare go once a pull has taken its place. */
  _topUp() {
    const L = this.loco, k = this.k;
    // Only while she hangs: on the floor, an arm sealed on a rock's flank would only hold her back.
    if (!this.steep) return;
    const want = k.minWallHolds + k.spareHolds;
    let short = this.walls < k.minWallHolds;
    for (let a = 0; a < L.n && this.walls < want; a++) {
      const g = L.arms.arms[a].goal;
      // A station freed to pull gets its reach and its cool-down before it may hold again.
      if (L.role[a] !== IDLE || (g && g.loco !== L) || L.time < this.freedT[a] + k.seekMax + k.seekCool) continue;
      const o = this._wallAnchor(a);
      if (o && L.plantStation(a, o)) { this.walls++; this.holding[a] = 1; this.made[a] = 1; this.madeT[a] = L.roleT[a]; this.stats.toppedUp++; if (this._pinned) this._settle(a); }
      else if (short && !g && this._reachWall(a)) short = false;
    }
  }

  /* Short of holds with none sealed, one free arm lays itself on the wall beside her root, at most one reach at a time;
     once its suckers seal, the top-up makes it a hold. */
  _reachWall(a) {
    const L = this.loco, A = L.arms, dist = A.sdf?.distance, nrm = this._n, p = this._p, k = this.k;
    for (let b = 0; b < L.n; b++) if (A.arms[b].goal?.loco === L && A.arms[b].goal.kind !== 'plant' && L.role[b] === IDLE) return false;
    if (!dist || L.time < this.wallReachAt[a]) return false;
    const rf = L.mantle.rootFrame(a, this._rf);
    for (let i = 0; i < 3; i++) p[i] = rf.p[i] + rf.n[i] * k.wallReach;
    const s = dist(p[0], p[1], p[2], nrm);
    if (!Number.isFinite(s) || s > k.snapMax || nrm[1] > k.floorCos) return false;
    for (let i = 0; i < 3; i++) p[i] -= nrm[i] * s;
    if (A.claim && !A.claim(a, 'stroke')) return false;
    if (!A.reach(a, p, { face: [p[0] - nrm[0] * 0.05, p[1] - nrm[1] * 0.05, p[2] - nrm[2] * 0.05], hold: k.seekMax })) { A.unclaim?.(a, 'stroke'); return false; }
    A.arms[a].goal.loco = L;
    this.wallReachAt[a] = L.time + k.seekMax + k.seekCool;
    this.stats.wallReaches++;
    return true;
  }

  /* Hanging, a station pulls like a calm stroke rather than a floor station, so she hangs, not sags. */
  cap(loco, a, cap) {
    if (loco.role[a] !== STATION || !this.steep) return undefined;
    return Math.max(cap, this.k.capCalm);
  }

  onStall(loco) { this.stallUntil = loco.time + this.k.pullStallT; }

  /* After every tick: the dome eased off while two or more holds are on the walls, and the wall bookkeeping. */
  _tick(dt) {
    const L = this.loco, m = L.mantle, st = L.state.mode;
    // A knob changed from outside becomes the new base.
    if (m.knobs.righting !== this._domeSet) this._domeBase = m.knobs.righting;
    const live = !(st === 'off' || st === 'held' || st.startsWith('rigid'));
    this._at = -1;
    // A station released and remade between two looks (the righting runs after Pull) restarts its role clock.
    for (let a = 0; a < L.n; a++) { if (L.role[a] !== STATION || L.roleT[a] < this.madeT[a]) this.made[a] = 0; this.madeT[a] = L.roleT[a]; }
    if (live) this._refresh();
    this.dome = live ? domeShare(this.walls, this.k) : 1;
    m.knobs.righting = this._domeSet = this._domeBase * this.dome;
    if (!live) return;
    // A wall reach that lapsed without sealing gives its arm's claim back.
    for (let a = 0; a < L.n; a++) {
      if (this.wallReachAt[a] > 0 && L.role[a] === IDLE && !L.arms.arms[a].goal) { L.arms.unclaim?.(a, 'stroke'); this.wallReachAt[a] = 0; }
    }
    this._topUp();
    // Hanging with nothing pulling, each station's arm stiffens and holds its root still, like the floor stance; a line
    // alone lets her slide and swing about her holds. The mantle reads these targets after this listener.
    let pulling = false;
    for (let a = 0; a < L.n; a++) if (L.role[a] === PLANTED) pulling = true;
    const pin = this.steep && !pulling;
    if (!pin) { this.hangSet.fill(0); this._pinned = false; }
    else {
      if (!this._pinned) { this._settle(); this._pinned = true; }
      for (let a = 0; a < L.n; a++) {
        if (L.role[a] !== STATION) this.hangSet[a] = 0;
        if (!this.hangSet[a] || m.armMode[a] !== 1) continue;
        for (let i = 0; i < 3; i++) { m.armTarget[a * 3 + i] = this.hangP[a * 3 + i]; m.armAxis[a * 3 + i] = 0; }
      }
    }
    // A wall station about to lose its last sealed sucker moves to another sealed patch of its arm.
    for (let a = 0; a < L.n; a++) {
      if (this.steep && L.role[a] === STATION && !(L.anchorN[a * 3 + 1] > this.k.floorCos) && L.lostT[a] > this.k.anchorGrace / 2 && this._reanchor(L, a)) this.stats.reanchored++;
    }
    const S = this.stats;
    for (let a = 0; a < L.n; a++) {
      if (L.role[a] !== PLANTED || L.anchorN[a * 3 + 1] > this.k.floorCos) continue;
      S.wallT += dt;
      if (L.rate[a] < 0) S.wallPullT += dt;
    }
  }

  destroy() {
    this.loco.listeners.delete(this._listen);
    this.loco.mantle.knobs.righting = this._domeBase;
  }
}

/* The pull mode and the Climb scenario, which replaces the registry's placeholder before the panel reads it. */
export function installClimb(loco) {
  const pull = new Pull(loco);
  loco.registerMode('pull', pull);
  register('climb', { label: 'Climb', key: '3', run: climb });
  return pull;
}

const r3 = (v) => +(+v).toFixed(3);

/* Climb the front glass to a spot 70 cm up (or under the lid with variant 'lid', report only): arrive within 60 s, hang
   there 5 s on wall holds (never none, two or more for 95% of it), pull for most of the wall time, never fall. A voluntary release below the safety
   rule can't happen (it is refused); a hold lost to the flicker can, so those are counted and reported. */
export async function climb(ctx, { variant = null, to = null, urgency = 0.5, limit = 60, hold = 5, arriveR = 0.07 } = {}) {
  const { loco, mantle } = ctx, pull = loco.modes.get('pull');
  if (!loco.canPlant) return { passed: false, failed: 'no plant support in the arms yet' };
  if (!pull) return { passed: false, failed: 'no pull mode registered' };
  const spot = to ?? (variant === 'lid' ? [-0.5, 0.9, 0.2] : [-0.5, 0.7, TANK.d / 2 - 0.01]);
  const S = pull.stats, s0 = JSON.parse(JSON.stringify(S));
  const w = { y0: loco.c[1], yMax: -Infinity, left: false, drop: 0, track: [], domeMin: 1, forcePeak: 0, wallsMax: 0, lidHoldT: 0, acc: 0 };
  const watch = (dt) => {
    const c = loco.c;
    // She has left the floor once she hangs from the wall: off the floor with a wall hold.
    if (!w.left && pull.walls >= 1 && !pull.standing) w.left = true;
    if (w.left) { w.yMax = Math.max(w.yMax, c[1]); w.drop = Math.max(w.drop, w.yMax - c[1]); }
    w.domeMin = Math.min(w.domeMin, pull.dome);
    w.wallsMax = Math.max(w.wallsMax, pull.walls);
    let lid = 0;
    for (let a = 0; a < loco.n; a++) {
      if (!pull.holding[a]) continue;
      w.forcePeak = Math.max(w.forcePeak, mantle.armForce[a]);
      if (loco.anchorN[a * 3 + 1] < -0.7) lid++;
    }
    if (lid >= 2) w.lidHoldT += dt;
    w.acc += dt;
    if (w.acc >= 0.5) {
      w.acc = 0;
      w.track.push({ t: r3(loco.time), c: c.map(r3), walls: pull.walls, holds: pull.holding.reduce((x, y) => x + y, 0), dome: r3(pull.dome), roles: loco.state.roles.join(',') });
    }
  };
  loco.listeners.add(watch);
  try {
    // 7 cm in the wall's plane keeps the 3D gate's 0.1 m with the crown about 6 cm off the glass.
    const d = loco.want(spot, { urgency, arriveR, source: 'scenario' });
    if (!d) return { passed: false, failed: 'refused' };
    let over = false;
    const timer = until(loco, () => over, limit).then(() => ({ arrived: false, failed: 'timeout' }));
    const res = await Promise.race([d.done, timer]);
    over = true;
    if (loco.desire === d) loco.stop('timeout');
    const c = loco.c, dist3 = Math.hypot(c[0] - spot[0], c[1] - spot[1], c[2] - spot[2]);
    const wallT = S.wallT - s0.wallT, pullT = S.wallPullT - s0.wallPullT;
    // The hang: the crown's drift and how many wall holds she keeps, every tick.
    const h = { start: [...c], t: 0, minWalls: Infinity, enough: 0, ticks: 0, peakSpeed: 0, last: [...c], acc: 0 };
    if (res.arrived) {
      await until(loco, () => {
        h.t += 1 / 60; h.acc += 1 / 60;
        h.minWalls = Math.min(h.minWalls, pull.walls);
        h.ticks++; if (pull.walls >= loco.knobs.minWallHolds) h.enough++;
        if (h.acc >= 1) {
          h.peakSpeed = Math.max(h.peakSpeed, Math.hypot(c[0] - h.last[0], c[1] - h.last[1], c[2] - h.last[2]) / h.acc);
          h.last = [...c]; h.acc = 0;
        }
        return false;
      }, hold);
    }
    const drift = res.arrived ? Math.hypot(c[0] - h.start[0], c[1] - h.start[1], c[2] - h.start[2]) / hold : null;
    const releases = Object.fromEntries(Object.entries(S.releases).map(([key, v]) => [key, v - s0.releases[key]]));
    const out = {
      variant, spot, urgency, arrived: !!res.arrived, failed: res.failed ?? null, t: r3(res.t ?? limit), dist3: r3(dist3),
      hang: res.arrived ? { drift: r3(drift), peakSpeed: r3(h.peakSpeed), minWallHolds: h.minWalls, enoughShare: r3(h.enough / Math.max(1, h.ticks)) } : null,
      wallT: r3(wallT), pullShare: r3(wallT > 0 ? pullT / wallT : 0), fallDrop: r3(w.drop), climbed: r3((w.yMax > -Infinity ? w.yMax : c[1]) - w.y0),
      refused: S.refused - s0.refused, unsafeLost: S.unsafeLost - s0.unsafeLost, reanchored: S.reanchored - s0.reanchored, toppedUp: S.toppedUp - s0.toppedUp, wallReaches: S.wallReaches - s0.wallReaches, releases,
      domeMin: r3(w.domeMin), forcePeak: r3(w.forcePeak), wallsMax: w.wallsMax, lidHoldT: r3(w.lidHoldT), track: w.track,
    };
    if (variant === 'lid') { out.passed = null; return out; }
    out.passed = out.arrived && out.t <= limit && dist3 <= 0.1 && drift !== null && drift < 0.01 && h.minWalls >= 1 && out.hang.enoughShare >= 0.95
      && out.pullShare >= 0.7 && out.fallDrop <= 0.1;
    return out;
  } finally { loco.listeners.delete(watch); }
}
