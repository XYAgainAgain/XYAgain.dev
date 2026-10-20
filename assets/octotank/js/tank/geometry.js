import * as THREE from 'three/webgpu';
import { TANK } from '../config.js';

export function wallGeometry(body) {
  const size = body.size.map((half) => half * 2);
  // Collision slabs overlap to seal the enclosure; visible slabs meet without duplicate faces.
  if (body.taste !== 'floor' && body.taste !== 'lid') {
    size[1] = TANK.h;
    if (body.pos[0] === 0) size[0] = TANK.w;
  }
  return new THREE.BoxGeometry(...size);
}

export function rimGeometry(width, depth, height, thickness) {
  const outer = [
    [-width / 2 - thickness / 2, -depth / 2 - thickness / 2],
    [width / 2 + thickness / 2, -depth / 2 - thickness / 2],
    [width / 2 + thickness / 2, depth / 2 + thickness / 2],
    [-width / 2 - thickness / 2, depth / 2 + thickness / 2],
  ];
  const inner = [
    [-width / 2 + thickness / 2, -depth / 2 + thickness / 2],
    [width / 2 - thickness / 2, -depth / 2 + thickness / 2],
    [width / 2 - thickness / 2, depth / 2 - thickness / 2],
    [-width / 2 + thickness / 2, depth / 2 - thickness / 2],
  ];
  const positions = [], indices = [];
  const point = (p, y) => [p[0], y, p[1]];
  const quad = (...corners) => {
    const start = positions.length / 3;
    positions.push(...corners.flat());
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, top = height / 2, bottom = -top;
    quad(point(outer[i], top), point(inner[i], top), point(inner[j], top), point(outer[j], top));
    quad(point(outer[i], bottom), point(outer[j], bottom), point(inner[j], bottom), point(inner[i], bottom));
    quad(point(outer[i], bottom), point(outer[i], top), point(outer[j], top), point(outer[j], bottom));
    quad(point(inner[i], bottom), point(inner[j], bottom), point(inner[j], top), point(inner[i], top));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
