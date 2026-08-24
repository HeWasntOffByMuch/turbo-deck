import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMap, serializeMap } from '../../../terrain/index.js';
import { MAP_WRITE_ENDPOINT, writeMapToDisk, type FetchLike } from './map-write.js';
import { resolveMapWrite, writeMapFile } from '../../../../scripts/dev-map-write.js';
import { joinMap, MANIFEST_PATH, parseManifest, regionPath } from '../../../terrain/regions.js';
import { bakeEditorMap } from './map-source.js';
import { addRock, nextRockLayerId } from './rock.js';
import { EditHistory } from './history.js';

/**
 * Spec 177. Two halves of one loop, tested from both ends.
 *
 * The browser half has to tell "there is no dev server here" apart from "the
 * dev server said no" apart from "nothing answered", because the fix differs
 * every time and a single "save failed" sends you looking in the wrong place --
 * which is the whole reason this feature exists.
 *
 * The disk half has to refuse anything that is not a map file directly inside
 * `maps/`, and has to refuse a body that will not parse, because what it is
 * writing over is the file the server boots from.
 */

const reply = (status: number, body = ''): { ok: boolean; status: number; text(): Promise<string> } => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body),
});

describe('asking the dev server to write the map', () => {
  it('reports what was written', async () => {
    const seen: string[] = [];
    const fetchLike: FetchLike = (input, init) => {
      seen.push(`${init.method} ${input}`);
      return Promise.resolve(reply(200, 'wrote maps/arena.json (12 bytes)'));
    };
    const result = await writeMapToDisk(fetchLike, 'arena.json', '{}');
    expect(result.kind).toBe('written');
    expect(result.detail).toContain('arena.json');
    expect(seen).toEqual([`POST ${MAP_WRITE_ENDPOINT}?name=arena.json`]);
  });

  it('treats a missing endpoint as "not here", not as a failure', async () => {
    // What a built page and `vite preview` answer. The remedy is the download,
    // and the message has to say so rather than reading as a broken save.
    const result = await writeMapToDisk(() => Promise.resolve(reply(404)), 'arena.json', '{}');
    expect(result.kind).toBe('unavailable');
    expect(result.detail).toMatch(/Save to file/);
  });

  it('passes a refusal through in the server\'s own words', async () => {
    const result = await writeMapToDisk(
      () => Promise.resolve(reply(400, '"../secrets.json" is not a bare filename')),
      '../secrets.json',
      '{}',
    );
    expect(result.kind).toBe('refused');
    expect(result.detail).toContain('not a bare filename');
  });

  it('separates a server error from a refusal', async () => {
    const result = await writeMapToDisk(() => Promise.resolve(reply(500, 'EACCES')), 'arena.json', '{}');
    expect(result.kind).toBe('offline');
  });

  it('survives the fetch itself throwing', async () => {
    const result = await writeMapToDisk(() => Promise.reject(new Error('network down')), 'arena.json', '{}');
    expect(result.kind).toBe('offline');
    expect(result.detail).toContain('network down');
  });

  it('escapes the name it asks for', async () => {
    const seen: string[] = [];
    await writeMapToDisk(
      (input) => {
        seen.push(input);
        return Promise.resolve(reply(200));
      },
      'a b&c.json',
      '{}',
    );
    expect(seen[0]).toBe(`${MAP_WRITE_ENDPOINT}?name=a%20b%26c.json`);
  });
});

describe('what the dev server will write', () => {
  const root = '/repo';

  it('accepts a bare .json name, under maps/', () => {
    expect(resolveMapWrite('arena.json', root)).toEqual({ path: join(root, 'maps', 'arena.json') });
  });

  it.each([
    ['', 'no name'],
    ['..', 'the parent directory'],
    ['../package.json', 'a path out of maps/'],
    ['sub/arena.json', 'a path into a subdirectory'],
    ['/etc/passwd', 'an absolute path'],
    ['..\\arena.json', 'a windows-style escape'],
    ['arena.txt', 'not a map document'],
    ['arena.json\0.txt', 'a null byte'],
  ])('refuses %j (%s)', (name) => {
    expect(resolveMapWrite(name, root)).toHaveProperty('refusal');
  });

  it('refuses a name that would land beside maps/ rather than in it', () => {
    // The resolved-parent check, not the string one: `maps-elsewhere` shares a
    // prefix with `maps` and a prefix test would let it through.
    expect(resolveMapWrite('../maps-elsewhere/arena.json', root)).toHaveProperty('refusal');
  });
});

describe('writing the file', () => {
  const seeded = (): { root: string; text: string } => {
    const root = mkdtempSync(join(tmpdir(), 'map-write-'));
    mkdirSync(join(root, 'maps'), { recursive: true });
    return { root, text: serializeMap(bakeEditorMap(1234).document) };
  };

  /** The world as it now stands on disk under `maps/arena/`. */
  const readBack = (root: string): string =>
    serializeMap(
      joinMap(parseManifest(readFileSync(join(root, 'maps', 'arena', MANIFEST_PATH), 'utf8')), (region) =>
        readFileSync(join(root, 'maps', 'arena', region), 'utf8'),
      ),
    );

  it('writes a real map document, as a manifest and its regions', () => {
    // The name on the wire is still `arena.json` -- it is what a download is
    // called -- and what lands is `maps/arena/` (spec 204).
    const { root, text } = seeded();
    const result = writeMapFile('arena.json', text, root);
    expect(result.ok).toBe(true);
    expect(readBack(root)).toBe(text);
  });

  it('commits the manifest last, so a region is only ever reachable once it is whole', () => {
    const { root, text } = seeded();
    writeMapFile('arena.json', text, root);
    const manifest = parseManifest(readFileSync(join(root, 'maps', 'arena', MANIFEST_PATH), 'utf8'));
    // Every region the manifest names is on disk. That is the invariant the
    // ordering buys: the manifest is the only thing that makes a region
    // reachable, so if it is there, they are.
    for (const layer of manifest.layers) {
      for (const entry of layer.regions) {
        expect(() =>
          readFileSync(join(root, 'maps', 'arena', regionPath(entry.rx, entry.rz)), 'utf8'),
        ).not.toThrow();
      }
    }
  });

  it('refuses a body that is not a map, leaving what was there alone', () => {
    const { root, text } = seeded();
    writeMapFile('arena.json', text, root);
    // A truncated save is the realistic accident, and dropping it on top of the
    // map the server boots from would take the world down with it. Refused
    // before a single byte is written, since the parse happens first.
    const result = writeMapFile('arena.json', text.slice(0, text.length / 2), root);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not a map document/);
    expect(readBack(root)).toBe(text);
  });

  it('refuses to write outside maps/, whatever is already there', () => {
    const { root, text } = seeded();
    writeFileSync(join(root, 'package.json'), '{"name":"real"}');
    const result = writeMapFile('../package.json', text, root);
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{"name":"real"}');
  });
});

describe('a map the editor made, over a map that is already there', () => {
  /** A repo root with a written map already in it, and the text that made it. */
  const already = (): { root: string; text: string } => {
    const root = mkdtempSync(join(tmpdir(), 'map-write-tier-'));
    mkdirSync(join(root, 'maps'), { recursive: true });
    const text = serializeMap(bakeEditorMap(1234).document);
    expect(writeMapFile('arena.json', text, root).ok).toBe(true);
    return { root, text };
  };

  const readBack = (root: string): ReturnType<typeof joinMap> =>
    joinMap(parseManifest(readFileSync(join(root, 'maps', 'arena', MANIFEST_PATH), 'utf8')), (region) =>
      readFileSync(join(root, 'maps', 'arena', region), 'utf8'),
    );

  it('writes a rock tier, and reads it back as two layers (spec 219)', () => {
    // The editor's own tool, not a hand-built document: `addRock` adds a layer,
    // and until spec 219 the split refused every map that had one. From the
    // panel that was "Save to maps/" answering `not a map document`, with the
    // map unsaveable until the tier was undone.
    const { root } = already();
    const store = loadMap(bakeEditorMap(1234).document).store;
    const ground = store.layerInfo('ground') ?? store.layerInfo(store.layerIds[0] ?? '');
    if (!ground) throw new Error('no ground layer');
    const cx = (ground.bounds.minX + ground.bounds.maxX) / 2;
    const cz = (ground.bounds.minZ + ground.bounds.maxZ) / 2;
    const tierId = nextRockLayerId(store);
    const baked = addRock(store, new EditHistory(), {
      layerId: tierId,
      seed: 7,
      origin: ground.origin,
      baseY: ground.baseY,
      top: ground.baseY + 300,
      footprint: { minX: cx - 300, minZ: cz - 300, maxX: cx + 300, maxZ: cz + 300 },
      propLayerId: ground.id,
    });
    expect(baked.ok).toBe(true);
    expect(store.layerIds).toContain(tierId);

    const result = writeMapFile('arena.json', serializeMap(store.toDocument()), root);
    expect(result.ok).toBe(true);

    const back = readBack(root);
    expect(back.layers.map((l) => l.id)).toEqual(store.layerIds);
    const tier = back.layers.find((l) => l.id === tierId);
    expect(tier?.chunks.length).toBeGreaterThan(0);
    // The whole document, not merely both layer names: a region shared by the
    // ground and the tier has to hand each of them its own chunks back.
    expect(serializeMap(back)).toBe(serializeMap(store.toDocument()));
  });

  it('leaves every region the manifest names on disk, and sweeps the rest', () => {
    // `writeSplit`'s sweep, over a map that already exists -- the case the
    // seeded tests above never reach, and the one where getting staleness
    // wrong costs the whole map rather than a stray file.
    const { root } = already();
    const dir = join(root, 'maps', 'arena');
    // A file nothing reaches, of the shape an interrupted write leaves.
    writeFileSync(join(dir, 'r', '999_999.json.tmp'), 'not a region', 'utf8');

    const store = loadMap(bakeEditorMap(1234).document).store;
    const layerId = store.layerIds[0] ?? 'ground';
    const info = store.layerInfo(layerId);
    if (!info) throw new Error('no layer');
    store.setCornerHeight(layerId, 4, 4, (store.cornerHeight(layerId, 4, 4) ?? 0) + 40);
    expect(writeMapFile('arena.json', serializeMap(store.toDocument()), root).ok).toBe(true);

    const manifest = parseManifest(readFileSync(join(dir, MANIFEST_PATH), 'utf8'));
    for (const layer of manifest.layers) {
      for (const entry of layer.regions) {
        expect(() => readFileSync(join(dir, regionPath(entry.rx, entry.rz)), 'utf8')).not.toThrow();
      }
    }
    expect(() => readFileSync(join(dir, 'r', '999_999.json.tmp'), 'utf8')).toThrow();
    // And the map still loads, which is the thing a wrong sweep takes away.
    expect(readBack(root).layers[0]?.chunks.length).toBeGreaterThan(0);
  });
});
