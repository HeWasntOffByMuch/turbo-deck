/**
 * Calling off a wind-up over a wire that takes time (spec 090).
 *
 * `session.test.ts` already pins the cancel *rule* over a loopback, but that
 * loopback delivers on a microtask -- zero latency -- so it can only ever ask
 * "does Esc reach the server", never "does it reach the server *in time*".
 *
 * That gap is the whole of the bug this file exists for. The client drops its
 * predicted cast the instant the key goes down, so the bar vanishes at once;
 * the request then takes a one-way trip, and is held again until the server has
 * consumed the input frame it was stamped after. If the sum of those lands on
 * or past `releaseTick`, `cancelCast` refuses -- correctly, since a released
 * shot may not be called back -- and the blow the player withdrew from lands.
 * From the player's side: the bar disappeared, and the arrow flew anyway.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../sim/collision.js';
import { SERVER_PLAYER_RADIUS } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { UnreliableChannel, PERFECT_WIRE } from '../net/unreliable.js';
import { Rng } from '../../shared/prng.js';
import { decodeServerMessage } from '../net/messages.js';
import { ServerMessageType } from '../net/protocol.js';
import { GameServer } from '../server.js';
import { CastEndReason } from '../sim/types.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { GameClient } from './game-client.js';
import { createWorldPredictor } from './prediction.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));


interface Withdrawn {
  /** Ticks into the wind-up that the withdrawal was asked for. */
  readonly pressedAfter: number;
  /** True once the client had stopped drawing a bar for itself. */
  readonly barGone: boolean;
  /** A projectile the server actually put in the world. */
  readonly shotFlew: boolean;
  /** Damage the server dealt off this cast. */
  readonly damaged: boolean;
  /** How the server ended the cast: 'Cancelled', 'Released', or none. */
  readonly ended: string | null;
}

/**
 * Commit a shot, press Esc `pressAfter` ticks into the wind-up, and report what
 * each side ended up believing.
 *
 * Everything is real: the wire format, the server's input queue, the client's
 * prediction. Only the clock is driven by hand.
 */
async function withdraw(options: {
  readonly delayTicks: number;
  readonly pressAfter: number;
  readonly abilityId: string;
  /** How the player asks: the Esc key, or walking away from the blow. */
  readonly by?: 'esc' | 'move';
  /** Set when the press is deliberately after the loose, so no bar is expected. */
  readonly late?: boolean;
}): Promise<Withdrawn> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 7,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  let damaged = false;
  let ended: string | null = null;
  const line = new UnreliableChannel(transport.connect(), () => ({ ...PERFECT_WIRE, delayTicks: options.delayTicks }), Rng.fromSeed(1), (bytes, direction) => {
    // Inbound only: the tap sees both directions now, and these all decode a
    // *server* message.
    if (direction !== 'in') return;
    const message = decodeServerMessage(bytes);
    if (message.type === ServerMessageType.CombatResult && message.damage > 0) damaged = true;
    if (message.type === ServerMessageType.CastEnded) {
      ended = message.reason === CastEndReason.Cancelled ? 'Cancelled' : 'Released';
    }
  });

  const client = new GameClient(line, {
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

  const ability = abilityById(options.abilityId);
  if (!ability) throw new Error(`no ${options.abilityId}`);

  // Settle the session: a few ticks so the welcome, the stats and the first
  // deltas have all landed and the client knows who it is.
  let tick = 0;
  let walking = false;
  const advance = async (): Promise<void> => {
    tick += 1;
    line.deliver(tick);
    await settle();
    server.tick();
    client.advanceTick();
    const me = client.view().self;
    if (me) {
      client.sendInput(
        walking
          ? { moveX: 0, moveY: 1, facing: Math.PI / 2, buttons: 0 }
          : { moveX: 0, moveY: 0, facing: 0, buttons: 0 },
      );
    }
    line.deliver(tick);
    await settle();
  };
  for (let i = 0; i < 30 + options.delayTicks * 4; i++) await advance();

  const me = client.view().self;
  if (!me) throw new Error('never spawned');

  // Commit, aimed at a patch of ground well inside range so nothing but the
  // withdrawal decides the outcome.
  client.useAbility(options.abilityId, me.x + ability.range * 0.5, me.y);
  await advance();

  let barGone = false;
  let shotFlew = false;
  let pressed = false;
  const watch = (): void => {
    const view = client.view();
    if (!view.casts.some((cast) => cast.entityId === view.selfEntityId)) barGone = true;
    for (const entity of server.world.entities.values()) {
      if (entity.projectile) shotFlew = true;
    }
  };

  for (let i = 0; i < options.pressAfter; i++) {
    await advance();
    watch();
  }
  // The press. The client is still drawing its own bar at this point, which is
  // the player's whole basis for believing there is something to call off.
  const drawnBefore = client
    .view()
    .casts.some((cast) => cast.entityId === client.view().selfEntityId);
  if (!options.late) {
    expect(drawnBefore, 'the player was mid-wind-up when they asked to withdraw').toBe(true);
  }
  if ((options.by ?? 'esc') === 'move') {
    // Walking away is the other withdrawal (spec 079), and the interesting one:
    // it sends no message of its own. The client drops the bar the moment it
    // puts a move vector on an input, and the server decides when that input
    // lands.
    walking = true;
  } else {
    client.cancelCast();
  }
  pressed = true;
  if ((options.by ?? 'esc') === 'move') {
    // The bar goes on the next input, which the loop below sends.
    await advance();
  }
  barGone = !client
    .view()
    .casts.some((cast) => cast.entityId === client.view().selfEntityId);

  // Long enough for the cast to have released and any shot to have flown.
  for (let i = 0; i < ability.windupTicks + 90 + options.delayTicks * 4; i++) {
    await advance();
    watch();
  }
  expect(pressed).toBe(true);

  client.disconnect();
  return { pressedAfter: options.pressAfter, barGone, shotFlew, damaged, ended };
}

/**
 * A cast that has to turn first, with nobody withdrawing from anything.
 *
 * Spec 065 starts a cast in `Turning`, and the wind-up clock does not start
 * until the body is facing its aim -- so `releaseTick` is provisional and gets
 * re-stamped later. The client predicts a release at `now + windupTicks` with no
 * turn in it at all. If it also *stops drawing* at that predicted release, the
 * bar vanishes while the server is still winding up, and the shot lands after.
 *
 * That is the reported symptom exactly, and it needs no latency and no cancel.
 */
async function turnThenShoot(aimBehind: boolean): Promise<{
  readonly barGoneAtTick: number | null;
  readonly firedAtTick: number | null;
}> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 7,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const line = new UnreliableChannel(transport.connect(), () => ({ ...PERFECT_WIRE, delayTicks: 0 }), Rng.fromSeed(1), () => undefined);
  const client = new GameClient(line, {
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

  const ability = abilityById('ranged.shot');
  if (!ability) throw new Error('no ranged.shot');

  let tick = 0;
  const advance = async (facing: number): Promise<void> => {
    tick += 1;
    line.deliver(tick);
    await settle();
    server.tick();
    client.advanceTick();
    if (client.view().self) client.sendInput({ moveX: 0, moveY: 0, facing, buttons: 0 });
    line.deliver(tick);
    await settle();
  };
  // Settled, and facing +x.
  for (let i = 0; i < 30; i++) await advance(0);

  const me = client.view().self;
  if (!me) throw new Error('never spawned');

  // Aimed behind the body, so the server has to turn all the way round before
  // the wind-up starts; or straight ahead, as the control.
  const aimX = aimBehind ? me.x - ability.range * 0.5 : me.x + ability.range * 0.5;
  client.useAbility('ranged.shot', aimX, me.y);

  let barGoneAtTick: number | null = null;
  let firedAtTick: number | null = null;
  let sawBar = false;
  for (let i = 0; i < ability.windupTicks + 200; i++) {
    await advance(0);
    const view = client.view();
    const drawn = view.casts.some((cast) => cast.entityId === view.selfEntityId);
    if (drawn) sawBar = true;
    if (sawBar && !drawn && barGoneAtTick === null) barGoneAtTick = tick;
    for (const entity of server.world.entities.values()) {
      if (entity.projectile && firedAtTick === null) firedAtTick = tick;
    }
  }
  client.disconnect();
  return { barGoneAtTick, firedAtTick };
}

describe('a wind-up that has to turn first (spec 090)', () => {
  it('keeps the bar up until the blow actually lands', async () => {
    const ahead = await turnThenShoot(false);
    const behind = await turnThenShoot(true);
    console.log('aimed ahead ->', JSON.stringify(ahead));
    console.log('aimed behind ->', JSON.stringify(behind));

    for (const [label, result] of [['ahead', ahead], ['behind', behind]] as const) {
      expect(result.firedAtTick, `${label}: the shot flew`).not.toBeNull();
      expect(result.barGoneAtTick, `${label}: the bar was drawn then dropped`).not.toBeNull();
      // The bar must not vanish while the blow is still coming.
      expect(result.barGoneAtTick ?? 0, `${label}: bar outlasts the loose`).toBeGreaterThanOrEqual(
        result.firedAtTick ?? 0,
      );
    }
  }, 60_000);
});

describe('withdrawing over a wire that takes time (spec 090)', () => {
  const SHOT = 'ranged.shot';
  const windup = abilityById(SHOT)?.windupTicks ?? 0;

  it('honours a withdrawal on a free connection', async () => {
    // The control: no latency, pressed halfway. This already worked.
    const result = await withdraw({ delayTicks: 0, pressAfter: Math.floor(windup / 2), abilityId: SHOT });
    expect(result.barGone).toBe(true);
    expect(result.ended).toBe('Cancelled');
    expect(result.shotFlew).toBe(false);
    expect(result.damaged).toBe(false);
  }, 30_000);

  /**
   * The bug as reported: the bar goes, and the arrow flies anyway.
   *
   * Pressed with a third of the wind-up still to run -- comfortably early from
   * the player's side -- on a connection no worse than an ordinary one.
   */
  it('honours a withdrawal made in time, at a latency a real player has', async () => {
    for (const delayTicks of [3, 9, 15]) {
      const result = await withdraw({
        delayTicks,
        pressAfter: Math.floor(windup * 0.66),
        abilityId: SHOT,
      });
      const seen = `${delayTicks} ticks each way: ${JSON.stringify(result)}`;
      // The player saw the bar go. That is not in question -- the client drops
      // its predicted cast synchronously.
      expect(result.barGone, seen).toBe(true);
      // So nothing may be thrown, and nothing may be hurt.
      expect(result.shotFlew, seen).toBe(false);
      expect(result.damaged, seen).toBe(false);
      expect(result.ended, seen).toBe('Cancelled');
    }
  }, 60_000);

  it('honours walking away from a blow, which sends no message at all', async () => {
    for (const delayTicks of [0, 9]) {
      for (const fraction of [0.3, 0.9]) {
        const result = await withdraw({
          delayTicks,
          pressAfter: Math.max(1, Math.floor(windup * fraction)),
          abilityId: SHOT,
          by: 'move',
        });
        const seen = `move at ${fraction} of the wind-up, ${delayTicks}t each way: ${JSON.stringify(result)}`;
        expect(result.barGone, seen).toBe(true);
        expect(result.shotFlew, seen).toBe(false);
        expect(result.damaged, seen).toBe(false);
      }
    }
  }, 120_000);

  /**
   * The other side of the same rule, and the one that must keep failing to
   * cancel: a press that genuinely comes after the loose.
   *
   * Spec 079 is explicit that a shot in the air is never called back, so this
   * is not a bug to be fixed -- it is the boundary the fix must not cross.
   */
  it('does not un-throw a shot already loosed', async () => {
    const result = await withdraw({ delayTicks: 0, pressAfter: windup + 6, abilityId: SHOT, late: true });
    expect(result.shotFlew).toBe(true);
    expect(result.ended).toBe('Released');
  }, 30_000);
});

/**
 * A withdrawal that catches up with the commit it is withdrawing from (spec
 * 092).
 *
 * Casts and cancels wait in separate queues on the connection, each held until
 * the input frame it was stamped after has been applied. `due` turns true for a
 * whole backlog at once -- and on any tick the input queue empties, `starved`
 * makes *everything* due -- so a request and a withdrawal issued a moment apart
 * routinely come due on the same tick. They then rode the same input, and one
 * of them was swallowed:
 *
 * - with nothing in progress, `cancelCast` found no cast, reported that it had
 *   cancelled nothing, and the commit went ahead on the same tick. The player
 *   clicked away, watched the bar vanish, and the arrow flew.
 * - with a cast in progress, the cancel worked and the *request* was dropped
 *   without a word -- no `castStarted`, no `castRejected`. The client pairs the
 *   n-th reply with the n-th request (spec 080), so every answer after it was
 *   attributed to the wrong press.
 *
 * Both go through the real server, because the collision is made by the two
 * queues and cannot be seen from `step` alone.
 */
describe('a withdrawal that shares a tick with its own commit (spec 092)', () => {
  const SHOT = 'ranged.shot';

  async function session(): Promise<{
    readonly server: GameServer;
    readonly client: GameClient;
    readonly advance: () => Promise<void>;
  }> {
    const transport = new LoopbackTransport();
    const server = new GameServer({
      seed: 11,
      transport,
      world: createWorldColliders([], []),
      terrain: FLAT_TERRAIN,
    });
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
    const advance = async (): Promise<void> => {
      server.tick();
      client.advanceTick();
      if (client.view().self) client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      await settle();
    };
    for (let i = 0; i < 30; i++) await advance();
    return { server, client, advance };
  }

  it('throws nothing when the cancel comes second', async () => {
    const { server, client, advance } = await session();
    const me = client.view().self;
    expect(me).not.toBeNull();
    if (!me) return;
    const ability = abilityById(SHOT);
    expect(ability).toBeDefined();
    if (!ability) return;

    // The order the report describes, compressed to its essentials: the swing is
    // asked for, and the player says no before the server has got to it.
    client.useAbility(SHOT, me.x + ability.range * 0.5, me.y);
    client.cancelCast();

    let shotFlew = false;
    for (let i = 0; i < ability.windupTicks + 60; i++) {
      await advance();
      for (const entity of server.world.entities.values()) {
        if (entity.projectile) shotFlew = true;
      }
    }

    expect(shotFlew, 'a withdrawn shot flew').toBe(false);
    expect(server.world.entities.get(client.view().selfEntityId)?.cast ?? null).toBeNull();
    // And the request was answered, so the next press is paired with its own
    // reply rather than this one's.
    expect(client.view().awaitingCast).toBe(false);
    client.disconnect();
  }, 30_000);

  it('still starts a cast when the cancel came first', async () => {
    const { server, client, advance } = await session();
    const me = client.view().self;
    expect(me).not.toBeNull();
    if (!me) return;
    const ability = abilityById(SHOT);
    expect(ability).toBeDefined();
    if (!ability) return;

    // Changing your mind and then committing to something is not the same as
    // committing and then changing your mind, and the tick they collide on is
    // not allowed to blur the two.
    client.cancelCast();
    client.useAbility(SHOT, me.x + ability.range * 0.5, me.y);

    let shotFlew = false;
    for (let i = 0; i < ability.windupTicks + 60; i++) {
      await advance();
      for (const entity of server.world.entities.values()) {
        if (entity.projectile) shotFlew = true;
      }
    }

    expect(shotFlew, 'a committed shot was eaten by an older cancel').toBe(true);
    expect(client.view().awaitingCast).toBe(false);
    client.disconnect();
  }, 30_000);

  it('answers a request that arrives with a cancel for a cast already running', async () => {
    const { server, client, advance } = await session();
    const me = client.view().self;
    expect(me).not.toBeNull();
    if (!me) return;
    const ability = abilityById(SHOT);
    expect(ability).toBeDefined();
    if (!ability) return;

    client.useAbility(SHOT, me.x + ability.range * 0.5, me.y);
    for (let i = 0; i < 4; i++) await advance();
    expect(server.world.entities.get(client.view().selfEntityId)?.cast ?? null).not.toBeNull();

    // Withdraw and immediately ask for another. Whatever the server decides
    // about the second press, it owes exactly one answer for it.
    client.cancelCast();
    client.useAbility(SHOT, me.x + ability.range * 0.5, me.y);
    for (let i = 0; i < ability.windupTicks + 60; i++) await advance();

    expect(client.view().awaitingCast, 'a request went unanswered').toBe(false);
    client.disconnect();
  }, 30_000);
});
