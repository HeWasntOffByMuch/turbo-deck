/**
 * How big the interface is, across a reload (spec 136).
 *
 * Beside `binding-store.ts` and under the same three rules: never throws, takes a
 * `StorageLike` rather than reaching for one, and stores a document with a
 * version on it.
 *
 * The value itself is deliberately small. `'auto'` means "keep doing what
 * `autoUiScale` does", which is what an unwritten profile reads as and what the
 * interface shipped with; a number is an override, and the numbers are whole
 * because a UI pixel is a whole number of device pixels or it is nothing. Four is
 * the ceiling rather than `UI_SCALES`'s eight: past four an ordinary window does
 * not fit on an ordinary screen, and a setting that can make the interface
 * unusable needs a way back that this one does not have.
 *
 * Pure. No DOM, no clock.
 */

import type { StorageLike } from '../core/layout-store.js';

/** See {@link StoredDisplay.showFps}. */
export const DEFAULT_SHOW_FPS = true;

/** `'auto'` defers to `autoUiScale`; a number overrides it. */
export type ScaleChoice = 'auto' | 1 | 2 | 3 | 4;

/**
 * How far out the camera may be zoomed (spec 201).
 *
 * `'supported'` -- the default -- means "whatever this build is sized for", the
 * same shape `'auto'` has above and for the same reason: the number lives in
 * `view-settings.ts` beside the camera, `src/ui/` may not import the renderer,
 * and a copy of it here would be a second place to write down a constant that is
 * going to move. A number is an override, and one past the supported cap is a
 * dev setting the Display page marks as such.
 */
export type MaxZoomChoice = 'supported' | number;

/** What the Display tab offers, in the order it offers them. */
export const SCALE_CHOICES: readonly ScaleChoice[] = ['auto', 1, 2, 3, 4];

/**
 * 2 adds `showFps` (spec 165). A version 1 document is still read -- it simply
 * has no frame-rate preference in it, which is the same thing as not wanting one.
 * That is the whole reason the version is here rather than the reason to reject.
 *
 * 3 adds `maxZoom` (spec 201), and reads a 1 or a 2 the same way: absent means
 * `'supported'`, which is what every profile written before the setting existed
 * meant by saying nothing.
 */
export const DISPLAY_VERSION = 3;
export const DISPLAY_KEY = 'turbo-deck.ui.display';

export interface StoredDisplay {
  readonly version: number;
  readonly scale: ScaleChoice;
  /**
   * Whether the frame-time readout is drawn (spec 165).
   *
   * **On by default.** It went out off, behind a checkbox on the options
   * window's second page, and the first thing anybody asked was where it was.
   * A performance readout you have to find is a performance readout nobody
   * uses -- and this game is still being tuned, so the frame cost of a small
   * canvas in the corner is worth less than the frames it explains. The
   * checkbox is how you turn it *off*.
   */
  readonly showFps: boolean;
  /** See {@link MaxZoomChoice}. */
  readonly maxZoom: MaxZoomChoice;
}

/** What a choice is called in the interface. One place, so the two ends agree. */
export function scaleLabel(choice: ScaleChoice): string {
  return choice === 'auto' ? 'Auto' : `${choice}x`;
}

function readScale(raw: unknown): ScaleChoice | null {
  if (raw === 'auto') return 'auto';
  if (raw === 1 || raw === 2 || raw === 3 || raw === 4) return raw;
  return null;
}

function readMaxZoom(raw: unknown): MaxZoomChoice {
  // Absent, or anything that is not a finite positive number, reads as
  // `'supported'`. A preference nobody expressed is not a reason to throw the
  // rest of the document away, and a nonsense one costs the default rather than
  // a camera that cannot frame anything.
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return 'supported';
}

/** Read whatever was stored, or null. Never throws. */
export function migrateDisplay(raw: unknown): StoredDisplay | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) return null;
  // A document from a build that knew more than this one. Defaults are safer
  // than a half-understood restore, and the cost of defaults here is one click.
  if (version > DISPLAY_VERSION) return null;
  const scale = readScale(record['scale']);
  if (scale === null) return null;
  // Absent, or present as something that is not a boolean, both mean off. A
  // preference nobody has expressed is not a reason to throw the rest of the
  // document away -- the scale in it is still exactly what the player chose.
  // Absent means the default rather than false, so a profile written before
  // this preference existed does not read as "the player turned it off".
  const showFps = record['showFps'] === undefined ? DEFAULT_SHOW_FPS : record['showFps'] === true;
  return { version: DISPLAY_VERSION, scale, showFps, maxZoom: readMaxZoom(record['maxZoom']) };
}

export function parseDisplay(text: string | null): StoredDisplay | null {
  if (text === null) return null;
  try {
    return migrateDisplay(JSON.parse(text));
  } catch {
    return null;
  }
}

/** What an unwritten profile means. One place, so every reader agrees. */
export const DISPLAY_DEFAULTS: StoredDisplay = {
  version: DISPLAY_VERSION,
  scale: 'auto',
  showFps: DEFAULT_SHOW_FPS,
  maxZoom: 'supported',
};

/** The stored document, or the defaults. Never throws. */
export function loadDisplay(storage: StorageLike, key = DISPLAY_KEY): StoredDisplay {
  return parseDisplay(storage.getItem(key)) ?? DISPLAY_DEFAULTS;
}

/**
 * Write one field, keeping the rest.
 *
 * Read-modify-write rather than a whole-document setter, because the two
 * preferences are set from two different rows of the same page: a `saveScale`
 * that wrote `{version, scale}` alone -- which is what it did -- would silently
 * turn the frame-rate readout off every time somebody changed the interface
 * scale.
 */
function patch(storage: StorageLike, change: Partial<StoredDisplay>, key: string): void {
  const next: StoredDisplay = { ...loadDisplay(storage, key), ...change, version: DISPLAY_VERSION };
  storage.setItem(key, JSON.stringify(next));
}

export function saveScale(storage: StorageLike, scale: ScaleChoice, key = DISPLAY_KEY): void {
  patch(storage, { scale }, key);
}

export function saveShowFps(storage: StorageLike, showFps: boolean, key = DISPLAY_KEY): void {
  patch(storage, { showFps }, key);
}

export function saveMaxZoom(storage: StorageLike, maxZoom: MaxZoomChoice, key = DISPLAY_KEY): void {
  patch(storage, { maxZoom }, key);
}

/** The stored preference, or `'supported'` -- which is what nothing stored means. */
export function loadMaxZoom(storage: StorageLike, key = DISPLAY_KEY): MaxZoomChoice {
  return loadDisplay(storage, key).maxZoom;
}

/**
 * The stored preference as an actual number of world units.
 *
 * `supported` is handed in rather than imported, which is the whole point of the
 * `'supported'` sentinel: this module may not reach into `view-settings.ts`, and
 * the caller that can is the one place that knows what this build is sized for.
 */
export function resolveMaxZoom(choice: MaxZoomChoice, supported: number): number {
  return choice === 'supported' ? supported : choice;
}

/** The stored preference, or `'auto'` -- which is also what nothing stored means. */
export function loadScale(storage: StorageLike, key = DISPLAY_KEY): ScaleChoice {
  return loadDisplay(storage, key).scale;
}

/** The stored preference, or off. */
export function loadShowFps(storage: StorageLike, key = DISPLAY_KEY): boolean {
  return loadDisplay(storage, key).showFps;
}
