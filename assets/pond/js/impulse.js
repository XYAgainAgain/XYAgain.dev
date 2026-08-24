import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, uv, vec4, float, cos, length, max, PI, positionGeometry, varying } from 'three/tsl';
import { SIM_RES } from './config.js';

export const MAX_IMPULSES = 64;       // one instanced draw per sim step, hard cap
export const MICRO_RADIUS = 2.5;      // default bump radius in sim texels; callers may size per drop

const PROBE_A = 0.25, PROBE_B = 0.5, PROBE_SUM = 0.75, PROBE_TOL = 0.01;

/* WebGL2 hands half-float readbacks back as raw uint16; decode so the numbers mean something. */
export function halfToFloat(u) {
  const sgn = u >> 15 ? -1 : 1, ex = (u >> 10) & 0x1f, m = u & 0x3ff;
  if (ex === 0) return sgn * m * 2 ** -24;
  if (ex === 31) return m ? NaN : sgn * Infinity;
  return sgn * (1 + m / 1024) * 2 ** (ex - 15);
}

/* ONE/ONE on every channel: additive without a color write mask, and alpha undisturbed. */
function setAdditive(mat) {
  mat.transparent = true;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  mat.depthTest = false;
  mat.depthWrite = false;
}

/* RGBA16F as a color attachment does not imply float *blending*, so measure it: two known values
   added into a 1×1 target must read back as their sum. Runs under both backends, costs about a ms. */
export async function probeAdditiveBlending(renderer) {
  const rt = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  const uVal = uniform(0);
  const mat = new THREE.NodeMaterial();
  mat.fragmentNode = Fn(() => vec4(uVal, 0, 0, 0))();
  setAdditive(mat);
  const quad = new THREE.QuadMesh(mat);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const restore = () => {
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
  };

  let ok = false;
  try {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    // First pass lands on a cleared target, second must accumulate onto it or there is no test.
    renderer.autoClear = true;
    uVal.value = PROBE_A; quad.render(renderer);
    renderer.autoClear = false;
    uVal.value = PROBE_B; quad.render(renderer);
    restore();
    const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 1, 1);
    const r = raw instanceof Uint16Array ? halfToFloat(raw[0]) : raw[0];
    ok = Math.abs(r - PROBE_SUM) < PROBE_TOL;
    const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    console.info(`Pond: ${backend} additive float blending ${ok ? 'ok' : 'UNAVAILABLE'} - ${PROBE_A} + ${PROBE_B} read back ${Number(r).toFixed(4)}, want ${PROBE_SUM}`);
  } catch (err) {
    console.warn('Pond: additive blend probe failed', err);
  } finally {
    restore();
    mat.dispose();
    rt.dispose();
  }
  return ok;
}

/* Thousands of tiny drops a second, drawn straight into the live sim target as one instanced pass.
   sim.addDrop caps at 4 full-screen quads a frame, which rain and strider legs would blow through. */
export class ImpulseInjector {
  constructor(renderer, sim) {
    this.renderer = renderer;
    this.sim = sim;
    this.available = false;
    this.data = new Float32Array(MAX_IMPULSES * 4);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attr = new THREE.InstancedBufferAttribute(this.data, 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDrop', this.attr);
    geo.instanceCount = 0;
    this.geometry = geo;

    const vStr = varying(float(0), 'vImpStr');
    const mat = new THREE.NodeMaterial();
    // Sim uv → clip, matching QuadMesh's own uv attribute: x = 2u−1 but y = 1−2v. Drop that flip and
    // every injected drop lands mirrored against the same u,v handed to sim.addDrop. The quad's clip
    // half-extent is radius/256: clip width 2 spans SIM_RES texels, so 512h texels = 2×radius.
    mat.vertexNode = Fn(() => {
      const d = attribute('aDrop', 'vec4');
      vStr.assign(d.z);
      const q = positionGeometry.xy.mul(d.w.div(SIM_RES / 2));
      return vec4(d.x.mul(2).sub(1).add(q.x), float(1).sub(d.y.mul(2)).add(q.y), 0, 1);
    })();
    // Same cosine bump dropQuad uses, reaching zero exactly at the sprite's own edge.
    mat.fragmentNode = Fn(() => {
      const k = max(0, length(uv().sub(0.5).mul(2)).oneMinus());
      const bump = cos(k.mul(PI)).mul(-0.5).add(0.5);
      return vec4(bump.mul(vStr), 0, 0, 0);
    })();
    setAdditive(mat);
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    // vertexNode writes clip space itself, but the renderer still wants a camera it can update;
    // the bare Camera base class lacks updateProjectionMatrix and throws on WebGPU.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  async probe() {
    this.available = await probeAdditiveBlending(this.renderer);
    return this.available;
  }

  /* drops: [{ u, v, s, r? }] in sim uv (sim.toUV converts world xz), r a bump radius in texels.
     Extras past the cap are dropped. */
  inject(drops) {
    if (!this.available || !drops || drops.length === 0) return 0;
    const n = Math.min(drops.length, MAX_IMPULSES);
    const a = this.data;
    for (let i = 0; i < n; i++) {
      const d = drops[i], o = i * 4;
      a[o] = d.u; a[o + 1] = d.v; a[o + 2] = d.s; a[o + 3] = d.r ?? MICRO_RADIUS;
    }
    this.attr.needsUpdate = true;
    this.geometry.instanceCount = n;

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    try {
      // rtA is the live pond and swap() reassigns it every step: resolve it now, and never clear it.
      r.autoClear = false;
      r.setRenderTarget(this.sim.rtA);
      r.render(this.scene, this.camera);
    } finally {
      r.autoClear = prevAutoClear;
      r.setRenderTarget(prevTarget);
    }
    return n;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
