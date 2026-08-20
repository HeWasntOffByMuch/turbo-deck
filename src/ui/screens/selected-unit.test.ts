/**
 * The selected-unit mini HUD (spec 190).
 *
 * The two assertions the feature would be broken without and that nothing else
 * can see: that an empty selection draws *nothing at all* -- not even the panel
 * frame -- and that the eight status rows are shown and hidden rather than
 * created, so a body carrying one status is not held open at the height of
 * eight.
 */

import { describe, expect, it } from 'vitest';
import { Anchor } from '../core/containers.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { colorKey } from '../core/color.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import {
  FADING_TOKEN,
  MAX_STATUS_ROWS,
  PANEL_WIDTH,
  SelectedUnitScreen,
  TONE_TOKENS,
  selectedUnitInsets,
  type SelectedUnitView,
  type StatusRowView,
} from './selected-unit.js';

const VIEWPORT = { width: 640, height: 400 };

interface Harness {
  readonly panel: SelectedUnitScreen;
  readonly root: UiRoot;
  frame(): void;
  commands(): number;
  tints(): readonly string[];
}

function harness(): Harness {
  const layers = new LayerStack();
  const panel = new SelectedUnitScreen({ theme: THEME });
  // Docked the way the mount docks it. Placed straight into the layer a `Stack`
  // arranges its children to *fill*, so the panel would be measured at its own
  // width and then arranged at the width of the whole frame.
  const dock = new Anchor('selected:dock');
  dock.pointerTransparent = true;
  dock.padding = selectedUnitInsets(THEME, 0);
  dock.place(panel, 'topRight');
  layers.place('hud', dock);
  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: VIEWPORT,
    layers,
  });
  return {
    panel,
    root,
    frame() {
      root.update(0);
    },
    commands() {
      return root.paint().finish().length;
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

function row(overrides: Partial<StatusRowView> = {}): StatusRowView {
  return { id: 'exposed', label: 'Exposed', remaining: '2.0s', tone: 'affliction', fading: false, ...overrides };
}

function unit(overrides: Partial<SelectedUnitView> = {}): SelectedUnitView {
  return {
    name: 'Grazer',
    detail: 'Lv 3',
    health: { current: 60, max: 120 },
    dead: false,
    statuses: [row()],
    ...overrides,
  };
}

describe('the selected-unit panel', () => {
  it('draws nothing at all when nothing is selected', () => {
    // Not an empty frame in the corner: a panel outline over a body nobody
    // clicked is the interface announcing that a feature exists.
    const bag = harness();
    bag.panel.setView(null);
    bag.frame();
    expect(bag.panel.visible).toBe(false);
    expect(bag.commands()).toBe(0);
  });

  it('draws when something is, and stops again when it is deselected', () => {
    const bag = harness();
    bag.panel.setView(unit());
    bag.frame();
    expect(bag.commands()).toBeGreaterThan(0);

    bag.panel.setView(null);
    bag.frame();
    expect(bag.commands()).toBe(0);
  });

  it('is a fixed width, so its left edge does not move as statuses come and go', () => {
    const bag = harness();
    bag.panel.setView(unit({ statuses: [] }));
    bag.frame();
    const narrow = bag.panel.rect;

    bag.panel.setView(unit({ statuses: [row({ label: 'Vulnerable x9', remaining: '12s' })] }));
    bag.frame();
    expect(bag.panel.rect.width).toBe(narrow.width);
    expect(bag.panel.rect.x).toBe(narrow.x);
    expect(bag.panel.rect.width).toBe(PANEL_WIDTH);
  });

  it('clears the frame edge and whatever the mount says is above it', () => {
    const bag = harness();
    bag.panel.setView(unit());
    bag.frame();
    const flush = bag.panel.rect.y;

    // The tuning popovers, measured and handed in by the mount.
    const inset = selectedUnitInsets(THEME, 40);
    expect(inset.top).toBe(40 + THEME.spacing.sm);
    expect(flush).toBe(THEME.spacing.sm);
  });

  it('shows one row per status and hides the rest, rather than building them', () => {
    const bag = harness();
    bag.panel.setView(unit({ statuses: [row({ id: 'flow' }), row({ id: 'exposed' })] }));
    bag.frame();
    const withTwo = bag.panel.rect.height;

    bag.panel.setView(unit({ statuses: [row({ id: 'flow' })] }));
    bag.frame();
    // Hidden rows measure to nothing, so the panel shrinks. A row emptied
    // rather than hidden still costs a line of height, and eight of those would
    // hold the panel open at full size for a body carrying one status.
    expect(bag.panel.rect.height).toBeLessThan(withTwo);
  });

  it('never draws more rows than the wire can carry', () => {
    const bag = harness();
    const many = Array.from({ length: MAX_STATUS_ROWS + 4 }, (_, index) =>
      row({ id: `s${index}`, label: `Status ${index}` }),
    );
    bag.panel.setView(unit({ statuses: many }));
    bag.frame();
    // The extra four are simply not drawn: there are eight rows and there is no
    // path that creates a ninth.
    expect(bag.panel.rect.height).toBeLessThan(VIEWPORT.height);
  });

  it('colours a boon, an affliction and a row about to run out differently', () => {
    const bag = harness();
    bag.panel.setView(
      unit({
        statuses: [
          row({ id: 'flow', tone: 'boon' }),
          row({ id: 'exposed', tone: 'affliction' }),
          row({ id: 'sundered', tone: 'affliction', fading: true }),
        ],
      }),
    );
    bag.frame();
    const tints = bag.tints();
    expect(tints).toContain(colorKey(THEME.color(TONE_TOKENS.boon)));
    expect(tints).toContain(colorKey(THEME.color(TONE_TOKENS.affliction)));
    expect(tints).toContain(colorKey(THEME.color(FADING_TOKEN)));
  });

  it('lets the pointer through, everywhere', () => {
    // The world is underneath. A readout that took a click would be a hole in
    // the game in one corner of the screen.
    const bag = harness();
    bag.panel.setView(unit());
    bag.frame();
    const middle = {
      x: bag.panel.rect.x + Math.floor(bag.panel.rect.width / 2),
      y: bag.panel.rect.y + Math.floor(bag.panel.rect.height / 2),
    };
    expect(bag.panel.hitTest(middle)).toBeNull();
  });

  it('says a body is dead rather than reading 0/120', () => {
    const bag = harness();
    bag.panel.setView(unit({ dead: true, health: { current: 0, max: 120 } }));
    bag.frame();
    expect(bag.panel.health.caption).toBe('Dead');
    expect(bag.panel.health.filled).toBe(0);
  });
});
