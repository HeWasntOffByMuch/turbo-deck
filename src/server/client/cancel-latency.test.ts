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
import { decodeServerMessage } from '../net/messages.js';
import { ServerMessageType } from '../net/protocol.js';
import { GameServer } from '../server.js';
import { CastEndReason } from '../sim/types.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { GameClient } from './game-client.js';
import { createWorldPredictor } from './prediction.js';
import type { Channel } from '../net/transport.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Holds every frame, in both directions, for a fixed number of ticks. */
class DelayLine implements Channel {
  private readonly outbound: { at: number; bytes: Uint8Array }[] = [];
  private readonly inbound: { at: number; bytes: Uint8Array }[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private tick = 0;

  constructor(
    private readonly inner: Channel,
    private readonly delayTicks: number,
    private readonly watch: (bytes: Uint8Array) => void,
  ) {
    inner.onMessage((bytes) => {
      this.inbound.push({ at: this.tick + this.delayTicks, bytes });
    });
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  send(bytes: Uint8Array): void {
    this.outbound.push({ at: this.tick + this.delayTicks, bytes: new Uint8Array(bytes) });
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.inner.onClose(handler);
  }

  close(): void {
    this.inner.close();
  }

  deliver(tick: number): void {
    this.tick = tick;
    while (this.outbound.length > 0 && (this.outbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.outbound.shift();
      if (frame) this.inner.send(frame.bytes);
    }
    while (this.inbound.length > 0 && (this.inbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.inbound.shift();
      if (!frame) break;
      this.watch(frame.bytes);
      this.handler?.(frame.bytes);
    }
  }
}

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
  const line = new DelayLine(transport.connect(), options.delayTicks, (bytes) => {
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
