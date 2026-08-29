/* The one CPU-side list of what floats, shades, and can be sat on. Every cover or perch query in the
   pond comes here rather than keeping its own shapes; no GPU data ever flows in. */
export class Habitat {
  constructor() {
    this.pads = [];      // { id, x, z, r }
    this.clumps = [];    // { id, x, z, r, warp(theta) -> 0..1 radius factor, growth }
    this.perches = [];   // { id, x, y, z, type, radius }
    this.claims = new Map();
    this.nextId = 1;
  }

  addPad(pad) { const p = { id: this.nextId++, ...pad }; this.pads.push(p); return p; }

  addClump(clump) { const c = { id: this.nextId++, growth: 1, warp: () => 1, ...clump }; this.clumps.push(c); return c; }

  addPerch(perch) { const p = { id: this.nextId++, ...perch }; this.perches.push(p); return p; }

  /* Pads never move on the CPU side; the 0.1 margin covers their small GPU-side wander. */
  padAt(x, z, margin = 0.1) {
    for (const p of this.pads) if (Math.hypot(x - p.x, z - p.z) <= p.r + margin) return p;
    return null;
  }

  duckweedAt(x, z) {
    for (const c of this.clumps) {
      const dx = x - c.x, dz = z - c.z;
      const d = Math.hypot(dx, dz);
      if (d <= c.r * c.growth * c.warp(Math.atan2(dz, dx))) return c;
    }
    return null;
  }

  /* Nearest cover of either kind, with the distance to its edge (negative when inside). */
  nearestCover(x, z) {
    let best = null;
    for (const p of this.pads) {
      const d = Math.hypot(x - p.x, z - p.z) - p.r;
      if (!best || d < best.d) best = { kind: 'pad', shape: p, d };
    }
    for (const c of this.clumps) {
      const dx = x - c.x, dz = z - c.z;
      const d = Math.hypot(dx, dz) - c.r * c.growth * c.warp(Math.atan2(dz, dx));
      if (!best || d < best.d) best = { kind: 'duckweed', shape: c, d };
    }
    return best;
  }

  nearestPerch(x, z, type = null, freeOnly = false) {
    let best = null, bestD = Infinity;
    for (const p of this.perches) {
      if (type && p.type !== type) continue;
      if (freeOnly && this.claims.has(p.id)) continue;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  claim(perchId, who) { if (this.claims.has(perchId)) return false; this.claims.set(perchId, who); return true; }

  release(perchId) { this.claims.delete(perchId); }

  claimant(perchId) { return this.claims.get(perchId) ?? null; }
}
