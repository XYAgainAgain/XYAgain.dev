import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, texture, uv, vec2, vec3, vec4, float, length, pow, Loop, mix, smoothstep, select } from 'three/tsl';
import { WAKE_RES, INF_SLOTS } from './config.js';
import { capsuleInfluence, closestOnSegment, fbm2 } from './shading.js';
import { createRng, deriveSeed } from './rng.js';

const TAU = 1.2;    // seconds for a wake to fade to 1/e
const GAIN = 3.0;   // push accumulated per second at full capsule strength: a passing body saturates in ~0.3 s
const FINGER_TAU = 7.0;   // the parted line closes slowly enough to write a short word and watch it reform
// Algae relaxation: half a step in ~38 s, so a busy eel route reads thin after a minute of traffic and
// fills back in over about three. Scour is on the target, not the state, so a shove still thins fast.
const ALGAE_TAU = 55.0;
const ALGAE_SCOUR_TAU = 12.0;   // losing cover is quicker than growing it, so a few passes leave a visible route
// A single frame's step at that tau is ~1e-4, under the half-float ulp at 0.5, so a per-frame ease
// would round away to nothing and freeze the field. The cover eases on its own coarse tick instead.
const ALGAE_STEP = 0.5;
const SUB_DISCS = 16;   // substrate the algae clings to: every rock, nearest the middle of the pool first
const SUB_CAPS = 6;     // log trunks first, then whatever branch stubs still fit

/* Short-term memory of who swam where. R, G: signed push, accumulated and clamped so crossing wakes cancel.
   B: the algae cover field. A: the finger alone on its own slower clock, so only a hand parts the duckweed. */
export class WakeBuffer {
  constructor(renderer, U, extent, seed) {
    this.renderer = renderer;
    this.extent = extent;
    const mk = () => {
      const rt = new THREE.RenderTarget(WAKE_RES, WAKE_RES, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      return rt;
    };
    this.rtA = mk();
    this.rtB = mk();
    this.read = texture(this.rtA.texture);
    this.uExtent = uniform(extent);
    this.uDecay = uniform(1);
    this.uGain = uniform(0);
    this.uFingerDecay = uniform(1);
    // The tear is a fingertip, not the pad-shoving capsule: its own radii, far narrower than uPokeV.z.
    this.uFingerR = uniform(new THREE.Vector2(0.04, 0.17));
    // A finger through the water: capsule (ax, az, bx, bz) and (vx, vz, radius, strength), one frame at a time.
    this.uPoke = uniform(new THREE.Vector4(0, 0, 0, 0));
    this.uPokeV = uniform(new THREE.Vector4(0, 0, 0.15, 0));

    // Algae seed: the same FBM the floor will read, offset by the pond seed so a fresh tab has history.
    const rng = createRng(deriveSeed(seed, 1800));
    this.uAlgaeOffset = uniform(new THREE.Vector2(rng.range(0, 100), rng.range(0, 100)));
    this.uAlgaeScale = uniform(0.35);
    this.uAlgaeLo = uniform(0.46);
    this.uAlgaeHi = uniform(0.76);
    this.uAlgaeFloor = uniform(0.04);      // an idle tab neither washes green nor scrubs bare
    this.uAlgaeCeil = uniform(0.92);
    this.uAlgaeStir = uniform(0.45);       // eels distort the noise domain rather than just scouring it
    this.uAlgaeScroll = uniform(new THREE.Vector2(0.004, -0.003));
    this.uAlgaeShadeCut = uniform(0.85);   // no moonlight under pads or mats, so the open water carries the cover
    this.uAlgaeScour = uniform(0.8);
    this.uAlgaeRainCut = uniform(0.3);
    this.uAlgaeRate = uniform(0);
    this.uAlgaeRateDown = uniform(0);
    this.algaeAccum = 0;
    // Substrate: (x, z, radius, 0) discs and (ax, az, bx, bz) + (rOuter, 0, 0, 0) capsules. An empty slot
    // parks at radius -10, far enough negative that its falloff can never reach a texel.
    this.uSubDisc = uniformArray(Array.from({ length: SUB_DISCS }, () => new THREE.Vector4(0, 0, -10, 0)));
    this.uSubCapA = uniformArray(Array.from({ length: SUB_CAPS }, () => new THREE.Vector4()));
    this.uSubCapB = uniformArray(Array.from({ length: SUB_CAPS }, () => new THREE.Vector4(-10, 0, 0, 0)));
    this.uAlgaeCling = uniform(0.8);        // thicker where there is something to hold
    this.uAlgaeClingFloor = uniform(0.40);  // and never bare right up against a rock or a log
    this.uAlgaeClingReach = uniform(1.3);   // world units past the surface that still counts as shelter
    // Anything the algae can hold onto, 1 at the skin and tapering out over the reach. Both loops sit in
    // one Fn so the seed and the update pass can never disagree about where the substrate is.
    const affinityAt = Fn(([p]) => {
      const p3 = vec3(p.x, 0, p.y);
      const aff = float(0).toVar();
      Loop(SUB_DISCS, ({ i }) => {
        const o = this.uSubDisc.element(i);
        aff.addAssign(smoothstep(o.z.add(this.uAlgaeClingReach), o.z.sub(0.1), length(p.sub(o.xy))));
      });
      Loop(SUB_CAPS, ({ i }) => {
        const ab = this.uSubCapA.element(i);
        const r = this.uSubCapB.element(i).x;
        const d = length(p3.sub(closestOnSegment(p3, vec3(ab.x, 0, ab.y), vec3(ab.z, 0, ab.w))));
        aff.addAssign(smoothstep(r.add(this.uAlgaeClingReach), r.sub(0.1), d));
      });
      return aff.min(1);
    });
    // Seed and steady state share one shaping curve, or the field visibly relaxes to a new look on boot.
    const algaeShape = Fn(([q]) => smoothstep(this.uAlgaeLo, this.uAlgaeHi, fbm2(q)));
    const clingShape = Fn(([q, p]) => {
      const aff = affinityAt(p);
      return algaeShape(q).mul(aff.mul(this.uAlgaeCling).add(1)).max(aff.mul(this.uAlgaeClingFloor));
    });
    const seedMat = new THREE.NodeMaterial();
    seedMat.fragmentNode = Fn(() => {
      const p = uv().sub(0.5).mul(this.uExtent);
      const q = p.mul(this.uAlgaeScale).add(this.uAlgaeOffset);
      // Seeded under the same cover the steady state sees, or the first ticks visibly scrub it out from under the pads.
      const shadeG = U.coverTex.sample(p.div(U.maskExtent).add(0.5)).g;
      return vec4(0, 0, clingShape(q, p).mul(shadeG.mul(this.uAlgaeShadeCut).oneMinus()).clamp(this.uAlgaeFloor, this.uAlgaeCeil), 0);
    })();
    seedMat.blending = THREE.NoBlending;
    this.seedMat = seedMat;
    this.seedQuad = new THREE.QuadMesh(seedMat);
    this.seedField();

    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = Fn(() => {
      const c = uv();
      // Same mapping as the sim's obstacle bake: v runs with +z.
      const p = c.sub(0.5).mul(this.uExtent);
      const prev = this.read.sample(c);
      const cur = vec2(0).toVar();
      Loop(INF_SLOTS, ({ i }) => {
        const a = U.infA.element(i), b = U.infB.element(i), v = U.infC.element(i);
        // Evaluated at the surface (y = 0): a deep eel is far from it and writes a faint wake on its own.
        cur.addAssign(capsuleInfluence(vec3(p.x, 0, p.y), a, b, v).mul(b.w));
      });
      const pk = this.uPoke, pv = this.uPokeV;
      const a = vec4(pk.x, 0, pk.y, pv.z), b = vec4(pk.z, 0, pk.w, pv.w);
      cur.addAssign(capsuleInfluence(vec3(p.x, 0, p.y), a, b, vec4(pv.x, 0, pv.y, 0)).mul(pv.w));
      const next = prev.xy.mul(this.uDecay).add(cur.mul(this.uGain)).toVar();
      // Clamp the magnitude, never the components, or diagonal wakes get squared off.
      next.divAssign(length(next).max(1));
      const p3 = vec3(p.x, 0, p.y);
      const fd = length(p3.sub(closestOnSegment(p3, a.xyz, b.xyz)));
      // Latched, not accumulated: a finger crosses a texel in a single frame, so a rate-based gain
      // would never reach the tear threshold at any sane drag speed.
      const fw = smoothstep(this.uFingerR.y, this.uFingerR.x, fd).mul(pv.w.min(1));
      const finger = prev.w.mul(this.uFingerDecay).max(fw);
      // Algae cover: the seeded FBM thickened against the substrate and stirred by the wake, thinned by
      // what floats overhead, by traffic, and by rain, then eased so 30 and 240 fps converge alike.
      const stir = prev.xy.mul(this.uAlgaeStir).mul(U.motionScale);
      const q = p.mul(this.uAlgaeScale).add(this.uAlgaeOffset).add(stir).add(this.uAlgaeScroll.mul(U.time));
      const shadeG = U.coverTex.sample(p.div(U.maskExtent).add(0.5)).g;
      const target = clingShape(q, p)
        .mul(shadeG.mul(this.uAlgaeShadeCut).oneMinus())
        .mul(length(prev.xy).mul(this.uAlgaeScour).oneMinus().clamp(0, 1))
        .mul(U.rainEnv.mul(this.uAlgaeRainCut).oneMinus())
        .clamp(this.uAlgaeFloor, this.uAlgaeCeil);
      const rate = select(target.lessThan(prev.z), this.uAlgaeRateDown, this.uAlgaeRate);
      return vec4(next, mix(prev.z, target, rate), finger);
    })();
    mat.blending = THREE.NoBlending;
    this.quad = new THREE.QuadMesh(mat);

    /* Consumer decode: direction × pow(magnitude, k). Shaping on the magnitude only; a fractional
       power of a signed component is a NaN generator. Each layer picks its own k. */
    this.wakeAt = Fn(([xz, k]) => {
      const m = this.read.sample(xz.div(this.uExtent).add(0.5)).xy;
      const len = length(m);
      return m.div(len.max(1e-5)).mul(pow(len, k));
    });

    this.fingerAt = Fn(([xz]) => this.read.sample(xz.div(this.uExtent).add(0.5)).w);

    this.algaeAt = Fn(([xz]) => this.read.sample(xz.div(this.uExtent).add(0.5)).z);
  }

  swap() {
    const t = this.rtA; this.rtA = this.rtB; this.rtB = t;
    this.read.value = this.rtA.texture;
  }

  /* Both ping-pong targets, so the first update reads a seeded field whichever way the pair is facing. */
  seedField() {
    const r = this.renderer;
    for (const rt of [this.rtA, this.rtB]) { r.setRenderTarget(rt); this.seedQuad.render(r); }
    r.setRenderTarget(null);
  }

  /* What the algae can hold onto, from buildFloor's colliders: every rock as a disc, log trunks then
     branch stubs as capsules. Re-seeds once so a fresh tab opens with cover already on the substrate. */
  setSubstrate(colliders) {
    const spheres = (colliders?.spheres ?? []).slice()
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    const logs = colliders?.logs ?? [];
    const caps = [...logs.filter((l) => l.rInner > 0), ...logs.filter((l) => !(l.rInner > 0))];
    for (let i = 0; i < SUB_DISCS; i++) {
      const o = spheres[i];
      this.uSubDisc.array[i].set(o?.x ?? 0, o?.z ?? 0, o?.r ?? -10, 0);
    }
    for (let i = 0; i < SUB_CAPS; i++) {
      const o = caps[i];
      this.uSubCapA.array[i].set(o?.a.x ?? 0, o?.a.z ?? 0, o?.b.x ?? 0, o?.b.z ?? 0);
      this.uSubCapB.array[i].set(o?.rOuter ?? -10, 0, 0, 0);
    }
    // Only ever the first call: a later re-seed would wipe the live wake and finger channels with it.
    if (this.seedQuad) {
      this.seedField();
      this.seedMat.dispose();
      this.seedQuad = null;
      this.seedMat = null;
    }
  }

  /* Pointer wake for this frame only: a capsule from the last pushed point to the current one, with
     the pointer's velocity so the shove trails the finger the way an eel's wake trails the eel. */
  poke(ax, az, bx, bz, vx, vz, radius = 0.15, strength = 1) {
    this.uPoke.value.set(ax, az, bx, bz);
    this.uPokeV.value.set(vx, vz, radius, strength);
  }

  /* Once per rendered frame, after the influence slots are written and before anything samples it. */
  update(dt) {
    // CPU-computed so the shader never holds an all-literal exp() (Naga rejects those on Firefox).
    this.uDecay.value = Math.exp(-dt / TAU);
    this.uGain.value = dt * GAIN;
    this.uFingerDecay.value = Math.exp(-dt / FINGER_TAU);
    this.algaeAccum += dt;
    const algaeTick = this.algaeAccum >= ALGAE_STEP;
    // The rate carries the whole elapsed span, so the field converges the same at 30 and 240 fps.
    this.uAlgaeRate.value = algaeTick ? 1 - Math.exp(-this.algaeAccum / ALGAE_TAU) : 0;
    this.uAlgaeRateDown.value = algaeTick ? 1 - Math.exp(-this.algaeAccum / ALGAE_SCOUR_TAU) : 0;
    if (algaeTick) this.algaeAccum = 0;
    const r = this.renderer;
    r.setRenderTarget(this.rtB);
    this.quad.render(r);
    this.swap();
    r.setRenderTarget(null);
    this.uPokeV.value.w = 0;
  }

  get texture() { return this.rtA.texture; }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.quad.material.dispose();
    this.seedMat?.dispose();   // still alive if setSubstrate never ran
  }
}
