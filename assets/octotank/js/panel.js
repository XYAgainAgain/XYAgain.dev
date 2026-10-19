/* The diagnostics panel: frame rate, physics and script costs, her state, and every control as both a button and a
   key, built from one list so the two never drift apart. */

const FRAMES = 120;

export function createPanel({ el, readout, controls, ctx, tank, toys, seed, say }) {
  const { phys, mantle, arms, pose } = ctx;
  const gaps = new Float32Array(FRAMES);
  let gapCount = 0, lastFrame = 0, textAt = 0, breathDepth = mantle.knobs.breathDepth || 0.035, lastExhale = 0, inhaling = false;
  const state = { paused: false };
  const DRIVES = ['force', 'pin', 'free'];

  const squeeze = async () => {
    if (ctx.watch) return;
    say('squeezing');
    try {
      const r = await tank.squeeze();
      console.log('squeeze', r);
      say(r.passed ? 'squeeze: PASS' : 'squeeze: FAIL');
    } catch (err) { say(`squeeze: ${err.message}`); }
  };
  const actions = [
    { key: 'h', hint: 'H', label: () => (ctx.watch ? 'Squeezing…' : 'Squeeze'), run: squeeze },
    { key: 'a', hint: 'A', label: () => 'Reach toys', run: () => arms.reachNearestToys(toys) },
    { key: 'l', hint: 'L', label: () => 'Look at a toy', run: () => ctx.attention?.lookAndReach() },
    { key: 'i', hint: 'I', label: () => 'Arms idle', run: () => arms.idle() },
    { key: 'f', hint: 'F', label: () => 'Fetch held', run: () => arms.fetchHolding() },
    { key: 'g', hint: 'G', label: () => (arms.episodes.some((e) => e?.commanded) ? 'Let go' : 'Grip/let go'), run: () => say(`grip: ${arms.toggleGrip()}`) },
    { key: 's', hint: 'S', label: () => (tank.suckerView?.visible ? 'Suckers: shown' : 'Suckers: hidden'), run: () => { if (tank.suckerView) tank.suckerView.visible = !tank.suckerView.visible; } },
    { key: 'w', hint: 'W', label: () => (ctx.water?.knobs.tint ? 'Density tint: on' : 'Density tint: off'), run: () => ctx.water?.setTint(!ctx.water.knobs.tint) },
    { key: 'z', hint: 'Z', label: () => (arms.resting ? 'Arms: resting' : 'Arms: awake'), run: () => { arms.resting = !arms.resting; } },
    { key: 'p', hint: 'P', label: () => `Drive: ${mantle.drive}`, run: () => mantle.setDrive(DRIVES[(DRIVES.indexOf(mantle.drive) + 1) % DRIVES.length]) },
    { key: 't', hint: 'T', label: () => 'Tip her', run: () => mantle.tip(1.2) },
    {
      key: 'b', hint: 'B', label: () => (mantle.knobs.breathDepth > 0 ? 'Breathing: on' : 'Breathing: off'),
      run: () => {
        if (mantle.knobs.breathDepth > 0) { breathDepth = mantle.knobs.breathDepth; mantle.knobs.breathDepth = 0; }
        else mantle.knobs.breathDepth = breathDepth;
      },
    },
    { key: ' ', hint: 'Space', label: () => (state.paused ? 'Resume' : 'Pause'), run: () => { state.paused = !state.paused; } },
    { key: 'd', hint: 'D', label: () => (el.classList.contains('collapsed') ? 'Show panel' : 'Hide panel'), run: () => el.classList.toggle('collapsed'), keep: true },
    { key: 'r', hint: 'R', label: () => 'Reload', run: () => location.reload() },
  ];
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (a.keep ? ' keep' : '');
    b.setAttribute('aria-keyshortcuts', a.key === ' ' ? 'Space' : a.hint);
    a.button = b;
    b.addEventListener('click', () => { a.run(); relabel(); });
    controls.append(b);
  }
  const relabel = () => {
    for (const a of actions) {
      const text = `${a.label()} `;
      if (a.button.dataset.text === text) continue;
      a.button.dataset.text = text;
      a.button.replaceChildren(text, Object.assign(document.createElement('kbd'), { textContent: a.hint }));
    }
  };
  relabel();
  addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
    const a = actions.find((x) => x.key === ev.key.toLowerCase());
    if (!a) return;
    // A focused button already turns Space into a click.
    if (ev.key === ' ' && document.activeElement?.tagName === 'BUTTON') return;
    ev.preventDefault();
    a.run();
    relabel();
  });

  const deg = (r) => `${Math.round((r * 180) / Math.PI)}°`;
  return {
    state,
    /* Call once per drawn frame. */
    frame(now) {
      if (lastFrame) gaps[gapCount++ % FRAMES] = now - lastFrame;
      lastFrame = now;
      if (mantle.exhale !== lastExhale) { inhaling = mantle.exhale < lastExhale; lastExhale = mantle.exhale; }
      if (now < textAt || el.classList.contains('collapsed')) return;
      textAt = now + 250;
      const n = Math.min(gapCount, FRAMES), sorted = Array.from(gaps.subarray(0, n)).sort((x, y) => x - y);
      const mean = n ? sorted.reduce((x, y) => x + y, 0) / n : 0, p95 = n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
      const s = phys.stats(), h = mantle.health(), am = arms.stats();
      const busy = {};
      for (const arm of arms.arms) if (arm.goal) busy[arm.goal.kind] = (busy[arm.goal.kind] ?? 0) + 1;
      const busyText = Object.entries(busy).map(([k, v]) => `${v} ${k}`).join(', ') || 'all exploring';
      const breath = mantle.knobs.breathDepth > 0 ? `${Math.round(mantle.pace?.rate ?? mantle.knobs.breathRate)}/min, breathing ${inhaling ? 'in' : 'out'}` : 'held';
      readout.textContent = [
        `${document.documentElement.dataset.backend ?? '?'} · seed ${seed} · ${mantle.shell.count} verts · ${mantle.drive} drive${state.paused ? ' · PAUSED' : ''}`,
        `Render   ${mean ? Math.round(1000 / mean) : '–'} fps   frame ${mean.toFixed(1)} ms   p95 ${p95.toFixed(1)}`,
        `Physics  step ${s.mean.toFixed(2)} ms   p95 ${s.p95.toFixed(2)}   dropped ${phys.dropped.toFixed(2)} s`,
        `Script   tick ${s.js.mean.toFixed(2)} ms   p95 ${s.js.p95.toFixed(2)}   arms ${am.mean.toFixed(2)}`,
        `Body     volume ${h.volume.toFixed(2)}   strain ${h.strainMax.toFixed(2)}   tilt ${deg(h.tilt)}${h.nan ? `   NaN ${h.nan}` : ''}`,
        `Heading  ${deg(pose.yaw)}${pose.turning ? ', turning' : ''}   breath ${breath}`,
        `Attend   ${ctx.attention?.describe() ?? '–'}`,
        `Arms     ${busyText}`,
        `Water    ${ctx.water?.enabled ? `on, surface ${ctx.water.knobs.surfaceY} m, ${(s.water?.mean ?? 0).toFixed(3)} ms` : 'off (?water=0)'}${ctx.water?.knobs.tint ? '   tint: pale = floats or near neutral, darker = denser' : ''}`,
        `Suckers  ${arms.suckerReport().map((r, i) => `${i} ${Math.round(r.share * 100)}%${r.holds ? ` ${r.hard ? 'HARD ' : ''}${r.holds}` : r.tastes ? ` ~${r.tastes}` : ''}`).join('  ')}`,
      ].join('\n');
      relabel();
    },
  };
}
