import { describe, expect, it } from 'vitest';
import { buildGallery } from './gallery.js';
import { renderGallery, renderPlay } from './render.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { renderChat, renderControls, renderInventory, renderKeybindings, renderShop, renderWindows, GOLDEN_VIEWPORT } from './render.js';
import { LayerStack } from '../core/layers.js';
import { WindowManager } from '../core/window-manager.js';
import { UiWindow } from '../widgets/window.js';
import { Label } from '../widgets/label.js';
import { REDUCED_MOTION } from '../core/motion.js';
import { PLATE_ALPHA, PLATE_TOKEN } from '../screens/chat.js';

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
  /**
   * An animating window costs no layout (spec 133).
   *
   * The assertion that stops a tween quietly becoming a per-frame relayout the
   * next time somebody animates something. A window wiping into view is a
   * *clip*, computed while painting from the time it was handed; if this ever
   * fails, an animation has started changing a measured size and the whole
   * dirty-flag design has stopped paying for itself.
   */
  it('runs no layout while a window is animating', () => {
    const atlas = bakeAtlas(THEME);
    const layers = new LayerStack();
    const manager = new WindowManager();
    layers.place('windows', manager);
    const window = new UiWindow(new Label('inside'), { title: 'Arriving', at: { x: 8, y: 8 } });
    manager.register(window, 'arriving');
    window.visible = false;

    const root = new UiRoot(layers, { theme: THEME, atlas, viewport: GOLDEN_VIEWPORT, windows: manager, layers });
    manager.setViewport(GOLDEN_VIEWPORT);
    root.update(0);
    manager.open('arriving', 0);
    root.update(0);
    const settledPasses = root.layoutPasses;

    // A hundred frames spanning the whole animation and well past it.
    for (let frame = 1; frame <= 100; frame += 1) {
      root.update(frame * 4);
      root.paint();
    }
    expect(root.layoutPasses).toBe(settledPasses);
  });

  /** ...and it was really animating, so the assertion above means something. */
  it('draws a partly-revealed window differently from a settled one', () => {
    const atlas = bakeAtlas(THEME);
    const layers = new LayerStack();
    const manager = new WindowManager();
    layers.place('windows', manager);
    const window = new UiWindow(new Label('inside'), { title: 'Arriving', at: { x: 8, y: 8 } });
    manager.register(window, 'arriving');
    window.visible = false;
    const root = new UiRoot(layers, { theme: THEME, atlas, viewport: GOLDEN_VIEWPORT, windows: manager, layers });
    manager.setViewport(GOLDEN_VIEWPORT);
    manager.open('arriving', 0);
    root.update(0);

    root.update(20);
    const arriving = root.paint().finish().length;
    root.update(5000);
    const settled = root.paint().finish().length;
    // The clip pair is the difference, and it is gone once the window is there.
    expect(arriving).toBeGreaterThan(settled);

    // ...and with reduce-motion it is settled from the first frame.
    root.setMotion(REDUCED_MOTION);
    root.update(20);
    expect(root.paint().finish().length).toBe(settled);
  });

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
    // The controls card is excluded here for the same reason `chat` is,
    // immediately below: it is the one other surface with a translucent
    // plate on it, and it is checked on its own terms in "the one thing that
    // does blend" rather than against the opaque-everywhere rule.
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

/**
 * ...except the chat's plate, and that exception is a measurement (spec 189).
 *
 * The chat is the only surface drawn over the *world*, and a solid rectangle in
 * the corner of a game is a hole in it. So it blends -- and the reason that is
 * allowed is not that the rule above was relaxed, it is that this particular
 * blend is one the two backends round identically.
 *
 * A browser canvas stores premultiplied 8-bit and `getImageData` unpremultiplies
 * it, so a straight-alpha colour written over a transparent pixel comes back
 * rounded, where `raster.ts` writes it through untouched. For most alphas that
 * costs a byte or two per channel -- at 0.62 this plate came back `rgb(27,24,39)`
 * against `rgb(28,25,39)`, which is what `preview-ui-gallery.ts` reported before
 * the number below was chosen. For some it costs nothing, and `PLATE_ALPHA` is
 * one of those.
 *
 * Asserted here rather than left to the browser script, so a change to
 * `panelSunken` or to that constant fails in `npm test`. The fix if it does is a
 * neighbouring alpha, never a tolerance: a tolerance would hide every future
 * blending mistake along with this one.
 */
describe('the one thing that does blend', () => {
  /** What a browser canvas gives back after storing this colour premultiplied. */
  function throughPremultiplied(channel: number, alpha: number): number {
    return Math.round((Math.round((channel * alpha) / 255) * 255) / alpha);
  }

  it('survives premultiplied storage exactly, so both backends agree', () => {
    const plate = THEME.color(PLATE_TOKEN);
    for (const [name, channel] of Object.entries({ r: plate.r, g: plate.g, b: plate.b })) {
      expect(throughPremultiplied(channel, PLATE_ALPHA), `${name} at alpha ${PLATE_ALPHA}`).toBe(channel);
    }
  });

  it('is the only translucent thing the chat draws', () => {
    // Everything else -- every glyph, the field's frame, the scrollbar -- stays
    // opaque. What is see-through is the backing and nothing else, so the text
    // is exactly as legible as it was.
    const translucent = renderChat({ typing: 'on my way' })
      .root.paint()
      .finish()
      .filter((command) => {
        const alpha = command.kind === 'solid' ? command.color.a : command.kind === 'sprite' ? command.tint.a : 255;
        return alpha !== 255;
      });
    expect(translucent.length).toBeGreaterThan(0);
    for (const command of translucent) {
      expect(command.kind).toBe('solid');
      if (command.kind !== 'solid') continue;
      expect(command.color.a).toBe(PLATE_ALPHA);
      expect({ r: command.color.r, g: command.color.g, b: command.color.b }).toEqual({
        r: THEME.color(PLATE_TOKEN).r,
        g: THEME.color(PLATE_TOKEN).g,
        b: THEME.color(PLATE_TOKEN).b,
      });
    }
  });

  it('draws no plate at all when nothing has been said', () => {
    // An empty plate over the world is a black bar announcing that the chat
    // exists, and the chat announcing itself is the opposite of furniture.
    const commands = renderChat({ typing: '', empty: true }).root.paint().finish();
    const plates = commands.filter((command) => command.kind === 'solid' && command.color.a !== 255);
    expect(plates).toHaveLength(1);
  });

  /**
   * ...and the controls card's plate is the same exception, reusing the same
   * pair rather than a second chosen alpha (spec 254). Its border is opaque
   * -- `drawNineSlice` tinted with `edgeLight`, every channel of which is 255
   * -- so it must not turn up here at all; if it does, the border stopped
   * being opaque and the two-backend guarantee is gone with it.
   */
  it('is the only translucent thing the controls card draws', () => {
    const translucent = renderControls()
      .root.paint()
      .finish()
      .filter((command) => {
        const alpha = command.kind === 'solid' ? command.color.a : command.kind === 'sprite' ? command.tint.a : 255;
        return alpha !== 255;
      });
    expect(translucent.length).toBeGreaterThan(0);
    for (const command of translucent) {
      expect(command.kind).toBe('solid');
      if (command.kind !== 'solid') continue;
      expect(command.color.a).toBe(PLATE_ALPHA);
      expect({ r: command.color.r, g: command.color.g, b: command.color.b }).toEqual({
        r: THEME.color(PLATE_TOKEN).r,
        g: THEME.color(PLATE_TOKEN).g,
        b: THEME.color(PLATE_TOKEN).b,
      });
    }
  });
});
