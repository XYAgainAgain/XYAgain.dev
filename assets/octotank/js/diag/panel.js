import { list as scenarioList, isRunning, onRegister } from './scenarios.js';

/* The dev panel: tabs of collapsible sections of controls, each a button and a key, a key legend on ?, and the readout.
   Each action is { key, name, label(), run(), disabled? }; the first action to claim a key keeps it. */

const FRAMES = 120;
const STORE = 'octotank.panel';
const SECTIONS = [['sim', 'Sim'], ['view', 'View'], ['body', 'Body'], ['bench', 'Bench'], ['arms', 'Arms'], ['rod', 'Rod'], ['loco', 'Locomotion']];
// Section ids per tab, in display order; a section no tab names lands in the last one. A tab with no sections hides.
const TABS = [['amira', 'Amira', ['body', 'loco']], ['arms', 'Arms', ['arms', 'rod', 'bench']], ['tank', 'Tank', ['sim', 'sand']], ['view', 'View', ['view', 'camera']], ['more', 'More', []]];

const queued = [];
let attach = null;

/* Lets any module add a control to a section, before or after the panel exists:
   section('view').add({ key: 'n', name: 'Normals', label: () => 'Normals', run }). An unknown name makes a new section. */
export function section(name) {
  const api = { add(action) { if (attach) attach(name, action); else queued.push([name, action]); return api; } };
  return api;
}

const hintOf = (key) => (key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key);
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const load = () => { try { return plain(JSON.parse(localStorage.getItem(STORE))); } catch { return {}; } };
const save = (s) => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage blocked */ } };
const tag = (name, props = {}, ...kids) => { const e = Object.assign(document.createElement(name), props); e.append(...kids); return e; };

/* The most active arm's peak activation per muscle group (transverse, the four longitudinals from the sucker side, the
   two obliques) and the stiffest its bracing makes any joint. */
function muscleLine(arms) {
  let best = null, most = -1;
  for (const arm of arms.arms) { if (!arm.act) continue; let s = 0; for (const v of arm.act) s += v; if (s > most) { most = s; best = arm; } }
  if (!best) return 'Muscles  on';
  const S = best.n - 1, A = best.act, peak = (g) => { let m = 0; for (let j = 0; j < S; j++) m = Math.max(m, A[g * S + j]); return m.toFixed(2); };
  let brace = 1;
  for (let j = 0; j < S; j++) brace = Math.max(brace, best.mus.bendStiff[j]);
  return `Muscles  arm ${best.index}   T ${peak(0)}   L ${peak(1)} ${peak(2)} ${peak(3)} ${peak(4)}   O ${peak(5)} ${peak(6)}   braced ×${brace.toFixed(2)}`;
}

/* One arm-record event: the arm (omitted on the bench), the new label or the event and what it concerns, and its repeats. */
const eventText = (e, arm = true) => `${arm ? `${e.arm} ` : ''}${e.kind === 'label' ? `→ ${e.text}` : `${e.kind}${e.text ? ` ${e.text}` : ''}`}${e.count > 1 ? ` ×${e.count}` : ''}`;

export function createPanel({ el, readout, controls, ctx, tank, toys, seed, say }) {
  const { phys, mantle, arms, pose } = ctx;
  const loco = ctx.loco, bench = ctx.bench ?? null;
  const gaps = new Float32Array(FRAMES);
  let gapCount = 0, lastFrame = 0, textAt = 0, breathDepth = mantle.knobs.breathDepth || 0.035, lastExhale = 0, inhaling = false;
  const state = { paused: false };
  const DRIVES = ['force', 'pin', 'free'];
  const stored = load();
  stored.open = plain(stored.open);
  const remember = () => save(stored);

  let head = el.querySelector('.panel-head'), legend = el.querySelector('#panel-keys');
  if (!head) el.prepend(head = tag('div', { className: 'panel-head' }));
  if (!legend) head.after(legend = tag('div', { id: 'panel-keys', hidden: true }));
  const readoutBox = readout.closest('details');

  let tablist = el.querySelector('[role="tablist"]');
  if (!tablist) {
    controls.before(tablist = tag('div', { className: 'panel-tabs' }));
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Panel sections');
  }
  let active = null, ready = false;
  const tabs = TABS.map(([id, title, members]) => {
    const tab = tag('button', { type: 'button', id: `panel-tab-${id}`, textContent: title, hidden: true, tabIndex: -1 });
    const pane = tag('div', { id: `panel-pane-${id}`, hidden: true });
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', pane.id);
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tab.id);
    tablist.append(tab);
    controls.append(pane);
    return { id, tab, pane, members };
  });
  const select = (t, focus = false) => {
    for (const x of tabs) {
      const on = x === t;
      x.tab.setAttribute('aria-selected', String(on));
      x.tab.tabIndex = on ? 0 : -1;
      x.pane.hidden = !on;
    }
    active = t;
    if (focus) t.tab.focus();
  };
  const choose = (t, focus) => { select(t, focus); stored.tab = t.id; remember(); };
  for (const t of tabs) t.tab.addEventListener('click', () => choose(t));
  tablist.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const shown = tabs.filter((x) => !x.tab.hidden), i = shown.findIndex((x) => x.tab === ev.target);
    const next = i < 0 ? undefined : { ArrowRight: i + 1, ArrowLeft: i - 1 + shown.length, Home: 0, End: shown.length - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    choose(shown[next % shown.length], true);
  });
  /* Shows a tab once it holds a section; a late-arriving section can still restore the remembered tab. */
  const reveal = (t) => {
    if (!t.tab.hidden) return;
    t.tab.hidden = false;
    if (ready && (!active || t.id === stored.tab)) select(t);
  };

  const squeeze = async () => {
    if (ctx.watch) return;
    say('squeezing');
    try {
      const r = await tank.squeeze();
      console.log('squeeze', r);
      say(r.passed ? 'squeeze: PASS' : 'squeeze: FAIL');
    } catch (err) { say(`squeeze: ${err.message}`); }
  };
  const setHidden = (on) => { el.classList.toggle('collapsed', on); stored.hidden = on; remember(); };
  const setLegend = (on) => { legend.hidden = !on; legendAction.button?.setAttribute('aria-expanded', String(on)); };

  const legendAction = { key: '?', name: 'Key legend', label: () => (legend.hidden ? 'Keys' : 'Hide keys'), run: () => setLegend(legend.hidden) };
  const headActions = [
    { key: 'h', name: 'Hide panel', label: () => (el.classList.contains('collapsed') ? 'Show panel' : 'Hide panel'), run: () => setHidden(!el.classList.contains('collapsed')) },
    legendAction,
  ];
  const bySection = {
    sim: [
      { key: ' ', name: 'Pause', label: () => (state.paused ? 'Resume' : 'Pause'), run: () => { state.paused = !state.paused; } },
      { key: 'r', name: 'Reload', label: () => 'Reload', run: () => location.reload() },
    ],
    view: [
      { key: 's', name: 'Suckers', label: () => (tank.suckerView?.visible ? 'Suckers: shown' : 'Suckers: hidden'), run: () => { if (tank.suckerView) tank.suckerView.visible = !tank.suckerView.visible; } },
      { key: 'c', name: 'Capsules', label: () => (tank.armView?.capsules ? 'Capsules: shown' : 'Capsules: hidden'), run: () => { if (tank.armView) tank.armView.capsules = !tank.armView.capsules; } },
      { key: 'd', name: 'Density tint', label: () => (ctx.water?.knobs.tint ? 'Density tint: on' : 'Density tint: off'), run: () => ctx.water?.setTint(!ctx.water.knobs.tint) },
    ],
    body: [
      { key: 'm', name: 'Drive mode', label: () => `Drive: ${mantle.drive}`, run: () => mantle.setDrive(DRIVES[(DRIVES.indexOf(mantle.drive) + 1) % DRIVES.length]) },
      {
        key: 'b', name: 'Breathing', label: () => (mantle.knobs.breathDepth > 0 ? 'Breathing: on' : 'Breathing: off'),
        run: () => {
          if (mantle.knobs.breathDepth > 0) { breathDepth = mantle.knobs.breathDepth; mantle.knobs.breathDepth = 0; }
          else mantle.knobs.breathDepth = breathDepth;
        },
      },
      { key: 't', name: 'Tip her', label: () => 'Tip her', run: () => mantle.tip(1.2) },
      { key: 'q', name: 'Squeeze test', label: () => (ctx.watch ? 'Squeezing…' : 'Squeeze test'), run: squeeze },
    ],
    arms: [
      { key: 'a', name: 'Reach toys', label: () => 'Reach toys', run: () => arms.reachNearestToys(toys) },
      { key: 'l', name: 'Look at a toy', label: () => 'Look at a toy', run: () => ctx.attention?.lookAndReach(), disabled: !ctx.attention },
      { key: 'i', name: 'Arms idle', label: () => 'Arms idle', run: () => arms.idle() },
      { key: 'f', name: 'Fetch held', label: () => 'Fetch held', run: () => arms.fetchHolding() },
      { key: 'g', name: 'Grip/let go', label: () => (arms.episodes.some((e) => e?.commanded) ? 'Let go' : 'Grip/let go'), run: () => say(`grip: ${arms.toggleGrip()}`) },
      { key: 'z', name: 'Resting/awake', label: () => (arms.resting ? 'Arms: resting' : 'Arms: awake'), run: () => { arms.resting = !arms.resting; } },
      { key: 'e', name: 'Muscles', label: () => (arms.knobs.muscle ? 'Muscles: on' : 'Muscles: off'), run: () => { arms.knobs.muscle = arms.knobs.muscle ? 0 : 1; } },
    ],
    loco: loco ? [{ key: 'w', name: 'Wander', label: () => (loco.knobs.wander ? 'Wander: on' : 'Wander: off'), run: () => { loco.knobs.wander = !loco.knobs.wander; } }] : [],
  };

  const keys = new Map(), warned = new Set();
  const all = () => [...headActions, ...sections.flatMap((s) => [...s.actions, ...s.scenarios])];
  const relabel = () => {
    for (const a of all()) {
      if (a.type === 'range') {
        const value = a.get(), text = a.label();
        const index = a.values.reduce((best, v, i) => Math.abs(v - value) < Math.abs(a.values[best] - value) ? i : best, 0);
        a.button.value = index;
        a.button.setAttribute('aria-valuetext', text);
        a.caption.textContent = text;
        continue;
      }
      const text = a.label();
      if (a.button.dataset.text === text) continue;
      a.button.dataset.text = text;
      a.button.firstChild.textContent = text;
    }
  };
  const fire = (a) => { a.run(); relabel(); };
  const button = (a) => {
    if (a.type === 'range') {
      const input = tag('input', { type: 'range', min: 0, max: a.values.length - 1, step: 1, disabled: !!a.disabled });
      input.setAttribute('aria-label', a.name);
      input.addEventListener('input', () => { a.set(a.values[Number(input.value)]); relabel(); });
      a.button = input;
      a.caption = tag('span');
      return tag('label', { className: 'btn' }, a.caption, input);
    }
    const b = tag('button', { type: 'button', className: 'btn' });
    b.append(tag('span'), tag('kbd', { hidden: true }));
    b.lastChild.setAttribute('aria-hidden', 'true');
    if (a.disabled) { b.disabled = true; b.title = 'not built yet'; }
    b.addEventListener('click', () => fire(a));
    a.button = b;
    return b;
  };

  /* Gives every action its key in tab order; a collision keeps the first claimant and warns once. */
  const rebind = () => {
    keys.clear();
    for (const a of all()) {
      if (a.type === 'range') { a.bound = null; continue; }
      const k = a.key ? String(a.key).toLowerCase() : null, kbd = a.button.lastChild;
      const other = k && keys.get(k);
      if (other) {
        const msg = `panel: key "${hintOf(k)}" is taken by "${other.name}", so "${a.name}" gets none`;
        if (!warned.has(msg)) { warned.add(msg); console.warn(msg); }
      }
      if (!k || other) { kbd.hidden = true; a.button.removeAttribute('aria-keyshortcuts'); a.bound = null; continue; }
      keys.set(k, a);
      a.bound = k;
      kbd.hidden = false;
      kbd.textContent = hintOf(k);
      a.button.setAttribute('aria-keyshortcuts', k === '?' ? 'Shift+?' : hintOf(k));
    }
    const ordered = [...sections].sort((x, y) => x.order[0] - y.order[0] || x.order[1] - y.order[1]);
    const groups = [['Panel', headActions], ...ordered.map((s) => [s.title, [...s.actions, ...s.scenarios]])];
    legend.replaceChildren(tag('p', { className: 'keys-title', textContent: 'Keys' }), ...groups.filter(([, as]) => as.some((a) => a.bound)).map(([title, as]) => tag('dl', {},
      tag('dt', { textContent: title }),
      tag('dd', {}, ...as.filter((a) => a.bound).map((a) => tag('span', {}, tag('kbd', { textContent: hintOf(a.bound) }), ` ${a.name}`))))));
  };

  const sections = [];
  const sectionFor = (name) => {
    const id = String(name).toLowerCase();
    let s = sections.find((x) => x.id === id || x.title.toLowerCase() === id);
    if (s) return s;
    const title = SECTIONS.find(([i]) => i === id)?.[1] ?? String(name);
    const details = tag('details', { className: 'sec', open: stored.open[id] ?? true });
    details.dataset.section = id;
    const row = tag('div', { className: 'row' });
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', title);
    const scRow = tag('div', { className: 'row' }), checks = tag('div', { className: 'row checks' });
    details.append(tag('summary', { textContent: title }), row, scRow, checks);
    details.addEventListener('toggle', () => { stored.open[id] = details.open; remember(); });
    const t = tabs.find((x) => x.members.includes(id)) ?? tabs[tabs.length - 1];
    const rank = (sid) => { const r = t.members.indexOf(sid); return r < 0 ? t.members.length : r; };
    t.pane.insertBefore(details, [...t.pane.children].find((d) => rank(d.dataset.section) > rank(id)) ?? null);
    reveal(t);
    s = { id, title, details, row, scRow, checks, actions: [], scenarios: [], order: [tabs.indexOf(t), rank(id)] };
    sections.push(s);
    return s;
  };
  const add = (name, a, quiet) => {
    const s = sectionFor(name);
    a.name ??= a.label();
    s.actions.push(a);
    s.row.append(button(a));
    if (!quiet) { rebind(); relabel(); }
  };

  head.append(...headActions.map(button));
  legendAction.button.setAttribute('aria-controls', legend.id || (legend.id = 'panel-keys'));
  legendAction.button.setAttribute('aria-expanded', 'false');
  for (const [id] of SECTIONS) {
    if ((id === 'loco' && !loco) || (id === 'body' && bench) || !bySection[id]) continue;
    for (const a of bySection[id]) add(id, a, true);
  }
  for (const [name, a] of queued.splice(0)) add(name, a, true);
  attach = add;

  /* Scenario buttons straight from the registry, rebuilt whenever a module registers one; keyed ones first, by key.
     The bench shows its own, her body the rest. */
  const built = new Map();
  const syncScenarios = () => {
    if (!loco && !bench) return;
    const s = sectionFor(bench ? 'bench' : 'loco'), focused = document.activeElement;
    const focusedName = s.scenarios.find((a) => a.button === focused)?.sc.name;
    const scs = scenarioList().filter((sc) => !!sc.bench === !!bench).sort((x, y) => (x.key ? 0 : 1) - (y.key ? 0 : 1) || String(x.key ?? '').localeCompare(String(y.key ?? '')));
    s.scenarios = scs.map((sc) => {
      const prev = built.get(sc.name);
      if (prev?.sc === sc) return prev;
      const a = {
        sc, key: sc.key, name: sc.label, disabled: !sc.run, label: () => (isRunning() === sc.name ? `${sc.label}…` : sc.label),
        run: async () => {
          if (!sc.run || isRunning()) return;
          say(`${sc.label}: running`);
          try { const r = await tank.scenario(sc.name); console.log(sc.name, r); say(`${sc.label}: ${r.passed ? 'PASS' : r.passed === false ? 'FAIL' : 'done'}`); }
          catch (err) { say(`${sc.label}: ${err.message}`); }
        },
      };
      button(a);
      built.set(sc.name, a);
      return a;
    });
    s.scRow.replaceChildren(...s.scenarios.filter((a) => a.key).map((a) => a.button));
    const unkeyed = s.scenarios.filter((a) => !a.key);
    s.checks.replaceChildren(...(unkeyed.length ? [tag('span', { className: 'row-label', textContent: 'Checks' }), ...unkeyed.map((a) => a.button)] : []));
    s.scRow.setAttribute('role', 'group');
    s.scRow.setAttribute('aria-label', 'Scenarios');
    s.checks.setAttribute('role', 'group');
    s.checks.setAttribute('aria-label', 'Checks');
    rebind();
    relabel();
    // Moving or replacing a focused button drops its focus, so hand it to the same scenario's button.
    const target = focusedName ? built.get(focusedName)?.button : focused;
    if (target?.isConnected && target !== document.activeElement) target.focus();
  };
  let syncQueued = false;
  onRegister(() => { if (!syncQueued) { syncQueued = true; queueMicrotask(() => { syncQueued = false; syncScenarios(); }); } });
  syncScenarios();
  if (!loco && !bench) { rebind(); relabel(); }

  for (const d of el.querySelectorAll('details[data-section]:not(.sec)')) {
    const id = d.dataset.section;
    if (id in stored.open) d.open = stored.open[id];
    d.addEventListener('toggle', () => { stored.open[id] = d.open; remember(); });
  }
  if (stored.hidden) el.classList.add('collapsed');
  const first = tabs.find((t) => t.id === stored.tab && !t.tab.hidden) ?? tabs.find((t) => !t.tab.hidden);
  if (first) select(first);
  ready = true;
  relabel();

  addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat || ev.isComposing) return;
    // Shift and Alt clicks steer her, so only ? (itself shifted on most layouts) may come with Shift.
    if (ev.shiftKey && ev.key !== '?') return;
    const t = ev.target instanceof Element ? ev.target : null;
    if (t && (t.isContentEditable || t.closest('input, textarea, select'))) return;
    const a = keys.get(ev.key.toLowerCase());
    if (!a || a.disabled) return;
    // A focused button or summary already turns Space into its own click.
    if (ev.key === ' ' && t?.closest('button, summary')) return;
    ev.preventDefault();
    fire(a);
  });

  const deg = (r) => `${Math.round((r * 180) / Math.PI)}°`;
  return {
    state,
    /* Same as section(name).add(action), for a caller holding the panel. */
    add: (name, action) => add(name, action),
    keys: () => new Map([...keys].map(([k, a]) => [k, a.name])),
    /* Call once per drawn frame. */
    frame(now) {
      if (lastFrame) gaps[gapCount++ % FRAMES] = now - lastFrame;
      lastFrame = now;
      if (mantle.exhale !== lastExhale) { inhaling = mantle.exhale < lastExhale; lastExhale = mantle.exhale; }
      if (now < textAt || el.classList.contains('collapsed')) return;
      textAt = now + 250;
      relabel();
      if (readoutBox && !readoutBox.open) return;
      const n = Math.min(gapCount, FRAMES), sorted = Array.from(gaps.subarray(0, n)).sort((x, y) => x - y);
      const mean = n ? sorted.reduce((x, y) => x + y, 0) / n : 0, p95 = n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
      const s = phys.stats(), h = mantle.health(), am = arms.stats();
      if (bench) {
        const slot = Math.max(0, arms.slotOf(bench.index)), rec = arms.records.state[slot];
        readout.textContent = [
          `${document.documentElement.dataset.backend ?? '?'} · seed ${seed} · bench, arm ${bench.index}${state.paused ? ' · PAUSED' : ''}`,
          `Render   ${mean ? Math.round(1000 / mean) : '–'} fps   frame ${mean.toFixed(1)} ms   p95 ${p95.toFixed(1)}`,
          `Physics  step ${s.mean.toFixed(2)} ms   p95 ${s.p95.toFixed(2)}   tick ${s.js.mean.toFixed(2)} ms   arms ${am.mean.toFixed(2)}`,
          ...bench.describe(),
          ...(arms.knobs.muscle ? [muscleLine(arms)] : []),
          `Arm      ${rec.label}${rec.reason ? ` (${rec.reason})` : ''}${arms.resting ? ', resting' : ''}`,
          `Events   ${arms.records.recent(slot, 3).map((e) => eventText(e, false)).join('  ·  ') || '–'}`,
          `Suckers  ${arms.suckerReport().map((r) => `${Math.round(r.share * 100)}%${r.holds ? ` ${r.hard ? 'HARD ' : ''}${r.holds}` : r.tastes ? ` ~${r.tastes}` : ''}`).join('  ')}`,
        ].join('\n');
        return;
      }
      const breath = mantle.knobs.breathDepth > 0 ? `${Math.round(mantle.pace?.rate ?? mantle.knobs.breathRate)}/min, breathing ${inhaling ? 'in' : 'out'}` : 'held';
      readout.textContent = [
        `${document.documentElement.dataset.backend ?? '?'} · seed ${seed} · ${mantle.shell.count} verts · ${mantle.drive} drive${state.paused ? ' · PAUSED' : ''}`,
        `Render   ${mean ? Math.round(1000 / mean) : '–'} fps   frame ${mean.toFixed(1)} ms   p95 ${p95.toFixed(1)}`,
        `Physics  step ${s.mean.toFixed(2)} ms   p95 ${s.p95.toFixed(2)}   dropped ${phys.dropped.toFixed(2)} s`,
        `Script   tick ${s.js.mean.toFixed(2)} ms   p95 ${s.js.p95.toFixed(2)}   arms ${am.mean.toFixed(2)}`,
        `Body     volume ${h.volume.toFixed(2)}   strain ${h.strainMax.toFixed(2)}   tilt ${deg(h.tilt)}${h.nan ? `   NaN ${h.nan}` : ''}`,
        `Heading  ${deg(pose.yaw)}${pose.turning ? ', turning' : ''}   breath ${breath}`,
        `Attend   ${ctx.attention?.describe() ?? '–'}`,
        `Gait     ${loco ? `${loco.describe()}   ${loco.stats().mean.toFixed(3)} ms` : '–'}`,
        `Arms     ${arms.records.state.map((r, i) => `${i} ${r.label}`).join('  ')}`,
        `Events   ${arms.records.recent(-1, 3).map((e) => eventText(e)).join('  ·  ') || '–'}`,
        ...(arms.knobs.muscle ? [muscleLine(arms)] : []),
        ...(ctx.rods?.describe() ?? []),
        `Water    ${ctx.water?.enabled ? `on, surface ${ctx.water.knobs.surfaceY} m, ${(s.water?.mean ?? 0).toFixed(3)} ms` : 'off (?water=0)'}${ctx.water?.knobs.tint ? '   tint: pale = floats or near neutral, darker = denser' : ''}`,
        `Suckers  ${arms.suckerReport().map((r, i) => `${i} ${Math.round(r.share * 100)}%${r.holds ? ` ${r.hard ? 'HARD ' : ''}${r.holds}` : r.tastes ? ` ~${r.tastes}` : ''}`).join('  ')}`,
        `Tasted   ${arms.lastTaste ? `arm ${arms.lastTaste.arm} seg ${arms.lastTaste.seg} ${arms.lastTaste.taste} (${arms.lastTaste.tag})  salience ${arms.lastTaste.salience.toFixed(2)}${arms.lastTaste.idle ? '  idle' : ''}   ${arms.tastes.length} touching` : '–'}`,
      ].join('\n');
    },
  };
}
