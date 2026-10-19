import { LAYERS } from '../config.js';
import { Arm, ARM_KNOBS as CORE_KNOBS, makeSdfWorld, makeArmContact, separateArms, ShellBody, BodyEllipsoid, bodyRadius, facing, mulberry32 } from './arm-core.js';
import { SUCKER_KNOBS, layoutSuckers, SuckerBank, tasteRule, sampleHold, whoMoves, tasteSalience, Familiarity, SEAL_NONE, SEAL_WORK, SEAL_HARD } from './sucker-core.js';

/* Eight arm programs (arm-core.js) driving a kinematic Jolt capsule per segment. Each tick: root frames, programs and
   contact, arm-on-arm rounds, the suckers (touch, taste, flicker, grips), then the capsules follow the solved chains. */

export const ARM_KNOBS = {
  ...CORE_KNOBS,
  collider: 'sdf',       // 'sdf' (JS distance over the layout's statics) or 'jolt' (a sphere query per probe)
  mouthDrop: 0.01,       // m below the crown ring's center where a fetch delivers
  toyStandoff: 0.6,      // a tip grip aims this fraction of the toy's size short of its center, so the tip touches it
  capsuleStep: 0.05,     // stretch between the capsule sizes a segment can switch to
  slotGap: 0.004,        // m between arms laid side by side over one toy
  toyClear: 0.004,       // m a middle-of-the-arm contact sits over a toy's surface
  looseContact: true,    // arms lie over toys instead of passing into them (and flinging them, being kinematic)
  pushN: 2,              // N an arm can push a loose thing with; Jolt's own arm capsules skip toys unless armsHitToys is on
  breakMargin: 1,        // a grip tears once its pull passes this many times what its sealed suckers bear
  breakSmooth: 0.5,      // weight of the newest reading in the grip's force average
  breakGrace: 2,         // ticks after a grip forms before it can tear; any longer and a dragged toy is crushed into the floor
  capTau: 0.2,           // s the sealed force a tear is judged against is averaged over, as seals flicker
  gripSkip: 2,           // segments either side of a grip's that may lie into the toy it holds
  gripTau: 0.1,          // s the proxy smooths the grip point over, so the toy follows the arm and not its contact jitter
  minGrip: 0.05,         // N of sealed force under which a grip has nothing left holding it
  lostGrace: 0.3,        // s an arm's interest survives without touching the thing, or a grip without a seal
  fetchBeat: 0.25,       // s between food sealing on and the fetch starting
  fetchClear: 1,         // a fetch with food stops this many of the food's sizes short of her mouth
  rejectPush: 0.15,      // m/s a rejected thing leaves the tip with
  bodyMass: 1,           // kg, her whole weight, for whoMoves's tiebreak
};

const WINDOW = 1800;

export class Arms {
  constructor(phys, mantle, knobs = {}, { seed = 1 } = {}) {
    this.phys = phys;
    this.mantle = mantle;
    this.knobs = { ...ARM_KNOBS, ...knobs };
    const count = mantle.roots.length;
    this.arms = Array.from({ length: count }, (_, i) => new Arm(i, this.knobs, seed));
    this.track = new Array(count).fill(null);
    this.slot = new Float64Array(count);   // m across a shared toy, so arms going for one thing lie side by side
    this.slotDir = new Float64Array(count * 2);
    // The squeeze test sets this to a world point; every arm aims at it until it is cleared.
    this.lead = null;
    this.contact = makeArmContact(this.arms);
    // Deep in her, past the skin samples' reach, her own fitted body field answers; the ellipsoid if she has none.
    const fit = mantle.fieldFit;
    const core = fit ? { fit: () => fit.prepare(mantle.positions, mantle.shell.count, mantle.origin), distance: (x, y, z) => fit.distance(x, y, z), normal: (out) => fit.normal(out) } : new BodyEllipsoid();
    this.body = new ShellBody(mantle.shell.count, mantle.rest.reduce((a, b) => a + b, 0) / mantle.rest.length, core);
    this.rootsW = new Float64Array(count * 3);
    this.rootsN = new Float64Array(count * 3);
    this.rootsT = new Float64Array(count * 3);
    this.views = Array.from({ length: count }, (_, r) => [this.rootsW, this.rootsN, this.rootsT].map((A) => A.subarray(r * 3, r * 3 + 3)));
    this._rf = { p: [0, 0, 0], n: [0, 0, 0], t: [0, 0, 0] };
    this._c = [0, 0, 0]; this._o = [0, 0, 0]; this._q = [0, 0, 0, 1]; this._mouth = [0, 0, 0];
    this.shapes = new Map();
    this.msBuf = new Float32Array(WINDOW);
    this.msCount = 0;
    this.ms = 0;
    this._resting = false;
    this.time = 0;
    this._buildWorld();
    this._build();
    this._initSuckers(seed);
    this.tick(0, 0, true);
  }

  _initSuckers(seed) {
    const count = this.arms.length, S = this.S = this.arms[0].n - 1, NS = count * S;
    const sk = this.suckerKnobs = { ...SUCKER_KNOBS };
    this.layouts = this.arms.map((arm, a) => layoutSuckers(arm.len0, arm.rad0, arm.arc0, a, sk));
    this._layoutGen = this.arms.map((arm) => arm.restGen);
    this.banks = this.layouts.map((L, a) => new SuckerBank(L, a, sk, seed));
    this.epRng = this.arms.map((_, a) => mulberry32(((seed * 3266489917) ^ ((a + 1) * 0x27D4EB2F) ^ 0x7A57E) >>> 0));
    this.touchKind = new Uint8Array(NS);   // per segment: 0 nothing, 1 the furniture, 2 a loose thing, 3 herself
    this.touchTaste = new Array(NS).fill(null);
    this.touchEntry = new Array(NS).fill(null);
    this.touchP = new Float64Array(NS * 3); // the touched surface point, and its outward normal
    this.touchN = new Float64Array(NS * 3);
    this.refr = new Float64Array(NS);       // time until which a patch that just let go can't seal
    this.slide = new Float64Array(NS * 3);  // each touching patch's averaged sliding velocity
    this.slideAt = new Int32Array(NS).fill(-2);
    this._tickNo = 0;
    this._mode = new Uint8Array(S);
    this._scale = new Float64Array(S);
    this.episodes = new Array(count).fill(null);
    this.ignore = this.arms.map(() => new Map());
    this.proxies = this.arms.map(() => this.phys.addProxy([0, -0.5, 0]));
    this.fetchStand = new Float64Array(count);
    this.gripPos = new Float64Array(count * 3);
    this.reaction = new Float64Array(count * 3);   // N her arm feels from what it grips, last step
    this.anchorForce = new Float64Array(count);    // N its suckers sealed on the furniture bear before tearing
    this.anchorList = this.arms.map(() => []);
    this.anchorCount = new Int32Array(count);
    // The brain's override: with it off, no sucker ever seals on her own skin or arms.
    this.gripSelf = false;
    this.counts = { selfTouch: 0, selfSealed: 0, grips: 0, breaks: 0, release: 0, moveOn: 0, reject: 0, lapse: 0, fetches: 0, pushes: 0, pushMaxN: 0 };
    this.pushPen = new Float64Array(count * this.loose.length);
    this.pushNP = new Float64Array(count * this.loose.length * 6);
    this._rec = -1;
    // What every arm tastes: this tick's touches (one per arm per thing), and the touches that just began, for the brain.
    this.tastes = [];
    this.tasteLog = [];
    this.tasteSeq = 0;
    this.lastTaste = null;
    this.familiar = new Familiarity(sk);
    this._tasting = this.arms.map(() => new Map());
    this._f3 = [0, 0, 0]; this._v3 = [0, 0, 0]; this._p3 = [0, 0, 0];
    this._fr = { m: [0, 0, 0], e1: [0, 0, 0], e2: [0, 0, 0], e3: [0, 0, 0] };
  }

  /* Resting arms curl in toward their suckers; awake ones bend every which way. The brain will set this. */
  get resting() { return this._resting; }
  set resting(v) { this._resting = !!v; for (const a of this.arms) a.resting = this._resting; }

  /* The static furniture as signed-distance primitives, read once from the bodies Jolt already holds. The tank's
     walls become half-spaces on their inner faces: an arm segment is longer than a wall is half thick. */
  _buildWorld() {
    const prims = [], mid = [0, 0, 0];
    this.primEntry = [];
    const walls = this.phys.rigid.filter((e) => e.tag === 'wall');
    for (const e of walls) for (let a = 0; a < 3; a++) mid[a] += e.pos[a] / walls.length;
    for (const e of this.phys.rigid) {
      if (e.tag !== 'wall' && e.tag !== 'panel' && e.tag !== 'rock') continue;
      const q = this.phys.rotationOf(e);
      if (e.tag === 'wall' && e.kind === 'box') {
        const a = e.size.indexOf(Math.min(...e.size)), side = Math.sign(e.pos[a] - mid[a]) || 1;
        const n = [0, 0, 0];
        n[a] = -side;
        prims.push({ type: 'plane', n, d: e.size[a] - side * e.pos[a] });
      } else if (e.kind === 'box') prims.push({ type: 'box', c: e.pos, h: e.size, q });
      else if (e.kind === 'sphere') prims.push({ type: 'sphere', c: e.pos, r: e.size[0] });
      else if (e.kind === 'capsule') prims.push({ type: 'capsule', c: e.pos, hh: e.size[0], r: e.size[1], q });
      else continue;
      this.primEntry.push(e);
    }
    // Loose things go in after the furniture, posed from Jolt each tick: an arm lies over a toy rather than through it.
    // `sdf` (the furniture alone) is what health() measures against.
    this.loose = this.phys.rigid.filter((e) => e.tag === 'toy');
    const lp = this.loose.map((e) => (e.kind === 'box' ? { type: 'box', h: e.size } : e.kind === 'sphere' ? { type: 'sphere', r: e.size[0] } : { type: 'capsule', hh: e.size[0], r: e.size[1] }));
    this.sdf = makeSdfWorld(prims);
    const all = this.allSdf = makeSdfWorld(prims.concat(lp), { fixed: prims.length });
    this._looseAt = prims.length;
    const phys = this.phys, knobs = this.knobs, sdf = this.sdf;
    this.world = {
      collide: (x, y, z, r, out, pt) => {
        if (knobs.collider !== 'jolt') {
          const w = knobs.looseContact ? all : sdf, pen = w.collide(x, y, z, r, out, pt);
          // The arm yields to a loose thing over a few ticks rather than being thrown out of it in one.
          this.world.loose = pen > 0 && w === all && all.hit >= this._looseAt;
          // How far the arm meant to go into a loose thing is how hard it pushes it, once the solve is done.
          if (pen > 0 && this._rec >= 0 && w === all && all.hit >= this._looseAt) this._recordPush(all.hit - this._looseAt, pen, out, x, y, z, r);
          return pen;
        }
        const a = phys.collideStaticSphere(x, y, z, r, out);
        this.world.loose = false;
        return a > 0 ? a : 0;
      },
      distance: sdf.distance,
      focus: (lo, hi) => { if (knobs.collider !== 'jolt') (knobs.looseContact ? all : sdf).focus(lo, hi); },
      unfocus: () => { all.unfocus(); sdf.unfocus(); },
    };
  }

  _poseLoose() {
    const c = this._c, q = this._q;
    for (let i = 0; i < this.loose.length; i++) {
      const b = this.loose[i].body, p = b.GetPosition(), r = b.GetRotation();
      c[0] = p.GetX(); c[1] = p.GetY(); c[2] = p.GetZ();
      q[0] = r.GetX(); q[1] = r.GetY(); q[2] = r.GetZ(); q[3] = r.GetW();
      this.allSdf.move(this._looseAt + i, c, q);
    }
  }

  _build() {
    this.chains = [];
    for (const arm of this.arms) {
      const segs = [];
      for (let s = 0; s < arm.n - 1; s++) {
        const r = (arm.rad0[s] + arm.rad0[s + 1]) / 2;
        const e = this.phys.addRigid('capsule', [arm.len0[s] / 2, r], [0, -1, 0], { motion: 'kinematic', layer: LAYERS.ARMS, friction: 0.8 });
        e.tag = 'arm';
        // The render mesh is built once from `size`; `scale` is how far the live capsule has grown from it.
        e.scale = [1, 1];
        e.bin = this._bin(1);
        e.gen = arm.restGen;
        segs.push(e);
      }
      this.chains.push(segs);
    }
  }

  _bin(lam) { return Math.round((lam - this.knobs.stretchMin) / this.knobs.capsuleStep); }

  /* A capsule sized for segment s of arm a at stretch bin b, made once and kept (Jolt capsules can't scale unevenly). */
  _shape(a, s, b, arm) {
    const key = ((a * 64 + s) * 64 + b) * 1024 + (arm.restGen & 1023);
    let sh = this.shapes.get(key);
    if (!sh) {
      const lam = this.knobs.stretchMin + b * this.knobs.capsuleStep;
      const r = (arm.rad0[s] + arm.rad0[s + 1]) / 2 / Math.sqrt(lam);
      sh = new this.phys.Jolt.CapsuleShape(Math.max(1e-4, arm.len0[s] * lam / 2), r, null);
      sh.AddRef();
      this.shapes.set(key, sh);
    }
    return sh;
  }

  /* Root frames for every arm: the mantle's own when it offers one, else outward from the centroid. */
  _frames() {
    const m = this.mantle, c = m.centroid(this._c), R = this.rootsW, N = this.rootsN, T = this.rootsT, rf = this._rf, o = this._o;
    const count = this.arms.length, own = typeof m.rootFrame === 'function';
    let ox = 0, oy = 0, oz = 0;
    for (let r = 0; r < count; r++) {
      const p = rf.p, n = rf.n, t = rf.t;
      if (own) m.rootFrame(r, rf);
      else {
        m.rootWorld(r, p);
        n[0] = p[0] - c[0]; n[1] = p[1] - c[1]; n[2] = p[2] - c[2];
        const nl = Math.hypot(n[0], n[1], n[2]);
        if (nl > 1e-9) { n[0] /= nl; n[1] /= nl; n[2] /= nl; } else { n[0] = 0; n[1] = -1; n[2] = 0; }
        // Tangent from a fixed reference, not the drifting centroid, so the frame cannot spin from tick to tick.
        let tx = n[2], ty = 0, tz = -n[0];
        if (Math.hypot(tx, tz) < 0.2) { tx = 0; ty = -n[2]; tz = n[1]; }
        const tl = Math.hypot(tx, ty, tz) || 1;
        t[0] = tx / tl; t[1] = ty / tl; t[2] = tz / tl;
      }
      for (let i = 0; i < 3; i++) { R[r * 3 + i] = p[i]; N[r * 3 + i] = n[i]; T[r * 3 + i] = t[i]; }
      ox += p[0]; oy += p[1]; oz += p[2];
    }
    // The sucker side faces out of her underside: the ring's own normal, else centroid toward the ring's center.
    const ring = typeof m.ring === 'function' ? m.ring() : null;
    if (ring) { o[0] = ring.down[0]; o[1] = ring.down[1]; o[2] = ring.down[2]; }
    else { o[0] = ox / count - c[0]; o[1] = oy / count - c[1]; o[2] = oz / count - c[2]; }
    const ol = Math.hypot(o[0], o[1], o[2]);
    if (ol > 1e-6) { o[0] /= ol; o[1] /= ol; o[2] /= ol; } else { o[0] = 0; o[1] = -1; o[2] = 0; }
    const M = this._mouth, k = this.knobs;
    M[0] = ox / count + o[0] * k.mouthDrop; M[1] = oy / count + o[1] * k.mouthDrop; M[2] = oz / count + o[2] * k.mouthDrop;
    const V = this.views;
    for (let r = 0; r < count; r++) this.arms[r].setFrame(V[r][0], V[r][1], V[r][2], o);
  }

  tick(dt, time, teleport = false) {
    const t0 = performance.now();
    const k = this.knobs, m = this.mantle, arms = this.arms;
    if (dt > 0) { this.time += dt; this._readGrips(); }
    this.pushPen.fill(0);
    this._frames();
    this._poseLoose();
    this.body.fit(m.positions, m.shell.faces, m.shell.count, m.origin, this.rootsW, k.bodyScale);
    this._slots();
    for (let a = 0; a < arms.length; a++) {
      const arm = arms[a];
      arm.setLead(this.lead);
      const g = arm.goal;
      if (!g || g.kind === 'lead') this.track[a] = null;
      else if (g.kind === 'fetch') {
        const o = this._o, st = this.fetchStand[a];
        g.target[0] = this._mouth[0] + o[0] * st; g.target[1] = this._mouth[1] + o[1] * st; g.target[2] = this._mouth[2] + o[2] * st;
      }
      // Followed while the bend travels, then held: an arm that kept chasing a toy it was shoving would carry it off. Its
      // suckers keep turning toward the toy either way.
      else if (this.track[a]) {
        if (g.kind === 'reach') this._toyTarget(a, this.track[a], g.target);
        const p = this.track[a].body.GetPosition();
        if (g.face) { g.face[0] = p.GetX(); g.face[1] = p.GetY(); g.face[2] = p.GetZ(); }
      }
      this._rec = a; this._skipHeld(a);
      arm.step(dt, this.world, this.body);
    }
    // Rounds of arm-on-arm contact, then each arm's lengths, limits, and world contact, which get the last word. The
    // last round records which side of each other the arms lie on.
    const C = this.contact, rounds = Math.max(1, k.finishIters);
    C.tick++;
    C.touchGap = this.suckerKnobs.touchGap; C.faceCos = this.suckerKnobs.faceCos;
    for (let it = 0; it < rounds; it++) {
      separateArms(arms, k, C, it === rounds - 1 ? 1 : 0);
      for (let a = 0; a < arms.length; a++) { this._rec = a; this._skipHeld(a); arms[a].finishPass(this.world, this.body, it === rounds - 1); }
    }
    this._rec = -1;
    this.allSdf.skip = -1;
    if (dt > 0) { this._touches(); this._taste(dt); this._suckers(dt); }
    this._place(dt, teleport);
    if (dt > 0) { this._moveProxies(dt); this._pushToys(dt); }
    this.ms = performance.now() - t0;
    if (!teleport) this.msBuf[this.msCount++ % WINDOW] = this.ms;
  }

  /* Arms tracking the same toy get places across it in the order their roots sit around it. */
  _slots() {
    const T = this.track, arms = this.arms, k = this.knobs, c = this._c;
    this.slot.fill(0);
    for (let a = 0; a < arms.length; a++) {
      const toy = T[a];
      if (!toy || arms[a].goal?.tip) continue;
      let first = true;
      for (let b = 0; b < a; b++) if (T[b] === toy && !arms[b].goal?.tip) first = false;
      if (!first) continue;
      const group = [];
      for (let b = a; b < arms.length; b++) if (T[b] === toy && !arms[b].goal?.tip) group.push(b);
      if (group.length < 2) continue;
      const p = toy.body.GetPosition(), x = p.GetX(), z = p.GetZ();
      // Across is perpendicular to the toy-to-her line, flat; each arm's root says which side of that line it is on.
      this.mantle.centroid(c);
      let ax = -(c[2] - z), az = c[0] - x;
      const al = Math.hypot(ax, az) || 1;
      ax /= al; az /= al;
      group.sort((m, n) => ((arms[m].frame.p[0] - x) * ax + (arms[m].frame.p[2] - z) * az) - ((arms[n].frame.p[0] - x) * ax + (arms[n].frame.p[2] - z) * az));
      let width = 0;
      for (const b of group) width += 2 * arms[b].rad[arms[b].gripAt] + k.slotGap;
      let at = -width / 2;
      for (const b of group) { const w = 2 * arms[b].rad[arms[b].gripAt] + k.slotGap; this.slot[b] = at + w / 2; at += w; }
      for (const b of group) { this.slotDir[b * 2] = ax; this.slotDir[b * 2 + 1] = az; }
    }
  }

  _place(dt, teleport) {
    const q = this._q, J = this.phys.Jolt, bodies = this.phys.bodies, step = this.knobs.capsuleStep;
    for (let a = 0; a < this.arms.length; a++) {
      const arm = this.arms[a], X = arm.X, segs = this.chains[a];
      for (let s = 0; s < segs.length; s++) {
        const seg = segs[s];
        let dx = X[s * 3 + 3] - X[s * 3], dy = X[s * 3 + 4] - X[s * 3 + 1], dz = X[s * 3 + 5] - X[s * 3 + 2];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l > 1e-9) { dx /= l; dy /= l; dz /= l; } else { dx = 0; dy = 1; dz = 0; }
        const cx = (X[s * 3] + X[s * 3 + 3]) / 2, cy = (X[s * 3 + 1] + X[s * 3 + 4]) / 2, cz = (X[s * 3 + 2] + X[s * 3 + 5]) / 2;
        if (!Number.isFinite(cx + cy + cz)) continue;
        // A new size only once the stretch has moved well past the current bin, so a segment never flickers between two.
        const lam = arm.lam[s], b = this._bin(lam);
        if (seg.gen !== arm.restGen || (b !== seg.bin && Math.abs(lam - (this.knobs.stretchMin + seg.bin * step)) > 0.6 * step)) {
          const rl = this.knobs.stretchMin + b * step;
          bodies.SetShape(seg.id, this._shape(a, s, b, arm), false, J.EActivation_Activate);
          seg.bin = b; seg.gen = arm.restGen;
          const r0 = seg.size[1], h0 = seg.size[0], r = (arm.rad0[s] + arm.rad0[s + 1]) / 2 / Math.sqrt(rl);
          seg.scale[0] = r / r0; seg.scale[1] = (arm.len0[s] * rl / 2 + r) / (h0 + r0);
        }
        quatFromY(dx, dy, dz, q, 0);
        if (teleport || !(dt > 0)) this.phys.teleport(seg, cx, cy, cz, q[0], q[1], q[2], q[3]);
        else this.phys.moveKinematic(seg, cx, cy, cz, q[0], q[1], q[2], q[3], dt);
      }
    }
  }

  /* Where a reach for a toy aims: its near top, so the middle of the arm lies over it; a tip grip aims at its near
     side, so the tip arrives touching it rather than inside it. */
  _toyTarget(a, toy, out) {
    const arm = this.arms[a], p = toy.body.GetPosition(), root = arm.frame.p;
    const x = p.GetX(), y = p.GetY(), z = p.GetZ();
    const sz = toy.size, size = toy.kind === 'sphere' ? sz[0] : toy.kind === 'box' ? Math.min(sz[0], sz[1], sz[2]) : sz[1];
    let dx = root[0] - x, dy = root[1] - y, dz = root[2] - z;
    if (arm.goal?.tip) {
      const l = Math.hypot(dx, dy, dz);
      const off = l > 1e-6 ? (size * this.knobs.toyStandoff + arm.rad[arm.n - 1]) / l : 0;
      out[0] = x + dx * off; out[1] = y + dy * off; out[2] = z + dz * off;
      return out;
    }
    const fl = Math.hypot(dx, dz), ci = arm.gripAt;
    const ux = fl > 1e-6 ? 0.5 * dx / fl : 0, uz = fl > 1e-6 ? 0.5 * dz / fl : 0, ul = Math.hypot(ux, 1, uz);
    const off = (size + arm.rad[ci] + this.knobs.toyClear) / ul, sl = this.slot[a];
    out[0] = x + ux * off + this.slotDir[a * 2] * sl; out[1] = y + off; out[2] = z + uz * off + this.slotDir[a * 2 + 1] * sl;
    return out;
  }

  reach(i, target, opts) {
    const arm = this.arms[i];
    if (!arm || !arm.reach(target, opts)) return false;
    this.track[i] = null;
    return true;
  }

  reachAll(target, opts) { for (let i = 0; i < this.arms.length; i++) this.reach(i, target, opts); }

  reachToy(i, toy, opts) {
    const arm = this.arms[i];
    if (!arm || !toy) return false;
    // The goal decides tip or middle, and the target depends on which, so place it once the goal exists.
    const p = toy.body.GetPosition(), face = [p.GetX(), p.GetY(), p.GetZ()];
    if (!arm.reach(this._toyTarget(i, toy, [0, 0, 0]), { face, ...opts })) return false;
    this._toyTarget(i, toy, arm.goal.target);
    this.track[i] = toy;
    return true;
  }

  /* Every free arm reaches for the toy nearest its own root, following it while the bend travels, then holding. */
  reachNearestToys(toys, opts) {
    let sent = 0;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (arm.busy || !toys.length) continue;
      let best = null, bd = Infinity;
      for (const t of toys) {
        const p = t.body.GetPosition();
        const d = Math.hypot(p.GetX() - arm.frame.p[0], p.GetY() - arm.frame.p[1], p.GetZ() - arm.frame.p[2]);
        if (d < bd) { bd = d; best = t; }
      }
      if (best && this.reachToy(i, best, opts)) sent++;
    }
    return sent;
  }

  /* Bring arm i's grasp to her mouth; opts.grasp is where along the arm it holds (default: where it last touched). */
  fetch(i, opts) {
    const arm = this.arms[i];
    if (!arm || !arm.fetch(this._mouth, opts)) return false;
    this.track[i] = null;
    this.fetchStand[i] = 0;
    return true;
  }

  /* Every arm holding something after a reach fetches it. */
  fetchHolding(opts) {
    let sent = 0;
    for (let i = 0; i < this.arms.length; i++) if (this.arms[i].goal?.kind === 'hold' && this.fetch(i, opts)) sent++;
    return sent;
  }

  idle() { for (let i = 0; i < this.arms.length; i++) { this.track[i] = null; this.arms[i].idle(); } }

  /* NaN, contact, length, and bend, measured on the solved chains against the layout's own distance field. */
  health() {
    // The root rides a shell vertex and inherits the mantle's own contact, so it is measured on its own.
    const out = {
      nan: 0, penetration: 0, rootPenetration: 0, centerPenetration: 0, bodyPenetration: 0, bodyMidPenetration: 0, lenErr: 0, bend: 0, bendOver: -Infinity,
      stretchMax: 0, stretchMin: Infinity, twistMax: 0, armPenetration: separateArms(this.arms, this.knobs, this.contact, 2), crossings: this.contact.crossings, ms: this.stats(),
    };
    const nrm = [0, 0, 0], sdf = this.sdf, k = this.knobs;
    sdf.unfocus();
    for (const arm of this.arms) {
      const h = arm.health(), X = arm.X;
      out.nan += h.nan; out.lenErr = Math.max(out.lenErr, h.lenErr); out.bend = Math.max(out.bend, h.bend); out.bendOver = Math.max(out.bendOver, h.bendOver);
      out.stretchMax = Math.max(out.stretchMax, h.stretchMax); out.stretchMin = Math.min(out.stretchMin, h.stretchMin); out.twistMax = Math.max(out.twistMax, h.twistMax);
      for (let i = 0; i < arm.n; i++) {
        const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2], r = arm.rad[i];
        const pen = sdf.collide(x, y, z, r, nrm);
        if (i === 0) out.rootPenetration = Math.max(out.rootPenetration, pen);
        else out.penetration = Math.max(out.penetration, pen);
        out.centerPenetration = Math.max(out.centerPenetration, -sdf.distance(x, y, z, nrm));
        if (i > 0) out.bodyPenetration = Math.max(out.bodyPenetration, this.body.collide(x, y, z, bodyRadius(r, i, k.bodySkip), nrm));
        if (i + 1 < arm.n) {
          // Segment midpoints too, where a capsule could cut a corner the points straddle.
          const mx = (x + X[i * 3 + 3]) / 2, my = (y + X[i * 3 + 4]) / 2, mz = (z + X[i * 3 + 5]) / 2;
          const mr = (r + arm.rad[i + 1]) / 2, mid = sdf.collide(mx, my, mz, mr, nrm);
          if (i === 0) out.rootPenetration = Math.max(out.rootPenetration, mid);
          else out.penetration = Math.max(out.penetration, mid);
          out.bodyMidPenetration = Math.max(out.bodyMidPenetration, this.body.collide(mx, my, mz, bodyRadius(mr, i + 0.5, k.bodySkip), nrm));
        }
      }
    }
    return out;
  }

  stats() {
    const n = Math.min(this.msCount, WINDOW);
    if (!n) return { n: 0, mean: 0, p95: 0, max: 0 };
    const s = Array.from(this.msBuf.subarray(0, n)).sort((a, b) => a - b);
    return { n, mean: s.reduce((a, b) => a + b, 0) / n, p95: s[Math.min(n - 1, Math.floor(n * 0.95))], max: s[n - 1] };
  }

  resetStats() { this.msCount = 0; }

  /* Drops the grips and the capsule shapes this cache holds; the bodies keep their own references until they go, and
     the proxies belong to the physics world. */
  destroy() {
    for (let a = 0; a < this.arms.length; a++) if (this.episodes[a]?.h) { this.phys.removeConstraint(this.episodes[a].h); this.episodes[a].h = null; }
    for (const sh of this.shapes.values()) sh.Release();
    this.shapes.clear();
  }

  /* An arm lies over toys but not over the patch that grips one: pushed out of what follows it, it would chase its own
     toy. The rest of the arm still lies over it, or it sinks in and pops out when the grip ends. */
  _skipHeld(a) {
    const ep = this.episodes?.[a], w = this.allSdf;
    w.skip = ep?.h ? this._looseAt + this.loose.indexOf(ep.toy) : -1;
    if (ep?.h) { const j = this._segAt(this.arms[a], ep.arc); w.skipLo = j - this.knobs.gripSkip; w.skipHi = j + 1 + this.knobs.gripSkip; }
  }

  _recordPush(t, pen, n, x, y, z, r) {
    const k = this._rec * this.loose.length + t;
    if (pen <= this.pushPen[k]) return;
    this.pushPen[k] = pen;
    const o = k * 6, d = r - pen;
    this.pushNP[o] = n[0]; this.pushNP[o + 1] = n[1]; this.pushNP[o + 2] = n[2];
    this.pushNP[o + 3] = x - n[0] * d; this.pushNP[o + 4] = y - n[1] * d; this.pushNP[o + 5] = z - n[2] * d;
  }

  /* Each segment's touch: whatever its sucker side lies against within touchGap (the furniture, a loose thing, her
     skin, or another arm) and that thing's taste. */
  _touches() {
    const arms = this.arms, S = this.S, sk = this.suckerKnobs, C = this.contact, gap = sk.touchGap, fc = sk.faceCos;
    const w = this.knobs.looseContact ? this.allSdf : this.sdf, nrm = this._f3, nb = this._v3, bs = this.knobs.bodySkip;
    const TK = this.touchKind, TP = this.touchP, TN = this.touchN;
    for (let a = 0; a < arms.length; a++) {
      const arm = arms[a], X = arm.X;
      if (arm.valid === false) { TK.fill(0, a * S, a * S + S); continue; }
      arm._focus(w, this.knobs.focusPad);
      for (let j = 0; j < S; j++) {
        const g = a * S + j, p = j * 3;
        const dx = X[p + 3] - X[p], dy = X[p + 4] - X[p + 1], dz = X[p + 5] - X[p + 2];
        const mx = X[p] + dx / 2, my = X[p + 1] + dy / 2, mz = X[p + 2] + dz / 2, rm = (arm.rad[j] + arm.rad[j + 1]) / 2;
        let kind = 0, best = fc, entry = null, taste = null, d = 0;
        const pen = w.collide(mx, my, mz, rm + gap, nrm);
        if (pen > 0) {
          const f = facing(arm.SK, j, dx, dy, dz, -nrm[0], -nrm[1], -nrm[2]);
          if (f > best) {
            const hi = w.hit;
            best = f; d = rm + gap - pen;
            if (hi >= this._looseAt) { kind = 2; entry = this.loose[hi - this._looseAt]; } else { kind = 1; entry = this.primEntry[hi] ?? null; }
            taste = entry ? (entry.taste ?? entry.tag) : 'wall';
            TN[g * 3] = nrm[0]; TN[g * 3 + 1] = nrm[1]; TN[g * 3 + 2] = nrm[2];
          }
        }
        // The first few points grow out of her skin; past them, lying on her is touching her.
        if (j + 1 >= bs) {
          const pb = this.body.collide(mx, my, mz, bodyRadius(rm, j + 0.5, bs) + gap, nb);
          if (pb > 0) {
            const f = facing(arm.SK, j, dx, dy, dz, -nb[0], -nb[1], -nb[2]);
            if (f > best) { best = f; kind = 3; entry = null; taste = 'self'; d = rm + gap - pb; TN[g * 3] = nb[0]; TN[g * 3 + 1] = nb[1]; TN[g * 3 + 2] = nb[2]; }
          }
        }
        if (!kind && C.touch[g]) { kind = 3; taste = 'self'; d = 0; TN[g * 3] = 0; TN[g * 3 + 1] = 0; TN[g * 3 + 2] = 0; }
        TK[g] = kind; this.touchEntry[g] = entry; this.touchTaste[g] = taste;
        TP[g * 3] = mx - TN[g * 3] * d; TP[g * 3 + 1] = my - TN[g * 3 + 1] * d; TP[g * 3 + 2] = mz - TN[g * 3 + 2] * d;
      }
    }
  }

  /* Every touch on the sucker side is tasted and reported, idle arms included: `tastes` holds one entry per arm per thing
     it touches this tick (the segment nearest the base, the touched point, tag, taste, salience, idle), and a touch that
     just began also goes into `tasteLog` (the last tasteLogSize, numbered by `tasteSeq`) and `lastTaste`. */
  _taste(dt) {
    const arms = this.arms, S = this.S, TK = this.touchKind, TP = this.touchP, list = this.tastes, sk = this.suckerKnobs, now = this.time, fam = this.familiar;
    const seen = this._tasteSeen ??= new Set();
    seen.clear();
    let n = 0;
    for (let a = 0; a < arms.length; a++) {
      const arm = arms[a], g = arm.goal, was = this._tasting[a], now2 = this._tastingNow ??= new Map();
      now2.clear();
      for (let j = 0; j < S; j++) {
        const q = a * S + j, kind = TK[q];
        if (!kind) continue;
        const entry = kind === 3 ? 'self' : this.touchEntry[q] ?? this.touchTaste[q];
        if (now2.has(entry)) { list[now2.get(entry)].segs++; continue; }
        const o = list[n] ??= { arm: 0, seg: 0, segs: 0, point: [0, 0, 0], tag: null, taste: null, salience: 0, idle: false, fresh: false, seq: 0 };
        // Reaching for it, or holding it, is meaning to touch it; any other program is busy; none at all is idle.
        const meant = !!g && g.kind !== 'lead' && (this.track[a] === entry || this.episodes[a]?.toy === entry);
        const state = meant ? 'reach' : g ? 'busy' : 'idle';
        o.arm = a; o.seg = j; o.segs = 1; o.point[0] = TP[q * 3]; o.point[1] = TP[q * 3 + 1]; o.point[2] = TP[q * 3 + 2];
        o.tag = kind === 3 ? 'self' : entry?.tag ?? 'wall'; o.taste = this.touchTaste[q]; o.idle = state === 'idle';
        o.salience = tasteSalience(o.taste, state, fam.novelty(entry, now), sk);
        // A touch that flickers off for less than tasteGap is the same touch, not a new taste.
        const prior = was.get(entry);
        o.fresh = !prior || now - prior.at > sk.tasteGap;
        o.seq = o.fresh ? ++this.tasteSeq : prior.seq;
        now2.set(entry, n);
        if (o.fresh) {
          const e = { ...o, point: o.point.slice(), t: now };
          this.tasteLog.push(e);
          if (this.tasteLog.length > sk.tasteLogSize) this.tasteLog.shift();
          this.lastTaste = e;
        }
        n++;
      }
      for (const [entry, i] of now2) {
        const m = was.get(entry);
        if (m) { m.seq = list[i].seq; m.at = now; } else was.set(entry, { seq: list[i].seq, at: now });
        seen.add(entry);
      }
      for (const [entry, m] of was) if (now - m.at > sk.tasteGap) was.delete(entry);
    }
    list.length = n;
    for (const entry of seen) fam.touch(entry, dt, now);
  }

  /* Taste sets which patches may seal and how hard; the banks flicker; interest in a loose thing runs its course. */
  _suckers(dt) {
    const arms = this.arms, S = this.S, sk = this.suckerKnobs, t = this.time, mode = this._mode, scale = this._scale, c = this.counts;
    this._tickNo++;
    for (let a = 0; a < arms.length; a++) {
      const arm = arms[a], bank = this.banks[a];
      if (arm.restGen !== this._layoutGen[a]) {
        this.layouts[a] = layoutSuckers(arm.len0, arm.rad0, arm.arc0, a, sk);
        bank.relayout(this.layouts[a]);
        this._layoutGen[a] = arm.restGen;
      }
      const ep = this.episodes[a] ?? this._maybeStart(a);
      if (ep) this._retaste(a, ep);
      // The patch a grip hangs from stays on its toy whatever the probe sees: those suckers are attached, not sliding.
      const held = ep?.h ? this._segAt(arm, ep.arc) : -1;
      if (held >= 0) { this.touchKind[a * S + held] = 2; this.touchEntry[a * S + held] = ep.toy; this.touchTaste[a * S + held] = ep.taste; }
      for (let j = 0; j < S; j++) {
        const g = a * S + j, kind = this.touchKind[g];
        mode[j] = SEAL_NONE; scale[j] = 1;
        if (!kind || (this.refr[g] > t && j !== held)) continue;
        if (kind === 3) { c.selfTouch++; if (this.gripSelf) mode[j] = SEAL_WORK; continue; }
        const entry = this.touchEntry[g], mine = kind === 2 && ep?.toy === entry;
        if (kind === 2 && !mine && this._ignored(a, entry)) continue;
        if (j !== held && this._sliding(arm, j, g, kind === 2 ? entry : null, dt)) continue;
        const rule = mine ? ep.rule : tasteRule(this.touchTaste[g], sk, this);
        if (!(rule.grip > 0)) continue;
        mode[j] = mine && ep.hard ? SEAL_HARD : SEAL_WORK;
        scale[j] = rule.grip;
      }
      bank.step(dt, mode, scale);
      for (let j = 0; j < S; j++) if (this.touchKind[a * S + j] === 3) c.selfSealed += bank.segSealed[j];
      if (ep) this._episode(a, ep, dt);
      this._anchors(a);
    }
  }

  /* A sucker can't seal on a surface sliding past it: the segment's velocity against the touched point's, averaged
     over slideTau so contact jitter doesn't read as sliding. */
  _sliding(arm, j, g, toy, dt) {
    const X = arm.X, P = arm.P, p = j * 3, v = this._v3, sk = this.suckerKnobs, W = this.slide;
    let vx = (X[p] + X[p + 3] - P[p] - P[p + 3]) / (2 * dt), vy = (X[p + 1] + X[p + 4] - P[p + 1] - P[p + 4]) / (2 * dt), vz = (X[p + 2] + X[p + 5] - P[p + 2] - P[p + 5]) / (2 * dt);
    if (toy) {
      this.phys.pointVelocity(toy, this.touchP[g * 3], this.touchP[g * 3 + 1], this.touchP[g * 3 + 2], v);
      vx -= v[0]; vy -= v[1]; vz -= v[2];
    }
    if (!Number.isFinite(vx + vy + vz)) return true;
    // A patch that just came into contact starts from its own speed, not from a stale average.
    const f = this.slideAt[g] === this._tickNo - 1 ? 1 - Math.exp(-dt / Math.max(1e-3, sk.slideTau)) : 1;
    W[g * 3] += (vx - W[g * 3]) * f; W[g * 3 + 1] += (vy - W[g * 3 + 1]) * f; W[g * 3 + 2] += (vz - W[g * 3 + 2]) * f;
    this.slideAt[g] = this._tickNo;
    return !(Math.hypot(W[g * 3], W[g * 3 + 1], W[g * 3 + 2]) <= sk.sealSpeed);
  }

  _ignored(a, toy) {
    const m = this.ignore[a], u = m.get(toy);
    if (u === undefined) return false;
    if (u > this.time) return true;
    m.delete(toy);
    return false;
  }

  _maybeStart(a) {
    const S = this.S;
    for (let j = 0; j < S; j++) {
      const g = a * S + j;
      if (this.touchKind[g] !== 2 || this.refr[g] > this.time) continue;
      const toy = this.touchEntry[g];
      if (toy && !this._ignored(a, toy)) return this._start(a, toy);
    }
    return null;
  }

  _start(a, toy) {
    const taste = toy.taste ?? toy.tag, rule = tasteRule(taste, this.suckerKnobs, this);
    const ep = {
      toy, taste, rule, t0: this.time, hold: sampleHold(rule.holdMean, rule.holdSd, this.epRng[a]), hard: rule.hard, commanded: false,
      h: null, arc: 0, seg: -1, off: [0, 0, 0], gripT: 0, ticks: 0, fEma: 0, cap: 0, capEma: 0, seen: this.time, weak: 0, fetched: false,
    };
    this.episodes[a] = ep;
    return ep;
  }

  /* A taste can change under a grip (a debug retag today, rot later): spoiled cancels a fetch, food starts one. */
  _retaste(a, ep) {
    const taste = ep.toy.taste ?? ep.toy.tag;
    if (taste === ep.taste) return;
    const was = ep.rule;
    ep.taste = taste;
    ep.rule = tasteRule(taste, this.suckerKnobs, this);
    ep.hard = ep.rule.hard || ep.commanded;
    if (ep.rule.fetch && !was.fetch) { ep.hold = sampleHold(ep.rule.holdMean, ep.rule.holdSd, this.epRng[a]); ep.t0 = this.time; ep.fetched = false; }
    if (!ep.rule.fetch && ep.fetched) { ep.fetched = false; this.fetchStand[a] = 0; if (this.arms[a].goal?.kind === 'fetch') this.arms[a].moveOn(); }
  }

  _episode(a, ep, dt) {
    const S = this.S, bank = this.banks[a], arm = this.arms[a], t = this.time, k = this.knobs;
    let cap = 0, touching = false, bestJ = -1, bestF = 0;
    for (let j = 0; j < S; j++) {
      const g = a * S + j;
      if (this.touchKind[g] !== 2 || this.touchEntry[g] !== ep.toy) continue;
      touching = true;
      cap += bank.segCeil[j];
      if (bank.segCeil[j] > bestF) { bestF = bank.segCeil[j]; bestJ = j; }
    }
    ep.cap = cap;
    ep.capEma += (cap - ep.capEma) * (1 - Math.exp(-dt / Math.max(1e-3, k.capTau)));
    if (touching) ep.seen = t;
    if (!ep.h) {
      if (t - ep.seen > k.lostGrace) return this._end(a, false, 'lapse');
      if (cap > k.minGrip && ep.rule.grip > 0 && bestJ >= 0 && this._heldBy(ep.toy) < 0) this._grip(a, ep, bestJ);
    } else {
      ep.weak = cap > k.minGrip ? 0 : ep.weak + dt;
      if (ep.weak > k.lostGrace) return this._end(a, true, 'release');
    }
    if (ep.h && ep.rule.reject) {
      ep.arc += this.suckerKnobs.rejectSpeed * dt;
      if (ep.arc >= arm.arc0[S] - arm.len0[S - 1] / 2) return this._reject(a, ep);
    } else if (ep.h && ep.rule.fetch && !ep.fetched && t - ep.gripT > k.fetchBeat) {
      if (this.fetch(a, { grasp: ep.arc / arm.length, hold: ep.hold })) {
        const sz = ep.toy.size;
        this.fetchStand[a] = k.fetchClear * (ep.toy.kind === 'box' ? Math.max(sz[0], sz[1], sz[2]) : ep.toy.kind === 'sphere' ? sz[0] : sz[0] + sz[1]);
        ep.fetched = true;
        this.counts.fetches++;
      }
    }
    // A rejection runs its course to the tip; anything else not held by command lasts its taste's hold.
    if (!ep.commanded && !(ep.h && ep.rule.reject) && t - ep.t0 > ep.hold) this._end(a, true, 'moveOn');
  }

  /* A grip: the toy pinned at the touched point to this arm's proxy, which follows that spot on the arm from now on. */
  _grip(a, ep, j) {
    const arm = this.arms[a], g = a * this.S + j, P = this.touchP, F = segFrame(arm, j, 0.5, this._fr);
    const cx = P[g * 3], cy = P[g * 3 + 1], cz = P[g * 3 + 2];
    if (!F || !Number.isFinite(cx + cy + cz)) return;
    const vx = cx - F.m[0], vy = cy - F.m[1], vz = cz - F.m[2];
    ep.off[0] = vx * F.e1[0] + vy * F.e1[1] + vz * F.e1[2];
    ep.off[1] = vx * F.e2[0] + vy * F.e2[1] + vz * F.e2[2];
    ep.off[2] = vx * F.e3[0] + vy * F.e3[1] + vz * F.e3[2];
    ep.seg = j; ep.arc = arm.arc0[j] + arm.len0[j] / 2;
    const proxy = this.proxies[a];
    this.phys.teleport(proxy, cx, cy, cz, 0, 0, 0, 1);
    this.gripPos[a * 3] = cx; this.gripPos[a * 3 + 1] = cy; this.gripPos[a * 3 + 2] = cz;
    ep.h = this.phys.addPointConstraint(proxy, ep.toy, [cx, cy, cz]);
    this.phys.wake(ep.toy);
    ep.gripT = this.time; ep.ticks = 0; ep.fEma = 0; ep.weak = 0; ep.capEma = Math.max(ep.capEma, ep.cap);
    this.counts.grips++;
  }

  /* The arm already gripping this toy, or -1. One grip per toy: two rigid proxies on one body fight without limit, so a
     second arm only tastes it (arms after the same thing jostle and one yields). */
  _heldBy(toy) {
    for (let b = 0; b < this.arms.length; b++) if (this.episodes[b]?.h && this.episodes[b].toy === toy) return b;
    return -1;
  }

  _segAt(arm, arc) {
    let j = 0;
    while (j < arm.n - 2 && arc >= arm.arc0[j + 1]) j++;
    return j;
  }

  /* Where arm a's grip sits now: its stored offset, in the arm's frame at the grip's rest arc. */
  _gripPoint(a, ep, out) {
    const arm = this.arms[a], j = this._segAt(arm, ep.arc);
    const F = segFrame(arm, j, Math.max(0, Math.min(1, (ep.arc - arm.arc0[j]) / arm.len0[j])), this._fr);
    if (!F) return null;
    for (let i = 0; i < 3; i++) out[i] = F.m[i] + ep.off[0] * F.e1[i] + ep.off[1] * F.e2[i] + ep.off[2] * F.e3[i];
    return Number.isFinite(out[0] + out[1] + out[2]) ? out : null;
  }

  /* The force each grip held with through the last step; past what its seals bear, it tears. */
  _readGrips() {
    const k = this.knobs, f = this._p3, R = this.reaction;
    R.fill(0);
    for (let a = 0; a < this.arms.length; a++) {
      const ep = this.episodes[a];
      if (!ep?.h) continue;
      const F = this.phys.constraintForce(ep.h, f);
      ep.fEma += ((Number.isFinite(F) ? F : 0) - ep.fEma) * k.breakSmooth;
      // Jolt's lambda is the impulse on the toy, so her arm feels the opposite.
      R[a * 3] = -f[0]; R[a * 3 + 1] = -f[1]; R[a * 3 + 2] = -f[2];
      // The first ticks carry the toy taking up the arm's speed, not a pull.
      if (++ep.ticks > k.breakGrace && ep.fEma > Math.max(k.minGrip, ep.capEma * k.breakMargin)) {
        // A weakened grip tearing on its way out along the arm is the rejection finishing early.
        if (ep.rule.reject) this._reject(a, ep);
        else { this.counts.breaks++; this._end(a, true, 'break'); }
      }
    }
  }

  _moveProxies(dt) {
    const p = this._p3, G = this.gripPos, f = 1 - Math.exp(-dt / Math.max(1e-3, this.knobs.gripTau));
    for (let a = 0; a < this.arms.length; a++) {
      const ep = this.episodes[a];
      if (!ep?.h || !this._gripPoint(a, ep, p)) continue;
      for (let i = 0; i < 3; i++) G[a * 3 + i] += (p[i] - G[a * 3 + i]) * f;
      this._keepOut(a, ep.toy, G);
      this.phys.moveKinematic(this.proxies[a], G[a * 3], G[a * 3 + 1], G[a * 3 + 2], 0, 0, 0, 1, dt);
      this.phys.wake(ep.toy);
    }
  }

  /* A rigid proxy would drive what it holds into the floor or a wall until the grip tore: where the held toy's center,
     carried along with the proxy, would sink into the furniture, the proxy's target rises out by that much. */
  _keepOut(a, toy, G) {
    const pp = this.proxies[a].body.GetPosition(), px = pp.GetX(), py = pp.GetY(), pz = pp.GetZ();
    const tp = toy.body.GetPosition(), sz = toy.size, nrm = this._f3;
    const r = toy.kind === 'box' ? Math.min(sz[0], sz[1], sz[2]) : toy.kind === 'sphere' ? sz[0] : sz[1];
    const o = a * 3, cx = G[o] + tp.GetX() - px, cy = G[o + 1] + tp.GetY() - py, cz = G[o + 2] + tp.GetZ() - pz;
    this.sdf.unfocus();
    const pen = this.sdf.collide(cx, cy, cz, r, nrm);
    if (pen > 0 && Number.isFinite(pen)) { G[o] += nrm[0] * pen; G[o + 1] += nrm[1] * pen; G[o + 2] += nrm[2] * pen; }
  }

  /* Out along the arm and off the tip, with a little shove. */
  _reject(a, ep) {
    const arm = this.arms[a], X = arm.X, n = arm.n, toy = ep.toy;
    const dx = X[n * 3 - 3] - X[n * 3 - 6], dy = X[n * 3 - 2] - X[n * 3 - 5], dz = X[n * 3 - 1] - X[n * 3 - 4];
    const l = Math.hypot(dx, dy, dz), inv = this.phys.inverseMass(toy);
    this._end(a, true, 'reject');
    if (l > 1e-9 && inv > 0) {
      const J = this.knobs.rejectPush / inv / l, p = toy.body.GetPosition();
      this.phys.impulseAt(toy, dx * J, dy * J, dz * J, p.GetX(), p.GetY(), p.GetZ());
    }
  }

  /* Interest over: the grip goes, the patch on it stays unsealed for a beat, and the arm leaves it alone a while. */
  _end(a, ignore, why) {
    const ep = this.episodes[a];
    if (!ep) return;
    if (ep.h) { this.phys.removeConstraint(ep.h); ep.h = null; this.phys.stopKinematic(this.proxies[a]); }
    this.episodes[a] = null;
    const sk = this.suckerKnobs, S = this.S;
    if (ignore) this.ignore[a].set(ep.toy, this.time + sk.ignoreTime);
    for (let j = 0; j < S; j++) if (this.touchEntry[a * S + j] === ep.toy) this.refr[a * S + j] = this.time + sk.refractory;
    if (ep.fetched) this.fetchStand[a] = 0;
    if ((why === 'moveOn' || why === 'reject') && this.arms[a].goal?.kind !== 'lead') this.arms[a].moveOn();
    if (why in this.counts) this.counts[why]++;
  }

  _anchors(a) {
    const list = this.anchorList[a], bank = this.banks[a], S = this.S, TP = this.touchP, TN = this.touchN;
    let n = 0, sum = 0;
    for (let j = 0; j < S; j++) {
      const g = a * S + j;
      if (this.touchKind[g] !== 1 || !bank.segSealed[j]) continue;
      const o = list[n] ??= { seg: 0, p: [0, 0, 0], n: [0, 0, 0], force: 0, hold: 0, taste: null };
      o.seg = j; o.force = bank.segCeil[j]; o.hold = bank.segForce[j]; o.taste = this.touchTaste[g];
      for (let i = 0; i < 3; i++) { o.p[i] = TP[g * 3 + i]; o.n[i] = TN[g * 3 + i]; }
      n++; sum += o.force;
    }
    this.anchorCount[a] = n;
    this.anchorForce[a] = sum;
  }

  /* Capped pushes on loose things: each arm drives the touched point toward where it meant to be, never harder than
     pushN, so a light toy is nudged along and a heavy one stops the arm. */
  _pushToys(dt) {
    const nL = this.loose.length, P = this.pushPen, NP = this.pushNP, v = this._v3, cap = this.knobs.pushN * dt, c = this.counts;
    for (let a = 0; a < this.arms.length; a++) {
      const ep = this.episodes[a];
      for (let t = 0; t < nL; t++) {
        const k = a * nL + t, pen = P[k];
        if (!(pen > 0)) continue;
        const toy = this.loose[t];
        // An arm doesn't shove what it reached for or holds; a toy it merely touched while exploring it can push, or the
        // toy stays wedged under it.
        if ((ep?.h && ep.toy === toy) || this.track[a] === toy) continue;
        const inv = this.phys.inverseMass(toy);
        if (!(inv > 0)) continue;
        const o = k * 6, nx = NP[o], ny = NP[o + 1], nz = NP[o + 2], px = NP[o + 3], py = NP[o + 4], pz = NP[o + 5];
        this.phys.pointVelocity(toy, px, py, pz, v);
        // The speed the arm wanted into the toy, less what the toy already has away from the arm.
        const want = pen / dt + (v[0] * nx + v[1] * ny + v[2] * nz);
        if (!(want > 0)) continue;
        const J = Math.min(want / inv, cap);
        this.phys.impulseAt(toy, -nx * J, -ny * J, -nz * J, px, py, pz);
        c.pushes++;
        if (J / dt > c.pushMaxN) c.pushMaxN = J / dt;
      }
    }
  }

  /* The panel's G: a hard grip on whatever the arms are touching or holding or, once any grip is hard by command,
     let go of everything. Returns what it did. */
  toggleGrip() {
    if (this.episodes.some((e) => e?.commanded)) return this.releaseAll();
    let n = 0;
    for (const ep of this.episodes) if (ep && ep.rule.grip > 0) { ep.commanded = true; ep.hard = true; n++; }
    return n ? 'hard' : 'none';
  }

  releaseAll() {
    for (let a = 0; a < this.arms.length; a++) this._end(a, true, 'release');
    return 'released';
  }

  /* Her other arms' sealed hold on the furniture against what she grips: whether a pull reels the thing in or hauls her. */
  whoMoves(i) {
    const ep = this.episodes[i];
    if (!ep?.h) return null;
    let anchor = 0;
    for (let b = 0; b < this.arms.length; b++) if (b !== i) anchor += this.anchorForce[b];
    return whoMoves({ anchor, objectHold: 0, objectMass: 1 / Math.max(1e-9, this.phys.inverseMass(ep.toy)), bodyMass: this.knobs.bodyMass });
  }

  /* Arm i's sealed contacts on the furniture: segment, surface point, outward normal, the newtons they bear before
     tearing (force) and hold with routinely (hold), and taste. */
  anchors(i) { return this.anchorList[i].slice(0, this.anchorCount[i]); }

  /* Per arm: the share of touching suckers sealed, what it holds (by taste) or is tasting, and how hard. */
  suckerReport() {
    return this.banks.map((b, a) => {
      const ep = this.episodes[a], R = this.reaction;
      return {
        share: b.touching ? b.sealedCount / b.touching : 0, sealed: b.sealedCount, touching: b.touching,
        holds: ep?.h ? ep.taste : null, tastes: ep && !ep.h ? ep.taste : null, hard: !!ep?.hard, reaction: Math.hypot(R[a * 3], R[a * 3 + 1], R[a * 3 + 2]),
      };
    });
  }

  /* World position of sucker i on arm a, on the sucker side of the solved chain, its row a little to one side. */
  suckerPoint(a, i, out) {
    const arm = this.arms[a], L = this.layouts[a], j = L.seg[i];
    const f = Math.max(0, Math.min(1, (L.arc[i] - arm.arc0[j]) / arm.len0[j])), F = segFrame(arm, j, f, this._fr);
    if (!F) return null;
    const r = arm.rad[j] + (arm.rad[j + 1] - arm.rad[j]) * f, side = L.row[i] ? 0.4 : -0.4;
    for (let c = 0; c < 3; c++) out[c] = F.m[c] + F.e2[c] * r * 0.9 + F.e3[c] * r * side;
    return out;
  }
}

/* The frame of arm segment j at fraction f along it: point m, direction e1, sucker side squared off it e2, and e3. */
function segFrame(arm, j, f, out) {
  const X = arm.X, p = j * 3, SK = arm.SK, { m, e1, e2, e3 } = out;
  let dx = X[p + 3] - X[p], dy = X[p + 4] - X[p + 1], dz = X[p + 5] - X[p + 2];
  const l = Math.hypot(dx, dy, dz);
  if (!(l > 1e-9)) return null;
  dx /= l; dy /= l; dz /= l;
  m[0] = X[p] + (X[p + 3] - X[p]) * f; m[1] = X[p + 1] + (X[p + 4] - X[p + 1]) * f; m[2] = X[p + 2] + (X[p + 5] - X[p + 2]) * f;
  e1[0] = dx; e1[1] = dy; e1[2] = dz;
  let sx = SK[p], sy = SK[p + 1], sz = SK[p + 2];
  const c = sx * dx + sy * dy + sz * dz;
  sx -= c * dx; sy -= c * dy; sz -= c * dz;
  let sl = Math.hypot(sx, sy, sz);
  if (sl < 1e-6) {
    sx = Math.abs(dy) < 0.9 ? 0 : 1; sy = Math.abs(dy) < 0.9 ? 1 : 0; sz = 0;
    const k = sx * dx + sy * dy;
    sx -= k * dx; sy -= k * dy; sz -= k * dz;
    sl = Math.hypot(sx, sy, sz);
  }
  e2[0] = sx / sl; e2[1] = sy / sl; e2[2] = sz / sl;
  e3[0] = dy * e2[2] - dz * e2[1]; e3[1] = dz * e2[0] - dx * e2[2]; e3[2] = dx * e2[1] - dy * e2[0];
  return out;
}

/* Quaternion rotating +Y onto the unit vector d, written into out[o..o+3]. */
export function quatFromY(dx, dy, dz, out, o = 3) {
  // cross(Y, d) = (dz, 0, -dx); w = 1 + dot(Y, d)
  let x = dz, y = 0, z = -dx, w = 1 + dy;
  if (w < 1e-6) { x = 1; y = 0; z = 0; w = 0; }   // d is -Y: a half turn about X
  const l = Math.hypot(x, y, z, w);
  out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; out[o + 3] = w / l;
  return out;
}
