import * as THREE from 'three/webgpu';
import { VIEW_KNOBS, ArmTube, WebSector, newFrame, ringAtArc, tubeIndex, gridIndex, sectorName, webArmDepth } from './arm-view-core.js';

/* Her arms as she looks: one smooth tube per body chain at its drawn girth, the sucker cups along its oral face, the
   web between neighboring arm bases, and for a rod arm its other chain (the intent, or a shadow rod) as a thin ghost.
   Render-only; the capsules stay the collision and are hidden unless asked for. */

const SKIN = 0x8c5fb0;
const CUP = 0xa987c4;   // the skin a quarter of the way to white
const GHOST = 0x9fe3f0;
const WINDOW = 240;

/* A shallow cup of unit radius around +Y: a rim, a dimple, and a base sunk `sink` under the skin. */
function cupGeometry(sink) {
  const pts = [[0, 0.06], [0.3, 0.1], [0.55, 0.24], [0.72, 0.32], [0.86, 0.3], [0.97, 0.2], [1, 0.06], [0.96, -sink]];
  return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 12);
}

export class ArmView {
  constructor(arms, mantle, scene, knobs = {}) {
    this.arms = arms;
    this.mantle = mantle;
    this.scene = scene;
    const k = this.knobs = { ...VIEW_KNOBS, ghostGirth: 0.45, ...knobs };
    const count = arms.arms.length;
    this.tubes = arms.bodies.map((arm) => new ArmTube(arm.n, k));
    const vc = this.tubeVerts = this.tubes[0].vertexCount;
    this.skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.35, metalness: 0.05 });
    this.tubeGeo = dynamicGeometry(count * vc, tubeIndex(count, this.tubes[0].ringCount, this.tubes[0].sides));
    this.tubeMesh = new THREE.Mesh(this.tubeGeo, this.skin);
    // Moving geometry whose bounds are never refit: culling would drop her arms for a close camera.
    this.tubeMesh.frustumCulled = false;
    scene.add(this.tubeMesh);

    const total = arms.layouts.reduce((s, L) => s + L.n, 0);
    this.capacity = Math.ceil(total * 1.5);
    this.cupMat = new THREE.MeshStandardMaterial({ color: CUP, roughness: 0.45, metalness: 0.02 });
    this.cups = new THREE.InstancedMesh(cupGeometry(k.cupSink), this.cupMat, this.capacity);
    this.cups.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cups.frustumCulled = false;
    this.cups.count = 0;
    scene.add(this.cups);
    this.cupCache = arms.arms.map(() => ({ layout: null, gen: -1, u: null, big: null }));
    this.cupOff = new Int32Array(count + 1);

    // A lone arm (the bench) has no neighbor to web to.
    const U = k.webU, V = k.webV, wv = this.webVerts = (U + 1) * (V + 1), sectors = count > 1 ? count : 0;
    this.webs = Array.from({ length: sectors }, (_, r) => Object.assign(new WebSector(U, V), { a: r, b: (r + 1) % count, name: sectorName(r, count), gens: [-1, -1] }));
    this.webSkin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.35, metalness: 0.05, side: THREE.DoubleSide });
    this.webGeo = sectors ? dynamicGeometry(sectors * wv, gridIndex(sectors, U, V)) : null;
    this.webMesh = sectors ? new THREE.Mesh(this.webGeo, this.webSkin) : null;
    if (this.webMesh) { this.webMesh.frustumCulled = false; scene.add(this.webMesh); }
    this._mouthGaps();
    this._webOpts = { inset: k.webInset, fullness: k.fullness, count, down: [0, -1, 0] };

    const slots = arms.rods.map((rod, a) => (rod ? a : -1)).filter((a) => a >= 0);
    this.ghostSlots = slots;
    this.ghostTubes = slots.map((a) => new ArmTube(arms.arms[a].n, k));
    this.ghostSkin = new THREE.MeshStandardMaterial({ color: GHOST, roughness: 0.6, metalness: 0, transparent: true, opacity: 0.28, depthWrite: false });
    this.ghostGeo = slots.length ? dynamicGeometry(slots.length * vc, tubeIndex(slots.length, this.tubes[0].ringCount, this.tubes[0].sides)) : null;
    this.ghostMesh = slots.length ? new THREE.Mesh(this.ghostGeo, this.ghostSkin) : null;
    if (this.ghostMesh) { this.ghostMesh.frustumCulled = false; this.ghostMesh.renderOrder = 1; scene.add(this.ghostMesh); }

    this._f = newFrame();
    this._in = [0, 0, 0];
    this._root = [0, 0, 0];
    this._rad = arms.arms.map((arm) => new Float64Array(arm.n));
    this.capsuleMeshes = [];
    this._capsules = false;
    this.ms = new Float32Array(WINDOW);
    this.msCount = 0;
  }

  /* A rod arm's other chain drawn beside it, so the rod's lag and sag read at a glance. */
  get ghost() { return !!this.ghostMesh?.visible; }
  set ghost(v) { if (this.ghostMesh) this.ghostMesh.visible = !!v; }

  /* The arm capsules' meshes, shown only for debugging. */
  get capsules() { return this._capsules; }
  set capsules(v) {
    this._capsules = !!v;
    for (const m of this.capsuleMeshes) m.visible = this._capsules;
  }

  /* Each sector's distance from her mouth to the middle of its two roots, at her spawn pose: Jereb et al. measure web
     depth from the mouth, and the arms start this far out. */
  _mouthGaps() {
    const m = this.mantle, ring = m.ring(), drop = this.arms.knobs.mouthDrop ?? 0;
    const mouth = [ring.c[0] + ring.down[0] * drop, ring.c[1] + ring.down[1] * drop, ring.c[2] + ring.down[2] * drop];
    const pa = [0, 0, 0], pb = [0, 0, 0];
    for (const w of this.webs) {
      m.rootWorld(w.a, pa); m.rootWorld(w.b, pb);
      w.mouthGap = Math.hypot((pa[0] + pb[0]) / 2 - mouth[0], (pa[1] + pb[1]) / 2 - mouth[1], (pa[2] + pb[2]) / 2 - mouth[2]);
    }
  }

  _layoutWeb(w) {
    const k = this.knobs, arms = this.arms.bodies, A = arms[w.a], B = arms[w.b];
    const longest = arms.reduce((x, arm) => Math.max(x, arm.length), 0);
    const mid = k.webDeep * longest * (k.webOrder[w.name] ?? 1);
    w.midDepth = mid;
    w.layout(webArmDepth(mid, Number.isFinite(w.mouthGap) ? w.mouthGap : 0, k.scallop), k.scallop, A, B, this.tubes[w.a].sub);
    w.gens[0] = A.restGen; w.gens[1] = B.restGen;
  }

  /* Per-sucker ring params and which cups are the enlarged few, rebuilt whenever the arm's layout object (replaced
     on a re-layout) or its rest geometry changes. */
  _cupLayout(a) {
    const c = this.cupCache[a], L = this.arms.layouts[a], arm = this.arms.bodies[a];
    if (c.layout === L && c.gen === arm.restGen) return c;
    // The layout sized its cups on the authored arm; a rod arm draws thicker, so its enlarged cups grow by as much.
    const sub = this.tubes[a].sub, rad0 = this.arms.arms[a].rad0, drawn = arm.drawRad0 ?? rad0;
    if (!c.u || c.u.length < L.n) { c.u = new Float64Array(L.n); c.big = new Uint8Array(L.n); c.grow = new Float64Array(L.n); }
    const frac = this.arms.suckerKnobs.suckerFrac;
    for (let i = 0; i < L.n; i++) {
      c.u[i] = ringAtArc(L.arc[i], arm.len0, arm.arc0, sub);
      const j = L.seg[i], f = Math.max(0, Math.min(1, (L.arc[i] - arm.arc0[j]) / arm.len0[j]));
      const r = rad0[j] + (rad0[j + 1] - rad0[j]) * f;
      c.big[i] = L.radius[i] > 1.01 * frac * r ? 1 : 0;
      c.grow[i] = (drawn[j] + (drawn[j + 1] - drawn[j]) * f) / r;
    }
    c.layout = L; c.gen = arm.restGen;
    if (!this._warned && this.arms.layouts.reduce((s, x) => s + x.n, 0) > this.capacity) {
      this._warned = true;
      console.warn(`ArmView: ${this.capacity} sucker cups drawn at most; the layout asks for more.`);
    }
    return c;
  }

  update() {
    const t0 = performance.now();
    const k = this.knobs, arms = this.arms.bodies, tubes = this.tubes, count = arms.length;
    const pos = this.tubeGeo.attributes.position.array, nor = this.tubeGeo.attributes.normal.array;
    const girth = Number.isFinite(k.girth) && k.girth > 0 ? k.girth : 1;
    const N = this.arms.rootsN, inw = this._in;
    for (let a = 0; a < count; a++) {
      const arm = arms[a];
      inw[0] = -N[a * 3]; inw[1] = -N[a * 3 + 1]; inw[2] = -N[a * 3 + 2];
      // A chain gone non-finite would poison the whole merged buffer; its last good shape stays drawn.
      if (tubes[a].update(arm.X, this._radii(a, arm), arm.SK, girth, this.mantle.rootWorld(a, this._root), arm.D, arm.twist)) tubes[a].write(pos, nor, a * this.tubeVerts, k.rootSink, Number.isFinite(inw[0] + inw[1] + inw[2]) ? inw : null);
    }
    this.tubeGeo.attributes.position.needsUpdate = true;
    this.tubeGeo.attributes.normal.needsUpdate = true;
    if (this.ghost) this._writeGhosts(girth);

    if (this.cups.visible) this._writeCups();
    if (!this.webMesh) { this.ms[this.msCount++ % WINDOW] = performance.now() - t0; return; }

    const wpos = this.webGeo.attributes.position.array, wnor = this.webGeo.attributes.normal.array, wv = this.webVerts;
    const o = this._webOpts, down = this.mantle.ring().down;
    o.inset = k.webInset; o.fullness = k.fullness;
    o.down[0] = down[0]; o.down[1] = down[1]; o.down[2] = down[2];
    const gen = this._knobGen();
    for (let s = 0; s < count; s++) {
      const w = this.webs[s];
      if (w.gens[0] !== arms[w.a].restGen || w.gens[1] !== arms[w.b].restGen || w.knobGen !== gen) { this._layoutWeb(w); w.knobGen = gen; }
      if (tubes[w.a].valid && tubes[w.b].valid) w.write(tubes[w.a], tubes[w.b], wpos, wnor, s * wv, o);
    }
    this.webGeo.attributes.position.needsUpdate = true;
    this.webGeo.attributes.normal.needsUpdate = true;

    this.ms[this.msCount++ % WINDOW] = performance.now() - t0;
  }

  _writeGhosts(girth) {
    const pos = this.ghostGeo.attributes.position.array, nor = this.ghostGeo.attributes.normal.array, N = this.arms.rootsN, inw = this._in;
    const g = girth * (this.knobs.ghostGirth > 0 ? this.knobs.ghostGirth : 0.45);
    for (let s = 0; s < this.ghostSlots.length; s++) {
      const a = this.ghostSlots[s], A = this.arms, arm = A.bodies[a] === A.arms[a] ? A.rods[a] : A.arms[a], tube = this.ghostTubes[s];
      inw[0] = -N[a * 3]; inw[1] = -N[a * 3 + 1]; inw[2] = -N[a * 3 + 2];
      if (tube.update(arm.X, arm.drawRad ?? arm.rad, arm.SK, g, this.mantle.rootWorld(a, this._root), arm.D, arm.twist)) tube.write(pos, nor, s * this.tubeVerts, this.knobs.rootSink, Number.isFinite(inw[0] + inw[1] + inw[2]) ? inw : null);
    }
    this.ghostGeo.attributes.position.needsUpdate = true;
    this.ghostGeo.attributes.normal.needsUpdate = true;
  }

  /* The live drawn radii (a rod's collision radius is capped at the root), or with previewRoot set, carried onto a
     candidate taper (root radius previewRoot, exponent previewPow, the arm's own tip), to judge it before it exists. */
  _radii(a, arm) {
    const k = this.knobs, rad = arm.drawRad ?? arm.rad;
    if (!(k.previewRoot > 0)) return rad;
    const out = this._rad[a], rad0 = arm.drawRad0 ?? arm.rad0, tip = arm.knobs.tipRadius, pow = k.previewPow > 0 ? k.previewPow : arm.knobs.taperPow, L = arm.length;
    for (let i = 0; i < arm.n; i++) {
      const want = tip + (k.previewRoot - tip) * Math.pow(Math.max(0, 1 - arm.arc0[i] / L), pow);
      out[i] = rad[i] * want / Math.max(1e-5, rad0[i]);
    }
    return out;
  }

  /* The web's depth knobs folded into one number, so a live change re-lays every sector. */
  _knobGen() {
    const k = this.knobs, o = k.webOrder;
    return k.webDeep * 1e6 + k.scallop * 1e3 + o.A + o.B * 3 + o.C * 7 + o.D * 11 + o.E * 13;
  }

  _writeCups() {
    const k = this.knobs, arms = this.arms, sk = arms.suckerKnobs, M = this.cups.instanceMatrix.array, f = this._f, off = this.cupOff;
    const ca = Math.cos(k.rowAngle), sa = Math.sin(k.rowAngle), cap = this.capacity;
    off[0] = 0;
    for (let a = 0; a < arms.arms.length; a++) {
      const L = arms.layouts[a], c = this._cupLayout(a), tube = this.tubes[a], n = Math.max(0, Math.min(L.n, cap - off[a]));
      off[a + 1] = off[a] + n;
      if (!tube.valid) continue;
      for (let i = 0; i < n; i++) {
        tube.frameAt(c.u[i], f);
        const side = L.row[i] ? sa : -sa, t = f.t, o = f.o, b = f.b;
        const dx = o[0] * ca + b[0] * side, dy = o[1] * ca + b[1] * side, dz = o[2] * ca + b[2] * side;
        // Ordinary cups follow the drawn arm; the enlarged few keep their own size, grown with a rod arm's girth.
        const s = c.big[i] ? Math.max(L.radius[i] * c.grow[i], sk.suckerFrac * f.r) : sk.suckerFrac * f.r;
        const zx = t[1] * dz - t[2] * dy, zy = t[2] * dx - t[0] * dz, zz = t[0] * dy - t[1] * dx;
        const m = (off[a] + i) * 16;
        M[m] = t[0] * s; M[m + 1] = t[1] * s; M[m + 2] = t[2] * s; M[m + 3] = 0;
        M[m + 4] = dx * s; M[m + 5] = dy * s; M[m + 6] = dz * s; M[m + 7] = 0;
        M[m + 8] = zx * s; M[m + 9] = zy * s; M[m + 10] = zz * s; M[m + 11] = 0;
        M[m + 12] = f.c[0] + dx * f.r; M[m + 13] = f.c[1] + dy * f.r; M[m + 14] = f.c[2] + dz * f.r; M[m + 15] = 1;
      }
    }
    this.cups.count = off[arms.arms.length];
    this.cups.instanceMatrix.needsUpdate = true;
  }

  /* Mean and 95th percentile of update() in ms over the last WINDOW drawn frames. */
  stats() {
    const n = Math.min(this.msCount, WINDOW);
    if (!n) return { mean: 0, p95: 0, n: 0 };
    const sorted = Array.from(this.ms.subarray(0, n)).sort((x, y) => x - y);
    return { mean: sorted.reduce((x, y) => x + y, 0) / n, p95: sorted[Math.min(n - 1, Math.floor(n * 0.95))], n };
  }

  resetStats() { this.msCount = 0; }

  dispose() {
    for (const m of [this.tubeMesh, this.cups, this.webMesh, this.ghostMesh]) { if (!m) continue; this.scene.remove(m); m.geometry.dispose(); }
    this.cups.dispose();
    this.skin.dispose(); this.cupMat.dispose(); this.webSkin.dispose(); this.ghostSkin.dispose();
    // The capsule meshes belong to the rigid-body view, so they go back visible.
    this.capsules = true;
  }
}

function dynamicGeometry(verts, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}
