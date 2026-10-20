import { readPose, verticalSpan } from './toy-ripples.js';

export class SandContacts {
  constructor(phys, field) {
    Object.assign(this, { phys, field });
    this.bodies = new WeakMap(); this.providers = new Map(); this.interval = new Float64Array(2);
    this.count = 0;
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
    const f = this.field;
    f.beginContacts(); this.count = 0;
    for (const e of this.phys.rigid) {
      if (e.motion === 'static' || e.tag === 'arm' || !['box', 'sphere', 'capsule', 'cylinder'].includes(e.kind)) continue;
      let state = this.bodies.get(e);
      if (!state) { state = { pose: new Float64Array(12), vy: 0, ready: false }; this.bodies.set(e, state); }
      const pose = readPose(e.body, state.pose);
      const velocity = e.body.GetLinearVelocity(), vx = velocity.GetX(), vy = velocity.GetY(), vz = velocity.GetZ();
      const angular = e.body.GetAngularVelocity(), ax = angular.GetX(), ay = angular.GetY(), az = angular.GetZ();
      const impact = state.ready && state.vy < -0.05 ? Math.max(0, vy - state.vy) / dt : 0;
      state.vy = vy; state.ready = true;
      const radius = e.kind === 'sphere' ? e.size[0] : e.kind === 'box' ? Math.hypot(...e.size) : e.size[0] + e.size[1];
      if (pose[1] - radius > f.knobs.depth + f.knobs.unevenness + f.knobs.limit + 0.012) continue;
      const loX = Math.max(0, Math.ceil((pose[0] - radius + f.width / 2) / f.dx)), hiX = Math.min(f.nx - 1, Math.floor((pose[0] + radius + f.width / 2) / f.dx));
      const loZ = Math.max(0, Math.ceil((pose[2] - radius + f.depth / 2) / f.dz)), hiZ = Math.min(f.nz - 1, Math.floor((pose[2] + radius + f.depth / 2) / f.dz));
      const force = e.sandForce ?? (Number.isFinite(e.mass) ? Math.max(0.01, e.water?.weightInWater ?? e.mass * 9.81) + e.mass * impact : 0.1);
      for (let j = loZ; j <= hiZ; j += 2) for (let i = loX; i <= hiX; i += 2) {
        const x = i * f.dx - f.width / 2, z = j * f.dz - f.depth / 2;
        if (!verticalSpan(e.kind, e.size, pose, x, z, this.interval)) continue;
        const bottom = this.interval[0];
        if (bottom > f.sample(x, z) + 0.012) continue;
        const dx = x - pose[0], dy = bottom - pose[1], dz = z - pose[2];
        const speed = Math.hypot(vx + ay * dz - az * dy, vy + az * dx - ax * dz, vz + ax * dy - ay * dx);
        f.contact(x, bottom, z, Math.max(f.dx, f.dz) * 1.6, Math.max(speed, Math.min(1, impact * dt)), force, dt);
        if (speed > 0.004) this.count++;
      }
    }
    for (const provider of this.providers.values()) {
      provider.index = 0;
      provider.read((x, y, z, radius, force = 0.05) => this.point(provider, x, y, z, radius, force, dt));
      provider.points.length = provider.index;
    }
  }
}
