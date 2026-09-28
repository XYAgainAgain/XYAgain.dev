import * as THREE from 'three/webgpu';
import { Fn, uniform, uv, vec2, vec3, vec4, float, floor, fract, mix } from 'three/tsl';
import { hash3 } from './firmament.js';
import { NEB_PERIOD, NEB_OCTAVES, NEB_RES } from './void-sky-core.js';

/* Value noise on a lattice that wraps every `cells`, the doubly periodic twin of shading.js's valueNoise2:
   the same smoothstep fade and bilinear blend, hashed with pcg3d so the seed is a whole axis of its own. */
const valueNoise2P = Fn(([p, cells, seed]) => {
  const i = floor(p).toVar();
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const i0 = i.sub(floor(i.div(cells)).mul(cells)).toVar();
  const i1 = i.add(1).sub(floor(i.add(1).div(cells)).mul(cells)).toVar();
  const a = hash3(vec3(i0.x, i0.y, seed)).x;
  const b = hash3(vec3(i1.x, i0.y, seed)).x;
  const c = hash3(vec3(i0.x, i1.y, seed)).x;
  const d = hash3(vec3(i1.x, i1.y, seed)).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/* The nebula's three octaves for one tile, stored raw (R, G, B) so every dial past the noise still runs
   after the fetch, and rung 6's two octaves are the same texture read with the third ignored. */
function makeBakeMaterial(uSeed, uWarp) {
  const m = new THREE.NodeMaterial();
  m.fragmentNode = Fn(() => {
    const q = uv().mul(NEB_PERIOD).toVar();
    const out = [];
    let prev = null;
    for (let k = 0; k < NEB_OCTAVES.length; k++) {
      const o = NEB_OCTAVES[k];
      // Each octave is warped by the one before it: the same iterated warp the per-pixel nebula ran.
      const lean = prev ? vec2(prev.mul(uWarp).mul(o.lean[0]), prev.mul(uWarp).mul(o.lean[1])) : vec2(0, 0);
      const at = q.mul(o.freq).add(lean).add(vec2(o.shift[0], o.shift[1]));
      // Uniform-backed so no argument reaches the function as a bare literal, which naga types abstract.
      const n = valueNoise2P(at, float(o.cells).toVar(), uSeed.add(k)).toVar();
      out.push(n);
      prev = n;
    }
    return vec4(out[0], out[1], out[2], 1);
  })();
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

/* The baked tile: HalfFloat (8-bit bands the dim cloud edges), repeat wrap, one quad render. The seed is
   the page's own; a rebake keeps it, so a dial change never swaps the nebula mid-visit. */
export class NebulaBake {
  constructor({ seed = 0, res = NEB_RES } = {}) {
    this.seed = seed;
    this.uSeed = uniform(seed);
    this.uWarp = uniform(0.9);
    this.rt = new THREE.RenderTarget(res, res, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    });
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.RepeatWrapping;
    this.texture = this.rt.texture;
    this.material = makeBakeMaterial(this.uSeed, this.uWarp);
    this.quad = new THREE.QuadMesh(this.material);
    this.baked = false;
    this.warp = NaN;
  }

  /* One render into the tile, restoring whatever target was bound. `gpu` is the WebGPURenderer. */
  bake(gpu, warp) {
    const w = Number.isFinite(warp) ? warp : 0.9;
    this.uWarp.value = w;
    const prev = gpu.getRenderTarget();
    gpu.setRenderTarget(this.rt);
    this.quad.render(gpu);
    gpu.setRenderTarget(prev);
    this.baked = true;
    this.warp = w;
  }

  dispose() { this.rt.dispose(); this.material.dispose(); }
}
