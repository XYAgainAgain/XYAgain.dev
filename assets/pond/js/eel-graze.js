import { DEPTH, MOON_ORBIT_SECONDS } from './config.js';
import { CARVE_TICK, FINGER_CARVE_R, FINGER_CARVE } from './floaters.js';

/* Morgan's menu. An herbivore in a pond of carnivores: crumbs are somebody else's dinner, so her
   wander targets become duckweed furrows, algae tufts, and lily pads. Two hooks, called from steer. */

// ~half the time at Morgan's hunger 0.5, so she still wanders and rests like everyone else.
const PICK_BASE = 0.35, PICK_HUNGER = 0.3;
const KIND_WEIGHT = { duckweed: 1, algae: 1, pad: 1 };   // she loves a salad; distance is the only tiebreak
const REACH = 7;                 // nothing further than this is worth the swim
// The behavior file re-picks the instant the head is within 0.6 of e.target, so the steering target
// always rides this far past the mouthful; arrival is measured against the item itself.
const LEAD = 0.9;
const GIVE_UP = 10;              // unreachable for this long and the menu item is abandoned
const FURROW = [3, 6];           // seconds plowing one mat
const NIBBLE = [0.5, 1.1];
const CHEW = 0.6, NOPE = 0.45;
const EXCITE_FEED = 0.35, EXCITE_BITE = 0.7;
const TUFT_REACH = 0.35;         // 3D, to the holdfast
const ARC_MAX = 2.2;             // rad; the lead angle at a tight radius, so the arc cannot double back
const ARC_MIN_R = 0.75;          // an eel sitting on the clump center still gets a target outside 0.6

export class Grazing {
  constructor({ floaters, algae, pads, habitat }) {
    this.floaters = floaters ?? null;
    this.algae = algae ?? null;
    this.pads = pads ?? null;
    this.habitat = habitat ?? null;
    this.state = new Map();   // one record per grazer; bounded by the cast
    this.item = { x: 0, y: 0, z: 0, r: 0 };   // scratch: tick runs at 90 Hz, so no per-tick object
  }

  stateFor(e) {
    let st = this.state.get(e);
    if (!st) {
      st = { startedAt: 0, until: 0, arrived: 0, carveAcc: 0, nibbleAt: 0, tuftFreeAt: 0, padFreeAt: 0 };
      this.state.set(e, st);
    }
    return st;
  }

  /* The noise cut is the mat's real silhouette; the clump disc is only where to look for it. */
  matAt(x, z) {
    if (this.floaters?.matAt) return this.floaters.matAt(x, z);
    return this.habitat?.duckweedAt?.(x, z) ?? null;
  }

  /* Hook one, from pickTarget right after the tunnel branch. False falls through to cover and wander. */
  pickTarget(sys, e, now) {
    const rng = e.rng;
    if (!e.quirks.herbivore && sys.foods.some((f) => f.amount > 0)) return false;   // crumbs first for an omnivore
    if (!rng.chance(PICK_BASE + PICK_HUNGER * e.traits.hunger)) return false;
    const st = this.stateFor(e);
    const head = e.head;
    const menu = [];
    const weed = this.pickClump(e, head);
    if (weed) menu.push(weed);
    const tuft = this.pickTuft(head, now, st);
    if (tuft) menu.push(tuft);
    const pad = this.pickPad(e, head, now, st);
    if (pad) menu.push(pad);
    if (!menu.length) return false;
    // Weighted by kind and softened by distance: the near mouthful usually wins, not always.
    let total = 0;
    for (const m of menu) { m.w = KIND_WEIGHT[m.kind] / (1 + m.d); total += m.w; }
    let r = rng.next() * total, choice = menu[menu.length - 1];
    for (const m of menu) { r -= m.w; if (r <= 0) { choice = m; break; } }
    const dx = choice.x - head.x, dz = choice.z - head.z;
    const inv = Math.hypot(dx, dz) > 1e-4 ? 1 / Math.hypot(dx, dz) : 0;
    e.target.set(choice.x + dx * inv * LEAD, 0, choice.z + dz * inv * LEAD);
    e.coverSpot = { type: 'graze', kind: choice.kind, idx: choice.idx };
    e.retargetAt = now + GIVE_UP * 3;   // tick owns the give-up clock
    st.startedAt = now;
    st.arrived = 0;
    st.until = 0;
    st.carveAcc = 0;
    st.nibbleAt = 0;
    return true;
  }

  pickClump(e, head) {
    const f = this.floaters;
    if (!f?.clumps?.length) return null;
    let best = null, bestD = REACH;
    for (let i = 0; i < f.clumps.length; i++) {
      const c = f.clumps[i];
      const cx = c.x + c.dx, cz = c.z + c.dz;
      const d = Math.hypot(cx - head.x, cz - head.z);
      if (d >= bestD) continue;
      bestD = d;
      best = { kind: 'duckweed', idx: i, x: cx, z: cz, d };
    }
    if (!best) return null;
    // Aim where the noise cut actually left fronds: a mat's nominal center can be open water.
    const c = f.clumps[best.idx];
    const rr = c.r * (c.growth ?? 1) * (c.warpMean ?? 1) * 0.5;
    for (let k = 0; k < 6; k++) {
      const a = e.rng.range(0, Math.PI * 2), rad = rr * e.rng.next();
      const px = best.x + Math.cos(a) * rad, pz = best.z + Math.sin(a) * rad;
      if (this.matAt(px, pz)) { best.x = px; best.z = pz; return best; }
    }
    return null;
  }

  pickTuft(head, now, st) {
    const a = this.algae;
    if (!a?.tufts?.length || now < st.tuftFreeAt) return null;
    let best = null, bestD = REACH;
    for (let i = 0; i < a.tufts.length; i++) {
      if (!a.canBite?.(i)) continue;
      const t = a.tufts[i];
      const d = Math.hypot(t.x - head.x, t.z - head.z);
      if (d >= bestD) continue;
      bestD = d;
      best = { kind: 'algae', idx: i, x: t.x, z: t.z, d };
    }
    return best;
  }

  pickPad(e, head, now, st) {
    const ps = this.pads;
    if (!ps?.pads?.length) return null;
    const whole = e.radius * 2 + 0.25;
    let best = null, bestD = REACH;
    for (let i = 0; i < ps.pads.length; i++) {
      const p = ps.pads[i];
      const eat = p.r * 2 < whole;
      if (eat ? (now < st.padFreeAt || !ps.canEat?.(i)) : !ps.canBite?.(i)) continue;
      const d = Math.hypot(p.x - head.x, p.z - head.z);
      if (d >= bestD) continue;
      bestD = d;
      best = { kind: 'pad', idx: i, x: p.x, z: p.z, d };
    }
    return best;
  }

  /* The live mouthful, or null once it is gone or somebody else took it. */
  itemAt(kind, idx) {
    const it = this.item;
    if (kind === 'duckweed') {
      const c = this.floaters?.clumps?.[idx];
      if (!c) return null;
      it.x = c.x + c.dx; it.y = 0; it.z = c.z + c.dz; it.r = 0;
      return it;
    }
    if (kind === 'algae') {
      const t = this.algae?.tufts?.[idx];
      if (!t || t.biting) return null;
      it.x = t.x; it.y = t.y; it.z = t.z; it.r = 0;
      return it;
    }
    const p = this.pads?.pads?.[idx];
    if (!p || p.graze || p.r <= 0.01) return null;
    it.x = p.x; it.y = 0; it.z = p.z; it.r = p.r;
    return it;
  }

  /* Hook two, from steer right after the food block. Owns approach, arrival, and the bite. */
  tick(sys, e, dt) {
    const spot = e.coverSpot;
    if (!spot || spot.type !== 'graze') return;
    if (e.food) { this.done(sys, e, this.stateFor(e), false); return; }   // an omnivore drops the salad for a crumb
    // A rest pose owns the target while it holds its shape; the give-up clock drops the meal for us.
    if (e.pose?.kind) return;
    const now = sys.time;
    const st = this.stateFor(e);
    const head = e.head;
    const item = this.itemAt(spot.kind, spot.idx);
    if (!item) { this.done(sys, e, st, false); return; }

    const dx = item.x - head.x, dz = item.z - head.z;
    const d = Math.hypot(dx, dz);
    const inv = d > 1e-4 ? 1 / d : 0;
    e.target.set(item.x + dx * inv * LEAD, 0, item.z + dz * inv * LEAD);
    e.retargetAt = now + GIVE_UP * 3;
    if (!st.arrived && now - st.startedAt > GIVE_UP) { this.done(sys, e, st, false); return; }

    if (spot.kind === 'duckweed') { this.grazeMat(sys, e, dt, st, item, now); return; }
    if (spot.kind === 'algae') { this.biteTuft(sys, e, st, item, d, now); return; }
    this.eatPad(sys, e, st, spot.idx, item, d, now);
  }

  /* Duckweed: a furrow plowed the way Eleanor plows and the finger parts, on a slow arc through the mat. */
  grazeMat(sys, e, dt, st, item, now) {
    e.targetY = Math.max(e.targetY, -0.25);
    e.retargetYAt = now + 1;
    // The meal clock runs whether or not she is over fronds, so drifting out of a ragged mat cannot pin her.
    if (st.arrived && now > st.until) { this.done(sys, e, st, false); return; }   // the bites already sounded
    if (!this.matAt(e.head.x, e.head.z)) return;   // still swimming in, or drifted out; the lead target pulls her back
    if (!st.arrived) {
      st.arrived = 1;
      st.until = now + e.rng.range(FURROW[0], FURROW[1]);
      e.gait = 'prowl';
      e.gaitUntil = st.until;
    }
    // Swing the target a lead chord around the clump center, so she curves through the mat and the
    // behavior file's arrival re-pick never fires while she is eating.
    const head = e.head;
    let ox = head.x - item.x, oz = head.z - item.z;
    let m = Math.hypot(ox, oz);
    // Dead center of the mat has no radius to swing around, so borrow the heading for one.
    if (m < 1e-3) { ox = e.heading.x; oz = e.heading.z; m = Math.hypot(ox, oz) || 1; }
    const rr = Math.max(ARC_MIN_R, m);
    const stepA = Math.min(ARC_MAX, LEAD / rr);
    const ca = Math.cos(stepA), sa = Math.sin(stepA), ux = ox / m, uz = oz / m;
    e.target.set(item.x + (ux * ca - uz * sa) * rr, 0, item.z + (ux * sa + uz * ca) * rr);

    st.carveAcc += dt;
    if (st.carveAcc >= CARVE_TICK && this.floaters?.carveCapsule) {
      st.carveAcc = 0;
      const h = e.heading;
      this.floaters.carveCapsule(head.x, head.z, head.x + h.x * 0.3, head.z + h.z * 0.3, FINGER_CARVE_R * 1.5, FINGER_CARVE, true);
    }
    e.uExcite.value = Math.max(e.uExcite.value, EXCITE_FEED);
    // Every mouthful of the furrow is its own bite: bubbles from the nibble, the munch from the graze.
    if (now > st.nibbleAt) {
      st.nibbleAt = now + e.rng.range(NIBBLE[0], NIBBLE[1]);
      sys.emit('nibble', e);
      sys.emit('graze', e, { kind: 'duckweed', idx: e.coverSpot.idx, bite: true });
    }
  }

  /* Algae: one tuft torn off the stone, with the withdrawal nope selling the tear. */
  biteTuft(sys, e, st, item, d, now) {
    e.targetY = Math.min(-e.radius * 1.5, Math.max(-DEPTH + e.radius * 1.6, item.y));
    e.retargetYAt = now + 2;
    const dy = e.head.y - item.y;
    if (Math.sqrt(d * d + dy * dy) > TUFT_REACH) return;
    const idx = e.coverSpot.idx;
    if (!this.algae?.biteTuft?.(idx)) { this.done(sys, e, st, false); return; }
    st.tuftFreeAt = now + MOON_ORBIT_SECONDS;
    this.chew(sys, e, now);
    this.done(sys, e, st, true, 'algae', idx);
  }

  /* Pads: narrow enough and it goes whole, otherwise she takes a bite out of the rim. */
  eatPad(sys, e, st, idx, item, d, now) {
    e.targetY = Math.max(e.targetY, -0.25);
    e.retargetYAt = now + 1;
    if (d > Math.max(0.35, item.r * 0.6)) return;
    const whole = item.r * 2 < e.radius * 2 + 0.25;
    const ok = whole ? this.pads?.eatPad?.(idx) : this.pads?.bitePad?.(idx, e.rng.range(1, 100));
    if (!ok) { this.done(sys, e, st, false); return; }
    if (whole) st.padFreeAt = now + MOON_ORBIT_SECONDS;
    this.chew(sys, e, now);
    this.done(sys, e, st, true, 'pad', idx);
  }

  chew(sys, e, now) {
    e.gait = 'hold';
    e.gaitUntil = now + CHEW;
    e.uExcite.value = Math.max(e.uExcite.value, EXCITE_BITE);
    sys.emit('nibble', e);
    e.nopeUntil = now + NOPE;
  }

  done(sys, e, st, ate, kind, idx) {
    if (ate) sys.emit('graze', e, { kind, idx });
    e.coverSpot = null;
    e.retargetAt = sys.time;
    st.arrived = 0;
    st.until = 0;
  }
}
