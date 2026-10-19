import { createRng } from '../../../pond/js/rng.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Circulation {
  constructor(waves, knobs, seed) {
    Object.assign(this, { waves, knobs });
    const random = createRng((seed ^ 0x43555252) >>> 0).next;
    this.phase = Array.from({ length: 3 }, () => random() * Math.PI * 2);
    this.labels = new Int32Array(waves.h.length);
    this.nearest = new Int32Array(waves.h.length);
    this.queue = new Int32Array(waves.h.length);
    this.regions = [];
    this.generation = -1;
  }

  update(generation) {
    const w = this.waves, k = this.knobs;
    if (generation === this.generation && this.sourceX === k.sourceX && this.sourceZ === k.sourceZ) return false;
    this.generation = generation; this.sourceX = k.sourceX; this.sourceZ = k.sourceZ;
    this.labels.fill(-1); this.nearest.fill(-1); this.regions = [];
    const visit = (p, run) => {
      const x = p % w.nx, z = Math.floor(p / w.nx);
      if (x > 0) run(p - 1);
      if (x < w.nx - 1) run(p + 1);
      if (z > 0) run(p - w.nx);
      if (z < w.nz - 1) run(p + w.nx);
    };
    let distance = Infinity;
    this.sourceRegion = -1;
    for (let p = 0; p < w.solid.length; p++) {
      if (w.solid[p] || this.labels[p] >= 0) continue;
      const label = this.regions.length;
      const region = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      let head = 0, tail = 1; this.queue[0] = p; this.labels[p] = label;
      while (head < tail) {
        const q = this.queue[head++], x = q % w.nx * w.dx - w.width / 2, z = Math.floor(q / w.nx) * w.dz - w.depth / 2;
        region.minX = Math.min(region.minX, x); region.maxX = Math.max(region.maxX, x);
        region.minZ = Math.min(region.minZ, z); region.maxZ = Math.max(region.maxZ, z);
        const d = (x - k.sourceX) ** 2 + (z - k.sourceZ) ** 2;
        if (d < distance) { distance = d; this.sourceRegion = label; }
        visit(q, (next) => {
          if (w.solid[next] || this.labels[next] >= 0) return;
          this.labels[next] = label; this.queue[tail++] = next;
        });
      }
      this.regions.push(region);
    }
    let head = 0, tail = 0;
    for (let p = 0; p < w.solid.length; p++) if (!w.solid[p]) { this.nearest[p] = p; this.queue[tail++] = p; }
    while (head < tail) {
      const p = this.queue[head++];
      visit(p, (next) => {
        if (this.nearest[next] >= 0) return;
        this.nearest[next] = this.nearest[p]; this.queue[tail++] = next;
      });
    }
    return true;
  }

  cell(x, z) {
    const w = this.waves;
    const i = clamp(Math.round((x + w.width / 2) / w.dx), 0, w.nx - 1);
    const j = clamp(Math.round((z + w.depth / 2) / w.dz), 0, w.nz - 1);
    return j * w.nx + i;
  }

  rehome(positions, index) {
    const w = this.waves, p = this.cell(positions[index], positions[index + 2]);
    if (!w.solid[p] || this.nearest[p] < 0) return;
    const q = this.nearest[p];
    positions[index] = q % w.nx * w.dx - w.width / 2;
    positions[index + 2] = Math.floor(q / w.nx) * w.dz - w.depth / 2;
  }

  canTravel(ax, az, bx, bz) {
    const w = this.waves;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax) / w.dx, Math.abs(bz - az) / w.dz) * 2));
    for (let i = 1; i <= steps; i++) if (w.solid[this.cell(ax + (bx - ax) * i / steps, az + (bz - az) * i / steps)]) return false;
    return true;
  }

  sample(x, y, z, time, level, out) {
    out[0] = out[1] = out[2] = 0;
    const label = this.labels[this.cell(x, z)], region = this.regions[label];
    if (!region) return out;
    const k = this.knobs, width = Math.max(this.waves.dx * 2, region.maxX - region.minX);
    const depth = Math.max(this.waves.dz * 2, region.maxZ - region.minZ);
    const u = clamp((x - region.minX) / width, 0, 1), v = clamp(y / level, 0, 1), w = clamp((z - region.minZ) / depth, 0, 1);
    const sx = Math.sin(u * Math.PI), sy = Math.sin(v * Math.PI), sz = Math.sin(w * Math.PI);
    const t = time * k.swirlRate, scale = k.swirlScale;
    const a = Math.cos(x * scale + y * scale * 0.8 + t + this.phase[0]);
    const b = Math.cos(z * scale + x * scale - t * 0.73 + this.phase[1]);
    const c = Math.cos(y * scale * 0.8 + z * scale + t * 0.61 + this.phase[2]);
    const speed = k.ambientSpeed * (label === this.sourceRegion ? 1 : k.isolatedFlow);
    // The surface partition guides this visual current until a volumetric flow system exists.
    out[0] = speed * sx * (Math.cos(v * Math.PI) * 0.75 + (a * 0.8 - b) * 0.25);
    out[1] = speed * sy * (-Math.cos(u * Math.PI) * Math.min(1.5, level / width) * 0.75 + (c - a) * 0.2);
    out[2] = speed * sz * ((b - c * 0.8) * 0.35 + Math.sin(u * Math.PI * 2 + t * 0.3) * 0.2);
    return out;
  }
}
