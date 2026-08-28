/**
 * What a poise break actually stops (spec 173).
 *
 * Driven through the real `step`, for the reason `attack-cancel.test.ts` gives
 * about the attack point and for a sharper one here: until this file existed
 * every poise test in the tree called `applyPoiseDamage` directly and asserted
 * on the entity it handed back. All of them passed, and all of them passed
 * against a sim in which a broken body kept walking at full speed and swung
 * through its own stagger, because the pool and the flag were the only things
 * anybody had ever asked about.
 *
 * So the rule for this file is that nothing in it may call `applyPoiseDamage`,
 * `staggered` or `startCast` to establish the stagger. A body gets broken by a
 * blow, in a tick, and what it can do afterwards is read off the world state.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import {
  ActivityValue,
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

const STATS: EffectiveStats = { ...computeEffectiveStats(RECORD), spellPower: 1, critChance: 0 };
const CHUNK = 100;

function activeAround(x: number, y: number): Set<string> {
  const keys = new Set<string>();
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) keys.add(chunkKeyOf(x + dx * CHUNK, y + dy * CHUNK, CHUNK));
  }
  return keys;
}

function context(): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: activeAround(600, 450),
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

function input(entityId: number, overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    entityId,
    seq: 1,
    moveX: 0,
    moveY: 0,
    facing: 0,
    buttons: 0,
    predictedX: 0,
    predictedY: 0,
    hasPrediction: false,
    seqSpan: 1,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    castTargetEntityId: 0,
    cancelCast: false,
    ...overrides,
  };
}

/**
 * A world with a player and a monster standing on top of each other, and the
 * player already broken by a real blow.
 *
 * The break is produced by handing the *monster* enough stagger power to empty
 * the player's pool in one swing and then letting it hit. Reaching in to set
 * `activity` directly would be this file testing its own fixture -- the whole
 * point is that the sim's own path produces the state the gates read.
 */
function brokenPlayer(): {
  state: ServerWorldState;
  playerId: number;
  monsterId: number;
  tick: number;
  ctx: StepContext;
} {
  const ctx = context();
  let state = createWorldState(1);

  const spawnedPlayer = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: 600, y: 450, z: 0 },
    stats: STATS,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = spawnedPlayer.state;
  const playerId = spawnedPlayer.entity.id;

  const definition = monsterById('stalker');
  if (!definition) throw new Error('no stalker');
  const spawnedMonster = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'stalker',
    position: { x: 630, y: 450, z: 0 },
    stats: {
      ...definition.stats,
      traits: {
        // Enough to empty a starting player's 55-point pool in one blow, so the
        // break is a single event at a known tick rather than something that
        // emerges partway through a fight.
        ...definition.stats.traits,
        staggerPower: 500,
      },
    },
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  state = spawnedMonster.state;
  const monsterId = spawnedMonster.entity.id;

  // Run until the monster's own attack lands and breaks the player.
  let tick = 0;
  for (let i = 0; i < 600; i++) {
    const result = step(state, [], ctx);
    state = result.state;
    tick += 1;
    const player = state.entities.get(playerId);
    if (player && player.activity === ActivityValue.Stunned) {
      return { state, playerId, monsterId, tick, ctx };
    }
  }
  throw new Error('the monster never broke the player');
}

const entity = (state: ServerWorldState, id: number): ServerEntity => {
  const found = state.entities.get(id);
  if (!found) throw new Error(`no entity ${id}`);
  return found;
};

const rejections = (events: readonly ServerSimEvent[], id: number): readonly string[] =>
  events
    .filter((event) => event.kind === 'castRejected' && event.entityId === id)
    .map((event) => (event as { reason: string }).reason);

describe('a poise break stops the body it broke (spec 173)', () => {
  it('roots the legs against an input it would otherwise have honoured', () => {
    const { state, playerId, ctx } = brokenPlayer();
    const before = entity(state, playerId).position;

    // Full-tilt movement, on the tick after the break.
    const after = step(state, [input(playerId, { moveX: 1, moveY: 0 })], ctx);
    const moved = entity(after.state, playerId).position;

    expect(moved.x).toBe(before.x);
    expect(moved.y).toBe(before.y);
  });

  it('pins the facing, so a broken body does not keep tracking you', () => {
    const { state, playerId, ctx } = brokenPlayer();
    const before = entity(state, playerId).facing;

    // A facing a quarter turn away from where the body points. A body free to
    // steer would take a slice of this every tick; a broken one takes none.
    const after = step(state, [input(playerId, { facing: before + Math.PI / 2 })], ctx);

    expect(entity(after.state, playerId).facing).toBe(before);
  });

  it('refuses a cast, and says why', () => {
    const { state, playerId, ctx } = brokenPlayer();

    const after = step(
      state,
      [input(playerId, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
      ctx,
    );

    expect(entity(after.state, playerId).cast).toBeNull();
    expect(rejections(after.events, playerId)).toEqual(['staggered']);
  });

  it('answers the request rather than dropping it', () => {
    // The regression the first cut of this spec shipped: a null intent hid the
    // cast request along with the movement, so the swing was never refused --
    // it was never considered, and the client waited out its own timeout. A
    // refusal is the *feature*; silence is the bug.
    const { state, playerId, ctx } = brokenPlayer();

    const after = step(
      state,
      [input(playerId, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
      ctx,
    );

    expect(rejections(after.events, playerId)).toHaveLength(1);
  });

  it('spends nothing on a refused cast', () => {
    const { state, playerId, ctx } = brokenPlayer();
    const before = entity(state, playerId);

    const after = step(
      state,
      [input(playerId, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
      ctx,
    );
    const now = entity(after.state, playerId);

    // Resource regenerates on its own, so the assertion is that the *cast* took
    // nothing: never less than it started with, and no cooldown stamped.
    expect(now.resource).toBeGreaterThanOrEqual(before.resource);
    expect(now.cooldowns['melee.slash'] ?? 0).toBe(before.cooldowns['melee.slash'] ?? 0);
    expect(now.fallbackCharges).toBe(before.fallbackCharges);
  });

  it('cannot be ended early by casting through it', () => {
    // The hole the `startCast` gate closes: a commit writes `activity: Casting`,
    // so a cast let through would overwrite `Stunned` and cut the window short.
    const { state, playerId, ctx } = brokenPlayer();
    const until = entity(state, playerId).activityUntilTick;

    let current = state;
    for (let i = 0; i < 5; i++) {
      current = step(
        current,
        [input(playerId, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
        ctx,
      ).state;
      const player = entity(current, playerId);
      expect(player.activity).toBe(ActivityValue.Stunned);
      expect(player.activityUntilTick).toBe(until);
    }
  });

  it('lasts exactly its window, asserted from both sides', () => {
    // Two runs rather than one frame carrying both, because asking to move is
    // itself a withdrawal (spec 079) and answers `'withdrawn'` before the cast
    // is ever considered. Probing the legs and the hands in the same input
    // frame measures 079, not this.
    {
      const { state, playerId, ctx } = brokenPlayer();
      const until = entity(state, playerId).activityUntilTick;
      expect(until).toBeGreaterThan(state.tick);

      let current = state;
      const origin = entity(current, playerId).position.x;
      // `step` runs at `state.tick + 1` and the gate is `tick < until`, so the
      // last held tick is `until - 1` -- the loop condition is the gate itself
      // rather than a count, which is what keeps the two from drifting apart.
      while (current.tick + 1 < until) {
        current = step(current, [input(playerId, { moveX: 1, moveY: 0 })], ctx).state;
        expect(entity(current, playerId).position.x, `held tick ${current.tick}`).toBe(origin);
      }
      // The very next tick is free.
      current = step(current, [input(playerId, { moveX: 1, moveY: 0 })], ctx).state;
      expect(entity(current, playerId).position.x).toBeGreaterThan(origin);
    }

    {
      const { state, playerId, ctx } = brokenPlayer();
      const until = entity(state, playerId).activityUntilTick;

      let current = state;
      const swing = input(playerId, {
        castAbilityId: 'melee.slash',
        castTargetX: 700,
        castTargetY: 450,
      });
      while (current.tick + 1 < until) {
        const result = step(current, [swing], ctx);
        current = result.state;
        expect(rejections(result.events, playerId), `refused tick ${current.tick}`).toEqual([
          'staggered',
        ]);
      }
      // And the very next one is taken.
      const freed = step(current, [swing], ctx);
      expect(rejections(freed.events, playerId)).toEqual([]);
      expect(entity(freed.state, playerId).cast).not.toBeNull();
    }
  });

  it('holds a monster too, so the gate is on the body and not the input path', () => {
    // A monster has no input frame at all -- it decides for itself in
    // `monsterIntent` -- so this is the half that would still be broken if the
    // gate had been written into the client input handling.
    const { state, monsterId, playerId, ctx } = brokenPlayer();

    // Break the monster the same way the player was broken: give the player the
    // power to do it and let a blow land.
    const player = entity(state, playerId);
    let current = replaceEntity(state, {
      ...player,
      activity: ActivityValue.Idle,
      activityUntilTick: 0,
      stats: { ...player.stats, traits: { ...player.stats.traits, staggerPower: 500 } },
    });

    let broken: ServerEntity | null = null;
    for (let i = 0; i < 600; i++) {
      const result = step(
        current,
        [input(playerId, { castAbilityId: 'melee.slash', castTargetX: 630, castTargetY: 450, castTargetEntityId: monsterId })],
        ctx,
      );
      current = result.state;
      const monster = current.entities.get(monsterId);
      if (monster && monster.activity === ActivityValue.Stunned) {
        broken = monster;
        break;
      }
    }
    if (!broken) throw new Error('the player never broke the monster');

    const before = broken.position;
    const after = step(current, [], ctx);
    const now = entity(after.state, monsterId);

    expect(now.activity).toBe(ActivityValue.Stunned);
    expect(now.position.x).toBe(before.x);
    expect(now.position.y).toBe(before.y);
    expect(now.cast).toBeNull();
  });

  it('cannot be chained: the immunity window outlasts the stagger', () => {
    // The number spec 147 chose the immunity for. Without it two attackers hold
    // a third permanently, and the root this spec adds is what would make that
    // a removal rather than an inconvenience.
    const { state, playerId, ctx } = brokenPlayer();
    const firstUntil = entity(state, playerId).activityUntilTick;
    const immuneUntil = entity(state, playerId).staggerImmuneUntilTick;

    expect(immuneUntil).toBeGreaterThan(firstUntil);

    // Run past the stagger but not past the immunity, with the monster swinging
    // the whole time, and the player is never broken a second time.
    let current = state;
    while (current.tick < immuneUntil) {
      current = step(current, [], ctx).state;
      const player = entity(current, playerId);
      if (current.tick > firstUntil) expect(player.activity).not.toBe(ActivityValue.Stunned);
    }
  });

  it('replays identically from the same seed and inputs', () => {
    const play = (): ServerWorldState => {
      const { state, playerId, ctx } = brokenPlayer();
      let current = state;
      for (let i = 0; i < 90; i++) {
        const frame =
          i % 2 === 0
            ? input(playerId, { moveX: 1, moveY: 0 })
            : input(playerId, {
                castAbilityId: 'melee.slash',
                castTargetX: 700,
                castTargetY: 450,
              });
        current = step(current, [frame], ctx).state;
      }
      return current;
    };

    const a = play();
    const b = play();
    expect(JSON.stringify([...b.entities.entries()])).toBe(
      JSON.stringify([...a.entities.entries()]),
    );
  });
});
