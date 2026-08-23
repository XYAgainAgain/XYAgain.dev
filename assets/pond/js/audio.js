import * as Tone from 'tone';

/* Three slots: ambient bed, water SFX, eel SFX. Missing files fail quietly so the page
   never depends on audio being present. Nothing plays before unlock(). */
const FILES = {
  ambient: 'assets/pond/audio/ambient-pond.ogg',
  plips: ['plip-1', 'plip-2', 'plip-3', 'plip-4', 'plip-5', 'plip-6'].map((n) => `assets/pond/audio/sfx/${n}.ogg`),
  trickle: 'assets/pond/audio/sfx/trickle.ogg',
  plop: 'assets/pond/audio/sfx/plop.ogg',
  crackle: 'assets/pond/audio/sfx/eel-crackle.ogg',
  startle: 'assets/pond/audio/sfx/eel-startle.ogg',
  eat: 'assets/pond/audio/sfx/eel-eat.ogg',
};

const VOLUME_KEY = 'xy.volume';
const MUTE_KEY = 'xy.muted';

async function exists(url) {
  try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

export class PondAudio {
  constructor() {
    this.unlocked = false;
    this.master = null;
    this.players = {};
    this.lastPlip = 0;
    this.plipCount = 0;
    this.volume = this.readNumber(VOLUME_KEY, 0.7);
    this.muted = this.readBool(MUTE_KEY, false);
    this.onState = null;
  }

  readNumber(k, d) { try { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : d; } catch { return d; } }
  readBool(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } }

  /* Call from a user gesture. Builds the graph and starts the bed. */
  async unlock() {
    if (this.unlocked) return;
    await Tone.start();
    this.unlocked = true;
    this.master = new Tone.Gain(this.muted ? 0 : this.volume).toDestination();
    this.sfxBus = new Tone.Gain(0.8).connect(this.master);
    this.eelBus = new Tone.Gain(0.5).connect(this.master);
    this.loadAll().catch((err) => console.warn('Pond audio: optional file failed to load', err));
    this.onState?.();
  }

  async loadAll() {
    if (await exists(FILES.ambient)) {
      this.players.ambient = new Tone.Player({ url: FILES.ambient, loop: true, fadeIn: 2, fadeOut: 1, volume: -6 }).connect(this.master);
      await Tone.loaded();
      if (this.unlocked) this.players.ambient.start();
    }
    const plips = [];
    for (const f of FILES.plips) if (await exists(f)) plips.push(f);
    if (plips.length) {
      const urls = {}; plips.forEach((f, i) => { urls[i] = f; });
      this.players.plips = new Tone.Players({ urls, fadeOut: 0.05 }).connect(this.sfxBus);
      this.plipKeys = Object.keys(urls);
    }
    for (const key of ['trickle', 'plop', 'crackle', 'startle', 'eat']) {
      if (await exists(FILES[key])) {
        const p = new Tone.Player({ url: FILES[key], loop: key === 'trickle', fadeIn: key === 'trickle' ? 0.15 : 0, fadeOut: 0.2 });
        p.connect(key === 'crackle' || key === 'startle' || key === 'eat' ? this.eelBus : this.sfxBus);
        this.players[key] = p;
      }
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

  plip(strength = 1) {
    const p = this.players.plips;
    if (!p || !this.unlocked || !p.loaded) return;
    const now = Tone.now();
    // Spam-click ducking: rapid repeats get quieter instead of stacking into noise.
    if (now - this.lastPlip < 0.25) this.plipCount++; else this.plipCount = 0;
    this.lastPlip = now;
    const key = this.plipKeys[Math.floor(Math.random() * this.plipKeys.length)];
    const pl = p.player(key);
    pl.playbackRate = 0.9 + Math.random() * 0.25;
    pl.volume.value = -4 - Math.min(18, this.plipCount * 3) + (strength - 1) * 4;
    pl.start(now);
  }

  trickle(on) {
    const p = this.players.trickle;
    if (!p || !this.unlocked || !p.loaded) return;
    if (on && p.state !== 'started') p.start();
    else if (!on && p.state === 'started') p.stop();
  }

  one(key, rateJitter = 0.15, db = -6) {
    const p = this.players[key];
    if (!p || !this.unlocked || !p.loaded) return;
    p.playbackRate = 1 - rateJitter / 2 + Math.random() * rateJitter;
    p.volume.value = db;
    p.start(Tone.now());
  }

  plop() { this.one('plop', 0.2, -8); }
  startle() { this.one('startle', 0.3, -10); }
  crackle() { this.one('crackle', 0.3, -14); }
  eat() { this.one('eat', 0.2, -12); }
}

export const AUDIO_FILES = FILES;
