import { learnOpinion, nextBaseline, forget } from './brain-learning-core.js';

/* What she knows, kept per kind (one Crunchsnack learned is every Crunchsnack), and each physical thing's own state.
   A kind starts unknown unless instinct covers it; properties are revealed only by observations that establish them. */

const MAX_THINGS = 256, MAX_KINDS = 128;   // a bound against a host that names without end

export class Knowledge {
  constructor(T) {
    this.T = T;
    this.kinds = new Map();
    this.things = new Map();
    this.baseline = T.learn.baseline;
    this.cautions = new Map();   // thing → time its caution margin lapses
    this.done = new Map();       // `${target}|${activity}` → { at, enjoyed }
  }

  kind(id) {
    let k = this.kinds.get(id);
    if (!k) {
      const I = this.T.instinct, food = I.food.includes(id), shelter = I.shelter.includes(id), known = food || shelter || I.surfaces.includes(id);
      k = { id, explored: known, instinct: known, props: { edible: food, noxious: false, movable: false, shelter },
        obs: new Set(), contact: 0, contacts: 0, playReady: false, early: false,
        opinion: 0, expectation: this.baseline, encounters: 0, lastHandled: -Infinity, seenAt: -Infinity, actions: {} };
      this.kinds.set(id, k);
    }
    return k;
  }

  /* `first`: this thing was never seen before. */
  see(now, e) {
    let t = this.things.get(e.id);
    const first = !t;
    if (!t) {
      t = { id: e.id, kind: e.kind, pos: null, dist: null, seenAt: now, firstSeen: now, changed: false, unreachableAt: -Infinity,
        novelty: 1, gone: false, looked: false, comfortAt: -Infinity, touchedAt: -Infinity, atDen: false };
      this.things.set(e.id, t);
      this.kind(e.kind);
    }
    if (e.pos) t.pos = [e.pos[0], e.pos[1], e.pos[2]];
    if (Number.isFinite(e.dist)) t.dist = e.dist;
    t.seenAt = now; t.gone = false; t.changed = !!e.changed; t.atDen = !!e.atDen;
    this.kind(t.kind).seenAt = now;
    return { thing: t, first };
  }

  forgetThing(id) { const t = this.things.get(id); if (t) t.gone = true; this.cautions.delete(id); }

  /* One observation of a kind: 'look', 'taste', 'push', 'move', or 'feature', with what it showed. Taste settles food
   and noxiousness at once; the rest wait for `contact` seconds of handling and `observations` distinct kinds. */
  observe(kindId, type, value = null) {
    const k = this.kind(kindId), p = k.props;
    k.obs.add(type);
    if (type === 'taste') { if (value === 'food') p.edible = true; if (value === 'noxious') p.noxious = true; }
    if ((type === 'push' || type === 'move') && value) p.movable = true;
    return this._reveal(k);
  }

  handle(kindId, dt, now) { const k = this.kind(kindId); k.contact += dt; k.lastHandled = now; return this._reveal(k); }

  bout(kindId) { const k = this.kind(kindId); k.contacts++; return this._reveal(k); }

  _reveal(k) {
    const I = this.T.inspect;
    let fresh = false;
    if (!k.explored && k.contact >= I.contact && k.obs.size >= I.observations) { k.explored = true; fresh = true; }
    if (k.explored && !k.playReady && k.contact >= I.playContact && k.contacts >= I.playContacts) k.playReady = true;
    return fresh;
  }

  /* The bold early-play roll, once per kind after its first inspection; `u` in [0, 1). */
  rollEarly(kindId, u) {
    const k = this.kind(kindId);
    if (k.early || !k.explored) return false;
    k.early = true;
    if (u < this.T.inspect.earlyPlay) { k.playReady = true; return true; }
    return false;
  }

  /* A meaningful encounter's outcome moves the kind's opinion on surprise and nudges her baseline. */
  encounter(kindId, outcome, julia = false) {
    const k = this.kind(kindId), before = k.opinion;
    if (!Number.isFinite(outcome)) return { before, after: before, surprise: 0 };
    const r = learnOpinion(k, outcome, this.T, julia);
    k.opinion = r.opinion; k.expectation = r.expectation; k.encounters++;
    this.baseline = nextBaseline(this.baseline, outcome, this.T);
    return { before, after: k.opinion, surprise: r.surprise };
  }

  /* Opinions and expectations soften toward neutral and the baseline over `days`; recency marks past a day lapse, and so
     does a thing unseen and untouched for a day unless it is at her den or in `keep`. Past the caps the stalest go first. */
  age(days, now, keep = null) {
    if (!(days > 0)) return;
    for (const k of this.kinds.values()) Object.assign(k, forget(k, days, this.baseline, this.T));
    if (!Number.isFinite(now)) return;
    for (const [key, d] of this.done) if (now - d.at > 86400) this.done.delete(key);
    for (const [id, u] of this.cautions) if (u <= now) this.cautions.delete(id);
    const kept = (t) => keep?.has(t.id) || (t.atDen && !t.gone);
    const last = (t) => Math.max(t.seenAt, t.touchedAt ?? -Infinity);
    for (const [id, t] of this.things) if (now - last(t) > 86400 && !kept(t)) this.things.delete(id);
    if (this.things.size > MAX_THINGS) {
      const old = [...this.things.values()].sort((a, b) => kept(a) - kept(b) || last(a) - last(b));
      for (const t of old.slice(0, this.things.size - MAX_THINGS)) this.things.delete(t.id);
    }
    if (this.kinds.size > MAX_KINDS) {
      const used = new Set(['julia']);
      for (const t of this.things.values()) used.add(t.kind);
      const old = [...this.kinds.values()].filter((k) => !k.instinct && !used.has(k.id)).sort((a, b) => a.seenAt - b.seenAt);
      for (const k of old.slice(0, this.kinds.size - MAX_KINDS)) this.kinds.delete(k.id);
    }
  }

  finished(target, activity, now, enjoyed) { this.done.set(`${target}|${activity}`, { at: now, enjoyed }); }

  sinceDone(target, activity, now) {
    const d = this.done.get(`${target}|${activity}`);
    return d ? { since: now - d.at, enjoyed: d.enjoyed } : { since: Infinity, enjoyed: false };
  }

  caution(thingId, now) { this.cautions.set(thingId, now + this.T.noxious.caution); }

  cautious(thingId, now) { const u = this.cautions.get(thingId); if (u !== undefined && u <= now) this.cautions.delete(thingId); return u > now; }

  /* At the keeping line, after enough encounters. */
  favorite(kindId) {
    const k = this.kinds.get(kindId), K = this.T.attract.keep;
    return !!k && k.opinion >= K.favorite && k.encounters >= K.encounters;
  }
}
