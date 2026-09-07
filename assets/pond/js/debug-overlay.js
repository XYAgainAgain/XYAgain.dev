/* ?debug=1&overlay=brain: each resident's context rings as a small polar plot over its head. Reads
   sys.braincell.debug(e) and nothing else; without the flag the module is never even imported. */

const R = 26;              // plot radius in CSS pixels
const DPR_CAP = 2;

export class BrainOverlay {
  constructor(view) {
    this.view = view;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'fixed', inset: '0', zIndex: '2', pointerEvents: 'none',
    });
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.w = 0; this.h = 0;
  }

  fit() {
    const dpr = Math.min(devicePixelRatio || 1, DPR_CAP);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (w === this.w && h === this.h) return dpr;
    this.canvas.width = this.w = w;
    this.canvas.height = this.h = h;
    this.canvas.style.width = `${innerWidth}px`;
    this.canvas.style.height = `${innerHeight}px`;
    return dpr;
  }

  update(sys) {
    const brain = sys.braincell;
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = this.fit();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!brain || !sys.enabled) return;
    for (const e of sys.eels) {
      const d = brain.debug(e);
      if (!d) continue;
      // Same head-to-screen mapping the name tags use, so a plot sits where its eel is.
      const x = (e.head.x / this.view.w + 0.5) * innerWidth;
      const y = (e.head.z / this.view.h + 0.5) * innerHeight;
      if (!Number.isFinite(x + y)) continue;
      this.plot(ctx, x, y, d);
    }
  }

  plot(ctx, cx, cy, d) {
    const n = d.n, step = Math.PI * 2 / n;
    let peak = 1e-6;
    for (let k = 0; k < n; k++) if (d.interest[k] > peak) peak = d.interest[k];
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    for (let k = 0; k < n; k++) {
      const a = k * step, ca = Math.cos(a), sa = Math.sin(a);
      const gi = R * 0.25 + R * 0.7 * (d.interest[k] / peak);
      ctx.strokeStyle = 'rgba(90,230,130,0.65)';
      ctx.beginPath();
      ctx.moveTo(cx + ca * R * 0.25, cy + sa * R * 0.25);
      ctx.lineTo(cx + ca * gi, cy + sa * gi);
      ctx.stroke();
      const dv = Math.min(1, d.danger[k]);
      if (dv <= 0.001) continue;
      ctx.strokeStyle = `rgba(255,80,70,${0.35 + 0.55 * dv})`;
      ctx.beginPath();
      ctx.moveTo(cx + ca * R, cy + sa * R);
      ctx.lineTo(cx + ca * (R + 8 * dv), cy + sa * (R + 8 * dv));
      ctx.stroke();
    }
    const hc = Math.cos(d.heading), hs = Math.sin(d.heading);
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + hc * R * 0.2, cy + hs * R * 0.2);
    ctx.lineTo(cx + hc * (R + 6), cy + hs * (R + 6));
    ctx.stroke();
    if (!d.routing && !d.boxed) return;
    ctx.fillStyle = d.boxed ? '#ff4b3e' : '#ffd166';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  dispose() { this.canvas.remove(); }
}
