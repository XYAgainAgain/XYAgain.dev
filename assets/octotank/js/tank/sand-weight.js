import { shareLoad } from './sand-core.js';
import { armMassShare } from '../amira/arms/arm-rod.js';

const G = 9.81;

/* Her weight in water on the gravel, through only the skin and arm nodes resting on the bed, each by its own mass. An arm
   holding her body up carries that much of it down its own nodes instead, so the total never counts twice. */
export function registerWeight(contacts, field, mantle, arms) {
  const n = mantle.shell?.count ?? mantle.positions.length / 3, slots = arms.bodies.length;
  const skinTouch = new Uint8Array(n), skinForce = new Float64Array(n), skinMass = mantle.vertexMass ?? new Float64Array(n).fill(1);
  const support = new Float64Array(slots), armWeight = new Float64Array(slots);
  const nodes = Math.max(...arms.bodies.map((b) => b.n)), nodeTouch = new Uint8Array(nodes), nodeMass = new Float64Array(nodes), nodeForce = new Float64Array(nodes);
  const wf = arms.rodKnobs?.weightFactor ?? mantle.knobs?.gravityFactor ?? 0;
  for (let a = 0; a < slots; a++) armWeight[a] = (arms.armsMass ?? 0) * armMassShare(arms.arms[a].index, arms.knobs, arms.rodKnobs) * G * wf;
  // Each arm's upward push on her body, read once a tick before either provider spends it.
  const readSupport = () => {
    const F = mantle._armF;
    let sum = 0;
    for (let a = 0; a < slots; a++) { const up = F && Number.isFinite(F[a * 3 + 1]) ? Math.max(0, F[a * 3 + 1]) : 0; support[a] = up; sum += up; }
    return sum;
  };
  const remove = [
    contacts.register(mantle, (emit) => {
      const P = mantle.positions, o = mantle.origin, radius = mantle.knobs?.vertexRadius ?? 0.004, k = mantle.knobs ?? {};
      const weight = Number.isFinite(k.mass * k.gravityFactor) ? k.mass * G * k.gravityFactor : 0;
      const held = readSupport();
      for (let i = 0; i < n; i++) skinTouch[i] = field.touches(P[i * 3] + o[0], P[i * 3 + 1] + o[1] - radius, P[i * 3 + 2] + o[2]) ? 1 : 0;
      shareLoad(weight - held, skinMass, skinTouch, skinForce, n);
      for (let i = 0; i < n; i++) emit(P[i * 3] + o[0], P[i * 3 + 1] + o[1], P[i * 3 + 2] + o[2], radius, skinForce[i]);
    }),
    contacts.register(arms, (emit) => {
      for (let a = 0; a < slots; a++) {
        const arm = arms.bodies[a];
        if (arm.valid === false) continue;
        const X = arm.X, R = arm.drawRad ?? arm.rad, m = arm.n;
        // A node weighs its radius² times its share of the two segments beside it.
        for (let i = 0; i < m; i++) {
          const o = i * 3, before = i > 0 ? Math.hypot(X[o] - X[o - 3], X[o + 1] - X[o - 2], X[o + 2] - X[o - 1]) : 0;
          const after = i < m - 1 ? Math.hypot(X[o + 3] - X[o], X[o + 4] - X[o + 1], X[o + 5] - X[o + 2]) : 0;
          nodeMass[i] = R[i] * R[i] * (before + after) / 2;
          nodeTouch[i] = field.touches(X[o], X[o + 1] - R[i], X[o + 2]) ? 1 : 0;
        }
        shareLoad(armWeight[a] + support[a], nodeMass, nodeTouch, nodeForce, m);
        for (let i = 0; i < m; i++) emit(X[i * 3], X[i * 3 + 1], X[i * 3 + 2], R[i], nodeForce[i]);
      }
    }),
  ];
  return () => { for (const r of remove) r(); };
}
