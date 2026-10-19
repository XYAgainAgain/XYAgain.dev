import { EYE } from './mantle-core.js';
import { createRng, deriveSeed } from '../../../pond/js/rng.js';

/* Where her attention goes and which arm answers it, THREE-free. She looks with one eye, the left by preference,
   and the arm lying between that eye and the thing is the one that reaches. The picker is a stand-in for the brain. */

export const ATTEND_KNOBS = {
  curious: true,          // the stand-in picker: off, she only looks where she is told
  pickMin: 6,             // s between the picker's idle decisions, at random in this range
  pickMax: 16,
  toyShare: 0.55,         // share of decisions that pick a toy; the rest attend to nothing
  holdMin: 3,             // s an idle look lasts
  holdMax: 8,
  novel: 3,               // weight on a toy she has never looked at, against 1 for a familiar one
  moved: 4,               // weight on a toy that has moved since she last looked
  movedBy: 0.05,          // m a toy must move to count as moved
  reachRange: 0.7,        // m from her center that the look-and-reach prefers a toy within
  backBias: 0.8,          // rad a back pair arm pays against the front two pairs, about one arm's spacing
  reachWait: 6,           // s the look-and-reach waits for her turn to finish before reaching anyway
};

// Exploring arms in order of preference: the front pair, then the second.
export const FRONT_ARMS = [0, 7, 1, 6];

export function wrap(a) { return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI)); }

/* An eye's resting aim as a flat bearing, atan2(z, x), for a body facing (cos yaw, sin yaw): right is +z at yaw 0. */
export function restBearing(yaw, eye, ahead) {
  return yaw + (eye === EYE.left ? -1 : 1) * (Math.PI / 2 - ahead);
}

/* How far, flat and signed, a body turn must go to bring an eye's rest aim onto a point; NaN with no bearing. */
export function eyeTurn(yaw, eye, from, point, ahead) {
  const dx = point[0] - from[0], dz = point[2] - from[2];
  if (!(Math.hypot(dx, dz) > 1e-3)) return NaN;
  return wrap(Math.atan2(dz, dx) - restBearing(yaw, eye, ahead));
}

/* The eye she looks with: the left unless the right would save more than `favor` radians of turning. */
export function chooseEye(yaw, eyes, point, ahead, favor) {
  const l = Math.abs(eyeTurn(yaw, EYE.left, eyes[EYE.left], point, ahead));
  const r = Math.abs(eyeTurn(yaw, EYE.right, eyes[EYE.right], point, ahead));
  if (!Number.isFinite(l)) return Number.isFinite(r) ? EYE.right : EYE.left;
  return r + favor < l ? EYE.right : EYE.left;
}

/* The arm lying along the flat line from the eye to the point (Byrne et al. 2006b): the one whose outward bearing
   from the crown's center turns least from that line. A back pair arm pays `backBias` radians, a strong preference. */
export function armOnLine(roots, eye, point, { backBias = ATTEND_KNOBS.backBias } = {}) {
  const n = roots.length / 3, bx = point[0] - eye[0], bz = point[2] - eye[2];
  if (!(Math.hypot(bx, bz) > 1e-6) || !(n > 0)) return FRONT_ARMS[0];
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += roots[i * 3] / n; cz += roots[i * 3 + 2] / n; }
  const line = Math.atan2(bz, bx);
  let best = FRONT_ARMS[0], score = Infinity;
  for (let i = 0; i < n; i++) {
    const s = Math.abs(wrap(Math.atan2(roots[i * 3 + 2] - cz, roots[i * 3] - cx) - line)) + (FRONT_ARMS.includes(i) ? 0 : backBias);
    if (s < score) { score = s; best = i; }
  }
  return best;
}

/* One idle decision: a toy index weighted toward the new and the moved, or -1 for nothing (`force` always picks one
   if any is finite). `seen[i]` is where toy i was when she last looked at it, or null if she never has. */
export function pickInterest(points, seen, rng, k = ATTEND_KNOBS, force = false) {
  if (!points.length || (!force && !rng.chance(k.toyShare))) return -1;
  let total = 0;
  const w = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i], s = seen[i];
    if (!p.every(Number.isFinite)) continue;
    w[i] = !s ? k.novel : Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]) > k.movedBy ? k.moved : 1;
    total += w[i];
  }
  if (!(total > 0)) return -1;
  let u = rng.next() * total;
  for (let i = 0; i < w.length; i++) { u -= w[i]; if (w[i] > 0 && u <= 0) return i; }
  return w.findLastIndex((x) => x > 0);
}

/* The Phase 1 stand-in for her brain's attention: idle looks at the toys, and the look-and-reach. Ticks on the fixed
   step from a seeded generator, so a seed replays the same looks. */
export class Attention {
  constructor(pose, arms, toys, { seed = 1, knobs = {} } = {}) {
    this.pose = pose;
    this.arms = arms;
    this.toys = toys;
    this.knobs = { ...ATTEND_KNOBS, ...knobs };
    this.rng = createRng(deriveSeed(seed, 4111));
    this.points = toys.map(() => [0, 0, 0]);
    this._read();
    this.seen = this.points.map(() => null);
    this.toy = -1;            // the toy being attended, if any
    this.until = 0;           // sim time an idle look ends
    this.next = this.rng.range(this.knobs.pickMin, this.knobs.pickMax);
    this.reach = null;        // { toy, since } while a look-and-reach waits for her turn
    this.reached = -1;        // the arm the last look-and-reach sent
    this.time = 0;
    this._eye = -1;           // the eye last aimed on a drawn frame
    this._eye3 = [0, 0, 0];
    this._roots = new Float64Array(arms.arms.length * 3);
    this._r = [0, 0, 0];
  }

  _read() {
    for (let i = 0; i < this.toys.length; i++) {
      const p = this.toys[i].body.GetPosition(), o = this.points[i];
      o[0] = p.GetX(); o[1] = p.GetY(); o[2] = p.GetZ();
    }
  }

  /* Attend to toy i (or nothing with -1); its point is read from Jolt every tick, so a pushed toy stays watched. */
  attendToy(i, hold = Infinity) {
    if (i >= 0 && i < this.toys.length) {
      this.toy = i;
      this.reached = -1;
      this.seen[i] = [...this.points[i]];
      this.until = this.time + hold;
      return this.pose.attend(this.points[i]);
    }
    this.toy = -1;
    this.reach = null;
    this.pose.attend(null);
    return null;
  }

  /* Look at a toy with her favored eye and, once she has turned, reach with the arm on that eye's line. With no toy
     given she picks one in reach, the new and moved likelier. */
  lookAndReach(toy = null) {
    let i = toy === null ? -1 : typeof toy === 'number' ? toy : this.toys.indexOf(toy);
    if (i < 0) i = this._pickNear();
    if (i < 0) return null;
    const eye = this.attendToy(i);
    this.reach = { toy: i, since: this.time };
    return eye;
  }

  _pickNear() {
    const c = this.pose.center, far = [NaN, NaN, NaN];
    const near = this.points.map((p) => (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < this.knobs.reachRange ? p : far));
    // Asked, not idle: always a toy, in reach when there is one.
    const i = pickInterest(near, this.seen, this.rng, this.knobs, true);
    return i >= 0 ? i : pickInterest(this.points, this.seen, this.rng, this.knobs, true);
  }

  tick(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    this._read();
    const k = this.knobs, pose = this.pose;
    if (this.reach) {
      const settled = !pose.turning && !this.arms.lead && pose.focus && Math.abs(pose.focus.turn) <= pose.knobs.eyeSlack + 1e-6;
      if (settled || this.time - this.reach.since > k.reachWait) this._send(this.reach.toy);
    }
    if (this.toy >= 0 && !this.reach && this.time >= this.until) this.attendToy(-1);
    // Idle is nothing leading her, nothing on a path, and no look of her own under way.
    const idle = !this.arms.lead && !pose.path && this.toy < 0 && !pose.focus;
    if (!k.curious || !idle) { if (this.next < this.time) this.next = this.time + k.pickMin; return; }
    if (this.time < this.next) return;
    this.next = this.time + this.rng.range(k.pickMin, Math.max(k.pickMin, k.pickMax));
    const i = pickInterest(this.points, this.seen, this.rng, k);
    if (i >= 0) this.attendToy(i, this.rng.range(k.holdMin, Math.max(k.holdMin, k.holdMax)));
  }

  _send(i) {
    this.reach = null;
    const pose = this.pose, m = pose.mantle, f = pose.focus, eye = this._eye3, R = this._roots;
    if (!f) return;
    // Live eye and roots: the line is judged where she actually is once the turn has run in.
    const e = m.shell.eyes[f.eye] * 3;
    for (let a = 0; a < 3; a++) eye[a] = m.positions[e + a] + m.origin[a];
    for (let r = 0; r < R.length / 3; r++) {
      m.rootWorld(r, this._r);
      R[r * 3] = this._r[0]; R[r * 3 + 1] = this._r[1]; R[r * 3 + 2] = this._r[2];
    }
    const arm = armOnLine(R, eye, this.points[i], this.knobs);
    this.reached = this.arms.reachToy(arm, this.toys[i]) ? arm : -1;
    // A held look ends a while after the reach, like an idle one.
    this.until = this.time + this.rng.range(this.knobs.holdMin, Math.max(this.knobs.holdMin, this.knobs.holdMax));
  }

  /* On drawn frames: aim the attending eye at the thing, and hand an eye back to its idle glances when it is done. */
  aimEyes(parts) {
    const f = this.pose.focus;
    const eye = f ? f.eye : -1;
    if (this._eye >= 0 && this._eye !== eye) parts.look(this._eye, null);
    if (f) parts.look(eye, f.point);
    this._eye = eye;
  }

  /* One line for the panel. */
  describe() {
    const f = this.pose.focus;
    if (this.arms.lead) return 'leading the squeeze';
    if (!f) return this.knobs.curious ? 'nothing, drifting' : 'nothing (picker off)';
    const what = this.toy >= 0 ? `toy ${this.toy}` : 'a point';
    const arm = this.reached >= 0 && this.toy >= 0 ? `, arm ${this.reached}` : this.reach ? ', about to reach' : '';
    return `${what}, ${f.eye === EYE.left ? 'left' : 'right'} eye${this.pose.turning ? ', turning' : ''}${arm}`;
  }
}
