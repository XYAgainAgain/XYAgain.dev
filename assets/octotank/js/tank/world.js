import { buildTank, buildPanel, buildRocks, apertures, LAYOUT_KNOBS } from './layout.js';
import { loadRockwork } from './rockwork-core.js';
import { TankSand } from './sand.js';
import { buildToys, buildToysOn } from '../enrichment/toys.js';
import { Water } from '../water/buoyancy.js';
import { WATER_KNOBS } from '../water/buoyancy-core.js';
import { buildShell, SHAPE_KNOBS } from '../amira/body/mantle-core.js';

/* Her tank's world for the page and the headless harness alike: the glass, the furniture, the sand, her spawn, the toys,
   and the water. 'divider' is the slotted test wall and two boulders; 'rockwork' is the baked layout. */

export const WORLDS = ['rockwork', 'divider'];

export function worldName(params, fallback = 'rockwork') {
  const w = params.get('world');
  return WORLDS.includes(w) ? w : fallback;
}

export const ROCK_COLLIDERS = ['single', 'chunks'];
export const ROCK_CHUNKS = { size: 0.25, height: 0.25, pad: 3, bevel: 0.003 };

/* ?rock=: the rock as one mesh body, or as closed pieces near her. */
export function rockCollider(params, fallback = 'chunks') {
  const r = params.get('rock');
  return ROCK_COLLIDERS.includes(r) ? r : fallback;
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.pathname ?? url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/* The baked rockwork and its registry; `assets` ({ rockwork: bytes, layout: object }) skips the fetch. */
export async function loadLayout(assets = null) {
  const bin = assets?.rockwork ?? await fetchBytes(new URL('../../layout/rockwork.bin', import.meta.url));
  const layout = assets?.layout ?? JSON.parse(new TextDecoder().decode(await fetchBytes(new URL('../../layout/tank-layout.json', import.meta.url))));
  return { field: await loadRockwork(bin), layout };
}

function shellExtent(level, mantleKnobs) {
  const shape = {};
  for (const key in SHAPE_KNOBS) shape[key] = mantleKnobs[key] ?? SHAPE_KNOBS[key];
  const P = buildShell(level, shape).positions;
  let lowY = 0, reach = 0;
  for (let i = 0; i < P.length; i += 3) { lowY = Math.min(lowY, P[i + 1]); reach = Math.max(reach, Math.hypot(P[i], P[i + 1], P[i + 2])); }
  return { P, lowY, reach };
}

/* The den hollow's most open point, dropped onto the sand with a centimeter under her; nearby points if the shell touches. */
function denSpawn(field, den, sand, ext) {
  const n = [0, 0, 0], floor = (x, z) => sand ? sand.field.sample(x, z) : 0;
  const clearance = (x, z) => {
    const y = floor(x, z) - ext.lowY + 0.01;
    let worst = Infinity;
    for (let i = 0; i < ext.P.length; i += 3) worst = Math.min(worst, field.distance(x + ext.P[i], y + ext.P[i + 1], z + ext.P[i + 2], n));
    return { p: [x, y, z], worst };
  };
  let best = clearance(den.center[0], den.center[2]);
  const b = den.bounds;
  for (let r = 0.02; best.worst < 0.01 && r <= 0.2; r += 0.02) {
    for (let a = 0; a < 12; a++) {
      const x = den.center[0] + r * Math.cos(a * Math.PI / 6), z = den.center[2] + r * Math.sin(a * Math.PI / 6);
      if (x < b.x[0] || x > b.x[1] || z < b.z[0] || z > b.z[1]) continue;
      const c = clearance(x, z);
      if (c.worst > best.worst) best = c;
    }
  }
  return best.p;
}

/* Everything up to her body, in the page's build order. `level` and `mantleKnobs` are her shell's, for
   the spawn; `assets` as loadLayout's. */
export async function buildWorld(phys, { name = 'rockwork', params = new URLSearchParams(), seed = 1, level = 10, mantleKnobs = {}, assets = null } = {}) {
  const walls = buildTank(phys);
  const floaters = +(params.get('floaters') ?? WATER_KNOBS.floaters) || 0;
  const count = Math.max(0, Math.min(80, +(params.get('toys') ?? 12) || 0));
  const newSand = () => (params.get('sand') === '0' ? null : new TankSand(phys, { seed: Number.isFinite(Number(params.get('sandseed'))) && params.has('sandseed') ? Number(params.get('sandseed')) : 420 }));
  const world = { name, walls, panel: [], rocks: [], layoutKnobs: null, apertures: [], wander: { rocks: [], panelX: null, panelT: null }, layout: null, rockwork: null };
  let waterKnobs = { floaters };
  if (name === 'divider') {
    const layoutKnobs = world.layoutKnobs = { ...LAYOUT_KNOBS };
    if (params.has('gap')) layoutKnobs.gapH = +params.get('gap') || layoutKnobs.gapH;
    if (params.get('bullnose') === '0') layoutKnobs.bullnose = false;
    world.panel = buildPanel(phys, layoutKnobs);
    world.rocks = buildRocks(phys);
    world.sand = newSand();
    world.start = [layoutKnobs.panelX - 0.42, layoutKnobs.gapY + 0.08, 0];
    const keepOut = [[-0.55, 0.05, -0.12, 0.09], [0.5, 0.05, 0.1, 0.1], [world.start[0], world.start[1], world.start[2], 0.1]];
    world.toys = buildToys(phys, seed, count, { keepOut, panelX: layoutKnobs.panelX, panelT: layoutKnobs.panelT, floaters });
    world.apertures = apertures(layoutKnobs);
    world.wander = { rocks: world.rocks, panelX: layoutKnobs.panelX, panelT: layoutKnobs.panelT };
  } else {
    const { field, layout } = await loadLayout(assets);
    const entry = rockCollider(params) === 'chunks' ? phys.addMeshes(field.chunks(ROCK_CHUNKS), { friction: 0.7, field }) : phys.addMesh(field.mesh(), { friction: 0.7 });
    entry.tag = 'rock'; entry.taste = 'rock';
    world.rockwork = phys.rockwork = { entry, field };
    world.layout = layout;
    world.sand = newSand();
    const den = layout.pieces.find((p) => p.name === 'Den hollow');
    if (!den) throw new Error('tank-layout.json: no "Den hollow" piece');
    const ext = shellExtent(level, mantleKnobs);
    world.start = denSpawn(field, den, world.sand, ext);
    const b = den.bounds, band = { x: [b.x[0], b.x[0] + (b.x[1] - b.x[0]) / 3], z: b.z, top: b.y[1] };
    const keepOut = [[...world.start, ext.reach]];
    world.toys = buildToysOn(phys, seed, count, { field, band, den: b, keepOut, floor: (x, z) => (world.sand ? world.sand.field.sample(x, z) : 0), floaters });
    waterKnobs = { floaters, surfaceY: layout.tank?.water ?? WATER_KNOBS.surfaceY };
  }
  // ?water=0 keeps the toys' real masses but leaves them in air: no buoyancy, no drag.
  world.water = phys.water = new Water(phys, world.toys, { enabled: params.get('water') !== '0', knobs: waterKnobs });
  return world;
}
