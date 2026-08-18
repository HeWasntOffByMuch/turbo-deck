/**
 * What the client does with its own stagger (spec 169).
 *
 * The server roots a broken body -- `stagger-gate.test.ts` pins that through
 * the real `step`, from a real blow, and refuses to hand itself the state. This
 * file is the other side of the wire and asks a different question: once the
 * client has been *told* it is staggered, does it stop predicting a walk?
 *
 * That makes injecting the stagger on the server legitimate here where it would
 * not be there. The boundary under test is the wire: the client learns about
 * the break only from a replicated `activity`/`activityUntilTick`, however
 * those two fields came to be set, and nothing below reaches into the client at
 * all.
 *
 * The thing worth stating about the result: the onset cannot be predicted --
 * nobody knows they are about to be hit -- so what these tests pin is the
 * *steady state*, one round trip in. A client that kept walking after being
 * told would build error every tick, and unlike a step, a **turn** is never
 * reconciled: a `Correction` carries a position and no facing at all.
 */

import { describe, expect, it } from 'vitest';

import { createWorldColliders } from '../../sim/collision.js';
import { SERVER_PLAYER_RADIUS } from '../config.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { EntityActivity } from '../net/protocol.js';
import { GameServer } from '../server.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import type { ServerEntity } from '../sim/types.js';
import { GameClient } from './game-client.js';
import { createWorldPredictor } from './prediction.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The client's own predicted point, which is null only before it is placed. */
function selfAt(client: GameClient): { readonly x: number; readonly y: number } {
  const self = client.view().self;
  if (!self) throw new Error('the client has not been placed yet');
  return self;
}

/** How long a stagger is held for below. Longer than a round trip, by a lot. */
const WINDOW_TICKS = 60;

interface Stood {
  readonly server: GameServer;
  readonly client: GameClient;
  readonly entityId: number;
  step: (ticks: number, input?: { moveX: number; moveY: number; facing: number }) => Promise<void>;
}

async function stand(): Promise<Stood> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 5,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  // Nothing wanders in and hits anybody: the only stagger in these runs is the
  // one the test puts there.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), {
    playerId: 'you',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: createWorldColliders([], []),
        terrain: FLAT_TERRAIN,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  client.connect();
  await settle();

  const step = async (
    ticks: number,
    input?: { moveX: number; moveY: number; facing: number },
  ): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      if (input) client.sendInput({ ...input, buttons: 0 });
      server.tick();
      client.advanceTick();
      await settle();
    }
  };

  // Enough to be placed and to have a prediction to compare against.
  await step(20);
  const entityId = client.view().selfEntityId;
  return { server, client, entityId, step };
}

/** Stamps the stagger onto the server's own record, to be replicated normally. */
function breakOnServer(server: GameServer, entityId: number): void {
  const entities = server.world.entities as Map<number, ServerEntity>;
  const entity = entities.get(entityId);
  if (!entity) throw new Error('no player on the server');
  entities.set(entityId, {
    ...entity,
    activity: EntityActivity.Stunned,
    activityUntilTick: server.world.tick + WINDOW_TICKS,
  });
}

describe('the client predicts its own stagger (spec 169)', () => {
  it('sees the break at all', async () => {
    const { server, client, entityId, step } = await stand();
    expect(client.view().selfStaggered).toBe(false);
    breakOnServer(server, entityId);
    await step(6);
    expect(client.view().selfStaggered).toBe(true);
  });

  it('predicts no movement while it holds', async () => {
    const { server, client, entityId, step } = await stand();
    breakOnServer(server, entityId);
    // A few ticks for the delta to land, so what follows is the steady state
    // rather than the round trip the client cannot predict.
    await step(6);
    expect(client.view().selfStaggered).toBe(true);

    const before = { ...selfAt(client) };
    // Full-tilt movement for most of the window.
    await step(30, { moveX: 1, moveY: 0, facing: 0 });

    const after = selfAt(client);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('agrees with the server about where the body is', async () => {
    // The property that matters: not merely that the client stood still, but
    // that it stood still in the same place the server did, so there is nothing
    // left for a correction to pull back.
    const { server, client, entityId, step } = await stand();
    breakOnServer(server, entityId);
    await step(6);
    await step(30, { moveX: 1, moveY: 0, facing: 0 });

    const drawn = selfAt(client);
    const truth = server.world.entities.get(entityId);
    if (!truth) throw new Error('no player on the server');
    expect(drawn.x).toBeCloseTo(truth.position.x, 3);
    expect(drawn.y).toBeCloseTo(truth.position.y, 3);
  });

  it('walks again once the window ends', async () => {
    // The gate has to let go, or this would be a very thorough way of breaking
    // the game.
    const { server, client, entityId, step } = await stand();
    breakOnServer(server, entityId);
    await step(6);
    const held = { ...selfAt(client) };
    await step(WINDOW_TICKS + 10);
    expect(client.view().selfStaggered).toBe(false);

    await step(20, { moveX: 1, moveY: 0, facing: 0 });
    expect(selfAt(client).x).toBeGreaterThan(held.x + 1);
  });

  it('refuses a cast for the same window', async () => {
    const { server, client, entityId, step } = await stand();
    breakOnServer(server, entityId);
    await step(6);

    const rejections: string[] = [];
    client.onCastRejected((_abilityId, reason) => rejections.push(reason));
    client.useAbility('melee.slash', 200, 0, 0, 0);
    await step(10);

    expect(rejections).toEqual(['staggered']);
    expect(client.view().casts.some((cast) => cast.entityId === entityId)).toBe(false);
  });
});
