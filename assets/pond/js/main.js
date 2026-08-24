import * as THREE from 'three/webgpu';
import { texture, Fn, vec4, uv } from 'three/tsl';
import { VIEW_H, POOL_SCALE, MOON_ELEVATION, MOON_ORBIT_SECONDS, MAX_PIXELS } from './config.js';
import { seedFromUrl, deriveSeed } from './rng.js';
import { WaterSim } from './sim.js';
import { CausticsPass } from './caustics.js';
import { createSceneUniforms, makeUnderwaterShading, createWaveSet } from './shading.js';
import { buildFloor } from './floor.js';
import { EelSystem } from './eels.js';
import { attachEleanor } from './eleanor.js';
import { growEel } from './eel-physics.js';
import { SurfacePass } from './surface.js';
import { PondInput, detectLoop } from './input.js';
import { PondAudio } from './audio.js';
import { readEelChoice, writeEelChoice, setupIdleFade, askAboutEels, bindSoundButton, bindEelToggle } from './ui.js';

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
    renderer = await createRenderer(params.get('gl') === '1');
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

  const camera = new THREE.OrthographicCamera(-viewW / 2, viewW / 2, viewH / 2, -viewH / 2, 0.1, 20);
  camera.position.set(0, 5, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);

  const U = createSceneUniforms(createWaveSet(deriveSeed(seed, 31)));
  const shading = makeUnderwaterShading(U);
  const sim = new WaterSim(renderer, extent);
  const caustics = new CausticsPass(renderer, sim, U, viewW, viewH);

  const underScene = new THREE.Scene();
  const { colliders } = await buildFloor(underScene, shading, extent, seed, { w: viewW, h: viewH });
  sim.setObstacles(colliders.waterline.discs, colliders.waterline.capsules);
  const eels = new EelSystem(underScene, U, shading, seed, extent, colliders, sim, motion, { w: viewW, h: viewH });
  const eleanor = attachEleanor(eels, seed);

  // MSAA here is the scene's antialiasing: the canvas only ever shows a fullscreen quad. 2× is the budget.
  const underRT = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, samples: 2,
  });
  const surface = new SurfacePass(renderer, sim, U, underRT, viewW, viewH);

  // ?view=caustics|under|sim blits one intermediate target straight to the canvas.
  const debugView = params.get('view');
  let debugQuad = null;
  if (debugView) {
    const src = debugView === 'caustics' ? caustics.rt.texture : debugView === 'sim' ? sim.rtA.texture : underRT.texture;
    const tex = texture(src);
    const m = new THREE.NodeMaterial();
    const gain = debugView === 'sim' ? 20 : debugView === 'caustics' ? 0.5 : 1;
    m.fragmentNode = Fn(() => {
      const c = tex.sample(uv());
      return debugView === 'sim' ? vec4(c.r.mul(gain).add(0.5), c.g.mul(gain).add(0.5), 0.5, 1) : vec4(c.rgb.mul(gain), 1);
    })();
    debugQuad = new THREE.QuadMesh(m);
    debugQuad.update = () => { if (debugView === 'sim') tex.value = sim.rtA.texture; };
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
  setupIdleFade(root);
  // World x -> stereo pan; 0.8 keeps even edge-huggers a little off the speaker wall.
  const toPan = (x) => Math.max(-1, Math.min(1, x / (viewSize().w / 2))) * 0.8;
  eels.onEvent = (type, eel, food) => {
    const pan = toPan(eel.head.x);
    if (type === 'startle') eel === eleanor ? audio.eleanorStartle({ pan }) : audio.startle({ pan, length: eel.length });
    else if (type === 'eat') audio.eat(food?.size ?? 1, { pan, rate: eel === eleanor ? 0.5 : 1 });
    else if (type === 'slurp') audio.slurp({ pan });
    else if (type === 'nibble') audio.tinyBub({ pan });
  };

  // Input
  const toWorld = (cx, cy) => {
    const { w, h } = viewSize();
    return [(cx / innerWidth - 0.5) * w, (cy / innerHeight - 0.5) * h];
  };
  let swishUntil = 0;
  let lastCrackle = 0;
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
    },
    dragEnd: (path) => { for (const p of path.slice(-6)) eels.lure(p.x, p.z); },
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

  // A stray bubble reaches the surface now and then: quiet bloop, tiny ripple where it broke.
  let nextBubble = 6;
  function strayBubbles(now) {
    if (now < nextBubble) return;
    nextBubble = now + 7 + Math.random() * 13;
    const { w, h } = viewSize();
    const bx = (Math.random() - 0.5) * w * 0.9;
    audio.shortBub({ pan: toPan(bx) });
    if (!motion.reduced) sim.addDrop(bx, (Math.random() - 0.5) * h * 0.9, 0.3, 0.02);
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

  const timer = new THREE.Timer();
  timer.connect(document);
  let t = 0;
  // Diegetic performance watcher: a sustained hot pond gates Eleanor's visits (and future quality tiers).
  let perfEma = 8, perfHotFor = 0;
  let running = false;
  const moonDir = new THREE.Vector3();
  const epoch = (Date.now() / 1000) % MOON_ORBIT_SECONDS;

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

    const az = ((epoch + t) / MOON_ORBIT_SECONDS) * Math.PI * 2;
    moonDir.set(Math.cos(MOON_ELEVATION) * Math.cos(az), Math.sin(MOON_ELEVATION), Math.cos(MOON_ELEVATION) * Math.sin(az));
    U.moonDir.value.copy(moonDir);

    if (performance.now() > swishUntil) audio.swish(false);
    if (feeding && performance.now() >= nextCrumbAt) {
      nextCrumbAt = performance.now() + CRUMB_MS;
      eels.feed(feeding.x, feeding.z, 0.35);
      sim.addDrop(feeding.x, feeding.z, 0.14, 0.006);
      audio.plop('smol', toPan(feeding.x));
    }
    idleDrops(t, dt);
    strayBubbles(t);
    eels.update(dt);
    // Caustics follow the water, so they only need redrawing on frames the sim actually stepped.
    if (sim.update(dt) > 0 || t < 0.5) caustics.render();

    renderer.setRenderTarget(underRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(underScene, camera);
    if (debugQuad) { debugQuad.update(); renderer.setRenderTarget(null); debugQuad.render(renderer); }
    else surface.render();

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
      const px = raw instanceof Uint16Array ? Array.from(raw, (u) => {
        const sgn = u >> 15 ? -1 : 1, ex = (u >> 10) & 0x1f, m = u & 0x3ff;
        if (ex === 0) return sgn * m * 2 ** -24;
        if (ex === 31) return m ? NaN : sgn * Infinity;
        return sgn * (1 + m / 1024) * 2 ** (ex - 15);
      }) : raw;
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
      renderer, sim, caustics, eels, eleanor, U, surface, seed,
      grow: (i, d = 1) => growEel(eels.eels[i], d),
      stats: fpsStats,
      diag: async () => {
        console.log('backend', root.dataset.backend, 'moonDir', U.moonDir.value.toArray().map((v) => v.toFixed(3)).join(' '));
        await stats(sim.rtA, 'sim');
        await stats(caustics.rt, 'caustics');
        await stats(underRT, 'under');
      },
    };
    console.log('pond seed', seed, 'backend', root.dataset.backend, '- pond.diag() for target stats, pond.stats() for frame times');
  }
}

boot().catch((err) => {
  console.error('Pond failed to start', err);
  root.classList.add('no-renderer');
});
