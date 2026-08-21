/**
 * Which tabs a device is offered (spec 140).
 *
 * The tab bar has grown to six entries and five of them are workbenches: the map
 * editor is a three-button drag model (spec 049), and the two sandboxes and the
 * two studios are walls of `lil-gui` sliders. None of them can be driven by a
 * finger, and on an 844x390 landscape frame the six buttons wrap across the top
 * of the world and collide with the settings popovers in the other corner.
 *
 * So a coarse pointer is offered the game and nothing else. A `game` flag on the
 * tab rather than an index or a label match, for the same reason `fullscreen` is
 * a property of the tab: which tabs are the game is a fact about the tabs, not
 * about their order in the bar.
 *
 * Pure, and separate from `main.ts`, because `main.ts` is DOM from its first line
 * and this is the one decision in it worth failing a test over -- the day a
 * seventh workbench is added and marked wrong.
 */

/** As much of a tab as this decision needs to see. */
export interface ShellTab {
  readonly label: string;
  /** Whether this tab is the game. Absent means a workbench. */
  readonly game?: boolean;
}

/**
 * The tabs to build buttons for.
 *
 * Everything on a mouse; only the game on a finger. Never empty on a list that
 * has a game in it, because the alternative -- a shell with no tab at all -- is
 * a black page rather than a smaller one.
 */
export function visibleTabs<T extends ShellTab>(tabs: readonly T[], compact: boolean): readonly T[] {
  if (!compact) return tabs;
  const game = tabs.filter((tab) => tab.game === true);
  // A list with no game in it is not a case this can improve on, and hiding
  // every tab would leave a shell that mounts nothing at all.
  return game.length > 0 ? game : tabs;
}

/**
 * Whether the bar should draw tab buttons at all.
 *
 * One tab is not a choice, and a strip you cannot leave is furniture. The bar
 * itself stays -- `ui-layer.ts` measures it to know where the app's chrome ends,
 * and the fullscreen button lives in it (spec 093).
 */
export function showsTabButtons(visible: readonly ShellTab[]): boolean {
  return visible.length > 1;
}

/**
 * What pressing a tab should do (spec 199).
 *
 * A mount can take a network round trip now -- the Play tab and the editor fetch
 * the shipped map rather than carrying it in the bundle -- so a press is no
 * longer answered by the time the next one arrives. Two things go wrong without
 * an explicit answer, and both are worse than they look: mounting the Play tab
 * twice makes **two in-tab servers**, one of them orphaned and still holding a
 * transport, and the second mount overwrites the handle that could have stopped
 * the first.
 */
export type TabPress =
  /** Already there, or already on the way. Pressing again is not a second request. */
  | 'ignore'
  /** Mounted earlier and put away; show it again. */
  | 'show'
  /** Never mounted: start one, and remember that it is in flight. */
  | 'mount';

export function tabPress(
  index: number,
  active: number,
  mounting: ReadonlySet<number>,
  held: boolean,
): TabPress {
  if (index === active || mounting.has(index)) return 'ignore';
  return held ? 'show' : 'mount';
}

/**
 * What to do with a handle whose mount has just finished.
 *
 * `active` moves when the press is *made* rather than when the mount lands, so
 * that the button lights immediately -- a bar that does nothing for a second
 * reads as a dropped click. Which means a slow mount can arrive after the player
 * has moved on, and handing it to the screen then would put it over whatever
 * they moved to.
 *
 * Shelved rather than discarded: an unstarted handle is exactly the state a
 * backgrounded tab is in, so keeping it means coming back is instant instead of
 * a second fetch.
 */
export function mountLanded(index: number, active: number): 'show' | 'shelve' {
  return index === active ? 'show' : 'shelve';
}
