/* What reaches her attention: the arms' taste log read once per entry, simultaneous touches merged into touch bouts,
   the look spotlight, and knocks with their habituation. Things are named by string ids at this boundary. */

export class TasteReader {
  constructor() { this.seq = 0; this.gaps = 0; this.generation = undefined; }

  /* Unread entries in seq order, each once; only a new `generation` (a producer restarting its numbering) moves the
     cursor back. `gap` when the log wrapped past unread entries, which are never invented back. */
  read(log, generation) {
    const out = { fresh: [], gap: false };
    if (generation !== undefined && generation !== this.generation) {
      if (this.generation !== undefined) this.seq = 0;
      this.generation = generation;
    }
    if (!Array.isArray(log) || !log.length) return out;
    const seen = new Set();
    for (const e of log) {
      const s = e?.seq;
      if (!Number.isInteger(s) || s <= this.seq || seen.has(s)) continue;
      seen.add(s); out.fresh.push(e);
    }
    if (!out.fresh.length) return out;
    out.fresh.sort((a, b) => a.seq - b.seq);
    out.gap = this.seq > 0 && out.fresh[0].seq > this.seq + 1;
    if (out.gap) this.gaps++;
    this.seq = out.fresh[out.fresh.length - 1].seq;
    return out;
  }
}

/* One bout per thing however many suckers and arms touch it: a fresh touch opens it, contact keeps it, and boutGap
   without contact closes it. A contact recovered after a wrapped log continues a bout but opens none. */
export class TouchBouts {
  constructor(T) { this.T = T; this.open = new Map(); this.ever = new Set(); }

  update(now, dt, fresh, contacts, events) {
    for (const e of fresh) {
      let b = this.open.get(e.thing);
      if (!b) {
        b = { thing: e.thing, kind: e.kind, taste: e.taste, arms: new Set(), opened: now, last: now, handling: 0, novelty: e.novelty ?? 1, recovered: false };
        this.open.set(e.thing, b);
        events.push({ type: 'open', bout: b, first: !this.ever.has(e.thing), entry: e });
        this.ever.add(e.thing);
      }
      b.arms.add(e.arm); b.last = now; b.novelty = e.novelty ?? b.novelty;
    }
    const held = new Set();
    for (const c of contacts ?? []) {
      let b = this.open.get(c.thing);
      if (!b) {
        b = { thing: c.thing, kind: c.kind, taste: c.taste, arms: new Set(), opened: now, last: now, handling: 0, novelty: c.novelty ?? 1, recovered: true };
        this.open.set(c.thing, b);
      }
      b.arms.add(c.arm); b.last = now; b.novelty = c.novelty ?? b.novelty;
      held.add(c.thing);
    }
    for (const thing of held) {
      const b = this.open.get(thing);
      b.handling += dt;
      events.push({ type: 'hold', bout: b, dt });
    }
    for (const [thing, b] of this.open) {
      if (now - b.last >= this.T.touch.boutGap) { this.open.delete(thing); events.push({ type: 'close', bout: b }); }
    }
    return events;
  }

  /* The touch line for an investigation want: the taste's weight times (¼ + ¾ novelty), without the arm's state. */
  pull(taste, novelty) {
    const w = this.T.touch.weights[taste] ?? this.T.touch.weights.toy;
    return w * (0.25 + 0.75 * Math.max(0, Math.min(1, novelty)));
  }
}

/* Never seen 3, moved 2, unchanged 1, times up to moveMax for brisk motion; past fadeFrom the weight falls to
   fadeShare at fadeTo and stays there, and nothing hidden counts. */
export function lookWeight(t, A) {
  if (!t.visible) return 0;
  const base = t.seenBefore ? (t.changed ? A.weights.moved : A.weights.familiar) : A.weights.new;
  const d = Number.isFinite(t.dist) ? t.dist : 0, mv = Number.isFinite(t.moving) ? Math.max(0, Math.min(1, t.moving)) : 0;
  const f = d <= A.fadeFrom ? 1 : d >= A.fadeTo ? A.fadeShare : 1 - (1 - A.fadeShare) * (d - A.fadeFrom) / (A.fadeTo - A.fadeFrom);
  const w = base * (1 + (A.moveMax - 1) * mv) * f;
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/* Holds a look at least `hold` s unless something urgent comes, follows the goal's target, and otherwise draws among
   what she sees by look weight. */
export class Spotlight {
  constructor(T) { this.A = T.attention; this.look = null; this.since = -Infinity; this.urgent = false; }

  review(now, seen, { target = null, urgent = null } = {}, u = 0) {
    if (urgent) { this._set(urgent, now, true); return this.look; }
    if (now - this.since < this.A.hold && this.look !== null) return this.look;
    if (target !== null && seen.some((t) => t.id === target && t.visible)) { this._set(target, now, false); return this.look; }
    let total = 0;
    for (const t of seen) total += lookWeight(t, this.A);
    if (!(total > 0)) { this._set(null, now, false); return null; }
    let r = u * total;
    for (const t of seen) { r -= lookWeight(t, this.A); if (r < 0) { this._set(t.id, now, false); return this.look; } }
    this._set(seen[seen.length - 1].id, now, false);
    return this.look;
  }

  _set(id, now, urgent) { if (id !== this.look || urgent) this.since = now; this.look = id; this.urgent = urgent; }
}

/* Knocks per visitor: successive ones scale by e^(−habituation × n), with n a count that recovers by half every
   `recovery` seconds; `storm` knocks within stormWithin make a knock storm, counted at most once per stormEvery. */
export class KnockSense {
  constructor(T) { this.K = T.knock; this.visitors = new Map(); this.losses = []; }

  knock(now, visitor = 'visitor', jaded = 0) {
    const K = this.K;
    let v = this.visitors.get(visitor);
    if (!v) { v = { n: 0, at: now, times: [], storm: -Infinity }; this.visitors.set(visitor, v); }
    v.n *= Math.pow(0.5, Math.max(0, now - v.at) / K.recovery); v.at = now;
    const wake = K.first * Math.exp(-K.habituation * v.n);
    v.n += 1;
    v.times.push(now);
    while (v.times.length && now - v.times[0] > K.stormWithin) v.times.shift();
    const storm = v.times.length >= K.storm && now - v.storm >= K.stormEvery;
    if (storm) v.storm = now;
    return { wake, strength: wake * (1 - K.jadedMax * Math.max(0, Math.min(1, jaded))), first: v.n <= 1, storm };
  }

  /* The part of a wanted comfort loss knocks may take inside the rolling comfortWindow. */
  allow(now, want) {
    const K = this.K;
    while (this.losses.length && now - this.losses[0][0] >= K.comfortWindow) this.losses.shift();
    let spent = 0;
    for (const [, x] of this.losses) spent += x;
    const take = Math.max(0, Math.min(want, K.comfortCap - spent));
    if (take > 0) this.losses.push([now, take]);
    return take;
  }

  /* Visitors gone quiet for a day drop out, so the map can't grow without bound. */
  prune(now) { for (const [id, v] of this.visitors) if (now - v.at > 86400) this.visitors.delete(id); }
}
