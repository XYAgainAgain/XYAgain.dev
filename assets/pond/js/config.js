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
// Wake memory + algae cover field, RGBA16F ping-pong over the whole pool. 256 halves the texel to
// ~0.14 units, which is what stops the algae edges reading as a mosaic; the pass is still trivial.
export const WAKE_RES = 256;
export const COVER_DISCS = 48;       // surface-cover bake (mask G): up to 26 pads and 16 duckweed clumps
export const COVER_CAPS = 48;        // surface-cover bake (mask G): rush stems as shadow capsules
export const MAX_PIXELS = 2.6e6;     // internal render budget before DPR gets clamped
export const IDLE_FADE_MS = 6000;
export const NAME_LIFT = 0.2;          // world units a name tag floats above its eel's head, toward screen-up
export const STORAGE_KEY = 'xy.eels';
export const NAMES_KEY = 'xy.names';
export const QUALITY_KEY = 'xy.quality';
