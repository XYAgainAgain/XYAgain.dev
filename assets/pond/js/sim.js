import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, max, min, cos, length, smoothstep, mix, PI, Loop, uniformArray, step } from 'three/tsl';
import { SIM_RES, SIM_STEPS_HZ, SIM_DAMPING, SIM_WAVE } from './config.js';

/* Heightfield wave sim after Evan Wallace's MIT webgl-water: R = height, G = velocity.
   Ping-pong render targets so the same TSL runs on WebGPU and WebGL2. */
export class WaterSim {
  constructor(renderer, extent) {
    this.renderer = renderer;
    this.extent = extent;
    this.texelWorld = extent / SIM_RES;
    this.accumulator = 0;
    this.damping = SIM_DAMPING;

    const mk = () => {
      const rt = new THREE.RenderTarget(SIM_RES, SIM_RES, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      return rt;
    };
    this.rtA = mk();
    this.rtB = mk();
    this.read = texture(this.rtA.texture);

    const texel = float(1 / SIM_RES);
    this.uDamping = uniform(SIM_DAMPING);
    this.uWave = uniform(SIM_WAVE);

    // Obstacle mask (R = 1 where something solid crosses the waterline), baked once from the colliders.
    this.maskRT = new THREE.RenderTarget(SIM_RES, SIM_RES, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this.mask = texture(this.maskRT.texture);
    this.maskDirty = false;

    const stepMat = new THREE.NodeMaterial();
    stepMat.fragmentNode = Fn(() => {
      const c = uv();
      const info = this.read.sample(c);
      const here = this.mask.sample(c).r;
      // Neighbors inside an obstacle mirror the center value: a zero-gradient wall, so waves bounce.
      const tap = (o) => {
        const m = this.mask.sample(c.add(o)).r;
        return mix(this.read.sample(c.add(o)).r, info.r, m);
      };
      const hL = tap(vec2(texel.negate(), 0));
      const hR = tap(vec2(texel, 0));
      const hD = tap(vec2(0, texel.negate()));
      const hU = tap(vec2(0, texel));
      const lap = hL.add(hR).add(hD).add(hU).sub(info.r.mul(4));
      const vel = info.g.add(lap.mul(this.uWave)).mul(this.uDamping).toVar();
      // Sponge ring: kill waves near the pool edge so they never reflect off an invisible wall.
      const edge = min(min(c.x, c.x.oneMinus()), min(c.y, c.y.oneMinus()));
      vel.mulAssign(mix(0.90, 1.0, smoothstep(0.0, 0.08, edge)));
      const solid = here.oneMinus();
      return vec4(info.r.add(vel).mul(solid), vel.mul(solid), 0, 1);
    })();
    this.stepQuad = new THREE.QuadMesh(stepMat);

    this.uCenter = uniform(new THREE.Vector2());
    this.uRadius = uniform(0.01);
    this.uStrength = uniform(0.01);
    const dropMat = new THREE.NodeMaterial();
    dropMat.fragmentNode = Fn(() => {
      const c = uv();
      const info = this.read.sample(c);
      const d = length(c.sub(this.uCenter)).div(this.uRadius);
      const drop = max(0, d.oneMinus()).toVar();
      drop.assign(cos(drop.mul(PI)).mul(-0.5).add(0.5));
      return vec4(info.r.add(drop.mul(this.uStrength)), info.g, 0, 1);
    })();
    this.dropQuad = new THREE.QuadMesh(dropMat);

    this.pending = [];
  }

  /* Bakes waterline footprints (xz + radius, or capsule a→b + radius) into the obstacle mask. */
  setObstacles(discs, capsules) {
    const MAXD = 24, MAXC = 4;
    const d = [], cp = [];
    for (let i = 0; i < MAXD; i++) { const o = discs[i]; d.push(new THREE.Vector4(o?.x ?? 0, o?.z ?? 0, o?.r ?? 0, 0)); }
    for (let i = 0; i < MAXC; i++) { const o = capsules[i]; cp.push(new THREE.Vector4(o?.ax ?? 0, o?.az ?? 0, o?.bx ?? 0, o?.bz ?? 0)); cp.push(new THREE.Vector4(o?.r ?? 0, 0, 0, 0)); }
    const uDiscs = uniformArray(d), uCaps = uniformArray(cp);
    const uExtent = uniform(this.extent);
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = Fn(() => {
      const p = uv().sub(0.5).mul(uExtent);
      const solid = float(0).toVar();
      Loop(MAXD, ({ i }) => {
        const o = uDiscs.element(i);
        solid.addAssign(step(length(p.sub(o.xy)), o.z));
      });
      Loop(MAXC, ({ i }) => {
        const ab = uCaps.element(i.mul(2));
        const r = uCaps.element(i.mul(2).add(1)).x;
        const a = ab.xy, b = ab.zw;
        const ba = b.sub(a);
        const t = p.sub(a).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
        solid.addAssign(step(length(p.sub(a.add(ba.mul(t)))), r));
      });
      return vec4(solid.min(1), 0, 0, 1);
    })();
    const quad = new THREE.QuadMesh(mat);
    this.renderer.setRenderTarget(this.maskRT);
    quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
    mat.dispose();
  }

  /* World xz → sim uv. */
  toUV(x, z) {
    return [x / this.extent + 0.5, z / this.extent + 0.5];
  }

  /* radius and strength in world units; queued until the next step. */
  addDrop(x, z, radius, strength) {
    const [u, v] = this.toUV(x, z);
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    this.pending.push({ u, v, r: radius / this.extent, s: strength });
  }

  swap() {
    const t = this.rtA; this.rtA = this.rtB; this.rtB = t;
    this.read.value = this.rtA.texture;
  }

  renderPass(quad) {
    this.renderer.setRenderTarget(this.rtB);
    quad.render(this.renderer);
    this.swap();
  }

  update(dt) {
    const r = this.renderer;
    // At most a few splats per frame; the rest wait a frame rather than stacking passes.
    const n = Math.min(this.pending.length, 4);
    for (let i = 0; i < n; i++) {
      const d = this.pending[i];
      this.uCenter.value.set(d.u, d.v);
      this.uRadius.value = Math.max(d.r, 3.5 / SIM_RES);
      this.uStrength.value = d.s;
      this.renderPass(this.dropQuad);
    }
    this.pending.splice(0, n);

    const stepDt = 1 / SIM_STEPS_HZ;
    // A late frame gets at most two catch-up steps; anything older is dropped so recovery frames stay cheap.
    this.accumulator = Math.min(this.accumulator + dt, stepDt * 2.99);
    let steps = 0;
    while (this.accumulator >= stepDt) {
      this.renderPass(this.stepQuad);
      this.accumulator -= stepDt;
      steps++;
    }
    r.setRenderTarget(null);
    return steps;
  }

  get texture() { return this.rtA.texture; }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose(); this.maskRT.dispose();
    this.stepQuad.material.dispose(); this.dropQuad.material.dispose();
  }
}
