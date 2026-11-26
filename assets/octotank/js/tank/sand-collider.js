import { LAYERS } from '../config.js';

export class SandCollider {
  constructor(phys, field, resolution = 64) {
    Object.assign(this, { phys, field, resolution });
    const J = phys.Jolt, settings = new J.HeightFieldShapeSettings(), n = resolution;
    settings.mSampleCount = n; settings.mBlockSize = 4; settings.mBitsPerSample = 8;
    settings.mMinHeightValue = 0; settings.mMaxHeightValue = 0.15;
    settings.mOffset.Set(-field.width / 2, 0, -field.depth / 2);
    settings.mScale.Set(field.width / (n - 1), 1, field.depth / (n - 1));
    this.samples = new J.ArrayFloat(); this.samples.resize(n * n);
    this.heights = new Float32Array(n * n);
    this.sourceVersion = new Float64Array(field.patchVersion.length).fill(-1);
    this.sourceSamples = Array.from({ length: field.patchVersion.length }, () => []);
    this.sampleMarked = new Uint8Array(n * n); this.pendingSamples = new Int32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = i * field.width / (n - 1) - field.width / 2, z = j * field.depth / (n - 1) - field.depth / 2;
      const fx = Math.max(0, Math.min(field.nx - 1, (x + field.width / 2) / field.dx)), fz = Math.max(0, Math.min(field.nz - 1, (z + field.depth / 2) / field.dz));
      const sx = Math.min(field.nx - 2, Math.floor(fx)), sz = Math.min(field.nz - 2, Math.floor(fz));
      const patches = new Set();
      for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) patches.add(Math.floor((sz + dz) / field.patchSize) * field.patchNX + Math.floor((sx + dx) / field.patchSize));
      for (const patch of patches) this.sourceSamples[patch].push(j * n + i);
    }
    this.fill();
    settings.mHeightSamples = this.samples;
    const result = settings.Create();
    if (result.HasError()) { const error = result.GetError().c_str(); J.destroy(result); J.destroy(settings); J.destroy(this.samples); throw new Error(`Sand collision: ${error}`); }
    this.shape = J.castObject(result.Get(), J.HeightFieldShape); this.shape.AddRef();
    J.destroy(result); J.destroy(settings);
    const position = new J.RVec3(0, 0, 0), rotation = new J.Quat(0, 0, 0, 1);
    const creation = new J.BodyCreationSettings(this.shape, position, rotation, J.EMotionType_Static, LAYERS.NON_MOVING);
    creation.mFriction = 0.65; creation.mEnhancedInternalEdgeRemoval = true;
    const body = phys.bodies.CreateBody(creation), id = body.GetID();
    phys.bodies.AddBody(id, J.EActivation_DontActivate);
    J.destroy(creation); J.destroy(position); J.destroy(rotation);
    this.entry = { body, id, motion: 'static', tag: 'sand', taste: 'sand', kind: 'heightfield', pos: [0, 0, 0], size: [field.width / 2, 0.15, field.depth / 2] };
    phys.rigid.push(this.entry);
    this.center = new J.Vec3(); this.center.Set(...this.centerOfMass());
    this.version = field.version; this.updates = 0;
  }

  centerOfMass() {
    const v = this.shape.GetCenterOfMass(); return [v.GetX(), v.GetY(), v.GetZ()];
  }

  fill(force = false) {
    const f = this.field, n = this.resolution;
    let count = 0;
    this.changed = null; this.heightChanged = false;
    for (let p = 0; p < this.sourceVersion.length; p++) {
      if (!force && this.sourceVersion[p] === f.patchVersion[p]) continue;
      this.sourceVersion[p] = f.patchVersion[p];
      for (const q of this.sourceSamples[p]) if (!this.sampleMarked[q]) { this.sampleMarked[q] = 1; this.pendingSamples[count++] = q; }
    }
    for (let k = 0; k < count; k++) {
      const p = this.pendingSamples[k], i = p % n, j = Math.floor(p / n);
      this.sampleMarked[p] = 0;
      const x = i * f.width / (n - 1) - f.width / 2, z = j * f.depth / (n - 1) - f.depth / 2, height = f.sample(x, z);
      if (Math.abs(height - this.heights[p]) > 1e-5) {
        const b = this.changed;
        if (b) { b.x0 = Math.min(x, b.x0); b.x1 = Math.max(x, b.x1); b.z0 = Math.min(z, b.z0); b.z1 = Math.max(z, b.z1); }
        else this.changed = { x0: x, x1: x, z0: z, z1: z };
      }
      if (Math.fround(height) !== this.heights[p]) this.heightChanged = true;
      this.heights[p] = height;
    }
    if (this.heightChanged || !this.shape) {
      const J = this.phys.Jolt;
      J.HEAPF32.set(this.heights, J.getPointer(this.samples.data()) >>> 2);
    }
  }

  update(force = false) {
    if (!force && this.version === this.field.version) return false;
    const { phys, field: f, resolution: n } = this;
    this.fill(force);
    // Partial writes re-quantize decoded neighbors; full writes preserve the original sample inputs.
    // Creation also quantizes differently, so the first refresh must commit even an unchanged bed.
    if (force || this.heightChanged || !this.committed) {
      this.shape.SetHeights(0, 0, n, n, this.samples.data(), n, phys.jolt.GetTempAllocator());
      phys.bodies.NotifyShapeChanged(this.entry.id, this.center, false, phys.Jolt.EActivation_DontActivate);
      this.center.Set(...this.centerOfMass());
      this.committed = true;
    }
    // Outside the commit guard on purpose: keeping Jolt's warm-start contacts moves resting toys.
    phys.bodies.InvalidateContactCache(this.entry.id);
    const b = this.changed;
    if (b) for (const entry of phys.rigid) {
      if (entry.motion !== 'dynamic' || entry.body.IsActive()) continue;
      const p = entry.body.GetPosition(), x = p.GetX(), y = p.GetY(), z = p.GetZ();
      if (y > 0.2 || x < b.x0 - 0.1 || x > b.x1 + 0.1 || z < b.z0 - 0.1 || z > b.z1 + 0.1) continue;
      phys.bodies.ActivateBody(entry.id);
    }
    this.version = f.version; this.updates++;
    return true;
  }

  distance(x, y, z, out) {
    const f = this.field, n = this.resolution, h = this.heights;
    if (Math.abs(x) > f.width / 2 || Math.abs(z) > f.depth / 2) return Infinity;
    const dx = f.width / (n - 1), dz = f.depth / (n - 1);
    const fx = Math.max(0, Math.min(n - 1, (x + f.width / 2) / dx)), fz = Math.max(0, Math.min(n - 1, (z + f.depth / 2) / dz));
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz)), u = fx - i, v = fz - j;
    const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    const sx = v >= u ? (d - c) / dx : (b - a) / dx, sz = v >= u ? (c - a) / dz : (d - b) / dz;
    const height = v >= u ? a + (d - c) * u + (c - a) * v : a + (b - a) * u + (d - b) * v;
    const length = Math.hypot(sx, 1, sz);
    out[0] = -sx / length; out[1] = 1 / length; out[2] = -sz / length;
    return (y - height) / length;
  }

  dispose() {
    this.phys.removeRigid(this.entry);
    this.shape.Release(); this.phys.Jolt.destroy(this.samples); this.phys.Jolt.destroy(this.center);
  }
}
