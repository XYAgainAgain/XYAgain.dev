import { TANK, WALL, LAYERS } from './config.js';
import { createRng, deriveSeed } from '../../pond/js/rng.js';
import { MATERIALS, assignMaterials, buoyancyFactor, weightInWater, densityT, rampHex } from './water-core.js';

/* The fixed furniture of the spike: six tank panels, a rock wall with a hole, two boulders, and a dozen toys, all plain
   Jolt shapes. `tag` is what a piece is to the code; `taste` is what a sucker reports touching it, and can change. */

export const LAYOUT_KNOBS = {
  panelX: 0.1,        // where the rock wall stands
  gapH: 0.07,         // the slot's height, under the mantle's 0.12 m resting diameter
  gapY: 0.32,         // slot center height
  panelT: 0.06,
  bullnose: true,     // round the slot's lips; a hard box corner snags shell vertices on the way through
};

export function buildTank(phys) {
  const hw = TANK.w / 2, hh = TANK.h / 2, hd = TANK.d / 2, t = WALL / 2;
  const opts = { motion: 'static', layer: LAYERS.NON_MOVING, friction: 0.6 };
  const walls = [
    phys.addRigid('box', [hw + WALL, t, hd + WALL], [0, -t, 0], opts),                 // floor
    phys.addRigid('box', [hw + WALL, t, hd + WALL], [0, TANK.h + t, 0], opts),         // lid
    phys.addRigid('box', [t, hh + WALL, hd + WALL], [-hw - t, hh, 0], opts),           // left
    phys.addRigid('box', [t, hh + WALL, hd + WALL], [hw + t, hh, 0], opts),            // right
    phys.addRigid('box', [hw + WALL, hh + WALL, t], [0, hh, -hd - t], opts),           // back
    phys.addRigid('box', [hw + WALL, hh + WALL, t], [0, hh, hd + t], opts),            // front glass
  ];
  for (const w of walls) { w.tag = 'wall'; w.taste = 'glass'; }
  walls[0].taste = 'floor';
  walls[1].taste = 'lid';
  return walls;
}

/* A rock wall across the tank split by a horizontal slot the full depth of the tank, so the glass sees the squeeze.
   With the bullnose on, each lip is a capsule lying along z whose surface sits exactly on the slot's edge. */
export function buildPanel(phys, k = LAYOUT_KNOBS) {
  const hd = TANK.d / 2, ht = k.panelT / 2;
  const opts = { motion: 'static', layer: LAYERS.NON_MOVING, friction: 0.5 };
  const yTop = k.gapY + k.gapH / 2, yBot = k.gapY - k.gapH / 2;
  const r = k.bullnose ? ht : 0;
  const parts = [
    phys.addRigid('box', [ht, (TANK.h - yTop - r) / 2, hd], [k.panelX, (TANK.h + yTop + r) / 2, 0], opts),
    phys.addRigid('box', [ht, (yBot - r) / 2, hd], [k.panelX, (yBot - r) / 2, 0], opts),
  ];
  if (r > 0) {
    const alongZ = axisAngle(1, 0, 0, Math.PI / 2);
    parts.push(phys.addRigid('capsule', [hd - r, r], [k.panelX, yTop + r, 0], { ...opts, rot: alongZ }));
    parts.push(phys.addRigid('capsule', [hd - r, r], [k.panelX, yBot - r, 0], { ...opts, rot: alongZ }));
  }
  for (const p of parts) { p.tag = 'panel'; p.taste = 'rock'; }
  return parts;
}

export function buildRocks(phys) {
  const opts = { motion: 'static', layer: LAYERS.NON_MOVING, friction: 0.7 };
  const rocks = [
    phys.addRigid('sphere', [0.09], [-0.55, 0.05, -0.12], opts),
    phys.addRigid('box', [0.07, 0.05, 0.06], [0.5, 0.05, 0.1], { ...opts, rot: axisAngle(0, 1, 0, 0.5) }),
  ];
  for (const r of rocks) { r.tag = 'rock'; r.taste = 'rock'; }
  return rocks;
}

/* Twelve toys of four shapes and seeded materials, placed on both sides of the panel. `keepOut` is a list of
   [x, y, z, radius] spheres a toy must not start inside (the rocks, the mantle). */
export function buildToys(phys, seed, count = 12, { keepOut = [], panelX = LAYOUT_KNOBS.panelX, panelT = LAYOUT_KNOBS.panelT, floaters = 0 } = {}) {
  const rng = createRng(deriveSeed(seed, 77));
  const materials = assignMaterials(createRng(deriveSeed(seed, 78)), count, { floaters });
  const toys = [];
  const kinds = ['sphere', 'box', 'capsule', 'cylinder'];
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % 4];
    const s = rng.range(0.02, 0.04);
    const size = kind === 'sphere' ? [s] : kind === 'box' ? [s, s * rng.range(0.6, 1.2), s * rng.range(0.6, 1.2)] : [s, s * 0.6];
    let x, y, z, tries = 0;
    do {
      x = rng.range(-TANK.w / 2 + 0.1, TANK.w / 2 - 0.1); z = rng.range(-TANK.d / 2 + 0.08, TANK.d / 2 - 0.08); y = rng.range(0.25, TANK.h * 0.75);
    } while (++tries < 40 && (Math.abs(x - panelX) < panelT / 2 + 0.05 || keepOut.some(([kx, ky, kz, kr]) => Math.hypot(x - kx, y - ky, z - kz) < kr + 0.05)));
    // A spent draw where the old gravity stand-in sat, so every seed keeps its toys' places and turns.
    rng.next();
    const material = materials[i], rho = MATERIALS[material].rho;
    const toy = phys.addRigid(kind, size, [x, y, z], {
      motion: 'dynamic', layer: LAYERS.TOYS, friction: 0.5, restitution: 0.05, density: rho, ccd: true,
      rot: axisAngle(rng.next(), rng.next(), rng.next(), rng.range(0, 6.28)),
    });
    toy.tag = 'toy';
    toy.taste = 'toy';
    toy.water = {
      material, rho, volume: toy.volume, mass: toy.mass,
      buoyancy: buoyancyFactor(rho), weightInWater: weightInWater(rho, toy.volume), tint: rampHex(densityT(rho)),
    };
    toys.push(toy);
  }
  return toys;
}

export function axisAngle(x, y, z, angle) {
  const l = Math.hypot(x, y, z) || 1, s = Math.sin(angle / 2);
  return [x / l * s, y / l * s, z / l * s, Math.cos(angle / 2)];
}

/* Depth of a world point inside the panel's pieces: axis-aligned boxes, and capsules lying along z. */
export function penetration(point, parts) {
  let worst = 0;
  for (const b of parts) {
    if (b.kind === 'capsule') {
      const dz = Math.max(0, Math.abs(point[2] - b.pos[2]) - b.size[0]);
      const d = b.size[1] - Math.hypot(point[0] - b.pos[0], point[1] - b.pos[1], dz);
      if (d > 0) worst = Math.max(worst, d);
      continue;
    }
    const dx = b.size[0] - Math.abs(point[0] - b.pos[0]);
    const dy = b.size[1] - Math.abs(point[1] - b.pos[1]);
    const dz = b.size[2] - Math.abs(point[2] - b.pos[2]);
    if (dx > 0 && dy > 0 && dz > 0) worst = Math.max(worst, Math.min(dx, dy, dz));
  }
  return worst;
}
