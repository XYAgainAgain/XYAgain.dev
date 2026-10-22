import { LAYERS } from '../../config.js';
import { buildShell, rootPatches, uniqueEdges, restLengths, edgeStrain, signedVolume6, vertexNeighbors, domeWeights, BodyFieldFit, SHAPE_KNOBS, BREATH_KNOBS, breathPace, exhaleAt, breathWeights, vertexAreas, spinFor, inhaleShare, neutralizeAccel, spreadWrench } from './mantle-core.js';

/* Her pressurized soft body: mantle, head, and arm crown in one shell. Vertex positions live in Jolt's heap and are
   read in place each frame; with mUpdatePosition off and the body at `origin`, a vertex's local position is world
   minus origin. */

export const MANTLE_KNOBS = {
  mass: 0.5,              // kg in the soft body: half of her 1 kg, since eight arms weigh about as much as the rest
  pressurePa: null,       // gauge pressure; null takes the shell's own from LEVEL_PRESSURE
  compliance: 2e-4,       // m/N on the mantle's edges; the shear term is set to the same
  bendCompliance: 2e-3,
  headStiffness: 4,       // the head's and crown's compliance is the mantle's divided by these
  crownStiffness: 4,
  headDensity: 2.5,       // mass per vertex against the mantle's; at these masses XPBD is iteration-bound, so
  crownDensity: 2.5,      // weight, not compliance, is what keeps the head and crown from ballooning
  bend: 'distance',       // dihedral folds past flat at a hole's lip and the shell explodes; distance does not
  iterations: 5,
  damping: 2.0,           // 1/s; stands in for water drag
  gravityFactor: 0.04,    // slightly heavier than water: cuttlefish tissue without its float is 4% denser than seawater
  righting: 16,           // 1/s²: the dome's lift per meter of rest height, which rights her and nets to zero
  rollDamp: 4,            // 1/s: water's drag on her tumbling about a level axis, so righting settles, not swings
  vertexRadius: 0.004,
  friction: 0.4,
  pinSpeed: 1.2,          // m/s cap on a pinned root, so one step cannot cross a panel
  forceK: 4000,           // force drive: an implicit PD pull on each arm's skin patch, in 1/s² and 1/s, so per unit
  forceDamp: 90,          // mass: the newtons scale with the patch's mass by themselves
  forceN: 40,             // newtons one arm base can exert, as measured in vivo; the cap is spread over its patch
  patchRadius: 0.02,      // meters around a root that one arm base grips
  lateralDamp: 0,         // 1/s across a spring arm's own line when set (0 keeps forceDamp on every axis)
  breathPa: null,         // muscle pressure per unit of breath depth on the mantle's front; null takes LEVEL_BREATH
  ...BREATH_KNOBS,
  rootDroop: 0.6,         // radians below the crown ring's plane that an arm leaves the body
  ...SHAPE_KNOBS,
};

/* Below these, a mantle-first squeeze can leave a dent the shell never pops back out of (coarser shells need more);
   above about 250 the finest shell's short crease edges overstretch at rest. Keyed by vertex count. */
export const LEVEL_PRESSURE = { 152: 400, 296: 300, 488: 250 };

/* Calibrated per shell in the sim: the muscle pressure on the breathing skin that moves her volume by its whole
   amount, so a breath of depth d swings it by d. Stiffer shells (higher rest pressure, fewer edges) need more. */
export const LEVEL_BREATH = { 152: 28500, 296: 13700, 488: 8650 };

const DRIVES = ['pin', 'force', 'free'];

export class Mantle {
  constructor(phys, { n = 8, origin = [0, 0.3, 0], drive = 'pin', knobs = {} } = {}) {
    this.phys = phys;
    this.J = phys.Jolt;
    this.knobs = { ...MANTLE_KNOBS, ...knobs };
    const shape = {};
    for (const key in SHAPE_KNOBS) shape[key] = this.knobs[key];
    this.shell = buildShell(n, shape);
    this.knobs.pressurePa ??= LEVEL_PRESSURE[this.shell.count] ?? 250;
    this.knobs.breathPa ??= LEVEL_BREATH[this.shell.count] ?? 8650;
    this.origin = [...origin];
    this.drive = drive;
    this.roots = Array.from(this.shell.roots);
    this.edges = uniqueEdges(this.shell.faces);
    this.rest = restLengths(this.shell.positions, this.edges);
    this.restVolume = signedVolume6(this.shell.positions, this.shell.faces) / 6;
    this.neighbors = vertexNeighbors(this.shell.faces, this.shell.count);
    this.patches = rootPatches(this.shell.positions, this.roots, this.knobs.patchRadius, this.neighbors);
    this.vertexMass = regionMasses(this.shell, this.knobs);
    this.dome = domeWeights(this.shell.positions, this.vertexMass);
    this.positions = new Float32Array(this.shell.count * 3);   // local, copied out of the heap each frame
    this.positions.set(this.shell.positions);
    this._ring = { c: [0, 0, 0], down: [0, -1, 0] };
    this.fieldFit = new BodyFieldFit(this.shell);
    this._weighBreath();
    this._areas = new Float32Array(this.shell.count * 3);
    this._acc = new Float32Array(this.shell.count * 3);
    this.pace = { rate: 0, depth: 0 };
    // Start halfway through the exhale, where the muscles' push crosses zero, so the first tick has no kick.
    const a = inhaleShare(this.knobs.breathInhale);
    this.breathT = a + (1 - a) / 2;
    this.exhale = 0.5;        // 0 drawn in, 1 breathed out
    this.outflow = 1;         // 0–1, how fast the breath is leaving through the siphon, which flares with it
    this.armForce = new Float32Array(this.shell.roots.length);   // newtons each arm base pulled with last tick
    // Per arm: 0 free (its patch is left alone), 1 spring (the patch follows armTarget, its root's target), 2 rigid
    // (the posture's per-vertex targets). armAxis, when nonzero, is the line lateralDamp splits the damper about.
    const arms = this.roots.length;
    this.armMode = new Uint8Array(arms).fill(2);
    this.armCap = new Float32Array(arms).fill(Infinity);
    this.armTarget = new Float64Array(arms * 3);
    this.armAxis = new Float64Array(arms * 3);
    // A spring arm's target velocity: its damper works against motion relative to a moving target, not to the world.
    this.armVel = new Float64Array(arms * 3);
    this.breathHold = null;   // { exhale, depth, outflow? }: the breathing muscles held at a phase instead of cycling
    this._extra = new Float32Array(this.shell.count * 3);
    this._extraOn = false;
    this._scratch = new Float32Array(this.shell.count * 3);
    this._delta = new Float64Array(arms * 3);
    // Mass-weighted shares of the mantle and the head, for the axis between them.
    this._wMantle = Float32Array.from(this.vertexMass, (m, i) => m * this.shell.regions[i * 3]);
    this._wHead = Float32Array.from(this.vertexMass, (m, i) => m * this.shell.regions[i * 3 + 1]);
    this._build();
  }

  _build() {
    const J = this.J, k = this.knobs, shell = this.shell;
    const settings = new J.SoftBodySharedSettings();
    const v = new J.SoftBodySharedSettingsVertex();
    for (let i = 0; i < shell.count; i++) {
      v.mPosition.x = shell.positions[i * 3];
      v.mPosition.y = shell.positions[i * 3 + 1];
      v.mPosition.z = shell.positions[i * 3 + 2];
      v.mInvMass = 1 / this.vertexMass[i];
      settings.mVertices.push_back(v);
    }
    J.destroy(v);
    const f = new J.SoftBodySharedSettingsFace(0, 0, 0, 0);
    for (let i = 0; i < shell.faces.length; i += 3) {
      f.set_mVertex(0, shell.faces[i]);
      f.set_mVertex(1, shell.faces[i + 1]);
      f.set_mVertex(2, shell.faces[i + 2]);
      settings.AddFace(f);
    }
    J.destroy(f);
    // One attribute per vertex, blended by region in log space; Jolt gives each constraint the mean of its ends.
    const list = new J.ArraySoftBodySharedSettingsVertexAttributes();
    const attrs = new J.SoftBodySharedSettingsVertexAttributes();
    this.softness = new Float32Array(shell.count);
    for (let i = 0; i < shell.count; i++) {
      const soft = 1 / (Math.pow(k.headStiffness, shell.regions[i * 3 + 1]) * Math.pow(k.crownStiffness, shell.regions[i * 3 + 2]));
      this.softness[i] = soft;
      attrs.mCompliance = k.compliance * soft;
      attrs.mShearCompliance = k.compliance * soft;
      attrs.mBendCompliance = k.bendCompliance * soft;
      list.push_back(attrs);
    }
    const bendType = k.bend === 'none' ? J.SoftBodySharedSettings_EBendType_None : k.bend === 'distance' ? J.SoftBodySharedSettings_EBendType_Distance : J.SoftBodySharedSettings_EBendType_Dihedral;
    settings.CreateConstraints(list.data(), list.size(), bendType);
    J.destroy(attrs);
    J.destroy(list);
    settings.Optimize();

    const pos = new J.RVec3(this.origin[0], this.origin[1], this.origin[2]);
    const rot = new J.Quat(0, 0, 0, 1);
    const cs = new J.SoftBodyCreationSettings(settings, pos, rot, LAYERS.MANTLE);
    cs.mPressure = k.pressurePa * this.restVolume;
    cs.mNumIterations = k.iterations;
    cs.mLinearDamping = k.damping;
    cs.mGravityFactor = k.gravityFactor;
    cs.mVertexRadius = k.vertexRadius;
    cs.mFriction = k.friction;
    cs.mRestitution = 0;
    cs.mUpdatePosition = false;
    cs.mMakeRotationIdentity = true;
    cs.mAllowSleeping = false;
    this.body = this.phys.bodies.CreateSoftBody(cs);
    J.destroy(cs);
    J.destroy(pos);
    J.destroy(rot);
    this.id = this.body.GetID();
    this.phys.bodies.AddBody(this.id, J.EActivation_Activate);

    this.mp = J.castObject(this.body.GetMotionProperties(), J.SoftBodyMotionProperties);
    const verts = this.mp.GetVertices();
    const base = J.getPointer(verts.at(0));
    this.stride = (J.getPointer(verts.at(1)) - base) >> 2;      // in floats
    this.posAt = (base >> 2) + (J.SoftBodyVertexTraits.prototype.mPositionOffset >> 2);
    this.velAt = (base >> 2) + (J.SoftBodyVertexTraits.prototype.mVelocityOffset >> 2);
    this.setDrive(this.drive);
    this.sync();
  }

  /* pin: the eight roots carry inverse mass 0 and are moved by velocity. force: every vertex keeps its mass and
     each arm's patch is pulled toward its target (the posture's, or its spring's) with a newton cap. free: nothing pulls; she drifts and
     rights herself. `driven` lists whichever vertices are live. */
  setDrive(mode) {
    this.drive = DRIVES.includes(mode) ? mode : 'pin';
    for (const i of this.roots) this.mp.GetVertex(i).mInvMass = this.drive === 'pin' ? 0 : 1 / this.vertexMass[i];
    if (this.drive === 'pin') {
      this.driven = Int32Array.from(this.roots);
      this.drivenArm = Int32Array.from(this.roots, (_, r) => r);
    } else if (this.drive === 'force') {
      // Each root belongs to its own arm first; on a coarse shell a root can sit in its neighbor's patch.
      const seen = new Map(this.roots.map((i, r) => [i, r]));
      this.patches.forEach((p, r) => { for (const i of p) if (!seen.has(i)) seen.set(i, r); });
      this.driven = Int32Array.from(seen.keys());
      this.drivenArm = Int32Array.from(seen.values());
    } else {
      this.driven = new Int32Array(0);
      this.drivenArm = new Int32Array(0);
    }
    // Weigh each arm's patch as the vertices it actually drives, so overlapping patches never overspend forceN.
    this.patchSize = this.roots.map(() => 0);
    this.patchMass = this.roots.map(() => 0);
    for (let d = 0; d < this.driven.length; d++) { this.patchSize[this.drivenArm[d]]++; this.patchMass[this.drivenArm[d]] += this.vertexMass[this.driven[d]]; }
    const fresh = new Float32Array(this.driven.length * 3);
    for (let d = 0; d < this.driven.length; d++) {
      for (let k = 0; k < 3; k++) fresh[d * 3 + k] = this.positions[this.driven[d] * 3 + k] + this.origin[k];
    }
    this.targets = fresh;   // world-space, one per driven vertex; the rigid posture rewrites them every tick
    // A spring arm with no target yet holds where its root is, never the world origin.
    const p = [0, 0, 0];
    for (let r = 0; r < this.roots.length; r++) { this.rootWorld(r, p); this.armTarget.set(p, r * 3); }
  }

  setPressurePa(pa) { this.knobs.pressurePa = pa; this.mp.SetPressure(pa * this.restVolume); }
  setIterations(n) { this.knobs.iterations = n; this.mp.SetNumIterations(n); }

  /* Copy the live vertex positions out of the heap (re-read each time: WASM growth swaps the buffer). */
  sync() {
    const H = this.J.HEAPF32, p = this.positions, s = this.stride, at = this.posAt;
    for (let i = 0, n = this.shell.count; i < n; i++) {
      const o = at + i * s;
      p[i * 3] = H[o]; p[i * 3 + 1] = H[o + 1]; p[i * 3 + 2] = H[o + 2];
    }
    return p;
  }

  /* Each fixed tick: her breathing muscles, the dome's lift, then every driven vertex toward its world target.
     Pinned roots keep sliding at whatever velocity they last had (Jolt integrates inverse-mass-0 vertices too), so the
     velocity is written every tick, after the rest so a pin always wins; the roots' share of the lift is lost. */
  tick(dt) {
    const H = this.J.HEAPF32, s = this.stride, k = this.knobs;
    this.sync();
    // The pin drive and the force readout divide by dt; a zero step would write NaN into Jolt's velocities.
    if (!(dt > 0)) return;
    this._breathe(dt);
    if (k.righting) {
      const lift = k.righting * dt, dome = this.dome;
      for (let i = 0, n = this.shell.count; i < n; i++) H[this.velAt + i * s + 1] += lift * dome[i];
    }
    if (this._extraOn) {
      const X = this._extra;
      for (let i = 0, n = this.shell.count; i < n; i++) {
        const vo = this.velAt + i * s;
        H[vo] += X[i * 3] * dt; H[vo + 1] += X[i * 3 + 1] * dt; H[vo + 2] += X[i * 3 + 2] * dt;
      }
      X.fill(0);
      this._extraOn = false;
    }
    if (k.rollDamp) this._dampRoll(Math.min(1, k.rollDamp * dt));
    const pin = this.drive === 'pin', F = this._armF ??= new Float64Array(this.roots.length * 3);
    F.fill(0);
    // A spring arm's whole patch moves by its root's error, so the patch translates and keeps its shape.
    const mode = this.armMode, delta = this._delta, P = this.positions;
    for (let r = 0; r < this.roots.length; r++) {
      const ri = this.roots[r] * 3;
      for (let a = 0; a < 3; a++) delta[r * 3 + a] = this.armTarget[r * 3 + a] - this.origin[a] - P[ri + a];
    }
    // Implicit in the spring and the damper, so any gain is stable at the fixed step: v' = (v + dt·K·dx) / (1 + dt·D + dt²·K).
    const K = k.forceK, D = k.forceDamp, den = 1 + dt * D + dt * dt * K, lat = k.lateralDamp > 0 ? 1 + dt * k.lateralDamp + dt * dt * K : 0;
    for (let d = 0; d < this.driven.length; d++) {
      const i = this.driven[d], po = this.posAt + i * s, vo = this.velAt + i * s, arm = this.drivenArm[d], am = pin ? 2 : mode[arm];
      if (am === 0) continue;
      let dx, dy, dz, wx = 0, wy = 0, wz = 0;
      if (am === 1) {
        dx = delta[arm * 3]; dy = delta[arm * 3 + 1]; dz = delta[arm * 3 + 2];
        wx = dt * D * this.armVel[arm * 3]; wy = dt * D * this.armVel[arm * 3 + 1]; wz = dt * D * this.armVel[arm * 3 + 2];
      }
      else {
        dx = this.targets[d * 3] - this.origin[0] - H[po];
        dy = this.targets[d * 3 + 1] - this.origin[1] - H[po + 1];
        dz = this.targets[d * 3 + 2] - this.origin[2] - H[po + 2];
      }
      if (pin) {
        let vx = dx / dt, vy = dy / dt, vz = dz / dt;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > k.pinSpeed) { const f = k.pinSpeed / sp; vx *= f; vy *= f; vz *= f; }
        H[vo] = vx; H[vo + 1] = vy; H[vo + 2] = vz;
      } else {
        const capV = (Math.min(k.forceN, this.armCap[arm]) / this.patchMass[arm]) * dt;
        // With a moving target: v' = (v + dt·K·dx + dt·D·vt) / den.
        let ux = (H[vo] + dt * K * dx + wx) / den - H[vo], uy = (H[vo + 1] + dt * K * dy + wy) / den - H[vo + 1], uz = (H[vo + 2] + dt * K * dz + wz) / den - H[vo + 2];
        if (lat && am === 1) {
          // Across the arm's line the damper runs at lateralDamp: the same update with that denominator, minus its axial part.
          const ax = this.armAxis[arm * 3], ay = this.armAxis[arm * 3 + 1], az = this.armAxis[arm * 3 + 2];
          if (ax * ax + ay * ay + az * az > 0.5) {
            let lx = (H[vo] + dt * K * dx) / lat - H[vo], ly = (H[vo + 1] + dt * K * dy) / lat - H[vo + 1], lz = (H[vo + 2] + dt * K * dz) / lat - H[vo + 2];
            const ua = ux * ax + uy * ay + uz * az, la = lx * ax + ly * ay + lz * az;
            lx -= la * ax; ly -= la * ay; lz -= la * az;
            ux = ua * ax + lx; uy = ua * ay + ly; uz = ua * az + lz;
          }
        }
        const u = Math.hypot(ux, uy, uz);
        if (u > capV) { const f = capV / u; ux *= f; uy *= f; uz *= f; }
        H[vo] += ux; H[vo + 1] += uy; H[vo + 2] += uz;
        const m = this.vertexMass[i] / dt;
        F[arm * 3] += ux * m; F[arm * 3 + 1] += uy * m; F[arm * 3 + 2] += uz * m;
      }
    }
    for (let r = 0; r < this.armForce.length; r++) this.armForce[r] = Math.hypot(F[r * 3], F[r * 3 + 1], F[r * 3 + 2]);
  }

  _weighBreath() {
    this.breathW = breathWeights(this.shell, this.knobs);
    this.breathW.full = this.knobs.breathFull;
    this.breathW.start = this.knobs.breathStart;
  }

  /* Ventilation by her own muscles: the front of the mantle swells on the quick inhale and squeezes in on the slow
     exhale, as a pressure on that skin alone. Muscles are internal, so the net force and torque come out and breathing
     never walks or rocks her. Her gas pressure stays at its rest value. */
  _breathe(dt) {
    const k = this.knobs, pace = breathPace(k, this.pace), hold = this.breathHold;
    let depth = pace.depth;
    if (hold) {
      // Held: the muscles stay at one phase and depth (a full exhale, a jet's pulse) while the cycle waits.
      depth = Number.isFinite(hold.depth) ? Math.max(0, hold.depth) : 0;
      this.exhale = Number.isFinite(hold.exhale) ? Math.max(0, Math.min(1, hold.exhale)) : 0.5;
      this.outflow = Number.isFinite(hold.outflow) ? Math.max(0, Math.min(1, hold.outflow)) : 0;
      if (!(depth > 0)) return;
    } else {
      if (!(pace.depth > 0 && pace.rate > 0)) { this.exhale = 0; this.outflow = 0; return; }
      this.breathT = (this.breathT + (dt * pace.rate) / 60) % 1;
      this.exhale = exhaleAt(this.breathT, k.breathInhale);
      // Water leaves through the funnel only on the exhale, fastest halfway through it.
      this.outflow = this.breathT >= inhaleShare(k.breathInhale) ? 4 * this.exhale * (1 - this.exhale) : 0;
    }
    if (k.breathFull !== this.breathW.full || k.breathStart !== this.breathW.start) this._weighBreath();
    const push = k.breathPa * depth * (0.5 - this.exhale);
    const H = this.J.HEAPF32, s = this.stride, n = this.shell.count, W = this.breathW, m = this.vertexMass, A = this._acc;
    vertexAreas(this.positions, this.shell.faces, this._areas);
    const P = this.positions;
    let fx = 0, fy = 0, fz = 0, M = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const g = (push * W[i]) / m[i];
      A[i * 3] = g * this._areas[i * 3]; A[i * 3 + 1] = g * this._areas[i * 3 + 1]; A[i * 3 + 2] = g * this._areas[i * 3 + 2];
      fx += m[i] * A[i * 3]; fy += m[i] * A[i * 3 + 1]; fz += m[i] * A[i * 3 + 2]; M += m[i];
      cx += m[i] * P[i * 3]; cy += m[i] * P[i * 3 + 1]; cz += m[i] * P[i * 3 + 2];
    }
    fx /= M; fy /= M; fz /= M; cx /= M; cy /= M; cz /= M;
    let tx = 0, ty = 0, tz = 0;
    for (let i = 0; i < n; i++) {
      const rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz;
      const ax = A[i * 3] - fx, ay = A[i * 3 + 1] - fy, az = A[i * 3 + 2] - fz;
      tx += m[i] * (ry * az - rz * ay); ty += m[i] * (rz * ax - rx * az); tz += m[i] * (rx * ay - ry * ax);
    }
    const w = spinFor(P, m, n, cx, cy, cz, tx, ty, tz, this._spin ??= [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const vo = this.velAt + i * s, rx = P[i * 3] - cx, ry = P[i * 3 + 1] - cy, rz = P[i * 3 + 2] - cz;
      H[vo] += (A[i * 3] - fx - (w[1] * rz - w[2] * ry)) * dt;
      H[vo + 1] += (A[i * 3 + 1] - fy - (w[2] * rx - w[0] * rz)) * dt;
      H[vo + 2] += (A[i * 3 + 2] - fz - (w[0] * ry - w[1] * rx)) * dt;
    }
  }

  /* Per-vertex accelerations (m/s², count × 3), consumed by the next mantle.tick() whatever order callers tick in.
     neutral 'both' takes out their net force and torque, 'force' the force alone, false applies them raw. */
  addAccel(acc, { neutral = 'both' } = {}) {
    const n = this.shell.count, A = this._scratch;
    if (!acc || acc.length < n * 3) return false;
    for (let i = 0; i < n * 3; i++) { const v = acc[i]; A[i] = Number.isFinite(v) ? v : 0; }
    neutralizeAccel(A, this.positions, this.vertexMass, n, neutral, this._nspin ??= [0, 0, 0]);
    const X = this._extra;
    for (let i = 0; i < n * 3; i++) X[i] += A[i];
    this._extraOn = true;
    return true;
  }

  /* Arm r's root wrench (N, and N·m about its root) through addAccel raw, so the next tick takes it: on the patch that
     arm drives (the force drive only), or with `body` on all of her. A pinned drive ignores it. */
  addWrench(r, F, T, body = false) {
    if (this.drive === 'pin' || (!body && this.drive !== 'force') || !(r >= 0 && r < this.roots.length)) return false;
    if (this._wFor !== this.driven) {
      this._wFor = this.driven;
      this._wVerts = this.roots.map((_, a) => Int32Array.from(this.driven.filter((_, d) => this.drivenArm[d] === a)));
    }
    const V = body ? (this._wAll ??= Int32Array.from({ length: this.shell.count }, (_, i) => i)) : this._wVerts[r], acc = this._wAcc ??= new Float32Array(this.shell.count * 3), ri = this.roots[r] * 3, P = this.positions, root = this._wRoot ??= [0, 0, 0];
    root[0] = P[ri]; root[1] = P[ri + 1]; root[2] = P[ri + 2];
    if (!spreadWrench(F, T, root, P, this.vertexMass, V, acc)) return false;
    this.addAccel(acc, { neutral: false });
    if (body) acc.fill(0);
    else for (let k = 0; k < V.length; k++) acc.fill(0, V[k] * 3, V[k] * 3 + 3);
    return true;
  }

  /* The unit axis from her head toward the far end of her mantle, from the two regions' mass-weighted centroids. */
  mantleAxis(out = [0, 0, 0]) {
    const P = this.positions, wm = this._wMantle, wh = this._wHead;
    let mx = 0, my = 0, mz = 0, Mm = 0, hx = 0, hy = 0, hz = 0, Mh = 0;
    for (let i = 0, n = this.shell.count; i < n; i++) {
      const a = wm[i], b = wh[i], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      mx += a * x; my += a * y; mz += a * z; Mm += a;
      hx += b * x; hy += b * y; hz += b * z; Mh += b;
    }
    if (!(Mm > 0 && Mh > 0)) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
    const dx = mx / Mm - hx / Mh, dy = my / Mm - hy / Mh, dz = mz / Mm - hz / Mh, l = Math.hypot(dx, dy, dz);
    if (l > 1e-9) { out[0] = dx / l; out[1] = dy / l; out[2] = dz / l; } else { out[0] = 0; out[1] = 1; out[2] = 0; }
    return out;
  }

  /* The crown ring's span: the mean, least, and greatest distance between opposite roots, live or (rest) at rest. */
  ringSpan(rest = false, out = { mean: 0, min: 0, max: 0 }) {
    const R = this.roots, P = rest ? this.shell.positions : this.positions, half = R.length >> 1;
    let sum = 0, lo = Infinity, hi = 0;
    for (let r = 0; r < half; r++) {
      const a = R[r] * 3, b = R[r + half] * 3, d = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
      sum += d; lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    out.mean = sum / Math.max(1, half); out.min = lo; out.max = hi;
    return out;
  }

  /* Take away a share of her rigid spin about level axes, leaving her yaw rate, drift, and every deformation alone.
     Spin comes from the full inertia tensor, so a tilted or squashed body's yaw never reads as roll. */
  _dampRoll(share) {
    const H = this.J.HEAPF32, s = this.stride, m = this.vertexMass, n = this.shell.count;
    let M = 0, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < n; i++) {
      const po = this.posAt + i * s, vo = this.velAt + i * s, w = m[i];
      M += w; cx += w * H[po]; cy += w * H[po + 1]; cz += w * H[po + 2]; vx += w * H[vo]; vy += w * H[vo + 1]; vz += w * H[vo + 2];
    }
    cx /= M; cy /= M; cz /= M; vx /= M; vy /= M; vz /= M;
    let lx = 0, ly = 0, lz = 0, xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (let i = 0; i < n; i++) {
      const po = this.posAt + i * s, vo = this.velAt + i * s, w = m[i];
      const rx = H[po] - cx, ry = H[po + 1] - cy, rz = H[po + 2] - cz;
      const ux = H[vo] - vx, uy = H[vo + 1] - vy, uz = H[vo + 2] - vz;
      lx += w * (ry * uz - rz * uy); ly += w * (rz * ux - rx * uz); lz += w * (rx * uy - ry * ux);
      xx += w * rx * rx; yy += w * ry * ry; zz += w * rz * rz; xy += w * rx * ry; xz += w * rx * rz; yz += w * ry * rz;
    }
    // I = (tr(S) − S) for the second-moment matrix S; solve I·ω = L by its adjugate.
    const a = yy + zz, b = -xy, c = -xz, d = xx + zz, e = -yz, f = xx + yy;
    const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d;
    const det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-30)) return;
    const wx = ((A * lx + B * ly + C * lz) / det) * share;
    const wz = ((C * lx + (b * c - a * e) * ly + (a * d - b * b) * lz) / det) * share;
    for (let i = 0; i < n; i++) {
      const po = this.posAt + i * s, vo = this.velAt + i * s;
      const rx = H[po] - cx, ry = H[po + 1] - cy, rz = H[po + 2] - cz;
      // Subtract (ω × r) with ω = (wx, 0, wz).
      H[vo] -= -wz * ry; H[vo + 1] -= wz * rx - wx * rz; H[vo + 2] -= wx * ry;
    }
  }

  /* Turn her by `angle` radians about a world axis through her centroid, at rest, so righting can be watched. */
  tip(angle, axis = [0, 0, 1]) {
    this.sync();
    const H = this.J.HEAPF32, s = this.stride;
    const l = Math.hypot(axis[0], axis[1], axis[2]);
    if (!(l > 0) || !Number.isFinite(angle)) return;
    const ax = axis[0] / l, ay = axis[1] / l, az = axis[2] / l;
    const c = Math.cos(angle), sn = Math.sin(angle), t = 1 - c;
    const m = this.centroid().map((v, i) => v - this.origin[i]);
    for (let i = 0, n = this.shell.count; i < n; i++) {
      const po = this.posAt + i * s, vo = this.velAt + i * s;
      const x = H[po] - m[0], y = H[po + 1] - m[1], z = H[po + 2] - m[2];
      const dot = ax * x + ay * y + az * z;
      // Rodrigues: v cos θ + (a × v) sin θ + a (a · v)(1 − cos θ).
      H[po] = m[0] + x * c + (ay * z - az * y) * sn + ax * dot * t;
      H[po + 1] = m[1] + y * c + (az * x - ax * z) * sn + ay * dot * t;
      H[po + 2] = m[2] + z * c + (ax * y - ay * x) * sn + az * dot * t;
      H[vo] = 0; H[vo + 1] = 0; H[vo + 2] = 0;
    }
    this.sync();
  }

  /* World position of a root vertex right now (the arms hang off these). */
  rootWorld(r, out) {
    const i = this.roots[r] * 3;
    out[0] = this.positions[i] + this.origin[0];
    out[1] = this.positions[i + 1] + this.origin[1];
    out[2] = this.positions[i + 2] + this.origin[2];
    return out;
  }

  /* The crown ring's world center and its unit normal pointing out of her underside, from the live roots. */
  ring() {
    const R = this.roots, P = this.positions, m = R.length, o = this.origin, out = this._ring;
    let cx = 0, cy = 0, cz = 0;
    for (const i of R) { cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2]; }
    cx /= m; cy /= m; cz /= m;
    // Roots turn from +x toward +z, clockwise seen from above, so the summed cross products point down.
    let dx = 0, dy = 0, dz = 0;
    for (let k = 0; k < m; k++) {
      const a = R[k] * 3, b = R[(k + 1) % m] * 3;
      const ax = P[a] - cx, ay = P[a + 1] - cy, az = P[a + 2] - cz;
      const bx = P[b] - cx, by = P[b + 1] - cy, bz = P[b + 2] - cz;
      dx += ay * bz - az * by; dy += az * bx - ax * bz; dz += ax * by - ay * bx;
    }
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-12) { out.down[0] = dx / l; out.down[1] = dy / l; out.down[2] = dz / l; }
    out.c[0] = cx + o[0]; out.c[1] = cy + o[1]; out.c[2] = cz + o[2];
    return out;
  }

  /* Her body's up in world space: the crown ring's normal, flipped. */
  up(out = [0, 0, 0]) {
    const d = this.ring().down;
    out[0] = -d[0]; out[1] = -d[1]; out[2] = -d[2];
    return out;
  }

  /* Root r's frame for the arm hung on it: p its world position, n the unit direction the arm leaves along (outward
     from the crown ring, tipped down by rootDroop), t the unit tangent around the ring with r increasing.
     r = 0 is front-right and r grows around her right side, so 3 is back-right and 7 front-left. */
  rootFrame(r, out = {}) {
    const p = out.p ?? (out.p = [0, 0, 0]), n = out.n ?? (out.n = [0, 0, 0]), t = out.t ?? (out.t = [0, 0, 0]);
    this.rootWorld(r, p);
    const { c, down } = this.ring();
    const dx = down[0], dy = down[1], dz = down[2];
    let rx = p[0] - c[0], ry = p[1] - c[1], rz = p[2] - c[2];
    const along = rx * dx + ry * dy + rz * dz;
    rx -= along * dx; ry -= along * dy; rz -= along * dz;
    const l = Math.hypot(rx, ry, rz);
    if (l > 1e-9) { rx /= l; ry /= l; rz /= l; }
    else {
      // A ring crushed to a point has no outward; fall back to the root's rest bearing.
      const az = (2 * Math.PI * (r + 0.5)) / this.roots.length;
      rx = Math.cos(az); ry = 0; rz = Math.sin(az);
    }
    const cd = Math.cos(this.knobs.rootDroop), sd = Math.sin(this.knobs.rootDroop);
    n[0] = rx * cd + dx * sd; n[1] = ry * cd + dy * sd; n[2] = rz * cd + dz * sd;
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= nl; n[1] /= nl; n[2] /= nl;
    t[0] = dy * rz - dz * ry; t[1] = dz * rx - dx * rz; t[2] = dx * ry - dy * rx;
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    t[0] /= tl; t[1] /= tl; t[2] /= tl;
    return out;
  }

  /* Her head's axes in world space, from the crown ring: f toward her front pair, u her up, s her right side. */
  bodyFrame(out = {}) {
    const f = out.f ?? (out.f = [1, 0, 0]), u = out.u ?? (out.u = [0, 1, 0]), sd = out.s ?? (out.s = [0, 0, 1]);
    const { c, down } = this.ring(), P = this.positions, o = this.origin, a = this.roots[0] * 3, b = this.roots[this.roots.length - 1] * 3;
    u[0] = -down[0]; u[1] = -down[1]; u[2] = -down[2];
    let fx = (P[a] + P[b]) / 2 + o[0] - c[0], fy = (P[a + 1] + P[b + 1]) / 2 + o[1] - c[1], fz = (P[a + 2] + P[b + 2]) / 2 + o[2] - c[2];
    const along = fx * u[0] + fy * u[1] + fz * u[2];
    fx -= along * u[0]; fy -= along * u[1]; fz -= along * u[2];
    const l = Math.hypot(fx, fy, fz);
    if (l > 1e-9) { f[0] = fx / l; f[1] = fy / l; f[2] = fz / l; }
    sd[0] = f[1] * u[2] - f[2] * u[1]; sd[1] = f[2] * u[0] - f[0] * u[2]; sd[2] = f[0] * u[1] - f[1] * u[0];
    return out;
  }

  centroid(out = [0, 0, 0]) {
    let x = 0, y = 0, z = 0;
    const p = this.positions, n = this.shell.count;
    for (let i = 0; i < n; i++) { x += p[i * 3]; y += p[i * 3 + 1]; z += p[i * 3 + 2]; }
    out[0] = x / n + this.origin[0]; out[1] = y / n + this.origin[1]; out[2] = z / n + this.origin[2];
    return out;
  }

  health() {
    let nan = 0;
    for (let i = 0; i < this.positions.length; i++) if (!Number.isFinite(this.positions[i])) nan++;
    const strain = edgeStrain(this.positions, this.rest, this.edges);
    const volume = signedVolume6(this.positions, this.shell.faces) / 6 / this.restVolume;
    const tilt = Math.acos(Math.max(-1, Math.min(1, -this.ring().down[1])));
    return { nan, strainMax: strain.max, strainMean: strain.mean, volume, tilt };
  }

  destroy() {
    this.phys.bodies.RemoveBody(this.id);
    this.phys.bodies.DestroyBody(this.id);
    this.body = null;
    this.mp = null;
  }
}

/* Each vertex's mass in kg, by region density, summing to the body's mass. */
function regionMasses(shell, k) {
  const out = new Float32Array(shell.count);
  let total = 0;
  for (let i = 0; i < shell.count; i++) {
    out[i] = shell.regions[i * 3] + k.headDensity * shell.regions[i * 3 + 1] + k.crownDensity * shell.regions[i * 3 + 2];
    total += out[i];
  }
  for (let i = 0; i < shell.count; i++) out[i] *= k.mass / total;
  return out;
}
