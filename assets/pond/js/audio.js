import * as Tone from 'tone';

/* Ambient bed plus one-shot sample sets on three mix buses (ambience, eel, env).
   One-shots spawn a throwaway Player over the set's shared buffer so each play can carry
   its own pan and pitch; a file that fails to load warns once and its slot stays silent. */
const BASE = 'assets/pond/audio/';
const seq = (stem, n) => Array.from({ length: n }, (_, i) => `${stem}-${i + 1}.ogg`);
const SETS = {
  plips: seq('sfx/plip', 6),
  swishes: ['sfx/swishy-a.ogg', 'sfx/swishy-b.ogg'],
  plops: ['sfx/plop-big.ogg', 'sfx/plop-smol.ogg'],
  startles: seq('sfx/eel-startle', 3),
  eleanor: ['sfx/eleanor-startle.ogg'],
  crackles: ['sfx/crackle-lil.ogg', 'sfx/crackle-med.ogg', 'sfx/crackle-big.ogg'],
  eats: seq('sfx/eel-eat', 3),
  slurps: seq('sfx/slurp', 4),
  shortBubs: seq('sfx/short-bubs', 5),
  tinyBubs: seq('sfx/tiny-bubs', 8),
  sips: ['sfx/sippy.ogg'],
};
// Sounds the eels make ride the eel bus; player-made water and pond environment ride env.
const EEL_SETS = new Set(['startles', 'eleanor', 'crackles', 'eats', 'slurps', 'tinyBubs', 'sips']);
// Rain's lowpass sweep: a shut-in patter at the first drops, wide open in a downpour.
const RAIN_LP = [700, 7000];

/* The space eel's voice is Eleanor's, reversed and half an octave down, through the space reverb.
   The envelope carries kind 'sam'; his identity is also the only void one, so either proves him. */
const SPACE_RATE = 0.707;
const isSam = (ev) => ev?.kind === 'sam' || ev?.eel?.identity?.void === true;
// His bed loop: 4 s in on arrival, 4 s out on departure, and 6 dB down under his own one-shots.
const DRONE_FADE = 4;
const DRONE_SWELL = 120;   // seconds for one full swell of the bed, low to high and back
const DRONE_DUCK = -6;

/* Mixed by ear via ?mixer=1; the panel still overrides these per-browser via localStorage. */
const DEFAULT_MIX = {
  buses: { ambience: 0, eel: 0, env: 0 },
  levels: {
    ambient: -2.5, rain: -6,
    plip: -5, swish: -1.5, plopBig: -2, plopSmol: -2,
    startle: -10, eleanorStartle: -8,
    crackleLil: -2.5, crackleMed: -2.5, crackleBig: -2.5,
    eat: -3, slurp: -3, tinyBub: -18, shortBub: -15, sip: 4,
    drip: -17, padSettle: -8, drone: -5, droneLow: -10, droneRest: -3,
  },
};

/* The audible length of a one-shot is not buffer.duration / rate: the rate is jittered and trim picks
   a random start and a 70–100% length after that. Pure, so a caller can line a visual up with it. */
export function shotVariant(bufDur, { jitter = 0.15, rate = 1, trim = false } = {}, rand = Math.random) {
  const r = rate * (1 - jitter / 2 + rand() * jitter);
  const offset = trim ? rand() * 0.1 * bufDur : 0;
  // Untrimmed plays the whole buffer, which Tone wants as an absent duration, not a number.
  const dur = trim ? (0.7 + rand() * 0.3) * (bufDur - offset) : undefined;
  return { rate: r, offset, dur, duration: (dur ?? bufDur) / r };
}

/* All of Korobeiniki (public-domain folk tune) in semitones from A, A section then B; crumb
   drops walk it, a 2 s gap resets to the top, and big plops roll a 2-octave major pentatonic. */
const TETRIS = [
  7, 2, 3, 5, 3, 2, 0, 0, 3, 7, 5, 3, 2, 3, 5, 7, 3, 0, 0,
  5, 8, 12, 10, 8, 7, 3, 7, 5, 3, 2, 2, 3, 5, 7, 3, 0, 0,
  7, 3, 5, 2, 3, 0, -1, 2, 7, 3, 5, 2, 3, 7, 12, 11,
];
const PENTA = [-12, -10, -8, -5, -3, 0, 2, 4, 7, 9, 12];
const st = (semi) => 2 ** (semi / 12);

const VOLUME_KEY = 'xy.volume';
const MUTE_KEY = 'xy.muted';
const MIX_KEY = 'xy.devmix';
const BUSVOL_KEY = 'xy.busvol';

export class PondAudio {
  constructor() {
    this.unlocked = false;
    this.master = null;
    this.buses = null;
    this.players = {};
    this.tracks = new Map();       // (creature id, bus) → persistent Panner; the eel bus keys on the id alone
    this.trackPan = new Map();     // last pan per creature, so a second route for it opens already aimed
    this.reversed = new Map();     // set|key → a reversed copy of that buffer
    this.live = new Set();         // in-flight throwaway players, for stopAll()
    this.droneOn = false;
    this.duckUntil = 0;
    this.swishPl = null;
    this.swishPanner = null;
    this.lastPlip = 0;
    this.plipCount = 0;
    this.tetrisIdx = 0;
    this.lastSmol = 0;
    this.crackleAt = 0;
    this.eleanorAt = 0;
    this.bubAt = 0;
    this.rainEnv = 0;              // shower envelope, survives an unlock so a shower already running fades in
    this.rainOn = false;
    this.rainStopAt = 0;
    this.volume = this.readNumber(VOLUME_KEY, 0.5);
    this.muted = this.readBool(MUTE_KEY, false);
    // User-facing bus faders (0–1), layered on top of the dev mix's bus dB.
    this.userBuses = { ambience: 1, eel: 1, env: 1 };
    try { Object.assign(this.userBuses, JSON.parse(localStorage.getItem(BUSVOL_KEY)) ?? {}); } catch {}
    this.mix = structuredClone(DEFAULT_MIX);
    try {
      const saved = JSON.parse(localStorage.getItem(MIX_KEY));
      if (saved) { Object.assign(this.mix.buses, saved.buses); Object.assign(this.mix.levels, saved.levels); }
    } catch {}
    this.onState = null;
  }

  readNumber(k, d) { try { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : d; } catch { return d; } }
  readBool(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } }

  /* Call from a user gesture. Builds the graph and starts the bed. The promise latch matters: two
     gestures racing past a boolean while Tone.start() awaits would build two live graphs. */
  async unlock() {
    try {
      this.unlockP ??= this.buildGraph();
      await this.unlockP;
    } catch (err) {
      // A rejected latch would wedge every later gesture on the same dead promise; clear it to retry.
      this.unlockP = null;
      this.onState?.();
      throw err;
    }
  }

  async buildGraph() {
    await Tone.start();
    this.unlocked = true;
    // The limiter caps the summed output so a busy pond can't clip, whatever the mix says.
    this.limiter = new Tone.Limiter(-3).toDestination();
    this.master = new Tone.Gain(this.muted ? 0 : this.volume).connect(this.limiter);
    this.buses = {
      ambience: new Tone.Gain(this.busGain('ambience')).connect(this.master),
      eel: new Tone.Gain(this.busGain('eel')).connect(this.master),
      env: new Tone.Gain(this.busGain('env')).connect(this.master),
    };
    /* The space reverb feeds the eel bus, so the mixer's eel row still governs him and gains no row.
       Tone generates the impulse off-thread; until it lands the dry half still passes, so nothing waits. */
    this.space = new Tone.Reverb({ decay: 5, preDelay: 0.02, wet: 0.55 }).connect(this.buses.eel);
    this.space.ready.catch((err) => console.warn('Pond audio: space reverb failed', err));
    this.swishPanner = new Tone.Panner(0).connect(this.buses.env);
    this.droneGain = new Tone.Gain(0);                            // arrival/departure envelope
    // The bed breathes between its two mixer levels on a slow swell; a gain, since an LFO into a dB param is nonsense.
    this.droneSwell = new Tone.Gain(1).connect(this.droneGain);
    this.droneLfo = new Tone.LFO({ frequency: 1 / DRONE_SWELL, min: Tone.dbToGain(this.mix.levels.droneLow), max: Tone.dbToGain(this.mix.levels.drone) });
    this.droneLfo.connect(this.droneSwell.gain);
    this.droneOut = new Tone.Gain(1).connect(this.buses.eel);     // the duck under his one-shots
    this.droneGain.connect(this.droneOut);
    this.loadAll();
    this.watchVisibility();
    this.onState?.();
  }

  /* Web Audio runs off the render loop, so a hidden tab keeps looping the beds (and any swish left
     on by a drag) until it is revisited. Suspending the raw context freezes every playhead in place. */
  watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (!this.unlocked) return;
      const ctx = Tone.getContext()?.rawContext;
      if (!ctx?.suspend) return;
      // A browser can refuse to resume without a fresh gesture; the next unlock gesture retries.
      if (document.hidden) { if (ctx.state === 'running') ctx.suspend().catch(() => {}); }
      else if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    });
  }

  loadAll() {
    const warn = (name) => (err) => console.warn(`Pond audio: ${name} failed to load`, err);
    this.players.ambient = new Tone.Player({
      url: `${BASE}ambient-pond.ogg`, loop: true, fadeIn: 2, fadeOut: 1, volume: this.mix.levels.ambient,
      onload: () => { if (this.unlocked) this.players.ambient.start(); },
      onerror: warn('ambient'),
    }).connect(this.buses.ambience);
    // Rain gets its own gain and filter so the envelope can swell and open up without touching the
    // mix level, which stays a plain dB slider like every other slot.
    this.rainGain = new Tone.Gain(0).connect(this.buses.env);
    this.rainFilter = new Tone.Filter({ type: 'lowpass', frequency: RAIN_LP[0], Q: 0.4 }).connect(this.rainGain);
    this.players.rain = new Tone.Player({
      url: `${BASE}drippy-pond-rain.ogg`, loop: true, fadeIn: 1.5, fadeOut: 2, volume: this.mix.levels.rain,
      onload: () => { if (this.rainEnv > 0) this.setRain(this.rainEnv); },
      onerror: warn('rain'),
    }).connect(this.rainFilter);
    // The space eel's bed: a seamless loop, so the player's own fades only ever touch its start and stop.
    this.players.drone = new Tone.Player({
      url: `${BASE}sam-drone.ogg`, loop: true, fadeIn: 0.05, fadeOut: 0.05, volume: 0,
      onerror: warn('drone'),
    }).connect(this.droneSwell);
    // The sets stay unconnected: they only hold decoded buffers for shot() to spawn from.
    for (const [name, files] of Object.entries(SETS)) {
      const urls = {};
      files.forEach((f, i) => { urls[i] = f; });
      this.players[name] = new Tone.Players({ urls, baseUrl: BASE, onerror: warn(name) });
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(VOLUME_KEY, String(this.volume)); } catch {}
    this.apply();
  }

  /* The rain bed's true loop length, once decoded; the shower chains itself one loop at a time. */
  rainLoopSeconds() {
    const b = this.players.rain?.buffer;
    return b?.loaded ? b.duration : null;
  }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch {}
    this.apply();
  }

  apply() {
    if (!this.master) return;
    this.master.gain.rampTo(this.muted ? 0 : this.volume, 0.15);
    this.onState?.();
  }

  /* Where a routing override lands. The space reverb is deliberately not a member of this.buses: it
     has no gain and no mixer row, and every bus loop in here would trip over it. */
  busNode(name) { return name === 'space' ? this.space : this.buses[name]; }

  /* Lazy per-creature Panner so a long sound keeps tracking its owner across the screen. Keyed by
     creature and bus, since one panner wired to the eel bus would swallow a space route silently. */
  trackPanner(id, bus = 'eel') {
    const key = bus === 'eel' ? id : `${id}|${bus}`;
    let tr = this.tracks.get(key);
    if (!tr) {
      tr = new Tone.Panner(this.trackPan.get(id) ?? 0).connect(this.busNode(bus) ?? this.buses.eel);
      this.tracks.set(key, tr);
    }
    return tr;
  }

  setTrackPan(id, pan) {
    if (!this.unlocked) return;
    const p = Math.max(-1, Math.min(1, pan));
    this.trackPan.set(id, p);
    this.trackPanner(id).pan.value = p;
    const space = this.tracks.get(`${id}|space`);
    if (space) space.pan.value = p;
  }

  /* Reversing a Tone.Player flips the channel data of the buffer in place, and that data is shared
     with the set's own Players, so a reversed copy is cut once per variant and played forward. */
  reversedBuffer(set, key, buf) {
    const id = `${set}|${key}`;
    let rev = this.reversed.get(id);
    if (!rev) {
      if (!(buf.duration > 0)) return null;
      rev = buf.slice(0);
      rev.reverse = true;
      this.reversed.set(id, rev);
    }
    return rev;
  }

  swishPan(pan) { if (this.swishPanner) this.swishPanner.pan.value = Math.max(-1, Math.min(1, pan)); }

  /* Resolves the variant, trim, and jittered rate up front, returning { play, duration } so a caller can
     align a visual with the sound before it plays. opts match shot()'s; levelKey may carry opts.level. */
  prepare(set, key, levelKey, opts = {}) {
    if (levelKey && typeof levelKey === 'object') { opts = levelKey; levelKey = opts.level; }
    const { db = 0, jitter = 0.15, rate = 1, pan = null, track = null, trim = false,
      delay = 0, bus = null, lp = 0, reverse = false } = opts;
    if (!this.unlocked) return null;
    const src = this.players[set]?.player(String(key));
    if (!src?.loaded) return null;
    const buf = reverse ? this.reversedBuffer(set, key, src.buffer) : src.buffer;
    if (!buf) return null;
    const v = shotVariant(buf.duration, { jitter, rate, trim }, Math.random);
    const play = () => {
      const p = new Tone.Player(buf);
      p.playbackRate = v.rate;
      p.volume.value = (this.mix.levels[levelKey] ?? 0) + db;
      p.fadeIn = trim ? 0.03 : 0;
      p.fadeOut = trim ? 0.15 : 0.05;
      let panner = null, filt = null;
      let out = this.busNode(bus) ?? (EEL_SETS.has(set) ? this.buses.eel : this.buses.env);
      // lp is a lowpass in Hz for sounds made under water; the filter sits last so the panner is unchanged.
      if (lp > 0) { filt = new Tone.Filter({ type: 'lowpass', frequency: lp, Q: 0.5 }).connect(out); out = filt; }
      if (track != null) p.connect(this.trackPanner(track, bus ?? 'eel'));
      else if (pan != null) { panner = new Tone.Panner(Math.max(-1, Math.min(1, pan))).connect(out); p.connect(panner); }
      else p.connect(out);
      this.live.add(p);
      p.onstop = () => { this.live.delete(p); setTimeout(() => { panner?.dispose(); filt?.dispose(); p.dispose(); }, 250); };
      p.start(Tone.now() + Math.max(0, delay), v.offset, v.dur);
      return p;
    };
    return { play, duration: v.duration, rate: v.rate };
  }

  /* Spawn one throwaway Player over the set's shared buffer. trim randomizes the start and length, bus
     overrides routing ('space' included), reverse plays a backward copy; the rest are self-explanatory. */
  shot(set, key, levelKey, opts) {
    return this.prepare(set, key, levelKey, opts)?.play() ?? null;
  }

  pick(set, levelKey, opts) {
    return this.shot(set, Math.floor(Math.random() * SETS[set].length), levelKey, opts);
  }

  /* One of his: prepared first so the drone can duck for exactly as long as the sound lasts. */
  guestShot(set, key, levelKey, opts) {
    const s = this.prepare(set, key, levelKey, opts);
    if (!s) return null;
    this.duckDrone(s.duration);
    return s.play();
  }

  /* The space voice on top of whatever the resident sound already asked for. */
  spaceOpts(rate = 1) { return { reverse: true, bus: 'space', rate: rate * SPACE_RATE }; }

  plip(strength = 1, pan = null) {
    const now = Tone.now();
    // Spam-click ducking: rapid repeats get quieter instead of stacking into noise.
    if (now - this.lastPlip < 0.25) this.plipCount++; else this.plipCount = 0;
    this.lastPlip = now;
    this.pick('plips', 'plip', { db: -Math.min(18, this.plipCount * 3) + (strength - 1) * 4, jitter: 0.25, pan });
  }

  /* Looping hand-swish while dragging; each drag spawns a fresh variant through the swish panner. */
  swish(on) {
    if (!this.unlocked) return;
    if (!on) { if (this.swishPl?.state === 'started') this.swishPl.stop(); return; }
    if (this.swishPl?.state === 'started') return;
    const src = this.players.swishes?.player(String(Math.floor(Math.random() * SETS.swishes.length)));
    if (!src?.loaded) return;
    const p = new Tone.Player(src.buffer);
    p.loop = true;
    p.fadeIn = 0.15;
    p.fadeOut = 0.3;
    p.volume.value = this.mix.levels.swish;
    p.connect(this.swishPanner);
    p.onstop = () => { if (this.swishPl === p) this.swishPl = null; setTimeout(() => p.dispose(), 400); };
    this.swishPl = p;
    p.start();
  }

  plop(size = 'big', pan = null) {
    if (size === 'smol') {
      const now = Tone.now();
      if (now - this.lastSmol > 2) this.tetrisIdx = 0;
      this.lastSmol = now;
      this.shot('plops', 1, 'plopSmol', { rate: st(TETRIS[this.tetrisIdx++ % TETRIS.length]), jitter: 0, pan });
    } else {
      this.shot('plops', 0, 'plopBig', { rate: st(PENTA[Math.floor(Math.random() * PENTA.length)]), jitter: 0.02, pan });
    }
  }

  /* Bigger eel, deeper voice: residents run ~1.6–3.6 units and grow toward 7 before the SLURP. */
  rateForLength(len = 2.8) { return Math.max(0.6, Math.min(1.3, (2.8 / len) ** 0.5)); }

  startle({ length, pan = null, db = 0 } = {}) {
    this.pick('startles', 'startle', { db, jitter: 0.2, rate: this.rateForLength(length), pan });
  }

  /* The big girl's chunky startle: throttled, and trimmed/jittered since there's only one file.
     Hers alone; the space eel never startles anyone, so his envelope is refused outright. */
  eleanorStartle({ pan = null, ev = null } = {}) {
    if (isSam(ev)) return;
    const now = Tone.now();
    if (now < this.eleanorAt) return;
    if (this.shot('eleanor', 0, 'eleanorStartle', { jitter: 0.2, trim: true, pan })) this.eleanorAt = now + 2.5;
  }

  /* lil 4 s, med 15 s, big 27 s; 'auto' rolls mostly lil. One at a time unless forced. */
  crackle(size = 'auto', { force = false, length, pan = null, track = null } = {}) {
    const now = Tone.now();
    if (!force && now < this.crackleAt) return;
    if (size === 'auto') { const r = Math.random(); size = r < 0.7 ? 'lil' : r < 0.95 ? 'med' : 'big'; }
    const [idx, levelKey] = { lil: [0, 'crackleLil'], med: [1, 'crackleMed'], big: [2, 'crackleBig'] }[size];
    const pl = this.shot('crackles', idx, levelKey, { jitter: 0.1, rate: this.rateForLength(length), pan, track });
    if (pl) this.crackleAt = now + (pl.buffer.duration / pl.playbackRate) * 0.8;
  }

  /* size 1 = big treat, 2 = crumb, 3 = tiny; rate 0.5 drops Eleanor's an octave. His voice is hers,
     so a Sam meal starts from her rate whatever the caller passed, then the space voice slows it again. */
  eat(size = 2, { pan = null, rate = 1, db = 0, ev = null } = {}) {
    const key = Math.min(3, Math.max(1, size)) - 1;
    if (isSam(ev)) return this.guestShot('eats', key, 'eat', { jitter: 0.3, pan, db, ...this.spaceOpts(0.5) });
    return this.shot('eats', key, 'eat', { jitter: 0.3, rate, pan, db });
  }

  /* Morgan's mouthfuls: the crumb eat, pitched up and pulled back, since she takes many small bites.
     (The tiny eat sample peaks 4 dB under it and averages -50 dB, so with a cut it vanishes.) */
  graze({ pan = null, muffled = false } = {}) {
    this.shot('eats', 1, 'eat', { jitter: 0.3, rate: 1.35, db: -3, pan, lp: muffled ? 900 : 0 });
  }

  slurp({ pan = null, ev = null } = {}) {
    const key = Math.floor(Math.random() * SETS.slurps.length);
    if (isSam(ev)) return this.guestShot('slurps', key, 'slurp', { jitter: 0.2, trim: true, pan, ...this.spaceOpts() });
    return this.shot('slurps', key, 'slurp', { jitter: 0.2, trim: true, pan });
  }

  /* Matthew at the notch. One "sshpp" per sip, pitch-and-time squished by playbackRate: a wide random
     spread plus a climb through the cup (`step` counts sips since the cup began), so no two land alike. */
  sip({ pan = null, step = 0 } = {}) {
    const rate = 1.0 + Math.min(0.35, step * 0.07) + Math.random() * 0.25;
    if (!this.shot('sips', 0, 'sip', { jitter: 0.15, rate, pan })) this.pick('shortBubs', 'shortBub', { db: -4, jitter: 0.35, rate: 1.4, pan });
  }

  /* Chandler's song: pentatonic big-plops walking up then back down, forced onto the eel bus because
     it is a creature making it, not the water. Scheduled ahead so the phrase survives a busy frame. */
  sing({ pan = null, notes = 3 } = {}) {
    const n = Math.max(1, Math.min(8, Math.round(notes)));
    const peak = Math.ceil(n / 2);
    let idx = 2 + Math.floor(Math.random() * 3);
    let at = 0;
    for (let i = 0; i < n; i++) {
      const semi = PENTA[Math.max(0, Math.min(PENTA.length - 1, idx))];
      this.shot('plops', 0, 'plopBig', { db: -6, rate: st(semi), jitter: 0.02, pan, delay: at, bus: 'eel' });
      at += 0.16 + Math.random() * 0.08;
      idx += (i < peak - 1 ? 1 : -1) * (1 + Math.floor(Math.random() * 2));
    }
  }

  /* Vi's headbutt: a crackle dropped a couple of semitones so it lands as a thud, not a rustle. */
  headbutt({ pan = null, length } = {}) {
    this.shot('crackles', 0, 'crackleLil', { jitter: 0.08, rate: 0.85 * this.rateForLength(length), pan });
  }

  /* Morgan pulling someone loose: two bubbles, close enough to read as one gesture. */
  rescue({ pan = null } = {}) {
    this.pick('tinyBubs', 'tinyBub', { jitter: 0.3, pan });
    this.pick('tinyBubs', 'tinyBub', { jitter: 0.3, pan, delay: 0.12 });
  }

  /* A snoot-boop: two tiny bubs a hair further apart than the rescue's, and never throttled, since a
     reunion fires three of these in a row and swallowing any one of them ruins the joke. */
  boop({ pan = null } = {}) {
    this.pick('tinyBubs', 'tinyBub', { jitter: 0.3, pan });
    this.pick('tinyBubs', 'tinyBub', { jitter: 0.3, pan, delay: 0.18 });
  }

  /* Nibble/surface bubbles; lightly throttled so a dinner circle stays bubbly, not fizzy. */
  tinyBub({ pan = null, ev = null } = {}) {
    const now = Tone.now();
    if (now - this.bubAt < 0.15) return;
    this.bubAt = now;
    const key = Math.floor(Math.random() * SETS.tinyBubs.length);
    if (isSam(ev)) return this.guestShot('tinyBubs', key, 'tinyBub', { jitter: 0.3, pan, ...this.spaceOpts() });
    return this.shot('tinyBubs', key, 'tinyBub', { jitter: 0.3, pan });
  }

  shortBub({ pan = null } = {}) { this.pick('shortBubs', 'shortBub', { jitter: 0.25, pan }); }

  /* Water running off a tipped lily pad: a small high plip, at most two a second pond-wide. */
  drip({ pan = null } = {}) {
    const now = Tone.now();
    if (now - (this.dripAt ?? 0) < 0.5) return;
    this.dripAt = now;
    this.pick('plips', 'drip', { jitter: 0.3, rate: 1.2, pan });
  }

  /* A pad or leaf settling back after a body shoved it: a low plip. */
  padSettle({ pan = null } = {}) { this.pick('plips', 'padSettle', { jitter: 0.2, rate: 0.7, pan }); }

  /* Verticality placeholders, all standing in for SFX-Wishlist rows Sam has yet to record. */

  // A snout breaking the film: the plip, five semitones down.
  peek({ pan = null } = {}) { this.pick('plips', 'plip', { db: -4, jitter: 0.25, rate: st(-5), pan }); }

  // A body coming back down. One branch, never both: a belly flop is an octave under with a burst
  // behind it, an ordinary re-entry is the length-pitched plop with a single short-bubs after.
  splash({ pan = null, length = 2.8, bellyflop = false } = {}) {
    if (bellyflop) {
      this.shot('plops', 0, 'plopBig', { rate: 0.5, jitter: 0.02, pan });
      this.pick('shortBubs', 'shortBub', { db: 4, jitter: 0.3, delay: 0.06, pan });
    } else {
      this.shot('plops', 0, 'plopBig', { rate: this.rateForLength(length), jitter: 0.04, pan });
      this.pick('shortBubs', 'shortBub', { jitter: 0.3, delay: 0.09, pan });
    }
  }

  // Sand moving under a digging head: short-bubs, low-passed into a scrunch and throttled to a beat.
  dig({ pan = null } = {}) {
    const now = Tone.now();
    if (now - (this.digAt ?? 0) < 0.35) return;
    this.digAt = now;
    this.pick('shortBubs', 'shortBub', { db: -3, jitter: 0.4, rate: 0.75, lp: 700, pan });
  }

  // Snapping at the reflection and getting water: the plip, four semitones up.
  moonbite({ pan = null } = {}) { this.pick('plips', 'plip', { jitter: 0.2, rate: st(4), pan }); }

  // Tearing a mouthful off a whole treat: tiny-bubs scheduled across the spin, two a revolution.
  spin({ pan = null, revs = 3 } = {}) {
    const n = Math.max(2, Math.min(12, Math.round(revs * 2)));
    // Spaced across the roll rather than at a fixed half second, so a capped shot count still fits it.
    const gap = revs / n;
    for (let i = 0; i < n; i++) this.pick('tinyBubs', 'tinyBub', { db: -2, jitter: 0.35, delay: i * gap, pan });
  }

  /* The shower envelope (0–1) from rain.js. Gain is squared so the build feels gradual rather than
     arriving all at once, and the lowpass opens as the rain gets closer. */
  setRain(env) {
    const e = Math.max(0, Math.min(1, env));
    this.rainEnv = e;
    if (!this.unlocked || !this.rainGain) return;
    if (e <= 0) {
      this.rainGain.gain.rampTo(0, 2);
      this.stopRain();
      return;
    }
    const p = this.players.rain;
    if (p?.loaded && !this.rainOn) {
      this.rainOn = true;
      clearTimeout(this.rainStopAt);
      if (p.state !== 'started') p.start();
    }
    this.rainGain.gain.rampTo(e * e, 0.4);
    this.rainFilter.frequency.rampTo(RAIN_LP[0] + (RAIN_LP[1] - RAIN_LP[0]) * e ** 0.7, 0.6);
  }

  /* The space eel's bed. Silent and inert until the drone file exists; `instant` cuts the fade to nearly
     nothing, reserved for a future move too abrupt to fade through. No caller passes it yet. `track` is
     his creature id, so the bed pans with his head. */
  guestDrone(on, { instant = false, track = null, rest = false } = {}) {
    if (!this.unlocked || !this.players.drone?.loaded) return;
    const p = this.players.drone;
    const fade = instant ? 0.05 : DRONE_FADE;
    if (track != null && this.droneTrack !== track) {
      this.droneTrack = track;
      this.droneOut.disconnect();
      this.droneOut.connect(this.trackPanner(track));
    }
    clearTimeout(this.droneStopAt);
    if (on) {
      this.droneOn = true;
      if (p.state !== 'started') p.start();
      if (this.droneLfo.state !== 'started') this.droneLfo.start();
      // Asleep in the log the bed drops by the droneRest level: a dial relative to drone, set by ear.
      this.droneRest = rest;
      this.droneGain.gain.rampTo(rest ? Tone.dbToGain(this.mix.levels.droneRest) : 1, fade);
      return;
    }
    this.droneOn = false;
    this.droneGain.gain.rampTo(0, fade);
    // A loop left running keeps the graph awake for nothing; a return before the timer cancels it.
    this.droneStopAt = setTimeout(() => { if (!this.droneOn && p.state === 'started') p.stop(); }, fade * 1000 + 400);
  }

  /* His one-shots duck the bed under them for exactly as long as they sound. */
  duckDrone(seconds) {
    if (!this.droneOn || !this.droneOut) return;
    const until = Tone.now() + Math.max(0.2, seconds) + 0.35;
    if (until <= this.duckUntil) return;   // a longer duck already covers this one
    this.duckUntil = until;
    this.droneOut.gain.rampTo(Tone.dbToGain(DRONE_DUCK), 0.08);
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => { this.duckUntil = 0; this.droneOut?.gain.rampTo(1, 0.5); }, (until - Tone.now()) * 1000);
  }

  /* Dry means stopped, not silent: a loop left running keeps the graph awake for nothing. The timer
     outlasts the gain ramp, and a shower that returns first cancels it by flipping rainOn back. */
  stopRain() {
    if (!this.rainOn) return;
    this.rainOn = false;
    const p = this.players.rain;
    clearTimeout(this.rainStopAt);
    this.rainStopAt = setTimeout(() => { if (!this.rainOn && p?.state === 'started') p.stop(); }, 2400);
  }

  stopAll() {
    this.swish(false);
    for (const p of [...this.live]) if (p.state === 'started') p.stop();
  }

  /* Mixer hooks: live edits persist to localStorage until baked into DEFAULT_MIX. */
  setLevel(key, db) {
    this.mix.levels[key] = db;
    // The two looping slots track their slider live; one-shots pick the new level up on next play.
    if (key === 'ambient' && this.players.ambient) this.players.ambient.volume.value = db;
    if (key === 'rain' && this.players.rain) this.players.rain.volume.value = db;
    if (key === 'drone' && this.droneLfo) this.droneLfo.max = Tone.dbToGain(db);
    if (key === 'droneLow' && this.droneLfo) this.droneLfo.min = Tone.dbToGain(db);
    if (key === 'droneRest' && this.droneOn && this.droneRest) this.droneGain.gain.rampTo(Tone.dbToGain(db), 0.1);
    // swishPl stays non-null through its fade tail (onstop clears it), so this also catches fades.
    if (key === 'swish' && this.swishPl) this.swishPl.volume.value = db;
    this.saveMix();
  }

  busGain(name) { return Tone.dbToGain(this.mix.buses[name]) * (this.userBuses[name] ?? 1); }

  applyBus(name) { this.buses?.[name]?.gain.rampTo(this.busGain(name), 0.05); }

  setBus(name, db) {
    this.mix.buses[name] = db;
    this.applyBus(name);
    this.saveMix();
  }

  /* The public per-bus faders (Ambience, Eel sounds, Environment), 0–1 linear. */
  busVolume(name) { return this.userBuses[name] ?? 1; }

  setBusVolume(name, v) {
    this.userBuses[name] = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(BUSVOL_KEY, JSON.stringify(this.userBuses)); } catch {}
    this.applyBus(name);
    this.onState?.();
  }

  saveMix() { try { localStorage.setItem(MIX_KEY, JSON.stringify(this.mix)); } catch {} }

  resetMix() {
    try { localStorage.removeItem(MIX_KEY); } catch {}
    this.mix = structuredClone(DEFAULT_MIX);
    if (this.players.ambient) this.players.ambient.volume.value = this.mix.levels.ambient;
    if (this.players.rain) this.players.rain.volume.value = this.mix.levels.rain;
    if (this.droneLfo) { this.droneLfo.max = Tone.dbToGain(this.mix.levels.drone); this.droneLfo.min = Tone.dbToGain(this.mix.levels.droneLow); }
    if (this.swishPl) this.swishPl.volume.value = this.mix.levels.swish;
    for (const n of Object.keys(this.buses ?? {})) this.applyBus(n);
  }
}
