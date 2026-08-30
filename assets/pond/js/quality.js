import { QUALITY_KEY } from './config.js';

/* The adaptive quality ladder's brain: one rung index with hysteresis, no renderer and no DOM.
   main.js owns what each rung actually does; this only decides when to climb or descend. */

const MAX_RUNG = 8;
const EMA_ALPHA = 0.05;
const HOT_MS = 25;                 // sustained frame time that buys a rung
const COOL_MS = 18;                // distinctly cooler, so the pond cannot oscillate around one threshold
const PROMOTE_S = 3;
const RECOVER_S = 10;              // recovery dwells longer than promotion: a pond that just healed should not re-trip
const DWELL_S = 6;                 // minimum time at any rung, both directions
const BOOT_WARMUP_S = 5;
const CHANGE_WARMUP_S = 1;         // pipeline recompiles and target reallocations spike the frames right after a rung
const SPIKE_MS = 250;

function clampRung(n) {
  const r = Math.round(n);
  return Number.isFinite(r) ? Math.max(0, Math.min(MAX_RUNG, r)) : 0;
}

function save(rung) {
  try { localStorage.setItem(QUALITY_KEY, String(rung)); } catch {}
}

export class QualityGovernor {
  constructor({ initialRung = 0, pinned = false, onChange = null } = {}) {
    this.pinned = !!pinned;
    this.onChange = onChange ?? null;
    this._rung = clampRung(initialRung);
    this._ema = 8;                 // a plausible warm start, so the first samples never read as hot
    this._hot = 0;
    this._cool = 0;
    this._sinceChange = 0;
    this._warmup = BOOT_WARMUP_S;
    // Boot applies the persisted rungs as one walk from 0, so onChange's rung walk never double-applies.
    if (this._rung > 0) this.onChange?.(this._rung, 0);
  }

  get rung() { return this._rung; }
  get ema() { return this._ema; }

  /* Once per rendered frame, raw (unclamped) frame time in ms. */
  update(frameMs) {
    if (!(frameMs > 0) || frameMs > SPIKE_MS) return;   // tab switches and window drags are not the pond's fault
    const dt = frameMs / 1000;
    this._sinceChange += dt;
    if (this._warmup > 0) { this._warmup -= dt; return; }
    this._ema += (frameMs - this._ema) * EMA_ALPHA;
    if (this.pinned) return;
    this._hot = this._ema > HOT_MS ? this._hot + dt : 0;
    this._cool = this._ema < COOL_MS ? this._cool + dt : 0;
    if (this._sinceChange < DWELL_S) return;
    if (this._hot >= PROMOTE_S && this._rung < MAX_RUNG) this._move(this._rung + 1, true);
    else if (this._cool >= RECOVER_S && this._rung > 0) this._move(this._rung - 1, true);
  }

  /* Dev override: force-walks the ladder without persisting, so a test tier never follows Sam to the next boot. */
  setRung(n) {
    const r = clampRung(n);
    if (r !== this._rung) this._move(r, false);
  }

  _move(rung, persist) {
    const prev = this._rung;
    this._rung = rung;
    this._hot = 0;
    this._cool = 0;
    this._sinceChange = 0;
    this._warmup = CHANGE_WARMUP_S;
    if (persist) save(rung);
    this.onChange?.(rung, prev);
  }

  static load() {
    try {
      const v = localStorage.getItem(QUALITY_KEY);
      return v === null ? 0 : clampRung(parseInt(v, 10));
    } catch { return 0; }
  }
}
