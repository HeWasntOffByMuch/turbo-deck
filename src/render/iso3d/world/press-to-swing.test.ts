/**
 * Pressing an ability means "stop and swing" (spec 258).
 *
 * Two halves, `combat.test.ts`'s split and for its reason. The pure half pins
 * the rule, because a rule is cheaper to pin down than a session. The wired half
 * drives a real `GameClient` against a real `GameServer` over a real loopback
 * through the Play tab's own `swingHold` -> `moveIntent` -> `sendInput` chain,
 * because the thing being claimed is *what happens when a player who is walking
 * presses attack* -- and that only exists once both ends are running.
 *
 * The wired half is the one that matters, and the measurement it was written
 * from is the whole reason the rule exists: with a direction held, **173 swings
 * were asked for and 173 were refused as `withdrawn`, none started.** Every
 * assertion in Node passed throughout, because none of them held a key.
 */

import { describe, expect, it } from 'vitest';

import { BROADCAST_EVERY_N_TICKS, SERVER_TICK_RATE } from '../../../server/config.js';
import { GameClient } from '../../../server/client/game-client.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import {
  MOVE_EAST,
  MOVE_NORTH,
  MOVE_WEST,
} from '../../../ui/input/actions.js';
import { committedPhase } from './cast.js';
import { heldAfterHold, moveIntent, NO_HOLD, swingHold } from './intent.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ===========================================================================
// The rule.
// ===========================================================================

const held = (...actions: string[]): ReadonlySet<string> => new Set(actions);

describe('what a press takes out of the player’s hands (spec 258)', () => {
  it('takes the directions that were already down', () => {
    const hold = swingHold({
      previous: NO_HOLD,
      held: held(MOVE_NORTH, MOVE_EAST),
      pressed: held(MOVE_NORTH, MOVE_EAST),
      casting: true,
      committed: false,
    });
    expect([...hold].sort()).toEqual([MOVE_EAST, MOVE_NORTH].sort());
  });

  it('takes nothing that is not a direction', () => {
    // A held ability key, a held camera key: neither asks the body to walk, so
    // neither is a thing a swing has to take away.
    const hold = swingHold({
      previous: NO_HOLD,
      held: held('skill.1', 'camera.rotateLeft'),
      pressed: held('skill.1', 'camera.rotateLeft'),
      casting: true,
      committed: false,
    });
    expect(hold.size).toBe(0);
  });

  it('leaves a direction pressed after the commit alone', () => {
    // The decision this game is built on (spec 079). The hold is an **edge** --
    // what was down when the button went down -- precisely so that reaching for
    // a direction *during* a wind-up still withdraws from it.
    const hold = swingHold({
      previous: NO_HOLD,
      held: held(MOVE_NORTH),
      pressed: null,
      casting: true,
      committed: false,
    });
    expect(hold.size).toBe(0);
  });

  it('lets go of a key that was released, so pressing it again withdraws', () => {
    const first = swingHold({
      previous: NO_HOLD,
      held: held(MOVE_NORTH),
      pressed: held(MOVE_NORTH),
      casting: true,
      committed: false,
    });
    expect(first.size).toBe(1);
    // Let go...
    const released = swingHold({
      previous: first,
      held: held(),
      pressed: null,
      casting: true,
      committed: false,
    });
    expect(released.size).toBe(0);
    // ...and press again: a fresh ask, and nothing holds it.
    const again = swingHold({
      previous: released,
      held: held(MOVE_NORTH),
      pressed: null,
      casting: true,
      committed: false,
    });
    expect(again.size).toBe(0);
  });

  it('ends at the attack point, not at the end of the cast', () => {
    // The one that would be easy to get wrong, and costly: past the attack point
    // a held direction is no longer a withdrawal, it is the walk-out of the
    // follow-through that Agility buys. Holding the keys through the backswing
    // would take that away from anybody who was already moving.
    const during = swingHold({
      previous: held(MOVE_NORTH),
      held: held(MOVE_NORTH),
      pressed: null,
      casting: true,
      committed: true,
    });
    expect(during.size).toBe(0);
  });

  it('ends when the cast does, and when there never was one', () => {
    // Which is also what a *refused* press leaves behind: the request was
    // answered `onCooldown` or `notEnoughResource`, no cast exists, and the keys
    // must come back rather than stranding a player who cannot walk.
    expect(
      swingHold({
        previous: held(MOVE_NORTH),
        held: held(MOVE_NORTH),
        pressed: null,
        casting: false,
        committed: false,
      }).size,
    ).toBe(0);
  });

  it('lets a second press re-take a key released and re-pressed mid-swing', () => {
    const first = swingHold({
      previous: NO_HOLD,
      held: held(MOVE_NORTH),
      pressed: held(MOVE_NORTH),
      casting: true,
      committed: false,
    });
    const again = swingHold({
      previous: first,
      held: held(MOVE_NORTH, MOVE_WEST),
      pressed: held(MOVE_NORTH, MOVE_WEST),
      casting: true,
      committed: false,
    });
    expect([...again].sort()).toEqual([MOVE_NORTH, MOVE_WEST].sort());
  });

  it('hands the held set back untouched when it is holding nothing', () => {
    // Identity, not a copy: this runs every frame, and the ordinary case is an
    // empty hold.
    const down = held(MOVE_NORTH);
    expect(heldAfterHold(down, NO_HOLD)).toBe(down);
    expect([...heldAfterHold(down, held(MOVE_NORTH))]).toEqual([]);
  });
});

// ===========================================================================
// The same rule, through both ends.
// ===========================================================================

interface Wired {
  readonly server: GameServer;
  readonly client: GameClient;
}

async function wire(): Promise<Wired> {
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
  return { server, client };
}

interface Walked {
  readonly started: number;
  readonly refused: number;
  /** Frames the body actually moved, before the press and after the cast ended. */
  readonly movedBefore: number;
  readonly movedAfter: number;
  /** Frames it moved while a cast was live. Must be zero. */
  readonly movedDuring: number;
}

/**
 * Walk north the whole time, press attack once, and report what happened.
 *
 * The key is never released, which is the case the rule is for: a player kiting
 * on WASD does not let go to swing.
 */
async function walkAndSwing(pressAt: number, ticks: number): Promise<Walked> {
  const { server, client } = await wire();
  const down = new Set<string>([MOVE_NORTH]);
  let hold: ReadonlySet<string> = NO_HOLD;
  let pressed: ReadonlySet<string> | null = null;
  let facing = 0;
  let started = 0;
  let refused = 0;
  let movedBefore = 0;
  let movedAfter = 0;
  let movedDuring = 0;
  let ended = false;
  let last: { readonly x: number; readonly y: number } | null = null;

  client.onCastStarted(() => {
    started += 1;
  });
  client.onCastRejected(() => {
    refused += 1;
  });

  for (let i = 0; i < ticks; i++) {
    server.tick();
    client.advanceTick();
    const view = client.view();
    const me = view.self;
    if (!me) {
      await settle();
      continue;
    }
    if (i === pressAt) {
      // The set the press was made with (spec 264). Immediate here, so it is
      // simply what is down -- a *queued* press carries the set it was made
      // with several frames earlier.
      pressed = down;
      client.useAbility('melee.slash', me.x, me.y - 1000);
    }
    const own = view.casts.find((cast) => cast.entityId === view.selfEntityId) ?? null;
    hold = swingHold({
      previous: hold,
      held: down,
      pressed,
      casting: view.selfRoot !== null,
      committed: own !== null && committedPhase(own.phase),
    });
    pressed = null;
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
    client.sendInput({ moveX: intent.moveX, moveY: intent.moveY, facing: intent.facing, buttons: 0 });
    await settle();

    const after = client.view();
    const now = after.self;
    const moved = last && now ? Math.hypot(now.x - last.x, now.y - last.y) > 1e-6 : false;
    const casting = after.selfRoot !== null;
    if (!casting && started > 0) ended = true;
    if (moved) {
      if (casting) movedDuring += 1;
      else if (ended) movedAfter += 1;
      else movedBefore += 1;
    }
    last = now ? { x: now.x, y: now.y } : last;
    facing = intent.facing;
  }
  return { started, refused, movedBefore, movedAfter, movedDuring };
}

describe('walking and attacking, over a real loopback (spec 258)', () => {
  it('lands the swing, stops for it, and walks on afterwards', async () => {
    const run = await walkAndSwing(10, SERVER_TICK_RATE * 2);

    // The measurement this rule was written from. It read 0 and 173.
    expect(run.started).toBeGreaterThan(0);
    expect(run.refused).toBe(0);

    // It really was walking first, so "it stopped" means something.
    expect(run.movedBefore).toBeGreaterThan(0);
    // Stopped for the whole cast: the wind-up because the press took the key,
    // the follow-through because the cancel point had not been reached.
    expect(run.movedDuring).toBe(0);
    // And went on its way without a second press.
    expect(run.movedAfter).toBeGreaterThan(0);
  });
});
