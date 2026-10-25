/* The den's numbers, engine-free: when a bowl under her is already comfortable, how far along the dig is, the wiggle's
   envelope, and where each arm base goes as she rocks, twists, and shimmies herself down into the gravel and glides back out. */

export const DEN_KNOBS = {
  on: true,
  radius: 0.075,         // m: the bowl's lip, a little past her 0.12 m resting diameter; deeper or narrower and it slumps
  depth: 0.025,          // m at its center, inside the bed's 4 cm excavation limit
  digTime: 12,           // s of shoveling a fresh bowl takes
  minTime: 3,            // s of wiggling even into a bowl that is already there
  maxTime: 18,           // s she gives a settle before lying down in whatever she has
  comfy: 0.15,           // missing share of the bowl under which the one there already fits her
  done: 0.03,            // missing share at which the digging is finished
  stall: 0.01,           // and the share a bowl must gain within stallTime s to keep her shoveling
  stallTime: 2,
  rate: 1.4,             // Hz of the rocking
  tilt: 0.12,            // rad her crown ring rocks either way
  twist: 0.07,           // rad she screws herself back and forth about her own up
  shimmy: 0.003,         // m her arm bases slide side to side with each rock
  axisTurn: 6,           // s the rocking's axis takes to come round, so she rocks every which way
  ease: 1,               // s the wiggle swells in over and dies away over
  holdN: 2.7,            // N each arm base holds her with while she settles, the stance's own
  hunker: 0.003,         // m she presses down past the bed's drop, lying low
  exitTime: 2.5,         // s she takes to glide up out of the bowl when she sets off from it; 0 leaves it to the crawl
  exitDist: 1.4,         // radii she glides toward where she's going, her center past the rim's crest at 1.3
};

/* The flat way out of a den at (cx, cz) toward (px, pz), into out as [x, z]; null when the place lies inside minDist,
   where she'd arrive before she was out of the bowl anyway. */
export function exitWay(cx, cz, px, pz, minDist, out) {
  const dx = px - cx, dz = pz - cz, l = Math.hypot(dx, dz);
  if (!(l > minDist) || !Number.isFinite(l)) return null;
  out[0] = dx / l; out[1] = dz / l;
  return out;
}

/* How far along the glide out she is at u (0–1) of it, as a share of its distance, and that share's rate per unit u:
   eased in and out, so she neither jerks off the bowl's floor nor lands on the crawl moving. */
export function exitEase(u) {
  const v = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return { at: v * v * (3 - 2 * v), rate: 6 * v * (1 - v) };
}

/* Where an arm base that began the glide at (ax, az) goes, into out as [x, z]: turned by theta about (px, pz), her center
   when the glide began, so she faces the way her heading asks, and slid dist along the way (wx, wz). */
export function exitSpot(ax, az, px, pz, theta, wx, wz, dist, out) {
  const c = Math.cos(theta), s = Math.sin(theta), rx = ax - px, rz = az - pz;
  out[0] = px + rx * c - rz * s + wx * dist;
  out[1] = pz + rx * s + rz * c + wz * dist;
  return out;
}

/* What the bowl under her asks for: a light settle when it already fits, and the share of it still to dig. */
export function denPlan(missing, total, k = DEN_KNOBS) {
  const left = total > 0 && Number.isFinite(missing) ? Math.max(0, Math.min(1, missing / total)) : 0;
  return { left, light: left <= k.comfy };
}

/* 0 → 1 over `ease` from the start and 1 → 0 over `ease` before `end` (Infinity while the end is unknown). */
export function envelope(t, end, ease) {
  if (!(ease > 0)) return t >= 0 && t <= end ? 1 : 0;
  const a = Math.max(0, Math.min(1, t / ease)), b = Math.max(0, Math.min(1, (end - t) / ease));
  const s = (u) => u * u * (3 - 2 * u);
  return s(a) * s(b);
}

/* How much of the bowl to shovel in a step of dt at rocking phase phi: the strokes come with the rocks, averaging out to
   the whole bowl in digTime. */
export function shovelShare(dt, phi, k = DEN_KNOBS) {
  if (!(dt > 0) || !(k.digTime > 0)) return 0;
  return (dt / k.digTime) * (Math.PI / 2) * Math.abs(Math.sin(phi));
}

/* An arm base's offset from its rest target as she wiggles: (rx, rz) its flat offset from her center, phi the rocking's
   phase, psi the rocking's axis bearing, env the envelope. Into out: [dx, dy, dz]. */
export function wiggleOffset(rx, rz, phi, psi, env, k, out) {
  const s = Math.sin(phi) * env, dx = Math.cos(psi), dz = Math.sin(psi), along = rx * dx + rz * dz;
  // The twist runs at half the rocking's rate, so a rock and a screw never line up the same way twice running.
  const w = Math.sin(phi / 2) * env * k.twist;
  out[0] = -w * rz + k.shimmy * s * dx;
  out[1] = k.tilt * s * along;
  out[2] = w * rx + k.shimmy * s * dz;
  return out;
}
