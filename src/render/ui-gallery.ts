/**
 * The gallery, in a real browser (spec 121).
 *
 * A dev-server page rather than a tab in the game's shell, for the same reason
 * `wind-probe.html` and `shading-probe.html` are: it is a measuring rig, and the
 * thing it measures is whether the browser backend agrees with the software one.
 * Shipping it inside the game would mean the game's bundle carries a QA surface.
 *
 * Everything here is glue. The tree, the layout, the theme and the draw list all
 * come from `src/ui/`, unchanged, which is the point -- if this page and the
 * goldens ever disagree, the difference is the backend and not the scene.
 */

import { replay } from '../ui/core/draw-list.js';
import { autoUiScale, uiFrame } from '../ui/core/frame.js';
import { UiRoot } from '../ui/core/root.js';
import { NO_MODIFIERS, type Modifiers, type UiEvent } from '../ui/core/events.js';
import { buildGallery } from '../ui/gallery/gallery.js';
import { bakeAtlas } from '../ui/render/atlas.js';
import { Canvas2dSurface } from '../ui/render/canvas2d.js';
import { RasterSurface } from '../ui/render/raster.js';
import { THEME } from '../ui/theme/theme.js';

interface Probe {
  /** Milliseconds for one full update + paint + replay, averaged. */
  frameMs: number;
  drawCalls: number;
  viewport: { width: number; height: number };
  scale: number;
  /** Whether canvas2d's pixels match the software rasterizer's, byte for byte. */
  matchesRaster: boolean;
  firstMismatch: string | null;
}

function modifiersOf(event: MouseEvent | KeyboardEvent): Modifiers {
  return { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey };
}

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;';
  app.appendChild(canvas);

  const atlas = bakeAtlas(THEME);
  const gallery = buildGallery(THEME);

  const dpr = globalThis.devicePixelRatio || 1;
  const scale = autoUiScale(app.clientWidth, app.clientHeight, dpr, {
    minViewport: THEME.input.minViewport,
    coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
    maxTapUiPx: THEME.input.maxTapUiPx,
  });
  const frame = uiFrame(app.clientWidth, app.clientHeight, dpr, scale);

  const root = new UiRoot(gallery.root, {
    theme: THEME,
    atlas,
    viewport: { width: frame.width, height: frame.height },
  });
  const surface = new Canvas2dSurface(canvas, atlas, frame.width, frame.height, { scale: frame.scale });

  // Pointer positions arrive in CSS pixels and the UI thinks in UI pixels.
  // One conversion, in one place.
  const toUi = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.floor(((clientX - box.left) * dpr) / frame.scale),
      y: Math.floor(((clientY - box.top) * dpr) / frame.scale),
    };
  };

  let now = 0;
  const send = (event: UiEvent): void => {
    root.handle(event);
  };

  canvas.addEventListener('mousemove', (event) => {
    send({ kind: 'pointer', phase: 'move', pos: toUi(event.clientX, event.clientY), button: -1, mods: modifiersOf(event), time: now });
  });
  canvas.addEventListener('mousedown', (event) => {
    const pos = toUi(event.clientX, event.clientY);
    const hit = root.content.hitTest(pos);
    root.focus.focus(hit);
    send({ kind: 'pointer', phase: 'down', pos, button: event.button, mods: modifiersOf(event), time: now });
  });
  globalThis.addEventListener('mouseup', (event) => {
    send({ kind: 'pointer', phase: 'up', pos: toUi(event.clientX, event.clientY), button: event.button, mods: modifiersOf(event), time: now });
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    send({ kind: 'wheel', pos: toUi(event.clientX, event.clientY), delta: -Math.sign(event.deltaY), mods: NO_MODIFIERS, time: now });
  }, { passive: false });
  globalThis.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      root.moveFocus(event.shiftKey ? -1 : 1);
      return;
    }
    send({ kind: 'key', phase: 'down', code: event.code, mods: modifiersOf(event), time: now });
    if (event.key.length === 1) send({ kind: 'text', text: event.key, time: now });
  });

  const samples: number[] = [];
  let drawCalls = 0;

  const draw = (timestamp: number): void => {
    now = timestamp;
    const started = performance.now();
    root.update(timestamp);
    const list = root.paint();
    const commands = list.finish();
    drawCalls = commands.length;
    replay(surface, commands);
    samples.push(performance.now() - started);
    if (samples.length > 120) samples.shift();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  /**
   * The cross-backend check, run on demand from the preview script.
   *
   * `drawImage` at integer coordinates with smoothing off is a plain blit, and
   * so is the software rasterizer, so the two should agree byte for byte. This
   * is the assertion that would have caught spec 101's failure -- a pass whose
   * offscreen measurements were all correct while the screen was black.
   */
  globalThis.setTimeout(() => {
    const reference = new RasterSurface(atlas, frame.width, frame.height);
    reference.clear(THEME.color('ink'));
    replay(reference, root.paint().finish());

    const actual = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height);
    let mismatch: string | null = null;
    if (actual) {
      outer: for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          // Sample the centre of each upscaled block, so the comparison is about
          // the pixels and not about how the browser laid them out.
          const sx = x * frame.scale + Math.floor(frame.scale / 2);
          const sy = y * frame.scale + Math.floor(frame.scale / 2);
          const offset = (sy * canvas.width + sx) * 4;
          const expected = reference.pixelAt(x, y);
          const got = {
            r: actual.data[offset] ?? 0,
            g: actual.data[offset + 1] ?? 0,
            b: actual.data[offset + 2] ?? 0,
          };
          if (expected.a === 0) continue;
          if (got.r !== expected.r || got.g !== expected.g || got.b !== expected.b) {
            mismatch = `(${x}, ${y}) canvas rgb(${got.r},${got.g},${got.b}) vs raster rgb(${expected.r},${expected.g},${expected.b})`;
            break outer;
          }
        }
      }
    }

    const sorted = [...samples].sort((a, b) => a - b);
    (globalThis as { __uiProbe?: Probe }).__uiProbe = {
      frameMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      drawCalls,
      viewport: { width: frame.width, height: frame.height },
      scale: frame.scale,
      matchesRaster: mismatch === null,
      firstMismatch: mismatch,
    };
  }, 1200);
}

main();
