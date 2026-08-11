/**
 * The HUD (spec 128).
 *
 * The first assertion is the one this phase exists for: a hundred frames of
 * draining bars and running cooldowns must cost zero layout passes. If it ever
 * fails, retained mode has stopped paying for itself and a fight is spending a
 * full relayout sixty times a second.
 */

import { describe, expect, it } from 'vitest';
import { UiRoot } from '../core/root.js';
import { LayerStack } from '../core/layers.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { HudScreen, type HudView } from './hud.js';
import type { AbilityView } from '../widgets/skill-slot.js';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];

function ability(id: string, sweep = 0, affordable = true): AbilityView {
  return {
    id,
    name: id,
    icon: 'ability:slash',
    cost: 10,
    sweep,
    affordable,
    secondsLeft: sweep * 6,
  };
}

function viewOf(overrides: Partial<HudView> = {}): HudView {
  return {
    health: { current: 80, max: 120 },
    resource: { current: 30, max: 50 },
    cast: null,
    slots: KEYS.map((_, i) => ability(`skill.${i}`)),
    keyLabels: KEYS,
    ...overrides,
  };
}

interface Harness {
  readonly hud: HudScreen;
  readonly root: UiRoot;
  readonly layers: LayerStack;
}

function harness(view = viewOf()): Harness {
  const hud = new HudScreen({ theme: THEME });
  const layers = new LayerStack();
  layers.place('hud', hud);
  hud.setView(view);
  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: { width: 400, height: 300 },
    layers,
  });
  root.update(0);
  return { hud, root, layers };
}

describe('the frame budget', () => {
  /** The assertion the whole spec is named after. */
  it('costs no layout at all over a hundred frames of changing numbers', () => {
    const test = harness();
    const passes = test.root.layoutPasses;

    for (let frame = 1; frame <= 100; frame++) {
      const t = frame / 100;
      test.hud.setView(
        viewOf({
          health: { current: 120 - frame, max: 120 },
          resource: { current: 50 - frame / 4, max: 50 },
          slots: KEYS.map((_, i) => ability(`skill.${i}`, Math.max(0, 1 - t - i / 20))),
        }),
      );
      test.root.update(frame * 16);
    }
    expect(test.root.layoutPasses).toBe(passes);
  });

  it('costs no layout when the same view arrives again', () => {
    const test = harness();
    const passes = test.root.layoutPasses;
    test.hud.setView(viewOf());
    test.root.update(16);
    expect(test.root.layoutPasses).toBe(passes);
  });

  /** An ability *appearing* is structural, and pays for itself once. */
  it('costs exactly one pass when a slot changes what it holds', () => {
    const test = harness();
    const passes = test.root.layoutPasses;
    const slots = KEYS.map((_, i) => (i === 3 ? ability('skill.other') : ability(`skill.${i}`)));
    test.hud.setView(viewOf({ slots }));
    test.root.update(16);
    expect(test.root.layoutPasses).toBe(passes + 1);

    // ...and not again for the same contents.
    test.hud.setView(viewOf({ slots }));
    test.root.update(32);
    expect(test.root.layoutPasses).toBe(passes + 1);
  });

  /**
   * A cast bar appearing changes what is on screen, so it is layout -- but it
   * happens twice per cast rather than sixty times a second, which is the whole
   * distinction this screen is built around.
   */
  it('pays once when a cast starts and once when it ends', () => {
    const test = harness();
    const passes = test.root.layoutPasses;

    test.hud.setView(viewOf({ cast: { name: 'Slash', progress: 0.1 } }));
    test.root.update(16);
    expect(test.root.layoutPasses).toBe(passes + 1);

    for (let frame = 2; frame <= 20; frame++) {
      test.hud.setView(viewOf({ cast: { name: 'Slash', progress: frame / 20 } }));
      test.root.update(frame * 16);
    }
    expect(test.root.layoutPasses).toBe(passes + 1);

    test.hud.setView(viewOf({ cast: null }));
    test.root.update(400);
    expect(test.root.layoutPasses).toBe(passes + 2);
  });
});

describe('what the HUD shows', () => {
  it('fills its bars from the numbers it was given', () => {
    const { hud } = harness();
    expect(hud.health.filled).toBeCloseTo(80 / 120);
    expect(hud.resource.filled).toBeCloseTo(30 / 50);
    expect(hud.health.caption).toBe('80/120');
  });

  it('draws an empty bar rather than dividing by zero', () => {
    const { hud } = harness(viewOf({ health: { current: 10, max: 0 } }));
    expect(hud.health.filled).toBe(0);
  });

  it('clamps a value that has gone outside its range', () => {
    const { hud } = harness(viewOf({ health: { current: 500, max: 120 } }));
    expect(hud.health.filled).toBe(1);
    hud.health.fraction = -3;
    expect(hud.health.filled).toBe(0);
    hud.health.fraction = Number.NaN;
    expect(hud.health.filled).toBe(0);
  });

  it('labels each slot with what the key map says fires it', () => {
    const { hud } = harness(viewOf({ keyLabels: ['Q', 'W', 'E', 'R', '5', '6', '7', '8'] }));
    expect(hud.slots.map((slot) => slot.keyLabel)).toEqual(['Q', 'W', 'E', 'R', '5', '6', '7', '8']);
  });

  it('keeps a key on a slot that has nothing in it', () => {
    const slots: (AbilityView | null)[] = KEYS.map(() => null);
    const { hud } = harness(viewOf({ slots }));
    expect(hud.slots[0]?.ability).toBeNull();
    expect(hud.slots[0]?.keyLabel).toBe('1');
  });
});

describe('a slot', () => {
  it('emits its index when clicked, and nothing else', () => {
    const { hud } = harness();
    const used: number[] = [];
    hud.onUse = (index) => used.push(index);
    hud.slots[2]?.onActivate?.(2);
    expect(used).toEqual([2]);
  });

  it('covers more of itself the longer the cooldown has left', () => {
    const { hud, root } = harness();
    const slot = hud.slots[0];
    expect(slot).toBeDefined();
    if (!slot) return;

    let previous = 0;
    for (const sweep of [0, 0.25, 0.5, 0.75, 1]) {
      hud.setView(viewOf({ slots: [ability('skill.0', sweep), ...KEYS.slice(1).map((_, i) => ability(`skill.${i + 1}`))] }));
      root.update(0);
      const height = slot.sweepRect()?.height ?? 0;
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
    expect(previous).toBe(slot.rect.height);
  });

  it('draws no wedge at all when the cooldown is done', () => {
    const { hud } = harness();
    expect(hud.slots[0]?.sweepRect()).toBeNull();
  });
});

describe('the pointer', () => {
  /**
   * The HUD is always on top of the world. If it ate clicks, a player could not
   * order a move through the half of the screen it covers.
   */
  it('is transparent everywhere except its slots', () => {
    const test = harness();
    const bar = test.hud.health;
    const overBar = { x: bar.rect.x + 2, y: bar.rect.y + 2 };
    expect(test.layers.hitTest(overBar)).toBeNull();

    const slot = test.hud.slots[0];
    expect(slot).toBeDefined();
    if (!slot) return;
    const overSlot = { x: slot.rect.x + 2, y: slot.rect.y + 2 };
    expect(test.layers.hitTest(overSlot)).toBe(slot);
  });
});
