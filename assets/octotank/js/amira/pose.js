import { EYE, EYE_KNOBS } from './mantle-core.js';
import { createRng, deriveSeed } from '../../../pond/js/rng.js';
import { wrap, eyeTurn, chooseEye } from './attention.js';

/* Her heading, plus the rigid posture (a virtual center the arm roots keep their rest offsets around) while a path
   runs, ?loco=0 is set, or the drive isn't force. Live, center and yaw are read off her body and the heading
   controller's yawCmd is what her planted arms turn her toward. She brings an eye onto what she attends to, else drifts. */

export const POSE_KNOBS = {
  turnRate: 0.8,          // rad/s at most: plausible, but no study measured a peak
  turnLag: 0.6,           // s: how quickly a heading error becomes turning
  turnEase: 0.3,          // s: how quickly the turn rate itself changes, so a turn starts and stops softly
  deadband: 0.3,          // rad of heading error she lets stand before turning at all
  eyeSlack: 0.7,          // rad off an eye's rest aim a thing may sit before her body turns, not just the eye
  driftMin: 20,           // s between idle changes of heading, at random in this range
  driftMax: 45,
  driftStep: 0.9,         // rad at most per change, either way; small ones add up until one passes the dead band
  turnHold: 2,            // s a finished turn's command is held for her arms to bring her body onto it
};

// Heading sources, strongest first: the squeeze's lead, a commanded heading, attention, then the idle drift.
export const HEADING = { drift: 0, attend: 1, command: 2, lead: 3 };
const { lead: LEAD, command: COMMAND, attend: ATTEND, drift: DRIFT } = HEADING;

export class Pose {
  constructor(mantle, start, knobs = {}, { seed = 1, eyeKnobs = EYE_KNOBS, rigid = false } = {}) {
    this.mantle = mantle;
    this.knobs = { ...POSE_KNOBS, ...knobs };
    this.eyeKnobs = eyeKnobs;   // main.js points this at the eyes' own live knobs
    this.center = [...start];
    this.yaw = 0;               // her heading is (cos yaw, sin yaw) on the floor plane (x, z)
    this.yawCmd = 0;            // the heading the controller asks for; the same as yaw while rigid
    this.command = null;        // a yaw a caller wants her to face, above attention and under the lead
    this.alwaysRigid = !!rigid; // ?loco=0
    this.yawRate = 0;
    this.turning = false;
    this.squash = 1;           // vertical scale on the root offsets: a flattened posture fits a low hole
    this.path = null;          // { keys: [[t, x, y, z, squash?]], t: 0, resolve }
    this.time = 0;
    this.focus = null;         // { point, eye, turn }: what she attends to, which eye, and the body turn it asks for
    this.source = DRIFT;       // the source steering her now
    this.turnTo = 0;           // the heading a started turn is committed to
    this.turnEnd = -Infinity;  // when the last turn's command arrived
    this.rng = createRng(deriveSeed(seed, 2203));
    this.driftYaw = 0;
    this.driftAt = this.rng.range(this.knobs.driftMin, Math.max(this.knobs.driftMin, this.knobs.driftMax));
    // Deepest root below the shell center, which is what has to clear the bottom lip of a hole.
    this.rootDrop = Math.max(...mantle.roots.map((i) => Math.abs(mantle.shell.positions[i * 3 + 1])));
    const P = mantle.shell.positions, E = mantle.shell.eyes;
    this.eyeRest = [EYE.right, EYE.left].map((e) => (E ? [P[E[e] * 3], P[E[e] * 3 + 1], P[E[e] * 3 + 2]] : [0, 0, e === EYE.left ? -0.03 : 0.03]));
    this._eyes = [[0, 0, 0], [0, 0, 0]];
    this._frame = { f: [1, 0, 0], u: [0, 1, 0], s: [0, 0, 1] };
    this._wasRigid = true;
  }

  /* Rigid while a path runs, with ?loco=0, on a drive that isn't force, or on a body that can't report itself. */
  get rigid() {
    const m = this.mantle;
    return !!this.path || this.alwaysRigid || (m.drive !== undefined && m.drive !== 'force') || typeof m.centroid !== 'function' || typeof m.bodyFrame !== 'function';
  }

  /* Live: where she really is. Her yaw only means something while her up is near vertical; past that it holds. */
  _readBody() {
    const m = this.mantle;
    m.sync?.();
    m.centroid(this.center);
    const f = m.bodyFrame(this._frame);
    if (f.u[1] > 0.7 && Math.hypot(f.f[0], f.f[2]) > 1e-6) this.yaw = Math.atan2(f.f[2], f.f[0]);
  }

  /* Follow a list of [seconds, x, y, z, squash?] keys in order; resolves with the keys' end time when done. */
  follow(keys) {
    return new Promise((resolve) => {
      this.path = { keys, t: 0, resolve };
    });
  }

  /* Attend to a world point (an array, read live each tick, or a copied {x, y, z}), or to nothing with null. She
     picks the eye (her left unless the right saves more than `favor`), or takes `eye`; returns the eye's name. */
  attend(point, eye = null) {
    const p = Array.isArray(point) || ArrayBuffer.isView(point) ? point : point ? [point.x, point.y, point.z] : null;
    if (!p || !(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))) { this.focus = null; return null; }
    const k = this.eyeKnobs, eyes = this.eyeCenters();
    const e = eye === 'left' || eye === EYE.left ? EYE.left : eye === 'right' || eye === EYE.right ? EYE.right : chooseEye(this.yaw, eyes, p, k.eyeAhead, k.favor);
    this.focus = { point: p, eye: e, turn: eyeTurn(this.yaw, e, eyes[e], p, k.eyeAhead) };
    return e === EYE.left ? 'left' : 'right';
  }

  /* Both eyes' centers where the posture puts them, at the commanded heading rather than the lagging skin. */
  eyeCenters(out = this._eyes) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), c = this.center;
    for (let e = 0; e < 2; e++) {
      const r = this.eyeRest[e], o = out[e];
      o[0] = c[0] + r[0] * cy - r[2] * sy; o[1] = c[1] + r[1] * this.squash; o[2] = c[2] + r[0] * sy + r[2] * cy;
    }
    return out;
  }

  /* The heading wanted now and the error that starts a turn toward it, from the strongest source that has one. */
  _goal(lead, out) {
    const k = this.knobs, c = this.center, f = this.focus;
    // The eye's error stays current under the lead too, since callers read it to judge when she has settled.
    if (f) {
      const p = f.point;
      f.turn = Number.isFinite(p[0] + p[1] + p[2]) ? eyeTurn(this.yaw, f.eye, this.eyeCenters()[f.eye], p, this.eyeKnobs.eyeAhead) : NaN;
    }
    if (lead && Number.isFinite(lead[0] + lead[2]) && Math.hypot(lead[0] - c[0], lead[2] - c[2]) > 1e-3) {
      out.src = LEAD; out.yaw = Math.atan2(lead[2] - c[2], lead[0] - c[0]); out.start = k.deadband;
      return out;
    }
    if (Number.isFinite(this.command)) {
      out.src = COMMAND; out.yaw = wrap(this.command); out.start = k.deadband;
      return out;
    }
    if (f && Number.isFinite(f.turn)) {
      out.src = ATTEND; out.yaw = wrap(this.yaw + f.turn); out.start = Math.max(k.deadband, k.eyeSlack);
      return out;
    }
    out.src = DRIFT; out.yaw = this.driftYaw; out.start = k.deadband;
    return out;
  }

  /* Ease her heading toward the goal. The dead band keeps her from fidgeting; once she starts a turn she finishes it,
     a weaker source can't take a turn over, and a turn under way keeps its side when the target crosses behind her. */
  _steer(dt, lead, rigid) {
    // Rigid, the command is her heading, so a heading set from outside steers from there. Live, it follows her body
    // except during a turn and for turnHold after one, so a stale command never spins her.
    if (rigid) this.yawCmd = this.yaw;
    else if (!this.turning && this.time - this.turnEnd > this.knobs.turnHold) {
      this.yawCmd = this.yaw;
      if (this.source === DRIFT) this.driftYaw = this.yaw;
    }
    const k = this.knobs, g = this._goal(lead, this._g ??= { src: DRIFT, yaw: 0, start: 0 });
    // A turn a stronger source started runs to its committed heading before a weaker one gets a say.
    if (!this.turning || g.src >= this.source) { this.source = g.src; this.turnTo = g.yaw; }
    let want = 0;
    let e = wrap(this.turnTo - this.yawCmd);
    if (this.yawRate !== 0 && Math.abs(e) > 2.8 && Math.sign(e) !== Math.sign(this.yawRate)) e += 2 * Math.PI * Math.sign(this.yawRate);
    if (!this.turning && Math.abs(e) > g.start) this.turning = true;
    else if (this.turning && Math.abs(e) < k.deadband * 0.3) { this.turning = false; this.turnEnd = this.time; }
    if (this.turning) want = Math.max(-k.turnRate, Math.min(k.turnRate, e / Math.max(1e-3, k.turnLag)));
    this.yawRate += (want - this.yawRate) * Math.min(1, dt / Math.max(1e-3, k.turnEase));
    if (Math.abs(this.yawRate) < 1e-4 && !this.turning) this.yawRate = 0;
    this.yawCmd = wrap(this.yawCmd + this.yawRate * dt);
    if (rigid) this.yaw = this.yawCmd;
    // The drift walks only while nothing stronger steers; it restarts from wherever she was left facing.
    if (this.source !== DRIFT || g.src !== DRIFT) {
      this.driftYaw = this.yawCmd;
      this.driftAt = Math.max(this.driftAt, this.time + k.driftMin);
    } else if (this.time >= this.driftAt) {
      this.driftYaw = wrap(this.driftYaw + this.rng.range(-k.driftStep, k.driftStep));
      this.driftAt = this.time + this.rng.range(k.driftMin, Math.max(k.driftMin, k.driftMax));
    }
  }

  tick(dt, arms = null) {
    this.time += dt;
    const rigid = this.rigid;
    if (!rigid) {
      this._readBody();
      this.squash = 1;
      // Coming off a path, the command starts from where she actually faces.
      if (this._wasRigid) { this.yawCmd = this.driftYaw = this.turnTo = this.yaw; this.yawRate = 0; this.turning = false; }
    }
    this._wasRigid = rigid;
    // Off the level her yaw means nothing: the command rests on her body and she doesn't turn until she is back down.
    if (!rigid && !(this._frame.u[1] > 0.7)) { this.yawCmd = this.turnTo = this.driftYaw = this.yaw; this.yawRate = 0; this.turning = false; return; }
    if (dt > 0) this._steer(dt, arms?.lead ?? null, rigid);
    if (!rigid) return;
    if (this.path) {
      const p = this.path;
      p.t += dt;
      const keys = p.keys;
      let k = 0;
      while (k < keys.length - 1 && p.t > keys[k + 1][0]) k++;
      if (k >= keys.length - 1) {
        this.center[0] = keys[k][1]; this.center[1] = keys[k][2]; this.center[2] = keys[k][3];
        this.squash = keys[k][4] ?? 1;
        this.path = null;
        p.resolve(p.t);
      } else {
        const a = keys[k], b = keys[k + 1];
        const u = smooth((p.t - a[0]) / Math.max(1e-6, b[0] - a[0]));
        this.center[0] = a[1] + (b[1] - a[1]) * u;
        this.center[1] = a[2] + (b[2] - a[2]) * u;
        this.center[2] = a[3] + (b[3] - a[3]) * u;
        const sa = a[4] ?? 1, sb = b[4] ?? 1;
        this.squash = sa + (sb - sa) * u;
      }
    } else {
      // Idle: a slow figure around the start so the pin drive is always doing something visible.
      this.center[0] += Math.sin(this.time * 0.37) * 0.02 * dt;
      this.center[1] += Math.cos(this.time * 0.23) * 0.015 * dt;
    }
    // Each driven vertex keeps its rest offset from the center, so a posture is a translation, a yaw, and a squash.
    const m = this.mantle, t = m.targets, rest = m.shell.positions, cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    for (let d = 0; d < m.driven.length; d++) {
      const i = m.driven[d] * 3, ox = rest[i], oy = rest[i + 1], oz = rest[i + 2];
      t[d * 3] = this.center[0] + ox * cy - oz * sy;
      t[d * 3 + 1] = this.center[1] + oy * this.squash;
      t[d * 3 + 2] = this.center[2] + ox * sy + oz * cy;
    }
  }
}

function smooth(u) { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); }
