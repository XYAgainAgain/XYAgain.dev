/* Each arm's state, its reason, and since when, plus a ring of recent events per arm that collapses repeats. Pure
   observation: it reads the arms, their reflexes, the blocked tell, and locomotion's roles, and writes only its own state. */

export const RECORD_SIZE = 64;   // events per arm, so a busy arm can't write over a quiet one's beats
const WINDOW = 1800;

export class ArmRecords {
  constructor(arms) {
    this.arms = arms;
    const n = arms.arms.length;
    this.state = Array.from({ length: n }, () => ({ label: 'exploring', reason: null, since: 0 }));
    // Locomotion, when the page has one: its role names tell a stroke from a station. Arms holds no reference to it.
    this.loco = null;
    this.ring = Array.from({ length: n }, (_, a) => Array.from({ length: RECORD_SIZE }, () => ({ t: 0, arm: a, kind: '', text: '', count: 0, seq: 0 })));
    this.written = new Float64Array(n);        // events each arm has logged; its newest sits at (written - 1) % RECORD_SIZE
    this.seq = 0;                              // across every arm, so a merged read keeps their order
    this._note = new Array(n).fill(null);      // the newest note since the last tick, for a label change's reason
    this._kind = new Array(n).fill(null);
    this._goal = new Array(n).fill(null);
    this._ep = new Array(n).fill(null);
    // Her locomotion's assignment for each arm (null in the pool), its newest reason, and since when.
    this.assigned = Array.from({ length: n }, () => ({ task: null, why: null, since: 0 }));
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

  /* An assignment given, ended (task null), suspended, or resumed, with its reason; logged as an 'assign' event. */
  assign(a, task, why = null) {
    if (!(a >= 0 && a < this.state.length)) return;
    const s = this.assigned[a];
    if (s.task !== task) s.since = this.arms.time;
    s.task = task; s.why = why;
    this._log(a, 'assign', `${task ?? 'pool'}${why ? `, ${why}` : ''}`);
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

  /* A repeat of this arm's newest event only counts up; `t` stays the first time. */
  _log(a, kind, text) {
    const R = this.ring[a], w = this.written[a];
    if (w > 0) {
      const e = R[(w - 1) % RECORD_SIZE];
      if (e.kind === kind && e.text === text) { e.count++; return; }
    }
    const e = R[w % RECORD_SIZE];
    e.t = this.arms.time; e.kind = kind; e.text = text; e.count = 1; e.seq = ++this.seq;
    this.written[a] = w + 1;
  }

  /* Up to `count` of the newest events, oldest first: slot a's alone, or every arm's merged with a < 0. These are the
     rings' own entries, rewritten as they wrap, so copy any you keep. */
  recent(a = -1, count = RECORD_SIZE) {
    const out = [];
    if (a >= 0) {
      const R = this.ring[a], w = this.written[a];
      if (!R) return out;
      for (let i = 1; i <= Math.min(w, RECORD_SIZE, count); i++) out.push(R[(w - i) % RECORD_SIZE]);
      return out.reverse();
    }
    // Newest first across the arms: each arm's ring is in order, so its next-newest is always the one to compare.
    const n = this.ring.length, back = this._back ??= new Int32Array(n);
    back.fill(0);
    while (out.length < count) {
      let best = -1, bs = 0;
      for (let b = 0; b < n; b++) {
        const w = this.written[b], i = back[b] + 1;
        if (i > Math.min(w, RECORD_SIZE)) continue;
        const s = this.ring[b][(w - i) % RECORD_SIZE].seq;
        if (s > bs) { bs = s; best = b; }
      }
      if (best < 0) break;
      back[best]++;
      out.push(this.ring[best][(this.written[best] - back[best]) % RECORD_SIZE]);
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
