import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, uv, vec3, vec4, float, max, step, sin, smoothstep, length, positionGeometry, varying, mix, atan } from 'three/tsl';

export const EFFECT_POOL = 64;

/* Kind is resolved on the CPU at spawn so the shader stays branchless: colors, rise speed, half-size
   in world units, and life in seconds. rise is +y because the pond's floor is at -DEPTH. Color may
   exceed 1: the pass is additive into a half-float target, so a pop reads as a real flash. */
export const KINDS = {
  spark: { color: [1.0, 0.86, 0.52], rise: 0.10, size: 0.055, life: 0.9, style: 0 },
  // ~1.3 cm at pond scale: a true-to-life bubble is too small to read from a straight-down camera.
  // style 1 draws a wobbling ring, 2 an expanding one.
  bubble: { color: [0.85, 0.95, 1.10], rise: 0.26, size: 0.075, life: 2.6, style: 1 },
  bubbleTiny: { color: [0.80, 0.92, 1.05], rise: 0.22, size: 0.048, life: 1.6, style: 1 },
  pop: { color: [1.20, 1.35, 1.55], rise: 0.02, size: 0.105, life: 0.16, style: 2 },
  mote: { color: [0.58, 0.95, 0.86], rise: 0.06, size: 0.045, life: 2.2, style: 0 },
};

/* One bounded instanced draw for every below-the-waterline effect: fish-death sparks, nibble bubbles,
   Eleanor's slurp motes. Lives in underScene so the surface pass refracts it like everything else. */
export class UnderwaterEffectsPool {
  constructor() {
    this.time = 0;
    this.next = 0;
    this.origin = new Float32Array(EFFECT_POOL * 4);   // xyz spawn point, w spawn time
    this.motion = new Float32Array(EFFECT_POOL * 4);   // xyz world velocity, w life
    this.look = new Float32Array(EFFECT_POOL * 4);     // rgb color, w half-size
    this.style = new Float32Array(EFFECT_POOL * 2);    // shape style, wobble seed

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (arr) => {
      const a = new THREE.InstancedBufferAttribute(arr, 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aOrigin = mk(this.origin);
    this.aMotion = mk(this.motion);
    this.aLook = mk(this.look);
    this.aStyle = new THREE.InstancedBufferAttribute(this.style, 2);
    this.aStyle.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aMotion', this.aMotion);
    geo.setAttribute('aLook', this.aLook);
    geo.setAttribute('aStyle', this.aStyle);
    geo.instanceCount = EFFECT_POOL;
    this.geometry = geo;

    this.uTime = uniform(0);
    // Per-instance attributes only exist in the vertex stage, so color and fade cross as varyings.
    const vTint = varying(vec3(0), 'vFxTint');
    const vFade = varying(float(0), 'vFxFade');
    const vRing = varying(float(0), 'vFxRing');
    const vSeed = varying(float(0), 'vFxSeed');

    const mat = new THREE.NodeMaterial();
    // Quads lie in xz to face the straight-down camera. A dead or unborn slot collapses to zero scale,
    // so it costs four degenerate vertices and no fragments instead of a per-frame CPU sweep.
    mat.positionNode = Fn(() => {
      const o = attribute('aOrigin', 'vec4');
      const m = attribute('aMotion', 'vec4');
      const look = attribute('aLook', 'vec4');
      const style = attribute('aStyle', 'vec2');
      const t = this.uTime.sub(o.w).toVar();
      const life = m.w.max(1e-3);
      const live = step(float(0), t).mul(step(life, t).oneMinus());
      const f = t.div(life).clamp(0, 1);
      vTint.assign(look.rgb);
      vRing.assign(style.x.clamp(0, 1));
      vSeed.assign(style.y);
      // Rings vanish all at once, like real bubbles; only blobs get the slow fade.
      const softEnv = smoothstep(0.0, 0.15, f).mul(f.oneMinus());
      const holdEnv = smoothstep(0.0, 0.1, f).mul(smoothstep(1.0, 0.82, f));
      vFade.assign(mix(softEnv, holdEnv, vRing));
      const c = o.xyz.add(m.xyz.mul(t.max(0)));
      const sway = sin(t.mul(5).add(o.x.mul(7))).mul(0.012);
      const half = look.w.mul(live).mul(max(0, style.x.sub(1)).mul(f).mul(1.2).add(1));
      const q = positionGeometry.xy;
      return vec3(c.x.add(sway).add(q.x.mul(half)), c.y, c.z.add(q.y.mul(half)));
    })();
    mat.fragmentNode = Fn(() => {
      const q = uv().sub(0.5).mul(2);
      const r = length(q);
      // Two angular waves with per-instance phase, so no two bubbles shimmy alike.
      const th = atan(q.y, q.x);
      const wob = sin(th.mul(3).add(this.uTime.mul(6)).add(vSeed)).mul(0.035)
        .add(sin(th.mul(5).sub(this.uTime.mul(8.3)).add(vSeed.mul(1.7))).mul(0.02));
      const rw = r.mul(wob.mul(vRing).add(1));
      const blob = max(0, rw.oneMinus()).pow(1.5);
      const ring = smoothstep(0.68, 0.82, rw).mul(smoothstep(0.96, 0.88, rw)).mul(0.85)
        .add(smoothstep(0.18, 0.0, rw).mul(0.18));
      return vec4(vTint.mul(mix(blob, ring, vRing)).mul(vFade), 0);
    })();
    // Additive RGB with alpha left alone: underRT's alpha carries the depth fraction the surface
    // refraction reads, and renderOrder 20 puts this after every opaque contributor and the eel halo.
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
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  /* main.js's frame clock, the same value spawn() stamps. Should it ever run backward (a wrap, a
     reseek), in-flight slots read a negative age and the vertex stage treats them as dead. */
  setTime(t) {
    this.time = t;
    this.uTime.value = t;
  }

  /* Ring buffer: the 65th spawn overwrites the oldest of the 64 live slots. Returns the slot it took. */
  spawn(x, y, z, kind = 'spark') {
    const p = KINDS[kind] ?? KINDS.spark;
    const i = this.next;
    this.next = (this.next + 1) % EFFECT_POOL;
    const o = i * 4;
    this.origin[o] = x; this.origin[o + 1] = y; this.origin[o + 2] = z; this.origin[o + 3] = this.time;
    this.motion[o] = 0; this.motion[o + 1] = p.rise; this.motion[o + 2] = 0; this.motion[o + 3] = p.life;
    this.look[o] = p.color[0]; this.look[o + 1] = p.color[1]; this.look[o + 2] = p.color[2]; this.look[o + 3] = p.size;
    this.style[i * 2] = p.style; this.style[i * 2 + 1] = Math.random() * 6.28;
    this.aOrigin.needsUpdate = this.aMotion.needsUpdate = this.aLook.needsUpdate = this.aStyle.needsUpdate = true;
    return i;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
