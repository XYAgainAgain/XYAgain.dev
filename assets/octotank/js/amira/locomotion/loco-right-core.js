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
  rightLevel: 0.1,        // how far below level her up must dip before that reach turns back against her lean
  rightRamp: 3,           // s over which that pull doubles while she stays over
  rightSwap: 3,           // s without her coming any further up before the arms try rolling her another way
  rightHigh: 0.3,         // m: only with her body's center under this, so a hang up the glass, mantle below her arms, is no flip
  rightHang: 0.5,         // how far below level (about 30°) her up may dip on the glass and still read as hanging
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

/* Wall holds that don't mean a flip. Her up clearly above level they make a lean; with nothing under her body she hangs down to
   rightHang below level, or past it on two holds the right way round; with the floor under her, only at a wall's foot. */
export function clinging(steep, walls, upY, dot, lying, k = RIGHT_KNOBS) {
  if (!(walls >= 1)) return false;
  if (upY > k.rightDot) return true;
  // Past rightHang below level with nothing under her, only the two-hold hang the right way round holds; less lets go and rights.
  if (!lying) return upY > -k.rightHang || (walls >= 2 && dot >= -k.rightDot);
  // At a wall's foot, the floor under her body: off it by her crown (steep) on two holds, her up not turned into them and
  // dipping no more than rightHang.
  return !!steep && walls >= 2 && upY > -k.rightHang && dot >= -k.rightDot;
}

/* The latch's next state, never on while she clings. `hang`: she hangs from the walls the right way round; `lying`: something solid
   lies under her body, and while it does a rock flank by her crown reading as upright never ends the latch. */
export function flipped(was, dot, upY, near, hang, lying, k = RIGHT_KNOBS, cling = false) {
  if (!Number.isFinite(dot) || cling) return false;
  if (upY >= k.rightDone) return false;
  if (was) return lying || dot < k.rightDone;
  return near && (dot < -k.rightDot || (!hang && upY < -k.rightDot));
}

/* Turns a toward b by the share t of the arc between them, about axis (both unit, across it). A normalized sum would
   cancel and flip when they oppose; `arc` ([angle]) keeps the angle unwrapped tick to tick, so the turn never jumps. */
function arcTo(a, b, axis, t, arc, out) {
  const px = axis[1] * a[2] - axis[2] * a[1], py = axis[2] * a[0] - axis[0] * a[2], pz = axis[0] * a[1] - axis[1] * a[0];
  let phi = Math.atan2(b[0] * px + b[1] * py + b[2] * pz, b[0] * a[0] + b[1] * a[1] + b[2] * a[2]);
  const last = arc?.[0];
  if (Number.isFinite(last)) phi += 2 * Math.PI * Math.round((last - phi) / (2 * Math.PI));
  if (arc) arc[0] = phi;
  const c = Math.cos(t * phi), sn = Math.sin(t * phi);
  out[0] = c * a[0] + sn * px; out[1] = c * a[1] + sn * py; out[2] = c * a[2] + sn * pz;
  return out;
}

/* u's part across the unit axis, unit, or false when u lies along it. */
function across(u, axis, out) {
  const d = u[0] * axis[0] + u[1] * axis[1] + u[2] * axis[2];
  const x = u[0] - d * axis[0], y = u[1] - d * axis[1], z = u[2] - d * axis[2], n = Math.hypot(x, y, z);
  if (!(n > 1e-9)) return false;
  out[0] = x / n; out[1] = y / n; out[2] = z / n;
  return true;
}

const Y = [0, 1, 0], _a = [0, 0, 0], _b = [0, 0, 0], _l = [0, 0, 0];

/* Turns from `lean` to `side` across axis as the lean's length l falls under 0.15, `side` alone when there is no lean. */
function leanToSide(lean, l, side, axis, arc, out) {
  const hasSide = across(side, axis, _b);
  if (!(l > 1e-9) || !across(lean, axis, _a)) {
    if (hasSide) { out[0] = _b[0]; out[1] = _b[1]; out[2] = _b[2]; return out; }
    if (!across([1, 0, 0], axis, out)) across([0, 0, 1], axis, out);
    return out;
  }
  const t = hasSide && l < 0.15 ? 1 - l / 0.15 : 0;
  if (t > 0) return arcTo(_a, _b, axis, t, arc, out);
  if (arc) arc[0] = NaN;
  out[0] = _a[0]; out[1] = _a[1]; out[2] = _a[2];
  return out;
}

/* Downhill across her crown ring, in its plane: its lower half pulls her over, so no flip of sign as she rocks past level.
   With no downhill to read, flat on her back, it turns toward `side`, her right. */
export function rollDir(up, side, out = [0, 0, 0], arc = null) {
  _l[0] = up[1] * up[0]; _l[1] = up[1] * up[1] - 1; _l[2] = up[1] * up[2];
  return leanToSide(_l, Math.hypot(_l[0], _l[1], _l[2]), side, up, arc, out);
}

/* The ways to try in turn when one makes no headway: the short way, either side of it, then the long way round. */
export const ROLL_TURNS = [0, Math.PI / 2, -Math.PI / 2, Math.PI];

/* dir, lying across axis, turned by angle a about it in place: about her up, π pulls the upper half instead. */
export function turnDir(dir, a, axis = [0, 1, 0]) {
  const c = Math.cos(a), s = Math.sin(a), x = dir[0], y = dir[1], z = dir[2];
  const cx = axis[1] * z - axis[2] * y, cy = axis[2] * x - axis[0] * z, cz = axis[0] * y - axis[1] * x;
  dir[0] = c * x - s * cx; dir[1] = c * y - s * cy; dir[2] = c * z - s * cz;
  return dir;
}

/* Which way the level reach goes, ±1: against her lean on her back, with it from level up, and between, the last one
   holds. Flipping at level itself, every pull swapped each tick she rocked across it, and the patch drive bucked. */
export function rollSense(upY, last = 0, k = RIGHT_KNOBS) {
  return upY >= 0 ? 1 : upY < -k.rightLevel || !last ? -1 : last;
}

/* The level way the bases reach to the floor, unit: along her lean by sense, turning toward `side` as she lies flat. */
export function rollReach(up, side, sense, out = [0, 0, 0], arc = null) {
  _l[0] = sense * up[0]; _l[1] = 0; _l[2] = sense * up[2];
  return leanToSide(_l, Math.hypot(_l[0], _l[2]), side, Y, arc, out);
}

/* Whether arm base p lies on the half of her crown ring toward dir, the half whose arms pull her over. */
export function nearSide(p, c, dir) { return (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1] + (p[2] - c[2]) * dir[2] > 0; }

/* The arms' pull t s into the latch: rightN once the reflex takes over, doubling over rightRamp. */
export function rightPull(t, k = RIGHT_KNOBS) {
  const u = k.rightRamp > 0 ? (t - k.rightAfter) / k.rightRamp : 1;
  return t < k.rightAfter ? 0 : k.rightN * (1 + Math.max(0, Math.min(1, u)));
}
