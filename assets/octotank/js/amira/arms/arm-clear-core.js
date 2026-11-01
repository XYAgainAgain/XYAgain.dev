/* An arm chain's segments against the tank's bounded solids (the divider's pieces and the rocks), free of THREE and Jolt.
   A segment's middle can cut a solid both its ends clear, which point contact misses; chains are flat xyz, a node at 3i. */

/* The world whose cut() measures the solids: the Arms world hands its furniture's, a bare sdf world is its own. */
export function solidsOf(world) {
  if (!world) return null;
  if (world.solids) return world.solids;
  return typeof world.cut === 'function' ? world : null;
}

/* Pulls point o toward a until segment a–o is no longer than max; whether it moved. */
export function capLength(X, a, o, max) {
  const dx = X[o] - X[a], dy = X[o + 1] - X[a + 1], dz = X[o + 2] - X[a + 2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(l > max) || !(max >= 0)) return false;
  const f = max / l;
  X[o] = X[a] + dx * f; X[o + 1] = X[a + 1] + dy * f; X[o + 2] = X[a + 2] + dz * f;
  return true;
}

/* Where point o goes so segment a–o, cutting solid S.segHit by cut at S.segT (normal nrm), comes clear: across the segment,
   toward the side its last-clear self in P lay on. The target goes in out; false when the way off runs along the segment. */
export function sidePush(S, X, a, o, ra, rb, P, cut, nrm, k, reach, tmp, out) {
  const hit = S.segHit, t = S.segT;
  let nx = nrm[0], ny = nrm[1], nz = nrm[2];
  // Measured on last tick's segment, the solid's normal points to where the segment came from; a cut it has slid
  // through has a normal pointing the other way now.
  if (P && hit >= 0 && Number.isFinite(P[a] + P[a + 1] + P[a + 2] + P[o] + P[o + 1] + P[o + 2])) {
    S.depthTo(hit, P[a], P[a + 1], P[a + 2], P[o], P[o + 1], P[o + 2], ra, rb, tmp);
    if (Number.isFinite(tmp[0] + tmp[1] + tmp[2])) { nx = tmp[0]; ny = tmp[1]; nz = tmp[2]; }
  }
  const dx = X[o] - X[a], dy = X[o + 1] - X[a + 1], dz = X[o + 2] - X[a + 2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l > 1e-9) {
    const d = (nx * dx + ny * dy + nz * dz) / l;
    nx -= d * dx / l; ny -= d * dy / l; nz -= d * dz / l;
  }
  const m = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(m >= k.clearSide)) return false;
  // Moving o by s moves the point at t by t·s, so a cut near the root end asks a longer move, never past reach.
  const s = Math.min(reach, (cut + k.clearMargin) / Math.max(k.clearTMin, t)) / m;
  out[0] = X[o] + nx * s; out[1] = X[o + 1] + ny * s; out[2] = X[o + 2] + nz * s;
  return Number.isFinite(out[0] + out[1] + out[2]);
}

/* A place for point o inside the ball around a that no solid reaches (rMax the segment's thicker end), along a–o and
   between min and max from a: the last way back for a segment nothing else clears. The free ball's radius is returned. */
export function foldTarget(S, X, a, o, rMax, min, max, out) {
  const free = S.gap(X[a], X[a + 1], X[a + 2], max + rMax) - rMax, len = Math.max(min, Math.min(max, free));
  let dx = X[o] - X[a], dy = X[o + 1] - X[a + 1], dz = X[o + 2] - X[a + 2];
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l > 1e-12) { dx /= l; dy /= l; dz /= l; } else { dx = 0; dy = 1; dz = 0; }
  out[0] = X[a] + dx * len; out[1] = X[a + 1] + dy * len; out[2] = X[a + 2] + dz * len;
  return free;
}
