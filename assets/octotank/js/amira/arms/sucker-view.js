import * as THREE from 'three/webgpu';

/* Debug only: a small marker on every sealed sucker, off until toggled (S on the panel). */

export class SuckerView {
  constructor(arms, scene) {
    this.arms = arms;
    const max = arms.layouts.reduce((n, L) => n + L.n, 0);
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0022, 6, 4), new THREE.MeshBasicMaterial({ color: 0x7dffb0 }), max);
    // Its bounds are the spawn pose's and never follow the arms, so culling would hide markers that are in view.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.count = 0;
    this.max = max;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._p = [0, 0, 0];
  }

  get visible() { return this.mesh.visible; }
  set visible(v) { this.mesh.visible = !!v; }

  update() {
    if (!this.mesh.visible) return;
    const arms = this.arms, m = this._m, p = this._p;
    let n = 0;
    for (let a = 0; a < arms.arms.length; a++) {
      const sealed = arms.banks[a].sealed;
      for (let i = 0; i < sealed.length; i++) {
        if (!sealed[i] || n >= this.max || !arms.suckerPoint(a, i, p)) continue;
        m.makeTranslation(p[0], p[1], p[2]);
        this.mesh.setMatrixAt(n++, m);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
