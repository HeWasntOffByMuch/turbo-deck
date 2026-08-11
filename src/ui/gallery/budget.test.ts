import { describe, expect, it } from 'vitest';
import { buildGallery } from './gallery.js';
import { renderGallery, renderPlay } from './render.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { renderInventory, renderKeybindings, renderShop, renderWindows } from './render.js';

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

  /**
   * The HUD is the one screen drawn every frame of a fight, so its draw-call
   * count is the number the brief's budget is actually spent on. A ceiling
   * rather than a target: it fails when something starts emitting a quad per
   * pixel, which is the failure worth catching.
   *
   * That it costs no *layout* while everything on it animates is asserted in
   * `screens/hud.test.ts`, where the frames can be driven one at a time.
   */
  it('keeps the HUD and the character sheet inside a draw-call budget', () => {
    const frame = renderPlay({ cast: 0.5, cooldowns: { 0: 0.4, 3: 0.9 } });
    const list = frame.root.paint();
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(1200);
  });

  it('never leaves the clip stack unbalanced', () => {
    // `finish()` throws on an unbalanced stack; a widget that pushes and forgets
    // to pop clips everything drawn after it, which looks like the *next* widget
    // being broken.
    for (const scrollTo of [0, 100, 260, 10_000]) {
      expect(() => renderGallery({ scrollTo }).root.paint().finish()).not.toThrow();
    }
    // The HUD clips a key label and the sheet clips a tab strip, so both push.
    expect(() => renderPlay({ cast: 0.5 }).root.paint().finish()).not.toThrow();
    expect(() => renderPlay({ viewport: { width: 300, height: 140 } }).root.paint().finish()).not.toThrow();
  });
});

/**
 * Nothing in this framework blends.
 *
 * Every palette colour is opaque and every quad is drawn at full alpha, which is
 * not a style preference: a source-over blend is the one operation the software
 * rasterizer and a browser canvas cannot be made to agree on byte for byte. They
 * round it differently, and `scripts/preview-ui-gallery.ts` caught exactly that
 * on the first translucent thing ever drawn here -- a cooldown scrim, off by one
 * in two channels.
 *
 * The rule that replaced it: a "dimmed" look is a darker *opaque* token. This is
 * the check that keeps it true, since the alternative is finding out in a
 * browser months later.
 */
describe('nothing is drawn translucent', () => {
  const scenes = {
    widgets: () => renderGallery(),
    windows: () => renderWindows({ focusWindow: 'character' }),
    keys: () => renderKeybindings(),
    bag: () =>
      renderInventory({
        pickUp: { container: 'inventory', index: 0 },
        carryToCell: { container: 'inventory', index: 20 },
      }),
    play: () => renderPlay({ cast: 0.5, cooldowns: { 0: 0.4, 3: 0.9 } }),
    shop: () => renderShop({ confirmRow: 0, buyback: true }),
  };

  for (const [name, build] of Object.entries(scenes)) {
    it(`in the ${name} scene`, () => {
      for (const command of build().root.paint().finish()) {
        const alpha =
          command.kind === 'solid' ? command.color.a : command.kind === 'sprite' ? command.tint.a : 255;
        expect(alpha, `${name}: a ${command.kind} at alpha ${alpha}`).toBe(255);
      }
    });
  }

  it('has no translucent colour in the palette at all', () => {
    for (const [name, color] of Object.entries(THEME.palette)) {
      expect(color.a, name).toBe(255);
    }
  });
});
