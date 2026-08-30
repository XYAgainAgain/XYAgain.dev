/* Dev-only mix console (?mixer=1): audition every slot, drag its level, and copy the
   result as JSON to bake into DEFAULT_MIX. Never loads in normal visits. */

const BUSES = [
  ['ambience', 'Ambience bus'],
  ['eel', 'Eel bus'],
  ['env', 'Env bus'],
];

const ROWS = [
  { key: 'ambient', label: 'ambient bed' },
  { key: 'plip', label: 'plip', fire: (a) => a.plip(1) },
  { key: 'swish', label: 'swish loop', toggle: true },
  { key: 'plopBig', label: 'plop big', fire: (a) => a.plop('big') },
  { key: 'plopSmol', label: 'plop smol', fire: (a) => a.plop('smol') },
  { key: 'startle', label: 'eel startle', fire: (a) => a.startle() },
  { key: 'eleanorStartle', label: 'eleanor startle', fire: (a) => a.shot('eleanor', 0, 'eleanorStartle', { jitter: 0.2, trim: true }) },
  { key: 'crackleLil', label: 'crackle lil', fire: (a) => a.crackle('lil', { force: true }) },
  { key: 'crackleMed', label: 'crackle med', fire: (a) => a.crackle('med', { force: true }) },
  { key: 'crackleBig', label: 'crackle big', fire: (a) => a.crackle('big', { force: true }) },
  { key: 'eat', label: 'eel eat', multi: [['1', (a) => a.eat(1)], ['2', (a) => a.eat(2)], ['3', (a) => a.eat(3)]] },
  { key: 'slurp', label: 'slurp', fire: (a) => a.slurp() },
  { key: 'tinyBub', label: 'tiny bubs', fire: (a) => a.tinyBub() },
  { key: 'shortBub', label: 'short bubs', fire: (a) => a.shortBub() },
  { key: 'drip', label: 'pad drip', fire: (a) => a.drip() },
  { key: 'padSettle', label: 'pad settle', fire: (a) => a.padSettle() },
];

const CSS = `
#mixer { position: fixed; top: 8px; right: 8px; z-index: 1000; width: 300px; max-height: 92vh;
  overflow-y: auto; background: rgba(10, 14, 20, 0.92); color: #cfd8e3; border: 1px solid #2a3548;
  border-radius: 8px; padding: 10px 12px; font: 11px/1.5 ui-monospace, Consolas, monospace; }
#mixer h3 { margin: 6px 0 4px; font-size: 11px; color: #8fa3bd; text-transform: uppercase; letter-spacing: 0.08em; }
#mixer .row { display: grid; grid-template-columns: 92px 1fr 34px; gap: 6px; align-items: center; margin: 2px 0; }
#mixer .row .fire { display: flex; gap: 3px; }
#mixer button { background: #1d2735; color: #cfd8e3; border: 1px solid #33415a; border-radius: 4px;
  padding: 1px 6px; font: inherit; cursor: pointer; }
#mixer button:hover { background: #2a3850; }
#mixer button.on { background: #3a5a3a; }
#mixer input[type=range] { width: 100%; accent-color: #6fa8dc; }
#mixer .val { text-align: right; color: #8fa3bd; }
#mixer .bar { display: flex; gap: 6px; margin-top: 8px; }
`;

export function attachMixer(audio) {
  document.getElementById('mixer')?.remove();
  const style = document.createElement('style');
  style.textContent = CSS;
  const panel = document.createElement('div');
  panel.id = 'mixer';
  panel.append(style);

  const ensure = async () => {
    if (!audio.unlocked) { await audio.unlock(); audio.setMuted(false); }
  };
  const btn = (text, onClick) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', async () => { await ensure(); onClick(b); });
    return b;
  };
  const slider = (min, max, value, onInput) => {
    const s = document.createElement('input');
    s.type = 'range'; s.min = min; s.max = max; s.step = 0.5; s.value = value;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = value;
    s.addEventListener('input', () => { val.textContent = s.value; onInput(s.valueAsNumber); });
    return [s, val];
  };
  const row = (label, fires, sliderEl, valEl) => {
    const r = document.createElement('div');
    r.className = 'row';
    const name = document.createElement('div');
    name.textContent = label;
    const fireBox = document.createElement('div');
    fireBox.className = 'fire';
    fireBox.append(name, ...fires);
    r.append(fireBox, sliderEl, valEl);
    return r;
  };

  const h = (t) => { const e = document.createElement('h3'); e.textContent = t; return e; };
  panel.append(h('Buses (dB)'));
  for (const [key, label] of BUSES) {
    const [s, v] = slider(-24, 6, audio.mix.buses[key], (db) => audio.setBus(key, db));
    panel.append(row(label, [], s, v));
  }

  panel.append(h('Slots (dB)'));
  for (const def of ROWS) {
    const fires = [];
    if (def.fire) fires.push(btn('▶', () => def.fire(audio)));
    if (def.multi) for (const [t, f] of def.multi) fires.push(btn(t, () => f(audio)));
    if (def.toggle) fires.push(btn('▶', (b) => {
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      audio.swish(on);
    }));
    const [s, v] = slider(-40, 0, audio.mix.levels[def.key], (db) => audio.setLevel(def.key, db));
    panel.append(row(def.label, fires, s, v));
  }

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.append(
    btn('stop all', () => audio.stopAll()),
    btn('copy mix', async (b) => {
      const json = JSON.stringify(audio.mix, null, 2);
      console.log('Pond mix:', json);
      try { await navigator.clipboard.writeText(json); b.textContent = 'copied!'; setTimeout(() => { b.textContent = 'copy mix'; }, 1200); }
      catch { b.textContent = 'see console'; setTimeout(() => { b.textContent = 'copy mix'; }, 1200); }
    }),
    btn('reset', () => { audio.resetMix(); attachMixer(audio); }),
  );
  panel.append(bar);
  document.body.append(panel);
}
