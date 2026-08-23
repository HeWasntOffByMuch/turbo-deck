/**
 * The trees a client stops drawing (spec 215).
 *
 * The measurement this exists for: driving the real cache, the real
 * `StreamedMap` and the real `ChunkIngest` around the shipped map with spec
 * 208's terrain eviction on throughout, the prop field was left drawing **72
 * regions against 4 with ground under them** -- 1,124 `InstancedMesh` objects
 * against 80, every one of them shadow-casting, over 24 chunks of terrain. It
 * stopped at 72 for spec 208's own reason one level up: the map has 72 regions
 * and the walk had been through all of them.
 *
 * The field is modelled here as the set of region keys it is drawing, which is
 * exactly what `heldRegions()` hands the drop pass -- the meshes themselves are
 * asserted in `prop-instances.test.ts`, and building 99,616 instances to count
 * strings would make this test a minute long and no sharper.
 */

import { describe, expect, it } from 'vitest';

import { loadMapFile } from '../../../server/world/map-file.js';
import { buildWorldFromMap } from '../../../server/world/build.js';
import { infoFromIndex } from '../../../server/world/tiled-map.js';
import { MAP_CHUNK_KEEP_RADIUS, MAP_CHUNK_REQUEST_RADIUS } from '../../../server/config.js';
import { ChunkDeniedReason } from '../../../server/net/protocol.js';
import type { MapChunkMessage, MapInfoMessage } from '../../../server/net/map-messages.js';
import { MapChunkCache } from '../../../server/client/map-cache.js';
import { StreamedMap } from '../../../server/client/streamed-map.js';
import { propRegionBounds, propRegionKey, propRegionKeysIn, propRegionSize } from '../props.js';
import { ChunkIngest } from './chunk-ingest.js';
import { orphanedPropRegions, propRegionHasGround } from './prop-residency.js';

const LOADED = loadMapFile();
const BUILT = buildWorldFromMap(LOADED.doc, LOADED.mapId);
const INFO = infoFromIndex(BUILT.index) as MapInfoMessage;
const LAYER0 = LOADED.doc.layers[0];
if (!LAYER0) throw new Error('no layer');
const LAYER = LAYER0;
const EXTENT = LOADED.doc.grid.cellSize * LOADED.doc.grid.chunkCells;
const BY_COORD = new Map(LAYER.chunks.map((c) => [`${String(c.cx)},${String(c.cz)}`, c]));

/** World position of a chunk's middle. */
function at(cx: number, cz: number): { x: number; z: number } {
  return { x: LAYER.origin.x + (cx + 0.5) * EXTENT, z: LAYER.origin.z + (cz + 0.5) * EXTENT };
}

/** The world rectangle a chunk covers. */
function rectOf(cx: number, cz: number): { minX: number; minZ: number; maxX: number; maxZ: number } {
  return {
    minX: LAYER.origin.x + cx * EXTENT,
    minZ: LAYER.origin.z + cz * EXTENT,
    maxX: LAYER.origin.x + (cx + 1) * EXTENT,
    maxZ: LAYER.origin.z + (cz + 1) * EXTENT,
  };
}

/**
 * A client, a server that answers everything, and a prop field modelled as the
 * keys it is drawing -- `view.ts`'s frame, with the pieces that need a canvas
 * left out and every rule that decides residency left in.
 */
function client(options: { dropping: boolean }) {
  const cache = new MapChunkCache(INFO);
  const streamed = new StreamedMap(INFO);
  const ingest = new ChunkIngest({
    settleMs: 250,
    regionSize: propRegionSize(),
    incompleteHoldMs: 1500,
    regionsPerFlush: 64,
    meshTimeoutMs: 30_000,
  });
  /** Regions with batches on the scene graph. What `heldRegions()` answers. */
  const drawn = new Set<string>();
  let now = 0;
  let dropped: string[] = [];
  let adopted = 0;
  let forgotten = 0;
  /** Regions the settle handed back with no ground under them. */
  let refused = 0;

  const holds = (rect: { minX: number; minZ: number; maxX: number; maxZ: number }): boolean =>
    streamed.holdsAnyIn(rect);

  /** The eviction half of a frame: forget the ground, then the trees on it. */
  const evict = (x: number, z: number): void => {
    const gone = cache.evictBeyond(x, z, MAP_CHUNK_KEEP_RADIUS);
    if (gone.length === 0) {
      dropped = [];
      return;
    }
    const { restitch } = streamed.remove(gone);
    // Offered *and* completed: dropping a chunk leaves the four beside it
    // stitched to ground that has gone, and the worker meshes them and hands
    // them straight back. Left merely offered they sit in the queue forever,
    // and a queued chunk holds its regions in flight -- which is a stall in the
    // harness rather than in the client, and reads as trees that never appear.
    if (restitch.length > 0) {
      ingest.offer(restitch, now);
      for (const ref of restitch) ingest.complete(ref.layer, ref.cx, ref.cz, now);
    }
    if (!options.dropping) {
      dropped = [];
      return;
    }
    dropped = [...orphanedPropRegions([...drawn], holds)];
    for (const key of dropped) drawn.delete(key);
    forgotten += ingest.forgetRegions((key) => !propRegionHasGround(key, holds));
  };

  /** The streaming half: ask, be served, insert, mesh. */
  const stream = (x: number, z: number): void => {
    for (let pass = 0; pass < 30; pass++) {
      const want = cache.wanted(x, z, MAP_CHUNK_REQUEST_RADIUS, 64, now);
      if (want.length === 0) return;
      for (const req of want) {
        cache.markRequested(req, now);
        const doc = BY_COORD.get(`${String(req.cx)},${String(req.cz)}`);
        if (!doc) {
          cache.deny(req.layer, req.cx, req.cz, ChunkDeniedReason.Unknown);
          continue;
        }
        const msg = { mapId: INFO.mapId, layer: req.layer, chunk: doc } as MapChunkMessage;
        if (!cache.accept(msg)) continue;
        const dirty = streamed.add({ layer: req.layer, cx: req.cx, cz: req.cz, chunk: doc });
        ingest.offer(dirty, now);
        for (const ref of dirty) ingest.complete(ref.layer, ref.cx, ref.cz, now);
      }
    }
  };

  /**
   * The settle: which regions are owed a compose, sent off to be composed.
   *
   * A queue rather than a return value because the compose happens on another
   * thread -- a region is asked for on one frame and hung on the graph on a
   * later one, and that gap is a thing the rules have to survive.
   */
  const inbox: string[] = [];
  const request = (): readonly string[] => {
    now += 2000;
    const rects = ingest.takePropRects(now, 64, (rect) => streamed.rectCovered(rect));
    const keys = rects.map((rect) => propRegionKey(rect.minX, rect.minZ));
    inbox.push(...keys);
    return keys;
  };

  /** What came back, hung on the graph -- unless its ground went meanwhile. */
  const adopt = (): void => {
    for (const key of inbox.splice(0)) {
      if (!propRegionHasGround(key, holds)) {
        refused++;
        if (options.dropping) continue;
      }
      adopted++;
      drawn.add(key);
    }
  };

  const settle = (): readonly string[] => {
    const asked = request();
    adopt();
    return asked;
  };

  /** One frame's worth, in the order `view.ts` does it: forget, ask, draw. */
  const step = (x: number, z: number): void => {
    now += 50;
    evict(x, z);
    stream(x, z);
    settle();
  };

  const visit = (cx: number, cz: number): void => {
    const p = at(cx, cz);
    step(p.x, p.z);
  };

  return {
    cache,
    streamed,
    ingest,
    drawn,
    holds,
    step,
    visit,
    settle,
    request,
    adopt,
    evict,
    stream,
    dropped: () => dropped,
    adoptedCount: () => adopted,
    forgottenCount: () => forgotten,
    refusedCount: () => refused,
    at: () => now,
  };
}

/** Every region with a held chunk under it -- what the field should be drawing. */
function regionsWithGround(c: ReturnType<typeof client>): Set<string> {
  const live = new Set<string>();
  for (const ref of c.streamed.heldRefs()) {
    for (const key of propRegionKeysIn(rectOf(ref.cx, ref.cz))) live.add(key);
  }
  return live;
}

/**
 * The whole invariant, in one assertion: **the field draws the regions the
 * ground justifies, and only those.**
 *
 * Both directions matter and each catches a different wrong rule. A field that
 * never dropped anything fails the first; a field that dropped the regions of
 * every chunk that went -- which is the rule you write if you reach for the
 * eviction rather than for the residency -- fails the second, because a region
 * spans about four chunks and loses one of them on nearly every step while its
 * trees must stay drawn.
 *
 * Read off the held chunks rather than off `orphanedPropRegions`, or it would
 * be the rule asserting itself.
 */
function expectFieldMatchesGround(c: ReturnType<typeof client>): void {
  const live = regionsWithGround(c);
  expect([...c.drawn].sort()).toEqual([...live].sort());
}

describe('what a walk leaves drawn', () => {
  /** A lap of the map's perimeter, three times over. */
  function circuit(dropping: boolean): ReturnType<typeof client> {
    const c = client({ dropping });
    for (let lap = 0; lap < 3; lap++) {
      for (let cx = -10; cx <= 17; cx++) c.visit(cx, -10);
      for (let cz = -10; cz <= 14; cz++) c.visit(17, cz);
      for (let cx = 17; cx >= -10; cx--) c.visit(cx, 14);
      for (let cz = 14; cz >= -10; cz--) c.visit(-10, cz);
    }
    return c;
  }

  /** An explorer rather than a circler: a lawnmower over the whole map. */
  function lawnmower(dropping: boolean): ReturnType<typeof client> {
    const c = client({ dropping });
    for (let cz = -10; cz <= 14; cz += 2) {
      if ((cz + 10) % 4 === 0) for (let cx = -10; cx <= 17; cx++) c.visit(cx, cz);
      else for (let cx = 17; cx >= -10; cx--) c.visit(cx, cz);
    }
    return c;
  }

  it('draws a fraction of what it used to, over the same walk', () => {
    // The same walk with and without, so the contrast is measured here rather
    // than quoted -- and so a number that drifts fails as a ratio rather than as
    // a stale constant. The terrain is evicted in both: this is the trees.
    const dropping = lawnmower(true);
    const hoarding = lawnmower(false);
    expect(hoarding.drawn.size).toBeGreaterThan(60);
    expect(dropping.drawn.size).toBeLessThan(hoarding.drawn.size / 5);
    // ...and the ground under it was bounded the whole way, in both.
    expect(hoarding.streamed.size).toBeLessThanOrEqual((2 * MAP_CHUNK_KEEP_RADIUS + 1) ** 2);
  });

  it('draws the regions the ground justifies, and only those', () => {
    for (const c of [circuit(true), lawnmower(true)]) {
      expectFieldMatchesGround(c);
      expect(orphanedPropRegions([...c.drawn], c.holds)).toEqual([]);
    }
  });

  it('comes back to the same count, rather than ratcheting up a band a lap', () => {
    const c = client({ dropping: true });
    const lap = (): number => {
      for (const [cx, cz] of [[0, 0], [4, 0], [8, 0], [8, 4], [4, 4], [0, 4], [0, 0]] as const) {
        c.visit(cx, cz);
      }
      return c.drawn.size;
    };
    const first = lap();
    expect(lap()).toBe(first);
    expect(lap()).toBe(first);
  });
});

describe('dropping and rebuilding cannot fight', () => {
  it('keeps a region whose other chunks are still held, at every step of a walk', () => {
    // The discriminating case, and the reason the rule reads residency rather
    // than the eviction: from chunk 5 onward every step drops a column, and a
    // 2200-unit region spans about four 616-unit chunks -- so nearly every
    // dropped column comes out of a region whose other chunks are still held
    // and whose trees must stay drawn. Asserted per step: a walk that ends
    // somewhere quiet can look right having been wrong the whole way.
    const c = client({ dropping: true });
    let evicted = 0;
    for (let cx = 0; cx <= 14; cx++) {
      c.visit(cx, 0);
      evicted += c.dropped().length;
      expectFieldMatchesGround(c);
    }
    // ...and the walk really did drop regions, rather than passing by never
    // reaching an eviction at all.
    expect(evicted).toBeGreaterThan(0);
  });

  it('never drops what the ground still justifies, anywhere in a chunk', () => {
    // Over every position in a chunk rather than one, as spec 208 asserts it
    // for chunks: a boundary bug is a bug about *where in the chunk* you are
    // standing, and the region grid and the chunk grid do not share a boundary.
    const c = client({ dropping: true });
    for (let cx = 0; cx <= 8; cx++) c.visit(cx, 3);

    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        const x = LAYER.origin.x + (8 + i / 12) * EXTENT;
        const z = LAYER.origin.z + (3 + j / 12) * EXTENT;
        c.step(x, z);
        expectFieldMatchesGround(c);
      }
    }
  });

  it('serves and composes each region once for a player standing still', () => {
    const c = client({ dropping: true });
    const home = at(5, 5);
    c.step(home.x, home.z);
    const once = c.adoptedCount();
    for (let i = 0; i < 20; i++) c.step(home.x, home.z);
    expect(c.adoptedCount()).toBe(once);
  });
});

describe('what a dropped region becomes', () => {
  it('is composed and drawn again once the player walks back', () => {
    const c = client({ dropping: true });
    const home = at(0, 0);
    c.visit(0, 0);
    const homeRegions = new Set(c.drawn);
    expect(homeRegions.size).toBeGreaterThan(0);

    // Far enough that no chunk of home's regions is held.
    for (let cx = 1; cx <= 14; cx++) c.visit(cx, 0);
    for (const key of homeRegions) expect(c.drawn.has(key)).toBe(false);

    for (let cx = 13; cx >= 0; cx--) c.visit(cx, 0);
    for (const key of homeRegions) expect(c.drawn.has(key)).toBe(true);
    expect(c.holds({ minX: home.x, minZ: home.z, maxX: home.x, maxZ: home.z })).toBe(true);
  });

  it('is owed nothing on the settle', () => {
    // The case a walk cannot produce, because a walk that settles every step has
    // handed every dirty region out before its ground can go: a region dirtied
    // and evicted *inside one settle period*. It was never drawn, so it is in no
    // drop list -- and it is exactly the entry still sitting in the ledger
    // waiting for `incompleteHoldMs` to hand it out, to be composed on the far
    // thread from props that thread has also evicted.
    const c = client({ dropping: true });
    const home = at(0, 0);
    const far = at(14, 0);

    c.stream(home.x, home.z);
    expect(c.ingest.dirtyRegionCount).toBeGreaterThan(0);

    // The player is already elsewhere when the next frame comes round.
    c.evict(far.x, far.z);
    expect(c.forgottenCount()).toBeGreaterThan(0);

    // Long past every hold in the ingest, and nothing dead is handed back.
    const owed = c.settle();
    const live = regionsWithGround(c);
    for (const key of owed) expect(live.has(key)).toBe(true);
    expect(c.refusedCount()).toBe(0);
  });
});

describe('a region composed while its ground was going', () => {
  it('is refused rather than hung on the graph behind the drop pass', () => {
    // Asked for on one frame, evicted on the next, delivered on the one after.
    // The drop pass reads what is *drawn*, and this was not drawn when it ran --
    // so without the guard nothing would ever take this down again, and one
    // region of every fast crossing would be orphaned for the session.
    const c = client({ dropping: true });
    const home = at(0, 0);
    const far = at(14, 0);

    c.stream(home.x, home.z);
    const asked = c.request();
    expect(asked.length).toBeGreaterThan(0);

    // The ground goes while those regions are being composed.
    c.evict(far.x, far.z);
    c.adopt();

    expect(c.refusedCount()).toBeGreaterThan(0);
    expect([...c.drawn]).toEqual([]);
    expect(orphanedPropRegions([...c.drawn], c.holds)).toEqual([]);
  });

  it('is adopted when its ground is still there', () => {
    const c = client({ dropping: true });
    const home = at(0, 0);
    c.stream(home.x, home.z);
    const asked = c.request();
    c.adopt();
    expect(c.refusedCount()).toBe(0);
    expect([...c.drawn].sort()).toEqual([...asked].sort());
  });
});

describe('what counts as ground under a region', () => {
  /** A chunk whose region holds more than one, so the two questions differ. */
  function sharedRegion(): { chunk: (typeof LAYER.chunks)[number]; key: string } {
    for (const chunk of LAYER.chunks) {
      const key = propRegionKey(
        LAYER.origin.x + (chunk.cx + 0.5) * EXTENT,
        LAYER.origin.z + (chunk.cz + 0.5) * EXTENT,
      );
      const bounds = propRegionBounds(key);
      const inside = LAYER.chunks.filter((c) =>
        propRegionKeysIn(rectOf(c.cx, c.cz)).includes(key),
      );
      if (inside.length > 1 && bounds.maxX > bounds.minX) return { chunk, key };
    }
    throw new Error('every region of the map is one chunk');
  }

  it('is ground held, never ground the map merely declares', () => {
    // The one sentence that separates it from `rectCovered`, which reads
    // `declared`. A rule reading `declared` would keep every region of the map
    // forever -- which is the bug spec 215 exists to close, written the other
    // way round.
    const { chunk, key } = sharedRegion();
    const streamed = new StreamedMap(INFO);
    const bounds = propRegionBounds(key);
    expect(streamed.holdsAnyIn(bounds)).toBe(false);

    streamed.add({ layer: 0, cx: chunk.cx, cz: chunk.cz, chunk });
    expect(streamed.holdsAnyIn(bounds)).toBe(true);
  });

  it('asks the opposite question to rectCovered, on a half-arrived region', () => {
    // One chunk of several: there is something to draw, and not everything.
    // `rectCovered` says "not yet" and this says "still" -- and a region's
    // trees wait for the first and are taken down by the second.
    const { chunk, key } = sharedRegion();
    const streamed = new StreamedMap(INFO);
    streamed.add({ layer: 0, cx: chunk.cx, cz: chunk.cz, chunk });

    const bounds = propRegionBounds(key);
    expect(streamed.holdsAnyIn(bounds)).toBe(true);
    expect(streamed.rectCovered(bounds)).toBe(false);
  });

  it('goes false again when the last chunk under it is dropped', () => {
    const { chunk, key } = sharedRegion();
    const streamed = new StreamedMap(INFO);
    const bounds = propRegionBounds(key);
    const under = LAYER.chunks.filter((c) => propRegionKeysIn(rectOf(c.cx, c.cz)).includes(key));
    for (const c of under) streamed.add({ layer: 0, cx: c.cx, cz: c.cz, chunk: c });
    expect(streamed.holdsAnyIn(bounds)).toBe(true);

    // All but one: a region that has lost most of its ground still has trees.
    streamed.remove(under.slice(1).map((c) => ({ layer: 0, cx: c.cx, cz: c.cz })));
    expect(streamed.holdsAnyIn(bounds)).toBe(true);

    streamed.remove([{ layer: 0, cx: chunk.cx, cz: chunk.cz }]);
    expect(streamed.holdsAnyIn(bounds)).toBe(false);
  });
});
