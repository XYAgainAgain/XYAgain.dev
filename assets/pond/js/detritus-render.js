import * as THREE from 'three/webgpu';
import {
  Fn, If, Discard, attribute, uniform, varying, vec2, vec3, vec4, float,
  sin, cos, abs, sign, min, max, sqrt, pow, exp, floor, fract, length, dot, cross, normalize,
  mix, step, smoothstep, select, hash, fwidth, texture, frontFacing, instanceIndex,
  positionGeometry, uv, TWO_PI,
} from 'three/tsl';
import { DEPTH } from './config.js';
import { TRAY_SLOTS } from './detritus-core.js';
import { PadSystem } from './pads.js';
import { makeUnderwaterShading } from './shading.js';

/* The four detritus draws: sticks, cards, and the chunky lathe riding the film, plus the opaque sink
   tray under it. Shape is per-instance data on one topology each, so detritus.js only writes vec4s. */

export const DETRITUS_ORDER = { sticks: 30, cards: 31, chunky: 33, tray: 0 };
export { TRAY_SLOTS };

const STICK_ROWS = 10;                   // six rows cannot draw a kink: 10 × 2 sides = 20 vertices, 18 triangles
const STUB_ROWS = 2;                     // the welded sliver: 4 vertices, 2 triangles
const CARD_GRID = 3;                     // 3 × 3 = 9 vertices, 8 triangles
const LATHE_SIDES = 6, LATHE_RINGS = 4;  // 24 side + two 7-vertex cap fans = 38 vertices, 48 triangles
const ATLAS_COLS = 4, ATLAS_ROWS = 2;    // tiles 0–3 leaves, 4–5 chips, 6 petal, 7 spare
const SHADOW_RES = 1024;                 // the litter silhouette the floor reads through U.litterTex
const SLOT_KEYS = {
  sticks: ['s0', 's1', 's2', 's3', 's4'],
  cards: ['c0', 'c1', 'c2', 'c3'],
  chunky: ['k0', 'k1'],
  tray: ['t0', 't1', 't2', 't3'],
};
const XYZW = ['x', 'y', 'z', 'w'];

/* One kind's instance arrays, from { s0, s1, ... }, from an array in slot order, or from a single
   interleaved block, which is how the four-slot tray is easiest for the CPU side to keep together. */
function bindSlots(buffers, kind) {
  const keys = SLOT_KEYS[kind], src = buffers?.[kind];
  if (!src) throw new Error(`detritus-render: buffers.${kind} is missing`);
  if (src instanceof Float32Array) {
    const stride = keys.length * 4;
    if (src.length === 0 || src.length % stride) {
      throw new Error(`detritus-render: interleaved buffers.${kind} length ${src.length} is not a multiple of ${stride}`);
    }
    const count = src.length / stride;
    const arrays = keys.map(() => new Float32Array(count * 4));
    const pull = () => {
      for (let i = 0; i < count; i++) {
        for (let s = 0; s < keys.length; s++) {
          const from = i * stride + s * 4, to = i * 4, a = arrays[s];
          a[to] = src[from]; a[to + 1] = src[from + 1]; a[to + 2] = src[from + 2]; a[to + 3] = src[from + 3];
        }
      }
    };
    pull();
    return { count, arrays, pull };
  }
  const arrays = keys.map((k, i) => (Array.isArray(src) ? src[i] : src[k]));
  arrays.forEach((a, i) => {
    if (!(a instanceof Float32Array)) throw new Error(`detritus-render: buffers.${kind}.${keys[i]} is not a Float32Array`);
  });
  const count = arrays[0].length / 4;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`detritus-render: buffers.${kind}.${keys[0]} length ${arrays[0].length} is not 4 × a positive count`);
  }
  arrays.forEach((a, i) => {
    if (a.length !== count * 4) {
      throw new Error(`detritus-render: buffers.${kind} lengths disagree (${keys[i]} ${a.length}, want ${count * 4})`);
    }
  });
  return { count, arrays, pull: null };
}

function makeStickGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  // position is (row parameter, side, isStub) and uv is (isTip, side01): packing the ribbon coordinates
  // into the two default buffers is what keeps the stick at seven vertex buffers.
  const inner = STICK_ROWS - 2;
  const pos = [], uvs = [], idx = [];
  for (let r = 0; r < STICK_ROWS; r++) {
    const tipRow = r === 0 || r === STICK_ROWS - 1;
    const k = tipRow ? (r === 0 ? 0 : 1) : (r - 1) / (inner - 1);
    for (const s of [-1, 1]) { pos.push(k, s, 0); uvs.push(tipRow ? 1 : 0, (s + 1) * 0.5); }
  }
  for (let r = 0; r < STICK_ROWS - 1; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, d, a, d, c);
  }
  const base = STICK_ROWS * 2;
  for (let r = 0; r < STUB_ROWS; r++) {
    for (const s of [-1, 1]) { pos.push(r, s, 1); uvs.push(0, (s + 1) * 0.5); }
  }
  idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/* The card grid, built twice: once for the surface cards and once for the tray. position is the ±1
   grid and uv the leaf-local coordinate the atlas, the curl, and the hand-off dither all read. */
function makeCardGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  const pos = [], uvs = [], idx = [];
  for (let gy = 0; gy < CARD_GRID; gy++) {
    for (let gx = 0; gx < CARD_GRID; gx++) {
      pos.push(gx - 1, gy - 1, 0);
      uvs.push(gx * 0.5, gy * 0.5);
    }
  }
  for (let gy = 0; gy < CARD_GRID - 1; gy++) {
    for (let gx = 0; gx < CARD_GRID - 1; gx++) {
      const a = gy * CARD_GRID + gx, b = a + 1, c = a + CARD_GRID, d = c + 1;
      // Wound for a +y front face under the straight-down camera, like the pads: the other way round
      // frontFacing flips every card's normal downward and the moon term drops out.
      idx.push(a, d, b, a, c, d);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/* position is (v along the axis, u around it, code): 0 side, ±1 a cap rim, ±2 a cap center. The caps
   are mandatory, or a cone closing at radius 0.18 shows a hexagonal hole. */
function makeLatheGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  const pos = [], uvs = [], idx = [];
  for (let r = 0; r < LATHE_RINGS; r++) {
    for (let s = 0; s < LATHE_SIDES; s++) {
      const v = r / (LATHE_RINGS - 1), u = s / LATHE_SIDES;
      pos.push(v, u, 0); uvs.push(u, v);
    }
  }
  for (let r = 0; r < LATHE_RINGS - 1; r++) {
    for (let s = 0; s < LATHE_SIDES; s++) {
      const s2 = (s + 1) % LATHE_SIDES;
      const a = r * LATHE_SIDES + s, b = r * LATHE_SIDES + s2;
      const c = (r + 1) * LATHE_SIDES + s, d = (r + 1) * LATHE_SIDES + s2;
      // Outward-facing: the other winding turns the whole body inside out and frontFacing then lights
      // every cone from underneath.
      idx.push(a, d, b, a, c, d);
    }
  }
  for (const top of [true, false]) {
    const v = top ? 1 : 0, code = top ? 1 : -1;
    const hub = pos.length / 3;
    pos.push(v, 0, code * 2); uvs.push(0, v);
    for (let s = 0; s < LATHE_SIDES; s++) { pos.push(v, s / LATHE_SIDES, code); uvs.push(s / LATHE_SIDES, v); }
    for (let s = 0; s < LATHE_SIDES; s++) {
      const a = hub + 1 + s, b = hub + 1 + ((s + 1) % LATHE_SIDES);
      if (top) idx.push(hub, b, a); else idx.push(hub, a, b);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/* Premultiplied over the surface, spelled out rather than taken from a preset so the two backends
   cannot disagree; every fragment stage below emits premultiplied color. */
function setSurfaceBlend(mat) {
  mat.transparent = true;
  mat.premultipliedAlpha = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  mat.forceSinglePass = true;
}

/* The silhouette pass sums coverage into an 8-bit target, which saturates at 1: overlapping litter
   still reads as one shadow, and an item faded to nothing adds nothing. */
function setShadowBlend(mat) {
  mat.transparent = true;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  mat.forceSinglePass = true;
}

function texNode(map) { return map ? texture(map) : null; }

export function createDetritusMeshes({
  U, sim, textures = null, atlas = null, buffers,
  pads = null, ride: rideIn = null, shading: shadingIn = null,
}) {
  if (!U || !sim) throw new Error('detritus-render: U and sim are required');
  const sticks = bindSlots(buffers, 'sticks');
  const cards = bindSlots(buffers, 'cards');
  const chunky = bindSlots(buffers, 'chunky');
  const tray = bindSlots(buffers, 'tray');
  if (tray.count !== TRAY_SLOTS) {
    throw new Error(`detritus-render: the sink tray wants ${TRAY_SLOTS} slots, buffers.tray carries ${tray.count}`);
  }
  // The five-tap ride is the pads': borrowing their method keeps one stencil under everything afloat,
  // and it already folds makeSwell in, so adding swell again here would count it twice.
  const ride = rideIn ?? pads?.ride ?? PadSystem.prototype.makeRide.call({}, U, sim);
  const shading = shadingIn ?? makeUnderwaterShading(U);
  const wood = textures?.wood ?? null;
  const leaf = textures?.leaf ?? null;
  // The atlas arrives either as its own bundle or as the manifest's 'detritus' set, whose albedo
  // carries the opacity in its alpha; the leaf set stands in whole until one of them exists.
  const det = textures?.detritus ?? null;
  const atlasSet = atlas ?? (det?.albedo ? { albedoOpacity: det.albedo, normal: det.normal, arm: det.arm } : null);
  const attrs = [];
  const disposables = [];

  // The sim writes s1/s2/c1/c3 once per boot (respawns keep an item's identity), so only the
  // per-tick vec4s are dynamic; re-flagging the static ones each frame was pure upload waste.
  const DYNAMIC = new Set(['aDtS0', 'aDtS3', 'aDtC0', 'aDtC2', 'aDtK0', 'aDtK1', 'aDtT0', 'aDtT1', 'aDtT2', 'aDtT3']);
  const mkAttr = (geo, name, arr) => {
    const a = new THREE.InstancedBufferAttribute(arr, 4);
    const dyn = DYNAMIC.has(name);
    a.setUsage(dyn ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
    geo.setAttribute(name, a);
    if (dyn) attrs.push(a);
    return a;
  };

  // The atlas is one 4 × 2 grid. The inset is normalized, so rung 6's 512² atlas still insets inside
  // the tiles' 6 px margins; the bias is the lever if coarse mips ever bleed a neighbor in anyway.
  const uAtlasOn = uniform(atlasSet?.albedoOpacity ? 1 : 0);
  const uAtlasGrid = uniform(new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS));
  const uAtlasInset = uniform(new THREE.Vector2(1.5 / 1024, 1.5 / 1024));
  const uAtlasBias = uniform(0);
  for (const map of [atlasSet?.albedoOpacity, atlasSet?.normal, atlasSet?.arm]) {
    // The loader sets repeat wrapping, which on an atlas bleeds every tile into its neighbor.
    if (map) { map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.needsUpdate = true; }
  }
  const cardTex = {
    albedo: texNode(atlasSet?.albedoOpacity ?? leaf?.albedo),
    normal: texNode(atlasSet?.normal ?? leaf?.normal),
    arm: texNode(atlasSet?.arm ?? leaf?.arm),
    hasAlpha: !!atlasSet?.albedoOpacity,
  };
  const cardBump = det?.bump ?? leaf?.bump ?? 1.2;
  const atlasSample = (node, auv) => node.sample(auv).bias(uAtlasBias);
  const woodTex = {
    albedo: texNode(wood?.albedo),
    normal: texNode(wood?.normal),
    arm: texNode(wood?.arm),
    rough: texNode(wood?.arm ? null : wood?.roughness),
  };

  const uVoidSpan = uniform(0.8);        // seconds of the Space Eel's pull; reserved at voidT 0 in Part 1
  // The camera looks straight down, so a floater's bob is invisible and only its tilt shades. Sliding
  // down the ride gradient is the part of following the water a viewer can actually see.
  const uSway = uniform(0.18);
  const uPi = uniform(Math.PI);          // a uniform, not a literal: Naga rejects all-literal runtime math
  const uShadowTexel = uniform(sim.extent / SHADOW_RES);
  const uHalf = uniform(0.5);
  const uIdEps = uniform(0.5);
  const uDitherCells = uniform(64);      // one dither cell is about a pixel on a 0.5-unit leaf
  const uHashBias = uniform(1024.5);     // hash() truncates its seed to a uint, so keep it clear of zero
  const uHandoffU = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uHandoffId = uniform(new THREE.Vector4(-1, -1, -1, -1));
  const uKindEps = uniform(new THREE.Vector2(0.5, 1.5));
  // Curl coefficients per kind: (across² lift, along² lift, |across| kink, twist), scaled by the curl.
  const uLeafCurl = uniform(new THREE.Vector4(0.85, 0.10, 0, 0.12));
  const uChipCurl = uniform(new THREE.Vector4(0.25, 0, 0.55, 0.30));
  const uPetalCurl = uniform(new THREE.Vector4(0.55, 0.55, 0, 0));
  const uCardFallEdge = uniform(new THREE.Vector2(0.82, 1.0));
  const uCardFallCol = uniform(new THREE.Vector3(0.30, 0.22, 0.10));
  const slotOf = [(v) => v.x, (v) => v.y, (v) => v.z, (v) => v.w];

  /* The hand-off dither, shared by both cards so they cannot disagree: a cell index over the leaf's own
     UV and its pool id, never the screen coordinate, which refraction displaces between the two. */
  const handoffHash = Fn(([uvLocal, poolId]) => {
    const cell = floor(uvLocal.mul(uDitherCells));
    const id = cell.x.add(cell.y.mul(uDitherCells)).add(poolId.mul(uDitherCells).mul(uDitherCells));
    return hash(id.add(uHashBias));
  });

  /* One card's crossing progress, matched out of the four tray slots by pool id. An unclaimed card gets
     0, which reads as "nothing has handed off yet" on both sides. */
  const handoffFor = Fn(([poolId]) => {
    const u = float(0).toVar();
    for (const pick of slotOf) {
      u.addAssign(pick(uHandoffU).mul(step(abs(pick(uHandoffId).sub(poolId)), uIdEps)));
    }
    return u;
  });

  /* The atlas rect for a tile index, or the whole texture while the atlas is missing. */
  const tileRect = Fn(([tile]) => {
    const cols = uAtlasGrid.x;
    const tx = tile.sub(floor(tile.div(cols)).mul(cols));
    const ty = floor(tile.div(cols));
    const size = vec2(1).div(uAtlasGrid);
    const o = vec2(tx, ty).mul(size).add(uAtlasInset);
    const s = size.sub(uAtlasInset.mul(2));
    return vec4(mix(vec2(0), o, uAtlasOn), mix(vec2(1), s, uAtlasOn));
  });

  /* A card's curl height and its analytic gradient in world units: leaf edges lift, petals cup, chips
     kink. q.x runs across the card and q.y along it, matching the atlas, where a leaf's tip is at high v. */
  const cardCurl = Fn(([K, curl, q, halfW, halfL]) => {
    const ratio = halfW.div(halfL.max(1e-5));
    const h = K.x.mul(halfW).mul(q.x).mul(q.x)
      .add(K.y.mul(halfL).mul(q.y).mul(q.y))
      .add(K.z.mul(halfW).mul(abs(q.x)))
      .add(K.w.mul(halfW).mul(q.x).mul(q.y)).mul(curl);
    const gx = K.x.mul(2).mul(q.x).add(K.z.mul(sign(q.x))).add(K.w.mul(q.y)).mul(curl);
    const gz = K.y.mul(2).mul(q.y).add(K.w.mul(q.x).mul(ratio)).mul(curl);
    return vec3(h, gx, gz);
  });

  /* The shared cutout: the packed alpha where the atlas exists, an ellipse while it does not. */
  const cardShape = Fn(([texel, local]) => (cardTex.hasAlpha
    ? texel.a
    : smoothstep(uCardFallEdge.x, uCardFallEdge.y, length(local.sub(0.5).mul(2))).oneMinus()));

  const buildCards = () => {
    const geo = makeCardGeometry();
    const [c0a, c1a, c2a, c3a] = cards.arrays;
    mkAttr(geo, 'aDtC0', c0a); mkAttr(geo, 'aDtC1', c1a); mkAttr(geo, 'aDtC2', c2a); mkAttr(geo, 'aDtC3', c3a);
    geo.instanceCount = cards.count;

    const uLit = uniform(new THREE.Vector2(2.0, 0.24));
    const uGain = uniform(1.0), uBump = uniform(cardBump), uAO = uniform(0.6);
    const uRough = uniform(0.55);
    const uFloat = uniform(0.008);
    const uCut = uniform(0.45), uFringe = uniform(1.2);
    const uLog = uniform(new THREE.Vector2(0.55, 0.7));   // waterlog: albedo darkening, curl flattening
    const uAspectMin = uniform(0.05);

    const vN = varying(vec3(0), 'vDtCN');
    const vRect = varying(vec4(0), 'vDtCRect');
    const vInfo = varying(vec4(0), 'vDtCInfo');           // fade, waterlog age, petal flag (spare), pool id
    const vTint = varying(vec3(0), 'vDtCTint');
    const vTan = varying(vec3(0), 'vDtCTan');
    const vBi = varying(vec3(0), 'vDtCBi');

    /* One card vertex's world placement. The lit draw and the silhouette pass both call it, so a leaf
       and its shadow can never end up on different ripples. */
    const place = () => {
      const C0 = attribute('aDtC0', 'vec4'), C1 = attribute('aDtC1', 'vec4');
      const C2 = attribute('aDtC2', 'vec4'), C3 = attribute('aDtC3', 'vec4');
      const q = positionGeometry.xy;
      const kind = C1.x, age = C2.x.clamp(0, 1);
      const shrink = C2.z.div(uVoidSpan).clamp(0, 1).oneMinus();
      // size is the half-length along the card's own axis and aspect is length over width.
      const halfL = C0.w.mul(shrink);
      const halfW = halfL.div(C1.y.max(uAspectMin));
      const curl = C1.w.mul(age.mul(uLog.y).oneMinus().max(0));
      const K = mix(mix(uLeafCurl, uChipCurl, step(uKindEps.x, kind)), uPetalCurl, step(uKindEps.y, kind));
      const cu = cardCurl(K, curl, q, halfW, halfL);
      const cr = cos(C0.z), sr = sin(C0.z);
      const local = vec2(q.x.mul(halfW), q.y.mul(halfL));
      // Yaw 0 points along +z: long axis (sin, cos), across axis (cos, -sin), the frame stationsFor
      // traces. Negating the yaw here drew every card mirrored off the silhouette physics collides with.
      const off = vec2(local.x.mul(cr).add(local.y.mul(sr)), local.x.mul(sr).negate().add(local.y.mul(cr)));
      // One centered tap, radius-scaled like a pad: all nine vertices read the same texel addresses.
      const r = ride(C0.xy, max(halfW, halfL));
      const g = vec2(r.y, r.z);
      const y = r.x.add(dot(off, g)).add(cu.x).add(uFloat);
      const gl = vec2(cu.y.mul(cr).add(cu.z.mul(sr)), cu.y.mul(sr).negate().add(cu.z.mul(cr))).add(g);
      const slide = g.mul(uSway);
      return { C0, C1, C2, C3, kind, age, cr, sr, gl, fade: C2.y.clamp(0, 1),
        pos: vec3(C0.x.add(off.x).sub(slide.x), y, C0.y.add(off.y).sub(slide.y)) };
    };

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const s = place();
      vN.assign(normalize(vec3(s.gl.x.negate(), 1, s.gl.y.negate())));
      vTan.assign(vec3(s.cr, 0, s.sr.negate()));
      vBi.assign(vec3(s.sr, 0, s.cr));
      vRect.assign(tileRect(s.C2.w));
      vInfo.assign(vec4(s.fade, s.age, step(uKindEps.y, s.kind), float(instanceIndex)));
      // c3 is every kind's multiply now: the sim writes real palette values for leaves and chips too.
      vTint.assign(s.C3.rgb);
      return s.pos;
    })();

    mat.fragmentNode = Fn(() => {
      const local = uv();
      const auv = vRect.xy.add(local.mul(vRect.zw));
      const src = cardTex.albedo ? atlasSample(cardTex.albedo, auv) : vec4(uCardFallCol, 1);
      // Cutout, not blend: one instanced draw cannot sort its own overlaps and renderOrder only sorts
      // draws. Every fetch happens before the discard, which is where the fragment budget went.
      const shape = cardShape(src, local);
      const arm = cardTex.arm ? atlasSample(cardTex.arm, auv) : vec4(1, uRough, 0, 1);
      const tn = cardTex.normal ? atlasSample(cardTex.normal, auv).rgb.mul(2).sub(1) : vec3(0, 0, 1);
      const band = fwidth(shape).mul(uFringe).max(1e-4);
      const poolId = vInfo.w;
      const over = step(handoffFor(poolId), handoffHash(local, poolId));
      If(shape.lessThan(uCut), () => { Discard(); });
      // The over half of the crossing, off the same hash and the same u the tray card reads.
      If(over.lessThan(uHalf), () => { Discard(); });
      const n0 = normalize(vN);
      const n = normalize(vTan.mul(tn.x.mul(uBump)).add(vBi.mul(tn.y.mul(uBump))).add(n0.mul(tn.z)));
      const nn = select(frontFacing, n, n.negate());
      const ao = arm.r.mul(uAO).add(uAO.oneMinus());
      const albedo = src.rgb.mul(vTint).mul(mix(float(1), uLog.x, vInfo.y)).mul(ao);
      const ndl = dot(nn, U.moonDir).max(0);
      const col = albedo.mul(U.moonColor).mul(ndl.mul(uLit.x).add(uLit.y)).mul(U.moonStrength).mul(uGain);
      // Premultiplied, with the antialiasing confined to the fringe the cutout left standing.
      const a = smoothstep(uCut, uCut.add(band), shape).mul(vInfo.x);
      return vec4(col.mul(a), a);
    })();
    setSurfaceBlend(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = DETRITUS_ORDER.cards;

    const sRect = varying(vec4(0), 'vDtCSRect');
    const sInfo = varying(vec2(0), 'vDtCSInfo');   // fade, pool id
    const shadowMat = new THREE.NodeMaterial();
    shadowMat.positionNode = Fn(() => {
      const s = place();
      sRect.assign(tileRect(s.C2.w));
      sInfo.assign(vec2(s.fade, float(instanceIndex)));
      return s.pos;
    })();
    shadowMat.fragmentNode = Fn(() => {
      const local = uv();
      const src = cardTex.albedo
        ? atlasSample(cardTex.albedo, sRect.xy.add(local.mul(sRect.zw)))
        : vec4(uCardFallCol, 1);
      const poolId = sInfo.y;
      // The same over-half the surface card discards: a sinking leaf's shadow has to leave the surface
      // plane with the leaf, not hang there until the pool slot respawns.
      const over = step(handoffFor(poolId), handoffHash(local, poolId));
      If(cardShape(src, local).lessThan(uCut), () => { Discard(); });
      If(over.lessThan(uHalf), () => { Discard(); });
      return vec4(sInfo.x);
    })();
    setShadowBlend(shadowMat);
    const shadowMesh = new THREE.Mesh(geo, shadowMat);
    shadowMesh.frustumCulled = false;

    disposables.push(geo, mat, shadowMat);
    return { mesh, shadowMesh, geo, knobs: {
      lit: uLit, gain: uGain, bump: uBump, ao: uAO, rough: uRough, float: uFloat,
      cut: uCut, fringe: uFringe, waterlog: uLog, aspectMin: uAspectMin,
      leafCurl: uLeafCurl, chipCurl: uChipCurl, petalCurl: uPetalCurl,
      fallbackEdge: uCardFallEdge, fallbackColor: uCardFallCol,
    } };
  };

  const buildSticks = () => {
    const geo = makeStickGeometry();
    const [s0a, s1a, s2a, s3a, s4a] = sticks.arrays;
    mkAttr(geo, 'aDtS0', s0a); mkAttr(geo, 'aDtS1', s1a); mkAttr(geo, 'aDtS2', s2a);
    mkAttr(geo, 'aDtS3', s3a); mkAttr(geo, 'aDtS4', s4a);
    geo.instanceCount = sticks.count;

    const uTile = uniform(new THREE.Vector2(1.4, 0.22));   // bark repeats per unit along the axis, per flank across
    const uPhase = uniform(new THREE.Vector2(0.37, 0.11));
    const uFall = uniform(new THREE.Vector3(0.26, 0.19, 0.12));
    const uBroken = uniform(new THREE.Vector3(0.70, 0.62, 0.46));
    const uBrokenLen = uniform(0.030);
    // The six shelter sticks read as weathered grey driftwood: thicker from the CPU, paler from here.
    const uShelterTint = uniform(0.65);
    const uShelterCol = uniform(new THREE.Vector3(0.58, 0.57, 0.52));
    const uSnapPinch = uniform(0.30);                      // how far a snapped stick necks in at the tear
    const uWet = uniform(new THREE.Vector2(0.72, 1.0));
    const uWetDark = uniform(0.62);
    const uMen = uniform(new THREE.Vector4(0.88, 0.05, 0.55, 10));   // where, width, gain, glint power
    const uLit = uniform(new THREE.Vector2(1.9, 0.22));
    const uGain = uniform(1.0), uBump = uniform(wood?.bump ?? 1.0), uAO = uniform(0.6), uRough = uniform(0.8);
    const uFloat = uniform(0.010);
    const uBow = uniform(1.0);
    const uCap = uniform(1.0), uCapMax = uniform(0.25);    // the round end is one half-width long
    const uAgeDark = uniform(0.80);
    const uTapR = uniform(0.02);
    const uStubEps = uniform(1e-4);

    const vSide = varying(float(0), 'vDtSSide');
    const vFrame = varying(vec3(0), 'vDtSFrame');
    const vNorm = varying(vec3(0), 'vDtSNorm');
    const vTan = varying(vec3(0), 'vDtSTan');
    const vUV = varying(vec2(0), 'vDtSUV');
    const vInfo = varying(vec4(0), 'vDtSInfo');   // distance from the nearest end, age, fade, shelter
    const vSnap = varying(float(0), 'vDtSSnap');  // world distance from the snap, huge on an unsnapped stick

    /* One ribbon vertex's world placement, shared by the lit draw and the silhouette pass. widthFloor
       is the silhouette's minimum half-width: a twig thinner than a texel aliases out of that target. */
    const place = (widthFloor) => {
      const S0 = attribute('aDtS0', 'vec4'), S1 = attribute('aDtS1', 'vec4');
      const S2 = attribute('aDtS2', 'vec4'), S3 = attribute('aDtS3', 'vec4');
      const S4 = attribute('aDtS4', 'vec4');
      const rib = positionGeometry, tip = attribute('uv', 'vec2').x;
      const kRow = rib.x, side = rib.y, isStub = rib.z;
      const shrink = S3.z.div(uVoidSpan).clamp(0, 1).oneMinus();
      const L = S0.w.mul(shrink).max(1e-4);
      const HW = S1.x.mul(shrink);
      const capT = HW.mul(uCap).div(L).min(uCapMax).max(1e-4);
      // The first and last rows are the tips; the rest span the barrel between the two round ends.
      const tMain = mix(capT.add(kRow.mul(capT.mul(-2).add(1))), kRow, tip);
      const t = mix(tMain, S2.x.clamp(0, 1), isStub);
      // Yaw 0 points along +z, matching stationsFor: long axis (sin, cos), lateral (cos, -sin). The old
      // (cos, sin) drew every stick mirrored across the diagonal from the silhouette physics collides with.
      const dir = vec2(sin(S0.z), cos(S0.z));
      const perp = vec2(cos(S0.z), sin(S0.z).negate());
      const bow = S1.y.mul(uBow).mul(shrink);
      const bow2 = S4.z.mul(uBow).mul(shrink);
      const kinkT = S4.x, kinkAmp = S4.y.mul(shrink);
      const twoPiT = uPi.mul(2).mul(t);
      // Centerline: one hump, one S-bend, and a hinge that opens past kinkT. The hinge is what reads as
      // a Y-fork's second limb or a stick that snapped and never straightened out.
      const latOff = bow.mul(sin(uPi.mul(t)))
        .add(bow2.mul(sin(twoPiT)))
        .add(kinkAmp.mul(L).mul(t.sub(kinkT).max(0)));
      const latD = bow.mul(uPi).mul(cos(uPi.mul(t)))
        .add(bow2.mul(uPi.mul(2)).mul(cos(twoPiT)))
        .add(kinkAmp.mul(L).mul(step(kinkT, t)));
      const axis = S0.xy.add(dir.mul(t.sub(0.5).mul(L))).add(perp.mul(latOff));
      const tanXZ = normalize(dir.add(perp.mul(latD.div(L))));
      const stubDir = vec2(sin(S0.z.add(S2.z)), cos(S0.z.add(S2.z)));
      const stubLive = step(uStubEps, S2.y);
      const center = mix(axis, axis.add(stubDir.mul(S2.y.mul(shrink).mul(stubLive).mul(kRow))), isStub);
      // The circular cap profile, so a tip closes to a round end instead of a spear.
      const e = min(t, t.oneMinus()).div(capT).clamp(0, 1);
      const snapped = step(0.5, S4.w);
      const snapD = abs(t.sub(kinkT)).mul(L);
      const pinch = smoothstep(0, uBrokenLen, snapD).oneMinus().mul(snapped).mul(uSnapPinch).oneMinus();
      const wMain = HW.mul(sqrt(e.mul(2).sub(e.mul(e)).max(0))).mul(pinch);
      // A stub with length 0 collapses all four of its vertices onto the weld: four vertex invocations
      // and no fragments, which is what close to a third of the twigs cost. The floor must not revive it.
      const wStub = S2.w.mul(shrink).mul(kRow.oneMinus()).mul(stubLive);
      const live = mix(float(1), stubLive, isStub);
      const w = mix(wMain, wStub, isStub).max(widthFloor.mul(live));
      const perp3 = mix(vec3(tanXZ.y, 0, tanXZ.x.negate()), vec3(stubDir.y, 0, stubDir.x.negate()), isStub);
      const tan3 = mix(vec3(tanXZ.x, 0, tanXZ.y), vec3(stubDir.x, 0, stubDir.y), isStub);
      const cr = cos(S1.w), sr = sin(S1.w);
      const sideDir = perp3.mul(cr).add(vec3(0, 1, 0).mul(sr));
      const lat = sideDir.mul(side.mul(w));
      // Two taps at the world endpoints: their mean is the bob and their difference the lengthwise
      // tilt, which is what rigidity costs. Per-station taps would let the longest 1.85-unit stick bend.
      const tapR = HW.max(uTapR);
      const rA = ride(S0.xy.sub(dir.mul(L.mul(0.5))), tapR);
      const rB = ride(S0.xy.add(dir.mul(L.mul(0.5))), tapR);
      const gMean = vec2(rA.y.add(rB.y), rA.z.add(rB.z)).mul(0.5);
      const slide = gMean.mul(uSway);
      const p = vec2(center.x.add(lat.x).sub(slide.x), center.y.add(lat.z).sub(slide.y));
      const y = rA.x.add(rB.x).mul(0.5)
        .add(t.sub(0.5).mul(rB.x.sub(rA.x)))
        .add(dot(p.sub(S0.xy), perp).mul(dot(gMean, perp)))
        .add(lat.y).add(uFloat);
      return { S0, S1, S2, S3, side, sideDir, perp3, tan3, cr, sr, t, L, snapped, snapD,
        fade: S3.y.clamp(0, 1), pos: vec3(p.x, y, p.y) };
    };

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const s = place(float(0));
      vSide.assign(s.side);
      vFrame.assign(s.sideDir);
      vNorm.assign(s.perp3.mul(s.sr.negate()).add(vec3(0, 1, 0).mul(s.cr)));
      vTan.assign(s.tan3);
      vUV.assign(vec2(s.t.mul(s.L).mul(uTile.x).add(s.S1.z.mul(uPhase.x)),
        s.side.mul(uTile.y).add(s.S1.z.mul(uPhase.y))));
      // flags bit 0 is the shelter mark: the six long sticks the eels rest under, never cut by the ladder.
      vInfo.assign(vec4(min(s.t, s.t.oneMinus()).mul(s.L), s.S3.x.clamp(0, 1), s.fade,
        step(0.25, fract(s.S3.w.mul(0.5)))));
      vSnap.assign(mix(float(1e3), s.snapD, s.snapped));
      return s.pos;
    })();

    mat.fragmentNode = Fn(() => {
      const side = vSide, aSide = abs(side);
      // The rushes' signed-side fake cylinder: the side coordinate is the normal across the ribbon,
      // taken perpendicular to the local tangent, so a flat strip shades round.
      const n0 = vFrame.mul(side).add(vNorm.mul(sqrt(side.mul(side).oneMinus().max(0))));
      const tRaw = normalize(vTan);
      const nRaw = n0.sub(tRaw.mul(dot(n0, tRaw)));
      const nCyl = nRaw.div(length(nRaw).max(1e-4));
      const tn = woodTex.normal ? woodTex.normal.sample(vUV).rgb.mul(2).sub(1) : vec3(0, 0, 1);
      const n = normalize(tRaw.mul(tn.x.mul(uBump)).add(cross(nCyl, tRaw).mul(tn.y.mul(uBump))).add(nCyl.mul(tn.z)));
      const nn = select(frontFacing, n, n.negate());
      const armV = woodTex.arm ? woodTex.arm.sample(vUV) : null;
      const ao = armV ? armV.r.mul(uAO).add(uAO.oneMinus()) : float(1);
      const rough = armV ? armV.g : (woodTex.rough ? woodTex.rough.sample(vUV).r : uRough);
      const albedo = (woodTex.albedo ? woodTex.albedo.sample(vUV).rgb : uFall).toVar();
      albedo.assign(mix(albedo, uShelterCol.mul(albedo.g.add(0.35)), vInfo.w.mul(uShelterTint)));
      // A snapped end shows pale interior wood over a fixed world distance, not a fraction of the length.
      albedo.assign(mix(albedo, uBroken.mul(albedo.r.add(0.40)), smoothstep(0, uBrokenLen, vInfo.x).oneMinus()));
      // Mid-stick tear: the same pale wood in a band at the kink, where the width pinched in.
      albedo.assign(mix(albedo, uBroken.mul(albedo.r.add(0.40)), smoothstep(0, uBrokenLen, vSnap).oneMinus()));
      albedo.mulAssign(mix(float(1), uAgeDark, vInfo.y));
      // Two grazing-flank margins, not one edge: the fake cylinder's up term is a square root and never
      // goes negative, so there is no downward component a single waterline could key off.
      albedo.mulAssign(mix(float(1), uWetDark, smoothstep(uWet.x, uWet.y, aSide)));
      const ndl = dot(nn, U.moonDir).max(0);
      const lit = albedo.mul(ao).mul(U.moonColor).mul(ndl.mul(uLit.x).add(uLit.y)).mul(U.moonStrength).mul(uGain).toVar();
      // One meniscus hairline per flank, on the moon vector, where the film actually grips the bark.
      const glint = pow(dot(nn, normalize(U.moonDir.add(vec3(0, 1, 0)))).max(0), uMen.w)
        .mul(smoothstep(0, uMen.y, abs(aSide.sub(uMen.x))).oneMinus()).mul(uMen.z).mul(rough.oneMinus().max(0.2));
      lit.addAssign(U.moonColor.mul(glint));
      const a = vInfo.z;
      return vec4(lit.mul(a), a);
    })();
    setSurfaceBlend(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = DETRITUS_ORDER.sticks;

    const sFade = varying(float(0), 'vDtSSFade');
    const shadowMat = new THREE.NodeMaterial();
    shadowMat.positionNode = Fn(() => {
      const s = place(uShadowTexel);
      sFade.assign(s.fade);
      return s.pos;
    })();
    shadowMat.fragmentNode = Fn(() => vec4(sFade))();
    setShadowBlend(shadowMat);
    const shadowMesh = new THREE.Mesh(geo, shadowMat);
    shadowMesh.frustumCulled = false;

    disposables.push(geo, mat, shadowMat);
    return { mesh, shadowMesh, geo, knobs: {
      tile: uTile, phase: uPhase, fallback: uFall, broken: uBroken, brokenLen: uBrokenLen,
      shelterTint: uShelterTint, shelterColor: uShelterCol, snapPinch: uSnapPinch,
      wet: uWet, wetDark: uWetDark,
      meniscus: uMen, lit: uLit, gain: uGain, bump: uBump, ao: uAO, rough: uRough,
      float: uFloat, bow: uBow, cap: uCap, capMax: uCapMax, ageDark: uAgeDark, tapRadius: uTapR,
    } };
  };

  const buildChunky = () => {
    const geo = makeLatheGeometry();
    const [k0a, k1a] = chunky.arrays;
    mkAttr(geo, 'aDtK0', k0a); mkAttr(geo, 'aDtK1', k1a);
    geo.instanceCount = chunky.count;

    const uConeRings = uniform(new THREE.Vector4(0.95, 1.0, 0.72, 0.18));
    const uAcornRings = uniform(new THREE.Vector4(0.55, 1.0, 0.98, 0.80));
    const uRingSteps = uniform(new THREE.Vector3(0.2, 0.5, 0.8));
    const uThird = uniform(1 / (LATHE_RINGS - 1));
    const uTall = uniform(new THREE.Vector2(2.3, 1.7));        // body height in radii: cone, acorn
    const uWater = uniform(new THREE.Vector2(0.45, 0.42));     // where the film crosses the body
    const uNub = uniform(0.015);
    const uLean = uniform(1.5);
    const uRock = uniform(0.35);       // seeded idle rocking, in slope units, on top of the ride lean
    const uTile = uniform(24.0), uPhase = uniform(0.29), uGrain = uniform(0.35);
    const uConeTint = uniform(new THREE.Vector3(0.42, 0.28, 0.15));
    const uAcornTint = uniform(new THREE.Vector3(0.66, 0.48, 0.26));
    const uCapTint = uniform(new THREE.Vector3(0.34, 0.24, 0.14));
    const uCapFrom = uniform(new THREE.Vector2(0.66, 0.70));   // the cupule takes the top 32% of v
    const uRimW = uniform(0.02), uRimDark = uniform(0.55);
    const uBract = uniform(new THREE.Vector4(6.0, 5.0, 0.35, 0.45));   // ridges along v, spiral steps in u, albedo bite, normal bite
    const uAbsorb = uniform(new THREE.Vector3(0.22, 0.11, 0.06));
    const uMen = uniform(new THREE.Vector2(0.008, 0.45));
    const uLit = uniform(new THREE.Vector2(2.1, 0.20));
    const uGain = uniform(1.0), uBump = uniform(wood?.bump ?? 1.0), uAO = uniform(0.6);
    const uRough = uniform(new THREE.Vector2(0.65, 0.9));      // body, acorn cap
    const uTapMin = uniform(0.02);

    const vN = varying(vec3(0), 'vDtKN');
    const vRad = varying(vec3(0), 'vDtKRad');
    const vTanU = varying(vec3(0), 'vDtKTanU');
    const vUV = varying(vec4(0), 'vDtKUV');       // bark uv, then the raw lathe (u, v)
    const vInfo = varying(vec3(0), 'vDtKInfo');   // kindT, fade, height above the film

    /* One lathe vertex's world placement, shared by the lit draw and the silhouette pass. */
    const place = () => {
      const K0 = attribute('aDtK0', 'vec4'), K1 = attribute('aDtK1', 'vec4');
      const g = positionGeometry;
      const v = g.x, uAround = g.y, code = g.z;
      const kindT = K1.x.clamp(0, 1);
      const shrink = K1.w.div(uVoidSpan).clamp(0, 1).oneMinus();
      const size = K0.w.mul(shrink);
      const prof = mix(uConeRings, uAcornRings, kindT);
      // One profile vec4 scales the four rings, so one topology reads as a cone or an acorn.
      const ringAt = (vv) => {
        const r = prof.x.toVar();
        r.assign(mix(r, prof.y, step(uRingSteps.x, vv)));
        r.assign(mix(r, prof.z, step(uRingSteps.y, vv)));
        r.assign(mix(r, prof.w, step(uRingSteps.z, vv)));
        return r;
      };
      const isCap = step(0.5, abs(code));
      const isHub = step(1.5, abs(code));
      const radius = ringAt(v).mul(size).mul(isHub.oneMinus());
      const ang = uAround.mul(TWO_PI).add(K0.z);
      const radial = vec2(cos(ang), sin(ang));
      const tall = mix(uTall.x, uTall.y, kindT).mul(size);
      // The acorn's pole nub is the top cap's own center pushed along the axis; the cone gets none.
      const yLocal = v.sub(mix(uWater.x, uWater.y, kindT)).mul(tall)
        .add(isHub.mul(step(0.5, code)).mul(uNub).mul(kindT));
      // Both taps use one instance axis; a per-vertex radial axis would give every rim vertex its own
      // waterline and warp the lathe.
      const dirLean = vec2(sin(K0.z), cos(K0.z));
      const perpLean = vec2(cos(K0.z), sin(K0.z).negate());
      const tapR = size.max(uTapMin);
      const rA = ride(K0.xy.sub(dirLean.mul(size)), tapR);
      const rB = ride(K0.xy.add(dirLean.mul(size)), tapR);
      const gMean = vec2(rA.y.add(rB.y), rA.z.add(rB.z)).mul(0.5);
      // Two incommensurate rates per seed, so no two acorns bob together and none of it ever loops.
      const rock = vec2(sin(U.time.mul(1.3).add(K1.y.mul(9))), cos(U.time.mul(1.1).add(K1.y.mul(5))))
        .mul(uRock).mul(U.motionScale);
      const lean = dirLean.mul(rB.x.sub(rA.x).div(size.mul(2).max(1e-4)))
        .add(perpLean.mul(dot(gMean, perpLean))).mul(uLean).add(rock);
      const waterY = rA.x.add(rB.x).mul(0.5);
      const off = radial.mul(radius);
      const slide = gMean.mul(uSway);
      const xz = K0.xy.add(off).sub(lean.mul(yLocal)).sub(slide);
      // The lathe's own surface normal from the profile slope, one-sided at the two ends.
      const vHi = v.add(uThird).min(1), vLo = v.sub(uThird).max(0);
      const dR = ringAt(vHi).sub(ringAt(vLo)).mul(size);
      const dY = vHi.sub(vLo).mul(tall).max(1e-5);
      const n2 = normalize(vec2(dY, dR.negate()));
      const nSide = normalize(vec3(radial.x.mul(n2.x), n2.y, radial.y.mul(n2.x)));
      return { K0, K1, kindT, size, radial, isCap, code, v, uAround, off, gMean, yLocal,
        nSide, fade: K1.z.clamp(0, 1), pos: vec3(xz.x, waterY.add(yLocal), xz.y) };
    };

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const s = place();
      vN.assign(mix(s.nSide, vec3(0, sign(s.code), 0), s.isCap));
      vRad.assign(vec3(s.radial.x, 0, s.radial.y));
      vTanU.assign(vec3(s.radial.y.negate(), 0, s.radial.x));
      vUV.assign(vec4(vec2(s.uAround, s.v).mul(s.size).mul(uTile).add(s.K1.y.mul(uPhase)), s.uAround, s.v));
      // Height above the film at this fragment's own xz, so the waterline follows the ripple slope.
      vInfo.assign(vec3(s.kindT, s.fade, s.yLocal.sub(dot(s.off, s.gMean))));
      return s.pos;
    })();

    mat.fragmentNode = Fn(() => {
      const kindT = vInfo.x, cone = kindT.oneMinus(), v = vUV.w;
      // Bract ridges: a triangle wave along v, its phase stepped into a five-turn spiral around u.
      const bract = abs(fract(v.mul(uBract.x).add(floor(vUV.z.mul(uBract.y)).div(uBract.y))).mul(2).sub(1));
      const tn = woodTex.normal ? woodTex.normal.sample(vUV.xy).rgb.mul(2).sub(1) : vec3(0, 0, 1);
      const n = normalize(vTanU.mul(tn.x.mul(uBump)).add(vRad.mul(tn.y.mul(uBump))).add(normalize(vN).mul(tn.z))).toVar();
      n.assign(normalize(n.add(vTanU.mul(bract.mul(2).sub(1)).mul(uBract.w).mul(cone))));
      const nn = select(frontFacing, n, n.negate());
      const armV = woodTex.arm ? woodTex.arm.sample(vUV.xy) : null;
      const ao = armV ? armV.r.mul(uAO).add(uAO.oneMinus()) : float(1);
      const tint = mix(uConeTint, uAcornTint, kindT);
      const albedo = (woodTex.albedo ? tint.mul(woodTex.albedo.sample(vUV.xy).rgb.add(uGrain)) : tint).toVar();
      albedo.mulAssign(mix(float(1), bract.mul(uBract.z).oneMinus(), cone));
      // The acorn's cupule: the top third takes the rough tone, with a darker line at its rim.
      const cap = smoothstep(uCapFrom.x, uCapFrom.y, v).mul(kindT);
      albedo.assign(mix(albedo, uCapTint, cap));
      albedo.mulAssign(smoothstep(0, uRimW, abs(v.sub(uCapFrom.y))).oneMinus().mul(kindT).mul(uRimDark).oneMinus());
      const rough = mix(armV ? armV.g : (woodTex.rough ? woodTex.rough.sample(vUV.xy).r : uRough.x), uRough.y, cap);
      // Half-submersion is a tint, not a discard: a discard would leave composed water where the
      // submerged mass should be, and the vertex stage already knows this fragment's height.
      const sub = smoothstep(uMen.x.negate(), uMen.x, vInfo.z).oneMinus();
      albedo.assign(mix(albedo, albedo.mul(exp(uAbsorb.negate().mul(vInfo.z.negate().max(0)))), sub));
      const ndl = dot(nn, U.moonDir).max(0);
      const lit = albedo.mul(ao).mul(U.moonColor).mul(ndl.mul(uLit.x).add(uLit.y)).mul(U.moonStrength).mul(uGain).toVar();
      lit.addAssign(U.moonColor.mul(smoothstep(0, uMen.x, abs(vInfo.z)).oneMinus().mul(uMen.y).mul(rough.oneMinus().max(0.2))));
      const a = vInfo.y;
      return vec4(lit.mul(a), a);
    })();
    setSurfaceBlend(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = DETRITUS_ORDER.chunky;

    const sFade = varying(float(0), 'vDtKSFade');
    const shadowMat = new THREE.NodeMaterial();
    shadowMat.positionNode = Fn(() => {
      const s = place();
      sFade.assign(s.fade);
      return s.pos;
    })();
    shadowMat.fragmentNode = Fn(() => vec4(sFade))();
    setShadowBlend(shadowMat);
    const shadowMesh = new THREE.Mesh(geo, shadowMat);
    shadowMesh.frustumCulled = false;

    disposables.push(geo, mat, shadowMat);
    return { mesh, shadowMesh, geo, knobs: {
      coneRings: uConeRings, acornRings: uAcornRings, tall: uTall, water: uWater, nub: uNub,
      lean: uLean, rock: uRock, tile: uTile, phase: uPhase, grain: uGrain,
      coneTint: uConeTint, acornTint: uAcornTint, capTint: uCapTint, capFrom: uCapFrom,
      rimWidth: uRimW, rimDark: uRimDark, bract: uBract, absorb: uAbsorb, meniscus: uMen,
      lit: uLit, gain: uGain, bump: uBump, ao: uAO, rough: uRough, tapMin: uTapMin,
    } };
  };

  const buildTray = () => {
    const geo = makeCardGeometry();
    const [t0a, t1a, t2a, t3a] = tray.arrays;
    mkAttr(geo, 'aDtT0', t0a); mkAttr(geo, 'aDtT1', t1a); mkAttr(geo, 'aDtT2', t2a); mkAttr(geo, 'aDtT3', t3a);
    geo.instanceCount = TRAY_SLOTS;

    const uBump = uniform(cardBump);
    const uRough = uniform(0.6);
    const uDark = uniform(0.55);          // a leaf that sinks is already waterlogged through
    const uCut = uniform(0.45);
    const uAspectMin = uniform(0.05);

    const vN = varying(vec3(0), 'vDtTN');
    const vP = varying(vec3(0), 'vDtTP');
    const vRect = varying(vec4(0), 'vDtTRect');
    const vTint = varying(vec3(0), 'vDtTTint');
    const vTan = varying(vec3(0), 'vDtTTan');
    const vBi = varying(vec3(0), 'vDtTBi');
    const vId = varying(float(0), 'vDtTId');
    const vGone = varying(float(0), 'vDtTGone');

    const mat = new THREE.NodeMaterial();
    mat.positionNode = Fn(() => {
      const T0 = attribute('aDtT0', 'vec4'), T1 = attribute('aDtT1', 'vec4');
      const T2 = attribute('aDtT2', 'vec4'), T3 = attribute('aDtT3', 'vec4');
      const q = positionGeometry.xy;
      const kind = T1.x;
      const halfL = T0.w;
      const halfW = halfL.div(T1.y.max(uAspectMin));
      const K = mix(mix(uLeafCurl, uChipCurl, step(uKindEps.x, kind)), uPetalCurl, step(uKindEps.y, kind));
      const cu = cardCurl(K, T1.w, q, halfW, halfL);
      const cr = cos(T0.z), sr = sin(T0.z);
      const local = vec2(q.x.mul(halfW), q.y.mul(halfL));
      // Same frame as the surface card: long axis (sin, cos), across axis (cos, -sin).
      const off = vec2(local.x.mul(cr).add(local.y.mul(sr)), local.x.mul(sr).negate().add(local.y.mul(cr)));
      const gl = vec2(cu.y.mul(cr).add(cu.z.mul(sr)), cu.y.mul(sr).negate().add(cu.z.mul(cr)));
      vN.assign(normalize(vec3(gl.x.negate(), 1, gl.y.negate())));
      vTan.assign(vec3(cr, 0, sr.negate()));
      vBi.assign(vec3(sr, 0, cr));
      vRect.assign(tileRect(T2.z));
      vTint.assign(T3.rgb);
      vId.assign(T2.w);
      vGone.assign(T3.w.clamp(0, 1));
      const p = vec3(T0.x.add(off.x), T2.y.negate().add(cu.x), T0.y.add(off.y));
      vP.assign(p);
      return p;
    })();

    mat.fragmentNode = Fn(() => {
      const local = uv();
      const auv = vRect.xy.add(local.mul(vRect.zw));
      const src = cardTex.albedo ? atlasSample(cardTex.albedo, auv) : vec4(uCardFallCol, 1);
      const shape = cardShape(src, local);
      const arm = cardTex.arm ? atlasSample(cardTex.arm, auv) : vec4(1, uRough, 0, 1);
      const tn = cardTex.normal ? atlasSample(cardTex.normal, auv).rgb.mul(2).sub(1) : vec3(0, 0, 1);
      const dither = handoffHash(local, vId);
      const over = step(handoffFor(vId), dither);
      // underRT's alpha is the depth fraction the compose pass refracts by, so coverage has to be a
      // discard, never a blend; the under half of the crossing keeps exactly what the over half cut.
      If(shape.lessThan(uCut), () => { Discard(); });
      If(over.greaterThan(uHalf), () => { Discard(); });
      // Same dither runs the rot-away once a leaf has landed, so it dissolves into the sand cell by cell.
      If(dither.lessThan(vGone), () => { Discard(); });
      const n = normalize(vTan.mul(tn.x.mul(uBump)).add(vBi.mul(tn.y.mul(uBump))).add(normalize(vN).mul(tn.z)));
      const nn = select(frontFacing, n, n.negate());
      const albedo = src.rgb.mul(vTint).mul(uDark).mul(arm.r.mul(0.5).add(0.5));
      const lit = shading.shade(albedo, nn, vP, arm.g);
      return vec4(lit, vP.y.negate().div(DEPTH).clamp(0, 1));
    })();
    // Opaque, exactly like the rush under pass: no blending to configure, and alpha is the depth fraction.
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = DETRITUS_ORDER.tray;
    disposables.push(geo, mat);
    return { mesh, geo, knobs: { bump: uBump, rough: uRough, dark: uDark, cut: uCut, aspectMin: uAspectMin } };
  };

  const S = buildSticks(), C = buildCards(), K = buildChunky(), T = buildTray();
  const byKind = { sticks: S, cards: C, chunky: K };
  const pools = { sticks: sticks.count, cards: cards.count, chunky: chunky.count };
  const trayU = tray.arrays[2];
  const handoffU = uHandoffU.value, handoffId = uHandoffId.value;

  /* The litter's own silhouette, for shade()'s moon-position shadows. Framed exactly like the caustic
     camera so uv = p.xz / extent + 0.5, which is how shade() builds the entry point it reads this at. */
  const shadowRT = new THREE.RenderTarget(SHADOW_RES, SHADOW_RES, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  shadowRT.texture.wrapS = shadowRT.texture.wrapT = THREE.ClampToEdgeWrapping;
  const shadowTex = texture(shadowRT.texture);
  const half = sim.extent / 2;
  const shadowCam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 10);
  shadowCam.position.set(0, 5, 0);
  shadowCam.up.set(0, 0, -1);
  shadowCam.lookAt(0, 0, 0);
  const shadowScene = new THREE.Scene();
  shadowScene.add(S.shadowMesh, C.shadowMesh, K.shadowMesh);
  const shadowClear = new THREE.Color();
  // Point the U bag's node at the real target now, while nothing has built: a TextureNode decides its
  // RT handling at build time, so a later .value swap would be read as a plain texture.
  if (U.litterTex) U.litterTex.value = shadowRT.texture;
  disposables.push(shadowRT);

  return {
    sticks: S.mesh,
    cards: C.mesh,
    chunky: K.mesh,
    sinkTray: T.mesh,
    shadowTex,
    shadowRT,
    pools,
    /* Draws the three floating kinds flat into the silhouette target, straight down like the moon at
       zenith; shade() walks its own refracted ray back up to this plane, so no light angle belongs here. */
    renderShadow(renderer) {
      if (!renderer) return;
      const prev = renderer.getRenderTarget();
      // Reads into the scratch and hands it straight back: setClearColor copies, so nothing overwrites it.
      const prevColor = renderer.getClearColor(shadowClear);
      const prevAlpha = renderer.getClearAlpha();
      const prevAutoClear = renderer.autoClear;
      try {
        renderer.setClearColor(0x000000, 1);
        renderer.setRenderTarget(shadowRT);
        renderer.clearColor();   // no depth attachment on this target, so only the color clear is valid
        renderer.autoClear = false;   // the explicit clear above already did it; render() would repeat it
        renderer.render(shadowScene, shadowCam);
      } finally {
        // A throw here must not strand the pond drawing into the silhouette target for the rest of the night.
        renderer.autoClear = prevAutoClear;
        renderer.setRenderTarget(prev);
        renderer.setClearColor(prevColor, prevAlpha);
      }
    },
    /* The ladder's dial on the litter shadow: 0 skips every fetch in shade() outright. */
    setShadow(strength) {
      if (U.litterShadow) U.litterShadow.value = Math.min(1, Math.max(0, strength || 0));
    },
    /* buffers.tray is the one source of truth for the crossing: both cards read the hand-off out of
       these two uniforms, so an over and an under fragment can never be driven by different values. */
    sync() {
      if (tray.pull) tray.pull();
      for (let i = 0; i < TRAY_SLOTS; i++) {
        const u = trayU[i * 4], id = trayU[i * 4 + 3], k = XYZW[i];
        handoffU[k] = Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0;
        handoffId[k] = Number.isFinite(id) && u > 0 ? id : -1;
      }
      for (const a of attrs) a.needsUpdate = true;
    },
    /* Omitted counts reset to full; shadow meshes share geometry, so ladder cuts need one bookkeeper. */
    setCounts(counts = {}) {
      for (const kind of ['sticks', 'cards', 'chunky']) {
        const want = counts[kind];
        const n = Number.isFinite(want) ? Math.min(pools[kind], Math.max(0, Math.floor(want))) : pools[kind];
        byKind[kind].geo.instanceCount = n;
      }
    },
    knobs: {
      sticks: S.knobs, cards: C.knobs, chunky: K.knobs, tray: T.knobs,
      handoff: uHandoffU, handoffId: uHandoffId, dither: uDitherCells, voidSpan: uVoidSpan,
      sway: uSway, litterShadow: U.litterShadow ?? null,
      kindEps: uKindEps, atlasOn: uAtlasOn, atlasGrid: uAtlasGrid, atlasInset: uAtlasInset, atlasBias: uAtlasBias,
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
