# Pond Audio Slots

All files OGG Opus under `assets/pond/audio/`. A file that fails to load warns once and its slot stays silent. Default levels live in `DEFAULT_MIX` in `js/audio.js`; `?mixer=1` opens the dev mix console. Every one-shot spawns its own player, panned to where it happened: pointer sounds at the pointer, creature sounds on a per-creature panner that sweeps as they swim.

| File | Slot | Notes |
| --- | --- | --- |
| `ambient-pond.ogg` | Ambient bed | Gapless 3-min nighttime loop, fades in over 2 s after the gate |
| `drippy-pond-rain.ogg` | Rain (reserved) | Perfect-loop light rain for the future randomized shower feature; not loaded yet |
| `sfx/plip-1..6.ogg` | Poke | Random pick, pitch jitter, ducked under spam |
| `sfx/swishy-a/b.ogg` | Drag | One looping hand-swish per drag, random variant, 150 ms fade-in |
| `sfx/plop-big.ogg` | Treat drop | R-click food; each drop rolls a random note on a 2-octave major pentatonic |
| `sfx/plop-smol.ogg` | Crumb drops | R-click-drag crumbs walk the Korobeiniki (Tetris) melody, resetting after a 2 s gap |
| `sfx/eel-startle-1..3.ogg` | Eel spooked | Random pick, pitched by eel length (longer = deeper) |
| `sfx/eleanor-startle.ogg` | Eleanor startled | Her nopes and log exits; random pitch and trim since it's one file |
| `sfx/crackle-lil/med/big.ogg` | Eel electricity | lil ≈4 s, med ≈15 s, big ≈27 s; recolor lil, corral med, ambient rolls weighted lil-heavy and tied to a random eel's length + position; one at a time |
| `sfx/eel-eat-1..3.ogg` | Crumb finished | 1 big food, 2 crumb, 3 tiny; wide pitch jitter, Eleanor's an octave down |
| `sfx/slurp-1..4.ogg` | The BIG SLURP | Random pick, pitch + trim variance, when Eleanor inhales a resident |
| `sfx/short-bubs-1..5.ogg` | Pond bubbles | Stray ambient bubble every 7–20 s with a tiny ripple in view |
| `sfx/tiny-bubs-1..8.ogg` | Eel bubbles | Nibbling at crumbs and Eleanor's shallow swim-bys |
