import { ROLE } from './locomotion-core.js';
import { RIGHT_KNOBS, ROLL_TURNS, supportDot, clinging, flipped, rollDir, rollSense, rollReach, turnDir, nearSide, rightPull } from './loco-right-core.js';

/* The righting reflex: on her back, every hold and the stance let go (they only pin her there) and the arm bases on her
   downhill side pull down to the floor until she rolls over. Listens after the climb, whose support it reads. */

const { planted: PLANTED, station: STATION } = ROLE;
const UP = [0, 1, 0];

export class Right {
  constructor(loco) {
    this.name = 'right';
    this.loco = loco;
    for (const key in RIGHT_KNOBS) loco.knobs[key] ??= RIGHT_KNOBS[key];
    this.k = loco.knobs;
    this.on = false;            // the latch: on her back against what holds her up
    this.t = 0;                 // s the latch has been on
    this.phase = '';            // '' | 'wait' | 'right', for the panel and the harness
    this.dir = [1, 0, 0];
    this.sense = 0;             // which way the reach goes, held near level; 0 until an episode's first pull
    this.still = 0;             // s she has lain still while not upside down, inside the latch
    this.turn = 0;              // which of ROLL_TURNS the arms are trying
    this.best = -1;             // the most upright she has come since the last try began, and when
    this.bestT = 0;
    this.restUntil = -Infinity; // a give-up's rest: no new latch until then
    this.stats = { n: 0, time: 0, longest: 0, released: 0, gaveUp: 0 };
    this._up = [0, 1, 0]; this._h = [0, 0, 0]; this._arcD = [NaN]; this._arcR = [NaN]; this._n = [0, 1, 0]; this._p = [0, 0, 0]; this._c = [0, 0, 0]; this._cPrev = null; this._f = { f: [1, 0, 0], u: [0, 1, 0], s: [0, 0, 1] };
    this._listen = (dt) => this._tick(dt);
    // A reset starts her fresh: no give-up's rest carried into the next scenario, and no speed read across the jump.
    this._listen.reset = () => { this._clear(); this.restUntil = -Infinity; this._cPrev = null; };
    loco.listeners.add(this._listen);
  }

  _clear() {
    this.on = false; this.t = 0; this.still = 0; this.phase = '';
    this.loco.flipped = false;
  }

  _tick(dt) {
    const L = this.loco, k = this.k, m = L.mantle, st = L.state.mode;
    // A squeeze threading a slot owns her holds and may turn her any way it must.
    const sq = L.modes.get('squeeze'), squeezing = !!sq?.active && L.desire === sq.desire;
    if (!(dt > 0) || !k.rightOn || squeezing || st === 'off' || st === 'held' || st.startsWith('rigid')) { this._clear(); return; }
    const up = m.up(this._up), ring = m.ring().c, c = m.centroid(this._c), sdf = L.arms.sdf;
    sdf?.unfocus?.();
    const was = this.on;
    // Her body's center, not her crown: on her back propped up on her arms the crown can sit as high as a hang's.
    if (!(c[1] < k.rightHigh + (was ? 0.1 : 0))) { if (was) this._clear(); return; }
    const near = !sdf || sdf.distance(c[0], c[1], c[2], this._n) < k.rightNear;
    const pull = L.modes.get('pull'), dot = supportDot(up, pull?.support ?? UP);
    // Two or more wall holds, her up not into the wall, and nothing under her body: a climb, mantle below her arms or not.
    const lying = !!sdf && sdf.distance(c[0], c[1] - k.rightNear, c[2], this._n) <= 0;
    const hang = !!pull?.steep && pull.walls >= 2 && dot >= -k.rightDot && !lying;
    const sp = this._cPrev ? Math.hypot(c[0] - this._cPrev[0], c[1] - this._cPrev[1], c[2] - this._cPrev[2]) / dt : 0;
    this._cPrev ??= [0, 0, 0];
    this._cPrev[0] = c[0]; this._cPrev[1] = c[1]; this._cPrev[2] = c[2];
    const cling = clinging(pull?.steep, pull?.walls ?? 0, up[1], dot, lying, k);
    this.on = flipped(was, dot, up[1], near, hang, lying, k, cling) && (was || L.time >= this.restUntil);
    // Still and leaning the right way up, or past rightMax, it rests: a latch that never let go would keep every arm unplanted.
    this.still = this.on && up[1] > 0 && sp < k.stanceSpeed ? this.still + dt : 0;
    if (this.on && (this.still > k.rightStill || this.t > k.rightMax)) { this.on = false; this.restUntil = L.time + k.rightRest; this.stats.gaveUp++; }
    if (!this.on) { if (was) this._clear(); return; }
    if (!was) { this.stats.n++; this.t = 0; this.turn = 0; this.best = up[1]; this.bestT = 0; this.sense = 0; this._arcD[0] = this._arcR[0] = NaN; }
    this.t += dt;
    this.stats.time += dt;
    this.stats.longest = Math.max(this.stats.longest, this.t);
    if (this.t < k.rightAfter) { this.phase = 'wait'; return; }
    this.phase = 'right';
    L.flipped = true;
    for (let a = 0; a < L.n; a++) if (L.role[a] === STATION || L.role[a] === PLANTED) { L._release(a, 'right'); this.stats.released++; }
    L.stanceOn = false;
    const cap = rightPull(this.t, k);
    if (!(cap > 0)) return;
    if (up[1] > this.best + 0.05) { this.best = up[1]; this.bestT = this.t; }
    else if (this.t - this.bestT > k.rightSwap) { this.turn = (this.turn + 1) % ROLL_TURNS.length; this.best = up[1]; this.bestT = this.t; }
    // Toward the floor just past each base, a point that moves with it: fixed points stall the roll once the bases reach them.
    const side = m.bodyFrame(this._f).s, ground = L.arms.phys?.terrain?.field;
    const dir = turnDir(rollDir(up, side, this.dir, this._arcD), ROLL_TURNS[this.turn], up);
    const sense = rollSense(up[1], this.sense, k);
    if (sense !== this.sense) { this.sense = sense; this._arcR[0] = NaN; }
    const h = turnDir(rollReach(up, side, sense, this._h, this._arcR), ROLL_TURNS[this.turn]);
    // Sharing her arms' solve, the far side's bases push level along the roll too: an arm no spring drives hangs its weight,
    // drag, and contact on her as she rolls, and those undriven arms alone held her on her back.
    const far = L.arms.coupling ? k.rightFarCoupled : 0;
    for (let a = 0; a < L.n; a++) {
      const p = m.rootWorld(a, this._p);
      if (L.arms.episodes?.[a]?.h) continue;
      const near = nearSide(p, ring, dir);
      if (!near && !(far > 0)) continue;
      const fx = p[0] + h[0] * k.rightReach, fz = p[2] + h[2] * k.rightReach;
      m.armMode[a] = 1;
      m.armTarget[a * 3] = fx; m.armTarget[a * 3 + 1] = near ? ground?.sample(fx, fz) ?? 0 : p[1]; m.armTarget[a * 3 + 2] = fz;
      m.armAxis[a * 3] = 0; m.armAxis[a * 3 + 1] = 0; m.armAxis[a * 3 + 2] = 0;
      m.armVel[a * 3] = 0; m.armVel[a * 3 + 1] = 0; m.armVel[a * 3 + 2] = 0;
      m.armCap[a] = near ? cap : cap * far;
    }
  }

  describe() { return this.phase === 'right' ? `righting (${this.t.toFixed(1)} s)` : ''; }

  destroy() { this._clear(); this.loco.listeners.delete(this._listen); }
}

export function installRight(loco) {
  const right = new Right(loco);
  loco.rightMode = right;
  return right;
}
