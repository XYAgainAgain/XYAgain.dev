import * as THREE from 'three/webgpu';
import { section } from '../diag/panel.js';

/* The tank's lights: a sky-and-floor fill and a warm key. ?pane=legacy restores the blue rim: it lights the sand
   from 27° up, below Snell's window, and mirrors off glossy pebbles straight into the right pane. */
export const LIGHT_KNOBS = { key: 2.2, fill: 1.4, rim: 0 };
export const LEGACY_LIGHTS = { key: 2.2, fill: 1.2, rim: 0.8 };

export class TankLights {
  constructor(scene, renderer, { legacy = false } = {}) {
    Object.assign(this, { scene, renderer });
    this.knobs = { ...(legacy ? LEGACY_LIGHTS : LIGHT_KNOBS) };
    this.fill = new THREE.HemisphereLight(0x9fc4ff, 0x1a2230, this.knobs.fill);
    // Light from above the water reaches it only through Snell's window: anything standing for it sits 41.4° up or more.
    this.key = new THREE.DirectionalLight(0xfff2d8, this.knobs.key);
    this.key.position.set(0.4, 1.6, 0.9);
    this.rim = new THREE.DirectionalLight(0x6fa0ff, this.knobs.rim);
    this.rim.position.set(-0.8, 0.5, -0.6);
    scene.add(this.fill, this.key, this.rim);
    this.sync();
    this.installControls();
  }

  sync() {
    const k = this.knobs, at = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);
    this.fill.intensity = at(k.fill); this.key.intensity = at(k.key); this.rim.intensity = at(k.rim);
    this.rim.visible = this.rim.intensity > 0;
  }

  installControls() {
    this.actions = [
      ['Key light', 'key', [0, 1, 1.5, 2, 2.2, 2.5, 3]],
      ['Fill light', 'fill', [0.8, 1, 1.2, 1.4, 1.6, 2]],
      ['Rim light (old)', 'rim', [0, 0.4, 0.8]],
    ].map(([name, key, values]) => ({
      type: 'range', name, values, get: () => this.knobs[key], label: () => `${name}: ${this.knobs[key] ? this.knobs[key] : 'off'}`,
      set: (value) => { this.knobs[key] = value; this.sync(); },
    }));
    for (const action of this.actions) section('Lights').add(action);
  }

  dispose() {
    for (const light of [this.fill, this.key, this.rim]) { light.removeFromParent(); light.dispose?.(); }
    for (const action of this.actions ?? []) if (action.button) action.button.disabled = true;
  }
}
