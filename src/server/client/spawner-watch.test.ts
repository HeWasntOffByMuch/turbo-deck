/**
 * The spawner readout, end to end over the loopback (spec 076).
 *
 * Against the shipped map rather than a fixture, because the thing being tested
 * is that a document's markers reach a client's overlay -- and `maps/arena.json`
 * is the document the game actually opens.
 */

import { describe, expect, it } from 'vitest';
import { BROADCAST_EVERY_N_TICKS, CHUNK_SIZE, INTEREST_CHUNK_RADIUS } from '../config.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { SpawnerStateValue } from '../net/protocol.js';
import { DEFAULT_SPAWN } from '../player/player-manager.js';
import { GameServer } from '../server.js';
import { buildWorldFromMap } from '../world/build.js';
import { loadMapFile } from '../world/map-file.js';
import { spawnPointsFrom } from '../world/spawners.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const file = loadMapFile();
const built = buildWorldFromMap(file.doc, file.mapId);

function harness(): { server: GameServer; transport: LoopbackTransport } {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, built, transport });
  transport.onConnection((channel) => server.accept(channel));
  return { server, transport };
}

async function connect(transport: LoopbackTransport): Promise<GameClient> {
  const client = new GameClient(transport.connect(), { playerId: 'alice', displayName: 'Alice' });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  return client;
}

async function broadcast(server: GameServer, periods = 1): Promise<void> {
  for (let i = 0; i < periods * BROADCAST_EVERY_N_TICKS; i++) server.tick();
  while (server.world.tick % BROADCAST_EVERY_N_TICKS !== 0) server.tick();
  await settle();
}

describe('watching the map spawners', () => {
  it('sends nothing to a client that never asked', async () => {
    const { server, transport } = harness();
    const client = await connect(transport);
    await broadcast(server, 3);
    expect(client.view().spawners).toEqual([]);
  });

  /**
   * What arrives is the map's spawners *inside the client's interest window*,
   * which is not the same claim as "the whole map" and is the one the server
   * actually makes: `sendSpawnerStates` has filtered on `interestChunks` since
   * spec 145, because the whole document going to every watcher is the wrong
   * shape for either the marker count or the client count growing.
   *
   * This asserted plain equality against `spawnPointsFrom(file.doc)` until the
   * map grew a spider nest out east, and it passed for a hundred specs for a
   * reason that was never the rule: every marker on the map happened to sit
   * inside one window of the spawn point, so "the whole map" and "what is near
   * me" were the same list. The moment content was authored further out the
   * test failed on correct behaviour -- 17 of 24 -- which is a test measuring
   * the map's layout while claiming to measure the wire.
   *
   * So it is bounded from both sides, and neither bound re-derives the filter
   * (a test that recomputes `near.has(keyAt(...))` passes whatever that
   * expression says, including the wrong thing). A window is a square of chunks
   * about the player's own chunk, so world distance converts to it with one
   * chunk of slack either way: everything closer than `(radius - 1) * chunk` is
   * inside it wherever in their chunk the player stands, and nothing further
   * than `(radius + 1) * chunk` can be. Between the two is the slack, and this
   * says nothing about it -- deliberately, because that is where the answer
   * legitimately depends on where the player is standing.
   */
  it('sends the spawners near the client once asked, with what it holds', async () => {
    const { server, transport } = harness();
    const client = await connect(transport);
    await broadcast(server, 1);

    client.watchSpawners(true);
    await settle();

    const seen = client.view().spawners;
    const points = spawnPointsFrom(file.doc);
    const byId = new Map(points.map((point) => [point.id, point]));

    // Chebyshev, because a window is a square of chunks rather than a circle.
    const away = (point: { x: number; y: number }): number =>
      Math.max(Math.abs(point.x - DEFAULT_SPAWN.x), Math.abs(point.y - DEFAULT_SPAWN.y));
    const inside = (INTEREST_CHUNK_RADIUS - 1) * CHUNK_SIZE;
    const outside = (INTEREST_CHUNK_RADIUS + 1) * CHUNK_SIZE;

    // Everything that arrived is a real spawner, and they keep the document's
    // order -- the overlay reads this as a list, so a shuffle is a regression.
    expect(seen.length).toBeGreaterThan(0);
    const seenIds = seen.map((s) => s.id);
    expect(seenIds.every((id) => byId.has(id))).toBe(true);
    expect(seenIds).toEqual(points.map((p) => p.id).filter((id) => seenIds.includes(id)));

    // Nothing beyond the window leaked through the filter.
    for (const status of seen) {
      expect(away(status), `${status.id} arrived and is ${Math.round(away(status))} out`)
        .toBeLessThan(outside);
    }

    // And nothing the player is plainly standing among was dropped by it. The
    // count is asserted so this cannot pass by there being nothing to check.
    const near = points.filter((point) => away(point) < inside);
    expect(near.length).toBeGreaterThan(0);
    for (const point of near) {
      expect(seenIds, `${point.id} is ${Math.round(away(point))} out and did not arrive`)
        .toContain(point.id);
    }

    for (const status of seen) {
      const point = byId.get(status.id);
      expect(status.monsterId).toBe(point?.monsterId);
      // Coordinates survive the thousandths encoding to within its own
      // resolution -- which is the guarantee the wire actually makes, and is
      // not the same as "exactly".
      //
      // `SpawnerStatus` rides as `varint(round(v * 1000))` and comes back
      // divided, so what arrives is the nearest thousandth to what was sent.
      // A spawn point is `layer.origin + chunk * extent + marker.local`, and
      // that sum lands off the thousandth lattice whenever the addition costs a
      // low bit: spawner-12's `248 + 465.522` is `713.5219999999999`, which
      // encodes to 713522 and decodes to a *cleaner* number than the one it
      // started as. The round trip did not lose the coordinate, it snapped it.
      //
      // So the honest assertion is the encoding's own bound, half a thousandth,
      // which `toBeCloseTo(_, 3)` is exactly. Asserting identity made this test
      // a hostage to whether a particular marker's arithmetic happened to be
      // representable, and it failed the moment one was not.
      expect(status.x).toBeCloseTo(point?.x ?? Number.NaN, 3);
      expect(status.y).toBeCloseTo(point?.y ?? Number.NaN, 3);
      // Everything is filled on the first tick, so nothing is counting down.
      expect(status.state).toBe(SpawnerStateValue.Occupied);
      expect(status.ticks).toBe(0);
    }
  });

  it('counts down once a spawner is emptied, and stops when the client says stop', async () => {
    const { server, transport } = harness();
    const client = await connect(transport);
    await broadcast(server, 1);
    client.watchSpawners(true);
    await settle();

    // Kill the first monster the map put in the world.
    const victim = [...server.world.entities.values()].find((e) => e.spawnerId !== null);
    expect(victim).toBeDefined();
    if (!victim) return;
    server.despawnEntity(victim.id);
    await broadcast(server, 1);

    const waiting = client.view().spawners.find((s) => s.id === victim.spawnerId);
    expect(waiting?.state).toBe(SpawnerStateValue.Waiting);
    expect(waiting?.ticks).toBeGreaterThan(0);

    client.watchSpawners(false);
    await settle();
    expect(client.view().spawners).toEqual([]);
    await broadcast(server, 3);
    expect(client.view().spawners).toEqual([]);
  });
});
