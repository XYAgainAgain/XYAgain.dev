import * as THREE from 'three/webgpu';
import { EEL_COUNT, EEL_POINTS, DEPTH } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { TICK, TRAIL_LEN, segDist, pushTrail, followBody, collide, constrain, rememberPushes } from './eel-physics.js';
import { expire, pickTarget, steer } from './eel-behavior.js';
import { EelRenderer } from './eel-render.js';
import { identityFor, applyIdentity, rollIdentityColors, rollIdentityPattern } from './eel-identity.js';

class Eel {
  constructor(index, seed, extent, colliders, view, identity) {
    this.view = view;
    this.index = index;
    this.identity = identity;
    this.rng = createRng(deriveSeed(seed, 1000 + index));
    const rng = this.rng;
    // Identity sets name, build, speeds (in body lengths/s), and traits; the rolls below stay universal.
    applyIdentity(this, identity, rng);
    this.spacing = this.length / (EEL_POINTS - 1);
    this.ampTail = this.length * rng.range(0.08, 0.11);   // half-amplitude at the tail tip
    this.wavePhase = rng.range(0, Math.PI * 2);
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
    for (let i = EEL_POINTS - 1; i >= 0; i--) pushTrail(this, this.pts[i]);
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
    this.gait = 'prowl';
    this.gaitUntil = 0;
    this.speedBL = this.prowlBL;
    this.waveK = 0;
    this.anterior = 0.3;
    this.ampMul = 1;
    this.reverse = false;
    this.nopeUntil = 0;
    this.coverSpot = null;
    this.flock = null;
    this.rollColors(rng);
    this.rollPattern(rng);
  }

  rollColors(rng) { rollIdentityColors(this, this.identity, rng); }

  rollPattern(rng) { rollIdentityPattern(this, this.identity, rng); }

  get head() { return this.pts[0]; }
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
    this.renderer = new EelRenderer(scene, U, shading);
    this.group = this.renderer.group;
    for (let i = 0; i < EEL_COUNT; i++) {
      const e = new Eel(i, seed, extent, colliders, view, identityFor(i));
      pickTarget(e, 0);
      this.eels.push(e);
      this.renderer.buildMesh(e);
    }
    // Bonds resolve by name; a crush on someone not in the pond (Eleanor, for now) stays unrequited.
    for (const e of this.eels) {
      e.partner = e.quirks.follows ? this.eels.find((o) => o.name === e.quirks.follows) ?? null : null;
      e.flock = this.eels;
    }
    this.enabled = true;
    this.onEvent = null;           // audio hook: (type, eel) =>
  }

  endPrewarm() { this.renderer.endPrewarm(); }

  setView(w, h) { this.view.w = w; this.view.h = h; for (const e of this.eels) { e.view.w = w; e.view.h = h; } }

  setEnabled(on) {
    this.enabled = on;
    this.renderer.setEnabled(on);
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
    const mesh = this.renderer.createFoodMesh();
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
      this.renderer.applyAppearance(e);
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
    this.renderer.sync(this.eels, this.foods, this.acc / TICK);
  }

  tick(dt) {
    this.time += dt;
    for (const e of this.eels) for (let i = 0; i < EEL_POINTS; i++) e.pose0[i].copy(e.pts[i]);
    for (const e of this.eels) steer(this, e, dt);
    for (const e of this.eels) followBody(e);
    for (const e of this.eels) for (let i = 0; i < EEL_POINTS; i++) e.prev[i].copy(e.pts[i]);
    collide(this.eels, this.colliders);
    for (const e of this.eels) constrain(e);
    for (const e of this.eels) rememberPushes(e);
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

  dispose() { this.renderer.dispose(this.eels); }
}
