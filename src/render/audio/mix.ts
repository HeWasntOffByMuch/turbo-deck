/**
 * How loud each bus is, and where that survives a reload (spec 229).
 *
 * The mix is a **player** preference, not content -- so it goes where the
 * interface scale and the keybindings go: a versioned document over an injected
 * `StorageLike`, read at mount and written on change, under the three rules
 * `binding-store.ts` states. Never throws, takes its storage rather than
 * reaching for one, and a document it cannot understand costs defaults rather
 * than a black screen -- or here, rather than a game with no sound and no way to
 * find out why.
 *
 * This is the other half of the split the catalog's header describes. **What a
 * sound is** is repo content in `assets/audio/sfx.json`, committed and reviewed
 * as a diff; **how loud it is for you** is in your browser and nobody else's.
 * Putting the mix in the catalog would make turning the music down a change to
 * the repository, and putting the catalog in `localStorage` would mean a sound
 * assignment lived on one machine.
 *
 * Pure. No DOM, no Web Audio, no clock. It lives beside the engine rather than
 * in `src/ui/input/` with its three siblings for one reason: `BusId` is declared
 * in `events.ts` and `src/ui/` may not import the renderer. The options page
 * takes the bus list as an argument instead, exactly as `DisplayScreen` takes
 * the camera's zoom band and for the same stated reason.
 */

import type { StorageLike } from '../../ui/core/layout-store.js';
import { BUSES, type BusId } from './events.js';

export const AUDIO_VERSION = 1;
export const AUDIO_KEY = 'turbo-deck.audio.mix';

/**
 * Every bus's level, plus the master, plus a mute.
 *
 * A mute rather than "set master to 0", because they are different states and
 * conflating them loses the level: unmuting has to put the volume back where it
 * was, and a mute that is a zeroed slider has nowhere to put it back from.
 */
export interface AudioMix {
  readonly version: number;
  /** 0..1, multiplied into every bus. */
  readonly master: number;
  readonly buses: Readonly<Record<BusId, number>>;
  readonly muted: boolean;
}

/**
 * What an unwritten profile means.
 *
 * Master at 0.7 rather than 1.0 deliberately: this is a game whose sound is
 * being built, and the first thing anybody does with audio that opens at full
 * is turn it off. Ambience opens quieter still because a bed is meant to sit
 * underneath everything; UI slightly under the world because interface feedback
 * that competes with a fight is interface feedback in the way.
 */
export const AUDIO_DEFAULTS: AudioMix = {
  version: AUDIO_VERSION,
  master: 0.7,
  buses: { player: 1, combat: 1, elemental: 1, ambience: 0.6, ui: 0.8 },
  muted: false,
};

function level(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Read whatever was stored, or null. Never throws.
 *
 * A bus this build has never heard of is ignored and one it knows about but the
 * document does not gets its default -- the same asymmetry `migrateBindings`
 * applies to an unknown action, and for the same reason: a profile written by a
 * build with a sixth bus should cost you that bus's level, not every level you
 * have ever set.
 */
export function migrateMix(raw: unknown): AudioMix | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) return null;
  // A document from a build that knew more than this one. Defaults are safer
  // than a half-understood restore, and the cost here is four sliders.
  if (version > AUDIO_VERSION) return null;
  const stored = typeof record['buses'] === 'object' && record['buses'] !== null
    ? (record['buses'] as Record<string, unknown>)
    : {};
  const buses = {} as Record<BusId, number>;
  for (const bus of BUSES) buses[bus] = level(stored[bus], AUDIO_DEFAULTS.buses[bus]);
  return {
    version: AUDIO_VERSION,
    master: level(record['master'], AUDIO_DEFAULTS.master),
    buses,
    muted: record['muted'] === true,
  };
}

export function parseMix(text: string | null): AudioMix | null {
  if (text === null) return null;
  try {
    return migrateMix(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The stored mix, or the defaults. Never throws. */
export function loadMix(storage: StorageLike, key = AUDIO_KEY): AudioMix {
  // `getItem` throws as well as `setItem` does, in the same browsers and for the
  // same reasons -- and this one is read at mount, before there is a game to
  // watch it fail, so an unguarded read costs the whole tab rather than the
  // volume somebody set. Same rule, and the same comment, as `loadLayout`.
  try {
    return parseMix(storage.getItem(key)) ?? AUDIO_DEFAULTS;
  } catch {
    return AUDIO_DEFAULTS;
  }
}

/**
 * Write the mix.
 *
 * Cannot throw: it is called from inside a frame, where a browser refusing the
 * write (a full quota, a private window) would otherwise take the render loop
 * rather than one preference. Same rule `saveLayout` states.
 */
export function saveMix(storage: StorageLike, mix: AudioMix, key = AUDIO_KEY): void {
  try {
    storage.setItem(key, JSON.stringify({ ...mix, version: AUDIO_VERSION }));
  } catch {
    // See above.
  }
}

/** The mix with one bus moved. Read-modify-write, so one slider cannot clear another. */
export function withBus(mix: AudioMix, bus: BusId, value: number): AudioMix {
  return { ...mix, buses: { ...mix.buses, [bus]: level(value, mix.buses[bus]) } };
}

export function withMaster(mix: AudioMix, value: number): AudioMix {
  return { ...mix, master: level(value, mix.master) };
}

export function withMuted(mix: AudioMix, muted: boolean): AudioMix {
  return { ...mix, muted };
}

/**
 * The gain a bus is actually set to.
 *
 * The master folds in here rather than being a node of its own in the graph, and
 * that is a real choice with a real reason: a master `GainNode` would be one
 * more node every voice's signal passes through, and the alternative is one
 * multiply on five numbers whenever a slider moves. The graph is
 * `voice -> [panner] -> bus -> destination`, five bus nodes for the whole game.
 *
 * Squared, because a slider is linear in *position* and hearing is not: a linear
 * gain slider does almost nothing over its top half and everything in the last
 * centimetre. `x^2` is the cheap standard approximation and it is applied here
 * rather than in the widget, so the stored number stays the one the player set.
 */
export function busGain(mix: AudioMix, bus: BusId): number {
  if (mix.muted) return 0;
  const value = mix.master * mix.buses[bus];
  return value * value;
}
