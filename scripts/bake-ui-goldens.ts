/**
 * Regenerate the gallery's golden images (spec 123).
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
import {
  encodePng,
  GOLDEN_CASES,
  INVENTORY_GOLDEN_CASES,
  KEYBINDING_GOLDEN_CASES,
  WINDOW_GOLDEN_CASES,
} from '../src/ui/gallery/goldens.js';
import {
  renderGallery,
  renderInventory,
  renderKeybindings,
  renderWindows,
} from '../src/ui/gallery/render.js';

const directory = fileURLToPath(new URL('../src/ui/gallery/goldens/', import.meta.url));
mkdirSync(directory, { recursive: true });

for (const item of GOLDEN_CASES) {
  const frame = renderGallery(item.options);
  const png = encodePng(frame.surface.width, frame.surface.height, frame.surface.pixels);
  writeFileSync(`${directory}${item.name}.png`, png);
  console.log(`${item.name}.png  ${frame.surface.width}x${frame.surface.height}  ${item.covers}`);
}

for (const item of WINDOW_GOLDEN_CASES) {
  const frame = renderWindows(item.options);
  const png = encodePng(frame.surface.width, frame.surface.height, frame.surface.pixels);
  writeFileSync(`${directory}${item.name}.png`, png);
  console.log(`${item.name}.png  ${frame.surface.width}x${frame.surface.height}  ${item.covers}`);
}

for (const item of KEYBINDING_GOLDEN_CASES) {
  const frame = renderKeybindings(item.options);
  const png = encodePng(frame.surface.width, frame.surface.height, frame.surface.pixels);
  writeFileSync(`${directory}${item.name}.png`, png);
  console.log(`${item.name}.png  ${frame.surface.width}x${frame.surface.height}  ${item.covers}`);
}

for (const item of INVENTORY_GOLDEN_CASES) {
  const frame = renderInventory(item.options);
  const png = encodePng(frame.surface.width, frame.surface.height, frame.surface.pixels);
  writeFileSync(`${directory}${item.name}.png`, png);
  console.log(`${item.name}.png  ${frame.surface.width}x${frame.surface.height}  ${item.covers}`);
}

const total =
  GOLDEN_CASES.length +
  WINDOW_GOLDEN_CASES.length +
  KEYBINDING_GOLDEN_CASES.length +
  INVENTORY_GOLDEN_CASES.length;
console.log(`\n${total} golden(s) written to src/ui/gallery/goldens/`);
