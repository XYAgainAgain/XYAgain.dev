import * as THREE from 'three/webgpu';
import { uniform, texture, positionWorld, vec4 } from 'three/tsl';
import { TANK } from '../config.js';
import { section } from '../diag/panel.js';
import { clipProjection } from '../water/optics-core.js';
import { sideEye, sideEntry, sideProject } from './wall-optics-core.js';

export class WallOptics {
  constructor(renderer, scene, camera, glass, water) {
    Object.assign(this, { renderer, scene, camera, glass, water });
    this.knobs = { enabled: true, resolution: 1024 };
    this.group = new THREE.Group(); this.group.name = 'Side pane refraction'; scene.add(this.group);
    this.last = -Infinity; this.captures = 0;
    this.viewport = new THREE.Vector4(); this.scissor = new THREE.Vector4();
    this.view = camera.clone(); this.virtualEye = new THREE.Vector3();
    this.matrix = uniform(new THREE.Matrix4());
    this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const material = new THREE.MeshBasicNodeMaterial({ depthWrite: false, side: THREE.FrontSide });
    const projected = this.matrix.mul(vec4(positionWorld, 1));
    material.colorNode = texture(this.target.texture, projected.xy.div(projected.w)).rgb;
    this.panes = [-1, 1].map((sign) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(TANK.d, 1), material);
      mesh.position.x = sign * (TANK.w / 2 + 0.001);
      mesh.rotation.y = sign * Math.PI / 2; mesh.renderOrder = 10;
      this.group.add(mesh); return mesh;
    });
    this.installControls();
  }

  get active() { return this.knobs.enabled && this.glass.knobs.visible && this.water.enabled; }

  eyeFor(camera, sign, out = this.virtualEye) {
    return out.fromArray(sideEye(camera.position.toArray(), sign, TANK.w, this.water.ctx.water.knobs.surfaceY));
  }

  capture(time) {
    const r = this.renderer, c = this.camera, level = this.water.ctx.water.knobs.surfaceY;
    const sign = Math.sign(c.position.x), shown = this.active && Math.abs(c.position.x) > TANK.w / 2 + 0.003;
    this.group.visible = shown;
    if (!shown) { this.last = -Infinity; return; }
    for (let i = 0; i < 2; i++) {
      this.panes[i].visible = (i ? 1 : -1) === sign;
      this.panes[i].scale.y = level; this.panes[i].position.y = level / 2;
    }
    const size = Math.max(128, Math.min(4096, Math.round(this.knobs.resolution) || 1024)), height = Math.max(64, Math.round(size * level / TANK.d));
    if (this.target.width !== size || this.target.height !== height) { this.target.setSize(size, height); this.last = -Infinity; }
    const hz = Math.max(1, Math.min(120, this.water.knobs.opticsHz)), interval = 1 / hz;
    const moved = !this.lastCamera?.equals(c.matrixWorld) || !this.lastProjection?.equals(c.projectionMatrix) || this.lastLevel !== level;
    const scheduled = !moved && this.lastRate === hz && Number.isFinite(this.last) && time >= this.last;
    if (scheduled && time + 1e-8 < this.due) return;
    // One coherent side view approximates the varying Snell rays and preserves hidden detail.
    const view = this.view; view.copy(c, false); view.position.copy(this.eyeFor(c, sign)); view.up.set(0, 1, 0);
    view.lookAt(view.position.clone().add(new THREE.Vector3(-sign, 0, 0))); view.updateMatrixWorld();
    const corners = [];
    for (const y of [0, level]) for (const z of [-TANK.d / 2, TANK.d / 2]) corners.push(new THREE.Vector3(sign * TANK.w / 2, y, z).applyMatrix4(view.matrixWorldInverse));
    const xs = corners.map((p) => -p.x * view.near / p.z), ys = corners.map((p) => -p.y * view.near / p.z);
    view.coordinateSystem = r.coordinateSystem;
    view.projectionMatrix.makePerspective(Math.min(...xs), Math.max(...xs), Math.max(...ys), Math.min(...ys), view.near, view.far, r.coordinateSystem);
    this.matrix.value.set(0.5, 0, 0, 0.5, 0, -0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(view.projectionMatrix).multiply(view.matrixWorldInverse);
    // The cut sits just past the sand's edge skirt (0.75 mm out) and short of the glass (2 mm out): inside it, the near
    // side of the bed is gone and the pane looks into the sand from beneath its surface.
    const plane = new THREE.Plane(new THREE.Vector3(-sign, 0, 0), TANK.w / 2 + 0.0015).applyMatrix4(view.matrixWorldInverse);
    const coefficients = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    if (!clipProjection(view.projectionMatrix.elements, coefficients, r.coordinateSystem === THREE.WebGPUCoordinateSystem)) { this.group.visible = false; return; }
    view.projectionMatrixInverse.copy(view.projectionMatrix).invert();
    const target = r.getRenderTarget(), autoClear = r.autoClear, shine = this.glass.panes.visible, scissorTest = r.getScissorTest();
    r.getViewport(this.viewport); r.getScissor(this.scissor);
    this.group.visible = false; this.glass.panes.visible = false;
    try {
      r.setRenderTarget(this.target); r.autoClear = true; r.render(this.scene, view);
      this.last = time; this.lastRate = hz; this.lastLevel = level; this.captures++;
      this.due = scheduled ? this.due + (Math.floor((time - this.due + 1e-8) / interval) + 1) * interval : time + interval;
      (this.lastCamera ??= new THREE.Matrix4()).copy(c.matrixWorld); (this.lastProjection ??= new THREE.Matrix4()).copy(c.projectionMatrix);
    } finally {
      this.group.visible = true; this.glass.panes.visible = shine;
      r.setRenderTarget(target); r.setViewport(this.viewport); r.setScissor(this.scissor); r.setScissorTest(scissorTest); r.autoClear = autoClear;
    }
  }

  render(time) { this.capture(time); this.renderer.render(this.scene, this.camera); }

  withoutPanes(callback) {
    const visible = this.group.visible; this.group.visible = false;
    try { return callback(); } finally { this.group.visible = visible; }
  }

  installControls() {
    this.actions = [
      { name: 'Side refraction', label: () => `Side refraction: ${this.knobs.enabled ? 'on' : 'off'}`, run: () => { this.knobs.enabled = !this.knobs.enabled; this.last = -Infinity; } },
      { type: 'range', name: 'Side optics resolution', values: [128, 256, 512, 1024, 2048, 4096], get: () => this.knobs.resolution,
        label: () => `Side optics: ${this.knobs.resolution} px`, set: (v) => { this.knobs.resolution = v; this.last = -Infinity; } },
    ];
    for (const action of this.actions) section('view').add(action);
  }

  paths(camera) { return this.active && Math.abs(camera.position.x) > TANK.w / 2 + 0.003 ? 2 : 1; }

  project(point, camera, out, path = 0) {
    const eye = camera.position.toArray(), level = this.water.ctx.water.knobs.surfaceY;
    out.copy(point);
    if (this.paths(camera) < 2) return out;
    if (!path) {
      const direction = point.clone().sub(camera.position).normalize().toArray();
      return sideEntry(eye, direction, TANK.w, TANK.d, level) ? null : out;
    }
    const projected = sideProject(point.toArray(), eye, TANK.w, TANK.d, level);
    return projected ? out.fromArray(projected) : null;
  }

  bendRay(ray) {
    ray.opticalPath = 0;
    if (this.paths(this.camera) < 2) return ray;
    const point = sideEntry(ray.origin.toArray(), ray.direction.toArray(), TANK.w, TANK.d, this.water.ctx.water.knobs.surfaceY);
    if (!point) return ray;
    ray.opticalPath = 1; ray.origin.fromArray(point);
    ray.direction.copy(ray.origin).sub(this.eyeFor(this.camera, Math.sign(this.camera.position.x))).normalize();
    return ray;
  }

  dispose() {
    this.group.removeFromParent(); this.target.dispose(); this.panes[0].material.dispose();
    for (const pane of this.panes) pane.geometry.dispose();
    for (const action of this.actions) if (action.button) action.button.disabled = true;
  }
}
