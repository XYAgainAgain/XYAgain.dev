import * as THREE from 'three/webgpu';
import { EYE, EYE_KNOBS, pupilBand, levelStep, clampCone } from './mantle-core.js';
import { createRng } from '../../../pond/js/rng.js';

/* Her eyes and siphon: small meshes that each ride a frame built every drawn frame from three shell vertices, so
   they squish and turn with the skin under them. Eye state runs on sim time, so a paused tank holds her gaze. */

export const PART_KNOBS = {
  eyeRadius: 0.0085,      // 17 mm across, inside the 15–20 mm measured
  eyeOut: 0.25,           // how far the eyeball's center sits outside the skin, as a fraction of its radius
  siphonLength: 0.032,    // the funnel runs 19–53% of mantle length in O. vulgaris; this is about a fifth of hers
  siphonBase: 0.0085,
  siphonTip: 0.0045,
  siphonForward: 1.2,     // how far the funnel leans from her underside toward her front
  siphonSwing: 0.45,      // rad the funnel swings to either side as it aims her breaths
  siphonPeriod: 9,        // s for one slow swing there and back
  siphonFlare: 0.35,      // how much wider the funnel's mouth opens while a breath leaves through it
  squishMin: 0.7,         // clamp on how much a part scales with the skin's stretch
  squishMax: 1.3,
  ...EYE_KNOBS,
};

const COLUMNS = 24, ROWS = 6;
const UP = [0, 1, 0];
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3(), _g = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Matrix4(), _f = new THREE.Matrix4(), _p = new THREE.Matrix4();
const _quat = new THREE.Quaternion(), _y = new THREE.Vector3(0, 1, 0), _one = new THREE.Vector3(1, 1, 1), _s = new THREE.Matrix4();

export class BodyParts {
  constructor(mantle, scene, knobs = {}, { seed = 1 } = {}) {
    this.mantle = mantle;
    this.knobs = { ...PART_KNOBS, ...knobs };
    this.rng = createRng(seed);
    const k = this.knobs, shell = mantle.shell;
    this.restNormals = vertexNormals(shell.positions, shell.faces, shell.count);
    this.mats = {
      eye: new THREE.MeshStandardMaterial({ color: 0xe0a92a, roughness: 0.18, metalness: 0 }),
      pupil: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.6, side: THREE.DoubleSide }),
      siphon: new THREE.MeshStandardMaterial({ color: 0x9a6cbd, roughness: 0.45, side: THREE.DoubleSide }),
    };
    this.parts = [];
    this.time = null;
    this.open = 1 - Math.max(0, Math.min(1, k.light));
    this.statocyst = { est: [0, 1, 0], tracking: false };
    this.frame = {};
    this._shown = -1;
    this.pupilGeo = new THREE.BufferGeometry();
    // Rows across the band keep a wide pupil lying on the eyeball; a single chord from top to bottom would sink into it.
    this.pupilGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((COLUMNS + 1) * (ROWS + 1) * 3), 3));
    const index = [];
    for (let j = 0; j < COLUMNS; j++) {
      for (let r = 0; r < ROWS; r++) {
        const a = j * (ROWS + 1) + r, b = a + ROWS + 1;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    this.pupilGeo.setIndex(index);
    this._band = new Float32Array((COLUMNS + 1) * 4);
    const eyeGeo = new THREE.SphereGeometry(k.eyeRadius, 24, 16);
    this.eyes = Array.from(shell.eyes, (a, e) => {
      const n = this._restNormal(a);
      const center = this._restPoint(a).addScaledVector(n, k.eyeRadius * k.eyeOut);
      const part = this._mount(a, new THREE.Mesh(eyeGeo, this.mats.eye), new THREE.Matrix4().makeTranslation(center.x, center.y, center.z), scene);
      const pupil = new THREE.Mesh(this.pupilGeo, this.mats.pupil);
      pupil.matrixAutoUpdate = false;
      pupil.frustumCulled = false;
      scene.add(pupil);
      const side = e === EYE.left ? -1 : 1, rest = [0, 0, side];
      return { name: e === EYE.left ? 'left' : 'right', side, part, pupil, rest, gaze: [...rest], want: [...rest], wander: [...rest], target: null, next: 0, center: [0, 0, 0] };
    });
    // The funnel opens at both ends, its base at the origin and its mouth up +y before posing. It sits on her midline,
    // so its base is the exact skin point there rather than the vertex it rides.
    const siphonGeo = new THREE.CylinderGeometry(k.siphonTip, k.siphonBase, k.siphonLength, 14, 1, true);
    siphonGeo.translate(0, k.siphonLength / 2, 0);
    const sn = this._restNormal(shell.siphon).setZ(0).normalize();
    this.siphonRest = sn.clone().add(new THREE.Vector3(k.siphonForward, 0, 0)).normalize();
    this.siphonBase = new THREE.Vector3(...shell.siphonPoint).addScaledVector(sn, -k.siphonBase * 0.3);
    this.siphon = this._mount(shell.siphon, new THREE.Mesh(siphonGeo, this.mats.siphon), this._siphonPose(0, new THREE.Matrix4()), scene);
    this.siphon.restInv = this.siphon.rest.clone().invert();
    this.update();
  }

  _restPoint(i) { const p = this.mantle.shell.positions; return new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); }
  _restNormal(i) { const n = this.restNormals; return new THREE.Vector3(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]); }

  /* The funnel's rest pose swung `angle` radians about her up. */
  _siphonPose(angle, out) {
    _g.copy(this.siphonRest).applyAxisAngle(_y, angle);
    return out.compose(this.siphonBase, _quat.setFromUnitVectors(_y, _g), _one);
  }

  /* Ride vertex a with two of its neighbors, picked once: the first, and whichever other is most square to it. */
  _mount(a, mesh, restPose, scene) {
    const nbr = this.mantle.neighbors[a], P = this.mantle.shell.positions;
    const b = nbr[0];
    const ex = P[b * 3] - P[a * 3], ey = P[b * 3 + 1] - P[a * 3 + 1], ez = P[b * 3 + 2] - P[a * 3 + 2];
    const el = Math.hypot(ex, ey, ez);
    let c = nbr[1], best = Infinity;
    for (const j of nbr) {
      if (j === b) continue;
      const fx = P[j * 3] - P[a * 3], fy = P[j * 3 + 1] - P[a * 3 + 1], fz = P[j * 3 + 2] - P[a * 3 + 2];
      const cos = Math.abs(ex * fx + ey * fy + ez * fz) / (el * Math.hypot(fx, fy, fz));
      if (cos < best) { best = cos; c = j; }
    }
    const part = { a, b, c, flip: false, mesh, rest: new THREE.Matrix4(), offset: new THREE.Matrix4(), lenRest: 0 };
    // The frame's normal must face out of her; if the neighbor order winds it inward, flip it for good.
    frame(P, [0, 0, 0], part, part.rest);
    if (_n.dot(this._restNormal(a)) < 0) { part.flip = true; frame(P, [0, 0, 0], part, part.rest); }
    part.lenRest = el;
    part.offset.copy(part.rest).invert().multiply(restPose);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    this.parts.push(part);
    return part;
  }

  /* Aim one eye ('left', 'right', or its index) at a world point, or hand it back to its idle glances with null. */
  look(eye, point) {
    const e = this.eyes[this._eye(eye)];
    e.target = point ? [point.x ?? point[0], point.y ?? point[1], point.z ?? point[2]] : null;
    return e.name;
  }

  /* The eye she would look at a world point with: whichever turns less, with her left favored by `favor` radians. */
  eyeFor(point) {
    const p = [point.x ?? point[0], point.y ?? point[1], point.z ?? point[2]], F = this.mantle.bodyFrame(this.frame);
    let best = 'left', score = Infinity;
    for (const e of this.eyes) {
      const d = toBody(F, p[0] - e.center[0], p[1] - e.center[1], p[2] - e.center[2], [0, 0, 0]);
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      const turn = Math.acos(Math.max(-1, Math.min(1, (d[0] * e.rest[0] + d[1] * e.rest[1] + d[2] * e.rest[2]) / l))) - (e.name === 'left' ? this.knobs.favor : 0);
      if (turn < score) { score = turn; best = e.name; }
    }
    return best;
  }

  /* Look at a point with the eye she would pick; returns which one. */
  lookAt(point) { return this.look(this.eyeFor(point), point); }

  /* Where an eye is looking right now, as a world-space unit vector. */
  gaze(eye, out = [0, 0, 0]) { return toWorld(this.mantle.bodyFrame(this.frame), this.eyes[this._eye(eye)].gaze, out); }

  _eye(eye) { return eye === 'left' || eye === EYE.left ? EYE.left : EYE.right; }

  /* Pose every part from the live shell; call after the mantle's sync on each drawn frame. */
  update() {
    const P = this.mantle.positions, o = this.mantle.origin, k = this.knobs;
    const now = this.mantle.phys?.time ?? 0, dt = this.time === null ? 0 : Math.max(0, Math.min(2, now - this.time));
    this.time = now;
    if (this.siphon?.restInv) {
      const A = this._aim;
      if (A) {
        // The world aim carried back into the rest shell: the mount's live frame undone, then its rest frame applied.
        frame(P, o, this.siphon, _s);
        _g.set(A[0], A[1], A[2]).transformDirection(_s.invert()).transformDirection(this.siphon.rest);
        this.siphon.offset.copy(this.siphon.restInv).multiply(_p.compose(this.siphonBase, _quat.setFromUnitVectors(_y, _g), _one));
      } else {
        const swing = k.siphonSwing * Math.sin((2 * Math.PI * now) / Math.max(0.1, k.siphonPeriod));
        this.siphon.offset.copy(this.siphon.restInv).multiply(this._siphonPose(swing, _p));
      }
    }
    for (const part of this.parts) {
      frame(P, o, part, _m);
      const l = Math.hypot(P[part.b * 3] - P[part.a * 3], P[part.b * 3 + 1] - P[part.a * 3 + 1], P[part.b * 3 + 2] - P[part.a * 3 + 2]);
      const s = Math.max(k.squishMin, Math.min(k.squishMax, part.lenRest > 0 ? l / part.lenRest : 1));
      _q.makeScale(s, s, s);
      part.mesh.matrix.multiplyMatrices(_m, _q).multiply(part.offset);
      if (part === this.siphon) {
        const w = 1 + k.siphonFlare * (this.mantle.outflow ?? 0);
        part.mesh.matrix.multiply(_f.makeScale(w, 1, w));
      }
      part.mesh.matrixWorldNeedsUpdate = true;
    }
    if (this.eyes) this._eyes(dt);
  }

  _eyes(dt) {
    const k = this.knobs, F = this.mantle.bodyFrame(this.frame), st = this.statocyst;
    // Her statocysts sit in her head, so their sense of up lives in her body frame and turns with her until it catches up.
    const upB = this._upB ??= [0, 0, 0];
    upB[0] = F.f[1]; upB[1] = F.u[1]; upB[2] = F.s[1];
    levelStep(st, upB, dt, k);
    const g = Math.max(0, Math.min(1, k.levelGain)), lev = this._lev ??= [0, 0, 0];
    for (let a = 0; a < 3; a++) lev[a] = UP[a] + (st.est[a] - UP[a]) * g;
    const ll = Math.hypot(lev[0], lev[1], lev[2]) || 1;
    for (let a = 0; a < 3; a++) lev[a] /= ll;
    // A roll about her long axis raises the lower eye and lowers the upper one; a pitch rolls the pupils level.
    const roll = Math.atan2(-lev[2], lev[1]), cr = Math.cos(-roll), sr = Math.sin(-roll);
    const want = 1 - Math.max(0, Math.min(1, k.light));
    this.open += (want - this.open) * (1 - Math.pow(2, -dt / Math.max(1e-3, k.pupilHalf)));
    if (Math.abs(this.open - this._shown) > 1e-3) this._shape();
    const levW = toWorld(F, lev, this._levW ??= [0, 0, 0]), d = this._d ??= [0, 0, 0], gw = this._gw ??= [0, 0, 0];
    const now = this.time, ease = 1 - Math.exp(-dt / Math.max(1e-3, k.gazeTime));
    for (const e of this.eyes) {
      // Each eye rests looking out to its own side, level, a touch forward; the skin's normal there leans back.
      e.rest[0] = Math.sin(k.eyeAhead); e.rest[1] = 0; e.rest[2] = e.side * Math.cos(k.eyeAhead);
      const m = e.part.mesh.matrix;
      _c.setFromMatrixPosition(m);
      e.center[0] = _c.x; e.center[1] = _c.y; e.center[2] = _c.z;
      if (e.target) {
        toBody(F, e.target[0] - _c.x, e.target[1] - _c.y, e.target[2] - _c.z, d);
      } else {
        if (now >= e.next) {
          randomInCone(e.rest, k.saccadeCone, this.rng, e.wander);
          e.next = now + this.rng.range(k.saccadeMin, Math.max(k.saccadeMin, k.saccadeMax));
        }
        // Idle glances are set against her body, so they take the roll back; a target is already in the world.
        d[0] = e.wander[0]; d[1] = e.wander[1] * cr - e.wander[2] * sr; d[2] = e.wander[1] * sr + e.wander[2] * cr;
      }
      const l = Math.hypot(d[0], d[1], d[2]);
      if (l > 1e-9) { for (let a = 0; a < 3; a++) d[a] /= l; clampCone(e.rest, d, k.eyeTurn, e.want); }
      for (let a = 0; a < 3; a++) e.gaze[a] += (e.want[a] - e.gaze[a]) * ease;
      const gl = Math.hypot(e.gaze[0], e.gaze[1], e.gaze[2]) || 1;
      for (let a = 0; a < 3; a++) e.gaze[a] /= gl;
      toWorld(F, e.gaze, gw);
      // The pupil's long axis lies level as her statocysts judge level: across the gaze, square to their up.
      _n.set(gw[0], gw[1], gw[2]);
      _e1.set(levW[1] * gw[2] - levW[2] * gw[1], levW[2] * gw[0] - levW[0] * gw[2], levW[0] * gw[1] - levW[1] * gw[0]);
      if (_e1.lengthSq() < 1e-8) _e1.set(F.f[0], F.f[1], F.f[2]);
      _e1.normalize();
      _e2.crossVectors(_n, _e1);
      const scale = _g.setFromMatrixColumn(m, 0).length();
      e.pupil.matrix.makeBasis(_e1.multiplyScalar(scale), _e2.multiplyScalar(scale), _n.multiplyScalar(scale));
      e.pupil.matrix.setPosition(_c);
      e.pupil.matrixWorldNeedsUpdate = true;
    }
  }

  /* Rebuild the shared pupil mesh for the current openness, laid onto the eyeball just above its surface. */
  _shape() {
    const b = pupilBand(this.open, COLUMNS, this.knobs, this._band), pos = this.pupilGeo.attributes.position, r = this.knobs.eyeRadius;
    const R2 = (r * 1.015) ** 2;
    for (let j = 0; j <= COLUMNS; j++) {
      const x = b[j * 4] * r, top = b[j * 4 + 1] * r, bottom = b[j * 4 + 3] * r;
      for (let row = 0; row <= ROWS; row++) {
        const y = bottom + ((top - bottom) * row) / ROWS;
        pos.setXYZ(j * (ROWS + 1) + row, x, y, Math.sqrt(Math.max(0, R2 - x * x - y * y)));
      }
    }
    pos.needsUpdate = true;
    this._shown = this.open;
  }

  /* Point the funnel's mouth along a world direction (the jet's outflow) until called with null, when it swings again. */
  aimSiphon(dir) {
    this._aim = dir && Number.isFinite(dir[0] + dir[1] + dir[2]) && Math.hypot(dir[0], dir[1], dir[2]) > 1e-6 ? [dir[0], dir[1], dir[2]] : null;
  }

  /* The siphon's mouth direction in world space, for the jet. */
  siphonAim(out = new THREE.Vector3()) {
    return out.setFromMatrixColumn(this.siphon.mesh.matrix, 1).normalize();
  }
}

function toBody(F, x, y, z, out) {
  out[0] = x * F.f[0] + y * F.f[1] + z * F.f[2];
  out[1] = x * F.u[0] + y * F.u[1] + z * F.u[2];
  out[2] = x * F.s[0] + y * F.s[1] + z * F.s[2];
  return out;
}

function toWorld(F, v, out) {
  for (let a = 0; a < 3; a++) out[a] = F.f[a] * v[0] + F.u[a] * v[1] + F.s[a] * v[2];
  return out;
}

/* A unit direction within `cone` radians of unit `rest`, spread evenly over the cone's cap. */
function randomInCone(rest, cone, rng, out) {
  const ang = cone * Math.sqrt(rng.next()), az = 2 * Math.PI * rng.next();
  const ax = Math.abs(rest[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let px = ax[1] * rest[2] - ax[2] * rest[1], py = ax[2] * rest[0] - ax[0] * rest[2], pz = ax[0] * rest[1] - ax[1] * rest[0];
  const pl = Math.hypot(px, py, pz);
  px /= pl; py /= pl; pz /= pl;
  const qx = rest[1] * pz - rest[2] * py, qy = rest[2] * px - rest[0] * pz, qz = rest[0] * py - rest[1] * px;
  const c = Math.cos(ang), s = Math.sin(ang), ca = Math.cos(az), sa = Math.sin(az);
  out[0] = rest[0] * c + (px * ca + qx * sa) * s;
  out[1] = rest[1] * c + (py * ca + qy * sa) * s;
  out[2] = rest[2] * c + (pz * ca + qz * sa) * s;
  return out;
}

/* A rotation-and-position frame at vertex a: e1 toward b, the normal from e1 × (c − a), e2 completing it. */
function frame(P, o, part, out) {
  const { a, b, c } = part;
  _e1.set(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]);
  _e2.set(P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]);
  if (_e1.lengthSq() < 1e-14) _e1.set(1, 0, 0);
  _e1.normalize();
  _n.crossVectors(_e1, _e2);
  if (_n.lengthSq() < 1e-14) _n.set(0, 1, 0).cross(_e1);
  if (_n.lengthSq() < 1e-14) _n.set(0, 0, 1);
  _n.normalize();
  if (part.flip) _n.negate();
  _e2.crossVectors(_n, _e1);
  out.makeBasis(_e1, _e2, _n);
  out.setPosition(P[a * 3] + o[0], P[a * 3 + 1] + o[1], P[a * 3 + 2] + o[2]);
  return out;
}

function vertexNormals(P, faces, count) {
  const N = new Float32Array(count * 3);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const bx = P[b] - P[a], by = P[b + 1] - P[a + 1], bz = P[b + 2] - P[a + 2];
    const cx = P[c] - P[a], cy = P[c + 1] - P[a + 1], cz = P[c + 2] - P[a + 2];
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
  }
  for (let i = 0; i < count; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
  }
  return N;
}
