import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, attribute, vec2, vec3, vec4, float, int, floor, mix, normalize, cross, sin, cos, abs, fract, step, smoothstep, varying, dot, texture, TWO_PI, positionWorld, screenUV, screenSize, viewportSharedTexture, cameraViewMatrix, exp, sign, mod, fwidth, length, hue, If, Discard } from 'three/tsl';
import { EEL_COUNT, EEL_POINTS, INF_SLOTS, DEPTH } from './config.js';
import { valueNoise2, fbm2Y, hash2 } from './shading.js';
import { makeRampTexture, bakeRamp, LIT_COBALT, STAR_SILVER, STAR_GOLD } from './eel-palette.js';
import { GLITTER, GLITTER_HASH_PERIOD, GLITTER_DEEP_DRIFT, starLayout, glitterLayout, swirlAround } from './eel-stars-core.js';
import { crumbScale } from './treats-core.js';
import { floorHeightAt } from './floor.js';
import { Firmament } from './firmament.js';
import { makeVoidDials, makeVoidSet, FLARE_WRAP, SUN_WRAP } from './eel-void.js';
import { CLOUD_LIGHT, dialNum } from './eel-tail-cloud-core.js';

const RINGS = 48, SIDES = 12;
const DEG = Math.PI / 180;

/* Inigo Quilez's five-point star, signed distance from the outline. `rf` is the inner/outer radius
   ratio and arrives as a uniform: a bare literal feeding runtime math types abstract, and Naga rejects it. */
const sdStar5 = Fn(([pIn, r, rf]) => {
  const k1 = vec2(0.809016994375, -0.587785252292);
  const k2 = vec2(-0.809016994375, -0.587785252292);
  const p = vec2(abs(pIn.x), pIn.y).toVar();
  p.assign(p.sub(k1.mul(dot(k1, p).max(0).mul(2))));
  p.assign(p.sub(k2.mul(dot(k2, p).max(0).mul(2))));
  p.assign(vec2(abs(p.x), p.y.sub(r)));
  const ba = vec2(0.587785252292, 0.809016994375).mul(rf).sub(vec2(0, 1)).toVar();
  const h = dot(p, ba).div(dot(ba, ba)).max(0).min(r);
  return length(p.sub(ba.mul(h))).mul(sign(p.y.mul(ba.x).sub(p.x.mul(ba.y))));
});
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpY = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpCap = { a: new THREE.Vector3(), b: new THREE.Vector3() };
const UP = new THREE.Vector3(0, 1, 0);
const tmpPink = new THREE.Color(), tmpFlash = new THREE.Color();
// Generic smoothstep; handles reversed edges the way GLSL's does not, which blink() relies on.
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const VOID_BOUNDS = [
  ['nebLo', 0, 0.999, 0.5], ['nebHi', 0.001, 1, 0.86], ['lensBand', 0, 0.999, 0.42],
  ['starScale', 1e-3, 64, 1], ['spikeLen', 1e-3, 128, 11], ['galCells', 1e-3, 64, 5],
  ['galScale', 1e-4, 4, 0.045], ['galArmSharp', 0, 64, 1.7], ['galDiskFall', 0, 128, 2.6],
  ['galCoreFall', 0, 128, 6.5], ['ringScale', 1.001, 16, 2.5], ['holeOpen', 1e-3, 60, 0.4],
  ['holeClose', 1e-3, 60, 0.6],
];
/* TSL's hue() on the CPU: the same rotation about the grey axis, so the sand light turns with the body. */
function rotateHue(col, ang, w) {
  const cs = Math.cos(ang), sn = Math.sin(ang) * 0.57735, m = (col.r + col.g + col.b) / 3 * (1 - cs);
  const r = col.r * cs + (col.b - col.g) * sn + m, g = col.g * cs + (col.r - col.b) * sn + m, b = col.b * cs + (col.g - col.r) * sn + m;
  col.setRGB(col.r + (Math.max(0, r) - col.r) * w, col.g + (Math.max(0, g) - col.g) * w, col.b + (Math.max(0, b) - col.b) * w);
}

/* Tube geometry parameterized by (t along, angle around); the spine comes in as a uniform array. */
function makeTubeGeometry() {
  const geo = new THREE.BufferGeometry();
  const count = (RINGS + 1) * (SIDES + 1);
  const aT = new Float32Array(count), aAng = new Float32Array(count);
  let k = 0;
  for (let r = 0; r <= RINGS; r++) {
    for (let s = 0; s <= SIDES; s++) {
      aT[k] = r / RINGS;
      aAng[k] = (s / SIDES) * Math.PI * 2;
      k++;
    }
  }
  const idx = [];
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * (SIDES + 1) + s, b = a + SIDES + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aAng', new THREE.BufferAttribute(aAng, 1));
  geo.setIndex(idx);
  return geo;
}

export class EelRenderer {
  constructor(scene, U, shading, knobs) {
    this.U = U;
    this.shading = shading;
    this.knobs = knobs ?? { skin: 0.3, glow: 1.0 };   // the system owns them; pond.eels.knobs tunes live
    // The jelly dials, live via pond.eels.knobs.jelly.<dial>.value; warp/wobble are pixels.
    // halo is a CPU-side dimmer set at swap time; lamp is read live every frame in writeSlot.
    this.jellyU = {
      warp: uniform(11.0), wobble: uniform(1.5), depthEps: uniform(0.01),
      desat: uniform(0.45), tint: uniform(0.75), gain: uniform(0.95),
      rim: uniform(1.1), wash: uniform(0.4), ghost: uniform(0.2),
      lamp: { value: 0.3 }, halo: { value: 0.2 },
    };
    // Shelley's three families, live via pond.eels.knobs.families.<group>.<dial>.value. The plain
    // {value} entries move a CPU-side grid, so they land on the next applyKnobs() rather than instantly.
    this.familyU = {
      stars: {
        twinkle: uniform(0.25), fillGain: uniform(1.0), rimGain: uniform(1.8), rimFade: uniform(0.6),
        rf: uniform(0.4), scatter: uniform(1.0), forceClass: { value: -1 }, forceMetal: { value: -1 },
      },
      swirl: { drift: uniform(0.02), contrast: uniform(1.3), floor: uniform(0.5) },
      // Tiger is a look, not a formula: every constant in the tear is a live dial. forceBreak (null, or
      // 0–1) overrides the rolled break on every tiger-declaring eel and lands on the next applyKnobs().
      tiger: {
        gain: uniform(1), freqT: uniform(9), freqA: uniform(2.2), spacing: uniform(0.8),
        taper: uniform(0.6), fork: uniform(1.7), phase: uniform(3.6),
        edgeLo: uniform(0.32), edgeHi: uniform(0.68), forceBreak: { value: null },
      },
      // levelsForce under 2.5 means "use the eel's own roll"; rung 3 writes 3 here and 0 into oct2.
      splotch: {
        freqMul: uniform(1), around: uniform(0.9), edgeW: uniform(0.06),
        levelsForce: uniform(0), oct2: uniform(1), forceW: { value: null }, forceLit: { value: null },
      },
      sheen: {
        span: uniform(0.6), width: uniform(0.35), center: uniform(0.32),
        rimLo: uniform(0.15), rimHi: uniform(0.85), forceW: { value: null },
      },
      // pingPong 1 walks the ramp up and back down; 0 is the sawtooth, which snaps at the wrap.
      tailOwn: { rate: uniform(0.08), from: uniform(0.82), to: uniform(0.95), pingPong: uniform(1), force: { value: null } },
      rgb: { rate: uniform(0.78), force: { value: null } },
      // The wet look: a moonlit specular streak down every resident's back. gain 0 is the old matte body.
      // tint pulls the streak toward the eel's own chroma (0 is bare moonlight); refR is the girth sharp is tuned at.
      wet: { gain: uniform(0.3), sharp: uniform(40), tint: uniform(0.7), refR: { value: 0.1 } },
      glitter: {
        density: uniform(GLITTER.density), gain: uniform(1.0), sharp: uniform(48),
        hueWobble: uniform(0.08), deepGain: uniform(0.5), tint: uniform(0.3),
        base: { value: 0.01 }, lagGain: { value: 0.04 },
        deepScale: { value: GLITTER.deepScale }, cell: { value: GLITTER.cell },
      },
    };
    // Sam's dials, live via pond.eels.knobs.void.<dial>.value. The firmament and every void material
    // are built on his first visit, so a pond that only ever sees Eleanor pays nothing for him.
    this.voidU = makeVoidDials();
    this.firmament = null;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.geometry = makeTubeGeometry();
    this.foodGeo = new THREE.SphereGeometry(0.045, 8, 6);
    this.foodMat = new THREE.NodeMaterial();
    // Alpha carries depth below the surface for the refraction pass, same as every underwater material.
    this.foodMat.fragmentNode = Fn(() => vec4(vec3(0.9, 0.8, 0.55), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
    // A hidden-size food crumb drawn on the first frames so the real first feed never compiles a pipeline mid-click.
    this.warmFood = new THREE.Mesh(this.foodGeo, this.foodMat);
    this.warmFood.scale.setScalar(0.001); this.warmFood.position.y = -DEPTH;
    this.warmFood.frustumCulled = false;
    this.group.add(this.warmFood);
  }

  endPrewarm() { if (this.warmFood) { this.group.remove(this.warmFood); this.warmFood = null; } }

  /* Builds a lazy pipeline on one eel and shows it for the loader's warm-up render, then puts the
     bundle back. Render state only: no seeded roll, no pose, no clock. `what` is 'jelly' or 'void'. */
  prewarmLate(e, what) {
    if (!e?.body) return () => {};
    const was = { visible: e.body.visible, material: e.body.material };
    if (what === 'jelly') {
      e.matJelly ??= e._mkJelly();
      e.body.material = e.matJelly;
      if (e.jellyDepth) e.jellyDepth.visible = true;
    } else {
      e.voidSet ??= e._mkVoid();
      e.body.material = e.voidSet.body;
      e.voidSet.show(true);
      // show(true) never opens the singularity or swaps the eyes to suns; both are otherwise never
      // attached to a visible mesh, so compileAsync would skip their pipelines entirely.
      was.eyeMats = e.eyes.map((m) => m.material);
      e.eyes.forEach((m, i) => { m.material = e.voidSet.suns[i]; });
      const hole = e.voidSet.hole;
      was.hole = { horizon: hole.horizon.visible, ring: hole.ring.visible };
      hole.horizon.visible = hole.ring.visible = true;
    }
    e.body.visible = true;
    return () => {
      e.body.visible = was.visible;
      e.body.material = was.material;
      e.voidSet?.show(false);
      if (was.eyeMats) e.eyes.forEach((m, i) => { m.material = was.eyeMats[i]; });
      if (was.hole) { e.voidSet.hole.horizon.visible = was.hole.horizon; e.voidSet.hole.ring.visible = was.hole.ring; }
      this.syncBundleVisibility(e);
    };
  }

  buildMesh(e) {
    const spine = [];
    for (let i = 0; i < EEL_POINTS; i++) spine.push(e.pts[i].clone());
    e.uSpine = uniformArray(spine);
    e.uColA = uniform(e.colA.clone());
    e.uColB = uniform(e.colB.clone());
    e.uRadius = uniform(e.radius);
    e.uSquash = uniform(1);
    e.uPattern = uniform(new THREE.Vector4(e.stripeFreq, e.spotFreq, e.wavy, e.pulseRate));
    e.uWeights = uniform(new THREE.Vector3(e.wStripe, e.wSpot, e.wFlank));
    e.uSeed = uniform(e.index * 17.3 + 3.1);
    e.uExcite = uniform(0);
    e.uRoll = uniform(0);   // body roll about the long axis, wrapped into [0, 2pi) by commitPose
    // One 256 × 1 ramp per eel, allocated here and rebaked in place forever after; every mask reads
    // its color from it, so a reroll is a texture upload and some uniforms, never a new pipeline.
    e.rampTex = makeRampTexture();
    const baked = bakeRamp(e.rampTex, e.rampStops, e.rampOpts, e.rng);
    e.rampHead = baked.head; e.rampTail = baked.tail;
    e.uLayers = uniform(new THREE.Vector2(this.knobs.skin * e.skinMul, this.knobs.glow));
    e.uSkinTint = uniform(new THREE.Color(1, 1, 1));
    e.uGlowTint = uniform(new THREE.Color(1, 1, 1));
    e.uBand = uniform(new THREE.Vector2(e.wBand, e.repeats));
    e.uRace = uniform(new THREE.Vector2(e.wRace, e.raceOff));
    e.uPlaid = uniform(new THREE.Vector3(e.wPlaid, e.plaidFreq, e.wRidge));
    e.uGlowMode = uniform(e.glowMode.clone());
    // Shelley's set. uGlitter.w is an accumulated scroll position, not a rate: rewriting a rate under a
    // time multiply would jump the whole fleck field every time she changed speed.
    e.uStars = uniform(new THREE.Vector4(0, 1, 1, 0.3));      // wStars, cellsAlong, cellsAround, radius
    e.uStarsB = uniform(new THREE.Vector4(0.5, 0, 0.1, 1));   // density, starSeed, rim, twinkleRateMul
    e.uStarCol = uniform(new THREE.Color(...STAR_SILVER));
    e.uStarRim = uniform(new THREE.Color(...LIT_COBALT));
    e.uSwirl = uniform(new THREE.Vector4(0, 2.5, 2, 0));      // wSwirl, freq, cells around, seed
    e.uGlitter = uniform(new THREE.Vector4(0, 0, 30, 0));     // wGlitter, seed, facetTilt (deg), scroll
    e.uGlitterB = uniform(new THREE.Vector4(1, 1, 1, 1));     // the two fleck grids, surface then deep
    e.uGlitterCol = uniform(new THREE.Color(...STAR_SILVER));
    // Splotch, sheen, and tiger share this pack: three uniforms rather than nine. Paisley's three
    // components stay zero until its own slice lands, costing a uniform write instead of a fourth per-eel one.
    e.uFam = uniform(new THREE.Vector4(0, 0, 0, 0));        // wSplotch, wSheen, wPaisley, tigerBreak
    e.uFamB = uniform(new THREE.Vector4(0, 0, 0, 0));       // splotchFreq, splotchLevels, sheenDrift, paisleyScale
    e.uGlowModeB = uniform(new THREE.Vector4(0, 0, 0, 0));  // tailOwn, rgb, splotchLit, paisleyTiles
    e.uWet = uniform(new THREE.Vector4(1, 1, 1, 1));        // the streak's chroma, and its per-eel gain
    e.uWetSharp = uniform(1);
    e.uBury = uniform(new THREE.Vector3(-1e3, -1e3, 0));    // closed-over index, collar's far index, cut height
    this.pushFamilies(e);
    const rampNode = texture(e.rampTex);
    const U = this.U;

    const vNormal = varying(vec3(0), 'vEelN');
    const vWorld = varying(vec3(0), 'vEelP');
    const vUV = varying(vec2(0), 'vEelUV');

    // The sand the solver reads is analytic and the floor drawn is a mesh, so a buried tube grazing it
    // pokes through in flickering slivers. Closed-over rings are not drawn; the collar is cut at the sand.
    const cutBuried = () => {
      const segF = vUV.x.mul(EEL_POINTS - 1);
      If(segF.lessThan(e.uBury.x).or(segF.lessThan(e.uBury.y).and(vWorld.y.lessThan(e.uBury.z))), () => { Discard(); });
    };

    const buildPosition = (radiusScale) => Fn(() => {
      const t = attribute('aT', 'float');
      const ang = attribute('aAng', 'float');
      const segF = t.mul(EEL_POINTS - 1);
      const i0 = int(floor(segF)).min(EEL_POINTS - 2);
      const f = segF.sub(float(i0));
      const p0 = e.uSpine.element(i0);
      const p1 = e.uSpine.element(i0.add(1));
      const pos = mix(p0, p1, f);
      const tangent = normalize(p1.sub(p0).add(vec3(1e-4, 0, 0)));
      // Epsilon keeps the frame finite if a segment ever points straight up or down.
      const b = normalize(cross(tangent, vec3(0, 1, 0)).add(vec3(1e-5, 0, 1e-5)));
      const n = cross(b, tangent);
      // Body profile: blunt head, long taper; eels are a little taller than wide.
      const profile = smoothstep(0.0, 0.10, t).mul(t.oneMinus().pow(0.6)).mul(1.15);
      const r = e.uRadius.mul(profile).mul(radiusScale);
      const ca = cos(ang), sa = sin(ang);
      const offset = n.mul(ca.mul(1.0)).add(b.mul(sa.mul(e.uSquash).mul(0.8)));
      const world = pos.add(offset.mul(r));
      vNormal.assign(normalize(n.mul(ca).add(b.mul(sa))));
      vWorld.assign(world);
      vUV.assign(vec2(t, ang));
      return world;
    })();

    // Eleanor's glow is its own animal: dim wavy ridge lines running the length of the body plus a
    // pink tail photophore with a rare red flash (the pelican eel's real trick), not the pattern mix.
    // Two graphs from one builder: the halo shell skips the glitter, since a 2–3 px fleck magnified
    // 2.4× is bloom noise, not bloom.
    const emissionFor = (detail) => e.identity?.dorsalGlow ? Fn(() => {
      const t = vUV.x, ang = vUV.y;
      const time = U.time;
      const wander = sin(t.mul(7).sub(time.mul(0.2)).add(e.uSeed)).mul(0.5);
      const ridge = (mu, w, gain) => smoothstep(w, 0.0, abs(sin(ang.sub(mu).sub(wander).mul(0.5)))).mul(gain);
      const lines = ridge(0, 0.18, 1.0).add(ridge(2.4, 0.12, 0.35)).add(ridge(-2.4, 0.12, 0.35));
      const drift = sin(time.mul(0.11).add(t.mul(3)).add(e.uSeed)).mul(0.2).add(0.8);
      const tip = smoothstep(0.9, 1.0, t);
      const tipPulse = sin(time.mul(0.7).add(e.uSeed)).mul(0.18).add(0.82);
      // Double warning blink every ~4 s, the way real photophore flashes come in bursts; a charging
      // pulse rides the strips tailward each cycle so the tip's blink reads as its arrival.
      const cyc = time.mul(0.25).add(e.uSeed).fract();
      const travel = smoothstep(0.16, 0.0, abs(t.sub(cyc))).mul(1.4);
      const blink = (c) => smoothstep(0.0, 0.02, cyc.sub(c)).mul(smoothstep(0.07, 0.05, cyc.sub(c)));
      const flash = blink(0.05).add(blink(0.16)).mul(2.6);
      const body = mix(e.uColA, e.uColB, sin(t.mul(2).add(time.mul(0.05))).mul(0.5).add(0.5)).mul(lines).mul(drift.mul(0.5).add(travel));
      const tail = vec3(1.0, 0.3, 0.55).mul(tip).mul(tipPulse.mul(1.25)).add(vec3(1.0, 0.05, 0.1).mul(tip).mul(flash));
      const eyeT = smoothstep(0.0, 0.05, t).oneMinus();
      return body.add(tail).mul(e.uExcite.mul(0.8).add(1)).add(eyeT.mul(0.25));
    }) : Fn(() => {
      // Roll spins the pattern, wrapped into [0, 2pi) for the dorsal and ridge terms. At roll 0 the
      // raw attribute passes through: wrapping moves the seam vertex, and the spot noise notices.
      const rolled = vUV.y.add(e.uRoll).div(TWO_PI).fract().mul(TWO_PI);
      const t = vUV.x, ang = mix(vUV.y, rolled, step(1e-6, e.uRoll));
      const time = U.time;
      const T = this.familyU.tiger;
      const wave = sin(t.mul(e.uPattern.x).mul(TWO_PI).add(sin(ang.add(t.mul(6))).mul(e.uPattern.z)).sub(time.mul(0.6))).mul(0.5).add(0.5).toVar();
      const stripes = smoothstep(0.35, 0.65, wave).toVar();
      // Tiger: one noise fetch spent three ways, so the edges fork, the pitch stops being a metronome,
      // and the bands narrow toward the ends. The halo skips the fetch: at 2.4×, a tear is bloom noise.
      if (detail) If(e.uFam.w.mul(e.uWeights.x).greaterThan(0), () => {
        const brk = e.uFam.w.mul(T.gain);
        const tearN = valueNoise2(vec2(t.mul(T.freqT), ang.mul(T.freqA).add(e.uSeed)));
        const tear = tearN.sub(0.5).mul(brk);
        const spacing = tearN.sub(0.5).mul(T.spacing).mul(brk).add(1);
        const taper = abs(t.sub(0.5)).mul(T.taper).mul(brk).oneMinus();
        const torn = sin(t.mul(e.uPattern.x).mul(spacing).mul(TWO_PI)
          .add(sin(ang.add(t.mul(6)).add(tearN.mul(T.fork))).mul(e.uPattern.z))
          .add(tear.mul(T.phase)).sub(time.mul(0.6))).mul(0.5).add(0.5);
        // Clamped because a cranked break could otherwise push the low edge past the high one, and a
        // smoothstep with reversed edges is undefined; the rolled range never reaches 0.17 anyway.
        const wob = tear.mul(0.5).mul(taper).clamp(-0.17, 0.17);
        wave.assign(torn);
        stripes.assign(smoothstep(T.edgeLo.sub(wob), T.edgeHi.add(wob), torn));
      });
      const spotsN = valueNoise2(vec2(t.mul(e.uPattern.y), ang.mul(1.2).add(e.uSeed)));
      const spots = smoothstep(0.62, 0.8, spotsN);
      const flank = smoothstep(0.05, 0.35, abs(cos(ang))).oneMinus();
      // Racing stripes, car-decal style: two lines straddling the dorsal ridge, split into segments of
      // solid bar, hash marks, or pinlines. Widths are in radians on a skinny tube, so keep them generous.
      // Distance from the ridge without acos: cos() can round past 1 on the seam, and acos of that is
      // NaN, which the compose pass then smears across the body.
      const dorsal = abs(ang.sub(Math.PI)).sub(Math.PI).negate();
      const dd = dorsal.sub(e.uRace.y.add(sin(t.mul(9).add(e.uSeed)).mul(0.06)));
      const rseed = e.uSeed.add(e.uRace.y.mul(40));   // rolls with raceOff, so a reroll re-lays the segments
      const zoneF = t.mul(3).add(rseed.mul(0.37).fract());
      const style = fract(sin(floor(zoneF).mul(12.9898).add(rseed)).mul(43758.5453));
      const solid = smoothstep(0.36, 0.22, abs(dd));
      const hatch = smoothstep(0.44, 0.3, abs(dd)).mul(step(0.5, fract(t.mul(16).add(dd.mul(3)))));
      const pins = smoothstep(0.1, 0.04, abs(abs(dd).sub(0.24)));
      const segGap = smoothstep(0.0, 0.08, fract(zoneF)).mul(smoothstep(1.0, 0.92, fract(zoneF)));
      const race = mix(mix(solid, hatch, smoothstep(0.3, 0.45, style)), pins, smoothstep(0.65, 0.8, style))
        .mul(segGap).mul(smoothstep(0.03, 0.12, t));
      // Ridge lights, Eleanor's trick at resident scale: a wandering dorsal line with two side lines low
      // enough to still show from above, and a charge pulse riding tailward every four seconds.
      const wander = sin(t.mul(7).sub(time.mul(0.2)).add(e.uSeed)).mul(0.35);
      const ridgeAt = (mu, w, gain) => smoothstep(w, w * 0.3, abs(dorsal.sub(mu).sub(wander))).mul(gain);
      const cyc = time.mul(0.25).add(e.uSeed).fract();
      const travel = smoothstep(0.16, 0.0, abs(t.sub(cyc))).mul(1.2);
      // Side lines at 0.75 rad: at 1.2 they sat on a resident's silhouette and read as a blurry edge.
      const ridge = ridgeAt(0, 0.4, 1.0).add(ridgeAt(0.75, 0.25, 0.5)).mul(travel.add(0.7));
      // Plaid: straight bands along the body crossed with bands around it; the crossings glow hardest.
      const bandT = smoothstep(0.35, 0.65, sin(t.mul(e.uPattern.x).mul(TWO_PI)).mul(0.5).add(0.5));
      const bandA = smoothstep(0.35, 0.65, sin(ang.mul(e.uPlaid.y)).mul(0.5).add(0.5));
      const plaid = bandT.add(bandA).mul(0.35).add(bandT.mul(bandA).mul(0.5));

      // The marbled swirl. fbm2Y is bell-shaped around 0.5, and 0.5 sits in the ramp's jam, so jam wins
      // by more than the stop widths say and cobalt only surfaces as veins and pools where the field peaks.
      const F = this.familyU;
      // Each family sits behind a uniform branch: a whole draw takes it or skips it, so the eleven
      // eels without it pay nothing, and fwidth stays in uniform control flow.
      const wSwirl = e.uSwirl.x;
      const fieldSwirl = float(0.5).toVar(), maskSwirl = float(0).toVar();
      If(wSwirl.greaterThan(0), () => {
        // Periodic around the girth (uSwirl.z is an integer cell count) so a roll never shows a seam.
        const swirlN = fbm2Y(vec2(t.mul(e.uSwirl.y).add(time.mul(U.motionScale).mul(F.swirl.drift)).add(e.uSwirl.w), ang.div(TWO_PI).mul(e.uSwirl.z)), e.uSwirl.z);
        fieldSwirl.assign(swirlN.sub(0.5).mul(F.swirl.contrast).add(0.5).clamp(0, 1));
        // Floored so jam still glows and the cobalt pools read a notch brighter: lit cobalt, on the body too.
        maskSwirl.assign(wSwirl.mul(F.swirl.floor.add(F.swirl.floor.oneMinus().mul(fieldSwirl))));
      });

      // Splotch: two octaves quantized to flat plateaus, each plateau landing on its own ramp region.
      // Hand-rolled rather than shading.js's fbm2, whose four octaves are more detail than a plateau needs.
      const SP = F.splotch, wSplotch = e.uFam.x;
      const fieldSplotch = float(0).toVar(), maskSplotch = float(0).toVar();
      If(wSplotch.greaterThan(0), () => {
        const freq = e.uFamB.x.mul(SP.freqMul);
        const n = valueNoise2(vec2(t.mul(freq), ang.mul(SP.around).add(e.uSeed))).toVar();
        // The halo never builds the second octave and rung 3 branches past it; a multiply by zero still
        // pays for the fetch. Normalized by the amplitude sum, so dropping it costs detail, not brightness.
        if (detail) If(SP.oct2.greaterThan(0), () => {
          const octB = valueNoise2(vec2(t.mul(freq).mul(2.03), ang.mul(SP.around).mul(2.03).add(e.uSeed)));
          n.assign(n.mul(0.5).add(octB.mul(0.25).mul(SP.oct2)).div(SP.oct2.mul(0.25).add(0.5)));
        });
        // levels is a uniform: a bare literal feeding runtime math types abstract in WGSL.
        const levels = mix(e.uFamB.y, SP.levelsForce, step(2.5, SP.levelsForce));
        const scaled = n.mul(levels);
        fieldSplotch.assign(floor(scaled).div(levels.sub(1).max(1)).clamp(0, 1));
        const edge = smoothstep(SP.edgeW, 0.0, abs(fract(scaled).sub(0.5).abs().sub(0.5)));
        // Picks between dim plateaus with neon outlines and lit plateau interiors, per splotchLit.
        maskSplotch.assign(mix(edge, fieldSplotch, e.uGlowModeB.z).mul(wSplotch));
      });

      // Sheen: a near-solid body whose color wanders across a narrow slice of the ramp, drawn at the rim.
      const SH = F.sheen, wSheen = e.uFam.y;
      const fieldSheen = float(0).toVar(), maskSheen = float(0).toVar();
      If(wSheen.greaterThan(0), () => {
        const drift = valueNoise2(vec2(t.mul(SH.span), time.mul(U.motionScale).mul(e.uFamB.z).add(e.uSeed)));
        fieldSheen.assign(drift.mul(SH.width).add(SH.center));
        // The camera is fixed straight down, so a real Fresnel collapses to 1 - dot(n, up). FrontSide
        // hands it the tube's far wall, so take |n.y|: unflipped, dot(n, up) clamps to 0 and the rim is flat.
        maskSheen.assign(smoothstep(SH.rimLo, SH.rimHi, normalize(vNormal).y.abs().oneMinus()).mul(wSheen));
      });

      // The field indexes the ramp: crests and flank read the main half, spots and between-stripe skin the
      // accent half, bands walk the whole ramp; a flank-only eel borrows the spot field so it is not split at mid-body.
      const wRace = e.uRace.x, wPlaid = e.uPlaid.x, wRidge = e.uPlaid.z;
      const bare = smoothstep(0.0, 1e-3, e.uWeights.x.add(e.uWeights.y).add(e.uBand.x).add(wRace).add(wPlaid).add(wRidge).add(wSwirl).add(wSplotch).add(wSheen)).oneMinus();
      const wSpotF = e.uWeights.y.add(bare);
      const wSum = e.uWeights.x.add(wSpotF).add(e.uBand.x).add(wRace).add(wPlaid).add(wRidge).add(wSwirl).add(wSplotch).add(wSheen).max(1e-3);
      const field = wave.oneMinus().mul(e.uWeights.x.div(wSum))
        .add(spots.mul(wSpotF.div(wSum)))
        .add(t.mul(e.uBand.y).mul(e.uBand.x.div(wSum)))
        .add(race.oneMinus().mul(wRace.div(wSum)))
        .add(bandT.add(bandA).mul(0.5).mul(wPlaid.div(wSum)))
        .add(ridge.clamp(0, 1).oneMinus().mul(wRidge.div(wSum)))
        .add(fieldSwirl.mul(wSwirl.div(wSum)))
        .add(fieldSplotch.mul(wSplotch.div(wSum)))
        .add(fieldSheen.mul(wSheen.div(wSum)))
        .toVar();

      // The tail-own envelope: the tip walks the ramp on its own slow clock instead of the body's field.
      // A field move, not a brightness term, which is why it lands here and not in the glow envelope.
      const TO = F.tailOwn;
      If(e.uGlowModeB.x.greaterThan(0), () => {
        const tailT = smoothstep(TO.from, TO.to, t).mul(e.uGlowModeB.x);
        const walk = fract(time.mul(U.motionScale).mul(TO.rate).add(e.uSeed.mul(0.1)));
        const ownF = mix(walk, walk.sub(0.5).abs().mul(2), TO.pingPong);
        field.assign(mix(field, ownF, tailT));
      });

      // The bake puts a band-edge mask in alpha, so each stripe boundary lights up from the one sample.
      const samp = rampNode.sample(vec2(field, 0.5));
      const ramp = vec3(0).toVar();
      ramp.assign(samp.rgb);
      // The gamer glow: a real hue rotation, a full wheel every eight seconds. Skin, glow, and the sand
      // light (writeSlot runs the same angle) all turn together, or the body and its light drift apart.
      If(e.uGlowModeB.y.greaterThan(0), () => {
        ramp.assign(mix(ramp, hue(ramp, time.mul(U.motionScale).mul(F.rgb.rate)), e.uGlowModeB.y));
      });
      const mask = stripes.mul(e.uWeights.x).add(spots.mul(e.uWeights.y)).add(flank.mul(e.uWeights.z)).add(samp.a.mul(e.uBand.x))
        .add(race.mul(wRace)).add(plaid.mul(wPlaid)).add(ridge.mul(wRidge)).add(maskSwirl).add(maskSplotch).add(maskSheen);

      // The stars. Each fragment tests the four nearest cells, so a star may sit anywhere in its own cell
      // (a full half-cell of jitter each way) without being cut at the edge: that is what breaks the rows.
      // Stars do crop at the nose and tail, like a pattern painted onto a body that ends.
      const stars = vec3(0).toVar();
      If(e.uStars.x.greaterThan(0), () => {
        const cellsA = e.uStars.y, cellsR = e.uStars.z;
        const sp = vec2(t.mul(cellsA), ang.div(TWO_PI).mul(cellsR));
        const base = floor(sp.sub(0.5));
        // On the darkest jam a lit-cobalt ring reads as a blue dot with a pale center, so there the rim
        // fades toward the star's own metal; the ramp runs jam → cobalt, so dark jam is the low field.
        const jamness = smoothstep(0.55, 0.75, fieldSwirl).oneMinus();
        const rimCol = mix(e.uStarRim, e.uStarCol.mul(0.8), jamness.mul(F.stars.rimFade));
        const starAcc = vec3(0).toVar();
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const cell = base.add(vec2(ox, oy));
          // The girth wraps: the hash reads the wrapped row so the seam's neighbors are the same stars.
          const wrapR = cell.y.sub(floor(cell.y.div(cellsR)).mul(cellsR));
          const cid = vec2(cell.x, wrapR).add(e.uStarsB.y);
          const sh = (hx, hy) => hash2(cid.add(vec2(hx, hy)));
          const present = step(e.uStarsB.x.oneMinus(), sh(0.137, 0.911));
          const rStar = e.uStars.w.mul(sh(0.531, 0.229).mul(0.7).add(0.65));
          const center = cell.add(0.5).add(vec2(sh(0.813, 0.457), sh(0.271, 0.083)).sub(0.5).mul(F.stars.scatter));
          const q = sp.sub(center);
          const spin = sh(0.647, 0.359).mul(TWO_PI), cs = cos(spin), sn = sin(spin);
          const sd = sdStar5(vec2(q.x.mul(cs).sub(q.y.mul(sn)), q.x.mul(sn).add(q.y.mul(cs))), rStar, F.stars.rf);
          // Half a derivative footprint keeps a five-pixel star's points sharp; the rim is the difference
          // of two coverages so it stays a band with two real edges instead of a fading aura.
          const soft = fwidth(sd).mul(0.5).max(1e-5);
          const fill = smoothstep(soft.negate(), soft, sd).oneMinus();
          const rimOuter = smoothstep(e.uStarsB.z.sub(soft), e.uStarsB.z.add(soft), sd).oneMinus();
          const rimBand = rimOuter.sub(fill).max(0);
          const twH = sh(0.929, 0.041);
          // The square skews amplitudes low, so a handful barely move and the dimmest still holds 0.2.
          const twAmp = twH.mul(twH).mul(0.5).add(0.3).mul(U.motionScale);
          // twinkle is in Hz; the spin doubles as the phase, since nobody can read that correlation.
          const twRate = F.stars.twinkle.mul(e.uStarsB.w).mul(twH.mul(0.6).add(0.7)).mul(TWO_PI);
          const tw = float(1).sub(twAmp.mul(sin(time.mul(twRate).add(spin)).mul(0.5).add(0.5)));
          const one = fill.mul(e.uStarCol).mul(F.stars.fillGain).add(rimBand.mul(rimCol).mul(F.stars.rimGain)).mul(present).mul(tw);
          // max, not add: two stars that drift into each other overlap like paper, they do not double up.
          starAcc.assign(starAcc.max(one));
        }
        stars.assign(starAcc.mul(e.uStars.x).mul(e.uLayers.y));
      });

      // The glitter: flat foil flecks on hashed facets, flashing as her motion swings them through the
      // moon's half-vector. FrontSide hands this camera the tube's far wall, so a visible fragment's
      // normal points away from it; flip it back before building facets, or every fleck faces the floor.
      const glitter = vec3(0).toVar();
      if (detail) If(e.uGlitter.x.greaterThan(0), () => {
        const nRaw = normalize(vNormal);
        const nrm = nRaw.mul(step(float(0), nRaw.y).mul(2).sub(1));
        const halfV = normalize(this.shading.lightDir().add(vec3(0, 1, 0)));
        const tanA = normalize(cross(nrm, vec3(0, 0, 1)).add(vec3(1e-5, 0, 0)));
        const tanB = cross(nrm, tanA);
        // A napping eel tilts nothing, so a slow wobble of the facet angle keeps her from going flat.
        const wob = sin(time.mul(0.05).mul(TWO_PI).mul(U.motionScale).add(e.uGlitter.y)).mul(0.25).add(1);
        const tiltMax = e.uGlitter.z.mul(DEG).mul(wob);
        const fleck = (along, around, driftMul) => {
          const gT = t.sub(e.uGlitter.w.mul(driftMul)).mul(along), gA = ang.div(TWO_PI).mul(around);
          // The scroll drives the along id negative without bound, and TSL's hash saturates negative seeds
          // to one value; wrapping it to a 1024-cell period keeps every fleck its own fleck for a whole night.
          const P = float(GLITTER_HASH_PERIOD);
          const idT = floor(gT).toVar();
          idT.assign(idT.sub(floor(idT.div(P)).mul(P)));
          const gid = vec2(idT, mod(floor(gA), around)).add(e.uGlitter.y).add(1000.5);
          const gh = (ox, oy) => hash2(gid.add(vec2(ox, oy)));
          const hAz = gh(0.733, 0.319), hTilt = gh(0.457, 0.601);
          const az = hAz.mul(TWO_PI);
          const tilt = tiltMax.mul(hTilt.mul(0.6).add(0.4));
          const facet = normalize(nrm.mul(cos(tilt)).add(tanA.mul(cos(az)).add(tanB.mul(sin(az))).mul(sin(tilt))));
          // A soft sliver inside the cell, nudged off center by hashes the facet already paid for: a whole
          // lit cell is a square, and squares are not foil.
          const jit = vec2(fract(hAz.mul(17.17)), fract(hTilt.mul(23.31))).sub(0.5).mul(0.12);
          const local = vec2(fract(gT), fract(gA)).sub(0.5).sub(jit);
          const shape = smoothstep(0.42, 0.16, abs(local.x).add(abs(local.y).mul(1.4)));
          // First-order hue rotation about the grey axis: the holographic wobble real craft glitter has,
          // for a handful of ALU instead of an RGB to HSV round trip.
          const w = gh(0.089, 0.523).sub(0.5).mul(2).mul(F.glitter.hueWobble);
          const c = e.uGlitterCol;
          return {
            lit: dot(facet, halfV).max(0).pow(F.glitter.sharp).mul(step(F.glitter.density.oneMinus(), gh(0.211, 0.877))).mul(shape),
            col: c.add(vec3(c.z.sub(c.y), c.x.sub(c.z), c.y.sub(c.x)).mul(w)),
          };
        };
        const surf = fleck(e.uGlitterB.x, e.uGlitterB.y, 1);
        const deep = fleck(e.uGlitterB.z, e.uGlitterB.w, GLITTER_DEEP_DRIFT);
        // The deeper layer is tinted toward the body's own ramp, as if seen through the jam.
        glitter.assign(surf.col.mul(surf.lit)
          .add(mix(deep.col, ramp, F.glitter.tint).mul(deep.lit).mul(F.glitter.deepGain))
          .mul(e.uGlitter.x).mul(F.glitter.gain).mul(e.uLayers.y));
      });

      const breathe = sin(time.mul(TWO_PI).mul(0.25).add(e.uSeed)).mul(0.25).add(0.75);
      const pulse = sin(time.mul(e.uPattern.w).sub(t.mul(7)).add(e.uSeed)).mul(0.25).add(0.85);
      const flicker = valueNoise2(vec2(time.mul(6), e.uSeed)).mul(0.4).add(0.6);
      const g = e.uGlowMode;
      const envelope = g.x.add(g.y.mul(breathe)).add(g.z.mul(pulse)).add(g.w.mul(flicker))
        .div(g.x.add(g.y).add(g.z).add(g.w).max(1e-3));

      const skin = ramp.mul(e.uLayers.x).mul(e.uSkinTint);
      const glow = ramp.mul(mask).mul(e.uLayers.y).mul(e.uGlowTint).mul(envelope);
      const eyeT = smoothstep(0.0, 0.05, t).oneMinus();
      // Stars and glitter never index the ramp and skip the glow envelope, so the swirl's colors do not
      // tint them and the traveling pulse does not sweep across them. Excite still lifts everything.
      return skin.add(glow).add(stars).add(glitter).mul(e.uExcite.mul(0.8).add(1)).add(eyeT.mul(0.3));
    });
    const emission = emissionFor(true), emissionCoarse = emissionFor(false);

    const bodyMat = new THREE.NodeMaterial();
    bodyMat.positionNode = buildPosition(1);
    bodyMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const L = this.shading.lightDir();
      const lambert = dot(n, L).max(0).mul(0.5).add(0.1);
      const body = vec3(0.03, 0.035, 0.05).mul(U.moonColor).mul(lambert);
      const glow = emission();
      const rim = dot(n, vec3(0, 1, 0)).max(0).oneMinus().pow(2).mul(0.4);
      // FrontSide hands this camera the far wall, so only y is mirrored: that is the back's real normal
      // at this xz, and a full negate would put the streak on the side away from the moon.
      const W = this.familyU.wet;
      const back = vec3(n.x, n.y.abs(), n.z);
      const wet = dot(back, normalize(L.add(vec3(0, 1, 0)))).max(0).pow(W.sharp.mul(e.uWetSharp))
        .mul(W.gain).mul(e.uWet.w).mul(mix(vec3(1), e.uWet.xyz, W.tint)).mul(U.moonColor);
      const depthFrac = vWorld.y.negate().div(DEPTH).clamp(0, 1);
      const out = vec4(body.add(glow).add(glow.mul(rim)).add(wet), depthFrac).toVar();
      cutBuried();
      return out;
    })();
    bodyMat.side = THREE.FrontSide;

    // Halo: a fatter additive shell; alpha blend keeps the RT's depth channel from the body.
    e.uHaloMul = uniform(1);
    const haloMat = new THREE.NodeMaterial();
    haloMat.positionNode = buildPosition(2.4);
    haloMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const edge = dot(n, vec3(0, 1, 0)).max(0);
      const glow = emissionCoarse().mul(0.16).mul(edge.pow(1.5)).mul(e.uHaloMul).toVar();
      cutBuried();
      return vec4(glow, 0);
    })();
    haloMat.transparent = true;
    haloMat.blending = THREE.CustomBlending;
    haloMat.blendSrc = THREE.OneFactor;
    haloMat.blendDst = THREE.OneFactor;
    haloMat.blendSrcAlpha = THREE.ZeroFactor;
    haloMat.blendDstAlpha = THREE.OneFactor;
    haloMat.depthWrite = false;
    haloMat.side = THREE.FrontSide;

    // Lazy on purpose: the jelly pipeline only compiles for eels that actually roll jelly.
    e.matBody = bodyMat;
    e.matJelly = null;
    e._mkJelly = () => {
      const J = this.jellyU;
      const m = new THREE.NodeMaterial();
      m.positionNode = buildPosition(1);
      // One copy, two taps: bent falls back to straight when it lands on something nearer than the
      // eel (bent.a is scene depth), so foreground never gets dragged sideways through the body.
      const sceneCopy = viewportSharedTexture();
      // The under-target is half float; the shared framebuffer copy must match or both backends refuse the blit.
      sceneCopy.value.type = THREE.HalfFloatType;
      m.fragmentNode = Fn(() => {
        const n = normalize(vNormal);
        const nView = cameraViewMatrix.mul(vec4(n, 0)).xyz;
        const wobPx = vec2(
          valueNoise2(vec2(vUV.x.mul(5).add(U.time.mul(0.13)), vUV.y.mul(0.8).add(e.uSeed))),
          valueNoise2(vec2(vUV.y.mul(0.9).add(U.time.mul(0.11)), vUV.x.mul(4).add(e.uSeed).add(7)))
        ).sub(0.5).mul(J.wobble);
        // Toward-center sampling magnifies, the way a water-filled tube actually lenses.
        const warpedUV = screenUV.add(wobPx.sub(nView.xy.mul(J.warp)).div(screenSize));
        const bent = sceneCopy.sample(warpedUV);
        const straight = sceneCopy.sample(screenUV);
        const depthFrac = vWorld.y.negate().div(DEPTH).clamp(0, 1);
        const valid = step(depthFrac.sub(J.depthEps), bent.a);
        const background = mix(straight.rgb, bent.rgb, valid);
        // The ramp wash drifts down the body, desaturated: tinted glass is pale, not neon.
        const drift = rampNode.sample(vec2(vUV.x.add(U.time.mul(0.02)), 0.5)).rgb;
        const pale = mix(vec3(dot(drift, vec3(0.299, 0.587, 0.114))), drift, J.desat);
        // Chord-thickness proxy: glass is thickest at the crown, so dye and presence peak mid-body
        // while the wide rim band draws the silhouette.
        const thick = dot(n, vec3(0, 1, 0)).max(0);
        const rim = smoothstep(0.15, 0.8, thick.oneMinus());
        const breathe = sin(U.time.mul(TWO_PI).mul(0.25).add(e.uSeed)).mul(0.2).add(0.8);
        const density = J.tint.mul(thick.mul(0.75).add(0.25)).add(rim.mul(J.rim).mul(0.4));
        const transmission = exp(vec3(1).sub(pale).mul(density).negate());
        const refracted = background.mul(transmission).mul(J.gain.clamp(0, 1));
        const opacity = J.wash.mul(thick.mul(0.6).add(0.4)).add(rim.mul(J.rim).mul(breathe)).clamp(0, 0.8);
        const out = vec4(refracted.add(emission().mul(J.ghost)), opacity).toVar();
        cutBuried();
        return out;
      })();
      // Alpha blending: the see-through part is the exact scene beneath, self-overlaps accumulate
      // instead of punching floor-colored holes, and dst alpha survives for the depth pass below.
      m.transparent = true;
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.ZeroFactor;
      m.blendDstAlpha = THREE.OneFactor;
      m.depthWrite = false;
      m.side = THREE.FrontSide;
      // Depth companion: RGB untouched, alpha becomes eel depth so the refraction pass keeps its contract.
      const d = new THREE.NodeMaterial();
      d.positionNode = buildPosition(1);
      d.fragmentNode = Fn(() => { cutBuried(); return vec4(vec3(0), vWorld.y.negate().div(DEPTH).clamp(0, 1)); })();
      d.transparent = true;
      d.blending = THREE.CustomBlending;
      d.blendEquation = THREE.AddEquation;
      d.blendSrc = THREE.ZeroFactor;
      d.blendDst = THREE.OneFactor;
      d.blendSrcAlpha = THREE.OneFactor;
      d.blendDstAlpha = THREE.ZeroFactor;
      d.depthWrite = true;
      d.side = THREE.FrontSide;
      e.matJellyDepth = d;
      e.jellyDepth = new THREE.Mesh(this.geometry, d);
      e.jellyDepth.frustumCulled = false;
      e.jellyDepth.renderOrder = 2.5;
      this.group.add(e.jellyDepth);
      return m;
    };

    // Sam's set, lazy for the same reason the jelly is: the firmament and five pipelines only exist
    // once an identity declares the void.
    e.voidSet = null;
    e._mkVoid = () => {
      this.firmament ??= new Firmament();
      return makeVoidSet(e, U, {
        position: buildPosition(1),
        vNormal, vWorld, vUV, geometry: this.geometry, group: this.group,
        firmament: this.firmament, V: this.voidU,
      });
    };

    e.body = new THREE.Mesh(this.geometry, bodyMat);
    e.halo = new THREE.Mesh(this.geometry, haloMat);
    e.body.frustumCulled = e.halo.frustumCulled = false;
    e.halo.renderOrder = 5;

    const eyeGeo = new THREE.SphereGeometry(1, 8, 6);
    const eyeMat = new THREE.NodeMaterial();
    eyeMat.fragmentNode = Fn(() => vec4(vec3(1.0, 0.98, 0.9), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
    e.matEye = eyeMat;
    e.eyes = [new THREE.Mesh(eyeGeo, eyeMat), new THREE.Mesh(eyeGeo, eyeMat)];
    e.eyes.forEach((m) => { m.scale.setScalar(e.radius * 0.2); this.group.add(m); });
    this.group.add(e.body, e.halo);
    // The boot cast can roll jelly before its mesh exists, so the swap runs here too.
    this.syncBodyMaterial(e);
  }

  /* Jelly swaps the material; the void swaps the whole set. renderOrder 2 sits after the opaques (so the
     copy holds the floor) but under algae, halos, and every surface layer; the void is an ordinary opaque at 0. */
  syncBodyMaterial(e) {
    if (e.identity?.void) {
      const set = (e.voidSet ??= e._mkVoid());
      if (e.body.material !== set.body) { e.body.material = set.body; e.body.renderOrder = 0; }
      // A sun needs the pixels to show a surface, so his eyes run larger than an eel's: eyeScale is a void dial.
      for (let i = 0; i < e.eyes.length; i++) {
        e.eyes[i].material = set.suns[i];
        e.eyes[i].scale.setScalar(e.radius * 0.2 * this.voidU.eyeScale.value);
      }
      // The ordinary lit halo is not his silhouette: the rim lens is, and the sheets are his tail.
      if (e.uHaloMul) e.uHaloMul.value = 0;
      this.syncBundleVisibility(e);
      return;
    }
    if (e.voidSet) {
      e.voidSet.show(false);
      e._voidAt = undefined;
      e._tailPrev = null;
      e.tailSpeed = 0;
    }
    if (e.matEye) for (const m of e.eyes) m.material = e.matEye;
    // His suns turn with his head; an ordinary eye is a flat dot, so the pose has to come back with it.
    if (e.eyes) for (const m of e.eyes) { m.scale.setScalar(e.radius * 0.2); m.quaternion.identity(); }
    const want = e.jelly ? (e.matJelly ??= e._mkJelly()) : e.matBody;
    if (e.body.material !== want) {
      e.body.material = want;
      e.body.renderOrder = e.jelly ? 2 : 0;
    }
    // The 2.4× additive shell screams "lamp"; a jelly keeps only a whisper of it.
    if (e.uHaloMul) e.uHaloMul.value = e.jelly ? this.jellyU.halo.value : 1;
    this.syncBundleVisibility(e);
  }

  /* Show or hide a whole animal. The stage calls this for every park and every arrival, so it owns the
     halo, the jelly depth companion, and every piece of the void bundle, not just the body and eyes. */
  setVisible(e, v) {
    if (!e.body) return;
    e.body.visible = v;
    for (const m of e.eyes) m.visible = v;
    this.syncBundleVisibility(e);
  }

  /* The per-identity bundle behind setVisible: the void hides the halo outright, and the jelly depth
     companion only ever shows for a jelly that is actually on screen. */
  syncBundleVisibility(e) {
    const v = !!e.body?.visible, isVoid = !!e.identity?.void;
    if (e.halo) e.halo.visible = v && !isVoid;
    // The jelly companion writes depth into the channel the refraction pass reads, so a swallowed jelly
    // eel would keep occluding from inside whichever guest's mouth ate it.
    if (e.jellyDepth) e.jellyDepth.visible = v && !!e.jelly && !isVoid;
    if (!e.voidSet) return;
    const on = v && isVoid;
    e.voidSet.show(on);
    // A guest who leaves mid-meal would otherwise ease his mouth shut in front of everyone on the way
    // back in; the open is stage state, not something the swap should carry.
    if (!on) e._hole = 0;
  }

  /* A reroll rebakes the ramp texture and moves uniforms; the node graph and the materials are the
     ones built at boot, which is what keeps a middle click free of a pipeline compile. */
  /* The CPU side of the families: the star and glitter cell grids, the class table, the metal, and the
     splotch/sheen/tiger pack. Cheap enough to re-run from applyKnobs, which is what makes the force dials usable. */
  pushFamilies(e) {
    const K = this.familyU;
    // The streak's width on screen goes as girth over root-sharp, so sharp scales with girth squared:
    // a thick back keeps a thin wet line instead of wearing a broad pale stripe.
    const c = tmpPink.copy(e.colA).lerp(e.colB, 0.35), m = Math.max(c.r, c.g, c.b, 1e-3);
    e.uWet.value.set(c.r / m, c.g / m, c.b / m, e.identity?.wet ?? 1);
    e.uWetSharp.value = Math.min(12, Math.max(0.5, (e.radius / K.wet.refR.value) ** 2));
    // A force dial on a body family only reaches the eels that declare it, since their shape parameters
    // are rolled alongside the weight; the two envelopes need none, so those force onto anybody.
    const pick = (forced, declared, own) => (forced != null && declared ? forced : own ?? 0);
    e.uFam.value.set(
      pick(K.splotch.forceW.value, e.splotchDeclared, e.wSplotch),
      pick(K.sheen.forceW.value, e.sheenDeclared, e.wSheen),
      e.wPaisley ?? 0,
      pick(K.tiger.forceBreak.value, e.tigerDeclared, e.tigerBreak));
    e.uFamB.value.set(e.splotchFreq ?? 0, e.splotchLevels ?? 0, e.sheenDrift ?? 0, e.paisleyScale ?? 0);
    e.uGlowModeB.value.set(
      K.tailOwn.force.value ?? e.wTailOwn ?? 0,
      K.rgb.force.value ?? e.wRgb ?? 0,
      K.splotch.forceLit.value ?? e.splotchLit ?? 0,
      e.paisleyTiles ?? 0);
    const L = starLayout(e.length, e.radius, K.stars.forceClass.value >= 0 ? K.stars.forceClass.value : e.starClass ?? 1);
    e.uStars.value.set(e.wStars ?? 0, L.cellsAlong, L.cellsAround, L.radius);
    e.uStarsB.value.set(L.density, e.starSeed ?? 0, L.rim, 1);
    const metal = K.stars.forceMetal.value >= 0 ? K.stars.forceMetal.value : e.starMetal ?? 0;
    e.uStarCol.value.setRGB(...(metal ? STAR_GOLD : STAR_SILVER));
    e.uGlitterCol.value.copy(e.uStarCol.value);
    e.uStarRim.value.setRGB(...LIT_COBALT);
    const freq = e.swirlFreq ?? 2.5;
    e.uSwirl.value.set(e.wSwirl ?? 0, freq, swirlAround(e.length, e.radius, freq), e.swirlSeed ?? 0);
    const G = glitterLayout(e.length, e.radius, K.glitter.cell.value, K.glitter.deepScale.value);
    e.uGlitter.value.set(e.wGlitter ?? 0, e.glitterSeed ?? 0, e.facetTilt ?? 30, e.glitterScroll ?? 0);
    e.uGlitterB.value.set(G.surface.along, G.surface.around, G.deep.along, G.deep.around);
  }

  applyAppearance(e) {
    const baked = bakeRamp(e.rampTex, e.rampStops, e.rampOpts, e.rng);
    e.rampHead = baked.head; e.rampTail = baked.tail;
    e.uColA.value.copy(e.colA); e.uColB.value.copy(e.colB);
    e.uPattern.value.set(e.stripeFreq, e.spotFreq, e.wavy, e.pulseRate);
    e.uWeights.value.set(e.wStripe, e.wSpot, e.wFlank);
    e.uBand.value.set(e.wBand, e.repeats);
    e.uRace.value.set(e.wRace, e.raceOff);
    e.uPlaid.value.set(e.wPlaid, e.plaidFreq, e.wRidge);
    e.uGlowMode.value.copy(e.glowMode);
    e.uLayers.value.set(this.knobs.skin * e.skinMul, this.knobs.glow);
    // A guest identity swap re-samples the build, so everything derived from the radius is refreshed
    // here too: the resident hot-swap does it by hand, and nothing else would for the guest.
    e.uRadius.value = e.radius;
    this.pushFamilies(e);
    this.syncBodyMaterial(e);
  }

  /* The ladder's void column. Like every other setQuality here it resets what it is not given, so the
     whole desired state goes over on each call. */
  setVoidQuality({ nebOct = 3, galaxies = 6, twinkleMin = 0, corona = 1, sheets = 3, tailOct = 3 } = {}) {
    const V = this.voidU;
    V.nebOct.value = nebOct;
    V.galaxies.value = galaxies;
    V.twinkleMin.value = twinkleMin;
    V.corona.value = corona;
    // The cloud's two costs are overdraw and octaves, so the ladder sheds a sheet and a fetch together.
    V.tailSheets.value = sheets;
    V.tailOct.value = tailOct;
  }

  createFoodMesh() { return new THREE.Mesh(this.foodGeo, this.foodMat); }

  setEnabled(on) {
    this.group.visible = on;
    // The system stops syncing while disabled, so nothing would overwrite a stale lit capsule.
    if (!on) for (let i = 0; i < INF_SLOTS; i++) this.clearSlot(i);
  }

  /* One influence capsule: spine points 2 and 16 of 24, the lit trunk minus snoot and whippy tail. */
  writeSlot(i, e) {
    const U = this.U, a = e.show[2], b = e.show[16];
    U.infA.array[i].set(a.x, a.y, a.z, e.radius);
    U.infB.array[i].set(b.x, b.y, b.z, 1);
    // speedBL is body lengths per second, so a long eel pushes harder than a short one at equal gait.
    const v = e.speedBL * e.length;
    U.infC.array[i].set(e.heading.x * v, e.heading.y * v, e.heading.z * v, e.uExcite.value);
    // A jelly is a dim lamp: full sand glow fills the glass with its own color and reads as solid.
    const k = (0.7 + e.uExcite.value * 0.6) * (e.jelly ? this.jellyU.lamp.value : 1);
    // Ramp half means (a whole-ramp mean of 26 tablecloth bands is beige), kept to the same narrow
    // span as before: a full head→tail lerp passes through grey on complementary palettes.
    U.eelCol.array[i].copy(e.rampHead).lerp(e.rampTail, 0.25).multiplyScalar(k);
    U.eelColB.array[i].copy(e.rampHead).lerp(e.rampTail, 0.55).multiplyScalar(k);
    const wRgb = e.uGlowModeB.value.y;
    if (wRgb > 0) {
      const ang = U.time.value * U.motionScale.value * this.familyU.rgb.rate.value;
      rotateHue(U.eelCol.array[i], ang, wRgb);
      rotateHue(U.eelColB.array[i], ang, wRgb);
    }
  }

  clearSlot(i) {
    const U = this.U;
    U.infA.array[i].set(0, -99, 0, 0);
    U.infB.array[i].set(0, -99, 0, 0);
    U.infC.array[i].set(0, 0, 0, 0);
    U.eelCol.array[i].setRGB(0, 0, 0);
    U.eelColB.array[i].setRGB(0, 0, 0);
  }

  /* Her body is long enough that one chord reads as a static bar, so she gets two chained capsules,
     the last two INF_SLOTS past the six residents, that actually follow her S-curve. */
  writeGuestSlots(e) {
    if (e.identity?.void) { this.writeVoidSlots(e); return; }
    const U = this.U;
    const v = e.speedBL * e.length;
    const k = 0.7 + e.uExcite.value * 0.6;
    const seg = (slot, a, b) => {
      U.infA.array[slot].set(a.x, a.y, a.z, e.radius);
      U.infB.array[slot].set(b.x, b.y, b.z, 1);
      U.infC.array[slot].set(e.heading.x * v, e.heading.y * v, e.heading.z * v, e.uExcite.value);
    };
    seg(EEL_COUNT, e.show[2], e.show[10]);
    seg(EEL_COUNT + 1, e.show[10], e.show[18]);
    U.eelCol.array[EEL_COUNT].copy(e.colA).multiplyScalar(k);
    U.eelColB.array[EEL_COUNT].copy(e.colA).lerp(e.colB, 0.6).multiplyScalar(k);
    U.eelCol.array[EEL_COUNT + 1].copy(U.eelColB.array[EEL_COUNT]);
    // The tail capsule ends in the photophore's pink, blinking on the sand in the same cycle the
    // shader runs on the tip: pure formula off the shared clock, so no readback and no drift.
    const time = U.time.value;
    const cyc = (time * 0.25 + e.uSeed.value) % 1;
    const blink = (c) => sstep(0.0, 0.02, cyc - c) * sstep(0.07, 0.05, cyc - c);
    const flash = (blink(0.05) + blink(0.16)) * 2.6;
    const tipPulse = Math.sin(time * 0.7 + e.uSeed.value) * 0.18 + 0.82;
    tmpPink.setRGB(1.0, 0.3, 0.55).multiplyScalar(tipPulse * 0.9);
    tmpFlash.setRGB(1.0, 0.05, 0.1).multiplyScalar(flash * 0.5);
    U.eelColB.array[EEL_COUNT + 1].copy(e.colB).lerp(tmpPink, 0.75).add(tmpFlash).multiplyScalar(k);
  }

  /* Sam lights the sand with two things and nothing between: his face and his tail cloud. The head is a
     point capsule flickering on the suns' own sizzle; the tail third brightens as it churns. */
  writeVoidSlots(e) {
    const U = this.U, time = U.time.value, ms = U.motionScale.value;
    const v = e.speedBL * e.length;
    const heat = Math.min(1, Math.max(0, e.sunHeat ?? 1));
    const infC = U.infC.array;
    // A point capsule at the eyes' reach, so the sand under his face is lit and his body is not.
    tmpC.copy(e.show[0]).addScaledVector(e.heading, 0.05);
    U.infA.array[EEL_COUNT].set(tmpC.x, tmpC.y, tmpC.z, e.radius * 1.4);
    U.infB.array[EEL_COUNT].set(tmpC.x, tmpC.y, tmpC.z, 1);
    infC[EEL_COUNT].set(e.heading.x * v, e.heading.y * v, e.heading.z * v, e.uExcite.value);
    // The tail capsule belongs under the cloud, which starts late and reaches past his tip.
    if (e.voidSet) e.voidSet.cloud.capsule(tmpCap);
    else { tmpCap.a.copy(e.show[19]); tmpCap.b.copy(e.show[23]); }
    U.infA.array[EEL_COUNT + 1].set(tmpCap.a.x, tmpCap.a.y, tmpCap.a.z, e.radius * 2.2);
    U.infB.array[EEL_COUNT + 1].set(tmpCap.b.x, tmpCap.b.y, tmpCap.b.z, 1);
    infC[EEL_COUNT + 1].set(e.heading.x * v, e.heading.y * v, e.heading.z * v, e.uExcite.value);
    // The shader's sizzle on the CPU, so the sand flickers in the same cycle the suns do.
    const tw = (time * ms) % (Math.PI * 2);
    const sizzle = 1 + (Math.sin(tw * 37 + e.uSeed.value) * 0.04 + Math.sin(tw * 91) * 0.02) * heat;
    const face = (0.35 + heat * 0.55) * sizzle;
    U.eelCol.array[EEL_COUNT].setRGB(1.0, 0.50, 0.18).multiplyScalar(face);
    U.eelColB.array[EEL_COUNT].copy(U.eelCol.array[EEL_COUNT]);
    const churn = (0.35 + Math.min(1, e.tailSpeed ?? 0) * 0.6) * (0.35 + heat * 0.65);
    // The sand under the plume takes the color queue's own weighted mean, so a pickup lights the floor too.
    const glow = e.voidSet?.cloud.light ?? CLOUD_LIGHT;
    U.eelCol.array[EEL_COUNT + 1].setRGB(glow[0], glow[1], glow[2]).multiplyScalar(churn);
    U.eelColB.array[EEL_COUNT + 1].copy(U.eelCol.array[EEL_COUNT + 1]).multiplyScalar(0.7);
  }

  sync(eels, foods, alpha) {
    // Held for the guest pass below it: the plume reads these eels' ramps when one swims up to his face.
    this.plumeCast = eels;
    for (const e of eels) {
      for (let i = 0; i < EEL_POINTS; i++) e.uSpine.array[i].copy(e.show[i].copy(e.pose0[i]).lerp(e.pts[i], alpha));
      this.syncBury(e);
      // Eye placement from the head frame.
      const h = e.show[0], n1 = e.show[1];
      tmpA.subVectors(h, n1).normalize();
      tmpB.crossVectors(tmpA, UP).normalize();
      const r = e.radius * 0.95;
      // Seated where the head profile is nearly full radius, sunk slightly into the body.
      e.eyes[0].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, r * 0.62);
      e.eyes[1].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, -r * 0.62);
      e.eyes[0].position.y += r * 0.22; e.eyes[1].position.y += r * 0.22;
      // A resident being slurped is hidden but still posed, so its slot goes dark with it.
      if (e.body.visible) this.writeSlot(e.index, e); else this.clearSlot(e.index);
    }
    for (const f of foods) {
      // mx/mz carry the sinking flutter; x/z stay the anchor the eels aim at.
      f.mesh.position.set(f.mx ?? f.x, f.y, f.mz ?? f.z);
      f.mesh.scale.setScalar(crumbScale(f.amount));
    }
  }

  /* The cut rides the closure front: rings the sand has fully closed on vanish, and inside the collar
     anything under the sand at the hole (plus a sliver of margin for the mesh) does too. */
  syncBury(e) {
    const front = e.burrowFront ?? -1;
    if (!(front >= 0)) { e.uBury.value.set(-1e3, -1e3, 0); return; }
    const c = e.show[Math.min(EEL_POINTS - 1, Math.round(front))];
    e.uBury.value.set(front - (e.burrowSoft ?? 0), front + 1, floorHeightAt(c.x, c.z) + 0.02 + e.radius * 0.1);
  }

  /* The guest owns slots EEL_COUNT and EEL_COUNT + 1. She is parked offstage and hidden between
     visits, so a dark body must never leave a lit capsule sitting in the pond. */
  syncGuest(e, alpha) {
    for (let i = 0; i < EEL_POINTS; i++) e.uSpine.array[i].copy(e.show[i].copy(e.pose0[i]).lerp(e.pts[i], alpha));
    const h = e.show[0], n1 = e.show[1];
    tmpA.subVectors(h, n1).normalize();
    tmpB.crossVectors(tmpA, UP).normalize();
    const r = e.radius * 0.95;
    e.eyes[0].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, r * 0.62);
    e.eyes[1].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, -r * 0.62);
    e.eyes[0].position.y += r * 0.22; e.eyes[1].position.y += r * 0.22;
    // A parked or swallowed guest pays nothing for the void: the plume's whole update, its uniform writes,
    // and its sweep over the cast would all run for something nobody can see.
    if (e.identity?.void && e.voidSet) {
      if (e.body.visible) this.syncVoid(e, tmpA);
      else { e._voidAt = undefined; e._tailPrev = null; e.tailSpeed = 0; }
    }
    if (e.body.visible) this.writeGuestSlots(e);
    else { this.clearSlot(EEL_COUNT); this.clearSlot(EEL_COUNT + 1); }
  }

  /* Everything about Sam that lives on the frame clock: tail speed, the sun clocks, and the singularity's
     open, all decoration only since behavior reads none of it. `fwd` is the caller's normalized forward vector. */
  syncVoid(e, fwd) {
    const S = e.voidSet, U = this.U, V = this.voidU;
    for (const [dial, lo, hi, fallback] of VOID_BOUNDS) dialNum(V[dial], lo, hi, fallback);
    S.setCoronaVisible(e.body.visible && V.corona.value > 0);
    const now = U.time.value, ms = U.motionScale.value;
    const dt = Math.min(0.1, Math.max(0, now - (e._voidAt ?? now)));
    e._voidAt = now;
    // Lateral travel of the tail against the body it hangs off, smoothed over 0.3 s so one frame of
    // solver jitter cannot flash the whole cloud.
    tmpC.subVectors(e.show[22], e.show[18]);
    const prev = (e._tailPrev ??= tmpC.clone());
    // Capped because a park teleports the whole chain, and an uncapped frame of that would flare the
    // cloud for a second after he comes back.
    const raw = dt > 1e-4 ? Math.min(6, tmpC.distanceTo(prev) / dt) : (e.tailSpeed ?? 0);
    prev.copy(tmpC);
    const smoothed = e.tailSpeed ?? 0;
    e.tailSpeed = smoothed + (raw - smoothed) * (dt > 0 ? 1 - Math.exp(-dt / 0.3) : 0);
    const heat = Math.min(1, Math.max(0, e.sunHeat ?? 1));
    e.uSunHeat.value = heat;
    e.uSizzleT.value = (this.U.time.value * this.U.motionScale.value) % (Math.PI * 2);
    e.uFlareT.value = (this.U.time.value * this.U.motionScale.value * V.flareSpeed.value) % FLARE_WRAP;
    // Accumulated and ping-ponged rather than wrapped: the sun face reads non-periodic noise, so a modulo
    // of its clock would jump the whole granulation.
    e._sunT = (e._sunT ?? 0) + dt * ms;
    e.uSunT.value = SUN_WRAP - Math.abs((e._sunT % (SUN_WRAP * 2)) - SUN_WRAP);
    // The cast is what his plume picks colors up from; sync() runs over it just before this one.
    S.cloud.sync(dt, heat, this.plumeCast);
    // His suns are eyeballs: the surface graph reads the local normal, so the mesh itself has to carry
    // the head's frame, and the flares take the same turn as an angular offset.
    tmpB.crossVectors(fwd, UP).normalize();
    tmpM.makeBasis(tmpB, tmpY.crossVectors(fwd, tmpB), fwd);
    const yaw = Math.atan2(fwd.z, fwd.x);
    // The coronas ride above the body so the tube's own depth cannot swallow them; straight down, only
    // their xz placement reads anyway.
    const liftY = e.show[0].y + e.radius * 1.5;
    for (let i = 0; i < 2; i++) {
      e.eyes[i].quaternion.setFromRotationMatrix(tmpM);
      S.coronaMats[i].uAng.value = yaw;
      S.coronas[i].position.copy(e.eyes[i].position);
      S.coronas[i].position.y = liftY;
      S.coronas[i].scale.setScalar(e.radius * 0.2 * V.eyeScale.value * Math.max(1e-3, V.coronaSize.value || 0));
    }
    // The meal scale eases open in 0.4 s and shut in 0.6 s; the controller only ever sets the target.
    const want = Number.isFinite(e.horizon) ? Math.max(0, e.horizon) : 0;
    const cur = Number.isFinite(e._hole) ? Math.max(0, e._hole) : 0;
    const tau = want > cur ? V.holeOpen.value : V.holeClose.value;
    const rate = Math.max(want, cur, 1e-3) / tau;
    e._hole = cur + Math.sign(want - cur) * Math.min(Math.abs(want - cur), rate * dt);
    const open = e._hole > 1e-3 && e.body.visible;
    S.hole.horizon.visible = S.hole.ring.visible = open;
    if (!open) return;
    const rad = e._hole * e.radius;
    S.hole.horizon.position.copy(e.show[0]).addScaledVector(fwd, e.radius * 0.5);
    S.hole.horizon.scale.setScalar(rad);
    S.hole.ring.position.copy(S.hole.horizon.position);
    S.hole.ring.position.y = liftY;
    S.hole.ring.scale.setScalar(rad * V.ringScale.value * 2);
    S.hole.spin(dt, ms > 0.5);
  }

  dispose(eels) {
    this.geometry.dispose();
    for (const e of eels) {
      e.matBody.dispose(); e.matJelly?.dispose(); e.matJellyDepth?.dispose(); e.halo.material.dispose(); e.rampTex.dispose();
      e.voidSet?.dispose();
      // Both eyes share one geometry, and the eye material is held on the eel rather than read off the
      // mesh, which may be wearing Sam's suns instead.
      e.eyes?.[0]?.geometry.dispose(); e.matEye?.dispose();
    }
    this.firmament?.dispose();
    this.foodGeo.dispose(); this.foodMat.dispose();
  }
}
