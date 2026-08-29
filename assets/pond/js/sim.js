import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, max, min, cos, length, smoothstep, mix, PI, Loop, uniformArray, step } from 'three/tsl';
import { SIM_RES, SIM_STEPS_HZ, SIM_DAMPING, SIM_WAVE, COVER_DISCS, COVER_CAPS } from './config.js';

const MAXD = 24, MAXC = 4;   // waterline walls the obstacle mask can hold

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
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.mask = texture(this.maskRT.texture);
    this.obstacles = { discs: [], capsules: [] };
    this.cover = { discs: [], capsules: [] };
    this.bake = null;

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

  /* Waterline walls (xz + radius, or capsule a→b + radius): mask R, which the wave step bounces off. */
  setObstacles(discs, capsules) {
    this.obstacles = { discs, capsules };
    this.bakeMask();
  }

  /* Surface cover: mask G, read by the floor as moon shadow. Discs {x, z, r, strength} for pads and
     mats, capsules {ax, az, bx, bz, r, strength} for reed stems. Never a wall: R is untouched. */
  setCover(discs, capsules) {
    this.cover = { discs, capsules };
    this.bakeMask();
  }

  /* One persistent material bakes both channels from stored inputs: a rebake never reallocates. */
  bakeMask() {
    if (!this.bake) {
      const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4());
      const uDiscs = uniformArray(v4(MAXD)), uCaps = uniformArray(v4(MAXC * 2));
      const uCovD = uniformArray(v4(COVER_DISCS)), uCovC = uniformArray(v4(COVER_CAPS * 2));
      const uExtent = uniform(this.extent);
      // A hard step bakes stair-steps into the wall, and every wave that bounces off it shows them;
      // a 1.5-texel smoothstep skirt plus linear filtering gives the sim an antialiased shoreline.
      const uEdge = uniform(this.texelWorld * 1.5);
      const mat = new THREE.NodeMaterial();
      mat.fragmentNode = Fn(() => {
        const p = uv().sub(0.5).mul(uExtent);
        const solid = float(0).toVar();
        const cover = float(0).toVar();
        Loop(MAXD, ({ i }) => {
          const o = uDiscs.element(i);
          solid.addAssign(smoothstep(o.z.add(uEdge), o.z.sub(uEdge), length(p.sub(o.xy))));
        });
        Loop(MAXC, ({ i }) => {
          const ab = uCaps.element(i.mul(2));
          const r = uCaps.element(i.mul(2).add(1)).x;
          const a = ab.xy, b = ab.zw;
          const ba = b.sub(a);
          const t = p.sub(a).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
          solid.addAssign(smoothstep(r.add(uEdge), r.sub(uEdge), length(p.sub(a.add(ba.mul(t))))));
        });
        Loop(COVER_DISCS, ({ i }) => {
          const o = uCovD.element(i);
          cover.addAssign(smoothstep(o.z.add(uEdge), o.z.sub(uEdge), length(p.sub(o.xy))).mul(o.w));
        });
        Loop(COVER_CAPS, ({ i }) => {
          const ab = uCovC.element(i.mul(2));
          const rs = uCovC.element(i.mul(2).add(1));
          const a = ab.xy, b = ab.zw;
          const ba = b.sub(a);
          const t = p.sub(a).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
          cover.addAssign(smoothstep(rs.x.add(uEdge), rs.x.sub(uEdge), length(p.sub(a.add(ba.mul(t))))).mul(rs.y));
        });
        return vec4(solid.min(1), cover.min(1), 0, 1);
      })();
      this.bake = { quad: new THREE.QuadMesh(mat), uDiscs, uCaps, uCovD, uCovC };
    }
    const { quad, uDiscs, uCaps, uCovD, uCovC } = this.bake;
    const { discs, capsules } = this.obstacles;
    // Empty wall slots get a negative radius: a zero radius still baked a skirt-sized wall at the pool center.
    for (let i = 0; i < MAXD; i++) { const o = discs[i]; uDiscs.array[i].set(o?.x ?? 0, o?.z ?? 0, o?.r ?? -1, 0); }
    for (let i = 0; i < MAXC; i++) {
      const o = capsules[i];
      uCaps.array[i * 2].set(o?.ax ?? 0, o?.az ?? 0, o?.bx ?? 0, o?.bz ?? 0);
      uCaps.array[i * 2 + 1].set(o?.r ?? -1, 0, 0, 0);
    }
    const cd = this.cover.discs, cc = this.cover.capsules;
    for (let i = 0; i < COVER_DISCS; i++) { const o = cd[i]; uCovD.array[i].set(o?.x ?? 0, o?.z ?? 0, o?.r ?? 0, o?.strength ?? 0); }
    for (let i = 0; i < COVER_CAPS; i++) {
      const o = cc[i];
      uCovC.array[i * 2].set(o?.ax ?? 0, o?.az ?? 0, o?.bx ?? 0, o?.bz ?? 0);
      uCovC.array[i * 2 + 1].set(o?.r ?? 0, o?.strength ?? 0, 0, 0);
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.maskRT);
    quad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
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
    this.bake?.quad.material.dispose();
  }
}
