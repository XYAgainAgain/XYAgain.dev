import { Fn, vec2, vec3, vec4, float, floor, fract, dot, mix, normalize, hash, Loop, length, uniformArray, uniform, texture, refract, sin, cos, smoothstep, pow, clamp, If } from 'three/tsl';
import { createRng } from './rng.js';
import * as THREE from 'three/webgpu';
import { INF_SLOTS, IOR_WATER, MOON_COLOR } from './config.js';

/* Shared TSL helpers used by the floor, rocks, log, eels, and the compose pass. */

// TSL's hash() truncates its seed to a uint, and u32(negative) saturates to 0 on WGSL: without the offset
// every lattice cell on one side of a diagonal through the origin hashed alike and the noise went flat there.
export const hash2 = Fn(([p]) => {
  return hash(dot(p, vec2(127.1, 311.7)).add(4194304.5));
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
export const CURRENT_TERMS = 4;

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
  // mainDir doubles as the pond's wind bearing, so the swell and everything the wind pushes agree.
  return { waves, phases, mainDir };
}

/* Surface current as a sinusoidal potential: its curl is divergence-free (nothing bunches into sinks)
   and normalized to max|curl| 1. Each term is (dir.x, dir.z, k, amp) plus (phase, omega). */
export function createCurrentSet(seed) {
  const rng = createRng(seed);
  const terms = [], phases = [];
  let sumAK = 0;
  for (let i = 0; i < CURRENT_TERMS; i++) {
    const dir = rng.range(0, Math.PI * 2);
    const k = (2 * Math.PI) / rng.range(3, 9);
    const amp = rng.range(0.6, 1.0);
    terms.push({ x: Math.cos(dir), y: Math.sin(dir), z: k, w: amp });
    sumAK += amp * k;
    // Slowest term drifts a full cycle in 50–60 s; the rest a little quicker so the path never closes visibly.
    phases.push({ x: rng.range(0, Math.PI * 2), y: i === 0 ? rng.range(0.10, 0.125) : rng.range(0.13, 0.3), z: 0, w: 0 });
  }
  for (const t of terms) t.w /= sumAK;
  return { terms, phases };
}

/* Surface current at xz: the 2D curl of the potential above, |v| <= 1. Shared by every floater. */
export function makeCurrent(U) {
  return Fn(([xz, t]) => {
    const dpdx = float(0).toVar();
    const dpdz = float(0).toVar();
    Loop(CURRENT_TERMS, ({ i }) => {
      const c = U.current.element(i);
      const q = U.currentPhase.element(i);
      const arg = dot(xz, c.xy).mul(c.z).add(q.x).add(t.mul(q.y));
      const g = cos(arg).mul(c.w).mul(c.z);
      dpdx.addAssign(g.mul(c.x));
      dpdz.addAssign(g.mul(c.y));
    });
    return vec2(dpdz, dpdx.negate());
  });
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
export function createSceneUniforms(waveSet, currentSet) {
  // The creature influence field: one capsule per slot, parked below the world and strength 0 until claimed.
  const infA = [], infB = [], infC = [], eelCol = [], eelColB = [];
  for (let i = 0; i < INF_SLOTS; i++) {
    infA.push(new THREE.Vector4(0, -99, 0, 0));
    infB.push(new THREE.Vector4(0, -99, 0, 0));
    infC.push(new THREE.Vector4(0, 0, 0, 0));
    eelCol.push(new THREE.Color(0, 0, 0));
    eelColB.push(new THREE.Color(0, 0, 0));
  }
  const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  placeholder.needsUpdate = true;
  return {
    moonDir: uniform(new THREE.Vector3(0, 1, 0)),     // toward the moon, above water
    moonColor: uniform(new THREE.Color(...MOON_COLOR)),
    moonStrength: uniform(0.20),
    time: uniform(0),
    causticTex: texture(placeholder),                   // replaced by the caustics pass before any material builds
    causticCenter: uniform(new THREE.Vector2()),
    causticSize: uniform(new THREE.Vector2(1, 1)),
    infA: uniformArray(infA),                           // (ax, ay, az, radius)
    infB: uniformArray(infB),                           // (bx, by, bz, strength)
    infC: uniformArray(infC),                           // (vx, vy, vz, excite), velocity in world units/s
    eelCol: uniformArray(eelCol),                       // glow color at the capsule's head end
    eelColB: uniformArray(eelColB),                     // glow color at the tail end; mixed along the axis
    eelGlow: uniform(2.4),
    swell: uniform(1.0),
    waves: uniformArray(waveSet.waves.map((w) => new THREE.Vector4(w.x, w.y, w.z, w.w))),
    wavePhase: uniformArray(waveSet.phases.map((p) => new THREE.Vector4(p.x, p.y, p.z, p.w))),
    reflCausticTex: texture(placeholder),
    current: uniformArray(currentSet.terms.map((c) => new THREE.Vector4(c.x, c.y, c.z, c.w))),
    currentPhase: uniformArray(currentSet.phases.map((p) => new THREE.Vector4(p.x, p.y, p.z, p.w))),
    wind: uniform(new THREE.Vector4(1, 0, 0, 0)),         // (bearing.x, bearing.z, gust, gust lagged for the reeds)
    moonPhase: uniform(0),                                // 0–1 around the orbit; the pond's night clock
    motionScale: uniform(1),                              // 1, or 0.1 under reduced motion: scales plant-owned idle motion
    // Surface cover (mask G) and the live sim, swapped in by main.js before any material builds.
    coverTex: texture(placeholder),
    simTex: texture(placeholder),
    maskExtent: uniform(1),
    coverStrength: uniform(0),                            // 0 until something floats: the floor's shadow fetches are gated on it
    coverWobble: uniform(0.08),                           // ripple nudge on the shadow's entry point; a rung-4 switch
    // The wake buffer's read node and extent, swapped in by main.js; the floor reads algae cover from B.
    wakeTex: texture(placeholder),
    wakeExtent: uniform(1),
    rainEnv: uniform(0),                                  // rain.envelope, republished each frame; 0 when dry
    wetAir: uniform(0),                                   // how wet the dry rock tops and bark look: soaks in seconds, dries over a minute
    // Algae cover look. Cooler than the pads' yellow-green and the duckweed's olive, so the three read apart.
    algaeColThin: uniform(new THREE.Vector3(0.12, 0.34, 0.22)),
    algaeColDense: uniform(new THREE.Vector3(0.05, 0.18, 0.11)),
    algaeGain: uniform(1),                                // master strength; 0 kills the tint for comparison shots
    algaeLift: uniform(0.11),                             // the floor's moon is 0.2; a tint alone vanishes, so cover carries its own faint light
    algaeDetail: uniform(1),                              // rung-4 switch for the high-frequency octave and the filament grain
    // Domain warp on the cover fetch: the field's texel grid is what reads as pixelated, so bend the
    // lookup instead of paying for a finer field. World units, and the noise scale that drives them.
    algaeWarp: uniform(0.45),
    algaeWarpScale: uniform(2.6),
    algaeRough: uniform(0.35),                            // algae is slimy, so smoother than the sand it covers
  };
}

/* Closest point on segment ab to p, the same clamp-the-projection math sim.js runs in 2D for its
   obstacle capsules. The max() keeps a degenerate capsule (a == b) from dividing by zero. */
export const closestOnSegment = Fn(([p, a, b]) => {
  const ba = b.sub(a);
  const t = p.sub(a).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
  return a.add(ba.mul(t));
});

/* The scalar half of the wake falloff: full inside the body's skin, zero 0.9 units out. Lift, push,
   and the CPU twin below all read this one curve so they can never drift apart. */
export const capsuleWeight = Fn(([p, a, b]) => {
  const d = length(p.sub(closestOnSegment(p, a.xyz, b.xyz)));
  return smoothstep(a.w.add(0.9), a.w.add(0.05), d);
});

/* Wake push at p from one influence slot, for anything creatures shove around (lily pads first).
   Falloff scales the WHOLE push, not just velocity, or the shove reaches the whole pond as a press. */
export const capsuleInfluence = Fn(([p, a, b, vel]) => {
  const closest = closestOnSegment(p, a.xyz, b.xyz);
  const away = p.sub(closest);
  const d = length(away);
  const w = capsuleWeight(p, a, b);
  const radial = away.div(d.max(1e-5));   // safe normalize: dead on the axis, d is 0
  return radial.xz.add(vel.xz.mul(0.6)).mul(w);
});

/* CPU twin of capsuleWeight for the few things the CPU decides (pad drips, settle plops): the CPU may
   never read the GPU, so it re-runs the same curve against the same uniform arrays. */
export function capsuleWeightCPU(U, px, py, pz, slot) {
  const a = U.infA.array[slot], b = U.infB.array[slot];
  if (b.w <= 0) return 0;
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const len2 = Math.max(1e-6, bax * bax + bay * bay + baz * baz);
  const t = Math.max(0, Math.min(1, ((px - a.x) * bax + (py - a.y) * bay + (pz - a.z) * baz) / len2));
  const dx = px - (a.x + bax * t), dy = py - (a.y + bay * t), dz = pz - (a.z + baz * t);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const e0 = a.w + 0.9, e1 = a.w + 0.05;
  const s = Math.max(0, Math.min(1, (d - e0) / (e1 - e0)));
  return s * s * (3 - 2 * s);
}

/* CPU twin of capsuleInfluence: the horizontal push at a point from one slot, written into out {x, z}.
   Returns the weight so callers get both from one closest-point solve (stalk bumps, drips). */
export function capsuleInfluenceCPU(U, px, py, pz, slot, out) {
  out.x = 0; out.z = 0;
  const a = U.infA.array[slot], b = U.infB.array[slot];
  if (b.w <= 0) return 0;
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const len2 = Math.max(1e-6, bax * bax + bay * bay + baz * baz);
  const t = Math.max(0, Math.min(1, ((px - a.x) * bax + (py - a.y) * bay + (pz - a.z) * baz) / len2));
  const dx = px - (a.x + bax * t), dy = py - (a.y + bay * t), dz = pz - (a.z + baz * t);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const e0 = a.w + 0.9, e1 = a.w + 0.05;
  const s = Math.max(0, Math.min(1, (d - e0) / (e1 - e0)));
  const w = s * s * (3 - 2 * s);
  if (w <= 0) return 0;
  const v = U.infC.array[slot], inv = 1 / Math.max(1e-5, d);
  out.x = (dx * inv + v.x * 0.6) * w;
  out.z = (dz * inv + v.z * 0.6) * w;
  return w;
}

/* Builds the underwater shading Fn bound to one set of scene uniforms. */
export function makeUnderwaterShading(U) {
  // Moon direction as seen from under the surface: refracted, pointing up toward the light.
  const lightDir = Fn(() => {
    const eta = float(1 / IOR_WATER);
    const refr = refract(U.moonDir.negate(), vec3(0, 1, 0), eta);
    return normalize(refr).negate();
  });

  // One slot's neon at p, measured to the skin, not the axis; the sand and the pads both read this
  // one formula so they can never disagree. The mid hump refunds what an RGB lerp loses between hues.
  const eelSlotGlow = Fn(([p, i]) => {
    const a = U.infA.element(i), b = U.infB.element(i);
    const ba = b.xyz.sub(a.xyz);
    const t = p.sub(a.xyz).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
    const d = length(p.sub(a.xyz.add(ba.mul(t)))).sub(a.w.mul(1.5)).max(0);
    const col = mix(U.eelCol.element(i), U.eelColB.element(i), t).mul(t.mul(t.oneMinus()).mul(0.5).add(1));
    const shimmer = sin(t.mul(5).sub(U.time.mul(1.57)).add(float(i).mul(2.7))).mul(0.22).add(1);
    return col.mul(shimmer).mul(b.w).mul(U.eelGlow.mul(0.42).div(d.mul(d).mul(3.5).add(1)));
  });

  // Unwrapped neon fill summed over every slot: what a pad's underside or a fish's flank receives.
  const eelGlowAt = Fn(([p]) => {
    const glow = vec3(0).toVar();
    Loop(INF_SLOTS, ({ i }) => { glow.addAssign(eelSlotGlow(p, i)); });
    return glow;
  });

  // Lambert + soft spec under moonlight; caustics add direct light, eel neon adds fill.
  // Constants live in uniforms: an all-literal WGSL expression is an abstract type, and Firefox's Naga
  // rejects the whole module when one reaches runtime math (Chrome silently materializes f32).
  const kSpecLo = uniform(24), kSpecHi = uniform(140), kAmbient = uniform(0.004);
  // Shadow wobble stencil: two sim texels either side of the entry point, in mask uv; sim heights are
  // a few hundredths of a unit, so the gain turns them into a visible fraction-of-a-unit crawl.
  const kWobbleGain = uniform(40);
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
      const o = U.reflCausticTexel.mul(1.5);   // 1.5 texels of the live refl target (rung 6 halves it)
      const reflRatio = U.reflCausticTex.sample(causticUV.add(vec2(o, o))).r
        .add(U.reflCausticTex.sample(causticUV.add(vec2(o.negate(), o))).r)
        .add(U.reflCausticTex.sample(causticUV.add(vec2(o, o.negate()))).r)
        .add(U.reflCausticTex.sample(causticUV.sub(vec2(o, o))).r).mul(0.25);
      const reflCaustic = pow(smoothstep(0.7, 3.0, reflRatio), 1.0).mul(1.6).add(clamp(reflRatio, 0.0, 1.2).mul(0.3));
      const faceWater = n.y.negate().add(1).clamp(0, 1).mul(0.6).add(0.2);
      direct.assign(ndlAir.mul(2.9).add(reflCaustic.mul(faceWater).mul(2.5)).add(0.2));
    });
    // Rain-wet stone and bark: darker and far glossier, only above the waterline (underwater is always wet).
    const wet = U.wetAir.mul(smoothstep(-0.02, 0.02, p.y));
    roughness.assign(mix(roughness, roughness.mul(0.4), wet));
    const alb = albedo.mul(wet.mul(-0.28).add(1));
    // Surface cover shadow (pads, later mats and stems): the floor point is lit by a ray that crossed
    // the surface up-moon of it, so the mask is read at that entry point, not overhead. Two height
    // taps along the azimuth make the shadow crawl with the ripples. Nothing floating can shade a
    // point above the water, and the eel glow below is never attenuated: the eels are under the pad.
    const cover = float(0).toVar();
    // Branch on the uniform alone: sampling inside per-fragment control flow is a WGSL uniformity error.
    If(U.coverStrength.greaterThan(0), () => {
      const entry = p.xz.add(L.xz.mul(p.y.negate().div(L.y.max(1e-3)))).toVar();
      const azim = L.xz.div(length(L.xz).max(1e-4));
      const c = entry.div(U.maskExtent).add(0.5);
      // U.simTexel is sim.uTexel (assigned in main beside simTex), so the stencil follows rung 6.
      const step2 = azim.mul(U.simTexel.mul(2));
      const dh = U.simTex.sample(c.add(step2)).r.sub(U.simTex.sample(c.sub(step2)).r);
      entry.addAssign(azim.mul(dh.mul(U.coverWobble).mul(kWobbleGain)));
      const g = U.coverTex.sample(entry.div(U.maskExtent).add(0.5)).g;
      cover.assign(g.mul(U.coverStrength).mul(smoothstep(0.02, -0.02, p.y)));
    });
    direct.mulAssign(cover.oneMinus());
    direct.mulAssign(U.moonStrength);
    const ambient = kAmbient;
    const V = vec3(0, 1, 0);
    const H = normalize(L.add(V));
    const specPow = mix(kSpecHi, kSpecLo, roughness);
    const spec = dot(n, H).max(0).pow(specPow).mul(roughness.oneMinus()).mul(caustic.mul(0.5).add(0.3)).mul(0.25).mul(cover.oneMinus()).mul(wet.mul(2).add(1));
    // Wrapped Lambert over the normal map so gravel facets face or shade the glow; the roughness-
    // driven highlight puts a neon glint on wet stones.
    const glow = vec3(0).toVar();
    const glowSpec = vec3(0).toVar();
    Loop(INF_SLOTS, ({ i }) => {
      const a = U.infA.element(i), b = U.infB.element(i);
      const ba = b.xyz.sub(a.xyz);
      const t = p.sub(a.xyz).dot(ba).div(ba.dot(ba).max(1e-6)).clamp(0, 1);
      const away = a.xyz.add(ba.mul(t)).sub(p);
      const Le = away.div(length(away).max(1e-4));
      const cNow = eelSlotGlow(p, i);
      // The wrap keeps crevices dim rather than black under a soft nearby glow.
      glow.addAssign(cNow.mul(dot(n, Le).add(0.35).div(1.35).clamp(0, 1)));
      const He = normalize(Le.add(V));
      glowSpec.addAssign(cNow.mul(dot(n, He).max(0).pow(specPow)).mul(roughness.oneMinus()).mul(1.2));
    });
    const dbg = new URLSearchParams(location.search).get('shade');
    if (dbg === 'n') return n.mul(0.5).add(0.5);
    if (dbg === 'l') return L.mul(0.5).add(0.5);
    if (dbg === 'ndl') return vec3(ndl);
    if (dbg === 'caustic') return vec3(caustic.mul(0.5));
    if (dbg === 'albedo') return albedo;
    if (dbg === 'cover') return vec3(cover);
    return alb.mul(U.moonColor.mul(direct.add(ambient)))
      .add(U.moonColor.mul(spec))
      .add(alb.mul(glow).mul(0.9))
      .add(glow.mul(0.05))
      .add(glowSpec);
  });

  // U rides along so materials built from `shading` alone (the floor's) can reach the scene uniforms.
  return { shade, lightDir, eelGlowAt, U };
}
