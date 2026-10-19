import { TANK } from '../config.js';
import {
  CARRY_KNOBS, isSmall, isWedged, onFloor, whoMovesInWater, toLocalPoint, toWorldPoint, haulStep, extent,
} from './loco-carry-core.js';
import { springTarget, lerp } from './locomotion-core.js';
import { until, register } from '../scenarios.js';
import { FRONT_ARMS } from './attention.js';

/* Loose things as holds: a small prize stowed in her web beside the crown ring, a bigger one reeled to her mouth, and
   a wedged one she hauls herself to on a spring whose anchor rides the toy, the toy taking the opposite pull. Ticks as
   a locomotion listener, after the gait has written the mantle's arm drive and before the mantle steps. */

const GRAV = 9.81;

/* The pull question's inputs for arm i's grip, read live: her other arms' anchors, the toy's wedging, resting, weight,
   mass, and the pull's steepness, and whether her body lies on the floor. Null without a grip. */
export function moveInputs(arms, i, k = CARRY_KNOBS) {
  const ep = arms.episodes?.[i];
  if (!ep?.h) return null;
  const toy = ep.toy, phys = arms.phys, m = arms.mantle, sdf = arms.sdf, nrm = [0, 0, 0];
  const p = toy.body.GetPosition(), c = [p.GetX(), p.GetY(), p.GetZ()], q = phys.rotationOf(toy);
  sdf.unfocus();
  const dist = sdf.distance;
  let anchor = 0;
  for (let b = 0; b < arms.arms.length; b++) if (b !== i) anchor += arms.anchorForce[b];
  const crown = m.ring().c, dx = c[0] - crown[0], dy = c[1] - crown[1], dz = c[2] - crown[2], dl = Math.hypot(dx, dy, dz);
  // Her body is on the floor if any skin vertex sits within its own radius plus floorGap of an upward surface.
  const P = m.positions, o = m.origin, reach = (m.knobs.vertexRadius ?? 0.004) + k.floorGap;
  let bodyOnFloor = false;
  for (let v = 0, n = m.shell.count; v < n && !bodyOnFloor; v++) {
    if (dist(P[v * 3] + o[0], P[v * 3 + 1] + o[1], P[v * 3 + 2] + o[2], nrm) <= reach && nrm[1] > k.floorCos) bodyOnFloor = true;
  }
  const inv = phys.inverseMass(toy);
  return {
    anchor, wedged: isWedged(c, toy.kind, toy.size, q, dist, k), resting: onFloor(c, toy.kind, toy.size, q, dist, k),
    weightInWater: toy.water?.weightInWater ?? (inv > 0 ? GRAV / inv : 0), up: dl > 1e-6 ? Math.abs(dy) / dl : 0,
    bodyOnFloor, objectMass: inv > 0 ? 1 / inv : Infinity,
  };
}

export class Carry {
  constructor({ mantle, arms, loco }, { knobs = {} } = {}) {
    this.mantle = mantle;
    this.arms = arms;
    this.loco = loco;
    this.knobs = { ...CARRY_KNOBS, ...knobs };
    const n = arms.arms.length;
    this.job = new Array(n).fill(null);
    this.felt = new Float64Array(n * 3);
    this.counts = { stows: 0, reels: 0, hauls: 0, haulArrived: 0, haulTimeout: 0, haulLost: 0, ended: 0 };
    this._acc = null;
    this._p = [0, 0, 0]; this._a = [0, 0, 0]; this._t = [0, 0, 0]; this._q = [0, 0, 0, 1]; this._c = [0, 0, 0];
    if (loco) {
      loco.knobs.carry = this.knobs;
      this._fn = (dt) => this.tick(dt);
      this._fn.reset = () => this.reset();
      loco.listeners.add(this._fn);
    }
  }

  /* A small thing gripped by arm i rides in her web beside the crown ring until let go. Anything bigger only by `force`:
     a ball wider than the web, held under her, rolls her onto her side. */
  stow(i, { force = false } = {}) {
    const A = this.arms, ep = A.episodes[i];
    if (!ep?.h || (!force && !isSmall(ep.toy.kind, ep.toy.size, this.knobs)) || !A.stow(i, this._stowAt(ep.toy))) return false;
    this.job[i] = { kind: 'stow', toy: ep.toy, t: 0 };
    this.counts.stows++;
    return true;
  }

  /* Where a stowed toy sits: stowStand of its size below the mouth, and out past the crown ring's edge by stowOut of its
     size toward the carrying arm's base. */
  _stowAt(toy) {
    const k = this.knobs, r = extent(toy.kind, toy.size) / 2, ring = this.mantle.ringSpan?.().mean ?? 0.085;
    return { stand: k.stowStand * r, out: k.stowOut > 0 ? ring / 2 + k.stowOut * r : 0 };
  }

  /* A thing too big for the web comes to her mouth and is held there a while, then the grip's own taste takes over. */
  reel(i) {
    const A = this.arms, ep = A.episodes[i], k = this.knobs;
    if (!ep?.h) return false;
    const was = ep.commanded;
    if (!A.fetch(i, { grasp: ep.arc / A.arms[i].length, hold: k.reelHold })) return false;
    A.fetchStand[i] = A.knobs.fetchClear * extent(ep.toy.kind, ep.toy.size) / 2;
    ep.fetched = true;
    ep.commanded = true;
    A.claim(i, 'held');
    this.job[i] = { kind: 'reel', toy: ep.toy, t: 0, was };
    this.counts.reels++;
    return true;
  }

  /* Arm i hauls her to what it grips: the grip stops driving the toy, the arm plants on the toy's grip point read
     live, and the patch's spring shortens toward it at the urgency's speed. */
  haul(i, { urgency = 0.3 } = {}) {
    const A = this.arms, ep = A.episodes[i], phys = A.phys;
    if (!ep?.h || ep.seg < 0) return false;
    const toy = ep.toy, b = toy.body.GetPosition(), c = [b.GetX(), b.GetY(), b.GetZ()], q = phys.rotationOf(toy);
    const g = [A.gripPos[i * 3], A.gripPos[i * 3 + 1], A.gripPos[i * 3 + 2]];
    const n = [g[0] - c[0], g[1] - c[1], g[2] - c[2]], nl = Math.hypot(n[0], n[1], n[2]);
    if (!(nl > 1e-6)) return false;
    for (let a = 0; a < 3; a++) n[a] /= nl;
    if (!A.freeze(i, true)) return false;
    if (!A.plant(i, { seg: ep.seg, p: g, n, taste: ep.taste })) { A.freeze(i, false, g); return false; }
    A.arms[i].goal.carry = this;
    A.claim(i, 'held');
    const local = toLocalPoint(g, c, q, [0, 0, 0]), lk = this.loco?.knobs;
    const root = this.mantle.rootWorld(i, this._p), ell = Math.hypot(root[0] - g[0], root[1] - g[1], root[2] - g[2]);
    this.job[i] = {
      kind: 'haul', toy, t: 0, local, n, u: [0, 0, 0], ell, was: ep.commanded, wasHard: ep.hard, small: isSmall(toy.kind, toy.size, this.knobs),
      speed: lk ? lerp(lk.speedCalm, lk.speedHurried, urgency) : 0.05, capU: lk ? lerp(lk.capCalm, lk.capHurried, urgency) : 1.5,
    };
    // A haul seals hard, as a commanded grip does: at the working share its cap would flicker with the seals.
    ep.commanded = true;
    ep.hard = true;
    this.counts.hauls++;
    return true;
  }

  /* Which of her and arm i's toy moves, and the matching action: stow or reel it in, or haul herself to it. */
  pull(i, opts = {}) {
    const inputs = moveInputs(this.arms, i, this.knobs);
    if (!inputs) return null;
    const r = whoMovesInWater(inputs, this.knobs), toy = this.arms.episodes[i].toy;
    const action = r.who === 'body' ? 'haul' : isSmall(toy.kind, toy.size, this.knobs) ? 'stow' : 'reel';
    const ok = action === 'haul' ? this.haul(i, opts) : action === 'stow' ? this.stow(i) : this.reel(i);
    return { ...r, action, ok, wedged: inputs.wedged, resting: inputs.resting, anchor: +inputs.anchor.toFixed(2) };
  }

  tick(dt) {
    const L = this.loco, mode = L?.state.mode ?? '';
    if (!(dt > 0) || mode === 'off' || mode === 'held' || mode.startsWith('rigid') || this.mantle.drive !== 'force') return;
    const A = this.arms;
    for (let i = 0; i < this.job.length; i++) {
      const j = this.job[i];
      if (!j) continue;
      j.t += dt;
      const ep = A.episodes[i];
      if (!ep?.h || ep.toy !== j.toy) { this._end(i, j.kind === 'haul' ? 'lost' : 'ended'); continue; }
      if (j.kind === 'haul') this._haul(i, j, ep, dt);
      else if (j.kind === 'stow') this._keepStowed(i, j, ep, dt);
      else if (j.kind === 'reel' && A.arms[i].goal?.kind !== 'fetch') this._end(i, 'ended');
    }
    this._feel(dt);
  }

  /* The fetch plans its fold once from where the arm lay, so as she crawls and turns the grip drifts off its mark;
     past stowSlack for stowReset it is planned again from where the arm lies now. */
  _keepStowed(i, j, ep, dt) {
    const A = this.arms, g = A.arms[i].goal, k = this.knobs, G = A.gripPos;
    // Only once the fold has had its time to form.
    if (g?.kind !== 'fetch' || g.t < g.duration) { j.off = 0; return; }
    const e = Math.hypot(G[i * 3] - g.target[0], G[i * 3 + 1] - g.target[1], G[i * 3 + 2] - g.target[2]);
    j.off = e > k.stowSlack ? (j.off ?? 0) + dt : 0;
    if (j.off < k.stowReset) return;
    j.off = 0;
    j.refetch = (j.refetch ?? 0) + 1;
    A.stow(i, { ...this._stowAt(ep.toy), duration: k.refetchTime });
  }

  _haul(i, j, ep, dt) {
    const A = this.arms, m = this.mantle, k = this.knobs, phys = A.phys, arm = A.arms[i], g = arm.goal;
    if (g?.kind !== 'plant' || g.carry !== this) return this._end(i, 'lost');
    const b = j.toy.body.GetPosition(), c = this._c, q = phys.rotationOf(j.toy, this._q), P = this._a;
    c[0] = b.GetX(); c[1] = b.GetY(); c[2] = b.GetZ();
    toWorldPoint(j.local, c, q, P);
    if (!Number.isFinite(P[0] + P[1] + P[2])) return this._end(i, 'lost');
    // The anchor rides the toy: the plant's point and its suckers' aim follow it.
    const n = j.n;
    n[0] = P[0] - c[0]; n[1] = P[1] - c[1]; n[2] = P[2] - c[2];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= nl; n[1] /= nl; n[2] /= nl;
    for (let a = 0; a < 3; a++) { g.point[a] = P[a]; g.normal[a] = n[a]; g.face[a] = P[a] - n[a] * 0.05; }
    // The pull she put through the patch last tick goes into the toy, toward her: a toy that wasn't wedged comes.
    const u = j.u, inv = phys.inverseMass(j.toy);
    if (j.t > dt && inv > 0 && m.armForce[i] > 0) {
      const J = m.armForce[i] * dt;
      phys.impulseAt(j.toy, u[0] * J, u[1] * J, u[2] * J, P[0], P[1], P[2]);
    }
    const root = m.rootWorld(i, this._p);
    const chord = springTarget(root, P, j.ell, this._t, u, n);
    if (chord <= k.haulDone) return this._end(i, 'arrived');
    if (j.t > k.haulMax) return this._end(i, 'timeout');
    j.ell = haulStep(j.ell, chord, j.speed, dt, k);
    springTarget(root, P, j.ell, this._t, u, n);
    const lk = this.loco?.knobs, safety = lk?.anchorSafety ?? 0.6;
    m.armMode[i] = 1;
    m.armTarget[i * 3] = this._t[0]; m.armTarget[i * 3 + 1] = this._t[1]; m.armTarget[i * 3 + 2] = this._t[2];
    m.armAxis[i * 3] = u[0]; m.armAxis[i * 3 + 1] = u[1]; m.armAxis[i * 3 + 2] = u[2];
    m.armCap[i] = Math.max(0, Math.min(j.capU, safety * ep.capEma));
  }

  /* What the grips pull with reaches her through each gripping arm's patch, smoothed and capped, as a raw force: the
     proxies are kinematic, so without this a carried toy weighs nothing to her. */
  _feel(dt) {
    const k = this.knobs, A = this.arms, m = this.mantle, F = this.felt, R = A.reaction;
    if (!k.feelGrips || !m.driven || !R) { F.fill(0); return; }
    const f = 1 - Math.exp(-dt / Math.max(1e-3, k.feelTau));
    let any = false;
    for (let i = 0; i < this.job.length; i++) {
      const live = A.episodes[i]?.h && this.job[i]?.kind !== 'haul';
      for (let a = 0; a < 3; a++) F[i * 3 + a] += ((live ? R[i * 3 + a] : 0) - F[i * 3 + a]) * f;
      const mag = Math.hypot(F[i * 3], F[i * 3 + 1], F[i * 3 + 2]);
      if (mag > k.feelCap) for (let a = 0; a < 3; a++) F[i * 3 + a] *= k.feelCap / mag;
      if (mag > 1e-4) any = true;
    }
    if (!any) return;
    const acc = this._acc ??= new Float32Array(m.shell.count * 3);
    acc.fill(0);
    for (let d = 0; d < m.driven.length; d++) {
      const arm = m.drivenArm[d], pm = m.patchMass[arm];
      if (!(pm > 0)) continue;
      const v = m.driven[d] * 3;
      acc[v] += F[arm * 3] / pm; acc[v + 1] += F[arm * 3 + 1] / pm; acc[v + 2] += F[arm * 3 + 2] / pm;
    }
    m.addAccel(acc, { neutral: false });
  }

  _end(i, why) {
    const A = this.arms, j = this.job[i], ep = A.episodes[i], arm = A.arms[i];
    this.job[i] = null;
    if (!j) return;
    this.last = { arm: i, kind: j.kind, why, t: +j.t.toFixed(2) };
    if (j.kind === 'haul') {
      if (arm.goal?.carry === this) A.unplant(i);
      const live = ep?.h && ep.toy === j.toy;
      if (live) {
        const b = j.toy.body.GetPosition(), c = [b.GetX(), b.GetY(), b.GetZ()], P = toWorldPoint(j.local, c, A.phys.rotationOf(j.toy), [0, 0, 0]);
        A.freeze(i, false, P);
        ep.commanded = j.was;
        ep.hard = j.wasHard || ep.rule.hard;
        if (why === 'arrived' && j.small) { this.counts.haulArrived++; this.stow(i); return; }
      }
      this.counts[why === 'arrived' ? 'haulArrived' : why === 'timeout' ? 'haulTimeout' : 'haulLost']++;
    } else if (j.kind === 'reel' && ep?.h && ep.toy === j.toy) {
      // The reel is done: from here the grip lasts its taste's own hold.
      ep.commanded = j.was;
      ep.t0 = A.time;
    }
    if (arm.goal?.kind === 'fetch' && (j.kind === 'stow' || !ep?.h)) arm.idle();
    if (!ep?.h) A.unclaim(i, 'held');
    this.counts.ended++;
  }

  /* Let go of what arm i carries. */
  letGo(i) {
    const A = this.arms;
    if (this.job[i]) this._end(i, 'ended');
    if (A.episodes[i]) A._end(i, true, 'release');
  }

  /* Drop every carry: hauls give their grips back to the constraint first, then every carried thing is let go and its
     arm's claim returns. */
  reset() {
    const A = this.arms;
    for (let i = 0; i < this.job.length; i++) {
      const j = this.job[i];
      if (!j) continue;
      this._end(i, 'reset');
      if (A.episodes[i]?.toy === j.toy) A._end(i, true, 'release');
      A.unclaim(i, 'held');
    }
    this.felt.fill(0);
  }

  destroy() { if (this.loco && this._fn) this.loco.listeners.delete(this._fn); }

  describe() {
    const parts = [];
    for (let i = 0; i < this.job.length; i++) if (this.job[i]) parts.push(`${this.job[i].kind} arm ${i}`);
    return parts.join(', ') || 'nothing';
  }
}

const r3 = (v) => +(+v).toFixed(3);

/* Pick the nearest resting thing on her side the web can take (a ball first), go to it, and reach until one arm grips
   it, up to `reaches` tries; the first reach is attention's look-and-reach. */
async function reachAndGrip(ctx, { urgency = 0.5, reaches = 3 } = {}) {
  const { loco, arms: A, attention: att, mantle: m, carry, toys, phys } = ctx, k = carry?.knobs ?? CARRY_KNOBS;
  const panelX = ctx.layoutKnobs?.panelX ?? 0.1, out = { reaches: [], passed: false };
  const at = (t) => { const p = t.body.GetPosition(); return [p.GetX(), p.GetY(), p.GetZ()]; };
  const crownDist = (t) => { const c = m.ring().c, p = at(t); return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]); };
  const rad = (t) => extent(t.kind, t.size) / 2;
  const sdf = A.sdf, nrm = [0, 0, 0];
  const resting = (t) => {
    const v = [0, 0, 0];
    phys.pointVelocity(t, ...at(t), v);
    sdf.unfocus();
    return Math.hypot(v[0], v[1], v[2]) < 0.02 && onFloor(at(t), t.kind, t.size, phys.rotationOf(t), sdf.distance, k);
  };
  const mine = (t) => at(t)[0] < panelX - 0.1 && (t.water?.weightInWater ?? 0) < 0.7;
  const spheres = toys.filter((t) => t.kind === 'sphere' && mine(t));
  // Near-neutral balls take 5–6 s to land; anything still sinking after 8 s is skipped.
  await until(loco, () => spheres.some(resting), 8);
  const byNear = (list) => list.filter(resting).sort((a, b) => crownDist(a) - crownDist(b));
  const pool = byNear(spheres.filter((t) => isSmall(t.kind, t.size, k)));
  // A ball the web can take, else any small thing; something bigger only when nothing small rests on her side.
  const toy = pool[0] ?? byNear(toys.filter((t) => mine(t) && isSmall(t.kind, t.size, k)))[0] ?? byNear(spheres)[0] ?? byNear(toys.filter(mine))[0];
  if (!toy) {
    const seen = toys.map((t, i) => ({ i, kind: t.kind, x: r3(at(t)[0]), y: r3(at(t)[1]), weight: r3(t.water?.weightInWater ?? 0), small: isSmall(t.kind, t.size, k), resting: resting(t) }));
    return { out: { ...out, failed: 'no resting ball on her side', seen }, arm: -1 };
  }
  const ti = toys.indexOf(toy);
  Object.assign(out, { toy: ti, kind: toy.kind, size: r3(rad(toy)), small: isSmall(toy.kind, toy.size, k), weight: r3(toy.water?.weightInWater ?? 0), dist0: r3(crownDist(toy)) });

  let t = 0;
  const d = loco.want(toy, { urgency, source: 'scenario' });
  if (d) await Promise.race([d.done, until(loco, () => { t += 1 / 60; return crownDist(toy) < 0.45 || t > 30; })]);
  if (loco.desire === d) loco.stop('in reach');
  out.approach = { t: r3(t), dist: r3(crownDist(toy)) };

  const gripping = () => A.episodes.findIndex((e) => e?.h && e.toy === toy);
  const tried = new Set();
  let arm = -1;
  for (let r = 0; r < reaches && gripping() < 0; r++) {
    let a = -1;
    if (r === 0) {
      att.lookAndReach(toy);
      await until(loco, () => !att.reach, att.knobs.reachWait + 1);
      a = att.reached;
    }
    if (a < 0 || tried.has(a)) {
      const order = [...FRONT_ARMS, ...A.arms.map((_, i) => i).filter((i) => !FRONT_ARMS.includes(i))];
      const p = at(toy);
      a = order.filter((i) => !tried.has(i) && !A.arms[i].busy && !(A.ignore[i].get(toy) > A.time))
        .sort((x, y) => Math.hypot(...A.arms[x].frame.p.map((v, c) => v - p[c])) - Math.hypot(...A.arms[y].frame.p.map((v, c) => v - p[c])))[0] ?? -1;
      if (a < 0 || !A.reachToy(a, toy)) { out.reaches.push({ arm: a, sent: false }); continue; }
    }
    tried.add(a);
    const rec = { arm: a, bendT: null, bendMax: 0, grip: null, gripArc: null };
    let s = 0;
    await until(loco, () => {
      s += 1 / 60;
      const g = A.arms[a].goal;
      if (g?.kind === 'reach') rec.bendMax = Math.max(rec.bendMax, A.arms[a].reachB);
      if (rec.bendT === null && g?.kind !== 'reach') rec.bendT = r3(s);
      return gripping() >= 0;
    }, 8);
    rec.grip = gripping() >= 0 ? r3(s) : null;
    if (A.episodes[a]?.h && A.episodes[a].toy === toy) rec.gripArc = r3(A.episodes[a].arc / A.arms[a].length);
    out.reaches.push(rec);
  }
  arm = gripping();
  out.arm = arm;
  if (arm < 0) return { out: { ...out, failed: 'no grip' }, arm: -1 };
  // A grip that formed on the way there, before any reach, has no bend wave to judge.
  const last = out.reaches[out.reaches.length - 1];
  // The bend must have traveled for half a second and reached the contact (or a third of the arm), not snapped there.
  out.bendWave = last ? (last.bendT ?? last.grip ?? 0) >= 0.5 && last.bendMax >= Math.min(0.3, 0.8 * (last.gripArc ?? 1)) : null;
  return { out, toy, arm, at, crownDist, rad, resting };
}

/* The ball exit: reach a resting ball with a bend wave, grip, stow it in the web, carry it 0.4 m, and let go on
   command, with no arm ever gripping another. Needs ctx.carry. */
export async function ballScenario(ctx, { urgency = 0.5, carryUrgency = 0.4, reaches = 3, knobs = null } = {}) {
  const { loco, arms: A, mantle: m, carry } = ctx;
  if (!carry || typeof A.stow !== 'function') return { passed: false, failed: 'no carry support in the arms yet' };
  if (knobs) Object.assign(carry.knobs, knobs);
  const sel0 = A.counts.selfSealed, rel0 = A.counts.release, panelX = ctx.layoutKnobs?.panelX ?? 0.1, sdf = A.sdf, nrm = [0, 0, 0];
  const g = await reachAndGrip(ctx, { urgency, reaches });
  const { out, toy, arm, at, crownDist, rad, resting } = g;
  out.passed = false;
  if (arm < 0) return out;
  // Stow it, then wait for it to sit in the web.
  out.stowed = carry.stow(arm, { force: !out.small });
  let s = 0;
  out.underWebT = (await until(loco, () => { s += 1 / 60; return crownDist(toy) <= rad(toy) + 0.06; }, 4)) ? r3(s) : null;

  // Carry it 0.4 m across the floor, to the open spot farthest from the furniture.
  const c0 = m.ring().c;
  let best = null, bestD = -Infinity;
  for (let i = 0; i < 16; i++) {
    const th = (i / 16) * 2 * Math.PI, p = [c0[0] + 0.4 * Math.cos(th), 0, c0[2] + 0.4 * Math.sin(th)];
    if (p[0] > panelX - 0.2 || Math.abs(p[0]) > TANK.w / 2 - 0.15 || Math.abs(p[2]) > TANK.d / 2 - 0.12) continue;
    sdf.unfocus();
    const dd = sdf.distance(p[0], 0.05, p[2], nrm);
    if (dd > bestD) { bestD = dd; best = p; }
  }
  const watch = { ticks: 0, near: 0, strokes: 0, fMax: 0, capMin: Infinity, track: [], detail: [] };
  let acc = 0;
  const fn = (dt) => {
    watch.ticks++;
    const dist = crownDist(toy), ep = A.episodes[arm];
    if (dist <= rad(toy) + 0.1) watch.near++;
    const role = loco.state.roles[arm];
    if (role === 'seek' || role === 'planted') watch.strokes++;
    if (ep?.h) { watch.fMax = Math.max(watch.fMax, ep.fEma); watch.capMin = Math.min(watch.capMin, ep.capEma); }
    if ((acc += dt) >= 0.1) {
      const M = A._mouth, G = A.gripPos, o = arm * 3, g = A.arms[arm].goal;
      watch.track.push(r3(dist));
      watch.detail.push([r3(at(toy)[1]), r3(Math.hypot(G[o] - M[0], G[o + 1] - M[1], G[o + 2] - M[2])), g?.kind?.[0] ?? '-', r3(m.ring().down[1])]);
      acc = 0;
    }
  };
  loco.listeners.add(fn);
  let res = { arrived: false, failed: 'no spot' };
  if (best) {
    const dc = loco.want(best, { urgency: carryUrgency, source: 'scenario' });
    let over = false;
    res = dc ? await Promise.race([dc.done, until(loco, () => over, 30).then(() => ({ arrived: false, failed: 'timeout' }))]) : { arrived: false, failed: 'refused' };
    over = true;
    if (loco.desire === dc) loco.stop('timeout');
  }
  loco.listeners.delete(fn);
  out.refetches = carry.job[arm]?.refetch ?? 0;
  Object.assign(out, {
    to: best?.map(r3) ?? null, arrived: !!res.arrived, carryT: r3(res.t ?? 30), carryFailed: res.failed ?? null, heldShare: r3(watch.near / Math.max(1, watch.ticks)),
    stowedStrokeTicks: watch.strokes, gripPeakN: r3(watch.fMax), gripCapMinN: Number.isFinite(watch.capMin) ? r3(watch.capMin) : null, track: watch.track, detail: watch.detail,
  });

  // G again: everything lets go.
  out.g2 = A.toggleGrip();
  out.releaseWhy = A.counts.release > rel0 ? 'release' : null;
  s = 0;
  const clear = await until(loco, () => { s += 1 / 60; return crownDist(toy) - rad(toy) >= 0.05 || resting(toy); }, 3);
  out.clearT = clear ? r3(s) : null;
  out.selfSealed = A.counts.selfSealed - sel0;
  out.passed = !!(out.bendWave !== false && out.underWebT !== null && out.heldShare >= 0.9 && out.stowedStrokeTicks === 0 && out.arrived
    && out.carryT <= 30 && out.releaseWhy && out.clearT !== null && out.selfSealed === 0);
  return out;
}

/* Report only: grip the nearest resting thing on her side, then haul her to it whatever whoMoves says, and log who
   actually moved. A toy that isn't wedged should come to her on the opposite pull. */
export async function haulScenario(ctx, { urgency = 0.5 } = {}) {
  const { loco, arms: A, mantle: m, carry } = ctx;
  if (!carry || typeof A.freeze !== 'function') return { passed: null, failed: 'no haul support in the arms yet' };
  const g = await reachAndGrip(ctx, { urgency });
  const { out, toy, arm, at } = g;
  out.passed = null;
  if (arm < 0) return out;
  const who = A.whoMoves(arm), c0 = [...m.ring().c], t0 = at(toy), r = [0, 0, 0];
  Object.assign(out, { who: who?.who, why: who?.why, wedged: who?.wedged, resting: who?.resting, anchor: who ? r3(who.anchor) : null });
  out.hauling = carry.haul(arm, { urgency });
  let s = 0, fMax = 0, chordMin = Infinity, strain = 0;
  if (out.hauling) {
    await until(loco, () => {
      s += 1 / 60;
      const j = carry.job[arm];
      fMax = Math.max(fMax, m.armForce[arm]);
      if (j?.kind === 'haul') { m.rootWorld(arm, r); const P = at(toy); chordMin = Math.min(chordMin, Math.hypot(r[0] - P[0], r[1] - P[1], r[2] - P[2])); }
      strain = Math.max(strain, m.health().strainMax);
      return j?.kind !== 'haul';
    }, carry.knobs.haulMax + 1);
  }
  const c1 = m.ring().c, t1 = at(toy);
  Object.assign(out, {
    t: r3(s), ended: carry.last, crownMoved: r3(Math.hypot(c1[0] - c0[0], c1[2] - c0[2])), toyMoved: r3(Math.hypot(t1[0] - t0[0], t1[2] - t0[2])),
    peakN: r3(fMax), chordMin: Number.isFinite(chordMin) ? r3(chordMin) : null, strainMax: r3(strain),
  });
  A.releaseAll();
  return out;
}

register('ball', { label: 'Ball', key: '1', run: ballScenario });
register('haul', { label: 'Haul to a toy', run: haulScenario });
