import { pickInterest, ATTEND_KNOBS } from './attention.js';
import { createRng, deriveSeed } from '../../../pond/js/rng.js';
import { TANK } from '../config.js';
import { sizeOf } from './locomotion.js';

/* Her own destinations while nobody asks for one, a stand-in for the brain: she picks something that catches her eye (a
   toy, the novel and moved likelier, a rock, a spot on the glass), crawls there, tastes or looks a while, and moves on.
   She keeps to her side of the rock wall and visits the glass from the floor, until she can squeeze and climb. */

export class Wander {
  constructor(loco, { toys = [], rocks = [], attention = null, panelX = 0.1, panelT = 0.06, seed = 1 } = {}) {
    this.loco = loco;
    this.toys = toys;
    this.rocks = rocks;
    this.attention = attention;
    this.panelX = panelX;
    this.panelT = panelT;
    this.rng = createRng(deriveSeed(seed, 6607));
    const count = toys.length + rocks.length + 4;
    this.lastGlass = false;
    this.points = Array.from({ length: count }, () => [0, 0, 0]);
    this.seen = new Array(count).fill(null);
    this.time = 0;
    this.next = this.rng.range(2, 6);
    this.desire = null;
    this.state = 'wait';
    this.dwellUntil = 0;
    this.looking = null;
    this.what = '';
  }

  tick(dt) {
    const loco = this.loco, k = loco.knobs;
    this.time += dt;
    if (!k.wander) {
      if (this.desire && loco.desire === this.desire) loco.stop('wander off');
      this.desire = null; this.state = 'off';
      return;
    }
    // A click or a scenario takes over until its own desire ends.
    if (loco.desire && loco.desire !== this.desire) { this.desire = null; this.state = 'yield'; this.next = Math.max(this.next, this.time + k.wanderMin); return; }
    if (this.desire) {
      if (loco.desire === this.desire) return;
      const d = this.desire;
      this.desire = null;
      if (d.arrived) return this._arrive(d);
      this.state = 'wait'; this.next = this.time + k.wanderMin;
      return;
    }
    if (this.state === 'dwell') {
      if (this.time < this.dwellUntil) return;
      if (this.looking && loco.pose.focus?.point === this.looking) loco.pose.attend(null);
      this.looking = null;
      this.state = 'wait'; this.next = this.time + this.rng.range(k.wanderMin, Math.max(k.wanderMin, k.wanderMax));
    }
    if (this.state === 'off' || this.state === 'yield') this.state = 'wait';
    // Without arms that can plant she can't get anywhere, so she doesn't set out.
    if (this.time >= this.next && loco.canPlant) this._pick();
  }

  /* One pick among everything on her side of the wall and farther than arriving distance. */
  _pick() {
    const loco = this.loco, k = loco.knobs, c = loco.c, P = this.points, T = this.toys, R = this.rocks, rng = this.rng;
    const side = Math.sign(c[0] - this.panelX) || -1, clear = this.panelT / 2 + 0.08;
    const ok = (p, size) => Number.isFinite(p[0] + p[1] + p[2]) && (p[0] - this.panelX) * side > clear && Math.hypot(p[0] - c[0], p[2] - c[2]) > k.arriveR + size;
    const nan = (p) => { p[0] = NaN; p[1] = NaN; p[2] = NaN; };
    for (let i = 0; i < T.length; i++) {
      loco._entryPoint(T[i], P[i]);
      if (!ok(P[i], sizeOf(T[i])) || this._held(T[i])) nan(P[i]);
      this.seen[i] = this.attention?.seen[i] ?? this.seen[i];
    }
    for (let i = 0; i < R.length; i++) { const p = P[T.length + i]; loco._entryPoint(R[i], p); if (!ok(p, sizeOf(R[i]))) nan(p); }
    // One spot per glass wall at a random height and place on her side; the side wall across the tank is skipped.
    const hw = TANK.w / 2, hd = TANK.d / 2, lo = side < 0 ? -hw + 0.1 : this.panelX + clear, hi = side < 0 ? this.panelX - clear : hw - 0.1;
    const g = T.length + R.length, y = () => rng.range(k.glassLo, Math.max(k.glassLo, k.glassHi));
    P[g][0] = rng.range(lo, hi); P[g][1] = y(); P[g][2] = -hd;
    P[g + 1][0] = rng.range(lo, hi); P[g + 1][1] = y(); P[g + 1][2] = hd;
    P[g + 2][0] = side * hw; P[g + 2][1] = y(); P[g + 2][2] = rng.range(-hd + 0.1, hd - 0.1);
    // And one open spot on the floor, so there is always somewhere to go back down to.
    P[g + 3][0] = rng.range(lo, hi); P[g + 3][1] = 0; P[g + 3][2] = rng.range(-hd + 0.1, hd - 0.1);
    // The glass stays a minority of picks, and never twice running: after a visit up a wall she comes back down.
    const glass = !this.lastGlass && rng.chance(k.glassShare);
    for (let i = g; i < g + 3; i++) if (!glass || !ok(P[i], 0)) nan(P[i]);
    if (!ok(P[g + 3], 0)) nan(P[g + 3]);
    const i = pickInterest(P, this.seen, rng, this.attention?.knobs ?? ATTEND_KNOBS, true);
    this.next = this.time + k.wanderMin;
    if (i < 0) return;
    const target = i < T.length ? T[i] : i < g ? R[i - T.length] : P[i];
    this.lastGlass = i >= g && i < g + 3;
    this.seen[i] = [...P[i]];
    if (i < T.length && this.attention) this.attention.seen[i] = [...P[i]];
    this.what = i < T.length ? `toy ${i}` : i < g ? 'a rock' : this.lastGlass ? 'the glass' : 'an open spot';
    this.desire = loco.want(target, { urgency: k.wanderUrgency, source: 'wander' });
    this.state = this.desire ? 'going' : 'wait';
  }

  _held(toy) { return (this.loco.arms.episodes ?? []).some((e) => e?.h && e.toy === toy); }

  /* There: a toy is tasted by the arm on her eye's line, anything else looked at, for a dwell. */
  _arrive(d) {
    const k = this.loco.knobs, i = d.entry ? this.toys.indexOf(d.entry) : -1;
    if (i >= 0 && this.attention) this.attention.lookAndReach(i);
    else { this.looking = [...d.point]; this.loco.pose.attend(this.looking); }
    this.state = 'dwell';
    this.dwellUntil = this.time + this.rng.range(k.dwellMin, Math.max(k.dwellMin, k.dwellMax));
  }

  describe() {
    if (!this.loco.knobs.wander) return 'wander off';
    return this.state === 'going' ? `wandering to ${this.what}` : this.state === 'dwell' ? `with ${this.what}` : 'idle, wandering';
  }
}
