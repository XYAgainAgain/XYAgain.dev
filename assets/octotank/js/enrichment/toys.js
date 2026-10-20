import { TANK, LAYERS } from '../config.js';
import { createRng, deriveSeed } from '../../../pond/js/rng.js';
import { MATERIALS, SEAWATER, WATER_KNOBS, assignMaterials, buoyancyFactor, weightInWater, densityT, rampHex } from '../water/buoyancy-core.js';
import { LAYOUT_KNOBS, axisAngle } from '../tank/layout.js';

/* Twelve toys of four shapes and seeded materials, placed on both sides of the panel. `keepOut` is a list of
   [x, y, z, radius] spheres a toy must not start inside (the rocks, the mantle). */
export function buildToys(phys, seed, count = 12, { keepOut = [], panelX = LAYOUT_KNOBS.panelX, panelT = LAYOUT_KNOBS.panelT, floaters = WATER_KNOBS.floaters } = {}) {
  const rng = createRng(deriveSeed(seed, 77));
  const materials = assignMaterials(createRng(deriveSeed(seed, 78)), count, { floaters });
  const reserved = new Set();
  for (const slot of [0, 2, 3].filter((i) => i < count)) {
    if (MATERIALS[materials[slot]].rho >= SEAWATER.rho) {
      const donor = materials.findIndex((name, i) => !reserved.has(i) && MATERIALS[name].rho < SEAWATER.rho);
      if (donor >= 0) [materials[slot], materials[donor]] = [materials[donor], materials[slot]];
    }
    reserved.add(slot);
  }
  const toys = [];
  const kinds = ['sphere', 'box', 'capsule', 'cylinder'];
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % 4];
    const s = rng.range(0.02, 0.04);
    const size = kind === 'sphere' ? [s] : kind === 'box' ? [s, s * rng.range(0.6, 1.2), s * rng.range(0.6, 1.2)] : [s, s * 0.6];
    const material = materials[i], rho = MATERIALS[material].rho;
    const left = (i === 0 || i === 2) && rho < SEAWATER.rho;
    const right = i === 3 && rho < SEAWATER.rho;
    const minX = right ? Math.max(0.08, panelX + panelT / 2 + 0.08) : -TANK.w / 2 + 0.1;
    const maxX = left ? Math.min(-0.08, panelX - panelT / 2 - 0.08) : TANK.w / 2 - 0.1;
    let x, y, z, tries = 0;
    do {
      x = rng.range(minX, maxX); z = rng.range(-TANK.d / 2 + 0.08, TANK.d / 2 - 0.08); y = rng.range(0.25, TANK.h * 0.75);
    } while (++tries < 40 && (Math.abs(x - panelX) < panelT / 2 + 0.05 || keepOut.some(([kx, ky, kz, kr]) => Math.hypot(x - kx, y - ky, z - kz) < kr + 0.05)));
    // A spent draw where the old gravity stand-in sat, so every seed keeps its toys' places and turns.
    rng.next();
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
