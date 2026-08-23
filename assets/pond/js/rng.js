// Mulberry32. `seed | 0` matters: a fractional seed would change the whole sequence.
export function createRng(seed) {
  let a = seed | 0;
  const next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

export function deriveSeed(root, salt) {
  return (root ^ Math.imul(salt, 0x9E3779B1)) | 0;
}

export function seedFromUrl() {
  const q = new URLSearchParams(location.search).get('seed');
  if (q !== null && q !== '' && Number.isFinite(+q)) return (+q) | 0;
  return (Math.random() * 2 ** 31) | 0;
}
