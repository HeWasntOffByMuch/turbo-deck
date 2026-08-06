import { describe, expect, it } from 'vitest';
import {
  createLayer,
  createWorld,
  exportMap,
  loadMap,
  type ChunkOptions,
  type LoadedMap,
  type Rect,
} from '../../../terrain/index.js';
import { applyTerrainBrush, type BrushSettings } from './brush.js';
import { EditHistory, HISTORY_LIMIT } from './history.js';

/**
 * Spec 050. Undo is the thing that makes a destructive tool usable, so what
 * matters is that one stroke is one entry however many frames it spans, that a
 * restore is exact, and that it reports what it changed so the caller re-meshes
 * exactly that.
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
          features: [
            { kind: 'rolling', amplitude: 18 },
            { kind: 'hill', x: 0, z: 0, radius: 160, edge: 90, height: 100 },
          ],
        }),
      ]),
      props: [],
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    }),
  );
}

const BRUSH: BrushSettings = { tool: 'raise', radius: 80, strength: 200, falloff: 0.7 };

/** Every corner height, materials and tones in the layer, for exact comparison. */
function snapshotAll(map: LoadedMap): { heights: number[]; materials: number[]; tones: number[] } {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  const heights: number[] = [];
  const materials: number[] = [];
  const tones: number[] = [];
  for (let row = 0; row <= layer.grid.totalRows; row++) {
    for (let col = 0; col <= layer.grid.totalCols; col++) heights.push(map.store.cornerHeight(LAYER, col, row));
  }
  for (let row = 0; row < layer.grid.totalRows; row++) {
    for (let col = 0; col < layer.grid.totalCols; col++) {
      const cell = map.store.cellAt(LAYER, col, row);
      materials.push(cell?.materialIndex ?? -1);
      tones.push(cell?.tone ?? -1);
    }
  }
  return { heights, materials, tones };
}

/** Paint one stroke of `frames` steps, capturing into `history` as the view does. */
function paint(map: LoadedMap, history: EditHistory, x: number, z: number, frames = 4, over: Partial<BrushSettings> = {}): void {
  history.beginStroke();
  for (let i = 0; i < frames; i++) {
    applyTerrainBrush(
      map.store,
      { ...BRUSH, ...over },
      {
        layerId: LAYER,
        x,
        z,
        dtSeconds: 0.1,
        flattenTo: 0,
        onTouchChunk: (cx, cz) => history.captureChunk(map.store, LAYER, cx, cz),
      },
    );
  }
  history.endStroke();
}

describe('recording', () => {
  it('records one entry per stroke, however many frames it spans', () => {
    const map = loaded();
    const history = new EditHistory();
    paint(map, history, 0, 0, 30);
    expect(history.depth).toBe(1);
    paint(map, history, 40, 40, 30);
    expect(history.depth).toBe(2);
  });

  it('drops a stroke that touched nothing', () => {
    // A click that missed the terrain must not cost an undo slot.
    const history = new EditHistory();
    history.beginStroke();
    history.endStroke();
    expect(history.depth).toBe(0);
  });

  it('captures a chunk once, on first touch', () => {
    const map = loaded();
    const history = new EditHistory();
    history.beginStroke();
    const before = map.store.cornerHeight(LAYER, 10, 10);
    // Capture, then paint, then capture again: the second must not overwrite
    // the snapshot with the already-edited state.
    history.captureChunk(map.store, LAYER, 1, 1);
    applyTerrainBrush(map.store, BRUSH, { layerId: LAYER, x: 0, z: 0, dtSeconds: 0.5, flattenTo: 0 });
    history.captureChunk(map.store, LAYER, 1, 1);
    history.endStroke();

    history.undo(map.store);
    expect(map.store.cornerHeight(LAYER, 10, 10)).toBeCloseTo(before, 3);
  });

  it('reports whether a stroke is open', () => {
    const history = new EditHistory();
    expect(history.isRecording).toBe(false);
    history.beginStroke();
    expect(history.isRecording).toBe(true);
    history.endStroke();
    expect(history.isRecording).toBe(false);
  });

  it('ignores a capture with no stroke open', () => {
    const map = loaded();
    const history = new EditHistory();
    history.captureChunk(map.store, LAYER, 0, 0);
    history.endStroke();
    expect(history.depth).toBe(0);
  });
});

describe('undo', () => {
  it('restores heights, materials and tones exactly', () => {
    const map = loaded();
    const history = new EditHistory();
    const before = snapshotAll(map);

    // Hard enough to move materials as well as heights.
    paint(map, history, 0, 0, 40, { strength: 500, radius: 60 });
    const after = snapshotAll(map);
    expect(after.heights).not.toEqual(before.heights);
    expect(after.materials).not.toEqual(before.materials);

    history.undo(map.store);
    const restored = snapshotAll(map);
    restored.heights.forEach((h, i) => expect(h).toBe(must(before.heights[i], 'a height')));
    expect(restored.materials).toEqual(before.materials);
    expect(restored.tones).toEqual(before.tones);
  });

  it('returns exactly the chunks it restored', () => {
    const map = loaded();
    const history = new EditHistory();
    paint(map, history, 0, 0);
    const { remeshed: restored } = history.undo(map.store);
    expect(restored.length).toBeGreaterThan(0);
    for (const c of restored) {
      expect(c.layerId).toBe(LAYER);
      expect(map.store.buildChunk(c.layerId, c.cx, c.cz)).not.toBeNull();
    }
    // No duplicates -- the caller re-meshes each one once.
    expect(new Set(restored.map((c) => `${c.cx},${c.cz}`)).size).toBe(restored.length);
  });

  it('unwinds strokes newest first', () => {
    const map = loaded();
    const history = new EditHistory();
    const start = snapshotAll(map).heights;

    paint(map, history, 0, 0);
    const afterFirst = snapshotAll(map).heights;
    paint(map, history, 60, 0);
    expect(snapshotAll(map).heights).not.toEqual(afterFirst);

    history.undo(map.store);
    snapshotAll(map).heights.forEach((h, i) => expect(h).toBeCloseTo(must(afterFirst[i], 'a height'), 5));
    history.undo(map.store);
    snapshotAll(map).heights.forEach((h, i) => expect(h).toBeCloseTo(must(start[i], 'a height'), 5));
    expect(history.depth).toBe(0);
  });

  it('undoes overlapping strokes correctly', () => {
    // Two strokes over the same ground: the second's snapshot holds the state
    // the first left, so unwinding both has to land back at the start.
    const map = loaded();
    const history = new EditHistory();
    const start = snapshotAll(map).heights;
    paint(map, history, 0, 0, 10);
    paint(map, history, 10, 10, 10);
    history.undo(map.store);
    history.undo(map.store);
    snapshotAll(map).heights.forEach((h, i) => expect(h).toBeCloseTo(must(start[i], 'a height'), 5));
  });

  it('is a no-op on an empty stack', () => {
    const map = loaded();
    const history = new EditHistory();
    const before = snapshotAll(map).heights;
    expect(history.undo(map.store).remeshed).toEqual([]);
    expect(snapshotAll(map).heights).toEqual(before);
  });
});

describe('the cap', () => {
  it('keeps the newest strokes and drops the oldest', () => {
    const map = loaded();
    const history = new EditHistory(3);
    const start = snapshotAll(map).heights;
    for (let i = 0; i < 6; i++) paint(map, history, i * 30 - 80, 0, 2);
    expect(history.depth).toBe(3);

    // Unwinding everything still on the stack cannot reach the start, because
    // the earliest strokes were dropped -- that is what a cap means.
    while (history.depth > 0) history.undo(map.store);
    expect(snapshotAll(map).heights).not.toEqual(start);
  });

  it('defaults to twenty', () => {
    const map = loaded();
    const history = new EditHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) paint(map, history, 0, 0, 1);
    expect(history.depth).toBe(HISTORY_LIMIT);
  });
});

describe('clear', () => {
  it('forgets everything, including an open stroke', () => {
    const map = loaded();
    const history = new EditHistory();
    paint(map, history, 0, 0);
    history.beginStroke();
    history.clear();
    expect(history.depth).toBe(0);
    expect(history.isRecording).toBe(false);
    expect(history.undo(map.store).remeshed).toEqual([]);
  });
});
