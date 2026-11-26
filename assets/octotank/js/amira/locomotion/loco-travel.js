import { TRAVEL_KNOBS, Energy, reachable, paceOf, priceTrip, hopAim, hopSpot, clamp } from './loco-travel-core.js';
import { createRng, deriveSeed } from '../../../../pond/js/rng.js';
import { TANK } from '../../config.js';
import { section } from '../../diag/panel.js';
import { clearOfRock, bodyReach } from '../../tank/rock-clear.js';

/* How she gets where Wander sends her, and how much she wants to go: her energy drifts through calm and restless spells,
   each trip is priced by mode (crawl, climb, the squeeze, a hop, a swing once she has one), and she takes the cheapest.
   Restless she hops around the tank as her breath allows; calm she crawls and fiddles. A stand-in for the brain. */

const UPRIGHT = 0.9;

export class Travel {
  constructor(wander, { seed = 1 } = {}) {
    this.wander = wander;
    this.loco = wander.loco;
    this.knobs = { ...TRAVEL_KNOBS };
    this.energy = new Energy(createRng(deriveSeed(seed, 6623)), this.knobs);
    // Its own stream for the far-side coin, so the spells never shift with how many picks she makes.
    this.rng = createRng(deriveSeed(seed, 6629));
    this.time = null;
    this.last = null;         // the last trip's price and choice
    this.pending = null;      // a hop chosen this tick, launched once the controller has run: { d, aim, meters, spot, crawl }
    this.plan = null;         // a crossing she means to make: { target, what, side, tries, d }
    this.side = 0;
    this.sideT = 0;           // s she has spent on this side of the divider
    this.counts = { trips: 0, crawl: 0, climb: 0, squeeze: 0, hop: 0, refused: 0, far: 0, jetsCalm: 0, jetsRestless: 0, spells: 0, crossed: 0, crossGaveUp: 0 };
    this.refusals = {};
    // After the controller, as the jet's own adrift launch is: a jet started mid-tick would leave the rest of that tick's gait
    // planting arms the jet has just claimed. Added before the jet installs, so it runs first and the thrust starts this tick.
    this._listen = () => this._launch();
    this._listen.reset = () => this.reset();
    this.loco.listeners.add(this._listen);
    const loc = section('loco');
    const k = this.knobs;
    loc.add({ name: 'Travel chooser', label: () => this.label(), run: () => { k.on = !k.on; if (!k.on) this.drop(); } });
    loc.add({ type: 'range', name: 'How restless she runs', values: [0, 0.25, 0.5, 0.75, 1], get: () => k.jumpy, set: (v) => { k.jumpy = v; }, label: () => `How restless she runs ${k.jumpy}` });
    loc.add({ type: 'range', name: 'Spell length', values: [0.25, 0.5, 1, 2, 4], get: () => k.spellScale, set: (v) => { k.spellScale = v; }, label: () => `Spell length ×${k.spellScale}` });
    loc.add({ type: 'range', name: 'Energy', values: [-1, 0, 0.25, 0.5, 0.75, 1], get: () => k.energyPin, set: (v) => { k.energyPin = v; }, label: () => (k.energyPin < 0 ? 'Energy: drifting' : `Energy pinned at ${k.energyPin}`) });
    loc.add({ type: 'range', name: 'Leaps above energy', values: [0.4, 0.55, 0.7, 0.85, 1.01], get: () => k.leapMin, set: (v) => { k.leapMin = v; }, label: () => (k.leapMin > 1 ? 'Travel leaps: never' : `Travel leaps above energy ${k.leapMin}`) });
    loc.add({ type: 'range', name: 'Breath worth when restless', values: [2, 8, 20, 60], get: () => k.breathRestless, set: (v) => { k.breathRestless = v; }, label: () => `A full breath debt worth ${k.breathRestless} s, restless` });
    loc.add({ type: 'range', name: 'Far side share', values: [0, 0.1, 0.3, 0.5, 1], get: () => k.farShare, set: (v) => { k.farShare = v; }, label: () => `Far side share ${k.farShare} × energy` });
  }

  /* Choosing for her: on, and Wander running. */
  get active() { return !!this.knobs.on && !!this.loco.knobs.wander; }

  /* Calm enough that she never leaps to get somewhere: a calm spell, or her energy under leapMin as one fades in. A pinned
     energy decides alone. */
  get calm() {
    const E = this.energy, k = this.knobs;
    return this.active && (k.energyPin >= 0 ? E.value < k.leapMin : !E.restless || E.e < k.leapMin);
  }

  pace() { return paceOf(this.energy.value, this.knobs); }

  /* Restless with guided hops: she roams, so a destination nearer than a hop isn't worth the trip. */
  roams() { const h = this.loco.hopMode; return this.active && !this.calm && !!h?.on && !!h.knobs.roam; }

  tick() {
    const now = this.loco.time;
    if (this.time !== null) this.energy.tick(now - this.time);
    this.time = now;
    this.counts.spells = this.energy.spells;
    const side = this._side();
    if (this.side && side !== this.side) { this.counts.crossed++; this.sideT = 0; }
    this.side = side;
    this.sideT += Math.max(0, now - (this._sideAt ?? now)); this._sideAt = now;
    // Every jet she makes, whatever started it, by the spell it came in: calm spells should have none.
    const jet = this.loco.jetMode;
    if (jet && !this._heard) {
      this._heard = (what, j) => { if (what === 'start' && j.kind === 'jet') this.counts[this.calm ? 'jetsCalm' : 'jetsRestless']++; };
      jet.listeners.add(this._heard);
    }
  }

  // Without a panel the tank is one side.
  _side() { return this.wander.panelX == null ? -1 : Math.sign(this.loco.c[0] - this.wander.panelX) || -1; }

  /* The far side this pick, likelier as she grows restless or bored of this side, and only from the floor: the slot is
     reached from below. */
  farPick() {
    const L = this.loco, k = this.knobs;
    const want = k.farShare * Math.min(1, this.energy.value + this.sideT / Math.max(1, k.sideBore));
    return this.rng.next() < want && L.c[1] < k.crossFromY && !L.modes.get('pull')?.steep && !L.flipped;
  }

  /* A crossing's desire ended: true if she should try again soon. Through, or out of tries, the plan ends. */
  ended(d) {
    const p = this.plan;
    if (!p || p.d !== d) return false;
    if (d.arrived || this._side() === p.side) { this.plan = null; return false; }
    if (++p.tries >= this.knobs.crossTries) { this.plan = null; this.counts.crossGaveUp++; return false; }
    return true;
  }

  drop() { this.plan = null; }

  /* A scenario's clean slate: the crossing, a readied hop, and her side clock go, so a scenario's time is neither a trip nor
     boredom. Her spell and the counts carry on: a mood and a session readout, not intents. */
  reset() {
    this.pending = null; this.plan = null;
    this.side = 0; this.sideT = 0; this._sideAt = null;
    this.time = null;
  }

  reachable(p) { return reachable(p, TANK, this.knobs); }

  /* Why a hop can't start now, or true. */
  canHop() {
    const L = this.loco, jet = L.jetMode, A = L.arms;
    if (!jet) return 'no jet';
    if (jet.phase !== 'off') return 'jetting';
    if (!jet.debt.ready) return jet.debt.debt > jet.k.jetReady ? 'winded' : 'heart';
    if (L.hold) return 'held';
    if (L.flipped) return 'righting';
    if (A.resting) return 'resting';
    if (A.lead) return 'arms busy';
    if (L.modes.get('squeeze')?.active) return 'squeezing';
    if (L.modes.get('pull')?.steep) return 'on the wall';
    if (!(L.mantle.up(this._up ??= [0, 0, 0])[1] > UPRIGHT)) return 'not upright';
    return true;
  }

  /* A trip Wander just set out on: priced by mode, the urgency set, and a hop readied if it wins. Returns the choice. */
  go(d, cross) {
    const L = this.loco, k = this.knobs, c = L.c, p = d.point, jet = L.jetMode, e = this.energy.value;
    const flat = Math.hypot(p[0] - c[0], p[2] - c[2]), rise = Math.max(0, p[1] - 0.05);
    const can = this.calm ? 'calm' : this.canHop();
    const price = priceTrip({ flat, rise, cross, energy: e, debt: jet?.debt.debt ?? 0, jet: can }, { speedCalm: L.knobs.speedCalm, speedHurried: L.knobs.speedHurried, jetMeters: jet?.k.jetMeters ?? 3 }, k);
    const pick = price.modes[price.best];
    d.urgency = clamp(pick.urgency, 0, 1);
    let mode = price.best, label = pick.label;
    const panel = this.wander.panelX == null ? null : { x: this.wander.panelX, t: this.wander.panelT };
    // A landing her body can't fit beside the rock is crawled instead.
    const spot = mode === 'hop' ? hopSpot(p, TANK, k, [0, 0, 0], panel) : null;
    if (spot && !clearOfRock(L.arms.phys, spot, this._reach ??= bodyReach(L.mantle))) {
      this.refusals.rock = (this.refusals.rock ?? 0) + 1;
      mode = 'crawl'; label = price.modes.crawl.label; d.urgency = clamp(price.modes.crawl.urgency, 0, 1);
    }
    if (mode === 'hop') {
      const aim = [0, 0, 0];
      hopAim(c, p, L.mantle.knobs.damping, TANK, k, aim, panel);
      this.pending = { d, aim, meters: Math.hypot(aim[0] - c[0], aim[1] - c[1], aim[2] - c[2]), spot, crawl: price.modes.crawl };
    } else if (price.modes.hop.why) this.refusals[price.modes.hop.why] = (this.refusals[price.modes.hop.why] ?? 0) + 1;
    this.counts.trips++;
    this.counts[mode === 'hop' ? 'hop' : label]++;
    if (cross) this.counts.far++;
    this.last = { mode, label, flat: +flat.toFixed(2), energy: +e.toFixed(2), crawl: +price.modes.crawl.cost.toFixed(1), hop: Number.isFinite(price.modes.hop.cost) ? +price.modes.hop.cost.toFixed(1) : price.modes.hop.why };
    return this.last;
  }

  /* The readied hop, if its trip still stands; refused, the trip is crawled instead. */
  _launch() {
    const h = this.pending;
    if (!h) return;
    this.pending = null;
    if (this.loco.desire !== h.d || !this.active) return;
    // A guided hop lands on the spot itself; with ?hop=0 it is the plain jet aimed short by her coast.
    const hop = this.loco.hopMode;
    const r = hop?.on ? hop.start(h.spot, { speed: this.knobs.hopSpeed, reason: 'travel' })
      : this.loco.jetMode.start({ to: h.aim, speed: this.knobs.hopSpeed, urgency: 1, reason: 'travel', meters: h.meters });
    if (r === true) return;
    this.counts.refused++; this.refusals[r] = (this.refusals[r] ?? 0) + 1;
    this.counts.hop--; this.counts[h.crawl.label]++;
    h.d.urgency = h.crawl.urgency;
    if (this.last) { this.last.mode = 'crawl'; this.last.label = h.crawl.label; }
    if (this.wander.desire === h.d) this.wander.how = h.crawl.label;
  }

  spell() { return this.calm || !this.active ? 'calm' : 'restless'; }

  label() {
    if (!this.knobs.on) return 'Travel chooser: off';
    const E = this.energy, k = this.knobs;
    return `Travel: ${this.spell()} ${E.value.toFixed(2)}${k.energyPin < 0 ? `, spell turns in ${Math.max(0, E.left).toFixed(0)} s` : ''}${this.last ? `, last ${this.last.label}` : ''}`;
  }

  /* For Wander's line on the panel. */
  describe() { return this.active ? `${this.spell()} ${this.energy.value.toFixed(2)}` : ''; }

  stats() { return { energy: +this.energy.value.toFixed(3), spell: this.spell(), counts: { ...this.counts }, refusals: { ...this.refusals }, last: this.last }; }
}
