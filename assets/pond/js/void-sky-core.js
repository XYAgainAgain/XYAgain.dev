/* The THREE-free half of his sky: the universe transform shared with the body shader, session stars and
   their flash ring, meteors and comets, and the finger's gravity wave. All decoration on the frame clock. */

const TAU = Math.PI * 2;
/* Cell indices go negative near screen center as drift carries them out; the bias keeps both ends
   positive for the uint cast, sized as a multiple of the table's span so slot/tag math stays clean. */
export const CELL_BIAS = 65536;
// The meteor stream's salt off the firmament seed: its own generator, so a meteor never moves a star.
export const METEOR_SALT = 7331;

/* The straight clock's transform, before the loop: rotation about screen center and a straight drift,
   parked under reduced motion. createSkyClock seeds the loop's spin from the same closed form. */
export function universeFrame(time, motionScale, spin, drift, driftAngle, out = {}) {
  const t = (Number.isFinite(time) ? time : 0) * (motionScale >= 0.5 ? 1 : 0);
  const ang = t * (Number.isFinite(spin) ? spin : 0), d = t * (Number.isFinite(drift) ? drift : 0);
  const da = Number.isFinite(driftAngle) ? driftAngle : 0;
  out.c = Math.cos(ang); out.s = Math.sin(ang);
  out.ox = Math.cos(da) * d; out.oy = Math.sin(da) * d;
  return out;
}

// The universe's own loop

/* Three of the scene clock's 4,096 s wraps: long enough that the drift's lap is the loop itself at about
   eight screens of radius, and that snapping a galaxy's spin to whole turns moves it under 5%. */
export const SKY_LOOP = 12288;
// main.js wraps U.time here; the sky only ever reads its deltas.
export const SCENE_WRAP = 4096;
export const SKY_DT_MAX = 0.1;
export const DRIFT_SPEED = 0.004;
// Fixed, so moving the drift dial changes the speed along the circle and never jumps the position.
export const DRIFT_RADIUS = DRIFT_SPEED * SKY_LOOP / TAU;
// The twinkle's base rate is twinkleRate × this in cycles a second; its second octave runs at 0.41 of it.
export const TWINKLE_BASE = 0.16;
export const TWINKLE_OCT2 = 0.41;
// A galaxy turns once in 8 to 20 minutes before the snap.
export const GAL_SLOW = 1200, GAL_FAST = 480;

const fin = (x, d = 0) => (Number.isFinite(x) ? x : d);
// Into [0, m) for either sign, so a negative dial runs its clock backward without leaving the range.
export const wrapTo = (x, m) => ((x % m) + m) % m;

/* How far the scene clock moved since `prev`, across its wrap, clamped the way every frame clock here is,
   so a slept tab or a pond switched off for an hour costs one short step. */
export function sceneDelta(prev, now) {
  if (!Number.isFinite(prev) || !Number.isFinite(now)) return 0;
  let d = now - prev;
  if (d < 0) d += SCENE_WRAP;
  return Math.min(SKY_DT_MAX, Math.max(0, d));
}

/* The loop state, seeded from the old closed form at `time`, so the sky he first shows is the one the
   straight clock would have shown then, apart from where the drift sits on its circle. */
export function createSkyClock(time = 0, motionScale = 1, { spin = 0, drift = 0, galSpin = 1, nebDrift = 0 } = {}) {
  const t = Math.max(0, fin(time)), live = motionScale >= 0.5 ? 1 : 0;
  return {
    T: wrapTo(t, SKY_LOOP),
    rot: wrapTo(t * fin(spin) * live, TAU),
    phi: wrapTo(t * fin(drift) * live / DRIFT_RADIUS, TAU),
    gal: wrapTo(t * fin(galSpin), SKY_LOOP),
    nebX: wrapTo(t * fin(nebDrift) * live, NEB_PERIOD),
    nebY: wrapTo(t * fin(nebDrift) * live * 0.6, NEB_PERIOD),
  };
}

/* One frame of the loop. T and the galaxy clock run under reduced motion as they always did; the spin,
   the drift, and the nebula scroll freeze where they are. Every field is reduced before it is stored. */
export function stepSkyClock(c, dt, { live = true, spin = 0, drift = 0, galSpin = 1, nebDrift = 0 } = {}) {
  const d = Math.min(SKY_DT_MAX, Math.max(0, fin(dt)));
  const m = live ? d : 0;
  c.T = wrapTo(c.T + d, SKY_LOOP);
  c.rot = wrapTo(c.rot + fin(spin) * m, TAU);
  c.phi = wrapTo(c.phi + fin(drift) * m / DRIFT_RADIUS, TAU);
  c.gal = wrapTo(c.gal + fin(galSpin) * d, SKY_LOOP);
  c.nebX = wrapTo(c.nebX + fin(nebDrift) * m, NEB_PERIOD);
  c.nebY = wrapTo(c.nebY + fin(nebDrift) * m * 0.6, NEB_PERIOD);
  return c;
}

/* The sampling transform from the loop state: the accumulated spin, and the drift around a circle of
   DRIFT_RADIUS that leaves the origin heading `driftAngle` and curves left, home again once a lap. */
export function skyFrame(c, driftAngle, out = {}) {
  const a = fin(driftAngle), R = DRIFT_RADIUS;
  out.c = Math.cos(c.rot); out.s = Math.sin(c.rot);
  out.ox = R * (Math.sin(a + c.phi) - Math.sin(a));
  out.oy = R * (Math.cos(a) - Math.cos(a + c.phi));
  return out;
}

/* A rate in cycles a second, snapped to whole cycles per loop. Never 0 unless the rate was. */
export function loopCycles(rate, L = SKY_LOOP) {
  if (!Number.isFinite(rate) || rate === 0) return 0;
  return Math.sign(rate) * Math.max(1, Math.round(Math.abs(rate) * L));
}

/* A whole-cycle term's phase in [0, 1), exact in doubles: T × n stays well inside 2^53. */
export function loopPhase(cycles, T, L = SKY_LOOP) {
  const x = cycles * T / L;
  return x - Math.floor(x);
}

/* The two twinkle octaves' phases, which the shader reads where it used to multiply the clock. */
export function twinklePhases(twinkleRate, T, out = {}) {
  const r = fin(twinkleRate) * TWINKLE_BASE;
  out.a = loopPhase(loopCycles(r), T);
  out.b = loopPhase(loopCycles(r * TWINKLE_OCT2), T);
  return out;
}

/* A galaxy's whole turns per loop from its spin roll, the shader's arithmetic: the sign keeps a roll of
   exactly one half still, and the magnitude is at least 10, so no galaxy can stop. */
export function galaxyTurns(h, L = SKY_LOOP) {
  const x = L / GAL_SLOW + (L / GAL_FAST - L / GAL_SLOW) * h;
  return Math.sign(h - 0.5) * Math.floor(x + 0.5);
}

/* World xz under the straight-down camera to the body's aspect-corrected sampling point: screenUV is
   top-left origin on both backends, and camera top is -z, so v runs with z. */
export function worldToSample(x, z, viewW, viewH, aspect, out = {}) {
  const u = x / viewW + 0.5, v = z / viewH + 0.5;
  return uvToSample(u, v, aspect, out);
}

export function uvToSample(u, v, aspect, out = {}) {
  out.x = (u - 0.5) * aspect;
  out.y = v - 0.5;
  return out;
}

export function toUniverse(sx, sy, f, out = {}) {
  out.x = sx * f.c - sy * f.s + f.ox;
  out.y = sx * f.s + sy * f.c + f.oy;
  return out;
}

/* pcg3d on uint32 lanes, the firmament shader's hash, so the CPU can find the galaxies the GPU draws. */
export function pcg3d(x, y, z) {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; y = (y ^ (y >>> 16)) >>> 0; z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  return [x, y, z];
}

export function hash3(x, y, z) {
  const h = pcg3d(x, y, z);
  return [h[0] * 2.3283064365386963e-10, h[1] * 2.3283064365386963e-10, h[2] * 2.3283064365386963e-10];
}

/* The center of the galaxy nearest a universe point, walking the same hashed cells the shader draws:
   occupancy under `dens`, the center in the middle half of its cell. Null when none is within reach. */
export function nearestGalaxy(px, py, { cells, dens, off, reach = 3 } = {}) {
  if (!(cells > 0) || !(dens > 0) || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  const gx = px * cells, gy = py * cells;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let best = null, bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const ix = cx + dx, iy = cy + dy;
      const h = hash3(ix + CELL_BIAS, iy + CELL_BIAS, off);
      if (h[2] > dens) continue;
      const ax = ix + h[0] * 0.5 + 0.25, ay = iy + h[1] * 0.5 + 0.25;
      const d = (ax - gx) ** 2 + (ay - gy) ** 2;
      if (d < bestD) { bestD = d; best = { x: ax / cells, y: ay / cells }; }
    }
  }
  return best;
}

// Session stars

export const SESSION_RES = 128;     // the slot table's side: 16,384 slots, 64 KB of RGBA8
export const SESSION_CELLS = 36;    // cells per screen height; a star is confined to its cell's middle half
export const SESSION_REACH = 3;     // how many cells a star may be nudged to find a free one
const TAG_SPAN = 256;
const REACH_ORDER = [];
for (let dy = -SESSION_REACH; dy <= SESSION_REACH; dy++) for (let dx = -SESSION_REACH; dx <= SESSION_REACH; dx++) REACH_ORDER.push([dx, dy]);
REACH_ORDER.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2));

export function createSessionSky(res = SESSION_RES, cells = SESSION_CELLS) {
  return { res, cells, bytes: new Uint8Array(res * res * 4), count: 0, dirty: false, rainTick: 0 };
}

/* Cell c (biased, never negative) lands in slot c mod res and carries c div res as a one-byte tag, so a
   cell a table's width away cannot read another cell's star. */
export function slotIndex(sky, cx, cy) {
  const r = sky.res;
  return ((cy % r) * r + (cx % r)) * 4;
}

export function slotTag(sky, c) { return Math.floor(c / sky.res) % TAG_SPAN; }

/* Where a new star goes: the free cell nearest the drop within SESSION_REACH, its in-cell offset clamped
   to the middle half and quantized to what the texel holds. Returns null when every nearby cell is full. */
export function placeSessionStar(sky, px, py) {
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  const C = sky.cells, gx = px * C, gy = py * C;
  const c0x = Math.floor(gx), c0y = Math.floor(gy);
  if (c0x + CELL_BIAS - SESSION_REACH < 0 || c0y + CELL_BIAS - SESSION_REACH < 0) return null;
  let best = null, bestD = Infinity;
  // Nearest-first order, so a tie (a drop exactly on a cell wall) stays home and the rule is deterministic.
  for (const [dx, dy] of REACH_ORDER) {
    const lx = c0x + dx, ly = c0y + dy;
    const at = slotIndex(sky, lx + CELL_BIAS, ly + CELL_BIAS);
    if (sky.bytes[at + 3] !== 0) continue;
    const nx = quantOffset(gx - lx), ny = quantOffset(gy - ly);
    const d = (lx + offsetOf(nx) - gx) ** 2 + (ly + offsetOf(ny) - gy) ** 2;
    if (d < bestD) { bestD = d; best = { lx, ly, nx, ny, at }; }
  }
  if (!best) return null;
  best.x = (best.lx + offsetOf(best.nx)) / C;
  best.y = (best.ly + offsetOf(best.ny)) / C;
  return best;
}

// Four bits per axis: the offset runs 0.25 to 0.75 of the cell, so the star's wings never cross a wall.
function quantOffset(f) { return Math.round((Math.min(0.75, Math.max(0.25, f)) - 0.25) / 0.5 * 15); }
export function offsetOf(n) { return 0.25 + (n / 15) * 0.5; }

/* One star, one texel: tag x, tag y, the packed offset, and warm in the top bit over a 7-bit level.
   A level under one step still writes one, since a zero alpha byte is what "empty" means. */
export function addSessionStar(sky, px, py, level = 1, warm = true) {
  const lv = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  if (!(lv > 0)) return null;
  const at = placeSessionStar(sky, px, py);
  if (!at) return null;
  const b = sky.bytes;
  b[at.at] = slotTag(sky, at.lx + CELL_BIAS);
  b[at.at + 1] = slotTag(sky, at.ly + CELL_BIAS);
  b[at.at + 2] = (at.nx << 4) | at.ny;
  b[at.at + 3] = (warm ? 128 : 0) | Math.max(1, Math.round(lv * 127));
  sky.count++;
  sky.dirty = true;
  return at;
}

/* The shader's read, on the CPU, for the tests: the star a universe point's own cell holds, or null. */
export function readSessionStar(sky, px, py) {
  const lx = Math.floor(px * sky.cells), ly = Math.floor(py * sky.cells);
  const cx = lx + CELL_BIAS, cy = ly + CELL_BIAS;
  const at = slotIndex(sky, cx, cy), b = sky.bytes;
  if (b[at + 3] === 0 || b[at] !== slotTag(sky, cx) || b[at + 1] !== slotTag(sky, cy)) return null;
  const nx = b[at + 2] >> 4, ny = b[at + 2] & 15;
  return {
    x: (lx + offsetOf(nx)) / sky.cells, y: (ly + offsetOf(ny)) / sky.cells,
    level: (b[at + 3] & 127) / 127, warm: b[at + 3] >= 128,
  };
}

/* Rain thins to one drop in four, counted rather than rolled so it needs no generator at all. */
export function rainPasses(sky) {
  const pass = sky.rainTick % 4 === 0;
  sky.rainTick = (sky.rainTick + 1) % 4;
  return pass;
}

// The flash ring: a cap on how many stars can be mid-flash at once, never on how many exist.

export const FLASH_SLOTS = 16;
export const FLASH_TIME = 0.3;

export function createFlashRing(n = FLASH_SLOTS) {
  return { next: 0, recs: Array.from({ length: n }, () => ({ x: 0, y: 0, gain: 0, born: -Infinity })) };
}

export function pushFlash(ring, x, y, gain, now) {
  const r = ring.recs[ring.next];
  r.x = x; r.y = y; r.gain = gain; r.born = now;
  ring.next = (ring.next + 1) % ring.recs.length;
  return r;
}

/* A pinprick: a 40 ms rise, then a quadratic fall to nothing at FLASH_TIME. */
export function flashLevel(age, dur = FLASH_TIME) {
  if (!(age >= 0) || !(age < dur)) return 0;
  const rise = Math.min(1, age / 0.04);
  const fall = 1 - age / dur;
  return rise * fall * fall;
}

export function quietFlashes(ring) { for (const r of ring.recs) { r.gain = 0; r.born = -Infinity; } }

// Meteors and comets

export const COMET_ODDS = 1 / 12;
export const METEOR_FADE = 0.4;

/* The wait before the next streak: uniform over half to one and a half times the mean, which is 20 to
   60 s at the default 40, and doubled under reduced motion. */
export function meteorWait(rng, every, reduced) {
  return every * (0.5 + rng.next()) * (reduced ? 2 : 1);
}

export function createMeteorSky(rng, every = 40) {
  return { rng, wait: meteorWait(rng, every > 0 ? every : 40, false), live: null, reduced: false };
}

/* A streak drawn to cross his body: nothing outside his silhouette can show it, so a screen-wide random
   path would rarely cross him. `anchor` is his midpoint and `span` his length, both in screen heights. */
export function spawnMeteor(rng, anchor, span, galaxyNear = null) {
  const comet = rng.next() < COMET_ODDS;
  const heading = rng.range(0, TAU);
  const dx = Math.cos(heading), dy = Math.sin(heading);
  const s = Number.isFinite(span) && span > 0 ? span : 0.3;
  const off = rng.range(-0.35, 0.35) * s;
  const L = comet ? rng.range(0.30, 0.45) : rng.range(0.45, 0.80);
  const T = comet ? rng.range(4, 6) : rng.range(0.45, 0.9);
  const lead = rng.range(0.35, 0.65);
  const ax = Number.isFinite(anchor?.x) ? anchor.x : 0, ay = Number.isFinite(anchor?.y) ? anchor.y : 0;
  const m = {
    comet, dx, dy, L, T, age: 0,
    x0: ax - dy * off - dx * L * lead, y0: ay + dx * off - dy * L * lead,
    trail: comet ? rng.range(0.07, 0.11) : rng.range(0.06, 0.13),
    gain: comet ? rng.range(0.8, 1.1) : rng.range(0.6, 1.0),
    life: comet ? T : T + METEOR_FADE,
    gx: null, gy: null,
  };
  if (comet && galaxyNear) {
    const g = galaxyNear(ax, ay);
    if (g) { m.gx = g.x; m.gy = g.y; }
  }
  return m;
}

/* Advance the scheduler. The wait only counts down while nothing is in flight, and a mean of 0 or less
   switches new streaks off without cutting one short. Returns the live streak or null. */
export function stepMeteors(sky, dt, { every = 40, reduced = false, anchor = null, span = 0.3, galaxyNear = null } = {}) {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  // A reduced-motion flip rescales the wait already running, so the doubling holds across a toggle.
  if (!!reduced !== sky.reduced) { sky.wait *= reduced ? 2 : 0.5; sky.reduced = !!reduced; }
  if (sky.live) {
    sky.live.age += step;
    if (sky.live.age >= sky.live.life) sky.live = null;
    return sky.live;
  }
  if (!(every > 0)) return null;
  sky.wait -= step;
  if (sky.wait > 0) return null;
  sky.live = spawnMeteor(sky.rng, anchor, span, galaxyNear);
  sky.wait = meteorWait(sky.rng, every, reduced);
  return sky.live;
}

/* The comet tail's noise scroll, restarted per streak: the feather noise is not periodic, and a comet's
   6 s at 0.6 a second never gets near the wrap, so no tail in flight can jump. */
export const COMET_PHASE_WRAP = 64;
export function stepCometPhase(st, m, dt, reduced) {
  if (m !== st.streak) { st.streak = m; st.phase = 0; }
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  st.phase = (st.phase + d * (reduced ? 0.2 : 1) * 0.6) % COMET_PHASE_WRAP;
  return st.phase;
}

/* A streak's drawable state at its age: head, heading, trail length, and intensity; a comet adds its
   tail's direction, pointing away from the nearest galaxy (or back along its path when there is none). */
export function meteorState(m, out = {}) {
  const k = Math.min(1, m.age / m.T);
  out.hx = m.x0 + m.dx * m.L * k;
  out.hy = m.y0 + m.dy * m.L * k;
  out.dx = m.dx; out.dy = m.dy;
  out.comet = m.comet;
  if (m.comet) {
    // A sine envelope: a comet swims up out of the dark and back into it.
    out.level = m.gain * Math.sin(Math.PI * Math.min(1, m.age / m.T));
    out.trail = m.trail;
    let tx = -m.dx, ty = -m.dy;
    if (m.gx !== null) {
      const ex = out.hx - m.gx, ey = out.hy - m.gy, n = Math.hypot(ex, ey);
      if (n > 1e-6) { tx = ex / n; ty = ey / n; }
    }
    out.tx = tx; out.ty = ty;
  } else {
    // The trail grows in over its first 80 ms, burns, and fades out over METEOR_FADE once the head stops.
    const burn = Math.min(1, m.age / 0.05) * (m.age <= m.T ? 1 : Math.max(0, 1 - (m.age - m.T) / METEOR_FADE));
    out.level = m.gain * burn;
    out.trail = m.trail * Math.min(1, m.age / 0.08);
    out.tx = -m.dx; out.ty = -m.dy;
  }
  return out;
}

// The finger's gravity wave

/* A ring from the touch point whose crest crosses his whole body in `cross` seconds, then settles over
   `settle`. `span` is the farthest point of his body from the touch, in screen heights. */
export function startWave(x, y, span, cross = 0.6, settle = 0.4) {
  const c = Number.isFinite(cross) && cross > 0.05 ? cross : 0.6;
  const s = Number.isFinite(span) && span > 0 ? span : 0.2;
  return { x, y, speed: s / c, cross: c, settle: Number.isFinite(settle) && settle > 0 ? settle : 0.4, age: 0 };
}

/* Radius and envelope at the wave's age; `level` 0 means it has settled and can be dropped. */
export function waveState(w, out = {}) {
  out.r = w.speed * w.age;
  const rise = Math.min(1, w.age / 0.08);
  const past = w.age - w.cross;
  const fall = past <= 0 ? 1 : Math.max(0, 1 - past / w.settle);
  out.level = rise * fall * fall;
  return out;
}

/* Is a hand at (fx, fz) on a body drawn along `pts` (anything with x and z), within `reach`? */
export function touchesBody(pts, fx, fz, reach) {
  if (!pts?.length || !Number.isFinite(fx) || !Number.isFinite(fz) || !(reach > 0)) return false;
  const r2 = reach * reach;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((fx - a.x) * ex + (fz - a.z) * ez) / l2)) : 0;
    const qx = a.x + ex * t - fx, qz = a.z + ez * t - fz;
    if (qx * qx + qz * qz <= r2) return true;
  }
  return false;
}

/* The farthest body point from (fx, fz): how far the wave has to travel to cross all of him. */
export function farthestFrom(pts, fx, fz) {
  let m = 0;
  for (const p of pts ?? []) {
    const d = Math.hypot(p.x - fx, p.z - fz);
    if (d > m) m = d;
  }
  return m;
}

// The baked nebula

/* The tile is NEB_PERIOD cells on a side; the finer octaves run at 2.1× and 4.4× that, so each lattice
   closes on a whole cell count (10, 21, 44) and repeats — 2.5 screen heights at the default nebFreq of 4. */
export const NEB_PERIOD = 10;
export const NEB_OCTAVES = [
  { freq: 1, cells: 10, shift: [0, 0], lean: [0, 0] },
  { freq: 2.1, cells: 21, shift: [17.3, 17.3], lean: [1, -1.3] },
  { freq: 4.4, cells: 44, shift: [41.7, 41.7], lean: [1, 0.8] },
];
export const NEB_RES = 512;
export const NEB_SEED_SPAN = 1 << 20;

/* A fresh nebula every page load, or ?nebseed=N to keep a favorite. Render side only: Math.random,
   never a sim generator. */
export function nebulaSeed(search = '', rand = Math.random) {
  const raw = new URLSearchParams(search ?? '').get('nebseed');
  if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Math.abs(Math.trunc(Number(raw))) % NEB_SEED_SPAN;
  }
  const r = rand();
  return Math.floor((Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999999) : 0) * NEB_SEED_SPAN);
}

/* The bake's three octaves on the CPU, for the tests: each is value noise on its own wrapped lattice,
   the second warped by the first and the third by the second, exactly as the shader writes them. */
export function nebulaTile(qx, qy, seed, warp) {
  const out = [0, 0, 0];
  let prev = 0;
  for (let k = 0; k < 3; k++) {
    const o = NEB_OCTAVES[k];
    const w = k === 0 ? 0 : prev * warp;
    const x = qx * o.freq + w * o.lean[0] + o.shift[0];
    const y = qy * o.freq + w * o.lean[1] + o.shift[1];
    out[k] = prev = periodicNoise(x, y, o.cells, seed + k);
  }
  return out;
}

export function periodicNoise(x, y, P, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const wrap = (i) => i - Math.floor(i / P) * P;
  const x0 = wrap(ix), x1 = wrap(ix + 1), y0 = wrap(iy), y1 = wrap(iy + 1);
  const h = (a, b) => hash3(a, b, seed)[0];
  const top = h(x0, y0) + (h(x1, y0) - h(x0, y0)) * ux;
  const bot = h(x0, y1) + (h(x1, y1) - h(x0, y1)) * ux;
  return top + (bot - top) * uy;
}

/* How far the peek has lifted his head, 0 to 1: the moon pull eases in as the snout breaks the plane. */
export function peekLift(headY, radius) {
  if (!Number.isFinite(headY) || !(radius > 0)) return 0;
  const t = Math.min(1, Math.max(0, (headY + radius) / (2 * radius)));
  return t * t * (3 - 2 * t);
}
