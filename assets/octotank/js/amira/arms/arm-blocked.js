import { focusChain } from './arm-core.js';

/* The blocked tell: a held reach whose grip point can't close on its target while the arm lies on something in the way.
   It reads the body chain (a rod arm's rod is what's really stopped); only the hold's target and clock reach the intent chain. Blocked → one side-step, its side latched → moveOn. */

export const BLOCKED_KNOBS = {
  on: false,
  blockT: 0.4,       // s a held gap may go without closing while the arm lies on something in the way
  gapMin: 0.05,      // m of gap that counts as arrived: a rod arm's grip point can ride 4–5 cm off its target unobstructed
  closeEps: 0.004,   // m the gap must shrink by to count as closing
  touchGap: 0.005,   // m past a segment's radius that counts as touching
  facing: 0.3,       // a touch is in the way when the way through it to the target meets its normal this head-on
  touchGrace: 0.1,   // s a touch may flicker off without restarting the window
  probeT: 0.9,       // s of the side-step: out along the surface and back, then settleT with the target home
  probeStretch: 0.5, // s a side-step may outlast its hold, so a stall late in a short hold still shows one
  settleT: 0.25,     // s the gap is averaged over at the end, so an arm swinging through doesn't count as past
  probeDist: 0.08,   // m it moves the hold's target at most
  clearFrac: 0.25,   // of the blocked gap the side-step must win back to count as getting past,
  clearMin: 0.02,    // and at least this many m of it, more than a rod arm's own jitter
  sideMin: 0.1,      // under this share of the way lying along the surface, the target is dead behind it: go over the top
  inside: 0.005,     // m inside the furniture a reach's target counts as in a solid, which fails at once
  linger: 1,         // s the label stays after the arm moves on, so the panel can say why
  loco: false,       // locomotion's seeks too: a foot presses into the floor on purpose and its seek has its own timeout
};

/* One tick of the gap window over s { best, stall, away } (fresh: all Infinity but stall 0). True once the gap has gone
   blockT without closing by closeEps while the arm touches something in the way, give or take touchGrace of flicker. */
export function stallStep(s, gap, touching, dt, k) {
  s.away = touching ? 0 : s.away + dt;
  if (!Number.isFinite(gap)) { s.best = Infinity; s.stall = 0; return false; }
  if (s.away > k.touchGrace) { s.best = gap; s.stall = 0; return false; }
  if (gap <= k.gapMin || gap < s.best - k.closeEps) { s.best = Math.min(s.best, gap); s.stall = 0; return false; }
  s.stall += dt;
  return s.stall >= k.blockT - 1e-9;
}

export const freshWindow = (s = {}) => Object.assign(s, { best: Infinity, stall: 0, away: Infinity });

/* Whether a touch at c with outward normal n lies in the way to target t: the way from it meets its normal head-on.
   The floor under a reach for something on it faces sideways to that way, so it never counts. */
export function inTheWay(c, n, t, facing) {
  const dx = t[0] - c[0], dy = t[1] - c[1], dz = t[2] - c[2], l = Math.hypot(dx, dy, dz);
  return l > 1e-9 && (dx * n[0] + dy * n[1] + dz * n[2]) / l < -facing;
}

/* The side-step's unit direction from a touch: d − (d·n)n for d = t − c, which is n × (d × n), so it carries the sign
   of (target − contact) × normal. A target dead behind goes over the top; a surface facing up, off to one side. */
export function sideStep(c, n, t, out, sideMin = BLOCKED_KNOBS.sideMin) {
  const dx = t[0] - c[0], dy = t[1] - c[1], dz = t[2] - c[2], dl = Math.hypot(dx, dy, dz), dn = dx * n[0] + dy * n[1] + dz * n[2];
  if (!Number.isFinite(dl + dn)) return null;
  let x = dx - dn * n[0], y = dy - dn * n[1], z = dz - dn * n[2], l = Math.hypot(x, y, z);
  if (!(l > sideMin * dl && l > 1e-9)) {
    x = -n[1] * n[0]; y = 1 - n[1] * n[1]; z = -n[1] * n[2]; l = Math.hypot(x, y, z);
    // A surface facing up has no top to go over: any level way along it.
    if (!(l > 0.2)) { x = n[2]; y = 0; z = -n[0]; l = Math.hypot(x, y, z); if (!(l > 1e-6)) { x = 1; y = 0; z = 0; l = 1; } }
  }
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return Number.isFinite(out[0] + out[1] + out[2]) ? out : null;
}

/* The side once per reach: the first call fixes st.side and every later one returns it, whatever the touch says now. */
export function latchSide(st, c, n, t, sideMin) {
  if (!st.side) { const s = sideStep(c, n, t, [0, 0, 0], sideMin); if (s) st.side = s; }
  return st.side ?? null;
}

/* The side-step's offset along its side at u of the probe: out and back on a half sine, so the target never jumps. */
export function probeOffset(u, dist) { return u > 0 && u < 1 ? dist * Math.sin(Math.PI * u) : 0; }

/* The side-step got past: the gap to the real target, settled, won back clearFrac of what it was when blocked (and
   clearMin), or arrived. */
export function probeCleared(gap, gap0, k) { return gap <= Math.max(k.gapMin, Math.min(gap0 * (1 - k.clearFrac), gap0 - k.clearMin)); }

export class ArmBlocked {
  constructor(arms) {
    this.arms = arms;
    const n = arms.arms.length;
    this.knobs = { ...BLOCKED_KNOBS };
    this.state = new Array(n).fill(null);
    this.watch = Array.from({ length: n }, () => this._reset({ goal: null }));
    this.counts = { blocked: 0, probes: 0, cleared: 0, moveOn: 0, inside: 0, flips: 0 };
    // The last few tells, oldest first: { t, arm, kind, ht, gap }.
    this.log = [];
    this._live = false;
    this._c = [0, 0, 0]; this._n = [0, 0, 0]; this._m = [0, 0, 0]; this._hit = null;
  }

  _reset(st) {
    freshWindow(st);
    return Object.assign(st, { phase: 0, probed: false, cleared: false, t: 0, gap0: 0, orig: st.orig ?? [0, 0, 0], side: null, c: st.c ?? [0, 0, 0], n: st.n ?? [0, 0, 0], linger: st.linger ?? 0, dir: 0, sum: 0, sumT: 0, what: null, hold0: 0 });
  }

  tick(dt) {
    const k = this.knobs;
    if (!k.on) { if (this._live) this._drop(); return; }
    this._live = true;
    for (let a = 0; a < this.arms.arms.length; a++) this._arm(a, dt, k);
  }

  /* Turned off mid-probe: the target goes back where it was and every label clears. */
  _drop() {
    this._live = false;
    for (let a = 0; a < this.watch.length; a++) {
      const st = this.watch[a], g = this.arms.arms[a].goal;
      if (st.phase === 1 && g === st.goal) { for (let i = 0; i < 3; i++) g.target[i] = st.orig[i]; g.hold = st.hold0; }
      this._reset(st); st.goal = null; st.linger = 0;
      this.state[a] = null;
    }
  }

  _arm(a, dt, k) {
    const A = this.arms, arm = A.arms[a], g = arm.goal, st = this.watch[a];
    if (g !== st.goal) {
      this._reset(st); st.goal = g;
      // A goal taken away mid-probe clears its label too; only a moveOn's own lingers.
      if (g || !(st.linger > 0)) { this.state[a] = null; st.linger = 0; }
      const mine = g && (g.kind === 'reach' || g.kind === 'hold') && (k.loco || !g.loco);
      if (mine && A.sdf.distance(g.target[0], g.target[1], g.target[2], this._m) < -k.inside) { this.counts.inside++; return this._moveOn(a, arm, st, 'inside', 0, 'its target is inside a solid'); }
    }
    if (!g) {
      if (st.linger > 0 && (st.linger -= dt) <= 0 && this.state[a] === 'blocked') this.state[a] = null;
      return;
    }
    if (g.kind !== 'hold' || (g.loco && !k.loco)) return;
    // A frozen arm (its root frame lost) can't close any gap: the window waits, and a side-step resumes once it steps.
    if (arm.valid === false) { if (st.phase !== 1) freshWindow(st); return; }
    const body = A.bodies[a], X = body.X, gi = arm.gripAt, T = g.target;
    if (st.phase === 1) return this._probe(a, arm, st, g, X, gi, dt, k);
    // A grip is an arrival, whatever the gap says.
    if (A.episodes[a]?.h) { freshWindow(st); if (this.state[a] === 'blocked') this.state[a] = null; return; }
    const gap = Math.hypot(X[gi * 3] - T[0], X[gi * 3 + 1] - T[1], X[gi * 3 + 2] - T[2]);
    const touching = this._contact(a, body, gi, T, k);
    if (touching) { for (let i = 0; i < 3; i++) { st.c[i] = this._c[i]; st.n[i] = this._n[i]; } st.what = this._hit; }
    if (!stallStep(st, gap, touching, dt, k)) return;
    if (st.probed) return this._moveOn(a, arm, st, 'moveOn', gap, 'still blocked after its side-step');
    // Too late in the hold for a side-step: one would keep it pressed well past its own end.
    if (g.hold - g.ht < k.probeT - k.probeStretch) return this._moveOn(a, arm, st, 'moveOn', gap, 'blocked near the end of its hold');
    // Blocked: this tick says so, and the side-step starts moving the target on the next.
    if (!latchSide(st, st.c, st.n, T, k.sideMin)) return this._moveOn(a, arm, st, 'moveOn', gap, 'blocked, with no way along the surface');
    st.phase = 1; st.probed = true; st.cleared = false; st.t = 0; st.gap0 = gap; st.dir = 0; st.sum = 0; st.sumT = 0;
    for (let i = 0; i < 3; i++) st.orig[i] = T[i];
    // The hold lasts out the side-step, so its own clock can't cut the probe short.
    st.hold0 = g.hold; g.hold = Math.max(g.hold, g.ht + k.probeT + 2 * dt);
    this.state[a] = 'blocked';
    this.counts.blocked++; this.counts.probes++;
    this._event(a, 'blocked', g, gap);
    A.records?.note?.(a, 'blocked', st.what ?? 'something in the way');
  }

  _probe(a, arm, st, g, X, gi, dt, k) {
    const T = g.target, O = st.orig, S = st.side;
    st.t += dt;
    const move = Math.max(1e-6, k.probeT - k.settleT), u = Math.min(1, st.t / move), off = probeOffset(u, k.probeDist);
    for (let i = 0; i < 3; i++) T[i] = O[i] + S[i] * off;
    // The applied offset against the latched side: it can only ever be zero or along it.
    const dir = Math.sign((T[0] - O[0]) * S[0] + (T[1] - O[1]) * S[1] + (T[2] - O[2]) * S[2]);
    if (dir && st.dir && dir !== st.dir) this.counts.flips++;
    if (dir) st.dir = dir;
    const gap = Math.hypot(X[gi * 3] - O[0], X[gi * 3 + 1] - O[1], X[gi * 3 + 2] - O[2]);
    if (u >= 1) { st.sum += gap * dt; st.sumT += dt; }
    this.state[a] = 'probing';
    if (st.t < k.probeT - 1e-9) return;
    for (let i = 0; i < 3; i++) T[i] = O[i];
    st.phase = 0; freshWindow(st);
    st.cleared = probeCleared(st.sumT > 0 ? st.sum / st.sumT : gap, st.gap0, k);
    const gripped = !!this.arms.episodes[a]?.h;
    if (!st.cleared && !gripped) return this._moveOn(a, arm, st, 'moveOn', gap, 'blocked: its side-step found no way past');
    this.state[a] = null;
    // A grip taken mid-probe ends it as an arrival, not a side-step that got past.
    if (!st.cleared) return;
    this.counts.cleared++;
    this._event(a, 'cleared', g, gap);
    this.arms.records?.note?.(a, 'cleared', 'side-stepped past what blocked it');
  }

  _moveOn(a, arm, st, kind, gap, text) {
    this._event(a, kind, arm.goal, gap);
    if (text) this.arms.records?.note?.(a, 'blocked', text);
    arm.moveOn();
    st.goal = arm.goal; st.phase = 0; st.linger = this.knobs.linger;
    this.state[a] = 'blocked';
    this.counts.moveOn++;
    this.arms.records?.note?.(a, 'moveOn', 'blocked');
  }

  _event(a, kind, g, gap) {
    this.log.push({ t: this.arms.time, arm: a, kind, ht: g?.ht ?? null, gap });
    if (this.log.length > 32) this.log.shift();
  }

  /* The touch in the way nearest the grip point among the segments up to it, against the furniture and every loose
     thing but the one the reach is for; this._c and this._n get its surface point and outward normal. */
  _contact(a, body, gi, T, k) {
    const A = this.arms, w = A.knobs.looseContact ? A.allSdf : A.sdf, X = body.X, rad = body.rad, nrm = this._n, c = this._c;
    const ti = w === A.allSdf && A.track[a] ? A.loose.indexOf(A.track[a]) : -1, skip = ti >= 0 ? A._looseAt + ti : -1;
    focusChain(body, w, A.knobs.focusPad);
    const was = w.skip;
    w.skip = skip;
    let found = false;
    for (let j = Math.min(gi, body.n - 2); j >= 0 && !found; j--) {
      const p = j * 3, mx = (X[p] + X[p + 3]) / 2, my = (X[p + 1] + X[p + 4]) / 2, mz = (X[p + 2] + X[p + 5]) / 2;
      const r = (rad[j] + rad[j + 1]) / 2 + k.touchGap, pen = w.collide(mx, my, mz, r, nrm);
      if (!(pen > 0)) continue;
      const d = r - pen;
      c[0] = mx - nrm[0] * d; c[1] = my - nrm[1] * d; c[2] = mz - nrm[2] * d;
      found = Number.isFinite(c[0] + c[1] + c[2]) && inTheWay(c, nrm, T, k.facing);
      if (found) this._hit = w.hit >= A._looseAt && w === A.allSdf ? A.loose[w.hit - A._looseAt] : A.primEntry?.[w.hit] ?? null;
    }
    w.skip = was;
    return found;
  }
}
