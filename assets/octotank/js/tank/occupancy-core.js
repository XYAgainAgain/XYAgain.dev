/* The contact shadow's math, THREE-free: occupancy.js builds the same formulas in TSL, and the tests pin them here.
   The map holds her lowest surface over each spot of the floor; a receiver darkens by how close that surface is above it. */

export const OCCUPANCY_KNOBS = {
  enabled: true,
  resolution: 512,      // texels along x; z gets half (the floor is 2 × 1 m), so 512 is 3.9 mm a texel
  hz: 0,                // 0 captures on every physics tick, the only times she or a toy moves
  taps: 5,              // 5 is the cross, 1 the center alone
  strength: 1,          // how much of the fill a full contact removes
  contactDirect: 0.25,  // the share of the contact that also dims the direct light
  fade: 0.08,           // m of gap at which the shadow is gone
  rockRoofs: true,      // rock between a receiver and her blocks the contact (the rockwork world's overhangs)
};

// The shadow's shape, fixed: the knobs above are the ones worth a panel control.
export const CONTACT_SHAPE = {
  sunk: 0.03,           // m a caster may sit below a receiver (sunk into the sand) and still darken it, fading out by here
  near: 0.004,          // m: tap radius at contact
  far: 0.03,            // m: tap radius by `rise` of gap
  rise: 0.06,
  outside: 0.015,       // m: tap radius beside her silhouette, where the center tap sees nothing
};
const DEFAULTS = { ...OCCUPANCY_KNOBS, ...CONTACT_SHAPE };

// The cheaper rungs as knob values, for the quality ladder to set.
export const OCCUPANCY_RUNGS = {
  top: { enabled: true, resolution: 512, taps: 5, hz: 0 },
  middle: { enabled: true, resolution: 256, taps: 1, hz: 30 },
  floor: { enabled: false },
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/* Texel counts for a floor of w × d at a resolution along x: square texels, at least 16 along z. */
export function occupancySize(resolution, w, d) {
  const width = Math.max(32, Math.min(2048, Math.round(resolution) || OCCUPANCY_KNOBS.resolution));
  return { width, height: Math.max(16, Math.round(width * d / w)) };
}

/* How strongly a caster `gap` m above a receiver darkens it: 1 at contact, gone by `fade`; a caster below the receiver
   (sunk into the sand) counts fully to `sunk / 3` and is gone by `sunk`. */
export function contactFalloff(gap, k = DEFAULTS) {
  if (!Number.isFinite(gap)) return 0;
  if (gap >= 0) { const t = 1 - clamp01(gap / k.fade); return t * t; }
  return smoothstep(-k.sunk, -k.sunk / 3, gap);
}

/* The cross's radius: tight at contact, wider as the gap grows, and `outside` where the center sees no caster. */
export function tapRadius(gap, coverage, k = DEFAULTS) {
  const inside = k.near + (k.far - k.near) * clamp01((Number.isFinite(gap) ? gap : 0) / k.rise);
  return k.outside + (inside - k.outside) * clamp01(coverage);
}

/* One tap's height from its filtered coverage R and height-times-coverage G; uncovered taps read as no caster. */
export function tapHeight(r, g) { return r > 1e-4 ? g / r : 0; }

/* The contact factor (1 is unoccluded) from a receiver's height and its taps, each [R, G], center first. */
export function contactFactor(y, taps, k = DEFAULTS) {
  let sum = 0;
  for (const [r, g] of taps) sum += clamp01(r) * contactFalloff(tapHeight(r, g) - y, k);
  return 1 - clamp01(k.strength) * sum / Math.max(1, taps.length);
}

// Above any tank height: a column with no overhang.
export const ROOF_NONE = 8;
// m: an overhang's underside counts as below its own roof, and nothing within this of the roof counts as above it.
export const ROOF_MARGIN = 0.005;

// Undersides kept per column, one per texture channel.
export const ROOF_SLOTS = 4;

/* Per column of a baked rock field, the undersides of its overhangs (rock with water under it), lowest first, ROOF_NONE
   in unused slots; `over` counts columns with more than ROOF_SLOTS, whose highest ones are dropped. Row k runs along z. */
export function bakeRoofs(field) {
  const { nx, ny, nz, h, x0, y0, z0, codes: f } = field, roofs = new Float32Array(nx * nz * ROOF_SLOTS).fill(ROOF_NONE);
  let over = 0;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const base = i + nx * ny * k, c = (i + nx * k) * ROOF_SLOTS;
    let n = 0;
    for (let j = 1; j < ny; j++) {
      const a = f[base + nx * (j - 1)], b = f[base + nx * j];
      if (!(a >= 0 && b < 0)) continue;
      if (n < ROOF_SLOTS) roofs[c + n] = y0 + (j - 1 + a / (a - b)) * h;
      n++;
    }
    if (n > ROOF_SLOTS) over++;
  }
  return { nx, nz, h, x0, z0, roofs, over };
}

/* Whether an overhang stands between a receiver at height `y` and a caster at `caster` over (x, z), from the nearest
   column; the shader's test. */
export function roofBetween(baked, x, z, y, caster) {
  const i = Math.round((x - baked.x0) / baked.h), k = Math.round((z - baked.z0) / baked.h);
  if (!(i >= 0 && k >= 0 && i < baked.nx && k < baked.nz)) return false;
  const c = (i + baked.nx * k) * ROOF_SLOTS, m = ROOF_MARGIN;
  for (let s = 0; s < ROOF_SLOTS; s++) { const r = baked.roofs[c + s]; if (y < r + m && caster > r + m) return true; }
  return false;
}
