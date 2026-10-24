/* Locomotion without THREE or Jolt: the spring law, stroke limits, foot placement, recruitment, arrival, stall, and the
   heading term. locomotion.js runs it on her live body and arms; every number here is a knob on tank.knobs.loco. */

export const LOCO_KNOBS = {
  enabled: true,
  wander: true,
  speedCalm: 0.05,        // m/s at urgency 0, under the measured crawl means of 7.3 and 9 cm/s
  speedHurried: 0.19,     // m/s at urgency 1, under the measured 21.3 cm/s crawl maximum
  arriveR: 0.08,          // m, about half her mantle
  wallStandoff: 0.06,     // m her crown can't get closer to a wall than, added to arriveR when a place is up a wall
  capCalm: 2.7,           // N per planted arm at urgency 0 and 1, sized to her drawn 0.89 kg: 1.77× the caps that set her
  capHurried: 8.9,        // pace at 0.5 kg, so a stroke accelerates her as much
  capHaul: 14,
  anchorSafety: 0.6,      // share of the anchor's sealed hold an arm may pull with
  helpMin: 0.25,          // an arm whose line lies this far off the travel no longer helps
  toneK: 0,               // 1/s² pulling free patches toward their rest shape; momentum-neutral, off unless the ring folds
  yawGain: 4,             // heading error (rad) times a root's radius times this, as a tangential offset on its target
  yawMax: 0.05,           // m, the most that offset gets: about 1.8 N on a patch, the 0.2 N/cm measured at 0.5 kg scaled with her mass
  stallShare: 0.2,        // stalled while the crown makes under this share of the wanted speed along the travel
  stallT: 1.5,            // s stalled before recruitment widens
  stallPull: 4,           // s before the front arms would reach ahead for a hold (with a pull mode registered)
  stallGiveUp: 10,        // s before the desire is dropped
  stallTau: 0.3,          // s smoothing on the crown's speed the stall reads
  footArc: 0.18,          // m along the arm where a push stroke's foot goes down
  footBias: 0.3,          // how far behind the travel the foot is set, against the arm's own bearing
  footTol: 0.08,          // m of arc a sealed anchor may lie off the foot and still plant
  footPress: 0.5,         // of the arm's radius at the foot: how far into the surface the seek aims
  seekMax: 2.5,           // s a foot has to seal before the stroke gives up
  seekCool: 0.8,          // s an arm waits after a failed seek
  hazardBase: 5,          // 1/s, the rate an eligible arm starts a stroke at full urgency and usefulness
  steer: 1,               // how much an arm whose push would cancel her sideways drift is preferred
  pushersCalm: 3,         // pushers wanted at once, calm and hurried; the rate law caps her speed, more fill the gaps
  pushersHurried: 4,
  crowdFall: 0.25,        // the hazard's factor per pusher past the wanted count
  extend: 0.95,           // share of the arm's full stretch a push runs to
  leadMax: 0.06,          // m the rest length may run ahead of the chord, so a blocked body never winds the spring up
  anchorGrace: 0.3,       // s a planted anchor survives with none of its segments sealed
  strokeMax: 8,           // s a stroke may last
  recoverCalm: 0.5,       // per second in stretch, calm and hurried
  recoverHurried: 1.0,
  recoverMax: 2.5,        // s a recovering arm waits for its stretch at most
  recoverTol: 0.03,       // stretch over rest a recovered arm may keep
  floorCos: 0.7,          // a support whose normal is this near up is a floor
  climbSin: 0.42,         // a travel this steep is a climb
  stationN: 0.9,          // N a station hold pulls with
  stations: 3,            // stations at most at once; she plants them to turn on the spot
  stationRate: 0,         // 1/s an idle arm on the furniture becomes a station unasked (off: stations are for turning)
  stationMax: 30,         // s a station lasts
  stationLinger: 1,       // s stations stay after a turn on them has finished
  stanceN: 2.7,           // N each patch holds her body where it settled while she stands still
  stanceSpeed: 0.01,      // m/s under which her crown counts as settled
  stanceSettle: 0.5,      // s settled before the stance takes hold
  turnCap: 2.7,           // N a station may pull with while she turns on it
  pairWeights: [0.3, 0.5, 1.0, 0.9, 0.9, 1.0, 0.5, 0.3],   // by arm: pair 3 pushes most, then 4, 2, and 1
  wanderMin: 8,           // s between her own destinations, at random in this range
  wanderMax: 20,
  wanderUrgency: 0.25,
  dwellMin: 3,            // s she stays with what she went to
  dwellMax: 8,
  glassShare: 0.3,        // share of her own picks that may go to the glass (never two running)
  glassLo: 0.1,           // m up the glass a wandering look lands, at random in this range
  glassHi: 0.6,
};

export const ROLE = { idle: 0, seek: 1, planted: 2, recover: 3, station: 4, busy: 5, cool: 6 };
export const ROLE_NAMES = ['idle', 'seek', 'planted', 'recover', 'station', 'busy', 'cool'];

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
export function wrap(a) { return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI)); }

/* The root target on the line from anchor A through root p at rest length ell; writes the unit line into u and returns
   the chord |p − A|. A root on its anchor takes the anchor's normal n as its line. */
export function springTarget(p, A, ell, out, u, n = null) {
  let ux = p[0] - A[0], uy = p[1] - A[1], uz = p[2] - A[2];
  const c = Math.hypot(ux, uy, uz);
  if (c > 1e-9 && Number.isFinite(c)) { ux /= c; uy /= c; uz /= c; }
  else if (n && Math.hypot(n[0], n[1], n[2]) > 1e-9) { const l = Math.hypot(n[0], n[1], n[2]); ux = n[0] / l; uy = n[1] / l; uz = n[2] / l; }
  else { ux = 0; uy = 1; uz = 0; }
  u[0] = ux; u[1] = uy; u[2] = uz;
  out[0] = A[0] + ux * ell; out[1] = A[1] + uy * ell; out[2] = A[2] + uz * ell;
  return Number.isFinite(c) ? c : 0;
}

/* How fast an arm's rest length moves for the body velocity v she wants: its projection on the arm's line, so pushers
   on different lines never fight. Positive pushes her off the hold, negative hauls her to it. */
export function strokeRate(v, u) { return v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; }

/* The longest a stroke's rest length runs: `extend` of the full stretch of the segments from the root to the anchor. */
export function ellMax(len0, lamMax, seg, extend = LOCO_KNOBS.extend) {
  let s = 0;
  for (let j = 0; j <= seg && j < len0.length; j++) s += len0[j] * lamMax[j];
  return extend * s;
}

/* The segment holding arc s along an arm with rest arcs arc0 (one per point). */
export function segAtArc(arc0, s) {
  let j = 0;
  while (j < arc0.length - 2 && s >= arc0[j + 1]) j++;
  return j;
}

/* The flat unit travel from c toward t into d (y 0); returns the flat distance, with d zeroed when there is none. */
export function flatDir(c, t, d) {
  const dx = t[0] - c[0], dz = t[2] - c[2], l = Math.hypot(dx, dz);
  if (l > 1e-6 && Number.isFinite(l)) { d[0] = dx / l; d[1] = 0; d[2] = dz / l; return l; }
  d[0] = 0; d[1] = 0; d[2] = 0;
  return Number.isFinite(l) ? l : 0;
}

/* Where a push's foot goes down: footArc out along the arm's flat bearing n, tilted behind the travel d by footBias,
   then dropped onto the surface through `distance(x, y, z, normalOut)`. Null when it can't. */
export function footTarget(root, n, d, k, out, distance = null, nrm = [0, 1, 0]) {
  let fx = n[0] - k.footBias * d[0], fz = n[2] - k.footBias * d[2];
  const l = Math.hypot(fx, fz);
  if (!(l > 1e-6)) return null;
  fx /= l; fz /= l;
  out[0] = root[0] + fx * k.footArc; out[1] = root[1]; out[2] = root[2] + fz * k.footArc;
  if (distance) {
    for (let it = 0; it < 3; it++) {
      const s = distance(out[0], out[1], out[2], nrm);
      if (!Number.isFinite(s)) return null;
      if (Math.abs(s) < 1e-5) break;
      out[0] -= nrm[0] * s; out[1] -= nrm[1] * s; out[2] -= nrm[2] * s;
    }
  }
  return Number.isFinite(out[0] + out[1] + out[2]) ? out : null;
}

/* How much an arm with flat outward bearing n helps a push toward d: its pair's weight times how far it points behind.
   With `lat` and `steer`, an arm on the side she drifts toward, whose push sends her back, helps more (Levy et al. 2015). */
export function usefulness(n, d, w = 1, lat = null, steer = 0) {
  const base = -(n[0] * d[0] + n[2] * d[2]);
  return w * (lat ? base + steer * (n[0] * lat[0] + n[2] * lat[2]) : base);
}

export function wantPushers(urgency, k = LOCO_KNOBS) { return Math.round(lerp(k.pushersCalm, k.pushersHurried, clamp(urgency, 0, 1))); }

export function crowd(active, want, fall = LOCO_KNOBS.crowdFall) { return active < want ? 1 : Math.pow(fall, active - want + 1); }

/* An eligible arm's rate of starting a stroke, per second. */
export function hazard(urgency, use, crowdF, k = LOCO_KNOBS, widen = false) {
  const h = k.hazardBase * clamp(urgency, 0, 1) * Math.max(0, use) * crowdF;
  return widen ? 2 * h : h;
}

/* One seeded draw of whether a hazard h fires within dt; `rng.next` is uniform on [0, 1). */
export function fires(rng, h, dt) { return h > 0 && rng.next() < 1 - Math.exp(-h * dt); }

/* Why a planted push stroke ends, or null: its anchor lost, its rest length or the chord at full extension, its line
   no longer helping, or it ran too long. `along` is u · d, positive while the arm pushes her along the travel. */
export function releaseReason({ ell, max, chord, along, helpMin, lostT, grace, t, tMax }) {
  if (lostT > grace) return 'lost';
  if (ell >= max) return 'full';
  if (chord >= max) return 'blocked';
  if (along < helpMin) return 'help';
  if (t > tMax) return 'long';
  return null;
}

/* Push off a floor, pull on anything steeper or for a steep travel; n the support's normal, d the unit travel. */
export function surfaceMode(n, d, k = LOCO_KNOBS) {
  return n[1] > k.floorCos && Math.abs(d[1]) < k.climbSin ? 'push' : 'pull';
}

/* A planted arm's cap: the urgency's, or what its sealed hold safely bears if that is less. */
export function capFor(urgency, anchorForce, k = LOCO_KNOBS) {
  return Math.min(lerp(k.capCalm, k.capHurried, clamp(urgency, 0, 1)), k.anchorSafety * Math.max(0, anchorForce));
}

/* A place arrives when the crown is within r of it, flat on the floor, in 3D on a wall. */
export function arrivedPlace(c, t, r, flat = true) {
  const dx = t[0] - c[0], dy = flat ? 0 : t[1] - c[1], dz = t[2] - c[2];
  return Math.hypot(dx, dy, dz) <= r;
}

/* An object arrives when an arm is tasting that very thing, never by its tag (every toy tastes of 'toy'). */
export function arrivedEpisode(episodes, entry) {
  if (!entry) return -1;
  for (let a = 0; a < episodes.length; a++) if (episodes[a] && episodes[a].toy === entry) return a;
  return -1;
}

/* Furniture arrives when a sealed anchor lies on that very piece; `entries` is one per anchor. */
export function arrivedFurniture(entries, count, entry) {
  if (!entry) return -1;
  for (let i = 0; i < count; i++) if (entries[i] === entry) return i;
  return -1;
}

/* The stall clock: the crown's speed along the travel, smoothed, against the wanted speed. Returns 0 moving, 1 widen,
   2 try pulling, 3 give up. */
export function stallStep(st, along, want, dt, k = LOCO_KNOBS) {
  if (!(want > 0) || !(dt > 0)) { st.t = 0; return 0; }
  st.ema += ((Number.isFinite(along) ? along : 0) - st.ema) * (1 - Math.exp(-dt / Math.max(1e-3, k.stallTau)));
  st.t = st.ema < k.stallShare * want ? st.t + dt : 0;
  return st.t >= k.stallGiveUp ? 3 : st.t >= k.stallPull ? 2 : st.t >= k.stallT ? 1 : 0;
}

/* The heading term on a planted root at flat offset (rx, rz) from the crown's center: tangential, turning her toward
   positive yaw (from +x toward +z) for a positive error, clamped to max. Written into out. */
export function yawTerm(rx, rz, eYaw, k, out) {
  const r = Math.hypot(rx, rz);
  out[0] = 0; out[1] = 0; out[2] = 0;
  if (!(r > 1e-6) || !Number.isFinite(eYaw)) return out;
  const m = clamp(k.yawGain * eYaw * r, -k.yawMax, k.yawMax);
  out[0] = (-rz / r) * m; out[2] = (rx / r) * m;
  return out;
}

/* Tone on free patches: each vertex of an arm in mode 0 is pulled toward its rest offset in her live body frame (axes
   f, u, s at crown center c; offsets from the rest center c0). Raw: the caller neutralizes it. */
export function toneAccel(P, origin, rest, c0, c, F, driven, drivenArm, armMode, K, out) {
  out.fill(0);
  if (!(K > 0)) return out;
  const f = F.f, u = F.u, s = F.s;
  for (let d = 0; d < driven.length; d++) {
    if (armMode[drivenArm[d]] !== 0) continue;
    const i = driven[d] * 3, ox = rest[i] - c0[0], oy = rest[i + 1] - c0[1], oz = rest[i + 2] - c0[2];
    const tx = c[0] + ox * f[0] + oy * u[0] + oz * s[0], ty = c[1] + ox * f[1] + oy * u[1] + oz * s[1], tz = c[2] + ox * f[2] + oy * u[2] + oz * s[2];
    out[i] = K * (tx - P[i] - origin[0]); out[i + 1] = K * (ty - P[i + 1] - origin[1]); out[i + 2] = K * (tz - P[i + 2] - origin[2]);
  }
  return out;
}

/* The angle (radians) of the crown's velocity off her body axis; NaN when either is too small to have a direction. */
export function crawlAngle(v, front) {
  const sp = Math.hypot(v[0], v[2]), fl = Math.hypot(front[0], front[2]);
  if (!(sp > 1e-6 && fl > 1e-6)) return NaN;
  return wrap(Math.atan2(v[2], v[0]) - Math.atan2(front[2], front[0]));
}
