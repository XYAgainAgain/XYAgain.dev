/* One leader tab writes the shared record; a follower may submit only its visitor's knocks and palm visits. A lone
   tab is a leader of one, so every change carries its owner. */

export const FOLLOWER_KINDS = new Set(['knock', 'palm']);
const LEDGER = 256;

export class SharedRecord {
  constructor(meters, lift = 0) {
    this.meters = { ...meters };
    this.lift = lift;
    this.advancedAt = null;   // shared time of the last drift advance, s
    this.seq = 0;
  }
}

export class Authority {
  constructor(record, { tab = 'local', leader = tab } = {}) {
    this.record = record;
    this.tab = tab;
    this.leader = leader;
    this.ledger = [];
    this.totals = new Map();   // why → summed delta, for diagnostics
    this._done = new Map();    // unique id → time it resolved
  }

  get isLeader() { return this.leader === this.tab; }

  allows(kind) { return this.isLeader || FOLLOWER_KINDS.has(kind); }

  /* Refused for a follower, applied at most once per `id`, clamped 0–1; returns the change applied. */
  meter(meter, delta, why, now, id = null) {
    if (!this.allows('meter') || !Number.isFinite(delta) || delta === 0) return 0;
    if (id !== null) { if (this._done.has(id)) return 0; this._done.set(id, now); }
    const m = this.record.meters;
    if (!(meter in m)) return 0;
    const v = m[meter], next = v + delta < 0 ? 0 : v + delta > 1 ? 1 : v + delta;
    m[meter] = next;
    this._log('meter', meter, next - v, why, now);
    return next - v;
  }

  lift(next, why, now) {
    if (!this.allows('lift') || !Number.isFinite(next)) return false;
    const v = this.record.lift;
    this.record.lift = next < 0 ? 0 : next > 1 ? 1 : next;
    if (why !== 'drift') this._log('lift', 'lift', this.record.lift - v, why, now);
    return true;
  }

  /* True the first time `id` is claimed, so a retried meal or prize resolves once. */
  once(id, now) {
    if (!this.isLeader || this._done.has(id)) return false;
    this._done.set(id, now);
    return true;
  }

  /* Ids older than `age` s can't come back as retries. */
  prune(now, age = 86400) { for (const [id, t] of this._done) if (now - t > age) this._done.delete(id); }

  _log(kind, key, delta, why, now) {
    this.totals.set(why, (this.totals.get(why) ?? 0) + delta);
    if (why === 'drift') return;
    this.record.seq++;
    this.ledger.push({ seq: this.record.seq, t: now, owner: this.tab, kind, key, delta, why });
    if (this.ledger.length > LEDGER) this.ledger.shift();
  }
}
