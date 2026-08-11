/**
 * Bindings across a reload (spec 125).
 *
 * Beside `core/layout-store.ts` and under the same three rules: never throws,
 * takes a `StorageLike` rather than reaching for one, and stores a document with
 * a version on it.
 *
 * The difference is what goes in it. The layout stores every window because a
 * window's position has no default worth preserving; this stores only the
 * bindings a player has *changed*, so that a default which ships later still
 * reaches a profile saved earlier.
 *
 * Pure. No DOM, no clock.
 */

import type { Chord } from './actions.js';
import type { BindingOverride, InputMap } from './input-map.js';
import type { StorageLike } from '../core/layout-store.js';

export const BINDINGS_VERSION = 1;
export const BINDINGS_KEY = 'turbo-deck.ui.bindings';

export interface StoredBindings {
  readonly version: number;
  readonly overrides: readonly BindingOverride[];
}

function readChord(raw: unknown): Chord | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record['code'] !== 'string' || record['code'].length === 0) return null;
  const flag = (name: string): boolean => record[name] === true;
  return {
    code: record['code'],
    ...(flag('shift') ? { shift: true } : {}),
    ...(flag('ctrl') ? { ctrl: true } : {}),
    ...(flag('alt') ? { alt: true } : {}),
    ...(flag('meta') ? { meta: true } : {}),
  };
}

function readOverride(raw: unknown): BindingOverride | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record['actionId'] !== 'string' || record['actionId'].length === 0) return null;
  return {
    actionId: record['actionId'],
    primary: readChord(record['primary']),
    secondary: readChord(record['secondary']),
  };
}

/** Read whatever was stored, or null. Never throws. */
export function migrateBindings(raw: unknown): StoredBindings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) return null;
  // A document from a build that knew more than this one. Defaults are safer than
  // a half-understood restore -- and here the cost of defaults is only that the
  // player rebinds, which is recoverable in a way a wrong binding is not.
  if (version > BINDINGS_VERSION) return null;
  if (!Array.isArray(record['overrides'])) return null;

  const overrides = record['overrides']
    .map((entry) => readOverride(entry))
    .filter((entry): entry is BindingOverride => entry !== null);
  return { version: BINDINGS_VERSION, overrides };
}

export function parseBindings(text: string | null): StoredBindings | null {
  if (text === null) return null;
  try {
    return migrateBindings(JSON.parse(text));
  } catch {
    return null;
  }
}

export function captureBindings(map: InputMap): StoredBindings {
  return { version: BINDINGS_VERSION, overrides: map.toOverrides() };
}

export function saveBindings(storage: StorageLike, map: InputMap, key = BINDINGS_KEY): void {
  storage.setItem(key, JSON.stringify(captureBindings(map)));
}

/**
 * Load into `map`, or leave it at its defaults.
 *
 * Returns whether anything was applied, so a caller can tell "no profile yet"
 * from "a profile that happens to match the defaults" -- which matters only for
 * diagnostics, but costs nothing to answer honestly.
 */
export function loadBindings(storage: StorageLike, map: InputMap, key = BINDINGS_KEY): boolean {
  const stored = parseBindings(storage.getItem(key));
  if (!stored) return false;
  map.applyOverrides(stored.overrides);
  return true;
}
