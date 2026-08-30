import { IDLE_FADE_MS, NAMES_KEY, STORAGE_KEY } from './config.js';

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

export function bindSoundButton(btn, panel, audio) {
  const master = panel.querySelector('#volume');
  const busSliders = [...panel.querySelectorAll('[data-bus]')];
  const render = () => {
    const off = !audio.unlocked || audio.muted;
    btn.setAttribute('aria-pressed', String(!off));
    btn.dataset.state = !audio.unlocked ? 'locked' : audio.muted ? 'muted' : 'on';
    btn.setAttribute('aria-label', !audio.unlocked ? 'Turn sound on' : audio.muted ? 'Unmute' : 'Mute');
    master.value = String(Math.round(audio.volume * 100));
    for (const s of busSliders) s.value = String(Math.round(audio.busVolume(s.dataset.bus) * 100));
  };
  btn.addEventListener('click', async () => {
    if (!audio.unlocked) { await audio.unlock(); audio.setMuted(false); }
    else audio.setMuted(!audio.muted);
    render();
  });
  master.addEventListener('input', () => {
    audio.setVolume(master.valueAsNumber / 100);
    if (audio.muted && master.valueAsNumber > 0) audio.setMuted(false);
    render();
  });
  for (const s of busSliders) s.addEventListener('input', () => audio.setBusVolume(s.dataset.bus, s.valueAsNumber / 100));
  audio.onState = render;
  render();
}

export function bindEelToggle(btn, onChange) {
  const render = (v) => {
    btn.setAttribute('aria-pressed', String(v === 'yes'));
    btn.textContent = v === 'yes' ? 'eels: on' : 'eels: off';
  };
  btn.addEventListener('click', () => {
    const next = readEelChoice() === 'yes' ? 'no' : 'yes';
    writeEelChoice(next);
    render(next);
    onChange(next);
  });
  render(readEelChoice());
  return render;
}

/* Names default off, and nothing else drives them, so the stored choice is pushed out at bind time. */
export function bindNamesToggle(btn, onChange) {
  const render = (v) => {
    btn.setAttribute('aria-pressed', String(v === 'on'));
    btn.textContent = v === 'on' ? 'names: on' : 'names: off';
  };
  btn.addEventListener('click', () => {
    const next = readNamesChoice() === 'on' ? 'off' : 'on';
    writeNamesChoice(next);
    render(next);
    onChange(next === 'on');
  });
  const initial = readNamesChoice() === 'on' ? 'on' : 'off';
  render(initial);
  onChange(initial === 'on');
  return render;
}
