import * as THREE from 'three/webgpu';
import { TANK, FIXED_DT } from './config.js';
import { seedFromUrl } from '../../pond/js/rng.js';
import { loadJolt, Physics } from './physics.js';
import { Mantle, MANTLE_KNOBS } from './amira/mantle.js';
import { SHELL_LEVELS } from './amira/mantle-core.js';
import { buildTank, buildPanel, buildRocks, buildToys, LAYOUT_KNOBS } from './layout.js';
import { Arms } from './amira/arms.js';
import { SuckerView } from './amira/sucker-view.js';
import { ArmView } from './amira/arm-view.js';
import { Pose } from './amira/pose.js';
import { Attention } from './amira/attention.js';
import { Locomotion } from './amira/locomotion.js';
import { Wander } from './amira/loco-wander.js';
import { isRunning } from './scenarios.js';
import { BodyParts } from './amira/body-parts.js';
import { attachDebug } from './debug.js';
import { Water } from './water.js';
import { createPanel } from './panel.js';

/* Amira's tank: Jolt from the import map, her soft body and arms (amira/), the rockwork, the toys, and the panel.
   Flags: ?verts=150|300|500  ?drive=force|pin|free  ?seed=  ?gl=1  ?joltdebug=1  ?gap=  ?toys=  ?iters=  ?pa=
   ?collider=jolt  ?curious=0  ?armtoys=1 (Jolt's own arm-on-toy contact)  ?water=0  ?floaters=  ?girth=  ?capsules=1  ?loco=0 (the rigid posture)  ?wander=0  plus any MANTLE_KNOBS name; ?render=0 (headless: step only, draw on tank.renderOnce) */

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
  const start = [layoutKnobs.panelX - 0.42, layoutKnobs.gapY + 0.08, 0];
  const keepOut = [[-0.55, 0.05, -0.12, 0.09], [0.5, 0.05, 0.1, 0.1], [start[0], start[1], start[2], 0.1]];
  const toys = buildToys(phys, seed, Math.max(0, Math.min(80, +(params.get('toys') ?? 12) || 0)), { keepOut, panelX: layoutKnobs.panelX, panelT: layoutKnobs.panelT, floaters: +params.get('floaters') || 0 });
  // ?water=0 keeps the toys' real masses but leaves them in air: no buoyancy, no drag.
  const water = phys.water = new Water(phys, toys, { enabled: params.get('water') !== '0' });
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
  const mantle = new Mantle(phys, { n: level, origin: start, drive, knobs: mantleKnobs });
  const arms = new Arms(phys, mantle, params.has('collider') ? { collider: params.get('collider') } : {}, { seed });
  const locoOn = params.get('loco') !== '0';
  const pose = new Pose(mantle, start, {}, { seed, rigid: !locoOn });
  pose.tick(0);
  const attention = new Attention(pose, arms, toys, { seed, knobs: params.get('curious') === '0' ? { curious: false } : {} });
  const loco = new Locomotion({ mantle, arms, pose, attention, toys }, { seed, knobs: { enabled: locoOn, wander: params.get('wander') !== '0' } });
  loco.wander = new Wander(loco, { toys, rocks, attention, panelX: layoutKnobs.panelX, panelT: layoutKnobs.panelT, seed });

  // Scene: a long lens at the glass, dim gallery light, the tank as a wire box.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06080d);
  const camera = new THREE.PerspectiveCamera(22, innerWidth / innerHeight, 0.05, 20);
  const fit = () => {
    const aspect = innerWidth / Math.max(1, innerHeight);
    camera.aspect = aspect;
    // Distance that frames the tank's width (or its height on a tall viewport) with a little margin.
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const dW = (TANK.w / 2 + 0.08) / (Math.tan(halfFov) * aspect);
    const dH = (TANK.h / 2 + 0.08) / Math.tan(halfFov);
    camera.position.set(0, TANK.h / 2, TANK.d / 2 + Math.max(dW, dH));
    camera.lookAt(0, TANK.h / 2, 0);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
  };
  fit();
  addEventListener('resize', fit);
  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a2230, 1.2));
  const key = new THREE.DirectionalLight(0xfff2d8, 2.2);
  key.position.set(0.4, 1.6, 0.9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6fa0ff, 0.8);
  rim.position.set(-0.8, 0.5, -0.6);
  scene.add(rim);

  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(TANK.w, TANK.h, TANK.d)), new THREE.LineBasicMaterial({ color: 0x4a5a78 }));
  box.position.set(0, TANK.h / 2, 0);
  scene.add(box);

  const mats = {
    wall: new THREE.MeshStandardMaterial({ color: 0x24324a, roughness: 0.9, transparent: true, opacity: 0.25 }),
    panel: new THREE.MeshStandardMaterial({ color: 0x5a4a3e, roughness: 0.95 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x4e4a46, roughness: 1 }),
    toy: new THREE.MeshStandardMaterial({ color: 0xe0b23c, roughness: 0.4, metalness: 0.1 }),
    arm: new THREE.MeshStandardMaterial({ color: 0xb9503f, roughness: 0.6 }),
  };
  const rigidMeshes = [];
  for (const e of phys.rigid) {
    if (e.tag === 'wall') { if (e.pos[2] > 0) continue; }   // the front glass stays clear
    let geo;
    if (e.kind === 'box') geo = new THREE.BoxGeometry(e.size[0] * 2, e.size[1] * 2, e.size[2] * 2);
    else if (e.kind === 'sphere') geo = new THREE.SphereGeometry(e.size[0], 20, 14);
    else if (e.kind === 'capsule') geo = new THREE.CapsuleGeometry(e.size[1], e.size[0] * 2, 4, 10);
    else geo = new THREE.CylinderGeometry(e.size[1], e.size[1], e.size[0] * 2, 16);
    const mesh = new THREE.Mesh(geo, mats[e.tag] ?? mats.toy);
    scene.add(mesh);
    const tint = e.water ? new THREE.MeshStandardMaterial({ color: e.water.tint, roughness: 0.4, metalness: 0.1 }) : null;
    rigidMeshes.push({ e, mesh, tint });
  }
  const mantleGeo = new THREE.BufferGeometry();
  mantleGeo.setAttribute('position', new THREE.BufferAttribute(mantle.positions, 3));
  mantleGeo.setIndex(new THREE.BufferAttribute(mantle.shell.faces, 1));
  mantleGeo.computeVertexNormals();
  const mantleMesh = new THREE.Mesh(mantleGeo, new THREE.MeshStandardMaterial({ color: 0x8c5fb0, roughness: 0.35, metalness: 0.05, side: THREE.DoubleSide }));
  mantleMesh.position.set(...mantle.origin);
  // Its bounding sphere is from the spawn pose and never follows her, so culling would hide her from a close camera.
  mantleMesh.frustumCulled = false;
  scene.add(mantleMesh);
  const bodyParts = new BodyParts(mantle, scene, {}, { seed });
  pose.eyeKnobs = bodyParts.knobs;
  const rootMarkers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe08a }), mantle.roots.length);
  scene.add(rootMarkers);
  const m4 = new THREE.Matrix4(), tmp3 = [0, 0, 0];

  water.onTint = (on) => { for (const r of rigidMeshes) if (r.tint) r.mesh.material = on ? r.tint : mats.toy; };
  water.setTint(water.knobs.tint);
  const ctx = { phys, mantle, arms, pose, attention, loco, panel, walls, rocks, toys, layoutKnobs, water, watch: null, probe: null };
  const tank = attachDebug(ctx);
  tank.scene = scene; tank.camera = camera; tank.renderer = renderer; tank.bodyParts = bodyParts;
  tank.knobs.parts = bodyParts.knobs;
  tank.attention = attention; tank.knobs.attention = attention.knobs;
  tank.water = water; tank.knobs.water = water.knobs;
  tank.suckerView = new SuckerView(arms, scene);
  const armView = tank.armView = new ArmView(arms, mantle, scene, Number(params.get('girth')) > 0 ? { girth: +params.get('girth') } : {});
  tank.knobs.armView = armView.knobs;
  armView.capsuleMeshes = rigidMeshes.filter((r) => r.e.tag === 'arm').map((r) => r.mesh);
  armView.capsules = params.get('capsules') === '1';
  window.tank = tank;
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
  let wantFrame = !headless, afterFrame = null;
  tank.renderOnce = () => new Promise((resolve) => { wantFrame = true; afterFrame = resolve; });
  let last = performance.now();
  const preTick = (dt) => {
    attention.tick(dt);
    pose.tick(dt, arms);
    loco.tick(dt);
    mantle.tick(dt);
    mantle.sync();
    arms.tick(dt, phys.time);
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
    mantle.sync();
    mantleGeo.attributes.position.needsUpdate = true;
    mantleGeo.computeVertexNormals();
    attention.aimEyes(bodyParts);
    bodyParts.update();
    tank.suckerView.update();
    armView.update();
    for (let r = 0; r < mantle.roots.length; r++) {
      mantle.rootWorld(r, tmp3);
      m4.makeTranslation(tmp3[0], tmp3[1], tmp3[2]);
      rootMarkers.setMatrixAt(r, m4);
    }
    rootMarkers.instanceMatrix.needsUpdate = true;
    syncRigid();
    renderer.render(scene, camera);
    if (afterFrame) { const f = afterFrame; afterFrame = null; f(); }
    if (!headless) diag.frame(now);
  }
  // Click to send her: the floor, a rock, the panel, or the back or side glass; Alt-click the front glass, which plain
  // clicks pass through (the camera sits beyond it). Shift is hurried.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const clickable = rigidMeshes.filter(({ e }) => (e.tag === 'wall' && e.taste !== 'lid') || e.tag === 'panel' || e.tag === 'rock').map((r) => r.mesh);
  const inside = (p) => Math.abs(p.x) <= TANK.w / 2 + 0.005 && p.y >= -0.005 && p.y <= TANK.h + 0.005 && Math.abs(p.z) <= TANK.d / 2 + 0.005;
  renderer.domElement.addEventListener('click', (ev) => {
    if (isRunning() || !loco.knobs.enabled) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let hit = null;
    if (ev.altKey) {
      const o = ray.ray.origin, d = ray.ray.direction, t = Math.abs(d.z) > 1e-6 ? (TANK.d / 2 - o.z) / d.z : -1;
      if (t > 0) hit = new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, TANK.d / 2);
      if (hit && !inside(hit)) hit = null;
    } else hit = ray.intersectObjects(clickable, false).map((h) => h.point).find(inside) ?? null;
    if (!hit) { say('no place to go there'); return; }
    const p = [Math.max(-TANK.w / 2, Math.min(TANK.w / 2, hit.x)), Math.max(0, hit.y), Math.max(-TANK.d / 2, Math.min(TANK.d / 2, hit.z))];
    loco.want(p, { urgency: ev.shiftKey ? 0.9 : 0.3, source: 'click' });
    say(`going to ${p.map((v) => v.toFixed(2)).join(', ')}${ev.shiftKey ? ', hurried' : ''}`);
  });

  say('');
  renderer.setAnimationLoop(frame);

  document.addEventListener('visibilitychange', () => { if (document.hidden) renderer.setAnimationLoop(null); else { last = performance.now(); renderer.setAnimationLoop(frame); } });
}

boot().catch((err) => { console.error('Tank: boot failed', err); say('boot failed: ' + err.message); });
