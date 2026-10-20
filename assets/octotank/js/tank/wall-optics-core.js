export const WATER_IOR = 1.333;

export function refractRay(direction, normal, ratio, out = [0, 0, 0]) {
  const dot = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2], k = 1 - ratio * ratio * (1 - dot * dot);
  if (k < 0) return null;
  const n = ratio * dot + Math.sqrt(k);
  for (let i = 0; i < 3; i++) out[i] = direction[i] * ratio - normal[i] * n;
  return out;
}

// The apparent eye after refraction: extending the bent ray back lets one straight pinhole view stand in for the water-side rays.
export function sideEye(eye, sign, width, level, out = [0, 0, 0]) {
  const center = [sign * width / 2, level / 2, 0], direction = center.map((v, i) => v - eye[i]), distance = Math.hypot(...direction);
  const bent = refractRay(direction.map((v) => v / distance), [sign, 0, 0], 1 / WATER_IOR);
  for (let i = 0; i < 3; i++) out[i] = center[i] - bent[i] * distance;
  return out;
}

export function sideEntry(eye, direction, width, depth, level, out = [0, 0, 0]) {
  if (Math.abs(eye[0]) <= width / 2 + 0.003 || Math.abs(direction[0]) < 1e-10) return null;
  const t = (Math.sign(eye[0]) * width / 2 - eye[0]) / direction[0];
  if (t <= 0) return null;
  for (let i = 0; i < 3; i++) out[i] = eye[i] + direction[i] * t;
  return out[1] >= 0 && out[1] < level && Math.abs(out[2]) <= depth / 2 ? out : null;
}

export function sideProject(point, eye, width, depth, level, out = [0, 0, 0]) {
  const sign = Math.sign(eye[0]), virtual = sideEye(eye, sign, width, level);
  const t = (sign * width / 2 - virtual[0]) / (point[0] - virtual[0]);
  if (t < 0 || t > 1 || !Number.isFinite(t)) return null;
  for (let i = 0; i < 3; i++) out[i] = virtual[i] + (point[i] - virtual[i]) * t;
  return out[1] >= 0 && out[1] < level && Math.abs(out[2]) <= depth / 2 ? out : null;
}
