import { createRng, deriveSeed } from '../../../pond/js/rng.js';

export const SAND_KNOBS = {
  seed: 420, depth: 0.05, unevenness: 0.008, limit: 0.04, minimum: 0.01,
  tileSize: 0.35, relief: 0.45, strength: 1, healHalfLife: 60, slump: 2,
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (v) => v * v * (3 - 2 * v);

function noise(table, x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix), v = smooth(z - iz);
  const at = (a, b) => table[((b & 63) * 64) + (a & 63)];
  const a = at(ix, iz), b = at(ix + 1, iz), c = at(ix, iz + 1), d = at(ix + 1, iz + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export class SandField {
  constructor(width, depth, nx = 256, nz = 128, knobs = {}) {
    Object.assign(this, { width, depth, nx, nz });
    this.knobs = { ...SAND_KNOBS, ...knobs };
    this.dx = width / (nx - 1); this.dz = depth / (nz - 1);
    const n = nx * nz;
    for (const name of ['base', 'h', 'cut', 'ridge', 'removed']) this[name] = new Float32Array(n);
    this.blocked = new Uint8Array(n); this.occupied = new Uint8Array(n);
    this.pending = new Int32Array(n); this.marked = new Uint8Array(n); this.pendingCount = 0;
    this.island = new Int32Array(n);
    this.region = new Int32Array(n); this.queue = new Int32Array(n);
    this.version = 0; this.dirty = null; this.active = null;
    this.reset(); this.setMask(this.blocked);
  }

  reset() {
    const rng = createRng(deriveSeed(this.knobs.seed, 4601)), table = Float32Array.from({ length: 4096 }, () => rng.range(-1, 1));
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const x = i * this.dx, z = j * this.dz;
      let value = 0, amplitude = 1, sum = 0;
      for (let octave = 0; octave < 4; octave++) {
        const scale = 3 * 2 ** octave;
        value += noise(table, x * scale + 13.2, z * scale + 7.4) * amplitude;
        sum += amplitude; amplitude *= 0.45;
      }
      const p = j * this.nx + i;
      this.base[p] = this.h[p] = Math.max(this.knobs.minimum, this.knobs.depth + value / sum * this.knobs.unevenness);
    }
    this.cut.fill(0); this.ridge.fill(0); this.occupied.fill(0); this.marked.fill(0); this.pendingCount = 0;
    this.active = null; this.touch(0, this.nx - 1, 0, this.nz - 1);
  }

  touch(x0, x1, z0, z1) {
    const b = this.dirty;
    this.dirty = b ? { x0: Math.min(b.x0, x0), x1: Math.max(b.x1, x1), z0: Math.min(b.z0, z0), z1: Math.max(b.z1, z1) } : { x0, x1, z0, z1 };
    this.version++;
  }

  setMask(mask) {
    this.blocked.set(mask); this.region.fill(-1);
    let regions = 0;
    for (let p = 0; p < mask.length; p++) {
      if (mask[p] || this.region[p] >= 0) continue;
      let head = 0, tail = 1; this.queue[0] = p; this.region[p] = regions;
      while (head < tail) {
        const q = this.queue[head++], i = q % this.nx, j = (q / this.nx) | 0;
        for (const k of [i > 0 ? q - 1 : -1, i + 1 < this.nx ? q + 1 : -1, j > 0 ? q - this.nx : -1, j + 1 < this.nz ? q + this.nx : -1]) {
          if (k < 0 || mask[k] || this.region[k] >= 0) continue;
          this.region[k] = regions; this.queue[tail++] = k;
        }
      }
      regions++;
    }
    this.regions = regions;
    this.resizeBudgets(32);
  }

  resizeBudgets(count) {
    if (this.budget?.length >= count) return;
    const capacity = Math.max(count, (this.budget?.length ?? 16) * 2);
    for (const name of ['budget', 'weights', 'excavated', 'spent']) this[name] = new Float64Array(capacity);
  }

  contactIslands() {
    for (let i = 0; i < this.pendingCount; i++) this.island[this.pending[i]] = -1;
    let count = 0;
    for (let i = 0; i < this.pendingCount; i++) {
      const start = this.pending[i], region = this.region[start];
      if (region < 0 || this.island[start] >= 0) continue;
      let head = 0, tail = 1; this.queue[0] = start; this.island[start] = count;
      while (head < tail) {
        const p = this.queue[head++], x = p % this.nx, z = (p / this.nx) | 0;
        for (let axis = 0; axis < 4; axis++) {
          const q = axis === 0 ? (x ? p - 1 : -1) : axis === 1 ? (x + 1 < this.nx ? p + 1 : -1) : axis === 2 ? (z ? p - this.nx : -1) : (z + 1 < this.nz ? p + this.nx : -1);
          if (q < 0 || !this.marked[q] || this.region[q] !== region || this.island[q] >= 0) continue;
          this.island[q] = count; this.queue[tail++] = q;
        }
      }
      count++;
    }
    this.sites = count; this.resizeBudgets(count);
  }

  sample(x, z, out = null) {
    const fx = clamp((x + this.width / 2) / this.dx, 0, this.nx - 1), fz = clamp((z + this.depth / 2) / this.dz, 0, this.nz - 1);
    const i = Math.min(this.nx - 2, Math.floor(fx)), j = Math.min(this.nz - 2, Math.floor(fz)), u = fx - i, v = fz - j;
    const a = this.h[j * this.nx + i], b = this.h[j * this.nx + i + 1], c = this.h[(j + 1) * this.nx + i], d = this.h[(j + 1) * this.nx + i + 1];
    if (out) {
      const sx = ((b - a) * (1 - v) + (d - c) * v) / this.dx, sz = ((c - a) * (1 - u) + (d - b) * u) / this.dz;
      const length = Math.hypot(sx, 1, sz); out[0] = -sx / length; out[1] = 1 / length; out[2] = -sz / length;
    }
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }

  beginContacts() { this.occupied.fill(0); }

  contact(x, bottom, z, radius, speed, force, dt) {
    if (!Number.isFinite(x + bottom + z + radius + speed + force + dt) || radius <= 0 || dt <= 0) return;
    if (bottom > this.sample(x, z) + 0.012 || Math.abs(x) > this.width / 2 || Math.abs(z) > this.depth / 2) return;
    const r = Math.max(radius, this.dx * 1.5, this.dz * 1.5), reach = r * 2.4;
    const cx = (x + this.width / 2) / this.dx, cz = (z + this.depth / 2) / this.dz;
    const center = clamp(Math.round(cz), 0, this.nz - 1) * this.nx + clamp(Math.round(cx), 0, this.nx - 1), region = this.region[center];
    if (region < 0) return;
    const x0 = Math.max(0, Math.floor(cx - reach / this.dx)), x1 = Math.min(this.nx - 1, Math.ceil(cx + reach / this.dx));
    const z0 = Math.max(0, Math.floor(cz - reach / this.dz)), z1 = Math.min(this.nz - 1, Math.ceil(cz + reach / this.dz));
    const amount = Math.min(0.008, Math.max(0, speed - 0.01) * Math.sqrt(Math.max(0, force) / 0.05) * 0.04 * this.knobs.strength * dt);
    // Squared distances in contact radii: 1.2² holds the footprint against healing, the divot cuts inside 1,
    // and the ridge peaks at 1.7 out to the 2.4 reach.
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
      const p = j * this.nx + i;
      if (this.region[p] !== region) continue;
      const dx = (i - cx) * this.dx / r, dz = (j - cz) * this.dz / r, square = dx * dx + dz * dz;
      if (square <= 1.44) this.occupied[p] = 1;
      if (square < 5.76 && amount > 0 && !this.marked[p]) { this.marked[p] = 1; this.pending[this.pendingCount++] = p; }
      if (square < 1) this.cut[p] = Math.max(this.cut[p], amount * (1 - square) ** 2);
      else if (square < 5.76 && amount > 0) this.ridge[p] = Math.max(this.ridge[p], (1 - Math.abs(Math.sqrt(square) - 1.7) / 0.7) ** 2);
    }
    if (amount > 0) this.wake(x0, x1, z0, z1);
  }

  wake(x0, x1, z0, z1) {
    const b = this.active;
    this.active = b ? { x0: Math.min(b.x0, x0), x1: Math.max(b.x1, x1), z0: Math.min(b.z0, z0), z1: Math.max(b.z1, z1) } : { x0, x1, z0, z1 };
  }

  step(dt) {
    if (!this.active || !Number.isFinite(dt) || dt <= 0) return false;
    const b = this.active, k = this.knobs, h = this.h, occupied = this.occupied;
    const x0 = Math.max(0, b.x0 - 1), x1 = Math.min(this.nx - 1, b.x1 + 1), z0 = Math.max(0, b.z0 - 1), z1 = Math.min(this.nz - 1, b.z1 + 1);
    const each = (fn) => { for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) fn(j * this.nx + i, i, j); };
    const pending = (fn) => { for (let i = 0; i < this.pendingCount; i++) fn(this.pending[i]); };
    this.contactIslands();
    this.budget.fill(0); this.excavated.fill(0);
    let changed = false;
    pending((p) => {
      this.removed[p] = 0;
      if (this.blocked[p]) { this.cut[p] = this.ridge[p] = 0; return; }
      const take = Math.min(this.cut[p], Math.max(0, h[p] - Math.max(k.minimum, this.base[p] - k.limit)));
      this.cut[p] = 0;
      if (take > 0) { const old = h[p]; h[p] -= take; this.removed[p] = old - h[p]; this.budget[this.island[p]] += this.removed[p]; changed = true; }
    });
    this.excavated.set(this.budget);
    // Only touching contact patches share gravel, so distant simultaneous digs cannot feed each other's ridges.
    for (let pass = 0; pass < 4; pass++) {
      this.weights.fill(0);
      pending((p) => { if (this.ridge[p] > 0 && !occupied[p] && !this.blocked[p] && h[p] < this.base[p] + k.limit - 1e-7) this.weights[this.island[p]] += this.ridge[p]; });
      const spent = this.spent; spent.fill(0);
      pending((p) => {
        const r = this.island[p];
        if (r < 0 || occupied[p] || !this.weights[r] || !this.ridge[p]) return;
        const rise = Math.min(Math.max(0, this.base[p] + k.limit - h[p]), this.budget[r] * this.ridge[p] / this.weights[r]);
        const old = h[p]; h[p] += rise; spent[r] += h[p] - old;
      });
      for (let r = 0; r < this.sites; r++) this.budget[r] = Math.max(0, this.budget[r] - spent[r]);
    }
    pending((p) => {
      const r = this.island[p];
      if (r >= 0 && this.excavated[r] > 0) h[p] += this.removed[p] * this.budget[r] / this.excavated[r];
      this.ridge[p] = 0; this.marked[p] = 0;
    });
    this.pendingCount = 0;
    const keep = k.healHalfLife > 0 ? Math.exp(-Math.LN2 * dt / k.healHalfLife) : 1;
    each((p, i, j) => {
      if (this.blocked[p] || occupied[p]) return;
      const old = h[p], delta = old - this.base[p];
      h[p] = keep < 1 && Math.abs(delta) < 1e-6 ? this.base[p] : this.base[p] + delta * keep;
      for (let axis = 0; axis < 2; axis++) {
        const q = axis ? (j < z1 ? p + this.nx : -1) : (i < x1 ? p + 1 : -1);
        if (q < 0 || this.blocked[q] || occupied[q]) continue;
        const difference = h[p] - h[q], excess = Math.max(0, Math.abs(difference) - 0.65 * (q === p + 1 ? this.dx : this.dz));
        if (!excess) continue;
        const high = difference > 0 ? p : q, low = difference > 0 ? q : p;
        const move = Math.min(excess * Math.min(0.24, k.slump * dt), h[high] - Math.max(k.minimum, this.base[high] - k.limit), this.base[low] + k.limit - h[low]);
        if (move > 0) { h[high] -= move; h[low] += move; changed = true; }
      }
      if (Math.abs(h[p] - old) > 1e-9) changed = true;
    });
    let live = null;
    each((p, i, j) => {
      if (Math.abs(h[p] - this.base[p]) < 1e-6) return;
      if (!live) live = { x0: i, x1: i, z0: j, z1: j };
      else { live.x0 = Math.min(live.x0, i); live.x1 = Math.max(live.x1, i); live.z0 = Math.min(live.z0, j); live.z1 = Math.max(live.z1, j); }
    });
    this.active = live;
    if (changed) this.touch(x0, x1, z0, z1);
    return changed;
  }
}
