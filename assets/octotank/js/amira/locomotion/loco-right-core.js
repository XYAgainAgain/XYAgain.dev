/* Righting herself, engine-free: whether she is on her back, which way she rolls over, and how hard her arms pull.
   A real octopus rights itself with its arms in seconds; no hold ever keeps one on its back. */

export const RIGHT_KNOBS = {
  rightOn: true,
  rightDot: 0.17,         // her up below this against the support's normal (past about 100°) counts as on her back
  rightDone: 0.85,        // and above this (under about 30°) she is the right way up again
  rightNear: 0.12,        // m: her body's center this near a surface means something holds her up, not open water
  rightAfter: 0.25,       // s on her back before the reflex takes over, so a tumble in passing is left alone
  rightN: 1.2,            // N each arm base on the side she leans to pulls down with at first; 0 leaves it to the dome alone
  rightFarCoupled: 0.5,   // sharing her arms' solve, the share of that pull her far side's bases push along the roll with; 0 leaves them be
  rightReach: 0.04,       // m out past each of those arm bases to the floor point it pulls toward, mostly down, so she rolls
  rightRamp: 3,           // s over which that pull doubles while she stays over
  rightSwap: 3,           // s without her coming any further up before the arms try rolling her another way
  rightHigh: 0.3,         // m: only with her body's center under this, so a hang up the glass, mantle below her arms, is no flip
  rightStill: 1.5,        // s lying still the right way up, leaning on something, before the reflex lets her be
  rightMax: 12,           // s the reflex tries at most before it rests
  rightRest: 4,           // s it rests after giving up
};

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* Her up against the normal of what she lies on or holds: 1 upright on it, −1 flat on her back against it. */
export function supportDot(up, support) {
  const l = Math.hypot(support[0], support[1], support[2]);
  return l > 1e-9 ? dot3(up, support) / l : up[1];
}

/* The latch's next state. `hang`: she hangs from the walls the right way round; `lying`: something solid lies under her
   body, and while it does a rock flank by her crown reading as upright never ends the latch. */
export function flipped(was, dot, upY, near, hang, lying, k = RIGHT_KNOBS) {
  if (!Number.isFinite(dot)) return false;
  if (upY >= k.rightDone) return false;
  if (was) return lying || dot < k.rightDone;
  return near && (dot < -k.rightDot || (!hang && upY < -k.rightDot));
}

/* Which way her crown goes to roll her up the short way, flat on the floor; along `side`, her right, when she lies
   flat on her back with no lean to read. */
export function rollDir(up, side, out = [0, 0, 0]) {
  const s = up[1] < 0 ? -1 : 1;
  let x = s * up[0], z = s * up[2], l = Math.hypot(x, z);
  if (!(l > 0.15)) { x = side[0]; z = side[2]; l = Math.hypot(x, z); }
  if (!(l > 1e-9)) { x = 1; z = 0; l = 1; }
  out[0] = x / l; out[1] = 0; out[2] = z / l;
  return out;
}

/* The ways to try in turn when one makes no headway: the short way, either side of it, then the long way round. */
export const ROLL_TURNS = [0, Math.PI / 2, -Math.PI / 2, Math.PI];

/* dir turned by angle a about world up, in place. */
export function turnDir(dir, a) {
  const c = Math.cos(a), s = Math.sin(a), x = dir[0], z = dir[2];
  dir[0] = c * x - s * z; dir[2] = s * x + c * z;
  return dir;
}

/* Whether arm base p lies on the half of her crown ring toward dir, the half whose arms pull her over. */
export function nearSide(p, c, dir) { return (p[0] - c[0]) * dir[0] + (p[2] - c[2]) * dir[2] > 0; }

/* The arms' pull t s into the latch: rightN once the reflex takes over, doubling over rightRamp. */
export function rightPull(t, k = RIGHT_KNOBS) {
  const u = k.rightRamp > 0 ? (t - k.rightAfter) / k.rightRamp : 1;
  return t < k.rightAfter ? 0 : k.rightN * (1 + Math.max(0, Math.min(1, u)));
}
