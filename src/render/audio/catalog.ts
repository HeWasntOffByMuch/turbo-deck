/**
 * What a sound event is made of, as a document (spec 229).
 *
 * The catalog is `assets/audio/sfx.json`: one entry per sound event that has
 * files behind it, holding the variants and whatever a person tuned by ear.
 * The SFX tab reads it, writes it back through `POST /api/sfx` in development,
 * and it is committed -- so a mix change reviews as a diff, the same way
 * `maps/arena.json` makes the world review as one.
 *
 * Pure. No DOM, no Web Audio, no clock. Everything here is parsing, defaulting
 * and arithmetic, which is what makes it assertable in `npm test` where the
 * engine that consumes it cannot be.
 *
 * ## The format is minimal on purpose
 *
 * An entry stores `variants` and **only the fields that differ from the
 * defaults**. Two reasons, and the second is the one that matters: a file where
 * every entry restates `"rolloff": 1` is a file nobody reads, and -- more
 * importantly -- a default that is written into forty entries is a default that
 * can never be changed again. `SOUND_DEFAULTS` moving should move the game.
 *
 * An event with **no entry at all** is silent, and that is the honest encoding
 * of "nobody has assigned a file to this yet". It is not an error, it is not a
 * warning, and it is deliberately not a placeholder beep: an unassigned event is
 * the normal state of a game being built.
 *
 * ## What round-trips
 *
 * `parseCatalog(catalogToJson(c))` is `c`, asserted over the shipped document.
 * That is the property `vfx-json.ts` states for effects and for the same reason:
 * a tool you tune in and whose output is not what you tuned is a tool that lies
 * to you once and is never trusted again.
 */

import {
  isSoundEventId,
  soundEvent,
  SOUND_EVENT_IDS as SOUND_EVENT_ORDER,
  type SoundEventId,
} from './events.js';

/** How far a world sound carries. World units -- see `SOUND_DEFAULTS`. */
export interface DistanceFalloff {
  /** Full volume within this. */
  readonly ref: number;
  /** Past this it is not started at all. See {@link SOUND_DEFAULTS}. */
  readonly max: number;
  /** How fast it falls between them. 1 is the inverse-square-ish default; 0 is flat. */
  readonly rolloff: number;
}

/** The playback-rate spread a variant is drawn from. */
export interface PitchRange {
  readonly min: number;
  readonly max: number;
}

/**
 * One event's entry, exactly as the document stores it.
 *
 * Everything but `variants` is optional and means "the default". `variants` is
 * required and may not be empty, because an entry with no files is the same
 * thing as no entry and two encodings of one state is one of them being wrong.
 */
export interface SoundEntry {
  /** URLs under `/audio/`, in the order the tab shows them. */
  readonly variants: readonly string[];
  readonly volume?: number;
  readonly pitch?: PitchRange;
  /** Overrides the event's declared placement. */
  readonly spatial?: boolean;
  readonly distance?: Partial<DistanceFalloff>;
  /** See {@link SOUND_DEFAULTS.cooldownMs}. */
  readonly cooldownMs?: number;
}

/** An entry with every default filled in. What the engine is handed. */
export interface ResolvedSound {
  readonly id: SoundEventId;
  readonly variants: readonly string[];
  readonly volume: number;
  readonly pitch: PitchRange;
  readonly spatial: boolean;
  readonly distance: DistanceFalloff;
  readonly cooldownMs: number;
  readonly loop: boolean;
}

/**
 * What an unstated field means.
 *
 * The distances are in world units, and the world is big: a body's radius is 10,
 * melee reach is 70-90, a bow reaches 420 and a map chunk is 616 across. So
 * `ref: 140` is "anything in the fight you are in is at full volume", and
 * `max: 2200` is about three and a half chunks -- past which the sound is not
 * started at all rather than started quietly.
 *
 * **`max` is a cull, not a fade to nothing**, and that distinction is the one
 * thing here worth knowing. The Web Audio `inverse` distance model clamps the
 * distance into `[ref, max]` and never reaches zero, so a sound at the far edge
 * plays forever at a small but non-zero gain -- and forty of them is a wash of
 * noise from things nobody can see. Culling at the start is what makes the range
 * mean what a designer thinks it means, and it costs nothing at all: it is a
 * decision taken once when the voice would have been allocated. A sound already
 * playing is never cut, so there is no boundary artefact to hear.
 *
 * The pitch spread is **deliberately narrow**. +/-3% is about half a semitone --
 * enough that six footsteps in a row are not six copies of one recording, and
 * short of the point where a sword sounds like a cartoon. The shipped catalog
 * widens it on the few rows where repetition is highest and says so there.
 *
 * `cooldownMs` is the smallest interesting number in the file. One tick of
 * Whirlwind lands on every body in the arc, and a Poison beat lands on every
 * body carrying one -- so an event can genuinely fire eight times in the same
 * frame, and eight copies of one recording starting on the same sample is not
 * eight sounds, it is one sound three times as loud with a comb filter on it.
 * 40ms is under the threshold at which two transients read as two events, so
 * what it suppresses is inaudible and what it prevents is not.
 */
export const SOUND_DEFAULTS = {
  volume: 1,
  pitch: { min: 0.97, max: 1.03 } as PitchRange,
  distance: { ref: 140, max: 2200, rolloff: 1 } as DistanceFalloff,
  cooldownMs: 40,
} as const;

/** The bounds the SFX tab's controls span, and what a parsed document is clamped into. */
export const SOUND_LIMITS = {
  volume: { min: 0, max: 2 },
  /** An octave either way. Past that it is a different sound, not a variation. */
  pitch: { min: 0.5, max: 2 },
  ref: { min: 10, max: 2000 },
  max: { min: 50, max: 12000 },
  rolloff: { min: 0, max: 4 },
  cooldownMs: { min: 0, max: 2000 },
} as const;

export type SoundCatalog = ReadonlyMap<SoundEventId, SoundEntry>;

export const CATALOG_VERSION = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * An entry with the defaults applied, clamped into the limits.
 *
 * `loop` comes from the **event** rather than the entry: whether a sound is held
 * or fired is decided by the call site that holds the handle, so an entry that
 * could turn a one-shot into a loop would be a document able to leave a sound
 * running with nothing owning it.
 */
export function resolveSound(id: SoundEventId, entry: SoundEntry): ResolvedSound {
  const event = soundEvent(id);
  const pitch = entry.pitch ?? SOUND_DEFAULTS.pitch;
  const distance = entry.distance ?? {};
  const lo = clamp(pitch.min, SOUND_LIMITS.pitch.min, SOUND_LIMITS.pitch.max);
  const hi = clamp(pitch.max, SOUND_LIMITS.pitch.min, SOUND_LIMITS.pitch.max);
  const ref = clamp(distance.ref ?? SOUND_DEFAULTS.distance.ref, SOUND_LIMITS.ref.min, SOUND_LIMITS.ref.max);
  return {
    id,
    variants: entry.variants,
    volume: clamp(entry.volume ?? SOUND_DEFAULTS.volume, SOUND_LIMITS.volume.min, SOUND_LIMITS.volume.max),
    // Swapped rather than refused if they are the wrong way round: a range is
    // a pair of bounds, and a document with them crossed is a typo rather than
    // a reason to drop the whole file.
    pitch: { min: Math.min(lo, hi), max: Math.max(lo, hi) },
    spatial: entry.spatial ?? event?.placement === 'world',
    distance: {
      ref,
      // Never inside `ref`: the model clamps into the interval, and an inverted
      // one silences the sound entirely rather than making it loud.
      max: Math.max(ref + 1, clamp(distance.max ?? SOUND_DEFAULTS.distance.max, SOUND_LIMITS.max.min, SOUND_LIMITS.max.max)),
      rolloff: clamp(distance.rolloff ?? SOUND_DEFAULTS.distance.rolloff, SOUND_LIMITS.rolloff.min, SOUND_LIMITS.rolloff.max),
    },
    cooldownMs: clamp(
      entry.cooldownMs ?? SOUND_DEFAULTS.cooldownMs,
      SOUND_LIMITS.cooldownMs.min,
      SOUND_LIMITS.cooldownMs.max,
    ),
    loop: event?.loop === true,
  };
}

export type CatalogParse = { readonly catalog: SoundCatalog } | { readonly error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown, where: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${where} must be a finite number`);
    return undefined;
  }
  return value;
}

function readPitch(value: unknown, where: string, errors: string[]): PitchRange | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${where} must be an object with min and max`);
    return undefined;
  }
  // Both bounds or neither. `readNumber` answers `undefined` for an absent field
  // without complaining -- which is right for `volume`, where absent means the
  // default, and wrong here: a range is a pair, so `{ "min": 0.5 }` is a typo,
  // and honouring it as "the default spread" is exactly the silent answer this
  // parser exists not to give.
  if (value['min'] === undefined || value['max'] === undefined) {
    errors.push(`${where} must be an object with min and max`);
    return undefined;
  }
  const min = readNumber(value['min'], `${where}.min`, errors);
  const max = readNumber(value['max'], `${where}.max`, errors);
  if (min === undefined || max === undefined) return undefined;
  return { min, max };
}

function readDistance(value: unknown, where: string, errors: string[]): Partial<DistanceFalloff> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${where} must be an object`);
    return undefined;
  }
  // Absent keys stay absent rather than becoming an explicit `undefined`. Under
  // `exactOptionalPropertyTypes` those are different types, and downstream they
  // are different facts: `{}` means "use the defaults" and `{ ref: undefined }`
  // means somebody wrote a field and got it wrong.
  const kept: Record<string, number> = {};
  for (const key of ['ref', 'max', 'rolloff'] as const) {
    const parsed = readNumber(value[key], `${where}.${key}`, errors);
    if (parsed !== undefined) kept[key] = parsed;
  }
  return kept;
}

/**
 * A URL a variant may name.
 *
 * Under `/audio/` and nothing else. This is not a security boundary -- the
 * catalog is repo content and a browser fetching it is fetching our own site --
 * it is a **typo** boundary: a path that is not under `/audio/` is a path the
 * bake did not write, and finding that out at parse time beats finding it out
 * as a sound that never plays. No `..`, for the same reason `resolveMapWrite`
 * refuses one: it can only ever mean the writer got confused.
 */
export function isVariantUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/audio/') &&
    !value.includes('..') &&
    !value.includes('\0') &&
    value.length > '/audio/'.length
  );
}

/**
 * Read a catalog document.
 *
 * Shallow-but-total, the discipline `vfx-json.ts` states: every field is checked
 * for its *kind* and the whole document is refused otherwise. What it must never
 * do is return a partial catalog, because half a mix looks exactly like a mix.
 *
 * An id this build has never heard of is the one thing that is skipped rather
 * than refused, and that asymmetry is deliberate: it is what lets a catalog
 * written by a newer build still work here, minus the rows for events that do
 * not exist yet. The same choice `migrateBindings` makes about an unknown action.
 */
export function parseCatalog(text: string): CatalogParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObject(raw)) return { error: 'the document must be an object' };
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isFinite(version)) return { error: 'missing version' };
  if (version > CATALOG_VERSION) return { error: `version ${String(version)} is newer than this build reads` };
  const sounds = raw['sounds'];
  if (!isObject(sounds)) return { error: 'missing sounds' };

  const errors: string[] = [];
  const catalog = new Map<SoundEventId, SoundEntry>();
  for (const [id, value] of Object.entries(sounds)) {
    if (!isSoundEventId(id)) continue;
    if (!isObject(value)) {
      errors.push(`${id} must be an object`);
      continue;
    }
    const variants = value['variants'];
    if (!Array.isArray(variants) || !variants.every(isVariantUrl)) {
      errors.push(`${id}.variants must be a list of /audio/... paths`);
      continue;
    }
    // An entry with no files is the same state as no entry. Dropped rather than
    // refused, so hitting "remove last variant" in the tab and saving produces a
    // document that loads.
    if (variants.length === 0) continue;
    // Built by accretion rather than as one literal, for the reason above: an
    // optional field that is present-and-undefined is a different type from an
    // absent one, and `catalogToJson` would write the first back out.
    const entry: { -readonly [K in keyof SoundEntry]: SoundEntry[K] } = { variants };
    const volume = readNumber(value['volume'], `${id}.volume`, errors);
    if (volume !== undefined) entry.volume = volume;
    const pitch = readPitch(value['pitch'], `${id}.pitch`, errors);
    if (pitch !== undefined) entry.pitch = pitch;
    if (value['spatial'] !== undefined) entry.spatial = value['spatial'] === true;
    const distance = readDistance(value['distance'], `${id}.distance`, errors);
    if (distance !== undefined && Object.keys(distance).length > 0) entry.distance = distance;
    const cooldownMs = readNumber(value['cooldownMs'], `${id}.cooldownMs`, errors);
    if (cooldownMs !== undefined) entry.cooldownMs = cooldownMs;
    catalog.set(id, entry);
  }
  if (errors.length > 0) return { error: errors.slice(0, 6).join('; ') };
  return { catalog };
}

/**
 * Write a catalog document.
 *
 * Keys in the vocabulary's own order rather than insertion order, so two people
 * editing different rows produce diffs that do not reorder the file underneath
 * each other. Only fields that differ from the defaults are written -- see the
 * header.
 */
export function catalogToJson(catalog: SoundCatalog): string {
  const sounds: Record<string, unknown> = {};
  for (const id of orderedIds(catalog)) {
    const entry = catalog.get(id);
    if (!entry || entry.variants.length === 0) continue;
    const out: Record<string, unknown> = { variants: [...entry.variants] };
    if (entry.volume !== undefined && entry.volume !== SOUND_DEFAULTS.volume) out['volume'] = entry.volume;
    if (
      entry.pitch !== undefined &&
      (entry.pitch.min !== SOUND_DEFAULTS.pitch.min || entry.pitch.max !== SOUND_DEFAULTS.pitch.max)
    ) {
      out['pitch'] = { min: entry.pitch.min, max: entry.pitch.max };
    }
    if (entry.spatial !== undefined && entry.spatial !== (soundEvent(id)?.placement === 'world')) {
      out['spatial'] = entry.spatial;
    }
    const distance: Record<string, number> = {};
    for (const key of ['ref', 'max', 'rolloff'] as const) {
      const value = entry.distance?.[key];
      if (value !== undefined && value !== SOUND_DEFAULTS.distance[key]) distance[key] = value;
    }
    if (Object.keys(distance).length > 0) out['distance'] = distance;
    if (entry.cooldownMs !== undefined && entry.cooldownMs !== SOUND_DEFAULTS.cooldownMs) {
      out['cooldownMs'] = entry.cooldownMs;
    }
    sounds[id] = out;
  }
  return `${JSON.stringify({ version: CATALOG_VERSION, sounds }, null, 2)}\n`;
}

/** Ids present in the catalog, in the vocabulary's order. */
function orderedIds(catalog: SoundCatalog): readonly SoundEventId[] {
  const held = new Set(catalog.keys());
  const out: SoundEventId[] = [];
  for (const id of SOUND_EVENT_ORDER) if (held.has(id)) out.push(id);
  return out;
}

/** Which events nobody has assigned a file to. The gap report, and the tab's header. */
export function unassignedEvents(catalog: SoundCatalog): readonly SoundEventId[] {
  return SOUND_EVENT_ORDER.filter((id) => (catalog.get(id)?.variants.length ?? 0) === 0);
}

/** Every distinct file the catalog references. For the "is anything unused" half of the report. */
export function referencedVariants(catalog: SoundCatalog): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of catalog.values()) for (const url of entry.variants) out.add(url);
  return out;
}

/** An empty catalog: every event silent. What a missing document means. */
export const EMPTY_CATALOG: SoundCatalog = new Map<SoundEventId, SoundEntry>();
