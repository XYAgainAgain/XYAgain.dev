import { COVER_DISCS, COVER_CAPS } from './config.js';

/* The one CPU-side list of what floats, shades, and can be sat on. Every cover or perch query in the
   pond comes here rather than keeping its own shapes; no GPU data ever flows in. */
export class Habitat {
  constructor() {
    this.pads = [];      // { id, x, z, r }
    this.clumps = [];    // { id, x, z, r, warp(theta) -> 0..1 radius factor, growth }
    this.perches = [];   // { id, x, y, z, type, radius }
    this.claims = new Map();
    this.nextId = 1;
    // Cover sources fill the shadow bake; sim.setCover replaces both arrays wholesale, so only
    // composeCover may call it, or a later phase's rebake would erase an earlier phase's shadows.
    this.coverSources = [];
    this.duckweedField = null;
    this.coverDiscs = [];
    this.coverCaps = [];
    this.coverWarned = false;
  }

  addPad(pad) { const p = { id: this.nextId++, ...pad }; this.pads.push(p); return p; }

  // dx, dz are the live drift of a mat's center; every query below reads x + dx, never the seed point.
  addClump(clump) { const c = { id: this.nextId++, growth: 1, dx: 0, dz: 0, warp: () => 1, ...clump }; this.clumps.push(c); return c; }

  addPerch(perch) { const p = { id: this.nextId++, ...perch }; this.perches.push(p); return p; }

  /* fn(discs, capsules) pushes { x, z, r, strength } and { ax, az, bx, bz, r, strength }. */
  addCoverSource(fn) { this.coverSources.push(fn); }

  composeCover(sim) {
    const d = this.coverDiscs, c = this.coverCaps;
    d.length = 0; c.length = 0;
    for (const fn of this.coverSources) fn(d, c);
    if ((d.length > COVER_DISCS || c.length > COVER_CAPS) && !this.coverWarned) {
      this.coverWarned = true;
      console.warn(`Pond: cover bake truncated (${d.length}/${COVER_DISCS} discs, ${c.length}/${COVER_CAPS} capsules)`);
    }
    d.length = Math.min(d.length, COVER_DISCS); c.length = Math.min(c.length, COVER_CAPS);
    sim.setCover(d, c);
  }

  /* Pads never move on the CPU side; the margin covers the GPU wander (0.1) plus the stalk-bump swing (0.2). */
  padAt(x, z, margin = 0.3) {
    for (const p of this.pads) if (Math.hypot(x - p.x, z - p.z) <= p.r + margin) return p;
    return null;
  }

  /* The mat's real silhouette is a noise cut the clump discs know nothing about; floaters.js hands
     that test over here so a cover query and the pixels on screen can never disagree. */
  setDuckweedField(fn) { this.duckweedField = fn; }

  duckweedAt(x, z) {
    if (this.duckweedField) return this.duckweedField(x, z);
    for (const c of this.clumps) {
      const dx = x - c.x - c.dx, dz = z - c.z - c.dz;
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
      const dx = x - c.x - c.dx, dz = z - c.z - c.dz;
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
