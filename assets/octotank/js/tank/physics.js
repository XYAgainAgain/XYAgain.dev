import { LAYERS, FIXED_DT, MAX_SUBSTEPS, GRAVITY } from '../config.js';

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
const SETTLE_STEPS = 30;    // steps; a new soft body is inflating

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
    this.tickMs = new Float32Array(STEP_WINDOW);   // the JS side of a tick: posture, pins, 184 kinematic moves, water
    this.stepCount = 0;
    this.stepTotal = 0;
    this.dropped = 0;         // seconds of frame time the step cap discarded
    this.water = null;        // ticked after the JS work, just before Jolt steps
  }

  /* Fixed 60 Hz with a two-step cap; leftover time past that is dropped, never caught up. */
  step(frameDt, preTick) {
    this.acc += Math.min(frameDt, 0.1);
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_SUBSTEPS) {
      const t0 = performance.now();
      preTick?.(FIXED_DT, this.stepTotal);
      this.water?.tick(FIXED_DT);
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

  /* Jolt's Step alone; `js` is the same summary for the JS work that feeds each step, water included, and `water` that
     part alone. */
  stats() {
    const n = Math.min(this.stepCount, STEP_WINDOW);
    return { n, ...summarize(this.stepMs, n), js: summarize(this.tickMs, n), water: this.water?.stats() ?? null, dropped: this.dropped };
  }

  resetStats() { this.stepCount = 0; this.dropped = 0; this.water?.resetStats(); }

  /* kind: box (size = half extents), sphere (size = [r]), capsule/cylinder (size = [halfHeight, r]). Jolt derives mass
     and inertia from `density` (kg/m³) and the shape's volume; `ccd` sweeps a fast body so it can't skip through a wall. */
  addRigid(kind, size, pos, { rot = null, motion = 'dynamic', layer = LAYERS.TOYS, friction = 0.5, restitution = 0, density = 1000, ccd = false } = {}) {
    const J = this.Jolt;
    let shape;
    if (kind === 'box') {
      this.tmp.v.Set(size[0], size[1], size[2]);
      shape = new J.BoxShape(this.tmp.v, Math.min(0.005, 0.3 * Math.min(size[0], size[1], size[2])), null);
    } else if (kind === 'sphere') shape = new J.SphereShape(size[0], null);
    else if (kind === 'capsule') shape = new J.CapsuleShape(size[0], size[1], null);
    else if (kind === 'cylinder') shape = new J.CylinderShape(size[0], size[1], Math.min(0.005, 0.3 * size[1]), null);
    else throw new Error(`addRigid: unknown kind ${kind}`);
    shape.SetDensity(density);
    const volume = shape.GetVolume();
    const motionType = motion === 'static' ? J.EMotionType_Static : motion === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Dynamic;
    this.tmp.r.Set(pos[0], pos[1], pos[2]);
    if (rot) this.tmp.q.Set(rot[0], rot[1], rot[2], rot[3]); else this.tmp.q.Set(0, 0, 0, 1);
    const cs = new J.BodyCreationSettings(shape, this.tmp.r, this.tmp.q, motionType, layer);
    cs.mFriction = friction;
    cs.mRestitution = restitution;
    // Jolt's default damping would be a second, unphysical drag on top of the water's.
    cs.mLinearDamping = 0;
    cs.mAngularDamping = 0;
    if (ccd) cs.mMotionQuality = J.EMotionQuality_LinearCast;
    const body = this.bodies.CreateBody(cs);
    J.destroy(cs);
    const id = body.GetID();
    this.bodies.AddBody(id, J.EActivation_Activate);
    const entry = { id, body, kind, size, motion, layer, pos: [...pos], volume, mass: motion === 'dynamic' ? 1 / body.GetMotionProperties().GetInverseMass() : Infinity };
    this.rigid.push(entry);
    return entry;
  }

  /* A static triangle mesh at the origin from { positions, indices }, counterclockwise from outside. One closed body on
     purpose: Jolt pushes a soft-body vertex out through its nearest triangle in each shape, back face or not. */
  addMesh(mesh, { layer = LAYERS.NON_MOVING, friction = 0.7 } = {}) {
    const { id, body, lo, hi } = this._staticMesh(mesh, layer, friction);
    const size = [0, 1, 2].map((a) => (hi[a] - lo[a]) / 2);
    const entry = { id, body, kind: 'mesh', size, motion: 'static', layer, pos: [0, 0, 0], bounds: { lo, hi }, volume: 0, mass: Infinity };
    this.rigid.push(entry);
    return entry;
  }

  /* Closed pieces as one entry: the first is its body, the rest its `parts`, outside `rigid`. With `field`, a soft body skips each
     piece over `margin` m plus two steps of its fastest vertex, and the last step's change in that speed, away. */
  addMeshes(meshes, { layer = LAYERS.NON_MOVING, friction = 0.7, field = null, margin = 0.025 } = {}) {
    if (!meshes.length) throw new Error('addMeshes: no pieces');
    if (field && this.cull?.field && this.cull.field !== field) throw new Error('addMeshes: one culled field per world');
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], pieces = meshes.map((m) => this._staticMesh(m, layer, friction));
    for (const p of pieces) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p.lo[a]); hi[a] = Math.max(hi[a], p.hi[a]); }
    const size = [0, 1, 2].map((a) => (hi[a] - lo[a]) / 2), parts = pieces.slice(1).map((p) => p.id);
    const entry = { id: pieces[0].id, body: pieces[0].body, parts, kind: 'mesh', size, motion: 'static', layer, pos: [0, 0, 0], bounds: { lo, hi }, volume: 0, mass: Infinity };
    if (field) {
      const cull = this._softCull(), J = this.Jolt;
      cull.field = field; cull.margin = margin; cull.version++;
      entry.culled = pieces.map((p) => { const ptr = J.getPointer(p.body); cull.boxes.set(ptr, [...p.lo, ...p.hi]); return ptr; });
    }
    this.rigid.push(entry);
    return entry;
  }

  /* Jolt walks every vertex to its nearest triangle in each overlapping body, however far; the listener drops the pieces
     the field proves out of reach before the walk. */
  _softCull() {
    if (this.cull) return this.cull;
    const J = this.Jolt, cull = this.cull = { field: null, margin: 0, reach: 0, boxes: new Map(), version: 0, open: false, age: 0, speed: 0, step: -1, ptr: 0, near: new Float64Array(0), count: 0, n: [0, 0, 0] };
    const listener = cull.listener = new J.SoftBodyContactListenerJS();
    const accept = J.SoftBodyValidateResult_AcceptContact, reject = J.SoftBodyValidateResult_RejectContact;
    listener.OnSoftBodyContactValidate = (soft, other) => {
      const b = cull.boxes.get(other);
      if (!b) return accept;
      // Keyed on stepTotal: a stepper that doesn't bump it reuses the last step's vertices.
      if (cull.step !== this.stepTotal || cull.ptr !== soft) this._nearVertices(soft);
      if (cull.open) return accept;
      const m = cull.reach, P = cull.near;
      for (let i = 0; i < cull.count * 3; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        const dx = x < b[0] ? b[0] - x : x > b[3] ? x - b[3] : 0, dy = y < b[1] ? b[1] - y : y > b[4] ? y - b[4] : 0, dz = z < b[2] ? b[2] - z : z > b[5] ? z - b[5] : 0;
        if (dx * dx + dy * dy + dz * dz <= m * m) return accept;
      }
      return reject;
    };
    listener.OnSoftBodyContactAdded = () => {};
    this.system.SetSoftBodyContactListener(listener);
    return cull;
  }

  // Once per step, and only when a piece asks.
  _nearVertices(ptr) {
    const J = this.Jolt, cull = this.cull, body = J.wrapPointer(ptr, J.Body);
    const verts = J.castObject(body.GetMotionProperties(), J.SoftBodyMotionProperties).GetVertices(), n = verts.size();
    const base = J.getPointer(verts.at(0)), stride = n > 1 ? (J.getPointer(verts.at(1)) - base) >> 2 : 0, at = (base >> 2) + (J.SoftBodyVertexTraits.prototype.mPositionOffset >> 2), vat = (base >> 2) + (J.SoftBodyVertexTraits.prototype.mVelocityOffset >> 2);
    if (cull.near.length < n * 3) cull.near = new Float64Array(n * 3);
    // Jolt keeps soft bodies unrotated, with each vertex stored relative to the center of mass.
    const H = J.HEAPF32, o = body.GetCenterOfMassPosition(), ox = o.GetX(), oy = o.GetY(), oz = o.GetZ(), f = cull.field, P = cull.near;
    let v2 = 0;
    for (let i = 0; i < n; i++) { const k = vat + i * stride; v2 = Math.max(v2, H[k] * H[k] + H[k + 1] * H[k + 1] + H[k + 2] * H[k + 2]); }
    // A speed that jumped last step means a push in progress; a new body is inflating, so it skips nothing.
    const speed = Math.sqrt(v2), fresh = cull.ptr !== ptr;
    cull.age = fresh ? 0 : cull.age + 1;
    const lim = cull.reach = cull.margin + (2 * speed + Math.abs(speed - (fresh ? 0 : cull.speed))) * FIXED_DT;
    cull.speed = speed;
    cull.open = !(lim < Infinity) || cull.age < SETTLE_STEPS;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const k = at + i * stride, x = H[k] + ox, y = H[k + 1] + oy, z = H[k + 2] + oz;
      if (x !== x || y !== y || z !== z) cull.open = true;
      if (!(f.distance(x, y, z, cull.n) <= lim)) continue;
      P[c * 3] = x; P[c * 3 + 1] = y; P[c * 3 + 2] = z; c++;
    }
    cull.count = c; cull.step = this.stepTotal; cull.ptr = ptr;
  }

  _staticMesh({ positions, indices }, layer, friction) {
    const J = this.Jolt, verts = new J.VertexList(), tris = new J.IndexedTriangleList(), f3 = new J.Float3(0, 0, 0), tri = new J.IndexedTriangle(0, 0, 0, 0, 0);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    verts.reserve(positions.length / 3);
    for (let p = 0; p < positions.length; p += 3) {
      f3.x = positions[p]; f3.y = positions[p + 1]; f3.z = positions[p + 2];
      verts.push_back(f3);
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], positions[p + a]); hi[a] = Math.max(hi[a], positions[p + a]); }
    }
    tris.reserve(indices.length / 3);
    for (let n = 0; n < indices.length; n += 3) {
      tri.set_mIdx(0, indices[n]); tri.set_mIdx(1, indices[n + 1]); tri.set_mIdx(2, indices[n + 2]);
      tris.push_back(tri);
    }
    const materials = new J.PhysicsMaterialList(), settings = new J.MeshShapeSettings(verts, tris, materials);
    J.destroy(f3); J.destroy(tri); J.destroy(verts); J.destroy(tris); J.destroy(materials);
    const result = settings.Create();
    if (result.HasError()) { const error = result.GetError().c_str(); J.destroy(result); J.destroy(settings); throw new Error(`addMesh: ${error}`); }
    const shape = result.Get();
    shape.AddRef();
    J.destroy(result); J.destroy(settings);
    this.tmp.r.Set(0, 0, 0); this.tmp.q.Set(0, 0, 0, 1);
    const cs = new J.BodyCreationSettings(shape, this.tmp.r, this.tmp.q, J.EMotionType_Static, layer);
    // Toys rolling across triangle seams catch on internal edges without it.
    cs.mFriction = friction; cs.mEnhancedInternalEdgeRemoval = true;
    const body = this.bodies.CreateBody(cs);
    J.destroy(cs);
    shape.Release();
    const id = body.GetID();
    this.bodies.AddBody(id, J.EActivation_DontActivate);
    return { id, body, lo, hi };
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
     direction that lifts the probe out into `out`; Jolt objects are made once. Culled rock answers from its field. */
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
        body: new J.BodyFilter(), shapeFilter: new J.ShapeFilter(), npq: this.system.GetNarrowPhaseQuery(), n: [0, 0, 0],
      };
    }
    const field = this.cull?.field;
    if (field && !q.skip) {
      const skip = q.skip = new J.BodyFilterJS(), ids = q.pieceIds = new Set();
      skip.ShouldCollide = (id) => !ids.has(J.wrapPointer(id, J.BodyID).GetIndexAndSequenceNumber());
      skip.ShouldCollideLocked = (body) => !this.cull?.boxes.has(body);
    }
    // Keyed on membership: a freed body id can come back on another body.
    if (field && q.pieceVersion !== this.cull.version) {
      q.pieceIds.clear();
      for (const ptr of this.cull.boxes.keys()) q.pieceIds.add(J.wrapPointer(ptr, J.Body).GetID().GetIndexAndSequenceNumber());
      q.pieceVersion = this.cull.version;
    }
    q.scale.Set(r, r, r);
    q.at.Set(x, y, z);
    q.mat.SetTranslation(q.at);
    q.collector.Reset();
    q.npq.CollideShape(q.shape, q.scale, q.mat, q.settings, q.base, q.collector, q.bp, q.obj, field ? q.skip : q.body, q.shapeFilter);
    const rock = field ? r - field.distance(x, y, z, q.n) : 0;
    const depth = q.collector.HadHit() ? q.collector.get_mHit().get_mPenetrationDepth() : 0;
    if (rock > 0 && !(depth >= rock)) { out[0] = q.n[0]; out[1] = q.n[1]; out[2] = q.n[2]; return rock; }
    if (!(depth > 0)) return 0;
    const hit = q.collector.get_mHit();
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
    for (const id of entry.parts ?? []) { this.bodies.RemoveBody(id); this.bodies.DestroyBody(id); }
    for (const ptr of entry.culled ?? []) this.cull.boxes.delete(ptr);
    if (entry.culled) { this.cull.version++; if (!this.cull.boxes.size) this.cull.field = null; }
    if (this.rockwork?.entry === entry) this.rockwork = null;
  }

  destroy() {
    for (const h of [...this.constraints]) this.removeConstraint(h);
    if (this._pcs) { this.Jolt.destroy(this._pcs); this._pcs = null; }
    for (const e of this.proxies) { this.bodies.RemoveBody(e.id); this.bodies.DestroyBody(e.id); }
    this.proxies = [];
    for (const e of [...this.rigid]) this.removeRigid(e);
    if (this.cull) { this.system.SetSoftBodyContactListener(null); this.Jolt.destroy(this.cull.listener); this.cull = null; }
    for (const t of Object.values(this.tmp)) this.Jolt.destroy(t);
    if (this.query) {
      const { shape, npq, n, pieceIds, pieceVersion, ...owned } = this.query;
      shape.Release();
      for (const o of Object.values(owned)) this.Jolt.destroy(o);
      this.query = null;
    }
    this.Jolt.destroy(this.jolt);
    this.jolt = null;
  }
}
