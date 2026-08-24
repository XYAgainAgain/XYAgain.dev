import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, attribute, vec2, vec3, vec4, float, int, floor, mix, normalize, cross, sin, cos, abs, smoothstep, varying, dot, TWO_PI, positionWorld } from 'three/tsl';
import { EEL_COUNT, EEL_POINTS, DEPTH } from './config.js';
import { valueNoise2 } from './shading.js';

const RINGS = 48, SIDES = 12;
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* Tube geometry parameterized by (t along, angle around); the spine comes in as a uniform array. */
function makeTubeGeometry() {
  const geo = new THREE.BufferGeometry();
  const count = (RINGS + 1) * (SIDES + 1);
  const aT = new Float32Array(count), aAng = new Float32Array(count);
  let k = 0;
  for (let r = 0; r <= RINGS; r++) {
    for (let s = 0; s <= SIDES; s++) {
      aT[k] = r / RINGS;
      aAng[k] = (s / SIDES) * Math.PI * 2;
      k++;
    }
  }
  const idx = [];
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * (SIDES + 1) + s, b = a + SIDES + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aAng', new THREE.BufferAttribute(aAng, 1));
  geo.setIndex(idx);
  return geo;
}

export class EelRenderer {
  constructor(scene, U, shading) {
    this.U = U;
    this.shading = shading;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.geometry = makeTubeGeometry();
    this.foodGeo = new THREE.SphereGeometry(0.045, 8, 6);
    this.foodMat = new THREE.NodeMaterial();
    // Alpha carries depth below the surface for the refraction pass, same as every underwater material.
    this.foodMat.fragmentNode = Fn(() => vec4(vec3(0.9, 0.8, 0.55), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
    // A hidden-size food crumb drawn on the first frames so the real first feed never compiles a pipeline mid-click.
    this.warmFood = new THREE.Mesh(this.foodGeo, this.foodMat);
    this.warmFood.scale.setScalar(0.001); this.warmFood.position.y = -DEPTH;
    this.warmFood.frustumCulled = false;
    this.group.add(this.warmFood);
  }

  endPrewarm() { if (this.warmFood) { this.group.remove(this.warmFood); this.warmFood = null; } }

  buildMesh(e) {
    const spine = [];
    for (let i = 0; i < EEL_POINTS; i++) spine.push(e.pts[i].clone());
    e.uSpine = uniformArray(spine);
    e.uColA = uniform(e.colA.clone());
    e.uColB = uniform(e.colB.clone());
    e.uRadius = uniform(e.radius);
    e.uSquash = uniform(1);
    e.uPattern = uniform(new THREE.Vector4(e.stripeFreq, e.spotFreq, e.wavy, e.pulseRate));
    e.uWeights = uniform(new THREE.Vector3(e.wStripe, e.wSpot, e.wFlank));
    e.uSeed = uniform(e.index * 17.3 + 3.1);
    e.uExcite = uniform(0);
    const U = this.U;

    const vNormal = varying(vec3(0), 'vEelN');
    const vWorld = varying(vec3(0), 'vEelP');
    const vUV = varying(vec2(0), 'vEelUV');

    const buildPosition = (radiusScale) => Fn(() => {
      const t = attribute('aT', 'float');
      const ang = attribute('aAng', 'float');
      const segF = t.mul(EEL_POINTS - 1);
      const i0 = int(floor(segF)).min(EEL_POINTS - 2);
      const f = segF.sub(float(i0));
      const p0 = e.uSpine.element(i0);
      const p1 = e.uSpine.element(i0.add(1));
      const pos = mix(p0, p1, f);
      const tangent = normalize(p1.sub(p0).add(vec3(1e-4, 0, 0)));
      // Epsilon keeps the frame finite if a segment ever points straight up or down.
      const b = normalize(cross(tangent, vec3(0, 1, 0)).add(vec3(1e-5, 0, 1e-5)));
      const n = cross(b, tangent);
      // Body profile: blunt head, long taper; eels are a little taller than wide.
      const profile = smoothstep(0.0, 0.10, t).mul(t.oneMinus().pow(0.6)).mul(1.15);
      const r = e.uRadius.mul(profile).mul(radiusScale);
      const ca = cos(ang), sa = sin(ang);
      const offset = n.mul(ca.mul(1.0)).add(b.mul(sa.mul(e.uSquash).mul(0.8)));
      const world = pos.add(offset.mul(r));
      vNormal.assign(normalize(n.mul(ca).add(b.mul(sa))));
      vWorld.assign(world);
      vUV.assign(vec2(t, ang));
      return world;
    })();

    const emission = Fn(() => {
      const t = vUV.x, ang = vUV.y;
      const time = U.time;
      const stripes = smoothstep(0.35, 0.65, sin(t.mul(e.uPattern.x).mul(TWO_PI).add(sin(ang.add(t.mul(6))).mul(e.uPattern.z)).sub(time.mul(0.6))).mul(0.5).add(0.5));
      const spotsN = valueNoise2(vec2(t.mul(e.uPattern.y), ang.mul(1.2).add(e.uSeed)));
      const spots = smoothstep(0.62, 0.8, spotsN);
      const flank = smoothstep(0.05, 0.35, abs(cos(ang))).oneMinus();
      const pulse = sin(time.mul(e.uPattern.w).sub(t.mul(7)).add(e.uSeed)).mul(0.25).add(0.85);
      const glowA = e.uColA.mul(stripes.mul(e.uWeights.x).add(flank.mul(e.uWeights.z)));
      const glowB = e.uColB.mul(spots.mul(e.uWeights.y));
      const eyeT = smoothstep(0.0, 0.05, t).oneMinus();
      return glowA.add(glowB).mul(pulse).mul(e.uExcite.mul(0.8).add(1)).add(eyeT.mul(0.3));
    });

    const bodyMat = new THREE.NodeMaterial();
    bodyMat.positionNode = buildPosition(1);
    bodyMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const L = this.shading.lightDir();
      const lambert = dot(n, L).max(0).mul(0.5).add(0.1);
      const body = vec3(0.03, 0.035, 0.05).mul(U.moonColor).mul(lambert);
      const glow = emission();
      const rim = dot(n, vec3(0, 1, 0)).max(0).oneMinus().pow(2).mul(0.4);
      const depthFrac = vWorld.y.negate().div(DEPTH).clamp(0, 1);
      return vec4(body.add(glow).add(glow.mul(rim)), depthFrac);
    })();
    bodyMat.side = THREE.FrontSide;

    // Halo: a fatter additive shell; alpha blend keeps the RT's depth channel from the body.
    const haloMat = new THREE.NodeMaterial();
    haloMat.positionNode = buildPosition(2.4);
    haloMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const edge = dot(n, vec3(0, 1, 0)).max(0);
      const glow = emission().mul(0.16).mul(edge.pow(1.5));
      return vec4(glow, 0);
    })();
    haloMat.transparent = true;
    haloMat.blending = THREE.CustomBlending;
    haloMat.blendSrc = THREE.OneFactor;
    haloMat.blendDst = THREE.OneFactor;
    haloMat.blendSrcAlpha = THREE.ZeroFactor;
    haloMat.blendDstAlpha = THREE.OneFactor;
    haloMat.depthWrite = false;
    haloMat.side = THREE.FrontSide;

    e.body = new THREE.Mesh(this.geometry, bodyMat);
    e.halo = new THREE.Mesh(this.geometry, haloMat);
    e.body.frustumCulled = e.halo.frustumCulled = false;
    e.halo.renderOrder = 5;

    const eyeGeo = new THREE.SphereGeometry(1, 8, 6);
    const eyeMat = new THREE.NodeMaterial();
    eyeMat.fragmentNode = Fn(() => vec4(vec3(1.0, 0.98, 0.9), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
    e.eyes = [new THREE.Mesh(eyeGeo, eyeMat), new THREE.Mesh(eyeGeo, eyeMat)];
    e.eyes.forEach((m) => { m.scale.setScalar(e.radius * 0.2); this.group.add(m); });
    this.group.add(e.body, e.halo);
  }

  applyAppearance(e) {
    e.uColA.value.copy(e.colA); e.uColB.value.copy(e.colB);
    e.uPattern.value.set(e.stripeFreq, e.spotFreq, e.wavy, e.pulseRate);
    e.uWeights.value.set(e.wStripe, e.wSpot, e.wFlank);
  }

  createFoodMesh() { return new THREE.Mesh(this.foodGeo, this.foodMat); }

  setEnabled(on) {
    this.group.visible = on;
    if (!on) for (let i = 0; i < EEL_COUNT; i++) { this.U.eelPos.array[i].set(0, -99, 0); this.U.eelCol.array[i].setRGB(0, 0, 0); }
  }

  sync(eels, foods, alpha) {
    const U = this.U;
    for (const e of eels) {
      for (let i = 0; i < EEL_POINTS; i++) e.uSpine.array[i].copy(e.show[i].copy(e.pose0[i]).lerp(e.pts[i], alpha));
      // Eye placement from the head frame.
      const h = e.show[0], n1 = e.show[1];
      tmpA.subVectors(h, n1).normalize();
      tmpB.crossVectors(tmpA, UP).normalize();
      const r = e.radius * 0.95;
      // Seated where the head profile is nearly full radius, sunk slightly into the body.
      e.eyes[0].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, r * 0.62);
      e.eyes[1].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, -r * 0.62);
      e.eyes[0].position.y += r * 0.22; e.eyes[1].position.y += r * 0.22;
      const mid = e.show[Math.floor(EEL_POINTS * 0.3)];
      U.eelPos.array[e.index].copy(mid);
      U.eelCol.array[e.index].copy(e.colA).lerp(e.colB, 0.3).multiplyScalar(0.7 + e.uExcite.value * 0.6);
    }
    for (const f of foods) {
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.scale.setScalar(Math.max(0.2, Math.min(1, f.amount)));
    }
  }

  dispose(eels) {
    this.geometry.dispose();
    for (const e of eels) { e.body.material.dispose(); e.halo.material.dispose(); }
    this.foodGeo.dispose(); this.foodMat.dispose();
  }
}
