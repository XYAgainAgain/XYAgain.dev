import { SLIDERS, personalize, lineTable } from './brain-tuning-core.js';
import { freshMeters, driftDeltas, updateLines, pastRedLine, liftStep, pressures, clamp01 } from './brain-needs-core.js';
import { MoodPile, readMood, MoodDisplay, MoodWord } from './brain-mood-core.js';
import { scoreCandidate, Selector, Wants, travelFactor, recencyFactor, unreachableFactor, restBenefits, shelterBenefits } from './brain-choice-core.js';
import { BrainClock } from './brain-clock-core.js';
import { Authority, SharedRecord } from './brain-authority-core.js';
import { TasteReader, TouchBouts, Spotlight, KnockSense } from './brain-senses-core.js';
import { Knowledge } from './brain-knowledge-core.js';
import { RestLadder } from './brain-rest-core.js';
import { encounterOutcome, cleanOutcome, SkillBook } from './brain-learning-core.js';
import { createRng, deriveSeed } from '../../../../pond/js/rng.js';

/* Amira's brain, THREE-free. The host feeds evidence (see, touch, observe, knock, disturb, at, places, company, ate, report;
   string ids, numbers accepted for sight) and steps it with epoch ms; it reads goal, release, look, mood, meters, explain(). */

const SENSE = 0.25, METER = 1;
const GAP = 300;      // s; a longer silence is a pause, never one enormous step
const MEMORY = 600;   // s a thing out of sight stays a candidate at its last known distance
const SIGHT_MAX = 128, OBS_MAX = 64;
const finiteFrom0 = (x) => (Number.isFinite(x) && x >= 0 ? x : null);
const idOf = (x) => (typeof x === 'string' ? x : Number.isFinite(x) ? String(x) : null);

export class Brain {
  constructor({ now = NaN, seed = 1, sliders = SLIDERS, tuning = null, tab = 'local', record = null } = {}) {
    const T = this.T = tuning ?? personalize(sliders);
    this.rows = lineTable(T);
    this.clock = new BrainClock(now, T);
    const t = this.clock.t;
    this.record = record ?? new SharedRecord(freshMeters(T));
    this.auth = new Authority(this.record, { tab });
    this.flags = updateLines(this.record.meters, {}, T, this.rows);
    this.pile = new MoodPile(T); this.display = new MoodDisplay(T); this.word = new MoodWord(T);
    this.wants = new Wants(T); this.selector = new Selector(T);
    this.know = new Knowledge(T); this.bouts = new TouchBouts(T); this.reader = new TasteReader();
    this.spot = new Spotlight(T); this.knocks = new KnockSense(T); this.rest = new RestLadder(T);
    this.skills = new SkillBook(T);   // tactic learning, carried for the puzzles that will feed it
    this.rng = { draw: createRng(deriveSeed(seed, 7001)), look: createRng(deriveSeed(seed, 7013)), roll: createRng(deriveSeed(seed, 7027)) };
    this.world = { seen: [], log: null, contacts: [], at: { kind: 'open', den: null, settled: false }, den: null, shelter: null,
      patrol: 0.8, projects: [], julia: null, palm: null, exposedUntil: -Infinity };
    this.body = { goal: 0, crawl: 0, engaged: null, displaying: false, released: true };
    this.goal = null; this._pending = null; this._goalSeq = 0; this.release = null; this._obs = [];
    this.look = null; this.startle = null; this.woken = null; this.paused = false;
    this.lastNoxious = -Infinity; this.lastResult = -Infinity;
    this._urgentLook = null; this._palmAt = null; this._scored = [];
    this._conditions(t); this._mood(t); this.display.snap(this.moodNow);
    this._birth(t);
  }

  /* Time-stamped start state, set again at the first valid step when the constructor had no valid time. */
  _birth(t) {
    this._lookSince = t; this._pruneAt = t; this._displayAt = t;
    if (this._palmAt !== null) this._palmAt = t;
    this.next = { sense: t, meters: t + METER, review: t };
    this._lastSense = t; this._lastMeters = t;
  }

  get born() { return this.clock.started; }

  get t() { return this.clock.t; }
  get meters() { return this.record.meters; }
  get lift() { return this.record.lift; }
  get reasons() { return [...this.pile.items.values()]; }

  // Evidence in
  see(list) {
    const out = [];
    for (const s of Array.isArray(list) ? list : []) {
      const id = idOf(s?.id);
      if (id === null) continue;
      out.push({ ...s, id, kind: s.kind == null ? id : String(s.kind), dist: finiteFrom0(s.dist), eta: finiteFrom0(s.eta),
        moving: Number.isFinite(s.moving) ? clamp01(s.moving) : 0 });
      if (out.length >= SIGHT_MAX) break;
    }
    this.world.seen = out;
  }
  /* `generation` changes only when the log's producer restarts its numbering. */
  touch(log, contacts = [], generation) {
    this.world.log = log; this.world.contacts = Array.isArray(contacts) ? contacts : []; this.world.logGen = generation;
  }
  places({ den, shelter, patrol, projects } = {}) {
    const W = this.world;
    if (den !== undefined) W.den = den;
    if (shelter !== undefined) W.shelter = shelter;
    if (Number.isFinite(patrol)) W.patrol = patrol;
    if (projects !== undefined) W.projects = Array.isArray(projects) ? projects : [];
  }
  company({ julia, palm } = {}) {
    const W = this.world;
    if (julia !== undefined) W.julia = julia;
    if (palm !== undefined) {
      if (palm && !W.palm) this._palmAt = this.t;
      if (!palm) this._palmAt = null;
      W.palm = palm;
    }
  }
  at(place) { this.world.at = { kind: 'open', den: null, settled: false, ...place }; }
  /* Held for the next sensory tick, after that tick's sight, so a thing seen in the same frame is known by then. */
  observe(thing, type, value = null) {
    const id = idOf(thing);
    if (id === null || this.paused) return;
    this._obs.push([id, type, value]);
    if (this._obs.length > OBS_MAX) this._obs.shift();
  }
  _observe(id, type, value, t) {
    const th = this.know.things.get(id);
    if (!th) return;
    if (type === 'feature') this.auth.meter('stimulation', this.T.gains.feature, 'feature', t, `feature:${id}:${value ?? ''}`);
    if (this.know.observe(th.kind, type, value)) this._learned(th, t);
  }
  gone(thing) {
    const id = idOf(thing);
    if (id === null) return;
    this.know.forgetThing(id); this.wants.dropTarget(id);
    if (this._pending?.cand.target === id) {
      this._pending = null; this.selector.clear();
      if (this.goal?.phase === 'release') this.goal.next = null;
      this.next.review = Math.min(this.next.review, this.t);
    }
    if (this.goal?.phase === 'go' && this.goal.target === id) this._end('vanished', this.t);
  }

  knock(visitor = 'visitor', { near = true } = {}) {
    if (!this.born) return null;
    const t = this.t, k = this.knocks.knock(t, visitor), K = this.T.knock;
    if (near) this.world.exposedUntil = t + this.T.comfort.exposedFor;
    if (this.rest.asleep) {
      if (this.rest.disturb(t, k.storm ? K.stormStrength : k.wake, true)) this._woken(t);
    } else {
      this.rest.calmSince = t;
      const share = K.first > 0 ? k.strength / K.first : 0;
      this.pile.add('firstKnock', visitor, t, { points: this.T.reasons.firstKnock.points * share });
      this.auth.meter('comfort', -this.knocks.allow(t, K.comfort * share), 'knock', t);
      this.startle = { at: t, strength: k.strength, flinch: this._absorbed() };
      this._urgentLook = 'glass';
    }
    if (k.storm) {
      this.pile.add('rudeKnocking', visitor, t);
      this.auth.meter('comfort', -this.knocks.allow(t, K.stormComfort), 'storm', t);
    }
    this._mood(t);
    return k;
  }

  disturb(strength, { near = true, knockLike = false } = {}) {
    if (!this.born) return;
    const t = this.t;
    if (near) this.world.exposedUntil = t + this.T.comfort.exposedFor;
    if (this.rest.disturb(t, strength, knockLike)) this._woken(t);
  }

  ate(id) {
    const thing = idOf(id), t = this.t, th = this.know.things.get(thing);
    if (!th || th.gone || this.paused || !this.born) return 0;
    const k = this.know.kind(th.kind), F = this.T.offers.food, offer = F[th.kind] ?? F.other;
    k.props.edible = true;
    const got = offer?.fullness && this.auth.once(`meal:${thing}`, t) ? this.auth.meter('fullness', offer.fullness, 'meal', t) : 0;
    if (k.opinion >= 0) this.pile.add('ateLiked', th.kind, t);
    if (this.goal?.phase === 'go' && this.goal.target === thing) this._end('success', t);
    this.know.forgetThing(thing); this.wants.dropTarget(thing);
    return got;
  }

  /* A body summary, ignored while paused: goal id, engaged (play, thumb, work, inspect, company), crawl 0–1, jets and haulOuts since the last report, displaying,
     failed (distinct tactics), released or aborted (answering that goal id), unreachable, done, outcome, result. */
  report(s = {}) {
    if (this.paused || !this.born) return;
    const t = this.t, b = this.body;
    if ('crawl' in s) b.crawl = Number.isFinite(s.crawl) ? clamp01(s.crawl) : 0;
    if ('engaged' in s) b.engaged = typeof s.engaged === 'string' ? s.engaged : null;
    if ('displaying' in s) b.displaying = !!s.displaying;
    if (Number.isFinite(s.goal)) b.goal = s.goal;
    if (s.jets > 0) this.auth.meter('energy', this.T.energy.jet * s.jets, 'jet', t);
    if (s.haulOuts > 0) this.auth.meter('energy', this.T.energy.haulOut * s.haulOuts, 'haulOut', t);
    if (s.result) this._result(s.result, t);
    const letGo = s.released === true || s.aborted === true;
    if (this.release && s.goal === this.release.id && letGo) {
      this.release = null;
      if (this.goal?.phase === 'release') this._startPending(t);
      else this._pending = null;
    } else if (this.goal?.phase === 'go' && s.goal === this.goal.id && s.released !== undefined) b.released = letGo;
    const g = this.goal;
    if (!g || g.phase !== 'go' || s.goal !== g.id) return;
    if (s.outcome) g.outcome = cleanOutcome(s.outcome) ?? g.outcome;
    if (s.failed > g.failed) {
      g.failed = s.failed;
      const E = this.T.episode;
      if (g.failed >= E.endAfter) { this.pile.add('failedEpisode', g.target, t); g.outcome = { ...g.outcome, obstruction: 1 }; this._end('failed', t); return; }
      if (g.failed >= E.putDownAfter) { this.pile.add('blockedTwice', g.target, t); this.next.review = Math.min(this.next.review, t); }
    }
    if (s.unreachable) { const th = this.know.things.get(g.target); if (th) th.unreachableAt = t; this._end('unreachable', t); return; }
    if (s.done) this._end(s.done, t);
  }

  pause() { this.paused = true; }

  resume(nowMs) {
    this.paused = false;
    const born = this.born, dt = this.clock.advance(nowMs);
    if (!born) { if (this.born) this._birth(this.t); return; }
    if (dt > 0) this._gap(this.t, dt);
  }

  /* The display settles on the tick timeline, never at the host's step times, so a span reads the same however the
     host slices it. */
  step(nowMs) {
    if (this.paused) return this;
    const born = this.born, dt = this.clock.advance(nowMs), t = this.t;
    if (!born) { if (this.born) this._birth(t); return this; }
    if (!(dt > 0)) return this;
    if (dt > GAP) { this._gap(t, dt); return this; }
    for (;;) {
      const n = this.next, due = Math.min(n.sense, n.meters, n.review);
      if (due > t) break;
      this.display.step(this.moodNow, due - this._displayAt); this._displayAt = due;
      if (n.sense === due) { this._sense(due); n.sense = due + SENSE; }
      else if (n.meters === due) { this._meters(due); n.meters = due + METER; }
      else { this._review(due); n.review = due + this.T.choice.review; }
    }
    return this;
  }

  /* A pause: drift in closed form over the gap as she was, feelings expire on their original times, perception (look,
     bouts, startle) starts fresh, and her goal resumes. */
  _gap(t, dt) {
    const m = this.record.meters, d = driftDeltas(m, t - this._lastMeters, this._driftState(t), this.T);
    for (const k in d) this.auth.meter(k, d[k], 'drift', t);
    this.auth.lift(liftStep(this.record.lift, dt, null, this.T), 'drift', t);
    this.know.age(dt / 86400, t, this._kept());
    this.pile.expire(t); this.wants.expire(t);
    if (dt > GAP) this.pile.clearLocal();
    this.bouts.open.clear(); this.spot.look = null; this.look = null; this.startle = null; this._urgentLook = null;
    if (this.release) this.release.since += dt;
    updateLines(m, this.flags, this.T, this.rows); this._conditions(t); this._mood(t); this.display.snap(this.moodNow);
    this.next = { sense: t, meters: t + METER, review: t };
    this._lastSense = t; this._lastMeters = t; this._displayAt = t;
  }

  _driftState(t) {
    const at = this.world.at, C = this.T.comfort.targets;
    let target = at.kind === 'den' ? C.den : at.kind === 'shelter' ? C.shelter : C.ordinary;
    if (at.kind === 'open' && t < this.world.exposedUntil) target = C.exposed;
    return { sleep: this.rest.sleep, crawl: this.body.crawl, target, displaying: this.body.displaying };
  }

  _awakeEnough() { const s = this.rest.state; return s === 'awake' || s === 'curled'; }
  _absorbed() { return (!!this.goal && this.goal.kind !== 'aimless') || this.rest.state !== 'awake'; }

  _sense(t) {
    const dt = t - this._lastSense, W = this.world, K = this.know;
    this._lastSense = t;
    const view = [];
    for (const s of W.seen) {
      if (!s.visible) continue;
      const { thing, first } = K.see(t, s), k = K.kind(thing.kind);
      view.push({ id: s.id, visible: true, dist: thing.dist, moving: s.moving, changed: !!s.changed, seenBefore: k.explored });
      if (first && !k.explored && k.contact === 0) {
        this.pile.add('newThing', s.id, t);
        this.wants.offer([{ kind: 'inspect', target: s.id, matches: ['inspect'], strength: 2 }], s.id, t);
        this._urgentLook = s.id;
        this.next.review = Math.min(this.next.review, t);
      } else if (s.changed && !first) {
        this.wants.offer([{ kind: 'revisit', target: s.id, matches: ['play', 'inspect'], strength: 1.5 }], `moved:${s.id}`, t);
      }
    }
    const obs = this._obs;
    this._obs = [];
    for (const [id, type, value] of obs) this._observe(id, type, value, t);
    const { fresh } = this.reader.read(W.log, W.logGen), events = [];
    this.bouts.update(t, dt, fresh, W.contacts, events);
    for (const e of events) this._touchEvent(e, t);
    const look = this.spot.review(t, view, { target: this.goal?.target ?? null, urgent: this._urgentLook }, this.rng.look.next());
    this._urgentLook = null;
    if (look !== this.look) this._lookSince = t;
    this.look = look;
    if (look && t - this._lookSince >= this.T.attention.hold) {
      const th = K.things.get(look);
      if (th && !th.looked) { th.looked = true; if (K.observe(th.kind, 'look')) this._learned(th, t); }
    }
    this._mood(t);
  }

  _touchEvent(e, t) {
    const b = e.bout, K = this.know;
    if (typeof b.thing !== 'string') return;
    if (!K.things.has(b.thing)) K.see(t, { id: b.thing, kind: b.kind ?? b.thing });
    const th = K.things.get(b.thing);
    th.novelty = Number.isFinite(b.novelty) ? clamp01(b.novelty) : 1; th.touchedAt = t;
    if (e.type === 'open') {
      const G = this.T.gains, C = this.T.comfort;
      if (K.bout(th.kind)) this._learned(th, t);
      const taste = b.taste === 'food' || b.taste === 'noxious' ? b.taste : 'plain';
      if (K.observe(th.kind, 'taste', taste)) this._learned(th, t);
      if (e.first) this.auth.meter('stimulation', G.firstTouch, 'firstTouch', t, `first:${b.thing}`);
      else if (t - th.comfortAt >= C.touchEvery) { th.comfortAt = t; this.auth.meter('comfort', C.touch, 'touch', t); }
      if (b.taste === 'noxious') this._noxious(th, e.entry?.severity, t);
      else if (b.thing !== 'self' && this.bouts.pull(b.taste, b.novelty) >= this.T.touch.investigate) {
        this.wants.offer([{ kind: 'investigate', target: b.thing, matches: ['inspect', 'play'], strength: 1 }], `touch:${b.thing}`, t);
      }
    } else if (e.type === 'hold') {
      if (K.handle(th.kind, e.dt, t)) this._learned(th, t);
      // A patrol's re-tastes are chosen inspections too, paid up to the patrol's offer.
      const g = this.goal?.phase === 'go' ? this.goal : null, G = this.T.gains;
      const cap = g?.kind === 'inspect' && g.target === b.thing ? G.inspectCap : g?.kind === 'patrol' && b.thing !== 'self' ? this.T.offers.patrol.stimulation : 0;
      if (g && g.stimPaid < cap) g.stimPaid += this.auth.meter('stimulation', Math.min(cap - g.stimPaid, G.inspectPerMin * th.novelty * e.dt / 60), g.kind, t);
    }
  }

  _noxious(th, severity, t) {
    const N = this.T.noxious, s = Number.isFinite(severity) ? clamp01(severity) : 0.7, severe = s >= N.severeAt;
    this.lastNoxious = t;
    this.know.kind(th.kind).props.noxious = true;
    this.know.caution(th.id, t);
    this.pile.add(severe ? 'noxiousSevere' : 'noxiousMild', th.id, t);
    this.auth.meter('comfort', -(severe ? Math.max(N.mild, N.severe * s) : N.mild), 'noxious', t);
    this.know.encounter(th.kind, encounterOutcome({ noxious: s }, this.T));
    this.wants.dropTarget(th.id);
    this._urgentLook = th.id;
    this._mood(t);
    if (this.goal?.phase === 'go' && this.goal.target === th.id) this._end('failed', t);
  }

  _learned(th, t) {
    this.pile.add('learned', th.id, t);
    this.wants.offer([{ kind: 'follow', target: th.id, matches: ['play', 'inspect'], strength: 1.5 }], `learned:${th.id}`, t);
    this.know.rollEarly(th.kind, this.rng.roll.next());
  }

  _result(r, t) {
    const G = this.T.gains;
    if (!r.survived || !r.changed || t - this.lastResult < G.resultEvery) return;
    this.lastResult = t;
    this.auth.meter('expression', G.result, 'result', t, r.id ? `result:${r.id}:${t}` : null);
    this.pile.add('workStayed', r.id ?? 'work', t);
    this.wants.offer([{ kind: 'improve', matches: ['improve', 'arrange'], strength: 1 }], 'inspired', t);
  }

  _meters(t) {
    const e = t - this._lastMeters, m = this.record.meters, T = this.T, b = this.body;
    this._lastMeters = t;
    if (!(e > 0)) return;
    const d = driftDeltas(m, e, this._driftState(t), T);
    for (const k in d) this.auth.meter(k, d[k], 'drift', t);
    const G = T.gains, g = this.goal?.phase === 'go' ? this.goal : null, engaged = this._awakeEnough() ? b.engaged : null;
    if (engaged === 'play' && g?.kind === 'play') this.auth.meter('fun', G.playPerMin * e / 60, 'play', t);
    if (engaged === 'thumb') this.auth.meter('fun', G.thumbPerMin * e / 60, 'thumb', t);
    if (engaged === 'work') this.auth.meter('expression', G.workPerMin * e / 60, 'work', t);
    const company = engaged === 'company' ? (g?.target === 'julia' ? 'julia' : 'visitor') : null;
    this.auth.lift(liftStep(this.record.lift, e, company, T), 'drift', t);
    updateLines(m, this.flags, T, this.rows);
    this.pile.expire(t);
    this.wants.expire(t, this.rest.asleep);
    this.know.age(e / 86400, t, this._kept());
    this._conditions(t);
    const at = this.world.at, resting = g?.kind === 'rest' && at.kind === 'den' && !!at.settled, before = this.rest.state;
    if (resting && !g.settled) { g.settled = true; this.auth.meter('comfort', T.comfort.settle, 'settle', t, `settle:${g.id}`); }
    this.rest.step(t, {
      resting, willing: !!this.flags.sleepy || !!g?.nap, comfortOk: m.comfort >= T.gates.sleep.comfort,
      energy: m.energy, redLine: !!(this.flags.restNow || this.flags.exhausted), hour: this.clock.wallAt(t).hour,
    });
    if (before === 'active' && this.rest.state === 'awake' && this.goal?.kind === 'rest') this._end('success', t);
    if (before === 'stirring' && this.rest.state === 'awake' && this._pending && !this.goal) this._startPending(t);
    this._mood(t);
    this.word.update(this.pile, t, this.rest.asleep);
    this.skills.age(e);
    if (t - this._pruneAt >= 60) {
      this._pruneAt = t; this.knocks.prune(t); this.auth.prune(t);
      for (const id of this.bouts.ever) if (!this.know.things.has(id)) this.bouts.ever.delete(id);
    }
  }

  _conditions(t) {
    const f = this.flags, P = this.pile, R = this.T.reasons;
    P.setCondition('peckish', !!f.peckish, t, f.foodFirst ? R.peckish.hard : R.peckish.points);
    P.setCondition('sleepy', !!f.sleepy, t, f.restNow || f.exhausted ? R.sleepy.hard : R.sleepy.points);
    P.setCondition('lowComfort', !!f.lowComfort, t);
    P.setCondition('restless', !!(f.restlessStim || f.restlessFun), t);
    P.setCondition('content', !!f.content, t);
    const at = this.world.at;
    P.setCondition('settled', at.kind === 'den' && !!at.settled && this.rest.state !== 'awake', t);
    if (f.project) this.wants.offer([{ kind: 'project', matches: ['arrange', 'improve'], project: true, strength: 1 }], 'project', t);
    if (f.restlessStim) this.wants.offer([{ kind: 'different', matches: ['patrol', 'inspect'], strength: 0.5 }], 'restless', t);
  }

  _mood(t) {
    this.moodNow = readMood(this.pile, { noxiousRecent: t - this.lastNoxious <= this.T.mood.threatNoxious, redLine: pastRedLine(this.flags, this.rows) });
  }

  _woken(t) {
    this.pile.add('wokenFull', 'wake', t);
    this.woken = this.rest.woken; this.rest.woken = null;
    if (this.goal?.kind === 'rest') this._end('woken', t);
    this._mood(t);
  }

  // Choosing
  _candidates(t) {
    const T = this.T, A = T.attract, m = this.record.meters, K = this.know, W = this.world, out = [];
    const threat = this.moodNow.threat, target = this.goal?.target ?? this._pending?.cand?.target ?? null;
    const playOk = m.comfort > T.gates.play.comfort && m.energy > T.gates.play.energy && !threat;
    const seen = new Map();
    for (const s of W.seen) if (s.visible) seen.set(s.id, s);
    for (const th of K.things.values()) {
      if (th.gone || K.cautious(th.id, t)) continue;
      const s = seen.get(th.id);
      if (!s && th.id !== target && t - th.seenAt > MEMORY) continue;
      const k = K.kind(th.kind);
      if (k.props.noxious) continue;
      const dist = s?.dist ?? th.dist, travel = travelFactor(dist, T), unr = unreachableFactor(t - th.unreachableAt, T);
      const inspecting = this.goal?.kind === 'inspect' && this.goal.target === th.id;
      if ((!k.explored && s) || inspecting) {
        const move = clamp01(s?.moving ?? 0), direct = th.novelty * (A.novelty.lo + (A.novelty.hi - A.novelty.lo) * move);
        out.push({ key: `inspect:${th.id}`, kind: 'inspect', family: 'explore', target: th.id, direct, travel, unreachable: unr,
          commit: 'inspect', tier: 'attend', fresh: k.contact === 0 });
      }
      const offer = k.props.edible ? T.offers.food[th.kind] ?? T.offers.food.other : null;
      if (offer) out.push({ key: `eat:${th.id}`, kind: 'eat', family: 'eat', target: th.id, benefits: offer, opinion: k.opinion, travel,
        unreachable: unr, commit: 'manipulate', tier: 'attend', urgency: T.urgency.food, eta: s?.eta ?? (Number.isFinite(dist) ? dist / T.choice.foodSpeed : Infinity) });
      if (k.explored && k.playReady && k.props.movable && !k.props.edible) {
        const r = K.sinceDone(th.id, 'play', t);
        out.push({ key: `play:${th.id}`, kind: 'play', family: 'play', target: th.id, benefits: T.offers.play, opinion: k.opinion, travel,
          effort: s?.effort ?? 1, recency: th.changed ? 1 : recencyFactor(r.since, r.enjoyed, T), gated: !playOk, commit: 'play', tier: 'attend' });
        if (s?.carryable && !s.atDen && K.favorite(th.kind)) {
          out.push({ key: `keep:${th.id}`, kind: 'keep', family: 'keep', target: th.id, benefits: T.offers.keep, direct: Math.min(1, k.opinion),
            travel, commit: 'manipulate', tier: 'held' });
        }
      }
    }
    const den = W.den;
    if (den?.id && den.usable !== false) {
      const at = W.at, settled = at.kind === 'den' && at.den === den.id && !!at.settled;
      const nap = m.comfort > T.gates.nap.comfort && t - this.rest.lastWake >= A.nap.sinceSleep;
      out.push({ key: `rest:${den.id}`, kind: 'rest', family: 'rest', target: den.id, benefits: restBenefits(m, T, { settle: !settled }),
        direct: nap ? A.nap.base + A.nap.warmth * clamp01(den.warmth ?? 0.5) : 0, nap, travel: travelFactor(den.dist, T),
        effort: 1, boost: this.rest.restBoost(t), commit: 'other', tier: 'attend' });
    }
    if (W.shelter?.id) out.push({ key: `shelter:${W.shelter.id}`, kind: 'shelter', family: 'rest', target: W.shelter.id, benefits: shelterBenefits(m, T),
      travel: travelFactor(W.shelter.dist, T), commit: 'other', tier: 'attend' });
    out.push({ key: 'patrol', kind: 'patrol', family: 'explore', target: null, benefits: T.offers.patrol, travel: travelFactor(W.patrol, T), commit: 'other', tier: 'attend' });
    const freshWork = t - this.lastResult >= T.gains.resultEvery;
    for (const p of W.projects) {
      if (typeof p?.id !== 'string' || !(p.pieces ?? []).every((id) => { const th = K.things.get(id); return th && !th.gone && K.kind(th.kind).explored; })) continue;
      const r = K.sinceDone(p.id, 'arrange', t);
      out.push({ key: `create:${p.id}`, kind: freshWork ? 'arrange' : 'improve', family: 'create', target: p.id,
        benefits: freshWork ? T.offers.arrange : T.offers.improve, travel: travelFactor(p.dist, T), effort: p.effort ?? 0.85,
        recency: recencyFactor(r.since, r.enjoyed, T), commit: 'create', tier: 'held' });
    }
    const social = this._awakeEnough() && m.comfort > T.gates.company.comfort && m.energy > T.gates.company.energy && !threat;
    if (social && W.julia?.within) {
      out.push({ key: 'company:julia', kind: 'company', family: 'company', target: 'julia', direct: A.company * (1 + this.record.lift),
        opinion: K.kind('julia').opinion, opinionWeight: T.adjust.juliaOpinion, travel: travelFactor(W.julia.dist, T), commit: 'other', tier: 'attend' });
    }
    if (social && W.palm && this._palmAt !== null && t - this._palmAt >= T.lift.palmHold) {
      out.push({ key: 'company:glass', kind: 'company', family: 'company', target: 'glass', direct: A.company * (1 + this.record.lift),
        travel: travelFactor(W.palm.dist, T), commit: 'other', tier: 'attend' });
    }
    out.push({ key: 'aimless', kind: 'aimless', family: 'aimless', target: null, direct: T.choice.aimless, commit: 'other', tier: 'idle' });
    for (const c of out) c.want = c.kind !== 'aimless' && this.wants.matches(c.kind, c.target);
    return out;
  }

  /* The red lines and danger skip the lottery: food first past fullness's hard line (food she can reach in bothUrgentEat
     seconds when energy is urgent too), rest at energy's, shelter from a real alarm. */
  _lane(scored, t) {
    const f = this.flags, T = this.T, pick = (kind) => scored.find((s) => s.cand.kind === kind);
    const rest = pick('rest'), tired = f.exhausted || f.restNow;
    const meals = scored.filter((s) => s.cand.kind === 'eat' && (!tired || s.cand.eta <= T.choice.bothUrgentEat));
    const food = (this.goal?.kind === 'eat' && meals.find((s) => s.key === this.goal.key)) || meals[0];
    if (f.foodFirst && food) return food.key;
    if (f.exhausted && (rest ?? pick('shelter'))) return (rest ?? pick('shelter')).key;
    const g = this.goal?.phase === 'go' && this.selector.goal?.key === this.goal.key ? this.selector.goal : null;
    if (f.restNow && rest && !(g && g.cand.tier === 'held' && t < g.floor)) return rest.key;
    if ((this.moodNow.points.alarmed ?? 0) >= T.mood.threatAlarm) return (pick('shelter') ?? rest)?.key ?? null;
    return null;
  }

  _score(t) {
    const D = this.display, md = { valence: D.valence, arousal: D.arousal, dominance: D.dominance, points: this.moodNow.points };
    const ctx = { meters: this.record.meters, pressures: pressures(this.record.meters, this.flags, this.T, this.rows), mood: md, rhythm: this.clock.rhythmAt(t) };
    this._scored = this._candidates(t).map((c) => {
      const s = scoreCandidate(c, ctx, this.T);
      if (c.boost > 1) s.score *= c.boost;
      return s;
    }).sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
    return this._scored;
  }

  /* Until the body acknowledges the release, only a lane may start a goal (it can take only free arms); the release
     stays requested, marked urgent, and is overdue after releaseMax. */
  _releasing(t) {
    const R = this.release, scored = this._score(t), lane = this._lane(scored, t);
    R.overdue = t - R.since >= this.T.choice.releaseMax;
    if (lane && this.goal?.key !== lane) {
      const e = scored.find((s) => s.key === lane);
      if (this.goal?.phase === 'go') this._end('switched', t, false);
      this._pending = null; R.urgent = true; R.goal.next = lane;
      this.selector.set(e, t, 'lane');
      this._start({ key: e.key, cand: e.cand, score: e.score, why: 'lane' }, t);
    } else if (!this.goal) {
      this.goal = R.goal;
    }
  }

  /* The queued goal, re-read against current evidence: a target gone, eaten, or soured while it waited is never published. */
  _startPending(t) {
    const p = this._pending;
    this._pending = null; this.goal = null;
    const c = p && this._candidates(t).find((x) => x.key === p.key);
    if (c) { this._start({ ...p, cand: c }, t); return; }
    this.selector.clear();
    this.next.review = Math.min(this.next.review, t);
  }

  /* Instances her memory keeps however long unseen: what her goals point at and her projects' pieces. */
  _kept() {
    const keep = new Set([this.goal?.target, this._pending?.cand.target, this.release?.goal.target]);
    for (const p of this.world.projects) for (const id of p?.pieces ?? []) keep.add(id);
    return keep;
  }

  _review(t) {
    if (this.rest.asleep) return;
    if (this.release) { this._releasing(t); return; }
    if (!this.goal) {
      const s = this.rest.state;
      if (this._pending && s !== 'half' && s !== 'stirring') this._startPending(t);
      else if (!this._pending) this.selector.clear();
    }
    const scored = this._score(t);
    const fresh = new Set(scored.filter((s) => s.cand.fresh).map((s) => s.key));
    const cur = this.goal;
    const r = this.selector.review(t, scored, this.rng.draw.next(), { lane: this._lane(scored, t), bypassFloor: fresh, protect: cur?.kind === 'eat' || cur?.why === 'lane' });
    const pick = this.selector.goal;
    if (r.action === 'keep' || r.action === 'none' || !pick) { if (cur && pick?.key === cur.key) cur.score = pick.score; return; }
    if (cur?.key === pick.key) return;
    if (cur) this._end('switched', t, false);
    const next = { key: pick.key, cand: pick.cand, score: pick.score, why: r.why };
    if (cur && cur.tier === 'held' && !this.body.released) {
      this._pending = next; this.goal = { ...cur, phase: 'release', next: pick.key };
      this.release = { id: cur.id, key: cur.key, target: cur.target, goal: this.goal, since: t, overdue: false, urgent: false };
      return;
    }
    const rs = this.rest.state;
    if ((rs === 'half' || rs === 'stirring') && pick.cand.kind !== 'rest') { this._pending = next; this.goal = null; return; }
    this._pending = null;
    this._start(next, t);
  }

  _start(sel, t) {
    const c = sel.cand, T = this.T;
    const urgency = sel.why === 'lane' && c.kind === 'shelter' ? T.urgency.retreat : c.urgency ?? T.urgency.ordinary;
    this.goal = { id: ++this._goalSeq, key: c.key, kind: c.kind, family: c.family, target: c.target ?? null, tier: c.tier ?? 'attend',
      urgency, nap: !!c.nap, commit: c.commit ?? 'other', phase: 'go', since: t, why: sel.why ?? 'choose', score: sel.score, stimPaid: 0, failed: 0, outcome: null };
    this.body.released = this.goal.tier !== 'held';
  }

  /* Closes a goal in progress: a meaningful encounter teaches an opinion, the activity is marked for recency, and a want
     it answered is dropped. A goal in release ends only by the body's acknowledgment. `rechoose` asks for a review at once. */
  _end(how, t, rechoose = true) {
    const g = this.goal;
    if (!g || g.phase !== 'go') return;
    this.goal = null;
    const T = this.T, th = g.target ? this.know.things.get(g.target) : null;
    const long = t - g.since >= (T.choice.floors[g.commit] ?? T.choice.floors[g.kind] ?? T.choice.floors.other);
    if (g.outcome && (th || g.target === 'julia') && (g.kind !== 'play' || long)) {
      const kind = th?.kind ?? g.target, o = encounterOutcome(g.outcome, T), enjoyed = o >= this.know.baseline;
      this.know.encounter(kind, o, kind === 'julia');
      this.know.finished(g.target, g.kind === 'improve' ? 'arrange' : g.kind, t, enjoyed);
      if (g.kind === 'play' && enjoyed) this.pile.add('enjoyedPlay', g.target, t);
    } else if (g.kind === 'play' || g.kind === 'arrange' || g.kind === 'improve') {
      this.know.finished(g.target, g.kind === 'improve' ? 'arrange' : g.kind, t, false);
    }
    if (how === 'success') {
      this.wants.drop(g.kind, g.target);
      if (g.kind === 'keep') {
        this.auth.meter('comfort', T.offers.keep.comfort, 'keep', t, `keep:${g.id}`);
        this.pile.add('keptFavorite', g.target, t);
      }
      if (g.kind === 'company') {
        this.pile.add('company', g.target, t);
        if (g.target === 'glass') this.auth.lift(this.record.lift + T.lift.palm, 'palm', t);
      }
    }
    if (this.selector.goal?.key === g.key) this.selector.clear();
    if (rechoose) this.next.review = Math.min(this.next.review, t);
  }

  /* A copy of the current choice as a readable chain, the two runners-up, the selector's last reason, and any release
     the body hasn't acknowledged (`overdue` once it outlasts releaseMax). */
  explain() {
    const g = this.goal, top = this._scored.find((s) => s.key === g?.key) ?? null, R = this.release;
    return structuredClone({
      release: R && { id: R.id, key: R.key, target: R.target, next: R.goal.next ?? null, since: R.since, overdue: R.overdue, urgent: R.urgent },
      goal: g, chain: top && { opportunity: top.key, benefits: top.parts, tilt: top.tilt, attraction: top.direct, want: top.bonus, adjust: top.adj, score: top.score },
      runnersUp: this._scored.filter((s) => s.key !== g?.key).slice(0, 2).map((s) => ({ key: s.key, score: s.score })),
      why: this.selector.last?.why ?? null, step: { ...this.body }, mood: { ...this.moodNow }, word: this.word.word, rest: this.rest.state,
    });
  }

  /* The mantle's arousal input is activation above its background, scaled to 0–1; effort is her crawling. */
  breath() {
    const bg = this.T.mood.background[1];
    return { arousal: Math.max(0, (this.display.arousal - bg) / (1 - bg)), effort: this.body.crawl };
  }
}
