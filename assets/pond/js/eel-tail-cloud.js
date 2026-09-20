import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, vec2, vec3, vec4, float, mix, asinh, smoothstep, sin, floor, fract,
  positionWorld, exp, dot, step, If, TWO_PI,
} from 'three/tsl';
import { EEL_POINTS, DEPTH } from './config.js';
import { valueNoise2Y, hash2 } from './shading.js';
import {
  PLUME_ORANGE, QUEUE_SLOTS, ROPE_FREE, ROPE_POINTS, cycleColor, dialNum, easeRgb, feedReady, makeQueue,
  makeRope, markFed, plumeSpan, queueMean, queuePush, queueStep, stepRope,
} from './eel-tail-cloud-core.js';

/* Sam's nebula plume: a towed rope of six points, pinned to a skinny part of his tail and to the tip,
   drawn by one flat quad that is only a canvas. Nothing is painted onto geometry that bends, so nothing
   can crinkle; the gas is a field around the rope's centerline, and the tip is inside it by construction. */

// The compose pass multiplies everything underwater by exp(-ABSORB * path), which eats red first; the
// tailTint dial undoes as much of that as the look wants. Same figures surface.js runs.
const ABSORB = [0.22, 0.11, 0.06];
// A park teleports the whole chain. Anything this far in one frame is a jump, not a swim.
const TELEPORT = 1.0;
// Dust reddening: green extinguished 1.35× as hard as red, blue 1.9×, applied once to the summed depth.
const SIGMA = [1.0, 1.35, 1.9];
// The gas lattice repeats over this many cells along the scroll axis and the scroll phase wraps at exactly
// that, so the wrap is silent. Octaves take integer multiples of it for the same reason.
const GAS_PERIOD = 64, WARP_PERIOD = 32;
// One draw's worth of bounding slack past the drawn gas, so a puff never meets the quad's own border.
const QUAD_PAD = 1.25;

const tmpV = new THREE.Vector3(), tmpPiv = new THREE.Vector3();
const rgb = [0, 0, 0];

export function makeTailCloud(e, U, V, ctx) {
  const geo = new THREE.PlaneGeometry(1, 1);

  const ropeArr = [];
  for (let i = 0; i < ROPE_POINTS; i++) ropeArr.push(new THREE.Vector4(i * 0.3, 0, i * 0.3, 0));
  const uRope = uniformArray(ropeArr);            // per point: world x, world z, arc length, spare
  const uTotal = uniform(1);                      // the rope's whole arc length, the plume's own 0-1
  // Plume half width at the base, at its fattest, at the end, then the layers' brightness share: the
  // samples add, so a rung that drops one must not make the plume dimmer.
  const uWidth = uniform(new THREE.Vector4(0.27, 0.62, 0.78, 0.7));
  const uBreath = uniform(1);                     // the resting glow's slow swell, from the CPU
  const uPhase = uniform(0);                      // the gas's own crawl outward, accumulated and wrapped
  const uEvolve = uniform(0);                     // the warp field's drift, same
  const uFlash = uniform(new THREE.Vector2());    // the two glitter layers' flash phases, the second lagged
  const uFlashLarge = uniform(0);                 // accumulated separately so two component wraps cannot flip it
  // Where in the pond the plume's base is, in gas cells: the gas hangs in the water and he drags through it.
  const uWorld = uniform(new THREE.Vector2());
  // The queue: rgb plus its place along the plume, then its band half width, weight, and breakup phase.
  const slotA = [], slotB = [];
  for (let i = 0; i < QUEUE_SLOTS; i++) {
    slotA.push(new THREE.Vector4(...PLUME_ORANGE, 9));
    slotB.push(new THREE.Vector4(0.28, 0, 0, 0));
  }
  const uSlotA = uniformArray(slotA), uSlotB = uniformArray(slotB);

  const m = new THREE.NodeMaterial();
  m.fragmentNode = Fn(() => {
    const heat = e.uSunHeat.clamp(0, 1);
    const P = vec2(positionWorld.x, positionWorld.z).toVar();
    // Nearest point on the rope: a constant-bound walk of the five segments, carrying the arc length and
    // the signed lateral offset of the winner. This is the whole coordinate system the gas lives in.
    const bestD2 = float(1e9).toVar();
    const segD2 = [], segS = [], segSide = [];
    for (let k = 0; k < ROPE_POINTS - 1; k++) {
      const A = uRope.element(k), B = uRope.element(k + 1);
      const ab = vec2(B.x.sub(A.x), B.y.sub(A.y)).toVar();
      const ap = vec2(P.x.sub(A.x), P.y.sub(A.y)).toVar();
      const hh = dot(ap, ab).div(dot(ab, ab).max(1e-8)).clamp(0, 1).toVar();
      const diff = ap.sub(ab.mul(hh)).toVar();
      const d2 = dot(diff, diff).toVar();
      segD2.push(d2);
      segS.push(mix(A.z, B.z, hh).toVar());
      segSide.push(step(0, ab.x.mul(diff.y).sub(ab.y.mul(diff.x))).mul(2).sub(1).toVar());
      bestD2.assign(bestD2.min(d2));
    }
    // A polyline's nearest-point frame kinks at every joint, and the gas drawn in it creases there. Each
    // segment's frame is blended by how close it is instead, which is smooth across the joint; only the
    // nearest segment carries any weight more than a blend width away from one.
    const maxW = uWidth.x.max(uWidth.y).max(uWidth.z);
    const out = vec3(0).toVar();
    If(bestD2.lessThan(maxW.mul(maxW)), () => {
    const kk = V.tailJointBlend.clamp(0.02, 2).toVar();
    const bestS = float(0).toVar(), side = float(0).toVar(), wSum = float(0).toVar();
    for (let k = 0; k < ROPE_POINTS - 1; k++) {
      // The exponent is a non-positive number by construction; clamping it says so to the compiler and
      // makes an overflow to Inf, which would take the whole frame to NaN, impossible.
      const wk = exp(bestD2.sub(segD2[k]).div(kk.mul(kk)).clamp(-60, 0)).toVar();
      wSum.addAssign(wk);
      bestS.addAssign(segS[k].mul(wk));
      side.addAssign(segSide[k].mul(wk));
    }
    bestS.divAssign(wSum.max(1e-5));
    side.divAssign(wSum.max(1e-5));
    const dist = bestD2.max(1e-12).sqrt().toVar();
    const t = bestS.div(uTotal.max(1e-3)).clamp(0, 1).toVar();
    // One body-width at the base, swelling fast to its fattest, then only a gentle flare. tailSwell is
    // held off both ends: a smoothstep with equal edges is undefined in WGSL and GLSL alike.
    const sw = V.tailSwell.clamp(0.05, 0.95);
    const w = mix(uWidth.x, uWidth.y, smoothstep(0, sw, t))
      .add(uWidth.z.sub(uWidth.y).mul(smoothstep(sw, 1.0, t))).max(1e-3).toVar();
    // The long terminal fade begins before the last rope segment, so neither noise nor the quad can expose
    // a flat end. The radial smoothstep gives faint outskirts instead of a cutout silhouette.
    const ratio = dist.div(w).toVar();
    const across = smoothstep(0, 1, ratio).oneMinus();
    const env = smoothstep(0, V.tailRise.clamp(0.02, 0.6), t)
      .mul(smoothstep(V.tailFall.clamp(0.3, 0.9), 1.0, t).oneMinus().pow(V.tailEndPow.max(0.1)))
      .mul(across).toVar();
    If(env.greaterThan(0.004), () => {
      // Pond units on both axes, in the rope's own frame, shifted by where in the water he is. That shift
      // is what drags him through gas that hangs in the pond; blending the two frames per fragment instead
      // smears the field into lengthwise lanes whenever the rope happens to lie along a world axis.
      const co = vec2(dist.mul(side), bestS).mul(V.tailFreq).add(uWorld).toVar();
      const q = vec2(co.x, co.y.div(V.tailStretch.max(0.2)).sub(uPhase)).toVar();
      // The warp field carries no scroll of its own, only its slow drift, so it shears against the gas
      // rather than sliding with it. Its period and its drift's wrap are the same number.
      const qw = co.mul(V.tailWarpF.clamp(0.05, 4)).toVar();
      const w1 = valueNoise2Y(vec2(qw.x, qw.y.add(uEvolve)), float(WARP_PERIOD)).toVar();
      const w2 = valueNoise2Y(vec2(qw.y.mul(0.73).add(19.1), qw.x.mul(-0.73).add(uEvolve).add(7.4)),
        float(WARP_PERIOD)).toVar();
      const wx = w1.sub(0.5).mul(V.tailWarp).mul(2).toVar();
      const wy = w2.sub(0.5).mul(V.tailWarp).mul(2).toVar();
      const q2 = vec2(q.x.add(wx.mul(-1.3)).add(wy.mul(0.4)),
        q.y.add(wy).add(wx.mul(0.35))).toVar();
      // Every octave is an integer multiple of the base, so one wrap length serves all of them.
      const f = valueNoise2Y(q2, float(GAS_PERIOD)).mul(0.62)
        .add(valueNoise2Y(q2.mul(2).add(11.7), float(GAS_PERIOD * 2)).mul(0.38)).toVar();
      If(V.tailOct.greaterThan(2.5), () => {
        f.addAssign(valueNoise2Y(q2.mul(4).add(29.1), float(GAS_PERIOD * 4)).sub(0.5).mul(0.2));
      });
      // Emission follows the whole smooth density field. A small floor keeps the cloud connected while the
      // broad warp still opens dim channels between bright cores.
      const dpow = V.tailDensPow.max(0.1).toVar();
      const densFloor = V.tailDensFloor.clamp(0, 0.5).toVar();
      const dens = f.max(0).add(densFloor).div(densFloor.add(1)).pow(dpow).toVar();
      // One more gas fetch, at twice the scale and a coordinate pushed further toward the world's frame,
      // so the two layers never agree.
      If(V.tailSheets.greaterThan(2.5), () => {
        const qd = q2.add(uWorld.mul(0.55));
        const f2 = valueNoise2Y(qd.mul(2).add(71.3), float(GAS_PERIOD * 2));
        dens.addAssign(f2.max(0).add(densFloor).div(densFloor.add(1)).pow(dpow)
          .mul(V.tailDepth.max(0)));
      });
      // The same two warp fetches make a band arrive through gas-shaped pockets. Its front wanders farther
      // than one slot width, then the pockets grow together as the slot gains weight.
      const colorT = t.add(w1.sub(0.5).add(w2.sub(0.5).mul(0.7)).mul(V.tailColorWarp))
        .add(side.mul(ratio).mul(w2.mul(0.7).add(0.3)).mul(V.tailColorSide)).toVar();
      // Where a queued color has soaked in: it rides the gas's own density, so ink and gas are one
      // substance rather than a separately patterned overlay.
      const soak = f.clamp(0, 1).mul(0.5).toVar();
      const house = V.tailHouse.max(1e-3).toVar();
      const col = vec3(...PLUME_ORANGE).mul(house).toVar(), sum = house.toVar();
      const soften = V.tailSeepSoft.max(0.05).toVar();
      const seepHi = V.tailSeepHi.max(V.tailSeepLo.add(0.05)).toVar();
      for (let i = 0; i < QUEUE_SLOTS; i++) {
        const S = uSlotA.element(i), T = uSlotB.element(i);
        const edge = T.x.max(0.02).toVar(), soft = V.tailBandSoft.max(0.01).toVar();
        const band = smoothstep(edge, edge.add(soft), colorT.sub(S.w).abs()).oneMinus();
        // Each slot leans on a different blend of the two warp fields, so no two arrive in the same
        // pockets; the seed can only lean the blend, never break the field.
        const pocket = soak.add(mix(w1, w2, sin(T.z).mul(0.5).add(0.5)).mul(0.5)).toVar();
        // Scattered wisps first, merging as the slot gains weight. The transition is a whole puff wide,
        // which is what lets two hues share a gradient rather than meet at an edge.
        const seepAt = mix(seepHi, V.tailSeepLo, T.y).toVar();
        const seep = smoothstep(seepAt, seepAt.add(soften), pocket);
        const g = band.mul(seep).mul(T.y).pow(V.tailBandPow.max(0.1)).toVar();
        sum.addAssign(g);
        col.addAssign(S.xyz.mul(g));
      }
      col.divAssign(sum.max(1e-4));
      // Lean an overlap toward its own hues instead of the grey their average makes, then hand back the
      // brightness the subtraction took: a mixed pocket should read richer, not darker.
      const rich = V.tailMixRich.clamp(0, 0.95).toVar();
      const peak = col.r.max(col.g).max(col.b).max(1e-4).toVar();
      col.subAssign(vec3(col.r.min(col.g).min(col.b)).mul(rich));
      col.mulAssign(peak.div(col.r.max(col.g).max(col.b).max(1e-4)));
      // Dust as optical depth, exponentiated once so the reddening is a real extinction rather than a grey
      // multiply; it rides the warp field already in hand, so turning it up costs nothing new.
      const tau = smoothstep(V.tailDustLo, V.tailDustHi.max(V.tailDustLo.add(1e-3)), w1).mul(V.tailDust);
      const depthFrac = positionWorld.y.negate().div(DEPTH).clamp(0, 1);
      const comp = exp(vec3(...ABSORB).mul(depthFrac).mul(DEPTH));
      const coreWidth = V.tailCoreWidth.clamp(0.05, 0.95);
      // A gaussian across the plume, never a gated strip: an 0.08-wide gate drew a hard bright ribbon
      // down the whole centerline.
      const coreAcross = ratio.div(coreWidth).pow(2).negate().exp();
      const coreEnd = V.tailCoreEnd.clamp(0.1, 0.9);
      const coreLength = smoothstep(0, V.tailCoreRise.clamp(0.01, 0.4), t)
        .mul(smoothstep(coreEnd, 1, t).oneMinus());
      const core = coreAcross.mul(coreLength).mul(V.tailCoreGain.max(0));
      const shade = dens.mul(env).mul(exp(vec3(...SIGMA).negate().mul(tau)))
        .mul(mix(V.tailSleep.mul(uBreath), float(1), heat)).mul(V.tailGain).mul(uWidth.w)
        .mul(mix(vec3(1), comp, V.tailTint)).mul(core.add(1)).toVar();
      const lit = col.mul(shade).toVar();
      // GLITTER SEAM: foil flecks in the rope's own coordinates, so they ride the plume rather than the
      // water. Masked by the gas so none floats in clear water, tinted by whatever color it sits in.
      If(V.tailGlit.greaterThan(0), () => {
        const cell = V.tailGlitCell.max(1e-3).toVar();
        const sharp = V.tailGlitSharp.max(1).toVar();
        const dens0 = V.tailGlitDens.clamp(0, 1).oneMinus().toVar();
        const fleck = (size, phase, star = false) => {
          // Biased well positive before the hash: a cell index either side of the centerline is negative.
          const gc = vec2(dist.mul(side), bestS).div(size).toVar();
          const id = floor(gc).add(512.5).toVar();
          const h1 = hash2(id).toVar(), h2 = hash2(id.add(vec2(7.3, 3.1))).toVar();
          const h3 = hash2(id.add(vec2(1.7, 9.2))).toVar();
          const local = fract(gc).sub(0.5).sub(vec2(h2.sub(0.5), h3.sub(0.5)).mul(0.3)).toVar();
          const diamond = smoothstep(0.05, 0.26, local.x.abs().add(local.y.abs())).oneMinus();
          const shape = star
            ? diamond.max(smoothstep(0.018, 0.09, local.x.abs().min(local.y.abs())).oneMinus()
              .mul(smoothstep(0.12, 0.48, local.x.abs().max(local.y.abs())).oneMinus()))
            : diamond;
          const flash = sin(phase.add(h2.mul(TWO_PI))).mul(0.5).add(0.5).pow(sharp).toVar();
          return { lit: shape.mul(step(dens0, h1)).mul(flash), flash };
        };
        const a = fleck(cell, uFlash.x);
        const glit = mix(col, vec3(1), a.flash.mul(V.tailGlitWhite.clamp(0, 1))).mul(a.lit).toVar();
        If(V.tailSheets.greaterThan(2.5), () => {
          const b = fleck(cell.mul(V.tailGlitDeepScale.max(1.05)), uFlash.y);
          const c = fleck(cell.mul(V.tailGlitLargeScale.max(2)), uFlashLarge, true);
          glit.addAssign(mix(col, vec3(1), b.flash.mul(V.tailGlitWhite.clamp(0, 1)))
            .mul(b.lit).mul(V.tailGlitDeep.max(0)));
          glit.addAssign(mix(col, vec3(1), c.flash.mul(V.tailGlitWhite.clamp(0, 1)))
            .mul(c.lit).mul(V.tailGlitLarge.max(0)));
        });
        lit.addAssign(glit.mul(shade).mul(V.tailGlit));
      });
      // One ratio for all three channels: tone-mapping them apart is what turns overlapping additive puffs
      // pastel-white instead of letting them saturate toward their own hue. Compressive only, because an
      // asinh stretch below unit luminance is an expansion, and it lifted the thin far end to near-white.
      const lum = lit.r.max(lit.g).max(lit.b).max(1e-5).toVar();
      const k = V.tailStretchK.max(0.1);
      out.assign(lit.mul(asinh(lum.mul(k)).div(asinh(k)).div(lum).min(1)));
    });
    });
    return vec4(out, 0);
  })();
  // Additive with the destination alpha left alone: that alpha is scene depth for the compose pass.
  m.transparent = true;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;

  const mesh = new THREE.Mesh(geo, m);
  mesh.rotation.x = -Math.PI / 2;        // the camera is straight down, so the quad lies in the pond plane
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.visible = false;
  ctx.group.add(mesh);

  const rope = makeRope();
  const queue = makeQueue();
  const smoothedLight = PLUME_ORANGE.slice();
  const prevTip = new THREE.Vector3();
  // Scratch reused every frame: the span and the anchor, plus the rope's config object.
  const span = { back: 0.8, fore: 1.4, total: 2.2, from: 21 };
  const cfg = { bend: 0.7, kink: 0.55, smooth: 0.45, lag: 0.35, grade: 0.8, endScale: 1.65 };
  const colorCfg = { sat: 0.72, lum: 0.78, grey: 0.18 };
  const anchor = new THREE.Vector3();
  let primed = false, breathT = 0, lagSpeed = 0;

  /* One pickup pass over the cast, on the frame clock: anybody who brings a head within tailNear body
     widths of his leaves two stops of their own ramp in the queue, then goes on cooldown. */
  function pickups(cast, now, near, cool) {
    if (!cast) return;
    const reach = e.radius * 2 * near;
    const head = e.show[0];
    for (const o of cast) {
      if (o === e || !o.body?.visible || !o.show || !o.rampHead || !o.rampTail) continue;
      if (head.distanceToSquared(o.show[0]) > reach * reach) continue;
      if (!feedReady(queue, o, now, cool)) continue;
      markFed(queue, o, now);
      queuePush(queue, o.rampHead.r, o.rampHead.g, o.rampHead.b, colorCfg);
      queuePush(queue, o.rampTail.r, o.rampTail.g, o.rampTail.b, colorCfg);
      queue.quiet = 0;
    }
  }

  /* The other two feeders. Awake and moving with nothing fed lately he walks the nebula cycle; asleep he
     is steady orange with one color dripping in every minute or so. Its own timer off a hash of its own
     counter, never a simulation roll: the determinism trace must not be able to see this. */
  function feeders(dt, heat, moving, idle, dripMin, dripMax) {
    queue.quiet += dt;
    if (heat > 0.5) {
      if (!moving || queue.quiet < idle) return;
      queue.quiet = 0;
      cycleColor(queue.cycle++, rgb);
      queuePush(queue, rgb[0], rgb[1], rgb[2], colorCfg);
      return;
    }
    queue.drip -= dt;
    if (queue.drip > 0) return;
    const hi = Math.max(dripMin, dripMax);
    const r = Math.abs((Math.sin(queue.cycle * 12.9898) * 43758.5453) % 1);
    queue.drip = dripMin + (hi - dripMin) * r;
    cycleColor(queue.cycle++, rgb);
    queuePush(queue, rgb[0], rgb[1], rgb[2]);
  }

  return {
    mesh, rope, queue,
    // The plume's own light for the sand capsule eases toward the queue mean instead of popping on a push.
    light: smoothedLight,
    show(on) {
      mesh.visible = on;
      // Coming back from a park must never inherit a mid-whip rope or a stale anchor.
      if (!on) { rope.primed = false; primed = false; }
    },
    /* Everything on the frame clock: the anchor, the rope, the gas and glitter phases, and the color
       queue. `heat` is 0 asleep, which drops the gain to the sleeping one and slows the breath. */
    sync(dt, heat, cast) {
      // A tab that slept hands back a dt worth a whole second of rope in one step. Reduced motion parks
      // the plume and its queue; only the pickup cooldowns keep wall-clock time.
      const h = Math.min(1 / 30, Math.max(0, dt));
      const hm = h * U.motionScale.value;
      breathT += hm;
      // Every taste dial normalized once, here: a junk value snaps back instead of reaching a uniform.
      const back = dialNum(V.tailBack, 0.02, 0.5, 0.08);
      const past = dialNum(V.tailPast, 0.02, 0.9, 0.14);
      cfg.bend = dialNum(V.tailRopeBend, 0, 1, 0.7);
      cfg.kink = dialNum(V.tailRopeKink, 0.05, 1.4, 0.55);
      cfg.smooth = dialNum(V.tailRopeSmooth, 0.01, 8, 0.6);
      cfg.lag = dialNum(V.tailRopeLag, 0.01, 8, 0.55);
      cfg.grade = dialNum(V.tailRopeGrade, 0, 6, 1.0);
      cfg.endScale = dialNum(V.tailEndSeg, 1, 3, 1.65);
      colorCfg.sat = dialNum(V.tailColorSat, 0, 1, 0.72);
      colorCfg.lum = dialNum(V.tailColorLum, 0.05, 1, 0.78);
      colorCfg.grey = dialNum(V.tailColorGrey, 0, 0.95, 0.18);
      const anchorTau = dialNum(V.tailAnchor, 0.01, 2, 0.1);
      const layers = Math.round(dialNum(V.tailSheets, 1, 3, 3)) > 2 ? 2 : 1;
      for (const [d, lo, hi, df] of GPU_BOUNDS) dialNum(V[d], lo, hi, df);

      plumeSpan(e.length, EEL_POINTS, back, past, span);
      const tip = e.show[EEL_POINTS - 1];
      tmpPiv.copy(e.show[Math.min(EEL_POINTS - 1, Math.round(span.from))]);
      if (!primed) { prevTip.copy(tip); anchor.copy(tmpPiv); primed = true; }
      tmpV.subVectors(tip, prevTip);
      const jumped = tmpV.lengthSq() > TELEPORT * TELEPORT;
      if (jumped) { anchor.copy(tmpPiv); rope.primed = false; }
      prevTip.copy(tip);
      // Smoothed just enough that one frame of solver jitter cannot shimmy the whole plume sideways.
      anchor.lerp(tmpPiv, 1 - Math.exp(-hm / anchorTau));
      stepRope(rope, hm, anchor, tip, span.fore / ROPE_FREE, cfg);

      const w0 = e.radius * V.tailW0.value, w1 = e.radius * V.tailW1.value, w2 = e.radius * V.tailW2.value;
      const wMax = Math.max(w0, w1, w2);
      const total = rope.s[ROPE_POINTS - 1];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sumY = 0;
      for (let i = 0; i < ROPE_POINTS; i++) {
        const j = i * 3;
        uRope.array[i].set(rope.p[j], rope.p[j + 2], rope.s[i], 0);
        minX = Math.min(minX, rope.p[j]); maxX = Math.max(maxX, rope.p[j]);
        minZ = Math.min(minZ, rope.p[j + 2]); maxZ = Math.max(maxZ, rope.p[j + 2]);
        sumY += rope.p[j + 1];
      }
      const pad = wMax * QUAD_PAD;
      mesh.position.set((minX + maxX) * 0.5, sumY / ROPE_POINTS + e.radius * V.tailLift.value,
        (minZ + maxZ) * 0.5);
      mesh.scale.set(maxX - minX + pad * 2, maxZ - minZ + pad * 2, 1);
      uTotal.value = Math.max(1e-3, total);
      const world = V.tailWorld.value * V.tailFreq.value;
      uWorld.value.set(anchor.x * world, anchor.z * world);
      uWidth.value.set(w0, w1, w2, 1 / Math.sqrt(layers));

      const wag = Math.min(1, e.tailSpeed ?? 0);
      // Accumulated, never clock * rate: multiplying a live rate by the clock jumps the whole field every
      // time his tail changes speed. Each wrap is an exact period of the noise it feeds.
      const flow = V.tailFlow.value + wag * V.tailSwing.value * heat;
      uPhase.value = (uPhase.value + flow * hm) % GAS_PERIOD;
      uEvolve.value = (uEvolve.value + V.tailEvolve.value * hm) % WARP_PERIOD;
      // The flash rides his own motion; the second layer rides a lagged copy of it, which is what makes
      // the two sheets of foil swim past each other like the liquid in a water wiggler.
      const rate = dialNum(V.tailGlitRate, 0, 20, 0.35);
      const motion = dialNum(V.tailGlitMotion, 0, 20, 1.3);
      lagSpeed += (wag - lagSpeed) * (1 - Math.exp(-hm / 0.35));
      const flashA = (rate + wag * motion) * hm * TWO_PI_JS;
      const flashB = (rate + lagSpeed * motion) * 0.6 * hm * TWO_PI_JS;
      uFlash.value.set((uFlash.value.x + flashA) % TWO_PI_JS, (uFlash.value.y + flashB) % TWO_PI_JS);
      uFlashLarge.value = (uFlashLarge.value + (flashA + flashB) * 0.5) % TWO_PI_JS;
      uBreath.value = 1 + V.tailBreath.value
        * Math.sin(breathT * Math.PI * 2 / Math.max(1, V.tailBreathPeriod.value));

      queueStep(queue, hm, dialNum(V.tailLife, 1, 900, 150), dialNum(V.tailRetire, 0.05, 8, 1.5));
      if (hm > 0 && !jumped) {
        pickups(cast, performance.now() * 0.001, dialNum(V.tailNear, 0.1, 8, 1), dialNum(V.tailCool, 0, 600, 90));
        feeders(hm, heat, wag > 0.04 || (e.speedBL ?? 0) > 0.05, dialNum(V.tailIdle, 0.5, 600, 45),
          dialNum(V.tailDripMin, 1, 600, 90), dialNum(V.tailDripMax, 1, 900, 180));
      }
      const band = dialNum(V.tailBand, 0.02, 1, 0.22);
      for (let i = 0; i < QUEUE_SLOTS; i++) {
        const s = queue.slots[i];
        uSlotA.array[i].set(s.r, s.g, s.b, s.pos);
        uSlotB.array[i].set(band, s.w, s.seed, 0);
      }
      queueMean(queue, queue.mean, V.tailHouse.value);
      easeRgb(smoothedLight, queue.mean, hm, dialNum(V.tailGlowEase, 0.05, 12, 2));
    },
    /* Where the plume's own light sits: the rope's base out to its second-to-last point, so the lit sand
       follows the gas round a turn instead of pointing where his tail used to go. */
    capsule(out) {
      const j = (ROPE_POINTS - 2) * 3;
      out.a.set(rope.p[0], rope.p[1], rope.p[2]);
      out.b.set(rope.p[j], rope.p[j + 1], rope.p[j + 2]);
      return out;
    },
    // The hand door into the queue, for driving it from the console: cloud.push(r, g, b).
    push(r, g, b) { queue.quiet = 0; return queuePush(queue, r, g, b, colorCfg); },
    dispose() { ctx.group.remove(mesh); geo.dispose(); m.dispose(); },
  };
}

const TWO_PI_JS = Math.PI * 2;
// The dials the shader reads straight off a uniform, with the range each one is defined over. Normalizing
// them on the CPU is cheaper and safer than proving every expression downstream survives a NaN.
const GPU_BOUNDS = [
  ['tailW0', 0.05, 12, 1.0], ['tailW1', 0.05, 12, 2.6], ['tailW2', 0.05, 12, 3.4],
  ['tailSwell', 0.05, 0.95, 0.42], ['tailRise', 0.02, 0.6, 0.1], ['tailFall', 0.3, 0.9, 0.52],
  ['tailEndPow', 0.1, 6, 1.05], ['tailLift', -4, 4, 0.6], ['tailOct', 1, 4, 3],
  ['tailCoreGain', 0, 4, 0.95], ['tailCoreWidth', 0.05, 0.95, 0.42],
  ['tailCoreRise', 0.01, 0.4, 0.07], ['tailCoreEnd', 0.1, 0.9, 0.68],
  ['tailJointBlend', 0.02, 2, 0.22],
  ['tailFreq', 0.2, 12, 2.6], ['tailStretch', 0.2, 8, 2], ['tailWarp', 0, 4, 1.35],
  ['tailWarpF', 0.05, 4, 0.38], ['tailFlow', 0, 8, 0.1], ['tailSwing', 0, 8, 0.22],
  ['tailEvolve', 0, 4, 0.04], ['tailWorld', 0, 1, 0.12],
  ['tailColorWarp', 0, 2, 0.62], ['tailColorSide', 0, 2, 0.48],
  ['tailSeepLo', 0, 0.95, 0.34], ['tailSeepHi', 0.05, 1, 0.78],
  ['tailSeepSoft', 0.05, 1, 0.22], ['tailBandSoft', 0.01, 1, 0.3], ['tailMixRich', 0, 0.95, 0.7],
  ['tailDensPow', 0.1, 6, 2], ['tailDensFloor', 0, 0.5, 0.015], ['tailDepth', 0, 3, 0.5],
  ['tailDust', 0, 4, 0.55], ['tailDustLo', 0, 1, 0.42], ['tailDustHi', 0, 1, 0.72],
  ['tailGain', 0, 6, 1.35], ['tailSleep', 0, 3, 0.45], ['tailTint', 0, 1, 0.65],
  ['tailStretchK', 0.1, 60, 10], ['tailBandPow', 0.1, 8, 2.0],
  ['tailHouse', 0.001, 2, 0.12], ['tailBreath', 0, 2, 0.45], ['tailBreathPeriod', 1, 60, 7],
  ['tailGlit', 0, 6, 2.2], ['tailGlitDens', 0, 1, 0.22], ['tailGlitCell', 0.005, 2, 0.035],
  ['tailGlitSharp', 1, 64, 9], ['tailGlitWhite', 0, 1, 0.48], ['tailGlitDeep', 0, 4, 0.8],
  ['tailGlitDeepScale', 1.05, 6, 1.8], ['tailGlitLarge', 0, 4, 0.65],
  ['tailGlitLargeScale', 2, 12, 4.2],
];
