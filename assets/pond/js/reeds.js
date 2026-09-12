import * as THREE from 'three/webgpu';
import {
  Fn, attribute, uniform, varying, vec2, vec3, vec4, float, sin, cos, sqrt, abs, dot, length,
  normalize, mix, smoothstep, step, select, frontFacing, screenSize,
} from 'three/tsl';
import { DEPTH, VIEW_H, INF_SLOTS, RUSH_POOL } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { capsuleInfluenceCPU } from './shading.js';
import { floorHeightAt } from './floor.js';
import { layoutTussocks, shadowCapsules, shoalHeight, SHADOW_CAPS, SHADOW_LEAN } from './reeds-core.js';

/* Soft rush on the sand shoals: one instanced ribbon drawn twice, opaque in underScene (alpha is the depth
   fraction) and emergent-only in overScene, bent by a damped CPU spring per stem, never by a raw wake read. */

const RUSH_SALT = 1702;
const STEM_SEGS = 6;                 // 7 rows × 2 = 14 ribbon vertices, 12 triangles
const HEAD_V = 0.885;                // the lateral inflorescence sits a little below the tip, as a rush's does
const ROCK_CLEAR = 0.3, LOG_CLEAR = 0.4;
const SHOAL_INNER = 0.5;             // a runner may not root this far inside a neighboring bar
// Per-stem shadows: COVER_CAPS 48 less the six reserved for the Phase 4 shelter sticks, with slack.
const PER_STEM_CAPS = 40, STEM_CAP_R = 0.08, STEM_CAP_S = 0.25;
const DT_MAX = 0.1;                  // a stalled tab must not integrate a whole second into the springs
const OVER_ORDER = 45;               // above the pads (40), the lilies (42), and the crumbs (44): a tip is the tallest thing afloat

/* The resting arc on the CPU, for the perch records: the same circular arc the position node draws. */
function restPoint(s, v) {
  const th = s.lean * v, R = s.len / Math.max(s.lean, 1e-3);
  const c = Math.cos(s.azimuth), sn = Math.sin(s.azimuth), out = R * (1 - Math.cos(th));
  return { x: s.x + c * out, y: s.y + R * Math.sin(th), z: s.z + sn * out };
}

function makeStemGeometry() {
  const rows = STEM_SEGS + 1;
  const geo = new THREE.InstancedBufferGeometry();
  // Row, side, and the head corner mask share one vec4: the stem already carries three instanced buffers.
  const rib = [];
  for (let r = 0; r < rows; r++) for (const s of [-1, 1]) rib.push(r / STEM_SEGS, s, 0, 0);
  const idx = [];
  for (let r = 0; r < STEM_SEGS; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, d, a, d, c);
  }
  const h = rows * 2;
  for (const [u, w] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) rib.push(HEAD_V, 0, u, w);
  idx.push(h, h + 1, h + 2, h, h + 2, h + 3);
  const n = h + 4;
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  // shade() carries texture nodes whose default uv resolves at build; WebGL2 warns when it is missing.
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  geo.setAttribute('aRib', new THREE.Float32BufferAttribute(rib, 4));
  geo.setIndex(idx);
  return geo;
}

export class Rushes {
  constructor({ underScene, overScene, U, shading, wake, seed, shoals, colliders, habitat, motion, view }) {
    this.U = U;
    this.motion = motion;
    this.tussocks = [];
    this.stems = [];
    this.capsCount = 0;
    this.pokes = [];
    this.pushTmp = { x: 0, z: 0 };
    this.layout(seed, shoals ?? [], colliders, view, habitat);
    this.build(U, shading, wake);
    underScene.add(this.mesh);
    if (overScene) overScene.add(this.overMesh);
    if (habitat) {
      this.publishShadows(habitat);
      this.publishPerches(habitat);
    }
  }

  get count() { return this.stems.length; }

  layout(seed, shoals, colliders, view, habitat) {
    const rng = createRng(deriveSeed(seed, RUSH_SALT));
    const spheres = colliders?.spheres ?? [];
    const logs = colliders?.logs ?? [];
    // The pads are placed before the rushes, so an emergent stem can be kept out from under one.
    const padAt = habitat?.padAt ? (x, z, m) => !!habitat.padAt(x, z, m) : null;
    // A runner may land anywhere its own bar reaches, but not inside stone, wood, a pad, or a neighbor's crown.
    const blocked = (x, z, own) => {
      if (padAt && padAt(x, z, 0.3)) return true;
      for (const o of spheres) if (Math.hypot(x - o.x, z - o.z) < (o.rHit ?? o.r) + ROCK_CLEAR) return true;
      for (const l of logs) {
        const dx = l.b.x - l.a.x, dz = l.b.z - l.a.z, l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - l.a.x) * dx + (z - l.a.z) * dz) / l2));
        const px = x - (l.a.x + dx * t), pz = z - (l.a.z + dz * t);
        if (px * px + pz * pz < (l.rOuter + LOG_CLEAR) ** 2) return true;
      }
      for (const s of shoals) if (s !== own && shoalHeight(s, x, z) > s.h * SHOAL_INNER) return true;
      return false;
    };
    // Roots sit on the sand as drawn, dunes and mound alike; a flat -DEPTH floats or buries a base by the dune height.
    const out = layoutTussocks(rng, shoals, view, { floorAt: floorHeightAt, blocked, padAt, pool: RUSH_POOL });
    this.tussocks = out.tussocks;
    this.stems = out.stems;
  }

  build(U, shading, wake) {
    const geo = makeStemGeometry();
    // The layout is final for the life of the page, so the buffers size to what grew, not to the pool.
    const n = Math.max(1, this.stems.length);
    const A = new Float32Array(n * 4), B = new Float32Array(n * 4), C = new Float32Array(n * 4);
    this.stems.forEach((s, i) => {
      const o = i * 4;
      A.set([s.x, s.z, s.len, s.azimuth], o);
      B.set([s.phase, s.lean, s.head, s.seed], o);
      C.set([s.y, s.dead, s.hue, s.width], o);
    });
    geo.setAttribute('aRushA', new THREE.InstancedBufferAttribute(A, 4));
    geo.setAttribute('aRushB', new THREE.InstancedBufferAttribute(B, 4));
    geo.setAttribute('aRushC', new THREE.InstancedBufferAttribute(C, 4));
    // The spring's bend per stem, in radians on xz, rewritten each frame; the fourth instanced buffer.
    this.bendArr = new Float32Array(n * 4);
    this.aBend = new THREE.InstancedBufferAttribute(this.bendArr, 4);
    this.aBend.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aRushD', this.aBend);
    this.springX = new Float32Array(n); this.springZ = new Float32Array(n);
    this.velX = new Float32Array(n); this.velZ = new Float32Array(n);
    geo.instanceCount = this.stems.length;

    // Uniforms, never bare literals: an all-literal WGSL expression is abstract and Naga rejects the
    // module the moment one reaches runtime math.
    const uRushGreen = uniform(new THREE.Vector3(0.13, 0.30, 0.11));
    const uRushStraw = uniform(new THREE.Vector3(0.44, 0.38, 0.20));
    const uRushHeadBrown = uniform(new THREE.Vector3(0.33, 0.22, 0.11));
    const uRushStrawBand = uniform(new THREE.Vector2(0.35, 1.0));
    const uRushDeadTone = uniform(0.9);
    const uRushDeadW = uniform(0.7);
    const uRushRough = uniform(0.8);
    const uRushHue = uniform(1.0);
    // Verticality, since a straight-down camera cannot show height: the submerged half is damped and the
    // waterline wears a bright ring, which is the cue that reads as "this pierces the surface".
    const uRushWetTint = uniform(0.75);
    const uRushWetBand = uniform(new THREE.Vector2(-0.01, 0.01));
    const uRushMeniscus = uniform(0.35), uRushMeniscusW = uniform(0.02);
    const uRushWBase = uniform(0.035), uRushWTip = uniform(0.010);
    const uRushHeadW = uniform(0.08), uRushHeadL = uniform(0.05);
    const uRushSway = uniform(0.04);
    const uRushOmega = uniform(new THREE.Vector2(3.0, 4.0));
    // The wake is a shiver on top of the spring, as the tufts use it, never the part itself.
    const uRushWakeK = uniform(2.4), uRushWakeGain = uniform(0.18);
    const uRushBendMax = uniform(0.9);
    // The spring (CPU, per stem): a reed's fundamental near 3.6 rad/s and light damping give the 2–3
    // visible overshoots a parted clump shows before it settles.
    this.spring = {
      omega: 3.6, zeta: 0.12, contact: 1.4, massSoft: 0.6, finger: 1.2, fingerR: 0.55,
      gain: this.motion?.reduced ? 0.5 : 1,
    };
    // Rung 5 drops the internal DPR, and below about two pixels a ribbon crawls whatever MSAA does.
    const uRushPxFloor = uniform(0), uRushPxFrom = uniform(0.6), uRushViewH = uniform(VIEW_H);
    const uRushShadow = uniform(0.3);

    // Two materials share one geometry and one graph; each gets its own varyings, built fresh per material.
    const buildMaterial = (over) => {
    const vRushP = varying(vec3(0), over ? 'vRushOP' : 'vRushP');
    const vRushT = varying(vec3(0), over ? 'vRushOT' : 'vRushT');
    const vRushSideV = varying(vec3(0), over ? 'vRushOSideV' : 'vRushSideV');
    const vRushSide = varying(float(0), over ? 'vRushOSide' : 'vRushSide');
    const vRushV = varying(float(0), over ? 'vRushOV' : 'vRushV');
    const vRushSeed = varying(vec3(0), over ? 'vRushOSeed' : 'vRushSeed');
    const vRushHead = varying(float(0), over ? 'vRushOHead' : 'vRushHead');

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const A4 = attribute('aRushA', 'vec4'), B4 = attribute('aRushB', 'vec4'), C4 = attribute('aRushC', 'vec4');
      const D4 = attribute('aRushD', 'vec4');
      const rib = attribute('aRib', 'vec4');
      const v = rib.x, side = rib.y;
      const base = vec3(A4.x, C4.x, A4.y), baseXZ = vec2(A4.x, A4.y);
      const len = A4.z, lean = B4.y;
      const azDir = vec2(cos(A4.w), sin(A4.w));
      const bend = azDir.mul(lean).toVar();

      // A fast stem oscillation under the lagged gust: the gust reaches the clump a beat after the water.
      const omega = mix(uRushOmega.x, uRushOmega.y, B4.w);
      const windDir = normalize(U.wind.xy.add(vec2(1e-4, 0)));
      const gust = U.wind.w.mul(sin(U.time.mul(omega).add(B4.x))).mul(uRushSway).mul(v).mul(v).mul(U.motionScale);
      bend.addAssign(windDir.mul(gust));

      // The part is the CPU spring (bodies and the finger, damped, with its overshoots); the wake read at
      // this row's own resting xz is only a shiver that travels up a stem after the body has passed.
      const R0 = len.div(lean.max(1e-3));
      const restXZ = baseXZ.add(azDir.mul(R0.mul(cos(lean.mul(v)).oneMinus())));
      const wk = wake.wakeAt(restXZ, uRushWakeK).mul(uRushWakeGain).mul(U.motionScale);
      bend.addAssign(D4.xy.add(wk).mul(v).mul(v));

      const raw = length(bend);
      const theta = raw.min(uRushBendMax.add(lean)).max(1e-3);
      const dir2 = bend.div(raw.max(1e-4));
      const dir = vec3(dir2.x, 0, dir2.y);
      // Circular arc of exact length, so a hard-parted rush never grows while Eleanor passes.
      const th = theta.mul(v);
      const R = len.div(theta);
      const p = base.add(dir.mul(R.mul(cos(th).oneMinus()))).add(vec3(0, R.mul(sin(th)), 0)).toVar();
      const tangent = vec3(0, 1, 0).mul(cos(th)).add(dir.mul(sin(th)));

      const sideV = vec3(dir2.y.negate(), 0, dir2.x);
      const wide = mix(uRushWBase, uRushWTip, v).mul(C4.w).mul(mix(float(1), uRushDeadW, C4.y))
        .max(step(uRushPxFrom, v).mul(uRushPxFloor).mul(uRushViewH).div(screenSize.y).mul(0.5));
      p.addAssign(sideV.mul(side).mul(wide));
      // The seed head, a diamond that collapses to a point when this stem carries none.
      p.addAssign(sideV.mul(rib.z).mul(B4.z).mul(uRushHeadW));
      p.addAssign(tangent.mul(rib.w).mul(B4.z).mul(uRushHeadL));

      vRushP.assign(p);
      vRushT.assign(tangent);
      vRushSideV.assign(sideV);
      vRushSide.assign(side);
      vRushV.assign(v);
      vRushSeed.assign(vec3(B4.w, C4.y, C4.z));
      vRushHead.assign(abs(rib.z).add(abs(rib.w)).min(1));
      return p;
    })();

    mat.fragmentNode = Fn(() => {
      // Round shading on flat geometry: the side coordinate is the normal across the ribbon and the
      // camera-facing component is what is left of it, taken perpendicular to the local tangent.
      const t = normalize(vRushT);
      const s = vRushSide;
      const n0 = vRushSideV.mul(s).add(vec3(0, 1, 0).mul(sqrt(s.mul(s).oneMinus().max(0))));
      const nRaw = n0.sub(t.mul(dot(n0, t)));
      const n = nRaw.div(length(nRaw).max(1e-4));
      const nn = select(frontFacing, n, n.negate());
      const live = mix(uRushGreen, uRushStraw, smoothstep(uRushStrawBand.x, uRushStrawBand.y, vRushV));
      const body = mix(live, uRushStraw.mul(uRushDeadTone), vRushSeed.y);
      const hue = vRushSeed.z.mul(uRushHue);
      // Red against green, so a neighbor reads yellower or cooler rather than merely brighter.
      const albedo = mix(body, uRushHeadBrown, vRushHead).add(vec3(hue, hue.negate(), hue.mul(-0.5))).max(0);
      const lit = shading.shade(albedo, nn, vRushP, uRushRough).toVar();
      lit.mulAssign(mix(uRushWetTint, float(1), smoothstep(uRushWetBand.x, uRushWetBand.y, vRushP.y)));
      lit.addAssign(smoothstep(0, uRushMeniscusW, abs(vRushP.y)).oneMinus().mul(uRushMeniscus));
      if (over) {
        // Only what stands above the film, feathered across the meniscus band; the water and everything
        // floating on it are already composed underneath, so this is the emergent stem laid on top.
        return vec4(lit, smoothstep(uRushMeniscusW.negate(), uRushMeniscusW, vRushP.y));
      }
      return vec4(lit, vRushP.y.negate().div(DEPTH).clamp(0, 1));
    })();
    mat.side = THREE.DoubleSide;
    if (over) {
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthTest = false;
      mat.blending = THREE.NormalBlending;
    }
    return mat;
    };

    const mat = buildMaterial(false);
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.overMaterial = buildMaterial(true);
    this.overMesh = new THREE.Mesh(geo, this.overMaterial);
    this.overMesh.frustumCulled = false;
    this.overMesh.renderOrder = OVER_ORDER;
    this.uPxFloor = uRushPxFloor;
    this.uShadow = uRushShadow;
    this.knobs = {
      green: uRushGreen, straw: uRushStraw, headBrown: uRushHeadBrown, strawBand: uRushStrawBand,
      deadTone: uRushDeadTone, deadWidth: uRushDeadW, rough: uRushRough, hue: uRushHue,
      wBase: uRushWBase, wTip: uRushWTip, headW: uRushHeadW, headL: uRushHeadL,
      sway: uRushSway, omega: uRushOmega,
      wakeK: uRushWakeK, wakeGain: uRushWakeGain, bendMax: uRushBendMax,
      spring: this.spring,
      pxFloor: uRushPxFloor, pxFrom: uRushPxFrom, shadow: uRushShadow,
      wetTint: uRushWetTint, wetBand: uRushWetBand, meniscus: uRushMeniscus, meniscusW: uRushMeniscusW,
      // Not a uniform: the cover bake is CPU work, and this picks which shape it pushes.
      shadowPerStem: true,
    };
  }

  /* Two shapes, one knob. Per stem (the default) a displaced shadow is the strongest standing-up cue a
     straight-down camera has; the two rest-pose proxies per tussock never disagree with a parting stem. */
  publishShadows(habitat) {
    this.shadowStems = this.stems.filter((s) => !s.dead).map((s) => {
      const tip = restPoint(s, 1);
      return { x: s.x, z: s.z, tipX: tip.x, tipZ: tip.z, tipY: Math.max(0, tip.y) };
    });
    habitat.addCoverSource((discs, caps) => {
      const m = this.U.moonDir.value;
      const h = Math.hypot(m.x, m.z) || 1;
      const mx = m.x / h, mz = m.z / h;
      const before = caps.length;
      if (this.knobs.shadowPerStem) {
        for (const s of this.shadowStems) {
          if (caps.length - before >= PER_STEM_CAPS) break;
          const lift = SHADOW_LEAN * s.tipY;
          caps.push({ ax: s.x, az: s.z, bx: s.tipX + mx * lift, bz: s.tipZ + mz * lift, r: STEM_CAP_R, strength: STEM_CAP_S });
        }
      } else {
        for (const t of this.tussocks) {
          if (caps.length - before >= SHADOW_CAPS) break;
          shadowCapsules(t, { x: mx, z: mz }, this.uShadow.value, caps);
        }
      }
      this.capsCount = caps.length - before;
    });
  }

  /* Rushes shed seeds and their tips are the only thing standing in open water; the fireflies and the
     dragonflies are the consumers, and neither exists yet. */
  publishPerches(habitat) {
    for (const s of this.stems) {
      if (s.dead) continue;
      const tip = restPoint(s, 1);
      habitat.addPerch({ x: tip.x, y: tip.y, z: tip.z, type: 'stem', radius: 0.04 });
      if (!s.head) continue;
      const head = restPoint(s, HEAD_V);
      habitat.addPerch({ x: head.x, y: head.y, z: head.z, type: 'stem', radius: 0.05 });
    }
  }

  /* The finger, one segment per frame from main: a push along its travel on every stem within reach.
     Queued here and spent in update(), so a swish arrives as force the spring integrates, never as a pose. */
  poke(ax, az, bx, bz, vx, vz) {
    this.pokes.push({ ax, az, bx, bz, vx, vz });
  }

  /* One damped spring per stem: bodies and the finger push, the stem swings back through 2–3 overshoots,
     and nothing reads a per-frame field, so a swish cannot make a clump jitter. */
  update(dt) {
    const n = this.stems.length;
    if (!n) { this.pokes.length = 0; return; }
    const step = dt > 0 ? Math.min(dt, DT_MAX) : 0;
    const S = this.spring, U = this.U, out = this.pushTmp;
    const w2 = S.omega * S.omega, damp = 2 * S.zeta * S.omega;
    const maxBend = this.knobs.bendMax.value;
    for (let i = 0; i < n; i++) {
      const s = this.stems[i];
      let fx = 0, fz = 0;
      for (let k = 0; k < INF_SLOTS; k++) {
        if (!capsuleInfluenceCPU(U, s.x, s.y, s.z, k, out)) continue;
        const a = U.infA.array[k], b = U.infB.array[k];
        const g = b.w * (a.w / (a.w + S.massSoft));   // girth scales the shove, as it does for the petioles
        fx += out.x * g; fz += out.z * g;
      }
      for (const q of this.pokes) {
        const ux = q.bx - q.ax, uz = q.bz - q.az, l2 = ux * ux + uz * uz || 1e-9;
        const tt = Math.max(0, Math.min(1, ((s.x - q.ax) * ux + (s.z - q.az) * uz) / l2));
        const dx = s.x - (q.ax + ux * tt), dz = s.z - (q.az + uz * tt);
        const d = Math.hypot(dx, dz);
        if (d >= S.fingerR) continue;
        const wgt = 1 - d / S.fingerR;
        const sp = Math.hypot(q.vx, q.vz), inv = sp > 1e-4 ? 1 / sp : 0;
        // Away from the finger's line, leaning into its travel; a stopped finger still parts by pressure.
        fx += (dx / Math.max(d, 1e-4) * 0.4 + q.vx * inv * 0.6) * wgt * S.finger;
        fz += (dz / Math.max(d, 1e-4) * 0.4 + q.vz * inv * 0.6) * wgt * S.finger;
      }
      const g = S.contact * S.gain;
      const ax = fx * g * w2 - w2 * this.springX[i] - damp * this.velX[i];
      const az = fz * g * w2 - w2 * this.springZ[i] - damp * this.velZ[i];
      this.velX[i] += ax * step; this.velZ[i] += az * step;
      let bx = this.springX[i] + this.velX[i] * step, bz = this.springZ[i] + this.velZ[i] * step;
      const m = Math.hypot(bx, bz);
      if (m > maxBend) { bx *= maxBend / m; bz *= maxBend / m; this.velX[i] *= 0.5; this.velZ[i] *= 0.5; }
      this.springX[i] = bx; this.springZ[i] = bz;
      const o = i * 4;
      this.bendArr[o] = bx; this.bendArr[o + 1] = bz;
    }
    this.pokes.length = 0;
    this.aBend.needsUpdate = true;
  }

  setQuality({ pxFloor = 0 } = {}) { this.uPxFloor.value = pxFloor; }

  debug() {
    const alive = this.stems.filter((s) => !s.dead).length;
    return {
      tussocks: this.tussocks.length,
      kinds: this.tussocks.map((t) => t.kind),
      stems: this.stems.length,
      alive,
      heads: this.stems.filter((s) => s.head > 0).length,
      capsules: this.capsCount,
      perTussock: this.tussocks.map((t) => ({
        x: +t.x.toFixed(2), z: +t.z.toFixed(2), stems: t.count,
        runner: +(t.runner * 180 / Math.PI).toFixed(1),
        tipY: +t.meanTipY.toFixed(2), reach: +t.meanHoriz.toFixed(2),
      })),
      tipSpan: this.stems.length
        ? [Math.min(...this.stems.map((s) => s.y + s.tip.height)), Math.max(...this.stems.map((s) => s.y + s.tip.height))].map((v) => +v.toFixed(3))
        : null,
    };
  }

  dispose() {
    this.mesh.removeFromParent();
    this.overMesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.overMaterial.dispose();
  }
}
