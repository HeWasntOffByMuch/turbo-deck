/**
 * The screen that edits the map (spec 125).
 *
 * A row per action: its name, its two chords as buttons, and a reset. Clicking a
 * chord button enters *capture* -- the row swallows the next key, mouse button or
 * wheel notch and binds it (spec 189). The three go through one function, because
 * a chord does not remember which device pressed it.
 *
 * Three details that are the difference between this and a list of labels.
 *
 * **Capture pushes `textEntry`.** For the same reason a focused text field does:
 * while capturing, `Digit1` must bind and not also cast. That is the whole reason
 * spec 123 made contexts a stack rather than a flag.
 *
 * **A conflict is offered, not enforced.** Binding a chord somebody else has
 * leaves both in place and shows what it clashes with. The player can then decide
 * -- and a map that refused the edit would leave them with no way to swap two
 * keys, since every intermediate state is a conflict.
 *
 * **An unbound row says so.** Blank reads as "no name", not as "nothing will
 * happen", so the button carries the word.
 *
 * Pure. No DOM, no clock: capture is driven by events handed in.
 */

import { Column, Row } from '../core/containers.js';
import type { EventContext } from '../core/events.js';
import { uniformInsets } from '../core/geom.js';
import type { Widget } from '../core/widget.js';
import {
  ACTION_CATEGORIES,
  actionById,
  chordLabel,
  isBindable,
  pointerCode,
  wheelCode,
  type ActionCategory,
  type ActionDefinition,
  type Chord,
} from '../input/actions.js';
import { chordOf, type BindingSlot, type InputMap, type Modifiers } from '../input/input-map.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { TabPanel } from '../widgets/tabs.js';
import { TextField } from '../widgets/text-field.js';

/** What the screen is waiting for, when it is waiting. */
export interface Capture {
  readonly actionId: string;
  readonly slot: BindingSlot;
}

export interface KeybindingsOptions {
  readonly theme: Theme;
  readonly map: InputMap;
  /** Push/pop the text-entry context while capturing. */
  readonly contexts?: { push(id: 'textEntry'): void; pop(id: 'textEntry'): void };
}

/** One editable row, kept out of the screen so a test can drive one in isolation. */
export class BindingRow extends Row {
  readonly primaryButton: Button;
  readonly secondaryButton: Button;
  readonly resetButton: Button;
  /** Public so a test can measure it: a name too wide for it clips in silence. */
  readonly nameLabel: Label;

  constructor(
    readonly action: ActionDefinition,
    private readonly screen: KeybindingsScreen,
    theme: Theme,
  ) {
    super(`row:${action.id}`);
    this.gap = theme.spacing.xs;

    this.nameLabel = new Label(action.label, 'body');
    this.nameLabel.layoutGrow = 2;

    this.primaryButton = new Button('', `bind:${action.id}:primary`);
    this.primaryButton.layoutGrow = 2;
    this.primaryButton.onPress = () => {
      this.screen.beginCapture(action.id, 'primary');
    };

    this.secondaryButton = new Button('', `bind:${action.id}:secondary`);
    this.secondaryButton.layoutGrow = 2;
    this.secondaryButton.onPress = () => {
      this.screen.beginCapture(action.id, 'secondary');
    };

    this.resetButton = new Button('R', `reset:${action.id}`);
    this.resetButton.onPress = () => {
      this.screen.resetAction(action.id);
    };

    this.addAll([this.nameLabel, this.primaryButton, this.secondaryButton, this.resetButton]);
  }

  /** Redraw the labels from the map. Called whenever a binding changes. */
  refresh(map: InputMap, capture: Capture | null): void {
    const binding = map.bindingsFor(this.action.id);
    const capturing = (slot: BindingSlot): boolean =>
      capture?.actionId === this.action.id && capture.slot === slot;

    // `Press a key` until spec 189, which is now false for three of the rows it
    // can be sitting on: a mouse button and a wheel notch bind here too.
    this.primaryButton.setLabel(capturing('primary') ? 'Press...' : chordLabel(binding.primary));
    this.secondaryButton.setLabel(capturing('secondary') ? 'Press...' : chordLabel(binding.secondary));
    this.resetButton.enabled = map.isModified(this.action.id);
  }

  matches(query: string): boolean {
    if (query.length === 0) return true;
    const needle = query.toLowerCase();
    return this.action.label.toLowerCase().includes(needle) || this.action.id.toLowerCase().includes(needle);
  }
}

export class KeybindingsScreen extends Column {
  readonly tabs = new TabPanel('keybindingTabs');
  readonly filter = new TextField('', 'keybindingFilter');
  readonly resetAllButton: Button;
  /** The last conflict the screen noticed, for the caller to confirm or ignore. */
  private conflictNotice = '';
  private capture: Capture | null = null;

  private readonly rows: BindingRow[] = [];
  private readonly notice = new Label('', 'body');

  constructor(private readonly options: KeybindingsOptions) {
    super('keybindings');
    const theme = options.theme;
    this.padding = uniformInsets(theme.spacing.xs);
    this.gap = theme.spacing.xs;

    this.filter.placeholder = 'Filter';
    this.filter.onChange = () => {
      this.applyFilter();
    };

    this.resetAllButton = new Button('Reset all', 'resetAll');
    this.resetAllButton.onPress = () => {
      this.options.map.reset();
      this.refresh();
      this.onBindingsChanged?.();
    };

    const header = new Row('keybindingHeader');
    header.gap = theme.spacing.xs;
    this.filter.layoutGrow = 1;
    header.addAll([this.filter, this.resetAllButton]);

    this.notice.colorToken = 'danger';
    this.notice.visible = false;

    for (const category of ACTION_CATEGORIES) {
      const actions = options.map.definitions.filter((action) => action.category === category);
      if (actions.length === 0) continue;
      this.tabs.addTab(category, CATEGORY_LABELS[category], () => this.buildCategory(actions, theme));
    }
    this.tabs.layoutGrow = 1;

    this.addAll([header, new Separator('row'), this.notice, this.tabs]);
    this.refresh();
  }

  private buildCategory(actions: readonly ActionDefinition[], theme: Theme): Widget {
    const column = new Column(`category`);
    column.gap = theme.spacing.xs;
    for (const action of actions) {
      const row = new BindingRow(action, this, theme);
      this.rows.push(row);
      column.add(row);
    }
    // A tab's content is built on first selection (spec 124), so the rows that
    // appear here have never been refreshed. Do it now rather than waiting for
    // the next binding change, or a freshly-opened tab shows empty buttons.
    this.refresh();
    return column;
  }

  get capturing(): Capture | null {
    return this.capture;
  }

  get conflict(): string {
    return this.conflictNotice;
  }

  beginCapture(actionId: string, slot: BindingSlot): void {
    if (this.capture) this.endCapture();
    this.capture = { actionId, slot };
    this.options.contexts?.push('textEntry');
    this.conflictNotice = '';
    this.refresh();
  }

  /** Stop waiting, binding nothing. What Escape does. */
  cancelCapture(): void {
    if (!this.capture) return;
    this.endCapture();
    this.refresh();
  }

  private endCapture(): void {
    this.capture = null;
    this.options.contexts?.pop('textEntry');
  }

  resetAction(actionId: string): void {
    this.options.map.reset(actionId);
    this.conflictNotice = '';
    this.refresh();
    // Announced, like a binding is (spec 138). A reset writes the map exactly as
    // `applyBinding` does, and it did not say so -- so the key went back to its
    // default on screen and in the game, and the override it had just undone was
    // still in the saved profile, waiting to come back on the next refresh.
    this.onBindingsChanged?.();
  }

  /**
   * Take a key while capturing.
   *
   * Returns whether it was consumed. Escape cancels rather than binding -- it is
   * how a player gets out of a capture opened by accident, so it can never be
   * swallowed by one. A bare modifier is ignored and capture stays open, because
   * reaching for Ctrl+K means pressing Ctrl first.
   */
  captureKey(code: string, mods: Modifiers): boolean {
    const active = this.capture;
    if (!active) return false;
    if (code === 'Escape') {
      this.cancelCapture();
      return true;
    }
    return this.captureCode(code, mods);
  }

  /**
   * Take a mouse button while capturing (spec 189).
   *
   * The same function underneath, because a button is a chord: only the code
   * differs, and where it came from is not something a binding remembers. A
   * button past the fifth has no code and is swallowed with the capture left
   * open, which is what a bare modifier already does -- the alternative is
   * binding a control the window has no way to name back.
   *
   * Returns whether the press was consumed, which is true whenever a capture is
   * armed: a press the router never sees cannot become a click on whatever the
   * cursor happened to be over.
   */
  capturePointer(button: number, mods: Modifiers): boolean {
    if (!this.capture) return false;
    const code = pointerCode(button);
    if (code === null) return true;
    return this.captureCode(code, mods);
  }

  /** Take a wheel notch while capturing (spec 189). `notches` is the UI's sign. */
  captureWheel(notches: number, mods: Modifiers): boolean {
    if (!this.capture) return false;
    const code = wheelCode(notches);
    if (code === null) return true;
    return this.captureCode(code, mods);
  }

  private captureCode(code: string, mods: Modifiers): boolean {
    const active = this.capture;
    if (!active) return false;
    if (!isBindable(code)) return true;

    const chord = chordOf(code, mods);
    this.applyBinding(active.actionId, active.slot, chord);
    this.endCapture();
    this.refresh();
    return true;
  }

  /** Clear the slot currently being captured. */
  unbindCapturing(): void {
    const active = this.capture;
    if (!active) return;
    this.applyBinding(active.actionId, active.slot, null);
    this.endCapture();
    this.refresh();
  }

  private applyBinding(actionId: string, slot: BindingSlot, chord: Chord | null): void {
    const action = actionById(actionId);
    if (chord && action) {
      const clashes = this.options.map.conflicts(chord, action.context, actionId);
      // Reported, not refused. Both bindings stay live and the player decides --
      // refusing would make swapping two keys impossible, since every
      // intermediate state is a conflict.
      this.conflictNotice =
        clashes.length === 0
          ? ''
          : `${chordLabel(chord)} is also ${clashes.map((id) => actionById(id)?.label ?? id).join(', ')}`;
    } else {
      this.conflictNotice = '';
    }
    this.options.map.bind(actionId, slot, chord);
    // Every path that writes the map announces it: this one, and the two resets.
    // The alternative is a save that happens for some edits and not others, which
    // is what shipped -- and the half that did not save was the half a player
    // reaches for when they have made a mistake.
    this.onBindingsChanged?.();
  }

  /**
   * Told whenever the map was actually written to (spec 135).
   *
   * On the screen rather than on `InputMap`, because the map is a pure data
   * structure that a dozen things read and exactly one thing edits -- and a
   * change notification on the data would fire for a load as well as for a
   * player's decision, which is how a profile gets saved over itself at boot.
   */
  onBindingsChanged: (() => void) | null = null;

  /** Rebuild every row's labels from the map. */
  refresh(): void {
    for (const row of this.rows) row.refresh(this.options.map, this.capture);
    this.notice.setText(this.conflictNotice);
    this.notice.visible = this.conflictNotice.length > 0;
    this.applyFilter();
    this.invalidateMeasure();
  }

  private applyFilter(): void {
    const query = this.filter.text;
    for (const row of this.rows) row.visible = row.matches(query);
    this.invalidateMeasure();
  }

  /** Rows currently shown, for tests and for the browser page. */
  visibleRows(): readonly BindingRow[] {
    return this.rows.filter((row) => row.visible);
  }

  /** Every row built so far. Tabs build lazily, so this grows as they are opened. */
  builtRows(): readonly BindingRow[] {
    return this.rows;
  }

  /** Open every tab, so all rows exist. The browser page and tests want this. */
  buildAllTabs(): void {
    const wanted = this.tabs.activeId;
    for (const id of this.tabs.tabIds) this.tabs.select(id);
    if (wanted) this.tabs.select(wanted);
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'key' || event.phase !== 'down') return;
    if (!this.capture) return;
    // While capturing, every key belongs to this screen -- including the ones
    // that would otherwise move focus or close the window.
    if (this.captureKey(event.code, event.mods)) context.stopPropagation();
  }
}

/**
 * A category's name as a player reads it.
 *
 * A table rather than title-casing the id, because title-casing gives "Ui" --
 * and an interface that cannot spell its own name is not encouraging.
 */
const CATEGORY_LABELS: Readonly<Record<ActionCategory, string>> = {
  movement: 'Movement',
  combat: 'Combat',
  world: 'World',
  skillbar: 'Skillbar',
  camera: 'Camera',
  ui: 'UI',
  debug: 'Debug',
};

export function categoriesWithActions(map: InputMap): readonly ActionCategory[] {
  return ACTION_CATEGORIES.filter((category) =>
    map.definitions.some((action) => action.category === category),
  );
}
