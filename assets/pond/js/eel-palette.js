import * as THREE from 'three/webgpu';
import { bakeRampData } from './eel-palette-core.js';

/* The THREE-facing half of the ramp bakery. Consumers import everything from here; the pure math
   lives in eel-palette-core.js so node --test can reach it without a bare 'three/webgpu' specifier. */

export { JIM_TABLECLOTH, PRIDE_FLAGS, hexStops, twoToneStops, bakeRampData } from './eel-palette-core.js';

// NoColorSpace: the bytes are already the linear values the shader wants, so nothing decodes them.
export function makeRampTexture() {
  const tex = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Rebakes in place; the texture is allocated once per eel and never reallocated on a roll.
export function bakeRamp(texture, stops, opts, rng) {
  const { head, tail } = bakeRampData(texture.image.data, stops, opts, rng);
  texture.needsUpdate = true;
  return { head: new THREE.Color(head[0], head[1], head[2]), tail: new THREE.Color(tail[0], tail[1], tail[2]) };
}
