import { TANK } from '../config.js';

/* Her rest shell's farthest point from its center, m. */
export function bodyReach(mantle) {
  const P = mantle.shell.positions;
  let r = 0;
  for (let i = 0; i < P.length; i += 3) r = Math.max(r, Math.hypot(P[i], P[i + 1], P[i + 2]));
  return r;
}

/* How far a point is from the rock, or Infinity without one; out gets the outward normal. */
export function rockDistance(phys, x, y, z, out = [0, 0, 0]) {
  const rw = phys.rockwork;
  return rw ? rw.field.distance(x, y, z, out) : Infinity;
}

/* A destination she can stand at: her body, `reach` m from her center, clears the rock at body height over the spot, pulled
   in off the glass by the same reach. Always true without a rockwork. */
export function clearOfRock(phys, p, reach = 0.1, floorY = 0.05) {
  if (!phys.rockwork) return true;
  if (!Number.isFinite(p[0] + p[1] + p[2])) return false;
  const hw = TANK.w / 2 - reach, hd = TANK.d / 2 - reach;
  const x = Math.max(-hw, Math.min(hw, p[0])), z = Math.max(-hd, Math.min(hd, p[2])), y = Math.max(p[1], floorY + reach);
  return rockDistance(phys, x, y, z) > reach;
}
