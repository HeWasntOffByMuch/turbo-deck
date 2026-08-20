/**
 * The action bar screen (spec 190).
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
  frame(): void;
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
    frame() {
      root.update(0);
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
    badge: '',
    highlight: null,
    change: null,
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
