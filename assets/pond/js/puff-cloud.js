import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, varying, vec2, vec3, vec4, float, sin, cos, fract, length, smoothstep, mix, step, uv, positionGeometry } from 'three/tsl';
import { puffCloudCards, PUFF_CLOUD_RIM } from './pollen-core.js';

/* A bumped lily's exhale: a cloud of pinpricks, each one advancing along its own bearing until it
   leaves the frame. The whole layer is stateless in the shader, so a burst is one attribute write. */

export const PUFF_CLOUD_POOL = 3000;

/* Same card as the film's: a quad in xz, facing the straight-down camera. */
function makeCardGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

export class PuffCloud {
  /* floaters supplies the film's own shared nodes (the current, the mat silhouette, the pool extent),
     so a puff eddies on the same water and hides under the same fronds the film does. */
  constructor({ overScene, U, sim, floaters, pool = PUFF_CLOUD_POOL }) {
    this.U = U;
    this.time = 0;
    this.next = 0;
    this.pool = Math.max(1, pool | 0);
    const n = this.pool;
    this.a = new Float32Array(n * 4);   // originX, originZ, birth, life
    this.b = new Float32Array(n * 4);   // dirX, dirZ, speed, seed

    const geo = makeCardGeometry();
    const mk = (arr) => {
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.aA = mk(this.a);
    this.aB = mk(this.b);
    geo.setAttribute('aPuffA', this.aA);
    geo.setAttribute('aPuffB', this.aB);
    geo.instanceCount = n;
    this.geometry = geo;

    this.uTime = uniform(0);
    const uPuffY = uniform(0.2);
    // Wider than the film's pinpricks and brighter than its base: the film reads at 0.012 only because
    // its slope sparkle multiplies it, and an airborne grain has no water under it to catch the light.
    const uPuffR = uniform(new THREE.Vector2(0.014, 0.022));
    const uPuffSwirl = uniform(0.5), uPuffSwirlRamp = uniform(3);
    const uPuffFlutter = uniform(0.04), uPuffFlutterRamp = uniform(2);
    // Flutter rate: base, per-seed, the z axis's rate ratio, and the phase scale.
    const uPuffRate = uniform(new THREE.Vector4(0.9, 1.1, 0.8, Math.PI * 2));
    const uPuffFade = uniform(new THREE.Vector2(0.25, 3));   // seconds in, seconds out
    // A rock swallows a card whole; a mat only dusts, so the fronds keep half the cloud on them.
    const uPuffMatSoft = uniform(0.3), uPuffMatWeight = uniform(0.5);
    const uPuffColor = uniform(new THREE.Vector3(1.0, 0.86, 0.42));
    const uPuffPinA = uniform(0.9), uPuffGain = uniform(2.0);
    const uPuffAlphaLo = uniform(0.5);

    const vPuffAlpha = varying(float(0), 'vPuffAlpha');

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const A = attribute('aPuffA', 'vec4');
      const B = attribute('aPuffB', 'vec4');
      const life = A.w.max(1e-3);
      const age = this.uTime.sub(A.z).toVar();
      // An unborn or expired card collapses to nothing, which is what makes a spent pool free.
      const live = step(float(0), age).mul(step(life, age).oneMinus());
      const t = age.max(0).toVar();
      const p = A.xy.add(B.xy.mul(B.z).mul(t)).toVar();
      // The shared curl field is divergence-free, so the cloud eddies without ever bunching into a knot.
      p.addAssign(floaters.current(p, U.time).mul(uPuffSwirl).mul(t.min(uPuffSwirlRamp)).mul(U.motionScale));
      const om = uPuffRate.x.add(uPuffRate.y.mul(B.w));
      const phi = B.w.mul(uPuffRate.w);
      p.addAssign(vec2(
        sin(t.mul(om).add(phi)),
        cos(t.mul(om).mul(uPuffRate.z).add(phi)),
      ).mul(uPuffFlutter).mul(t.min(uPuffFlutterRamp)).mul(U.motionScale));

      const env = smoothstep(float(0), uPuffFade.x, t).mul(smoothstep(life.sub(uPuffFade.y), life, t).oneMinus());
      const solid = sim.mask.sample(p.div(floaters.uWeedExtent).add(0.5)).a;
      const matV = smoothstep(uPuffMatSoft.negate(), uPuffMatSoft, floaters.matEdgeAt(p)).mul(uPuffMatWeight);
      const halfW = mix(uPuffR.x, uPuffR.y, B.w).mul(live).mul(env).mul(solid.oneMinus()).mul(matV.oneMinus());
      // Decorrelated from the radius and the flutter rate, which all read the one seed slot.
      vPuffAlpha.assign(uPuffAlphaLo.add(uPuffAlphaLo.oneMinus().mul(fract(B.w.mul(17)))));
      const q = positionGeometry.xy.mul(halfW);
      return vec3(p.x.add(q.x), uPuffY, p.y.add(q.y));
    })();

    mat.fragmentNode = Fn(() => {
      const q = uv().sub(0.5).mul(2);
      const r = length(q);
      // The film's pinprick, with no slope taps: these grains are in the air, not on the water.
      const shape = smoothstep(1.0, 0.55, r).mul(uPuffPinA);
      const col = uPuffColor.mul(U.moonColor).mul(U.moonStrength).mul(uPuffGain).mul(shape).mul(vPuffAlpha);
      return vec4(col, 0);
    })();
    mat.transparent = true;
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.forceSinglePass = true;
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 46;
    overScene.add(this.mesh);

    this.uPuffY = uPuffY;
    this.knobs = {
      r: uPuffR, swirl: uPuffSwirl, swirlRamp: uPuffSwirlRamp, flutter: uPuffFlutter,
      flutterRamp: uPuffFlutterRamp, rate: uPuffRate, fade: uPuffFade,
      matSoft: uPuffMatSoft, matWeight: uPuffMatWeight, color: uPuffColor,
      pinA: uPuffPinA, gain: uPuffGain, alphaLo: uPuffAlphaLo, y: uPuffY,
    };
  }

  /* main.js's frame clock, the same value burst() stamps. Should it run backward, in-flight cards read
     a negative age and the vertex stage treats them as dead. */
  setTime(t) {
    this.time = t;
    this.uTime.value = t;
  }

  /* One flower's cloud, born at its downwind petal rim. Ring buffer: a sixth simultaneous burst takes
     the oldest cards, which is the accepted failure at 3,000 slots and ~120 cards a puff. */
  burst(x, z, { size = 1, prng, count, y } = {}) {
    if (!prng || !(count > 0)) return 0;
    const w = this.U.wind.value;
    const windAngle = Math.atan2(w.y, w.x);
    const cards = puffCloudCards(prng, { count, windAngle, gust: w.z });
    const rimX = x + Math.cos(windAngle) * PUFF_CLOUD_RIM * size;
    const rimZ = z + Math.sin(windAngle) * PUFF_CLOUD_RIM * size;
    // A millisecond into the past: birth lands in a float32 attribute, and a clock that rounds up there
    // reads as unborn for a frame in both the shader's live test and the CPU count.
    const birth = this.time - 1e-3;
    for (const c of cards) {
      const o = this.next * 4;
      this.next = (this.next + 1) % this.pool;
      this.a[o] = rimX + c.offX * size; this.a[o + 1] = rimZ + c.offZ * size;
      this.a[o + 2] = birth; this.a[o + 3] = c.life;
      this.b[o] = c.dirX; this.b[o + 1] = c.dirZ; this.b[o + 2] = c.speed; this.b[o + 3] = c.seed;
    }
    if (y !== undefined) this.uPuffY.value = y;
    this.aA.needsUpdate = this.aB.needsUpdate = true;
    return cards.length;
  }

  /* Cards still inside their own life, for the headless checks. An untouched slot carries life 0. */
  live() {
    let n = 0;
    for (let i = 0; i < this.pool; i++) {
      const o = i * 4, life = this.a[o + 3], age = this.time - this.a[o + 2];
      if (life > 0 && age >= 0 && age < life) n++;
    }
    return n;
  }

  debug() { return { pool: this.pool, live: this.live(), next: this.next, time: this.time }; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
