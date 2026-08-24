import * as THREE from 'three/webgpu';
import { Fn, If, uniform, texture, uv, vec2, vec3, vec4, float, normalize, refract, reflect, dot, mix, smoothstep, exp, min, length, pow, step } from 'three/tsl';
import { DEPTH, IOR_WATER } from './config.js';
import { fbm2, valueNoise2, makeSwell } from './shading.js';

/* Final compose: refracts the underwater RT through the live surface, adds a soft cloudy sky
   and moon in the reflection, and absorbs color with path length. Straight-down camera. */
export class SurfacePass {
  constructor(renderer, sim, U, underRT, viewW, viewH) {
    this.renderer = renderer;
    this.uView = uniform(new THREE.Vector2(viewW, viewH));
    this.uExtent = uniform(sim.extent);
    this.uTexelW = uniform(sim.texelWorld);
    this.uSlosh = uniform(1.0);
    this.uExposure = uniform(1.0);
    this.uSlope = uniform(1.8);
    this.uSkyGain = uniform(0.03);
    this.uMaxOffset = uniform(0.2);   // world units; keeps steep ripples from flinging pixels around
    this.uReveal = uniform(0.0);     // 0 = dim gate state, 1 = full
    this.uRainNoise = uniform(0.0);  // shower envelope × 0.35; 0 when dry, and always 0 in reduced motion
    const texel = float(1 / sim.rtA.width);
    const under = texture(underRT.texture);
    const eta = float(1 / IOR_WATER);
    const uDepth = uniform(DEPTH);
    const swell = makeSwell(U);

    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = Fn(() => {
      // QuadMesh uv is top-origin (v = 0 at the top edge), and camera top is -z.
      const suv = uv();
      const x = suv.x.sub(0.5).mul(this.uView.x);
      const z = suv.y.sub(0.5).mul(this.uView.y);
      const xz = vec2(x, z);
      const c = xz.div(this.uExtent).add(0.5);
      const read = sim.read;
      const h = read.sample(c).r;
      // Two-texel spacing: the per-texel dispersion noise is what made eels shimmer under ripples.
      const t2 = texel.mul(2);
      const hL = read.sample(c.sub(vec2(t2, 0))).r;
      const hR = read.sample(c.add(vec2(t2, 0))).r;
      const hD = read.sample(c.sub(vec2(0, t2))).r;
      const hU = read.sample(c.add(vec2(0, t2))).r;
      const slope = vec2(hL.sub(hR), hD.sub(hU)).mul(0.5);
      // Spectral swell layered on the simulated ripples; uSlosh scales it for reduced-motion.
      const t = U.time;
      const sw = swell(xz, t);
      const scale = this.uTexelW.mul(2);
      // A shower's 3 cm rings never survive a 512 sim, so its fine texture lives here: three octaves
      // of animated value noise, decorrelated per axis, folded into the slope exactly like the swell.
      const rn = this.uRainNoise;
      const rx = float(0).toVar(), rz = float(0).toVar();
      // Branching on a uniform is coherent across the whole quad, so a dry pond pays nothing at all.
      If(rn.greaterThan(0), () => {
        // Scroll directions are coprime integer pairs (3,-2), (-5,7), (11,-4): no shared factor, so
        // the octaves never fall into step and streak along one diagonal.
        const rp = xz.mul(8.0).add(vec2(t.mul(3 * 0.23), t.mul(-2 * 0.23)));
        const rq = xz.mul(22.0).add(vec2(t.mul(-5 * 0.148), t.mul(7 * 0.148)));
        const rr = xz.mul(44.0).add(vec2(t.mul(11 * 0.157), t.mul(-4 * 0.157)));
        const gain = rn.mul(scale).mul(1.1);
        rx.assign(valueNoise2(rp).sub(0.5).add(valueNoise2(rq).sub(0.5).mul(0.6)).add(valueNoise2(rr).sub(0.5).mul(0.45)).mul(gain));
        rz.assign(valueNoise2(rp.add(vec2(37.2, 11.7))).sub(0.5).add(valueNoise2(rq.add(vec2(5.9, 23.4))).sub(0.5).mul(0.6)).add(valueNoise2(rr.add(vec2(17.3, 3.1))).sub(0.5).mul(0.45)).mul(gain));
      });
      const sx = slope.x.mul(this.uSlope).sub(sw.y.mul(scale).mul(this.uSlosh));
      const sz = slope.y.mul(this.uSlope).sub(sw.z.mul(scale).mul(this.uSlosh));
      const n = normalize(vec3(sx.add(rx), scale, sz.add(rz)));
      // Reflection sees the rain barely: full-noise normals smear the moon's halo into a broad glare
      // band across the whole pond, and that band moves with the clock, not the seed.
      const nR = normalize(vec3(sx.add(rx.mul(0.2)), scale, sz.add(rz.mul(0.2))));

      const I = vec3(0, -1, 0);
      const R = refract(I, n, eta).toVar();
      R.y = min(R.y, float(-0.2));
      // One depth tap under the pixel decides the path length; refining at the hit point made eels
      // shimmer wherever the ripple pushed the sample across their edge every frame.
      const depthFrac0 = under.sample(suv).a;
      const dist0 = depthFrac0.mul(uDepth).add(h).add(sw.x).max(0.02);
      const offset = R.xz.mul(dist0.div(R.y.negate())).toVar();
      const offLen = length(offset);
      offset.mulAssign(min(offLen, this.uMaxOffset).div(offLen.max(1e-5)));
      const hit = xz.add(offset);
      const hitUV = vec2(hit.x.div(this.uView.x).add(0.5), hit.y.div(this.uView.y).add(0.5));
      const sample = under.sample(hitUV);
      const dist = dist0;
      // Water is crystal clear, so absorption is faint, but red still dies first.
      const absorb = exp(vec3(0.22, 0.11, 0.06).negate().mul(dist));
      const below = sample.rgb.mul(absorb);

      const Rr = reflect(I, nR);
      const moon = U.moonDir;
      const cosM = dot(Rr, moon).max(0);
      // Straight down, the mirror direction sits ~38 deg off the moon, so the glow must be broad to read at all.
      const disc = smoothstep(0.9975, 0.9995, cosM).mul(4.0);
      const halo = pow(cosM, 400).mul(2.0).add(pow(cosM, 60).mul(0.7)).add(pow(cosM, 6).mul(0.35)).add(pow(cosM, 2).mul(0.08));
      const cloud = fbm2(Rr.xz.mul(3).add(vec2(t.mul(0.01), 0))).mul(0.02).add(0.01);
      const sky = U.moonColor.mul(disc.add(halo).add(cloud));
      // F0 sits above the physical 0.02 on purpose: from straight above, the reflected sky is how ripples read.
      const F0 = float(0.035);
      const fresnel = F0.add(F0.oneMinus().mul(dot(nR, vec3(0, 1, 0)).max(0).oneMinus().pow(5)));
      const water = mix(below, sky, fresnel.clamp(0, 0.6)).add(sky.mul(this.uSkyGain));
      // depthFrac 0 means the pixel is above the waterline (a rock top): no refraction, no sky film.
      const color = mix(water, sample.rgb, step(depthFrac0, float(0.001))).toVar();
      const vig = length(suv.sub(0.5)).mul(1.25).pow(2.2).oneMinus().clamp(0.25, 1);
      color.mulAssign(vig.mul(this.uExposure));
      color.mulAssign(mix(0.45, 1.0, this.uReveal));
      return vec4(color, 1);
    })();
    this.quad = new THREE.QuadMesh(mat);
  }

  setView(w, h) { this.uView.value.set(w, h); }

  render() {
    this.renderer.setRenderTarget(null);
    this.quad.render(this.renderer);
  }

  dispose() { this.quad.material.dispose(); }
}
