/**
 * Active skills, driven through the real `step` (spec 188).
 *
 * Nothing here calls `startCast` or `applyEffects` directly, for the reason
 * `abilities.test.ts` gives about the abilities it tests: a skill is only
 * correct if it behaves correctly *in a tick*, next to movement, monsters and
 * everything else that runs in one. What is asserted is the whole lifecycle the
 * brief names -- activation, validation, wind-up, resolution, effects, cooldown
 * -- and the fact that every one of those steps is the one the game already had.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import {
  ABILITIES,
  abilityById,
  TEST_STATUS_TICKS,
  type AbilityDefinition,
} from '../data/abilities.js';
import { dotById, dotDurationTicks, dotTotalDamage } from '../data/damage-over-time.js';
import { monsterById } from '../data/monsters.js';
import { itemById } from '../data/items.js';
import { DROP_TABLES } from '../data/loot.js';
import { ALL_VENDORS } from '../data/vendors.js';
import { computeEffectiveStats } from '../player/stats.js';
import { skillAbilityIdsOf } from '../player/skill-slots.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type Equipment,
  type PersistedPlayer,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { extraCostsFor } from './abilities.js';
import { rally } from './aggro.js';
import { MIN_MOVE_SCALE } from './movement.js';
import { moveScaleOf, statusOf, StatusId } from './statuses.js';
import { STATUS_VISUALS, visualFor } from '../data/status-visuals.js';
import { SCORCHED_EARTH } from '../data/aura-fields.js';
import {
  ActivityValue,
  AggroValue,
  CastPhase,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';

const SIGILS: Equipment = {
  ...EMPTY_EQUIPMENT,
  skill1: 'sigil.guardBreak',
  skill2: 'sigil.stunningBlow',
  skill3: 'sigil.whirlwind',
  skill4: 'sigil.cripplingStrike',
};

function record(equipment: Equipment = SIGILS): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    skills: [],
    equipment,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 600, y: 450, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    // High enough to wear every sigil, since a level requirement refused on the
    // way in would be a different test failing.
    level: 10,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 100,
    resource: 100,
  };
}

/** Crit off and spell power flat, so a damage assertion is arithmetic. */
function statsFor(equipment: Equipment = SIGILS): EffectiveStats {
  return { ...computeEffectiveStats(record(equipment)), spellPower: 1, critChance: 0 };
}

const CHUNK = 100;

function activeAround(x: number, y: number): Set<string> {
  const keys = new Set<string>();
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) keys.add(chunkKeyOf(x + dx * CHUNK, y + dy * CHUNK, CHUNK));
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

function withPlayer(
  state: ServerWorldState,
  x: number,
  y: number,
  stats: EffectiveStats = statsFor(),
): { state: ServerWorldState; id: number } {
  const result = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x, y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

function withMonster(
  state: ServerWorldState,
  typeId: string,
  x: number,
  y: number,
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
  return { state: result.state, id: result.entity.id };
}

function withDummy(
  state: ServerWorldState,
  x: number,
  y: number,
): { state: ServerWorldState; id: number } {
  return withMonster(state, 'dummy', x, y);
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

interface Run {
  state: ServerWorldState;
  events: ServerSimEvent[];
}

function run(
  state: ServerWorldState,
  ticks: number,
  frames: Record<number, ServerInput[]> = {},
  ctx: StepContext = context(),
): Run {
  const events: ServerSimEvent[] = [];
  let current = state;
  for (let i = 0; i < ticks; i++) {
    const result = step(current, frames[i] ?? [], ctx);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

const rejections = (events: readonly ServerSimEvent[]): string[] =>
  events.filter((event) => event.kind === 'castRejected').map((event) => event.reason);

const hits = (events: readonly ServerSimEvent[]): Extract<ServerSimEvent, { kind: 'hit' }>[] =>
  events.filter((event): event is Extract<ServerSimEvent, { kind: 'hit' }> => event.kind === 'hit');

/** A caster and a dummy in reach of every melee skill in the table. */
function duel(equipment: Equipment = SIGILS): {
  state: ServerWorldState;
  casterId: number;
  targetId: number;
} {
  const empty = createWorldState(7);
  const caster = withPlayer(empty, 600, 450, statsFor(equipment));
  const target = withDummy(caster.state, 660, 450);
  return { state: target.state, casterId: caster.id, targetId: target.id };
}

function cast(entityId: number, abilityId: string, target: ServerEntity | null): ServerInput {
  return input(entityId, {
    castAbilityId: abilityId,
    castTargetX: target?.position.x ?? 0,
    castTargetY: target?.position.y ?? 0,
    castTargetEntityId: target?.id ?? 0,
  });
}

describe('the four skills as data', () => {
  /**
   * The review criterion the spec states, as a test: a skill is
   * `targeting + casting + costs + cooldown + effects`, and if any of the four
   * rows stops being expressible that way it has grown a special case.
   */
  it('says everything it does in its own row', () => {
    for (const id of [
      'skill.guardBreak',
      'skill.stunningBlow',
      'skill.whirlwind',
      'skill.cripplingStrike',
    ]) {
      const ability = abilityById(id);
      expect(ability, id).toBeTruthy();
      if (!ability) continue;
      expect(ability.skill, id).toBe(true);
      expect(ability.windupTicks, id).toBeGreaterThan(0);
      expect(ability.cooldownTicks, id).toBeGreaterThan(0);
      expect(ability.effects?.length, id).toBeGreaterThan(0);
      // An area skill names a shape; everything else names a body or a point.
      if (ability.kind === 'area') expect(ability.area, id).toBeDefined();
      else expect(ability.targeting, id).toBe('unit');
    }
  });

  it('is carried as an item, and the item is what makes it castable', () => {
    expect(skillAbilityIdsOf(SIGILS)).toEqual([
      'skill.guardBreak',
      'skill.stunningBlow',
      'skill.whirlwind',
      'skill.cripplingStrike',
    ]);
    expect(skillAbilityIdsOf(EMPTY_EQUIPMENT)).toEqual([]);
  });
});

describe('the server decides, not the client', () => {
  it('refuses a skill the caster is not carrying', () => {
    const { state, casterId, targetId } = duel(EMPTY_EQUIPMENT);
    const target = state.entities.get(targetId);
    const { events } = run(state, 4, { 0: [cast(casterId, 'skill.guardBreak', target ?? null)] });
    expect(rejections(events)).toContain('notEquipped');
  });

  it('lets the same request through once the sigil is worn', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const { events } = run(state, 4, { 0: [cast(casterId, 'skill.guardBreak', target ?? null)] });
    expect(rejections(events)).toHaveLength(0);
  });

  it('refuses a skill already on cooldown', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.guardBreak')?.windupTicks ?? 0;
    const { events } = run(state, windup + 6, {
      0: [cast(casterId, 'skill.guardBreak', target ?? null)],
      // Well past the release, so the first one landed and stamped its cooldown.
      [windup + 3]: [cast(casterId, 'skill.guardBreak', target ?? null)],
    });
    expect(rejections(events)).toEqual(['onCooldown']);
  });

  it('refuses a skill the caster cannot pay for', () => {
    const { state, casterId, targetId } = duel();
    const caster = state.entities.get(casterId);
    if (!caster) throw new Error('no caster');
    // Whirlwind is the most expensive of the four; one point short is a refusal.
    const cost = abilityById('skill.whirlwind')?.cost ?? 0;
    const broke = replaceEntity(state, { ...caster, resource: cost - 1 });
    const target = broke.entities.get(targetId);
    const { events } = run(broke, 4, { 0: [cast(casterId, 'skill.whirlwind', target ?? null)] });
    expect(rejections(events)).toContain('notEnoughResource');
  });

  it('refuses a unit skill asked for with nothing named', () => {
    const { state, casterId } = duel();
    const { events } = run(state, 4, { 0: [cast(casterId, 'skill.guardBreak', null)] });
    expect(rejections(events)).toContain('noTarget');
  });

  it('refuses a unit skill asked for past its range', () => {
    const empty = createWorldState(7);
    const caster = withPlayer(empty, 600, 450);
    // Far outside Guard Break's 85 units, even allowing for the dummy's radius.
    const far = withDummy(caster.state, 1200, 450);
    const target = far.state.entities.get(far.id);
    const { events } = run(far.state, 4, {
      0: [cast(caster.id, 'skill.guardBreak', target ?? null)],
    });
    expect(rejections(events)).toContain('outOfRange');
  });
});

describe('the cast lifecycle is the one the game already had', () => {
  it('spends the cost at the commit and stamps no cooldown until the blow lands', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const cost = abilityById('skill.stunningBlow')?.cost ?? 0;
    // Measured against what the body actually spawned with rather than against
    // the record's number: a player's pool is *derived*, so hard-coding 100
    // would be this test asserting a stat table it does not own.
    const before = state.entities.get(casterId)?.resource ?? 0;
    const started = step(state, [cast(casterId, 'skill.stunningBlow', target ?? null)], context());
    const caster = started.state.entities.get(casterId);
    expect(cost).toBeGreaterThan(0);
    expect(caster?.resource).toBeCloseTo(before - cost, 5);
    // The button does not grey out for a swing that has not happened.
    expect(caster?.cooldowns['skill.stunningBlow']).toBeUndefined();
    expect(caster?.cast?.phase).toBe(CastPhase.Windup);
  });

  it('starts the cooldown at the attack point, not at the commit', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.stunningBlow')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.stunningBlow', target ?? null)],
    });
    const caster = landed.state.entities.get(casterId);
    expect(caster?.cooldowns['skill.stunningBlow']).toBeGreaterThan(landed.state.tick);
  });

  /**
   * The decision this whole game is built on, and it has to hold for skills:
   * a wind-up somebody stepped out of costs the time and nothing else.
   */
  it('refunds everything when the wind-up is withdrawn from', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const before = state.entities.get(casterId)?.resource ?? 0;
    const { state: after } = run(state, 6, {
      0: [cast(casterId, 'skill.stunningBlow', target ?? null)],
      3: [input(casterId, { cancelCast: true })],
    });
    const caster = after.entities.get(casterId);
    expect(caster?.cast).toBeNull();
    // The pool regenerates during a wind-up, so the refund puts it back to at
    // least where it started rather than to exactly there.
    expect(caster?.resource ?? 0).toBeGreaterThanOrEqual(before);
    expect(caster?.cooldowns['skill.stunningBlow']).toBeUndefined();
  });

  /**
   * `castAngle` is the brief's, and it is the existing turn-before-the-wind-up
   * rule with the tolerance made the row's to name. A body pointing the wrong
   * way starts in `Turning` and its wind-up clock has not begun.
   */
  it('turns toward the target before winding up when it is not facing it', () => {
    const empty = createWorldState(7);
    const caster = withPlayer(empty, 600, 450);
    // Behind the caster, which faces +x by default.
    const behind = withDummy(caster.state, 540, 450);
    const body = behind.state.entities.get(caster.id);
    if (!body) throw new Error('no caster');
    const facing = replaceEntity(behind.state, { ...body, facing: 0, stats: statsFor() });
    const target = facing.entities.get(behind.id);
    const started = step(facing, [cast(caster.id, 'skill.guardBreak', target ?? null)], context());
    expect(started.state.entities.get(caster.id)?.cast?.phase).toBe(CastPhase.Turning);
  });

  it('winds up immediately when it is already inside the cast angle', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const started = step(state, [cast(casterId, 'skill.guardBreak', target ?? null)], context());
    expect(started.state.entities.get(casterId)?.cast?.phase).toBe(CastPhase.Windup);
  });
});

describe('Guard Break', () => {
  it('takes guard off its target through the existing pool', () => {
    const { state, casterId, targetId } = duel();
    const before = state.entities.get(targetId)?.poise ?? 0;
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.guardBreak')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.guardBreak', target ?? null)],
    });
    const after = landed.state.entities.get(targetId);
    expect(before).toBeGreaterThan(0);
    expect(after?.poise ?? 0).toBeLessThan(before);
  });

  it('deals its damage as well as taking the guard', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.guardBreak')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.guardBreak', target ?? null)],
    });
    const landedHits = hits(landed.events).filter((hit) => hit.targetId === targetId);
    expect(landedHits).toHaveLength(1);
    expect(landedHits[0]?.damage ?? 0).toBeGreaterThan(0);
  });
});

describe('Stunning Blow', () => {
  it('puts its target in the game’s own stunned state', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.stunningBlow')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.stunningBlow', target ?? null)],
    });
    const after = landed.state.entities.get(targetId);
    expect(after?.activity).toBe(ActivityValue.Stunned);
    expect(after?.activityUntilTick ?? 0).toBeGreaterThan(landed.state.tick);
    // Announced on the same event a poise break uses, so the client's flinch and
    // the swirl over the head are the ones already drawn.
    expect(landed.events.some((event) => event.kind === 'poiseBroken')).toBe(true);
  });

  /**
   * The break's anti-chain window is about *guard breaks*, and a skill's stun
   * is not one -- see the note on the `stun` case in `sim/skill-effects.ts`.
   * What still stamps the window is that the stun *lands*: a guard break cannot
   * follow it for free.
   */
  it('leaves the target unbreakable for a while afterwards', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.stunningBlow')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.stunningBlow', target ?? null)],
    });
    const struck = landed.state.entities.get(targetId);
    expect(struck?.staggerImmuneUntilTick ?? 0).toBeGreaterThan(landed.state.tick);
    expect(hits(landed.events).filter((hit) => hit.targetId === targetId)).toHaveLength(1);
  });
});

describe('Whirlwind', () => {
  it('hits everything inside its circle and nothing outside it', () => {
    const empty = createWorldState(7);
    const caster = withPlayer(empty, 600, 450);
    const near = withDummy(caster.state, 660, 450);
    const alsoNear = withDummy(near.state, 600, 520);
    // Well outside the 160-unit radius.
    const far = withDummy(alsoNear.state, 600, 900);
    const windup = abilityById('skill.whirlwind')?.windupTicks ?? 0;
    const landed = run(far.state, windup + 2, {
      0: [cast(caster.id, 'skill.whirlwind', null)],
    });
    const struck = new Set(hits(landed.events).map((hit) => hit.targetId));
    expect(struck.has(near.id)).toBe(true);
    expect(struck.has(alsoNear.id)).toBe(true);
    expect(struck.has(far.id)).toBe(false);
    // And never its own caster, which is the one body inside every circle.
    expect(struck.has(caster.id)).toBe(false);
  });

  it('needs no target at all', () => {
    const empty = createWorldState(7);
    const caster = withPlayer(empty, 600, 450);
    const { events } = run(caster.state, 4, { 0: [cast(caster.id, 'skill.whirlwind', null)] });
    expect(rejections(events)).toHaveLength(0);
  });
});

describe('Crippling Strike', () => {
  it('applies Slow through the existing status system', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.cripplingStrike')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.cripplingStrike', target ?? null)],
    });
    const after = landed.state.entities.get(targetId);
    const slow = statusOf(after?.statuses ?? {}, StatusId.Slowed, landed.state.tick);
    expect(slow).toBeTruthy();
    expect(slow?.magnitude).toBeCloseTo(0.4, 5);
  });

  it('makes the slowed body actually slower, and never stops it dead', () => {
    const slowed = { ...({} as Record<string, never>) };
    void slowed;
    const statuses = {
      [StatusId.Slowed]: { expiresAtTick: 100, stacks: 1, magnitude: 0.4, sourceId: 0, appliedAtTick: 0 },
    };
    expect(moveScaleOf(statuses, 0, MIN_MOVE_SCALE)).toBeCloseTo(0.6, 5);
    // A magnitude past the floor is a hard slow, never a root.
    const brutal = { [StatusId.Slowed]: { expiresAtTick: 100, stacks: 1, magnitude: 5, sourceId: 0, appliedAtTick: 0 } };
    expect(moveScaleOf(brutal, 0, MIN_MOVE_SCALE)).toBe(MIN_MOVE_SCALE);
    // And an expired one is not a slow at all.
    expect(moveScaleOf(statuses, 100, MIN_MOVE_SCALE)).toBe(1);
  });
});

describe('costs beyond the pool', () => {
  /**
   * The brief's "do not assume every skill uses pool". Guard Break is the row
   * that pays in guard, and what is asserted here is that the second currency
   * behaves exactly like the first: taken at the commit, refunded by a
   * withdrawal, refused when it is not there.
   */
  it('takes guard from the caster at the commit', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const before = state.entities.get(casterId)?.poise ?? 0;
    const cost = abilityById('skill.guardBreak')?.costs?.poise ?? 0;
    expect(cost).toBeGreaterThan(0);
    const started = step(state, [cast(casterId, 'skill.guardBreak', target ?? null)], context());
    expect(started.state.entities.get(casterId)?.poise).toBeCloseTo(before - cost, 5);
  });

  it('gives the guard back when the wind-up is withdrawn from', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const before = state.entities.get(casterId)?.poise ?? 0;
    const { state: after } = run(state, 6, {
      0: [cast(casterId, 'skill.guardBreak', target ?? null)],
      2: [input(casterId, { cancelCast: true })],
    });
    expect(after.entities.get(casterId)?.poise ?? 0).toBeGreaterThanOrEqual(before);
  });

  it('refuses the cast rather than letting a caster stagger itself', () => {
    const { state, casterId, targetId } = duel();
    const caster = state.entities.get(casterId);
    if (!caster) throw new Error('no caster');
    const cost = abilityById('skill.guardBreak')?.costs?.poise ?? 0;
    const drained = replaceEntity(state, { ...caster, poise: cost - 1 });
    const target = drained.entities.get(targetId);
    const { events } = run(drained, 3, { 0: [cast(casterId, 'skill.guardBreak', target ?? null)] });
    expect(rejections(events)).toContain('notEnoughPoise');
  });

  /**
   * The health branch has no shipped row behind it yet, so it is asserted
   * against the pure function rather than through a fight. The rule that
   * matters is the one a row could not express on its own: **a cost may never
   * be lethal**, so it is refused at "exactly enough" rather than at "not
   * quite" -- a skill that could kill its user is unusable in the fight it was
   * designed for, which makes the cost a fiction.
   */
  it('never lets a health cost be the thing that kills you', () => {
    const bill = { costs: { health: 20 } } as unknown as Parameters<typeof extraCostsFor>[1];
    expect(extraCostsFor({ health: 21, poise: 0 }, bill).refusal).toBeNull();
    expect(extraCostsFor({ health: 20, poise: 0 }, bill).refusal).toBe('notEnoughHealth');
    expect(extraCostsFor({ health: 3, poise: 0 }, bill).refusal).toBe('notEnoughHealth');
  });

  it('costs nothing extra for a row that names nothing', () => {
    const free = { } as unknown as Parameters<typeof extraCostsFor>[1];
    const paid = extraCostsFor({ health: 1, poise: 0 }, free);
    expect(paid).toEqual({ health: 0, poise: 0, refusal: null });
  });
});

/**
 * `kind: 'channel'` has **no shipped row** since spec 237.
 *
 * `channel.drain` was spec 062's one channel -- granted by nothing, castable by
 * anybody -- and it went with the rest of that demo set. The mechanism is still
 * live in `sim/abilities.ts`, `client/combat.ts` and `data/description.ts`, and
 * `CastPhaseValue.Channel` is still on the wire; what is gone is anything to
 * point it at, so the end-to-end test that used to live here cannot be written.
 *
 * The invariant it asserted is **not** lost, and that is why it was removed
 * rather than skipped: *an interrupted cast that is past its attack point keeps
 * its cooldown* is a rule about where the cooldown is stamped rather than about
 * channels, and `sim/attack-cancel.test.ts` asserts it on both sides of the
 * attack point through the backswing -- refunded before it, kept after it.
 *
 * If a channel is ever authored again, the test to restore is a cast broken off
 * mid-pulse whose `cooldowns[id]` still stands.
 */

describe('an instant skill', () => {
  /**
   * "Instant execution" is not a mode: it is `windupTicks` at its floor, which
   * `seconds()` already clamps to one tick. Asserted against the shortest
   * wind-up in the table so that a row authored at zero cannot silently become
   * a cast that never releases.
   */
  it('is a wind-up of one tick rather than a mode of its own', () => {
    for (const id of ['skill.guardBreak', 'skill.cripplingStrike']) {
      expect(abilityById(id)?.windupTicks ?? 0).toBeGreaterThanOrEqual(1);
    }
  });
});

/**
 * Stunning Blow's stun, which shipped landing only sometimes.
 *
 * The cause was an ordering trap inside the skill's own effect list: its
 * `poiseDamage` runs first, and on a body whose guard it *breaks* that stamps
 * the anti-chain immunity window -- which the `stun` a line later then read and
 * refused. So the skill stunned for the target's own `staggerTicks` when it
 * broke the guard and for its authored duration when it did not, and for
 * nothing at all against a body already inside somebody else's window.
 *
 * Which of those happened depended on the monster: a grazer's guard is 20 and
 * the skill takes 30, so it always broke; a ravager's is 49, so it usually did
 * not. From the player's seat that reads as a skill that sometimes works.
 */
describe('Stunning Blow stuns every time it lands', () => {
  const STUN_TICKS = 84;

  /**
   * Fires the skill and reports how long the stun it produced actually lasts.
   *
   * Stepped one tick at a time so the *first* tick the body is stunned on is
   * observed rather than inferred: the length is `activityUntilTick` minus that
   * tick, and measuring from the end of the run instead would be short by
   * however many ticks the run happened to overshoot by.
   */
  function strike(state: ServerWorldState, casterId: number, targetId: number): {
    readonly target: ServerEntity | undefined;
    readonly stunTicks: number | null;
    /** The world as it stands, so a caller can keep stepping the same clock. */
    readonly state: ServerWorldState;
  } {
    const windup = abilityById('skill.stunningBlow')?.windupTicks ?? 0;
    const ctx = context();
    let current = state;
    let stunTicks: number | null = null;
    for (let i = 0; i < windup + 3; i++) {
      const frame = i === 0
        ? [cast(casterId, 'skill.stunningBlow', current.entities.get(targetId) ?? null)]
        : [];
      current = step(current, frame, ctx).state;
      const target = current.entities.get(targetId);
      if (stunTicks === null && target?.activity === ActivityValue.Stunned) {
        stunTicks = target.activityUntilTick - current.tick;
      }
    }
    return { target: current.entities.get(targetId), stunTicks, state: current };
  }

  /** A caster and a monster of `typeId` in reach. */
  function against(typeId: string): { state: ServerWorldState; casterId: number; targetId: number } {
    const definition = monsterById(typeId);
    if (!definition) throw new Error(`no ${typeId}`);
    const empty = createWorldState(7);
    const caster = withPlayer(empty, 600, 450, statsFor());
    const spawned = spawnEntity(caster.state, {
      kind: EntityKindValue.Monster,
      typeId,
      position: { x: 655, y: 450, z: 0 },
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
    });
    return { state: spawned.state, casterId: caster.id, targetId: spawned.entity.id };
  }

  /**
   * The authored duration, whatever the target's own guard did. A body whose
   * guard the same blow broke used to get its own `staggerTicks` instead --
   * half a second where the row says one and a half.
   */
  it('stuns for the duration the row states, on a body whose guard it breaks', () => {
    // A stalker's guard is 20 and the skill takes 30, so this always breaks --
    // and its 40 health survives the blow, which a grazer's 24 does not.
    const { state, casterId, targetId } = against('stalker');
    const { target, stunTicks } = strike(state, casterId, targetId);
    expect(target?.activity).toBe(ActivityValue.Stunned);
    expect(stunTicks).toBe(STUN_TICKS);
  });

  it('stuns for the same duration on a body whose guard it does not break', () => {
    // A ravager's guard is 49, so 30 leaves it standing.
    const { state, casterId, targetId } = against('ravager');
    const { target, stunTicks } = strike(state, casterId, targetId);
    expect(target?.activity).toBe(ActivityValue.Stunned);
    expect(stunTicks).toBe(STUN_TICKS);
  });

  /**
   * The window stops a *guard break* being repeatable, which is what would
   * otherwise let two attackers hold a third permanently. A skill's stun is
   * rate-limited by its own cooldown and wind-up instead, so being inside
   * somebody else's window is not a reason for it to do nothing.
   */
  it('stuns a body that is already inside a break’s immunity window', () => {
    const { state, casterId, targetId } = against('ravager');
    const target = state.entities.get(targetId);
    if (!target) throw new Error('no target');
    const immune = replaceEntity(state, {
      ...target,
      staggerImmuneUntilTick: state.tick + SERVER_TICK_RATE * 10,
    });
    const struck = strike(immune, casterId, targetId);
    expect(struck.target?.activity).toBe(ActivityValue.Stunned);
    expect(struck.stunTicks).toBe(STUN_TICKS);
  });

  /**
   * The question the reported bug was really asking: is the mob *stunned*, or
   * does it merely carry a flag saying so.
   *
   * Spec 173 made `staggered` root the legs and refuse the hands, and this
   * asserts it end to end for a skill's stun: an engaged ravager, which chases
   * and swings at everything, neither moves nor commits to anything for the
   * whole window -- and does both again once it is over.
   */
  it('really roots the body: it neither walks nor swings for the window', () => {
    const { state, casterId, targetId } = against('ravager');
    const struck = strike(state, casterId, targetId);
    expect(struck.target?.activity).toBe(ActivityValue.Stunned);
    if (!struck.target) throw new Error('no target');

    // Where it was when the blow landed, and where the caster is: a body free
    // to act would close on the player and swing.
    const held = struck.target.position;
    // The same world and the same clock the blow landed on. Rebuilding one
    // around the stunned body would put its `activityUntilTick` against a fresh
    // tick counter, which makes the window look however long the new clock is
    // behind -- a test measuring its own scaffolding rather than the rule.
    const ctx = context();
    let current = struck.state;
    for (let i = 0; i < 20; i++) current = step(current, [], ctx).state;

    const during = current.entities.get(targetId);
    expect(during?.activity).toBe(ActivityValue.Stunned);
    expect(Math.hypot(
      (during?.position.x ?? 0) - held.x,
      (during?.position.y ?? 0) - held.y,
    )).toBeLessThan(1e-6);
    expect(during?.cast).toBeNull();

    // And free again afterwards, which is what makes it a window rather than a
    // removal.
    for (let i = 0; i < STUN_TICKS + 5; i++) current = step(current, [], ctx).state;
    expect(current.entities.get(targetId)?.activity).not.toBe(ActivityValue.Stunned);
  });

  /**
   * Constitution's Resolute is the one thing that still refuses it, and that is
   * the difference between a global anti-chain guard and an *earned* defence: a
   * player who built for it and is hurt enough to have it is meant to be
   * unstaggerable, and a skill that walked through it would make the trait
   * worth nothing.
   */
  it('is still refused by a body that has earned its footing', () => {
    const { state, casterId, targetId } = against('ravager');
    const target = state.entities.get(targetId);
    if (!target) throw new Error('no target');
    const resolute = replaceEntity(state, {
      ...target,
      health: 1,
      stats: { ...target.stats, traits: { ...target.stats.traits, resoluteBelow: 0.9 } },
    });
    const struck = strike(resolute, casterId, targetId);
    expect(struck.target?.activity).not.toBe(ActivityValue.Stunned);
  });
});

/**
 * Crippling Strike's slow, seen from outside (specs 186, 188).
 *
 * The two halves of a slow ride different fields and mean different things,
 * which is worth an assertion because they are easy to confuse: the *mark* says
 * a body is slowed and rides spec 186's status list, and the *number* a step is
 * multiplied by rides `EntityField.MoveScale`. A watcher needs the first; only
 * the mover's own predictor needs the second.
 */
describe('a slowed body says so', () => {
  it('carries a status the mark layer knows how to draw', () => {
    const { state, casterId, targetId } = duel();
    const target = state.entities.get(targetId);
    const windup = abilityById('skill.cripplingStrike')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.cripplingStrike', target ?? null)],
    });
    const after = landed.state.entities.get(targetId);
    expect(statusOf(after?.statuses ?? {}, StatusId.Slowed, landed.state.tick)).toBeTruthy();
    // ...and the visual table has a row for it, so it is a mark rather than a
    // status the wire silently drops.
    expect(visualFor(StatusId.Slowed)).not.toBeNull();
  });
});

/**
 * The seven afflictions, driven through the real `step` (spec 190).
 *
 * The arithmetic of a pulse -- how many, how big, on which ticks -- is asserted
 * against the pass itself in `damage-over-time.test.ts`, where a real tick would
 * only put movement, regeneration and monster intent between the reading and the
 * thing being read. What is left here is the half that only exists inside a
 * tick, and it is the half spec 190 exists to close: **an affliction has to
 * survive the trip from a row to a body**, and the trip is different for every
 * one of the seven.
 *
 * That is why the first block is seven separate tests rather than one about the
 * mechanic. Two of the landing paths silently dropped `ability.effects` before
 * this spec -- a projectile's impact resolved in `world.ts` and called
 * `applyDamage` directly, and `landSelf` read `healing` and nothing else -- so a
 * row could be authored, validated, typechecked and never run. Poison Dart is
 * the headline: it is the projectile, and if it lands the seam is genuinely
 * wired rather than merely written.
 *
 * The rest is what "damage over time" actually claims. A blow is right or wrong
 * once and this is not a blow: the caster stops doing anything, the input frames
 * go empty, and the target has to keep losing health with somebody still
 * answerable for it.
 */

/** A loadout of up to four sigils, in slot order. Four is all there are. */
function wearing(...sigils: readonly string[]): Equipment {
  return {
    ...EMPTY_EQUIPMENT,
    skill1: sigils[0] ?? null,
    skill2: sigils[1] ?? null,
    skill3: sigils[2] ?? null,
    skill4: sigils[3] ?? null,
  };
}

/** How one skill is asked for: a body, a point, a direction, or nothing. */
type Aim = (casterId: number, target: ServerEntity) => ServerInput;

interface Affliction {
  readonly name: string;
  readonly ability: string;
  readonly sigil: string;
  readonly dotId: string;
  readonly aim: Aim;
}

const atBody = (ability: string): Aim => (casterId, target) => cast(casterId, ability, target);

const atPoint = (ability: string): Aim => (casterId, target) =>
  input(casterId, {
    castAbilityId: ability,
    castTargetX: target.position.x,
    castTargetY: target.position.y,
  });

/** Straight down +x, which is where `duel` stands the dummy. */
const downRange = (ability: string): Aim => (casterId) =>
  input(casterId, { castAbilityId: ability, castTargetX: 900, castTargetY: 450 });

const atNothing = (ability: string): Aim => (casterId) =>
  input(casterId, { castAbilityId: ability });

/**
 * One row per landing path, which is the point: `unit`, a burst, a melee body, a
 * cone, a lane, a circle on the caster's own feet, and a patch of ground.
 */
const AFFLICTIONS: readonly Affliction[] = [
  {
    name: 'Poison Dart',
    ability: 'skill.poisonDart',
    sigil: 'sigil.poisonDart',
    dotId: StatusId.Poison,
    aim: atBody('skill.poisonDart'),
  },
  {
    name: 'Ember Toss',
    ability: 'skill.emberToss',
    sigil: 'sigil.emberToss',
    dotId: StatusId.Burn,
    aim: atPoint('skill.emberToss'),
  },
  {
    name: 'Rending Cut',
    ability: 'skill.rendingCut',
    sigil: 'sigil.rendingCut',
    dotId: StatusId.Bleed,
    aim: atBody('skill.rendingCut'),
  },
  {
    name: 'Acid Spray',
    ability: 'skill.acidSpray',
    sigil: 'sigil.acidSpray',
    dotId: StatusId.Corrosion,
    aim: downRange('skill.acidSpray'),
  },
  {
    name: 'Arc Lash',
    ability: 'skill.arcLash',
    sigil: 'sigil.arcLash',
    dotId: StatusId.Shock,
    aim: downRange('skill.arcLash'),
  },
  {
    name: 'Rime Touch',
    ability: 'skill.rimeTouch',
    sigil: 'sigil.rimeTouch',
    dotId: StatusId.Frostbite,
    aim: atNothing('skill.rimeTouch'),
  },
  {
    name: 'Blight',
    ability: 'skill.blight',
    sigil: 'sigil.blight',
    dotId: StatusId.Decay,
    aim: atPoint('skill.blight'),
  },
];

interface Landing {
  readonly state: ServerWorldState;
  readonly events: ServerSimEvent[];
  /** The first tick the target was carrying it, or null if it never was. */
  readonly landedAtTick: number | null;
  /** The target's health at the end of each tick, so a decline can be sampled. */
  readonly health: ReadonlyMap<number, number>;
  readonly casterId: number;
  readonly targetId: number;
}

/**
 * Casts one skill on tick 0 and then does **nothing at all** for the rest.
 *
 * Stepped one tick at a time rather than through `run`, because the tick the
 * affliction first appears on is the anchor every later assertion is measured
 * from -- a wind-up, a turn and a projectile's flight are three different
 * delays, and inferring the landing from the length of the run would make the
 * arithmetic a guess about scaffolding.
 */
function afflict(row: Affliction, ticks: number): Landing {
  const { state, casterId, targetId } = duel(wearing(row.sigil));
  const target = state.entities.get(targetId);
  if (!target) throw new Error('no target');
  const ctx = context();
  const events: ServerSimEvent[] = [];
  const health = new Map<number, number>();
  let current = state;
  let landedAtTick: number | null = null;
  for (let i = 0; i < ticks; i++) {
    const result = step(current, i === 0 ? [row.aim(casterId, target)] : [], ctx);
    current = result.state;
    events.push(...result.events);
    const body = current.entities.get(targetId);
    health.set(current.tick, body?.health ?? 0);
    if (landedAtTick === null && statusOf(body?.statuses ?? {}, row.dotId, current.tick)) {
      landedAtTick = current.tick;
    }
  }
  return { state: current, events, landedAtTick, health, casterId, targetId };
}

function afflictionRow(id: string): Affliction {
  const found = AFFLICTIONS.find((row) => row.ability === id);
  if (!found) throw new Error(`no affliction skill ${id}`);
  return found;
}

describe('every one of the seven reaches a body', () => {
  for (const row of AFFLICTIONS) {
    it(`${row.name} leaves ${row.dotId} on what it lands on, answerable to whoever cast it`, () => {
      const landed = afflict(row, 120);
      expect(rejections(landed.events)).toHaveLength(0);
      const held = statusOf(
        landed.state.entities.get(landed.targetId)?.statuses ?? {},
        row.dotId,
        landed.state.tick,
      );
      expect(held, row.ability).toBeTruthy();
      expect(landed.landedAtTick).not.toBeNull();
      // Without this the affliction's kill pays nobody -- and it is the field
      // that had to be invented for a status that can kill.
      expect(held?.sourceId).toBe(landed.casterId);
    });
  }
});

describe('an affliction outlives the blow that applied it', () => {
  /**
   * The whole claim, and it is asserted with the input frames empty from tick 1
   * onward: the caster has thrown one dart and is standing still.
   *
   * Poison is the row to measure it on because it has no rider -- no ramp, no
   * exertion, no spread -- so what the numbers come to is `pulses` and
   * `dotTotalDamage` and nothing about the fight.
   */
  it('goes on taking health, in pulses credited to a caster who is doing nothing', () => {
    const poison = dotById(StatusId.Poison);
    if (!poison) throw new Error('no poison row');
    const landed = afflict(afflictionRow('skill.poisonDart'), dotDurationTicks(poison) + 180);
    const landedAt = landed.landedAtTick;
    expect(landedAt).not.toBeNull();
    if (landedAt === null) return;

    const onTarget = hits(landed.events).filter((hit) => hit.targetId === landed.targetId);
    // The dart's own impact first, then the affliction. Everything after the
    // first is damage that arrived with nothing being done to cause it.
    const pulses = onTarget.slice(1);
    expect(pulses).toHaveLength(poison.pulses);
    expect(pulses.every((hit) => hit.attackerId === landed.casterId)).toBe(true);
    expect(pulses.reduce((sum, hit) => sum + hit.damage, 0)).toBeCloseTo(
      dotTotalDamage(poison),
      5,
    );

    // And the same thing read off the body rather than off the events: still
    // falling a second in, five seconds in, and ten seconds in.
    const sample = (tick: number): number => landed.health.get(tick) ?? Number.NaN;
    expect(sample(landedAt + 60)).toBeLessThan(sample(landedAt));
    expect(sample(landedAt + 300)).toBeLessThan(sample(landedAt + 60));
    expect(sample(landedAt + 600)).toBeLessThan(sample(landedAt + 300));
    // ...and stopped once the row has spent its pulses, rather than for ever.
    expect(sample(landedAt + 700)).toBe(sample(landedAt + 600));
  });
});

describe('a projectile skill’s effect list runs at both of its call sites', () => {
  /**
   * The burst is a **separate call site** from the direct hit in `world.ts`, so
   * a dart landing on a body says nothing about a pot landing beside one.
   *
   * The pot is thrown at a patch of ground 70 units to the side of the dummy and
   * misses it by construction: the flight path passes 57 units off, against a
   * projectile radius of 10 and a body radius of 22. Nothing was struck, and the
   * fire still has to start.
   */
  it('starts the fire on what the splash reached, not only on what it hit', () => {
    const ember = abilityById('skill.emberToss');
    if (!ember) throw new Error('no ember toss');
    expect(ember.radius ?? 0).toBeGreaterThan(0);

    const empty = createWorldState(7);
    const caster = withPlayer(empty, 600, 450, statsFor(wearing('sigil.emberToss')));
    const beside = withDummy(caster.state, 700, 450);
    const aimX = 700;
    const aimY = 520;
    const body = beside.state.entities.get(beside.id);
    if (!body) throw new Error('no dummy');
    // The two facts the argument above rests on, stated as arithmetic rather
    // than left in a comment: the pot lands inside the splash and outside the
    // body it sets alight.
    const reach = Math.hypot(aimX - body.position.x, aimY - body.position.y);
    expect(reach).toBeLessThanOrEqual((ember.radius ?? 0) + body.radius);
    expect(reach).toBeGreaterThan((ember.projectile?.radius ?? 0) + body.radius);

    const landed = run(beside.state, 120, {
      0: [input(caster.id, { castAbilityId: 'skill.emberToss', castTargetX: aimX, castTargetY: aimY })],
    });
    const burnt = landed.state.entities.get(beside.id);
    const burn = statusOf(burnt?.statuses ?? {}, StatusId.Burn, landed.state.tick);
    expect(burn).toBeTruthy();
    expect(burn?.sourceId).toBe(caster.id);
  });
});

describe('Poison Dart is a thing you throw again', () => {
  /**
   * The concentration is what the skill buys, and three separate properties have
   * to hold at once for it to be worth throwing twice.
   *
   * A refresh has to **add a stack** up to the row's cap, it has to **move the
   * expiry**, and it must **not move `appliedAtTick`** -- because that is what
   * the cadence is measured from, and a dart every second that pushed the phase
   * out would be a poison that never ticked at all. Six casts against a cap of
   * five, so the cap is asserted by a refusal to grow rather than by arriving at
   * the number and stopping.
   */
  it('stacks up to the row’s cap and refreshes the clock without moving the cadence', () => {
    const poison = dotById(StatusId.Poison);
    if (!poison) throw new Error('no poison row');
    const { state, casterId, targetId } = duel(wearing('sigil.poisonDart'));
    const target = state.entities.get(targetId) ?? null;
    const ctx = context();
    // Just past the cooldown each time, so every cast is let through -- and
    // inside the poison's own life, which is what makes the stack reachable.
    const casts = new Set([0, 145, 290, 435, 580, 725]);
    expect(casts.size).toBeGreaterThan(poison.maxStacks);

    let current = state;
    const stacks: number[] = [];
    const expiries: number[] = [];
    const appliedAt = new Set<number>();
    for (let i = 0; i < 800; i++) {
      const frame = casts.has(i) ? [cast(casterId, 'skill.poisonDart', target)] : [];
      current = step(current, frame, ctx).state;
      const held = statusOf(
        current.entities.get(targetId)?.statuses ?? {},
        StatusId.Poison,
        current.tick,
      );
      if (!held) continue;
      appliedAt.add(held.appliedAtTick);
      if (stacks[stacks.length - 1] !== held.stacks) stacks.push(held.stacks);
      if (expiries[expiries.length - 1] !== held.expiresAtTick) expiries.push(held.expiresAtTick);
    }

    expect(stacks).toEqual([1, 2, 3, 4, 5]);
    // One expiry per cast, each later than the last: the sixth dart still
    // refreshes a poison it can no longer make any stronger.
    expect(expiries).toHaveLength(casts.size);
    expect([...expiries].sort((a, b) => a - b)).toEqual(expiries);
    // The one number a refresh may not touch.
    expect([...appliedAt]).toHaveLength(1);
  });
});

/**
 * A test-only row, because `landSelf`'s hole cannot be reached from the shipped
 * table.
 *
 * `landSelf` read `healing` and `healingFraction` and nothing else, so a
 * self-targeted row's effect list was dropped on the floor -- and no shipped
 * `kind: 'self'` row has one, since the two that exist are a heal and a flask.
 * Registering one for the duration of the test is the only way to assert the
 * path without changing what the game ships; it is removed again in `finally`,
 * and it is deliberately not a `skill`, so nothing has to be worn to cast it.
 */
const SELF_ROW: AbilityDefinition = {
  id: 'test.selfAffliction',
  name: 'Self Affliction',
  kind: 'self',
  targeting: 'self',
  windupTicks: 2,
  cooldownTicks: 60,
  cost: 0,
  range: 0,
  damage: 0,
  healing: 5,
  effects: [{ kind: 'applyDot', dotId: StatusId.Frostbite }],
  description: 'Test-only: a self-cast whose effect list has to run.',
};

describe('a self-targeted skill’s effect list runs', () => {
  it('lands on the caster, from a row whose only effect is an affliction', () => {
    const table = ABILITIES as Map<string, AbilityDefinition>;
    table.set(SELF_ROW.id, SELF_ROW);
    try {
      const { state, casterId } = duel(EMPTY_EQUIPMENT);
      const landed = run(state, 20, { 0: [input(casterId, { castAbilityId: SELF_ROW.id })] });
      expect(rejections(landed.events)).toHaveLength(0);
      const caster = landed.state.entities.get(casterId);
      const held = statusOf(caster?.statuses ?? {}, StatusId.Frostbite, landed.state.tick);
      expect(held).toBeTruthy();
      // The caster is both ends of a self-cast, which is what makes the credit
      // worth asserting: it is the one landing where the two could be confused.
      expect(held?.sourceId).toBe(casterId);
    } finally {
      table.delete(SELF_ROW.id);
    }
  });
});

describe('what an affliction must not do in a real tick', () => {
  /**
   * Two things a pulse looked correct doing in isolation and was wrong doing in
   * a tick, both found by review rather than by a green test: the guard drain
   * measured against a pool that was refilling under it, and a shout for help
   * raised once per pulse instead of once per blow.
   */
  it('drains a guard that is regenerating under it, rather than tying with it', () => {
    // `regenPoise` runs in `advanceProgression` every tick and a monster gets
    // back `SCALING.combat.monsterPoiseRegen` a second. Corrosion was authored
    // at exactly that, so the rider read as working everywhere it was measured
    // on its own and did nothing whatsoever in a fight -- against the one body
    // you would ever put it on, which is a stationary one being set up for a
    // break.
    const empty = createWorldState(5);
    const caster = withPlayer(empty, 600, 450, statsFor(wearing('sigil.acidSpray')));
    const target = withDummy(caster.state, 660, 450);
    const before = target.state.entities.get(target.id)?.poise ?? 0;
    expect(before).toBeGreaterThan(0);

    const corrosion = dotById(StatusId.Corrosion);
    if (!corrosion) throw new Error('no corrosion row');
    const landed = run(target.state, dotDurationTicks(corrosion) + 10, {
      0: [
        input(caster.id, {
          castAbilityId: 'skill.acidSpray',
          castTargetX: 900,
          castTargetY: 450,
        }),
      ],
    });

    const after = landed.state.entities.get(target.id)?.poise ?? 0;
    expect(after).toBeLessThan(before);
    // And it never broke the guard on its own: a body staggered once a second
    // for six seconds is a removal rather than a setup.
    expect(landed.events.filter((event) => event.kind === 'poiseBroken')).toHaveLength(0);
  });

  it('calls the nest once for the blow, and never again for the pulses', () => {
    // `rally` is driven off this tick's `hit` events and its whole bound is one
    // hop per blow. A poison ticking twenty times would raise twenty calls, each
    // from wherever the applier had walked to by then -- so a single dart would
    // drag a nest across the map for ten seconds.
    const empty = createWorldState(5);
    const caster = withPlayer(empty, 600, 450, statsFor(wearing('sigil.poisonDart')));
    const bitten = withMonster(caster.state, 'small_spider', 800, 450);
    const nest = withMonster(bitten.state, 'small_spider', 840, 450);
    const target = bitten.state.entities.get(bitten.id) ?? null;

    const poison = dotById(StatusId.Poison);
    if (!poison) throw new Error('no poison row');
    const landed = run(nest.state, dotDurationTicks(poison), {
      0: [cast(caster.id, 'skill.poisonDart', target)],
    });

    // A real fight produced both kinds: one blow, and many pulses after it.
    const produced = hits(landed.events).filter((event) => event.attackerId === caster.id);
    const blow = produced.find((event) => event.periodic !== true);
    const pulses = produced.filter((event) => event.periodic === true);
    expect(blow, 'the dart never landed').toBeDefined();
    expect(pulses.length).toBeGreaterThan(1);

    // Put both through `rally` against **one** world, so the only difference
    // between the two calls is the flag. A calm nest beside a live victim is
    // the state rally exists for; by the end of a ten-second poison the
    // neighbour is long since engaged and the victim may not be in the map at
    // all, which is why the pair is judged here rather than where they arose.
    const nestling = nest.state.entities.get(nest.id);
    const victim = nest.state.entities.get(bitten.id);
    const attacker = nest.state.entities.get(caster.id);
    if (!nestling || !victim || !attacker) throw new Error('missing body');
    const world = new Map([
      [attacker.id, attacker],
      [victim.id, victim],
      [nestling.id, { ...nestling, aggro: AggroValue.Calm, targetId: null }],
    ]);

    if (blow) expect(rally([blow], world).size, 'a blow rallied nobody').toBeGreaterThan(0);
    for (const event of pulses) {
      expect(rally([event], world).size, 'a pulse rallied somebody').toBe(0);
    }
  });
});

describe('determinism holds with afflictions in play', () => {
  /**
   * Four appliers, two bodies and five hundred ticks, so the pass is exercised
   * where it actually chooses something: Burn and Shock both spread, and a
   * choice between two bodies is where an order dependency would hide.
   */
  function scripted(): ServerWorldState {
    const empty = createWorldState(11);
    const caster = withPlayer(
      empty,
      600,
      450,
      statsFor(wearing('sigil.poisonDart', 'sigil.emberToss', 'sigil.rendingCut', 'sigil.arcLash')),
    );
    const near = withDummy(caster.state, 660, 450);
    // Inside Burn's 90 and Shock's 150 of the first, so what is on one reaches
    // the other.
    const behind = withDummy(near.state, 740, 450);
    const target = behind.state.entities.get(near.id) ?? null;
    return run(behind.state, 500, {
      0: [cast(caster.id, 'skill.poisonDart', target)],
      60: [
        input(caster.id, {
          castAbilityId: 'skill.emberToss',
          castTargetX: 660,
          castTargetY: 450,
        }),
      ],
      160: [cast(caster.id, 'skill.rendingCut', target)],
      280: [
        input(caster.id, { castAbilityId: 'skill.arcLash', castTargetX: 900, castTargetY: 450 }),
      ],
    }).state;
  }

  it('replays the same seed and the same frames to bit-identical state', () => {
    const snapshot = (state: ServerWorldState): string =>
      JSON.stringify({
        tick: state.tick,
        nextEntityId: state.nextEntityId,
        rng: state.rng.getState(),
        entities: [...state.entities.values()],
      });
    expect(snapshot(scripted())).toBe(snapshot(scripted()));
  });

  /**
   * Why the replay above is safe to add afflictions to at all: the pass draws
   * **nothing**. Measured from the tick the poison is on -- by which point the
   * dart has resolved and rolled whatever it was going to -- through four
   * hundred more ticks of pulses, the generator has not moved.
   */
  it('never touches the Rng while it pulses', () => {
    const { state, casterId, targetId } = duel(wearing('sigil.poisonDart'));
    const target = state.entities.get(targetId) ?? null;
    const ctx = context();
    let current = state;
    let quiet: string | null = null;
    for (let i = 0; i < 400; i++) {
      current = step(current, i === 0 ? [cast(casterId, 'skill.poisonDart', target)] : [], ctx).state;
      const held = statusOf(
        current.entities.get(targetId)?.statuses ?? {},
        StatusId.Poison,
        current.tick,
      );
      if (quiet === null && held) quiet = JSON.stringify(current.rng.getState());
    }
    expect(quiet).not.toBeNull();
    expect(JSON.stringify(current.rng.getState())).toBe(quiet);
  });
});

/**
 * The field, end to end (spec 223).
 *
 * `aura-field.test.ts` is the pass's own arithmetic; what is asserted here is
 * the half that only exists once the whole tick is running -- that casting the
 * skill actually starts a field, that the field burns what is standing in it
 * through the real `step`, and that adding one to a fight moves no Rng draw.
 */
describe('a skill that makes the ground dangerous', () => {
  const FIELD_SIGIL: Equipment = wearing('sigil.scorchedEarth');

  /** A caster wearing the sigil, and a dummy inside the field's reach. */
  function field(gap = 60): {
    state: ServerWorldState;
    casterId: number;
    targetId: number;
  } {
    const empty = createWorldState(7);
    const caster = withPlayer(empty, 600, 450, statsFor(FIELD_SIGIL));
    const target = withDummy(caster.state, 600 + gap, 450);
    return { state: target.state, casterId: caster.id, targetId: target.id };
  }

  function cast_(state: ServerWorldState, casterId: number, ticks: number): Run {
    return run(state, ticks, { 0: [input(casterId, { castAbilityId: 'skill.scorchedEarth' })] });
  }

  it('puts the field on the caster and nothing on anybody else', () => {
    const { state, casterId, targetId } = field();
    const windup = abilityById('skill.scorchedEarth')?.windupTicks ?? 0;
    const landed = cast_(state, casterId, windup + 2);
    const caster = landed.state.entities.get(casterId);
    expect(statusOf(caster?.statuses ?? {}, StatusId.ScorchedEarth, landed.state.tick)).not.toBeNull();
    // The *field* is the caster's; what the target gets is the affliction.
    const target = landed.state.entities.get(targetId);
    expect(statusOf(target?.statuses ?? {}, StatusId.ScorchedEarth, landed.state.tick)).toBeNull();
  });

  it('burns what is standing in it, through the real tick', () => {
    const { state, casterId, targetId } = field();
    const windup = abilityById('skill.scorchedEarth')?.windupTicks ?? 0;
    const landed = cast_(state, casterId, windup + 4);
    const target = landed.state.entities.get(targetId);
    const burn = statusOf(target?.statuses ?? {}, StatusId.Burn, landed.state.tick);
    expect(burn).not.toBeNull();
    // Credited to the caster, which is what makes a field's kill pay somebody.
    expect(burn?.sourceId).toBe(casterId);
    // And it is really pulsing: the health bar moves without a second cast.
    const later = run(landed.state, SERVER_TICK_RATE);
    expect(hits(later.events).some((hit) => hit.targetId === targetId && hit.periodic)).toBe(true);
  });

  it('leaves a body outside its reach alone', () => {
    const away = SCORCHED_EARTH.radius + 200;
    const { state, casterId, targetId } = field(away);
    const windup = abilityById('skill.scorchedEarth')?.windupTicks ?? 0;
    const landed = cast_(state, casterId, windup + 4);
    const target = landed.state.entities.get(targetId);
    expect(statusOf(target?.statuses ?? {}, StatusId.Burn, landed.state.tick)).toBeNull();
  });

  it('stops burning once the field has run out', () => {
    // Eight seconds of field plus the linger, and then some. The affliction has
    // to be gone, or the field is a permanent burn with a delay on the front.
    const { state, casterId, targetId } = field();
    const ability = abilityById('skill.scorchedEarth');
    const held = ability?.effects?.[0];
    const duration = held && held.kind === 'applyStatus' ? held.durationTicks : 0;
    expect(duration).toBeGreaterThan(0);
    const windup = ability?.windupTicks ?? 0;
    const landed = cast_(state, casterId, windup + duration + SERVER_TICK_RATE * 2);
    const target = landed.state.entities.get(targetId);
    expect(statusOf(target?.statuses ?? {}, StatusId.Burn, landed.state.tick)).toBeNull();
    expect(
      statusOf(landed.state.entities.get(casterId)?.statuses ?? {}, StatusId.ScorchedEarth, landed.state.tick),
    ).toBeNull();
  });

  /**
   * The property that makes adding this pass to the tick safe at all: it draws
   * **nothing**. Measured from the tick the field is up -- by which point the
   * cast has rolled whatever it was going to -- through four hundred more ticks
   * of it burning a body.
   */
  it('never touches the Rng while it burns', () => {
    const { state, casterId, targetId } = field();
    const ctx = context();
    let current = state;
    let quiet: string | null = null;
    for (let i = 0; i < 400; i++) {
      current = step(
        current,
        i === 0 ? [input(casterId, { castAbilityId: 'skill.scorchedEarth' })] : [],
        ctx,
      ).state;
      const burning = statusOf(
        current.entities.get(targetId)?.statuses ?? {},
        StatusId.Burn,
        current.tick,
      );
      if (quiet === null && burning) quiet = JSON.stringify(current.rng.getState());
    }
    expect(quiet).not.toBeNull();
    expect(JSON.stringify(current.rng.getState())).toBe(quiet);
  });

  it('replays the same seed and the same frames to bit-identical state', () => {
    const scripted = (): ServerWorldState => {
      const { state, casterId } = field();
      return run(state, 300, {
        0: [input(casterId, { castAbilityId: 'skill.scorchedEarth' })],
      }).state;
    };
    const snapshot = (state: ServerWorldState): string =>
      JSON.stringify({
        tick: state.tick,
        nextEntityId: state.nextEntityId,
        rng: state.rng.getState(),
        entities: [...state.entities.values()],
      });
    expect(snapshot(scripted())).toBe(snapshot(scripted()));
  });
});

/**
 * The test row (spec 190).
 *
 * Not content, so nothing here asserts a number anybody balanced. What it
 * asserts is the one thing the row exists to do -- put the **whole** mark row on
 * one body in one press -- and the three ways a test instrument could quietly
 * stop being one: by hurting what it measures, by knocking it over, or by
 * leaking into the economy.
 */
describe('a skill that marks everything', () => {
  const TEST_SIGIL: Equipment = { ...EMPTY_EQUIPMENT, skill1: 'sigil.testStatuses' };

  function marked(): { run: Run; target: ServerEntity | undefined; before: ServerEntity | undefined } {
    const { state, casterId, targetId } = duel(TEST_SIGIL);
    const before = state.entities.get(targetId);
    const windup = abilityById('skill.testStatuses')?.windupTicks ?? 0;
    const landed = run(state, windup + 2, {
      0: [cast(casterId, 'skill.testStatuses', before ?? null)],
    });
    return { run: landed, target: landed.state.entities.get(targetId), before };
  }

  /**
   * Written over `STATUS_VISUALS` rather than over a list of ids, which is the
   * whole point of the assertion: a tenth row added to that table fails this
   * test until this row applies it too, where a hand-written list would go on
   * passing while the thing it is for -- the full row -- was no longer full.
   *
   * Mapped through `visualFor` for the same reason the packer is: `adapted` is
   * not an id the sim ever writes, so what has to be true is that some live
   * status *draws as* each row.
   */
  it('leaves every mark the client can draw live on one body, at once', () => {
    const { run: landed, target } = marked();
    const drawn = new Set(
      Object.keys(target?.statuses ?? {})
        .filter((id) => statusOf(target?.statuses ?? {}, id, landed.state.tick) !== null)
        .map((id) => visualFor(id)?.id)
        .filter((id): id is string => id !== undefined),
    );
    for (const visual of STATUS_VISUALS) {
      expect(drawn.has(visual.id), `${visual.id} is not on the target`).toBe(true);
    }
    expect(drawn.size).toBe(STATUS_VISUALS.length);
  });

  /**
   * Two of the twelve ids arrive without the row authoring them, because this
   * lands as a real blow and `markTarget` writes both. That is the argument for
   * keeping a damage effect at all, so it is asserted rather than assumed.
   */
  it('gets the two in-a-fight timers from the blow itself', () => {
    const { run: landed, target } = marked();
    for (const id of [StatusId.RecentlyHit, StatusId.InCombat]) {
      expect(statusOf(target?.statuses ?? {}, id, landed.state.tick), id).toBeTruthy();
    }
  });

  /**
   * The two it deliberately leaves alone. Both are inverted -- carrying one
   * means the mechanic has fired and has not re-armed -- so a test row that
   * applied them would switch Second Wind and Perfect Exit off on the very body
   * somebody is measuring.
   */
  it('never writes the two inverted flags, so what it marked can still recover', () => {
    const { run: landed, target } = marked();
    for (const id of [StatusId.SecondWindSpent, StatusId.PerfectExitSpent]) {
      expect(statusOf(target?.statuses ?? {}, id, landed.state.tick), id).toBeNull();
    }
  });

  /**
   * Two windows, not one, and the split is the two specs meeting rather than a
   * loosened assertion.
   *
   * The nine this row *authors* share `TEST_STATUS_TICKS`, for the reason the
   * constant gives: what the row is for is having them live at the same
   * instant, and nine tuned durations would keep breaking that. The seven
   * afflictions do not, because they are not authored here at all -- spec 190
   * applies a row **whole**, so a test Burn is the Burn, at the length the
   * table states. A test instrument showing a mark for something the game does
   * not have would be worse than one whose marks expire at different times.
   */
  it('holds the marks it authors for one window, and an affliction for its own', () => {
    const { run: landed, target } = marked();
    for (const [id, held] of Object.entries(target?.statuses ?? {})) {
      if (visualFor(id) === null) continue;
      const affliction = dotById(id);
      if (affliction) {
        expect(held.expiresAtTick - held.appliedAtTick, id).toBe(dotDurationTicks(affliction));
        continue;
      }
      expect(held.expiresAtTick, id).toBeLessThanOrEqual(landed.state.tick + TEST_STATUS_TICKS);
    }
  });

  it('does little to no damage: one point before mitigation, and no kill', () => {
    const { run: landed, target, before } = marked();
    const blows = hits(landed.events);
    expect(blows.length).toBe(1);
    expect(blows[0]?.damage).toBeLessThanOrEqual(1);
    expect(blows[0]?.killed).toBe(false);
    expect((before?.health ?? 0) - (target?.health ?? 0)).toBeLessThanOrEqual(1);
  });

  /**
   * Cast until the cooldown has come round several times. A test instrument that
   * kills what it is measuring after a minute of use is not one.
   */
  it('cannot kill what it is marking, however many times it lands', () => {
    const { state, casterId, targetId } = duel(TEST_SIGIL);
    const ability = abilityById('skill.testStatuses');
    if (!ability) throw new Error('no skill.testStatuses');
    const target = state.entities.get(targetId);
    const period = ability.windupTicks + ability.cooldownTicks + 2;
    const frames: Record<number, ServerInput[]> = {};
    for (let i = 0; i < 8; i++) frames[i * period] = [cast(casterId, 'skill.testStatuses', target ?? null)];
    const landed = run(state, period * 8, frames);
    const after = landed.state.entities.get(targetId);
    expect(hits(landed.events).length).toBeGreaterThan(1);
    expect(after?.health ?? 0).toBeGreaterThan(0);
  });

  /**
   * The stacking marks are the other half of a short cooldown: three of the nine
   * rows draw a count, and a count that never moved would be a picture nobody
   * had checked.
   */
  it('builds the stacking marks up when it is cast again', () => {
    const { state, casterId, targetId } = duel(TEST_SIGIL);
    const ability = abilityById('skill.testStatuses');
    if (!ability) throw new Error('no skill.testStatuses');
    const target = state.entities.get(targetId);
    const period = ability.windupTicks + ability.cooldownTicks + 2;
    const landed = run(state, period * 2 + 2, {
      0: [cast(casterId, 'skill.testStatuses', target ?? null)],
      [period]: [cast(casterId, 'skill.testStatuses', target ?? null)],
    });
    const after = landed.state.entities.get(targetId);
    expect(statusOf(after?.statuses ?? {}, StatusId.Flow, landed.state.tick)?.stacks).toBe(2);
  });

  /**
   * An ability blow carries `staggerPower * abilityPoiseFactor` of guard damage,
   * and that factor is zero for everyone but the Strength+Intelligence pair --
   * so a mark measured through a body that cannot move is exactly what this row
   * must not produce.
   */
  it('does not knock over what it marks', () => {
    const { target, before } = marked();
    expect(target?.activity).not.toBe(ActivityValue.Stunned);
    expect(target?.poise).toBe(before?.poise);
  });

  it('actually slows what it marked, so the mark is not a claim about nothing', () => {
    const { run: landed, target } = marked();
    const scale = moveScaleOf(target?.statuses ?? {}, landed.state.tick, MIN_MOVE_SCALE);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(MIN_MOVE_SCALE);
  });

  it('is refused unless it is carried, like every other skill', () => {
    const { state, casterId, targetId } = duel(EMPTY_EQUIPMENT);
    const target = state.entities.get(targetId);
    const { events } = run(state, 4, { 0: [cast(casterId, 'skill.testStatuses', target ?? null)] });
    expect(rejections(events)).toContain('notEquipped');
  });

  it('is worn in any of the four skill slots', () => {
    for (const slot of ['skill1', 'skill2', 'skill3', 'skill4'] as const) {
      expect(skillAbilityIdsOf({ ...EMPTY_EQUIPMENT, [slot]: 'sigil.testStatuses' })).toEqual([
        'skill.testStatuses',
      ]);
    }
  });

  /**
   * The leak that would make it content by accident. `value: 0` is what stops
   * both prices, and the two tables are what stop it arriving on its own.
   */
  it('is worth nothing and is in no drop table and no vendor stock', () => {
    expect(itemById('sigil.testStatuses')?.value).toBe(0);
    for (const [monsterId, table] of DROP_TABLES) {
      for (const entry of table.entries) {
        expect(entry.defId, `${monsterId} drops it`).not.toBe('sigil.testStatuses');
      }
    }
    for (const vendor of ALL_VENDORS) {
      expect(vendor.stock, vendor.id).not.toContain('sigil.testStatuses');
    }
  });
});
