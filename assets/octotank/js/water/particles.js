import * as THREE from 'three/webgpu';
import { uv, float, uniform } from 'three/tsl';
import { createRng } from '../../../pond/js/rng.js';

const CAPACITY = 2048;

export class Particles {
  constructor(group, width, depth, level, seed, knobs) {
    Object.assign(this, { width, depth, knobs, level });
    this.positions = new Float32Array(CAPACITY * 3);
    this.sizes = new Float32Array(CAPACITY);
    const rng = createRng((seed ^ 0x57415452) >>> 0).next;
    for (let i = 0; i < CAPACITY; i++) {
      this.positions[i * 3] = (rng() - 0.5) * width;
      this.positions[i * 3 + 1] = 0.01 + rng() * (level - 0.02);
      this.positions[i * 3 + 2] = (rng() - 0.5) * depth;
      this.sizes[i] = 0.6 + rng() * 0.9;
    }
    const material = new THREE.MeshBasicNodeMaterial({ color: 0x9bbcc5, transparent: true, depthWrite: false });
    this.opacity = uniform(knobs.particleOpacity);
    material.opacityNode = float(1).sub(uv().sub(0.5).length().mul(2)).max(0).pow(1.5).mul(this.opacity);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.0024, 0.0024), material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = Math.min(CAPACITY, knobs.particles);
    group.add(this.mesh);
    this.matrix = new THREE.Matrix4(); this.position = new THREE.Vector3(); this.scale = new THREE.Vector3();
    this.velocity = [0, 0, 0];
    this.ambient = [0, 0, 0];
  }

  update(dt, time, level, flow, camera, reduced, currents) {
    const count = Math.max(0, Math.min(CAPACITY, Math.floor(this.knobs.particles) || 0)), p = this.positions;
    this.mesh.count = count;
    this.opacity.value = Math.max(0, Math.min(1, this.knobs.particleOpacity));
    const boundX = this.width / 2 - 0.003, boundY = Math.max(0.006, level - 0.006), boundZ = this.depth / 2 - 0.003;
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      currents.rehome(p, j);
      if (dt > 0 && !reduced) {
        flow.sample(p[j], p[j + 1], p[j + 2], this.velocity);
        currents.sample(p[j], p[j + 1], p[j + 2], time, level, this.ambient);
        const x = p[j] + (this.velocity[0] + this.ambient[0]) * dt;
        const z = p[j + 2] + (this.velocity[2] + this.ambient[2]) * dt;
        if (currents.canTravel(p[j], p[j + 2], x, p[j + 2])) p[j] = x;
        if (currents.canTravel(p[j], p[j + 2], p[j], z)) p[j + 2] = z;
        p[j + 1] += (this.velocity[1] + this.ambient[1] - 0.0002) * dt;
      }
      p[j] = Math.max(-boundX, Math.min(boundX, p[j]));
      p[j + 2] = Math.max(-boundZ, Math.min(boundZ, p[j + 2]));
      if (p[j + 1] < 0.004) p[j + 1] = boundY;
      p[j + 1] = Math.min(boundY, p[j + 1]);
      this.position.fromArray(p, j); this.scale.setScalar(this.sizes[i]);
      this.matrix.compose(this.position, camera.quaternion, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.level = level;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }
}
