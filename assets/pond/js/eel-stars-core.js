/* The CPU half of Shelley's three families: the star size classes, the integer cell grids the shader
   tiles over the body, and the fit invariant. THREE-free so node --test can reach it. */

// cell is world units; radius and rim are cell units; density is the fraction of cells holding a star.
// Density falls as size rises so coverage stays similar across rolls: no bald eel, no wallpaper.
export const STAR_CLASSES = [
  { name: 'small', cell: 0.065, radius: 0.26, rim: 0.10, density: 0.5 },
  { name: 'medium', cell: 0.10, radius: 0.29, rim: 0.10, density: 0.45 },
  { name: 'large', cell: 0.15, radius: 0.30, rim: 0.09, density: 0.4 },
];

export const STAR_METAL_ODDS = 0.5;   // a fair coin per reroll, silver or gold
export const STAR_SIZE_JITTER = 0.35;  // the outer radius rolls 0.65–1.35× per star
export const SWIRL_FREQ = [3.5, 5.5];   // noise cells along the body; fewer than 3 is one pool, not marble
export const FACET_TILT = [25, 40];   // degrees; some Shelleys flash more readily than others

const clampClass = (i) => Math.min(STAR_CLASSES.length - 1, Math.max(0, Math.round(i) || 0));

// Integer counts are the whole point: a fractional count around the girth tears the pattern open at
// ang = 2pi, and uRoll wraps straight through that seam.
const cellCounts = (length, radius, cell) => ({
  along: Math.max(1, Math.round(length / cell)),
  around: Math.max(1, Math.round((2 * Math.PI * radius) / cell)),
});

export function starLayout(length, radius, classIndex) {
  const c = STAR_CLASSES[clampClass(classIndex)];
  const { along, around } = cellCounts(length, radius, c.cell);
  return {
    name: c.name, cell: c.cell, cellsAlong: along, cellsAround: around,
    radius: c.radius, rim: c.rim, density: c.density,
  };
}

// Half-extent of the biggest a star in this class can get, rim included, in cell units.
export function starExtent(radius, rim) { return radius * (1 + STAR_SIZE_JITTER) + rim; }

// A star may sit anywhere in its cell (half a cell of jitter each way) and the shader only tests the
// four nearest cells, so its reach from the cell center must stay within one cell: extent ≤ 0.5.
export function starFits(radius, rim) { return starExtent(radius, rim) <= 0.5; }

export const GLITTER = { cell: 0.018, density: 0.35, deepScale: 1.6 };

/* Two fleck grids at different scales; the deeper one reads as flecks further down in the liquid. */
export function glitterLayout(length, radius, cell = GLITTER.cell, deepScale = GLITTER.deepScale) {
  const c = cell > 0 ? cell : GLITTER.cell;
  const s = deepScale > 0 ? deepScale : GLITTER.deepScale;
  return { surface: cellCounts(length, radius, c), deep: cellCounts(length, radius, c * s) };
}

// Integer noise cells around the girth, so the periodic fbm closes the seam under any roll. Square
// cells would give a thin eel well under one cell around, and one cell is a band, not a marble.
export const SWIRL_MIN_AROUND = 2;
export function swirlAround(length, radius, freq) {
  const square = length > 0 ? (2 * Math.PI * radius * freq) / length : 0;
  return Math.max(SWIRL_MIN_AROUND, Math.round(square));
}
// The CPU scroll wraps here; with the deep layer at half rate both fleck grids shift by whole
// multiples of the shader's 1024-cell hash period, so the wrap is invisible.
export const GLITTER_SCROLL_WRAP = 2048;
export const GLITTER_HASH_PERIOD = 1024;
export const GLITTER_DEEP_DRIFT = 0.5;
