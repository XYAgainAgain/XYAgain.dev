/* Matthew's kettle. The census MUST ("must be drinking tea"): he sips at lily pad notches, snoot
   poked up under the slit where rain runs off the leaf. A cup whenever it rains, one before every
   deep rest and another on waking, and a one-in-four nightcap after a meal. Two hooks, from steer. */

const LEAD = 0.9;     // steering target rides past the notch; arrival is measured at the notch itself
const REACH = 8;      // no pad past this is worth the swim
const ARRIVE = 0.45;
const GIVE_UP = 12;
const DEEP = 5;       // bout seconds past this is a real rest, same line steer draws for poses

export class TeaTime {
  constructor({ pads }) {
    this.pads = pads ?? null;
    this.state = new Map();   // one record per tea drinker; bounded by the cast
    // Live dials (pond.eels.knobs.tea): sip/break/cadence are second ranges, meal the after-dinner
    // odds, grace how fresh a cup skips the bedtime one, rainOn the envelope that starts the ritual.
    this.knobs = { sip: [4, 8], break: [4, 10], cadence: [1.3, 2.4], meal: 0.25, grace: 12, rainOn: 0.2 };
  }

  stateFor(e) {
    let st = this.state.get(e);
    if (!st || st.id !== e.identity) {
      st = { id: e.identity, want: '', padIdx: -1, giveUpAt: 0, sipUntil: 0, sipAt: 0, sipN: 0, breakUntil: 0, seenBout: -1, wasDeep: false, restLen: 0, lastTeaAt: -99 };
      this.state.set(e, st);
    }
    return st;
  }

  /* From main on every finished crumb: the after-dinner cup. */
  onMeal(ev) {
    const e = ev.eel;
    if (!e?.quirks?.tea || ev.source !== 'eel') return;
    const st = this.stateFor(e);
    if (!st.want && e.rng.chance(this.knobs.meal)) st.want = 'meal';
  }

  /* The notch nearest the head, a wide gape winning ties. */
  pickPad(e) {
    const list = this.pads?.pads;
    if (!list) return -1;
    let pick = -1, best = 0;
    for (let i = 0; i < list.length; i++) {
      const s = this.pads.sipSpot(i);
      if (!s) continue;
      const d = Math.hypot(s.x - e.head.x, s.z - e.head.z);
      if (d > REACH) continue;
      const w = (1 + s.notch * 2) / (1 + d);
      if (w > best) { best = w; pick = i; }
    }
    return pick;
  }

  /* Hook one, from pickTarget ahead of the tunnel branch: a due cup outranks a log run. */
  pickTarget(sys, e, now) {
    const st = this.stateFor(e);
    if (!st.want || now < st.breakUntil) return false;
    if (sys.foods.some((f) => f.amount > 0)) return false;   // crumbs first; the meal roll re-queues anyway
    const idx = st.padIdx >= 0 ? st.padIdx : this.pickPad(e);
    if (idx < 0) {
      if (st.want === 'rest') this.rest(e, st, now);   // no pad in reach: straight to bed, no cup
      this.abandon(e, st, now);
      return false;
    }
    const s = this.pads.sipSpot(idx);
    if (!s) { st.padIdx = -1; return false; }
    st.padIdx = idx;
    if (!st.giveUpAt) st.giveUpAt = now + GIVE_UP;
    this.aim(e, s);
    e.coverSpot = { type: 'tea', idx };
    e.retargetAt = now + GIVE_UP * 3;
    return true;
  }

  aim(e, s) {
    const dx = s.x - e.head.x, dz = s.z - e.head.z;
    const inv = Math.hypot(dx, dz) > 1e-4 ? 1 / Math.hypot(dx, dz) : 0;
    e.target.set(s.x + dx * inv * LEAD, 0, s.z + dz * inv * LEAD);
  }

  /* Hook two, from steer after the food block. Owns triggers, approach, and the cup itself. */
  tick(sys, e, dt) {
    const now = sys.time;
    const st = this.stateFor(e);
    const k = this.knobs;

    // Trigger bookkeeping first, so a queued cup survives whatever the trip logic decides below.
    const deep = e.gait === 'hold' && e.gaitUntil - e.gaitFrom > DEEP;
    if (deep && st.seenBout !== e.gaitFrom) {
      st.seenBout = e.gaitFrom;
      // Bedtime cup: hijack a fresh deep rest unless one just happened; rest() resumes the bout after.
      if (now - st.lastTeaAt > k.grace && !e.snuggle.with && !e.pose.kind && !st.want) {
        st.want = 'rest';
        st.restLen = Math.max(8, e.gaitUntil - now);
        e.gaitUntil = now;
      } else st.wasDeep = true;
    }
    if (st.wasDeep && (e.gait !== 'hold' || now >= e.gaitUntil)) { st.wasDeep = false; if (!st.want) st.want = 'wake'; }
    const env = sys.rain?.envelope ?? 0;
    if (!st.want && env > k.rainOn && now >= st.breakUntil) st.want = 'rain';
    // A due cup with no trip started yet expedites the next retarget, where hook one takes over.
    // The live-crumb guard mirrors hook one's, or this would re-expedite every tick through a meal.
    if (st.want && st.padIdx < 0 && now >= st.breakUntil && !e.food && !e.tunnel && !sys.foods.some((f) => f.amount > 0)) {
      e.retargetAt = Math.min(e.retargetAt, now);
    }

    // Anything louder cancels the trip: a scare, a crumb, a log run, a braid.
    if (st.padIdx >= 0 && (now < e.fleeUntil || e.food || e.tunnel || e.twine)) { this.abandon(e, st, now); return; }
    if (!st.want || st.padIdx < 0) return;

    const s = this.pads?.sipSpot(st.padIdx);
    if (!s) { this.abandon(e, st, now); return; }

    if (st.sipUntil) {
      if (now >= st.sipUntil) { this.finish(sys, e, st, now); return; }
      // Mid-cup: parked under the notch on a slurp cadence, each sip dimpling the surface. The re-aim
      // keeps the slow hold drift orbiting the notch instead of coasting past the pad.
      this.aim(e, s);
      e.gait = 'hold';
      e.gaitUntil = Math.max(e.gaitUntil, st.sipUntil);
      e.targetY = -e.radius * 1.4;
      e.retargetYAt = st.sipUntil;
      if (now >= st.sipAt) {
        st.sipAt = now + e.rng.range(k.cadence[0], k.cadence[1]);
        sys.emit('tea', e, { step: st.sipN++ });   // the step climbs the sample's pitch through the cup
        sys.sim?.addDrop(s.x, s.z, 0.25, 0.003);
      }
      return;
    }

    // On approach: no napping with the kettle on, hold the aim (pads drift), rise near the pad.
    if (e.gait === 'hold') { e.gait = 'prowl'; e.gaitUntil = now + 2; }
    this.aim(e, s);
    const d = Math.hypot(s.x - e.head.x, s.z - e.head.z);
    if (d < 2) { e.targetY = -e.radius * 1.4; e.retargetYAt = now + 1; }
    if (d < ARRIVE && e.head.y > -e.radius * 3) {
      st.sipUntil = now + e.rng.range(k.sip[0], k.sip[1]);
      st.sipAt = now;
      st.sipN = 0;
      e.gait = 'hold';
      e.gaitUntil = st.sipUntil;
      e.gaitFrom = now;
      st.seenBout = e.gaitFrom;   // consume the bout, or a long cup would read as a rest and re-hijack
    } else if (now > st.giveUpAt) {
      // The pond said no. The bedtime cup still ends in bed; everything else just tries again later.
      if (st.want === 'rest') this.rest(e, st, now);
      this.abandon(e, st, now);
    }
  }

  finish(sys, e, st, now) {
    st.lastTeaAt = now;
    const reason = st.want;
    st.want = ''; st.padIdx = -1; st.giveUpAt = 0; st.sipUntil = 0;
    if (e.coverSpot?.type === 'tea') e.coverSpot = null;
    e.retargetAt = now;
    if (reason === 'rain') st.breakUntil = now + e.rng.range(this.knobs.break[0], this.knobs.break[1]);
    if (reason === 'rest') this.rest(e, st, now);
  }

  /* Bedtime proper: the interrupted rest resumes on the spot, and waking from it still earns a cup. */
  rest(e, st, now) {
    e.gait = 'hold';
    e.gaitFrom = now;
    e.gaitUntil = now + st.restLen;
    st.seenBout = e.gaitFrom;
    st.wasDeep = true;
  }

  abandon(e, st, now) {
    st.want = ''; st.padIdx = -1; st.giveUpAt = 0; st.sipUntil = 0;
    st.breakUntil = now + 5;
    if (e.coverSpot?.type === 'tea') e.coverSpot = null;
  }
}
