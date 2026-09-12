/* THREE-free math behind the shoals and the rush tussocks: the quartic mound, the circular-arc stem,
   the clump layout, and the moon-projected shadow proxies. Pure functions, so the tests can hit them. */

import { DEPTH } from './config.js';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

// Shoals. Soft rush is a margin plant (saturated bank to 15–30 cm of standing water), and this pond's
// only margin is the frame's edge, so the mounds hug an edge band and some lean in from past it.
export const SHOAL_COUNT = [5, 8];
export const SHOAL_RX = [1.0, 2.0];
export const SHOAL_ASPECT = [0.7, 1.0];
// Submerged crests stay under -0.30: a 0.12-radius body's floor bound (crest + r + 0.08) must clear its
// ceiling (-0.5 r) or collide() pins it; emergent crests are shallow bumps that break the film.
export const SHOAL_CREST = [-0.45, -0.30], SHOAL_EMERGENT = [0.02, 0.06];
export const SHOAL_EMERGENT_CHANCE = 0.2;
export const SHOAL_MIN_SEP = 2.6;
export const SHOAL_CLEAR = 0.6;              // margin outside a rock's rHit or the log capsule, past the mound's own extent
export const SHOAL_EXTENT = 0.6;             // of the larger semi-axis: the quartic is under a tenth of its height past this
export const SHOAL_EDGE = [0.72, 1.08];      // of the half-extent, on the axis that meets the chosen edge
export const SHOAL_ALONG = 0.95;             // of the half-extent, anywhere along that edge
export const SHOAL_TRIES = 30;

// Tussocks, in three densities so a pond reads as colonies at different ages rather than one clump stamped
// five times: a sparse pioneer, the ordinary clump, and a thick old stand.
export const DENSITY = [
  { name: 'sparse', core: [3, 5], disc: [0.22, 0.36], odds: 0.3 },
  { name: 'normal', core: [6, 8], disc: [0.18, 0.32], odds: 0.45 },
  { name: 'thick', core: [10, 14], disc: [0.26, 0.42], odds: 0.25 },
];
export const CORE_HARD = [3, 14];
export const RUNNERS = [1, 2];
export const ALIVE = [40, 72];
export const BASE_DISC = [0.18, 0.32];
// Pads: an emergent stem that rises under a pad reads as squashed by it, so the arc above this depth
// must clear every pad disc by PAD_CLEAR, or the stem re-aims, or shortens until it stays under.
export const PAD_CLEAR = 0.25, PAD_DEPTH = -0.05, PAD_SUBMERGE = -0.08, PAD_TRIES = 6;
export const RUNNER_OUT = [1.5, 4.0];
export const RUNNER_JITTER = 20 * D2R;
export const RUNNER_TRIES = 12;
export const FAN = [45 * D2R, 70 * D2R];
export const AZ_JITTER = 0.20;               // of a stem's own azimuth slot, so the fan never combs
export const MIN_AZ_GAP = 10 * D2R;          // guaranteed, by widening the slot rather than re-rolling into it
export const MAX_FAN_SPAN = Math.PI;         // the widest a tussock ever opens: nothing points backward
export const LEN_MAX = [1.4, 2.0];
export const LEN_SHARE = [0.7, 0.9];
export const LEN_MIN = 0.6;
export const DEAD_SHARE = [0.15, 0.25], DEAD_LEN = [0.4, 0.6];
export const HEAD_CHANCE = 0.3, HEAD_SIZE = [0.6, 1.0];
export const HUE_JITTER = 0.06;
export const WIDTH_MUL = [0.85, 1.25];
export const TIP_CEIL = 1.0;                 // world y a tip may reach; past it a rush reads as a mast
/* Past about a radian the tip travels further out than up and a stem reads, from straight above, as a
   straw dropped on the water. A rush stands: the lean stays well under horizontal, straw leans further. */
export const LEAN = [0.60, 1.10];
export const LEAN_DEAD = [0.90, 1.30];

// Shadow proxies
export const SHADOW_SPREAD = 25 * D2R;
export const SHADOW_LEAN = 0.78;             // moonlight at 52 degrees lands a tip this far along the azimuth
export const SHADOW_R = [0.10, 0.14];
export const SHADOW_CAPS = 10;

/* The shoal profile: a rotated elliptical quartic. The flat edge derivative settles the mound into the
   sand instead of standing it on top, and there is no square root on this per-spine-point path. */
export function shoalHeight(s, x, z) {
  const dx = x - s.x, dz = z - s.z, bound = s.rx + s.rz;
  if (dx > bound || dx < -bound || dz > bound || dz < -bound) return 0;
  const u = dx * s.cosR - dz * s.sinR, w = dx * s.sinR + dz * s.cosR;
  const qx = u / s.rx, qz = w / s.rz;
  const k = 1 - (qx * qx + qz * qz);
  return k > 0 ? s.h * k * k : 0;
}

export function shoalSum(shoals, x, z) {
  let y = 0;
  for (let i = 0; i < shoals.length; i++) y += shoalHeight(shoals[i], x, z);
  return y;
}

function seg2(px, pz, a) {
  const ux = a.bx - a.ax, uz = a.bz - a.az;
  const l2 = ux * ux + uz * uz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - a.ax) * ux + (pz - a.az) * uz) / l2));
  return Math.hypot(px - (a.ax + ux * t), pz - (a.az + uz * t));
}

/* Shoal placement: an edge band around the boot-time view rect (the pond's stand-in for a shore), clear
   of the rocks and the log, spaced from each other. Fewer shoals rather than one on a rock. */
export function placeShoals(rng, view, obstacles = {}, max = 5) {
  const spheres = obstacles.spheres ?? [], logs = obstacles.logs ?? [];
  const out = [];
  const want = Math.min(max, rng.int(SHOAL_COUNT[0], SHOAL_COUNT[1]));
  for (let i = 0; i < want; i++) {
    const rx = rng.range(SHOAL_RX[0], SHOAL_RX[1]);
    const rz = rx * rng.range(SHOAL_ASPECT[0], SHOAL_ASPECT[1]);
    const rot = rng.range(0, Math.PI);
    // About one pond in five gets a crest that breaks the film; the rest stay speed bumps under it.
    const crest = rng.chance(SHOAL_EMERGENT_CHANCE)
      ? rng.range(SHOAL_EMERGENT[0], SHOAL_EMERGENT[1])
      : rng.range(SHOAL_CREST[0], SHOAL_CREST[1]);
    let x = 0, z = 0, ok = false;
    for (let tries = 0; tries < SHOAL_TRIES; tries++) {
      // One of the four edges, weighted by length so the long sides carry more of the margin.
      const edge = rng.next() < view.w / (view.w + view.h) ? 'z' : 'x';
      const off = rng.range(SHOAL_EDGE[0], SHOAL_EDGE[1]) * (rng.chance(0.5) ? 1 : -1);
      const along = rng.range(-SHOAL_ALONG, SHOAL_ALONG);
      if (edge === 'x') { x = off * (view.w / 2); z = along * (view.h / 2); }
      else { z = off * (view.h / 2); x = along * (view.w / 2); }
      // Clearances grow with the mound: a two-unit shoal must not lift the sand under a rock or the log,
      // and two mounds too close merge into one compound hump with two tussocks on it.
      const ext = Math.max(rx, rz) * SHOAL_EXTENT;
      if (spheres.some((o) => Math.hypot(o.x - x, o.z - z) < (o.rHit ?? o.r) + SHOAL_CLEAR + ext)) continue;
      if (logs.some((l) => seg2(x, z, l) < l.rOuter + SHOAL_CLEAR + ext)) continue;
      if (out.some((s) => Math.hypot(s.x - x, s.z - z) < SHOAL_MIN_SEP + ext + Math.max(s.rx, s.rz) * SHOAL_EXTENT)) continue;
      ok = true;
      break;
    }
    if (!ok) continue;
    out.push({ x, z, rx, rz, rot, crest, h: crest + DEPTH, emergent: crest > 0, cosR: Math.cos(-rot), sinR: Math.sin(-rot) });
  }
  return out;
}

/* Radius fraction where the quartic crosses the film, for the waterline disc. Zero for a mound that
   never breaks it, so a submerged shoal is asked for no chord. */
export function shoalChordFrac(h, depth) {
  if (!(h > depth)) return 0;
  return Math.sqrt(1 - Math.sqrt(depth / h));
}

/* A stem of arc length len leaning by theta, as a circular arc: exact length at any bend, so a parted
   rush never grows. Returns the tip's horizontal travel and its rise above the base. */
export function arcTip(len, theta) {
  const th = Math.max(theta, 1e-3), R = len / th;
  return { horiz: R * (1 - Math.cos(th)), height: R * Math.sin(th) };
}

/* The inverse: the arc length whose tip rises exactly `rise` at this lean. */
export function lenForRise(rise, theta) {
  const th = Math.max(theta, 1e-3);
  return rise * th / Math.sin(th);
}

/* Toward whichever frame edge is nearest, so every tussock leans out of the corner it grew in. */
export function runnerBearing(rng, s, view) {
  const gx = view.w / 2 - Math.abs(s.x), gz = view.h / 2 - Math.abs(s.z);
  const ang = gx <= gz ? (s.x >= 0 ? 0 : Math.PI) : (s.z >= 0 ? Math.PI / 2 : -Math.PI / 2);
  return ang + rng.range(-RUNNER_JITTER, RUNNER_JITTER);
}

/* The resting arc at fraction v of the length: the same circular arc the position node draws. */
export function arcPoint(x, y, z, az, len, lean, v) {
  const th = Math.max(lean, 1e-3) * v, R = len / Math.max(lean, 1e-3);
  const out = R * (1 - Math.cos(th));
  return { x: x + Math.cos(az) * out, y: y + R * Math.sin(th), z: z + Math.sin(az) * out };
}

/* True when any part of the resting arc that rises past PAD_DEPTH lies inside a pad disc. */
export function underPad(padAt, x, y, z, az, len, lean) {
  for (const v of [0.45, 0.65, 0.82, 1]) {
    const q = arcPoint(x, y, z, az, len, lean, v);
    if (q.y > PAD_DEPTH && padAt(q.x, q.z, PAD_CLEAR)) return true;
  }
  return false;
}

function gapOk(az, taken) {
  for (const a of taken) {
    let d = Math.abs(az - a) % TAU;
    if (d > Math.PI) d = TAU - d;
    if (d < MIN_AZ_GAP) return false;
  }
  return true;
}

function makeStem(rng, t, bx, bz, az, tall, floorAt, padAt, taken = null) {
  const dead = !tall && rng.chance(t.deadShare);
  const band = dead ? LEAN_DEAD : LEAN;
  const lean = rng.range(band[0], band[1]);
  const share = dead ? rng.range(DEAD_LEN[0], DEAD_LEN[1]) : rng.range(LEN_SHARE[0], LEN_SHARE[1]);
  let len = tall ? t.lenMax : t.lenMax * share;
  const y = floorAt(bx, bz);
  if (arcTip(len, lean).height > TIP_CEIL - y) len = Math.max(LEN_MIN, lenForRise(TIP_CEIL - y, lean));
  // A pad over the emergent arc: swing the stem around its fan first, and if every try still rises
  // under a pad, keep it under the film instead. A stem that cannot even do that is not grown.
  if (padAt && underPad(padAt, bx, y, bz, az, len, lean)) {
    let found = false;
    for (let k = 0; k < PAD_TRIES && !found; k++) {
      const a2 = az + rng.range(-t.fan, t.fan);
      // A re-aim may leave its slot but never land on a neighbor: the gap guarantee holds either way.
      if (!underPad(padAt, bx, y, bz, a2, len, lean) && (!taken || gapOk(a2, taken))) { az = a2; found = true; }
    }
    if (!found) {
      const rise = PAD_SUBMERGE - y;
      if (rise <= 0.15) return null;
      len = Math.min(len, lenForRise(rise, lean));
      if (len < LEN_MIN * 0.5) return null;
    }
  }
  const seed = rng.next();
  const phase = rng.range(0, TAU);
  const hue = rng.range(-HUE_JITTER, HUE_JITTER);
  const width = rng.range(WIDTH_MUL[0], WIDTH_MUL[1]);
  const head = !dead && rng.chance(HEAD_CHANCE) ? rng.range(HEAD_SIZE[0], HEAD_SIZE[1]) : 0;
  const tip = arcTip(len, lean);
  if (taken) taken.push(az);
  return { x: bx, y, z: bz, azimuth: az, len, lean, phase, seed, dead: dead ? 1 : 0, hue, width, head, tip };
}

/* One tussock per shoal: a core fanned around the runner bearing plus one or two loners out along it.
   `opts.floorAt(x, z)` is the sand (shoal included) and `opts.blocked(x, z)` rejects a runner site. */
export function layoutTussocks(rng, shoals, view, opts = {}) {
  const floorAt = opts.floorAt ?? (() => 0);
  const blocked = opts.blocked ?? (() => false);
  const padAt = opts.padAt ?? null;
  const pool = opts.pool ?? 80;
  const tussocks = [], stems = [];
  const n = shoals.length;
  if (!n) return { tussocks, stems };

  const runners = shoals.map(() => rng.int(RUNNERS[0], RUNNERS[1]));
  const kinds = shoals.map(() => {
    let u = rng.next();
    for (const d of DENSITY) { if (u < d.odds) return d; u -= d.odds; }
    return DENSITY[DENSITY.length - 1];
  });
  const cores = kinds.map((d) => rng.int(d.core[0], d.core[1]));
  const want = Math.min(pool, rng.int(ALIVE[0], ALIVE[1]));
  let total = cores.reduce((a, b) => a + b, 0) + runners.reduce((a, b) => a + b, 0);
  // The pond carries a stem budget, not the shoals: trim the fattest tussock and feed the thinnest so
  // a five-shoal seed stays inside the pool without emptying its last clump to pay for the first.
  for (let guard = 0; total > want && guard < 200; guard++) {
    let i = 0;
    for (let k = 1; k < n; k++) if (cores[k] > cores[i]) i = k;
    if (cores[i] <= CORE_HARD[0]) break;
    cores[i]--; total--;
  }
  for (let guard = 0; total < want && guard < 200; guard++) {
    let i = 0;
    for (let k = 1; k < n; k++) if (cores[k] < cores[i]) i = k;
    if (cores[i] >= CORE_HARD[1]) break;
    cores[i]++; total++;
  }

  for (let i = 0; i < n; i++) {
    const s = shoals[i];
    const runner = runnerBearing(rng, s, view);
    const fan = rng.range(FAN[0], FAN[1]);
    const t = {
      x: s.x, z: s.z, runner, fan, kind: kinds[i].name,
      lenMax: rng.range(LEN_MAX[0], LEN_MAX[1]),
      deadShare: rng.range(DEAD_SHARE[0], DEAD_SHARE[1]),
      shadowR: rng.range(SHADOW_R[0], SHADOW_R[1]),
      start: stems.length, count: 0, meanHoriz: 0, meanTipY: 0,
    };
    const discR = rng.range(kinds[i].disc[0], kinds[i].disc[1]);
    const count = cores[i];
    // One or two full-height silhouettes per tussock, picked before the loop so the stream never
    // depends on how many stems a rejection dropped.
    const t0 = rng.int(0, count - 1);
    const t1 = rng.int(1, 2) > 1 && count > 1 ? (t0 + 1 + rng.int(0, count - 2)) % count : -1;
    // Wide enough to guarantee MIN_AZ_GAP between neighbors even at the jitter's worst draw, but never
    // past a half circle: a rejection loop cannot hold 10 degrees between eight stems in a 90-degree fan.
    const span = Math.min(MAX_FAN_SPAN / count, Math.max(2 * fan / count, MIN_AZ_GAP / (1 - 2 * AZ_JITTER)));
    // A thick stand's slots are narrow, so the jitter shrinks with them and the gap guarantee survives.
    const jit = Math.max(0, Math.min(AZ_JITTER, (span - MIN_AZ_GAP) / (2 * span)));
    const taken = [];
    for (let k = 0; k < count; k++) {
      const a = rng.range(0, TAU), d = discR * Math.sqrt(rng.next());
      const bx = s.x + Math.cos(a) * d, bz = s.z + Math.sin(a) * d;
      const az = runner + (k - (count - 1) / 2) * span + rng.range(-jit, jit) * span;
      const st = makeStem(rng, t, bx, bz, az, k === t0 || k === t1, floorAt, padAt, taken);
      if (st) stems.push(st);
    }
    for (let k = 0; k < runners[i]; k++) {
      let bx = 0, bz = 0, ok = false;
      for (let tries = 0; tries < RUNNER_TRIES; tries++) {
        const d = rng.range(RUNNER_OUT[0], RUNNER_OUT[1]);
        const a = runner + rng.range(-fan, fan) * 0.5;
        bx = s.x + Math.cos(a) * d; bz = s.z + Math.sin(a) * d;
        if (!blocked(bx, bz, s)) { ok = true; break; }
      }
      if (!ok) continue;
      const st = makeStem(rng, t, bx, bz, runner + rng.range(-fan, fan), false, floorAt, padAt);
      if (st) stems.push(st);
    }
    t.count = stems.length - t.start;
    let horiz = 0, tipY = 0, live = 0;
    for (let k = t.start; k < stems.length; k++) {
      const st = stems[k];
      if (st.dead) continue;
      horiz += st.tip.horiz; tipY += Math.max(0, st.y + st.tip.height); live++;
    }
    if (live) { t.meanHoriz = horiz / live; t.meanTipY = tipY / live; }
    tussocks.push(t);
  }
  return { tussocks, stems };
}

/* Two rest-pose fan capsules per tussock, from its center to the mean air-projected tip. Rest pose on
   purpose: the cover bake runs every 2 s while stems part instantly, so a live shadow would jump. */
export function shadowCapsules(t, moonAz, strength = 0.3, out = []) {
  for (const sgn of [1, -1]) {
    const a = t.runner + sgn * SHADOW_SPREAD;
    out.push({
      ax: t.x, az: t.z,
      bx: t.x + Math.cos(a) * t.meanHoriz + moonAz.x * SHADOW_LEAN * t.meanTipY,
      bz: t.z + Math.sin(a) * t.meanHoriz + moonAz.z * SHADOW_LEAN * t.meanTipY,
      r: t.shadowR, strength,
    });
  }
  return out;
}
