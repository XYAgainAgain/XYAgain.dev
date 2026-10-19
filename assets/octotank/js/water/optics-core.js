export function clipProjection(elements, plane, webgpu) {
  const qx = (Math.sign(plane.x) + elements[8]) / elements[0];
  const qy = (Math.sign(plane.y) + elements[9]) / elements[5];
  const qw = (1 + elements[10]) / elements[14];
  const dot = plane.x * qx + plane.y * qy - plane.z + plane.w * qw;
  if (!Number.isFinite(dot) || Math.abs(dot) < 1e-8) return false;
  const scale = (webgpu ? 1 : 2) / dot;
  elements[2] = plane.x * scale;
  elements[6] = plane.y * scale;
  elements[10] = plane.z * scale + (webgpu ? 0 : 1);
  elements[14] = plane.w * scale;
  return true;
}

export function transmissionVisible(camera, level, width, depth, maxSlope = 0) {
  if (camera.y >= level) return true;
  const dy = level - camera.y;
  const dx = Math.max(0, Math.abs(camera.x) - width / 2);
  const dz = Math.max(0, Math.abs(camera.z) - depth / 2);
  return dy / Math.hypot(dx, dy, dz) + maxSlope >= Math.sqrt(1 - 1 / (1.333 * 1.333));
}
