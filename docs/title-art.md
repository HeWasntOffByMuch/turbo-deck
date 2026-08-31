# Title art (spec 254)

Two drop-in files. Neither is required — the title screen falls back to a flat
background and the wordmark in the game's own 5x7 face — but both are what it is
designed around.

| File | What it is | Notes |
|---|---|---|
| `background.png` | The title screen's painting | Drawn `center / cover`, so any aspect works; the safe area is the middle. Pixel art: it is scaled with `image-rendering: pixelated` and must not be pre-smoothed. |
| `logo.png` | The logotype | Drawn at `min(62%, 760px)` wide, height auto. Transparent background. |

They live under `public/`, so vite copies them into `dist/` verbatim and serves
them at `/title/...` in dev and at `<base>/title/...` on Pages — the client
resolves both through `withBase`, which is why a root-relative path here is
correct and a hard-coded `/turbo-deck/` would not be.

Nothing in the build reads this directory by listing it: the two names above are
constants in `src/render/iso3d/world/title-overlay.ts`. Renaming a file means
editing that one module.
