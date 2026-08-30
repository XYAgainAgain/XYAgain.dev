import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, length, pow, Loop, smoothstep } from 'three/tsl';
import { WAKE_RES, INF_SLOTS } from './config.js';
import { capsuleInfluence, closestOnSegment, fbm2 } from './shading.js';
import { createRng, deriveSeed } from './rng.js';

const TAU = 1.2;    // seconds for a wake to fade to 1/e
const GAIN = 3.0;   // push accumulated per second at full capsule strength: a passing body saturates in ~0.3 s
const FINGER_TAU = 7.0;   // the parted line closes slowly enough to write a short word and watch it reform

/* Short-term memory of who swam where. R, G: signed push, accumulated and clamped so crossing wakes cancel.
   B: the algae cover field. A: the finger alone on its own slower clock, so only a hand parts the duckweed. */
export class WakeBuffer {
  constructor(renderer, U, extent, seed) {
    this.renderer = renderer;
    this.extent = extent;
    const mk = () => {
      const rt = new THREE.RenderTarget(WAKE_RES, WAKE_RES, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      return rt;
    };
    this.rtA = mk();
    this.rtB = mk();
    this.read = texture(this.rtA.texture);
    this.uExtent = uniform(extent);
    this.uDecay = uniform(1);
    this.uGain = uniform(0);
    this.uFingerDecay = uniform(1);
    // The tear is a fingertip, not the pad-shoving capsule: its own radii, far narrower than uPokeV.z.
    this.uFingerR = uniform(new THREE.Vector2(0.04, 0.17));
    // A finger through the water: capsule (ax, az, bx, bz) and (vx, vz, radius, strength), one frame at a time.
    this.uPoke = uniform(new THREE.Vector4(0, 0, 0, 0));
    this.uPokeV = uniform(new THREE.Vector4(0, 0, 0.15, 0));

    // Algae seed: the same FBM the floor will read, offset by the pond seed so a fresh tab has history.
    const rng = createRng(deriveSeed(seed, 1800));
    this.uAlgaeOffset = uniform(new THREE.Vector2(rng.range(0, 100), rng.range(0, 100)));
    this.uAlgaeScale = uniform(0.35);
    const seedMat = new THREE.NodeMaterial();
    seedMat.fragmentNode = Fn(() => {
      const p = uv().sub(0.5).mul(this.uExtent);
      const cover = smoothstep(0.42, 0.72, fbm2(p.mul(this.uAlgaeScale).add(this.uAlgaeOffset)));
      return vec4(0, 0, cover, 0);
    })();
    seedMat.blending = THREE.NoBlending;
    const seedQuad = new THREE.QuadMesh(seedMat);
    for (const rt of [this.rtA, this.rtB]) { renderer.setRenderTarget(rt); seedQuad.render(renderer); }
    renderer.setRenderTarget(null);
    seedMat.dispose();

    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = Fn(() => {
      const c = uv();
      // Same mapping as the sim's obstacle bake: v runs with +z.
      const p = c.sub(0.5).mul(this.uExtent);
      const prev = this.read.sample(c);
      const cur = vec2(0).toVar();
      Loop(INF_SLOTS, ({ i }) => {
        const a = U.infA.element(i), b = U.infB.element(i), v = U.infC.element(i);
        // Evaluated at the surface (y = 0): a deep eel is far from it and writes a faint wake on its own.
        cur.addAssign(capsuleInfluence(vec3(p.x, 0, p.y), a, b, v).mul(b.w));
      });
      const pk = this.uPoke, pv = this.uPokeV;
      const a = vec4(pk.x, 0, pk.y, pv.z), b = vec4(pk.z, 0, pk.w, pv.w);
      cur.addAssign(capsuleInfluence(vec3(p.x, 0, p.y), a, b, vec4(pv.x, 0, pv.y, 0)).mul(pv.w));
      const next = prev.xy.mul(this.uDecay).add(cur.mul(this.uGain)).toVar();
      // Clamp the magnitude, never the components, or diagonal wakes get squared off.
      next.divAssign(length(next).max(1));
      const p3 = vec3(p.x, 0, p.y);
      const fd = length(p3.sub(closestOnSegment(p3, a.xyz, b.xyz)));
      // Latched, not accumulated: a finger crosses a texel in a single frame, so a rate-based gain
      // would never reach the tear threshold at any sane drag speed.
      const fw = smoothstep(this.uFingerR.y, this.uFingerR.x, fd).mul(pv.w.min(1));
      const finger = prev.w.mul(this.uFingerDecay).max(fw);
      return vec4(next, prev.z, finger);
    })();
    mat.blending = THREE.NoBlending;
    this.quad = new THREE.QuadMesh(mat);

    /* Consumer decode: direction × pow(magnitude, k). Shaping on the magnitude only; a fractional
       power of a signed component is a NaN generator. Each layer picks its own k. */
    this.wakeAt = Fn(([xz, k]) => {
      const m = this.read.sample(xz.div(this.uExtent).add(0.5)).xy;
      const len = length(m);
      return m.div(len.max(1e-5)).mul(pow(len, k));
    });

    this.fingerAt = Fn(([xz]) => this.read.sample(xz.div(this.uExtent).add(0.5)).w);
  }

  swap() {
    const t = this.rtA; this.rtA = this.rtB; this.rtB = t;
    this.read.value = this.rtA.texture;
  }

  /* Pointer wake for this frame only: a capsule from the last pushed point to the current one, with
     the pointer's velocity so the shove trails the finger the way an eel's wake trails the eel. */
  poke(ax, az, bx, bz, vx, vz, radius = 0.15, strength = 1) {
    this.uPoke.value.set(ax, az, bx, bz);
    this.uPokeV.value.set(vx, vz, radius, strength);
  }

  /* Once per rendered frame, after the influence slots are written and before anything samples it. */
  update(dt) {
    // CPU-computed so the shader never holds an all-literal exp() (Naga rejects those on Firefox).
    this.uDecay.value = Math.exp(-dt / TAU);
    this.uGain.value = dt * GAIN;
    this.uFingerDecay.value = Math.exp(-dt / FINGER_TAU);
    const r = this.renderer;
    r.setRenderTarget(this.rtB);
    this.quad.render(r);
    this.swap();
    r.setRenderTarget(null);
    this.uPokeV.value.w = 0;
  }

  get texture() { return this.rtA.texture; }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.quad.material.dispose();
  }
}
