/**
 * What the client does with its own death (spec 229).
 *
 * The reported bug, in one sentence: a player who dies holding a move order
 * watches their own body get up and walk to it. Everybody else sees the corpse
 * lie where it fell, which is what makes this a prediction bug and not a
 * simulation one -- `stepWorld`'s movement pass steps past a body at zero health
 * before it reads an intent, so the server never moves it.
 *
 * That is also the whole of *why* it persists. A `Correction` is the only thing
 * that pulls a mispredicted position back, and the server emits one out of the
 * movement pass -- so the one case that never enters that pass is the one case
 * nothing corrects. The error is not bounded by a round trip the way every other
 * mispredict here is; it stands until the respawn teleport, and its size is how
 * far the order was.
 *
 * Measured against this file before the fix: one second of asking to walk east
 * carried the drawn body **155 units** while the server held it at the death
 * spot and said nothing.
 *
 * The stagger next door is the same shape and a weaker case, which is why these
 * are separate files: there the server reads the intent and discards it, so a
 * client that kept walking was corrected every tick. Here it is silence.
 */

import { describe, expect, it } from 'vitest';

import { createWorldColliders } from '../../sim/collision.js';
import { SERVER_PLAYER_RADIUS } from '../config.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { decodeClientMessage } from '../net/messages.js';
import { ClientMessageType } from '../net/protocol.js';
import type { Channel } from '../net/transport.js';
import { DEFAULT_SPAWN } from '../player/player-manager.js';
import { GameServer } from '../server.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { GameClient } from './game-client.js';
import { createWorldPredictor } from './prediction.js';

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

const PLAYER = 'you';

/** A whole second of walking, which is what made the original 155 units. */
const RUN_TICKS = 60;

/** The client's own predicted point -- what is drawn, and what walked off. */
function selfAt(client: GameClient): { readonly x: number; readonly y: number } {
  const self = client.view().self;
  if (!self) throw new Error('the client has not been placed yet');
  return self;
}

/** Where the server says the body is. The truth every other client is shown. */
function serverAt(server: GameServer, entityId: number): { x: number; y: number } {
  const entity = server.world.entities.get(entityId);
  if (!entity) throw new Error('no player on the server');
  return { x: entity.position.x, y: entity.position.y };
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

interface Stood {
  readonly server: GameServer;
  readonly client: GameClient;
  readonly entityId: number;
  /** Every `Input` this client has put on the wire, in order. */
  readonly sentInputs: { moveX: number; moveY: number }[];
  step: (ticks: number, input?: { moveX: number; moveY: number; facing: number }) => Promise<void>;
}

/**
 * A player standing on flat, empty ground.
 *
 * Flat and empty on purpose: a tree between the body and its order would stop
 * the walk for a reason that has nothing to do with being dead, and would make a
 * passing test evidence of the wrong thing.
 */
async function stand(): Promise<Stood> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 5,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  // Nothing wanders in: the only death in these runs is the one the test asks
  // for, and an ambient monster could hand the body a stagger as well.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  // Read off the wire rather than off the client's own bookkeeping, because
  // "stopped predicting" and "stopped claiming" are two facts and only the
  // second is what the server is protected by. Spying rather than reaching
  // inside: `sendInput` is the boundary under test.
  const sentInputs: { moveX: number; moveY: number }[] = [];
  const real = transport.connect();
  const spy: Channel = {
    send(bytes) {
      const message = decodeClientMessage(bytes);
      if (message.type === ClientMessageType.Input) {
        sentInputs.push({ moveX: message.moveX, moveY: message.moveY });
      }
      real.send(bytes);
    },
    close: () => real.close(),
    get isOpen() {
      return real.isOpen;
    },
    onMessage: (handler) => real.onMessage(handler),
    onClose: (handler) => real.onClose(handler),
  };

  const client = new GameClient(spy, {
    playerId: PLAYER,
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
  return { server, client, entityId: client.view().selfEntityId, sentInputs, step };
}

/** Kills the player through the admin path and waits for the delta to land. */
async function die(stood: Stood): Promise<void> {
  expect(stood.server.kill(PLAYER).ok).toBe(true);
  await stood.step(6);
  expect(stood.client.view().selfDead, 'the client should have been told').toBe(true);
}

describe('the one answer to "am I dead" (spec 229)', () => {
  it('is false before the client knows which body is its own', () => {
    // A welcome that has not landed. This is what the overlay's own test used to
    // pin, and it matters more now that the legs read the same field: answering
    // "dead" here would freeze every session through its loading frames.
    const transport = new LoopbackTransport();
    const client = new GameClient(transport.connect(), { playerId: PLAYER });
    expect(client.view().selfDead).toBe(false);
  });

  it('is false for a living body and true at zero health', async () => {
    const stood = await stand();
    expect(stood.client.view().selfDead).toBe(false);
    await die(stood);
    expect(stood.client.view().selfDead).toBe(true);
  });

  it('is false again the moment the body is back up', async () => {
    const stood = await stand();
    await die(stood);
    stood.client.respawn();
    await stood.step(6);
    expect(stood.client.view().selfDead).toBe(false);
  });
});

describe('a corpse stays where it fell (spec 229)', () => {
  it('does not walk to the order it died under', async () => {
    const stood = await stand();
    await die(stood);
    const fell = { ...selfAt(stood.client) };

    // What a standing move order does every tick: ask to walk, full tilt.
    await stood.step(RUN_TICKS, { moveX: 1, moveY: 0, facing: 0 });

    // To the unit. Not "close to", because there is no rounding here to hide
    // behind -- the predictor either applied a vector or it did not.
    expect(distance(selfAt(stood.client), fell)).toBe(0);
    // And what the drawn body agrees with is the truth every other client was
    // being shown the whole time, which is the half that was wrong.
    expect(distance(serverAt(stood.server, stood.entityId), fell)).toBe(0);
  });

  it('claims nothing on the wire either, not just in its own prediction', async () => {
    const stood = await stand();
    await die(stood);
    const from = stood.sentInputs.length;

    await stood.step(RUN_TICKS, { moveX: 1, moveY: 0, facing: 0 });

    const claims = stood.sentInputs.slice(from);
    expect(claims.length, 'the inputs should still be sent').toBeGreaterThan(0);
    // Sent, and empty. A request that cannot be honoured still gets an answer
    // (spec 080) -- what stops is the asking to move, not the input, which is
    // also what the cast pass needs in order to refuse a corpse's swing.
    expect(claims.every((claim) => claim.moveX === 0 && claim.moveY === 0)).toBe(true);
  });

  it('gets up at the spawn rather than at where it was walking to', async () => {
    // The same bug through the other door, and the reason fixing the prediction
    // alone is not fixing it: the order outlives the death, so a body put back
    // on the spawn pad sets off for where it died without being asked.
    //
    // `sendInput` is the boundary this file owns, so the order here is the one
    // thing a caller can still do -- keep asking. The view drops its own orders
    // at the death (`dropOrders`), which is the other half and the half no
    // headless test can see.
    const stood = await stand();
    await die(stood);
    stood.client.respawn();
    await stood.step(6);

    const up = { ...selfAt(stood.client) };
    expect(distance(up, DEFAULT_SPAWN)).toBeLessThan(64);
    expect(distance(up, serverAt(stood.server, stood.entityId))).toBeLessThan(1);
  });

  it('walks again the moment it is back up', async () => {
    // The control. Every assertion above is an absence, and a client that had
    // simply stopped sending anything would pass all of them.
    const stood = await stand();
    await die(stood);
    stood.client.respawn();
    await stood.step(6);

    const up = { ...selfAt(stood.client) };
    await stood.step(30, { moveX: 1, moveY: 0, facing: 0 });
    expect(distance(selfAt(stood.client), up)).toBeGreaterThan(32);
  });
});
