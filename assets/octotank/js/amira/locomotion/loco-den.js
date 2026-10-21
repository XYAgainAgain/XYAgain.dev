import { DEN_KNOBS, denPlan, envelope, shovelShare, wiggleOffset } from './loco-den-core.js';
import { section } from '../../diag/panel.js';

/* Resting and lying still, she rocks and screws herself down into the gravel, shoveling a bowl under her (a short wiggle if
   one already fits), then lies low in it. She takes the crawl's patches as the jet does and hands them back as a stance. */

const SHOVEL_DT = 1 / 15;

export class Den {
  constructor({ loco, mantle, arms, sand, jet = null }, { knobs = {} } = {}) {
    Object.assign(this, { loco, mantle, arms, sand, jet });
    this.knobs = { ...DEN_KNOBS, ...knobs };
    const n = mantle.roots.length;
    this.anchor = new Float64Array(n * 3);   // each arm base's target before the wiggle, sinking as the bed drops
    this.bed0 = new Float64Array(n);         // the bed under each arm base when the settle began
    this.center = [0, 0, 0];
    this.body = [0, 0];                      // her own center when the settle began, which the wiggle rocks about
    this.dens = [];                           // where her last few dens are, so resting there again finds the old one
    this.state = 'off';                       // off, wait, settle, snug
    this.t = 0; this.phi = 0; this.end = Infinity;
    this.left = 0; this.light = false; this.share = 0; this.since = 0; this.best = Infinity; this.bestT = 0;
    this.last = null;                         // how the last settle went
    this.counts = { settles: 0, light: 0, ended: { done: 0, time: 0, woke: 0, away: 0, jet: 0, tipped: 0 } };
    this._o = [0, 0, 0]; this._p = [0, 0, 0]; this._u = [0, 0, 0];
    this._held = false;
    loco.registerMode('den', { describe: () => (this.state === 'settle' ? this.describe() : '') });
    section('loco').add({ name: 'Den', label: () => `Den: ${this.knobs.on ? this.state : 'off'}`, run: () => { this.knobs.on = !this.knobs.on; } });
  }

  get field() { return this.sand?.field ?? null; }

  tick(dt) {
    if (!(dt > 0)) return;
    const k = this.knobs, L = this.loco;
    if (!k.on || !this.field || !this.arms.resting) {
      if (this.state === 'settle') this._stop('woke');
      this.state = k.on && this.field ? 'awake' : 'off';
      return;
    }
    if (this.state === 'settle') return this._settle(dt);
    // Snug stays snug until she goes somewhere; the next stop settles in afresh.
    if (this.state === 'snug') { if (L.desire || L.hold) this.state = 'wait'; return; }
    this.state = 'wait';
    const jetting = !!this.jet && this.jet.phase !== 'off';
    if (L.desire || L.hold || !L._live || jetting || !(this.mantle.up(this._u)[1] > 0.9) || L.settleT < L.knobs.stanceSettle) return;
    this._start();
  }

  _start() {
    const k = this.knobs, L = this.loco, m = this.mantle, f = this.field, c = m.centroid(this.center);
    let look = f.bowl(c[0], c[2], k.radius, k.depth, 0);
    const x = c[0], z = c[2];
    this.body[0] = x; this.body[1] = z;
    // An old den within half a radius of her is where she settles, if it still fits her better than a fresh spot.
    for (const d of this.dens) {
      if (Math.hypot(d[0] - x, d[1] - z) > k.radius / 2) continue;
      const old = f.bowl(d[0], d[1], k.radius, k.depth, 0);
      if (old.total > 0 && old.missing / old.total < look.missing / Math.max(1e-12, look.total)) { look = old; c[0] = d[0]; c[2] = d[1]; }
    }
    const plan = denPlan(look.missing, look.total, k);
    this.left = plan.left; this.light = plan.light;
    L.standDown(0);
    L.hold = true; L.holdBy = this; this._held = true;
    const p = this._p;
    for (let a = 0; a < m.roots.length; a++) {
      m.rootWorld(a, p);
      this.anchor.set(p, a * 3);
      this.bed0[a] = f.sample(p[0], p[2]);
      m.armMode[a] = 1; m.armCap[a] = k.holdN;
      m.armAxis.fill(0, a * 3, a * 3 + 3); m.armVel.fill(0, a * 3, a * 3 + 3);
    }
    this.t = 0; this.phi = 0; this.share = 0; this.since = 0; this.best = Infinity; this.bestT = 0;
    this.end = plan.light ? k.minTime : Infinity;
    const side = m.bodyFrame().s;
    this.psi0 = Math.atan2(side[2], side[0]);
    this.state = 'settle';
    this.counts.settles++; if (plan.light) this.counts.light++;
    this.last = { at: [+c[0].toFixed(3), +c[2].toFixed(3)], startLeft: +plan.left.toFixed(3), light: plan.light, t: 0, ended: null, left: null };
  }

  _settle(dt) {
    const k = this.knobs, L = this.loco, m = this.mantle, f = this.field, up = m.up(this._u);
    if (L.desire) return this._stop('away');
    if (this.jet && this.jet.phase !== 'off') return this._stop('jet');
    if (!(up[1] > 0.75) || !m.positions.every(Number.isFinite)) return this._stop('tipped');
    this.t += dt;
    this.phi += 2 * Math.PI * k.rate * dt;
    // Shoveling comes in strokes with the rocks, a few at a time.
    this.share += shovelShare(dt, this.phi, k);
    this.since += dt;
    if (this.since >= SHOVEL_DT && this.t < this.end) {
      const c = this.center, r = f.bowl(c[0], c[2], k.radius, k.depth, this.share);
      this.left = r.total > 0 ? Math.max(0, r.missing - r.moved) / r.total : 0;
      if (this.left < this.best - k.stall) { this.best = this.left; this.bestT = this.t; }
      this.share = 0; this.since = 0;
    }
    // Done once the bowl is dug, or no longer deepening (the slump and her own scuffs trickle gravel back in), or out of time.
    const shoveled = this.left <= k.done || this.t - this.bestT > k.stallTime;
    if (this.end === Infinity && this.t >= k.minTime && (shoveled || this.t >= k.maxTime - k.ease)) this.end = this.t + k.ease;
    if (this.t >= this.end) return this._stop(this.light || this.t < k.maxTime - 1e-6 ? 'done' : 'time');
    const env = envelope(this.t, this.end, k.ease), psi = this.psi0 + (2 * Math.PI * this.t) / k.axisTurn, b = this.body, o = this._o;
    for (let a = 0; a < m.roots.length; a++) {
      const A = a * 3, drop = f.sample(this.anchor[A], this.anchor[A + 2]) - this.bed0[a];
      wiggleOffset(this.anchor[A] - b[0], this.anchor[A + 2] - b[1], this.phi, psi, env, k, o);
      m.armTarget[A] = this.anchor[A] + o[0];
      m.armTarget[A + 1] = this.anchor[A + 1] + Math.min(0, drop) - k.hunker * Math.min(1, this.t / Math.max(1e-3, k.ease)) + o[1];
      m.armTarget[A + 2] = this.anchor[A + 2] + o[2];
      m.armMode[a] = 1; m.armCap[a] = k.holdN;
    }
  }

  /* Hand her back: lying in the bowl, the stance holds her where the wiggle left off; going or jetting, the crawl or the jet has her. */
  _stop(why) {
    const L = this.loco, m = this.mantle, k = this.knobs;
    if (this.last) Object.assign(this.last, { t: +this.t.toFixed(2), ended: why, left: +this.left.toFixed(3) });
    if (why in this.counts.ended) this.counts.ended[why]++;
    const settled = why === 'done' || why === 'time' || why === 'woke';
    if (why === 'done' || why === 'time') {
      this.dens = this.dens.filter((d) => Math.hypot(d[0] - this.center[0], d[1] - this.center[2]) > k.radius / 2);
      this.dens.unshift([this.center[0], this.center[2]]);
      this.dens.length = Math.min(this.dens.length, 4);
    }
    if (settled) {
      for (let a = 0; a < m.roots.length; a++) {
        const A = a * 3, drop = this.field.sample(this.anchor[A], this.anchor[A + 2]) - this.bed0[a];
        L.stanceP[A] = this.anchor[A]; L.stanceP[A + 1] = this.anchor[A + 1] + Math.min(0, drop) - k.hunker; L.stanceP[A + 2] = this.anchor[A + 2];
      }
      L.stanceOn = true;
    }
    if (this._held && why !== 'jet') L.hold = false;
    if (L.holdBy === this) L.holdBy = null;
    this._held = false;
    this.state = why === 'done' || why === 'time' ? 'snug' : 'wait';
  }

  /* A jet asks first: the settle ends and the jet takes her body. */
  release(why) { if (this.state === 'settle') this._stop(why); }

  describe() {
    const pct = Math.round((1 - this.left) * 100);
    return `settling in: ${this.light ? 'a wiggle into her old den' : `digging ${pct}%`}, ${this.t.toFixed(1)} s`;
  }
}
