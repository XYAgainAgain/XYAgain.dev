import { PARA_KNOBS, hopCourse, hopCut, paraAim, scoreLanding, pickTarget, courseHeight, trailVec, poseDir } from './loco-para-core.js';
import { TRAVEL_KNOBS, hopAim } from './loco-travel-core.js';
import { register, until } from '../../diag/scenarios.js';
import { section } from '../../diag/panel.js';
import { TANK } from '../../config.js';
import { createRng, deriveSeed, seedFromUrl } from '../../../../pond/js/rng.js';

/* Jet hops: she launches mantle-first, climbs to an apex and levels out, cuts thrust when her coast will carry the rest,
   then parachutes down onto her arms reaching for the spot. Flown by the jet's guide; ?hop=0 leaves travel hops as plain aimed jets. */

export class Hop {
  constructor(loco, jet) {
    this.loco = loco;
    this.jet = jet;
    this.knobs = { ...PARA_KNOBS };
    this.target = null;       // the floor spot this hop means to land on
    this.from = null;         // her centroid at launch, and the course's apex height
    this.top = 0;
    this.last = null;         // how the last hop went: aim, cut, landing
    this.flippedEver = false;
    this.reachMax = 0;
    this._bear = [0, 0];
    const k = this.knobs;
    this.guide = {
      course: (c, out, v) => this._course(c, out, v),
      cut: (c, v) => hopCut(c, v, this.target, this.from, k),
      aim: (a, arm, out) => this._aim(arm, out),
      trail: (out) => trailVec(this.from ?? this.loco.mantle.ring().c, this.target, k, out),
      get spread() { return k.trailSpread; },
      // With no lean the jet's own steering and thrust run, as the hop first flew.
      pose: (d, out) => (k.lean > 0 ? poseDir(d, k.lean, out) : d),
      get landNear() { return k.landNear; },
      get landMax() { return k.landMax; },
      get align0() { return k.align0; },
      get align1() { return k.align1; },
      get paraSpeed() { return k.paraSpeed; },
      get down() { return k.paraDown; },
      get plant() { return k.landPlant; },
      get right() { return k.right; },
      get ramp() { return k.ramp; },
    };
    jet.listeners.add((what, j) => this._heard(what, j));
  }

  get on() { return !!this.knobs.on; }

  /* A hop to the floor at spot p ([x, y, z]; y is read off the sand there when the arms' distance field allows). Returns
     true, or why not. */
  start(p, { speed = null, reason = 'hop' } = {}) {
    if (!this.on) return 'hops off';
    if (!p || ![0, 1, 2].every((i) => Number.isFinite(+p[i]))) return 'no target';
    const c = this.loco.mantle.ring().c, was = [this.target, this.from, this.top];
    this.target = [+p[0], floorY(this.loco.arms.sdf, +p[0], +p[1], +p[2]), +p[2]];
    this.from = null;
    const flat = Math.hypot(this.target[0] - c[0], this.target[2] - c[2]);
    const r = this.jet.start({ guide: this.guide, speed: Number.isFinite(speed) && speed > 0 ? speed : this.knobs.speed, urgency: 1, reason, meters: flat * this.knobs.overMax });
    // A refused hop leaves any hop still in flight its own course: the jet keeps calling this guide.
    if (r !== true) { [this.target, this.from, this.top] = was; return r; }
    // She lets go of the sand as she launches, or the sealed arms drag behind her and the leap reads as a scoot.
    if (this.knobs.letGo) for (let a = 0; a < this.jet.owned.length; a++) if (this.jet.owned[a]) this.loco.arms.releaseSeals?.(a);
    this.flippedEver = false;
    this.reachMax = 0;
    this.last = { reason, target: this.target.map(r3), flat: r3(flat), cut: null, cutLeft: null, apexY: 0, landErr: null, landUp: null, upright: null, on: null };
    return true;
  }

  // The launch point and apex are read on the course's first call, from the jet's own mass centroid.
  _course(c, out, v) {
    if (!this.from) { this.from = [c[0], c[1], c[2]]; this.top = this._clearTop(this.from, this.target); }
    return hopCourse(c, this.target, this.top, this.knobs, out, v);
  }

  /* The apex over launch o that carries her centroid `clear` off any rock, glass, or divider along the way to p, its ends
     aside (she may launch from beside the glass or land by it). No height clears: the plain apex, not a climb into the lid. */
  _clearTop(o, p) {
    const k = this.knobs, sdf = this.loco.arms.sdf, n = this._n ??= [0, 0, 0], base = o[1] + k.apex;
    if (!sdf) return base;
    sdf.unfocus?.();
    const dx = p[0] - o[0], dz = p[2] - o[2], flat = Math.hypot(dx, dz), N = 12;
    for (let top = base; top <= o[1] + k.apexMax + 1e-9; top += k.apexStep) {
      let ok = true;
      for (let i = 1; i < N && ok; i++) {
        const s = (flat * i) / N;
        if (s < k.clearEnds || flat - s < k.clearEnds) continue;
        const d = sdf.distance(o[0] + (dx * i) / N, courseHeight(o[1], top, s, k), o[2] + (dz * i) / N, n);
        ok = !(d < k.clear) || n[1] > 0.9;
      }
      if (ok) return top;
    }
    return base;
  }

  _aim(arm, out) {
    const c = this.jet.c, p = this.target;
    let bx = p[0] - c[0], bz = p[2] - c[2];
    const left = Math.hypot(bx, bz);
    if (left > 1e-3) { this._bear[0] = bx / left; this._bear[1] = bz / left; }
    const w = paraAim(arm.frame.p, arm.frame.d, p, left, this._bear, this.knobs, out);
    if (w > this.reachMax) this.reachMax = w;
    return out;
  }

  _heard(what, j) {
    if (!this.last || !this.target) return;
    // A plain jet started over this hop's glide (a startle, the J key) ends the hop unscored.
    if (j.guide !== this.guide) { if (what === 'start') { this.last.cut ??= 'superseded'; this.target = null; } return; }
    if (this.loco.flipped) this.flippedEver = true;
    if (what === 'thrust' || what === 'coast') this.last.apexY = Math.max(this.last.apexY, r3(j.c[1]));
    if (what === 'end') {
      this.last.cut = j.last.ended;
      this.last.cutLeft = r3(Math.hypot(this.target[0] - j.c[0], this.target[2] - j.c[2]));
    }
    if (what === 'land' && this.last.landErr === null) {
      const up = this.loco.mantle.up(this._up ??= [0, 0, 0]), s = scoreLanding(j.c, this.target, up[1], this.flippedEver, this.knobs);
      Object.assign(this.last, { landErr: r3(s.err), landUp: r3(up[1]), upright: s.upright, on: s.on, landed: j.last.landed, reachMax: r3(this.reachMax) });
      this.target = null;
    }
  }

  label() {
    if (!this.on) return 'Hops: plain jets';
    const L = this.last;
    return L?.landErr != null ? `Hops: last landed ${(L.landErr * 100).toFixed(0)} cm off${L.upright ? '' : ', not upright'}` : 'Hops';
  }
}

const r3 = (v) => +(+v).toFixed(3);
const _n = [0, 0, 0];

// The sand's height under (x, z) when the closest thing to a point above it is the floor; y as given otherwise.
function floorY(sdf, x, y, z) {
  if (!sdf) return y;
  sdf.unfocus?.();
  const d = sdf.distance(x, y + 0.2, z, _n);
  return Number.isFinite(d) && _n[1] > 0.95 && d < 0.4 ? y + 0.2 - d : y;
}

/* Hop to the last clicked spot on the floor, or 0.5 m ahead along her heading. */
export function hopPress(hop) {
  const jet = hop.jet, L = hop.loco, c = L.mantle.ring().c;
  let to = jet.lastClick;
  if (!to) {
    const h = L.pose?.yaw ?? 0;
    to = [c[0] + Math.cos(h) * 0.5, 0, c[2] + Math.sin(h) * 0.5];
  }
  const r = hop.start([to[0], 0, to[2]], { reason: 'key' });
  if (r === true) jet.lastClick = null;
  return r;
}

/* The hop check: from the floor, a hop to a seeded spot 0.4–0.7 m off on open floor. Passes when she lands right side up
   within landR of it, bonking nothing on the way. With hops off, the plain aimed jet flies the same trip, for comparison. */
export async function hopScenario(ctx, { target = null, settle = 1, after = 2, lo = 0.4, hi = 0.7, knobs = null } = {}) {
  const jet = ctx.loco.jetMode, hop = ctx.loco.hopMode;
  if (!jet || !hop) return { passed: false, failed: 'no jet installed' };
  // Knobs for this run only (the harness's --opts), put back after.
  const was = knobs ? Object.fromEntries(Object.keys(knobs).filter((key) => key in hop.knobs).map((key) => [key, hop.knobs[key]])) : null;
  if (was) for (const key in was) hop.knobs[key] = knobs[key];
  try { return await hopRun(ctx, jet, hop, { target, settle, after, lo, hi }); } finally { if (was) Object.assign(hop.knobs, was); }
}

async function hopRun({ loco: L, arms: A, mantle: m, seed }, jet, hop, { target, settle, after, lo, hi }) {
  await until(L, () => false, settle);
  await until(L, () => jet.debt.ready && !L.flipped, 15);
  const c0 = [...m.ring().c], rng = createRng(deriveSeed(seed ?? seedFromUrl(), 6637));
  const panelX = L.wander?.panelX ?? 0.1, panelT = L.wander?.panelT ?? 0.06, nrm = [0, 0, 0];
  // Open floor: the floor is the closest thing to points 0.15 and 0.3 m over the spot, so no rock, glass, or divider is near.
  const open = (x, z) => {
    if (!A.sdf) return true;
    A.sdf.unfocus?.();
    return [0.15, 0.3].every((y) => { A.sdf.distance(x, y, z, nrm); return nrm[1] > 0.95; });
  };
  const p = target ?? pickTarget(c0, () => rng.next(), { lo, hi, tank: TANK, panelX, panelT, ok: open });
  if (!p) return { passed: false, failed: 'no open target' };
  const w = { bonk: 0, nan: 0, strainMax: 0, flipped: false, ticks: 0, t: 0, apexY: c0[1] };
  const watch = (dt) => {
    w.ticks++; w.t += dt;
    if (L.flipped) w.flipped = true;
    if (jet.phase !== 'off') {
      w.apexY = Math.max(w.apexY, jet.c[1]);
      // Her body against something that isn't the floor while she flies: a bonk.
      A.sdf?.unfocus?.();
      const d = A.sdf ? A.sdf.distance(jet.c[0], jet.c[1], jet.c[2], nrm) : Infinity;
      if (d < 0.07 && nrm[1] < 0.7 && !w.bonk++) w.bonkAt = [...jet.c, ...nrm].map(r3).join(' ');
    }
    if (w.ticks % 10 === 0) {
      const h = m.health();
      if (h.nan) w.nan++;
      if (h.strainMax > w.strainMax) { w.strainMax = h.strainMax; w.strainAt = `${r3(w.t)} ${jet.phase}`; }
    }
  };
  L.listeners.add(watch);
  try {
    let started;
    if (hop.on) started = hop.start(p, { reason: 'scenario' });
    else {
      const aim = [0, 0, 0], tk = L.wander?.travel?.knobs ?? TRAVEL_KNOBS;
      hopAim(c0, p, m.knobs.damping, TANK, tk, aim);
      started = jet.start({ to: aim, speed: tk.hopSpeed, urgency: 1, reason: 'scenario', meters: Math.hypot(aim[0] - c0[0], aim[1] - c0[1], aim[2] - c0[2]) });
    }
    if (started !== true) return { passed: false, failed: `refused: ${started}` };
    await until(L, () => jet.phase === 'off', 20);
    const landC = [...jet.c], up = m.up([0, 0, 0]), landUp = up[1], last = { ...jet.last };
    await until(L, () => false, after);
    const afterC = m.ring().c, afterUp = m.up(up)[1];
    const s = scoreLanding(landC, p, landUp, w.flipped, hop.knobs), sa = scoreLanding(afterC, p, afterUp, w.flipped, hop.knobs);
    // Signed miss along the hop (+ past the spot) and across it.
    const hx = p[0] - c0[0], hz = p[2] - c0[2], hl = Math.hypot(hx, hz) || 1;
    const along = (q) => ((q[0] - p[0]) * hx + (q[2] - p[2]) * hz) / hl, side = (q) => ((q[2] - p[2]) * hx - (q[0] - p[0]) * hz) / hl;
    const out = {
      hop: hop.on, target: (hop.on && hop.last ? hop.last.target : p.map(r3)).join(' '), apexTop: hop.on ? r3(hop.top - c0[1]) : null, from: c0.map(r3).join(' '), flat: r3(Math.hypot(p[0] - c0[0], p[2] - c0[2])),
      ended: last.ended, peak: last.peak, meters: last.meters, thrustT: last.thrustT, glideT: last.glideT, landed: last.landed, stations: last.stations ?? 0,
      apexRise: r3(w.apexY - c0[1]), landErr: r3(s.err), landAlong: r3(along(landC)), landSide: r3(side(landC)), landUp: r3(landUp), afterErr: r3(sa.err), afterUp: r3(afterUp), flipped: w.flipped,
      upright: s.upright && sa.upright, bonkTicks: w.bonk, bonkAt: w.bonkAt ?? null, reachMax: hop.on ? r3(hop.reachMax) : 0, cutLeft: hop.on ? hop.last?.cutLeft ?? null : null,
      nan: w.nan, strainMax: r3(w.strainMax), strainAt: w.strainAt ?? null, debt: r3(jet.debt.debt),
    };
    // A bonk she meant would have a target on the thing; this check's spots are open floor, so any bonk is a miss.
    out.passed = !!last.landed && out.upright && s.on && w.nan === 0 && w.bonk === 0;
    return out;
  } finally {
    L.listeners.delete(watch);
    if (jet.phase === 'thrust') jet.stop('scenario over');
  }
}

/* Install on a Locomotion beside its jet: loco.hopMode, loco.hop(p, opts), the panel's controls, and the hop check. */
export function installHop(loco, jet) {
  const hop = new Hop(loco, jet), k = hop.knobs;
  loco.hopMode = hop;
  loco.hop = (p, o) => hop.start(p, o);
  const loc = section('loco');
  loc.add({ key: 'q', name: 'Hop', label: () => hop.label(), run: () => hopPress(hop) });
  loc.add({ name: 'Hops guided', label: () => (k.on ? 'Hops: guided, parachute reach' : 'Hops: plain aimed jets'), run: () => { k.on = !k.on; } });
  loc.add({ type: 'range', name: 'Hop apex', values: [0.06, 0.1, 0.15, 0.22, 0.3], get: () => k.apex, set: (v) => { k.apex = v; }, label: () => `Hop apex ${Math.round(k.apex * 100)} cm` });
  loc.add({ type: 'range', name: 'Hop lean', values: [0, 0.5, 0.75, 1, 1.25], get: () => k.lean, set: (v) => { k.lean = v; }, label: () => `Hop lean ${Math.round(k.lean * 57.3)}° under the climb` });
  loc.add({ type: 'range', name: 'Arms streaming', values: [0, 0.1, 0.2, 0.35, 0.5], get: () => k.trailLift, set: (v) => { k.trailLift = v; }, label: () => `Arms stream ${Math.round(k.trailLift * 57.3)}° above level` });
  loc.add({ type: 'range', name: 'Hop coast', values: [0.3, 0.35, 0.4, 0.45, 0.5], get: () => k.coastT, set: (v) => { k.coastT = v; }, label: () => `Hop coast ${k.coastT} s per m/s` });
  loc.add({ type: 'range', name: 'Parachute spread', values: [0.15, 0.25, 0.35, 0.5, 0.7], get: () => k.paraDown, set: (v) => { k.paraDown = v; }, label: () => `Parachute arms ${Math.round(k.paraDown * 57.3)}° below level` });
  loc.add({ type: 'range', name: 'Reach for the landing', values: [0, 0.35, 0.65, 0.85, 1], get: () => k.reachShare, set: (v) => { k.reachShare = v; }, label: () => `Reach for the landing ${k.reachShare}` });
  register('hop', { label: 'Hop check', run: hopScenario });
  return hop;
}
