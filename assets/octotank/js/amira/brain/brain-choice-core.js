import { moodTilt } from './brain-mood-core.js';
import { claimWins } from '../locomotion/loco-carry-core.js';

/* A candidate: { key, kind, family, target, benefits: { meter: amount }, direct, want, opinion, opinionWeight, travel,
   effort, recency, unreachable, gated, commit, tier }; every adjustment defaults to 1. */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (x, d) => (Number.isFinite(x) ? x : d);

export const usable = (benefit, value) => Math.max(0, Math.min(benefit, 1 - value));

export function travelFactor(meters, T) {
  return Math.max(T.adjust.travelMin, 1 - T.adjust.travelPerMeter * Math.max(0, num(meters, 0)));
}

/* 1 when never done; the last window applies only to something she enjoyed. */
export function recencyFactor(since, enjoyed, T) {
  if (!(since >= 0) || since === Infinity) return 1;
  const R = T.adjust.recency;
  for (let i = 0; i < R.length; i++) if (since < R[i][0]) return i === R.length - 1 && !enjoyed ? 1 : R[i][1];
  return 1;
}

/* Curled for restCurl, then half-sleep, over the horizon; comfort toward `target`, with the settling bonus unless she
   is already settled. */
export function restBenefits(m, T, { target = T.comfort.targets.den, settle = true } = {}) {
  const H = T.horizon, curl = Math.min(T.offers.restCurl, H), E = T.energy;
  const energy = (E.curled * curl + E.half * Math.max(0, H - curl)) / 60;
  const c0 = m.comfort + (settle ? T.comfort.settle : 0);
  const c1 = target - (target - c0) * Math.pow(0.5, H / T.comfort.halfLife);
  return { energy, comfort: Math.max(0, Math.min(c1, 1) - m.comfort) };
}

export function shelterBenefits(m, T) {
  const t = T.comfort.targets.shelter;
  return { comfort: Math.max(0, t - (t - m.comfort) * Math.pow(0.5, T.horizon / T.comfort.halfLife) - m.comfort) };
}

export function unreachableFactor(since, T) {
  if (!(since >= 0)) return 1;
  for (const [upTo, f] of T.adjust.unreachable) if (since < upTo) return f;
  return 1;
}

/* (scale × Σ usable × pressure + direct) × tilt, plus the want bonus, times the adjustments. ctx: meters, pressures,
   mood (a reading with points), rhythm ({ family: × }). Returns the score and every part, for the explanation chain. */
export function scoreCandidate(c, ctx, T) {
  const m = ctx.meters, P = ctx.pressures, ben = c.benefits ?? {}, parts = {};
  let base = 0;
  for (const k in ben) {
    const u = usable(num(ben[k], 0), m[k]);
    parts[k] = [u, P[k]];
    base += u * P[k];
  }
  const tilt = c.family === 'aimless' ? 1 : moodTilt(c.family, ctx.mood, T) * (ctx.rhythm?.[c.family] ?? 1);
  const bonus = c.want ? T.choice.wantBonus : 0;
  const adj = (1 + num(c.opinionWeight, T.adjust.opinion) * clamp(num(c.opinion, 0), -1, 1))
    * clamp(num(c.travel, 1), 0, 1) * Math.max(T.adjust.effortMin, Math.min(1, num(c.effort, 1)))
    * Math.max(0, num(c.recency, 1)) * Math.max(0, num(c.unreachable, 1)) * (c.gated ? T.adjust.gatedPlay : 1);
  const meterPart = T.choice.scale * base * tilt, direct = num(c.direct, 0) * tilt;
  const score = (meterPart + direct + bonus) * adj;
  return { key: c.key, cand: c, score: Number.isFinite(score) ? score : 0, parts, meterPart, direct, bonus, tilt, adj };
}

const byScore = (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/* The best `pool` whose score is at least `cutoff` of the best, drawn with odds ∝ score^power; u in [0, 1). */
export function drawTopThree(scored, u, T) {
  const C = T.choice, live = scored.filter((s) => s.score > 0).sort(byScore);
  if (!live.length) return { pick: null, pool: [] };
  const best = live[0].score, pool = live.filter((s) => s.score >= best * C.cutoff).slice(0, C.pool);
  let total = 0;
  for (const s of pool) total += s.score ** C.power;
  const out = pool.map((s) => ({ key: s.key, score: s.score, odds: s.score ** C.power / total }));
  let r = clamp(num(u, 0), 0, 1 - 1e-12) * total, pick = pool[pool.length - 1];
  for (const s of pool) { r -= s.score ** C.power; if (r < 0) { pick = s; break; } }
  return { pick, pool: out };
}

/* A stronger owner always keeps its arm. */
export function armsFor(owners, arms, tier) {
  return arms.filter((a) => claimWins(owners[a] ?? 'idle', tier));
}

/* A goal keeps its floor, then one rival must beat it by switchMargin on switchReviews reviews in a row. `lane` forces
   a goal at once; `bypassFloor` keys (never-seen things) may cut the floor short unless the goal is `protect`ed. */
export class Selector {
  constructor(T) { this.T = T; this.goal = null; this.streaks = new Map(); this.last = null; }

  floorOf(c) { const F = this.T.choice.floors; return F[c.commit ?? c.kind] ?? F.other; }

  set(entry, now, why) {
    this.goal = { key: entry.key, cand: entry.cand, score: entry.score, since: now, floor: now + this.floorOf(entry.cand), why };
    this.streaks.clear();
    return this.goal;
  }

  clear() { this.goal = null; this.streaks.clear(); }

  review(now, scored, u, { lane = null, bypassFloor = null, protect = false } = {}) {
    const g = this.goal, find = (k) => scored.find((s) => s.key === k);
    if (lane) {
      if (g?.key === lane) { g.score = find(lane)?.score ?? g.score; return this._out('keep', 'lane'); }
      const e = find(lane);
      if (e) { this.set(e, now, 'lane'); return this._out('switch', 'lane', [{ key: e.key, score: e.score, odds: 1 }]); }
    }
    const cur = g && find(g.key);
    if (!cur) {
      const d = drawTopThree(scored, u, this.T);
      if (!d.pick) { this.clear(); return this._out('none', 'empty'); }
      this.set(d.pick, now, g ? 'gone' : 'choose');
      return this._out(g ? 'switch' : 'choose', this.goal.why, d.pool);
    }
    g.score = cur.score;
    const need = Math.max(0, cur.score) * (1 + this.T.choice.switchMargin);
    let rivals = scored.filter((s) => s.key !== g.key && s.score > need);
    const early = now < g.floor;
    if (early) rivals = protect ? [] : rivals.filter((s) => bypassFloor?.has(s.key));
    const runs = new Map();
    for (const s of rivals) runs.set(s.key, (this.streaks.get(s.key) ?? 0) + 1);
    this.streaks = runs;
    if (!rivals.length) return this._out('keep', early ? 'floor' : 'holds');
    const ready = rivals.filter((s) => runs.get(s.key) >= this.T.choice.switchReviews);
    if (!ready.length) return this._out('keep', 'margin');
    const d = drawTopThree(ready, u, this.T);
    if (!d.pick) return this._out('keep', 'holds');
    this.set(d.pick, now, 'beaten');
    return this._out('switch', 'beaten', d.pool);
  }

  _out(action, why, pool = null) { this.last = { action, why, pool, goal: this.goal }; return this.last; }
}

/* Each lasts `life` (a project `projectLife`) unless it succeeds, its thing goes, or she falls fully asleep; one event
   offers perEvent at most, and one source refills once per `refill`. */
export class Wants {
  constructor(T) { this.T = T; this.list = []; this._fed = new Map(); }

  offer(items, source, now) {
    const W = this.T.wants;
    if (now - (this._fed.get(source) ?? -Infinity) < W.refill) return 0;
    let n = 0;
    for (const it of items.slice(0, W.perEvent)) {
      const key = `${it.kind}:${it.target ?? ''}`;
      if (this.list.some((w) => w.key === key)) continue;
      const w = { key, kind: it.kind, target: it.target ?? null, matches: it.matches ?? [it.kind], strength: it.strength ?? 1,
        project: !!it.project, source, born: now, expires: now + (it.project ? W.projectLife : W.life) };
      if (this.list.length >= W.max) {
        let weak = 0;
        for (let i = 1; i < this.list.length; i++) {
          const a = this.list[i], b = this.list[weak];
          if (a.strength < b.strength || (a.strength === b.strength && a.born < b.born)) weak = i;
        }
        if (this.list[weak].strength > w.strength) continue;
        this.list.splice(weak, 1);
      }
      this.list.push(w);
      n++;
    }
    if (n) this._fed.set(source, now);
    return n;
  }

  expire(now, fullSleep = false) {
    for (const [src, at] of this._fed) if (now - at >= this.T.wants.refill) this._fed.delete(src);
    this.list = fullSleep ? this.list.filter((w) => w.project && w.expires > now) : this.list.filter((w) => w.expires > now);
  }

  matches(kind, target) { return this.list.some((w) => w.matches.includes(kind) && (w.target === null || w.target === target)); }

  /* A want that succeeded, or whose thing is gone. */
  drop(kind, target) { this.list = this.list.filter((w) => !(w.matches.includes(kind) && (w.target === null || w.target === target))); }

  dropTarget(target) { this.list = this.list.filter((w) => w.target !== target); }
}
