// Tank interior in meters; Jolt works in SI.
export const TANK = { w: 2.0, h: 1.0, d: 1.0 };
export const WALL = 0.05;
export const FIXED_DT = 1 / 60;
// A long frame never buys a third step; the ladder drops quality instead (Osminoktopus plan, Physics).
export const MAX_SUBSTEPS = 2;
export const GRAVITY = -9.81;

// Object layers. ARMS never meet MANTLE: a root capsule sits on the very vertex it is pinned to.
export const LAYERS = { NON_MOVING: 0, TOYS: 1, MANTLE: 2, ARMS: 3, COUNT: 4 };

export function finite01(v, fallback) {
  const n = +v;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
