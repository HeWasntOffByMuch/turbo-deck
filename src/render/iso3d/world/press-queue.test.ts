/**
 * A press that waits for the swing (spec 264).
 *
 * Two halves, `press-to-swing.test.ts`'s split and for its reason. The pure half
 * pins the rule; the wired half drives a real `GameClient` against a real
 * `GameServer` through the Play tab's own `startAim` -> queue -> `drainPress` ->
 * `useAbility` chain, because the thing being claimed is *what happens when a
 * player presses a skill during their own swing* -- and that only exists once
 * both ends are running.
 *
 * The wired half carries its own control, and it has to: every assertion in it
 * is that a refusal did **not** happen, and a run in which nothing was pressed
 * scores a flawless zero on all of them. So each case is run twice -- once
 * through the queue and once sending on the press, which is what shipped -- and
 * the control has to produce the `alreadyCasting` the queue removes.
 */

import { describe, expect, it } from 'vitest';

import { BROADCAST_EVERY_N_TICKS } from '../../../server/config.js';
import { GameClient } from '../../../server/client/game-client.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { CastPhase, type ServerEntity } from '../../../server/sim/types.js';
import { MOVE_NORTH } from '../../../ui/input/actions.js';
import { heldAfterHold, moveIntent, NO_HOLD, swingHold } from './intent.js';
import { committedPhase } from './cast.js';
import { drainPress, type QueuedPress } from './press-queue.js';

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

// ===========================================================================
// The rule.
// ===========================================================================

const press = (abilityId: string, ...down: string[]): QueuedPress => ({
  abilityId,
  held: new Set(down),
});

const FREE = { rooted: false, staggered: false, pending: false, ready: true };

describe('a press waiting for the body (spec 264)', () => {
  it('has nothing to do with nothing queued', () => {
    expect(drainPress({ queued: null, ...FREE })).toEqual({ send: null, queued: null });
  });

  it('sends at once when the body is free', () => {
    const waiting = press('self.hearthdraught');
    expect(drainPress({ queued: waiting, ...FREE })).toEqual({ send: waiting, queued: null });
  });

  it('holds through each of the three gates, and only sends when all are clear', () => {
    // The same three `autoAttack` takes, and each has to be its own: a break
    // *clears* the cast it interrupted so `rooted` cannot stand in for
    // `staggered` (spec 173), and a request in flight has no cast behind it at
    // all so neither of them can stand in for `pending` (spec 080).
    const waiting = press('skill.whirlwind');
    for (const gate of ['rooted', 'staggered', 'pending'] as const) {
      const step = drainPress({ queued: waiting, ...FREE, [gate]: true });
      expect(step, gate).toEqual({ send: null, queued: waiting });
    }
    expect(drainPress({ queued: waiting, ...FREE }).send).toBe(waiting);
  });

  it('drops a press whose ability went on cooldown while it waited', () => {
    // A second press, made during the first one's wind-up. What a press waits
    // for is the body and never the timer, so this is dropped where it stands
    // rather than parked -- `castOrder`'s rule for the same situation.
    const waiting = press('self.hearthdraught');
    expect(drainPress({ queued: waiting, ...FREE, ready: false })).toEqual({
      send: null,
      queued: null,
    });
    // ...but only on a tick it would otherwise have been sent. While the body
    // is busy the answer can still change, so it is still waiting.
    expect(drainPress({ queued: waiting, ...FREE, rooted: true, ready: false }).queued).toBe(
      waiting,
    );
  });

  it('carries the directions the press was made with, not the ones held now', () => {
    // The field exists for exactly one case, and it is the case that would be
    // wrong without it: press, then decide to run. A direction pressed *after*
    // the press is a withdrawal (spec 079), which is what pressing it means.
    const waiting = press('self.hearthdraught', MOVE_NORTH);
    const step = drainPress({ queued: waiting, ...FREE });
    expect([...(step.send?.held ?? [])]).toEqual([MOVE_NORTH]);
  });
});

describe('the swing hold, raised at the send (spec 264)', () => {
  it('suppresses a direction that was down at the press', () => {
    const hold = swingHold({
      previous: NO_HOLD,
      held: new Set([MOVE_NORTH]),
      pressed: new Set([MOVE_NORTH]),
      casting: true,
      committed: false,
    });
    expect([...hold]).toEqual([MOVE_NORTH]);
  });

  it('leaves a direction pressed after the press alone', () => {
    // The queued press was made with nothing down; the player then reached for
    // a key while it waited. Suppressing that would cost them most of a second
    // of walking they asked for.
    const hold = swingHold({
      previous: NO_HOLD,
      held: new Set([MOVE_NORTH]),
      pressed: new Set<string>(),
      casting: true,
      committed: false,
    });
    expect(hold.size).toBe(0);
  });

  it('drops one that was released between the press and the send', () => {
    const hold = swingHold({
      previous: NO_HOLD,
      held: new Set<string>(),
      pressed: new Set([MOVE_NORTH]),
      casting: true,
      committed: false,
    });
    expect(hold.size).toBe(0);
  });
});

// ===========================================================================
// The same rule, through both ends.
// ===========================================================================

/** A self-cast every character carries, so nothing has to be equipped for it. */
const FLASK = 'self.hearthdraught';

interface Pressed {
  /** Refusals the server sent back, by reason. */
  readonly rejects: readonly string[];
  /** Whether the server ever started the flask. */
  readonly landed: boolean;
  /** The phase the body's own swing was in when the press was made. */
  readonly pressedDuring: string;
  /**
   * Frames the body moved while the **flask's** cast was live. Must be zero.
   *
   * The flask's rather than any cast's, because the swing before it is one a
   * walking player is entitled to leave: the hold ends at the attack point, so
   * a held direction walks out of the follow-through, which is the thing
   * Agility buys (spec 258).
   */
  readonly movedDuring: number;
}

/**
 * Swing, press the flask partway through it, and report what came back.
 *
 * `queue: false` is the control: it sends on the press, which is what `castNow`
 * did.
 */
async function swingThenPress(options: {
  /** Press once the body's own cast has reached this phase. */
  readonly during: number;
  readonly queue: boolean;
  /** Hold this direction for the whole run, released never. */
  readonly walking: boolean;
}): Promise<Pressed> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const client = new GameClient(transport.connect(), { playerId: 'you' });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  for (let i = 0; i < BROADCAST_EVERY_N_TICKS * 3; i++) {
    server.tick();
    client.advanceTick();
  }
  await settle();

  const rejects: string[] = [];
  client.onCastRejected((_id, reason) => rejects.push(reason));

  const down = new Set<string>(options.walking ? [MOVE_NORTH] : []);
  let hold: ReadonlySet<string> = NO_HOLD;
  let castPress: ReadonlySet<string> | null = null;
  let queued: QueuedPress | null = null;
  let facing = 0;
  let swung = false;
  let pressedYet = false;
  let pressedDuring = 'never';
  let landed = false;
  let movedDuring = 0;
  let last: { x: number; y: number } | null = null;

  for (let i = 0; i < 220; i++) {
    server.tick();
    client.advanceTick();
    const view = client.view();
    const me = view.self;
    if (!me) {
      await settle();
      continue;
    }
    const live = server.world.entities as Map<number, ServerEntity>;
    const own = live.get(view.selfEntityId)?.cast ?? null;
    if (own?.abilityId === FLASK) landed = true;

    // One swing, to be pressed during. A press like any other, so it takes the
    // held direction out of the player's hands (spec 258) -- without that the
    // walking run refuses its own scaffolding as `withdrawn` and never gets a
    // cast to press during.
    if (!swung) {
      swung = true;
      castPress = new Set(down);
      client.useAbility('melee.slash', me.x, me.y - 1000);
    } else if (!pressedYet && own?.abilityId === 'melee.slash' && own.phase === options.during) {
      // `pressAbility`'s `'cast'` branch. `startAim` is not consulted: the flask
      // is off cooldown throughout, and what is being measured is the gate it
      // does *not* have.
      pressedYet = true;
      pressedDuring = own.phase === CastPhase.Backswing ? 'backswing' : 'windup';
      if (options.queue) queued = { abilityId: FLASK, held: new Set(down) };
      else {
        castPress = new Set(down);
        client.useAbility(FLASK, me.x, me.y, 0);
      }
    }

    if (options.queue) {
      const step = drainPress({
        queued,
        rooted: view.selfRoot !== null,
        staggered: view.selfStaggered,
        pending: view.awaitingCast,
        ready: view.estimatedTick >= (view.cooldowns[queued?.abilityId ?? ''] ?? 0),
      });
      queued = step.queued;
      if (step.send) {
        castPress = step.send.held;
        client.useAbility(step.send.abilityId, me.x, me.y, 0);
      }
    }

    const mine = view.casts.find((cast) => cast.entityId === view.selfEntityId) ?? null;
    hold = swingHold({
      previous: hold,
      held: down,
      pressed: castPress,
      casting: view.selfRoot !== null,
      committed: mine !== null && committedPhase(mine.phase),
    });
    castPress = null;
    const intent = moveIntent({
      held: heldAfterHold(down, hold),
      self: me,
      destination: null,
      route: null,
      facing,
      castAim: view.selfRoot,
      committed: view.selfCommitted,
      staggered: view.selfStaggered,
      dead: view.selfDead,
    });
    facing = intent.facing;
    client.sendInput({
      moveX: intent.moveX,
      moveY: intent.moveY,
      facing: intent.facing,
      buttons: 0,
    });
    await settle();

    const now = client.view().self;
    if (own?.abilityId === FLASK && last && now && Math.hypot(now.x - last.x, now.y - last.y) > 1e-6) {
      movedDuring += 1;
    }
    last = now ?? null;
  }

  client.disconnect();
  return { rejects, landed, pressedDuring, movedDuring };
}

describe('a press made during a swing, over the wire (spec 264)', () => {
  for (const during of [CastPhase.Windup, CastPhase.Backswing]) {
    const name = during === CastPhase.Windup ? 'wind-up' : 'follow-through';

    it(`lands when it was pressed during a ${name}`, async () => {
      const queued = await swingThenPress({ during, queue: true, walking: false });
      expect(queued.pressedDuring).not.toBe('never');
      expect(queued.rejects).toEqual([]);
      expect(queued.landed).toBe(true);

      // The control, and the reason the three assertions above mean anything:
      // sent on the press, this is the refusal the report was about.
      const now = await swingThenPress({ during, queue: false, walking: false });
      expect(now.pressedDuring).toBe(queued.pressedDuring);
      expect(now.rejects).toContain('alreadyCasting');
      expect(now.landed).toBe(false);
    }, 30_000);
  }

  it('lands for a player who is walking, and does not walk through its own cast', async () => {
    // Both halves of spec 258 carried across the wait: the directions held at
    // the press are still taken out of the player's hands when the request goes
    // out, so it is not refused as `withdrawn` -- and the body stays still for
    // the cast it belongs to rather than for the swing before it.
    const queued = await swingThenPress({
      during: CastPhase.Backswing,
      queue: true,
      walking: true,
    });
    expect(queued.rejects).toEqual([]);
    expect(queued.landed).toBe(true);
    expect(queued.movedDuring).toBe(0);
  }, 30_000);
});
