import * as THREE from 'three/webgpu';
import { DEPTH } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { paceWave, commitPose, claimTick } from './eel-behavior.js';
import { floorHeightAt, floorSurfaceAt, sandColorAt, sandAlbedoAt } from './floor.js';
import { RELIEF_HEAL_TAU } from './relief-core.js';
import { moonBrightAt, leapForm, leapArc, leapDistance, landingClear, crestHeight, knob, clamp01 } from './eel-air-core.js';

/* Verticality: every state that leaves the water column's comfort band. Peek, log flop, ballistic
   leap, burrow with dig puffs, and the moon bite, plus the per-eel moon mood the rest of the pond
   reads. Mounted as sys.air; the per-eel bounds in eel-physics.js belong to this module alone. */

const AIR_SALT = 3100;        // per-eel behavioral stream: one salt per slot, never per identity
const SEDIMENT_SALT = 3170;   // decorative puffs, so a reduced-motion run cannot shift a decision

const PEEK_LIFT = 0.9;        // snout height above the film, in radii
const PEEK_BL = 0.05;         // both the creep and the rise rate, in body lengths a second
const PEEK_TIME = [1, 4];
const AIR_CAP = 4;            // seconds above the film before the descent is forced
const AIR_DRAIN = 0.5;
const COOL = [20, 60];
const RECOVER_SPEED = 0.8;    // times prowl; a peek's own 0.05 BL/s would take twenty seconds to drain
const RECOVER_TOL = 0.005;
const RECOVER_WATCH = 1.5;
const RECOVER_DEADLINE = 6;
const RECOVER_EXTRA = 3;      // the defined fallback: one body length deeper at cruise, then snap
const FLOP_SPEED = 1.2;       // times prowl
const FLOP_SCARE = 1.6;
const FLOP_GIVEUP = 12;
const FLOP_EXIT = 3;          // hard cap on the timeout's run for the far side, so it always reaches recovery
const CLIMB_RATE = 2;         // world units a second the flop's head may climb; well over the crest's own slope
const FLOP_STUCK_WINDOW = 20; // a second stuck event against the same log inside this flops anyway
const FLOP_COOL = 8;          // a drowned crest never breaks the film, so it earns no air cooldown
const LEAP_LAUNCH = 0.8;
const LEAP_AMP = 0.4;         // a leaping body is stiff
const BELLY_AMP = 1.3;
const BELLY_RING = 1.6;
const DIG_ONE = 1.5, DIG_TWO = 1;
const DIG_ONE_MAX = 6;        // dig1 is a goal now, so this is only the give-up deadline
const DIG_HALO = 0.15;        // the additive shell blooms through the sand as a bright ball
const DIG_TRICKLE = 0.8;      // seconds between the buried hold's idle billows
const SILT_TINT = [0.85, 1.0, 1.35];   // silt catching moonlight, not the sand it came from
const DIG_SLOPE = 20 * Math.PI / 180;
const DIG_YAW1 = 25 * Math.PI / 180, DIG_HZ1 = 4;
const DIG_YAW2 = 15 * Math.PI / 180, DIG_HZ2 = 2;
const DIG_BUDGET = { one: [20, 24], two: [6, 4], wake: [6, 16] };
// The sand relief. RELIEF_R is one spine stamp's Gaussian radius in world units, RELIEF_RIDGE the
// mound's height in body radii, RELIEF_TROUGH what the exit leaves as a fraction of that mound.
const RELIEF_R = 0.45, RELIEF_RIDGE = 0.5, RELIEF_TROUGH = 0.6;
const RELIEF_TICK = 0.1;      // restamp cadence; the heal over one of these is under a thousandth
const TROUGH_PUFF = 1.6;      // seconds between trickle puffs at full depth, stretching as it fills
const TROUGH_DONE = 0.1;      // remaining depth at which a trough stops earning silt
const TROUGH_MAX = 4;         // healing troughs followed at once
const SCARE_R = 3.5, SCARE_AT = 0.35;   // the open-water spook test: reach, and the intensity that turns an eel scared
// Sand is cover. A buried eel needs a spook this many times over that line to be dug out on the spot,
// or that much pressure sustained; one poke lives 1.6 s, so a lone distant one leaves it where it is.
const BURIED_EVICT = 2.5, BURIED_GRACE = 1.8;
const BITE_COOL = 300;
const BITE_TIMEOUT = 12;
const BITE_REACH = 0.4;
const MOON_SPOT = 3.0;        // surface.js's uMoonSpot default, until main publishes the live anchor
const FINGER_PEEK_REACH = 1.5, FINGER_PEEK_STILL = 1.5;

const tmp = new THREE.Vector3();
const sandRGB = [0, 0, 0];

function maxY(e) { let m = -Infinity; for (const p of e.pts) if (p.y > m) m = p.y; return m; }
function minY(e) { let m = Infinity; for (const p of e.pts) if (p.y < m) m = p.y; return m; }
function wrapPi(a) { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a; }

export function attachAir(sys, seed) {
  const air = new AirStates(sys, seed);
  sys.air = air;
  sys.addModule(air);
  return air;
}

export class AirStates {
  constructor(sys, seed) {
    this.sys = sys;
    this.seed = seed;
    this.map = new Map();
    this.puffRng = createRng(deriveSeed(seed, SEDIMENT_SALT));
    this.anchor = { x: 0, z: 0, ok: false };
    this.troughs = [];      // { trail, t0, puffAt } per exit, so the silt can follow the sand closing
    this.recoveries = [];   // { name, took, hitDeadline }, kept only under ?debug=1
  }

  // Live knobs, read every call so the console can tune mid-night.
  k(name) { return knob(this.sys.knobs?.air?.[name], 1); }
  kMoon() { return knob(this.sys.knobs?.moon, 1); }

  state(e) { return this.map.get(e) ?? null; }

  /* Guests are ordinary eels to every other module, but not to this one: Eleanor has no air states
     this wave, and the plan says so outright rather than leaning on her length. */
  allows(e) {
    if (!this.sys.guests.includes(e)) return true;
    return e.airStates === true || e.identity?.traits?.airStates === true;
  }

  defaultFloor(e) { return -DEPTH + e.radius + 0.08; }
  defaultCeil(e) { return -e.radius * 0.5; }

  /* Bounds come off the *current* radius, so a hot-swap that arrives mid-flop leaves the newcomer
     inside its own default band; deleting the map entry alone would leave a stale bound open. */
  initEel(sys, e) {
    e.floorY = this.defaultFloor(e);
    e.ceilingY = this.defaultCeil(e);
    e.buried = false;
    e.burrowing = 0;
    const rng = createRng(deriveSeed(this.seed, AIR_SALT + (e.index ?? 0)));
    this.map.set(e, {
      rng,
      moonOff: rng.range(-0.08, 0.08),
      state: null, phase: '', t0: 0, until: 0,
      airFor: 0, coolUntil: -1e9, biteAt: -1e9,
      above: e.head.y > 0, exempt: false,
      yWant: e.head.y, ringUp: 0.4, ringDown: 0.4,
      fingerRoll: -1, stuckLog: null, stuckLogAt: -1e9, flopUntil: -1e9, burrowBout: -1,
      flop: null, leap: null, dig: null, bite: null, recover: null,
      reason: '',
    });
  }

  // The pond-wide clocks

  prepass(sys, dt) {
    const now = sys.time;
    this.readAnchor();
    sys.relief?.setStrength(this.k('relief'));
    this.troughTick();
    for (const e of sys.eels) this.advance(sys, e, dt, now);
    for (const g of sys.guests) this.advance(sys, g, dt, now);
  }

  /* The flat-water anchor for the reflected moon. main.js publishes it from the same CPU-owned
     uniforms the surface pass uses; without that hook the azimuth alone is close enough to aim at. */
  readAnchor() {
    const sys = this.sys;
    const pub = sys.moonBiteAnchor;
    if (pub && Number.isFinite(pub.x) && Number.isFinite(pub.z)) {
      this.anchor.x = pub.x; this.anchor.z = pub.z; this.anchor.ok = true;
      return;
    }
    const dir = sys.U?.moonDir?.value;
    if (!dir) { this.anchor.ok = false; return; }
    const len = Math.hypot(dir.x, dir.z);
    if (len < 1e-5) { this.anchor.ok = false; return; }
    this.anchor.x = (dir.x / len) * MOON_SPOT;
    this.anchor.z = (dir.z / len) * MOON_SPOT;
    this.anchor.ok = true;
  }

  /* Stamina, the film watch, and the finger's own peek trigger: the clocks that must run whether or
     not this module owns the eel's tick. */
  advance(sys, e, dt, now) {
    const st = this.map.get(e);
    if (!st) return;
    const above = e.head.y > 0;
    if (above) st.airFor = Math.min(AIR_CAP * this.k('stamina'), st.airFor + dt);
    else st.airFor = Math.max(0, st.airFor - dt * AIR_DRAIN);
    if (above && !st.above) {
      sys.sim?.addDrop(e.head.x, e.head.z, st.ringUp + e.radius, 0.02);
      sys.emit('peek', e, { size: e.length });
      // Every emergence starts the cooldown, so a show-off cannot chain a peek into a leap.
      st.coolUntil = now + st.rng.range(COOL[0], COOL[1]) / Math.max(0.05, this.k('stamina'));
    } else if (!above && st.above) {
      sys.sim?.addDrop(e.head.x, e.head.z, st.ringDown + e.radius, st.ringDown > 0.5 ? 0.05 : 0.02);
      if (st.ringDown > 0.5) sys.emit('splash', e, { size: e.length, detail: { bellyflop: !!st.belly } });
    }
    st.above = above;
    // The bite approach is the one state steer can decline to reach (a freeze, a nope, an escape all
    // return above it), so its abort tests run here rather than waiting on a tick that may not come.
    if (st.state === 'bite' && this.biteStale(sys, e, st)) this.cancelApproach(e);
    if (st.state === null && !e.slurpedBy) this.fingerPeek(sys, e, st, now);
  }

  /* F2a's still hand, rolled once per gesture: a finger parked within 1.5 units for 1.5 s. No call
     site needed, because "held still" is a clock rather than an arrival. */
  fingerPeek(sys, e, st, now) {
    const f = sys.finger;
    if (!f || f.mode === 'none' || f.stillFor < FINGER_PEEK_STILL) return;
    if (st.fingerRoll === f.gestureId) return;
    if (Math.hypot(f.x - e.head.x, f.z - e.head.z) > FINGER_PEEK_REACH) return;
    st.fingerRoll = f.gestureId;
    const mul = sys.fear?.fingerPeekMul?.(e) ?? 1;
    this.tryPeek(e, 'finger', 0.3 * (e.traits?.curious ?? 1) * mul);
  }

  // Moon mood (V2)

  moonBright(e) {
    const st = this.map.get(e);
    const phase = this.sys.U?.moonPhase?.value ?? this.sys.moon?.phase01 ?? 0;
    return moonBrightAt(phase, st?.moonOff ?? 0, this.sys.pins?.moon ?? null);
  }

  /* The four §9 effects, scaled together by knobs.moon. depthBand hands back the caller's own top
     pushed deeper, clamped so the band never collapses onto the floor bound. */
  depthBand(e, lo, top) {
    const shift = 0.2 * this.moonBright(e) * this.kMoon() * e.length;
    return Math.max(lo + 0.05, top - shift);
  }
  coverMul(e) { return 1 + 0.3 * this.moonBright(e) * this.kMoon(); }
  travelMul(e) { return Math.max(0.1, 1 - 0.2 * this.moonBright(e) * this.kMoon()); }
  airMul(e) { return Math.max(0, 1 - 0.5 * this.moonBright(e) * this.kMoon()); }

  // Shared gates

  /* An exemption is open, which is also "this module owns the tick": eel-fear.js already calls the
     second name, so both are here rather than one of them being a near-miss. */
  busy(e) { return !!this.map.get(e)?.state; }
  owns(e) { return !!this.map.get(e)?.state; }

  scared(sys, e) {
    const now = sys.time;
    if (now < e.freezeUntil || now < e.nopeUntil || now < e.fleeUntil) return true;
    if (sys.fear?.pendingScatter?.(e)) return true;
    for (const s of sys.spooks) {
      if (s.except === e || (s.only && s.only !== e)) continue;
      if (now - s.t > 1.6) continue;
      const d = Math.hypot(e.head.x - s.x, e.head.z - s.z);
      if (d < SCARE_R && (1 - d / SCARE_R) * s.strength * (e.traits?.spookMul ?? 1) > SCARE_AT) return true;
    }
    return false;
  }

  /* The buried grace. Half of §3's point is that the sand is safety, so the spook that ends a dig has
     to be nearer or louder than the one that turns a swimming eel, or keep at it. */
  buriedScared(sys, e, st, dt) {
    const now = sys.time;
    // Already-committed fear, not a fresh ripple: a scatter decided in the prepass digs the eel out at once,
    // which is how Eleanor's hunt still reaches an eel under the sand.
    if (now < e.freezeUntil || now < e.nopeUntil || now < e.fleeUntil) return true;
    if (sys.fear?.pendingScatter?.(e)) return true;
    const mul = e.traits?.spookMul ?? 1;
    let worst = 0;
    for (const s of sys.spooks) {
      if (s.except === e || (s.only && s.only !== e)) continue;
      if (now - s.t > 1.6) continue;
      const d = Math.hypot(e.head.x - s.x, e.head.z - s.z);
      if (d >= SCARE_R) continue;
      const k = (1 - d / SCARE_R) * s.strength * mul;
      if (k > worst) worst = k;
    }
    const d0 = st.dig;
    if (worst >= SCARE_AT * Math.max(1, knob(this.sys.knobs?.air?.buriedEvict, BURIED_EVICT))) return true;
    // Drains at half the fill rate, so successive pokes stack toward the grace instead of each one
    // starting over, and a single expired one bleeds off in a couple of seconds.
    if (worst <= SCARE_AT) { d0.scareFor = Math.max(0, (d0.scareFor ?? 0) - dt * 0.5); return false; }
    d0.scareFor = (d0.scareFor ?? 0) + dt;
    return d0.scareFor >= knob(this.sys.knobs?.air?.buriedGrace, BURIED_GRACE);
  }

  /* Everything a voluntary air state needs before it may begin: an open exemption anywhere refuses,
     and so does the shared cooldown and the stamina the peek and the leap both spend. */
  ready(e, needStamina = true) {
    const sys = this.sys, st = this.map.get(e);
    if (!st || st.state || e.slurpedBy || !this.allows(e)) return null;
    // A refuge contest owns both parties' ticks; starting an air state under one would run two
    // controllers on the same eel and pause the contest with its locks still held.
    if (sys.fear?.contesting?.(e)) return null;
    if (sys.time < st.coolUntil) return null;
    if (needStamina && st.airFor > AIR_CAP * 0.5) return null;
    if (this.scared(sys, e)) return null;
    return st;
  }

  // V3 peek

  /* Reasons carry their own odds; a bare call from force() skips the roll entirely. The moon term
     and knobs.air.peek multiply everything, per the trigger table. */
  tryPeek(e, reason = 'pad', odds = null) {
    const st = this.ready(e);
    if (!st) return false;
    if (e.tunnel) return false;
    const base = odds ?? (reason === 'ridge' ? 0.6 : reason === 'rain' ? 0.15 * (this.sys.rain?.envelope ?? 0) : 0.4);
    const p = base * this.airMul(e) * this.k('peek');
    if (!(p > 0) || !st.rng.chance(Math.min(1, p))) return false;
    this.startPeek(e, st, reason);
    return true;
  }

  startPeek(e, st, reason) {
    const now = this.sys.time;
    st.state = 'peek'; st.phase = 'rise'; st.t0 = now; st.reason = reason;
    st.yWant = e.head.y;
    st.riseTo = e.radius * PEEK_LIFT;
    st.until = 0;
    st.ringUp = 0.4; st.ringDown = 0.4; st.belly = false;
    e.ceilingY = e.radius;   // the plan's lifted ceiling: the snout clears, the neck follows it up
    st.exempt = true;
  }

  peekTick(sys, e, st, dt) {
    const now = sys.time;
    const rise = PEEK_BL * e.length * (sys.motion?.reduced ? 0.5 : 1);
    const ceil = this.defaultCeil(e);
    if (st.phase !== 'down' && (this.scared(sys, e) || st.airFor >= AIR_CAP * this.k('stamina'))) {
      st.phase = 'down';
      st.scared = this.scared(sys, e);
    }
    if (st.phase === 'rise') {
      st.yWant = Math.min(st.riseTo, st.yWant + rise * dt);
      if (st.yWant >= st.riseTo - 1e-4) { st.phase = 'top'; st.until = now + st.rng.range(PEEK_TIME[0], PEEK_TIME[1]); }
    } else if (st.phase === 'top') {
      if (st.bite) this.biteNow(sys, e, st);
      if (now >= st.until) st.phase = 'down';
    } else {
      st.yWant = Math.max(ceil - e.radius * 1.5, st.yWant - rise * 2 * dt);
      if (e.head.y <= ceil) {
        // The scare was held under the peek; the nope itself waits for release(), since a 1.1 s
        // nopeUntil armed here would expire under a recovery that usually runs longer than that.
        if (st.scared) { sys.emit('startle', e); st.deferNope = true; }
        st.scared = false;
        this.startRecover(sys, e, st, 'air');
        return;
      }
    }
    const huffing = st.bitten && now < st.huffUntil;
    this.drive(sys, e, dt, {
      holdHeading: true,
      speedBL: PEEK_BL,
      ySet: st.yWant,
      squash: huffing ? 1.3 : 1,
      excite: huffing ? 0.6 : 0,
      resting: true,
    });
  }

  // V4 the log flop

  logFits(e, log) { return log.rInner >= e.radius * 1.15 + 0.02; }

  /* Eligibility plus the plan's odds. `target` is the destination the crossing was in the way of, so
     the exit lands on the useful side of the log rather than wherever the head happened to point. */
  tryFlop(e, log, target = null, force = false) {
    const sys = this.sys;
    const st = force ? this.map.get(e) : this.ready(e, false);
    if (!st || !log || (force && (st.state || !this.allows(e)))) return false;
    if (!this.allows(e) || e.tunnel) return false;
    // A crossing whose crest was drowned breaks no film, so it collects no air cooldown; without a
    // repeat guard the very next pickTarget rolls the same log again.
    if (!force && sys.time < st.flopUntil) return false;
    const path = this.flopPath(sys, e, log, target);
    if (!path) return false;
    if (!force) {
      const focus = clamp01(e.focus ?? e.wits ?? 0.5);
      const dry = path.crestY > 0 ? 1 : 0.5;
      const env = sys.rain?.envelope ?? 0;
      const p = (this.logFits(e, log) ? 0.15 * focus : 0.6) * (1 + 2 * env) * dry * this.k('flop');
      if (!(p > 0) || !st.rng.chance(Math.min(1, p))) return false;
    }
    st.state = 'flop'; st.phase = 'approach'; st.t0 = sys.time; st.flop = path; st.flopLast = path;
    st.flopUntil = sys.time + FLOP_COOL;
    st.ringUp = 0.4; st.ringDown = 0.4; st.belly = false;
    // An exemption may only ever open the bound: a drowned crest sits below the default ceiling, and
    // clamping the whole chain down to it crushes the body before the head has climbed anywhere.
    e.ceilingY = Math.max(this.defaultCeil(e), path.crestY + e.radius + 0.15);
    st.exempt = true;
    e.tunnel = null;
    return true;
  }

  /* Crossing point on the axis nearest the head, nudged clear of any stub, with the near-side
     approach and the far-side exit measured along the outward normal. */
  flopPath(sys, e, log, target) {
    const head = e.head;
    const ax = log.b.x - log.a.x, az = log.b.z - log.a.z;
    const len2 = ax * ax + az * az;
    if (!(len2 > 1e-6)) return null;
    let t = ((head.x - log.a.x) * ax + (head.z - log.a.z) * az) / len2;
    t = Math.max(0.05, Math.min(0.95, t));
    let cx = log.a.x + ax * t, cz = log.a.z + az * t;
    // Stubs are ordinary collider entries with rInner 0; crossing over one is climbing a branch.
    const alen = Math.sqrt(len2);
    for (const s of sys.colliders.logs) {
      if (s === log || s.rInner > 0) continue;
      const sx = (s.a.x + s.b.x) * 0.5, sz = (s.a.z + s.b.z) * 0.5;
      const along = ((sx - log.a.x) * ax + (sz - log.a.z) * az) / len2;
      const want = (log.rOuter + s.rOuter + e.radius) / alen;
      const gap = t - along;
      if (Math.abs(gap) >= want) continue;
      t = Math.max(0.05, Math.min(0.95, along + (gap >= 0 ? want : -want)));
      cx = log.a.x + ax * t; cz = log.a.z + az * t;
    }
    let nx = head.x - cx, nz = head.z - cz;
    let nl = Math.hypot(nx, nz);
    if (nl < 1e-4) { nx = -az / alen; nz = ax / alen; nl = 1; }
    nx /= nl; nz /= nl;
    // The far side has to be the side the eel wanted; without a target the head's own normal decides.
    if (target && ((target.x - cx) * nx + (target.z - cz) * nz) > 0) { nx = -nx; nz = -nz; }
    const L = e.length, rO = log.rOuter;
    return {
      log, cx, cz, nx, nz, rOuter: rO,
      crestY: log.a.y + rO,
      approach: { x: cx + nx * (rO + 0.4 * L), z: cz + nz * (rO + 0.4 * L) },
      exit: { x: cx - nx * (rO + 0.5), z: cz - nz * (rO + 0.5) },
    };
  }

  flopTick(sys, e, st, dt) {
    const now = sys.time, f = st.flop, head = e.head;
    // s runs along -n: negative on the near side, zero over the axis, positive past it.
    const s = -((head.x - f.cx) * f.nx + (head.z - f.cz) * f.nz);
    const scare = this.scared(sys, e);
    const speed = e.prowlBL * FLOP_SPEED * (scare ? FLOP_SCARE : 1);
    const flank = crestHeight(f.rOuter, f.rOuter, f.crestY, e.radius);   // the path's value at the tangent
    if (st.phase !== 'giveup' && now - st.t0 > FLOP_GIVEUP) { st.phase = 'giveup'; st.giveUpAt = now; }
    // The fallback parks it on the far side rather than handing a half-crossed body to recovery, which
    // derives its own route from the heading and would close the ceiling on the near flank.
    if (st.phase === 'giveup') {
      e.target.set(f.exit.x, 0, f.exit.z);
      const there = Math.hypot(head.x - f.exit.x, head.z - f.exit.z) < 0.4;
      if (there || now - st.giveUpAt > FLOP_EXIT) { this.startRecover(sys, e, st, 'air'); return; }
      this.drive(sys, e, dt, { tx: f.exit.x, tz: f.exit.z, speedBL: speed, targetY: flank });
      return;
    }
    if (st.phase === 'approach') {
      // The approach point is where the climb lines up, not where the eel is going: arriving there
      // hands the target to the exit, or the head would park a body length short of the wood.
      const near = Math.hypot(head.x - f.approach.x, head.z - f.approach.z) < 0.5;
      if (near || s > -f.rOuter) st.phase = 'cross';
      this.drive(sys, e, dt, { tx: f.approach.x, tz: f.approach.z, speedBL: e.prowlBL, targetY: flank });
      return;
    }
    // A rate limit, not a chase: an exponential chase lags below the semicircle by enough to sit
    // inside the log's envelope, and the collider's sideways push then stalls the crossing outright.
    const yWant = crestHeight(s, f.rOuter, f.crestY, e.radius);
    const step = CLIMB_RATE * dt;
    const done = s > f.rOuter + 0.4 || Math.hypot(head.x - f.exit.x, head.z - f.exit.z) < 0.35;
    this.drive(sys, e, dt, {
      tx: f.exit.x, tz: f.exit.z, speedBL: speed, excite: scare ? 0.8 : 0.2,
      ySet: head.y + Math.max(-step, Math.min(step, yWant - head.y)),
    });
    if (done) {
      // The rings come from eels.js's surface contact, point by point where the body breaks the film.
      sys.emit('splash', e, { size: e.length, detail: { flop: true } });
      e.target.set(f.exit.x, 0, f.exit.z);
      this.startRecover(sys, e, st, 'air');
    }
  }

  /* The stuck detector's own flop: a second blocked episode against the same log inside 20 s starts
     one regardless of focus, which is how a dumb eel gets over a log by accident. */
  stuckFlop(e, log) {
    const sys = this.sys, st = this.map.get(e);
    if (!st || !log) return false;
    const now = sys.time;
    const repeat = st.stuckLog === log && now - st.stuckLogAt < FLOP_STUCK_WINDOW;
    st.stuckLog = log; st.stuckLogAt = now;
    if (!repeat || sys.fear?.contesting?.(e)) return false;
    return this.tryFlop(e, log, e.target, true);
  }

  // V5 the leap

  /* The spontaneous roll: excited, cruising, in open water, off cooldown. Rate is per second, so the
     caller passes its own dt. */
  tryLeap(e, dt = 1 / 90) {
    const sys = this.sys;
    const st = this.ready(e);
    if (!st || sys.motion?.reduced) return false;
    if (e.tunnel || e.twine || e.food || sys.time < e.fleeUntil) return false;
    if ((e.uExcite?.value ?? 0) <= 0.5) return false;
    const rate = 0.004 * clamp01(e.leap ?? 0) * this.airMul(e) * this.k('leap');
    if (!(rate > 0) || !st.rng.chance(rate * dt)) return false;
    return this.startLeap(e, st, null);
  }

  /* The expansion contract's entry point: a firefly hunt hands a target instead of the roll. */
  leap(e, target = null) {
    const st = this.ready(e);
    if (!st || this.sys.motion?.reduced) return false;
    return this.startLeap(e, st, target);
  }

  startLeap(e, st, target, forced = false) {
    const sys = this.sys;
    const form = leapForm(e.wits ?? e.braincellUsage ?? 0.5);
    const y0 = this.defaultCeil(e);
    const arc = leapArc(e.leap ?? 0, form.formHeight, y0);
    const dist = leapDistance(e.length, form.formDistance);
    let ang = Math.atan2(e.heading.z, e.heading.x);
    if (target) ang = Math.atan2(target.z - e.head.z, target.x - e.head.x);
    else if (forced) {
      const clear = this.clearHeading(e, dist, ang);
      if (clear === null) return false;   // the force API still owes its physical preconditions
      ang = clear;
    }
    if (!forced && !target && !this.landingOk(e, ang, dist)) return false;
    st.state = 'leap'; st.phase = 'launch'; st.t0 = sys.time;
    st.leap = { form, arc, dist, ang, y0, from: e.head.y, bt: 0, forced, aim: !!(target || forced) };
    st.ringUp = 0.4;
    st.ringDown = 0.6 * (form.belly ? BELLY_RING : 1);
    st.belly = form.belly;
    st.exempt = true;
    return true;
  }

  /* Sixteen headings, first clear landing wins: a forced leap has to actually go somewhere, and the
     spontaneous roll still refuses rather than steering. Null when all sixteen are blocked, because
     handing back the original heading would launch at a landing landingClear() already rejected. */
  clearHeading(e, dist, from) {
    const sys = this.sys;
    const limX = sys.view.w * 0.7, limZ = sys.view.h * 0.7;
    for (let i = 0; i < 16; i++) {
      const a = from + (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 8));
      const x = e.head.x + Math.cos(a) * dist, z = e.head.z + Math.sin(a) * dist;
      if (landingClear(x, z, e.radius, sys.colliders.spheres, sys.colliders.logs, limX, limZ)) return a;
    }
    return null;
  }

  landingOk(e, ang, dist) {
    const sys = this.sys;
    return landingClear(
      e.head.x + Math.cos(ang) * dist, e.head.z + Math.sin(ang) * dist, e.radius,
      sys.colliders.spheres, sys.colliders.logs, sys.view.w * 0.7, sys.view.h * 0.7,
    );
  }

  leapTick(sys, e, st, dt) {
    const now = sys.time, L = st.leap, head = e.head;
    if (st.phase === 'launch') {
      const t = Math.min(1, (now - st.t0) / LEAP_LAUNCH);
      // A timed interpolation, not the exponential depth chase, which approaches y0 and never arrives.
      const y = L.from + (L.y0 - L.from) * t;
      if (this.scared(sys, e) || e.tunnel) { this.abort(sys, e, st, this.scared(sys, e) ? 'scared' : 'tunnel'); return; }
      // Cruise carries the head a couple of units during the approach, so the clearance can be lost
      // under it. A forced leap re-aims; a spontaneous one gives up, which is the plan's "no cost".
      if (!this.landingOk(e, L.ang, L.dist)) {
        const clear = L.forced ? this.clearHeading(e, L.dist, L.ang) : null;
        if (clear === null) { this.abort(sys, e, st, 'landing'); return; }
        L.ang = clear;
      }
      const aimX = head.x + Math.cos(L.ang) * L.dist, aimZ = head.z + Math.sin(L.ang) * L.dist;
      this.drive(sys, e, dt, { tx: L.aim ? aimX : undefined, tz: aimZ, holdHeading: !L.aim, speedBL: e.cruiseBL, ySet: y, excite: 0.7 });
      if (t < 1 || Math.abs(head.y - L.y0) >= 0.01) return;
      // The landing is computed from the position and heading the approach actually reached, never
      // from where the roll happened; a forced leap is allowed one more search for a clear line.
      L.ang = Math.atan2(e.heading.z, e.heading.x);
      if (!this.landingOk(e, L.ang, L.dist)) {
        const clear = L.forced ? this.clearHeading(e, L.dist, L.ang) : null;
        if (clear === null) { this.abort(sys, e, st, 'landing'); return; }
        L.ang = clear;
      }
      st.phase = 'air'; L.bt = 0;
      e.ceilingY = L.arc.apexY + e.radius + 0.2;
      return;
    }
    L.bt += dt;
    if (L.bt < L.arc.T) {
      const y = L.y0 + L.arc.v * L.bt - 0.5 * L.arc.g * L.bt * L.bt;
      this.drive(sys, e, dt, { heading: L.ang, speedFixed: L.dist / L.arc.T, ySet: y, ampMul: LEAP_AMP, excite: 0.9 });
      return;
    }
    // The last fractional slice of flight, so the eel lands on the point that was cleared, not a tick short.
    const rem = L.arc.T - (L.bt - dt);
    if (rem > 1e-6) this.drive(sys, e, rem, { heading: L.ang, speedFixed: L.dist / L.arc.T, ySet: L.y0, ampMul: LEAP_AMP, excite: 0.9 });
    // The ring and the splash event already went off at the film crossing a tick or two above y0.
    head.y = L.y0;
    const belly = L.form.belly;
    const fx = sys.effects;
    for (let i = 0; i < 8 && fx; i++) {
      const a = st.rng.range(0, Math.PI * 2), rr = st.rng.range(0, e.radius * 2.5);
      fx.spawn(head.x + Math.cos(a) * rr, head.y - e.radius * st.rng.range(1, 4), head.z + Math.sin(a) * rr, 'bubble');
    }
    // Flee-style decay: the impact carries the speed and recovery's own ramp bleeds it off.
    e.speedBL = e.cruiseBL * 1.2;
    e.uExcite.value = 1;
    st.embarrassedUntil = belly ? now + 2 : 0;
    this.startRecover(sys, e, st, 'air');
    if (belly) { e.pose.ampMul = BELLY_AMP; commitPose(e); }
  }

  abort(sys, e, st, why = '') {
    e.ceilingY = this.defaultCeil(e);
    e.floorY = this.defaultFloor(e);
    st.state = null; st.phase = ''; st.exempt = false; st.leap = null;
    st.abortedBy = why;
  }

  // V6 burrow

  /* Open sand only: no rock within 3 r, nothing overhead, and not in the bore, or the dig would push
     the body through something solid on its way down. */
  canBurrow(e) {
    const sys = this.sys, head = e.head, r3 = e.radius * 3;
    if (e.tunnel || !this.allows(e)) return false;
    for (const s of sys.colliders.spheres) {
      const rr = (s.rHit ?? s.r) + r3;
      if ((head.x - s.x) ** 2 + (head.z - s.z) ** 2 < rr * rr) return false;
    }
    for (const l of sys.colliders.logs) {
      const dx = l.b.x - l.a.x, dz = l.b.z - l.a.z, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((head.x - l.a.x) * dx + (head.z - l.a.z) * dz) / l2));
      const px = head.x - (l.a.x + dx * t), pz = head.z - (l.a.z + dz * t);
      if (px * px + pz * pz < (l.rOuter + r3) ** 2) return false;
    }
    const pad = sys.habitat?.padAt?.(head.x, head.z, e.radius);
    return !pad;
  }

  tryBurrow(e, force = false) {
    const sys = this.sys, st = this.map.get(e);
    if (!st || st.state || e.slurpedBy || !this.allows(e)) return false;
    // One dig per hold bout, the way the coil and the sickle work: the asleep hold asks every tick,
    // and without this the eel climbs out and immediately digs back in for the whole bout.
    if (!force && st.burrowBout === e.gaitFrom) return false;
    if (!force && (sys.fear?.contesting?.(e) || !this.canBurrow(e))) return false;
    st.burrowBout = e.gaitFrom;
    st.state = 'burrow'; st.phase = 'dig1'; st.t0 = sys.time;
    st.dig = { ang: Math.atan2(e.heading.z, e.heading.x), grains: 0, silt: 0, puffAt: 0, scareFor: 0 };
    st.exempt = true;
    sys.emit('dig', e, { size: e.length, detail: { phase: 'in' } });
    return true;
  }

  digTick(sys, e, st, dt) {
    const now = sys.time, d = st.dig, head = e.head;
    const sand = floorHeightAt(head.x, head.z);
    e.floorY = sand - 1.2 * e.radius;
    const el = now - st.t0;
    // The press ramps in over dig1 so the body slides under instead of snapping there, holds through
    // the buried hold, and lets go at wake; the halo follows it down and back up.
    const press = st.phase === 'dig1' ? Math.min(1, el / DIG_ONE) : st.phase === 'wake' ? 0 : 1;
    e.burrowing = press;
    this.dimHalo(e, st, press, dt);
    this.stampRelief(e, st, dt, press);
    if (st.phase === 'dig1') {
      const sink = e.prowlBL * e.length * Math.sin(DIG_SLOPE);
      this.puffBudget(e, st, el / DIG_ONE, DIG_BUDGET.one);
      this.drive(sys, e, dt, {
        heading: d.ang + DIG_YAW1 * Math.sin(el * DIG_HZ1 * Math.PI * 2),
        speedBL: e.prowlBL * Math.cos(DIG_SLOPE),
        ySet: head.y - sink * dt, ampMul: 1.2,
      });
      // The mirror of finishRecover's test: dig1 ends on a buried chain, not on a stopwatch, so a
      // long slow eel simply takes longer to get all of itself down there.
      const under = maxY(e) <= sand - e.radius;
      if (el >= DIG_ONE && (under || el >= DIG_ONE_MAX)) { st.phase = 'dig2'; st.t0 = now; d.grains = 0; d.silt = 0; }
      return;
    }
    if (st.phase === 'dig2') {
      this.puffBudget(e, st, el / DIG_TWO, DIG_BUDGET.two);
      this.drive(sys, e, dt, {
        heading: d.ang + DIG_YAW2 * Math.sin(el * DIG_HZ2 * Math.PI * 2),
        speedBL: 0, ySet: head.y, ampMul: 0.15, resting: true,
      });
      if (el >= DIG_TWO) { st.phase = 'buried'; st.t0 = now; e.buried = true; d.grains = 0; d.silt = 0; }
      return;
    }
    if (st.phase === 'buried') {
      // The hold owns the clock: the bout ending, a scare, or a quorum wake all lift the head out.
      if (now >= e.gaitUntil || this.buriedScared(sys, e, st, dt)) { this.startWake(sys, e, st); return; }
      if (now >= (d.puffAt ?? 0)) {
        this.trickle(e);
        d.puffAt = now + this.puffRng.range(0.75, 1.25) * knob(this.sys.knobs?.air?.puffTrickle, DIG_TRICKLE);
      }
      this.drive(sys, e, dt, { heading: d.ang, speedBL: 0, ySet: head.y, ampMul: 0.15, resting: true });
      return;
    }
    // Waking is the dig in reverse: rise into the floor band and swim out along the trail.
    this.puffBudget(e, st, el / 0.8, DIG_BUDGET.wake);
    const want = this.defaultFloor(e) + e.radius * 1.2;
    const rise = e.prowlBL * e.length * Math.sin(DIG_SLOPE) * dt;
    this.drive(sys, e, dt, { heading: d.ang, speedBL: e.prowlBL, ySet: Math.min(want, head.y + rise), ampMul: 1 });
    if (head.y >= want - 0.01) this.startRecover(sys, e, st, 'burrow');
  }

  startWake(sys, e, st) {
    this.collapseRelief(e, st);
    st.phase = 'wake'; st.t0 = sys.time;
    e.buried = false;
    e.burrowing = 0;
    st.dig.grains = 0; st.dig.silt = 0;
    sys.emit('dig', e, { size: e.length, detail: { phase: 'out' } });
  }

  /* sys.air.wake(e): the braincell's quorum calls this on every member of a pile it just woke. A
     buried eel starts its physical dig-out; anyone else has nothing to do. */
  wake(e) {
    const st = this.map.get(e);
    if (!st || st.state !== 'burrow' || (st.phase !== 'buried' && st.phase !== 'dig1' && st.phase !== 'dig2')) return false;
    this.startWake(this.sys, e, st);
    return true;
  }

  // The sand relief

  /* The dig's mark: sand heaved up along the buried part of the body. Stamped toward a height, not
     added, on a coarse clock, so a long hold keeps its mound against the heal for free. */
  stampRelief(e, st, dt, press) {
    const field = this.sys.relief;
    const d = st.dig;
    if (!field || !d) return;
    d.reliefAt = (d.reliefAt ?? 0) - dt;
    if (d.reliefAt > 0) return;
    d.reliefAt = RELIEF_TICK;
    const h = RELIEF_RIDGE * e.radius * Math.max(0, Math.min(1, press));
    if (!(h > 0)) return;
    for (let i = 0; i < e.pts.length; i += 3) {
      const p = e.pts[i];
      if (p.y > floorHeightAt(p.x, p.z)) continue;
      field.stamp(p.x, p.z, RELIEF_R, h);
    }
  }

  /* The exit: the ridge falls in on itself, and the trail is kept so silt can trickle up out of the
     trough while it fills, which is what hides the healing. */
  collapseRelief(e, st) {
    const field = this.sys.relief;
    if (!field || st.phase === 'wake') return;
    const h = -RELIEF_TROUGH * RELIEF_RIDGE * e.radius;
    const trail = [];
    for (let i = 0; i < e.pts.length; i += 3) {
      const p = e.pts[i];
      if (p.y > floorHeightAt(p.x, p.z)) continue;
      field.stamp(p.x, p.z, RELIEF_R, h);
      trail.push(p.x, p.z);
    }
    if (trail.length < 2) return;
    this.troughs.push({ trail, t0: this.sys.time, puffAt: this.sys.time + TROUGH_PUFF });
    if (this.troughs.length > TROUGH_MAX) this.troughs.shift();
  }

  /* Silt drifting up off a trough as the sand closes over it, thinning with the depth that is left.
     Every draw is the decorative puff stream, so a filling trough can never move a decision. */
  troughTick() {
    if (!this.troughs.length) return;
    const sys = this.sys, now = sys.time, pool = sys.sediment;
    for (let i = this.troughs.length - 1; i >= 0; i--) {
      const tr = this.troughs[i];
      const left = Math.exp(-(now - tr.t0) / RELIEF_HEAL_TAU);
      if (left < TROUGH_DONE) { this.troughs.splice(i, 1); continue; }
      if (now < tr.puffAt) continue;
      tr.puffAt = now + (this.puffRng.range(0.7, 1.3) * TROUGH_PUFF) / left;
      if (!pool || pool.live() > pool.pool * 0.7) continue;
      const k = this.puffRng.int(0, tr.trail.length / 2 - 1) * 2;
      this.puff(tr.trail[k], tr.trail[k + 1], 'silt', 1);
    }
  }

  // The sediment

  haloBase(e) { return e.jelly ? knob(this.sys.knobs?.jelly?.halo?.value, 1) : 1; }

  /* A buried eel keeps the influence field's sand glow, which reads as light through sand, but not
     the 2.4× additive shell, which blooms over the floor as a bright ball. */
  dimHalo(e, st, want, dt) {
    st.dim = (st.dim ?? 0) + (want - (st.dim ?? 0)) * Math.min(1, dt * 4);
    if (e.uHaloMul) e.uHaloMul.value = this.haloBase(e) * (1 - (1 - DIG_HALO) * st.dim);
  }

  /* The buried hold's idle cloud, a radius or two off the snout. Skipped while the pool is busy, so
     several dug-in eels can never starve a live dig-in burst of slots. */
  trickle(e) {
    const pool = this.sys.sediment;
    if (!pool || pool.live() > pool.pool * 0.7) return;
    const a = this.puffRng.range(0, Math.PI * 2), rr = this.puffRng.range(1, 2) * e.radius;
    this.puff(e.head.x + Math.cos(a) * rr, e.head.z + Math.sin(a) * rr, 'silt', 1);
  }

  /* Fixed budget per phase, paid out across the phase's shake cycles rather than per tick, so the
     count is the same at 60 and 240 Hz. */
  puffBudget(e, st, frac, [grains, silt]) {
    const f = Math.max(0, Math.min(1, frac));
    const d = st.dig;
    const wantG = Math.floor(f * grains), wantS = Math.floor(f * silt);
    if (wantG > d.grains) { this.puff(e.head.x, e.head.z, 'grain', wantG - d.grains, e.heading); d.grains = wantG; }
    if (wantS > d.silt) { this.puff(e.head.x, e.head.z, 'silt', wantS - d.silt, e.heading); d.silt = wantS; }
  }

  /* Spawns from the local sand surface, never the head: for most of a dig the head is under the
     opaque floor mesh. Reduced motion keeps the billows and drops the flying grains. */
  puff(x, z, kind = 'silt', n = 1, sweep = null) {
    const sys = this.sys;
    const pool = sys.sediment;
    if (!pool || n <= 0) return 0;
    if (kind === 'grain' && sys.motion?.reduced) return 0;
    const rng = this.puffRng;
    const y0 = floorSurfaceAt(x, z) + 0.01;
    const sx = sweep ? -sweep.z : 1, sz = sweep ? sweep.x : 0;
    // Sand-colored silt over sand is invisible by construction, so a billow reads as sand lifted into
    // the moonlight: lifted and cooled. A grain is a pebble instead, so it ships the raw albedo and
    // the pool lights it the way the floor beside it is lit.
    const gain = this.k('puff');
    let color;
    if (kind === 'grain') {
      sandAlbedoAt(x, z, sandRGB);
      color = [sandRGB[0] * gain, sandRGB[1] * gain, sandRGB[2] * gain];
      if (pool.uSubGain) pool.uSubGain.value = gain;
    } else {
      sandColorAt(x, z, sandRGB);
      color = [sandRGB[0] * SILT_TINT[0] * 5 * gain, sandRGB[1] * SILT_TINT[1] * 5 * gain, sandRGB[2] * SILT_TINT[2] * 5 * gain];
    }
    let made = 0;
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const jx = Math.cos(a) * 0.05, jz = Math.sin(a) * 0.05;
      if (kind === 'grain') {
        const side = rng.chance(0.5) ? 1 : -1;
        const sp = rng.range(0.15, 0.4);
        const vx = (sx * side + Math.cos(a) * 0.4) * sp, vz = (sz * side + Math.sin(a) * 0.4) * sp;
        const vy = rng.range(0.05, 0.18);
        // Landing height is stored per instance: predict the return-to-launch time, ask the sand, then
        // re-ask at the column the real touchdown reaches, since sand below launch height lands later.
        const tf = 2 * vy / 0.6;
        let landY = floorSurfaceAt(x + jx + vx * tf, z + jz + vz * tf) + 0.01;
        const ts = (vy + Math.sqrt(Math.max(0, vy * vy + 1.2 * (y0 - landY)))) / 0.6;
        landY = floorSurfaceAt(x + jx + vx * ts, z + jz + vz * ts) + 0.01;
        pool.spawn(x + jx, y0, z + jz, 'grain', {
          vx, vy, vz, landY, size: rng.range(0.035, 0.07) * this.k('grainSize'), life: rng.range(2, 4), color,
        });
      } else {
        pool.spawn(x + jx, y0, z + jz, 'silt', {
          vx: rng.range(-0.02, 0.02), vy: rng.range(0.03, 0.08), vz: rng.range(-0.02, 0.02),
          size: rng.range(0.05, 0.07) * this.k('puffSize'), life: rng.range(3, 6), color,
        });
      }
      made++;
    }
    return made;
  }

  // V8 the moon bite

  /* Checked at the trigger and again on every approach tick: the anchor in view, over open water,
     out of the rain, and the eel still interruptible. */
  bitePreconditions(e) {
    const sys = this.sys, a = this.anchor;
    if (!a.ok) return false;
    if ((sys.rain?.envelope ?? 0) >= 0.2) return false;
    if (Math.abs(a.x) > sys.view.w * 0.5 || Math.abs(a.z) > sys.view.h * 0.5) return false;
    const clear = e.radius * 3;
    for (const s of sys.colliders.spheres) {
      const rr = (s.rHit ?? s.r) + clear;
      if ((a.x - s.x) ** 2 + (a.z - s.z) ** 2 < rr * rr) return false;
    }
    for (const l of sys.colliders.logs) {
      const dx = l.b.x - l.a.x, dz = l.b.z - l.a.z, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((a.x - l.a.x) * dx + (a.z - l.a.z) * dz) / l2));
      const px = a.x - (l.a.x + dx * t), pz = a.z - (l.a.z + dz * t);
      if (px * px + pz * pz < (l.rOuter + clear) ** 2) return false;
    }
    return !sys.habitat?.padAt?.(a.x, a.z, clear);
  }

  tryMoonBite(e, dt = 1 / 90, force = false) {
    const sys = this.sys;
    const st = force ? this.map.get(e) : this.ready(e);
    if (!st || (force && st.state)) return false;
    if (!this.allows(e) || e.tunnel || e.food || sys.time < e.fleeUntil) return false;
    if (!force) {
      if (sys.time - st.biteAt < BITE_COOL) return false;
      const curious = e.traits?.curious ?? 1;
      if (curious < 1.1 && e.census?.startle !== 'investigate') return false;
      if (this.moonBright(e) >= 0.6) return false;
      const rate = 0.002 * curious * this.k('moonbite');
      if (!(rate > 0) || !st.rng.chance(rate * dt)) return false;
    }
    if (!this.bitePreconditions(e)) return false;
    st.state = 'bite'; st.phase = 'approach'; st.t0 = sys.time; st.bite = true;
    st.bitten = false; st.huffUntil = 0;
    st.ringUp = 0.4; st.ringDown = 0.4; st.belly = false;
    return true;
  }

  biteStale(sys, e, st) {
    return sys.time - st.t0 > BITE_TIMEOUT || !this.bitePreconditions(e) || this.scared(sys, e);
  }

  biteTick(sys, e, st, dt) {
    const a = this.anchor;
    // Every approach tick parked the target on the reflection, and cancelApproach clears the plan so
    // a dropped bite does not leave the eel swimming at it until its retarget clock comes round.
    if (this.biteStale(sys, e, st)) { this.cancelApproach(e); return; }
    e.target.set(a.x, 0, a.z);
    if (Math.hypot(e.head.x - a.x, e.head.z - a.z) < BITE_REACH) {
      // Inside the reach the peek is requested directly: no second V3 roll, no second cooldown test.
      this.startPeek(e, st, 'moonbite');
      st.bite = true;
      return;
    }
    this.drive(sys, e, dt, { tx: a.x, tz: a.z, speedBL: e.prowlBL, excite: 0.3 });
  }

  biteNow(sys, e, st) {
    const now = sys.time;
    st.bite = false; st.bitten = true;
    st.biteAt = now;   // the five-minute cooldown is spent on the bite, not on the trigger
    st.huffUntil = now + 2;
    e.retargetAt = 0;   // the anchor is not a plan: pick a fresh one the tick the eel is steering again
    sys.sim?.addDrop(e.head.x, e.head.z, 0.5, 0.03);
    sys.emit('moonbite', e, { size: e.length });
    sys.stim?.shuffle?.(e);
  }

  // V1 recovery

  /* The body phase. The head is already home; this drains the rest of the chain out of the extreme
     before the bound closes, because collide() clamps every point at once. */
  startRecover(sys, e, st, kind) {
    st.state = 'recover'; st.phase = kind; st.t0 = sys.time;
    st.recover = { watchAt: sys.time, watchVal: kind === 'burrow' ? minY(e) : maxY(e), nudge: 0, extra: false };
    st.flop = null; st.leap = null;
    this.finishRecover(sys, e, st);
  }

  /* Completion is evaluated here, at the top of the eel's tick, which is after the previous tick's
     collide() and constrain(): the only place the chain's real extremes are known. */
  finishRecover(sys, e, st) {
    const done = st.phase === 'burrow'
      ? minY(e) >= this.defaultFloor(e) - RECOVER_TOL
      : maxY(e) <= this.defaultCeil(e) + RECOVER_TOL;
    if (!done) return false;
    this.logRecovery(sys, e, sys.time - st.t0, false);
    this.release(e, st);
    return true;
  }

  logRecovery(sys, e, took, hitDeadline) {
    if (!sys.debug) return;
    this.recoveries.push({ name: e.name, took: +took.toFixed(3), hitDeadline });
    if (this.recoveries.length > 500) this.recoveries.shift();
    if (hitDeadline) console.warn(`[air] ${e.name} recovery hit the deadline after ${took.toFixed(1)} s`);
  }

  release(e, st) {
    e.floorY = this.defaultFloor(e);
    e.ceilingY = this.defaultCeil(e);
    e.buried = false;
    e.burrowing = 0;
    st.dim = 0;
    if (e.uHaloMul) e.uHaloMul.value = this.haloBase(e);
    if (st.deferNope) { st.deferNope = false; e.nopeUntil = Math.max(e.nopeUntil, this.sys.time + 1.1); }
    st.state = null; st.phase = ''; st.exempt = false;
    st.recover = null; st.flop = null; st.leap = null; st.dig = null; st.bite = false;
    return true;
  }

  recoverTick(sys, e, st, dt) {
    const now = sys.time, R = st.recover, burrow = st.phase === 'burrow';
    if (this.finishRecover(sys, e, st)) return;
    const el = now - st.t0;
    // Watchdog: no progress in the offending extreme for 1.5 s nudges the route 30 degrees.
    const val = burrow ? minY(e) : maxY(e);
    const better = burrow ? val > R.watchVal + 1e-3 : val < R.watchVal - 1e-3;
    if (better) { R.watchVal = val; R.watchAt = now; }
    else if (now - R.watchAt > RECOVER_WATCH) { R.nudge += Math.PI / 6; R.watchAt = now; }
    if (!R.extra && el > RECOVER_DEADLINE) { R.extra = true; R.at = now; }
    if (R.extra && now - R.at > RECOVER_EXTRA) {
      // The plan prefers a rare kink to an eel parked above the film.
      this.logRecovery(sys, e, el, true);
      this.release(e, st);
      return;
    }
    const ang = Math.atan2(e.heading.z, e.heading.x) + R.nudge;
    const reach = e.length * (R.extra ? 1 : 0.8);
    const ty = burrow
      ? this.defaultFloor(e) + e.radius * 1.5
      : this.defaultCeil(e) - e.radius * (R.extra ? 3 : 1.5);
    this.drive(sys, e, dt, {
      tx: e.head.x + Math.cos(ang) * reach,
      tz: e.head.z + Math.sin(ang) * reach,
      speedBL: R.extra ? e.cruiseBL : e.prowlBL * RECOVER_SPEED,
      targetY: ty,
      excite: now < (st.embarrassedUntil ?? 0) ? 0.6 : 0,
    });
  }

  // The tick

  /* Returns true when this module owned the eel's movement; steer() returns straight away then, the
     way it already does for the freeze and the nope. */
  tick(sys, e, dt) {
    const st = this.map.get(e);
    if (!st || !st.state || e.slurpedBy) return false;
    // The bite's swim out to the reflection is uncommitted and voluntary, so steer runs it from the
    // voluntary section below the meal and social arbitration instead of from this early return.
    if (st.state === 'bite') return false;
    claimTick(e, 'air', st.state);
    e.reverse = false;
    switch (st.state) {
      case 'peek': this.peekTick(sys, e, st, dt); break;
      case 'flop': this.flopTick(sys, e, st, dt); break;
      case 'leap': this.leapTick(sys, e, st, dt); break;
      case 'burrow': this.digTick(sys, e, st, dt); break;
      case 'recover': this.recoverTick(sys, e, st, dt); break;
      default: return false;
    }
    // A state that ended inside its own tick without moving anything hands the tick straight back.
    return st.state !== null || st.moved === sys.ticks;
  }

  approaching(e) {
    const st = this.map.get(e);
    return !!st && st.state === 'bite' && !e.slurpedBy;
  }

  /* V8's voluntary half, called from steer's voluntary section. It owns the tick the same way the
     committed states do once it wins one; arriving hands over to the peek, which does not. */
  approachTick(sys, e, dt) {
    const st = this.map.get(e);
    if (!st || st.state !== 'bite' || e.slurpedBy) return false;
    claimTick(e, 'voluntary', 'moonbite');
    e.reverse = false;
    this.biteTick(sys, e, st, dt);
    return st.state !== null || st.moved === sys.ticks;
  }

  /* The approach lost the tick to a higher owner or to a crumb the eel can smell. Dropped quietly:
     no cooldown spent, and the reflection stops being the target the way a cancelled bite does. */
  cancelApproach(e) {
    const st = this.map.get(e);
    if (!st || st.state !== 'bite') return false;
    st.state = null; st.phase = ''; st.bite = false;
    e.retargetAt = 0;
    return true;
  }

  /* Slurp acquisition cancels the controller outright: the slurp owns the pose from that tick on.
     Spit restores the bounds after the chain reset. */
  cancel(e) {
    const st = this.map.get(e);
    if (!st) return false;
    st.deferNope = false;
    this.release(e, st);
    st.airFor = 0;
    return true;
  }

  restore(e) {
    const st = this.map.get(e);
    e.floorY = this.defaultFloor(e);
    e.ceilingY = this.defaultCeil(e);
    e.buried = false;
    e.burrowing = 0;
    if (e.uHaloMul) e.uHaloMul.value = this.haloBase(e);
    if (st) { st.state = null; st.phase = ''; st.exempt = false; st.airFor = 0; st.above = e.head.y > 0; st.dim = 0; }
    return true;
  }

  // Locomotion

  /* The owner's own move, in the shape steer() uses: one heading solve, the pose commit, then the
     head advance. Nothing after commitPose touches the committed fields. */
  drive(sys, e, dt, o) {
    const head = e.head;
    if (o.heading !== undefined) e.heading.set(Math.cos(o.heading), 0, Math.sin(o.heading));
    else if (!o.holdHeading && o.tx !== undefined) {
      const dx = o.tx - head.x, dz = o.tz - head.z;
      if (dx * dx + dz * dz > 1e-6) {
        let diff = wrapPi(Math.atan2(dz, dx) - Math.atan2(e.heading.z, e.heading.x));
        if (e.quirks?.leftOnly && diff > 0) diff -= Math.PI * 2;
        const maxTurn = e.turnRate * (1.6 - 0.6 * Math.min(1, e.speedBL / e.cruiseBL)) * dt;
        const yaw = Math.max(-maxTurn, Math.min(maxTurn, diff * Math.min(1, dt * 9)));
        const c = Math.cos(yaw), s = Math.sin(yaw);
        e.heading.set(e.heading.x * c - e.heading.z * s, 0, e.heading.x * s + e.heading.z * c).normalize();
      }
    }
    const reduce = sys.motion?.reduced ? 0.35 : 1;
    let speed = e.speedBL;
    if (o.speedFixed !== undefined) speed = o.speedFixed / Math.max(1e-4, e.length);
    else {
      const want = (o.speedBL ?? e.prowlBL) * reduce;
      const rate = want > e.speedBL ? 1.3 : 2.5;
      speed = e.speedBL + Math.max(-rate * dt, Math.min(rate * dt, want - e.speedBL));
    }
    e.speedMul += (1 - e.speedMul) * Math.min(1, dt * 4);
    e.uExcite.value += ((o.excite ?? 0) - e.uExcite.value) * Math.min(1, dt * 3);
    e.squash += ((o.squash ?? 1) - e.squash) * Math.min(1, dt * 5);
    const f = paceWave(e, dt, o.resting ?? false);
    e.pose.speed = speed;
    if (o.ampMul !== undefined) e.pose.ampMul = o.ampMul;
    if (o.targetY !== undefined) { e.pose.targetY = o.targetY; e.retargetYAt = sys.time + 0.5; }
    commitPose(e);
    const move = e.speedBL * e.length;
    head.addScaledVector(e.heading, move * dt);
    // Snout yaw as the derivative of its lateral sine, so the head stays in phase with the body wave.
    tmp.set(-e.heading.z, 0, e.heading.x);
    head.addScaledVector(tmp, Math.cos(e.wavePhase) * e.ampTail * 0.2 * e.anterior * Math.PI * 2 * f * dt);
    // ySet drives the head along a path this module computed (an arc, a slope); yAbs eases onto one
    // that could otherwise start with a step; neither uses the bob, which is a swimming tell.
    if (o.ySet !== undefined) head.y = o.ySet;
    else if (o.yAbs !== undefined) head.y += (o.yAbs - head.y) * Math.min(1, dt * (o.yRate ?? 8));
    else head.y += (e.targetY - head.y) * Math.min(1, dt * 1.5);
    e.lastX = head.x; e.lastZ = head.z;
    const st = this.map.get(e);
    if (st) st.moved = sys.ticks;
  }

  // Debug

  /* pond.eels.air.force(i, 'leap'): every state on demand, odds and cooldowns bypassed, physical
     preconditions kept where skipping one would push a body through scenery. */
  force(i, state = 'peek', opts = null) {
    const sys = this.sys;
    const e = typeof i === 'number' ? (sys.eels[i] ?? sys.guests[i - sys.eels.length]) : i;
    if (!e) return false;
    const st = this.map.get(e);
    if (!st) return false;
    if (st.state) this.release(e, st);
    if (!state) return true;
    // A guest that has not opted in is refused here too, or a console poke would raise Eleanor's
    // ceiling and leave the largest body in the pond free to breach.
    if (!this.allows(e)) return false;
    if (state === 'peek') { this.startPeek(e, st, opts?.reason ?? 'forced'); return true; }
    if (state === 'leap') { st.airFor = 0; return this.startLeap(e, st, opts?.target ?? null, true); }
    if (state === 'burrow') return this.tryBurrow(e, true);
    if (state === 'moonbite') { st.airFor = 0; st.biteAt = -1e9; return this.tryMoonBite(e, 0, true); }
    if (state === 'wake') return this.wake(e);
    if (state === 'flop') {
      let best = null, bd = Infinity;
      for (const l of sys.colliders.logs) {
        if (l.rInner <= 0) continue;
        const d = Math.hypot((l.a.x + l.b.x) * 0.5 - e.head.x, (l.a.z + l.b.z) * 0.5 - e.head.z);
        if (d < bd) { bd = d; best = l; }
      }
      return best ? this.tryFlop(e, best, opts?.target ?? null, true) : false;
    }
    return false;
  }

  debug(e) {
    const st = this.map.get(e);
    if (!st) return null;
    return {
      state: st.state, phase: st.phase, airFor: +st.airFor.toFixed(3),
      cooldown: Math.max(0, +(st.coolUntil - this.sys.time).toFixed(2)),
      moonBright: +this.moonBright(e).toFixed(4), moonOff: +st.moonOff.toFixed(4),
      floorY: +e.floorY.toFixed(4), ceilingY: +e.ceilingY.toFixed(4),
      buried: !!e.buried, burrowing: +(e.burrowing ?? 0).toFixed(3),
      exempt: st.exempt, abortedBy: st.abortedBy ?? '',
    };
  }
}

