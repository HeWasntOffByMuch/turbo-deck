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

    // No `layoutGrow`: a Linear squashes children it cannot fit, so a growing
    // tab panel in a short window draws its rows on top of each other. Natural
    // height plus the caller's ScrollView is the honest pairing, and it is the
    // third screen to reach that answer.
    this.add(this.tabs);
  }
}
