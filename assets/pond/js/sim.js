import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, int, max, min, cos, atan, fract, length, smoothstep, mix, PI, Loop, uniformArray, step } from 'three/tsl';
import { SIM_RES, SIM_STEPS_HZ, SIM_DAMPING, SIM_WAVE, COVER_DISCS, COVER_CAPS } from './config.js';

const MAXD = 24, MAXC = 4;   // waterline walls the obstacle mask can hold
const PROF_N = 32, PROF_FLOATS = (PROF_N + 1) * 2;   // floaters.js's bark waterline profile: LOG_PROFILE_N stations, two sides
const RIM_N = 64, RIM_FLOATS = RIM_N + 1;              // a stone's lumpy waterline, floaters.js's RIM_N stations around it

/* Heightfield wave sim after Evan Wallace's MIT webgl-water: R = height, G = velocity.
   Ping-pong render targets so the same TSL runs on WebGPU and WebGL2. */
export class WaterSim {
  constructor(renderer, extent) {
    this.renderer = renderer;
    this.extent = extent;
    this.res = SIM_RES;
    this.texelWorld = extent / SIM_RES;
    this.accumulator = 0;
    this.damping = SIM_DAMPING;

    this.rtA = this.mkState();
    this.rtB = this.mkState();
    this.read = texture(this.rtA.texture);

    // A uniform, not a const: the quality ladder changes the resolution, and a const would force a
    // material rebuild. Surface and caustics read it too, so their taps follow the same grid.
    this.uTexel = uniform(1 / SIM_RES);
    const texel = this.uTexel;
    this.uDamping = uniform(SIM_DAMPING);
    this.uWave = uniform(SIM_WAVE);

    // Obstacle mask (R = 1 where something solid crosses the waterline), baked once from the colliders.
    this.maskRT = this.mkMask();
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

  mkState(res = this.res) {
    const rt = new THREE.RenderTarget(res, res, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  }

  mkMask(res = this.res) {
    return new THREE.RenderTarget(res, res, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
  }

  /* Quality ladder rung 6. World wave speed goes as texel × sqrt(gain), so the gain scales by
     (res / SIM_RES)² or a smaller grid would visibly race; 0.039 at 384 is far under the 0.5 limit. */
  setResolution(res) {
    if (res === this.res || !(res > 0)) return;
    const newA = this.mkState(res), newB = this.mkState(res), newMask = this.mkMask(res);
    if (!this.copyQuad) {
      const m = new THREE.NodeMaterial();
      m.fragmentNode = Fn(() => this.read.sample(uv()))();
      this.copyQuad = new THREE.QuadMesh(m);
    }
    const prev = this.renderer.getRenderTarget();
    // Carry the live water across instead of restarting from flat: the pond would visibly stop dead.
    this.renderer.setRenderTarget(newA);
    this.copyQuad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
    const oldA = this.rtA, oldB = this.rtB, oldMask = this.maskRT;
    this.rtA = newA; this.rtB = newB; this.maskRT = newMask;
    this.read.value = newA.texture;
    this.mask.value = newMask.texture;
    oldA.dispose(); oldB.dispose(); oldMask.dispose();
    this.res = res;
    this.texelWorld = this.extent / res;
    this.uTexel.value = 1 / res;
    this.uWave.value = SIM_WAVE * (res / SIM_RES) ** 2;
    if (this.bake) this.bake.uEdge.value = this.texelWorld * 1.5;
    this.bakeMask();
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

  /* The bark's real waterline per capsule (floaters.js builds it): B is the tight solid the mats and the
     pollen hug, while R keeps the wider crest envelope the waves bounce off. */
  setWaterlineProfiles(profiles, rims = null) {
    this.profiles = profiles;
    this.rims = rims;
    this.bakeMask();
  }

  /* One persistent material bakes every channel from stored inputs: a rebake never reallocates. */
  bakeMask() {
    if (!this.bake) {
      const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4());
      const uDiscs = uniformArray(v4(MAXD)), uCaps = uniformArray(v4(MAXC * 2));
      // Per capsule: the trunk axis (a, u), then (len, hasProfile, bore chord), then 33 stations × 2 sides of half-widths.
      const uProfA = uniformArray(v4(MAXC)), uProfB = uniformArray(v4(MAXC));
      const uProfW = uniformArray(new Array(MAXC * PROF_FLOATS).fill(0));
      // Per disc: a stone's waterline radius around it; uDiscs.w says whether the disc has one.
      const uRimW = uniformArray(new Array(MAXD * RIM_FLOATS).fill(0));
      const uCovD = uniformArray(v4(COVER_DISCS)), uCovC = uniformArray(v4(COVER_CAPS * 2));
      const uExtent = uniform(this.extent);
      // A hard step bakes stair-steps into the wall, and every wave that bounces off it shows them;
      // a 1.5-texel smoothstep skirt plus linear filtering gives the sim an antialiased shoreline.
      const uEdge = uniform(this.texelWorld * 1.5);
      const mat = new THREE.NodeMaterial();
      mat.fragmentNode = Fn(() => {
        const p = uv().sub(0.5).mul(uExtent);
        const solid = float(0).toVar();
        const tight = float(0).toVar();
        const open = float(0).toVar();   // tight, but a hollow trunk's bore is water: what the pollen hugs
        const cover = float(0).toVar();
        Loop(MAXD, ({ i }) => {
          const o = uDiscs.element(i);
          const d = p.sub(o.xy);
          const dist = length(d);
          solid.addAssign(smoothstep(o.z.sub(uEdge), o.z.add(uEdge), dist).oneMinus());
          // The tight channels take the stone's real rim at this angle when it has one, else the chord.
          const f = fract(atan(d.y, d.x).div(PI.mul(2))).mul(RIM_N);
          const i0 = f.floor();
          const base = int(i).mul(RIM_FLOATS);
          const k0 = base.add(int(i0)), k1 = base.add(int(i0.add(1).min(float(RIM_N))));
          const rim = mix(uRimW.element(k0), uRimW.element(k1), f.sub(i0));
          const rr = mix(o.z, rim, o.w);
          const tightDisc = smoothstep(rr.sub(uEdge), rr.add(uEdge), dist).oneMinus();
          tight.addAssign(tightDisc);
          open.addAssign(tightDisc);
        });
        Loop(MAXC, ({ i }) => {
          const ab = uCaps.element(i.mul(2));
          const r = uCaps.element(i.mul(2).add(1)).x;
          const a = ab.xy, b = ab.zw;
          const ba = b.sub(a);
          const t = p.sub(a).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
          const plain = smoothstep(r.sub(uEdge), r.add(uEdge), length(p.sub(a.add(ba.mul(t))))).oneMinus();
          solid.addAssign(plain);
          // The profiled trunk: the station's half-width on the fragment's side of the axis, interpolated.
          const A = uProfA.element(i), B = uProfB.element(i);
          const rel = p.sub(A.xy);
          const s = rel.dot(A.zw);
          const perp = rel.x.mul(A.w.negate()).add(rel.y.mul(A.z));
          const inSpan = step(float(0), s).mul(step(s, B.x));
          const f = s.div(B.x.max(1e-4)).clamp(0, 1).mul(PROF_N);
          const i0 = f.floor();
          const side = int(step(perp, float(0)));
          const base = int(i).mul(PROF_FLOATS);
          const k0 = base.add(int(i0).mul(2)).add(side);
          const k1 = base.add(int(i0.add(1).min(float(PROF_N))).mul(2)).add(side);
          const w0 = uProfW.element(k0), w1 = uProfW.element(k1);
          const wid = mix(w0, w1, f.sub(i0));
          const shaped = smoothstep(wid.sub(uEdge), wid.add(uEdge), perp.abs()).oneMinus().mul(inSpan);
          tight.addAssign(mix(plain, shaped, B.y));
          open.addAssign(mix(plain, shaped.mul(smoothstep(B.z.sub(uEdge), B.z.add(uEdge), perp.abs())), B.y));
        });
        Loop(COVER_DISCS, ({ i }) => {
          const o = uCovD.element(i);
          cover.addAssign(smoothstep(o.z.sub(uEdge), o.z.add(uEdge), length(p.sub(o.xy))).oneMinus().mul(o.w));
        });
        Loop(COVER_CAPS, ({ i }) => {
          const ab = uCovC.element(i.mul(2));
          const rs = uCovC.element(i.mul(2).add(1));
          const a = ab.xy, b = ab.zw;
          const ba = b.sub(a);
          const t = p.sub(a).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
          cover.addAssign(smoothstep(rs.x.sub(uEdge), rs.x.add(uEdge), length(p.sub(a.add(ba.mul(t))))).oneMinus().mul(rs.y));
        });
        return vec4(solid.min(1), cover.min(1), tight.min(1), open.min(1));
      })();
      this.bake = { quad: new THREE.QuadMesh(mat), uDiscs, uCaps, uCovD, uCovC, uEdge, uProfA, uProfB, uProfW, uRimW };
    }
    const { quad, uDiscs, uCaps, uCovD, uCovC, uProfA, uProfB, uProfW, uRimW } = this.bake;
    const { discs, capsules } = this.obstacles;
    // Empty wall slots get a negative radius: a zero radius still baked a skirt-sized wall at the pool center.
    for (let i = 0; i < MAXD; i++) {
      const o = discs[i], rim = this.rims?.[i];
      uDiscs.array[i].set(o?.x ?? 0, o?.z ?? 0, o?.r ?? -1, rim ? 1 : 0);
      if (rim) for (let k = 0; k < RIM_FLOATS; k++) uRimW.array[i * RIM_FLOATS + k] = rim[k] ?? 0;
    }
    for (let i = 0; i < MAXC; i++) {
      const o = capsules[i];
      uCaps.array[i * 2].set(o?.ax ?? 0, o?.az ?? 0, o?.bx ?? 0, o?.bz ?? 0);
      uCaps.array[i * 2 + 1].set(o?.r ?? -1, 0, 0, 0);
    }
    for (let i = 0; i < MAXC; i++) {
      const pr = this.profiles?.[i];
      if (!pr) { uProfB.array[i].set(0, 0, 0, 0); continue; }
      uProfA.array[i].set(pr.ax, pr.az, pr.ux, pr.uz);
      uProfB.array[i].set(pr.len, 1, pr.bore ?? 0, 0);
      for (let k = 0; k < PROF_FLOATS; k++) uProfW.array[i * PROF_FLOATS + k] = pr.w[k] ?? 0;
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
      this.uRadius.value = Math.max(d.r, 3.5 / this.res);
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
    this.copyQuad?.material.dispose();
    this.bake?.quad.material.dispose();
  }
}
