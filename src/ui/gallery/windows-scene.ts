/**
 * Six windows, tabs and a tooltip, on one screen (spec 124).
 *
 * The phase-2 half of the QA surface, and the subject of its own goldens. Six
 * because that is the number the brief's frame budget is stated against -- if it
 * holds here it holds for a real screen, since no real screen is six windows of
 * different widgets all open at once.
 *
 * Built as a pure function of a theme and an atlas, like the widget gallery, so
 * the tree the browser draws and the tree `npm test` compares are the same tree.
 */

import { Column, Row } from '../core/containers.js';
import { LayerStack } from '../core/layers.js';
import { uniformInsets, type Size } from '../core/geom.js';
import { WindowManager } from '../core/window-manager.js';
import type { Widget } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Checkbox } from '../widgets/checkbox.js';
import { Label } from '../widgets/label.js';
import { ScrollView } from '../widgets/scroll-view.js';
import { Slider } from '../widgets/slider.js';
import { TabPanel } from '../widgets/tabs.js';
import { TextField } from '../widgets/text-field.js';
import { Tooltip } from '../widgets/tooltip.js';
import { UiWindow } from '../widgets/window.js';

export interface WindowsScene {
  readonly root: LayerStack;
  readonly manager: WindowManager;
  readonly tooltip: Tooltip;
  readonly tabs: TabPanel;
  readonly parts: Readonly<Record<string, Widget>>;
}

function heading(theme: Theme, text: string): Label {
  const label = new Label(text, 'body');
  label.colorToken = 'accent';
  void theme;
  return label;
}

function stack(theme: Theme, children: readonly Widget[]): Column {
  const column = new Column();
  column.gap = theme.spacing.xs;
  column.addAll(children);
  return column;
}

export function buildWindowsScene(theme: Theme, viewport: Size): WindowsScene {
  const parts: Record<string, Widget> = {};
  const manager = new WindowManager();
  const layers = new LayerStack();
  layers.place('windows', manager);

  const tooltip = new Tooltip();
  tooltip.viewport = viewport;
  layers.place('tooltip', tooltip);

  // --- 1: a tabbed window, which is what the character sheet will be ---------
  const tabs = new TabPanel('character');
  tabs.addTab('stats', 'Stats', () =>
    stack(theme, [
      heading(theme, 'STATS'),
      new Separator('row'),
      new Label('Strength   12', 'body'),
      new Label('Dexterity   9', 'body'),
      new Label('Vitality   14', 'body'),
    ]),
  );
  tabs.addTab('skills', 'Skills', () =>
    stack(theme, [heading(theme, 'SKILLS'), new Separator('row'), new Label('Nothing learned', 'body')]),
  );
  tabs.addTab('gear', 'Gear', () => stack(theme, [new Label('Empty', 'body')]));
  parts['tabs'] = tabs;

  const characterWindow = new UiWindow(tabs, {
    title: 'Character',
    at: { x: 8, y: 8 },
    size: { width: 140, height: 96 },
    resizable: true,
  });
  manager.register(characterWindow, 'character');

  // --- 2: a scrolling list ---------------------------------------------------
  const list = new Column('log');
  list.padding = uniformInsets(theme.spacing.xs);
  list.gap = theme.spacing.xs;
  for (let i = 1; i <= 14; i++) list.add(new Label(`Log line ${i}`, 'body'));
  const scroller = new ScrollView(list, 'logScroll');
  parts['logScroll'] = scroller;
  manager.register(
    new UiWindow(scroller, { title: 'Log', at: { x: 160, y: 8 }, size: { width: 120, height: 80 }, resizable: true }),
    'log',
  );

  // --- 3: settings, exercising the interactive widgets -----------------------
  const volume = new Slider(0, 100, 65, 5, 'volume');
  const settings = stack(theme, [
    new Checkbox('Fullscreen', 'settings:fullscreen'),
    new Checkbox('Show FPS', 'settings:fps'),
    volume,
  ]);
  parts['volume'] = volume;
  manager.register(
    new UiWindow(settings, { title: 'Settings', at: { x: 24, y: 112 }, size: { width: 128, height: 72 } }),
    'settings',
  );

  // --- 4: a search field, so a focused caret is in the picture ---------------
  const search = new TextField('', 'search');
  // ASCII: the body face is printable ASCII, and a character it has no glyph for
  // draws a solid block on purpose -- visibly wrong rather than invisibly missing.
  search.placeholder = 'Search...';
  parts['search'] = search;
  manager.register(
    new UiWindow(stack(theme, [search]), { title: 'Find', at: { x: 168, y: 100 }, size: { width: 112, height: 44 } }),
    'find',
  );

  // --- 5: pinned, so Escape has something to skip ---------------------------
  const pinned = new UiWindow(stack(theme, [new Label('Pinned', 'body')]), {
    title: 'Map',
    at: { x: 208, y: 152 },
    size: { width: 88, height: 40 },
  });
  pinned.pinned = true;
  manager.register(pinned, 'map');

  // --- 6: unclosable, so Escape has something else to skip ------------------
  const buttons = new Row('actions');
  buttons.gap = theme.spacing.xs;
  buttons.addAll([new Button('OK', 'actions:ok'), new Button('No', 'actions:no')]);
  manager.register(
    new UiWindow(stack(theme, [buttons]), {
      title: 'Prompt',
      at: { x: 60, y: 196 },
      size: { width: 96, height: 44 },
      closable: false,
    }),
    'prompt',
  );

  manager.setViewport(viewport);
  return { root: layers, manager, tooltip, tabs, parts };
}
