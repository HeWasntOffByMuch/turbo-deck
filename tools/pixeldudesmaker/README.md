# pixeldudesmaker (vendored)

A web-based pixel-art character generator by **0x72** — it composites base /
head / face atlases and recolours them by palette to produce little 16×24
"dude" sprites, with idle/run animation and zip / sprite-sheet export.

- Original: https://0x72.itch.io/pixeldudesmaker
- Author: 0x72 (https://itch.io/0x72)

This is turbo-deck's intended source of real character art: spec 010 draws the
actors as pixel dudes with a placeholder-art "swap seam" in
`src/render/sprites.ts`, and this tool is what produces the sprite sheets that
seam is meant to load.

## Why it's in this repo

The tool is not released as licensed software, but 0x72 explicitly invited
modding it. From the itch.io comments:

> "Feel free to mod it. Unfortunately, I'm unable to provide support. But I'm
> sure all the files are provided with the application and visible in the
> network tab of the dev tools. I took no steps to hide how it works […]"

and, when asked for the source:

> "Feel free download the app from itch; I don't have anything else."

Separately, the **assets generated** with the tool are covered by 0x72's
permissive grant: free for any commercial/non-commercial project, except as
NFTs. So any sprite sheet exported here can be used in the game freely.

## Contents

Captured from the live itch.io build (game bundle `html/4533168`); only the
generator itself is kept — itch.io page chrome, fonts, analytics and payment
scripts from the surrounding page were dropped.

| File | What it is |
|---|---|
| `index.html` | UI (de-itched: the external `static.itch.io/htmlgame.js` wrapper script was removed so it runs standalone) |
| `app.js` | the generator — 0x72's own code (unmodified) |
| `style.css` | UI styles (unmodified) |
| `jszip.js`, `FileSaver.min.js` | vendored third-party libs used for zip export |
| `data/Archive.zip` | the source atlases + config the app fetches at runtime |
| `data/{base,heads,faces}.png`, `data/conf.json` | the same atlases + config, unpacked for convenience / future headless baking |
| `extract.mjs` | the Playwright script used to capture the bundle, for reproducibility |

## Running it

It's a static site; serve the folder and open it (a plain `file://` open won't
work because `app.js` `fetch`es `data/Archive.zip`):

```bash
npx serve tools/pixeldudesmaker      # or: python3 -m http.server -d tools/pixeldudesmaker
# then open the printed URL
```

Tweak the sliders / palettes, then **export → sprite** for a sprite sheet or
**export → zip** for the layers. Drop the result where `src/render/sprites.ts`
can load it to replace the placeholder dudes.
