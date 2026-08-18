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

/** What the Display tab offers, in the order it offers them. */
export const SCALE_CHOICES: readonly ScaleChoice[] = ['auto', 1, 2, 3, 4];

/**
 * 2 adds `showFps` (spec 165). A version 1 document is still read -- it simply
 * has no frame-rate preference in it, which is the same thing as not wanting one.
 * That is the whole reason the version is here rather than the reason to reject.
 */
export const DISPLAY_VERSION = 2;
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
  return { version: DISPLAY_VERSION, scale, showFps };
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

/** The stored preference, or `'auto'` -- which is also what nothing stored means. */
export function loadScale(storage: StorageLike, key = DISPLAY_KEY): ScaleChoice {
  return loadDisplay(storage, key).scale;
}

/** The stored preference, or off. */
export function loadShowFps(storage: StorageLike, key = DISPLAY_KEY): boolean {
  return loadDisplay(storage, key).showFps;
}
