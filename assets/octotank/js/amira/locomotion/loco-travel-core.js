/* How she travels, without THREE or Jolt: her energy through calm and restless spells, which destinations she can reach, and each trip priced by mode (time plus breath) so she takes the cheapest.
   loco-travel.js runs them for Wander; every number is a knob on tank.knobs.travel. */

export const TRAVEL_KNOBS = {
  on: true,
  calmMin: 90,            // s a calm spell lasts, at random in this range, times spellScale and (1.5 − jumpy)
  calmMax: 240,
  restlessMin: 45,        // s a restless spell lasts, times spellScale and (0.5 + jumpy)
  restlessMax: 120,
  spellScale: 1,
  jumpy: 0.5,             // how restless she runs: 0 all but never, 1 restless spells long and calm ones short
  calmLevel: 0.15,        // the energy each spell drifts toward, with a slow wobble on top
  restlessLevel: 0.85,
  wobble: 0.06,
  wobbleT: 47,            // s, the wobble's period
  energyTau: 20,          // s the energy takes to ease toward a new spell's level
  energyPin: -1,          // 0–1 holds her energy there (the panel's dial); below 0 it drifts
  leapMin: 0.55,          // energy under which she never jets to get somewhere
  hopMin: 0.35,           // m of floor under which a trip is always crawled
  hopSpeed: 0.45,         // m/s a travel hop holds: the measured mean jet (JET_KNOBS.vJetMin)
  hopLaunch: 1.5,         // s a hop spends turning and launching, and gliding down and planting after
  hopSettle: 2.5,
  hopPath: 1.25,          // a hop's path over its flat distance, for the arc and the coast
  liftShare: 0.25,        // a hop aims this share of its length above the floor, between liftMin and liftMax m
  liftMin: 0.08,
  liftMax: 0.2,
  coastShare: 0.8,        // of her drag coast she aims short by, so the glide carries her onto the target
  wallOff: 0.15,          // m off the glass a hop toward a spot up the wall lands, to climb from
  breathCalm: 60,         // s of travel one full oxygen debt is worth, calm and restless
  breathRestless: 8,
  breathLimit: 0.9,       // a hop is refused if it would leave her debt past this (JET_KNOBS: 1 ends any jet)
  crawlEff: 0.35,         // the crawl's real progress over its wanted speed (measured: 2.6–4.5 cm/s at urgency 0.25–0.4)
  climbSpeed: 0.04,       // m/s up the glass
  slotTime: 60,           // s the squeeze takes, and its odds of getting her through (lip: 11 of 20 in 120 s)
  slotOdds: 0.55,
  slotUrgency: 0.6,       // a trip across the divider goes at least this urgently, as the lip scenario does
  tunnelTime: 20,         // s a passage through the rock takes, and its odds (the tunnel scenario: 34 of 36 legs, median 18 s)
  tunnelOdds: 0.9,
  farPast: 0.12,          // m past a passage's far mouth along its line a far trip's spot starts, up to farSpread more
  farSpread: 0.15,
  urgCalm: 0.2,           // her trips' urgency, calm to restless
  urgRestless: 0.45,
  waitCalm: 1.2,          // shares of Wander's waits between trips, calm to restless
  waitRestless: 0.35,
  dwellCalm: 1.4,         // shares of her dwell with what she went to: calm she fiddles longer
  dwellRestless: 0.5,
  farShare: 0,            // share of her picks on the far side of the divider or of a passage, times her energy plus her boredom
  sideBore: 180,          // s on one side that bores her as much as a restless spell does
  crossTries: 4,          // tries at the slot before a crossing is given up, crossRetry s apart
  crossRetry: 2,
  crossFromY: 0.15,       // m: she sets off to cross only from the floor
  reachY: 0.3,            // m up a target over open floor may be and still be reached from the floor
  climbY: 0.7,            // m up a target by the glass may be and still be climbed to
  wallNear: 0.12,         // m from the glass that counts as by it
};

export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
export function lerp(a, b, t) { return a + (b - a) * t; }

/* How long a spell lasts: its range, scaled by spellScale and leaned by jumpy. */
export function spellLength(restless, r, k = TRAVEL_KNOBS) {
  const j = clamp(k.jumpy, 0, 1), s = Math.max(0.05, k.spellScale);
  return restless ? lerp(k.restlessMin, k.restlessMax, r) * s * (0.5 + j) : lerp(k.calmMin, k.calmMax, r) * s * (1.5 - j);
}

/* 0–1, calm and restless spells alternating, each drifting the value toward its level. Draws from a separate seeded stream
   (rng with next()) only when a spell turns, so nothing else she does moves it. */
export class Energy {
  constructor(rng, k = TRAVEL_KNOBS) {
    this.rng = rng; this.k = k;
    const c = (k.calmMin + k.calmMax) / 2 * (1.5 - clamp(k.jumpy, 0, 1)), r = (k.restlessMin + k.restlessMax) / 2 * (0.5 + clamp(k.jumpy, 0, 1));
    // She opens partway into a spell, picked by the share of time each takes.
    this.restless = rng.next() < r / Math.max(1e-6, r + c);
    this.left = spellLength(this.restless, rng.next(), k) * rng.next();
    this.phase = rng.next() * 2 * Math.PI;
    this.t = 0;
    this.e = this.level();
    this.spells = 0;
  }

  level() {
    const k = this.k;
    return clamp((this.restless ? k.restlessLevel : k.calmLevel) + k.wobble * Math.sin((2 * Math.PI * this.t) / Math.max(1, k.wobbleT) + this.phase), 0, 1);
  }

  tick(dt) {
    if (!(dt > 0)) return this.e;
    this.t += dt;
    this.left -= dt;
    if (this.left <= 0) { this.restless = !this.restless; this.left = spellLength(this.restless, this.rng.next(), this.k); this.spells++; }
    this.e += (this.level() - this.e) * (1 - Math.exp(-dt / Math.max(1e-3, this.k.energyTau)));
    return this.e;
  }

  /* The energy her choices read: the pin when one is set. */
  get value() { return this.k.energyPin >= 0 ? clamp(this.k.energyPin, 0, 1) : this.e; }
}

/* Whether a destination can be got to at all: inside the glass, over open floor no higher than reachY, by the glass no
   higher than climbY. */
export function reachable(p, tank, k = TRAVEL_KNOBS) {
  if (!Number.isFinite(p[0] + p[1] + p[2]) || Math.abs(p[0]) > tank.w / 2 || Math.abs(p[2]) > tank.d / 2) return false;
  if (p[1] <= k.reachY) return true;
  const glass = tank.w / 2 - Math.abs(p[0]) <= k.wallNear || tank.d / 2 - Math.abs(p[2]) <= k.wallNear;
  return glass && p[1] <= k.climbY;
}

/* Heads at share × min(1, energy + bored); draws from rng only when heads is possible, so a zero share leaves it untouched. */
export function farCoin(rng, share, energy, bored) {
  const want = share * Math.min(1, energy + bored);
  return want > 0 && rng.next() < want;
}

/* Her trips' pace at energy e: urgency, and the shares of Wander's waits and dwells. */
export function paceOf(e, k = TRAVEL_KNOBS) {
  const t = clamp(e, 0, 1);
  return { urgency: lerp(k.urgCalm, k.urgRestless, t), wait: lerp(k.waitCalm, k.waitRestless, t), dwell: lerp(k.dwellCalm, k.dwellRestless, t) };
}

/* Each way of making a trip, priced: { flat, rise, cross, energy, debt, jet } with jet true or why a jet can't start, and speeds { speedCalm, speedHurried, jetMeters }.
   Cost is seconds plus breath at what a full debt is worth to her; best is the cheapest that can go. Over the divider only the slot crosses, through the rock (cross 'tunnel') its passage. */
export function priceTrip({ flat = 0, rise = 0, cross = false, energy = 0, debt = 0, jet = true } = {}, speeds, k = TRAVEL_KNOBS) {
  const e = clamp(energy, 0, 1), u = cross ? Math.max(paceOf(e, k).urgency, k.slotUrgency) : paceOf(e, k).urgency;
  const v = Math.max(1e-3, lerp(speeds.speedCalm, speeds.speedHurried, u) * k.crawlEff), up = Math.max(0, rise) / Math.max(1e-3, k.climbSpeed);
  const worth = lerp(k.breathCalm, k.breathRestless, e);
  const crawlT = flat / v + up + (cross === 'tunnel' ? k.tunnelTime / Math.max(0.05, k.tunnelOdds) : cross ? k.slotTime / Math.max(0.05, k.slotOdds) : 0);
  const modes = {
    crawl: { label: cross ? 'squeeze' : rise > 0.05 ? 'climb' : 'crawl', t: crawlT, breath: 0, cost: crawlT, ok: true, why: null, urgency: u },
    hop: { label: rise > 0.05 ? 'hop, climb' : 'hop', t: Infinity, breath: 0, cost: Infinity, ok: false, why: null, urgency: u },
    swing: { label: 'swing', t: Infinity, breath: 0, cost: Infinity, ok: false, why: 'not built', urgency: u },
  };
  const h = modes.hop;
  h.breath = (flat * k.hopPath) / Math.max(1e-3, speeds.jetMeters);
  h.t = k.hopLaunch + (flat * k.hopPath) / Math.max(1e-3, k.hopSpeed) + k.hopSettle + up;
  h.why = cross === 'tunnel' ? 'only the passage crosses' : cross ? 'only the slot crosses' : e < k.leapMin ? 'calm' : flat < k.hopMin ? 'short' : jet !== true ? String(jet) : debt + h.breath > k.breathLimit ? 'breath' : null;
  h.ok = h.why === null;
  if (h.ok) h.cost = h.t + h.breath * worth;
  let best = 'crawl';
  for (const m of ['hop', 'swing']) if (modes[m].ok && modes[m].cost < modes[best].cost) best = m;
  return { modes, best };
}

/* The floor spot a hop to target p lands on: p itself, or for a spot up or by the glass or the divider (panel { x, t }) the
   floor in front of it, pulled in off whichever walls it is by, keeping the side of the divider it was on. Written into out (y 0). */
export function hopSpot(p, tank, k = TRAVEL_KNOBS, out = [0, 0, 0], panel = null) {
  let x = p[0], z = p[2];
  const hw = tank.w / 2, hd = tank.d / 2, side = panel ? Math.sign(x - panel.x) || -1 : 0, gap = panel ? (x - panel.x) * side - panel.t / 2 : Infinity;
  if (p[1] > k.reachY || hw - Math.abs(x) <= k.wallNear || hd - Math.abs(z) <= k.wallNear || gap <= k.wallNear) {
    x = clamp(x, -(hw - k.wallOff), hw - k.wallOff); z = clamp(z, -(hd - k.wallOff), hd - k.wallOff);
    if (gap < k.wallOff) x = panel.x + side * (panel.t / 2 + k.wallOff);
  }
  out[0] = x; out[1] = 0; out[2] = z;
  return out;
}

/* Where a plain aimed hop (?hop=0) aims from center c to target p: short of its spot by her coast, lifted by a share of
   its length. drag is her body's linear drag (1/s). Written into out; returns the flat distance. */
export function hopAim(c, p, drag, tank, k = TRAVEL_KNOBS, out = [0, 0, 0], panel = null) {
  hopSpot(p, tank, k, out, panel);
  const x = out[0], z = out[2];
  const dx = x - c[0], dz = z - c[2], flat = Math.hypot(dx, dz);
  const back = flat > 1e-6 ? Math.min((k.hopSpeed / Math.max(1e-3, drag)) * k.coastShare, flat / 2) / flat : 0;
  out[0] = x - dx * back; out[2] = z - dz * back;
  out[1] = Math.max(0, Math.min(p[1], k.reachY)) + clamp(k.liftShare * flat, k.liftMin, k.liftMax);
  return flat;
}
