import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, varying, positionGeometry, vec2, vec3, vec4, float, sin, cos, dot, cross, length, normalize, mix, smoothstep, pow, select, frontFacing, PI } from 'three/tsl';
import { DEPTH, INF_SLOTS, MOON_ORBIT_SECONDS } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { makeCurrent, capsuleInfluenceCPU, valueNoise2 } from './shading.js';

/* Cladophora: filaments in strips along the waterline and over submerged stone, plus a haze quad per tuft
   so the mass reads as a glowing cloud. Two instanced draws, both additive, destination alpha untouched. */

export const TUFT_POOL = 64;
const STRAND_MAX = 16;
const STRAND_POOL = TUFT_POOL * STRAND_MAX;
const TUFT_SALT = 1700;
const TUFT_TARGET = [40, 64];
const STRANDS = [8, 13], STRANDS_BIG = [13, STRAND_MAX];
const STRAND_SEGS = 5;                     // 6 rows × 2 = 12 vertices, 10 triangles
const MIN_SEP = 0.25;                      // holdfast spacing for the scatter, 3D
const VIEW_MARGIN = 0.6;

// 13 cm of real Cladophora is 0.78 units and the ordinary band sits under it. One in six is a monster
// well past that, half an eel long, paid out of the same strand pool, so the rest run leaner.
const TUFT_LEN = [0.30, 0.70];
const TUFT_LEN_BIG = [0.90, 1.30];
const BIG_CHANCE = 1 / 6;
const STRAND_LEN_SPREAD = [0.55, 1.0];     // each strand's share of its tuft's length
const TUFT_LEN_MIN = 0.10;
// A monster flops rather than standing: without cutting its rise toward up, the headroom cap in 0.8
// units of water would shave every big tuft straight back to an ordinary one.
const BIG_UP_BLEND = 0.35;
const W_BASE = [0.018, 0.026], W_TIP = 0.004;
const FAN_SPREAD = 35 * Math.PI / 180, FAN_SPREAD_BIG = 58 * Math.PI / 180;
const REST_LEAN = [0.40, 1.25];            // rad, per tuft; without a resting arch a strand is edge-on to the top-down camera
const LEAN_JITTER = [0.8, 1.25];           // per strand, around its tuft's lean
const LEAN_MAX = 1.3;                      // uTuftBendMax; past it the shader clamps anyway
const LEAN_STRIP = 0.22, LEAN_DEEP = 0.18, LEAN_DEEP_AT = 0.35;
// Yaw is a full circle around the holdfast normal, tilt is how far off it the whole tuft leans. Without
// the yaw every tuft on a log leans the same way off the bark and the row reads as a comb.
const TILT = [0.10, 0.80], TILT_BIG = [0.55, 1.30];
const STRAND_SCATTER = 0.16;               // per-strand tilt off the tuft axis, so no two strands share a plane
const CURL = 0.25, OMEGA = [1.0, 2.0];
const MEANDER_GAIN = 0.03;                 // shared with uTuftMeander: the CPU bows against this exact number
const MEANDER_AMP = [0.6, 1.4], MEANDER_F = [0.85, 1.25];
const STRAND_ALPHA = [0.35, 0.8];

// Placement. Emergent rocks and half-drowned trunks wear waterline strips; everything else is scattered.
const EMERGENT_TOP = -0.04;
const STRIP_STEP = [0.30, 0.40];           // arc between holdfasts along a strip
const STRIP_Y = [-0.16, -0.06];            // the band of substrate the water actually laps
const STRIP_RING = [3, 24];
const STRIP_SHARE = 0.7;                   // of the budget claimed by strips before the scatter fills in
// Strips grow as colonies, not fences: a couple of tight runs per flank, long bare stretches between,
// a bare side now and then, and the odd loner. Narrow colonies over a finer walk is what packs them.
const COLONIES = [1, 2], COLONY_W = [0.03, 0.14], COLONY_STRAY = 0.06, SIDE_BARE = 0.35;
const RING_ARCS = [1, 2], RING_ARC_W = [0.4, 1.6];
const FLANK_STEP = 0.5, RING_STEP = 0.65;  // of STRIP_STEP, so a colony has holdfasts to spend
// A slice of the budget buys second holdfasts beside chosen ones rather than new sites: two fans
// growing through each other is what a clump looks like from above.
const STACK_SHARE = 0.18, STACK_CHANCE = 0.35, STACK_OFF = [0.02, 0.07], STACK_RISE = 0.02;
const STRIP_DOWN = [0.15, 0.55];
const STRIP_YAW = 1.2;                     // how far a streamer swings off the outward normal before it is inside the stone
const BISECT_STEPS = 10;                   // π/2^10 is under a millimeter of bark
const FLANK_Y = [-0.30, -0.10];
const ROCK_FLANK = [1, 3], EMERGENT_FLANK = [2, 3];
const SPREAD_TRIES = 4;                    // angles rolled per holdfast; the loosest one wins
const CROWN_BAND = [0.05, 0.25];           // how far below a submerged crown its flank tufts sit
const FLOOR_MARGIN = 0.08, SURFACE_MARGIN = 0.06;
const LOG_TUFTS = [3, 5], LOG_T = [0.12, 0.88], LOG_TOP_Y = -0.08, LOG_PHI_SIN = 0.78;

// Rise direction: normalize(mix(axis, up, blend)). The blend shrinks in the shallows so a strand on a
// near-surface flank leans out instead of standing up through the waterline.
const UP_BLEND = 0.6, UP_BLEND_DEPTH = 0.40, UP_BLEND_FLOOR = 0.2;

const CLOUD_R = [0.30, 0.55];
const CLOUD_LEN_REF = 0.50, CLOUD_SCALE = [0.8, 1.7];
const CLOUD_FOLLOW = 0.5;                  // the haze centers over the middle of the fan, not over the tips
const CLOUD_HZ = [0.05, 0.10];
const CLOUD_LIFT = 0.10;                   // the haze sits camera-side of its rock or the stone halves it

// CPU bend lag. Fast to lay over, slow to recover: water damps a tuft far harder than air damps a reed.
const ATTACK_TAU = 0.25, RECOVER_TAU = 3.5;
const BEND_GAIN = 0.9, REDUCED_BEND = 0.5, MASS_SOFT = 0.6;
const DT_MAX = 0.1;

// Grazing: the strands collapse fast, then creep back over a whole orbit. A re-upload every half
// second is finer than a filament growing 0.0004 units a second could ever show.
const BITE_FALL = 0.3, BITE_REGROW = MOON_ORBIT_SECONDS, BITE_UPLOAD = 0.5;

/* How far a resting strand of unit length ever gets above and below its holdfast. A tip-only bound
   misses the interior maximum, which is where a down-leaning strand actually reaches the waterline. */
const reach = { up: 0, down: 0 };
function arcReach(riseY, latY, bend) {
  const m = Math.hypot(riseY, latY), lo = -Math.atan2(latY, riseY), hi = bend + lo;
  const sl = Math.sin(lo), sh = Math.sin(hi);
  // bend is at most LEAN_MAX and lo lands in [−π, π], so ±π/2 are the only turning points in the sweep.
  const mx = lo <= Math.PI / 2 && hi >= Math.PI / 2 ? 1 : Math.max(sl, sh);
  const mn = lo <= -Math.PI / 2 && hi >= -Math.PI / 2 ? -1 : Math.min(sl, sh);
  reach.up = (latY + m * mx) / bend;
  reach.down = (latY + m * mn) / bend;
}

function makeStrandGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  const rows = STRAND_SEGS + 1;
  // Row and side share one vec2: WebGPU binds at most 8 vertex buffers and the strand carries 5 instanced ones.
  const aRib = [];
  for (let r = 0; r < rows; r++) for (const s of [-1, 1]) aRib.push(r / STRAND_SEGS, s);
  const idx = [];
  for (let r = 0; r < STRAND_SEGS; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, d, a, d, c);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(rows * 2 * 3), 3));
  // shade() carries texture nodes whose default uv resolves at build; WebGL2 warns when it is missing.
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(rows * 2 * 2), 2));
  geo.setAttribute('aRib', new THREE.Float32BufferAttribute(aRib, 2));
  geo.setIndex(idx);
  return geo;
}

/* Horizontal, because the camera looks straight down: an xz quad is already the billboard. */
function makeCloudGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

/* Additive with the alpha equation pinned to (0, 1): underRT's alpha is the depth fraction the compose
   pass refracts by, so the strands may add light but must never touch it. */
function setAdditive(mat) {
  mat.transparent = true;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  mat.depthTest = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  mat.forceSinglePass = true;
}

export class AlgaeTufts {
  constructor({ underScene, U, shading, wake, seed, colliders, motion, view }) {
    this.U = U;
    this.motion = motion;
    this.tufts = [];
    this.strandCount = 0;
    this.pushTmp = { x: 0, z: 0 };
    this.bitten = 0;      // grazed tufts still collapsing or regrowing; 0 means stepBites costs nothing
    this.biteAcc = 0;
    this.layout(seed, view, colliders);
    const current = makeCurrent(U);
    this.build(U, shading, wake, current);
    this.buildCloud(U, shading, current);
    underScene.add(this.mesh);
    underScene.add(this.cloudMesh);
  }

  /* Strips first: emergent rocks wear a collar and half-drowned trunks wear two flanking lines, both
     walked by arc length. The scatter (crowns, submerged flanks) fills whatever budget is left. */
  layout(seed, view, colliders) {
    const rng = createRng(deriveSeed(seed, TUFT_SALT));
    const ex = view.w / 2 + VIEW_MARGIN, ez = view.h / 2 + VIEW_MARGIN;
    const inView = (x, z) => Math.abs(x) <= ex && Math.abs(z) <= ez;
    const strips = [], scatter = [];

    for (const s of colliders.spheres) {
      if (!inView(s.x, s.z)) continue;
      // top - y recovers the vertical semi-axis the rock's squash left out of the collider, so a
      // holdfast lands on the stone instead of floating beside it.
      const ry = s.top - s.y;
      // s.y below the floor is a shoal mound's buried sphere, not a rock; its flank is nowhere near the sand.
      if (!(ry > 0.02) || !(s.r > 0.05) || s.y <= -DEPTH) continue;
      const submerged = s.top < EMERGENT_TOP;
      if (submerged) {
        if (s.top < -SURFACE_MARGIN) scatter.push({ x: s.x, y: s.top, z: s.z, nx: 0, ny: 1, nz: 0 });
      } else {
        this.waterlineRing(rng, s, ry, inView, strips);
      }
      const band = submerged ? ROCK_FLANK : EMERGENT_FLANK;
      const lo = submerged ? s.top - CROWN_BAND[1] : FLANK_Y[0];
      // An emergent rock now wears a collar, so its scattered flank tufts drop clear of that band
      // instead of contesting the same six centimeters of stone.
      const hi = submerged ? s.top - CROWN_BAND[0] : Math.min(FLANK_Y[1], STRIP_Y[0] - 0.04);
      const n = rng.int(band[0], band[1]);
      const near = [];
      for (let i = 0; i < n; i++) {
        const f = this.flankOnRock(rng, s, ry, lo, hi, near);
        if (f) { near.push(f); scatter.push(f); }
      }
    }

    for (const l of colliders.logs) {
      if (!(l.rInner > 0) || !(l.rOuter > 0.02)) continue;   // rInner 0 is a branch stub
      const dx = l.b.x - l.a.x, dz = l.b.z - l.a.z;
      const alen = Math.hypot(dx, dz);
      if (alen < 1e-3) continue;
      // A trunk whose bark breaks the surface gets the strip treatment; a sunk one keeps the scatter.
      if (l.bark && l.a.y + l.rOuter > 0 && this.waterlineFlanks(rng, l, alen, inView, strips) > 0) continue;
      const px = -dz / alen, pz = dx / alen;
      const logY = l.a.y;
      const lo = Math.max(-LOG_PHI_SIN, (-DEPTH + FLOOR_MARGIN - logY) / l.rOuter);
      const hi = Math.min(LOG_PHI_SIN, (LOG_TOP_Y - logY) / l.rOuter);
      if (lo >= hi) continue;
      const n = rng.int(LOG_TUFTS[0], LOG_TUFTS[1]);
      for (let i = 0; i < n; i++) {
        const t = rng.range(LOG_T[0], LOG_T[1]);
        const cx = l.a.x + dx * t, cz = l.a.z + dz * t;
        if (!inView(cx, cz)) continue;
        const sv = rng.range(lo, hi), side = rng.chance(0.5) ? 1 : -1;
        if (l.bark) {
          // The collider is a crest-plus-bend envelope; the shaped bark is where a holdfast can actually grip.
          const b = l.bark(t, Math.acos(sv) * side);
          if (b.y > LOG_TOP_Y || b.y < -DEPTH + FLOOR_MARGIN) continue;
          scatter.push(b);
          continue;
        }
        const cv = Math.sqrt(Math.max(0, 1 - sv * sv)) * side;
        const nx = px * cv, nz = pz * cv;
        scatter.push({ x: cx + nx * l.rOuter, y: logY + sv * l.rOuter, z: cz + nz * l.rOuter, nx, ny: sv, nz });
      }
    }

    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
    };
    shuffle(strips); shuffle(scatter);
    const cap = Math.min(rng.int(TUFT_TARGET[0], TUFT_TARGET[1]), TUFT_POOL);
    const sites = Math.max(1, Math.round(cap * (1 - STACK_SHARE)));
    const share = Math.round(sites * STRIP_SHARE);
    const kept = [];
    let si = 0;
    for (; si < strips.length && kept.length < share; si++) kept.push(strips[si]);
    for (const s of scatter) {
      if (kept.length >= sites) break;
      // Strips space themselves by STRIP_STEP, so only the scattered holdfasts police each other.
      if (kept.some((k) => !k.strip && (k.x - s.x) ** 2 + (k.y - s.y) ** 2 + (k.z - s.z) ** 2 < MIN_SEP * MIN_SEP)) continue;
      kept.push(s);
    }
    for (; si < strips.length && kept.length < sites; si++) kept.push(strips[si]);
    // Twins land after the separation pass on purpose: MIN_SEP exists to stop accidental doubles, and
    // these are the deliberate ones.
    const order = kept.map((_, i) => i);
    shuffle(order);
    for (const i of order) {
      if (kept.length >= cap) break;
      if (rng.chance(STACK_CHANCE)) kept.push(this.stackTwin(rng, kept[i]));
    }
    for (const h of kept) this.growTuft(rng, h);
  }

  /* A second holdfast a fan's width from the first, on the same substrate. */
  stackTwin(rng, h) {
    let tx = -h.nz, tz = h.nx;
    const m = Math.hypot(tx, tz);
    if (m < 1e-4) { tx = 1; tz = 0; } else { tx /= m; tz /= m; }
    const d = rng.range(STACK_OFF[0], STACK_OFF[1]) * (rng.chance(0.5) ? 1 : -1);
    return { ...h, x: h.x + tx * d, y: h.y + rng.range(-STACK_RISE, STACK_RISE), z: h.z + tz * d };
  }

  /* The rock's ring at the waterline, walked at a fixed arc step and dropped to just under the surface.
     A boulder wears eight to fifteen holdfasts; a stone barely breaking the surface has no ring at all. */
  waterlineRing(rng, s, ry, inView, out) {
    const dy0 = -s.y / ry;
    const k = 1 - dy0 * dy0;
    if (k < 0.04) return;
    const r0 = s.r * Math.sqrt(k);
    const step = rng.range(STRIP_STEP[0], STRIP_STEP[1]) * RING_STEP;
    const n = Math.max(STRIP_RING[0], Math.min(STRIP_RING[1], Math.round((2 * Math.PI * r0) / step)));
    const th0 = rng.range(0, Math.PI * 2);
    const dth = (Math.PI * 2) / n;
    const arcs = [];
    for (let k = rng.int(RING_ARCS[0], RING_ARCS[1]); k > 0; k--) arcs.push({ c: rng.range(0, Math.PI * 2), w: rng.range(RING_ARC_W[0], RING_ARC_W[1]) * 0.5 });
    for (let i = 0; i < n; i++) {
      const th = th0 + (i + rng.range(-0.4, 0.4)) * dth;
      const inArc = arcs.some((a) => Math.abs(((th - a.c + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI) < a.w);
      if (!inArc && !rng.chance(COLONY_STRAY)) continue;
      const y = rng.range(STRIP_Y[0], STRIP_Y[1]);
      const dy = (y - s.y) / ry;
      const rh = s.r * Math.sqrt(Math.max(0, 1 - dy * dy));
      const x = s.x + rh * Math.cos(th), z = s.z + rh * Math.sin(th);
      if (!inView(x, z)) continue;
      const gx = (x - s.x) / (s.r * s.r), gy = (y - s.y) / (ry * ry), gz = (z - s.z) / (s.r * s.r);
      const m = Math.hypot(gx, gy, gz) || 1;
      out.push({ x, y, z, nx: gx / m, ny: gy / m, nz: gz / m, strip: true });
    }
  }

  /* Both flanks of a half-drowned trunk. The bark radius varies along the log, so the angle that sits
     just under the surface is solved per station and per side rather than assumed. Returns the count. */
  waterlineFlanks(rng, l, alen, inView, out) {
    const step = rng.range(STRIP_STEP[0], STRIP_STEP[1]) * FLANK_STEP;
    const span = LOG_T[1] - LOG_T[0];
    const n = Math.max(2, Math.min(32, Math.round((alen * span) / step)));
    let placed = 0;
    for (const sgn of [1, -1]) {
      if (rng.chance(SIDE_BARE)) continue;
      const colonies = [];
      for (let k = rng.int(COLONIES[0], COLONIES[1]); k > 0; k--) colonies.push({ c: rng.range(LOG_T[0], LOG_T[1]), w: rng.range(COLONY_W[0], COLONY_W[1]) });
      for (let i = 0; i < n; i++) {
        const t = LOG_T[0] + span * ((i + rng.range(0.1, 0.9)) / n);
        if (!colonies.some((c) => Math.abs(t - c.c) < c.w) && !rng.chance(COLONY_STRAY)) continue;
        const target = rng.range(STRIP_Y[0], STRIP_Y[1]);
        const ang = this.barkAngleAt(l, t, target, sgn);
        if (ang === null) continue;
        const b = l.bark(t, ang);
        if (!inView(b.x, b.z)) continue;
        if (b.y > LOG_TOP_Y || b.y < -DEPTH + FLOOR_MARGIN) continue;
        out.push({ x: b.x, y: b.y, z: b.z, nx: b.nx, ny: b.ny, nz: b.nz, strip: true });
        placed++;
      }
    }
    return placed;
  }

  /* Bark height falls from the ridge (ang 0) to the belly (ang ±PI), so a bracket test plus a fixed
     step count always lands. Null when this station's whole flank is above or below the target. */
  barkAngleAt(l, t, targetY, sgn) {
    let lo = 0, hi = Math.PI;
    if (l.bark(t, 0).y < targetY || l.bark(t, hi * sgn).y > targetY) return null;
    for (let i = 0; i < BISECT_STEPS; i++) {
      const mid = (lo + hi) * 0.5;
      if (l.bark(t, mid * sgn).y > targetY) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5 * sgn;
  }

  /* A point on the rock's ellipsoid between y0 and y1, with the exact gradient normal. Of several rolled
     angles the one farthest from this rock's earlier holdfasts wins, or MIN_SEP throws a twin away. */
  flankOnRock(rng, s, ry, y0, y1, near) {
    const lo = Math.max(y0, -DEPTH + FLOOR_MARGIN, s.y - ry * 0.98);
    const hi = Math.min(y1, -SURFACE_MARGIN, s.y + ry * 0.98);
    if (lo >= hi) return null;
    let best = null, bestGap = -1;
    for (let i = 0; i < SPREAD_TRIES; i++) {
      const y = rng.range(lo, hi);
      const dy = (y - s.y) / ry;
      const rh = s.r * Math.sqrt(Math.max(0, 1 - dy * dy));
      const th = rng.range(0, Math.PI * 2);
      const x = s.x + rh * Math.cos(th), z = s.z + rh * Math.sin(th);
      let gap = Infinity;
      for (const p of near) gap = Math.min(gap, (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2);
      if (gap <= bestGap) continue;
      const gx = (x - s.x) / (s.r * s.r), gy = (y - s.y) / (ry * ry), gz = (z - s.z) / (s.r * s.r);
      const m = Math.hypot(gx, gy, gz) || 1;
      bestGap = gap;
      best = { x, y, z, nx: gx / m, ny: gy / m, nz: gz / m };
      if (gap === Infinity) break;
    }
    return best;
  }

  /* A tuft: an axis yawed and tilted off the holdfast normal, strands fanned about it each on their
     own small tilt, every length capped by the water above and the sand below. */
  growTuft(rng, h) {
    if (this.tufts.length >= TUFT_POOL || this.strandCount + STRAND_MAX > STRAND_POOL) return;
    const depth = -h.y;
    const big = rng.chance(BIG_CHANCE);
    const lenBand = big ? TUFT_LEN_BIG : TUFT_LEN;
    const lenBase = rng.range(lenBand[0], lenBand[1]);
    let rx, ryy, rz;
    if (h.strip) {
      // Right under the surface an upward rise would push every tip through it and the headroom cap
      // would shave the tuft away, so a strip streams outward off the substrate and droops.
      const hh = Math.hypot(h.nx, h.nz) || 1;
      const yaw = rng.range(-STRIP_YAW, STRIP_YAW), cy = Math.cos(yaw), sy = Math.sin(yaw);
      const ox = h.nx / hh, oz = h.nz / hh;
      const down = rng.range(STRIP_DOWN[0], STRIP_DOWN[1]);
      const flat = 1 - down;
      rx = (ox * cy - oz * sy) * flat; rz = (ox * sy + oz * cy) * flat; ryy = -down;
    } else {
      // Perpendicular pair around the normal, p1 the up-most of them, so yaw 0 is the old straight-out lean.
      let p1x = -h.nx * h.ny, p1y = 1 - h.ny * h.ny, p1z = -h.nz * h.ny;
      let m1 = Math.hypot(p1x, p1y, p1z);
      if (m1 < 1e-4) { p1x = 1; p1y = 0; p1z = 0; m1 = 1; }
      p1x /= m1; p1y /= m1; p1z /= m1;
      const p2x = h.ny * p1z - h.nz * p1y, p2y = h.nz * p1x - h.nx * p1z, p2z = h.nx * p1y - h.ny * p1x;
      const tiltBand = big ? TILT_BIG : TILT;
      const yaw = rng.range(0, Math.PI * 2), tilt = rng.range(tiltBand[0], tiltBand[1]);
      const st = Math.sin(tilt), cy = Math.cos(yaw) * st, sy = Math.sin(yaw) * st, ct = Math.cos(tilt);
      const axX = h.nx * ct + p1x * cy + p2x * sy;
      const axY = h.ny * ct + p1y * cy + p2y * sy;
      const axZ = h.nz * ct + p1z * cy + p2z * sy;
      const blend = UP_BLEND * Math.min(1, Math.max(UP_BLEND_FLOOR, depth / UP_BLEND_DEPTH)) * (big ? BIG_UP_BLEND : 1);
      rx = axX * (1 - blend); ryy = axY * (1 - blend) + blend; rz = axZ * (1 - blend);
    }
    const rm = Math.hypot(rx, ryy, rz) || 1;
    rx /= rm; ryy /= rm; rz /= rm;
    const headroom = Math.max(0, depth - SURFACE_MARGIN);
    const floorRoom = Math.max(0, h.y + DEPTH - FLOOR_MARGIN);
    // Best case over the fan is a strand aimed level or below; if even that cannot reach the minimum
    // length under the water above, drop the tuft rather than squash it onto the ceiling.
    if (ryy > 1e-3 && headroom / ryy < TUFT_LEN_MIN) return;

    // Orthonormal frame in the plane the strands fan through.
    let ax = rz, ay = 0, az = -rx;
    const ah = Math.hypot(ax, az);
    if (ah < 1e-4) { ax = 1; ay = 0; az = 0; } else { ax /= ah; az /= ah; }
    const bx = ryy * az - rz * ay, by = rz * ax - rx * az, bz = rx * ay - ryy * ax;

    const strandBand = big ? STRANDS_BIG : STRANDS;
    const count = rng.int(strandBand[0], strandBand[1]);
    const fan = big ? FAN_SPREAD_BIG : FAN_SPREAD;
    // Waterline tufts stream over with the current and deep flanks droop, so the tuft's resting arch
    // is biased by where it sits rather than rolled the same way everywhere.
    const leanC = rng.range(REST_LEAN[0], REST_LEAN[1])
      + (h.strip ? LEAN_STRIP : 0) + (!h.strip && depth > LEAN_DEEP_AT ? LEAN_DEEP : 0);
    const azimuth = rng.range(0, Math.PI * 2);
    const strands = [];
    for (let i = 0; i < count; i++) {
      const a = azimuth + rng.range(-fan, fan);
      const ca = Math.cos(a), sa = Math.sin(a);
      let lx = ax * ca + bx * sa, ly = ay * ca + by * sa, lz = az * ca + bz * sa;
      const sd = rng.range(0, Math.PI * 2), sj = rng.range(0, STRAND_SCATTER);
      const cs = Math.cos(sd), ss = Math.sin(sd), cj = Math.cos(sj), sjs = Math.sin(sj);
      const jx = ax * cs + bx * ss, jy = ay * cs + by * ss, jz = az * cs + bz * ss;
      const srx = rx * cj + jx * sjs, sry = ryy * cj + jy * sjs, srz = rz * cj + jz * sjs;
      // The ribbon plane is cross(rise, lat) with no normalize in the shader, so this strand's own axis
      // and its fan direction have to stay perpendicular and unit after the scatter.
      const d = srx * lx + sry * ly + srz * lz;
      lx -= srx * d; ly -= sry * d; lz -= srz * d;
      const lm = Math.hypot(lx, ly, lz) || 1;
      lx /= lm; ly /= lm; lz /= lm;
      // Rolled before the cap test so a rejected strand never shifts the stream for the ones after it.
      const s = {
        rx: srx, ry: sry, rz: srz, lx, ly, lz,
        len: 0,
        lean: Math.min(LEAN_MAX, leanC * rng.range(LEAN_JITTER[0], LEAN_JITTER[1])),
        width: rng.range(W_BASE[0], W_BASE[1]),
        phase: rng.range(0, Math.PI * 2),
        omega: rng.range(OMEGA[0], OMEGA[1]),
        factor: rng.range(0.8, 1.2),
        curl: rng.range(-CURL, CURL),
        wavePhase: rng.range(0, Math.PI * 2),
        waveAmp: rng.range(MEANDER_AMP[0], MEANDER_AMP[1]),
        alpha: rng.range(STRAND_ALPHA[0], STRAND_ALPHA[1]),
        waveF: rng.range(MEANDER_F[0], MEANDER_F[1]),
      };
      const roll = lenBase * rng.range(STRAND_LEN_SPREAD[0], STRAND_LEN_SPREAD[1]);
      arcReach(sry, ly, Math.max(1e-3, s.lean));
      const cap = reach.up > 1e-3 ? headroom / reach.up : lenBand[1];
      if (cap < TUFT_LEN_MIN) continue;
      // A nub is honest where the sand is close; the alternative is a meter of filament buried in it.
      const capDown = reach.down < -1e-3 ? floorRoom / -reach.down : lenBand[1];
      s.len = Math.max(TUFT_LEN_MIN, Math.min(roll, cap, capDown));
      // The bow's budget is whatever room is left to the water or sand above the arc. A clean bow only
      // swings one way, so its sign picks the margin; the meander spends both, and a maxed strand straightens rather than flattens.
      const wys = srz * lx - srx * lz;
      const mAmp = s.waveAmp * MEANDER_GAIN * Math.abs(wys), halfW = W_BASE[1] * 0.5;
      const bowUp = Math.max(0, wys * s.curl) + mAmp, bowDown = Math.max(0, -wys * s.curl) + mAmp;
      let k = 1;
      if (bowUp > 1e-4) k = Math.min(k, Math.max(0, headroom - s.len * reach.up - halfW) / (s.len * bowUp));
      if (bowDown > 1e-4) k = Math.min(k, Math.max(0, floorRoom + s.len * reach.down - halfW) / (s.len * bowDown));
      if (k < 1) { s.curl *= k; s.waveAmp *= k; }
      strands.push(s);
    }
    const cloud = {
      r: rng.range(CLOUD_R[0], CLOUD_R[1])
        * Math.min(CLOUD_SCALE[1], Math.max(CLOUD_SCALE[0], lenBase / CLOUD_LEN_REF)),
      phase: rng.range(0, Math.PI * 2),
      rate: rng.range(CLOUD_HZ[0], CLOUD_HZ[1]) * Math.PI * 2,
      nx: rng.range(0, 50), nz: rng.range(0, 50),
    };
    if (!strands.length) return;
    // The haze follows the fan's mean lean, so a tuft laid right over drags its cloud along instead
    // of glowing over its own holdfast. Horizontal only: the camera looks straight down.
    let mx = 0, mz = 0;
    for (const s of strands) {
      const t = Math.min(LEAN_MAX, Math.max(1e-3, s.lean)), R = s.len / t;
      const sn = Math.sin(t) * R, cs = (1 - Math.cos(t)) * R;
      mx += s.rx * sn + s.lx * cs;
      mz += s.rz * sn + s.lz * cs;
    }
    const k = CLOUD_FOLLOW / strands.length;
    this.tufts.push({
      x: h.x, y: h.y, z: h.z,
      cloudX: h.x + mx * k, cloudY: h.y + CLOUD_LIFT, cloudZ: h.z + mz * k,
      start: this.strandCount, count: strands.length, strands, cloud,
      biting: false, biteT: 0,
    });
    this.strandCount += strands.length;
  }

  build(U, shading, wake, current) {
    const geo = makeStrandGeometry();
    const A = new Float32Array(STRAND_POOL * 4), B = new Float32Array(STRAND_POOL * 4);
    const C = new Float32Array(STRAND_POOL * 4), D = new Float32Array(STRAND_POOL * 4);
    const E = new Float32Array(STRAND_POOL * 4);
    this.bendArr = new Float32Array(STRAND_POOL * 4);
    this.bend = new Float32Array(TUFT_POOL * 2);
    for (const tf of this.tufts) {
      tf.strands.forEach((s, i) => {
        const o = (tf.start + i) * 4;
        A.set([tf.x, tf.y, tf.z, s.len], o);
        B.set([s.rx, s.ry, s.rz, s.lean], o);
        C.set([s.lx, s.ly, s.lz, s.width], o);
        D.set([s.phase, s.omega, s.factor, s.curl], o);
        E.set([s.wavePhase, s.waveAmp, s.alpha, s.waveF], o);
      });
    }
    this.aBend = new THREE.InstancedBufferAttribute(this.bendArr, 4);
    this.aBend.setUsage(THREE.DynamicDrawUsage);
    // Strand length is the one static field grazing rewrites, so it carries the dynamic hint too.
    this.tuftA = A;
    this.aTuftA = new THREE.InstancedBufferAttribute(A, 4);
    this.aTuftA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTuftA', this.aTuftA);
    geo.setAttribute('aTuftB', new THREE.InstancedBufferAttribute(B, 4));
    geo.setAttribute('aTuftC', new THREE.InstancedBufferAttribute(C, 4));
    geo.setAttribute('aTuftD', new THREE.InstancedBufferAttribute(D, 4));
    geo.setAttribute('aTuftE', new THREE.InstancedBufferAttribute(E, 4));
    geo.setAttribute('aBend', this.aBend);
    geo.instanceCount = this.strandCount;

    // Uniforms, never bare literals: an all-literal WGSL expression is abstract and Naga rejects the
    // module the moment one reaches runtime math. Cooler and darker than pads or duckweed.
    const uTuftBase = uniform(new THREE.Vector3(0.08, 0.28, 0.14));
    const uTuftTip = uniform(new THREE.Vector3(0.20, 0.46, 0.24));
    const uTuftLift = uniform(0.18);                 // the floor's moon is 0.15; a thread this thin vanishes at that level
    const uTuftLightGain = uniform(1.6);
    const uTuftRough = uniform(0.45);
    const uTuftFadeBand = uniform(new THREE.Vector2(0.65, 1.0));
    const uTuftFadeEnd = uniform(0.15);              // what is left of a strand at its tip
    const uTuftAlpha = uniform(1.0);                 // master scale on the per-strand 0.35–0.8
    const uTuftEdge = uniform(1.0);                  // exponent on the across-ribbon falloff
    const uTuftNormalUp = uniform(0.35);
    const uTuftWidth = uniform(1.0), uTuftTipW = uniform(W_TIP), uTuftTaper = uniform(0.7);
    const uTuftSway = uniform(0.12), uTuftOsc = uniform(0.03);
    const uTuftWakeK = uniform(2.4), uTuftWakeGain = uniform(0.35);
    const uTuftCurl = uniform(1.0), uTuftBendMax = uniform(1.3);
    const uTuftMeander = uniform(MEANDER_GAIN), uTuftMeanderK = uniform(2 * Math.PI * 1.7);
    const uTuftCeil = uniform(-0.02);                // hard backstop: no strand ever crosses the waterline

    const vTuftP = varying(vec3(0), 'vTuftP');
    const vTuftN = varying(vec3(0), 'vTuftN');
    const vTuftV = varying(float(0), 'vTuftV');
    const vTuftSide = varying(float(0), 'vTuftSide');
    const vTuftAlpha = varying(float(0), 'vTuftAlpha');

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const tA = attribute('aTuftA', 'vec4'), tB = attribute('aTuftB', 'vec4');
      const tC = attribute('aTuftC', 'vec4'), tD = attribute('aTuftD', 'vec4');
      const tE = attribute('aTuftE', 'vec4');
      const bend = attribute('aBend', 'vec4');
      const ribAttr = attribute('aRib', 'vec2');
      const v = ribAttr.x, side = ribAttr.y;
      const base = tA.xyz, len = tA.w, rise = tB.xyz, latRest = tC.xyz;
      const baseXZ = vec2(tA.x, tA.z);

      // Idle drive: the local current lays the tuft downstream, with a slow per-strand wobble on top.
      const cur = current(baseXZ, U.time);
      const curMag = length(cur);
      const sway = cur.div(curMag.max(1e-5)).mul(curMag.mul(uTuftSway).add(sin(U.time.mul(tD.y).add(tD.x)).mul(uTuftOsc)));
      const wk = wake.wakeAt(baseXZ, uTuftWakeK).mul(uTuftWakeGain);
      const drive = sway.mul(U.motionScale).add(bend.xy.mul(bend.z).mul(tD.z)).add(wk);
      const driveV = vec3(drive.x, 0, drive.y);
      // Everything the strand leans by lives in the plane perpendicular to its rise axis.
      const latVec = latRest.mul(tB.w).add(driveV.sub(rise.mul(dot(rise, driveV))));
      const raw = length(latVec);
      const amount = raw.min(uTuftBendMax).max(1e-3);
      const latDir = latVec.div(raw.max(1e-4));
      // Circular arc: exact arc length, so a body laying a strand over never stretches it.
      const th = amount.mul(v);
      const R = len.div(amount);
      const p = base.add(rise.mul(R.mul(sin(th)))).add(latDir.mul(R.mul(cos(th).oneMinus()))).toVar();
      const tangent = rise.mul(cos(th)).add(latDir.mul(sin(th)));
      // Ribbon plane from the resting frame, not the live one: rise and latRest are orthonormal by
      // construction, so this cross is unit without a normalize and the ribbon cannot twist or flicker.
      const wide = cross(rise, latRest);
      // One clean bow plus a faster seeded wobble, so a thread meanders instead of sweeping an arc.
      const wobble = sin(v.mul(PI)).mul(tD.w).mul(uTuftCurl)
        .add(sin(v.mul(uTuftMeanderK).mul(tE.w).add(tE.x)).mul(tE.y).mul(uTuftMeander));
      p.addAssign(wide.mul(wobble.mul(len)));
      const halfW = mix(tC.w, uTuftTipW, pow(v.max(0), uTuftTaper)).mul(0.5).mul(uTuftWidth);
      const rib = p.add(wide.mul(side).mul(halfW));
      const world = vec3(rib.x, rib.y.min(uTuftCeil), rib.z);
      const face = cross(wide, tangent);
      vTuftN.assign(normalize(mix(face.div(length(face).max(1e-4)), vec3(0, 1, 0), uTuftNormalUp)));
      vTuftP.assign(world);
      vTuftV.assign(v);
      vTuftSide.assign(side);
      vTuftAlpha.assign(tE.z);
      return world;
    })();

    mat.fragmentNode = Fn(() => {
      const n = normalize(vTuftN);
      const nn = select(frontFacing, n, n.negate());
      // Unit albedo, so shade() returns the incident light itself: moon through the caustics plus any
      // eel neon passing. That is also where the glow arrives, so there is no separate glow path.
      const light = shading.shade(vec3(1), nn, vTuftP, uTuftRough).mul(uTuftLightGain);
      const col = mix(uTuftBase, uTuftTip, vTuftV).mul(light.add(uTuftLift));
      const fade = mix(float(1), uTuftFadeEnd, smoothstep(uTuftFadeBand.x, uTuftFadeBand.y, vTuftV));
      // Hard-edged, a three-pixel ribbon reads as a stripe; falling off across it reads as a thread.
      const edge = pow(vTuftSide.mul(vTuftSide).oneMinus().max(0), uTuftEdge);
      const opacity = vTuftAlpha.mul(uTuftAlpha).mul(edge).mul(fade);
      return vec4(col.mul(opacity), 0);
    })();
    setAdditive(mat);

    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.knobs = {
      base: uTuftBase, tip: uTuftTip, lift: uTuftLift, lightGain: uTuftLightGain,
      rough: uTuftRough, fadeBand: uTuftFadeBand, fadeEnd: uTuftFadeEnd,
      strandAlpha: uTuftAlpha, edge: uTuftEdge, normalUp: uTuftNormalUp,
      width: uTuftWidth, tipW: uTuftTipW, taper: uTuftTaper, sway: uTuftSway, osc: uTuftOsc,
      wakeK: uTuftWakeK, wakeGain: uTuftWakeGain, curl: uTuftCurl, meander: uTuftMeander,
      meanderK: uTuftMeanderK, bendMax: uTuftBendMax, ceil: uTuftCeil,
    };
  }

  /* The haze: one quad per tuft, drifting and breathing under the same current and the same CPU bend,
     so an eel that lays the threads over drags the cloud with them. */
  buildCloud(U, shading, current) {
    const geo = makeCloudGeometry();
    const A = new Float32Array(TUFT_POOL * 4), B = new Float32Array(TUFT_POOL * 4);
    this.cloudBendArr = new Float32Array(TUFT_POOL * 4);
    this.tufts.forEach((tf, i) => {
      const c = tf.cloud, o = i * 4;
      A.set([tf.cloudX, tf.cloudY, tf.cloudZ, c.r], o);
      B.set([c.phase, c.rate, c.nx, c.nz], o);
    });
    this.aCloudBend = new THREE.InstancedBufferAttribute(this.cloudBendArr, 4);
    this.aCloudBend.setUsage(THREE.DynamicDrawUsage);
    this.cloudA = A;
    this.aCloudA = new THREE.InstancedBufferAttribute(A, 4);
    this.aCloudA.setUsage(THREE.DynamicDrawUsage);   // w is the haze radius, which fades with a bitten tuft
    geo.setAttribute('aCloudA', this.aCloudA);
    geo.setAttribute('aCloudB', new THREE.InstancedBufferAttribute(B, 4));
    geo.setAttribute('aCloudBend', this.aCloudBend);
    geo.instanceCount = this.tufts.length;

    // Yellower than the strands, so the haze and the threads separate the way they do in the reference.
    const uCloudCol = uniform(new THREE.Vector3(0.16, 0.42, 0.26));
    const uCloudOpacity = uniform(0.18);
    const uCloudRadius = uniform(1.0);
    const uCloudFall = uniform(1.6);
    const uCloudNoiseScale = uniform(1.4), uCloudNoiseAmt = uniform(0.6), uCloudNoiseDrift = uniform(0.02);
    const uCloudDrift = uniform(0.15), uCloudBreathe = uniform(0.18), uCloudLean = uniform(0.25);
    const uCloudRough = uniform(0.6);
    const uCeil = this.knobs.ceil, uLightGain = this.knobs.lightGain;

    const vHazeQ = varying(vec2(0), 'vHazeQ');
    const vHazeP = varying(vec3(0), 'vHazeP');
    const vHazeN = varying(vec2(0), 'vHazeN');

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const cA = attribute('aCloudA', 'vec4'), cB = attribute('aCloudB', 'vec4');
      const bd = attribute('aCloudBend', 'vec4');
      const drift = current(vec2(cA.x, cA.z), U.time).mul(uCloudDrift).mul(U.motionScale);
      const lean = bd.xy.mul(bd.z).mul(uCloudLean);
      const breathe = sin(U.time.mul(cB.y).add(cB.x)).mul(uCloudBreathe).mul(U.motionScale).add(1);
      const rad = cA.w.mul(uCloudRadius).mul(breathe);
      const q = vec2(positionGeometry.x, positionGeometry.z);
      const center = vec3(cA.x.add(drift.x).add(lean.x), cA.y.min(uCeil), cA.z.add(drift.y).add(lean.y));
      vHazeQ.assign(q);
      vHazeP.assign(center);
      vHazeN.assign(cB.zw);
      return center.add(vec3(q.x.mul(rad), 0, q.y.mul(rad)));
    })();

    mat.fragmentNode = Fn(() => {
      const r2 = dot(vHazeQ, vHazeQ);
      const fall = pow(r2.oneMinus().max(0), uCloudFall);
      const nz = valueNoise2(vHazeQ.mul(uCloudNoiseScale).add(vHazeN).add(vec2(U.time.mul(uCloudNoiseDrift), 0)));
      // Mixed toward 1 rather than multiplied raw, or the breakup would halve the haze's mean brightness.
      const breakup = mix(uCloudNoiseAmt.oneMinus(), float(1), nz);
      const light = shading.shade(vec3(1), vec3(0, 1, 0), vHazeP, uCloudRough).mul(uLightGain);
      return vec4(uCloudCol.mul(light).mul(fall.mul(breakup).mul(uCloudOpacity)), 0);
    })();
    setAdditive(mat);

    this.cloudMaterial = mat;
    this.cloudMesh = new THREE.Mesh(geo, mat);
    this.cloudMesh.frustumCulled = false;
    this.cloudMesh.renderOrder = 4;
    Object.assign(this.knobs, {
      cloudCol: uCloudCol, cloudOpacity: uCloudOpacity, cloudRadius: uCloudRadius, cloudFall: uCloudFall,
      cloudNoiseScale: uCloudNoiseScale, cloudNoiseAmt: uCloudNoiseAmt, cloudNoiseDrift: uCloudNoiseDrift,
      cloudDrift: uCloudDrift, cloudBreathe: uCloudBreathe, cloudLean: uCloudLean, cloudRough: uCloudRough,
    });
  }

  /* Asymmetric one-pole per tuft: quick to lay over, slow to rise. A stateless GPU read of the wake
     would spring back on the wake's own 1.2 s, which reads as a reed, not as water-damped algae. */
  /* A tuft the quality ladder has hidden, or one already torn off, is not on anybody's menu. */
  canBite(i) {
    const tf = this.tufts[i];
    if (!tf || tf.biting) return false;
    return tf.start + tf.count <= this.mesh.geometry.instanceCount && i < this.cloudMesh.geometry.instanceCount;
  }

  /* Torn off the stone: the strands fall to a stubble over BITE_FALL and creep back over one orbit.
     The width attribute is untouched, so what is left is the holdfast nub a grazer actually leaves. */
  biteTuft(i) {
    if (!this.canBite(i)) return false;
    const tf = this.tufts[i];
    tf.biting = true;
    tf.biteT = 0;
    this.bitten++;
    return true;
  }

  stepBites(dt) {
    if (!this.bitten) return;
    this.biteAcc += dt;
    let falling = false;
    for (const tf of this.tufts) if (tf.biting && tf.biteT < BITE_FALL) { falling = true; break; }
    if (!falling && this.biteAcc < BITE_UPLOAD) return;
    // Advance by everything the throttle swallowed, or a regrow would run at a fraction of real time.
    const el = this.biteAcc;
    this.biteAcc = 0;
    for (let i = 0; i < this.tufts.length; i++) {
      const tf = this.tufts[i];
      if (!tf.biting) continue;
      tf.biteT += el;
      let gone = tf.biteT < BITE_FALL ? Math.min(1, tf.biteT / BITE_FALL) : 1 - (tf.biteT - BITE_FALL) / BITE_REGROW;
      if (gone <= 0) { gone = 0; tf.biting = false; this.bitten--; }
      const keep = 1 - gone;
      for (let j = 0; j < tf.count; j++) this.tuftA[(tf.start + j) * 4 + 3] = tf.strands[j].len * keep;
      this.cloudA[i * 4 + 3] = tf.cloud.r * keep;
    }
    this.aTuftA.needsUpdate = true;
    this.aCloudA.needsUpdate = true;
  }

  update(dt) {
    if (!this.tufts.length) return;
    // A NaN dt would poison the lag state for the rest of the session; the comparison rejects it.
    const step = dt > 0 ? Math.min(dt, DT_MAX) : 0;
    this.stepBites(step);
    const U = this.U, out = this.pushTmp;
    const gain = BEND_GAIN * (this.motion && this.motion.reduced ? REDUCED_BEND : 1);
    for (let i = 0; i < this.tufts.length; i++) {
      const tf = this.tufts[i];
      let px = 0, pz = 0;
      for (let s = 0; s < INF_SLOTS; s++) {
        // Sampled at the mass, not the holdfast: a tuft leaning a body-length downstream would
        // otherwise ignore an eel swimming straight through the part of it you can see.
        if (!capsuleInfluenceCPU(U, tf.cloudX, tf.y, tf.cloudZ, s, out)) continue;
        const a = U.infA.array[s], b = U.infB.array[s];
        // A body's shove scales with its girth, exactly as the petiole bump does.
        const k = b.w * (a.w / (a.w + MASS_SOFT));
        px += out.x * k; pz += out.z * k;
      }
      px *= gain; pz *= gain;
      const o = i * 2;
      const cur = Math.hypot(this.bend[o], this.bend[o + 1]);
      const k = 1 - Math.exp(-step / (Math.hypot(px, pz) > cur ? ATTACK_TAU : RECOVER_TAU));
      this.bend[o] += (px - this.bend[o]) * k;
      this.bend[o + 1] += (pz - this.bend[o + 1]) * k;
      const bx = this.bend[o], bz = this.bend[o + 1];
      const m = Math.hypot(bx, bz), inv = m > 1e-5 ? 1 / m : 0;
      for (let j = 0; j < tf.count; j++) {
        const w = (tf.start + j) * 4;
        this.bendArr[w] = bx * inv; this.bendArr[w + 1] = bz * inv; this.bendArr[w + 2] = m;
      }
      const c = i * 4;
      this.cloudBendArr[c] = bx * inv; this.cloudBendArr[c + 1] = bz * inv; this.cloudBendArr[c + 2] = m;
    }
    this.aBend.needsUpdate = true;
    this.aCloudBend.needsUpdate = true;
  }

  /* Decorative, so the pool tail is what gets cut. The strand buffer is tuft-major, so a prefix is
     whole tufts, and the same prefix indexes the haze. */
  setQuality({ tuftFraction = 1 } = {}) {
    const k = Math.max(0, Math.min(this.tufts.length, Math.round(this.tufts.length * tuftFraction)));
    const tf = this.tufts[k];
    this.mesh.geometry.instanceCount = tf ? tf.start : this.strandCount;
    this.cloudMesh.geometry.instanceCount = k;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.cloudMesh.removeFromParent();
    this.cloudMesh.geometry.dispose();
    this.cloudMaterial.dispose();
  }
}
