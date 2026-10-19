import { segmentImpulse } from './water-core.js';

export class Breaches {
  constructor(mantle, arms, waves) {
    Object.assign(this, { mantle, arms, waves });
    this.skin = new Float32Array(mantle.positions.length);
    this.oldSkin = new Float32Array(mantle.positions.length);
    this.oldArms = arms.arms.map((a) => new Float32Array(a.X.length));
    this.point = [0, 0];
    this.ready = false; this.contacts = 0; this.total = 0;
  }

  update(level, strength, emit) {
    const m = this.mantle;
    for (let i = 0; i < this.skin.length; i += 3) {
      for (let j = 0; j < 3; j++) this.skin[i + j] = m.positions[i + j] + m.origin[j];
    }
    this.contacts = 0;
    const stamp = (previous, current, a, b, radius, gain) => {
      if (!emit || !this.ready) return;
      const impulse = segmentImpulse(previous, current, a, b, level, radius, strength, this.point) * gain;
      if (!impulse) return;
      this.waves.impulse(this.point[0], this.point[1], Math.max(0.045, radius * 2), impulse);
      this.contacts++;
    };
    for (const [a, b] of m.edges) stamp(this.oldSkin, this.skin, a, b, 0.003, 0.05);
    for (let j = 0; j < this.arms.arms.length; j++) {
      const arm = this.arms.arms[j];
      for (let i = 0; i < arm.n - 1; i++) stamp(this.oldArms[j], arm.X, i, i + 1, Math.max(0.004, arm.rad[i]), 0.5);
      this.oldArms[j].set(arm.X);
    }
    this.oldSkin.set(this.skin);
    this.ready = true; this.total += this.contacts;
  }
}
