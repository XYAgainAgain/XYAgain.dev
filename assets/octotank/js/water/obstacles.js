import { LAYERS } from '../config.js';

export class WaterObstacles {
  constructor(phys, waves) {
    this.phys = phys; this.waves = waves;
    const J = phys.Jolt;
    this.shape = new J.SphereShape(Math.min(waves.dx, waves.dz) * 0.35, null);
    this.shape.AddRef();
    this.query = phys.system.GetNarrowPhaseQuery();
    const axis = new J.Vec3(1, 0, 0), mat = new J.RMat44(), w = new J.Vec4(0, 0, 0, 1);
    mat.SetAxisX(axis); axis.Set(0, 1, 0); mat.SetAxisY(axis); axis.Set(0, 0, 1); mat.SetAxisZ(axis); mat.SetColumn4(3, w);
    J.destroy(axis); J.destroy(w);
    const bpl = new J.BroadPhaseLayer(0);
    this.owned = {
      mat, bpl, scale: new J.Vec3(1, 1, 1), point: new J.RVec3(), base: new J.RVec3(),
      settings: new J.CollideShapeSettings(), collector: new J.CollideShapeAnyHitCollisionCollector(),
      bp: new J.SpecifiedBroadPhaseLayerFilter(bpl), obj: new J.SpecifiedObjectLayerFilter(LAYERS.NON_MOVING),
      body: new J.BodyFilter(), filter: new J.ShapeFilter(),
    };
    this.mask = new Uint8Array(waves.h.length);
    this.bakes = 0; this.bakeMs = 0;
  }

  invalidate() { this.dirty = true; }

  update(level) {
    let changed = this.dirty || this.level !== level;
    const statics = this.phys.rigid.filter((e) => e.motion === 'static');
    if (!this.statics || statics.length !== this.statics.length || statics.some((e, i) => e !== this.statics[i])) {
      this.statics = statics;
      this.pose = new Float64Array(this.statics.length * 7).fill(NaN);
      changed = true;
    }
    for (let i = 0; i < this.statics.length; i++) {
      const body = this.statics[i].body, p = body.GetPosition();
      const x = p.GetX(), y = p.GetY(), z = p.GetZ(), q = body.GetRotation();
      const values = [x, y, z, q.GetX(), q.GetY(), q.GetZ(), q.GetW()];
      for (let k = 0; k < 7; k++) {
        if (this.pose[i * 7 + k] !== values[k]) changed = true;
        this.pose[i * 7 + k] = values[k];
      }
    }
    if (!changed) return false;
    const start = performance.now(), w = this.waves, q = this.owned;
    for (let j = 0; j < w.nz; j++) for (let i = 0; i < w.nx; i++) {
      q.point.Set(i * w.dx - w.width / 2, level, j * w.dz - w.depth / 2);
      q.mat.SetTranslation(q.point); q.collector.Reset();
      this.query.CollideShape(this.shape, q.scale, q.mat, q.settings, q.base, q.collector, q.bp, q.obj, q.body, q.filter);
      this.mask[j * w.nx + i] = q.collector.HadHit() ? 1 : 0;
    }
    w.setObstacles(this.mask);
    this.level = level; this.dirty = false; this.bakes++; this.bakeMs = performance.now() - start;
    return true;
  }

  dispose() {
    this.shape.Release();
    for (const value of Object.values(this.owned)) this.phys.Jolt.destroy(value);
  }
}
