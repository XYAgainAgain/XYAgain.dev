import * as THREE from 'three/webgpu';
import { texture, Fn, vec4, uv, uniform } from 'three/tsl';
import { VIEW_H, DEPTH, POOL_SCALE, MOON_ELEVATION, MOON_ORBIT_SECONDS, MAX_PIXELS } from './config.js';
import { seedFromUrl, deriveSeed } from './rng.js';
import { WaterSim } from './sim.js';
import { CausticsPass } from './caustics.js';
import { createSceneUniforms, makeUnderwaterShading, createWaveSet, createCurrentSet } from './shading.js';
import { buildFloor } from './floor.js';
import { WakeBuffer } from './wake.js';
import { Habitat } from './cover.js';
import { EelSystem } from './eels.js';
import { attachEleanor } from './eleanor.js';
import { Grazing } from './eel-graze.js';
import { IDENTITIES } from './eel-identity.js';
import { growEel } from './eel-physics.js';
import { SurfacePass } from './surface.js';
import { ImpulseInjector, halfToFloat } from './impulse.js';
import { UnderwaterEffectsPool, KINDS as EFFECT_KINDS } from './effects.js';
import { RainScheduler } from './rain.js';
import { PadSystem } from './pads.js';
import { FloaterSystem } from './floaters.js';
import { AlgaeTufts } from './algae.js';
import { PondInput, detectLoop } from './input.js';
import { PondAudio } from './audio.js';
import { readEelChoice, writeEelChoice, setupIdleFade, askAboutEels, bindSoundButton, bindEelToggle, bindNamesToggle } from './ui.js';
import { NameLabels } from './names.js';

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
  const habitat = new Habitat();

  const underScene = new THREE.Scene();
  // Anything floating *on* the water: the surface pass would refract it through the very surface it sits on.
  const overScene = new THREE.Scene();
  const { colliders, textures } = await buildFloor(underScene, shading, extent, seed, { w: viewW, h: viewH }, habitat);
  sim.setObstacles(colliders.waterline.discs, colliders.waterline.capsules);
  // ?cast=jim,shelley pins those residents in first and freezes the off-screen rotation for testing;
  // a bare ?cast= freezes the seeded draw as-is.
  const cast = params.has('cast') ? (params.get('cast') ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const eels = new EelSystem(underScene, U, shading, seed, extent, colliders, sim, motion, view, { cast });
  const eleanor = attachEleanor(eels, seed);
  const effects = new UnderwaterEffectsPool();
  underScene.add(effects.mesh);

  // MSAA here is the scene's antialiasing: the canvas only ever shows a fullscreen quad. 2× is the budget.
  const underRT = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, samples: 2,
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
    };
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const px = innerWidth * innerHeight * dpr * dpr;
    const scale = px > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / px) : 1;
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
  bindSoundButton(soundBtn, document.getElementById('volume-panel'), audio);
  // Dev-only mix console; the module never loads without the flag.
  if (params.get('mixer') === '1') import('./mixer.js').then((m) => m.attachMixer(audio)).catch((err) => console.warn('Pond: mixer failed to load', err));
  const eelToggleRender = bindEelToggle(document.getElementById('eel-toggle'), (v) => eels.setEnabled(v === 'yes'));
  const names = new NameLabels(document.getElementById('eel-names'), view);
  bindNamesToggle(document.getElementById('names-toggle'), (on) => names.setEnabled(on));
  setupIdleFade(root);
  // World x → stereo pan; 0.8 keeps even edge-huggers a little off the speaker wall.
  const toPan = (x) => Math.max(-1, Math.min(1, x / (viewSize().w / 2))) * 0.8;
  // Audio is one subscriber among several to come; pan arrives precomputed on the payload.
  eels.on('startle', (ev) => { ev.source === 'eleanor' ? audio.eleanorStartle({ pan: ev.pan }) : audio.startle({ pan: ev.pan, length: ev.length }); });
  eels.on('eat', (ev) => audio.eat(ev.size ?? 1, { pan: ev.pan, rate: ev.source === 'eleanor' ? 0.5 : 1 }));
  eels.on('slurp', (ev) => audio.slurp({ pan: ev.pan }));
  eels.on('nibble', (ev) => audio.tinyBub({ pan: ev.pan }));
  eels.on('sing', (ev) => audio.sing({ pan: ev.pan, notes: ev.food?.notes ?? 3 }));
  eels.on('headbutt', (ev) => audio.headbutt({ pan: ev.pan, length: ev.length }));
  eels.on('rescue', (ev) => audio.rescue({ pan: ev.pan }));
  eels.on('graze', (ev) => audio.graze({ pan: ev.pan, muffled: ev.food?.kind === 'algae' }));   // a tuft is eaten under water

  // Showers own their own clock: envelope drives impulses, surface noise, and eel activity; intensity
  // alone drives the rain bed. ?rain=1 skips the wait and starts one now.
  const rain = new RainScheduler({ sim, injector: impulse, motion, view, surface, audio, bearing: waveSet.mainDir });
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
    carpet: textures.duckweed, rain, motion,
  });
  // Tufts root on the rocks and logs the floor just built; the CPU bend reads the influence slots each frame.
  const algae = new AlgaeTufts({ underScene, U, shading, wake, seed, colliders, motion, view: { w: viewW, h: viewH } });
  eels.graze = new Grazing({ floaters, algae, pads, habitat });
  habitat.composeCover(sim);
  // Reseeds the algae field with the rocks, logs, and this first cover bake all known.
  wake.setSubstrate(colliders);
  let coverBakeAt = 2;

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
  const finger = { x: 0, z: 0, px: 0, pz: 0, at: -1, path: null, idx: 0 };
  // R-hold crumbs drop on a fixed 250 BPM clock (Tetris-ish tempo), moving or not.
  const CRUMB_MS = 60000 / 250;
  let feeding = null;
  let nextCrumbAt = 0;
  new PondInput(liveCanvas, toWorld, {
    poke: (x, z) => {
      sim.addDrop(x, z, 0.5, motion.reduced ? 0.08 : 0.2);
      eels.spook(x, z, 1);
      audio.plip(1, toPan(x));
    },
    dragStart: () => {},
    dragMove: (x, z, moved, path) => {
      sim.addDrop(x, z, 0.55, Math.min(0.07, 0.01 + moved * 0.07));
      if (path.length < 8) eels.spook(x, z, 0.5); else eels.lure(x, z);
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
        for (let k = Math.max(finger.idx, n - 1 - 16); k < n - 1; k++) floaters.poke(path[k].x, path[k].z, path[k + 1].x, path[k + 1].z, vx, vz);
        wake.poke(a.x, a.z, b.x, b.z, vx, vz, 0.35, 16);
      }
      finger.at = -1;
      for (const p of path.slice(-6)) eels.lure(p.x, p.z);
    },
    feed: (x, z) => {
      eels.feed(x, z, 1);
      sim.addDrop(x, z, 0.18, 0.012);
      audio.plop('big', toPan(x));
      feeding = { x, z };
      nextCrumbAt = performance.now() + CRUMB_MS;
    },
    feedDragMove: (x, z) => { if (feeding) { feeding.x = x; feeding.z = z; } },
    feedDragEnd: (path) => {
      feeding = null;
      const loop = detectLoop(path);
      if (loop) { eels.vortex(loop.x, loop.z, loop.radius); audio.crackle('med', { pan: toPan(loop.x) }); }
    },
    recolor: () => { feeding = null; eels.recolor(); audio.crackle('lil'); },
  });

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

  // ?impulse=test: 40 micro-drops a frame over the middle of the pool, so the injector is visible
  // under both backends without waiting on a live shower. One reused array, no per-frame allocation.
  const testDrops = params.get('impulse') === 'test' ? Array.from({ length: 40 }, () => ({ u: 0, v: 0, s: 0.006, r: 2.5 })) : null;

  const timer = new THREE.Timer();
  timer.connect(document);
  let t = 0;
  // Diegetic performance watcher: a sustained hot pond gates Eleanor's visits (and future quality tiers).
  let perfEma = 8, perfHotFor = 0;
  let running = false;
  const moonDir = new THREE.Vector3();
  const epoch = (Date.now() / 1000) % MOON_ORBIT_SECONDS;
  // The pond's night clock: one orbit is one night. Lilies, mat growth, and later larvae read it.
  const moon = { az: 0, phase01: 0, cycles: 0 };

  // Frame-rate HUD; in debug mode every frame time is kept so pond.stats() can report averages and lows.
  const debug = params.get('debug') === '1';
  const fpsEl = document.getElementById('fps');
  document.getElementById('backend').textContent = root.dataset.backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  let fpsFrames = 0, fpsSince = 0, fpsLastLog = 0;
  const frameTimes = [];
  const fpsStats = () => {
    const s = frameTimes.slice().sort((a, b) => a - b);
    if (!s.length) return null;
    const sum = s.reduce((a, b) => a + b, 0);
    const pick = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return { frames: s.length, avgFps: +(s.length / sum).toFixed(1), medianMs: +(pick(0.5) * 1000).toFixed(2), low1pctFps: +(1 / pick(0.99)).toFixed(1), worstMs: +(s[s.length - 1] * 1000).toFixed(1), over16ms: s.filter((v) => v > 1 / 60).length };
  };
  function hud(rawDt, now) {
    fpsFrames++;
    if (now - fpsSince >= 0.5) {
      fpsEl.textContent = `${Math.round(fpsFrames / (now - fpsSince))} FPS`;
      fpsFrames = 0; fpsSince = now;
    }
    if (!debug || t < 3) return;
    frameTimes.push(rawDt);
    if (now - fpsLastLog >= 10) { fpsLastLog = now; console.log('Pond fps', JSON.stringify(fpsStats())); }
  }

  function frame() {
    timer.update();
    const rawDt = timer.getDelta();
    hud(rawDt, timer.getElapsed());
    if (debug && rawDt > 0.05 && t > 3) console.warn(`Pond: slow frame ${(rawDt * 1000).toFixed(0)} ms (drops ${sim.pending.length}, foods ${eels.foods.length}, eels ${eels.enabled})`);
    const dt = Math.min(rawDt, 0.05);
    t += dt;
    perfEma += (rawDt * 1000 - perfEma) * 0.05;
    perfHotFor = perfEma > 14 ? perfHotFor + dt : 0;
    eels.perfHot = perfHotFor > 4;
    U.time.value = t % 4096;
    surface.uReveal.value += (revealTarget - surface.uReveal.value) * Math.min(1, dt * 1.2);

    const orbit = (epoch + t) / MOON_ORBIT_SECONDS;
    const az = orbit * Math.PI * 2;
    moon.az = az; moon.phase01 = orbit % 1; moon.cycles = Math.floor(t / MOON_ORBIT_SECONDS);
    U.moonPhase.value = moon.phase01;
    moonDir.set(Math.cos(MOON_ELEVATION) * Math.cos(az), Math.sin(MOON_ELEVATION), Math.cos(MOON_ELEVATION) * Math.sin(az));
    U.moonDir.value.copy(moonDir);

    if (performance.now() > swishUntil) audio.swish(false);
    if (feeding && performance.now() >= nextCrumbAt) {
      nextCrumbAt = performance.now() + CRUMB_MS;
      eels.feed(feeding.x, feeding.z, 0.35);
      sim.addDrop(feeding.x, feeding.z, 0.14, 0.006);
      audio.plop('smol', toPan(feeding.x));
    }
    // Ahead of anything that spawns, so this frame's effects are stamped with this frame's clock.
    effects.setTime(t);
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
    names.update(eels);
    // Right after the eels wrote this frame's influence slots: drips, plops, and stalk swings read the live pose.
    pads.update(dt, t, rain, impulse);
    floaters.update(dt, t);
    algae.update(dt, t);
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
    if (sim.update(dt) > 0 || t < 0.5) caustics.render();
    // The drag segment since the last frame becomes a pointer capsule; a flick is capped so it shoves, not teleports.
    if (finger.at >= 0 && performance.now() - finger.at < 120) {
      let vx = (finger.x - finger.px) / Math.max(dt, 1e-3), vz = (finger.z - finger.pz) / Math.max(dt, 1e-3);
      const sp = Math.hypot(vx, vz);
      if (sp > 3) { vx *= 3 / sp; vz *= 3 / sp; }
      // A finger crosses a texel in one frame where a body lingers for many, so it pushes 16× as hard.
      wake.poke(finger.px, finger.pz, finger.x, finger.z, vx, vz, 0.35, 16);
      pads.disturb(finger.x, finger.z);
      // The wake field gains nothing from sub-frame precision; the CPU speck sim and the noise carve do,
      // so they get every coalesced sample since the last frame, newest 16 at most.
      const path = finger.path;
      if (path && path.length > 1) {
        let k = Math.max(finger.idx, path.length - 1 - 16);
        for (; k < path.length - 1; k++) floaters.poke(path[k].x, path[k].z, path[k + 1].x, path[k + 1].z, vx, vz);
        finger.idx = path.length - 1;
      } else floaters.poke(finger.px, finger.pz, finger.x, finger.z, vx, vz);
      finger.px = finger.x; finger.pz = finger.z;
    }
    // After eels.update wrote this frame's influence slots, before anything samples the field.
    wake.update(dt);

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
      renderer, sim, caustics, eels, eleanor, U, surface, seed, overScene, impulse, effects, rain, wake, habitat, moon, pads, floaters, algae, textures,
      grow: (i, d = 1) => growEel(eels.eels[i], d),
      swap: (i, name) => eels.swapIdentity(eels.eels[i], name ? IDENTITIES.find((id) => id.name.toLowerCase() === name.toLowerCase()) : null),
      stats: fpsStats,
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
