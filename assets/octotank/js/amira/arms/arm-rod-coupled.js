import { Rod, ROD_KNOBS } from './arm-rod-core.js';

/* A rod whose root node and root frame ride a rigid body shared with other rods (her body), its stock substep split into
   phases rod-coupler-core.js drives. assemble() and stepLimit() are Rod._newton's, kept equal to it by the coupled-rod tests. */

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

function put(Blk, o, r0, c0, M, m, s, t = false) {
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) Blk[o + 6 * (r0 + i) + c0 + k] += s * (t ? M[m + 3 * k + i] : M[m + 3 * i + k]);
}

function crossMat(x, y, z, O) {
  O[0] = 0; O[1] = -z; O[2] = y;
  O[3] = z; O[4] = 0; O[5] = -x;
  O[6] = -y; O[7] = x; O[8] = 0;
}

/* q ← exp(h)·q into out at o, for the world rotation vector 2h. */
export function turn(q, qo, hx, hy, hz, out, o) {
  const a = Math.hypot(hx, hy, hz), s = a > 1e-12 ? Math.sin(a) / a : 1, c = Math.cos(a);
  const ex = hx * s, ey = hy * s, ez = hz * s, qx = q[qo], qy = q[qo + 1], qz = q[qo + 2], qw = q[qo + 3];
  const nx = c * qx + ex * qw + ey * qz - ez * qy, ny = c * qy - ex * qz + ey * qw + ez * qx;
  const nz = c * qz + ex * qy - ey * qx + ez * qw, nw = c * qw - ex * qx - ey * qy - ez * qz, il = 1 / Math.hypot(nx, ny, nz, nw);
  out[o] = nx * il; out[o + 1] = ny * il; out[o + 2] = nz * il; out[o + 3] = nw * il;
}

const positive = (v, d) => (v > 0 && Number.isFinite(v) ? v : d);

/* In-place Cholesky of the symmetric 6×6 at o (lower triangle), with the stock floor on the pivots. */
export function chol6(L, o) {
  for (let i = 0; i < 6; i++) for (let c = 0; c <= i; c++) {
    let s = L[o + 6 * i + c];
    for (let m = 0; m < c; m++) s -= L[o + 6 * i + m] * L[o + 6 * c + m];
    if (i === c) L[o + 7 * i] = Math.sqrt(s > 1e-300 ? s : 1e-300);
    else L[o + 6 * i + c] = s / L[o + 7 * c];
  }
}

/* x = (L Lᵀ)⁻¹ r for the factor at o; r read at ro with stride rs, x written at xo with stride xs, t six of scratch. */
export function cholSolve6(L, o, r, ro, rs, x, xo, xs, t) {
  for (let i = 0; i < 6; i++) {
    let s = r[ro + rs * i];
    for (let m = 0; m < i; m++) s -= L[o + 6 * i + m] * t[m];
    t[i] = s / L[o + 7 * i];
  }
  for (let i = 5; i >= 0; i--) {
    let s = t[i];
    for (let m = i + 1; m < 6; m++) s -= L[o + 6 * m + i] * x[xo + xs * m];
    x[xo + xs * i] = s / L[o + 7 * i];
  }
}

export class CoupledRod extends Rod {
  constructor(geom, knobs = ROD_KNOBS) {
    super({ ...geom, fixedRoot: true }, knobs);
    const n = this.n;
    this.Lh = new Float64Array(36 * n);  // Cholesky factor of each condensed pivot D̂_j
    this.Zh = new Float64Array(36 * n);  // D̂_{j+1}⁻¹ E_jᵀ
    this.bh = new Float64Array(6 * n);   // condensed right-hand side b̂_j
    this.dh = new Float64Array(6 * n);   // D̂_j⁻¹ b̂_j
    this.G = new Float64Array(36);       // group 0 against her (Δc, Δφ), row-major
    this.Y = new Float64Array(36);       // D̂_0⁻¹ G
    this.K = new Float64Array(36);       // Gᵀ D̂_0⁻¹ G: the whole rod's inertia felt at her body over one substep
    this.rb = new Float64Array(6);       // Gᵀ D̂_0⁻¹ b̂_0
    this.gl = new Float64Array(6);       // Gᵀ Δλ_0 as applied: impulse times ds into her
    this._t6 = new Float64Array(6); this._cm = new Float64Array(9);
    this.fAcc = [0, 0, 0]; this.tAcc = [0, 0, 0];
    this.alphaOwn = 1;
    this.failed = false;                 // non-finite this tick: the coupler stops counting it and it starts over
  }

  /* The whole rod carried rigidly until its root lies at (px, py, pz) in frame g (unit, signed against qg): positions and
     frames turn and move, velocities stay, so the carry strains nothing and moves no momentum. */
  carryTo(px, py, pz, g) {
    const x = this.x, q = this.q, n = this.n, gq = this.qg;
    const ax = g[0], ay = g[1], az = g[2], aw = g[3], bx = -gq[0], by = -gq[1], bz = -gq[2], bw = gq[3];
    const rx = aw * bx + ax * bw + ay * bz - az * by, ry = aw * by - ax * bz + ay * bw + az * bx;
    const rz = aw * bz + ax * by - ay * bx + az * bw, rw = aw * bw - ax * bx - ay * by - az * bz;
    const x0 = x[0], y0 = x[1], z0 = x[2];
    for (let i = 0; i <= n; i++) {
      const o = 3 * i, vx = x[o] - x0, vy = x[o + 1] - y0, vz = x[o + 2] - z0;
      const tx = 2 * (ry * vz - rz * vy), ty = 2 * (rz * vx - rx * vz), tz = 2 * (rx * vy - ry * vx);
      x[o] = px + vx + rw * tx + (ry * tz - rz * ty); x[o + 1] = py + vy + rw * ty + (rz * tx - rx * tz); x[o + 2] = pz + vz + rw * tz + (rx * ty - ry * tx);
    }
    for (let j = 0; j < n; j++) {
      const o = 4 * j, qx = q[o], qy = q[o + 1], qz = q[o + 2], qw = q[o + 3];
      const nx = rw * qx + rx * qw + ry * qz - rz * qy, ny = rw * qy - rx * qz + ry * qw + rz * qx;
      const nz = rw * qz + rx * qy - ry * qx + rz * qw, nw = rw * qw - rx * qx - ry * qy - rz * qz, il = 1 / Math.hypot(nx, ny, nz, nw);
      q[o] = nx * il; q[o + 1] = ny * il; q[o + 2] = nz * il; q[o + 3] = nw * il;
    }
    const gl = 1 / Math.hypot(ax, ay, az, aw);
    gq[0] = ax * gl; gq[1] = ay * gl; gq[2] = az * gl; gq[3] = aw * gl;
    this.p.set(x); this.qp.set(q);
  }

  /* Node 0 and the root frame where her body puts them now; the frame keeps its sign against the last one. */
  placeRoot(px, py, pz, g) {
    const x = this.x, p = this.p, q = this.qg;
    const s = g[0] * q[0] + g[1] * q[1] + g[2] * q[2] + g[3] * q[3] < 0 ? -1 : 1, il = s / Math.hypot(g[0], g[1], g[2], g[3]);
    q[0] = g[0] * il; q[1] = g[1] * il; q[2] = g[2] * il; q[3] = g[3] * il;
    x[0] = p[0] = px; x[1] = p[1] = py; x[2] = p[2] = pz;
  }

  beginTick() {
    const k = this.knobs, sg = this._sig;
    if (sg[0] !== k.E0 || sg[1] !== k.tipStiff || sg[2] !== k.shearFactor || sg[3] !== k.density || sg[4] !== k.addedMass || sg[5] !== this.mass) this.configure();
    this._sealing = this.nSeals > 0;
    if (this._sealing || this._sLive) this._sAcc.fill(0);
    this.fAcc[0] = this.fAcc[1] = this.fAcc[2] = 0; this.tAcc[0] = this.tAcc[1] = this.tAcc[2] = 0;
    this.failed = false;
  }

  /* The stock substep up to its Newton iterations, the root already placed at the substep's end. */
  beginSubstep(ds, ambient, t) {
    this._masses();
    this._forces(ds, ambient);
    this._predict(ds);
    if (this.nSeals) this._pin(t, ds * ds);
    this.lamS.fill(0); this.lamB.fill(0);
  }

  endSubstep(ds) {
    const ds2 = ds * ds, lS = this.lamS, lB = this.lamB, A = this.A, ll = this.ll, F = this.fAcc, T = this.tAcc;
    if (this.nSeals) this._held(ds2);
    this._finish(ds);
    F[0] -= lS[0] / (ll[0] * ds2); F[1] -= lS[1] / (ll[0] * ds2); F[2] -= lS[2] / (ll[0] * ds2);
    T[0] -= (A[0] * lB[0] + A[3] * lB[1] + A[6] * lB[2]) / ds2;
    T[1] -= (A[1] * lB[0] + A[4] * lB[1] + A[7] * lB[2]) / ds2;
    T[2] -= (A[2] * lB[0] + A[5] * lB[1] + A[8] * lB[2]) / ds2;
  }

  /* After S substeps: the averaged root wrench and seal forces as Rod.step reports them, and its fresh start when non-finite. */
  endTick(S) {
    const k = this.knobs, e = this.ext, F = this.rootForce, T = this.rootTorque, x = this.x, n = this.n;
    // Rod.step's own root bookkeeping, kept on the last good root so a rod handed back to it, or reset, starts from there.
    if (Number.isFinite(x[0] + x[1] + x[2] + this.qg[0] + this.qg[1] + this.qg[2] + this.qg[3])) {
      for (let i = 0; i < 3; i++) this.root0[i] = this.root1[i] = x[i];
      for (let i = 0; i < 4; i++) this.qr0[i] = this.qr1[i] = this.qg[i];
    } else this.failed = true;
    if (this.failed || !Number.isFinite(x[3 * n] + x[3 * n + 1] + x[3 * n + 2] + this.q[0] + this.q[4 * n - 1])) {
      this.failed = true;
      for (let i = 0; i < 4; i++) this.qg[i] = this.qr0[i];
      this.poseFromRest();
      this.resets = (this.resets ?? 0) + 1;
      for (let i = 0; i <= n; i++) if (this.unseal(i)) this.sealBroke[i] = 1;
      this._sAcc.fill(0);
      this.fAcc.fill(0); this.tAcc.fill(0);
    }
    F[0] = this.fAcc[0] / S + e[0]; F[1] = this.fAcc[1] / S + e[1] + k.weightFactor * this.mN[0] * k.gravity; F[2] = this.fAcc[2] / S + e[2];
    T[0] = this.tAcc[0] / S; T[1] = this.tAcc[1] / S; T[2] = this.tAcc[2] / S;
    if (this._sealing || this._sLive) {
      const a = this._sAcc, f = this.sF;
      for (let i = 0; i < a.length; i++) f[i] = a[i] / S;
      this.sA0.set(this.sA);
    }
    this._sLive = this._sealing;
  }

  /* Rod._newton up to its block solve: D, E, and b at the current iterate. */
  assemble(ds2) {
    const n = this.n, p = this.p, qp = this.qp, D = this.D, E = this.E, b = this.b, d3 = this.d3, ll = this.ll, A = this.A, alS = this.alS;
    const Wp = this.Wp, Wt = this.Wt, lS = this.lamS, lB = this.lamB, on = this.on, R = this.rest, g = this.qg;
    const K = this._k, T1 = this._t1, T2 = this._t2, T3 = this._t3;
    for (let j = 0; j < n; j++) {
      const qx = qp[4 * j], qy = qp[4 * j + 1], qz = qp[4 * j + 2], qw = qp[4 * j + 3];
      const l = ll[j] = this.len0[j] * this.lam[j];
      const ex = 2 * (qx * qz + qw * qy), ey = 2 * (qy * qz - qw * qx), ez = 1 - 2 * (qx * qx + qy * qy);
      d3[3 * j] = ex; d3[3 * j + 1] = ey; d3[3 * j + 2] = ez;
      const gx = (p[3 * j + 3] - p[3 * j]) / l - ex, gy = (p[3 * j + 4] - p[3 * j + 1]) / l - ey, gz = (p[3 * j + 5] - p[3 * j + 2]) / l - ez;
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
      on[j] = 1;
      const P = j > 0 ? qp : g, pa = j > 0 ? 4 * (j - 1) : 0;
      const ax = P[pa], ay = P[pa + 1], az = P[pa + 2], aw = P[pa + 3];
      const bx = qp[4 * j], by = qp[4 * j + 1], bz = qp[4 * j + 2], bw = qp[4 * j + 3];
      const rx = aw * bx - ax * bw - ay * bz + az * by, ry = aw * by + ax * bz - ay * bw - az * bx;
      const rz = aw * bz - ax * by + ay * bx - az * bw, rw = aw * bw + ax * bx + ay * by + az * bz;
      const r0x = R[4 * j], r0y = R[4 * j + 1], r0z = R[4 * j + 2], r0w = R[4 * j + 3];
      const dp = (rx - r0x) ** 2 + (ry - r0y) ** 2 + (rz - r0z) ** 2 + (rw - r0w) ** 2;
      const dm = (rx + r0x) ** 2 + (ry + r0y) ** 2 + (rz + r0z) ** 2 + (rw + r0w) ** 2, sg = dp <= dm ? 1 : -1;
      const ib = this.lv[j] / (4 * this.bendScale[j] * ds2), cb = ib / this.EIv[j], ct = ib / this.GJv[j];
      b[6 * j + 3] = -(rx - sg * r0x + cb * lB[3 * j]);
      b[6 * j + 4] = -(ry - sg * r0y + cb * lB[3 * j + 1]);
      b[6 * j + 5] = -(rz - sg * r0z + ct * lB[3 * j + 2]);
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
      mm(K, 0, Wt, ta, T1, 0);
      mmt(T1, 0, K, 0, T2, 0);
      for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) {
        D[o + 6 * i + c] = (Wp[pa + 3 * i + c] + Wp[pb + 3 * i + c]) * w + T2[3 * i + c] + alS[ta + 3 * i + c];
      }
      mmt(T1, 0, A, 9 * j, T2, 0);
      put(D, o, 0, 3, T2, 0, 1); put(D, o, 3, 0, T2, 0, 1, true);
      for (let i = 0; i < 9; i++) T3[i] = Wt[ta + i] + (j > 0 ? Wt[ta - 9 + i] : 0);
      mm(A, 9 * j, T3, 0, T2, 0);
      mmt(T2, 0, A, 9 * j, T3, 0);
      put(D, o, 3, 3, T3, 0, 1);
      const ib = this.lv[j] / (4 * this.bendScale[j] * ds2);
      D[o + 21] += ib / this.EIv[j]; D[o + 28] += ib / this.EIv[j]; D[o + 35] += ib / this.GJv[j];
      if (j === n - 1) continue;
      const e = o, w2 = 1 / (l * ll[j + 1]);
      for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) E[e + 6 * i + c] = -Wp[pb + 3 * i + c] * w2;
      mmt(T1, 0, A, 9 * j + 9, T2, 0);
      put(E, e, 0, 3, T2, 0, -1);
      mm(A, 9 * j, Wt, ta, T2, 0);
      mmt(T2, 0, A, 9 * j + 9, T3, 0);
      put(E, e, 3, 3, T3, 0, -1);
    }
  }

  /* Elimination from the tip toward the root, so group 0 is left holding the whole chain condensed onto its root:
     D̂_j = D_j − E_j D̂_{j+1}⁻¹ E_jᵀ, b̂_j = b_j − E_j D̂_{j+1}⁻¹ b̂_{j+1}. The same work as the stock root-first sweep. */
  condense() {
    const n = this.n, D = this.D, E = this.E, b = this.b, L = this.Lh, Z = this.Zh, bh = this.bh, dh = this.dh, t = this._t6;
    let o = 36 * (n - 1);
    for (let i = 0; i < 36; i++) L[o + i] = D[o + i];
    for (let i = 0; i < 6; i++) bh[6 * (n - 1) + i] = b[6 * (n - 1) + i];
    chol6(L, o);
    cholSolve6(L, o, bh, 6 * (n - 1), 1, dh, 6 * (n - 1), 1, t);
    for (let j = n - 2; j >= 0; j--) {
      const e = 36 * j, on = 36 * (j + 1);
      o = 36 * j;
      for (let c = 0; c < 6; c++) cholSolve6(L, on, E, e + 6 * c, 1, Z, e + c, 6, t);
      for (let i = 0; i < 6; i++) for (let c = 0; c <= i; c++) {
        let s = D[o + 6 * i + c];
        for (let m = 0; m < 6; m++) s -= E[e + 6 * i + m] * Z[e + 6 * m + c];
        L[o + 6 * i + c] = s;
      }
      for (let i = 0; i < 6; i++) {
        let s = b[6 * j + i];
        for (let m = 0; m < 6; m++) s -= E[e + 6 * i + m] * dh[6 * j + 6 + m];
        bh[6 * j + i] = s;
      }
      chol6(L, o);
      cholSolve6(L, o, bh, 6 * j, 1, dh, 6 * j, 1, t);
    }
  }

  /* Group 0 against her body: stretch-shear 0 sees node 0 move by Δc + Δφ × r and bend-twist 0 sees the root frame turn
     by Δφ, so G = [[−I/l, [r]×/l], [0, −A₀]], r from her center (cx, cy, cz) to node 0. */
  rootJacobian(cx, cy, cz) {
    const G = this.G, il = 1 / this.ll[0], x = this.p, A = this.A, C = this._cm;
    crossMat(x[0] - cx, x[1] - cy, x[2] - cz, C);
    G.fill(0);
    for (let i = 0; i < 3; i++) {
      G[6 * i + i] = -il;
      for (let k = 0; k < 3; k++) { G[6 * i + 3 + k] = il * C[3 * i + k]; G[6 * (3 + i) + 3 + k] = -A[3 * i + k]; }
    }
  }

  rootBlock() {
    const G = this.G, Y = this.Y, K = this.K, rb = this.rb, dh = this.dh, t = this._t6;
    for (let c = 0; c < 6; c++) cholSolve6(this.Lh, 0, G, c, 6, Y, c, 6, t);
    for (let i = 0; i < 6; i++) {
      for (let c = 0; c < 6; c++) {
        let s = 0;
        for (let m = 0; m < 6; m++) s += G[6 * m + i] * Y[6 * m + c];
        K[6 * i + c] = s;
      }
      let s = 0;
      for (let m = 0; m < 6; m++) s += G[6 * m + i] * dh[m];
      rb[i] = s;
    }
  }

  /* Δλ once her step dy is known (null: she cannot move): Δλ_0 = D̂_0⁻¹(b̂_0 − G dy), then Δλ_{j+1} = D̂_{j+1}⁻¹b̂_{j+1} − Z_j Δλ_j. */
  backsolve(dy) {
    const n = this.n, dl = this.dl, dh = this.dh, Z = this.Zh, Y = this.Y;
    for (let i = 0; i < 6; i++) {
      let s = dh[i];
      if (dy) for (let m = 0; m < 6; m++) s -= Y[6 * i + m] * dy[m];
      dl[i] = s;
    }
    for (let j = 0; j < n - 1; j++) {
      const e = 36 * j;
      for (let i = 0; i < 6; i++) {
        let s = dh[6 * j + 6 + i];
        for (let m = 0; m < 6; m++) s -= Z[e + 6 * i + m] * dl[6 * j + m];
        dl[6 * j + 6 + i] = s;
      }
    }
  }

  /* Rod._newton's damped-step limit for the current Δλ: fills dP and dT, returns the largest safe scale. */
  stepLimit() {
    const n = this.n, dl = this.dl, dP = this.dP, dT = this.dT, ll = this.ll, Wp = this.Wp, Wt = this.Wt, A = this.A, d3 = this.d3;
    const turnMax = positive(this.knobs.stepTurn, ROD_KNOBS.stepTurn);
    let alpha = 1;
    for (let i = 1; i <= n; i++) {
      let gx = 0, gy = 0, gz = 0;
      if (i < n) { gx -= dl[6 * i] / ll[i]; gy -= dl[6 * i + 1] / ll[i]; gz -= dl[6 * i + 2] / ll[i]; }
      gx += dl[6 * i - 6] / ll[i - 1]; gy += dl[6 * i - 5] / ll[i - 1]; gz += dl[6 * i - 4] / ll[i - 1];
      const o = 9 * i;
      const mx = dP[3 * i] = Wp[o] * gx + Wp[o + 1] * gy + Wp[o + 2] * gz;
      const my = dP[3 * i + 1] = Wp[o + 3] * gx + Wp[o + 4] * gy + Wp[o + 5] * gz;
      const mz = dP[3 * i + 2] = Wp[o + 6] * gx + Wp[o + 7] * gy + Wp[o + 8] * gz;
      const reach = 0.5 * Math.min(i < n ? ll[i] : Infinity, ll[i - 1]), m = Math.hypot(mx, my, mz);
      if (m > reach) alpha = Math.min(alpha, reach / m);
    }
    for (let j = 0; j < n; j++) {
      const lx = dl[6 * j], ly = dl[6 * j + 1], lz = dl[6 * j + 2], dx = d3[3 * j], dy = d3[3 * j + 1], dz = d3[3 * j + 2];
      let tx = ly * dz - lz * dy, ty = lz * dx - lx * dz, tz = lx * dy - ly * dx;
      let a = 9 * j, bx = dl[6 * j + 3], by = dl[6 * j + 4], bz = dl[6 * j + 5];
      tx += A[a] * bx + A[a + 3] * by + A[a + 6] * bz; ty += A[a + 1] * bx + A[a + 4] * by + A[a + 7] * bz; tz += A[a + 2] * bx + A[a + 5] * by + A[a + 8] * bz;
      if (j + 1 < n) {
        a = 9 * j + 9; bx = dl[6 * j + 9]; by = dl[6 * j + 10]; bz = dl[6 * j + 11];
        tx -= A[a] * bx + A[a + 3] * by + A[a + 6] * bz; ty -= A[a + 1] * bx + A[a + 4] * by + A[a + 7] * bz; tz -= A[a + 2] * bx + A[a + 5] * by + A[a + 8] * bz;
      }
      const o = 9 * j;
      const wx = dT[3 * j] = Wt[o] * tx + Wt[o + 1] * ty + Wt[o + 2] * tz;
      const wy = dT[3 * j + 1] = Wt[o + 3] * tx + Wt[o + 4] * ty + Wt[o + 5] * tz;
      const wz = dT[3 * j + 2] = Wt[o + 6] * tx + Wt[o + 7] * ty + Wt[o + 8] * tz;
      const m = Math.hypot(wx, wy, wz);
      if (m > turnMax) alpha = Math.min(alpha, turnMax / m);
    }
    return (this.alphaOwn = Number.isFinite(alpha) ? alpha : 0);
  }

  /* The step at scale alpha; gl gets Gᵀ(alpha Δλ_0), the impulse times ds this rod hands her. */
  apply(alpha) {
    const n = this.n, dl = this.dl, dP = this.dP, dT = this.dT, lS = this.lamS, lB = this.lamB, qp = this.qp, p = this.p, G = this.G, gl = this.gl;
    for (let j = 0; j < n; j++) {
      lS[3 * j] += alpha * dl[6 * j]; lS[3 * j + 1] += alpha * dl[6 * j + 1]; lS[3 * j + 2] += alpha * dl[6 * j + 2];
      lB[3 * j] += alpha * dl[6 * j + 3]; lB[3 * j + 1] += alpha * dl[6 * j + 4]; lB[3 * j + 2] += alpha * dl[6 * j + 5];
      turn(qp, 4 * j, 0.5 * alpha * dT[3 * j], 0.5 * alpha * dT[3 * j + 1], 0.5 * alpha * dT[3 * j + 2], qp, 4 * j);
    }
    for (let i = 1; i <= n; i++) {
      p[3 * i] += alpha * dP[3 * i]; p[3 * i + 1] += alpha * dP[3 * i + 1]; p[3 * i + 2] += alpha * dP[3 * i + 2];
    }
    for (let i = 0; i < 6; i++) {
      let s = 0;
      for (let m = 0; m < 6; m++) s += G[6 * m + i] * dl[m];
      gl[i] = alpha * s;
    }
  }

  /* A contact push-out of node i by d over h (0: a placement, no speed): d as position, and the impulse along d's direction
     n that stops the node's closing speed and no more, j = −(v·n)/(nᵀWn), leaving W n j. With added mass the impulse still points along n, never sideways. */
  pushOut(i, dx, dy, dz, h) {
    if (i === 0) return 0;
    const x = this.x, v = this.v, W = this.Wp, o = 3 * i, w = 9 * i, d = Math.hypot(dx, dy, dz);
    x[o] += dx; x[o + 1] += dy; x[o + 2] += dz;
    if (!(h > 0) || !(d > 0)) return 0;
    const nx = dx / d, ny = dy / d, nz = dz / d, vn = v[o] * nx + v[o + 1] * ny + v[o + 2] * nz;
    // Depth over h as speed would fling a node whose depth it did not cause (her skin, another arm, a correction), and
    // coupled, every fling reaches her and pumps her spin. A node already leaving keeps its speed.
    if (!(vn < 0)) return 0;
    const ax = W[w] * nx + W[w + 1] * ny + W[w + 2] * nz, ay = W[w + 3] * nx + W[w + 4] * ny + W[w + 5] * nz, az = W[w + 6] * nx + W[w + 7] * ny + W[w + 8] * nz;
    const den = nx * ax + ny * ay + nz * az;
    // Before its first step a node has no inverse mass yet; its closing speed is then simply taken away.
    if (!(den > 0)) { v[o] -= vn * nx; v[o + 1] -= vn * ny; v[o + 2] -= vn * nz; return 0; }
    const j = -vn / den;
    v[o] += ax * j; v[o + 1] += ay * j; v[o + 2] += az * j;
    return j;
  }

  /* Linear and angular momentum (about the world origin) of nodes 1..n and the elements' spins; node 0 is hers. */
  momentum(P, L) {
    const n = this.n, x = this.x, v = this.v, M = this.Mp, q = this.q, om = this.om;
    for (let i = 1; i <= n; i++) {
      const w = 9 * i, o = 3 * i;
      const px = M[w] * v[o] + M[w + 1] * v[o + 1] + M[w + 2] * v[o + 2];
      const py = M[w + 3] * v[o] + M[w + 4] * v[o + 1] + M[w + 5] * v[o + 2];
      const pz = M[w + 6] * v[o] + M[w + 7] * v[o + 1] + M[w + 8] * v[o + 2];
      P[0] += px; P[1] += py; P[2] += pz;
      L[0] += x[o + 1] * pz - x[o + 2] * py; L[1] += x[o + 2] * px - x[o] * pz; L[2] += x[o] * py - x[o + 1] * px;
    }
    for (let e = 0; e < n; e++) {
      const qx = q[4 * e], qy = q[4 * e + 1], qz = q[4 * e + 2], qw = q[4 * e + 3];
      const dx = 2 * (qx * qz + qw * qy), dy = 2 * (qy * qz - qw * qx), dz = 1 - 2 * (qx * qx + qy * qy);
      const wx = om[3 * e], wy = om[3 * e + 1], wz = om[3 * e + 2], dw = dx * wx + dy * wy + dz * wz, J = this.J1[e];
      L[0] += J * (wx + dx * dw); L[1] += J * (wy + dy * dw); L[2] += J * (wz + dz * dw);
    }
    return P;
  }
}
