import { section } from './panel.js';

/* The panel's grabby seals, the stung-twice latch, and firm stations: their controls on the Arms tab, and readout lines
   for what each is doing. */

const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length] ?? list[0];

export class SuckerDiag {
  constructor(arms, { loco = null, name = (e) => arms.records._name(e) } = {}) {
    this.arms = arms;
    this.loco = loco;
    this.name = name;
    this._ends = 0;
    this._at = -1;
    this.rate = 0;
    this._controls();
  }

  _controls() {
    const A = this.arms, k = A.rodKnobs, L = A.reflexes.latchKnobs, seals = A._anyRod && !A.shadow, add = (a) => section('arms').add(a);
    add({ key: '0', name: 'Grabby seals', label: () => `Grabby: ${k.grabby ? 'on' : 'off'}${k.seals ? '' : ' (?loads=1)'}`, run: () => { k.grabby = !k.grabby; }, disabled: !seals });
    add({ key: '=', name: 'Seal beat', label: () => `Beat: ${k.sealBeat} s`, run: () => { k.sealBeat = cycle([0.25, 0.5, 1], k.sealBeat); k.sealBeatSd = k.sealBeat / 2; }, disabled: !seals });
    add({ key: '.', name: 'Draw in a beat', label: () => `Beat holds: ×${k.beatLift} draw`, run: () => { k.beatLift = cycle([1, 2, 3], k.beatLift); }, disabled: !seals });
    add({ key: '/', name: 'Seal rest', label: () => `Rest: ${k.sealRest} s`, run: () => { k.sealRest = cycle([0.1, 0.25, 0.5], k.sealRest); }, disabled: !seals });
    add({ key: '-', name: 'Pop stretch', label: () => `Pop at: ×${k.popStretch}`, run: () => { k.popStretch = cycle([1.3, 1.5, 1.8], k.popStretch); }, disabled: !seals });
    add({ key: '\\', name: 'Latch', label: () => `Latch: ${L.latch ? 'on' : 'off'}`, run: () => { L.latch = !L.latch; } });
    add({ key: ';', name: 'Stings to latch', label: () => `Latch after: ${L.stings} stings`, run: () => { L.stings = cycle([2, 3], L.stings); } });
    add({ key: "'", name: 'Latch hold', label: () => `Latch holds: ${L.hold} s`, run: () => { L.hold = cycle([20, 45, 90], L.hold); } });
    add({ key: '[', name: 'Berth', label: () => `Berth: ${Math.round(L.berth * 100)} cm`, run: () => { L.berth = cycle([0.03, 0.06, 0.1], L.berth); } });
    if (this.loco) {
      const lk = this.loco.knobs;
      add({ key: ']', name: 'Firm stations', label: () => `Stations: ${lk.stationFirm ? 'firm' : 'flicker'}`, run: () => { lk.stationFirm = !lk.stationFirm; } });
      add({ key: ',', name: 'Station slip', label: () => `Slip: ${Math.round(lk.stationSlip * 100)} cm`, run: () => { lk.stationSlip = cycle([0.15, 0.25, 0.4], lk.stationSlip); } });
    }
  }

  /* Readout lines: live seals, ends a second and the share of each reason, the worst stretch and the pops; the latch. */
  describe() {
    const A = this.arms, k = A.rodKnobs, lines = [], s = A.sealStats, E = A.sealEnds;
    if (A._anyRod && !A.shadow && k.seals) {
      let total = 0;
      for (const v of Object.values(E)) total += v;
      // A scenario's reset empties the tally, so the rate starts over rather than reading a negative count.
      if (total < this._ends) this._at = -1;
      if (this._at >= 0 && A.time > this._at) this.rate += ((total - this._ends) / (A.time - this._at) - this.rate) * 0.3;
      this._ends = total; this._at = A.time;
      const top = Object.entries(E).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([w, v]) => `${w} ${Math.round((v / Math.max(1, total)) * 100)}%`).join(', ');
      lines.push(`Seals    ${s.live} held   ${this.rate.toFixed(1)} let go/s (${top || '–'})   stretch ×${s.stretch.toFixed(2)}, max ×${s.stretchMax.toFixed(2)}   pops ${s.pops}${k.grabby ? '' : '   grabby off'}`);
      // Per arm: what it means (none, touch, firm), the budget its seals share, and what they bore through the last step.
      if (k.grace) {
        const tag = ['–', 't', 'F'], n = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(2));
        lines.push(`Grace    ${A.rods.map((r, a) => (r ? `${a}${tag[A.sealIntent[a]]} ${n(A.sealApplied[a])}/${n(A.sealBudget[a])}` : `${a} –`)).join('  ')}   N borne/budget`);
      } else lines.push('Grace    off: every seal at full strength');
    }
    const R = A.reflexes, list = R.latch.list(R._latchList ??= []), L = R.latchKnobs;
    const on = list.map((e) => { const m = R.latch.m.get(e); return `${this.name(e)} ${Math.max(0, L.hold - (A.time - m.last)).toFixed(0)} s`; });
    lines.push(`Latch    ${L.latch ? (on.length ? `keeping ${Math.round(L.berth * 100)} cm off ${on.join(', ')}` : 'none') : 'off'}   trips ${R.latch.trips}`);
    return lines;
  }
}
