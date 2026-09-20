/* The THREE-free half of Sam's nebula plume: the towed rope the gas hangs around, the dial guard every
   live value passes through, and the six-slot color queue with its palette matrix. */

export const QUEUE_SLOTS = 6;

// His house color, darker and more saturated than the old cloud orange so the nebula stops read against it.
export const PLUME_ORANGE = [0.86, 0.21, 0.02];
// Only the boot value for the sand under the plume; from the first frame the queue's mean owns it.
export const CLOUD_LIGHT = [0.95, 0.26, 0.04];

/* Rows of the narrowband palette over (H-alpha, [O III], [S II]). Unlike Cosmorph's hooNatural this one
   does route S II, because deep red beside the rose is half the point of the queue. */
export const PALETTE = [
  [1.00, 0.00, 0.92],
  [0.16, 0.80, 0.05],
  [0.10, 0.90, 0.10],
];

export function linesToRgb(ha, oiii, sii, out = [0, 0, 0]) {
  for (let i = 0; i < 3; i++) out[i] = PALETTE[i][0] * ha + PALETTE[i][1] * oiii + PALETTE[i][2] * sii;
  return out;
}

/* What the idle cycle walks: real emission lines interleaved with his own orange, so no two nebula
   colors ever ride the plume side by side without him between them. */
export const NEBULA_CYCLE = [
  { lines: [1, 0, 0] },                 // H-alpha rose-red
  { rgb: PLUME_ORANGE },
  { lines: [0, 1, 0] },                 // [O III] teal
  { rgb: PLUME_ORANGE },
  { lines: [0, 0, 0.8] },               // [S II] deep red
  { rgb: PLUME_ORANGE },
  { rgb: [0.30, 0.55, 1.00] },          // H-beta blue, a plain continuum entry: the palette models no H-beta
  { rgb: PLUME_ORANGE },
  { rgb: [0.55, 0.78, 1.00] },          // reflection-nebula blue, scattered starlight, never a line
  { rgb: PLUME_ORANGE },
];

export function cycleColor(i, out = [0, 0, 0]) {
  const e = NEBULA_CYCLE[((i % NEBULA_CYCLE.length) + NEBULA_CYCLE.length) % NEBULA_CYCLE.length];
  if (e.rgb) { out[0] = e.rgb[0]; out[1] = e.rgb[1]; out[2] = e.rgb[2]; return out; }
  return linesToRgb(e.lines[0], e.lines[1], e.lines[2], out);
}

/* Where the plume starts on his body and how far it reaches past the tip, in world units, plus the spine
   index of its anchor. Written into the caller's object: this runs every frame. */
export function plumeSpan(length, points, back, past, out) {
  // A dial swung to junk degrades to the default share rather than to a NaN span the whole plume inherits.
  const b = clamp(Number.isFinite(back) ? back : 0.08, 0.02, 0.5);
  const p = clamp(Number.isFinite(past) ? past : 0.14, 0.02, 0.9);
  out.back = b * length;
  out.fore = p * length;
  out.total = out.back + out.fore;
  out.from = (1 - b) * (points - 1);
  return out;
}

/* The towed rope. Point 0 is pinned to a skinny spine point, point 1 to the live tail tip, and the rest
   are dragged behind at a fixed segment length, so the plume is always attached and never stretches.
   Every free point is an overdamped follower of the straight line behind its leader, with a longer time
   constant the further out it sits: no spring, no velocity, so nothing can overshoot or crack like a
   whip. The reference heading is low-passed too, which is what keeps a swim stroke out of the rope. */
export const ROPE_POINTS = 6;
export const ROPE_FREE = ROPE_POINTS - 2;

export function makeRope(n = ROPE_POINTS) {
  return {
    n, p: new Float64Array(n * 3), dir: new Float64Array(2),
    s: new Float64Array(n), seg: 0.3, primed: false,
  };
}

function arcLengths(r) {
  const { p, s, n } = r;
  s[0] = 0;
  for (let i = 1; i < n; i++) {
    const j = i * 3, k = j - 3;
    // In x and z, matching the plane the fragment measures its own distance along.
    s[i] = s[i - 1] + Math.hypot(p[j] - p[k], p[j + 2] - p[k + 2]);
  }
  return s[n - 1];
}

function ropeSegmentLength(n, i, seg, cfg) {
  const endScale = clamp(Number.isFinite(cfg?.endScale) ? cfg.endScale : 1, 1, 3);
  return i === n - 1 ? seg * endScale : seg;
}

/* Laid out straight behind the tail with the filtered heading reset: the one state a park, a teleport, a
   show, or an identity swap may hand the next frame. */
export function primeRope(r, a, tip, seg, cfg) {
  const { p, dir, n } = r;
  r.seg = Number.isFinite(seg) && seg > 1e-4 ? seg : 0.3;
  p[0] = a.x; p[1] = a.y; p[2] = a.z;
  p[3] = tip.x; p[4] = tip.y; p[5] = tip.z;
  let dx = tip.x - a.x, dz = tip.z - a.z;
  const L = Math.hypot(dx, dz);
  if (L > 1e-5) { dx /= L; dz /= L; } else { dx = 1; dz = 0; }
  dir[0] = dx; dir[1] = dz;
  for (let i = 2; i < n; i++) {
    const j = i * 3, k = j - 3, len = ropeSegmentLength(n, i, r.seg, cfg);
    p[j] = p[k] + dx * len; p[j + 1] = p[k + 1]; p[j + 2] = p[k + 2] + dz * len;
  }
  r.primed = true;
  arcLengths(r);
  return r;
}

/* One ascending pass, so every point sees a leader that's already final: each free point relaxes toward
   the line behind its leader, so a sideways wag barely moves it (the length fix after is second order in
   the wag) and nothing can overshoot or crack like a whip. Flat on purpose, since the gas is drawn from x
   and z alone: a rope that curved in y could fold on screen while every 3D angle still read as legal. */
export function stepRope(r, dt, a, tip, seg, cfg) {
  const { p, dir, n } = r;
  const len = Number.isFinite(seg) && seg > 1e-4 ? seg : r.seg;
  r.seg = len;
  const h = Number.isFinite(dt) && dt > 0 ? Math.min(0.1, dt) : 0;
  const bend = clamp(Number.isFinite(cfg.bend) ? cfg.bend : 0.7, 0, 1);
  const kink = clamp(Number.isFinite(cfg.kink) ? cfg.kink : 0.55, 0.02, Math.PI * 0.5);
  const smooth = clamp(Number.isFinite(cfg.smooth) ? cfg.smooth : 0.45, 0.01, 8);
  const lag = clamp(Number.isFinite(cfg.lag) ? cfg.lag : 0.35, 0.01, 8);
  const grade = clamp(Number.isFinite(cfg.grade) ? cfg.grade : 0.8, 0, 6);
  if (!r.primed || !finiteRope(r)) return primeRope(r, a, tip, len, cfg);
  p[0] = a.x; p[1] = a.y; p[2] = a.z;
  p[3] = tip.x; p[4] = tip.y; p[5] = tip.z;
  // The heading the rope is measured against, low-passed: his travel and his turns get through, the
  // per-stroke wag of the tail does not. A tail stood on end has almost no chord here, so the filtered
  // heading carries it rather than a direction read off two nearly coincident points.
  let bx = tip.x - a.x, bz = tip.z - a.z;
  const bL = Math.hypot(bx, bz);
  if (bL < 1e-4) { bx = dir[0]; bz = dir[1]; }
  else {
    bx /= bL; bz /= bL;
    const ks = 1 - Math.exp(-h / smooth);
    dir[0] += (bx - dir[0]) * ks; dir[1] += (bz - dir[1]) * ks;
    const dL = Math.hypot(dir[0], dir[1]);
    if (dL > 1e-9) { dir[0] /= dL; dir[1] /= dL; } else { dir[0] = bx; dir[1] = bz; }
  }
  for (let i = 2; i < n; i++) {
    const j = i * 3, k = j - 3, m = k - 3, segLen = ropeSegmentLength(n, i, len, cfg);
    // Two references, and the difference is the whole trick: the rope aims itself along the low-passed
    // heading, but the kink cap is measured against the real segment ahead of it, so an ordinary swim
    // stroke moves nothing while a fold is still impossible.
    let ax, az, cx = bx, cz = bz;
    if (i === 2) { ax = dir[0]; az = dir[1]; }
    else {
      ax = p[k] - p[m]; az = p[k + 2] - p[m + 2];
      const aL = Math.hypot(ax, az);
      if (aL < 1e-9) { ax = dir[0]; az = dir[1]; } else { ax /= aL; az /= aL; }
      cx = ax; cz = az;
    }
    let dx = p[j] - p[k], dz = p[j + 2] - p[k + 2];
    let dL = Math.hypot(dx, dz);
    if (dL < 1e-9) { dx = ax; dz = az; } else { dx /= dL; dz /= dL; }
    // Where this point would sit if the rope lay straight behind its leader.
    let tx = dx + (ax - dx) * bend, tz = dz + (az - dz) * bend;
    const tL = Math.hypot(tx, tz);
    if (tL < 1e-9) { tx = ax; tz = az; } else { tx /= tL; tz /= tL; }
    // Overdamped, so it can only approach: each point further out takes longer than the one before it.
    const kf = 1 - Math.exp(-h / (lag * (1 + (i - 2) * grade)));
    p[j] += (p[k] + tx * segLen - p[j]) * kf;
    p[j + 2] += (p[k + 2] + tz * segLen - p[j + 2]) * kf;
    dx = p[j] - p[k]; dz = p[j + 2] - p[k + 2];
    dL = Math.hypot(dx, dz);
    if (dL < 1e-9) { dx = ax; dz = az; } else { dx /= dL; dz /= dL; }
    // The turn onto the cone, as a signed angle: in the plane there is always a way round, even for a
    // segment pointing exactly back the way it came.
    const off = Math.atan2(cx * dz - cz * dx, cx * dx + cz * dz);
    if (off > kink || off < -kink) {
      const th = Math.atan2(cz, cx) + (off > 0 ? kink : -kink);
      dx = Math.cos(th); dz = Math.sin(th);
    }
    p[j] = p[k] + dx * segLen; p[j + 1] = p[k + 1]; p[j + 2] = p[k + 2] + dz * segLen;
  }
  if (!finiteRope(r)) return primeRope(r, a, tip, len, cfg);
  arcLengths(r);
  return r;
}

export function finiteRope(r) {
  for (let i = 0; i < r.p.length; i++) if (!Number.isFinite(r.p[i])) return false;
  return true;
}

/* The widest angle any two consecutive segments make on screen, which is the one number the kink cap has
   to hold. Measured in x and z, because that is the curve the gas is drawn around. */
export function ropeMaxAngle(r) {
  const { p, n } = r;
  let worst = 0;
  for (let i = 2; i < n; i++) {
    const j = i * 3, k = j - 3, m = k - 3;
    const ax = p[k] - p[m], az = p[k + 2] - p[m + 2];
    const bx = p[j] - p[k], bz = p[j + 2] - p[k + 2];
    if (Math.hypot(ax, az) < 1e-9 || Math.hypot(bx, bz) < 1e-9) continue;
    worst = Math.max(worst, Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz)));
  }
  return worst;
}

/* Every live dial read through here, once per sync: junk degrades to the default and an out-of-range
   value snaps back, so no NaN can reach a uniform and poison an additive draw. */
export function dialNum(d, lo, hi, dflt) {
  const raw = typeof d?.value === 'number' ? d.value : NaN;
  const v = Number.isFinite(raw) ? clamp(raw, lo, hi) : dflt;
  if (d && raw !== v) d.value = v;
  return v;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/* The six-slot color queue. A slot is born at the plume's base and rides the flow outward; `pos` is its
   place along the plume in the same 0-1 the shader uses, so age and distance are one number. */
export function makeQueue() {
  const slots = [];
  for (let i = 0; i < QUEUE_SLOTS; i++) {
    slots.push({ r: 0, g: 0, b: 0, pos: 9, w: 0, seed: i * 1.87, fade: 1, pending: false, pr: 0, pg: 0, pb: 0 });
  }
  // The drip starts part-wound so he does not boot with a nebula color already in the queue.
  return { slots, cool: new Map(), quiet: 0, drip: 20, cycle: 0, mean: PLUME_ORANGE.slice() };
}

export const BIRTH = -0.12, DEATH = 1.12;
const COLOR_SCRATCH = [0, 0, 0];

/* Fades in as it leaves his body and out as it falls off the ragged end; zero outside, so an expired slot
   costs the shader a multiply and nothing else. */
export function slotWeight(pos) {
  if (!(pos > BIRTH) || pos >= DEATH) return 0;
  return sstep((pos - BIRTH) / 0.18) * sstep((DEATH - pos) / 0.26);
}

export function queueStep(q, dt, life, retire = 1.5) {
  const h = Math.max(0, dt);
  const step = h / Math.max(1, life);
  const rate = h / Math.max(0.05, Number.isFinite(retire) ? retire : 1.5);
  for (const s of q.slots) {
    // A band the viewer can see never changes color under them: it fades out, takes the waiting color at
    // zero contribution, and fades back in from the base.
    if (s.pending) {
      s.fade = Math.max(0, s.fade - rate);
      if (s.fade <= 0) {
        s.r = s.pr; s.g = s.pg; s.b = s.pb;
        s.pos = BIRTH + 1e-4; s.pending = false;
      }
    } else if (s.fade < 1) s.fade = Math.min(1, s.fade + rate);
    if (s.pos < DEATH) s.pos += step;
    s.w = slotWeight(s.pos) * s.fade;
  }
}

/* Pickups are authored as display-ramp stops, which can be near white. Move them into the same bounded,
   emission-like gamut as the queue before blending so two pale ramps cannot bleach a whole plume. */
export function normalizePlumeColor(r, g, b, cfg = {}, out = [0, 0, 0]) {
  const cap = clamp(Number.isFinite(cfg.lum) ? cfg.lum : 0.78, 0.05, 1);
  const minSat = clamp(Number.isFinite(cfg.sat) ? cfg.sat : 0.72, 0, 1);
  const grey = clamp(Number.isFinite(cfg.grey) ? cfg.grey : 0.18, 0, 0.95);
  let rr = clamp(Number.isFinite(r) ? r : PLUME_ORANGE[0], 0, 1);
  let gg = clamp(Number.isFinite(g) ? g : PLUME_ORANGE[1], 0, 1);
  let bb = clamp(Number.isFinite(b) ? b : PLUME_ORANGE[2], 0, 1);
  let hi = Math.max(rr, gg, bb), lo = Math.min(rr, gg, bb);
  if (hi < 1e-6 || (hi - lo) / hi < grey) {
    rr = PLUME_ORANGE[0]; gg = PLUME_ORANGE[1]; bb = PLUME_ORANGE[2];
    hi = PLUME_ORANGE[0]; lo = PLUME_ORANGE[2];
  }
  const sat = (hi - lo) / Math.max(hi, 1e-6);
  const boost = Math.max(1, minSat / Math.max(sat, 1e-6));
  rr = Math.max(0, hi - (hi - rr) * boost);
  gg = Math.max(0, hi - (hi - gg) * boost);
  bb = Math.max(0, hi - (hi - bb) * boost);
  hi = Math.max(rr, gg, bb);
  const scale = cap / Math.max(hi, 1e-6);
  out[0] = rr * scale; out[1] = gg * scale; out[2] = bb * scale;
  return out;
}

/* A push takes the furthest non-retiring slot, so two colors arriving together never overwrite one another.
   A slot nobody can see takes the color at once; a live one has to retire first. */
export function queuePush(q, r, g, b, cfg) {
  let pick = null;
  for (const s of q.slots) if (!s.pending && (!pick || s.pos > pick.pos)) pick = s;
  if (!pick) return null;
  normalizePlumeColor(r, g, b, cfg, COLOR_SCRATCH);
  pick.pr = COLOR_SCRATCH[0]; pick.pg = COLOR_SCRATCH[1]; pick.pb = COLOR_SCRATCH[2];
  if (pick.w > 0) { pick.pending = true; return pick; }
  pick.r = pick.pr; pick.g = pick.pg; pick.b = pick.pb;
  pick.pos = BIRTH + 1e-4;
  pick.pending = false;
  pick.fade = 1;
  pick.w = slotWeight(pick.pos);
  return pick;
}

/* What the sand under the plume is lit by: the visible slots' weighted mean. `house` is his own orange's
   standing weight in the shader, so the floor and the gas agree on how much of him is in the mix. */
export function queueMean(q, out = q.mean, house = 0) {
  let sw = house, r = PLUME_ORANGE[0] * house, g = PLUME_ORANGE[1] * house, b = PLUME_ORANGE[2] * house;
  for (const s of q.slots) {
    if (!(s.w > 0)) continue;
    sw += s.w; r += s.r * s.w; g += s.g * s.w; b += s.b * s.w;
  }
  if (sw > 1e-5) { out[0] = r / sw; out[1] = g / sw; out[2] = b / sw; }
  else { out[0] = PLUME_ORANGE[0]; out[1] = PLUME_ORANGE[1]; out[2] = PLUME_ORANGE[2]; }
  return out;
}

export function easeRgb(current, target, dt, tau) {
  const k = 1 - Math.exp(-Math.max(0, dt) / Math.max(0.05, tau));
  for (let i = 0; i < 3; i++) current[i] += (target[i] - current[i]) * k;
  return current;
}

export function feedReady(q, key, now, cool) {
  const last = q.cool.get(key);
  return last === undefined || now - last >= cool;
}

// Nothing five minutes stale can still block a pickup, whatever the cooldown dial says.
const COOL_FORGET = 300;

// Residents hot-swap, so the keys are objects that go away; without a hard ceiling a churning cast grows
// the map for the life of the page however recent every entry is.
const COOL_MAX = 48;

export function markFed(q, key, now) {
  q.cool.set(key, now);
  if (q.cool.size > 16) for (const [k, t] of q.cool) if (now - t > COOL_FORGET) q.cool.delete(k);
  // Map iteration is insertion-ordered, so the first key left is the longest-standing entry.
  while (q.cool.size > COOL_MAX) q.cool.delete(q.cool.keys().next().value);
  return now;
}
