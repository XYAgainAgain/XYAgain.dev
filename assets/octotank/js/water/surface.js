import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, positionLocal, positionWorld, cameraPosition, normalWorld, materialColor, materialEmissive, vec2, vec3, vec4, float, mix, refract } from 'three/tsl';
import { clipProjection } from './optics-core.js';
import { Refraction } from './refraction.js';

export class Surface {
  constructor(renderer, scene, camera, waves, level, knobs) {
    Object.assign(this, { renderer, scene, camera, waves, knobs });
    this.level = uniform(level);
    this.gain = uniform(knobs.caustics);
    this.reflectionOn = uniform(0);
    this.reflectionStrength = uniform(knobs.reflectionStrength);
    const { nx, nz } = waves;
    this.pixels = new Uint16Array(nx * nz * 4);
    this.field = new THREE.DataTexture(this.pixels, nx, nz, THREE.RGBAFormat, THREE.HalfFloatType);
    this.field.minFilter = this.field.magFilter = THREE.LinearFilter;
    this.field.generateMipmaps = false;
    this.focus = new Float32Array(nx * nz);
    this.slope = [0, 0];
    this.originals = new Map(); this.reverse = new Map();
    this.group = new THREE.Group();
    this.group.name = 'Water visuals';
    scene.add(this.group);
    this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.refraction = new Refraction(renderer, scene, camera, waves.width, waves.depth, knobs);
    this.mirror = camera.clone();
    this.matrix = uniform(new THREE.Matrix4());
    this.lastReflection = -Infinity;
    this.clip = new THREE.Plane(); this.clipVector = new THREE.Vector4();
    this.look = new THREE.Vector3(); this.direction = new THREE.Vector3();
    this.viewport = new THREE.Vector4(); this.scissor = new THREE.Vector4();

    const coord = positionWorld.xz.div(vec2(waves.width, waves.depth)).add(0.5);
    const sample = texture(this.field, coord);
    const normal = vec3(sample.g.negate(), 1, sample.b.negate()).normalize();
    const towardEye = cameraPosition.sub(positionWorld).normalize();
    const grazing = float(1).sub(normal.dot(towardEye).abs()).pow(5);
    const cosine = normal.dot(towardEye).abs();
    const totalInternal = float(1).sub(cosine.mul(cosine)).mul(1.333 * 1.333).greaterThan(1);
    const below = cameraPosition.y.lessThan(this.level);
    const fresnel = below.and(totalInternal).select(1, grazing.mul(0.98).add(0.02).clamp(0, 1));
    const projected = this.matrix.mul(vec4(positionWorld, 1));
    const reflectionUV = projected.xy.div(projected.w).add(sample.gb.mul(0.035)).clamp(0.001, 0.999);
    const reflected = texture(this.target.texture, reflectionUV).rgb.mul(this.reflectionStrength);
    const ray = refract(towardEye.negate(), below.select(normal.negate(), normal), below.select(1.333, 1 / 1.333));
    const refracted = this.refraction.color(positionWorld, ray);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
    material.positionNode = positionLocal.add(vec3(0, sample.r, 0));
    material.colorNode = mix(refracted.mul(vec3(0.86, 0.97, 1.0)), mix(vec3(0.025, 0.055, 0.07), reflected, this.reflectionOn), fresnel)
      .add(vec3(0.012, 0.028, 0.035)).add(vec3(0.4, 0.55, 0.6).mul(sample.gb.length().mul(0.7).min(0.06)));
    material.opacity = 1;
    const geometry = new THREE.PlaneGeometry(waves.width, waves.depth, nx - 1, nz - 1);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.y = level;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);

    const points = [], edges = [];
    const edge = (i, j) => { points.push(new THREE.Vector3(i * waves.dx - waves.width / 2, 0, j * waves.dz - waves.depth / 2)); edges.push(j * nx + i); };
    for (let i = 0; i < nx; i++) edge(i, 0);
    for (let j = 1; j < nz; j++) edge(nx - 1, j);
    for (let i = nx - 2; i >= 0; i--) edge(i, nz - 1);
    for (let j = nz - 2; j >= 0; j--) edge(0, j);
    this.edges = edges;
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    this.line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x8db3c2, transparent: true, opacity: 0.5 }));
    this.line.position.y = level;
    this.group.add(this.line);
    const backdropMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    backdropMaterial.colorNode = mix(vec3(0.002, 0.007, 0.011), vec3(0.006, 0.020, 0.027), positionWorld.y.div(this.level).clamp(0, 1));
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(waves.width, 1), backdropMaterial);
    this.backdrop.position.set(0, level / 2, -waves.depth / 2 + 0.001);
    this.backdrop.scale.y = level;
    this.group.add(this.backdrop);
    this.upload();
  }

  upload() {
    const W = this.waves, { nx, nz, h, dx, dz } = W, F = this.focus, P = this.pixels;
    F.fill(0);
    this.maxSlope = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const p = (j * nx + i) * 4;
      if (W.solid[j * nx + i]) { P[p] = P[p + 1] = P[p + 2] = 0; continue; }
      W.slopes(i, j, this.slope);
      this.maxSlope = Math.max(this.maxSlope, Math.hypot(...this.slope));
      P[p] = THREE.DataUtils.toHalfFloat(h[j * nx + i]);
      P[p + 1] = THREE.DataUtils.toHalfFloat(this.slope[0]);
      P[p + 2] = THREE.DataUtils.toHalfFloat(this.slope[1]);
      // A vertical ray bends uphill by (1 − 1/1.333) × slope, so crests focus light beneath them and troughs spread it.
      const x = i + this.slope[0] * this.level.value * 0.25 / dx;
      const z = j + this.slope[1] * this.level.value * 0.25 / dz;
      const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
        if (ix + a < 0 || ix + a >= nx || iz + b < 0 || iz + b >= nz) continue;
        F[(iz + b) * nx + ix + a] += (a ? fx : 1 - fx) * (b ? fz : 1 - fz);
      }
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const p = j * nx + i;
      const soft = (F[p] * 4 + F[j * nx + Math.max(0, i - 1)] + F[j * nx + Math.min(nx - 1, i + 1)]
        + F[Math.max(0, j - 1) * nx + i] + F[Math.min(nz - 1, j + 1) * nx + i]) / 8;
      P[p * 4 + 3] = THREE.DataUtils.toHalfFloat(W.solid[p] ? 1 : Math.max(0.2, Math.min(4, soft)));
    }
    this.field.needsUpdate = true;
    const edgePositions = this.line.geometry.attributes.position;
    for (let i = 0; i < this.edges.length; i++) edgePositions.setY(i, h[this.edges[i]]);
    edgePositions.needsUpdate = true;
  }

  material(original) {
    if (!original?.isMeshStandardMaterial || this.reverse.has(original)) return original;
    if (this.originals.has(original)) return this.originals.get(original);
    const result = new THREE.MeshStandardNodeMaterial();
    result.copy(original);
    const { width, depth } = this.waves;
    result.colorNode = Fn(() => {
      const wet = this.level.sub(positionWorld.y).smoothstep(0, 0.02);
      const coord = positionWorld.xz.add(vec2(positionWorld.y.mul(0.12), positionWorld.y.mul(-0.08))).div(vec2(width, depth)).add(0.5);
      const caustic = texture(this.field, coord.clamp(0.001, 0.999)).a.sub(1).mul(3).clamp(-0.4, 2);
      const lit = normalWorld.y.max(0).mul(0.8).add(0.2);
      const waterDepth = positionWorld.z.negate().add(depth / 2).div(depth).clamp(0, 1);
      return materialColor.mul(float(1).add(caustic.mul(this.gain).mul(wet).mul(lit)))
        .mul(mix(vec3(1), vec3(0.86, 0.96, 0.99), waterDepth.mul(wet)));
    })();
    result.emissiveNode = Fn(() => {
      const wet = this.level.sub(positionWorld.y).smoothstep(0, 0.02);
      const coord = positionWorld.xz.add(vec2(positionWorld.y.mul(0.12), positionWorld.y.mul(-0.08))).div(vec2(width, depth)).add(0.5);
      const light = texture(this.field, coord.clamp(0.001, 0.999)).a.sub(1).max(0).min(2);
      return materialEmissive.add(vec3(0.045, 0.065, 0.06).mul(light).mul(this.gain).mul(wet).mul(normalWorld.y.max(0)));
    })();
    this.originals.set(original, result); this.reverse.set(result, original);
    return result;
  }

  patchMaterials(enabled) {
    let changed = false;
    this.scene.traverse((object) => {
      if (!object.isMesh || object === this.mesh) return;
      const patch = (m) => {
        const next = enabled ? this.material(m) : (this.reverse.get(m) ?? m);
        if (next !== m) changed = true;
        return next;
      };
      if (Array.isArray(object.material)) object.material = object.material.map(patch);
      else object.material = patch(object.material);
    });
    if (changed) { this.lastReflection = -Infinity; this.refraction.last = -Infinity; }
  }

  update(level) {
    if (this.level.value !== level) { this.lastReflection = -Infinity; this.refraction.last = -Infinity; }
    this.level.value = level;
    this.mesh.position.y = this.line.position.y = level;
    this.backdrop.position.y = level / 2; this.backdrop.scale.y = level;
    this.gain.value = Math.max(0, this.knobs.caustics);
    this.reflectionStrength.value = Math.max(0, this.knobs.reflectionStrength);
    this.patchMaterials(true);
  }

  reflect(time, force = false) {
    this.camera.updateMatrixWorld();
    this.refraction.capture(time, this.level.value, this.maxSlope, [this.mesh, this.line], force);
    const k = this.knobs;
    if (!k.reflections || k.reflectionHz <= 0) { this.reflectionOn.value = 0; this.lastReflection = -Infinity; return; }
    const size = Math.max(64, Math.min(4096, Math.round(k.reflectionResolution) || 2048));
    const height = Math.max(32, Math.min(4096, Math.round(size / this.camera.aspect)));
    if (this.target.width !== size || this.target.height !== height) {
      this.target.setSize(size, height);
      this.lastReflection = -Infinity;
    }
    const cameraChanged = !this.lastCamera?.equals(this.camera.matrixWorld) || !this.lastProjection?.equals(this.camera.projectionMatrix);
    const interval = 1 / Math.min(120, k.reflectionHz);
    const scheduled = !force && !cameraChanged && Number.isFinite(this.lastReflection) && time >= this.lastReflection;
    if (scheduled && time + 1e-8 < this.reflectionDue) return;
    const r = this.renderer, c = this.camera, m = this.mirror, y = this.level.value;
    m.copy(c, false);
    c.getWorldDirection(this.direction);
    this.look.copy(c.position).add(this.direction); this.look.y = 2 * y - this.look.y;
    m.position.copy(c.position); m.position.y = 2 * y - m.position.y;
    m.up.setFromMatrixColumn(c.matrixWorld, 1).normalize(); m.up.y *= -1;
    m.lookAt(this.look);
    m.near = c.near; m.far = c.far; m.aspect = c.aspect; m.fov = c.fov;
    m.coordinateSystem = r.coordinateSystem;
    m.updateProjectionMatrix(); m.updateMatrixWorld();
    this.matrix.value.set(0.5, 0, 0, 0.5, 0, -0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(m.projectionMatrix).multiply(m.matrixWorldInverse);
    // Clip at the surface so emerged geometry cannot appear in the submerged reflection.
    const sign = c.position.y < y ? -1 : 1;
    this.clip.set(new THREE.Vector3(0, sign, 0), -sign * y).applyMatrix4(m.matrixWorldInverse);
    this.clipVector.set(this.clip.normal.x, this.clip.normal.y, this.clip.normal.z, this.clip.constant);
    if (!clipProjection(m.projectionMatrix.elements, this.clipVector, r.coordinateSystem === THREE.WebGPUCoordinateSystem)) { this.reflectionOn.value = 0; return; }
    m.projectionMatrixInverse.copy(m.projectionMatrix).invert();
    const target = r.getRenderTarget(), autoClear = r.autoClear;
    r.getViewport(this.viewport); r.getScissor(this.scissor);
    const scissorTest = r.getScissorTest();
    const meshVisible = this.mesh.visible, lineVisible = this.line.visible;
    this.mesh.visible = false; this.line.visible = false;
    try {
      r.setRenderTarget(this.target); r.autoClear = true;
      r.render(this.scene, m);
      this.reflectionOn.value = 1;
      this.reflectionDue = scheduled ? this.reflectionDue + (Math.floor(Math.max(0, time - this.reflectionDue + 1e-8) / interval) + 1) * interval : time + interval;
      this.lastReflection = time;
      (this.lastCamera ??= new THREE.Matrix4()).copy(c.matrixWorld);
      (this.lastProjection ??= new THREE.Matrix4()).copy(c.projectionMatrix);
    } finally {
      r.setRenderTarget(target); r.setViewport(this.viewport); r.setScissor(this.scissor); r.setScissorTest(scissorTest);
      r.autoClear = autoClear; this.mesh.visible = meshVisible; this.line.visible = lineVisible;
    }
  }

  setVisible(on) {
    this.group.visible = on;
    this.patchMaterials(on);
    this.lastReflection = -Infinity;
    this.refraction.last = -Infinity;
  }

  dispose() {
    this.patchMaterials(false);
    for (const m of this.originals.values()) m.dispose();
    this.originals.clear(); this.reverse.clear();
    this.group.removeFromParent();
    for (const object of [this.mesh, this.line, this.backdrop]) { object.geometry.dispose(); object.material.dispose(); }
    this.field.dispose(); this.target.dispose();
    this.refraction.dispose();
  }
}
