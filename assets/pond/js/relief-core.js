import { RELIEF_MAX } from './config.js';

/* The dig relief's pure math: a signed height field in world units over a square world footprint,
   stamped by a burrow and relaxed back to flat. relief.js owns the DataTexture that draws it. */

export const RELIEF_MID = 128 / 255;        // the byte a flat sand texel carries
export const RELIEF_DECODE = 255 / 127;     // that byte, mid removed, back to -1..1
export const RELIEF_HEAL_TAU = 20;          // e^-3 by 60 s, so a trough is flat again in about a minute
const FLAT = RELIEF_MAX / 400;              // under half a byte: call it flat and stop paying for it

export function createRelief(res, extent) {
  const n = Math.max(1, res | 0) ** 2;
  return {
    res: Math.max(1, res | 0),
    extent,
    work: new Float32Array(n),                    // signed world units, the field of record
    bytes: new Uint8Array(n).fill(128),
    box: null,                                    // dirty texel AABB; null means the sand is flat
    live: false,
  };
}

export function encode(v) {
  const t = Math.round(128 + (v / RELIEF_MAX) * 127);
  return t < 0 ? 0 : t > 255 ? 255 : t;
}

function grow(g, x0, x1, z0, z1) {
  const b = g.box;
  if (!b) { g.box = { x0, x1, z0, z1 }; return; }
  if (x0 < b.x0) b.x0 = x0;
  if (x1 > b.x1) b.x1 = x1;
  if (z0 < b.z0) b.z0 = z0;
  if (z1 > b.z1) b.z1 = z1;
}

/* One Gaussian, clamped toward h rather than added: a dig restamps its own ridge many times a second
   and accumulation would pile it into a mountain. A negative h carves the same way. */
export function stamp(g, x, z, r, h) {
  // An infinite radius would sweep the whole grid at full weight, so the guard is finiteness, not sign.
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(h) || !Number.isFinite(r) || !(r > 0) || h === 0) return 0;
  const cap = h > 0 ? Math.min(h, RELIEF_MAX) : Math.max(h, -RELIEF_MAX);
  const N = g.res, step = g.extent / N, half = g.extent * 0.5, work = g.work;
  const reach = r * 2;
  const ix0 = Math.max(0, Math.floor((x - reach + half) / step - 0.5));
  const ix1 = Math.min(N - 1, Math.ceil((x + reach + half) / step - 0.5));
  const iz0 = Math.max(0, Math.floor((z - reach + half) / step - 0.5));
  const iz1 = Math.min(N - 1, Math.ceil((z + reach + half) / step - 0.5));
  if (ix1 < ix0 || iz1 < iz0) return 0;
  const k = -1 / (2 * r * r);
  const up = cap > 0;
  let touched = 0;
  for (let iz = iz0; iz <= iz1; iz++) {
    const dz = (iz + 0.5) * step - half - z, row = iz * N;
    for (let ix = ix0; ix <= ix1; ix++) {
      const dx = (ix + 0.5) * step - half - x;
      const w = Math.exp((dx * dx + dz * dz) * k);
      if (w < 0.02) continue;
      const v = cap * w, i = row + ix;
      if (up ? v > work[i] : v < work[i]) { work[i] = v; touched++; }
    }
  }
  if (!touched) return 0;
  grow(g, ix0, ix1, iz0, iz1);
  g.live = true;
  return touched;
}

/* Bilinear over the float field, clamped at the border the way the GPU's ClampToEdge sampler is, so
   the CPU twin and the shader read one surface. World units, zero while the sand is flat. */
export function heightAt(g, x, z) {
  if (!g.live || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const N = g.res, b = g.work;
  let fx = (x / g.extent + 0.5) * N - 0.5;
  let fz = (z / g.extent + 0.5) * N - 0.5;
  fx = fx < 0 ? 0 : fx > N - 1 ? N - 1 : fx;
  fz = fz < 0 ? 0 : fz > N - 1 ? N - 1 : fz;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const x1 = x0 + 1 > N - 1 ? N - 1 : x0 + 1;
  const z1 = z0 + 1 > N - 1 ? N - 1 : z0 + 1;
  const tx = fx - x0, tz = fz - z0;
  const r0 = z0 * N, r1 = z1 * N;
  const lo = b[r0 + x0] + (b[r0 + x1] - b[r0 + x0]) * tx;
  const hi = b[r1 + x0] + (b[r1 + x1] - b[r1 + x0]) * tx;
  return lo + (hi - lo) * tz;
}

/* Relax the dirty region toward flat and re-encode it, shrinking the box to whatever is still moving.
   Returns whether the bytes changed, which is the caller's cue to upload. */
export function heal(g, dt, tau = RELIEF_HEAL_TAU) {
  if (!g.box) return false;
  const { x0, x1, z0, z1 } = g.box;
  const N = g.res, work = g.work, bytes = g.bytes;
  const el = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const keep = Math.exp(-el / (Number.isFinite(tau) && tau > 1e-3 ? tau : RELIEF_HEAL_TAU));
  let nx0 = x1, nx1 = x0, nz0 = z1, nz1 = z0, live = false;
  for (let iz = z0; iz <= z1; iz++) {
    const row = iz * N;
    for (let ix = x0; ix <= x1; ix++) {
      const i = row + ix;
      let v = work[i] * keep;
      if (v > -FLAT && v < FLAT) v = 0;
      else {
        live = true;
        if (ix < nx0) nx0 = ix;
        if (ix > nx1) nx1 = ix;
        if (iz < nz0) nz0 = iz;
        if (iz > nz1) nz1 = iz;
      }
      work[i] = v;
      bytes[i] = encode(v);
    }
  }
  g.box = live ? { x0: nx0, x1: nx1, z0: nz0, z1: nz1 } : null;
  g.live = live;
  return true;
}
