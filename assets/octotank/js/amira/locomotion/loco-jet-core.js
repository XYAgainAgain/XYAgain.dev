/* Jets, the swim, and the few-arm gaits without THREE or Jolt: the oxygen debt, the thrust law, the steering field, the
   dome's share while she thrusts, being adrift, and the two-arm overlap. loco-jet.js and loco-few.js run them on her
   live body; every number is a knob on tank.knobs.loco. Newtons here are sim forces on the 0.89 kg soft body. */

export const JET_KNOBS = {
  jetUrgency: 0.85,       // a startle this urgent jets; a gentler one crawls away
  vJetMin: 0.45,          // m/s at jetUrgency: the measured mean jet, 45.3 cm/s (A. aculeatus, Huffard 2006)
  vJetMax: 1.0,           // m/s at urgency 1: 70.1 cm/s measured in A. aculeatus, 100 cm/s in O. vulgaris (Wells 1990)
  jetKv: 6,               // 1/s the thrust closes a speed error at, over what holds the speed against drag
  jetMaxN: 5.3,           // N: 6 m/s² of headroom on her drawn 0.89 kg, about 0.2 s to 1 m/s
  jetMeters: 3,           // m of jetting that spends the whole oxygen debt ("more than a few meters is impossible")
  jetRecover: 30,         // s the debt takes to clear from full; recovery after a jet is unmeasured
  jetReady: 0.5,          // debt above which no new jet starts
  jetRest: 3,             // s after a jet before the next may start, however short it was: the heart restarts
  jetMaxT: 6,             // s one jet may thrust
  jetHz: 1.5,             // mantle pulses per second and their depth; both unmeasured in Octopus
  jetDepth: 0.06,
  jetSpread: 0.35,        // rad the trailing arms open from the travel's axis
  trailStiff: 1,          // the trailing arms' base and tip stiffness, as shares of stiffBehind: a short tank's jet
  trailTip: 0.1,          // lasts well under a second, so the arms must swing back fast
  jetStop: 0.15,          // m from a surface ahead, plus jetCoast of her drag coast, where thrust ends
  jetCoast: 0.5,
  jetTouch: 0.01,         // m from a surface where a jet meant to reach it ('touch') stops thrusting: she arrives at speed
  jetAlign0: 0.3,         // cos of the thrust's angle off the course where thrust starts, and where it is full
  jetAlign1: 0.8,
  alignK: 30,             // 1/s² and 1/s: the steering spring on that angle, and its damper on the axis's swing
  alignD: 8,
  jetDome: 0.2,           // share of the righting dome left on while she thrusts, so steering can lay her mantle level
  spreadDown: 0.5,        // rad below level the parachute's arms aim as she sinks after a jet
  spreadSpeed: 0.2,       // m/s under which a coasting jet's trailing arms open into the parachute
  landGap: 0.1,           // m from the crown to the floor that counts as landed, below landSpeed m/s
  landSpeed: 0.12,
  landMax: 10,            // s a glide may last before she is called landed wherever she is
  adriftR: 0.2,           // m clear of everything, with no anchor, for adriftT s: adrift
  adriftT: 1.5,
  swimMin: 0.05,          // m/s at urgency 0 and 1: the measured swim, 10.8 mean and 20.2 max cm/s (Huffard 2006)
  swimMax: 0.2,
  swimDist: 0.6,          // m: adrift and calm, a target this close is swum to head-first
  swimDebt: 0.3,          // of the jet's oxygen cost per meter, for the gentler head-first swim
  swimDepth: 0.03,
};

export const FEW_KNOBS = {
  fewHaste: 2,            // how much sooner a free arm restarts when only one or two are left
  fewOverlap: 0.15,       // s the other arm must have been planted before a walking arm lets go
  dabTime: 0.6,           // s a dabbing arm holds its touch
  dabTilt: 0.25,          // rad of tilt that calls a dab
  dabSeek: 1.2,           // s a dab has to find the floor
  hopMinT: 0.2,           // s a lone arm's push must last to count as a hop
};

export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
export function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

/* The oxygen debt: meters jetted fill it at 1/jetMeters each, and at 1 the jet must end; out of a jet it drains at
   1/jetRecover per second. A new jet waits until the debt is under jetReady and jetRest has passed. */
export class OxygenDebt {
  constructor(k = JET_KNOBS) { this.k = k; this.debt = 0; this.restT = Infinity; this.jetting = false; }
  get ready() { return !this.jetting && this.debt <= this.k.jetReady && this.restT >= this.k.jetRest; }
  get spent() { return this.debt >= 1; }
  start() {
    if (!this.ready) return false;
    this.jetting = true;
    return true;
  }
  /* Meters moved while thrusting, at `cost` of a jet's price per meter; returns whether the debt is spent. */
  add(meters, cost = 1) {
    if (Number.isFinite(meters) && meters > 0) this.debt = Math.min(1, this.debt + (meters * cost) / this.k.jetMeters);
    return this.spent;
  }
  end() { if (this.jetting) { this.jetting = false; this.restT = 0; } }
  tick(dt) {
    if (!(dt > 0) || this.jetting) return;
    this.debt = Math.max(0, this.debt - dt / this.k.jetRecover);
    this.restT += dt;
  }
}

/* The speed a jet of this urgency holds: the measured mean at jetUrgency, the top at 1. */
export function jetSpeed(urgency, k = JET_KNOBS) {
  const u = clamp((urgency - k.jetUrgency) / Math.max(1e-6, 1 - k.jetUrgency), 0, 1);
  return k.vJetMin + (k.vJetMax - k.vJetMin) * u;
}

export function swimSpeed(urgency, k = JET_KNOBS) { return k.swimMin + (k.swimMax - k.swimMin) * clamp(urgency, 0, 1); }

/* Thrust in newtons on mass M (kg) to hold speed vJet along the thrust against linear drag (1/s), with vAlong her
   speed along it now: drag's share held outright, the error closed at jetKv, never past jetMaxN, never backward. */
export function jetThrust(M, drag, vJet, vAlong, k = JET_KNOBS) {
  const F = M * k.jetKv * (vJet - (Number.isFinite(vAlong) ? vAlong : 0)) + M * drag * vJet;
  return Number.isFinite(F) ? clamp(F, 0, k.jetMaxN) : 0;
}

/* The angular acceleration (rad/s²) turning unit axis a toward unit course d: a spring on the angle between them,
   less a damper on w, the axis's own swing rate (its spin about itself is left alone). Written into out. */
export function steerAlpha(a, d, w, k, out) {
  let x = a[1] * d[2] - a[2] * d[1], y = a[2] * d[0] - a[0] * d[2], z = a[0] * d[1] - a[1] * d[0];
  const s = Math.hypot(x, y, z), c = a[0] * d[0] + a[1] * d[1] + a[2] * d[2], th = Math.atan2(s, c);
  if (s > 1e-9) { x /= s; y /= s; z /= s; }
  else if (c < 0) {
    // Facing straight away: turn about any axis across the thrust.
    x = Math.abs(a[1]) < 0.9 ? -a[2] : 0; y = Math.abs(a[1]) < 0.9 ? 0 : a[2]; z = Math.abs(a[1]) < 0.9 ? a[0] : -a[1];
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
  } else { x = 0; y = 0; z = 0; }
  const wa = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
  out[0] = k.alignK * th * x - k.alignD * (w[0] - wa * a[0]);
  out[1] = k.alignK * th * y - k.alignD * (w[1] - wa * a[1]);
  out[2] = k.alignK * th * z - k.alignD * (w[2] - wa * a[2]);
  return out;
}

/* Per-vertex accelerations α × (p − c) about her mass centroid c: a rigid turn's, so their net force is zero by
   construction and their torque is her own inertia times α. Positions P (count × 3), masses m; written into out. */
export function steerAccel(P, m, n, alpha, out) {
  let M = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { const w = m[i]; M += w; cx += w * P[i * 3]; cy += w * P[i * 3 + 1]; cz += w * P[i * 3 + 2]; }
  if (!(M > 0)) { out.fill(0, 0, n * 3); return out; }
  cx /= M; cy /= M; cz /= M;
  const ax = alpha[0], ay = alpha[1], az = alpha[2];
  for (let i = 0; i < n; i++) {
    const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz;
    out[i * 3] = ay * rz - az * ry; out[i * 3 + 1] = az * rx - ax * rz; out[i * 3 + 2] = ax * ry - ay * rx;
  }
  return out;
}

/* Takes (1 − keep) of the righting dome's lift back out, added into acc's y; the dome nets to no force already. */
export function domeCancel(dome, righting, keep, acc) {
  const g = -(1 - clamp(keep, 0, 1)) * righting;
  if (!g) return acc;
  for (let i = 0; i < dome.length; i++) acc[i * 3 + 1] += g * dome[i];
  return acc;
}

/* The adrift clock: no anchor and nothing within adriftR of her crown, for adriftT seconds. */
export function adrift(st, dist, anchors, dt, k = JET_KNOBS) {
  st.t = anchors === 0 && Number.isFinite(dist) && dist > k.adriftR ? st.t + dt : 0;
  return st.t >= k.adriftT;
}

/* How far thrust may run before she must coast: jetStop plus jetCoast of the distance her drag coasts her from speed v. */
export function stopDistance(v, drag, k = JET_KNOBS) { return k.jetStop + k.jetCoast * Math.max(0, v) / Math.max(1e-3, drag); }

/* The first hit along a ray from p in unit direction d within range, by sphere tracing distance(x, y, z, nrm); Infinity
   if none. A hit is the surface within `skin`. */
export function rayHit(distance, p, d, range, skin = 0.004, nrm = [0, 0, 0]) {
  let s = 0;
  for (let it = 0; it < 64 && s <= range; it++) {
    const r = distance(p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s, nrm);
    if (!Number.isFinite(r)) return Infinity;
    if (r <= skin) return s;
    s += Math.max(r, 0.004);
  }
  return Infinity;
}

const VOLUNTARY = new Set(['full', 'blocked', 'help', 'long']);

/* Walking on two arms, one waits to let go until the other has held its plant fewOverlap seconds, so a foot is always
   down and each arm's duty stays over half. A lost anchor still lets go. */
export function overlapHolds(why, partnerPlantedT, k = FEW_KNOBS) {
  return VOLUNTARY.has(why) && !(partnerPlantedT >= k.fewOverlap);
}
