/**
 * Walking out of a blow, on both sides of the tick it commits (spec 094).
 *
 * The first half is the scenario the bug report describes, end to end and with
 * nothing faked: a body in range of its mark, facing it, with a standing attack
 * order; the swing commits; and part-way through the wind-up the player
 * right-clicks empty ground. The shot must not go off. It holds -- and it held
 * before the fix below, at 30/50/80% of a wind-up now long enough to act inside,
 * which is what moved the search onto the tick the commit *begins*.
 *
 * The second half is that tick: a request that arrives on the same input as a
 * step. It is where the reported symptom actually lived, and it fails without
 * the rule in `step`.
 *
 * Everything here is the shipped code. The server is a real `GameServer`, the
 * wire is the real binary protocol over a loopback, and the loop is `view.ts`'s
 * own -- `autoAttack` decides, `moveIntent` steers, one input frame goes out --
 * with the ground click doing exactly what `onMouseDown`'s ground branch does:
 * drop the target, take a destination, and `cancelCast()`.
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

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface WalkedAway {
  /** Ticks of wind-up the server had run when the player clicked away. */
  readonly windupTicksSeen: number;
  /** The wind-up's full length, so the click is provably inside it. */
  readonly windupTicks: number;
  /** True if the server put a projectile in the world after the click. */
  readonly shotFlew: boolean;
  /** How the server ended the cast, if it ended it at all. */
  readonly ended: string | null;
  /** True once the body had actually left the spot it committed from. */
  readonly walked: boolean;
}

/**
 * Commit through a standing attack order, then walk away `atFraction` of the
 * way through the wind-up.
 *
 * `ticksPerFrame` is the Play tab's accumulator: one tick a frame is a machine
 * keeping up, and more is one that is not. The wire is drained once a frame,
 * not once a tick, because that is the shape the real client has.
 */
async function walkAwayMidWindup(options: {
  readonly weapon: string;
  readonly atFraction: number;
  readonly ticksPerFrame: number;
}): Promise<WalkedAway> {
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

  let ended: string | null = null;
  client.onCastEnded((end) => {
    if (end.entityId !== client.view().selfEntityId) return;
    ended = end.reason === CastEndReason.Cancelled ? 'Cancelled' : 'Released';
  });

  let targetId: number | null = null;
  let destination: { x: number; y: number } | null = null;
  let facing = 0;
  let windupSeen = 0;
  let clickedAway = false;
  let shotFlew = false;
  let walked = false;
  let committedAt: { x: number; y: number } | null = null;

  const swingId = options.weapon === 'bow.hunting' ? 'ranged.shot' : 'ranged.star';
  const windupTicks = abilityById(swingId)?.windupTicks ?? 0;
  /** Ticks to keep watching after the click: the whole wind-up and a flight. */
  const after = windupTicks + SERVER_TICK_RATE * 3;
  let sinceClick = 0;

  for (let frame = 0; frame < 4000 && (!clickedAway || sinceClick < after); frame++) {
    for (let n = 0; n < options.ticksPerFrame; n++) {
      server.tick();
      client.advanceTick();
      if (clickedAway) sinceClick += 1;

      const view = client.view();
      if (!view.self || !view.stats) continue;
      const live = server.world.entities as Map<number, ServerEntity>;

      // The mark stands still and takes it: this is about the withdrawal, not
      // about a chase.
      if (targetId === null && !clickedAway) {
        client.equip('mainHand', options.weapon);
        if (view.stats.basicAttackId !== swingId) continue;
        const self = live.get(view.selfEntityId);
        if (!self) continue;
        // Well inside the swing's reach, so `autoAttack` never asks for a step:
        // in range from the first tick, exactly as the report describes.
        server.spawnEntities('grazer', self.position.x + 200, self.position.y, 1);
        targetId = [...live.values()].find((e) => e.id !== view.selfEntityId)?.id ?? null;
        continue;
      }

      // Immortal on both sides: neither body may end the run early.
      const me = live.get(view.selfEntityId);
      if (me) live.set(view.selfEntityId, { ...me, health: me.stats.maxHealth });
      if (targetId !== null) {
        const mob = live.get(targetId);
        if (mob) live.set(targetId, { ...mob, health: mob.stats.maxHealth });
      }

      // Anything the server threw after the click is the failure this test is
      // looking for.
      if (clickedAway) {
        for (const entity of live.values()) {
          if (entity.projectile && entity.projectile.ownerId === view.selfEntityId) shotFlew = true;
        }
        if (committedAt) {
          const now = live.get(view.selfEntityId);
          if (now && Math.hypot(now.position.x - committedAt.x, now.position.y - committedAt.y) > 4) {
            walked = true;
          }
        }
      }

      // --- view.ts's loop ------------------------------------------------
      const entity = targetId === null ? undefined : view.entities.find((e) => e.id === targetId);
      const radius = (targetId === null ? undefined : live.get(targetId)?.radius) ?? 22;
      const swing = abilityById(swingId);
      if (targetId !== null) {
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
          aligned: !entity ? true : facesAim(view.self, facing, { x: entity.x, y: entity.y }),
          tick: view.estimatedTick,
        });
        if (decision.drop || !entity) targetId = null;
        else {
          destination = decision.chaseTo;
          if (decision.attack) client.useAbility(swingId, entity.x, entity.y, entity.id, radius);
        }
      }

      // The click. Part-way into a wind-up the *server* is actually running --
      // measured off its own cast, so "mid-wind-up" is not a guess.
      const serverCast = live.get(view.selfEntityId)?.cast ?? null;
      if (!clickedAway && serverCast) {
        windupSeen += 1;
        if (windupSeen >= Math.max(1, Math.round(windupTicks * options.atFraction))) {
          const self = live.get(view.selfEntityId);
          committedAt = self ? { x: self.position.x, y: self.position.y } : null;
          // `onMouseDown`, empty-ground branch: the order is let go, a move
          // order is taken, and the blow is withdrawn from explicitly.
          targetId = null;
          destination = { x: view.self.x - 260, y: view.self.y + 60 };
          client.cancelCast();
          clickedAway = true;
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
  return { windupTicksSeen: windupSeen, windupTicks, shotFlew, ended, walked };
}

describe('walking away from a wind-up an attack order committed', () => {
  for (const ticksPerFrame of [1, 3]) {
    for (const atFraction of [0.3, 0.5, 0.8]) {
      it(`throws nothing: clicked away at ${atFraction * 100}% of the wind-up, ${ticksPerFrame} tick(s) a frame`, async () => {
        const result = await walkAwayMidWindup({
          weapon: 'bow.hunting',
          atFraction,
          ticksPerFrame,
        });
        const seen = JSON.stringify(result);

        // The run has to have been the scenario, or the assertion below is
        // vacuous: a wind-up was genuinely running when the player clicked.
        expect(result.windupTicksSeen, seen).toBeGreaterThan(0);
        expect(result.windupTicksSeen, seen).toBeLessThan(result.windupTicks);

        expect(result.shotFlew, seen).toBe(false);
        expect(result.ended, seen).toBe('Cancelled');
        expect(result.walked, seen).toBe(true);
      }, 30_000);
    }
  }
});

interface Stepped {
  /** True if the server began a wind-up off the request. */
  readonly started: boolean;
  /** True if a shot of ours ever reached the world. */
  readonly shotFlew: boolean;
  /** Refusals the server sent back, by reason. */
  readonly rejects: readonly string[];
}

/**
 * Ask for an ability on a frame that is also walking, and stop walking at once.
 *
 * `view.ts`'s `castNow` gives up the move order and the attack order before it
 * asks -- but not the keys, so a hotbar press taken while running sends exactly
 * this input. The stop is what makes it matter: the wind-up used to begin on the
 * very tick the body asked to be elsewhere, and it was only ever called off
 * again by the *next* input carrying a vector. There isn't one here.
 */
async function commitWhileStepping(options: {
  readonly stepsAfter: number;
}): Promise<Stepped> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 5,
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

  const swingId = 'ranged.shot';
  const windupTicks = abilityById(swingId)?.windupTicks ?? 0;
  let asked = false;
  let sinceAsk = 0;
  let started = false;
  let shotFlew = false;

  for (let tick = 0; tick < options.stepsAfter + windupTicks + SERVER_TICK_RATE * 3; tick++) {
    server.tick();
    client.advanceTick();
    const view = client.view();
    if (!view.self || !view.stats) {
      await settle();
      continue;
    }
    const live = server.world.entities as Map<number, ServerEntity>;
    if (asked) {
      sinceAsk += 1;
      if (live.get(view.selfEntityId)?.cast) started = true;
      for (const entity of live.values()) {
        if (entity.projectile && entity.projectile.ownerId === view.selfEntityId) shotFlew = true;
      }
    }

    // Walking, and then the press -- on the frame the vector is still going out.
    const walking = !asked && tick >= options.stepsAfter;
    if (walking && tick === options.stepsAfter + 2) {
      const self = live.get(view.selfEntityId);
      client.useAbility(swingId, (self?.position.x ?? 0) + 200, self?.position.y ?? 0);
      asked = true;
    }
    // The step stops the instant the ability is asked for, so nothing arriving
    // later can be what called the cast off.
    const stepping = walking || (asked && sinceAsk === 0);
    client.sendInput({
      moveX: stepping ? -1 : 0,
      moveY: 0,
      facing: 0,
      buttons: 0,
    });
    await settle();
  }

  client.disconnect();
  return { started, shotFlew, rejects };
}

describe('a commit that rides the same input as a step (spec 094)', () => {
  for (const stepsAfter of [30, 45, 60]) {
    it(`throws nothing, and says why: asked ${stepsAfter} ticks in`, async () => {
      const result = await commitWhileStepping({ stepsAfter });
      const seen = JSON.stringify(result);

      expect(result.shotFlew, seen).toBe(false);
      expect(result.started, seen).toBe(false);
      // Answered rather than dropped: the client pairs the n-th reply with the
      // n-th request (spec 080).
      expect(result.rejects, seen).toEqual(['withdrawn']);
    }, 30_000);
  }
});
