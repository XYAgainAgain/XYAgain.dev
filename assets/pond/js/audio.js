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
};
// Sounds the eels make ride the eel bus; player-made water and pond environment ride env.
const EEL_SETS = new Set(['startles', 'eleanor', 'crackles', 'eats', 'slurps', 'tinyBubs']);
// drippy-pond-rain.ogg is reserved for the future rain-shower feature (env bus).

/* Mixed by ear via ?mixer=1; the panel still overrides these per-browser via localStorage. */
const DEFAULT_MIX = {
  buses: { ambience: 0, eel: 0, env: 0 },
  levels: {
    ambient: -2.5,
    plip: -5, swish: -1.5, plopBig: -2, plopSmol: -2,
    startle: -10, eleanorStartle: -8,
    crackleLil: -2.5, crackleMed: -2.5, crackleBig: -2.5,
    eat: -3, slurp: -3, tinyBub: -18, shortBub: -15,
  },
};

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
    this.tracks = new Map();       // creature id -> persistent Panner on the eel bus
    this.live = new Set();         // in-flight throwaway players, for stopAll()
    this.swishPl = null;
    this.swishPanner = null;
    this.lastPlip = 0;
    this.plipCount = 0;
    this.tetrisIdx = 0;
    this.lastSmol = 0;
    this.crackleAt = 0;
    this.eleanorAt = 0;
    this.bubAt = 0;
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

  /* Call from a user gesture. Builds the graph and starts the bed. */
  async unlock() {
    if (this.unlocked) return;
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
    this.swishPanner = new Tone.Panner(0).connect(this.buses.env);
    this.loadAll();
    this.onState?.();
  }

  loadAll() {
    const warn = (name) => (err) => console.warn(`Pond audio: ${name} failed to load`, err);
    this.players.ambient = new Tone.Player({
      url: `${BASE}ambient-pond.ogg`, loop: true, fadeIn: 2, fadeOut: 1, volume: this.mix.levels.ambient,
      onload: () => { if (this.unlocked) this.players.ambient.start(); },
      onerror: warn('ambient'),
    }).connect(this.buses.ambience);
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

  /* Lazy per-creature Panner so a long sound keeps tracking its owner across the screen. */
  trackPanner(id) {
    let tr = this.tracks.get(id);
    if (!tr) { tr = new Tone.Panner(0).connect(this.buses.eel); this.tracks.set(id, tr); }
    return tr;
  }

  setTrackPan(id, pan) {
    if (!this.unlocked) return;
    this.trackPanner(id).pan.value = Math.max(-1, Math.min(1, pan));
  }

  swishPan(pan) { if (this.swishPanner) this.swishPanner.pan.value = Math.max(-1, Math.min(1, pan)); }

  /* Spawn one throwaway Player over the set's shared buffer. opts: db (level offset),
     jitter (pitch spread), rate (pitch multiplier), pan (static), track (creature panner id),
     trim (random start/length, for small sample pools like Eleanor's). */
  shot(set, key, levelKey, { db = 0, jitter = 0.15, rate = 1, pan = null, track = null, trim = false } = {}) {
    if (!this.unlocked) return null;
    const src = this.players[set]?.player(String(key));
    if (!src?.loaded) return null;
    const buf = src.buffer;
    const p = new Tone.Player(buf);
    p.playbackRate = rate * (1 - jitter / 2 + Math.random() * jitter);
    p.volume.value = this.mix.levels[levelKey] + db;
    p.fadeIn = trim ? 0.03 : 0;
    p.fadeOut = trim ? 0.15 : 0.05;
    let panner = null;
    const bus = EEL_SETS.has(set) ? this.buses.eel : this.buses.env;
    if (track != null) p.connect(this.trackPanner(track));
    else if (pan != null) { panner = new Tone.Panner(Math.max(-1, Math.min(1, pan))).connect(bus); p.connect(panner); }
    else p.connect(bus);
    this.live.add(p);
    p.onstop = () => { this.live.delete(p); setTimeout(() => { panner?.dispose(); p.dispose(); }, 250); };
    let offset = 0, dur;
    if (trim) { offset = Math.random() * 0.1 * buf.duration; dur = (0.7 + Math.random() * 0.3) * (buf.duration - offset); }
    p.start(Tone.now(), offset, dur);
    return p;
  }

  pick(set, levelKey, opts) {
    return this.shot(set, Math.floor(Math.random() * SETS[set].length), levelKey, opts);
  }

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

  startle({ length, pan = null } = {}) {
    this.pick('startles', 'startle', { jitter: 0.2, rate: this.rateForLength(length), pan });
  }

  /* The big girl's chunky startle: throttled, and trimmed/jittered since there's only one file. */
  eleanorStartle({ pan = null } = {}) {
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

  /* size 1 = big treat, 2 = crumb, 3 = tiny; rate 0.5 drops Eleanor's an octave. */
  eat(size = 2, { pan = null, rate = 1 } = {}) {
    this.shot('eats', Math.min(3, Math.max(1, size)) - 1, 'eat', { jitter: 0.3, rate, pan });
  }

  slurp({ pan = null } = {}) { this.pick('slurps', 'slurp', { jitter: 0.2, trim: true, pan }); }

  /* Nibble/surface bubbles; lightly throttled so a dinner circle stays bubbly, not fizzy. */
  tinyBub({ pan = null } = {}) {
    const now = Tone.now();
    if (now - this.bubAt < 0.15) return;
    this.bubAt = now;
    this.pick('tinyBubs', 'tinyBub', { jitter: 0.3, pan });
  }

  shortBub({ pan = null } = {}) { this.pick('shortBubs', 'shortBub', { jitter: 0.25, pan }); }

  stopAll() {
    this.swish(false);
    for (const p of [...this.live]) if (p.state === 'started') p.stop();
  }

  /* Mixer hooks: live edits persist to localStorage until baked into DEFAULT_MIX. */
  setLevel(key, db) {
    this.mix.levels[key] = db;
    // The two looping slots track their slider live; one-shots pick the new level up on next play.
    if (key === 'ambient' && this.players.ambient) this.players.ambient.volume.value = db;
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
    if (this.swishPl) this.swishPl.volume.value = this.mix.levels.swish;
    for (const n of Object.keys(this.buses ?? {})) this.applyBus(n);
  }
}
