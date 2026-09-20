import { DEPTH } from './config.js';
import { Eel } from './eels.js';
import { IDENTITIES, applyIdentity } from './eel-identity.js';
import { paceWave } from './eel-behavior.js';
import { growEel } from './eel-physics.js';
import {
  SLURP_AT, begin, capture, deriveLair, exitTarget, moveGuest, nopeTick, onStage, park, parkOffstage,
  pickExit, progressStrike, rescueLadder, resetGuest, resetProgress, setExit, setVisible,
  spit, startle, teleport,
} from './guest-stage.js';
import { brain as samBrain, enterSam, initSam } from './sam-eel.js';

/* The guest slot: one shared body, one of two identities rolled at each park. Eleanor is the original:
   log lair, feed-spree visits, hunts anyone near her size, and a stand-down when the pond runs hot,
   because she is the pond's biggest cost and knows it. Sam the Space Eel shares her slot, none of her
   menace; guest-stage.js runs the shared stage, sam-eel.js his half. */

const FEED_WORTH = 4;   // recent feed-spree total that makes the trip worthwhile
const VISIT_CAP = 30;   // seconds before she loses interest in an outing
const ZOOM_EVERY = 0.7; // seconds between evasive re-aims for a zoomies prey
const ZOOM_JITTER = 40 * Math.PI / 180;
const SLIP = 0.5;         // rock and log pushes on a guest snout, halved: far too strong to be held by bark
const COMMOTION_NEAR = 4; // she picks out individual crumbs only once she is this close to the table
// F2's published threat, by state. Anything that frightens residents publishes one of these.
const THREAT = { lair: 0.15, depart: 0.3, return: 0.3, hunt: 1, slurp: 1, graze: 0.7, swimby: 0.5, wriggle: 0, offstage: 0 };

/* The guest table: which controller drives the body, how it takes a lair at boot, and what it needs
   initialized on top of the shared reset. Everything identity-specific about the swap is a row here. */
const GUESTS = {
  Eleanor: { brain, init: initEleanor, enter: enterEleanor },
  Sam: { brain: samBrain, init: initSam, enter: enterSam },
};

const guestId = (name) => IDENTITIES.find((i) => i.name === name);

function samOdds(sys) {
  const v = sys.knobs.guest?.samOdds;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}

/* The roll: one draw from the guest's own rng, so ?seed pins who visits when. ?guest= freezes it the
   way ?cast= freezes the resident rotation. */
function rollGuest(sys, e) {
  const pin = String(sys.guestPin ?? '').trim().toLowerCase();
  if (pin === 'sam') return guestId('Sam');
  if (pin === 'eleanor') return guestId('Eleanor');
  return e.rng.chance(samOdds(sys)) ? guestId('Sam') : guestId('Eleanor');
}

export function attachGuest(sys, seed, opts = null) {
  sys.guestPin = opts?.guest ?? null;
  // Born Eleanor whatever the roll says: the swap below is the only path that dresses the body, so
  // there is exactly one place that can get it wrong.
  const e = new Eel(6, seed, sys.extent, sys.colliders, sys.view, guestId('Eleanor'));
  // A refused swap would leave the body with no controller at all, and eels.js falls back to steer(),
  // which no guest survives; Eleanor is the floor.
  if (!applyGuestIdentity(sys, e, rollGuest(sys, e))) applyGuestIdentity(sys, e, guestId('Eleanor'));
  sys.renderer.buildMesh(e);
  sys.renderer.applyAppearance(e);
  if (!GUESTS[e.name].enter(sys, e, sys.time)) { park(sys, e); e.state = 'offstage'; }
  setVisible(sys, e, e.state === 'lair');
  sys.guests.push(e);
  // Every later park rolls the next visit's identity, from inside the park itself.
  e.onPark = (s, g) => applyGuestIdentity(s, g, rollGuest(s, g));
  bindFollowers(sys, e);
  return e;
}

/* The whole swap, in the order the shared body needs it: unbind, reset, rebuild, re-init, redress.
   It runs only while fully offstage, which is exactly where park() calls it from. */
export function applyGuestIdentity(sys, e, id) {
  if (!id || !GUESTS[id.name]) return false;
  if (e.body && onStage(sys, e)) {
    if (sys.debug) console.warn(`[guest] refused an identity swap on stage in ${e.state}`);
    return false;
  }
  const from = e.name;
  unbindGuest(sys, e);
  e.gen = (e.gen ?? 0) + 1;
  // applyIdentity rolls the new length straight onto the eel; growEel is the only path that carries
  // spacing, ampTail, and the trail buffer with it, so hand the delta back through it.
  const oldLen = e.length;
  e.identity = id;
  applyIdentity(e, id, e.rng);
  const want = e.length;
  e.length = oldLen;
  growEel(e, want - oldLen);
  e.baseLength = e.length;
  e.rollColors(e.rng);
  e.rollPattern(e.rng);
  e.rollNick(e.rng);
  resetGuest(e);
  e.brain = GUESTS[id.name].brain;
  e.slip = SLIP;
  // The crumb-spam wobble is a resident's thing; a guest is born past the line and is not drunk, just big.
  e.drunkAt = Infinity;
  // The clamp band and the eye scale are functions of the radius that just changed; eel-air.js rewrites
  // the band with the same numbers in the init loop below, but a pond without it would keep the old one.
  e.floorY = -DEPTH + e.radius + 0.08;
  e.ceilingY = -e.radius * 0.5;
  if (e.uRadius) e.uRadius.value = e.radius;
  if (e.eyes) for (const m of e.eyes) m.scale.setScalar(e.radius * 0.2);
  GUESTS[id.name].init(sys, e);
  // Same hooks a hot-swap fires, in registration order: wits, fear state, air bounds, quirk state.
  for (const m of sys.modules) m.initEel?.(sys, e);
  if (e.body) sys.renderer.applyAppearance(e);
  bindFollowers(sys, e);
  if (from !== e.name) sys.emit('swap', e, { from, to: e.name });
  return true;
}

/* Everything in the pond that was pointing at the body while somebody else wore it. A crush is rebound
   by name afterwards, which is what restores Eleanor's follower the moment she takes the body back. */
function unbindGuest(sys, e) {
  // Every live path spits before it parks, so a body still in the jaws here means an invariant broke;
  // let it go rather than hand the next identity a hidden, collapsed resident.
  if (e.prey?.slurpedBy === e) {
    if (sys.debug) console.warn(`[guest] swapped with ${e.prey.name} still swallowed`);
    e.prey.slurpedBy = null;
    e.prey.length = e.prey.baseLength;
    growEel(e.prey, 0);
    sys.air?.restore(e.prey);
    setVisible(sys, e.prey, true);
  }
  e.prey = null;
  sys.lairGuest = null;
  for (const r of sys.eels) {
    if (r.partner === e) r.partner = null;
    if (r.slurpedBy === e) { r.slurpedBy = null; setVisible(sys, r, true); }
    if (r.buttTo === e) r.buttTo = null;
    if (r.rescueTo === e) r.rescueTo = null;
    if (r.cuddle?.with === e) r.cuddle.until = 0;
    if (r.snuggle?.with === e) r.snuggle.with = null;
    if (r.coverSpot?.owner === e) r.coverSpot = null;
  }
}

/* Late bond resolution: residents whose crush names the guest (Josh names Eleanor) acquire the body. */
function bindFollowers(sys, e) {
  for (const r of sys.eels) if (!r.partner && r.quirks.follows === e.name) r.partner = e;
}

function initEleanor(sys, e) {
  // Lair test is stricter than the passage fit: she wants a den, not a squeeze.
  const log = sys.colliders.logs[0];
  deriveLair(e, log && log.rInner >= e.radius * 1.6 ? log : null);
}

function enterEleanor(sys, e) {
  e.nextSwimBy = e.rng.range(30, 60);
  if (!e.lair) return false;
  teleport(e, e.lairPoint.x, e.lairPoint.z, Math.atan2(e.lairDir.z, e.lairDir.x), e.lairPoint.y);
  e.state = 'lair';
  return true;
}

function goHome(sys, e, now) {
  e.stateAt = now;
  e.rescued = false;
  e.stuckStrikes = 0;
  resetProgress(e);
  if (e.lair && !sys.perfHot) { e.state = 'return'; e.returnLeg = 0; }
  else e.state = 'depart';
}

function brain(sys, e, dt) {
  const now = sys.time;
  e.threat = THREAT[e.state] ?? 0.3;
  e.threatOn = e.state === 'hunt' ? e.prey : null;
  sys.lairGuest = e.lair && (e.state === 'lair' || e.state === 'return') ? e : null;
  if (sys.perfHot) e.coolAt = now + 10;

  if (e.state === 'lair' || e.state === 'offstage') {
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 4);
    paceWave(e, dt, true);
    // Q-A, the guest form: the module proposes, her controller applies. A tail flick and a small
    // heading wobble are the only two that fit a body already folded inside its log.
    const fidget = e.state === 'lair' ? sys.stim?.lairStim(sys, e) : null;
    if (fidget) {
      if (fidget.ampMul !== null) e.ampMul = fidget.ampMul;
      if (fidget.yaw) {
        const c = Math.cos(fidget.yaw * dt), s = Math.sin(fidget.yaw * dt);
        e.heading.set(e.heading.x * c - e.heading.z * s, 0, e.heading.x * s + e.heading.z * c);
      }
    }
    if (now > e.checkAt) {
      e.checkAt = now + 1;
      const fromLair = e.state === 'lair';
      // A hot pond empties even the lair; otherwise: repossessions first, then dinner, then a lap.
      if (fromLair && sys.perfHot) { begin(sys, e, 'depart', now); setExit(e, pickExit(sys, e)); return; }
      if (!sys.perfHot && now > e.coolAt) {
        const gnarly = sys.eels.filter((r) => r.length > SLURP_AT && !r.slurpedBy);
        if (gnarly.length) {
          gnarly.sort((a, b) => b.length - a.length);
          e.prey = gnarly[0];
          begin(sys, e, 'hunt', now);
          setExit(e, fromLair ? pickExit(sys, e) : null);
        } else if (sys.feedRecent >= FEED_WORTH) {
          sys.feedRecent = 0;
          begin(sys, e, 'graze', now);
          e.table = sys.commotion;
          setExit(e, fromLair ? pickExit(sys, e) : null);
        } else if (now > e.nextSwimBy) {
          begin(sys, e, 'swimby', now);
          setExit(e, fromLair ? pickExit(sys, e) : null);
          e.swimbyX = e.rng.range(-sys.view.w * 0.35, sys.view.w * 0.35);
          e.swimbyZ = e.rng.range(-sys.view.h * 0.35, sys.view.h * 0.35);
          e.swimbyBest = Infinity; e.swimbyBestAt = now;
        } else if (e.state === 'offstage' && e.lair) {
          begin(sys, e, 'return', now);
          e.returnLeg = 0;
        }
      }
    }
    return;
  }

  // Stuck rescue ladder: nope backward down her own path first; the hard park is the last resort.
  if (rescueLadder(sys, e, now, VISIT_CAP)) return;
  if (nopeTick(sys, e, dt, now)) return;
  // A meal in progress finishes before any performance retreat; slurp plus wriggle caps under 4 s.
  if (sys.perfHot && e.state !== 'depart' && e.state !== 'slurp' && e.state !== 'wriggle') { e.state = 'depart'; e.stateAt = now; }

  if (e.state === 'slurp') { slurpTick(sys, e, dt, now); return; }
  if (e.state === 'wriggle') {
    e.reverse = false;
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 6);
    paceWave(e, dt, false);
    e.wavePhase += Math.PI * 2 * 2.5 * dt;   // the victory shimmy runs hotter than her actual beat
    e.uExcite.value += (1 - e.uExcite.value) * Math.min(1, dt * 4);
    if (now - e.stateAt > 1.2) { spit(sys, e, now, { growPredator: true }); goHome(sys, e, now); }
    return;
  }

  e.reverse = false;
  let tx = 0, tz = 0, ty = -DEPTH + e.radius + 0.1, wantBL = e.cruiseBL;
  const fold = exitTarget(sys, e, dt, now);
  if (fold === 'done') return;
  if (fold) {
    tx = fold.x; tz = fold.z; ty = fold.y; wantBL = e.prowlBL;
  } else if (e.state === 'depart') {
    const d = Math.max(sys.view.w, sys.view.h) * 0.9 + e.length;
    tx = Math.cos(e.parkAng) * d; tz = Math.sin(e.parkAng) * d;
    // A surrender parks the moment the whole body is out of frame, or at its deadline if the swim-out jams.
    if (e.forceParkAt !== null && (now > e.forceParkAt || !onStage(sys, e))) { parkOffstage(sys, e, now); return; }
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < 1.5) {
      e.state = 'offstage';
      park(sys, e);
      setVisible(sys, e, false);
      e.nextSwimBy = now + e.rng.range(40, 80);
      // The offstage check reads coolAt, not nextSwimBy: without this a feeding spree pulls her straight back.
      e.coolAt = Math.max(e.coolAt, e.nextSwimBy);
      return;
    }
  } else if (e.state === 'return') {
    const p = e.returnLeg === 0 ? e.lairApproach : e.lairPoint;
    tx = p.x; tz = p.z; ty = p.y;
    if (e.returnLeg === 1) wantBL = e.prowlBL;
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < (e.returnLeg === 0 ? 0.8 : 0.5)) {
      if (e.returnLeg === 0) e.returnLeg = 1;
      else {
        e.state = 'lair';
        e.homeFails = 0;
        e.nextSwimBy = now + e.rng.range(40, 80);
        return;
      }
    }
  } else if (e.state === 'swimby') {
    // Shallow crossing on purpose: the surface furrow is the whole show.
    tx = e.swimbyX; tz = e.swimbyZ; ty = -e.radius * 1.3;
    const dSwim = Math.hypot(tx - e.head.x, tz - e.head.z);
    if (dSwim < 1.2) { goHome(sys, e, now); return; }
    // An orbit around the point never trips the progress watch, so closing distance is the test here:
    // 5 s without gaining ground ends the lap the ordinary way instead of at the 50 s surrender.
    if (dSwim < e.swimbyBest - 0.3) { e.swimbyBest = dSwim; e.swimbyBestAt = now; }
    else if (now - e.swimbyBestAt > 5) { goHome(sys, e, now); return; }
  } else if (e.state === 'hunt') {
    const p = e.prey;
    if (!p || p.length <= SLURP_AT || now - e.stateAt > 25) { e.prey = null; goHome(sys, e, now); return; }
    tx = p.head.x; tz = p.head.z;
    ty = Math.max(-DEPTH + e.radius, p.head.y);
    wantBL = e.cruiseBL * 1.3;
    const tail = p.pts[p.pts.length - 1];
    // A zoomies prey is never actually caught: the run itself burns her back under SLURP_AT.
    if (p.quirks?.zoomies) zoomTick(sys, e, p, dt, now);
    else if (Math.min(Math.hypot(e.head.x - tail.x, e.head.z - tail.z), Math.hypot(e.head.x - p.head.x, e.head.z - p.head.z)) < 0.9) {
      // F1: everybody close enough to watch loses every second of trust she had earned, and carries
      // two minutes of extra fear on top of it.
      capture(sys, e, p, now, { state: 'slurp', witness: true });
      return;
    }
  } else {
    // A feed spree does not depend on her short nose: she heads for the commotion, and only once she is
    // on top of it does smell pick out individual crumbs. Smelling none en route is never a reason to go home.
    const spot = sys.commotion;
    if (spot) { e.table = e.table ?? { x: 0, z: 0 }; e.table.x = spot.x; e.table.z = spot.z; }
    // No table at all is a different thing from a table she cannot smell yet: the first is a wasted
    // trip, the second is what the investigate phase exists to survive.
    if (!e.table) { goHome(sys, e, now); return; }
    const far = Math.hypot(e.table.x - e.head.x, e.table.z - e.head.z);
    const arrived = far <= COMMOTION_NEAR;
    let best = null, bd = 1e9;
    if (arrived) {
      // The brain prepass already sensed for her this tick; sense() only rebuilds and returns this list.
      for (const f of (sys.braincell ? e.sensedFoods : sys.foods)) {
        // A crumb still falling or parked on a pad is smelled, not eaten; the sensed set carries both.
        if (f.amount <= 0 || f.airborne || f.onPad) continue;
        const d = Math.hypot(f.x - e.head.x, f.z - e.head.z);
        if (d < bd) { bd = d; best = f; }
      }
    }
    // The visit ends on its own clock or when the table is genuinely gone, never because her short
    // nose has not reached a crumb yet: that failure is what the investigate phase exists to survive.
    if (now - e.stateAt > VISIT_CAP || !sys.foods.some((f) => f.amount > 0)) { goHome(sys, e, now); return; }
    if (!best) {
      tx = e.table.x; tz = e.table.z;
    } else {
      tx = best.x; tz = best.z;
      ty = Math.max(-DEPTH + e.radius, best.y + 0.05);
      if (bd < 0.9) {
        wantBL = e.prowlBL;
        best.amount -= dt * 3;
        e.uExcite.value += (0.7 - e.uExcite.value) * Math.min(1, dt * 2);
        if (now > (e.bubSoundAt ?? 0)) { e.bubSoundAt = now + e.rng.range(0.4, 0.9); sys.emit('nibble', e); }
        if (best.amount <= 0) sys.emit('eat', e, best);
      }
    }
  }

  // Homing aims at a point two units off her own log's mouth, so that log must stop shoving her away
  // from it or she orbits her own front door until the visit times out.
  const inBore = !!e.exiting || (e.state === 'return' && e.returnLeg === 1);
  moveGuest(sys, e, dt, now, tx, tz, ty, wantBL, { inBore, homing: e.state === 'return' ? e.lair : null });

  // Per tick, a body her size reads every scrape along a log as a jam; three bad windows is a real
  // one, and 1.5 s is still early enough.
  if (!progressStrike(e, dt)) return;
  if (e.stuckStrikes < 2) { e.nopePulse = now + 1.3; startle(sys, e); return; }
  e.stuckStrikes = 0;
  // The old rescue for a jammed return was another return, and goHome resets the visit clock,
  // so the hard park never fired. A second failed trip home now surrenders the visit instead.
  if (e.forceParkAt !== null || (e.state === 'return' && (e.homeFails = (e.homeFails ?? 0) + 1) >= 2)) parkOffstage(sys, e, now);
  else goHome(sys, e, now);
}

/* Chandler outruns the queen. Speed comes from the residents' own steer: a speedMul spike set after
   her steer ran this tick becomes next tick's burst, capped at cruise × 1.5 like every other stim. */
function zoomTick(sys, e, p, dt, now) {
  if (p.slurpedBy) return;
  p.uExcite.value += (1 - p.uExcite.value) * Math.min(1, dt * 4);
  if (p.length > p.baseLength) growEel(p, -Math.min(0.5 * dt, p.length - p.baseLength));
  // Mid-bore the run's own target must stand, or she aims at the wall from inside the log.
  if (p.tunnel || now < e.zoomAt) return;
  e.zoomAt = now + ZOOM_EVERY;
  const ax = p.head.x - e.head.x, az = p.head.z - e.head.z;
  const away = Math.hypot(ax, az) > 1e-4 ? Math.atan2(az, ax) : e.rng.range(0, Math.PI * 2);
  const ang = away + e.rng.range(-ZOOM_JITTER, ZOOM_JITTER);
  const d = p.length * e.rng.range(2, 3);
  const hw = sys.view.w * 0.45, hh = sys.view.h * 0.45;
  p.target.set(
    Math.max(-hw, Math.min(hw, p.head.x + Math.cos(ang) * d)),
    0,
    Math.max(-hh, Math.min(hh, p.head.z + Math.sin(ang) * d)),
  );
  p.retargetAt = now + ZOOM_EVERY;
  p.speedMul = 2.2;
}

function slurpTick(sys, e, dt, now) {
  const p = e.prey;
  e.reverse = false;
  e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 6);
  paceWave(e, dt, false);
  e.uExcite.value += (0.9 - e.uExcite.value) * Math.min(1, dt * 3);
  e.slurpT = Math.min(1, e.slurpT + dt / 2.5);
  const mouth = e.head;
  const n = p.pts.length;
  // Tail-first into the pharyngeal jaws: each segment collapses to the mouth as the eaten front reaches it.
  const eaten = e.slurpT * (n + 3);
  for (let i = 0; i < n; i++) {
    const depth = n - 1 - i < eaten ? Math.min(1, (eaten - (n - 1 - i)) / 3) : 0;
    if (depth > 0) p.pts[i].lerp(mouth, Math.min(1, depth * (dt * 14 + 0.15)));
  }
  if (e.slurpT >= 1) {
    setVisible(sys, p, false);
    p.length = p.baseLength;
    growEel(p, 0);   // recomputes spacing and damped tail amplitude at the reset length
    begin(sys, e, 'wriggle', now);
  }
}
