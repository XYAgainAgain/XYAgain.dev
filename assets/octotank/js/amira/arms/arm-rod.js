import { ROD_KNOBS, frameQuat, jointQuat } from './arm-rod-core.js';
import { CoupledRod } from './arm-rod-coupled.js';
import { restArm, armVolume, projectPoint, travelPoint, focusChain, chainBends, bodyRadius } from './arm-core.js';
import { solidsOf, capLength, sidePush, foldTarget } from './arm-clear-core.js';

/* A rod arm's body chain: the intent Arm keeps its programs and its chain, its chain's bends set the rod's rest shape, and the
   rod, with mass, water, and contact of its own, is where the arm is; it reaches the intent only through _feedback. */

export const ROD_ARM_KNOBS = {
  ...ROD_KNOBS,
  // Relaxed tissue, root to tip alike: COOMM's 10 kPa arm times the k = 26 her muscle map scales its stresses by, so tissue
  // and muscle keep COOMM's ratio. Bracing firms it (braceGain); 1e6 with a 2× tip was the authored look's fit.
  E0: 2.6e5,
  tipStiff: 1,
  // The rod's own bend limit: the rest shape walked under it, and a one-sided spring from limitSoft of it outward.
  bendLimit: true,
  limitTip: 0.8,         // rad at the last joint, tighter than the intent's bendTip; the root and the ramp are the intent's
  limitSoft: 0.85,       // share of the limit where the spring starts; below it the wiggle sees nothing
  limitTau: 0.5,         // s that spring's stiffness takes to fade as a joint eases; it rises at once, so a joint at the soft limit can't flip it tick by tick
  limitGain: 10,         // that spring's reach: at the limit it bears this many times (limit − soft limit) of the joint's own stiffness, its slope 3× that
  limitTwist: 0.33,      // share of that spring the joint's twist takes: stiff in bend alone, a joint's twist rate ran 4–30× a free joint's and her time on her back rose
  restFollow: 0.05,      // s the rest shape takes to follow the chain's bends: its contact moves them a little every tick, and a soft rod takes each as a shove
  rest: 'chain',         // the rest shape: the intent's chain as its contact laid it, its posed bends ('bends', which can
                         // run through her body), or 'targets' (its programs' own, with the rod as their spring)
  hold: 'rod',           // whose contact bends later rest shapes: 'rod', 'ghost' (the intent chain's own), or 'off'
  stiffRef: 90,          // 1/s² of authored joint stiffness that leaves the rod's bending as is, in targets mode
  rootShare: 0.033,      // the drawn arm's root radius over the full arm's length, the front pair's too
  rootGap: 0.002,        // m a rod's collision radius keeps clear of its neighbors' roots on her crown
  intentRounds: 1,       // finishing passes a driving rod's intent chain runs, the last of the arm-on-arm rounds (0: all)
  cutFixes: 3,           // pushes the last contact round may give one segment still cutting into something
  cutSkin: true,         // and those pushes count a segment's middle sunk in her skin too
  // Segment clearance: the last round checks each whole segment against the divider and the rocks, and caps its stretch.
  clear: true,
  stretchCap: 1.9,       // of a segment's rest length, the longest contact leaves it (0: no cap)
  clearFixes: 3,         // sideways pushes one segment cutting a solid may take before it is undone
  clearTol: 0.005,       // m a segment may cut a solid past its ends and be left to the middle fixes: a graze, or a chord across a round surface
  clearMargin: 2e-4,     // m past clear each push aims
  clearSide: 0.2,        // share of the way-off direction that must lie across the segment for a push to help
  clearTMin: 0.25,       // a cut this near the root end is pushed as if this far along, so the far end never leaps
  foldMin: 0.1,          // of rest length, the shortest a segment folds to when nothing else clears it
  girthFloor: 0.8,       // stretch under which a squeezed segment stops thickening, the authored arm's stretchMin (0: no floor)
  current: true,         // the tank's currents push the rod
  braceGain: 12,         // times the passive bending and axial stiffness a fully braced stretch of arm adds on top
  reachBrace: 0.25,      // share of that bracing a reach takes on its way out (4×, the old 1e6 fit); the rest comes as it grabs
  grabTau: 0.25,         // s for the arm to firm up once it holds, grips, plants, or fetches, and to let go of it
  aim: true,             // a reach aims through the rod: its target moves until the rod's own grip point lands there
  aimTau: 0.3,           // s the aim's correction takes to catch up with the rod's miss
  aimMax: 0.08,          // m the aim may move off where the program meant
  aimPress: 0.006,       // m closer to a toy than the program's clearance a middle grip aims: aimed true, the rod would hover over it
  // Off in core; main.js turns the loads on for the bench, and the loads and the root wrench for her rod arms unless ?loads=0.
  toyPush: 'capped',     // 'rod': a toy takes the rod's own contact momentum, split by the two inverse masses; 'capped': pushN per toy
  gripLoad: false,       // what a grip holds weighs on the rod's grip nodes, a tick late
  gripMass: true,        // and the held toy's mass rides those nodes, so its inertia is the rod's own, not a late pull that rings
  gripLoadTau: 0.08,     // s that load is smoothed over
  seals: false,          // sealed suckers on the furniture, and a plant's foot, hold their node where it sealed
  toySeals: false,       // and on a loose thing, which a grip mostly holds anyway
  sealCompliance: 1e-4,  // m/N
  sealGrace: 0.15,       // s a segment's seal outlasts its suckers all flickering off at once
  sealLift: 0.04,        // m the intent chain may draw a sealed node's point off its anchor before the arm lets go there
  // Grabby suckers: a patch that takes hold recruits all its suckers, an exploring arm's seal holds a beat, the arm lets go
  // as its program moves on (judged in the arm's own frame, so her body walking off stretches it), and past popStretch it pops.
  grabby: true,
  sealBeat: 0.5,         // s mean, and its spread, an exploring arm's seal holds against beatLift times the draw
  sealBeatSd: 0.25,
  beatLift: 2,
  sealRest: 0.25,        // s a patch rests after letting go before it can take hold again
  popStretch: 1.5,       // of the arm's length from the root to a seal, past which every seal on it pops (with peel, anatomical)
  popRest: 0.6,          // s the popped patches rest
  // Grip follows intent: an arm only feeling its way seals at touch, one doing a job seals firm, sized to that job. One
  // budget per arm, shared over its seals by contact quality, limited inside the rod's solve and kept on its surface.
  grace: true,
  touchArmN: 0.3,        // N one feeling arm's seals bear between them
  adhesionShare: 0.6,    // of a seal's budget, the share that holds it on against a pull off its surface; the rest is shear
  touchCompliance: 2e-3, // m/N
  firmCompliance: 2e-3,
  firmMul: 2,            // a firm arm's budget over the force its task asks for
  firmTau: 0.25,         // s a seal whose arm goes from feeling to working takes to firm up
  slipMax: 0.02,         // m a firm seal may slide along its surface before it lets go
  touchSlipMax: 0.08,    // and a touch seal, which slides as feeling
  // Peel and emergency release (with grace): a seal lets go over a ramp, never in one tick. The arm meaning to let go peels
  // tip first; a pull past adhesion peels that seal; stretched off its holds, skidding, or flinching, it lets go fast.
  peel: true,
  peelTime: 0.2,         // s a seal takes to peel when the arm means to let go, or when pulled off past its adhesion
  peelStagger: 0.02,     // s apart, tip first, the seals of a group letting go together
  peelFast: 3,           // ticks an emergency release takes
  peelStretch: 1.35,     // unexpected strain (arc over the commanded length) from which it paces itself by the stretch rate
  popHard: 1.6,          // unexpected strain at which whatever still holds lets go at once
  // Drag relax: a firm hold being dragged off, whose job doesn't need the arm short, lengthens the span to it toward
  // dragMax at what its suckers bear, then pops; while it runs, the hold may slide dragSlipMax.
  dragRelax: true,
  dragRate: 0.5,         // per second, each segment of that span
  dragMax: 1.5,          // anatomical elongation of the span
  dragRecover: 0.3,      // per second back, once nothing drags
  dragSlipMax: 0.06,     // m
  // Grip on the floor while she travels: an unsealed node lying on an upward face loses speed along it, by velocity alone so it
  // can't fling anything. It saturates, so a stroke can still drag an arm. Weight is no use: an arm weighs about 0.04 N in water.
  grip: 30,              // 1/s; 0 turns it off
  gripMax: 0.02,         // N per node
  gripGap: 0.002,        // m over the surface a node still counts as lying on it
  gripCos: 0.7,          // a surface whose normal is this near up is a floor
  gripSoft: 0.1,         // share of its stiffness a joint on the floor keeps: its rest shape rides her, and held to it the arm skates whatever the grip does
  gripSoftTau: 0.15,     // s a joint takes to soften and firm: read tick by tick, contact's flicker would shake it
  wrench: false,         // the root's force and torque reach her body, a tick late; explicit, so at her mass it grows
  wrenchSpread: 'body',  // over all of her as a rigid body would take it, or 'patch', the arm's own
  // The shared solve (?couple=1) alone reads these.
  coupleTurn: 0.08,      // rad a carry may turn a rod onto her shell's root frame in one tick
  coupleExtra: 0,        // iterations a short coupled step may add (the lone rod's own step keeps its three)
  looseStroke: true,     // coupled, a stroke's seek and plant don't firm the arm: braced, a foot pressed for its seal levers her over
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
    this.coupled = false;                 // in the shared solve's care this tick (Arms sets it)
    this.started = false;
    this._fresh = true;
    this._first = true;
    this._resets = 0;
    this._touched = new Uint8Array(n);
    this._berth = new Float64Array(3 * n); // what berths account for in each node's correction this tick, kept off her bill
    this._hit = n;
    this._n = [0, 0, 0];
    this._q = [0, 0, 0, 1];
    this._f9 = new Float64Array(9);
    this._B = new Float64Array((n - 1) * 2);
    this._Bc = new Float64Array((n - 1) * 2);
    this._L = new Float64Array(n - 1);
    this._Ls = new Float64Array(n - 1);   // each joint's spring stiffness, fading
    this._s3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.clearStats = { capped: 0, pushed: 0, reverted: 0, folded: 0 };
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
    // Its step() is the stock Rod's, so an arm the shared solve leaves out moves exactly as a plain rod would.
    this.rod = new CoupledRod({ len: arm.len0, rad: this.drawRad0, mass: this.mass }, this.k);
    this.restGen = arm.restGen;
    this.started = false;
    this._resets = 0;
  }

  /* The rest shape from the intent chain: its posed bends, the bends of its chain as its own contact laid it, or in
     targets mode its programs' targets with each joint's authored stiffness scaling the rod's bending there. */
  _rest(dt = 0) {
    const arm = this.intent, rod = this.rod, k = this.k;
    rod.limitScale.fill(1); rod.twistScale.fill(1);
    const kind = arm.goal?.kind, stroke = this.coupled && k.looseStroke && !!arm.goal?.loco;
    const want = this.gripping || ((kind === 'hold' || kind === 'plant') && !stroke) || kind === 'fetch' ? 1 : 0;
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
      const s = this._s3, lim = k.bendLimit ? this._limits() : null;
      const fromChain = k.rest === 'chain' && arm.X.every(Number.isFinite);
      let B = fromChain ? chainBends(arm.frame, arm.twist, arm.X, this._B, this.n - 1, s[0], s[1], s[2], lim) : arm.out;
      if (lim && !fromChain) B = this._clampRest(B, lim);
      if (k.restFollow > 0 && fromChain) {
        const E = this._Be ??= Float64Array.from(B), f = !this.started ? 1 : dt > 0 ? 1 - Math.exp(-dt / k.restFollow) : 0;
        for (let a = 0; a < E.length; a++) B[a] = E[a] += (B[a] - E[a]) * f;
      } else this._Be = null;
      rod.setRestFromBends(B, arm.twist, arm.lam);
      // Soft tissue, firmed where the program braces: a braced stretch of arm is braceFactor times stiffer, a relaxed one is
      // the passive tissue (with the muscle map's own small change in muscle mode).
      const M = arm.knobs.muscle ? arm.mus : null, g = this.grab;
      for (let j = 0; j < rod.n; j++) {
        const f = braceFactor(braceShare(arm, j), g, k);
        rod.bendScale[j] = this.stiff * (M ? M.bendStiff[j] : 1) * f; rod.stretchScale[j] = (M ? M.axialStiff[j] : 1) * f;
      }
      if (k.grip > 0 && k.gripSoft < 1) this._floorJoints(dt);
      if (lim && k.limitGain > 0 && this.started) this._limitSpring(B, lim, dt);
      else this._Ls.fill(0);
    }
  }

  /* Each joint's limit this tick: the turn off her body as the intent has it, the rest on the intent's ramp up to limitTip, a fetch's raise kept. */
  _limits() {
    const arm = this.intent, k = this.k, ak = arm.knobs, S = this.n - 1, L = this._L, tip = k.limitTip;
    L[0] = arm.lim[0];
    for (let j = 1; j < S; j++) L[j] = Math.max(arm.limRaise[j] * arm.w, ak.bendBase + (tip - ak.bendBase) * Math.pow(j / Math.max(1, S - 1), ak.bendPow));
    return L;
  }

  /* Posed bends walk nothing, so they are cut to the limit joint by joint. */
  _clampRest(B, L) {
    const out = this._Bc, S = this.n - 1;
    for (let j = 0; j < S; j++) {
      const u = B[j * 2], v = B[j * 2 + 1], m = Math.sqrt(u * u + v * v), f = m > L[j] ? L[j] / m : 1;
      out[j * 2] = u * f; out[j * 2 + 1] = v * f;
    }
    return out;
  }

  /* A second spring per joint, one-sided, cubic from the soft limit and straight past the limit, folded into the rest-shape spring so both
     solves stay implicit: linearized at the live bend with its true slope, or a stiffness read a tick late chatters every joint in the band. */
  _limitSpring(B, L, dt = 0) {
    const rod = this.rod, k = this.k, q = rod.q, R = rod.rest, tw = this.intent.twist, soft = k.limitSoft, G = k.limitGain, S = this.n - 1, Ls = this._Ls, fade = k.limitTau > 0 ? (dt > 0 ? Math.exp(-dt / k.limitTau) : 1) : 0;
    for (let j = 1; j < S; j++) {
      const a = 4 * (j - 1), b = 4 * j, ax = q[a], ay = q[a + 1], az = q[a + 2], aw = q[a + 3], bx = q[b], by = q[b + 1], bz = q[b + 2], bw = q[b + 3];
      const rx = aw * bx - ax * bw - ay * bz + az * by, ry = aw * by + ax * bz - ay * bw - az * bx, rz = aw * bz - ax * by + ay * bx - az * bw, rw = aw * bw + ax * bx + ay * by + az * bz;
      const dz = 1 - 2 * (rx * rx + ry * ry), p0 = L[j] * soft;
      if (dz >= Math.cos(p0) && !(Ls[j] > 1e-3)) { Ls[j] = 0; continue; }
      const dx = 2 * (rx * rz + rw * ry), dy = 2 * (ry * rz - rw * rx), h = Math.sqrt(dx * dx + dy * dy);
      if (!(h > 1e-9)) { Ls[j] *= fade; continue; }
      const phi = Math.atan2(h, dz), w = Math.max(1e-6, L[j] - p0), u = Math.max(0, phi - p0) / w;
      // The spring's moment over the joint's stiffness, f, and the slope it's linearized with, t: never under the true slope, or the step overshoots.
      const f = u < 1 ? G * w * u * u * u : G * w * (1 + 3 * (u - 1)), t = Ls[j] = Math.max(3 * G * Math.min(1, u * u), Ls[j] * fade), target = t * phi - f;
      // jointQuat is roll, then bend: the live bend's direction read in the joint's rolled frame.
      const roll = tw[j - 1], c = Math.cos(roll), s = Math.sin(roll), eu = (dx * c + dy * s) / h, ev = (dy * c - dx * s) / h;
      jointQuat((B[j * 2] + target * eu) / (1 + t), (B[j * 2 + 1] + target * ev) / (1 + t), roll, R, 4 * j);
      rod.limitScale[j] = 1 + t; rod.twistScale[j] = 1 + k.limitTwist * t;
    }
  }

  /* After the intent arm's step: the root from its frame, the rest shape from its bends, then the rod's own step.
     ambient(x, y, z, out) is the water's velocity. */
  step(dt, ambient) {
    this.prepare(dt, ambient, false);
    this.commit();
  }

  /* step() up to the rod's own step. With join, a started rod skips that step and returns true: the shared solve
     (rod-coupler-core.js) steps it with her body, at the root frame _q built here, and commit() follows. */
  prepare(dt, ambient, join) {
    const arm = this.intent;
    this._joined = false;
    if (arm.valid === false) return false;
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
      if (join) return (this._joined = true);
      rod.setRoot(F.p, q);
      rod.step(dt, ambient);
    }
    return false;
  }

  /* The rest of step() once the rod has stepped, alone or in the shared solve. */
  commit() {
    if (this.intent.valid === false) return;
    const rod = this.rod, resets = rod.resets ?? 0;
    // Either solve starts a non-finite rod over from its rest pose.
    if (resets !== this._resets) { this._resets = resets; this._fresh = true; }
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
    this._berth.fill(0);
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
    const S = last && world && this.k.clear ? solidsOf(world) : null;
    if (last) this._late = null;
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
          if (dir === nrm && world.berthHit === true) { const b = this._berth; b[o] += 2 * pen * dir[0]; b[o + 1] += 2 * pen * dir[1]; b[o + 2] += 2 * pen * dir[2]; }
          travelPoint(this, i, world, body, fx, fy, fz);
          this._touched[i] = 1;
          if (i < this._hit) this._hit = i;
        }
      }
    }
    if (S) this._clear(world, body, S);
    Q.set(X);
    this._fresh = false;
    this._first = false;
  }

  /* The last round's word on the bounded solids, root to tip: a segment cutting one is pushed off across itself toward where it
     lay last tick, else put back there, else folded in beside its neighbor; then the stretch cap, along a segment now clear. */
  _clear(world, body, S) {
    this._late = S;
    for (let i = 1; i < this.n; i++) this._clearSeg(i, world, body, S);
  }

  /* Segment i (nodes i − 1 to i) cleared of the bounded solids S, then capped along its now-clear line. */
  _clearSeg(i, world, body, S) {
    const X = this.X, P = this.started ? this.P : null, k = this.k, l0 = this.intent.len0, st = this.clearStats;
    const nrm = this._cn ??= [0, 0, 0], tmp = this._ct ??= [0, 0, 0], tgt = this._cg ??= [0, 0, 0];
    const fixes = Math.max(0, Math.round(k.clearFixes) || 0), tol = k.clearTol > 0 ? k.clearTol : 0;
    const a = 3 * (i - 1), o = 3 * i, ra = this.rad[i - 1], rb = this.rad[i];
    const max = k.stretchCap > 0 ? k.stretchCap * l0[i - 1] : Infinity, reach = Number.isFinite(max) ? max : 2 * l0[i - 1];
    let cut = this._cut(S, a, o, ra, rb, nrm);
    if (cut > tol) {
      this._touched[i] = 1;
      if (i < this._hit) this._hit = i;
      for (let f = 0; f < fixes && cut > tol; f++) {
        if (!sidePush(S, X, a, o, ra, rb, P, cut, nrm, k, reach, tmp, tgt)) break;
        this._moveTo(i, world, body, tgt[0], tgt[1], tgt[2]);
        cut = this._cut(S, a, o, ra, rb, nrm);
        st.pushed++;
      }
      if (cut > tol && P) {
        X[o] = P[o]; X[o + 1] = P[o + 1]; X[o + 2] = P[o + 2];
        projectPoint(this, i, world, body);
        cut = this._cut(S, a, o, ra, rb, nrm);
        if (cut > tol) {
          this._moveTo(i, world, body, P[o] + X[a] - P[a], P[o + 1] + X[a + 1] - P[a + 1], P[o + 2] + X[a + 2] - P[a + 2]);
          cut = this._cut(S, a, o, ra, rb, nrm);
        }
        if (!(cut > tol)) st.reverted++;
      }
      // Last, the free ball beside its neighbor: always clear, though a node threaded past a wall comes back through it.
      if (cut > tol) {
        foldTarget(S, X, a, o, Math.max(ra, rb), Math.max(0, k.foldMin) * l0[i - 1], reach, tgt);
        X[o] = tgt[0]; X[o + 1] = tgt[1]; X[o + 2] = tgt[2];
        projectPoint(this, i, world, body);
        st.folded++;
      }
    }
    if (capLength(X, a, o, max)) st.capped++;
  }

  /* Settle's word after a toy's push moved nodes since the last round: each moved node out of the solids, then every segment
     it touches cleared and capped the same way, the furniture alone, so the push's share into the toy stands. */
  _clearLate() {
    const X = this.X, Q = this.Q, S = this._late, l0 = this.intent.len0, cap = this.k.stretchCap > 0 ? this.k.stretchCap : Infinity;
    this._late = null;
    if (!S) {
      for (let i = 1; i < this.n; i++) if (capLength(X, 3 * (i - 1), 3 * i, cap * l0[i - 1])) this.clearStats.capped++;
      return;
    }
    // Another arm's contact may have left a focus on the solids; these nodes need all of them.
    let unfocused = false;
    for (let i = 1; i < this.n; i++) {
      const a = 3 * (i - 1), o = 3 * i;
      const movedA = X[a] !== Q[a] || X[a + 1] !== Q[a + 1] || X[a + 2] !== Q[a + 2];
      const movedO = X[o] !== Q[o] || X[o + 1] !== Q[o + 1] || X[o + 2] !== Q[o + 2];
      if (!movedA && !movedO) { if (capLength(X, a, o, cap * l0[i - 1])) this.clearStats.capped++; continue; }
      if (!unfocused) { S.unfocus?.(); unfocused = true; }
      // Only out of a bounded solid it sank in: the floor and the glass are point contact's, and a push off them here buzzed.
      if (movedO && S.gap(X[o], X[o + 1], X[o + 2], this.rad[i]) < this.rad[i] - this.k.clearTol) projectPoint(this, i, S, null);
      this._clearSeg(i, S, null, S);
    }
  }

  /* How far segment a–o cuts the bounded solids past its own ends. */
  _cut(S, a, o, ra, rb, out) {
    const X = this.X;
    return S.cut(X[a], X[a + 1], X[a + 2], X[o], X[o + 1], X[o + 2], ra, rb, out);
  }

  /* Point i carried to (x, y, z) around whatever it meets on the way. */
  _moveTo(i, world, body, x, y, z) {
    const X = this.X, o = 3 * i, fx = X[o], fy = X[o + 1], fz = X[o + 2];
    X[o] = x; X[o + 1] = y; X[o + 2] = z;
    travelPoint(this, i, world, body, fx, fy, fz);
  }

  /* After the last round: what contact moved, the rod keeps as velocity (a point pushed out of a rock must not keep
     its inward speed, or it goes back in); then the frames turn onto the corrected segments. her (a joined rod's, from
     Arms): her body, center, velocity and spin, mass, inverse inertia, and the push P and turn L she takes back. */
  settle(dt, her = null) {
    if (this.intent.valid === false) return;
    const rod = this.rod, X = this.X, x = rod.x, n = this.n, h = this._placed ? 0 : dt, joined = this._joined, nb = this._nb ??= [0, 0, 0];
    // A toy's push since the last round can stretch a segment or swing it into a solid; clearance and the cap have the last word.
    if (this.k.clear) this._clearLate();
    for (let i = 1; i < n; i++) {
      const o = i * 3, dx = X[o] - x[o], dy = X[o + 1] - x[o + 1], dz = X[o + 2] - x[o + 2];
      if (dx === 0 && dy === 0 && dz === 0) continue;
      // A node pushed out of her own skin pushes her back, or every arm resting on her would shove her along. Only the push
      // along her skin's normal, as deep as the node sat in her, is hers: the rest is the floor's, a rock's, or a berth's.
      const pen = joined && her ? her.body.collide(x[o], x[o + 1], x[o + 2], bodyRadius(this.rad[i], i, this.knobs.bodySkip), nb) : 0;
      const B = this._berth, s = pen > 0 ? Math.min(pen, dx * nb[0] + dy * nb[1] + dz * nb[2] - Math.max(0, B[o] * nb[0] + B[o + 1] * nb[1] + B[o + 2] * nb[2])) : 0;
      if (s > 0) {
        const c = her.c, rx = x[o] - c[0], ry = x[o + 1] - c[1], rz = x[o + 2] - c[2], w = her.w, v = her.v, nx = nb[0], ny = nb[1], nz = nb[2];
        const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx, I = her.Ii;
        const extra = 1 / her.M + cx * (I[0] * cx + I[1] * cy + I[2] * cz) + cy * (I[3] * cx + I[4] * cy + I[5] * cz) + cz * (I[6] * cx + I[7] * cy + I[8] * cz);
        const j = rod.pushOutOn(i, nx * s, ny * s, nz * s, h, v[0] + w[1] * rz - w[2] * ry, v[1] + w[2] * rx - w[0] * rz, v[2] + w[0] * ry - w[1] * rx, extra);
        if (j > 0) {
          her.P[0] -= nx * j; her.P[1] -= ny * j; her.P[2] -= nz * j; her.L[0] -= cx * j; her.L[1] -= cy * j; her.L[2] -= cz * j;
          // The next contact, on any rod, meets her as this one left her: against a frozen her, many at once over-push.
          const iM = j / her.M;
          v[0] -= nx * iM; v[1] -= ny * iM; v[2] -= nz * iM;
          w[0] -= (I[0] * cx + I[1] * cy + I[2] * cz) * j; w[1] -= (I[3] * cx + I[4] * cy + I[5] * cz) * j; w[2] -= (I[6] * cx + I[7] * cy + I[8] * cz) * j;
        }
        const qx = dx - nx * s, qy = dy - ny * s, qz = dz - nz * s;
        if (qx * qx + qy * qy + qz * qz > 1e-12) rod.pushOut(i, qx, qy, qz, h);
      }
      // Coupled, the push-out only stops the node's closing speed, along the push through its own inverse mass: any more,
      // or any sideways, would reach her through the solve as a fling or a drift.
      else if (joined) rod.pushOut(i, dx, dy, dz, h);
      else rod.displace(i, dx, dy, dz, h);
    }
    rod.alignFrames();
    X.set(x);
    this.Q.set(X);
    this._radii();
    this._frames();
  }

  _floorJoints(dt) {
    const rod = this.rod, k = this.k, G = this._gs ??= new Float64Array(rod.n).fill(1), f = dt > 0 ? 1 - Math.exp(-dt / Math.max(1e-3, k.gripSoftTau)) : 0;
    if (!this.started) { G.fill(1); return; }
    for (let j = 1; j < rod.n; j++) {
      G[j] += ((rod.gripRate[j] > 0 ? k.gripSoft : 1) - G[j]) * f;
      rod.bendScale[j] *= G[j];
    }
  }

  /* After settle: which nodes lie on the floor for the next tick's solve; sdf is the furniture alone, so a toy or another arm never grips. */
  floorGrip(sdf, on = true) {
    const k = this.k, rod = this.rod, X = this.X, g = on && k.grip > 0 ? k.grip : 0, nrm = this._n, gap = k.gripGap;
    let live = false;
    if (g > 0) for (let i = 1; i < this.n; i++) {
      const o = i * 3, lies = sdf.collide(X[o], X[o + 1], X[o + 2], this.rad[i] + gap, nrm) > 0 && nrm[1] >= k.gripCos;
      rod.gripRate[i] = lies ? g : 0;
      if (!lies) continue;
      live = true;
      rod.gripMax[i] = k.gripMax; rod.gripN[o] = nrm[0]; rod.gripN[o + 1] = nrm[1]; rod.gripN[o + 2] = nrm[2];
    }
    else rod.gripRate.fill(0);
    rod._gLive = live;
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
  reset() { this.started = false; this.rod.gripRate.fill(0); this.rod._gLive = false; }

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
