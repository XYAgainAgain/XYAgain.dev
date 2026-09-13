/* THREE-free math behind the floating litter: the 47-item cast's layout, the mass-tiered drift with its
   lee field, the substepped station contact, the turning, and the sink. Pure, so the tests can hit them. */

import { createRng, deriveSeed } from './rng.js';
import { upwindEdgeSpawn } from './pollen-core.js';

export const KIND = { STICK: 0, TWIG: 1, LEAF: 2, CHIP: 3, PETAL: 4, CONE: 5, ACORN: 6 };
export const DETRITUS_SALT = 1600;
// One fixed substream per kind: a later kind can be added without reshuffling the cast already placed.
export const SALT = {
  stick: DETRITUS_SALT + 1, twig: DETRITUS_SALT + 2, leaf: DETRITUS_SALT + 3, chip: DETRITUS_SALT + 4,
  petal: DETRITUS_SALT + 5, cone: DETRITUS_SALT + 6, acorn: DETRITUS_SALT + 7,
  life: DETRITUS_SALT + 8, order: DETRITUS_SALT + 9,
};

export const COUNTS = { stick: 6, twig: 6, leaf: 16, chip: 8, petal: 6, cone: 2, acorn: 3 };
export const STICK_POOL = COUNTS.stick + COUNTS.twig;                 // 12
export const CARD_POOL = COUNTS.leaf + COUNTS.chip + COUNTS.petal;    // 30
export const CHUNK_POOL = COUNTS.cone + COUNTS.acorn;                 // 5
export const SHELTER_STICKS = COUNTS.stick;

export const STICK_LEN = [1.0, 1.85], TWIG_LEN = [0.30, 0.85];
export const LEAF_SIZE = [0.25, 0.75], CHIP_SIZE = [0.08, 0.25], PETAL_SIZE = [0.05, 0.12];
// Every branch class can fork; the remaining twig half splits among snaps, side limbs, and plain wood.
export const FORK_CHANCE = 0.50, SNAP_CHANCE = 0.20, STUB_CHANCE = 0.20;
export const MARGIN = 0.6;            // how far past the view rect the cast is laid out and respawned
export const TRIES = 16;

/* Mass tiers, petal > leaf > chip > twig > cone/acorn > stick: a petal is a sail and a waterlogged
   stick barely moves. The nut sits above the stick because it is small and drags almost nothing. */
export const DRIFT_GAIN = [0.28, 0.40, 0.78, 0.55, 1.00, 0.30, 0.30];   // indexed by KIND

export const WIND_FORCE = 0.35;       // units/s² of downwind push at gust 1, before the mass gain
export const DAMP = 2.32;             // 2ω at the specks' ω = 1.16, so litter settles the way they do
export const VMAX = 1.5, AVMAX = 2.5;
export const SPIN_GUST = 1.5;         // rad/s² of seeded wobble at gust 1
export const MAX_DT = 1 / 20;         // the specks' SPECK_DT_MAX: a slept tab must not teleport litter
export const SKIN = 0.02;             // the same clearance floaters' SPECK_SKIN gives a speck off bark
// Eight, not four: the budget has to cover a whole tick at vMax, or a slow frame silently integrates
// less time than it reports and the litter's speed becomes frame-rate dependent.
export const SUBSTEP_MAX = 8, STEP_FLOOR = 0.02;
export const RESOLVE_PASSES = 3;
/* Mirrors the render's 10-row cap/barrel schedule; zero-width tips still probe at SKIN, so physics
   and silhouette agree. */
export const STICK_STATIONS = 10, STICK_INNER = STICK_STATIONS - 2;
export const STICK_CAP = 1.0, STICK_CAP_MAX = 0.25;   // uCap and uCapMax: the round end is one half-width long
export const STUB_STATIONS = 2;
export const STATION_SLOTS = STICK_STATIONS + STUB_STATIONS;
// Two interior samples cover the longer fork limbs without reviving their zero-width tips.
export const stubStationT = (i) => (i + 1) / (STUB_STATIONS + 1);
export const STICK_TORQUE = 6;
export const RETIRE_GAP = 1;          // seconds between retirements, so the sink tray never floods
// Four, not three: a frame-boundary spawn and cleanup together must not silently drop a sinking leaf.
export const TRAY_SLOTS = 4;

/* Only wood rings the water: a leaf is a sail thin enough to ride the ripples it arrives on, while a
   nut sits deep enough to push a little. Indexed by KIND. */
export const WAKE_KIND = [1, 1, 0, 0, 0, 0.8, 0.8];
export const WAKE_MIN_SPEED = 0.05, WAKE_MIN_STRENGTH = 0.004;
export const WAKE_RADIUS = [0.15, 0.70], WAKE_IMPACT_RADIUS = 0.25;
export const WAKE_SLOTS = 16;         // wakes one tick may publish, so a pileup cannot flood the injector
export const IMPACT_GAP = 0.5;        // an impact waits half the drift gap: a collision outranks a bow wave
export const PAIR_SKIN = 0.01;

export const RING_CAP = 24, RING_BAND = 0.12, RING_MAX_R = 2.5;
export const MAT_EPS = 0.03, MAT_PASSES = 4;
// The meter has to outlast the half second a card takes to limp back into the fronds, or the damping
// strobes off between touches instead of holding it at the rim.
export const MAT_RELEASE = 1.5;

export const LEE_REACH = 0.6, LEE_GUST_MIN = 0.05, LEE_POW = 1.5;
export const CONTACT_HITS = 4;        // colliders one 0.6 probe may overlap at this pond's spacing

/* The hand, as the water feels it. A palm is about 0.1 m across and this pond runs about 0.3 m to the
   unit, so the solid part is a third of a unit wide and drags a slug of water roughly twice that. */
export const HAND_RADIUS = 0.17, HAND_REACH = 0.55;
export const HAND_RESIST_FLOOR = 0.012;  // nothing is zero-resistance, and it keeps the divide finite
export const HAND_GRIP_REF = 0.1;        // the resistance a shove transfers whole: about a stick's thickness
export const HAND_SPEED_MAX = 2.4;       // cursor speed the push saturates at, so a flick is not a railgun

export const SINK = { NONE: 0, CROSS: 1, FALL: 2, REST: 3, FADE: 4 };
/* Buoyancy uses the card's vertical half-extent; using leaf width made broad leaves sink faster
   than petals. */
export const SINK_RADIUS = 0.05;

const LEAF_FRESH = 0.15;
/* Linear multipliers over a near-neutral warm tan tile, which is why the yellows run past 1: the tile
   carries the veins and the silhouette, this carries the whole of the color. */
const LEAF_AUTUMN = [
  [1.05, 0.72, 0.30],   // ochre
  [0.92, 0.48, 0.26],   // russet
  [0.74, 0.34, 0.24],   // red-brown
  [1.22, 1.05, 0.42],   // bright yellow
  [0.70, 0.74, 0.38],   // olive
  [1.15, 1.06, 0.84],   // pale straw
  [0.52, 0.38, 0.28],   // dark brown
  [1.00, 0.60, 0.34],   // tawny
];
const LEAF_GREEN = [[0.56, 0.86, 0.44], [0.68, 0.80, 0.40]];
const CHIP_COLOR = [[0.34, 0.26, 0.20], [0.46, 0.34, 0.24], [0.26, 0.21, 0.18], [0.40, 0.29, 0.26]];
const TINT_MAX = 1.5;
// Species: willow long and thin, alder/birch oval, maple lobed. Tiles 0–3, the middle species owning two.
// Aspect is length/width, never under 1, which is the instance layout's own convention.
const SPECIES_ASPECT = [[3.2, 5.0], [1.3, 1.7], [1.0, 1.2]];
const CHIP_ASPECT = [1.4, 2.2], PETAL_ASPECT = [1.8, 2.6];

const DEFAULT_LIFETIME = {
  leaf: [150, 300], petal: [120, 240], chip: [300, 600],
  // Sticks and the chunky pair never retire on screen, so these are inert; they stay so the roll is total.
  twig: [900, 1500], stick: [1200, 2100], chunky: [1500, 2400],
};

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;

/* The live dials. Sam is still deciding the lee strength, the turning, the counts, and whether the
   shelter sticks read paler, so every one of these is a knob and none of them is a constant. */
export function detritusKnobs() {
  return {
    leeDriftGain: 0.3, leeAngularDamping: 2.2,
    // The pollen grains' own K.cur. Litter used to chase the raw curl at gain 1 and surged past the
    // duckweed it floats among; matching the grains puts the whole surface on one flow.
    currentGain: 0.12,
    slopeGain: 1.5,          // downslope push from the analytic swell: the CPU's only read of the water's shape
    // Over SPIN_GUST on purpose: the seeded spin is a constant bias per piece, and a vane weaker than it
    // has no fixed point at all, so a leaf would just keep rolling instead of settling across the wind.
    vaneTorque: 2.5,
    shearTorque: 0.8,        // current difference across a long body, about its own lateral axis
    wobbleTorque: 0.4,       // the seeded slow turn that keeps nothing in the cast perfectly still
    cardAngularDamp: 1.1,    // a card spins up far more freely than a stick
    matDamp: 3.0,            // extra linear damping while a card is caught on a duckweed edge
    ringSpeed: 1.0, ringGain: 1.5,   // how a rain drop's or a tap's ring travels, and how hard it shoves
    // Reference buoyancy drives descent; sinkFood supplies flutter. These values yield about 0.12 units/s
    // in a 0.8-unit pond, so sinkGravity is scene-scaled rather than Earth gravity.
    sinkGravity: 0.30, sinkDensity: 1.05,
    crossFor: 0.35, restFor: 5, goneFor: 1, swayIn: 1.2, sway: 0.09,
    // Seconds per kind, read at every lifetime roll, so a change takes hold on the next retirement.
    lifetime: Object.fromEntries(Object.entries(DEFAULT_LIFETIME).map(([k, v]) => [k, [...v]])),
    // What a moving stick does to the water it displaces, and what it does to whatever it runs into.
    wakeDrift: 1.0, wakeImpact: 3.0, wakeMax: 0.12, wakeGap: 0.25,
    pairRestitution: 0.15, pairTorque: 2.5,
    /* The swish. handDrag folds half the water density, the drag coefficient, and the wood's own density
       into one number: ½ × Cd × ρwater / ρwood, about 1.1 for hardwood, then divided by thickness. */
    handDrag: 1.1, handRestitution: 0.32, handTorque: 1.1, handVMax: 2.5,
    // A wet leaf is plastered to the film across its whole span: raise this and leaves cling harder.
    cardCling: 1.0,
    vMax: 2.5,               // a hand can throw litter faster than any breeze ever will
    // Read once, at layout: a relayout is what applies a change to these two.
    chunkySize: [0.06, 0.14],
    species: [1, 1, 1],
    shelterTint: 0,   // how much paler the six shelter sticks read; the render side takes it as a uniform
  };
}

function smoothstep01(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / ((e1 - e0) || 1e-9)));
  return t * t * (3 - 2 * t);
}

export function wrapAngle(a) {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
}

/* The reusable result the contact helper fills: the deepest overlap in nx/nz/depth, and every overlap
   in hits (×3: nx, nz, depth) so the lee field can sum the colliders it stands between. */
export function makeContactOut(cap = CONTACT_HITS) {
  return { nx: 1, nz: 0, depth: 0, n: 0, hits: new Float32Array(cap * 3) };
}

export function lifeBucket(kind) {
  if (kind === KIND.STICK) return 'stick';
  if (kind === KIND.TWIG) return 'twig';
  if (kind === KIND.LEAF) return 'leaf';
  if (kind === KIND.CHIP) return 'chip';
  if (kind === KIND.PETAL) return 'petal';
  return 'chunky';
}

export function rollLifetime(rng, kind, knobs) {
  const b = lifeBucket(kind);
  const span = knobs?.lifetime?.[b] ?? DEFAULT_LIFETIME[b];
  return rng.range(span[0], span[1]);
}

/* The shader's capT, and where row i lands along the stick. Row 0 and the last row are the tips. */
export function stickCapT(len, halfWidth) {
  return Math.min(STICK_CAP_MAX, Math.max(1e-4, halfWidth * STICK_CAP / Math.max(1e-4, len)));
}

export function stickRowT(i, len, halfWidth) {
  if (i <= 0) return 0;
  if (i >= STICK_STATIONS - 1) return 1;
  const capT = stickCapT(len, halfWidth);
  return capT + ((i - 1) / (STICK_INNER - 1)) * (1 - 2 * capT);
}

export function stickRowWidth(i, halfWidth) {
  return (i <= 0 || i >= STICK_STATIONS - 1) ? 0 : halfWidth;
}

/* The pinned centerline: lateral offset at t along a stick, on the lateral axis (uz, -ux). One bow, one
   double bow for the de-straightening, and a hinge past kinkT for the snapped and forked ones. */
export function stickLat(item, t) {
  return item.bow * Math.sin(Math.PI * t)
    + item.bow2 * Math.sin(2 * Math.PI * t)
    + item.kinkAmp * item.len * Math.max(0, t - item.kinkT);
}

function place(rng, rect, blocked) {
  let x = 0, z = 0;
  for (let t = 0; t < TRIES; t++) {
    x = rng.range(-rect.ex, rect.ex); z = rng.range(-rect.ez, rect.ez);
    if (!blocked(x, z)) return { x, z };
  }
  // Budget spent: leave it where it landed and let the first resolve walk it out of the rock.
  return { x, z };
}

function pickWeighted(rng, weights) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return 0;
  let t = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    t -= weights[i] > 0 ? weights[i] : 0;
    if (t <= 0) return i;
  }
  return weights.length - 1;
}

function baseItem(id, kind, x, z, rng, knobs) {
  return {
    id, kind, x, z, vx: 0, vz: 0, angle: rng.range(-Math.PI, Math.PI), av: 0,
    age: 0, lifetime: rollLifetime(rng, kind, knobs), voidT: 0, seed: rng.next(),
    stick: false, long: false, card: false, caught: 0, halfWidth: 0, minR: 0, wakeAt: -1e9, hitAt: -1e9,
  };
}

function makeStick(rng, kind, lenRange, ctx, id) {
  const len = rng.range(lenRange[0], lenRange[1]);
  const p = place(rng, ctx.rect, ctx.blocked);
  const it = baseItem(id, kind, p.x, p.z, rng, ctx.knobs);
  const shelter = kind === KIND.STICK;
  // A shelter stick is a fallen branch, not a twig: thicker, and thick enough to read as cover.
  const raw = Math.min(0.045, Math.max(0.012, len * rng.range(0.018, 0.030)));
  const halfWidth = shelter ? raw * 1.6 : raw;
  // Thirteen unit rolls in a fixed order, every one drawn whatever shape wins, so a fork on this twig
  // cannot shift a single value the next one reads.
  const fam = rng.next();
  const bowSign = rng.next() < 0.5 ? 1 : -1, bowU = rng.next();
  const bow2Sign = rng.next() < 0.5 ? 1 : -1, bow2U = rng.next();
  const stubTU = rng.next(), stubLU = rng.next(), stubWU = rng.next();
  const stubYawSign = rng.next() < 0.5 ? 1 : -1, stubYawU = rng.next();
  const kinkTU = rng.next(), kinkAU = rng.next(), kinkSign = rng.next() < 0.5 ? 1 : -1;
  let stubT = 0, stubLen = 0, stubYaw = 0, stubWidth = 0, kinkT = 0, kinkAmp = 0, snapped = 0;
  if (fam < FORK_CHANCE) {
    stubT = lerp(shelter ? 0.62 : 0.68, shelter ? 0.82 : 0.88, stubTU);
    stubLen = len * lerp(shelter ? 0.30 : 0.20, shelter ? 0.60 : 0.75, stubLU);
    stubWidth = halfWidth * lerp(shelter ? 0.65 : 0.55, 0.95, stubWU);
    stubYaw = stubYawSign * lerp(0.48, shelter ? 0.95 : 1.08, stubYawU);
  }
  if (shelter) {
    // Shelter forks may also carry a mild gnarl, but stay whole enough to read as cover.
    if (kinkTU < 0.5) { kinkT = lerp(0.30, 0.70, kinkTU * 2); kinkAmp = kinkSign * Math.tan(lerp(4, 12, kinkAU) * DEG); }
  } else if (fam >= FORK_CHANCE && fam < FORK_CHANCE + SNAP_CHANCE) {
    kinkT = lerp(0.30, 0.70, kinkTU);
    kinkAmp = kinkSign * Math.tan(lerp(15, 40, kinkAU) * DEG);
    snapped = 1;
  } else if (fam >= FORK_CHANCE + SNAP_CHANCE && fam < FORK_CHANCE + SNAP_CHANCE + STUB_CHANCE) {
    stubT = lerp(0.12, 0.30, stubTU);
    stubLen = len * lerp(0.25, 0.50, stubLU);
    stubWidth = halfWidth * lerp(0.60, 0.85, stubWU);
    stubYaw = stubYawSign * lerp(0.61, 1.22, stubYawU);
  }
  // Separate silhouette families keep the two sine terms from making every branch the same soft hook.
  const curveMode = Math.min(3, Math.floor(bowU * 4));
  const curveU = bowU * 4 - curveMode;
  let bow, bow2;
  if (curveMode === 0) {
    bow = bowSign * len * lerp(0.003, 0.018, curveU);
    bow2 = bow2Sign * len * lerp(0, 0.008, bow2U);
  } else if (curveMode === 1) {
    bow = bowSign * len * lerp(0.07, 0.17, curveU);
    bow2 = bow2Sign * len * lerp(0, 0.018, bow2U);
  } else if (curveMode === 2) {
    bow = bowSign * len * lerp(0.005, 0.035, bow2U);
    bow2 = bow2Sign * len * lerp(0.05, 0.11, curveU);
  } else {
    bow = bowSign * len * lerp(0.04, 0.12, curveU);
    bow2 = bow2Sign * len * lerp(0.035, 0.09, bow2U);
  }
  it.stick = true;
  it.shelter = shelter;
  it.len = len;
  it.halfWidth = halfWidth;
  it.curveMode = curveMode;
  it.bow = bow;
  it.bow2 = bow2;
  it.kinkT = kinkT;
  it.kinkAmp = kinkAmp;
  it.snapped = snapped;
  it.roll = rng.range(-0.35, 0.35);
  it.stubT = stubT;
  it.stubLen = stubLen;
  it.stubYaw = stubYaw;
  it.stubWidth = stubWidth;
  // Every probe is widened by SKIN, so a zero-width tip row still sweeps that much: the anti-tunneling
  // bound is the smallest effective radius, not the smallest drawn one.
  let minR = Infinity;
  for (let i = 0; i < STICK_STATIONS; i++) minR = Math.min(minR, Math.max(SKIN, stickRowWidth(i, halfWidth)));
  if (it.stubLen > 0) for (let i = 0; i < STUB_STATIONS; i++) {
    minR = Math.min(minR, Math.max(SKIN, it.stubWidth * (1 - stubStationT(i))));
  }
  it.minR = minR;
  return it;
}

function makeCard(rng, kind, sizeRange, ctx, id) {
  const size = rng.range(sizeRange[0], sizeRange[1]);
  const p = place(rng, ctx.rect, ctx.blocked);
  const it = baseItem(id, kind, p.x, p.z, rng, ctx.knobs);
  let aspect, tile, curl, col;
  if (kind === KIND.LEAF) {
    const sp = pickWeighted(rng, ctx.knobs.species ?? [1, 1, 1]);
    aspect = rng.range(SPECIES_ASPECT[sp][0], SPECIES_ASPECT[sp][1]);
    tile = sp === 0 ? 0 : sp === 1 ? (rng.chance(0.5) ? 1 : 2) : 3;
    curl = rng.range(0.35, 0.90);
    const pal = rng.next() < LEAF_FRESH ? LEAF_GREEN : LEAF_AUTUMN;
    col = pal[Math.floor(rng.next() * pal.length)];
  } else if (kind === KIND.CHIP) {
    aspect = rng.range(CHIP_ASPECT[0], CHIP_ASPECT[1]);
    tile = rng.chance(0.5) ? 4 : 5;
    curl = rng.range(0.50, 1.00);
    col = CHIP_COLOR[Math.floor(rng.next() * CHIP_COLOR.length)];
  } else {
    aspect = rng.range(PETAL_ASPECT[0], PETAL_ASPECT[1]);
    tile = 6;
    curl = rng.range(0.60, 1.00);
    // The petal tile is greyscale: the shedding lily's own color arrives here once lilies drop petals.
    col = [1, 1, 1];
  }
  const jitter = kind === KIND.PETAL ? 0 : rng.range(-0.06, 0.06);
  it.long = kind === KIND.LEAF || kind === KIND.CHIP;
  it.card = true;
  it.size = size;
  it.aspect = aspect;
  it.tile = tile;
  it.curl = curl;
  it.r = Math.max(0, Math.min(TINT_MAX, col[0] + jitter));
  it.g = Math.max(0, Math.min(TINT_MAX, col[1] + jitter));
  it.b = Math.max(0, Math.min(TINT_MAX, col[2] + jitter));
  it.halfL = size * 0.5;
  it.halfWidth = it.halfL / aspect;
  it.minR = it.halfWidth;
  resetSink(it);
  it.sway = rng.range(0, Math.PI * 2);
  return it;
}

function makeChunk(rng, kind, ctx, id) {
  const span = ctx.knobs.chunkySize ?? [0.06, 0.14];
  const size = rng.range(span[0], span[1]);
  const p = place(rng, ctx.rect, ctx.blocked);
  const it = baseItem(id, kind, p.x, p.z, rng, ctx.knobs);
  it.size = size;
  it.kindT = kind === KIND.CONE ? 0 : 1;
  // The body's max radius, which the lathe's height derives from; size is the across measure.
  it.radius = size * 0.5;
  it.halfWidth = it.radius;
  it.minR = it.halfWidth;
  return it;
}

// Fisher-Yates in place, so a ladder cut on the tail thins every kind in the draw evenly.
function shuffle(rng, arr, from = 0) {
  for (let i = arr.length - 1; i > from; i--) {
    const j = from + Math.floor(rng.next() * (i + 1 - from));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}

/* The whole cast, laid out over the boot rect. Sticks come shelter-first (they are never cut at any
   rung) with the twigs shuffled behind them; cards and chunky are shuffled outright. */
export function layoutDetritus(seed, ctx) {
  const knobs = ctx.knobs ?? detritusKnobs();
  const rect = ctx.rect;
  const blocked = ctx.blocked ?? (() => false);
  const c = { rect, blocked, knobs };
  const sticks = [], cards = [], chunky = [];

  const rs = createRng(deriveSeed(seed, SALT.stick));
  for (let i = 0; i < COUNTS.stick; i++) sticks.push(makeStick(rs, KIND.STICK, STICK_LEN, c, i));
  const rt = createRng(deriveSeed(seed, SALT.twig));
  for (let i = 0; i < COUNTS.twig; i++) sticks.push(makeStick(rt, KIND.TWIG, TWIG_LEN, c, COUNTS.stick + i));

  const rl = createRng(deriveSeed(seed, SALT.leaf));
  for (let i = 0; i < COUNTS.leaf; i++) cards.push(makeCard(rl, KIND.LEAF, LEAF_SIZE, c, i));
  const rc = createRng(deriveSeed(seed, SALT.chip));
  for (let i = 0; i < COUNTS.chip; i++) cards.push(makeCard(rc, KIND.CHIP, CHIP_SIZE, c, COUNTS.leaf + i));
  const rp = createRng(deriveSeed(seed, SALT.petal));
  for (let i = 0; i < COUNTS.petal; i++) cards.push(makeCard(rp, KIND.PETAL, PETAL_SIZE, c, COUNTS.leaf + COUNTS.chip + i));

  const rn = createRng(deriveSeed(seed, SALT.cone));
  for (let i = 0; i < COUNTS.cone; i++) chunky.push(makeChunk(rn, KIND.CONE, c, i));
  const ra = createRng(deriveSeed(seed, SALT.acorn));
  for (let i = 0; i < COUNTS.acorn; i++) chunky.push(makeChunk(ra, KIND.ACORN, c, COUNTS.cone + i));

  const ro = createRng(deriveSeed(seed, SALT.order));
  shuffle(ro, sticks, COUNTS.stick);
  shuffle(ro, cards);
  shuffle(ro, chunky);
  return { sticks, cards, chunky };
}

/* Contact stations mirror render rows. The snapped pinch is deliberately conservative because it
   only narrows the drawn geometry. */
export function stationsFor(item, out) {
  const ux = Math.sin(item.angle), uz = Math.cos(item.angle);
  if (item.stick) {
    for (let i = 0; i < STICK_STATIONS; i++) {
      const v = stickRowT(i, item.len, item.halfWidth);
      const along = (v - 0.5) * item.len;
      const lat = stickLat(item, v);
      const o = i * 3;
      out[o] = item.x + ux * along + uz * lat;
      out[o + 1] = item.z + uz * along - ux * lat;
      out[o + 2] = stickRowWidth(i, item.halfWidth);
    }
    if (!(item.stubLen > 0)) return STICK_STATIONS;
    const av = item.stubT;
    const aa = (av - 0.5) * item.len, ab = stickLat(item, av);
    const bx = item.x + ux * aa + uz * ab, bz = item.z + uz * aa - ux * ab;
    const sa = item.angle + item.stubYaw;
    for (let i = 0; i < STUB_STATIONS; i++) {
      const t = stubStationT(i), o = (STICK_STATIONS + i) * 3;
      out[o] = bx + Math.sin(sa) * item.stubLen * t;
      out[o + 1] = bz + Math.cos(sa) * item.stubLen * t;
      out[o + 2] = item.stubWidth * (1 - t);
    }
    return STICK_STATIONS + STUB_STATIONS;
  }
  out[0] = item.x; out[1] = item.z; out[2] = item.halfWidth;
  if (!item.long) return 1;
  /* Pulling the end circles inward by halfWidth makes the capsule exact length and collapses a round
     leaf to one circle. */
  const h = Math.max(0, item.halfL - item.halfWidth);
  out[3] = item.x + ux * h; out[4] = item.z + uz * h; out[5] = item.halfWidth;
  out[6] = item.x - ux * h; out[7] = item.z - uz * h; out[8] = item.halfWidth;
  return 3;
}

/* Height gradient of the analytic swell at xz, the CPU twin of shading.makeSwell: the only read the CPU
   gets of the water's own shape, since the GPU heightfield is never read back. */
export function swellSlope(x, z, t, waves, phases, swell, out) {
  out.x = 0; out.z = 0;
  if (!waves || !phases) return out;
  const n = Math.min(waves.length, phases.length);
  const tide = Math.sin(t * 0.045) * 0.35 + 0.85;
  let sx = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const w = waves[i], ph = phases[i];
    const arg = (x * w.x + z * w.y) * w.z - t * ph.y + ph.x;
    const a = w.w * swell * (Math.sin(t * ph.z + ph.w) * 0.5 + 0.65) * tide;
    const d = Math.cos(arg) * a * w.z;
    sx += d * w.x; sz += d * w.y;
  }
  out.x = sx; out.z = sz;
  return out;
}

/* The reference sim's percentUnderWater, with y flipped to a positive-down depth: a card whose center sits
   on the plane is half under, and one a buoyancy radius down is fully under. */
export function underWater(depth, radius) {
  const r = Math.max(1e-4, radius);
  return Math.max(0, Math.min(1, (r + depth) / (2 * r)));
}

/* Where gravity and drag balance at full submergence, which is the fall speed the two dials buy. */
export function sinkTerminal(knobs) {
  const g = knobs?.sinkGravity ?? 0.30;
  const bs = 1 / Math.max(1e-3, knobs?.sinkDensity ?? 1.05);
  return Math.sqrt(Math.max(0, g * (1 - bs)));
}

export function makeRingList(cap = RING_CAP) {
  return {
    cap, n: 0,
    x: new Float32Array(cap), z: new Float32Array(cap),
    r0: new Float32Array(cap), t0: new Float32Array(cap), s: new Float32Array(cap),
  };
}

/* A rain drop or a finger tap, as an expanding circle of shove. Full list: the oldest ring goes, since
   it is also the widest and the weakest. */
export function pushRing(L, x, z, strength, radius, now) {
  let i = L.n;
  if (i >= L.cap) {
    i = 0;
    for (let j = 1; j < L.n; j++) if (L.t0[j] < L.t0[i]) i = j;
  } else L.n++;
  L.x[i] = x; L.z[i] = z; L.s[i] = strength;
  L.r0[i] = Math.max(0, radius || 0); L.t0[i] = now;
  return i;
}

export function pruneRings(L, now, speed) {
  for (let i = L.n - 1; i >= 0; i--) {
    if (L.r0[i] + speed * (now - L.t0[i]) <= RING_MAX_R) continue;
    const last = --L.n;
    L.x[i] = L.x[last]; L.z[i] = L.z[last]; L.r0[i] = L.r0[last]; L.t0[i] = L.t0[last]; L.s[i] = L.s[last];
  }
  return L.n;
}

/* Scaled by speed divided by band width so a full crossing delivers strength × gain worth of
   velocity, regardless of band width. */
export function ringPush(L, x, z, now, speed, gain, out) {
  out.x = 0; out.z = 0;
  if (!L.n) return out;
  const norm = speed / (2 * RING_BAND);
  for (let i = 0; i < L.n; i++) {
    const dx = x - L.x[i], dz = z - L.z[i];
    const r = Math.sqrt(dx * dx + dz * dz);
    const R = L.r0[i] + speed * (now - L.t0[i]);
    if (Math.abs(r - R) > RING_BAND) continue;
    const g = L.s[i] * gain * norm / (Math.sqrt(Math.max(0.2, r)) * Math.max(1e-4, r));
    out.x += dx * g; out.z += dz * g;
  }
  return out;
}

/* Resolves penetration while preserving tangential velocity; long-axis station offsets also
   produce contact torque. */
export function resolveStations(item, ctx) {
  const st = ctx.stations, out = ctx.out, contact = ctx.contact;
  const lever = item.stick ? item.len : (item.long ? item.halfL * 2 : 0);
  const leverK = lever > 0 ? STICK_TORQUE / (lever * lever) : 0;
  let hits = 0;
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    const n = stationsFor(item, st);
    let moved = 0, deep = 0, dnx = 0, dnz = 0, torque = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const sx = st[o], sz = st[o + 1];
      if (!contact(sx, sz, st[o + 2] + SKIN, out)) continue;
      const d = out.depth;
      if (!(d > 0)) continue;
      const nx = out.nx, nz = out.nz;
      // Lever arm off the center the stations were measured from; nothing moves until the pass is over.
      if (leverK) torque += (nx * d * (sz - item.z) - nz * d * (sx - item.x)) * leverK;
      if (d > deep) { deep = d; dnx = nx; dnz = nz; }
      moved++; hits++;
    }
    if (!moved) break;
    // One correction a pass, the deepest one. Applying every overlapping station's own depth in turn
    // ejected a stick lodged in a log by several times the real overlap, hard enough to throw it off frame.
    item.x += dnx * deep; item.z += dnz * deep;
    item.av += torque;
    // One projection, against the deepest contact: killing each station's own normal in turn spends the
    // tangential speed on the geometry, and a leaf across a small stone lost 99% of it and caught there.
    ctx.hitNx = dnx; ctx.hitNz = dnz; ctx.hitVx = item.vx; ctx.hitVz = item.vz;   // the contract's read point
    const vn = item.vx * dnx + item.vz * dnz;
    if (vn < 0) { item.vx -= vn * dnx; item.vz -= vn * dnz; }
  }
  if (item.av > AVMAX) item.av = AVMAX; else if (item.av < -AVMAX) item.av = -AVMAX;
  return hits;
}

/* Waterline footprint, which is what the water feels: a ribbon's planform, a card's, or a nut's disc. */
export function itemMass(item) {
  if (item.stick) return item.len * item.halfWidth * 2;
  if (item.card) return item.halfL * item.halfWidth * 4;
  const r = item.radius ?? item.halfWidth;
  return Math.PI * r * r;
}

export function wakeRadius(item) {
  const span = item.stick ? item.len * 0.35 : (item.halfL ?? item.radius ?? 0.1) * 1.2;
  return Math.max(WAKE_RADIUS[0], Math.min(WAKE_RADIUS[1], span));
}

/* A piece under way pushes a bow wave. Rate-limited per item, because the injector wants one batched
   drop now and then, not a fresh ring every tick of a slow drift. */
export function driftWake(item, ctx, now) {
  const kind = WAKE_KIND[item.kind] ?? 0;
  if (!(kind > 0) || !ctx.wake) return 0;
  if (now - item.wakeAt < ctx.knobs.wakeGap) return 0;
  const sp = Math.hypot(item.vx, item.vz);
  if (sp < WAKE_MIN_SPEED) return 0;
  const s = Math.min(ctx.knobs.wakeMax, ctx.knobs.wakeDrift * itemMass(item) * kind * sp * ctx.ms);
  if (!(s > WAKE_MIN_STRENGTH)) return 0;
  item.wakeAt = now;
  ctx.wake(item.x, item.z, wakeRadius(item), s, 0);
  return s;
}

/* The shove a resolve already spent on a rock or log becomes wake: the killed normal velocity is
   exactly the momentum that had to go somewhere. Its own shorter gate catches splashes the drift's would miss. */
export function impactWake(item, ctx, now) {
  const kind = WAKE_KIND[item.kind] ?? 0;
  if (!(kind > 0) || !ctx.wake) return 0;
  if (now - item.hitAt < ctx.knobs.wakeGap * IMPACT_GAP) return 0;
  // Only the normal speed the resolve killed. The whole tick's velocity change also carries the wind, the
  // damping, and every ring, so a card sitting on a rock in the rain published splashes it never earned.
  const vn = ctx.hitVx * ctx.hitNx + ctx.hitVz * ctx.hitNz;
  const dv = vn < 0 ? -vn : 0;
  if (dv < WAKE_MIN_SPEED) return 0;
  const s = Math.min(ctx.knobs.wakeMax, ctx.knobs.wakeImpact * itemMass(item) * kind * dv * ctx.ms);
  if (!(s > WAKE_MIN_STRENGTH)) return 0;
  item.hitAt = now; item.wakeAt = now;
  ctx.wake(item.x, item.z, WAKE_IMPACT_RADIUS, s, 1);
  return s;
}

/* Closest approach of two segments, clamped at both ends, as the point on each. Two parallel sticks
   meet across their overlap rather than at an intersection that lies off both of them. */
export function segmentClosest(a0x, a0z, a1x, a1z, b0x, b0z, b1x, b1z, out) {
  const ux = a1x - a0x, uz = a1z - a0z, vx = b1x - b0x, vz = b1z - b0z;
  const wx = a0x - b0x, wz = a0z - b0z;
  const a = ux * ux + uz * uz, b = ux * vx + uz * vz, c = vx * vx + vz * vz;
  const d = ux * wx + uz * wz, e = vx * wx + vz * wz;
  const den = a * c - b * b;
  let s = den > 1e-9 ? (b * e - c * d) / den : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  let t = c > 1e-9 ? (b * s + e) / c : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  // Re-solving s against the clamped t is what keeps a tip-to-barrel touch on both segments.
  s = a > 1e-9 ? (b * t - d) / a : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  out.ax = a0x + ux * s; out.az = a0z + uz * s;
  out.bx = b0x + vx * t; out.bz = b0z + vz * t;
  out.s = s; out.t = t;
  out.dist = Math.hypot(out.ax - out.bx, out.az - out.bz);
  return out;
}

/* The two drawn tips of a stick's centerline, which is the capsule the pair test collides. */
export function stickEnds(item, out) {
  const ux = Math.sin(item.angle), uz = Math.cos(item.angle);
  const h = item.len * 0.5, lat1 = stickLat(item, 1);
  out.x0 = item.x - ux * h; out.z0 = item.z - uz * h;
  out.x1 = item.x + ux * h + uz * lat1; out.z1 = item.z + uz * h - ux * lat1;
  return out;
}

/* Stick against stick over the whole 12-item pool: 66 capsule tests a frame, bounded by the pool rather
   than the scene. Mass is planform area, so a fallen branch shoves a twig aside and hardly slows. */
export function resolveStickPairs(sticks, ctx, count = sticks.length) {
  const seg = ctx.seg, eA = ctx.endsA, eB = ctx.endsB;
  const k = ctx.knobs;
  const n = Math.min(count, sticks.length);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const A = sticks[i];
    stickEnds(A, eA);
    const mA = itemMass(A);
    // A kinked tip swings well off the straight chord, so the box has to carry that lateral offset too or
    // snapped sticks pass clean through each other.
    const latA = Math.abs(stickLat(A, 1));
    for (let j = i + 1; j < n; j++) {
      const B = sticks[j];
      const reach = (A.len + B.len) * 0.5 + A.halfWidth + B.halfWidth + latA + Math.abs(stickLat(B, 1));
      if (Math.abs(A.x - B.x) > reach || Math.abs(A.z - B.z) > reach) continue;
      stickEnds(B, eB);
      segmentClosest(eA.x0, eA.z0, eA.x1, eA.z1, eB.x0, eB.z0, eB.x1, eB.z1, seg);
      const rSum = A.halfWidth + B.halfWidth + PAIR_SKIN;
      const depth = rSum - seg.dist;
      if (!(depth > 0)) continue;
      const mB = itemMass(B);
      let nx = seg.ax - seg.bx, nz = seg.az - seg.bz;
      const d = Math.hypot(nx, nz);
      // Dead-center overlap has no normal of its own; the axis between the centers is the honest guess.
      if (d > 1e-6) { nx /= d; nz /= d; } else {
        const cx = A.x - B.x, cz = A.z - B.z, cd = Math.hypot(cx, cz);
        if (cd > 1e-6) { nx = cx / cd; nz = cz / cd; } else { nx = 1; nz = 0; }
      }
      const total = mA + mB;
      const wA = mB / total, wB = mA / total;
      A.x += nx * depth * wA; A.z += nz * depth * wA;
      B.x -= nx * depth * wB; B.z -= nz * depth * wB;
      const vn = (A.vx - B.vx) * nx + (A.vz - B.vz) * nz;
      const px = (seg.ax + seg.bx) * 0.5, pz = (seg.az + seg.bz) * 0.5;
      if (vn < 0) {
        const jn = -(1 + k.pairRestitution) * vn * (mA * mB) / total;
        A.vx += (jn / mA) * nx; A.vz += (jn / mA) * nz;
        B.vx -= (jn / mB) * nx; B.vz -= (jn / mB) * nz;
        const spinA = jn * (nx * (pz - A.z) - nz * (px - A.x));
        const spinB = jn * (nx * (pz - B.z) - nz * (px - B.x));
        A.av += spinA * k.pairTorque / (mA * A.len * A.len);
        B.av -= spinB * k.pairTorque / (mB * B.len * B.len);
        if (A.av > AVMAX) A.av = AVMAX; else if (A.av < -AVMAX) A.av = -AVMAX;
        if (B.av > AVMAX) B.av = AVMAX; else if (B.av < -AVMAX) B.av = -AVMAX;
        if (ctx.wake) {
          const s = Math.min(k.wakeMax, k.wakeImpact * (mA * mB / total) * -vn * ctx.ms);
          if (s > WAKE_MIN_STRENGTH && ctx.t - Math.max(A.hitAt, B.hitAt) >= k.wakeGap * IMPACT_GAP) {
            A.hitAt = ctx.t; B.hitAt = ctx.t;
            A.wakeAt = ctx.t; B.wakeAt = ctx.t;
            ctx.wake(px, pz, WAKE_IMPACT_RADIUS, s, 1);
          }
        }
      }
      // A separation can shove either stick into a rock, so both take their world contact again here
      // instead of a frame later; A's capsule is then stale for every pair still to come.
      resolveStations(A, ctx);
      resolveStations(B, ctx);
      stickEnds(A, eA);
      hits++;
    }
  }
  return hits;
}

/* What a shove has to overcome, as a length. A stick or nut resists by thickness, since drag and mass
   both scale with planform; a soaked card resists by its whole span, so a broad leaf takes more shifting. */
export function handResist(item, knobs) {
  if (item.card) return Math.max(HAND_RESIST_FLOOR, (item.halfL ?? 0) * 2 * (knobs?.cardCling ?? 1));
  if (item.stick) return Math.max(HAND_RESIST_FLOOR, item.halfWidth * 2);
  return Math.max(HAND_RESIST_FLOOR, (item.radius ?? item.halfWidth) * 2);
}

/* The hand's nearest approach to this piece, walking the same stations the collision uses. Endpoint-only
   sampling missed a swish straight across the middle of a branch, which is most of them. */
export function handNearest(item, hand, ctx, out) {
  out.d = Infinity;
  if (!hand || !hand.n) return out;
  const reach = HAND_RADIUS + HAND_REACH + item.halfWidth;
  if (item.x < hand.x0 - reach || item.x > hand.x1 + reach
    || item.z < hand.z0 - reach || item.z > hand.z1 + reach) return out;
  const st = ctx.stations;
  const n = stationsFor(item, st);
  const seg = hand.segs;
  for (let i = 0; i < n; i++) {
    const o = i * 3, sx = st[o], sz = st[o + 1], sr = st[o + 2];
    for (let s = 0; s < hand.n; s++) {
      const q = s * 4, ax = seg[q], az = seg[q + 1];
      const ex = seg[q + 2] - ax, ez = seg[q + 3] - az;
      const t = Math.max(0, Math.min(1, ((sx - ax) * ex + (sz - az) * ez) / (ex * ex + ez * ez || 1e-9)));
      const rx = sx - (ax + ex * t), rz = sz - (az + ez * t);
      const d = Math.hypot(rx, rz) - sr;
      if (d >= out.d) continue;
      out.d = d; out.x = sx; out.z = sz; out.rx = rx; out.rz = rz; out.sr = sr;
    }
  }
  return out;
}

/* The hand as a moving collider rather than a force field: the slug of water it drags pushes the piece,
   and the palm itself shoves and bounces whatever it actually lands on. Thin twigs fly, branches lumber. */
export function handPush(item, hand, ctx) {
  const k = ctx.knobs;
  const near = handNearest(item, hand, ctx, ctx.hand);
  if (!(near.d < HAND_RADIUS + HAND_REACH)) return 0;
  const raw = Math.hypot(hand.vx, hand.vz);
  const speed = Math.min(HAND_SPEED_MAX, raw);
  const hx = raw > 1e-6 ? hand.vx / raw : 0, hz = raw > 1e-6 ? hand.vz / raw : 0;
  const lever = item.stick ? item.len : (item.long ? item.halfL * 2 : 0);
  const leverK = lever > 0 ? k.handTorque / (lever * lever) : 0;
  const rx = near.x - item.x, rz = near.z - item.z;
  const resist = handResist(item, k);
  // Quadratic drag against the water the palm is driving, which self-limits: the piece stops accelerating
  // once it matches the flow.
  const falloff = 1 - smoothstep01(HAND_RADIUS, HAND_RADIUS + HAND_REACH, Math.max(0, near.d));
  const wx = hx * speed * falloff, wz = hz * speed * falloff;
  const dx = wx - item.vx, dz = wz - item.vz, dv = Math.hypot(dx, dz);
  const a = k.handDrag * dv * ctx.ms / resist;
  const fx = dx * a, fz = dz * a;
  ctx.dirFx += fx; ctx.dirFz += fz;
  if (leverK) ctx.dirTorque += (fx * rz - fz * rx) * leverK;
  // near.d is measured from the hand's centerline, so the palm's own radius is the contact threshold.
  if (near.d >= HAND_RADIUS) return falloff;
  // Palm contact: separate, then bounce off it. An infinitely heavy hand means matching its normal
  // velocity plus the restitution, which is what makes a smacked branch tumble away instead of sliding.
  let nx = near.rx, nz = near.rz;
  const nl = Math.hypot(nx, nz);
  if (nl > 1e-6) { nx /= nl; nz /= nl; } else {
    // Palm dead on the station: the piece's own offset from the touched point is the only axis left, and a
    // motionless finger has no direction to fall back on at all.
    const cx = item.x - near.x, cz = item.z - near.z, cd = Math.hypot(cx, cz);
    if (cd > 1e-6) { nx = cx / cd; nz = cz / cd; } else if (raw > 1e-6) { nx = hx; nz = hz; } else { nx = 1; nz = 0; }
  }
  const depth = HAND_RADIUS - near.d;
  item.x += nx * depth; item.z += nz * depth;
  const vn = (item.vx - hand.vx) * nx + (item.vz - hand.vz) * nz;
  if (vn < 0) {
    // A plastered leaf sheds most of the smack into the film it is stuck to, so the palm transfers less
    // of it than to a stick of the same weight. Sticks and nuts are at or near the whole of it.
    const grip = Math.min(1, Math.sqrt(HAND_GRIP_REF / resist));
    const was = Math.hypot(item.vx, item.vz);
    const jn = -(1 + k.handRestitution) * vn * grip;
    item.vx += jn * nx; item.vz += jn * nz;
    if (leverK) item.av += (nx * jn * rz - nz * jn * rx) * leverK;
    if (item.av > AVMAX) item.av = AVMAX; else if (item.av < -AVMAX) item.av = -AVMAX;
    // The palm keeps shoving for as long as it is on the piece, so the cap is what a hand can drive this
    // piece to at all: a branch takes the lot, a soaked leaf tears loose from the film well below it.
    const cap = Math.max(was, k.handVMax * grip);
    const sp = Math.hypot(item.vx, item.vz);
    if (sp > cap) { const s = cap / sp; item.vx *= s; item.vz *= s; }
  }
  return 1;
}

/* The obstacle's flow shadow, which makeCurrent does not carry: a bounded smooth field from the nearest
   surface point outward, strongest straight downwind. ctx.wx/wz is the downwind bearing, already unit. */
export function leeField(x, z, ctx) {
  if (!(ctx.gust >= LEE_GUST_MIN)) return 0;   // no wind, no downwind side: normalizing zero would go NaN
  const out = ctx.out;
  if (!ctx.contact(x, z, LEE_REACH, out)) return 0;
  const n = Math.min(out.n, out.hits.length / 3);
  let L = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    // d is the helper's own outward-normal dot, never normalize(p - sp): that goes NaN exactly at e = 0,
    // which is where the weight is strongest.
    const d = out.hits[o] * ctx.wx + out.hits[o + 1] * ctx.wz;
    if (d <= 0) continue;
    const e = LEE_REACH - out.hits[o + 2];
    L += (1 - smoothstep01(0, 1, e / LEE_REACH)) * Math.pow(d, LEE_POW);
  }
  return L > 1 ? 1 : L;
}

/* One item, one fixed tick. ctx carries this item's sampled water and pushes, so the caller owns every
   THREE-side lookup and this stays testable against analytic colliders. */
export function stepItem(item, ctx, dt) {
  const h = Math.min(dt, MAX_DT);
  const k = ctx.knobs;
  const gain = DRIFT_GAIN[item.kind];
  const L = leeField(item.x, item.z, ctx);
  const driftK = 1 + (k.leeDriftGain - 1) * L;
  const angK = 1 + (k.leeAngularDamping - 1) * L;
  const ms = ctx.ms;
  const long = item.stick || item.long;
  // Ambient wind, the current, and the swell all take the lee's shadow; the finger and the eels never do.
  let fx = ctx.wx * ctx.gust * WIND_FORCE * gain * driftK * ms + ctx.dirFx + ctx.ringFx * gain;
  let fz = ctx.wz * ctx.gust * WIND_FORCE * gain * driftK * ms + ctx.dirFz + ctx.ringFz * gain;
  // Downhill off the swell's own slope: what "follows the surface" means without a heightfield readback.
  fx -= ctx.slopeX * k.slopeGain * gain * driftK * ms;
  fz -= ctx.slopeZ * k.slopeGain * gain * driftK * ms;
  // One damping term, about the water's own velocity, so calm-night litter rides the current and sits.
  const curK = k.currentGain;
  const cx = ctx.curX * curK * ms * driftK, cz = ctx.curZ * curK * ms * driftK;
  const damp = DAMP * (1 + (k.matDamp - 1) * item.caught);
  let vx = item.vx + (fx - damp * (item.vx - cx)) * h;
  let vz = item.vz + (fz - damp * (item.vz - cz)) * h;
  const vCap = k.vMax ?? VMAX;
  const v2 = vx * vx + vz * vz;
  if (v2 > vCap * vCap) { const s = vCap / Math.sqrt(v2); vx *= s; vz *= s; }

  const spin = (item.seed * 2 - 1) * SPIN_GUST * ctx.gust * gain * ms;
  const wob = Math.sin(ctx.t * (0.15 + 0.25 * item.seed) + 7 * item.seed) * k.wobbleTorque * gain * ms;
  // Broadside is the stable fixed point of sin(2d) and along-wind the unstable one, which is exactly how
  // a floating rod behaves: it turns across the wind and stays there.
  const vane = long ? Math.sin(2 * (item.angle - ctx.windAngle)) * k.vaneTorque * ctx.gust * gain * ms : 0;
  const dampA = item.stick ? DAMP : k.cardAngularDamp;
  let av = item.av + (spin + wob + vane + ctx.dirTorque + ctx.curTorque - dampA * angK * item.av) * h;
  if (av > AVMAX) av = AVMAX; else if (av < -AVMAX) av = -AVMAX;
  item.vx = vx; item.vz = vz; item.av = av;

  // Anti-tunneling: clamp the water run first (a ceiling alone is not a cap), then substep what is left.
  const maxStep = Math.max(STEP_FLOOR, 0.5 * item.minR);
  let travel = Math.hypot(vx, vz) * h;
  let run = h;
  if (travel > SUBSTEP_MAX * maxStep) { run = h * (SUBSTEP_MAX * maxStep) / travel; travel = SUBSTEP_MAX * maxStep; }
  const n = Math.min(SUBSTEP_MAX, Math.max(1, Math.ceil(travel / maxStep)));
  const sh = run / n;
  let hits = 0;
  for (let s = 0; s < n; s++) {
    item.x += item.vx * sh; item.z += item.vz * sh;
    item.angle += item.av * sh;
    hits += resolveStations(item, ctx);
  }
  item.angle = wrapAngle(item.angle);
  item.age += h;
  return hits;
}

/* Two field samples step cards out of duckweed; caught decays so steady wind does not flicker the
   edge damping. */
export function matEdge(item, field, h = 0) {
  let m = field(item.x, item.z);
  if (!(m > 0)) {
    item.caught = h > 0 ? Math.max(0, item.caught - h / MAT_RELEASE) : 0;
    return 0;
  }
  let passes = 0;
  for (; passes < MAT_PASSES && m > 0; passes++) {
    const gx = field(item.x + MAT_EPS, item.z) - m;
    const gz = field(item.x, item.z + MAT_EPS) - m;
    const gl = Math.hypot(gx, gz);
    if (!(gl > 1e-6)) break;
    // The field grows inward, so the outward direction is straight down its gradient.
    const nx = -gx / gl, nz = -gz / gl;
    // Newton plus a skin, not plus a half-width: a card held its own width clear of the fronds reads as a
    // suspicious gap, and it also drifts back so slowly that the caught damping strobes off between touches.
    const step = Math.min(0.5, m * MAT_EPS / gl + SKIN);
    item.x += nx * step; item.z += nz * step;
    const vn = item.vx * nx + item.vz * nz;
    if (vn < 0) { item.vx -= vn * nx; item.vz -= vn * nz; }
    m = field(item.x, item.z);
  }
  item.caught = 1;
  return passes;
}

export function age01(item) {
  return Math.max(0, Math.min(1, item.age / Math.max(1e-3, item.lifetime)));
}

export function resetSink(item) {
  item.sink = SINK.NONE;
  item.slot = -1;
  item.u = 0; item.depth = 0; item.sinkV = 0; item.gone = 0;
  item.sinkT = 0; item.restT = 0;
  item.sinkX = 0; item.sinkZ = 0;
  item.mx = item.x; item.mz = item.z;
}

export function retireDue(item, now, lastRetire) {
  return item.age >= item.lifetime && now - lastRetire >= RETIRE_GAP;
}

export function makeTray(slots = TRAY_SLOTS) {
  return { slots, owner: new Int32Array(slots).fill(-1), lastRetire: -Infinity, claimed: 0, sunk: 0 };
}

export function trayLive(tray) {
  let n = 0;
  for (let s = 0; s < tray.slots; s++) if (tray.owner[s] >= 0) n++;
  return n;
}

/* A card lets go of the film at its own spot and stays there: the crossing is a dither between the over
   card and the tray card, so the two must agree on one anchor. */
export function beginSink(item, slot) {
  item.sink = SINK.CROSS;
  item.slot = slot;
  item.u = 0; item.depth = 0; item.sinkV = 0; item.gone = 0;
  item.sinkT = 0; item.restT = 0;
  item.sinkX = item.x; item.sinkZ = item.z;
  item.mx = item.x; item.mz = item.z;
  item.vx = 0; item.vz = 0; item.av = 0;
}

/* The sink itself: the tray's hand-off, then the descent, then sinkFood's flutter over the top. Returns
   the phase; a return of SINK.NONE is the caller's cue to free the slot and respawn the card upwind. */
export function stepSink(item, ctx, dt) {
  const h = Math.min(dt, MAX_DT);
  const k = ctx.knobs;
  item.vx = 0; item.vz = 0; item.av = 0;
  item.x = item.sinkX; item.z = item.sinkZ;
  if (item.sink === SINK.CROSS) {
    item.u = Math.min(1, item.u + h / Math.max(0.05, k.crossFor));
    item.mx = item.sinkX; item.mz = item.sinkZ;
    if (item.u >= 1) { item.sink = SINK.FALL; item.sinkT = 0; }
    return item.sink;
  }
  const floorY = ctx.floorAt(item.sinkX, item.sinkZ);
  const maxDepth = Math.max(0.05, -floorY - 0.05);
  item.sinkT += h;
  if (item.sink === SINK.FALL) {
    /* Positive-down adaptation of threejs-water's SimulationObjectUtils.updatePhysics: gravity minus
       buoyancy, submerged quadratic drag, then Euler integration. */
    const under = underWater(item.depth, SINK_RADIUS);
    const buoyancy = 1 / Math.max(1e-3, k.sinkDensity);
    item.sinkV += k.sinkGravity * h * (1 - buoyancy * under);
    // Capped so Euler's drag can never reverse the fall: percentUnderWater <= 1 < density keeps the net
    // force downward at every depth, and a card that rose would break the tray's monotone contract.
    item.sinkV -= Math.min(item.sinkV, under * h * item.sinkV * item.sinkV);
    item.depth += item.sinkV * h;
    if (item.depth >= maxDepth) {
      // Settled into the silt, not bounced: the reference's 0.7 restitution is for a beach ball.
      item.depth = maxDepth; item.sinkV = 0;
      item.sink = SINK.REST; item.restT = 0;
    }
  } else if (item.sink === SINK.REST) {
    item.restT += h;
    if (item.restT >= k.restFor) { item.sink = SINK.FADE; item.restT = 0; }
  } else if (item.sink === SINK.FADE) {
    item.restT += h;
    item.gone = Math.min(1, item.restT / Math.max(0.05, k.goneFor));
    if (item.gone >= 1) { item.sink = SINK.NONE; return SINK.NONE; }
  }
  // Eased in from the let-go and gone by the floor, exactly eels.js sinkFood: the drawn point flutters,
  // the anchor never does, so the crossing and the tray agree on where the card is.
  const fi = Math.min(1, item.sinkT / Math.max(0.05, k.swayIn));
  const amp = k.sway * fi * fi * (3 - 2 * fi) * Math.max(0, Math.min(1, (maxDepth - item.depth) / maxDepth));
  const s = Math.sin(ctx.t * 1.4 + item.sway) * amp;
  item.mx = item.sinkX + Math.cos(item.sway) * s;
  item.mz = item.sinkZ + Math.sin(item.sway) * s;
  return item.sink;
}

/* A card whose clock is up, if the tray has room and the last retirement is far enough back. The gap is
   what keeps four leaves from letting go together and emptying the tray in one second. */
export function offerSink(item, index, tray, ctx) {
  if (!retireDue(item, ctx.t, tray.lastRetire)) return false;
  let slot = -1;
  for (let s = 0; s < tray.slots; s++) if (tray.owner[s] < 0) { slot = s; break; }
  if (slot < 0) return false;      // every slot busy: it floats on and asks again next tick
  tray.owner[slot] = index;
  tray.lastRetire = ctx.t;
  tray.claimed++;
  beginSink(item, slot);
  return true;
}

/* One sinking card's step, so the tray's bookkeeping has exactly one implementation. Returns true while
   the card is floating normally, which is the caller's cue to step its motion instead. */
export function stepCardLife(item, tray, ctx, rng, h) {
  if (item.sink === SINK.NONE) return true;
  if (stepSink(item, ctx, h) !== SINK.NONE) return false;
  tray.owner[item.slot] = -1;
  tray.sunk++;
  respawnItem(item, rng, ctx, true);
  return false;
}

/* Back on an upwind or off-frame point, already afloat: the grill bans fall-in plops, so a respawn is a
   piece that drifts in rather than one that lands. `reset` is false for a piece that merely left frame. */
export function respawnItem(item, rng, ctx, reset = true) {
  const s = upwindEdgeSpawn(rng, { x: ctx.wx, z: ctx.wz }, ctx.rect, MARGIN * 0.5);
  item.x = s.x; item.z = s.z;
  item.vx = 0; item.vz = 0; item.av = 0;
  item.angle = rng.range(-Math.PI, Math.PI);
  item.voidT = 0;
  item.caught = 0;
  if (item.card) { resetSink(item); item.sway = rng.range(0, Math.PI * 2); }
  if (!reset) return item;
  item.age = 0;
  item.lifetime = rollLifetime(rng, item.kind, ctx.knobs);
  return item;
}

/* One NaN in an item's state is permanent: offFrame's bounds both read false, no resolve can walk it back,
   and the instance buffer it writes can drop the whole draw. A respawn is the only exit. */
export function itemFinite(item) {
  return Number.isFinite(item.x) && Number.isFinite(item.z)
    && Number.isFinite(item.vx) && Number.isFinite(item.vz)
    && Number.isFinite(item.angle) && Number.isFinite(item.av);
}

export function offFrame(item, rect) {
  const ex = rect.ex + MARGIN, ez = rect.ez + MARGIN;
  return item.x < -ex || item.x > ex || item.z < -ez || item.z > ez;
}
