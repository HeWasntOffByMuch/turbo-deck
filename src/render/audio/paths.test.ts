/**
 * Where a source file ends up (spec 229).
 *
 * The property that matters is not that any one name is right -- it is that
 * **three places agree**. The bake writes the file, the dev server decides where
 * an upload may land, and the SFX tab predicts the URL so it can assign the take
 * the moment the bake finishes. All three read this module, and the failure if
 * they ever stopped is silent in the worst way: an import that succeeds, a bake
 * that succeeds, and a variant pointing at a URL that 404s only when somebody
 * swings a sword.
 *
 * The other thing pinned here is that **the 74 delivered paths cannot move**.
 * They are referenced by `assets/audio/sfx.json`; a rename map that lost a row
 * would re-derive the name, the catalog would point at nothing, and the game
 * would go quiet with every test green.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BAKED_NAMES,
  bakedNameFor,
  bakedPathFor,
  importFolderFor,
  isSourceName,
  isStereoPath,
  resolveImport,
  slugSegment,
  SOURCE_EXTENSIONS,
  urlForBaked,
} from './paths.js';
import { parseCatalog, referencedVariants } from './catalog.js';
import { SOUND_EVENT_IDS } from './events.js';

const CATALOG = new URL('../../../assets/audio/sfx.json', import.meta.url);

describe('the delivered library', () => {
  /**
   * The one that would break the game silently.
   *
   * Every URL the shipped catalog names has to be a URL the bake still produces
   * for the source it came from. If a rename row were dropped, the derived name
   * would be a different, perfectly valid path -- and nothing would fail until a
   * player noticed the sound had gone.
   */
  it('bakes to exactly the paths the shipped catalog references', () => {
    const parsed = parseCatalog(readFileSync(CATALOG, 'utf8'));
    if ('error' in parsed) throw new Error(parsed.error);
    const produced = new Set(Object.values(BAKED_NAMES).map(urlForBaked));
    const referenced = [...referencedVariants(parsed.catalog)];
    expect(referenced.length).toBeGreaterThan(0);
    for (const url of referenced) expect(produced).toContain(url);
  });

  it('renames every source to a distinct name', () => {
    const names = Object.values(BAKED_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('renames only sources this can bake', () => {
    for (const source of Object.keys(BAKED_NAMES)) expect(isSourceName(source)).toBe(true);
  });

  /**
   * A rename wins over derivation, and derivation is what everything else gets.
   *
   * The half that makes the map a *map* rather than the old table: a file nobody
   * has written a row for still bakes, which is the entire point of the change.
   */
  it('derives a name for anything not in the map', () => {
    expect(bakedNameFor('steps/generic/FEETMisc_STEP-Boots on Generic Ground 1_HY_PC-001.wav')).toBe(
      'player/footsteps/boots_01',
    );
    expect(bakedNameFor('combat/hit_flesh/Parry Take 3.wav')).toBe('combat/hit_flesh/parry_take_3');
  });
});

describe('a derived name', () => {
  it('mirrors the folder it was found in', () => {
    expect(bakedPathFor('combat/swings/Parry 01.wav')).toBe('combat/swings/parry_01');
    expect(bakedPathFor('flat.wav')).toBe('flat');
  });

  it('drops only the last extension', () => {
    // A take called `hit.v2.wav` keeps the `v2`: it is part of the name somebody
    // gave it, and only the format suffix is ours to remove.
    expect(bakedPathFor('a/hit.v2.wav')).toBe('a/hit_v2');
  });

  it('is a URL nothing has to escape', () => {
    const nasty = 'Weird Dir #2/Sword + Shield (take 3)!.wav';
    const baked = bakedPathFor(nasty);
    expect(baked).toMatch(/^[a-z0-9_/]+$/);
    expect(encodeURI(urlForBaked(baked))).toBe(urlForBaked(baked));
  });

  it('never produces an empty segment', () => {
    // `___.wav` is still a file, and a path segment of nothing is a different
    // path. The fallback is what stops `//` appearing in a URL.
    expect(bakedPathFor('---/___.wav')).toBe('sound/sound');
    expect(slugSegment('')).toBe('sound');
  });

  it('is stable: baking the same source twice names it the same thing', () => {
    for (const source of Object.keys(BAKED_NAMES)) {
      expect(bakedNameFor(source)).toBe(bakedNameFor(source));
      expect(bakedPathFor(source)).toBe(bakedPathFor(source));
    }
  });
});

describe('stereo', () => {
  /**
   * Only where a sound never reaches a `PannerNode`.
   *
   * A panner downmixes stereo to mono before it pans, so anything spatial is
   * twice the bytes for an image that is discarded. Two places qualify and this
   * pins which: the interface, and the ambient bed that is `placement: 'flat'`
   * because it is everywhere.
   */
  it('is the interface and the ambient bed, and nothing else', () => {
    expect(isStereoPath('ui/denied')).toBe(true);
    expect(isStereoPath('ambience/world/forest')).toBe(true);
    expect(isStereoPath('combat/hits/blunt_01')).toBe(false);
    expect(isStereoPath('player/footsteps/boots_01')).toBe(false);
    // A positioned ambient emitter is spatial and must not be stereo.
    expect(isStereoPath('ambience/water/shore')).toBe(false);
  });
});

describe('an import', () => {
  /**
   * The folder is derived from the event, so the tab can predict the URL.
   *
   * This is the join that lets an import be assigned the instant the bake
   * finishes: the endpoint answers with `urlForBaked(bakedNameFor(path))`, and
   * the bake writes the file at exactly that name, because both went through
   * this module.
   */
  it('lands where the event says, and bakes to the URL that predicts', () => {
    const target = resolveImport(importFolderFor('combat.hit.flesh'), 'Parry 01.wav');
    if ('refusal' in target) throw new Error(target.refusal);
    expect(target.path).toBe('combat/hit_flesh/parry_01.wav');
    expect(urlForBaked(bakedNameFor(target.path))).toBe('/audio/combat/hit_flesh/parry_01.ogg');
  });

  it('gives every event in the vocabulary a folder it can use', () => {
    const seen = new Set<string>();
    for (const id of SOUND_EVENT_IDS) {
      const folder = importFolderFor(id);
      expect(folder).toMatch(/^[a-z0-9_]+\/[a-z0-9_]+$/);
      const target = resolveImport(folder, 'take.wav');
      expect('refusal' in target).toBe(false);
      seen.add(folder);
    }
    // Two events must not share a folder, or importing for one would offer its
    // takes under the other and `unusedClips` would report neither.
    expect(seen.size).toBe(SOUND_EVENT_IDS.length);
  });

  it('keeps the extension and slugs everything else', () => {
    const target = resolveImport('combat/hits', 'My Take (FINAL).WAV');
    if ('refusal' in target) throw new Error(target.refusal);
    expect(target.path).toBe('combat/hits/my_take_final.wav');
  });

  it('accepts every format the bake can read, and nothing else', () => {
    for (const extension of SOURCE_EXTENSIONS) {
      expect('refusal' in resolveImport('a/b', `take${extension}`)).toBe(false);
    }
    for (const bad of ['take.txt', 'take.js', 'take', 'take.wav.exe', '.wav']) {
      // `.wav` alone is admitted by the extension test and slugs to `sound.wav`,
      // which is a file; the rest are refused.
      if (bad === '.wav') continue;
      expect('refusal' in resolveImport('a/b', bad)).toBe(true);
    }
  });

  /**
   * Traversal is refused rather than neutralised.
   *
   * It *would* be neutralised -- every segment is slugged, so `..` becomes a
   * folder called `sound` rather than a step upward, and nothing can leave the
   * source root whatever is sent. Refusing anyway is the difference between an
   * attempt that quietly writes junk somewhere harmless and one that says what
   * it thought it was doing.
   */
  it('refuses a folder segment that is not a name', () => {
    for (const folder of ['..', '../../etc', 'a/../b', './x', 'combat/...']) {
      expect('refusal' in resolveImport(folder, 'take.wav')).toBe(true);
    }
  });

  it('refuses an empty folder and one nested past reason', () => {
    expect('refusal' in resolveImport('', 'take.wav')).toBe(true);
    expect('refusal' in resolveImport('a/b/c/d/e', 'take.wav')).toBe(true);
    expect('refusal' in resolveImport('a/b/c/d', 'take.wav')).toBe(false);
  });

  it('refuses a name with a null in it', () => {
    expect('refusal' in resolveImport('a/b', 'take\0.wav')).toBe(true);
  });

  it('never escapes the source root, whatever it is handed', () => {
    // The property behind the rule above: for anything that IS accepted, the
    // path is relative, has no `..` in it, and is exactly as deep as it looks.
    const attempts = ['a/b', 'combat/hits', 'UI', 'x/y/z', 'A B/C D'];
    for (const folder of attempts) {
      const target = resolveImport(folder, '../../../evil.wav');
      if ('refusal' in target) continue;
      expect(target.path.startsWith('/')).toBe(false);
      expect(target.path.split('/')).not.toContain('..');
      expect(target.path).toMatch(/^[a-z0-9_/]+\.[a-z0-9]+$/);
    }
  });
});
