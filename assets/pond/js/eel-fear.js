import { createRng, deriveSeed } from './rng.js';
import { nope, affection, dropCover } from './eel-behavior.js';
import { SPOOK_LIFE } from './eels.js';
import { TICK } from './eel-physics.js';

/* Fear (Part Two, F1-F6): who scares whom, how scary they are being right now, and what a frightened
   eel does about it. Mounted as sys.fear; everything keys by name or kind, never by "eel" or a guest. */

const FEAR_SALT = 3000;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hasKey = (o, k) => k !== null && k !== undefined && Object.prototype.hasOwnProperty.call(o, k);

// F1. Trust is slow to earn and lost in one sight of the queen eating a friend.
const TRUST_MAX = 0.4, TRUST_NEAR = 3, TRUST_GAIN = 0.01, TRUST_DECAY = 0.002, TRUST_SLURP = 0.3;
const SPIKE_AMOUNT = 0.3, SPIKE_FOR = 120, WITNESS_R = 4;
const SIZE_RATIO = 1.15, SIZE_K = 0.8, SIZE_CAP = 0.4, SIZE_FOND = 0.3;
// F2/F2a.
const FAST_SPEED = 4, FAST_FAM = 0.5, FAST_EVERY = 0.25, FAST_STRENGTH = 1.2;
const STILL_FOR = 1, STILL_FAM = 0.3, STILL_W = 0.35, LURE_FAM_K = 1.5;
const FINGER_REF = 3, BURST_MUL = 1.6, BURST_CONE = Math.cos(30 * Math.PI / 180);
const MOVING_BL = 0.12;
// F3.
const SCATTER_AT = 0.5, SCATTER_LEN = [1.5, 3], SCATTER_MUL = 1.6, WAKE_SPOOK = 0.5, PANIC_FLOOR = 0.02;
// F4.
const CLAIM_R = 1.2, GAPE_LEN = [0.3, 0.8], LUNGE_BL = [0.5, 1], LUNGE_FOR = 1.0, RETURN_FOR = 1.5;
const LUNGE_MUL = 1.6;
const VISITOR_SPOOK = 0.8, DISPLACE_SPOOK = 0.6, CONTEST_WINDOW = 60;
const VISITOR_BACKSTOP = 8;   // only fires if the occupant stopped ticking; its sequence caps at 3.3 s
const CLOSING_EPS = 0.02;     // world units of approach over the gape that count as "still coming on"
// F5.
const ALARM_N = 96, ALARM_REACH = 3, ALARM_TAU = 25, ALARM_STEP = 0.5, ALARM_RATE = 0.4;
const ALARM_EVERY = 6, ALARM_WAKE = 0.6, ALARM_R = 0.6, ALARM_LIFE = 90, ALARM_SPOOK_EVERY = 2;
const CALM_N = 24, CALM_CAP = 60, CALM_TAU = 300;
// F6.
const METERS = {
  poke: { need: 5, window: 12, refractory: 20, maxRaw: 1.2 },
  recolor: { need: 4, window: 6, refractory: 15 },
  drag: { need: 6, window: 20, refractory: 25 },
};
const POKE_CAUSES = new Set(['poke', 'swish', 'finger-fast']);
const FAM_DEAF = 0.7;   // past this the hand is a friend: it stops feeding the spook meter entirely
const ROLL_FOR = 1.5, ROLL_BACK = 1, DEADPAN_FOR = 3, DIZZY_FOR = 1.5, RETREAT_FOR = 15;
const DRAG_REACH = 2;   // pointer capsule overlaps the body within radius × this
const DRAG_BUCKET = 0.25;   // contact accrues into quarter-second entries, not one record a tick
// The comfort stop puts back exactly what the appearance rolls wrote, nothing else on the eel.
const APPEARANCE = [
  'colA', 'colB', 'flagBands', 'skinMul', 'rampStops', 'rampOpts', 'jelly', 'nameStyle', 'nick',
  'stripeFreq', 'spotFreq', 'wStripe', 'wSpot', 'wBand', 'wRace', 'raceOff', 'wPlaid', 'plaidFreq',
  'wRidge', 'wFlank', 'wavy', 'pulseRate', 'repeats', 'glowMode',
];

export function attachFear(sys, seed) {
  const mod = new FearSystem(seed);
  mod.sys = sys;
  sys.addModule(mod);
  sys.fear = mod;
  return mod;
}

class FearSystem {
  constructor(seed) {
    this.seed = seed;
    this.sys = null;
    this.state = new Map();
    // The alarm trail is a fixed ring of reused records: names, never live references, so a hot-swap
    // cannot retarget a mark somebody already smelled.
    this.alarm = Array.from({ length: ALARM_N }, () => ({ x: 0, z: 0, t: -1e9, strength: 0, emitter: null, src: null, kind: null }));
    this.alarmHead = 0;
    this.calm = new Float32Array(CALM_N * CALM_N);
    // The hand as an ordinary feared body, so F1 and F3 need no special case for it.
    this.hand = { name: 'finger', nameKey: 'finger', kind: 'finger', length: 0, cruiseBL: 0, x: 0, z: 0, active: false, dragging: false, speed: 0, familiarity: 0, stillFor: 0 };
    this.handPrev = { x: 0, z: 0, has: false };
    this.guestSet = new Set();
    this.refugeLocks = new Map();   // refuge id → { who, x, z }; the point resolves near-duplicates
    this.pairLocks = new Map();     // "a|b" → occupant
    this.contests = [];             // pond-wide start times, for the three-a-minute cap
    this.fastAt = 0;
    this.near = { x: 0, z: 0, d: 0 };
    this.reach = 0;
    this.bySource = new Map();   // scratch for the alarm sample
    this.spine = [0, 0, 0];      // head, mid, tail sample indices, reused every distance test
    // Two reused records: the steer hooks below run every tick and their answers are read immediately.
    this.burst = { speedMul: 1, excite: 0 };
    this.own = { own: true, burst: 0 };
  }

  stateFor(e) {
    let st = this.state.get(e);
    if (!st) { st = this.fresh(e); this.state.set(e, st); }
    return st;
  }

  fresh(e) {
    return {
      rng: createRng(deriveSeed(this.seed, FEAR_SALT + (e.index ?? 0))),
      trust: new Map(),        // name → 0..TRUST_MAX
      spike: new Map(),        // name → { amount, until }, the witnessed-slurp bonus
      lastD: new Map(),        // name → last distance, for the closing speed
      panic: 0, panicName: null, panicKind: null, panicX: 0, panicZ: 0,
      out: [], pool: [],       // the danger writers handed to the braincell
      alarmAt: -1, alarmW: [], alarmPool: [], localAlarm: 0, alarmX: 0, alarmZ: 0, alarmHas: false,
      alarmSpookAt: 0, alarmQuietUntil: -1e9,
      scatter: null,
      contest: null, contestAt: -1e9, pending: null,
      meters: { poke: { events: [], refractoryUntil: 0 }, recolor: { events: [], refractoryUntil: 0 }, drag: { events: [], refractoryUntil: 0 } },
      seen: new Map(),         // spook id → t, so one stimulus counts once per eel
      tell: null,
      snap: null,
    };
  }

  /* A hot-swap hands the body to somebody new: every meter, trust, lock, and bout goes with the eel
     who left. Called by EelSystem.swapIdentity through the module hook. */
  initEel(sys, e) {
    this.releaseLocks(e);
    this.state.set(e, this.fresh(e));
  }

  // F1. base = fears[name] ?? fears[kind] ?? 0, and an explicit zero is an immunity, not a floor.
  baseFear(e, nameKey, kind) {
    const f = e.fears;
    if (!f) return { base: 0, immune: true };
    if (hasKey(f, nameKey)) return { base: f[nameKey], immune: f[nameKey] === 0 };
    if (hasKey(f, kind)) return { base: f[kind], immune: f[kind] === 0 };
    return { base: 0, immune: false };
  }

  fearOf(e, o) {
    if (!o || o === e) return 0;
    const nameKey = o.nameKey ?? null;
    const kind = o.kind ?? 'eel';
    const { base, immune } = this.baseFear(e, nameKey, kind);
    if (immune) return 0;
    const st = this.stateFor(e);
    if (kind === 'finger') return clamp01(base * (1 - clamp01(o.familiarity ?? 0)));
    const spike = st.spike.get(nameKey);
    const bonus = spike ? spike.amount : 0;
    return clamp01(base + bonus + this.sizeTerm(e, o, kind) - (st.trust.get(nameKey) ?? 0));
  }

  /* The dominance rule: about 1.15× length at equal girth is the 1.5 mass ratio that makes one eel
     step aside at the crumb. Guests are their own thing (a guest is scary by threat, not by ratio). */
  sizeTerm(e, o, kind) {
    if (kind !== 'eel' || !e.length || !o.length) return 0;
    const raw = Math.min(SIZE_CAP, Math.max(0, (o.length / e.length - SIZE_RATIO) * SIZE_K));
    if (raw <= 0) return 0;
    const now = this.sys.time;
    const fond = o === e.partner || e === o.partner || (e.cuddle?.with === o && now < e.cuddle.until);
    return raw * (fond ? SIZE_FOND : 1);
  }

  /* Alarm marks carry a name and a kind rather than a body, so this is the fear map without an object. */
  fearByName(e, nameKey, kind) {
    const { base, immune } = this.baseFear(e, nameKey, kind);
    if (immune) return 0;
    const st = this.stateFor(e);
    const spike = st.spike.get(nameKey);
    return clamp01(base + (spike ? spike.amount : 0) - (st.trust.get(nameKey) ?? 0));
  }

  // F2. How scary the other party is being right now, independent of who is watching.
  threatOf(observer, o) {
    if (o.kind === 'finger') {
      if (!o.dragging) return 0;
      return clamp01((o.speed - 2) / 6) * (1 - clamp01(o.familiarity));
    }
    if (this.guestSet.has(o)) {
      let t = o.threat ?? 0.3;
      // A hunter published its quarry: everyone else is a bystander to the same chase.
      if (o.threatOn) t *= o.threatOn === observer ? 1.5 : 0.6;
      return clamp01(t);
    }
    const now = this.sys.time;
    if (now < (o.buttBurst ?? 0)) return 1;
    if (this.state.get(o)?.contest?.phase === 'lunge') return 1;
    if ((o.speedMul ?? 1) >= BURST_MUL) {
      const dx = observer.head.x - o.head.x, dz = observer.head.z - o.head.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4 && (o.heading.x * dx + o.heading.z * dz) / d > BURST_CONE) return 1;
    }
    return (o.speedBL ?? 0) > MOVING_BL ? 0.5 : 0.25;
  }

  /* Nearest of head, mid, and tail: a tail sweeping past counts, and a long body is not a point. */
  nearestOf(e, o) {
    const out = this.near, head = e.head;
    if (!o.pts) { out.x = o.x; out.z = o.z; out.d = Math.hypot(o.x - head.x, o.z - head.z); return out; }
    const n = o.pts.length, spine = this.spine;
    spine[0] = 0; spine[1] = n >> 1; spine[2] = n - 1;
    out.d = Infinity;
    for (const i of spine) {
      const p = o.pts[i];
      const d = Math.hypot(p.x - head.x, p.z - head.z);
      if (d < out.d) { out.d = d; out.x = p.x; out.z = p.z; }
    }
    return out;
  }

  // F3. Fear x how scary x how close x how fast it is closing, all measured to that nearest sample.
  panicOf(e, o, dt) {
    const st = this.stateFor(e);
    const nameKey = o.nameKey ?? null;
    const fear = this.fearOf(e, o);
    if (fear <= 0) { st.lastD.delete(nameKey); return 0; }
    const near = this.nearestOf(e, o);
    const d = near.d;
    const reach = (2 + 4 * fear) * (e.length || 1);
    this.reach = reach;
    const prev = st.lastD.get(nameKey);
    st.lastD.set(nameKey, d);
    if (d >= reach) return 0;
    const threat = this.threatOf(e, o);
    if (threat <= 0) return 0;
    const proximity = clamp01(1 - d / reach);
    const ref = o.kind === 'finger' ? FINGER_REF : Math.max(1e-3, (o.cruiseBL ?? 0.5) * (o.length || 1));
    const closing = prev !== undefined && dt > 1e-6 ? (prev - d) / dt : 0;
    const approach = 0.4 + 0.6 * clamp01(closing / ref);
    return clamp01(fear * threat * proximity * approach * (this.sys.knobs.fear ?? 1));
  }

  panic(e) { return this.state.get(e)?.panic ?? 0; }

  localAlarm(e) { return this.state.get(e)?.localAlarm ?? 0; }

  /* Chunk 1's hook. Feared bodies and cached alarm marks are the same shape to the danger ring. */
  dangerWriters(e) { return this.state.get(e)?.out ?? null; }

  // F5's calm grid, in seconds of rest per cell, exposed 0–1.
  calmAt(x, z) {
    const i = this.cellOf(x, z);
    return i < 0 ? 0 : clamp01(this.calm[i] / CALM_CAP);
  }

  cellOf(x, z) {
    const ext = this.sys?.extent || 1;
    const u = Math.floor((x / ext + 0.5) * CALM_N);
    const v = Math.floor((z / ext + 0.5) * CALM_N);
    if (u < 0 || v < 0 || u >= CALM_N || v >= CALM_N) return -1;
    return v * CALM_N + u;
  }

  /* The nap roll, bent by both trails at once: a fresh scare keeps everyone up, a well-slept corner
     invites the next bout. Read by updateGait, which draws either way, so the stream never shifts. */
  holdMul(e) {
    const st = this.state.get(e);
    const alarm = st ? st.localAlarm : 0;
    return Math.max(0, 1 - alarm) * (1 + 0.5 * this.calmAt(e.head.x, e.head.z));
  }

  // F2a. A hand that has been in the water a while is interesting rather than frightening.
  lureMul(e) {
    const st = this.stateFor(e);
    if (st.scatter || this.sys.time < st.meters.drag.refractoryUntil) return 0;
    return 1 + LURE_FAM_K * clamp01(this.hand.familiarity) * (e.traits?.curious ?? 1);
  }

  fingerPeekMul(e) { return 0.5 + clamp01(this.hand.familiarity); }

  prepass(sys, dt) {
    const now = sys.time;
    this.guestSet.clear();
    for (const g of sys.guests) this.guestSet.add(g);
    const f = sys.finger, h = this.hand;
    h.x = f.x; h.z = f.z; h.speed = f.speed; h.stillFor = f.stillFor;
    h.familiarity = clamp01(f.familiarity);
    h.active = f.mode !== 'none';
    h.dragging = f.mode === 'drag';
    const decay = Math.exp(-dt / CALM_TAU);
    for (let i = 0; i < this.calm.length; i++) this.calm[i] *= decay;
    this.dragContact(sys, dt, now);
    for (const e of sys.eels) this.think(sys, e, dt, now, false);
    for (const g of sys.guests) this.think(sys, g, dt, now, true);
    this.fastFinger(sys, now);
    this.acquireContests(sys, now);
    this.handPrev.x = h.x; this.handPrev.z = h.z; this.handPrev.has = h.active;
  }

  think(sys, e, dt, now, isGuest) {
    const st = this.stateFor(e);
    if (e.slurpedBy) { st.panic = 0; st.pending = null; st.out.length = 0; this.cancelContest(e, st); return; }
    this.decayTrust(sys, e, st, dt, now);
    this.buildPanic(sys, e, st, dt, now);
    // Staggered by index so the six samples land on six different ticks rather than all on one.
    if (st.alarmAt < 0 || (sys.ticks + (e.index ?? 0)) % ALARM_EVERY === 0) this.sampleAlarm(e, st, now);
    this.appendAlarm(st);
    if (isGuest) { this.guestAlarm(e, st, now); return; }
    this.alarmEffects(sys, e, st, now);
    this.scatterStep(sys, e, st, dt, now);
    this.calmStep(e, dt, now);
    this.meterStep(e, st, now);
  }

  decayTrust(sys, e, st, dt, now) {
    for (const [k, v] of st.trust) {
      const w = v - TRUST_DECAY * dt;
      if (w <= 0) st.trust.delete(k); else st.trust.set(k, w);
    }
    for (const [k, s] of st.spike) if (now > s.until) st.spike.delete(k);
    // An id that nothing can re-observe anymore has no duplicate left to suppress, so it ages out along
    // with the spook itself. The extra tick is slack: eels.js only expires the list after this prepass has already run.
    for (const [id, t] of st.seen) if (now - t > SPOOK_LIFE + TICK) st.seen.delete(id);
  }

  /* One pass over everything this eel could be afraid of: the panic scalar, and the danger writers
     the braincell will fold into its ring during steer. */
  buildPanic(sys, e, st, dt, now) {
    st.out.length = 0;
    let best = 0, bestName = null, bestKind = null, bestX = 0, bestZ = 0;
    let n = 0;
    const consider = (o) => {
      const p = this.panicOf(e, o, dt);
      if (p <= PANIC_FLOOR) return;
      // panicOf left the nearest spine sample and the reach it measured against in place.
      const rec = st.pool[n] ?? (st.pool[n] = { x: 0, z: 0, r: 0, strength: 0 });
      rec.x = this.near.x; rec.z = this.near.z; rec.r = this.reach; rec.strength = p;
      st.out.push(rec);
      n++;
      if (p > best) {
        best = p;
        // Lowercase, because every downstream lookup (the fears table, the lair test, the alarm
        // mark's source) is keyed the way the identity tables are.
        bestName = o.nameKey ?? null;
        bestKind = o.kind ?? 'eel';
        bestX = rec.x; bestZ = rec.z;
      }
    };
    for (const o of sys.eels) if (o !== e && !o.slurpedBy) consider(o);
    for (const g of sys.guests) if (g !== e && !g.slurpedBy) consider(g);
    if (this.hand.active) consider(this.hand);
    st.panic = best;
    st.panicName = bestName; st.panicKind = bestKind;
    st.panicX = bestX; st.panicZ = bestZ;
    // Trust accrues only while nothing is happening: a calm neighbor within three units, no panic.
    if (best <= PANIC_FLOOR) this.growTrust(sys, e, st, dt);
  }

  growTrust(sys, e, st, dt) {
    const bump = (o) => {
      if (o === e || o.slurpedBy || !o.name) return;
      if (Math.hypot(o.head.x - e.head.x, o.head.z - e.head.z) > TRUST_NEAR) return;
      const k = o.nameKey;
      st.trust.set(k, Math.min(TRUST_MAX, (st.trust.get(k) ?? 0) + TRUST_GAIN * dt));
    };
    for (const o of sys.eels) bump(o);
    for (const g of sys.guests) bump(g);
  }

  /* F1's other half: seeing the queen eat a friend costs her every second of trust she had earned,
     and buys her two minutes of extra fear on top. */
  witnessSlurp(sys, predator, prey) {
    const key = predator.nameKey ?? null;
    if (!key) return;
    const now = sys.time;
    for (const o of sys.eels) {
      if (o === prey || o.slurpedBy) continue;
      if (Math.hypot(o.head.x - predator.head.x, o.head.z - predator.head.z) > WITNESS_R) continue;
      const st = this.stateFor(o);
      st.trust.set(key, Math.max(0, (st.trust.get(key) ?? 0) - TRUST_SLURP));
      st.spike.set(key, { amount: SPIKE_AMOUNT, until: now + SPIKE_FOR });
    }
  }

  // F5. One mark, damped by how calm this water has been.
  deposit(x, z, strength, emitter, src, kind, now) {
    const s = strength * (1 - 0.5 * this.calmAt(x, z));
    if (s <= 1e-3) return;
    const m = this.alarm[this.alarmHead];
    this.alarmHead = (this.alarmHead + 1) % ALARM_N;
    m.x = x; m.z = z; m.t = now; m.strength = s;
    m.emitter = emitter; m.src = src; m.kind = kind;
  }

  guestAlarm(g, st, now) {
    const threat = g.threat ?? 0.3;
    if (threat <= 0) return;
    if (st.gx === undefined) { st.gx = g.head.x; st.gz = g.head.z; return; }
    if (Math.hypot(g.head.x - st.gx, g.head.z - st.gz) < ALARM_STEP) return;
    st.gx = g.head.x; st.gz = g.head.z;
    const key = g.nameKey ?? null;
    this.deposit(g.head.x, g.head.z, threat, key, key, g.kind ?? 'guest', now);
  }

  /* Sampled every sixth tick and reapplied on the other five: the ring is rebuilt every tick but the
     trail does not move fast enough to be worth walking ninety times a second. */
  sampleAlarm(e, st, now) {
    st.alarmAt = now;
    st.alarmW.length = 0;
    const mine = e.nameKey ?? null;
    // The sum runs over sources, not marks: a guest laying a mark every half unit of travel would
    // otherwise pin every reader at 1 for as long as she is out, and a pond that never sleeps.
    const perSource = this.bySource;
    perSource.clear();
    let bestS = 0, bx = 0, bz = 0, has = false;
    for (const m of this.alarm) {
      const age = now - m.t;
      if (age < 0 || age > ALARM_LIFE) continue;
      if (m.emitter && m.emitter === mine) continue;   // nobody scares themselves with their own trail
      const d = Math.hypot(m.x - e.head.x, m.z - e.head.z);
      if (d > ALARM_REACH) continue;
      const f = this.fearByName(e, m.src, m.kind);
      if (f <= 0) continue;
      const s = m.strength * (1 - d / ALARM_REACH) * Math.exp(-age / ALARM_TAU) * f;
      if (s <= 1e-3) continue;
      if (s > (perSource.get(m.src) ?? 0)) perSource.set(m.src, s);
      if (s > bestS) { bestS = s; bx = m.x; bz = m.z; has = true; }
    }
    let sum = 0;
    for (const v of perSource.values()) sum += v;
    st.localAlarm = clamp01(sum);
    st.alarmX = bx; st.alarmZ = bz; st.alarmHas = has;
    // One cached writer, at the strongest mark: the trail is a place to avoid, not ten of them.
    if (has) {
      const rec = st.alarmPool[0] ?? (st.alarmPool[0] = { x: 0, z: 0, r: ALARM_R, strength: 0 });
      rec.x = bx; rec.z = bz; rec.strength = st.localAlarm;
      st.alarmW.push(rec);
    }
  }

  appendAlarm(st) { for (const w of st.alarmW) st.out.push(w); }

  /* The maps reach nobody who is asleep, so alarm gets two explicit effects on top of the berth. */
  alarmEffects(sys, e, st, now) {
    if (st.localAlarm <= ALARM_WAKE || !st.alarmHas) return;
    const resting = e.gait === 'hold' && now < e.gaitUntil;
    if (resting) {
      e.gaitUntil = Math.min(e.gaitUntil, now);
      e.restPose.kind = '';
      e.snuggle.with = null;
      return;
    }
    if (now < st.alarmSpookAt) return;
    st.alarmSpookAt = now + ALARM_SPOOK_EVERY;
    // A flight this spook starts leaves no marks of its own, or panic would chain through the pile
    // forever instead of dying out after one pass.
    st.alarmQuietUntil = now + ALARM_SPOOK_EVERY;
    // `only` keeps one eel's inherited fright off the whole pond; the trail is what carries it.
    sys.spook(st.alarmX, st.alarmZ, st.localAlarm, { cause: 'alarm', only: e });
  }

  scatterStep(sys, e, st, dt, now) {
    const sc = st.scatter;
    if (sc) {
      if (now >= sc.until) { st.scatter = null; return; }
      // Every half unit of travel while fleeing, so a bolt leaves a trail rather than one mark.
      if (!sc.quiet && Math.hypot(e.head.x - sc.lastX, e.head.z - sc.lastZ) >= ALARM_STEP && now >= sc.depositAt) {
        sc.lastX = e.head.x; sc.lastZ = e.head.z;
        sc.depositAt = now + ALARM_RATE;
        this.deposit(e.head.x, e.head.z, sc.strength, sc.mine, sc.src, sc.kind, now);
      }
      return;
    }
    if (st.panic <= SCATTER_AT || st.pending) return;
    // Decided here, begun in steer: the reverse escape runs above the scatter hook, and starting a
    // nope from the prepass could clear its tunnel or open a hide underneath it.
    st.pending = { src: st.panicName, kind: st.panicKind, x: st.panicX, z: st.panicZ, strength: st.panic, quiet: now < st.alarmQuietUntil };
  }

  startScatter(sys, e, st, now, src, kind, x, z, strength, fromAlarm) {
    const mine = e.nameKey ?? null;
    const until = now + st.rng.range(SCATTER_LEN[0], SCATTER_LEN[1]);
    st.scatter = { until, src, kind, mine, strength, quiet: fromAlarm, lastX: e.head.x, lastZ: e.head.z, depositAt: 0 };
    // Naps, braids, meals, and loiters all end here; fleeUntil is what the social blocks already read.
    e.fleeUntil = Math.max(e.fleeUntil, until);
    e.attnReset = false;
    e.snack.until = 0;
    e.restPose.kind = '';
    e.snuggle.with = null;
    if (e.gait === 'hold') e.gaitUntil = Math.min(e.gaitUntil, now);
    dropCover(sys, e);
    if (e.coverSpot?.type === 'graze') e.coverSpot = null;
    if (e.food) { e.food.claims = Math.max(0, e.food.claims - 1); e.food = null; }
    this.cancelContest(e, st);
    // The threat's own den is no refuge: the log is only cover when she is not the thing in it.
    const lair = this.lairOf(sys, src);
    nope(sys, e, { x, z }, now, lair ? { avoidLog: lair } : null);
    sys.emit('scatter', e);
    if (!fromAlarm) this.deposit(e.head.x, e.head.z, strength, mine, src, kind, now);
    // The bolt itself is the next eel's warning, which is what makes a feed spree empty in a ripple.
    sys.spook(e.head.x, e.head.z, WAKE_SPOOK, { cause: 'alarm', except: e });
  }

  lairOf(sys, src) {
    if (!src) return null;
    for (const g of sys.guests) if (g.lair && g.nameKey === src) return g.lair;
    return null;
  }

  scattering(e) { return !!this.state.get(e)?.scatter; }
  /* A scatter decided but not yet begun: the air module reads this as a scare, so a peek submerges
     first and the bout starts the tick recovery hands the eel back. */
  pendingScatter(e) { return !!this.state.get(e)?.pending; }

  /* Called from steer below the reverse escape, so an eel backing out of a bore clears the mouth
     before the burst; a scatter does interrupt a tunnel run, exactly as today's nope does. */
  scatterTick(sys, e, dt) {
    const st = this.state.get(e);
    if (st?.pending) {
      const p = st.pending;
      st.pending = null;
      this.startScatter(sys, e, st, sys.time, p.src, p.kind, p.x, p.z, p.strength, p.quiet);
    }
    if (!st?.scatter) return null;
    this.burst.speedMul = SCATTER_MUL;
    this.burst.excite = st.scatter.strength;
    return this.burst;
  }

  calmStep(e, dt, now) {
    const resting = (e.gait === 'hold' && now < e.gaitUntil) || !!e.restPose?.kind;
    if (!resting && e.coverSpot?.type !== 'tea') return;
    const i = this.cellOf(e.head.x, e.head.z);
    if (i < 0) return;
    this.calm[i] = Math.min(CALM_CAP, this.calm[i] + dt);
  }

  // F2a's fast-finger startle: the "clears a lane" moment, and a familiar hand emits none of it.
  fastFinger(sys, now) {
    const h = this.hand;
    if (!h.dragging || h.speed <= FAST_SPEED || h.familiarity >= FAST_FAM) return;
    if (now < this.fastAt) return;
    this.fastAt = now + FAST_EVERY;
    sys.spook(h.x, h.z, FAST_STRENGTH * (1 - h.familiarity), { cause: 'finger-fast' });
  }

  /* F2a's patient hand: a real force term toward the pointer, not a fake lure, because a lure has to
     be a second old before anything reads it and a held-still hand never ages one. */
  forceTick(sys, e, force, dt) {
    const h = this.hand;
    if (!h.active || h.stillFor <= STILL_FOR || h.familiarity <= STILL_FAM) return;
    const st = this.stateFor(e);
    if (st.scatter || sys.time < st.meters.drag.refractoryUntil) return;
    const dx = h.x - e.head.x, dz = h.z - e.head.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.4 || d > 6) return;
    const w = STILL_W * h.familiarity * (e.traits?.curious ?? 1);
    force.x += (dx / d) * w;
    force.z += (dz / d) * w;
  }

  // F4. What this eel is currently the occupant of, as a stable id plus the point it is holding.
  refugeOf(sys, e, now) {
    if (e.tunnel && e.tunnel.hideUntil && now > e.tunnel.hideFrom && now < e.tunnel.hideUntil) {
      const log = sys.colliders.logs[0];
      if (!log) return null;
      const da = Math.hypot(log.a.x - e.head.x, log.a.z - e.head.z);
      const db = Math.hypot(log.b.x - e.head.x, log.b.z - e.head.z);
      return { id: `log:0:${da < db ? 'a' : 'b'}`, x: e.head.x, z: e.head.z };
    }
    const c = e.coverSpot;
    if (!c) return null;
    if (c.type === 'pad' && now < (c.holdUntil ?? 0)) return { id: `pad:${c.idx}`, x: e.head.x, z: e.head.z };
    if (c.type === 'rock' && c.refuge) {
      const d = Math.hypot(c.x - e.head.x, c.z - e.head.z);
      if (d <= (c.radius ?? e.radius * 2) + e.length * 0.5) return { id: c.refuge, x: e.head.x, z: e.head.z };
    }
    return null;
  }

  pairKey(a, b) { return a.index < b.index ? `${a.index}|${b.index}` : `${b.index}|${a.index}`; }

  acquireContests(sys, now) {
    // Pond-wide rate cap first: three a minute keeps the Roadmap's "mostly cozy" rule intact.
    const cap = sys.knobs.contestCap ?? {};
    const perMinute = cap.perMinute ?? 3, perOccupant = cap.perOccupant ?? 30;
    while (this.contests.length && now - this.contests[0] > CONTEST_WINDOW) this.contests.shift();
    if (this.contests.length >= perMinute) return;
    for (const e of sys.eels) {
      if (this.contests.length >= perMinute) return;
      if (e.slurpedBy) continue;
      const st = this.stateFor(e);
      if (st.contest || st.scatter || now - st.contestAt < perOccupant) continue;
      // An air state owns its eel's tick outright, so neither side of a contest may be in one: the two
      // machines would otherwise run at once and air's early return would pause the contest mid-lock.
      if (sys.air?.owns(e)) continue;
      const refuge = this.refugeOf(sys, e, now);
      if (!refuge || this.locked(refuge)) continue;
      const reach = e.length;
      for (const v of sys.eels) {
        if (v === e || v.slurpedBy || sys.air?.owns(v)) continue;
        const vs = this.stateFor(v);
        if (vs.contest || vs.scatter) continue;
        if (Math.hypot(v.head.x - refuge.x, v.head.z - refuge.z) > reach) continue;
        if (affection(e, v, now) > 0 || affection(v, e, now) > 0) continue;
        const pk = this.pairKey(e, v);
        if (this.pairLocks.has(pk)) continue;
        this.startContest(sys, e, v, st, vs, refuge, pk, now);
        break;
      }
    }
  }

  /* One contest per hole, and two nearby names for the same hole are one hole: the claim region is
     1.2 body lengths of whoever is sitting in it, so each lock carries its own holder's radius. */
  locked(refuge) {
    if (this.refugeLocks.has(refuge.id)) return true;
    for (const l of this.refugeLocks.values()) if (Math.hypot(l.x - refuge.x, l.z - refuge.z) <= l.r) return true;
    return false;
  }

  /* The public "this eel is mid-contest" test, so air states can refuse to start on top of one. */
  contesting(e) { return !!this.state.get(e)?.contest; }

  startContest(sys, occupant, visitor, st, vs, refuge, pk, now) {
    this.refugeLocks.set(refuge.id, { who: occupant, x: refuge.x, z: refuge.z, r: CLAIM_R * (occupant.length || 1) });
    this.pairLocks.set(pk, occupant);
    this.contests.push(now);
    st.contestAt = now;
    // Possession counts: a tie goes to whoever is already in the hole.
    const holds = this.fearOf(visitor, occupant) >= this.fearOf(occupant, visitor);
    const rec = { role: 'occupant', other: visitor, refuge: refuge.id, pair: pk, x: refuge.x, z: refuge.z, phase: '', until: 0 };
    st.contest = rec;
    // The visitor holds no clock of its own: ending on a shorter timer than the occupant's sequence
    // dropped both locks mid-lunge. VISITOR_BACKSTOP only catches an occupant that stopped ticking.
    vs.contest = { role: 'visitor', other: occupant, refuge: refuge.id, pair: pk, x: refuge.x, z: refuge.z, phase: 'visit', until: now + VISITOR_BACKSTOP };
    if (!holds) {
      sys.spook(occupant.head.x, occupant.head.z, DISPLACE_SPOOK, { cause: 'contest', only: occupant });
      rec.phase = 'done';
      rec.until = now;
      this.endContest(sys, occupant, st);
      return;
    }
    rec.phase = 'gape';
    rec.until = now + st.rng.range(GAPE_LEN[0], GAPE_LEN[1]);
    rec.d0 = Math.hypot(visitor.head.x - occupant.head.x, visitor.head.z - occupant.head.z);
    rec.prevD = rec.d0;
    sys.emit('gape', occupant);
  }

  /* The refuge contest's gape-then-lunge sequence. The occupant owns its tick through the whole
     sequence and the visitor owns its own, so nothing else steers either of them mid-contest. */
  contestTick(sys, e, dt) {
    const st = this.state.get(e);
    const c = st?.contest;
    if (!c) return null;
    const now = sys.time;
    const other = c.other;
    if (!other || other.slurpedBy || e.slurpedBy || st.scatter) { this.cancelContest(e, st); return null; }
    if (c.role === 'visitor') {
      if (now >= c.until) { this.endContest(sys, e, st); return null; }
      return this.owned(0);
    }
    if (c.phase === 'gape') {
      e.target.set(other.head.x, 0, other.head.z);
      e.pose.speed = 0;
      e.pose.squash = 1.3;
      e.pose.excite = 1;
      const d = Math.hypot(other.head.x - e.head.x, other.head.z - e.head.z);
      if (now < c.until) { c.prevD = d; return this.owned(0); }
      // The lunge answers a visitor that is still coming on, not merely one that is still nearby:
      // either it closed over the gape or it is closing right now.
      const closing = c.d0 - d > CLOSING_EPS || c.prevD - d > 0;
      if (d > e.length * 1.5 || !closing) { this.endContest(sys, e, st); return null; }
      c.phase = 'lunge';
      c.until = now + LUNGE_FOR;
      const reach = st.rng.range(LUNGE_BL[0], LUNGE_BL[1]) * e.length;
      const dx = other.head.x - e.head.x, dz = other.head.z - e.head.z;
      const len = Math.max(1e-4, Math.hypot(dx, dz));
      c.toX = e.head.x + (dx / len) * reach;
      c.toZ = e.head.z + (dz / len) * reach;
      sys.emit('lunge', e);
      sys.spook(e.head.x, e.head.z, VISITOR_SPOOK, { cause: 'contest', only: other });
      return this.owned(LUNGE_MUL);
    }
    if (c.phase === 'lunge') {
      e.target.set(c.toX, 0, c.toZ);
      if (now < c.until && Math.hypot(c.toX - e.head.x, c.toZ - e.head.z) > 0.3) return this.owned(LUNGE_MUL);
      c.phase = 'return';
      c.until = now + RETURN_FOR;
      return this.owned(0);
    }
    e.target.set(c.x, 0, c.z);
    if (now >= c.until || Math.hypot(c.x - e.head.x, c.z - e.head.z) < 0.4) { this.endContest(sys, e, st); return null; }
    return this.owned(0);
  }

  owned(burst) { this.own.burst = burst; return this.own; }

  endContest(sys, e, st) {
    const c = st?.contest;
    if (!c) return;
    st.contest = null;
    const held = this.refugeLocks.get(c.refuge);
    if (held && held.who === (c.role === 'occupant' ? e : c.other)) this.refugeLocks.delete(c.refuge);
    this.pairLocks.delete(c.pair);
    const os = c.other ? this.state.get(c.other) : null;
    if (os?.contest && os.contest.pair === c.pair) os.contest = null;
  }

  cancelContest(e, st) {
    if (st?.contest) this.endContest(this.sys, e, st);
  }

  releaseLocks(e) {
    const st = this.state.get(e);
    if (st) this.cancelContest(e, st);
    for (const [id, l] of this.refugeLocks) if (l.who === e) this.refugeLocks.delete(id);
    for (const [pk, who] of this.pairLocks) if (who === e) this.pairLocks.delete(pk);
  }

  // F6. Contact with the live pointer capsule, integrated while it actually overlaps the body.
  dragContact(sys, dt, now) {
    const h = this.hand, prev = this.handPrev;
    if (!h.dragging || !prev.has) return;
    const reach = DRAG_REACH;
    for (const e of sys.eels) {
      if (e.slurpedBy) continue;
      let hit = false;
      for (const p of e.pts) {
        if (segPoint(p.x, p.z, prev.x, prev.z, h.x, h.z) <= e.radius * reach) { hit = true; break; }
      }
      if (!hit) continue;
      const st = this.stateFor(e);
      const m = st.meters.drag;
      if (now < m.refractoryUntil) continue;
      const last = m.events[m.events.length - 1];
      if (last && now - last.t < DRAG_BUCKET) last.dt += dt;
      else m.events.push({ t: now, dt });
      this.checkDrag(sys, e, st, m, now);
    }
  }

  checkDrag(sys, e, st, m, now) {
    const win = METERS.drag.window * this.windowScale(e);
    let total = 0, w = 0;
    for (const ev of m.events) if (now - ev.t <= win) { m.events[w++] = ev; total += ev.dt; }
    m.events.length = w;
    if (total >= METERS.drag.need) {
      m.events.length = 0;
      m.refractoryUntil = now + METERS.drag.refractory;
      this.startTell(sys, e, st, 'drag', now);
    }
  }

  windowScale(e) { return 1.5 - 0.5 * clamp01(e.focus ?? 0); }

  /* A stimulus counts once per eel, the first time it lands inside effective range: the spook list is
     re-read every tick, so counting per tick would call one poke five pokes. */
  noteSpook(e, s) {
    if (!POKE_CAUSES.has(s.cause)) return;
    // Every cause this meter counts comes from the hand, so a hand this well known feeds it nothing.
    if (this.hand.familiarity > FAM_DEAF) return;
    const st = this.stateFor(e);
    if (st.seen.has(s.id)) return;
    const now = this.sys.time;
    st.seen.set(s.id, now);
    const m = st.meters.poke;
    if (now < m.refractoryUntil) return;
    const win = METERS.poke.window * this.windowScale(e);
    let w = 0;
    for (const t of m.events) if (now - t <= win) m.events[w++] = t;
    m.events.length = w;
    m.events.push(now);
    if (m.events.length >= METERS.poke.need) {
      m.events.length = 0;
      m.refractoryUntil = now + METERS.poke.refractory;
      this.startTell(this.sys, e, st, 'poke', now);
    }
  }

  /* The refractory: an ordinary poke is exactly 1, so anything genuinely stronger still lands, and
     contest, headbutt, and alarm causes always do. */
  ignoreSpook(e, s) {
    const st = this.state.get(e);
    if (!st) return false;
    const now = this.sys.time;
    if (POKE_CAUSES.has(s.cause) && now < st.meters.poke.refractoryUntil && s.strength <= METERS.poke.maxRaw) return true;
    if (s.cause === 'swish' && now < st.meters.drag.refractoryUntil) return true;
    return false;
  }

  /* Called by EelSystem.recolor before any roll: a vetoed eel must not advance its own rng streams,
     or the veto would change what everybody wears next time. */
  noteRecolor(sys, e) {
    const st = this.stateFor(e);
    const now = sys.time;
    const m = st.meters.recolor;
    if (now < m.refractoryUntil) return false;
    const win = METERS.recolor.window * this.windowScale(e);
    let w = 0;
    for (const t of m.events) if (now - t <= win) m.events[w++] = t;
    m.events.length = w;
    if (!m.events.length) st.snap = snapshot(e);
    m.events.push(now);
    if (m.events.length >= METERS.recolor.need) {
      m.events.length = 0;
      m.refractoryUntil = now + METERS.recolor.refractory;
      this.startTell(sys, e, st, 'recolor', now);
    }
    return true;
  }

  meterStep(e, st, now) {
    const t = st.tell;
    if (!t || now < t.until) return;
    if (t.meter === 'recolor' && st.snap) { restore(e, st.snap); this.sys.renderer.applyAppearance(e); st.snap = null; }
    st.tell = null;
  }

  startTell(sys, e, st, meter, now) {
    if (st.tell) return;
    const kind = meter === 'poke' ? (st.rng.chance(0.5) ? 'roll' : 'deadpan')
      : meter === 'recolor' ? (st.rng.chance(0.5) ? 'loop' : 'belly')
        : 'retreat';
    const dur = kind === 'roll' ? ROLL_FOR + ROLL_BACK : kind === 'deadpan' ? DEADPAN_FOR : kind === 'retreat' ? RETREAT_FOR : DIZZY_FOR;
    st.tell = { kind, meter, at: now, until: now + dur };
    // Q-C owns every roll in the pond, this one included; what stays here is which meter fired.
    if (kind === 'roll') sys.stim?.rollStart(e, 'lazy');
    if (kind === 'belly') sys.stim?.rollStart(e, 'dizzy');
    if (kind === 'loop') { e.gait = 'loop'; e.gaitUntil = now + DIZZY_FOR; }
    if (kind === 'retreat') {
      const hw = e.view.w * 0.45, hh = e.view.h * 0.45;
      st.tell.x = this.hand.x >= 0 ? -hw : hw;
      st.tell.z = this.hand.z >= 0 ? -hh : hh;
    }
    sys.emit('overit', e, { detail: { meter } });
  }

  /* The tell owns the target and the pose for its one reaction. It yields to a scatter and a slurp
     and never interrupts a run: those tiers claim the tick above it. */
  tellTick(sys, e, dt, held = false) {
    const st = this.state.get(e);
    const t = st?.tell;
    if (!t) return false;
    // Yields to a scatter and a slurp; a run, a reverse escape, and an air state all outrank it, so
    // it stops overriding rather than cancelling anything.
    if (held || st.scatter || e.slurpedBy || e.tunnel || sys.air?.owns?.(e)) return false;
    // A committed meal or a social hold outranks a tell too: the reaction waits it out on its own
    // clock rather than pulling a feeding, sipping, twined, or snuggled eel off what it is doing.
    if (e.food || e.restPose?.kind || e.twine) return false;
    if (e.coverSpot?.type === 'tea' || e.coverSpot?.type === 'graze') return false;
    if (e.snuggle?.with && sys.time < e.snuggle.until) return false;
    const now = sys.time;
    // The roll itself belongs to Q-C's controller, which is already turning the eel in the prepass;
    // the lazy turn and the comfort stop's belly-up supply only the speed that goes with them.
    if (t.kind === 'roll') { e.pose.speed = e.prowlBL * 0.6; return true; }
    if (t.kind === 'belly') { e.pose.speed = e.prowlBL * 0.4; return true; }
    if (t.kind === 'deadpan') {
      e.pose.speed = e.prowlBL * 0.5;
      e.pose.squash = 1.2;
      e.target.set(this.hand.x, 0, this.hand.z);
      return true;
    }
    if (t.kind === 'retreat') {
      e.target.set(t.x, 0, t.z);
      e.pose.speed = e.prowlBL;
      if (Math.hypot(t.x - e.head.x, t.z - e.head.z) < 0.6) t.until = Math.min(t.until, now);
      return true;
    }
    return false;   // the loop gait draws itself through updateGait's own branch
  }

  debug(e) {
    const st = this.state.get(e);
    if (!st) return null;
    return {
      panic: st.panic, source: st.panicName, localAlarm: st.localAlarm,
      calm: this.calmAt(e.head.x, e.head.z), writers: st.out.length,
      scatter: !!st.scatter, contest: st.contest?.phase ?? null, tell: st.tell?.kind ?? null,
      trust: Object.fromEntries(st.trust), poke: st.meters.poke.events.length,
    };
  }
}

function snapshot(e) {
  const s = {};
  for (const k of APPEARANCE) s[k] = e[k];
  return s;
}

function restore(e, s) {
  for (const k of APPEARANCE) e[k] = s[k];
}

function segPoint(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}
