/* The rest ladder: curled awake, half-sleep, then full sleep as quiet stretches broken by short active bouts, with
   waking rules. States: 'awake', 'curled', 'half', 'stirring' (half-sleep yielding), 'quiet', 'active'. */

export const SLEEP_OF = { awake: 'awake', curled: 'curled', half: 'half', stirring: 'half', quiet: 'full', active: 'full' };

export class RestLadder {
  constructor(T) {
    this.R = T.rest;
    this.state = 'awake';
    this.since = 0;
    this.calmSince = 0;          // last disturbance of any size
    this.lastWake = -Infinity;   // end of the last full sleep, natural or woken
    this.sleepStart = 0;
    this.night = false;
    this.nextActive = Infinity;
    this.extraDream = false;     // a missed dream owed to the next full sleep
    this.bumpUntil = -Infinity;
    this.rebound = false;        // unfinished sleep, owed ×rebound rest priority once calm
    this.woken = null;           // set on a forced waking, for the host's reaction; the brain clears it
  }

  get sleep() { return SLEEP_OF[this.state]; }
  get asleep() { return this.state === 'quiet' || this.state === 'active'; }

  _to(state, now) { this.state = state; this.since = now; }

  thresholds(now) {
    const b = now < this.bumpUntil ? this.R.wakeBump : 0;
    return { quiet: this.R.wakeQuiet + b, active: this.R.wakeActive + b };
  }

  /* A disturbance of `strength` 0–1; knocks never land during an active bout. Returns true if it woke her. */
  disturb(now, strength, knock = false) {
    this.calmSince = now;
    if (!this.asleep || !(strength > 0)) return false;
    const th = this.thresholds(now);
    if (this.state === 'active' ? knock || strength <= th.active : strength <= th.quiet) return false;
    if (this.state === 'quiet') this.extraDream = true;
    this.woken = { at: now, strength, knock };
    this._wake(now, true);
    return true;
  }

  _wake(now, forced) {
    this._to('awake', now);
    this.lastWake = now;
    this.nextActive = Infinity;
    if (forced) { this.bumpUntil = now + this.R.bumpFor; this.rebound = true; }
  }

  /* ctx: resting (her goal is rest and she is settled in a den), willing (sleepy, or a willing nap), comfortOk (full
     sleep's comfort gate), energy, redLine (energy past its hard line), hour (Eastern). */
  step(now, ctx) {
    const R = this.R, calm = now - this.calmSince;
    switch (this.state) {
      case 'awake':
        if (ctx.resting) this._to('curled', now);
        break;
      case 'curled':
        if (!ctx.resting) this._to('awake', now);
        else if (now - this.since >= R.curlToHalf && calm >= R.curlToHalf) this._to('half', now);
        break;
      case 'half':
        if (!ctx.resting) this._to('stirring', now);
        else if (now - this.since >= R.halfToFull && ctx.willing && ctx.comfortOk && calm >= R.calmFor
          && (now - this.lastWake >= R.awakeBetween || ctx.redLine)) this._sleep(now, ctx.hour);
        break;
      case 'stirring':
        if (ctx.resting) this._to('half', now);
        else if (now - this.since >= R.stir) this._to('awake', now);
        break;
      case 'quiet':
        if (now >= this.nextActive) { this._to('active', now); this.nextActive = now + R.active; }
        break;
      case 'active':
        if (now >= this.nextActive) {
          const longEnough = !this.night || now - this.sleepStart >= R.nightMin;
          if (ctx.energy >= R.wakeEnergy && longEnough) { this._wake(now, false); break; }
          this._to('quiet', now);
          this.nextActive = now + R.cycle - R.active;
        }
        break;
    }
    if (this.rebound && this.asleep) this.rebound = false;
    return this.state;
  }

  _sleep(now, hour) {
    this._to('quiet', now);
    this.sleepStart = now;
    this.night = hour >= this.R.nightFrom && hour < this.R.nightTo;
    this.nextActive = now + (this.extraDream ? 0 : this.R.quiet);
    this.extraDream = false;
  }

  /* The ×rebound rest priority, once she has been calm for calmFor after a forced waking. */
  restBoost(now) { return this.rebound && now - this.calmSince >= this.R.calmFor ? this.R.rebound : 1; }
}
