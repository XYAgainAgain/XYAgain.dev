import * as THREE from 'three/webgpu';
import { texture, Fn, vec4, uv, uniform } from 'three/tsl';
import { VIEW_H, DEPTH, POOL_SCALE, MOON_ELEVATION, MOON_ORBIT_SECONDS, MAX_PIXELS, SIM_RES, CAUSTIC_RES, SEDIMENT_POOL, finite01 } from './config.js';
import { seedFromUrl, deriveSeed, createRng } from './rng.js';
import { WaterSim } from './sim.js';
import { CausticsPass } from './caustics.js';
import { createSceneUniforms, makeUnderwaterShading, createWaveSet, createCurrentSet } from './shading.js';
import { buildFloor, floorHeightAt, setTextureSize, setRelief } from './floor.js';
import { WakeBuffer } from './wake.js';
import { ReliefField } from './relief.js';
import { Habitat } from './cover.js';
import { EelSystem } from './eels.js';
import { attachBraincell } from './eel-brain.js';
import { attachFear } from './eel-fear.js';
import { attachAir } from './eel-air.js';
import { attachQuirks } from './eel-quirks.js';
import { attachCrush } from './eel-crush.js';
import { attachBond } from './eel-bond.js';
import { attachTreats } from './treats.js';
import { attachEleanor } from './eleanor.js';
import { Grazing } from './eel-graze.js';
import { TeaTime } from './eel-tea.js';
import { IDENTITIES } from './eel-identity.js';
import { growEel } from './eel-physics.js';
import { SurfacePass } from './surface.js';
import { ImpulseInjector, halfToFloat } from './impulse.js';
import { UnderwaterEffectsPool, KINDS as EFFECT_KINDS } from './effects.js';
import { RainScheduler } from './rain.js';
import { PadSystem } from './pads.js';
import { FloaterSystem } from './floaters.js';
import { PuffCloud } from './puff-cloud.js';
import { AlgaeTufts } from './algae.js';
import { Rushes } from './reeds.js';
import { createDetritus } from './detritus.js';
import { createDetritusMeshes } from './detritus-render.js';
import { PondInput, detectLoop } from './input.js';
import { PondAudio } from './audio.js';
import { readEelChoice, writeEelChoice, setupIdleFade, askAboutEels, bindSoundButton, bindEelToggle, bindNamesToggle, bindJunk } from './ui.js';
import { NameLabels } from './names.js';
import { QualityGovernor } from './quality.js';

const params = new URLSearchParams(location.search);
const root = document.documentElement;
let canvas = document.getElementById('pond');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motion = { reduced: reduceMotion.matches && params.get('motion') !== 'full' };

function viewSize() {
  const aspect = innerWidth / Math.max(1, innerHeight);
  return { w: VIEW_H * aspect, h: VIEW_H };
}

async function createRenderer(forceWebGL) {
  // A canvas holds one context type, so each attempt gets a fresh one.
  const fresh = canvas.cloneNode(false);
  canvas.replaceWith(fresh);
  canvas = fresh;
  const r = new THREE.WebGPURenderer({ canvas: fresh, antialias: false, forceWebGL, alpha: false });
  r.toneMapping = THREE.NoToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  await r.init();
  return r;
}

async function boot() {
  const seed = seedFromUrl();
  let renderer;
  try {
    // Firefox's WebGPU runs this scene at roughly half its WebGL2 rate with no visible difference, so it
    // starts on WebGL2; ?gl=0 forces WebGPU there, ?gl=1 forces WebGL2 anywhere.
    const firefox = /firefox/i.test(navigator.userAgent);
    renderer = await createRenderer(params.get('gl') === '1' || (firefox && params.get('gl') !== '0'));
  } catch (err) {
    console.warn('Pond: WebGPU init failed, retrying on WebGL2.', err);
    try { renderer = await createRenderer(true); }
    catch (err2) { console.error('Pond: no renderer available.', err2); root.classList.add('no-renderer'); return; }
  }
  const liveCanvas = renderer.domElement;
  root.dataset.backend = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  renderer.onDeviceLost = (info) => { console.error('Pond: device lost', info); renderer.setAnimationLoop(null); root.classList.add('no-renderer'); };

  const { w: viewW, h: viewH } = viewSize();
  const extent = POOL_SCALE * Math.max(viewW, viewH);
  // One live view object, kept current by resize(), shared with everything that needs the frame.
  const view = { w: viewW, h: viewH };

  const camera = new THREE.OrthographicCamera(-viewW / 2, viewW / 2, viewH / 2, -viewH / 2, 0.1, 20);
  camera.position.set(0, 5, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);

  const waveSet = createWaveSet(deriveSeed(seed, 31));
  const U = createSceneUniforms(waveSet, createCurrentSet(deriveSeed(seed, 1900)));
  const shading = makeUnderwaterShading(U);
  const sim = new WaterSim(renderer, extent);
  // The floor's cover shadow reads the mask and the live sim through the scene uniforms; swapped in
  // before any material builds, the same way the caustics pass replaces its placeholder.
  U.simTex = sim.read;
  U.simTexel = sim.uTexel;
  U.coverTex = sim.mask;
  U.maskExtent.value = sim.extent;
  const caustics = new CausticsPass(renderer, sim, U, viewW, viewH);
  // Nothing may ride the injector until this passes; rain and strider legs are its first customers.
  const impulse = new ImpulseInjector(renderer, sim);
  await impulse.probe();
  // Wake memory for the flora layers; runs from boot so the field is warm before anything reads it.
  const wake = new WakeBuffer(renderer, U, extent, seed);
  // Published before buildFloor so the floor, rocks, and bark can read the algae cover out of channel B.
  U.wakeTex = wake.read;
  U.wakeExtent.value = wake.extent;
  // The dig relief, on the wake buffer's footprint. Published before buildFloor so the sand material
  // can read it, and handed to floor.js so floorSurfaceAt sits on the same sand the shader draws.
  const relief = new ReliefField(extent);
  U.reliefTex = relief.read;
  U.reliefExtent = relief.uExtent;
  U.reliefTexel = relief.uTexel;
  U.reliefStep = relief.uStep;
  U.reliefStrength = relief.uStrength;
  setRelief(relief);
  const habitat = new Habitat();

  // ?tier=0–8 pins a rung for testing; otherwise the ladder resumes where the last session settled.
  const tierParam = params.get('tier');
  const pinnedTier = tierParam !== null && /^[0-8]$/.test(tierParam.trim()) ? +tierParam : null;
  const initialRung = pinnedTier ?? QualityGovernor.load();
  const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const texBase = mobile ? 1024 : 2048;
  // Known from the first frame, so a remembered rung 6 boots straight into small maps instead of re-decoding 2K.
  let texSizeNow = initialRung >= 6 ? texBase / 2 : texBase;

  const underScene = new THREE.Scene();
  // Anything floating *on* the water: the surface pass would refract it through the very surface it sits on.
  const overScene = new THREE.Scene();
  const { colliders, textures, shoals } = await buildFloor(underScene, shading, extent, seed, { w: viewW, h: viewH }, habitat, { textureSize: texSizeNow });
  sim.setObstacles(colliders.waterline.discs, colliders.waterline.capsules);
  // ?cast=jim,shelley pins those residents in first and freezes the off-screen rotation for testing;
  // a bare ?cast= freezes the seeded draw as-is.
  const cast = params.has('cast') ? (params.get('cast') ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const eels = new EelSystem(underScene, U, shading, seed, extent, colliders, sim, motion, view, { cast, debug: params.get('debug') === '1' });
  // ?brain= and ?moon= pin a 0–1 scalar for testing; a bare or junk value is no pin at all.
  const pin = (name) => { const raw = params.get(name); return raw === null || raw.trim() === '' ? null : finite01(Number(raw), null); };
  eels.pins = { brain: pin('brain'), moon: pin('moon') };
  eels.relief = relief;
  const eleanor = attachEleanor(eels, seed);
  // After Eleanor, so addModule's init hook reaches the guest too: she gets wits and module state at
  // attach time even though her controller never runs steer. Fear registers first, because the
  // braincell's focus reads this tick's panic out of it in the same prepass.
  const fear = attachFear(eels, seed);
  const braincell = attachBraincell(eels, seed);
  const effects = new UnderwaterEffectsPool();
  underScene.add(effects.mesh);
  eels.effects = effects;
  // Sediment is a second instance rather than more slots: premultiplied, so a dig puff occludes the
  // sand instead of glowing over it, on its own seeded stream so puff counts never move a decision.
  const sediment = new UnderwaterEffectsPool({ pool: SEDIMENT_POOL, blend: 'premultiplied', rng: createRng(deriveSeed(seed, 3171)), shading });
  // The floor's own albedo and uv scale, so a flying grain is a chip of the sand it came out of.
  sediment.setSubstrate(textures.sand?.albedo, 0.16 * (textures.sand?.tiling ?? 1));
  underScene.add(sediment.mesh);
  eels.sediment = sediment;
  // Last of the three, so its initEel sees the wits and fear state the other two already installed.
  const air = attachAir(eels, seed);
  // Where a flat pond would put the moon's reflection, from the same CPU-owned uniforms the surface
  // pass reads. The glitter itself wanders with the water normal; the eel is wrong about it anyway.
  eels.moonBiteAnchor = { x: 0, z: 0 };
  // Last of the four: its heading adapter wraps the braincell's, and its bonk watch reads the head
  // push the physics pass left behind.
  const quirks = attachQuirks(eels, seed);
  // After quirks: the crush's punchline emits a bonk, and its huff leans on the stim shuffle.
  const crush = attachCrush(eels, seed);
  // After the crush: a crush bout outranks a life bond, and the fit test asks the crush directly.
  const bond = attachBond(eels, seed);

  // MSAA here is the scene's antialiasing: the canvas only ever shows a fullscreen quad. 4, not 2,
  // because the WebGPU backend rounds any count under four down to one (getSampleCount in r185).
  const underRT = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, samples: 4,
  });
  const surface = new SurfacePass(renderer, sim, U, underRT, viewW, viewH);

  // ?view=caustics|under|sim|wake blits one intermediate target straight to the canvas.
  const debugView = params.get('view');
  let debugQuad = null;
  if (debugView) {
    const src = debugView === 'caustics' ? caustics.rt.texture : debugView === 'sim' ? sim.rtA.texture : debugView === 'wake' ? wake.rtA.texture : underRT.texture;
    const tex = texture(src);
    const m = new THREE.NodeMaterial();
    const gain = debugView === 'sim' ? 20 : debugView === 'caustics' ? 0.5 : 1;
    const uExtentDbg = uniform(sim.extent);
    m.fragmentNode = Fn(() => {
      // The wake view is cropped to the viewport so what you draw lands where you drew it; the other
      // views still show the whole pool. Signed fields sit on 0.5 grey; the algae channel stays raw blue.
      if (debugView === 'wake') {
        const xz = uv().sub(0.5).mul(surface.uView);
        const c = tex.sample(xz.div(uExtentDbg).add(0.5));
        return vec4(c.r.mul(0.5).add(0.5), c.g.mul(0.5).add(0.5), c.b, 1);
      }
      const c = tex.sample(uv());
      if (debugView === 'sim') return vec4(c.r.mul(gain).add(0.5), c.g.mul(gain).add(0.5), 0.5, 1);
      return vec4(c.rgb.mul(gain), 1);
    })();
    debugQuad = new THREE.QuadMesh(m);
    debugQuad.update = () => {
      if (debugView === 'sim') tex.value = sim.rtA.texture;
      if (debugView === 'wake') tex.value = wake.rtA.texture;
      if (debugView === 'caustics') tex.value = caustics.rt.texture;   // rung 6 reallocates it
    };
  }

  // Rung 5's internal-resolution step; the pixel budget is measured on the true DPR first, then this scales under it.
  let qualityScale = 1;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const px = innerWidth * innerHeight * dpr * dpr;
    const scale = (px > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / px) : 1) * qualityScale;
    renderer.setPixelRatio(dpr * scale);
    renderer.setSize(innerWidth, innerHeight, false);
    const { w, h } = viewSize();
    camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2;
    camera.updateProjectionMatrix();
    const rw = Math.max(1, Math.round(innerWidth * dpr * scale)), rh = Math.max(1, Math.round(innerHeight * dpr * scale));
    underRT.setSize(rw, rh);
    surface.setView(w, h);
    caustics.setView(w, h);
    eels.setView(w, h);
  }
  resize();
  let resizeQueued = false;
  addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; resize(); });
  });

  // Audio + UI
  const audio = new PondAudio();
  const soundBtn = document.getElementById('sound');
  bindSoundButton(soundBtn, document.getElementById('volume-panel'), audio, document.getElementById('mute'));
  // Dev-only mix console; the module never loads without the flag.
  if (params.get('mixer') === '1') import('./mixer.js').then((m) => m.attachMixer(audio)).catch((err) => console.warn('Pond: mixer failed to load', err));
  const eelToggleRender = bindEelToggle(document.getElementById('eel-toggle'), (v) => eels.setEnabled(v === 'yes'));
  const names = new NameLabels(document.getElementById('eel-names'), view);
  // ?debug=1&overlay=brain draws the context rings. Nothing is imported, allocated, or kept without it.
  let brainOverlay = null;
  if (params.get('debug') === '1' && params.get('overlay') === 'brain') {
    const { BrainOverlay } = await import('./debug-overlay.js');
    brainOverlay = new BrainOverlay(view);
  }
  bindNamesToggle(document.getElementById('names-toggle'), (on) => names.setEnabled(on));
  const moonKnobs = bindJunk({
    seg: document.getElementById('junk'),
    moon: document.getElementById('moon'),
    drawer: document.getElementById('controls-drawer'),
    cluster: document.querySelector('.chrome-controls'),
    volumeRows: document.querySelector('.volume-rows'),
    volumeWrap: document.getElementById('volume-panel'),
    volumeDock: document.getElementById('volume-dock'),
  });
  // jelly-kbd ships focusable button semantics; these caps are decorative labels, not controls.
  for (const k of document.querySelectorAll('.legend jelly-kbd')) { k.tabIndex = -1; k.removeAttribute('role'); }
  setupIdleFade(root);
  // World x → stereo pan; 0.8 keeps even edge-huggers a little off the speaker wall.
  const toPan = (x) => Math.max(-1, Math.min(1, x / (view.w / 2))) * 0.8;
  // Audio is one subscriber among several to come; pan arrives precomputed on the payload.
  eels.on('startle', (ev) => { ev.kind === 'eleanor' ? audio.eleanorStartle({ pan: ev.pan }) : audio.startle({ pan: ev.pan, length: ev.length }); });
  eels.on('eat', (ev) => audio.eat(ev.size ?? 1, { pan: ev.pan, rate: ev.kind === 'eleanor' ? 0.5 : 1 }));
  // Every crumb announces itself at the splash, click and held stream alike: the dimple and the plop
  // are subscribers, so the ring and the sound arrive with the crumb instead of with the button.
  eels.on('drop', (ev) => {
    // A crumb tapping a lily pad is a sound off a leaf, not a hole in the water.
    if (ev.detail?.pad) { audio.plop('smol', ev.pan); return; }
    const big = (ev.detail?.amount ?? 0.35) >= 0.75;
    sim.addDrop(ev.x, ev.z, big ? 0.18 : 0.14, big ? 0.012 : 0.006);
    audio.plop(big ? 'big' : 'smol', ev.pan);
  });
  // Thrown clean off the pool: one distant plip, and the pond never knew it existed.
  eels.on('void', (ev) => audio.plip(0.35, toPan(ev.x)));
  // The toss itself stays quiet: a whoosh on every held crumb at 250 BPM would be unbearable, and an
  // empty listener would still cost a payload per throw, so there is deliberately no subscriber.
  eels.on('slurp', (ev) => audio.slurp({ pan: ev.pan }));
  eels.on('nibble', (ev) => audio.tinyBub({ pan: ev.pan }));
  eels.on('sing', (ev) => audio.sing({ pan: ev.pan, notes: ev.food?.notes ?? 3 }));
  eels.on('headbutt', (ev) => audio.headbutt({ pan: ev.pan, length: ev.length }));
  eels.on('rescue', (ev) => audio.rescue({ pan: ev.pan }));
  eels.on('boop', (ev) => audio.boop({ pan: ev.pan }));
  // A scatter is the startle heard from farther off: same voice, quieter, so a whole pond bolting
  // does not stack into noise.
  eels.on('scatter', (ev) => audio.startle({ pan: ev.pan, length: ev.length, db: -8 }));
  // Deliberate silence until Sam records them: SFX-Wishlist rows "gape hiss", "lunge swish", "the sigh".
  const silent = () => {};
  eels.on('gape', silent);
  eels.on('lunge', silent);
  eels.on('overit', silent);
  eels.on('huff', silent);
  // A soft bonk (Q-A's snout probe) stays silent forever; the hard one waits on the thup.
  eels.on('bonk', silent);
  eels.on('spin', (ev) => audio.spin({ pan: ev.pan, revs: ev.detail?.revs ?? 3 }));
  eels.on('graze', (ev) => audio.graze({ pan: ev.pan, muffled: ev.food?.kind === 'algae' }));   // a tuft is eaten under water
  // Verticality, all placeholders until Sam records the wishlist rows (wet snout-pop, leap splash,
  // sand scrunch, wet snap on nothing). splash branches once: a belly flop is never both variants.
  eels.on('peek', (ev) => audio.peek({ pan: ev.pan }));
  eels.on('splash', (ev) => audio.splash({ pan: ev.pan, length: ev.length, bellyflop: !!ev.detail?.bellyflop }));
  eels.on('dig', (ev) => audio.dig({ pan: ev.pan }));
  eels.on('moonbite', (ev) => audio.moonbite({ pan: ev.pan }));

  // Showers own their own clock: envelope drives impulses, surface noise, and eel activity; intensity
  // alone drives the rain bed. ?rain=1 skips the wait and starts one now.
  const rain = new RainScheduler({ sim, injector: impulse, motion, view, surface, audio, bearing: waveSet.mainDir, seed });
  if (params.get('rain') === '1') rain.force();
  eels.rain = rain;
  rain.habitat = habitat;
  eels.habitat = habitat;

  // Flora: the pads publish their cover and perches to the habitat; the cover composer bakes the
  // shadow mask now and every 2 s after (the stems and mats of later phases move on that clock).
  const pads = new PadSystem({
    underScene, overScene, U, shading, sim, wake, seed, view: { w: viewW, h: viewH }, colliders, habitat, leaf: textures.leaf, motion,
    events: { drip: (x) => audio.drip({ pan: toPan(x) }), settle: (x) => audio.padSettle({ pan: toPan(x) }) },
  });
  // ?bloom=cycle runs the lilies through a whole night every 40 s; ?bloom=0.7 pins them.
  if (params.get('bloom') !== null) pads.bloomDebug = params.get('bloom');
  // Duckweed after the pads, so its speck seeding can exclude the pad discs already in the registry.
  const floaters = new FloaterSystem({
    overScene, U, sim, wake, shading, seed, view: { w: viewW, h: viewH }, colliders, habitat,
    carpet: textures.duckweed, rain, motion, pads,
  });
  // The lily puffs, after the floaters: the cloud eddies on the film's own current and hides under the
  // same mat silhouette, so it is built from those shared nodes and handed to the pads afterward.
  const puffs = new PuffCloud({ overScene, U, sim, floaters });
  pads.puffs = puffs;
  pads.floaters = floaters;
  // Tufts root on the rocks and logs the floor just built; the CPU bend reads the influence slots each frame.
  const algae = new AlgaeTufts({ underScene, U, shading, wake, seed, colliders, motion, view: { w: viewW, h: viewH } });
  // Rushes root in the shoals buildFloor just raised, and register their shadow proxies before the first bake.
  const rushes = new Rushes({ underScene, overScene, U, shading, wake, seed, shoals, colliders, habitat, motion, view: { w: viewW, h: viewH } });
  // After the pads, which the landing has to query, and before hand.feed, which is now a throw.
  const treats = attachTreats(eels, { overScene, pads, view, motion, U });
  // Floating litter: the drift and contact are the floaters' own collider tables and curl, so the litter
  // banks on the same rocks the specks do, and the dials land on pond.eels.knobs.detritus.
  const detritus = createDetritus({
    U, seed, view: { w: viewW, h: viewH }, wind: rain.wind, knobs: eels.knobs,
    current: (x, z, at, out) => floaters.currentAt(x, z, at, out),
    contact: (x, z, r, out) => floaters.obstacleContact(x, z, r, out),
    matField: (x, z) => floaters.memAt(x, z),
    floorAt: floorHeightAt,
  });
  rain.onFeatureDrop = (x, z, strength, radius) => detritus.ring(x, z, strength, radius);
  // The atlas arrives as the manifest's own set, whose albedo carries the cutout in its alpha; passing it
  // as `atlas` would look for an albedoOpacity key and silently fall back to the plain leaf map.
  const detritusMeshes = createDetritusMeshes({ U, sim, textures, buffers: detritus.buffers, pads, shading });
  overScene.add(detritusMeshes.sticks, detritusMeshes.cards, detritusMeshes.chunky);
  underScene.add(detritusMeshes.sinkTray);
  detritusMeshes.setCounts(detritus.draw);
  const litterShadow = 0.65;
  detritusMeshes.setShadow(litterShadow);
  eels.graze = new Grazing({ floaters, algae, pads, habitat });
  eels.tea = new TeaTime({ pads });
  eels.knobs.tea = eels.tea.knobs;   // pond.eels.knobs.tea.<dial>, tuned live
  eels.on('tea', (ev) => audio.sip({ pan: ev.pan, step: ev.food?.step ?? 0 }));
  eels.on('eat', (ev) => eels.tea.onMeal(ev));
  // A finished graze meal earns the nightcap roll too; per-bite furrow events would over-queue cups.
  eels.on('graze', (ev) => { if (!ev.food?.bite) eels.tea.onMeal(ev); });
  habitat.composeCover(sim);
  // Reseeds the algae field with the rocks, logs, and this first cover bake all known.
  wake.setSubstrate(colliders);
  let coverBakeAt = 2;

  // The quality ladder. The governor walks one rung at a time, so each rung's "off" is the exact inverse
  // of its "on"; these restore values are read here, before any rung has had a chance to apply.
  const uRestore = { algaeDetail: U.algaeDetail.value, coverWobble: U.coverWobble.value };
  // setQuality resets any field it is not given, so the whole desired state goes over on every call.
  const floaterQ = { speckFraction: 1, detile: true, pollenFraction: 1, pollen: true };
  const setFloaters = (patch) => { Object.assign(floaterQ, patch); floaters.setQuality({ ...floaterQ }); };
  let texChain = Promise.resolve();
  const setTex = (size) => {
    if (size === texSizeNow) return;
    texSizeNow = size;
    // Serialized: two decodes in flight would leave whichever finished last applied, not whichever was asked last.
    texChain = texChain
      .then(() => (texSizeNow === size ? setTextureSize(textures, size) : null))
      .catch((err) => console.warn('Pond: texture resize failed', err));
  };

  const RUNGS = {
    1: { on: () => setFloaters({ pollenFraction: 0.5 }), off: () => setFloaters({ pollenFraction: 1 }) },
    2: { on: () => rain.setCap(0.5), off: () => rain.setCap(1) },
    3: { on: () => setFloaters({ speckFraction: 0.4 }), off: () => setFloaters({ speckFraction: 1 }) },
    4: {
      on: () => {
        algae.setQuality({ tuftFraction: 0.5 });
        pads.setQuality({ lilyFraction: 0.4, puffScale: 0.5 });
        U.algaeDetail.value = 0;
        U.coverWobble.value = 0;
        setFloaters({ detile: false, pollen: false });
        treats.setQuality({ shadow: false });
        // Cards and chunky go, decorative twigs halve, the six shelter sticks stay: cover is ecology.
        detritus.setQuality({ cardFraction: 0, twigFraction: 0.5, chunkFraction: 0 });
        detritusMeshes.setCounts(detritus.draw);
        detritusMeshes.sinkTray.visible = false;
        detritusMeshes.setShadow(0);
      },
      off: () => {
        algae.setQuality({ tuftFraction: 1 });
        pads.setQuality({ lilyFraction: 1, puffScale: 1 });
        treats.setQuality({ shadow: true });
        detritus.setQuality({});
        detritusMeshes.setCounts(detritus.draw);
        detritusMeshes.sinkTray.visible = true;
        detritusMeshes.setShadow(litterShadow);
        U.algaeDetail.value = uRestore.algaeDetail;
        U.coverWobble.value = uRestore.coverWobble;
        setFloaters({ detile: true, pollen: true });
      },
    },
    5: {
      on: () => { qualityScale = 0.75; resize(); rushes.setQuality({ pxFloor: 2.5 }); },
      off: () => { qualityScale = 1; resize(); rushes.setQuality({ pxFloor: 0 }); },
    },
    6: {
      on: () => { sim.setResolution(384); caustics.setResolution(512); setTex(texBase / 2); },
      off: () => { sim.setResolution(SIM_RES); caustics.setResolution(CAUSTIC_RES); setTex(texBase); },
    },
    // 7 halves the caustic update rate in the frame loop; 8 only derives eels.perfHot, which Eleanor already reads.
  };

  function applyRung(rung, prev) {
    if (rung > prev) for (let r = prev + 1; r <= rung; r++) RUNGS[r]?.on();
    else for (let r = prev; r > rung; r--) RUNGS[r]?.off();
    eels.perfHot = rung >= 8;
  }
  const gov = new QualityGovernor({ initialRung, pinned: pinnedTier !== null, onChange: applyRung });

  // Audio already speaks for a nibble; this is the second subscriber, and it only makes bubbles.
  eels.on('nibble', (ev) => {
    const n = Math.random() < 0.5 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      effects.spawn(ev.x + (Math.random() - 0.5) * 0.1, ev.y + 0.03, ev.z + (Math.random() - 0.5) * 0.1, 'bubbleTiny');
    }
  });
  // One bubble per sung note, staggered over the phrase. The pool stamps spawn time at the call, so
  // the queue holds them and the frame loop drains it on effects.time, which is in scope here (t is not yet).
  const singBubs = [];
  eels.on('sing', (ev) => {
    const n = Math.max(1, Math.min(8, ev.food?.notes ?? 3));
    for (let i = 0; i < n; i++) {
      singBubs.push({ at: effects.time + (i * 0.6) / n, x: ev.x + (Math.random() - 0.5) * 0.1, y: ev.y + 0.03, z: ev.z + (Math.random() - 0.5) * 0.1 });
    }
  });

  // Input
  const toWorld = (cx, cy) => {
    const { w, h } = viewSize();
    return [(cx / innerWidth - 0.5) * w, (cy / innerHeight - 0.5) * h];
  };
  let swishUntil = 0;
  let lastCrackle = 0;
  // A finger through the water leaves a wake too; the frame loop hands the drag segment to the wake buffer.
  const finger = { x: 0, z: 0, px: 0, pz: 0, vx: 0, vz: 0, at: -1, moveAt: 0, path: null, idx: 0 };
  // One handler set: PondInput drives it live and eels.playInput drives the same functions, so a
  // recorded gesture makes the same water, sounds, and spooks a hand does.
  const hand = {
    poke: (x, z) => {
      const strength = motion.reduced ? 0.08 : 0.2;
      sim.addDrop(x, z, 0.5, strength);
      detritus.ring(x, z, strength, 0.5);
      floaters.tap(x, z);
      eels.spook(x, z, 1);
      audio.plip(1, toPan(x));
    },
    dragStart: () => {},
    dragMove: (x, z, moved, path) => {
      sim.addDrop(x, z, 0.55, Math.min(0.07, 0.01 + moved * 0.07));
      if (path.length < 8) eels.spook(x, z, 0.5, { cause: 'swish' }); else eels.lure(x, z);
      swishUntil = performance.now() + 180;
      audio.swish(true);
      audio.swishPan(toPan(x));
      // The frame loop walks path from finger.idx, so every coalesced sub-sample reaches the specks.
      if (finger.at < 0) { finger.px = x; finger.pz = z; finger.idx = path.length - 1; }
      finger.path = path;
      finger.x = x; finger.z = z; finger.at = performance.now();
    },
    dragEnd: (path) => {
      // A release inside a frame would drop the last coalesced samples; walk them here on the path's own clock.
      const n = path.length;
      if (finger.at >= 0 && n > 1 && finger.idx < n - 1) {
        const a = path[Math.max(0, finger.idx)], b = path[n - 1];
        const dtp = Math.max(1e-3, (b.t - a.t) / 1000);
        let vx = (b.x - a.x) / dtp, vz = (b.z - a.z) / dtp;
        const sp = Math.hypot(vx, vz);
        if (sp > 3) { vx *= 3 / sp; vz *= 3 / sp; }
        for (let k = Math.max(finger.idx, n - 1 - 16); k < n - 1; k++) {
          floaters.poke(path[k].x, path[k].z, path[k + 1].x, path[k + 1].z, vx, vz);
          detritus.poke(path[k].x, path[k].z, path[k + 1].x, path[k + 1].z, vx, vz);
        }
        wake.poke(a.x, a.z, b.x, b.z, vx, vz, 0.35, 16);
        rushes.poke(a.x, a.z, b.x, b.z, vx, vz);
      }
      finger.at = -1;
      finger.vx = 0; finger.vz = 0; finger.moveAt = 0;
      for (const p of path.slice(-6)) eels.lure(p.x, p.z);
    },
    // The crumb is born a pond depth up and the splash comes with it; the ring and the plop moved to
    // the drop listener so the click and the held stream both announce themselves at the landing.
    feed: (x, z) => {
      treats.toss(x, z, 1, { origin: 'click' });
      eels.holdFeed(x, z);
    },
    feedDragMove: (x, z) => eels.moveFeed(x, z),
    feedDragEnd: (path) => {
      eels.endFeed();
      const loop = detectLoop(path);
      if (loop) { eels.vortex(loop.x, loop.z, loop.radius); audio.crackle('med', { pan: toPan(loop.x) }); }
    },
    recolor: () => { eels.endFeed(); eels.recolor(); audio.crackle('lil'); },
    // A hand over the water with no button down: the cursor moves, nothing else does.
    hover: (x, z, gap) => eels.hoverFinger(x, z, gap),
    // sys.finger is the eels' copy of the snapshot; the prepass advances its clocks from here.
    input: (s) => {
      const f = eels.finger;
      if (s.gestureId !== f.gestureId) { f.gestureId = s.gestureId; f.heldFor = 0; f.stillFor = 0; }
      if (s.moveSeq !== f.moveSeq) { f.moveSeq = s.moveSeq; f.stillFor = 0; }
      f.mode = s.mode; f.x = s.x; f.z = s.z; f.vx = s.vx; f.vz = s.vz; f.speed = s.speed; f.vAge = 0;
    },
  };
  new PondInput(liveCanvas, toWorld, hand);
  // The script's vocabulary onto the same handlers; a synthetic path is one sample long, which the
  // drag branches already handle (under eight samples reads as a poke, not a swish).
  eels.inputHandlers = {
    poke: hand.poke,
    'drag-start': hand.dragStart,
    'drag-move': (x, z) => hand.dragMove(x, z, 0.2, [{ x, z, t: performance.now() }]),
    'drag-end': (x, z) => hand.dragEnd([{ x, z, t: performance.now() }]),
    'feed-start': hand.feed,
    'feed-move': hand.feedDragMove,
    'feed-end': () => hand.feedDragEnd([]),
    recolor: hand.recolor,
  };

  // Gate
  const dialog = document.getElementById('gate');
  let choice = readEelChoice();
  let revealTarget = 0;
  const applyChoice = (v) => { eels.setEnabled(v === 'yes'); eelToggleRender(v); };
  if (choice === 'yes' || choice === 'no') {
    applyChoice(choice);
    revealTarget = 1;
    root.classList.add('is-ready');
    // Return visits skip the gate, so the first tap on the water doubles as the audio unlock.
    // unlock() honors the stored mute preference, so a deliberately muted pond stays quiet.
    liveCanvas.addEventListener('pointerdown', () => audio.unlock(), { once: true });
  } else {
    eels.setEnabled(false);
    askAboutEels(dialog).then(async (v) => {
      writeEelChoice(v);
      applyChoice(v);
      revealTarget = 1;
      root.classList.add('is-ready');
      await audio.unlock();
      audio.setMuted(false);
    });
  }

  // A stray bubble is seen before it is heard: it leaves the mud, rises, and only then bloops and
  // rings. Rain stirs a few more loose ones out of the bottom, never a fizz of them.
  const pendingPops = [];
  let nextBubble = 6;
  function strayBubbles(now) {
    if (now < nextBubble) return;
    nextBubble = now + (7 + Math.random() * 13) / (1 + 0.6 * rain.envelope);
    const { w, h } = viewSize();
    const bx = (Math.random() - 0.5) * w * 0.9;
    const bz = (Math.random() - 0.5) * h * 0.9;
    // Narrow band on purpose: the pop is scheduled from the rise time, so arrival has to land while
    // the sprite is still bright rather than after it has faded out.
    const by = -DEPTH * (0.5 + Math.random() * 0.15);
    effects.spawn(bx, by, bz, 'bubble');
    pendingPops.push({ x: bx, z: bz, at: now - by / EFFECT_KINDS.bubble.rise });
  }

  function popBubbles(now) {
    for (let i = pendingPops.length - 1; i >= 0; i--) {
      const p = pendingPops[i];
      if (now < p.at) continue;
      pendingPops.splice(i, 1);
      effects.spawn(p.x, -0.02, p.z, 'pop');
      audio.shortBub({ pan: toPan(p.x) });
      if (!motion.reduced) sim.addDrop(p.x, p.z, 0.3, 0.02);
    }
  }

  // Idle ripples arrive from off-screen, so the pond never looks dead.
  let nextIdleDrop = 2;
  function idleDrops(now, dt) {
    if (motion.reduced) return;
    if (now < nextIdleDrop) return;
    nextIdleDrop = now + 2 + Math.random() * 4;
    const { w, h } = viewSize();
    const side = Math.floor(Math.random() * 4);
    const m = 1.5;
    const x = side < 2 ? (side === 0 ? -w / 2 - m : w / 2 + m) : (Math.random() - 0.5) * w;
    const z = side >= 2 ? (side === 2 ? -h / 2 - m : h / 2 + m) : (Math.random() - 0.5) * h;
    sim.addDrop(x, z, 0.8 + Math.random() * 0.8, 0.08 + Math.random() * 0.1);
  }

  /* The litter's own splashes, batched into the injector the pads and the rain already share. An impact
     also shoves what it ran into, since a branch outweighs a pad rim, a rush, and every twig it meets. */
  const wakePool = Array.from({ length: detritus.wakes.length }, () => ({ u: 0, v: 0, s: 0, r: 0 }));
  const wakeDrops = [];
  const spendWakes = () => {
    const n = detritus.wakeN;
    if (!n || !impulse.available) return;
    wakeDrops.length = 0;
    for (let i = 0; i < n; i++) {
      const w = detritus.wakes[i], d = wakePool[i];
      // sim.toUV inline: it returns a fresh pair, and this runs up to 16 times a frame.
      d.u = w.x / sim.extent + 0.5; d.v = w.z / sim.extent + 0.5;
      d.s = w.s; d.r = w.r * SIM_RES / sim.extent;
      wakeDrops.push(d);
      if (!w.hit) continue;
      pads.disturb(w.x, w.z, w.r);
      rushes.poke(w.x, w.z, w.x, w.z, 0, 0);
    }
    impulse.inject(wakeDrops);
  };

  // ?impulse=test: 40 micro-drops a frame over the middle of the pool, so the injector is visible
  // under both backends without waiting on a live shower. One reused array, no per-frame allocation.
  const testDrops = params.get('impulse') === 'test' ? Array.from({ length: 40 }, () => ({ u: 0, v: 0, s: 0.006, r: 2.5 })) : null;

  let causticFrame = 0;
  const timer = new THREE.Timer();
  timer.connect(document);
  let t = 0;
  let running = false;
  const moonDir = new THREE.Vector3();
  const epoch = (Date.now() / 1000) % MOON_ORBIT_SECONDS;
  // The pond's night clock: one orbit is one night. Lilies, mat growth, and later larvae read it.
  const moon = { az: 0, phase01: 0, cycles: 0 };

  // Frame-rate HUD; in debug mode every frame time is kept so pond.stats() can report averages and lows.
  const debug = params.get('debug') === '1';
  const fpsEl = document.getElementById('fps');
  const fpsEl2 = document.getElementById('fps2');
  const backendName = root.dataset.backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  document.getElementById('backend').textContent = backendName;
  document.getElementById('backend2').textContent = backendName;
  let fpsFrames = 0, fpsSince = 0, fpsLastLog = 0;
  const FRAME_SAMPLES = 20000;   // ~83 s at 240 Hz, ~5.5 min at 60 Hz: the right window for a percentile
  const frameTimes = [];
  const fpsStats = () => {
    const s = frameTimes.slice().sort((a, b) => a - b);
    if (!s.length) return null;
    const sum = s.reduce((a, b) => a + b, 0);
    const pick = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return { frames: s.length, rung: gov.rung, avgFps: +(s.length / sum).toFixed(1), medianMs: +(pick(0.5) * 1000).toFixed(2), low1pctFps: +(1 / pick(0.99)).toFixed(1), worstMs: +(s[s.length - 1] * 1000).toFixed(1), over16ms: s.filter((v) => v > 1 / 60).length };
  };
  function hud(rawDt, now) {
    fpsFrames++;
    if (now - fpsSince >= 0.5) {
      fpsEl.textContent = fpsEl2.textContent = `${Math.round(fpsFrames / (now - fpsSince))} FPS`;
      fpsFrames = 0; fpsSince = now;
    }
    if (!debug || t < 3) return;
    frameTimes.push(rawDt);
    // Left unbounded, the once-per-10-second sort would itself become the spike the instrument is measuring.
    if (frameTimes.length > FRAME_SAMPLES) frameTimes.splice(0, frameTimes.length - FRAME_SAMPLES);
    if (now - fpsLastLog >= 10) { fpsLastLog = now; console.log('Pond fps', JSON.stringify(fpsStats())); }
  }

  function frame() {
    timer.update();
    const rawDt = timer.getDelta();
    hud(rawDt, timer.getElapsed());
    if (debug && rawDt > 0.05 && t > 3) console.warn(`Pond: slow frame ${(rawDt * 1000).toFixed(0)} ms (drops ${sim.pending.length}, foods ${eels.foods.length}, eels ${eels.enabled})`);
    const dt = Math.min(rawDt, 0.05);
    t += dt;
    // Diegetic performance watcher: the ladder spends decorative budgets first and only gates Eleanor at the top.
    // A hidden tab's throttled frames are not the pond's fault; without the gate a background tab climbs to rung 8.
    if (!document.hidden) gov.update(rawDt * 1000);
    U.time.value = t % 4096;
    surface.uReveal.value += (revealTarget - surface.uReveal.value) * Math.min(1, dt * 1.2);

    const orbit = (epoch + t) / MOON_ORBIT_SECONDS;
    const az = orbit * Math.PI * 2;
    moon.az = az; moon.phase01 = orbit % 1; moon.cycles = Math.floor(t / MOON_ORBIT_SECONDS);
    U.moonPhase.value = moon.phase01;
    moonDir.set(Math.cos(MOON_ELEVATION) * Math.cos(az), Math.sin(MOON_ELEVATION), Math.cos(MOON_ELEVATION) * Math.sin(az));
    U.moonDir.value.copy(moonDir);
    const moonAz = Math.hypot(moonDir.x, moonDir.z) || 1;
    eels.moonBiteAnchor.x = surface.uMoonSpot.value * moonDir.x / moonAz;
    eels.moonBiteAnchor.z = surface.uMoonSpot.value * moonDir.z / moonAz;

    if (performance.now() > swishUntil) audio.swish(false);
    // Ahead of anything that spawns, so this frame's effects are stamped with this frame's clock.
    effects.setTime(t);
    sediment.setTime(t);
    puffs.setTime(t);
    for (let i = singBubs.length - 1; i >= 0; i--) {
      if (t < singBubs[i].at) continue;
      const q = singBubs[i];
      effects.spawn(q.x, q.y, q.z, 'bubbleTiny');
      singBubs.splice(i, 1);
    }
    idleDrops(t, dt);
    strayBubbles(t);
    popBubbles(t);
    eels.update(dt);
    // Past the fixed tick by the leftover accumulator, so a hard-flicked crumb does not step at 90 Hz.
    treats.setTime(eels.time + (eels.acc ?? 0));
    names.update(eels);
    brainOverlay?.update(eels);
    // Right after the eels wrote this frame's influence slots: drips, plops, and stalk swings read the live pose.
    pads.update(dt, t, rain, impulse);
    floaters.update(dt, t);
    // Litter steps on the frame clock with the specks' own dt ceiling inside, so a slept tab cannot
    // teleport it; it reads the influence slots eels.update just wrote and the pokes of the last frame.
    detritus.tick(dt);
    detritusMeshes.sync();
    spendWakes();
    algae.update(dt, t);
    rushes.update(dt, t);
    if (t > coverBakeAt) { coverBakeAt = t + 2; habitat.composeCover(sim); }
    // Before sim.update, so this frame's drops are stepped by the water they landed in.
    rain.update(dt);
    U.wind.value.set(rain.wind.x, rain.wind.z, rain.wind.gust, rain.wind.gustLag);
    U.rainEnv.value = rain.envelope;
    // Dry stone and bark soak in a couple of seconds and take about a minute to dry once the shower ends.
    U.wetAir.value += (rain.envelope - U.wetAir.value) * Math.min(1, dt / (rain.envelope > U.wetAir.value ? 2 : 60));
    if (testDrops) {
      for (const d of testDrops) { d.u = 0.3 + Math.random() * 0.4; d.v = 0.3 + Math.random() * 0.4; }
      impulse.inject(testDrops);
    }
    // Caustics follow the water, so they only need redrawing on frames the sim actually stepped.
    if (sim.update(dt) > 0 || t < 0.5) {
      // Rung 7 halves that again; the surface pass keeps sampling last frame's accumulation, which stays valid.
      causticFrame++;
      if (gov.rung < 7 || (causticFrame & 1) === 0 || t < 0.5) caustics.render();
    }
    // The drag segment since the last frame becomes a pointer capsule; a flick is capped so it shoves, not teleports.
    const nowMs = performance.now();
    if (finger.at >= 0 && nowMs - finger.at < 120) {
      let vx = (finger.x - finger.px) / Math.max(dt, 1e-3), vz = (finger.z - finger.pz) / Math.max(dt, 1e-3);
      const sp = Math.hypot(vx, vz);
      if (sp > 3) { vx *= 3 / sp; vz *= 3 / sp; }
      // The pointer handler is throttled well below the frame rate, so most frames of a real drag see no
      // movement at all. A hand mid-swish is still moving through the water: carry the last speed over.
      if (sp > 1e-4) { finger.vx = vx; finger.vz = vz; finger.moveAt = nowMs; }
      else {
        // Held at full for one throttle interval, then faded: a finger that has stopped must not keep
        // shoving litter, the rushes, and the wake field for the rest of the stale window.
        const f = 1 - Math.max(0, Math.min(1, (nowMs - finger.moveAt - 45) / 75));
        vx = finger.vx * f; vz = finger.vz * f;
      }
      // A finger crosses a texel in one frame where a body lingers for many, so it pushes 16× as hard.
      wake.poke(finger.px, finger.pz, finger.x, finger.z, vx, vz, 0.35, 16);
      rushes.poke(finger.px, finger.pz, finger.x, finger.z, vx, vz);
      pads.disturb(finger.x, finger.z);
      // The wake field gains nothing from sub-frame precision; the CPU speck sim and the noise carve do,
      // so they get every coalesced sample since the last frame, newest 16 at most.
      const path = finger.path;
      const walked = !!(path && path.length > 1);
      let fed = 0;
      if (walked) {
        let k = Math.max(finger.idx, path.length - 1 - 16);
        for (; k < path.length - 1; k++) {
          floaters.poke(path[k].x, path[k].z, path[k + 1].x, path[k + 1].z, vx, vz);
          detritus.poke(path[k].x, path[k].z, path[k + 1].x, path[k + 1].z, vx, vz);
          fed++;
        }
        finger.idx = path.length - 1;
      }
      if (!walked) floaters.poke(finger.px, finger.pz, finger.x, finger.z, vx, vz);
      // The litter collides with the hand rather than sampling a field, so it needs one on every frame of
      // a drag, not only the frames a new pointer sample landed on.
      if (!fed) detritus.poke(finger.px, finger.pz, finger.x, finger.z, vx, vz);
      finger.px = finger.x; finger.pz = finger.z;
    }
    // After eels.update wrote this frame's influence slots, before anything samples the field.
    wake.update(dt);
    // Costs nothing on a frame with no dig and no sand still settling back.
    relief.update(dt);

    if (U.litterShadow.value > 0) detritusMeshes.renderShadow(renderer);
    renderer.setRenderTarget(underRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(underScene, camera);
    if (debugQuad) { debugQuad.update(); renderer.setRenderTarget(null); debugQuad.render(renderer); }
    else {
      surface.render();
      // Drawn onto the composed canvas with no clear; materials in here own their own depth flags.
      if (overScene.children.length) {
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        try { renderer.render(overScene, camera); }
        finally { renderer.autoClear = prevAutoClear; }
      }
    }

    // Long sounds ride each creature's own panner, so they sweep the stereo field as it swims.
    if (audio.unlocked && eels.enabled) {
      for (const e of eels.eels) audio.setTrackPan(e.index, toPan(e.head.x));
      if (eleanor.body?.visible) audio.setTrackPan(eleanor.index, toPan(eleanor.head.x));
    }
    if (eels.enabled && t - lastCrackle > 4 && Math.random() < dt * 0.08) {
      lastCrackle = t;
      const e = eels.eels[Math.floor(Math.random() * eels.eels.length)];
      audio.crackle('auto', { length: e.length, track: e.index });
    }
    if (t > 1) eels.endPrewarm();
  }

  function start() {
    if (running || document.hidden) return;
    running = true;
    renderer.setAnimationLoop(frame);
  }
  function stop() {
    running = false;
    renderer.setAnimationLoop(null);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  // Reduced motion: calm water (heavy damping, faint swell) and slow eels, applied live on preference change.
  const applyMotion = () => {
    motion.reduced = reduceMotion.matches && params.get('motion') !== 'full';
    sim.uDamping.value = motion.reduced ? 0.975 : sim.damping;
    surface.uSlosh.value = motion.reduced ? 0.2 : 1.0;
    // Plant-owned idle motion (breeze, drift, stir) runs at a tenth; event responses keep full gain.
    U.motionScale.value = motion.reduced ? 0.1 : 1;
    rain.motionChanged();
  };
  reduceMotion.addEventListener('change', applyMotion);
  applyMotion();
  start();

  if (params.get('debug') === '1') {
    // pond.diag() reads back every intermediate target and prints mean/max/NaN so a black screen has numbers behind it.
    const stats = async (rt, label) => {
      const w = Math.min(rt.width, 64), h = Math.min(rt.height, 64);
      // Sample the center: the corners of the sim are its sponge ring and always read zero.
      const raw = await renderer.readRenderTargetPixelsAsync(rt, (rt.width - w) >> 1, (rt.height - h) >> 1, w, h);
      // Half-float targets read back as raw uint16; decode so the stats mean something.
      const px = raw instanceof Uint16Array ? Array.from(raw, (u) => halfToFloat(u)) : raw;
      let sum = [0, 0, 0, 0], max = [-1e9, -1e9, -1e9, -1e9], nan = 0;
      for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 4; c++) {
        const v = px[i + c];
        if (Number.isNaN(v)) { nan++; continue; }
        sum[c] += v; if (v > max[c]) max[c] = v;
      }
      const n = px.length / 4;
      console.log(label, rt.width + 'x' + rt.height, 'mean', sum.map((v) => (v / n).toFixed(4)).join(' '), 'max', max.map((v) => v.toFixed(3)).join(' '), 'nan', nan);
    };
    window.pond = {
      renderer, sim, caustics, eels, eleanor, braincell, fear, air, quirks, crush, bond, treats, U, surface, seed, overScene, impulse, effects, sediment, puffs, rain, wake, relief, habitat, moon, pads, floaters, algae, rushes, detritus, detritusMeshes, textures, audio,
      grow: (i, d = 1) => growEel(eels.eels[i], d),
      swap: (i, name) => eels.swapIdentity(eels.eels[i], name ? IDENTITIES.find((id) => id.name.toLowerCase() === name.toLowerCase()) : null),
      stats: fpsStats,
      // pond.play('held-feed') or pond.play([...]): recorded input on the simulation clock.
      play: async (src) => {
        const script = Array.isArray(src) ? src : await (await fetch(`/.dev/tests/fixtures/${src}.json`)).json();
        return eels.playInput(script) ? script.length : 0;
      },
      moonButton: moonKnobs,
      quality: { get rung() { return gov.rung; }, get ema() { return gov.ema; }, get pinned() { return gov.pinned; }, setRung: (n) => gov.setRung(n) },
      diag: async () => {
        console.log('backend', root.dataset.backend, 'moonDir', U.moonDir.value.toArray().map((v) => v.toFixed(3)).join(' '), 'moonPhase', moon.phase01.toFixed(3), 'wind', U.wind.value.toArray().map((v) => v.toFixed(2)).join(' '));
        await stats(sim.rtA, 'sim');
        await stats(caustics.rt, 'caustics');
        await stats(underRT, 'under');
        await stats(wake.rtA, 'wake');
      },
    };
    eels.on('swap', (p) => console.log('pond: ' + p.food.from + ' swam off, ' + p.food.to + ' swam in'));
    console.log('pond seed', seed, 'backend', root.dataset.backend, '- pond.diag() for target stats, pond.stats() for frame times');
  }
}

boot().catch((err) => {
  console.error('Pond failed to start', err);
  root.classList.add('no-renderer');
});
