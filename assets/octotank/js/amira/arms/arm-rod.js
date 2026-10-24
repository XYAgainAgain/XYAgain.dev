import { Rod, ROD_KNOBS, frameQuat } from './arm-rod-core.js';
import { restArm, armVolume, projectPoint, travelPoint, focusChain, chainBends, bodyRadius } from './arm-core.js';

/* A rod arm's body chain: the intent Arm keeps its programs and its chain, its chain's bends set the rod's rest shape, and the
   rod, with mass, water, and contact of its own, is where the arm is; it reaches the intent only through _feedback. */

export const ROD_ARM_KNOBS = {
  ...ROD_KNOBS,
  // Relaxed tissue, root to tip alike: COOMM's 10 kPa arm times the k = 26 her muscle map scales its stresses by, so tissue
  // and muscle keep COOMM's ratio. Bracing firms it (braceGain); 1e6 with a 2× tip was the authored look's fit.
  E0: 2.6e5,
  tipStiff: 1,
  rest: 'chain',         // the rest shape: the intent's chain as its contact laid it, its posed bends ('bends', which can
                         // run through her body), or 'targets' (its programs' own, with the rod as their spring)
  hold: 'rod',           // whose contact bends later rest shapes: 'rod', 'ghost' (the intent chain's own), or 'off'
  stiffRef: 90,          // 1/s² of authored joint stiffness that leaves the rod's bending as is, in targets mode
  rootShare: 0.033,      // the drawn arm's root radius over the full arm's length, the front pair's too
  rootGap: 0.002,        // m a rod's collision radius keeps clear of its neighbors' roots on her crown
  intentRounds: 1,       // finishing passes a driving rod's intent chain runs, the last of the arm-on-arm rounds (0: all)
  cutFixes: 3,           // pushes the last contact round may give one segment still cutting into something
  cutSkin: true,         // and those pushes count a segment's middle sunk in her skin too
  girthFloor: 0.8,       // stretch under which a squeezed segment stops thickening, the authored arm's stretchMin (0: no floor)
  current: true,         // the tank's currents push the rod
  braceGain: 12,         // times the passive bending and axial stiffness a fully braced stretch of arm adds on top
  reachBrace: 0.25,      // share of that bracing a reach takes on its way out (4×, the old 1e6 fit); the rest comes as it grabs
  grabTau: 0.25,         // s for the arm to firm up once it holds, grips, plants, or fetches, and to let go of it
  aim: true,             // a reach aims through the rod: its target moves until the rod's own grip point lands there
  aimTau: 0.3,           // s the aim's correction takes to catch up with the rod's miss
  aimMax: 0.08,          // m the aim may move off where the program meant
  aimPress: 0.006,       // m closer to a toy than the program's clearance a middle grip aims: aimed true, the rod would hover over it
  // Off in core; main.js turns the loads on for the bench, and ?loads=1 the loads and the root wrench for her rod arms.
  toyPush: 'capped',     // 'rod': a toy takes the rod's own contact momentum, split by the two inverse masses; 'capped': pushN per toy
  gripLoad: false,       // what a grip holds weighs on the rod's grip nodes, a tick late
  gripMass: true,        // and the held toy's mass rides those nodes, so its inertia is the rod's own, not a late pull that rings
  gripLoadTau: 0.08,     // s that load is smoothed over
  seals: false,          // sealed suckers on the furniture, and a plant's foot, hold their node where it sealed
  toySeals: false,       // and on a loose thing, which a grip mostly holds anyway
  sealCompliance: 1e-4,  // m/N
  sealGrace: 0.15,       // s a segment's seal outlasts its suckers all flickering off at once
  sealLift: 0.04,        // m the intent chain may draw a sealed node's point off its anchor before the arm lets go there
  wrench: false,         // the root's force and torque reach her body, a tick late; explicit, so at her mass it grows
  wrenchSpread: 'body',  // over all of her as a rigid body would take it, or 'patch', the arm's own
};

const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/* Her arm numbers that get rod bodies from the ?rods flag: all of them when it is absent or 'all', else the listed ones
   (so 'none', or an empty list, gives none). */
export function rodArms(value, count = 8) {
  if (value == null || value.trim() === 'all') return Array.from({ length: count }, (_, i) => i);
  return [...new Set(value.split(',').map((v) => v.trim()).filter((v) => /^\d$/.test(v) && +v < count).map(Number))];
}

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

/* A node pushed out of a loose thing by d along unit n over h: the normal impulse j that stops their closing, split by
   the node's 3×3 inverse mass W (at 9i) and the thing's wt, and the node's own share of the push-out into out. */
export function splitPush(W, i, nx, ny, nz, d, h, wt, out) {
  const o = 9 * i, ax = W[o] * nx + W[o + 1] * ny + W[o + 2] * nz, ay = W[o + 3] * nx + W[o + 4] * ny + W[o + 5] * nz, az = W[o + 6] * nx + W[o + 7] * ny + W[o + 8] * nz;
  const den = nx * ax + ny * ay + nz * az + Math.max(0, wt), j = den > 0 && d > 0 && h > 0 ? d / h / den : 0;
  out[0] = ax * j * h; out[1] = ay * j * h; out[2] = az * j * h;
  return j;
}

/* What the rod puts on her through its root, into F and T (N, and N·m about node 0); with `hold`, less what its seals bore and
   their moments, since her patch spring already pulls her to that anchor. False if any of it is not finite. */
export function rootWrench(rod, hold, F, T) {
  const x = rod.x, f = rod.sF, rf = rod.rootForce, rt = rod.rootTorque;
  F[0] = rf[0]; F[1] = rf[1]; F[2] = rf[2]; T[0] = rt[0]; T[1] = rt[1]; T[2] = rt[2];
  // Every node's seal force, not only the sealed ones: a seal that broke inside the step still bore its share of it.
  if (hold) for (let i = 1; i <= rod.n; i++) {
    const o = 3 * i, fx = f[o], fy = f[o + 1], fz = f[o + 2];
    if (fx === 0 && fy === 0 && fz === 0) continue;
    const rx = x[o] - x[0], ry = x[o + 1] - x[1], rz = x[o + 2] - x[2];
    F[0] -= fx; F[1] -= fy; F[2] -= fz;
    T[0] -= ry * fz - rz * fy; T[1] -= rz * fx - rx * fz; T[2] -= rx * fy - ry * fx;
  }
  return Number.isFinite(F[0] + F[1] + F[2] + T[0] + T[1] + T[2]);
}

/* How braced joint j is, 0–1: its program's stiffness above idle as a share of a reach's braced base, the same share
   the muscle map's co-contraction takes (the map itself gives her no stiffening from it). */
export function braceShare(arm, j) {
  const k = arm.knobs, span = k.stiffBehind - k.stiffIdle, s = (arm.stiffGoal[j] - k.stiffIdle) * arm.w / span;
  return span > 0 && s > 0 ? Math.min(1, s) : 0;
}

/* What bracing b (0–1) multiplies the passive stiffness by: a reach on its way out takes reachBrace of it, a grab (0–1) the rest. */
export function braceFactor(b, grab, k) {
  const r = Math.max(0, Math.min(1, k.reachBrace)), g = Math.max(0, Math.min(1, grab));
  return 1 + Math.max(0, k.braceGain) * b * (r + (1 - r) * g);
}

/* One tick of a reach aimed through its rod: off moves f of the way to the intent chain's grip point (I at o) less the rod's
   (X at o), never past max. Only the rod's own miss is fed back, so a target the program can't reach never winds it up. */
export function aimStep(off, I, X, o, f, max) {
  for (let c = 0; c < 3; c++) { const e = I[o + c] - X[o + c]; if (Number.isFinite(e)) off[c] += f * (e - off[c]); }
  const m = Math.hypot(off[0], off[1], off[2]);
  if (!(m <= max)) { const s = m > 0 && Number.isFinite(m) && max > 0 ? max / m : 0; off[0] *= s; off[1] *= s; off[2] *= s; }
  return off;
}

/* A grip's load L (N on the arm) shared between the two nodes of segment j, fr of the way along it. */
export function spreadLoad(ext, j, fr, L) {
  const f = Math.max(0, Math.min(1, fr)), o = 3 * j;
  for (let c = 0; c < 3; c++) { ext[o + c] += (1 - f) * L[c]; ext[o + 3 + c] += f * L[c]; }
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
    this.grab = 0;                        // 0–1, how far the arm has firmed for a hold; gripping is set from outside
    this.gripping = false;
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
  _rest(dt = 0) {
    const arm = this.intent, rod = this.rod, k = this.k;
    const kind = arm.goal?.kind, want = this.gripping || kind === 'hold' || kind === 'plant' || kind === 'fetch' ? 1 : 0;
    this.grab = !this.started ? want : this.grab + (want - this.grab) * (dt > 0 ? 1 - Math.exp(-dt / Math.max(1e-3, k.grabTau)) : 0);
    if (k.rest === 'targets') {
      rod.setRestFromBends(arm.tgt, arm.twist, arm.lam);
      const ak = arm.knobs, ref = k.stiffRef > 0 ? k.stiffRef : ROD_ARM_KNOBS.stiffRef;
      for (let j = 0; j < rod.n; j++) {
        const kk = ak.stiffIdle + (arm.stiffGoal[j] - ak.stiffIdle) * arm.w;
        rod.bendScale[j] = this.stiff * Math.max(0.05, Math.min(20, kk / ref));
        // The bend's bracing is already in the authored stiffness here; only the muscles' axial stiffening is added.
        rod.stretchScale[j] = arm.knobs.muscle && arm.mus ? arm.mus.axialStiff[j] : 1;
      }
    } else {
      const s = this._s3, B = k.rest === 'chain' && arm.X.every(Number.isFinite) ? chainBends(arm.frame, arm.twist, arm.X, this._B, this.n - 1, s[0], s[1], s[2]) : arm.out;
      rod.setRestFromBends(B, arm.twist, arm.lam);
      // Soft tissue, firmed where the program braces: a braced stretch of arm is braceFactor times stiffer, a relaxed one is
      // the passive tissue (with the muscle map's own small change in muscle mode).
      const M = arm.knobs.muscle ? arm.mus : null, g = this.grab;
      for (let j = 0; j < rod.n; j++) {
        const f = braceFactor(braceShare(arm, j), g, k);
        rod.bendScale[j] = this.stiff * (M ? M.bendStiff[j] : 1) * f; rod.stretchScale[j] = (M ? M.axialStiff[j] : 1) * f;
      }
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
    this._rest(dt);
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
      const nrm = this._n, nb = this._mb ??= [0, 0, 0], fixes = Math.max(1, Math.round(this.k.cutFixes) || 1);
      for (let i = 1; i < n; i++) {
        const a = (i - 1) * 3, o = i * 3;
        // A segment dragged across a rounded lip can still cut it after one push, its far end stopped on the way out.
        for (let f = 0; f < fixes; f++) {
          const mx = (X[a] + X[o]) / 2, my = (X[a + 1] + X[o + 1]) / 2, mz = (X[a + 2] + X[o + 2]) / 2, mr = (this.rad[i - 1] + this.rad[i]) / 2;
          let pen = world.collide(mx, my, mz, mr, nrm, i), dir = nrm;
          // Her skin too, where a segment spans her curves: its points sit on her, its middle sinks in.
          if (body && this.k.cutSkin) { const pb = body.collide(mx, my, mz, bodyRadius(mr, i - 0.5, k.bodySkip), nb); if (pb > pen) { pen = pb; dir = nb; } }
          if (!(pen > 0)) break;
          // Only the far end moves, twice the depth, carried there around whatever it meets: the near one has already
          // cleared, and a middle's push can point into a thin wall the end lies beyond.
          const fx = X[o], fy = X[o + 1], fz = X[o + 2];
          X[o] += 2 * pen * dir[0]; X[o + 1] += 2 * pen * dir[1]; X[o + 2] += 2 * pen * dir[2];
          travelPoint(this, i, world, body, fx, fy, fz);
          this._touched[i] = 1;
          if (i < this._hit) this._hit = i;
        }
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
    // A segment squeezed shorter than girthFloor keeps that girth: contact did the squeezing, and up to 3× its girth (the
    // rod's own floor) would swell back into whatever squeezed it.
    const g = this.k.girthFloor > 0 ? 1 / Math.sqrt(this.k.girthFloor) : Infinity;
    for (let i = 0; i < this.n; i++) {
      this.drawRad[i] = Math.min(this.drawRad[i], this.drawRad0[i] * g);
      this.rad[i] = Math.min(this.drawRad[i], this.cap);
    }
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
