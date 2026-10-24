import { section } from './panel.js';

export const WRENCH_WINDOW = 1800;

/* The rod arms' live numbers and controls, shared by the bench and her body: how far each rod lies from its arm's
   intent chain, what its root bears, its cost, and the panel's limp, ghost, detail, rest, hold, current, aim, reset, and sliders. */

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

/* The shared solve's last tick: the rods in it (one-way among them), the push and twist it gave her, its substeps and
   iterations, the root gap her shell had opened since the tick before, and any rod it gave up on or handoff it refused. */
export function coupledLine(A) {
  const c = A.coupled;
  if (!A.coupling) return 'Into her shared solve off: each rod steps alone';
  if (!c) return 'Into her shared solve on, no rod joined this tick';
  let n = 0, one = 0;
  for (let a = 0; a < A.joined.length; a++) { n += A.joined[a]; one += A.oneWay[a]; }
  const dt = A.coupledDt > 0 ? A.coupledDt : 1, mN = (v) => (Math.hypot(v[0], v[1], v[2]) / dt * 1000);
  return `Into her ${n} rods, ${one} one-way   push ${mN(c.impulseP).toFixed(0)} mN   twist ${mN(c.impulseL).toFixed(1)} mN·m   S ${c.S}, ${c.iters} iters   gap ${(c.gap * 1000).toFixed(2)} mm, ${(c.gapTurn * 180 / Math.PI).toFixed(2)}°${c.failed ? `   FAILED ${c.failed}` : ''}${c.refused ? '   REFUSED' : ''}`;
}

/* Which of several stats is worst by f: its index, or -1 for none. */
export function worstOf(stats, f) {
  let best = -1;
  for (let i = 0; i < stats.length; i++) if (best < 0 || f(stats[i]) > f(stats[best])) best = i;
  return best;
}

export class RodDiag {
  /* name: the panel section; view(): the ArmView once it exists; limp: the bending scale a limp rod takes;
     holdLocked: the hold source stays as it is (the bench's twin check needs it off). */
  constructor(arms, { name = 'rod', view = () => null, limp = 0.15, holdLocked = false } = {}) {
    this.arms = arms;
    this.slots = arms.rods.map((r, s) => (r ? s : -1)).filter((s) => s >= 0);
    this.stats = this.slots.map(() => ({ tipLag: 0, shapeRms: 0, shapeMax: 0, rootN: 0, rootNm: 0, kinetic: 0, speedMax: 0 }));
    // Each tick's root wrench, the rod's from its multipliers and the inverse-dynamics one off the intent chain (the
    // scout's c-lite), six components each in rootForce's sense: what the arm puts on its mount. The windows are allocated once the first wrench is ready.
    this.wrench = this.slots.map(() => ({ rod: null, id: null, n: 0, k: 0, P: null, P2: null, last: new Float64Array(12) }));
    this.limpStiff = limp;
    this.limp = false;
    // With several rods the readout sums them up and details one: an index into slots.
    this.pick = 0;
    this._controls(name, view, holdLocked);
  }

  /* The bench calls this after the arms each tick, with the fixed step dt: the stats and the wrench window its checks read.
     On her body only describe() measures, at the readout's pace. */
  tick(dt) {
    if (!(dt > 0)) return;
    for (let i = 0; i < this.slots.length; i++) {
      const arm = this.arms.arms[this.slots[i]], rod = this.arms.rods[this.slots[i]];
      rodStat(arm, rod, this.stats[i]);
      this._wrench(this.wrench[i], arm, rod, dt);
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
    W.rod ??= new Float32Array(WRENCH_WINDOW * 6);
    W.id ??= new Float32Array(WRENCH_WINDOW * 6);
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

  /* The arm number shown in detail. */
  get picked() { return this.slots.length ? this.arms.rods[this.slots[this.pick % this.slots.length]].index : -1; }

  /* The readout's rod lines; rootLabel names what each root hangs from, tail rides the cost line. One rod gets its full
     lines; several get every tip's lag on one line, the worst of the rest, and the picked arm's full lines. */
  describe(rootLabel = 'Root', tail = '') {
    const A = this.arms, k = A.rodKnobs, rs = A.rodStats(), cm = (v) => (v * 100).toFixed(1), many = this.slots.length > 1, st = this.stats;
    // Measured now, at the readout's pace, rather than every tick on her body.
    this.slots.forEach((s, i) => rodStat(A.arms[s], A.rods[s], st[i]));
    const lines = [`Rod      ${many ? `${this.slots.length} arms, ` : ''}${A.shadow ? 'shadow' : 'drive'}   E ${k.E0.toExponential(1)} Pa × ${k.tipStiff} at the tip, braced +${k.braceGain}×   rest ${k.rest}   hold ${A.shadow ? 'its arm' : k.hold}${this.limp ? '   LIMP' : ''}`];
    if (many) {
      const arm = (i) => A.rods[this.slots[i]].index, sh = worstOf(st, (x) => x.shapeRms), sp = worstOf(st, (x) => x.speedMax), pu = worstOf(st, (x) => x.rootN);
      lines.push(`Tip lag  ${this.slots.map((s, i) => `${A.rods[s].index} ${cm(st[i].tipLag)}`).join('  ')} cm`);
      lines.push(`Worst    shape rms ${cm(st[sh].shapeRms)} cm (arm ${arm(sh)})   fastest ${st[sp].speedMax.toFixed(2)} m/s (arm ${arm(sp)})   pull ${(st[pu].rootN * 1000).toFixed(0)} mN (arm ${arm(pu)})   motion ${(st.reduce((s, x) => s + x.kinetic, 0) * 1000).toFixed(2)} mJ in all`);
    }
    if (A.canCouple) lines.push(coupledLine(A));
    for (const i of many ? [this.pick % this.slots.length] : this.slots.keys()) {
      const s = this.slots[i], x = st[i], rod = A.rods[s], tag = many || rootLabel === 'Root' ? `arm ${rod.index}  ` : '';
      lines.push(`Lag      ${tag}tip ${cm(x.tipLag)} cm   shape rms ${cm(x.shapeRms)} cm, max ${cm(x.shapeMax)} cm   fastest ${x.speedMax.toFixed(2)} m/s${rod.mass ? `   ${Math.round(rod.mass * 1000)} g` : ''}`);
      lines.push(`${rootLabel.padEnd(9)}${tag}pull ${(x.rootN * 1000).toFixed(0)} mN   twist ${(x.rootNm * 1000).toFixed(1)} mN·m   motion ${(x.kinetic * 1000).toFixed(2)} mJ`);
      const W = A.rootLoad.subarray(s * 6, s * 6 + 6);
      if (k.wrench && !A.shadow) lines.push(`Into her ${tag}pull ${(Math.hypot(W[0], W[1], W[2]) * 1000).toFixed(0)} mN   twist ${(Math.hypot(W[3], W[4], W[5]) * 1000).toFixed(1)} mN·m`);
      const L = this.wrench[i].last, idN = Math.hypot(L[6], L[7], L[8]), gap = Math.hypot(L[0] - L[6], L[1] - L[7], L[2] - L[8]);
      if (this.wrench[i].n) lines.push(`ID       ${tag}pull ${(idN * 1000).toFixed(0)} mN   twist ${(Math.hypot(L[9], L[10], L[11]) * 1000).toFixed(1)} mN·m   gap ${idN > 1e-6 ? Math.round(gap / idN * 100) : 0}%`);
    }
    lines.push(`Cost     rod${many ? 's' : ''} ${rs.p50.toFixed(3)} ms p50, ${rs.p95.toFixed(3)} p95${tail}`);
    return lines;
  }

  _controls(name, view, holdLocked) {
    const A = this.arms, k = A.rodKnobs, on = this.slots.length > 0, add = (a) => section(name).add(a);
    add({ key: '5', name: 'Limp', label: () => (this.limp ? 'Limp: on' : 'Limp: off'), run: () => this.setLimp(!this.limp), disabled: !on });
    add({ key: 'o', name: 'Ghost', label: () => (view()?.ghost ? 'Ghost: shown' : 'Ghost: hidden'), run: () => { const v = view(); if (v) v.ghost = !v.ghost; }, disabled: !on });
    if (this.slots.length > 1) add({ key: 'y', name: 'Rod in detail', label: () => `Detail: arm ${this.picked}`, run: () => { this.pick = (this.pick + 1) % this.slots.length; } });
    add({ key: 'k', name: 'Rest source', label: () => `Rest: ${k.rest}`, run: () => { k.rest = k.rest === 'bends' ? 'chain' : k.rest === 'chain' ? 'targets' : 'bends'; }, disabled: !on });
    add({ key: 'p', name: 'Contact hold', label: () => `Hold: ${A.shadow ? 'its arm' : k.hold}`, run: () => { k.hold = k.hold === 'rod' ? 'ghost' : k.hold === 'ghost' ? 'off' : 'rod'; }, disabled: !on || holdLocked || A.shadow });
    add({ key: 'u', name: 'Current', label: () => (k.current ? 'Current: on' : 'Current: off'), run: () => { k.current = !k.current; }, disabled: !on });
    add({ key: '9', name: 'Aim through the rod', label: () => (k.aim ? 'Aim: through the rod' : 'Aim: as posed'), run: () => { k.aim = !k.aim; }, disabled: !on || holdLocked || A.shadow });
    add({ key: 'x', name: 'Reset the rod', label: () => (this.slots.length > 1 ? 'Reset the rods' : 'Reset the rod'), run: () => this.reset(), disabled: !on });
    add({ key: '8', name: 'Shared solve', label: () => (A.coupling ? 'Shared solve: on' : 'Shared solve: off'), run: () => { A.coupling = !A.coupling; }, disabled: !A.canCouple });
    if (!on) return;
    const sci = (v) => v.toExponential(1).replace('e+', 'e');
    const range = (label, values, get, set, fmt) => add({ type: 'range', name: label, values, get, set, label: () => `${label} ${fmt(get())}` });
    range('Tissue', [3e4, 1e5, 2e5, 2.6e5, 5e5, 1e6, 2e6, 5e6], () => k.E0, (v) => { k.E0 = v; }, (v) => `${sci(v)} Pa`);
    range('Tip ×', [0.1, 0.25, 0.5, 1, 2, 4], () => k.tipStiff, (v) => { k.tipStiff = v; }, (v) => `${v}`);
    range('Bracing', [0, 1, 2, 4, 6, 8, 12, 16], () => k.braceGain, (v) => { k.braceGain = v; }, (v) => `+${v}×`);
    range('Reach brace', [0, 0.1, 0.25, 0.4, 0.6, 0.8, 1], () => k.reachBrace, (v) => { k.reachBrace = v; }, (v) => `${Math.round(v * 100)}%`);
    range('Firm-up', [0.05, 0.1, 0.25, 0.5, 1], () => k.grabTau, (v) => { k.grabTau = v; }, (v) => `${v} s`);
    range('Aim reach', [0, 0.02, 0.04, 0.08, 0.12], () => k.aimMax, (v) => { k.aimMax = v; }, (v) => `${Math.round(v * 100)} cm`);
    range('Aim pace', [0.1, 0.2, 0.3, 0.5, 1], () => k.aimTau, (v) => { k.aimTau = v; }, (v) => `${v} s`);
    range('Aim press', [0, 0.002, 0.004, 0.006, 0.01], () => k.aimPress, (v) => { k.aimPress = v; }, (v) => `${(v * 1000).toFixed(0)} mm`);
    range('Weight', [0, 0.02, 0.04, 0.08, 0.15, 0.3], () => k.weightFactor, (v) => { k.weightFactor = v; }, (v) => `${Math.round(v * 100)}% g`);
    range('Added mass', [0, 0.5, 1], () => k.addedMass, (v) => { k.addedMass = v; }, (v) => `${v}`);
    range('Substeps', [1, 2, 3, 4], () => k.substeps, (v) => { k.substeps = v; }, (v) => `${v}`);
  }
}
