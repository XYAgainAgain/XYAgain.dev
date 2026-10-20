import * as THREE from 'three/webgpu';
import { sphereMesh, uniqueEdges, restLengths, buildShell, signedVolume6, SHELL_LEVELS, SHAPE_KNOBS } from '../amira/body/mantle-core.js';
import { Arm } from '../amira/arms/arm-core.js';
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
    this.diag.tick();
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
async function reachCheck(ctx, { seconds = 5, script = 'hold', target = null, E0 = null, tipStiff = null, rest = null } = {}) {
  const { bench, arms } = ctx;
  const k = arms.rodKnobs, keep = { E0: k.E0, tip: k.tipStiff, rest: k.rest };
  if (E0 > 0) k.E0 = E0;
  if (tipStiff > 0) k.tipStiff = tipStiff;
  if (rest) k.rest = rest;
  bench.mount.setScript(script);
  bench.resetRod();
  arms.resetStats();
  const o = { E0: k.E0, tipStiff: k.tipStiff, rest: k.rest, script, duration: 0, intentAt: null, rodAt: null, tipLagMax: 0, tipLagMean: 0, shapeRmsMean: 0, shapeMax: 0, settledRms: 0, rootNMax: 0, speedMax: 0, penMax: 0, armPen: 0, nan: 0, ticks: 0 };
  let settledN = 0;
  try {
    const m = bench.mount.center, tgt = target ?? [m[0] + 0.45, m[1] - 0.18, m[2] + 0.1];
    bench.reachTo(tgt);
    o.duration = bench.arm.goal?.duration ?? 0;
    const near = (X, i) => Math.hypot(X[i * 3] - tgt[0], X[i * 3 + 1] - tgt[1], X[i * 3 + 2] - tgt[2]) < 0.03;
    await watch(bench, seconds, (t) => {
      const s = bench.stat, gi = bench.arm.gripAt;
      o.ticks++;
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
  } finally { k.E0 = keep.E0; k.tipStiff = keep.tip; k.rest = keep.rest; bench.idle(); bench.mount.setScript('hold'); }
  o.tipLagMean /= Math.max(1, o.ticks); o.shapeRmsMean /= Math.max(1, o.ticks); o.settledRms /= Math.max(1, settledN);
  const rs = arms.rodStats(), as = arms.stats();
  Object.assign(o, { rodMean: rs.mean, rodP50: rs.p50, rodP95: rs.p95, armsMean: as.mean, armsP95: as.p95 });
  for (const key of Object.keys(o)) if (typeof o[key] === 'number') o[key] = r3(o[key]);
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

register('bench-twin', { label: 'Twin check', bench: true, run: twinCheck });
register('bench-lip', { label: 'Lip check', bench: true, run: lipCheck });
register('bench-reach', { label: 'Reach check', bench: true, run: reachCheck });
register('bench-toy', { label: 'Toy throw', bench: true, run: toyCheck });
