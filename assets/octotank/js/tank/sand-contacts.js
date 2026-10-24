import { readPose, verticalSpan } from './toy-ripples.js';
import { shareLoad } from './sand-core.js';

export class SandContacts {
  constructor(phys, field) {
    Object.assign(this, { phys, field });
    this.bodies = new WeakMap(); this.providers = new Map(); this.interval = new Float64Array(2);
    this.turn = new Float64Array(9);
    this.count = 0; this.grow(64);
  }

  grow(n) {
    const old = this.cells;
    this.cells = new Float64Array(n * 4); if (old) this.cells.set(old);
    // Only touching cells are kept, each standing for an equal patch of bed.
    this.touching = new Uint8Array(n).fill(1); this.weights = new Float64Array(n).fill(1); this.share = new Float64Array(n);
  }

  register(key, read) {
    const provider = { read, points: [], index: 0 };
    this.providers.set(key, provider);
    return () => { if (this.providers.get(key) === provider) this.providers.delete(key); };
  }

  point(provider, x, y, z, radius, force, dt) {
    const i = provider.index++;
    const old = provider.points[i];
    const distance = old ? Math.hypot(x - old[0], y - old[1], z - old[2]) : 0;
    let speed = 0;
    if (!old) provider.points[i] = [x, y, z, 0, 0, 0];
    else {
      const blend = 1 - Math.exp(-dt / 0.08), valid = distance < 0.15 && Number.isFinite(distance);
      for (let a = 0; a < 3; a++) {
        const value = a === 0 ? x : a === 1 ? y : z;
        old[a + 3] = valid ? old[a + 3] + ((value - old[a]) / dt - old[a + 3]) * blend : 0; old[a] = value;
      }
      speed = distance > 1e-6 ? Math.min(distance / dt, Math.hypot(old[3], old[4], old[5])) : 0;
    }
    this.field.contact(x, y - radius, z, radius, speed, force, dt);
    if (speed > 0.004 && y - radius <= this.field.sample(x, z) + 0.012) this.count++;
  }

  update(dt) {
    const f = this.field, M = this.turn;
    f.beginContacts(); this.count = 0;
    for (const e of this.phys.rigid) {
      if (e.motion === 'static' || e.tag === 'arm' || !['box', 'sphere', 'capsule', 'cylinder'].includes(e.kind)) continue;
      let state = this.bodies.get(e);
      if (!state) { state = { pose: new Float64Array(12), last: new Float64Array(12), vy: 0, strike: 0, age: 0, ready: false }; this.bodies.set(e, state); }
      const pose = readPose(e.body, state.pose), last = state.last;
      // Motion is the pose's change since the last sand tick, not Jolt's velocity: the arms' impulses land on that before
      // the solve, so a toy an arm only leans on would read as plowing. A jump past 15 cm is a teleport.
      const px = pose[0] - last[0], py = pose[1] - last[1], pz = pose[2] - last[2], tracked = state.ready && Math.hypot(px, py, pz) < 0.15;
      const vy = tracked ? py / dt : 0, lost = tracked && state.vy < -0.05 ? Math.max(0, vy - state.vy) : 0;
      // M = R_last · R_nowᵀ takes a body point's offset now to where it sat last tick.
      if (tracked) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] = last[3 + r * 3] * pose[3 + c * 3] + last[4 + r * 3] * pose[4 + c * 3] + last[5 + r * 3] * pose[5 + c * 3];
      state.vy = vy; state.ready = true; last.set(pose);
      const radius = e.kind === 'sphere' ? e.size[0] : e.kind === 'box' ? Math.hypot(...e.size) : e.size[0] + e.size[1];
      // A landing that bounces leaves the bed between two sand ticks, so the speed it lost near the bed waits for its next touch.
      if (lost > 0 && pose[1] - radius < f.sample(pose[0], pose[2]) + 0.02) { state.strike += lost; state.age = 0; } else if (!tracked || ++state.age > 3) state.strike = 0;
      if (pose[1] - radius > f.knobs.depth + f.knobs.unevenness + f.knobs.limit + 0.012) continue;
      const loX = Math.max(0, Math.ceil((pose[0] - radius + f.width / 2) / f.dx)), hiX = Math.min(f.nx - 1, Math.floor((pose[0] + radius + f.width / 2) / f.dx));
      const loZ = Math.max(0, Math.ceil((pose[2] - radius + f.depth / 2) / f.dz)), hiZ = Math.min(f.nz - 1, Math.floor((pose[2] + radius + f.depth / 2) / f.dz));
      let k = 0;
      for (let j = loZ; j <= hiZ; j += 2) for (let i = loX; i <= hiX; i += 2) {
        const x = i * f.dx - f.width / 2, z = j * f.dz - f.depth / 2;
        if (!verticalSpan(e.kind, e.size, pose, x, z, this.interval) || !f.touches(x, this.interval[0], z)) continue;
        if (k === this.share.length) this.grow(k * 2);
        const bottom = this.interval[0], c = this.cells;
        let speed = 0;
        if (tracked) {
          // The body's own rise or fall is left out: the collider holds the bed rigid, so it only settles into a cut
          // already made or lifts away. Landings dig through the strike instead; sliding, and a roll's slip, still plow.
          const rx = x - pose[0], ry = bottom - pose[1], rz = z - pose[2];
          speed = Math.hypot(px + rx - M[0] * rx - M[1] * ry - M[2] * rz, ry - M[3] * rx - M[4] * ry - M[5] * rz, pz + rz - M[6] * rx - M[7] * ry - M[8] * rz) / dt;
        }
        c[k * 4] = x; c[k * 4 + 1] = bottom; c[k * 4 + 2] = z; c[k * 4 + 3] = speed; k++;
      }
      if (!k) continue;
      const strike = state.strike; state.strike = 0;
      const force = e.sandForce ?? (Number.isFinite(e.mass) ? Math.max(0.01, e.water?.weightInWater ?? e.mass * 9.81) + e.mass * strike / dt : 0.1);
      // The whole load, a landing's included, is split over the cells it rests on rather than pressed through each.
      shareLoad(force, this.weights, this.touching, this.share, k);
      const kick = Math.min(1, strike), reach = Math.max(f.dx, f.dz) * 1.6, c = this.cells;
      for (let m = 0; m < k; m++) {
        f.contact(c[m * 4], c[m * 4 + 1], c[m * 4 + 2], reach, Math.max(c[m * 4 + 3], kick), this.share[m], dt);
        if (c[m * 4 + 3] > 0.004) this.count++;
      }
    }
    for (const provider of this.providers.values()) {
      provider.index = 0;
      provider.read((x, y, z, radius, force = 0.05) => this.point(provider, x, y, z, radius, force, dt));
      provider.points.length = provider.index;
    }
  }
}
