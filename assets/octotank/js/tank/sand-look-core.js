/* The sand's triplanar look, THREE-free: sand.js builds these formulas in TSL and the tests pin them here. */

export const SAND_LOOK = {
  triplanar: 'on',   // 'on' (three projections), 'walls' (the top plus the stronger side), 'off' (the top alone)
  roughFloor: 0.6,   // the least roughness any pebble keeps, so none is a mirror; 0 is the raw map
  // Blend exponent: the least-stretched projection faces the surface most, so a sharper blend keeps each wall on it;
  // the gravel's 33° repose is stretched less by the top projection than by a side one.
  sharpness: 8,
};
// A normal this close to straight up takes the top projection alone (four fetches); the sides fade in over
// FLAT_RAMP of normal.y below it, so the cut leaves no seam.
export const FLAT_CUT = 0.96;
export const FLAT_RAMP = 0.04;
export const AO_INTENSITY = 0.35;
export const RAW_ROUGHNESS = 0.95;

export const TRIPLANAR_RUNGS = { top: { triplanar: 'on' }, middle: { triplanar: 'walls' }, floor: { triplanar: 'off' } };
export const TRIPLANAR_MODES = { off: 0, walls: 1, on: 2 };

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const normalize = (v) => { const l = Math.hypot(...v) || 1; return v.map((a) => a / l); };

/* [wx, wy, wz] for a geometric normal: |n|^sharpness shares, the sides faded to nothing at flatCut; 'walls' keeps only the stronger side. */
export function triplanarWeights(n, { triplanar = 'on', flatCut = FLAT_CUT, ramp = FLAT_RAMP, sharpness = SAND_LOOK.sharpness } = {}) {
  const [x, y, z] = normalize(n), k = sharpness, ax = Math.abs(x) ** k, ay = Math.abs(y) ** k, az = Math.abs(z) ** k, sum = Math.max(1e-8, ax + ay + az);
  const side = triplanar === 'off' ? 0 : 1 - smoothstep(flatCut - ramp, flatCut, y);
  let wx = ax / sum * side, wz = az / sum * side;
  if (triplanar === 'walls') { if (wx >= wz) wz = 0; else wx = 0; }
  return [wx, 1 - wx - wz, wz];
}

/* The [lo, hi] a roughness map's green channel spans: the floor up to 1, or the raw 0.95 × g when the floor is 0. */
export function roughnessRange(roughFloor = SAND_LOOK.roughFloor) {
  return roughFloor > 0 ? [Math.min(1, roughFloor), 1] : [0, RAW_ROUGHNESS];
}

/* Whiteout blend of a tangent-space sample t (unpacked to −1..1) onto the geometric normal N at relief s, as a world normal.
   X projects (u, v) = (z, y), Z projects (x, y), and the top projects (x, −z), the planar mapping's orientation. */
export const whiteoutX = (t, N, s) => normalize([N[0] * Math.abs(t[2]), N[1] + t[1] * s, N[2] + t[0] * s]);
export const whiteoutZ = (t, N, s) => normalize([N[0] + t[0] * s, N[1] + t[1] * s, N[2] * Math.abs(t[2])]);
export const whiteoutY = (t, N, s) => normalize([N[0] + t[0] * s, N[1] * Math.abs(t[2]), N[2] - t[1] * s]);

export const aoOf = (r, intensity = AO_INTENSITY) => (r - 1) * intensity + 1;
