/**
 * What a tooltip does with more than one line (spec 176).
 *
 * The waiting and the edge flip are spec 124's and are checked through the
 * screens that use them. What is worth checking here is the half that is new:
 * that a line keeps its colour through wrapping, that prose still behaves
 * exactly as the one unstyled run it always was, and that "the same thing is
 * under the cursor" is judged on the colour as well as the words.
 */

import { describe, expect, it } from 'vitest';
import { DrawList } from '../core/draw-list.js';
import { FULL_MOTION } from '../core/motion.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import type { Color } from '../core/color.js';
import { UiRoot } from '../core/root.js';
import { LayerStack } from '../core/layers.js';
import { Tooltip, type TooltipContent } from './tooltip.js';

const ATLAS = bakeAtlas(THEME);
const VIEWPORT = { width: 200, height: 160 };

const PAINT = {
  theme: THEME,
  atlas: ATLAS,
  now: 0,
  motion: FULL_MOTION,
  hovered: null,
  pressed: null,
  focused: null,
};

/** A laid-out, shown tooltip, and the colours it drew its glyphs in. */
function shown(content: TooltipContent): { tooltip: Tooltip; tints: readonly Color[] } {
  const layers = new LayerStack();
  const tooltip = new Tooltip();
  tooltip.viewport = VIEWPORT;
  layers.place('tooltip', tooltip);
  const root = new UiRoot(layers, { theme: THEME, atlas: ATLAS, viewport: VIEWPORT, layers });
  tooltip.point(content, { x: 4, y: 4 }, 0);
  tooltip.update(THEME.input.tooltipDelayMs + 1, THEME.input.tooltipDelayMs);
  root.update(THEME.input.tooltipDelayMs + 1);

  const list = new DrawList();
  tooltip.paint(list, PAINT);
  const tints = list
    .finish()
    .filter((cmd) => cmd.kind === 'sprite')
    .map((cmd) => (cmd as { tint: Color }).tint);
  return { tooltip, tints };
}

const key = (color: Color): string => `${color.r},${color.g},${color.b}`;

/**
 * Every distinct colour the *text* was drawn in, in draw order.
 *
 * A run of glyphs counts once, and the box's own 9-slice is dropped: it is
 * sprites too, in the frame tint, and it is drawn before every line.
 */
function runs(tints: readonly Color[]): readonly string[] {
  const frame = key(THEME.widget('tooltip').state('normal').frameTint);
  const out: string[] = [];
  for (const tint of tints) {
    const at = key(tint);
    if (at === frame) continue;
    if (out[out.length - 1] !== at) out.push(at);
  }
  return out;
}

describe('a tooltip of lines', () => {
  it('draws each line in its own colour', () => {
    const { tints } = shown([
      { text: 'NAME', colorToken: 'rarityRare' },
      { text: 'GOOD', colorToken: 'success' },
      { text: 'BAD', colorToken: 'danger' },
    ]);
    expect(runs(tints)).toEqual([
      key(THEME.color('rarityRare')),
      key(THEME.color('success')),
      key(THEME.color('danger')),
    ]);
  });

  it('draws a line with no token in the tooltip\'s own text colour', () => {
    const { tints } = shown([{ text: 'PLAIN' }]);
    expect(runs(tints)).toEqual([key(THEME.widget('tooltip').state('normal').text)]);
  });

  /**
   * Prose is the single unstyled run it always was.
   *
   * The character sheet passes a string and this is the assertion that it did
   * not quietly change under it when the bag learned to pass lines.
   */
  it('takes a string as one unstyled line', () => {
    const fromString = shown('THE SAME WORDS');
    const fromLines = shown([{ text: 'THE SAME WORDS' }]);
    expect(fromString.tooltip.desiredSize).toEqual(fromLines.tooltip.desiredSize);
    expect(runs(fromString.tints)).toEqual(runs(fromLines.tints));
    expect(fromString.tooltip.label).toBe('THE SAME WORDS');
  });

  /**
   * Wrapping is per line, and a fragment keeps its line's colour.
   *
   * The failure this rules out is the one a joined string would have: a name too
   * long for the box folding into the stat under it, so two facts end up on one
   * line in one of their two colours.
   */
  it('wraps each line on its own, and every fragment keeps its colour', () => {
    const long = 'A NAME FAR TOO LONG TO FIT INSIDE ONE HUNDRED AND FORTY PIXELS OF BODY TEXT';
    const { tooltip, tints } = shown([
      { text: long, colorToken: 'rarityExceptional' },
      { text: '+8 DAMAGE', colorToken: 'success' },
    ]);
    // More than two lines tall: the name folded rather than being clipped.
    const lineHeight = 7;
    expect(tooltip.desiredSize.height).toBeGreaterThan(lineHeight * 2);
    // ...and exactly two colours, in order, however many fragments the name took.
    expect(runs(tints)).toEqual([key(THEME.color('rarityExceptional')), key(THEME.color('success'))]);
  });

  it('reads back as plain text, one line per line', () => {
    const { tooltip } = shown([{ text: 'NAME' }, { text: 'RARE' }]);
    expect(tooltip.label).toBe('NAME\nRARE');
  });

  it('drops empty lines rather than drawing a blank one', () => {
    const { tooltip } = shown([{ text: 'NAME' }, { text: '' }, { text: 'RARE' }]);
    expect(tooltip.content).toHaveLength(2);
  });

  /**
   * The same content does not restart the wait, and a different colour is
   * different content.
   *
   * The second half is the one worth stating: the same item can be described in
   * the same words at two tiers only if something has changed about it, and a
   * tooltip that kept counting would be describing the old one.
   */
  it('judges "the same thing" on the words and the colour together', () => {
    const tooltip = new Tooltip();
    tooltip.viewport = VIEWPORT;
    const delay = THEME.input.tooltipDelayMs;

    tooltip.point([{ text: 'SWORD', colorToken: 'rarityCommon' }], { x: 0, y: 0 }, 0);
    expect(tooltip.update(delay + 1, delay)).toBe(true);

    // Same words, cursor moved: still showing, because the wait never restarted.
    tooltip.point([{ text: 'SWORD', colorToken: 'rarityCommon' }], { x: 4, y: 4 }, delay + 1);
    expect(tooltip.update(delay + 2, delay)).toBe(true);

    // Same words, different tier: a new thing, and the wait starts again.
    tooltip.point([{ text: 'SWORD', colorToken: 'rarityRare' }], { x: 4, y: 4 }, delay + 2);
    expect(tooltip.update(delay + 3, delay)).toBe(false);
    expect(tooltip.update(delay * 2 + 3, delay)).toBe(true);
  });

  it('says nothing when it is handed nothing', () => {
    const tooltip = new Tooltip();
    tooltip.viewport = VIEWPORT;
    tooltip.point([], { x: 0, y: 0 }, 0);
    expect(tooltip.update(10_000, THEME.input.tooltipDelayMs)).toBe(false);
    tooltip.point(null, { x: 0, y: 0 }, 0);
    expect(tooltip.label).toBe('');
  });
});
