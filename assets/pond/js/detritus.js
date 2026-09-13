import { INF_SLOTS, DEPTH } from './config.js';
import { createRng, deriveSeed } from './rng.js';
import { capsuleInfluenceCPU } from './shading.js';
import {
  COUNTS, STICK_POOL, CARD_POOL, CHUNK_POOL, SHELTER_STICKS, TRAY_SLOTS, SALT, MARGIN, MAX_DT, SINK,
  STATION_SLOTS, WAKE_SLOTS,
  detritusKnobs, layoutDetritus, makeContactOut, stepItem, respawnItem, offFrame, age01, itemFinite,
  makeRingList, pushRing, pruneRings, ringPush, swellSlope, matEdge, resolveStations,
  makeTray, trayLive, offerSink, stepCardLife,
  driftWake, impactWake, resolveStickPairs, handPush,
} from './detritus-core.js';

/* Floating litter, CPU side: the 47-item cast's drift, turning, contact, and sink, filling the instance
   buffers detritus-render.js draws. No scene objects live here. */

const EEL_FORCE = 0.55;                        // units/s² a passing body lends a floating piece
const POKE_MAX = 16;                           // sub-frame pointer samples honored per tick

class DetritusSystem {
  constructor({
    U = null, seed = 0, view = null, extent = 0, wind = null, current = null, contact = null,
    knobs = null, matField = null, floorAt = null,
  } = {}) {
    this.U = U;
    this.seed = seed;
    this.t = 0;
    this.respawned = 0;
    this.tray = makeTray();
    // The dials live in whatever knob bag the caller keeps (pond.eels.knobs.detritus once main hands
    // over eels.knobs), so a taste pass retunes the flow, the turning, and the sink without a reload.
    if (knobs) {
      if (!knobs.detritus) knobs.detritus = detritusKnobs();
      this.knobs = knobs.detritus;
    } else this.knobs = detritusKnobs();
    const half = extent > 0 ? extent / 2 : 0;
    this.rect = view
      ? { ex: view.w / 2 + MARGIN, ez: view.h / 2 + MARGIN }
      : { ex: half + MARGIN, ez: half + MARGIN };
    // An empty pond is a legal pond: with no helper every query is open water.
    this.contact = contact ?? (() => 0);
    this.current = current ?? ((x, z, t, out) => this.currentFromU(x, z, t, out));
    this.wind = wind;
    // floaters.memAt when main hands it over; a pond with no duckweed yet is all open water.
    this.matField = matField;
    this.floorAt = floorAt ?? (() => -DEPTH);
    this.rng = createRng(deriveSeed(seed, SALT.life));
    this.out = makeContactOut();
    this.forceOut = { x: 0, z: 0 };
    this.pushA = { x: 0, z: 0 };
    this.pushB = { x: 0, z: 0 };
    this.curOut = { x: 0, z: 0 };
    this.curB = { x: 0, z: 0 };
    this.slopeOut = { x: 0, z: 0 };
    this.ringOut = { x: 0, z: 0 };
    this.rings = makeRingList();
    this.w0 = { x: 1, z: 0, gust: 0 };
    this.slotBox = new Float32Array(INF_SLOTS * 5);
    this.poke0 = { n: 0, vx: 0, vz: 0, x0: 0, x1: 0, z0: 0, z1: 0, segs: new Float32Array(POKE_MAX * 4) };
    this.pokeSegs = this.poke0.segs;

    const cast = layoutDetritus(seed, {
      rect: this.rect, knobs: this.knobs,
      // A hand's width of clearance at layout, so nothing is born already resolving out of a rock.
      blocked: (x, z) => !!this.contact(x, z, 0.08, this.out),
    });
    this.sticks = cast.sticks;
    this.cards = cast.cards;
    this.chunky = cast.chunky;

    // Drained by main each frame into one batched injector call, then reused; nothing here allocates.
    this.wakes = Array.from({ length: WAKE_SLOTS }, () => ({ x: 0, z: 0, r: 0, s: 0, hit: 0 }));
    this.wakeN = 0;

    this.ctx = {
      contact: this.contact, out: this.out, stations: new Float32Array(STATION_SLOTS * 3),
      knobs: this.knobs, rect: this.rect, floorAt: this.floorAt,
      seg: { ax: 0, az: 0, bx: 0, bz: 0, s: 0, t: 0, dist: 0 },
      endsA: { x0: 0, z0: 0, x1: 0, z1: 0 }, endsB: { x0: 0, z0: 0, x1: 0, z1: 0 },
      hand: { d: Infinity, x: 0, z: 0, rx: 0, rz: 0, sr: 0 },
      wake: (x, z, r, s, hit) => this.pushWake(x, z, r, s, hit),
      t: 0, wx: 1, wz: 0, windAngle: 0, gust: 0, curX: 0, curZ: 0,
      dirFx: 0, dirFz: 0, dirTorque: 0, curTorque: 0, ringFx: 0, ringFz: 0, slopeX: 0, slopeZ: 0, ms: 1,
      hitNx: 1, hitNz: 0, hitVx: 0, hitVz: 0,   // what the last resolve pushed along, for tests and debug
    };

    this.buffers = {
      s0: new Float32Array(STICK_POOL * 4), s1: new Float32Array(STICK_POOL * 4),
      s2: new Float32Array(STICK_POOL * 4), s3: new Float32Array(STICK_POOL * 4),
      s4: new Float32Array(STICK_POOL * 4),
      c0: new Float32Array(CARD_POOL * 4), c1: new Float32Array(CARD_POOL * 4),
      c2: new Float32Array(CARD_POOL * 4), c3: new Float32Array(CARD_POOL * 4),
      k0: new Float32Array(CHUNK_POOL * 4), k1: new Float32Array(CHUNK_POOL * 4),
      // The sink tray: u (t2.x) 0 is a free slot, and the sink owns every write here.
      t0: new Float32Array(TRAY_SLOTS * 4), t1: new Float32Array(TRAY_SLOTS * 4),
      t2: new Float32Array(TRAY_SLOTS * 4), t3: new Float32Array(TRAY_SLOTS * 4),
    };
    // The same arrays under one name per kind, which is the shape detritus-render.js binds by; the flat
    // keys above stay, so writeStatic and writeDynamic keep writing through one reference each.
    this.buffers.tray = { t0: this.buffers.t0, t1: this.buffers.t1, t2: this.buffers.t2, t3: this.buffers.t3 };
    this.buffers.sticks = {
      s0: this.buffers.s0, s1: this.buffers.s1, s2: this.buffers.s2, s3: this.buffers.s3, s4: this.buffers.s4,
    };
    this.buffers.cards = { c0: this.buffers.c0, c1: this.buffers.c1, c2: this.buffers.c2, c3: this.buffers.c3 };
    this.buffers.chunky = { k0: this.buffers.k0, k1: this.buffers.k1 };
    // What the render side has to re-upload each tick; the rest is written once, below.
    this.buffersDynamic = ['s0', 's3', 'c0', 'c2', 'k0', 'k1', 't0', 't1', 't2', 't3'];
    this.draw = { sticks: STICK_POOL, cards: CARD_POOL, chunky: CHUNK_POOL };
    this.quality = { cardFraction: 1, twigFraction: 1, chunkFraction: 1 };
    this.writeStatic();
    this.writeDynamic();
  }

  /* The same curl floaters.currentAt evaluates, read straight off the uniforms rather than through
     FloaterSystem, so this module stays out of the render-side import graph. Callers may pass their own. */
  currentFromU(x, z, t, out) {
    const C = this.U?.current?.array, P = this.U?.currentPhase?.array;
    out.x = 0; out.z = 0;
    if (!C || !P) return out;
    let dpdx = 0, dpdz = 0;
    for (let i = 0; i < C.length; i++) {
      const c = C[i], q = P[i];
      const g = Math.cos((x * c.x + z * c.y) * c.z + q.x + t * q.y) * c.w * c.z;
      dpdx += g * c.x; dpdz += g * c.y;
    }
    out.x = dpdz; out.z = -dpdx;
    return out;
  }

  /* Bearing and gust, from rain.wind when the caller handed one over and from U.wind otherwise, where
     the vec4 is (bearing.x, bearing.z, gust, lagged gust). */
  windNow() {
    const w = this.w0;
    if (this.wind) { w.x = this.wind.x; w.z = this.wind.z; w.gust = this.wind.gust ?? 0; return w; }
    const v = this.U?.wind?.value;
    if (!v) { w.x = 1; w.z = 0; w.gust = 0; return w; }
    w.x = v.x; w.z = v.y; w.gust = v.z;
    return w;
  }

  /* One sub-frame segment of the finger's path, appended, the shape floaters.poke already takes so
     main's coalesced walk feeds both with one loop. */
  poke(ax, az, bx, bz, vx, vz) {
    const p = this.poke0;
    if (p.n >= POKE_MAX) return;
    const o = p.n * 4;
    this.pokeSegs[o] = ax; this.pokeSegs[o + 1] = az; this.pokeSegs[o + 2] = bx; this.pokeSegs[o + 3] = bz;
    if (p.n === 0) { p.x0 = Math.min(ax, bx); p.x1 = Math.max(ax, bx); p.z0 = Math.min(az, bz); p.z1 = Math.max(az, bz); }
    else {
      p.x0 = Math.min(p.x0, ax, bx); p.x1 = Math.max(p.x1, ax, bx);
      p.z0 = Math.min(p.z0, az, bz); p.z1 = Math.max(p.z1, az, bz);
    }
    p.vx = vx; p.vz = vz; p.n++;
  }

  /* The water this tick owes: what a moving piece displaces and what an impact spends. Full means the
     frame already has more splashes than one injector batch should carry, so the weakest is the one lost. */
  pushWake(x, z, r, s, hit) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(s > 0)) return;
    let i = this.wakeN;
    if (i >= WAKE_SLOTS) {
      i = 0;
      for (let j = 1; j < WAKE_SLOTS; j++) if (this.wakes[j].s < this.wakes[i].s) i = j;
      if (this.wakes[i].s >= s) return;
    } else this.wakeN++;
    const w = this.wakes[i];
    w.x = x; w.z = z; w.r = r; w.s = s; w.hit = hit;
  }

  /* A drop's expanding ring, in world units and the sim's own strength scale (rain's big drops 0.04–0.10,
     a finger tap 0.2). Main converts sim uv to world; this only ever sees world x, z. */
  ring(x, z, strength, radius = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(strength > 0)) return;
    pushRing(this.rings, x, z, strength, Number.isFinite(radius) ? radius : 0, this.t);
  }

  /* Instance counts only, never an allocation, and every field it is not given goes back to 1. The
     pools are shuffled behind their structural head, so a tail cut thins every kind evenly. */
  setQuality({ cardFraction = 1, twigFraction = 1, chunkFraction = 1 } = {}) {
    const ok = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1);
    const q = { cardFraction: ok(cardFraction), twigFraction: ok(twigFraction), chunkFraction: ok(chunkFraction) };
    // The six shelter sticks are structural: cover is ecology, so no rung ever cuts them.
    this.draw.sticks = SHELTER_STICKS + Math.round(COUNTS.twig * q.twigFraction);
    this.draw.cards = Math.round(CARD_POOL * q.cardFraction);
    this.draw.chunky = Math.round(CHUNK_POOL * q.chunkFraction);
    this.quality = q;
  }

  packSlots() {
    const U = this.U;
    if (!U?.infA?.array || !U?.infB?.array) return 0;
    const sb = this.slotBox;
    let ns = 0;
    for (let i = 0; i < INF_SLOTS; i++) {
      const a = U.infA.array[i], b = U.infB.array[i];
      if (b.w <= 0) continue;
      const reach = a.w + 0.9, o = ns * 5;
      sb[o] = i;
      sb[o + 1] = Math.min(a.x, b.x) - reach; sb[o + 2] = Math.max(a.x, b.x) + reach;
      sb[o + 3] = Math.min(a.z, b.z) - reach; sb[o + 4] = Math.max(a.z, b.z) + reach;
      ns++;
    }
    return ns;
  }

  /* Every passing body's push at one world point. The hand is not in here: it is a collider now, resolved
     against the item's own stations rather than sampled at two endpoints. */
  pushAt(x, z, ns, out) {
    out.x = 0; out.z = 0;
    const f = this.forceOut, sb = this.slotBox;
    for (let s = 0; s < ns; s++) {
      const o = s * 5;
      if (x < sb[o + 1] || x > sb[o + 2] || z < sb[o + 3] || z > sb[o + 4]) continue;
      capsuleInfluenceCPU(this.U, x, 0, z, sb[o], f);
      out.x += f.x * EEL_FORCE; out.z += f.z * EEL_FORCE;
    }
    return out;
  }

  /* The swell's slope at one point, straight off the wave uniforms: the CPU has no heightfield readback,
     so this analytic twin is the whole of "follow the water's surface" on this side. */
  slopeAt(x, z, now, out) {
    const W = this.U?.waves?.array, P = this.U?.wavePhase?.array;
    if (!W || !P) { out.x = 0; out.z = 0; return out; }
    return swellSlope(x, z, now, W, P, this.U?.swell?.value ?? 1, out);
  }

  /* Age the i-th card straight to its lifetime, so a sink can be watched without waiting minutes. */
  forceSink(i) {
    const it = this.cards[i];
    if (!it || it.sink !== SINK.NONE) return false;
    it.age = it.lifetime;
    this.tray.lastRetire = -Infinity;
    return true;
  }

  stepPool(pool, ctx, h, now, ns, dirK, drawn = pool.length) {
    const k = this.knobs;
    const mf = this.matField;
    for (let i = 0; i < pool.length; i++) {
      const it = pool[i];
      if (it.card && !stepCardLife(it, this.tray, ctx, this.rng, h)) continue;
      const long = it.stick || it.long;
      const halfLen = it.stick ? it.len * 0.5 : it.halfL;
      const ux = Math.sin(it.angle), uz = Math.cos(it.angle);
      if (long) {
        // Both endpoints, for the flow and the push alike: the difference between them is a swing, which
        // is most of how anything with a long axis ever changes heading.
        const ax = it.x + ux * halfLen, az = it.z + uz * halfLen;
        const bx = it.x - ux * halfLen, bz = it.z - uz * halfLen;
        const cA = this.current(ax, az, now, this.curOut);
        const cAx = cA.x, cAz = cA.z;
        const cB = this.current(bx, bz, now, this.curB);
        ctx.curX = (cAx + cB.x) * 0.5; ctx.curZ = (cAz + cB.z) * 0.5;
        const lenFor = Math.max(0.2, halfLen * 2);
        ctx.curTorque = ((cAx - cB.x) * uz - (cAz - cB.z) * ux) * k.shearTorque / lenFor;
        const A = this.pushAt(ax, az, ns, this.pushA);
        const pax = A.x, paz = A.z;
        const B = this.pushAt(bx, bz, ns, this.pushB);
        ctx.dirFx = (pax + B.x) * 0.5 * dirK;
        ctx.dirFz = (paz + B.z) * 0.5 * dirK;
        ctx.dirTorque = ((pax - B.x) * uz - (paz - B.z) * ux) * dirK * 0.5 / lenFor;
      } else {
        const c = this.current(it.x, it.z, now, this.curOut);
        ctx.curX = c.x; ctx.curZ = c.z;
        ctx.curTorque = 0;
        const A = this.pushAt(it.x, it.z, ns, this.pushA);
        ctx.dirFx = A.x * dirK; ctx.dirFz = A.z * dirK; ctx.dirTorque = 0;
      }
      // The hand reads the item's real silhouette, so it adds to the push the bodies already wrote.
      if (this.poke0.n) handPush(it, this.poke0, ctx);
      const sl = this.slopeAt(it.x, it.z, now, this.slopeOut);
      ctx.slopeX = sl.x; ctx.slopeZ = sl.z;
      const R = ringPush(this.rings, it.x, it.z, now, k.ringSpeed, k.ringGain, this.ringOut);
      ctx.ringFx = R.x * dirK; ctx.ringFz = R.z * dirK;
      const hits = stepItem(it, ctx, h);
      if (!itemFinite(it)) { respawnItem(it, this.rng, ctx, true); this.respawned++; continue; }
      // A contact spent momentum the water has to take; a clear run only pushes its own bow wave. A piece
      // the ladder cut from the draw rings nothing: a pad rim bobbing under nothing at all reads as a ghost.
      if (i < drawn) { if (hits > 0) impactWake(it, ctx, now); else driftWake(it, ctx, now); }
      // Leaves do not float over duckweed; a stick or a nut pushes through the fronds and ignores them.
      if (mf && it.card && matEdge(it, mf, h) > 0) resolveStations(it, ctx);
      if (offFrame(it, this.rect)) {
        // A stick or a nut that drifts out comes back as a fresh one; only a card ever dies on screen.
        respawnItem(it, this.rng, ctx, !it.card);
        this.respawned++;
      } else if (it.card) offerSink(it, i, this.tray, ctx);
    }
  }

  /* On the fixed tick, after the eels wrote this frame's influence slots. */
  tick(dt) {
    const h = Math.min(dt, MAX_DT);
    this.t += h;
    const ctx = this.ctx;
    const ms = this.U?.motionScale?.value ?? 1;
    // Reduced motion: ambient drift, spin, and bob scale away; a finger or an eel still lands a push.
    const dirK = 0.5 + 0.5 * ms;
    const w = this.windNow();
    const wl = Math.hypot(w.x, w.z);
    // A calm night has no downwind side; the fallback bearing only ever multiplies a zero gust.
    ctx.wx = wl > 1e-6 ? w.x / wl : 1;
    ctx.wz = wl > 1e-6 ? w.z / wl : 0;
    ctx.windAngle = Math.atan2(ctx.wx, ctx.wz);
    ctx.gust = Math.max(0, w.gust);
    ctx.ms = ms;
    ctx.t = this.t;
    pruneRings(this.rings, this.t, this.knobs.ringSpeed);
    this.wakeN = 0;
    const ns = this.packSlots();
    this.stepPool(this.sticks, ctx, h, this.t, ns, dirK, this.draw.sticks);
    this.stepPool(this.cards, ctx, h, this.t, ns, dirK, this.draw.cards);
    this.stepPool(this.chunky, ctx, h, this.t, ns, dirK, this.draw.chunky);
    // After the pools move, so a pair is separated where they actually ended the tick, and only over what
    // the ladder is drawing: an invisible twig must not bat a branch across the pond.
    resolveStickPairs(this.sticks, ctx, this.draw.sticks);
    this.writeDynamic();
    this.poke0.n = 0;
  }

  /* Written once: nothing in these changes over an item's life, respawns included. */
  writeStatic() {
    const b = this.buffers;
    for (let i = 0; i < this.sticks.length; i++) {
      const it = this.sticks[i], o = i * 4;
      b.s1[o] = it.halfWidth; b.s1[o + 1] = it.bow; b.s1[o + 2] = it.seed; b.s1[o + 3] = it.roll;
      b.s2[o] = it.stubT; b.s2[o + 1] = it.stubLen; b.s2[o + 2] = it.stubYaw; b.s2[o + 3] = it.stubWidth;
      b.s4[o] = it.kinkT; b.s4[o + 1] = it.kinkAmp; b.s4[o + 2] = it.bow2; b.s4[o + 3] = it.snapped;
    }
    for (let i = 0; i < this.cards.length; i++) {
      const it = this.cards[i], o = i * 4;
      // kind 0 leaf, 1 chip, 2 petal: the card kinds renumbered off KIND, which counts sticks first.
      b.c1[o] = it.kind - 2; b.c1[o + 1] = it.aspect; b.c1[o + 2] = it.seed; b.c1[o + 3] = it.curl;
      // c3.rgb is the tint for every card kind: the atlas tiles are a near-neutral warm tan, so all of
      // the color a leaf or a chip has lives here as a multiply.
      b.c3[o] = it.r; b.c3[o + 1] = it.g; b.c3[o + 2] = it.b; b.c3[o + 3] = 0;
    }
  }

  writeDynamic() {
    const b = this.buffers;
    for (let i = 0; i < this.sticks.length; i++) {
      const it = this.sticks[i], o = i * 4;
      b.s0[o] = it.x; b.s0[o + 1] = it.z; b.s0[o + 2] = it.angle; b.s0[o + 3] = it.len;
      // A stick never retires on screen, so fade stays 1 and age only ever drives the waterlog darkening.
      b.s3[o] = age01(it); b.s3[o + 1] = 1; b.s3[o + 2] = it.voidT; b.s3[o + 3] = it.shelter ? 1 : 0;
    }
    for (let i = 0; i < this.cards.length; i++) {
      const it = this.cards[i], o = i * 4;
      b.c0[o] = it.x; b.c0[o + 1] = it.z; b.c0[o + 2] = it.angle; b.c0[o + 3] = it.halfL;
      // fade stays 1 across the crossing too: the dither against the tray's u is what hides the over card.
      b.c2[o] = age01(it); b.c2[o + 1] = 1; b.c2[o + 2] = it.voidT; b.c2[o + 3] = it.tile;
    }
    for (let i = 0; i < this.chunky.length; i++) {
      const it = this.chunky[i], o = i * 4;
      b.k0[o] = it.x; b.k0[o + 1] = it.z; b.k0[o + 2] = it.angle; b.k0[o + 3] = it.radius;
      b.k1[o] = it.kindT; b.k1[o + 1] = it.seed; b.k1[o + 2] = 1; b.k1[o + 3] = it.voidT;
    }
    for (let s = 0; s < TRAY_SLOTS; s++) {
      const o = s * 4, idx = this.tray.owner[s];
      if (idx < 0) {
        // u = 0 is the free marker the render side keys off; zero the rest so nothing stale is ever read.
        for (let j = 0; j < 4; j++) { b.t0[o + j] = 0; b.t1[o + j] = 0; b.t2[o + j] = 0; b.t3[o + j] = 0; }
        continue;
      }
      const it = this.cards[idx];
      b.t0[o] = it.mx; b.t0[o + 1] = it.mz; b.t0[o + 2] = it.angle; b.t0[o + 3] = it.halfL;
      b.t1[o] = it.kind - 2; b.t1[o + 1] = it.aspect; b.t1[o + 2] = it.seed; b.t1[o + 3] = it.curl;
      b.t2[o] = it.u; b.t2[o + 1] = it.depth; b.t2[o + 2] = it.tile; b.t2[o + 3] = idx;
      b.t3[o] = it.r; b.t3[o + 1] = it.g; b.t3[o + 2] = it.b; b.t3[o + 3] = it.gone;
    }
  }

  debug() {
    return {
      detritus: {
        pool: this.sticks.length + this.cards.length + this.chunky.length,
        draw: { ...this.draw }, quality: { ...this.quality },
        retired: this.tray.claimed, respawned: this.respawned, sunk: this.tray.sunk,
        sinking: trayLive(this.tray), rings: this.rings.n, wakes: this.wakeN, t: this.t,
      },
    };
  }
}

export function createDetritus(opts) {
  return new DetritusSystem(opts);
}

export { DetritusSystem };
