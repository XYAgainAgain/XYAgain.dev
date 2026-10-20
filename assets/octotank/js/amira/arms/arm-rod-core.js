import { SEAWATER, CD } from '../../water/buoyancy-core.js';

/* One arm as a position-based Cosserat rod, free of THREE and Jolt: Kugelstadt and Schömer's (SCA 2016) particles and
   quaternions with XPBD compliance (Macklin et al. 2016), each substep a Newton solve that is block tridiagonal (Deul et al. 2018). */

export const ROD_KNOBS = {
  E0: 1e6,               // Pa at the root
  tipStiff: 1,           // the modulus's multiplier at the tip, geometric along the arc
  shearFactor: 27 / 28,  // PyElastica's shear correction for a circular section
  density: 1040,         // kg/m³ when no mass budget is given
  weightFactor: 0.04,    // net weight over mass, the mantle's gravityFactor
  gravity: -9.81,
  addedMass: 1,          // share of the sideways water each element drags along; 0 turns it off
  cdCross: CD.cylinderCross,
  cfSkin: 0.02,          // skin friction along the arm
  tipCap: true,          // a tip leading the way meets sphere drag
  damp: 0,               // 1/s of plain velocity decay on top of the water's drag, for settling tests
  substeps: 1,
  iterations: 1,
  maxSpeed: 6,           // m/s per node
  maxSpin: 60,           // rad/s per element
  stepTurn: 0.3,         // rad the most any element may turn in one Newton step; a bigger step is scaled down
  rootStep: 0.01,        // m the root may travel in one substep before the step takes more of them
  rootTurn: 0.1,         // rad, the same for its turn
  maxSubsteps: 8,
};

// 3×3 row-major blocks at offsets; outputs never alias inputs.
function mm(A, a, B, b, O, o) {
  for (let i = 0; i < 3; i++) {
    const r0 = A[a + 3 * i], r1 = A[a + 3 * i + 1], r2 = A[a + 3 * i + 2];
    O[o + 3 * i] = r0 * B[b] + r1 * B[b + 3] + r2 * B[b + 6];
    O[o + 3 * i + 1] = r0 * B[b + 1] + r1 * B[b + 4] + r2 * B[b + 7];
    O[o + 3 * i + 2] = r0 * B[b + 2] + r1 * B[b + 5] + r2 * B[b + 8];
  }
}

function mmt(A, a, B, b, O, o) {
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) {
    O[o + 3 * i + k] = A[a + 3 * i] * B[b + 3 * k] + A[a + 3 * i + 1] * B[b + 3 * k + 1] + A[a + 3 * i + 2] * B[b + 3 * k + 2];
  }
}

/* Adds s·M (3×3 at m) into the 6×6 block at o, rows from r0 and columns from c0; `t` adds its transpose instead. */
function put(Blk, o, r0, c0, M, m, s, t = false) {
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) Blk[o + 6 * (r0 + i) + c0 + k] += s * (t ? M[m + 3 * k + i] : M[m + 3 * i + k]);
}

/* The speed s left after one step of drag a·s² + b·s from speed w (a, b already times dt over mass): the root of
   a·s² + (1 + b)·s = w, in the form that stays exact as a goes to 0. */
function slow(w, a, b) {
  const c = 1 + b;
  return 2 * w / (c + Math.sqrt(c * c + 4 * a * w));
}

/* q ← exp(h)·q into out at o, for the world rotation vector 2h; exact for any turn, so a big one cannot fold a frame. */
function turn(q, qo, hx, hy, hz, out, o) {
  const a = Math.hypot(hx, hy, hz), s = a > 1e-12 ? Math.sin(a) / a : 1, c = Math.cos(a);
  const ex = hx * s, ey = hy * s, ez = hz * s, qx = q[qo], qy = q[qo + 1], qz = q[qo + 2], qw = q[qo + 3];
  const nx = c * qx + ex * qw + ey * qz - ez * qy, ny = c * qy - ex * qz + ey * qw + ez * qx;
  const nz = c * qz + ex * qy - ey * qx + ez * qw, nw = c * qw - ex * qx - ey * qy - ez * qz, il = 1 / Math.hypot(nx, ny, nz, nw);
  out[o] = nx * il; out[o + 1] = ny * il; out[o + 2] = nz * il; out[o + 3] = nw * il;
}

/* A knob that must be a positive number, else its default: a zero or a NaN here would stall or reverse the solver. */
const positive = (v, d) => (v > 0 && Number.isFinite(v) ? v : d);

function crossMat(x, y, z, O) {
  O[0] = 0; O[1] = -z; O[2] = y;
  O[3] = z; O[4] = 0; O[5] = -x;
  O[6] = -y; O[7] = x; O[8] = 0;
}

/* The quaternion (x, y, z, w) whose rotation takes the axes to the orthonormal frame (u, v, d), d along the arm. */
export function frameQuat(u, v, d, out = [0, 0, 0, 1]) {
  const m00 = u[0], m11 = v[1], m22 = d[2], tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) { const s = 2 * Math.sqrt(tr + 1); w = s / 4; x = (v[2] - d[1]) / s; y = (d[0] - u[2]) / s; z = (u[1] - v[0]) / s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (v[2] - d[1]) / s; x = s / 4; y = (v[0] + u[1]) / s; z = (d[0] + u[2]) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (d[0] - u[2]) / s; x = (v[0] + u[1]) / s; y = s / 4; z = (d[1] + v[2]) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (u[1] - v[0]) / s; x = (d[0] + u[2]) / s; y = (d[1] + v[2]) / s; z = s / 4; }
  const l = Math.hypot(x, y, z, w) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = w / l;
  return out;
}

/* The rest relative rotation for a joint: the roll left by the segment before it, then its bend (ku, kv), which tips
   the arm toward ku·u + kv·v as the arm's bendFrame does: a rotation vector (−kv, ku, 0) in the material frame. */
export function jointQuat(ku, kv, roll, out, o = 0) {
  const phi = Math.hypot(ku, kv), sb = phi > 1e-12 ? Math.sin(phi / 2) / phi : 0.5;
  const bx = -kv * sb, by = ku * sb, bw = Math.cos(phi / 2);
  const sz = Math.sin(roll / 2), cz = Math.cos(roll / 2);
  out[o] = cz * bx - sz * by; out[o + 1] = cz * by + sz * bx; out[o + 2] = sz * bw; out[o + 3] = cz * bw;
  return out;
}

export class Rod {
  /* len per element and rad per node (the arm's rest geometry); mass is the rod's whole budget, else density sets it.
     A fixed root makes node 0 and the root frame kinematic, set by setRoot; a free one leaves the whole rod loose. */
  constructor({ len, rad, mass = null, fixedRoot = true }, knobs = ROD_KNOBS) {
    const n = this.n = len.length, N = n + 1;
    if (!(n >= 1) || rad.length !== N) throw new Error(`rod: ${n} elements need ${N} radii, got ${rad.length}`);
    for (const v of [...len, ...rad]) if (!(v > 0) || !Number.isFinite(v)) throw new Error(`rod: lengths and radii must be positive, got ${v}`);
    this.knobs = knobs;
    this.mass = mass;
    this.fixedRoot = fixedRoot;
    this.len0 = Float64Array.from(len);
    this.rad0 = Float64Array.from(rad);
    this.lam = new Float64Array(n).fill(1);
    this.bendScale = new Float64Array(n).fill(1);    // per joint: a braced stretch of arm is stiffer, a relaxed one softer
    this.stretchScale = new Float64Array(n).fill(1);
    this.rest = new Float64Array(4 * n);
    for (let j = 0; j < n; j++) this.rest[4 * j + 3] = 1;
    this.x = new Float64Array(3 * N); this.v = new Float64Array(3 * N); this.p = new Float64Array(3 * N);
    this.ext = new Float64Array(3 * N);              // newtons per node, set by the caller and kept until changed
    this.q = new Float64Array(4 * n); this.qp = new Float64Array(4 * n); this.om = new Float64Array(3 * n);
    this.mN = new Float64Array(N); this.maE = new Float64Array(n); this.J1 = new Float64Array(n); this.rE = new Float64Array(n);
    this.GA = new Float64Array(n); this.EA = new Float64Array(n); this.EIv = new Float64Array(n); this.GJv = new Float64Array(n); this.lv = new Float64Array(n);
    this.Wp = new Float64Array(9 * N); this.Wt = new Float64Array(9 * n); this.mPerp = new Float64Array(N);
    this.Mp = new Float64Array(9 * N); this._mOld = false;
    this.aPerp = new Float64Array(N); this.bPerp = new Float64Array(N); this.aPar = new Float64Array(N); this.tN = new Float64Array(3 * N);
    this.tE = new Float64Array(3 * n); this.lE = new Float64Array(n);
    this.lamS = new Float64Array(3 * n); this.lamB = new Float64Array(3 * n); this.on = new Uint8Array(n);
    this.D = new Float64Array(36 * n); this.E = new Float64Array(36 * n); this.L = new Float64Array(36 * n); this.Z = new Float64Array(36 * n);
    this.b = new Float64Array(6 * n); this.dl = new Float64Array(6 * n); this.dP = new Float64Array(3 * N); this.dT = new Float64Array(3 * n);
    this.d3 = new Float64Array(3 * n); this.ll = new Float64Array(n); this.A = new Float64Array(9 * n); this.alS = new Float64Array(9 * n);
    this.root0 = [0, 0, 0]; this.root1 = [0, 0, 0];
    this.qr0 = [0, 0, 0, 1]; this.qr1 = [0, 0, 0, 1]; this.qg = new Float64Array([0, 0, 0, 1]);
    this.rootForce = [0, 0, 0];   // N the rod puts on its mount, with node 0's own weight and any force put on it
    this.rootTorque = [0, 0, 0];  // N·m about node 0
    this._k = new Float64Array(9); this._t1 = new Float64Array(9); this._t2 = new Float64Array(9); this._t3 = new Float64Array(9);
    this._u6 = new Float64Array(6); this._v6 = new Float64Array(6); this._amb = [0, 0, 0];
    this.configure();
    this.poseFromRest();
  }

  /* Masses, inertias, and stiffnesses from the rest geometry and the knobs; cheap enough to rerun when a knob moves. */
  configure() {
    const k = this.knobs, n = this.n, l0 = this.len0, r0 = this.rad0;
    this._sig = [k.E0, k.tipStiff, k.shearFactor, k.density, k.addedMass, this.mass];
    let vol = 0, L = 0;
    for (let j = 0; j < n; j++) { const r = this.rE[j] = 0.5 * (r0[j] + r0[j + 1]); vol += Math.PI * r * r * l0[j]; L += l0[j]; }
    const rho = this.mass > 0 ? this.mass / vol : k.density, rhoW = SEAWATER.rho;
    this.rho = rho;
    this.mN.fill(0);
    const EIe = this._EIe ??= new Float64Array(n), GJe = this._GJe ??= new Float64Array(n);
    let s = 0;
    for (let j = 0; j < n; j++) {
      const r = this.rE[j], A = Math.PI * r * r, I = Math.PI * r ** 4 / 4, m = rho * A * l0[j];
      // Incompressible tissue: G = E/3.
      const E = k.E0 * Math.pow(k.tipStiff, (s + l0[j] / 2) / L), G = E / 3;
      s += l0[j];
      this.mN[j] += m / 2; this.mN[j + 1] += m / 2;
      this.maE[j] = Math.max(0, k.addedMass) * rhoW * A * l0[j];
      this.J1[j] = rho * I * l0[j];
      this.GA[j] = k.shearFactor * G * A; this.EA[j] = E * A;
      EIe[j] = E * I; GJe[j] = G * 2 * I;
    }
    // Joint j bends element j against the one before it (the root frame for j = 0), weighted by length as PyElastica does.
    this.EIv[0] = EIe[0]; this.GJv[0] = GJe[0]; this.lv[0] = l0[0];
    for (let j = 1; j < n; j++) {
      const a = l0[j - 1], c = l0[j];
      this.EIv[j] = (EIe[j - 1] * a + EIe[j] * c) / (a + c);
      this.GJv[j] = (GJe[j - 1] * a + GJe[j] * c) / (a + c);
      this.lv[j] = (a + c) / 2;
    }
  }

  /* Where the root goes by the end of the next step: a position and the frame quaternion (frameQuat of the arm's
     root frame). snap places it there now, for a first pose or a teleport. */
  setRoot(p, q, snap = false) {
    const ql = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!Number.isFinite(p[0] + p[1] + p[2]) || !(ql > 1e-6) || !Number.isFinite(ql)) return;
    const r1 = this.root1, q1 = this.qr1;
    r1[0] = p[0]; r1[1] = p[1]; r1[2] = p[2];
    const dot = q[0] * this.qr0[0] + q[1] * this.qr0[1] + q[2] * this.qr0[2] + q[3] * this.qr0[3], sg = (dot < 0 ? -1 : 1) / ql;
    q1[0] = sg * q[0]; q1[1] = sg * q[1]; q1[2] = sg * q[2]; q1[3] = sg * q[3];
    if (snap) {
      this.root0[0] = p[0]; this.root0[1] = p[1]; this.root0[2] = p[2];
      for (let i = 0; i < 4; i++) this.qr0[i] = this.qg[i] = q1[i];
      this.x[0] = p[0]; this.x[1] = p[1]; this.x[2] = p[2];
    }
  }

  /* The rest shape from an arm's bends (two per joint), twists (one per segment), and stretches (one per segment). */
  setRestFromBends(B, twist, lam) {
    const n = this.n;
    for (let j = 0; j < n; j++) jointQuat(B[2 * j], B[2 * j + 1], j > 0 && twist ? twist[j - 1] : 0, this.rest, 4 * j);
    // A stretch the solver cannot divide by is ignored; the arm's own stay within 0.8–1.8.
    if (lam) for (let j = 0; j < n; j++) if (lam[j] >= 0.05 && lam[j] <= 20) this.lam[j] = lam[j];
  }

  /* Lays the rod out along its rest shape from the root, at rest. */
  poseFromRest() {
    const n = this.n, x = this.x, q = this.q, R = this.rest, g = this.qg;
    let ax = g[0], ay = g[1], az = g[2], aw = g[3];
    x[0] = this.root0[0]; x[1] = this.root0[1]; x[2] = this.root0[2];
    for (let j = 0; j < n; j++) {
      const bx = R[4 * j], by = R[4 * j + 1], bz = R[4 * j + 2], bw = R[4 * j + 3];
      const nx = aw * bx + ax * bw + ay * bz - az * by, ny = aw * by - ax * bz + ay * bw + az * bx;
      const nz = aw * bz + ax * by - ay * bx + az * bw, nw = aw * bw - ax * bx - ay * by - az * bz;
      const il = 1 / Math.hypot(nx, ny, nz, nw);
      ax = nx * il; ay = ny * il; az = nz * il; aw = nw * il;
      q[4 * j] = ax; q[4 * j + 1] = ay; q[4 * j + 2] = az; q[4 * j + 3] = aw;
      const l = this.len0[j] * this.lam[j];
      x[3 * j + 3] = x[3 * j] + l * 2 * (ax * az + aw * ay);
      x[3 * j + 4] = x[3 * j + 1] + l * 2 * (ay * az - aw * ax);
      x[3 * j + 5] = x[3 * j + 2] + l * (1 - 2 * (ax * ax + ay * ay));
    }
    this.v.fill(0); this.om.fill(0);
    this.p.set(x); this.qp.set(q);
    this._mOld = false;
  }

  /* Element j's directors (d1, d2, d3) into out[0..8]; d3 runs along the arm, and d1, d2 carry the arm's u, v. */
  frame(j, out, o = 0) {
    const q = this.q, x = q[4 * j], y = q[4 * j + 1], z = q[4 * j + 2], w = q[4 * j + 3];
    out[o] = 1 - 2 * (y * y + z * z); out[o + 1] = 2 * (x * y + w * z); out[o + 2] = 2 * (x * z - w * y);
    out[o + 3] = 2 * (x * y - w * z); out[o + 4] = 1 - 2 * (x * x + z * z); out[o + 5] = 2 * (y * z + w * x);
    out[o + 6] = 2 * (x * z + w * y); out[o + 7] = 2 * (y * z - w * x); out[o + 8] = 1 - 2 * (x * x + y * y);
    return out;
  }

  /* A contact correction: node i moves by (dx, dy, dz) and keeps it as velocity over dt, so it does not push back in. */
  displace(i, dx, dy, dz, dt) {
    if (this.fixedRoot && i === 0) return;
    const x = this.x, v = this.v, inv = dt > 0 ? 1 / dt : 0;
    x[3 * i] += dx; x[3 * i + 1] += dy; x[3 * i + 2] += dz;
    v[3 * i] += dx * inv; v[3 * i + 1] += dy * inv; v[3 * i + 2] += dz * inv;
  }

  /* After corrections, turns each element by the smallest rotation that lays its d3 back along its segment. */
  alignFrames() {
    const n = this.n, x = this.x, q = this.q;
    for (let j = 0; j < n; j++) {
      let tx = x[3 * j + 3] - x[3 * j], ty = x[3 * j + 4] - x[3 * j + 1], tz = x[3 * j + 5] - x[3 * j + 2];
      const tl = Math.hypot(tx, ty, tz);
      if (!(tl > 1e-12)) continue;
      tx /= tl; ty /= tl; tz /= tl;
      const qx = q[4 * j], qy = q[4 * j + 1], qz = q[4 * j + 2], qw = q[4 * j + 3];
      const dx = 2 * (qx * qz + qw * qy), dy = 2 * (qy * qz - qw * qx), dz = 1 - 2 * (qx * qx + qy * qy);
      const c = dx * tx + dy * ty + dz * tz;
      // Past about 170° the turn has no clear axis; the element keeps its frame for the solver to sort out.
      if (c > 1 - 1e-12 || c < -0.985) continue;
      let rx = dy * tz - dz * ty, ry = dz * tx - dx * tz, rz = dx * ty - dy * tx, rw = 1 + c;
      const rl = Math.hypot(rx, ry, rz, rw);
      rx /= rl; ry /= rl; rz /= rl; rw /= rl;
      const nx = rw * qx + rx * qw + ry * qz - rz * qy, ny = rw * qy - rx * qz + ry * qw + rz * qx;
      const nz = rw * qz + rx * qy - ry * qx + rz * qw, nw = rw * qw - rx * qx - ry * qy - rz * qz;
      const il = 1 / Math.hypot(nx, ny, nz, nw);
      q[4 * j] = nx * il; q[4 * j + 1] = ny * il; q[4 * j + 2] = nz * il; q[4 * j + 3] = nw * il;
    }
  }

  /* Live radii per node from each segment's actual length, keeping its volume. */
  radii(out) {
    const n = this.n, x = this.x;
    const seg = (j) => Math.hypot(x[3 * j + 3] - x[3 * j], x[3 * j + 4] - x[3 * j + 1], x[3 * j + 5] - x[3 * j + 2]) / this.len0[j];
    for (let i = 0; i <= n; i++) {
      const e = i === 0 ? seg(0) : i === n ? seg(n - 1) : (seg(i - 1) + seg(i)) / 2;
      out[i] = this.rad0[i] / Math.sqrt(Math.max(0.1, e));
    }
    return out;
  }

  /* Advances dt; ambient(x, y, z, out) gives the water's velocity at a point, still water without it. */
  step(dt, ambient = null) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const k = this.knobs;
    const sg = this._sig;
    if (sg[0] !== k.E0 || sg[1] !== k.tipStiff || sg[2] !== k.shearFactor || sg[3] !== k.density || sg[4] !== k.addedMass || sg[5] !== this.mass) this.configure();
    // A root that moves or turns far in one tick (a fast drag) is followed in more substeps, up to a limit.
    let S = Math.max(1, Math.round(k.substeps) || 1);
    if (this.fixedRoot) {
      const r0 = this.root0, r1 = this.root1, a = this.qr0, b = this.qr1;
      const move = Math.hypot(r1[0] - r0[0], r1[1] - r0[1], r1[2] - r0[2]);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
      const cap = Math.max(S, Math.round(positive(k.maxSubsteps, ROD_KNOBS.maxSubsteps)));
      S = Math.min(cap, Math.max(S, Math.ceil(move / positive(k.rootStep, ROD_KNOBS.rootStep)), Math.ceil(ang / positive(k.rootTurn, ROD_KNOBS.rootTurn))));
    }
    const its = Math.max(1, Math.round(k.iterations) || 1), ds = dt / S, ds2 = ds * ds;
    const F = this.rootForce, T = this.rootTorque, lS = this.lamS, lB = this.lamB, A = this.A, ll = this.ll;
    let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
    for (let s = 0; s < S; s++) {
      if (this.fixedRoot) this._placeRoot((s + 1) / S);
      this._masses();
      this._forces(ds, ambient);
      this._predict(ds);
      lS.fill(0); lB.fill(0);
      // A step that had to be scaled down left the rod short of its constraints: a few more catch it up.
      for (let it = 0, extra = 0; it < its + extra; it++) if (this._newton(ds2) < 1 && extra < 3) extra++;
      this._finish(ds);
      if (!this.fixedRoot) continue;
      // The reaction on the mount is the constraints' generalized force on what holds still: node 0 and the root frame.
      fx -= lS[0] / (ll[0] * ds2); fy -= lS[1] / (ll[0] * ds2); fz -= lS[2] / (ll[0] * ds2);
      if (this.on[0]) {
        tx -= (A[0] * lB[0] + A[3] * lB[1] + A[6] * lB[2]) / ds2;
        ty -= (A[1] * lB[0] + A[4] * lB[1] + A[7] * lB[2]) / ds2;
        tz -= (A[2] * lB[0] + A[5] * lB[1] + A[8] * lB[2]) / ds2;
      }
    }
    for (let i = 0; i < 3; i++) { this.root0[i] = this.root1[i]; this.qr0[i] = this.qr1[i]; }
    this.qr0[3] = this.qr1[3];
    // A rod gone non-finite (a bad force from outside) starts over from its rest pose rather than poison the arm.
    if (!Number.isFinite(this.x[3 * this.n] + this.x[3 * this.n + 1] + this.x[3 * this.n + 2] + this.q[0] + this.q[4 * this.n - 1])) {
      if (this.fixedRoot) this._placeRoot(1);
      this.poseFromRest();
      this.resets = (this.resets ?? 0) + 1;
      fx = fy = fz = tx = ty = tz = 0;
    }
    // Node 0 is held, so what acts on it goes straight to the mount.
    const held = this.fixedRoot ? 1 : 0, e = this.ext;
    F[0] = fx / S + held * e[0]; F[1] = fy / S + held * (e[1] + k.weightFactor * this.mN[0] * k.gravity); F[2] = fz / S + held * e[2];
    T[0] = tx / S; T[1] = ty / S; T[2] = tz / S;
  }

  _placeRoot(t) {
    const r0 = this.root0, r1 = this.root1, a = this.qr0, b = this.qr1, g = this.qg, x = this.x;
    x[0] = r0[0] + (r1[0] - r0[0]) * t; x[1] = r0[1] + (r1[1] - r0[1]) * t; x[2] = r0[2] + (r1[2] - r0[2]) * t;
    let gx = a[0] + (b[0] - a[0]) * t, gy = a[1] + (b[1] - a[1]) * t, gz = a[2] + (b[2] - a[2]) * t, gw = a[3] + (b[3] - a[3]) * t;
    const il = 1 / (Math.hypot(gx, gy, gz, gw) || 1);
    g[0] = gx * il; g[1] = gy * il; g[2] = gz * il; g[3] = gw * il;
  }

  /* Each node's inverse mass, with the water dragged sideways by each element it touches along that element's own
     tangent, and each element's inverse inertia in the world (torsion twice the bending inertia); plus drag terms. */
  _masses() {
    const n = this.n, x = this.x, q = this.q, tE = this.tE, lE = this.lE, Wp = this.Wp, Wt = this.Wt, ma = this.maE;
    const k = this.knobs, rho = SEAWATER.rho, mu = SEAWATER.mu, cd = Math.max(0, k.cdCross), cf = Math.max(0, k.cfSkin);
    for (let e = 0; e < n; e++) {
      let dx = x[3 * e + 3] - x[3 * e], dy = x[3 * e + 4] - x[3 * e + 1], dz = x[3 * e + 5] - x[3 * e + 2];
      const l = Math.hypot(dx, dy, dz);
      lE[e] = l;
      if (l > 1e-12) { dx /= l; dy /= l; dz /= l; } else { dx = 0; dy = 0; dz = 1; }
      tE[3 * e] = dx; tE[3 * e + 1] = dy; tE[3 * e + 2] = dz;
    }
    for (let i = 0; i <= n; i++) {
      const o = 9 * i;
      if (this.fixedRoot && i === 0) { Wp.fill(0, o, o + 9); continue; }
      const m = this.mN[i];
      let a00 = m, a01 = 0, a02 = 0, a11 = m, a12 = 0, a22 = m, perp = m, ap = 0, bp = 0, apar = 0, nx = 0, ny = 0, nz = 0;
      for (let e = i - 1; e <= i; e++) {
        if (e < 0 || e >= n) continue;
        const c = ma[e] / 2, t0 = tE[3 * e], t1 = tE[3 * e + 1], t2 = tE[3 * e + 2], r = this.rE[e], l = lE[e];
        a00 += c * (1 - t0 * t0); a01 -= c * t0 * t1; a02 -= c * t0 * t2;
        a11 += c * (1 - t1 * t1); a12 -= c * t1 * t2; a22 += c * (1 - t2 * t2);
        perp += c;
        // Crossflow ½ρ·Cd·(2rl)·v² with Cd = cd + 24/Re (the tank's own law for blunt bodies), skin ½ρ·cf·(2πrl)·v².
        ap += 0.5 * rho * cd * r * l; bp += cd > 0 ? 6 * mu * l : 0; apar += 0.5 * Math.PI * rho * cf * r * l;
        nx += t0; ny += t1; nz += t2;
      }
      const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
      const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
      const det = a00 * c00 + a01 * c01 + a02 * c02, id = det > 0 ? 1 / det : 0;
      Wp[o] = c00 * id; Wp[o + 1] = c01 * id; Wp[o + 2] = c02 * id;
      Wp[o + 3] = c01 * id; Wp[o + 4] = c11 * id; Wp[o + 5] = c12 * id;
      Wp[o + 6] = c02 * id; Wp[o + 7] = c12 * id; Wp[o + 8] = c22 * id;
      // The water's share turns with the arm, so a node keeps its momentum, not its velocity: holding the velocity
      // while transverse mass swings to axial pumps energy in, and the arm wobbles out of its plane.
      const M = this.Mp, v = this.v;
      if (this._mOld) {
        const vx = v[3 * i], vy = v[3 * i + 1], vz = v[3 * i + 2];
        const px = M[o] * vx + M[o + 1] * vy + M[o + 2] * vz, py = M[o + 3] * vx + M[o + 4] * vy + M[o + 5] * vz, pz = M[o + 6] * vx + M[o + 7] * vy + M[o + 8] * vz;
        v[3 * i] = Wp[o] * px + Wp[o + 1] * py + Wp[o + 2] * pz;
        v[3 * i + 1] = Wp[o + 3] * px + Wp[o + 4] * py + Wp[o + 5] * pz;
        v[3 * i + 2] = Wp[o + 6] * px + Wp[o + 7] * py + Wp[o + 8] * pz;
      }
      M[o] = a00; M[o + 1] = a01; M[o + 2] = a02; M[o + 3] = a01; M[o + 4] = a11; M[o + 5] = a12; M[o + 6] = a02; M[o + 7] = a12; M[o + 8] = a22;
      const nl = Math.hypot(nx, ny, nz) || 1;
      this.tN[3 * i] = nx / nl; this.tN[3 * i + 1] = ny / nl; this.tN[3 * i + 2] = nz / nl;
      this.mPerp[i] = perp; this.aPerp[i] = ap; this.bPerp[i] = bp; this.aPar[i] = apar;
    }
    this._mOld = true;
    for (let j = 0; j < n; j++) {
      const qx = q[4 * j], qy = q[4 * j + 1], qz = q[4 * j + 2], qw = q[4 * j + 3], o = 9 * j, iJ = 1 / this.J1[j];
      const dx = 2 * (qx * qz + qw * qy), dy = 2 * (qy * qz - qw * qx), dz = 1 - 2 * (qx * qx + qy * qy);
      Wt[o] = iJ * (1 - 0.5 * dx * dx); Wt[o + 1] = -0.5 * iJ * dx * dy; Wt[o + 2] = -0.5 * iJ * dx * dz;
      Wt[o + 3] = Wt[o + 1]; Wt[o + 4] = iJ * (1 - 0.5 * dy * dy); Wt[o + 5] = -0.5 * iJ * dy * dz;
      Wt[o + 6] = Wt[o + 2]; Wt[o + 7] = Wt[o + 5]; Wt[o + 8] = iJ * (1 - 0.5 * dz * dz);
    }
  }

  /* External forces and net weight, then water drag on the velocity relative to the water: across and along each
     node's tangent on their own, each implicit in its speed so drag damps instead of overshooting and terminal speed is exact. */
  _forces(ds, ambient) {
    const n = this.n, x = this.x, v = this.v, ext = this.ext, Wp = this.Wp, k = this.knobs, u = this._amb, gy = k.weightFactor * k.gravity;
    const rho = SEAWATER.rho, mu = SEAWATER.mu, rt = this.rad0[n];
    for (let i = 0; i <= n; i++) {
      if (this.fixedRoot && i === 0) continue;
      const o = 9 * i, f0 = ext[3 * i], f1 = ext[3 * i + 1] + this.mN[i] * gy, f2 = ext[3 * i + 2];
      let vx = v[3 * i] + ds * (Wp[o] * f0 + Wp[o + 1] * f1 + Wp[o + 2] * f2);
      let vy = v[3 * i + 1] + ds * (Wp[o + 3] * f0 + Wp[o + 4] * f1 + Wp[o + 5] * f2);
      let vz = v[3 * i + 2] + ds * (Wp[o + 6] * f0 + Wp[o + 7] * f1 + Wp[o + 8] * f2);
      u[0] = u[1] = u[2] = 0;
      if (ambient) ambient(x[3 * i], x[3 * i + 1], x[3 * i + 2], u);
      const wx = vx - u[0], wy = vy - u[1], wz = vz - u[2], t0 = this.tN[3 * i], t1 = this.tN[3 * i + 1], t2 = this.tN[3 * i + 2];
      const wa = wx * t0 + wy * t1 + wz * t2;
      const px = wx - wa * t0, py = wy - wa * t1, pz = wz - wa * t2, pl = Math.hypot(px, py, pz);
      const mp = Math.max(1e-12, this.mPerp[i]), ma = Math.max(1e-12, this.mN[i]);
      const sp = pl > 0 ? slow(pl, ds * this.aPerp[i] / mp, ds * this.bPerp[i] / mp) / pl : 1;
      let qa = this.aPar[i], qb = 0;
      if (i === n && k.tipCap && wa > 0) {
        // White's sphere curve, its Stokes term written out so a creeping tip needs no 1/Re.
        const re = rho * wa * 2 * rt / mu;
        qa += 0.5 * rho * Math.PI * rt * rt * (6 / (1 + Math.sqrt(re)) + 0.4); qb = 6 * Math.PI * mu * rt;
      }
      const al = Math.abs(wa), sa = al > 0 ? Math.sign(wa) * slow(al, ds * qa / ma, ds * qb / ma) : 0;
      vx = u[0] + px * sp + sa * t0; vy = u[1] + py * sp + sa * t1; vz = u[2] + pz * sp + sa * t2;
      v[3 * i] = vx; v[3 * i + 1] = vy; v[3 * i + 2] = vz;
    }
  }

  _predict(ds) {
    const n = this.n, x = this.x, v = this.v, p = this.p, q = this.q, qp = this.qp, om = this.om;
    p[0] = x[0]; p[1] = x[1]; p[2] = x[2];
    for (let i = this.fixedRoot ? 1 : 0; i <= n; i++) for (let a = 0; a < 3; a++) p[3 * i + a] = x[3 * i + a] + ds * v[3 * i + a];
    for (let j = 0; j < n; j++) turn(q, 4 * j, 0.5 * ds * om[3 * j], 0.5 * ds * om[3 * j + 1], 0.5 * ds * om[3 * j + 2], qp, 4 * j);
  }

  /* One Newton step on every constraint at once. Group j holds stretch-shear j (nodes j, j+1 and element j) and
     bend-twist j (element j against the one before it, or the root frame), so the system is block tridiagonal. */
  _newton(ds2) {
    const n = this.n, p = this.p, qp = this.qp, D = this.D, E = this.E, b = this.b, d3 = this.d3, ll = this.ll, A = this.A, alS = this.alS;
    const Wp = this.Wp, Wt = this.Wt, lS = this.lamS, lB = this.lamB, on = this.on, R = this.rest, g = this.qg;
    const K = this._k, T1 = this._t1, T2 = this._t2, T3 = this._t3;
    for (let j = 0; j < n; j++) {
      const qx = qp[4 * j], qy = qp[4 * j + 1], qz = qp[4 * j + 2], qw = qp[4 * j + 3];
      const l = ll[j] = this.len0[j] * this.lam[j];
      const ex = 2 * (qx * qz + qw * qy), ey = 2 * (qy * qz - qw * qx), ez = 1 - 2 * (qx * qx + qy * qy);
      d3[3 * j] = ex; d3[3 * j + 1] = ey; d3[3 * j + 2] = ez;
      const gx = (p[3 * j + 3] - p[3 * j]) / l - ex, gy = (p[3 * j + 4] - p[3 * j + 1]) / l - ey, gz = (p[3 * j + 5] - p[3 * j + 2]) / l - ez;
      // Compliance is shear across the arm and stretch along it, so the world matrix turns with the element.
      const ss = this.stretchScale[j] * l * ds2, cs = 1 / (this.GA[j] * ss), ca = 1 / (this.EA[j] * ss), dc = ca - cs, o = 9 * j;
      alS[o] = cs + dc * ex * ex; alS[o + 1] = dc * ex * ey; alS[o + 2] = dc * ex * ez;
      alS[o + 3] = alS[o + 1]; alS[o + 4] = cs + dc * ey * ey; alS[o + 5] = dc * ey * ez;
      alS[o + 6] = alS[o + 2]; alS[o + 7] = alS[o + 5]; alS[o + 8] = cs + dc * ez * ez;
      const mx = lS[3 * j], my = lS[3 * j + 1], mz = lS[3 * j + 2];
      b[6 * j] = -(gx + alS[o] * mx + alS[o + 1] * my + alS[o + 2] * mz);
      b[6 * j + 1] = -(gy + alS[o + 3] * mx + alS[o + 4] * my + alS[o + 5] * mz);
      b[6 * j + 2] = -(gz + alS[o + 6] * mx + alS[o + 7] * my + alS[o + 8] * mz);
    }
    for (let j = 0; j < n; j++) {
      on[j] = j > 0 || this.fixedRoot ? 1 : 0;
      if (!on[j]) { b[6 * j + 3] = b[6 * j + 4] = b[6 * j + 5] = 0; continue; }
      const P = j > 0 ? qp : g, pa = j > 0 ? 4 * (j - 1) : 0;
      const ax = P[pa], ay = P[pa + 1], az = P[pa + 2], aw = P[pa + 3];
      const bx = qp[4 * j], by = qp[4 * j + 1], bz = qp[4 * j + 2], bw = qp[4 * j + 3];
      // r = conj(a)·b, the joint's rotation in a's frame
      const rx = aw * bx - ax * bw - ay * bz + az * by, ry = aw * by + ax * bz - ay * bw - az * bx;
      const rz = aw * bz - ax * by + ay * bx - az * bw, rw = aw * bw + ax * bx + ay * by + az * bz;
      const r0x = R[4 * j], r0y = R[4 * j + 1], r0z = R[4 * j + 2], r0w = R[4 * j + 3];
      // The rest rotation is ± a quaternion; the nearer sign by the full four-vector (the imaginary part alone flips cells).
      const dp = (rx - r0x) ** 2 + (ry - r0y) ** 2 + (rz - r0z) ** 2 + (rw - r0w) ** 2;
      const dm = (rx + r0x) ** 2 + (ry + r0y) ** 2 + (rz + r0z) ** 2 + (rw + r0w) ** 2, sg = dp <= dm ? 1 : -1;
      const ib = this.lv[j] / (4 * this.bendScale[j] * ds2), cb = ib / this.EIv[j], ct = ib / this.GJv[j];
      b[6 * j + 3] = -(rx - sg * r0x + cb * lB[3 * j]);
      b[6 * j + 4] = -(ry - sg * r0y + cb * lB[3 * j + 1]);
      b[6 * j + 5] = -(rz - sg * r0z + ct * lB[3 * j + 2]);
      // A = ½(rw·I − [r]×)·R_aᵀ; the rows of R_aᵀ are a's directors.
      const xx = ax * ax, yy = ay * ay, zz = az * az, xy = ax * ay, xz = ax * az, yz = ay * az, wx = aw * ax, wy = aw * ay, wz = aw * az;
      const R0 = 1 - 2 * (yy + zz), R1 = 2 * (xy + wz), R2 = 2 * (xz - wy);
      const R3 = 2 * (xy - wz), R4 = 1 - 2 * (xx + zz), R5 = 2 * (yz + wx);
      const R6 = 2 * (xz + wy), R7 = 2 * (yz - wx), R8 = 1 - 2 * (xx + yy), o = 9 * j;
      A[o] = 0.5 * (rw * R0 + rz * R3 - ry * R6); A[o + 1] = 0.5 * (rw * R1 + rz * R4 - ry * R7); A[o + 2] = 0.5 * (rw * R2 + rz * R5 - ry * R8);
      A[o + 3] = 0.5 * (-rz * R0 + rw * R3 + rx * R6); A[o + 4] = 0.5 * (-rz * R1 + rw * R4 + rx * R7); A[o + 5] = 0.5 * (-rz * R2 + rw * R5 + rx * R8);
      A[o + 6] = 0.5 * (ry * R0 - rx * R3 + rw * R6); A[o + 7] = 0.5 * (ry * R1 - rx * R4 + rw * R7); A[o + 8] = 0.5 * (ry * R2 - rx * R5 + rw * R8);
    }
    D.fill(0); E.fill(0);
    for (let j = 0; j < n; j++) {
      const o = 36 * j, l = ll[j], w = 1 / (l * l), pa = 9 * j, pb = 9 * j + 9, ta = 9 * j;
      crossMat(d3[3 * j], d3[3 * j + 1], d3[3 * j + 2], K);
      mm(K, 0, Wt, ta, T1, 0);              // T1 = [d3]×·Wθ
      mmt(T1, 0, K, 0, T2, 0);
      for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) {
        D[o + 6 * i + c] = (Wp[pa + 3 * i + c] + Wp[pb + 3 * i + c]) * w + T2[3 * i + c] + alS[ta + 3 * i + c];
      }
      if (on[j]) {
        mmt(T1, 0, A, 9 * j, T2, 0);         // stretch-shear against bend-twist, through element j
        put(D, o, 0, 3, T2, 0, 1); put(D, o, 3, 0, T2, 0, 1, true);
        for (let i = 0; i < 9; i++) T3[i] = Wt[ta + i] + (j > 0 ? Wt[ta - 9 + i] : 0);
        mm(A, 9 * j, T3, 0, T2, 0);
        mmt(T2, 0, A, 9 * j, T3, 0);
        put(D, o, 3, 3, T3, 0, 1);
        const ib = this.lv[j] / (4 * this.bendScale[j] * ds2);
        D[o + 21] += ib / this.EIv[j]; D[o + 28] += ib / this.EIv[j]; D[o + 35] += ib / this.GJv[j];
      } else { D[o + 21] = 1; D[o + 28] = 1; D[o + 35] = 1; }
      if (j === n - 1) continue;
      const e = o, w2 = 1 / (l * ll[j + 1]);
      for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) E[e + 6 * i + c] = -Wp[pb + 3 * i + c] * w2;
      mmt(T1, 0, A, 9 * j + 9, T2, 0);        // stretch-shear j against bend-twist j+1, through element j
      put(E, e, 0, 3, T2, 0, -1);
      if (on[j]) {
        mm(A, 9 * j, Wt, ta, T2, 0);
        mmt(T2, 0, A, 9 * j + 9, T3, 0);
        put(E, e, 3, 3, T3, 0, -1);
      }
    }
    this._solveBlocks();
    const dl = this.dl, dP = this.dP, dT = this.dT, turnMax = positive(this.knobs.stepTurn, ROD_KNOBS.stepTurn);
    // Damped Newton: far from its shape (a hard yank) a full step overshoots and the rod thrashes, so the whole step
    // shrinks until no element turns more than stepTurn and no node moves more than half a segment.
    let alpha = 1;
    for (let i = this.fixedRoot ? 1 : 0; i <= n; i++) {
      let gx = 0, gy = 0, gz = 0;
      if (i < n) { gx -= dl[6 * i] / ll[i]; gy -= dl[6 * i + 1] / ll[i]; gz -= dl[6 * i + 2] / ll[i]; }
      if (i > 0) { gx += dl[6 * i - 6] / ll[i - 1]; gy += dl[6 * i - 5] / ll[i - 1]; gz += dl[6 * i - 4] / ll[i - 1]; }
      const o = 9 * i;
      const mx = dP[3 * i] = Wp[o] * gx + Wp[o + 1] * gy + Wp[o + 2] * gz;
      const my = dP[3 * i + 1] = Wp[o + 3] * gx + Wp[o + 4] * gy + Wp[o + 5] * gz;
      const mz = dP[3 * i + 2] = Wp[o + 6] * gx + Wp[o + 7] * gy + Wp[o + 8] * gz;
      const reach = 0.5 * Math.min(i < n ? ll[i] : Infinity, i > 0 ? ll[i - 1] : Infinity), m = Math.hypot(mx, my, mz);
      if (m > reach) alpha = Math.min(alpha, reach / m);
    }
    for (let j = 0; j < n; j++) {
      const lx = dl[6 * j], ly = dl[6 * j + 1], lz = dl[6 * j + 2], dx = d3[3 * j], dy = d3[3 * j + 1], dz = d3[3 * j + 2];
      let tx = ly * dz - lz * dy, ty = lz * dx - lx * dz, tz = lx * dy - ly * dx;
      if (on[j]) {
        const a = 9 * j, bx = dl[6 * j + 3], by = dl[6 * j + 4], bz = dl[6 * j + 5];
        tx += A[a] * bx + A[a + 3] * by + A[a + 6] * bz; ty += A[a + 1] * bx + A[a + 4] * by + A[a + 7] * bz; tz += A[a + 2] * bx + A[a + 5] * by + A[a + 8] * bz;
      }
      if (j + 1 < n) {
        const a = 9 * j + 9, bx = dl[6 * j + 9], by = dl[6 * j + 10], bz = dl[6 * j + 11];
        tx -= A[a] * bx + A[a + 3] * by + A[a + 6] * bz; ty -= A[a + 1] * bx + A[a + 4] * by + A[a + 7] * bz; tz -= A[a + 2] * bx + A[a + 5] * by + A[a + 8] * bz;
      }
      const o = 9 * j;
      const wx = dT[3 * j] = Wt[o] * tx + Wt[o + 1] * ty + Wt[o + 2] * tz;
      const wy = dT[3 * j + 1] = Wt[o + 3] * tx + Wt[o + 4] * ty + Wt[o + 5] * tz;
      const wz = dT[3 * j + 2] = Wt[o + 6] * tx + Wt[o + 7] * ty + Wt[o + 8] * tz;
      const m = Math.hypot(wx, wy, wz);
      if (m > turnMax) alpha = Math.min(alpha, turnMax / m);
    }
    for (let j = 0; j < n; j++) {
      lS[3 * j] += alpha * dl[6 * j]; lS[3 * j + 1] += alpha * dl[6 * j + 1]; lS[3 * j + 2] += alpha * dl[6 * j + 2];
      if (on[j]) { lB[3 * j] += alpha * dl[6 * j + 3]; lB[3 * j + 1] += alpha * dl[6 * j + 4]; lB[3 * j + 2] += alpha * dl[6 * j + 5]; }
      turn(qp, 4 * j, 0.5 * alpha * dT[3 * j], 0.5 * alpha * dT[3 * j + 1], 0.5 * alpha * dT[3 * j + 2], qp, 4 * j);
    }
    for (let i = this.fixedRoot ? 1 : 0; i <= n; i++) {
      p[3 * i] += alpha * dP[3 * i]; p[3 * i + 1] += alpha * dP[3 * i + 1]; p[3 * i + 2] += alpha * dP[3 * i + 2];
    }
    return alpha;
  }

  /* The symmetric block-tridiagonal system (diagonal blocks D, upper blocks E) by block Thomas with a 6×6 Cholesky. */
  _solveBlocks() {
    const n = this.n, D = this.D, E = this.E, L = this.L, Z = this.Z, b = this.b, dl = this.dl, t = this._u6, y = this._v6;
    for (let j = 0; j < n; j++) {
      const o = 36 * j;
      for (let i = 0; i < 36; i++) L[o + i] = D[o + i];
      if (j > 0) {
        const e = 36 * (j - 1);
        for (let i = 0; i < 6; i++) for (let c = 0; c <= i; c++) {
          let s = 0;
          for (let m = 0; m < 6; m++) s += E[e + 6 * m + i] * Z[e + 6 * m + c];
          L[o + 6 * i + c] -= s;
        }
      }
      for (let i = 0; i < 6; i++) for (let c = 0; c <= i; c++) {
        let s = L[o + 6 * i + c];
        for (let m = 0; m < c; m++) s -= L[o + 6 * i + m] * L[o + 6 * c + m];
        if (i === c) L[o + 7 * i] = Math.sqrt(s > 1e-300 ? s : 1e-300);
        else L[o + 6 * i + c] = s / L[o + 7 * c];
      }
      for (let i = 0; i < 6; i++) {
        let s = b[6 * j + i];
        if (j > 0) { const e = 36 * (j - 1); for (let m = 0; m < 6; m++) s -= E[e + 6 * m + i] * dl[6 * j - 6 + m]; }
        y[i] = s;
      }
      this._chol(o, y, dl, 6 * j);
      if (j === n - 1) continue;
      const e = 36 * j;
      for (let c = 0; c < 6; c++) {
        for (let i = 0; i < 6; i++) {
          let s = E[e + 6 * i + c];
          for (let m = 0; m < i; m++) s -= L[o + 6 * i + m] * t[m];
          t[i] = s / L[o + 7 * i];
        }
        for (let i = 5; i >= 0; i--) {
          let s = t[i];
          for (let m = i + 1; m < 6; m++) s -= L[o + 6 * m + i] * Z[e + 6 * m + c];
          Z[e + 6 * i + c] = s / L[o + 7 * i];
        }
      }
    }
    for (let j = n - 2; j >= 0; j--) {
      const e = 36 * j;
      for (let i = 0; i < 6; i++) {
        let s = 0;
        for (let m = 0; m < 6; m++) s += Z[e + 6 * i + m] * dl[6 * j + 6 + m];
        dl[6 * j + i] -= s;
      }
    }
  }

  _chol(o, rhs, out, oo) {
    const L = this.L, t = this._u6;
    for (let i = 0; i < 6; i++) {
      let s = rhs[i];
      for (let m = 0; m < i; m++) s -= L[o + 6 * i + m] * t[m];
      t[i] = s / L[o + 7 * i];
    }
    for (let i = 5; i >= 0; i--) {
      let s = t[i];
      for (let m = i + 1; m < 6; m++) s -= L[o + 6 * m + i] * out[oo + m];
      out[oo + i] = s / L[o + 7 * i];
    }
  }

  _finish(ds) {
    const n = this.n, x = this.x, v = this.v, p = this.p, q = this.q, qp = this.qp, om = this.om, k = this.knobs;
    const decay = k.damp > 0 ? Math.exp(-k.damp * ds) : 1, vmax = k.maxSpeed, wmax = k.maxSpin;
    for (let i = 0; i <= n; i++) {
      let vx = (p[3 * i] - x[3 * i]) / ds, vy = (p[3 * i + 1] - x[3 * i + 1]) / ds, vz = (p[3 * i + 2] - x[3 * i + 2]) / ds;
      const sp = Math.hypot(vx, vy, vz), c = (sp > vmax ? vmax / sp : 1) * decay;
      v[3 * i] = vx * c; v[3 * i + 1] = vy * c; v[3 * i + 2] = vz * c;
      x[3 * i] = p[3 * i]; x[3 * i + 1] = p[3 * i + 1]; x[3 * i + 2] = p[3 * i + 2];
    }
    for (let j = 0; j < n; j++) {
      const ax = qp[4 * j], ay = qp[4 * j + 1], az = qp[4 * j + 2], aw = qp[4 * j + 3];
      const bx = -q[4 * j], by = -q[4 * j + 1], bz = -q[4 * j + 2], bw = q[4 * j + 3];
      const rx = aw * bx + ax * bw + ay * bz - az * by, ry = aw * by - ax * bz + ay * bw + az * bx, rz = aw * bz + ax * by - ay * bx + az * bw;
      // The exact turn between the two, matching the exact turns that made it.
      const rw = aw * bw - ax * bx - ay * by - az * bz, sl = Math.hypot(rx, ry, rz), sw = rw >= 0 ? 1 : -1;
      const g = (sl > 1e-12 ? 2 * Math.atan2(sl, Math.abs(rw)) / sl : 2) * sw / ds;
      let wx = rx * g, wy = ry * g, wz = rz * g;
      const wl = Math.hypot(wx, wy, wz), c = (wl > wmax ? wmax / wl : 1) * decay;
      om[3 * j] = wx * c; om[3 * j + 1] = wy * c; om[3 * j + 2] = wz * c;
      q[4 * j] = ax; q[4 * j + 1] = ay; q[4 * j + 2] = az; q[4 * j + 3] = aw;
    }
  }
}
