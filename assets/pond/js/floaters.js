import * as THREE from 'three/webgpu';
import { Fn, If, attribute, uniform, uniformArray, varying, vec2, vec3, vec4, float, int, sin, cos, length, smoothstep, mix, pow, step, dot, normalize, texture, uv, fwidth, positionGeometry } from 'three/tsl';
import { WAKE_RES, MOON_ORBIT_SECONDS, INF_SLOTS } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { segDist } from './eel-physics.js';
import { makeCurrent, makeSwell, valueNoise2, capsuleInfluenceCPU } from './shading.js';

/* The surface-particle system: one config per layer, one InstancedBufferGeometry each. Phase 2 so far:
   duckweed specks (CPU particle sim) + the mat decal that carries the frond texture. */

/* Pollen (salt 1500, pool 4,000, last 200 slots for lily puffs) and floating leaves (salt 1600, 60)
   drop in as further entries; nothing else here assumes duckweed is the only layer. */
export const FLOATERS = {
  duckweed: { salt: 1400, pool: 8000, size: [0.035, 0.06], renderOrder: 10 },
};

export const SPECK_POOL = FLOATERS.duckweed.pool;
export const CLUMP_POOL = 16;              // 15 at a 16:9 boot; the headroom is for ultrawide
export const CLUMP_MIN_SEP = 1.2;          // far under the radii: big and small are meant to nearly touch
export const CLUMP_MARGIN = 1.2;           // clumps may straddle the frame edge and lean in
export const CLUMP_DENSITY = 0.060;        // clumps per unit² of the boot layout rect: 15 at 16:9
export const CLUMP_RADIUS = [0.5, 2.6];
export const CLUMP_SKEW = 1.6;             // u^1.6: mostly small islands with a few big ones
export const COVERAGE_CAP = 0.22;          // geometric; the noise cut below eats ~30% of it back
export const GROWTH_MAX = 1.3;
export const GROWTH_FLOOR = 0.63;          // 40% of seeded area, reserved for Phase 5 grazing
export const GROWTH_PER_CYCLE = [0.05, 0.08];
export const SPECK_DENSITY = 78;           // specks per unit² of nominal clump area; most land in the rim band

const WARP_BASE = 0.65, WARP_SPAN = 0.5;   // warp(θ) = 0.65 + 0.5 × f(θ), f in 0–1
const WARP_HARMONICS = [1, 2, 3, 5];       // integer harmonics: no ±π seam, and the CPU twin matches exactly
const WARP_AMPS = [0.42, 0.28, 0.18, 0.12];
const LEE_REACH = 1.5;                     // how far downwind of a rock or the log a clump is favored

/* Membership: the scalar the silhouette is cut on, positive where fronds float. The radial ramp is linear
   and unclamped so no noise excursion reaches the decal rim (MEM_SPAN × radius) and cuts a circle arc. */
const MEM_SPAN = 1.45, MEM_EDGE = 0.78, MEM_SLOPE = 2.2, MEM_NOISE = 3.47;
const MAT_SHRINK = 0.78;                   // the noise cut leaves about this much of the nominal radius

// The pristine field sits at 0.625 ± 0.1875, not 0.5 ± 0.25, so the bottom of the byte range is
// headroom Eleanor can carve into: from 0 the noise term beats even a clump's center density.
const NOISE_MID = 0.625, NOISE_HALF = 0.1875;
// 1024 over the pool is 0.02 units a texel: fine enough that a fingertip-wide carve is five texels
// and not a hairline the bilinear fetch would swallow.
const NOISE_RES = 1024;
// Lattice cells of 2.5 down to 0.08 units: the big octaves carve bays and spurs, the last two are
// the ragged frond-scale rim.
const NOISE_OCTAVES = [[8, 0.28], [16, 0.22], [32, 0.17], [64, 0.13], [128, 0.12], [256, 0.08]];

// Carving lives in its own world-space field, never in the noise: the noise is read in each clump's
// drifted frame, so a scar stamped there rides a wandering mat and reappears a pond-width away.
const SCAR_RES = 512;                      // 0.04 units a texel: a fingertip furrow is still four wide
const SCAR_K = MEM_NOISE;                  // scar bytes carry the units the noise subtraction used
// Deepest a furrow goes: the mat is long gone by NOISE_MID × MEM_NOISE, and anything past it only
// buys a longer heal.
const SCAR_MAX = NOISE_MID * 255;

// Trunk waterline half-widths, sampled along the axis at boot so the per-speck test stays a lookup.
const LOG_PROFILE_N = 32, LOG_BISECT = 10;

// Speck particle sim. Settle ~5 s: critically damped, ω = 5.8 / settle for a 2% tail.
const SPECK_OMEGA = 1.16;
const SPECK_DT_MAX = 1 / 20;
const SPECK_CAP = 0.6, SPECK_VMAX = 3;
// Steady-state offset is force / ω²: the wind gain is what keeps a gust from walking the whole mat
// off its own silhouette, which is the failure the sharp edge made visible.
const SPECK_EEL_GAIN = 0.25, SPECK_WIND_GAIN = 0.12;
// The specks sell the edge as living matter: densest in a band (1/e half-width SPECK_BAND) straddling
// the frond line, a long thin tail past it, and SPECK_LOOSE as a flat scatter over nearby open water.
const SPECK_BAND = 0.30, SPECK_CORE = 0.22;
const SPECK_TAIL = 0.26, SPECK_TAIL_LEN = 1.7, SPECK_LOOSE = 0.045, SPECK_REACH = 3.4;
const POKE_INNER = 0.06, POKE_OUTER = 0.18, POKE_GAIN = 0.18, POKE_VEL = 0.25;
const OBS_SKIN = 0.06;                     // specks pile against the waterline, never inside it
const CLUMP_DRIFT = 0.016, CLUMP_DRIFT_CUR = 0.020;   // units/s downwind, plus a nudge from the current
const CLUMP_STICK = 0.25;                  // a mat that reaches a rock or the log adheres and stops
// Eleanor is the only body wide enough to plow the mat apart; the residents only warp it. She is
// identified by capsule radius (0.24–0.28 against a resident's 0.065–0.12), never by slot index.
const CARVE_MIN_R = 0.18, CARVE_WIDE = 0.34, CARVE_DEPTH = 0.6, CARVE_RATE = 1.2;
export const CARVE_TICK = 0.25;
const CARVE_HEAL_TAU = 85;   // the furrow is ~95% closed in a little under four minutes
// A finger slices the same field she does, thinner and to a fixed depth: passing twice cannot dig
// deeper than parted, where dwelling in her path can. A grazer eats on the same terms.
export const FINGER_CARVE_R = 0.085, FINGER_CARVE = 0.46;
const POKE_MAX = 16;                       // sub-frame pointer samples honored per frame

function smoothstep01(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / ((e1 - e0) || 1e-9)));
  return t * t * (3 - 2 * t);
}

/* The clump silhouette, evaluated identically on both processors: the decal draws it, the speck
   seeding lands inside it, and habitat.duckweedAt answers cover queries with it. */
function warpFactor(theta, ph) {
  let s = 0;
  for (let k = 0; k < 4; k++) s += WARP_AMPS[k] * Math.sin(theta * WARP_HARMONICS[k] + ph[k]);
  return WARP_BASE + WARP_SPAN * (s * 0.5 + 0.5);
}

function warpMoments(ph) {
  let sum = 0, sumSq = 0;
  const N = 64;
  for (let i = 0; i < N; i++) {
    const w = warpFactor((i / N) * Math.PI * 2, ph);
    sum += w; sumSq += w * w;
  }
  return { mean: sum / N, meanSq: sumSq / N };
}

/* The shared distribution noise. A JS twin of TSL's valueNoise2 would never match bit for bit, so one
   quantized array is the contract: the shader samples the texture, the CPU reads the same bytes. */
function buildNoiseField(seed, extent) {
  const rng = createRng(deriveSeed(seed, 1301));
  const N = NOISE_RES;
  const f = new Float32Array(N * N);
  for (const [L, amp] of NOISE_OCTAVES) {
    const g = new Float32Array(L * L);
    for (let i = 0; i < g.length; i++) g[i] = rng.next();
    const s = L / N;
    for (let y = 0; y < N; y++) {
      const fy = y * s, y0 = Math.floor(fy), ty = fy - y0;
      const wy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % L) * L, r1 = ((y0 + 1) % L) * L;
      for (let x = 0; x < N; x++) {
        const fx = x * s, x0 = Math.floor(fx), tx = fx - x0;
        const wx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % L, c1 = (x0 + 1) % L;
        const lo = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * wx;
        const hi = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * wx;
        f[y * N + x] += amp * (lo + (hi - lo) * wy);
      }
    }
  }
  // Stretched to ±2σ, not min to max: a sum of octaves clusters hard around its mean, and min/max
  // normalization would leave the field almost flat over any one clump.
  let sum = 0, sumSq = 0;
  for (let i = 0; i < f.length; i++) { sum += f[i]; sumSq += f[i] * f[i]; }
  const mean = sum / f.length;
  const k = NOISE_HALF / Math.max(1e-6, 2 * Math.sqrt(Math.max(0, sumSq / f.length - mean * mean)));
  const bytes = new Uint8Array(N * N);
  for (let i = 0; i < f.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round((NOISE_MID + (f[i] - mean) * k) * 255)));
  const tex = new THREE.DataTexture(bytes, N, N, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { bytes, tex, res: N, extent };
}

/* The scar layer: what has been plowed, in world coordinates, zero everywhere until something carves.
   work carries the sub-byte relaxation the heal runs on. */
function buildScarField(extent) {
  const N = SCAR_RES;
  const bytes = new Uint8Array(N * N);
  const tex = new THREE.DataTexture(bytes, N, N, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { bytes, work: new Float32Array(N * N), tex, res: N, extent };
}

/* Unit disc, 6 rings × 32 segments = 193 vertices. aRR is the radial fraction the membership is cut
   on; aTh is the angle the warp is evaluated at, so the decal's silhouette is the clump's. */
function makeDecalGeometry() {
  const RINGS = 6, SEG = 32;
  const geo = new THREE.InstancedBufferGeometry();
  const count = 1 + RINGS * SEG;
  const aRR = new Float32Array(count), aTh = new Float32Array(count);
  let k = 1;
  for (let r = 1; r <= RINGS; r++) {
    for (let s = 0; s < SEG; s++) { aRR[k] = r / RINGS; aTh[k] = (s / SEG) * Math.PI * 2; k++; }
  }
  const idx = [];
  const at = (r, s) => 1 + (r - 1) * SEG + (s % SEG);
  for (let s = 0; s < SEG; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < RINGS; r++) {
    for (let s = 0; s < SEG; s++) {
      idx.push(at(r, s), at(r + 1, s + 1), at(r + 1, s));
      idx.push(at(r, s), at(r, s + 1), at(r + 1, s + 1));
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  // Same as the pad fan: the texture nodes' default uv resolves at build, and WebGL2 warns without one.
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  geo.setAttribute('aRR', new THREE.Float32BufferAttribute(aRR, 1));
  geo.setAttribute('aTh', new THREE.Float32BufferAttribute(aTh, 1));
  geo.setIndex(idx);
  return geo;
}

/* One card per speck, lying in xz to face the straight-down camera, exactly as effects.js does. */
function makeCardGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

export class FloaterSystem {
  constructor({ overScene, U, sim, wake, shading, seed, view, colliders, habitat, carpet, rain, motion }) {
    this.U = U;
    this.sim = sim;
    this.wake = wake;
    this.shading = shading;
    this.habitat = habitat;
    this.motion = motion;
    this.rain = rain;
    this.clumps = [];
    this.speckCount = 0;
    this.growthCap = GROWTH_MAX;
    this.lastCycle = 0;
    this.windCalm = 1;   // eased 0.7 while a shower loosens the packing
    this.noise = buildNoiseField(seed, sim.extent);
    this.scar = buildScarField(sim.extent);
    this.pokeSegs = new Float32Array(POKE_MAX * 4);
    this.poke0 = { n: 0, vx: 0, vz: 0, x0: 0, x1: 0, z0: 0, z1: 0 };
    this.forceOut = { x: 0, z: 0 };
    this.driftOut = { x: 0, z: 0 };
    this.slotBox = new Float32Array(INF_SLOTS * 5);
    this.memClump = null;
    this.carveAcc = 0;
    this.carveBox = null;   // scar-texel AABB of everything plowed and not yet healed
    this.rect = { ex: view.w / 2 + CLUMP_MARGIN, ez: view.h / 2 + CLUMP_MARGIN };
    this.flattenColliders(colliders);

    this.layout(seed, view, colliders, rain.wind, sim.extent, habitat);
    // addClump stores a copy, so the registry's objects become ours: growth and drift then have one
    // home that the decal, the specks, and every cover query read.
    this.clumps = this.clumps.map((c) => habitat.addClump(c));
    this.buildShared(U, sim);
    this.buildCarpet(U, carpet);
    this.buildSpecks(U);
    overScene.add(this.carpetMesh, this.speckMesh);

    // The one silhouette test, so a cover query can never disagree with what is drawn.
    habitat.setDuckweedField((x, z) => this.matAt(x, z));
    // Half cover: a mat shades the sand and hides a strider, but not the way a pad does.
    habitat.addCoverSource((discs) => {
      for (const c of this.clumps) {
        discs.push({ x: c.x + c.dx, z: c.z + c.dz, r: c.r * c.growth * c.warpMean * MAT_SHRINK, strength: 0.4 * c.growth });
      }
    });
    if (U.coverStrength.value <= 0) U.coverStrength.value = 0.85;
  }

  flattenColliders(colliders) {
    const d = colliders.waterline.discs, c = colliders.waterline.capsules;
    this.obsDisc = new Float32Array(d.length * 3);
    d.forEach((o, i) => this.obsDisc.set([o.x, o.z, o.r], i * 3));
    this.obsCap = new Float32Array(c.length * 5);
    c.forEach((o, i) => this.obsCap.set([o.ax, o.az, o.bx, o.bz, o.r], i * 5));
    // A trunk is not a pill: its ends are open mouths and its flanks are shaped bark, so the capsule's
    // crest-plus-bend radius is only the fallback the branch stubs (no bark sampler) still want.
    const trunks = (colliders.logs || []).filter((l) => typeof l.bark === 'function');
    this.obsProfile = c.map((o) => {
      // The mask capsule is inset from the mouths by its own radius, so match on the axis, not the ends.
      const l = trunks.find((t) => segDist(o.ax, o.az, t.a.x, t.a.z, t.b.x, t.b.z) < 1e-3 && segDist(o.bx, o.bz, t.a.x, t.a.z, t.b.x, t.b.z) < 1e-3);
      return l ? this.buildLogProfile(l) : null;
    });
  }

  /* Half-widths of the chord where a trunk's bark crosses y = 0, per station and per flank, in the axis
     frame. The two sides differ: bark is lumpy and the trunk bends. */
  buildLogProfile(l) {
    const ax = l.a.x, az = l.a.z;
    const len = Math.hypot(l.b.x - ax, l.b.z - az) || 1e-6;
    const ux = (l.b.x - ax) / len, uz = (l.b.z - az) / len;
    const w = new Float32Array((LOG_PROFILE_N + 1) * 2);
    for (let i = 0; i <= LOG_PROFILE_N; i++) {
      const t = i / LOG_PROFILE_N;
      const p = this.barkWaterlinePerp(l, t, 1, ax, az, ux, uz);
      const m = this.barkWaterlinePerp(l, t, -1, ax, az, ux, uz);
      const wp = p >= 0 ? p : (m >= 0 ? m : 0), wn = m < 0 ? -m : (p < 0 ? -p : 0);
      // Filed by the sign the bark lands on, and a flank whose sample crossed over borrows its twin:
      // better a symmetric trunk than one side of it reading as zero-width water.
      w[i * 2] = wp || wn;
      w[i * 2 + 1] = wn || wp;
    }
    return { ax, az, ux, uz, len, w };
  }

  /* Signed offset from the axis of the point where one flank meets the water, the same bracket algae.js
     solves on: bark height falls monotonically from the ridge (ang 0) to the belly (ang ±PI). */
  barkWaterlinePerp(l, t, sgn, ax, az, ux, uz) {
    const perpOf = (ang) => { const p = l.bark(t, ang * sgn); return (p.x - ax) * -uz + (p.z - az) * ux; };
    if (l.bark(t, 0).y <= 0) return 0;                                   // ridge drowned: nothing dry here
    if (l.bark(t, Math.PI * sgn).y >= 0) return perpOf(Math.PI / 2);     // belly dry: the widest chord
    let lo = 0, hi = Math.PI;
    for (let i = 0; i < LOG_BISECT; i++) {
      const mid = (lo + hi) * 0.5;
      if (l.bark(t, mid * sgn).y > 0) lo = mid; else hi = mid;
    }
    return perpOf((lo + hi) * 0.5);
  }

  logHalfWidth(pr, t, side) {
    const f = t * LOG_PROFILE_N;
    let i0 = Math.floor(f);
    if (i0 < 0) i0 = 0; else if (i0 > LOG_PROFILE_N - 1) i0 = LOG_PROFILE_N - 1;
    const o = i0 * 2 + side;
    return pr.w[o] + (pr.w[o + 2] - pr.w[o]) * (f - i0);
  }

  insideObstacle(x, z, margin = 0) {
    const d = this.obsDisc;
    for (let i = 0; i < d.length; i += 3) {
      const dx = x - d[i], dz = z - d[i + 1], r = d[i + 2] + margin;
      if (dx * dx + dz * dz < r * r) return true;
    }
    const c = this.obsCap;
    for (let i = 0, k = 0; i < c.length; i += 5, k++) {
      const pr = this.obsProfile[k];
      if (!pr) {
        if (segDist(x, z, c[i], c[i + 1], c[i + 2], c[i + 3]) < c[i + 4] + margin) return true;
        continue;
      }
      const rx = x - pr.ax, rz = z - pr.az;
      const s = rx * pr.ux + rz * pr.uz;
      if (s < 0 || s > pr.len) continue;   // both mouths are open annuli, so nothing juts past an end
      const perp = rx * -pr.uz + rz * pr.ux;
      if (Math.abs(perp) < this.logHalfWidth(pr, s / pr.len, perp >= 0 ? 0 : 1) + margin) return true;
    }
    return false;
  }

  /* Bilinear over a field's quantized bytes, matching the sampler the shader uses on the same texture. */
  fieldAt(f, x, z) {
    const N = f.res, b = f.bytes;
    let fx = (x / f.extent + 0.5) * N - 0.5;
    let fz = (z / f.extent + 0.5) * N - 0.5;
    fx = fx < 0 ? 0 : fx > N - 1 ? N - 1 : fx;
    fz = fz < 0 ? 0 : fz > N - 1 ? N - 1 : fz;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(N - 1, x0 + 1), z1 = Math.min(N - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const r0 = z0 * N, r1 = z1 * N;
    const lo = b[r0 + x0] + (b[r0 + x1] - b[r0 + x0]) * tx;
    const hi = b[r1 + x0] + (b[r1 + x1] - b[r1 + x0]) * tx;
    return (lo + (hi - lo) * tz) / 255;
  }

  noiseAt(x, z) { return this.fieldAt(this.noise, x, z); }
  scarAt(x, z) { return this.fieldAt(this.scar, x, z); }

  /* CPU twin of the mat's alpha test, positive inside the fronds; noise is read in the clump's own frame so a
     drifting mat carries its shape. Side effects: this.memClump (the winning clump) and this.memBand. */
  memAt(x, z) {
    let best = -99;
    this.memClump = null;
    this.memBand = 1;
    // One lookup for every clump in reach: a scar belongs to the pond, not to whichever mat drifts over it.
    const scar = this.scarAt(x, z) * SCAR_K;
    for (const c of this.clumps) {
      const lx = x - c.dx, lz = z - c.dz;
      const dx = lx - c.x, dz = lz - c.z;
      const reach = c.r * c.growth * (WARP_BASE + WARP_SPAN) * MEM_SPAN;
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach) continue;
      const rn = Math.sqrt(d2) / (c.r * c.growth * warpFactor(Math.atan2(dz, dx), c.phases));
      const m = (MEM_EDGE - rn) * MEM_SLOPE + (this.noiseAt(lx, lz) - NOISE_MID) * MEM_NOISE - scar;
      if (m > best) { best = m; this.memClump = c; this.memBand = SPECK_BAND * MEM_SLOPE / Math.max(0.3, c.r * c.warpMean); }
    }
    return best;
  }

  matAt(x, z) { return this.memAt(x, z) > 0 ? this.memClump : null; }

  /* Clumps by Poisson disc over the boot view rect plus a margin, biased into the lee of the rocks
     and the log; then specks rejection-sampled into a band across the frond line. Salt 1300 and 1400. */
  layout(seed, view, colliders, wind, extent, habitat) {
    const rng = createRng(deriveSeed(seed, 1300));
    const ex = this.rect.ex, ez = this.rect.ez;
    const target = Math.max(1, Math.min(CLUMP_POOL, Math.round(CLUMP_DENSITY * 4 * ex * ez)));
    // A candidate sheltered downwind of an obstacle counts double, so mats pile in the lee.
    const inLee = (x, z) => {
      for (const o of colliders.waterline.discs) {
        const dx = x - o.x, dz = z - o.z, d = Math.hypot(dx, dz);
        if (d - o.r <= LEE_REACH && d > 1e-4 && (dx * wind.x + dz * wind.z) / d > 0.3) return true;
      }
      const cA = this.obsCap;
      for (let i = 0, k = 0; i < cA.length; i += 5, k++) {
        const pr = this.obsProfile[k];
        const lax = cA[i], laz = cA[i + 1], ex = cA[i + 2] - lax, ez = cA[i + 3] - laz;
        const t = Math.max(0, Math.min(1, ((x - lax) * ex + (z - laz) * ez) / (ex * ex + ez * ez || 1e-9)));
        const dx = x - (lax + ex * t), dz = z - (laz + ez * t), m = Math.hypot(dx, dz);
        // A trunk shelters behind its own bark, not behind the capsule's worst-case envelope. The profile
        // runs the whole trunk while the mask capsule is inset, so its station comes from the trunk axis.
        const tp = pr ? Math.max(0, Math.min(1, ((x - pr.ax) * pr.ux + (z - pr.az) * pr.uz) / pr.len)) : 0;
        const r = pr ? this.logHalfWidth(pr, tp, (dx * -pr.uz + dz * pr.ux) >= 0 ? 0 : 1) : cA[i + 4];
        if (m - r > LEE_REACH) continue;
        if (m > 1e-4 && (dx * wind.x + dz * wind.z) / m > 0.3) return true;
      }
      return false;
    };
    for (let n = 0; n < target; n++) {
      for (let tries = 0; tries < 40; tries++) {
        const x = rng.range(-ex, ex), z = rng.range(-ez, ez);
        if (this.clumps.some((c) => Math.hypot(x - c.x, z - c.z) < CLUMP_MIN_SEP)) continue;
        if (!inLee(x, z) && rng.next() < 0.5) continue;
        const phases = [rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2)];
        const m = warpMoments(phases);
        this.clumps.push({
          x, z, dx: 0, dz: 0, growth: 1,
          r: CLUMP_RADIUS[0] + (CLUMP_RADIUS[1] - CLUMP_RADIUS[0]) * Math.pow(rng.next(), CLUMP_SKEW),
          phases, warpMean: m.mean, warpMeanSq: m.meanSq,
          rate: rng.range(GROWTH_PER_CYCLE[0], GROWTH_PER_CYCLE[1]),
          // Own speed and a few degrees off the wind: a field that drifts rigidly never merges.
          driftK: rng.range(0.55, 1.45), driftAng: rng.range(-0.45, 0.45),
          warp: (theta) => warpFactor(theta, phases),
        });
        break;
      }
    }
    // Coverage cap over the fixed pool extent: shrink every radius by the same factor until a roll
    // complies, then let growth run up to whatever headroom the same rule leaves.
    const capArea = COVERAGE_CAP * extent * extent;
    const areaOf = () => this.clumps.reduce((a, c) => a + Math.PI * c.r * c.r * c.warpMeanSq, 0);
    let base = areaOf();
    if (base > capArea) {
      const k = Math.sqrt(capArea / base);
      for (const c of this.clumps) c.r *= k;
      base = areaOf();
    }
    this.growthCap = Math.max(1, Math.min(GROWTH_MAX, Math.sqrt(capArea / Math.max(base, 1e-6))));
    this.coverage = base;

    // Specks: the acceptance weight is a Gaussian on the membership, so the pool spends itself on the
    // ragged rim band and only SPECK_CORE of it thins the interior.
    const srng = createRng(deriveSeed(seed, 1400));
    const windAngle = Math.atan2(wind.z, wind.x);
    const want = this.clumps.map((c) => SPECK_DENSITY * Math.PI * c.r * c.r * c.warpMeanSq);
    const total = want.reduce((a, b) => a + b, 0);
    const fit = total > SPECK_POOL ? SPECK_POOL / total : 1;
    const specks = [];
    this.clumps.forEach((c, ci) => {
      const n = Math.floor(want[ci] * fit);
      // Reach far enough past the frond line that the thin outer tail is a fixed world distance,
      // not a fraction of the radius: a small island gets the same drifting skirt a big one does.
      const span = MEM_SPAN + 1.1 / Math.max(0.4, c.r * c.warpMean);
      for (let i = 0; i < n; i++) {
        let x = 0, z = 0, frac = 0, loose = 0, ok = false;
        for (let attempt = 0; attempt < 12 && !ok; attempt++) {
          // Packing asymmetry: 1.6× the density downwind, 0.5× upwind, rejection-sampled on the angle.
          let theta = 0;
          for (let k = 0; k < 8; k++) {
            theta = srng.range(0, Math.PI * 2);
            if (srng.next() < (1.05 + 0.55 * Math.cos(theta - windAngle)) / 1.6) break;
          }
          // A sharp rim on the packed side, lace on the open one: the exponent pushes the radial
          // fraction outward downwind and inward upwind. 0.5 alone would be uniform by area.
          frac = Math.pow(srng.next(), 0.5 - 0.12 * Math.cos(theta - windAngle));
          const d = frac * span * c.r * warpFactor(theta, c.phases);
          x = c.x + Math.cos(theta) * d; z = c.z + Math.sin(theta) * d;
          const t = this.memAt(x, z) / this.memBand;
          const halo = Math.exp(-t * t);
          let p = SPECK_CORE + (1 - SPECK_CORE) * halo;
          if (t < 0) {
            const out = -t;
            // Outside: the halo proper, then a long thin skirt, then a flat scatter of loose bits.
            p = Math.max(halo, SPECK_TAIL * Math.exp(-out / SPECK_TAIL_LEN), out < SPECK_REACH ? SPECK_LOOSE : 0);
            loose = Math.min(1, out / SPECK_REACH);
          }
          if (srng.next() >= p) continue;
          ok = !this.insideObstacle(x, z) && !habitat.padAt(x, z, 0);
        }
        const half = srng.range(FLOATERS.duckweed.size[0], FLOATERS.duckweed.size[1]) * 0.5;
        specks.push({
          x, z, frac, clump: ci, loose: ok ? loose : 0,
          // A speck off the band, under a pad, or on a rock is never seen: kill it at init, not per frame.
          half: ok ? half : 0,
          // ~2% yellowing fronds, like the albedo's; tint > 1 is the flag the shader reads.
          tint: srng.next() < 0.02 ? 1.5 : srng.next(), rot: srng.range(0, Math.PI * 2), glint: srng.next(),
        });
      }
    });
    // Shuffled so the quality ladder can cut the tail and still thin every clump evenly.
    for (let i = specks.length - 1; i > 0; i--) {
      const j = Math.floor(srng.next() * (i + 1));
      const t = specks[i]; specks[i] = specks[j]; specks[j] = t;
    }
    this.specks = specks;
    this.speckCount = specks.length;
    this.liveAtBoot = specks.filter((s) => s.half > 0).length;
  }

  /* Uniforms and helper Fns both layers share, so the mat and the specks can never disagree. */
  buildShared(U, sim) {
    this.current = makeCurrent(U);
    this.swell = makeSwell(U);
    this.noiseTex = texture(this.noise.tex);
    this.scarTex = texture(this.scar.tex);
    this.uWeedExtent = uniform(sim.extent);
    // Both layers wander on the one current: a mat and the specks over it must never slide apart.
    this.uWeedDrift = uniform(0.14);
    this.uWeedFloat = uniform(0.006);
    this.uWeedSwellTilt = uniform(1.0);
    this.uWeedTiltMax = uniform(0.30);
    this.uWeedWarpBase = uniform(WARP_BASE);
    this.uWeedWarpSpan = uniform(WARP_SPAN);
    this.uWeedWarpHarm = uniform(new THREE.Vector4(...WARP_HARMONICS));
    this.uWeedWarpAmp = uniform(new THREE.Vector4(...WARP_AMPS));
    // One vec4 per clump: growth in x (the whole growth and grazing mechanism) and the live drift of
    // the mat's center in yz, so both shaders follow a wandering clump with no per-instance rewrite.
    this.growthArr = Array.from({ length: CLUMP_POOL }, () => new THREE.Vector4(0, 0, 0, 0));
    // Flat mirrors of the same three floats: the speck loop reads them 5,000 times a frame.
    this.growF = new Float32Array(CLUMP_POOL);
    this.driftF = new Float32Array(CLUMP_POOL * 2);
    this.clumps.forEach((c, i) => { this.growthArr[i].x = c.growth; this.growF[i] = c.growth; });
    this.uWeedGrowth = uniformArray(this.growthArr);

    this.warpAt = Fn(([theta, ph]) => {
      const h = this.uWeedWarpHarm, a = this.uWeedWarpAmp;
      const s = sin(theta.mul(h.x).add(ph.x)).mul(a.x)
        .add(sin(theta.mul(h.y).add(ph.y)).mul(a.y))
        .add(sin(theta.mul(h.z).add(ph.z)).mul(a.z))
        .add(sin(theta.mul(h.w).add(ph.w)).mul(a.w));
      return s.mul(0.5).add(0.5).mul(this.uWeedWarpSpan).add(this.uWeedWarpBase);
    });

    /* Bob and tilt for anything lying on the water: one sim tap for the ripple height at the point,
       the swell's analytic slope for the tilt. A 5 cm card cannot resolve a ripple's slope anyway. */
    this.ride = Fn(([xz]) => {
      const h = this.sim.read.sample(xz.div(this.uWeedExtent).add(0.5)).r;
      const sw = this.swell(xz, U.time);
      const g = vec2(sw.y, sw.z).mul(this.uWeedSwellTilt).toVar();
      g.assign(g.mul(this.uWeedTiltMax.div(length(g).max(1e-5)).min(1)));
      return vec3(h.add(sw.x), g.x, g.y);
    });
  }

  buildCarpet(U, carpet) {
    const geo = makeDecalGeometry();
    this.carpetArr = new Float32Array(CLUMP_POOL * 4);
    this.carpetWarp = new Float32Array(CLUMP_POOL * 4);
    this.clumps.forEach((c, i) => {
      this.carpetArr.set([c.x, c.z, c.r, i], i * 4);
      this.carpetWarp.set(c.phases, i * 4);
    });
    geo.setAttribute('aClump', new THREE.InstancedBufferAttribute(this.carpetArr, 4));
    geo.setAttribute('aWarp', new THREE.InstancedBufferAttribute(this.carpetWarp, 4));
    geo.instanceCount = this.clumps.length;

    const uCarpetTile = uniform(carpet?.tiling ?? 0.65);   // repeats per unit, from the manifest: frond size is the set's call
    const uCarpetRot = uniform(new THREE.Vector2(Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)));
    const uCarpetOffset = uniform(new THREE.Vector2(0.37, 0.61));
    const uCarpetSecondScale = uniform(1.31);
    const uCarpetDetile = uniform(1);              // rung 4 turns the second albedo tap off
    const uCarpetNoise = uniform(0.6);
    const uCarpetMixLo = uniform(0.35), uCarpetMixHi = uniform(0.65);
    const uCarpetRipple = uniform(0.55);
    const uCarpetTexel2 = this.sim.uTexel.mul(2);   // follows sim.setResolution (quality rung 6)
    const uCarpetWakeK = uniform(1.0);
    const uCarpetWakeWarp = uniform(0.07);         // an eel under the mat scrunches the fronds, never tears them
    const uCarpetWakeTilt = uniform(0.35);
    const uCarpetTearLo = uniform(0.30), uCarpetTearHi = uniform(0.60), uCarpetTearAmt = uniform(3.2);
    const uCarpetSpan = uniform(MEM_SPAN), uCarpetMemEdge = uniform(MEM_EDGE);
    const uCarpetMemSlope = uniform(MEM_SLOPE), uCarpetMemNoise = uniform(MEM_NOISE);
    const uCarpetMemMid = uniform(NOISE_MID);
    const uCarpetScarK = uniform(SCAR_K);
    // Push-aside: the fronds slide off the finger's line instead of only vanishing along it.
    const uCarpetPart = uniform(0.09), uCarpetPartStep = uniform(this.sim.extent * 1.2 / WAKE_RES);
    const uCarpetPartLo = uniform(0.02), uCarpetPartHi = uniform(0.30);
    const uCarpetFrondLo = uniform(0.35), uCarpetFrondHi = uniform(0.62);
    const uCarpetBump = uniform(carpet?.bump ?? 0.9);
    const uCarpetGain = uniform(1.0);
    const uCarpetAO = uniform(0.6);
    const uCarpetTransTint = uniform(new THREE.Vector3(0.30, 1.0, 0.48));
    const uCarpetTransGain = uniform(1.0);
    this.uCarpetDetile = uCarpetDetile;

    const tex = {
      albedo: carpet?.albedo ? texture(carpet.albedo) : null,
      normal: carpet?.normal ? texture(carpet.normal) : null,
      arm: carpet?.arm ? texture(carpet.arm) : null,
      opacity: carpet?.opacity ? texture(carpet.opacity) : null,
    };

    const vCarpetPos = varying(vec2(0), 'vCarpetPos');
    const vCarpetSrc = varying(vec2(0), 'vCarpetSrc');
    const vCarpetRR = varying(float(0), 'vCarpetRR');
    const vCarpetTilt = varying(vec2(0), 'vCarpetTilt');

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const A = attribute('aClump', 'vec4'), W = attribute('aWarp', 'vec4');
      const rr = attribute('aRR', 'float'), th = attribute('aTh', 'float');
      const g = this.uWeedGrowth.element(int(A.w.add(0.5)));
      const rEff = rr.mul(uCarpetSpan).mul(A.z).mul(g.x).mul(this.warpAt(th, W));
      const src = A.xy.add(vec2(cos(th), sin(th)).mul(rEff));
      const xz = src.add(g.yz).toVar();
      xz.addAssign(this.current(xz, U.time).mul(this.uWeedDrift).mul(U.motionScale));
      // Per-vertex ride: at 6 rings the mat undulates with the ripples crossing under it.
      const ride = this.ride(xz);
      vCarpetPos.assign(xz);
      vCarpetSrc.assign(src);
      vCarpetRR.assign(rr);
      vCarpetTilt.assign(vec2(ride.y, ride.z));
      return vec3(xz.x, ride.x.add(this.uWeedFloat), xz.y);
    })();

    mat.fragmentNode = Fn(() => {
      const p = vCarpetPos, src = vCarpetSrc, rr = vCarpetRR;
      const c = p.div(this.uWeedExtent).add(0.5);
      // The surface.js two-texel slope, reused: the mat's leaves shiver with the ripples under it,
      // which also breaks the tiling a second way for free.
      const t2 = uCarpetTexel2;
      const hL = this.sim.read.sample(c.sub(vec2(t2, 0))).r, hR = this.sim.read.sample(c.add(vec2(t2, 0))).r;
      const hD = this.sim.read.sample(c.sub(vec2(0, t2))).r, hU = this.sim.read.sample(c.add(vec2(0, t2))).r;
      const slope = vec2(hL.sub(hR), hD.sub(hU)).mul(0.5);
      const wk = this.wake.wakeAt(p, uCarpetWakeK);
      // The finger's own channel and its gradient: fronds slide down the slope away from the line, so
      // a swish shoulders the mat aside as well as parting it.
      const fa = this.wake.fingerAt(p);
      const fgx = this.wake.fingerAt(p.add(vec2(uCarpetPartStep, 0))).sub(fa);
      const fgz = this.wake.fingerAt(p.add(vec2(0, uCarpetPartStep))).sub(fa);
      const fg = vec2(fgx, fgz);
      const part = fg.div(length(fg).max(1e-4)).mul(smoothstep(uCarpetPartLo, uCarpetPartHi, fa)).mul(uCarpetPart);
      // Texture and noise both ride the clump's own frame, so a drifting mat carries its fronds.
      const base = src.add(part).add(slope.mul(uCarpetRipple).mul(U.motionScale)).add(wk.mul(uCarpetWakeWarp)).mul(uCarpetTile);
      const uvA = vec2(base.x.mul(uCarpetRot.x).sub(base.y.mul(uCarpetRot.y)), base.x.mul(uCarpetRot.y).add(base.y.mul(uCarpetRot.x)));
      const uvB = base.mul(uCarpetSecondScale).add(uCarpetOffset);
      const albA = tex.albedo ? tex.albedo.sample(uvA).rgb : vec3(0.20, 0.36, 0.16);
      const albedo = albA.toVar();
      // A set with an opacity map has real water between its fronds; the mat goes lacy for free.
      const holes = (tex.opacity ? tex.opacity.sample(uvA).r : float(1)).toVar();
      // Two rotated taps mixed on a slow noise kill the grid; the second tap is a rung-4 switch, and
      // the branch is on the uniform alone so a fragment never samples inside varying control flow.
      If(uCarpetDetile.greaterThan(0), () => {
        const w = smoothstep(uCarpetMixLo, uCarpetMixHi, valueNoise2(src.mul(uCarpetNoise)));
        const albB = tex.albedo ? tex.albedo.sample(uvB).rgb : vec3(0.20, 0.36, 0.16);
        albedo.assign(mix(albA, albB, w));
        if (tex.opacity) holes.assign(mix(holes, tex.opacity.sample(uvB).r, w));
      });
      const arm = tex.arm ? tex.arm.sample(uvA) : vec4(1, 0.7, 0, 1);
      const tn = tex.normal ? tex.normal.sample(uvA).rgb.mul(2).sub(1) : vec3(0, 0, 1);
      // GL-convention assembly, the same swizzle floor.js uses, tilted onto the water's plane and
      // leaned along the wake so a body under the mat shows as a crease rather than a hole.
      const n = normalize(vec3(
        tn.x.mul(uCarpetBump).sub(vCarpetTilt.x).sub(wk.x.mul(uCarpetWakeTilt)),
        tn.z,
        tn.y.mul(uCarpetBump).sub(vCarpetTilt.y).sub(wk.y.mul(uCarpetWakeTilt)),
      ));
      const ndl = dot(n, U.moonDir).max(0);
      const ao = arm.r.mul(uCarpetAO).add(uCarpetAO.oneMinus());
      const col = albedo.mul(ao).mul(U.moonColor).mul(ndl.mul(2.2).add(0.25)).mul(U.moonStrength).mul(uCarpetGain).toVar();
      // The pads' through-leaf glow, per fragment because the decal is far too coarse to carry it.
      col.addAssign(albedo.mul(this.shading.eelGlowAt(vec3(p.x, 0, p.y)).mul(uCarpetTransTint)).mul(uCarpetTransGain));

      // Everything that decides presence lands on one scalar, then a single fwidth threshold cuts it:
      // a finger parts the fronds and the log rejects them through the same edge the noise carves.
      const dens = uCarpetMemEdge.sub(rr.mul(uCarpetSpan)).mul(uCarpetMemSlope);
      const nz = this.noiseTex.sample(src.div(this.uWeedExtent).add(0.5)).r;
      const tear = smoothstep(uCarpetTearLo, uCarpetTearHi, fa).mul(uCarpetTearAmt);
      const solid = this.sim.mask.sample(c).r;
      // The scar reads at the fragment's world position while the noise reads in the clump's frame: a
      // furrow stays where it was plowed instead of riding a drifting mat across the pond.
      const scar = this.scarTex.sample(c).r;
      const edge = dens.add(nz.sub(uCarpetMemMid).mul(uCarpetMemNoise)).sub(scar.mul(uCarpetScarK)).sub(tear).sub(solid.mul(4));
      const aa = fwidth(edge).max(1e-4);
      const gate = smoothstep(aa.negate(), aa, edge);
      // Re-sharpen the lace: minification softens the near-binary opacity toward its 0.78 mean, and a
      // mat at 0.78 alpha everywhere is the flat green haze this set was chosen to avoid.
      const frond = smoothstep(uCarpetFrondLo, uCarpetFrondHi, holes);
      return vec4(col, gate.mul(frond));
    })();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.blending = THREE.NormalBlending;
    mat.side = THREE.DoubleSide;
    mat.forceSinglePass = true;
    this.carpetMaterial = mat;
    this.carpetMesh = new THREE.Mesh(geo, mat);
    this.carpetMesh.frustumCulled = false;
    this.carpetMesh.renderOrder = 8;
    this.knobs = {
      tile: uCarpetTile, ripple: uCarpetRipple, wakeWarp: uCarpetWakeWarp, wakeTilt: uCarpetWakeTilt,
      tearLo: uCarpetTearLo, tearHi: uCarpetTearHi, tearAmt: uCarpetTearAmt,
      memEdge: uCarpetMemEdge, memSlope: uCarpetMemSlope, memNoise: uCarpetMemNoise, scarK: uCarpetScarK,
      frondLo: uCarpetFrondLo, frondHi: uCarpetFrondHi, transGain: uCarpetTransGain,
    };
  }

  buildSpecks(U) {
    const geo = makeCardGeometry();
    this.home = new Float32Array(SPECK_POOL * 2);
    this.seedArr = new Float32Array(SPECK_POOL * 4);
    this.scaleArr = new Float32Array(SPECK_POOL * 3);
    this.off = new Float32Array(SPECK_POOL * 2);
    this.vel = new Float32Array(SPECK_POOL * 2);
    this.sFrac = new Float32Array(SPECK_POOL);
    this.sClump = new Uint8Array(SPECK_POOL);
    this.sActive = new Uint8Array(SPECK_POOL);
    this.sLoose = new Float32Array(SPECK_POOL);
    this.specks.forEach((s, i) => {
      this.home.set([s.x, s.z], i * 2);
      this.seedArr.set([s.tint, s.rot, s.glint, s.frac], i * 4);
      this.scaleArr.set([s.half, s.clump, s.loose], i * 3);
      this.sFrac[i] = s.frac;
      this.sClump[i] = s.clump;
      this.sLoose[i] = s.loose;
      this.sActive[i] = s.half > 0 ? 1 : 0;
    });
    // aSeed: tint, card rotation, glint jitter, radial fraction (the alive test). aScale: half-size, clump
    // index, looseness (0 in the mat, 1 adrift on open water). aOff: this frame's CPU displacement.
    geo.setAttribute('aHome', new THREE.InstancedBufferAttribute(this.home, 2));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seedArr, 4));
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(this.scaleArr, 3));
    this.aOff = new THREE.InstancedBufferAttribute(this.off, 2);
    this.aOff.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOff', this.aOff);
    geo.instanceCount = this.speckCount;

    // Uniforms, never bare literals, for anything that crosses an Fn boundary (Naga rejects those on Firefox).
    // Greens matched to the albedo set: the moon tint lifts blue 1.6× over red, so linear blue sits near zero.
    const uWeedColA = uniform(new THREE.Vector3(0.047, 0.102, 0.003));
    const uWeedColB = uniform(new THREE.Vector3(0.136, 0.230, 0.008));
    const uWeedColY = uniform(new THREE.Vector3(0.42, 0.27, 0.015));   // the odd yellowing frond
    const uWeedLit = uniform(new THREE.Vector2(2.2, 0.25));   // the carpet's own Lambert gain and ambient floor
    const uWeedGlint = uniform(new THREE.Vector2(40, 0.3));   // exponent, gain
    const uWeedLoose = uniform(2.2);                          // extra current drift for a speck adrift
    const uWeedTransTint = uniform(new THREE.Vector3(0.30, 1.0, 0.48));
    const uWeedTransGain = uniform(1.0);
    const uWeedFrondA = uniform(new THREE.Vector4(-0.22, 0.0, 1.0, 0.74));
    const uWeedFrondB = uniform(new THREE.Vector4(0.30, 0.10, 0.76, 1.0));
    const uWeedDome = uniform(new THREE.Vector2(0.55, 1.6));
    const uWeedEdge = uniform(new THREE.Vector2(1.0, 0.80));
    const uWeedGain = uniform(1.0);

    const vWeedTint = varying(vec3(0), 'vWeedTint');
    const vWeedGlint = varying(float(0), 'vWeedGlint');
    const vWeedTilt = varying(vec2(0), 'vWeedTilt');
    const vWeedGlow = varying(vec3(0), 'vWeedGlow');

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const home = attribute('aHome', 'vec2');
      const seed = attribute('aSeed', 'vec4');
      const scl = attribute('aScale', 'vec3');
      const off = attribute('aOff', 'vec2');
      // The whole growth and grazing mechanism: a speck is alive while its radial fraction is inside
      // its clump's scalar, and a dead one collapses to zero size instead of costing a CPU sweep.
      const g = this.uWeedGrowth.element(int(scl.y.add(0.5)));
      const cardSize = scl.x.mul(step(seed.w, g.x));
      const anchor = home.add(g.yz);
      const drift = this.current(anchor, U.time).mul(this.uWeedDrift.mul(scl.z.mul(uWeedLoose).add(1))).mul(U.motionScale);
      const here = anchor.add(off).add(drift);
      const ride = this.ride(here);
      const q = positionGeometry.xy.mul(cardSize);
      const cr = cos(seed.y), sr = sin(seed.y);
      const card = vec2(q.x.mul(cr).sub(q.y.mul(sr)), q.x.mul(sr).add(q.y.mul(cr)));
      vWeedTint.assign(mix(mix(uWeedColA, uWeedColB, seed.x.min(1)), uWeedColY, step(1.25, seed.x)));
      vWeedGlint.assign(seed.z.mul(0.6).add(0.7));
      // Tilt lands on the normal, not the geometry: under a straight-down orthographic camera a
      // card tipped about a horizontal axis projects identically, so only the shading can show it.
      vWeedTilt.assign(vec2(ride.y, ride.z));
      // A 5 px card needs no per-fragment glow, but it does need the same green the fronds beside it
      // take from an eel below, or the specks read as dark grit on a lit mat.
      vWeedGlow.assign(this.shading.eelGlowAt(vec3(here.x, 0, here.y)).mul(uWeedTransTint));
      return vec3(here.x.add(card.x), ride.x.add(this.uWeedFloat), here.y.add(card.y));
    })();

    mat.fragmentNode = Fn(() => {
      const q = uv().sub(0.5).mul(2);
      // Two offset ellipses: a frond and its smaller sibling, the shape duckweed actually has.
      const d1 = length(q.sub(uWeedFrondA.xy).div(uWeedFrondA.zw));
      const d2 = length(q.sub(uWeedFrondB.xy).div(uWeedFrondB.zw));
      const body = smoothstep(uWeedEdge.x, uWeedEdge.y, d1.min(d2));
      // A fake dome normal, tipped by the water it sits on, so the mat catches the moon instead of
      // reading as flat confetti.
      const n = normalize(vec3(q.x.mul(uWeedDome.x).sub(vWeedTilt.x), uWeedDome.y, q.y.mul(uWeedDome.x).sub(vWeedTilt.y)));
      // The carpet's own recipe, so a speck and the fronds under it are lit by one formula.
      const lit = dot(n, U.moonDir).max(0).mul(uWeedLit.x).add(uWeedLit.y);
      const glint = pow(dot(n, normalize(U.moonDir.add(vec3(0, 1, 0)))).max(0), uWeedGlint.x).mul(uWeedGlint.y).mul(vWeedGlint);
      const col = vWeedTint.mul(U.moonColor).mul(lit.add(glint)).mul(U.moonStrength).mul(uWeedGain)
        .add(vWeedTint.mul(vWeedGlow).mul(uWeedTransGain));
      return vec4(col, body);
    })();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.blending = THREE.NormalBlending;
    mat.side = THREE.DoubleSide;
    mat.forceSinglePass = true;
    this.speckMaterial = mat;
    this.speckMesh = new THREE.Mesh(geo, mat);
    this.speckMesh.frustumCulled = false;
    this.speckMesh.renderOrder = FLOATERS.duckweed.renderOrder;
    this.knobs.colA = uWeedColA; this.knobs.colB = uWeedColB; this.knobs.speckGain = uWeedGain;
  }

  /* Quality ladder: instance counts and uniforms only, never an allocation. The speck pool is
     shuffled, so cutting the tail thins every clump evenly. */
  setQuality({ speckFraction = 1, detile = true } = {}) {
    this.speckMesh.geometry.instanceCount = Math.max(0, Math.min(this.speckCount, Math.round(this.speckCount * speckFraction)));
    this.uCarpetDetile.value = detile ? 1 : 0;
  }

  /* One sub-frame segment of the finger's path, appended. main.js hands over every coalesced pointer
     sample since the last frame, so a fast swish is a polyline here and not a single chord. */
  poke(ax, az, bx, bz, vx, vz) {
    const p = this.poke0;
    if (p.n >= POKE_MAX) return;
    const o = p.n * 4;
    this.pokeSegs[o] = ax; this.pokeSegs[o + 1] = az; this.pokeSegs[o + 2] = bx; this.pokeSegs[o + 3] = bz;
    if (p.n === 0) { p.x0 = Math.min(ax, bx); p.x1 = Math.max(ax, bx); p.z0 = Math.min(az, bz); p.z1 = Math.max(az, bz); }
    else {
      p.x0 = Math.min(p.x0, ax, bx); p.x1 = Math.max(p.x1, ax, bx);
      p.z0 = Math.min(p.z0, az, bz); p.z1 = Math.max(p.z1, az, bz);
    }
    p.vx = vx; p.vz = vz; p.n++;
  }

  /* One capsule bitten out of the world-space scar layer, once, whatever mats are over it. floorMode (the
     finger, a grazer) caps the depth however many passes; Eleanor accumulates, so dwelling digs deeper. */
  carveCapsule(ax, az, bx, bz, r, amount, floorMode) {
    let near = false;
    for (const c of this.clumps) {
      const reach = c.r * c.growth * (WARP_BASE + WARP_SPAN) * MEM_SPAN + r;
      if (segDist(c.x + c.dx, c.z + c.dz, ax, az, bx, bz) <= reach) { near = true; break; }
    }
    if (!near) return;   // a furrow through open water would only cost the heal sweep
    const N = this.scar.res, ext = this.scar.extent, work = this.scar.work;
    const step = ext / N, half = ext * 0.5, inner = r * 0.45, amt = amount * 255;
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + half) / step - 0.5));
    const ix1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + r + half) / step - 0.5));
    const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - r + half) / step - 0.5));
    const iz1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + r + half) / step - 0.5));
    if (ix1 < ix0 || iz1 < iz0) return;
    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = (iz + 0.5) * step - half, row = iz * N;
      for (let ix = ix0; ix <= ix1; ix++) {
        const w = smoothstep01(r, inner, segDist((ix + 0.5) * step - half, wz, ax, az, bx, bz));
        if (w <= 0) continue;
        const i = row + ix, cut = amt * w;
        const v = floorMode ? Math.max(work[i], cut) : work[i] + cut;
        work[i] = v > SCAR_MAX ? SCAR_MAX : v;
      }
    }
    const box = this.carveBox;
    if (!box) this.carveBox = { x0: ix0, x1: ix1, z0: iz0, z1: iz1 };
    else {
      if (ix0 < box.x0) box.x0 = ix0; if (ix1 > box.x1) box.x1 = ix1;
      if (iz0 < box.z0) box.z0 = iz0; if (iz1 > box.z1) box.z1 = iz1;
    }
  }

  /* Eleanor is the only body wide enough to plow a mat in two; the residents pass under it. */
  carveGuests(dt) {
    const U = this.U;
    for (let s = 0; s < INF_SLOTS; s++) {
      const a = U.infA.array[s], b = U.infB.array[s];
      if (b.w <= 0 || a.w < CARVE_MIN_R || (a.y + b.y) * 0.5 < -CARVE_DEPTH) continue;
      this.carveCapsule(a.x, a.z, b.x, b.z, a.w * CARVE_WIDE, CARVE_RATE * dt, false);
    }
  }

  /* Relax the carved region back toward clean water and re-upload, four times a second at most. The scar
     does not drift with the mat over it, which CARVE_HEAL_TAU makes moot inside a few minutes. */
  healCarve(dt) {
    this.carveAcc += dt;
    if (this.carveAcc < CARVE_TICK) return;
    // Reset on every tick, box or not: an accumulator left running through a quiet minute would heal
    // the next carve away the instant it was made.
    const el = Math.min(this.carveAcc, 1);
    this.carveAcc = 0;
    if (!this.carveBox) return;
    const { x0, x1, z0, z1 } = this.carveBox;
    const N = this.scar.res, work = this.scar.work, bytes = this.scar.bytes;
    const keep = Math.exp(-el / CARVE_HEAL_TAU);
    let live = false;
    for (let iz = z0; iz <= z1; iz++) {
      const row = iz * N;
      for (let ix = x0; ix <= x1; ix++) {
        const i = row + ix, v = work[i];
        if (v > 0.4) { work[i] = v * keep; live = true; }
        else if (v !== 0) work[i] = 0;
        bytes[i] = work[i] + 0.5;
      }
    }
    if (!live) this.carveBox = null;
    this.scar.tex.needsUpdate = true;
  }

  /* The shared current, CPU side: the same curl-of-a-potential the shader evaluates, for the handful
     of clump centers whose drift the CPU owns. */
  currentAt(x, z, t, out) {
    const C = this.U.current.array, P = this.U.currentPhase.array;
    let dpdx = 0, dpdz = 0;
    for (let i = 0; i < C.length; i++) {
      const c = C[i], q = P[i];
      const g = Math.cos((x * c.x + z * c.y) * c.z + q.x + t * q.y) * c.w * c.z;
      dpdx += g * c.x; dpdz += g * c.y;
    }
    out.x = dpdz; out.z = -dpdx;
  }

  /* Right after pads.update, on this frame's pose. Growth and drift are two clocks walking one float per
     clump; each speck is a damped spring, which is what lets a rock hold it. */
  update(dt, now) {
    // Elapsed orbits, the same clock the lilies bloom on. main's moon.cycles counts from boot while
    // its phase01 counts from a wall-clock epoch, so their sum is not monotonic and cannot drive this.
    const cycle = now / MOON_ORBIT_SECONDS;
    const d = cycle - this.lastCycle;
    this.lastCycle = cycle;
    if (d > 0) {
      for (let i = 0; i < this.clumps.length; i++) {
        const c = this.clumps[i];
        const g = Math.min(this.growthCap, Math.max(GROWTH_FLOOR, c.growth + c.rate * d));
        if (g !== c.growth) { c.growth = g; this.growthArr[i].x = g; this.growF[i] = g; }
      }
    }
    this.driftClumps(dt, now);
    this.carveGuests(dt);
    for (let i = 0; i < this.poke0.n; i++) {
      const o = i * 4;
      this.carveCapsule(this.pokeSegs[o], this.pokeSegs[o + 1], this.pokeSegs[o + 2], this.pokeSegs[o + 3], FINGER_CARVE_R, FINGER_CARVE, true);
    }
    this.healCarve(dt);
    // Rain loosens the packing: the downwind bias eases off 30% while a shower is running.
    const target = this.rain?.envelope > 0.5 ? 0.7 : 1;
    this.windCalm += (target - this.windCalm) * Math.min(1, dt / 2);
    this.stepSpecks(dt);
  }

  /* Mats wander downwind a few centimeters a second, so a pond left running rearranges itself and islands
     merge as they pass. One that meets a rock or the log sticks; one that leaves the rect wraps upwind, off-frame. */
  driftClumps(dt, now) {
    const w = this.U.wind.value, ms = this.U.motionScale.value, out = this.driftOut;
    const spanX = 2 * (this.rect.ex + 1), spanZ = 2 * (this.rect.ez + 1);
    for (let i = 0; i < this.clumps.length; i++) {
      const c = this.clumps[i];
      this.currentAt(c.x + c.dx, c.z + c.dz, now, out);
      const ca = Math.cos(c.driftAng), sa = Math.sin(c.driftAng), k = CLUMP_DRIFT * c.driftK;
      const bx = (w.x * ca - w.y * sa) * k, bz = (w.x * sa + w.y * ca) * k;
      const nx = c.dx + (bx + out.x * CLUMP_DRIFT_CUR) * dt * ms;
      const nz = c.dz + (bz + out.z * CLUMP_DRIFT_CUR) * dt * ms;
      if (!this.insideObstacle(c.x + nx, c.z + nz, CLUMP_STICK)) { c.dx = nx; c.dz = nz; }
      let wx = c.dx, wz = c.dz;
      if (c.x + wx > this.rect.ex + 1) wx -= spanX;
      else if (c.x + wx < -this.rect.ex - 1) wx += spanX;
      if (c.z + wz > this.rect.ez + 1) wz -= spanZ;
      else if (c.z + wz < -this.rect.ez - 1) wz += spanZ;
      if (wx !== c.dx || wz !== c.dz) {
        // The upwind edge can hold a rock; slide the respawn along it until the mat lands on open water.
        for (let tries = 0; tries < 8 && this.insideObstacle(c.x + wx, c.z + wz, CLUMP_STICK); tries++) wz += (tries & 1 ? -1 : 1) * (tries + 1) * 0.8;
        c.dx = wx; c.dz = wz;
      }
      this.growthArr[i].y = c.dx; this.growthArr[i].z = c.dz;
      this.driftF[i * 2] = c.dx; this.driftF[i * 2 + 1] = c.dz;
    }
  }

  stepSpecks(dt) {
    const pk = this.poke0, seg = this.pokeSegs;
    const n = Math.min(this.speckCount, this.speckMesh.geometry.instanceCount);
    if (n <= 0) { pk.n = 0; return; }
    const U = this.U, h = Math.min(dt, SPECK_DT_MAX), ms = U.motionScale.value;
    // Eels stay an event under reduced motion; the wind is idle motion and follows motionScale.
    const eelK = SPECK_EEL_GAIN * (0.5 + 0.5 * ms);
    const w = U.wind.value, windK = SPECK_WIND_GAIN * w.z * ms * this.windCalm;
    const windX = w.x * windK, windZ = w.y * windK;
    // Slot boxes first: a speck then rejects a distant eel with four compares instead of a solve.
    const sb = this.slotBox;
    let ns = 0;
    for (let i = 0; i < INF_SLOTS; i++) {
      const a = U.infA.array[i], b = U.infB.array[i];
      if (b.w <= 0) continue;
      const reach = a.w + 0.9, o = ns * 5;
      sb[o] = i;
      sb[o + 1] = Math.min(a.x, b.x) - reach; sb[o + 2] = Math.max(a.x, b.x) + reach;
      sb[o + 3] = Math.min(a.z, b.z) - reach; sb[o + 4] = Math.max(a.z, b.z) + reach;
      ns++;
    }
    const off = this.off, vel = this.vel, home = this.home, drift = this.driftF;
    const act = this.sActive, frac = this.sFrac, cl = this.sClump, grow = this.growF, out = this.forceOut;
    const loose = this.sLoose;
    const dA = this.obsDisc, cA = this.obsCap, prof = this.obsProfile;
    const px0 = pk.x0 - POKE_OUTER, px1 = pk.x1 + POKE_OUTER, pz0 = pk.z0 - POKE_OUTER, pz1 = pk.z1 + POKE_OUTER;
    for (let i = 0; i < n; i++) {
      const ci = cl[i];
      if (!act[i] || frac[i] > grow[ci]) continue;
      const i2 = i * 2, c2 = ci * 2;
      let ox = off[i2], oz = off[i2 + 1];
      const hx = home[i2] + drift[c2], hz = home[i2 + 1] + drift[c2 + 1];
      let px = hx + ox, pz = hz + oz;
      const lw = 1 + loose[i] * 1.6;
      let fx = windX * lw, fz = windZ * lw;
      for (let s = 0; s < ns; s++) {
        const o = s * 5;
        if (px < sb[o + 1] || px > sb[o + 2] || pz < sb[o + 3] || pz > sb[o + 4]) continue;
        capsuleInfluenceCPU(U, px, 0, pz, sb[o], out);
        fx += out.x * eelK; fz += out.z * eelK;
      }
      let vx = vel[i2], vz = vel[i2 + 1];
      // The nearest sub-segment shoves once: summing over the polyline would multiply one swish by 16.
      if (pk.n && px >= px0 && px <= px1 && pz >= pz0 && pz <= pz1) {
        let bd = POKE_OUTER, brx = 0, brz = 0;
        for (let s = 0; s < pk.n; s++) {
          const o = s * 4, ax = seg[o], az = seg[o + 1], ex = seg[o + 2] - ax, ez = seg[o + 3] - az;
          const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1e-9)));
          const rx = px - (ax + ex * t), rz = pz - (az + ez * t), d = Math.sqrt(rx * rx + rz * rz);
          if (d < bd) { bd = d; brx = rx; brz = rz; }
        }
        if (bd < POKE_OUTER) {
          const inv = 1 / Math.max(1e-4, bd), gk = smoothstep01(POKE_OUTER, POKE_INNER, bd) * POKE_GAIN;
          vx += (brx * inv + pk.vx * POKE_VEL) * gk;
          vz += (brz * inv + pk.vz * POKE_VEL) * gk;
        }
      }
      // A loose speck is tethered to nothing much: the softer spring lets the wind carry it further
      // and bring it back slowly, which is the whole read of a bit adrift.
      const om = SPECK_OMEGA * (1 - loose[i] * 0.55), kSpring = om * om, kDamp = 2 * om;
      vx += (fx - kSpring * ox - kDamp * vx) * h;
      vz += (fz - kSpring * oz - kDamp * vz) * h;
      const v2 = vx * vx + vz * vz;
      if (v2 > SPECK_VMAX * SPECK_VMAX) { const s = SPECK_VMAX / Math.sqrt(v2); vx *= s; vz *= s; }
      ox += vx * h; oz += vz * h;
      const m2 = ox * ox + oz * oz;
      if (m2 > SPECK_CAP * SPECK_CAP) { const s = SPECK_CAP / Math.sqrt(m2); ox *= s; oz *= s; }
      px = hx + ox; pz = hz + oz;
      // Held at the waterline: the inward velocity dies so wind and wakes pile duckweed against the
      // log and the taller stones instead of sliding it through them.
      for (let j = 0; j < dA.length; j += 3) {
        const dx = px - dA[j], dz = pz - dA[j + 1], rr = dA[j + 2] + OBS_SKIN;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2);
        const nx = d > 1e-5 ? dx / d : 1, nz = d > 1e-5 ? dz / d : 0;
        px = dA[j] + nx * rr; pz = dA[j + 1] + nz * rr;
        const vn = vx * nx + vz * nz;
        if (vn < 0) { vx -= vn * nx; vz -= vn * nz; }
      }
      for (let j = 0, k = 0; j < cA.length; j += 5, k++) {
        const pr = prof[k];
        if (pr) {
          const rx = px - pr.ax, rz = pz - pr.az;
          const s = rx * pr.ux + rz * pr.uz;
          if (s < 0 || s > pr.len) continue;   // the mouths are open annuli: no cap juts past either end
          const perp = rx * -pr.uz + rz * pr.ux;
          const ap = perp < 0 ? -perp : perp;
          const rw = this.logHalfWidth(pr, s / pr.len, perp >= 0 ? 0 : 1) + OBS_SKIN;
          if (ap >= rw) continue;
          // Out through whichever face is nearer, so a speck that drifted in past a mouth leaves by the
          // mouth instead of being shouldered the whole width of the trunk.
          const near0 = s * 2 <= pr.len, endGap = near0 ? s : pr.len - s;
          let nlx, nlz, push;
          if (endGap < rw - ap) { const g = near0 ? -1 : 1; nlx = pr.ux * g; nlz = pr.uz * g; push = endGap + 1e-3; }
          else { const g = perp >= 0 ? 1 : -1; nlx = -pr.uz * g; nlz = pr.ux * g; push = rw - ap; }
          px += nlx * push; pz += nlz * push;
          const vnl = vx * nlx + vz * nlz;
          if (vnl < 0) { vx -= vnl * nlx; vz -= vnl * nlz; }
          continue;
        }
        // Squared compare in the hot path: segDist's hypot would run 20,000 times a frame for nothing.
        const rr = cA[j + 4] + OBS_SKIN;
        const ax = cA[j], az = cA[j + 1], bx = cA[j + 2] - ax, bz = cA[j + 3] - az;
        const t = Math.max(0, Math.min(1, ((px - ax) * bx + (pz - az) * bz) / (bx * bx + bz * bz || 1e-9)));
        const qx = ax + bx * t, qz = az + bz * t;
        const dx = px - qx, dz = pz - qz, dd = dx * dx + dz * dz;
        if (dd >= rr * rr) continue;
        const d = Math.sqrt(dd);
        const nx = d > 1e-5 ? dx / d : 1, nz = d > 1e-5 ? dz / d : 0;
        px = qx + nx * rr; pz = qz + nz * rr;
        const vn = vx * nx + vz * nz;
        if (vn < 0) { vx -= vn * nx; vz -= vn * nz; }
      }
      off[i2] = px - hx; off[i2 + 1] = pz - hz;
      vel[i2] = vx; vel[i2 + 1] = vz;
    }
    this.aOff.needsUpdate = true;
    pk.n = 0;
  }

  dispose() {
    for (const m of [this.carpetMesh, this.speckMesh]) { m.geometry.dispose(); m.material.dispose(); }
    this.noise.tex.dispose();
    this.scar.tex.dispose();
  }
}
