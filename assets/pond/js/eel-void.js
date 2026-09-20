import * as THREE from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, uv, sin, atan, mix, smoothstep, step, dot, length, exp, normalize, cameraViewMatrix, positionWorld, normalWorld, normalLocal, screenUV, screenSize, If, TWO_PI } from 'three/tsl';
import { DEPTH } from './config.js';
import { valueNoise2, fbm2Y } from './shading.js';
import { makeTailCloud } from './eel-tail-cloud.js';

/* Sam the Space Eel's look: a noodle-shaped hole in reality, two orange dwarf eyes, and a nebula tail,
   with a singularity he only opens to eat. Opaque materials write depth to alpha; additive ones don't. */

const SUN_CORE = [1.0, 0.52, 0.16];
const SUN_LIMB = [0.92, 0.27, 0.03];
const SUN_HOT = [1.0, 0.78, 0.36];       // the white-hot granules a K dwarf's blobby face shows
const SUN_EMBER = [0.9, 0.22, 0.08];
const RING_OUT = [1.0, 0.30, 0.22];      // the accretion ring's outer edge
const NEB_HA = [0.78, 0.06, 0.18];
// Real teal, blue-green leaning cyan. A green-dominant [O III] dims to olive over dark water.
const NEB_OIII = [0.05, 0.62, 0.60];
const NEB_SII = [0.42, 0.01, 0.03];
const NEB_HB = [0.08, 0.24, 0.72];
const NEB_REFLECT = [0.18, 0.46, 0.76];
const NEB_OLD_HA = [0.50, 0.12, 0.42];
const NEB_OLD_TEAL = [0.10, 0.30, 0.32];
const FLARE_HOT = [1.0, 0.62, 0.24];
const FLARE_RIM = [1.0, 0.26, 0.03];
// The compose pass multiplies everything underwater by exp(-ABSORB * path); the tint knob undoes it.
const ABSORB = [0.22, 0.11, 0.06];
const FLARE_CELLS = 20;                   // noise cells around the accretion ring; the period that closes its seam
// The flare clock wraps here, 8 turns: every harmonic in the shader is an integer, so the wrap is silent.
export const FLARE_WRAP = Math.PI * 16;
// The sun clock's ping-pong turning point, in seconds: far enough out that a reversal is a curiosity.
export const SUN_WRAP = 2048;

/* Every taste constant in the void, live as pond.eels.knobs.void.<dial>.value. Uniform dials land on
   the next frame; the plain {value} entries are CPU-side and land on the next sync. */
export function makeVoidDials() {
  return {
    // The universe's own motion: a full turn in about three hours, a slow crawl across the screen.
    spin: uniform(0.0006), drift: uniform(0.004), driftAngle: uniform(0.7),
    // A thin bend just inside the silhouette, no rim line: lens is the peak shift in pixels and
    // lensBand is where the band starts, in |n·up| from the edge inward.
    lens: uniform(20), lensBand: uniform(0.42), rimGain: uniform(1.0), rimTint: uniform(0),
    // starScale multiplies every tier's cell count, so it is really "how far away the field is".
    starScale: uniform(1.0), starDensity: uniform(1.0), starGain: uniform(3.0),
    dustGain: uniform(1.7), midGain: uniform(2.8), brightGain: uniform(2.8),
    twinkle: uniform(0.875), twinkleRate: uniform(1.75), twinkleMin: uniform(0), twinkleShare: uniform(0.55),
    spikeGain: uniform(1.0), spikeAt: uniform(0.27), spikeLen: uniform(11), spikeAngle: uniform(0.35),
    nebula: uniform(0.7), nebFreq: uniform(4), nebWarp: uniform(0.9), nebDrift: uniform(0.01),
    nebLo: uniform(0.5), nebHi: uniform(0.86), nebOct: uniform(3),
    nebReal: uniform(1), nebHotLo: uniform(0.18), nebHotHi: uniform(0.92),
    nebHaCut: uniform(0.75), nebOiii: uniform(0.9), nebOiiiFloor: uniform(0.01), nebSii: uniform(0.12),
    nebHb: uniform(0.20), nebReflect: uniform(0.18), nebRealCap: uniform(0.50), nebRealRich: uniform(0.75),
    // How much of the finest octave steers the hue: the clouds keep their scale while the color turns
    // several times over one body length.
    nebHueVary: uniform(0.4),
    galaxies: uniform(6), galGain: uniform(0.7), galColor: uniform(0.7), galSpin: uniform(1.0),
    galCells: uniform(5), galDensity: uniform(0.55), galScale: uniform(0.045),
    galArm: uniform(0.85), galArmSharp: uniform(1.7), galArmBreak: uniform(0.58),
    galCoreFall: uniform(6.5), galDiskFall: uniform(2.6), galCore: uniform(1.2),
    tint: uniform(1),
    // The suns: sizzle and granule are the face, blob the hot/cool patches over it.
    eyeScale: uniform(1), sunGain: uniform(1.0), sizzle: uniform(1), granule: uniform(0.22), blob: uniform(0),
    // Their flares, all measured in disc radii above the limb. flare is the tallest a prominence can get,
    // corona is the rung-6 switch, and coronaSize is only the quad: 6.6 puts its edge just past flare's reach.
    flare: uniform(2), corona: uniform(1), coronaGain: uniform(1.15), coronaSize: uniform(6.6),
    flareSpeed: uniform(1), flareCurl: uniform(0.3), flarePeak: uniform(6),
    limbFall: uniform(0.36), limbGain: uniform(0.84), promGain: uniform(2.6),
    // The nebula plume. back/past are fractions of his body length either side of the tail tip; the three
    // widths are half widths in body radii, so 1 is one body-width across; rise/fall/swell are places
    // along the plume's own length.
    tailGain: uniform(1.35), tailSleep: uniform(0.45), tailTint: uniform(0.65),
    tailBreath: { value: 0.45 }, tailBreathPeriod: { value: 7 },
    tailBack: { value: 0.08 }, tailPast: { value: 0.14 },
    // The towed rope past the tip. smooth low-passes the tail's heading so a swim stroke never reaches the
    // rope; lag is how slowly the first free point follows and grade how much slower each one after it,
    // which is what leaves the far end drifting like gas; bend is the pull toward straight and kink the
    // hard cap on the angle between two segments, so the curve can never crease.
    tailRopeSmooth: { value: 0.6 }, tailRopeLag: { value: 0.55 }, tailRopeGrade: { value: 1.0 },
    tailRopeBend: { value: 0.70 }, tailRopeKink: { value: 0.55 },
    tailW0: uniform(1.0), tailW1: uniform(2.6), tailW2: uniform(3.4), tailSwell: uniform(0.42),
    tailRise: uniform(0.10), tailFall: uniform(0.52), tailEndPow: uniform(1.05), tailEndSeg: { value: 1.65 },
    tailCoreGain: uniform(0.95), tailCoreWidth: uniform(0.42), tailCoreRise: uniform(0.07), tailCoreEnd: uniform(0.68),
    // sheets is a uniform now: it gates the second gas sample and the second glitter layer in the graph.
    tailLift: uniform(0.6), tailOct: uniform(3), tailSheets: uniform(3),
    // How far either side of a rope joint the two segments' arc-length frames blend, in pond units: a
    // polyline's nearest-point coordinate creases at every joint, and any pattern drawn in it creases too.
    tailJointBlend: uniform(0.22),
    // The gas, in pond units: freq is cycles per unit, stretch the elongation along the flow, warpF the
    // warp field's own much coarser frequency.
    tailFreq: uniform(2.6), tailStretch: uniform(2.0), tailWarp: uniform(1.35), tailWarpF: uniform(0.38),
    tailFlow: uniform(0.10), tailSwing: uniform(0.22), tailEvolve: uniform(0.04),
    tailColorWarp: uniform(0.62), tailColorSide: uniform(0.48), tailSeepLo: uniform(0.34), tailSeepHi: uniform(0.78),
    tailSeepSoft: uniform(0.22), tailBandSoft: uniform(0.3), tailMixRich: uniform(0.7),
    tailColorSat: { value: 0.72 }, tailColorLum: { value: 0.78 }, tailColorGrey: { value: 0.18 },
    // How much of the gas is read in world coordinates rather than the rope's own: 0 carries its gas
    // along with it, 1 drags through gas that hangs in the water, so his own swimming supplies the motion.
    tailWorld: uniform(0.12),
    // The glitter: fleck cell size in pond units, the share of cells carrying one, the facet sharpness,
    // how far a flash leans to white, and the two extra layers' gains and coarser scales.
    tailGlit: uniform(2.2), tailGlitDens: uniform(0.22), tailGlitCell: uniform(0.035),
    tailGlitSharp: uniform(9), tailGlitWhite: uniform(0.48), tailGlitDeep: uniform(0.8),
    tailGlitDeepScale: uniform(1.8), tailGlitLarge: uniform(0.65), tailGlitLargeScale: uniform(4.2),
    // The flash clock, CPU-accumulated: its idle rate and the share his own tail speed adds.
    tailGlitRate: { value: 0.35 }, tailGlitMotion: { value: 1.3 },
    // Density stays continuous so one field carries bright cores into faint outskirts without cutout edges.
    tailDensPow: uniform(2.0), tailDensFloor: uniform(0.015),
    // The second gas sample's own share of the total density, fetched only when tailSheets enables it.
    tailDepth: uniform(0.5),
    // The dark filaments: depth, and the window they cut out of the warp field.
    tailDust: uniform(0.55), tailDustLo: uniform(0.42), tailDustHi: uniform(0.72),
    // The color queue. life is how long a stop takes to ride the plume in seconds, band sets its broad
    // arc-length reach, and house is his own orange's standing weight.
    tailLife: { value: 150 }, tailBand: { value: 0.10 }, tailHouse: uniform(0.12),
    tailGlowEase: { value: 2.0 },
    // A slot never changes color while it is being drawn: a push waits behind this fade, in seconds.
    tailRetire: { value: 1.5 },
    // Sharpens whose band a puff belongs to. Kept near 1 so two or three slots reach any one point; the
    // richness that saves an overlap from grey comes from tailMixRich, not from starving the blend.
    tailBandPow: uniform(2.0),
    tailStretchK: uniform(10),
    tailNear: { value: 1.0 }, tailCool: { value: 90 }, tailIdle: { value: 45 },
    tailDripMin: { value: 90 }, tailDripMax: { value: 180 },
    // The anchor's own smoothing in seconds: enough that one frame of solver jitter cannot shimmy the
    // whole plume sideways, little enough that the rope still leaves his tail exactly where it is.
    tailAnchor: { value: 0.10 },
    // The singularity: the ring's reach past the horizon, its spin, and the two ease clocks in seconds.
    ringGain: uniform(1.0), ringSpin: uniform(1.5), ringScale: uniform(2.5),
    holeOpen: { value: 0.4 }, holeClose: { value: 0.6 },
  };
}

/* Three octaves of iterated domain warp with the clock in the domain: the cloud never repeats and never
   stops evolving. Rung 6 branches past the third fetch. */
function nebula(p, V, time, live) {
  const t = time.mul(V.nebDrift).mul(live);
  const q = p.mul(V.nebFreq).add(vec2(t, t.mul(0.6))).toVar();
  const a = valueNoise2(q);
  const b = valueNoise2(q.mul(2.1).add(vec2(a.mul(V.nebWarp), a.mul(V.nebWarp).mul(-1.3))).add(17.3));
  const c = b.toVar(), f = a.mul(0.6).add(b.mul(0.4)).toVar();
  If(V.nebOct.greaterThan(2.5), () => {
    c.assign(valueNoise2(q.mul(4.4).add(vec2(b.mul(V.nebWarp), b.mul(V.nebWarp).mul(0.8))).add(41.7)));
    f.assign(a.mul(0.5).add(b.mul(0.33)).add(c.mul(0.17)));
  });
  // Coverage still carves real black sky; the fetched octave differences only choose which gas is visible.
  const nebLo = V.nebLo.min(V.nebHi.sub(1e-3));
  const nebHi = V.nebHi.max(V.nebLo.add(1e-3));
  const cov = smoothstep(nebLo, nebHi, f).pow(1.6);
  const hotLo = V.nebHotLo.clamp(0, 0.95);
  // The ionization blend rides the finest octave in hand as well as the coarse one, so hue turns several
  // times along his length; a narrow window over one octave alone paints whole stretches a single flat hue.
  const hueSrc = mix(b, c, V.nebHueVary.clamp(0, 1)).toVar();
  const hot = smoothstep(hotLo, V.nebHotHi.clamp(0.01, 1).max(hotLo.add(0.01)), hueSrc).toVar();
  const ridge = a.sub(b).abs().toVar(), vein = b.sub(c).abs().toVar();
  const ha = f.mul(0.55).add(0.25).mul(float(1).sub(hot.mul(V.nebHaCut))).toVar();
  const oiii = hot.mul(ridge.mul(0.6).add(0.4)).mul(V.nebOiii).add(V.nebOiiiFloor).toVar();
  const sii = ridge.mul(0.36).add(vein.mul(0.2)).mul(V.nebSii).toVar();
  const hbeta = c.sub(a).abs().mul(V.nebHb).toVar();
  const reflection = f.sub(b).abs().mul(V.nebReflect).toVar();
  const physical = vec3(...NEB_HA).mul(ha)
    .add(vec3(...NEB_OIII).mul(oiii))
    .add(vec3(...NEB_SII).mul(sii))
    .add(vec3(...NEB_HB).mul(hbeta))
    .add(vec3(...NEB_REFLECT).mul(reflection)).toVar();
  const low = physical.r.min(physical.g).min(physical.b);
  const peak = physical.r.max(physical.g).max(physical.b).max(1e-5).toVar();
  physical.subAssign(vec3(low).mul(V.nebRealRich.clamp(0, 0.95)));
  // The haze subtraction takes brightness along with the chroma it is after; hand the brightness back, or
  // a vivid cloud dims into a dull one. Darkness between the clouds is coverage's job, never the palette's.
  physical.mulAssign(peak.div(physical.r.max(physical.g).max(physical.b).max(1e-5)));
  physical.mulAssign(V.nebRealCap.clamp(0.05, 1).div(peak).min(1));
  const old = mix(vec3(...NEB_OLD_TEAL), vec3(...NEB_OLD_HA), hot);
  return mix(old, physical, V.nebReal.clamp(0, 1)).mul(cov).mul(V.nebula);
}

/* The body. No light, no caustic, no cover shadow: whatever part of the fixed universe sits under this
   pixel, bent a little at the rim. Two crossing coils show the same stars, which is the whole trick. */
export function makeVoidMaterial(e, U, ctx) {
  const { position, vNormal, vWorld, firmament, V } = ctx;
  const m = new THREE.NodeMaterial();
  m.positionNode = position;
  m.fragmentNode = Fn(() => {
    const time = U.time;
    const live = step(0.5, U.motionScale);   // reduced motion parks the universe; it keeps its stars
    const n = normalize(vNormal);
    const aspect = screenSize.x.div(screenSize.y);
    const sp = vec2(screenUV.x.sub(0.5).mul(aspect), screenUV.y.sub(0.5)).toVar();
    // The jelly's toward-center warp, applied to the sampling coordinate instead of the scene: stars
    // bend inward at the silhouette. lens is in pixels, so it divides by the screen's short side.
    const nView = cameraViewMatrix.mul(vec4(n, 0)).xyz;
    // Only the silhouette bends: across the rest of the girth he is a flat window, so a coil crossing a coil shows one sky.
    const edge = smoothstep(V.lensBand.min(0.999), 1.0, dot(n, vec3(0, 1, 0)).abs().oneMinus());
    sp.assign(sp.sub(nView.xy.mul(V.lens).mul(edge).div(screenSize.y)));
    const p = firmament.uv(sp, V, time, live).toVar();
    // Stars are sized in pixels, so the field keeps its look at any viewport or device ratio.
    const col = firmament.stars(p, screenSize.y, V, time, live)
      .add(firmament.galaxies(p, V, time))
      .add(nebula(p, V, time, live)).toVar();
    // FrontSide hands this camera the tube's far wall, so the rim band takes |n.y| the way the sheen does.
    const rim = smoothstep(0.15, 0.85, dot(n, vec3(0, 1, 0)).abs().oneMinus());
    col.mulAssign(mix(vec3(1), vec3(V.rimGain), rim));
    col.addAssign(vec3(...SUN_CORE).mul(rim).mul(V.rimTint));
    const depthFrac = vWorld.y.negate().div(DEPTH).clamp(0, 1);
    // tint 1 keeps the water's absorption on him; 0 pre-divides it out without touching the compose pass.
    const comp = exp(vec3(...ABSORB).mul(depthFrac).mul(DEPTH));
    col.mulAssign(mix(vec3(1), comp, V.tint.oneMinus()));
    return vec4(col, depthFrac);
  })();
  m.side = THREE.FrontSide;
  return m;
}

/* A K-type orange dwarf at eye scale. Limb darkening off the world normal, the surface off the local
   one so it turns with his head the way an eyeball does; uSunHeat slides it to embers when he naps.
   `seed` is what keeps his two suns from being the same star. */
export function makeSunMaterial(e, U, V, seed) {
  const m = new THREE.NodeMaterial();
  m.fragmentNode = Fn(() => {
    const nW = normalize(normalWorld), nL = normalize(normalLocal);
    const sd = float(seed);
    const heat = e.uSunHeat.clamp(0, 1);
    const mu = nW.y.abs().max(0.02).pow(0.6);
    const grain = valueNoise2(vec2(nL.x.mul(4).add(e.uSunT.mul(0.25)).add(sd), nL.z.mul(4))).sub(0.5).mul(V.granule).mul(2);
    const sizzle = sin(e.uSizzleT.mul(37).add(e.uSeed)).mul(0.04).add(sin(e.uSizzleT.mul(91)).mul(0.02))
      .mul(V.sizzle).mul(heat);
    const hot = mix(vec3(...SUN_LIMB), vec3(...SUN_CORE), mu);
    // The blobby hot/cool face of the reference star: one slow low-frequency octave, hard-shouldered so
    // the patches have edges instead of reading as another wash.
    const surf = hot.toVar();
    If(V.blob.greaterThan(0), () => {
      const patch = smoothstep(0.40, 0.60, valueNoise2(vec2(nL.x.mul(2).add(e.uSunT.mul(0.07)).add(sd.mul(3.7)), nL.z.mul(2))));
      surf.assign(mix(hot, mix(hot.mul(0.72), mix(hot, vec3(...SUN_HOT), 0.4), patch), V.blob));
    });
    const col = mix(vec3(...SUN_EMBER).mul(0.34), surf, heat).mul(grain.add(sizzle).add(1)).mul(V.sunGain);
    return vec4(col, positionWorld.y.negate().div(DEPTH).clamp(0, 1));
  })();
  return m;
}

/* The flares: a thin band of activity at the limb, built in polar coordinates so nothing can wander out
   into the quad. A tight glow seats the disc, and a per-angle height field sends the occasional thin
   prominence licking off it. `uAng` ties the band to his face, `seed` makes one eye's limb not the other's. */
export function makeCoronaMaterial(e, U, V, seed) {
  const uAng = uniform(0);
  const m = new THREE.NodeMaterial();
  m.fragmentNode = Fn(() => {
    const sd = float(seed);
    const heat = e.uSunHeat.clamp(0, 1);
    const b = e.uFlareT;
    const p = uv().sub(0.5).mul(2);
    const d = length(p).toVar();
    const disc = float(2).div(V.coronaSize.max(1e-3)).toVar();   // the eye's radius, in this quad's half-width
    // Height above the limb in disc radii. Everything below is a function of it, so reach is a number
    // rather than whatever a thresholded field happened to leave standing.
    const h = d.div(disc).sub(1).max(0).toVar();
    // Shearing the angle with height curves a wisp as it climbs; much past 0.5 and the ring reads as a pinwheel.
    // The quad's exact center would be atan(0, 0), undefined in both backends, so x is nudged off zero there.
    const th = atan(p.y, p.x.add(step(d, float(1e-5)).mul(1e-3))).add(uAng).add(h.mul(V.flareCurl)).toVar();
    // Coprime angular harmonics rather than a hashed field: seamless at +-pi by construction, and every
    // clock coefficient is an integer, so the wrapped phase never pops and never loses float32 precision.
    const f = sin(th.mul(7).add(b.mul(3)).add(sd)).mul(0.9)
      .add(sin(th.mul(13).sub(b.mul(5)).add(sd.mul(2.3))))
      .add(sin(th.mul(19).add(b.mul(8)).add(sd.mul(3.7))).mul(0.8))
      .add(sin(th.mul(29).sub(b.mul(13)).add(sd.mul(5.1))).mul(0.6))
      .div(6.6).add(0.5).toVar();
    // A steep power is what keeps the limb mostly quiet: the typical angle barely clears the glow and only
    // the rare one where all four harmonics agree throws a tall, and therefore narrow, tongue. Heat is in
    // here as well as in the final color so the tongues retract into the disc as he cools rather than fading.
    // A zero base under a live exponent is pow(0, n), undefined below zero and 1 at zero, so the base is
    // floored and the exponent held positive: at the limb these decide whether a tongue exists at all.
    const H = f.max(1e-4).pow(V.flarePeak.max(0.5)).mul(V.flare).mul(heat).max(1e-4).toVar();
    const prom = h.div(H).oneMinus().max(0).pow(1.6);
    const glow = h.div(V.limbFall.max(1e-3)).oneMinus().max(0).pow(2);
    // The quad is additive, so the face has to be masked off or the glow would flatten the granules.
    const seat = smoothstep(disc.mul(0.86), disc, d).mul(smoothstep(0.93, 1.0, d).oneMinus());
    const a = glow.mul(V.limbGain).add(prom.mul(V.promGain)).mul(seat);
    const col = mix(vec3(...FLARE_HOT), vec3(...FLARE_RIM), smoothstep(0, 0.35, h));
    return vec4(col.mul(a).mul(V.coronaGain).mul(V.corona).mul(heat), 0);
  })();
  additive(m);
  m.uAng = uAng;
  return m;
}

/* The horizon sphere and its accretion ring. The lens quad and the orbiting specks are a later slice;
   these two are the meal itself. The renderer places and scales them from the eased open. */
export function makeSingularity(e, U, V) {
  const geoHorizon = new THREE.SphereGeometry(1, 12, 8);
  const geoRing = new THREE.PlaneGeometry(1, 1);
  const matHorizon = new THREE.NodeMaterial();
  matHorizon.fragmentNode = Fn(() => vec4(vec3(0), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
  const uRingAng = uniform(0);
  const matRing = new THREE.NodeMaterial();
  matRing.fragmentNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const d = length(p).toVar();
    const period = float(FLARE_CELLS).toVar();
    const ang = atan(p.y, p.x.add(step(d, float(1e-5)).mul(1e-3))).add(uRingAng).div(TWO_PI).mul(period);
    const n = fbm2Y(vec2(d.mul(3.0), ang), period);
    // The horizon's own edge in this quad's normalized radius; the ring is brightest right against it.
    const ringScale = V.ringScale.max(1.001);
    const inner = float(1).div(ringScale);
    // Falling edges are written as one-minus: a smoothstep with its edges reversed is undefined in WGSL and GLSL.
    const band = smoothstep(inner.sub(0.08), inner, d).mul(smoothstep(inner, 1.0, d).oneMinus());
    const col = mix(vec3(...FLARE_HOT), vec3(...RING_OUT), smoothstep(inner, 1.0, d));
    return vec4(col.mul(band).mul(n.mul(0.8).add(0.6)).mul(V.ringGain), 0);
  })();
  additive(matRing);
  matRing.side = THREE.DoubleSide;

  const horizon = new THREE.Mesh(geoHorizon, matHorizon);
  const ring = new THREE.Mesh(geoRing, matRing);
  ring.rotation.x = -Math.PI / 2;        // the camera is straight down, so the quad lies in the pond plane
  ring.renderOrder = 5;
  horizon.frustumCulled = ring.frustumCulled = false;
  horizon.visible = ring.visible = false;
  return {
    horizon, ring, uRingAng,
    spin(dt, live) { uRingAng.value = (uRingAng.value + dt * V.ringSpin.value * (live ? 1 : 0.2)) % (Math.PI * 2); },
    dispose() { geoHorizon.dispose(); geoRing.dispose(); matHorizon.dispose(); matRing.dispose(); },
  };
}

/* Additive RGB with the destination alpha left alone: an additive material that writes alpha would make
   the compose pass read its neighbors as floor-deep. */
function additive(m) {
  m.transparent = true;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.depthWrite = false;
}

/* The whole void bundle for one guest, built the first time an identity declares it and kept for the
   life of the body: the swap back to Eleanor only hides it. */
export function makeVoidSet(e, U, ctx) {
  e.uSunHeat = uniform(1);
  // The sizzle's clock, wrapped on the CPU in doubles: a float32 time hours old steps too coarsely for 91 rad/s.
  e.uSizzleT = uniform(0);
  // The flare's, wrapped at FLARE_WRAP so integer harmonics of it stay continuous across the wrap.
  e.uFlareT = uniform(0);
  // The sun face drifts through plain value noise, which is not periodic, so a modulo would pop it. This
  // one ping-pongs instead: continuous, bounded, and still fine-grained in float32 on a night-long tab.
  e.uSunT = uniform(0);
  const V = ctx.V;
  const body = makeVoidMaterial(e, U, ctx);
  // Two seeds, two suns: sharing one material is what made his eyes read as a matched pair of decals.
  const suns = [makeSunMaterial(e, U, V, 0), makeSunMaterial(e, U, V, 13.7)];
  const coronaMats = [makeCoronaMaterial(e, U, V, 0), makeCoronaMaterial(e, U, V, 6.4)];
  const coronaGeo = new THREE.PlaneGeometry(1, 1);
  const coronas = [new THREE.Mesh(coronaGeo, coronaMats[0]), new THREE.Mesh(coronaGeo, coronaMats[1])];
  for (const c of coronas) { c.rotation.x = -Math.PI / 2; c.renderOrder = 5; c.frustumCulled = false; c.visible = false; }
  const cloud = makeTailCloud(e, U, V, ctx);
  const hole = makeSingularity(e, U, V);
  ctx.group.add(coronas[0], coronas[1], hole.horizon, hole.ring);
  let coronaVisible = false;
  const setCoronaVisible = (v) => {
    if (coronaVisible === v) return;
    coronaVisible = v;
    for (const c of coronas) c.visible = v;
  };
  return {
    body, suns, coronaMats, coronas, cloud, hole, setCoronaVisible,
    show(v) {
      cloud.show(v);
      setCoronaVisible(v && V.corona.value > 0);
      if (!v) hole.horizon.visible = hole.ring.visible = false;
    },
    dispose() {
      body.dispose(); hole.dispose(); cloud.dispose(); coronaGeo.dispose();
      for (const m of suns) m.dispose();
      for (const m of coronaMats) m.dispose();
      ctx.group.remove(coronas[0], coronas[1], hole.horizon, hole.ring);
    },
  };
}
