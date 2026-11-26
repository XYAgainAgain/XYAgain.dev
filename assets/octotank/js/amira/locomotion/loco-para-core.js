/* Jet hops and the parachute, without THREE or Jolt: a hop's course (up to its apex, then level), when thrust may end so
   her coast carries her onto the target, where a parachute arm aims (out and down, the arms facing the landing turned to
   reach for it), and how a landing scores. loco-hop.js flies them; every number is a knob on tank.knobs.hop. */

export const PARA_KNOBS = {
  on: true,
  speed: 0.45,            // m/s a hop holds: the measured mean jet (JET_KNOBS.vJetMin)
  ramp: 0.25,             // s her thrust takes to build at launch, the mantle's first squeeze, so a hop doesn't kick off
  apex: 0.15,             // m above her launch the course climbs to before it levels out
  climb: 1.1,             // the course's rise per unit across while she is under the apex: a launch about 48° up
  sideK: 1.5,             // how hard the course leans against her sideways drift, per unit of it over her speed
  coastT: 0.4,            // s: her drag coast's length per m/s of flat speed (measured 0.34–0.42 on long glides)
  sinkV: 0.12,            // m/s she sinks at on the parachute, for how long the coast has before she touches down
  restH: 0.055,           // m her mass centroid sits over the floor at rest
  cutSlack: 0.03,         // m short of the target thrust may end: the reaching arms take up the rest
  overMax: 1.8,           // a hop's thrust never runs past this many times its flat distance
  clear: 0.13,            // m her centroid keeps off anything but the floor along the course's middle; the apex rises until
  clearEnds: 0.15,        // it does, or stays put if no height clears. The course's first and last clearEnds m aren't checked
  apexStep: 0.03,         // m the apex rises per try, up to apexMax over her launch
  apexMax: 0.35,
  lean: 1.0,              // rad her body pitches under the course while she thrusts, so the mantle leads, not the head
  align0: 0.3,            // cos of her body's angle off that pose where thrust starts, and where it is full (the jet's own 0.3,
  align1: 0.8,            // 0.8 by default; nearer 1, she pitches over before she goes)
  letGo: true,           // the arms she launches with release their seals at once
  trailLift: 0.2,        // rad above level the arms stream back while she flies, so they leave the sand behind her
  trailSpread: 0.2,       // rad the streaming arms open around that line: a tighter bundle than a plain jet's
  paraDown: 0.35,         // rad below level the parachute's arms aim: wide, so the web opens
  paraSpeed: 0.25,        // m/s under which the trailing arms open into the parachute
  right: 1,               // share of the jet's steering spring that turns her belly-down once the thrust ends
  landNear: true,         // the glide ends only once her centroid is down near the floor, not on the first sealed tip
  landMax: 4,             // s the glide may last before she is called landed wherever she is
  landPlant: false,       // arms sealed on the floor at touchdown become stations, as a plain jet's do: a turn on stations
                          // planted that near her root pops them over and over, so a hop lands on its arms and lets them be
  reachR: 0.4,            // m from the target under which the arms facing it start turning to reach for it
  reachShare: 0.65,       // how far those arms turn from the parachute's aim toward the target, at the full reach
  reachCos0: 0.0,         // cos of an arm's bearing off the target's under which it doesn't reach, and over which it fully does
  reachCos1: 0.7,
  roam: true,             // restless, she skips her own destinations nearer than a hop (TRAVEL_KNOBS.hopMin) while any farther remain
  landR: 0.15,            // m from the target a landing counts as on it
  upright: 0.7,           // her body's up (y) over which she landed right side up
};

export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
export function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

function unit(x, y, z, out) {
  const l = Math.hypot(x, y, z);
  if (!(l > 1e-9)) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/* The unit course from centroid c toward floor target p: leaning against sideways drift in velocity v, rising `climb` per
   unit while under top (m), easing level as she reaches it. Written into out; returns the flat distance left. */
export function hopCourse(c, p, top, k = PARA_KNOBS, out = [0, 0, 0], v = null) {
  const dx = p[0] - c[0], dz = p[2] - c[2], flat = Math.hypot(dx, dz);
  const rise = k.climb * clamp((top - c[1]) / Math.max(1e-3, k.apex), 0, 1);
  if (!(flat > 1e-6)) { out[0] = 0; out[1] = rise > 0 ? 1 : 0; out[2] = 0; return 0; }
  const ux = dx / flat, uz = dz / flat;
  let ax = ux, az = uz;
  if (v && k.sideK > 0) {
    // Sideways is n = (−uz, ux); the course leans to −n by her sideways speed over her speed.
    const sp = Math.max(0.1, Math.hypot(v[0], v[2])), g = (k.sideK * (v[2] * ux - v[0] * uz)) / sp;
    ax = ux + uz * g; az = uz - ux * g;
    const l = Math.hypot(ax, az);
    ax /= l; az /= l;
  }
  unit(ax, rise, az, out);
  return flat;
}

/* Her centroid's height on the course s m across from launch height y0, climbing toward top as hopCourse steers it:
   at `climb` per unit while more than apex under it, then easing in with length apex / climb. */
export function courseHeight(y0, top, s, k = PARA_KNOBS) {
  const gap = top - y0, c = Math.max(1e-3, k.climb), a = Math.max(1e-3, k.apex);
  if (!(gap > 0)) return y0;
  const s1 = Math.max(0, (gap - a) / c);
  if (s <= s1) return y0 + c * s;
  return top - Math.min(gap, a) * Math.exp((-c * (s - s1)) / a);
}

/* How far she coasts across from flat speed v, h m over the floor she lands on: her drag's coast, cut short by touching
   down if she is low. */
export function coastLength(v, h, k = PARA_KNOBS) {
  if (!(v > 0)) return 0;
  const T = Math.max(0, h - k.restH) / Math.max(1e-3, k.sinkV), tau = Math.max(1e-3, k.coastT);
  return v * tau * (1 - Math.exp(-T / tau));
}

/* Whether thrust should end now, centroid c, velocity v, floor target p, from the launch point o: 'coast' once the coast
   will carry her the rest (less cutSlack), 'passed' if she is already past it. null keeps thrusting. */
export function hopCut(c, v, p, o, k = PARA_KNOBS) {
  let hx = p[0] - o[0], hz = p[2] - o[2];
  const hl = Math.hypot(hx, hz);
  if (!(hl > 1e-6)) return 'passed';
  hx /= hl; hz /= hl;
  const left = (p[0] - c[0]) * hx + (p[2] - c[2]) * hz;
  if (left <= 0) return 'passed';
  const along = v[0] * hx + v[2] * hz;
  return left - k.cutSlack <= coastLength(along, c[1] - p[1], k) ? 'coast' : null;
}

/* Where a hop points her body while it thrusts along unit course d: d pitched down by lean in its own vertical plane, so
   her mantle leads and the crown tips back over the arms. A course with no flat part is kept as it is. Written into out. */
export function poseDir(d, lean, out = [0, 0, 0]) {
  const f = Math.hypot(d[0], d[2]);
  if (!(f > 1e-6)) { out[0] = d[0]; out[1] = d[1]; out[2] = d[2]; return out; }
  const p = Math.atan2(d[1], f) - lean, c = Math.cos(p);
  out[0] = (d[0] / f) * c; out[1] = Math.sin(p); out[2] = (d[2] / f) * c;
  return out;
}

/* The way a hop's trailing arms take as her travel (arms point the opposite way): along the flat bearing from launch o to
   target p, tipped trailLift below level so the arms behind her point that far up. Written into out. */
export function trailVec(o, p, k = PARA_KNOBS, out = [0, 0, 0]) {
  const dx = p[0] - o[0], dz = p[2] - o[2], l = Math.hypot(dx, dz), c = Math.cos(k.trailLift), s = Math.sin(k.trailLift);
  if (!(l > 1e-6)) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  out[0] = (dx / l) * c; out[1] = -s; out[2] = (dz / l) * c;
  return out;
}

/* The parachute's aim for an arm rooted at rp leaving along d: out and paraDown below level, turned toward floor target p
   by reachShare as she nears it (left) and as the arm faces it. bear is her flat heading (unit x, z). Returns the reach weight 0–1. */
export function paraAim(rp, d, p, left, bear, k = PARA_KNOBS, out = [0, 0, 0]) {
  const l = Math.hypot(d[0], d[2]), c = Math.cos(k.paraDown), s = Math.sin(k.paraDown);
  let ax, az;
  if (l > 1e-6) { ax = d[0] / l; az = d[2] / l; } else { ax = bear[0]; az = bear[1]; }
  const bx = ax * c, by = -s, bz = az * c;
  const near = 1 - smoothstep(0, Math.max(1e-3, k.reachR), left);
  const face = smoothstep(k.reachCos0, k.reachCos1, ax * bear[0] + az * bear[1]);
  const w = clamp(k.reachShare, 0, 1) * near * face;
  if (!(w > 0)) { out[0] = bx; out[1] = by; out[2] = bz; return 0; }
  const tx = p[0] - rp[0], ty = p[1] - rp[1], tz = p[2] - rp[2], tl = Math.hypot(tx, ty, tz);
  if (!(tl > 1e-6)) { out[0] = bx; out[1] = by; out[2] = bz; return 0; }
  unit(bx + (tx / tl - bx) * w, by + (ty / tl - by) * w, bz + (tz / tl - bz) * w, out);
  return w;
}

/* A landing scored: flat distance from target p to where she came down (c), and whether it counts. */
export function scoreLanding(c, p, upY, flippedEver, k = PARA_KNOBS) {
  const err = Math.hypot(c[0] - p[0], c[2] - p[2]);
  const upright = upY > k.upright && !flippedEver;
  return { err, upright, on: err <= k.landR, passed: upright && err <= k.landR };
}

/* A seeded floor target for the hop scenario: dist m (lo–hi) at a seeded bearing from c, at least margin m off the glass,
   off the divider's face (none when panelX is null), clear of keep-out discs [x, z, r], and ok(x, z) if given. rand() gives 0–1.
   null after `tries` misses. */
export function pickTarget(c, rand, { lo = 0.4, hi = 0.8, tank, panelX, panelT, margin = 0.15, keep = [], ok = null, tries = 200 } = {}) {
  const side = panelX == null ? 0 : Math.sign(c[0] - panelX) || -1;
  // The length is drawn first and shrinks toward lo only when no bearing fits, so long hops aren't crowded out by the glass.
  let d = lo + rand() * (hi - lo);
  for (let i = 0; i < tries; i++) {
    if (i && i % 20 === 0) d = Math.max(lo, d * 0.93);
    const th = rand() * 2 * Math.PI, x = c[0] + Math.cos(th) * d, z = c[2] + Math.sin(th) * d;
    if (side && (x - panelX) * side < panelT / 2 + margin) continue;
    if (tank.w / 2 - Math.abs(x) < margin || tank.d / 2 - Math.abs(z) < margin) continue;
    if (keep.some(([kx, kz, r]) => Math.hypot(x - kx, z - kz) < r) || (ok && !ok(x, z))) continue;
    return [x, 0, z];
  }
  return null;
}
