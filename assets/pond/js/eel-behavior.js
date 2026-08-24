import * as THREE from 'three/webgpu';
import { DEPTH, EEL_POINTS } from './config.js';
import { segDist, retreatAlongTrail } from './eel-physics.js';

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
const axis = new THREE.Vector3(), rel = new THREE.Vector3(), nearest = new THREE.Vector3();

// Real-eel locomotion baseline: tail-beat Hz = F_IDLE + F_K × speed in body lengths/s (BL/s).
const F_IDLE = 0.6, F_K = 1.4;
const WRAP = Math.PI * 2 * 1000;

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

export function startTunnel(e, entry, exit, now) {
  // Line up on the axis two units out from the mouth first, so the head enters the bore straight.
  const axis = new THREE.Vector3().subVectors(exit, entry).normalize();
  const approach = entry.clone().addScaledVector(axis, -2.0);
  // Run-out past the far mouth keeps the tail from being dragged through the rim when the head turns away.
  const runout = exit.clone().addScaledVector(axis, e.length + 0.6);
  e.tunnel = { approach, entry, exit, runout, stage: 0 };
  e.target.copy(approach);
  e.retargetAt = now + 30;
}

export function pickTarget(e, now) {
  const rng = e.rng;
  e.coverSpot = null;
  const flock = e.flock || [];
  // Tunnel runs: a good share of the time the next destination is one log mouth, then the other.
  // Crowded cover loses its appeal: every current claimant halves the draw toward that spot.
  const log = e.colliders.logs[0];
  if (log && e.tunnel === null && logFits(e, log)) {
    const logClaims = flock.reduce((n, o) => n + (o !== e && o.coverSpot?.type === 'log' ? 1 : 0), 0);
    if (rng.chance(Math.min(0.85, 0.4 * e.traits.cover) / (1 + logClaims))) {
      const fromA = rng.chance(0.5);
      startTunnel(e, fromA ? log.a : log.b, fromA ? log.b : log.a, now);
      e.coverSpot = { type: 'log', idx: 0 };
      return;
    }
  }
  e.tunnel = null;
  // Half the time head for cover: a spot beside a rock (or under a lily pad, later). Otherwise wander
  // the viewport and a little past it, so they drift in and out but never leave for long.
  const rocks = e.colliders.spheres;
  if (rocks.length && rng.chance(Math.min(0.6, 0.2 * e.traits.cover))) {
    const claims = rocks.map((_, i) => flock.reduce((n, o) => n + (o !== e && o.coverSpot?.type === 'rock' && o.coverSpot.idx === i ? 1 : 0), 0));
    const least = Math.min(...claims);
    const idx = rng.pick(rocks.map((_, i) => i).filter((i) => claims[i] === least));
    const o = rocks[idx];
    const a = rng.range(0, Math.PI * 2), d = o.r + rng.range(0.6, 1.6);
    e.target.set(o.x + Math.cos(a) * d, 0, o.z + Math.sin(a) * d);
    e.coverSpot = { type: 'rock', idx };
  } else {
    const ex = e.view.w * 0.48, ez = e.view.h * 0.48;
    e.target.set(rng.range(-ex, ex), 0, rng.range(-ez, ez));
  }
  e.retargetAt = now + rng.range(e.traits.attention[0], e.traits.attention[1]);
}

/* Hold/prowl/cruise cadence: travel in bouts, then settle; anguilliforms stop rather than coast. */
function updateGait(e, now) {
  if (now < e.gaitUntil) return;
  const rng = e.rng, t = e.traits;
  if (e.gait === 'hold') { e.gait = rng.chance(0.75) ? 'prowl' : 'cruise'; e.gaitUntil = now + rng.range(t.travelTime[0], t.travelTime[1]); }
  else if (rng.chance(t.holdChance)) { e.gait = 'hold'; e.gaitUntil = now + rng.range(t.holdTime[0], t.holdTime[1]); }
  else { e.gait = rng.chance(0.35) ? 'cruise' : 'prowl'; e.gaitUntil = now + rng.range(t.travelTime[0], t.travelTime[1]); }
}

/* The nope: hold tight if already denned, back straight up when threatened head-on with trail
   to spare, bolt for the log when it fits and is close; otherwise the plain flee burst handles it. */
function nope(sys, e, s, now) {
  const head = e.head;
  const log = sys.colliders.logs[0];
  if (log && segDist(head.x, head.z, log.a.x, log.a.z, log.b.x, log.b.z) < log.rInner) {
    if (!e.tunnel) {
      const da = Math.hypot(log.a.x - s.x, log.a.z - s.z), db = Math.hypot(log.b.x - s.x, log.b.z - s.z);
      const exit = da > db ? log.a : log.b;   // continue toward the mouth farther from the threat
      startTunnel(e, exit === log.a ? log.b : log.a, exit, now);
      e.tunnel.stage = 1;
      e.target.copy(exit);
    }
    e.tunnel.hideFrom = now;
    e.tunnel.hideUntil = now + e.rng.range(3, 8);
    e.coverSpot = { type: 'log', idx: 0 };
    return;
  }
  tmpB.set(s.x - head.x, 0, s.z - head.z);
  if (tmpB.length() < e.length && tmpB.normalize().dot(e.heading) > 0.4 && e.trailCount > EEL_POINTS * 3) {
    e.tunnel = null;
    e.nopeUntil = now + 1.1;
    return;
  }
  if (log && logFits(e, log)) {
    const da = Math.hypot(log.a.x - head.x, log.a.z - head.z), db = Math.hypot(log.b.x - head.x, log.b.z - head.z);
    if (Math.min(da, db) < e.length * 2.5) {
      const nearA = da < db;
      startTunnel(e, nearA ? log.a : log.b, nearA ? log.b : log.a, now);
      e.tunnel.wantHide = true;   // hold begins a beat after entering the bore, not at the mouth
      e.coverSpot = { type: 'log', idx: 0 };
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

  if (now < e.nopeUntil) { nopingTick(sys, e, dt); return; }
  e.reverse = false;

  const force = tmpA.set(0, 0, 0);
  let speedMul = 1;
  let excite = 0;

  // Hiding freezes the run mid-bore; the timer clears and the run resumes on its own.
  const hiding = !!(e.tunnel && e.tunnel.hideUntil && now > e.tunnel.hideFrom && now < e.tunnel.hideUntil);
  if (e.tunnel && e.tunnel.hideUntil && now >= e.tunnel.hideUntil) e.tunnel.hideUntil = 0;

  // Inside a tunnel run: reach the mouth, then aim straight through to the far mouth, holding axis height.
  if (e.tunnel && !hiding) {
    const dxz = Math.hypot(e.target.x - head.x, e.target.z - head.z);
    if (e.tunnel.stage === 0 && dxz < 0.5) {
      e.tunnel.stage = 1; e.target.copy(e.tunnel.exit);
      if (e.tunnel.wantHide) { e.tunnel.wantHide = false; e.tunnel.hideFrom = now + 0.6; e.tunnel.hideUntil = now + 0.6 + rng.range(3, 8); }
    }
    else if (e.tunnel.stage === 1 && dxz < 0.4) { e.tunnel.stage = 2; e.target.copy(e.tunnel.runout); }
    else if (e.tunnel.stage === 2 && dxz < 0.5) { e.tunnel = null; pickTarget(e, now); }
    if (e.tunnel) { e.targetY = e.tunnel.entry.y; e.retargetYAt = now + 2; }
  }
  // Never abandon a run mid-bore: turning around inside the log drags the body through its wall.
  if ((now > e.retargetAt && e.tunnel?.stage !== 1) || (!e.tunnel && head.distanceTo(e.target) < 0.6)) pickTarget(e, now);
  tmpB.subVectors(e.target, head); tmpB.y = 0; tmpB.normalize();
  force.addScaledVector(tmpB, hiding ? 0 : e.tunnel ? 1.4 : 0.6);

  // Spooks: strong, short-lived push away, with a speed burst.
  for (const s of sys.spooks) {
    const age = now - s.t;
    if (age > 1.6) continue;
    const dx = head.x - s.x, dz = head.z - s.z;
    const d = Math.hypot(dx, dz);
    if (d > 3.5) continue;
    let k = (1 - age / 1.6) * s.strength * (1 - d / 3.5);
    // Ripple-chaser quirk: a modest splash is an invitation; real scares still land at full force.
    if (e.quirks.rippleChase && k * e.traits.spookMul < 0.55) {
      force.x -= (dx / (d + 0.05)) * k * 3;
      force.z -= (dz / (d + 0.05)) * k * 3;
      excite = Math.max(excite, k * 0.5);
      continue;
    }
    k *= e.traits.spookMul;
    force.x += (dx / (d + 0.05)) * k * 6;
    force.z += (dz / (d + 0.05)) * k * 6;
    speedMul = Math.max(speedMul, 1 + 1.4 * k);
    excite = Math.max(excite, k);
    if (k > 0.5 && now > e.fleeUntil) {
      e.fleeUntil = now + 1;
      sys.onEvent?.('startle', e);
      nope(sys, e, s, now);
      if (now < e.nopeUntil) { nopingTick(sys, e, dt); return; }
    }
  }

  // Lures: drag trails older than a second pull gently, eels nose in to look.
  for (const l of sys.lures) {
    const age = now - l.t;
    if (age < 1.0 || age > 9) continue;
    const dx = l.x - head.x, dz = l.z - head.z;
    const d = Math.hypot(dx, dz);
    if (d > 6 || d < 0.4) continue;
    const k = 0.35 * (1 - age / 9) * e.traits.curious;
    force.x += (dx / d) * k; force.z += (dz / d) * k;
  }

  // Bonded following: drift toward the partner when the gap opens; never overrides a run or a meal.
  if (e.partner && !e.tunnel && !e.food) {
    const dx = e.partner.head.x - head.x, dz = e.partner.head.z - head.z;
    const d = Math.hypot(dx, dz);
    if (d > e.length * 1.2 && d < 8) {
      const w = e.quirks.followWeight ?? 0.3;
      force.x += (dx / d) * w; force.z += (dz / d) * w;
    }
  }

  // Food: pick the least-crowded nearby crumb; spreading out is the whole point.
  if (sys.foods.length) {
    const log = sys.colliders.logs[0];
    const fits = log ? logFits(e, log) : false;
    let best = null, bestScore = Infinity;
    for (const f of sys.foods) {
      if (f.amount <= 0) continue;
      // Bore food is invisible to an eel that cannot fit through the mouth.
      if (!fits && log && segDist(f.x, f.z, log.a.x, log.a.z, log.b.x, log.b.z) < log.rInner) continue;
      const d = Math.hypot(f.x - head.x, f.z - head.z);
      const score = d + f.claims * 2.2 * (1 + e.traits.yield * 2) - (e.food === f ? e.traits.persistence : 0);
      if (score < bestScore) { bestScore = score; best = f; }
    }
    if (e.food && e.food !== best) e.food.claims = Math.max(0, e.food.claims - 1);
    if (best && e.food !== best) best.claims++;
    e.food = best;
    if (best) {
      const dx = best.x - head.x, dz = best.z - head.z;
      const d = Math.hypot(dx, dz);
      // Food inside the log is reached through a mouth, not the wall: run the tunnel and let the
      // bore do the steering until the head is actually inside.
      let pull = 4.0 * e.traits.hunger;
      if (log && segDist(best.x, best.z, log.a.x, log.a.z, log.b.x, log.b.z) < log.rOuter) {
        if (!e.tunnel && fits) {
          const nearA = Math.hypot(log.a.x - head.x, log.a.z - head.z) < Math.hypot(log.b.x - head.x, log.b.z - head.z);
          startTunnel(e, nearA ? log.a : log.b, nearA ? log.b : log.a, now);
        }
        if (segDist(head.x, head.z, log.a.x, log.a.z, log.b.x, log.b.z) > log.rInner) pull = 0;
      }
      force.x += (dx / (d + 0.01)) * pull; force.z += (dz / (d + 0.01)) * pull;
      speedMul = Math.max(speedMul, 1 + 0.5 * e.traits.hunger);
      e.targetY = Math.max(e.targetY, -0.25);
      if (d < 0.35) {
        best.amount -= dt * 0.6;
        excite = Math.max(excite, 0.5);
        if (best.amount <= 0) { sys.onEvent?.('eat', e); }
      }
    }
  } else if (e.food) { e.food = null; }

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

  // Idle spacing: resting eels spread out instead of dogpiling; bonded partners may cuddle.
  let crowd = 0;
  if (!e.tunnel) {
    for (const o of sys.eels) {
      if (o === e || o === e.partner) continue;
      const dx = head.x - o.head.x, dz = head.z - o.head.z;
      const d = Math.hypot(dx, dz);
      const want = (e.length + o.length) * 0.25;
      if (d < want && d > 1e-4) {
        const calmness = 1 - Math.min(1, e.speedBL / e.cruiseBL);
        const k = (1 - d / want) * 1.2 * calmness;
        force.x += (dx / d) * k; force.z += (dz / d) * k;
        crowd = Math.max(crowd, k);
      }
    }
  }

  // Steer around rocks and the log wall before the head touches them (a shoved head kinks the trail).
  // Reach grows with speed: a bolting eel turns no faster, so it has to start the turn earlier.
  const lookahead = 0.5 + 0.45 * (e.speedMul - 1);
  for (const o of sys.colliders.spheres) {
    const dx = head.x - o.x, dz = head.z - o.z;
    const d = Math.hypot(dx, dz), reach = o.r + lookahead;
    if (d < reach && d > 1e-4) {
      // Slippery in 3D: a rock with clear water over its top is a speed bump, not a wall.
      const top = o.y + o.r;
      const canClear = top < -e.radius * 2.5;
      const k = (1 - d / reach) * (canClear ? 0.7 : 2.5);
      force.x += (dx / d) * k; force.z += (dz / d) * k;
      if (canClear && d < o.r + 0.6) e.targetY = Math.max(e.targetY, top + e.radius * 1.5);
    }
  }
  if (!e.tunnel) {
    for (const l of sys.colliders.logs) {
      // force aliases tmpA, so this block keeps to its own temporaries.
      axis.subVectors(l.b, l.a); rel.subVectors(head, l.a);
      const t = Math.max(0, Math.min(1, rel.dot(axis) / axis.lengthSq()));
      nearest.copy(l.a).addScaledVector(axis, t);
      const dx = head.x - nearest.x, dz = head.z - nearest.z;
      const d = Math.hypot(dx, dz), reach = l.rOuter + lookahead;
      if (d < reach && d > 1e-4) {
        const top = l.a.y + l.rOuter;
        const canClear = top < -e.radius * 2.5;
        const k = (1 - d / reach) * (canClear ? 0.7 : 2.5);
        force.x += (dx / d) * k; force.z += (dz / d) * k;
        if (canClear && d < l.rOuter + 0.6) e.targetY = Math.max(e.targetY, top + e.radius * 1.5);
      }
    }
  }

  // Stay near the view: past ~70% of a viewport beyond the edge, turn back.
  const limX = sys.view.w * 0.7, limZ = sys.view.h * 0.7;
  if (Math.abs(head.x) > limX) force.x -= Math.sign(head.x) * 3;
  if (Math.abs(head.z) > limZ) force.z -= Math.sign(head.z) * 3;

  if (sys.motion.reduced) speedMul = Math.min(speedMul, 1) * 0.35;

  if (force.x * force.x + force.z * force.z > 1e-6) {
    let diff = Math.atan2(force.z, force.x) - Math.atan2(e.heading.z, e.heading.x);
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const maxTurn = e.turnRate * (1 + 0.6 * (e.speedMul - 1)) * dt;
    const yaw = Math.max(-maxTurn, Math.min(maxTurn, diff * Math.min(1, dt * 7)));
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const hx = e.heading.x * c - e.heading.z * sn, hz = e.heading.x * sn + e.heading.z * c;
    e.heading.set(hx, 0, hz).normalize();
  }
  e.speedMul += (speedMul - e.speedMul) * Math.min(1, dt * 4);
  e.uExcite.value += (excite - e.uExcite.value) * Math.min(1, dt * 3);

  updateGait(e, now);
  const gait = hiding ? 'hold' : (e.tunnel || e.food) ? 'cruise' : e.gait;

  // Depth wandering: bottom-hugging by default; only a cruise ranges the whole column.
  if (now > e.retargetYAt) {
    const top = gait === 'cruise' ? -e.radius * 1.6 : -DEPTH * 0.55;
    e.targetY = rng.range(-DEPTH + e.radius * 2.2, top);
    e.retargetYAt = now + rng.range(4, 10);
  }

  // Stimuli raise the speed floor rather than multiply it, so a spooked resting eel still bolts.
  let gaitBL = gait === 'hold' ? 0.05 : gait === 'prowl' ? e.prowlBL : e.cruiseBL;
  if (crowd > 0.3 && gait === 'hold') gaitBL = Math.max(gaitBL, e.prowlBL * 0.6);   // shuffle out of a pile
  const stim = Math.max(0, e.speedMul - 1);
  const wantBL = Math.min(gaitBL + stim * e.cruiseBL, e.cruiseBL * 1.5) * (sys.motion.reduced ? 0.35 : 1);
  // Voluntary accel ~1.3 L/s²; stopping is quicker (eels do not coast), startle quicker still.
  const rate = wantBL > e.speedBL ? (stim > 0.5 ? 6 : 1.3) : 2.5;
  e.speedBL += Math.max(-rate * dt, Math.min(rate * dt, wantBL - e.speedBL));
  const speed = e.speedBL * e.length;

  // Tail beat is an output of speed; wavelength comes from measured slip, clamped to 0.58–0.85 L.
  const f = F_IDLE + F_K * e.speedBL;
  e.wavePhase += Math.PI * 2 * f * dt;
  if (e.wavePhase > WRAP) e.wavePhase -= WRAP;
  const lambda = Math.min(0.85, Math.max(0.58, e.speedBL / (slipFor(e.speedBL) * f)));
  e.waveK = (Math.PI * 2) / ((EEL_POINTS - 1) * lambda);
  e.ampMul += ((gait === 'hold' ? 0.15 : 1) - e.ampMul) * Math.min(1, dt * 3);
  e.anterior += ((0.2 + 0.8 * Math.min(1, e.speedBL / 1.6)) - e.anterior) * Math.min(1, dt * 3);

  const side = tmpC.set(-e.heading.z, 0, e.heading.x);
  head.addScaledVector(e.heading, speed * dt);
  // Snout yaw as the derivative of its lateral sine, so the head stays in phase with the body wave.
  head.addScaledVector(side, Math.cos(e.wavePhase) * e.ampTail * 0.2 * e.anterior * Math.PI * 2 * f * dt);
  head.y += (e.targetY - head.y) * Math.min(1, dt * 0.8);

  e.squash += ((1 + (e.speedMul - 1) * 0.18) - e.squash) * Math.min(1, dt * 5);
  e.uSquash.value = e.squash;

  // Surface wake when swimming shallow.
  if (head.y > -0.15 && now > e.rippleAt && !sys.motion.reduced) {
    e.rippleAt = now + 0.3;
    sys.sim.addDrop(head.x, head.z, 0.45 + e.radius, 0.008 * speed);
  }
}
