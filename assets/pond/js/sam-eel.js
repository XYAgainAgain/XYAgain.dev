import { DEPTH } from './config.js';
import { boreBackout, dropCover, headInBore, paceWave, releaseSteer, steerGuest } from './eel-behavior.js';
import { growEel } from './eel-physics.js';
import {
  SLURP_AT, begin, capture, deriveLair, dropTailPerch, endGuestMeals, exitTarget, moveGuest, nopeTick, onStage, park,
  parkOffstage, pickExit, progressStrike, rescueLadder, resetProgress, rest, setExit, setVisible, spit, teleport,
} from './guest-stage.js';
import {
  buildGuestPolicy, collapseStep, crumbClaimed, crumbWanted, curlSide, deferClock, deferReady, horizonAt,
  insideBore, logFitsGuest, logTaken, openMask, ouroborosPoints, spaghettiPoints, spiralAt, spiralStart,
  tailSlots, COLLAPSE, MEALS,
} from './sam-eel-core.js';
import { shoalAvoidFrac } from './reeds-core.js';
import { crumbScale } from './treats-core.js';

/* Sam the Space Eel: the controller behind the void. He rides Eleanor's stage and repossession trigger,
   shares none of her temper (zero threat, calm not alarm, patience for a log instead of taking it), and
   the singularity opens only for a repossession or for himself. His rounds are a resident's tick through
   steerGuest, gated by the policy his identity builds; a forced exit on stage swallows him whole. */

const SUN_ORANGE = [1.0, 0.55, 0.18];
const STRETCH = 1.2;        // how far past its own length a swallowed body is drawn out toward the horizon
export const HORIZON_SLURP = 1.2;  // the meal scale the renderer eases the mouth open to, in body radii
const MEAL_HOLD = 0.9;      // the calm beat between the last segment going in and the spit
const REACH = 0.9;          // jaw range, Eleanor's
const GIVE_UP = 25;         // seconds of approach before a repossession is abandoned
const NEAR_LAIR = 4;        // a free log this close ends a rounds leg early
const SPARKS = 8;           // stargazed: sun-orange specks shed over the roll
const STARGAZE_FOR = 2;
const CALM_STEP = 0.5;      // units of travel between calm deposits, F5's own spacing
const ALARM_FREE = 0.001;
const DUNE_MAX = 0.085;     // the floor's two dune terms at their worst, on top of whatever a shoal adds
const SAND_CLEAR = 0.06;    // default: how far under his center the sand has to stay to stay out of him
const AVOID_MIN = 0.05;     // a crown narrower than this is not worth steering around
const EXIT_FLOP_FOR = 20;   // seconds after the lair's exit fold in which the flop over that log may still start
const EXIT_FLOP_OUT = 1.2;  // units off the bark where he lines up beside the log before going over it
const ORIGIN = { x: 0, y: 0, z: 0 }, UNIT_X = { x: 1, y: 0, z: 0 };
const tmpH = { x: 0, y: 0, z: 0 };

const dial = (sys) => sys.knobs.guest ?? {};

/* A [lo, hi] dial, drawn from the guest's own rng and scaled by samStay. A junk dial falls back rather
   than handing NaN to a clock nothing can ever pass. */
function span(e, band, fallback, mul) {
  const b = Array.isArray(band) && Number.isFinite(band[0]) && Number.isFinite(band[1]) ? band : fallback;
  return e.rng.range(b[0], b[1]) * mul;
}

function stayMul(sys) {
  const v = dial(sys).samStay;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function capFor(sys, seconds) {
  const v = dial(sys).samCap;
  return seconds * (Number.isFinite(v) && v > 0 ? v : 1);
}

/* Both logs are candidates, nearest first; he never evicts, so a claimed or occupied one is simply
   not his. `soft` skips the occupancy test, for picking which log to walk toward at all. */
function freeLair(sys, e, soft = false) {
  const logs = (e.lairs ?? []).slice();
  logs.sort((a, b) => logNear(a, e.head) - logNear(b, e.head));
  for (const l of logs) if (soft || !logTaken(l, sys.eels, e)) return l;
  return null;
}

function hyp(p, q) { return Math.hypot(p.x - q.x, p.z - q.z); }

/* Distance to the nearer mouth: which end he approaches from decides how far the log actually is. */
function logNear(l, head) { return Math.min(hyp(l.a, head), hyp(l.b, head)); }

/* Nearest of his spine to a point in xz. Every fourth vertebra: the body is a smooth curve and this
   runs once per resident per tick. */
function nearSpine(e, x, z) {
  let best = Infinity;
  for (let i = 0; i < e.pts.length; i += 4) {
    const p = e.pts[i];
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best) best = d;
  }
  return best;
}

/* The release runs in the same tick as the transition out of rounds: the air module's prepass trigger
   (the still finger) reads steerHeld before this controller ticks again. */
export function brain(sys, e, dt) {
  tick(sys, e, dt);
  if (e.steerHeld && e.state !== 'rounds') releaseSteer(sys, e);
}

function tick(sys, e, dt) {
  const now = sys.time;
  const k = dial(sys);
  // Zero in every state, so threatOf returns 0, guestAlarm deposits nothing, and no fear map ever
  // learns him. The presence writer in eel-fear.js is what residents actually steer around.
  e.threat = 0;
  e.threatOn = null;
  shoalGuard(sys, e, k);
  pace(e, k);
  // His small meals live only in rounds: whatever took him out of it ended them, whichever seam it was.
  if (e.state !== 'rounds') endGuestMeals(sys, e);
  e.openMask = openMask(e.pts, sys.colliders.logs, !!e.body?.visible && e.state !== 'offstage', e.openMask);
  deferTrack(sys, e, now);
  pullTick(sys, e, dt);
  // The mouth belongs to the meal: any seam that ends one early (a surrender, a hot pond, a repossession
  // mid-sweep) leaves the horizon closed behind it.
  if (!(e.state === 'collect' && e.phase !== 'approach')) e.horizon = mealHorizon(e, now);
  // Only the log residents can reach is expressible to them, so a nap in the second log berths nobody.
  const home = e.state === 'lair' && e.lair === sys.colliders.logs[0];
  sys.lairGuest = home ? e : null;
  sunHeat(e, dt);
  calmTrail(sys, e, k);
  bowStep(sys, e, dt, k);
  sparkStep(sys, e, now);
  tailPerchTick(sys, e);
  if (sys.perfHot) e.coolAt = now + 10;
  // The surrender marks a forced exit and hands the tick straight back; the collapse starts here.
  if (e.state === 'depart' && e.exitStyle === 'collapse') { startCollapse(sys, e, now); return; }
  // An air state owns him until it lets go: leaving rounds under one would freeze the peek or the flop
  // with its bounds open, since moveGuest never ticks the air module. Every air state has its own deadline.
  if (e.state === 'rounds' && sys.air?.busy(e)) { steerGuest(sys, e, dt, e.guestPolicy); return; }

  if (e.state === 'lair' && e.returnLeg >= 2) { restTick(sys, e, dt, now); return; }
  if (e.state === 'offstage') { offstageTick(sys, e, dt, now); return; }

  if (rescueLadder(sys, e, now, capFor(sys, e.stageCap ?? 45))) return;
  if (nopeTick(sys, e, dt, now)) return;
  // A meal in progress finishes before any performance retreat; the whole capture caps under 4 s. A hot
  // pond is a forced exit, so he swallows himself rather than swimming off the rim.
  if (sys.perfHot && e.state !== 'depart' && !(e.state === 'collect' && e.phase !== 'approach')) { startCollapse(sys, e, now); return; }

  e.reverse = false;
  // Already paced to the dial by pace() above, so these read as world speeds whatever length he rolled.
  const cruise = e.cruiseBL, prowl = e.prowlBL;
  let tx = 0, tz = 0, ty = -DEPTH + e.radius + 0.1, wantBL = cruise;
  let homing = null;

  const fold = exitTarget(sys, e, dt, now);
  if (fold === 'done') return;
  if (fold) {
    tx = fold.x; tz = fold.z; ty = fold.y; wantBL = prowl;
  } else if (e.state === 'collect') {
    if (collectTick(sys, e, dt, now)) return;
    const p = e.prey;
    tx = p.head.x; tz = p.head.z;
    ty = Math.max(-DEPTH + e.radius, p.head.y);
    // The approach is a cruise, not a chase: Eleanor's hunt runs 1.3× and he runs none of it.
    wantBL = cruise;
  } else if (e.state === 'depart') {
    const d = Math.max(sys.view.w, sys.view.h) * 0.9 + e.length;
    tx = Math.cos(e.parkAng) * d; tz = Math.sin(e.parkAng) * d;
    // A surrender parks the moment the whole body is out of frame, or at its deadline if the swim-out jams.
    if (e.forceParkAt !== null && (now > e.forceParkAt || !onStage(sys, e))) { parkOffstage(sys, e, now); return; }
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < 1.5) {
      e.state = 'offstage';
      park(sys, e);
      setVisible(sys, e, false);
      rest(e, now);   // after the park: the roll inside it wiped both clocks
      return;
    }
  } else if (e.state === 'lair') {
    // A resident that takes the log while he is still walking up to it wins; inside the bore it is his.
    if (e.returnLeg === 0 && now > e.checkAt) {
      e.checkAt = now + 1;
      if (logTaken(e.lair, sys.eels, e)) { toWait(sys, e, now, e.lair); return; }
    }
    homing = e.lair;
    const p = e.returnLeg === 0 ? e.lairApproach : e.lairPoint;
    tx = p.x; tz = p.z; ty = p.y;
    if (e.returnLeg === 1) wantBL = prowl;
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < (e.returnLeg === 0 ? 0.8 : 0.5)) {
      if (e.returnLeg === 0) e.returnLeg = 1;
      else { sleep(sys, e, now); return; }
    }
  } else if (e.state === 'wait') {
    // Beside the bore axis, never on it: a blocked mouth is an eviction by another name.
    const p = holdPoint(e);
    tx = p.x; tz = p.z; ty = p.y;
    wantBL = Math.hypot(tx - e.head.x, tz - e.head.z) > e.radius * 3 ? prowl : 0;
    if (now > e.checkAt) {
      e.checkAt = now + 1;
      if (!logTaken(e.lairWanted, sys.eels, e)) { toLair(sys, e, now, e.lairWanted); return; }
      // A log that never frees up is not worth a second try: the expired wait spends his lair leg.
      if (now - e.stateAt > (k.samWait ?? 45)) { e.leg++; toRounds(sys, e, now); return; }
    }
  } else if (e.state === 'arrive') {
    tx = e.roamX; tz = e.roamZ;
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < 1.5) { toRounds(sys, e, now); return; }
  } else {
    if (roundsTick(sys, e, now)) return;
    // Open water is a resident's tick: steer owns the heading and the pose commit, the stage only watches.
    if (!steerGuest(sys, e, dt, e.guestPolicy)) { toDepart(sys, e, now); return; }
    deferTick(sys, e, now);
    exitFlopTick(sys, e, now);
    roundsStrike(sys, e, dt, now);
    return;
  }

  // Read after the fold, not before: a fold that arrived this tick hands the walls back to avoidance.
  const inBore = !!e.exiting || (e.state === 'lair' && e.returnLeg === 1);
  moveGuest(sys, e, dt, now, tx, tz, ty, wantBL, { inBore, homing, shoals: e.shoalAvoid });
  if (progressStrike(e, dt)) {
    if (e.stuckStrikes >= 2) {
      e.stuckStrikes = 0;
      if (e.forceParkAt !== null) parkOffstage(sys, e, now);
      else {
        // A jammed walk to a log spends the leg, or rounds sees the same free log and walks straight back.
        if (e.state === 'lair' || e.state === 'wait') e.leg++;
        toRounds(sys, e, now);
      }
    } else e.nopePulse = now + 1.3;   // no startle: the stage policy is silence for him
  }
}

// States

function offstageTick(sys, e, dt, now) {
  e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 4);
  paceWave(e, dt, true);
  if (now <= e.checkAt) return;
  e.checkAt = now + 1;
  if (sys.perfHot || now < e.coolAt) return;
  e.leg = 0;
  e.roamX = e.rng.range(-sys.view.w * 0.3, sys.view.w * 0.3);
  e.roamZ = e.rng.range(-sys.view.h * 0.3, sys.view.h * 0.3);
  e.stageCap = 60;
  begin(sys, e, 'arrive', now);
}

/* The nap: tail out of the mouth, suns down to embers, the universe in him still drifting. */
function restTick(sys, e, dt, now) {
  e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 4);
  paceWave(e, dt, true);
  // The stimming module proposes, his controller applies. A tail flick is the only fidget that
  // fits a body already folded inside its log.
  const fidget = sys.stim?.lairStim(sys, e);
  if (fidget && fidget.ampMul !== null) e.ampMul = fidget.ampMul;
  if (now <= e.checkAt) return;
  e.checkAt = now + 1;
  // A hot pond empties even the lair: a forced exit, so the collapse starts from inside the log.
  if (sys.perfHot) { startCollapse(sys, e, now); return; }
  if (now > e.napUntil) { wake(sys, e, now); toRounds(sys, e, now); }
}

/* A rounds leg's once-a-second checks: look in on the log, and take the one repossession the pond
   actually needs. Steer does the wandering. Returns true when the tick has been handed to another state. */
function roundsTick(sys, e, now) {
  if (now <= e.checkAt) return false;
  // A committed run owns him until it clears the far mouth: every exit from here would hand a body still
  // in the bore to moveGuest, whose log shove does not know he is inside it.
  if (e.tunnel && e.tunnel.stage >= 1) return false;
  // A crumb mid-pull is half a second from the horizon; leaving rounds now would pop it out of the air.
  if (e.crumbPull) return false;
  e.checkAt = now + 1;
  if (!sys.perfHot && now > e.coolAt) {
    const gnarly = sys.eels.filter((r) => r.length > SLURP_AT && !r.slurpedBy);
    if (gnarly.length) {
      gnarly.sort((a, b) => b.length - a.length);
      e.prey = gnarly[0];
      e.phase = 'approach';
      e.stageCap = GIVE_UP;
      begin(sys, e, 'collect', now);
      return true;
    }
  }
  // A run never becomes a nap: lining up at a mouth is exactly what the near-log test reads as arriving.
  if (e.tunnel) return false;
  // One lair leg a visit: rounds, a nap, rounds, gone. Past the first nap there is nothing to walk to.
  const want = e.leg > 0 ? null : freeLair(sys, e, true);
  const near = !!want && logNear(want, e.head) < NEAR_LAIR;
  if (!(now > e.roundsUntil || near)) return false;
  if (!want) { toDepart(sys, e, now); return true; }
  if (logTaken(want, sys.eels, e)) toWait(sys, e, now, want);
  else toLair(sys, e, now, want);
  return true;
}

/* The repossession. Eleanor's trigger and cadence; none of her menace, and the witness effect that
   teaches a pond to fear its predator stays off. Returns true when it owns the tick outright. */
function collectTick(sys, e, dt, now) {
  const p = e.prey;
  if (e.phase === 'approach') {
    if (!p || p.slurpedBy || p.length <= SLURP_AT || now - e.stateAt > GIVE_UP) { e.prey = null; toRounds(sys, e, now); return true; }
    const tail = p.pts[p.pts.length - 1];
    const d = Math.min(Math.hypot(e.head.x - tail.x, e.head.z - tail.z), Math.hypot(e.head.x - p.head.x, e.head.z - p.head.z));
    if (d >= REACH) return false;
    // The body stretches away from the snout along the line it was caught on, so a meal taken from the
    // side does not snap the victim around to his heading first.
    const ax = p.head.x - e.head.x, az = p.head.z - e.head.z;
    const al = Math.hypot(ax, az);
    e.slurpDir = al > 1e-4 ? { x: ax / al, y: 0, z: az / al } : { x: e.heading.x, y: 0, z: e.heading.z };
    e.horizon = HORIZON_SLURP;
    e.phase = 'slurp';
    capture(sys, e, p, now, { state: 'collect', witness: false });
    return true;
  }
  e.reverse = false;
  e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 6);
  paceWave(e, dt, false);
  if (e.phase === 'slurp') {
    e.slurpT = Math.min(1, e.slurpT + dt / 2.5);
    // The eaten front runs 1 to 0 in u, tail first, exactly as the live slurp orders its segments.
    const pts = spaghettiPoints(p.pts, e.head, e.slurpDir, p.length * STRETCH, 1 - e.slurpT, e.stretchOut ??= []);
    for (let i = 0; i < p.pts.length; i++) p.pts[i].set(pts[i].x, pts[i].y, pts[i].z);
    if (e.slurpT < 1) return true;
    setVisible(sys, p, false);
    p.length = p.baseLength;
    growEel(p, 0);   // recomputes spacing and damped tail amplitude at the reset length
    e.phase = 'hold';
    e.stateAt = now;
    return true;
  }
  if (now - e.stateAt < MEAL_HOLD) return true;
  const spat = spit(sys, e, now, { growPredator: (dial(sys).samGrows ?? 0) > 0 });
  e.horizon = 0;
  if (spat) stargaze(sys, e, spat, now);
  e.coolAt = now + e.rng.range(40, 80);
  toRounds(sys, e, now);
  return true;
}

/* The stage keeps watching under steer, or a wedged guest never surrenders. A strike is a fresh plan
   (then steer's paced reverse), never a stage-clock reset: that is what let wave one re-arm forever. */
function roundsStrike(sys, e, dt, now) {
  if (!progressStrike(e, dt)) return;
  // Wedged inside a bore: back out to the mouth he came in by. A fresh plan here would aim through the wood.
  if (e.tunnel && headInBore(e)) { e.stuckStrikes = 0; boreBackout(sys, e, now); return; }
  e.attnReset = true;
  if (e.stuckStrikes >= 2) { e.stuckStrikes = 0; e.nopeUntil = Math.max(e.nopeUntil, now + 0.7); }
}

// Transitions

function toRounds(sys, e, now) {
  e.prey = null;
  e.phase = null;
  e.horizon = 0;
  e.roundsUntil = now + span(e, dial(sys).samRounds, [90, 150], stayMul(sys));
  e.retargetAt = 0;
  // The rescue deadline has to outlast the leg it is watching, or a long rounds roll surrenders itself.
  e.stageCap = e.roundsUntil - now + 30;
  if (e.state !== 'rounds') begin(sys, e, 'rounds', now);
  else { e.stateAt = now; e.rescued = false; e.stuckStrikes = 0; resetProgress(e); }
}

function toWait(sys, e, now, log) {
  e.lairWanted = log;
  e.checkAt = now + 1;
  e.stageCap = (dial(sys).samWait ?? 45) + 20;
  begin(sys, e, 'wait', now);
}

function toLair(sys, e, now, log) {
  deriveLair(e, log);
  e.returnLeg = 0;
  e.stageCap = 60;
  begin(sys, e, 'lair', now);
}

function toDepart(sys, e, now) {
  if (e.state === 'lair' && e.returnLeg >= 2) setExit(e, pickExit(sys, e));
  // Never leave with someone in the jaws, whichever seam forced the exit.
  if (e.prey?.slurpedBy === e) spit(sys, e, now, { growPredator: false });
  e.prey = null;
  e.phase = null;
  e.horizon = 0;
  e.stageCap = 45;
  begin(sys, e, 'depart', now);
}

function sleep(sys, e, now) {
  e.returnLeg = 2;
  e.napUntil = now + span(e, dial(sys).samNap, [120, 240], stayMul(sys));
  e.checkAt = now + 1;
  e.leg++;
}

function wake(sys, e, now) {
  e.returnLeg = 0;
  dropTailPerch(sys, e);   // his nappers wake with him, the ordinary way
  setExit(e, pickExit(sys, e));   // silent for him: the stage reads his startle policy
  e.stateAt = now;
  // B6: now and then the way out of the lair is over the top of it, when the crest is dry. The side he
  // climbs from is drawn here too, so the whole choice is made on one tick.
  const l = e.lair, odds = dial(sys).samExitFlop;
  const dry = !!l && l.a.y + l.rOuter > 0 && l.b.y + l.rOuter > 0;
  e.exitFlop = dry && e.rng.chance(Number.isFinite(odds) ? Math.min(1, Math.max(0, odds)) : 0.35)
    ? { log: l, side: e.rng.chance(0.5) ? 1 : -1, until: null } : null;
}

/* The flop out of the lair, once the exit fold has handed him to steer: line up beside the middle of the
   log he slept in, then go over it from wherever alongside he got to. Gives up after EXIT_FLOP_FOR. */
function exitFlopTick(sys, e, now) {
  const f = e.exitFlop;
  if (!f || e.exiting || !sys.air) return;
  const l = f.log;
  const ax = l.b.x - l.a.x, az = l.b.z - l.a.z, len = Math.hypot(ax, az) || 1e-4;
  const ux = ax / len, uz = az / len, px = -uz, pz = ux;
  const mx = (l.a.x + l.b.x) * 0.5, mz = (l.a.z + l.b.z) * 0.5;
  // A run, a peek, or anything else the air module holds him for ends the offer, and so does the clock.
  // Checked before the target write: a run's stage machine steers by e.target and must keep its own.
  if ((f.until !== null && now > f.until) || e.tunnel || sys.air.busy(e)) { e.exitFlop = null; return; }
  if (f.until === null) {
    f.until = now + EXIT_FLOP_FOR;
    // Any pad or crest the first wander just claimed would read the flank point as its own arrival.
    dropCover(sys, e);
    const out = l.rOuter + EXIT_FLOP_OUT;
    e.target.set(mx + px * f.side * out, 0, mz + pz * f.side * out);
    e.retargetAt = f.until;
  }
  const t = ((e.head.x - l.a.x) * ux + (e.head.z - l.a.z) * uz) / len;
  const lat = (e.head.x - l.a.x) * px + (e.head.z - l.a.z) * pz;
  if (t < 0.15 || t > 0.85 || Math.abs(lat) > l.rOuter + e.guestPolicy.flopReach) return;
  const out = l.rOuter + 3, sd = lat >= 0 ? -1 : 1;
  const across = { x: mx + px * sd * out, z: mz + pz * sd * out };
  if (sys.air.tryFlop(e, l, across, false, true)) e.exitFlop = null;
}

// B5's small meals

/* The horizon's target, in body radii, from whichever small meal is open; a capture writes its own. */
function mealHorizon(e, now) {
  if (e.state !== 'rounds') return 0;
  return Math.max(e.crumbPull ? MEALS.crumbHorizon : 0, now < (e.sweepUntil ?? 0) ? MEALS.sweepHorizon : 0);
}

/* Every landed crumb's defer clock, every tick: "unwanted for four seconds" has to be watched, not guessed. */
function deferTrack(sys, e, now) {
  if (!e.guestPolicy?.defer) return;
  for (const f of sys.foods) if (f.amount > 0 && !f.airborne && !f.onPad) deferClock(f, now, crumbWanted(f, sys.eels));
}

/* A crumb in a log's footprint is under wood or in a bore, and he takes no runs for food. */
function underLog(sys, x, z) {
  for (const l of sys.colliders.logs) {
    const ax = l.b.x - l.a.x, az = l.b.z - l.a.z, l2 = ax * ax + az * az || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - l.a.x) * ax + (z - l.a.z) * az) / l2));
    if (Math.hypot(x - l.a.x - ax * t, z - l.a.z - az * t) < l.rOuter + 0.1) return true;
  }
  return false;
}

/* B5 item 2, the approach half, after steer has moved him: a crumb nobody has wanted for samDefer seconds,
   let go the moment a resident claims it, and the pull opened at crumbReach. */
function deferTick(sys, e, now) {
  if (!e.guestPolicy?.defer || e.crumbPull) return;
  const c = e.samCrumb;
  if (c) {
    // Eaten, capped away, or claimed after all: he lets it go without a word and wanders on.
    if (!(c.amount > 0) || !sys.foods.includes(c) || crumbClaimed(c, sys.eels)) { standDown(e); return; }
    if (now - e.samCrumbAt > MEALS.crumbGiveUp) { c.samRefused = true; standDown(e); return; }
    if (Math.hypot(c.x - e.head.x, c.z - e.head.z) < MEALS.crumbReach) startPull(sys, e, c);
    return;
  }
  if (now < (e.deferAt ?? 0)) return;
  e.deferAt = now + 1;
  if (e.tunnel || e.exitFlop || e.leanOn || sys.air?.busy(e)) return;
  const v = dial(sys).samDefer, defer = Number.isFinite(v) && v >= 0 ? v : 4;
  let best = null, bd = Infinity;
  for (const f of sys.foods) {
    if (!deferReady(f, now, sys.eels, defer) || underLog(sys, f.x, f.z)) continue;
    const d = Math.hypot(f.x - e.head.x, f.z - e.head.z);
    if (d < bd) { bd = d; best = f; }
  }
  if (!best) return;
  e.samCrumb = best;
  e.samCrumbAt = now;
  // A pad loiter or a crest rest would hold the retarget shut under him on the way.
  dropCover(sys, e);
}

function standDown(e) {
  e.samCrumb = null;
  e.retargetAt = 0;
}

/* The pull starts: the crumb leaves the world, so no claim can reach it from here on, and spirals into the
   crumb-scale horizon. Residents ticked first, so a claim made on this very tick is already counted. */
function startPull(sys, e, c) {
  if (crumbClaimed(c, sys.eels)) { standDown(e); return; }
  sys.takeFood(c);
  const h = horizonAt(e.head, e.heading, e.radius, tmpH);
  e.crumbPull = { crumb: c, t: 0, y0: c.y, cap: spiralStart(c.x, c.z, h.x, h.z, MEALS.crumbTurn), at: {} };
  standDown(e);
}

/* Controller-owned, like the repossession's stretch: the crumb rides the spiral to his moving mouth, drawn
   out along the pull, and is gone at the horizon. Out of foods, the renderer no longer places its mesh. */
function pullTick(sys, e, dt) {
  const p = e.crumbPull;
  if (!p) return;
  p.t += dt;
  const h = horizonAt(e.head, e.heading, e.radius, tmpH);
  const s = spiralAt(p.cap, p.t, MEALS.crumbPull, h.x, h.z, MEALS.crumbHorizon * e.radius, p.at);
  const c = p.crumb, k = s.u * s.u;
  c.x = c.mx = s.x; c.z = c.mz = s.z;
  c.y = h.y + (p.y0 - h.y) * (1 - k);
  if (c.mesh) {
    const [along, across] = MEALS.crumbStretch, sc = crumbScale(c.amount);
    c.mesh.position.set(c.x, c.y, c.z);
    // Local x onto the line to the hole, turned about y only: the camera looks straight down.
    c.mesh.rotation.set(0, Math.atan2(-(h.z - c.z), h.x - c.x), 0);
    const wide = sc * (1 + (across - 1) * s.u);
    c.mesh.scale.set(sc * (1 + (along - 1) * s.u), wide, wide);
  }
  if (!s.done) return;
  e.crumbPull = null;
  sys.dropFood(c);
  sys.emit('eat', e, c);
}

// The two plain fields the renderer reads, and the deference the residents feel

/* The tail perch (B4): two slots riding the lit tail while he sleeps. A hot-swap or a slurp in eels.js
   nulls a napper's spot without handing the claim back, so forgotten claims are swept here every tick. */
function tailPerchTick(sys, e) {
  const h = sys.habitat;
  const asleep = e.state === 'lair' && e.returnLeg >= 2 && !!e.body?.visible;
  const at = asleep && h ? tailSlots(e.pts, e.radius, e.lair, e.tailAt) : null;
  if (!at) { dropTailPerch(sys, e); return; }
  e.tailAt = at;
  if (!e.tailPerch) {
    e.tailPerch = h.addPerch({ x: at.x, y: at.y, z: at.z, type: 'tail', radius: e.radius * 3, cap: 2, owner: e, slots: at.slots });
  }
  const p = e.tailPerch;
  p.x = at.x; p.y = at.y; p.z = at.z; p.slots = at.slots;
  for (const r of h.claimants(p.id)) {
    if (r.slurpedBy || r.coverSpot?.type !== 'tail' || r.coverSpot.id !== p.id) h.release(p.id, r);
  }
}

// The self-swallow (S4)

/* A forced exit on stage. Marked swallowed by its own mouth, the body is skipped by the brain loop, the
   chain solver, and every resident; the collapse module below drives it until the park. */
function startCollapse(sys, e, now) {
  e.exitStyle = 'collapse';
  // The small meals end, and his body closes to the water: litter and treats pass over the curling ring.
  endGuestMeals(sys, e);
  e.openMask?.fill(0);
  // Never with someone in the jaws, whichever seam forced the exit.
  if (e.prey?.slurpedBy === e) spit(sys, e, now, { growPredator: false });
  e.prey = null;
  e.phase = null;
  if (e.steerHeld) releaseSteer(sys, e);
  dropTailPerch(sys, e);
  setExit(e, null);
  e.exitFlop = null;
  // Nobody sees a collapse off the rim: an ordinary park does the same job.
  if (!onStage(sys, e)) {
    e.state = 'offstage';
    setVisible(sys, e, false);
    park(sys, e);
    rest(e, now);
    return;
  }
  sys.lairGuest = null;
  const fx = e.heading.x, fz = e.heading.z, lead = COLLAPSE.lead;
  e.collapse = {
    t: 0, phase: 'swallow', w: 0, s: 1, flash: 0, L: e.length,
    mouth: { x: e.head.x - fx * lead, y: e.head.y, z: e.head.z - fz * lead },
    fwd: { x: fx, z: fz }, side: curlSide(e.pts, e.heading),
    from: e.pts.map((q) => ({ x: q.x, y: q.y, z: q.z })), dist: [], loop: [],
  };
  e.state = 'collapse';
  e.stateAt = now;
  e.speedBL = 0;
  e.reverse = false;
  e.horizon = HORIZON_SLURP;
  e.collapseFlash = 0;
  e.slurpedBy = e;
}

/* One tick of the collapse, from the module prepass (the brain loop skips a swallowed body). The tick
   the last point goes in carries collapseFlash 1; the next one hides, parks, and rolls the next visit. */
export function collapseSelfTick(sys, e, dt) {
  const c = e.collapse;
  collapseStep(c, dt);
  // The brain loop skips a swallowed body, so a collapse out of the lair would go in on embers.
  e.sunHeat = Math.min(1, (e.sunHeat ?? 1) + SUN_WAKE * dt);
  if (c.phase === 'done') { finishCollapse(sys, e, sys.time); return; }
  e.collapseFlash = c.flash;
  // Render-only and never read here: two ticks in one frame would clear the flash before any draw saw it.
  if (c.flash) e.flashPending = { x: e.head.x, y: e.head.y, z: e.head.z };
  e.horizon = HORIZON_SLURP;
  spaghettiPoints(e.pts, ORIGIN, UNIT_X, c.L, c.s, c.dist);
  ouroborosPoints(c.dist, c.L, c.mouth, c.fwd, c.side, c.loop);
  for (let i = 0; i < e.pts.length; i++) {
    const f = c.from[i], q = c.loop[i];
    e.pts[i].set(f.x + (q.x - f.x) * c.w, f.y + (q.y - f.y) * c.w, f.z + (q.z - f.z) * c.w);
  }
}

function finishCollapse(sys, e, now) {
  e.collapseFlash = 0;
  e.horizon = 0;
  e.collapse = null;
  // Before the park: the identity roll's unbind and module init loops run inside it.
  e.slurpedBy = null;
  e.state = 'offstage';
  setVisible(sys, e, false);
  // Off the rim before the park, whose roll refuses to redress a body still on stage.
  const d = Math.max(sys.view.w, sys.view.h) * 0.9 + e.length;
  teleport(e, Math.cos(e.parkAng) * d, Math.sin(e.parkAng) * d, e.parkAng + Math.PI);
  park(sys, e);
  rest(e, now);
  // main.js cuts the drone on this rather than fading it; the roll's reset leaves it alone on purpose.
  e.droneCut = true;
}

/* Registered by the guest attach. Runs every collapsing guest; a no-op for everyone else. */
export const collapseModule = {
  prepass(sys, dt) {
    for (const g of sys.guests) if (g.state === 'collapse' && g.collapse) collapseSelfTick(sys, g, dt);
  },
};

const SUN_WAKE = 0.5;   // heat per second on the way back up

/* Awake is 1. Asleep in the lair the suns cool to embers over three seconds and re-ignite over two. */
function sunHeat(e, dt) {
  const want = e.state === 'lair' && e.returnLeg >= 2 ? 0 : 1;
  const rate = want > e.sunHeat ? SUN_WAKE : 1 / 3;
  const step = rate * dt;
  e.sunHeat = want > e.sunHeat ? Math.min(want, e.sunHeat + step) : Math.max(want, e.sunHeat - step);
}

/* Every shared module reads gaits in body lengths, and at a resident's rate ten units of void crosses
   the pond in three seconds. Paced to the dial each tick; baseCruiseBL keeps the rolled rate. */
function pace(e, k) {
  if (e.baseCruiseBL == null) return;
  const c = Number.isFinite(k.samCruise) && k.samCruise > 0 ? k.samCruise : 0.8;
  e.cruiseBL = Math.min(e.baseCruiseBL, c / e.length);
  e.prowlBL = Math.min(e.baseProwlBL, e.cruiseBL * 0.6);
}

/* The sand he cannot wear: the solver's clearance and the crowns he steers around, both off one dial.
   Rebuilt only when that dial moves, since the mounds themselves are cast once at boot. */
function shoalGuard(sys, e, k) {
  const clear = Number.isFinite(k.samSandClear) && k.samSandClear >= 0 ? k.samSandClear : SAND_CLEAR;
  e.voidClear = clear;
  if (e.shoalAvoid && e.shoalClearAt === clear) return;
  e.shoalClearAt = clear;
  // His center rides at most one radius under the film, so sand raised past that stands inside him.
  const clearH = DEPTH - e.radius - clear - DUNE_MAX;
  // The crown keeps the mound's own ellipse and rotation: a long crest is given its length to steer
  // around while the approach across its narrow side stays open water.
  e.shoalAvoid = (sys.colliders.shoals ?? [])
    .map((s) => {
      const q = shoalAvoidFrac(s, clearH);
      return { x: s.x, z: s.z, rx: q * s.rx, rz: q * s.rz, cosR: s.cosR, sinR: s.sinR, r: q * Math.max(s.rx, s.rz) };
    })
    .filter((o) => o.r > AVOID_MIN && o.rx > 0 && o.rz > 0);
}

/* Eleanor leaves alarm; he leaves calm. A direct deposit into the cell under his head every half unit
   of travel, which is what buys longer holds and damped alarms in his wake. */
function calmTrail(sys, e, k) {
  const add = k.calm ?? 0;
  if (add <= ALARM_FREE || !e.body?.visible || !sys.fear?.dropCalm) return;
  if (e.calmX === undefined) { e.calmX = e.head.x; e.calmZ = e.head.z; return; }
  if (Math.hypot(e.head.x - e.calmX, e.head.z - e.calmZ) < CALM_STEP) return;
  e.calmX = e.head.x; e.calmZ = e.head.z;
  sys.fear.dropCalm(e.head.x, e.head.z, add);
}

/* The bow: a resident he passes over eases a little deeper and floats back up on its own steer. Written
   straight onto the head (pose overrides are too late, since a guest ticks after residents commit theirs). */
function bowStep(sys, e, dt, k) {
  const drop = k.bow ?? 0;
  const reach = k.bowReach ?? 0.5;
  // A bow is for him passing over; asleep in the log it would press his tail's nappers into the sand.
  if (drop <= 0 || reach <= 0 || !e.body?.visible || (e.state === 'lair' && e.returnLeg >= 2)) return;
  for (const r of sys.eels) {
    if (r.slurpedBy || r.tunnel) continue;
    if (nearSpine(e, r.head.x, r.head.z) > reach) continue;
    const want = Math.max(r.floorY, r.head.y - drop);
    if (want >= r.head.y) continue;
    r.head.y += (want - r.head.y) * Math.min(1, dt * 4);
  }
}

/* Stargazed: the spat eel rolls dizzy and sheds sun-orange specks for two seconds. The spine point is
   picked by count rather than by a draw, so nothing decorative ever touches a simulation generator. */
function stargaze(sys, e, p, now) {
  sys.stim?.rollStart(p, 'dizzy');
  e.sparkle = { p, until: now + STARGAZE_FOR, next: now, n: 0 };
}

function sparkStep(sys, e, now) {
  const s = e.sparkle;
  if (!s) return;
  if (now > s.until || s.n >= SPARKS) { e.sparkle = null; return; }
  if (now < s.next) return;
  s.next = now + STARGAZE_FOR / SPARKS;
  const pts = s.p.pts;
  const at = pts[Math.round(s.n * (pts.length - 1) / (SPARKS - 1))];
  s.n++;
  sys.effects?.spawn(at.x, at.y + 0.02, at.z, 'spark', { color: SUN_ORANGE });
}

/* Two body radii off the mouth, one and a half radii to the side of the bore axis, facing in. */
function holdPoint(e) {
  const l = e.lairWanted;
  if (!l) return { x: e.head.x, y: e.head.y, z: e.head.z };
  const ax = l.b.x - l.a.x, az = l.b.z - l.a.z;
  const len = Math.hypot(ax, az) || 1e-4;
  const dx = ax / len, dz = az / len;
  const near = hyp(l.a, e.head) <= hyp(l.b, e.head) ? l.a : l.b;
  const out = near === l.a ? -1 : 1;
  return {
    x: near.x + dx * out * e.radius * 2 - dz * e.radius * 1.5,
    y: near.y,
    z: near.z + dz * out * e.radius * 2 + dx * e.radius * 1.5,
  };
}

/* Boot only: the rolled guest takes a log the way Eleanor does, so ?guest=sam opens on him asleep in
   it whenever the seed laid down one he fits. False leaves the caller to park him offstage. */
export function enterSam(sys, e, now) {
  // At boot he was here first: a planned run is not a tenant yet, so only a body already in the bore loses him the log.
  const log = (e.lairs ?? []).find((l) => !sys.eels.some((r) => r.pts.some((p) => insideBore(p, l))));
  if (!log) return false;
  deriveLair(e, log);
  teleport(e, e.lairPoint.x, e.lairPoint.z, Math.atan2(e.lairDir.z, e.lairDir.x), e.lairPoint.y);
  e.state = 'lair';
  e.returnLeg = 2;
  e.leg = 1;
  e.napUntil = now + span(e, dial(sys).samNap, [120, 240], stayMul(sys));
  e.checkAt = now + 1;
  e.sunHeat = 0;
  return true;
}

/* Called by the guest attach once the build is his: both logs he fits are lair candidates. */
export function initSam(sys, e) {
  e.lairs = sys.colliders.logs.filter((l) => logFitsGuest(l, e.radius));
  // Before the modules' initEel: the fear, air, and brain modules read the policy from the first prepass.
  e.guestPolicy = buildGuestPolicy(e.identity);
  e.baseCruiseBL = e.cruiseBL;
  e.baseProwlBL = e.prowlBL;
  e.leg = 0;
  e.phase = null;
  e.napUntil = 0;
  e.roundsUntil = 0;
  e.roamX = 0; e.roamZ = 0;
  e.lairWanted = null;
  e.samCrumb = null;
  e.samCrumbAt = 0;
  e.deferAt = 0;
  e.sparkle = null;
  e.exitFlop = null;
  e.tailAt = null;
  // The run cooldown belongs to a visit: a Sam-to-Sam re-roll keeps the body and would inherit it.
  e.boreAt = -1e9;
  e.stageCap = 60;
  e.calmX = undefined;
  e.slurpDir = { x: 1, y: 0, z: 0 };
  // Rebuilt on the first tick: the crowns he must steer around are a function of the radius he just rolled.
  e.shoalAvoid = null;
  e.shoalClearAt = null;
  if (sys.knobs.guest) sys.knobs.guest.samSandClear ??= SAND_CLEAR;
}
