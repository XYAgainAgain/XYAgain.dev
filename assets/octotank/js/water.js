import { GRAVITY } from './config.js';
import { WATER_KNOBS, joltLinearDrag, joltAngularDrag, joltRollingDrag, worldHalfHeight, submergedShare, wetOffset, toLocal } from './water-core.js';

/* Seawater on the toys, once per fixed tick before Jolt steps: buoyancy and drag through Jolt's own
   ApplyBuoyancyImpulse, with coefficients from water-core.js. `enabled` false leaves the toys in plain air. */

const WINDOW = 1800;

export class Water {
  constructor(phys, toys, { enabled = true, knobs = {} } = {}) {
    const J = phys.Jolt, k = this.knobs = { ...WATER_KNOBS, ...knobs };
    this.phys = phys;
    this.enabled = enabled;
    this.toys = toys.filter((t) => t.water && t.motion === 'dynamic');
    this.tmp = { surf: new J.RVec3(0, k.surfaceY, 0), up: new J.Vec3(0, 1, 0), flow: new J.Vec3(0, 0, 0), g: new J.Vec3(0, GRAVITY, 0) };
    this.u = [0, 0, 0];
    this.w = [0, 0, 0];
    this.ms = new Float32Array(WINDOW);
    this.count = 0;
    this.onTint = null;
  }

  tick(dt) {
    if (!this.enabled) return;
    const t0 = performance.now(), k = this.knobs, B = this.phys.bodies, u = this.u, w = this.w, T = this.tmp;
    T.surf.Set(0, k.surfaceY, 0);
    for (const toy of this.toys) {
      if (!B.IsActive(toy.id)) continue;
      // Jolt hands back views of one shared buffer, so each read is copied out before the next call.
      const v = B.GetLinearVelocity(toy.id), vx = v.GetX(), vy = v.GetY(), vz = v.GetZ();
      const a = B.GetAngularVelocity(toy.id), ax = a.GetX(), ay = a.GetY(), az = a.GetZ();
      const q = toy.body.GetRotation(), qx = q.GetX(), qy = q.GetY(), qz = q.GetZ(), qw = q.GetW();
      const p = toy.body.GetPosition(), py = p.GetY();
      const W = toy.water, half = worldHalfHeight(toy.kind, toy.size, qx, qy, qz, qw);
      // Jolt reads the flow at its center of buoyancy, below the center of mass on a floater: v + ω × r there.
      const ry = wetOffset(py, k.surfaceY, half), fx = vx - az * ry, fz = vz + ax * ry, speed = Math.hypot(fx, vy, fz);
      let lin = 0, ang = 0;
      if (speed > 1e-6) {
        toLocal(qx, qy, qz, qw, -fx / speed, -vy / speed, -fz / speed, u);
        // Jolt sizes drag by its whole bounding box; a floater half out of the water only drags with its wet half.
        lin = joltLinearDrag(toy.kind, toy.size, W.volume, u[0], u[1], u[2], speed) * k.linearDrag * submergedShare(py, k.surfaceY, half);
      }
      if (ax || ay || az) {
        toLocal(qx, qy, qz, qw, ax, ay, az, w);
        ang = joltAngularDrag(toy.kind, toy.size, W.volume, W.mass, w[0], w[1], w[2]) * k.angularDrag;
        // Resting on the floor (Jolt lets a toy sink a few millimeters into it), a roll also loses to the floor itself.
        if (py - half - k.floorY < 0.004) ang += joltRollingDrag(toy.kind, toy.size, W.mass, Math.hypot(ax, ay, az), W.weightInWater, half, k.rolling);
      }
      B.ApplyBuoyancyImpulse(toy.id, T.surf, T.up, W.buoyancy, Number.isFinite(lin) ? lin : 0, Number.isFinite(ang) ? ang : 0, T.flow, T.g, dt);
    }
    this.ms[this.count++ % WINDOW] = performance.now() - t0;
  }

  setTint(on) {
    this.knobs.tint = !!on;
    this.onTint?.(this.knobs.tint);
  }

  stats() {
    const n = Math.min(this.count, WINDOW);
    if (!n) return { n: 0, mean: 0, p95: 0, max: 0 };
    const s = Array.from(this.ms.subarray(0, n)).sort((x, y) => x - y);
    return { n, mean: s.reduce((x, y) => x + y, 0) / n, p95: s[Math.min(n - 1, Math.floor(n * 0.95))], max: s[n - 1] };
  }

  resetStats() { this.count = 0; }

  /* Each toy's material and what the water makes of it. */
  report() {
    return this.toys.map((t, i) => ({
      i, kind: t.kind, material: t.water.material, rho: t.water.rho, mass: +t.water.mass.toFixed(4), volume: +t.water.volume.toExponential(3),
      weightAir: +(t.water.mass * -GRAVITY).toFixed(4), weightWater: +t.water.weightInWater.toFixed(4), buoyancy: +t.water.buoyancy.toFixed(4),
    }));
  }

  destroy() {
    for (const o of Object.values(this.tmp)) this.phys.Jolt.destroy(o);
    this.tmp = {};
    this.toys = [];
  }
}
