import { createRng, deriveSeed } from './rng.js';
import { claimTick, startTwine, endTwine } from './eel-behavior.js';
import {
  pairKey, partnersOf, stepMissing, strollPoint, boopPoint, paceMul, catchUpMul, pickWeighted,
  vigilPoint, NEAR_FILL,
} from './eel-bond-core.js';

/* The life bond. Seams eel-behavior.js reads: active(e) parks the wander re-pick, follower(e) parks the
   gait roll, pickTarget(sys, e, now) claims social, pullMul/holdMul/twineMul/paceMul bend four odds. */

const SALT = 2200;
const DIALS = {
  apart: [60, 120], farDist: 5, nearFill: NEAR_FILL, seekMax: 40, seekOdds: null, hello: 1.5, helloTwine: 0.75,
  stroll: [30, 90], strollHold: 0.6, strollRest: 0.05, leadOdds: null, twineBoost: 4, rest: [20, 60],
  restTogether: 2, loneRest: 0.5, cool: 45, apartPull: 0.5, keep: 0.5, guestNear: 6, panicCut: 0.35,
  vigilGap: 2.5, vigilMax: 30, brave: 0.15, reunionHellos: 3, forceWait: 90,
};
// Reasons no window will ever open for a forced bout, so force() refuses instead of queueing.
const PERMANENT = new Set(['nobond', 'nopartner']);
const ARRIVE = 1.2;              // seeker body lengths from the partner's head that counts as arrived
const BOOP_NEAR = 1.4;           // radius sums between noses the boop fires inside
const AMP_PULSE = 1.6, AMP_FOR = 0.4;
const SEEK_MUL = 1.15, VIGIL_MUL = 1.3;
const STROLL_SIDE = 2.2;         // radius sums of clear water between the two strolling bodies
const REUNION_GAP = 1.3;         // seconds between the boops of a reunion
const HELLO_TWINE = [5, 9];
// A boop that never lands is the one phase with no clock of its own, so the approach is bounded.
const HELLO_MAX = 12;
const VIGIL_INSET = 0.45;        // the vigil's station stays this far inside the view, like the leap's landings
// Backstop behind onEnabled: sim seconds between prepasses that mean the ticks stopped for a while,
// whatever stopped them. Normal running advances sys.time exactly one tick per prepass.
const PAUSE_GAP = 0.5;
const DEEP_HOLD = 5;             // hold-bout seconds past which steer calls it a real rest, poses and all
// Refreshed every tick of a hello so nothing downstream reads the pause as a nap: startPose, the
// burrow, and steer's own deep-rest test all key off how long the current hold bout has been running.
const HELLO_SLICE = 0.5;

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const dist = (a, b) => Math.hypot(a.head.x - b.head.x, a.head.z - b.head.z);
const gaitBLOf = (e, gait) => (gait === 'cruise' ? e.cruiseBL : e.prowlBL);

export function attachBond(sys, seed) {
  if (sys.bond instanceof Bond) return sys.bond;
  const bond = new Bond(sys, seed);
  sys.bond = bond;
  sys.addModule(bond);
  return bond;
}

export class Bond {
  constructor(sys, seed) {
    this.sys = sys;
    this.rng = createRng(deriveSeed(seed, SALT));
    this.map = new Map();      // one record per resident; bounded by the cast
    this.pairs = new Map();    // key → the couple's whole history, bout or no bout
    this.lastAt = sys.time;
  }

  k(name) { return num(this.sys.knobs?.bond?.[name], DIALS[name]); }

  /* A dial that is deliberately allowed to be off: a finite number overrides the per-eel weights, and
     anything else (null by default) hands the decision back to the identities. */
  odds(name) { return num(this.sys.knobs?.bond?.[name], null); }

  roll(name) {
    const v = this.sys.knobs?.bond?.[name];
    const lo = num(v?.[0], DIALS[name][0]), hi = num(v?.[1], DIALS[name][1]);
    return this.rng.range(Math.min(lo, hi), Math.max(lo, hi));
  }

  /* Whether the wander re-pick and the gait roll should leave this eel alone. Two names for one set
     because steer reads them for two different reasons; the stroll leader is in neither. */
  active(e) {
    const rec = this.map.get(e)?.pair;
    if (!rec) return false;
    return !(rec.phase === 'stroll' && rec.leader === e);
  }

  follower(e) { return this.active(e); }

  initEel(sys, e) {
    // A hot-swap hands this body to someone new: whatever the leaver was in the middle of is over, and
    // the graph has to be rebuilt around whoever just arrived.
    const st = this.map.get(e);
    if (st?.pair) this.endPair(st.pair, 'swapped');
    this.map.set(e, { pair: null, tickedAt: -1, forceUntil: 0, want: '' });
    this.buildGraph(sys);
  }

  /* The undirected bond graph, rebuilt from the cast: an edge exists when either identity names the
     other and both are in the pond. Couples who survive a rebuild keep their meter and their cooldown. */
  buildGraph(sys) {
    const roster = new Set(sys.eels.map((o) => o.name));
    const byName = new Map(sys.eels.map((o) => [o.name, o]));
    const seen = new Set();
    for (const e of sys.eels) {
      for (const name of partnersOf(e.name, e.quirks?.lifeBond, roster)) {
        const key = pairKey(e.name, name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const other = byName.get(name);
        const [a, b] = e.index <= other.index ? [e, other] : [other, e];
        const rec = this.pairs.get(key);
        if (rec) { rec.a = a; rec.b = b; }
        else this.pairs.set(key, this.fresh(key, a, b));
      }
    }
    for (const [key, rec] of this.pairs) {
      if (seen.has(key)) continue;
      if (rec.phase !== 'apart') this.endPair(rec, 'swapped');
      this.pairs.delete(key);
    }
  }

  fresh(key, a, b) {
    return {
      key, a, b, missing: 0, apartFor: this.roll('apart'), phase: 'apart',
      seeker: null, leader: null, follower: null, taken: null, guest: null,
      t0: 0, until: 0, step: 0, side: 1, boops: 0, booped: 0, boopAt: 0, closeFrom: 0, ampUntil: 0,
      twineWhen: 0, eightDone: 0, eight: null, reunion: false, snugSet: false, heldGait: false, vigilSpent: false,
      coolUntil: 0, lastEnd: '', lastEndAt: -1,
    };
  }

  /* The pond going dark ends every bout: ticks stop while sys.time runs on, so a stroll would wake
     against clocks that expired without it. */
  onEnabled(sys, on) {
    if (!on) for (const rec of this.pairs.values()) if (rec.phase !== 'apart') this.endPair(rec, 'disabled');
    this.lastAt = sys.time;
  }

  prepass(sys, dt) {
    const now = sys.time;
    if (now - this.lastAt > PAUSE_GAP) {
      for (const rec of this.pairs.values()) if (rec.phase !== 'apart') this.endPair(rec, 'paused');
    }
    this.lastAt = now;
    if (!this.pairs.size) return;
    const step = num(dt, 0);
    for (const rec of Array.from(this.pairs.values())) this.tickPair(sys, rec, now, step);
    for (const e of sys.eels) this.pendingForce(sys, e, now);
  }

  tickPair(sys, rec, now, dt) {
    const a = rec.a, b = rec.b;
    if (!a || !b) return;
    // A slurp outranks whatever the couple was doing, from any phase: the free one keeps watch.
    if (rec.phase !== 'vigil' && (a.slurpedBy || b.slurpedBy)) {
      const free = a.slurpedBy ? b : a, taken = a.slurpedBy ? a : b;
      if (rec.phase !== 'apart') this.endPair(rec, 'preempted:fit:slurped');
      this.tryVigil(sys, rec, free, taken, now);
      return;
    }
    if (rec.phase === 'apart') { this.apartTick(sys, rec, now, dt); return; }
    // An errand with nobody on it, or a vigil with nobody inside the guest, is over however it got here.
    if ((rec.phase === 'seek' || rec.phase === 'vigil') && !rec.seeker) { this.endPair(rec, 'lost'); return; }
    if (rec.phase === 'vigil' && !rec.taken) { this.endPair(rec, 'lost'); return; }
    for (const e of this.membersOf(rec)) {
      const st = this.map.get(e);
      if (!st || st.pair !== rec) { this.endPair(rec, 'preempted:skipped', 'lost the record'); return; }
      // The fit test runs first so the ending names the owner that took the eel; the stamp is the
      // backstop for whatever skipped the hook without a name.
      if (e.slurpedBy) { this.endPair(rec, 'preempted:fit:slurped'); return; }
      const fail = this.fitFail(sys, e, now, this.fitOpts(rec, e));
      if (fail) { this.endPair(rec, `preempted:fit:${fail}`, e.name); return; }
      // A single skipped tick is ridden out everywhere (the fit tests above name every real owner), and a
      // watcher near the guest flinches for longer than that and comes back on their own.
      if (rec.phase !== 'vigil' && st.tickedAt < sys.ticks - 2) {
        this.endPair(rec, 'preempted:skipped', `${e.name} stamp ${st.tickedAt} vs tick ${sys.ticks}`);
        return;
      }
    }
    if (rec.phase === 'vigil') this.vigilTick(sys, rec, now);
    else if (rec.phase === 'seek') this.seekTick(sys, rec, now);
    else if (rec.phase === 'hello') this.helloTick(sys, rec, now);
    else if (rec.phase === 'stroll') this.strollTick(sys, rec, now, dt);
    else if (rec.phase === 'rest') this.restTick(sys, rec, now);
  }

  /* Who is actually being steered by the bout. A seek and a vigil are one eel's errand; the other side
     is living its own life and must not be tested as though it had agreed to anything. */
  membersOf(rec) {
    if (rec.phase === 'seek' || rec.phase === 'vigil') return rec.seeker ? [rec.seeker] : [];
    return [rec.a, rec.b];
  }

  other(rec, e) { return e === rec.a ? rec.b : rec.a; }

  /* The reunion inherits the vigil's exemptions: the guest who did the swallowing is still right there,
     and the ordinary guest and panic tests would cancel the three boops the whole vigil was waiting for. */
  fitOpts(rec, e) {
    return {
      partner: this.other(rec, e),
      resting: rec.phase === 'rest',
      vigil: rec.phase === 'vigil' || rec.reunion,
    };
  }

  // Apart, and the seek

  apartTick(sys, rec, now, dt) {
    const a = rec.a, b = rec.b;
    rec.vigilSpent = false;   // nobody is inside the guest, so the next slurp earns a fresh vigil
    rec.missing = stepMissing(rec.missing, dt, dist(a, b) > this.k('farDist'), this.k('nearFill'));
    if (rec.missing < rec.apartFor || now < rec.coolUntil) return;
    if (this.engaged(a) || this.engaged(b)) return;   // one of them is already out with somebody
    if (this.fitFail(sys, a, now, { partner: b, entry: true })) return;
    if (this.fitFail(sys, b, now, { partner: a, entry: true })) return;
    this.startSeek(sys, rec, this.pickSeeker(rec), now);
  }

  /* The global knob, when finite, is the odds the lower-index resident goes looking; otherwise each
     identity carries its own appetite for the trip. */
  pickSeeker(rec) {
    const global = this.odds('seekOdds');
    const wA = global === null ? num(rec.a.quirks?.lifeBondSeek, 0.5) : global;
    const wB = global === null ? num(rec.b.quirks?.lifeBondSeek, 0.5) : 1 - global;
    return pickWeighted(this.rng.next(), wA, wB) === 0 ? rec.a : rec.b;
  }

  startSeek(sys, rec, seeker, now, reunion = false) {
    rec.phase = 'seek';
    rec.seeker = seeker;
    rec.reunion = reunion;
    rec.t0 = now;
    this.join(sys, rec, seeker);
    this.log(`${seeker.name} went looking for ${this.other(rec, seeker).name}`);
  }

  seekTick(sys, rec, now) {
    const seeker = rec.seeker, o = this.other(rec, seeker);
    if (now - rec.t0 > this.k('seekMax')) { this.endPair(rec, 'lost'); return; }
    if (dist(seeker, o) > ARRIVE * seeker.length) return;
    // Arrived on a partner who is still bolting or airborne: wait rather than test, since a spat-out
    // partner is fleeing by definition and that one second is the whole reunion.
    if (now < o.fleeUntil || sys.air?.busy?.(o)) return;
    // The one being sought holds no record of their own, so a bout with a third partner is only
    // visible from here: leave them to it rather than steal them mid-gesture.
    if (this.engaged(o, rec)) { this.endPair(rec, 'partnerbusy', `${o.name}:bout`); return; }
    const fail = this.fitFail(sys, o, now, { partner: seeker, vigil: rec.reunion });
    if (fail) { this.endPair(rec, 'partnerbusy', `${o.name}:${fail}`); return; }
    this.startHello(sys, rec, now);
  }

  // The hello

  startHello(sys, rec, now) {
    const a = rec.a, b = rec.b;
    rec.phase = 'hello';
    rec.t0 = now;
    rec.step = 0;
    rec.booped = 0;
    rec.boopAt = 0;
    rec.eightDone = 0;
    rec.boops = rec.reunion ? Math.max(1, Math.round(this.k('reunionHellos'))) : 1;
    // A reunion goes straight to the boops: three of them in a row is already the whole gesture.
    rec.twineWhen = !rec.reunion && this.rng.chance(this.k('helloTwine')) ? this.rng.pick([1, 2, 3]) : 0;
    this.join(sys, rec, a);
    this.join(sys, rec, b);
    this.approach(rec, now);
    if (!(rec.twineWhen & 1)) { rec.step = 1; rec.closeFrom = now; }
    this.log(`${a.name} and ${b.name} said hello (${rec.boops} boop(s), twine ${rec.twineWhen})`);
  }

  helloTick(sys, rec, now) {
    const a = rec.a, b = rec.b;
    // Closing at prowl until the noses meet; a hold's creep took the two of them up to 13 s to cross a gap
    // of two units. The hold is for the boop itself and the pause after it.
    if (rec.booped) this.hold(rec, now); else this.approach(rec, now);
    if (rec.step === 0 || rec.step === 3) {
      if (a.twine || b.twine) return;   // a braid owns both targets until it lets go on its own clock
      rec.eight = null;
      // The figure-8 waits for a braid one of them was already in rather than being quietly skipped.
      const bit = rec.step === 0 ? 1 : 2;
      if ((rec.twineWhen & bit) && !(rec.eightDone & bit)) { rec.eightDone |= bit; this.figureEight(sys, rec, now); return; }
      if (rec.step === 3) { this.startStroll(sys, rec, now); return; }
      rec.step = 1;
      rec.closeFrom = now;
      return;
    }
    if (rec.step === 1) {
      if (rec.boopAt && now - rec.boopAt < REUNION_GAP) return;
      if (dist(a, b) > BOOP_NEAR * (a.radius + b.radius)) {
        if (now - rec.closeFrom > HELLO_MAX) this.endPair(rec, 'noboop');
        return;
      }
      rec.booped++;
      rec.boopAt = now;
      rec.ampUntil = now + AMP_FOR;
      sys.emit('boop', a);
      if (rec.booped >= rec.boops) rec.step = 2;
      return;
    }
    // A reunion's third boop is the whole gesture: only the wiggle plays out before the stroll.
    if (now - rec.boopAt < (rec.reunion ? AMP_FOR : this.k('hello'))) return;
    if (rec.twineWhen & 2) { rec.step = 3; return; }
    this.startStroll(sys, rec, now);
  }

  /* The figure-8: a braid the pair did not have to roll for, on the module's own clock so the odds the
     twine seam already owns stay exactly where they were. */
  figureEight(sys, rec, now) {
    const a = rec.a, b = rec.b;
    if (a.twine || b.twine) return;
    rec.eight = startTwine(sys, [a, b], now, this.rng.range(HELLO_TWINE[0], HELLO_TWINE[1]));
  }

  // The stroll and the rest

  startStroll(sys, rec, now) {
    const global = this.odds('leadOdds');
    const wA = global === null ? num(rec.a.quirks?.lifeBondLead, 0.5) : global;
    const wB = global === null ? num(rec.b.quirks?.lifeBondLead, 0.5) : 1 - global;
    const leader = pickWeighted(this.rng.next(), wA, wB) === 0 ? rec.a : rec.b;
    rec.phase = 'stroll';
    rec.reunion = false;   // the guest exemption ends with the boops, not with the bout
    rec.leader = leader;
    rec.follower = this.other(rec, leader);
    rec.side = this.rng.chance(0.5) ? 1 : -1;
    rec.t0 = now;
    rec.until = now + this.roll('stroll');
    this.release(rec, now);
    // The follower's gait roll is parked from here, so the hello's hold has to be handed back by hand
    // or it would ride out the whole stroll at a creep.
    rec.follower.gait = 'prowl';
    this.log(`${leader.name} is leading the stroll, ${rec.follower.name} alongside`);
  }

  strollTick(sys, rec, now, dt) {
    const held = (e) => e.gait === 'hold' && now < e.gaitUntil;
    if (now >= rec.until || held(rec.leader)) { this.startRest(sys, rec, now); return; }
    // The follower's gait roll is parked, so its rest stops are rolled here at the same odds per second
    // the leader's cadence gives, off the module's stream: Shelley's rest stops survive her following.
    const f = rec.follower, t = f.traits;
    const travel = Math.max(0.5, ((t?.travelTime?.[0] ?? 2) + (t?.travelTime?.[1] ?? 8)) * 0.5);
    const p = ((t?.holdChance ?? 0.55) / travel) * this.holdMul(f, true) * num(dt, 0);
    if (p > 0 && this.rng.chance(Math.min(1, p))) this.startRest(sys, rec, now);
  }

  startRest(sys, rec, now) {
    const a = rec.a, b = rec.b, len = this.roll('rest');
    rec.phase = 'rest';
    rec.t0 = now;
    rec.until = now + len;
    rec.snugSet = true;
    rec.heldGait = true;
    for (const e of [a, b]) {
      const o = this.other(rec, e);
      if (e.twine) endTwine(e.twine);   // no braid tows the parked leader
      e.gait = 'hold'; e.gaitFrom = now; e.gaitUntil = rec.until;
      e.cuddle.with = o; e.cuddle.until = rec.until;
    }
    // One anchor, one mover: only the follower snuggles; the leader parks where it is.
    const lead = rec.leader ?? a, f = this.other(rec, lead);
    lead.target.set(lead.head.x, 0, lead.head.z);
    f.snuggle.with = lead; f.snuggle.until = rec.until;
    this.log(`${a.name} and ${b.name} settled down together for ${len.toFixed(1)} s`);
  }

  restTick(sys, rec, now) {
    const lead = rec.leader ?? rec.a, f = this.other(rec, lead);
    // A scare clears the snuggle, and a real shove wakes the parked leader; either one ends the nap.
    if (now >= rec.until || f.snuggle?.with !== lead || lead.gait !== 'hold') this.endPair(rec, 'rested');
  }

  // The vigil

  tryVigil(sys, rec, free, taken, now) {
    if (free.slurpedBy || this.engaged(free) || rec.vigilSpent) return;
    if (this.fitFail(sys, free, now, { partner: taken, vigil: true, entry: true })) return;
    rec.phase = 'vigil';
    rec.seeker = free;
    rec.taken = taken;
    rec.guest = taken.slurpedBy;
    rec.t0 = now;
    this.join(sys, rec, free);
    this.log(`${free.name} is keeping watch on ${rec.guest?.name ?? 'the guest'}`);
  }

  vigilTick(sys, rec, now) {
    if (!rec.taken.slurpedBy) {
      // Spat back out. The seek's own arrival test waits out the flee, then the reunion boops fire.
      this.startSeek(sys, rec, rec.seeker, now, true);
      return;
    }
    if (now - rec.t0 > this.k('vigilMax')) { rec.vigilSpent = true; this.endPair(rec, 'vigil:timeout'); }
  }

  /* How frightening the guest is to an eel whose partner she is holding. Read by eel-fear.js, which has
     no other way to know that this one observer has stopped caring. */
  brave(observer, guest) {
    const rec = this.map.get(observer)?.pair;
    return rec && rec.phase === 'vigil' && rec.guest === guest ? this.k('brave') : 1;
  }

  // The seams

  /* The social tier's hook, from steer. A failed claim is a higher tier taking the eel, which ends the
     bout rather than pausing it: half a hello resuming after a panic looks like a glitch. */
  pickTarget(sys, e, now) {
    const st = this.map.get(e);
    const rec = st?.pair;
    if (!rec) return 0;
    // Two owners that write the target themselves: the braid seam above, and the snuggle block that
    // steers the resting follower. Stamping without a claim is how the tick still counts as ticked.
    if (e.twine || (rec.phase === 'rest' && rec.leader !== e)) { st.tickedAt = sys.ticks; return 0; }
    if (rec.phase === 'stroll' && rec.leader === e) { st.tickedAt = sys.ticks; return 0; }
    if (!claimTick(e, 'social', 'bond')) {
      this.endPair(rec, 'preempted:claim', `${e.name} ${e.tick.tier}/${e.tick.owner}`);
      return 0;
    }
    st.tickedAt = sys.ticks;
    if (rec.phase === 'seek') {
      const o = this.other(rec, e);
      e.gait = 'prowl';   // the gait roll is parked, so a cruise it entered on would otherwise ride the whole errand
      e.target.set(o.head.x, 0, o.head.z);
      return SEEK_MUL;
    }
    if (rec.phase === 'vigil') return this.vigilTarget(rec, e);
    if (rec.phase === 'hello') return this.helloTarget(rec, e, now);
    // Re-parked every tick: a one-shot park is lost the moment anything else lets go of the target.
    if (rec.phase === 'rest') { e.target.set(e.head.x, 0, e.head.z); return 0; }
    return this.strollTarget(rec, e);
  }

  vigilTarget(rec, e) {
    const g = rec.guest;
    const tail = g?.pts?.[g.pts.length - 1];
    if (!tail) return 1;
    const p = vigilPoint(tail, g.heading, this.k('vigilGap') * e.length);
    if (!p) return 1;   // a dead-stopped guest for one tick: hold the last target rather than write NaN
    // A departing guest drags the station off the stage; the watcher waits at the shore instead.
    const hw = e.view.w * VIGIL_INSET, hh = e.view.h * VIGIL_INSET;
    e.target.set(Math.max(-hw, Math.min(hw, p.x)), 0, Math.max(-hh, Math.min(hh, p.z)));
    e.gait = 'prowl';   // the gait roll is parked here too, so the multiplier scales a known gait
    return VIGIL_MUL;
  }

  helloTarget(rec, e, now) {
    const o = this.other(rec, e);
    const p = boopPoint(o.head, e.head, e.radius + o.radius);
    if (!p) return 1;
    e.target.set(p.x, 0, p.z);
    if (now < rec.ampUntil) e.pose.ampMul = AMP_PULSE;
    return 1;
  }

  strollTarget(rec, e) {
    const lead = rec.leader;
    // Same gait for both halves of the couple, so the pace scale below compares like with like.
    if (lead.gait === 'prowl' || lead.gait === 'cruise') e.gait = lead.gait;
    const gap = (e.radius + lead.radius) * STROLL_SIDE;
    const p = strollPoint(lead.head, lead.heading, rec.side, gap, num(e.quirks?.lifeBondAhead, 0) * e.length);
    if (!p) return 1;
    e.target.set(p.x, 0, p.z);
    return 1;
  }

  /* Apart really is apart: the identity's own follow weight is halved so the reunion reads as an event
     rather than as the two of them never quite separating. */
  pullMul(e) {
    const st = this.map.get(e);
    if (!st || st.pair || !e.partner) return 1;
    const rec = this.pairs.get(pairKey(e.name, e.partner.name));
    return rec ? this.k('apartPull') : 1;
  }

  /* Both halves of "they would rather rest together": a partner away means fewer rests rolled at all,
     and both strollers roll more late in the walk (the follower through strollTick), since a hold is how
     the stroll becomes the shared nap. */
  holdMul(e, asFollower = false) {
    const rec = this.map.get(e)?.pair;
    if (!rec) return this.hasPartner(e) ? this.k('loneRest') : 1;
    if (rec.phase !== 'stroll' || (rec.leader !== e && !asFollower)) return 1;
    // Doubling the hold odds from the first step ended every stroll inside two seconds, so the walk gets
    // its opening stretch at long odds and the nap only becomes the likely ending late in it.
    const late = this.sys.time >= rec.t0 + (rec.until - rec.t0) * this.k('strollHold');
    return late ? this.k('restTogether') : this.k('strollRest');
  }

  twineMul(e) {
    const rec = this.map.get(e)?.pair;
    return rec?.phase === 'stroll' ? this.k('twineBoost') : 1;
  }

  /* The fast one waits. Only the stroll paces: a seeker on an errand and a vigil at a safe distance are
     both going somewhere alone. */
  paceMul(e) {
    const rec = this.map.get(e)?.pair;
    if (rec?.phase !== 'stroll') return 1;
    const o = this.other(rec, e);
    const mul = paceMul(gaitBLOf(e, e.gait), gaitBLOf(o, e.gait));
    if (rec.leader === e) return mul;
    const d = Math.hypot(e.target.x - e.head.x, e.target.z - e.head.z);
    const ahead = (e.head.x - e.target.x) * rec.leader.heading.x + (e.head.z - e.target.z) * rec.leader.heading.z > 0;
    return mul * catchUpMul(d, e.length, ahead);
  }

  /* Whether these two share an edge: idle spacing lets them touch the way a follows partner may. */
  bonded(e, o) {
    if (!this.pairs.size || !e || !o) return false;
    return this.pairs.has(pairKey(e.name, o.name));
  }

  /* In a bout of any kind, either side of it. The seek and the vigil write a record on the errand's eel
     alone, so the one being sought (or kept watch for) is only found by walking the pairs. */
  engaged(e, except = null) {
    const own = this.map.get(e)?.pair;
    if (own && own !== except) return true;
    for (const rec of this.pairs.values()) {
      if (rec === except || rec.phase === 'apart') continue;
      if (rec.a === e || rec.b === e) return true;
    }
    return false;
  }

  /* Read by eel-air.js, eel-fear.js, and steer: a couple mid-bout rolls no peek, flop, leap, burrow, bore
     run, refuge fight, or rest pose. Without it a stroll rarely outlived the next tunnel. */
  inBout(e) { return !!this.map.get(e)?.pair; }

  /* Read by twineFree: the ordinary braid roll may recruit a stroller, but not an eel mid-seek, mid-hello,
     resting, or on vigil, whose target the bout owns. */
  twineLocked(e) {
    const rec = this.map.get(e)?.pair;
    return !!rec && rec.phase !== 'stroll';
  }

  hasPartner(e) {
    for (const rec of this.pairs.values()) {
      if (rec.a !== e && rec.b !== e) continue;
      if (!this.other(rec, e).slurpedBy) return true;
    }
    return false;
  }

  // Bookkeeping

  join(sys, rec, e) {
    const st = this.map.get(e);
    if (!st) return;
    st.pair = rec;
    st.tickedAt = sys.ticks;
    st.forceUntil = 0;   // however the bout started, the queued request it was waiting on is spent
  }

  /* The two things a bout writes on the eels themselves, handed back at every exit: the parked hold and
     the snuggle. Only the ones this bout set, so a nap somebody else started survives it. */
  release(rec, now) {
    if (rec.eight) { endTwine(rec.eight); rec.eight = null; }
    for (const e of [rec.a, rec.b]) {
      if (!e) continue;
      if (rec.heldGait && e.gait === 'hold') e.gaitUntil = Math.min(e.gaitUntil, now);
      if (rec.snugSet && e.snuggle?.with === this.other(rec, e)) { e.snuggle.with = null; e.snuggle.until = 0; }
      if (rec.snugSet && e.cuddle?.with === this.other(rec, e)) { e.cuddle.with = null; e.cuddle.until = 0; }
    }
    rec.heldGait = false;
    rec.snugSet = false;
  }

  hold(rec, now) {
    for (const e of [rec.a, rec.b]) {
      e.gait = 'hold';
      e.gaitFrom = now;
      e.gaitUntil = now + HELLO_SLICE;
    }
    rec.heldGait = true;
  }

  approach(rec, now) {
    for (const e of [rec.a, rec.b]) if (e.gait !== 'prowl') { e.gait = 'prowl'; e.gaitFrom = now; e.gaitUntil = now; }
    rec.heldGait = false;
  }

  endPair(rec, reason, note = '') {
    const now = this.sys.time;
    rec.lastEnd = note ? `${reason} (${note})` : reason;
    rec.lastEndAt = now;
    this.log(`${rec.key} out of a ${rec.phase}: ${rec.lastEnd} after ${(now - rec.t0).toFixed(2)} s`);
    this.release(rec, now);
    for (const e of [rec.a, rec.b]) {
      const st = e ? this.map.get(e) : null;
      if (st?.pair === rec) st.pair = null;
      if (e) e.retargetAt = Math.min(e.retargetAt, now);   // the wander picks its own point again this tick
    }
    if (reason === 'rested') { rec.missing = 0; rec.coolUntil = now + this.k('cool'); }
    else rec.missing *= Math.max(0, this.k('keep'));
    if (reason === 'noboop') rec.coolUntil = now + this.k('cool');   // a pair that cannot meet must not retry on a loop
    rec.phase = 'apart';
    rec.apartFor = this.roll('apart');
    rec.seeker = null; rec.leader = null; rec.follower = null; rec.taken = null; rec.guest = null;
    rec.reunion = false; rec.step = 0; rec.booped = 0; rec.boopAt = 0; rec.ampUntil = 0; rec.twineWhen = 0; rec.eightDone = 0;
  }

  /* Everything that outranks the bond, tested at entry and again every tick, and which test said no.
     A twine is missing on purpose: a braiding couple is doing the thing this module exists to cause. */
  fitFail(sys, e, now, opts = {}) {
    const { partner = null, entry = false, vigil = false, resting = false } = opts;
    if (e.food) return 'food';
    if (e.tunnel) return 'tunnel';
    if (!resting && e.restPose?.kind) return 'rest';
    if (e.snuggle?.with && e.snuggle.with !== partner) return 'snuggle';
    if (!vigil && now < e.fleeUntil) return 'flee';
    // A hold, deep or not, only bars entry: mid-bout the module writes the gaits itself, and a nap beside
    // the partner is the rest phase's whole point.
    if (entry && e.gait === 'hold' && now < e.gaitUntil) return e.gaitUntil - e.gaitFrom > DEEP_HOLD ? 'nap' : 'hold';
    if (e.coverSpot?.type === 'graze' || e.coverSpot?.type === 'tea') return `meal:${e.coverSpot.type}`;
    if (sys.air?.busy?.(e)) return 'air';
    if (sys.crush?.active(e)) return 'crush';
    // steer's own social-tier owners, every one of them claimed before the bond hook. Starting under one
    // only spends a bout on a claim that cannot be won.
    if (e.gait === 'loop' && now < e.gaitUntil) return 'loop';
    if (now < (e.snack?.until ?? 0)) return 'snack';
    if (e.rescueTo) return 'rescue';
    if (e.buttTo) return 'headbutt';
    if (sys.braincell?.hasSensedFood(e)) return 'scent';
    // Another body a length away already reads as a little panic; only a real fright ends a bout.
    if (!vigil && (sys.fear?.panic(e) ?? 0) > this.k('panicCut')) return 'panic';
    if (sys.fear?.scattering(e)) return 'scatter';
    if (sys.fear?.pendingScatter(e)) return 'prescatter';
    // A refuge fight owns the eel through the contest tier, which steer's own `busy` hides from the
    // hook: naming it here is the difference between a reason and a mystery skipped tick.
    if (sys.fear?.contesting?.(e)) return 'contest';
    const g = sys.guests[0];
    if (!vigil && g && (g.threat ?? 0) > 0 && dist(e, g) < this.k('guestNear')) return 'guest';
    return '';
  }

  log(msg) { if (this.sys.debug) console.log(`[bond] ${msg}`); }

  // Debug

  /* pond.bond.force('Jim'): start a seek now, bypassing the meter and the cooldown but not one safety
     test. A request that cannot start yet waits for a window rather than bouncing, and force(name, false)
     cancels it. The second argument names which partner when an eel has more than one. */
  force(name, partnerName = true) {
    const sys = this.sys, now = sys.time;
    const on = partnerName !== false;
    const e = typeof name === 'string' ? sys.eels.find((o) => o.name === name || o.nick === name) : name;
    const st = e ? this.map.get(e) : null;
    // Logged whatever ?debug= says: an explicit console call that answers only `false` is a dead end.
    if (!st) { console.log(`[bond] force(${name}) refused: noeel`); return false; }
    if (!on) {
      console.log(`[bond] force(${e.name}) ${st.forceUntil > now ? 'cancelled' : 'was not queued'}`);
      st.forceUntil = 0;
      return false;
    }
    if (this.engaged(e)) { console.log(`[bond] force(${e.name}) refused: already in a ${st.pair?.phase ?? 'bout'}`); return false; }
    st.want = typeof partnerName === 'string' ? partnerName : '';
    const why = this.tryForce(sys, e, st, now);
    if (!why) return true;
    if (PERMANENT.has(why)) { console.log(`[bond] force(${e.name}) refused: ${why}`); return false; }
    st.forceUntil = now + this.k('forceWait');
    console.log(`[bond] force(${e.name}) queued for ${this.k('forceWait')} s, waiting on: ${why}`);
    return 'queued';
  }

  /* One attempt at a forced seek: '' when it took, otherwise the test that refused it. */
  tryForce(sys, e, st, now) {
    const rec = this.recFor(e, st.want);
    if (!rec) return st.want ? 'nopartner' : 'nobond';
    const o = this.other(rec, e);
    if (o.slurpedBy) return 'partner:slurped';
    if (this.engaged(o)) return 'partner:busy';
    const mine = this.fitFail(sys, e, now, { partner: o, entry: true });
    if (mine) return `fit:${mine}`;
    const theirs = this.fitFail(sys, o, now, { partner: e, entry: true });
    if (theirs) return `partner:${theirs}`;
    this.startSeek(sys, rec, e, now);
    return '';
  }

  recFor(e, want) {
    for (const rec of this.pairs.values()) {
      if (rec.a !== e && rec.b !== e) continue;
      if (!want || this.other(rec, e).name === want || this.other(rec, e).nick === want) return rec;
    }
    return null;
  }

  pendingForce(sys, e, now) {
    const st = this.map.get(e);
    if (!st?.forceUntil || st.pair) return;
    if (now > st.forceUntil) {
      st.forceUntil = 0;
      console.log(`[bond] force(${e.name}) gave up after ${this.k('forceWait')} s`);
      return;
    }
    if (!this.tryForce(sys, e, st, now)) console.log(`[bond] force(${e.name}) took, after waiting for a window`);
  }

  debug() {
    const out = {};
    const now = this.sys.time;
    for (const rec of this.pairs.values()) {
      out[rec.key] = {
        phase: rec.phase === 'apart' && now < rec.coolUntil ? 'cooling' : rec.phase,
        missing: +rec.missing.toFixed(2),
        apartFor: +rec.apartFor.toFixed(2),
        gap: +Math.hypot(rec.a.head.x - rec.b.head.x, rec.a.head.z - rec.b.head.z).toFixed(2),
        seeker: rec.seeker?.name ?? '',
        leader: rec.leader?.name ?? '',
        boops: `${rec.booped}/${rec.boops}`,
        twineWhen: rec.twineWhen,
        left: rec.until > now ? +(rec.until - now).toFixed(2) : 0,
        cool: Math.max(0, +(rec.coolUntil - now).toFixed(2)),
        // A bout that started and ended between two samples leaves its reason here and nowhere else.
        lastEnd: rec.lastEnd,
        lastEndAgo: rec.lastEndAt < 0 ? -1 : +(now - rec.lastEndAt).toFixed(2),
      };
    }
    return out;
  }
}
