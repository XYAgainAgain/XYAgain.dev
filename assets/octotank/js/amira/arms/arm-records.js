/* Each arm's state, its reason, and since when, plus a ring of recent events that collapses repeats. Pure observation:
   it reads the arms, their reflexes, the blocked tell, and locomotion's roles, and writes nothing but its own state. */

export const RECORD_SIZE = 64;
const WINDOW = 1800;

export class ArmRecords {
  constructor(arms) {
    this.arms = arms;
    const n = arms.arms.length;
    this.state = Array.from({ length: n }, () => ({ label: 'exploring', reason: null, since: 0 }));
    // Locomotion, when the page has one: its role names tell a stroke from a station. Arms holds no reference to it.
    this.loco = null;
    this.ring = Array.from({ length: RECORD_SIZE }, () => ({ t: 0, arm: -1, kind: '', text: '', count: 0, seq: 0 }));
    this.seq = 0;
    this._last = new Int32Array(n).fill(-1);   // ring slot of each arm's newest event, valid while its seq still matches
    this._lastSeq = new Float64Array(n);
    this._note = new Array(n).fill(null);      // the newest note since the last tick, for a label change's reason
    this._kind = new Array(n).fill(null);
    this._goal = new Array(n).fill(null);
    this._ep = new Array(n).fill(null);
    this.msBuf = new Float32Array(WINDOW);
    this.msCount = 0;
  }

  setLoco(loco) { this.loco = loco ?? null; }

  /* Logs an event for slot a; `text` may be a string or the thing it concerns (a toy, a rock), named here. */
  note(a, kind, text = '') {
    if (!(a >= 0 && a < this.state.length)) return;
    const s = typeof text === 'string' ? text : this._name(text);
    this._note[a] = s ? `${kind}: ${s}` : kind;
    this._log(a, kind, s);
  }

  tick(dt) {
    const t0 = performance.now(), A = this.arms, n = this.state.length, now = A.time;
    for (let a = 0; a < n; a++) {
      const g = A.arms[a].goal, kind = g ? g.kind : null, ep = A.episodes[a];
      if (ep && ep !== this._ep[a]) { this._note[a] ??= `touch: ${this._name(ep.toy)}`; this._log(a, 'touch', this._name(ep.toy)); }
      this._ep[a] = ep;
      const st = this.state[a], label = this._label(a, g, ep);
      if (label !== st.label) {
        const tier = A.owner[a];
        st.label = label; st.since = now; st.reason = this._note[a] ?? (tier && tier !== 'idle' ? tier : null);
        this._log(a, 'label', label);
      } else if (kind !== this._kind[a] || g !== this._goal[a]) this._log(a, 'goal', kind ?? 'none');
      this._kind[a] = kind; this._goal[a] = g; this._note[a] = null;
    }
    this.msBuf[this.msCount++ % WINDOW] = performance.now() - t0;
  }

  /* The fixed precedence: a recoil, then blocked or probing, then held, then the goal kind, then exploring. A recoil
     is any reflex state but calm, so the reflex machine's own names show through. */
  _label(a, g, ep) {
    const A = this.arms, r = A.reflexes?.state[a];
    if (r && r !== 'calm') return r;
    const b = A.blocked?.state[a];
    if (b) return b;
    if (ep?.h || A.owner[a] === 'held') return 'held';
    const role = this.loco?.state?.roles?.[a];
    if (g) {
      // A goal locomotion set is a foot: seeking the floor, pushing her along, or holding her where she is.
      if (g.loco) return role === 'planted' ? 'stroke' : role === 'station' || role === 'seek' ? role : g.kind === 'reach' ? 'seek' : g.kind;
      return g.kind;
    }
    return role === 'recover' ? 'recover' : 'exploring';
  }

  _name(e) {
    if (!e) return '';
    const i = this.arms.loose?.indexOf(e) ?? -1;
    return i >= 0 ? `${e.taste ?? e.tag} ${i}` : String(e.tag ?? e.taste ?? 'thing');
  }

  /* A repeat of this arm's newest event, while it is still in the ring, only counts up; `t` stays the first time. */
  _log(a, kind, text) {
    const R = this.ring, j = this._last[a];
    if (j >= 0) {
      const e = R[j];
      if (e.seq === this._lastSeq[a] && e.kind === kind && e.text === text) { e.count++; return; }
    }
    const slot = this.seq % RECORD_SIZE, e = R[slot];
    e.t = this.arms.time; e.arm = a; e.kind = kind; e.text = text; e.count = 1; e.seq = ++this.seq;
    this._last[a] = slot; this._lastSeq[a] = e.seq;
  }

  /* Up to `count` of the newest events, oldest first: slot a's alone, or every arm's with a < 0. These are the ring's
     own entries, rewritten as it wraps, so copy any you keep. */
  recent(a = -1, count = RECORD_SIZE) {
    const R = this.ring, out = [], have = Math.min(this.seq, RECORD_SIZE);
    for (let i = 0; i < have && out.length < count; i++) {
      const e = R[(this.seq - 1 - i) % RECORD_SIZE];
      if (a < 0 || e.arm === a) out.push(e);
    }
    return out.reverse();
  }

  /* ms per tick over the last WINDOW ticks. */
  stats() {
    const n = Math.min(this.msCount, WINDOW);
    let sum = 0, max = 0;
    for (let i = 0; i < n; i++) { sum += this.msBuf[i]; if (this.msBuf[i] > max) max = this.msBuf[i]; }
    return { mean: n ? sum / n : 0, max, ticks: n };
  }
}
