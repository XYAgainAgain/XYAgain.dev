export const VISUAL_KNOBS = {
  sourceX: -0.92, sourceZ: -0.29, rippleStrength: 0.0015,
  caustics: 0.95, particles: 320, particleOpacity: 0.32,
  opticsHz: 30, reflectionResolution: 2048, reflectionHz: 30, reflectionStrength: 1.2, reflections: true,
  refractionResolution: 384, refractionHz: 30, refractions: true,
  contactStrength: 0.002, currentStrength: 0.14,
  ambientSpeed: 0.012, isolatedFlow: 0.22, swirlScale: 3.5, swirlRate: 0.12,
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Waves {
  constructor(width = 2, depth = 0.7, nx = 128, nz = 48) {
    Object.assign(this, { width, depth, nx, nz });
    this.dx = width / (nx - 1); this.dz = depth / (nz - 1);
    this.h = new Float32Array(nx * nz);
    this.v = new Float32Array(nx * nz);
    this.next = new Float32Array(nx * nz);
    this.solid = new Uint8Array(nx * nz);
    this.neighbors = new Int32Array(nx * nz * 4);
    this.visited = new Uint32Array(nx * nz);
    this.queue = new Int32Array(nx * nz);
    this.stamp = 0;
    this.setObstacles(this.solid);
    this.accumulator = 0;
    this.time = 0;
  }

  impulse(x, z, radius, strength) {
    const { nx, nz, dx, dz, width, depth, h } = this;
    radius = Math.max(radius, 3 * Math.max(dx, dz));
    const cx = (x + width / 2) / dx, cz = (z + depth / 2) / dz;
    const i0 = Math.round(cx), j0 = Math.round(cz);
    if (i0 < 0 || i0 >= nx || j0 < 0 || j0 >= nz || !strength) return;
    const first = j0 * nx + i0;
    if (this.solid[first]) return;
    this.stamp = (this.stamp + 1) >>> 0;
    if (!this.stamp) { this.visited.fill(0); this.stamp = 1; }
    let head = 0, tail = 1;
    this.queue[0] = first; this.visited[first] = this.stamp;
    while (head < tail) {
      const p = this.queue[head++], i = p % nx, j = Math.floor(p / nx);
      const r = Math.hypot((i - cx) * dx, (j - cz) * dz) / radius;
      if (r >= 1) continue;
      h[p] = clamp(h[p] + strength * (0.5 + 0.5 * Math.cos(r * Math.PI)), -0.012, 0.012);
      for (let q = 0; q < 4; q++) {
        const next = this.neighbors[p * 4 + q];
        if (this.visited[next] === this.stamp) continue;
        this.visited[next] = this.stamp; this.queue[tail++] = next;
      }
    }
  }

  setObstacles(mask) {
    if (mask.length !== this.solid.length) throw new RangeError('Water obstacle mask has the wrong size');
    this.solid.set(mask);
    const { nx, nz, solid, neighbors } = this;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const p = j * nx + i;
      if (solid[p]) this.h[p] = this.v[p] = this.next[p] = 0;
      const adjacent = [j * nx + Math.max(0, i - 1), j * nx + Math.min(nx - 1, i + 1), Math.max(0, j - 1) * nx + i, Math.min(nz - 1, j + 1) * nx + i];
      for (let k = 0; k < 4; k++) neighbors[p * 4 + k] = solid[adjacent[k]] ? p : adjacent[k];
    }
  }

  advance(dt, knobs, ambient = true) {
    this.accumulator = Math.min(this.accumulator + Math.max(0, dt), 8 / 120);
    let steps = 0;
    while (this.accumulator + 1e-9 >= 1 / 120) {
      this.time += 1 / 120;
      if (ambient) this.impulse(knobs.sourceX, knobs.sourceZ, 0.065, Math.sin(this.time * 12) * knobs.rippleStrength / 12);
      this.step(1 / 120);
      this.accumulator -= 1 / 120;
      steps++;
    }
    return steps;
  }

  step(dt) {
    const { nx, nz, h, v, next, dx, dz, neighbors, solid } = this;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const p = j * nx + i;
      if (solid[p]) continue;
      // A solid neighbor mirrors this cell's height: zero normal flow, so the wave reflects.
      const lap = (h[neighbors[p * 4]] + h[neighbors[p * 4 + 1]] - 2 * h[p]) / (dx * dx)
        + (h[neighbors[p * 4 + 2]] + h[neighbors[p * 4 + 3]] - 2 * h[p]) / (dz * dz);
      v[p] = (v[p] + lap * 0.075 * dt) * Math.exp(-dt * 0.85);
      next[p] = clamp(h[p] + v[p] * dt, -0.012, 0.012);
    }
    h.set(next);
  }

  slopes(i, j, out) {
    const { h, nx, dx, dz, neighbors } = this, p = (j * nx + i) * 4;
    out[0] = (h[neighbors[p + 1]] - h[neighbors[p]]) / (2 * dx);
    out[1] = (h[neighbors[p + 3]] - h[neighbors[p + 2]]) / (2 * dz);
    return out;
  }
}

export class Flow {
  constructor(width = 2, height = 1, depth = 0.7) {
    this.size = [width, height, depth];
    this.n = [24, 12, 10];
    this.data = new Float32Array(24 * 12 * 10 * 3);
    this.sampled = [0, 0, 0];
  }

  decay(dt) {
    const k = Math.exp(-dt * 2.4);
    for (let i = 0; i < this.data.length; i++) this.data[i] *= k;
  }

  stir(x, y, z, vx, vy, vz, radius, gain) {
    const [nx, ny, nz] = this.n, [w, h, d] = this.size, data = this.data;
    const cx = (x / w + 0.5) * (nx - 1), cy = y / h * (ny - 1), cz = (z / d + 0.5) * (nz - 1);
    const rx = radius / w * (nx - 1), ry = radius / h * (ny - 1), rz = radius / d * (nz - 1);
    for (let k = Math.max(0, Math.floor(cz - rz)); k <= Math.min(nz - 1, Math.ceil(cz + rz)); k++) {
      for (let j = Math.max(0, Math.floor(cy - ry)); j <= Math.min(ny - 1, Math.ceil(cy + ry)); j++) {
        for (let i = Math.max(0, Math.floor(cx - rx)); i <= Math.min(nx - 1, Math.ceil(cx + rx)); i++) {
          const r = ((i - cx) / rx) ** 2 + ((j - cy) / ry) ** 2 + ((k - cz) / rz) ** 2;
          if (r >= 1) continue;
          const a = (1 - r) ** 2 * gain, p = ((k * ny + j) * nx + i) * 3;
          data[p] = clamp(data[p] + vx * a, -0.4, 0.4);
          data[p + 1] = clamp(data[p + 1] + vy * a, -0.4, 0.4);
          data[p + 2] = clamp(data[p + 2] + vz * a, -0.4, 0.4);
        }
      }
    }
  }

  sample(x, y, z, out = this.sampled) {
    const [nx, ny, nz] = this.n, [w, h, d] = this.size;
    const a = clamp((x / w + 0.5) * (nx - 1), 0, nx - 1);
    const b = clamp(y / h * (ny - 1), 0, ny - 1);
    const c = clamp((z / d + 0.5) * (nz - 1), 0, nz - 1);
    const i = Math.min(nx - 2, Math.floor(a)), j = Math.min(ny - 2, Math.floor(b)), k = Math.min(nz - 2, Math.floor(c));
    out[0] = out[1] = out[2] = 0;
    for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const weight = (dx ? a - i : 1 - a + i) * (dy ? b - j : 1 - b + j) * (dz ? c - k : 1 - c + k);
      const p = (((k + dz) * ny + j + dy) * nx + i + dx) * 3;
      for (let q = 0; q < 3; q++) out[q] += this.data[p + q] * weight;
    }
    return out;
  }
}

export function contactImpulse(previousY, y, level, radius, distance, strength) {
  const near = Math.min(Math.abs(previousY - level), Math.abs(y - level));
  const crosses = (previousY - level) * (y - level) < 0;
  if ((!crosses && near > radius) || distance > 0.15 || distance < 1e-6) return 0;
  return Math.min(strength, distance * 0.12) * (crosses ? 1 : Math.max(0, 1 - near / radius));
}

export function segmentImpulse(previous, current, a, b, level, radius, strength, out) {
  a *= 3; b *= 3;
  const ay = current[a + 1], by = current[b + 1], py = previous[a + 1], qy = previous[b + 1];
  if (Math.max(ay, by, py, qy) < level - radius || Math.min(ay, by, py, qy) > level + radius) return 0;
  const t = Math.abs(by - ay) > 1e-8 ? clamp((level - ay) / (by - ay), 0, 1) : 0.5;
  const x = current[a] + (current[b] - current[a]) * t, y = ay + (by - ay) * t, z = current[a + 2] + (current[b + 2] - current[a + 2]) * t;
  const px = previous[a] + (previous[b] - previous[a]) * t, oldY = py + (qy - py) * t, pz = previous[a + 2] + (previous[b + 2] - previous[a + 2]) * t;
  const dx = x - px, dy = y - oldY, dz = z - pz;
  const amount = contactImpulse(oldY, y, level, radius, Math.hypot(dx, dy, dz), strength);
  if (!amount) return 0;
  const cross = Math.abs(dy) > 1e-8 ? clamp((level - oldY) / dy, 0, 1) : 1;
  out[0] = px + dx * cross; out[1] = pz + dz * cross;
  return amount * Math.sign(dy || dx || dz);
}
