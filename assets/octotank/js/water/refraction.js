import * as THREE from 'three/webgpu';
import { Fn, If, uniform, texture, vec2, vec3, vec4, float, getViewPosition, min } from 'three/tsl';
import { clipProjection, transmissionVisible } from './optics-core.js';

export class Refraction {
  constructor(renderer, scene, camera, width, depth, knobs) {
    Object.assign(this, { renderer, scene, camera, width, depth, knobs });
    this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.target.depthTexture = new THREE.DepthTexture(1, 1);
    this.view = camera.clone();
    this.project = uniform(new THREE.Matrix4());
    this.inverse = uniform(new THREE.Matrix4());
    this.viewMatrix = uniform(new THREE.Matrix4());
    this.on = uniform(0);
    this.plane = new THREE.Plane(); this.coefficients = new THREE.Vector4();
    this.viewport = new THREE.Vector4(); this.scissor = new THREE.Vector4();
    this.last = -Infinity; this.frames = 0;
  }

  color(origin, ray) {
    return Fn(() => {
      const result = vec3(0.006, 0.017, 0.022).toVar();
      If(this.on.greaterThan(0.5).and(ray.dot(ray).greaterThan(0.5)), () => {
        const safe = vec3(...['x', 'y', 'z'].map((axis) => ray[axis].greaterThanEqual(0).select(1, -1).mul(ray[axis].abs().max(0.0001))));
        const boundary = vec3(ray.x.greaterThan(0).select(this.width / 2, -this.width / 2), ray.y.greaterThan(0).select(1.25, 0), ray.z.greaterThan(0).select(this.depth / 2, -this.depth / 2));
        const distances = boundary.sub(origin).div(safe);
        const exit = min(min(distances.x, distances.y), distances.z).clamp(0.001, 3);
        const near = float(0).toVar(), far = exit.toVar(), found = float(0).toVar();
        const coord = vec2(0.5).toVar();
        // View depths of the ray point and of the captured scene where that point lands on screen.
        const probe = (distance) => {
          const point = origin.add(ray.mul(distance));
          const clip = this.project.mul(vec4(point, 1));
          const sampled = clip.xy.div(clip.w).mul(vec2(0.5, -0.5)).add(0.5).clamp(0.001, 0.999);
          const depth = texture(this.target.depthTexture, sampled);
          return { ray: this.viewMatrix.mul(vec4(point, 1)).z.negate().toVar(), scene: getViewPosition(sampled, depth, this.inverse).z.negate().toVar() };
        };
        const start = probe(float(0));
        const lastRay = start.ray.toVar(), lastScene = start.scene.toVar(), lastHidden = float(0).toVar();
        // Going behind the depth image is a hit only where the scene is continuous with the last miss or lies between the two
        // ray depths; a jump forward means the ray slipped behind a thin floater, which would smear it into stacked ghosts.
        const advance = (distance, onHit) => {
          const s = probe(distance);
          const behind = s.scene.lessThanEqual(s.ray);
          const between = s.scene.greaterThanEqual(lastRay.sub(0.01));
          const continuous = lastHidden.lessThan(0.5).and(s.scene.greaterThanEqual(lastScene.sub(s.ray.sub(lastRay).abs().add(0.05))));
          If(behind.and(between.or(continuous)), onHit).Else(() => {
            near.assign(distance); lastRay.assign(s.ray); lastScene.assign(s.scene); lastHidden.assign(behind.select(1, 0));
          });
        };
        // A bounded depth march avoids the silhouette oscillation of repeated UV offsets.
        for (let i = 1; i <= 16; i++) {
          If(found.lessThan(0.5), () => {
            const distance = exit.mul(i / 16).toVar();
            advance(distance, () => { far.assign(distance); found.assign(1); });
          });
        }
        for (let i = 0; i < 8; i++) {
          If(found.greaterThan(0.5), () => {
            const middle = near.add(far).mul(0.5).toVar();
            advance(middle, () => { far.assign(middle); });
          });
        }
        const finalClip = this.project.mul(vec4(origin.add(ray.mul(far)), 1));
        coord.assign(finalClip.xy.div(finalClip.w).mul(vec2(0.5, -0.5)).add(0.5));
        // A ray that ends hidden behind a floater has no answer in the capture; its exit point would only paint the floater again.
        const inside = coord.x.greaterThan(0).and(coord.x.lessThan(1)).and(coord.y.greaterThan(0)).and(coord.y.lessThan(1))
          .and(found.greaterThan(0.5).or(lastHidden.lessThan(0.5)));
        result.assign(inside.select(texture(this.target.texture, coord.clamp(0.001, 0.999)).rgb, result));
      });
      return result;
    })();
  }

  capture(time, level, maxSlope, hidden, force = false) {
    const k = this.knobs, c = this.camera, r = this.renderer;
    if (!k.refractions || k.refractionHz <= 0 || !transmissionVisible(c.position, level, this.width, this.depth, maxSlope)) {
      this.on.value = 0; this.last = -Infinity; return;
    }
    c.updateMatrixWorld();
    const size = Math.max(64, Math.min(1024, Math.round(k.refractionResolution) || 384));
    const height = Math.max(32, Math.round(size / c.aspect));
    if (this.target.width !== size || this.target.height !== height) { this.target.setSize(size, height); this.last = -Infinity; }
    const moved = !this.lastCamera?.equals(c.matrixWorld) || !this.lastProjection?.equals(c.projectionMatrix);
    const interval = 1 / Math.min(120, k.refractionHz);
    const scheduled = !force && !moved && Number.isFinite(this.last) && time >= this.last;
    if (scheduled && time + 1e-8 < this.due) return;
    const v = this.view;
    v.copy(c, false); v.coordinateSystem = r.coordinateSystem; v.updateProjectionMatrix(); v.updateMatrixWorld();
    const sign = c.position.y < level ? 1 : -1;
    this.plane.set(new THREE.Vector3(0, sign, 0), -sign * level).applyMatrix4(v.matrixWorldInverse);
    this.coefficients.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    if (!clipProjection(v.projectionMatrix.elements, this.coefficients, r.coordinateSystem === THREE.WebGPUCoordinateSystem)) { this.on.value = 0; return; }
    v.projectionMatrixInverse.copy(v.projectionMatrix).invert();
    this.project.value.multiplyMatrices(v.projectionMatrix, v.matrixWorldInverse);
    this.inverse.value.copy(v.projectionMatrixInverse); this.viewMatrix.value.copy(v.matrixWorldInverse);
    const target = r.getRenderTarget(), autoClear = r.autoClear, scissorTest = r.getScissorTest();
    r.getViewport(this.viewport); r.getScissor(this.scissor);
    const visibility = hidden.map((m) => m.visible);
    for (const object of hidden) object.visible = false;
    try {
      r.setRenderTarget(this.target); r.autoClear = true; r.render(this.scene, v);
      this.on.value = 1; this.last = time; this.frames++;
      this.due = scheduled ? this.due + (Math.floor((time - this.due + 1e-8) / interval) + 1) * interval : time + interval;
      (this.lastCamera ??= new THREE.Matrix4()).copy(c.matrixWorld);
      (this.lastProjection ??= new THREE.Matrix4()).copy(c.projectionMatrix);
    } finally {
      r.setRenderTarget(target); r.setViewport(this.viewport); r.setScissor(this.scissor); r.setScissorTest(scissorTest); r.autoClear = autoClear;
      hidden.forEach((m, i) => { m.visible = visibility[i]; });
    }
  }

  dispose() { this.target.dispose(); }
}
