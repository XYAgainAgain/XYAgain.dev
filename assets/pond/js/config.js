// World units: the viewport is VIEW_H tall; everything else scales from that.
export const VIEW_H = 10;
export const DEPTH = 0.8;            // surface y=0, floor y=-DEPTH
export const POOL_SCALE = 2;         // simulated pool is 2× the viewport
export const SIM_RES = 512;
export const SIM_STEPS_HZ = 75;      // fixed-step wave sim, independent of refresh rate
export const SIM_DAMPING = 0.996;
export const SIM_WAVE = 0.07;          // Laplacian gain per step; 0.5 is the stability limit and looks like a bathtub
export const CAUSTIC_RES = 1024;
export const CAUSTIC_MARGIN = 1.35;  // caustic domain relative to the visible floor
export const IOR_WATER = 1.333;
export const MOON_ELEVATION = 52 * Math.PI / 180;
export const MOON_ORBIT_SECONDS = 30 * 60;
export const MOON_COLOR = [0.62, 0.74, 1.0];
export const EEL_COUNT = 6;
export const EEL_POINTS = 24;
export const INF_SLOTS = 8;          // creature influence capsules: 6 residents plus Eleanor's two chained capsules
// Context-steering ring width. At 16 the sampled directions sit wider apart than an eel is thick, so a
// passable gap can hold no slot at all; pond.eels.knobs.slots is the live A/B.
export const BRAIN_SLOTS = 32;
// Dig puffs get their own premultiplied pool: about 26 grains and 16 silt per dig, so 128 slots hold
// three overlapping digs plus a wake-up with the billows still alive.
export const SEDIMENT_POOL = 128;
// Wake memory + algae cover field, RGBA16F ping-pong over the whole pool. 256 halves the texel to
// ~0.14 units, which is what stops the algae edges reading as a mosaic; the pass is still trivial.
export const WAKE_RES = 256;
// Dig relief, on the wake buffer's footprint. A texel is ~0.14 units, which a body-width mound spans
// several of once the bilinear filter rounds it off; RELIEF_MAX is one byte's world range either way.
export const RELIEF_RES = 256;
export const RELIEF_MAX = 0.12;
// Rushes: one instanced ribbon per stem, 40–72 alive over 5–8 shoals. Neither pool ever reallocates,
// and eight shoals plus five dry rocks stay inside the mask's MAXD 24 waterline discs.
export const RUSH_POOL = 80;
export const SHOAL_MAX = 8;
export const COVER_DISCS = 48;       // surface-cover bake (mask G): up to 26 pads and 16 duckweed clumps
export const COVER_CAPS = 48;        // surface-cover bake (mask G): rush stems as shadow capsules
export const MAX_PIXELS = 2.6e6;     // internal render budget before DPR gets clamped
export const IDLE_FADE_MS = 6000;
export const NAME_LIFT = 0.2;          // world units a name tag floats above its eel's head, toward screen-up
export const STORAGE_KEY = 'xy.eels';
export const NAMES_KEY = 'xy.names';
export const QUALITY_KEY = 'xy.quality';
export const JUNK_KEY = 'xy.junk';

// One gate for every 0–1 pin and live knob: NaN, Infinity, or a non-number keeps the fallback, so a
// junk ?brain= can never poison a multiplier downstream.
export function finite01(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/* Chosen once before any request: swapping tiers mid-session means re-decoding maps already resident,
   so a settled low rung only takes effect on the next visit, via the persisted rung. */
export function chooseTextureTier({ rung = 0, mobile = false } = {}) {
  const base = mobile ? 1024 : 2048;
  return rung >= 6 ? base / 2 : base;
}
