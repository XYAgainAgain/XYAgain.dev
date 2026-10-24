import * as THREE from 'three/webgpu';
import { TANK, FIXED_DT } from './config.js';
import { seedFromUrl } from '../../pond/js/rng.js';
import { loadJolt, Physics } from './tank/physics.js';
import { Mantle, MANTLE_KNOBS } from './amira/body/mantle.js';
import { SHELL_LEVELS } from './amira/body/mantle-core.js';
import { buildTank, buildPanel, buildRocks, apertures, LAYOUT_KNOBS } from './tank/layout.js';
import { buildToys } from './enrichment/toys.js';
import { Arms } from './amira/arms/arms.js';
import { SuckerView } from './amira/arms/sucker-view.js';
import { ArmView } from './amira/arms/arm-view.js';
import { Pose } from './amira/body/pose.js';
import { Attention } from './amira/attention.js';
import { Locomotion } from './amira/locomotion/locomotion.js';
import { Wander } from './amira/locomotion/loco-wander.js';
import { Carry } from './amira/locomotion/loco-carry.js';
import { installRight } from './amira/locomotion/loco-right.js';
import { installClimb } from './amira/locomotion/loco-climb.js';
import { installSqueeze } from './amira/locomotion/loco-squeeze.js';
import { installJet } from './amira/locomotion/loco-jet.js';
import { installFew } from './amira/locomotion/loco-few.js';
import { Den } from './amira/locomotion/loco-den.js';
import { isRunning } from './diag/scenarios.js';
import { BodyParts } from './amira/body/body-parts.js';
import { attachDebug } from './diag/debug.js';
import { Water } from './water/buoyancy.js';
import { WATER_KNOBS } from './water/buoyancy-core.js';
import { WaterVisuals } from './water/visuals.js';
import { createPanel } from './diag/panel.js';
import { TankCamera } from './tank/camera.js';
import { TankGlass } from './tank/glass.js';
import { wallGeometry } from './tank/geometry.js';
import { TankSand } from './tank/sand.js';
import { registerWeight } from './tank/sand-weight.js';
import { WallOptics } from './tank/wall-optics.js';
import { Mount, Bench, BENCH_KNOBS, benchBodyMass } from './diag/bench.js';
import { RodDiag } from './diag/rod-diag.js';
import { rodArms } from './amira/arms/arm-rod.js';

/* Amira's tank: Jolt from the import map, her soft body and arms (amira/), the rockwork, the toys, and the panel.
   Flags: ?verts=150|300|500  ?drive=force|pin|free  ?seed=  ?gl=1  ?joltdebug=1  ?gap=  ?toys=  ?iters=  ?pa=
   ?collider=jolt  ?curious=0  ?armtoys=1 (Jolt's own arm-on-toy contact)  ?water=0  ?floaters=  ?girth=  ?capsules=1  ?loco=0 (the rigid posture)  ?wander=0  ?sand=0  ?sandseed=  ?sandtex=256|512|1024  plus any MANTLE_KNOBS name; ?render=0 (headless: step only, draw on tank.renderOnce)
   ?bench=arm (her set aside, one arm on a mount: diag/bench.js)  ?rod=0 (the bench arm authored, no rod)  ?twin=1 (the bench's twin check; with ?toys=0)
   ?rods=none (her authored arms; all eight are rods by default)  ?rods=3,4 (only those arms rods)  ?rodmode=shadow (the rods run beside her
   authored arms, touching nothing)  ?loads=1 (her rods with their loads and root wrench, unstable)  ?den=0 (no settling in) */

const params = new URLSearchParams(location.search);
const root = document.documentElement;
let canvas = document.getElementById('tank-canvas');
const hud = document.getElementById('hud');
const status = document.getElementById('status');

async function createRenderer(forceWebGL) {
  const fresh = canvas.cloneNode(false);
  canvas.replaceWith(fresh);
  canvas = fresh;
  const r = new THREE.WebGPURenderer({ canvas: fresh, antialias: true, forceWebGL, alpha: false });
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  await r.init();
  return r;
}

const say = (msg) => { if (status) status.textContent = msg; };

async function boot() {
  const seed = seedFromUrl();
  const level = SHELL_LEVELS[params.get('verts') ?? '500'] ?? SHELL_LEVELS[500];
  const drive = ['pin', 'free'].includes(params.get('drive')) ? params.get('drive') : 'force';
  const layoutKnobs = { ...LAYOUT_KNOBS };
  if (params.has('gap')) layoutKnobs.gapH = +params.get('gap') || layoutKnobs.gapH;
  if (params.get('bullnose') === '0') layoutKnobs.bullnose = false;

  say('loading Jolt');
  const joltP = loadJolt({ debug: params.get('joltdebug') === '1' });
  let renderer;
  try {
    const firefox = /firefox/i.test(navigator.userAgent);
    renderer = await createRenderer(params.get('gl') === '1' || (firefox && params.get('gl') !== '0'));
  } catch (err) {
    console.warn('Tank: WebGPU init failed, retrying on WebGL2.', err);
    try { renderer = await createRenderer(true); }
    catch (err2) { console.error('Tank: no renderer available.', err2); root.classList.add('no-renderer'); say('no renderer'); return; }
  }
  root.dataset.backend = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  const Jolt = await joltP;
  say('building');

  const phys = new Physics(Jolt, { armsHitToys: params.get('armtoys') === '1' });
  const walls = buildTank(phys);
  const panel = buildPanel(phys, layoutKnobs);
  const rocks = buildRocks(phys);
  const sand = params.get('sand') === '0' ? null : new TankSand(phys, { seed: Number.isFinite(Number(params.get('sandseed'))) && params.has('sandseed') ? Number(params.get('sandseed')) : 420 });
  const start = [layoutKnobs.panelX - 0.42, layoutKnobs.gapY + 0.08, 0];
  const keepOut = [[-0.55, 0.05, -0.12, 0.09], [0.5, 0.05, 0.1, 0.1], [start[0], start[1], start[2], 0.1]];
  const floaters = +(params.get('floaters') ?? WATER_KNOBS.floaters) || 0;
  const toys = buildToys(phys, seed, Math.max(0, Math.min(80, +(params.get('toys') ?? 12) || 0)), { keepOut, panelX: layoutKnobs.panelX, panelT: layoutKnobs.panelT, floaters });
  // ?water=0 keeps the toys' real masses but leaves them in air: no buoyancy, no drag.
  const water = phys.water = new Water(phys, toys, { enabled: params.get('water') !== '0', knobs: { floaters } });
  // Any mantle knob can ride the query string by its own name (?forceK=2000&bend=none); iters and pa are short forms.
  const mantleKnobs = {};
  const alias = { iters: 'iterations', pa: 'pressurePa' };
  for (const [key, raw] of params) {
    const name = alias[key] ?? key;
    // A bare ?pa would read as 0 Pa and override the per-level pressure, so blanks are skipped.
    if (!(name in MANTLE_KNOBS) || raw.trim() === '') continue;
    if (typeof MANTLE_KNOBS[name] === 'string') mantleKnobs[name] = raw;
    else if (Number.isFinite(+raw)) mantleKnobs[name] = +raw;
  }
  const armKnobs = params.has('collider') ? { collider: params.get('collider') } : {};
  // Her arms run on their muscles; ?muscle=0 runs them on the authored targets alone, as before the muscle map.
  armKnobs.muscle = params.get('muscle') === '0' ? 0 : 1;
  // Her arms steer off each other before they touch, which thins the tangles but still lets two meet; ?crowd=0 turns it off.
  armKnobs.crowd = params.get('crowd') === '0' ? 0 : 1;
  // The bench sets her aside: a mount holds one arm (a rod unless ?rod=0), and nothing of her body, posture, attention,
  // or locomotion is built.
  const benchOn = params.get('bench') === 'arm', twin = benchOn && params.get('twin') === '1';
  let mantle, arms, pose = null, attention = null, loco = null, carry = null, jet = null, bench = null, den = null;
  if (benchOn) {
    mantle = new Mount({ ...BENCH_KNOBS });
    const index = mantle.k.index, rods = params.get('rod') === '0' ? [] : [index];
    // Its intent chain keeps every finishing pass, as the twin check's twin does; the twin check closes both rod-to-intent channels.
    arms = new Arms(phys, mantle, armKnobs, { seed, indices: [index], rods, rodKnobs: { ...(twin ? { hold: 'off', aim: false } : {}), toyPush: 'rod', gripLoad: true, seals: true, intentRounds: 0 }, bodyMass: benchBodyMass(1040) });
    bench = new Bench({ arms, mount: mantle, phys, seed, toys, rocks, twin });
  } else {
    mantle = new Mantle(phys, { n: level, origin: start, drive, knobs: mantleKnobs });
    const rods = rodArms(params.get('rods'));
    // ?loads=1: her rod arms push toys, bear their grips, seal, and pass it all on to her through their roots. Off by
    // default, since the root wrench fed back a tick late grows tick on tick at her mass.
    const rodKnobs = params.get('loads') === '1' ? { toyPush: 'rod', gripLoad: true, seals: true, wrench: true } : {};
    arms = new Arms(phys, mantle, armKnobs, { seed, rods, rodKnobs, rodMode: params.get('rodmode') === 'shadow' ? 'shadow' : 'drive' });
    const locoOn = params.get('loco') !== '0';
    pose = new Pose(mantle, start, {}, { seed, rigid: !locoOn });
    pose.tick(0);
    attention = new Attention(pose, arms, toys, { seed, knobs: params.get('curious') === '0' ? { curious: false } : {} });
    loco = new Locomotion({ mantle, arms, pose, attention, toys }, { seed, knobs: { enabled: locoOn, wander: params.get('wander') !== '0' } });
    loco.wander = new Wander(loco, { toys, rocks, attention, panelX: layoutKnobs.panelX, panelT: layoutKnobs.panelT, seed });
    carry = new Carry({ mantle, arms, loco });
    installClimb(loco);
    installSqueeze(loco, { apertures: apertures(layoutKnobs) });
    jet = installJet(loco);
    installFew(loco, { carry });
    installRight(loco);
    // Resting on the sand she settles into a den she digs; ?den=0 leaves her lying on the bed as it is.
    if (sand) den = new Den({ loco, mantle, arms, sand, jet }, { knobs: params.get('den') === '0' ? { on: false } : {} });
    // The records read locomotion's roles to tell a stroke from a station; Arms itself never sees locomotion.
    arms.records.setLoco(loco);
  }
  // An incidental touch can't end an arm's task, and a held reach that something blocks side-steps once, then moves on;
  // ?keeptask=0 and ?blocked=0 show her without either.
  arms.suckerKnobs.keepTask = params.get('keeptask') !== '0';
  arms.blocked.knobs.on = params.get('blocked') !== '0';

  // A long lens keeps the exhibit readable from the front while preserving its depth.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06080d);
  const camera = new THREE.PerspectiveCamera(22, innerWidth / innerHeight, 0.05, 20);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a2230, 1.2));
  const key = new THREE.DirectionalLight(0xfff2d8, 2.2);
  key.position.set(0.4, 1.6, 0.9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6fa0ff, 0.8);
  rim.position.set(-0.8, 0.5, -0.6);
  scene.add(rim);
  if (sand) await sand.mount(scene, [256, 512, 1024].includes(+params.get('sandtex')) ? +params.get('sandtex') : 1024);

  const mats = {
    floor: new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.9 }),
    wall: new THREE.MeshStandardMaterial({ color: 0x24324a, roughness: 0.9, transparent: true, opacity: 0.25, depthWrite: false }),
    panel: new THREE.MeshStandardMaterial({ color: 0x5a4a3e, roughness: 0.95 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x4e4a46, roughness: 1 }),
    toy: new THREE.MeshStandardMaterial({ color: 0xe0b23c, roughness: 0.4, metalness: 0.1 }),
    arm: new THREE.MeshStandardMaterial({ color: 0xb9503f, roughness: 0.6 }),
  };
  const rigidMeshes = [];
  for (const e of phys.rigid) {
    if (e.tag === 'sand') continue;
    if (e.tag === 'wall') { if (e.pos[2] > 0) continue; }   // the front glass stays clear
    let geo;
    if (e.tag === 'wall') geo = wallGeometry(e);
    else if (e.kind === 'box') geo = new THREE.BoxGeometry(e.size[0] * 2, e.size[1] * 2, e.size[2] * 2);
    else if (e.kind === 'sphere') geo = new THREE.SphereGeometry(e.size[0], 20, 14);
    else if (e.kind === 'capsule') geo = new THREE.CapsuleGeometry(e.size[1], e.size[0] * 2, 4, 10);
    else geo = new THREE.CylinderGeometry(e.size[1], e.size[1], e.size[0] * 2, 16);
    const mesh = new THREE.Mesh(geo, e.taste === 'floor' ? mats.floor : mats[e.tag] ?? mats.toy);
    scene.add(mesh);
    const tint = e.water ? new THREE.MeshStandardMaterial({ color: e.water.tint, roughness: 0.4, metalness: 0.1 }) : null;
    rigidMeshes.push({ e, mesh, tint });
  }
  const mantleGeo = new THREE.BufferGeometry();
  mantleGeo.setAttribute('position', new THREE.BufferAttribute(mantle.positions, 3));
  mantleGeo.setIndex(new THREE.BufferAttribute(mantle.shell.faces, 1));
  mantleGeo.computeVertexNormals();
  const mantleMesh = new THREE.Mesh(mantleGeo, new THREE.MeshStandardMaterial({ color: bench ? 0x9aa7ad : 0x8c5fb0, roughness: bench ? 0.6 : 0.35, metalness: 0.05, side: THREE.DoubleSide }));
  mantleMesh.position.set(...mantle.origin);
  // Its bounding sphere is from the spawn pose and never follows her, so culling would hide her from a close camera.
  mantleMesh.frustumCulled = false;
  scene.add(mantleMesh);
  const bodyParts = bench ? null : new BodyParts(mantle, scene, {}, { seed });
  if (bodyParts) { pose.eyeKnobs = bodyParts.knobs; jet.parts = bodyParts; }
  const rootMarkers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe08a }), mantle.roots.length);
  scene.add(rootMarkers);
  const m4 = new THREE.Matrix4(), tmp3 = [0, 0, 0];

  water.onTint = (on) => { for (const r of rigidMeshes) if (r.tint) r.mesh.material = on ? r.tint : mats.toy; };
  water.setTint(water.knobs.tint);
  const ctx = { phys, mantle, arms, pose, attention, loco, carry, den, bench, rods: null, panel, walls, rocks, toys, layoutKnobs, water, watch: null, probe: null };
  const tank = attachDebug(ctx);
  tank.scene = scene; tank.camera = camera; tank.renderer = renderer; tank.bodyParts = bodyParts;
  if (bodyParts) tank.knobs.parts = bodyParts.knobs;
  if (bench) { tank.bench = bench; tank.knobs.bench = bench.mount.k; }
  tank.attention = attention; if (attention) tank.knobs.attention = attention.knobs;
  tank.carry = carry;
  if (den) { tank.den = den; tank.knobs.den = den.knobs; }
  tank.water = water; tank.knobs.water = water.knobs;
  tank.suckerView = new SuckerView(arms, scene);
  const armView = tank.armView = new ArmView(arms, mantle, scene, Number(params.get('girth')) > 0 ? { girth: +params.get('girth') } : {});
  tank.knobs.armView = armView.knobs;
  armView.capsuleMeshes = rigidMeshes.filter((r) => r.e.tag === 'arm').map((r) => r.mesh);
  armView.capsules = params.get('capsules') === '1';
  // Her intent chains stay hidden until asked for (O); the bench shows its ghost from the start.
  if (!bench) armView.ghost = false;
  if (bench) bench.view = armView;
  else if (arms._anyRod) tank.rods = ctx.rods = new RodDiag(arms, { view: () => armView });
  const cameraRig = new TankCamera(camera, renderer.domElement, {
    animals: [mantleMesh, armView.tubeMesh, armView.webMesh, ...(bodyParts?.parts.map((p) => p.mesh) ?? [])].filter(Boolean),
    scenery: [...rigidMeshes.filter(({ e }) => e.tag !== 'arm').map((r) => r.mesh), ...(sand ? [sand.mesh] : [])], say,
  });
  tank.cameraRig = cameraRig; tank.knobs.camera = cameraRig.knobs;
  if (sand) {
    tank.sand = sand; tank.knobs.sand = sand.knobs;
    registerWeight(sand.contacts, sand.field, mantle, arms);
  }
  addEventListener('resize', () => {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    cameraRig.fit();
  });
  window.tank = tank;
  const waterVisuals = new WaterVisuals({ renderer, scene, camera, ctx, jet, seed, enabled: params.get('waterview') !== '0' });
  tank.waterVisuals = waterVisuals;
  // The rods feel the tank's currents, which are the visuals' for now.
  const flow = [0, 0, 0];
  arms.ambient = (x, y, z, out) => { waterVisuals.currents.sample(x, y, z, phys.time, water.knobs.surfaceY, flow); out[0] = flow[0]; out[1] = flow[1]; out[2] = flow[2]; };
  tank.knobs.waterVisuals = waterVisuals.knobs;
  const glass = tank.glass = new TankGlass(scene);
  tank.knobs.glass = glass.knobs;
  const wallOptics = tank.wallOptics = new WallOptics(renderer, scene, camera, glass, waterVisuals);
  tank.knobs.wallOptics = wallOptics.knobs; cameraRig.optics = wallOptics;
  const diag = createPanel({ el: document.getElementById('panel'), readout: hud, controls: document.getElementById('controls'), ctx, tank, toys, seed, say });

  const syncRigid = (all = false) => {
    for (const { e, mesh } of rigidMeshes) {
      if (e.motion === 'static' && !all) continue;
      const p = e.body.GetPosition(), q = e.body.GetRotation();
      mesh.position.set(p.GetX(), p.GetY(), p.GetZ());
      mesh.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
      if (e.scale) mesh.scale.set(e.scale[0], e.scale[1], e.scale[0]);
    }
  };
  syncRigid(true);

  // Headless runs skip drawing so the sim keeps real time; a screenshot asks for one frame.
  const headless = params.get('render') === '0';
  let wantFrame = !headless, afterFrame = null, drawnTick = -1;
  tank.renderOnce = () => new Promise((resolve) => { wantFrame = true; afterFrame = resolve; });
  let last = performance.now();
  const preTick = (dt) => {
    if (bench) bench.tick(dt);
    else {
      attention.tick(dt);
      pose.tick(dt, arms);
      loco.tick(dt);
      den?.tick(dt);
      mantle.tick(dt);
      mantle.sync();
    }
    arms.tick(dt, phys.time);
    bench?.after(dt);
    sand?.tick(dt);
    ctx.watch?.();
    ctx.probe?.(dt);
  };
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!diag.state.paused) phys.step(dt, preTick);
    if (!wantFrame) return;
    if (headless) { wantFrame = false; }
    // Her shapes only change on a physics tick, so a frame between two ticks would rebuild them identically; a drawing
    // knob changed meanwhile shows on the next tick, at most 1/60 s later.
    if (phys.stepTotal !== drawnTick || diag.state.paused || afterFrame) {
      drawnTick = phys.stepTotal;
      mantle.sync();
      mantleGeo.attributes.position.needsUpdate = true;
      mantleGeo.computeVertexNormals();
      if (bodyParts) { attention.aimEyes(bodyParts); bodyParts.update(); }
      tank.suckerView.update();
      armView.update();
      for (let r = 0; r < mantle.roots.length; r++) {
        mantle.rootWorld(r, tmp3);
        m4.makeTranslation(tmp3[0], tmp3[1], tmp3[2]);
        rootMarkers.setMatrixAt(r, m4);
      }
      rootMarkers.instanceMatrix.needsUpdate = true;
      syncRigid();
    }
    sand?.update(dt);
    cameraRig.update(dt);
    waterVisuals.update(phys.time);
    glass.update();
    wallOptics.withoutPanes(() => glass.withoutShine(() => waterVisuals.beforeRender(phys.time)));
    wallOptics.render(phys.time);
    if (afterFrame) { const f = afterFrame; afterFrame = null; f(); }
    if (!headless) diag.frame(now);
  }
  // Click to send her: the floor, a rock, the panel, or the back or side glass; Alt-click the front glass, which plain
  // clicks pass through (the camera sits beyond it). Shift is hurried.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const clickable = rigidMeshes.filter(({ e }) => (e.tag === 'wall' && e.taste !== 'lid') || e.tag === 'panel' || e.tag === 'rock').map((r) => r.mesh);
  if (sand) clickable.push(sand.mesh);
  const inside = (p) => Math.abs(p.x) <= TANK.w / 2 + 0.005 && p.y >= -0.005 && p.y <= TANK.h + 0.005 && Math.abs(p.z) <= TANK.d / 2 + 0.005;
  if (bench) bench.bindPointer(renderer.domElement, camera, mantleMesh);
  renderer.domElement.addEventListener('click', (ev) => {
    if (bench?.takeClick() || isRunning() || (!bench && !loco.knobs.enabled)) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let hit = null;
    if (ev.altKey) {
      const o = ray.ray.origin, d = ray.ray.direction, t = Math.abs(d.z) > 1e-6 ? (TANK.d / 2 - o.z) / d.z : -1;
      if (t > 0) hit = new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, TANK.d / 2);
      if (hit && !inside(hit)) hit = null;
    } else {
      wallOptics.bendRay(ray.ray);
      hit = ray.intersectObjects(clickable, false).map((h) => h.point).find(inside) ?? null;
    }
    if (!hit) { say('no place to go there'); return; }
    const p = [Math.max(-TANK.w / 2, Math.min(TANK.w / 2, hit.x)), Math.max(0, hit.y), Math.max(-TANK.d / 2, Math.min(TANK.d / 2, hit.z))];
    if (bench) { bench.reachTo(p); say(`reaching to ${p.map((v) => v.toFixed(2)).join(', ')}`); return; }
    loco.want(p, { urgency: ev.shiftKey ? 0.9 : 0.3, source: 'click' });
    say(`going to ${p.map((v) => v.toFixed(2)).join(', ')}${ev.shiftKey ? ', hurried' : ''}`);
  });

  say('');
  renderer.setAnimationLoop(frame);

  document.addEventListener('visibilitychange', () => { if (document.hidden) renderer.setAnimationLoop(null); else { last = performance.now(); renderer.setAnimationLoop(frame); } });
}

boot().catch((err) => { console.error('Tank: boot failed', err); say('boot failed: ' + err.message); });
