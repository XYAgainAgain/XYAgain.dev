import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, attribute, vec2, vec3, vec4, float, int, floor, mix, normalize, cross, sin, cos, abs, fract, step, smoothstep, varying, dot, texture, TWO_PI, positionWorld, screenUV, screenSize, viewportSharedTexture, cameraViewMatrix, exp } from 'three/tsl';
import { EEL_COUNT, EEL_POINTS, INF_SLOTS, DEPTH } from './config.js';
import { valueNoise2 } from './shading.js';
import { makeRampTexture, bakeRamp } from './eel-palette.js';

const RINGS = 48, SIDES = 12;
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const tmpPink = new THREE.Color(), tmpFlash = new THREE.Color();
// Generic smoothstep; handles reversed edges the way GLSL's does not, which blink() relies on.
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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
    const rampNode = texture(e.rampTex);
    const U = this.U;

    const vNormal = varying(vec3(0), 'vEelN');
    const vWorld = varying(vec3(0), 'vEelP');
    const vUV = varying(vec2(0), 'vEelUV');

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
    const emission = e.identity?.dorsalGlow ? Fn(() => {
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
      const t = vUV.x, ang = vUV.y;
      const time = U.time;
      const wave = sin(t.mul(e.uPattern.x).mul(TWO_PI).add(sin(ang.add(t.mul(6))).mul(e.uPattern.z)).sub(time.mul(0.6))).mul(0.5).add(0.5);
      const stripes = smoothstep(0.35, 0.65, wave);
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

      // The field indexes the ramp: crests and flank read the main half, spots and between-stripe skin the
      // accent half, bands walk the whole ramp; a flank-only eel borrows the spot field so it is not split at mid-body.
      const wRace = e.uRace.x, wPlaid = e.uPlaid.x, wRidge = e.uPlaid.z;
      const bare = smoothstep(0.0, 1e-3, e.uWeights.x.add(e.uWeights.y).add(e.uBand.x).add(wRace).add(wPlaid).add(wRidge)).oneMinus();
      const wSpotF = e.uWeights.y.add(bare);
      const wSum = e.uWeights.x.add(wSpotF).add(e.uBand.x).add(wRace).add(wPlaid).add(wRidge).max(1e-3);
      const field = wave.oneMinus().mul(e.uWeights.x.div(wSum))
        .add(spots.mul(wSpotF.div(wSum)))
        .add(t.mul(e.uBand.y).mul(e.uBand.x.div(wSum)))
        .add(race.oneMinus().mul(wRace.div(wSum)))
        .add(bandT.add(bandA).mul(0.5).mul(wPlaid.div(wSum)))
        .add(ridge.clamp(0, 1).oneMinus().mul(wRidge.div(wSum)));

      // The bake puts a band-edge mask in alpha, so each stripe boundary lights up from the one sample.
      const samp = rampNode.sample(vec2(field, 0.5));
      const ramp = samp.rgb;
      const mask = stripes.mul(e.uWeights.x).add(spots.mul(e.uWeights.y)).add(flank.mul(e.uWeights.z)).add(samp.a.mul(e.uBand.x))
        .add(race.mul(wRace)).add(plaid.mul(wPlaid)).add(ridge.mul(wRidge));

      const breathe = sin(time.mul(TWO_PI).mul(0.25).add(e.uSeed)).mul(0.25).add(0.75);
      const pulse = sin(time.mul(e.uPattern.w).sub(t.mul(7)).add(e.uSeed)).mul(0.25).add(0.85);
      const flicker = valueNoise2(vec2(time.mul(6), e.uSeed)).mul(0.4).add(0.6);
      const g = e.uGlowMode;
      const envelope = g.x.add(g.y.mul(breathe)).add(g.z.mul(pulse)).add(g.w.mul(flicker))
        .div(g.x.add(g.y).add(g.z).add(g.w).max(1e-3));

      const skin = ramp.mul(e.uLayers.x).mul(e.uSkinTint);
      const glow = ramp.mul(mask).mul(e.uLayers.y).mul(e.uGlowTint).mul(envelope);
      const eyeT = smoothstep(0.0, 0.05, t).oneMinus();
      return skin.add(glow).mul(e.uExcite.mul(0.8).add(1)).add(eyeT.mul(0.3));
    });

    const bodyMat = new THREE.NodeMaterial();
    bodyMat.positionNode = buildPosition(1);
    bodyMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const L = this.shading.lightDir();
      const lambert = dot(n, L).max(0).mul(0.5).add(0.1);
      const body = vec3(0.03, 0.035, 0.05).mul(U.moonColor).mul(lambert);
      const glow = emission();
      const rim = dot(n, vec3(0, 1, 0)).max(0).oneMinus().pow(2).mul(0.4);
      const depthFrac = vWorld.y.negate().div(DEPTH).clamp(0, 1);
      return vec4(body.add(glow).add(glow.mul(rim)), depthFrac);
    })();
    bodyMat.side = THREE.FrontSide;

    // Halo: a fatter additive shell; alpha blend keeps the RT's depth channel from the body.
    e.uHaloMul = uniform(1);
    const haloMat = new THREE.NodeMaterial();
    haloMat.positionNode = buildPosition(2.4);
    haloMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const edge = dot(n, vec3(0, 1, 0)).max(0);
      const glow = emission().mul(0.16).mul(edge.pow(1.5)).mul(e.uHaloMul);
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
        return vec4(refracted.add(emission().mul(J.ghost)), opacity);
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
      d.fragmentNode = Fn(() => vec4(vec3(0), vWorld.y.negate().div(DEPTH).clamp(0, 1)))();
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

    e.body = new THREE.Mesh(this.geometry, bodyMat);
    e.halo = new THREE.Mesh(this.geometry, haloMat);
    e.body.frustumCulled = e.halo.frustumCulled = false;
    e.halo.renderOrder = 5;

    const eyeGeo = new THREE.SphereGeometry(1, 8, 6);
    const eyeMat = new THREE.NodeMaterial();
    eyeMat.fragmentNode = Fn(() => vec4(vec3(1.0, 0.98, 0.9), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
    e.eyes = [new THREE.Mesh(eyeGeo, eyeMat), new THREE.Mesh(eyeGeo, eyeMat)];
    e.eyes.forEach((m) => { m.scale.setScalar(e.radius * 0.2); this.group.add(m); });
    this.group.add(e.body, e.halo);
    // The boot cast can roll jelly before its mesh exists, so the swap runs here too.
    this.syncBodyMaterial(e);
  }

  /* Jelly is the one roll that swaps the material. renderOrder 2 sits after the opaques (so the
     copy holds the whole floor) but under algae, halos, and every surface layer. */
  syncBodyMaterial(e) {
    const want = e.jelly ? (e.matJelly ??= e._mkJelly()) : e.matBody;
    if (e.body.material !== want) {
      e.body.material = want;
      e.body.renderOrder = e.jelly ? 2 : 0;
    }
    if (e.jellyDepth) e.jellyDepth.visible = !!e.jelly;
    // The 2.4× additive shell screams "lamp"; a jelly keeps only a whisper of it.
    if (e.uHaloMul) e.uHaloMul.value = e.jelly ? this.jellyU.halo.value : 1;
  }

  /* A reroll rebakes the ramp texture and moves uniforms; the node graph and the materials are the
     ones built at boot, which is what keeps a middle click free of a pipeline compile. */
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
    this.syncBodyMaterial(e);
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

  sync(eels, foods, alpha) {
    for (const e of eels) {
      for (let i = 0; i < EEL_POINTS; i++) e.uSpine.array[i].copy(e.show[i].copy(e.pose0[i]).lerp(e.pts[i], alpha));
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
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.scale.setScalar(Math.max(0.2, Math.min(1, f.amount)));
    }
  }

  /* The guest owns slots EEL_COUNT and EEL_COUNT + 1. She is parked offstage and hidden between
     visits, so a dark body must never leave a lit capsule sitting in the pond. */
  syncGuest(e, alpha) {
    for (let i = 0; i < EEL_POINTS; i++) e.uSpine.array[i].copy(e.show[i].copy(e.pose0[i]).lerp(e.pts[i], alpha));
    if (e.body.visible) this.writeGuestSlots(e);
    else { this.clearSlot(EEL_COUNT); this.clearSlot(EEL_COUNT + 1); }
    const h = e.show[0], n1 = e.show[1];
    tmpA.subVectors(h, n1).normalize();
    tmpB.crossVectors(tmpA, UP).normalize();
    const r = e.radius * 0.95;
    e.eyes[0].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, r * 0.62);
    e.eyes[1].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, -r * 0.62);
    e.eyes[0].position.y += r * 0.22; e.eyes[1].position.y += r * 0.22;
  }

  dispose(eels) {
    this.geometry.dispose();
    for (const e of eels) { e.matBody.dispose(); e.matJelly?.dispose(); e.matJellyDepth?.dispose(); e.halo.material.dispose(); e.rampTex.dispose(); }
    this.foodGeo.dispose(); this.foodMat.dispose();
  }
}
