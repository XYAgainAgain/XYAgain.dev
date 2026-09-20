import { DEPTH } from './config.js';
import { paceWave } from './eel-behavior.js';
import { growEel } from './eel-physics.js';
import {
  SLURP_AT, begin, capture, deriveLair, exitTarget, moveGuest, nopeTick, onStage, park, parkOffstage,
  pickExit, progressStrike, rescueLadder, resetProgress, rest, setExit, setVisible, spit, teleport,
} from './guest-stage.js';
import { insideBore, logFitsGuest, logTaken, spaghettiPoints } from './sam-eel-core.js';
import { shoalAvoidFrac } from './reeds-core.js';

/* Sam the Space Eel, wave one: the controller behind the void. He rides Eleanor's stage and repossession
   trigger, shares none of her temper (zero threat, calm not alarm, patience for a log instead of taking
   it), and the singularity opens only for a repossession. The tunnel run, sweep, treats, tail perch, body
   vacuum, and self-swallow are wave two; this pass has no steerGuest adapter, just local targets. */

const SUN_ORANGE = [1.0, 0.55, 0.18];
const STRETCH = 1.2;        // how far past its own length a swallowed body is drawn out toward the horizon
const HORIZON_SLURP = 1.2;  // the meal scale the renderer eases the mouth open to, in body radii
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

export function brain(sys, e, dt) {
  const now = sys.time;
  const k = dial(sys);
  // Zero in every state, so threatOf returns 0, guestAlarm deposits nothing, and no fear map ever
  // learns him. The presence writer in eel-fear.js is what residents actually steer around.
  e.threat = 0;
  e.threatOn = null;
  shoalGuard(sys, e, k);
  // The mouth belongs to the meal: any seam that ends a capture early (a surrender, a hot pond) has
  // to leave a closed horizon behind it, and this is cheaper than remembering every one of them.
  if (e.state !== 'collect') e.horizon = 0;
  // Only the log residents can reach is expressible to them, so a nap in the second log berths nobody.
  const home = e.state === 'lair' && e.lair === sys.colliders.logs[0];
  sys.lairGuest = home ? e : null;
  sunHeat(e, dt);
  calmTrail(sys, e, k);
  bowStep(sys, e, dt, k);
  sparkStep(sys, e, now);
  if (sys.perfHot) e.coolAt = now + 10;

  if (e.state === 'lair' && e.returnLeg >= 2) { restTick(sys, e, dt, now); return; }
  if (e.state === 'offstage') { offstageTick(sys, e, dt, now); return; }

  if (rescueLadder(sys, e, now, capFor(sys, e.stageCap ?? 45))) return;
  if (nopeTick(sys, e, dt, now)) return;
  // A meal in progress finishes before any performance retreat; the whole capture caps under 4 s.
  if (sys.perfHot && e.state !== 'depart' && !(e.state === 'collect' && e.phase !== 'approach')) toDepart(sys, e, now);

  e.reverse = false;
  // Gaits are in body lengths, and ten units of eel at a resident's cruise crosses the pond in three
  // seconds; his pace is a world speed, so it reads the same whatever length he rolled.
  const cruise = Math.min(e.cruiseBL, (k.samCruise ?? 0.8) / e.length), prowl = Math.min(e.prowlBL, cruise * 0.6);
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
    if (roundsTick(sys, e, now, k)) return;
    tx = e.roamX; tz = e.roamZ;
  }

  // Read after the fold, not before: a fold that arrived this tick hands the walls back to avoidance.
  const inBore = !!e.exiting || (e.state === 'lair' && e.returnLeg === 1);
  moveGuest(sys, e, dt, now, tx, tz, ty, wantBL, { inBore, homing, shoals: e.shoalAvoid });
  if (progressStrike(e, dt)) {
    if (e.stuckStrikes >= 2) {
      e.stuckStrikes = 0;
      if (e.forceParkAt !== null) parkOffstage(sys, e, now);
      else toRounds(sys, e, now);
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
  // A hot pond empties even the lair, and he goes quietly.
  if (sys.perfHot) { wake(sys, e, now); toDepart(sys, e, now); return; }
  if (now > e.napUntil) { wake(sys, e, now); toRounds(sys, e, now); }
}

/* A rounds leg: wander the open water, look in on the log, and take the one repossession the pond
   actually needs. Returns true when the tick has been handed to another state. */
function roundsTick(sys, e, now, k) {
  if (now > e.retargetAt) {
    e.retargetAt = now + e.rng.range(6, 12);
    e.roamX = e.rng.range(-sys.view.w * 0.35, sys.view.w * 0.35);
    e.roamZ = e.rng.range(-sys.view.h * 0.35, sys.view.h * 0.35);
  }
  if (now <= e.checkAt) return false;
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
  setExit(e, pickExit(sys, e));   // silent for him: the stage reads his startle policy
  e.stateAt = now;
}

// The two plain fields the renderer reads, and the deference the residents feel

/* Awake is 1. Asleep in the lair the suns cool to embers over three seconds and re-ignite over two. */
function sunHeat(e, dt) {
  const want = e.state === 'lair' && e.returnLeg >= 2 ? 0 : 1;
  const rate = want > e.sunHeat ? 0.5 : 1 / 3;
  const step = rate * dt;
  e.sunHeat = want > e.sunHeat ? Math.min(want, e.sunHeat + step) : Math.max(want, e.sunHeat - step);
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
  if (drop <= 0 || reach <= 0 || !e.body?.visible) return;
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
  e.leg = 0;
  e.phase = null;
  e.napUntil = 0;
  e.roundsUntil = 0;
  e.roamX = 0; e.roamZ = 0;
  e.lairWanted = null;
  e.sparkle = null;
  e.stageCap = 60;
  e.calmX = undefined;
  e.slurpDir = { x: 1, y: 0, z: 0 };
  // Rebuilt on the first tick: the crowns he must steer around are a function of the radius he just rolled.
  e.shoalAvoid = null;
  e.shoalClearAt = null;
  if (sys.knobs.guest) sys.knobs.guest.samSandClear ??= SAND_CLEAR;
}
