import * as THREE from 'three/webgpu';
import { EEL_POINTS, DEPTH } from './config.js';

export const TICK = 1 / 90;
export const TRAIL_LEN = 400;   // ≥0.03-unit spacing × 400 covers a 12-unit body; Eleanor needs the headroom
const OFF_DECAY = Math.exp(-2.5 * TICK);
const SLIP_POINTS = 4;   // how far back the head's slip reaches; behind it the body takes full pushes
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
let near = new Uint8Array(0);   // per-tick pair cull scratch, grown to the cast size

export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

export function pushTrail(e, p) {
  const n = e.trail.length;
  e.trailHead = (e.trailHead + 1) % n;
  e.trail[e.trailHead].copy(p);
  e.trailCount = Math.min(e.trailCount + 1, n);
}
export function trailAt(e, k) { const n = e.trail.length; return e.trail[(e.trailHead - k + n) % n]; }

/* Tail half-amplitude with length damping past ~3.6 units: giant tails read as thrash, not propulsion. */
export function tailAmp(e) {
  return e.length * e.ampRatio * Math.min(1, Math.sqrt(3.6 / e.length));
}

/* Growth support: longer bodies need longer path memory (capacity is the trail array itself). */
export function growEel(e, d) {
  e.length += d;
  e.spacing = e.length / (e.pts.length - 1);
  e.ampTail = tailAmp(e);
  if (e.length * 1.5 > e.trail.length * 0.03) growTrail(e);
}

function growTrail(e) {
  const fresh = Array.from({ length: Math.ceil(e.trail.length * 1.5) }, () => new THREE.Vector3());
  for (let k = e.trailCount - 1; k >= 0; k--) fresh[e.trailCount - 1 - k].copy(trailAt(e, k));
  e.trail = fresh;
  e.trailHead = Math.max(0, e.trailCount - 1);
}

/* The body slides along the path the head took (snake-style), so turns flow down the length
   instead of the tail being dragged sideways. Collision pushes live in a decaying offset layer. */
export function followBody(e) {
  const pts = e.pts;
  const head = pts[0];
  // Record the path only when the head has actually advanced; shoves and dithering never enter it.
  tmpB.subVectors(head, trailAt(e, 0));
  if (tmpB.length() > 0.03 && tmpB.dot(e.heading) > 0) pushTrail(e, head);
  // Envelope node sits ~0.1 L behind the snout; the wave grows from there to the tail tip.
  const node = (EEL_POINTS - 1) * 0.1;
  // Segment -1 runs from the live head to the newest recorded point, so the body never lags the head.
  const last = e.trailCount - 1;
  let seg = -1, segStart = head, segEnd = trailAt(e, 0);
  let segLen = segStart.distanceTo(segEnd), walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const want = i * e.spacing;
    while (walked + segLen < want && seg < last - 1) {
      walked += segLen; seg++;
      segStart = trailAt(e, seg); segEnd = trailAt(e, seg + 1);
      segLen = segStart.distanceTo(segEnd);
    }
    const p = pts[i];
    if (walked + segLen >= want && segLen > 1e-6) {
      p.copy(segStart).lerp(segEnd, (want - walked) / segLen);
    } else {
      // Not enough history yet: extend straight back from the last known point.
      tmpB.subVectors(segEnd, segStart);
      if (tmpB.lengthSq() < 1e-8) tmpB.copy(e.heading).negate();
      tmpB.normalize();
      p.copy(segEnd).addScaledVector(tmpB, want - walked - segLen);
    }
    // Backward-traveling wave: constant tail amplitude, speed-scaled anterior, uniform when reversing.
    const phase = e.wavePhase - i * e.waveK;
    let env;
    if (e.reverse) env = 1;
    else if (i <= node) env = -0.2 * (1 - i / node);   // slight counter-phase snout yaw, node not at the head
    else {
      // Concave growth keeps the mid-body calm so the tail reads as propulsion, not thrashing.
      const t = (i - node) / (EEL_POINTS - 1 - node);
      env = Math.pow(t, 1.3) * (e.anterior + (1 - e.anterior) * Math.min(1, t * 2));
    }
    const amt = Math.sin(phase) * e.ampTail * env * e.ampMul;
    const q = pts[i - 1];
    tmpC.subVectors(q, p); const d = tmpC.length() || 1e-4;
    p.x += (-tmpC.z / d) * amt; p.z += (tmpC.x / d) * amt;
    // Leftover collision push, fading so the body eases back onto its path.
    const off = e.offsets[i];
    off.multiplyScalar(OFF_DECAY);
    p.add(off);
  }
}

/* Head walks backward down its own recorded path (film in reverse); consumed entries pop so the
   trail keeps extending behind the head. The guard leaves enough history for the body solve. */
export function retreatAlongTrail(e, dist) {
  const head = e.pts[0];
  let remaining = dist;
  while (remaining > 1e-5 && e.trailCount > 4) {
    const back = trailAt(e, 0);
    const step = head.distanceTo(back);
    if (step > remaining) { head.lerp(back, remaining / step); return; }
    head.copy(back);
    remaining -= step;
    e.trailHead = (e.trailHead - 1 + e.trail.length) % e.trail.length;
    e.trailCount--;
  }
}

/* Integrates the residual collision push into the offset layer. The push is what remained after the
   stored offset was applied, so adding it converges on the full displacement; a lerp stalls at half. */
export function rememberPushes(e) {
  for (let i = 1; i < e.pts.length; i++) { tmpA.copy(e.pts[i]).sub(e.prev[i]); e.offsets[i].addScaledVector(tmpA, 0.5); }
}

export function collide(eels, colliders) {
  const floorY = -DEPTH;
  const { spheres, logs } = colliders;
  if (near.length < eels.length) near = new Uint8Array(eels.length);
  // Bounding sphere per eel so distant pairs skip the 24×24 point test.
  for (const e of eels) {
    const c = e.pts[EEL_POINTS >> 1];
    let r2 = 0;
    for (const p of e.pts) r2 = Math.max(r2, p.distanceToSquared(c));
    e.boundR = Math.sqrt(r2) + e.radius;
  }
  for (let a = 0; a < eels.length; a++) {
    const ea = eels[a];
    if (ea.slurpedBy) continue;
    const ca = ea.pts[EEL_POINTS >> 1];
    // Guests run slip below 1. A body eight units long snags on scenery its brain steered past three
    // seconds ago, and the strongest eel in the pond should shrug that off, not park on it.
    const slip = ea.slip ?? 1;
    // Decide the pair cull once per eel, outside the 24×24 point loop it gates.
    for (let b = a + 1; b < eels.length; b++) {
      const eb = eels[b];
      near[b] = !eb.slurpedBy && ca.distanceTo(eb.pts[EEL_POINTS >> 1]) <= ea.boundR + eb.boundR ? 1 : 0;
    }
    for (let i = 0; i < EEL_POINTS; i++) {
      const p = ea.pts[i];
      const r = ea.radius;
      const soft = i === 0 ? 0.35 : 1;   // the head eases out of contact; a full shove kinks the trail
      const glance = i < SLIP_POINTS ? slip : 1;
      // Rock and log colliders both sit proud of what they draw (the log's is a crest-plus-bend
      // envelope), so a slippery snout may take a small bite out of one before the push counts.
      const sink = (1 - glance) * r * 0.35;
      if (p.y < floorY + r + 0.08) p.y = floorY + r + 0.08;   // floor has bumps up to ~0.08
      if (p.y > -r * 0.5) p.y = -r * 0.5;
      for (const s of spheres) {
        // A rock reaching the surface band pushes sideways only; pushing up there just fights the ceiling clamp.
        // The envelope is an ellipsoid: dy is scaled into the horizontal radius's units and pushed back out.
        const sr = s.rHit ?? s.r, ky = sr / (s.ryHit ?? sr);
        const dx = p.x - s.x, dy = s.y + sr > -r * 2 ? 0 : (p.y - s.y) * ky, dz = p.z - s.z;
        const d = Math.hypot(dx, dy, dz), min = sr + r - sink;
        if (d < min && d > 1e-5) { const k = (min - d) / d * soft * glance; p.x += dx * k; p.y += dy * k / ky; p.z += dz * k; }
      }
      for (const l of logs) {
        // Distance to the log's axis segment; inside the bore is fine, the wall is not.
        tmpA.subVectors(l.b, l.a); const len2 = tmpA.lengthSq();
        tmpB.subVectors(p, l.a);
        const t = Math.max(0, Math.min(1, tmpB.dot(tmpA) / len2));
        tmpC.copy(l.a).addScaledVector(tmpA, t);
        const dx = p.x - tmpC.x, dy = p.y - tmpC.y, dz = p.z - tmpC.z;
        const d = Math.hypot(dx, dy, dz);
        // Hollow logs have open mouths; a solid stub (rInner 0) keeps its tip as a sphere cap.
        const endCap = t <= 0 || t >= 1;
        if (endCap && l.rInner > 0) continue;
        const inner = l.rInner - r + sink, outer = l.rOuter + r - sink;
        if (d > inner && d < outer && d > 1e-5) {
          const toInner = d - inner, toOuter = outer - d;
          const k = (l.rInner > 0 && toInner < toOuter ? -toInner : toOuter) / d * soft * glance;
          p.x += dx * k; p.y += dy * k; p.z += dz * k;
        }
      }
      for (let b = a + 1; b < eels.length; b++) {
        if (!near[b]) continue;
        const eb = eels[b];
        const min = r + eb.radius;
        for (let j = 0; j < EEL_POINTS; j++) {
          const q = eb.pts[j];
          const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < min * min && d2 > 1e-8) {
            const d = Math.sqrt(d2), k = (min - d) / d * 0.25;
            p.x += dx * k; p.y += dy * k; p.z += dz * k;
            q.x -= dx * k; q.y -= dy * k; q.z -= dz * k;
          }
        }
      }
    }
  }
}

/* Distance constraints with a tolerance band: the path-following pose already spaces the chain, so this
   only acts where a collision push tore or bunched it, sharing the correction between both neighbors. */
export function constrain(e) {
  const pts = e.pts, sp = e.spacing, lo = sp * 0.85, hi = sp * 1.15;
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 1; i < EEL_POINTS; i++) {
      const p = pts[i], q = pts[i - 1];
      tmpA.subVectors(p, q);
      const d = tmpA.length();
      if ((d >= lo && d <= hi) || d < 1e-6) continue;
      tmpA.multiplyScalar((d - sp) / d);
      if (i === 1) p.sub(tmpA);
      else { p.addScaledVector(tmpA, -0.5); q.addScaledVector(tmpA, 0.5); }
    }
  }
}
