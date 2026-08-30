import * as THREE from 'three/webgpu';
import { EEL_POINTS, DEPTH } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { TICK, TRAIL_LEN, segDist, pushTrail, followBody, collide, constrain, rememberPushes, tailAmp, growEel } from './eel-physics.js';
import { expire, pickTarget, steer } from './eel-behavior.js';
import { EelRenderer } from './eel-render.js';
import { drawCast, pickAbsent, applyIdentity, rollIdentityColors, rollIdentityPattern, rollNickname } from './eel-identity.js';

export class Eel {
  constructor(index, seed, extent, colliders, view, identity) {
    this.view = view;
    this.index = index;
    this.identity = identity;
    this.rng = createRng(deriveSeed(seed, 1000 + index));
    const rng = this.rng;
    // Identity sets name, build, speeds (in body lengths/s), and traits; the rolls below stay universal.
    applyIdentity(this, identity, rng);
    this.spacing = this.length / (EEL_POINTS - 1);
    this.baseLength = this.length;   // snake growth resets here after a SLURP
    this.ampRatio = rng.range(0.05, 0.07);   // tail-tip half-amplitude fraction; real eels run ~0.10 L but that thrashes at our scale
    this.ampTail = tailAmp(this);
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
    this.stuckFor = 0;
    this.nopeZig = 0;
    this.attnReset = false;
    this.slurpedBy = null;
    this.offscreenFor = 0;   // seconds the whole body has been out of view; 5 buys an identity swap
    this.rollColors(rng);
    this.rollPattern(rng);
    this.rollNick(rng);   // last, so the draw never shifts the color and pattern streams above it
  }

  rollColors(rng) { rollIdentityColors(this, this.identity, rng); }

  rollPattern(rng) { rollIdentityPattern(this, this.identity, rng); }

  rollNick(rng) { rollNickname(this, this.identity, rng); }

  get head() { return this.pts[0]; }
}

// The shim fans out across every type the pond emits; a new event type belongs here too.
const EVENT_TYPES = ['startle', 'eat', 'slurp', 'nibble', 'swap'];

export class EelSystem {
  constructor(scene, U, shading, seed, extent, colliders, sim, motion, view, opts = {}) {
    this.view = view;
    this.scene = scene;
    this.U = U;
    this.shading = shading;
    this.sim = sim;
    this.motion = motion;          // { reduced: bool }
    this.extent = extent;
    this.colliders = colliders;
    this.rng = createRng(deriveSeed(seed, 5));
    // Live appearance layers, reachable as pond.eels.knobs; skin 0 is the pre-ramp look for an A/B.
    this.knobs = { skin: 0.3, glow: 1.0 };
    this.eels = [];
    this.guests = [];              // Eleanor-class residents: own brain, shared physics and renderer
    this.perfHot = false;          // set by main's frame-time watcher; gates guest visits
    this.rain = null;              // the shower scheduler, one shared reference: behavior reads its envelope
    this.habitat = null;           // the cover registry; pads become loiter targets once it is set
    this.feedRecent = 0;           // decaying feed-spree meter; the residents eat too fast for a stock check
    this.spooks = [];              // { x, z, t, strength }
    this.lures = [];               // curiosity points from drags: { x, z, t }
    this.foods = [];               // { x, z, y, amount, mesh, claims }
    this.vortices = [];            // { x, z, t, strength, radius }
    this.time = 0;
    // Listeners live before the eels do: anything built below may already emit.
    this.listeners = new Map();    // type → fn[]
    this.shim = null;
    this.shimFn = null;
    this.renderer = new EelRenderer(scene, U, shading, this.knobs);
    this.group = this.renderer.group;
    // A pinned ?cast= is a test rig, so it also freezes the rotation; a seeded draw keeps swapping.
    this.hotSwap = !opts.cast;   // null means no ?cast= at all; [] is a bare ?cast= that pins the seeded draw
    const cast = drawCast(seed, opts.cast ?? []);
    for (let i = 0; i < cast.length; i++) {
      const e = new Eel(i, seed, extent, colliders, view, cast[i]);
      pickTarget(this, e, 0);
      this.eels.push(e);
      this.renderer.buildMesh(e);
    }
    // Bonds resolve by name; a crush on someone not in the pond (Eleanor, for now) stays unrequited.
    for (const e of this.eels) {
      e.partner = e.quirks.follows ? this.eels.find((o) => o.name === e.quirks.follows) ?? null : null;
      e.flock = this.eels;
    }
    this.enabled = true;
  }

  endPrewarm() { this.renderer.endPrewarm(); }

  /* Subscribe/unsubscribe. Many consumers per type: a single assigned callback let the second one win. */
  on(type, fn) {
    const list = this.listeners.get(type);
    if (!list) this.listeners.set(type, [fn]);
    else if (!list.includes(fn)) list.push(fn);
  }

  off(type, fn) {
    const list = this.listeners.get(type);
    const i = list ? list.indexOf(fn) : -1;
    if (i >= 0) list.splice(i, 1);
  }

  /* One payload for every consumer, pan included, so nobody re-derives the world → stereo mapping. */
  emit(type, eel, extra) {
    const list = this.listeners.get(type);
    if (!list || !list.length) return;
    const h = eel.head;
    const payload = {
      type,
      x: h.x, y: h.y, z: h.z,
      // 0.8 keeps even edge-huggers a little off the speaker wall.
      pan: Math.max(-1, Math.min(1, h.x / (this.view.w / 2))) * 0.8,
      source: this.guests.includes(eel) ? 'eleanor' : 'eel',
      size: extra?.size,
      length: eel.length,
      eel,
      food: extra ?? null,
    };
    for (const fn of list.slice()) fn(payload);
  }

  /* Compatibility shim: one wrapper across every type, still called as (type, eel, food). */
  set onEvent(fn) {
    if (this.shim) for (const t of EVENT_TYPES) this.off(t, this.shim);
    this.shimFn = fn ?? null;
    this.shim = fn ? (p) => fn(p.type, p.eel, p.food) : null;
    if (this.shim) for (const t of EVENT_TYPES) this.on(t, this.shim);
  }

  get onEvent() { return this.shimFn; }

  setView(w, h) { this.view.w = w; this.view.h = h; for (const e of this.eels) { e.view.w = w; e.view.h = h; } }

  setEnabled(on) {
    this.enabled = on;
    this.renderer.setEnabled(on);
    if (!on) for (const e of this.eels) if (e.coverSpot?.type === 'pad') e.coverSpot = null;
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
    // Size bucket picks the eel-eat-* variant when the crumb finishes: 1 big, 2 crumb, 3 tiny.
    const size = amount >= 0.75 ? 1 : amount >= 0.3 ? 2 : 3;
    this.foods.push({ x, z, y: -0.05, amount, size, mesh, claims: 0, vy: 0, growPerAmt: 0.02 });
    this.feedRecent += amount;
    if (this.foods.length > 24) { const f = this.foods.shift(); this.group.remove(f.mesh); }
  }
  vortex(x, z, radius) {
    this.vortices.push({ x, z, t: this.time, radius: Math.max(radius, 1.2), strength: 1 });
  }
  recolor() {
    for (const e of this.eels) {
      e.rollColors(this.rng);
      e.rollPattern(this.rng);
      e.rollNick(this.rng);
      this.renderer.applyAppearance(e);
    }
    this.applyKnobs();
  }

  /* Trade one resident for an identity nobody is wearing. Only ever called off-screen, so a whole new
     build, palette, and length can land in a single frame without anything popping in view. */
  swapIdentity(e, id = null) {
    if (!e || e.slurpedBy) return false;
    const names = this.eels.map((o) => o.name);
    // A named swap (console) still has to obey the pool: active, and not already on screen.
    if (id && (id.active === false || names.includes(id.name))) return false;
    const to = id ?? pickAbsent(this.rng, names);
    if (!to) return false;
    const from = e.name, oldLen = e.length;
    e.identity = to;
    applyIdentity(e, to, e.rng);
    // applyIdentity rolls the new length straight onto the eel; growEel is the only path that carries
    // spacing, ampTail, and the trail buffer with it, so hand the delta back through it.
    const want = e.length;
    e.length = oldLen;
    growEel(e, want - oldLen);
    e.baseLength = e.length;
    e.uRadius.value = e.radius;
    for (const m of e.eyes) m.scale.setScalar(e.radius * 0.2);
    e.rollColors(e.rng);
    e.rollPattern(e.rng);
    e.rollNick(e.rng);
    this.renderer.applyAppearance(e);
    // The plan belonged to the eel who left: drop the crumb claim, the perch, and the run.
    if (e.food) { e.food.claims = Math.max(0, e.food.claims - 1); e.food = null; }
    e.coverSpot = null;
    e.tunnel = null;
    e.gaitUntil = 0;
    e.retargetAt = 0;
    e.speedBL = e.prowlBL;
    // Whole flock, not just the swapped eel: someone's partner may have just walked out of the pond.
    for (const o of this.eels) {
      o.partner = o.quirks.follows
        ? this.eels.find((p) => p.name === o.quirks.follows) ?? this.guests.find((g) => g.name === o.quirks.follows) ?? null
        : null;
    }
    this.emit('swap', e, { from, to: e.name });
    return true;
  }

  /* Push the live skin/glow layers at everyone, guests included, after tweaking pond.eels.knobs. */
  applyKnobs() {
    const { skin, glow } = this.knobs;
    for (const e of this.eels) e.uLayers.value.set(skin * e.skinMul, glow);
    for (const g of this.guests) g.uLayers.value.set(skin * g.skinMul, glow);
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
    for (const g of this.guests) this.renderer.syncGuest(g, this.acc / TICK);
  }

  tick(dt) {
    this.time += dt;
    const all = this.guests.length ? this.eels.concat(this.guests) : this.eels;
    for (const e of all) for (let i = 0; i < EEL_POINTS; i++) e.pose0[i].copy(e.pts[i]);
    // A slurped eel forgets its pad; nothing else clears a loiter it can no longer hold.
    for (const e of all) if (e.slurpedBy && e.coverSpot?.type === 'pad') e.coverSpot = null;
    for (const e of all) if (!e.slurpedBy) (e.brain || steer)(this, e, dt);
    // The cast rotates where nobody is looking: every spine point (halo included) past the view rectangle.
    // A head-only test with a body-length margin sat beyond the 0.7-view turn-back line on the short axis.
    const hw = this.view.w * 0.5, hh = this.view.h * 0.5;
    for (const e of this.eels) {
      if (e.slurpedBy || e.tunnel) continue;
      const r = e.radius * 2.5;
      const off = e.pts.every((p) => Math.abs(p.x) > hw + r || Math.abs(p.z) > hh + r);
      e.offscreenFor = off ? e.offscreenFor + dt : 0;
      if (this.hotSwap && e.offscreenFor >= 5) { this.swapIdentity(e); e.offscreenFor = 0; }
    }
    for (const e of all) if (!e.slurpedBy) followBody(e);
    for (const e of all) for (let i = 0; i < EEL_POINTS; i++) e.prev[i].copy(e.pts[i]);
    collide(all, this.colliders);
    for (const e of all) if (!e.slurpedBy) constrain(e);
    for (const e of all) if (!e.slurpedBy) rememberPushes(e);
    // Food sinks slowly, then rests on the sand; spent crumbs disappear.
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i];
      f.y = Math.max(-DEPTH + 0.05, f.y - dt * 0.12);
      if (f.amount <= 0) { this.group.remove(f.mesh); this.foods.splice(i, 1); }
    }
    this.feedRecent *= Math.exp(-dt / 6);
    expire(this.spooks, this.time, 1.6);
    expire(this.lures, this.time, 9);
    expire(this.vortices, this.time, 7);
  }

  dispose() { this.renderer.dispose(this.eels.concat(this.guests)); }
}
