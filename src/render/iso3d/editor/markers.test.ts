import { describe, expect, it } from 'vitest';
import { Rng } from '../../../shared/prng.js';
import {
  createLayer,
  createWorld,
  exportMap,
  loadMap,
  parseMap,
  serializeMap,
  type ChunkOptions,
  type LoadedMap,
  type MapMarker,
  type Rect,
} from '../../../terrain/index.js';
import { EditHistory } from './history.js';
import { eraseMarkers, nextMarkerId, placeMarker } from './markers.js';
import { DEFAULT_SCATTER, eraseStroke, scatterStroke } from './scatter.js';

/**
 * Spec 052. Markers are the first thing in the editor that carries an *identity*
 * -- a spawn point is referred to by id by whatever reads the map later -- so how
 * ids are chosen matters as much as where the marker lands.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const LAYER = 'ground';
const ARENA = { minX: 0, minZ: 0, maxX: 200, maxZ: 160 };

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

function loaded(markers: readonly MapMarker[] = []): LoadedMap {
  return loadMap(
    exportMap({
      world: createWorld([
        createLayer({
          id: LAYER,
          bounds: BOUNDS,
          baseY: -100,
          waterLevel: null,
          seed: 7,
          features: [{ kind: 'rolling', amplitude: 10 }],
        }),
      ]),
      props: [],
      seed: 7,
      arena: ARENA,
      options: OPT,
      ...(markers.length > 0 ? { markers } : {}),
    }),
  );
}

describe('nextMarkerId', () => {
  const marker = (kind: MapMarker['kind'], id: string): MapMarker => ({ kind, id, x: 0, z: 0 });

  it('starts at one', () => {
    expect(nextMarkerId([], 'spawn')).toBe('spawn-1');
  });

  it('takes the lowest free number, not one past the highest', () => {
    // So deleting spawn-2 and placing again reuses it rather than climbing.
    const existing = [marker('spawn', 'spawn-1'), marker('spawn', 'spawn-3')];
    expect(nextMarkerId(existing, 'spawn')).toBe('spawn-2');
  });

  it('counts each kind separately', () => {
    const existing = [marker('spawn', 'spawn-1'), marker('spawn', 'spawn-2')];
    expect(nextMarkerId(existing, 'campfire')).toBe('campfire-1');
    expect(nextMarkerId(existing, 'spawn')).toBe('spawn-3');
  });

  it('ignores ids that do not follow the pattern', () => {
    const existing = [marker('spawn', 'hand-written'), marker('spawn', 'spawn-1')];
    expect(nextMarkerId(existing, 'spawn')).toBe('spawn-2');
  });
});

describe('placing', () => {
  it('lands at the world point it was given', () => {
    const map = loaded();
    const { marker } = placeMarker(map.store, LAYER, 'spawn', 120, -40);
    expect(marker).not.toBeNull();
    const stored = must(map.store.markers(LAYER)[0], 'the placed marker');
    expect(stored.x).toBeCloseTo(120, 6);
    expect(stored.z).toBeCloseTo(-40, 6);
    expect(stored.kind).toBe('spawn');
    expect(stored.id).toBe('spawn-1');
  });

  it('files it in the chunk that contains it, exactly once', () => {
    const map = loaded();
    // Right on the corner where four chunks meet.
    const seam = BOUNDS.minX + OPT.cellSize * OPT.chunkCells;
    placeMarker(map.store, LAYER, 'objective', seam, seam);
    expect(map.store.markers(LAYER)).toHaveLength(1);
    expect(map.store.markersWithin(LAYER, seam, seam, 5)).toHaveLength(1);
  });

  it('reports the chunk it touched, before touching it', () => {
    const map = loaded();
    const seen: string[] = [];
    const { dirty } = placeMarker(map.store, LAYER, 'spawn', 60, 60, (cx, cz) => {
      // The store must not hold the marker yet when the callback fires.
      expect(map.store.markers(LAYER)).toHaveLength(0);
      seen.push(`${cx},${cz}`);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(dirty.length).toBe(1);
  });

  it('places nothing outside the layer', () => {
    const map = loaded();
    expect(placeMarker(map.store, LAYER, 'spawn', 9999, 0).marker).toBeNull();
    expect(placeMarker(map.store, LAYER, 'spawn', NaN, 0).marker).toBeNull();
    expect(map.store.markers(LAYER)).toHaveLength(0);
  });

  it('numbers repeated placements', () => {
    const map = loaded();
    placeMarker(map.store, LAYER, 'spawn', 0, 0);
    placeMarker(map.store, LAYER, 'spawn', 60, 0);
    placeMarker(map.store, LAYER, 'campfire', -60, 0);
    expect(map.store.markers(LAYER).map((m) => m.id).sort()).toEqual(['campfire-1', 'spawn-1', 'spawn-2']);
  });
});

describe('the document round trip', () => {
  it('returns markers to their world positions, with kind, id and label', () => {
    const map = loaded([
      { kind: 'spawn', id: 'spawn-1', x: 100, z: 80, label: 'start' },
      { kind: 'campfire', id: 'campfire-1', x: -150, z: -120 },
    ]);
    const reloaded = loadMap(
      parseMap(
        serializeMap(
          exportMap({
            world: map.world,
            props: [],
            seed: 7,
            arena: ARENA,
            options: OPT,
            markers: map.store.markers(LAYER),
          }),
        ),
      ),
    );
    const back = reloaded.store.markers(LAYER);
    expect(back).toHaveLength(2);
    const spawn = must(back.find((m) => m.id === 'spawn-1'), 'the spawn');
    expect(spawn.x).toBeCloseTo(100, 3);
    expect(spawn.z).toBeCloseTo(80, 3);
    expect(spawn.label).toBe('start');
    const fire = must(back.find((m) => m.id === 'campfire-1'), 'the campfire');
    expect(fire.x).toBeCloseTo(-150, 3);
    expect(fire.kind).toBe('campfire');
  });

  it('survives a placement made through the store', () => {
    const map = loaded();
    placeMarker(map.store, LAYER, 'trigger', 40, -90);
    const text = serializeMap(map.store.toDocument());
    const back = loadMap(parseMap(text)).store.markers(LAYER);
    expect(back).toHaveLength(1);
    expect(must(back[0], 'the marker').x).toBeCloseTo(40, 3);
    expect(must(back[0], 'the marker').z).toBeCloseTo(-90, 3);
  });

  it('is a fixed point, as every other part of the document is', () => {
    const map = loaded([{ kind: 'spawn', id: 'spawn-1', x: 100, z: 80 }]);
    const text = serializeMap(map.store.toDocument());
    expect(serializeMap(loadMap(parseMap(text)).store.toDocument())).toBe(text);
  });
});

describe('erasing markers', () => {
  it('removes those inside the radius and no others', () => {
    const map = loaded();
    placeMarker(map.store, LAYER, 'spawn', 0, 0);
    placeMarker(map.store, LAYER, 'spawn', 40, 0);
    placeMarker(map.store, LAYER, 'spawn', 200, 0);

    const { removed } = eraseMarkers(map.store, LAYER, { x: 0, z: 0, radius: 60 });
    expect(removed).toHaveLength(2);
    const left = map.store.markers(LAYER);
    expect(left).toHaveLength(1);
    expect(must(left[0], 'the survivor').x).toBeCloseTo(200, 6);
  });

  it('does nothing on empty ground or a degenerate radius', () => {
    const map = loaded();
    placeMarker(map.store, LAYER, 'spawn', 0, 0);
    expect(eraseMarkers(map.store, LAYER, { x: 250, z: 180, radius: 20 }).removed).toHaveLength(0);
    expect(eraseMarkers(map.store, LAYER, { x: 0, z: 0, radius: 0 }).removed).toHaveLength(0);
    expect(eraseMarkers(map.store, LAYER, { x: NaN, z: 0, radius: 50 }).removed).toHaveLength(0);
    expect(map.store.markers(LAYER)).toHaveLength(1);
  });

  it('frees the id for reuse', () => {
    const map = loaded();
    placeMarker(map.store, LAYER, 'spawn', 0, 0);
    placeMarker(map.store, LAYER, 'spawn', 100, 0);
    eraseMarkers(map.store, LAYER, { x: 0, z: 0, radius: 30 });
    // spawn-1 is free again, so the next placement takes it back.
    placeMarker(map.store, LAYER, 'spawn', -100, 0);
    expect(map.store.markers(LAYER).map((m) => m.id).sort()).toEqual(['spawn-1', 'spawn-2']);
  });
});

describe('undo', () => {
  it('takes back one placement', () => {
    const map = loaded();
    const history = new EditHistory();
    history.beginStroke();
    placeMarker(map.store, LAYER, 'spawn', 50, 50, (cx, cz) => history.captureChunk(map.store, LAYER, cx, cz));
    history.endStroke();

    expect(map.store.markers(LAYER)).toHaveLength(1);
    expect(history.depth).toBe(1);
    history.undo(map.store);
    expect(map.store.markers(LAYER)).toHaveLength(0);
  });

  it('brings an erased marker back with its id', () => {
    const map = loaded();
    placeMarker(map.store, LAYER, 'objective', 30, -30);
    const history = new EditHistory();

    history.beginStroke();
    eraseMarkers(map.store, LAYER, { x: 30, z: -30, radius: 50 }, (cx, cz) =>
      history.captureChunk(map.store, LAYER, cx, cz),
    );
    history.endStroke();
    expect(map.store.markers(LAYER)).toHaveLength(0);

    history.undo(map.store);
    const back = map.store.markers(LAYER);
    expect(back).toHaveLength(1);
    expect(must(back[0], 'the marker').id).toBe('objective-1');
    expect(must(back[0], 'the marker').kind).toBe('objective');
  });

  it('restores props and markers erased in the same stroke', () => {
    // The eraser takes everything under it, so undo has to give everything back.
    const map = loaded();
    scatterStroke(
      map.store,
      LAYER,
      { ...DEFAULT_SCATTER, density: 30, spacing: 10 },
      { x: 0, z: 0, radius: 120, dtSeconds: 2, carry: 0 },
      Rng.fromSeed(2),
    );
    placeMarker(map.store, LAYER, 'campfire', 0, 0);
    const props = map.store.props(LAYER).length;
    expect(props).toBeGreaterThan(2);

    const history = new EditHistory();
    const capture = (cx: number, cz: number): void => history.captureChunk(map.store, LAYER, cx, cz);
    history.beginStroke();
    const circle = { x: 0, z: 0, radius: 90 };
    eraseStroke(map.store, LAYER, circle, capture);
    eraseMarkers(map.store, LAYER, circle, capture);
    history.endStroke();

    expect(map.store.markers(LAYER)).toHaveLength(0);
    expect(map.store.props(LAYER).length).toBeLessThan(props);

    history.undo(map.store);
    expect(map.store.markers(LAYER)).toHaveLength(1);
    expect(map.store.props(LAYER)).toHaveLength(props);
  });
});
