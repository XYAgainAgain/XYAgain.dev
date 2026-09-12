/* THREE-free math behind the pollen film: the lee-edge/rim/open-water layout, the shared rain-thinning
   one-pole, the active-count rule, and the puff cloud's per-card rolls. Pure, so the tests can hit them. */

export const POLLEN_EDGE_SHARE = 0.6;
// Zero at rest: the soft motes read as blurry spots under the water, so the film is all pinpricks. The
// class survives as a dial, and the shader still carries its branch.
export const POLLEN_MOTE_SHARE = 0;
export const POLLEN_MARGIN = 0.5;
export const POLLEN_RADIAL = [0.6, 1.5];
export const POLLEN_EDGE_BAND = [-2.6, 0];
export const POLLEN_TRIES = 16;
// A shower washes this share of the film out of the pond for good, and a lily's puff seeds the film
// again while it sits under this fraction of the pool.
export const POLLEN_WASH = 0.2;
export const POLLEN_REFILL_BELOW = 0.6;
export const POLLEN_REFILL_N = [30, 50];
export const POLLEN_RAIN_K = 0.3;
export const POLLEN_RAIN_ENV = 0.3;
export const POLLEN_RAIN_FALL = 4;
export const POLLEN_RAIN_RISE = 60;
// Rim homes: half the slots the lee-edge class leaves, hugging a pad, a rock, or the log inside a
// hand's width of its waterline, which is where real pollen scum collects.
export const POLLEN_RIM_SHARE = 0.5;
export const POLLEN_RIM_BAND = [0.0, 0.12];
// The sim's gains: target speeds in units/s, the finger's shove, a tap's burst within tapR (it must beat
// the adhesion break or a crust shrugs it off), the approach rate, and the release odds per second.
export const POLLEN_SIM = { wind: 0.10, cur: 0.12, eel: 0.5, poke: 1.0, pokeRadial: 0.4, tap: 1.5, tapR: 0.4, drag: 2.0, vmax: 3.0, break: 0.6, kick: 0.05, release: 1 / 180, matRelease: 1 / 45, freeFor: 3.0 };

// One burst's card count, each card's downwind speed at gust 0, and how long it lives: long enough to
// cross the frame and leave, since the cloud disperses by spread rather than by fading in place.
export const PUFF_CLOUD_N = [90, 140];
export const PUFF_CLOUD_SPEED = [0.35, 0.75];
export const PUFF_CLOUD_LIFE = [14, 20];
export const PUFF_CLOUD_SPREAD = 25 * Math.PI / 180;
export const PUFF_CLOUD_SCATTER = 0.4;     // birth scatter around the petal rim, in flower sizes
export const PUFF_CLOUD_RIM = 0.5;         // downwind offset of the birth point, in flower sizes

/* The pollen homes' downwind rejection, the specks' recipe: a candidate angle is accepted more often on the lee side, up to
   8 draws, so a lee-edge home is denser downwind without ever excluding the upwind rim. */
function windAngleAt(rng, windAngle) {
  let theta = 0;
  for (let k = 0; k < 8; k++) {
    theta = rng.range(0, Math.PI * 2);
    if (rng.next() < (1.05 + 0.55 * Math.cos(theta - windAngle)) / 1.6) break;
  }
  return theta;
}

/* Weighted by rim length (r × warpMean), so a big island draws more lee-edge homes than a small one. */
function pickClump(rng, clumps) {
  let total = 0;
  for (const c of clumps) total += c.r * c.warpMean;
  if (total <= 0) return -1;
  let t = rng.next() * total;
  for (let i = 0; i < clumps.length; i++) {
    t -= clumps[i].r * clumps[i].warpMean;
    if (t <= 0) return i;
  }
  return clumps.length - 1;
}

/* A disc contributes its circumference, a capsule the same cap circle plus its two flanks, so a long
   log draws more rim homes than a pebble does. */
function rimPerimeter(s) {
  const len = s.ax === undefined ? 0 : Math.hypot(s.bx - s.ax, s.bz - s.az);
  return 2 * Math.PI * s.r + 2 * len;
}

function pickRim(rng, rims) {
  let total = 0;
  for (const s of rims) total += rimPerimeter(s);
  if (total <= 0) return -1;
  let t = rng.next() * total;
  for (let i = 0; i < rims.length; i++) {
    t -= rimPerimeter(rims[i]);
    if (t <= 0) return i;
  }
  return rims.length - 1;
}

/* A home in the band just outside one rim's waterline. The candidate is built by offsetting a surface
   point, then verified against every rim, since a stadium offset near a cap can land inside a neighbor. */
function rimSite(rng, ctx) {
  const { rims, rimBand = POLLEN_RIM_BAND, rimAt, rect, memT, windAngle } = ctx;
  for (let tries = 0; tries < POLLEN_TRIES; tries++) {
    const ri = pickRim(rng, rims);
    if (ri < 0) return { x: 0, z: 0, ok: false };
    const s = rims[ri];
    const theta = windAngleAt(rng, windAngle);
    const d = rng.range(rimBand[0], rimBand[1]);
    let cx = s.x, cz = s.z;
    if (s.ax !== undefined) {
      const t = rng.next();
      cx = s.ax + (s.bx - s.ax) * t; cz = s.az + (s.bz - s.az) * t;
    }
    const x = cx + Math.cos(theta) * (s.r + d), z = cz + Math.sin(theta) * (s.r + d);
    if (Math.abs(x) > rect.ex || Math.abs(z) > rect.ez) continue;
    if (rimAt(x, z, 0) || !rimAt(x, z, d + 1e-4)) continue;
    if (memT(x, z) >= 0) continue;   // a mat already covering this rim owns the water; the collapse would hide the card anyway
    return { x, z, ok: true };
  }
  return { x: 0, z: 0, ok: false };
}

/* Uniform over ctx.rect, accepted where memT is negative (past the frond line) and unblocked. Shared by
   the open-water class and by a lee-edge or rim home that exhausts its own tries. */
function openWaterSite(rng, rect, memT, blocked) {
  for (let tries = 0; tries < POLLEN_TRIES; tries++) {
    const x = rng.range(-rect.ex, rect.ex), z = rng.range(-rect.ez, rect.ez);
    if (memT(x, z) < 0 && !blocked(x, z)) return { x, z, ok: true };
  }
  return { x: 0, z: 0, ok: false };
}

/* Returns pool records in a shuffled order, so the quality ladder's tail cut thins the lee-edge and
   open-water classes evenly. */
export function layoutPollen(rng, ctx) {
  const { pool, edgeShare = POLLEN_EDGE_SHARE, moteShare = POLLEN_MOTE_SHARE, rimShare = POLLEN_RIM_SHARE,
    clumps, rims = [], windAngle, rect, memT, blocked } = ctx;
  const edgeCount = clumps.length > 0 ? Math.round(pool * edgeShare) : 0;
  const rimCount = rims.length > 0 ? Math.round((pool - edgeCount) * rimShare) : 0;
  const records = [];
  for (let i = 0; i < pool; i++) {
    const mote = rng.next() < moteShare ? 1 : 0;
    const alphaRoll = rng.range(0.55, 1);
    const seed = rng.next();
    let x = 0, z = 0, clump = -1, rim = 0, placed = false;

    if (i < edgeCount) {
      const ci = pickClump(rng, clumps);
      const c = clumps[ci];
      for (let tries = 0; tries < POLLEN_TRIES && !placed; tries++) {
        const theta = windAngleAt(rng, windAngle);
        const frac = rng.range(POLLEN_RADIAL[0], POLLEN_RADIAL[1]);
        const d = frac * c.r * (c.growth ?? 1) * c.warp(theta);
        const cx = c.x + Math.cos(theta) * d, cz = c.z + Math.sin(theta) * d;
        // A clump leaning in from past the frame edge keeps its off-frame rim to itself: a card out there
        // would draw for nobody and read the mask's clamped border texel.
        if (Math.abs(cx) > rect.ex || Math.abs(cz) > rect.ez) continue;
        const t = memT(cx, cz);
        if (t >= POLLEN_EDGE_BAND[0] && t <= POLLEN_EDGE_BAND[1] && !blocked(cx, cz)) {
          x = cx; z = cz; clump = ci; placed = true;
        }
      }
      if (!placed) {
        const site = openWaterSite(rng, rect, memT, blocked);
        x = site.x; z = site.z; clump = -1; placed = site.ok;
      }
    } else if (i < edgeCount + rimCount) {
      const site = rimSite(rng, ctx);
      x = site.x; z = site.z; rim = site.ok ? 1 : 0; placed = site.ok;
      if (!placed) {
        const open = openWaterSite(rng, rect, memT, blocked);
        x = open.x; z = open.z; placed = open.ok;
      }
    } else {
      const site = openWaterSite(rng, rect, memT, blocked);
      x = site.x; z = site.z; clump = -1; placed = site.ok;
    }

    records.push({ x, z, clump, rim, mote, alpha: placed ? alphaRoll : 0, seed });
  }

  // Fisher-Yates on the same stream, so the ladder's tail cut thins every class evenly.
  for (let i = records.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = records[i]; records[i] = records[j]; records[j] = t;
  }
  return records;
}

/* One-pole toward POLLEN_RAIN_K while a shower runs, recovering toward 1 after: losing the film is
   quicker than growing it back, the same asymmetry the algae cover field uses. */
export function rainThinStep(k, envelope, dt) {
  const target = envelope > POLLEN_RAIN_ENV ? POLLEN_RAIN_K : 1;
  const tau = target < k ? POLLEN_RAIN_FALL : POLLEN_RAIN_RISE;
  return k + (target - k) * Math.min(1, dt / tau);
}

export function pollenActive(pool, fraction, on, rainK) {
  if (!on) return 0;
  return Math.max(0, Math.min(pool, Math.round(pool * fraction * rainK)));
}

/* How many cards one burst gets, before the quality scale and the reduced-motion halving. Never zero:
   a flower that puffs has to be seen puffing. */
export function puffCloudCount(prng, scale = 1, reduced = false) {
  const roll = PUFF_CLOUD_N[0] + (PUFF_CLOUD_N[1] - PUFF_CLOUD_N[0]) * prng.next();
  const n = Math.max(1, Math.round(Math.round(roll) * scale));
  return reduced ? Math.ceil(n / 2) : n;
}

/* One burst's cards. Every card gets its own bearing, speed, and life, which is what disperses the
   cloud: the shader only ever advances a card along its own line, so there is no per-frame CPU work. */
export function puffCloudCards(prng, { count, windAngle, gust = 0 }) {
  const cards = [];
  const gustK = 0.6 + 0.6 * Math.max(0, gust);
  for (let i = 0; i < count; i++) {
    const ang = windAngle + (prng.next() * 2 - 1) * PUFF_CLOUD_SPREAD;
    const speed = (PUFF_CLOUD_SPEED[0] + (PUFF_CLOUD_SPEED[1] - PUFF_CLOUD_SPEED[0]) * prng.next()) * gustK;
    const life = PUFF_CLOUD_LIFE[0] + (PUFF_CLOUD_LIFE[1] - PUFF_CLOUD_LIFE[0]) * prng.next();
    // Birth scatter over the petal rim's disc, not a square, so the cloud starts round.
    const sa = prng.next() * Math.PI * 2, sr = Math.sqrt(prng.next()) * PUFF_CLOUD_SCATTER;
    cards.push({
      dirX: Math.cos(ang), dirZ: Math.sin(ang), speed, life,
      offX: Math.cos(sa) * sr, offZ: Math.sin(sa) * sr, seed: prng.next(),
    });
  }
  return cards;
}

/* A card that left the frame comes back on the upwind edge, a margin outside the rect, so it drifts in
   rather than popping into view; wind is the bearing the air blows toward. */
export function upwindEdgeSpawn(rng, wind, rect, margin) {
  const wx = wind.x || 0, wz = wind.z || 0;
  if (Math.abs(wx) >= Math.abs(wz)) {
    return { x: -(wx >= 0 ? 1 : -1) * (rect.ex + margin), z: rng.range(-rect.ez, rect.ez) };
  }
  return { x: rng.range(-rect.ex, rect.ex), z: -(wz >= 0 ? 1 : -1) * (rect.ez + margin) };
}

/* Where a puff's grains settle onto the film: points along the cloud's own bearings and speeds, at
   ages inside its life, kept inside the rect. */
export function puffSettleSites(prng, { x, z, count, windAngle, gust = 0, rect }) {
  const sites = [];
  const cards = puffCloudCards(prng, { count: count * 2, windAngle, gust });
  for (const c of cards) {
    if (sites.length >= count) break;
    const t = 1 + prng.next() * (c.life - 1);
    const sx = x + c.offX + c.dirX * c.speed * t, sz = z + c.offZ + c.dirZ * c.speed * t;
    if (Math.abs(sx) <= rect.ex && Math.abs(sz) <= rect.ez) sites.push({ x: sx, z: sz });
  }
  return sites;
}

export function adhesionBreaks(pushX, pushZ, threshold) {
  return pushX * pushX + pushZ * pushZ > threshold * threshold;
}
