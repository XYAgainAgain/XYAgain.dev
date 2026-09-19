import * as THREE from 'three/webgpu';
import { JIM_TABLECLOTH, PRIDE_FLAGS, THEMES, weightedPickName, twoToneStops, JAM, COBALT, SHELLEY_SWIRL, STAR_SILVER, STAR_GOLD } from './eel-palette.js';
import { EEL_COUNT } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { STAR_METAL_ODDS, SWIRL_FREQ, FACET_TILT } from './eel-stars-core.js';

/* The cast. An identity constrains build, glow palette, and behavior knobs; each visit samples fresh
   values inside those constraints, so Matthew is always Matthew without ever being an exact rerun. */

const TEAL = [0.10, 1.00, 0.85], MAGENTA = [1.00, 0.25, 0.70], BLUE = [0.35, 0.55, 1.00], YELLOW = [0.95, 0.95, 0.20];
const ORANGE = [1.00, 0.45, 0.10], PURPLE = [0.60, 0.20, 1.00], GREEN = [0.20, 1.00, 0.30], RED = [1.00, 0.15, 0.25];
// The census colors. Pushed saturated on purpose: these are emission on a near-black body, so a
// tasteful millennial pink or goldenrod would read as mud rather than as a lit sign.
const PINK = [1.00, 0.40, 0.68], NEON_GREEN = [0.45, 1.00, 0.10], TURQUOISE = [0.15, 0.90, 0.82];
const LIME_YELLOW = [0.80, 1.00, 0.15], MILLENNIAL_PINK = [1.00, 0.62, 0.60], GOLDENROD = [0.92, 0.66, 0.10];
const GOLD = [1.00, 0.84, 0.25], BLACK = [0, 0, 0];
// Matthew's census pair, stalker camo: dark-leaning but still lit, two variants each for variety.
const FOREST = [0.10, 0.62, 0.20], MOSS = [0.30, 0.85, 0.25], DEEP_BLUE = [0.12, 0.32, 0.95], LAKE = [0.22, 0.55, 1.00];
const POOL = [TEAL, MAGENTA, BLUE, YELLOW, ORANGE, PURPLE, GREEN, RED];
// The tablecloth's two most saturated bands; only the fallback and the guest capsules still read these.
const CLOTH_NAVY = [0.2784, 0.3216, 0.4471], CLOTH_EMBER = [0.7333, 0.3137, 0.2353];
const PRIDE_LIST = Object.values(PRIDE_FLAGS);
const STEADY_PULSE = [0, 0, 1, 0];   // (lantern, breathe, pulse, flicker); today's traveling pulse alone

// Knob meanings: cover/hunger/yield/persistence/spookMul/curious scale existing steering terms;
// prowl/cruise are BL/s bands; attention is the retarget interval; hold/travel are gait bout seconds.
// The second row is the braincell wave's per-eel set: how much of the shared braincell this one uses,
// smell reach, fidget and leap odds, the anchor it drifts home to, who it fears, and its spin odds.
const DEFAULT_TRAITS = {
  prowl: [0.28, 0.45], cruise: [0.8, 1.0], turn: [4.5, 6.5],
  holdChance: 0.55, holdTime: [1, 6], travelTime: [2, 8], attention: [5, 12],
  cover: 1, hunger: 1, yield: 0, persistence: 1, spookMul: 1, curious: 1,
  braincellUsage: 0.5, nose: 1, stim: 0.3, leap: 0.2, home: 'roam',
  // An explicit 0 is an immunity the size term cannot override, which is how kind `sam` is feared
  // by nobody however big he gets.
  fears: { eleanor: 0.6, finger: 0.2, sam: 0 }, spinOdds: 0.35, kind: 'eel',
  // Diet as a per-kind weight rather than a branch, so a fish, a firefly, or a strider is a table row.
  eats: { crumb: 1 },
};
const DEFAULT_BUILD = { length: [1.6, 3.4], radius: [0.07, 0.12] };

export const IDENTITIES = [
  {
    name: 'Matthew',   // forest-and-lake stalker camo (a former mountain bike racer); tea with every rest,
                       // a chaos wardrobe, and a heart that belongs to whoever is currently closest
    pronouns: 'he/him',
    nicks: [['Matthew', 80], ['Thew', 20]],
    build: { length: [2.8, 3.3], radius: [0.08, 0.095] },   // still the racer silhouette, bulked up a bit
    colorsA: [FOREST, MOSS], colorsB: [DEEP_BLUE, LAKE],
    chaos: true,   // the census draw lives in chaosKit: splotches, sheen, or the whole closet
    glow: [0, 1, 0, 0],
    traits: { hunger: 1.5, cover: 1.5, persistence: 2.2, holdChance: 0.8, holdTime: [8, 25], braincellUsage: 0.75, nose: 1.2, stim: 0.3, leap: 0.9, home: 'log', fears: { eleanor: 0.5 } },
    census: { startle: 'freeze', hunt: 'stalk', party: 'corner', twoAM: 'asleep' },
    quirks: { gourmet: true, tea: true, shipsNearest: true, followWeight: 0.4 },
  },
  {
    name: 'Jaz',   // turquoise and purple, spotted and mottled; chunky, calm, slow breather;
                   // hunger locks on, #1 log fan, bonded to Bee
    pronouns: 'they/them',
    nicks: [['Jaz', 60], ['JD', 20], ['J-Dizzle', 10], ['The Warp-Warden', 10]],
    build: { length: [2.0, 2.6], radius: [0.105, 0.125] },
    colorsA: [TURQUOISE], colorsB: [PURPLE],
    jelly: 0.33,
    pattern: { stripe: [0.2, 0.2, 0.5], spot: [0.95, 0.4, 1], flank: [0.9, 0.4, 1], wavy: [0, 1.6], splotch: [0.8, 0.3, 0.7] },
    glow: [0, 1, 0, 0],
    traits: { holdChance: 0.7, holdTime: [3, 9], persistence: 2.5, cover: 1.7, cruise: [0.72, 0.88], turn: [4.2, 5.6], attention: [8, 16], braincellUsage: 1.0, nose: 1.0, stim: 0.3, leap: 0, home: 'log', fears: { eleanor: 0.2 } },
    census: { startle: 'freeze', hunt: 'stalk', party: 'corner', twoAM: 'cozy' },
    quirks: { follows: 'Bee', followWeight: 0.4, snake: true, spiralSleep: true, gourmet: true, graze: true },
  },
  {
    name: 'Jim',   // wears Dad's beloved tablecloth, all 26 stripes, a different tonic every roll; slow,
                   // checks on the others; low hunger, yields meals; life-bonded to Shelley, strolling level with her
    pronouns: 'he/him',
    nicks: [['Jim', 70], ['Dad', 20], ['My Literal Actual Father', 10]],
    build: { length: [2.8, 3.2], radius: [0.1, 0.115] },   // the parents run big: older, and they have eaten more
    colorsA: [CLOTH_NAVY], colorsB: [CLOTH_EMBER],
    // gain lives in the bake and clamps per channel, so anything past ~1.2 bleaches the pale bands white.
    ramp: { stops: JIM_TABLECLOTH, rotate: true, jitter: 0.15, sat: 1.4, gain: 1.15, skin: 1 },
    pattern: { stripe: [0, 0, 0], spot: [0, 0, 0], band: [1, 1, 1], flank: [0, 0, 0], wavy: [0, 1] },   // every stripe edge lights, no flank
    traits: { cruise: [0.68, 0.82], prowl: [0.24, 0.34], hunger: 0.5, yield: 1, curious: 1.25, braincellUsage: 0.7, nose: 0.8, stim: 0.2, leap: 0.1, home: 'pad', fears: { eleanor: 0.7 }, spinOdds: 0.2 },
    quirks: { follows: 'Shelley', followWeight: 0.7, lifeBond: 'Shelley', lifeBondSeek: 0.5, lifeBondLead: 0.4, lifeBondAhead: 0 },
  },
  {
    name: 'Shelley',   // jam marbled with cobalt, glittering with stars: Mom's own color chart. Fast,
                       // often ahead of Jim; random rest stops, tiny attention span; life-bonded to him
    pronouns: 'she/her',
    nicks: [['Shelley', 60], ['Mom', 20], ['Shel', 10], ['My Literal Actual Mother', 10]],
    build: { length: [2.7, 3.1], radius: [0.095, 0.11] },   // big like Jim, a touch slimmer: she is the fast one
    // The ramp is her truth; colA/colB only feed the fallback layer and the guest capsules.
    colorsA: [COBALT], colorsB: [JAM],
    // gain sits low on purpose: the whole body is lit, and jam past ~0.6 tone-maps to hot pink on screen.
    ramp: { stops: SHELLEY_SWIRL, jitter: 0.15, soften: 110, sat: 1, gain: 0.6, skin: 1 },
    pattern: { stripe: [0, 0, 0], spot: [0, 0, 0], flank: [0, 0, 0], wavy: [0, 1], swirl: [1, 1, 1], stars: [1, 1, 1], glitter: [1, 1, 1] },
    traits: { cruise: [0.95, 1.1], attention: [2, 5], holdChance: 0.6, holdTime: [0.5, 3], travelTime: [1, 4], curious: 1.4, braincellUsage: 0.6, nose: 1.0, stim: 0.6, leap: 0.4, home: 'roam', fears: { eleanor: 0.6 } },
    quirks: { follows: 'Jim', followWeight: 0.45, lifeBond: 'Jim', lifeBondSeek: 0.5, lifeBondLead: 0.6, lifeBondAhead: 0.5 },
  },
  {
    name: 'Josh',   // longest, always some orange; bold, fast, sharp turns; crush on Eleanor
    pronouns: 'he/him',
    build: { length: [3.2, 3.6], radius: [0.09, 0.11] },
    colorsA: [ORANGE], colorsB: [YELLOW, RED, MAGENTA],
    // Plaid is effectively mandated where he lives (Alaska), so it wins most rolls.
    pattern: { stripe: [0.6, 0.4, 0.9], spot: [0.5, 0.3, 0.7], flank: [0.8, 0.5, 1], plaid: [0.65, 0.7, 1], wavy: [0.5, 2] },
    traits: { spookMul: 0.6, cruise: [0.95, 1.15], turn: [5.8, 7.2], hunger: 1.2, cover: 0.6, braincellUsage: 0.6, nose: 1.0, stim: 0.4, leap: 1.0, home: 'rock', fears: { eleanor: 0 }, spinOdds: 0.5 },
    quirks: { follows: 'Eleanor', followWeight: 0.35 },
  },
  {
    name: 'Andy',   // blue/yellow striped gentleman; follows water disturbances; underuses the Braincell
    pronouns: 'he/him',
    build: { length: [2.4, 2.9], radius: [0.085, 0.1] },
    colorsA: [BLUE], colorsB: [YELLOW],
    pattern: { stripe: [1, 0.7, 1], spot: [0.2, 0.2, 0.4], flank: [0.5, 0.3, 0.6], wavy: [0.8, 2.2] },
    traits: { curious: 1.5, hunger: 0.9, braincellUsage: 0.15, nose: 1.4, stim: 0.6, leap: 0.8, home: 'rock', fears: { eleanor: 0.5 } },
    quirks: { rippleChase: true },
  },
  {
    name: 'Chandler',   // pink and neon green, tiger stripes over splotches; would kiss all her friends,
                        // flips her shit when startled, and stalks a crumb with total patience
    pronouns: 'she/her',
    nicks: [['Chan', 60], ['Chandler', 20], ['Changirl', 10], ['Chananigans', 7], ['shit goth. zing.', 3]],
    build: { length: [2.3, 2.7], radius: [0.085, 0.1] },
    colorsA: [PINK], colorsB: [NEON_GREEN],
    pattern: { stripe: [0.9, 0.5, 1], spot: [0.9, 0.5, 1], flank: [0.3, 0.2, 0.4], wavy: [1.8, 3], tiger: [0.8, 0.3, 0.6], splotch: [0.9, 0.4, 0.8] },
    glow: STEADY_PULSE,
    traits: { curious: 1.6, spookMul: 0.8, cover: 0.85, persistence: 2.2, hunger: 1.2, braincellUsage: 0.5, nose: 1.1, stim: 0.9, leap: 0.6, home: 'rock', fears: { eleanor: 0.3 } },
    census: { startle: 'flip', hunt: 'stalk', party: 'corner', twoAM: 'cozy' },
    // zoomies is read by eleanor.js: the hunt turns into a chase instead of a slurp.
    quirks: { sings: [8, 20], gourmet: true, cuddly: true, zoomies: true, graze: true },
  },
  {
    name: 'Morgan',   // green and yellow, spotted with a solid sheen; an herbivore who files a scare
                      // away to worry about later, hugs the exits, crushes on Jaz, and sips tea like Matthew
    pronouns: 'they/she',
    nicks: [['Morgan', 60], ['Mubgub', 20], ['Mubulous Gubulon', 20]],
    build: { length: [2.0, 2.4], radius: [0.095, 0.11] },
    colorsA: [GREEN], colorsB: [LIME_YELLOW],
    jelly: 0.33,
    pattern: { stripe: [0.15, 0.2, 0.4], spot: [0.9, 0.5, 1], flank: [0.8, 0.4, 0.9], wavy: [0, 1.4], splotch: [0.6, 0.25, 0.5], sheen: [0.8, 0.4, 0.8] },
    glow: [0, 1, 1, 0],   // breathe and pulse together; the envelope normalizes by the weight sum
    traits: { curious: 0.85, cover: 1.1, hunger: 0.5, braincellUsage: 0.85, nose: 0.9, stim: 0.3, leap: 0.3, home: 'pad', fears: { eleanor: 0.75, vi: 0.2 }, spinOdds: 0, eats: { crumb: 0 } },
    census: { startle: 'later', hunt: 'bonk', party: 'exits', twoAM: 'cozy' },
    quirks: { follows: 'Jaz', followWeight: 0.25, rescue: true, loopies: true, graze: true, herbivore: true, floor: true, tea: true },
  },
  {
    name: 'Vi',   // Violet, who jives with Vi; purple over black, all splotches, a restless flicker; loud,
                  // headbutts everyone, beefs with the whole pond, and waits for dinner to drift into her face
    pronouns: 'she/her',
    draw: 2,   // four respondents named her as the beef, so she shows up twice as often as anyone else
    nicks: [['Vi', 60], ['Violet', 20], ['Violence', 15], ['Pro Rage Baiter', 5]],
    build: { length: [3.0, 3.4], radius: [0.115, 0.13] },   // tall and bulky, and then some
    colorsA: [PURPLE], colorsB: [BLACK],   // black stops are unlit in both layers, so the gaps come free
    pattern: { stripe: [0.1, 0.2, 0.4], spot: [1, 0.7, 1], flank: [0.35, 0.2, 0.5], wavy: [0, 1.2], splotch: [0.5, 0.2, 0.4] },
    glow: [0, 0, 0, 1],
    traits: { curious: 1.35, spookMul: 1.4, cover: 1.6, braincellUsage: 0.4, nose: 0.7, stim: 0.7, leap: 0.5, home: 'rock', fears: { eleanor: 0.1 }, spinOdds: 0.6 },
    census: { startle: 'flip', hunt: 'doordash', party: 'exits', twoAM: 'cozy' },
    // spare: the parents are off limits, and so is a ghost, once Chrys is in the pool
    quirks: { headbutt: { every: [40, 90], favorite: 'Bee', favoriteWeight: 3, spare: ['Jim', 'Shelley', 'Chrys'] }, cuddly: true, dominant: true },
  },
  {
    name: 'Bee',   // millennial pink and goldenrod, mottled and thicc; dead asleep at 2 AM, orbits the
                   // snack table, investigates every noise, and is Vi's favorite headbutt target
    pronouns: 'any/all',
    build: { length: [2.0, 2.4], radius: [0.135, 0.155] },   // thicc as hell: the roundest resident
    colorsA: [MILLENNIAL_PINK], colorsB: [GOLDENROD],
    jelly: 0.45,   // fewer shipped varietals than the other two glass rollers, so Bee jellies more
    pattern: { stripe: [0.1, 0.2, 0.4], spot: [1, 0.6, 1], flank: [0.6, 0.3, 0.7], wavy: [0, 1.2], splotch: [0.9, 0.4, 0.8] },
    glow: [1, 1, 0, 0],
    traits: { holdChance: 0.8, holdTime: [8, 25], curious: 1.1, spookMul: 1.2, cover: 1.35, braincellUsage: 0.5, nose: 1.0, stim: 0.4, leap: 0, home: 'pad', fears: { eleanor: 0.4, vi: 0.5 } },
    census: { startle: 'investigate', hunt: 'doordash', party: 'snacks', twoAM: 'asleep' },
    quirks: { follows: 'Jaz', followWeight: 0.3, matchmaker: true, cuddly: true },
  },
  {
    name: 'Heather',   // green and teal, or a Pride flag half the time; tiger over splotches, asleep at
                       // 2 AM, one corner and one friend, turns to investigate instead of fleeing
    pronouns: 'she/her',
    build: { length: [2.6, 3.0], radius: [0.1, 0.12] },
    colorsA: [GREEN], colorsB: [TEAL],
    ramp: { prideFlag: 0.5 },
    pattern: { stripe: [0.9, 0.5, 1], spot: [0.85, 0.4, 0.9], flank: [0.3, 0.2, 0.5], wavy: [1.8, 3], tiger: [0.7, 0.25, 0.5], splotch: [0.85, 0.4, 0.8] },
    glow: [0, 1, 0, 0],
    glowB: [1, 0],   // the tail tip runs its own clock through the ramp: green to teal, or a flag's stripes in order
    // turn is up so the long way round for a right-hand turn is a loop, not a glacial arc.
    traits: { holdChance: 0.8, holdTime: [8, 25], curious: 0.85, cover: 1.1, turn: [7.0, 8.5], braincellUsage: 0.3, nose: 1.0, stim: 0.1, leap: 0.2, home: 'rock', fears: { eleanor: 0.7, vi: 0 } },
    census: { startle: 'investigate', hunt: 'bonk', party: 'corner', twoAM: 'asleep' },
    quirks: { follows: 'Jaz', followWeight: 0.4, leftOnly: true },
  },
  {
    name: 'Marc',   // red and gold bands, a lantern with a pulse in it; here for the vibes not the food,
                    // lunges when he does bother, and wanders slowly looking for an eel who isn't here
    pronouns: 'he/him',
    nicks: [['Marc', 85], ['Marx', 10], ['Moo Deng Xiaopeng Thot', 5]],
    build: { length: [2.0, 2.4], radius: [0.095, 0.11] },
    colorsA: [RED], colorsB: [GOLD],
    // Red-heavy bands repeating 3–5× down the body; skin up so the gold shows between the lit edges.
    ramp: { stops: [{ color: RED, width: 3 }, { color: GOLD, width: 2 }], repeats: [3, 5], skin: 0.35 },
    pattern: { stripe: [0, 0, 0], spot: [0, 0, 0], band: [1, 0.8, 1], flank: [0.25, 0.15, 0.35], wavy: [0, 1] },
    glow: [1, 0, 1, 0],
    traits: { curious: 0.6, spookMul: 0.8, cover: 0.85, hunger: 0.3, persistence: 0.5, attention: [12, 20], prowl: [0.18, 0.28], braincellUsage: 0.8, nose: 0.8, stim: 0.2, leap: 0.15, home: 'log', fears: { eleanor: 0.5 }, spinOdds: 0.2 },
    census: { startle: 'investigate', hunt: 'lunge', party: 'corner', twoAM: 'cozy' },
    // follows Chrys, who is not in the pool, so this stays unrequited
    quirks: { follows: 'Chrys', followWeight: 0.4, sickleRest: true, dinnerCircle: true, wander: true },
  },
  {
    name: 'Eleanor',   // the mega-eel; not in the active rotation, attached as a guest with her own brain
    pronouns: 'she/her',
    active: false,
    dorsalGlow: true,   // dim wavy ridge lights + tail photophore instead of the standard pattern glow
    wet: 0.45,   // the back's moonlit streak, dimmed: at full gain it reads as a third ridge light between her two
    build: { length: [7.5, 8.5], radius: [0.24, 0.28] },   // barely fits under the surface; drifting up breaches
    colorsA: [PURPLE], colorsB: [TEAL],
    pattern: { stripe: [0.4, 0.3, 0.6], spot: [0.9, 0.6, 1], flank: [0.9, 0.6, 1], wavy: [1, 2.5] },
    traits: { spookMul: 0.3, cover: 0.4, turn: [1.2, 1.8], cruise: [0.3, 0.42], prowl: [0.15, 0.25], kind: 'eleanor', braincellUsage: 0.5, nose: 0.4, stim: 0.15, leap: 0, home: 'log', spinOdds: 0, fears: { eleanor: 0, finger: 0, eel: 0, sam: 0 } },
  },
];

const activePool = () => IDENTITIES.filter((i) => i.active !== false);

/* Tickets, not a flat pick: `draw` (default 1) is how many an identity holds, so a ×2 shows up twice as often. */
function weightedPick(rng, pool) {
  let total = 0;
  for (const id of pool) total += id.draw ?? 1;
  let r = rng.next() * total;
  for (const id of pool) { r -= id.draw ?? 1; if (r < 0) return id; }
  return pool[pool.length - 1];
}

/* The residents on screen: pinned names first (?cast=), then a seeded weighted draw without replacement,
   each draw pulling its `follows` chain in behind it. Returns fewer than EEL_COUNT when the pool is smaller. */
export function drawCast(seed, pinned = []) {
  const pool = activePool();
  const cast = [];
  const take = (id) => { if (id && !cast.includes(id)) cast.push(id); };
  for (const name of pinned) {
    if (cast.length >= EEL_COUNT) break;
    const want = String(name).toLowerCase();
    take(pool.find((i) => i.name.toLowerCase() === want));
  }
  const rng = createRng(deriveSeed(seed, 77));
  while (cast.length < EEL_COUNT && cast.length < pool.length) {
    let id = weightedPick(rng, pool.filter((i) => !cast.includes(i)));
    take(id);
    // Walk the chain (Morgan → Jaz → Bee) while there is room; a crush on the guest or on someone
    // retired resolves to nothing, which is the unrequited case, and a mutual pair stops on its own.
    while (id?.quirks?.follows && cast.length < EEL_COUNT) {
      const next = pool.find((i) => i.name === id.quirks.follows);
      if (!next || cast.includes(next)) break;
      take(next);
      id = next;
    }
  }
  return cast;
}

export function absentIdentities(present) {
  const have = new Set(present.map((n) => String(n).toLowerCase()));
  return activePool().filter((i) => !have.has(i.name.toLowerCase()));
}

/* The pool's bench, weighted the same as the boot draw; null once every active identity is on screen. */
export function pickAbsent(rng, present) {
  const away = absentIdentities(present);
  return away.length ? weightedPick(rng, away) : null;
}

export function applyIdentity(e, id, rng) {
  const t = { ...DEFAULT_TRAITS, ...id.traits };
  const b = { ...DEFAULT_BUILD, ...id.build };
  e.name = id.name;
  // Every fear/trust/alarm table is keyed lowercase, and those lookups run in an O(n²) per-tick loop.
  e.nameKey = id.name.toLowerCase();
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
  // The braincell wave's knobs ride on the eel, not inside traits, because modules read them by name.
  // fears merges key by key so an identity's explicit 0 survives as a hard immunity later.
  e.kind = t.kind;
  e.braincellUsage = t.braincellUsage;
  e.nose = t.nose;
  e.stim = t.stim;
  e.leap = t.leap;
  e.home = t.home;
  e.spinOdds = t.spinOdds;
  e.fears = { ...DEFAULT_TRAITS.fears, ...id.traits?.fears };
  e.eats = { ...DEFAULT_TRAITS.eats, ...id.traits?.eats };
  e.quirks = id.quirks || {};
  e.pronouns = id.pronouns ?? '';   // the tag's second line; blank until an identity carries one
  // The four census enums; an absent knob means today's behavior, which is why the old five carry none.
  e.census = id.census ?? {};
}

/* colA/colB still roll: the fallback layer, Eleanor's branch, and her capsules all read them. The ramp
   is the body's truth: the identity's stops, a flag at the odds it declares, or those two colors. */
export function rollIdentityColors(e, id, rng) {
  e.colA = new THREE.Color(...rng.pick(id.colorsA));
  e.colB = new THREE.Color(...rng.pick(id.colorsB));
  const ramp = id.ramp;
  e.flagBands = false;
  // Scales the global skin knob: the neon eels keep their dark gaps, a woven eel shows its whole cloth.
  e.skinMul = ramp?.skin ?? 0.1;
  if (ramp?.stops) {
    e.rampStops = ramp.stops;
    e.rampOpts = ramp;
  } else if (ramp?.prideFlag && rng.chance(ramp.prideFlag === true ? 1 : ramp.prideFlag)) {
    e.rampStops = rng.pick(PRIDE_LIST);
    // A short blend per boundary, and the lit edge widened to ride the blend instead of drawing a line across it.
    e.rampOpts = { soften: 14, edge: 12, ...ramp };
    // Three flags in four fly Jim-style: whole cloth showing, every stripe edge lit; the rest ride the families.
    e.flagBands = rng.chance(0.75);
    if (e.flagBands) e.skinMul = 1;
    // Themed palettes, guarded like every other opt-in: THEMES is empty, so nobody declares this yet.
  } else if (ramp?.themes && rng.chance(ramp.themeChance ?? 1)) {
    e.rampStops = THEMES[weightedPickName(rng, ramp.themes)];
    e.rampOpts = { soften: 6, ...ramp };
  } else {
    e.rampStops = twoToneStops(e.colA.toArray(), e.colB.toArray());
    e.rampOpts = { ...ramp, soften: 1 };
  }
  // The glass roll, guarded like band (no draw unless the identity asks); a quarter fly the rainbow.
  e.jelly = id.jelly ? rng.chance(id.jelly) : false;
  if (e.jelly && rng.chance(0.25)) {
    e.rampStops = PRIDE_FLAGS.rainbow;
    e.rampOpts = { soften: 24 };
  }
  // The name tag wears the main color; a many-stop ramp (tablecloth, flag) picks any stop bright
  // enough to read on the water. getStyle() encodes the working-space value to sRGB for CSS.
  const bright = e.rampStops.length > 2 ? e.rampStops.filter((st) => st.color[0] * 0.3 + st.color[1] * 0.6 + st.color[2] * 0.1 >= 0.2) : [];
  e.nameStyle = (bright.length ? new THREE.Color(...rng.pick(bright).color) : e.colA).getStyle();
}

/* What the name tag says this visit: `nicks` is [[name, weight], ...], rolled like real life (Morgan is
   Mubgub one time in five). `name` stays canonical for bonds and ?cast=; no draw unless there is a choice. */
export function rollNickname(e, id, rng) {
  const nicks = id.nicks;
  if (!nicks || nicks.length < 2) { e.nick = nicks?.[0]?.[0] ?? id.name; return; }
  let total = 0;
  for (const [, w] of nicks) total += w;
  let r = rng.next() * total;
  for (const [n, w] of nicks) { r -= w; if (r < 0) { e.nick = n; return; } }
  e.nick = nicks[nicks.length - 1][0];
}

// Matthew's answers, split 33:33:34 stated:stated:any. The closet is every shipped family at equal odds.
const CLOSET = ['stripe', 'spot', 'band', 'race', 'plaid', 'ridge', 'flank', 'splotch', 'sheen', 'tiger'];
const RGB_CHANCE = 0.35;   // the gamer glow's odds per chaos identity, on top of the wardrobe pick
function chaosKit(rng) {
  const u = rng.next();
  if (u < 0.33) return { stripe: [0, 0, 0], spot: [1, 0.5, 0.9], flank: [0.8, 0.3, 0.7], wavy: [0, 1.4], splotch: [1, 0.5, 0.9] };
  if (u < 0.66) return { stripe: [0, 0, 0], spot: [0, 0, 0], flank: [0, 0, 0], wavy: [0, 1], sheen: [1, 0.5, 0.9] };   // near-solid, wet-leaf sheen
  const kit = { stripe: [0, 0, 0], spot: [0, 0, 0], flank: [0, 0, 0], wavy: [0, 3] };
  kit[rng.pick(CLOSET)] = [1, 0.6, 1];
  if (kit.band) kit.repeats = [2.5, 5];   // banded at repeats 1 on a two-stop ramp splits the body in half
  if (kit.tiger) kit.stripe = [1, 0.6, 1];   // tiger tears the stripe field, so a closet tiger needs stripes to tear
  return kit;
}

/* A side stream for a family that must cost zero draws off the shared rng: one recolor pass rolls every
   eel from one generator, so an appended draw would move the nickname after it and everyone downstream. */
const bits = (v) => Math.round(v * 1e6) | 0;
const subStream = (e, salt) => createRng(deriveSeed(bits(e.wavy) ^ bits(e.pulseRate) ^ bits(e.spotFreq), salt));

/* Pattern spec per family is [chance, lo, hi]: the chance gates the family, lo–hi bounds its weight. */
export function rollIdentityPattern(e, id, rng) {
  const p = id.chaos ? chaosKit(rng) : id.pattern;
  const roll = ([c, lo, hi]) => (rng.chance(c) ? rng.range(lo, hi) : 0);
  e.stripeFreq = rng.range(4, 14);
  e.spotFreq = rng.range(6, 16);
  e.wStripe = roll(p.stripe);
  e.wSpot = roll(p.spot);
  // Skipped entirely rather than rolled against 0, so a bandless identity keeps its old rng stream.
  e.wBand = p.band ? roll(p.band) : 0;
  e.wRace = p.race ? roll(p.race) : 0;
  e.raceOff = p.race ? rng.range(0.55, 0.75) : 0.65;
  e.wPlaid = p.plaid ? roll(p.plaid) : 0;
  e.plaidFreq = p.plaid ? rng.int(2, 3) : 2;
  e.wRidge = p.ridge ? roll(p.ridge) : 0;
  e.wFlank = roll(p.flank);
  e.wavy = rng.range(p.wavy[0], p.wavy[1]);
  e.pulseRate = rng.range(1.5, 4);
  // Same rule as band: no draw unless the identity asks, so the old residents keep their rng streams.
  const rep = id.ramp?.repeats ?? p.repeats;
  e.repeats = rep ? rng.range(rep[0], rep[1]) : 1;
  // Shelley's three families, appended here so every earlier identity's rng stream is byte-identical;
  // same no-draw-unless-declared guard as band and race.
  e.wStars = p.stars ? roll(p.stars) : 0;
  e.starClass = p.stars ? rng.int(0, 2) : 1;
  e.starMetal = p.stars ? (rng.chance(STAR_METAL_ODDS) ? 1 : 0) : 0;
  e.starSeed = p.stars ? rng.range(0, 100) : 0;
  e.wSwirl = p.swirl ? roll(p.swirl) : 0;
  e.swirlFreq = p.swirl ? rng.range(SWIRL_FREQ[0], SWIRL_FREQ[1]) : 2.5;
  e.swirlSeed = p.swirl ? rng.range(0, 100) : 0;
  e.wGlitter = p.glitter ? roll(p.glitter) : 0;
  e.glitterSeed = p.glitter ? rng.range(0, 100) : 0;
  e.facetTilt = p.glitter ? rng.range(FACET_TILT[0], FACET_TILT[1]) : 30;
  // Tiger tears the stripe edges; it modifies the stripe field rather than joining the weights, so it
  // never reaches wSum. Its stream hangs off this roll's own values (see subStream) instead of `rng`.
  e.tigerDeclared = !!p.tiger;
  e.tigerBreak = 0;
  if (p.tiger) {
    const sub = subStream(e, 0x716);
    e.tigerBreak = sub.chance(p.tiger[0]) ? sub.range(p.tiger[1], p.tiger[2]) : 0;
  }
  e.splotchDeclared = !!p.splotch;
  e.wSplotch = 0; e.splotchFreq = 0; e.splotchLevels = 0; e.splotchLit = 0;
  if (p.splotch) {
    const sub = subStream(e, 0x5b1);
    e.wSplotch = sub.chance(p.splotch[0]) ? sub.range(p.splotch[1], p.splotch[2]) : 0;
    e.splotchFreq = sub.range(2.5, 5);
    e.splotchLevels = sub.int(3, 4);
    e.splotchLit = sub.chance(0.5) ? 1 : 0;   // lit interiors or lit outlines, a fresh toss per roll
  }
  e.sheenDeclared = !!p.sheen;
  e.wSheen = 0; e.sheenDrift = 0;
  if (p.sheen) {
    const sub = subStream(e, 0x5ee);
    e.wSheen = sub.chance(p.sheen[0]) ? sub.range(p.sheen[1], p.sheen[2]) : 0;
    e.sheenDrift = sub.range(0.05, 0.12);
  }
  // The two envelopes: tail-own is a flat declaration, and the gamer glow is an independent roll for
  // whoever answered chaos, which is why it keys off id.chaos rather than off a name.
  e.wTailOwn = id.glowB?.[0] ?? 0;
  e.wRgb = id.chaos ? (subStream(e, 0x76b).chance(RGB_CHANCE) ? 1 : 0) : id.glowB?.[1] ?? 0;
  // The pattern roll runs after the color roll, so this is where the tag can take the metal of the night.
  if (p.stars) e.nameStyle = new THREE.Color(...(e.starMetal ? STAR_GOLD : STAR_SILVER)).getStyle();
  e.glowMode = new THREE.Vector4(...(id.glow ?? STEADY_PULSE));
  if (e.flagBands) { e.wStripe = e.wSpot = e.wRace = e.wPlaid = e.wRidge = e.wFlank = e.wSwirl = e.wStars = e.wGlitter = e.wSplotch = e.wSheen = e.tigerBreak = 0; e.wBand = 1; e.repeats = 1; }
  if (e.wStripe + e.wSpot + e.wBand + e.wRace + e.wPlaid + e.wRidge + e.wFlank + e.wSwirl + e.wStars + e.wGlitter + e.wSplotch + e.wSheen === 0) e.wFlank = 1;
}
