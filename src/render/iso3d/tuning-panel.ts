import GUI from 'lil-gui';

/**
 * The sandbox's live tuning panel (specs 032/037/152), generic over whatever
 * all-numeric tuning record it is pointed at.
 *
 * It started as the mech's hand-rolled slider column; the robe needs the same
 * thing for a completely different set of knobs, and a second copy would have
 * meant every later fix landing in one of them. So it is parameterised over the
 * record type instead: describe the rows, hand it the object, and it binds
 * controls straight onto the live tuning. Mutations take effect on the next
 * frame -- no apply button, no copy, no event plumbing -- which is the whole
 * point of a tuning sandbox.
 *
 * Since spec 152 the controls are `lil-gui`, which is what the map editor has
 * always used and what the brief asks for: no second UI framework in the tree,
 * and none of the sliders, number fields, colour pickers and folder chevrons
 * hand-written again here. What did NOT move is the row *data* -- a
 * {@link TuningGroup} is a plain description with no lil-gui in it, which is the
 * same split `editor/tools.ts` keeps from `editor/panel.ts` and the reason the
 * mech, robe and critter tables are readable on their own.
 *
 * Sections can be shown and hidden as a unit, so the panel can swap its contents
 * when the sandbox's unit picker changes without rebuilding anything.
 */

/** Keys of `T` whose value is a number: the only ones a row can bind to. */
export type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

interface TuningRowBase<T> {
  readonly label: string;
  readonly key: NumericKeys<T>;
  /** Hover explanation of what the knob does; shown on the whole row. */
  readonly tip: string;
}

/** One editable number: a slider, or a checkbox over a 0/1. */
export interface TuningSlider<T> extends TuningRowBase<T> {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Decimal places in the readout (0/undefined => integer). */
  readonly digits?: number;
  /** Render as an on/off checkbox instead of a slider; the value is 0 or 1. */
  readonly toggle?: boolean;
}

/**
 * One editable colour, over a key holding a hex int (`0xRRGGBB`).
 *
 * A colour is still a number, so it binds through the same `NumericKeys` as
 * every other row -- but a range with a min and a max is the wrong control for
 * one. `min`/`max`/`step` are absent rather than ignored, which is why this is a
 * union member and not a flag on the slider.
 */
export interface TuningSwatch<T> extends TuningRowBase<T> {
  readonly swatch: true;
}

export type TuningRow<T> = TuningSlider<T> | TuningSwatch<T>;

export interface TuningGroup<T> {
  readonly title: string;
  /** Start the group collapsed. Useful for the rarely-touched solver knobs. */
  readonly collapsed?: boolean;
  readonly rows: readonly TuningRow<T>[];
}

/** A mounted group of rows bound to a live tuning object. */
export interface TuningSection {
  /** Push the tuning's current values back into the controls (after a reset). */
  sync(): void;
  setVisible(visible: boolean): void;
}

function isSwatch<T>(row: TuningRow<T>): row is TuningSwatch<T> {
  return 'swatch' in row;
}

const PANEL_TEXT = '#c9c9d8';
export const LABEL_CSS = `font-family:'Segoe UI',system-ui,sans-serif;color:${PANEL_TEXT};`;

/**
 * Mount a panel into the page flow rather than lil-gui's fixed corner.
 *
 * Every GUI here lives in a tab's own column beside a canvas; left at its
 * default the panel floats over whichever tab happens to be on screen, which is
 * the same correction `editor/panel.ts` makes.
 */
export function embedGui(gui: GUI): GUI {
  gui.domElement.style.position = 'static';
  gui.domElement.style.maxWidth = '100%';
  return gui;
}

/**
 * Where lil-gui puts a GUI's or a folder's contents.
 *
 * By class rather than by index: `domElement` holds a title and this, and
 * appending to `domElement` itself drops the addition *under* the controllers
 * instead of among them. The same lookup `editor/panel.ts` makes, and for the
 * same reason -- lil-gui has no widget for a block of monospaced readout, so it
 * is raw DOM mounted inside the panel rather than floating beside it.
 */
export function guiContents(gui: GUI): HTMLElement {
  return (gui.domElement.querySelector('.lil-children') as HTMLElement | null) ?? gui.domElement;
}

/** Read a numeric field off the tuning without losing the key's type. */
function read<T>(target: T, key: NumericKeys<T>): number {
  return Number(target[key]);
}

/** Write a numeric field back. The cast is a no-op: `T[NumericKeys<T>]` is a number. */
function write<T>(target: T, key: NumericKeys<T>, value: number): void {
  target[key] = value as T[NumericKeys<T>];
}

/**
 * Bind a set of groups onto `parent` as folders. Every control writes straight
 * into `target`, so the running simulation picks changes up on its next frame.
 */
export function addTuningGroups<T>(
  parent: GUI,
  groups: readonly TuningGroup<T>[],
  target: T,
): TuningSection {
  const folders: GUI[] = [];
  const refreshers: (() => void)[] = [];

  for (const group of groups) {
    const folder = parent.addFolder(group.title);
    if (group.collapsed) folder.close();
    folders.push(folder);

    for (const row of group.rows) {
      // lil-gui's `add` is typed over `keyof T`, and a `NumericKeys<T>` narrowed
      // out of a generic does not satisfy it. The record view is the same object
      // -- every key a row can name holds a number, which is what `NumericKeys`
      // already guaranteed on the way in.
      const bag = target as unknown as Record<string, number>;
      const key = row.key as string;
      const controller = isSwatch(row)
        ? folder.addColor(bag, key)
        : row.toggle
          ? folder.add(booleanProxy(target, row.key), 'on')
          : folder.add(bag, key, row.min, row.max, row.step).decimals(row.digits ?? 0);
      controller.name(row.label);
      // lil-gui has no tooltip, and the tips are half of what this panel is
      // for: on the row's whole element, so hovering the label, the slider or
      // the readout all explain the same knob.
      controller.domElement.title = row.tip;
      refreshers.push(() => controller.updateDisplay());
    }
  }

  return {
    sync: () => {
      for (const refresh of refreshers) refresh();
    },
    setVisible: (visible: boolean) => {
      for (const folder of folders) folder.show(visible);
    },
  };
}

/**
 * A boolean view of a 0/1 field, so lil-gui draws a checkbox for it.
 *
 * lil-gui picks its control from the value's *type*, and a toggle row binds a
 * number -- which would come out as a number field reading 0 and 1. The accessor
 * pair is read on every `updateDisplay`, so the checkbox still follows a reset
 * that wrote the underlying field directly.
 */
function booleanProxy<T>(target: T, key: NumericKeys<T>): { on: boolean } {
  return {
    get on(): boolean {
      return read(target, key) >= 0.5;
    },
    set on(value: boolean) {
      write(target, key, value ? 1 : 0);
    },
  };
}
