/**
 * What the boards on the shipped map say, and that they say all of it
 * (spec 283).
 *
 * `signText` **truncates** rather than refusing -- deliberately, since a map is
 * a document somebody may hand-edit and a sign is no reason to refuse a whole
 * world -- so a board written one character too long loses its end silently, in
 * the field, to whoever walks up to it. Nothing else in the tree would notice.
 *
 * The vocabulary rules are the other half, and they are the rules
 * `docs/mechanics-vocabulary.md` Part 1 states rather than this file's opinion:
 * a synonym is a second concept whether or not anybody meant it to be, and a
 * number in prose is a second copy of a table with nothing keeping it true.
 */

import { describe, expect, it } from 'vitest';
import { loadMapFile } from './map-file.js';
import { loadMap } from '../../terrain/map-world.js';
import { MAX_SIGN_TEXT, signText } from '../../terrain/vegetation.js';

const shipped = loadMapFile();
const world = loadMap(shipped.doc);

function boards(): readonly string[] {
  const found: string[] = [];
  for (const layer of shipped.doc.layers) {
    for (const prop of world.store.props(layer.id)) {
      const text = signText(prop);
      if (text !== null) found.push(text);
    }
  }
  return found;
}

describe('the boards on the shipped map (spec 283)', () => {
  it('has some, which is the state spec 260 shipped without', () => {
    // Spec 260 built the sign and named "a tutorial line" as the first thing
    // one is for, and the map carried 5,666 props and no board for twenty-three
    // specs. A count of zero here is that state coming back.
    expect(boards().length).toBeGreaterThan(0);
  });

  it('says all of what it says', () => {
    // `signText` slices at the cap rather than refusing, so a board over it is
    // a sentence that stops mid-word in the world and nowhere else.
    for (const text of boards()) {
      expect(text.length, text).toBeLessThanOrEqual(MAX_SIGN_TEXT);
    }
  });

  it('states no number', () => {
    // The rule `mechanics-vocabulary.md` holds every description to, and the
    // reason the boards say what a mechanic *is* and never how much: the sheet
    // and the tooltips are derived from the rows the sim reads, and a board is
    // not. Digits are the test because they are what a retune moves; a word
    // like "some" survives one.
    for (const text of boards()) {
      expect(text, text).not.toMatch(/\d/);
    }
  });

  it('uses the controlled term and not a synonym', () => {
    // Part 1's own table: Guard is the pool, Staggered is the state, and the
    // two phases are the wind-up and the backswing. "Poise" is what the sim
    // calls Guard internally and is exactly the leak worth catching, since it
    // is the word somebody reading `sim/poise.ts` would reach for.
    for (const text of boards()) {
      expect(text.toLowerCase(), text).not.toMatch(/\bpoise\b/);
      expect(text.toLowerCase(), text).not.toMatch(/\bmana\b/);
      expect(text.toLowerCase(), text).not.toMatch(/\bstun\b/);
    }
  });
});
