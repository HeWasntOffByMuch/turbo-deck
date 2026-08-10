/**
 * Regenerate the gallery's golden images (spec 121).
 *
 * `npm run bake:ui-goldens`. The PNGs are committed, and CI re-bakes and
 * requires no diff -- the same arrangement `assets/units/manifest.json` uses,
 * and for the same reason: a committed artefact that nothing checks is a
 * committed artefact that goes stale.
 *
 * Running this is how you *accept* a visual change. Look at the diff first; the
 * whole point of a byte-exact golden is that it makes you look.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng, GOLDEN_CASES } from '../src/ui/gallery/goldens.js';
import { renderGallery } from '../src/ui/gallery/render.js';

const directory = fileURLToPath(new URL('../src/ui/gallery/goldens/', import.meta.url));
mkdirSync(directory, { recursive: true });

for (const item of GOLDEN_CASES) {
  const frame = renderGallery(item.options);
  const png = encodePng(frame.surface.width, frame.surface.height, frame.surface.pixels);
  writeFileSync(`${directory}${item.name}.png`, png);
  console.log(`${item.name}.png  ${frame.surface.width}x${frame.surface.height}  ${item.covers}`);
}

console.log(`\n${GOLDEN_CASES.length} golden(s) written to src/ui/gallery/goldens/`);
