import * as THREE from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, uv, sin, atan, mix, smoothstep, step, dot, length, exp, normalize, cameraViewMatrix, positionWorld, normalWorld, normalLocal, screenUV, screenSize, viewportTexture, texture, If, Discard, TWO_PI } from 'three/tsl';
import { DEPTH } from './config.js';
import { valueNoise2, fbm2Y } from './shading.js';
import { makeTailCloud } from './eel-tail-cloud.js';
import { NEB_PERIOD } from './void-sky-core.js';

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

// ?voiddebug=nostars,nogal,noneb,notail,nocorona,nobody (and nometeor, nocomet, nowave, nosession, noflash,
// nolens) seeds the show* dials below with that layer off, so a frame-time drop can be pinned on its owner.
const VOID_DEBUG = new Set(String(new URLSearchParams(globalThis.location?.search ?? '').get('voiddebug') ?? '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
const seedOn = (token) => (VOID_DEBUG.has(token) ? 0 : 1);
const tmpSize = new THREE.Vector2();

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
    // The self-swallow's last frame: the ring at collapseScale times its size, held collapseHold seconds
    // (0 is exactly one frame).
    collapseScale: { value: 3 }, collapseHold: { value: 0 },
    // The lens at his mouth: pull is the bend at the horizon's edge in screen heights, times the meal's
    // scale; eps is the depth slack a bent sample needs to count as behind the hole.
    lensPull: { value: 0.06 }, lensEps: uniform(0.01),
    // Meteors: the mean wait in seconds between streaks (20 to 60 s at 40, doubled under reduced motion,
    // 0 for none), then the streak's look. One in twelve is a comet; its tail and spread are screen heights.
    meteors: { value: 40 }, meteorGain: uniform(2.5), meteorWidth: { value: 1.1 },
    cometGain: uniform(1.2), cometComa: { value: 2.4 }, cometTail: { value: 0.09 }, cometSpread: uniform(0.02),
    // Session stars and the pinprick each one is born with; flashSize is the flash's core in pixels.
    sessionGain: uniform(4), flashGain: uniform(3), flashSize: uniform(2.2),
    // The finger's gravity wave: displacement at the crest and its width, both in screen heights, the
    // seconds it takes to cross his body and to settle after, and how close to him counts as a touch.
    waveAmp: { value: 0.02 }, waveWidth: uniform(0.04), waveCross: { value: 0.6 }, waveSettle: { value: 0.4 },
    waveReach: { value: 1.3 },
    // How far the moon's reflection leans toward his peeking head, in world units, full inside half a unit
    // and gone at two. Negative leans it away, which is the other reading of the plan.
    moonPull: { value: 0.04 },
    // Profiling switches, 1 on and 0 off. The three sky layers are uniform Ifs that skip their math; tail,
    // corona, and body take their draws off the render list on the next sync, while the stage keeps them.
    showStars: uniform(seedOn('nostars')), showGal: uniform(seedOn('nogal')), showNeb: uniform(seedOn('noneb')),
    showTail: { value: seedOn('notail') }, showCorona: { value: seedOn('nocorona') }, showBody: { value: seedOn('nobody') },
    // Slice D's terms, each a uniform If that is false at rest; the lens is a draw.
    showMeteor: uniform(seedOn('nometeor')), showComet: uniform(seedOn('nocomet')), showWave: uniform(seedOn('nowave')),
    showSession: uniform(seedOn('nosession')), showFlash: uniform(seedOn('noflash')), showLens: { value: seedOn('nolens') },
  };
}

/* Three octaves of iterated domain warp, baked once per page into a repeating tile (void-nebula.js) and
   read here in one fetch. `scroll` is the CPU's accumulated drift through it, wrapped at a whole tile. */
function nebula(p, V, scroll, tile) {
  const q = p.mul(V.nebFreq).add(scroll);
  const s = texture(tile, q.div(NEB_PERIOD)).toVar();
  const a = s.x, b = s.y;
  const c = b.toVar(), f = a.mul(0.6).add(b.mul(0.4)).toVar();
  If(V.nebOct.greaterThan(2.5), () => {
    c.assign(s.z);
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

/* What the body used to rebuild every fragment, now set once per render on the CPU: the universe's rotation
   and drift offset, the spike axis, and the target's aspect. Done on the render, not in syncVoid, so an
   arrival frame or a motion flip can never draw last visit's sky. */
function voidFrame(V, firmament) {
  const f = {};
  const rot = uniform(new THREE.Vector4(1, 0, 0, 0)).onRenderUpdate((_, u) => {
    // The same function the CPU uses to place a drop, so a star lands where the shader will draw it. It
    // only reads the loop: a render can run more than once a frame, and renderer.sync owns the step.
    firmament.frame(f);
    u.value.set(f.c, f.s, f.ox, f.oy);
  });
  const spike = uniform(new THREE.Vector2(1, 0)).onRenderUpdate((_, u) => {
    u.value.set(Math.cos(V.spikeAngle.value), Math.sin(V.spikeAngle.value));
  });
  const aspect = targetAspect((a) => { if (firmament) firmament.aspect = a; });
  return { rot, spike, aspect };
}

/* ScreenNode's own rule for screenSize: the bound target's size, else the drawing buffer's. */
function targetAspect(onValue = null) {
  return uniform(1).onRenderUpdate(({ renderer }) => {
    const rt = renderer.getRenderTarget();
    const w = rt ? rt.width : renderer.getDrawingBufferSize(tmpSize).x;
    const h = rt ? rt.height : tmpSize.y;
    const a = h > 0 ? w / h : 1;
    onValue?.(a);
    return a;
  });
}

/* The body. No light, no caustic, no cover shadow: whatever part of the fixed universe sits under this
   pixel, bent a little at the rim. Two crossing coils show the same stars, which is the whole trick. */
export function makeVoidMaterial(e, U, ctx) {
  const { position, vNormal, vWorld, firmament, V, nebTile } = ctx;
  const F = voidFrame(V, firmament);
  const m = new THREE.NodeMaterial();
  m.positionNode = position;
  m.fragmentNode = Fn(() => {
    const live = step(0.5, U.motionScale);   // reduced motion halves the twinkle; the CPU freezes the motion
    const n = normalize(vNormal);
    const sp = vec2(screenUV.x.sub(0.5).mul(F.aspect), screenUV.y.sub(0.5)).toVar();
    // The jelly's toward-center warp, applied to the sampling coordinate instead of the scene: stars
    // bend inward at the silhouette. lens is in pixels, so it divides by the screen's short side.
    const nView = cameraViewMatrix.mul(vec4(n, 0)).xyz;
    // Only the silhouette bends: across the rest of the girth he is a flat window, so a coil crossing a coil shows one sky.
    const edge = smoothstep(V.lensBand.min(0.999), 1.0, dot(n, vec3(0, 1, 0)).abs().oneMinus());
    sp.assign(sp.sub(nView.xy.mul(V.lens).mul(edge).div(screenSize.y)));
    const p = firmament.uv(sp, F.rot).toVar();
    // The finger's ring bends the universe itself, so every layer below rides it.
    firmament.warp(p, V);
    // Stars are sized in pixels, so the field keeps its look at any viewport or device ratio. Each layer
    // sits behind its show dial as a uniform If, so switching one off drops its whole cost.
    const col = vec3(0).toVar();
    If(V.showStars.greaterThan(0.5), () => { col.addAssign(firmament.stars(p, screenSize.y, V, live, F.spike)); });
    col.addAssign(firmament.galaxies(p, V));
    If(V.showNeb.greaterThan(0.5), () => { col.addAssign(nebula(p, V, firmament.uNebScroll, nebTile)); });
    // Each of these is behind its own uniform If and costs one compare until something happens.
    col.addAssign(firmament.session(p, screenSize.y, V, live));
    col.addAssign(firmament.meteor(p, screenSize.y, V));
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
    // The quad is additive, so the face has to be masked off or the glow would flatten the granules.
    const seat = smoothstep(disc.mul(0.86), disc, d).mul(smoothstep(0.93, 1.0, d).oneMinus()).toVar();
    const out = vec3(0).toVar();
    // The seat is exactly zero over the face and in the quad's corners: the branch skips the harmonics
    // there (WebGPU demotes a discard and runs on), and the discard skips the blend.
    If(seat.greaterThan(0), () => {
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
    const a = glow.mul(V.limbGain).add(prom.mul(V.promGain)).mul(seat);
    const col = mix(vec3(...FLARE_HOT), vec3(...FLARE_RIM), smoothstep(0, 0.35, h));
    out.assign(col.mul(a).mul(V.coronaGain).mul(V.corona).mul(heat));
    }).Else(() => { Discard(); });
    return vec4(out, 0);
  })();
  additive(m);
  m.uAng = uAng;
  return m;
}

/* The horizon sphere, its accretion ring, and the lens. The renderer places and scales all three from
   the eased open; the orbiting specks belong to floaters.js. */
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
  // r185 draws a transparent DoubleSide twice, back pass then front; a flat quad lights only one of them.
  matRing.forceSinglePass = true;

  const lens = makeLens(V);
  const horizon = new THREE.Mesh(geoHorizon, matHorizon);
  const ring = new THREE.Mesh(geoRing, matRing);
  const lensMesh = new THREE.Mesh(geoRing, lens.material);
  const capture = new THREE.Mesh(geoRing, lens.capture);
  // The camera is straight down, so both quads lie in the pond plane.
  ring.rotation.x = lensMesh.rotation.x = -Math.PI / 2;
  ring.renderOrder = 5;
  // Drawn after the jellies' 2 and their depth pass's 2.5, clear of the tufts' 3; what it bends is the
  // capture taken before the first jelly.
  lensMesh.renderOrder = 2.9;
  // After every opaque and before the first jelly; nothing else in the under-scene sits between 1 and 2.
  capture.renderOrder = 1.9;
  // Its triangles cover no pixel: the draw exists only so its copy runs at that point in the frame.
  capture.scale.setScalar(0);
  horizon.frustumCulled = ring.frustumCulled = lensMesh.frustumCulled = capture.frustumCulled = false;
  horizon.visible = ring.visible = lensMesh.visible = capture.visible = false;
  return {
    horizon, ring, uRingAng, lens: lensMesh, capture, uLens: lens.uLens,
    spin(dt, live) { uRingAng.value = (uRingAng.value + dt * V.ringSpin.value * (live ? 1 : 0.2)) % (Math.PI * 2); },
    dispose() {
      geoHorizon.dispose(); geoRing.dispose(); matHorizon.dispose(); matRing.dispose();
      lens.material.dispose(); lens.capture.dispose();
      // r185 copies into a per-target clone of the texture, which the tap holds as its value after a draw.
      if (lens.grab.value !== lens.frame) lens.grab.value?.dispose();
      lens.frame.dispose();
    },
  };
}

/* The jelly's framebuffer tap, bent toward the hole. The quad is 4 horizon radii and the horizon its inner
   quarter; a pixel at d samples strength × r_h / d nearer the center, which folds the floor's far side
   around the rim the way a real lens does. Only the opaque under-target is in the copy. */
function makeLens(V) {
  // x: the pull at the horizon's edge in screen heights; y: the horizon's own depth, for the validity test.
  const uLens = uniform(new THREE.Vector2(0, 0));
  const aspect = targetAspect();
  // Its own texture, never the shared one: each jelly rewrites that singleton just before its own draw,
  // so by order 3 it holds every jelly but the last. Half float, as the under-target is.
  const frame = new THREE.FramebufferTexture();
  frame.type = THREE.HalfFloatType;
  frame.minFilter = THREE.LinearFilter;
  frame.generateMipmaps = false;
  const grab = viewportTexture(screenUV, null, frame);
  // The capture's draw copies at order 1.9. The lens's clone resolves to the same per-target texture,
  // which is also r185's dedupe key, so at order 2.9 it finds the copy done and takes none of its own.
  const capture = new THREE.NodeMaterial();
  capture.fragmentNode = Fn(() => vec4(grab.rgb.mul(0), 0))();
  capture.colorWrite = false;
  capture.depthWrite = false;
  capture.depthTest = false;
  capture.transparent = true;
  capture.side = THREE.DoubleSide;
  capture.forceSinglePass = true;
  const m = new THREE.NodeMaterial();
  m.fragmentNode = Fn(() => {
    const s = uv().sub(0.5).mul(2).toVar();
    const d = length(s).toVar();
    // Quad +x is screen right and quad +y is world -z, which is screen up: toward the center is (-x, +y).
    const disp = uLens.x.mul(0.25).div(d.max(0.25));
    const toward = vec2(s.x.negate().div(aspect), s.y).div(d.max(1e-4));
    const bent = grab.sample(screenUV.add(toward.mul(disp)));
    // A bent sample that lands on something nearer than the hole would drag foreground through it.
    const valid = step(uLens.y.sub(V.lensEps), bent.a);
    // Inside the horizon the black sphere has to show; past 4 r_h are the quad's empty corners.
    If(step(0.25, d).mul(step(d, 1)).mul(valid).lessThan(0.5), () => { Discard(); });
    return vec4(bent.rgb, smoothstep(0.25, 1.0, d).oneMinus());
  })();
  // The jelly's blend: src-alpha over, destination alpha (scene depth) left alone.
  m.transparent = true;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.forceSinglePass = true;
  return { material: m, capture, frame, grab, uLens };
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
  ctx.group.add(coronas[0], coronas[1], hole.horizon, hole.ring, hole.lens, hole.capture);
  let coronaVisible = false;
  const setCoronaVisible = (v) => {
    if (coronaVisible === v) return;
    coronaVisible = v;
    for (const c of coronas) c.visible = v;
  };
  const lit = (d) => !(Number(d.value) < 0.5);   // junk reads as on: a debug switch never hides by accident
  return {
    body, suns, coronaMats, coronas, cloud, hole, setCoronaVisible,
    /* The show* switches for the three meshes, once per sync. material.visible takes a draw off the render
       list without touching mesh visibility, which show() and the stage own, and it survives every swap. */
    layers() {
      body.visible = lit(V.showBody);
      cloud.mesh.material.visible = lit(V.showTail);
      for (const m of coronaMats) m.visible = lit(V.showCorona);
      hole.lens.material.visible = hole.capture.material.visible = lit(V.showLens);
    },
    // The warm-up has to see every pipeline whatever the switches or a persisted rung 6 say; layers()
    // and the next show() put them back, since setCoronaVisible keeps its cache in step.
    allLayers() {
      body.visible = cloud.mesh.material.visible = hole.lens.material.visible = hole.capture.material.visible = true;
      for (const m of coronaMats) m.visible = true;
      setCoronaVisible(true);
    },
    show(v) {
      cloud.show(v);
      setCoronaVisible(v && V.corona.value > 0);
      if (!v) hole.horizon.visible = hole.ring.visible = hole.lens.visible = hole.capture.visible = false;
    },
    dispose() {
      body.dispose(); hole.dispose(); cloud.dispose(); coronaGeo.dispose();
      for (const m of suns) m.dispose();
      for (const m of coronaMats) m.dispose();
      ctx.group.remove(coronas[0], coronas[1], hole.horizon, hole.ring, hole.lens, hole.capture);
    },
  };
}
