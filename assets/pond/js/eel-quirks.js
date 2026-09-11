import { createRng, deriveSeed } from './rng.js';
import { headPush } from './eel-physics.js';
import { floorHeightAt } from './floor.js';

/* Part Four: the small repeated movements that make an animal look occupied. Stimming, bonking,
   spin feeding, the one roll owner every rolling behavior goes through, and the food-drunk wobble.
   Mounted as sys.stim, which is the name eel-air.js's moon-bite huff already reaches for. */

const QUIRK_SALT = 3300;      // per-eel behavioral stream: one salt per slot, never per identity
const DECOR_SALT = 3299;      // the spin's bubbles, so a quality rung can never shift a decision
const TAU = Math.PI * 2;

const STIM_EVERY = [3, 8];    // seconds per unit of stim; a stim of 0 never rolls at all
// A 50 degree yaw on a three-unit eel is about half a body length of head travel from directly above,
// which is the smallest offset that reads as deliberate rather than as steering noise.
const SHUFFLE_FOR = 0.7, SHUFFLE_YAW = 50 * Math.PI / 180, SHUFFLE_BL = 0.5;
// A flick that raises the wave amplitude is legible; one that lowers it just looks like slowing down.
const FLICK_FOR = 0.5, FLICK_AMP = 1.45;
const SLOW_PROWL = 1.2;       // times prowl: an unhurried wander is idle enough to fidget in
const DEEP_EDGE = 3;          // a deep sleeper fidgets this far into a hold and this far from its end
const PROBE_REACH = 0.5;      // body lengths to a rock rim or an open log mouth worth nosing
const PROBE_SQUASH = 1.15, PROBE_BACK = 0.2, PROBE_CAP = 4, PROBE_OUT = 1.2;
const LAIR_WOBBLE = 10 * Math.PI / 180, LAIR_WOBBLE_FOR = 1.2;

const SPIN_REVS = [2, 5], SPIN_YAW = 10 * Math.PI / 180, SPIN_BUB = 0.12;
const GRATITUDE_HALF = 1.5;   // the half turn, and again for the belly-up drift before it comes back
const TELL_ROLL = 1.5, TELL_ROLL_HOLD = 1, TELL_BELLY = 0.4, TELL_BELLY_HOLD = 0.7;
const EASE_RATE = TAU;        // an interrupted roll unwinds at one revolution a second
const HALF_TILT = Math.PI / 4;   // reduced motion: what is left of the roll family
const HOLD_BL = 0.05;         // updateGait's own hold speed, for the gratitude drift
const BONK_TELEPORT = 1.5;    // head displacement in radii past which it was a placement, not a bump

/* Q-D. Read off the live length every tick and applied once per quantity, never compounded into
   stored state, so an eel that shrinks back under the line sheds all four effects at once. */
export const FOOD_DRUNK = { at: 5.5, bob: 2, want: 0.85, focus: 0.7, squash: 1.08 };

// Guests carry drunkAt Infinity: Eleanor is born past the line and her selection stays untouched.
export function foodDrunk(e) { return (e?.length ?? 0) > (e?.drunkAt ?? FOOD_DRUNK.at); }

export function attachQuirks(sys, seed) {
  // Idempotent: a second module would re-roll every eel's stim clock and double the spin's bubbles.
  if (sys.stim) return sys.stim;
  const q = new Quirks(sys, seed);
  sys.stim = q;
  sys.addModule(q);
  // The gratitude roll needs meal history, and a finished crumb is exactly what `eat` announces.
  sys.on('eat', (ev) => q.onMeal(ev));
  return q;
}

export class Quirks {
  constructor(sys, seed) {
    this.sys = sys;
    this.seed = seed;
    this.map = new Map();
    this.decorRng = createRng(deriveSeed(seed, DECOR_SALT));
  }

  /* Q-C's head wobble offered to the brain's one checked nudge, so the legality test sees it. Jaz's
     snake grid never reaches that nudge, so she spins without the wobble. */
  yawProposal(e) {
    const st = this.map.get(e);
    return st?.spin && st.roll ? Math.sin(phaseOf(e)) * SPIN_YAW : 0;
  }

  // Live knob accessor, the same shape as eel-air.js's.
  kStim() { return num(this.sys.knobs?.stim, 1); }
  kSpin() { return num(this.sys.knobs?.spin, 1); }
  q(name) { return num(this.sys.knobs?.quirks?.[name], DIALS[name]); }

  state(e) { return this.map.get(e) ?? null; }

  initEel(sys, e) {
    e.roll = 0;
    const rng = createRng(deriveSeed(this.seed, QUIRK_SALT + (e.index ?? 0)));
    this.map.set(e, {
      rng,
      nextStim: sys.time + this.stimGap(e, rng),
      bout: null, roll: null, spin: null, spinRevs: 0, spinTried: -1,
      bonkAt: -1e9, meals: 0,
    });
  }

  stimRate(e) { return Math.max(0, (e.stim ?? 0) * this.kStim()); }

  /* A stim of 0 is a gate, never a deadline: writing Infinity into the clock latched stimming off for
     the rest of the session the first time knobs.stim passed through zero. */
  stimGap(e, rng) {
    const s = this.stimRate(e);
    return rng.range(STIM_EVERY[0], STIM_EVERY[1]) / (s > 0 ? s : 1);
  }

  prepass(sys, dt) {
    const now = sys.time;
    for (const e of sys.eels) this.advance(sys, e, dt, now);
    for (const g of sys.guests) this.advance(sys, g, dt, now);
  }

  advance(sys, e, dt, now) {
    const st = this.map.get(e);
    if (!st) return;
    // Lifecycle cleanup, the one place outside commitPose that writes e.roll: the jaws own the pose
    // from the tick they close, and a spat-out eel comes back level.
    if (e.slurpedBy) {
      st.roll = null; st.spin = null; st.bout = null;
      e.roll = 0;
      if (e.uRoll) e.uRoll.value = 0;   // commitPose is unreachable while slurped, so level the shader here
      return;
    }
    this.bonkWatch(sys, e, st, now);
    this.spinBubbles(sys, e, st, now);
    this.rollStep(sys, e, st, dt, now);
  }

  // Q-B, the universal bonk

  /* eels.js stamps prev[] immediately before collide() and constrain() never moves point 0, so the
     head's displacement across that pass is exactly what the eel ran into on the previous tick. */
  bonkWatch(sys, e, st, now) {
    if (now - st.bonkAt < this.q('bonkEvery') || e.speedBL <= e.cruiseBL) return;
    const push = headPush(e) / e.radius;
    // Above BONK_TELEPORT it was not a collision at all: a lair placement or a spit moves the head
    // whole units, and the worst real push measured over ten minutes of chasing was 0.77 radii.
    if (push <= this.q('bonkPush') || push > BONK_TELEPORT) return;
    st.bonkAt = now;
    sys.emit('bonk', e, { detail: { strength: push * e.radius } });
  }

  /* Q-B, the bonk-hunters. The angle the crumb approach is rotated by so the lunge line runs through
     the nearest hard thing; null keeps today's random miss. Clamped so a rock behind the eel is no aim. */
  bonkAim(sys, e, crumb) {
    const reach = this.q('bonkNear');
    let bx = 0, bz = 0, bd = reach;
    for (const o of sys.colliders.spheres) {
      const r = o.rHit ?? o.r;
      const d = Math.hypot(crumb.x - o.x, crumb.z - o.z) - r;
      if (d >= bd) continue;
      bd = d;
      const a = Math.atan2(crumb.z - o.z, crumb.x - o.x);
      bx = o.x + Math.cos(a) * r; bz = o.z + Math.sin(a) * r;
    }
    for (const l of sys.colliders.logs) {
      const p = segNearest(crumb.x, crumb.z, l);
      const d = Math.hypot(crumb.x - p.x, crumb.z - p.z) - l.rOuter;
      if (d >= bd) continue;
      bd = d;
      bx = p.x; bz = p.z;
    }
    if (bd >= reach) return null;
    const to = Math.atan2(bz - e.head.z, bx - e.head.x);
    const at = Math.atan2(crumb.z - e.head.z, crumb.x - e.head.x);
    const off = Math.atan2(Math.sin(to - at), Math.cos(to - at));
    const cap = this.q('bonkAngle');
    return Math.max(-cap, Math.min(cap, off));
  }

  // Q-C, spin feeding

  /* A committed sequence: the odds are rolled once per crumb and the revolutions finish whether or
     not the treat survives them, because the eel is swallowing. */
  trySpin(sys, e, crumb) {
    const st = this.map.get(e);
    if (!st || st.spin || st.spinTried === crumb.dropId) return false;
    // Refused before it costs anything: a roll started under a bore run is eased away on the next
    // prepass, and the event, the bubbles, and the doubled bite rate would fire for nothing.
    if (this.interrupted(sys, e, sys.time)) return false;
    st.spinTried = crumb.dropId;
    if (sys.motion?.reduced) return false;
    if (!st.rng.chance(Math.max(0, (e.spinOdds ?? 0) * this.kSpin()))) return false;
    if (!this.rollStart(e, 'spin')) return false;
    st.spin = { bubAt: 0, dropId: crumb.dropId };
    sys.emit('spin', e, { detail: { revs: st.spinRevs } });
    return true;
  }

  // Derived from the live spin, and only for the treat that started it: a crumb the eel picks up
  // mid-roll is an ordinary mouthful.
  biteMul(e, food) {
    const sp = this.map.get(e)?.spin;
    return sp && sp.dropId === food?.dropId ? 2 : 1;
  }

  spinBubbles(sys, e, st, now) {
    if (!st.spin) return;
    if (!st.roll || st.roll.kind !== 'spin') { st.spin = null; return; }
    if (now < st.spin.bubAt) return;
    st.spin.bubAt = now + SPIN_BUB;
    const r = this.decorRng;
    sys.effects?.spawn(e.head.x + r.range(-0.05, 0.05), e.head.y + 0.02, e.head.z + r.range(-0.05, 0.05), 'bubbleTiny');
  }

  // The roll family, one owner

  /* Every member is a list of legs: an absolute unwrapped phase, the rate to walk there, and how long
     to sit on it. An interruption replaces the list with a single ease to the nearest full turn. */
  rollStart(e, kind) {
    const st = this.map.get(e);
    if (!st || e.slurpedBy) return false;
    const reduced = !!this.sys.motion?.reduced;
    if (reduced && (kind === 'spin' || kind === 'lazy')) return false;
    if (st.roll && !st.roll.easing) return false;
    const from = phaseOf(e);
    const half = reduced ? HALF_TILT : Math.PI;
    let legs = null, speed = null;
    if (kind === 'spin') {
      st.spinRevs = st.rng.int(SPIN_REVS[0], SPIN_REVS[1]);
      legs = [{ to: from + TAU * st.spinRevs, rate: TAU, hold: 0 }];
    } else if (kind === 'gratitude') {
      const rate = half / GRATITUDE_HALF;
      legs = [{ to: from + half, rate, hold: GRATITUDE_HALF }, { to: from, rate, hold: 0 }];
      speed = HOLD_BL;
    } else if (kind === 'dizzy') {
      const rate = half / TELL_BELLY;
      legs = [{ to: from + half, rate, hold: TELL_BELLY_HOLD }, { to: from, rate, hold: 0 }];
    } else if (kind === 'lazy') {
      legs = [{ to: from + TAU, rate: TAU / TELL_ROLL, hold: TELL_ROLL_HOLD }];
    } else return false;
    st.roll = { kind, legs, i: 0, easing: false, speed, holdUntil: -1 };
    return true;
  }

  /* Which roll is turning, for anyone who cares that an eel is currently throwing itself around. The
     unwind keeps its kind, so a spin reads as a spin until the body is level again. */
  rolling(e) {
    return this.map.get(e)?.roll?.kind ?? null;
  }

  rollBusy(e) {
    const r = this.map.get(e)?.roll;
    return !!r && !r.easing;
  }

  /* Never a one-tick reset: whatever was rolling unwinds from where it is to the nearest full turn,
     which for a spin is the plan's "continue to the nearest full revolution". */
  rollEnd(e) {
    const st = this.map.get(e);
    const r = st?.roll;
    if (!r || r.easing) return false;
    r.easing = true;
    // The unwind is not the spin: the bubbles, the head yaw, and the doubled bite rate end with it.
    if (r.kind === 'spin') st.spin = null;
    r.legs = [{ to: Math.round(phaseOf(e) / TAU) * TAU, rate: EASE_RATE, hold: 0 }];
    r.i = 0;
    r.speed = null;
    r.holdUntil = -1;
    return true;
  }

  /* Any tier that owns the eel outright. The roll does not fight it, it unwinds underneath it. */
  interrupted(sys, e, now) {
    return !!(sys.fear?.scattering(e) || sys.air?.owns?.(e) || e.tunnel
      || now < e.nopeUntil || now < e.freezeUntil || now < e.fleeUntil);
  }

  /* The committed phase is the truth, never a private copy. A tick that never reaches commitPose (a
     freeze, a nope) leaves e.roll where it is, so the roll waits there instead of drifting off it. */
  rollStep(sys, e, st, dt, now) {
    if (!st.roll) return;
    if (!st.roll.easing && this.interrupted(sys, e, now)) this.rollEnd(e);
    const r = st.roll;
    const cur = phaseOf(e);
    const leg = r.legs[r.i];
    const gap = leg.to - cur;
    const step = leg.rate * dt;
    let next = cur + Math.sign(gap) * step;
    if (Math.abs(gap) <= step) {
      next = leg.to;
      if (r.holdUntil < 0) r.holdUntil = now + leg.hold;
      // The last leg retires only once the phase it asked for is the committed one: a final tick that
      // never reaches commitPose (a nope, a freeze) would otherwise strand up to one step of tilt.
      const settled = r.i + 1 < r.legs.length || Math.abs(cur - leg.to) < 1e-6;
      if (now >= r.holdUntil && settled) {
        r.i++;
        r.holdUntil = -1;
        if (r.i >= r.legs.length) { st.roll = null; st.spin = null; }
      }
    }
    e.pose.roll = next;
    // A prepass pose write with no tier claim, so it yields to every tier that outranks a voluntary roll.
    if (r.speed !== null && this.speedFree(sys, e)) e.pose.speed = r.speed;
  }

  speedFree(sys, e) {
    // A flee burst outranks the gratitude crawl, or the eel that just ate by the finger creeps away from it.
    if (e.food || e.tunnel || sys.time < e.fleeUntil) return false;
    if (e.coverSpot?.type === 'tea' || e.coverSpot?.type === 'graze') return false;
    return !(sys.fear?.contesting?.(e));
  }

  /* The gratitude roll's trigger. Grazing never reaches here: it announces itself as `graze`. */
  onMeal(ev) {
    if (ev.source !== 'eel' || !ev.eel) return;
    const st = this.map.get(ev.eel);
    if (!st) return;
    if (ev.food?.contested) { st.meals = 0; return; }
    if (++st.meals < this.q('gratitude')) return;
    st.meals = 0;
    this.rollStart(ev.eel, 'gratitude');
  }

  // Q-A, stimming

  /* Called from steer below the tells. A bout owns the eel in the voluntary tier and parks its
     target, which is why only an idle hold may start one; a forced shuffle runs wherever it is. */
  tick(sys, e, dt, held = false) {
    const st = this.map.get(e);
    if (!st) return false;
    const now = sys.time;
    // Re-validated every tick, not only at the start: a bore run or a crumb acquired mid-bout outranks
    // a fidget, and a bout that kept writing target and pose underneath the owner would drag the eel off.
    if (st.bout) {
      if (held || !this.boutFree(sys, e)) { st.bout = null; return false; }
      return this.boutTick(sys, e, st, now);
    }
    if (held || this.stimRate(e) <= 0) return false;
    // The clock runs whatever the eel is doing; only the bout waits for somewhere idle to happen in.
    if (now < st.nextStim || !this.idleHold(sys, e, now)) return false;
    st.nextStim = now + this.stimGap(e, st.rng);
    const seam = this.probeSeam(sys, e);
    const kind = st.rng.pick(seam ? ['shuffle', 'flick', 'probe'] : ['shuffle', 'flick']);
    if (kind === 'probe') st.bout = { kind, for: PROBE_CAP, until: 0, phase: 'in', seam, bx: 0, bz: 0 };
    else if (kind === 'flick') st.bout = { kind, for: FLICK_FOR, until: 0 };
    else st.bout = { kind, for: SHUFFLE_FOR, until: 0, ang: this.shuffleAng(e, st) };
    return this.boutTick(sys, e, st, now);
  }

  /* eel-air.js's moon-bite huff. The bout waits for a tick it may actually own rather than expiring
     under the air state that asked for it. */
  shuffle(e) {
    const st = this.map.get(e);
    if (!st || st.bout) return false;
    st.bout = { kind: 'shuffle', for: SHUFFLE_FOR, until: 0, ang: this.shuffleAng(e, st) };
    return true;
  }

  shuffleAng(e, st) {
    return Math.atan2(e.heading.z, e.heading.x) + (st.rng.chance(0.5) ? SHUFFLE_YAW : -SHUFFLE_YAW);
  }

  /* Everything a fidget yields to. Tested every tick of a bout, not only at the start, because a meal
     or a bore run acquired mid-bout owns the eel from that tick on. */
  boutFree(sys, e) {
    if (e.tunnel || e.food || e.buried || e.restPose?.kind) return false;
    // Tea and a graze are meals holding still, not an animal with nothing to do.
    if (e.coverSpot?.type === 'tea' || e.coverSpot?.type === 'graze') return false;
    return !(sys.air?.busy?.(e)) && !(sys.crush?.active?.(e));
  }

  idleHold(sys, e, now) {
    const held = e.gait === 'hold' && now < e.gaitUntil;
    if (!held && !(e.gait === 'prowl' && e.speedBL < e.prowlBL * SLOW_PROWL)) return false;
    // Gated on the middle of the bout, not on the identity: a deep sleeper still fidgets as it settles
    // and as it wakes, which is the only window the pond's three biggest holders ever get.
    if (held && e.census?.twoAM === 'asleep' && now - e.gaitFrom > DEEP_EDGE && e.gaitUntil - now > DEEP_EDGE) return false;
    return this.boutFree(sys, e);
  }

  boutTick(sys, e, st, now) {
    const b = st.bout;
    if (b.until === 0) b.until = now + b.for;
    if (b.kind === 'probe') return this.probeTick(sys, e, st, b, now);
    if (now >= b.until) { st.bout = null; return false; }
    if (b.kind === 'flick') { e.pose.ampMul = FLICK_AMP; return true; }
    e.target.set(e.head.x + Math.cos(b.ang) * e.length * 0.6, 0, e.head.z + Math.sin(b.ang) * e.length * 0.6);
    e.pose.speed = e.prowlBL * SHUFFLE_BL;
    return true;
  }

  probeTick(sys, e, st, b, now) {
    if (now >= b.until) { st.bout = null; return false; }
    const s = b.seam;
    if (b.phase === 'in') {
      e.target.set(s.x, 0, s.z);
      e.pose.targetY = s.y;
      e.pose.speed = e.prowlBL;
      if (Math.hypot(e.head.x - s.x, e.head.z - s.z) > e.radius + 0.06) return true;
      b.phase = 'out';
      b.until = Math.min(b.until, now + PROBE_OUT);
      b.bx = e.head.x - e.heading.x * e.length * PROBE_BACK;
      b.bz = e.head.z - e.heading.z * e.length * PROBE_BACK;
      e.pose.squash = PROBE_SQUASH;
      sys.emit('bonk', e, { detail: { soft: true } });
      sys.air?.puff(s.x, s.z, 'grain', 2, e.heading);
      sys.air?.puff(s.x, s.z, 'silt', 2);
      return true;
    }
    e.target.set(b.bx, 0, b.bz);
    e.pose.speed = e.prowlBL * SHUFFLE_BL;
    if (Math.hypot(e.head.x - b.bx, e.head.z - b.bz) < 0.15) { st.bout = null; return false; }
    return true;
  }

  /* The surface facing the eel at the local sand height: a rock's rim or an open log mouth. */
  probeSeam(sys, e) {
    const hx = e.head.x, hz = e.head.z;
    let best = null, bd = e.length * PROBE_REACH;
    for (const o of sys.colliders.spheres) {
      const r = o.rHit ?? o.r;
      const dx = hx - o.x, dz = hz - o.z, d = Math.hypot(dx, dz);
      if (d < 1e-4 || d - r >= bd) continue;
      bd = d - r;
      best = { x: o.x + (dx / d) * r, z: o.z + (dz / d) * r, y: null };
    }
    for (const l of sys.colliders.logs) {
      if (l.rInner <= 0) continue;
      for (const m of [l.a, l.b]) {
        const dx = hx - m.x, dz = hz - m.z, d = Math.hypot(dx, dz);
        // Surface distance and the mouth rim, the same metric and the same kind of point as the rock
        // faces above; the bore axis is a spot inside the log, and the sand under it is not a seam.
        if (d < 1e-4 || d - l.rOuter >= bd) continue;
        bd = d - l.rOuter;
        best = { x: m.x + (dx / d) * l.rOuter, z: m.z + (dz / d) * l.rOuter, y: m.y };
      }
    }
    if (!best) return null;
    best.y = Math.max(e.floorY + 0.02, best.y ?? floorHeightAt(best.x, best.z) + e.radius * 1.2);
    return best;
  }

  /* The guest contract: an intent, not a move. Eleanor's lair hold applies this through her own
     locomotion, so nothing here touches e.target. No shuffle and no probe: she is inside her log. */
  lairStim(sys, e) {
    const st = this.map.get(e);
    if (!st) return null;
    const now = sys.time;
    if (!st.bout) {
      if (this.stimRate(e) <= 0 || now < st.nextStim) return null;
      st.nextStim = now + this.stimGap(e, st.rng);
      st.bout = st.rng.chance(0.5)
        ? { kind: 'flick', for: FLICK_FOR, until: 0 }
        : { kind: 'wobble', for: LAIR_WOBBLE_FOR, until: 0, amp: st.rng.chance(0.5) ? LAIR_WOBBLE : -LAIR_WOBBLE };
    }
    const b = st.bout;
    if (b.until === 0) b.until = now + b.for;
    if (now >= b.until) { st.bout = null; return null; }
    // A whole sine period of yaw rate over the bout, so she never ends the wobble off her lair axis.
    // Anything that is not a wobble reads as the flick, so a bout meant for a resident cannot leak in.
    if (b.kind !== 'wobble') return { ampMul: FLICK_AMP, yaw: 0 };
    const u = 1 - (b.until - now) / b.for;
    return { ampMul: null, yaw: b.amp * Math.cos(u * TAU) * TAU / b.for };
  }

  debug(e) {
    const st = this.map.get(e);
    if (!st) return null;
    return {
      stim: e.stim, nextStim: st.nextStim, bout: st.bout?.kind ?? null,
      roll: st.roll ? { kind: st.roll.kind, cur: phaseOf(e), easing: st.roll.easing } : null,
      spinning: !!st.spin, revs: st.spinRevs, meals: st.meals, bonkAt: st.bonkAt,
      drunk: foodDrunk(e),
    };
  }
}

// Taste dials, live under pond.eels.knobs.quirks; knobs.stim and knobs.spin stay plain multipliers.
const DIALS = { bonkPush: 0.6, bonkEvery: 2, bonkNear: 1.2, bonkAngle: Math.PI / 3, gratitude: 3 };

function phaseOf(e) { return Number.isFinite(e.roll) ? e.roll : 0; }

function num(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }

function segNearest(px, pz, l) {
  const ax = l.b.x - l.a.x, az = l.b.z - l.a.z;
  const len2 = ax * ax + az * az || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - l.a.x) * ax + (pz - l.a.z) * az) / len2));
  return { x: l.a.x + ax * t, z: l.a.z + az * t };
}
