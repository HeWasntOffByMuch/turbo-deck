/**
 * The action bar screen (spec 196).
 *
 * What is asserted here is what only exists once the widgets have been laid out:
 * that the bar is five slots of the framework's own size, that it takes a click
 * where a slot is and passes the pointer through where one is not, and that
 * nothing about a fight -- a draining wedge, a slot going unaffordable -- costs
 * a layout pass.
 */

import { describe, expect, it } from 'vitest';
import { Anchor } from '../core/containers.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { colorKey } from '../core/color.js';
import { bakeAtlas } from '../render/atlas.js';
import { MOTION, REDUCED_MOTION } from '../core/motion.js';
import { THEME } from '../theme/theme.js';
import { SLOT_SIDE, type AbilityView } from '../widgets/skill-slot.js';
import {
  ActionBarScreen,
  HIGHLIGHT_TOKENS,
  actionBarInsets,
  barWidth,
  iconScaleFor,
  type ActionSlotView,
} from './action-bar.js';

const VIEWPORT = { width: 400, height: 300 };
const SLOTS = 5;

interface Harness {
  readonly bar: ActionBarScreen;
  readonly root: UiRoot;
  readonly pressed: number[];
  frame(nowMs?: number): void;
  tints(): readonly string[];
}

function harness(): Harness {
  const layers = new LayerStack();
  const bar = new ActionBarScreen({ theme: THEME, slotCount: SLOTS });
  const pressed: number[] = [];
  bar.onUse = (index) => pressed.push(index);
  const dock = new Anchor('bar:dock');
  dock.pointerTransparent = true;
  dock.padding = actionBarInsets(THEME, 0);
  dock.place(bar, 'bottom');
  layers.place('hud', dock);
  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: VIEWPORT,
    layers,
  });
  return {
    bar,
    root,
    pressed,
    frame(nowMs = 0) {
      root.update(nowMs);
    },
    tints() {
      const seen = new Set<string>();
      for (const command of root.paint().finish()) {
        if (command.kind === 'sprite') seen.add(colorKey(command.tint));
        if (command.kind === 'solid') seen.add(colorKey(command.color));
      }
      return [...seen];
    },
  };
}

function ability(overrides: Partial<AbilityView> = {}): AbilityView {
  return {
    id: 'melee.heavy',
    name: 'Heavy',
    icon: 'ability:heavy',
    cost: 12,
    sweep: 0,
    affordable: true,
    secondsLeft: 0,
    ...overrides,
  };
}

function slot(overrides: Partial<ActionSlotView> = {}): ActionSlotView {
  return {
    ability: ability(),
    keyLabel: '1',
    hint: [{ text: 'Heavy' }],
    badge: '',
    highlight: null,
    change: null,
    refund: null,
    ...overrides,
  };
}

const EMPTY = slot({ ability: null });

describe('the action bar screen', () => {
  it('is five slots of the size it was told, in a row', () => {
    const bag = harness();
    bag.bar.setView({ slots: Array.from({ length: SLOTS }, () => EMPTY) });
    bag.frame();
    expect(bag.bar.slots).toHaveLength(SLOTS);
    for (const cell of bag.bar.slots) {
      expect(cell.rect.width).toBe(SLOT_SIDE);
      expect(cell.rect.height).toBe(SLOT_SIDE);
    }
    expect(bag.bar.rect.width).toBe(barWidth(SLOTS, SLOT_SIDE, THEME.spacing.xs));
  });

  /**
   * The one thing about the bar that is not simply "the framework's own slot".
   *
   * A bag cell is a thing you look at; these are tap targets, and the mount
   * converts a *physical* size into UI pixels through whatever scale is in
   * force. So the side has to be settable, and setting it has to be layout.
   */
  it('takes a slot size, and re-measures when it changes', () => {
    const bag = harness();
    bag.bar.setView({ slots: Array.from({ length: SLOTS }, () => slot()) });
    bag.frame();

    bag.bar.setSlotSide(46);
    expect(bag.bar.needsMeasure).toBe(true);
    bag.frame();
    expect(bag.bar.side).toBe(46);
    for (const cell of bag.bar.slots) expect(cell.rect.width).toBe(46);
    expect(bag.bar.rect.width).toBe(barWidth(SLOTS, 46, THEME.spacing.xs));

    // Setting the same size again is free.
    bag.bar.setSlotSide(46);
    expect(bag.bar.needsMeasure).toBe(false);
  });

  it('magnifies the icon with the box, in whole steps', () => {
    // Whole, because that is the only kind of blit this framework does -- and
    // derived, so a bigger slot cannot end up with the art marooned in it.
    expect(iconScaleFor(SLOT_SIDE)).toBe(1);
    expect(iconScaleFor(46)).toBe(3);
    expect(iconScaleFor(8)).toBe(1);
  });

  it('sits along the bottom, clear of whatever the floor is holding', () => {
    const bag = harness();
    bag.bar.setView({ slots: [slot()] });
    bag.frame();
    expect(bag.bar.rect.y + bag.bar.rect.height).toBe(VIEWPORT.height - THEME.spacing.sm);
    expect(actionBarInsets(THEME, 24).bottom).toBe(24 + THEME.spacing.sm);
  });

  it('takes a click on a slot and lets one beside it through', () => {
    const bag = harness();
    bag.bar.setView({ slots: Array.from({ length: SLOTS }, () => slot()) });
    bag.frame();
    const cell = bag.bar.slots[2];
    if (!cell) throw new Error('no third slot');
    const middle = {
      x: cell.rect.x + Math.floor(cell.rect.width / 2),
      y: cell.rect.y + Math.floor(cell.rect.height / 2),
    };
    expect(bag.bar.hitTest(middle)).toBe(cell);
    // Above the bar is the world, and it stays the world.
    expect(bag.bar.hitTest({ x: middle.x, y: bag.bar.rect.y - 4 })).toBeNull();
  });

  it('reports which slot was pressed, empty or not', () => {
    const bag = harness();
    bag.bar.setView({ slots: [slot(), EMPTY, slot(), EMPTY, slot()] });
    bag.frame();
    bag.bar.slots[1]?.onActivate?.(1);
    // The screen forwards it; whether an empty slot casts anything is decided by
    // `abilityForSlot` at the mount, which is the same gate the key path uses.
    expect(bag.pressed).toEqual([1]);
  });

  /**
   * The whole justification for retained mode: a fight is field writes.
   *
   * A cooldown draining, a pool emptying and a slot lighting up are all
   * paint-time facts, so sixty of these a second cost no layout at all.
   */
  it('costs no layout pass while only the numbers move', () => {
    const bag = harness();
    bag.bar.setView({ slots: [slot()] });
    bag.frame();
    const before = bag.bar.rect;

    bag.bar.setView({
      slots: [slot({ ability: ability({ sweep: 0.6, secondsLeft: 3.2, affordable: false }), highlight: 'casting' })],
    });
    expect(bag.bar.needsMeasure).toBe(false);
    bag.frame();
    expect(bag.bar.rect).toEqual(before);
  });

  it('draws each highlight in its own colour', () => {
    for (const [highlight, token] of Object.entries(HIGHLIGHT_TOKENS)) {
      const bag = harness();
      bag.bar.setView({
        slots: [slot({ highlight: highlight as keyof typeof HIGHLIGHT_TOKENS })],
      });
      bag.frame();
      expect(bag.tints(), highlight).toContain(colorKey(THEME.color(token)));
    }
  });

  it('draws a badge and a change without either becoming layout', () => {
    const bag = harness();
    bag.bar.setView({ slots: [slot({ badge: '2/3' })] });
    bag.frame();
    const before = bag.bar.rect;

    bag.bar.setView({ slots: [slot({ badge: '1/3', change: { label: 'EQUIP', progress: 0.5 } })] });
    expect(bag.bar.needsMeasure).toBe(false);
    bag.frame();
    expect(bag.bar.rect).toEqual(before);
  });
});

/**
 * Which slot the cursor rests on (spec 235).
 *
 * The world draws the hovered skill's reach on the ground, and `src/ui/` may not
 * reach the sim -- so what this layer owes is an index and an *edge*, not a
 * level: `pointerMoved` fires on every mouse move, and a callback per move
 * would re-lay a ground decal several times a frame while the cursor sat still.
 */
describe('the hovered slot', () => {
  it('reports entering and leaving a slot, once each', () => {
    const bar = new ActionBarScreen({ theme: THEME, slotCount: 4 });
    const seen: (number | null)[] = [];
    bar.onHover = (index) => seen.push(index);
    const [first, second] = bar.slots;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;
    first.rect = { x: 0, y: 0, width: 20, height: 20 };
    second.rect = { x: 40, y: 0, width: 20, height: 20 };

    bar.pointerMoved({ x: 45, y: 10 }, 0);
    bar.pointerMoved({ x: 50, y: 12 }, 16);
    expect(seen).toEqual([1]);
    expect(bar.hoveredSlot).toBe(1);

    bar.pointerMoved({ x: 200, y: 10 }, 32);
    expect(seen).toEqual([1, null]);
    expect(bar.hoveredSlot).toBeNull();
  });
});

/**
 * The refund mark (spec 253): where it is drawn, and when it stops being.
 *
 * Asserted off the draw list rather than off pixels, because what is being
 * checked is that the widget *emits* the mark at the right moment and in the
 * right colour -- the picture itself is `world-hud-refunded.png`, which is the
 * only thing that can say whether it reads.
 */
describe('a cooldown reduction landing on a slot', () => {
  const REFUND = { label: '-1.2', startedMs: 1000 };
  const success = colorKey(THEME.color('success'));

  /** Every glyph and quad the mark contributes, by their vertical position. */
  function marks(test: Harness): readonly number[] {
    const tops: number[] = [];
    for (const command of test.root.paint().finish()) {
      if (command.kind === 'sprite' && colorKey(command.tint) === success) tops.push(command.dst.y);
      if (command.kind === 'solid' && colorKey(command.color) === success) tops.push(command.dst.y);
    }
    return tops;
  }

  it('draws nothing in the mark’s colour until one lands', () => {
    const test = harness();
    test.bar.setView({ slots: [slot()] });
    test.frame(1000);
    expect(marks(test)).toHaveLength(0);
  });

  it('draws the frame and the label the moment it lands', () => {
    const test = harness();
    test.bar.setView({ slots: [slot({ refund: REFUND })] });
    test.frame(1000);
    expect(marks(test).length).toBeGreaterThan(0);
  });

  /**
   * The whole point of the mark: it leaves. Asserted as the label's *topmost*
   * pixel rising, which is the one thing a still frame cannot show.
   */
  it('carries the label upward as it ages', () => {
    const test = harness();
    test.bar.setView({ slots: [slot({ refund: REFUND })] });
    test.frame(1000);
    const atStart = Math.min(...marks(test));
    test.frame(1300);
    const later = Math.min(...marks(test));
    expect(later).toBeLessThan(atStart);
  });

  /**
   * **The property the first cut got wrong, at the size it got it wrong at.**
   *
   * The travel was one slot side, which is right in spirit and was wrong in
   * fact: the bar converts a *physical* 46 CSS pixels through the interface
   * scale, so a shipped slot is 20-23 UI pixels rather than the 46 an unscaled
   * gallery draws. Twenty pixels over 800ms is a quarter of a pixel a frame, and
   * sub-pixel-per-frame motion does not read as motion -- it reads as a label
   * that appeared somewhere and sat there, which is how it was reported.
   *
   * So the claim is not "it ends up higher than it started", which the old
   * version satisfied. It is that **every frame moves it**, at the smallest slot
   * the bar is ever drawn at and at the frame rate the game runs at.
   */
  it('moves every frame at 60fps, at the bar’s smallest slot', () => {
    const test = harness();
    test.bar.setSlotSide(SLOT_SIDE);
    test.bar.setView({ slots: [slot({ refund: REFUND })] });

    const frameMs = 1000 / 60;
    let previous = Number.POSITIVE_INFINITY;
    let frames = 0;
    for (let elapsed = 0; elapsed < MOTION.refund.durationMs - frameMs; elapsed += frameMs) {
      test.frame(REFUND.startedMs + elapsed);
      const top = Math.min(...marks(test));
      if (frames > 0) {
        expect(top, `frame ${frames} at ${Math.round(elapsed)}ms`).toBeLessThanOrEqual(previous - 1);
      }
      previous = top;
      frames += 1;
    }
    // ...and it really was the whole life being sampled, not two frames of it.
    expect(frames).toBeGreaterThan(40);
  });

  /**
   * Linear, which is what separates *rising* from *arriving*.
   *
   * The three other entries in `MOTION` ease out because each is arriving
   * somewhere; a decelerating float reads as having got there and then creeping.
   * `world/damage-popup.ts` rises its numbers at a constant rate for this
   * reason, and this is the same object one layer over -- so the travel in the
   * first half of the life is the travel in the second.
   */
  it('rises at a constant rate, as the world’s own floating numbers do', () => {
    const test = harness();
    test.bar.setSlotSide(SLOT_SIDE);
    test.bar.setView({ slots: [slot({ refund: REFUND })] });
    const half = MOTION.refund.durationMs / 2;

    test.frame(REFUND.startedMs);
    const start = Math.min(...marks(test));
    test.frame(REFUND.startedMs + half);
    const middle = Math.min(...marks(test));
    test.frame(REFUND.startedMs + MOTION.refund.durationMs - 1);
    const end = Math.min(...marks(test));

    expect(start - middle).toBeGreaterThan(0);
    // Within a pixel of each other: the two halves are the same distance.
    expect(Math.abs((start - middle) - (middle - end))).toBeLessThanOrEqual(1);
  });

  it('stops drawing once its window has run out', () => {
    const test = harness();
    test.bar.setView({ slots: [slot({ refund: REFUND })] });
    test.frame(1000 + MOTION.refund.durationMs);
    expect(marks(test)).toHaveLength(0);
  });

  /**
   * Reduce-motion is answered centrally by `animate`, which snaps to the end of
   * the tween -- so the mark still appears and still expires, it simply does not
   * travel. A player who asked for less motion is not a player who asked to be
   * told less.
   */
  it('still says its piece with motion reduced, without moving', () => {
    const test = harness();
    test.bar.setView({ slots: [slot({ refund: REFUND })] });
    test.root.setMotion(REDUCED_MOTION);
    test.frame(1000);
    const atStart = Math.min(...marks(test));
    expect(Number.isFinite(atStart)).toBe(true);
    test.frame(1300);
    expect(Math.min(...marks(test))).toBe(atStart);
  });

  it('costs no layout pass -- a mark is a field, like everything else in a fight', () => {
    const test = harness();
    test.bar.setView({ slots: [slot()] });
    test.frame(1000);
    const before = test.bar.slots[0]?.rect;
    test.bar.setView({ slots: [slot({ refund: REFUND })] });
    test.frame(1000);
    expect(test.bar.slots[0]?.rect).toEqual(before);
  });
});
