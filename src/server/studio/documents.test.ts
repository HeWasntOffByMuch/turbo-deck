/**
 * Writing tuned documents back to disk (spec 110).
 *
 * The property that matters is the negative one: a document that would not
 * validate never reaches the disk. Writing first and checking second would mean
 * the broken file is already there when the check fails, and the next reader --
 * CI, the game, the next tuning session -- gets it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOfPath, listDocuments, readDocument, resolveInside, writeDocument } from './documents.js';
import type { ClipLib } from '../../units/types.js';

let dir: string;

function clipLib(patch: Partial<ClipLib> = {}): ClipLib {
  return {
    formatVersion: 1,
    id: 'biped.core',
    skeletonRef: 'biped.skeleton.json',
    clips: [
      {
        id: 'attack',
        source: 'clips/attack.glb',
        durationMs: 900,
        loop: false,
        events: [
          { name: 'swing.start', normalizedTime: 0 },
          { name: 'swing.impact', normalizedTime: 0.55 },
        ],
      },
    ],
    ...patch,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-docs-'));
  mkdirSync(join(dir, 'dev'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('path resolution', () => {
  it('accepts a document under the units directory', () => {
    expect(resolveInside(dir, 'dev/x.cliplib.json')).toBe(join(dir, 'dev', 'x.cliplib.json'));
  });

  it('refuses a path that escapes, however it is spelled', () => {
    // Resolved and then checked, rather than filtered as a string -- the string
    // version is the one that gets walked around with encoding.
    for (const attempt of ['../secrets.json', 'dev/../../secrets.json', '/etc/passwd.json']) {
      expect(resolveInside(dir, attempt), attempt).toBeNull();
    }
  });

  it('refuses anything that is not JSON', () => {
    expect(resolveInside(dir, 'dev/model.glb')).toBeNull();
  });

  it('knows a document by its suffix', () => {
    expect(kindOfPath('a/b.skeleton.json')).toBe('skeleton');
    expect(kindOfPath('a/b.cliplib.json')).toBe('cliplib');
    expect(kindOfPath('a/b.unitdef.json')).toBe('unitdef');
    expect(kindOfPath('a/b.json')).toBeNull();
  });
});

describe('writing', () => {
  it('writes a valid document and reports where it went', () => {
    const result = writeDocument(dir, 'dev/biped.core.cliplib.json', clipLib());
    expect(result.ok).toBe(true);
    expect(result.path).toBe('dev/biped.core.cliplib.json');
    expect(existsSync(join(dir, 'dev', 'biped.core.cliplib.json'))).toBe(true);
  });

  it('round-trips exactly what was sent', () => {
    const doc = clipLib();
    writeDocument(dir, 'dev/biped.core.cliplib.json', doc);
    const read = readDocument(dir, 'dev/biped.core.cliplib.json');
    expect('doc' in read && read.doc).toEqual(doc);
  });

  it('refuses a document that would not validate, and writes nothing', () => {
    // A dragged marker that ended up out of order is the realistic case, and it
    // must not be able to produce a file CI would reject.
    const broken = clipLib({
      clips: [
        {
          id: 'attack',
          source: 'clips/attack.glb',
          durationMs: 900,
          loop: false,
          events: [
            { name: 'swing.impact', normalizedTime: 0.55 },
            { name: 'swing.start', normalizedTime: 0.1 },
          ],
        },
      ],
    });
    const result = writeDocument(dir, 'dev/broken.cliplib.json', broken);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('cliplib.event.order');
    expect(existsSync(join(dir, 'dev', 'broken.cliplib.json'))).toBe(false);
  });

  it('leaves the previous file untouched when the new one is rejected', () => {
    // The failure that would actually hurt: a tuning session that made a
    // document worse and destroyed the good one on the way.
    writeDocument(dir, 'dev/x.cliplib.json', clipLib());
    const before = readFileSync(join(dir, 'dev', 'x.cliplib.json'), 'utf8');
    writeDocument(dir, 'dev/x.cliplib.json', { ...clipLib(), formatVersion: 99 });
    expect(readFileSync(join(dir, 'dev', 'x.cliplib.json'), 'utf8')).toBe(before);
  });

  it('refuses a path it cannot validate rather than writing it unchecked', () => {
    const result = writeDocument(dir, 'dev/notes.json', { anything: true });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('document.kind');
  });

  it('refuses to escape the units directory', () => {
    const result = writeDocument(dir, '../escaped.cliplib.json', clipLib());
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, '..', 'escaped.cliplib.json'))).toBe(false);
  });

  it('leaves no temp file behind', () => {
    // The atomic write is a temp plus a rename; a leftover .tmp would be read by
    // nothing but would show up in a diff and in the listing.
    writeDocument(dir, 'dev/x.cliplib.json', clipLib());
    expect(existsSync(join(dir, 'dev', 'x.cliplib.json.tmp'))).toBe(false);
  });
});

describe('reading', () => {
  it('reports a missing document rather than throwing', () => {
    const result = readDocument(dir, 'dev/nope.cliplib.json');
    expect('error' in result && result.error).toContain('no document');
  });

  it('reports unreadable JSON rather than throwing', () => {
    writeFileSync(join(dir, 'dev', 'bad.cliplib.json'), '{ not json');
    expect('error' in readDocument(dir, 'dev/bad.cliplib.json')).toBe(true);
  });
});

describe('listing', () => {
  it('finds documents in subdirectories, forward-slashed', () => {
    writeDocument(dir, 'dev/x.cliplib.json', clipLib());
    expect(listDocuments(dir)).toContain('dev/x.cliplib.json');
  });

  it('is empty for a directory that does not exist', () => {
    expect(listDocuments(join(dir, 'nowhere'))).toEqual([]);
  });
});
