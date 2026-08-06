import { describe, expect, it } from 'vitest';
import { Rng } from '../../../shared/prng.js';
import {
  createLayer,
  createWorld,
  exportMap,
  loadMap,
  parseMap,
  quantize,
  serializeMap,
  type ChunkOptions,
  type LoadedMap,
  type Rect,
} from '../../../terrain/index.js';
import { applyTerrainBrush } from './brush.js';
import { placeMarker } from './markers.js';
import { bakeLayerNav } from './nav.js';
import {
  AUTOSAVE_KEY,
  clearAutosave,
  mapFilename,
  mapText,
  readAutosave,
  RevisionTracker,
  writeAutosave,
  type StorageLike,
} from './persistence.js';
import { DEFAULT_SCATTER, scatterStroke } from './scatter.js';

/**
 * Spec 054. The interesting cases here are all failures: a browser that refuses
 * to store, a slot left half-written by a killed tab, a file that is not a map.
 * None of them may take the editor down, because the map is still in memory and
 * still savable to a file.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const LAYER = 'ground';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

function loaded(): LoadedMap {
  return loadMap(
    exportMap({
      world: createWorld([
        createLayer({
          id: LAYER,
          bounds: BOUNDS,
          baseY: -100,
          waterLevel: -40,
          seed: 7,
          features: [{ kind: 'rolling', amplitude: 14 }],
        }),
      ]),
      props: [],
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    }),
  );
}

/** A `Storage` that works, backed by a Map. */
function fakeStorage(): StorageLike & { readonly slots: Map<string, string> } {
  const slots = new Map<string, string>();
  return {
    slots,
    getItem: (k) => slots.get(k) ?? null,
    setItem: (k, v) => void slots.set(k, v),
    removeItem: (k) => void slots.delete(k),
  };
}

/** A `Storage` that refuses, the way a full origin or private mode does. */
function refusingStorage(message: string): StorageLike {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error(message);
    },
    removeItem: () => undefined,
  };
}

describe('the autosave slot', () => {
  it('round-trips a document', () => {
    const storage = fakeStorage();
    const map = loaded();
    const text = mapText(map.store.toDocument());
    expect(writeAutosave(storage, text).ok).toBe(true);

    const back = must(readAutosave(storage), 'the restored document');
    expect(serializeMap(back)).toBe(text);
    expect(storage.slots.has(AUTOSAVE_KEY)).toBe(true);
  });

  it('reads back null when there is nothing there', () => {
    expect(readAutosave(fakeStorage())).toBeNull();
  });

  it('discards a slot that is not a map rather than throwing', () => {
    // A tab killed mid-write leaves exactly this, and it must not brick the
    // next tab that opens.
    for (const junk of ['', 'not json at all', '{}', '{"version":99}', '{"version":1}']) {
      const storage = fakeStorage();
      storage.setItem(AUTOSAVE_KEY, junk);
      expect(readAutosave(storage)).toBeNull();
    }
  });

  it('discards a truncated document', () => {
    const storage = fakeStorage();
    const text = mapText(loaded().store.toDocument());
    storage.setItem(AUTOSAVE_KEY, text.slice(0, Math.floor(text.length / 2)));
    expect(readAutosave(storage)).toBeNull();
  });

  it('reports a refused write instead of throwing', () => {
    const result = writeAutosave(refusingStorage('QuotaExceededError: quota reached'), 'anything');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('storage full');
  });

  it('reports a browser with storage switched off', () => {
    const result = writeAutosave(refusingStorage('Access is denied'), 'anything');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Access is denied');
  });

  it('survives a storage that throws on read', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(readAutosave(storage)).toBeNull();
  });

  it('clears, and never throws doing it', () => {
    const storage = fakeStorage();
    storage.setItem(AUTOSAVE_KEY, 'x');
    clearAutosave(storage);
    expect(storage.slots.has(AUTOSAVE_KEY)).toBe(false);
    expect(() => clearAutosave(refusingStorage('no'))).not.toThrow();
  });
});

describe('the filename', () => {
  it('names the seed and ends in .json, stably', () => {
    const doc = loaded().store.toDocument();
    expect(mapFilename(doc)).toBe('map-7.json');
    expect(mapFilename(doc)).toBe(mapFilename(doc));
  });

  it('handles a clock-derived seed without producing a negative name', () => {
    const doc = { ...loaded().store.toDocument(), seed: -12345 };
    expect(mapFilename(doc)).toMatch(/^map-\d+\.json$/);
  });
});

describe('revision tracking', () => {
  it('starts dirty, so an unsaved map is saved once', () => {
    expect(new RevisionTracker().isDirty).toBe(true);
  });

  it('goes clean on save and dirty again on a change', () => {
    const rev = new RevisionTracker();
    rev.markSaved();
    expect(rev.isDirty).toBe(false);
    rev.touch();
    expect(rev.isDirty).toBe(true);
    rev.markSaved();
    expect(rev.isDirty).toBe(false);
  });

  it('does not lose a change made while a save was being written', () => {
    // The counter, not a boolean: touch-then-markSaved on the *older* revision
    // must not mark the newer state clean.
    const rev = new RevisionTracker();
    rev.markSaved();
    rev.touch();
    expect(rev.isDirty).toBe(true);
    rev.touch();
    rev.markSaved();
    expect(rev.isDirty).toBe(false);
  });

  it('resets to clean on a load', () => {
    const rev = new RevisionTracker();
    rev.touch();
    rev.touch();
    rev.reset();
    expect(rev.isDirty).toBe(false);
  });
});

describe('a round trip through the whole editor', () => {
  it('brings back the ground, the props and the markers that were authored', () => {
    const map = loaded();

    // Sculpt.
    for (let i = 0; i < 20; i++) {
      applyTerrainBrush(
        map.store,
        { tool: 'raise', radius: 90, strength: 300, falloff: 0.7 },
        { layerId: LAYER, x: 0, z: 0, dtSeconds: 0.1, flattenTo: 0 },
      );
    }
    // Scatter.
    scatterStroke(
      map.store,
      LAYER,
      { ...DEFAULT_SCATTER, density: 30, spacing: 10 },
      { x: 100, z: 60, radius: 90, dtSeconds: 2, carry: 0 },
      Rng.fromSeed(9),
    );
    // Mark.
    placeMarker(map.store, LAYER, 'spawn', -60, 40);
    placeMarker(map.store, LAYER, 'campfire', 120, -80);
    bakeLayerNav(map.store, LAYER);

    // Compared at the document's own precision. The live store holds the
    // brush's full-precision result; the file holds it quantised to 1e-3, which
    // is the format's stated resolution and not a discrepancy.
    const heights = (m: LoadedMap): number[] => {
      const layer = must(m.store.layerInfo(LAYER), 'the layer');
      const out: number[] = [];
      for (let row = 0; row <= layer.grid.totalRows; row++) {
        for (let col = 0; col <= layer.grid.totalCols; col++) {
          out.push(quantize(m.store.cornerHeight(LAYER, col, row)));
        }
      }
      return out;
    };

    const text = mapText(map.store.toDocument());
    const storage = fakeStorage();
    expect(writeAutosave(storage, text).ok).toBe(true);
    const restored = loadMap(must(readAutosave(storage), 'the restored document'));

    expect(heights(restored)).toEqual(heights(map));
    expect(restored.store.props(LAYER)).toHaveLength(map.store.props(LAYER).length);
    expect(restored.store.markers(LAYER).map((m) => m.id).sort()).toEqual(
      map.store.markers(LAYER).map((m) => m.id).sort(),
    );
    expect(restored.store.chunkNav(LAYER, 0, 0)).not.toBeNull();
    // ...and saving the restored map produces the identical file.
    expect(mapText(restored.store.toDocument())).toBe(text);
  });

  it('rejects a file that is not a map without changing anything', () => {
    const map = loaded();
    const before = mapText(map.store.toDocument());
    expect(() => parseMap('{"version": 99}')).toThrow(/unsupported version/);
    expect(mapText(map.store.toDocument())).toBe(before);
  });
});
