import { section } from './panel.js';

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
    this.limpStiff = limp;
    this.limp = false;
    this._controls(name, view, holdLocked);
  }

  /* After the arms each tick. */
  tick() { for (let i = 0; i < this.slots.length; i++) rodStat(this.arms.arms[this.slots[i]], this.arms.rods[this.slots[i]], this.stats[i]); }

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
