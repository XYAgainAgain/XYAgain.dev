import { LAYERS, FIXED_DT, MAX_SUBSTEPS, GRAVITY } from './config.js';

/* The Jolt world: layers, the fixed step, body bookkeeping, and the destroy discipline. Everything newed
   from Jolt is destroyed here; the frame loop allocates nothing (the temps below are reused). */

export async function loadJolt({ debug = false } = {}) {
  // The debug build asserts on bad soft-body settings the release build swallows; it lives in .dev, which only a
  // local server has, so anywhere else the flag is ignored.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const mod = debug && local
    ? await import('/.dev/vendor-src/jolt/package/dist/jolt-physics.debug.wasm-compat.js')
    : await import('jolt');
  return mod.default();
}

const STEP_WINDOW = 1800;   // 30 s of step samples at 60 Hz

// Grip proxies sit one layer past config's: kinematic stand-ins for an arm's grip point that collide with nothing.
export const PROXY_LAYER = LAYERS.COUNT;
const LAYER_COUNT = LAYERS.COUNT + 1;

function summarize(buf, n) {
  if (!n) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / n, p50: s[Math.floor(n * 0.5)], p95: s[Math.min(n - 1, Math.floor(n * 0.95))], max: s[n - 1] };
}

export class Physics {
  /* armsHitToys: Jolt's own arm-capsule contact with toys. Kinematic capsules have no mass limit, so the arms
     push toys from their own code with a capped force instead. */
  constructor(Jolt, { armsHitToys = false } = {}) {
    this.Jolt = Jolt;
    const settings = new Jolt.JoltSettings();
    settings.mMaxWorkerThreads = 0;
    const assertFailed = new Jolt.AssertFailedHandlerJS();
    assertFailed.OnAssertFailed = (expression, message, file, line) => {
      console.error(`Jolt assert: (${Jolt.UTF8ToString(expression)}) ${Jolt.UTF8ToString(message)} at ${Jolt.UTF8ToString(file)}:${line}`);
    };
    settings.mAssertFailedHandler = assertFailed;

    const pairs = new Jolt.ObjectLayerPairFilterTable(LAYER_COUNT);
    pairs.EnableCollision(LAYERS.NON_MOVING, LAYERS.TOYS);
    pairs.EnableCollision(LAYERS.TOYS, LAYERS.TOYS);
    pairs.EnableCollision(LAYERS.MANTLE, LAYERS.NON_MOVING);
    pairs.EnableCollision(LAYERS.MANTLE, LAYERS.TOYS);
    pairs.EnableCollision(LAYERS.ARMS, LAYERS.NON_MOVING);
    if (armsHitToys) pairs.EnableCollision(LAYERS.ARMS, LAYERS.TOYS);
    const bpStatic = new Jolt.BroadPhaseLayer(0), bpMoving = new Jolt.BroadPhaseLayer(1);
    const bp = new Jolt.BroadPhaseLayerInterfaceTable(LAYER_COUNT, 2);
    bp.MapObjectToBroadPhaseLayer(LAYERS.NON_MOVING, bpStatic);
    bp.MapObjectToBroadPhaseLayer(LAYERS.TOYS, bpMoving);
    bp.MapObjectToBroadPhaseLayer(LAYERS.MANTLE, bpMoving);
    bp.MapObjectToBroadPhaseLayer(LAYERS.ARMS, bpMoving);
    bp.MapObjectToBroadPhaseLayer(PROXY_LAYER, bpMoving);
    settings.mObjectLayerPairFilter = pairs;
    settings.mBroadPhaseLayerInterface = bp;
    settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bp, 2, pairs, LAYER_COUNT);
    this.armsHitToys = armsHitToys;

    this.jolt = new Jolt.JoltInterface(settings);
    Jolt.destroy(settings);
    Jolt.destroy(bpStatic);
    Jolt.destroy(bpMoving);
    this.system = this.jolt.GetPhysicsSystem();
    this.bodies = this.system.GetBodyInterface();

    this.tmp = { v: new Jolt.Vec3(), v2: new Jolt.Vec3(), r: new Jolt.RVec3(), q: new Jolt.Quat() };
    this.tmp.v.Set(0, GRAVITY, 0);
    this.system.SetGravity(this.tmp.v);

    this.rigid = [];          // { id, body, kind, size, motion, layer }
    this.proxies = [];        // grip stand-ins, outside `rigid` so nothing draws or collides them
    this.constraints = new Set();
    this.acc = 0;
    this.collisionSteps = 1;
    this.stepMs = new Float32Array(STEP_WINDOW);
    this.tickMs = new Float32Array(STEP_WINDOW);   // the JS side of a tick: posture, pins, 184 kinematic moves
    this.stepCount = 0;
    this.stepTotal = 0;
    this.dropped = 0;         // seconds of frame time the step cap discarded
  }

  /* Fixed 60 Hz with a two-step cap; leftover time past that is dropped, never caught up. */
  step(frameDt, preTick) {
    this.acc += Math.min(frameDt, 0.1);
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_SUBSTEPS) {
      const t0 = performance.now();
      preTick?.(FIXED_DT, this.stepTotal);
      const t1 = performance.now();
      this.jolt.Step(FIXED_DT, this.collisionSteps);
      this.stepMs[this.stepCount % STEP_WINDOW] = performance.now() - t1;
      this.tickMs[this.stepCount % STEP_WINDOW] = t1 - t0;
      this.stepCount++;
      this.stepTotal++;
      this.acc -= FIXED_DT;
      n++;
    }
    if (this.acc > FIXED_DT) { this.dropped += this.acc - FIXED_DT; this.acc = FIXED_DT; }
    return n;
  }

  get time() { return this.stepTotal * FIXED_DT; }

  /* Jolt's Step alone; `js` is the same summary for the JS work that feeds each step. */
  stats() {
    const n = Math.min(this.stepCount, STEP_WINDOW);
    return { n, ...summarize(this.stepMs, n), js: summarize(this.tickMs, n), dropped: this.dropped };
  }

  resetStats() { this.stepCount = 0; this.dropped = 0; }

  /* kind: box (size = half extents), sphere (size = [r]), capsule/cylinder (size = [halfHeight, r]). */
  addRigid(kind, size, pos, { rot = null, motion = 'dynamic', layer = LAYERS.TOYS, friction = 0.5, restitution = 0, damping = 0, gravityFactor = 1 } = {}) {
    const J = this.Jolt;
    let shape;
    if (kind === 'box') {
      this.tmp.v.Set(size[0], size[1], size[2]);
      shape = new J.BoxShape(this.tmp.v, Math.min(0.005, 0.3 * Math.min(size[0], size[1], size[2])), null);
    } else if (kind === 'sphere') shape = new J.SphereShape(size[0], null);
    else if (kind === 'capsule') shape = new J.CapsuleShape(size[0], size[1], null);
    else if (kind === 'cylinder') shape = new J.CylinderShape(size[0], size[1], Math.min(0.005, 0.3 * size[1]), null);
    else throw new Error(`addRigid: unknown kind ${kind}`);
    const motionType = motion === 'static' ? J.EMotionType_Static : motion === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Dynamic;
    this.tmp.r.Set(pos[0], pos[1], pos[2]);
    if (rot) this.tmp.q.Set(rot[0], rot[1], rot[2], rot[3]); else this.tmp.q.Set(0, 0, 0, 1);
    const cs = new J.BodyCreationSettings(shape, this.tmp.r, this.tmp.q, motionType, layer);
    cs.mFriction = friction;
    cs.mRestitution = restitution;
    cs.mLinearDamping = damping;
    cs.mAngularDamping = damping;
    cs.mGravityFactor = gravityFactor;
    const body = this.bodies.CreateBody(cs);
    J.destroy(cs);
    const id = body.GetID();
    this.bodies.AddBody(id, J.EActivation_Activate);
    const entry = { id, body, kind, size, motion, layer, pos: [...pos] };
    this.rigid.push(entry);
    return entry;
  }

  moveKinematic(entry, x, y, z, qx, qy, qz, qw, dt) {
    this.tmp.r.Set(x, y, z);
    this.tmp.q.Set(qx, qy, qz, qw);
    this.bodies.MoveKinematic(entry.id, this.tmp.r, this.tmp.q, dt);
  }

  teleport(entry, x, y, z, qx, qy, qz, qw) {
    this.tmp.r.Set(x, y, z);
    this.tmp.q.Set(qx, qy, qz, qw);
    this.bodies.SetPositionAndRotation(entry.id, this.tmp.r, this.tmp.q, this.Jolt.EActivation_Activate);
  }

  /* World rotation of a body as [x, y, z, w]; statics never move, so one read at setup is enough. */
  rotationOf(entry, out = [0, 0, 0, 1]) {
    const q = entry.body.GetRotation();
    out[0] = q.GetX(); out[1] = q.GetY(); out[2] = q.GetZ(); out[3] = q.GetW();
    return out;
  }

  /* A sphere probe against the static world alone (NON_MOVING). Returns the deepest penetration and writes the
     direction that lifts the probe out into `out`; every Jolt object it uses is made once, on first call. */
  collideStaticSphere(x, y, z, r, out) {
    const J = this.Jolt;
    let q = this.query;
    if (!q) {
      const shape = new J.SphereShape(1, null);
      shape.AddRef();
      const mat = new J.RMat44();
      const v = new J.Vec3(1, 0, 0);
      mat.SetAxisX(v); v.Set(0, 1, 0); mat.SetAxisY(v); v.Set(0, 0, 1); mat.SetAxisZ(v);
      const w = new J.Vec4(0, 0, 0, 1);
      mat.SetColumn4(3, w);
      J.destroy(w);
      const bpl = new J.BroadPhaseLayer(0);
      q = this.query = {
        shape, mat, scale: v, at: new J.RVec3(0, 0, 0), base: new J.RVec3(0, 0, 0),
        settings: new J.CollideShapeSettings(), collector: new J.CollideShapeClosestHitCollisionCollector(),
        bpl, bp: new J.SpecifiedBroadPhaseLayerFilter(bpl), obj: new J.SpecifiedObjectLayerFilter(LAYERS.NON_MOVING),
        body: new J.BodyFilter(), shapeFilter: new J.ShapeFilter(), npq: this.system.GetNarrowPhaseQuery(),
      };
    }
    q.scale.Set(r, r, r);
    q.at.Set(x, y, z);
    q.mat.SetTranslation(q.at);
    q.collector.Reset();
    q.npq.CollideShape(q.shape, q.scale, q.mat, q.settings, q.base, q.collector, q.bp, q.obj, q.body, q.shapeFilter);
    if (!q.collector.HadHit()) return 0;
    const hit = q.collector.get_mHit(), depth = hit.get_mPenetrationDepth();
    if (!(depth > 0)) return 0;
    // The axis is the way to push the other body (shape 2) out, so the probe leaves along its negative.
    const ax = hit.get_mPenetrationAxis();
    const l = Math.hypot(ax.GetX(), ax.GetY(), ax.GetZ());
    if (l < 1e-12) return 0;
    out[0] = -ax.GetX() / l; out[1] = -ax.GetY() / l; out[2] = -ax.GetZ() / l;
    return depth;
  }

  /* A kinematic grip proxy: a 2 mm sphere on the proxy layer. Made once per arm, never per grip. */
  addProxy(pos) {
    const J = this.Jolt, shape = new J.SphereShape(0.002, null);
    this.tmp.r.Set(pos[0], pos[1], pos[2]);
    this.tmp.q.Set(0, 0, 0, 1);
    const cs = new J.BodyCreationSettings(shape, this.tmp.r, this.tmp.q, J.EMotionType_Kinematic, PROXY_LAYER);
    const body = this.bodies.CreateBody(cs);
    J.destroy(cs);
    const id = body.GetID();
    this.bodies.AddBody(id, J.EActivation_Activate);
    const entry = { id, body, kind: 'sphere', size: [0.002], motion: 'kinematic', layer: PROXY_LAYER, pos: [...pos] };
    this.proxies.push(entry);
    return entry;
  }

  /* A ball joint between two bodies at world point p, owned here until removeConstraint. The handle's `pc` reads lambda. */
  addPointConstraint(a, b, p) {
    const J = this.Jolt;
    const s = this._pcs ??= new J.PointConstraintSettings();
    s.mSpace = J.EConstraintSpace_WorldSpace;
    this.tmp.r.Set(p[0], p[1], p[2]);
    s.mPoint1 = this.tmp.r;
    s.mPoint2 = this.tmp.r;
    const c = s.Create(a.body, b.body);
    c.AddRef();
    this.system.AddConstraint(c);
    const h = { c, pc: J.castObject(c, J.PointConstraint), a, b };
    this.constraints.add(h);
    return h;
  }

  /* Newtons the constraint held with over the last step, its direction (on body b) into out. */
  constraintForce(h, out) {
    const l = h.pc.GetTotalLambdaPosition(), x = l.GetX(), y = l.GetY(), z = l.GetZ();
    if (out) { out[0] = x / FIXED_DT; out[1] = y / FIXED_DT; out[2] = z / FIXED_DT; }
    return Math.hypot(x, y, z) / FIXED_DT;
  }

  /* Stop a kinematic body where it is: one moved by MoveKinematic keeps that speed until told otherwise. */
  stopKinematic(entry) {
    this.tmp.v.Set(0, 0, 0);
    this.tmp.v2.Set(0, 0, 0);
    this.bodies.SetLinearAndAngularVelocity(entry.id, this.tmp.v, this.tmp.v2);
  }

  removeConstraint(h) {
    if (!h || !this.constraints.delete(h)) return;
    this.system.RemoveConstraint(h.c);
    h.c.Release();
  }

  inverseMass(entry) { return entry.body.GetMotionProperties().GetInverseMass(); }

  /* A constraint to a kinematic proxy doesn't reliably keep a dynamic body awake, so a grip wakes it each tick. */
  wake(entry) { if (!this.bodies.IsActive(entry.id)) this.bodies.ActivateBody(entry.id); }

  /* Impulse (N·s) on a dynamic body at a world point; Jolt wakes it. */
  impulseAt(entry, ix, iy, iz, px, py, pz) {
    this.tmp.v.Set(ix, iy, iz);
    this.tmp.r.Set(px, py, pz);
    this.bodies.AddImpulse(entry.id, this.tmp.v, this.tmp.r);
  }

  /* Velocity of a body's material at a world point into out. */
  pointVelocity(entry, px, py, pz, out) {
    this.tmp.r.Set(px, py, pz);
    const v = this.bodies.GetPointVelocity(entry.id, this.tmp.r);
    out[0] = v.GetX(); out[1] = v.GetY(); out[2] = v.GetZ();
    return out;
  }

  removeRigid(entry) {
    const i = this.rigid.indexOf(entry);
    if (i < 0) return;
    this.rigid.splice(i, 1);
    this.bodies.RemoveBody(entry.id);
    this.bodies.DestroyBody(entry.id);
  }

  destroy() {
    for (const h of [...this.constraints]) this.removeConstraint(h);
    if (this._pcs) { this.Jolt.destroy(this._pcs); this._pcs = null; }
    for (const e of this.proxies) { this.bodies.RemoveBody(e.id); this.bodies.DestroyBody(e.id); }
    this.proxies = [];
    for (const e of [...this.rigid]) this.removeRigid(e);
    for (const t of Object.values(this.tmp)) this.Jolt.destroy(t);
    if (this.query) {
      const { shape, npq, ...owned } = this.query;
      shape.Release();
      for (const o of Object.values(owned)) this.Jolt.destroy(o);
      this.query = null;
    }
    this.Jolt.destroy(this.jolt);
    this.jolt = null;
  }
}
