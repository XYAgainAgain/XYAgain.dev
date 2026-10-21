/* The arms' recoil off a noxious touch: reflex-core.js's state machine per arm, turned into goals. An arm flinches off
   the thing, holds clear while it reassesses, then comes back to what it was reaching for more carefully, stopping short. */

import { Reflex, REFLEX_KNOBS } from './reflex-core.js';
import { tasteRule, severityOf } from './sucker-core.js';
import { claimWins, supportDist } from '../locomotion/loco-carry-core.js';

export const ARM_REFLEX_KNOBS = {
  on: true,              // nothing recoils until something is tasted noxious, so it can stay on
  noGrasp: true,         // while a reflex holds the arm none of it seals or tastes its way into an episode; off, only the touched patch
  keepModes: ['squeeze', 'pull'],   // locomotion's stroke modes whose arms keep their job through a noxious touch, as a jet's do by tier
  pauseReach: true,      // a mild touch on a reaching arm stops its bend for the mild hold rather than replacing the reach
  headOn: 0.7,           // a touch whose normal runs this much along the touched segment flinches off to its side, or up off
                         // its suckers, since no bend moves a segment along its own length; 1 leaves every normal as it is
  avoidMax: 1.5,         // s a flinched arm still touching the thing holds its pose before letting go, so it can't freeze against it
  resumeWithin: 8,       // s a reach the recoil took the arm from stays worth coming back to
  resumeAmp: 0.6,        // of the arm's reach amplitude and speed, the second, careful try
  resumeSpeed: 0.7,
  resumeTip: true,       // the careful try reaches with its tip, stopping short of the thing, so no part of the arm lies over it
  keepOut: 0.08,         // m past the noxious thing's surface the careful try's grip point stays
};

/* Point out moved along the line from center c to `pad` past the surface of a shape (kind, size, rotation q), if inside it. */
export function pushOut(out, c, q, kind, size, pad, tmp = [0, 0, 0], d = [0, 0, 0]) {
  d[0] = out[0] - c[0]; d[1] = out[1] - c[1]; d[2] = out[2] - c[2];
  const l = Math.hypot(d[0], d[1], d[2]);
  if (l > 1e-9) { d[0] /= l; d[1] /= l; d[2] /= l; } else { d[0] = 0; d[1] = 1; d[2] = 0; }
  const R = supportDist(kind, size, q, d, tmp) + pad;
  if (Number.isFinite(R) && l < R) { out[0] = c[0] + d[0] * R; out[1] = c[1] + d[1] * R; out[2] = c[2] + d[2] * R; }
  return out;
}

export class ArmReflexes {
  constructor(arms) {
    this.arms = arms;
    const n = arms.arms.length;
    // One live object for the panel: the machine's and the recoil goal's knobs, and the wiring's.
    this.knobs = { ...REFLEX_KNOBS, ...ARM_REFLEX_KNOBS };
    this.rx = Array.from({ length: n }, () => new Reflex(this.knobs));
    this.state = new Array(n).fill('calm');
    this.touches = Array.from({ length: n }, () => []);
    this.mine = new Array(n).fill(null);      // the goal the reflex last set on each arm: a recoil, or a mild touch's still
    this.stash = new Array(n).fill(null);     // the reach a recoil took the arm from
    this.entry = new Array(n).fill(null);     // the noxious thing the running episode is about
    this.live = new Uint8Array(n);            // a recoil holds the arm, from its flinch until calm
    this.released = new Uint8Array(n);        // the reflex let its own recoil go, so an arm with no goal is still its own
    this.paused = new Array(n).fill(null);    // the reach a mild touch is pausing
    this.until = new Float64Array(n);         // when that pause, or a mild still, ends
    this.counts = { recoils: 0, extends: 0, mild: 0, kept: 0, misses: 0, resumes: 0, leaves: 0, releases: 0 };
    this._recoils = new Map();
    this._opts = {};
    this._q = [0, 0, 0, 1]; this._c = [0, 0, 0]; this._t = [0, 0, 0]; this._d = [0, 0, 0];
    this._was = this.knobs.on;
  }

  /* After the touches are tasted and before the suckers act: each arm's noxious touches through its machine, and its
     transitions into goals for the next tick's step. */
  tick(dt) {
    const A = this.arms, k = this.knobs;
    if (!k.on) { if (this._was) this._off(); this._was = false; return; }
    this._was = true;
    const S = A.S, TK = A.touchKind, TE = A.touchEntry, TT = A.touchTaste, TP = A.touchP, TN = A.touchN, sk = A.suckerKnobs;
    for (let a = 0; a < this.rx.length; a++) {
      const list = this.touches[a];
      let c = 0;
      for (let j = 0; j < S; j++) {
        const q = a * S + j;
        if (TK[q] !== 2 || !TE[q] || !this._noxious(TT[q])) continue;
        const o = list[c++] ??= { entry: null, severity: 0, seg: 0, point: [0, 0, 0], normal: [0, 0, 0] };
        o.entry = TE[q]; o.severity = severityOf(TE[q], sk); o.seg = j;
        for (let i = 0; i < 3; i++) { o.point[i] = TP[q * 3 + i]; o.normal[i] = TN[q * 3 + i]; }
      }
      const out = this.rx[a].sense(list, dt, c);
      for (let i = 0; i < out.length; i++) this._act(a, out[i]);
      if (this.live[a] || this.paused[a] || this.mine[a]) this._upkeep(a, dt);
      this.state[a] = this.rx[a].state;
    }
  }

  /* Where arms.js's _toyTarget hands a reach with a keep-out: off the noxious thing by the margin and the arm's radius. */
  keepOut(a, out) {
    const A = this.arms, arm = A.arms[a], g = arm.goal, e = g?.keepOut?.entry, b = e?.body;
    if (!b) return out;
    const p = b.GetPosition(), r = b.GetRotation(), c = this._c, q = this._q, B = A.bodies[a];
    c[0] = p.GetX(); c[1] = p.GetY(); c[2] = p.GetZ(); q[0] = r.GetX(); q[1] = r.GetY(); q[2] = r.GetZ(); q[3] = r.GetW();
    const rad = B.rad[g.tip ? B.n - 1 : arm.gripAt] ?? 0;
    return pushOut(out, c, q, e.kind, e.size, g.keepOut.margin + rad, this._t, this._d);
  }

  _noxious(taste) {
    let r = this._recoils.get(taste);
    if (r === undefined) this._recoils.set(taste, r = !!tasteRule(taste, this.arms.suckerKnobs).recoil);
    return r;
  }

  _act(a, tr) {
    const A = this.arms, t = tr.touch;
    if (t && tr.ignore > 0) A.ignore[a].set(t.entry, Math.max(A.ignore[a].get(t.entry) ?? 0, A.time + tr.ignore));
    if (tr.type === 'recoil') this._recoil(a, t, tr.duration);
    else if (tr.type === 'extend') this._extend(a, tr);
    else if (tr.type === 'mild') this._mild(a, tr);
    else if (tr.type === 'calm') this._calm(a);
    else A.records.note(a, tr.type, this.entry[a] ?? '');
  }

  /* What keeps this arm through a noxious touch: the squeeze test's lead, a running squeeze, a climb (pull while she hangs;
     on the floor it is a crawl's stroke), or a tier over the reflex (a jet, bound arms). A grip is let go, never outranked. */
  _keeper(a) {
    const A = this.arms, g = A.arms[a].goal, owner = A.owner[a];
    if (A.lead) return 'lead';
    const sm = g?.loco?.strokeMode?.[a];
    if (sm && this.knobs.keepModes?.includes(sm.name) && (sm.name === 'pull' ? sm.steep : sm.active !== false)) return sm.name;
    return claimWins(owner, 'reflex') || (owner === 'held' && A.episodes[a]?.h) ? null : owner;
  }

  /* A plain reach or hold to come back to; locomotion's feet, fetches, and the rest are let go instead, and so is a
     careful try stung again, which would otherwise come back every few seconds for as long as the thing lies there. */
  _stashOf(a, g) {
    if ((g.kind !== 'reach' && g.kind !== 'hold') || g.loco || !g.target || g.keepOut) return null;
    const A = this.arms, w = A.blocked?.watch[a], side = w?.phase === 1 && w.goal === g;
    // Mid side-step the blocked tell has moved the target and stretched the hold; the reach was going where it began.
    return { toy: A.track[a], target: (side ? w.orig : g.target).slice(0, 3), face: g.face ? g.face.slice(0, 3) : null, tip: !!g.tip, hold: side ? w.hold0 : g.hold, cFix: g.cFix ?? null, owner: A.owner[a], t: A.time };
  }

  _recoil(a, touch, duration) {
    const A = this.arms, arm = A.arms[a], rec = A.records;
    this.entry[a] = touch.entry;
    const by = this._keeper(a);
    if (by) { this.counts.kept++; rec.note(a, 'kept', by); return false; }
    const g0 = arm.goal, stash = !g0 || g0 === this.mine[a] ? this.stash[a] : this._stashOf(a, g0);
    // The grip goes before the goal does: a stowed fetch's end idles the arm, which would undo the flinch.
    if (A.episodes[a]) A._end(a, true, 'reflex');
    const g = arm.recoil(this._aimed(a, touch), this._optsFor(duration));
    if (!g) { this.counts.misses++; rec.note(a, 'miss', touch.entry); return false; }
    this.stash[a] = stash; this.mine[a] = g; this.live[a] = 1; this.released[a] = 0; this.paused[a] = null;
    A.track[a] = null;
    A.owner[a] = 'reflex';
    this._refr(a, touch.entry, duration);
    this.counts.recoils++;
    rec.note(a, 'recoil', touch.entry);
    return true;
  }

  /* A head-on touch: the normal's part square to the touched segment of the body chain, or none at all (makeRecoil's
     fallback, straight off the sucker side) when too little of it is. The touch the machine keeps is left as it was. */
  _aimed(a, touch) {
    const k = this.knobs, n = touch.normal, X = this.arms.bodies[a].X, o = touch.seg * 3;
    if (!(k.headOn < 1) || !n || !(touch.seg >= 0)) return touch;
    let dx = X[o + 3] - X[o], dy = X[o + 4] - X[o + 1], dz = X[o + 5] - X[o + 2];
    const dl = Math.hypot(dx, dy, dz), nl = Math.hypot(n[0], n[1], n[2]);
    if (!(dl > 1e-9) || !(nl > 1e-9)) return touch;
    dx /= dl; dy /= dl; dz /= dl;
    const c = (n[0] * dx + n[1] * dy + n[2] * dz) / nl;
    if (!(Math.abs(c) > k.headOn)) return touch;
    const a2 = this._aimTouch ??= { ...touch, normal: [0, 0, 0] }, m = a2.normal;
    Object.assign(a2, touch, { normal: m });
    m[0] = n[0] / nl - c * dx; m[1] = n[1] / nl - c * dy; m[2] = n[2] / nl - c * dz;
    if (Math.hypot(m[0], m[1], m[2]) < Math.sqrt(1 - k.headOn * k.headOn) * 0.5) m[0] = m[1] = m[2] = 0;
    return a2;
  }

  _optsFor(duration) {
    const o = Object.assign(this._opts, this.knobs);
    o.duration = duration; o.hold = Infinity;
    return o;
  }

  /* A new thing during a running recoil: a stronger one re-aims the flinch off itself, a weaker one only lengthens it. */
  _extend(a, tr) {
    const A = this.arms, arm = A.arms[a], g = arm.goal, t = tr.touch;
    if (!this.live[a] || g !== this.mine[a] || g?.kind !== 'recoil') return this._recoil(a, t, tr.duration);
    this.counts.extends++;
    const g2 = tr.stronger ? arm.recoil(this._aimed(a, t), this._optsFor(tr.duration)) : null;
    if (g2) { this.mine[a] = g2; this.entry[a] = t.entry; } else g.duration = Math.max(g.duration, g.t + tr.duration);
    this._refr(a, t.entry, tr.duration);
    A.records.note(a, 'extend', t.entry);
  }

  /* Under the recoil threshold: no flinch. A reaching arm's bend stops for the hold, so the reach carries on after it;
     an idle arm holds still that long and then looks elsewhere. */
  _mild(a, tr) {
    const A = this.arms, arm = A.arms[a], g = arm.goal, k = this.knobs;
    this.counts.mild++;
    if (!this.live[a]) this.entry[a] = tr.touch.entry;
    A.records.note(a, 'mild', tr.touch.entry);
    if (this.live[a] || this._keeper(a)) return;
    const until = A.time + tr.hold;
    if (g && (g.kind === 'reach' || g.kind === 'hold')) {
      if (k.pauseReach) { this.until[a] = this.paused[a] === g ? Math.max(this.until[a], until) : until; this.paused[a] = g; }
    } else if (!g) {
      arm.still(); this.mine[a] = arm.goal; A.owner[a] = 'reflex'; this.until[a] = until;
    } else if (g === this.mine[a] && g.kind === 'still') this.until[a] = Math.max(this.until[a], until);
  }

  /* Clear long enough: back to the reach at reduced amplitude and speed, stopping short of the thing, or if there was
     none, the recoil lets go so the arm's wander leaves the spot. An arm something else took since is left to it. */
  _calm(a) {
    const A = this.arms, arm = A.arms[a], k = this.knobs, st = this.stash[a], e = this.entry[a];
    A.records.note(a, 'calm', e ?? '');
    if (this.live[a]) {
      const g = arm.goal, own = g ? g === this.mine[a] : this.released[a];
      if (own && !(st && A.time - st.t <= k.resumeWithin && this._resume(a, st, e))) {
        if (g) arm._letGo(false);
        if (A.owner[a] === 'reflex') A.owner[a] = 'idle';
        this.counts.leaves++;
      }
    }
    this.live[a] = 0; this.released[a] = 0; this.stash[a] = null; this.entry[a] = null;
    if (this.mine[a]?.kind === 'recoil') this.mine[a] = null;
  }

  _resume(a, st, e) {
    const A = this.arms, arm = A.arms[a], k = this.knobs, ak = arm.knobs;
    const opts = { amplitude: ak.reachAmplitude * k.resumeAmp, speed: ak.reachSpeed * k.resumeSpeed, hold: st.hold, tip: st.tip || !!k.resumeTip };
    if (st.cFix != null && !opts.tip) opts.contactArc = st.cFix / arm.length;
    if (!st.toy && st.face) opts.face = st.face;
    if (!(st.toy ? A._reachToy(a, st.toy, opts) : A._reach(a, st.target, opts))) return false;
    const g = arm.goal;
    // A tracked toy's target is kept out every tick in _toyTarget; a point reach's once, here.
    if (e?.body) { g.keepOut = { entry: e, margin: k.keepOut }; if (st.toy) A._toyTarget(a, st.toy, g.target); else this.keepOut(a, g.target); }
    A.owner[a] = st.owner === 'held' || st.owner === 'reflex' ? 'idle' : st.owner;
    this.counts.resumes++;
    A.records.note(a, 'resume', st.toy ?? 'point');
    return true;
  }

  /* The touched patch stays unsealed for the recoil, and under noGrasp the whole arm while the reflex holds it, as
     OctopusController disables grasping near a hazard: an episode begun mid-flinch would moveOn the recoil away. */
  _refr(a, entry, duration) {
    const A = this.arms, S = A.S, R = A.refr, until = A.time + duration;
    for (let j = 0; j < S; j++) { const q = a * S + j; if (A.touchKind[q] === 2 && A.touchEntry[q] === entry && R[q] < until) R[q] = until; }
  }

  _upkeep(a, dt) {
    const A = this.arms, arm = A.arms[a], k = this.knobs, g = arm.goal, rx = this.rx[a], now = A.time;
    const p = this.paused[a];
    // The step already moved the reach's clock this tick; taking it back holds the bend where it is.
    if (p) {
      if (g !== p || !(now < this.until[a])) this.paused[a] = null;
      else if (p.kind === 'reach') p.t = Math.max(0, p.t - dt);
      else if (p.kind === 'hold') p.ht = Math.max(0, p.ht - dt);
    }
    const m = this.mine[a];
    if (m?.kind === 'still') {
      if (g !== m) this.mine[a] = null;
      else if (now >= this.until[a]) { arm._letGo(false); if (A.owner[a] === 'reflex') A.owner[a] = 'idle'; this.mine[a] = null; }
    }
    if (!this.live[a]) return;
    // Something stronger took the arm since (a mode, bound arms, a command): it is theirs, suckers and all, though the
    // machine still remembers the thing.
    if (g !== m && !(this.released[a] && !g)) { this.live[a] = 0; this.released[a] = 0; this.stash[a] = null; this.mine[a] = null; return; }
    if (m?.kind === 'recoil' && g === m && rx.state === 'avoiding' && rx.time - rx.since >= k.avoidMax) {
      arm._letGo(false);
      this.released[a] = 1;
      if (A.owner[a] === 'reflex') A.owner[a] = 'idle';
      this.counts.releases++;
      A.records.note(a, 'letGo', this.entry[a] ?? '');
    }
    if (k.noGrasp) { const S = A.S, R = A.refr, until = now + dt; for (let q = a * S; q < a * S + S; q++) if (R[q] < until) R[q] = until; }
  }

  /* Switched off: every goal of its own let go and every machine reset, so nothing it set outlives the knob. */
  _off() {
    const A = this.arms;
    for (let a = 0; a < this.rx.length; a++) {
      const arm = A.arms[a];
      if (this.mine[a] && arm.goal === this.mine[a]) { arm._letGo(false); if (A.owner[a] === 'reflex') A.owner[a] = 'idle'; }
      this.rx[a].reset();
      this.mine[a] = null; this.stash[a] = null; this.entry[a] = null; this.paused[a] = null;
      this.live[a] = 0; this.released[a] = 0;
      this.state[a] = 'calm';
    }
  }
}
