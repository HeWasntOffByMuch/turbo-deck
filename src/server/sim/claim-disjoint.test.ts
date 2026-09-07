/**
 * A claim on a body does not outlive that body (spec 279).
 *
 * Two places in the sim hold a claim on a named body across ticks -- a shot in
 * the air and a swing mid-wind-up -- and both used to re-derive "is my mark
 * still there" from the mark's *current* health every tick. That answer is
 * false while a player is a corpse and true again the instant they respawn, and
 * a respawn is a **teleport**: so the shot turned and followed them to the
 * spawn pad, and the swing landed on them standing at it.
 *
 * Everywhere else in the sim already got this right and is the model for it:
 * `settle` calms a monster on the tick its quarry hits zero health, and
 * `sweepConversations` re-asks holdability every broadcast. What those two do
 * once, these two now latch.
 *
 * Driven through the real `step` rather than by calling the passes directly,
 * for `attack-reach.test.ts`'s reason: every rule here lives in the interaction
 * between the death sweep (pass 4) and a pass above it, and a direct call would
 * prove nothing about the ordering that is the whole bug.
 *
 * The respawn is reproduced rather than imported: `server.respawn` is on the
 * transport side and needs a `Connection`, so what these tests do is the two
 * things it does that the sim can see -- health back to full, body somewhere
 * else -- which is exactly the state the sim is being asked about.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { computeEffectiveStats, projectileLifetimeTicks } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type Equipment,
  type PersistedPlayer,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { applyToTarget } from './abilities.js';
import {
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  specializations: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 600, y: 450, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentProgressionPoints: 0,
  health: 100,
  resource: 100,
};

const CHUNK = 100;

/** Where the spawn pad is, for these tests: a long way from any of the fights. */
const HOME = { x: 200, y: 100 } as const;

function activeAround(...points: readonly { x: number; y: number }[]): Set<string> {
  const keys = new Set<string>();
  for (const point of points) {
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        keys.add(chunkKeyOf(point.x + dx * CHUNK, point.y + dy * CHUNK, CHUNK));
      }
    }
  }
  return keys;
}

/** The ambient spawner off: these tests count `hit` events. */
function context(...points: readonly { x: number; y: number }[]): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: activeAround({ x: 600, y: 450 }, HOME, ...points),
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

function withPlayer(
  state: ServerWorldState,
  x: number,
  y: number,
  equipment: Equipment = EMPTY_EQUIPMENT,
): { state: ServerWorldState; id: number } {
  const result = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x, y, z: 0 },
    stats: computeEffectiveStats({ ...RECORD, equipment }),
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

/**
 * A monster, optionally already fighting somebody.
 *
 * Handing it a bare `targetId` is enough: `settle` commits it on the first tick
 * (spec 163), because a target arriving with no mood attached is something
 * outside the sim saying "fight this".
 */
function withMonster(
  state: ServerWorldState,
  typeId: string,
  x: number,
  y: number,
  targetId?: number,
): { state: ServerWorldState; id: number } {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no ${typeId}`);
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x, y, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  const next =
    targetId === undefined
      ? result.state
      : replaceEntity(result.state, { ...result.entity, targetId, anchor: { x, y } });
  return { state: next, id: result.entity.id };
}

function input(entityId: number, overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    entityId,
    seq: 1,
    moveX: 0,
    moveY: 0,
    facing: 0,
    buttons: 0,
    predictedX: 600,
    predictedY: 450,
    hasPrediction: true,
    seqSpan: 1,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    castTargetEntityId: 0,
    cancelCast: false,
    ...overrides,
  };
}

const shotIn = (state: ServerWorldState): ServerEntity | undefined =>
  [...state.entities.values()].find((entity) => entity.projectile !== null);

/** The body, or a failure that names it -- `!` is forbidden here and rightly. */
function bodyOf(state: ServerWorldState, id: number): ServerEntity {
  const entity = state.entities.get(id);
  if (!entity) throw new Error(`no entity ${id}`);
  return entity;
}

const hitsOn = (events: readonly ServerSimEvent[], id: number): number =>
  events.filter((event) => event.kind === 'hit' && event.targetId === id).length;

/** Ticks a shot of this row stays in the air, asked rather than written down. */
function flightTicks(abilityId: string): number {
  const spec = abilityById(abilityId)?.projectile;
  if (!spec) throw new Error(`no projectile on ${abilityId}`);
  return projectileLifetimeTicks(spec);
}

/**
 * Run until a shot is in the air, or give up.
 *
 * The slinger is driven by its own `monsterIntent` rather than by a scripted
 * input, so how many ticks it takes to close, turn and wind up is the table's
 * business and not this test's.
 */
function untilLoosed(
  state: ServerWorldState,
  ctx: StepContext,
  ticks = 400,
): ServerWorldState {
  let current = state;
  for (let i = 0; i < ticks; i++) {
    current = step(current, [], ctx).state;
    if (shotIn(current)) return current;
  }
  throw new Error('nothing was loosed');
}

/** Health to full and the body somewhere else: what `server.respawn` does. */
function respawn(state: ServerWorldState, id: number, at: { x: number; y: number }): ServerWorldState {
  const entity = bodyOf(state, id);
  return replaceEntity(state, {
    ...entity,
    position: { x: at.x, y: at.y, z: 0 },
    health: entity.stats.maxHealth,
  });
}

// ---------------------------------------------------------------------------

describe('a shot outlives its target but not its shooter', () => {
  it('leaves with the body that loosed it, rather than gluing itself to the mark', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const slinger = withMonster(state, 'slinger', 850, 450, player.id);
    state = slinger.state;
    const ctx = context({ x: 850, y: 450 });

    let current = untilLoosed(state, ctx);
    // The shooter is killed while its star is in the air -- which is a sweep,
    // so the body is simply gone from the next tick's world.
    const without = new Map(current.entities);
    without.delete(slinger.id);
    current = { ...current, entities: without };

    // It goes on the very next tick, and never converges on the body it was
    // chasing: before this it flew, tracked, arrived and could do neither, so
    // it sat exactly on the player at a gap of zero for 230 ticks.
    let closest = Infinity;
    let alive = 0;
    for (let i = 0; i < flightTicks('ranged.star') + SERVER_TICK_RATE; i++) {
      current = step(current, [], ctx).state;
      const shot = shotIn(current);
      if (!shot) break;
      alive += 1;
      const self = current.entities.get(player.id);
      if (self) {
        closest = Math.min(closest, Math.hypot(shot.position.x - self.position.x, shot.position.y - self.position.y));
      }
    }
    expect(alive).toBe(0);
    expect(closest).toBe(Infinity);
  });

  it('still lands when its shooter is a dead player, who is still in the world', () => {
    // The other half of the rule, and the reason it is stated as "in the world"
    // rather than "alive": a player's entity is never swept, so their arrow is
    // still owned by somebody and still resolves.
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const mark = withMonster(state, 'dummy', 780, 450);
    state = mark.state;
    const ctx = context({ x: 780, y: 450 });

    let current = step(
      state,
      [
        input(player.id, {
          castAbilityId: 'ranged.shot',
          castTargetX: 780,
          castTargetY: 450,
          castTargetEntityId: mark.id,
        }),
      ],
      ctx,
    ).state;
    current = untilLoosed(current, ctx);
    current = replaceEntity(current, { ...bodyOf(current, player.id), health: 0 });

    let hits = 0;
    for (let i = 0; i < flightTicks('ranged.shot') + SERVER_TICK_RATE; i++) {
      const result = step(current, [], ctx);
      current = result.state;
      hits += hitsOn(result.events, mark.id);
      if (!shotIn(current)) break;
    }
    expect(hits).toBe(1);
  });
});

describe('a disjoint is permanent', () => {
  it('does not re-acquire a mark that died and respawned', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const slinger = withMonster(state, 'slinger', 850, 450, player.id);
    state = slinger.state;
    const ctx = context({ x: 850, y: 450 });

    let current = untilLoosed(state, ctx);
    const loosedAt = bodyOf(current, player.id).position;

    current = replaceEntity(current, { ...bodyOf(current, player.id), health: 0 });
    current = step(current, [], ctx).state;
    current = respawn(current, player.id, HOME);

    let hits = 0;
    let nearestToHome = Infinity;
    for (let i = 0; i < flightTicks('ranged.star') + SERVER_TICK_RATE; i++) {
      const result = step(current, [], ctx);
      current = result.state;
      hits += hitsOn(result.events, player.id);
      const shot = shotIn(current);
      if (!shot) break;
      nearestToHome = Math.min(nearestToHome, Math.hypot(shot.position.x - HOME.x, shot.position.y - HOME.y));
    }

    // It landed on nobody, and it never set off after them: the last aim stands,
    // which is what spec 079 says a disjointed shot does.
    expect(hits).toBe(0);
    expect(shotIn(current)).toBeUndefined();
    expect(nearestToHome).toBeGreaterThan(Math.hypot(loosedAt.x - HOME.x, loosedAt.y - HOME.y) / 2);
  });

  it('still refuses a bystander after it has lost its mark', () => {
    // Losing the body does not turn a single-target shot into a point one.
    // `targetEntityId` is what makes a shot single-target and is deliberately
    // left alone by the disjoint.
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const mark = withMonster(state, 'dummy', 900, 450);
    state = mark.state;
    const bystander = withMonster(state, 'dummy', 750, 450);
    state = bystander.state;
    const ctx = context({ x: 750, y: 450 }, { x: 900, y: 450 });

    let current = step(
      state,
      [
        input(player.id, {
          castAbilityId: 'ranged.shot',
          castTargetX: 900,
          castTargetY: 450,
          castTargetEntityId: mark.id,
        }),
      ],
      ctx,
    ).state;
    current = untilLoosed(current, ctx);
    // The mark dies before the arrow has passed the body standing in front of it.
    current = replaceEntity(current, { ...bodyOf(current, mark.id), health: 0 });

    let struckBystander = 0;
    for (let i = 0; i < flightTicks('ranged.shot') + SERVER_TICK_RATE; i++) {
      const result = step(current, [], ctx);
      current = result.state;
      struckBystander += hitsOn(result.events, bystander.id);
      if (!shotIn(current)) break;
    }
    expect(struckBystander).toBe(0);
  });
});

describe('a shot loosed by a wind-up that lost its mark is born disjointed', () => {
  it('does not chase a mark that died and respawned inside the wind-up', () => {
    // The same bug arriving through the other door. A wind-up is long enough for
    // a mark to die and come back inside it, and `launchProjectile` used to open
    // every shot at `disjointed: false` -- so the cast correctly gave up on the
    // body and then handed a fresh shot its id.
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const slinger = withMonster(state, 'slinger', 850, 450, player.id);
    state = slinger.state;
    const ctx = context({ x: 850, y: 450 });

    // Wound up, and not yet loosed.
    let current = state;
    let left = 0;
    for (let i = 0; i < 400; i++) {
      current = step(current, [], ctx).state;
      const cast = current.entities.get(slinger.id)?.cast;
      if (cast && cast.phase === 0 && cast.releaseTick > current.tick) {
        left = cast.releaseTick - current.tick;
        break;
      }
    }
    expect(left).toBeGreaterThan(1);
    expect(shotIn(current)).toBeUndefined();

    current = replaceEntity(current, { ...bodyOf(current, player.id), health: 0 });
    current = step(current, [], ctx).state;
    current = respawn(current, player.id, HOME);

    let hits = 0;
    let nearestToHome = Infinity;
    for (let i = 0; i < left + flightTicks('ranged.star') + SERVER_TICK_RATE; i++) {
      const result = step(current, [], ctx);
      current = result.state;
      hits += hitsOn(result.events, player.id);
      const shot = shotIn(current);
      if (shot) {
        nearestToHome = Math.min(
          nearestToHome,
          Math.hypot(shot.position.x - HOME.x, shot.position.y - HOME.y),
        );
      }
    }
    expect(hits).toBe(0);
    // It was loosed at the ground the mark fell on and stayed there: never
    // anywhere near the spawn pad.
    expect(nearestToHome).toBeGreaterThan(300);
  });
});

describe('a wind-up that has seen its mark fall lands on nobody', () => {
  /**
   * A ravager mid-wind-up on the player, and how many ticks of it are left.
   *
   * The wind-up is where the window is: past the turn a cast is deliberately
   * *not* called off by its target dying (spec 079), and `landOnTarget` misses
   * on a corpse -- so the only body this could ever have gone wrong for is one
   * that is not a corpse any more by the release.
   */
  function midWindup(): { state: ServerWorldState; ctx: StepContext; player: number; left: number } {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ravager = withMonster(state, 'ravager', 640, 450, player.id);
    state = ravager.state;
    const ctx = context();

    for (let i = 0; i < 400; i++) {
      state = step(state, [], ctx).state;
      const cast = state.entities.get(ravager.id)?.cast;
      if (cast && cast.phase === 0 && cast.releaseTick > state.tick) {
        return { state, ctx, player: player.id, left: cast.releaseTick - state.tick };
      }
    }
    throw new Error('the ravager never wound up');
  }

  it('misses a mark that died mid-wind-up and respawned before the release', () => {
    const { state, ctx, player, left } = midWindup();
    expect(left).toBeGreaterThan(1);

    let current = replaceEntity(state, { ...bodyOf(state, player), health: 0 });
    current = step(current, [], ctx).state;
    current = respawn(current, player, HOME);

    let hits = 0;
    let missed = 0;
    for (let i = 0; i < left + SERVER_TICK_RATE; i++) {
      const result = step(current, [], ctx);
      current = result.state;
      hits += hitsOn(result.events, player);
      missed += result.events.filter((event) => event.kind === 'attackMissed').length;
    }
    // The swing still happens -- it runs its clock and spends its cooldown --
    // and it finds nobody.
    expect(hits).toBe(0);
    expect(missed).toBeGreaterThan(0);
  });

  it('still lands on a mark that only walked away, which is spec 221 untouched', () => {
    const { state, ctx, player, left } = midWindup();

    // Out of reach but alive: nothing has been lost, so the blow that was in
    // range when it began still lands.
    const walked = bodyOf(state, player);
    let current = replaceEntity(state, { ...walked, position: { ...walked.position, x: walked.position.x - 300 } });

    let hits = 0;
    for (let i = 0; i < left + SERVER_TICK_RATE; i++) {
      const result = step(current, [], ctx);
      current = result.state;
      hits += hitsOn(result.events, player);
    }
    expect(hits).toBeGreaterThan(0);
  });
});

describe('a corpse takes no blow', () => {
  const EMBER: Equipment = { ...EMPTY_EQUIPMENT, skill1: 'sigil.emberToss' };

  it('is not caught by a burst, and so never dies twice', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450, EMBER);
    state = player.state;
    // Off the line of flight, so the pot cannot strike it directly and has to
    // reach it through the burst -- which is the path that lacked the guard.
    const mark = withMonster(state, 'dummy', 800, 520);
    state = mark.state;
    const ctx = context({ x: 800, y: 450 }, { x: 800, y: 520 });

    let current = step(
      state,
      [
        input(player.id, {
          castAbilityId: 'skill.emberToss',
          castTargetX: 800,
          castTargetY: 450,
        }),
      ],
      ctx,
    ).state;

    let deaths = 0;
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      // Zeroed only once the pot is nearly down: exactly the state a body killed
      // earlier in this same tick is in when the burst pass runs, since the
      // sweep is two passes later.
      const shot = shotIn(current);
      if (shot && Math.hypot(800 - shot.position.x, 450 - shot.position.y) < 3) {
        current = replaceEntity(current, { ...bodyOf(current, mark.id), health: 0 });
      }
      const result = step(current, [], ctx);
      current = result.state;
      deaths += result.events.filter((event) => event.kind === 'died' && event.entityId === mark.id).length;
      hits += hitsOn(result.events, mark.id);
      if (!current.entities.has(mark.id)) break;
    }

    // The corpse took no damage, so it raised no second `died` -- which is what
    // `creditDeaths` was being paid twice off, and what the sweep's `killedBy`
    // was taking the loot credit from.
    expect(hits).toBe(0);
    expect(deaths).toBe(0);
  });

  it('is refused by `applyToTarget` itself, with the Rng and both bodies untouched', () => {
    // The backstop, asserted directly: the guard is a property of the one seam
    // every hostile landing goes through rather than of the four that remembered.
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const mark = withMonster(state, 'dummy', 620, 450);
    state = mark.state;

    const attacker = bodyOf(state, player.id);
    const corpse = { ...bodyOf(state, mark.id), health: 0 };
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');

    const before = state.rng.getState();
    const result = applyToTarget(slash, attacker, corpse, state.rng, 10);
    expect(result.events).toEqual([]);
    expect(result.target).toBe(corpse);
    expect(result.attacker).toBe(attacker);
    expect(result.rng.getState()).toEqual(before);
  });
});

describe('a burst is drawn at the radius it hits at', () => {
  it('sends the shaped radius on the effect, not the authored one', () => {
    /** The `effect` radius an Ember Toss reports for a caster with this shaping. */
    function drawn(spellRadiusPct: number): number {
      let state = createWorldState(4);
      const spawned = spawnEntity(state, {
        kind: EntityKindValue.Player,
        typeId: 'player',
        ownerPlayerId: 'p1',
        position: { x: 600, y: 450, z: 0 },
        stats: (() => {
          const base = computeEffectiveStats({
            ...RECORD,
            equipment: { ...EMPTY_EQUIPMENT, skill1: 'sigil.emberToss' },
          });
          return { ...base, traits: { ...base.traits, spellRadiusPct } };
        })(),
        radius: 16,
        zoneId: 'greenmarch',
      });
      state = spawned.state;
      const ctx = context({ x: 800, y: 450 });

      let current = step(
        state,
        [
          input(spawned.entity.id, {
            castAbilityId: 'skill.emberToss',
            castTargetX: 800,
            castTargetY: 450,
          }),
        ],
        ctx,
      ).state;

      for (let i = 0; i < 400; i++) {
        const result = step(current, [], ctx);
        current = result.state;
        const burst = result.events.find(
          (event) => event.kind === 'effect' && event.effectId === 'skill.emberToss.impact',
        );
        if (burst && burst.kind === 'effect') return burst.radius;
      }
      throw new Error('the pot never burst');
    }

    const authored = abilityById('skill.emberToss')?.radius;
    if (authored === undefined) throw new Error('no radius on skill.emberToss');

    expect(drawn(0)).toBeCloseTo(authored, 6);
    // The ring a shaped caster draws is the ring a shaped caster hits at. It
    // used to be the authored one either way, so the picture was wrong for
    // exactly the builds that bought the shaping.
    expect(drawn(0.5)).toBeCloseTo(authored * 1.5, 6);
  });
});
