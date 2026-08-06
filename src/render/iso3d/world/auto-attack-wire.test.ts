/**
 * The standing attack order as a player sees it (spec 080).
 *
 * `auto-attack-loop.test.ts` drives the same two pure functions against the same
 * real tick, and every fault spec 080 exists for was invisible to it -- because
 * its client reads the *server's* own entity and therefore never disagrees with
 * it. Everything here is about that disagreement, so it needs the real
 * `GameClient`: its predicted cast, its request queue, its replica of the world.
 *
 * Frames, not ticks. The loopback delivers on a microtask, so a frame that runs
 * two ticks runs both of them before a single message lands -- and the Play tab
 * runs an accumulator, so multi-tick frames are ordinary and a slow machine
 * makes them long. A harness that drained the wire between every tick would be
 * measuring a connection nobody has.
 *
 * The quarry is mortal, which is the whole point. Held at full health this loop
 * looks perfect; it is dying that produces the fault, because a shot's damage
 * lands when the *shot* arrives and by then the next wind-up is most of the way
 * along.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../../sim/collision.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../../../server/config.js';
import { abilityById } from '../../../server/data/abilities.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { turnToward } from '../../../server/sim/movement.js';
import { CastEndReason, type ServerEntity } from '../../../server/sim/types.js';
import { FLAT_TERRAIN } from '../../../server/world/terrain.js';
import { GameClient } from '../../../server/client/game-client.js';
import { createWorldPredictor } from '../../../server/client/prediction.js';
import { moveIntent } from './intent.js';
import { autoAttack } from './target.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Fought {
  /** Ticks the order asked to swing. */
  readonly asks: number;
  /** Casts the server actually began, counted off its own entity. */
  readonly commits: number;
  /** Refusals the server sent back, by reason. */
  readonly rejects: readonly string[];
  /** Wind-ups of ours the server withdrew from: spec 080's headline. */
  readonly cancels: number;
  /** Bodies put down, so "nothing was withdrawn from" is not vacuous. */
  readonly kills: number;
  /** Ticks the server was casting and the client drew no bar. */
  readonly missing: number;
  /** Ticks the client walked while the server held it rooted. */
  readonly unrooted: number;
  readonly ticks: number;
}

/**
 * Runs a standing attack order exactly as `view.ts` runs it -- decide, steer,
 * send one input frame -- against a real server over a real loopback, putting a
 * fresh body up whenever the last one goes down.
 */
async function play(options: {
  readonly ticks: number;
  readonly weapon: string | null;
  readonly monster: string;
  /** Ticks per frame, cycled. `[1]` is a perfect 60Hz; `[10]` is a bad day. */
  readonly cadence: readonly number[];
}): Promise<Fought> {
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
  void client.connect();

  const rejects: string[] = [];
  client.onCastRejected((_abilityId, reason) => rejects.push(reason));
  let cancels = 0;
  client.onCastEnded((end) => {
    if (end.reason === CastEndReason.Cancelled && end.entityId === client.view().selfEntityId) {
      cancels += 1;
    }
  });

  let targetId: number | null = null;
  /** The last body we were told to attack, so a replacement can score the kill. */
  let previous: number | null = null;
  let facing = 0;
  let asks = 0;
  let commits = 0;
  let kills = 0;
  let missing = 0;
  let unrooted = 0;
  let sampled = 0;
  let ticks = 0;
  let lastServerCastKey: string | null = null;

  for (let frame = 0; ticks < options.ticks; frame++) {
    const perFrame = options.cadence[frame % options.cadence.length] ?? 1;
    // A frame's worth of ticks with nothing delivered between them, and then
    // the wire, which is the shape the Play tab's accumulator actually has.
    for (let n = 0; n < perFrame; n++) {
      ticks += 1;
      server.tick();
      client.advanceTick();

      const view = client.view();
      if (!view.self || !view.stats) continue;
      const live = server.world.entities as Map<number, ServerEntity>;

      if (targetId === null) {
        // Whatever ended the last order, the server is the one who says whether
        // the body is down: the view drops a target on the replica's word, and
        // the replica is up to three ticks behind.
        if (previous !== null) {
          const gone = live.get(previous);
          if (!gone || gone.health <= 0) kills += 1;
          if (gone) server.despawnEntity(previous);
          previous = null;
        }
        if (options.weapon) client.equip('mainHand', options.weapon);
        const self = live.get(view.selfEntityId);
        // The equip is a round trip: wait for the stat block to name the swing
        // the switch was clicked for, or the first body is fought bare-handed.
        if (!self || view.stats.basicAttackId === '') continue;
        if (options.weapon && view.stats.basicAttackId === 'melee.slash') continue;
        server.spawnEntities(options.monster, self.position.x + 300, self.position.y, 1);
        targetId = [...live.values()].find((e) => e.id !== view.selfEntityId)?.id ?? null;
        previous = targetId;
        continue;
      }

      const mob = live.get(targetId);
      // Immortal on our side only: a stalker's blows must not end the run.
      const me = live.get(view.selfEntityId);
      if (me) live.set(view.selfEntityId, { ...me, health: me.stats.maxHealth });

      // --- view.ts's own loop, in its own order --------------------------
      const swingId = view.stats.basicAttackId || 'melee.slash';
      const swing = abilityById(swingId);
      const entity = view.entities.find((e) => e.id === targetId);
      const radius = mob?.radius ?? 22;
      const decision = autoAttack({
        self: view.self,
        selfHealth: view.entities.find((e) => e.id === view.selfEntityId)?.health ?? 1,
        target: entity
          ? { id: entity.id, x: entity.x, y: entity.y, radius, health: entity.health }
          : null,
        range: swing?.range ?? 0,
        rooted: view.selfRoot !== null,
        pending: view.awaitingCast,
        readyAtTick: view.cooldowns[swingId] ?? 0,
        tick: view.estimatedTick,
      });
      if (decision.drop || !entity) {
        targetId = null;
      } else if (decision.attack) {
        asks += 1;
        client.useAbility(swingId, entity.x, entity.y, entity.id, radius);
      }
      const intent = moveIntent({
        held: new Set<string>(),
        self: view.self,
        destination: decision.chaseTo,
        route: null,
        facing,
        castAim: view.selfRoot,
      });
      facing = turnToward(facing, intent.facing, view.stats.turnRate, SERVER_TICK_RATE);
      client.sendInput({
        moveX: intent.moveX,
        moveY: intent.moveY,
        facing: intent.facing,
        buttons: 0,
      });

      // --- what the player is looking at ---------------------------------
      const after = client.view();
      const cast = live.get(after.selfEntityId)?.cast ?? null;
      const key = cast ? `${cast.abilityId}@${cast.startedTick}` : null;
      if (key && key !== lastServerCastKey) commits += 1;
      lastServerCastKey = key;

      sampled += 1;
      if (key && !after.casts.some((drawn) => drawn.entityId === after.selfEntityId)) missing += 1;
      if (key && !after.selfRoot) unrooted += 1;
    }
    await settle();
  }

  client.disconnect();
  return { asks, commits, rejects, cancels, kills, missing, unrooted, ticks: sampled };
}

/** Every basic attack in the game, and the one a bare hand falls back to. */
const WEAPONS: readonly (string | null)[] = [null, 'bow.hunting', 'stars.weighted'];

/**
 * One tick a frame is a machine keeping up; ten is one that is not, and it is
 * where the seam opens widest -- ten ticks of deciding and sending go by with
 * nothing delivered between them, so the replica the order reads is ten ticks
 * stale by the end of every frame.
 */
const CADENCES: readonly (readonly number[])[] = [[1], [2, 1, 1, 0, 3], [10]];

describe('a standing attack order, over a real session (spec 080)', () => {
  for (const cadence of CADENCES) {
    for (const weapon of WEAPONS) {
      const name = `${weapon ?? 'empty hands'} at ${cadence.join('/')} ticks a frame`;

      it(`withdraws from nothing and asks once a swing: ${name}`, async () => {
        const result = await play({ ticks: 600, weapon, monster: 'grazer', cadence });
        const seen = JSON.stringify(result);

        // The run has to have been a fight, or everything below is vacuous.
        expect(result.kills, seen).toBeGreaterThan(2);
        expect(result.commits, seen).toBeGreaterThan(8);

        // The headline. Before spec 080 this was one per kill with a ranged
        // weapon -- a bar that filled three-quarters of the way and vanished --
        // and zero with melee, because a swing resolves on its own release
        // while a shot resolves when it arrives.
        expect(result.cancels, seen).toBe(0);

        // One ask per swing, and nothing refused. Over a loopback the client's
        // mirror agrees with the server about nearly everything, so this is a
        // guard rather than a reproduction -- the `pending` gate that makes it
        // hold when they *disagree* is pinned directly in `target.test.ts`.
        // What it does catch is the loop asking twice for one commit, which is
        // what any future brake on the ask would break first.
        expect(result.asks - result.commits, seen).toBeLessThanOrEqual(1);
        expect(result.rejects, seen).toEqual([]);
      }, 30_000);
    }
  }

  /**
   * The one that has to hold at speed as well: a body that closes on the player
   * mid-fight moves the aim between swings, which is what puts a turn in front
   * of a wind-up and what makes the reach decision live.
   */
  it('holds up against something that fights back', async () => {
    for (const weapon of WEAPONS) {
      const result = await play({ ticks: 600, weapon, monster: 'stalker', cadence: [2, 1, 1, 0, 3] });
      const seen = `${weapon ?? 'empty hands'}: ${JSON.stringify(result)}`;
      expect(result.kills, seen).toBeGreaterThan(2);
      expect(result.cancels, seen).toBe(0);
      expect(result.rejects, seen).toEqual([]);
      // A bar for every blow, and no walking through one.
      expect(result.missing / result.ticks, seen).toBeLessThan(0.01);
      expect(result.unrooted / result.ticks, seen).toBeLessThan(0.01);
    }
  }, 60_000);
});
