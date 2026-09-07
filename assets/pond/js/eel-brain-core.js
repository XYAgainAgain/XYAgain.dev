/* Context steering, the pure half. No Three, no pond: plain numbers and arrays, so the open-water
   invariant can be proved in Node on recorded force/state inputs. eel-brain.js wraps it. */

export const TAU = Math.PI * 2;
const SKIRT = Math.PI / 4;

export function wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

/* Wrapped angular distance, always in [0, pi]: a skirt measured on the raw difference grows a second
   lobe behind the eel. */
export function angDelta(a, b) { return Math.abs(wrapPi(a - b)); }

export function slotAngle(k, n) { return k * TAU / n; }

export function slotOf(a, n) {
  const k = Math.round(a / TAU * n) % n;
  return k < 0 ? k + n : k;
}

/* Linear read between slot centers, for a tangent candidate that lands off the grid. */
export function ringAt(ring, n, a) {
  const f = ((a / TAU * n) % n + n) % n;
  const k = Math.floor(f), t = f - k;
  return ring[k % n] * (1 - t) + ring[(k + 1) % n] * t;
}

export function makeRings(n) {
  return { n, interest: new Float64Array(n), danger: new Float64Array(n), blurred: new Float64Array(n), scratch: new Float64Array(n) };
}

export function clearRings(r) { r.interest.fill(0); r.danger.fill(0); }

/* Hard silhouettes only, no skirt: what an obstacle physically blocks, not what it makes unattractive.
   A tangent candidate is judged on this; the cosine skirt alone would call every gap fully blocked. */
export function hardAt(obstacles, a, count = obstacles.length) {
  let m = 0;
  for (let i = 0; i < count; i++) {
    const o = obstacles[i];
    if (angDelta(a, o.ang) <= o.alpha && o.S > m) m = o.S;
  }
  return m;
}

/* Interest sums; Fray's pyramid, weight × max(0, cos dtheta)². */
export function addInterest(ring, n, ang, weight) {
  if (!(weight > 0)) return;
  for (let k = 0; k < n; k++) {
    const c = Math.cos(slotAngle(k, n) - ang);
    if (c > 0) ring[k] += weight * c * c;
  }
}

/* Danger takes the per-slot max: a second rock behind the first adds nothing. Full strength inside the
   inflated silhouette, a cosine skirt to alpha + pi/4, then exactly zero. */
export function addDanger(ring, n, thetaC, alpha, strength, skip = null) {
  if (!(strength > 0)) return;
  const lim = alpha + SKIRT;
  for (let k = 0; k < n; k++) {
    if (skip && skip[k]) continue;
    const d = angDelta(slotAngle(k, n), thetaC);
    let v;
    if (d <= alpha) v = strength;
    else if (d < lim) v = strength * Math.cos(2 * (d - alpha));
    else continue;
    if (v > ring[k]) ring[k] = v;
  }
}

/* Flat half-ring, no skirt: the view limit is a boundary, not an obstacle with a silhouette. */
export function addDangerArc(ring, n, thetaC, half, strength) {
  if (!(strength > 0)) return;
  for (let k = 0; k < n; k++) {
    if (angDelta(slotAngle(k, n), thetaC) <= half && strength > ring[k]) ring[k] = strength;
  }
}

export function blurRing(src, dst, n, radius) {
  const r = Math.max(0, Math.min(n >> 1, Math.round(radius)));
  if (r === 0) { dst.set(src); return dst; }
  const w = 2 * r + 1;
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += src[(k + j + n) % n];
    dst[k] = sum / w;
  }
  return dst;
}

/* Heather's rule: reachability is one-sided, so a slot is judged by the worst danger on the sweep she
   would actually have to make to reach it, not by its own. */
function sweepScores(out, blurred, n, from, dir) {
  const step = TAU / n;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = from + dir * i * step;
    const k = slotOf(a, n);
    if (blurred[k] > worst) worst = blurred[k];
    out[k] = worst;
  }
  return out;
}

function scoreAtAngle(score, n, a) { return ringAt(score, n, a); }

// One reused record: adapt() runs once per eel per tick and a fresh object each time is pure garbage.
const RESULT = { heading: 0, routing: false, boxed: false, min: 0, limit: 0, slot: -1, side: 0, candidate: false };

function result(heading, routing, boxed, min, limit, slot, side, candidate) {
  RESULT.heading = heading; RESULT.routing = routing; RESULT.boxed = boxed;
  RESULT.min = min; RESULT.limit = limit; RESULT.slot = slot; RESULT.side = side; RESULT.candidate = candidate;
  return RESULT;
}

/* The adapter. cfg carries the two rings, the force heading, the focus-derived knobs, the tangent
   candidates, and last tick's context heading; nothing here reads the pond. */
export function adapt(cfg) {
  const {
    n, interest, danger, blurred, scratch,
    forceAng, tolerance = 0, floor = 0, blurRadius = 0,
    candidates = null, obstacles = null, obstacleCount = undefined, prevHeading = 0, blendA = 1,
    goalAng = null, goalWeight = 0.6,
    sweepFrom = null, sweepDir = -1, stickySide = 0,
  } = cfg;

  let min = Infinity, boxed = true;
  for (let k = 0; k < n; k++) {
    const v = danger[k];
    if (v < min) min = v;
    if (v <= 0.8) boxed = false;
  }
  const nObst = obstacleCount ?? (obstacles ? obstacles.length : 0);
  const fSlot = slotOf(forceAng, n);
  // The floor is what keeps the invariant honest in a cluttered pond: a distant rock's cosine skirt
  // raises the ring's minimum everywhere, and without it every heading reads as obstructed.
  const bypassLimit = Math.max(min + tolerance, floor);
  // A one-sided eel's reachability is the whole sweep, not the slot, so her legality has to exist
  // before the bypass or a target behind a dangerous left arc would read as open water.
  const swept = sweepFrom !== null ? sweepScores(scratch, danger, n, sweepFrom, sweepDir) : null;
  // The open-water invariant: a legal force heading is returned untouched, so every tuned behavior
  // keeps the exact vector it computes today. Boxed in, the emergency branch outranks the bypass.
  const openAhead = swept === null ? danger[fSlot] : swept[fSlot];
  if (!boxed && openAhead <= bypassLimit) {
    return result(forceAng, false, false, min, bypassLimit, fSlot, 0, false);
  }

  blurRing(danger, blurred, n, blurRadius);
  let bmin = Infinity;
  for (let k = 0; k < n; k++) if (blurred[k] < bmin) bmin = blurred[k];
  const limit = Math.max(bmin + tolerance, floor);
  const score = sweepFrom === null ? blurred : sweepScores(scratch, blurred, n, sweepFrom, sweepDir);

  if (boxed) {
    let bestK = -1, best = Infinity;
    for (let k = 0; k < n; k++) {
      if (stickySide !== 0) {
        const off = wrapPi(slotAngle(k, n) - prevHeading);
        if (off !== 0 && Math.sign(off) !== stickySide) continue;
      }
      if (score[k] < best) { best = score[k]; bestK = k; }
    }
    if (bestK < 0) for (let k = 0; k < n; k++) if (score[k] < best) { best = score[k]; bestK = k; }
    const want = slotAngle(bestK, n);
    const side = Math.sign(wrapPi(want - prevHeading)) || stickySide;
    return result(blend(prevHeading, want, blendA, score, n, limit), true, true, min, limit, bestK, side, false);
  }

  // Goal fallback: only when the resultant's own cone is fully blocked does the live target get a say.
  if (goalAng !== null) {
    let open = false;
    for (let k = 0; k < n && !open; k++) {
      if (angDelta(slotAngle(k, n), forceAng) <= Math.PI / 4 && score[k] <= limit) open = true;
    }
    if (!open) addInterest(interest, n, goalAng, goalWeight);
  }

  let bestK = -1, best = -Infinity;
  for (let k = 0; k < n; k++) {
    if (score[k] > limit) continue;
    if (interest[k] > best) { best = interest[k]; bestK = k; }
  }
  let candAng = null;
  if (candidates && obstacles) {
    for (const a of candidates) {
      // Same threshold the slots are masked with, applied to the hard field: a candidate is legal when
      // what physically blocks it is no worse than the best the ring can offer anywhere.
      if (hardAt(obstacles, a, nObst) > limit) continue;
      const v = ringAt(interest, n, a);
      if (v > best) { best = v; candAng = a; }
    }
  }

  let want;
  if (candAng !== null) want = candAng;
  // Nothing legal at all. A one-sided eel must never be handed the force heading back, because she
  // cannot reach it: give her the least-danger slot her own sweep can actually get to.
  else if (bestK < 0) want = sweepFrom === null ? forceAng : leastOnSweep(score, n);
  else {
    // Sub-slot fit, but never across a masked neighbor: interpolating through a blocked arc invents a
    // heading the ring never said was safe.
    const kp = (bestK + 1) % n, km = (bestK - 1 + n) % n;
    want = slotAngle(bestK, n);
    if (score[kp] <= limit && score[km] <= limit) {
      const a = interest[km], b = interest[bestK], c = interest[kp];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-9) {
        const off = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
        want += off * TAU / n;
      }
    }
  }
  return result(blend(prevHeading, want, blendA, score, n, limit), true, false, min, limit, bestK, 0, candAng !== null);
}

function leastOnSweep(swept, n) {
  let best = Infinity, bestK = 0;
  for (let k = 0; k < n; k++) if (swept[k] < best) { best = swept[k]; bestK = k; }
  return slotAngle(bestK, n);
}

/* Fray's global hysteresis, then the recheck: a blend that crossed a blocked arc falls back to the
   winner itself, which is legal by construction. */
function blend(prev, want, a, score, n, limit) {
  if (!(a < 1)) return want;
  const h = prev + wrapPi(want - prev) * a;
  return scoreAtAngle(score, n, h) > limit ? want : h;
}
