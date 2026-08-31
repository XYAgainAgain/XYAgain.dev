import { IDLE_FADE_MS, JUNK_KEY, NAMES_KEY, STORAGE_KEY } from './config.js';

/* The eel gate, idle fade, sound button + volume dropdown, and the chrome toggles. Pure DOM, no rendering. */
export function readEelChoice() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function writeEelChoice(v) {
  try { localStorage.setItem(STORAGE_KEY, v); } catch {}
}

function readNamesChoice() {
  try { return localStorage.getItem(NAMES_KEY); } catch { return null; }
}

function writeNamesChoice(v) {
  try { localStorage.setItem(NAMES_KEY, v); } catch {}
}

export function setupIdleFade(root) {
  let timer = null, deadline = 0, idle = false;
  const check = () => {
    const left = deadline - performance.now();
    if (left > 0) { timer = setTimeout(check, left); return; }
    timer = null; idle = true; root.classList.add('is-idle');
  };
  const wake = () => {
    deadline = performance.now() + IDLE_FADE_MS;
    if (idle) { idle = false; root.classList.remove('is-idle'); }
    if (timer === null) timer = setTimeout(check, IDLE_FADE_MS);
  };
  ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
  wake();
  return wake;
}

/* Shows the gate dialog; resolves 'yes' | 'no'. */
export function askAboutEels(dialog) {
  return new Promise((resolve) => {
    const yes = dialog.querySelector('[data-eels="yes"]');
    const no = dialog.querySelector('[data-eels="no"]');
    const finish = (v) => { dialog.close(); resolve(v); };
    yes.addEventListener('click', () => finish('yes'), { once: true });
    no.addEventListener('click', () => finish('no'), { once: true });
    dialog.addEventListener('cancel', (e) => e.preventDefault());
    dialog.showModal();
    yes.focus();
  });
}

export function bindSoundButton(btn, panel, audio, rowMute) {
  const master = panel.querySelector('#volume');
  const busSliders = [...panel.querySelectorAll('[data-bus]')];
  const sound = btn.closest('.sound');
  const drawer = document.getElementById('controls-drawer');
  const render = () => {
    const silent = !audio.unlocked || audio.muted;
    const state = !audio.unlocked ? 'locked' : audio.muted ? 'muted' : 'on';
    // jelly-icon-button syncs its label attribute onto the inner button's aria-label.
    btn.dataset.state = state;
    btn.setAttribute('label', 'Sound mixer');
    rowMute.dataset.state = state;
    rowMute.setAttribute('label', !audio.unlocked ? 'Turn sound on' : audio.muted ? 'Unmute' : 'Mute');
    // Muted greys the whole mixer out; the row speaker is the only way back.
    for (const s of [master, ...busSliders]) s.toggleAttribute('disabled', silent);
    master.value = String(Math.round(audio.volume * 100));
    for (const s of busSliders) s.value = String(Math.round(audio.busVolume(s.dataset.bus) * 100));
  };
  const toggleSilent = async (wantSilent) => {
    if (!audio.unlocked) {
      if (!wantSilent) {
        // A failed unlock must not wedge the mixer: re-render so everything stays clickable for a retry.
        try { await audio.unlock(); audio.setMuted(false); } catch (err) { console.warn('Pond: audio unlock failed', err); }
      }
    } else audio.setMuted(wantSilent);
    render();
  };
  // The big button only pins the mixer open now; muting lives on the row speaker. The pin and the
  // Controls drawer are mutually exclusive so the two panels never stack.
  btn.addEventListener('click', () => {
    if (sound.classList.toggle('pinned')) drawer.open = false;
  });
  drawer.addEventListener('toggle', () => { if (drawer.open) sound.classList.remove('pinned'); });
  rowMute.addEventListener('click', () => toggleSilent(audio.unlocked && !audio.muted));
  master.addEventListener('input', () => {
    const v = Number(master.value);
    audio.setVolume(v / 100);
    if (audio.muted && v > 0) audio.setMuted(false);
    render();
  });
  for (const s of busSliders) s.addEventListener('input', () => audio.setBusVolume(s.dataset.bus, Number(s.value) / 100));
  audio.onState = render;
  render();
}

export function bindEelToggle(sw, onChange) {
  const render = (v) => { sw.checked = v === 'yes'; };
  sw.addEventListener('change', () => {
    const next = sw.checked ? 'yes' : 'no';
    writeEelChoice(next);
    onChange(next);
  });
  render(readEelChoice());
  return render;
}

/* Names default off, and nothing else drives them, so the stored choice is pushed out at bind time. */
export function bindNamesToggle(sw, onChange) {
  const render = (v) => { sw.checked = v === 'on'; };
  sw.addEventListener('change', () => {
    const next = sw.checked ? 'on' : 'off';
    writeNamesChoice(next);
    onChange(next === 'on');
  });
  const initial = readNamesChoice() === 'on' ? 'on' : 'off';
  render(initial);
  onChange(initial === 'on');
  return render;
}

/* UI junk: none condenses the chrome behind the moon button, some idle-fades, tons never hides.
   The mixer's slider rows are reparented into the drawer for none, so their state rides along. */
export function bindJunk({ seg, moon, drawer, cluster, volumeRows, volumeWrap, volumeDock }) {
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem(JUNK_KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(JUNK_KEY, v); } catch {} };
  const head = drawer.shadowRoot?.querySelector('.head');
  const chevron = drawer.shadowRoot?.querySelector('.chevron');
  // Controls moved while hidden measure 0×0 and jelly skips the rebuild; re-shape once visible.
  const refreshMixer = () => requestAnimationFrame(() => {
    for (const c of volumeRows.querySelectorAll('jelly-slider, jelly-icon-button')) { c.applyShape?.(); c.requestFrame?.(); }
  });
  const apply = (v) => {
    root.dataset.junk = v;
    if (v === 'none') { volumeDock.append(volumeRows); drawer.open = false; }
    else { volumeWrap.append(volumeRows); root.classList.remove('moon-open'); drawer.open = false; refreshMixer(); }
    // The moon docks over the chevron in none mode, and the header stops being a collapse control there.
    if (chevron) chevron.style.display = v === 'none' ? 'none' : '';
    seg.value = v;
  };
  // Capture on the shadow root outruns the component's own header listener: in moon mode, clicking
  // "Controls" dismisses the whole panel instead of collapsing the drawer downward inside it.
  drawer.shadowRoot?.addEventListener('click', (e) => {
    if (root.dataset.junk !== 'none' || !head || !e.composedPath().includes(head)) return;
    e.stopPropagation();
    root.classList.remove('moon-open');
    drawer.open = false;
    moon.focus?.();
  }, true);
  seg.addEventListener('change', (e) => {
    const v = e.detail?.value || seg.value || 'some';
    write(v);
    apply(v);
  });
  // The drawer's open state tracks panel visibility exactly, or aria-expanded lies while hidden.
  moon.addEventListener('click', () => {
    if (root.classList.toggle('moon-open')) { drawer.open = true; refreshMixer(); }
    else drawer.open = false;
    // Discovered: from here on the moon may idle-fade with the rest of the chrome.
    root.classList.remove('moon-unseen');
    try { localStorage.setItem('xy.moonseen', '1'); } catch {}
  });
  try { if (!localStorage.getItem('xy.moonseen')) root.classList.add('moon-unseen'); } catch { root.classList.add('moon-unseen'); }
  document.addEventListener('pointerdown', (e) => {
    if (root.classList.contains('moon-open') && !e.composedPath().includes(cluster)) {
      root.classList.remove('moon-open');
      drawer.open = false;
    }
  }, true);
  // The moon rides the water: a pinch rotating around the rim plus a slow slosh, so the deformation
  // travels coherently like a reflection instead of jittering. Driven through the public physics body.
  const knobs = { ripple: 0.045, mod: 0.5, spin: 0.32, slosh: 0.35, sloshRate: 0.23, tick: 90, hoverBoost: 1.25 };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let phase = 0, t0 = performance.now(), hovered = false;
  moon.addEventListener('pointerenter', () => { hovered = true; });
  moon.addEventListener('pointerleave', () => { hovered = false; });
  const lap = () => {
    setTimeout(lap, knobs.tick);
    const b = moon.body;
    if (root.dataset.junk !== 'none' || reduce.matches || !b) return;
    phase += knobs.spin;
    const t = (performance.now() - t0) / 1000;
    const amp = knobs.ripple * (1 - knobs.mod / 2 + (knobs.mod / 2) * Math.sin(t * 0.9)) * (hovered ? knobs.hoverBoost : 1);
    const rx = b.width / 2, ry = b.height / 2;
    b.pulseAt?.(Math.cos(phase) * rx, Math.sin(phase) * ry, amp);
    b.pulseAt?.(-Math.cos(phase) * rx, -Math.sin(phase) * ry, amp * 0.7);
    b.stretchAlong?.(Math.cos(t * knobs.sloshRate * Math.PI * 2), Math.sin(t * knobs.sloshRate * Math.PI * 2), knobs.slosh * 0.01 * (hovered ? knobs.hoverBoost : 1));
    // A direct body poke never repaints on its own; requestFrame restarts the paint loop.
    moon.requestFrame?.();
  };
  lap();
  const stored = read();
  // Small screens open condensed by default; a stored choice always wins.
  const fallback = matchMedia('(max-width: 720px)').matches ? 'none' : 'some';
  apply(stored === 'none' || stored === 'some' || stored === 'tons' ? stored : fallback);
  return knobs;
}
