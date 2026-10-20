/* Engine-free picking for the tank's sounds: which take of a multi-take file plays next (cut points in
   audio/sfx/slices.json), and which stretch of a long texture file plays as a one-shot. */

export function takeBag(count, random = Math.random) {
  let order = [], last = -1;
  return () => {
    if (!order.length) {
      order = Array.from({ length: count }, (_, i) => i);
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      // Takes come off the end, so a fresh shuffle must not end on the take that just played.
      const end = order.length - 1;
      if (end > 0 && order[end] === last) [order[0], order[end]] = [order[end], order[0]];
    }
    return (last = order.pop());
  };
}

export function textureWindow(length, { min = 0.6, max = 1.6, fade = 0.05 } = {}, random = Math.random) {
  const span = Math.min(length, min + (max - min) * random());
  const fadeTime = Math.min(fade, span / 4);
  return { offset: (length - span) * random(), duration: span, fadeIn: fadeTime, fadeOut: fadeTime };
}
