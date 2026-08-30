import * as THREE from 'three/webgpu';
import { Fn, vec2, vec3, vec4, float, positionWorld, normalWorld, texture, mix, normalize, uniform, sign, atan, cross, mat3, mat4, PI } from 'three/tsl';
import { DEPTH } from './config.js';
import { fbm2, valueNoise2 } from './shading.js';
import { createRng, deriveSeed } from './rng.js';

/* Floor, rocks, and the hollow log. Textures come from assets/pond/textures/manifest.json when present;
   each missing map falls back to a procedural placeholder so nothing blocks on art. */

const MANIFEST_URL = 'assets/pond/textures/manifest.json';

async function loadManifest() {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function loadTex(loader, url, srgb) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    loader.load(url, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      resolve(t);
    }, undefined, () => resolve(null));
  });
}

/* Loads one material's maps from the manifest; any missing map comes back null. */
async function loadSet(loader, manifest, name) {
  const entry = manifest?.[name] || {};
  const base = 'assets/pond/textures/';
  const [albedo, normal, roughness, arm, height, opacity] = await Promise.all([
    loadTex(loader, entry.albedo && base + entry.albedo, true),
    loadTex(loader, entry.normal && base + entry.normal, false),
    loadTex(loader, entry.roughness && base + entry.roughness, false),
    loadTex(loader, entry.arm && base + entry.arm, false),
    loadTex(loader, !entry.normal && entry.height && base + entry.height, false),   // height only feeds normals when no normal map
    loadTex(loader, entry.opacity && base + entry.opacity, false),
  ]);
  return { albedo, normal, roughness, arm, height, opacity, tiling: entry.tiling ?? 1, bump: entry.bump ?? 1 };
}

/* Builds a NodeMaterial that writes (lit color, depthFrac) for the underwater RT.
   Planar (floor) or triplanar (rocks, log) mapping; normals come from the height map when present. */
function makeSurfaceMaterial(shading, set, placeholder, tilingWorld, triplanar = false, cylinder = null) {
  const uTiling = uniform(tilingWorld);
  // cylinder: { inv: Matrix4 world→log-local, rot: Matrix3 local→world rotation } for bark mapping.
  const uInv = cylinder ? uniform(cylinder.inv) : null;
  const uRot = cylinder ? uniform(cylinder.rot) : null;
  const uBump = uniform(set.bump);
  const texel = float(1 / 2048);
  const mat = new THREE.NodeMaterial();

  // Height-map slope on one projection plane: (dh/du, dh/dv) over two texels.
  const slopeAt = (tuv) => {
    const h = (o) => texture(set.height, tuv.add(o)).r;
    return vec2(h(vec2(texel, 0)).sub(h(vec2(texel.negate(), 0))), h(vec2(0, texel)).sub(h(vec2(0, texel.negate()))));
  };

  mat.fragmentNode = Fn(() => {
    const p = positionWorld;
    const geomN = normalize(normalWorld);
    let albedo, rough, n;

    if (cylinder) {
      // Bark: u wraps around the trunk, v runs along its length (local y), so the grain follows the log.
      const lp = uInv.mul(vec4(p, 1)).xyz;
      const ang = atan(lp.z, lp.x);
      const tuv = vec2(ang.div(PI.mul(2)).mul(uTiling.mul(2.2)), lp.y.mul(uTiling));
      albedo = set.albedo ? texture(set.albedo, tuv).rgb : placeholder.albedo(p);
      rough = set.arm ? texture(set.arm, tuv).g : set.roughness ? texture(set.roughness, tuv).r : placeholder.roughness();
      if (set.normal) {
        const tn = texture(set.normal, tuv).rgb.mul(2).sub(1);
        const localN = uInv.mul(vec4(geomN, 0)).xyz;
        const tangent = normalize(vec3(lp.z.negate(), 0, lp.x));   // around the trunk
        const bitangent = vec3(0, 1, 0);                            // along it
        const ln = normalize(tangent.mul(tn.x.mul(uBump)).add(bitangent.mul(tn.y.mul(uBump))).add(localN.mul(tn.z)));
        n = normalize(uRot.mul(ln));
      } else {
        n = placeholder.normal(p, geomN);
      }
    } else if (!triplanar) {
      const tuv = p.xz.mul(uTiling);
      albedo = set.albedo ? texture(set.albedo, tuv).rgb : placeholder.albedo(p);
      rough = set.arm ? texture(set.arm, tuv).g : set.roughness ? texture(set.roughness, tuv).r : placeholder.roughness();
      if (set.normal) {
        // GL-convention map on a +y plane: u runs along +x, v along +z.
        const tn = texture(set.normal, tuv).rgb.mul(2).sub(1);
        n = normalize(vec3(tn.x.mul(uBump), tn.z, tn.y.mul(uBump)));
      } else if (set.height) {
        const sl = slopeAt(tuv);
        n = normalize(geomN.add(vec3(sl.x.negate(), 0, sl.y.negate()).mul(uBump.mul(6))));
      } else {
        n = placeholder.normal(p, geomN);
      }
    } else {
      const w = geomN.abs().pow(4).toVar();
      w.divAssign(w.x.add(w.y).add(w.z));
      const uvX = p.zy.mul(uTiling), uvY = p.xz.mul(uTiling), uvZ = p.xy.mul(uTiling);
      const tri = (tex) => texture(tex, uvX).mul(w.x).add(texture(tex, uvY).mul(w.y)).add(texture(tex, uvZ).mul(w.z));
      albedo = set.albedo ? tri(set.albedo).rgb : placeholder.albedo(p);
      rough = set.arm ? tri(set.arm).g : set.roughness ? tri(set.roughness).r : placeholder.roughness();
      if (set.normal) {
        // Per-plane tangent frames (u, v) = X: (+z, +y), Y: (+x, +z), Z: (+x, +y), flipped on back-facing sides.
        const tx = texture(set.normal, uvX).rgb.mul(2).sub(1);
        const ty = texture(set.normal, uvY).rgb.mul(2).sub(1);
        const tz = texture(set.normal, uvZ).rgb.mul(2).sub(1);
        const bend = vec3(0, tx.y, tx.x.mul(sign(geomN.x))).mul(w.x)
          .add(vec3(ty.x.mul(sign(geomN.y)), 0, ty.y).mul(w.y))
          .add(vec3(tz.x.mul(sign(geomN.z)), tz.y, 0).mul(w.z));
        n = normalize(geomN.add(bend.mul(uBump)));
      } else if (set.height) {
        const sx = slopeAt(uvX), sy = slopeAt(uvY), sz = slopeAt(uvZ);
        const bend = vec3(0, sx.y.negate(), sx.x.negate()).mul(w.x)
          .add(vec3(sy.x.negate(), 0, sy.y.negate()).mul(w.y))
          .add(vec3(sz.x.negate(), sz.y.negate(), 0).mul(w.z));
        n = normalize(geomN.add(bend.mul(uBump.mul(6))));
      } else {
        n = placeholder.normal(p, geomN);
      }
    }

    const dbg = new URLSearchParams(location.search).get('shade');
    if (dbg === 'gn') return vec4(geomN.mul(0.5).add(0.5), 1);
    const lit = shading.shade(albedo, n, p, rough);
    const depthFrac = p.y.negate().div(DEPTH).clamp(0, 1);
    return vec4(lit, depthFrac);
  })();
  mat.side = THREE.FrontSide;
  return mat;
}

/* Welds the non-indexed PolyhedronGeometry vertices so computeVertexNormals can smooth across faces. */
function weldGeometry(geo, precision = 1e-4) {
  const pos = geo.attributes.position;
  const map = new Map();
  const unique = [];
  const index = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.round(x / precision)}_${Math.round(y / precision)}_${Math.round(z / precision)}`;
    let id = map.get(key);
    if (id === undefined) { id = unique.length / 3; map.set(key, id); unique.push(x, y, z); }
    index.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(unique, 3));
  out.setIndex(index);
  return out;
}

/* A cylinder's seam column is a duplicate vertex pair per row, so each half only sees its own faces.
   Averaging the two after computeVertexNormals hides the lighting crack that leaves down the side. */
function weldSeamNormals(geo, radial, hseg) {
  const n = geo.attributes.normal;
  for (let row = 0; row <= hseg; row++) {
    const i0 = row * (radial + 1), i1 = i0 + radial;
    const x = n.getX(i0) + n.getX(i1), y = n.getY(i0) + n.getY(i1), z = n.getZ(i0) + n.getZ(i1);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(i0, x / l, y / l, z / l);
    n.setXYZ(i1, x / l, y / l, z / l);
  }
}

/* Shortest distance from a point to a segment, used to keep the log off the rocks it cannot lie over. */
/* Closest approach of two segments in the plane: zero when they cross, else an endpoint is nearest. */
function segSegDist(ax, az, bx, bz, cx, cz, dx, dz) {
  const cross = (ox, oz, px, pz, qx, qz) => (px - ox) * (qz - oz) - (pz - oz) * (qx - ox);
  const d1 = cross(cx, cz, dx, dz, ax, az), d2 = cross(cx, cz, dx, dz, bx, bz);
  const d3 = cross(ax, az, bx, bz, cx, cz), d4 = cross(ax, az, bx, bz, dx, dz);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(
    segPointDist(ax, 0, az, cx, 0, cz, dx, 0, dz), segPointDist(bx, 0, bz, cx, 0, cz, dx, 0, dz),
    segPointDist(cx, 0, cz, ax, 0, az, bx, 0, bz), segPointDist(dx, 0, dz, ax, 0, az, bx, 0, bz),
  );
}

function segPointDist(px, py, pz, ax, ay, az, bx, by, bz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const len2 = ux * ux + uy * uy + uz * uz;
  let t = len2 > 1e-9 ? ((px - ax) * ux + (py - ay) * uy + (pz - az) * uz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + ux * t), py - (ay + uy * t), pz - (az + uz * t));
}

/* Cheap smooth 3D noise: a few hashed sines, enough for lumpy rocks without a library. */
function lumpNoise(x, y, z, f, ph) {
  return Math.sin(x * f[0] + ph[0]) * Math.sin(y * f[1] + ph[1]) * 0.5
    + Math.sin(z * f[2] + ph[2]) * Math.cos(x * f[1] + ph[0]) * 0.35
    + Math.sin((x + y) * f[2] * 1.7 + ph[1]) * Math.sin((z - y) * f[0] * 1.3 + ph[2]) * 0.2;
}

const placeholders = {
  sand: {
    albedo: Fn(([p]) => {
      const g = fbm2(p.xz.mul(1.7)).mul(0.5).add(valueNoise2(p.xz.mul(22)).mul(0.35));
      return mix(vec3(0.07, 0.065, 0.075), vec3(0.24, 0.22, 0.22), g);
    }),
    roughness: () => uniform(0.85),
    normal: Fn(([p, gn]) => {
      const e = float(0.05);
      const h = Fn(([q]) => valueNoise2(q.mul(9)).mul(0.04));
      const dx = h(p.xz.add(vec2(e, 0))).sub(h(p.xz.sub(vec2(e, 0))));
      const dz = h(p.xz.add(vec2(0, e))).sub(h(p.xz.sub(vec2(0, e))));
      return normalize(gn.add(vec3(dx.negate(), 0, dz.negate()).mul(3)));
    }),
  },
  stone: {
    albedo: Fn(([p]) => {
      const g = fbm2(p.xz.add(p.y).mul(3.5));
      return mix(vec3(0.14, 0.14, 0.15), vec3(0.32, 0.30, 0.28), g);
    }),
    roughness: () => uniform(0.6),
    normal: Fn(([p, gn]) => gn),
  },
  wood: {
    albedo: Fn(([p]) => {
      const rings = valueNoise2(vec2(p.x.mul(1.2), p.y.add(p.z).mul(14))).mul(0.6);
      return mix(vec3(0.16, 0.11, 0.07), vec3(0.34, 0.24, 0.14), rings);
    }),
    roughness: () => uniform(0.7),
    normal: Fn(([p, gn]) => gn),
  },
};

export async function buildFloor(scene, shading, extent, seed, view, habitat = null) {
  const rng = createRng(deriveSeed(seed, 77));
  const loader = new THREE.TextureLoader();
  const manifest = await loadManifest();
  // Every manifest set loads here, once; the flora takes leaf and duckweed from the returned library.
  const names = ['sand', 'stone', 'algae', 'wood', 'leaf', 'duckweed'];
  const sets = await Promise.all(names.map((n) => loadSet(loader, manifest, n)));
  const textures = Object.fromEntries(names.map((n, i) => [n, sets[i]]));
  const { sand, stone, algae, wood } = textures;

  const group = new THREE.Group();
  const colliders = { spheres: [], logs: [], waterline: { discs: [], capsules: [] } };

  // Gentle dunes and pebble-scale bumps so the gravel catches the moon at varying angles.
  const floorGeo = new THREE.PlaneGeometry(extent, extent, 160, 160);
  floorGeo.rotateX(-Math.PI / 2);
  const fpos = floorGeo.attributes.position;
  const ff = [rng.range(0.25, 0.5), rng.range(0.25, 0.5), rng.range(0.25, 0.5)];
  const fph = [rng.range(0, 6), rng.range(0, 6), rng.range(0, 6)];
  for (let v = 0; v < fpos.count; v++) {
    const x = fpos.getX(v), z = fpos.getZ(v);
    const y = 0.06 * lumpNoise(x, 0, z, ff, fph) + 0.025 * lumpNoise(x * 3.3, 1, z * 3.3, ff, fph);
    fpos.setY(v, y);
  }
  floorGeo.computeVertexNormals();
  const floor = new THREE.Mesh(floorGeo, makeSurfaceMaterial(shading, sand, placeholders.sand, 0.16 * sand.tiling));
  floor.position.y = -DEPTH;
  floor.frustumCulled = false;
  group.add(floor);

  // Rocks: displaced icosahedra (no pole pinch), triplanar-mapped, alternating stone and algae sets.
  const rockMats = [
    makeSurfaceMaterial(shading, stone, placeholders.stone, 0.5 * stone.tiling, true),
    makeSurfaceMaterial(shading, algae, placeholders.stone, 0.5 * algae.tiling, true),
  ];
  const rockCount = 14;
  for (let i = 0; i < rockCount; i++) {
    const big = i < 5;                         // several break the surface
    const r = big ? rng.range(0.8, 1.15) : rng.range(0.22, 0.6);
    const geo = weldGeometry(new THREE.IcosahedronGeometry(1, 5));
    const pos = geo.attributes.position;
    const lump = createRng(deriveSeed(seed, 900 + i));
    const f = [lump.range(1.2, 2.6), lump.range(1.2, 2.6), lump.range(1.2, 2.6)];
    const ph = [lump.range(0, 6), lump.range(0, 6), lump.range(0, 6)];
    const sq = [lump.range(0.8, 1.25), lump.range(0.55, 0.85), lump.range(0.8, 1.25)];
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const k = 1 + 0.16 * lumpNoise(x, y, z, f, ph) + 0.05 * lumpNoise(x * 3.1, y * 3.1, z * 3.1, f, ph);
      pos.setXYZ(v, x * k * sq[0], y * k * sq[1], z * k * sq[2]);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, rockMats[i % 2]);
    // Scatter across the visible view plus a little beyond it, not the whole 3× pool. A few tries
    // to keep rocks off each other; if none succeed the overlap stays, which reads as a pile.
    let ang = 0, dist = 0;
    for (let tries = 0; tries < 12; tries++) {
      ang = rng.range(0, Math.PI * 2);
      dist = rng.range(view.h * 0.18, Math.max(view.w, view.h) * 0.6);
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      if (colliders.spheres.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r + 0.25)) break;
    }
    const sink = big ? 0.15 : 0.3;
    m.position.set(Math.cos(ang) * dist, -DEPTH + r * sq[1] * sink, Math.sin(ang) * dist);
    m.scale.setScalar(r);
    m.rotation.y = rng.range(0, Math.PI * 2);
    group.add(m);
    const rc = r * Math.min(sq[0], sq[2]) * 0.95;
    const ry = r * sq[1];
    const top = m.position.y + ry;
    colliders.spheres.push({ x: m.position.x, y: m.position.y, z: m.position.z, r: rc, top });
    // Chord of the rock at y = 0 is what the water sim treats as a wall; a dry top is a perch.
    if (top > 0) {
      const frac = Math.sqrt(Math.max(0, 1 - (m.position.y / ry) ** 2));
      colliders.waterline.discs.push({ x: m.position.x, z: m.position.z, r: rc * frac });
      habitat?.addPerch({ x: m.position.x, y: top, z: m.position.z, type: 'rock', radius: rc * 0.5 });
    }
  }

  // Two logs at most; the second rolls in about half the seeds. Stub waterline capsules are deferred so
  // both trunks claim their MAXC slots first.
  const buildLog = (li, prev) => {
    const stubCaps = [];
    // Hollow log: an open cylinder rendered from both sides, lying on the sand near the view.
    // Seeded size variance: mostly ordinary, sometimes snug, rarely grand (a future Eleanor-sized bore).
    const sizeRng = createRng(deriveSeed(seed, 4243 + li * 20));
    const grand = sizeRng.chance(0.15);
    let sizeMul = grand ? sizeRng.range(1.25, 1.5) : sizeRng.chance(0.3) ? sizeRng.range(0.72, 0.9) : sizeRng.range(0.9, 1.15);
    // A second log has to read as a different tree: girth and length both land well away from the first.
    if (prev && Math.abs(sizeMul - prev.sizeMul) < 0.2) sizeMul = prev.sizeMul > 1.05 ? Math.min(sizeMul, prev.sizeMul - 0.25) : prev.sizeMul + 0.25;
    // The bore rolls independently of girth so a tight bore makes the eels' fit check a real sorting rule.
    const boreT = grand ? sizeRng.range(0.7, 0.8) : sizeRng.chance(0.25) ? sizeRng.range(0.24, 0.4) : sizeRng.range(0.6, 0.78);
    const logR = 0.52 * sizeMul;
    // Snapped logs come in lengths; this spread is wide enough that two seeds rarely read as the same log.
    let logLen = 4.6 * sizeRng.range(0.68, 1.45);
    if (prev && Math.abs(logLen / prev.logLen - 1) < 0.2) logLen *= prev.logLen > 4.6 ? 0.75 : 1.3;
    const halfLen = logLen / 2;
    const logY = -DEPTH + logR * 0.9;

    const logNoise = createRng(deriveSeed(seed, 4242 + li * 20));
    const lf = [logNoise.range(2, 4), logNoise.range(2, 4), logNoise.range(2, 4)];
    const lph = [logNoise.range(0, 6), logNoise.range(0, 6), logNoise.range(0, 6)];
    const swellA = [logNoise.range(0.04, 0.09), logNoise.range(0.02, 0.045)];
    const swellW = [logNoise.range(1.5, 3.1), logNoise.range(3.3, 6.2)];
    const swellP = [logNoise.range(0, 6.28), logNoise.range(0, 6.28)];
    const taperK = logNoise.range(0.015, 0.055) * (logNoise.chance(0.5) ? 1 : -1);
    const knots = [];
    for (let i = 0, n = logNoise.int(2, 4); i < n; i++) {
      knots.push({
        y: logNoise.range(-0.8, 0.8) * halfLen, a: logNoise.range(0, 6.28),
        amp: logNoise.range(0.09, 0.26), w: logNoise.range(2.5, 8), s: logNoise.range(1.5, 4),
      });
    }

    // One radial profile for bark, bore, and lips, so the three shells can never disagree about the wall.
    // Knots only ever add, so the bore's worst case comes from the swell, the taper, and the bark noise.
    const KFLOOR = 0.88;
    const radialK = (ang, y) => {
      const t = y / halfLen;
      let k = 1 + swellA[0] * Math.sin(t * swellW[0] + swellP[0]) + swellA[1] * Math.sin(t * swellW[1] + swellP[1]) - taperK * t;
      for (const kn of knots) k += kn.amp * Math.exp(-((y - kn.y) ** 2) * kn.w) * Math.max(0, Math.cos(ang - kn.a)) ** kn.s;
      k += 0.030 * lumpNoise(Math.cos(ang) * 2, y * 0.9, Math.sin(ang) * 2, lf, lph)
        + 0.015 * lumpNoise(Math.cos(ang) * 6.3, y * 3.1, Math.sin(ang) * 6.3, lf, lph);
      // Exponential floor rather than a clamp: a hard max() leaves a flat band around the deepest pinch.
      return k > KFLOOR + 0.12 ? k : KFLOOR + 0.12 * Math.exp((k - KFLOOR - 0.12) / 0.12);
    };
    let kMin = Infinity, kMax = 0;
    for (let a = 0; a < 48; a++) for (let b = 0; b <= 48; b++) {
      const k = radialK((a / 48) * 6.283, (b / 24 - 1) * halfLen);
      kMin = Math.min(kMin, k); kMax = Math.max(kMax, k);
    }

    // Eels tunnel along a straight collider axis, so the modeled bore swallows the pinch and the bend and
    // still leaves rInner of clear air. The leftover is the bend budget: thick wall banana, thin shell straight.
    const boreBase = Math.min(logR * 0.90, Math.max(logR * Math.min(boreT + 0.18, 0.87), (logR * boreT + 0.01) / kMin));
    const bendMag = Math.min(logR * logNoise.range(0.12, 0.32), Math.max(0, boreBase * kMin - logR * boreT - 0.01));
    const bendDir = (logNoise.chance(0.5) ? 1 : -1) * (Math.PI / 2) + logNoise.range(-0.35, 0.35);
    const bendX = (y) => Math.cos(bendDir) * bendMag * (1 - (y / halfLen) ** 2);
    const bendZ = (y) => Math.sin(bendDir) * bendMag * (1 - (y / halfLen) ** 2);

    // Snapped ends: each end tears along its own seeded rim, so neither mouth is a saw cut and the
    // two ends break at different places. Splinters ride out along the axis; the bore stays open.
    const tearRng = createRng(deriveSeed(seed, 4244 + li * 20));
    const TEAR_W = 0.25;
    const tearMax = 0.55 * TEAR_W * halfLen;   // past this the last rings fold back through each other
    const ends = [1, -1].map(() => {
      const spikes = [];
      for (let i = 0, n = tearRng.int(1, 3); i < n; i++) {
        spikes.push({ a: tearRng.range(0, 6.28), w: tearRng.range(4, 12), h: tearRng.range(0.10, 0.40) * logR });
      }
      return {
        base: tearRng.range(-0.10, 0.05) * logR, rag: tearRng.range(0.04, 0.10) * logR,
        ph: [tearRng.range(0, 6), tearRng.range(0, 6), tearRng.range(0, 6)], spikes,
      };
    });
    const endOff = (end, ang) => {
      const e = ends[end > 0 ? 0 : 1];
      let o = e.base + e.rag * lumpNoise(Math.cos(ang) * 2.4, 0, Math.sin(ang) * 2.4, lf, e.ph);
      for (const s of e.spikes) o += s.h * Math.max(0, Math.cos(ang - s.a)) ** s.w;
      return end * Math.max(-tearMax, Math.min(tearMax, o));
    };
    const tearWin = (y) => {
      const u = Math.abs(y) / halfLen;
      if (u <= 1 - TEAR_W) return 0;
      const s = (u - (1 - TEAR_W)) / TEAR_W;
      return s * s * (3 - 2 * s);
    };

    // Placement: rocks are already down, so the log picks a heading and a spot that keeps its capsule
    // clear of anything bigger than itself. Lying across a smaller stone is fine; it reads as resting on it.
    const placeRng = createRng(deriveSeed(seed, 4245 + li * 20));
    // The collider is a straight capsule, so its outer wall must reach the bark crest plus the bend.
    const logOuter = logR * kMax + bendMag;
    let place = null;
    for (let tries = 0; tries < 48; tries++) {
      const head = placeRng.range(0, Math.PI * 2);
      const azim = placeRng.range(0, Math.PI * 2);
      const rad = placeRng.range(0.16, prev ? 0.36 : 0.30);
      const cx = Math.cos(azim) * view.w * rad, cz = Math.sin(azim) * view.h * rad;
      const dx = Math.cos(head) * halfLen, dz = -Math.sin(head) * halfLen;
      let pen = 0;
      for (const s of colliders.spheres) {
        if (s.r <= logOuter) continue;
        pen += Math.max(0, s.r + logOuter + 0.15 - segPointDist(s.x, s.y, s.z, cx - dx, logY, cz - dz, cx + dx, logY, cz + dz));
      }
      if (prev) {
        pen += Math.max(0, prev.rOuter + logOuter + 0.35 - segSegDist(prev.ax, prev.az, prev.bx, prev.bz, cx - dx, cz - dz, cx + dx, cz + dz));
        // Near-parallel logs read as one broken trunk, so the second one crosses the first's heading.
        const dh = ((head - prev.head) % Math.PI + Math.PI) % Math.PI;
        if (Math.min(dh, Math.PI - dh) < 0.5) pen += 0.5;
      }
      // Rock clearance outweighs framing ten to one; framing only settles ties between clean spots.
      const score = pen * 10 + Math.max(0, Math.abs(cx) + Math.abs(dx) - view.w * 0.42)
        + Math.max(0, Math.abs(cz) + Math.abs(dz) - view.h * 0.42);
      if (!place || score < place.score) place = { head, cx, cz, score };
      if (score === 0) break;
    }
    const logAng = place.head, lx = place.cx, lz = place.cz;

    const log = new THREE.Group();
    log.rotation.z = Math.PI / 2;
    log.rotation.y = logAng;
    log.position.set(lx, logY, lz);
    log.updateMatrixWorld(true);
    const logInv = new THREE.Matrix4().copy(log.matrixWorld).invert();
    const logRot = new THREE.Matrix3().setFromMatrix4(log.matrixWorld);
    const woodMat = makeSurfaceMaterial(shading, wood, placeholders.wood, 0.55 * wood.tiling, false, { inv: logInv, rot: logRot });
    const woodInner = makeSurfaceMaterial(shading, wood, placeholders.wood, 0.55 * wood.tiling, false, { inv: logInv, rot: logRot });
    woodInner.side = THREE.BackSide;

    const RADIAL = 64, HSEG = 96;
    const shapeShell = (geo, baseR) => {
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
        const ang = Math.atan2(z, x);
        const r = baseR * radialK(ang, y);
        pos.setXYZ(v, Math.cos(ang) * r + bendX(y), y + endOff(y >= 0 ? 1 : -1, ang) * tearWin(y), Math.sin(ang) * r + bendZ(y));
      }
      geo.computeVertexNormals();
      weldSeamNormals(geo, RADIAL, HSEG);
      return geo;
    };
    const outer = shapeShell(new THREE.CylinderGeometry(1, 1, logLen, RADIAL, HSEG, true), logR);
    const inner = shapeShell(new THREE.CylinderGeometry(1, 1, logLen, RADIAL, HSEG, true), boreBase);
    log.add(new THREE.Mesh(outer, woodMat));
    log.add(new THREE.Mesh(inner, woodInner));

    // End lips: an annulus, never a disc, so both mouths stay enterable. Its rim rides the same tear
    // as the two shells, which is what welds the torn edge together instead of leaving a clean rim.
    for (const end of [1, -1]) {
      const verts = [], idx = [], ye = end * halfLen, bx = bendX(ye), bz = bendZ(ye);
      for (let i = 0; i < RADIAL; i++) {
        const ang = (i / RADIAL) * Math.PI * 2, k = radialK(ang, ye), y = ye + endOff(end, ang);
        const ri = boreBase * k * 0.985, ro = logR * k * 1.005;
        verts.push(Math.cos(ang) * ri + bx, y, Math.sin(ang) * ri + bz);
        verts.push(Math.cos(ang) * ro + bx, y, Math.sin(ang) * ro + bz);
      }
      for (let i = 0; i < RADIAL; i++) {
        const j = (i + 1) % RADIAL, ai = i * 2, ao = ai + 1, bi = j * 2, bo = bi + 1;
        if (end > 0) idx.push(ai, bo, ao, ai, bi, bo);
        else idx.push(ai, ao, bo, ai, bo, bi);
      }
      const lip = new THREE.BufferGeometry();
      lip.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      // shade() carries texture nodes whose default uv resolves at build; WebGL2 warns when it is missing.
      lip.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(verts.length / 3 * 2), 2));
      lip.setIndex(idx);
      lip.computeVertexNormals();
      log.add(new THREE.Mesh(lip, woodMat));
    }
    group.add(log);

    const dir = new THREE.Vector3(Math.cos(logAng), 0, -Math.sin(logAng));
    colliders.logs.push({
      a: new THREE.Vector3(lx, logY, lz).addScaledVector(dir, -halfLen),
      b: new THREE.Vector3(lx, logY, lz).addScaledVector(dir, halfLen),
      rInner: logR * boreT, rOuter: logOuter,
    });
    if (logY + logOuter > 0) {
      // The bark crest, not the nominal radius, is what stands dry; the mask must keep duckweed off all of it.
      const chord = Math.sqrt(logOuter * logOuter - logY * logY);
      colliders.waterline.capsules.push({ ax: lx - dir.x * halfLen, az: lz - dir.z * halfLen, bx: lx + dir.x * halfLen, bz: lz + dir.z * halfLen, r: chord });
      // Three perches along the dry ridge, read off the shaped trunk so they sit on the bark, not above it.
      for (const s of [-0.35, 0, 0.35]) {
        const ys = s * logLen;
        const p = log.localToWorld(new THREE.Vector3(logR * radialK(0, ys) + bendX(ys), ys, bendZ(ys)));
        habitat?.addPerch({ x: p.x, y: p.y, z: p.z, type: 'log', radius: logR * 0.4 });
      }
    }

    // Branch stubs: children of the log group, same material, so bark and transform carry over. Each base
    // disc hides inside the wall (never through it into the bore) and each is a solid capsule to the eels.
    const stubRng = createRng(deriveSeed(seed, 4246 + li * 20));
    const AXIS_Y = new THREE.Vector3(0, 1, 0);
    for (let i = 0, want = stubRng.int(0, 5); i < want; i++) {
      const y0 = stubRng.range(-0.55, 0.55) * halfLen;
      const psi = (stubRng.chance(0.5) ? 1 : -1) * stubRng.range(0.35, 1.85);   // 0 is the ridge; never the underside
      const phi = stubRng.range(0.35, 1.22);                                    // 20 to 70 degrees off the trunk axis
      const lean = stubRng.chance(0.5) ? 1 : -1;
      const cs = Math.cos(psi), sn = Math.sin(psi), sp = Math.sin(phi), cp = Math.cos(phi);
      const kk = radialK(psi, y0);
      // Measured against whichever bore is wider, the modeled one or the collider's, so a stub can
      // never end up as wood inside the air the eels are promised.
      const rSurf = logR * kk, rBore = Math.max(boreBase * kk, logR * boreT + bendMag);
      const wall = rSurf - rBore;
      const R = Math.min(stubRng.range(0.10, 0.30) * logR, 0.45 * wall / Math.max(0.25, cp));
      if (R < 0.06 * logR) continue;
      const rb = rBore + wall * 0.5;
      // Length is whatever survives four limits: neither mouth, not out of the water, not into the sand,
      // and long enough that what clears the bark is a branch rather than a pimple.
      const sink = wall * 0.5 / sp;
      let len = Math.min(stubRng.range(0.5, 2.2) * logR, (0.78 * halfLen - lean * y0) / cp);
      const room = cs > 0 ? 0.10 - logY - R : -DEPTH + 0.06 + R - logY;
      if (Math.abs(cs) > 1e-3) len = Math.min(len, (room / cs - rb) / sp);
      if (len < sink + 0.28 * logR) continue;

      const SR = 14, SH = 10, tipR = R * stubRng.range(0.45, 0.8);
      const geo = new THREE.CylinderGeometry(tipR, R, len, SR, SH, false);
      const sBias = stubRng.range(-0.05, 0.02) * len, sRag = stubRng.range(0.02, 0.06) * len;
      const sPh = [stubRng.range(0, 6), stubRng.range(0, 6), stubRng.range(0, 6)];
      const sSpk = [];
      for (let k = 0, n = stubRng.int(1, 2); k < n; k++) sSpk.push({ a: stubRng.range(0, 6.28), w: stubRng.range(4, 10), h: stubRng.range(0.04, 0.10) * len });
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
        const u = (y + len / 2) / len;
        if (u <= 0.55) continue;
        const s = (u - 0.55) / 0.45;
        // Scaling by radius pins the cap center, so the snapped tip splinters around it instead of tilting.
        const win = s * s * (3 - 2 * s) * Math.min(1, Math.hypot(x, z) / Math.max(tipR, 1e-4));
        const ang = Math.atan2(z, x);
        let o = sBias + sRag * lumpNoise(Math.cos(ang) * 2.6, 0, Math.sin(ang) * 2.6, lf, sPh);
        for (const s2 of sSpk) o += s2.h * Math.max(0, Math.cos(ang - s2.a)) ** s2.w;
        pos.setY(v, y + Math.max(-0.18 * len, Math.min(0.18 * len, o)) * win);
      }
      geo.computeVertexNormals();
      weldSeamNormals(geo, SR, SH);

      const d3 = new THREE.Vector3(sp * cs, cp * lean, sp * sn);
      const base = new THREE.Vector3(cs * rb + bendX(y0), y0, sn * rb + bendZ(y0));
      const stub = new THREE.Mesh(geo, woodMat);
      stub.quaternion.setFromUnitVectors(AXIS_Y, d3);
      stub.position.copy(base).addScaledVector(d3, len / 2);
      log.add(stub);

      // Solid capsule: eel-physics walls the band between rInner and rOuter, so rInner 0 is a filled limb.
      // It starts where the stub leaves the bark, keeping the collider out of the trunk's own wall band.
      const a = log.localToWorld(base.clone().addScaledVector(d3, Math.min(len * 0.9, sink)));
      const b = log.localToWorld(base.clone().addScaledVector(d3, len));
      colliders.logs.push({ a, b, rInner: 0, rOuter: R });
      const yTop = Math.max(a.y, b.y);
      if (yTop + R > 0) {
        const chord = yTop >= R ? R : Math.sqrt(Math.max(0, R * R - yTop * yTop));
        if (chord > 0.03) stubCaps.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, r: chord });
      }
    }
    return { head: logAng, ax: lx - dir.x * halfLen, az: lz - dir.z * halfLen, bx: lx + dir.x * halfLen, bz: lz + dir.z * halfLen, rOuter: logOuter, sizeMul, logLen, stubCaps };
  };
  const firstLog = buildLog(0, null);
  const secondLog = createRng(deriveSeed(seed, 4260)).chance(0.5) ? buildLog(1, firstLog) : null;
  for (const c of [...firstLog.stubCaps, ...(secondLog ? secondLog.stubCaps : [])]) if (colliders.waterline.capsules.length < 4) colliders.waterline.capsules.push(c);

  scene.add(group);
  return { group, colliders, textures };
}
