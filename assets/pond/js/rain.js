import { SIM_RES, SIM_STEPS_HZ } from './config.js';
import { MAX_IMPULSES, MICRO_RADIUS } from './impulse.js';

/* Intensity is the shower's real strength and alone drives the audio bed; envelope is intensity
   capped for reduced motion, and drives impulse density, the surface's micro-ripple noise, and the
   eels' activity. Weather rolls off Math.random like idleDrops, not the pond seed, which is layout only. */

// Weather by coin toss: every 15 dry minutes, 50/50 whether a shower starts; while it pours, each
// completed audio loop tosses again and the rain chains until it loses. Losing resets the timer.
const TOSS_INTERVAL = 900;
const TOSS_P = 0.5;
const LOOP_FALLBACK = 180;            // the bed is a 3:00 loop; used until the decoder confirms it
const BUILD = [10, 22], TAIL = [18, 40], PEAK = [0.55, 1.0];
// Reduced motion: rarer starts, shorter chains, and capped low. The shower still sounds like a
// shower, because the ceiling is on the visible half only.
const CALM = { build: [14, 26], tail: [20, 40] };
const WET = { build: BUILD, tail: TAIL };
const CALM_P = 0.35;
const CALM_CEIL = 0.25, CALM_AUDIO = 0.8;
const NEXT = { dry: 'build', build: 'steady', steady: 'tail', tail: 'dry' };

// Density is per 8-texel cell per sim step: 4,096 cells × 0.012 is ~49 drops a step, ~3,700 a
// second, all of it inside the 64-per-call cap.
const CELL_TEXELS = 8;
const DENSITY = 0.012;
const FULL_PER_STEP = Math.round(DENSITY * (SIM_RES / CELL_TEXELS) ** 2);
const STRENGTH = [0.012, 0.026];      // against a pointer poke's 0.2
// Feature drops: a second tier of poke-scale splats that ring outward like real raindrops. The
// micro carpet is texture; these are the rain you watch. Landed in view so eyes match ears.
const BIG_RATE = 10;                  // per second at envelope 1, matched to the rain bed's audible drops
const BIG_RADIUS = [4, 9];            // bump radius in sim texels (a pointer poke is ~7)
const BIG_STRENGTH = [0.04, 0.10];
const MAX_CALLS = 4;                  // 4×64 covers a 50 ms catch-up frame at full density
const NOISE_GAIN = 0.35;

const INTEREST_SLOTS = 8;
const INTEREST_RATE = [3, 6];         // published per second, for Andy
const AUDIO_HZ = 8;

const FORCE_BUILD = 4, FORCE_STEADY = 240;

const roll = ([lo, hi]) => lo + Math.random() * (hi - lo);
const smooth = (p) => p * p * (3 - 2 * p);

const WIND_LAG = 1.5;                 // seconds for a gust to reach the reeds after it crosses the water

export class RainScheduler {
  constructor({ sim, injector, motion, view, surface = null, audio = null, bearing = 0 }) {
    this.sim = sim;
    this.injector = injector;
    this.motion = motion;
    this.view = view;
    this.surface = surface;
    this.audio = audio;
    this.habitat = null;       // set by main once the flora exists; feature drops dodge the pads

    this.envelope = 0;         // what the pond sees: intensity, capped under reduced motion
    this.intensity = 0;        // what the shower actually is; the audio bed rides this
    this.state = 'dry';
    this.stateT = 0;
    this.stateLen = 1;
    this.peak = 0;
    this.gustPhase = Math.random() * Math.PI * 2;
    // The pond's one wind: bearing from the swell so they agree, a light breeze when dry, real gusts
    // in a shower. gustLag is the copy the reeds read, so a gust visibly crosses the water first.
    this.wind = { x: Math.cos(bearing), z: Math.sin(bearing), gust: 0, gustLag: 0 };
    this.t = 0;
    this.pending = 0;          // fractional impulses owed to the injector
    this.forceSteady = false;

    // Pool and batch are allocated once: the frame loop only ever writes into them.
    this.pool = Array.from({ length: MAX_IMPULSES }, () => ({ u: 0, v: 0, s: 0, r: MICRO_RADIUS }));
    this.batch = [];
    this.pendingBig = 0;
    this.interestPoints = Array.from({ length: INTEREST_SLOTS }, () => ({ x: 0, z: 0, t: -1e9 }));
    this.interestHead = 0;
    this.interestNext = 0;
    this.audioAt = 0;
    this.pushedEnv = 0;
    this.pushedNoise = -1;     // forces the first write, so a stale uniform can never linger

    this.enter('dry');
  }

  get raining() { return this.state !== 'dry'; }

  enter(state) {
    const T = this.motion.reduced ? CALM : WET;
    this.state = state;
    this.stateT = 0;
    if (state === 'build') {
      this.stateLen = roll(T.build);
      this.peak = roll(PEAK);
    } else if (state === 'steady') {
      // One audio loop per link of the chain, so the continue toss lands on the seam of the bed.
      this.stateLen = this.forceSteady ? FORCE_STEADY : (this.audio?.rainLoopSeconds?.() ?? LOOP_FALLBACK);
      this.forceSteady = false;
    } else if (state === 'tail') {
      this.stateLen = roll(T.tail);
    } else {
      this.stateLen = TOSS_INTERVAL;
      this.peak = 0;
    }
  }

  /* Dry expiry tosses for a shower; steady expiry tosses to chain another loop or let go. */
  transition() {
    const p = this.motion.reduced ? CALM_P : TOSS_P;
    if (this.state === 'dry') return this.enter(Math.random() < p ? 'build' : 'dry');
    if (this.state === 'steady') return this.enter(Math.random() < p ? 'steady' : 'tail');
    this.enter(NEXT[this.state]);
  }

  /* A live reduced-motion flip shortens an in-progress ramp to the calm ranges; a running steady
     just finishes its loop and faces the calmer chain odds. The envelope cap applies next frame. */
  motionChanged() {
    if (!this.motion.reduced || !CALM[this.state]) return;
    this.stateLen = Math.min(this.stateLen, Math.max(this.stateT, CALM[this.state][1]));
  }

  /* ?rain=1: start pouring immediately and stay there long enough to actually look at. */
  force() {
    this.forceSteady = true;
    this.enter('build');
    this.stateLen = FORCE_BUILD;
    this.peak = PEAK[1];
  }

  update(dt) {
    this.t += dt;
    this.advance(dt);
    this.blow(dt);
    this.pushAudio();
    // Exactly zero when dry, and always zero under reduced motion.
    const noise = this.motion.reduced ? 0 : this.envelope * NOISE_GAIN;
    if (this.surface && noise !== this.pushedNoise) { this.surface.uRainNoise.value = noise; this.pushedNoise = noise; }
    if (this.envelope <= 0) { this.pending = 0; this.pendingBig = 0; return; }
    this.emit(dt);
  }

  advance(dt) {
    this.stateT += dt;
    if (this.stateT >= this.stateLen) this.transition();
    if (this.state === 'dry') { this.intensity = 0; this.envelope = 0; return; }
    const p = Math.min(1, this.stateT / this.stateLen);
    const shape = this.state === 'build' ? smooth(p) : this.state === 'tail' ? smooth(1 - p) : 1;
    this.intensity = this.peak * shape * (0.88 + 0.12 * this.gustRaw());
    // Clamped every frame, not per shower, so toggling the preference mid-downpour takes effect now.
    this.envelope = this.motion.reduced ? Math.min(this.intensity, CALM_CEIL) : this.intensity;
  }

  gustRaw() { return 0.5 + 0.5 * Math.sin(this.t * 0.23 + this.gustPhase); }

  /* Wind runs dry or wet: a quarter-strength breeze at rest, swelling with the shower. */
  blow(dt) {
    this.wind.gust = this.gustRaw() * (0.25 + 0.75 * this.envelope);
    this.wind.gustLag += (this.wind.gust - this.wind.gustLag) * Math.min(1, dt / WIND_LAG);
  }

  /* Tone's own ramps do the smoothing, so pushing every frame would only queue automation events. */
  pushAudio() {
    if (!this.audio) return;
    const level = this.intensity * (this.motion.reduced ? CALM_AUDIO : 1);
    // Dry is the longest state by far, so it must cost nothing: one final zero, then silence.
    if (level <= 0 && this.pushedEnv <= 0) return;
    const crossed = (level > 0) !== (this.pushedEnv > 0);
    if (!crossed && this.t < this.audioAt) return;
    this.audioAt = this.t + 1 / AUDIO_HZ;
    this.pushedEnv = level;
    this.audio.setRain(level);
  }

  /* Drops per rendered frame = density × envelope × the sim steps that frame is worth; the remainder
     carries so a light shower still lands drops. A failed blend probe means audible rain and no rings. */
  emit(dt) {
    const inj = this.injector;
    if (!inj?.available) { this.pending = 0; this.pendingBig = 0; return; }
    this.pending = Math.min(this.pending + FULL_PER_STEP * this.envelope * dt * SIM_STEPS_HZ, MAX_IMPULSES * MAX_CALLS);
    this.pendingBig = Math.min(this.pendingBig + BIG_RATE * this.envelope * dt, 8);
    for (let call = 0; call < MAX_CALLS && this.pending >= 1; call++) {
      const n = Math.min(MAX_IMPULSES, Math.floor(this.pending));
      const drops = this.take(n);
      // Feature drops land inside the viewport (plus a hair of margin); the micro carpet covers the
      // whole pool so waves still arrive from off-screen.
      const bu = this.view.w * 1.1 / this.sim.extent, bv = this.view.h * 1.1 / this.sim.extent;
      for (let i = 0; i < n; i++) {
        const d = drops[i];
        if (this.pendingBig >= 1) {
          this.pendingBig -= 1;
          // A splash under a pad would ring where nothing landed: re-roll a few times, then let the
          // drop fall as an invisible micro one rather than fake a ring.
          let open = false;
          for (let k = 0; k < 4 && !open; k++) {
            d.u = 0.5 + (Math.random() - 0.5) * bu;
            d.v = 0.5 + (Math.random() - 0.5) * bv;
            open = !this.habitat?.padAt((d.u - 0.5) * this.sim.extent, (d.v - 0.5) * this.sim.extent, 0);
          }
          if (open) { d.s = roll(BIG_STRENGTH); d.r = roll(BIG_RADIUS); }
          else { d.s = roll(STRENGTH); d.r = MICRO_RADIUS; }
        } else {
          d.u = Math.random();
          d.v = Math.random();
          d.s = roll(STRENGTH); d.r = MICRO_RADIUS;
        }
      }
      inj.inject(drops);
      this.publishInterest(drops, n);
      this.pending -= n;
    }
  }

  /* The injector reads drops.length, so the batch is resized against the pool instead of sliced. */
  take(n) {
    const b = this.batch;
    while (b.length < n) b.push(this.pool[b.length]);
    b.length = n;
    return b;
  }

  /* 3–6 real drop positions a second, on screen, for Andy to drift toward. They are never spooks:
     3,700 impulses a second reaching the spook list would carpet-bomb the pond. */
  publishInterest(drops, n) {
    if (this.t < this.interestNext) return;
    const ex = this.view.w * 0.45, ez = this.view.h * 0.45;
    for (let i = 0; i < n; i++) {
      const x = (drops[i].u - 0.5) * this.sim.extent;
      const z = (drops[i].v - 0.5) * this.sim.extent;
      if (Math.abs(x) > ex || Math.abs(z) > ez) continue;
      const p = this.interestPoints[this.interestHead];
      p.x = x; p.z = z; p.t = this.t;
      this.interestHead = (this.interestHead + 1) % INTEREST_SLOTS;
      this.interestNext = this.t + 1 / roll(INTEREST_RATE);
      return;
    }
  }

  /* One uniformly chosen recent drop, picked reservoir-style so nothing is allocated to choose it. */
  freshInterest(maxAge = 5) {
    let best = null, seen = 0;
    for (const p of this.interestPoints) {
      if (this.t - p.t > maxAge) continue;
      seen++;
      if (Math.random() < 1 / seen) best = p;
    }
    return best;
  }
}
