/* One arm's recoil off a noxious touch, THREE-free: a state machine after OctopusController's HazardResponse
   (hazards.js, MIT), re-implemented. It only reads touches and reports transitions; arm-reflex.js turns them into goals. */

export const REFLEX_KNOBS = {
  threshold: 0.4,     // severity at and above which a new touch recoils; under it the arm only holds and ignores longer
  recoilBase: 0.25,   // s of recoil: recoilBase + recoilPer × severity
  recoilPer: 0.9,
  clear: 0.6,         // s clear of every noxious touch, after any recoil, before the arm is calm and its seen set rearms
  ignoreTime: 4,      // s after its last touch that a thing which set off a recoil can't set off another
  mildHold: 0.3,      // s a mild touch holds the arm, shorter than any recoil
  mildIgnore: 8,      // s a mild thing is left alone after its last touch
  // The recoil goal's shape (makeRecoil in arm-plant-core.js); a goal takes these when made and carries them.
  bend: 0.16,         // rad per joint the flinch bends, times 1 + gain × severity, inside each joint's limit
  gain: 4,
  smear: 3,           // joints at and behind the touched segment that bend
  stiff: 1,           // of stiffBehind, at those joints
  baseStiff: 0.5,     // of stiffBehind, the arm before them holding its pose
  shorten: 0.03,      // of its length the flinching part loses, times 1 + gain × severity, early in the recoil
  shortenRate: 1,     // per s, that shortening's pace (an arm's own runs under 3% a second)
  shortenIn: 0.15,    // share of the recoil the shortening takes to come in, and where it starts to let go
  shortenOut: 0.4,
  hold: 2,            // s a recoil goal keeps its pose past its recoil before letting go, if nothing replaces it
  muscle: 'pass',     // in muscle mode: 'pass' keeps the flinch's bends as they are, 'map' braces them through the map
};

/* The escalation latch, body-wide: a thing that has stung her `stings` times (on any arms) within `window` s is given a
   wide berth by every arm for `hold` s after its last sting. */
export const LATCH_KNOBS = {
  latch: true,
  stings: 2,
  window: 30,
  hold: 45,
  berth: 0.06,        // m every arm keeps off the latched thing's surface
  berthIn: 0.5,       // s the berth takes to grow to full, so an arm lying on the thing is eased off, not thrown
};

/* Stings per thing and the latches they trip, THREE-free. sting() returns true on the sting that trips a latch. */
export class StingLatch {
  constructor(knobs = LATCH_KNOBS) {
    this.knobs = knobs;
    this.m = new Map();       // entry → { times: sting times inside the window, since: when it latched, or -1, last }
    this.time = 0;
    this.trips = 0;
  }

  sting(entry, t = this.time) {
    if (entry == null) return false;
    const k = this.knobs;
    let e = this.m.get(entry);
    if (!e) this.m.set(entry, e = { times: [], since: -1, last: t });
    e.last = t;
    e.times.push(t);
    while (e.times.length && t - e.times[0] > k.window) e.times.shift();
    if (e.since >= 0 || !k.latch || e.times.length < Math.max(1, k.stings)) return false;
    e.since = t;
    this.trips++;
    return true;
  }

  /* Forgets stings older than the window and lets latches lapse `hold` s after their last sting. */
  tick(t) {
    this.time = t;
    const k = this.knobs;
    for (const [entry, e] of this.m) {
      if (e.since >= 0 && t - e.last > k.hold) e.since = -1;
      while (e.times.length && t - e.times[0] > k.window) e.times.shift();
      if (e.since < 0 && !e.times.length) this.m.delete(entry);
    }
  }

  latched(entry) { const e = this.m.get(entry); return !!e && e.since >= 0 && !!this.knobs.latch; }

  /* The berth around a latched thing now, growing in over berthIn; 0 when it isn't latched. */
  berth(entry, t = this.time) {
    const e = this.m.get(entry), k = this.knobs;
    if (!e || e.since < 0 || !k.latch) return 0;
    return k.berth * Math.min(1, Math.max(0, (t - e.since) / Math.max(1e-6, k.berthIn)));
  }

  /* Every latched thing, for the berth's world and the readout. */
  list(out = []) {
    out.length = 0;
    if (this.knobs.latch) for (const [entry, e] of this.m) if (e.since >= 0) out.push(entry);
    return out;
  }

  reset() { this.m.clear(); this.trips = 0; }
}

/* Seconds of recoil for a touch of this severity. */
export function recoilTime(severity, k = REFLEX_KNOBS) { return k.recoilBase + k.recoilPer * severity; }

const sev = (s) => (Number.isFinite(s) && s > 0 ? Math.min(1, s) : 0);
const v3 = (p) => (p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]) ? [p[0], p[1], p[2]] : null);
const copy = (c, s) => ({ entry: c.entry, severity: s, seg: c.seg, point: v3(c.point), normal: v3(c.normal) });

/* States: calm, recoiling (timed), avoiding (still touching a noxious thing with no recoil running), and reassessing
   (clear, waiting out `clear`). sense() returns this tick's transitions, each { type, t, state, ... }, in an array it reuses. */
export class Reflex {
  constructor(knobs = REFLEX_KNOBS) {
    this.knobs = knobs;
    this.out = [];
    this._best = new Map();
    this.reset();
  }

  reset() {
    this.state = 'calm';
    this.time = 0;
    this.since = 0;             // when the state last changed
    this.end = 0;               // when the running recoil ends
    this.quiet = 0;             // s clear of every noxious touch
    this.severity = 0;          // the running episode's strongest recoil, and its touch
    this.touch = null;
    this.seen = new Set();      // entries met this episode: touching one again never retriggers
    this.memory = new Map();    // entry → { last, window }: a thing's last touch and how long after it it stays ignored
    this.out.length = 0;
  }

  get remaining() { return Math.max(0, this.end - this.time); }

  /* Seconds before this thing can set off a recoil or a mild hold again (0 once it can). */
  ignoreLeft(entry) { const m = this.memory.get(entry); return m ? Math.max(0, m.last + m.window - this.time) : 0; }

  ignoring(entry) { return this.ignoreLeft(entry) > 0; }

  /* One tick: the noxious touches on this arm, each { entry, severity, seg, point, normal }, the first `count` of them.
     A thing touching several segments counts once, by its segment nearest the base. */
  sense(touches, dt, count = touches?.length ?? 0) {
    const k = this.knobs, out = this.out, best = this._best;
    out.length = 0;
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    const t = this.time += dt;
    best.clear();
    for (let i = 0; i < count; i++) {
      const c = touches[i], s = sev(c?.severity);
      if (!(s > 0) || c.entry == null) continue;
      const b = best.get(c.entry), bs = b === undefined ? 0 : sev(touches[b].severity);
      if (b === undefined || s > bs || (s === bs && c.seg < touches[b].seg)) best.set(c.entry, i);
    }
    // A new encounter is a thing neither met this episode nor still remembered; the strongest of them sets the recoil.
    let hit = -1, hs = 0;
    const mild = this._mild ??= [];
    mild.length = 0;
    for (const [entry, i] of best) {
      const s = sev(touches[i].severity), m = this.memory.get(entry), fresh = !this.seen.has(entry) && !(m && t < m.last + m.window);
      this.seen.add(entry);
      if (!fresh) { if (m) m.last = t; continue; }
      const strong = s >= k.threshold;
      this.memory.set(entry, { last: t, window: strong ? k.ignoreTime : k.mildIgnore });
      if (!strong) { mild.push(i); continue; }
      if (s > hs || (s === hs && touches[i].seg < touches[hit].seg)) { hit = i; hs = s; }
    }
    let began = false;
    if (hit >= 0) {
      const d = recoilTime(hs, k);
      if (t < this.end) {
        // A running recoil is lengthened by a new encounter, never shortened; a stronger one takes over its aim.
        if (t + d > this.end) {
          const stronger = hs > this.severity;
          this.end = t + d;
          if (stronger) { this.severity = hs; this.touch = copy(touches[hit], hs); }
          out.push({ type: 'extend', t, duration: d, stronger, ignore: k.ignoreTime, touch: copy(touches[hit], hs) });
        }
      } else if (d > 0) { this.end = t + d; this.severity = hs; this.touch = copy(touches[hit], hs); began = true; }
    }
    // A mild thing met during a recoil is remembered but asks for no hold, which would replace the flinch.
    if (!(t < this.end)) for (const i of mild) out.push({ type: 'mild', t, hold: k.mildHold, ignore: k.mildIgnore, touch: copy(touches[i], sev(touches[i].severity)) });
    for (const [entry, m] of this.memory) if (!(t < m.last + m.window)) this.memory.delete(entry);
    // The clear time only starts once the recoil is over, so reassessing always lasts `clear` after one.
    const was = this.state;
    let next;
    if (t < this.end) { next = 'recoiling'; this.quiet = 0; }
    else {
      if (best.size) this.quiet = 0; else this.quiet += dt;
      next = best.size ? 'avoiding' : this.seen.size && this.quiet < k.clear - 1e-9 ? 'reassessing' : 'calm';
    }
    // A recoil that ran out and another that began on the same tick is a new recoil, not a state that stayed.
    if (began) out.push({ type: 'recoil', t, from: was, duration: this.end - t, severity: this.severity, ignore: k.ignoreTime, touch: this.touch });
    else if (next !== was && next === 'avoiding') out.push({ type: 'avoid', t, from: was });
    else if (next !== was && next === 'reassessing') out.push({ type: 'reassess', t, from: was });
    else if (next !== was && next === 'calm') {
      this.seen.clear(); this.severity = 0; this.touch = null;
      out.push({ type: 'calm', t, from: was });
    }
    if (began || next !== was) this.since = t;
    this.state = next;
    for (let i = 0; i < out.length; i++) out[i].state = next;
    return out;
  }
}
