/* The tank clock, injected: the host passes epoch milliseconds and nothing here
   reads the wall clock. Elapsed time is plain seconds; only the displayed hour and the light phase follow US Eastern. */

const ZONE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
const HOUR = 3600000;

/* Eastern's offset from UTC in ms. New York's changes land on whole UTC hours, so one lookup per UTC hour is exact. */
export class Eastern {
  constructor() { this._key = NaN; this._offset = 0; }

  offset(ms) {
    const key = Math.floor(ms / HOUR);
    if (key !== this._key) {
      const p = {};
      for (const { type, value } of ZONE.formatToParts(key * HOUR)) p[type] = +value;
      this._offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - key * HOUR;
      this._key = key;
    }
    return this._offset;
  }

  /* Fractional Eastern hour 0–24 and the Eastern calendar day number. */
  wall(ms) {
    const local = ms + this.offset(ms), day = Math.floor(local / (24 * HOUR));
    return { hour: (local - day * 24 * HOUR) / HOUR, day };
  }
}

export function phaseAt(hour, T) {
  const R = T.rhythm;
  if (hour >= R.dawn[0] && hour < R.dawn[1]) return 'dawn';
  if (hour >= R.day[0] && hour < R.day[1]) return 'day';
  if (hour >= R.dusk[0] && hour < R.dusk[1]) return 'dusk';
  return 'night';
}

/* Families not listed stay ×1. */
export function rhythmOf(phase, T) {
  const out = {};
  for (const f of T.rhythm.families[phase] ?? []) out[f] = T.rhythm.boost;
  return out;
}

/* Brain time in seconds from injected epoch ms. It never runs backward: a stale or wrong host time advances nothing.
   Without a valid starting time it reads 0 until the first valid `advance` sets the epoch. */
export class BrainClock {
  constructor(nowMs, T) {
    this.T = T;
    this.eastern = new Eastern();
    this._ms = Number.isFinite(nowMs) ? nowMs : null;
    this.t = (this._ms ?? 0) / 1000;
  }

  get started() { return this._ms !== null; }

  /* 0 for a time at or before the last, and for the one that sets a missing epoch. */
  advance(nowMs) {
    if (!Number.isFinite(nowMs)) return 0;
    if (this._ms === null) { this._ms = nowMs; this.t = nowMs / 1000; return 0; }
    if (nowMs <= this._ms) return 0;
    const dt = (nowMs - this._ms) / 1000;
    this._ms = nowMs; this.t = nowMs / 1000;
    return dt;
  }

  get ms() { return this._ms; }

  wall() { return this.eastern.wall(this._ms); }

  wallAt(sec) { return this.eastern.wall(sec * 1000); }

  rhythmAt(sec) { return rhythmOf(phaseAt(this.wallAt(sec).hour, this.T), this.T); }

  phase() { return phaseAt(this.wall().hour, this.T); }

  rhythm() { return rhythmOf(this.phase(), this.T); }
}
