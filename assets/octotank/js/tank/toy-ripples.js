const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const SUBCELLS = [-0.25, 0.25];

function sphere(ox, oy, oz, dx, dy, dz, radius, interval) {
  const b = ox * dx + oy * dy + oz * dz;
  const d = b * b - ox * ox - oy * oy - oz * oz + radius * radius;
  if (d < 0) return false;
  const root = Math.sqrt(d);
  interval[0] = -b - root; interval[1] = -b + root;
  return true;
}

function slab(origin, direction, half, interval) {
  if (Math.abs(direction) < 1e-10) return Math.abs(origin) <= half;
  const a = (-half - origin) / direction, b = (half - origin) / direction;
  interval[0] = Math.max(interval[0], Math.min(a, b));
  interval[1] = Math.min(interval[1], Math.max(a, b));
  return interval[1] > interval[0];
}

export function readPose(body, out) {
  const p = body.GetPosition();
  out[0] = p.GetX(); out[1] = p.GetY(); out[2] = p.GetZ();
  const q = body.GetRotation(), x = q.GetX(), y = q.GetY(), z = q.GetZ(), w = q.GetW();
  out[3] = 1 - 2 * (y * y + z * z); out[4] = 2 * (x * y - z * w); out[5] = 2 * (x * z + y * w);
  out[6] = 2 * (x * y + z * w); out[7] = 1 - 2 * (x * x + z * z); out[8] = 2 * (y * z - x * w);
  out[9] = 2 * (x * z - y * w); out[10] = 2 * (y * z + x * w); out[11] = 1 - 2 * (x * x + y * y);
  return out;
}

export function verticalSpan(kind, size, pose, x, z, interval) {
  const wx = x - pose[0], wz = z - pose[2];
  const ox = pose[3] * wx + pose[9] * wz, oy = pose[4] * wx + pose[10] * wz, oz = pose[5] * wx + pose[11] * wz;
  const dx = pose[6], dy = pose[7], dz = pose[8];
  let lo, hi;
  if (kind === 'sphere') {
    if (!sphere(ox, oy, oz, dx, dy, dz, size[0], interval)) return 0;
    [lo, hi] = interval;
  } else if (kind === 'box') {
    interval[0] = -Infinity; interval[1] = Infinity;
    if (!slab(ox, dx, size[0], interval) || !slab(oy, dy, size[1], interval) || !slab(oz, dz, size[2], interval)) return 0;
    [lo, hi] = interval;
  } else if (kind === 'capsule' || kind === 'cylinder') {
    const half = size[0], radius = size[1], a = dx * dx + dz * dz;
    const b = ox * dx + oz * dz, c = ox * ox + oz * oz - radius * radius;
    interval[0] = -Infinity; interval[1] = Infinity;
    let hit = false;
    if (a < 1e-10) hit = c <= 0;
    else {
      const d = b * b - a * c;
      if (d >= 0) {
        const root = Math.sqrt(d);
        interval[0] = (-b - root) / a; interval[1] = (-b + root) / a; hit = true;
      }
    }
    hit = hit && slab(oy, dy, half, interval);
    lo = hit ? interval[0] : Infinity; hi = hit ? interval[1] : -Infinity;
    if (kind === 'capsule') {
      for (let cap = 0; cap < 2; cap++) {
        const end = cap ? half : -half;
        if (sphere(ox, oy - end, oz, dx, dy, dz, radius, interval)) {
          lo = Math.min(lo, interval[0]); hi = Math.max(hi, interval[1]);
        }
      }
    }
  } else return 0;
  interval[0] = lo + pose[1]; interval[1] = hi + pose[1];
  return hi > lo;
}

export function submergedColumn(kind, size, pose, x, z, level, band, interval) {
  if (!verticalSpan(kind, size, pose, x, z, interval)) return 0;
  const lo = interval[0], hi = interval[1], water = level;
  const proximity = clamp(1 + (hi - water) / band, 0, 1);
  return Math.max(0, Math.min(hi, water) - lo) * proximity * proximity * (3 - 2 * proximity);
}

export class Displacements {
  constructor(toys, waves) {
    Object.assign(this, { toys, waves });
    this.states = new WeakMap(); this.interval = new Float64Array(2);
    this.level = null; this.contacts = 0; this.total = 0; this.cells = 0;
  }

  update(level, strength, emit) {
    const w = this.waves, cell = Math.max(w.dx, w.dz), band = cell * 2;
    this.contacts = 0; this.cells = 0;
    for (const toy of this.toys) {
      if (toy.motion === 'static') continue;
      let state = this.states.get(toy);
      if (!state) {
        state = { old: new Float64Array(12), pose: new Float64Array(12), ready: false };
        this.states.set(toy, state);
      }
      const old = state.old, pose = readPose(toy.body, state.pose);
      const distance = Math.hypot(pose[0] - old[0], pose[1] - old[1], pose[2] - old[2]);
      const moved = pose.some((v, i) => (i < 3 || toy.kind !== 'sphere') && Math.abs(v - old[i]) > 1e-9);
      if (emit && strength > 0 && state.ready && level === this.level && moved && distance < 0.15) {
        const radius = toy.kind === 'sphere' ? toy.size[0] : toy.kind === 'box' ? Math.hypot(...toy.size)
          : toy.kind === 'capsule' ? toy.size[0] + toy.size[1] : Math.hypot(...toy.size);
        const high = Math.max(old[1], pose[1]) + radius, low = Math.min(old[1], pose[1]) - radius;
        const dy = pose[1] - old[1];
        // A fast crossing can traverse the entire shallow band between two frames.
        if ((old[1] - level) * (pose[1] - level) < 0 && Math.abs(old[1] - level) > radius && Math.abs(pose[1] - level) > radius) {
          const t = (level - old[1]) / dy;
          w.impulse(old[0] + (pose[0] - old[0]) * t, old[2] + (pose[2] - old[2]) * t,
            radius, Math.sign(dy) * Math.min(strength, Math.abs(dy) * 0.06));
          this.contacts++;
        }
        if (high >= level - band && low <= level) {
          const minI = clamp(Math.floor((Math.min(old[0], pose[0]) - radius + w.width / 2) / w.dx), 0, w.nx - 1);
          const maxI = clamp(Math.ceil((Math.max(old[0], pose[0]) + radius + w.width / 2) / w.dx), 0, w.nx - 1);
          const minJ = clamp(Math.floor((Math.min(old[2], pose[2]) - radius + w.depth / 2) / w.dz), 0, w.nz - 1);
          const maxJ = clamp(Math.ceil((Math.max(old[2], pose[2]) + radius + w.depth / 2) / w.dz), 0, w.nz - 1);
          let active = false;
          for (let j = minJ; j <= maxJ; j++) for (let i = minI; i <= maxI; i++) {
            const p = j * w.nx + i;
            if (w.solid[p]) continue;
            let delta = 0;
            // Subcell coverage keeps small toys from hopping between grid points.
            for (const sx of SUBCELLS) for (const sz of SUBCELLS) {
              const x = (i + sx) * w.dx - w.width / 2, z = (j + sz) * w.dz - w.depth / 2;
              delta += submergedColumn(toy.kind, toy.size, old, x, z, level, band, this.interval)
                - submergedColumn(toy.kind, toy.size, pose, x, z, level, band, this.interval);
            }
            delta *= strength * 25;
            this.cells++;
            if (!delta) continue;
            active = true;
            // Smooth through open neighbors only, so a wake cannot bleed through a divider.
            w.h[p] = clamp(w.h[p] + delta * 0.5, -0.012, 0.012);
            for (let q = 0; q < 4; q++) {
              const n = w.neighbors[p * 4 + q];
              w.h[n] = clamp(w.h[n] + delta * 0.125, -0.012, 0.012);
            }
          }
          if (active) this.contacts++;
        }
      }
      old.set(pose); state.ready = true;
    }
    this.level = level; this.total += this.contacts;
  }
}
