import { DEPTH } from './config.js';
import { paceWave } from './eel-behavior.js';
import { pushTrail, retreatAlongTrail, growEel } from './eel-physics.js';

/* The guest stage: what both guests share to get on and off it, parking, the teleport, the lair's three
   exits, the stuck-rescue ladder, visibility, and the capture/spit a repossession runs through. Eleanor
   and Sam each add their own controller on top. The stage reads only one thing off the identity: Eleanor's
   exits are gravelly, his are silent, and no stage-owned site may emit without asking. */

export const SLURP_AT = 7;        // residents longer than this get repossessed segment by segment
export const PROG_WINDOW = 0.5;   // stuck is judged over this window, never tick to tick
export const REV_JAM = 1;         // seconds of motionless head before a backing-out fold gets help
export const REV_TRAIL = 6;       // retreatAlongTrail starves at 4; below this the path cannot feed a reverse

export function startle(sys, e) {
  if (e.identity?.startle === false) return;
  sys.emit('startle', e);
}

/* The renderer owns the whole bundle: body, halo or nebula, eyes, coronas, jelly depth, singularity. */
export function setVisible(sys, e, v) {
  if (e.body) sys.renderer.setVisible(e, v);
}

/* Every exit change clears the reverse-jam watch with it, so a fresh fold never inherits the last one's strikes. */
export function setExit(e, mode) {
  e.exiting = mode;
  e.exitFor = 0;
  e.revJam = 0;
  e.revNudged = false;
  e.revPush = 0;
  e.revX = e.head.x; e.revZ = e.head.z;
}

/* Any spine point inside the view plus the hot-swap margin: the test for whether a chain move would be seen. */
export function onStage(sys, e) {
  const hw = sys.view.w * 0.5 + e.radius * 2.5, hh = sys.view.h * 0.5 + e.radius * 2.5;
  for (const p of e.pts) if (Math.abs(p.x) <= hw && Math.abs(p.z) <= hh) return true;
  return false;
}

export function resetProgress(e) {
  e.stuckFor = 0;
  e.progT = 0;
  e.progX = e.head.x; e.progZ = e.head.z;
}

/* Full-chain move: pose, history, and collision memory all reset so the body arrives already laid out. */
export function teleport(e, x, z, ang, y = -DEPTH + e.radius + 0.1) {
  const cx = Math.cos(ang), cz = Math.sin(ang);
  for (let i = 0; i < e.pts.length; i++) {
    e.pts[i].set(x - cx * i * e.spacing, y, z - cz * i * e.spacing);
    e.prev[i].copy(e.pts[i]);
    e.pose0[i].copy(e.pts[i]);
    e.show[i].copy(e.pts[i]);
    e.offsets[i].set(0, 0, 0);
  }
  e.trailHead = 0;
  e.trailCount = 0;
  for (let i = e.pts.length - 1; i >= 0; i--) pushTrail(e, e.pts[i]);
  e.heading.set(cx, 0, cz);
  e.targetY = y;
}

/* The park is where the next visit's identity is rolled, because it is the one moment the body is
   guaranteed to be off frame and hidden. e.onPark is the attach's hook; attach itself has none yet. */
export function park(sys, e) {
  if (sys.debug && e.body?.visible && onStage(sys, e)) console.warn(`[guest] parked from on stage in ${e.state} (t=${sys.time.toFixed(2)})`);
  e.onPark?.(sys, e);
  e.parkAng = e.rng.range(0, Math.PI * 2);
  setExit(e, null);
  e.nopePulse = 0;
  const d = Math.max(sys.view.w, sys.view.h) * 0.9 + e.length;
  teleport(e, Math.cos(e.parkAng) * d, Math.sin(e.parkAng) * d, e.parkAng + Math.PI);
}

/* Only ever called when a guest leaves the log; the exit's startle rides along here, silent for
   whichever guest's stage policy refuses it. */
export function pickExit(sys, e) {
  startle(sys, e);
  return e.rng.chance(0.4) ? 'turn' : e.rng.chance(0.58) ? 'reverse' : 'ahead';
}

export function begin(sys, e, state, now) {
  e.state = state;
  e.stateAt = now;
  e.forceParkAt = null;
  e.rescued = false;
  e.stuckStrikes = 0;
  resetProgress(e);
  setVisible(sys, e, true);
}

/* The surrender: spit anything held (never park with someone in the jaws), swim off, rest a while.
   Both the visit-cap ladder and the give-up end here. A hard park is the teleport a viewer sees,
   so on stage it becomes a depart; the park itself waits until the body is off frame or overdue. */
export function parkOffstage(sys, e, now) {
  if (e.prey && e.prey.slurpedBy === e) spit(sys, e, now, { growPredator: e.identity?.growsOnSlurp !== false });
  e.prey = null;
  e.rescued = false;
  e.homeFails = 0;
  if (onStage(sys, e) && now < (e.forceParkAt ?? Infinity)) {
    rest(e, now);
    if (e.forceParkAt === null) e.forceParkAt = now + 15;
    e.parkAng = Math.atan2(e.head.z, e.head.x);   // straight out the nearest rim, not across the pond
    e.state = 'depart'; e.stateAt = now;
    e.stuckStrikes = 0;
    resetProgress(e);
    setExit(e, null);
    return;
  }
  e.forceParkAt = null;
  e.state = 'offstage';
  park(sys, e);
  // After the park, never before it: the identity roll inside park() wipes both clocks, and a guest
  // that parked with no cooldown left walks straight back on stage.
  rest(e, now);
  setVisible(sys, e, false);
}

/* The gap before the next visit. Without the coolAt the next tick picked a fresh one: hunt and graze
   read nothing else. */
export function rest(e, now) {
  e.nextSwimBy = now + e.rng.range(40, 80);
  e.coolAt = Math.max(e.coolAt, now + e.rng.range(40, 80));
}

/* The visit cap's two rungs: nope backward down the guest's own path first, the hard park second.
   True means the guest has been parked and the caller's tick is over. */
export function rescueLadder(sys, e, now, cap) {
  if (now - e.stateAt <= cap + 20) return false;
  if (!e.rescued) {
    e.rescued = true;
    e.stateAt = now - cap - 10;
    e.nopePulse = now + 1.4;
    startle(sys, e);
    return false;
  }
  parkOffstage(sys, e, now);
  return true;
}

/* The nope pulse itself: a retreat down the trail that owns the tick while it runs. */
export function nopeTick(sys, e, dt, now) {
  if (now >= e.nopePulse) return false;
  e.reverse = true;
  e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 8);
  paceWave(e, dt, false);
  retreatAlongTrail(e, (sys.motion.reduced ? 0.175 : 0.5) * e.length * dt);
  return true;
}

/* Three ways out of the lair: fold around inside like proper water pasta and leave the way it came,
   back out tail-first down its own path, or carry on out the far mouth: 'done', a target, or null. */
export function exitTarget(sys, e, dt, now) {
  if (e.exiting === 'reverse') {
    e.reverse = true;
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 8);
    paceWave(e, dt, false);
    // The jam shove is spent over 0.2 s at the retreat's own pace; as one pop it moved the snout 0.1 L in a tick.
    if (now < e.revPush) e.head.addScaledVector(e.heading, e.length * 0.5 * dt);
    else retreatAlongTrail(e, (sys.motion.reduced ? 0.175 : 0.5) * e.length * dt);
    const behind = (e.head.x - e.lair.a.x) * e.lairDir.x + (e.head.z - e.lair.a.z) * e.lairDir.z;
    if (behind < -0.8) { setExit(e, null); return 'done'; }
    // A reverse eats the path it walks, so it can jam on the bore or simply run out of history. One
    // shove deeper buys fresh trail to back down; after that the fold is the only way out.
    if (e.trailCount <= REV_TRAIL) { setExit(e, 'turn'); return 'done'; }
    if (Math.hypot(e.head.x - e.revX, e.head.z - e.revZ) > e.radius * 0.5) {
      e.revJam = 0; e.revX = e.head.x; e.revZ = e.head.z;
    } else if ((e.revJam += dt) > REV_JAM) {
      if (e.revNudged) { setExit(e, 'turn'); return 'done'; }
      e.revPush = now + 0.2;
      e.revJam = 0; e.revNudged = true;
    }
    return 'done';
  }
  if (!e.exiting) return null;
  const p = e.exiting === 'turn' ? e.lairApproach : e.lairExit;
  // The fold runs with avoidance and the stuck watch both off, so a jam is steered only by collision;
  // 2 s without arriving demotes it to the far-mouth exit (never reverse: a spent trail flips that back to turn).
  e.exitFor += dt;
  if (e.exiting === 'turn' && e.exitFor > 2) setExit(e, 'ahead');
  if (Math.hypot(p.x - e.head.x, p.z - e.head.z) < 0.8) setExit(e, null);
  return { x: p.x, z: p.z, y: e.lairPoint.y };
}

/* Obstacle push, written into the module scratch so the steering loops allocate nothing. Squared
   falloff keeps the far field a hint; the tangent is what saves a head-on, where radial alone cancels. */
let avoidX = 0, avoidZ = 0;
const NO_SHOALS = [];
export function avoid(e, dx, dz, d, reach) {
  const f = 1 - d / reach, k = f * f * 2.2;
  avoidX = (dx / d) * k; avoidZ = (dz / d) * k;
  const ahead = (-dx * e.heading.x - dz * e.heading.z) / d;
  if (ahead <= 0) return;
  const sx = -e.heading.z, sz = e.heading.x;
  const kt = k * ahead * 1.4 * (dx * sx + dz * sz >= 0 ? 1 : -1);   // slide toward the flank it is not on
  avoidX += sx * kt; avoidZ += sz * kt;
}

/* The one heading solve and pose commit a guest tick gets. A guest has the residents' sense of
   obstacles scaled to its bulk; grinding on scenery is beneath it, except mid-bore where the run
   needs the walls to do the steering. `homing` exempts the guest's own lair from the shove. */
export function moveGuest(sys, e, dt, now, tx, tz, ty, wantBL, opts = null) {
  const head = e.head;
  let ax = tx - head.x, az = tz - head.z;
  const al = Math.hypot(ax, az) || 1e-4;
  ax /= al; az /= al;
  const inBore = !!opts?.inBore;
  const homing = opts?.homing ?? null;
  if (!inBore) {
    // Reach is the turning radius at this speed, not a fixed collar: eight units of eel has to start
    // the sweep long before the snout arrives, or the turn finishes somewhere inside the rock.
    const look = 0.9 + e.radius * 2 + Math.min(2.4, e.speedBL * e.length / Math.max(0.8, e.turnRate));
    for (const o of sys.colliders.spheres) {
      const dx = head.x - o.x, dz = head.z - o.z;
      const d = Math.hypot(dx, dz), reach = (o.rHit ?? o.r) + look;
      if (d < reach && d > 1e-4) { avoid(e, dx, dz, d, reach); ax += avoidX; az += avoidZ; }
    }
    for (const l of sys.colliders.logs) {
      if (homing && l === homing) continue;
      const abx = l.b.x - l.a.x, abz = l.b.z - l.a.z;
      const tp = Math.max(0, Math.min(1, ((head.x - l.a.x) * abx + (head.z - l.a.z) * abz) / (abx * abx + abz * abz)));
      const nx = l.a.x + abx * tp, nz = l.a.z + abz * tp;
      const dx = head.x - nx, dz = head.z - nz;
      const d = Math.hypot(dx, dz), reach = l.rOuter + look;
      if (d < reach && d > 1e-4) { avoid(e, dx, dz, d, reach); ax += avoidX; az += avoidZ; }
    }
    // Sand the guest cannot swim over without wearing it. Only the crown of such a mound is in the
    // list, so the low shoals stay open water and a tall crest is a rock like any other.
    for (const o of opts?.shoals ?? NO_SHOALS) {
      const dx = head.x - o.x, dz = head.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d <= 1e-4) continue;
      // A crown is an oriented ellipse, so the exclusion radius is its edge along this bearing: the
      // long axis is given its full width and the crossing over the narrow side is not blocked for it.
      const u = dx * o.cosR - dz * o.sinR, w = dx * o.sinR + dz * o.cosR;
      const q = Math.hypot(u / o.rx, w / o.rz);
      const reach = (q > 1e-6 ? d / q : o.r) + look;
      if (d < reach) { avoid(e, dx, dz, d, reach); ax += avoidX; az += avoidZ; }
    }
  }

  let diff = Math.atan2(az, ax) - Math.atan2(e.heading.z, e.heading.x);
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  // Slow = supple: near-stationary a guest can hairpin inside its own bore; the exit fold leans on this.
  const supple = (1.6 - 0.6 * Math.min(1, e.speedBL / e.cruiseBL)) * (e.exiting === 'turn' ? 4 : 1);
  const maxTurn = e.turnRate * supple * dt;
  const yaw = Math.max(-maxTurn, Math.min(maxTurn, diff * Math.min(1, dt * 5)));
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  e.heading.set(e.heading.x * c - e.heading.z * sn, 0, e.heading.x * sn + e.heading.z * c).normalize();

  wantBL *= sys.motion.reduced ? 0.35 : 1;
  e.speedBL += Math.max(-0.5 * dt, Math.min(0.5 * dt, wantBL - e.speedBL));
  const speed = e.speedBL * e.length;
  const f = paceWave(e, dt, false);
  const wob = Math.cos(e.wavePhase) * e.ampTail * 0.2 * e.anterior * Math.PI * 2 * f * dt;
  head.addScaledVector(e.heading, speed * dt);
  head.x += -e.heading.z * wob;
  head.z += e.heading.x * wob;
  e.targetY = ty;
  head.y += (e.targetY - head.y) * Math.min(1, dt * 0.6);

  // A guest's back barely fits under the surface; riding high plows a wake through the sim for free.
  if (head.y > -e.radius * 1.2 && now > e.rippleAt && !sys.motion.reduced) {
    e.rippleAt = now + 0.22;
    sys.sim.addDrop(head.x, head.z, 0.7 + e.radius, 0.014 * speed);
    if (now > (e.bubSoundAt ?? 0)) { e.bubSoundAt = now + e.rng.range(1.2, 2.4); sys.emit('nibble', e); }
  }
  return speed;
}

/* Stuck: commanded speed and no ground covered over a window. Per tick, a body this size reads every
   scrape along a log as a jam; the caller's ladder decides what two bad windows mean. */
export function progressStrike(e, dt) {
  const head = e.head;
  const cmd = e.speedBL * e.length;
  if (cmd > 0.5 && !e.exiting) {
    e.progT += dt;
    if (e.progT < PROG_WINDOW) return false;
    const moved = Math.hypot(head.x - e.progX, head.z - e.progZ);
    if (moved < cmd * e.progT * 0.3) e.stuckFor += e.progT; else e.stuckFor = 0;
    e.progT = 0; e.progX = head.x; e.progZ = head.z;
    if (e.stuckFor > PROG_WINDOW * 2) { e.stuckFor = 0; e.stuckStrikes++; return true; }
    return false;
  }
  e.progT = 0; e.progX = head.x; e.progZ = head.z;
  e.stuckFor = Math.max(0, e.stuckFor - dt * 2);
  return false;
}

/* The jaws closing, shared so only the witness effect tells the two guests apart: F1 writes a
   two-minute fear spike under the predator's name without ever reading e.threat, so a calm
   repossession has to turn it off here rather than by being unfrightening. */
export function capture(sys, e, p, now, opts = null) {
  p.slurpedBy = e;
  // The slurp owns the pose from here: no air exemption may outlive the jaws closing on it.
  sys.air?.cancel(p);
  e.slurpT = 0;
  begin(sys, e, opts?.state ?? 'slurp', now);
  if (opts?.witness !== false) sys.fear?.witnessSlurp(sys, e, p);
  sys.emit('slurp', e);
}

/* Spat back at base length, fast and fleeing for a second. The void gains nothing from a meal, so the
   growth is the predator's own dial rather than part of the act. */
export function spit(sys, e, now, opts = null) {
  const p = e.prey;
  e.prey = null;
  if (!p) return null;
  const off = opts?.offset ?? 0.5;
  teleport(p, e.head.x + e.heading.x * off, e.head.z + e.heading.z * off, Math.atan2(e.heading.z, e.heading.x), Math.max(-DEPTH + p.radius + 0.1, e.head.y));
  p.slurpedBy = null;
  // Bounds back from the current radius, after the chain reset above.
  sys.air?.restore(p);
  p.speedMul = 2.2;
  p.speedBL = p.cruiseBL;
  p.fleeUntil = now + 1;
  setVisible(sys, p, true);
  if (opts?.growPredator) growEel(e, 0.5);
  return p;
}

/* Every controller-owned field on the guest body, in one place so a swap cannot miss one. The body
   outlives both identities, so anything a controller wrote has to be wiped before the other takes it. */
export function resetGuest(e) {
  e.state = 'offstage';
  e.checkAt = 0;
  e.stateAt = 0;
  e.coolAt = 0;
  e.forceParkAt = null;
  e.revPush = 0;
  e.nopePulse = 0;
  e.rescued = false;
  e.stuckStrikes = 0;
  e.homeFails = 0;
  e.prey = null;
  e.zoomAt = 0;
  // The void body's sand rules, or the next identity to wear this body would inherit them.
  e.voidClear = 0;
  e.shoalAvoid = null;
  e.threat = 0;
  e.threatOn = null;
  e.table = null;
  e.lair = null;
  e.lairs = null;
  e.lairDir = null; e.lairPoint = null; e.lairApproach = null; e.lairExit = null;
  e.returnLeg = 0;
  e.nextSwimBy = 0;
  e.slurpT = 0;
  e.exitStyle = 'swim';
  e.tunnel = null;
  e.food = null;
  e.coverSpot = null;
  e.reverse = false;
  e.rippleAt = 0;
  e.bubSoundAt = 0;
  e.speedBL = e.prowlBL;
  e.speedMul = 1;
  e.fleeUntil = 0;
  e.ampMul = 1;
  e.uExcite && (e.uExcite.value = 0);
  // The render contract's two plain fields. Neutral is awake with no mouth open, which is what
  // Eleanor's ticks leave behind forever.
  e.sunHeat = 1;
  e.horizon = 0;
  e.tailSpeed = 0;
  // park() re-rolls this per park, but a first depart-from-lair reads it first: undefined here fed
  // cos/sin a NaN that poisoned the whole chain until the stuck rescue finally parked her.
  e.parkAng = e.rng.range(0, Math.PI * 2);
  setExit(e, null);
  resetProgress(e);
}

/* The lair and every vector derived from it. Radius decides the fit, so this is redone on every swap. */
export function deriveLair(e, log) {
  e.lair = log ?? null;
  if (!e.lair) { e.lairDir = e.lairPoint = e.lairApproach = e.lairExit = null; return null; }
  const ax = e.lair.b.x - e.lair.a.x, az = e.lair.b.z - e.lair.a.z;
  const len = Math.hypot(ax, az) || 1e-4;
  e.lairDir = { x: ax / len, z: az / len };
  // A body shorter than the bore would vanish into it, so the head stops where the tail third still hangs out of mouth a.
  const inset = Math.max(0.6, len - e.length * 0.67);
  e.lairPoint = { x: e.lair.b.x - e.lairDir.x * inset, y: e.lair.b.y, z: e.lair.b.z - e.lairDir.z * inset };
  e.lairApproach = { x: e.lair.a.x - e.lairDir.x * 2.0, y: e.lair.a.y, z: e.lair.a.z - e.lairDir.z * 2.0 };
  e.lairExit = { x: e.lair.b.x + e.lairDir.x * 2.0, y: e.lair.b.y, z: e.lair.b.z + e.lairDir.z * 2.0 };
  return e.lair;
}
