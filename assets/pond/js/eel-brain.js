import { BRAIN_SLOTS, DEPTH } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { retreatAlongTrail } from './eel-physics.js';
import { tickHeldAbove } from './eel-behavior.js';
import { makeRings, clearRings, addInterest, addDanger, addDangerArc, adapt, wrapPi, slotAngle, legalNudge, TAU } from './eel-brain-core.js';
import { FOOD_DRUNK, foodDrunk } from './eel-quirks.js';

/* The Shared Braincell. One number per eel says how much of it they bother to use; everything below
   is the same machinery for everyone. Mounted as sys.braincell and as sys.headingAdapter. */

const BRAIN_SALT = 2000;         // per-eel stream, separate from e.rng so a scent draw never shifts a gait roll
const OU_TAU = 1.5;              // seconds of correlation on the scent approach error
const PLOP_R = 3.5, PLOP_FOR = 1.5;
const PLUME_CAP = 5;
const NOTICE_LIFE = 6;           // seconds a quorum notice stands
const NAP_REACH = 3.5;           // same reach the nap field uses, so a pile is one thing to both
const SULK_RANGE = [20, 40];
const SIDE_EYE_NEAR = 1.5, SIDE_EYE_YAW = 0.35;
// Above the 0.2 legality floor on purpose: at or under it the grudge can never mask a heading, and
// danger combines by maximum, so a writer below the floor is worth exactly nothing.
const SIDE_EYE_DANGER = 0.35;
const BOXED_LIMIT = 2.5, ESCAPE_LIMIT = 3;
const ANCHOR_REFRESH = [240, 480];
const WAVE_WRAP = Math.PI * 2 * 1000;   // same phase wrap the swim wave uses, so a long escape cannot drift
const BRAKE = 0.7, BRAKE_ANGLE = 30;   // fallbacks; pond.eels.knobs.brake and .brakeAngle are the live dials
const BRAIN_FLOOR = 0.2;         // fallback when the knob is missing; pond.eels.knobs.brainFloor is the live dial
const TANGENT_EPS = 1e-6;        // just clear of the silhouette, never a whole slot: a passable gap is often narrower
const DEFAULT_EATS = { crumb: 1 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

export function attachBraincell(sys, seed) {
  const mod = new Braincell(seed);
  mod.sys = sys;
  sys.addModule(mod);
  sys.braincell = mod;
  sys.headingAdapter = (s, e, force, dt) => mod.heading(s, e, force, dt);
  return mod;
}

class Braincell {
  constructor(seed) {
    this.seed = seed;
    this.sys = null;
    this.keepRings = false;   // ?overlay=brain turns on the per-eel ring copies; off, nothing is kept
    this.state = new Map();
    this.slots = BRAIN_SLOTS;
    // Scratch reused across every eel and tick: the ring pass allocates nothing.
    this.rings = makeRings(this.slots);
    this.candidates = [];
    this.obst = [];           // { ang, alpha, S } per writer, for the tangent candidates' own test
    this.carve = new Uint8Array(this.slots);
    this.pile = [];
    this.push = { x: 0, z: 0 };
    this.liveIds = new Set();
    this.spine = [0, 0, 0];
    this.obstAt = 0;          // obst is a pool of reused records; obstAt is how many are live this tick
  }

  stateFor(e) {
    let st = this.state.get(e);
    if (!st) { st = this.fresh(e); this.state.set(e, st); }
    return st;
  }

  fresh(e) {
    return {
      rng: createRng(deriveSeed(this.seed, BRAIN_SALT + (e.index ?? 0))),
      spare: null,              // the second Box-Muller normal, spent next draw
      eps: 0, epsSd: 0,
      memory: [],
      anchor: 'unresolved',
      anchorAt: 0,
      sulk: new Map(),          // dropId -> until; keyed by id so a deleted crumb cannot pin an object
      seen: new Map(),          // dropId -> { x, z, y }, last known position of everything it smelled
      notice: new Map(),        // dropId -> t, quorum detections
      lastFood: null,
      noProgressFor: 0,
      progressAt: 0,
      progressD: Infinity,
      giveUpOn: null,
      episodes: 0,
      sideEye: [],              // { x, z, until }
      gaze: null,               // { x, z, until, w }, the bounded yaw proposal
      ctx: null, routing: false, boxed: false, boxedFor: 0, boxedSide: 0, deflect: 0,
      escape: null,
      ringsTick: -1, look: 0, tolerance: 0, floor: 0, blur: 0, dbgI: null, dbgD: null,
      drops: [], phantom: null, misses: 0, gesture: -1, lastDrop: 0,
      crevice: null, creviceAt: -1,
      senseW: new Map(), sensePlume: new Map(),
    };
  }

  initEel(sys, e) {
    this.state.set(e, this.fresh(e));
    e.wits = 0; e.focus = 0;
    if (e.sensedFoods) e.sensedFoods.length = 0;
  }

  // Ring width is a live A/B (pond.eels.knobs.slots); the scratch follows it.
  resize(want) {
    const n = want | 0;
    if (n === this.slots || !(n >= 8) || !(n <= 256)) return;
    this.slots = n;
    this.rings = makeRings(this.slots);
    this.carve = new Uint8Array(this.slots);
  }

  prepass(sys, dt) {
    this.resize(sys.knobs.slots ?? BRAIN_SLOTS);
    const now = sys.time;
    const all = sys.guests.length ? sys.eels.concat(sys.guests) : sys.eels;
    // Residents then guests, no concat: this runs every tick and the joined array would be garbage.
    for (const e of sys.eels) this.think(sys, e, dt, now);
    for (const g of sys.guests) this.think(sys, g, dt, now);
    this.quorum(sys, now);
  }

  think(sys, e, dt, now) {
    const st = this.stateFor(e);
    e.wits = witsOf(sys, e);
    e.focus = focusOf(sys, e, now);
    // Expiry first: sensing refreshes a notice, so expiring after it would drop a crumb the eel is
    // still smelling and let a sleeper claim it for a tick before quorum could carry.
    expireMap(st.sulk, now);
    expireMap(st.notice, now, NOTICE_LIFE);
    this.sense(e);
    this.remember(sys, e, st, now);
    this.stepError(e, st, dt);
    for (let i = st.sideEye.length - 1; i >= 0; i--) if (now > st.sideEye[i].until) st.sideEye.splice(i, 1);
    if (st.anchor === 'unresolved' || now >= st.anchorAt) this.resolveAnchor(sys, e, st, now);
    this.anticipate(sys, e, st, now);
  }

  /* B3. Smell, not omniscience: the sensed set is built once for everyone before anybody steers. */
  sense(e) {
    const sys = this.sys;
    const out = (e.sensedFoods ??= []);
    out.length = 0;
    const st = this.stateFor(e);
    st.senseW.clear(); st.sensePlume.clear();
    const scents = sys?.scents;
    if (!scents || !scents.length) return out;
    const now = sys.time, head = e.head;
    const nose = e.nose ?? 1;
    const eats = e.eats ?? DEFAULT_EATS;
    for (const s of scents) {
      if (!(s.amount > 0)) continue;
      const w = eats[s.kind] ?? 0;
      if (!(w > 0)) continue;
      if (st.sulk.has(s.dropId)) continue;   // B5: a site it stormed off from does not exist for a while
      const dx = s.x - head.x, dz = s.z - head.z;
      const d = Math.hypot(dx, dz);
      // Fields across the body register, fields along it do not: a crumb dead ahead is noticed late.
      const abeam = d > 1e-5 ? 0.35 + 0.65 * Math.abs((e.heading.x * dz - e.heading.z * dx) / d) : 1;
      const age = Math.max(0, now - (s.t ?? now));
      const plop = age < PLOP_FOR ? (s.plop ?? PLOP_R) : 0;
      const plume = Math.min(PLUME_CAP, (0.8 + 0.9 * Math.sqrt(age)) * Math.sqrt(s.amount) * nose);
      if (d > Math.max(plop, plume) * abeam) continue;
      out.push(s);
      st.senseW.set(s, w);
      st.sensePlume.set(s, plume);
      if (s.dropId !== undefined) st.notice.set(s.dropId, now);   // refreshed while smelled, so it only ages once lost
    }
    return out;
  }

  hasSensedFood(e) { return !!e.sensedFoods?.length; }

  senseWeight(e, f) { return this.stateFor(e).senseW.get(f) ?? 1; }

  /* B4's three write triggers, resolved against last tick's sensed set. */
  remember(sys, e, st, now) {
    const cap = Math.round(3 * e.wits);
    const live = this.liveIds;
    live.clear();
    for (const f of e.sensedFoods) if (f.dropId !== undefined) live.add(f.dropId);
    for (const [id, pos] of st.seen) {
      if (live.has(id)) continue;
      let still = false;
      for (const sc of sys.scents) if (sc.dropId === id && sc.amount > 0) { still = true; break; }
      // Out of range, or finished by somebody else while this eel was on its way.
      const mine = st.lastFood && st.lastFood.dropId === id && Math.hypot(st.lastFood.x - e.head.x, st.lastFood.z - e.head.z) < 0.35;
      if (!still && mine) { st.seen.delete(id); continue; }
      this.writeMemory(st, pos.x, pos.z, pos.y, now, cap);
      st.seen.delete(id);
    }
    for (const f of e.sensedFoods) if (f.dropId !== undefined) st.seen.set(f.dropId, { x: f.x, z: f.z, y: f.y });
    st.lastFood = e.food ?? st.lastFood;
    const life = 20 + 40 * e.wits;
    for (let i = st.memory.length - 1; i >= 0; i--) if (now - st.memory[i].t > life) st.memory.splice(i, 1);
    while (st.memory.length > Math.max(0, cap)) st.memory.shift();
  }

  writeMemory(st, x, z, y, now, cap) {
    if (!(cap > 0)) return;
    st.memory.push({ x, z, y, t: now });
    while (st.memory.length > cap) st.memory.shift();
  }

  /* B3's approach error: an Ornstein-Uhlenbeck walk on the pull direction, integrated for everyone
     every tick so it decays honestly when there is nothing to chase. */
  stepError(e, st, dt) {
    const sd = st.epsSd;
    // Nothing to chase and nothing left to decay: skip the draw so the eel's stream is not spent on it.
    if (sd === 0 && st.eps === 0) return;
    const g = gauss(st);
    st.eps += -st.eps / OU_TAU * dt + sd * Math.sqrt(2 / OU_TAU) * Math.sqrt(dt) * g;
    const lim = 2 * Math.max(sd, 1e-6);
    st.eps = Math.max(-lim, Math.min(lim, st.eps));
    if (sd === 0 && Math.abs(st.eps) < 1e-6) st.eps = 0;
    st.epsSd = 0;   // the food block re-arms it each tick it is hunting
  }

  approachError(e, committed, d, f) {
    const st = this.stateFor(e);
    if (committed) { st.eps = 0; st.epsSd = 0; return 0; }
    const plume = st.sensePlume.get(f) ?? 0;
    st.epsSd = lerp(1.2, 0.25, clamp01(e.focus)) * (plume > 1e-6 ? clamp01(d / plume) : 1);
    return st.eps;
  }

  /* B7. A pile wakes as one beat: detections are counted per drop across a resting component, and
     nobody may take a meal off a sleeping pile until the count carries. */
  quorum(sys, now) {
    const resting = this.pile;
    resting.length = 0;
    let noticed = false;
    for (const e of sys.eels) {
      if (e.gait !== 'hold' || now >= e.gaitUntil || e.slurpedBy) continue;
      resting.push(e);
      if (this.stateFor(e).notice.size) noticed = true;
    }
    if (!noticed) return;   // a pile with nothing to smell has nothing to decide
    const seen = new Set();
    for (const a of resting) {
      if (seen.has(a)) continue;
      const comp = [a];
      seen.add(a);
      for (let i = 0; i < comp.length; i++) {
        for (const b of resting) {
          if (seen.has(b)) continue;
          if (Math.hypot(comp[i].head.x - b.head.x, comp[i].head.z - b.head.z) > NAP_REACH) continue;
          seen.add(b); comp.push(b);
        }
      }
      const need = Math.ceil(comp.length / 2);
      const tally = new Map();
      for (const m of comp) {
        const w = m.census?.twoAM === 'cozy' ? 2 : 1;
        for (const id of this.stateFor(m).notice.keys()) tally.set(id, (tally.get(id) ?? 0) + w);
      }
      let carried = false;
      for (const v of tally.values()) if (v >= need) { carried = true; break; }
      if (!carried) continue;
      for (const m of comp) {
        m.gaitUntil = Math.min(m.gaitUntil, now);
        if (m.restPose) m.restPose.kind = '';
        if (m.snuggle) m.snuggle.with = null;
        sys.air?.wake?.(m);   // a buried member starts its dig-out instead of teleporting up
      }
    }
  }

  /* Until its pile carries, a sleeper may smell dinner and still not get up for it. */
  mayHunt(e) {
    if (e.gait !== 'hold' || this.sys.time >= e.gaitUntil) return true;
    return this.stateFor(e).notice.size === 0;
  }

  /* B7's rhythm reader. Four detected drops inside one gesture, both variances tight, and a
     high-wits eel starts waiting where the next one is going to land. */
  anticipate(sys, e, st, now) {
    if (!(sys.knobs.anticipation > 0) || !(e.wits >= 0.6)) { st.phantom = null; return; }
    const g = sys.finger.gestureId;
    if (g !== st.gesture) { st.gesture = g; st.drops.length = 0; st.misses = 0; st.phantom = null; st.lastDrop = 0; }
    // Release ends the tell: the rhythm belonged to a hand that is no longer feeding.
    if (sys.finger.mode !== 'feed') { st.phantom = null; st.drops.length = 0; st.misses = 0; st.lastDrop = 0; return; }
    for (const f of e.sensedFoods) {
      // Strictly increasing, so a crumb that scrolled out of the window can never be counted twice
      // and the stream stays in drop order however late a smell arrives.
      if (f.kind !== 'crumb' || f.gestureId !== g || !(f.dropId > (st.lastDrop ?? 0))) continue;
      st.lastDrop = f.dropId;
      st.drops.push({ dropId: f.dropId, t: f.t, x: f.x, z: f.z });
      if (st.drops.length > 4) st.drops.shift();
      // A landed crumb near the guess is the tell working; two clean misses and the gesture is dropped.
      if (st.phantom) {
        if (Math.hypot(f.x - st.phantom.x, f.z - st.phantom.z) <= 0.5) st.misses = 0;
        else if (++st.misses >= 2) { st.phantom = null; st.drops.length = 0; return; }
      }
    }
    if (st.misses >= 2 || st.drops.length < 4) return;
    const dts = [], sps = [];
    for (let i = 1; i < st.drops.length; i++) {
      dts.push(st.drops[i].t - st.drops[i - 1].t);
      sps.push(Math.hypot(st.drops[i].x - st.drops[i - 1].x, st.drops[i].z - st.drops[i - 1].z));
    }
    if (cv(dts) >= 0.2 || cv(sps) >= 0.2) { st.phantom = null; return; }
    const last = st.drops[st.drops.length - 1], prev = st.drops[st.drops.length - 2];
    const interval = mean(dts);
    if (!(interval > 1e-3)) { st.phantom = null; return; }
    if (now > last.t + 1.5 * interval) { st.phantom = null; return; }
    st.phantom = { x: last.x + (last.x - prev.x), z: last.z + (last.z - prev.z), until: last.t + 1.5 * interval };
  }

  /* Hook one, from steer before the force sum: the memory sniff hold, the side-eye's gaze arming,
     and the anticipation phantom, which is an ordinary force term like every other pull. */
  preSteer(sys, e, dt, force) {
    const st = this.stateFor(e), now = sys.time, head = e.head;
    // A run, a scatter, or a contest has already claimed the tick by the time this hook is reached;
    // the sniff hold is voluntary tier and stands down for them rather than co-steering.
    const spot = tickHeldAbove(e, 'voluntary') ? null : e.coverSpot;
    if (spot?.type === 'memory') {
      if (spot.holdUntil > 0) {
        if (now >= spot.holdUntil) e.coverSpot = null;
      } else if (Math.hypot(e.target.x - head.x, e.target.z - head.z) < 0.6) {
        const until = now + st.rng.range(2, 3);
        spot.holdUntil = until;
        e.gait = 'hold'; e.gaitUntil = until;
        e.targetY = -DEPTH + e.radius * 2.2;
        e.retargetYAt = until; e.retargetAt = until;
        // Nose down and swing: the site is forgotten the moment the sniff starts, so it is checked once.
        for (let i = st.memory.length - 1; i >= 0; i--) {
          if (Math.hypot(st.memory[i].x - spot.x, st.memory[i].z - spot.z) < 0.8) st.memory.splice(i, 1);
        }
      }
      if (spot.holdUntil > now) {
        e.target.set(spot.x + Math.cos(now * 2.4) * 0.25, 0, spot.z + Math.sin(now * 2.4) * 0.25);
      }
    }
    // The side-eye: within range of a spot it gave up on, the head turns to look while the body swims on.
    st.gaze = null;
    let near = null, nd = SIDE_EYE_NEAR;
    for (const s of st.sideEye) {
      const d = Math.hypot(s.x - head.x, s.z - head.z);
      if (d < nd) { nd = d; near = s; }
    }
    if (near) st.gaze = { x: near.x, z: near.z, w: 1 - nd / SIDE_EYE_NEAR };
    if (force && st.phantom && now <= st.phantom.until) {
      const dx = st.phantom.x - head.x, dz = st.phantom.z - head.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) { force.x += (dx / d) * 0.4; force.z += (dz / d) * 0.4; }
    }
  }

  /* Hook two, from steer beside graze and tea: the give-up clock on whatever crumb it is chasing. */
  tick(sys, e, dt) {
    const st = this.stateFor(e), now = sys.time;
    const f = e.food;
    if (!f) { st.giveUpOn = null; st.noProgressFor = 0; st.progressD = Infinity; return; }
    if (st.giveUpOn !== f) { st.giveUpOn = f; st.noProgressFor = 0; st.progressAt = now; st.progressD = e.foodDist; st.episodes = 0; }
    // Progress is judged over a second, never tick to tick: a body wave alone moves the snout.
    if (now - st.progressAt >= 1) {
      if (st.progressD - e.foodDist < 0.05) st.noProgressFor += now - st.progressAt;
      else st.noProgressFor = 0;
      st.progressAt = now; st.progressD = e.foodDist;
    }
    if (st.noProgressFor < lerp(18, 7, clamp01(e.wits))) return;
    this.giveUp(sys, e, st, f, now);
  }

  giveUp(sys, e, st, f, now) {
    st.noProgressFor = 0;
    st.giveUpOn = null;
    this.writeMemory(st, f.x, f.z, f.y, now, Math.round(3 * e.wits));
    // Sensing skips a sulked drop, so leaving it in `seen` makes remember() write the same site again
    // next prepass and two duplicates fill a two-site memory.
    if (f.dropId !== undefined) st.seen.delete(f.dropId);
    if (e.food === f) { f.claims = Math.max(0, f.claims - 1); e.food = null; }
    e.attnReset = true;
    if (e.wits > 0.4 && f.dropId !== undefined) {
      const until = now + st.rng.range(SULK_RANGE[0], SULK_RANGE[1]);
      st.sulk.set(f.dropId, until);
      st.sideEye.push({ x: f.x, z: f.z, until });
    }
  }

  /* A stuck or boxed episode while chasing the same crumb is worth four seconds of the give-up clock. */
  blocked(e) {
    const st = this.stateFor(e);
    if (!st.giveUpOn) return;
    st.noProgressFor += 4;
    st.episodes++;
  }

  // B4's anchors. A class with no candidates yet stays unresolved and pulls on nothing.
  resolveAnchor(sys, e, st, now) {
    const home = e.home ?? 'roam';
    // Retry on a cheap fixed cadence while a class has nothing to offer yet, so waiting for the pads
    // to publish does not spend a seeded draw ninety times a second.
    const wait = () => { st.anchor = 'unresolved'; st.anchorAt = now + 5; };
    if (home === 'roam') { st.anchor = null; st.anchorAt = Infinity; return; }
    let pick = null;
    if (home === 'log') {
      const log = sys.colliders.logs[0];
      if (!log) return wait();
      const m = st.rng.chance(0.5) ? log.a : log.b;
      pick = { x: m.x, z: m.z };
    } else if (home === 'rock') {
      const rocks = sys.colliders.spheres;
      if (!rocks.length) return wait();
      // Vi takes the biggest stone in the pond; everyone else takes a seeded one.
      let o = rocks[Math.floor(st.rng.next() * rocks.length)];
      if (e.quirks?.dominant) for (const r of rocks) if (r.r > o.r) o = r;
      pick = { x: o.x, z: o.z };
    } else {
      const pads = sys.habitat?.pads ?? [];
      if (!pads.length) return wait();   // a pad home waits for pads, never a rock
      const p = pads[Math.floor(st.rng.next() * pads.length)];
      pick = { x: p.x, z: p.z };
    }
    st.anchor = pick;
    st.anchorAt = now + st.rng.range(ANCHOR_REFRESH[0], ANCHOR_REFRESH[1]);
  }

  /* The wander draw, in the same normalized units pickTarget uses so the party biases still apply
     to it afterwards. Home fidelity is the whole of B4's 80%-within-5-BL line. */
  anchorDraw(e, ex, ez) {
    const st = this.stateFor(e);
    const a = st.anchor;
    if (!a || a === 'unresolved') return null;
    if (!st.rng.chance(0.8 * clamp01(e.wits))) return null;
    const r = 5 * e.length;
    const ang = st.rng.range(0, TAU), d = r * Math.sqrt(st.rng.next());
    return { ux: (a.x + Math.cos(ang) * d) / ex, uz: (a.z + Math.sin(ang) * d) / ez };
  }

  /* B4's revisit: nothing in the water, hungry, and smart enough to remember where dinner was. */
  pickMemory(e, now) {
    const st = this.stateFor(e);
    if (!st.memory.length || this.hasSensedFood(e)) return false;
    if (!(e.traits.hunger > 0.5)) return false;
    if (!st.rng.chance(0.5 * clamp01(e.wits))) return false;
    let best = st.memory[0];
    for (const m of st.memory) if (m.t > best.t) best = m;
    e.target.set(best.x, 0, best.z);
    e.coverSpot = { type: 'memory', x: best.x, z: best.z, holdUntil: 0 };
    return true;
  }

  /* B6. Crevices beat open sand: the cover pick is scored over candidate spots against the inflated
     envelopes, and each one carries the refuge id F4 will lock on. */
  creviceSpot(e, now) {
    const sys = this.sys;
    const st = this.stateFor(e);
    if (st.creviceAt !== sys.ticks || !st.crevice) { st.crevice = this.creviceCandidates(sys, e); st.creviceAt = sys.ticks; }
    const list = st.crevice;
    if (!list.length) return false;
    const head = e.head, r = e.radius;
    let best = null, bestScore = -Infinity;
    for (const c of list) {
      if (this.blockedLine(sys, e, head.x, head.z, c.x, c.z)) continue;
      let score = c.hard - this.claimsAt(sys, e, c, r * 2) + 2 * clamp01(sys.fear?.calmAt?.(c.x, c.z) ?? 0);
      score += st.rng.next() * 1e-3;   // seeded tie-break, small enough never to outrank a real surface
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return false;
    // The body lies along the surface, so the target sits on the contact side rather than on the point.
    e.target.set(best.x + best.nx * r * 0.5, 0, best.z + best.nz * r * 0.5);
    e.coverSpot = { type: 'rock', idx: best.idx, refuge: best.refuge, x: best.x, z: best.z, radius: r * 2 };
    return true;
  }

  creviceCandidates(sys, e) {
    const out = [];
    const r = e.radius, rocks = sys.colliders.spheres, logs = sys.colliders.logs;
    const env = (o) => (o.rHit ?? o.r) + r * 1.15;
    for (let i = 0; i < rocks.length; i++) {
      const o = rocks[i], ring = (o.rHit ?? o.r) + r * 1.5;
      for (let k = 0; k < 8; k++) {
        const a = k * TAU / 8;
        out.push({ x: o.x + Math.cos(a) * ring, z: o.z + Math.sin(a) * ring, nx: -Math.cos(a), nz: -Math.sin(a), idx: i, refuge: `rock:${i}` });
      }
      for (let j = i + 1; j < rocks.length; j++) {
        const p = rocks[j];
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
        const gap = d - env(o) - env(p);
        // The free gap, not the midpoint of the centers: overlapping piles have no midpoint worth sitting in.
        if (gap < 2.2 * r || gap > 1.5 || d < 1e-4) continue;
        const t = (env(o) + gap * 0.5) / d;
        out.push({ x: o.x + dx * t, z: o.z + dz * t, nx: 0, nz: 0, idx: i, refuge: `rockpair:${i}:${j}` });
      }
    }
    for (let i = 0; i < logs.length; i++) {
      const l = logs[i];
      const ax = l.b.x - l.a.x, az = l.b.z - l.a.z;
      const len = Math.hypot(ax, az);
      if (len < 1e-4) continue;
      const ux = ax / len, uz = az / len, nx = -uz, nz = ux;
      const ring = l.rOuter + r * 1.5;
      for (let s = 0; s <= len; s += 0.6) {
        const t = s / len;
        for (const side of [1, -1]) {
          out.push({
            x: l.a.x + ux * s + nx * side * ring, z: l.a.z + uz * s + nz * side * ring,
            nx: -nx * side, nz: -nz * side, idx: i, refuge: `log:${i}:${t < 0.5 ? 'a' : 'b'}`,
          });
        }
      }
      if (l.rInner > 0) {
        for (const [m, tag] of [[l.a, 'a'], [l.b, 'b']]) {
          for (const side of [1, -1]) {
            out.push({ x: m.x + nx * side * ring, z: m.z + nz * side * ring, nx: -nx * side, nz: -nz * side, idx: i, refuge: `log:${i}:${tag}` });
          }
        }
      }
    }
    // Reject anything already inside a body, then score by how much hard surface it can touch.
    const keep = [];
    for (const c of out) {
      if (this.insideEnvelope(sys, e, c.x, c.z)) continue;
      c.hard = this.hardness(sys, e, c.x, c.z);
      keep.push(c);
    }
    return keep;
  }

  insideEnvelope(sys, e, x, z) {
    const r = e.radius;
    for (const o of sys.colliders.spheres) if (Math.hypot(x - o.x, z - o.z) < (o.rHit ?? o.r) + r * 1.15) return true;
    for (const l of sys.colliders.logs) if (segDist2(x, z, l) < l.rOuter + r * 1.15) return true;
    return false;
  }

  /* The floor always counts one; every rock or log wall within r × 3 counts another. */
  hardness(sys, e, x, z) {
    const reach = e.radius * 3;
    let n = 1;
    for (const o of sys.colliders.spheres) if (Math.hypot(x - o.x, z - o.z) - (o.rHit ?? o.r) < reach) n++;
    for (const l of sys.colliders.logs) if (segDist2(x, z, l) - l.rOuter < reach) n++;
    return n;
  }

  /* Only a live rock occupant counts against a refuge: a memory sniff or a pad loiter has coordinates
     too, and an eel that left for a crumb or got slurped is not holding the hole. */
  claimsAt(sys, e, c, radius) {
    let n = 0;
    for (const o of sys.eels) {
      if (o === e || o.slurpedBy || o.coverSpot?.type !== 'rock') continue;
      if (o.coverSpot.refuge === c.refuge) { n++; continue; }
      if (Math.hypot(o.coverSpot.x - c.x, o.coverSpot.z - c.z) < radius) n++;
    }
    return n;
  }

  /* One-segment reject: a spot behind a rock or across a log is not cover, it is a detour. The maps
     route the rest. */
  blockedLine(sys, e, ax, az, bx, bz) {
    const r = e.radius;
    for (const o of sys.colliders.spheres) {
      if (segPoint(o.x, o.z, ax, az, bx, bz) < (o.rHit ?? o.r) + r * 1.15 - 1e-3) return true;
    }
    for (const l of sys.colliders.logs) {
      if (segSegDist(ax, az, bx, bz, l.a.x, l.a.z, l.b.x, l.b.z) < l.rOuter + r * 1.15 - 1e-3) return true;
    }
    return false;
  }

  // Context steering

  /* B2's danger ring, built at most once a tick so Jaz's legality test and the adapter agree. */
  buildDanger(sys, e, dt) {
    const st = this.stateFor(e);
    if (st.ringsTick === sys.ticks) return st;
    st.ringsTick = sys.ticks;
    const n = this.slots, rings = this.rings, danger = rings.danger;
    clearRings(rings);
    this.candidates.length = 0;
    this.obstAt = 0;
    const head = e.head, r = e.radius, focus = clamp01(e.focus);
    const look = lerp(0.5, 2.0, focus) * e.length + 0.45 * (e.speedMul - 1);
    st.look = look;
    st.tolerance = lerp(0.35, 0, focus);
    // An absolute floor beside the relative tolerance: a far rock's weak skirt lifts the ring's
    // minimum everywhere, and without this the maps would claim to be deciding on every tick.
    st.floor = Math.max(0, sys.knobs.brainFloor ?? BRAIN_FLOOR);
    st.blur = 2 * (1 - focus);

    for (const o of sys.colliders.spheres) {
      const dx = o.x - head.x, dz = o.z - head.z;
      const rc = o.rHit ?? o.r;
      const d = Math.hypot(dx, dz);
      const gap = d - rc - r;
      if (gap > look || d < 1e-4) continue;
      const top = o.y + o.r;
      const canClear = top < -r * 2.5;
      const S = clamp01(1 - Math.max(0, gap) / Math.max(look, 1e-4)) * (canClear ? 0.3 : 1);
      const alpha = Math.asin(Math.min(1, (rc + r + 0.1) / Math.max(d, 1e-4)));
      const thetaC = Math.atan2(dz, dx);
      this.writeObstacle(danger, thetaC, alpha, S, null);
      // The clear-water lift the legacy shove used to own; the depth reroll still overrides it later.
      if (canClear && d < rc + 0.6) e.targetY = Math.max(e.targetY, top + r * 1.5);
    }

    const berth = sys.lairGuest && e.quirks.follows !== sys.lairGuest.name ? 4 : 1;
    const bore = e.tunnel ? this.boreLog(sys, e) : null;
    for (const l of sys.colliders.logs) {
      const near = segNearest(head.x, head.z, l);
      const dx = near.x - head.x, dz = near.z - head.z;
      const d = Math.hypot(dx, dz);
      const rOut = l.rOuter * berth;
      const gap = d - rOut - r;
      if (gap > look || d < 1e-4) continue;
      const top = l.a.y + l.rOuter;
      const canClear = berth === 1 && top < -r * 2.5;
      const S = clamp01(1 - Math.max(0, gap) / Math.max(look, 1e-4)) * (canClear ? 0.3 : 1);
      const alpha = Math.asin(Math.min(1, (rOut + r + 0.1) / Math.max(d, 1e-4)));
      const thetaC = Math.atan2(dz, dx);
      // Tunnel-aware: the bore this eel is running is legal, but its walls still write.
      const skip = l === bore ? this.boreCarve(e, l, look) : null;
      this.writeObstacle(danger, thetaC, alpha, S, skip);
      if (canClear && d < l.rOuter + 0.6) e.targetY = Math.max(e.targetY, top + r * 1.5);
    }

    // Guarded rather than defaulted: an absent fear module would otherwise allocate an empty array a tick.
    const feared = sys.fear?.dangerWriters?.(e);
    if (feared) for (const w of feared) {
      const dx = w.x - head.x, dz = w.z - head.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4 || d - w.r > look) continue;
      this.writeField(danger, Math.atan2(dz, dx), Math.asin(Math.min(1, w.r / Math.max(d, 1e-4))), clamp01(w.strength));
    }

    // The view limit is a boundary, so the whole outward half reads as unwelcome rather than solid.
    if (Math.abs(head.x) > sys.view.w * 0.7) this.writeArc(danger, head.x > 0 ? 0 : Math.PI, Math.PI / 2, 0.8);
    if (Math.abs(head.z) > sys.view.h * 0.7) this.writeArc(danger, head.z > 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI / 2, 0.8);

    const flockR = e.length;
    // Two loops rather than a concat: this runs per eel per tick and the array would be garbage.
    for (const o of sys.eels) this.writeNeighbor(danger, e, o, flockR);
    for (const o of sys.guests) this.writeNeighbor(danger, e, o, flockR);

    // B7's side-eye writes a wide berth, not a wall: a grudge is a deliberate detour.
    for (const s of st.sideEye) {
      const dx = s.x - head.x, dz = s.z - head.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4 || d > look + 1.5) continue;
      this.writeField(danger, Math.atan2(dz, dx), Math.asin(Math.min(1, 0.6 / Math.max(d, 0.6))), SIDE_EYE_DANGER);
    }
    return st;
  }

  /* Nearest of head, mid, and tail: a long body is not a point, and the separation term already
     pushes, so this only stops a masked direction from pointing through a neighbor. */
  writeNeighbor(danger, e, o, flockR) {
    if (o === e || o.slurpedBy) return;
    const head = e.head, spine = this.spine;
    spine[0] = 0; spine[1] = o.pts.length >> 1; spine[2] = o.pts.length - 1;
    let bx = 0, bz = 0, bd = Infinity;
    for (const i of spine) {
      const p = o.pts[i];
      const d = Math.hypot(p.x - head.x, p.z - head.z);
      if (d < bd) { bd = d; bx = p.x; bz = p.z; }
    }
    if (bd > flockR || bd < 1e-4) return;
    this.writeField(danger, Math.atan2(bz - head.z, bx - head.x), Math.asin(Math.min(1, (o.radius + e.radius) / bd)), 0.25);
  }

  // Pooled records rather than a fresh object per writer: this runs ~25 times per eel per tick.
  record(ang, alpha, S, hard, flat) {
    const rec = this.obst[this.obstAt] ?? (this.obst[this.obstAt] = { ang: 0, alpha: 0, S: 0, hard: true, flat: false });
    rec.ang = ang; rec.alpha = alpha; rec.S = S; rec.hard = hard; rec.flat = flat;
    this.obstAt++;
  }

  /* One obstacle: the skirted silhouette on the ring, plus its two tangent directions as candidates.
     The inflation already carries the eel's radius plus 0.1, so riding that edge really does fit, and
     the nudge past it has to stay far under one slot or a gap narrower than a slot is stepped over. */
  writeObstacle(danger, thetaC, alpha, S, skip) {
    addDanger(danger, this.slots, thetaC, alpha, S, skip);
    this.record(thetaC, alpha, S, true, false);
    const out = alpha + TANGENT_EPS;
    this.candidates.push(thetaC + out, thetaC - out);
  }

  /* A skirted writer that is not a silhouette, so it spawns no tangent of its own but still masks
     anybody else's: feared bodies, neighbors, and the side-eye's berth. */
  writeField(danger, thetaC, alpha, S) {
    addDanger(danger, this.slots, thetaC, alpha, S);
    this.record(thetaC, alpha, S, false, false);
  }

  writeArc(danger, thetaC, half, S) {
    addDangerArc(danger, this.slots, thetaC, half, S);
    this.record(thetaC, half, S, false, true);
  }

  /* The log this eel's run belongs to; startTunnel keeps the mouths, so match on them. */
  boreLog(sys, e) {
    const t = e.tunnel;
    if (!t) return null;
    for (const l of sys.colliders.logs) {
      if (l.rInner <= 0) continue;
      if (l.a.distanceTo(t.entry) < 1e-3 || l.b.distanceTo(t.entry) < 1e-3) return l;
    }
    return sys.colliders.logs[0] ?? null;
  }

  boreCarve(e, l, look) {
    const carve = this.carve;
    carve.fill(0);
    const n = this.slots, head = e.head;
    const inner = l.rInner - e.radius;
    if (inner <= 0) return null;
    for (let k = 0; k < n; k++) {
      const a = slotAngle(k, n);
      const px = head.x + Math.cos(a) * Math.min(look, 1.5), pz = head.z + Math.sin(a) * Math.min(look, 1.5);
      if (segDist2(px, pz, l) < inner) carve[k] = 1;
    }
    return carve;
  }

  /* Jaz's cardinals are masked with the same test as everyone else's slots, never interest minus danger. */
  legal(e, ang) {
    const st = this.buildDanger(this.sys, e, 0);
    const n = this.slots, danger = this.rings.danger;
    let min = Infinity;
    for (let k = 0; k < n; k++) if (danger[k] < min) min = danger[k];
    const k = ((Math.round(ang / TAU * n) % n) + n) % n;
    return danger[k] <= Math.max(min + st.tolerance, st.floor);
  }

  dangerAt(e, ang) {
    this.buildDanger(this.sys, e, 0);
    const n = this.slots;
    const k = ((Math.round(ang / TAU * n) % n) + n) % n;
    return this.rings.danger[k];
  }

  routing(e) { return this.stateFor(e).routing; }

  boxed(e) { return this.stateFor(e).boxed; }

  deflection(e) { return this.stateFor(e).deflect; }

  /* Jaz's grid never reaches the adapter, so it files its own decision here: without this the brake
     and the overlay keep replaying whatever reroute her last non-Snake tick happened to make. */
  reportHeading(e, heading, forceAng, routed) {
    const st = this.stateFor(e);
    st.ctx = heading;
    st.routing = !!routed;
    st.deflect = routed ? Math.abs(wrapPi(heading - forceAng)) : 0;
    st.boxed = false;
    st.boxedFor = 0;
    st.boxedSide = 0;
    if (this.keepRings) {
      const n = this.slots;
      if (!st.dbgI || st.dbgI.length !== n) { st.dbgI = new Float64Array(n); st.dbgD = new Float64Array(n); }
      st.dbgI.fill(0);
      st.dbgD.set(this.rings.danger);
    }
  }

  /* The voluntary gait multiplier, tapered by how hard the reroute actually was: a bypassed or
     barely-bent tick pays nothing, and a full brakeAngle turn pays the whole knob. */
  brakeFor(e) {
    const st = this.stateFor(e);
    if (!st.routing || !(st.deflect > 0)) return 1;
    const sys = this.sys;
    const brake = sys.knobs.brake ?? BRAKE;
    const span = Math.max(1e-3, (sys.knobs.brakeAngle ?? BRAKE_ANGLE) * Math.PI / 180);
    return 1 - (1 - brake) * Math.min(1, st.deflect / span);
  }

  /* sys.headingAdapter. The ring machinery only decides anything when the force heading is blocked. */
  heading(sys, e, force, dt) {
    const st = this.buildDanger(sys, e, dt);
    const n = this.slots, rings = this.rings;
    const now = sys.time;
    const mag = Math.hypot(force.x, force.z);
    const forceAng = Math.atan2(force.z, force.x);
    addInterest(rings.interest, n, forceAng, mag);
    const cur = Math.atan2(e.heading.z, e.heading.x);
    const goal = e.target ? Math.atan2(e.target.z - e.head.z, e.target.x - e.head.x) : null;
    // A committed hunt vector gets no second-best: if the crumb is blocked, B5 owns the answer.
    const committed = !!(e.food && e.foodDist < 0.6) || now < e.burstUntil;
    const res = adapt({
      n, interest: rings.interest, danger: rings.danger, blurred: rings.blurred, scratch: rings.scratch,
      forceAng, tolerance: st.tolerance, floor: st.floor, blurRadius: st.blur,
      candidates: this.candidates, obstacles: this.obst, obstacleCount: this.obstAt,
      prevHeading: st.ctx ?? cur, blendA: 1 - Math.exp(-dt / 0.12),
      goalAng: committed ? null : goal,
      sweepFrom: e.quirks.leftOnly ? cur : null, sweepDir: -1,
      stickySide: st.boxedSide,
    });
    st.ctx = res.heading;
    st.routing = res.routing;
    st.boxed = res.boxed;
    // How far the maps actually moved the heading, not just whether they decided something: three
    // quarters of a cluttered pond's ticks route, but half of those barely turn at all.
    st.deflect = res.routing ? Math.abs(wrapPi(res.heading - forceAng)) : 0;
    if (this.keepRings) {
      if (!st.dbgI || st.dbgI.length !== n) { st.dbgI = new Float64Array(n); st.dbgD = new Float64Array(n); }
      st.dbgI.set(rings.interest); st.dbgD.set(rings.danger);
    }
    if (res.boxed) {
      st.boxedFor += dt;
      if (!st.boxedSide) st.boxedSide = res.side || 1;
      if (st.boxedFor > BOXED_LIMIT && !st.escape) this.startEscape(sys, e, st, now);
      // A saturated ring says nothing about which way is least bad, so today's shove decides instead
      // and the eel keeps moving rather than sitting in the pile waiting for the escape timer.
      if (res.min > 0.99) {
        const p = this.repulsion(sys, e, this.push);
        if (p.x * p.x + p.z * p.z > 1e-8) { st.ctx = Math.atan2(p.z, p.x); return st.ctx; }
      }
    } else { st.boxedFor = 0; st.boxedSide = 0; }
    // Every bounded yaw proposal lands here, so one validated nudge covers the side-eye's gaze and
    // Q-C's spin wobble alike rather than each reopening the legality boundary behind the solve.
    let nudge = 0;
    if (st.gaze) {
      const want = Math.atan2(st.gaze.z - e.head.z, st.gaze.x - e.head.x);
      const off = wrapPi(want - res.heading);
      nudge = Math.max(-SIDE_EYE_YAW, Math.min(SIDE_EYE_YAW, off)) * st.gaze.w;
    }
    nudge += sys.stim?.yawProposal?.(e) ?? 0;
    return res.heading + legalNudge(res.score, this.slots, res.heading, res.limit, nudge);
  }

  startEscape(sys, e, st, now) {
    st.escape = { until: now + ESCAPE_LIMIT, gone: 0, want: e.length, bore: !!e.tunnel };
    st.boxedFor = 0;
    this.blocked(e);
  }

  /* B2's dedicated reverse escape. Unlike the nope it never clears e.tunnel, so a run backs out of
     its own bore and keeps the mouths, the axis depth, and the run-out it already owns. */
  escapeTick(sys, e, dt) {
    const st = this.stateFor(e), esc = st.escape;
    if (!esc) return false;
    const now = sys.time;
    if (now > esc.until || e.trailCount <= 6) { this.endEscape(sys, e, st, now); return false; }
    e.reverse = true;
    e.stuckFor = 0;
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 8);
    const step = (sys.motion.reduced ? 0.28 : 0.8) * e.length * dt;
    retreatAlongTrail(e, step);
    esc.gone += step;
    e.wavePhase += Math.PI * 2 * 2.6 * dt;
    if (e.wavePhase > WAVE_WRAP) e.wavePhase -= WAVE_WRAP;
    e.ampMul += (1 - e.ampMul) * Math.min(1, dt * 6);
    e.uExcite.value += (0.6 - e.uExcite.value) * Math.min(1, dt * 3);
    e.squash += (1 - e.squash) * Math.min(1, dt * 5);
    e.uSquash.value = e.squash;
    if (e.tunnel) e.targetY = e.tunnel.entry.y;
    if (esc.bore) {
      // Not clear until the whole body is out of the bore: turning early drags it through the wall.
      const l = this.boreLog(sys, e);
      if (l && e.pts.every((p) => segDist2(p.x, p.z, l) > l.rOuter)) this.endEscape(sys, e, st, now);
    } else if (esc.gone >= esc.want) this.endEscape(sys, e, st, now);
    return true;
  }

  endEscape(sys, e, st, now) {
    const bore = st.escape?.bore;
    st.escape = null;
    st.boxedFor = 0;
    st.boxedSide = 0;
    e.reverse = false;
    // A second episode on the same crumb is the give-up trigger; otherwise just re-decide.
    if (st.giveUpOn && st.episodes >= 2) this.giveUp(sys, e, st, st.giveUpOn, now);
    else if (!bore) e.attnReset = true;
  }

  /* Today's rock and log shove, kept as the fallback heading for a pile with no legal slot at all. */
  repulsion(sys, e, out) {
    const head = e.head, look = 0.5 + 0.45 * (e.speedMul - 1);
    out.x = 0; out.z = 0;
    for (const o of sys.colliders.spheres) {
      const dx = head.x - o.x, dz = head.z - o.z;
      const d = Math.hypot(dx, dz), reach = (o.rHit ?? o.r) + look;
      if (d < reach && d > 1e-4) { const k = (1 - d / reach) * 2.5; out.x += (dx / d) * k; out.z += (dz / d) * k; }
    }
    for (const l of sys.colliders.logs) {
      const near = segNearest(head.x, head.z, l);
      const dx = head.x - near.x, dz = head.z - near.z;
      const d = Math.hypot(dx, dz), reach = l.rOuter + look;
      if (d < reach && d > 1e-4) { const k = (1 - d / reach) * 2.5; out.x += (dx / d) * k; out.z += (dz / d) * k; }
    }
    return out;
  }

  /* Read-only view for ?overlay=brain. The overlay draws, it never decides; the ring copies only
     exist once the flag has asked for them. */
  debug(e) {
    this.keepRings = true;
    const st = this.state.get(e);
    if (!st || !st.dbgI) return null;
    return {
      n: st.dbgI.length,
      interest: st.dbgI, danger: st.dbgD,
      heading: st.ctx, routing: st.routing, boxed: st.boxed, boxedFor: st.boxedFor, deflect: st.deflect,
      wits: e.wits, focus: e.focus, tolerance: st.tolerance, floor: st.floor, blur: st.blur, look: st.look,
      fresh: st.ringsTick,
    };
  }
}

/* B1. wits is stable per identity, focus is the per-tick version fear and sleep bleed out of. */
function witsOf(sys, e) {
  const pin = sys.pins.brain;
  if (pin !== null && pin !== undefined) return clamp01(pin);
  return clamp01((e.braincellUsage ?? 0.5) * (sys.knobs.brain ?? 1));
}

function focusOf(sys, e, now) {
  const holding = e.gait === 'hold' && now < e.gaitUntil;
  const deep = holding && e.gaitUntil - e.gaitFrom > 5;
  const asleep = deep && e.census?.twoAM === 'asleep' && !e.tunnel && !e.food && !e.restPose?.kind;
  const wake = e.buried ? 0 : asleep ? 0 : deep ? 0.1 : holding ? 0.3 : 1;
  const panic = clamp01(sys.fear?.panic?.(e) ?? 0);
  // Q-D's food-drunk multiplier, on this one line and nowhere else, so nothing compounds it.
  return clamp01(e.wits * wake * (1 - 0.6 * panic) * (foodDrunk(e) ? FOOD_DRUNK.focus : 1));
}

function segNearest(px, pz, l) {
  const ax = l.b.x - l.a.x, az = l.b.z - l.a.z;
  const len2 = ax * ax + az * az || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - l.a.x) * ax + (pz - l.a.z) * az) / len2));
  return { x: l.a.x + ax * t, z: l.a.z + az * t };
}

function segDist2(px, pz, l) {
  const n = segNearest(px, pz, l);
  return Math.hypot(px - n.x, pz - n.z);
}

function segPoint(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/* Closest approach of two 2D segments: zero if they cross, otherwise an endpoint, which is where the
   minimum has to sit once they do not. */
function segSegDist(ax, az, bx, bz, cx, cz, dx, dz) {
  const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz;
  const den = ux * vz - uz * vx;
  if (Math.abs(den) > 1e-12) {
    const wx = cx - ax, wz = cz - az;
    const t = (wx * vz - wz * vx) / den, s = (wx * uz - wz * ux) / den;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return 0;
  }
  return Math.min(
    segPoint(ax, az, cx, cz, dx, dz), segPoint(bx, bz, cx, cz, dx, dz),
    segPoint(cx, cz, ax, az, bx, bz), segPoint(dx, dz, ax, az, bx, bz),
  );
}

/* Box-Muller off the eel's own brain stream; the pair's second value is kept for the next draw. */
function gauss(st) {
  if (st.spare !== null) { const v = st.spare; st.spare = null; return v; }
  let u = st.rng.next();
  if (u < 1e-12) u = 1e-12;
  const r = Math.sqrt(-2 * Math.log(u)), th = TAU * st.rng.next();
  st.spare = r * Math.sin(th);
  return r * Math.cos(th);
}

function expireMap(map, now, life = 0) {
  for (const [k, t] of map) if (life ? now - t > life : now > t) map.delete(k);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

function cv(a) {
  const m = mean(a);
  if (Math.abs(m) < 1e-6) return Infinity;
  let v = 0;
  for (const x of a) v += (x - m) * (x - m);
  return Math.sqrt(v / a.length) / Math.abs(m);
}
