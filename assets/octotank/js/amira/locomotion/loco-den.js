import { DEN_KNOBS, denPlan, envelope, shovelShare, wiggleOffset, exitWay, exitEase, exitSpot, exitReach } from './loco-den-core.js';
import { wrap } from './locomotion-core.js';
import { section } from '../../diag/panel.js';

/* Resting and lying still, she rocks and screws herself down into the gravel, shoveling a bowl under her (a short wiggle if
   one already fits), then lies low in it until she sets off. She takes the crawl's patches as the jet does and hands them back as a stance. */

const SHOVEL_DT = 1 / 15;
const EXIT_STEP = 0.01;
const EXIT_FAN = [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100].map((d) => (d * Math.PI) / 180);

/* Whether (x, z) lies over the bed, inside the tank and off the furniture's footprint; a field with no extent is all bed. */
function onBed(f, x, z) {
  if (!(f.width > 0)) return true;
  if (!(Math.abs(x) <= f.width / 2 && Math.abs(z) <= f.depth / 2)) return false;
  return !f.blocked?.[Math.round((z + f.depth / 2) / f.dz) * f.nx + Math.round((x + f.width / 2) / f.dx)];
}

export class Den {
  constructor({ loco, mantle, arms, sand, jet = null }, { knobs = {} } = {}) {
    Object.assign(this, { loco, mantle, arms, sand, jet });
    this.knobs = { ...DEN_KNOBS, ...knobs };
    const n = mantle.roots.length;
    this.anchor = new Float64Array(n * 3);   // each arm base's target before the wiggle, sinking as the bed drops; or where it began the glide out
    this.bed0 = new Float64Array(n);         // the bed under each arm base when the settle began
    this.lift = new Float64Array(n);         // each arm base's height over the bed when the glide out began
    this.center = [0, 0, 0];
    this.body = [0, 0];                      // her own center when the settle began, which the wiggle rocks about
    this.dens = [];                           // where her last few dens are, so resting there again finds the old one
    this.lying = null;                        // [x, z] of the bowl she lies in, until she leaves it
    this.way = [0, 0];                        // the glide out's flat direction
    this.pivot = [0, 0]; this.psiExit = 0;    // her center and heading when the glide out began, which it turns about
    this.err0 = 0;                            // the heading error she set off with, eased in over the glide
    this.dist = 0; this.turn = 0;             // the glide's length once cleared, and the last turn her heading gave the bases
    this.bend = 0;                            // rad the glide's way was turned off the straight bearing to find a clear one
    this.declined = null;                     // the wish a blocked glide was refused for, so it isn't swept again every tick
    this.state = 'off';                       // off, wait, settle, snug, exit
    this.t = 0; this.phi = 0; this.end = Infinity;
    this.left = 0; this.light = false; this.share = 0; this.since = 0; this.best = Infinity; this.bestT = 0;
    this.last = null;                         // how the last settle went
    this.counts = { settles: 0, light: 0, exits: 0, ended: { done: 0, time: 0, woke: 0, off: 0, away: 0, jet: 0, tipped: 0 } };
    this._o = [0, 0, 0]; this._p = [0, 0, 0]; this._u = [0, 0, 0]; this._c = [0, 0, 0];
    this._held = false;
    loco.registerMode('den', { describe: () => (this.state === 'settle' || this.state === 'exit' ? this.describe() : '') });
    // A reset ends a glide at once, so a wish set before the next tick starts where she is; a hold someone else took stays theirs.
    this._listen = () => {};
    this._listen.reset = () => { if (this.state === 'exit') this._out(loco.holdBy === this, 'reset'); };
    loco.listeners.add(this._listen);
    const loc = section('loco');
    loc.add({ name: 'Den', label: () => `Den: ${this.knobs.on ? this.state : 'off'}`, run: () => { this.knobs.on = !this.knobs.on; } });
    loc.add({ type: 'range', name: 'Den exit', values: [0, 1.5, 2.5, 4], get: () => this.knobs.exitTime, set: (v) => { this.knobs.exitTime = v; }, label: () => (this.knobs.exitTime > 0 ? `Den exit glide ${this.knobs.exitTime} s` : 'Den exit glide: off') });
    loc.add({ type: 'range', name: 'Den exit distance', values: [1, 1.2, 1.4, 1.7], get: () => this.knobs.exitDist, set: (v) => { this.knobs.exitDist = v; }, label: () => `Den exit glide ${this.knobs.exitDist} radii` });
  }

  get field() { return this.sand?.field ?? null; }

  tick(dt) {
    if (!(dt > 0)) return;
    const k = this.knobs, L = this.loco;
    // Locomotion switched off ends whatever the den holds her in, as switching the den off does.
    const off = !L.knobs.enabled;
    if (this.state === 'exit') return k.on && !off ? this._exit(dt) : this._out(true);
    if (this.lying && this._leave()) return;
    if (!k.on || off || !this.field || !this.arms.resting) {
      if (this.state === 'settle') this._stop(off ? 'off' : 'woke');
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
      // Its first target goes in now, not next tick: the den runs just before the mantle, so a spring with a stale target pulls this tick.
      this.anchor.set(p, a * 3); m.armTarget.set(p, a * 3);
      this.bed0[a] = f.sample(p[0], p[2]);
      m.armMode[a] = 1; m.armCap[a] = k.holdN;
      m.armAxis.fill(0, a * 3, a * 3 + 3); m.armVel.fill(0, a * 3, a * 3 + 3);
    }
    this.t = 0; this.phi = 0; this.share = 0; this.since = 0; this.best = Infinity; this.bestT = 0;
    this.end = plan.light ? k.minTime : Infinity;
    this.lying = null;
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
    const settled = why === 'done' || why === 'time' || why === 'woke' || why === 'off';
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
    // Called away mid-dig she still lies in what bowl there is, once it is a bowl, and glides out of it like any other.
    if ((settled || why === 'away') && this.left < 0.7) this.lying = [this.center[0], this.center[2]];
    this.state = why === 'done' || why === 'time' ? 'snug' : 'wait';
  }

  /* Lying in her bowl with somewhere to go, she glides out (see _exit); once her center is past 1.7 radii of it, she has
     left the bowl and this stops asking. */
  _leave() {
    const k = this.knobs, L = this.loco, m = this.mantle, c = m.centroid(this._c);
    if (Math.hypot(c[0] - this.lying[0], c[2] - this.lying[1]) > k.radius * 1.7) { this.lying = null; return false; }
    if (!k.on || !this.field || !(k.exitTime > 0) || !L.desire || L.hold || !L._live) return false;
    if ((this.jet && this.jet.phase !== 'off') || !(m.up(this._u)[1] > 0.5)) return false;
    // A place inside the glide is one she reaches by crawling a step.
    if (L.desire === this.declined || !exitWay(this.lying[0], this.lying[1], L.desire.point[0], L.desire.point[2], k.radius * k.exitDist, this.way)) return false;
    const p = this._p, f = this.field;
    for (let a = 0; a < m.roots.length; a++) { m.rootWorld(a, p); this.anchor.set(p, a * 3); }
    this.pivot[0] = c[0]; this.pivot[1] = c[2];
    this.err0 = Number.isFinite(L.pose.yawCmd) ? wrap(L.pose.yawCmd - L.pose.yaw) : 0;
    if (!this._bearing(k.radius * k.exitDist, k.radius * k.exitMin)) { this.declined = L.desire; return false; }
    L.standDown(0);
    L.hold = true; L.holdBy = this; this._held = true;
    for (let a = 0; a < m.roots.length; a++) {
      const A = a * 3;
      // Each arm base keeps the height it had over the bed, less the hunker it lay pressed down by, so it rides up the
      // bowl's wall and over the rim.
      this.lift[a] = this.anchor[A + 1] - f.sample(this.anchor[A], this.anchor[A + 2]) + k.hunker;
    }
    this.psiExit = L.pose.yaw; this.turn = 0;
    this.t = 0;
    this.state = 'exit';
    this.counts.exits++;
    // The glide's first targets and holds go in the tick it takes her, or every patch the crawl let go of would hang loose.
    this._exit(0);
    return true;
  }

  /* Every arm base slides the same way along the bed, eased in and out, on the settle's holds, while she turns to follow the heading
     her pose commands. The error she set off with is eased in over the glide: held, she can't turn, and a crawl handed it yanks her round. */
  _exit(dt) {
    const k = this.knobs, L = this.loco, m = this.mantle, f = this.field, pose = L.pose;
    if (!L.desire) return this._out(true);
    if (!(m.up(this._u)[1] > 0.5) || !m.positions.every(Number.isFinite)) return this._out(false);
    this.t += dt;
    const T = Math.max(1e-3, k.exitTime), u = this.t / T, e = exitEase(u), dist = this.dist, w = this.way, v = (dist * e.rate) / T;
    // A heading gone non-finite, or one that would turn a base off the bed, keeps the last turn: zeroing it would snap every base back.
    if (Number.isFinite(pose.yawCmd)) {
      const turn = wrap(pose.yawCmd - this.psiExit) - (1 - e.at) * this.err0;
      if (this._fits(turn, dist * e.at)) this.turn = turn;
    }
    const turn = this.turn, q = this._o;
    for (let a = 0; a < m.roots.length; a++) {
      const A = a * 3;
      exitSpot(this.anchor[A], this.anchor[A + 2], this.pivot[0], this.pivot[1], turn, w[0], w[1], dist * e.at, q);
      const x = q[0], z = q[1];
      m.armTarget[A] = x; m.armTarget[A + 1] = f.sample(x, z) + this.lift[a]; m.armTarget[A + 2] = z;
      m.armVel[A] = w[0] * v; m.armVel[A + 1] = 0; m.armVel[A + 2] = w[1] * v;
      m.armAxis.fill(0, A, A + 3);
      m.armMode[a] = 1; m.armCap[a] = k.holdN;
    }
    if (u >= 1) this._out(true);
  }

  /* The glide only has to lift her out level; the crawl aims her after. So a straight bearing clear for less than min tries its
     neighbors, nearest first and alternating sides: the first clear the whole way wins, else the longest clear past min. */
  _bearing(full, min) {
    const w = this.way, a0 = Math.atan2(w[1], w[0]);
    let best = -1, bb = 0;
    for (const b of EXIT_FAN) {
      if (b) { w[0] = Math.cos(a0 + b); w[1] = Math.sin(a0 + b); }
      const d = this._clear(full);
      if (d >= full || (!b && d >= min)) { this.dist = d; this.bend = b; return true; }
      if (d >= min && d > best) { best = d; bb = b; }
    }
    if (best < 0) return false;
    w[0] = Math.cos(a0 + bb); w[1] = Math.sin(a0 + bb);
    this.dist = best; this.bend = bb;
    return true;
  }

  /* Whether every arm base, turned by turn about where she began and slid s along the way, lies over open bed. */
  _fits(turn, s) {
    const f = this.field, w = this.way, q = this._o;
    for (let a = 0, A = 0; a < this.mantle.roots.length; a++, A += 3) {
      exitSpot(this.anchor[A], this.anchor[A + 2], this.pivot[0], this.pivot[1], turn, w[0], w[1], s, q);
      if (!onBed(f, q[0], q[1])) return false;
    }
    return true;
  }

  /* How much of a glide of length dist out along `way` is clear: her center, exitClear over the bed, pressing no deeper into the
     furniture or glass than where she lies, and every arm base over open bed, turned as far as the glide will have turned it there. */
  _clear(dist) {
    const k = this.knobs, f = this.field, w = this.way, cx = this.pivot[0], cz = this.pivot[1];
    const sdf = this.arms.sdf, terrain = this.arms.phys?.terrain, skip = sdf?.skip, r = k.exitClear, nrm = this._u;
    let pen0 = 0;
    if (sdf) {
      sdf.unfocus();
      // The sand is in the world too, and a bowl's wall curving up beside her would read as a wall.
      sdf.skip = terrain && this.arms.primEntry ? this.arms.primEntry.indexOf(terrain.entry) : -1;
      pen0 = sdf.collide(cx, f.sample(cx, cz) + r, cz, r, nrm);
    }
    let D = dist;
    const free = (s) => {
      const x = cx + w[0] * s, z = cz + w[1] * s;
      if (sdf && sdf.collide(x, f.sample(x, z) + r, z, r, nrm) > pen0 + 1e-4) return false;
      return this._fits((s / D) * this.err0, s);
    };
    try {
      // Her bases turn in step with the slide, so a shorter glide turns them sooner: sweep again at each shorter length until one holds.
      for (let i = 0; i <= Math.ceil(dist / EXIT_STEP); i++) {
        const d = exitReach(D, EXIT_STEP, free);
        if (d >= D || !(d > 0)) return d;
        D = d;
      }
      return 0;
    } finally { if (sdf) sdf.skip = skip; }
  }

  /* Out of the bowl: the crawl has her where she is, held there as a stance until its first stroke. The stance takes
     her arm bases as they are, not the glide's targets they trail: a stance pulling against her lag springs her on release. */
  _out(stance, why = '') {
    const L = this.loco, m = this.mantle;
    if (stance) {
      for (let a = 0; a < m.roots.length; a++) L.stanceP.set(m.rootWorld(a, this._p), a * 3);
      m.armVel.fill(0);
      L.stanceOn = true;
    }
    if (this._held && L.holdBy === this && why !== 'jet') L.hold = false;
    if (L.holdBy === this) L.holdBy = null;
    this._held = false;
    this.lying = null;
    this.state = 'wait';
  }

  /* A jet asks first: the settle or the glide out ends and the jet takes her body. */
  release(why) {
    if (this.state === 'settle') this._stop(why);
    else if (this.state === 'exit') this._out(false, why);
  }

  describe() {
    if (this.state === 'exit') return `climbing out of her den, ${this.t.toFixed(1)} s`;
    const pct = Math.round((1 - this.left) * 100);
    return `settling in: ${this.light ? 'a wiggle into her old den' : `digging ${pct}%`}, ${this.t.toFixed(1)} s`;
  }
}
