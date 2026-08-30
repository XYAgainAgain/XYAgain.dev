/* Pointer handling for the pond. Mouse buttons map directly; touch counts fingers:
   1 = left, 2 = right, 3 = middle. A short hold-off on touch lets extra fingers arrive. */
export class PondInput {
  constructor(canvas, toWorld, handlers) {
    this.canvas = canvas;
    this.toWorld = toWorld;         // (clientX, clientY) => [x, z]
    this.h = handlers;              // poke, dragStart, dragMove, dragEnd, feed, feedDragMove, feedDragEnd, recolor, activity
    this.pointers = new Map();
    this.mode = null;               // 'left' | 'right' | null
    this.path = [];
    this.lastMoveAt = 0;
    this.movedAcc = 0;
    this.touchTimer = null;
    this.touchStart = null;
    this.bind();
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('dragstart', (e) => e.preventDefault());
  }

  onDown(e) {
    this.h.activity?.();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch') {
      const n = this.pointers.size;
      if (n === 1) {
        this.touchStart = { x: e.clientX, y: e.clientY, t: performance.now() };
        clearTimeout(this.touchTimer);
        this.touchTimer = setTimeout(() => {
          if (this.pointers.size === 1 && !this.mode) this.begin('left', this.touchStart.x, this.touchStart.y);
        }, 140);
      } else if (n === 2 && !this.mode) {
        clearTimeout(this.touchTimer);
        const pts = [...this.pointers.values()];
        this.begin('right', (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      } else if (n === 3) {
        clearTimeout(this.touchTimer);
        this.cancelMode();
        this.h.recolor?.();
      }
      return;
    }
    if (e.button === 0) this.begin('left', e.clientX, e.clientY);
    else if (e.button === 2) this.begin('right', e.clientX, e.clientY);
    else if (e.button === 1) { e.preventDefault(); this.h.recolor?.(); }
  }

  begin(mode, cx, cy) {
    const [x, z] = this.toWorld(cx, cy);
    this.mode = mode;
    this.path = [{ x, z, t: performance.now() }];
    this.lastMoveAt = performance.now();
    this.movedAcc = 0;
    if (mode === 'left') { this.h.poke?.(x, z); this.h.dragStart?.(x, z); }
    else { this.h.feed?.(x, z); }
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.h.activity?.();
    const p = this.pointers.get(e.pointerId);
    p.x = e.clientX; p.y = e.clientY;
    if (!this.mode) return;
    let cx = e.clientX, cy = e.clientY;
    if (e.pointerType === 'touch' && this.mode === 'right' && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      cx = (pts[0].x + pts[1].x) / 2; cy = (pts[0].y + pts[1].y) / 2;
    }
    const now = performance.now();
    // Every sub-frame sample the browser coalesced goes into the path, so a fast swish is a polyline
    // and not one chord; the handler stays throttled, because it drives audio and sim drops.
    const raw = (this.mode === 'left' && e.getCoalescedEvents?.().length) ? e.getCoalescedEvents() : null;
    let added = 0;
    if (raw) {
      for (const s of raw) {
        const [x, z] = this.toWorld(s.clientX, s.clientY);
        const last = this.path[this.path.length - 1];
        const d = Math.hypot(x - last.x, z - last.z);
        if (d < 0.04) continue;
        this.path.push({ x, z, t: now });
        this.movedAcc += d;
        added++;
      }
    } else {
      const [x, z] = this.toWorld(cx, cy);
      const last = this.path[this.path.length - 1];
      const d = Math.hypot(x - last.x, z - last.z);
      if (d < 0.04) return;
      this.path.push({ x, z, t: now });
      this.movedAcc += d;
      added = 1;
    }
    if (!added || now - this.lastMoveAt < 40) return;
    this.lastMoveAt = now;
    const tip = this.path[this.path.length - 1];
    const moved = this.movedAcc;
    this.movedAcc = 0;
    if (this.mode === 'left') this.h.dragMove?.(tip.x, tip.z, moved, this.path);
    else this.h.feedDragMove?.(tip.x, tip.z, moved, this.path);
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (e.pointerType === 'touch') {
      clearTimeout(this.touchTimer);
      if (this.pointers.size > 0) return;     // wait for the last finger
    }
    this.endMode();
  }

  cancelMode() { this.mode = null; this.path = []; }

  endMode() {
    if (!this.mode) return;
    const mode = this.mode, path = this.path;
    this.mode = null; this.path = [];
    if (mode === 'left') this.h.dragEnd?.(path);
    else this.h.feedDragEnd?.(path);
  }
}

/* Did this path come back near its start after wandering out? Returns centroid + radius or null. */
export function detectLoop(path) {
  if (path.length < 12) return null;
  const a = path[0], b = path[path.length - 1];
  let cx = 0, cz = 0, maxD = 0;
  for (const p of path) { cx += p.x; cz += p.z; }
  cx /= path.length; cz /= path.length;
  for (const p of path) maxD = Math.max(maxD, Math.hypot(p.x - cx, p.z - cz));
  const closes = Math.hypot(a.x - b.x, a.z - b.z) < Math.max(0.6, maxD * 0.5);
  if (!closes || maxD < 0.6) return null;
  return { x: cx, z: cz, radius: maxD };
}
