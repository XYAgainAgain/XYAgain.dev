import * as THREE from 'three/webgpu';
import { DEPTH, EEL_POINTS } from './config.js';
import { segDist, retreatAlongTrail, growEel } from './eel-physics.js';
import { FOOD_DRUNK, foodDrunk } from './eel-quirks.js';
import { wrapPi } from './eel-brain-core.js';

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

// Real-eel locomotion baseline: tail-beat Hz = F_IDLE + F_K × speed in body lengths/s (BL/s).
const F_IDLE = 0.6, F_K = 1.4;
const WRAP = Math.PI * 2 * 1000;
const HALF_PI = Math.PI / 2, FULL_TURN = Math.PI * 2;
// Far enough in the past that `now - stuckAt` never reads as stuck, even in the first seconds of a boot.
const NOT_STUCK = -999;
const WHITE = new THREE.Color(1, 1, 1);
// Naps are catching: a resting neighbor within NAP_REACH raises the odds of settling, deep sleepers
// more so, and every extra napper stacks toward NAP_CAP. Anything at all wakes them.
const NAP_REACH = 3.5, NAP_GAIN = 0.3, NAP_CAP = 0.6, NAP_DEEP = 1.5, NAP_LONG = [8, 20];
// Twining: fond eels traveling together braid around a shared guide point, a helix per member. Two make
// a double helix, three a challah. The guide crawls toward the leader's own wander target.
const TWINE_R = 0.24, TWINE_RY = 0.15, TWINE_OMEGA = Math.PI * 2 / 3.2, TWINE_LEN = [8, 16], TWINE_REACH = 1.6, TWINE_CHANCE = 0.1;
const SICKLE_SKIN = new THREE.Color(1, 0.85, 0.2), SICKLE_GLOW = new THREE.Color(1, 0.2, 0.15);
const TUNNEL_DIALS = { stall: 6, cooldown: 45, odds: 0.3, crowd: 1.5, snakeCool: 2 };   // fallback; pond.eels.knobs.tunnel is the live copy
const tunnelDial = (sys, key) => sys?.knobs?.tunnel?.[key] ?? TUNNEL_DIALS[key];
const RUNOUT_STEPS = 8;
// A hold bout the eel is actually holding. The nominal gait alone is not a rest: grazing and the tea
// ritual both write one while the eel is still travelling.
const HOLD_STILL = 0.2;

/* Every field a census knob or quirk owns, wiped whenever the eel wearing them changes. A hot-swap
   re-runs applyIdentity and drops the plan, but it cannot know about state invented out here. */
function initQuirkState(e) {
  e.quirkFor = e.identity;
  e.freezeUntil = 0;
  e.laterAt = 0;
  e.laterSpook = { x: 0, z: 0 };
  e.burstUntil = 0;
  e.stalkUntil = 0;
  e.bonkUntil = 0;
  e.bonkAng = 0;
  e.bonkFood = null;
  e.gourmetAt = 0;
  e.snack = { x: 0, z: 0, r: 0, ang: 0, until: 0 };
  e.snuggle = { with: null, until: 0 };
  e.twine = null;   // the shared group record while braiding, null otherwise
  e.restPose = { kind: '', from: 0, dur: 0, x: 0, z: 0, ang: 0, r0: 0, r1: 0, rate: 0, dirSign: 1 };
  e.poseBout = -1;
  e.loopAng = 0;
  e.rescueTo = null;
  e.rescueUntil = 0;
  e.buttAt = 0;
  e.buttTo = null;
  e.buttUntil = 0;
  e.buttBurst = 0;
  e.cuddle = { with: null, until: 0 };
  e.singAt = 0;
  e.snapAt = 0;
  e.shipAt = 0;
  e.stuckAt = NOT_STUCK;
  // The escape and stuck accumulators outlive the eel who armed them, so a newcomer can inherit up to
  // 1.1 s of reverse-swim and a queued zig. Off-screen by construction, but it is still the wrong eel.
  e.nopeUntil = 0;
  e.nopeZig = 0;
  e.attnReset = false;
  e.stuckFor = 0;
  e.boreRefusedAt = 0;
  e.gaitFrom = e.gaitFrom ?? 0;
  if (e.food) { e.food.claims = Math.max(0, e.food.claims - 1); e.food = null; }
}

/* In-place expiry: no per-tick array churn. */
export function expire(arr, now, maxAge) {
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (now - arr[i].t < maxAge) arr[w++] = arr[i];
  arr.length = w;
}

// Measured slip U/V: the body wave outruns the eel ~5× at a prowl, ~2× at a dash.
function slipFor(u) {
  return u < 1 ? 0.18 + 0.32 * Math.max(0, (u - 0.2) / 0.8) : Math.min(0.63, 0.5 + 0.13 * (u - 1));
}

// Fit test before committing to the bore; a too-fat eel never enters, it only shelters beside rocks.
function logFits(e, log) { return log.rInner >= e.radius * 1.15 + 0.02; }

const isMouth = (l, p) => l.a.distanceTo(p) < 1e-3 || l.b.distanceTo(p) < 1e-3;

/* The log a run belongs to; startTunnel keeps the mouths, so match on them. */
export function tunnelLog(colliders, t) {
  if (!t) return null;
  for (const l of colliders.logs) if (isMouth(l, t.entry) || isMouth(l, t.exit)) return l;
  return colliders.logs[0] ?? null;
}

function runoutClear(e, pt, bore) {
  for (const o of e.colliders.spheres) {
    if (Math.hypot(pt.x - o.x, pt.z - o.z) < (o.rHit ?? o.r) + e.radius) return false;
  }
  for (const l of e.colliders.logs) {
    if (l === bore) continue;
    if (segDist(pt.x, pt.z, l.a.x, l.a.z, l.b.x, l.b.z) < l.rOuter + e.radius) return false;
  }
  return true;
}

/* The run-out has to be water the eel can actually reach, corridor included: walk out from the far
   mouth along the axis and keep the last sample before anything blocks the way. A run-out buried in
   a rock stalled the run for good; one on the far side of a rock would do the same. */
function clearRunout(e, entry, exit, axis) {
  const bore = e.colliders.logs.find((l) => isMouth(l, entry) || isMouth(l, exit)) ?? null;
  const full = e.length + 0.6, pt = new THREE.Vector3(), last = exit.clone();
  for (let i = 1; i <= RUNOUT_STEPS; i++) {
    pt.copy(exit).addScaledVector(axis, full * i / RUNOUT_STEPS);
    if (!runoutClear(e, pt, bore)) break;
    last.copy(pt);
  }
  return last;
}

/* False when the far side has no room for the whole body to clear the wood before the head arrives,
   unless forced: an eel already inside the bore has to run somewhere. */
export function startTunnel(e, entry, exit, now, force = false) {
  // Line up on the axis two units out from the mouth first, so the head enters the bore straight.
  const axis = new THREE.Vector3().subVectors(exit, entry).normalize();
  const approach = entry.clone().addScaledVector(axis, -2.0);
  // Run-out past the far mouth keeps the tail from being dragged through the rim when the head turns away.
  const runout = clearRunout(e, entry, exit, axis);
  if (!force && runout.distanceTo(exit) < e.length) { e.boreRefusedAt = now; return false; }
  e.tunnel = { approach, entry, exit, runout, stage: 0, bestD: Infinity, noProg: 0 };
  e.target.copy(approach);
  e.retargetAt = now + 30;
  e.boreAt = now;
  return true;
}

/* A forced run's run-out may sit right at the mouth, so the head arriving is not the end of it. */
function tailClear(e) {
  const l = tunnelLog(e.colliders, e.tunnel);
  if (!l) return true;
  const p = e.pts[e.pts.length - 1];
  return segDist(p.x, p.z, l.a.x, l.a.z, l.b.x, l.b.z) > l.rOuter;
}

/* Is the head inside the bore this run belongs to? A run abandoned there turns the body through the
   log wall, so it is the one place the retarget gate may not fire. */
function headInBore(e) {
  const l = tunnelLog(e.colliders, e.tunnel);
  if (!l) return false;
  return segDist(e.head.x, e.head.z, l.a.x, l.a.z, l.b.x, l.b.z) < l.rInner;
}

export function pickTarget(sys, e, now) {
  const rng = e.rng;
  // A ridge claim lives in the habitat, so re-picking has to hand it back before forgetting it.
  if (e.coverSpot?.type === 'ridge') sys?.habitat?.release(e.coverSpot.id);
  e.coverSpot = null;
  const flock = e.flock || [];
  // Eels move on wet nights, so a shower thins the appetite for cover. It only ever reweights an
  // existing roll: no extra targets, no extra rolls, nothing new to simulate.
  const env = sys?.rain?.envelope ?? 0;
  const act = 1 + 0.35 * env;
  // The kettle outranks the log: a due cup keeps the tea drinker out of the bore until it is drunk.
  if (e.quirks.tea && sys?.tea?.pickTarget(sys, e, now)) return;
  // Tunnel runs: a good share of the time the next destination is one log mouth, then the other.
  // Crowded cover loses its appeal, and a laired guest closes the log to everyone but her admirer.
  const log = e.colliders.logs[0];
  const lairBlocked = !!(sys?.lairGuest && e.quirks.follows !== sys.lairGuest.name);
  const moonCover = sys.air?.coverMul(e) ?? 1;
  // The bore is the one stretch a snake cannot swim on cardinals, so Jaz waits longer between runs.
  const cooldown = tunnelDial(sys, 'cooldown') * (e.quirks.snake ? tunnelDial(sys, 'snakeCool') : 1);
  if (log && !lairBlocked && e.tunnel === null && logFits(e, log) && now - e.boreAt > cooldown) {
    // Crowding counts live runs rather than the coverSpot label, which one eel drops the moment its
    // own run ends; the moon reweights the bore the way it already reweights every other cover branch.
    const logClaims = flock.reduce((n, o) => n + (o !== e && o.tunnel ? 1 : 0), 0);
    const odds = Math.min(0.85, tunnelDial(sys, 'odds') * e.traits.cover / act) * moonCover;
    if (rng.chance(odds / (1 + tunnelDial(sys, 'crowd') * logClaims))) {
      const fromA = rng.chance(0.5);
      const m0 = fromA ? log.a : log.b, m1 = fromA ? log.b : log.a;
      // The other direction may have the room this one lacks; neither means the log is off the menu.
      if (startTunnel(e, m0, m1, now) || startTunnel(e, m1, m0, now)) {
        e.coverSpot = { type: 'log', idx: 0 };
        return;
      }
    }
  }
  e.tunnel = null;
  // The herbivore menu owns its own targets (duckweed, tufts, pads) and may not be wired up yet.
  if (e.quirks.graze && sys.graze?.pickTarget(sys, e, now)) return;
  // Half the time head for cover: under a lily pad or beside a rock. Otherwise wander the viewport
  // and a little past it, so they drift in and out but never leave for long.
  const pads = sys?.habitat?.pads ?? [];
  const rocks = e.colliders.spheres;
  let covered = false;
  if (pads.length && rng.chance(Math.min(0.5, 0.2 * e.traits.cover / act) * moonCover)) {
    const claims = pads.map((_, i) => flock.reduce((n, o) => n + (o !== e && o.coverSpot?.type === 'pad' && o.coverSpot.idx === i ? 1 : 0), 0));
    const least = Math.min(...claims);
    const idx = rng.pick(pads.map((_, i) => i).filter((i) => claims[i] === least));
    e.target.set(pads[idx].x, 0, pads[idx].z);
    // holdUntil 0 means "on the way"; arrival in steer() sets the loiter and its end.
    e.coverSpot = { type: 'pad', idx, holdUntil: 0 };
    covered = true;
  } else if (sys?.habitat && rng.chance(Math.min(0.35, 0.15 * e.traits.cover / act) * moonCover)) {
    // The dry crest of a log is cover of its own: the eel rests along it with its head out.
    const perch = sys.habitat.nearestPerch(e.head.x, e.head.z, 'log', true);
    if (perch && sys.habitat.claim(perch.id, e)) {
      e.target.set(perch.x, 0, perch.z);
      // peeked flips on arrival in steer(); the peek is a reward for reaching the crest, not for picking it.
      e.coverSpot = { type: 'ridge', id: perch.id, x: perch.x, y: perch.y, z: perch.z, peeked: false };
      covered = true;
    }
  } else if (rocks.length && rng.chance(Math.min(0.6, 0.2 * e.traits.cover / act) * moonCover)) {
    covered = rockCover(sys, e, rocks, flock, rng, now);
  }
  if (!covered) {
    const ex = e.view.w * 0.48, ez = e.view.h * 0.48;
    // Andy's ripple habit in the rain: now and then the next wander target is a drop that actually
    // landed, taken from the injector's own published positions rather than any spook.
    const drop = e.quirks.rippleChase && env > 0 && rng.chance(0.5 * env) ? sys.rain.freshInterest(5) : null;
    const party = e.census.party;
    if (drop) e.target.set(drop.x, 0, drop.z);
    // B4: nothing in the water, hungry, and smart enough to go check where dinner was last time.
    else if (sys.braincell?.pickMemory(e, now)) { /* the memory trip owns the target */ }
    else {
      // Home fidelity biases the draw; the party and patrol re-rolls then apply to that same draw.
      const a = sys.braincell?.anchorDraw(e, ex, ez) ?? null;
      let ux = a ? a.ux : rng.range(-1, 1), uz = a ? a.uz : rng.range(-1, 1);
      if (party === 'exits') {
        for (let i = 0; i < 4 && Math.abs(ux) <= 0.3 && Math.abs(uz) <= 0.3; i++) { ux = rng.range(-1, 1); uz = rng.range(-1, 1); }
      } else if (party === 'center') {
        for (let i = 0; i < 4 && (Math.abs(ux) > 0.34 || Math.abs(uz) > 0.34); i++) { ux = rng.range(-1, 1); uz = rng.range(-1, 1); }
      }
      // Marc's patrol: a target he has to actually travel to, so the search never reads as fidgeting.
      if (e.quirks.wander) {
        const far = e.view.w * 0.5;
        for (let i = 0; i < 4 && Math.hypot(ux * ex - e.head.x, uz * ez - e.head.z) < far; i++) { ux = rng.range(-1, 1); uz = rng.range(-1, 1); }
      }
      e.target.set(ux * ex, 0, uz * ez);
    }
  }
  e.retargetAt = now + rng.range(e.traits.attention[0], e.traits.attention[1]);
  // Over the log rather than through it, when the line to the target just drawn crosses one. The
  // module owns the odds, the eligibility, and its own repeat cooldown.
  if (log && !lairBlocked && sys.air && routeCrossesLog(e, log)) sys.air.tryFlop(e, log, e.target);
  // Rain: the investigate startle styles and Andy read a ticking film as something worth a look.
  if (env > 0 && (e.census.startle === 'investigate' || e.quirks.rippleChase)) sys.air?.tryPeek(e, 'rain');
}

/* Does the straight line to the target pass through the log's outer capsule? Eight samples along the
   route, not its midpoint: a route can clip the wood near either end with a clear middle. */
function routeCrossesLog(e, log) {
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, px = e.head.x + (e.target.x - e.head.x) * t, pz = e.head.z + (e.target.z - e.head.z) * t;
    if (segDist(px, pz, log.a.x, log.a.z, log.b.x, log.b.z) < log.rOuter) return true;
  }
  return false;
}

/* Every path that abandons cover early (a scare, a crumb, a scatter) goes through here, so a ridge
   claim never outlives its coverSpot and a crevice nobody is heading for stops counting as taken. */
export function dropCover(sys, e) {
  const t = e.coverSpot?.type;
  if (t === 'ridge') sys.habitat?.release(e.coverSpot.id);
  if (t === 'pad' || t === 'ridge' || t === 'rock') e.coverSpot = null;
}

/* B6's scored crevice pick. The random angle past one rock's radius survives as the fallback for a
   pond running without the braincell module. */
function rockCover(sys, e, rocks, flock, rng, now) {
  if (sys?.braincell) return sys.braincell.creviceSpot(e, now);
  const claims = rocks.map((_, i) => flock.reduce((n, o) => n + (o !== e && o.coverSpot?.type === 'rock' && o.coverSpot.idx === i ? 1 : 0), 0));
  const least = Math.min(...claims);
  const idx = rng.pick(rocks.map((_, i) => i).filter((i) => claims[i] === least));
  const o = rocks[idx];
  const a = rng.range(0, Math.PI * 2), d = o.r + rng.range(0.6, 1.6);
  e.target.set(o.x + Math.cos(a) * d, 0, o.z + Math.sin(a) * d);
  e.coverSpot = { type: 'rock', idx };
  return true;
}

/* Hold/prowl/cruise cadence: travel in bouts, then settle; anguilliforms stop rather than coast.
   act is the rain activity multiplier and only ever bends these odds; bout lengths stay untouched. */
function updateGait(sys, e, now, act) {
  if (now < e.gaitUntil) return;
  const rng = e.rng, t = e.traits;
  e.gaitFrom = now;   // bout length, which is what the deep-rest poses key off
  if (e.gait === 'hold') { e.gait = rng.chance(0.75 / act) ? 'prowl' : 'cruise'; e.gaitUntil = now + rng.range(t.travelTime[0], t.travelTime[1]); }
  else {
    // The nap field: one draw either way, so the odds only move when somebody nearby is resting.
    let nap = 0, napper = null, best = 0;
    for (const o of e.flock ?? []) {
      if (o === e || o.slurpedBy || o.gait !== 'hold' || now >= o.gaitUntil) continue;
      const w = Math.max(0, 1 - Math.hypot(o.head.x - e.head.x, o.head.z - e.head.z) / NAP_REACH) * (o.gaitUntil - o.gaitFrom > 5 ? NAP_DEEP : 1);
      nap += w;
      if (w > best) { best = w; napper = o; }
    }
    // F5 bends both odds at once: a fresh alarm keeps everyone up, a well-slept corner invites the
    // next bout. The draw happens either way, so the rng stream never shifts with it.
    const mood = sys.fear?.holdMul(e) ?? 1;
    const p = (t.holdChance / act) * mood, bonus = Math.min(NAP_CAP, nap * NAP_GAIN) * mood, u = rng.next();
    if (u < p || u < p + (1 - p) * bonus) {
      e.gait = 'hold'; e.gaitUntil = now + rng.range(t.holdTime[0], t.holdTime[1]);
      if (u >= p && napper) {
        // A caught nap runs long enough to radiate in turn; affection decides whether it is a snuggle.
        e.gaitUntil = Math.max(e.gaitUntil, now + rng.range(NAP_LONG[0], NAP_LONG[1]));
        const fond = napper === e.partner || e.quirks.cuddly ? 0.9 : (e.cuddle.with === napper && now < e.cuddle.until) ? 0.7 : 0.25;
        if (rng.chance(fond)) {
          e.snuggle.with = napper; e.snuggle.until = e.gaitUntil;
          e.cuddle.with = napper; e.cuddle.until = e.gaitUntil;
        }
      }
    }
    else { e.gait = rng.chance(0.35) ? 'cruise' : 'prowl'; e.gaitUntil = now + rng.range(t.travelTime[0], t.travelTime[1]); }
  }
  // Loopies: a prowl bout becomes a long lazy circle instead. Gated by the quirk, so nobody else draws.
  if (e.quirks.loopies && e.gait === 'prowl' && rng.chance(0.3)) { e.gait = 'loop'; e.gaitUntil = now + rng.range(6, 12); }
}

/* Jaz's freeze: prey stillness, not a retreat. No force, no travel, and the excitement still spikes. */
function freezeTick(sys, e, dt) {
  e.reverse = false;
  e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 8);
  paceWave(e, dt, true);
  e.uExcite.value += (1 - e.uExcite.value) * Math.min(1, dt * 3);
  e.squash += (1 - e.squash) * Math.min(1, dt * 5);
  e.uSquash.value = e.squash;
  e.lastX = e.head.x; e.lastZ = e.head.z;
}

/* Rest poses: the target walks a shape and the chain solver draws it. 'coil' tightens into a spiral,
   'sickle' is one slow arc. Center sits ahead-left of the head so the curl closes on its own path. */
function startPose(e, kind, now) {
  const p = e.restPose, head = e.head, L = e.length;
  const lx = e.heading.z, lz = -e.heading.x;   // screen-left of the heading
  const off = kind === 'coil' ? 0.7 : 0;
  p.x = head.x + e.heading.x * off * L + lx * (kind === 'coil' ? off * L : 0.3 * L);
  p.z = head.z + e.heading.z * off * L + lz * (kind === 'coil' ? off * L : 0.3 * L);
  p.kind = kind;
  p.from = now;
  p.ang = Math.atan2(head.z - p.z, head.x - p.x);
  const dir = e.rng.chance(0.5) ? 1 : -1;
  if (kind === 'coil') {
    p.dur = e.rng.range(3, 4);
    p.r0 = 0.45 * L; p.r1 = e.radius * 2;
    p.rate = 0;   // spiral angular rate follows the shrinking radius, recomputed each tick
  } else {
    p.dur = 2;
    p.r0 = p.r1 = 0.3 * L;
    p.rate = dir * (150 * Math.PI / 180) / 2;
  }
  p.dirSign = dir;
}

/* Snake rules for Jaz: a cardinal is blocked when their own body lies across the next stretch of it.
   The neck is skipped, since the first few points always trail right behind the head. */
export function snakeBlocked(e, hx, hz) {
  const head = e.head, look = Math.max(0.6, e.length * 0.4), lane = e.radius * 2.5 + 0.05;
  for (let i = 4; i < e.pts.length; i++) {
    const p = e.pts[i];
    const dx = p.x - head.x, dz = p.z - head.z;
    const along = dx * hx + dz * hz;
    if (along <= 0 || along > look) continue;
    if (Math.abs(dx * hz - dz * hx) < lane) return true;
  }
  return false;
}

/* How fond e is of o: a bond, two cuddly eels, or Bee's matchmaking; 0 means no braiding. Shared,
   and guest-safe: a visitor carries none of the resident-only fields, so it is fond of nobody. */
export function affection(e, o, now) {
  if (!e || !o || e === o) return 0;
  if (o === e.partner || e === o.partner) return 1;
  if (e.quirks?.cuddly && o.quirks?.cuddly) return 0.85;
  if (e.cuddle?.with === o && now < e.cuddle.until) return 0.6;
  return 0;
}

// A crusher is spoken for: whichever social bout started first wins, and a braid recruiting one
// mid-bout would overwrite the lane target under a claim the crush already holds.
function twineFree(sys, o, now) {
  return !o.slurpedBy && !o.tunnel && !o.food && !o.twine && o.gait !== 'hold' && now > o.fleeUntil && !o.restPose?.kind && !sys.crush?.active(o);
}

function endTwine(g) {
  for (const m of g.members) if (m.twine === g) m.twine = null;
}

/* Vi's next victim: on screen, reachable, and weighted so her favorite target comes up most. */
function pickVictim(e, hb) {
  const hw = e.view.w * 0.5, hh = e.view.h * 0.5;
  const spare = hb.spare ?? [];
  const eligible = (o) => o !== e && !o.slurpedBy && !o.tunnel && !spare.includes(o.name) && Math.abs(o.head.x) < hw && Math.abs(o.head.z) < hh;
  const weigh = (o) => (o.name === hb.favorite ? hb.favoriteWeight : 1);
  let total = 0;
  for (const o of e.flock) if (eligible(o)) total += weigh(o);
  if (total <= 0) return null;
  let r = e.rng.next() * total;
  for (const o of e.flock) { if (!eligible(o)) continue; r -= weigh(o); if (r < 0) return o; }
  return null;
}

/* Walks the pose one tick, parking the target on it unless something louder owns the target. It
   keeps running either way so the shape always expires on its own clock rather than getting stuck. */
function poseTick(e, dt, now, apply) {
  const p = e.restPose;
  if (!p.kind) return false;
  const t = (now - p.from) / p.dur;
  if (t >= 1) { p.kind = ''; return false; }
  const r = p.r0 + (p.r1 - p.r0) * t;
  p.ang += (p.rate || (p.dirSign * e.prowlBL * e.length / Math.max(0.1, r))) * dt;
  if (apply) e.target.set(p.x + Math.cos(p.ang) * r, 0, p.z + Math.sin(p.ang) * r);
  return apply;
}

/* Tail beat is an output of speed; wavelength comes from measured slip, clamped to 0.58–0.85 L.
   Shared by steer() and guest brains (Eleanor) so every swimmer waves honestly. */
export function paceWave(e, dt, resting) {
  const f = F_IDLE + F_K * e.speedBL;
  e.wavePhase += Math.PI * 2 * f * dt;
  if (e.wavePhase > WRAP) e.wavePhase -= WRAP;
  const lambda = Math.min(0.85, Math.max(0.58, e.speedBL / (slipFor(e.speedBL) * f)));
  e.waveK = (Math.PI * 2) / ((EEL_POINTS - 1) * lambda);
  e.ampMul += ((resting ? 0.15 : 1) - e.ampMul) * Math.min(1, dt * 3);
  e.anterior += ((0.2 + 0.8 * Math.min(1, e.speedBL / 1.6)) - e.anterior) * Math.min(1, dt * 3);
  return f;
}

/* Tick Contract step 2: the movement owners in priority order, highest first. The first claim of a
   tick holds the eel and only a strictly higher tier may take it away. */
export const TICK_TIERS = ['slurp', 'air', 'tunnel', 'escape', 'scatter', 'contest', 'meal', 'social', 'voluntary', 'wander'];
const TIER_RANK = new Map(TICK_TIERS.map((t, i) => [t, i]));

export function claimTick(e, tier, name) {
  const rank = TIER_RANK.get(tier);
  if (rank === undefined) return false;
  const held = e.tick.tier === null ? Infinity : TIER_RANK.get(e.tick.tier);
  if (rank >= held) return false;
  e.tick.tier = tier;
  e.tick.owner = name ?? tier;
  return true;
}

/* The one un-claim: an owner that ended its own reason for holding the eel mid-tick hands the tick back. */
export function releaseTick(e, tier) {
  if (e.tick.tier !== tier) return;
  e.tick.tier = null; e.tick.owner = null;
}

/* Whether a tier above the caller's already holds the eel. A module that lost the tick may keep its
   clocks running, but it may not write the target. */
export function tickHeldAbove(e, tier) {
  const rank = TIER_RANK.get(tier);
  if (rank === undefined || e.tick.tier === null) return false;
  return TIER_RANK.get(e.tick.tier) < rank;
}

/* Tick Contract step 5. The blocks above compute the defaults, the tick's owner overrides only what
   it cares about, and nothing past this line touches these fields again. */
export function commitPose(e) {
  const p = e.pose;
  if (p.speed !== null) e.speedBL = p.speed;
  if (p.targetY !== null) e.targetY = p.targetY;
  if (p.ampMul !== null) e.ampMul = p.ampMul;
  if (p.squash !== null) e.squash = p.squash;
  if (p.excite !== null) e.uExcite.value = p.excite;
  if (p.roll !== null) e.roll = p.roll;
  e.uSquash.value = e.squash;
  if (e.uRoll) e.uRoll.value = ((e.roll % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

/* Every owner that takes Jaz's grid off, in one place. Air states and the reverse escape return from
   steer long before the solve, so they never reach this test. A tunnel run only owns the heading from
   the last unit before its approach point through the wood: the open-water swim to it stays on the grid. */
function gridOff(e, now) {
  const t = e.tunnel;
  const axisBound = !!t && (t.stage > 0 || Math.hypot(t.approach.x - e.head.x, t.approach.z - e.head.z) < 1.0);
  return axisBound || now <= e.fleeUntil || !!e.restPose.kind
    || (e.gait === 'hold' && now < e.gaitUntil && !e.food && e.speedBL < HOLD_STILL);
}

const cardX = (q) => Math.round(Math.cos(q * HALF_PI));
const cardZ = (q) => Math.round(Math.sin(q * HALF_PI));

/* Keeps a fresh or swapped-in Jaz on the grid, and hands back the cardinal they are on. */
function snapCardinal(e) {
  const q = ((Math.round(Math.atan2(e.heading.z, e.heading.x) / HALF_PI) % 4) + 4) % 4;
  const cx = cardX(q), cz = cardZ(q);
  if (cx !== e.heading.x || cz !== e.heading.z) e.heading.set(cx, 0, cz);
  return q;
}

/* Snake rules for Jaz, as the solve's quantizer rather than a second solve: the adapter answers for
   them like everyone else, and the grid takes the legal cardinal nearest that answer. Never the
   reverse, never through their own body, and a short dwell against diagonal stutter. */
function gridHeading(sys, e, want, forceAng, now) {
  const brain = sys.braincell;
  const q0 = snapCardinal(e);
  let qc = q0;
  if (now >= e.snapAt || snakeBlocked(e, cardX(q0), cardZ(q0))) {
    let bestOff = Infinity, anyOff = Infinity, pick = -1, open = -1;
    for (let q = 0; q < 4; q++) {
      if (q === (q0 + 2) % 4 || snakeBlocked(e, cardX(q), cardZ(q))) continue;
      const off = Math.abs(wrapPi(q * HALF_PI - want));
      if (off < anyOff) { anyOff = off; open = q; }
      if (brain && !brain.snapLegal(e, want, q * HALF_PI)) continue;
      if (off < bestOff) { bestOff = off; pick = q; }
    }
    // Nothing legal: still the cardinal closest to the solved heading. A danger-only fallback is what
    // used to leave them committed to a direction their own pull was pointing away from.
    if (pick >= 0) qc = pick;
    else if (open >= 0) qc = open;
  }
  if (cardX(qc) !== e.heading.x || cardZ(qc) !== e.heading.z) {
    e.heading.set(cardX(qc), 0, cardZ(qc));
    e.snapAt = now + 0.4;
  }
  // Routed only when the grid took something other than the cardinal nearest the pull, on the wrapped
  // angle: rounded quadrant indices call -2 and +2 two different directions.
  const qn = ((Math.round(forceAng / HALF_PI) % 4) + 4) % 4;
  brain?.reportHeading(e, qc * HALF_PI, forceAng, qc !== qn);
}

/* Tick Contract step 4: the one place a resident's heading turns. sys.headingAdapter replaces the
   desired angle (Chunk 1's context steering) and the clamps still apply to whatever it hands back. */
function solveHeading(sys, e, force, dt, asleep) {
  const now = sys.time;
  const forced = force.x * force.x + force.z * force.z > 1e-6;
  if (asleep) return;   // half-buried on the floor: the heading is locked until the bout ends
  const grid = e.quirks.snake && !gridOff(e, now);
  if (!forced) {
    // Nothing pulling: hold the heading, but a snake eel still holds a cardinal one.
    if (grid) {
      const a = snapCardinal(e) * HALF_PI;
      sys.braincell?.reportHeading(e, a, a, false);
    }
    return;
  }
  const want = sys.headingAdapter ? sys.headingAdapter(sys, e, force, dt) : Math.atan2(force.z, force.x);
  if (grid) { gridHeading(sys, e, want, Math.atan2(force.z, force.x), now); return; }
  let diff = want - Math.atan2(e.heading.z, e.heading.x);
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  // +yaw carries +x toward +z, which is screen-right toward screen-down: clockwise. So left is
  // negative, and a right-hand turn has to take the long way round instead of freezing straight.
  if (e.quirks.leftOnly && diff > 0) diff -= Math.PI * 2;
  // Max yaw grows as speed drops, and sharpens again within a body length of food so the snout homes
  // in. Not for Heather: every correction is a full loop, and a faster loop is a Beyblade.
  const snout = e.food && e.foodDist < e.length && !e.quirks.leftOnly ? 1.4 : 1;
  const maxTurn = e.turnRate * snout * (1 + 0.6 * (e.speedMul - 1)) * (1.6 - 0.6 * Math.min(1, e.speedBL / e.cruiseBL)) * dt;
  const yaw = Math.max(-maxTurn, Math.min(maxTurn, diff * Math.min(1, dt * 9)));
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const hx = e.heading.x * c - e.heading.z * sn, hz = e.heading.x * sn + e.heading.z * c;
  e.heading.set(hx, 0, hz).normalize();
}

/* The nope: hold tight if already denned, back straight up when threatened head-on with trail
   to spare, bolt for the log when it fits and is close; otherwise the plain flee burst handles it.
   opts.avoidLog shuts the bore to a scatter whose threat is the thing living in it. */
export function nope(sys, e, s, now, opts = null) {
  const head = e.head;
  const log = sys.colliders.logs[0];
  const lairBlocked = !!(sys.lairGuest && e.quirks.follows !== sys.lairGuest.name) || (!!opts?.avoidLog && opts.avoidLog === log);
  if (log && !lairBlocked && segDist(head.x, head.z, log.a.x, log.a.z, log.b.x, log.b.z) < log.rInner) {
    if (!e.tunnel) {
      const da = Math.hypot(log.a.x - s.x, log.a.z - s.z), db = Math.hypot(log.b.x - s.x, log.b.z - s.z);
      const exit = da > db ? log.a : log.b;   // continue toward the mouth farther from the threat
      startTunnel(e, exit === log.a ? log.b : log.a, exit, now, true);
      e.tunnel.stage = 1;
      e.target.copy(exit);
    }
    e.tunnel.hideFrom = now;
    e.tunnel.hideUntil = now + e.rng.range(3, 8);
    e.coverSpot = { type: 'log', idx: 0 };
    return;
  }
  tmpB.set(s.x - head.x, 0, s.z - head.z);
  if (tmpB.length() < e.length && tmpB.normalize().dot(e.heading) > 0.4 && e.trailCount > 8) {
    e.tunnel = null;
    e.nopeUntil = now + 1.1;
    return;
  }
  if (log && !lairBlocked && logFits(e, log)) {
    const da = Math.hypot(log.a.x - head.x, log.a.z - head.z), db = Math.hypot(log.b.x - head.x, log.b.z - head.z);
    if (Math.min(da, db) < e.length * 2.5) {
      const nearA = da < db;
      if (startTunnel(e, nearA ? log.a : log.b, nearA ? log.b : log.a, now)) {
        e.tunnel.wantHide = true;   // hold begins a beat after entering the bore, not at the mouth
        e.coverSpot = { type: 'log', idx: 0 };
      }
    }
  }
}

/* Noping: back down the eel's own path, eyes still on the threat, wave uniform and quick. */
function nopingTick(sys, e, dt) {
  e.reverse = true;
  e.tunnel = null;
  e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 8);
  const f = (F_IDLE + F_K * 0.8) * 1.5;   // reverse gait ramps frequency steeply
  e.wavePhase += Math.PI * 2 * f * dt;
  if (e.wavePhase > WRAP) e.wavePhase -= WRAP;
  e.ampMul += (1 - e.ampMul) * Math.min(1, dt * 6);
  retreatAlongTrail(e, (sys.motion.reduced ? 0.28 : 0.8) * e.length * dt);
  e.uExcite.value += (1 - e.uExcite.value) * Math.min(1, dt * 3);
  e.squash += (1 - e.squash) * Math.min(1, dt * 5);
  e.uSquash.value = e.squash;
}

export function steer(sys, e, dt) {
  const now = sys.time;
  const rng = e.rng;
  const head = e.head;

  if (e.quirkFor !== e.identity) initQuirkState(e);
  // Tick Contract tier 2, above the tunnel and above the nope: a committed air state or its recovery
  // owns the eel outright and handles an interrupting scare itself, submerging before it lets go.
  if (sys.air?.tick(sys, e, dt)) return;
  // Freeze outranks everything a resident can decide for itself; only a slurp (which never reaches
  // steer at all) interrupts it.
  if (now < e.freezeUntil) { claimTick(e, 'scatter', 'freeze'); freezeTick(sys, e, dt); return; }
  // Morgan's filed-away scare comes due: the full reaction, from wherever she has drifted to since.
  if (e.laterAt && now >= e.laterAt) {
    e.laterAt = 0;
    // nope() overwrites coverSpot with a log spot, and only a 'ridge' label releases the habitat claim on
    // drop. The immediate startle path drops cover first too; skipping it here orphans a crest perch for good.
    dropCover(sys, e);
    sys.emit('startle', e);
    const before = e.nopeUntil;
    nope(sys, e, e.laterSpook, now);
    if (e.nopeUntil === before) { e.fleeUntil = now + 1; e.burstUntil = now + 1; }
  }

  if (now < e.nopeUntil) { claimTick(e, 'scatter', 'nope'); nopingTick(sys, e, dt); return; }
  if (e.nopeZig > 0) {
    // Second half of the zig-zag: flick the heading and back up again on the new line.
    e.nopeZig--;
    let zf = e.rng.chance(0.5) ? 0.6 : -0.6;
    if (e.quirks.leftOnly) zf = -0.6;   // she does not have a right flick in her
    const zc = Math.cos(zf), zs = Math.sin(zf);
    e.heading.set(e.heading.x * zc - e.heading.z * zs, 0, e.heading.x * zs + e.heading.z * zc);
    e.nopeUntil = now + 0.5;
    claimTick(e, 'scatter', 'nope');
    nopingTick(sys, e, dt);
    return;
  }
  // B2's dedicated reverse escape, below the nope so a real scare still interrupts it: unlike noping
  // it never clears e.tunnel, which is the whole point of giving it its own state.
  if (sys.braincell?.escapeTick(sys, e, dt)) { claimTick(e, 'escape', 'reverse'); return; }
  if (e.attnReset) {
    // Unstuck by forgetting, not teleporting: drop the claim, the run, and the plan, then re-decide.
    e.attnReset = false;
    if (e.food) { e.food.claims = Math.max(0, e.food.claims - 1); e.food = null; }
    e.tunnel = null;
    e.gaitUntil = 0;
    pickTarget(sys, e, now);
  }
  e.reverse = false;

  const force = tmpA.set(0, 0, 0);
  let speedMul = 1;
  let excite = 0;

  // F3 and F4. Below the reverse escape on purpose: an eel backing out of a bore clears the mouth
  // before the burst. A scatter does interrupt a tunnel run, exactly as today's nope already does.
  const scatter = sys.fear?.scatterTick(sys, e, dt) ?? null;
  if (scatter) {
    claimTick(e, 'scatter', 'scatter');
    speedMul = Math.max(speedMul, scatter.speedMul);
    excite = Math.max(excite, scatter.excite);
  }
  const contest = sys.fear?.contestTick(sys, e, dt) ?? null;
  if (contest) {
    claimTick(e, 'contest', 'contest');
    if (contest.burst) speedMul = Math.max(speedMul, contest.burst);
  }

  // Hiding freezes the run mid-bore; the timer clears and the run resumes on its own.
  const berthed = !!(sys.lairGuest && e.quirks.follows !== sys.lairGuest.name);
  const hiding = !!(e.tunnel && e.tunnel.hideUntil && now > e.tunnel.hideFrom && now < e.tunnel.hideUntil);
  if (e.tunnel && e.tunnel.hideUntil && now >= e.tunnel.hideUntil) e.tunnel.hideUntil = 0;

  // Inside a tunnel run: reach the mouth, then aim straight through to the far mouth, holding axis height.
  let stalled = false;
  if (e.tunnel && !hiding) {
    const t = e.tunnel, from = t.stage;
    const dxz = Math.hypot(e.target.x - head.x, e.target.z - head.z);
    // Progress clock, one per stage: a run that stops closing on its own stage target has stalled, and
    // the retarget gate below frees it. Elapsed rather than wall-clock, so a hide or a scare that
    // freezes the run does not spend the allowance. Stage 1 had no give-up clock at all.
    if (dxz < t.bestD - 0.05) { t.bestD = dxz; t.noProg = 0; } else if (!scatter && !contest) t.noProg += dt;
    if (t.stage === 0 && dxz < 0.5) {
      t.stage = 1; e.target.copy(t.exit);
      if (t.wantHide) { t.wantHide = false; t.hideFrom = now + 0.6; t.hideUntil = now + 0.6 + rng.range(3, 8); }
    }
    else if (t.stage === 1 && dxz < 0.4) { t.stage = 2; e.target.copy(t.runout); }
    else if (t.stage === 2 && dxz < 0.5 && tailClear(e)) { e.tunnel = null; pickTarget(sys, e, now); }
    else stalled = t.noProg > tunnelDial(sys, 'stall');
    if (e.tunnel === t && t.stage !== from) { t.bestD = Infinity; t.noProg = 0; }
    if (e.tunnel) { e.targetY = e.tunnel.entry.y; e.retargetYAt = now + 2; }
  }
  // The claim waits for the stage machine: a run that finished or gave up this tick is a wander now.
  if (e.tunnel) claimTick(e, 'tunnel', hiding ? 'hide' : 'tunnel');
  // The braincell's own target work: the memory sniff hold, the side-eye's gaze, and B7's phantom,
  // which is an ordinary force term. Before the retarget test, so an arrival lands the same tick.
  sys.braincell?.preSteer(sys, e, dt, force);
  // F6's one deliberate reaction. It yields to a scatter, a contest, and a slurp, and the tiers above
  // it own the tick outright, so it can never cancel a run or a recovery.
  const telling = !scatter && !contest && (sys.fear?.tellTick(sys, e, dt, tickHeldAbove(e, 'voluntary')) ?? false);
  if (telling) claimTick(e, 'voluntary', 'overit');
  // Q-A. Below every tier that can own the eel outright, so only an idle hold lets a fidget start.
  // The tier is passed in rather than imported, so eel-quirks.js stays free of a cycle with this file.
  const stimming = !scatter && !contest && !telling
    && (sys.stim?.tick(sys, e, dt, tickHeldAbove(e, 'voluntary')) ?? false);
  if (stimming) claimTick(e, 'voluntary', 'stim');
  // V8's approach is a voluntary trip rather than a committed air state, so it arbitrates down here:
  // anything holding the eel, or a crumb it can already smell, cancels the swim to the reflection.
  let biting = false;
  if (sys.air?.approaching(e)) {
    if (!tickHeldAbove(e, 'voluntary') && !(sys.braincell?.hasSensedFood(e) ?? false)) biting = sys.air.approachTick(sys, e, dt);
    else sys.air.cancelApproach(e);
  }
  if (biting) return;
  const memHold = e.coverSpot?.type === 'memory' && now < (e.coverSpot.holdUntil ?? 0);
  // A quirk holding the target this tick blocks the retarget exactly the way a pad loiter does.
  // Gait-driven state is read one tick late: updateGait runs below, where its rng stream already lives.
  const looping = e.gait === 'loop' && now < e.gaitUntil && !e.tunnel && !e.food;
  const snug = e.snuggle.with && now < e.snuggle.until && e.snuggle.with.gait === 'hold' && !e.snuggle.with.slurpedBy ? e.snuggle.with : null;
  if (!snug) e.snuggle.with = null;
  const quirkTarget = looping || !!e.restPose.kind || now < e.snack.until || !!e.rescueTo || !!e.buttTo || !!snug || !!e.twine || !!scatter || !!contest || telling || stimming || !!sys.crush?.active(e);
  // Under a pad: arrival (an xz test, since the target sits at the surface and the eel does not)
  // starts a loiter near the surface, and the re-pick and depth reroll wait until it ends.
  const padSpot = e.coverSpot?.type === 'pad' ? e.coverSpot : null;
  const padHolding = !!(padSpot && now < padSpot.holdUntil);
  if (padSpot && !e.tunnel && padSpot.holdUntil === 0 && Math.hypot(e.target.x - head.x, e.target.z - head.z) < 0.6) {
    const until = now + rng.range(6, 18);
    padSpot.holdUntil = until;
    e.gait = 'hold'; e.gaitUntil = until;
    e.targetY = Math.max(-0.35, -DEPTH + e.radius * 2.2);
    e.retargetYAt = until; e.retargetAt = until;
    sys.air?.tryPeek(e, 'pad');
  }
  // Reaching the claimed crest is the ridge peek's trigger, rolled once per claim.
  else if (e.coverSpot?.type === 'ridge' && !e.coverSpot.peeked && !e.tunnel && Math.hypot(e.target.x - head.x, e.target.z - head.z) < 0.6) {
    e.coverSpot.peeked = true;
    sys.air?.tryPeek(e, 'ridge');
  }
  // Never abandon a run mid-bore: turning around inside the log drags the body through its wall. Out
  // in the water a run is ordinary again, so a stall or the attention span can end one.
  else if (!padHolding && !memHold && !quirkTarget && !(e.tunnel && headInBore(e))
    && (now > e.retargetAt || stalled || (!e.tunnel && head.distanceTo(e.target) < 0.6))) {
    pickTarget(sys, e, now);
    // A run that gave up here is a wander now, and the claim above must not keep labeling it tunnel-owned.
    if (!e.tunnel) releaseTick(e, 'tunnel');
  }

  if (padHolding) claimTick(e, 'voluntary', 'pad');
  else if (memHold) claimTick(e, 'voluntary', 'memory');

  // Quirk targets, in the order they outrank each other; each parks e.target for this tick only. A
  // scatter or a contest owns the eel outright, so these blocks stand down for it exactly as for a
  // run or a flee: the food block's separate pull is the one documented co-drive.
  const busy = !!e.tunnel || now < e.fleeUntil || !!contest || !!scatter;
  let rescuing = false, butting = false;
  if (poseTick(e, dt, now, !busy)) { claimTick(e, 'social', 'pose'); }
  else if (looping && !busy) {
    claimTick(e, 'social', 'loop');
    e.loopAng += dt * 1.2;
    e.target.set(head.x + Math.cos(e.loopAng) * 0.6 * e.length, 0, head.z + Math.sin(e.loopAng) * 0.6 * e.length);
  }
  if (e.quirks.rescue && !busy) {
    const v = e.rescueTo;
    if (v && (now > e.rescueUntil || v.slurpedBy || now - v.stuckAt >= 8)) e.rescueTo = null;
    if (!e.rescueTo) {
      let pick = null, pd = Infinity;
      for (const o of e.flock) {
        if (o === e || o.slurpedBy || !(now - o.stuckAt < 8)) continue;
        const d = Math.hypot(o.head.x - head.x, o.head.z - head.z);
        if (d < pd) { pd = d; pick = o; }
      }
      if (pick) { e.rescueTo = pick; e.rescueUntil = now + 12; }
    }
    if (e.rescueTo) {
      const o = e.rescueTo;
      rescuing = true;
      claimTick(e, 'social', 'rescue');
      e.target.set(o.head.x, 0, o.head.z);
      if (Math.hypot(o.head.x - head.x, o.head.z - head.z) < 0.35 * e.length) {
        o.attnReset = true;
        o.stuckAt = NOT_STUCK;
        sys.emit('rescue', e, { who: o.name });
        e.rescueTo = null;
      }
    }
  }
  const hb = e.quirks.headbutt;
  if (hb) {
    if (!e.buttAt) e.buttAt = now + rng.range(hb.every[0], hb.every[1]);
    if (e.buttTo && (now > e.buttUntil || e.buttTo.slurpedBy || e.buttTo.tunnel)) e.buttTo = null;
    if (!e.buttTo && !busy && now >= e.buttAt) {
      e.buttTo = pickVictim(e, hb);
      e.buttUntil = now + 12;
      if (!e.buttTo) e.buttAt = now + rng.range(hb.every[0], hb.every[1]);
    }
    if (e.buttTo && !busy) {
      const o = e.buttTo;
      butting = true;
      claimTick(e, 'social', 'headbutt');
      e.target.set(o.head.x, 0, o.head.z);
      speedMul = Math.max(speedMul, 1.2);
      if (Math.hypot(o.head.x - head.x, o.head.z - head.z) < (e.radius + o.radius) * 2 + 0.1) {
        // `except` keeps the shove off the eel who threw it; everyone else takes it as a real scare.
        sys.spook(head.x, head.z, 1.3, { cause: 'headbutt', except: e });
        sys.emit('headbutt', e, { who: o.name });
        e.buttTo = null;
        e.buttBurst = now + 0.5;
        e.buttAt = now + rng.range(hb.every[0], hb.every[1]);
      }
    }
  }
  if (now < e.buttBurst) { speedMul = Math.max(speedMul, 1.6); excite = 1; }
  // Snuggling: curl up along the napper's flank; the approach is the only travel a hold allows.
  let snugFar = false;
  if (snug && !busy) {
    claimTick(e, 'social', 'snuggle');
    const sx = -snug.heading.z, sz = snug.heading.x, off = (e.radius + snug.radius) * 1.3;
    const side = (e.index & 1) ? 1 : -1;
    e.target.set(snug.head.x + sx * side * off - snug.heading.x * e.length * 0.3, 0, snug.head.z + sz * side * off - snug.heading.z * e.length * 0.3);
    snugFar = Math.hypot(e.target.x - head.x, e.target.z - head.z) > off + 0.25;
  }
  if (now < e.burstUntil) speedMul = Math.max(speedMul, 2);
  // Bee's table stays set after the crumbs are gone: she circles the spot she last ate at.
  if (now < e.snack.until) {
    if (e.food) e.snack.until = 0;
    else if (!busy) {
      claimTick(e, 'social', 'snack');
      e.snack.ang += (e.prowlBL * e.length / Math.max(0.3, e.snack.r)) * dt;
      e.target.set(e.snack.x + Math.cos(e.snack.ang) * e.snack.r, 0, e.snack.z + Math.sin(e.snack.ang) * e.snack.r);
    }
  }
  // The crush gag (eel-crush.js) parks its lane point here: social tier, a target write and nothing
  // else, so the turn-rate clamp is what makes the follower miss Jaz's corners.
  if (!busy) { const m = sys.crush?.pickTarget(sys, e, now) ?? 0; if (m > 0) speedMul = Math.max(speedMul, m); }

  tmpB.subVectors(e.target, head); tmpB.y = 0;
  // A hold that has reached its spot stops pulling and (below) stops creeping: at creep speed the turn
  // radius is a hair, so a target under the snout spins the head in place and winds the body into a ball.
  const settled = e.gait === 'hold' && now < e.gaitUntil && !e.food && !busy && !memHold
    && (snug ? !snugFar : !quirkTarget && tmpB.length() < 0.6);
  tmpB.normalize();
  force.addScaledVector(tmpB, hiding || settled ? 0 : e.tunnel ? 1.4 : 0.6);

  // Spooks: strong, short-lived push away, with a speed burst.
  const startle = e.census.startle;
  for (const s of sys.spooks) {
    if (s.except === e) continue;   // her own headbutt does not startle her
    if (s.only && s.only !== e) continue;   // a refuge lunge is aimed at one visitor and invisible to everyone else
    const age = now - s.t;
    if (age > 1.6) continue;
    const dx = head.x - s.x, dz = head.z - s.z;
    const d = Math.hypot(dx, dz);
    if (d > 3.5) continue;
    sys.fear?.noteSpook(e, s);
    if (sys.fear?.ignoreSpook(e, s)) continue;
    let k = (1 - age / 1.6) * s.strength * (1 - d / 3.5);
    // Literally anything wakes a napper: a poke that reaches the eel at all ends the hold.
    if (k > 0.1 && e.gait === 'hold' && now < e.gaitUntil) { e.gaitUntil = now; e.restPose.kind = ''; e.snuggle.with = null; }
    // Investigators and the ripple-chaser read a modest splash as an invitation; real scares still land.
    if ((e.quirks.rippleChase || startle === 'investigate') && k * e.traits.spookMul < 0.55) {
      force.x -= (dx / (d + 0.05)) * k * 3;
      force.z -= (dz / (d + 0.05)) * k * 3;
      excite = Math.max(excite, k * 0.5);
      continue;
    }
    k *= e.traits.spookMul * (startle === 'flip' ? 1.3 : 1);
    // Filed away, not felt: she swims on as if nothing happened and pays for it in a few seconds.
    if (startle === 'later' && k > 0.5) {
      if (!e.laterAt) { e.laterAt = now + rng.range(3, 5); e.laterSpook.x = s.x; e.laterSpook.z = s.z; }
      continue;
    }
    force.x += (dx / (d + 0.05)) * k * 6;
    force.z += (dz / (d + 0.05)) * k * 6;
    speedMul = Math.max(speedMul, 1 + 1.4 * k);
    excite = Math.max(excite, k);
    if (k > 0.5 && now > e.fleeUntil) {
      claimTick(e, 'scatter', 'startle');
      e.fleeUntil = now + 1;
      dropCover(sys, e);
      e.snack.until = 0;
      // A scare ends a rest bout outright, which is what pulls the pose down with it.
      if (e.gait === 'hold') { e.gaitUntil = Math.min(e.gaitUntil, now); e.restPose.kind = ''; e.snuggle.with = null; }
      if (startle === 'freeze') {
        e.freezeUntil = now + rng.range(1.5, 3);
        sys.emit('startle', e);
        freezeTick(sys, e, dt);
        return;
      }
      sys.emit('startle', e);
      const before = e.nopeUntil;
      nope(sys, e, s, now);
      if (startle === 'flip' && e.nopeUntil !== before) e.nopeUntil += 0.5;
      if (now < e.nopeUntil) { claimTick(e, 'scatter', 'nope'); nopingTick(sys, e, dt); return; }
    }
  }

  // Lures: drag trails older than a second pull gently, eels nose in to look.
  for (const l of sys.lures) {
    const age = now - l.t;
    if (age < 1.0 || age > 9) continue;
    const dx = l.x - head.x, dz = l.z - head.z;
    const d = Math.hypot(dx, dz);
    if (d > 6 || d < 0.4) continue;
    const k = 0.35 * (1 - age / 9) * e.traits.curious * (sys.fear?.lureMul(e) ?? 1);
    if (k <= 0) continue;
    force.x += (dx / d) * k; force.z += (dz / d) * k;
    if (d < 2 && e.gait === 'hold') { e.gaitUntil = Math.min(e.gaitUntil, now); e.snuggle.with = null; }   // a finger nearby wakes a napper
  }
  sys.fear?.forceTick(sys, e, force, dt);

  // Matthew's whole heart, geometrically: the beloved is whoever is closest, re-surveyed on a slow
  // clock, and the moment someone nearer drifts by it transfers instantly and without ceremony.
  if (e.quirks.shipsNearest && now >= e.shipAt) {
    e.shipAt = now + 2;
    let pick = null, pd = Infinity;
    for (const o of e.flock) {
      if (o === e || o.slurpedBy) continue;
      const d = Math.hypot(o.head.x - head.x, o.head.z - head.z);
      if (d < pd) { pd = d; pick = o; }
    }
    e.partner = pick;
  }
  // Bonded following: drift toward the partner when the gap opens; never overrides a run or a meal.
  if (e.partner && !e.tunnel && !e.food && !sys.crush?.snubbed(e, now)) {
    const dx = e.partner.head.x - head.x, dz = e.partner.head.z - head.z;
    const d = Math.hypot(dx, dz);
    if (d > e.length * 1.2 && d < 8) {
      const w = e.quirks.followWeight ?? 0.3;
      force.x += (dx / d) * w; force.z += (dz / d) * w;
    }
  }

  // Twining. The leader starts it: fond eels swimming alongside get pulled into a braid for a while.
  if (!e.twine && twineFree(sys, e, now) && rng.chance(TWINE_CHANCE * dt)) {
    let members = null;
    for (const o of e.flock) {
      if (o === e || !twineFree(sys, o, now) || affection(e, o, now) < 0.6) continue;
      const d = Math.hypot(o.head.x - head.x, o.head.z - head.z);
      if (d > TWINE_REACH * e.length || o.heading.dot(e.heading) < 0.3) continue;
      (members ??= [e]).push(o);
      if (members.length === 3) break;
    }
    if (members) {
      const g = { members, guide: new THREE.Vector3(head.x, 0, head.z), goal: e.target.clone(), dir: e.heading.clone(), t0: now, until: now + rng.range(TWINE_LEN[0], TWINE_LEN[1]) };
      for (let i = 0; i < members.length; i++) { members[i].twine = g; members[i].twinePhase = (i / members.length) * Math.PI * 2; }
    }
  }
  if (e.twine) {
    const g = e.twine, lead = g.members[0];
    const alive = now < g.until && g.members.every((m) => !m.slurpedBy && !m.tunnel && !m.food && now > m.fleeUntil);
    if (!alive) endTwine(g);
    else {
      // The leader advances the guide once per tick (it steers first) toward the goal the braid took from
      // its wander target; the leader's own target is the helix now, so the goal has to live on the group.
      if (e === lead) {
        tmpB.set(g.goal.x - g.guide.x, 0, g.goal.z - g.guide.z);
        if (tmpB.lengthSq() < 0.36) { pickTarget(sys, lead, now); g.goal.copy(lead.target); tmpB.set(g.goal.x - g.guide.x, 0, g.goal.z - g.guide.z); }
        tmpB.normalize();
        g.dir.lerp(tmpB, Math.min(1, dt * 1.5)).normalize();
        g.guide.addScaledVector(g.dir, lead.prowlBL * lead.length * 0.9 * dt);
      }
      // The braid keeps its clock through a scatter or a contest, but stops steering: whoever owns the
      // tick is the only thing writing this eel's target.
      if (!busy) {
        claimTick(e, 'social', 'twine');
        const th = TWINE_OMEGA * (now - g.t0) + e.twinePhase;
        const lx = -g.dir.z, lz = g.dir.x;
        e.target.set(g.guide.x + g.dir.x * 0.5 + lx * Math.sin(th) * TWINE_R, 0, g.guide.z + g.dir.z * 0.5 + lz * Math.sin(th) * TWINE_R);
        e.targetY = Math.max(-DEPTH + e.radius * 2.2, Math.min(-e.radius * 1.6, -DEPTH * 0.5 + Math.cos(th) * TWINE_RY));
        e.retargetYAt = now + 1;
      }
    }
  }

  // Food: pick the least-crowded nearby crumb; spreading out is the whole point.
  const hunt = e.census.hunt;
  const hadFood = e.food;
  let stalking = false;
  e.foodDist = Infinity;
  // B3: what this eel can actually smell right now, built for the whole pond back in the prepass.
  const smelled = e.sensedFoods ?? sys.foods;
  // A contest outranks a meal, so nothing below acquires, bites, spins, or drops cover under one; the
  // crumb keeps its claim and resumes after. A bore run is out of this test: it is how a hunt gets in.
  const mealBlocked = !!contest;
  if (e.quirks.herbivore) {
    // Crumbs are off the herbivore's menu entirely, claims included; a gourmet grazes and hunts both.
    if (e.food) { e.food.claims = Math.max(0, e.food.claims - 1); e.food = null; }
  } else if (smelled.length && !scatter && !mealBlocked && (sys.braincell?.mayHunt(e) ?? true)) {
    const log = sys.colliders.logs[0];
    const fits = log ? logFits(e, log) : false;
    // Doordash: dinner is whatever drifts into her face. Anything farther out does not exist.
    const reach = hunt === 'doordash' ? e.length : Infinity;
    // Gourmet: a scoring pass sometimes forgets which crumb the eel was sampling, so it keeps sampling.
    // Only three eels carry the quirk, so the live-crumb count runs inside that branch; both gates still apply.
    let skipPersist = false;
    if (e.quirks.gourmet && now > e.gourmetAt) {
      let live = 0;
      for (const f of smelled) if (f.amount > 0) live++;
      if (live >= 2) { e.gourmetAt = now + rng.range(2, 4); skipPersist = true; }
    }
    let best = null, bestScore = Infinity;
    for (const f of smelled) {
      if (f.amount <= 0) continue;
      // Bore food is invisible to an eel that cannot fit through the mouth, or dares not enter.
      if ((!fits || berthed) && log && segDist(f.x, f.z, log.a.x, log.a.z, log.b.x, log.b.z) < log.rInner) continue;
      const d = Math.hypot(f.x - head.x, f.z - head.z);
      // Doordash is about what lands in front of her; a crumb still falling or parked on a pad is fair
      // to anticipate from anywhere.
      if (d > reach && !f.airborne && !f.onPad) continue;
      const score = d + f.claims * 2.2 * (1 + e.traits.yield * 2) - (e.food === f && !skipPersist ? e.traits.persistence : 0);
      if (score < bestScore) { bestScore = score; best = f; }
    }
    if (e.food && e.food !== best) e.food.claims = Math.max(0, e.food.claims - 1);
    // A second claimant marks the crumb for good: the gratitude roll counts meals nobody argued over.
    // claims is live occupancy and falls back to zero, so the first claimant is stamped instead.
    if (best && e.food !== best) {
      best.claims++;
      // An identity, not a body: a hot-swap reuses the eel object, so the name and its swap generation
      // are what tell the newcomer's claim apart from the one the eel who left made.
      const by = best.claimedBy;
      if (by && (by.name !== e.name || by.gen !== e.gen)) best.contested = true;
      else if (!by) best.claimedBy = { name: e.name, gen: e.gen };
    }
    e.food = best;
    if (best) dropCover(sys, e);
    if (best) {
      claimTick(e, 'meal', 'meal');
      const dx = best.x - head.x, dz = best.z - head.z;
      const d = Math.hypot(dx, dz);
      let hunger = hunt === 'doordash' ? 1 : e.traits.hunger;
      let biteMul = 1;
      // Marxism at the crumb: he shows up for whoever is already eating, and takes almost nothing.
      if (e.quirks.dinnerCircle) {
        for (const f of smelled) {
          if (f.amount > 0 && f.claims - (f === best ? 1 : 0) >= 1) { hunger = 1; biteMul = 0.25; break; }
        }
      }
      // Bonk: stalk in, then a committed lunge aimed just wide, and the miss reads as a bump.
      let bonking = false;
      if (hunt === 'bonk') {
        if (e.bonkFood !== best) { e.bonkFood = best; e.stalkUntil = now + rng.range(2, 4); e.bonkUntil = 0; }
        else if (now >= e.stalkUntil && e.bonkUntil === 0) {
          e.bonkUntil = now + 1;
          // Q-B: a hard thing beside the crumb is a better miss than a random one, when there is one.
          const aim = sys.stim?.bonkAim(sys, e, best) ?? null;
          e.bonkAng = aim ?? rng.range(15, 25) * (Math.PI / 180) * (rng.chance(0.5) ? 1 : -1);
        }
        bonking = now < e.bonkUntil;
        if (bonking && d < 0.5 && d >= 0.35) {
          e.nopeUntil = now + 0.4;
          e.bonkUntil = 0;
          e.stalkUntil = now + rng.range(2, 4);
          bonking = false;
        } else if (!bonking && e.bonkUntil !== 0 && now >= e.bonkUntil) { e.bonkUntil = 0; e.stalkUntil = now + rng.range(2, 4); }
      }
      stalking = (hunt === 'stalk' || (hunt === 'bonk' && !bonking)) && d >= e.length;
      // Food inside the log is reached through a mouth, not the wall: run the tunnel and let the
      // bore do the steering until the head is actually inside.
      let pull = 4.0 * hunger;
      if (log && segDist(best.x, best.z, log.a.x, log.a.z, log.b.x, log.b.z) < log.rOuter) {
        if (!e.tunnel && fits && !berthed && now - (e.boreRefusedAt ?? 0) > 3) {
          const nearA = Math.hypot(log.a.x - head.x, log.a.z - head.z) < Math.hypot(log.b.x - head.x, log.b.z - head.z);
          startTunnel(e, nearA ? log.a : log.b, nearA ? log.b : log.a, now);
        }
        if (segDist(head.x, head.z, log.a.x, log.a.z, log.b.x, log.b.z) > log.rInner) pull = 0;
      }
      // Dinner-circle approach: each eel aims at its own side of the crumb until it is close enough to bite.
      const ringA = e.index * (Math.PI / 3);
      // Straight at the crumb from afar; the seat only matters in the last stretch, so nobody curves in.
      const ringR = d < 0.6 ? Math.min(0.2, d * 0.3) : 0;
      let ax = best.x + Math.cos(ringA) * ringR - head.x, az = best.z + Math.sin(ringA) * ringR - head.z;
      // B3's approach error: far and dumb wanders wide, close and smart homes in. Frozen at zero the
      // moment a hunt commits, so seats and bonk angles stay exactly what they are today.
      const committed = bonking || (hunt === 'lunge' && d < e.length * 3) || (hunt === 'stalk' && d < e.length) || d < 0.6;
      const eps = sys.braincell?.approachError(e, committed, d, best) ?? 0;
      if (eps) {
        const ec = Math.cos(eps), es = Math.sin(eps);
        const rx = ax * ec - az * es, rz = ax * es + az * ec;
        ax = rx; az = rz;
      }
      if (bonking) {
        const bc = Math.cos(e.bonkAng), bs = Math.sin(e.bonkAng);
        const rx = ax * bc - az * bs, rz = ax * bs + az * bc;
        ax = rx; az = rz;
      }
      // Inside bite range the pull lets go: a target under the snout at brake speed winds the body into a ball.
      const over = d < 0.35 ? 0 : 1;
      force.x += (ax / (d + 0.01)) * pull * over; force.z += (az / (d + 0.01)) * pull * over;
      // Brake on approach: a full-speed turning circle is wider than the crumb, which reads as orbiting.
      if (!stalking) speedMul = Math.max(speedMul, 1 + 0.5 * hunger * Math.min(1, d / 1.5));
      if (bonking || (hunt === 'lunge' && d < e.length * 3)) speedMul = Math.max(speedMul, 1.6);
      // Dive or rise to the crumb itself; each seat sits a little over or under it, so a dinner circle knots.
      e.targetY = Math.max(-DEPTH + e.radius * 2.2, Math.min(-e.radius * 1.6, best.y + e.radius * 1.2 + 0.12 * Math.sin(ringA * 2)));
      e.retargetYAt = now + 0.5;
      e.foodDist = d;
      // No bite on a crumb that is still in the air or resting on a pad: it is smelled, not eaten, yet.
      if (d < 0.35 && !best.airborne && !best.onPad) {
        // Q-C: a whole treat is worth spinning for, and a spinning eel tears at twice the rate.
        if (best.size === 1) sys.stim?.trySpin(sys, e, best);
        const bite = Math.min(best.amount, dt * 0.6 * biteMul * (sys.stim?.biteMul(e, best) ?? 1));
        best.amount -= bite;
        growEel(e, bite * (best.growPerAmt || 0));
        excite = Math.max(excite, 0.5);
        if (now > (e.bubSoundAt ?? 0)) { e.bubSoundAt = now + rng.range(0.5, 1.1); sys.emit('nibble', e); }
        if (best.amount <= 0) { sys.emit('eat', e, best); }
      }
    }
  } else if (e.food && !mealBlocked) { e.food.claims = Math.max(0, e.food.claims - 1); e.food = null; }
  // B5's give-up clock, before the other meal modules so a crumb it has quit on stops blocking them.
  sys.braincell?.tick(sys, e, dt);
  // Grazing is another builder's module and may not be wired yet; everything here works without it.
  if (e.quirks.graze && sys.graze && !mealBlocked) { sys.graze.tick(sys, e, dt); if (e.coverSpot?.type === 'graze') claimTick(e, 'meal', 'graze'); }
  if (e.quirks.tea && sys.tea && !mealBlocked) { sys.tea.tick(sys, e, dt); if (e.coverSpot?.type === 'tea') claimTick(e, 'meal', 'tea'); }
  // F6's tell had already written its pose when a meal or a graze claimed above it; the higher owner
  // takes those slots back rather than wearing the tell's speed for the rest of the reaction.
  if (telling && tickHeldAbove(e, 'voluntary')) { e.pose.speed = null; e.pose.squash = null; }
  // The table clears and Bee keeps circling it for a while. Only an emptied crumb sets the table:
  // giving up on an unreachable one also clears e.food, and orbiting that for 20 s is a sulk, not a party.
  if (e.census.party === 'snacks' && hadFood && !e.food && hadFood.amount <= 0) {
    e.snack.x = hadFood.x; e.snack.z = hadFood.z;
    e.snack.r = rng.range(1, 2) * e.length;
    e.snack.ang = rng.range(0, Math.PI * 2);
    e.snack.until = now + rng.range(10, 20);
  }

  // Vortex: swirl around the center with a slight inward pull, so they spiral.
  for (const v of sys.vortices) {
    const age = now - v.t;
    if (age > 7) continue;
    const dx = head.x - v.x, dz = head.z - v.z;
    const d = Math.hypot(dx, dz);
    if (d > v.radius * 2.2) continue;
    const k = (1 - age / 7) * 3.0;
    const inward = d > v.radius * 0.5 ? 0.8 : -0.4;
    force.x += (-dz / (d + 0.1)) * k - (dx / (d + 0.1)) * inward * k * 0.4;
    force.z += (dx / (d + 0.1)) * k - (dz / (d + 0.1)) * inward * k * 0.4;
    speedMul = Math.max(speedMul, 1.6);
    excite = Math.max(excite, 0.6);
  }

  // Bee's matchmaking: two eels she is hovering between get talked into each other's space.
  if (e.quirks.matchmaker) {
    const near = e.length * 2, near2 = near * near;
    for (let i = 0; i < e.flock.length; i++) {
      const a = e.flock[i];
      if (a === e || a.slurpedBy || !a.cuddle) continue;
      const ax2 = a.head.x - head.x, az2 = a.head.z - head.z;
      if (ax2 * ax2 + az2 * az2 > near2) continue;
      for (let j = i + 1; j < e.flock.length; j++) {
        const b = e.flock[j];
        if (b === e || b.slurpedBy || !b.cuddle) continue;
        const bx = b.head.x - head.x, bz = b.head.z - head.z;
        if (bx * bx + bz * bz > near2) continue;
        if (now >= a.cuddle.until) { a.cuddle.with = b; a.cuddle.until = now + 30; }
        if (now >= b.cuddle.until) { b.cuddle.with = a; b.cuddle.until = now + 30; }
      }
    }
  }

  // Idle spacing: resting eels spread out instead of dogpiling; bonded partners may cuddle.
  // Guests (Eleanor) count too, and her sheer length buys her a wide berth from the same math.
  let crowd = 0;
  if (!e.tunnel) {
    const sep = (o) => {
      if (o === e || o === e.partner || o.slurpedBy) return;
      const dx = head.x - o.head.x, dz = head.z - o.head.z;
      const d = Math.hypot(dx, dz);
      let want = (e.length + o.length) * 0.25;
      if (e.quirks.cuddly) want *= 0.5;   // cuddly eels treat everyone like a friend, so the comfort zone shrinks
      if (o === e.cuddle.with && now < e.cuddle.until) want *= 0.35;
      if (e.twine && o.twine === e.twine) want *= 0.25;   // braiding bodies are meant to touch
      if (d < want && d > 1e-4) {
        // Floor keeps a little personal space even mid-scramble, so feeding is a circle, not a pile.
        const calmness = Math.max(0.25, 1 - Math.min(1, e.speedBL / e.cruiseBL));
        const k = (1 - d / want) * 1.2 * calmness * (e.quirks.dominant ? 0.2 : 1);
        force.x += (dx / d) * k; force.z += (dz / d) * k;
        crowd = Math.max(crowd, k);
      }
    };
    for (const o of sys.eels) sep(o);
    for (const o of sys.guests) sep(o);
  }

  // Rocks and the log wall no longer shove: B2's danger ring routes around them, and the old
  // repulsion vector survives only inside eel-brain.js as the boxed-in fallback heading.

  // Stay near the view: past ~70% of a viewport beyond the edge, turn back.
  const limX = sys.view.w * 0.7, limZ = sys.view.h * 0.7;
  if (Math.abs(head.x) > limX) force.x -= Math.sign(head.x) * 3;
  if (Math.abs(head.z) > limZ) force.z -= Math.sign(head.z) * 3;

  // Andy in a shower: the whole film is ticking, so he fidgets. Omnidirectional and capped at +0.3;
  // direction comes from the wander target above, never from the drops themselves.
  const rainEnv = sys.rain?.envelope ?? 0;
  if (e.quirks.rippleChase && rainEnv > 0) {
    const restless = 0.3 * rainEnv;
    speedMul = Math.max(speedMul, 1 + restless);
    excite = Math.max(excite, restless * 0.6);
  }

  if (sys.motion.reduced) speedMul = Math.min(speedMul, 1) * 0.35;

  // Deep rest reads last tick's bout, same one-tick lag as the pose and loop states above.
  const deepHold = e.gait === 'hold' && now < e.gaitUntil && e.gaitUntil - e.gaitFrom > 5;
  // A long sip parks him in a hold too, but tea is drunk at the surface, never half-buried.
  const asleep = deepHold && e.census.twoAM === 'asleep' && !e.tunnel && !e.food && !e.restPose.kind && e.coverSpot?.type !== 'tea';
  solveHeading(sys, e, force, dt, asleep);
  e.speedMul += (speedMul - e.speedMul) * Math.min(1, dt * 4);
  // The crush's fluster rides on top of whatever this tick decided: a lift, never a level.
  excite = Math.min(1, excite + (sys.crush?.exciteLift(e) ?? 0));
  e.uExcite.value += (excite - e.uExcite.value) * Math.min(1, dt * 3);

  // A crush member is committed to moving: the cadence roll waits until the bout lets go, or a
  // random hold would sit them down mid-chase and read as giving up for no reason.
  if (!sys.crush?.active(e)) updateGait(sys, e, now, (1 + 0.35 * rainEnv) * (sys.air?.travelMul(e) ?? 1));
  // A long hold bout is where the coil and the sickle start, one per bout.
  if (e.gait === 'hold' && e.gaitUntil - e.gaitFrom > 5 && e.poseBout !== e.gaitFrom) {
    e.poseBout = e.gaitFrom;
    if (e.quirks.spiralSleep) startPose(e, 'coil', now);
    else if (e.quirks.sickleRest) startPose(e, 'sickle', now);
  }
  const gait = hiding ? 'hold'
    : e.tunnel ? 'cruise'
    : (rescuing || butting) ? 'cruise'
    : e.food ? ((stalking || e.foodDist < e.length) ? 'prowl' : 'cruise')
    : (padSpot && now < padSpot.holdUntil) ? 'hold'
    : (snug && snugFar) ? 'prowl'
    : e.twine ? 'prowl'
    : e.gait;

  // Depth wandering: bottom-hugging by default; only a cruise ranges the whole column.
  if (now > e.retargetYAt) {
    // Floor over chair: Morgan never takes the upper bands, cruising or not.
    const lo = -DEPTH + e.radius * 2.2;
    let top = e.quirks.floor ? -DEPTH * 0.85 : gait === 'cruise' ? -e.radius * 1.6 : -DEPTH * 0.3;
    // A bright moon pushes the band deeper; the module clamps it off the floor bound for us.
    top = sys.air?.depthBand(e, lo, top) ?? top;
    e.targetY = rng.range(lo, top);
    e.retargetYAt = now + rng.range(2.5, 7);
  }
  if (asleep) {
    e.targetY = -DEPTH + e.radius * 1.1;
    e.retargetYAt = now + 1;
    // Open sand and a deep hold is a burrow, not a lie-down. The module checks the site and holds
    // itself to one dig per bout, so this can be asked on every tick of the hold.
    sys.air?.tryBurrow(e);
  }

  // Stimuli raise the speed floor rather than multiply it, so a spooked resting eel still bolts.
  let gaitBL = gait === 'hold' ? (settled ? 0 : 0.05) : (gait === 'prowl' || gait === 'loop') ? e.prowlBL : e.cruiseBL;
  // Threading a gap is slower work, in proportion to how far the maps had to bend the heading. Only
  // the voluntary rate: the spook, scatter, and burst floors below are instinct and are never braked.
  if (sys.braincell) gaitBL *= sys.braincell.brakeFor(e);
  if (sys.braincell?.boxed(e)) gaitBL = Math.min(gaitBL, e.prowlBL * 0.5);
  if (e.restPose.kind) gaitBL = Math.max(gaitBL, e.prowlBL);   // the shape only draws if she keeps moving
  if (crowd > 0.3 && gait === 'hold') gaitBL = Math.max(gaitBL, e.prowlBL * 0.6);   // shuffle out of a pile
  if (crowd > 0.6 && e.gait === 'hold' && !snug) { e.gaitUntil = Math.min(e.gaitUntil, now); }   // a real shove wakes a napper
  const stim = Math.max(0, e.speedMul - 1);
  // Q-D on the voluntary rate only, before the clamp: a food-drunk eel is slower, never a slower eel.
  const drunk = foodDrunk(e);
  const wantBL = Math.min(gaitBL + stim * e.cruiseBL, e.cruiseBL * 1.5) * (sys.motion.reduced ? 0.35 : 1) * (drunk ? FOOD_DRUNK.want : 1);
  // Voluntary accel ~1.3 L/s²; stopping is quicker (eels do not coast), startle quicker still.
  const rate = wantBL > e.speedBL ? (stim > 0.5 ? 6 : 1.3) : 2.5;
  e.speedBL += Math.max(-rate * dt, Math.min(rate * dt, wantBL - e.speedBL));
  // The squash half of Q-D is a default with the lowest priority there is: a real pose override wins.
  const squashTo = 1 + (e.speedMul - 1) * 0.18;
  e.squash += ((drunk ? Math.max(squashTo, FOOD_DRUNK.squash) : squashTo) - e.squash) * Math.min(1, dt * 5);

  const f = paceWave(e, dt, gait === 'hold');
  // Whatever did not claim the tick was a wander, which is the honest label for the default.
  if (!e.tick.tier) claimTick(e, 'wander', 'wander');
  commitPose(e);
  const speed = e.speedBL * e.length;

  const side = tmpC.set(-e.heading.z, 0, e.heading.x);
  head.addScaledVector(e.heading, speed * dt);
  // Snout yaw as the derivative of its lateral sine, so the head stays in phase with the body wave.
  head.addScaledVector(side, Math.cos(e.wavePhase) * e.ampTail * 0.2 * e.anterior * Math.PI * 2 * f * dt);
  // A slow bob while moving, so a straight cruise still rises and dips a little through the column.
  const bob = gait === 'hold' ? 0 : 0.07 * (drunk ? FOOD_DRUNK.bob : 1) * Math.sin(now * 0.6 + e.index * 1.3);
  head.y += (e.targetY + bob - head.y) * Math.min(1, dt * 1.5);

  // Sickle rest colors him: skin to yellow, glow to red. Anyone whose tints are off white eases back,
  // so a hot-swap out of Marc cleans up on its own without swapIdentity knowing these exist.
  const sickling = !!e.quirks.sickleRest && e.restPose.kind === 'sickle';
  const skinT = e.uSkinTint.value, glowT = e.uGlowTint.value;
  // Only the sickle colors ever pull blue and green down, so those two channels are the whole test.
  if (sickling || skinT.b < 0.999 || glowT.g < 0.999) {
    const a = Math.min(1, dt * 1.5);
    skinT.lerp(sickling ? SICKLE_SKIN : WHITE, a);
    glowT.lerp(sickling ? SICKLE_GLOW : WHITE, a);
    if (!sickling && skinT.b > 0.996 && glowT.g > 0.996) { skinT.copy(WHITE); glowT.copy(WHITE); }
  }

  // Chandler hums while she rests. The clock runs whatever she is doing and the song waits for her to
  // settle: her hold bouts are shorter than the interval, so a per-bout timer would never come due.
  const sings = e.quirks.sings;
  if (sings) {
    if (!e.singAt) e.singAt = now + rng.range(sings[0], sings[1]);
    else if (now >= e.singAt) {
      if (gait !== 'hold') e.singAt = now + 0.5;
      else { e.singAt = now + rng.range(sings[0], sings[1]); sys.emit('sing', e, { notes: rng.int(3, 6) }); }
    }
  }

  // Surface wake when swimming shallow.
  if (head.y > -0.15 && now > e.rippleAt && !sys.motion.reduced) {
    e.rippleAt = now + 0.3;
    sys.sim.addDrop(head.x, head.z, 0.45 + e.radius, 0.008 * speed);
  }

  // Stuck check: commanded speed but no progress → two zig-zag nopes, then fresh interests.
  const cmd = e.speedBL * e.length;
  if (e.lastX !== undefined && cmd > 0.35) {
    const moved = Math.hypot(head.x - e.lastX, head.z - e.lastZ);
    if (moved < cmd * dt * 0.3) e.stuckFor += dt; else e.stuckFor = Math.max(0, e.stuckFor - dt * 2);
    // A left-only eel circles on purpose, so she gets twice the rope before the pond calls it stuck.
    if (e.stuckFor > (e.quirks.leftOnly ? 3 : 1.5) && e.trailCount > 8) {
      e.stuckFor = 0;
      e.stuckAt = now;   // Morgan's rescue window opens here
      sys.braincell?.blocked(e);   // B5 counts a blocked episode as four seconds of give-up clock
      // A second block against the same log inside 20 s climbs it, however few braincells are on
      // duty. It takes the whole episode: no zig-zag, and nothing left armed for the reverse escape.
      const stuckLog = sys.air && sys.colliders.logs.find((l) => l.rInner > 0
        && segDist(head.x, head.z, l.a.x, l.a.z, l.b.x, l.b.z) < l.rOuter + e.length * 0.6);
      if (!(stuckLog && sys.air.stuckFlop(e, stuckLog))) {
        e.nopeZig = 1;
        e.attnReset = true;
        e.tunnel = null;
        e.nopeUntil = now + 0.7;
      }
    }
  }
  e.lastX = head.x; e.lastZ = head.z;
  // Both roll for the tick after this one, so nothing already running is disturbed by them.
  sys.air?.tryLeap(e, dt);
  sys.air?.tryMoonBite(e, dt);
}
