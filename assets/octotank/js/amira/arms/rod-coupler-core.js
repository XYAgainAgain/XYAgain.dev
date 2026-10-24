import { ROD_KNOBS } from './arm-rod-core.js';
import { chol6, cholSolve6 } from './arm-rod-coupled.js';

/* Her body's six rigid degrees of freedom and every coupled rod in one step (plans/octotank/Shared-Solve-Plan.md), THREE-free.
   Each Newton iteration condenses each rod onto its root, solves her step once against her mass plus theirs, then finishes each rod. */

function qmul(a, b, out) {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
}

function qrot(q, x, y, z, out) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/* q ← exp(½h)·q for the world rotation vector h. */
function qturn(q, hx, hy, hz) {
  const a = 0.5 * Math.hypot(hx, hy, hz), s = a > 1e-14 ? Math.sin(a) / (2 * a) : 0.5, c = Math.cos(a);
  const x = hx * s, y = hy * s, z = hz * s;
  const nx = c * q[0] + x * q[3] + y * q[2] - z * q[1], ny = c * q[1] - x * q[2] + y * q[3] + z * q[0];
  const nz = c * q[2] + x * q[1] - y * q[0] + z * q[3], nw = c * q[3] - x * q[0] - y * q[1] - z * q[2], l = Math.hypot(nx, ny, nz, nw);
  q[0] = nx / l; q[1] = ny / l; q[2] = nz / l; q[3] = nw / l;
}

/* The world rotation vector of q, the short way round. */
function qlog(q, out) {
  const s = q[3] < 0 ? -1 : 1, x = s * q[0], y = s * q[1], z = s * q[2], vl = Math.hypot(x, y, z);
  const g = vl > 1e-14 ? (2 * Math.atan2(vl, s * q[3])) / vl : 2;
  out[0] = x * g; out[1] = y * g; out[2] = z * g;
  return out;
}

function inv3(A, O) {
  const a = A[0], b = A[1], c = A[2], d = A[3], e = A[4], f = A[5], g = A[6], h = A[7], i = A[8];
  const C0 = e * i - f * h, C1 = f * g - d * i, C2 = d * h - e * g, id = 1 / (a * C0 + b * C1 + c * C2);
  O[0] = C0 * id; O[1] = (c * h - b * i) * id; O[2] = (b * f - c * e) * id;
  O[3] = C1 * id; O[4] = (a * i - c * g) * id; O[5] = (c * d - a * f) * id;
  O[6] = C2 * id; O[7] = (b * g - a * h) * id; O[8] = (a * e - b * d) * id;
  return O;
}

/* R(q)·I0·R(q)ᵀ: an inertia carried through the turn q. */
const _R = new Float64Array(9);
function turnInertia(q, I0, out, T) {
  const x = q[0], y = q[1], z = q[2], w = q[3], R = _R;
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - w * z); R[2] = 2 * (x * z + w * y);
  R[3] = 2 * (x * y + w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - w * x);
  R[6] = 2 * (x * z - w * y); R[7] = 2 * (y * z + w * x); R[8] = 1 - 2 * (x * x + y * y);
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) T[3 * i + k] = R[3 * i] * I0[k] + R[3 * i + 1] * I0[3 + k] + R[3 * i + 2] * I0[6 + k];
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) out[3 * i + k] = T[3 * i] * R[3 * k] + T[3 * i + 1] * R[3 * k + 1] + T[3 * i + 2] * R[3 * k + 2];
  return out;
}

const mv3 = (A, x, y, z, out) => {
  out[0] = A[0] * x + A[1] * y + A[2] * z; out[1] = A[3] * x + A[4] * y + A[5] * z; out[2] = A[6] * x + A[7] * y + A[8] * z;
  return out;
};

export function newRigid() {
  return { M: 0, c: [0, 0, 0], v: [0, 0, 0], L: [0, 0, 0], I: new Float64Array(9), Ii: new Float64Array(9), w: [0, 0, 0] };
}

/* Her rigid state from her vertices: positions at posAt + i·stride and velocities at velAt + i·stride in H (the Jolt heap's
   layout), local to origin. Mass, center, velocity, angular momentum and inertia about the center, and the least-squares spin. */
export function rigidState(H, posAt, velAt, stride, n, mass, origin, out = newRigid()) {
  let M = 0, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < n; i++) {
    const p = posAt + i * stride, u = velAt + i * stride, m = mass[i];
    M += m; cx += m * H[p]; cy += m * H[p + 1]; cz += m * H[p + 2]; vx += m * H[u]; vy += m * H[u + 1]; vz += m * H[u + 2];
  }
  cx /= M; cy /= M; cz /= M; vx /= M; vy /= M; vz /= M;
  let lx = 0, ly = 0, lz = 0, xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < n; i++) {
    const p = posAt + i * stride, u = velAt + i * stride, m = mass[i];
    const rx = H[p] - cx, ry = H[p + 1] - cy, rz = H[p + 2] - cz, ux = H[u] - vx, uy = H[u + 1] - vy, uz = H[u + 2] - vz;
    lx += m * (ry * uz - rz * uy); ly += m * (rz * ux - rx * uz); lz += m * (rx * uy - ry * ux);
    xx += m * rx * rx; yy += m * ry * ry; zz += m * rz * rz; xy += m * rx * ry; xz += m * rx * rz; yz += m * ry * rz;
  }
  const I = out.I;
  I[0] = yy + zz; I[1] = -xy; I[2] = -xz; I[3] = -xy; I[4] = xx + zz; I[5] = -yz; I[6] = -xz; I[7] = -yz; I[8] = xx + yy;
  out.M = M;
  out.c[0] = cx + origin[0]; out.c[1] = cy + origin[1]; out.c[2] = cz + origin[2];
  out.v[0] = vx; out.v[1] = vy; out.v[2] = vz;
  out.L[0] = lx; out.L[1] = ly; out.L[2] = lz;
  inv3(I, out.Ii);
  mv3(out.Ii, lx, ly, lz, out.w);
  return out;
}

/* Every vertex gains dv + dw × (x − c), c in world; exact in momentum, M·dv and I·dw, and it strains no edge. */
export function addRigidVelocity(H, posAt, velAt, stride, n, origin, c, dv, dw) {
  const cx = c[0] - origin[0], cy = c[1] - origin[1], cz = c[2] - origin[2];
  for (let i = 0; i < n; i++) {
    const p = posAt + i * stride, u = velAt + i * stride, rx = H[p] - cx, ry = H[p + 1] - cy, rz = H[p + 2] - cz;
    H[u] += dv[0] + dw[1] * rz - dw[2] * ry; H[u + 1] += dv[1] + dw[2] * rx - dw[0] * rz; H[u + 2] += dv[2] + dw[0] * ry - dw[1] * rx;
  }
}

/* Momentum dP and angular momentum dL about her center, as a rigid field at her geometry now. */
const _dv = [0, 0, 0], _dw = [0, 0, 0];
export function addRigidMomentum(H, posAt, velAt, stride, n, mass, origin, dP, dL, s = newRigid()) {
  rigidState(H, posAt, velAt, stride, n, mass, origin, s);
  _dv[0] = dP[0] / s.M; _dv[1] = dP[1] / s.M; _dv[2] = dP[2] / s.M;
  addRigidVelocity(H, posAt, velAt, stride, n, origin, s.c, _dv, mv3(s.Ii, dL[0], dL[1], dL[2], _dw));
}

const finite6 = (a) => Number.isFinite(a[0] + a[1] + a[2] + a[3] + a[4] + a[5]);

export class RodCoupler {
  /* carry: each rod is carried rigidly onto her shell's root before the solve, so where her shell went other than the solve
     said (her springs, the sand, her skin's own motion) never drives the arm as a motor. */
  constructor({ carry = false } = {}) {
    this.carry = carry;
    // now: her velocity and spin change to write before Jolt steps, so its step lands her where the rods ended;
    // later: the momentum still owed, to add at the start of the next tick before her own forces.
    this.out = {
      dv: [0, 0, 0], dw: [0, 0, 0], dP: [0, 0, 0], dL: [0, 0, 0],
      impulseP: [0, 0, 0], impulseL: [0, 0, 0],
      S: 0, iters: 0, alphaMin: 1, gap: 0, gapTurn: 0, failed: 0, refused: false,
    };
    this._n = 0;
    this._Ab = new Float64Array(36); this._rb = new Float64Array(6); this._dy = new Float64Array(6); this._t6 = new Float64Array(6); this._sum = new Float64Array(6);
    this._Ip = new Float64Array(9); this._Iip = new Float64Array(9); this._T = new Float64Array(9); this._Is = new Float64Array(9); this._Iis = new Float64Array(9);
    this._Bs = new Float64Array(36); this._x6 = new Float64Array(6); this._ra = [0, 0, 0]; this._gc = [0, 0, 0, 1];
    this._o3 = [0, 0, 0]; this._g = [0, 0, 0, 1]; this._gr = [0, 0, 0, 1]; this._r = [0, 0, 0];
    this._cc = [0, 0, 0]; this._cp = [0, 0, 0]; this._dq = [0, 0, 0, 1]; this._dqp = [0, 0, 0, 1]; this._P = [0, 0, 0]; this._L = [0, 0, 0];
    this._vecs = [this.out.dv, this.out.dw, this.out.dP, this.out.dL, this.out.impulseP, this.out.impulseL];
  }

  _size(n) {
    if (n <= this._n) return;
    this._n = n;
    this._rs = new Float64Array(3 * n); this._re = new Float64Array(3 * n); this._gs = new Float64Array(4 * n); this._ge = new Float64Array(4 * n);
  }

  /* One tick. body: her rigidState as Jolt will start its step. list: { rod (a started CoupledRod), p and q (her shell's root
     and root frame now, world), oneWay (her spring drives this root: it rides her and never pushes back) }. ambient: the water.
     anchors: { n, x (3n, world), m (n, kg), K (1/s²), D (1/s) }, patches her springs hold toward the world (Mantle.springAnchors). */
  step(dt, body, list, ambient = null, anchors = null) {
    const out = this.out, na = list.length;
    for (const a of this._vecs) a[0] = a[1] = a[2] = 0;
    out.S = 0; out.iters = 0; out.alphaMin = 1; out.gap = 0; out.gapTurn = 0; out.failed = 0; out.refused = false;
    if (!na || !(dt > 0) || !(body.M > 0)) return out;
    this._size(na);
    const k = list[0].rod.knobs, rs = this._rs, re = this._re, gs = this._gs, ge = this._ge;
    const M = body.M, c0 = body.c, v0 = body.v, w0 = body.w, I0 = body.I;
    // Each root's path for the tick, relative to her center in her frame as it starts: from where its rod's root is to where
    // her shell holds it now, so her skin's own motion (and last tick's leftover) is a motor between her and the arm.
    let S = Math.max(1, Math.round(k.substeps) || 1);
    const cap = Math.max(S, Math.round(k.maxSubsteps > 0 ? k.maxSubsteps : ROD_KNOBS.maxSubsteps));
    const step0 = k.rootStep > 0 ? k.rootStep : ROD_KNOBS.rootStep, turn0 = k.rootTurn > 0 ? k.rootTurn : ROD_KNOBS.rootTurn, wl = Math.hypot(w0[0], w0[1], w0[2]);
    for (let a = 0; a < na; a++) {
      const { rod, p, q } = list[a], o = 3 * a, j = 4 * a, qg = rod.qg;
      for (let i = 0; i < 3; i++) { rs[o + i] = rod.x[i] - c0[i]; re[o + i] = p[i] - c0[i]; }
      const sg = q[0] * qg[0] + q[1] * qg[1] + q[2] * qg[2] + q[3] * qg[3] < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) { gs[j + i] = qg[i]; ge[j + i] = sg * q[i]; }
      const fx = dt * (v0[0] + w0[1] * re[o + 2] - w0[2] * re[o + 1]), fy = dt * (v0[1] + w0[2] * re[o] - w0[0] * re[o + 2]), fz = dt * (v0[2] + w0[0] * re[o + 1] - w0[1] * re[o]);
      const cq = Math.min(1, Math.abs(gs[j] * ge[j] + gs[j + 1] * ge[j + 1] + gs[j + 2] * ge[j + 2] + gs[j + 3] * ge[j + 3]));
      let ang = 2 * Math.acos(cq), move = Math.hypot(re[o] - rs[o] + fx, re[o + 1] - rs[o + 1] + fy, re[o + 2] - rs[o + 2] + fz);
      out.gap = Math.max(out.gap, Math.hypot(re[o] - rs[o], re[o + 1] - rs[o + 1], re[o + 2] - rs[o + 2])); out.gapTurn = Math.max(out.gapTurn, ang);
      // Carried, the root starts the tick on her shell and only her own motion moves it.
      if (this.carry) {
        const gc = this._gc;
        for (let i = 0; i < 4; i++) gc[i] = ge[j + i];
        rod.carryTo(p[0], p[1], p[2], gc);
        for (let i = 0; i < 3; i++) rs[o + i] = re[o + i];
        for (let i = 0; i < 4; i++) gs[j + i] = rod.qg[i];
        move = Math.hypot(fx, fy, fz); ang = 0;
      }
      S = Math.min(cap, Math.max(S, Math.ceil(move / step0), Math.ceil((ang + dt * wl) / turn0)));
    }
    out.S = S;
    const ds = dt / S, ds2 = ds * ds, its = Math.max(1, Math.round(k.iterations) || 1), turnMax = k.stepTurn > 0 ? k.stepTurn : ROD_KNOBS.stepTurn;
    const cc = this._cc, cp = this._cp, dq = this._dq, dqp = this._dqp, P = this._P, L = this._L;
    for (let i = 0; i < 3; i++) { cc[i] = c0[i]; P[i] = M * v0[i]; L[i] = body.L[i]; dq[i] = 0; }
    dq[3] = 1;
    const Ab = this._Ab, rb = this._rb, dy = this._dy, t6 = this._t6, sum = this._sum, o3 = this._o3, g = this._g, gr = this._gr, r3 = this._r;
    const Ip = this._Ip, Iip = this._Iip, Is = this._Is, Iis = this._Iis, T = this._T, Bs = this._Bs, x6 = this._x6, ra = this._ra;
    const nh = anchors && anchors.n > 0 && anchors.K >= 0 && anchors.D >= 0 ? anchors.n : 0;
    // A held patch is a damped spring on her over the substep, (K·ds² + D·ds)·m of stiffness at its point: inside the solve it
    // resists the arms' push now, where her own spring step would answer it a tick late and the two would pump each other.
    const hold = (kd) => {
      for (let h = 0; h < nh; h++) {
        const kk = anchors.m[h] * kd;
        if (!(kk > 0)) continue;
        qrot(dqp, anchors.x[3 * h] - c0[0], anchors.x[3 * h + 1] - c0[1], anchors.x[3 * h + 2] - c0[2], ra);
        const x = kk * ra[0], y = kk * ra[1], z = kk * ra[2], rr = ra[0] * ra[0] + ra[1] * ra[1] + ra[2] * ra[2];
        // k·JᵀJ for J = [I, −[r]×]: k on the linear block, −k[r]× and k[r]× across, k(|r|²I − r rᵀ) on the turning block.
        Bs[0] += kk; Bs[7] += kk; Bs[14] += kk;
        Bs[4] += z; Bs[5] -= y; Bs[9] -= z; Bs[11] += x; Bs[15] += y; Bs[16] -= x;
        Bs[19] -= z; Bs[20] += y; Bs[24] += z; Bs[26] -= x; Bs[30] -= y; Bs[31] += x;
        for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) Bs[6 * (3 + i) + 3 + c] += kk * ((i === c ? rr : 0) - ra[i] * ra[c]);
      }
    };
    const place = (t) => {
      for (let a = 0; a < na; a++) {
        const o = 3 * a, j = 4 * a;
        qrot(dqp, rs[o] + (re[o] - rs[o]) * t, rs[o + 1] + (re[o + 1] - rs[o + 1]) * t, rs[o + 2] + (re[o + 2] - rs[o + 2]) * t, o3);
        for (let i = 0; i < 4; i++) gr[i] = gs[j + i] + (ge[j + i] - gs[j + i]) * t;
        qmul(dqp, gr, g);
        list[a].rod.placeRoot(cp[0] + o3[0], cp[1] + o3[1], cp[2] + o3[2], g);
      }
    };
    for (let a = 0; a < na; a++) list[a].rod.beginTick();
    for (let s = 0; s < S; s++) {
      const t = (s + 1) / S;
      // Her free flight through the substep: spin from her momentum and the inertia she has now, so she turns as a body does.
      turnInertia(dq, I0, Is, T); inv3(Is, Iis);
      const w = mv3(Iis, L[0], L[1], L[2], r3);
      for (let i = 0; i < 3; i++) cp[i] = cc[i] + ds * P[i] / M;
      for (let i = 0; i < 4; i++) dqp[i] = dq[i];
      qturn(dqp, ds * w[0], ds * w[1], ds * w[2]);
      turnInertia(dqp, I0, Ip, T); inv3(Ip, Iip);
      place(t);
      for (let a = 0; a < na; a++) list[a].rod.beginSubstep(ds, ambient, t);
      for (let it = 0, extra = 0; it < its + extra; it++) {
        out.iters++;
        Ab.fill(0); rb.fill(0);
        Ab[0] = Ab[7] = Ab[14] = M;
        for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) Ab[6 * (3 + i) + 3 + c] = Ip[3 * i + c];
        if (nh) { Bs.set(Ab); hold(anchors.K * ds2 + anchors.D * ds); Ab.set(Bs); }
        let reach = Infinity;
        for (let a = 0; a < na; a++) {
          const rod = list[a].rod;
          if (rod.failed) continue;
          rod.assemble(ds2);
          rod.condense();
          rod.rootJacobian(cp[0], cp[1], cp[2]);
          rod.rootBlock();
          if (!finite6(rod.rb) || !Number.isFinite(rod.K[0] + rod.K[7] + rod.K[14] + rod.K[21] + rod.K[28] + rod.K[35])) { rod.failed = true; continue; }
          if (list[a].oneWay) continue;
          for (let i = 0; i < 36; i++) Ab[i] += rod.K[i];
          for (let i = 0; i < 6; i++) rb[i] += rod.rb[i];
          reach = Math.min(reach, 0.5 * rod.ll[0]);
        }
        chol6(Ab, 0);
        cholSolve6(Ab, 0, rb, 0, 1, dy, 0, 1, t6);
        if (!finite6(dy)) dy.fill(0);
        let amin = 1, short = false;
        for (let a = 0; a < na; a++) {
          const rod = list[a].rod;
          if (rod.failed) continue;
          rod.backsolve(dy);
          const al = rod.stepLimit();
          if (al < 1) short = true;
          if (!list[a].oneWay) amin = Math.min(amin, al);
        }
        // One scale for her and every two-way rod, inside her own limits too: no more than stepTurn of turn or half a root segment.
        const mv = Math.hypot(dy[0], dy[1], dy[2]), tr = Math.hypot(dy[3], dy[4], dy[5]);
        let alpha = amin;
        if (mv > reach) alpha = Math.min(alpha, reach / mv);
        if (tr > turnMax) alpha = Math.min(alpha, turnMax / tr);
        if (alpha < 1) short = true;
        sum.fill(0);
        for (let a = 0; a < na; a++) {
          const rod = list[a].rod, one = list[a].oneWay;
          if (rod.failed) continue;
          const al = one ? rod.alphaOwn : alpha;
          rod.apply(al);
          out.alphaMin = Math.min(out.alphaMin, al);
          if (one) continue;
          if (!finite6(rod.gl)) { rod.failed = true; continue; }
          for (let i = 0; i < 6; i++) sum[i] += rod.gl[i];
        }
        // Her step is what the applied multipliers push her by, and her momentum takes exactly that impulse; a held patch's
        // spring takes its share of the step to the world.
        for (let i = 0; i < 3; i++) { out.impulseP[i] += sum[i] / ds; out.impulseL[i] += sum[3 + i] / ds; }
        if (nh) {
          chol6(Bs, 0);
          cholSolve6(Bs, 0, sum, 0, 1, x6, 0, 1, t6);
          if (!finite6(x6)) x6.fill(0);
          const Iw = mv3(Ip, x6[3], x6[4], x6[5], r3);
          for (let i = 0; i < 3; i++) { cp[i] += x6[i]; P[i] += M * x6[i] / ds; L[i] += Iw[i] / ds; }
          qturn(dqp, x6[3], x6[4], x6[5]);
        } else {
          for (let i = 0; i < 3; i++) { cp[i] += sum[i] / M; P[i] += sum[i] / ds; L[i] += sum[3 + i] / ds; }
          const r = mv3(Iip, sum[3], sum[4], sum[5], r3);
          qturn(dqp, r[0], r[1], r[2]);
        }
        place(t);
        if (short && extra < 3) extra++;
      }
      for (let a = 0; a < na; a++) list[a].rod.endSubstep(ds);
      for (let i = 0; i < 3; i++) cc[i] = cp[i];
      for (let i = 0; i < 4; i++) dq[i] = dqp[i];
    }
    for (let a = 0; a < na; a++) { const rod = list[a].rod; if (rod.failed) out.failed++; rod.endTick(S); }
    // Jolt moves her by dt times the velocity it is given, and a stiff shell given a rigid spin ω turns by atan(dt·|ω|):
    // so these land her on the pose the rods ended on, and the momentum that leaves short is owed next tick.
    const th = qlog(dq, o3), tl = Math.hypot(th[0], th[1], th[2]), sw = tl > 1e-12 && tl < 1.2 ? Math.tan(tl) / (tl * dt) : 1 / dt;
    for (let i = 0; i < 3; i++) {
      const vh = (cc[i] - c0[i]) / dt, wh = th[i] * sw;
      out.dv[i] = vh - v0[i]; out.dw[i] = wh - w0[i]; out.dP[i] = P[i] - M * vh;
    }
    const Iw = mv3(I0, th[0] * sw, th[1] * sw, th[2] * sw, r3);
    for (let i = 0; i < 3; i++) out.dL[i] = L[i] - Iw[i];
    let sum12 = 0;
    for (let i = 0; i < 4; i++) sum12 += this._vecs[i][0] + this._vecs[i][1] + this._vecs[i][2];
    if (!Number.isFinite(sum12)) {
      for (let i = 0; i < 4; i++) this._vecs[i][0] = this._vecs[i][1] = this._vecs[i][2] = 0;
      out.refused = true;
    }
    return out;
  }
}
