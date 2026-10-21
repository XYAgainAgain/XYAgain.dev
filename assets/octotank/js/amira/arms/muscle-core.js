/* Chang et al. 2022, COOMM (Control Oriented Octopus Muscle Model), equations re-derived.
   Oplus winds negatively and gives positive right-handed twist; L0 curls toward the sucker side. */

export const GROUPS = 7;
export const MUSCLE_KNOBS = {
  transverse: 1.188373839738395, longitudinal: 0.0625, oblique: 0.0390625,
  longitudinalOffset: 0.625, obliqueOffset: 0.9375, winding: 3,
  obliqueArea: 0.0390625, k: 26, iterations: 10, relaxation: 0.55, warmRelaxation: 0.8, fallbackIterations: 256,
};
const finite = x => Number.isFinite(x) ? x : 0;
const clamp = x => Math.max(0, Math.min(1, finite(x)));
export function forceLength(x) {
  if (!(x >= 0) || x > 2) return 0;
  return Math.max(0, -6.44 + x * (18.01 + x * (-13.64 + 3.06 * x)));
}
function slope(x) { return forceLength(x) > 0 ? 18.01 + x * (-27.28 + 9.18 * x) : 0; }

export class MuscleArm {
  constructor({ len, rad }, knobs = MUSCLE_KNOBS) {
    const S = this.S = len.length;
    if (S < 2 || rad.length !== S + 1) throw new RangeError('Invalid muscle geometry');
    this.knobs = { ...MUSCLE_KNOBS, ...knobs };
    for (const key of ['transverse', 'longitudinal', 'oblique', 'longitudinalOffset', 'obliqueOffset', 'winding', 'k']) {
      if (!Number.isFinite(this.knobs[key]) || this.knobs[key] < 0) throw new RangeError('Invalid muscle gain');
    }
    if (!(this.knobs.iterations >= 1) || !Number.isFinite(this.knobs.iterations) || !(this.knobs.relaxation > 0 && this.knobs.relaxation <= 1) || !(this.knobs.warmRelaxation > 0 && this.knobs.warmRelaxation <= 1)) throw new RangeError('Invalid muscle solver');
    this.len = Float64Array.from(len); this.r = new Float64Array(S);
    this.area = new Float64Array(S); this.lv = new Float64Array(S); this.B = new Float64Array(S);
    this.dr = new Float64Array(S); this.hp = new Float64Array(S); this.hq = new Float64Array(S);
    this.ta = new Float64Array(S); this.tb = new Float64Array(S); this._weights = new Float64Array(4);
    this.restO = new Float64Array(S); this.restL = new Float64Array(S);
    this._a = new Float64Array(GROUPS * S);
    this._e = new Float64Array(S); this._bu = new Float64Array(S); this._bv = new Float64Array(S); this._t = new Float64Array(S);
    this._fu = new Float64Array(S); this._fv = new Float64Array(S); this._ft = new Float64Array(S); this._fe = new Float64Array(S);
    this._qu = new Float64Array(S); this._qv = new Float64Array(S); this._qt = new Float64Array(S);
    this._au = new Float64Array(S); this._av = new Float64Array(S); this._at = new Float64Array(S);
    this._cap = new Float64Array(S);
    this._we = new Float64Array(S); this._wqu = new Float64Array(S); this._wqv = new Float64Array(S); this._wqt = new Float64Array(S);
    this._warm = false; this._tol = new Float64Array(S);
    this._out = { lam: new Float64Array(S), bend: new Float64Array(2 * S), twist: new Float64Array(S), bendStiff: new Float64Array(S), axialStiff: new Float64Array(S) };
    let L = 0;
    for (let i = 0; i <= S; i++) if (!(rad[i] > 0) || !Number.isFinite(rad[i])) throw new RangeError('Invalid muscle radius');
    for (let i = 0; i < S; i++) {
      if (!(len[i] > 0) || !Number.isFinite(len[i])) throw new RangeError('Invalid muscle length');
      L += len[i]; this.r[i] = (rad[i] + rad[i + 1]) / 2;
      this.area[i] = Math.PI * this.r[i] ** 2;
      this._tol[i] = 4 * len[i] / (this.area[i] * this.r[i] * this.r[i]);
    }
    if (!Number.isFinite(L)) throw new RangeError('Invalid muscle length');
    const pitch = 2 * Math.PI * this.knobs.winding / L;
    for (let i = 1; i < S; i++) {
      this.lv[i] = (len[i - 1] + len[i]) / 2;
      this.B[i] = Math.PI / 4 * (this.r[i - 1] ** 4 * len[i - 1] + this.r[i] ** 4 * len[i]) / (len[i - 1] + len[i]);
    }
    for (let i = 0; i < S; i++) {
      let dr = 0, hp = 0, hq = 0;
      for (let side = -1; side <= 1; side += 2) {
        const j = i + side;
        if (j < 0 || j >= S) continue;
        const d = (len[i] + len[j]) / 2, ph = pitch * d;
        dr += 0.5 * side * (this.r[j] - this.r[i]) / d;
        hp += 0.5 * side * (this.r[j] * Math.cos(ph) - this.r[i]) / d;
        hq += 0.5 * this.r[j] * Math.sin(ph) / d;
        (side < 0 ? this.ta : this.tb)[i] = 0.25 * (this.r[i] + this.r[j] * Math.cos(ph));
      }
      this.dr[i] = dr; this.hp[i] = hp; this.hq[i] = hq;
      this.restL[i] = Math.sqrt(1 + (this.knobs.longitudinalOffset * dr) ** 2);
      this.restO[i] = Math.sqrt(1 + this.knobs.obliqueOffset ** 2 * (hp * hp + hq * hq));
    }
    this._a.fill(0); this._a.fill(1, S, 2 * S);
    this.equilibrium(this._a, [1, 0], this._out);
    for (let j = 1; j < S; j++) this._cap[j] = this._out.bend[2 * j];
    this._warm = false;
  }

  _oral(oral) {
    let u = finite(oral?.[0]), v = finite(oral?.[1]);
    const scale = Math.max(Math.abs(u), Math.abs(v));
    if (scale > 0) { u /= scale; v /= scale; const m = Math.hypot(u, v); u /= m; v /= m; }
    else { u = 0; v = 1; }
    this.cu = u; this.cv = v;
  }

  /* Muscle moments are segment-centered; the rod's couples live between segments. */
  _joints(e, qu, qv, qt, bu, bv, t) {
    const S = this.S, l = this.len;
    bu[0] = bv[0] = t[0] = 0;
    for (let j = 1; j < S; j++) {
      const ev = (e[j - 1] * l[j - 1] + e[j] * l[j]) / (l[j - 1] + l[j]);
      const f = ev * ev * ev / (2 * this.B[j]);
      bu[j] = f * (qu[j - 1] + qu[j]); bv[j] = f * (qv[j - 1] + qv[j]);
      t[j] = 1.5 * f * (qt[j - 1] + qt[j]);
    }
  }

  _forces(a, e, bu, bv, t, stiff) {
    const S = this.S, K = this.knobs, ru = this.cu, rv = this.cv;
    const lo = K.longitudinalOffset, gl = K.longitudinal, restL = this.restL;
    for (let i = 0; i < S; i++) {
      const E = e[i], root = Math.sqrt(E), r = this.r[i] / root, A = this.area[i] / E;
      const u = 0.5 * (bu[i] + (i + 1 < S ? bu[i + 1] : 0));
      const v = 0.5 * (bv[i] + (i + 1 < S ? bv[i + 1] : 0));
      const tw = 0.5 * (t[i] + (i + 1 < S ? t[i + 1] : 0));
      const x = u * ru + v * rv, y = -u * rv + v * ru;
      let f = a[i] ? -K.transverse * a[i] * forceLength(1 / root) : 0, qu = 0, qv = 0, qt = 0;
      let ds = stiff ? K.transverse * a[i] * slope(1 / root) / (2 * E * root) : 0, bs = 0;
      const p = lo * r, d = lo * this.dr[i] / (E * root), zt = p * tw;
      for (let k = 0; k < 4; k++) {
        const ac = a[(k + 1) * S + i];
        if (!ac) continue;
        const c = k === 0 ? 1 : k === 2 ? -1 : 0, s = k === 1 ? 1 : k === 3 ? -1 : 0;
        const b = c * x + s * y;
        const z = E - p * b;
        const m = Math.sqrt(z * z + d * d + zt * zt), h = m / restL[i];
        const w = forceLength(h), g = gl * ac, axial = g * w * z / m;
        f += axial; qu += p * A * axial * c; qv += p * A * axial * s;
        if (stiff) {
          const dz = 1 + p * b / (2 * E), dm = (z * dz - 1.5 * d * d / E - 0.5 * zt * zt / E) / m;
          ds += g * (slope(h) * dm * z / (this.restL[i] * m) + w * dz / m - w * z * dm / (m * m));
          bs += 4 * K.longitudinalOffset ** 2 / (E * E) * g * c * c * (slope(h) * z * z / (this.restL[i] * m * m) + w / m - w * z * z / (m * m * m));
        }
      }
      const op = K.obliqueOffset * r, od = K.obliqueOffset * this.hp[i] / (E * root);
      for (let k = 0; k < 2; k++) {
        const ac = a[(5 + k) * S + i];
        if (!ac) continue;
        const sign = k ? 1 : -1;
        const h = K.obliqueOffset * (t[i] * this.ta[i] + (i + 1 < S ? t[i + 1] * this.tb[i] : 0)) / root + sign * K.obliqueOffset * this.hq[i] / (E * root);
        const m = Math.sqrt(E * E + od * od + h * h), w = forceLength(m / this.restO[i]);
        const g = 4 * K.oblique * ac * w / m;
        f += g * E; qt -= op * A * g * h;
        if (stiff) {
          const dh = -h / (2 * E) - sign * K.obliqueOffset * this.hq[i] / (E * E * root);
          const dm = (E - 1.5 * od * od / E + h * dh) / m;
          ds += 4 * K.oblique * ac * (slope(m / this.restO[i]) * dm * E / (this.restO[i] * m) + w / m - w * E * dm / (m * m));
        }
      }
      this._fe[i] = 1 - f;
      this._fu[i] = qu * ru - qv * rv; this._fv[i] = qu * rv + qv * ru; this._ft[i] = qt;
      if (stiff) { stiff.axialStiff[i] = Math.max(0.01, (1 + ds) / E); this._au[i] = bs; }
    }
  }

  equilibrium(act, oral, out) {
    this._oral(oral);
    const S = this.S, a = this._a, e = this._e, bu = this._bu, bv = this._bv, t = this._t, K = this.knobs;
    let active = false;
    for (let i = 0; i < GROUPS * S; i++) { a[i] = clamp(act[i]); active ||= a[i] > 0; }
    // Starts from the last converged solve, kept apart because allocate reuses the working buffers; at rest a cold
    // start is exact, so it takes that instead.
    const warm = this._warm && active;
    if (warm) {
      e.set(this._we); this._qu.set(this._wqu); this._qv.set(this._wqv); this._qt.set(this._wqt);
      this._joints(e, this._qu, this._qv, this._qt, bu, bv, t);
    } else {
      e.fill(1); bu.fill(0); bv.fill(0); t.fill(0);
      this._qu.fill(0); this._qv.fill(0); this._qt.fill(0);
    }
    let converged = false;
    const fe = this._fe, fu = this._fu, fv = this._fv, ft = this._ft, qu = this._qu, qv = this._qv, qt = this._qt, tol = this._tol;
    for (let it = 0, n = Math.max(K.iterations, K.fallbackIterations); it < n; it++) {
      this._forces(a, e, bu, bv, t, null);
      let error = 0;
      const relax = it < K.iterations ? (warm ? K.warmRelaxation : K.relaxation) : 0.25;
      for (let i = 0; i < S; i++) {
        const E = e[i], de = Math.max(0.2, fe[i]) - E, du = fu[i] - qu[i], dv = fv[i] - qv[i], dt = ft[i] - qt[i];
        error = Math.max(error, Math.abs(de), E * E * E * tol[i] * Math.max(Math.abs(du), Math.abs(dv), 1.5 * Math.abs(dt)));
        e[i] = E + relax * de; qu[i] += relax * du; qv[i] += relax * dv; qt[i] += relax * dt;
      }
      this._joints(e, qu, qv, qt, bu, bv, t);
      if ((warm || it + 1 >= K.iterations) && error < 1e-4) { converged = true; break; }
    }
    // A NaN residual never passes the test above, so a converged state is always finite.
    this._warm = converged;
    if (converged) { this._we.set(e); this._wqu.set(this._qu); this._wqv.set(this._qv); this._wqt.set(this._qt); }
    this._forces(a, e, bu, bv, t, out);
    out.bend[0] = out.bend[1] = 0; out.bendStiff[0] = 1;
    for (let i = 0; i < S; i++) {
      out.lam[i] = e[i]; out.twist[i] = i + 1 < S ? t[i + 1] * this.lv[i + 1] : 0;
      if (i) {
        out.bend[2 * i] = bu[i] * this.lv[i]; out.bend[2 * i + 1] = bv[i] * this.lv[i];
        const ev = (e[i - 1] * this.len[i - 1] + e[i] * this.len[i]) / (this.len[i - 1] + this.len[i]);
        out.bendStiff[i] = 1 / (ev ** 3) + 0.5 * (this._au[i - 1] + this._au[i]);
      }
    }
    return out;
  }

  /* The alternating null mode is chosen nearest the smooth local moment, rather than seeded at an end. */
  _uncouple(nodes, out) {
    const S = this.S;
    out[0] = 0;
    for (let i = 1; i < S; i++) out[i] = 2 * nodes[i] - out[i - 1];
    let shift = 0;
    for (let i = 0; i < S; i++) {
      const near = i === 0 ? nodes[1] : i === S - 1 ? nodes[i] : 0.5 * (nodes[i] + nodes[i + 1]);
      shift += (i & 1 ? -1 : 1) * (near - out[i]);
    }
    shift /= S;
    for (let i = 0; i < S; i++) out[i] += i & 1 ? -shift : shift;
  }

  allocate(want, oral, act) {
    this._oral(oral);
    const S = this.S, K = this.knobs, e = this._e, bu = this._bu, bv = this._bv, t = this._t;
    act.fill(0); bu[0] = bv[0] = t[0] = 0;
    for (let i = 0; i < S; i++) e[i] = Number.isFinite(want.lam?.[i]) && want.lam[i] > 0 ? Math.max(0.5, Math.min(1.8, want.lam[i])) : 1;
    for (let j = 1; j < S; j++) {
      let u = finite(want.bend?.[2 * j]), v = finite(want.bend?.[2 * j + 1]);
      const size = Math.max(Math.abs(u), Math.abs(v));
      if (size > 1) { u /= size; v /= size; }
      const mag = Math.hypot(u, v), cap = this._cap[j] * (1 - 0.5 * (clamp(want.brace?.[j - 1]) + clamp(want.brace?.[j])));
      if (mag > cap) { u *= cap / mag; v *= cap / mag; }
      bu[j] = u / this.lv[j]; bv[j] = v / this.lv[j];
      t[j] = Math.max(-0.5, Math.min(0.5, finite(want.twist?.[j - 1]))) / this.lv[j];
      const ev = (e[j - 1] * this.len[j - 1] + e[j] * this.len[j]) / (this.len[j - 1] + this.len[j]);
      const f = this.B[j] / (ev ** 3);
      this._au[j] = bu[j] * f; this._av[j] = bv[j] * f; this._at[j] = t[j] * f / 1.5;
    }
    this._uncouple(this._au, this._qu); this._uncouple(this._av, this._qv); this._uncouple(this._at, this._qt);
    for (let i = 0; i < S; i++) {
      const E = e[i], root = Math.sqrt(E), A = this.area[i] / E, r = this.r[i] / root;
      const u = 0.5 * (bu[i] + (i + 1 < S ? bu[i + 1] : 0));
      const v = 0.5 * (bv[i] + (i + 1 < S ? bv[i + 1] : 0));
      const tw = 0.5 * (t[i] + (i + 1 < S ? t[i + 1] : 0));
      const x = u * this.cu + v * this.cv, y = -u * this.cv + v * this.cu;
      const p = K.longitudinalOffset * r, brace = clamp(want.brace?.[i]);
      const qx = (this._qu[i] * this.cu + this._qv[i] * this.cv) / Math.max(1e-30, p * A);
      const qy = (-this._qu[i] * this.cv + this._qv[i] * this.cu) / Math.max(1e-30, p * A);
      let axial = 0;
      for (let k = 0; k < 4; k++) {
        const c = k === 0 ? 1 : k === 2 ? -1 : 0, s = k === 1 ? 1 : k === 3 ? -1 : 0;
        const z = E - p * (c * x + s * y), d = K.longitudinalOffset * this.dr[i] / (E * root);
        const m = Math.sqrt(z * z + d * d + (p * tw) ** 2);
        this._weights[k] = K.longitudinal * forceLength(m / this.restL[i]) * z / m;
      }
      // Equal force on opposing sides avoids an unwanted bend when their force-length weights differ.
      const bx = brace * Math.min(this._weights[0], this._weights[2]), by = brace * Math.min(this._weights[1], this._weights[3]);
      const cx = qx >= 0 ? this._weights[0] - bx : this._weights[2] - bx, cy = qy >= 0 ? this._weights[1] - by : this._weights[3] - by;
      const scale = Math.min(1, cx / Math.max(1e-30, Math.abs(qx)), cy / Math.max(1e-30, Math.abs(qy)));
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? qx : k === 2 ? -qx : k === 1 ? qy : -qy;
        const force = (k & 1 ? by : bx) + Math.max(0, q) * Math.max(0, scale);
        const ac = clamp(force / Math.max(1e-30, this._weights[k]));
        act[(k + 1) * S + i] = ac; axial += ac * this._weights[k];
      }
      const op = K.obliqueOffset * r, od = K.obliqueOffset * this.hp[i] / (E * root);
      const group = this._qt[i] >= 0 ? 5 : 6, sign = group === 5 ? -1 : 1;
      const h = K.obliqueOffset * (t[i] * this.ta[i] + (i + 1 < S ? t[i + 1] * this.tb[i] : 0)) / root + sign * K.obliqueOffset * this.hq[i] / (E * root);
      const m = Math.sqrt(E * E + od * od + h * h), g = 4 * K.oblique * forceLength(m / this.restO[i]) / m;
      const ac = clamp(this._qt[i] / (-op * A * g * h || 1e-30));
      act[group * S + i] = ac; axial += ac * g * E;
      const need = E - 1 + axial;
      act[i] = clamp(need / Math.max(1e-30, K.transverse * forceLength(1 / root)));
      if (need < 0) {
        let add = -need / 4;
        for (let k = 0; k < 4; k++) add = Math.min(add, this._weights[k] * (1 - act[(k + 1) * S + i]));
        for (let k = 0; k < 4; k++) act[(k + 1) * S + i] = clamp(act[(k + 1) * S + i] + add / Math.max(1e-30, this._weights[k]));
      }
    }
    return act;
  }

  /* Full L0 with the other groups relaxed, not a stretch-conditioned global envelope. */
  authority(oral, out) {
    for (let j = 0; j < this.S; j++) out[j] = this._cap[j];
    return out;
  }
}
