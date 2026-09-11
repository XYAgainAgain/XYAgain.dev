const SPEED_WINDOW = 80;   // ms of path the reported pointer speed is measured over
const STILL_MOVE = 0.05;   // world units a pointer has to travel before it counts as having moved

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
    this.stillAcc = 0;
    this.hoverAt = 0;
    // The published snapshot. gestureId counts presses so a rhythm reader can tell one hold from the
    // next, and speed is deliberately uncapped: the flora's 3 units/s clamp stays local to the flora.
    this.snapshot = { mode: 'none', gestureId: 0, x: 0, z: 0, vx: 0, vz: 0, speed: 0, moveSeq: 0 };
    this.bind();
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    // A null relatedTarget means that pointer left the document, not that it slid under the chrome:
    // the only way a mouse dragged out of the window ever ends, and only for the pointer that left.
    document.addEventListener('pointerout', (e) => {
      if (e.pointerType === 'touch' || e.relatedTarget || !this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      this.endMode();
    });
    c.addEventListener('dragstart', (e) => e.preventDefault());
  }

  onDown(e) {
    this.h.activity?.();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch') {
      const n = this.pointers.size;
      // A second finger voids the pending tap, so releasing a feed can never fake a poke.
      if (n > 1) this.touchStart = null;
      if (n === 1) {
        this.touchStart = { x: e.clientX, y: e.clientY, t: performance.now() };
        clearTimeout(this.touchTimer);
        this.touchTimer = setTimeout(() => {
          const t = this.touchStart;
          this.touchStart = null;
          if (t && this.pointers.size === 1 && !this.mode) this.begin('left', t.x, t.y);
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
    this.stillAcc = 0;
    const s = this.snapshot;
    s.gestureId++;
    s.mode = mode === 'left' ? 'poke' : 'feed';
    s.x = x; s.z = z; s.vx = 0; s.vz = 0; s.speed = 0;
    this.h.input?.(s);
    if (mode === 'left') { this.h.poke?.(x, z); this.h.dragStart?.(x, z); }
    else { this.h.feed?.(x, z); }
  }

  /* Uncapped pointer speed over the last 80 ms of samples; a tip older than the window reads zero,
     which is what makes a held-still hand look still rather than frozen mid-flick. */
  measure(now) {
    const p = this.path, n = p.length, s = this.snapshot;
    if (n < 2 || now - p[n - 1].t > SPEED_WINDOW) { s.vx = 0; s.vz = 0; s.speed = 0; return; }
    let i = n - 1;
    while (i > 0 && now - p[i - 1].t <= SPEED_WINDOW) i--;
    const a = p[i], b = p[n - 1];
    const span = Math.max(1e-3, (b.t - a.t) / 1000);
    s.vx = (b.x - a.x) / span; s.vz = (b.z - a.z) / span;
    s.speed = Math.hypot(s.vx, s.vz);
  }

  /* A hand over the water with no button down. Position only: no gesture, no path, no speed measured.
     Without it the cursor reads as parked wherever the last gesture ended, and a throw at the moment
     of a click has no recent hand movement to inherit. Faster than the 40 ms handler throttle on
     purpose: the throw's velocity window is only about 56 ms, and 40 ms quantizes it badly. */
  hover(e) {
    if (this.mode || e.pointerType === 'touch') return;
    const now = performance.now();
    if (now - this.hoverAt < 16) return;
    const gap = now - this.hoverAt > 200;
    this.hoverAt = now;
    const [x, z] = this.toWorld(e.clientX, e.clientY);
    this.h.hover?.(x, z, gap);
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return this.hover(e);
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
    // Coalesced samples carry their own timeStamp, shifted onto this clock: stamping a whole batch
    // with now() collapses measure()'s span and reads an ordinary move as an extreme flick.
    const skew = Number.isFinite(e.timeStamp) ? now - e.timeStamp : 0;
    let added = 0;
    if (raw) {
      for (const c of raw) {
        const [x, z] = this.toWorld(c.clientX, c.clientY);
        const last = this.path[this.path.length - 1];
        const d = Math.hypot(x - last.x, z - last.z);
        if (d < 0.04) continue;
        this.path.push({ x, z, t: Number.isFinite(c.timeStamp) ? c.timeStamp + skew : now });
        this.movedAcc += d;
        this.stillAcc += d;
        added++;
      }
    } else {
      const [x, z] = this.toWorld(cx, cy);
      const last = this.path[this.path.length - 1];
      const d = Math.hypot(x - last.x, z - last.z);
      if (d < 0.04) return;
      this.path.push({ x, z, t: now });
      this.movedAcc += d;
      this.stillAcc += d;
      added = 1;
    }
    if (!added || now - this.lastMoveAt < 40) return;
    this.lastMoveAt = now;
    const tip = this.path[this.path.length - 1];
    const s = this.snapshot;
    if (this.mode === 'left') s.mode = 'drag';
    s.x = tip.x; s.z = tip.z;
    if (this.stillAcc >= STILL_MOVE) { this.stillAcc = 0; s.moveSeq++; }
    this.measure(now);
    this.h.input?.(s);
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
      // A one-finger drag waits for the last finger, but a two-finger feed is over the moment it
      // stops being two: waiting left the hold live and it kept dropping crumbs.
      if (this.pointers.size > 0 && this.mode !== 'right') return;
      // A tap released inside the hold-off never reached begin(), so fire it here or it is eaten.
      if (!this.mode && this.touchStart && this.pointers.size === 0) {
        const t = this.touchStart;
        this.touchStart = null;
        this.begin('left', t.x, t.y);
      }
    }
    this.endMode();
  }

  // The three-finger cancel still has to end the gesture, or a live feed hold drops crumbs forever.
  cancelMode() { this.path = []; if (this.mode) this.endMode(); else this.release(); }

  endMode() {
    if (!this.mode) return;
    const mode = this.mode, path = this.path;
    this.mode = null; this.path = [];
    this.release();
    if (mode === 'left') this.h.dragEnd?.(path);
    else this.h.feedDragEnd?.(path);
  }

  release() {
    const s = this.snapshot;
    s.mode = 'none'; s.vx = 0; s.vz = 0; s.speed = 0;
    this.h.input?.(s);
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
