import * as THREE from 'three/webgpu';
import { sphereMesh, uniqueEdges, restLengths, buildShell, signedVolume6, SHELL_LEVELS, SHAPE_KNOBS } from '../amira/body/mantle-core.js';
import { Arm, mulberry32 } from '../amira/arms/arm-core.js';
import { TANK } from '../config.js';
import { section } from './panel.js';
import { register, until } from './scenarios.js';
import { RodDiag } from './rod-diag.js';

/* The bench (?bench=arm): Amira set aside and one arm on a mount in the real tank, so the rod arm can be looked at and
   measured on its own (Rod Arm Build Plan, Stage 2). The mount stands in for her body with the surface Arms reads. */

export const BENCH_KNOBS = {
  index: 3,                // the arm on the mount: a back arm, at full length
  pos: [-0.85, 0.42, -0.12],
  pitch: -0.26,            // rad the arm leaves above (+) or below (−) level
  yaw: 0,                  // rad about up; 0 sends the arm toward +x
  radius: 0.045,           // the puck's
  half: 0.018,
  limp: 0.15,              // the rod's bending while limp, of its own
};

export const SCRIPTS = { hold: 'Hold', eight: 'Figure-8', jerk: 'Jerk', carry: 'Carry' };
const MARGIN = 0.06;
const NO_ROD = Object.freeze({ tipLag: 0, shapeRms: 0, shapeMax: 0, rootN: 0, rootNm: 0, kinetic: 0, speedMax: 0 });

/* Her body's mass by the rule, drawn volume at tissue density, from the shell she would have; her arms together match it. */
export function benchBodyMass(density) {
  const shell = buildShell(SHELL_LEVELS[500], { ...SHAPE_KNOBS });
  return Math.abs(signedVolume6(shell.positions, shell.faces)) / 6 * density;
}

/* A rounded puck that holds one arm, moved by a script or the pointer; it offers the surface Arms reads off her mantle. */
export class Mount {
  constructor(k = BENCH_KNOBS) {
    this.k = k;
    const { dirs, faces } = sphereMesh(5), count = dirs.length / 3, local = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      local[i * 3] = dirs[i * 3] * k.radius; local[i * 3 + 1] = dirs[i * 3 + 1] * k.half; local[i * 3 + 2] = dirs[i * 3 + 2] * k.radius;
    }
    this.local = local;
    this.shell = { count, faces, positions: local };
    this.edges = uniqueEdges(faces);
    this.rest = restLengths(local, this.edges);
    this.origin = [...k.pos];
    this.positions = new Float32Array(count * 3);
    this.roots = [0];
    this.fieldFit = null;
    this.knobs = { vertexRadius: 0.004 };
    this.armForce = new Float32Array([0.5]);   // what the sand feels the arm press with, N
    this.armMode = new Uint8Array(1);
    this.drive = 'mount';
    this.exhale = 0;
    this.base = [...k.pos];
    this.script = 'hold';
    this.t = 0;
    this.center = [0, 0, 0];
    this.angle = 0;
    this.R = new Float64Array(9);
    // On the rim, a little under, on the side the arm leaves from.
    this.rootLocal = [k.radius * 0.92, -k.half * 0.35, 0];
    this._ring = { c: [0, 0, 0], down: [0, -1, 0] };
    this.pose(0);
  }

  /* Where the script puts the puck at time t, relative to its base: dx, dy, dz, and a pitch offset. */
  _offset(t, o) {
    o[0] = o[1] = o[2] = o[3] = 0;
    if (this.script === 'eight') {
      o[0] = 0.05 * Math.sin(2 * Math.PI * t); o[1] = 0.03 * Math.sin(4 * Math.PI * t); o[3] = 0.3 * Math.sin(2 * Math.PI * t);
    } else if (this.script === 'jerk') {
      // 12 cm in a tenth of a second, held, then back.
      const c = t % 5, u = (v) => Math.min(1, Math.max(0, v / 0.1)), s = (w) => w * w * (3 - 2 * w);
      o[0] = 0.12 * (c < 2.5 ? s(u(c)) : 1 - s(u(c - 2.5)));
    } else if (this.script === 'carry') {
      // A slow loop over the floor, 45 cm along and 40 cm deep, once in 24 s.
      const a = 2 * Math.PI * t / 24;
      o[0] = 0.225 * (1 - Math.cos(a)); o[2] = 0.2 * Math.sin(a);
    }
    return o;
  }

  setScript(name) { if (name in SCRIPTS) { this.script = name; this.t = 0; } }

  /* Carries the base to (x, y, z) at `speed` m/s: a teleport would lay the arm afresh, perhaps straight through a wall. */
  glide(x, y, z, speed = 0.3) { this._glide = { to: [x, y, z], speed }; }

  get gliding() { return !!this._glide; }

  /* Moves the base, kept inside the tank. */
  moveTo(x, y, z) {
    const b = this.base, k = this.k;
    b[0] = Math.max(-TANK.w / 2 + MARGIN, Math.min(TANK.w / 2 - MARGIN, x));
    b[1] = Math.max(k.half + 0.03, Math.min(TANK.h - MARGIN, y));
    b[2] = Math.max(-TANK.d / 2 + MARGIN, Math.min(TANK.d / 2 - MARGIN, z));
  }

  tick(dt) { this.pose(dt); }

  sync() {}

  pose(dt) {
    this.t += dt;
    const g = this._glide;
    if (g) {
      const b = this.base, dx = g.to[0] - b[0], dy = g.to[1] - b[1], dz = g.to[2] - b[2], d = Math.hypot(dx, dy, dz), s = g.speed * dt;
      if (d <= s || !(s > 0)) { this.moveTo(...g.to); this._glide = null; } else this.moveTo(b[0] + dx * s / d, b[1] + dy * s / d, b[2] + dz * s / d);
    }
    const k = this.k, o = this._offset(this.t, this._o ??= [0, 0, 0, 0]), c = this.center, R = this.R;
    c[0] = Math.max(-TANK.w / 2 + MARGIN, Math.min(TANK.w / 2 - MARGIN, this.base[0] + o[0]));
    c[1] = Math.max(k.half + 0.03, Math.min(TANK.h - MARGIN, this.base[1] + o[1]));
    c[2] = Math.max(-TANK.d / 2 + MARGIN, Math.min(TANK.d / 2 - MARGIN, this.base[2] + o[2]));
    this.angle = o[3];
    // Yaw about up after pitch about the puck's own z, so +x local is where the arm leaves.
    const a = k.pitch + o[3], ca = Math.cos(a), sa = Math.sin(a), cy = Math.cos(k.yaw), sy = Math.sin(k.yaw);
    R[0] = cy * ca; R[1] = -cy * sa; R[2] = sy;
    R[3] = sa; R[4] = ca; R[5] = 0;
    R[6] = -sy * ca; R[7] = sy * sa; R[8] = cy;
    const L = this.local, P = this.positions, org = this.origin;
    for (let i = 0; i < this.shell.count; i++) {
      const x = L[i * 3], y = L[i * 3 + 1], z = L[i * 3 + 2];
      P[i * 3] = R[0] * x + R[1] * y + R[2] * z + c[0] - org[0];
      P[i * 3 + 1] = R[3] * x + R[4] * y + R[5] * z + c[1] - org[1];
      P[i * 3 + 2] = R[6] * x + R[7] * y + R[8] * z + c[2] - org[2];
    }
  }

  _world(x, y, z, out, at = true) {
    const R = this.R, c = at ? this.center : [0, 0, 0];
    out[0] = R[0] * x + R[1] * y + R[2] * z + c[0];
    out[1] = R[3] * x + R[4] * y + R[5] * z + c[1];
    out[2] = R[6] * x + R[7] * y + R[8] * z + c[2];
    return out;
  }

  rootWorld(r, out) { return this._world(this.rootLocal[0], this.rootLocal[1], this.rootLocal[2], out); }

  /* The arm leaves along the puck's +x with its suckers toward the puck's underside. */
  rootFrame(r, out = {}) {
    const p = out.p ?? (out.p = [0, 0, 0]), n = out.n ?? (out.n = [0, 0, 0]), t = out.t ?? (out.t = [0, 0, 0]);
    this.rootWorld(r, p);
    this._world(1, 0, 0, n, false);
    this._world(0, 0, 1, t, false);
    return out;
  }

  ring() {
    const o = this._ring;
    o.c[0] = this.center[0]; o.c[1] = this.center[1]; o.c[2] = this.center[2];
    this._world(0, -1, 0, o.down, false);
    return o;
  }

  centroid(out = [0, 0, 0]) { out[0] = this.center[0]; out[1] = this.center[1]; out[2] = this.center[2]; return out; }

  health() { return { nan: 0, strainMax: 0, strainMean: 0, volume: 1, tilt: Math.acos(Math.max(-1, Math.min(1, -this.ring().down[1]))) }; }
}

/* The bench around the mount: the arm programs, the mount scripts and drag, live stats, the panel's controls, and the
   twin (?twin=1), a plain Arm stepped beside the rod arm's intent chain to prove the rod never reaches it. */
export class Bench {
  constructor({ arms, mount, phys, seed, toys, rocks, twin = false }) {
    Object.assign(this, { arms, mount, phys, seed, toys, rocks });
    this.index = mount.k.index;
    this.slot = arms.slotOf(this.index);
    this.arm = arms.arms[this.slot];
    this.rod = arms.rods[this.slot];
    this.listeners = new Set();
    this.twin = twin ? new Arm(this.arm.index, arms.knobs, seed) : null;
    this.twinLog = { ticks: 0, mismatches: 0, first: null };
    if (this.twin) this._twinStep(0);
    this._drag = null;
    this._clicked = false;
    this._controls();
  }

  /* The rod's live numbers against its intent chain (rod-diag.js). */
  get stat() { return this.diag.stats[0] ?? NO_ROD; }

  get limp() { return this.diag.limp; }

  /* Before the arms: the mount moves. */
  tick(dt) { this.mount.tick(dt); }

  /* After the arms and before anything else that tick: the twin, the stats, then any scenario watching. */
  after(dt) {
    if (this.twin) this._twinStep(dt);
    this.diag.tick(dt);
    for (const fn of this.listeners) fn(dt);
  }

  /* The twin gets everything Arms gives the intent chain (frame, lead, a fetch's moving target, the contact passes)
     and nothing of the rod; any bit that differs means the rod reached the intent chain some other way. */
  _twinStep(dt) {
    const A = this.arms, a = this.slot, tw = this.twin, arm = this.arm, V = A.views[a];
    tw.setFrame(V[0], V[1], V[2], A._o);
    tw.setLead(A.lead);
    // A fetch's target follows her mouth every tick, as Arms.tick moves it before the intent arm steps.
    if (tw.goal?.kind === 'fetch') {
      const T = tw.goal.target, M = A._mouth, o = A._o, st = A.fetchStand[a], out = A.fetchOut[a], N = A.rootsN, nl = Math.hypot(N[a * 3], N[a * 3 + 2]);
      for (let i = 0; i < 3; i++) T[i] = M[i] + o[i] * st;
      if (out > 0 && nl > 1e-6) { T[0] += (N[a * 3] / nl) * out; T[2] += (N[a * 3 + 2] / nl) * out; }
    }
    const rec = A._rec;
    A._rec = -1; A._skipHeld(a);
    tw.step(dt, A.world, A.body);
    const rounds = Math.max(1, A.knobs.finishIters);
    for (let it = 0; it < rounds; it++) tw.finishPass(A.world, A.body, it === rounds - 1, false);
    A._rec = rec; A.allSdf.skip = -1;
    if (!(dt > 0)) return;
    const L = this.twinLog;
    L.ticks++;
    const diff = differ(arm, tw, 'arm') ?? differ(arm.goal ?? {}, tw.goal ?? {}, 'goal');
    if (!diff) return;
    L.mismatches++;
    L.first ??= { tick: L.ticks, ...diff, goals: [arm.goal?.kind ?? null, tw.goal?.kind ?? null, arm.goal?.t ?? null, tw.goal?.t ?? null, arm.time, tw.time] };
  }

  /* A program on the mount's arm, and on the twin when there is one, so the two get the same commands on the same tick. */
  _both(fn) { const r = fn(this.arm, true); if (this.twin) fn(this.twin, false); return r; }

  reachTo(p, opts = {}) {
    return this._both((arm, real) => (real ? this.arms.reach(this.index, p, opts) : arm.reach(p, opts)));
  }

  /* Across the round rock so the middle of the arm lands on its far shoulder and the rest drapes down past it. */
  drape() {
    const rock = this.rocks?.find((r) => r.kind === 'sphere');
    if (!rock) return false;
    const c = rock.pos, r = rock.size[0], dx = c[0] - this.mount.center[0], dz = c[2] - this.mount.center[2], l = Math.hypot(dx, dz) || 1;
    return this.reachTo([c[0] + dx / l * r * 0.4, c[1] + r + 0.03, c[2] + dz / l * r * 0.4]);
  }

  fetch() {
    return this._both((arm, real) => (real ? this.arms.fetch(this.index, { grasp: 0.55 }) : arm.fetch(this.arms._mouth, { grasp: 0.55 })));
  }

  idle() { this._both((arm, real) => (real ? this.arms.idle() : arm.idle())); }

  /* The arm holds the pose it has now (Arm.still), so whatever moves it after is the rod's own. */
  still() { this.arms.track[this.slot] = null; this._both((arm) => arm.still()); }

  setResting(v) { this._both((arm, real) => { if (real) this.arms.resting = v; else arm.resting = v; }); }

  setLimp(v) { this.diag.setLimp(v); }

  /* The rod laid back along the intent chain at rest. */
  resetRod() { this.rod?.reset(); }

  /* A left drag on the puck moves it on the plane through it facing the camera; a click elsewhere sends the arm there. */
  bindPointer(canvas, camera, mesh) {
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), hit = new THREE.Vector3(), n = new THREE.Vector3();
    const toNdc = (e) => { const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
    canvas.addEventListener('pointerdown', (e) => {
      this._clicked = false;
      if (e.button !== 0 || !e.isPrimary) return;
      toNdc(e);
      ray.setFromCamera(ndc, camera);
      // The puck's bounds were taken where it spawned.
      mesh.geometry.computeBoundingSphere();
      if (!ray.intersectObject(mesh, false).length) return;
      // Ahead of the camera's own handlers, so a touch on the puck never pans or zooms.
      e.stopImmediatePropagation();
      canvas.setPointerCapture(e.pointerId);
      camera.getWorldDirection(n);
      plane.setFromNormalAndCoplanarPoint(n, hit.set(...this.mount.center));
      const off = [this.mount.base[0] - this.mount.center[0], this.mount.base[1] - this.mount.center[1], this.mount.base[2] - this.mount.center[2]];
      this._drag = { id: e.pointerId, off, moved: false };
    }, { capture: true });
    canvas.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      e.stopImmediatePropagation();
      toNdc(e);
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      d.moved = true;
      // Followed at up to 2.5 m/s, under the 5 cm a tick past which an arm is laid out afresh.
      this.mount.glide(hit.x + d.off[0], hit.y + d.off[1], hit.z + d.off[2], 2.5);
    }, { capture: true });
    const end = (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      this._drag = null;
      // The click that ends a drag is not a reach.
      this._clicked = true;
    };
    canvas.addEventListener('pointerup', end, { capture: true });
    canvas.addEventListener('pointercancel', end, { capture: true });
  }

  /* Whether the click now arriving ended a drag (and so sends nothing). */
  takeClick() { const c = this._clicked; this._clicked = false; return c; }

  describe() {
    const m = this.mount, L = this.twinLog;
    const lines = [`Mount    ${SCRIPTS[m.script]}   at ${m.center.map((v) => v.toFixed(2)).join(', ')}   pitch ${Math.round((m.k.pitch + m.angle) * 180 / Math.PI)}°`];
    if (!this.rod) return [...lines, 'Rod      off (?rod=0): the authored arm'];
    return [...lines, ...this.diag.describe('Mount', this.twin ? `   twin ${L.mismatches ? `DIFFERS at tick ${L.first.tick} (${L.first.field})` : `matches over ${L.ticks} ticks`}` : '')];
  }

  /* The mount's own controls around the rod's shared ones. */
  _controls() {
    const add = (a) => section('bench').add(a);
    for (const [name, label] of Object.entries(SCRIPTS)) {
      add({ key: String(Object.keys(SCRIPTS).indexOf(name) + 1), name: `Mount: ${label}`, label: () => (this.mount.script === name ? `${label} ✓` : label), run: () => this.mount.setScript(name) });
    }
    add({ key: '6', name: 'Drape over the rock', label: () => 'Drape over the rock', run: () => this.drape() });
    add({ key: '7', name: 'Fetch to the mount', label: () => 'Fetch to the mount', run: () => this.fetch() });
    this.diag = new RodDiag(this.arms, { name: 'bench', view: () => this.view, limp: this.mount.k.limp, holdLocked: !!this.twin });
    if (!this.rod) return;
    add({ type: 'range', name: 'Pitch', values: [-1.2, -0.8, -0.5, -0.26, 0, 0.3, 0.6], get: () => this.mount.k.pitch, set: (v) => { this.mount.k.pitch = v; }, label: () => `Pitch ${Math.round(this.mount.k.pitch * 180 / Math.PI)}°` });
  }
}

/* The first own field of a and b, typed arrays and numbers and plain arrays, whose bits differ; null if none. */
function differ(a, b, where) {
  for (const key of Object.keys(a)) {
    const x = a[key], y = b[key];
    if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string' || x == null) {
      if (!Object.is(x, y)) return { field: `${where}.${key}`, intent: x, twin: y };
    } else if (ArrayBuffer.isView(x) || Array.isArray(x)) {
      if (!y || y.length !== x.length) return { field: `${where}.${key}`, intent: 'length', twin: y?.length };
      for (let i = 0; i < x.length; i++) {
        if (typeof x[i] === 'object') continue;
        if (!Object.is(x[i], y[i])) return { field: `${where}.${key}`, index: i, intent: x[i], twin: y[i] };
      }
    }
  }
  return null;
}

const r3 = (v) => +(+v).toFixed(4);

/* Runs fn(t) every tick for `seconds` of sim time on the bench, collecting what it returns. */
function watch(bench, seconds, fn) {
  let t = 0;
  return until(bench, () => { t += 1 / 60; fn(t); return false; }, seconds);
}

/* The Two Chains bit-identity test: needs ?twin=1&toys=0&floaters=0. A loaded rod (heavy, swung on a figure-8, reaching, draping,
   fetching, limp) must leave the intent chain exactly as its twin, which has no rod at all. */
async function twinCheck(ctx, { seconds = 6, weight = 0.4 } = {}) {
  const { bench, arms } = ctx;
  if (!bench.twin || !bench.rod) return { passed: false, failed: 'needs ?twin=1 and a rod arm' };
  const k = arms.rodKnobs, keep = k.weightFactor;
  k.weightFactor = weight;
  const L = bench.twinLog, before = L.ticks;
  let shapeMax = 0;
  const step = (fn, s) => { fn(); return watch(bench, s, () => { shapeMax = Math.max(shapeMax, bench.stat.shapeMax); }); };
  try {
    await step(() => bench.mount.setScript('eight'), seconds);
    await step(() => bench.drape(), seconds);
    await step(() => bench.setLimp(true), seconds / 2);
    await step(() => { bench.setLimp(false); bench.fetch(); }, seconds);
    await step(() => bench.mount.setScript('jerk'), seconds);
    await step(() => { bench.setResting(true); bench.mount.setScript('carry'); }, seconds);
    await step(() => { bench.setResting(false); bench.idle(); bench.mount.setScript('hold'); }, seconds / 2);
  } finally { k.weightFactor = keep; }
  // The rod has to have gone its own way, or matching proves nothing.
  return { ticks: L.ticks - before, mismatches: L.mismatches, first: L.first, shapeMax: r3(shapeMax), passed: L.mismatches === 0 && shapeMax > 0.02 };
}

/* The contact hold: the arm reaches past the slot's lower lip while the rod, made heavy, sags onto it. Every joint the
   hold moves has to be one the source chain touches; run with hold 'rod' and with 'ghost' to see it follows the source. */
async function lipCheck(ctx, { seconds = 6, weight = 1.5, hold = 'rod' } = {}) {
  const { bench, arms, layoutKnobs: L } = ctx;
  if (!bench.rod) return { passed: false, failed: 'needs a rod arm' };
  const k = arms.rodKnobs, keep = { w: k.weightFactor, h: k.hold }, m = bench.mount, base = [...m.base], pitch = m.k.pitch;
  const arm = bench.arm, rod = bench.rod, H = arms.holdDelta[bench.slot], S = arm.n - 1;
  const out = { hold, ticks: 0, rodOnly: 0, ghostOnly: 0, moved: 0, strays: 0, firstStray: null, penMax: 0, nan: 0 };
  k.weightFactor = weight; k.hold = hold;
  m.setScript('hold'); m.glide(L.panelX - 0.3, L.gapY + 0.1, 0); m.k.pitch = -0.2;
  try {
    await until(bench, () => !m.gliding, 10);
    bench.reachTo([L.panelX + 0.25, L.gapY, 0]);
    await watch(bench, seconds, () => {
      out.ticks++;
      if (out.ticks % 6 === 0) { const h = arms.health(); out.penMax = Math.max(out.penMax, h.penetration); out.nan += h.nan; }
      const src = hold === 'rod' ? rod._touched : arm._touched;
      for (let j = 0; j < S; j++) {
        const g = arm._touched[j + 1], r = rod._touched[j + 1];
        if (r && !g) out.rodOnly++;
        if (g && !r) out.ghostOnly++;
        if (H[j * 2] === 0 && H[j * 2 + 1] === 0) continue;
        out.moved++;
        // _feedback bends joint j only where its source touched point j or j + 1.
        if (!src[j] && !src[j + 1]) { out.strays++; out.firstStray ??= { tick: out.ticks, joint: j }; }
      }
    });
  } finally {
    k.weightFactor = keep.w; k.hold = keep.h; m.k.pitch = pitch; bench.idle(); m.glide(...base);
    await until(bench, () => !m.gliding, 10);
  }
  out.penMax = r3(out.penMax);
  out.passed = out.strays === 0 && out.moved > 0 && (out.rodOnly > 0 || out.ghostOnly > 0) && out.nan === 0;
  return out;
}

/* A reach measured: tip lag and shape error against the intent chain, the mount's pull, the rod's motion, its cost, and
   penetration, with the mount still or on a script. */
async function reachCheck(ctx, { seconds = 5, script = 'hold', target = null, E0 = null, tipStiff = null, rest = null, muscle = null } = {}) {
  const { bench, arms } = ctx;
  const k = arms.rodKnobs, keep = { E0: k.E0, tip: k.tipStiff, rest: k.rest, muscle: arms.knobs.muscle };
  if (E0 > 0) k.E0 = E0;
  if (tipStiff > 0) k.tipStiff = tipStiff;
  if (rest) k.rest = rest;
  if (muscle !== null) arms.knobs.muscle = muscle ? 1 : 0;
  bench.mount.setScript(script);
  bench.resetRod();
  arms.resetStats();
  const o = { E0: k.E0, tipStiff: k.tipStiff, rest: k.rest, muscle: arms.knobs.muscle, script, duration: 0, intentAt: null, rodAt: null, tipLagMax: 0, tipLagMean: 0, shapeRmsMean: 0, shapeMax: 0, settledRms: 0, rootNMax: 0, speedMax: 0, penMax: 0, armPen: 0, nan: 0, ticks: 0 };
  // The reach's own clock (reachB every tick, hashed), the contact arc it chose, and how fast its tip and contact point move.
  Object.assign(o, { reachBHash: 0, contactArc: 0, tipSpeed: 0, contactSpeed: 0, rodTipSpeed: 0, rodContactSpeed: 0, actL0: 0, braced: 1 });
  const last = { arm: null, rod: null }, f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  const speed = (X, prev, i) => Math.hypot(X[i * 3] - prev[i * 3], X[i * 3 + 1] - prev[i * 3 + 1], X[i * 3 + 2] - prev[i * 3 + 2]) * 60;
  let settledN = 0;
  try {
    const m = bench.mount.center, tgt = target ?? [m[0] + 0.45, m[1] - 0.18, m[2] + 0.1];
    bench.reachTo(tgt);
    o.duration = bench.arm.goal?.duration ?? 0;
    const near = (X, i) => Math.hypot(X[i * 3] - tgt[0], X[i * 3 + 1] - tgt[1], X[i * 3 + 2] - tgt[2]) < 0.03;
    await watch(bench, seconds, (t) => {
      const s = bench.stat, gi = bench.arm.gripAt;
      o.ticks++;
      const arm = bench.arm, tip = arm.n - 1;
      f64[0] = arm.reachB; o.reachBHash = (Math.imul(o.reachBHash ^ u32[0], 16777619) ^ u32[1]) >>> 0;
      if (arm.goal) o.contactArc = arm.contact;
      if (last.arm) { o.tipSpeed = Math.max(o.tipSpeed, speed(arm.X, last.arm, tip)); o.contactSpeed = Math.max(o.contactSpeed, speed(arm.X, last.arm, gi)); }
      if (bench.rod && last.rod) { o.rodTipSpeed = Math.max(o.rodTipSpeed, speed(bench.rod.X, last.rod, tip)); o.rodContactSpeed = Math.max(o.rodContactSpeed, speed(bench.rod.X, last.rod, gi)); }
      (last.arm ??= new Float64Array(arm.X.length)).set(arm.X);
      if (bench.rod) (last.rod ??= new Float64Array(bench.rod.X.length)).set(bench.rod.X);
      if (arm.act) {
        const S = arm.n - 1;
        for (let j = 0; j < S; j++) { o.actL0 = Math.max(o.actL0, arm.act[S + j]); o.braced = Math.max(o.braced, arm.mus.bendStiff[j]); }
      }
      // When the contact point first comes within 3 cm of the target, on the program's chain and on the rod.
      if (o.intentAt === null && near(bench.arm.X, gi)) o.intentAt = t;
      if (bench.rod && o.rodAt === null && near(bench.rod.X, gi)) o.rodAt = t;
      if (t > seconds - 1) { o.settledRms += s.shapeRms; settledN++; }
      o.tipLagMax = Math.max(o.tipLagMax, s.tipLag); o.tipLagMean += s.tipLag;
      o.shapeRmsMean += s.shapeRms; o.shapeMax = Math.max(o.shapeMax, s.shapeMax);
      o.rootNMax = Math.max(o.rootNMax, s.rootN); o.speedMax = Math.max(o.speedMax, s.speedMax);
      if (o.ticks % 6 === 0) {
        const h = arms.health();
        o.penMax = Math.max(o.penMax, h.penetration); o.armPen = Math.max(o.armPen, h.armPenetration); o.nan += h.nan;
      }
    });
  } finally { k.E0 = keep.E0; k.tipStiff = keep.tip; k.rest = keep.rest; arms.knobs.muscle = keep.muscle; bench.idle(); bench.mount.setScript('hold'); }
  o.tipLagMean /= Math.max(1, o.ticks); o.shapeRmsMean /= Math.max(1, o.ticks); o.settledRms /= Math.max(1, settledN);
  const rs = arms.rodStats(), as = arms.stats();
  Object.assign(o, { rodMean: rs.mean, rodP50: rs.p50, rodP95: rs.p95, armsMean: as.mean, armsP95: as.p95 });
  for (const key of Object.keys(o)) if (typeof o[key] === 'number' && key !== 'reachBHash') o[key] = r3(o[key]);
  o.passed = o.nan === 0;
  return o;
}

/* The heaviest toy thrown at a point `along` the settled arm at `speed`, from in front and above (a light one is
   stopped by the water within a few centimeters): the arm should be shoved aside, never passed through. */
async function toyCheck(ctx, { speed = 1.5, seconds = 3, along = 0.45, settle = 1.5 } = {}) {
  const { bench, arms, phys, toys } = ctx;
  bench.mount.setScript('hold');
  bench.idle();
  await until(bench, () => false, settle);
  const body = arms.bodies[bench.slot], at = Math.round(along * (body.n - 1)), p = body.X.slice(at * 3, at * 3 + 3);
  let best = null;
  for (const t of toys ?? []) if (t.motion === 'dynamic' && (!best || phys.inverseMass(t) < phys.inverseMass(best))) best = t;
  if (!best) return { passed: null, failed: 'no toys' };
  const dir = [0, -0.55, -0.83], dl = Math.hypot(...dir), back = 0.06 + Math.max(...best.size);
  const from = [p[0] - dir[0] / dl * back, p[1] - dir[1] / dl * back, p[2] - dir[2] / dl * back];
  phys.teleport(best, from[0], from[1], from[2], 0, 0, 0, 1);
  phys.wake(best);
  const inv = phys.inverseMass(best), J = speed / Math.max(1e-9, inv) / dl;
  phys.impulseAt(best, dir[0] * J, dir[1] * J, dir[2] * J, from[0], from[1], from[2]);
  const t = arms.loose.indexOf(best), w = arms.allSdf, nrm = [0, 0, 0], X0 = body.X.slice(), reach = Math.max(...best.size);
  const o = { toy: best.kind, kg: r3(1 / phys.inverseMass(best)), speed, met: 0, deepest: 0, penMax: 0, nan: 0, speedMax: 0, closest: Infinity, shoved: 0, ticks: 0 };
  await watch(bench, seconds, () => {
    o.ticks++;
    // How deep the solve found the arm in the toy before it pushed the arm out: proof the throw met it.
    const met = arms.pushPen[bench.slot * arms.loose.length + t];
    if (met > 0) { o.met++; o.deepest = Math.max(o.deepest, met); }
    const X = body.X, c = best.body.GetPosition(), cx = c.GetX(), cy = c.GetY(), cz = c.GetZ();
    w.unfocus();
    for (let i = 1; i < body.n; i++) {
      if (!Number.isFinite(X[i * 3] + X[i * 3 + 1] + X[i * 3 + 2])) { o.nan++; continue; }
      const pen = w.collide(X[i * 3], X[i * 3 + 1], X[i * 3 + 2], body.rad[i], nrm);
      if (pen > 0 && w.hit === arms._looseAt + t) o.penMax = Math.max(o.penMax, pen);
      // Center to point, less the toy's largest half size and the arm's radius: under zero means within its bounds.
      o.closest = Math.min(o.closest, Math.hypot(X[i * 3] - cx, X[i * 3 + 1] - cy, X[i * 3 + 2] - cz) - reach - body.rad[i]);
      o.shoved = Math.max(o.shoved, Math.hypot(X[i * 3] - X0[i * 3], X[i * 3 + 1] - X0[i * 3 + 1], X[i * 3 + 2] - X0[i * 3 + 2]));
    }
    o.speedMax = Math.max(o.speedMax, bench.stat.speedMax);
  });
  for (const key of ['deepest', 'penMax', 'speedMax', 'closest', 'shoved']) o[key] = r3(o[key]);
  o.passed = o.nan === 0;
  return o;
}

/* Stage 4's loads. The dynamic toys lightest first; a toy's bounding radius; every toy's pose, to put back after. */
function toysByMass(ctx) { return (ctx.toys ?? []).filter((t) => t.motion === 'dynamic').sort((a, b) => ctx.phys.inverseMass(b) - ctx.phys.inverseMass(a)); }

const toyR = (t) => (t.kind === 'sphere' ? t.size[0] : t.kind === 'box' ? Math.hypot(...t.size) : t.size[0] + t.size[1]);

function keepToys(ctx) {
  const saved = (ctx.toys ?? []).filter((t) => t.motion === 'dynamic').map((t) => {
    const p = t.body.GetPosition(), r = t.body.GetRotation();
    return [t, p.GetX(), p.GetY(), p.GetZ(), r.GetX(), r.GetY(), r.GetZ(), r.GetW()];
  });
  return () => { for (const [t, ...s] of saved) { ctx.phys.teleport(t, ...s); ctx.phys.stopKinematic(t); } };
}

/* The bench reset between runs: the mount held still, the arm idle and its rod laid back on it, settled. */
async function prepReach(ctx, settle = 1.5) {
  const { bench, arms } = ctx;
  bench.mount.setScript('hold');
  bench.idle();
  arms.releaseAll();
  bench.resetRod();
  await until(bench, () => false, settle);
  const m = bench.mount.center;
  return [m[0] + 0.45, m[1] - 0.18, m[2] + 0.1];
}

/* One reach with toys put in its way (each { toy, node, len }, from liveDrop), watched by fn(tick); returns the rod's
   track. A toy is set down once its node has walked len, just ahead of where that node is going (placeLive), and hovers
   there until the rod touches it (a bounding sphere frees a long toy too soon), so a run that strays still meets it. */
async function reachRun(ctx, tgt, seconds, drops = [], fn = null) {
  const { bench, phys, arms } = ctx, track = [], body = bench.rod;
  let tick = 0;
  for (const d of drops) Object.assign(d, { walk: 0, last: null, p: null, at: null, free: false });
  bench.reachTo(tgt);
  await watch(bench, seconds, () => {
    // The contact point is the reach's own choice, made on its first step.
    if (tick === 0) track.gi = bench.arm.gripAt;
    for (const d of drops) {
      if (d.free) continue;
      if (!d.p) {
        const X = body.X, o = d.node * 3;
        if (d.last) d.walk += Math.hypot(X[o] - d.last[0], X[o + 1] - d.last[1], X[o + 2] - d.last[2]);
        d.last = [X[o], X[o + 1], X[o + 2]];
        if (d.walk < d.len || !(d.p = placeLive(body, d.node, d.toy, arms.sdf, drops))) continue;
        d.at = tick;
      } else if (arms.pushPen[bench.slot * arms.loose.length + arms.loose.indexOf(d.toy)] > 0) { d.free = true; continue; }
      // A node that turned away before it got there is given the toy again where it is going now.
      else if (tick - d.at > 20) { d.p = null; continue; }
      phys.teleport(d.toy, d.p[0], d.p[1], d.p[2], 0, 0, 0, 1); phys.stopKinematic(d.toy); phys.wake(d.toy);
    }
    track.push(Float64Array.from(bench.rod.X));
    fn?.(tick);
    tick++;
  });
  return track;
}

const nearRod = (body, p, d) => {
  const X = body.X;
  for (let i = 1; i < body.n; i++) if (Math.hypot(X[i * 3] - p[0], X[i * 3 + 1] - p[1], X[i * 3 + 2] - p[2]) < d + body.rad[i]) return true;
  return false;
};

/* A toy for node `node` of the live run, set down once that node has covered `share` of the path it took in the clear run. */
function liveDrop(clear, node, share, toy) {
  node = Math.max(1, Math.min(clear[0].length / 3 - 2, node));
  return { toy, node, len: share * pathTick(clear, node, 1).path.at(-1) };
}

/* Just ahead of live node i along its velocity, clear of the furniture, the whole rod, and the toys already down; null
   while the node is still or nothing nearby is clear, so the drop waits a tick. */
function placeLive(body, i, toy, sdf, drops) {
  const X = body.X, V = body.rod.v, o = i * 3, R = toyR(toy), nrm = [0, 0, 0], l = Math.hypot(V[o], V[o + 1], V[o + 2]);
  if (!(l > 1e-3)) return null;
  sdf.unfocus();
  for (const gap of [0.005, 0.015, 0.03]) {
    const s = (R + body.rad[i] + gap) / l, p = [X[o] + V[o] * s, X[o + 1] + V[o + 1] * s, X[o + 2] + V[o + 2] * s];
    let clear = !(sdf.collide(p[0], p[1], p[2], R, nrm) > 0);
    for (let k = 1; k < body.n && clear; k++) clear = Math.hypot(X[k * 3] - p[0], X[k * 3 + 1] - p[1], X[k * 3 + 2] - p[2]) > R + body.rad[k] + 0.003;
    for (const d of drops) if (clear && d.p && d.toy !== toy) clear = Math.hypot(d.p[0] - p[0], d.p[1] - p[1], d.p[2] - p[2]) > R + toyR(d.toy) + 0.005;
    if (clear) return p;
  }
  return null;
}

/* The tick at which node i has covered `share` of the path it covers over the whole run. */
function pathTick(track, i, share) {
  const o = i * 3, d = [0];
  for (let t = 1; t < track.length; t++) d.push(d[t - 1] + Math.hypot(track[t][o] - track[t - 1][o], track[t][o + 1] - track[t - 1][o + 1], track[t][o + 2] - track[t - 1][o + 2]));
  const want = share * d[d.length - 1];
  return { at: Math.max(0, d.findIndex((v) => v >= want)), path: d };
}

const v3len = (A, o) => Math.hypot(A[o], A[o + 1], A[o + 2]);

/* An object's own numbers and typed arrays, nested, to put back later; knobs are skipped, since a run may set them, and
   so is a rod's intent arm, which is put back on its own. */
const UNKEPT = new Set(['knobs', 'k', 'intent']);
function snapState(o, seen = new Set([o])) {
  const s = [];
  for (const key of Object.keys(o)) {
    const v = o[key];
    if (UNKEPT.has(key) || typeof v === 'function') continue;
    if (ArrayBuffer.isView(v)) s.push([key, v.slice()]);
    else if (v === null || typeof v !== 'object') s.push([key, v]);
    else if (!seen.has(v)) { seen.add(v); s.push([key, v, snapState(v, seen)]); }
  }
  return s;
}

function putState(o, s) {
  for (const [key, v, sub] of s) {
    if (sub) { o[key] = v; putState(v, sub); } else if (ArrayBuffer.isView(v)) {
      if (ArrayBuffer.isView(o[key]) && o[key].length === v.length) o[key].set(v); else o[key] = v.slice();
    } else o[key] = v;
  }
}

/* A clear run and a toy run from one start: the arm, its rod, and its suckers put back with their random streams reseeded alike, the toys
   where they lay, no grips, and no current on the rod, so both are one reach until the toy is set down. again() before each run. */
async function sameStart(ctx, restore) {
  const { bench, arms } = ctx, rk = arms.rodKnobs, cur = rk.current, tgt = await prepReach(ctx), seed = (bench.seed * 7919) ^ 0x5eed;
  rk.current = false;
  // A grip let go on one run is ignored for a while on the next, and refractories run on the shared clock, so neither may differ.
  const ign = arms.ignore[bench.slot], added = arms.loose.filter((t) => !ign.has(t)), S = arms.S, r0 = arms.refr.slice(bench.slot * S, bench.slot * S + S), t0 = arms.time;
  for (const t of added) ign.set(t, Infinity);
  const bank = arms.banks[bench.slot], held = [bench.arm, bench.twin, bench.rod, bank].filter(Boolean), snaps = held.map((a) => snapState(a));
  return {
    tgt,
    again() {
      arms.releaseAll(); restore();
      held.forEach((a, i) => putState(a, snaps[i]));
      for (let j = 0; j < S; j++) arms.refr[bench.slot * S + j] = r0[j] + arms.time - t0;
      bench.arm.rng = mulberry32(seed);
      if (bench.twin) bench.twin.rng = mulberry32(seed);
      bank.rng = mulberry32(seed ^ 0xBA4C); arms.epRng[bench.slot] = mulberry32(seed ^ 0xE915);
    },
    done() { rk.current = cur; for (const t of added) ign.delete(t); added.length = 0; },
  };
}

/* The furthest any rod node lies from where it lay on the clear run's same tick, for ticks before `until`. */
function replayGap(track, X, k, until) {
  if (!(k < until) || !track[k]) return 0;
  let m = 0;
  for (let i = 0; i < X.length; i += 3) m = Math.max(m, Math.hypot(X[i] - track[k][i], X[i + 1] - track[k][i + 1], X[i + 2] - track[k][i + 2]));
  return m;
}

/* One arm, one toy and then three across its reach: the toys' total impulse against the arm's own momentum change plus
   the mount's impulse, on the rod path and on the capped one. */
async function budgetCheck(ctx, { seconds = 4, share = 0.5 } = {}) {
  const { bench, arms } = ctx, slot = bench.slot, nL = arms.loose.length, rk = arms.rodKnobs, keep = rk.toyPush, restore = keepToys(ctx);
  const toys = toysByMass(ctx).slice(0, 3), ign = arms.ignore[slot];
  if (toys.length < 3 || !bench.rod) return { passed: false, failed: 'needs three toys and a rod arm' };
  const out = { toys: toys.map((t) => t.kind), kg: toys.map((t) => r3(1 / ctx.phys.inverseMass(t))) };
  try {
    for (const t of toys) ign.set(t, Infinity);
    let tgt = await prepReach(ctx);
    const clear = await reachRun(ctx, tgt, seconds), gi = clear.gi;
    for (const mode of ['rod', 'capped']) {
      rk.toyPush = mode;
      for (const count of [1, 3]) {
        tgt = await prepReach(ctx);
        const nodes = count === 1 ? [gi] : [gi - 3, gi, gi + 3], use = toys.slice(0, count);
        const drops = use.map((toy, s) => liveDrop(clear, nodes[s], share, toy));
        const rod = bench.rod.rod, P = [0, 0, 0], P0 = [0, 0, 0];
        let J = 0, dP = 0, mount = 0, nan = 0, first = true;
        await reachRun(ctx, tgt, seconds, drops, () => {
          for (const t of use) J += v3len(arms.toyImpulse, (slot * nL + arms.loose.indexOf(t)) * 3);
          momentum(rod, P);
          if (!first) dP += Math.hypot(P[0] - P0[0], P[1] - P0[1], P[2] - P0[2]);
          P0[0] = P[0]; P0[1] = P[1]; P0[2] = P[2]; first = false;
          mount += Math.hypot(...rod.rootForce) / 60;
          if (!Number.isFinite(P[0] + P[1] + P[2])) nan++;
        });
        const kg = use.reduce((m, t) => m + 1 / ctx.phys.inverseMass(t), 0);
        out[`${mode}${count}`] = { J: r3(J), budget: r3(dP + mount), dv: r3(J / kg), placed: drops.map((d) => d.at), nan };
      }
    }
  } finally { rk.toyPush = keep; for (const t of toys) ign.delete(t); bench.idle(); restore(); }
  const a = out.rod1, b = out.rod3;
  out.rodRatio = r3(b.J / Math.max(1e-9, a.J)); out.cappedRatio = r3(out.capped3.J / Math.max(1e-9, out.capped1.J));
  out.massRatio = r3((out.kg[0] + out.kg[1] + out.kg[2]) / out.kg[0]);
  // Unlike toys can't share one total, so the gate is the arm's own momentum; per kilogram (dv) is the contrast that
  // shows the capped path tripling, which the arm's budget, mostly its hang on the mount, may not.
  out.cappedOver = out.capped1.J > out.capped1.budget || out.capped3.J > out.capped3.budget;
  out.dvRatio = { rod: r3(b.dv / Math.max(1e-9, a.dv)), capped: r3(out.capped3.dv / Math.max(1e-9, out.capped1.dv)) };
  out.passed = a.J > 0 && b.J > 0 && b.J <= b.budget && a.J <= a.budget && a.nan + b.nan === 0;
  return out;
}

/* Σ Mp·v over the rod's free nodes, into P. */
function momentum(rod, P) {
  const M = rod.Mp, v = rod.v;
  P[0] = P[1] = P[2] = 0;
  for (let i = 1; i <= rod.n; i++) {
    const w = 9 * i, o = 3 * i;
    P[0] += M[w] * v[o] + M[w + 1] * v[o + 1] + M[w + 2] * v[o + 2];
    P[1] += M[w + 3] * v[o] + M[w + 4] * v[o + 1] + M[w + 5] * v[o + 2];
    P[2] += M[w + 6] * v[o] + M[w + 7] * v[o + 1] + M[w + 8] * v[o + 2];
  }
  return P;
}

/* The deepest any rod node lies in toy t, and whether a node meets it. */
function toyPen(ctx, t) {
  const { bench, arms } = ctx, body = bench.rod, X = body.X, w = arms.allSdf, nrm = [0, 0, 0], at = arms._looseAt + arms.loose.indexOf(t);
  let pen = 0;
  w.unfocus();
  for (let i = 1; i < body.n; i++) {
    const p = w.collide(X[i * 3], X[i * 3 + 1], X[i * 3 + 2], body.rad[i], nrm);
    if (p > 0 && w.hit === at) pen = Math.max(pen, p);
  }
  return pen;
}

/* The heaviest toy at 60% of the reach: the rod arrives later and bent, the toy moves less than the arm's sweep; then a
   second pass grips it and lifts, for the grip load's stability. */
async function heavyCheck(ctx, { seconds = 4, share = 0.6, lift = 4, gripLoad = null, gripLoadTau = null, gripMass = null } = {}) {
  const { bench, arms, phys } = ctx, slot = bench.slot, restore = keepToys(ctx), toy = toysByMass(ctx).at(-1), ign = arms.ignore[slot];
  if (!toy || !bench.rod) return { passed: false, failed: 'needs a toy and a rod arm' };
  let gi = 0;
  const near = (X, tgt) => Math.hypot(X[gi * 3] - tgt[0], X[gi * 3 + 1] - tgt[1], X[gi * 3 + 2] - tgt[2]) < 0.03;
  const shapeOf = () => bench.stat.shapeRms;
  const o = { toy: toy.kind, kg: r3(1 / phys.inverseMass(toy)) }, rk = arms.rodKnobs, keepLoad = rk.gripLoad, keepTau = rk.gripLoadTau, keepMass = rk.gripMass;
  if (gripLoad !== null) rk.gripLoad = !!gripLoad;
  if (gripMass !== null) rk.gripMass = !!gripMass;
  if (gripLoadTau > 0) rk.gripLoadTau = gripLoadTau;
  o.gripLoad = rk.gripLoad; o.gripLoadTau = rk.gripLoadTau; o.gripMass = rk.gripMass;
  let same = null;
  try {
    ign.set(toy, Infinity);
    same = await sameStart(ctx, restore);
    const tgt = same.tgt;
    let rms = 0, n = 0, rodAt = null, pen = 0, gap = 0;
    const shapes = [];
    same.again();
    const clear = await reachRun(ctx, tgt, seconds, [], (k) => { gi ||= bench.arm.gripAt; shapes.push(shapeOf()); if (rodAt === null && near(bench.rod.X, tgt)) rodAt = k / 60; });
    o.clearRodAt = rodAt;
    same.again();
    const d = liveDrop(clear, gi, share, toy), start = [0, 0, 0];
    rodAt = null;
    let nan = 0, hits = 0;
    await reachRun(ctx, tgt, seconds, [d], (k) => {
      const at = d.at ?? Infinity;
      gap = Math.max(gap, replayGap(clear, bench.rod.X, k, at));
      if (k >= at) { rms += shapeOf(); n++; }
      if (rodAt === null && near(bench.rod.X, tgt)) rodAt = k / 60;
      if (k === at + 1) { const c = toy.body.GetPosition(); start[0] = c.GetX(); start[1] = c.GetY(); start[2] = c.GetZ(); }
      if (k > at) { pen = Math.max(pen, toyPen(ctx, toy)); if (v3len(arms.toyImpulse, (slot * arms.loose.length + arms.loose.indexOf(toy)) * 3) > 0) hits++; }
      if (!bench.rod.X.every(Number.isFinite)) nan++;
    });
    const c = toy.body.GetPosition();
    // The clear run over the ticks the toy was down for: until then the two were one reach, so like meets like.
    const at0 = Math.min(d.at ?? clear.length - 1, clear.length - 1), path = pathTick(clear, gi, 1).path, after = shapes.slice(at0);
    Object.assign(o, { clearShape: r3(after.reduce((s, v) => s + v, 0) / Math.max(1, after.length)), sweep: r3(path.at(-1) - path[at0]), replayGap: r3(gap) });
    // Sinking is the water's, not the arm's: the travel is measured level.
    Object.assign(o, { placedAt: d.at === null ? null : r3(d.at / 60), rodAt, shape: r3(rms / Math.max(1, n)), travel: r3(Math.hypot(c.GetX() - start[0], c.GetZ() - start[2])), penMax: r3(pen), hits, nan });
    // Grip and lift: no ignore, the arm reaching for the toy where it now lies.
    same.done();
    ign.delete(toy);
    await prepReach(ctx);
    const rod = bench.rod.rod, resets0 = rod.resets ?? 0, m = bench.mount.center;
    arms.reachToy(bench.index, toy);
    const gripped = await until(bench, () => !!arms.episodes[slot]?.h, 6);
    let speedMax = 0, rootYMin = 0, y0 = toy.body.GetPosition().GetY(), yMax = y0;
    if (gripped) {
      const ep = arms.episodes[slot];
      ep.commanded = ep.hard = true;
      bench.reachTo([m[0] + 0.3, m[1] - 0.02, m[2] + 0.1]);
      await watch(bench, lift, () => {
        speedMax = Math.max(speedMax, bench.stat.speedMax);
        if (arms.episodes[slot]?.h) rootYMin = Math.min(rootYMin, rod.rootForce[1]);
        yMax = Math.max(yMax, toy.body.GetPosition().GetY());
        if (!bench.rod.X.every(Number.isFinite)) nan++;
      });
    }
    Object.assign(o, { gripped, held: !!arms.episodes[slot]?.h, lifted: r3(yMax - y0), gripSpeedMax: r3(speedMax), rootYMin: r3(rootYMin), resets: (rod.resets ?? 0) - resets0, nan });
  } finally { same?.done(); rk.gripLoad = keepLoad; rk.gripLoadTau = keepTau; rk.gripMass = keepMass; ign.delete(toy); arms.releaseAll(); bench.idle(); restore(); }
  const later = o.clearRodAt !== null && (o.rodAt === null || o.rodAt > o.clearRodAt + 0.05);
  o.later = later; o.bent = o.shape > o.clearShape * 1.2;
  o.passed = o.hits > 0 && later && o.bent && o.travel < o.sweep && o.penMax < 0.015 && o.nan === 0 && o.resets === 0 && o.gripped && o.gripSpeedMax < 4;
  return o;
}

/* The lightest toy in the reach's path: it moves on while the arm touches it, never stalled and never batted off. */
async function lightCheck(ctx, { seconds = 4, share = 0.45 } = {}) {
  const { bench, arms, phys } = ctx, slot = bench.slot, restore = keepToys(ctx), toy = toysByMass(ctx)[0], ign = arms.ignore[slot];
  if (!toy || !bench.rod) return { passed: false, failed: 'needs a toy and a rod arm' };
  const t = arms.loose.indexOf(toy), nL = arms.loose.length, v = [0, 0, 0], u = [0, 0, 0];
  const o = { toy: toy.kind, kg: r3(1 / phys.inverseMass(toy)), contact: 0, stalls: 0, still: 0, bats: 0, glances: 0, run: 0, travel: 0, ratioMax: 0, nan: 0, replayGap: 0 };
  let d = null, same = null;
  try {
    ign.set(toy, Infinity);
    same = await sameStart(ctx, restore);
    same.again();
    const clear = await reachRun(ctx, same.tgt, seconds), gi = clear.gi;
    same.again();
    d = liveDrop(clear, gi, share, toy);
    const start = [0, 0, 0];
    let was = 0, run = 0, spWas = 0;
    await reachRun(ctx, same.tgt, seconds, [d], (k) => {
      const at = d.at ?? Infinity;
      o.replayGap = Math.max(o.replayGap, replayGap(clear, bench.rod.X, k, at));
      if (k <= at) return;
      const c = toy.body.GetPosition(), cx = c.GetX(), cy = c.GetY(), cz = c.GetZ();
      if (k === at + 1) { start[0] = cx; start[1] = cy; start[2] = cz; }
      // The velocity read now is the last step's, which carried the last tick's push: judged against that tick's contact.
      phys.pointVelocity(toy, cx, cy, cz, v);
      // Along the push, so the toy's own sinking is not read as a kick.
      const sp = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
      if (was > 0) {
        // A stall is a node driving into the toy that doesn't move it; one resting on it or sliding past is neither.
        if (sp < 0.001) { o.still++; if (was >= 0.02) o.stalls++; }
        // A kick needs a node driving into the toy, since j goes with the closing speed; a node sliding past at nearly
        // nothing along the push can't throw it, and the toy outrunning it there is its own earlier speed (a glance).
        if (sp > 2 * was + 0.01) { if (was >= 0.02 && sp > spWas + 0.005) o.bats++; else o.glances++; }
        if (was >= 0.02) o.ratioMax = Math.max(o.ratioMax, sp / was);
      }
      spWas = sp;
      // This tick's contact, by the nodes that met the toy, and their fastest speed.
      const T = arms.rodToy[slot], V = bench.rod.rod.v;
      let node = 0;
      const q = (slot * nL + t) * 3, jl = v3len(arms.toyImpulse, q);
      if (jl > 0) for (let c = 0; c < 3; c++) u[c] = arms.toyImpulse[q + c] / jl;
      for (let i = 1; i < T.length; i++) if (T[i] === t + 1) node = Math.max(node, V[i * 3] * u[0] + V[i * 3 + 1] * u[1] + V[i * 3 + 2] * u[2]);
      const touch = jl > 0 || arms.pushPen[slot * nL + t] > 0;
      was = touch ? Math.max(node, 1e-3) : 0;
      if (touch) { o.contact++; run++; o.run = Math.max(o.run, run); } else run = 0;
      o.travel = Math.max(o.travel, Math.hypot(cx - start[0], cz - start[2]));
      if (!bench.rod.X.every(Number.isFinite)) o.nan++;
    });
  } finally { same?.done(); ign.delete(toy); bench.idle(); restore(); }
  o.travel = r3(o.travel); o.ratioMax = r3(o.ratioMax); o.replayGap = r3(o.replayGap); o.placedAt = d?.at == null ? null : r3(d.at / 60);
  o.passed = o.travel > 0.03 && o.stalls === 0 && o.bats === 0 && o.run >= 5 && o.nan === 0;
  return o;
}

/* Momentum with the water, weight, and current off: toy impulse plus the rod's momentum change plus the mount's impulse
   less the known external forces, summed over a reach through two toys, against the toys' total impulse. */
async function balanceCheck(ctx, { seconds = 4, share = 0.5 } = {}) {
  const { bench, arms } = ctx, slot = bench.slot, nL = arms.loose.length, restore = keepToys(ctx), toys = toysByMass(ctx).slice(0, 2), ign = arms.ignore[slot];
  if (toys.length < 2 || !bench.rod) return { passed: false, failed: 'needs two toys and a rod arm' };
  const k = arms.rodKnobs, keep = { cur: k.current, cd: k.cdCross, cf: k.cfSkin, cap: k.tipCap, w: k.weightFactor, d: k.damp, s: k.seals };
  const o = { ticks: 0, J: 0, residual: 0, residualTick: 0, other: 0, nan: 0 }, R = [0, 0, 0];
  let drops = [];
  try {
    // Seals act inside the solve, out of reach of the external sum, so none may form.
    Object.assign(k, { current: false, cdCross: 0, cfSkin: 0, tipCap: false, weightFactor: 0, damp: 0, seals: false });
    // No grips on anything: a grip's load and the toy's mass on the rod are outside this sum.
    for (const t of arms.loose) ign.set(t, Infinity);
    let tgt = await prepReach(ctx);
    const clear = await reachRun(ctx, tgt, seconds), gi = clear.gi;
    tgt = await prepReach(ctx);
    drops = toys.map((toy, s) => liveDrop(clear, s ? gi + 4 : gi, share, toy));
    const rod = bench.rod.rod, P = [0, 0, 0], P0 = [0, 0, 0], dt = 1 / 60;
    let first = true;
    await reachRun(ctx, tgt, seconds, drops, () => {
      momentum(rod, P);
      if (!Number.isFinite(P[0] + P[1] + P[2])) { o.nan++; return; }
      if (!first) {
        const r = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          let J = 0, F = 0;
          // Every loose thing, not just the two dropped: the arm can brush any toy lying near its path.
          for (let t = 0; t < nL; t++) J += arms.toyImpulse[(slot * nL + t) * 3 + c];
          for (let i = 0; i <= rod.n; i++) F += rod.ext[i * 3 + c] + (c === 1 ? k.weightFactor * k.gravity * rod.mN[i] : 0);
          r[c] = P[c] - P0[c] + J + rod.rootForce[c] * dt - F * dt - arms.rodOther[slot * 3 + c];
          R[c] += r[c];
        }
        let jt = 0;
        for (let t = 0; t < nL; t++) jt += v3len(arms.toyImpulse, (slot * nL + t) * 3);
        o.J += jt; o.residualTick += Math.hypot(...r); o.other += v3len(arms.rodOther, slot * 3); o.ticks++;
      }
      P0[0] = P[0]; P0[1] = P[1]; P0[2] = P[2]; first = false;
    });
  } finally { Object.assign(k, { current: keep.cur, cdCross: keep.cd, cfSkin: keep.cf, tipCap: keep.cap, weightFactor: keep.w, damp: keep.d, seals: keep.s }); for (const t of arms.loose) ign.delete(t); bench.idle(); restore(); }
  o.placed = drops.map((d) => d.at);
  o.residual = Math.hypot(...R);
  o.share = r3(o.residual / Math.max(1e-12, o.J)); o.shareTick = r3(o.residualTick / Math.max(1e-12, o.J));
  for (const key of ['J', 'residual', 'residualTick', 'other']) o[key] = +o[key].toPrecision(4);
  o.passed = o.J > 0 && o.share < 0.05 && o.nan === 0;
  return o;
}

/* A seal peeled: drape over the rock until segments seal, then carry the mount off at 0.3 m/s until one tears; the
   recoil over the next second stays finite and dies away. Run with sealBreak on (the rod's ceiling) and off (breakMargin). */
async function peelCheck(ctx, { seconds = 6, away = 0.45 } = {}) {
  const { bench, arms } = ctx, slot = bench.slot, k = arms.rodKnobs, keep = { brk: k.sealBreak, lift: k.sealLift }, base = [...bench.mount.base];
  if (!bench.rod) return { passed: false, failed: 'needs a rod arm' };
  const runs = {};
  try {
    for (const brk of [true, false]) {
      Object.assign(k, { sealBreak: brk, sealLift: Infinity });
      await prepReach(ctx);
      bench.drape();
      const sealed = await until(bench, () => bench.rod.rod.nSeals >= 2 && arms.anchors(bench.index).length > 0, seconds);
      const o = { sealed, seals: bench.rod.rod.nSeals, broke: false, by: null, load: 0, ceil: 0, ratio: 0, speedMax: 0, keMax: 0, ke1: 0, nan: 0, resets: 0 };
      const rod = bench.rod.rod, r0 = rod.resets ?? 0, n0 = arms.counts.sealBreaks, d0 = arms.counts.sealDrops;
      arms.lastSealBreak = null;
      // Straight back from the rock the arm lies over.
      const m = bench.mount.base, rock = ctx.rocks?.find((r) => r.kind === 'sphere'), dx = rock ? rock.pos[0] - m[0] : 1, dz = rock ? rock.pos[2] - m[2] : 0, l = Math.hypot(dx, dz) || 1;
      bench.mount.glide(m[0] - dx / l * away, m[1], m[2] - dz / l * away, 0.3);
      o.broke = await until(bench, () => arms.counts.sealBreaks > n0, away / 0.3 + 1);
      // The mount held where it is and the arm stilled, so the second after measures the recoil, not a program still moving it.
      bench.mount.glide(...bench.mount.base);
      bench.still();
      const b = arms.lastSealBreak;
      if (b) Object.assign(o, { by: b.by, load: r3(b.load), ceil: r3(b.ceil), ratio: r3(b.load / Math.max(1e-9, b.ceil)) });
      let t = 0;
      await watch(bench, 1, () => {
        t += 1 / 60;
        o.speedMax = Math.max(o.speedMax, bench.stat.speedMax);
        const ke = bench.rod.kinetic();
        o.keMax = Math.max(o.keMax, ke);
        if (t > 0.98) o.ke1 = ke;
        if (!bench.rod.X.every(Number.isFinite)) o.nan++;
      });
      bench.idle();
      o.resets = (rod.resets ?? 0) - r0; o.drops = arms.counts.sealDrops - d0;
      o.speedMax = r3(o.speedMax); o.keMax = +o.keMax.toPrecision(3); o.ke1 = +o.ke1.toPrecision(3);
      o.passed = o.sealed && o.broke && o.ratio > 0.8 && o.ratio < (brk ? 1.5 : 1.5 * arms.knobs.breakMargin) && o.speedMax < 4 && o.ke1 < 0.1 * o.keMax && o.nan === 0 && o.resets === 0;
      runs[brk ? 'sealBreak' : 'margin'] = o;
      bench.mount.glide(...base);
      await until(bench, () => !bench.mount.gliding, 10);
    }
  } finally { Object.assign(k, { sealBreak: keep.brk, sealLift: keep.lift }); arms.releaseAll(); bench.idle(); bench.mount.glide(...base); await until(bench, () => !bench.mount.gliding, 10); }
  return { ...runs, passed: runs.sealBreak.passed && runs.margin.passed };
}

/* The root wrench from the rod's multipliers against the intent chain's inverse dynamics (rod-diag.js): hanging still
   they agree on the weight; on the figure-8, idle and reaching, they move together, drag being in one and not the other. */
async function wrenchCheck(ctx, { seconds = 4, stillV = 0.005 } = {}) {
  const { bench, arms } = ctx, W = bench.diag.wrench[0];
  if (!bench.rod || !W) return { passed: false, failed: 'needs a rod arm' };
  const take = async (s, fn) => {
    const rows = [];
    fn?.();
    await watch(bench, s, () => rows.push(Array.from(W.last)));
    return rows.slice(30);
  };
  const corr = (rows, a, b) => {
    const n = rows.length, ma = rows.reduce((s, r) => s + r[a], 0) / n, mb = rows.reduce((s, r) => s + r[b], 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (const r of rows) { sab += (r[a] - ma) * (r[b] - mb); saa += (r[a] - ma) ** 2; sbb += (r[b] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb || 1e-30);
  };
  const rms = (rows, f) => Math.sqrt(rows.reduce((s, r) => s + f(r) ** 2, 0) / rows.length);
  const sum = (rows) => ({
    rodN: r3(rms(rows, (r) => Math.hypot(r[0], r[1], r[2]))), idN: r3(rms(rows, (r) => Math.hypot(r[6], r[7], r[8]))),
    diffN: r3(rms(rows, (r) => Math.hypot(r[0] - r[6], r[1] - r[7], r[2] - r[8]))), rodNm: r3(rms(rows, (r) => Math.hypot(r[3], r[4], r[5]))),
    idNm: r3(rms(rows, (r) => Math.hypot(r[9], r[10], r[11]))), corrFy: r3(corr(rows, 1, 7)), corrTz: r3(corr(rows, 5, 11)),
  });
  const o = {}, k = arms.rodKnobs, cur = k.current, base = [...bench.mount.base];
  try {
    // High enough that the hanging arm can't rest its tip on the floor, and with the current off, an outside force only
    // the rod feels.
    k.current = false;
    bench.mount.glide(base[0], base[1] + 0.35, base[2]);
    await until(bench, () => !bench.mount.gliding, 10);
    // The arm stilled and left until the rod laid back on it finishes sagging (the fall unloads the mount): every node
    // under stillV for half a second.
    await prepReach(ctx, 0.5);
    bench.still();
    let calm = 0, settle = 0, floor = Infinity;
    o.settled = await until(bench, () => { settle++; floor = Math.min(floor, bench.stat.speedMax); calm = bench.stat.speedMax < stillV ? calm + 1 : 0; return calm >= 30; }, 15);
    o.settleS = r3(settle / 60); o.floor = r3(floor);
    const still = await take(4);
    const fy = still.reduce((s, r) => s + r[1], 0) / still.length, iy = still.reduce((s, r) => s + r[7], 0) / still.length;
    o.still = { rodFy: r3(fy), idFy: r3(iy), gap: r3(Math.abs(fy - iy) / Math.max(1e-9, Math.abs(iy))) };
    o.eight = sum(await take(seconds, () => bench.mount.setScript('eight')));
    const m = bench.mount.base;
    o.reach = sum(await take(seconds, () => bench.reachTo([m[0] + 0.45, m[1] - 0.18, m[2] + 0.1])));
  } finally { k.current = cur; bench.idle(); bench.mount.setScript('hold'); bench.mount.glide(...base); await until(bench, () => !bench.mount.gliding, 10); }
  o.passed = o.still.gap < 0.05 && o.eight.corrFy > 0.5;
  return o;
}

register('bench-budget', { label: 'Push budget', bench: true, run: budgetCheck });
register('bench-heavy', { label: 'Heavy toy', bench: true, run: heavyCheck });
register('bench-light', { label: 'Light toy', bench: true, run: lightCheck });
register('bench-balance', { label: 'Momentum balance', bench: true, run: balanceCheck });
register('bench-peel', { label: 'Seal peel', bench: true, run: peelCheck });
register('bench-wrench', { label: 'Root wrench', bench: true, run: wrenchCheck });
register('bench-twin', { label: 'Twin check', bench: true, run: twinCheck });
register('bench-lip', { label: 'Lip check', bench: true, run: lipCheck });
register('bench-reach', { label: 'Reach check', bench: true, run: reachCheck });
register('bench-toy', { label: 'Toy throw', bench: true, run: toyCheck });
