/**
 * What the SFX tab does to the document (spec 229).
 *
 * The tab is a tree, a filter box and a panel of sliders, and every one of them
 * is a way of *editing a file that is committed*. So the properties worth
 * pinning are the ones whose failure produces a document rather than a crash:
 * a variant that swaps past its neighbour and corrupts an order somebody
 * arranged by ear, a default written into forty entries so `SOUND_DEFAULTS` can
 * never move again, an entry left behind with no files in it -- the second
 * encoding of "silent" that `catalog.ts` exists to forbid.
 *
 * Two of them are invisible from inside the tab entirely. **An edit must not
 * touch the catalog it was handed**, because the engine is holding that catalog
 * and resolved copies of it: a mutation changes what is playing with nothing
 * having been told, and the tab looks perfect. And **the filter must be able to
 * find the row somebody is editing** -- a filter that hides it is not a lost
 * feature, it is a row nobody can assign a file to.
 *
 * The last group is the picker. `parseClips` is handed a file written by a
 * script, which is exactly the sort of input nobody re-reads, so it is asserted
 * against the real `public/audio/manifest.json` and against garbage.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  catalogToJson,
  isVariantUrl,
  SOUND_DEFAULTS,
  type SoundCatalog,
  type SoundEntry,
} from '../../audio/catalog.js';
import { soundEvent, soundEventSections, SOUND_EVENT_IDS, type SoundEventId } from '../../audio/events.js';
import {
  addVariant,
  clipFolder,
  clipLabel,
  coverage,
  editing,
  moveVariant,
  parseClips,
  removeVariant,
  setCooldown,
  setDistance,
  setPitch,
  setSpatial,
  setVolume,
  tree,
  unusedClips,
  type ClipEntry,
} from './model.js';

/** Three real ids, chosen so both placements and three buses are covered. */
const FOOTSTEP = 'player.footstep' satisfies SoundEventId;
const HIT = 'combat.hit.flesh' satisfies SoundEventId;
const PRESS = 'ui.press' satisfies SoundEventId;

const BOOTS = [
  '/audio/player/footsteps/boots_01.ogg',
  '/audio/player/footsteps/boots_02.ogg',
  '/audio/player/footsteps/boots_03.ogg',
] as const;

function catalogOf(rows: readonly (readonly [SoundEventId, SoundEntry])[]): SoundCatalog {
  return new Map<SoundEventId, SoundEntry>(rows);
}

/**
 * A tuned row, so "the tuning goes with the entry" has something to lose.
 * Every field is deliberately away from its default.
 */
function tuned(): SoundCatalog {
  return catalogOf([
    [
      FOOTSTEP,
      {
        variants: [...BOOTS],
        volume: 0.35,
        pitch: { min: 0.92, max: 1.08 },
        distance: { ref: 70, max: 900 },
        cooldownMs: 70,
      },
    ],
    [HIT, { variants: ['/audio/combat/hits/blunt_01.ogg'] }],
  ]);
}

/** Every key of every entry, so a mutation to any field of any row shows up. */
function snapshot(catalog: SoundCatalog): string {
  return JSON.stringify([...catalog.entries()]);
}

/** What `catalogToJson` writes for one row, or undefined if it writes no row at all. */
function written(catalog: SoundCatalog, id: SoundEventId): Record<string, unknown> | undefined {
  const doc: unknown = JSON.parse(catalogToJson(catalog));
  const sounds = (doc as { sounds?: Record<string, unknown> }).sounds;
  const entry = sounds?.[id];
  return typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined;
}

function variantsOf(catalog: SoundCatalog, id: SoundEventId): readonly string[] {
  return catalog.get(id)?.variants ?? [];
}

describe('the outline the tab draws', () => {
  it('holds every event exactly once, in the vocabulary’s own order', () => {
    // The table is the outline (`events.ts` says so), so a tree that reordered
    // or dropped a row would be a second list deciding what comes before what.
    const rows = tree(new Map()).flatMap((section) => section.rows.map((row) => row.event.id));
    expect(rows).toEqual(SOUND_EVENT_IDS);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it('groups exactly as the vocabulary groups, bus and heading alike', () => {
    const drawn = tree(new Map()).map((section) => `${section.bus}/${section.section}`);
    expect(drawn).toEqual(soundEventSections().map((section) => `${section.bus}/${section.section}`));
    expect(drawn.length).toBeGreaterThan(0);
  });

  it('counts each row’s variants off the catalog, for every row at once', () => {
    // The number beside a row is the only thing in the tree that is not a fact
    // about the table, so it is asserted over the whole tree rather than at the
    // two rows a fixture happens to fill.
    const catalog = tuned();
    for (const section of tree(catalog)) {
      for (const row of section.rows) {
        expect(row.variants, row.event.id).toBe(catalog.get(row.event.id)?.variants.length ?? 0);
      }
    }
    const rows = tree(catalog).flatMap((section) => section.rows);
    expect(rows.find((row) => row.event.id === FOOTSTEP)?.variants).toBe(3);
    expect(rows.find((row) => row.event.id === PRESS)?.variants).toBe(0);
  });
});

describe('the filter box', () => {
  it('yields no sections at all when nothing matches, rather than empty ones', () => {
    // Eleven headings with nothing under them is the tree again, which is the
    // one thing a filter exists to avoid. `parry` is the example `events.ts`
    // gives of a moment this game does not have.
    expect(tree(tuned(), 'parry')).toEqual([]);
    expect(tree(tuned(), 'zzzz')).toHaveLength(0);
  });

  it('finds a row by the note, which is the sentence the id does not say', () => {
    // The case somebody actually uses: "which row fires when I walk" is
    // answered by the note and by nothing else on the row. `stride` appears in
    // `player.footstep`'s note and in no id, label or heading anywhere.
    const found = tree(tuned(), 'stride').flatMap((section) => section.rows.map((row) => row.event.id));
    expect(found).toEqual([FOOTSTEP]);
    expect(soundEvent(FOOTSTEP)?.note.toLowerCase()).toContain('stride');
    expect(FOOTSTEP.toLowerCase()).not.toContain('stride');
  });

  it('finds a row by its id, its label and its heading too', () => {
    const ids = (query: string): readonly string[] =>
      tree(tuned(), query).flatMap((section) => section.rows.map((row) => row.event.id));
    // An id fragment.
    expect(ids('combat.hit.')).toContain(HIT);
    // A label: `ui.press` is called "Press".
    expect(ids('press')).toContain(PRESS);
    // A heading, which matches no id, label or note in the table -- so a tree
    // that only searched the rows would return nothing here.
    const vitals = tree(tuned(), 'vitals');
    expect(vitals).toHaveLength(1);
    expect(vitals[0]?.section).toBe('Vitals');
    expect(vitals[0]?.rows.length).toBeGreaterThan(1);
  });

  it('ignores case and surrounding space, and treats an empty query as no filter', () => {
    const all = tree(tuned()).flatMap((section) => section.rows.map((row) => row.event.id));
    for (const query of ['', '   ', '\n\t']) expect(tree(tuned(), query).flatMap((s) => s.rows).length).toBe(all.length);
    expect(tree(tuned(), 'STRIDE')).toEqual(tree(tuned(), 'stride'));
    expect(tree(tuned(), '  Stride  ')).toEqual(tree(tuned(), 'stride'));
  });

  it('keeps a filtered row’s variant count and its place in the order', () => {
    const filtered = tree(tuned(), 'combat.').flatMap((section) => section.rows);
    const ids = filtered.map((row) => row.event.id);
    // A filter narrows; it never reorders.
    expect(ids).toEqual(SOUND_EVENT_IDS.filter((id) => ids.includes(id)));
    expect(filtered.find((row) => row.event.id === HIT)?.variants).toBe(1);
  });
});

describe('assigning files to a row', () => {
  it('appends, so the order is the order they were added in', () => {
    let catalog: SoundCatalog = new Map();
    for (const url of BOOTS) catalog = addVariant(catalog, FOOTSTEP, url);
    expect(variantsOf(catalog, FOOTSTEP)).toEqual([...BOOTS]);
  });

  it('refuses a duplicate and hands back the very catalog it was given', () => {
    // Two identical variants is one variant with twice the odds, which is not
    // a thing anybody means to author. Identity, not equality: the tab assigns
    // the answer back, and a fresh map here would be a redraw for nothing.
    const catalog = tuned();
    expect(addVariant(catalog, FOOTSTEP, BOOTS[1])).toBe(catalog);
  });

  it('removes the named one and leaves the rest in order', () => {
    const catalog = removeVariant(tuned(), FOOTSTEP, 1);
    expect(variantsOf(catalog, FOOTSTEP)).toEqual([BOOTS[0], BOOTS[2]]);
  });

  it('deletes the whole entry when the last variant goes, and the tuning with it', () => {
    // The rule `catalog.ts` states: an entry with no files is the same state as
    // no entry, and two encodings of one state is one of them being wrong. A
    // volume left behind for a sound that does not exist is a number nobody can
    // hear the effect of -- and one that would come back if a file were ever
    // assigned again, which is the surprise.
    const catalog = removeVariant(tuned(), HIT, 0);
    expect(catalog.has(HIT)).toBe(false);

    const before = catalogOf([[PRESS, { variants: ['/audio/ui/click.ogg'], volume: 0.4, cooldownMs: 200 }]]);
    const after = removeVariant(before, PRESS, 0);
    expect(after.get(PRESS)).toBeUndefined();
    expect(written(after, PRESS)).toBeUndefined();
    // And nothing else in the document moved.
    expect(after.size).toBe(0);
  });

  it('is a no-op for an index that is not there', () => {
    const catalog = tuned();
    for (const index of [-1, 3, 99]) expect(removeVariant(catalog, FOOTSTEP, index)).toBe(catalog);
    // Including on a row that has no entry at all.
    expect(removeVariant(catalog, PRESS, 0)).toBe(catalog);
  });
});

describe('the order of a row’s variants', () => {
  it('swaps a variant with its neighbour, in both directions', () => {
    expect(variantsOf(moveVariant(tuned(), FOOTSTEP, 0, 1), FOOTSTEP)).toEqual([BOOTS[1], BOOTS[0], BOOTS[2]]);
    expect(variantsOf(moveVariant(tuned(), FOOTSTEP, 2, -1), FOOTSTEP)).toEqual([BOOTS[0], BOOTS[2], BOOTS[1]]);
  });

  it('does nothing off either end, rather than wrapping round', () => {
    // A wrap is what a mis-click on the top row looks like, and it is the one
    // failure that quietly rearranges a list somebody arranged by ear. Asserted
    // as "not the wrapped answer" as well as "unchanged", because an
    // implementation that wrapped would satisfy neither by accident.
    const catalog = tuned();
    const wrappedUp = [BOOTS[2], BOOTS[1], BOOTS[0]];
    const upOffTheTop = moveVariant(catalog, FOOTSTEP, 0, -1);
    expect(upOffTheTop).toBe(catalog);
    expect(variantsOf(upOffTheTop, FOOTSTEP)).toEqual([...BOOTS]);
    expect(variantsOf(upOffTheTop, FOOTSTEP)).not.toEqual(wrappedUp);

    const downOffTheBottom = moveVariant(catalog, FOOTSTEP, 2, 1);
    expect(downOffTheBottom).toBe(catalog);
    expect(variantsOf(downOffTheBottom, FOOTSTEP)).toEqual([...BOOTS]);
    // And the wrap in the other direction: last to first.
    expect(variantsOf(downOffTheBottom, FOOTSTEP)[0]).toBe(BOOTS[0]);
  });

  it('is always a permutation of the same files, for every move that is legal', () => {
    // The property behind the two cases above: a move rearranges and never
    // invents, drops or duplicates, whatever index and step it is handed.
    const catalog = tuned();
    const sorted = [...BOOTS].sort();
    for (let index = -2; index <= 4; index++) {
      for (const by of [-3, -2, -1, 0, 1, 2, 3]) {
        const moved = variantsOf(moveVariant(catalog, FOOTSTEP, index, by), FOOTSTEP);
        expect([...moved].sort(), `${String(index)} by ${String(by)}`).toEqual(sorted);
      }
    }
  });

  it('refuses a step that would land outside the list, however big', () => {
    const catalog = tuned();
    expect(moveVariant(catalog, FOOTSTEP, 1, 5)).toBe(catalog);
    expect(moveVariant(catalog, FOOTSTEP, 1, -5)).toBe(catalog);
    expect(moveVariant(catalog, PRESS, 0, 1)).toBe(catalog);
  });
});

describe('an edit never touches the catalog it was handed', () => {
  it('leaves the input untouched, whichever edit it was', () => {
    // The one failure in this file that is invisible from inside the tab: the
    // engine holds this catalog and resolved copies of it, so a mutation
    // changes what is playing with nothing having been told, and every screen
    // still looks right.
    const edits: readonly (readonly [string, (catalog: SoundCatalog) => SoundCatalog])[] = [
      ['addVariant', (c) => addVariant(c, FOOTSTEP, '/audio/player/footsteps/boots_04.ogg')],
      ['addVariant to an empty row', (c) => addVariant(c, PRESS, '/audio/ui/click.ogg')],
      ['addVariant duplicate', (c) => addVariant(c, FOOTSTEP, BOOTS[0])],
      ['removeVariant', (c) => removeVariant(c, FOOTSTEP, 0)],
      ['removeVariant of the last', (c) => removeVariant(c, HIT, 0)],
      ['moveVariant', (c) => moveVariant(c, FOOTSTEP, 0, 1)],
      ['moveVariant off the end', (c) => moveVariant(c, FOOTSTEP, 0, -1)],
      ['setVolume', (c) => setVolume(c, FOOTSTEP, 1.5)],
      ['setVolume to the default', (c) => setVolume(c, FOOTSTEP, SOUND_DEFAULTS.volume)],
      ['setPitch', (c) => setPitch(c, FOOTSTEP, { min: 0.8, max: 1.2 })],
      ['setPitch to the default', (c) => setPitch(c, FOOTSTEP, SOUND_DEFAULTS.pitch)],
      ['setCooldown', (c) => setCooldown(c, FOOTSTEP, 500)],
      ['setSpatial', (c) => setSpatial(c, FOOTSTEP, false, true)],
      ['setDistance', (c) => setDistance(c, FOOTSTEP, 'ref', 300)],
      ['setDistance to the default', (c) => setDistance(c, FOOTSTEP, 'ref', SOUND_DEFAULTS.distance.ref)],
    ];

    for (const [name, edit] of edits) {
      const catalog = tuned();
      const before = snapshot(catalog);
      edit(catalog);
      expect(snapshot(catalog), name).toBe(before);
    }
  });

  it('answers with a different map, so the tab can tell an edit happened', () => {
    const catalog = tuned();
    expect(addVariant(catalog, PRESS, '/audio/ui/click.ogg')).not.toBe(catalog);
    expect(setVolume(catalog, FOOTSTEP, 0.5)).not.toBe(catalog);
    expect(removeVariant(catalog, FOOTSTEP, 0)).not.toBe(catalog);
  });
});

describe('a field set back to its default', () => {
  it('is removed from the entry rather than stored, for every tuning field', () => {
    // What keeps `SOUND_DEFAULTS` able to move: a default written into forty
    // entries is a default that can never be changed again. It also means the
    // diff of a tuning session is the fields somebody actually tuned.
    const fields: readonly (readonly [string, (catalog: SoundCatalog) => SoundCatalog])[] = [
      ['volume', (c) => setVolume(c, FOOTSTEP, SOUND_DEFAULTS.volume)],
      ['pitch', (c) => setPitch(c, FOOTSTEP, { ...SOUND_DEFAULTS.pitch })],
      ['cooldownMs', (c) => setCooldown(c, FOOTSTEP, SOUND_DEFAULTS.cooldownMs)],
    ];

    for (const [key, edit] of fields) {
      const catalog = edit(tuned());
      const entry = catalog.get(FOOTSTEP);
      expect(entry, key).toBeDefined();
      // Absent, not present-and-undefined: under `exactOptionalPropertyTypes`
      // those are different types, and `catalogToJson` counts keys.
      expect(Object.keys(entry ?? { variants: [] }), key).not.toContain(key);

      const round = written(catalog, FOOTSTEP);
      expect(round, key).toBeDefined();
      expect(Object.keys(round ?? {}), key).not.toContain(key);
      // The variants are untouched by a tuning edit.
      expect(round?.['variants']).toEqual([...BOOTS]);
    }
  });

  it('stores a value that is not the default, and only that one', () => {
    const catalog = setVolume(setPitch(new Map(), FOOTSTEP, SOUND_DEFAULTS.pitch), FOOTSTEP, 0.5);
    // A row with no files is no row, so an unassigned event cannot be tuned.
    expect(catalog.size).toBe(0);

    const assigned = setVolume(addVariant(new Map(), FOOTSTEP, BOOTS[0]), FOOTSTEP, 0.5);
    expect(written(assigned, FOOTSTEP)).toEqual({ variants: [BOOTS[0]], volume: 0.5 });
  });

  it('drops one distance key without disturbing the others', () => {
    const catalog = setDistance(tuned(), FOOTSTEP, 'ref', SOUND_DEFAULTS.distance.ref);
    expect(catalog.get(FOOTSTEP)?.distance).toEqual({ max: 900 });
    // And a block whose every key is back at the default takes the block away.
    const flat = setDistance(catalog, FOOTSTEP, 'max', SOUND_DEFAULTS.distance.max);
    expect(Object.keys(flat.get(FOOTSTEP) ?? {})).not.toContain('distance');
    expect(written(flat, FOOTSTEP)?.['distance']).toBeUndefined();
  });
});

describe('turning a row’s spatialisation on and off', () => {
  it('keeps the falloff numbers when it is switched off, so it is not a one-way trip', () => {
    // Toggling to compare a sound flat against placed is the first thing
    // anybody does in this panel. A toggle that discarded the range would make
    // it a trip you take once and then have to re-tune your way back from.
    const flattened = setSpatial(tuned(), FOOTSTEP, false, true);
    expect(flattened.get(FOOTSTEP)?.spatial).toBe(false);
    expect(flattened.get(FOOTSTEP)?.distance).toEqual({ ref: 70, max: 900 });

    // ...and back again lands exactly where it started.
    const restored = setSpatial(flattened, FOOTSTEP, true, true);
    expect(restored.get(FOOTSTEP)?.distance).toEqual({ ref: 70, max: 900 });
    expect(editing(FOOTSTEP, restored).spatial).toBe(true);
    expect(written(restored, FOOTSTEP)).toEqual(written(tuned(), FOOTSTEP));
  });

  it('stores nothing when the value is the event’s own placement', () => {
    // The event declares the placement; the entry only ever overrides it. So a
    // row set to what it already was must write no key, or every entry in the
    // file would restate a fact the table already holds.
    const on = setSpatial(tuned(), FOOTSTEP, true, true);
    expect(Object.keys(on.get(FOOTSTEP) ?? {})).not.toContain('spatial');
    expect(written(on, FOOTSTEP)?.['spatial']).toBeUndefined();

    // The same in the other direction, for a row whose event is flat.
    const pressed = addVariant(new Map(), PRESS, '/audio/ui/click.ogg');
    expect(soundEvent(PRESS)?.placement).toBe('flat');
    const stillFlat = setSpatial(pressed, PRESS, false, false);
    expect(Object.keys(stillFlat.get(PRESS) ?? {})).not.toContain('spatial');
    const placed = setSpatial(pressed, PRESS, true, false);
    expect(placed.get(PRESS)?.spatial).toBe(true);
    expect(editing(PRESS, placed).spatial).toBe(true);
  });
});

describe('how much of the game has a sound', () => {
  it('counts every event in the vocabulary, assigned or not', () => {
    const empty = coverage(new Map());
    expect(empty.total).toBe(SOUND_EVENT_IDS.length);
    expect(empty.assigned).toBe(0);
    expect(empty.unassigned).toEqual(SOUND_EVENT_IDS);

    const some = coverage(tuned());
    expect(some.total).toBe(SOUND_EVENT_IDS.length);
    expect(some.assigned).toBe(2);
    expect(some.unassigned).not.toContain(FOOTSTEP);
    expect(some.unassigned).toContain(PRESS);
    expect(some.assigned + some.unassigned.length).toBe(some.total);
  });

  it('calls a row with an empty variant list unassigned, because it is silent', () => {
    // The report must never claim a sound for a row that plays nothing. An
    // empty entry cannot survive an edit here, but it can arrive from a
    // document written by hand.
    const report = coverage(catalogOf([[FOOTSTEP, { variants: [] }]]));
    expect(report.assigned).toBe(0);
    expect(report.unassigned).toContain(FOOTSTEP);
  });

  it('lists the clips no row references, in the manifest’s order', () => {
    const clips: readonly ClipEntry[] = [
      { url: BOOTS[0], seconds: 0.4, bytes: 100, channels: 1 },
      { url: '/audio/ui/click.ogg', seconds: 0.1, bytes: 50, channels: 1 },
      { url: BOOTS[1], seconds: 0.4, bytes: 100, channels: 1 },
      { url: '/audio/ui/denied.ogg', seconds: 0.2, bytes: 60, channels: 2 },
    ];
    const catalog = catalogOf([[FOOTSTEP, { variants: [BOOTS[0], BOOTS[1]] }]]);
    expect(unusedClips(catalog, clips)).toEqual(['/audio/ui/click.ogg', '/audio/ui/denied.ogg']);
    expect(unusedClips(new Map(), clips)).toEqual(clips.map((clip) => clip.url));
    expect(unusedClips(catalog, [])).toEqual([]);
  });

  it('is unbothered by a variant naming a file the manifest has not got', () => {
    // A row pointing at a deleted take is a real state, and it must not take
    // the unused report down with it or subtract from it.
    const clips: readonly ClipEntry[] = [{ url: BOOTS[0], seconds: 0.4, bytes: 100, channels: 1 }];
    const catalog = catalogOf([[FOOTSTEP, { variants: ['/audio/player/footsteps/gone.ogg'] }]]);
    expect(unusedClips(catalog, clips)).toEqual([BOOTS[0]]);
  });
});

describe('reading the bake’s manifest', () => {
  it('answers with an empty list rather than throwing, whatever it is handed', () => {
    // A missing or broken manifest costs a picker with nothing in it, which is
    // a tab you can still read, against a tab that will not open.
    const garbage: readonly unknown[] = [
      null,
      undefined,
      42,
      'clips',
      [],
      {},
      { clips: null },
      { clips: 'lots' },
      { clips: [null, 7, 'x', []] },
      { clips: [{}] },
      { clips: [{ url: 5 }] },
    ];
    for (const raw of garbage) expect(parseClips(raw), JSON.stringify(raw) ?? 'undefined').toEqual([]);
  });

  it('drops a url the document could never store, not merely one outside /audio/', () => {
    // The picker and the document have to agree about what a variant may be, or
    // the tab offers a clip you can assign, save, and then find it refuses to
    // load back. `isVariantUrl` is that one predicate -- and a `/audio/` prefix
    // test is not it: `/audio/../secret.ogg` passes the prefix and fails the
    // predicate.
    const raw = {
      clips: [
        { url: '/audio/ui/click.ogg' },
        { url: '/assets/audio/ui/click.ogg' },
        { url: 'audio/ui/click.ogg' },
        { url: 'https://example.com/audio/click.ogg' },
        { url: '/audio/../secret.ogg' },
        { url: '/audio/' },
      ],
    };
    expect(parseClips(raw).map((clip) => clip.url)).toEqual(['/audio/ui/click.ogg']);
    for (const clip of parseClips(raw)) expect(isVariantUrl(clip.url), clip.url).toBe(true);
  });

  it('fills in the fields a row is missing rather than dropping the row', () => {
    const [clip] = parseClips({ clips: [{ url: '/audio/ui/click.ogg' }] });
    expect(clip).toEqual({ url: '/audio/ui/click.ogg', seconds: 0, bytes: 0, channels: 1 });
    // Anything that is not exactly 2 is mono, so a garbled count cannot make
    // the picker claim a stereo take.
    const counts = [0, 1, 2, 3, '2', null].map(
      (channels) => parseClips({ clips: [{ url: '/audio/ui/click.ogg', channels }] })[0]?.channels,
    );
    expect(counts).toEqual([1, 1, 2, 1, 1, 1]);
  });

  it('reads every clip in the real manifest, and every one of them is assignable', () => {
    const clips = parseClips(readManifest());
    // The bake is committed, so an empty answer here is a broken bake rather
    // than a legitimately quiet game.
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      expect(isVariantUrl(clip.url), clip.url).toBe(true);
      expect(clip.seconds, clip.url).toBeGreaterThan(0);
      expect(clip.bytes, clip.url).toBeGreaterThan(0);
      expect([1, 2], clip.url).toContain(clip.channels);
    }
  });
});

describe('what the picker calls a clip', () => {
  it('splits a real url into a folder and a name that put it back together', () => {
    // The two halves are shown in two places -- the folder is the group heading
    // and the label is the row -- so a url they cannot reconstruct is a row
    // pointing at a file that is not the one it names.
    const clips = parseClips(readManifest());
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      expect(`/audio/${clipFolder(clip.url)}/${clipLabel(clip.url)}.ogg`, clip.url).toBe(clip.url);
      expect(clipLabel(clip.url), clip.url).not.toContain('/');
      expect(clipLabel(clip.url), clip.url).not.toContain('.ogg');
      expect(clipFolder(clip.url), clip.url).not.toMatch(/^\/|\/$/);
    }
  });

  it('groups the real manifest into the folders the bake actually wrote', () => {
    const folders = new Set(parseClips(readManifest()).map((clip) => clipFolder(clip.url)));
    // Nested folders keep both levels, or `combat/hits` and `combat/swings`
    // collapse into one heading holding both.
    expect(folders).toContain('player/footsteps');
    expect(folders).toContain('combat/hits');
    expect(folders).toContain('ui');
    expect(folders.size).toBeGreaterThan(3);
  });

  it('calls a clip sitting straight under /audio/ the root', () => {
    // The one shape with no folder in it. It is not in the bake today, and it
    // is what the picker would be handed the day somebody drops a file in the
    // top of the tree.
    expect(clipFolder('/audio/click.ogg')).toBe('/');
    expect(clipLabel('/audio/click.ogg')).toBe('click');
    // A name that is not an .ogg keeps its extension rather than losing a
    // trailing chunk of itself.
    expect(clipLabel('/audio/ui/click.wav')).toBe('click.wav');
    expect(clipLabel('/audio/ui/boots_01.ogg.ogg')).toBe('boots_01.ogg');
  });
});

/** The shipped bake, as the tab is handed it. */
function readManifest(): unknown {
  return JSON.parse(readFileSync(new URL('../../../../public/audio/manifest.json', import.meta.url), 'utf8'));
}
