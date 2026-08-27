/**
 * What the SFX tab reads back is what it wrote (spec 229).
 *
 * `assets/audio/sfx.json` is a committed document somebody tunes by ear, so the
 * one thing it may not do is come back different from what went in. The round
 * trip is asserted against the **shipped** document rather than a fixture,
 * because a fixture round-trips whatever shape the code happens to produce and
 * says nothing at all about the file in the repo.
 *
 * Three failures live here and nowhere else in the tree. A **typo'd event id**,
 * which `parseCatalog` deliberately skips rather than refuses -- so a mis-spelled
 * row is a sound that never plays, with no error anywhere to say so. A
 * **variant naming a file that is not on disk**, which is a 404 in a browser and
 * which no amount of parsing can catch, since the parser has no disk. And a
 * **document that is not already in the shape the writer produces** -- a default
 * restated, or a row out of the vocabulary's order -- which reads as harmless
 * right up until the first save, when it becomes a diff nobody asked for
 * attached to whatever change somebody was actually making. Both were true of
 * the shipped file when this test was written.
 *
 * The rest is the parser's contract. A refusal is **total**, because half a mix
 * looks exactly like a mix. The one skip is the one documented asymmetry, and it
 * is pinned in both directions so it cannot quietly widen to cover a row that is
 * merely broken. And `resolveSound` clamps rather than trusting -- including
 * `loop`, which is a fact about the event and which no entry may set, or a
 * document could leave a held sound running with nothing owning it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  EMPTY_CATALOG,
  SOUND_DEFAULTS,
  SOUND_LIMITS,
  catalogToJson,
  isVariantUrl,
  parseCatalog,
  referencedVariants,
  resolveSound,
  unassignedEvents,
  type SoundCatalog,
  type SoundEntry,
} from './catalog.js';
import { SOUND_EVENT_IDS, isSoundEventId, soundEvent, type SoundEventId } from './events.js';

/** A file that really exists, so a test about parsing is never also a test about assets. */
const A_FILE = '/audio/ui/denied.ogg';

const shippedText = readFileSync(new URL('../../../assets/audio/sfx.json', import.meta.url), 'utf8');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `Record` view of untyped JSON, so a document can be walked key by key without `any`. */
function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} is not an object`);
  return value;
}

/** The catalog a document parses to, or a failure naming why it did not. */
function parsed(text: string): SoundCatalog {
  const result = parseCatalog(text);
  if ('error' in result) throw new Error(`expected a catalog, got: ${result.error}`);
  return result.catalog;
}

/**
 * The message a bad document is refused with.
 *
 * The `catalog` check is not ceremony: it is the totality rule, asserted on
 * every refusal in the file at once. A parser that returned the rows it managed
 * alongside an error would hand the engine half a mix, which sounds like a mix.
 */
function refusal(text: string): string {
  const result = parseCatalog(text);
  expect('catalog' in result, text.slice(0, 72)).toBe(false);
  if (!('error' in result)) throw new Error('expected a refusal');
  return result.error;
}

/** A one-entry catalog, for asking what the writer does with one field. */
function one(id: SoundEventId, entry: SoundEntry): SoundCatalog {
  return new Map([[id, entry]]);
}

/** The `sounds` block `catalogToJson` produces, read back as untyped JSON. */
function written(catalog: SoundCatalog): Record<string, unknown> {
  const document: unknown = JSON.parse(catalogToJson(catalog));
  return record(record(document, 'the written document')['sounds'], 'the written sounds');
}

/** A whole document around one row, for the refusal cases. */
function documentAround(row: string, id = 'ui.error'): string {
  return `{"version":1,"sounds":{"${id}":${row}}}`;
}

const shipped = parsed(shippedText);
const shippedRaw: unknown = JSON.parse(shippedText);
const shippedSounds = record(record(shippedRaw, 'the shipped document')['sounds'], 'the shipped sounds');

describe('the shipped catalog', () => {
  it('parses with no error at all', () => {
    const result = parseCatalog(shippedText);
    expect('error' in result ? result.error : null).toBeNull();
  });

  it('comes back as itself: parse(write(c)) is c', () => {
    // The property the header claims, over the document the game actually
    // loads. A tool whose save is not what you tuned lies to you once and is
    // never trusted again.
    const again = parsed(catalogToJson(shipped));
    for (const [id, entry] of shipped) expect(again.get(id), id).toEqual(entry);
    // ...and the writer neither invented a row nor moved one, which the loop
    // above cannot see: a `Map`'s key order is the row order, and the row order
    // is the diff.
    expect([...again.keys()]).toEqual([...shipped.keys()]);
  });

  it('already holds its rows in the vocabulary’s order, so the first save is not a reordering', () => {
    // `catalogToJson` writes rows in the order `events.ts` declares them, which
    // is what stops two people editing two rows from shuffling the file
    // underneath each other. A committed document in some *other* order gets
    // that shuffle exactly once -- on the first save, as a diff nobody asked
    // for, attached to whatever change they were actually making.
    const ids = Object.keys(shippedSounds);
    expect(ids).toEqual(SOUND_EVENT_IDS.filter((id) => ids.includes(id)));
  });

  it('names only events this build knows, which the parser would otherwise drop in silence', () => {
    // The reason this check has to exist at all is the asymmetry pinned below:
    // an id `parseCatalog` has never heard of is skipped without an error, so a
    // typo in the committed file is a sound that never plays and never
    // complains. Every id surviving to the catalog means none was skipped.
    const ids = Object.keys(shippedSounds);
    expect(ids.length).toBe(shipped.size);
    for (const id of ids) expect(isSoundEventId(id), id).toBe(true);
  });

  it('points every variant at a file that is actually on disk', () => {
    // The check nothing else in the tree can make: a missing file is a 404 in a
    // browser and a sound that silently never plays, and the parser has no disk
    // to look on.
    const urls = [...referencedVariants(shipped)].sort();
    expect(urls.length).toBeGreaterThan(0);
    const missing = urls.filter((url) => !existsSync(new URL(`../../../public${url}`, import.meta.url)));
    expect(missing).toEqual([]);
  });

  it('restates no default, which is what keeps the round trip exact', () => {
    // `catalogToJson` drops a field equal to the default, so a document that
    // writes one comes back a field short. `"volume": 1` on `combat.stagger`
    // was exactly that: harmless to the mix, and a spurious diff the first time
    // anybody opened the tab and pressed save. Comparing key sets per row names
    // the offending id rather than reporting "the round trip failed".
    const rewritten = written(shipped);
    for (const [id, value] of Object.entries(shippedSounds)) {
      expect(Object.keys(record(rewritten[id], `the written ${id}`)).sort(), id).toEqual(
        Object.keys(record(value, id)).sort(),
      );
    }
  });

  it('resolves every row into something the engine can use', () => {
    for (const [id, entry] of shipped) {
      const sound = resolveSound(id, entry);
      expect(sound.variants.length, id).toBeGreaterThan(0);
      expect(sound.pitch.min, id).toBeLessThanOrEqual(sound.pitch.max);
      expect(sound.distance.max, id).toBeGreaterThan(sound.distance.ref);
    }
  });
});

describe('what catalogToJson writes', () => {
  /** An entry that states every field and states each one at its default. */
  const allDefaults: SoundEntry = {
    variants: [A_FILE],
    volume: SOUND_DEFAULTS.volume,
    pitch: { ...SOUND_DEFAULTS.pitch },
    distance: { ...SOUND_DEFAULTS.distance },
    cooldownMs: SOUND_DEFAULTS.cooldownMs,
  };

  it('writes nothing but the files when every field is the default', () => {
    // A file where forty entries restate `"rolloff": 1` is a file nobody reads,
    // and -- the half that matters -- a default written into forty entries is a
    // default that can never be moved again.
    expect(written(one('ui.error', allDefaults))).toEqual({ 'ui.error': { variants: [A_FILE] } });
  });

  it('writes a field the moment it differs, and only that field', () => {
    const cases: readonly (readonly [string, SoundEntry])[] = [
      ['volume', { ...allDefaults, volume: 0.5 }],
      ['pitch', { ...allDefaults, pitch: { min: 0.9, max: 1.1 } }],
      ['cooldownMs', { ...allDefaults, cooldownMs: 120 }],
      ['distance', { ...allDefaults, distance: { ...SOUND_DEFAULTS.distance, ref: 70 } }],
    ];
    for (const [key, entry] of cases) {
      const keys = Object.keys(record(written(one('ui.error', entry))['ui.error'], key));
      expect(keys.sort(), key).toEqual(['variants', key].sort());
    }
  });

  it('writes only the distance bounds that moved, not the whole block', () => {
    const entry: SoundEntry = { variants: [A_FILE], distance: { ...SOUND_DEFAULTS.distance, ref: 70 } };
    expect(written(one('ui.error', entry))['ui.error']).toEqual({ variants: [A_FILE], distance: { ref: 70 } });
  });

  it('measures spatial against the event’s own placement rather than a constant', () => {
    // `player.footstep` is a world sound and `ui.error` is flat, so one and the
    // same `spatial: true` is the default on the first and an override on the
    // second. A writer comparing against a fixed `true` would restate the key on
    // every world row in the file and drop the one override that means anything.
    expect(written(one('player.footstep', { variants: [A_FILE], spatial: true }))['player.footstep']).toEqual({
      variants: [A_FILE],
    });
    expect(written(one('ui.error', { variants: [A_FILE], spatial: true }))['ui.error']).toEqual({
      variants: [A_FILE],
      spatial: true,
    });
    expect(written(one('player.footstep', { variants: [A_FILE], spatial: false }))['player.footstep']).toEqual({
      variants: [A_FILE],
      spatial: false,
    });
  });

  it('orders rows by the vocabulary rather than by insertion', () => {
    // Two people editing two different rows must not reorder the file underneath
    // each other: a diff that moves forty lines to change one is a diff nobody
    // reads.
    const ids: readonly SoundEventId[] = [
      'ui.tradeComplete',
      'ambience.world',
      'combat.hit.flesh',
      'player.footstep',
    ];
    const entry: SoundEntry = { variants: [A_FILE] };
    const catalog: SoundCatalog = new Map(ids.map((id): [SoundEventId, SoundEntry] => [id, entry]));
    const expected = SOUND_EVENT_IDS.filter((id) => ids.includes(id));

    expect(Object.keys(written(catalog))).toEqual(expected);
    // The insertion order really was a different order, or the assertion above
    // passes for a writer that does nothing at all.
    expect([...catalog.keys()]).not.toEqual(expected);
  });

  it('drops an entry with no files rather than writing an empty row', () => {
    expect(written(one('ui.error', { variants: [] }))).toEqual({});
  });
});

describe('what parseCatalog refuses', () => {
  it('refuses text that is not JSON', () => {
    expect(refusal('{ not json')).toContain('not JSON');
    expect(refusal('')).toContain('not JSON');
  });

  it('refuses a document that is not an object', () => {
    for (const text of ['null', '[]', '7', '"sounds"']) {
      expect(refusal(text), text).toContain('must be an object');
    }
  });

  it('refuses a document with no usable version', () => {
    expect(refusal('{"sounds":{}}')).toContain('missing version');
    expect(refusal('{"version":"1","sounds":{}}')).toContain('missing version');
    // `1e999` is JSON every parser accepts and JavaScript turns into Infinity --
    // the one non-finite number a document can actually carry, and so the only
    // way `Number.isFinite` here is reachable at all.
    expect(refusal('{"version":1e999,"sounds":{}}')).toContain('missing version');
  });

  it('refuses a document from a build that knew more than this one, and reads its own', () => {
    expect(refusal(`{"version":${CATALOG_VERSION + 1},"sounds":{}}`)).toContain('newer');
    expect(parsed(`{"version":${CATALOG_VERSION},"sounds":{}}`).size).toBe(0);
    expect(parsed('{"version":0,"sounds":{}}').size).toBe(0);
  });

  it('refuses a document with no sounds block', () => {
    expect(refusal('{"version":1}')).toContain('missing sounds');
    // An array is an object to `typeof` and is not a map of rows.
    expect(refusal('{"version":1,"sounds":[]}')).toContain('missing sounds');
  });

  it('refuses an entry that is not an object', () => {
    expect(refusal(documentAround('["/audio/a.ogg"]'))).toContain('ui.error');
    expect(refusal(documentAround('"/audio/a.ogg"'))).toContain('ui.error');
  });

  it('refuses a variants list that is not a list of /audio/ paths', () => {
    const bad = [
      '"/audio/a.ogg"', // the string rather than a list of one
      '{}',
      '[7]',
      '[null]',
      '["a.ogg"]',
      '["/other/a.ogg"]',
      '["/audio/"]', // the prefix and nothing after it
      '["/audio/../secrets.ogg"]',
      '["/audio/ok.ogg", "/nope.ogg"]', // one bad entry takes the list
    ];
    for (const variants of bad) {
      expect(refusal(documentAround(`{"variants":${variants}}`)), variants).toContain('ui.error.variants');
    }
  });

  it('refuses a field that is not a finite number', () => {
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"volume":"loud"}`))).toContain('ui.error.volume');
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"cooldownMs":1e999}`))).toContain('ui.error.cooldownMs');
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"distance":{"ref":"near"}}`))).toContain(
      'ui.error.distance.ref',
    );
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"distance":5}`))).toContain('ui.error.distance');
  });

  it('refuses a pitch with one bound and not the other', () => {
    // A range is a pair. An absent field elsewhere means "the default", so the
    // obvious reading of a half-written pitch is the default spread -- which is
    // a typo answered silently, and the whole reason the parser is total.
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"pitch":{"min":0.5}}`))).toContain('ui.error.pitch');
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"pitch":{"max":1.5}}`))).toContain('ui.error.pitch');
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"pitch":{}}`))).toContain('ui.error.pitch');
    expect(refusal(documentAround(`{"variants":["${A_FILE}"],"pitch":7}`))).toContain('ui.error.pitch');
    // A complete one is fine, or the rule above is refusing every pitch there is.
    expect(parsed(documentAround(`{"variants":["${A_FILE}"],"pitch":{"min":0.5,"max":1.5}}`)).get('ui.error')?.pitch)
      .toEqual({ min: 0.5, max: 1.5 });
  });

  it('reads a spatial that is not a boolean as false rather than losing the file', () => {
    // The one lenient coercion in the parser, and it is stated here so it is a
    // decision rather than an oversight: a *present* junk value settles the
    // field, an absent one still means the event's own placement.
    const entry = parsed(documentAround(`{"variants":["${A_FILE}"],"spatial":"yes"}`)).get('ui.error');
    expect(entry?.spatial).toBe(false);
    expect(parsed(documentAround(`{"variants":["${A_FILE}"]}`)).get('ui.error')?.spatial).toBeUndefined();
  });
});

describe('the one thing parseCatalog skips rather than refuses', () => {
  // `combat.parry` is a deliberate choice of name: `events.ts` says there is no
  // such row "because nothing parries", so it is an id this build genuinely does
  // not know and never will by accident.
  const unknownRow = `"combat.parry":{"variants":["${A_FILE}"]}`;

  it('drops an event id this build has never heard of, and keeps the rest', () => {
    // What lets a catalog written by a newer build still work here, minus the
    // rows for events that do not exist yet -- the same choice `migrateBindings`
    // makes about an unknown action. The cost is that a typo is silent, which is
    // why the shipped document's ids are checked above.
    const catalog = parsed(`{"version":1,"sounds":{"ui.error":{"variants":["${A_FILE}"]},${unknownRow}}}`);
    expect([...catalog.keys()]).toEqual(['ui.error']);
  });

  it('is not an error even when the unknown row is the only row', () => {
    expect(parsed(`{"version":1,"sounds":{${unknownRow}}}`).size).toBe(0);
  });

  it('does not skip a known row that is merely broken', () => {
    // The asymmetry is about ids and about nothing else. A known id with a bad
    // field takes the whole document down rather than quietly going missing,
    // because a row silently absent from a mix is the failure this file opens by
    // naming.
    expect(refusal(documentAround('{"variants":["nope"]}'))).toContain('ui.error');
  });
});

describe('an entry with no files', () => {
  it('is dropped rather than kept, because no entry is already that state', () => {
    // Dropped rather than refused: pressing "remove last variant" in the tab and
    // saving has to produce a document that loads.
    const catalog = parsed(
      `{"version":1,"sounds":{"ui.error":{"variants":[]},"ui.press":{"variants":["${A_FILE}"]}}}`,
    );
    expect(catalog.has('ui.error')).toBe(false);
    expect(catalog.has('ui.press')).toBe(true);
  });

  it('is counted as unassigned, which is the state it was encoding', () => {
    expect(unassignedEvents(parsed('{"version":1,"sounds":{"ui.error":{"variants":[]}}}'))).toContain('ui.error');
  });
});

describe('resolveSound', () => {
  it('fills in every default for an entry that says nothing', () => {
    expect(resolveSound('player.footstep', { variants: [A_FILE] })).toEqual({
      id: 'player.footstep',
      variants: [A_FILE],
      volume: SOUND_DEFAULTS.volume,
      pitch: SOUND_DEFAULTS.pitch,
      spatial: true,
      distance: SOUND_DEFAULTS.distance,
      cooldownMs: SOUND_DEFAULTS.cooldownMs,
      loop: false,
    });
  });

  it('swaps a crossed pitch range rather than refusing it', () => {
    // A range is a pair of bounds, and a document with them the wrong way round
    // is a typo -- not a reason to lose the whole file.
    expect(resolveSound('ui.error', { variants: [A_FILE], pitch: { min: 1.4, max: 0.8 } }).pitch).toEqual({
      min: 0.8,
      max: 1.4,
    });
  });

  it('swaps after clamping, so a crossed range that is also out of bounds is still a range', () => {
    expect(resolveSound('ui.error', { variants: [A_FILE], pitch: { min: 99, max: 0.01 } }).pitch).toEqual({
      min: SOUND_LIMITS.pitch.min,
      max: SOUND_LIMITS.pitch.max,
    });
  });

  it('clamps every field into SOUND_LIMITS, whatever the document says', () => {
    const wild = [-1e9, -1, 0, 0.001, 0.5, 1, 3, 12345, 1e9];
    for (const a of wild) {
      for (const b of wild) {
        const where = `${a} / ${b}`;
        const sound = resolveSound('player.footstep', {
          variants: [A_FILE],
          volume: a,
          pitch: { min: a, max: b },
          distance: { ref: a, max: b, rolloff: b },
          cooldownMs: a,
        });
        expect(sound.volume, where).toBeGreaterThanOrEqual(SOUND_LIMITS.volume.min);
        expect(sound.volume, where).toBeLessThanOrEqual(SOUND_LIMITS.volume.max);
        expect(sound.pitch.min, where).toBeGreaterThanOrEqual(SOUND_LIMITS.pitch.min);
        expect(sound.pitch.max, where).toBeLessThanOrEqual(SOUND_LIMITS.pitch.max);
        expect(sound.pitch.min, where).toBeLessThanOrEqual(sound.pitch.max);
        expect(sound.distance.ref, where).toBeGreaterThanOrEqual(SOUND_LIMITS.ref.min);
        expect(sound.distance.ref, where).toBeLessThanOrEqual(SOUND_LIMITS.ref.max);
        expect(sound.distance.rolloff, where).toBeGreaterThanOrEqual(SOUND_LIMITS.rolloff.min);
        expect(sound.distance.rolloff, where).toBeLessThanOrEqual(SOUND_LIMITS.rolloff.max);
        expect(sound.cooldownMs, where).toBeGreaterThanOrEqual(SOUND_LIMITS.cooldownMs.min);
        expect(sound.cooldownMs, where).toBeLessThanOrEqual(SOUND_LIMITS.cooldownMs.max);
      }
    }
  });

  it('never leaves distance.max inside distance.ref, at any pair a document can name', () => {
    // The Web Audio inverse model clamps the distance into `[ref, max]`, so an
    // inverted pair does not make a sound loud: it silences it outright. And the
    // push past `ref` must not itself escape the limits -- which is why `ref` is
    // capped below `max` rather than at the same number.
    for (const ref of [-1e6, 0, 10, 139, 140, 2000, 1e6]) {
      for (const max of [-1e6, 0, 49, 50, 140, 2200, 1e6]) {
        const where = `ref ${ref}, max ${max}`;
        const distance = resolveSound('player.footstep', { variants: [A_FILE], distance: { ref, max } }).distance;
        expect(distance.max, where).toBeGreaterThan(distance.ref);
        expect(distance.max, where).toBeGreaterThanOrEqual(SOUND_LIMITS.max.min);
        expect(distance.max, where).toBeLessThanOrEqual(SOUND_LIMITS.max.max);
      }
    }
  });

  it('takes loop from the event, for every event in the vocabulary', () => {
    const entry: SoundEntry = { variants: [A_FILE] };
    for (const id of SOUND_EVENT_IDS) {
      expect(resolveSound(id, entry).loop, id).toBe(soundEvent(id)?.loop === true);
    }
    // ...and the sweep found both answers, or a resolver hard-coded to `false`
    // passes the loop above.
    const looping = SOUND_EVENT_IDS.filter((id) => resolveSound(id, entry).loop);
    expect(looping.length).toBeGreaterThan(0);
    expect(looping.length).toBeLessThan(SOUND_EVENT_IDS.length);
  });

  it('cannot be told to loop by an entry', () => {
    // A held sound is started and stopped by a driver holding a handle, so a
    // document able to turn a one-shot into a loop is a document able to leave a
    // sound running with nothing owning it. `SoundEntry` has no `loop` field at
    // all; this is the runtime half of that, since JSON on disk is not typed.
    const rogue = { variants: [A_FILE], loop: true };
    expect(resolveSound('ui.error', rogue).loop).toBe(false);
    expect(resolveSound('elemental.fire.travel', { variants: [A_FILE] }).loop).toBe(true);
  });

  it('takes spatial from the event’s placement, and lets an entry override it', () => {
    expect(resolveSound('player.footstep', { variants: [A_FILE] }).spatial).toBe(true);
    expect(resolveSound('ui.error', { variants: [A_FILE] }).spatial).toBe(false);
    expect(resolveSound('player.footstep', { variants: [A_FILE], spatial: false }).spatial).toBe(false);
    expect(resolveSound('ui.error', { variants: [A_FILE], spatial: true }).spatial).toBe(true);
  });

  it('fills in the distance bounds an entry left out, one at a time', () => {
    // `distance` is the one `Partial` in the format, so a row naming `ref` alone
    // must not lose `max` and `rolloff` with it.
    const only = resolveSound('player.footstep', { variants: [A_FILE], distance: { ref: 70 } }).distance;
    expect(only).toEqual({ ref: 70, max: SOUND_DEFAULTS.distance.max, rolloff: SOUND_DEFAULTS.distance.rolloff });
    expect(resolveSound('player.footstep', { variants: [A_FILE], distance: {} }).distance).toEqual(
      SOUND_DEFAULTS.distance,
    );
  });
});

describe('the gap report', () => {
  it('partitions the vocabulary: an event is assigned or unassigned, never both or neither', () => {
    const unassigned = new Set(unassignedEvents(shipped));
    for (const id of SOUND_EVENT_IDS) expect(unassigned.has(id), id).toBe(!shipped.has(id));
    expect(unassigned.size + shipped.size).toBe(SOUND_EVENT_IDS.length);
    // Both halves are non-empty on the shipped document, or the partition above
    // is also true of a report answering "everything" or "nothing".
    expect(unassigned.size).toBeGreaterThan(0);
    expect(shipped.size).toBeGreaterThan(0);
  });

  it('reports the gaps in the vocabulary’s own order, so the tab’s header is stable', () => {
    const unassigned = unassignedEvents(shipped);
    expect(unassigned).toEqual(SOUND_EVENT_IDS.filter((id) => unassigned.includes(id)));
  });

  it('calls every event unassigned when there is no document at all', () => {
    // What a missing file means, and the state a fresh checkout of this feature
    // would be in: silent everywhere, and not an error anywhere.
    expect(unassignedEvents(EMPTY_CATALOG)).toEqual(SOUND_EVENT_IDS);
    expect(referencedVariants(EMPTY_CATALOG).size).toBe(0);
  });

  it('counts a file shared by several events once, and invents none', () => {
    // `/audio/ui/drop_item.ogg` is under three events in the shipped document,
    // which is the case a list-of-lists flattened without a `Set` gets wrong --
    // and "is anything unused" is a question about files, not about rows.
    const referenced = referencedVariants(shipped);
    const total = [...shipped.values()].reduce((count, entry) => count + entry.variants.length, 0);
    expect(referenced.size).toBeLessThan(total);
    const named = new Set([...shipped.values()].flatMap((entry) => [...entry.variants]));
    expect([...referenced].sort()).toEqual([...named].sort());
  });
});

describe('what a variant may name', () => {
  it('takes a path under /audio/ and nothing else', () => {
    // Not a security boundary -- the catalog is repo content -- but a typo
    // boundary: a path the bake did not write is better found at parse time than
    // as a sound that never plays.
    expect(isVariantUrl(A_FILE)).toBe(true);
    const bad: readonly unknown[] = [
      '',
      '/audio/', // the prefix with nothing after it
      'audio/x.ogg',
      '/audiox.ogg',
      '/other/x.ogg',
      'https://example.com/audio/x.ogg',
      '/audio/../x.ogg',
      '/audio/x\0.ogg',
      7,
      null,
      undefined,
      ['/audio/x.ogg'],
      { url: '/audio/x.ogg' },
    ];
    for (const value of bad) expect(isVariantUrl(value), String(value)).toBe(false);
  });
});
