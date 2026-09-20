/* The loading screen: a flat fill in the page's own background, one looping eel clip, and an empty
   text slot. Loaded as its own module script before main.js so it owns the screen from first paint. */

const SHOW_DELAY_MS = 200;      // a warm cache is done before this, so the eel never blinks in and out
const MIN_VISIBLE_MS = 600;     // once shown it stays this long before the cross-fade
const READY_CEILING_MS = 25000; // a stage that never completes still hands the pond over
const FADE_MS = 700;

const STAGES = ['renderer-ready', 'impulse-probed', 'assets-ready', 'scene-built', 'pipelines-warmed', 'first-composed-frame'];

const el = (id) => document.getElementById(id);
const screen = el('loader');
const text = el('loader-text');
const clip = el('loader-clip');
const anim = el('loader-anim');

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* WebKit plays VP9 WebM but drops its alpha channel, and no media query or canPlayType reports that;
   the vendor string is the one stable signal, so those engines get the animated WebP instead. */
let shownAt = 0;
let settled = false;
let dismissed = false;
let clipSwapped = false;

function showAnimation() {
  if (clipSwapped || dismissed || !clip?.isConnected || !anim?.isConnected) return;
  clipSwapped = true;
  clip.remove();
  anim.src = anim.dataset.src;
  anim.classList.remove('loader-alt');
}

function pickClip() {
  if (!clip) return;
  if (reduced) {
    clip.autoplay = false;
    clip.preload = 'none';
    clip.pause();
    clip.removeAttribute('src');
    clip.load();
    return;
  }
  const webmAlpha = !!clip.canPlayType?.('video/webm; codecs="vp9"') && navigator.vendor !== 'Apple Computer, Inc.';
  if (!webmAlpha && anim) {
    showAnimation();
    return;
  }
  clip.addEventListener('error', showAnimation, { once: true });
  if (clip.error) { showAnimation(); return; }
  clip.play().catch(showAnimation);
}

const resolvers = {};
const ready = new Promise((res) => { resolvers.ready = res; });
const failed = new Promise((res) => { resolvers.failed = res; });

if (screen) {
  pickClip();
  setTimeout(() => { if (!settled) { shownAt = performance.now(); screen.classList.add('eel-in'); } }, SHOW_DELAY_MS);
}

function dismiss(then) {
  if (!screen) { then?.(); return; }
  dismissed = true;
  screen.classList.add('is-gone');
  setTimeout(() => {
    screen.hidden = true;
    screen.inert = true;
    // hidden alone only optimizes decode by convention; drop the sources so nothing keeps playing for real.
    if (clip?.isConnected) { clip.pause(); clip.removeAttribute('src'); clip.load(); }
    if (anim?.isConnected) anim.removeAttribute('src');
    then?.();
  }, FADE_MS);
}

/* Held open for the eel's minimum visible time, so a fast machine does not flash it away; the
   promise settles only once the cross-fade is over, which is what puts the gate after it. */
function finish(then) {
  const wait = shownAt ? Math.max(0, MIN_VISIBLE_MS - (performance.now() - shownAt)) : 0;
  setTimeout(() => dismiss(then), wait);
}

const marks = [];
function stage(name) {
  if (!STAGES.includes(name)) return;
  performance.mark(`pond:${name}`);
  marks.push([name, performance.now()]);
}

function done(info = {}) {
  if (settled) return;
  settled = true;
  finish(() => resolvers.ready(info));
}

function fail(kind, error) {
  if (settled) return;
  settled = true;
  dismiss();
  resolvers.failed({ kind, error });
}

const ceiling = setTimeout(() => {
  // No stage mark ever landed: main.js likely never ran at all, and it owns the only other trigger for this class.
  if (!marks.length) document.documentElement.classList.add('no-renderer');
  done({ ceiling: true });
}, READY_CEILING_MS);
ready.then(() => clearTimeout(ceiling));
failed.then(() => clearTimeout(ceiling));

/* Only ready, failed, and setText are the public surface; the rest is the boot path's own wiring. */
export const pondLoad = {
  ready,
  failed,
  setText(str) { if (text) text.textContent = str ?? ''; },
  stage,
  done,
  fail,
  report() {
    if (!marks.length) return;
    const t0 = marks[0][1];
    console.log('Pond load', marks.map(([n, at], i) => `${n} ${(at - (i ? marks[i - 1][1] : t0)).toFixed(0)}ms`).join(' | '), `total ${(marks[marks.length - 1][1]).toFixed(0)}ms`);
  },
};

window.pondLoad = pondLoad;
