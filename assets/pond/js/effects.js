import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, uv, vec3, vec4, float, max, step, sin, smoothstep, length, positionGeometry, positionWorld, varying, mix, atan, dot, normalize, texture } from 'three/tsl';

export const EFFECT_POOL = 64;

/* Kind is resolved on the CPU at spawn so the shader stays branchless: colors, rise speed, half-size
   in world units, and life in seconds. rise is +y because the pond's floor is at -DEPTH. Color may
   exceed 1: the pass is additive into a half-float target, so a pop reads as a real flash. */
// style is the drawn shape (0 blob, 1 wobbling ring, 2 expanding ring, 3 blob that holds then goes).
// gravity, grow, and opacity ride the sediment attribute, defaulting to 0/0/1 for the additive kinds.
export const KINDS = {
  spark: { color: [1.0, 0.86, 0.52], rise: 0.10, size: 0.055, life: 0.9, style: 0 },
  // ~1.3 cm at pond scale: a true-to-life bubble is too small to read from a straight-down camera.
  // style 1 draws a wobbling ring, 2 an expanding one.
  bubble: { color: [0.85, 0.95, 1.10], rise: 0.26, size: 0.075, life: 2.6, style: 1 },
  bubbleTiny: { color: [0.80, 0.92, 1.05], rise: 0.22, size: 0.048, life: 1.6, style: 1 },
  pop: { color: [1.20, 1.35, 1.55], rise: 0.02, size: 0.105, life: 0.16, style: 2, grow: 1.2 },
  mote: { color: [0.58, 0.95, 0.86], rise: 0.06, size: 0.045, life: 2.2, style: 0 },
  // Sediment, premultiplied instance only: a grain is a pebble chipped from the sand map (setSubstrate)
  // that thunks down under gravity and sits; silt swells and dissipates. Spawn color is the no-texture fallback.
  grain: { color: [0.42, 0.38, 0.32], rise: 0.12, size: 0.018, life: 3.0, style: 3, gravity: 0.6, opacity: 1 },
  silt: { color: [0.48, 0.44, 0.38], rise: 0.05, size: 0.06, life: 4.5, style: 0, grow: 2.0, opacity: 0.6 },
};

const NO_LANDING = -1e6;   // a grain-only clamp; every other kind falls through max() untouched

/* One bounded instanced draw for every below-the-waterline effect: fish-death sparks, nibble bubbles,
   Eleanor's slurp motes, and (a second premultiplied instance) the dig's sediment; underScene refracts it like everything else. */
export class UnderwaterEffectsPool {
  constructor({ pool = EFFECT_POOL, blend = 'additive', rng = null, shading = null } = {}) {
    this.time = 0;
    this.next = 0;
    this.pool = Math.max(1, pool | 0);
    this.premultiplied = blend === 'premultiplied';
    // Only the sediment instance draws pebbles, and only with the floor's shading to light them by.
    this.shading = shading;
    this.pebbles = this.premultiplied && !!shading;
    // The sediment instance draws its wobble seeds from the pond's seeded stream; the additive one
    // keeps Math.random, so a decorative puff can never shift a seeded decision.
    this.rand = rng ? () => rng.next() : Math.random;
    const n = this.pool;
    this.origin = new Float32Array(n * 4);   // xyz spawn point, w spawn time
    this.motion = new Float32Array(n * 4);   // xyz world velocity, w life
    this.look = new Float32Array(n * 4);     // rgb color, w half-size
    this.style = new Float32Array(n * 4);    // shape style, wobble seed, substrate uv window origin
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
    this.aStyle = mk(this.style, 4);
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
    // The sand map a pebble is a chip of, blank until setSubstrate. The placeholder declares sRGB because
    // TSL bakes the decode from the texture the node is built against, not the one swapped in later.
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    blank.colorSpace = THREE.SRGBColorSpace;
    blank.needsUpdate = true;
    this.blank = blank;
    this.subTex = texture(blank);
    this.uSubOn = uniform(0);
    this.uSubUV = uniform(1);      // the floor's own world-to-uv scale, so texel densities match
    this.uSubGain = uniform(1);    // knobs.air.puff, republished at every grain spawn
    const uGrainDome = uniform(new THREE.Vector2(0.9, 1.0));    // fake dome normal: rim slope, height
    // A pebble is not a circle, and its rim has to stay inside the quad once the wobble widens it.
    const uGrainWob = uniform(3.5);
    const uGrainEdge = uniform(new THREE.Vector2(0.78, 0.62));
    // Per-instance attributes only exist in the vertex stage, so color and fade cross as varyings.
    const vTint = varying(vec3(0), 'vFxTint');
    const vFade = varying(float(0), 'vFxFade');
    const vRing = varying(float(0), 'vFxRing');
    const vSeed = varying(float(0), 'vFxSeed');
    const vAlpha = varying(float(0), 'vFxAlpha');
    const vGrain = varying(float(0), 'vFxGrain');
    const vSub = varying(vec3(0), 'vFxSub');   // uv window center, then its half-width in uv units

    const mat = new THREE.NodeMaterial();
    // Quads lie in xz to face the straight-down camera. A dead or unborn slot collapses to zero scale,
    // so it costs four degenerate vertices and no fragments instead of a per-frame CPU sweep.
    mat.positionNode = Fn(() => {
      const o = attribute('aOrigin', 'vec4');
      const m = attribute('aMotion', 'vec4');
      const look = attribute('aLook', 'vec4');
      const style = attribute('aStyle', 'vec4');
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
      if (this.pebbles) {
        vGrain.assign(step(float(2.5), style.x));
        // The window is the sand the grain came out of, offset per instance so no two chips repeat,
        // and half a pebble wide in uv so its texels are the floor's texels.
        vSub.assign(vec3(o.x.mul(this.uSubUV).add(style.z), o.z.mul(this.uSubUV).add(style.w), look.w.mul(this.uSubUV)));
      }
      // Rings vanish all at once, like real bubbles; only blobs get the slow fade.
      const softEnv = smoothstep(0.0, 0.15, f).mul(f.oneMinus());
      const holdEnv = smoothstep(0.0, 0.1, f).mul(smoothstep(0.82, 1.0, f).oneMinus());
      vFade.assign(mix(softEnv, holdEnv, hold));
      const tp = t.max(0);
      const grav = gr.x;
      // A landed grain sits: the ballistic solve for the touchdown time freezes its horizontal travel,
      // or it slides on under the height it was given. Gravity 0 pushes the settle time out of range.
      const settle = m.y.add(m.y.mul(m.y).add(grav.mul(o.y.sub(gr.y)).mul(2)).max(0).sqrt()).div(grav.max(1e-4))
        .add(step(grav, float(1e-6)).mul(1e9));
      const th = tp.min(settle);
      const c = o.xyz.add(m.xyz.mul(vec3(th, tp, th)));
      // Gravity and the per-instance landing height live here so a grain flies, lands, and sits with
      // no CPU work; every other kind carries gravity 0 and a landing height far below the pond.
      const y = c.y.sub(grav.mul(tp).mul(tp).mul(0.5)).max(gr.y);
      const sway = sin(th.mul(5).add(o.x.mul(7))).mul(0.012);
      const half = look.w.mul(live).mul(gr.z.mul(f).add(1));
      const q = positionGeometry.xy;
      return vec3(c.x.add(sway).add(q.x.mul(half)), y, c.z.add(q.y.mul(half)));
    })();
    mat.fragmentNode = Fn(() => {
      const q = uv().sub(0.5).mul(2);
      const r = length(q);
      // Two angular waves with per-instance phase, so no two bubbles shimmy alike.
      const th = atan(q.y, q.x.add(step(r, float(1e-5)).mul(1e-3)));
      const wob = sin(th.mul(3).add(this.uTime.mul(6)).add(vSeed)).mul(0.035)
        .add(sin(th.mul(5).sub(this.uTime.mul(8.3)).add(vSeed.mul(1.7))).mul(0.02));
      // Rings ripple, pebbles go lumpy, and silt keeps its perfect circle; no instance is ever two of those.
      const rw = this.pebbles
        ? r.mul(wob.mul(vRing.add(vGrain.mul(uGrainWob))).add(1))
        : r.mul(wob.mul(vRing).add(1));
      const blob = max(0, rw.oneMinus()).pow(1.5);
      const ring = smoothstep(0.68, 0.82, rw).mul(smoothstep(0.88, 0.96, rw).oneMinus()).mul(0.85)
        .add(smoothstep(0.0, 0.18, rw).oneMinus().mul(0.18));
      const shape = mix(blob, ring, vRing).mul(vFade);
      if (!this.premultiplied) return vec4(vTint.mul(shape), 0);
      // Premultiplied: sediment has to occlude, and copying the additive vec4(rgb, 0) would make it
      // glow instead. The alpha factors below still leave underRT's depth channel alone.
      if (!this.pebbles) {
        const a = shape.mul(vAlpha).clamp(0, 1);
        return vec4(vTint.mul(a), a);
      }
      // A grain is a chip of the floor, not a puff of it: a hard opaque rim, a window of the sand map,
      // and a fake dome run through the floor's own shade(), caustics and cover shadow included.
      const dome = normalize(vec3(q.x.mul(uGrainDome.x), uGrainDome.y, q.y.mul(uGrainDome.x)));
      const chip = this.subTex.sample(vSub.xy.add(q.mul(vSub.z))).rgb.mul(this.uSubGain);
      const pebble = this.shading.shade(mix(vTint, chip, this.uSubOn), dome, positionWorld, float(0.85));
      const a = mix(shape, smoothstep(uGrainEdge.y, uGrainEdge.x, rw).oneMinus().mul(vFade), vGrain).mul(vAlpha).clamp(0, 1);
      return vec4(mix(vTint, pebble, vGrain).mul(a), a);
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

  /* Occupancy, so an idle trickle can stand aside for a dig-in burst instead of evicting one. */
  live() {
    let n = 0;
    for (let i = 0; i < this.pool; i++) if (this.dieAt[i] > this.time) n++;
    return n;
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
    const s = i * 4;
    this.style[s] = p.style; this.style[s + 1] = this.rand() * 6.28;
    // Only a pebble reads a uv window, so only a pebble spends the two draws that pick one.
    if (kindId === 1) { this.style[s + 2] = this.rand(); this.style[s + 3] = this.rand(); }
    this.grain[o] = p.gravity ?? 0;
    this.grain[o + 1] = opts?.landY ?? NO_LANDING;
    this.grain[o + 2] = p.grow ?? 0;
    this.grain[o + 3] = opts?.opacity ?? p.opacity ?? 1;
    this.dieAt[i] = this.time + life;
    this.aOrigin.needsUpdate = this.aMotion.needsUpdate = this.aLook.needsUpdate = this.aStyle.needsUpdate = this.aGrain.needsUpdate = true;
    return i;
  }

  /* The floor's sand albedo and its world-to-uv scale, once buildFloor has them. Without this call
     the grains keep their flat spawn tint, which is what a pond with no texture manifest gets. */
  setSubstrate(tex, uvScale) {
    if (!this.pebbles || !tex || !(uvScale > 0)) return false;
    this.subTex.value = tex;
    this.uSubUV.value = uvScale;
    this.uSubOn.value = 1;
    return true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.blank.dispose();
  }
}
