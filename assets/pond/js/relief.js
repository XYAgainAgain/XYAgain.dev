import * as THREE from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
import { RELIEF_RES, RELIEF_MAX } from './config.js';
import { createRelief, stamp, heightAt, heal, RELIEF_HEAL_TAU } from './relief-core.js';

const UPLOAD_HZ = 15;   // the heal over one of these is under a thousandth, so the field never steps

/* The sand's memory of a dig: a signed world-space height the floor reads as a bump plus a trough
   shade, and floorSurfaceAt adds so grains land on the mound the shader draws. Decoration only, and
   nothing at all happens on a frame with no dig and no healing left to do. */
export class ReliefField {
  constructor(extent, res = RELIEF_RES) {
    this.grid = createRelief(res, extent);
    const tex = new THREE.DataTexture(this.grid.bytes, this.grid.res, this.grid.res, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.tex = tex;
    this.read = texture(tex);
    this.uExtent = uniform(extent);
    this.uTexel = uniform(1 / this.grid.res);
    // World units between the two gradient taps, so the shader can turn a byte difference into a slope.
    this.uStep = uniform((2 * extent) / this.grid.res);
    this.uStrength = uniform(1);
    this.strength = 1;
    this.acc = 0;
  }

  /* knobs.air.relief, live: the shader's lean and shade and the CPU's height read one number, or a
     grain would land on a mound the floor is not drawing. */
  setStrength(v) {
    const s = Number.isFinite(v) && v >= 0 ? v : 1;
    if (s === this.strength) return;
    this.strength = s;
    this.uStrength.value = s;
  }

  stamp(x, z, r, h) { return stamp(this.grid, x, z, r, h); }

  heightAt(x, z) { return heightAt(this.grid, x, z) * this.strength; }

  update(dt) {
    if (!this.grid.box) return;
    this.acc += dt;
    if (this.acc < 1 / UPLOAD_HZ) return;
    const el = Math.min(this.acc, 1);
    this.acc = 0;
    if (heal(this.grid, el, RELIEF_HEAL_TAU)) this.tex.needsUpdate = true;
  }

  dispose() { this.tex.dispose(); }
}

export { RELIEF_MAX, RELIEF_HEAL_TAU };
