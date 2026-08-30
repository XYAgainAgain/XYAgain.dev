import * as THREE from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, positionLocal, varying, normalize, refract, reflect, length, dFdx, dFdy, min, max, texture, uv, mix } from 'three/tsl';
import { CAUSTIC_RES, CAUSTIC_MARGIN, DEPTH, IOR_WATER } from './config.js';
import { makeSwell } from './shading.js';

/* Differential-area caustics after Evan Wallace's MIT webgl-water: each grid vertex lands where its
   refracted moon ray hits the floor, brightness = flat area / wavy area, additive so folds sum.
   The second pass reflects instead, onto a plane above the water, for light dancing on rock tops. */
export class CausticsPass {
  constructor(renderer, sim, U, viewW, viewH) {
    this.renderer = renderer;
    this.sim = sim;
    this.U = U;

    const mkRT = (res) => {
      const rt = new THREE.RenderTarget(res, res, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      return rt;
    };
    this.mkRT = mkRT;
    this.res = CAUSTIC_RES;
    this.rt = mkRT(CAUSTIC_RES);
    this.rtRefl = mkRT(CAUSTIC_RES >> 1);
    // Exponential history of the refracted caustics: ripple dispersion speckle averages out instead of racing.
    this.accA = mkRT(CAUSTIC_RES);
    this.accB = mkRT(CAUSTIC_RES);
    this.uBlend = uniform(0.14);
    this.freshTex = texture(this.rt.texture);
    const freshTex = this.freshTex;
    this.accRead = texture(this.accA.texture);
    const accMat = new THREE.NodeMaterial();
    accMat.fragmentNode = Fn(() => {
      const c = uv();
      return vec4(mix(this.accRead.sample(c).r, freshTex.sample(c).r, this.uBlend), 0, 0, 1);
    })();
    this.accQuad = new THREE.QuadMesh(accMat);
    // Replace the placeholder nodes outright: a TextureNode decides RT-specific handling when built.
    U.causticTex = texture(this.accB.texture);
    U.reflCausticTex = texture(this.rtRefl.texture);
    U.reflCausticTexel = uniform(1 / (CAUSTIC_RES >> 1));   // shading's refl filter taps; rung 6 halves the target
    const swell = makeSwell(U);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.set(0, 5, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);
    U.causticCenter.value.set(0, 0);

    // Unit grids, scaled to the domain in setView; the reflected pass gets by with a quarter of the vertices.
    const geo = new THREE.PlaneGeometry(1, 1, 220, 220);
    geo.rotateX(-Math.PI / 2);
    const geoRefl = new THREE.PlaneGeometry(1, 1, 110, 110);
    geoRefl.rotateX(-Math.PI / 2);

    const uExtent = uniform(sim.extent);
    // Derived, not captured: one sim texel in world units, the run under the height taps' rise
    // (slope = rise/run), so it must track the grid when rung 6 coarsens it.
    const uTexelW = uExtent.mul(sim.uTexel);
    const texel = sim.uTexel;   // follows sim.setResolution, so the wide taps stay three sim texels apart
    const uDepth = uniform(DEPTH);
    const eta = float(1 / IOR_WATER);
    this.uSlope = uniform(5.0);        // sim ripple slope gain (artistic: ripples here are small)
    this.uSwellSlope = uniform(1.9);
    this.uReflHeight = uniform(0.35);  // plane above the water that catches the bounced light

    // Surface height and normal at a grid point: sim ripples plus the spectral swell.
    const surfaceAt = Fn(([p]) => {
      const c = p.xz.div(uExtent).add(0.5);
      const read = sim.read;
      const h = read.sample(c).r;
      // Wide spacing filters the short dispersion ripples whose caustics sprint across the floor.
      const t2 = texel.mul(3);
      const hL = read.sample(c.sub(vec2(t2, 0))).r;
      const hR = read.sample(c.add(vec2(t2, 0))).r;
      const hD = read.sample(c.sub(vec2(0, t2))).r;
      const hU = read.sample(c.add(vec2(0, t2))).r;
      const sw = swell(p.xz, U.time);
      const scale = uTexelW.mul(6);
      const n = normalize(vec3(
        hL.sub(hR).mul(this.uSlope).sub(sw.y.mul(scale).mul(this.uSwellSlope)),
        scale,
        hD.sub(hU).mul(this.uSlope).sub(sw.z.mul(scale).mul(this.uSwellSlope)),
      ));
      return vec4(n, h.add(sw.x));
    });

    const dbg = new URLSearchParams(location.search).get('shade');
    const buildMaterial = (reflected) => {
      const vOld = varying(vec2(0), reflected ? 'vOldR' : 'vOld');
      const vNew = varying(vec2(0), reflected ? 'vNewR' : 'vNew');
      const mat = new THREE.NodeMaterial();
      mat.positionNode = Fn(() => {
        const p = positionLocal;
        const sn = surfaceAt(p);
        const n = sn.xyz, h = sn.w;
        const I = U.moonDir.negate();
        let flat, ray, target;
        if (!reflected) {
          flat = refract(I, vec3(0, 1, 0), eta);
          ray = refract(I, n, eta).toVar();
          ray.y = min(ray.y, float(-0.05));
          target = uDepth.negate();
        } else {
          flat = reflect(I, vec3(0, 1, 0));
          ray = reflect(I, n).toVar();
          ray.y = max(ray.y, float(0.05));
          target = this.uReflHeight;
        }
        const oldPos = p.add(flat.mul(target.div(flat.y)));
        const start = vec3(p.x, h, p.z);
        const newPos = start.add(ray.mul(target.sub(h).div(ray.y)));
        vOld.assign(oldPos.xz);
        vNew.assign(newPos.xz);
        return vec3(newPos.x, 0, newPos.z);
      })();
      mat.fragmentNode = Fn(() => {
        if (dbg === 'cdiff') return vec4(length(vNew.sub(vOld)).mul(20), 0, 0, 1);
        const oldArea = length(dFdx(vOld)).mul(length(dFdy(vOld)));
        const newArea = length(dFdx(vNew)).mul(length(dFdy(vNew)));
        const ratio = oldArea.div(max(newArea, float(1e-5)));
        return vec4(min(ratio, float(6)), 0, 0, 1);
      })();
      mat.blending = THREE.AdditiveBlending;
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
      mat.transparent = true;
      return mat;
    };

    this.mesh = new THREE.Mesh(geo, buildMaterial(false));
    this.meshRefl = new THREE.Mesh(geoRefl, buildMaterial(true));
    this.setView(viewW, viewH);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.meshRefl.frustumCulled = false;
    this.sceneRefl = new THREE.Scene();
    this.sceneRefl.add(this.meshRefl);
  }

  /* Quality ladder rung 6: one reallocation at the transition, never per frame. The accumulation
     history starts from black and refills within a few frames, which is cheaper than resampling it. */
  setResolution(res) {
    if (res === this.res || !(res > 0)) return;
    this.rt.dispose(); this.rtRefl.dispose(); this.accA.dispose(); this.accB.dispose();
    this.res = res;
    this.rt = this.mkRT(res);
    this.rtRefl = this.mkRT(res >> 1);
    this.accA = this.mkRT(res);
    this.accB = this.mkRT(res);
    this.freshTex.value = this.rt.texture;
    this.accRead.value = this.accA.texture;
    this.U.causticTex.value = this.accA.texture;
    this.U.reflCausticTex.value = this.rtRefl.texture;
    this.U.reflCausticTexel.value = 1 / (res >> 1);
  }

  /* Domain = visible floor plus margin; the grid covers more, since rays arrive from outside it. */
  setView(viewW, viewH) {
    const size = Math.max(viewW, viewH) * CAUSTIC_MARGIN;
    this.U.causticSize.value.set(size, size);
    this.camera.left = -size / 2; this.camera.right = size / 2; this.camera.top = size / 2; this.camera.bottom = -size / 2;
    this.camera.updateProjectionMatrix();
    this.mesh.scale.set(size * 1.5, 1, size * 1.5);
    this.meshRefl.scale.set(size * 1.5, 1, size * 1.5);
  }

  render() {
    const r = this.renderer;
    const prevClear = r.getClearColor(this.prevClear ??= new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(this.rt);
    r.clearColor();   // no depth attachment on these targets, so only the color clear is valid
    r.render(this.scene, this.camera);
    r.setRenderTarget(this.rtRefl);
    r.clearColor();
    r.render(this.sceneRefl, this.camera);
    r.setRenderTarget(this.accB);
    this.accQuad.render(r);
    const t = this.accA; this.accA = this.accB; this.accB = t;
    this.accRead.value = this.accA.texture;
    this.U.causticTex.value = this.accA.texture;
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
  }

  dispose() {
    this.rt.dispose(); this.rtRefl.dispose(); this.accA.dispose(); this.accB.dispose(); this.accQuad.material.dispose();
    this.mesh.geometry.dispose(); this.meshRefl.geometry.dispose();
    this.mesh.material.dispose(); this.meshRefl.material.dispose();
  }
}
