import { DEPTH } from './config.js';
import { Eel } from './eels.js';
import { IDENTITIES } from './eel-identity.js';
import { paceWave } from './eel-behavior.js';
import { pushTrail, retreatAlongTrail, growEel } from './eel-physics.js';

/* Eleanor, the mega-eel guest. Home is a log lair when the pond rolls a bore she fits (grand logs,
   mostly), otherwise offstage. She answers feed sprees, takes the odd swim-by so a watch session
   always glimpses her, hunts anyone who dares approach her size, and stands down when the pond
   runs hot: she is the pond's biggest cost and she knows it. */

const FEED_WORTH = 4;   // recent feed-spree total that makes the trip worthwhile
const VISIT_CAP = 30;   // seconds before she loses interest in an outing
const SLURP_AT = 7;     // residents longer than this get repossessed segment by segment
const ZOOM_EVERY = 0.7; // seconds between evasive re-aims for a zoomies prey
const ZOOM_JITTER = 40 * Math.PI / 180;
const SLIP = 0.5;         // rock and log pushes on her snout, halved: she is far too strong to be held by bark
const REV_JAM = 1;        // seconds of motionless head before a backing-out fold gets help
const REV_TRAIL = 6;      // retreatAlongTrail starves at 4; below this the path can no longer feed a reverse
const PROG_WINDOW = 0.5;  // stuck is judged over this window, never tick to tick

export function attachEleanor(sys, seed) {
  const id = IDENTITIES.find((i) => i.name === 'Eleanor');
  const e = new Eel(6, seed, sys.extent, sys.colliders, sys.view, id);
  e.brain = brain;
  e.checkAt = 0;
  e.stateAt = 0;
  e.coolAt = 0;
  e.nopePulse = 0;
  e.rescued = false;
  e.stuckStrikes = 0;
  e.prey = null;
  e.zoomAt = 0;
  e.slip = SLIP;
  // park() re-rolls this per park, but a first depart-from-lair reads it first: undefined here fed
  // cos/sin a NaN that poisoned her whole chain until the stuck rescue finally parked her.
  e.parkAng = e.rng.range(0, Math.PI * 2);
  setExit(e, null);
  resetProgress(e);
  const log = sys.colliders.logs[0];
  // Lair test is stricter than the passage fit: she wants a den, not a squeeze.
  e.lair = log && log.rInner >= e.radius * 1.6 ? log : null;
  if (e.lair) {
    const ax = e.lair.b.x - e.lair.a.x, az = e.lair.b.z - e.lair.a.z;
    const len = Math.hypot(ax, az);
    e.lairDir = { x: ax / len, z: az / len };
    e.lairPoint = { x: e.lair.b.x - e.lairDir.x * 0.6, y: e.lair.b.y, z: e.lair.b.z - e.lairDir.z * 0.6 };
    e.lairApproach = { x: e.lair.a.x - e.lairDir.x * 2.0, y: e.lair.a.y, z: e.lair.a.z - e.lairDir.z * 2.0 };
    e.lairExit = { x: e.lair.b.x + e.lairDir.x * 2.0, y: e.lair.b.y, z: e.lair.b.z + e.lairDir.z * 2.0 };
    teleport(e, e.lairPoint.x, e.lairPoint.z, Math.atan2(e.lairDir.z, e.lairDir.x), e.lairPoint.y);
    e.state = 'lair';
  } else {
    park(sys, e);
    e.state = 'offstage';
  }
  e.nextSwimBy = e.rng.range(30, 60);
  sys.renderer.buildMesh(e);
  setVisible(e, e.state === 'lair');
  sys.guests.push(e);
  // Late bond resolution: residents whose crush names her (Josh) acquire her as a partner now.
  for (const r of sys.eels) if (!r.partner && r.quirks.follows === e.name) r.partner = e;
  return e;
}

function setVisible(e, v) {
  if (!e.body) return;
  e.body.visible = e.halo.visible = v;
  e.eyes.forEach((m) => { m.visible = v; });
}

/* Every exit change clears the reverse-jam watch with it, so a fresh fold never inherits the last one's strikes. */
function setExit(e, mode) {
  e.exiting = mode;
  e.revJam = 0;
  e.revNudged = false;
  e.revX = e.head.x; e.revZ = e.head.z;
}

function resetProgress(e) {
  e.stuckFor = 0;
  e.progT = 0;
  e.progX = e.head.x; e.progZ = e.head.z;
}

function park(sys, e) {
  e.parkAng = e.rng.range(0, Math.PI * 2);
  setExit(e, null);
  e.nopePulse = 0;
  const d = Math.max(sys.view.w, sys.view.h) * 0.9 + e.length;
  teleport(e, Math.cos(e.parkAng) * d, Math.sin(e.parkAng) * d, e.parkAng + Math.PI);
}

/* Full-chain move: pose, history, and collision memory all reset so the body arrives already laid out. */
function teleport(e, x, z, ang, y = -DEPTH + e.radius + 0.1) {
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

/* Only ever called when she leaves the log, so the gravelly startle rides along here. */
function pickExit(sys, e) {
  sys.emit('startle', e);
  return e.rng.chance(0.4) ? 'turn' : e.rng.chance(0.58) ? 'reverse' : 'ahead';
}

function begin(e, state, now) {
  e.state = state;
  e.stateAt = now;
  e.rescued = false;
  e.stuckStrikes = 0;
  resetProgress(e);
  setVisible(e, true);
}

function goHome(sys, e, now) {
  e.stateAt = now;
  e.rescued = false;
  e.stuckStrikes = 0;
  resetProgress(e);
  if (e.lair && !sys.perfHot) { e.state = 'return'; e.returnLeg = 0; }
  else e.state = 'depart';
}

/* Obstacle push, written into the module scratch so the steering loops allocate nothing. Squared
   falloff keeps the far field a hint; the tangent is what saves a head-on, where radial alone cancels. */
let avoidX = 0, avoidZ = 0;
function avoid(e, dx, dz, d, reach) {
  const f = 1 - d / reach, k = f * f * 2.2;
  avoidX = (dx / d) * k; avoidZ = (dz / d) * k;
  const ahead = (-dx * e.heading.x - dz * e.heading.z) / d;
  if (ahead <= 0) return;
  const sx = -e.heading.z, sz = e.heading.x;
  const kt = k * ahead * 1.4 * (dx * sx + dz * sz >= 0 ? 1 : -1);   // slide toward the flank it is not on
  avoidX += sx * kt; avoidZ += sz * kt;
}

function brain(sys, e, dt) {
  const now = sys.time;
  sys.lairGuest = e.lair && (e.state === 'lair' || e.state === 'return') ? e : null;
  if (sys.perfHot) e.coolAt = now + 10;

  if (e.state === 'lair' || e.state === 'offstage') {
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 4);
    paceWave(e, dt, true);
    if (now > e.checkAt) {
      e.checkAt = now + 1;
      const fromLair = e.state === 'lair';
      // A hot pond empties even the lair; otherwise: repossessions first, then dinner, then a lap.
      if (fromLair && sys.perfHot) { begin(e, 'depart', now); setExit(e, pickExit(sys, e)); return; }
      if (!sys.perfHot) {
        const gnarly = sys.eels.filter((r) => r.length > SLURP_AT && !r.slurpedBy);
        if (gnarly.length) {
          gnarly.sort((a, b) => b.length - a.length);
          e.prey = gnarly[0];
          begin(e, 'hunt', now);
          setExit(e, fromLair ? pickExit(sys, e) : null);
        } else if (sys.feedRecent >= FEED_WORTH) {
          sys.feedRecent = 0;
          begin(e, 'graze', now);
          setExit(e, fromLair ? pickExit(sys, e) : null);
        } else if (now > e.nextSwimBy) {
          begin(e, 'swimby', now);
          setExit(e, fromLair ? pickExit(sys, e) : null);
          e.swimbyX = e.rng.range(-sys.view.w * 0.35, sys.view.w * 0.35);
          e.swimbyZ = e.rng.range(-sys.view.h * 0.35, sys.view.h * 0.35);
        } else if (e.state === 'offstage' && e.lair && now > e.coolAt) {
          begin(e, 'return', now);
          e.returnLeg = 0;
        }
      }
    }
    return;
  }

  // Stuck rescue ladder: nope backward down her own path first; the hard park is the last resort.
  if (now - e.stateAt > VISIT_CAP + 20) {
    if (!e.rescued) { e.rescued = true; e.stateAt = now - VISIT_CAP - 10; e.nopePulse = now + 1.4; sys.emit('startle', e); }
    else {
      // Never park with someone in her jaws: any abandoned meal gets spat before she vanishes.
      if (e.prey && e.prey.slurpedBy === e) spit(sys, e, now);
      e.prey = null;
      e.state = 'offstage';
      park(sys, e);
      setVisible(e, false);
      e.rescued = false;
      e.nextSwimBy = now + e.rng.range(40, 80);
      return;
    }
  }
  if (now < e.nopePulse) {
    e.reverse = true;
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 8);
    paceWave(e, dt, false);
    retreatAlongTrail(e, (sys.motion.reduced ? 0.175 : 0.5) * e.length * dt);
    return;
  }
  // A meal in progress finishes before any performance retreat; slurp plus wriggle caps under 4 s.
  if (sys.perfHot && e.state !== 'depart' && e.state !== 'slurp' && e.state !== 'wriggle') { e.state = 'depart'; e.stateAt = now; }

  if (e.state === 'slurp') { slurpTick(sys, e, dt, now); return; }
  if (e.state === 'wriggle') {
    e.reverse = false;
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 6);
    paceWave(e, dt, false);
    e.wavePhase += Math.PI * 2 * 2.5 * dt;   // the victory shimmy runs hotter than her actual beat
    e.uExcite.value += (1 - e.uExcite.value) * Math.min(1, dt * 4);
    if (now - e.stateAt > 1.2) { spit(sys, e, now); goHome(sys, e, now); }
    return;
  }

  e.reverse = false;
  let tx = 0, tz = 0, ty = -DEPTH + e.radius + 0.1, wantBL = e.cruiseBL;
  // Three ways out of the lair: fold around inside like proper water pasta and leave the way she
  // came, back out tail-first down her own entry path, or just carry on out the far mouth.
  if (e.exiting === 'reverse') {
    e.reverse = true;
    e.speedBL += (0 - e.speedBL) * Math.min(1, dt * 8);
    paceWave(e, dt, false);
    retreatAlongTrail(e, (sys.motion.reduced ? 0.175 : 0.5) * e.length * dt);
    const behind = (e.head.x - e.lair.a.x) * e.lairDir.x + (e.head.z - e.lair.a.z) * e.lairDir.z;
    if (behind < -0.8) { setExit(e, null); return; }
    // A reverse eats the path it walks, so it can jam on the bore or simply run out of history. One
    // shove deeper buys fresh trail to back down; after that the fold is the only way out.
    if (e.trailCount <= REV_TRAIL) { setExit(e, 'turn'); return; }
    if (Math.hypot(e.head.x - e.revX, e.head.z - e.revZ) > e.radius * 0.5) {
      e.revJam = 0; e.revX = e.head.x; e.revZ = e.head.z;
    } else if ((e.revJam += dt) > REV_JAM) {
      if (e.revNudged) { setExit(e, 'turn'); return; }
      e.head.addScaledVector(e.heading, e.length * 0.1);
      e.revJam = 0; e.revNudged = true; e.revX = e.head.x; e.revZ = e.head.z;
    }
    return;
  }
  if (e.exiting) {
    const p = e.exiting === 'turn' ? e.lairApproach : e.lairExit;
    tx = p.x; tz = p.z; ty = e.lairPoint.y; wantBL = e.prowlBL;
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < 0.8) setExit(e, null);
  } else if (e.state === 'depart') {
    const d = Math.max(sys.view.w, sys.view.h) * 0.9 + e.length;
    tx = Math.cos(e.parkAng) * d; tz = Math.sin(e.parkAng) * d;
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < 1.5) {
      e.state = 'offstage';
      park(sys, e);
      setVisible(e, false);
      e.nextSwimBy = now + e.rng.range(40, 80);
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
        e.nextSwimBy = now + e.rng.range(40, 80);
        return;
      }
    }
  } else if (e.state === 'swimby') {
    // Shallow crossing on purpose: the surface furrow is the whole show.
    tx = e.swimbyX; tz = e.swimbyZ; ty = -e.radius * 1.3;
    if (Math.hypot(tx - e.head.x, tz - e.head.z) < 1.2) { goHome(sys, e, now); return; }
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
      p.slurpedBy = e;
      e.slurpT = 0;
      begin(e, 'slurp', now);
      sys.emit('slurp', e);
      return;
    }
  } else {
    let best = null, bd = 1e9;
    for (const f of sys.foods) {
      if (f.amount <= 0) continue;
      const d = Math.hypot(f.x - e.head.x, f.z - e.head.z);
      if (d < bd) { bd = d; best = f; }
    }
    if (!best || now - e.stateAt > VISIT_CAP) { goHome(sys, e, now); return; }
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

  const head = e.head;
  // She has the residents' sense of obstacles, scaled to her bulk; grinding on scenery is beneath
  // her, except mid-bore where the lair run needs the walls to do the steering.
  let ax = tx - head.x, az = tz - head.z;
  const al = Math.hypot(ax, az) || 1e-4;
  ax /= al; az /= al;
  const inBore = !!e.exiting || (e.state === 'return' && e.returnLeg === 1);
  // Homing aims at a point two units off her own log's mouth, so that log must stop shoving her away
  // from it or she orbits her own front door until the visit times out.
  const homing = e.state === 'return';
  if (!inBore) {
    // Reach is her turning radius at this speed, not a fixed collar: eight units of eel has to start
    // the sweep long before the snout arrives, or the turn finishes somewhere inside the rock.
    const look = 0.9 + e.radius * 2 + Math.min(2.4, e.speedBL * e.length / Math.max(0.8, e.turnRate));
    for (const o of sys.colliders.spheres) {
      const dx = head.x - o.x, dz = head.z - o.z;
      const d = Math.hypot(dx, dz), reach = (o.rHit ?? o.r) + look;
      if (d < reach && d > 1e-4) { avoid(e, dx, dz, d, reach); ax += avoidX; az += avoidZ; }
    }
    for (const l of sys.colliders.logs) {
      if (homing && l === e.lair) continue;
      const abx = l.b.x - l.a.x, abz = l.b.z - l.a.z;
      const tp = Math.max(0, Math.min(1, ((head.x - l.a.x) * abx + (head.z - l.a.z) * abz) / (abx * abx + abz * abz)));
      const nx = l.a.x + abx * tp, nz = l.a.z + abz * tp;
      const dx = head.x - nx, dz = head.z - nz;
      const d = Math.hypot(dx, dz), reach = l.rOuter + look;
      if (d < reach && d > 1e-4) { avoid(e, dx, dz, d, reach); ax += avoidX; az += avoidZ; }
    }
  }

  let diff = Math.atan2(az, ax) - Math.atan2(e.heading.z, e.heading.x);
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  // Slow = supple: near-stationary she can hairpin inside her own bore; the exit fold leans on this.
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

  // Her back barely fits under the surface; riding high plows a wake through the sim for free.
  if (head.y > -e.radius * 1.2 && now > e.rippleAt && !sys.motion.reduced) {
    e.rippleAt = now + 0.22;
    sys.sim.addDrop(head.x, head.z, 0.7 + e.radius, 0.014 * speed);
    if (now > (e.bubSoundAt ?? 0)) { e.bubSoundAt = now + e.rng.range(1.2, 2.4); sys.emit('nibble', e); }
  }

  // Stuck: commanded speed and no ground covered over a window. Per tick, a body her size reads every
  // scrape along a log as a jam; three bad windows is a real one, and 1.5 s is still early enough.
  const cmd = e.speedBL * e.length;
  if (cmd > 0.5 && !e.exiting) {
    e.progT += dt;
    if (e.progT >= PROG_WINDOW) {
      const moved = Math.hypot(head.x - e.progX, head.z - e.progZ);
      if (moved < cmd * e.progT * 0.3) e.stuckFor += e.progT; else e.stuckFor = 0;
      e.progT = 0; e.progX = head.x; e.progZ = head.z;
      if (e.stuckFor > PROG_WINDOW * 2) {
        e.stuckFor = 0;
        e.stuckStrikes++;
        if (e.stuckStrikes >= 2) { e.stuckStrikes = 0; goHome(sys, e, now); }
        else { e.nopePulse = now + 1.3; sys.emit('startle', e); }
      }
    }
  } else {
    e.progT = 0; e.progX = head.x; e.progZ = head.z;
    e.stuckFor = Math.max(0, e.stuckFor - dt * 2);
  }
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
    setVisible(p, false);
    p.length = p.baseLength;
    growEel(p, 0);   // recomputes spacing and damped tail amplitude at the reset length
    begin(e, 'wriggle', now);
  }
}

function spit(sys, e, now) {
  const p = e.prey;
  e.prey = null;
  if (!p) return;
  teleport(p, e.head.x + e.heading.x * 0.5, e.head.z + e.heading.z * 0.5, Math.atan2(e.heading.z, e.heading.x), Math.max(-DEPTH + p.radius + 0.1, e.head.y));
  p.slurpedBy = null;
  p.speedMul = 2.2;
  p.speedBL = p.cruiseBL;
  p.fleeUntil = now + 1;
  setVisible(p, true);
  // The queen stays winning. (No eat sound here: the slurp already covered the meal.)
  growEel(e, 0.5);
}
