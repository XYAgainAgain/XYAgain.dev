import { TANK, LAYERS } from '../config.js';
import { createRng, deriveSeed } from '../../../pond/js/rng.js';
import { MATERIALS, SEAWATER, WATER_KNOBS, assignMaterials, buoyancyFactor, weightInWater, densityT, rampHex } from '../water/buoyancy-core.js';
import { LAYOUT_KNOBS, axisAngle } from '../tank/layout.js';

const KINDS = ['sphere', 'box', 'capsule', 'cylinder'];

function toyMaterials(seed, count, floaters) {
  const materials = assignMaterials(createRng(deriveSeed(seed, 78)), count, { floaters });
  const reserved = new Set();
  for (const slot of [0, 2, 3].filter((i) => i < count)) {
    if (MATERIALS[materials[slot]].rho >= SEAWATER.rho) {
      const donor = materials.findIndex((name, i) => !reserved.has(i) && MATERIALS[name].rho < SEAWATER.rho);
      if (donor >= 0) [materials[slot], materials[donor]] = [materials[donor], materials[slot]];
    }
    reserved.add(slot);
  }
  return materials;
}

function drawSize(rng, kind) {
  const s = rng.range(0.02, 0.04);
  return kind === 'sphere' ? [s] : kind === 'box' ? [s, s * rng.range(0.6, 1.2), s * rng.range(0.6, 1.2)] : [s, s * 0.6];
}

function makeToy(phys, kind, size, pos, rot, material) {
  const rho = MATERIALS[material].rho;
  const toy = phys.addRigid(kind, size, pos, { motion: 'dynamic', layer: LAYERS.TOYS, friction: 0.5, restitution: 0.05, density: rho, ccd: true, rot });
  toy.tag = 'toy';
  toy.taste = 'toy';
  toy.water = {
    material, rho, volume: toy.volume, mass: toy.mass,
    buoyancy: buoyancyFactor(rho), weightInWater: weightInWater(rho, toy.volume), tint: rampHex(densityT(rho)),
  };
  return toy;
}

/* Twelve toys of four shapes and seeded materials, placed on both sides of the panel. `keepOut` is a list of
   [x, y, z, radius] spheres a toy must not start inside (the rocks, the mantle). */
export function buildToys(phys, seed, count = 12, { keepOut = [], panelX = LAYOUT_KNOBS.panelX, panelT = LAYOUT_KNOBS.panelT, floaters = WATER_KNOBS.floaters } = {}) {
  const rng = createRng(deriveSeed(seed, 77));
  const materials = toyMaterials(seed, count, floaters);
  const toys = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[i % 4];
    const size = drawSize(rng, kind);
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
    toys.push(makeToy(phys, kind, size, [x, y, z], axisAngle(rng.next(), rng.next(), rng.next(), rng.range(0, 6.28)), material));
  }
  return toys;
}

const boundR = (kind, s) => (kind === 'sphere' ? s[0] : kind === 'box' ? Math.hypot(s[0], s[1], s[2]) : kind === 'capsule' ? s[0] + s[1] : Math.hypot(s[0], s[1]));

/* The same seeded toys for the rockwork: on the sand in `band` ({ x, z, top }), any turn clear of the rock (`field`), the
   keep-out spheres, and each other. A full floor stacks them up the band's height, then spills them across the den's bounds. */
export function buildToysOn(phys, seed, count = 12, { field, band, den, keepOut = [], floor = () => 0, floaters = WATER_KNOBS.floaters } = {}) {
  const rng = createRng(deriveSeed(seed, 77));
  const materials = toyMaterials(seed, count, floaters);
  const placed = [], toys = [], n = [0, 0, 0];
  const fits = (x, y, z, r) => field.distance(x, y, z, n) > r + 0.005
    && keepOut.every(([kx, ky, kz, kr]) => Math.hypot(x - kx, y - ky, z - kz) > kr + r + 0.01)
    && placed.every(([px, py, pz, pr]) => Math.hypot(x - px, y - py, z - pz) > pr + r + 0.005);
  for (let i = 0; i < count; i++) {
    const kind = KINDS[i % 4], size = drawSize(rng, kind), r = boundR(kind, size);
    let p = null;
    for (let stage = 0; stage < 3 && !p; stage++) {
      const area = stage < 2 ? band : { x: den.x, z: den.z, top: den.y[1] };
      for (let t = 0; t < 60 && !p; t++) {
        const x = rng.range(area.x[0] + r, area.x[1] - r), z = rng.range(area.z[0] + r, area.z[1] - r), base = floor(x, z) + r + 0.002;
        const y = stage === 1 ? rng.range(base, Math.max(base, area.top - r)) : base;
        if (fits(x, y, z, r)) p = [x, y, z];
      }
    }
    // Nowhere clear: over the den's middle, high, where Jolt can sort the overlap out as it falls.
    p ??= [(den.x[0] + den.x[1]) / 2, den.y[1] - r, (den.z[0] + den.z[1]) / 2];
    placed.push([...p, r]);
    toys.push(makeToy(phys, kind, size, p, axisAngle(rng.next(), rng.next(), rng.next(), rng.range(0, 6.28)), materials[i]));
  }
  return toys;
}
