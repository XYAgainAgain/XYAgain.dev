/* Seawater for the toys, free of THREE and Jolt: the coefficients Jolt's ApplyBuoyancyImpulse is handed, plus materials,
   terminal speeds, and the density tint. SI; shapes as in physics.js's addRigid (capsules and cylinders lie along local y). */

// Seawater at salinity 35 and about 20 °C.
export const SEAWATER = { rho: 1025, mu: 1.08e-3 };
export const G = 9.81;

export const WATER_KNOBS = {
  surfaceY: 0.95,    // m; the lid is at 1.0, and the trim and overflow box want a few centimeters of air under it
  floaters: 3,       // toys that float, swapped in for sinkers
  linearDrag: 1,     // multiplies every drag coefficient, for trying the feel
  angularDrag: 1,
  rolling: 0.02,     // rolling resistance on the floor: Jolt has none, and water alone lets a cylinder roll for minutes
  floorY: 0,
  tint: true,        // color toys by density
};

export const MATERIALS = {
  abs: { rho: 1060, label: 'ABS' },
  ps: { rho: 1030, label: 'polystyrene' },
  trimmed: { rho: 1025, label: 'trimmed neutral' },
  nylon: { rho: 1160, label: 'nylon' },
  pmma: { rho: 1190, label: 'acrylic' },
  pc: { rho: 1200, label: 'polycarbonate' },
  pvc: { rho: 1330, label: 'PVC' },
  granite: { rho: 2700, label: 'granite' },
  shell: { rho: 2750, label: 'shell' },
  pp: { rho: 900, label: 'polypropylene' },
  pe: { rho: 950, label: 'polyethylene' },
};

const SINKERS = [['abs', 0.5], ['nylon', 0.15], ['pmma', 0.15], ['pc', 0.1], ['pvc', 0.1]];

/* One material per toy: a sixth heavy (stone and shell by turns), a sixth near-neutral, `floaters` floating, the rest
   slow-sinking plastics, shuffled across the toys. `rng` is a stream of its own, so placements never shift. */
export function assignMaterials(rng, count, { floaters = 0 } = {}) {
  const heavy = count >= 2 ? Math.round(count / 6) || 1 : 0;
  const neutral = count >= 3 ? Math.round(count / 6) || 1 : 0;
  const floats = Math.max(0, Math.min(count - heavy - neutral, Math.floor(floaters) || 0));
  const list = [];
  for (let i = 0; i < heavy; i++) list.push(i % 2 ? 'shell' : 'granite');
  for (let i = 0; i < neutral; i++) list.push(i % 2 ? 'trimmed' : 'ps');
  for (let i = 0; i < floats; i++) list.push(i % 2 ? 'pe' : 'pp');
  while (list.length < count) {
    let r = rng.next(), pick = SINKERS[0][0];
    for (const [name, w] of SINKERS) { if (r < w) { pick = name; break; } r -= w; }
    list.push(pick);
  }
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function volume(kind, size) {
  if (kind === 'box') return 8 * size[0] * size[1] * size[2];
  if (kind === 'sphere') return (4 / 3) * Math.PI * size[0] ** 3;
  const [h, r] = size;
  return Math.PI * r * r * 2 * h + (kind === 'capsule' ? (4 / 3) * Math.PI * r ** 3 : 0);
}

/* The local bounding box's full size, as Jolt's GetLocalBounds sees it. */
export function boundsSize(kind, size) {
  if (kind === 'box') return [2 * size[0], 2 * size[1], 2 * size[2]];
  if (kind === 'sphere') return [2 * size[0], 2 * size[0], 2 * size[0]];
  const [h, r] = size;
  return [2 * r, 2 * h + (kind === 'capsule' ? 2 * r : 0), 2 * r];
}

/* The area Jolt's buoyancy call multiplies its drag by: each bounding face weighted by the flow along its normal. */
export function joltArea(kind, size, ux, uy, uz) {
  const [sx, sy, sz] = boundsSize(kind, size);
  return Math.abs(ux) * sy * sz + Math.abs(uy) * sz * sx + Math.abs(uz) * sx * sy;
}

// Newton-regime drag coefficients for blunt shapes; a sphere follows White's curve instead.
export const CD = { cube: 1.05, cylinderAxial: 0.85, cylinderCross: 0.68 };

/* White's sphere fit, good from creeping flow to Re 2×10⁵. */
export function sphereCd(re) {
  const r = Math.max(re, 1e-9);
  return 24 / r + 6 / (1 + Math.sqrt(r)) + 0.4;
}

export const equivRadius = (V) => Math.cbrt((3 * V) / (4 * Math.PI));

/* Cd·A against a flow along local unit (ux, uy, uz): the true projected area, split into the parts that face the flow
   end-on and broadside, each with its own Cd (crossflow independence). */
export function dragCdA(kind, size, ux, uy, uz, re) {
  // Blunt bodies keep their cited value at speed and gain a Stokes-like term so a creeping toy still stops.
  const visc = 24 / Math.max(re, 1e-9);
  if (kind === 'sphere') return sphereCd(re) * Math.PI * size[0] ** 2;
  if (kind === 'box') {
    const [a, b, c] = size;
    return (CD.cube + visc) * 4 * (b * c * Math.abs(ux) + a * c * Math.abs(uy) + a * b * Math.abs(uz));
  }
  const [h, r] = size, side = Math.sqrt(Math.max(0, 1 - uy * uy));
  const ends = kind === 'capsule' ? sphereCd(re) : CD.cylinderAxial + visc;
  return ends * Math.PI * r * r * (kind === 'capsule' ? 1 : Math.abs(uy)) + (CD.cylinderCross + visc) * 4 * r * h * side;
}

/* The linear drag coefficient to hand Jolt so its ½ρ·C·A_jolt·v² comes out as the true ½ρ·Cd·A·v². */
export function joltLinearDrag(kind, size, V, ux, uy, uz, speed, w = SEAWATER) {
  const re = (w.rho * speed * 2 * equivRadius(V)) / w.mu;
  const a = joltArea(kind, size, ux, uy, uz);
  return a > 0 ? dragCdA(kind, size, ux, uy, uz, re) / a : 0;
}

/* Torque coefficient K = 2T/(ρR⁵ω²) for a sphere spinning in still fluid (Dennis et al. fit, Stokes below it). */
export function spinK(reR) {
  const r = Math.max(reR, 1e-9);
  return Math.max((16 * Math.PI) / r, 6.45 / Math.sqrt(r) + 32.1 / r);
}

/* Strip-theory paddle moments ∫|n|³dA per local axis: the faces a spin swings broadside through the water. */
export function paddleMoments(kind, size) {
  if (kind === 'sphere') return [0, 0, 0];
  if (kind === 'box') {
    const [a, b, c] = size;
    return [a * (b ** 4 + c ** 4), b * (a ** 4 + c ** 4), c * (a ** 4 + b ** 4)];
  }
  const [h, r] = size, len = h + (kind === 'capsule' ? r : 0);
  return [r * len ** 4, 0, r * len ** 4];
}

/* Torque (N·m) resisting a spin of local (wx, wy, wz): skin friction on the volume-equivalent sphere plus paddle drag. */
export function spinTorque(kind, size, V, wx, wy, wz, w = SEAWATER) {
  const om = Math.hypot(wx, wy, wz);
  if (!(om > 0)) return 0;
  const R = equivRadius(V), reR = (w.rho * om * R * R) / w.mu;
  const skin = 0.5 * spinK(reR) * w.rho * R ** 5 * om * om;
  const [kx, ky, kz] = paddleMoments(kind, size);
  // Along the spin axis, so the power drawn matches the per-axis torques' sum.
  const cd = kind === 'box' ? CD.cube : CD.cylinderCross;
  const paddle = (0.5 * w.rho * cd * (Math.abs(wx) ** 3 * kx + Math.abs(wy) ** 3 * ky + Math.abs(wz) ** 3 * kz)) / om;
  return skin + paddle;
}

/* Jolt's angular drag is linear: ΔL = C·l²·m·ω·dt with l the mean bounding side. This C gives the torque above. */
export function joltAngularDrag(kind, size, V, mass, wx, wy, wz, w = SEAWATER) {
  const om = Math.hypot(wx, wy, wz);
  if (!(om > 0) || !(mass > 0)) return 0;
  const [sx, sy, sz] = boundsSize(kind, size), l = (sx + sy + sz) / 3;
  return spinTorque(kind, size, V, wx, wy, wz, w) / (l * l * mass * om);
}

/* Half the toy's height in the world: how far its lowest point sits under its center. */
export function worldHalfHeight(kind, size, qx, qy, qz, qw) {
  // The world-y components of the body's local axes, the rotation matrix's middle row.
  const rx = 2 * (qx * qy + qw * qz), ry = 1 - 2 * (qx * qx + qz * qz), rz = 2 * (qy * qz - qw * qx);
  if (kind === 'sphere') return size[0];
  if (kind === 'box') return size[0] * Math.abs(rx) + size[1] * Math.abs(ry) + size[2] * Math.abs(rz);
  const [h, r] = size;
  return h * Math.abs(ry) + (kind === 'capsule' ? r : r * Math.sqrt(Math.max(0, 1 - ry * ry)));
}

/* The extra angular coefficient for Jolt that resists a roll on the floor with c·N·lever, N the toy's weight in water. */
export function joltRollingDrag(kind, size, mass, omega, weight, lever, c) {
  if (!(omega > 0) || !(mass > 0) || !(weight > 0) || !(c > 0)) return 0;
  const [sx, sy, sz] = boundsSize(kind, size), l = (sx + sy + sz) / 3;
  return (c * weight * lever) / (l * l * mass * omega);
}

/* Jolt reads fluid density as buoyancy × mass / volume; this is the factor that makes it seawater. */
export const buoyancyFactor = (rho, w = SEAWATER) => w.rho / rho;

/* Net downward force in water, N; negative floats. */
export const weightInWater = (rho, V, w = SEAWATER) => (rho - w.rho) * V * G;

/* Steady sinking (or rising, negative) speed along local fall direction u, by bisection on weight = drag. */
export function terminalVelocity(kind, size, rho, u = [0, 1, 0], w = SEAWATER) {
  const V = volume(kind, size), F = Math.abs(weightInWater(rho, V, w));
  if (F === 0) return 0;
  const d = 2 * equivRadius(V), drag = (v) => 0.5 * w.rho * dragCdA(kind, size, u[0], u[1], u[2], (w.rho * v * d) / w.mu) * v * v;
  let lo = 0, hi = 1;
  while (drag(hi) < F && hi < 1e4) hi *= 2;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (drag(m) < F) lo = m; else hi = m; }
  return Math.sign(rho - w.rho) * (lo + hi) / 2;
}

/* How far a toy's center sits under the surface as a share of its size: 1 under, 0 clear above. */
export function submergedShare(y, surfaceY, halfHeight) {
  return Math.max(0, Math.min(1, 0.5 + (surfaceY - y) / (2 * halfHeight)));
}

/* World-y offset from the center of mass to the middle of the wet part, on the same slab model; zero once it's under. */
export function wetOffset(y, surfaceY, halfHeight) {
  return (Math.max(-halfHeight, Math.min(halfHeight, surfaceY - y)) - halfHeight) / 2;
}

// viridis reversed so lightness falls as density climbs, cut before its near-black purples so the densest toys still
// show against the dark tank; perceptually uniform and readable with any color vision.
export const RAMP = [0xfde725, 0xaddc30, 0x5ec962, 0x28ae80, 0x21918c, 0x2c728e, 0x3b528b];

/* Ramp position for a density: floaters palest, neutral a quarter in, stone near the dark end; the square roots spread
   the crowd of plastics just past neutral. */
export function densityT(rho, w = SEAWATER) {
  const s = (rho - w.rho) / rho;
  const t = s >= 0 ? 0.25 + 0.75 * Math.sqrt(s / 0.65) : 0.25 - 0.25 * Math.sqrt(-s / 0.15);
  return Math.max(0, Math.min(1, t));
}

export function rampHex(t) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  let out = 0;
  for (const sh of [16, 8, 0]) out |= Math.round(((a >> sh) & 255) * (1 - f) + ((b >> sh) & 255) * f) << sh;
  return out;
}

/* WCAG relative luminance of a hex color, for checking the ramp only ever darkens. */
export function luminance(hex) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((hex >> 16) & 255) + 0.7152 * lin((hex >> 8) & 255) + 0.0722 * lin(hex & 255);
}

/* A quaternion's inverse applied to a vector: world into the body's frame. */
export function toLocal(qx, qy, qz, qw, vx, vy, vz, out) {
  // v' = v + 2w(−q × v) + 2(−q) × (−q × v), with −q the conjugate's vector part.
  const cx = -qy * vz + qz * vy, cy = -qz * vx + qx * vz, cz = -qx * vy + qy * vx;
  out[0] = vx + 2 * (qw * cx + (-qy * cz + qz * cy));
  out[1] = vy + 2 * (qw * cy + (-qz * cx + qx * cz));
  out[2] = vz + 2 * (qw * cz + (-qx * cy + qy * cx));
  return out;
}
