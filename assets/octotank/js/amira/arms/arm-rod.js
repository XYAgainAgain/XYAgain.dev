import { Rod, ROD_KNOBS, frameQuat } from './arm-rod-core.js';
import { restArm, armVolume, projectPoint, travelPoint, focusChain, chainBends } from './arm-core.js';

/* A rod arm's body chain: the intent Arm keeps its programs and its chain, its chain's bends set the rod's rest shape, and the
   rod, with mass, water, and contact of its own, is where the arm is; it reaches the intent only through _feedback. */

// Fitted on the bench: a reach arrives about 0.1 s behind its program and a still arm's tip hangs about 2 cm low.
export const ROD_ARM_KNOBS = {
  ...ROD_KNOBS,
  E0: 1e6,
  tipStiff: 2,
  rest: 'chain',         // the rest shape: the intent's chain as its contact laid it, its posed bends ('bends', which can
                         // run through her body), or 'targets' (its programs' own, with the rod as their spring)
  hold: 'rod',           // whose contact bends later rest shapes: 'rod', 'ghost' (the intent chain's own), or 'off'
  stiffRef: 90,          // 1/s² of authored joint stiffness that leaves the rod's bending as is, in targets mode
  rootShare: 0.033,      // the drawn arm's root radius over the full arm's length, the front pair's too
  rootGap: 0.002,        // m a rod's collision radius keeps clear of its neighbors' roots on her crown
  current: true,         // the tank's currents push the rod
};

const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/* The drawn arm's radii at each of arm's points: the canon root on the authored taper to the authored tip. */
export function drawnRadii(arm, k, out = new Float64Array(arm.n)) {
  const ak = arm.knobs, L = arm.length, root = k.rootShare * ak.length;
  for (let i = 0; i < arm.n; i++) out[i] = ak.tipRadius + (root - ak.tipRadius) * Math.pow(Math.max(0, 1 - arm.arc0[i] / L), ak.taperPow);
  return out;
}

/* Arm `index`'s share of all her arms' mass, by drawn volume among `count` canon arms. */
export function armMassShare(index, armKnobs, k, count = 8) {
  const n = armKnobs.points, len = new Float64Array(n - 1), rad = new Float64Array(n), arc = new Float64Array(n), front = armKnobs.frontArms ?? [];
  const vol = (isFront) => {
    restArm(n, armKnobs.length * (isFront ? armKnobs.frontScale : 1), armKnobs.tipLenRatio, k.rootShare * armKnobs.length, armKnobs.tipRadius, armKnobs.taperPow, len, rad, arc);
    return armVolume(len, rad);
  };
  const vf = vol(true), vb = vol(false);
  let total = 0;
  for (let i = 0; i < count; i++) total += front.includes(i) ? vf : vb;
  return (front.includes(index) ? vf : vb) / total;
}

export class RodArm {
  /* arm: the intent Arm; k: the rod knobs every rod arm shares; mass: this rod's kg; cap: the most its collision radius
     may be, so a root beside thinner neighbors on her crown never overlaps theirs (the drawn arm keeps the canon girth). */
  constructor(arm, k, mass, { cap = Infinity } = {}) {
    this.intent = arm;
    this.k = k;
    this.mass = mass;
    this.cap = Math.max(arm.knobs.tipRadius, cap);
    const n = this.n = arm.n;
    this.X = new Float64Array(n * 3);     // the body chain as it lies; contact works on it, then hands the change to the rod
    this.P = new Float64Array(n * 3);     // last tick's
    this.Q = new Float64Array(n * 3);     // where it last lay clear, which the swept check starts from
    this.rad = new Float64Array(n);       // collision, live; the drawn radius with the cap
    this.rad0 = new Float64Array(n);
    this.drawRad = new Float64Array(n);   // as drawn, live
    this.drawRad0 = new Float64Array(n);
    this.SK = new Float64Array((n - 1) * 3);
    this.lam = new Float64Array(n - 1).fill(1);
    this.D = null;                         // the view measures the roll from SK
    this.twist = null;
    this.rod = null;
    this.restGen = -1;
    this.stiff = 1;                       // the whole rod's bending, scaled (the bench's limp)
    this.started = false;
    this._fresh = true;
    this._first = true;
    this._resets = 0;
    this._touched = new Uint8Array(n);
    this._hit = n;
    this._n = [0, 0, 0];
    this._q = [0, 0, 0, 1];
    this._f9 = new Float64Array(9);
    this._B = new Float64Array((n - 1) * 2);
    this._s3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this._sync();
  }

  get knobs() { return this.intent.knobs; }
  get frame() { return this.intent.frame; }
  get valid() { return this.intent.valid; }
  get goal() { return this.intent.goal; }
  get gripAt() { return this.intent.gripAt; }
  get index() { return this.intent.index; }
  get length() { return this.intent.length; }
  get len0() { return this.intent.len0; }
  get arc0() { return this.intent.arc0; }

  /* A new rest geometry on the intent arm (a knob moved) builds the rod afresh along it. */
  _sync() {
    const arm = this.intent;
    if (this.restGen === arm.restGen) return;
    drawnRadii(arm, this.k, this.drawRad0);
    this.drawRad.set(this.drawRad0);
    for (let i = 0; i < this.n; i++) this.rad[i] = this.rad0[i] = Math.min(this.drawRad0[i], this.cap);
    this.rod = new Rod({ len: arm.len0, rad: this.drawRad0, mass: this.mass }, this.k);
    this.restGen = arm.restGen;
    this.started = false;
    this._resets = 0;
  }

  /* The rest shape from the intent chain: its posed bends, the bends of its chain as its own contact laid it, or in
     targets mode its programs' targets with each joint's authored stiffness scaling the rod's bending there. */
  _rest() {
    const arm = this.intent, rod = this.rod, k = this.k;
    if (k.rest === 'targets') {
      rod.setRestFromBends(arm.tgt, arm.twist, arm.lam);
      const ak = arm.knobs, ref = k.stiffRef > 0 ? k.stiffRef : ROD_ARM_KNOBS.stiffRef;
      for (let j = 0; j < rod.n; j++) {
        const kk = ak.stiffIdle + (arm.stiffGoal[j] - ak.stiffIdle) * arm.w;
        rod.bendScale[j] = this.stiff * Math.max(0.05, Math.min(20, kk / ref));
      }
    } else {
      const s = this._s3, B = k.rest === 'chain' && arm.X.every(Number.isFinite) ? chainBends(arm.frame, arm.twist, arm.X, this._B, this.n - 1, s[0], s[1], s[2]) : arm.out;
      rod.setRestFromBends(B, arm.twist, arm.lam);
      rod.bendScale.fill(this.stiff);
    }
  }

  /* After the intent arm's step: the root from its frame, the rest shape from its bends, then the rod's own step.
     ambient(x, y, z, out) is the water's velocity. */
  step(dt, ambient) {
    const arm = this.intent;
    if (arm.valid === false) return;
    this._sync();
    const rod = this.rod, F = arm.frame, q = frameQuat(F.u, F.v, F.d, this._q);
    // A root that jumped (a reset, a teleport) laid the intent chain afresh; dragged there, the rod would whip.
    if (arm._jumped) this.started = false;
    this._rest();
    if (!this.started) {
      // On the intent chain as it lies, which its own contact has already laid clear at full length.
      rod.setRoot(F.p, q, true);
      rod.poseFromPoints(arm.X);
      this._fresh = true;
    } else if (dt > 0) {
      rod.setRoot(F.p, q);
      rod.step(dt, ambient);
      const resets = rod.resets ?? 0;
      if (resets !== this._resets) { this._resets = resets; this._fresh = true; }
    }
    // A rod laid out afresh may lie inside something; that push-out is a placement, not a shove, so it leaves no speed.
    this._placed = this._fresh;
    if (this.started) this.P.set(this.X);
    this.X.set(rod.x);
    if (!this.started) this.P.set(this.X);
    this.Q.set(this.P);
    this._radii();
    // Arm-on-arm contact reads the sucker side before settle does, so it gets this tick's.
    this._frames();
    this._touched.fill(0);
    this._hit = this.n;
    this._first = true;
    this.started = true;
  }

  /* One round of the rod's own contact, after the arm-on-arm push: each point carried from where it last lay clear to
     where it is now, around whatever it meets, with no length seating or bend limit; the last round lifts the middle of
     a segment cutting a corner by its far end. */
  contact(world, body, last = false) {
    if (this.intent.valid === false) return;
    focusChain(this, world, this.knobs.focusPad);
    const X = this.X, Q = this.Q, n = this.n, k = this.knobs, first = this._first;
    for (let i = 1; i < n; i++) {
      const o = i * 3, m = len3(X[o] - Q[o], X[o + 1] - Q[o + 1], X[o + 2] - Q[o + 2]);
      // A point the later rounds left where the first one cleared it is still clear.
      if (!first && m < k.stillTol) continue;
      if (!this._fresh && m > this.rad[i] * k.sweepStep) travelPoint(this, i, world, body, Q[o], Q[o + 1], Q[o + 2]);
      else projectPoint(this, i, world, body);
    }
    if (last && world) {
      const nrm = this._n;
      for (let i = 1; i < n; i++) {
        const a = (i - 1) * 3, o = i * 3;
        const pen = world.collide((X[a] + X[o]) / 2, (X[a + 1] + X[o + 1]) / 2, (X[a + 2] + X[o + 2]) / 2, (this.rad[i - 1] + this.rad[i]) / 2, nrm, i);
        if (!(pen > 0)) continue;
        // Only the far end moves, twice the depth, carried there around whatever it meets: the near one has already
        // cleared, and a middle's push can point into a thin wall the end lies beyond.
        const fx = X[o], fy = X[o + 1], fz = X[o + 2];
        X[o] += 2 * pen * nrm[0]; X[o + 1] += 2 * pen * nrm[1]; X[o + 2] += 2 * pen * nrm[2];
        travelPoint(this, i, world, body, fx, fy, fz);
        this._touched[i] = 1;
        if (i < this._hit) this._hit = i;
      }
    }
    Q.set(X);
    this._fresh = false;
    this._first = false;
  }

  /* After the last round: what contact moved, the rod keeps as velocity (a point pushed out of a rock must not keep
     its inward speed, or it goes back in); then the frames turn onto the corrected segments. */
  settle(dt) {
    if (this.intent.valid === false) return;
    const rod = this.rod, X = this.X, x = rod.x, n = this.n, h = this._placed ? 0 : dt;
    for (let i = 1; i < n; i++) {
      const o = i * 3, dx = X[o] - x[o], dy = X[o + 1] - x[o + 1], dz = X[o + 2] - x[o + 2];
      if (dx !== 0 || dy !== 0 || dz !== 0) rod.displace(i, dx, dy, dz, h);
    }
    rod.alignFrames();
    X.set(x);
    this.Q.set(X);
    this._radii();
    this._frames();
  }

  _radii() {
    this.rod.radii(this.drawRad);
    for (let i = 0; i < this.n; i++) this.rad[i] = Math.min(this.drawRad[i], this.cap);
  }

  /* Each segment's live stretch, and its sucker side from the rod's own frame, as poseFromBends lays it on the posed one. */
  _frames() {
    const rod = this.rod, X = this.X, F = this.intent.frame, f = this._f9, SK = this.SK, l0 = this.intent.len0;
    for (let j = 0; j < this.n - 1; j++) {
      const o = j * 3;
      this.lam[j] = len3(X[o + 3] - X[o], X[o + 4] - X[o + 1], X[o + 5] - X[o + 2]) / l0[j];
      rod.frame(j, f);
      const sx = F.cu * f[0] + F.cv * f[3], sy = F.cu * f[1] + F.cv * f[4], sz = F.cu * f[2] + F.cv * f[5], sl = len3(sx, sy, sz);
      if (sl > 1e-9) { SK[o] = sx / sl; SK[o + 1] = sy / sl; SK[o + 2] = sz / sl; }
    }
  }

  /* The contact this chain lay against this tick, as the intent arm's _feedback takes it. */
  get contactHold() { return { X: this.X, touched: this._touched, hit: this._hit }; }

  /* Seat the rod on the intent chain again, at rest. */
  reset() { this.started = false; }

  /* The same report as Arm.health, measured on the rod: lengths against its rest stretch, bends against the intent's limits. */
  health() {
    const X = this.X, rod = this.rod, lim = this.intent.lim, n = this.n;
    let nan = 0, lenErr = 0, bend = 0, over = -Infinity, smax = 0, smin = Infinity, px = 0, py = 0, pz = 0;
    for (let i = 0; i < X.length; i++) if (!Number.isFinite(X[i])) nan++;
    for (let j = 0; j < n - 1; j++) {
      let dx = X[j * 3 + 3] - X[j * 3], dy = X[j * 3 + 4] - X[j * 3 + 1], dz = X[j * 3 + 5] - X[j * 3 + 2];
      const l = len3(dx, dy, dz), want = rod.len0[j] * rod.lam[j];
      lenErr = Math.max(lenErr, Math.abs(l - want) / want);
      if (l > 1e-12) { dx /= l; dy /= l; dz /= l; }
      if (j > 0) {
        const b = Math.acos(Math.max(-1, Math.min(1, dx * px + dy * py + dz * pz)));
        bend = Math.max(bend, b); over = Math.max(over, b - lim[j]);
      }
      px = dx; py = dy; pz = dz;
      smax = Math.max(smax, this.lam[j]); smin = Math.min(smin, this.lam[j]);
    }
    let tmax = 0;
    for (let j = 0; j < n - 1; j++) tmax = Math.max(tmax, Math.abs(this.intent.twist[j]));
    return { nan, lenErr, bend, bendOver: over, stretchMax: smax, stretchMin: smin, twistMax: tmax };
  }

  /* J of motion in the rod: its nodes' kinetic energy. */
  kinetic() {
    const rod = this.rod, v = rod.v;
    let e = 0;
    for (let i = 0; i <= rod.n; i++) e += 0.5 * rod.mN[i] * (v[3 * i] ** 2 + v[3 * i + 1] ** 2 + v[3 * i + 2] ** 2);
    return e;
  }
}
