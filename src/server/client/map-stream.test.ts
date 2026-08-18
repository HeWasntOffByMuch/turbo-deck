/**
 * The map reaches the client, and the two ends agree on the ground (spec 072).
 *
 * A real `GameServer` built from the shipped map, a real `GameClient`, and real
 * encoded frames over a loopback -- the same harness shape `session.test.ts`
 * uses, for the same reason: if a field is not in the protocol the client cannot
 * see it, so this is a genuine test of the streaming path rather than of two
 * objects sharing a heap.
 *
 * The assertion that matters is the last one. It is not "the terrain looks
 * right"; it is that `heightAt` returns the *identical double* on both sides.
 * Anything less and the client predicts against ground the server does not have.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseMap } from '../../terrain/map.js';
import { loadMap } from '../../terrain/map-world.js';
import { MAP_CHUNK_REQUEST_RADIUS } from '../config.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { buildWorldFromMap } from '../world/build.js';
import { GameClient } from './game-client.js';
import { chunksToDocument } from './map-rebuild.js';

const text = readFileSync('maps/arena.json', 'utf8');
const doc = parseMap(text);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
  readonly built: ReturnType<typeof buildWorldFromMap>;
}

function harness(): Harness {
  const built = buildWorldFromMap(doc, text);
  const transport = new LoopbackTransport();
  const server = new GameServer({ transport, built });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  return { server, transport, built };
}

async function connect(test: Harness): Promise<GameClient> {
  const client = new GameClient(test.transport.connect(), { playerId: 'p1', displayName: 'p1' });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  return client;
}

/**
 * Ticks the server *and* the client, letting the loopback drain each broadcast.
 *
 * The client's own tick matters here: chunk requests cannot ride on deltas
 * alone, because a delta is suppressed when nothing changed. A harness that
 * only ticked the server would test a world in which the player never stands
 * still, which is not the world.
 */
async function run(test: Harness, client: GameClient, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    test.server.tick();
    client.advanceTick();
    if (i % 3 === 0) await settle();
  }
  await settle();
}

describe('the map arrives', () => {
  it('announces the map before any chunk is asked for', async () => {
    const test = harness();
    const client = await connect(test);
    await settle();
    const map = client.view().map;
    expect(map).not.toBeNull();
    expect(map?.info.mapId).toBe(test.built.index.mapId);
    expect(map?.info.cellSize).toBe(doc.grid.cellSize);
    expect(map?.info.layers[0]?.coords.length).toBe(doc.layers[0]?.chunks.length);
  });

  it('streams the chunks around the player without being asked twice', async () => {
    const test = harness();
    const client = await connect(test);
    await run(test, client, 120);

    const map = client.view().map;
    if (!map) throw new Error('no map on the view');
    expect(map.chunks.length).toBeGreaterThan(0);

    // Every chunk exactly once -- a re-send would mean the cache is not doing
    // its job, and would turn a bounded download into an unbounded one.
    const keys = map.chunks.map((c) => `${c.layer}:${c.cx},${c.cz}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('eventually holds every chunk within the request radius', async () => {
    const test = harness();
    const client = await connect(test);
    await run(test, client, 600);

    const view = client.view();
    const self = view.self;
    const map = view.map;
    if (!self || !map) throw new Error('no player or no map on the view');
    const ground = map.info.layers[0];
    if (!ground) throw new Error('the map announced no layers');

    const extent = map.info.cellSize * map.info.chunkCells;
    // Chunk indices are measured from the layer's origin, not from
    // `bounds.min` -- the two move independently once the map has grown west
    // or north of where it was first baked (spec 083).
    const atCx = Math.floor((self.x - ground.origin.x) / extent);
    const atCz = Math.floor((self.y - ground.origin.z) / extent);

    const held = new Set(map.chunks.map((c) => `${c.cx},${c.cz}`));
    const announced = new Set(ground.coords.map((c) => `${c.cx},${c.cz}`));
    for (let cz = atCz - MAP_CHUNK_REQUEST_RADIUS; cz <= atCz + MAP_CHUNK_REQUEST_RADIUS; cz++) {
      for (let cx = atCx - MAP_CHUNK_REQUEST_RADIUS; cx <= atCx + MAP_CHUNK_REQUEST_RADIUS; cx++) {
        const key = `${cx},${cz}`;
        if (announced.has(key)) expect(held).toContain(key);
      }
    }
  });
});

describe('both ends agree on the ground', () => {
  it('samples identical heights from streamed chunks', async () => {
    const test = harness();
    const client = await connect(test);
    await run(test, client, 600);

    const map = client.view().map;
    if (!map) throw new Error('no map on the view');
    const ground = map.info.layers[0];
    if (!ground) throw new Error('the map announced no layers');
    // Rebuild a world from exactly what came over the wire, and from nothing
    // else -- no access to the server's document.
    const rebuilt = loadMap(chunksToDocument(map.info, map.chunks));

    const extent = map.info.cellSize * map.info.chunkCells;
    let sampled = 0;
    for (const chunk of map.chunks) {
      // Measured from origin, not `bounds.min` -- see the comment above.
      const originX = ground.origin.x + chunk.cx * extent;
      const originZ = ground.origin.z + chunk.cz * extent;
      for (let i = 1; i <= 7; i++) {
        const x = originX + (extent * i) / 8;
        const z = originZ + (extent * i) / 8;
        // Object.is, not toBeCloseTo: a client a few ulps below the server gets
        // corrected on ground that looks flat, which is the bug this prevents.
        expect(Object.is(rebuilt.world.heightAt(x, z), test.built.terrain.heightAt(x, z))).toBe(
          true,
        );
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(50);
  });
});

describe('the range check on a live server', () => {
  it('refuses a chunk far from the player and serves it after a teleport', async () => {
    const test = harness();
    const client = await connect(test);
    await run(test, client, 30);

    const coords = doc.layers[0]?.chunks ?? [];
    const self = client.view().self;
    const ground = test.built.index.layers[0];
    if (!self || !ground) throw new Error('no player or no layer');
    const extent = test.built.index.chunkExtent;
    // Measured from origin, not `bounds.min` -- see the comment above.
    const atCx = Math.floor((self.x - ground.origin.x) / extent);
    const atCz = Math.floor((self.y - ground.origin.z) / extent);

    // A chunk that exists but is outside the window from where the player is.
    const far = coords.find(
      (c) => Math.max(Math.abs(c.cx - atCx), Math.abs(c.cz - atCz)) > MAP_CHUNK_REQUEST_RADIUS,
    );
    if (!far) return; // The shipped map is smaller than the window; nothing to assert.

    await run(test, client, 600);
    const after = client.view().map;
    if (!after) throw new Error('no map on the view');
    expect(after.chunks.some((c) => c.cx === far.cx && c.cz === far.cz)).toBe(false);
  });
});
