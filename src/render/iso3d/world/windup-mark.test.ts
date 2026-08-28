/**
 * A blow whose mark is gone, over the real wire (spec 155).
 *
 * Two reports, one idea. A standing attack order loosed the arrow at a grazer
 * that had already left the world, because dropping the target said nothing
 * about the wind-up it had asked for a moment earlier. And right-clicking a
 * *different* body mid-wind-up set the target and nothing else, so the swing
 * landed on the mark you had just stopped attacking and the click you actually
 * made waited out its follow-through.
 *
 * Everything here is the shipped code, the same way `withdraw-order.test.ts`
 * is: a real `GameServer`, the real binary protocol over a loopback, and
 * `view.ts`'s own loop -- `withdrawIfMarkGone` first, then `autoAttack` decides
 * and `moveIntent` steers, one input frame out. The retarget does exactly what
 * `issueOrder`'s attackable branch does: withdraw if the id changed, then take
 * the new mark.
 *
 * The weapon is the bow throughout, because the fault is only visible on one
 * that puts something into the world -- a melee swing resolves on its own
 * release, so there is nothing left flying to point at a corpse -- and because
 * an arrow in the world is an unambiguous assertion.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../../sim/collision.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../../../server/config.js';
import { abilityById } from '../../../server/data/abilities.js';
import { facesAim } from '../../../server/sim/abilities.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { turnToward } from '../../../server/sim/movement.js';
import { CastEndReason, type ServerEntity } from '../../../server/sim/types.js';
import { FLAT_TERRAIN } from '../../../server/world/terrain.js';
import { GameClient } from '../../../server/client/game-client.js';
import { createWorldPredictor } from '../../../server/client/prediction.js';
import { moveIntent } from './intent.js';
import { autoAttack } from './target.js';
import { windupLostItsMarkIn } from './withdraw.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const SWING_ID = 'ranged.shot';

function makeSession(seed: number): { server: GameServer; client: GameClient } {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed,
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
  return { server, client };
}

/** Ours, in the world, right now. */
function ourShotIsFlying(server: GameServer, selfId: number): boolean {
  const live = server.world.entities as Map<number, ServerEntity>;
  for (const entity of live.values()) {
    if (entity.projectile && entity.projectile.ownerId === selfId) return true;
  }
  return false;
}

interface Killed {
  /** Ticks of wind-up the server had run when the mark died. */
  readonly windupTicksSeen: number;
  /** The wind-up's full length, so the kill is provably inside it. */
  readonly windupTicks: number;
  /** True if a shot of ours ever reached the world. */
  readonly shotFlew: boolean;
  /** How the server ended the cast, if it ended it at all. */
  readonly ended: string | null;
  /** The tick the server's own cast went away, and the one it would have released on. */
  readonly freedAtTick: number | null;
  readonly releaseTick: number | null;
}

/**
 * Commit through a standing attack order, then kill the mark `atFraction` of
 * the way through the swing -- inside the wind-up, or past the attack point.
 *
 * The mark is killed on the server and swept by `step`'s own pass, which is
 * what makes this the real scenario: since spec 076 a monster leaves the world
 * on the tick it dies, so what the client sees is a hole in `view.entities`
 * rather than a body at zero health, and it sees it up to a delta late.
 *
 * `ticksPerFrame` is the Play tab's accumulator: one tick a frame is a machine
 * keeping up, and more is one that is not.
 */
async function killMarkMidSwing(options: {
  readonly atFraction: number;
  readonly ticksPerFrame: number;
  /** Wait for the attack point first, so the blow has already happened. */
  readonly afterAttackPoint: boolean;
}): Promise<Killed> {
  const { server, client } = makeSession(11);

  let ended: string | null = null;
  client.onCastEnded((end) => {
    if (end.entityId !== client.view().selfEntityId) return;
    ended = end.reason === CastEndReason.Cancelled ? 'Cancelled' : 'Released';
  });

  let targetId: number | null = null;
  let destination: { x: number; y: number } | null = null;
  let facing = 0;
  let windupSeen = 0;
  let windupTicks = 0;
  let releaseTick: number | null = null;
  let killed = false;
  let shotFlew = false;
  let freedAtTick: number | null = null;

  /** Ticks to keep watching after the kill: the whole swing and a flight. */
  const after = SERVER_TICK_RATE * 4;
  let sinceKill = 0;

  for (let frame = 0; frame < 4000 && (!killed || sinceKill < after); frame++) {
    for (let n = 0; n < options.ticksPerFrame; n++) {
      server.tick();
      client.advanceTick();
      if (killed) sinceKill += 1;

      const live = server.world.entities as Map<number, ServerEntity>;
      {
        const view = client.view();
        if (!view.self || !view.stats) continue;

        // The mark stands still and takes it: this is about the withdrawal, not
        // about a chase.
        if (targetId === null && !killed) {
          client.equip('mainHand', 'bow.hunting');
          if (view.stats.basicAttackId !== SWING_ID) continue;
          const self = live.get(view.selfEntityId);
          if (!self) continue;
          // Well inside the swing's 420 reach, so `autoAttack` never asks for a
          // step: in range from the first tick.
          server.spawnEntities('grazer', self.position.x + 200, self.position.y, 1);
          targetId = [...live.values()].find((e) => e.id !== view.selfEntityId)?.id ?? null;
          continue;
        }

        // Immortal on our side: the run must not end on the player going down.
        const me = live.get(view.selfEntityId);
        if (me) live.set(view.selfEntityId, { ...me, health: me.stats.maxHealth });
      }

      if (killed) {
        const selfId = client.view().selfEntityId;
        if (ourShotIsFlying(server, selfId)) shotFlew = true;
        if (freedAtTick === null && !live.get(selfId)?.cast) freedAtTick = server.world.tick;
      }

      // --- view.ts's loop -------------------------------------------------
      //
      // The withdrawal first, off its own read, exactly as `sendInput` runs it.
      if (windupLostItsMarkIn(client.view())) client.cancelCast();

      const view = client.view();
      if (!view.self || !view.stats) continue;
      const entity = targetId === null ? undefined : view.entities.find((e) => e.id === targetId);
      const radius = (targetId === null ? undefined : live.get(targetId)?.radius) ?? 22;
      const swing = abilityById(SWING_ID);
      if (targetId !== null) {
        const decision = autoAttack({
          self: view.self,
          selfHealth: view.entities.find((e) => e.id === view.selfEntityId)?.health ?? 1,
          target: entity
            ? { id: entity.id, x: entity.x, y: entity.y, radius, health: entity.health }
            : null,
          range: swing?.range ?? 0,
          rooted: view.selfRoot !== null,
      staggered: view.selfStaggered,
          pending: view.awaitingCast,
          readyAtTick: view.cooldowns[SWING_ID] ?? 0,
          aligned: !entity ? true : facesAim(view.self, facing, { x: entity.x, y: entity.y }),
          tick: view.estimatedTick,
        });
        if (decision.drop || !entity) targetId = null;
        else {
          destination = decision.chaseTo;
          if (decision.attack) client.useAbility(SWING_ID, entity.x, entity.y, entity.id, radius);
        }
      }

      // The kill, measured off the server's own cast so "mid-wind-up" and "past
      // the attack point" are facts rather than guesses.
      const serverCast = live.get(client.view().selfEntityId)?.cast ?? null;
      if (!killed && serverCast) {
        windupTicks = Math.max(1, serverCast.releaseTick - serverCast.windupStartTick);
        releaseTick = serverCast.releaseTick;
        if (serverCast.phase === 0) windupSeen += 1;
        const due = options.afterAttackPoint
          ? serverCast.committed
          : windupSeen >= Math.max(1, Math.round(windupTicks * options.atFraction));
        if (due && targetId !== null) {
          const mark = live.get(targetId);
          // Killed outright and left to `step`'s own sweep, which is what takes
          // it out of the world and out of the next delta.
          if (mark) live.set(targetId, { ...mark, health: 0 });
          killed = true;
        }
      }

      const intent = moveIntent({
        held: new Set<string>(),
        self: view.self,
        destination,
        route: null,
        facing,
        castAim: view.selfRoot,
        targetAim: entity ? { x: entity.x, y: entity.y } : null,
      });
      facing = turnToward(facing, intent.facing, view.stats.turnRate, SERVER_TICK_RATE);
      client.sendInput({
        moveX: intent.moveX,
        moveY: intent.moveY,
        facing: intent.facing,
        buttons: 0,
      });
      if (intent.arrived) destination = null;
    }
    await settle();
  }

  client.disconnect();
  return { windupTicksSeen: windupSeen, windupTicks, shotFlew, ended, freedAtTick, releaseTick };
}

describe('a mark that dies while the swing is still a proposal (spec 155)', () => {
  for (const ticksPerFrame of [1, 3]) {
    for (const atFraction of [0.3, 0.5, 0.8]) {
      it(`throws nothing: mark killed at ${atFraction * 100}% of the wind-up, ${ticksPerFrame} tick(s) a frame`, async () => {
        const result = await killMarkMidSwing({ atFraction, ticksPerFrame, afterAttackPoint: false });
        const seen = JSON.stringify(result);

        // The run has to have been the scenario, or the assertion below is
        // vacuous: a wind-up was genuinely running when the grazer died.
        expect(result.windupTicksSeen, seen).toBeGreaterThan(0);
        expect(result.windupTicksSeen, seen).toBeLessThan(result.windupTicks);

        expect(result.shotFlew, seen).toBe(false);
        expect(result.ended, seen).toBe('Cancelled');
        // And the legs come back on the server before the arrow would have
        // left, rather than at the end of a follow-through nobody is watching.
        expect(result.freedAtTick, seen).not.toBeNull();
        expect(result.freedAtTick ?? 0, seen).toBeLessThan(result.releaseTick ?? 0);
      }, 30_000);
    }
  }

  /**
   * The other side of the boundary, and the reason the rule reads the phase at
   * all (spec 144): past the attack point the arrow is already in the air, so
   * there is nothing to prevent -- and cutting the follow-through short would be
   * the game buying the player movement they never asked for.
   */
  it('lets the follow-through run when the mark dies after the attack point', async () => {
    const result = await killMarkMidSwing({
      atFraction: 1,
      ticksPerFrame: 1,
      afterAttackPoint: true,
    });
    const seen = JSON.stringify(result);
    expect(result.shotFlew, seen).toBe(true);
    expect(result.ended, seen).toBe('Released');
  }, 30_000);
});

interface Switched {
  /** Ticks of wind-up the server had run on the first mark when the click landed. */
  readonly windupTicksSeen: number;
  readonly windupTicks: number;
  /** How the server ended the abandoned cast. */
  readonly ended: string | null;
  /** The tick the abandoned swing would have finished its backswing on. */
  readonly abandonedEndTick: number | null;
  /** The tick a cast naming the *new* mark began, if one ever did. */
  readonly committedToNewAtTick: number | null;
  /**
   * Damage the first mark took, which must be none -- and whether it left the
   * world, because a mark that was killed outright is missing rather than
   * damaged, and a health reading alone would score that as unharmed.
   */
  readonly firstMarkLost: number;
  readonly firstMarkGone: boolean;
  /** Withdrawals the server made on our behalf, so a re-click can be counted. */
  readonly cancels: number;
}

/**
 * Right-click a second body part-way through a wind-up aimed at the first --
 * or, with `sameMark`, right-click the body already being attacked, on every
 * tick of it.
 *
 * Both marks are in reach and close together, so nothing here is about walking
 * or about a long turn: what is being measured is whether the new order is
 * acted on now or after the old one has finished.
 */
async function retargetMidWindup(options: { readonly sameMark: boolean }): Promise<Switched> {
  const { server, client } = makeSession(23);

  let cancels = 0;
  let ended: string | null = null;
  client.onCastEnded((end) => {
    if (end.entityId !== client.view().selfEntityId) return;
    if (end.reason === CastEndReason.Cancelled) cancels += 1;
    if (ended === null) ended = end.reason === CastEndReason.Cancelled ? 'Cancelled' : 'Released';
  });

  let first: number | null = null;
  let second: number | null = null;
  let firstMaxHealth = 0;
  let firstMarkLost = 0;
  let firstMarkGone = false;
  let targetId: number | null = null;
  let destination: { x: number; y: number } | null = null;
  let facing = 0;
  let windupSeen = 0;
  let windupTicks = 0;
  let abandonedEndTick: number | null = null;
  let clicked = false;
  let committedToNewAtTick: number | null = null;
  let sinceClick = 0;
  /**
   * The clicked-through swing is over: with `sameMark` that is the whole run.
   *
   * Deliberately not "and then watch for a few seconds", because the marks are
   * only immortal by being healed between ticks and a blow that takes one to
   * zero is swept inside the same `step` -- so a longer tail would eventually
   * be measuring the *other* rule, the one the tests above pin. What this run
   * asserts is bounded: through a whole wind-up and its backswing, re-clicking
   * the body you are already attacking costs nothing.
   */
  let spammedSwingOver = false;

  const after = SERVER_TICK_RATE * 4;

  for (let frame = 0; frame < 4000 && !spammedSwingOver && (!clicked || sinceClick < after); frame++) {
    server.tick();
    client.advanceTick();
    if (clicked) sinceClick += 1;

    const live = server.world.entities as Map<number, ServerEntity>;
    {
      const view = client.view();
      if (!view.self || !view.stats) {
        await settle();
        continue;
      }

      if (first === null) {
        client.equip('mainHand', 'bow.hunting');
        if (view.stats.basicAttackId !== SWING_ID) {
          await settle();
          continue;
        }
        const self = live.get(view.selfEntityId);
        if (!self) {
          await settle();
          continue;
        }
        // Side by side and both well inside reach, so the switch costs neither
        // a walk nor a half-turn -- only the withdrawal being tested.
        server.spawnEntities('grazer', self.position.x + 220, self.position.y - 60, 1);
        server.spawnEntities('grazer', self.position.x + 220, self.position.y + 60, 1);
        const mobs = [...live.values()].filter((e) => e.id !== view.selfEntityId);
        first = mobs[0]?.id ?? null;
        second = mobs[1]?.id ?? null;
        firstMaxHealth = mobs[0]?.health ?? 0;
        targetId = first;
        await settle();
        continue;
      }

      const me = live.get(view.selfEntityId);
      if (me) live.set(view.selfEntityId, { ...me, health: me.stats.maxHealth });
    }

    // The mark being switched *to* is immortal, and so is the one being
    // re-clicked: what is measured here is the order, and a grazer that dies
    // would withdraw the wind-up for the other reason entirely -- which is the
    // rule the tests above pin, and would make the count below say nothing.
    // The mark being switched *away* from is left mortal on purpose, so
    // "the swing you called off did not land on it" is a real reading.
    if (second !== null) {
      const mob = live.get(second);
      if (mob) live.set(second, { ...mob, health: mob.stats.maxHealth });
    }
    if (first !== null) {
      const mob = live.get(first);
      if (mob && options.sameMark) live.set(first, { ...mob, health: mob.stats.maxHealth });
      else if (mob) firstMarkLost = Math.max(firstMarkLost, firstMaxHealth - mob.health);
      else if (!options.sameMark) firstMarkGone = true;
    }

    // --- view.ts's loop ---------------------------------------------------
    if (windupLostItsMarkIn(client.view())) client.cancelCast();

    const view = client.view();
    if (!view.self || !view.stats) {
      await settle();
      continue;
    }
    const entity = targetId === null ? undefined : view.entities.find((e) => e.id === targetId);
    const radius = (targetId === null ? undefined : live.get(targetId)?.radius) ?? 22;
    const swing = abilityById(SWING_ID);
    if (targetId !== null) {
      const decision = autoAttack({
        self: view.self,
        selfHealth: view.entities.find((e) => e.id === view.selfEntityId)?.health ?? 1,
        target: entity
          ? { id: entity.id, x: entity.x, y: entity.y, radius, health: entity.health }
          : null,
        range: swing?.range ?? 0,
        rooted: view.selfRoot !== null,
      staggered: view.selfStaggered,
        pending: view.awaitingCast,
        readyAtTick: view.cooldowns[SWING_ID] ?? 0,
        aligned: !entity ? true : facesAim(view.self, facing, { x: entity.x, y: entity.y }),
        tick: view.estimatedTick,
      });
      if (decision.drop || !entity) targetId = null;
      else {
        destination = decision.chaseTo;
        if (decision.attack) client.useAbility(SWING_ID, entity.x, entity.y, entity.id, radius);
      }
    }

    const serverCast = live.get(view.selfEntityId)?.cast ?? null;
    if (serverCast && !clicked) {
      windupTicks = Math.max(1, serverCast.releaseTick - serverCast.windupStartTick);
      if (serverCast.phase === 0) windupSeen += 1;
    }

    // The click, half way through the wind-up. `issueOrder`'s attackable
    // branch: withdraw if the mark changed, take the new one, and let the
    // auto-attack own the walking from here.
    if (!clicked && windupSeen >= Math.round(windupTicks * 0.5) && windupSeen > 0) {
      abandonedEndTick = serverCast?.endTick ?? null;
      const picked = options.sameMark ? first : second;
      if (picked !== targetId) client.cancelCast();
      targetId = picked;
      destination = null;
      clicked = true;
    }
    // ...and with `sameMark` the click is made on every tick of the wind-up,
    // because the thing being asserted is that re-clicking your own mark costs
    // nothing however hard it is done.
    if (options.sameMark && clicked) {
      if (serverCast) {
        if (first !== targetId) client.cancelCast();
        targetId = first;
      } else if (sinceClick > 0) {
        spammedSwingOver = true;
      }
    }

    if (clicked && !options.sameMark && serverCast && serverCast.targetEntityId === second) {
      committedToNewAtTick ??= server.world.tick;
    }

    const intent = moveIntent({
      held: new Set<string>(),
      self: view.self,
      destination,
      route: null,
      facing,
      castAim: view.selfRoot,
      targetAim: entity ? { x: entity.x, y: entity.y } : null,
    });
    facing = turnToward(facing, intent.facing, view.stats.turnRate, SERVER_TICK_RATE);
    client.sendInput({
      moveX: intent.moveX,
      moveY: intent.moveY,
      facing: intent.facing,
      buttons: 0,
    });
    if (intent.arrived) destination = null;
    await settle();
  }

  client.disconnect();
  return {
    windupTicksSeen: windupSeen,
    windupTicks,
    ended,
    abandonedEndTick,
    committedToNewAtTick,
    firstMarkLost,
    firstMarkGone,
    cancels,
  };
}

describe('switching marks mid-wind-up (spec 155)', () => {
  it('withdraws from the old blow and commits to the new one without waiting it out', async () => {
    const result = await retargetMidWindup({ sameMark: false });
    const seen = JSON.stringify(result);

    // Genuinely mid-wind-up, or the rest is vacuous.
    expect(result.windupTicksSeen, seen).toBeGreaterThan(0);
    expect(result.windupTicksSeen, seen).toBeLessThan(result.windupTicks);

    expect(result.ended, seen).toBe('Cancelled');
    // The body you stopped attacking is not hit by the swing you called off --
    // neither damaged nor killed by it.
    expect(result.firstMarkLost, seen).toBe(0);
    expect(result.firstMarkGone, seen).toBe(false);
    // And the click is acted on now rather than after the wind-up and the
    // backswing it interrupted -- which is the report, in one number.
    expect(result.committedToNewAtTick, seen).not.toBeNull();
    expect(result.abandonedEndTick, seen).not.toBeNull();
    expect(result.committedToNewAtTick ?? 0, seen).toBeLessThan(result.abandonedEndTick ?? 0);
  }, 30_000);

  it('costs nothing to re-click the mark you are already attacking', async () => {
    const result = await retargetMidWindup({ sameMark: true });
    const seen = JSON.stringify(result);
    expect(result.windupTicksSeen, seen).toBeGreaterThan(0);
    // Spam-clicking your own target must not cancel every wind-up it starts,
    // which is what an unguarded withdrawal in `issueOrder` would do.
    expect(result.cancels, seen).toBe(0);
  }, 30_000);
});
