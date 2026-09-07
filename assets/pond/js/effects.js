import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, uv, vec3, vec4, float, max, step, sin, smoothstep, length, positionGeometry, varying, mix, atan } from 'three/tsl';

export const EFFECT_POOL = 64;

/* Kind is resolved on the CPU at spawn so the shader stays branchless: colors, rise speed, half-size
   in world units, and life in seconds. rise is +y because the pond's floor is at -DEPTH. Color may
   exceed 1: the pass is additive into a half-float target, so a pop reads as a real flash.
   style is the drawn shape (0 blob, 1 wobbling ring, 2 expanding ring, 3 blob that holds then goes);
   gravity, grow, and opacity ride the sediment attribute and are 0/0/1 for the additive kinds. */
export const KINDS = {
  spark: { color: [1.0, 0.86, 0.52], rise: 0.10, size: 0.055, life: 0.9, style: 0 },
  // ~1.3 cm at pond scale: a true-to-life bubble is too small to read from a straight-down camera.
  // style 1 draws a wobbling ring, 2 an expanding one.
  bubble: { color: [0.85, 0.95, 1.10], rise: 0.26, size: 0.075, life: 2.6, style: 1 },
  bubbleTiny: { color: [0.80, 0.92, 1.05], rise: 0.22, size: 0.048, life: 1.6, style: 1 },
  pop: { color: [1.20, 1.35, 1.55], rise: 0.02, size: 0.105, life: 0.16, style: 2, grow: 1.2 },
  mote: { color: [0.58, 0.95, 0.86], rise: 0.06, size: 0.045, life: 2.2, style: 0 },
  // Sediment, premultiplied instance only: a grain thunks sideways under gravity and sits where it
  // lands; silt swells and dissipates. Color comes from the sand at the dig, per spawn.
  grain: { color: [0.42, 0.38, 0.32], rise: 0.12, size: 0.018, life: 3.0, style: 3, gravity: 0.6, opacity: 1 },
  silt: { color: [0.48, 0.44, 0.38], rise: 0.05, size: 0.03, life: 4.5, style: 0, grow: 1.5, opacity: 0.35 },
};

const NO_LANDING = -1e6;   // a grain-only clamp; every other kind falls through max() untouched

/* One bounded instanced draw for every below-the-waterline effect: fish-death sparks, nibble bubbles,
   Eleanor's slurp motes, and (in a second premultiplied instance) the dig's sediment. Lives in
   underScene so the surface pass refracts it like everything else. */
export class UnderwaterEffectsPool {
  constructor({ pool = EFFECT_POOL, blend = 'additive', rng = null } = {}) {
    this.time = 0;
    this.next = 0;
    this.pool = Math.max(1, pool | 0);
    this.premultiplied = blend === 'premultiplied';
    // The sediment instance draws its wobble seeds from the pond's seeded stream; the additive one
    // keeps Math.random, so a decorative puff can never shift a seeded decision.
    this.rand = rng ? () => rng.next() : Math.random;
    const n = this.pool;
    this.origin = new Float32Array(n * 4);   // xyz spawn point, w spawn time
    this.motion = new Float32Array(n * 4);   // xyz world velocity, w life
    this.look = new Float32Array(n * 4);     // rgb color, w half-size
    this.style = new Float32Array(n * 2);    // shape style, wobble seed
    this.grain = new Float32Array(n * 4);    // gravity, landing height, growth, opacity
    // Eviction bookkeeping: 0 free, 1 grain, 2 silt, 3 anything else.
    this.slotKind = new Uint8Array(n);
    this.dieAt = new Float32Array(n);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (arr, size = 4) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aOrigin = mk(this.origin);
    this.aMotion = mk(this.motion);
    this.aLook = mk(this.look);
    this.aStyle = mk(this.style, 2);
    this.aGrain = mk(this.grain);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aMotion', this.aMotion);
    geo.setAttribute('aLook', this.aLook);
    geo.setAttribute('aStyle', this.aStyle);
    geo.setAttribute('aGrain', this.aGrain);
    geo.instanceCount = n;
    this.geometry = geo;

    for (let i = 0; i < n; i++) this.grain[i * 4 + 1] = NO_LANDING;

    this.uTime = uniform(0);
    // Per-instance attributes only exist in the vertex stage, so color and fade cross as varyings.
    const vTint = varying(vec3(0), 'vFxTint');
    const vFade = varying(float(0), 'vFxFade');
    const vRing = varying(float(0), 'vFxRing');
    const vSeed = varying(float(0), 'vFxSeed');
    const vAlpha = varying(float(0), 'vFxAlpha');

    const mat = new THREE.NodeMaterial();
    // Quads lie in xz to face the straight-down camera. A dead or unborn slot collapses to zero scale,
    // so it costs four degenerate vertices and no fragments instead of a per-frame CPU sweep.
    mat.positionNode = Fn(() => {
      const o = attribute('aOrigin', 'vec4');
      const m = attribute('aMotion', 'vec4');
      const look = attribute('aLook', 'vec4');
      const style = attribute('aStyle', 'vec2');
      const gr = attribute('aGrain', 'vec4');
      const t = this.uTime.sub(o.w).toVar();
      const life = m.w.max(1e-3);
      const live = step(float(0), t).mul(step(life, t).oneMinus());
      const f = t.div(life).clamp(0, 1);
      vTint.assign(look.rgb);
      // Style 3 is a blob that holds and then goes: it takes the hold envelope without the ring shape.
      vRing.assign(style.x.clamp(0, 1).mul(step(style.x, float(2.5))));
      const hold = style.x.clamp(0, 1);
      vSeed.assign(style.y);
      vAlpha.assign(gr.w);
      // Rings vanish all at once, like real bubbles; only blobs get the slow fade.
      const softEnv = smoothstep(0.0, 0.15, f).mul(f.oneMinus());
      const holdEnv = smoothstep(0.0, 0.1, f).mul(smoothstep(1.0, 0.82, f));
      vFade.assign(mix(softEnv, holdEnv, hold));
      const tp = t.max(0);
      const c = o.xyz.add(m.xyz.mul(tp));
      // Gravity and the per-instance landing height live here so a grain flies, lands, and sits with
      // no CPU work; every other kind carries gravity 0 and a landing height far below the pond.
      const y = c.y.sub(gr.x.mul(tp).mul(tp).mul(0.5)).max(gr.y);
      const sway = sin(tp.mul(5).add(o.x.mul(7))).mul(0.012);
      const half = look.w.mul(live).mul(gr.z.mul(f).add(1));
      const q = positionGeometry.xy;
      return vec3(c.x.add(sway).add(q.x.mul(half)), y, c.z.add(q.y.mul(half)));
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
      const shape = mix(blob, ring, vRing).mul(vFade);
      if (!this.premultiplied) return vec4(vTint.mul(shape), 0);
      // Premultiplied: sediment has to occlude, and copying the additive vec4(rgb, 0) would make it
      // glow instead. The alpha factors below still leave underRT's depth channel alone.
      const a = shape.mul(vAlpha).clamp(0, 1);
      return vec4(vTint.mul(a), a);
    })();
    mat.transparent = true;
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    // Additive RGB with alpha left alone: underRT's alpha carries the depth fraction the surface
    // refraction reads, and renderOrder 20 puts this after every opaque contributor and the eel halo.
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = this.premultiplied ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
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

  /* Expired first, then the most-faded grain: a busy dig loses settled grains, never a live billow.
     The additive pool keeps its plain ring buffer, so nothing about the old kinds changes. */
  claimSlot(kindId) {
    if (!this.premultiplied) {
      const i = this.next;
      this.next = (this.next + 1) % this.pool;
      return i;
    }
    for (let i = 0; i < this.pool; i++) if (this.dieAt[i] <= this.time) { this.slotKind[i] = kindId; return i; }
    // Most faded means oldest as a fraction of its own life; grain lives vary, so dieAt alone would
    // evict a young short-lived grain ahead of an old, visibly settled long-lived one.
    let best = -1, oldest = -1;
    for (let i = 0; i < this.pool; i++) {
      if (this.slotKind[i] !== 1) continue;
      const age = (this.time - this.origin[i * 4 + 3]) / Math.max(1e-3, this.motion[i * 4 + 3]);
      if (age > oldest) { oldest = age; best = i; }
    }
    if (best < 0) { best = this.next; this.next = (this.next + 1) % this.pool; }
    this.slotKind[best] = kindId;
    return best;
  }

  /* Ring buffer on the additive pool: the 65th spawn overwrites the oldest of the 64 live slots.
     `opts` carries the per-spawn variance the sediment kinds need. Returns the slot it took. */
  spawn(x, y, z, kind = 'spark', opts = null) {
    const p = KINDS[kind] ?? KINDS.spark;
    const kindId = kind === 'grain' ? 1 : kind === 'silt' ? 2 : 3;
    const i = this.claimSlot(kindId);
    const o = i * 4;
    const life = opts?.life ?? p.life;
    this.origin[o] = x; this.origin[o + 1] = y; this.origin[o + 2] = z; this.origin[o + 3] = this.time;
    this.motion[o] = opts?.vx ?? 0; this.motion[o + 1] = opts?.vy ?? p.rise; this.motion[o + 2] = opts?.vz ?? 0; this.motion[o + 3] = life;
    const col = opts?.color ?? p.color;
    this.look[o] = col[0]; this.look[o + 1] = col[1]; this.look[o + 2] = col[2]; this.look[o + 3] = opts?.size ?? p.size;
    this.style[i * 2] = p.style; this.style[i * 2 + 1] = this.rand() * 6.28;
    this.grain[o] = p.gravity ?? 0;
    this.grain[o + 1] = opts?.landY ?? NO_LANDING;
    this.grain[o + 2] = p.grow ?? 0;
    this.grain[o + 3] = opts?.opacity ?? p.opacity ?? 1;
    this.dieAt[i] = this.time + life;
    this.aOrigin.needsUpdate = this.aMotion.needsUpdate = this.aLook.needsUpdate = this.aStyle.needsUpdate = this.aGrain.needsUpdate = true;
    return i;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
