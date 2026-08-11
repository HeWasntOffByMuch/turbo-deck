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

/** `'auto'` defers to `autoUiScale`; a number overrides it. */
export type ScaleChoice = 'auto' | 1 | 2 | 3 | 4;

/** What the Display tab offers, in the order it offers them. */
export const SCALE_CHOICES: readonly ScaleChoice[] = ['auto', 1, 2, 3, 4];

export const DISPLAY_VERSION = 1;
export const DISPLAY_KEY = 'turbo-deck.ui.display';

export interface StoredDisplay {
  readonly version: number;
  readonly scale: ScaleChoice;
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
  return { version: DISPLAY_VERSION, scale };
}

export function parseDisplay(text: string | null): StoredDisplay | null {
  if (text === null) return null;
  try {
    return migrateDisplay(JSON.parse(text));
  } catch {
    return null;
  }
}

export function saveScale(storage: StorageLike, scale: ScaleChoice, key = DISPLAY_KEY): void {
  storage.setItem(key, JSON.stringify({ version: DISPLAY_VERSION, scale }));
}

/** The stored preference, or `'auto'` -- which is also what nothing stored means. */
export function loadScale(storage: StorageLike, key = DISPLAY_KEY): ScaleChoice {
  return parseDisplay(storage.getItem(key))?.scale ?? 'auto';
}
