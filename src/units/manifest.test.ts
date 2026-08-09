import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  allEntries,
  compareManifest,
  manifestBody,
  manifestHash,
  manifestIsSelfConsistent,
  mismatchMessage,
  refusesConnection,
  type UnitAssetEntry,
  type UnitManifest,
} from './manifest.js';

const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

function entry(patch: Partial<UnitAssetEntry> = {}): UnitAssetEntry {
  return { path: 'grunt/grunt.glb', sha256: 'a'.repeat(64), bytes: 1024, ...patch };
}

function manifest(entries: readonly UnitAssetEntry[]): UnitManifest {
  return {
    formatVersion: 1,
    hash: manifestHash(entries, hashText),
    builtStages: [],
    units: [{ id: 'grunt', family: 'biped', entries }],
  };
}

describe('manifestHash', () => {
  it('changes when any byte of any file changes', () => {
    const before = manifestHash([entry()], hashText);
    expect(manifestHash([entry({ sha256: 'b'.repeat(64) })], hashText)).not.toBe(before);
  });

  it('changes when a file is added or removed', () => {
    const one = manifestHash([entry()], hashText);
    const two = manifestHash([entry(), entry({ path: 'grunt/clips/walk.glb' })], hashText);
    expect(two).not.toBe(one);
  });

  it('does not change when the order the files were listed in changes', () => {
    // The filesystem's listing order is a fact about the machine that ran the
    // bake, not about the assets. A hash that moved with it would be a hash
    // nobody could trust, and the first mismatch would teach everyone to
    // ignore the next one.
    const a = entry({ path: 'a.glb' });
    const b = entry({ path: 'b.glb', sha256: 'c'.repeat(64) });
    expect(manifestHash([a, b], hashText)).toBe(manifestHash([b, a], hashText));
  });

  it('does not change when a file size is restated', () => {
    // Size is carried for a human reading the file; the identity is the digest.
    expect(manifestHash([entry({ bytes: 1 })], hashText)).toBe(manifestHash([entry({ bytes: 999 })], hashText));
  });

  it('is stable across runs, so an unchanged bake produces an unchanged file', () => {
    expect(manifestHash([entry()], hashText)).toBe(manifestHash([entry()], hashText));
  });

  it('cannot be collided by a path containing the separator', () => {
    // `path:sha` joined by newlines: a path with a colon in it must not be able
    // to impersonate a different path/hash pair.
    const sneaky = manifestBody([entry({ path: `x.glb:${'b'.repeat(64)}\ny.glb` })]);
    const honest = manifestBody([entry({ path: 'x.glb', sha256: 'b'.repeat(64) }), entry({ path: 'y.glb' })]);
    expect(sneaky).not.toBe(honest);
  });
});

describe('manifestIsSelfConsistent', () => {
  it('accepts a manifest whose hash matches its contents', () => {
    expect(manifestIsSelfConsistent(manifest([entry()]), hashText)).toBe(true);
  });

  it('rejects one edited by hand without rehashing', () => {
    // Otherwise the server enforces agreement on a number describing nothing.
    const edited: UnitManifest = { ...manifest([entry()]), hash: 'deadbeef' };
    expect(manifestIsSelfConsistent(edited, hashText)).toBe(false);
  });

  it('rejects one whose file list was edited but whose hash was not', () => {
    const original = manifest([entry()]);
    const tampered: UnitManifest = {
      ...original,
      units: [{ id: 'grunt', family: 'biped', entries: [entry({ sha256: 'f'.repeat(64) })] }],
    };
    expect(manifestIsSelfConsistent(tampered, hashText)).toBe(false);
  });
});

describe('allEntries', () => {
  it('flattens every unit into one list', () => {
    const both: UnitManifest = {
      formatVersion: 1,
      hash: '',
      builtStages: [],
      units: [
        { id: 'a', family: 'biped', entries: [entry({ path: 'a.glb' })] },
        { id: 'b', family: 'biped', entries: [entry({ path: 'b.glb' })] },
      ],
    };
    expect(allEntries(both).map((item) => item.path)).toEqual(['a.glb', 'b.glb']);
  });
});

describe('compareManifest', () => {
  it('matches identical hashes', () => {
    expect(compareManifest('abc', 'abc')).toBe('match');
    expect(refusesConnection('match')).toBe(false);
  });

  it('refuses a client whose hash differs -- the case the whole thing is for', () => {
    expect(compareManifest('abc', 'def')).toBe('mismatch');
    expect(refusesConnection('mismatch')).toBe(true);
  });

  it('lets a client with no manifest through', () => {
    // The bot harness and the in-tab server share a process with the thing they
    // connect to; they cannot be stale with respect to themselves. And a gate
    // that failed closed on absence could never have been introduced at all.
    expect(compareManifest('', 'abc')).toBe('client-has-none');
    expect(refusesConnection('client-has-none')).toBe(false);
  });

  it('lets a client through when the server has no manifest either', () => {
    expect(compareManifest('abc', '')).toBe('server-has-none');
    expect(refusesConnection('server-has-none')).toBe(false);
  });
});

describe('mismatchMessage', () => {
  it('names both sides, because the remedy differs by which one moved', () => {
    const message = mismatchMessage('1111111111112222', '3333333333334444');
    expect(message).toContain('111111111111');
    expect(message).toContain('333333333333');
    expect(message).toContain('bake:units');
  });

  it('says "(none)" rather than printing an empty gap', () => {
    expect(mismatchMessage('', 'abc123456789')).toContain('(none)');
  });
});
