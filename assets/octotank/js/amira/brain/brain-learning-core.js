/* Learning bookkeeping: opinions that move on surprise, their slow forgetting, and tactic skill as two bounded
   tallies chosen between by Thompson sampling. Pure functions and one small class; nothing here reads a clock. */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const part = (x) => (Number.isFinite(+x) ? clamp(+x, 0, 1) : 0);

/* One meaningful encounter judged alone, −1–1. Each part is 0–1: varied play or a satisfying discovery, a completed
   intended result (true or 1), repeated obstruction, noxious discomfort. A part that isn't a number counts as 0. */
export function encounterOutcome({ varied = 0, completed = 0, obstruction = 0, noxious = 0 } = {}, T) {
  const L = T.learn;
  return clamp(L.varied * part(varied) + L.completed * part(completed) - L.obstruction * part(obstruction) - L.noxious * part(noxious), -1, 1);
}

/* The outcome's valid parts clamped 0–1, or null when none is a number, so a malformed report teaches nothing. */
export function cleanOutcome(o) {
  if (!o || typeof o !== 'object') return null;
  let out = null;
  for (const k of ['varied', 'completed', 'obstruction', 'noxious']) if (k in o && Number.isFinite(+o[k])) (out ??= {})[k] = clamp(+o[k], 0, 1);
  return out;
}

/* Opinion moves by `step` of the surprise (outcome − expectation), at most `cap`; the expectation moves `expect` of the
   way to the outcome. Julia's opinion takes the whole surprise up to juliaCap. Returns the new pair and the surprise. */
export function learnOpinion({ opinion = 0, expectation }, outcome, T, julia = false) {
  const L = T.learn, step = julia ? L.juliaStep : L.step, cap = julia ? L.juliaCap : L.cap;
  const e = Number.isFinite(expectation) ? expectation : L.baseline, o = clamp(outcome, -1, 1), surprise = o - e;
  return {
    opinion: clamp(opinion + clamp(step * surprise, -cap, cap), -1, 1),
    expectation: e + L.expect * (o - e),
    surprise,
  };
}

/* Her baseline, the slow average every kind's expectation starts from. */
export const nextBaseline = (baseline, outcome, T) => baseline + T.learn.baselineRate * (clamp(outcome, -1, 1) - baseline);

/* Over `days`, opinion drifts decayPerDay toward neutral and the expectation as much back toward the baseline. */
export function forget({ opinion, expectation }, days, baseline, T) {
  const k = Math.pow(1 - T.learn.decayPerDay, Math.max(0, days));
  return { opinion: opinion * k, expectation: baseline + (expectation - baseline) * k };
}

/* Standard normal and gamma (Marsaglia–Tsang, shape ≥ 1) from a uniform source `u` in [0, 1). */
function normal(u) {
  const a = Math.max(1e-12, u()), b = u();
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

function gamma(shape, u) {
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    let x, v;
    do { x = normal(u); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const w = Math.max(1e-12, u());
    if (w < 1 - 0.0331 * x ** 4 || Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}

export const betaDraw = (a, b, u) => { const x = gamma(a, u), y = gamma(b, u); return x / (x + y); };

/* Per mechanism and tactic, favorable and unfavorable tallies from 1 and 1. Evidence above that pair is capped at
   skillCap (both sides scaled together) and halves every skillHalfLife seconds. */
export class SkillBook {
  constructor(T) { this.T = T; this.m = new Map(); }

  get(mech, tactic) {
    const key = `${mech}|${tactic}`;
    let s = this.m.get(key);
    if (!s) { s = { good: 1, bad: 1 }; this.m.set(key, s); }
    return s;
  }

  /* The tactic whose drawn success estimate is highest; ties keep the earlier tactic in `tactics`. */
  choose(mech, tactics, u) {
    let best = null, top = -1;
    for (const t of tactics) {
      const s = this.get(mech, t), x = betaDraw(s.good, s.bad, u);
      if (x > top) { top = x; best = t; }
    }
    return best;
  }

  add(mech, tactic, good = 0, bad = 0) {
    const s = this.get(mech, tactic);
    s.good += clamp(good, 0, 1); s.bad += clamp(bad, 0, 1);
    const over = s.good + s.bad - 2, cap = this.T.learn.skillCap;
    if (over > cap) { const k = cap / over; s.good = 1 + (s.good - 1) * k; s.bad = 1 + (s.bad - 1) * k; }
    return s;
  }

  age(seconds) {
    const k = Math.pow(0.5, Math.max(0, seconds) / this.T.learn.skillHalfLife);
    for (const s of this.m.values()) { s.good = 1 + (s.good - 1) * k; s.bad = 1 + (s.bad - 1) * k; }
  }

  /* A late reward shared back along the episode's last `trail` tactic choices, newest weight 1, then ×trailDecay each
     step back, normalized to `amount`. */
  credit(trail, amount = 1) {
    const L = this.T.learn, last = trail.slice(-L.trail);
    let total = 0;
    for (let i = 0; i < last.length; i++) total += L.trailDecay ** i;
    for (let i = 0; i < last.length; i++) {
      const { mech, tactic } = last[last.length - 1 - i];
      this.add(mech, tactic, (amount * L.trailDecay ** i) / total, 0);
    }
  }
}
