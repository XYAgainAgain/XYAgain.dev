import { createRng, deriveSeed } from './rng.js';
import { claimTick } from './eel-behavior.js';
import {
  lanePoint, missTest, stepFluster, exitPoint, sideOf, withinJoin, punchline, entryOdds,
  LANE_CHECK, EXIT_BURST,
} from './eel-crush-core.js';

/* The Jaz crush gag. Seams eel-behavior.js reads: active(e) parks the wander re-pick, pickTarget(sys, e,
   now) claims social and returns a speed multiplier, snubbed(e, now) mutes the partner pull, exciteLift(e). */

const SALT = 2100;
// Jaz spends much of the pond's time inside a log, and a follower is rarely free at the same instant, so
// the roll looks often and quietly. The odds are quoted per ROLL_WINDOW of eligible time and scaled here,
// which keeps knobs.crush.odds and the per-eel appetites meaning what they always meant.
const ROLL_EVERY = 5, ROLL_WINDOW = 20;
const PERMANENT = new Set(['nocrush', 'nopartner', 'nogrid', 'gone']);  // no window will ever open
const EXIT_MUL = 1.15;
const EXCITE_PER_MISS = 0.15;
const AMP_PULSE = 0.75, AMP_FOR = 0.4;
const SNAP_FOR = 0.35;
// Only a real huff earns knobs.crush.cool; every other way out of a bout is the shorter one.
const SHORT_COOL = 45;
const CALM_PANIC = 0.05;
const DEEP_HOLD = 5;   // hold-bout seconds past which steer calls it a real rest, poses and all
// Backstop behind onEnabled: sim seconds between prepasses that mean the ticks stopped for a while,
// whatever stopped them. Normal running advances sys.time exactly one tick per prepass.
const PAUSE_GAP = 0.5;
// Heather draws highest: her left-only clamp turns every correction into a full loop, and she already
// swims closest. Live on sys.crush.perEel, so a console can dial one up without a rebuild.
const ODDS = { Morgan: 0.25, Bee: 0.35, Heather: 0.5 };
const ODDS_DEFAULT = 0.25;
const DIALS = {
  odds: 1, joinRadius: 5, joinBoost: 1.6, gap: 1, laneTol: 0.6, flusterPer: 0.34,
  boutMax: 25, huff: 3, snub: 8, cool: 120, bonk: 1, forceWait: 90,
};
const STAGGER = [0.3, 0.8];

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const midOf = (e) => e.pts[e.pts.length >> 1];

export function attachCrush(sys, seed) {
  if (sys.crush instanceof Crush) return sys.crush;
  const crush = new Crush(sys, seed);
  sys.crush = crush;
  sys.addModule(crush);
  return crush;
}

export class Crush {
  constructor(sys, seed) {
    this.sys = sys;
    this.rng = createRng(deriveSeed(seed, SALT));
    this.map = new Map();      // one record per resident; bounded by the cast
    this.bouts = [];           // { id, jaz, members: [] }, in practice never more than one
    this.boutId = 0;
    this.lastAt = sys.time;
    this.perEel = { ...ODDS };
  }

  k(name) { return num(this.sys.knobs?.crush?.[name], DIALS[name]); }

  stagger() {
    const v = this.sys.knobs?.crush?.exitStagger;
    const lo = num(v?.[0], STAGGER[0]), hi = num(v?.[1], STAGGER[1]);
    return this.rng.range(Math.min(lo, hi), Math.max(lo, hi));
  }

  /* Both seams eel-behavior.js reads: whether the wander re-pick should leave e.target alone, and
     whether the partner pull is muted because they are not talking right now. */
  active(e) { return !!this.map.get(e)?.bout; }

  snubbed(e, now) { const st = this.map.get(e); return !!st && now < st.snubUntil; }

  initEel(sys, e) {
    // A hot-swap hands this body to someone new: the leaver's attempt ends, and so does any bout that
    // was following this body as Jaz.
    const st = this.map.get(e);
    if (st?.bout) this.end(e, st, 'swapped');
    for (const b of this.bouts.slice()) if (b.jaz === e) this.endBout(b, 'swapped');
    this.map.set(e, this.fresh(sys));
  }

  fresh(sys) {
    return {
      bout: null, memberIndex: 0, fluster: 0, misses: 0, off: 0, sampled: false, phase: '',
      t0: 0, checkAt: 0, lastSnap: -1, exitAt: 0, exitFrom: 0, exitUntil: 0,
      exitX: 0, exitZ: 0, side: 1, snapUntil: 0, bonked: false, ampUntil: 0,
      tickedAt: -1, coolUntil: 0, snubUntil: 0, lastEnd: '', lastEndAt: -1, forceUntil: 0,
      rollAt: sys.time + this.rng.range(0, ROLL_EVERY),
    };
  }

  /* The pond going dark ends every attempt: ticks stop while sys.time runs on, so a bout would wake
     against clocks that expired without it. */
  onEnabled(sys, on) {
    if (!on) for (const b of this.bouts.slice()) this.endBout(b, 'disabled');
    this.lastAt = sys.time;
  }

  prepass(sys) {
    const now = sys.time;
    if (now - this.lastAt > PAUSE_GAP) for (const b of this.bouts.slice()) this.endBout(b, 'paused');
    this.lastAt = now;
    for (const b of this.bouts.slice()) this.tickBout(sys, b, now);
    for (const e of sys.eels) { this.pendingForce(sys, e, now); this.roll(sys, e, now); }
  }

  tickBout(sys, b, now) {
    // Jaz leaving ends every participation, a huff already under way included: the exit's snub window
    // outlives it, so nobody snaps back toward a partner who is gone.
    const fit = this.jazFit(sys, b.jaz);
    for (const e of b.members.slice()) {
      const st = this.map.get(e);
      if (!st || st.bout !== b) { this.drop(b, e); continue; }
      // steer skips the hook outright while a tunnel, a flee, a contest, or a scatter owns the eel, so
      // a member that went un-ticked lost the eel exactly the way a failed claim does.
      if (st.tickedAt < sys.ticks - 1) {
        this.end(e, st, 'preempted:skipped', `stamp ${st.tickedAt} vs tick ${sys.ticks}, busy ${this.busyLabel(sys, e, now)}`);
        continue;
      }
      if (e.slurpedBy) { this.end(e, st, 'preempted:fit:slurped'); continue; }
      const fail = this.fitFail(sys, e, now);
      if (fail) { this.end(e, st, `preempted:fit:${fail}`); continue; }
      if (!fit) { this.end(e, st, 'jazgone'); continue; }
      if (st.phase === 'exit') { if (now > st.exitUntil) this.end(e, st, 'huffed'); continue; }
      if (st.phase === 'tipped') { if (now >= st.exitAt) this.commitExit(e, st, b, now); continue; }
      if (now - st.t0 > this.k('boutMax')) { this.end(e, st, 'managed'); continue; }
      this.laneTick(sys, e, st, b, now);
    }
    if (!b.members.length) this.remove(b);
  }

  /* One tick of trying: arm on Jaz's corner and measure the overshoot 0.9 s later. Corners are the only
     thing that moves the meter, since Jaz turns about every three seconds and a per-second drain ate a
     fumble before the next one landed. gridHeading rewrites snapAt only on a real cardinal change. */
  laneTick(sys, e, st, b, now) {
    const jaz = b.jaz;
    if (jaz.snapAt !== st.lastSnap) { st.lastSnap = jaz.snapAt; st.checkAt = now + LANE_CHECK; }
    if (st.checkAt <= 0 || now < st.checkAt) return;
    st.checkAt = 0;
    const m = missTest(e.head, e.heading, jaz.head, jaz.heading, this.k('laneTol'), e.length);
    st.off = m.off;
    st.sampled = true;
    if (m.miss) { st.misses++; this.tryPunchline(e, st, jaz, now); }
    st.fluster = stepFluster(st.fluster, { missed: m.miss, per: this.k('flusterPer') });
    if (st.fluster >= 1) this.tipOver(sys, e, st, now);
  }

  tipOver(sys, e, st, now) {
    st.phase = 'tipped';
    st.side = sideOf(st.off);
    st.exitAt = now + this.stagger();   // two eels bailing on the same frame reads as a glitch
    st.ampUntil = now + AMP_FOR;
    st.snapUntil = 0;
    sys.stim?.shuffle(e);
    sys.emit('huff', e);
  }

  commitExit(e, st, b, now) {
    const p = exitPoint(b.jaz.head, b.jaz.heading, st.side, e.length);
    if (!p) { this.end(e, st, 'nolane'); return; }
    // Frozen at the commit rather than tracked: a bypass point that chases Jaz around the next corner
    // would be one more lap of following, and the whole point is that they are done.
    st.exitX = p.x; st.exitZ = p.z;
    st.phase = 'exit';
    st.exitFrom = now;
    st.exitUntil = now + this.k('huff');
    st.snubUntil = st.exitUntil + this.k('snub');
  }

  /* The social tier's hook, from steer. A failed claim is a higher tier taking the eel, which ends the
     attempt rather than pausing it: a half-finished huff resuming after a panic looks like a glitch. */
  pickTarget(sys, e, now) {
    const st = this.map.get(e);
    if (!st || !st.bout) return 0;
    if (!claimTick(e, 'social', 'crush')) {
      this.end(e, st, 'preempted:claim', `${e.tick.tier}/${e.tick.owner}`);
      return 0;
    }
    st.tickedAt = sys.ticks;
    const exiting = st.phase === 'exit';
    const mul = exiting && now - st.exitFrom < EXIT_BURST ? EXIT_MUL : 1;
    // A wander hold roll must not park a committed follower on the lane, and the hold's limp tail would
    // read as a body gliding without swimming. Scoped to the hold: a floor written on every tick would
    // ratchet a spook's burst speed in and never let it decay.
    if (e.gait === 'hold') { e.pose.speed = Math.max(e.speedBL, e.prowlBL * mul); e.pose.ampMul = 1; }
    if (now < st.ampUntil) e.pose.ampMul = AMP_PULSE;   // the tip-over's flinch outranks both
    if (exiting) {
      e.target.set(st.exitX, 0, st.exitZ);
      return mul;
    }
    const jaz = st.bout.jaz;
    const p = lanePoint(jaz.head, jaz.heading, this.k('gap'), st.memberIndex, e.length);
    if (!p) return 1;   // a zero-length heading for one tick: hold the last target rather than write NaN
    e.target.set(p.x, 0, p.z);
    if (now < st.snapUntil) { e.pose.speed = e.prowlBL; this.contact(sys, e, st, jaz); }
    return 1;
  }

  /* steer's last word on excitement, read every tick for every resident: the fluster is a lift on top
     of whatever the tick already decided, so a scare and a huff stack rather than overwrite. */
  exciteLift(e) {
    const st = this.map.get(e);
    return st?.bout ? Math.min(1, st.misses * EXCITE_PER_MISS) : 0;
  }

  tryPunchline(e, st, jaz, now) {
    if (st.bonked || this.k('bonk') <= 0) return;
    if (punchline(e.head, e.heading, midOf(jaz), e.length)) st.snapUntil = now + SNAP_FOR;
  }

  contact(sys, e, st, jaz) {
    const mid = midOf(jaz);
    if (Math.hypot(mid.x - e.head.x, mid.z - e.head.z) > (e.radius + jaz.radius) * 2 + 0.1) return;
    st.bonked = true;
    st.snapUntil = 0;
    // No spook: Jaz freezes when startled, and a friend blundering into them should not read as a scare.
    sys.emit('bonk', e, { detail: { soft: true, crush: true } });
  }

  // Entry

  roll(sys, e, now) {
    const st = this.map.get(e);
    if (!st || st.bout || now < st.rollAt) return;
    st.rollAt = now + ROLL_EVERY;
    if (now < st.coolUntil) return;
    const r = this.resolve(sys, e, now);
    if (r.why) return;
    const odds = entryOdds(this.k('odds') * (ROLL_EVERY / ROLL_WINDOW), num(this.perEel[e.name], ODDS_DEFAULT), this.k('joinBoost'), !!r.bout);
    if (this.rng.chance(odds)) this.enter(sys, e, r, now);
  }

  /* Whether this eel could be in a bout at all right now, and which one: the running bout for their Jaz
     if they are close enough to have watched it start, otherwise a fresh one. A non-empty `why` is the
     test that said no, which is all force() has to show for itself. */
  resolve(sys, e, now, forced = false) {
    const no = (why) => ({ why, jaz: null, bout: null });
    if (e.slurpedBy) return no('slurped');
    if (e.quirks?.follows !== 'Jaz') return no('nocrush');
    const jaz = e.partner;
    const jf = this.jazFail(sys, jaz);
    if (jf) return no(`jaz:${jf}`);
    if (jaz.restPose?.kind) return no('jaz:resting');
    if (now < jaz.fleeUntil) return no('jaz:fleeing');
    if (jaz.gait === 'hold' && now < jaz.gaitUntil) return no('jaz:holding');
    const fail = this.fitFail(sys, e, now, true);
    if (fail) return no(`fit:${fail}`);
    const bout = this.bouts.find((b) => b.jaz === jaz) ?? null;
    if (bout?.members.includes(e)) return no('already');
    // Where they are is the roll's business, not a safety test, so a forced bout may start from anywhere.
    if (!forced) {
      const d = Math.hypot(jaz.head.x - e.head.x, jaz.head.z - e.head.z);
      if (d < e.length * 1.2) return no('tooclose');
      if (d > 4) return no('toofar');
      if (e.heading.dot(jaz.heading) <= 0.3) return no('heading');
      if (bout && !withinJoin(e.head, bout.members.map((m) => m.head), this.k('joinRadius'))) return no('joinradius');
    }
    return { why: '', jaz, bout };
  }

  enter(sys, e, r, now) {
    const b = r.bout ?? this.open(r.jaz);
    const st = this.map.get(e);
    st.bout = b;
    st.memberIndex = this.slotFor(b);
    st.phase = 'lane';
    st.fluster = 0; st.misses = 0; st.off = 0; st.sampled = false;
    st.t0 = now; st.checkAt = 0; st.lastSnap = r.jaz.snapAt;
    st.bonked = false; st.snapUntil = 0; st.ampUntil = 0;
    st.forceUntil = 0;   // however the bout started, the queued request it was waiting on is spent
    st.tickedAt = sys.ticks;
    b.members.push(e);
    if (sys.debug) console.log(`[crush] ${e.name} ${b.members.length > 1 ? 'joined' : 'started'} bout ${b.id} behind ${b.jaz.name} at lane ${st.memberIndex}`);
    return true;
  }

  open(jaz) {
    const b = { id: ++this.boutId, jaz, members: [] };
    this.bouts.push(b);
    return b;
  }

  /* The lowest free queue position, so a member leaving lets the next joiner take the tight lane rather
     than trailing at a slot nobody is using. Live members keep the index they entered with. */
  slotFor(b) {
    const used = new Set(b.members.map((m) => this.map.get(m)?.memberIndex));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  /* Jaz still being someone a bout can follow, and which test said no. A plain rest survives (the lane
     just stops moving and boutMax runs out); a bore run or an air state puts them somewhere no
     follower should be steered. */
  jazFit(sys, jaz) { return !this.jazFail(sys, jaz); }

  jazFail(sys, jaz) {
    if (!jaz) return 'nopartner';
    if (jaz.slurpedBy) return 'slurped';
    if (!jaz.quirks?.snake) return 'nogrid';
    if (!sys.eels.includes(jaz)) return 'gone';
    if (jaz.tunnel) return 'tunnel';
    if (sys.air?.busy?.(jaz)) return 'air';
    return '';
  }

  /* Everything that outranks the gag, tested at entry and again every tick, and which test said no:
     the Tick Contract catches the loud ones, these are the quiet commitments that claim no tier. */
  fitFail(sys, e, now, entry = false) {
    if (e.food) return 'food';
    if (e.tunnel) return 'tunnel';
    if (e.twine) return 'twine';
    if (e.restPose?.kind) return 'rest';
    if (e.snuggle?.with) return 'snuggle';
    if (now < e.fleeUntil) return 'flee';
    // A hold only bars entry: mid-bout the follower is committed to moving, and pickTarget's speed floor
    // is what a wander roll cannot park. A deep hold is a nap rather than a pause and preempts either way,
    // on the same five seconds steer draws its own rest poses and its sleeping heading lock from.
    if (e.gait === 'hold' && now < e.gaitUntil) {
      if (e.gaitUntil - e.gaitFrom > DEEP_HOLD) return 'nap';
      if (entry) return 'hold';
    }
    if (e.coverSpot?.type === 'graze' || e.coverSpot?.type === 'tea') return `meal:${e.coverSpot.type}`;
    if (sys.air?.busy?.(e)) return 'air';
    // steer's own social-tier owners, every one of them claimed before the crush hook. Starting under
    // one only spends a cooldown on a claim that cannot be won.
    if (e.gait === 'loop' && now < e.gaitUntil) return 'loop';
    if (now < (e.snack?.until ?? 0)) return 'snack';
    if (e.rescueTo) return 'rescue';
    if (e.buttTo) return 'headbutt';
    if (sys.braincell?.hasSensedFood(e)) return 'scent';
    if ((sys.fear?.panic(e) ?? 0) > CALM_PANIC) return 'panic';
    if (sys.fear?.scattering(e)) return 'scatter';
    if (sys.fear?.pendingScatter(e)) return 'prescatter';
    // A refuge fight owns the eel through the contest tier, which steer's own `busy` hides from the
    // hook: naming it here is the difference between a reason and a mystery skipped tick.
    if (sys.fear?.contesting?.(e)) return 'contest';
    if ((sys.guests[0]?.threat ?? 0) > 0) return 'guest';
    return '';
  }

  /* Why steer would skip the hook outright this tick: exactly its own `busy` terms, for the log. */
  busyLabel(sys, e, now) {
    if (e.tunnel) return 'tunnel';
    if (now < e.fleeUntil) return 'flee';
    if (sys.fear?.contesting?.(e)) return 'contest';
    if (sys.fear?.scattering(e)) return 'scatter';
    return 'none';
  }

  // Endings

  end(e, st, reason, note = '') {
    const b = st.bout;
    const now = this.sys.time;
    // Anyone who tipped over has already huffed, however their exit ended: the long cooldown is theirs.
    const huffed = st.phase === 'tipped' || st.phase === 'exit';
    st.lastEnd = note ? `${reason} (${note})` : reason;
    st.lastEndAt = now;
    if (this.sys.debug) console.log(`[crush] ${e.name} out of bout ${b?.id ?? '-'}: ${st.lastEnd} after ${st.misses} miss(es) in ${(now - st.t0).toFixed(2)} s`);
    if (b) this.drop(b, e);
    st.bout = null; st.phase = ''; st.checkAt = 0; st.fluster = 0; st.snapUntil = 0; st.ampUntil = 0;
    st.coolUntil = now + (huffed ? this.k('cool') : SHORT_COOL);
    e.retargetAt = Math.min(e.retargetAt, now);   // the wander picks its own point again this tick
    if (b && !b.members.length) this.remove(b);
  }

  endBout(b, reason) {
    for (const e of b.members.slice()) {
      const st = this.map.get(e);
      if (st) this.end(e, st, reason);
      else this.drop(b, e);
    }
    this.remove(b);
  }

  drop(b, e) {
    const i = b.members.indexOf(e);
    if (i >= 0) b.members.splice(i, 1);
  }

  remove(b) {
    const i = this.bouts.indexOf(b);
    if (i >= 0) this.bouts.splice(i, 1);
  }

  // Debug

  /* pond.crush.force('Heather'): start or join, bypassing the roll and the cooldown but not one safety
     test. Jaz is in a log or resting most of the time, so a request that cannot start now waits for a
     window rather than bouncing: it retries until knobs.crush.forceWait runs out. force(name, false)
     cancels, a second call replaces the pending one, and a second name joins the live bout. */
  force(name, on = true) {
    const sys = this.sys, now = sys.time;
    const e = typeof name === 'string' ? sys.eels.find((o) => o.name === name || o.nick === name) : name;
    const st = e ? this.map.get(e) : null;
    // Logged whatever ?debug= says: an explicit console call that answers only `false` is a dead end.
    if (!st) { console.log(`[crush] force(${name}) refused: noeel`); return false; }
    if (!on) {
      console.log(`[crush] force(${e.name}) ${st.forceUntil > now ? 'cancelled' : 'was not queued'}`);
      st.forceUntil = 0;
      return false;
    }
    if (st.bout) { console.log(`[crush] force(${e.name}) refused: already in bout ${st.bout.id}`); return false; }
    const why = this.tryForce(sys, e, st, now);
    if (!why) return true;
    if (PERMANENT.has(why)) { console.log(`[crush] force(${e.name}) refused: ${why}`); return false; }
    st.forceUntil = now + this.k('forceWait');
    console.log(`[crush] force(${e.name}) queued for ${this.k('forceWait')} s, waiting on: ${why}`);
    return 'queued';
  }

  /* One attempt at a forced entry: '' when it took, otherwise the test that refused it. */
  tryForce(sys, e, st, now) {
    const r = this.resolve(sys, e, now, true);
    if (r.why) return r.why;
    this.enter(sys, e, r, now);
    return '';
  }

  pendingForce(sys, e, now) {
    const st = this.map.get(e);
    if (!st?.forceUntil || st.bout) return;
    if (now > st.forceUntil) {
      st.forceUntil = 0;
      console.log(`[crush] force(${e.name}) gave up after ${this.k('forceWait')} s`);
      return;
    }
    if (!this.tryForce(sys, e, st, now)) console.log(`[crush] force(${e.name}) took, after waiting for a window`);
  }

  debug() {
    const out = {};
    const now = this.sys.time;
    for (const e of this.sys.eels) {
      const st = this.map.get(e);
      if (!st || e.quirks?.follows !== 'Jaz') continue;
      out[e.name] = {
        state: st.phase || (now < st.coolUntil ? 'cooling' : 'idle'),
        fluster: +st.fluster.toFixed(3),
        misses: st.misses,
        off: st.sampled ? +st.off.toFixed(3) : 0,
        laneTol: +(this.k('laneTol') * e.length).toFixed(3),
        cool: Math.max(0, +(st.coolUntil - now).toFixed(2)),
        forceIn: st.forceUntil > now ? +(st.forceUntil - now).toFixed(2) : 0,
        memberIndex: st.bout ? st.memberIndex : -1,
        boutId: st.bout?.id ?? 0,
        // A bout that started and ended between two samples leaves its reason here and nowhere else.
        lastEnd: st.lastEnd,
        lastEndAgo: st.lastEndAt < 0 ? -1 : +(now - st.lastEndAt).toFixed(2),
      };
    }
    return out;
  }
}
