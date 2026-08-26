/**
 * The options window (specs 135, 136).
 *
 * One tab on its first day, and a `TabPanel` anyway. That was not anticipation:
 * the point of this window is that it is the *place* options live, and a window
 * with a single un-tabbed page would have to be restructured the first time a
 * second option exists -- which would move the keybindings under a player's
 * feet. Spec 136 added the second tab a spec later, and it cost one line.
 *
 * It owns nothing. The keybindings screen is handed in, so this file does not
 * learn what a binding is, and persistence is a callback the mount wires to
 * storage -- `src/ui/` may not touch `localStorage` any more than it may touch a
 * clock.
 *
 * Pure. No DOM, no clock, no engine imports.
 */

import { Column } from '../core/containers.js';
import { uniformInsets } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { TabPanel } from '../widgets/tabs.js';
import type { Widget } from '../core/widget.js';

export interface OptionsOptions {
  readonly theme: Theme;
  /** The keybindings page. Built by the caller, because it needs the map. */
  readonly keys: Widget;
  /** The display page. Built by the caller, because the mount owns the scale. */
  readonly display: Widget;
  /**
   * The audio page (spec 229), or absent.
   *
   * Optional for the reason the window is a `TabPanel` in the first place: the
   * gallery and the goldens build this window with no audio engine behind them,
   * and a tab of sliders that reach nothing is worse than no tab.
   */
  readonly audio?: Widget;
}

export class OptionsScreen extends Column {
  readonly tabs = new TabPanel('optionsTabs');

  constructor(options: OptionsOptions) {
    super('options');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.padding = uniformInsets(theme.spacing.xs);

    // A thunk, because `TabPanel` builds a tab's content on first selection
    // (spec 124) -- and the keybindings screen is expensive enough to build that
    // doing it for a tab nobody opened would be a cost with no picture.
    this.tabs.addTab('keys', 'Keys', () => options.keys);
    this.tabs.addTab('display', 'Display', () => options.display);
    // Third, and only where there is an engine behind it. A thunk like the two
    // above, so a tab nobody opens costs nothing to build.
    const audio = options.audio;
    if (audio) this.tabs.addTab('audio', 'Audio', () => audio);

    // The tabs take the window, and the strip stays at the top of it (spec 198).
    // This window is registered *unscrolled*, so before the panel scrolled its
    // own body the note that used to be here -- "no `layoutGrow`, a Linear
    // squashes children it cannot fit" -- was the whole bug: a keybinding
    // category with more rows than the window is tall went through the overflow
    // branch and every row was shrunk toward nothing, with no bar and no way to
    // reach the ones at the bottom.
    this.tabs.layoutGrow = 1;
    this.add(this.tabs);
  }
}
