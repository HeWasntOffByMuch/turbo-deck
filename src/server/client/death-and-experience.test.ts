/**
 * A kill that pays, and a death you get up from (spec 164).
 *
 * The kills are real kills, over a real loopback, for the reason
 * `loot-wire.test.ts` gives about drops: the claim is about the path from a body
 * dying to a number changing on a client, and every test that skipped that path
 * passed for four years while no kill in this game ever awarded anything.
 * `stats.test.ts` calls `grantExperience` directly and is right to -- it is
 * testing the award. Nothing was testing the *call*.
 *
 * The respawn half is here rather than beside it in `session.test.ts` because it
 * is the same fact from the other end: what a death does and what undoes it.
 */

import { describe, expect, it } from 'vitest';
import { SERVER_TICK_RATE } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { DEFAULT_SPAWN } from '../player/player-manager.js';
import { experienceForLevel } from '../player/levels.js';
import { EntityKindValue } from '../sim/types.js';
import { GameClient } from './game-client.js';

/**
 * Yield the event loop, so anything the loopback queued is delivered.
 *
 * `setImmediate` rather than `setTimeout(resolve, 0)` (spec 274). Node clamps a
 * zero timeout to one millisecond, so a settle awaited twice per simulated tick
 * cost 1.12ms of doing nothing against this call's 0.004ms -- 147 of the suite's
 * 330 CPU-seconds, and 39.6s of `rate-match.test.ts` alone. It is also the
 * stronger barrier: the check phase runs after the poll phase, where a timer
 * fires at the top of the next loop iteration.
 */
/**
 * Yield the event loop, so anything the loopback queued is delivered.
 *
 * `setImmediate` rather than `setTimeout(resolve, 0)` (spec 274). Node clamps a
 * zero timeout to one millisecond, so a settle awaited twice per simulated tick
 * cost 1.12ms of doing nothing against this call's 0.004ms -- 147 of the suite's
 * 330 CPU-seconds, and 39.6s of `rate-match.test.ts` alone. It is also the
 * stronger barrier: the check phase runs after the poll phase, where a timer
 * fires at the top of the next loop iteration.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Rig {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
  readonly clients: GameClient[];
  readonly tick: (times?: number) => Promise<void>;
}

function rig(): Rig {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 8, transport });
  // No ambient spawning: this test wants the bodies it puts there and no others,
  // and an unrelated kill would be experience arriving from somewhere else.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const clients: GameClient[] = [];
  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      for (const client of clients) client.advanceTick();
      await settle();
    }
  };
  return { server, transport, clients, tick };
}

async function join(r: Rig, playerId: string): Promise<GameClient> {
  const client = new GameClient(r.transport.connect(), { playerId, displayName: playerId });
  const welcome = client.connect();
  await settle();
  await welcome;
  await settle();
  r.clients.push(client);
  return client;
}

function positionOf(r: Rig, entityId: number): { x: number; y: number } {
  const entity = r.server.world.entities.get(entityId);
  if (!entity) throw new Error(`no entity ${entityId}`);
  return { x: entity.position.x, y: entity.position.y };
}

/** Where the one monster under test is, or null once it is gone. */
function monsterOf(r: Rig): { x: number; y: number } | null {
  for (const entity of r.server.world.entities.values()) {
    if (entity.kind === EntityKindValue.Monster) return { x: entity.position.x, y: entity.position.y };
  }
  return null;
}

function monsterCount(r: Rig): number {
  let n = 0;
  for (const entity of r.server.world.entities.values()) {
    if (entity.kind === EntityKindValue.Monster) n += 1;
  }
  return n;
}

/**
 * Swing at a body next to `client` until it is gone.
 *
 * Real swings on a real cadence -- 60 ticks between them is comfortably past any
 * attack interval in the table, so the loop is not racing the cooldown.
 */
async function killNearby(r: Rig, client: GameClient, monsterId: string): Promise<void> {
  const self = client.view().selfEntityId;
  const at = positionOf(r, self);
  r.server.spawnEntities(monsterId, at.x + 40, at.y, 1);
  await r.tick(2);
  expect(monsterCount(r), 'the body under test should be standing there').toBe(1);

  // Walk after it while swinging (spec 217). A grazer is skittish and runs for
  // two and a half seconds from whatever hit it -- which never mattered while
  // one blow killed it, and does now that it takes two or three. Standing still
  // and swinging at a fixed point simply misses everything after the first.
  for (let swing = 0; swing < 40 && monsterCount(r) > 0; swing++) {
    const prey = monsterOf(r);
    if (!prey) break;
    client.useAbility('melee.slash', prey.x, prey.y);
    for (let i = 0; i < 60; i++) {
      const here = positionOf(r, self);
      const there = monsterOf(r);
      const dx = there ? there.x - here.x : 0;
      const dy = there ? there.y - here.y : 0;
      const len = Math.hypot(dx, dy);
      // Close to just inside reach and stop, so the swing is not walked out of.
      const chase = len > 40 ? { moveX: dx / len, moveY: dy / len } : { moveX: 0, moveY: 0 };
      client.sendInput({ ...chase, facing: Math.atan2(dy, dx), buttons: 0 });
      await r.tick();
    }
  }
  expect(monsterCount(r), 'it should have died').toBe(0);
  // The award rides the store, which is a promise; the stats message that
  // follows it is a second hop. Neither is on the tick.
  await r.tick(10);
}

describe('a kill pays the killer', () => {
  it('raises the killer’s replicated experience by the row’s own award', async () => {
    const r = rig();
    const client = await join(r, 'alice');
    await r.tick(2);

    expect(client.view().experience).toBe(0);
    await killNearby(r, client, 'grazer');

    // The row's number, not a number of its own: what a kill is worth is content.
    expect(client.view().experience).toBe(monsterById('grazer')?.experience ?? -1);
  }, 30000);

  it('levels a character up over the wire once the kills add up', async () => {
    const r = rig();
    const client = await join(r, 'alice');
    await r.tick(2);

    const cost = experienceForLevel(2);
    const award = monsterById('grazer')?.experience ?? 0;
    expect(award).toBeGreaterThan(0);
    const kills = Math.ceil(cost / award);

    for (let i = 0; i < kills; i++) await killNearby(r, client, 'grazer');

    expect(client.view().level).toBe(2);
    // What is left over is *into* the new level, so the bar starts near empty
    // rather than carrying the whole total forward.
    expect(client.view().experience).toBe(kills * award - cost);
    expect(client.view().experience).toBeLessThan(experienceForLevel(3));
  }, 60000);
});

describe('death waits for the player', () => {
  it('never puts a dead body back on its feet by the passage of time', async () => {
    const r = rig();
    const client = await join(r, 'alice');
    await r.tick(2);
    const entityId = client.view().selfEntityId;

    expect(r.server.kill('alice').ok).toBe(true);
    await r.tick(SERVER_TICK_RATE * 10);

    const entity = r.server.world.entities.get(entityId);
    expect(entity?.health).toBe(0);
    expect(client.view().entities.find((e) => e.id === entityId)?.health).toBe(0);
  }, 30000);

  it('says so once, however long the body lies there', async () => {
    const r = rig();
    const client = await join(r, 'alice');
    const lines: string[] = [];
    client.onChat((message) => lines.push(message.text));
    await r.tick(2);

    expect(r.server.kill('alice').ok).toBe(true);
    await r.tick(SERVER_TICK_RATE * 3);

    expect(lines.filter((line) => line.includes('fallen'))).toHaveLength(1);
  }, 30000);

  it('puts them at the spawn, whole, when they ask', async () => {
    const r = rig();
    const client = await join(r, 'alice');
    await r.tick(2);
    const entityId = client.view().selfEntityId;

    // Walk away first, so a respawn is a visible journey rather than a heal.
    for (let i = 0; i < 90; i++) {
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      await r.tick();
    }
    const away = positionOf(r, entityId);
    expect(Math.hypot(away.x - DEFAULT_SPAWN.x, away.y - DEFAULT_SPAWN.y)).toBeGreaterThan(100);

    expect(r.server.kill('alice').ok).toBe(true);
    await r.tick(2);

    client.respawn();
    await r.tick(4);

    const entity = r.server.world.entities.get(entityId);
    expect(entity?.health).toBeGreaterThan(0);
    const back = positionOf(r, entityId);
    // Near the spawn rather than exactly on it: `clearSpawnNear` steps a body off
    // the point when somebody else is standing on it (spec 145).
    expect(Math.hypot(back.x - DEFAULT_SPAWN.x, back.y - DEFAULT_SPAWN.y)).toBeLessThan(100);
  }, 30000);

  it('does not flag the first input after a respawn as a speed hack', async () => {
    const r = rig();
    const client = await join(r, 'alice');
    await r.tick(2);

    for (let i = 0; i < 60; i++) {
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      await r.tick();
    }

    expect(r.server.kill('alice').ok).toBe(true);
    await r.tick(2);
    client.respawn();
    await r.tick(4);
    const afterRespawn = client.correctionCount;

    for (let i = 0; i < 30; i++) {
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      await r.tick();
    }
    // The teleport correction is expected and has already happened; what must
    // not follow is a violation on every input afterwards.
    expect(client.correctionCount - afterRespawn).toBeLessThan(2);
  }, 30000);

  it('ignores a respawn from a living player entirely', async () => {
    const r = rig();
    const client = await join(r, 'alice');
    await r.tick(2);
    const entityId = client.view().selfEntityId;

    for (let i = 0; i < 90; i++) {
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      await r.tick();
    }
    const away = positionOf(r, entityId);

    client.respawn();
    await r.tick(4);

    // Not taken home: a respawn on a living body would be a free trip to the
    // spawn and a free full heal, which is the whole reason it is gated. Judged
    // by distance from the spawn rather than by exact coordinates -- the four
    // ticks after the ask still walk the queued inputs off, and "did not move at
    // all" would be a claim about the input queue rather than about the respawn.
    const back = positionOf(r, entityId);
    const travelled = Math.hypot(back.x - away.x, back.y - away.y);
    expect(travelled).toBeLessThan(20);
    expect(Math.hypot(back.x - DEFAULT_SPAWN.x, back.y - DEFAULT_SPAWN.y)).toBeGreaterThan(100);
  }, 30000);
});
