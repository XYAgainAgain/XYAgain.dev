import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, attribute, vec2, vec3, vec4, float, int, floor, mix, normalize, cross, sin, cos, abs, smoothstep, varying, dot, TWO_PI, positionWorld } from 'three/tsl';
import { EEL_COUNT, EEL_POINTS, DEPTH } from './config.js';
import { valueNoise2 } from './shading.js';
import { createRng, deriveSeed } from './rng.js';

const RINGS = 48, SIDES = 12;
const TICK = 1 / 90, TRAIL_LEN = 240;
const OFF_DECAY = Math.exp(-2.5 * TICK);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
const axis = new THREE.Vector3(), rel = new THREE.Vector3(), nearest = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/* In-place expiry: no per-tick array churn. */
function expire(arr, now, maxAge) {
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (now - arr[i].t < maxAge) arr[w++] = arr[i];
  arr.length = w;
}

const PALETTE = [
  [0.10, 1.00, 0.85], [1.00, 0.25, 0.70], [0.35, 0.55, 1.00], [0.95, 0.95, 0.20],
  [1.00, 0.45, 0.10], [0.60, 0.20, 1.00], [0.20, 1.00, 0.30], [1.00, 0.15, 0.25],
];

/* Tube geometry parameterized by (t along, angle around); the spine comes in as a uniform array. */
function makeTubeGeometry() {
  const geo = new THREE.BufferGeometry();
  const count = (RINGS + 1) * (SIDES + 1);
  const aT = new Float32Array(count), aAng = new Float32Array(count);
  let k = 0;
  for (let r = 0; r <= RINGS; r++) {
    for (let s = 0; s <= SIDES; s++) {
      aT[k] = r / RINGS;
      aAng[k] = (s / SIDES) * Math.PI * 2;
      k++;
    }
  }
  const idx = [];
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * (SIDES + 1) + s, b = a + SIDES + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aAng', new THREE.BufferAttribute(aAng, 1));
  geo.setIndex(idx);
  return geo;
}

class Eel {
  constructor(index, seed, extent, colliders, view) {
    this.view = view;
    this.index = index;
    this.rng = createRng(deriveSeed(seed, 1000 + index));
    const rng = this.rng;
    this.length = rng.range(1.6, 3.4);
    this.radius = rng.range(0.07, 0.12);
    this.spacing = this.length / (EEL_POINTS - 1);
    this.baseSpeed = rng.range(0.7, 1.3);
    // Cruising anguilliform beat is slow; anything past ~2 Hz reads as vibration rather than swimming.
    this.waveFreq = rng.range(0.9, 1.5);
    this.waveAmp = rng.range(0.05, 0.11);
    this.phase = rng.range(0, Math.PI * 2);
    this.extent = extent;
    this.colliders = colliders;
    this.pts = [];
    this.prev = [];
    this.pose0 = [];           // last tick's solved pose, for render interpolation
    this.show = [];
    this.offsets = [];
    // Head history as a ring buffer: trailHead is the newest slot, trailCount how many are valid.
    this.trail = Array.from({ length: TRAIL_LEN }, () => new THREE.Vector3());
    this.trailHead = 0;
    this.trailCount = 0;
    // Max yaw rate in rad/s; eels are bendy, so a cruising U-turn fits inside a body length.
    this.turnRate = rng.range(3.5, 5.0);
    // Spawn with the whole body clear of rocks and the log; a body born inside a wall starts life twitching out of it.
    let ang = 0, hx = 0, hz = 0;
    const y = rng.range(-DEPTH + 0.2, -0.2);
    for (let tries = 0; tries < 20; tries++) {
      ang = rng.range(0, Math.PI * 2);
      const dist = rng.range(view.h * 0.1, view.h * 0.55);
      hx = Math.cos(ang) * dist; hz = Math.sin(ang) * dist;
      const tx = hx - Math.cos(ang) * this.length, tz = hz - Math.sin(ang) * this.length;
      if (colliders.spheres.every((o) => segDist(o.x, o.z, hx, hz, tx, tz) > o.r + 0.5) &&
          colliders.logs.every((l) => segDist(l.a.x, l.a.z, hx, hz, tx, tz) > l.rOuter + 0.6 && segDist(l.b.x, l.b.z, hx, hz, tx, tz) > l.rOuter + 0.6 &&
            segDist((l.a.x + l.b.x) / 2, (l.a.z + l.b.z) / 2, hx, hz, tx, tz) > l.rOuter + 0.6)) break;
    }
    for (let i = 0; i < EEL_POINTS; i++) {
      this.pts.push(new THREE.Vector3(hx - Math.cos(ang) * i * this.spacing, y, hz - Math.sin(ang) * i * this.spacing));
      this.prev.push(this.pts[i].clone());
      this.pose0.push(this.pts[i].clone());
      this.show.push(this.pts[i].clone());
      this.offsets.push(new THREE.Vector3());
    }
    for (let i = EEL_POINTS - 1; i >= 0; i--) this.pushTrail(this.pts[i]);
    this.heading = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
    this.target = new THREE.Vector3();
    this.retargetAt = 0;
    this.speedMul = 1;
    this.fleeUntil = 0;
    this.squash = 1;
    this.rippleAt = 0;
    this.food = null;
    this.tunnel = null;
    this.targetY = y;
    this.retargetYAt = 0;
    this.rollColors(rng);
    this.rollPattern(rng);
  }

  rollColors(rng) {
    const a = rng.pick(PALETTE), b = rng.pick(PALETTE);
    this.colA = new THREE.Color(...a);
    this.colB = new THREE.Color(...b);
  }

  rollPattern(rng) {
    this.stripeFreq = rng.range(4, 14);
    this.spotFreq = rng.range(6, 16);
    this.wStripe = rng.chance(0.7) ? rng.range(0.4, 1) : 0;
    this.wSpot = rng.chance(0.7) ? rng.range(0.4, 1) : 0;
    this.wFlank = rng.chance(0.8) ? rng.range(0.5, 1) : 0;
    this.wavy = rng.range(0, 2.5);
    this.pulseRate = rng.range(1.5, 4);
    if (this.wStripe + this.wSpot + this.wFlank === 0) this.wFlank = 1;
  }

  get head() { return this.pts[0]; }

  pushTrail(p) {
    this.trailHead = (this.trailHead + 1) % TRAIL_LEN;
    this.trail[this.trailHead].copy(p);
    this.trailCount = Math.min(this.trailCount + 1, TRAIL_LEN);
  }
  trailAt(k) { return this.trail[(this.trailHead - k + TRAIL_LEN) % TRAIL_LEN]; }

  startTunnel(entry, exit, now) {
    // Line up on the axis two units out from the mouth first, so the head enters the bore straight.
    const axis = new THREE.Vector3().subVectors(exit, entry).normalize();
    const approach = entry.clone().addScaledVector(axis, -2.0);
    // Run-out past the far mouth keeps the tail from being dragged through the rim when the head turns away.
    const runout = exit.clone().addScaledVector(axis, this.length + 0.6);
    this.tunnel = { approach, entry, exit, runout, stage: 0 };
    this.target.copy(approach);
    this.retargetAt = now + 30;
  }

  pickTarget(now, rng) {
    // Tunnel runs: a good share of the time the next destination is one log mouth, then the other.
    const log = this.colliders.logs[0];
    if (log && this.tunnel === null && rng.chance(0.4)) {
      const fromA = rng.chance(0.5);
      this.startTunnel(fromA ? log.a : log.b, fromA ? log.b : log.a, now);
      return;
    }
    this.tunnel = null;
    // Half the time head for cover: a spot beside a rock (or under a lily pad, later). Otherwise wander
    // the viewport and a little past it, so they drift in and out but never leave for long.
    const rocks = this.colliders.spheres;
    if (rocks.length && rng.chance(0.2)) {
      const o = rng.pick(rocks);
      const a = rng.range(0, Math.PI * 2), d = o.r + rng.range(0.6, 1.6);
      this.target.set(o.x + Math.cos(a) * d, 0, o.z + Math.sin(a) * d);
    } else {
      const ex = this.view.w * 0.48, ez = this.view.h * 0.48;
      this.target.set(rng.range(-ex, ex), 0, rng.range(-ez, ez));
    }
    this.retargetAt = now + rng.range(5, 12);
  }
}

export class EelSystem {
  constructor(scene, U, shading, seed, extent, colliders, sim, motion, view) {
    this.view = view;
    this.scene = scene;
    this.U = U;
    this.shading = shading;
    this.sim = sim;
    this.motion = motion;          // { reduced: bool }
    this.extent = extent;
    this.colliders = colliders;
    this.rng = createRng(deriveSeed(seed, 5));
    this.eels = [];
    this.spooks = [];              // { x, z, t, strength }
    this.lures = [];               // curiosity points from drags: { x, z, t }
    this.foods = [];               // { x, z, y, amount, mesh, claims }
    this.vortices = [];            // { x, z, t, strength, radius }
    this.time = 0;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.geometry = makeTubeGeometry();
    this.foodGeo = new THREE.SphereGeometry(0.045, 8, 6);
    this.foodMat = new THREE.NodeMaterial();
    // Alpha carries depth below the surface for the refraction pass, same as every underwater material.
    this.foodMat.fragmentNode = Fn(() => vec4(vec3(0.9, 0.8, 0.55), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
    for (let i = 0; i < EEL_COUNT; i++) {
      const e = new Eel(i, seed, extent, colliders, view);
      e.pickTarget(0, e.rng);
      this.eels.push(e);
      this.buildMesh(e);
    }
    this.enabled = true;
    this.onEvent = null;           // audio hook: (type, eel) =>
    // A hidden-size food crumb drawn on the first frames so the real first feed never compiles a pipeline mid-click.
    this.warmFood = new THREE.Mesh(this.foodGeo, this.foodMat);
    this.warmFood.scale.setScalar(0.001); this.warmFood.position.y = -DEPTH;
    this.warmFood.frustumCulled = false;
    this.group.add(this.warmFood);
  }

  endPrewarm() { if (this.warmFood) { this.group.remove(this.warmFood); this.warmFood = null; } }

  buildMesh(e) {
    const spine = [];
    for (let i = 0; i < EEL_POINTS; i++) spine.push(e.pts[i].clone());
    e.uSpine = uniformArray(spine);
    e.uColA = uniform(e.colA.clone());
    e.uColB = uniform(e.colB.clone());
    e.uRadius = uniform(e.radius);
    e.uSquash = uniform(1);
    e.uPattern = uniform(new THREE.Vector4(e.stripeFreq, e.spotFreq, e.wavy, e.pulseRate));
    e.uWeights = uniform(new THREE.Vector3(e.wStripe, e.wSpot, e.wFlank));
    e.uSeed = uniform(e.index * 17.3 + 3.1);
    e.uExcite = uniform(0);
    const U = this.U;

    const vNormal = varying(vec3(0), 'vEelN');
    const vWorld = varying(vec3(0), 'vEelP');
    const vUV = varying(vec2(0), 'vEelUV');

    const buildPosition = (radiusScale) => Fn(() => {
      const t = attribute('aT', 'float');
      const ang = attribute('aAng', 'float');
      const segF = t.mul(EEL_POINTS - 1);
      const i0 = int(floor(segF)).min(EEL_POINTS - 2);
      const f = segF.sub(float(i0));
      const p0 = e.uSpine.element(i0);
      const p1 = e.uSpine.element(i0.add(1));
      const pos = mix(p0, p1, f);
      const tangent = normalize(p1.sub(p0).add(vec3(1e-4, 0, 0)));
      // Epsilon keeps the frame finite if a segment ever points straight up or down.
      const b = normalize(cross(tangent, vec3(0, 1, 0)).add(vec3(1e-5, 0, 1e-5)));
      const n = cross(b, tangent);
      // Body profile: blunt head, long taper; eels are a little taller than wide.
      const profile = smoothstep(0.0, 0.10, t).mul(t.oneMinus().pow(0.6)).mul(1.15);
      const r = e.uRadius.mul(profile).mul(radiusScale);
      const ca = cos(ang), sa = sin(ang);
      const offset = n.mul(ca.mul(1.0)).add(b.mul(sa.mul(e.uSquash).mul(0.8)));
      const world = pos.add(offset.mul(r));
      vNormal.assign(normalize(n.mul(ca).add(b.mul(sa))));
      vWorld.assign(world);
      vUV.assign(vec2(t, ang));
      return world;
    })();

    const emission = Fn(() => {
      const t = vUV.x, ang = vUV.y;
      const time = U.time;
      const stripes = smoothstep(0.35, 0.65, sin(t.mul(e.uPattern.x).mul(TWO_PI).add(sin(ang.add(t.mul(6))).mul(e.uPattern.z)).sub(time.mul(0.6))).mul(0.5).add(0.5));
      const spotsN = valueNoise2(vec2(t.mul(e.uPattern.y), ang.mul(1.2).add(e.uSeed)));
      const spots = smoothstep(0.62, 0.8, spotsN);
      const flank = smoothstep(0.05, 0.35, abs(cos(ang))).oneMinus();
      const pulse = sin(time.mul(e.uPattern.w).sub(t.mul(7)).add(e.uSeed)).mul(0.25).add(0.85);
      const glowA = e.uColA.mul(stripes.mul(e.uWeights.x).add(flank.mul(e.uWeights.z)));
      const glowB = e.uColB.mul(spots.mul(e.uWeights.y));
      const eyeT = smoothstep(0.0, 0.05, t).oneMinus();
      return glowA.add(glowB).mul(pulse).mul(e.uExcite.mul(0.8).add(1)).add(eyeT.mul(0.3));
    });

    const bodyMat = new THREE.NodeMaterial();
    bodyMat.positionNode = buildPosition(1);
    bodyMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const L = this.shading.lightDir();
      const lambert = dot(n, L).max(0).mul(0.5).add(0.1);
      const body = vec3(0.03, 0.035, 0.05).mul(U.moonColor).mul(lambert);
      const glow = emission();
      const rim = dot(n, vec3(0, 1, 0)).max(0).oneMinus().pow(2).mul(0.4);
      const depthFrac = vWorld.y.negate().div(DEPTH).clamp(0, 1);
      return vec4(body.add(glow).add(glow.mul(rim)), depthFrac);
    })();
    bodyMat.side = THREE.FrontSide;

    // Halo: a fatter additive shell; alpha blend keeps the RT's depth channel from the body.
    const haloMat = new THREE.NodeMaterial();
    haloMat.positionNode = buildPosition(2.4);
    haloMat.fragmentNode = Fn(() => {
      const n = normalize(vNormal);
      const edge = dot(n, vec3(0, 1, 0)).max(0);
      const glow = emission().mul(0.16).mul(edge.pow(1.5));
      return vec4(glow, 0);
    })();
    haloMat.transparent = true;
    haloMat.blending = THREE.CustomBlending;
    haloMat.blendSrc = THREE.OneFactor;
    haloMat.blendDst = THREE.OneFactor;
    haloMat.blendSrcAlpha = THREE.ZeroFactor;
    haloMat.blendDstAlpha = THREE.OneFactor;
    haloMat.depthWrite = false;
    haloMat.side = THREE.FrontSide;

    e.body = new THREE.Mesh(this.geometry, bodyMat);
    e.halo = new THREE.Mesh(this.geometry, haloMat);
    e.body.frustumCulled = e.halo.frustumCulled = false;
    e.halo.renderOrder = 5;

    const eyeGeo = new THREE.SphereGeometry(1, 8, 6);
    const eyeMat = new THREE.NodeMaterial();
    eyeMat.fragmentNode = Fn(() => vec4(vec3(1.0, 0.98, 0.9), positionWorld.y.negate().div(DEPTH).clamp(0, 1)))();
    e.eyes = [new THREE.Mesh(eyeGeo, eyeMat), new THREE.Mesh(eyeGeo, eyeMat)];
    e.eyes.forEach((m) => { m.scale.setScalar(e.radius * 0.2); this.group.add(m); });
    this.group.add(e.body, e.halo);
  }

  setView(w, h) { this.view.w = w; this.view.h = h; for (const e of this.eels) { e.view.w = w; e.view.h = h; } }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
    if (!on) for (let i = 0; i < EEL_COUNT; i++) { this.U.eelPos.array[i].set(0, -99, 0); this.U.eelCol.array[i].setRGB(0, 0, 0); }
  }

  /* Interaction entry points (world xz). */
  spook(x, z, strength = 1) {
    this.spooks.push({ x, z, t: this.time, strength });
    if (this.spooks.length > 16) this.spooks.shift();
  }
  lure(x, z) {
    this.lures.push({ x, z, t: this.time });
    if (this.lures.length > 40) this.lures.shift();
  }
  feed(x, z, amount = 1) {
    const mesh = new THREE.Mesh(this.foodGeo, this.foodMat);
    mesh.position.set(x, -0.05, z);
    this.group.add(mesh);
    this.foods.push({ x, z, y: -0.05, amount, mesh, claims: 0, vy: 0 });
    if (this.foods.length > 24) { const f = this.foods.shift(); this.group.remove(f.mesh); }
  }
  vortex(x, z, radius) {
    this.vortices.push({ x, z, t: this.time, radius: Math.max(radius, 1.2), strength: 1 });
  }
  recolor() {
    for (const e of this.eels) {
      e.rollColors(this.rng);
      e.rollPattern(this.rng);
      e.uColA.value.copy(e.colA); e.uColB.value.copy(e.colB);
      e.uPattern.value.set(e.stripeFreq, e.spotFreq, e.wavy, e.pulseRate);
      e.uWeights.value.set(e.wStripe, e.wSpot, e.wFlank);
    }
  }

  steer(e, dt) {
    const now = this.time;
    const rng = e.rng;
    const head = e.head;
    const force = tmpA.set(0, 0, 0);
    let speedMul = 1;
    let excite = 0;

    // Inside a tunnel run: reach the mouth, then aim straight through to the far mouth, holding axis height.
    if (e.tunnel) {
      const dxz = Math.hypot(e.target.x - head.x, e.target.z - head.z);
      if (e.tunnel.stage === 0 && dxz < 0.5) { e.tunnel.stage = 1; e.target.copy(e.tunnel.exit); }
      else if (e.tunnel.stage === 1 && dxz < 0.4) { e.tunnel.stage = 2; e.target.copy(e.tunnel.runout); }
      else if (e.tunnel.stage === 2 && dxz < 0.5) { e.tunnel = null; e.pickTarget(now, rng); }
      if (e.tunnel) { e.targetY = e.tunnel.entry.y; e.retargetYAt = now + 2; }
    }
    // Never abandon a run mid-bore: turning around inside the log drags the body through its wall.
    if ((now > e.retargetAt && e.tunnel?.stage !== 1) || (!e.tunnel && head.distanceTo(e.target) < 0.6)) e.pickTarget(now, rng);
    tmpB.subVectors(e.target, head); tmpB.y = 0; tmpB.normalize();
    force.addScaledVector(tmpB, e.tunnel ? 1.4 : 0.6);

    // Spooks: strong, short-lived push away, with a speed burst.
    for (const s of this.spooks) {
      const age = now - s.t;
      if (age > 1.6) continue;
      const dx = head.x - s.x, dz = head.z - s.z;
      const d = Math.hypot(dx, dz);
      if (d > 3.5) continue;
      const k = (1 - age / 1.6) * s.strength * (1 - d / 3.5);
      force.x += (dx / (d + 0.05)) * k * 6;
      force.z += (dz / (d + 0.05)) * k * 6;
      speedMul = Math.max(speedMul, 1 + 1.4 * k);
      excite = Math.max(excite, k);
      if (k > 0.5 && now > e.fleeUntil) { e.fleeUntil = now + 1; this.onEvent?.('startle', e); }
    }

    // Lures: drag trails older than a second pull gently, eels nose in to look.
    for (const l of this.lures) {
      const age = now - l.t;
      if (age < 1.0 || age > 9) continue;
      const dx = l.x - head.x, dz = l.z - head.z;
      const d = Math.hypot(dx, dz);
      if (d > 6 || d < 0.4) continue;
      const k = 0.35 * (1 - age / 9);
      force.x += (dx / d) * k; force.z += (dz / d) * k;
    }

    // Food: pick the least-crowded nearby crumb; spreading out is the whole point.
    if (this.foods.length) {
      let best = null, bestScore = Infinity;
      for (const f of this.foods) {
        if (f.amount <= 0) continue;
        const d = Math.hypot(f.x - head.x, f.z - head.z);
        const score = d + f.claims * 2.2 - (e.food === f ? 1.0 : 0);
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
        const log = this.colliders.logs[0];
        let pull = 4.0;
        if (log && segDist(best.x, best.z, log.a.x, log.a.z, log.b.x, log.b.z) < log.rOuter) {
          if (!e.tunnel) {
            const nearA = Math.hypot(log.a.x - head.x, log.a.z - head.z) < Math.hypot(log.b.x - head.x, log.b.z - head.z);
            e.startTunnel(nearA ? log.a : log.b, nearA ? log.b : log.a, now);
          }
          if (segDist(head.x, head.z, log.a.x, log.a.z, log.b.x, log.b.z) > log.rInner) pull = 0;
        }
        force.x += (dx / (d + 0.01)) * pull; force.z += (dz / (d + 0.01)) * pull;
        speedMul = Math.max(speedMul, 1.5);
        e.targetY = Math.max(e.targetY, -0.25);
        if (d < 0.35) {
          best.amount -= dt * 0.6;
          excite = Math.max(excite, 0.5);
          if (best.amount <= 0) { this.onEvent?.('eat', e); }
        }
      }
    } else if (e.food) { e.food = null; }

    // Vortex: swirl around the center with a slight inward pull, so they spiral.
    for (const v of this.vortices) {
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

    // Steer around rocks and the log wall before the head touches them (a shoved head kinks the trail).
    // Reach grows with speed: a bolting eel turns no faster, so it has to start the turn earlier.
    const lookahead = 0.5 + 0.45 * (e.speedMul - 1);
    for (const o of this.colliders.spheres) {
      const dx = head.x - o.x, dz = head.z - o.z;
      const d = Math.hypot(dx, dz), reach = o.r + lookahead;
      if (d < reach && d > 1e-4) { const k = (1 - d / reach) * 2.5; force.x += (dx / d) * k; force.z += (dz / d) * k; }
    }
    if (!e.tunnel) {
      for (const l of this.colliders.logs) {
        // force aliases tmpA, so this block keeps to its own temporaries.
        axis.subVectors(l.b, l.a); rel.subVectors(head, l.a);
        const t = Math.max(0, Math.min(1, rel.dot(axis) / axis.lengthSq()));
        nearest.copy(l.a).addScaledVector(axis, t);
        const dx = head.x - nearest.x, dz = head.z - nearest.z;
        const d = Math.hypot(dx, dz), reach = l.rOuter + lookahead;
        if (d < reach && d > 1e-4) { const k = (1 - d / reach) * 2.5; force.x += (dx / d) * k; force.z += (dz / d) * k; }
      }
    }

    // Stay near the view: past ~70% of a viewport beyond the edge, turn back.
    const limX = this.view.w * 0.7, limZ = this.view.h * 0.7;
    if (Math.abs(head.x) > limX) force.x -= Math.sign(head.x) * 3;
    if (Math.abs(head.z) > limZ) force.z -= Math.sign(head.z) * 3;

    if (this.motion.reduced) speedMul = Math.min(speedMul, 1) * 0.35;

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

    // Depth wandering.
    if (now > e.retargetYAt) { e.targetY = rng.range(-DEPTH + e.radius * 2.2, -e.radius * 1.6); e.retargetYAt = now + rng.range(4, 10); }
    const speed = e.baseSpeed * e.speedMul;
    const wob = Math.sin(now * e.waveFreq * (1 + (e.speedMul - 1) * 0.6) + e.phase) * e.waveAmp * speed;
    const side = tmpC.set(-e.heading.z, 0, e.heading.x);
    head.addScaledVector(e.heading, speed * dt);
    head.addScaledVector(side, wob * dt * 6);
    head.y += (e.targetY - head.y) * Math.min(1, dt * 0.8);

    e.squash += ((1 + (e.speedMul - 1) * 0.18) - e.squash) * Math.min(1, dt * 5);
    e.uSquash.value = e.squash;

    // Surface wake when swimming shallow.
    if (head.y > -0.15 && now > e.rippleAt && !this.motion.reduced) {
      e.rippleAt = now + 0.3;
      this.sim.addDrop(head.x, head.z, 0.45 + e.radius, 0.008 * speed);
    }
  }

  /* The body slides along the path the head took (snake-style), so turns flow down the length
     instead of the tail being dragged sideways. Collision pushes live in a decaying offset layer. */
  followBody(e, dt) {
    const now = this.time;
    const pts = e.pts;
    const head = pts[0];
    // Record the path only when the head has actually advanced; shoves and dithering never enter it.
    tmpB.subVectors(head, e.trailAt(0));
    if (tmpB.length() > 0.03 && tmpB.dot(e.heading) > 0) e.pushTrail(head);
    const ampMul = 1 + (e.speedMul - 1) * 0.8;
    // Segment -1 runs from the live head to the newest recorded point, so the body never lags the head.
    const last = e.trailCount - 1;
    let seg = -1, segStart = head, segEnd = e.trailAt(0);
    let segLen = segStart.distanceTo(segEnd), walked = 0;
    for (let i = 1; i < pts.length; i++) {
      const want = i * e.spacing;
      while (walked + segLen < want && seg < last - 1) {
        walked += segLen; seg++;
        segStart = e.trailAt(seg); segEnd = e.trailAt(seg + 1);
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
      // Perpendicular sine that grows toward the tail.
      const phase = now * e.waveFreq * (1 + (e.speedMul - 1) * 0.5) + e.phase - i * 0.42;
      const amt = Math.sin(phase) * e.waveAmp * ampMul * Math.min(i / 6, 1) * 0.4;
      const q = pts[i - 1];
      tmpC.subVectors(q, p); const d = tmpC.length() || 1e-4;
      p.x += (-tmpC.z / d) * amt; p.z += (tmpC.x / d) * amt;
      // Leftover collision push, fading so the body eases back onto its path.
      const off = e.offsets[i];
      off.multiplyScalar(OFF_DECAY);
      p.add(off);
    }
  }

  /* Integrates the residual collision push into the offset layer. The push is what remained after the
     stored offset was applied, so adding it converges on the full displacement; a lerp stalls at half. */
  rememberPushes(e) {
    for (let i = 1; i < e.pts.length; i++) { tmpA.copy(e.pts[i]).sub(e.prev[i]); e.offsets[i].addScaledVector(tmpA, 0.5); }
  }

  collide() {
    const eels = this.eels;
    const floorY = -DEPTH;
    const { spheres, logs } = this.colliders;
    // Bounding sphere per eel so distant pairs skip the 24×24 point test.
    for (const e of eels) {
      const c = e.pts[EEL_POINTS >> 1];
      let r2 = 0;
      for (const p of e.pts) r2 = Math.max(r2, p.distanceToSquared(c));
      e.boundR = Math.sqrt(r2) + e.radius;
    }
    for (let pass = 0; pass < 1; pass++) {
      for (let a = 0; a < eels.length; a++) {
        const ea = eels[a];
        const ca = ea.pts[EEL_POINTS >> 1];
        for (let i = 0; i < EEL_POINTS; i++) {
          const p = ea.pts[i];
          const r = ea.radius;
          const soft = i === 0 ? 0.35 : 1;   // the head eases out of contact; a full shove kinks the trail
          if (p.y < floorY + r + 0.08) p.y = floorY + r + 0.08;   // floor has bumps up to ~0.08
          if (p.y > -r * 0.5) p.y = -r * 0.5;
          for (const s of spheres) {
            // A rock reaching the surface band pushes sideways only; pushing up there just fights the ceiling clamp.
            const dx = p.x - s.x, dy = s.y + s.r > -r * 2 ? 0 : p.y - s.y, dz = p.z - s.z;
            const d = Math.hypot(dx, dy, dz), min = s.r + r;
            if (d < min && d > 1e-5) { const k = (min - d) / d * soft; p.x += dx * k; p.y += dy * k; p.z += dz * k; }
          }
          for (const l of logs) {
            // Distance to the log's axis segment; inside the bore is fine, the wall is not.
            tmpA.subVectors(l.b, l.a); const len2 = tmpA.lengthSq();
            tmpB.subVectors(p, l.a);
            const t = Math.max(0, Math.min(1, tmpB.dot(tmpA) / len2));
            tmpC.copy(l.a).addScaledVector(tmpA, t);
            const dx = p.x - tmpC.x, dy = p.y - tmpC.y, dz = p.z - tmpC.z;
            const d = Math.hypot(dx, dy, dz);
            const endCap = t <= 0 || t >= 1;
            if (endCap) continue;
            const inner = l.rInner - r, outer = l.rOuter + r;
            if (d > inner && d < outer && d > 1e-5) {
              const toInner = d - inner, toOuter = outer - d;
              const k = (toInner < toOuter ? -toInner : toOuter) / d * soft;
              p.x += dx * k; p.y += dy * k; p.z += dz * k;
            }
          }
          for (let b = a + 1; b < eels.length; b++) {
            const eb = eels[b];
            if (i === 0) eb.skip = ca.distanceTo(eb.pts[EEL_POINTS >> 1]) > ea.boundR + eb.boundR;
            if (eb.skip) continue;
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
  }

  /* Distance constraints with a tolerance band: the path-following pose already spaces the chain, so this
     only acts where a collision push tore or bunched it, sharing the correction between both neighbors. */
  constrain(e) {
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

  syncUniforms(alpha) {
    const U = this.U;
    for (const e of this.eels) {
      for (let i = 0; i < EEL_POINTS; i++) e.uSpine.array[i].copy(e.show[i].copy(e.pose0[i]).lerp(e.pts[i], alpha));
      // Eye placement from the head frame.
      const h = e.show[0], n1 = e.show[1];
      tmpA.subVectors(h, n1).normalize();
      tmpB.crossVectors(tmpA, UP).normalize();
      const r = e.radius * 0.95;
      // Seated where the head profile is nearly full radius, sunk slightly into the body.
      e.eyes[0].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, r * 0.62);
      e.eyes[1].position.copy(h).addScaledVector(tmpA, -e.radius * 1.5).addScaledVector(tmpB, -r * 0.62);
      e.eyes[0].position.y += r * 0.22; e.eyes[1].position.y += r * 0.22;
      const mid = e.show[Math.floor(EEL_POINTS * 0.3)];
      U.eelPos.array[e.index].copy(mid);
      U.eelCol.array[e.index].copy(e.colA).lerp(e.colB, 0.3).multiplyScalar(0.7 + e.uExcite.value * 0.6);
    }
    for (const f of this.foods) {
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.scale.setScalar(Math.max(0.2, Math.min(1, f.amount)));
    }
  }

  /* Fixed-rate solve: the chain and its collision memory behave the same at 60 and 240 Hz. */
  update(dt) {
    if (!this.enabled) { this.time += dt; return; }
    this.acc = Math.min((this.acc || 0) + dt, TICK * 3);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick(TICK);
    }
    this.syncUniforms(this.acc / TICK);
  }

  tick(dt) {
    this.time += dt;
    for (const e of this.eels) for (let i = 0; i < EEL_POINTS; i++) e.pose0[i].copy(e.pts[i]);
    for (const e of this.eels) this.steer(e, dt);
    for (const e of this.eels) this.followBody(e, dt);
    for (const e of this.eels) for (let i = 0; i < EEL_POINTS; i++) e.prev[i].copy(e.pts[i]);
    this.collide();
    for (const e of this.eels) this.constrain(e);
    for (const e of this.eels) this.rememberPushes(e);
    // Food sinks slowly, then rests on the sand; spent crumbs disappear.
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i];
      f.y = Math.max(-DEPTH + 0.05, f.y - dt * 0.12);
      if (f.amount <= 0) { this.group.remove(f.mesh); this.foods.splice(i, 1); }
    }
    expire(this.spooks, this.time, 1.6);
    expire(this.lures, this.time, 9);
    expire(this.vortices, this.time, 7);
  }

  dispose() {
    this.geometry.dispose();
    for (const e of this.eels) { e.body.material.dispose(); e.halo.material.dispose(); }
    this.foodGeo.dispose(); this.foodMat.dispose();
  }
}
