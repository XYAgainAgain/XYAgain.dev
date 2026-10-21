import { section } from './panel.js';

export const WRENCH_WINDOW = 1800;

/* The rod arms' live numbers and controls, shared by the bench and her body: how far each rod lies from its arm's
   intent chain, what its root bears, its cost, and the panel's limp, ghost, rest, hold, current, reset, and sliders. */

/* One rod against its intent chain, into out: tip gap, shape error, root force and torque, motion, fastest node. */
export function rodStat(arm, rod, out) {
  const A = arm.X, B = rod.X, n = arm.n, v = rod.rod.v, t = (n - 1) * 3;
  let sum = 0, max = 0, vm = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(B[i * 3] - A[i * 3], B[i * 3 + 1] - A[i * 3 + 1], B[i * 3 + 2] - A[i * 3 + 2]);
    sum += d * d; if (d > max) max = d;
  }
  for (let i = 0; i < v.length; i += 3) vm = Math.max(vm, Math.hypot(v[i], v[i + 1], v[i + 2]));
  out.tipLag = Math.hypot(B[t] - A[t], B[t + 1] - A[t + 1], B[t + 2] - A[t + 2]);
  out.shapeRms = Math.sqrt(sum / n); out.shapeMax = max;
  out.rootN = Math.hypot(...rod.rod.rootForce); out.rootNm = Math.hypot(...rod.rod.rootTorque);
  out.kinetic = rod.kinetic();
  out.speedMax = vm;
  return out;
}

export class RodDiag {
  /* name: the panel section; view(): the ArmView once it exists; limp: the bending scale a limp rod takes;
     holdLocked: the hold source stays as it is (the bench's twin check needs it off). */
  constructor(arms, { name = 'rod', view = () => null, limp = 0.15, holdLocked = false } = {}) {
    this.arms = arms;
    this.slots = arms.rods.map((r, s) => (r ? s : -1)).filter((s) => s >= 0);
    this.stats = this.slots.map(() => ({ tipLag: 0, shapeRms: 0, shapeMax: 0, rootN: 0, rootNm: 0, kinetic: 0, speedMax: 0 }));
    // Each tick's root wrench, the rod's from its multipliers and the inverse-dynamics one off the intent chain (the
    // scout's c-lite), six components each in rootForce's sense: what the arm puts on its mount.
    this.wrench = this.slots.map((s) => ({ rod: new Float32Array(WRENCH_WINDOW * 6), id: new Float32Array(WRENCH_WINDOW * 6), n: 0, k: 0, P: null, P2: null, last: new Float64Array(12) }));
    this.limpStiff = limp;
    this.limp = false;
    this._controls(name, view, holdLocked);
  }

  /* After the arms each tick; the fixed step dt (none, no wrench). */
  tick(dt) {
    for (let i = 0; i < this.slots.length; i++) {
      const arm = this.arms.arms[this.slots[i]], rod = this.arms.rods[this.slots[i]];
      rodStat(arm, rod, this.stats[i]);
      if (dt > 0) this._wrench(this.wrench[i], arm, rod, dt);
    }
  }

  /* Σ(ext + m·g_eff − m·a) over the intent chain's points past the root, a from its last three poses on the rod's own
     masses, plus node 0's load and weight; drag and added mass left out, so its gap from the rod's is the water's share. */
  _wrench(W, arm, rod, dt) {
    const X = arm.X, r = rod.rod, m = r.mN, e = r.ext, k = this.arms.rodKnobs, gy = k.weightFactor * k.gravity, L = W.last;
    const ready = W.k >= 2 && rod.started;
    let fx = e[0], fy = e[1] + m[0] * gy, fz = e[2], tx = 0, ty = 0, tz = 0;
    if (ready) {
      const P = W.P, Q = W.P2, i2 = 1 / (dt * dt);
      for (let i = 1; i < arm.n; i++) {
        const o = i * 3;
        const gx = e[o] - m[i] * (X[o] - 2 * P[o] + Q[o]) * i2;
        const gyy = e[o + 1] + m[i] * gy - m[i] * (X[o + 1] - 2 * P[o + 1] + Q[o + 1]) * i2;
        const gz = e[o + 2] - m[i] * (X[o + 2] - 2 * P[o + 2] + Q[o + 2]) * i2;
        const rx = X[o] - X[0], ry = X[o + 1] - X[1], rz = X[o + 2] - X[2];
        fx += gx; fy += gyy; fz += gz;
        tx += ry * gz - rz * gyy; ty += rz * gx - rx * gz; tz += rx * gyy - ry * gx;
      }
    }
    (W.P2 ??= new Float64Array(X.length)).set(W.P ?? X);
    (W.P ??= new Float64Array(X.length)).set(X);
    W.k = rod.started ? W.k + 1 : 0;
    if (!ready) return;
    const F = r.rootForce, T = r.rootTorque, o = (W.n++ % WRENCH_WINDOW) * 6;
    L[0] = F[0]; L[1] = F[1]; L[2] = F[2]; L[3] = T[0]; L[4] = T[1]; L[5] = T[2];
    L[6] = fx; L[7] = fy; L[8] = fz; L[9] = tx; L[10] = ty; L[11] = tz;
    for (let c = 0; c < 6; c++) { W.rod[o + c] = L[c]; W.id[o + c] = L[6 + c]; }
  }

  setLimp(v) {
    this.limp = !!v;
    for (const s of this.slots) this.arms.rods[s].stiff = this.limp ? this.limpStiff : 1;
  }

  reset() { for (const s of this.slots) this.arms.rods[s].reset(); }

  /* The readout's rod lines; rootLabel names what each root hangs from, tail rides the cost line. */
  describe(rootLabel = 'Root', tail = '') {
    const A = this.arms, k = A.rodKnobs, rs = A.rodStats(), cm = (v) => (v * 100).toFixed(1), many = this.slots.length > 1;
    const lines = [`Rod      ${A.shadow ? 'shadow' : 'drive'}   E ${k.E0.toExponential(1)} Pa × ${k.tipStiff} at the tip   rest ${k.rest}   hold ${A.shadow ? 'its arm' : k.hold}${this.limp ? '   LIMP' : ''}`];
    this.slots.forEach((s, i) => {
      const st = this.stats[i], rod = A.rods[s], tag = many || rootLabel === 'Root' ? `arm ${rod.index}  ` : '';
      lines.push(`Lag      ${tag}tip ${cm(st.tipLag)} cm   shape rms ${cm(st.shapeRms)} cm, max ${cm(st.shapeMax)} cm   fastest ${st.speedMax.toFixed(2)} m/s${rod.mass ? `   ${Math.round(rod.mass * 1000)} g` : ''}`);
      lines.push(`${rootLabel.padEnd(9)}${tag}pull ${(st.rootN * 1000).toFixed(0)} mN   twist ${(st.rootNm * 1000).toFixed(1)} mN·m   motion ${(st.kinetic * 1000).toFixed(2)} mJ`);
      const L = this.wrench[i].last, idN = Math.hypot(L[6], L[7], L[8]), gap = Math.hypot(L[0] - L[6], L[1] - L[7], L[2] - L[8]);
      if (this.wrench[i].n) lines.push(`ID       ${tag}pull ${(idN * 1000).toFixed(0)} mN   twist ${(Math.hypot(L[9], L[10], L[11]) * 1000).toFixed(1)} mN·m   gap ${idN > 1e-6 ? Math.round(gap / idN * 100) : 0}%`);
    });
    lines.push(`Cost     rod ${rs.p50.toFixed(3)} ms p50, ${rs.p95.toFixed(3)} p95${tail}`);
    return lines;
  }

  _controls(name, view, holdLocked) {
    const A = this.arms, k = A.rodKnobs, on = this.slots.length > 0, add = (a) => section(name).add(a);
    add({ key: '5', name: 'Limp', label: () => (this.limp ? 'Limp: on' : 'Limp: off'), run: () => this.setLimp(!this.limp), disabled: !on });
    add({ key: 'o', name: 'Ghost', label: () => (view()?.ghost ? 'Ghost: shown' : 'Ghost: hidden'), run: () => { const v = view(); if (v) v.ghost = !v.ghost; }, disabled: !on });
    add({ key: 'k', name: 'Rest source', label: () => `Rest: ${k.rest}`, run: () => { k.rest = k.rest === 'bends' ? 'chain' : k.rest === 'chain' ? 'targets' : 'bends'; }, disabled: !on });
    add({ key: 'p', name: 'Contact hold', label: () => `Hold: ${A.shadow ? 'its arm' : k.hold}`, run: () => { k.hold = k.hold === 'rod' ? 'ghost' : k.hold === 'ghost' ? 'off' : 'rod'; }, disabled: !on || holdLocked || A.shadow });
    add({ key: 'u', name: 'Current', label: () => (k.current ? 'Current: on' : 'Current: off'), run: () => { k.current = !k.current; }, disabled: !on });
    add({ key: 'x', name: 'Reset the rod', label: () => 'Reset the rod', run: () => this.reset(), disabled: !on });
    if (!on) return;
    const sci = (v) => v.toExponential(1).replace('e+', 'e');
    const range = (label, values, get, set, fmt) => add({ type: 'range', name: label, values, get, set, label: () => `${label} ${fmt(get())}` });
    range('Stiffness', [3e4, 1e5, 2e5, 3e5, 5e5, 1e6, 2e6, 5e6], () => k.E0, (v) => { k.E0 = v; }, (v) => `${sci(v)} Pa`);
    range('Tip ×', [0.1, 0.25, 0.5, 1, 2, 4], () => k.tipStiff, (v) => { k.tipStiff = v; }, (v) => `${v}`);
    range('Weight', [0, 0.02, 0.04, 0.08, 0.15, 0.3], () => k.weightFactor, (v) => { k.weightFactor = v; }, (v) => `${Math.round(v * 100)}% g`);
    range('Added mass', [0, 0.5, 1], () => k.addedMass, (v) => { k.addedMass = v; }, (v) => `${v}`);
    range('Substeps', [1, 2, 3, 4], () => k.substeps, (v) => { k.substeps = v; }, (v) => `${v}`);
  }
}
