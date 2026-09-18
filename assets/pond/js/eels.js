import * as THREE from 'three/webgpu';
import { EEL_POINTS, DEPTH, BRAIN_SLOTS } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { TICK, TRAIL_LEN, segDist, pushTrail, followBody, collide, constrain, rememberPushes, tailAmp, growEel } from './eel-physics.js';
import { expire, pickTarget, steer } from './eel-behavior.js';
import { EelRenderer } from './eel-render.js';
import { drawCast, pickAbsent, applyIdentity, rollIdentityColors, rollIdentityPattern, rollNickname } from './eel-identity.js';
import { GLITTER_SCROLL_WRAP } from './eel-stars-core.js';
import { pushFingerSample, seedFingerHistory, tumbleFor } from './treats-core.js';

// How long a spook stays in sys.spooks. eel-fear.js ages its per-eel "already counted" ids on the same
// clock, because an id that nothing can re-observe anymore has no duplicate left to suppress.
export const SPOOK_LIFE = 1.6;

export class Eel {
  constructor(index, seed, extent, colliders, view, identity) {
    this.view = view;
    this.index = index;
    this.identity = identity;
    this.rng = createRng(deriveSeed(seed, 1000 + index));
    const rng = this.rng;
    // Identity sets name, build, speeds (in body lengths/s), and traits; the rolls below stay universal.
    applyIdentity(this, identity, rng);
    this.spacing = this.length / (EEL_POINTS - 1);
    this.baseLength = this.length;   // snake growth resets here after a SLURP
    this.ampRatio = rng.range(0.05, 0.07);   // tail-tip half-amplitude fraction; real eels run ~0.10 L but that thrashes at our scale
    this.ampTail = tailAmp(this);
    this.wavePhase = rng.range(0, Math.PI * 2);
    this.extent = extent;
    this.colliders = colliders;
    this.pts = [];
    this.prev = [];
    this.pose0 = [];           // last tick's solved pose, for render interpolation
    this.show = [];
    this.offsets = [];
    // Head history as a ring buffer: trailHead is the newest slot, trailCount how many are valid.
    this.trail = Array.from({ length: TRAIL_LEN }, () => new THREE.Vector3());
    this.trailHead = 0;
    this.trailCount = 0;
    // Spawn with the whole body clear of rocks and the log; a body born inside a wall starts life twitching out of it.
    let ang = 0, hx = 0, hz = 0;
    const y = rng.range(-DEPTH + 0.2, -0.2);
    for (let tries = 0; tries < 20; tries++) {
      ang = rng.range(0, Math.PI * 2);
      const dist = rng.range(view.h * 0.1, view.h * 0.55);
      hx = Math.cos(ang) * dist; hz = Math.sin(ang) * dist;
      const tx = hx - Math.cos(ang) * this.length, tz = hz - Math.sin(ang) * this.length;
      if (colliders.spheres.every((o) => segDist(o.x, o.z, hx, hz, tx, tz) > o.r + 0.5) &&
          colliders.logs.every((l) => segDist(l.a.x, l.a.z, hx, hz, tx, tz) > l.rOuter + 0.6 && segDist(l.b.x, l.b.z, hx, hz, tx, tz) > l.rOuter + 0.6 &&
            segDist((l.a.x + l.b.x) / 2, (l.a.z + l.b.z) / 2, hx, hz, tx, tz) > l.rOuter + 0.6)) break;
    }
    for (let i = 0; i < EEL_POINTS; i++) {
      this.pts.push(new THREE.Vector3(hx - Math.cos(ang) * i * this.spacing, y, hz - Math.sin(ang) * i * this.spacing));
      this.prev.push(this.pts[i].clone());
      this.pose0.push(this.pts[i].clone());
      this.show.push(this.pts[i].clone());
      this.offsets.push(new THREE.Vector3());
    }
    for (let i = EEL_POINTS - 1; i >= 0; i--) pushTrail(this, this.pts[i]);
    this.heading = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
    this.target = new THREE.Vector3();
    this.retargetAt = 0;
    this.speedMul = 1;
    this.fleeUntil = 0;
    this.squash = 1;
    this.slip = 1;   // collision glance factor on the snout; Eleanor runs 0.5 so she skids off scenery
    this.rippleAt = 0;
    this.food = null;
    this.tunnel = null;
    this.boreAt = -1e9;   // last run's start; the cooldown reads it, so a fresh eel is never on one
    this.targetY = y;
    this.retargetYAt = 0;
    this.gait = 'prowl';
    this.gaitUntil = 0;
    this.speedBL = this.prowlBL;
    this.waveK = 0;
    this.anterior = 0.3;
    this.ampMul = 1;
    this.reverse = false;
    this.nopeUntil = 0;
    this.coverSpot = null;
    this.flock = null;
    this.stuckFor = 0;
    this.nopeZig = 0;
    this.attnReset = false;
    this.roll = 0;             // unwrapped roll phase about the long axis; commitPose wraps the uniform
    this.glitterScroll = 0;    // accumulated fleck-field offset; the tick integrates it off speedBL
    // Per-eel clamp bounds. eel-air.js owns every change to them; collide() falls back to these same
    // numbers when no air module is attached, so a pond without it clamps exactly as it always did.
    this.floorY = -DEPTH + this.radius + 0.08;
    this.ceilingY = -this.radius * 0.5;
    // Tick Contract: who owns the eel this tick, and the pose overrides that owner may set. Both are
    // reset in the prepass, so a stale claim can never survive into the next tick.
    this.tick = { owner: null, tier: null };
    this.pose = { speed: null, targetY: null, ampMul: null, squash: null, roll: null, excite: null };
    this.slurpedBy = null;
    // Swap generation: a hot-swap reuses this object, so anything stored off the eel that must
    // outlive the tick (a crumb's claimant) records the name and this counter, never the reference.
    this.gen = 0;
    this.offscreenFor = 0;   // seconds the whole body has been out of view; 5 buys an identity swap
    this.rollColors(rng);
    this.rollPattern(rng);
    this.rollNick(rng);   // last, so the draw never shifts the color and pattern streams above it
  }

  rollColors(rng) { rollIdentityColors(this, this.identity, rng); }

  rollPattern(rng) { rollIdentityPattern(this, this.identity, rng); }

  rollNick(rng) { rollNickname(this, this.identity, rng); }

  get head() { return this.pts[0]; }
}

// The shim fans out across every type the pond emits; a new event type belongs here too. The tail of
// the list is the braincell wave's vocabulary: declared now, emitted by later chunks.
const EVENT_TYPES = [
  'startle', 'eat', 'slurp', 'nibble', 'swap', 'sing', 'headbutt', 'rescue', 'graze', 'tea', 'drop',
  'peek', 'splash', 'dig', 'bonk', 'gape', 'lunge', 'spin', 'scatter', 'moonbite', 'overit',
  'toss', 'void', 'huff', 'boop',
];
// Held-feed cadence: 250 BPM on the simulation clock, so the crumb stream is the same at 60 and 240 Hz.
const CRUMB_S = 60 / 250;
const FINGER_GRACE = 2;   // seconds a released hand stays familiar before familiarity starts decaying
const COMMOTION_FOR = 20;   // seconds of drops the commotion centroid averages over
const FINGER_V_AGE = 0.08;   // seconds a reported pointer velocity stays live; input.js's own speed window
// A recorded script enters below PondInput, so these map its vocabulary onto the same snapshot.
const SCRIPT_MODES = {
  poke: 'poke', 'drag-start': 'drag', 'drag-move': 'drag', 'drag-end': 'none',
  'feed-start': 'feed', 'feed-move': 'feed', 'feed-end': 'none',
};
const SCRIPT_STARTS = new Set(['poke', 'drag-start', 'feed-start']);

export class EelSystem {
  constructor(scene, U, shading, seed, extent, colliders, sim, motion, view, opts = {}) {
    this.view = view;
    this.scene = scene;
    this.U = U;
    this.shading = shading;
    this.sim = sim;
    this.motion = motion;          // { reduced: bool }
    this.extent = extent;
    this.colliders = colliders;
    this.rng = createRng(deriveSeed(seed, 5));
    // Live appearance layers, reachable as pond.eels.knobs; skin 0 is the pre-ramp look for an A/B.
    // The braincell wave's dials sit beside them, declared here and read by the modules that land later.
    this.knobs = {
      skin: 0.3, glow: 1.0,
      brain: 1, anticipation: 1, slots: BRAIN_SLOTS, brake: 0.7, brakeAngle: 30, brainFloor: 0.2,
      // 1.5 rather than 1: at 1 a grazing guest tops out at 0.49 panic, one hundredth under the
      // scatter line, and the dinner table never empties.
      // puffSize scales the silt billow's half-size, puffTrickle is seconds between buried puffs.
      fear: 1.5, stim: 1, spin: 1, moon: 1,
      // buriedEvict multiplies the spook line a buried eel is dug out by; buriedGrace is the seconds of
      // lesser pressure it sits through first. 1 and 0 restore the old evict-on-any-scare behavior.
      // relief scales the dig's dent in the sand, lean and shade together; 1 is the default depth, 0 is flat.
      air: { peek: 1, flop: 1, leap: 1, stamina: 1, moonbite: 1, puff: 1, puffSize: 1, grainSize: 1, puffTrickle: 0.8, buriedEvict: 2.5, buriedGrace: 1.8, relief: 1, spinLeap: 60, leapExcite: 0.2 },
      // F2a's finger clock in seconds, and F4's two contest caps (decisions 10 and 5).
      familiarity: { full: 12, grace: 2, forget: 25 },
      contestCap: { perOccupant: 30, perMinute: 3 },
      // Q-A to Q-C's taste dials. stim and spin above stay plain multipliers, as Part Five declares
      // them, so a primitive cannot carry these: bonk push in radii, its rate limit and aim, the meals.
      quirks: { bonkPush: 0.6, bonkEvery: 2, bonkNear: 1.2, bonkAngle: Math.PI / 3, gratitude: 3 },
      // The bore run: seconds without progress before a run gives up, the per-eel gap between runs
      // (snakeCool multiplies it for the grid swimmer), the odds per unit of cover, the crowding divisor,
      // and how far ahead the bore carve samples.
      tunnel: { stall: 6, cooldown: 45, odds: 0.3, crowd: 1.5, carve: 2.5, snakeCool: 2 },
      // The falling crumb (treats.js). Gravity is slowed because the real number reads as a teleport at
      // pond scale; toss takes no cap, and the pad thresholds are horizontal speeds in units/s.
      treat: {
        height: 1, gravity: 4.5, toss: 0.35, vHistTicks: 6, tell: 2.2, tellNorm: 2, tellRecent: 0.5,
        shadow: 0.35, scale: 1.2, airborneMax: 8, restMax: 8, maxFoods: 48,
        padBounceV: 1.2, padRestV: 0.3, padShedThreshold: 0.35,
        // Seconds a landed crumb rides the film before it starts down, by size bucket. A whole treat
        // has enough surface tension under it to sit there; a speck goes straight to the bottom.
        floatBig: 5, floatMid: 1.5,
        // The flutter's half-width in units and the seconds it eases in, so letting go is not a jump.
        sway: 0.09, swayIn: 1.2,
      },
      // The crush gag (eel-crush.js): roll odds, the join-in radius and its boost, the lane gap in body
      // lengths per member, the miss tolerance, fluster per miss, and the bout's clocks in seconds.
      crush: {
        odds: 1, joinRadius: 5, joinBoost: 1.6, gap: 1.0, laneTol: 0.6, flusterPer: 0.34,
        boutMax: 25, huff: 3, snub: 8, cool: 120, exitStagger: [0.3, 0.8], bonk: 1,
      },
      // The life bond (eel-bond.js): the pining meter's clocks in seconds, the two coins (null hands the
      // choice back to the identities), the stroll and rest spans, and the vigil kept on a guest.
      bond: {
        apart: [60, 120], farDist: 5, nearFill: 0.7, seekMax: 40, seekOdds: null, hello: 1.5, helloTwine: 0.75,
        stroll: [30, 90], strollHold: 0.6, strollRest: 0.05, leadOdds: null, twineBoost: 4, rest: [20, 60],
        restTogether: 2, loneRest: 0.5, cool: 45, apartPull: 0.5, keep: 0.5, guestNear: 6, panicCut: 0.35,
        vigilGap: 2.5, vigilMax: 30, brave: 0.15, reunionHellos: 3, forceWait: 90,
      },
    };
    this.pins = { brain: null, moon: null };   // ?brain= and ?moon=, filled by main through finite01
    // Registered behavior modules (eel-brain, eel-fear, eel-air): prepass(sys, dt) and initEel(sys, e).
    this.modules = [];
    // One pond-wide input snapshot, written by main from the pointer events and advanced on the
    // simulation clock in the prepass, so nothing about it follows the frame rate.
    // vHist is a short position history on the sim clock: input.js zeroes vx/vz at a press, so a throw
    // reading those would drop the first crumb of every click straight down.
    this.finger = { mode: 'none', gestureId: 0, x: 0, z: 0, vx: 0, vz: 0, speed: 0, stillFor: 0, heldFor: 0, releasedAt: -1e9, familiarity: 0, moveSeq: 0, vAge: 0, vHist: [] };
    this.held = null;              // live right-hold feed: { x, z, gestureId, next }
    this.inputHandlers = null;     // main's own pointer handlers, so a recorded script makes real side effects
    this.script = null;
    this.pokeRelease = null;       // tick a replayed poke lets go on; the fixture vocabulary has no release
    this.ticks = 0;                // simulation ticks since boot; the recorded-input player's clock
    this.spookId = 0;
    this.dropId = 0;
    this.eels = [];
    this.guests = [];              // Eleanor-class residents: own brain, shared physics and renderer
    this.allCast = this.eels;      // residents then guests, cached; see allOfCast()
    this.allCastN = -1;
    this.perfHot = false;          // set by main's frame-time watcher; gates guest visits
    this.rain = null;              // the shower scheduler, one shared reference: behavior reads its envelope
    this.habitat = null;           // the cover registry; pads become loiter targets once it is set
    this.graze = null;             // the herbivore menu (eel-graze.js); behavior calls it only for grazers
    this.tea = null;               // Matthew's kettle (eel-tea.js); behavior calls it only for tea drinkers
    this.braincell = null;         // eel-brain.js; sense, the context maps, memory, the tells
    this.fear = null;              // eel-fear.js; the fear map, scatter, refuge contests, alarm and calm
    this.stim = null;              // eel-quirks.js; stimming, bonks, spin feeding, the one roll owner
    this.treats = null;            // treats.js; the airborne crumb, its shadow, and the landing
    this.crush = null;             // eel-crush.js; the followers' failed attempts at Jaz's grid
    this.bond = null;              // eel-bond.js; the bonded couples finding each other and settling down
    this.headingAdapter = null;    // Chunk 1's context steering: (sys, e, force, dt) → desired heading angle
    // Everything smellable, keyed by kind. Crumbs register themselves in feed(); a fish school or a
    // dipping firefly registers the same shape with its own plume growth and plop radius.
    this.scents = [];
    this.feedRecent = 0;           // decaying feed-spree meter; the residents eat too fast for a stock check
    this.drops20 = [];             // the last COMMOTION_FOR seconds of drops, behind the commotion getter
    this.commotionPt = { x: 0, z: 0, amount: 0, n: 0 };
    this.commotionAt = 0;          // total amount in the window; 0 means no commotion at all
    this.spooks = [];              // { x, z, t, strength }
    this.lures = [];               // curiosity points from drags: { x, z, t }
    this.foods = [];               // { x, z, y, amount, mesh, claims }
    this.vortices = [];            // { x, z, t, strength, radius }
    this.time = 0;
    // Listeners live before the eels do: anything built below may already emit.
    this.listeners = new Map();    // type → fn[]
    this.shim = null;
    this.shimFn = null;
    this.renderer = new EelRenderer(scene, U, shading, this.knobs);
    this.knobs.jelly = this.renderer.jellyU;   // pond.eels.knobs.jelly.<dial>.value, tuned live
    // Same shape for Shelley's three families. forceClass (-1, or 0-2) and forceMetal (-1, 0 silver,
    // 1 gold) move a CPU grid, so they take applyKnobs(); every uniform dial is instant.
    this.knobs.families = this.renderer.familyU;
    this.group = this.renderer.group;
    // A pinned ?cast= is a test rig, so it also freezes the rotation; a seeded draw keeps swapping.
    this.debug = !!opts.debug;
    this.hotSwap = !opts.cast;   // null means no ?cast= at all; [] is a bare ?cast= that pins the seeded draw
    const cast = drawCast(seed, opts.cast ?? []);
    for (let i = 0; i < cast.length; i++) {
      const e = new Eel(i, seed, extent, colliders, view, cast[i]);
      pickTarget(this, e, 0);
      this.eels.push(e);
      this.renderer.buildMesh(e);
    }
    // Bonds resolve by name; a crush on someone not in the pond (Eleanor, for now) stays unrequited.
    for (const e of this.eels) {
      e.partner = e.quirks.follows ? this.eels.find((o) => o.name === e.quirks.follows) ?? null : null;
      e.flock = this.eels;
    }
    this.enabled = true;
  }

  endPrewarm() { this.renderer.endPrewarm(); }

  /* Subscribe/unsubscribe. Many consumers per type: a single assigned callback let the second one win. */
  on(type, fn) {
    const list = this.listeners.get(type);
    if (!list) this.listeners.set(type, [fn]);
    else if (!list.includes(fn)) list.push(fn);
  }

  off(type, fn) {
    const list = this.listeners.get(type);
    const i = list ? list.indexOf(fn) : -1;
    if (i >= 0) list.splice(i, 1);
  }

  /* One payload for every consumer: `source` is resident/guest, `kind` the species, pan precomputed,
     and `food` still carries the whole extra so every ev.food.<field> listener keeps working. */
  emit(type, eel, extra) {
    const list = this.listeners.get(type);
    if (!list || !list.length) return;
    const h = eel.head;
    this.send(list, {
      type,
      x: h.x, y: h.y, z: h.z,
      pan: this.panAt(h.x),
      source: this.guests.includes(eel) ? 'guest' : 'eel',
      kind: eel.kind ?? eel.identity?.kind ?? 'eel',
      size: extra?.size,
      length: eel.length,
      detail: extra?.detail ?? null,
      eel,
      food: extra ?? null,
    });
  }

  /* The same envelope for something the pond did rather than a creature: a crumb landing, later a
     splash with no author. No eel, so no length and no kind. */
  emitAt(type, x, y, z, extra) {
    const list = this.listeners.get(type);
    if (!list || !list.length) return;
    this.send(list, {
      type, x, y, z,
      pan: this.panAt(x),
      source: 'pond', kind: null,
      size: extra?.size, length: 0,
      detail: extra?.detail ?? null,
      eel: null,
      food: extra ?? null,
    });
  }

  // 0.8 keeps even edge-huggers a little off the speaker wall.
  panAt(x) { return Math.max(-1, Math.min(1, x / (this.view.w / 2))) * 0.8; }

  send(list, payload) { for (const fn of list.slice()) fn(payload); }

  /* Compatibility shim: one wrapper across every type, still called as (type, eel, food). */
  set onEvent(fn) {
    if (this.shim) for (const t of EVENT_TYPES) this.off(t, this.shim);
    this.shimFn = fn ?? null;
    this.shim = fn ? (p) => fn(p.type, p.eel, p.food) : null;
    if (this.shim) for (const t of EVENT_TYPES) this.on(t, this.shim);
  }

  get onEvent() { return this.shimFn; }

  setView(w, h) { this.view.w = w; this.view.h = h; for (const e of this.eels) { e.view.w = w; e.view.h = h; } }

  setEnabled(on) {
    this.enabled = on;
    this.renderer.setEnabled(on);
    // Simulation time keeps running while the eels are off, and a crumb left hanging over an empty
    // pond is a bug report: every flight resolves to its impact instead of freezing.
    if (!on) this.treats?.resolveAll();
    for (const m of this.modules) m.onEnabled?.(this, on);
    if (!on) for (const e of this.eels) {
      // Time keeps running while disabled, so an open exemption would resume mid-air after a long gap.
      this.air?.cancel(e);
      if (e.coverSpot?.type === 'ridge') this.habitat?.release(e.coverSpot.id);
      if (e.coverSpot?.type === 'pad' || e.coverSpot?.type === 'ridge') e.coverSpot = null;
    }
  }

  /* Interaction entry points (world xz). A spook carries an id (for a future habituation meter), a
     cause, `except` (everyone but this eel), and `only` (this eel alone, for a refuge lunge). */
  spook(x, z, strength = 1, opts = null) {
    this.spooks.push({
      id: ++this.spookId,
      cause: opts?.cause ?? 'poke',
      x, z, t: this.time, strength,
      except: opts?.except ?? null,
      only: opts?.only ?? null,
    });
    if (this.spooks.length > 16) this.spooks.shift();
  }
  lure(x, z) {
    this.lures.push({ x, z, t: this.time });
    if (this.lures.length > 40) this.lures.shift();
  }
  feed(x, z, amount = 1, opts = null) {
    // A crumb inside a rock is scored but unreachable, and six eels orbit the stone forever: slide it
    // to the rim. Logs are hollow and the bore is a legitimate dinner spot, so they keep theirs.
    for (const o of this.colliders.spheres) {
      const dx = x - o.x, dz = z - o.z, d = Math.hypot(dx, dz), want = o.r + 0.2;
      if (d >= want) continue;
      const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
      x = o.x + nx * want; z = o.z + nz * want;
    }
    // An airborne crumb is smelled, not eaten: it holds a scent entry and no mesh until land() runs.
    const air = opts?.air ?? null;
    const mesh = air ? null : this.renderer.createFoodMesh();
    if (mesh) { mesh.position.set(x, -0.05, z); this.group.add(mesh); }
    // Size bucket picks the eel-eat-* variant when the crumb finishes: 1 big, 2 crumb, 3 tiny.
    const size = amount >= 0.75 ? 1 : amount >= 0.3 ? 2 : 3;
    // The drop stream: a rhythm reader needs to know which crumb this was, which gesture made it,
    // and when it actually landed in simulation time rather than when a frame noticed it.
    const dropId = ++this.dropId;
    const crumb = {
      x, z, y: air ? air.y : -0.05, amount, size, mesh, claims: 0, claimedBy: null, contested: false, vy: 0, growPerAmt: 0.02,
      airborne: !!air, onPad: null,
      // mx/mz are where the mesh is drawn: the sinking flutter sways those and leaves x/z alone, so
      // the eels keep aiming at one anchor. sway is the flutter's heading, hashed off the id.
      mx: x, mz: z, sway: tumbleFor(dropId).phase, landedAt: opts?.t ?? this.time,
      dropId,
      gestureId: opts?.gestureId ?? this.finger.gestureId,
      origin: opts?.origin ?? 'click',
      t: opts?.t ?? this.time,
      // The scent fields: a crumb is its own registry entry, so a claim stays global on one object.
      kind: 'crumb', plop: 3.5,
    };
    if (!air) this.foods.push(crumb);
    this.scents.push(crumb);
    // The spree meter is what the airborne tell's recency reads, so it counts at the throw. Eleanor's
    // commotion centroid is about food that actually arrived, so a treat joins it at the splash.
    this.feedRecent += amount;
    if (!air) this.noteDrop(crumb);
    this.capFoods();
    return crumb;
  }

  noteDrop(crumb) {
    this.drops20.push({ x: crumb.x, z: crumb.z, amount: crumb.amount, t: this.time });
    this.recomputeCommotion();
  }

  /* Nothing that reads foods sees a crumb still in the air, which is the whole point: the eels smell
     it coming and cannot eat it. This is where it becomes real, and where the splash finally fires. */
  land(crumb) {
    if (!crumb || (!crumb.airborne && !crumb.onPad)) return crumb;
    crumb.airborne = false;
    crumb.onPad = null;
    crumb.y = -0.05;
    crumb.t = this.time;
    crumb.landedAt = this.time;   // the float-then-sink clock starts at the splash, not at the throw
    crumb.mx = crumb.x; crumb.mz = crumb.z;
    crumb.plop = 3.5;   // the pressure wave arrives for real; sense() runs its window from here
    if (!crumb.mesh) crumb.mesh = this.renderer.createFoodMesh();
    crumb.mesh.position.set(crumb.x, crumb.y, crumb.z);
    if (!crumb.mesh.parent) this.group.add(crumb.mesh);
    if (!this.foods.includes(crumb)) this.foods.push(crumb);
    if (!this.scents.includes(crumb)) this.scents.push(crumb);
    this.noteDrop(crumb);
    this.capFoods();
    this.emitAt('drop', crumb.x, crumb.y, crumb.z, {
      detail: { amount: crumb.amount, held: crumb.origin === 'held', tossed: true },
      dropId: crumb.dropId, t: crumb.t,
    });
    return crumb;
  }

  /* The void path: a crumb thrown clean off the pool never lands, so nobody may be left holding it. */
  unfeed(crumb) {
    if (!crumb) return;
    this.unscent(crumb);
    // The braincell holds this crumb in maps and per-eel arrays the scent registry knows nothing about.
    this.braincell?.forget(crumb);
    const i = this.foods.indexOf(crumb);
    if (i >= 0) this.foods.splice(i, 1);
    if (crumb.mesh) { this.group.remove(crumb.mesh); crumb.mesh = null; }
    crumb.amount = 0;
    crumb.airborne = false;
    crumb.onPad = null;
    crumb.claims = 0;
    crumb.claimedBy = null;
    for (const e of this.eels.concat(this.guests)) {
      if (e.food === crumb) e.food = null;
      if (e.bonkFood === crumb) e.bonkFood = null;
    }
  }

  /* The food cap goes out through the full removal path: an evicted crumb left claimed keeps its
     claimants circling a target that no longer exists, and a contest alive on nothing at all. */
  capFoods() {
    const cap = Math.max(1, (this.knobs.treat?.maxFoods | 0) || 48);
    while (this.foods.length > cap) this.unfeed(this.foods[0]);
  }

  /* Where the food is coming from: one amount-weighted point over the last twenty seconds, for a guest
     whose short nose can't smell individual crumbs. One reused record, recomputed only on change. */
  get commotion() {
    return this.commotionAt > 0 ? this.commotionPt : null;
  }

  recomputeCommotion() {
    let w = 0, x = 0, z = 0;
    for (const d of this.drops20) { w += d.amount; x += d.x * d.amount; z += d.z * d.amount; }
    this.commotionAt = w;
    if (w <= 0) return;
    const p = this.commotionPt;
    p.x = x / w; p.z = z / w; p.amount = w; p.n = this.drops20.length;
  }

  unscent(entry) {
    const i = this.scents.indexOf(entry);
    if (i >= 0) this.scents.splice(i, 1);
  }

  /* The right-hold feeder, moved off the wall clock: main opens the hold, the prepass drops the crumbs. */
  holdFeed(x, z) { this.held = { x, z, gestureId: this.finger.gestureId, next: this.time + CRUMB_S }; }
  moveFeed(x, z) { if (this.held) { this.held.x = x; this.held.z = z; } }
  endFeed() { this.held = null; }
  vortex(x, z, radius) {
    this.vortices.push({ x, z, t: this.time, radius: Math.max(radius, 1.2), strength: 1 });
  }
  recolor() {
    for (const e of this.eels) {
      // Inside Eleanor the fear tick is paused, so a comfort-stop snapshot taken now would be restored
      // over whatever the eel wears after the spit; it keeps its look until it is back in the water.
      if (e.slurpedBy) continue;
      // F6's comfort stop: a spammed eel keeps what it is wearing, and skipping it before the rolls
      // is what stops the veto from shifting everybody else's appearance too.
      if (this.fear && !this.fear.noteRecolor(this, e)) continue;
      e.rollColors(this.rng);
      e.rollPattern(this.rng);
      e.rollNick(this.rng);
      this.renderer.applyAppearance(e);
    }
    this.applyKnobs();
  }

  /* Trade one resident for an identity nobody is wearing. Only ever called off-screen, so a whole new
     build, palette, and length can land in a single frame without anything popping in view. */
  swapIdentity(e, id = null) {
    if (!e || e.slurpedBy) return false;
    const names = this.eels.map((o) => o.name);
    // A named swap (console) still has to obey the pool: active, and not already on screen.
    if (id && (id.active === false || names.includes(id.name))) return false;
    const to = id ?? pickAbsent(this.rng, names);
    if (!to) return false;
    const from = e.name, oldLen = e.length;
    e.gen++;   // the body is reused; the generation is what tells the outgoing eel's records apart
    // A braid does not survive one of its strands turning into someone else.
    if (e.twine) { for (const m of e.twine.members) if (m.twine === e.twine) m.twine = null; }
    e.identity = to;
    applyIdentity(e, to, e.rng);
    // applyIdentity rolls the new length straight onto the eel; growEel is the only path that carries
    // spacing, ampTail, and the trail buffer with it, so hand the delta back through it.
    const want = e.length;
    e.length = oldLen;
    growEel(e, want - oldLen);
    e.baseLength = e.length;
    e.uRadius.value = e.radius;
    // The clamp band is a function of the radius that just changed. eel-air.js rewrites these with the
    // same numbers in the initEel loop below, but a pond without it would keep the old eel's floor.
    e.floorY = -DEPTH + e.radius + 0.08;
    e.ceilingY = -e.radius * 0.5;
    for (const m of e.eyes) m.scale.setScalar(e.radius * 0.2);
    e.rollColors(e.rng);
    e.rollPattern(e.rng);
    e.rollNick(e.rng);
    this.renderer.applyAppearance(e);
    // The plan belonged to the eel who left: drop the crumb claim, the perch, and the run. A ridge
    // claim lives in the habitat rather than on the eel, so it has to be handed back explicitly.
    if (e.food) { e.food.claims = Math.max(0, e.food.claims - 1); e.food = null; }
    if (e.coverSpot?.type === 'ridge') this.habitat?.release(e.coverSpot.id);
    e.coverSpot = null;
    e.tunnel = null;
    e.gaitUntil = 0;
    e.retargetAt = 0;
    e.speedBL = e.prowlBL;
    // Every module wipes its own Map entry here, which is why new per-eel state never goes in initQuirkState.
    for (const m of this.modules) m.initEel?.(this, e);
    // Whole flock, not just the swapped eel: someone's partner may have just walked out of the pond.
    for (const o of this.eels) {
      o.partner = o.quirks.follows
        ? this.eels.find((p) => p.name === o.quirks.follows) ?? this.guests.find((g) => g.name === o.quirks.follows) ?? null
        : null;
      // A grudge, a rescue, or a crush aimed at the eel who left does not transfer to the newcomer.
      if (o.buttTo === e) o.buttTo = null;
      if (o.rescueTo === e) o.rescueTo = null;
      if (o.cuddle?.with === e) o.cuddle.until = 0;
      if (o.snuggle?.with === e) o.snuggle.with = null;
    }
    for (const g of this.guests) if (g.prey === e) g.prey = null;
    this.emit('swap', e, { from, to: e.name });
    return true;
  }

  /* Behavior modules register here rather than being assigned by name, so the prepass and the
     per-eel init hooks fire in registration order and a hot-swap can wipe their state for them. */
  addModule(mod) {
    if (!mod || this.modules.includes(mod)) return mod;
    this.modules.push(mod);
    for (const e of this.eels) mod.initEel?.(this, e);
    for (const g of this.guests) mod.initEel?.(this, g);
    return mod;
  }

  /* Recorded input, debug only: { tick, type, x, z, amount } entries fire through main's own pointer
     handlers (real side effects), with ticks counted from this call so a fixture always reproduces. */
  playInput(script) {
    this.script = Array.isArray(script) && script.length ? script.slice().sort((a, b) => a.tick - b.tick) : null;
    this.scriptAt = 0;
    // tick() increments before the prepass runs runScript, so the next one is the fixture's tick 0;
    // anchoring on the current count collapses recorded ticks 0 and 1 onto the same prepass.
    this.scriptFrom = this.ticks + 1;
    this.scriptPrev = null;
    this.replaying = !!this.script;  // sticks after the last event, so the fixture's tail stays clean
    this.pokeRelease = null;
    // Replay owns the cursor history from here: whatever the live hand was doing must not become the
    // launch velocity of the fixture's first toss.
    this.finger.vHist.length = 0;
    return !!this.script;
  }

  /* A discrete poke has no matching release in the fixture vocabulary, so it lets go of its own
     accord; without this a fixture that ends on one leaves an immortal, ever-more-familiar hand. */
  releaseScriptPoke() {
    if (this.pokeRelease === null || this.ticks < this.pokeRelease) return;
    this.pokeRelease = null;
    const f = this.finger;
    if (f.mode !== 'poke') return;
    f.mode = 'none';
    f.vx = 0; f.vz = 0; f.speed = 0;
    f.heldFor = 0; f.stillFor = 0;
    this.scriptPrev = null;
  }

  runScript() {
    this.releaseScriptPoke();
    const s = this.script;
    if (!s) return;
    const rel = this.ticks - this.scriptFrom;
    while (this.scriptAt < s.length && s[this.scriptAt].tick <= rel) {
      const ev = s[this.scriptAt++];
      this.scriptFinger(ev);
      this.inputHandlers?.[ev.type]?.(ev.x ?? 0, ev.z ?? 0, ev.amount);
    }
    if (this.scriptAt >= s.length) this.script = null;
  }

  /* A scripted gesture enters below PondInput, so it publishes its own snapshot: the rhythm reader
     keys on gestureId, and every crumb a fixture drops has to belong to a gesture. */
  scriptFinger(ev) {
    const f = this.finger;
    const mode = SCRIPT_MODES[ev.type];
    if (mode === undefined) return;
    // Published before the handler runs, so a crumb fed on this entry already carries the right id.
    const starting = SCRIPT_STARTS.has(ev.type);
    if (starting) { f.gestureId++; f.heldFor = 0; }
    const x = ev.x ?? 0, z = ev.z ?? 0;
    // Velocity comes off the fixture's own cadence, never off whatever real flick preceded the replay:
    // without this a scripted swipe reads as a standing hand to the speed-sensitive fear and stim paths.
    const prev = starting || mode === 'none' ? null : this.scriptPrev;
    const span = prev ? (ev.tick - prev.tick) * TICK : 0;
    if (span > 0) { f.vx = (x - prev.x) / span; f.vz = (z - prev.z) / span; f.speed = Math.hypot(f.vx, f.vz); }
    else if (!prev) { f.vx = 0; f.vz = 0; f.speed = 0; }
    f.vAge = 0;
    this.scriptPrev = mode === 'none' ? null : { x, z, tick: ev.tick };
    // Armed by a poke, disarmed by anything else on the same tick: a drag or a feed opened over it is
    // a deliberate hold and must not be released a tick later.
    this.pokeRelease = ev.type === 'poke' ? this.ticks + 1 : null;
    f.mode = mode;
    if (mode !== 'none') { f.x = x; f.z = z; f.stillFor = 0; f.moveSeq++; }
    // The throw's history, written before the handler that reads it. A gesture start wipes the window
    // so the launch cannot inherit anything from before the replay; an entry may name its own vx/vz,
    // which is the only way a recorded fast click reproduces (the vocabulary has no hover sample).
    if (starting) f.vHist.length = 0;
    if (Number.isFinite(ev.vx) && Number.isFinite(ev.vz)) {
      seedFingerHistory(f.vHist, f.x, f.z, ev.vx, ev.vz, this.time, (this.vHistTicks - 1) * TICK);
      f.vx = ev.vx; f.vz = ev.vz; f.speed = Math.hypot(ev.vx, ev.vz);
    } else this.sampleFinger();
  }

  get vHistTicks() { return Math.max(2, Math.min(32, (this.knobs.treat?.vHistTicks | 0) || 6)); }

  /* A hand over the water with no button down. Position only: mode, gestureId, and the press clocks
     all belong to a real gesture, but the next tick's sample has to see the hand actually moving or
     a fast click inherits nothing. A replay owns the cursor outright, so it ignores the live one. */
  hoverFinger(x, z, gap = false) {
    if (this.replaying || !Number.isFinite(x) || !Number.isFinite(z)) return;
    // A cursor back from outside the window teleported; its old samples would read as a throw.
    if (gap) this.finger.vHist.length = 0;
    this.finger.x = x;
    this.finger.z = z;
  }

  /* Sampled on the tick rather than on pointer events, and regardless of press state. runScript()
     runs after this, so a scripted move corrects the sample this tick already took. */
  sampleFinger() {
    const f = this.finger;
    pushFingerSample(f.vHist, f.x, f.z, this.time, this.vHistTicks);
  }

  /* F2a's finger clock. Familiarity rises while the hand is in the water, holds through a short
     grace after release (so a re-click continues where it left off), then decays. */
  advanceFinger(dt) {
    const f = this.finger;
    f.stillFor += dt;
    // Velocity only arrives on a pointermove, so a hand that stops moving would report its last
    // flick forever and later read as a fast finger.
    f.vAge += dt;
    if (f.vAge > FINGER_V_AGE) { f.vx = 0; f.vz = 0; f.speed = 0; }
    this.sampleFinger();
    const k = this.knobs.familiarity ?? null;
    const full = k?.full > 0 ? k.full : 12, grace = k?.grace ?? FINGER_GRACE, forget = k?.forget > 0 ? k.forget : 25;
    // Over the water, not merely down: a mouse dragged off the pond keeps the gesture alive, and time
    // spent out there is not time the eels spent getting used to a hand.
    const over = Math.abs(f.x) <= this.view.w * 0.5 && Math.abs(f.z) <= this.view.h * 0.5;
    if (f.mode !== 'none') {
      f.heldFor += dt;
      f.releasedAt = this.time;
      if (over) f.familiarity = Math.min(1, f.familiarity + dt / full);
    } else {
      f.heldFor = 0;
      if (this.time - f.releasedAt > grace) f.familiarity = Math.max(0, f.familiarity - dt / forget);
    }
  }

  /* Catch-up loop, not one crumb a tick: a slow frame owes several, and each keeps the scheduled
     simulation time it was owed at rather than the tick that noticed it. */
  dropHeld() {
    const h = this.held;
    if (!h) return;
    while (h.next <= this.time) {
      const opts = { origin: 'held', gestureId: h.gestureId, held: true, t0: h.next };
      // With treats attached the ring and the plop come from the landing instead; without it the
      // stream keeps the old shape, so a pond built without the module still feeds.
      if (this.treats) this.treats.toss(h.x, h.z, 0.35, opts);
      else {
        const crumb = this.feed(h.x, h.z, 0.35, { origin: 'held', gestureId: h.gestureId, t: h.next });
        this.emitAt('drop', crumb.x, crumb.y, crumb.z, { detail: { held: true, amount: 0.35 }, dropId: crumb.dropId, t: crumb.t });
      }
      h.next += CRUMB_S;
    }
  }

  /* Push the live skin/glow layers at everyone, guests included, after tweaking pond.eels.knobs. */
  applyKnobs() {
    const { skin, glow } = this.knobs;
    for (const e of this.eels) e.uLayers.value.set(skin * e.skinMul, glow);
    for (const g of this.guests) g.uLayers.value.set(skin * g.skinMul, glow);
    for (const e of this.allOfCast()) if (e.uStars) this.renderer.pushFamilies(e);
  }

  /* The glitter lags the body the way the liquid lags a water wiggler's tube: an accumulated scroll,
     not a rate, so changing speed slides the fleck field instead of teleporting it. */
  driftGlitter(all, dt) {
    const g = this.knobs.families?.glitter;
    if (!g) return;
    const base = g.base.value, lag = g.lagGain.value;
    for (const e of all) {
      if (!e.uGlitter) continue;
      // The wrap is a whole number of hash periods for both fleck grids, so nothing pops when it lands.
      e.glitterScroll = (e.glitterScroll + (base + e.speedBL * lag) * dt) % GLITTER_SCROLL_WRAP;
      e.uGlitter.value.w = e.glitterScroll;
    }
  }

  /* Fixed-rate solve: the chain and its collision memory behave the same at 60 and 240 Hz. */
  update(dt) {
    if (!this.enabled) { this.time += dt; return; }
    this.acc = Math.min((this.acc || 0) + dt, TICK * 3);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick(TICK);
    }
    this.renderer.sync(this.eels, this.foods, this.acc / TICK);
    for (const g of this.guests) this.renderer.syncGuest(g, this.acc / TICK);
  }

  /* Tick Contract step 1: everything the whole pond agrees on before any eel decides anything. */
  prepass(dt, all) {
    for (const e of all) {
      for (let i = 0; i < EEL_POINTS; i++) e.pose0[i].copy(e.pts[i]);
      // A slurped eel forgets its pad or its ridge; nothing else clears a hold it cannot keep, and
      // a ridge perch is a claim in the habitat, so dropping the spot alone would leak it forever.
      if (e.slurpedBy && (e.coverSpot?.type === 'pad' || e.coverSpot?.type === 'ridge')) {
        if (e.coverSpot.type === 'ridge') this.habitat?.release(e.coverSpot.id);
        e.coverSpot = null;
      }
      e.tick.owner = null; e.tick.tier = null;
      const p = e.pose;
      p.speed = p.targetY = p.ampMul = p.squash = p.roll = p.excite = null;
    }
    this.advanceFinger(dt);
    this.runScript();
    this.dropHeld();
    for (const m of this.modules) m.prepass?.(this, dt);
  }

  /* Nobody ever leaves either roster, so a length change is the only way the joined cast can differ.
     Eleanor is parked rather than removed, so the old per-tick concat ran forever once she arrived. */
  allOfCast() {
    const n = this.eels.length + this.guests.length;
    if (this.allCastN !== n) {
      this.allCast = this.guests.length ? this.eels.concat(this.guests) : this.eels;
      this.allCastN = n;
    }
    return this.allCast;
  }

  tick(dt) {
    this.time += dt;
    this.ticks++;
    const all = this.allOfCast();
    this.prepass(dt, all);
    for (const e of all) if (!e.slurpedBy) (e.brain || steer)(this, e, dt);
    // The cast rotates where nobody is looking: every spine point (halo included) past the view rectangle.
    // A head-only test with a body-length margin sat beyond the 0.7-view turn-back line on the short axis.
    const hw = this.view.w * 0.5, hh = this.view.h * 0.5;
    for (const e of this.eels) {
      if (e.slurpedBy || e.tunnel) continue;
      const r = e.radius * 2.5;
      const off = e.pts.every((p) => Math.abs(p.x) > hw + r || Math.abs(p.z) > hh + r);
      e.offscreenFor = off ? e.offscreenFor + dt : 0;
      if (this.hotSwap && e.offscreenFor >= 5) { this.swapIdentity(e); e.offscreenFor = 0; }
    }
    for (const e of all) if (!e.slurpedBy) followBody(e);
    for (const e of all) for (let i = 0; i < EEL_POINTS; i++) e.prev[i].copy(e.pts[i]);
    collide(all, this.colliders);
    for (const e of all) if (!e.slurpedBy) constrain(e);
    for (const e of all) if (!e.slurpedBy) rememberPushes(e);
    this.surfaceContact(all, dt);
    this.driftGlitter(all, dt);
    if (this.debug) this.sweepNaN(all);
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i];
      this.sinkFood(f, dt);
      if (f.amount <= 0) { this.group.remove(f.mesh); this.foods.splice(i, 1); this.unscent(f); }
    }
    this.feedRecent *= Math.exp(-dt / 6);
    if (this.drops20.length && this.time - this.drops20[0].t > COMMOTION_FOR) {
      while (this.drops20.length && this.time - this.drops20[0].t > COMMOTION_FOR) this.drops20.shift();
      this.recomputeCommotion();
    }
    expire(this.spooks, this.time, SPOOK_LIFE);
    expire(this.lures, this.time, 9);
    expire(this.vortices, this.time, 7);
  }

  /* A whole treat has enough surface tension under it to ride the film for a while; a speck goes
     straight down. Once it lets go it flutters rather than dropping on a rail: the sway is the mesh's
     alone (mx/mz), because x/z is the anchor every eel aims at and a 3 cm wobble on that jitters the
     approach vector, the claim scores, and B5's no-progress clock. */
  sinkFood(f, dt) {
    const k = this.knobs.treat;
    const hold = f.size === 1 ? (k?.floatBig ?? 5) : f.size === 2 ? (k?.floatMid ?? 1.5) : 0;
    const since = this.time - (f.landedAt ?? this.time);
    if (since < hold) {
      f.y = -0.05 + Math.sin(this.time * 1.4 + f.sway) * 0.012;
      f.mx = f.x; f.mz = f.z;
      return;
    }
    f.y = Math.max(-DEPTH + 0.05, f.y - dt * 0.12);
    // Eased in from the let-go and gone by the floor, so it lands where the eels were told.
    const fadeIn = Math.min(1, (since - hold) / Math.max(0.05, k?.swayIn ?? 1.2));
    const amp = (k?.sway ?? 0.09) * fadeIn * fadeIn * (3 - 2 * fadeIn) * Math.max(0, Math.min(1, (f.y + DEPTH - 0.05) / DEPTH));
    const s = Math.sin(this.time * 1.4 + f.sway) * amp;
    f.mx = f.x + Math.cos(f.sway) * s;
    f.mz = f.z + Math.sin(f.sway) * s;
  }

  /* Every animal breaks the film for real: any spine point that crossed the water plane since last tick
     rings the sim where it crossed, whatever behavior moved it. One ring per eel per tick, at the centroid. */
  surfaceContact(all, dt) {
    const sim = this.sim;
    if (!sim) return;
    const reduce = this.motion?.reduced ? 0.5 : 1;
    for (const e of all) {
      if (e.slurpedBy) continue;
      let n = 0, sx = 0, sz = 0, vy = 0;
      // The air module rings every tracked head itself (peek and leap sizes), guests included; the body is ours.
      for (let i = this.air ? 1 : 0; i < EEL_POINTS; i++) {
        const y0 = e.pose0[i].y, y1 = e.pts[i].y;
        const dy = Math.abs(y1 - y0);
        // A teleport (a park, a swap) is not a splash.
        if ((y0 < 0) === (y1 < 0) || dy > 0.5) continue;
        n++; sx += e.pts[i].x; sz += e.pts[i].z; vy = Math.max(vy, dy / dt);
      }
      if (!n) continue;
      // A body sliding over a crest crosses at a crawl, so the floor is the old flop ring; only the
      // vertical speed above that scales it up, to the leap's landing slap.
      const s = Math.min(0.06, 0.02 + 0.02 * vy) * Math.min(2, 1 + (n - 1) * 0.25) * reduce;
      sim.addDrop(sx / n, sz / n, 0.4 + e.radius * (1 + Math.min(3, n - 1) * 0.3), s);
    }
  }

  /* Debug-only tripwire: a NaN anywhere in a chain spreads through constrain() and the eel simply
     vanishes; Eleanor's first depart once hid that way for a whole rescue cycle. Warns once per eel. */
  sweepNaN(all) {
    for (const e of all) {
      let sum = 0;
      for (const p of e.pts) sum += p.x + p.y + p.z;
      if (Number.isFinite(sum)) { e.nanWarned = false; continue; }
      if (e.nanWarned) continue;
      e.nanWarned = true;
      const i = e.pts.findIndex((p) => !Number.isFinite(p.x + p.y + p.z));
      console.warn(`[eels] ${e.name ?? 'guest'} chain went NaN at point ${i} (t=${this.time.toFixed(2)})`, e);
    }
  }

  dispose() { this.renderer.dispose(this.eels.concat(this.guests)); }
}
