import { TANK } from '../config.js';
import { section } from '../diag/panel.js';
import { VISUAL_KNOBS, Waves, Flow } from './water-core.js';
import { Surface } from './surface.js';
import { Particles } from './particles.js';
import { WaterObstacles } from './obstacles.js';
import { Breaches } from './breaches.js';
import { Circulation } from './currents.js';
import { Displacements } from '../tank/toy-ripples.js';

export class WaterVisuals {
  constructor({ renderer, scene, camera, ctx, jet, seed, enabled = true }) {
    Object.assign(this, { renderer, scene, camera, ctx, jet });
    this.knobs = { ...VISUAL_KNOBS, sourceX: -TANK.w / 2 + 0.08, sourceZ: -TANK.d / 2 + 0.06 };
    for (const key of ['reflectionHz', 'refractionHz']) Object.defineProperty(this.knobs, key, {
      enumerable: true, get: () => this.knobs.opticsHz, set: (value) => { this.knobs.opticsHz = value; },
    });
    this.enabled = enabled;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.waves = new Waves(TANK.w, TANK.d, 128, Math.round(128 * TANK.d / TANK.w));
    this.obstacles = new WaterObstacles(ctx.phys, this.waves);
    this.obstacles.update(ctx.water.knobs.surfaceY);
    this.currents = new Circulation(this.waves, this.knobs, seed);
    this.currents.update(this.obstacles.bakes);
    this.breaches = new Breaches(ctx.mantle, ctx.arms, this.waves);
    this.displacements = new Displacements(ctx.toys, this.waves);
    // The overflow is already running when the page opens.
    if (enabled && !this.reduced.matches) for (let i = 0; i < 960; i++) this.waves.advance(1 / 120, this.knobs);
    this.flow = new Flow(TANK.w, TANK.h, TANK.d);
    this.surface = new Surface(renderer, scene, camera, this.waves, ctx.water.knobs.surfaceY, this.knobs);
    this.particles = new Particles(this.surface.group, TANK.w, TANK.d, ctx.water.knobs.surfaceY, seed, this.knobs);
    this.previous = new Float32Array(512 * 3);
    this.samples = new Float32Array(512 * 4);
    this.centroid = [0, 0, 0];
    this.lastTime = null; this.uploadAt = -Infinity;
    this.metrics = { updates: 0, updateMs: 0, reflectionMs: 0, reflections: 0 };
    this.wasReduced = this.reduced.matches;
    this.surface.setVisible(enabled);
    this.action = { key: 'v', name: 'Show/hide water', label: () => 'Show/hide water', run: () => { if (!this.disposed) this.setVisible(!this.enabled); } };
    section('view').add(this.action);
    this.maskAction = { name: 'Rebuild water mask', label: () => 'Rebuild water mask', run: () => this.rebuildMask() };
    section('view').add(this.maskAction);
    this.qualityActions = [
      ['Reflection resolution', 'reflectionResolution', [128, 256, 384, 512, 1024, 2048, 4096], 'px'],
      ['Water optics rate', 'opticsHz', [5, 10, 15, 20, 30, 60, 120], 'Hz'],
    ].map(([name, knob, values, unit]) => ({
      type: 'range', name, values, get: () => this.knobs[knob], label: () => `${name}: ${this.knobs[knob]} ${unit}`,
      set: (value) => { if (!this.disposed) { this.knobs[knob] = value; this.surface.lastReflection = -Infinity; this.surface.refraction.last = -Infinity; } },
    }));
    for (const action of this.qualityActions) section('view').add(action);
  }

  rebuildMask() {
    if (this.disposed) return;
    this.obstacles.invalidate();
    this.obstacles.update(this.ctx.water.knobs.surfaceY);
    this.currents.update(this.obstacles.bakes);
    this.uploadAt = -Infinity;
    return { generation: this.obstacles.bakes, regions: this.currents.regions.length, bakeMs: this.obstacles.bakeMs };
  }

  setVisible(on) {
    if (this.disposed) return;
    this.enabled = !!on;
    this.lastTime = null;
    this.waves.accumulator = 0;
    this.breaches.ready = false;
    this.flow.data.fill(0);
    this.surface.setVisible(this.enabled);
  }

  collect() {
    let n = 0;
    const put = (x, y, z, radius) => {
      if (n >= 512) return;
      const p = n++ * 4;
      this.samples[p] = x; this.samples[p + 1] = y; this.samples[p + 2] = z; this.samples[p + 3] = radius;
    };
    const { mantle, arms, toys } = this.ctx;
    mantle.centroid(this.centroid);
    put(...this.centroid, 0.075);
    for (const arm of arms.arms) {
      for (let i = 0; i < arm.n; i += 3) put(arm.X[i * 3], arm.X[i * 3 + 1], arm.X[i * 3 + 2], Math.max(0.025, arm.rad[i] * 2));
      const p = (arm.n - 1) * 3;
      put(arm.X[p], arm.X[p + 1], arm.X[p + 2], 0.025);
    }
    for (const toy of toys) {
      if (toy.motion !== 'dynamic') continue;
      const p = toy.body.GetPosition();
      put(p.GetX(), p.GetY(), p.GetZ(), Math.max(...toy.size, 0.025));
    }
    return n;
  }

  update(time) {
    if (!this.enabled) return;
    const started = performance.now(), count = this.collect(), k = this.knobs, level = this.ctx.water.knobs.surfaceY;
    let refresh = this.surface.level.value !== level;
    if (this.obstacles.update(level)) refresh = true;
    this.currents.update(this.obstacles.bakes);
    if (this.reduced.matches !== this.wasReduced) {
      this.wasReduced = this.reduced.matches;
      this.flow.data.fill(0);
      if (this.wasReduced) { this.waves.h.fill(0); this.waves.v.fill(0); }
      refresh = true;
    }
    const elapsed = this.lastTime === null ? 0 : time - this.lastTime;
    const valid = elapsed > 0 && elapsed <= 0.1;
    const dt = valid ? elapsed : 0;
    if (elapsed > 0.1 || elapsed < 0) this.flow.data.fill(0);
    this.flow.decay(dt);
    for (let i = 0; i < count; i++) {
      const p = i * 4, old = i * 3, s = this.samples, prev = this.previous;
      if (valid) {
        const dx = s[p] - prev[old], dy = s[p + 1] - prev[old + 1], dz = s[p + 2] - prev[old + 2];
        const distance = Math.hypot(dx, dy, dz);
        if (distance < 0.15 && !this.reduced.matches) {
          this.flow.stir(s[p], s[p + 1], s[p + 2], dx / dt, dy / dt, dz / dt, Math.max(0.11, s[p + 3] * 2), k.currentStrength * dt * 20);
        }
      }
      prev[old] = s[p]; prev[old + 1] = s[p + 1]; prev[old + 2] = s[p + 2];
    }
    this.breaches.update(level, k.contactStrength, valid && !this.reduced.matches);
    this.displacements.update(level, k.contactStrength, valid && !this.reduced.matches);
    if (dt && !this.reduced.matches && this.jet.phase === 'thrust' && this.jet.siphonDir) {
      const d = this.jet.siphonDir, c = this.centroid, mouth = this.jet.parts?.siphon?.mesh.matrix.elements;
      const x = mouth ? mouth[12] : c[0], y = mouth ? mouth[13] : c[1], z = mouth ? mouth[14] : c[2];
      for (let i = 1; i <= 4; i++) this.flow.stir(x + d[0] * i * 0.07, y + d[1] * i * 0.07, z + d[2] * i * 0.07,
        d[0] * 0.35, d[1] * 0.35, d[2] * 0.35, 0.09 + i * 0.015, dt * 8);
    }
    if (!this.reduced.matches) this.waves.advance(dt, k);
    this.surface.update(level);
    if (refresh || time - this.uploadAt >= 1 / 30 || this.uploadAt === -Infinity || time < this.uploadAt) {
      this.surface.upload(); this.uploadAt = time;
    }
    this.particles.update(dt, time, level, this.flow, this.camera, this.reduced.matches, this.currents);
    this.lastTime = time;
    this.metrics.updateMs += performance.now() - started; this.metrics.updates++;
  }

  beforeRender(time) {
    if (!this.enabled) return;
    const started = performance.now(), before = this.surface.lastReflection;
    this.surface.reflect(time);
    this.metrics.reflectionMs += performance.now() - started;
    if (before !== this.surface.lastReflection) this.metrics.reflections++;
  }

  dispose() {
    if (this.disposed) return;
    this.enabled = false; this.disposed = true;
    if (this.action.button) this.action.button.disabled = true;
    if (this.maskAction.button) this.maskAction.button.disabled = true;
    for (const action of this.qualityActions) if (action.button) action.button.disabled = true;
    this.obstacles.dispose();
    this.particles.dispose(); this.surface.dispose();
  }
}
