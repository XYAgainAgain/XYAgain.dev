import * as THREE from 'three/webgpu';
import { TANK } from '../config.js';
import { section } from '../diag/panel.js';
import { readPose, verticalSpan } from './toy-ripples.js';
import { SandField } from './sand-core.js';
import { SandCollider } from './sand-collider.js';
import { SandContacts } from './sand-contacts.js';

export class TankSand {
  constructor(phys, knobs = {}) {
    this.phys = phys;
    this.field = new SandField(TANK.w, TANK.d, 256, 128, knobs);
    this.knobs = this.field.knobs;
    this.contacts = new SandContacts(phys, this.field);
    this.collider = new SandCollider(phys, this.field);
    phys.terrain = this.collider;
    this.contactTime = 0; this.collisionTime = 0; this.meshTime = 0; this.maskTime = 0;
    this.metrics = { tickMs: 0, meshMs: 0, updates: 0, maskBakes: 0, contacts: 0 };
    this.rebuildMask();
  }

  rebuildMask() {
    const prims = [], poses = [];
    for (const e of this.phys.rigid) {
      if (e.motion !== 'static' || e.tag === 'wall' || e === this.collider.entry) continue;
      const pose = readPose(e.body, new Float64Array(12));
      poses.push(e, this.phys.Jolt.getPointer(e.body.GetShape()), ...e.size, ...pose);
      if (['box', 'sphere', 'capsule', 'cylinder'].includes(e.kind)) prims.push({ kind: e.kind, size: e.size, pose });
    }
    if (this.maskPose?.length === poses.length && poses.every((v, i) => v === this.maskPose[i])) return false;
    const f = this.field, mask = new Uint8Array(f.h.length), interval = new Float64Array(2);
    for (let j = 0; j < f.nz; j++) for (let i = 0; i < f.nx; i++) {
      const p = j * f.nx + i;
      const x = i * f.dx - f.width / 2, z = j * f.dz - f.depth / 2;
      for (const primitive of prims) {
        if (verticalSpan(primitive.kind, primitive.size, primitive.pose, x, z, interval) && f.base[p] >= interval[0] - 0.001 && f.base[p] <= interval[1] + 0.001) { mask[p] = 1; break; }
      }
    }
    f.setMask(mask); this.maskPose = poses; this.metrics.maskBakes++;
    return true;
  }

  async mount(scene, textureSize = 1024) {
    const url = new URL('../../textures/', import.meta.url), response = await fetch(new URL('manifest.json', url));
    if (!response.ok) throw new Error(`Sand manifest: ${response.status}`);
    const manifest = await response.json(), folder = manifest.tiers[textureSize] ?? manifest.tiers[1024], loader = new THREE.TextureLoader();
    this.textures = Object.fromEntries(await Promise.all(Object.entries(manifest.sand).map(async ([key, path]) => {
      const texture = await loader.loadAsync(new URL(folder + path, url).href);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = key === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = 4;
      return [key, texture];
    })));
    const height = this.textures.height.image, canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(height, 0, 0, 128, 128); this.detail = context.getImageData(0, 0, 128, 128).data;
    const material = this.material = new THREE.MeshStandardMaterial({
      map: this.textures.albedo, normalMap: this.textures.normal, roughnessMap: this.textures.roughness,
      aoMap: this.textures.ao, aoMapIntensity: 0.35, roughness: 0.95, normalScale: new THREE.Vector2(this.knobs.relief, this.knobs.relief),
    });
    const f = this.field, geometry = new THREE.PlaneGeometry(f.width, f.depth, f.nx - 1, f.nz - 1);
    this.micro = new Float32Array(f.h.length);
    geometry.rotateX(-Math.PI / 2);
    const uv = geometry.attributes.uv, positions = geometry.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, positions.getX(i) + f.width / 2, f.depth / 2 - positions.getZ(i));
    for (const key of ['position', 'normal']) geometry.attributes[key].setUsage(THREE.DynamicDrawUsage);
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-f.width / 2, 0, -f.depth / 2), new THREE.Vector3(f.width / 2, 0.15, f.depth / 2));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.mesh = new THREE.Mesh(geometry, material); this.mesh.name = 'Deformable pebbly sand'; scene.add(this.mesh);
    this.edges = [];
    for (let i = 0; i < f.nx; i++) this.edges.push(i);
    for (let j = 1; j < f.nz; j++) this.edges.push(j * f.nx + f.nx - 1);
    for (let i = f.nx - 2; i >= 0; i--) this.edges.push((f.nz - 1) * f.nx + i);
    for (let j = f.nz - 2; j > 0; j--) this.edges.push(j * f.nx);
    const side = new THREE.BufferGeometry(), sidePositions = new Float32Array(this.edges.length * 6), sideUV = new Float32Array(this.edges.length * 4), indices = [];
    let distance = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const p = this.edges[i], next = (i + 1) % this.edges.length, x = positions.getX(p), z = positions.getZ(p);
      if (i) distance += Math.hypot(x - sidePositions[(i - 1) * 6], z - sidePositions[(i - 1) * 6 + 2]);
      sidePositions.set([x, 0, z, x, 0, z], i * 6); sideUV.set([distance, 0, distance, 0], i * 4);
      indices.push(i * 2, next * 2, i * 2 + 1, next * 2, next * 2 + 1, i * 2 + 1);
    }
    side.setAttribute('position', new THREE.BufferAttribute(sidePositions, 3).setUsage(THREE.DynamicDrawUsage));
    side.setAttribute('uv', new THREE.BufferAttribute(sideUV, 2).setUsage(THREE.DynamicDrawUsage)); side.setIndex(indices);
    this.skirt = new THREE.Mesh(side, material); this.skirt.name = 'Sand bed edges'; this.skirt.frustumCulled = false; scene.add(this.skirt);
    // Buried scenery caps end at the glass plane; a slight overlap keeps the sand edge in front of them.
    for (const mesh of [this.mesh, this.skirt]) mesh.scale.set(1 + 0.0015 / f.width, 1, 1 + 0.0015 / f.depth);
    this.sync(true);
    this.installControls();
    return this;
  }

  detailAt(x, z) {
    const size = this.knobs.tileSize, u = ((x + TANK.w / 2) / size % 1 + 1) % 1, v = ((TANK.d / 2 - z) / size % 1 + 1) % 1;
    const fx = u * 128 - 0.5, fz = (1 - v) * 128 - 0.5, i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j;
    const at = (x, y) => this.detail[(((y + 128) % 128) * 128 + (x + 128) % 128) * 4] / 255 - 0.5;
    return ((at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b) * 0.003 * this.knobs.relief;
  }

  sync(force = false) {
    if (!this.mesh) return;
    const started = performance.now(), f = this.field, style = `${this.knobs.tileSize}/${this.knobs.relief}`;
    if (style !== this.style) {
      for (const texture of Object.values(this.textures)) texture.repeat.setScalar(1 / this.knobs.tileSize);
      for (const mesh of [this.mesh, this.skirt]) mesh.material.normalScale.setScalar(this.knobs.relief);
      this.material.normalScale.setScalar(this.knobs.relief);
      const positions = this.mesh.geometry.attributes.position.array;
      for (let p = 0; p < this.micro.length; p++) this.micro[p] = this.detailAt(positions[p * 3], positions[p * 3 + 2]);
      this.style = style; force = true;
    }
    if (!force && this.version === f.version) return;
    const b = force || !f.dirty ? { x0: 0, x1: f.nx - 1, z0: 0, z1: f.nz - 1 } : f.dirty;
    const p = this.mesh.geometry.attributes.position, normal = this.mesh.geometry.attributes.normal, a = p.array;
    for (let j = Math.max(0, b.z0 - 1); j <= Math.min(f.nz - 1, b.z1 + 1); j++) for (let i = Math.max(0, b.x0 - 1); i <= Math.min(f.nx - 1, b.x1 + 1); i++) {
      const v = j * f.nx + i; a[v * 3 + 1] = Math.max(f.knobs.minimum, f.h[v] + this.micro[v]);
    }
    for (let j = b.z0; j <= b.z1; j++) {
      for (let i = b.x0; i <= b.x1; i++) {
        const left = j * f.nx + Math.max(0, i - 1), right = j * f.nx + Math.min(f.nx - 1, i + 1);
        const back = Math.max(0, j - 1) * f.nx + i, front = Math.min(f.nz - 1, j + 1) * f.nx + i;
        const x = (a[right * 3 + 1] - a[left * 3 + 1]) / ((right - left) * f.dx), z = (a[front * 3 + 1] - a[back * 3 + 1]) / ((front - back) / f.nx * f.dz), length = Math.sqrt(x * x + 1 + z * z);
        normal.setXYZ(j * f.nx + i, -x / length, 1 / length, -z / length);
      }
      p.addUpdateRange((j * f.nx + b.x0) * 3, (b.x1 - b.x0 + 1) * 3); normal.addUpdateRange((j * f.nx + b.x0) * 3, (b.x1 - b.x0 + 1) * 3);
    }
    p.needsUpdate = normal.needsUpdate = true;
    const side = this.skirt.geometry, sideP = side.attributes.position, sideUV = side.attributes.uv;
    for (let i = 0; i < this.edges.length; i++) { const y = a[this.edges[i] * 3 + 1]; sideP.setY(i * 2, y); sideUV.setY(i * 2, y); }
    sideP.needsUpdate = sideUV.needsUpdate = true; side.computeVertexNormals();
    this.version = f.version; f.dirty = null;
    this.metrics.meshMs = performance.now() - started;
  }

  tick(dt) {
    const started = performance.now();
    this.contactTime += dt;
    if (this.contactTime + 1e-8 < 1 / 30) { this.metrics.tickMs = 0; return; }
    dt = this.contactTime; this.contactTime = 0;
    this.contacts.update(dt);
    const contacted = performance.now(); this.field.step(dt);
    const evolved = performance.now();
    this.collisionTime += dt; this.maskTime += dt;
    if (this.collisionTime + 1e-8 >= 1 / 15) { this.collider.update(); this.collisionTime %= 1 / 15; }
    if (this.maskTime >= 0.5) { this.rebuildMask(); this.maskTime = 0; }
    this.metrics.tickMs = performance.now() - started; this.metrics.contacts = this.contacts.count; this.metrics.updates++;
    this.metrics.contactMs = contacted - started; this.metrics.evolveMs = evolved - contacted; this.metrics.colliderMs = performance.now() - evolved;
  }

  update(dt) {
    this.meshTime += dt;
    if (this.meshTime < 1 / 30) return;
    this.sync(); this.meshTime %= 1 / 30;
  }

  reset() { this.field.reset(); this.maskPose = null; this.rebuildMask(); this.collider.update(true); this.sync(true); }

  installControls() {
    const controls = section('Sand');
    this.actions = [
      { name: 'Reset sand', label: () => 'Reset sand', run: () => this.reset() },
      { name: 'Rebuild sand mask', label: () => 'Rebuild sand mask', run: () => { this.maskPose = null; this.rebuildMask(); } },
      ...[
        ['Texture scale', 'tileSize', [0.25, 0.35, 0.5, 0.65, 0.75, 1], (v) => `${Math.round(v * 100)} cm`],
        ['Pebble relief', 'relief', [0, 0.2, 0.3, 0.45, 0.6, 0.8, 1], (v) => `${v}×`],
        ['Terrain unevenness', 'unevenness', [0, 0.003, 0.005, 0.008, 0.01, 0.015], (v) => `${Math.round(v * 1000)} mm`],
        ['Dig strength', 'strength', [0, 0.25, 0.5, 1, 1.5, 2, 3], (v) => `${v}×`],
        ['Healing half-life', 'healHalfLife', [0, 15, 30, 60, 120, 300], (v) => v ? `${v} sec` : 'off'],
        ['Gravel settling', 'slump', [0, 0.5, 1, 2, 4, 8], (v) => `${v}×`],
        ['Excavation limit', 'limit', [0.01, 0.02, 0.03, 0.04], (v) => `${Math.round(v * 100)} cm`],
      ].map(([name, key, values, format]) => ({ type: 'range', name, values, get: () => this.knobs[key], label: () => `${name}: ${format(this.knobs[key])}`,
        set: (value) => { this.knobs[key] = value; if (key === 'unevenness' || key === 'limit') this.reset(); else this.sync(); } })),
    ];
    for (const action of this.actions) controls.add(action);
  }

  dispose() {
    this.mesh?.removeFromParent(); this.skirt?.removeFromParent(); this.mesh?.geometry.dispose(); this.skirt?.geometry.dispose();
    this.material?.dispose(); for (const texture of Object.values(this.textures ?? {})) texture.dispose();
    this.collider.dispose(); if (this.phys.terrain === this.collider) this.phys.terrain = null;
    for (const action of this.actions ?? []) if (action.button) action.button.disabled = true;
  }
}
