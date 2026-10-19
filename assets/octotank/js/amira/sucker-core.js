import { mulberry32 } from './arm-core.js';

/* Amira's suckers without THREE or Jolt: where they sit along each arm, how hard each holds, the flicker that keeps
   only a share of the touching ones sealed, the taste rules that set attach, hold, and grip, and who moves on a pull. */

export const SUCKER_KNOBS = {
  perArm: 240,           // suckers per arm, in two staggered rows
  rows: 2,
  suckerFrac: 0.5,       // sucker radius over the arm's radius where it sits
  mantleLength: 0.15,    // m, what the enlarged suckers scale from
  enlargedArms: [1, 2, 5, 6],
  enlargedFrom: 15,      // 1-based, counted from the base along the arm
  enlargedCount: 3,
  enlargedFrac: 0.11,    // enlarged sucker diameter over mantle length
  workPa: 70e3,          // suction a working (flickering) sucker holds with
  bigPa: 100e3,          // the cavitation ceiling for a sucker at or above bigArea
  bigArea: 7.5e-6,       // m²
  smallPa: 250e3,        // smaller suckers reach more, up to this at smallArea
  smallArea: 1e-6,
  workShare: 0.2,        // share of touching suckers sealed while the arm works
  hardShare: 0.95,
  sealTime: 0.25,        // s a working seal lasts on average, so a touch settles at its share in a fifth of a second
  hardAttach: 0.15,      // s for an unsealed sucker to seal in a deliberate hard grip
  shareSpread: 0.6,      // per-arm wander of the share, as a standard deviation in log-odds
  shareMax: 0.4,         // and the most it ever wanders to
  shareTau: 2,           // s that wander takes to decorrelate
  faceCos: 0,            // a contact counts when its surface lies on the sucker half of the arm
  touchGap: 0.003,       // m past the arm's skin that still counts as touching
  sealSpeed: 0.15,       // m/s of sliding past a surface above which a sucker can't seal on it
  slideTau: 0.12,        // s the sliding speed is averaged over: the solved chain jitters by millimeters a tick
  boringHold: 1.5,       // s mean, and its spread, of a touch on something that isn't food
  boringSpread: 0.5,
  foodHold: 240.5,
  foodSpread: 165.5,
  spoiledGrip: 0.35,     // what a spoiled taste leaves of the grip
  rejectSpeed: 0.2,      // m/s a rejected thing travels out along the arm
  refractory: 1,         // s a patch stays unsealed after the arm moves on
  ignoreTime: 4,         // s an arm leaves a thing it moved on from alone
};

/* Where the suckers sit on one arm and what each can hold. Pitch follows sucker size, so they crowd toward the tip. */
export function layoutSuckers(len0, rad0, arc0, armIndex, k = SUCKER_KNOBS) {
  const S = len0.length, L = arc0[S], N = Math.max(0, Math.round(k.perArm));
  const armR = (s) => {
    let j = 0;
    while (j < S - 1 && arc0[j + 1] < s) j++;
    const f = Math.max(0, Math.min(1, (s - arc0[j]) / len0[j]));
    return rad0[j] + (rad0[j + 1] - rad0[j]) * f;
  };
  // Cumulative density ∝ 1 / sucker radius on a fine grid; sucker i sits at the (i + ½)-th unit of it.
  const M = 4096, cum = new Float64Array(M + 1);
  for (let m = 0; m < M; m++) cum[m + 1] = cum[m] + 1 / Math.max(1e-5, armR((m + 0.5) * L / M));
  const scale = N / cum[M];
  const arc = new Float64Array(N), radius = new Float64Array(N), area = new Float64Array(N);
  const row = new Uint8Array(N), seg = new Int32Array(N), fWork = new Float64Array(N), fHard = new Float64Array(N);
  let m = 0;
  for (let i = 0; i < N; i++) {
    const want = (i + 0.5) / scale;
    while (m < M - 1 && cum[m + 1] < want) m++;
    const f = (want - cum[m]) / Math.max(1e-12, cum[m + 1] - cum[m]);
    arc[i] = (m + Math.max(0, Math.min(1, f))) * L / M;
    radius[i] = k.suckerFrac * armR(arc[i]);
    row[i] = i % Math.max(1, k.rows);
  }
  if (k.enlargedArms?.includes(armIndex)) {
    for (let i = k.enlargedFrom - 1; i < Math.min(N, k.enlargedFrom - 1 + k.enlargedCount); i++) radius[i] = Math.max(radius[i], k.enlargedFrac * k.mantleLength / 2);
  }
  const segStart = new Int32Array(S + 1);
  let j = 0;
  for (let i = 0; i < N; i++) {
    while (j < S - 1 && arc[i] >= arc0[j + 1]) j++;
    seg[i] = j;
    area[i] = Math.PI * radius[i] * radius[i];
    const ceil = suckerCeiling(area[i], k);
    fWork[i] = area[i] * Math.min(k.workPa, ceil);
    fHard[i] = area[i] * ceil;
  }
  for (let i = 0, s = 0; s <= S; s++) { while (i < N && seg[i] < s) i++; segStart[s] = i; }
  segStart[S] = N;
  return { n: N, S, arc, radius, area, row, seg, segStart, fWork, fHard };
}

/* The pressure a sucker of this disc area can hold before the water in it cavitates: flat above bigArea, rising
   toward smallArea on a log scale. */
export function suckerCeiling(area, k = SUCKER_KNOBS) {
  if (area >= k.bigArea) return k.bigPa;
  if (area <= k.smallArea) return k.smallPa;
  const t = Math.log(k.bigArea / area) / Math.log(k.bigArea / k.smallArea);
  return k.bigPa + (k.smallPa - k.bigPa) * t;
}

/* What a taste does: grip (fraction of the sucker force left), hard (seal near all, at the ceiling), the hold's mean
   and spread in seconds, fetch (pull it to the mouth), reject (send it out along the arm), self (a no-op). */
export function tasteRule(tag, k = SUCKER_KNOBS, { gripSelf = false } = {}) {
  const boring = { grip: 1, hard: false, holdMean: k.boringHold, holdSd: k.boringSpread, fetch: false, reject: false, self: false };
  if (tag === 'food') return { ...boring, hard: true, holdMean: k.foodHold, holdSd: k.foodSpread, fetch: true };
  if (tag === 'spoiled') return { ...boring, grip: k.spoiledGrip, reject: true };
  if (tag === 'slick') return { ...boring, grip: 0 };
  if (tag === 'self') return gripSelf ? boring : { ...boring, grip: 0, holdMean: 0, holdSd: 0, self: true };
  return boring;
}

/* A lognormal draw with this mean and standard deviation, so a hold is never negative. */
export function sampleHold(mean, sd, rng) {
  if (!(mean > 0)) return 0;
  const s2 = Math.log(1 + (sd * sd) / (mean * mean)), mu = Math.log(mean) - s2 / 2;
  return Math.exp(mu + Math.sqrt(s2) * gauss(rng));
}

export function gauss(rng) {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* When she pulls on a gripped thing, the side holding on less moves: her hold is what her other arms have sealed on the
   world, the object's is what it is wedged by. Only when neither is held does mass decide. */
export function whoMoves({ anchor = 0, objectHold = 0, objectMass = 0, bodyMass = 1 } = {}) {
  if (anchor > objectHold) return 'object';
  if (objectHold > anchor) return 'body';
  return objectMass <= bodyMass ? 'object' : 'body';
}

export const SEAL_NONE = 0, SEAL_WORK = 1, SEAL_HARD = 2;

/* One arm's suckers, each sealing and releasing on its own clock. segForce is what the sealed ones hold with, segCeil
   what they bear before cavitating; mode[j] says how a segment may seal, scale[j] what its taste leaves. */
export class SuckerBank {
  constructor(layout, armIndex, k = SUCKER_KNOBS, seed = 1) {
    this.k = k;
    this.relayout(layout);
    // Its own stream: drawing from the arm's would shift every reach's jitter.
    this.rng = mulberry32(((seed * 2246822519) ^ ((armIndex + 1) * 0x85EBCA6B) ^ 0x51C4E2) >>> 0);
    this.mod = 0;
    this.touching = 0;
    this.sealedCount = 0;
    this.time = 0;
  }

  relayout(layout) {
    this.L = layout;
    this.sealed = new Uint8Array(layout.n);
    this.sealedAt = new Float64Array(layout.n);
    this.segSealed = new Uint16Array(layout.S);
    this.segForce = new Float64Array(layout.S);
    this.segCeil = new Float64Array(layout.S);
    this.segCount = Uint16Array.from({ length: layout.S }, (_, j) => layout.segStart[j + 1] - layout.segStart[j]);
  }

  /* The share sealed this tick would settle at, after the arm's own slow wander in log-odds. */
  share(hard) {
    const base = hard ? this.k.hardShare : this.k.workShare;
    const lo = Math.log(base / (1 - base)) + (hard ? 0 : this.mod);
    return 1 / (1 + Math.exp(-lo));
  }

  step(dt, mode, scale) {
    const k = this.k, L = this.L, rng = this.rng, sealed = this.sealed;
    this.time += dt;
    if (dt > 0) {
      const a = dt / Math.max(1e-3, k.shareTau);
      this.mod += -this.mod * a + k.shareSpread * Math.sqrt(2 * a) * gauss(rng);
      const lo = Math.log(k.workShare / (1 - k.workShare)), hi = Math.log(k.shareMax / (1 - k.shareMax)) - lo;
      if (this.mod > hi) this.mod = hi; else if (this.mod < -hi) this.mod = -hi;
    }
    let touching = 0, total = 0;
    for (let j = 0; j < L.S; j++) {
      const m = mode[j], i0 = L.segStart[j], i1 = L.segStart[j + 1];
      let n = 0, f = 0, c = 0;
      if (m === SEAL_NONE) {
        for (let i = i0; i < i1; i++) sealed[i] = 0;
      } else {
        const hard = m === SEAL_HARD, s = this.share(hard);
        // Two-state chain per sucker, its rates set so s is the stationary share: a working seal lasts sealTime, and a
        // hard grip seals within hardAttach.
        const on = hard ? 1 / k.hardAttach : s / ((1 - s) * k.sealTime), off = hard ? (1 - s) / (s * k.hardAttach) : 1 / k.sealTime;
        const pOff = 1 - Math.exp(-dt * off), pOn = 1 - Math.exp(-dt * on);
        for (let i = i0; i < i1; i++) {
          if (sealed[i]) { if (rng() < pOff) sealed[i] = 0; }
          else if (rng() < pOn) { sealed[i] = 1; this.sealedAt[i] = this.time; }
          if (sealed[i]) { n++; f += hard ? L.fHard[i] : L.fWork[i]; c += L.fHard[i]; }
        }
        touching += i1 - i0;
      }
      this.segSealed[j] = n;
      this.segForce[j] = f * (scale ? scale[j] : 1);
      this.segCeil[j] = c * (scale ? scale[j] : 1);
      total += n;
    }
    this.touching = touching;
    this.sealedCount = total;
  }

  /* Everything lets go at once: a command, or a grip torn off. */
  releaseAll() { this.sealed.fill(0); this.segSealed.fill(0); this.segForce.fill(0); this.segCeil.fill(0); this.sealedCount = 0; }
}
