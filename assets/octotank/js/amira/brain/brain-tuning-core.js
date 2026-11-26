import { SUCKER_KNOBS } from '../arms/sucker-core.js';

/* Amira's brain as data: every threshold, rate, offer, and reason lives here once. Rates are per minute unless the key
   says otherwise, times are seconds, and meters run 0 (unfulfilled) to 1 (fulfilled). */

export const METERS = ['fullness', 'stimulation', 'comfort', 'energy', 'fun', 'expression'];
export const FAMILIES = ['interested', 'pleased', 'cozy', 'inspired', 'frustrated', 'alarmed', 'uncomfortable'];

// Her values; personalize() scales each owned number by slider ÷ this, so these reproduce the table exactly.
export const SLIDERS = { curiosity: 0.90, activity: 0.60, sensitivity: 0.45, persistence: 0.65, expressiveness: 0.80, sociability: 0.60 };

export const OWNED = {
  curiosity: ['attract.novelty.lo', 'attract.novelty.hi', 'attention.weights.new'],
  activity: ['urgency.ordinary', 'energy.awake'],
  sensitivity: ['knock.first', 'noxious.mild', 'noxious.severe', 'noxious.margin'],
  persistence: ['episode.putDownAfter', 'episode.endAfter', 'choice.switchMargin'],
  expressiveness: ['display.min', 'display.max', 'display.overlay'],
  sociability: ['attract.company', 'lift.palm', 'lift.juliaPerMin'],
};
const WHOLE = new Set(['episode.putDownAfter', 'episode.endAfter']);

export const TUNING = {
  start: { fullness: 0.80, stimulation: 0.55, comfort: 0.75, energy: 0.80, fun: 0.50, expression: 0.45 },
  drift: { fullness: -0.0005, stimulation: -0.013, fun: -0.010, expression: -0.003 },
  floor: { fullness: 0.30, stimulation: 0.25, fun: 0.25, expression: 0.25 },
  awakeOnly: ['stimulation', 'fun', 'expression'],
  curve: { fullness: 'square', energy: 'square', comfort: 'square', stimulation: 'line', fun: 'line', expression: 'line' },
  pressureFloor: 0.05,
  energy: { awake: -0.0012, crawl: -0.002, curled: 0.008, half: 0.012, full: 0.025, jet: -0.008, haulOut: -0.03, display: 1.3 },
  comfort: {
    halfLife: 120,
    targets: { den: 0.95, shelter: 0.85, ordinary: 0.75, exposed: 0.50 },
    exposedFor: 60,           // s a knock or landing near open floor keeps it exposed
    settle: 0.05, touch: 0.005, touchEvery: 60,
  },
  gains: {
    inspectPerMin: 0.30, inspectCap: 0.25, feature: 0.03, firstTouch: 0.01,
    playPerMin: 0.025, thumbPerMin: 0.025, workPerMin: 0.01, result: 0.12, resultEvery: 600, keep: 0.03, inkWork: 10,
  },
  // Each condition clears `clearGap` past its entry, so a meter hovering at a line doesn't keep re-announcing it.
  clearGap: 0.05,
  lines: [
    { id: 'peckish', meter: 'fullness', at: 0.40, level: 'soft', relief: 2 },
    { id: 'foodFirst', meter: 'fullness', at: 0.25, level: 'hard' },
    { id: 'sleepy', meter: 'energy', at: 0.45, level: 'soft', relief: 3 },
    { id: 'restNow', meter: 'energy', at: 0.25, level: 'hard', inclusive: true },
    { id: 'exhausted', meter: 'energy', at: 0.15, level: 'crisis', inclusive: true },
    { id: 'lowComfort', meter: 'comfort', at: 0.40, level: 'soft' },
    { id: 'critical', meter: 'comfort', at: 0.25, level: 'crisis' },
    { id: 'restlessStim', meter: 'stimulation', at: 0.35, level: 'soft' },
    { id: 'restlessFun', meter: 'fun', at: 0.35, level: 'soft' },
    { id: 'project', meter: 'expression', at: 0.35, level: 'soft' },
  ],
  content: { above: 0.60 },
  gates: {
    play: { comfort: 0.45, energy: 0.30 },
    nap: { comfort: 0.75 },
    sleep: { comfort: 0.80 },
    company: { comfort: 0.45, energy: 0.25 },
    mischief: { comfort: 0.70, energy: 0.50 },
  },
  lift: { palm: 0.10, juliaPerMin: 0.05, halfLife: 300, palmHold: 4 },

  // Moodlets: family, points, lifetime (Infinity while a condition holds), word, and scope ('local' never leaves the tab).
  reasons: {
    newThing: { family: 'interested', points: 1, life: 90, word: 'curious' },
    learned: { family: 'interested', points: 1, life: 180, word: 'curious' },
    enjoyedPlay: { family: 'pleased', points: 1, life: 240, word: 'content' },
    ateLiked: { family: 'pleased', points: 1, life: 180, word: 'content' },
    settled: { family: 'cozy', points: 1, life: Infinity, word: 'cozy', condition: true },
    workStayed: { family: 'inspired', points: 1.5, life: 480, word: 'inspired' },
    company: { family: 'pleased', points: 0.5, life: 180, word: 'content' },
    blockedTwice: { family: 'frustrated', points: 1, life: 90, word: 'grumpy', scope: 'local' },
    failedEpisode: { family: 'frustrated', points: 2, life: 180, word: 'grumpy' },
    noxiousMild: { family: 'uncomfortable', points: 1, life: 30, word: 'uncomfortable', scope: 'local' },
    noxiousSevere: { family: 'uncomfortable', points: 2, life: 90, word: 'uncomfortable' },
    firstKnock: { family: 'alarmed', points: 0.75, life: 8, word: 'wary', scope: 'local' },
    rudeKnocking: { family: 'frustrated', points: 1.5, life: 120, word: 'grumpy', scope: 'local' },
    wokenFull: { family: 'frustrated', points: 2, life: 180, word: 'grumpy' },
    safeAfterRetreat: { family: 'cozy', points: 1.5, life: 600, word: 'cozy' },
    solvedHard: { family: 'pleased', points: 1, life: 180, word: 'proud', bold: true },
    ejected: { family: 'pleased', points: 0.5, life: 45, word: 'proud', bold: true },
    keptFavorite: { family: 'pleased', points: 0.5, life: 180, word: 'content' },
    boldDisplay: { family: 'pleased', points: 0.5, life: 45, word: 'proud', bold: true },
    peckish: { family: 'uncomfortable', points: 0.75, hard: 1.5, life: Infinity, word: 'peckish', condition: true, flavor: 'maint' },
    sleepy: { family: 'uncomfortable', points: 0.75, hard: 1.5, life: Infinity, word: 'sleepy', condition: true, flavor: 'sleepy' },
    lowComfort: { family: 'uncomfortable', points: 1.5, life: Infinity, word: 'uncomfortable', condition: true },
    restless: { family: 'interested', points: 0.5, life: Infinity, word: 'curious', condition: true },
    content: { family: 'pleased', points: 0.5, life: Infinity, word: 'content', condition: true },
  },
  mood: {
    familyCap: 3, secondShare: 0.5, refreshEvery: 30,
    // Pleasantness, activation, feeling in command, per effective point.
    dirs: {
      interested: [0.25, 0.35, 0.15], pleased: [0.60, 0.10, 0.20], cozy: [0.40, -0.40, 0.15], inspired: [0.50, 0.25, 0.30],
      frustrated: [-0.50, 0.45, 0.35], alarmed: [-0.65, 0.65, -0.70], uncomfortable: [-0.55, 0.15, -0.25],
    },
    background: [0, 0.25, 0.20],
    bold: 0.40, needWeight: 0.5, sleepyArousal: -0.30,
    threatAlarm: 1, threatNoxious: 3, threatPositive: 0.3, redLineNegative: 1.25,
    settleArousal: 10, settleOther: 60, settleShare: 0.95,
    word: { min: 0.75, lead: 0.5, leadFor: 5 },
  },
  tilt: {
    clamp: [0.6, 1.5],
    explore: { up: 1.3, down: 0.8 }, play: { up: 1.4, down: 0.7 }, create: { up: 1.5, down: 0.6 },
    rest: { up: 1.5 }, display: { up: 1.3 }, company: { up: 1.3 }, eat: { lo: 0.9, hi: 1.1 },
  },
  // Eastern hours; the lights' fades belong to the lighting.
  rhythm: {
    dawn: [6, 8], day: [8, 18], dusk: [18, 20],
    boost: 1.15, families: { dawn: ['explore', 'eat', 'play'], day: ['rest'], dusk: ['explore', 'eat', 'play'], night: ['explore'] },
  },

  horizon: 300,
  offers: {
    food: {
      scallop: { fullness: 0.18 }, urchin: { fullness: 0.18 }, snail: { fullness: 0.06 },
      crunchsnack: { fullness: 0.12, stimulation: 0.02 }, crunchtreat: { fullness: 0.20 }, crunchclaw: { fullness: 0.18 }, grubmeat: { fullness: 0.10 },
      other: { fullness: 0.10 },   // a food kind missing above, valued as the smallest treat
    },
    changed: { stimulation: 0.15 },
    play: { fun: 0.125, stimulation: 0.02 },
    thumb: { fun: 0.008 },
    arrange: { expression: 0.12, stimulation: 0.03, fun: 0.01 },
    improve: { expression: 0.05, stimulation: 0.03 },
    patrol: { stimulation: 0.05 },
    keep: { comfort: 0.03 },
    restCurl: 120,
  },
  instinct: { food: ['scallop', 'urchin', 'snail'], shelter: ['den', 'rockwork', 'hide'], surfaces: ['sand', 'floor', 'rock', 'glass', 'wall', 'lid', 'self'] },
  attract: {
    novelty: { lo: 0.8, hi: 1.2 },
    nap: { base: 0.3, warmth: 0.3, sinceSleep: 3600 },
    keep: { favorite: 0.30, encounters: 3 },
    company: 0.60,
  },
  adjust: {
    opinion: 0.3, juliaOpinion: 0.6,
    travelPerMeter: 0.25, travelMin: 0.5, effortMin: 0.7,
    // [s since finishing, factor]
    recency: [[120, 0.15], [600, 0.6], [21600, 1], [86400, 1.1]],
    unreachable: [[300, 0.15], [1800, 0.5]],
    gatedPlay: 0.2,
  },
  choice: {
    scale: 10, wantBonus: 0.15, aimless: 0.10, pool: 3, cutoff: 0.5, power: 2,
    review: 3, switchMargin: 0.30, switchReviews: 2,
    floors: { inspect: 8, manipulate: 20, play: 45, create: 90, other: 8 },
    bothUrgentEat: 10, releaseMax: 10,
    foodSpeed: 0.127,   // m/s, her crawl at food urgency; mirrors speedCalm and speedHurried in locomotion-core.js
  },
  urgency: { ordinary: 0.30, food: 0.55, retreat: 0.85 },
  wants: { max: 3, life: 300, projectLife: 1200, perEvent: 2, refill: 60 },
  attention: { review: 0.25, hold: 2, weights: { new: 3, moved: 2, familiar: 1 }, moveMax: 1.5, fadeFrom: 0.8, fadeTo: 1.2, fadeShare: 0.5 },
  touch: { weights: SUCKER_KNOBS.tasteWeight, boutGap: 2, investigate: 0.35 },
  inspect: { contact: 6, observations: 2, playContact: 20, playContacts: 3, earlyPlay: 0.05 },
  knock: { first: 0.25, habituation: 0.5, recovery: 3600, comfort: 0.03, storm: 10, stormWithin: 20, stormEvery: 60, stormStrength: 0.40, stormComfort: 0.04, comfortWindow: 600, comfortCap: 0.15, jadedMax: 0.4 },
  noxious: { mild: 0.04, severe: 0.15, severeAt: 0.75, margin: 0.10, caution: 300 },
  episode: { putDownAfter: 2, endAfter: 3, stall: 4 },
  display: { min: 5, max: 10, overlay: 1 },
  disturb: { landing: 0.9, thud: 0.6, juliaBump: 0.5 },
  rest: {
    curlToHalf: 120, halfToFull: 120, calmFor: 60, quiet: 420, active: 50, cycle: 1800, wakeEnergy: 0.90,
    nightFrom: 0, nightTo: 6, nightMin: 10800, wakeQuiet: 0.20, wakeActive: 0.35, wakeBump: 0.20, bumpFor: 1800,
    awakeBetween: 600, rebound: 1.5, stir: 10, swap: 120,
  },
  learn: {
    baseline: 0.4, baselineRate: 0.01, step: 0.5, cap: 0.15, juliaStep: 1, juliaCap: 0.30, expect: 0.3,
    decayPerDay: 0.05, varied: 0.6, completed: 0.3, obstruction: 0.6, noxious: 0.8,
    skillCap: 40, skillHalfLife: 604800, trail: 8, trailDecay: 0.7,
  },
};

function lookup(o, path) {
  const keys = path.split('.');
  for (let i = 0; i < keys.length - 1; i++) o = o?.[keys[i]];
  return [o, keys[keys.length - 1]];
}

/* A deep copy of `tuning` with the OWNED numbers scaled by slider ÷ her value, each slider clamped 0–1. Whole-number
   knobs round, never below 1. */
export function personalize(sliders = SLIDERS, tuning = TUNING) {
  const out = structuredClone(tuning);
  for (const [slider, paths] of Object.entries(OWNED)) {
    const v = sliders[slider] ?? SLIDERS[slider], scale = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) / SLIDERS[slider] : 1;
    if (scale === 1) continue;
    for (const path of paths) {
      const [o, k] = lookup(out, path);
      if (!o || typeof o[k] !== 'number') continue;
      o[k] = WHOLE.has(path) ? Math.max(1, Math.round(o[k] * scale)) : o[k] * scale;
    }
  }
  return out;
}

/* The line rows by id, with each one's clear point rounded clean of float drift (0.35 + 0.05 lands just under 0.4). */
export function lineTable(T) {
  const rows = {};
  for (const r of T.lines) rows[r.id] = { ...r, clear: Math.round((r.at + T.clearGap) * 1e9) / 1e9 };
  return rows;
}
