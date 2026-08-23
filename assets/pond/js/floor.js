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
  const [albedo, normal, roughness, arm, height] = await Promise.all([
    loadTex(loader, entry.albedo && base + entry.albedo, true),
    loadTex(loader, entry.normal && base + entry.normal, false),
    loadTex(loader, entry.roughness && base + entry.roughness, false),
    loadTex(loader, entry.arm && base + entry.arm, false),
    loadTex(loader, !entry.normal && entry.height && base + entry.height, false),   // height only feeds normals when no normal map
  ]);
  return { albedo, normal, roughness, arm, height, tiling: entry.tiling ?? 1, bump: entry.bump ?? 1 };
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

export async function buildFloor(scene, shading, extent, seed, view) {
  const rng = createRng(deriveSeed(seed, 77));
  const loader = new THREE.TextureLoader();
  const manifest = await loadManifest();
  const [sand, stone, algae, wood] = await Promise.all([
    loadSet(loader, manifest, 'sand'), loadSet(loader, manifest, 'stone'), loadSet(loader, manifest, 'algae'), loadSet(loader, manifest, 'wood'),
  ]);

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
    colliders.spheres.push({ x: m.position.x, y: m.position.y, z: m.position.z, r: rc });
    // Chord of the rock at y = 0 is what the water sim treats as a wall.
    const ry = r * sq[1];
    if (m.position.y + ry > 0) {
      const frac = Math.sqrt(Math.max(0, 1 - (m.position.y / ry) ** 2));
      colliders.waterline.discs.push({ x: m.position.x, z: m.position.z, r: rc * frac });
    }
  }

  // Hollow log: an open cylinder rendered from both sides, lying on the sand near the view.
  // It is fat enough to break the surface; the bore stays roomy for eels.
  const logR = 0.52, logLen = 4.6;
  const outer = new THREE.CylinderGeometry(logR, logR * 0.92, logLen, 64, 48, true);
  const inner = new THREE.CylinderGeometry(logR * 0.8, logR * 0.76, logLen, 64, 48, true);
  const logNoise = createRng(deriveSeed(seed, 4242));
  const lf = [logNoise.range(2, 4), logNoise.range(2, 4), logNoise.range(2, 4)];
  const lph = [logNoise.range(0, 6), logNoise.range(0, 6), logNoise.range(0, 6)];
  const bendPh = logNoise.range(0, 6), knotY = logNoise.range(-1.2, 1.2), knotA = logNoise.range(0, 6);
  // Shape the trunk: radius swells and pinches along its length, a gentle bend, a knot bulge, fine bark lumps.
  const shapeLog = (x, y, z, rScale) => {
    const ang = Math.atan2(z, x);
    const along = y / (logLen / 2);
    const swell = 1 + 0.10 * Math.sin(along * 2.3 + lph[0]) + 0.06 * Math.sin(along * 4.1 + lph[1]);
    const knot = 0.22 * Math.exp(-((y - knotY) ** 2) * 3.5) * Math.max(0, Math.cos(ang - knotA)) ** 3;
    const fine = 0.05 * lumpNoise(Math.cos(ang) * 2, y * 0.8, Math.sin(ang) * 2, lf, lph);
    const k = (swell + knot + fine) * rScale;
    const bend = Math.sin(along * 1.4 + bendPh) * 0.09;
    return [x * k + bend, y, z * k];
  };
  for (const [g, rs] of [[outer, 1], [inner, 1]]) {
    const pos = g.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const [x, y, z] = shapeLog(pos.getX(v), pos.getY(v), pos.getZ(v), rs);
      pos.setXYZ(v, x, y, z);
    }
    g.computeVertexNormals();
  }
  const logAng = rng.range(0, Math.PI * 2);
  const log = new THREE.Group();
  log.rotation.z = Math.PI / 2;
  log.rotation.y = logAng;
  const lx = Math.cos(logAng + 1.3) * view.w * 0.22, lz = Math.sin(logAng + 1.3) * view.h * 0.22;
  log.position.set(lx, -DEPTH + logR * 0.9, lz);
  log.updateMatrixWorld(true);
  const logInv = new THREE.Matrix4().copy(log.matrixWorld).invert();
  const logRot = new THREE.Matrix3().setFromMatrix4(log.matrixWorld);
  const woodMat = makeSurfaceMaterial(shading, wood, placeholders.wood, 0.55 * wood.tiling, false, { inv: logInv, rot: logRot });
  const woodInner = makeSurfaceMaterial(shading, wood, placeholders.wood, 0.55 * wood.tiling, false, { inv: logInv, rot: logRot });
  woodInner.side = THREE.BackSide;
  log.add(new THREE.Mesh(outer, woodMat));
  log.add(new THREE.Mesh(inner, woodInner));
  // End lips follow the shaped radius so the wall reads as solid wood.
  for (const end of [1, -1]) {
    const lip = new THREE.RingGeometry(logR * 0.78, logR, 64, 1);
    const lp = lip.attributes.position;
    for (let v = 0; v < lp.count; v++) {
      const px = lp.getX(v), py = lp.getY(v);
      const [sx, , sz] = shapeLog(px, end * logLen / 2, py, 1);
      lp.setXYZ(v, sx, sz, 0);
    }
    const m = new THREE.Mesh(lip, woodMat);
    m.rotation.x = end > 0 ? -Math.PI / 2 : Math.PI / 2;
    m.position.y = end * logLen / 2;
    log.add(m);
  }
  group.add(log);
  const dir = new THREE.Vector3(Math.cos(logAng), 0, -Math.sin(logAng));
  const logY = -DEPTH + logR * 0.9;
  colliders.logs.push({
    a: new THREE.Vector3(lx, logY, lz).addScaledVector(dir, -logLen / 2),
    b: new THREE.Vector3(lx, logY, lz).addScaledVector(dir, logLen / 2),
    rInner: logR * 0.74, rOuter: logR * 1.08,
  });
  if (logY + logR > 0) {
    const half = Math.sqrt(logR * logR - logY * logY);
    colliders.waterline.capsules.push({ ax: lx - dir.x * logLen / 2, az: lz - dir.z * logLen / 2, bx: lx + dir.x * logLen / 2, bz: lz + dir.z * logLen / 2, r: half });
  }

  scene.add(group);
  return { group, colliders };
}
