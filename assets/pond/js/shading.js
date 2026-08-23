import { Fn, vec2, vec3, vec4, float, floor, fract, dot, mix, normalize, hash, Loop, length, uniformArray, uniform, texture, refract, sin, cos, smoothstep, pow, clamp, If } from 'three/tsl';
import { createRng } from './rng.js';
import * as THREE from 'three/webgpu';
import { EEL_COUNT, IOR_WATER, MOON_COLOR } from './config.js';

/* Shared TSL helpers used by the floor, rocks, log, eels, and the compose pass. */

export const hash2 = Fn(([p]) => {
  return hash(dot(p, vec2(127.1, 311.7)).add(0.5));
});

export const valueNoise2 = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash2(i);
  const b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1)));
  const d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

export const fbm2 = Fn(([p]) => {
  const v = float(0).toVar();
  const amp = float(0.5).toVar();
  const q = p.toVar();
  Loop(4, () => {
    v.addAssign(valueNoise2(q).mul(amp));
    q.mulAssign(2.03);
    amp.mulAssign(0.5);
  });
  return v;
});

export const WAVE_COUNT = 12;

/* A small directional spectrum in the spirit of a JONSWAP sea, scaled to a pond: a dominant swell
   direction with spread, energy falling off toward short wavelengths. Each wave: (dir.x, dir.z, k, amp). */
export function createWaveSet(seed) {
  const rng = createRng(seed);
  const mainDir = rng.range(0, Math.PI * 2);
  // Each load gets its own sea state: a bit longer or choppier, calmer or livelier, slower or quicker.
  const longest = 2.4 * rng.range(0.8, 1.25);
  const energy = rng.range(0.8, 1.2);
  const tempo = 0.37 * rng.range(0.85, 1.15);
  const spreadWidth = rng.range(0.25, 0.5);
  const waves = [], phases = [];
  for (let i = 0; i < WAVE_COUNT; i++) {
    const f = i / (WAVE_COUNT - 1);
    const wavelength = longest * Math.pow(0.22, f) * rng.range(0.85, 1.15);
    const k = (2 * Math.PI) / wavelength;
    const spread = (rng.next() - 0.5) * Math.PI * (spreadWidth + f * 0.9);
    const dir = mainDir + spread;
    const amp = 0.011 * energy * Math.pow(wavelength / 2.4, 1.35) * rng.range(0.7, 1.2);
    waves.push({ x: Math.cos(dir), y: Math.sin(dir), z: k, w: amp });
    // Deep-water dispersion, scaled so phase speed lands where shorter waves still read as a slow swell.
    // z, w: a slow breathing rate and phase per wave, so the idle pattern never loops visibly.
    phases.push({ x: rng.range(0, Math.PI * 2), y: Math.sqrt(9.81 * k) * tempo, z: rng.range(0.04, 0.16), w: rng.range(0, Math.PI * 2) });
  }
  return { waves, phases };
}

/* Height and slope of the swell at xz: returns (h, dh/dx, dh/dz). Shared by caustics and the surface. */
export function makeSwell(U) {
  return Fn(([xz, t]) => {
    const h = float(0).toVar();
    const sx = float(0).toVar();
    const sz = float(0).toVar();
    Loop(WAVE_COUNT, ({ i }) => {
      const w = U.waves.element(i);
      const ph = U.wavePhase.element(i);
      const arg = dot(xz, w.xy).mul(w.z).sub(t.mul(ph.y)).add(ph.x);
      // Per-wave breathing plus a slow tide-like swing of the whole field, so depth visibly comes and goes.
      const breathe = sin(t.mul(ph.z).add(ph.w)).mul(0.5).add(0.65).mul(sin(t.mul(0.045)).mul(0.35).add(0.85));
      const a = w.w.mul(U.swell).mul(breathe);
      h.addAssign(sin(arg).mul(a));
      const d = cos(arg).mul(a).mul(w.z);
      sx.addAssign(d.mul(w.x));
      sz.addAssign(d.mul(w.y));
    });
    return vec3(h, sx, sz);
  });
}

/* Scene-wide uniforms every underwater material reads. Created once, closed over by the shading Fns. */
export function createSceneUniforms(waveSet) {
  const eelPos = [];
  const eelCol = [];
  for (let i = 0; i < EEL_COUNT; i++) { eelPos.push(new THREE.Vector3(0, -99, 0)); eelCol.push(new THREE.Color(0, 0, 0)); }
  const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  placeholder.needsUpdate = true;
  return {
    moonDir: uniform(new THREE.Vector3(0, 1, 0)),     // toward the moon, above water
    moonColor: uniform(new THREE.Color(...MOON_COLOR)),
    moonStrength: uniform(0.15),
    time: uniform(0),
    causticTex: texture(placeholder),                   // replaced by the caustics pass before any material builds
    causticCenter: uniform(new THREE.Vector2()),
    causticSize: uniform(new THREE.Vector2(1, 1)),
    eelPos: uniformArray(eelPos),
    eelCol: uniformArray(eelCol),
    eelGlow: uniform(2.4),
    swell: uniform(1.0),
    waves: uniformArray(waveSet.waves.map((w) => new THREE.Vector4(w.x, w.y, w.z, w.w))),
    wavePhase: uniformArray(waveSet.phases.map((p) => new THREE.Vector4(p.x, p.y, p.z, p.w))),
    reflCausticTex: texture(placeholder),
  };
}

/* Builds the underwater shading Fn bound to one set of scene uniforms. */
export function makeUnderwaterShading(U) {
  // Moon direction as seen from under the surface: refracted, pointing up toward the light.
  const lightDir = Fn(() => {
    const eta = float(1 / IOR_WATER);
    const refr = refract(U.moonDir.negate(), vec3(0, 1, 0), eta);
    return normalize(refr).negate();
  });

  const eelGlowAt = Fn(([p]) => {
    const glow = vec3(0).toVar();
    Loop(EEL_COUNT, ({ i }) => {
      const d = length(p.sub(U.eelPos.element(i)));
      glow.addAssign(U.eelCol.element(i).mul(U.eelGlow.mul(0.55).div(d.mul(d).mul(3.5).add(1))));
    });
    return glow;
  });

  // Lambert + soft spec under moonlight; caustics add direct light, eel neon adds fill.
  // Constants live in uniforms: an all-literal WGSL expression is an abstract type, and Firefox's Naga
  // rejects the whole module when one reaches runtime math (Chrome silently materializes f32).
  const kSpecLo = uniform(24), kSpecHi = uniform(140), kAmbient = uniform(0.004);
  const shade = Fn(([albedo, n, p, roughnessIn]) => {
    const roughness = float(roughnessIn).toVar();
    const L = lightDir();
    const ndl = dot(n, L).max(0);
    // Render-target v is top-origin and the caustic camera's top edge is -z, so v follows +z directly.
    const cd = p.xz.sub(U.causticCenter).div(U.causticSize);
    const causticUV = vec2(cd.x, cd.y).add(0.5);
    const ratio = U.causticTex.sample(causticUV).r;
    // Shape the area ratio so focus lines read as lines (curve from the MIT abyssal-ocean), keep a soft base.
    const caustic = pow(smoothstep(0.95, 2.4, ratio), 1.2).mul(3.2).add(clamp(ratio, 0.0, 1.2).mul(0.4));
    const direct = ndl.mul(caustic.add(0.08)).toVar();
    // Above the waterline: direct moon plus light bouncing off the rippling surface onto the object.
    If(p.y.greaterThan(0.0), () => {
      const ndlAir = dot(n, U.moonDir).max(0);
      const o = float(1.5 / 512);
      const reflRatio = U.reflCausticTex.sample(causticUV.add(vec2(o, o))).r
        .add(U.reflCausticTex.sample(causticUV.add(vec2(o.negate(), o))).r)
        .add(U.reflCausticTex.sample(causticUV.add(vec2(o, o.negate()))).r)
        .add(U.reflCausticTex.sample(causticUV.sub(vec2(o, o))).r).mul(0.25);
      const reflCaustic = pow(smoothstep(0.7, 3.0, reflRatio), 1.0).mul(1.6).add(clamp(reflRatio, 0.0, 1.2).mul(0.3));
      const faceWater = n.y.negate().add(1).clamp(0, 1).mul(0.6).add(0.2);
      direct.assign(ndlAir.mul(2.2).add(reflCaustic.mul(faceWater).mul(2.5)).add(0.2));
    });
    direct.mulAssign(U.moonStrength);
    const ambient = kAmbient;
    const V = vec3(0, 1, 0);
    const H = normalize(L.add(V));
    const specPow = mix(kSpecHi, kSpecLo, roughness);
    const spec = dot(n, H).max(0).pow(specPow).mul(roughness.oneMinus()).mul(caustic.mul(0.5).add(0.3)).mul(0.25);
    const glow = eelGlowAt(p);
    const dbg = new URLSearchParams(location.search).get('shade');
    if (dbg === 'n') return n.mul(0.5).add(0.5);
    if (dbg === 'l') return L.mul(0.5).add(0.5);
    if (dbg === 'ndl') return vec3(ndl);
    if (dbg === 'caustic') return vec3(caustic.mul(0.5));
    if (dbg === 'albedo') return albedo;
    return albedo.mul(U.moonColor.mul(direct.add(ambient)))
      .add(U.moonColor.mul(spec))
      .add(albedo.mul(glow).mul(0.9))
      .add(glow.mul(0.05));
  });

  return { shade, lightDir, eelGlowAt };
}
