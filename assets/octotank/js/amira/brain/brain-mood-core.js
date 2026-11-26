import { FAMILIES } from './brain-tuning-core.js';

/* Moodlets and the mood read off them. A moodlet is a reason with a source, points, and an ending; a condition holds
   while its condition does; mood is never stored, only read from the pile. */

const soften = (x) => x / (1 + Math.abs(x));
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export class MoodPile {
  constructor(T) {
    this.T = T;
    this.items = new Map();   // key `${reason}|${source}` → moodlet
  }

  /* The same reason and source refreshes at most once per refreshEvery, as a replacement with a new expiry, never an
     extension. Returns the moodlet that stands, null for an unknown reason. */
  add(reason, source, now, { points = null } = {}) {
    const R = this.T.reasons[reason];
    if (!R || R.condition) return null;
    const key = `${reason}|${source ?? ''}`, old = this.items.get(key);
    if (old && now - old.start < this.T.mood.refreshEvery) return old;
    const p = Number.isFinite(points) ? Math.max(0, points) : R.points;
    const m = this._make(R, reason, source, now, now + R.life, p);
    this.items.set(key, m);
    return m;
  }

  /* A condition reason is on or off as its condition is; points may change with it (peckish past the hard line). */
  setCondition(reason, on, now, points = null, source = '') {
    const R = this.T.reasons[reason], key = `${reason}|${source}`;
    if (!R) return;
    if (!on) { this.items.delete(key); return; }
    const p = points ?? R.points, old = this.items.get(key);
    if (old) { old.points = p; return; }
    this.items.set(key, this._make(R, reason, source, now, Infinity, p));
  }

  _make(R, reason, source, start, expires, points) {
    return { reason, source: source ?? '', family: R.family, points, start, expires, word: R.word, bold: !!R.bold,
      flavor: R.flavor ?? null, scope: R.scope ?? 'shared', condition: !!R.condition };
  }

  has(reason, source = null) {
    if (source !== null) return this.items.has(`${reason}|${source}`);
    for (const m of this.items.values()) if (m.reason === reason) return true;
    return false;
  }

  /* Drops every event whose original expiry has passed, however long the gap since the last look. */
  expire(now) {
    let n = 0;
    for (const [k, m] of this.items) if (m.expires <= now) { this.items.delete(k); n++; }
    return n;
  }

  clearLocal() { for (const [k, m] of this.items) if (m.scope === 'local') this.items.delete(k); }

  /* Per family, the strongest source at full and the second at half, capped; ties by key so order never matters. */
  sources() {
    const T = this.T.mood, by = {};
    for (const [key, m] of this.items) (by[m.family] ??= []).push({ key, m });
    const out = [];
    for (const f of FAMILIES) {
      const list = by[f];
      if (!list) continue;
      list.sort((a, b) => b.m.points - a.m.points || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const top = list.slice(0, 2).map((e, i) => ({ m: e.m, w: e.m.points * (i ? T.secondShare : 1) }));
      const total = top.reduce((s, e) => s + e.w, 0), scale = total > T.familyCap ? T.familyCap / total : 1;
      for (const e of top) out.push({ m: e.m, w: e.w * scale });
    }
    return out;
  }
}

/* The reading off the pile: valence and dominance −1–1, arousal 0–1, plus each family's effective points. A genuine
   threat (alarmed at threatAlarm points, or `noxiousRecent`) cuts positive pleasantness; a red-line meter deepens the negative. */
export function readMood(pile, { noxiousRecent = false, redLine = false } = {}, T = pile.T) {
  const M = T.mood, points = {};
  const src = pile.sources();
  for (const { m, w } of src) points[m.family] = (points[m.family] ?? 0) + w;
  const threat = noxiousRecent || (points.alarmed ?? 0) >= M.threatAlarm;
  let V = 0, A = 0, D = 0;
  for (const { m, w } of src) {
    const d = M.dirs[m.family], need = m.flavor ? M.needWeight : 1;
    let v = d[0] * w * need;
    if (v > 0 && threat) v *= M.threatPositive;
    if (v < 0 && redLine) v *= M.redLineNegative;
    V += v;
    A += (m.flavor === 'sleepy' ? M.sleepyArousal : d[1]) * w * need;
    D += d[2] * w * need + (m.bold ? M.bold * w : 0);
  }
  const [bv, ba, bd] = M.background;
  return {
    valence: clamp(bv + soften(V), -1, 1), arousal: clamp(ba + soften(A), 0, 1), dominance: clamp(bd + soften(D), -1, 1),
    points, threat,
  };
}

/* The displayed reading approaches the computed one: arousal settles settleShare of the way in settleArousal seconds,
   valence and dominance in settleOther. It is local and never makes a moodlet. */
export class MoodDisplay {
  constructor(T) {
    const M = T.mood, k = -Math.log(1 - M.settleShare);
    this.tauA = M.settleArousal / k; this.tauO = M.settleOther / k;
    [this.valence, this.arousal, this.dominance] = M.background;
    this.points = {}; this.threat = false;
  }

  step(target, dt) {
    const a = dt > 0 ? 1 - Math.exp(-dt / this.tauA) : 0, o = dt > 0 ? 1 - Math.exp(-dt / this.tauO) : 0;
    this.arousal += (target.arousal - this.arousal) * a;
    this.valence += (target.valence - this.valence) * o;
    this.dominance += (target.dominance - this.dominance) * o;
    this.points = target.points; this.threat = target.threat;
    return this;
  }

  snap(target) { this.valence = target.valence; this.arousal = target.arousal; this.dominance = target.dominance; this.points = target.points; this.threat = target.threat; return this; }
}

const lerpTilt = (up, s) => 1 + (up - 1) * clamp(s, 0, 1);

/* Mood's multiplier on a want family, before the daily rhythm. Family-driven tilts use effective points over the cap;
   pleasantness and dominance use the reading itself; drowsiness is how far arousal sits under its background. */
export function moodTilt(family, md, T) {
  const t = T.tilt, cap = T.mood.familyCap, p = md.points ?? {}, frac = (f) => Math.min(1, (p[f] ?? 0) / cap);
  let x = 1;
  switch (family) {
    case 'explore': x = lerpTilt(t.explore.up, frac('interested')) * lerpTilt(t.explore.down, frac('alarmed')); break;
    case 'play': x = md.valence >= 0 ? lerpTilt(t.play.up, md.valence) : lerpTilt(t.play.down, -md.valence); break;
    case 'create': x = lerpTilt(t.create.up, frac('inspired') + Math.max(0, md.dominance)) * lerpTilt(t.create.down, frac('alarmed')); break;
    case 'rest': {
      const bg = T.mood.background[1], drowsy = Math.max(0, bg - md.arousal) / bg;
      x = lerpTilt(t.rest.up, Math.max(drowsy, Math.min(1, ((p.uncomfortable ?? 0) + (p.alarmed ?? 0)) / cap)));
      break;
    }
    case 'display': x = md.dominance > 0 ? lerpTilt(t.display.up, frac('frustrated')) : 1; break;
    case 'company': x = lerpTilt(t.company.up, Math.max(0, md.valence)); break;
    case 'eat': return clamp(1, t.eat.lo, t.eat.hi);
    default: return 1;
  }
  return clamp(x, t.clamp[0], t.clamp[1]);
}

/* The caption: the strongest single source at `min` points or more, kept until a challenger leads by `lead` for
   `leadFor` seconds; a word whose reasons have ended gives way at once. */
export class MoodWord {
  constructor(T) { this.T = T; this.word = 'quietly alert'; this._rival = null; this._since = 0; }

  update(pile, now, asleep = false) {
    const W = this.T.mood.word;
    if (asleep) { this.word = 'asleep'; this._rival = null; return this.word; }
    let best = null, held = 0;
    for (const [key, m] of pile.items) {
      if (m.points < W.min) continue;
      if (!best || m.points > best.m.points || (m.points === best.m.points && key < best.key)) best = { key, m };
      if (m.word === this.word && m.points > held) held = m.points;
    }
    const word = best ? best.m.word : 'quietly alert';
    if (word === this.word) { this._rival = null; return word; }
    if (!held || !best) { this.word = word; this._rival = null; return word; }
    if (best.m.points - held < W.lead) { this._rival = null; return this.word; }
    if (this._rival !== word) { this._rival = word; this._since = now; }
    if (now - this._since >= W.leadFor) { this.word = word; this._rival = null; }
    return this.word;
  }
}
