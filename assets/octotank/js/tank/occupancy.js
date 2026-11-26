import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, positionWorld, vec2, vec3, vec4, float, If, select, mix, smoothstep } from 'three/tsl';
import { TANK } from '../config.js';
import { section } from '../diag/panel.js';
import { OCCUPANCY_KNOBS, CONTACT_SHAPE, ROOF_MARGIN, occupancySize, bakeRoofs } from './occupancy-core.js';

// A dedicated render layer, so the capture draws only her and the toys.
export const OCCUPANCY_LAYER = 5;

/* Contact shadows: her and the toys drawn from below into a small map of their lowest surface over the floor (R coverage,
   G height × coverage, so filtering at an edge still averages heights), read back by receivers as contactAt(world). */
export class Occupancy {
  constructor(renderer, scene, knobs = {}, { rock = null } = {}) {
    Object.assign(this, { renderer, scene });
    this.knobs = { ...OCCUPANCY_KNOBS, ...knobs };
    const size = occupancySize(this.knobs.resolution, TANK.w, TANK.d);
    this.target = new THREE.RenderTarget(size.width, size.height, { type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: false });
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.LinearFilter;
    this.last = -Infinity; this.wall = -Infinity; this.captures = 0;
    this.saved = { color: new THREE.Color(), viewport: new THREE.Vector4(), scissor: new THREE.Vector4() };

    const camera = this.camera = new THREE.OrthographicCamera(-TANK.w / 2, TANK.w / 2, TANK.d / 2, -TANK.d / 2, 0.01, TANK.h + 0.3);
    camera.position.set(0, -0.1, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 1, 0);
    camera.layers.set(OCCUPANCY_LAYER);
    camera.coordinateSystem = renderer.coordinateSystem;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    // Texture space from world space the way wall-optics.js maps its pane, which samples right on both backends.
    this.matrix = uniform(new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, -0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse));

    // Her mantle is double-sided, so the override is too; nearest from below wins the depth test.
    this.material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    this.material.colorNode = vec3(1, positionWorld.y, 0);

    const u = this.u = {
      strength: uniform(0), direct: uniform(0), fade: uniform(1), sunkLo: uniform(-0.03), sunkHi: uniform(-0.01),
      near: uniform(0), far: uniform(0), rise: uniform(1), outside: uniform(0), taps: uniform(5), on: uniform(0), roofs: uniform(0),
    };
    this.map = texture(this.target.texture);
    const tap = (coord) => this.map.sample(coord).level(float(0));
    const falloff = (gap) => {
      const above = float(1).sub(gap.div(u.fade).clamp(0, 1));
      return select(gap.greaterThanEqual(0), above.mul(above), smoothstep(u.sunkLo, u.sunkHi, gap));
    };
    const coordOf = (world) => this.matrix.mul(vec4(world.xyz, 1)).xy;
    // The rock field's columns, nearest-filtered: RGBA the lowest four overhang undersides, ROOF_NONE when unused.
    if (rock) {
      const baked = bakeRoofs(rock), half = THREE.DataUtils.toHalfFloat, data = Uint16Array.from(baked.roofs, (v) => half(v));
      this.roofTexture = new THREE.DataTexture(data, baked.nx, baked.nz, THREE.RGBAFormat, THREE.HalfFloatType);
      this.roofTexture.minFilter = this.roofTexture.magFilter = THREE.NearestFilter;
      this.roofTexture.generateMipmaps = false; this.roofTexture.needsUpdate = true;
      const scale = vec2(1 / (baked.h * baked.nx), 1 / (baked.h * baked.nz)), offset = vec2((0.5 - baked.x0 / baked.h) / baked.nx, (0.5 - baked.z0 / baked.h) / baked.nz);
      this.roofAt = (xz) => texture(this.roofTexture).sample(xz.mul(scale).add(offset)).level(float(0));
    }
    // Each tap's coverage times its falloff; G / R is guarded, since an uncovered texel has R = 0. An overhang in the
    // tap's column between the receiver and the tap's caster zeroes the tap.
    const occlusion = (xz, y, s = tap(coordOf(vec3(xz.x, y, xz.y)))) => {
      const height = s.g.div(s.r.max(1e-4)), shade = s.r.clamp(0, 1).mul(falloff(height.sub(y)));
      if (!this.roofAt) return shade;
      const roof = this.roofAt(xz), under = (r) => y.lessThan(r.add(ROOF_MARGIN)).and(height.greaterThan(r.add(ROOF_MARGIN)));
      return select(u.roofs.greaterThan(0.5).and(under(roof.x).or(under(roof.y)).or(under(roof.z)).or(under(roof.w))), float(0), shade);
    };

    /* 1 where nothing of hers is near above, toward 1 − strength in full contact. */
    this.contactAt = Fn(([world]) => {
      const result = float(1).toVar();
      // A uniform branch, so switched off the receivers skip every tap instead of zeroing them.
      If(u.on.greaterThan(0.5), () => {
        const xz = world.xz.toVar(), y = world.y.toVar(), center = tap(coordOf(world)).toVar();
        const cover = center.r.clamp(0, 1);
        const gap = center.g.div(center.r.max(1e-4)).sub(y);
        const radius = mix(u.outside, mix(u.near, u.far, gap.div(u.rise).clamp(0, 1)), cover).toVar();
        const sum = occlusion(xz, y, center).toVar();
        If(u.taps.greaterThan(1.5), () => {
          sum.assign(sum.add(occlusion(xz.add(vec2(radius, 0)), y)).add(occlusion(xz.sub(vec2(radius, 0)), y))
            .add(occlusion(xz.add(vec2(0, radius)), y)).add(occlusion(xz.sub(vec2(0, radius)), y)).div(5));
        });
        result.assign(float(1).sub(sum.mul(u.strength)));
      });
      return result;
    });
    /* Plain vertical coverage, 0–1, for a receiver that wants her footprint without the gap. */
    this.coverAt = Fn(([world]) => tap(coordOf(world)).r.clamp(0, 1).mul(u.on));
    /* The share of a contact factor that reaches the direct light too (contactDirect). */
    this.directOf = (contact) => mix(float(1), contact, u.direct);
    this.sync();
    this.installControls();
  }

  /* Puts a mesh in the capture and keeps its own materials from receiving: a caster could only ever shadow itself. */
  registerCaster(mesh) {
    if (!mesh) return mesh;
    mesh.layers.enable(OCCUPANCY_LAYER);
    mesh.userData.noContact = true;
    return mesh;
  }

  sync() {
    const k = this.knobs, u = this.u, s = CONTACT_SHAPE, on = !!k.enabled, unit = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
    u.strength.value = on ? unit(k.strength) : 0;
    u.direct.value = on ? unit(k.contactDirect) : 0;
    u.on.value = on ? 1 : 0;
    u.fade.value = Number.isFinite(k.fade) ? Math.max(1e-3, k.fade) : OCCUPANCY_KNOBS.fade;
    u.sunkLo.value = -s.sunk; u.sunkHi.value = -s.sunk / 3;
    u.near.value = s.near; u.far.value = s.far; u.rise.value = s.rise; u.outside.value = s.outside;
    u.taps.value = k.taps > 1 ? 5 : 1;
    u.roofs.value = k.rockRoofs ? 1 : 0;
    if (on && !this.wasOn) this.last = -Infinity;
    this.wasOn = on;
    if (k.resolution === this.resolution) return;
    const size = occupancySize(k.resolution, TANK.w, TANK.d);
    this.resolution = k.resolution;
    if (this.target.width !== size.width || this.target.height !== size.height) { this.target.setSize(size.width, size.height); this.last = -Infinity; }
  }

  /* Draws the map; call once per drawn frame before any capture that renders the receivers. `moved` false (nothing of
     hers or the toys' changed since the last capture) keeps the map that is already there. */
  capture(time, moved = true) {
    this.sync();
    const k = this.knobs;
    if (!k.enabled) return false;
    // A move the rate limit holds back stays owed, so the map can't freeze on a pose she has since left.
    this.pending ||= moved;
    if (!this.pending && Number.isFinite(this.last)) return false;
    // Held only while the wall clock is inside the period too: sim time freezes while paused, and a paused edit has to land.
    const wall = performance.now() / 1000, period = 1 / k.hz;
    if (k.hz > 0 && Number.isFinite(this.last) && time >= this.last && time - this.last + 1e-8 < period && wall - this.wall < period) return false;
    const r = this.renderer, scene = this.scene, s = this.saved;
    s.target = r.getRenderTarget(); s.autoClear = r.autoClear; s.alpha = r.getClearAlpha(); s.scissorTest = r.getScissorTest();
    r.getClearColor(s.color); r.getViewport(s.viewport); r.getScissor(s.scissor);
    s.background = scene.background; s.backgroundNode = scene.backgroundNode ?? null; s.override = scene.overrideMaterial;
    try {
      scene.background = null; scene.backgroundNode = null; scene.overrideMaterial = this.material;
      r.setRenderTarget(this.target); r.setClearColor(0x000000, 0); r.autoClear = true;
      r.render(scene, this.camera);
      this.last = time; this.wall = wall; this.captures++; this.pending = false;
    } finally {
      scene.background = s.background; scene.backgroundNode = s.backgroundNode; scene.overrideMaterial = s.override;
      r.setRenderTarget(s.target); r.setClearColor(s.color, s.alpha); r.autoClear = s.autoClear;
      r.setViewport(s.viewport); r.setScissor(s.scissor); r.setScissorTest(s.scissorTest);
    }
    return true;
  }

  installControls() {
    const k = this.knobs, set = (key) => (value) => { k[key] = value; this.sync(); };
    this.actions = [
      { name: 'Contact shadows', label: () => `Contact shadows: ${k.enabled ? 'on' : 'off'}`, run: () => { k.enabled = !k.enabled; this.last = -Infinity; this.sync(); } },
      ...[
        ['Contact resolution', 'resolution', [128, 256, 512, 1024], (v) => `${v} × ${v / 2}`],
        ['Contact taps', 'taps', [1, 5], (v) => `${v}`],
        ['Contact rate', 'hz', [15, 30, 0], (v) => (v ? `${v} Hz` : 'every tick')],
        ['Contact strength', 'strength', [0, 0.25, 0.5, 0.75, 1], (v) => `${Math.round(v * 100)}%`],
        ['Contact on direct light', 'contactDirect', [0, 0.1, 0.25, 0.5], (v) => `${Math.round(v * 100)}%`],
        ['Contact fade', 'fade', [0.04, 0.06, 0.08, 0.12], (v) => `${Math.round(v * 100)} cm`],
      ].map(([name, key, values, format]) => ({ type: 'range', name, values, get: () => k[key], label: () => `${name}: ${format(k[key])}`, set: set(key) })),
      ...(this.roofAt ? [{ name: 'Contact under rock', label: () => `Contact under rock: ${k.rockRoofs ? 'blocked' : 'reaches through'}`, run: () => { k.rockRoofs = !k.rockRoofs; this.sync(); } }] : []),
    ];
    for (const action of this.actions) section('Contact').add(action);
  }

  dispose() {
    this.target.dispose(); this.material.dispose(); this.roofTexture?.dispose();
    for (const action of this.actions ?? []) if (action.button) action.button.disabled = true;
  }
}
