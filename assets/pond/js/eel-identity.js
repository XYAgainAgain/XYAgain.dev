import * as THREE from 'three/webgpu';
import { JIM_TABLECLOTH, PRIDE_FLAGS, twoToneStops } from './eel-palette.js';

/* The cast. An identity constrains build, glow palette, and behavior knobs; each visit samples fresh
   values inside those constraints, so Matthew is always Matthew without ever being an exact rerun. */

const TEAL = [0.10, 1.00, 0.85], MAGENTA = [1.00, 0.25, 0.70], BLUE = [0.35, 0.55, 1.00], YELLOW = [0.95, 0.95, 0.20];
const ORANGE = [1.00, 0.45, 0.10], PURPLE = [0.60, 0.20, 1.00], GREEN = [0.20, 1.00, 0.30], RED = [1.00, 0.15, 0.25];
const SILVER = [0.78, 0.82, 0.90];
const POOL = [TEAL, MAGENTA, BLUE, YELLOW, ORANGE, PURPLE, GREEN, RED];
// The tablecloth's two most saturated bands; only the fallback and the guest capsules still read these.
const CLOTH_NAVY = [0.2784, 0.3216, 0.4471], CLOTH_EMBER = [0.7333, 0.3137, 0.2353];
const PRIDE_LIST = Object.values(PRIDE_FLAGS);
const STEADY_PULSE = [0, 0, 1, 0];   // (lantern, breathe, pulse, flicker); today's traveling pulse alone

// Knob meanings: cover/hunger/yield/persistence/spookMul/curious scale existing steering terms;
// prowl/cruise are BL/s bands; attention is the retarget interval; hold/travel are gait bout seconds.
const DEFAULT_TRAITS = {
  prowl: [0.28, 0.45], cruise: [0.8, 1.0], turn: [3.5, 5.0],
  holdChance: 0.55, holdTime: [1, 6], travelTime: [2, 8], attention: [5, 12],
  cover: 1, hunger: 1, yield: 0, persistence: 1, spookMul: 1, curious: 1,
};
const DEFAULT_BUILD = { length: [1.6, 3.4], radius: [0.07, 0.12] };

export const IDENTITIES = [
  {
    name: 'Matthew',   // long, skinny, blue-green, stripey; snacks constantly; log lover
    build: { length: [2.8, 3.3], radius: [0.065, 0.08] },
    colorsA: [TEAL, GREEN], colorsB: [BLUE, TEAL],
    pattern: { stripe: [0.95, 0.6, 1], spot: [0.3, 0.2, 0.5], flank: [0.7, 0.4, 0.8], wavy: [0.5, 1.8] },
    traits: { hunger: 1.5, cover: 1.5 },
  },
  {
    name: 'Jaz',   // chunky, multicolored, calm; hunger locks on; #1 log fan
    build: { length: [2.0, 2.6], radius: [0.105, 0.125] },
    colorsA: POOL, colorsB: POOL,
    pattern: { stripe: [0.85, 0.3, 1], spot: [0.85, 0.3, 1], flank: [0.85, 0.3, 1], wavy: [0, 2.5] },
    traits: { holdChance: 0.7, holdTime: [3, 9], persistence: 2.5, cover: 1.7, cruise: [0.72, 0.88], turn: [3.2, 4.3], attention: [8, 16] },
  },
  {
    name: 'Jim',   // wears Dad's beloved tablecloth, all 26 stripes, a different tonic every roll;
                   // slow, checks on the others; low hunger, yields meals; bonded with Shelley
    build: { length: [2.3, 2.7], radius: [0.085, 0.1] },
    colorsA: [CLOTH_NAVY], colorsB: [CLOTH_EMBER],
    // gain lives in the bake and clamps per channel, so anything past ~1.2 bleaches the pale bands white.
    ramp: { stops: JIM_TABLECLOTH, rotate: true, jitter: 0.15, sat: 1.4, gain: 1.15, skin: 1 },
    pattern: { stripe: [0, 0, 0], spot: [0, 0, 0], band: [1, 1, 1], flank: [0, 0, 0], wavy: [0, 1] },   // every stripe edge lights, no flank
    traits: { cruise: [0.68, 0.82], prowl: [0.24, 0.34], hunger: 0.5, yield: 1, curious: 1.25 },
    quirks: { follows: 'Shelley', followWeight: 0.5 },
  },
  {
    name: 'Shelley',   // silvery, fast, often ahead of Jim; random rest stops, tiny attention span
    build: { length: [2.2, 2.6], radius: [0.08, 0.095] },
    colorsA: [SILVER], colorsB: [SILVER, MAGENTA],
    pattern: { stripe: [0.4, 0.2, 0.5], spot: [0.4, 0.2, 0.5], flank: [0.9, 0.5, 0.9], wavy: [0, 1.2] },
    traits: { cruise: [0.95, 1.1], attention: [2, 5], holdChance: 0.6, holdTime: [0.5, 3], travelTime: [1, 4], curious: 1.4 },
    quirks: { follows: 'Jim', followWeight: 0.15 },
  },
  {
    name: 'Josh',   // longest, always some orange; bold, fast, sharp turns; crush on Eleanor
    build: { length: [3.2, 3.6], radius: [0.09, 0.11] },
    colorsA: [ORANGE], colorsB: [YELLOW, RED, MAGENTA],
    pattern: { stripe: [0.6, 0.4, 0.9], spot: [0.5, 0.3, 0.7], flank: [0.8, 0.5, 1], wavy: [0.5, 2] },
    traits: { spookMul: 0.6, cruise: [0.95, 1.15], turn: [4.5, 5.5], hunger: 1.2, cover: 0.6 },
    quirks: { follows: 'Eleanor', followWeight: 0.35 },
  },
  {
    name: 'Andy',   // blue/yellow striped gentleman; follows water disturbances; underuses the Braincell
    build: { length: [2.4, 2.9], radius: [0.085, 0.1] },
    colorsA: [BLUE], colorsB: [YELLOW],
    pattern: { stripe: [1, 0.7, 1], spot: [0.2, 0.2, 0.4], flank: [0.5, 0.3, 0.6], wavy: [0.8, 2.2] },
    traits: { curious: 1.5, hunger: 0.9 },
    quirks: { rippleChase: true },
  },
  {
    name: 'Eleanor',   // the mega-eel; not in the active rotation, attached as a guest with her own brain
    active: false,
    dorsalGlow: true,   // dim wavy ridge lights + tail photophore instead of the standard pattern glow
    build: { length: [7.5, 8.5], radius: [0.24, 0.28] },   // barely fits under the surface; drifting up breaches
    colorsA: [PURPLE], colorsB: [TEAL],
    pattern: { stripe: [0.4, 0.3, 0.6], spot: [0.9, 0.6, 1], flank: [0.9, 0.6, 1], wavy: [1, 2.5] },
    traits: { spookMul: 0.3, cover: 0.4, turn: [1.2, 1.8], cruise: [0.3, 0.42], prowl: [0.15, 0.25] },
  },
];

export function identityFor(index) {
  const active = IDENTITIES.filter((i) => i.active !== false);
  return active[index % active.length];
}

export function applyIdentity(e, id, rng) {
  const t = { ...DEFAULT_TRAITS, ...id.traits };
  const b = { ...DEFAULT_BUILD, ...id.build };
  e.name = id.name;
  e.length = rng.range(b.length[0], b.length[1]);
  e.radius = rng.range(b.radius[0], b.radius[1]);
  e.prowlBL = rng.range(t.prowl[0], t.prowl[1]);
  e.cruiseBL = rng.range(t.cruise[0], t.cruise[1]);
  e.turnRate = rng.range(t.turn[0], t.turn[1]);
  e.traits = {
    holdChance: t.holdChance, holdTime: t.holdTime, travelTime: t.travelTime, attention: t.attention,
    cover: t.cover, hunger: t.hunger, yield: t.yield, persistence: t.persistence,
    spookMul: t.spookMul, curious: t.curious,
  };
  e.quirks = id.quirks || {};
}

/* colA/colB still roll: the fallback layer, Eleanor's branch, and her capsules all read them. The
   ramp is the new truth for the body, built from the identity's stops, a flag, or those two colors. */
export function rollIdentityColors(e, id, rng) {
  e.colA = new THREE.Color(...rng.pick(id.colorsA));
  e.colB = new THREE.Color(...rng.pick(id.colorsB));
  const ramp = id.ramp;
  // Scales the global skin knob: the neon eels keep their dark gaps, a woven eel shows its whole cloth.
  e.skinMul = ramp?.skin ?? 0.1;
  if (ramp?.stops) {
    e.rampStops = ramp.stops;
    e.rampOpts = ramp;
  } else if (ramp?.prideFlag) {
    e.rampStops = rng.pick(PRIDE_LIST);
    e.rampOpts = { soften: 0, ...ramp };   // hard edges: a flag's stripes do not blend into each other
  } else {
    e.rampStops = twoToneStops(e.colA.toArray(), e.colB.toArray());
    e.rampOpts = { ...ramp, soften: 1 };
  }
}

/* Pattern spec per family is [chance, lo, hi]: the chance gates the family, lo–hi bounds its weight. */
export function rollIdentityPattern(e, id, rng) {
  const p = id.pattern;
  const roll = ([c, lo, hi]) => (rng.chance(c) ? rng.range(lo, hi) : 0);
  e.stripeFreq = rng.range(4, 14);
  e.spotFreq = rng.range(6, 16);
  e.wStripe = roll(p.stripe);
  e.wSpot = roll(p.spot);
  // Skipped entirely rather than rolled against 0, so a bandless identity keeps its old rng stream.
  e.wBand = p.band ? roll(p.band) : 0;
  e.wFlank = roll(p.flank);
  e.wavy = rng.range(p.wavy[0], p.wavy[1]);
  e.pulseRate = rng.range(1.5, 4);
  // Same rule as band: no draw unless the identity asks, so the old residents keep their rng streams.
  const rep = id.ramp?.repeats;
  e.repeats = rep ? rng.range(rep[0], rep[1]) : 1;
  e.glowMode = new THREE.Vector4(...(id.glow ?? STEADY_PULSE));
  if (e.wStripe + e.wSpot + e.wBand + e.wFlank === 0) e.wFlank = 1;
}
