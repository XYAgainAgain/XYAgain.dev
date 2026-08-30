import { NAME_LIFT } from './config.js';

/* Name tags for the cast: one absolutely positioned span per eel, parked over its head every frame.
   DOM rather than sprites, so the labels stay crisp and inherit the site's typeface for free. */
export class NameLabels {
  constructor(container, view) {
    this.container = container;
    this.view = view;
    this.enabled = false;
    // Keyed by the eel object, which outlives an identity swap; only e.name changes under it.
    this.labels = new Map();
  }

  setEnabled(on) {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) for (const el of this.labels.values()) el.hidden = true;
  }

  update(eels) {
    if (!this.enabled) return;
    const live = eels.enabled;
    for (const e of eels.eels) this.place(e, live);
    for (const e of eels.guests) this.place(e, live);
  }

  place(e, live) {
    let el = this.labels.get(e);
    if (!el) {
      el = document.createElement('span');
      el.className = 'eel-name';
      el.append(document.createElement('span'), document.createElement('small'));
      this.container.appendChild(el);
      this.labels.set(e, el);
    }
    if (!live || !e.body?.visible) { el.hidden = true; return; }
    const h = e.head;
    const x = (h.x / this.view.w + 0.5) * innerWidth;
    const y = ((h.z - NAME_LIFT) / this.view.h + 0.5) * innerHeight;
    // A tenth of the viewport of slack, so a tag only pops once its eel is well clear of the frame.
    const mx = innerWidth * 0.1, my = innerHeight * 0.1;
    // The NaN check ends the haunting: a poisoned eel once vanished but left its frozen tag on screen.
    if (!Number.isFinite(x + y) || x < -mx || x > innerWidth + mx || y < -my || y > innerHeight + my) { el.hidden = true; return; }
    // A nickname wins when one has been rolled; comparing each frame catches rerolls and hot-swaps alike.
    const label = e.nick ?? e.name, pro = e.pronouns ?? '';
    if (el.firstChild.textContent !== label) el.firstChild.textContent = label;
    if (el.lastChild.textContent !== pro) el.lastChild.textContent = pro;
    if (e.nameStyle && el.dataset.tint !== e.nameStyle) { el.dataset.tint = e.nameStyle; el.style.color = e.nameStyle; }
    el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.hidden = false;
  }
}
