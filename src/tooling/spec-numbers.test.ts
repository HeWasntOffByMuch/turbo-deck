import { describe, expect, it } from 'vitest';

import {
  checkSpecs,
  collisionsIn,
  nextFreeNumber,
  parseSpecPath,
  parseSpecPaths,
} from './spec-numbers.js';

describe('parseSpecPath', () => {
  it('reads the number and the slug off a spec name', () => {
    expect(parseSpecPath('specs/264-a-press-that-waits-for-the-swing.md')).toEqual({
      path: 'specs/264-a-press-that-waits-for-the-swing.md',
      number: 264,
      slug: 'a-press-that-waits-for-the-swing',
    });
  });

  it('counts the template, so nothing ever takes 000', () => {
    expect(parseSpecPath('specs/000-template.md')?.number).toBe(0);
  });

  it('ignores anything that is not a numbered spec', () => {
    for (const path of [
      'specs/notes.md',
      'specs/12-too-short.md',
      'specs/264-no-extension',
      'specs/subdir/264-nested.md',
      'docs/264-not-a-spec.md',
      'specs/264.md',
    ]) {
      expect(parseSpecPath(path)).toBeNull();
    }
  });
});

describe('nextFreeNumber', () => {
  it('is one past the highest claim', () => {
    expect(nextFreeNumber([0, 1, 263, 264])).toBe(265);
  });

  it('never fills a gap', () => {
    // 020 and 021 are holes in the real history. A spec dropped into one would
    // sort as though it had been built in 2025, which is the whole reason the
    // sequence exists.
    expect(nextFreeNumber([19, 22, 23])).toBe(24);
  });

  it('counts a claim on an unmerged branch exactly like a merged one', () => {
    // The bug this whole module is about: `main` stops at 264 and a branch has
    // already published 265, so the free number is 266.
    expect(nextFreeNumber([264, 265])).toBe(266);
  });

  it('starts at zero when nothing is claimed', () => {
    expect(nextFreeNumber([])).toBe(0);
  });
});

describe('collisionsIn', () => {
  it('reports a contested number with every file on it', () => {
    const specs = parseSpecPaths([
      'specs/263-a-body-that-arrives.md',
      'specs/263-a-grave-in-the-ground.md',
      'specs/264-a-day-and-a-night-the-server-keeps.md',
    ]);
    expect(collisionsIn(specs)).toEqual([
      {
        number: 263,
        files: [
          expect.objectContaining({ slug: 'a-body-that-arrives' }),
          expect.objectContaining({ slug: 'a-grave-in-the-ground' }),
        ],
      },
    ]);
  });

  it('says nothing when every number is held once', () => {
    expect(collisionsIn(parseSpecPaths(['specs/001-workflow.md', 'specs/002-deck.md']))).toEqual([]);
  });
});

describe('checkSpecs', () => {
  const main = ['specs/000-template.md', 'specs/263-a-grave-in-the-ground.md', 'specs/264-a-day.md'];

  it('passes a branch that took a free number', () => {
    const report = checkSpecs(main, [...main, 'specs/265-a-number-nobody-can-take-twice.md']);
    expect(report.collisions).toEqual([]);
    expect(report.added.map((spec) => spec.number)).toEqual([265]);
  });

  it('fails a branch that took a number main already holds', () => {
    const report = checkSpecs(main, [...main, 'specs/263-a-body-that-arrives.md']);
    expect(report.collisions).toHaveLength(1);
    const [collision] = report.collisions;
    expect(collision?.number).toBe(263);
    // Both files are named, because "263 is taken" is not something a session
    // can act on and "263 is taken by the grave" is.
    expect(collision?.files.map((file) => file.slug)).toEqual([
      'a-body-that-arrives',
      'a-grave-in-the-ground',
    ]);
  });

  it('fails a branch that collides with itself', () => {
    const report = checkSpecs(main, [...main, 'specs/265-one-thing.md', 'specs/265-another.md']);
    expect(report.collisions.map((collision) => collision.number)).toEqual([265]);
  });

  it('passes a renumber, which is an add at the new number and a removal at the old', () => {
    // The recovery path has to clear the gate, or a session that corrects a
    // collision is told off for having corrected it.
    const head = ['specs/000-template.md', 'specs/264-a-day.md', 'specs/265-a-grave-in-the-ground.md'];
    expect(checkSpecs(main, head).collisions).toEqual([]);
  });

  it('never fails on a duplicate this branch did not introduce', () => {
    // `main` carries 48 of these. Renumbering them would break every `spec NNN`
    // reference in the tree, so they are reported and never gated on.
    const duplicated = [...main, 'specs/263-a-body-that-arrives.md'];
    const report = checkSpecs(duplicated, duplicated);
    expect(report.added).toEqual([]);
    expect(report.collisions).toEqual([]);
    expect(report.existing.map((collision) => collision.number)).toEqual([263]);
  });

  it('reports a pre-existing duplicate as existing, not as this branch\'s doing', () => {
    const duplicated = [...main, 'specs/263-a-body-that-arrives.md'];
    const report = checkSpecs(duplicated, [...duplicated, 'specs/266-something-new.md']);
    expect(report.collisions).toEqual([]);
    expect(report.existing.map((collision) => collision.number)).toEqual([263]);
  });

  it('passes a branch that touches no specs at all', () => {
    const report = checkSpecs(main, main);
    expect(report.added).toEqual([]);
    expect(report.collisions).toEqual([]);
  });
});
