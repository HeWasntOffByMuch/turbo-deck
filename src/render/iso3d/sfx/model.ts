/**
 * What the SFX tab is, minus the DOM (spec 229).
 *
 * The outline it draws, what a filter matches, what an edit does to the
 * document, and how much of the game has a sound yet. Pure, and beside
 * `studio/vfx-fields.ts` for the reason that file's header gives: what a row
 * *is*, what an edit *means* and what the document *says* are answerable in
 * Node, and the panel over them is not. It is also the sort of code that looks
 * obviously right and is off by one -- a variant that swaps past its neighbour
 * and corrupts the order, a filter that hides the row somebody is editing.
 *
 * ## Edits return a new catalog
 *
 * Every function here answers with a fresh `SoundCatalog` rather than mutating
 * one. Two reasons. The engine is handed the catalog and holds resolved copies
 * of it, so a mutation would change what is playing without anything having been
 * told; and undo, if it is ever wanted, is then a stack of documents rather than
 * a stack of inverse operations. A catalog is forty small entries -- copying one
 * per keystroke is nothing next to the audio graph it feeds.
 *
 * ## An entry with no variants is deleted, never kept empty
 *
 * `catalog.ts` states it: an entry with no files is the same state as no entry,
 * and two encodings of one state is one of them being wrong. So removing the
 * last variant removes the row, and the tuning that was on it goes with it --
 * which is right, because a volume for a sound that does not exist is a number
 * nobody can hear the effect of.
 */

import {
  isVariantUrl,
  resolveSound,
  SOUND_DEFAULTS,
  type PitchRange,
  type ResolvedSound,
  type SoundCatalog,
  type SoundEntry,
} from '../../audio/catalog.js';
import {
  soundEventSections,
  type BusId,
  type SoundEventDefinition,
  type SoundEventId,
} from '../../audio/events.js';

/** One clip on disk, as `public/audio/manifest.json` lists it. */
export interface ClipEntry {
  readonly url: string;
  readonly seconds: number;
  readonly bytes: number;
  readonly channels: number;
}

/**
 * Read the bake's manifest.
 *
 * Written by `npm run bake:audio` rather than globbed by vite, because these
 * files are in `publicDir` -- copied verbatim, never in the module graph, and so
 * invisible to `import.meta.glob`. Never throws: a missing or broken manifest
 * costs a picker with nothing in it, which is a tab you can still read, against
 * a tab that will not open.
 *
 * A url is admitted by `isVariantUrl` rather than by a `/audio/` prefix test of
 * its own, and the two are not the same: `/audio/../secret.ogg` starts with the
 * prefix and is refused as a variant. A clip the picker offers and the document
 * cannot store is a row somebody assigns, saves, and finds the tab refuses to
 * load back -- so the one predicate that decides what a variant may be decides
 * what the picker may show.
 */
export function parseClips(raw: unknown): readonly ClipEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const clips = (raw as { clips?: unknown }).clips;
  if (!Array.isArray(clips)) return [];
  const out: ClipEntry[] = [];
  for (const clip of clips) {
    if (typeof clip !== 'object' || clip === null) continue;
    const entry = clip as Record<string, unknown>;
    const url = entry['url'];
    if (!isVariantUrl(url)) continue;
    out.push({
      url,
      seconds: typeof entry['seconds'] === 'number' ? entry['seconds'] : 0,
      bytes: typeof entry['bytes'] === 'number' ? entry['bytes'] : 0,
      channels: entry['channels'] === 2 ? 2 : 1,
    });
  }
  return out;
}

/** One row of the tab's outline. */
export interface EventRow {
  readonly event: SoundEventDefinition;
  readonly variants: number;
}

/** One section of it: a bus, a heading, and the rows under it. */
export interface TreeSection {
  readonly bus: BusId;
  readonly section: string;
  readonly rows: readonly EventRow[];
}

/**
 * The outline, filtered.
 *
 * A section with no matching row is dropped entirely rather than drawn empty:
 * the whole point of a filter on a forty-row tree is that what is left fits on
 * screen, and eleven empty headings is the tree again.
 *
 * The query matches the id, the label, the section and the *note* -- the note
 * especially, because "which row is the one that fires when I get hit" is the
 * question somebody has, and the answer is in the sentence rather than in the
 * name. Case-insensitive, substring, no globbing: this is a filter box, not a
 * query language.
 */
export function tree(catalog: SoundCatalog, query = ''): readonly TreeSection[] {
  const needle = query.trim().toLowerCase();
  const out: TreeSection[] = [];
  for (const section of soundEventSections()) {
    const rows: EventRow[] = [];
    for (const event of section.events) {
      if (needle !== '' && !matches(event, section.section, needle)) continue;
      rows.push({ event, variants: catalog.get(event.id)?.variants.length ?? 0 });
    }
    if (rows.length > 0) out.push({ bus: section.bus, section: section.section, rows });
  }
  return out;
}

function matches(event: SoundEventDefinition, section: string, needle: string): boolean {
  return (
    event.id.toLowerCase().includes(needle) ||
    event.label.toLowerCase().includes(needle) ||
    section.toLowerCase().includes(needle) ||
    event.note.toLowerCase().includes(needle)
  );
}

/** How many events have a sound, and how many exist. The tab's header, and the report. */
export interface Coverage {
  readonly assigned: number;
  readonly total: number;
  readonly unassigned: readonly SoundEventId[];
}

export function coverage(catalog: SoundCatalog): Coverage {
  const unassigned: SoundEventId[] = [];
  let total = 0;
  for (const section of soundEventSections()) {
    for (const event of section.events) {
      total += 1;
      if ((catalog.get(event.id)?.variants.length ?? 0) === 0) unassigned.push(event.id);
    }
  }
  return { assigned: total - unassigned.length, total, unassigned };
}

/** Clips in the manifest that no event references. Useful, and the other half of the report. */
export function unusedClips(catalog: SoundCatalog, clips: readonly ClipEntry[]): readonly string[] {
  const used = new Set<string>();
  for (const entry of catalog.values()) for (const url of entry.variants) used.add(url);
  return clips.filter((clip) => !used.has(clip.url)).map((clip) => clip.url);
}

/** A file's own name, for a list that is already grouped by its folder. */
export function clipLabel(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).replace(/\.ogg$/, '');
}

/** The folder a clip sits in, so the picker can group. */
export function clipFolder(url: string): string {
  const cut = url.lastIndexOf('/');
  return cut <= '/audio'.length ? '/' : url.slice('/audio/'.length, cut);
}

/**
 * The entry an event has, with the defaults filled in.
 *
 * What the editing panel shows. An event with no entry still resolves -- to an
 * empty variant list and every default -- so the panel draws the same controls
 * whether or not a file has been assigned yet, and assigning one does not make
 * the layout jump.
 */
export function editing(id: SoundEventId, catalog: SoundCatalog): ResolvedSound {
  return resolveSound(id, catalog.get(id) ?? { variants: [] });
}

function replace(catalog: SoundCatalog, id: SoundEventId, entry: SoundEntry | null): SoundCatalog {
  const next = new Map(catalog);
  // An entry with no files is no entry. See the header.
  if (entry === null || entry.variants.length === 0) next.delete(id);
  else next.set(id, entry);
  return next;
}

function current(catalog: SoundCatalog, id: SoundEventId): SoundEntry {
  return catalog.get(id) ?? { variants: [] };
}

/** Append a file. A duplicate is refused, because two identical variants is one variant. */
export function addVariant(catalog: SoundCatalog, id: SoundEventId, url: string): SoundCatalog {
  const entry = current(catalog, id);
  if (entry.variants.includes(url)) return catalog;
  return replace(catalog, id, { ...entry, variants: [...entry.variants, url] });
}

export function removeVariant(catalog: SoundCatalog, id: SoundEventId, index: number): SoundCatalog {
  const entry = current(catalog, id);
  if (index < 0 || index >= entry.variants.length) return catalog;
  return replace(catalog, id, {
    ...entry,
    variants: entry.variants.filter((_unused, at) => at !== index),
  });
}

/**
 * Move a variant one place.
 *
 * The order is not cosmetic: `VariantPicker` refuses an *immediate* repeat and
 * is otherwise uniform, so re-ordering does not change how often a take is
 * heard -- but it does decide what the list reads as, and a designer grouping
 * three light takes above three heavy ones is stating something. A move off
 * either end is a no-op rather than a wrap, because a wrap is what a mis-click
 * on the top row looks like.
 */
export function moveVariant(catalog: SoundCatalog, id: SoundEventId, index: number, by: number): SoundCatalog {
  const entry = current(catalog, id);
  const to = index + by;
  if (index < 0 || index >= entry.variants.length || to < 0 || to >= entry.variants.length) return catalog;
  const variants = [...entry.variants];
  const moved = variants[index];
  const other = variants[to];
  if (moved === undefined || other === undefined) return catalog;
  variants[index] = other;
  variants[to] = moved;
  return replace(catalog, id, { ...entry, variants });
}

/**
 * Set one tuning field.
 *
 * A field set back to its default is **removed** rather than stored, which is
 * what keeps the document minimal and what keeps `SOUND_DEFAULTS` able to move
 * -- see `catalog.ts`. It also means the diff of a tuning session is the fields
 * that were actually tuned.
 */
export function setVolume(catalog: SoundCatalog, id: SoundEventId, volume: number): SoundCatalog {
  const entry = current(catalog, id);
  return replace(catalog, id, without(entry, 'volume', volume === SOUND_DEFAULTS.volume ? undefined : volume));
}

export function setPitch(catalog: SoundCatalog, id: SoundEventId, pitch: PitchRange): SoundCatalog {
  const entry = current(catalog, id);
  const isDefault = pitch.min === SOUND_DEFAULTS.pitch.min && pitch.max === SOUND_DEFAULTS.pitch.max;
  return replace(catalog, id, without(entry, 'pitch', isDefault ? undefined : pitch));
}

export function setCooldown(catalog: SoundCatalog, id: SoundEventId, ms: number): SoundCatalog {
  const entry = current(catalog, id);
  return replace(catalog, id, without(entry, 'cooldownMs', ms === SOUND_DEFAULTS.cooldownMs ? undefined : ms));
}

/**
 * Turn a row's spatialisation on or off.
 *
 * The falloff numbers are **kept** when it is turned off, which is why the
 * document has a `spatial` boolean beside a `distance` block rather than a
 * nullable one: toggling to compare a sound flat against placed is the first
 * thing anybody does here, and a toggle that discarded the range would make
 * that a one-way trip.
 */
export function setSpatial(
  catalog: SoundCatalog,
  id: SoundEventId,
  spatial: boolean,
  placementDefault: boolean,
): SoundCatalog {
  const entry = current(catalog, id);
  return replace(catalog, id, without(entry, 'spatial', spatial === placementDefault ? undefined : spatial));
}

export function setDistance(
  catalog: SoundCatalog,
  id: SoundEventId,
  key: 'ref' | 'max' | 'rolloff',
  value: number,
): SoundCatalog {
  const entry = current(catalog, id);
  // Rebuilt from the keys that survive rather than copied-then-deleted: under
  // `exactOptionalPropertyTypes` an absent key and a present-`undefined` one are
  // different types, and `catalogToJson` counts keys.
  const held = { ...(entry.distance ?? {}) } as Partial<Record<'ref' | 'max' | 'rolloff', number>>;
  const distance: Partial<Record<'ref' | 'max' | 'rolloff', number>> = {};
  for (const field of ['ref', 'max', 'rolloff'] as const) {
    const next = field === key ? value : held[field];
    if (next !== undefined && next !== SOUND_DEFAULTS.distance[field]) distance[field] = next;
  }
  return replace(catalog, id, without(entry, 'distance', Object.keys(distance).length === 0 ? undefined : distance));
}

/**
 * One field set, or removed where it equals the default.
 *
 * Rebuilt rather than mutated-and-deleted, for the reason above and for the
 * bigger one in the header: an edit must not touch the catalog it was handed.
 */
function without<K extends keyof SoundEntry>(entry: SoundEntry, key: K, value: SoundEntry[K] | undefined): SoundEntry {
  const out: Record<string, unknown> = {};
  for (const [name, held] of Object.entries(entry)) if (name !== key) out[name] = held;
  if (value !== undefined) out[key] = value;
  return out as unknown as SoundEntry;
}
