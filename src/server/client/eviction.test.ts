/**
 * A client that forgets behind it (spec 208).
 *
 * The measurement this exists for: driven around a circuit of the shipped map,
 * a real cache and a real `StreamedMap` held **392 chunks against a 25-chunk
 * request window**, and stopped at 392 only because a circuit revisits its own
 * ground. Nothing on the client's map path removed anything.
 *
 * The assertion that matters most is not the bound -- it is that eviction and
 * the streamer cannot fight. A pass that drops what the next pass asks for is
 * worse than never evicting: it is a request storm, on the connection least able
 * to afford one.
 */

import { describe, expect, it } from 'vitest';

import { loadMapFile } from '../world/map-file.js';
import { buildWorldFromMap } from '../world/build.js';
import { infoFromIndex } from '../world/tiled-map.js';
import { MAP_CHUNK_KEEP_RADIUS, MAP_CHUNK_REQUEST_RADIUS } from '../config.js';
import { ChunkDeniedReason } from '../net/protocol.js';
import type { MapChunkMessage, MapInfoMessage } from '../net/map-messages.js';
import { MapChunkCache } from './map-cache.js';
import { StreamedMap } from './streamed-map.js';

const LOADED = loadMapFile();
const BUILT = buildWorldFromMap(LOADED.doc, LOADED.mapId);
const INFO = infoFromIndex(BUILT.index) as MapInfoMessage;
const LAYER0 = LOADED.doc.layers[0];
if (!LAYER0) throw new Error('no layer');
const LAYER = LAYER0;
const EXTENT = LOADED.doc.grid.cellSize * LOADED.doc.grid.chunkCells;

const BY_COORD = new Map(LAYER.chunks.map((c) => [`${String(c.cx)},${String(c.cz)}`, c]));

/** A client, and a server that answers everything it asks for. */
function client() {
  const cache = new MapChunkCache(INFO);
  const streamed = new StreamedMap(INFO);
  let tick = 0;
  let served = 0;

  const stream = (x: number, z: number): void => {
    tick += 10;
    for (let pass = 0; pass < 30; pass++) {
      const want = cache.wanted(x, z, MAP_CHUNK_REQUEST_RADIUS, 64, tick);
      if (want.length === 0) return;
      for (const req of want) {
        cache.markRequested(req, tick);
        const doc = BY_COORD.get(`${String(req.cx)},${String(req.cz)}`);
        if (!doc) {
          cache.deny(req.layer, req.cx, req.cz, ChunkDeniedReason.Unknown);
          continue;
        }
        served += 1;
        const msg = { mapId: INFO.mapId, layer: req.layer, chunk: doc } as MapChunkMessage;
        if (cache.accept(msg)) streamed.add({ layer: req.layer, cx: req.cx, cz: req.cz, chunk: doc });
      }
    }
  };

  const evict = (x: number, z: number): number => {
    const gone = cache.evictBeyond(x, z, MAP_CHUNK_KEEP_RADIUS);
    streamed.remove(gone);
    return gone.length;
  };

  return { cache, streamed, stream, evict, served: () => served, at: () => tick };
}

/** World position of a chunk's middle. */
function at(cx: number, cz: number): { x: number; z: number } {
  return { x: LAYER.origin.x + (cx + 0.5) * EXTENT, z: LAYER.origin.z + (cz + 0.5) * EXTENT };
}

const KEEP_WINDOW = (2 * MAP_CHUNK_KEEP_RADIUS + 1) ** 2;

describe('the keep radius', () => {
  it('is wider than the request radius', () => {
    expect(MAP_CHUNK_KEEP_RADIUS).toBeGreaterThan(MAP_CHUNK_REQUEST_RADIUS + 1);
  });
});

describe('walking the map', () => {
  /** A lap of the map's perimeter, evicting or not. Returns the peak held. */
  function circuit(evicting: boolean): number {
    const c = client();
    let peak = 0;
    const visit = (cx: number, cz: number): void => {
      const p = at(cx, cz);
      c.stream(p.x, p.z);
      if (evicting) c.evict(p.x, p.z);
      peak = Math.max(peak, c.streamed.size);
    };
    for (let lap = 0; lap < 3; lap++) {
      for (let cx = -10; cx <= 17; cx++) visit(cx, -10);
      for (let cz = -10; cz <= 14; cz++) visit(17, cz);
      for (let cx = 17; cx >= -10; cx--) visit(cx, 14);
      for (let cz = 14; cz >= -10; cz--) visit(-10, cz);
    }
    return peak;
  }

  it('holds a fraction of what it used to, over the same circuit', () => {
    // The same walk, with and without, so the contrast is measured here rather
    // than quoted from a probe -- and so a number that drifts fails as a ratio
    // rather than as a stale constant.
    const evicting = circuit(true);
    const hoarding = circuit(false);
    // Derived from the keep window rather than typed: what makes the contrast
    // real is that hoarding ends up holding several times what it is ever
    // allowed to want, and a hand-written 300 is a fact about how big the map
    // happened to be -- which is exactly the drift the comment above refuses.
    expect(hoarding).toBeGreaterThan(KEEP_WINDOW * 2);
    expect(evicting).toBeLessThan(hoarding / 5);
  });

  it('never exceeds the keep window', () => {
    // The hard bound. The circuit's own peak is well under it -- the walk hugs
    // the map's edge, so most of a 9x9 keep window is outside the map and the
    // 5x5 request window only ever fills a band -- which is why the assertion
    // above is the one that says the feature works and this one is the ceiling.
    expect(circuit(true)).toBeLessThanOrEqual(KEEP_WINDOW);
  });

  it('comes back to the same count, rather than ratcheting up a band a lap', () => {
    const c = client();
    const lap = (): number => {
      for (const [cx, cz] of [[0, 0], [4, 0], [8, 0], [8, 4], [4, 4], [0, 4], [0, 0]] as const) {
        const p = at(cx, cz);
        c.stream(p.x, p.z);
        c.evict(p.x, p.z);
      }
      return c.streamed.size;
    };
    const first = lap();
    expect(lap()).toBe(first);
    expect(lap()).toBe(first);
  });
});

describe('eviction and the streamer cannot fight', () => {
  it('never drops what the next pass would ask for, anywhere in a chunk', () => {
    // Over every position in a chunk rather than one: a boundary bug is a bug
    // about *where in the chunk* the player is standing, and the middle is the
    // one place it does not show.
    const c = client();
    const home = at(3, 3);
    c.stream(home.x, home.z);

    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        const x = LAYER.origin.x + (3 + i / 12) * EXTENT;
        const z = LAYER.origin.z + (3 + j / 12) * EXTENT;
        c.stream(x, z);
        const dropped = new Set(
          c.cache.evictBeyond(x, z, MAP_CHUNK_KEEP_RADIUS).map((r) => `${String(r.cx)},${String(r.cz)}`),
        );
        const asked = c.cache.wanted(x, z, MAP_CHUNK_REQUEST_RADIUS, 999, c.at());
        for (const req of asked) {
          expect(dropped.has(`${String(req.cx)},${String(req.cz)}`)).toBe(false);
        }
      }
    }
  });

  it('serves each chunk once for a player standing still', () => {
    const c = client();
    const home = at(5, 5);
    c.stream(home.x, home.z);
    const once = c.served();
    for (let i = 0; i < 20; i++) {
      c.evict(home.x, home.z);
      c.stream(home.x, home.z);
    }
    expect(c.served()).toBe(once);
  });
});

describe('what an evicted chunk becomes', () => {
  it('is asked for again once the player walks back', () => {
    const c = client();
    const home = at(0, 0);
    c.stream(home.x, home.z);
    expect(c.streamed.has(0, 0, 0)).toBe(true);

    const away = at(0 + MAP_CHUNK_KEEP_RADIUS + 3, 0);
    c.stream(away.x, away.z);
    expect(c.evict(away.x, away.z)).toBeGreaterThan(0);
    expect(c.streamed.has(0, 0, 0)).toBe(false);

    c.stream(home.x, home.z);
    expect(c.streamed.has(0, 0, 0)).toBe(true);
  });

  it('leaves a denied chunk denied, so a lap is not a request storm', () => {
    // `absent` is deliberately not cleared: ground the server says does not
    // exist still does not, and re-asking every lap would be a storm for a chunk
    // that is never coming.
    const cache = new MapChunkCache(INFO);
    // A coordinate the map declares and this fixture refuses.
    const edge = LAYER.chunks[0];
    if (!edge) throw new Error('no chunk');
    cache.deny(0, edge.cx, edge.cz, ChunkDeniedReason.Unknown);
    const p = at(edge.cx, edge.cz);
    const before = cache.wanted(p.x, p.z, MAP_CHUNK_REQUEST_RADIUS, 999, 0);
    expect(before.some((r) => r.cx === edge.cx && r.cz === edge.cz)).toBe(false);

    cache.evictBeyond(p.x, p.z, MAP_CHUNK_KEEP_RADIUS);
    const after = cache.wanted(p.x, p.z, MAP_CHUNK_REQUEST_RADIUS, 999, 0);
    expect(after.some((r) => r.cx === edge.cx && r.cz === edge.cz)).toBe(false);
  });

  it('names the neighbours that have to be re-stitched, and not the ones that went', () => {
    // A chunk's apron is built from the ground beside it, so dropping one leaves
    // the four next to it drawing a seam against ground that is not there.
    const c = client();
    const home = at(4, 4);
    c.stream(home.x, home.z);
    const gone = c.cache.evictBeyond(home.x, home.z, 1);
    const { removed, restitch } = c.streamed.remove(gone);
    expect(removed.length).toBe(gone.length);
    const goneKeys = new Set(removed.map((r) => `${String(r.cx)},${String(r.cz)}`));
    for (const ref of restitch) {
      expect(goneKeys.has(`${String(ref.cx)},${String(ref.cz)}`)).toBe(false);
      expect(c.streamed.has(ref.layer, ref.cx, ref.cz)).toBe(true);
    }
  });
});

describe('the world after an eviction', () => {
  it('does not claim to know ground it has thrown away', () => {
    const c = client();
    const home = at(0, 0);
    c.stream(home.x, home.z);
    const far = at(MAP_CHUNK_KEEP_RADIUS + 4, 0);
    c.stream(far.x, far.z);
    c.evict(far.x, far.z);
    // The point it walked away from is gone, and `knows` says so -- a body
    // routed over ground the client has dropped is the failure this guards.
    expect(c.streamed.knows(home.x, home.z)).toBe(false);
    expect(c.streamed.knows(far.x, far.z)).toBe(true);
  });

  it('still covers what it is standing in', () => {
    const c = client();
    const home = at(2, 2);
    c.stream(home.x, home.z);
    c.evict(home.x, home.z);
    const cover = c.streamed.coverage(home.x, home.z, MAP_CHUNK_REQUEST_RADIUS);
    expect(cover.held).toBe(cover.needed);
  });
});

describe('the worker lets go too', () => {
  it('drops what the main thread dropped, and re-meshes the seam', async () => {
    // The worker keeps a `StreamedMap` of its own, so without this it holds
    // every chunk of the session while the main thread lets go -- half the
    // memory the eviction was for, on the thread nobody is watching.
    const { MapWorkerCore } = await import('../../render/iso3d/world/map-worker-core.js');
    const core = new MapWorkerCore();
    core.setMap(INFO, 550);

    const held: { layer: number; cx: number; cz: number; chunk: (typeof LAYER.chunks)[number] }[] = [];
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        const doc = BY_COORD.get(`${String(cx)},${String(cz)}`);
        if (doc) held.push({ layer: 0, cx, cz, chunk: doc });
      }
    }
    expect(held.length).toBe(9);
    for (const h of held) core.addChunk(h);
    expect(core.generation).toBe(9);

    // Drop the middle: the four beside it are now stitched to ground that is
    // gone, so they come back as meshes.
    const replies = core.evict([{ layer: 0, cx: 0, cz: 0 }]);
    // **Up, not down** (spec 215). This used to read `toBe(8)`, because the
    // generation was the held count -- and a version number that goes backwards
    // when ground is let go is what had the renderer refusing every nav grid
    // built after the held set stopped growing.
    expect(core.generation).toBe(10);
    const meshed = replies.filter((r) => r.kind === 'mesh');
    expect(meshed.length).toBe(4);
    for (const r of meshed) {
      expect(r.kind === 'mesh' && (r.cx !== 0 || r.cz !== 0)).toBe(true);
    }
  });

  it('says nothing about a chunk it never held', () => {
    return (async () => {
      const { MapWorkerCore } = await import('../../render/iso3d/world/map-worker-core.js');
      const core = new MapWorkerCore();
      core.setMap(INFO, 550);
      expect(core.evict([{ layer: 0, cx: 99, cz: 99 }])).toEqual([]);
    })();
  });
});

/**
 * The number a nav reply is ordered by, and the number that says how much has
 * changed (spec 215).
 *
 * Both were the held chunk *count*, which is a version only for a client that
 * never forgets. Measured in a browser once it did: over a walk across the
 * shipped map the renderer asked for **one** grid and adopted **two**, and went
 * on routing against the one built over its spawn point -- pathfinding that
 * works until you go anywhere.
 */
describe('how much ground has moved', () => {
  it('counts a chunk let go as a change, the same as one that arrived', () => {
    const streamed = new StreamedMap(INFO);
    const doc = BY_COORD.get('0,0');
    if (!doc) throw new Error('no chunk');

    expect(streamed.revision).toBe(0);
    streamed.add({ layer: 0, cx: 0, cz: 0, chunk: doc });
    expect(streamed.revision).toBe(1);
    streamed.remove([{ layer: 0, cx: 0, cz: 0 }]);
    expect(streamed.revision).toBe(2);
    expect(streamed.size).toBe(0);
  });

  it('only ever goes up, while the held count does not', () => {
    // The property the whole fix rests on. Walking a corridor, the held set
    // reaches its keep window and stays there -- so `size` is flat and useless
    // as a version, while every step still changes which ground is held.
    const c = client();
    const seen: number[] = [];
    const sizes: number[] = [];
    for (let cx = 0; cx <= 12; cx++) {
      const p = at(cx, 3);
      c.stream(p.x, p.z);
      c.evict(p.x, p.z);
      seen.push(c.streamed.revision);
      sizes.push(c.streamed.size);
    }

    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] ?? 0).toBeGreaterThan(seen[i - 1] ?? 0);
    }
    // ...and the count it replaced flattens out, which is the bug in one line.
    const settled = sizes.slice(4);
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThan(
      (seen[seen.length - 1] ?? 0) - (seen[4] ?? 0),
    );
  });

  it('ignores a chunk that was not held and one already held', () => {
    const streamed = new StreamedMap(INFO);
    const doc = BY_COORD.get('0,0');
    if (!doc) throw new Error('no chunk');

    streamed.remove([{ layer: 0, cx: 0, cz: 0 }]);
    expect(streamed.revision).toBe(0);
    streamed.add({ layer: 0, cx: 0, cz: 0, chunk: doc });
    streamed.add({ layer: 0, cx: 0, cz: 0, chunk: doc });
    expect(streamed.revision).toBe(1);
  });
});
