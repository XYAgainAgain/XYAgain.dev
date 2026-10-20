import * as THREE from 'three/webgpu';
import { cameraPosition, positionWorld, normalWorld, uv, vec3, float, uniform, reflect } from 'three/tsl';
import { TANK } from '../config.js';
import { section } from '../diag/panel.js';
import { rimGeometry } from './geometry.js';

export class TankGlass {
  constructor(scene) {
    this.knobs = { visible: true, shine: 1 };
    this.strength = uniform(1);
    this.group = new THREE.Group(); this.group.name = 'Tank glass and trim';
    this.panes = new THREE.Group(); this.panes.name = 'Gallery reflections';
    this.group.add(this.panes); scene.add(this.group);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    material.forceSinglePass = true;
    const eye = cameraPosition.sub(positionWorld).normalize();
    const grazing = float(1).sub(normalWorld.dot(eye).abs()).pow(5);
    const reflected = reflect(eye.negate(), normalWorld);
    // A few dim architectural lights imply the gallery without another scene capture.
    const gallery = positionWorld.add(reflected.mul(float(4).div(reflected.z.abs().max(0.2))));
    const ceiling = gallery.x.add(0.5).div(1.4).abs().pow(8).add(gallery.y.sub(1.65).div(0.2).abs().pow(4)).negate().exp();
    const doorway = gallery.x.sub(1.5).div(0.22).abs().pow(4).add(gallery.y.sub(0.65).div(0.9).abs().pow(8)).negate().exp().mul(0.35);
    const light = ceiling.add(doorway);
    const coord = uv(), edge = coord.min(float(1).sub(coord));
    const rim = float(1).sub(edge.x.min(edge.y).smoothstep(0, 0.012));
    material.colorNode = vec3(0.57, 0.69, 0.76).add(vec3(0.2, 0.12, 0.02).mul(ceiling));
    material.opacityNode = light.mul(grazing.mul(0.16).add(0.045)).add(rim.mul(0.065)).add(grazing.mul(0.018)).mul(this.strength).clamp(0, 0.3);
    this.material = material;
    const pane = (width, height, x, y, z, yaw = 0) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
      mesh.position.set(x, y, z); mesh.rotation.y = yaw; mesh.renderOrder = 20;
      this.panes.add(mesh); return mesh;
    };
    this.front = pane(TANK.w, TANK.h, 0, TANK.h / 2, TANK.d / 2 + 0.002);
    pane(TANK.d, TANK.h, -TANK.w / 2 - 0.002, TANK.h / 2, 0, Math.PI / 2);
    pane(TANK.d, TANK.h, TANK.w / 2 + 0.002, TANK.h / 2, 0, -Math.PI / 2);

    this.trim = new THREE.MeshStandardMaterial({ color: 0x10151b, roughness: 0.38, metalness: 0.12 });
    const beam = (w, h, d, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.trim);
      mesh.position.set(x, y, z); this.group.add(mesh);
    };
    for (const y of [0, TANK.h]) {
      const rim = new THREE.Mesh(rimGeometry(TANK.w, TANK.d, 0.018, 0.022), this.trim);
      rim.position.y = y; this.group.add(rim);
    }
    for (const x of [-TANK.w / 2, TANK.w / 2]) {
      for (const z of [-TANK.d / 2, TANK.d / 2]) beam(0.009, TANK.h - 0.018, 0.009, x, TANK.h / 2, z);
    }
    this.actions = [
      { name: 'Show/hide glass', label: () => `Glass: ${this.knobs.visible ? 'shown' : 'hidden'}`, run: () => { this.knobs.visible = !this.knobs.visible; this.update(); } },
      { type: 'range', name: 'Glass shine', values: [0, 0.25, 0.5, 0.75, 1, 1.5, 2], get: () => this.knobs.shine,
        label: () => `Glass shine: ${this.knobs.shine}×`, set: (value) => { this.knobs.shine = value; this.update(); } },
    ];
    for (const action of this.actions) section('view').add(action);
  }

  update() {
    if (this.disposed) return;
    this.panes.visible = this.knobs.visible;
    this.strength.value = Math.max(0, Math.min(2, this.knobs.shine));
  }

  withoutShine(capture) {
    const shown = this.panes.visible;
    this.panes.visible = false;
    try { return capture(); }
    finally { this.panes.visible = shown; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((mesh) => mesh.geometry?.dispose());
    this.material.dispose(); this.trim.dispose();
    for (const action of this.actions) if (action.button) action.button.disabled = true;
  }
}
