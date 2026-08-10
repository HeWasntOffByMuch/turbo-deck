import { describe, expect, it } from 'vitest';
import { buildGallery } from './gallery.js';
import { renderGallery } from './render.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';

/**
 * The brief's budget is "full UI update + draw under 1.5 ms with 6 windows
 * open", and it says to measure it rather than assume.
 *
 * What can honestly be asserted in Node is the shape of the work rather than a
 * wall-clock number: this file may not read a clock (lint forbids it, and a
 * timing assertion on shared CI hardware is a flaky test waiting to happen). So
 * the budget is asserted as the two things that actually determine it -- how
 * much layout runs, and how many draw calls come out -- and
 * `scripts/preview-ui-gallery.ts` reports the real milliseconds from a browser.
 */
describe('frame budget', () => {
  it('does no layout work at all on a still frame', () => {
    // The whole justification for retained mode over immediate. If this fails,
    // six open windows cost a full relayout sixty times a second for nothing.
    const atlas = bakeAtlas(THEME);
    const gallery = buildGallery(THEME);
    const root = new UiRoot(gallery.root, { theme: THEME, atlas, viewport: { width: 400, height: 300 } });

    root.update(0);
    expect(root.layoutPasses).toBe(1);
    for (let frame = 1; frame <= 60; frame++) root.update(frame * 16);
    expect(root.layoutPasses).toBe(1);
  });

  it('re-lays-out exactly once when something actually changes', () => {
    const atlas = bakeAtlas(THEME);
    const gallery = buildGallery(THEME);
    const root = new UiRoot(gallery.root, { theme: THEME, atlas, viewport: { width: 400, height: 300 } });
    root.update(0);

    gallery.root.invalidateMeasure();
    root.update(16);
    expect(root.layoutPasses).toBe(2);
    root.update(32);
    expect(root.layoutPasses).toBe(2);
  });

  it('keeps the whole gallery inside a draw-call budget', () => {
    // A ceiling rather than a target. The gallery is denser than any real screen
    // -- every widget in the framework at once -- so if it fits here, an
    // inventory or a character sheet fits with room to spare. The number fails
    // when something starts emitting a quad per pixel, which is the failure mode
    // worth catching.
    const frame = renderGallery();
    const list = frame.root.paint();
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(2000);
  });

  it('spends its draw calls on glyphs rather than on chrome', () => {
    const frame = renderGallery();
    const commands = frame.root.paint().finish();
    const sprites = commands.filter((command) => command.kind === 'sprite').length;
    const solids = commands.filter((command) => command.kind === 'solid').length;
    // Chrome is nine quads per frame at most; text is one per inked glyph. If
    // solids ever outnumber sprites, something is drawing a background per
    // character.
    expect(sprites).toBeGreaterThan(solids);
  });

  it('never leaves the clip stack unbalanced', () => {
    // `finish()` throws on an unbalanced stack; a widget that pushes and forgets
    // to pop clips everything drawn after it, which looks like the *next* widget
    // being broken.
    for (const scrollTo of [0, 100, 260, 10_000]) {
      expect(() => renderGallery({ scrollTo }).root.paint().finish()).not.toThrow();
    }
  });
});
