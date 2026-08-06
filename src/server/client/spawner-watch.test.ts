/**
 * The spawner readout, end to end over the loopback (spec 076).
 *
 * Against the shipped map rather than a fixture, because the thing being tested
 * is that a document's markers reach a client's overlay -- and `maps/arena.json`
 * is the document the game actually opens.
 */

import { describe, expect, it } from 'vitest';
import { BROADCAST_EVERY_N_TICKS } from '../config.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { SpawnerStateValue } from '../net/protocol.js';
import { GameServer } from '../server.js';
import { buildWorldFromMap } from '../world/build.js';
import { loadMapFile } from '../world/map-file.js';
import { spawnPointsFrom } from '../world/spawners.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const file = loadMapFile();
const built = buildWorldFromMap(file.doc, file.text);

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

  it('sends every spawner on the map once asked, with what it holds', async () => {
    const { server, transport } = harness();
    const client = await connect(transport);
    await broadcast(server, 1);

    client.watchSpawners(true);
    await settle();

    const seen = client.view().spawners;
    const points = spawnPointsFrom(file.doc);
    expect(seen.map((s) => s.id)).toEqual(points.map((p) => p.id));
    for (const [i, status] of seen.entries()) {
      const point = points[i];
      expect(status.monsterId).toBe(point?.monsterId);
      // Coordinates survive the thousandths encoding exactly.
      expect(status.x).toBe(point?.x);
      expect(status.y).toBe(point?.y);
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
