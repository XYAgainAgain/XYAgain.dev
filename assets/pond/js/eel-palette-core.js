/* The ramp bakery: an ordered list of stops rasterized into 256 texels an eel's masks read their
   color from. THREE-free on purpose, so the width math and the head/tail means run under node --test. */

// Dad's beloved stripey tablecloth, top to bottom; 26 stripes is one full repeat.
// width is proportional to the photographed band, so the wide pale and orange bands survive.
export const JIM_TABLECLOTH = [
  { color: [0.3725, 0.4196, 0.5098], width: 62 },    // #5f6b82
  { color: [0.6314, 0.6392, 0.6157], width: 70 },    // #a1a39d
  { color: [0.4588, 0.4784, 0.3686], width: 62 },    // #757a5e
  { color: [0.7725, 0.7373, 0.6353], width: 75 },    // #c5bca2
  { color: [0.8118, 0.7373, 0.5922], width: 68 },    // #cfbc97
  { color: [0.3216, 0.3765, 0.4824], width: 71 },    // #52607b
  { color: [0.6510, 0.5843, 0.5020], width: 73 },    // #a69580
  { color: [0.2784, 0.3216, 0.4471], width: 81 },    // #475272
  { color: [0.5608, 0.3412, 0.3569], width: 94 },    // #8f575b  wider dusty red
  { color: [0.7765, 0.6235, 0.5059], width: 65 },    // #c69f81
  { color: [0.7020, 0.3569, 0.3176], width: 77 },    // #b35b51
  { color: [0.8353, 0.5608, 0.5176], width: 75 },    // #d58f84  wider pink
  { color: [0.7529, 0.6588, 0.6510], width: 56 },    // #c0a8a6
  { color: [0.8000, 0.7569, 0.6902], width: 138 },   // #ccc1b0  broad pale neutral
  { color: [0.7725, 0.6863, 0.5686], width: 65 },    // #c5af91
  { color: [0.8196, 0.7686, 0.6588], width: 79 },    // #d1c4a8
  { color: [0.6941, 0.6667, 0.5294], width: 71 },    // #b1aa87
  { color: [0.2549, 0.4471, 0.4745], width: 72 },    // #417279
  { color: [0.6431, 0.5569, 0.3608], width: 88 },    // #a48e5c
  { color: [0.8157, 0.7647, 0.6784], width: 74 },    // #d0c3ad
  { color: [0.8118, 0.5059, 0.3961], width: 61 },    // #cf8165
  { color: [0.6863, 0.5882, 0.4824], width: 75 },    // #af967b
  { color: [0.2667, 0.4549, 0.4863], width: 77 },    // #44747c
  { color: [0.7333, 0.3137, 0.2353], width: 110 },   // #bb503c  wider vivid orange-red
  { color: [0.7765, 0.7176, 0.5961], width: 77 },    // #c6b798
  { color: [0.7569, 0.5882, 0.4431], width: 132 },   // #c19671  final light tan before the repeat
];

// Plain /255, no sRGB decode: these go straight to emission the way the identity constants do.
export function hexStops(list) {
  return list.map((item) => {
    const pair = Array.isArray(item);
    const hex = pair ? item[0] : item;
    const width = pair && item[1] !== undefined ? item[1] : 1;
    const n = parseInt(hex.slice(1), 16);
    return { color: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], width };
  });
}

// Stripe-only flags, top to bottom; anything with a chevron or a triangle cannot become a ramp.
export const PRIDE_FLAGS = {
  rainbow: hexStops(['#E40303', '#FF8C00', '#FFED00', '#008026', '#24408E', '#732982']),
  trans: hexStops(['#5BCEFA', '#F5A9B8', '#FFFFFF', '#F5A9B8', '#5BCEFA']),
  // Pink and blue take two fifths each, purple the middle fifth.
  bi: hexStops([['#D60270', 2], ['#9B4F96', 1], ['#0038A8', 2]]),
  pan: hexStops(['#FF218C', '#FFD800', '#21B1FF']),
  lesbian: hexStops(['#D52D00', '#FF9A56', '#FFFFFF', '#D162A4', '#A30262']),
  nonbinary: hexStops(['#FCF434', '#FFFFFF', '#9C59D1', '#2C2C2C']),
  asexual: hexStops(['#000000', '#A3A3A3', '#FFFFFF', '#800080']),
  aromantic: hexStops(['#3DA542', '#A7D379', '#FFFFFF', '#A9A9A9', '#000000']),
  aroace: hexStops(['#E38D00', '#EDCE00', '#FFFFFF', '#62AEDC', '#1A3555']),
  genderfluid: hexStops(['#FF76A4', '#FFFFFF', '#C011D7', '#000000', '#2F3CBE']),
  genderqueer: hexStops(['#B57EDC', '#FFFFFF', '#4A8123']),
  agender: hexStops(['#000000', '#BCC4C7', '#FFFFFF', '#B7F684', '#FFFFFF', '#BCC4C7', '#000000']),
  polysexual: hexStops(['#F61CB9', '#07D569', '#1C92F6']),
  omnisexual: hexStops(['#FE9ACE', '#FF53BF', '#200044', '#6760FE', '#8EA6FF']),
};

export function twoToneStops(colA, colB) {
  return [{ color: colA, width: 1 }, { color: colB, width: 1 }];
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) * 0.5, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hueChannel(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueChannel(p, q, h + 1 / 3), hueChannel(p, q, h), hueChannel(p, q, h - 1 / 3)];
}

// Saturation before gain: pushing saturation on an already-clamped color would do nothing.
function shade(color, sat, gain) {
  let [r, g, b] = color;
  if (sat !== 1) {
    const [h, s, l] = rgbToHsl(r, g, b);
    [r, g, b] = hslToRgb(h, Math.min(1, s * sat), l);
  }
  return [Math.min(1, r * gain), Math.min(1, g * gain), Math.min(1, b * gain)];
}

function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const RAMP_TEXELS = 256;

/* Fills `data` (any array-like of 256 × 4 bytes; values are clamped and rounded here, so a plain
   Uint8Array works) and returns the half means the influence capsule mixes head to tail. */
export function bakeRampData(data, stops, opts = {}, rng) {
  const { rotate = false, jitter = 0, sat = 1, gain = 1, soften = 1, edge = 3 } = opts;
  const n = stops.length;
  let list = stops.map((s) => ({ color: s.color, width: s.width }));

  // Musical modes: every color, same order, different tonic, wrapping to close the loop.
  if (rotate && n > 1) {
    const k = rng.int(0, n - 1);
    list = list.slice(k).concat(list.slice(0, k));
  }
  if (jitter > 0) for (const s of list) s.width *= rng.range(1 - jitter, 1 + jitter);

  let total = 0;
  for (const s of list) total += s.width;
  if (!(total > 0)) { for (const s of list) s.width = 1; total = n; }

  const colors = list.map((s) => shade(s.color, sat, gain));
  const edges = new Array(n + 1);
  edges[0] = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += list[i].width; edges[i + 1] = (acc / total) * RAMP_TEXELS; }
  edges[n] = RAMP_TEXELS;

  const half = soften * 0.5;
  const sums = [0, 0, 0, 0, 0, 0];
  let j = 0;
  for (let x = 0; x < RAMP_TEXELS; x++) {
    const p = x + 0.5;
    while (j < n - 1 && p >= edges[j + 1]) j++;
    let col = colors[j];
    if (soften > 0 && n > 1) {
      const toLo = p - edges[j], toHi = edges[j + 1] - p;
      // Wrapping neighbors, so the last-to-first seam softens like every other boundary.
      if (toLo < half && toLo <= toHi) col = mixRgb(colors[(j - 1 + n) % n], col, (toLo + half) / soften);
      else if (toHi < half) col = mixRgb(col, colors[(j + 1) % n], (half - toHi) / soften);
    }
    const o = x * 4, s = x < RAMP_TEXELS / 2 ? 0 : 3;
    for (let c = 0; c < 3; c++) {
      data[o + c] = Math.round(Math.min(255, Math.max(0, col[c] * 255)));
      sums[s + c] += col[c];
    }
    // Alpha is the band-edge mask: 1 on a stop boundary, fading to 0 over `edge` texels, seam included.
    const toLo = p - edges[j], toHi = edges[j + 1] - p;
    const near = n > 1 ? Math.min(toLo, toHi) : Math.min(p, RAMP_TEXELS - p);
    data[o + 3] = edge > 0 ? Math.round(Math.max(0, 1 - near / edge) * 255) : 0;
  }

  const per = RAMP_TEXELS / 2;
  return {
    head: [sums[0] / per, sums[1] / per, sums[2] / per],
    tail: [sums[3] / per, sums[4] / per, sums[5] / per],
  };
}
