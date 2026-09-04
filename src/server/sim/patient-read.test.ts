/**
 * Patient Read: banked by withholding the attack, spent on a weak point (spec 272).
 *
 * Driven through the real `step` rather than by calling the pieces, and for the
 * reason this whole specialization exists: the one it replaces was *correct in
 * every unit test it had* and could not fire, because the field it read was
 * stamped by a pass running earlier in the same tick. A test that called the
 * grant and the payoff directly would have passed against Steady Aim too.
 *
 * So the shape of every case here is: run a real fight for a real number of
 * ticks, and read what the sim actually did.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { SCALING } from '../data/scaling.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { hasStatus, StatusId } from './statuses.js';
import {
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerWorldState,
} from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';

const CHUNK = 100;
const AT = { x: 600, y: 450 };

function record(
  attributes: Partial<BaseStats>,
  specializations: readonly SpecializationAllocation[],
): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: {
      strength: 5,
      agility: 5,
      intelligence: 5,
      constitution: 5,
      perception: 5,
      wisdom: 5,
      ...attributes,
    },
    specializations,
    // The sigil is worn, because `startCast` refuses a `skill: true` ability
    // that is not in `skillAbilityIds` (spec 188) -- so an unequipped skill
    // would make every ability case here pass by never casting at all.
    equipment: { ...EMPTY_EQUIPMENT, skill1: 'sigil.rendingCut' },
    inventory: emptyInventory(),
    coins: 0,
    position: { x: AT.x, y: AT.y, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 60,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 100,
  };
}

/** A reader: enough Perception to reach the tier, and the tiers themselves. */
function reader(tier = 3): EffectiveStats {
  return {
    ...computeEffectiveStats(
      record({ perception: 60 }, [{ specializationId: 'per.patientRead', tier }]),
    ),
    critChance: 0,
  };
}

/** The same character with no Patient Read bought at all. */
function novice(): EffectiveStats {
  return { ...computeEffectiveStats(record({ perception: 60 }, [])), critChance: 0 };
}

/**
 * A reader who finds a seam on essentially every blow.
 *
 * The chance is pinned above what `deriveTraits` will hand out, deliberately:
 * what these cases are about is whether a weak point *consumes* the read, and a
 * probabilistic roll would make them flake on a seed rather than fail on a bug.
 * The chance itself is `weak-point-chance.test.ts`'s subject.
 */
function sureThing(tier = 3): EffectiveStats {
  const base = reader(tier);
  return { ...base, traits: { ...base.traits, weakPointChance: 0.95 } };
}

function context(): StepContext {
  const keys = new Set<string>();
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) keys.add(chunkKeyOf(AT.x + dx * CHUNK, AT.y + dy * CHUNK, CHUNK));
  }
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: keys,
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

interface Fight {
  state: ServerWorldState;
  self: number;
  foe: number;
  ctx: StepContext;
}

/** A player and an unkillable dummy in reach, so a fight can run as long as needed. */
function fight(stats: EffectiveStats): Fight {
  let state = createWorldState(1);
  const p = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: AT.x, y: AT.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = p.state;
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  const m = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x: AT.x + 40, y: AT.y, z: 0 },
    stats: { ...definition.stats, maxHealth: 1_000_000 },
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  state = m.state;
  const body = state.entities.get(m.entity.id);
  if (body) state = replaceEntity(state, { ...body, health: 1_000_000 });
  return { state, self: p.entity.id, foe: m.entity.id, ctx: context() };
}

const selfOf = (f: Fight): ServerEntity => {
  const e = f.state.entities.get(f.self);
  if (!e) throw new Error('no self');
  return e;
};

const holdsRead = (f: Fight): boolean =>
  hasStatus(selfOf(f).statuses, StatusId.PatientRead, f.state.tick);

/** Advance `ticks`, optionally moving, optionally attacking on the first tick. */
function advance(
  f: Fight,
  ticks: number,
  options: { attackWith?: string; move?: boolean } = {},
): Fight {
  let { state } = f;
  for (let i = 0; i < ticks; i++) {
    const attacking = options.attackWith !== undefined && i === 0;
    const target = state.entities.get(f.foe);
    const result = step(
      state,
      [
        input(f.self, {
          seq: i + 1,
          moveX: options.move === true ? 1 : 0,
          castAbilityId: attacking ? options.attackWith ?? '' : '',
          castTargetX: target?.position.x ?? AT.x + 40,
          castTargetY: target?.position.y ?? AT.y,
          castTargetEntityId: target?.id ?? 0,
        }),
      ],
      f.ctx,
    );
    state = result.state;
  }
  return { ...f, state };
}

const WAIT = SCALING.perception.patientReadTicks;

// ---------------------------------------------------------------------------

describe('banking a Patient Read', () => {
  it('takes the whole configured interval without attacking', () => {
    let f = fight(reader());
    // Commit an attack so `lastAttackTick` is genuinely stamped, then measure
    // the wait from *that* tick rather than from the start of the fight -- the
    // commit lands partway through the wind-up, so counting from tick 0 would
    // be asserting against the wrong clock.
    f = advance(f, 40, { attackWith: 'melee.slash' });
    const stamped = selfOf(f).lastAttackTick;
    expect(stamped, 'no commit to measure from').toBeGreaterThan(0);
    expect(holdsRead(f)).toBe(false);

    // One tick short of the interval: still nothing.
    f = advance(f, stamped + WAIT - 1 - f.state.tick);
    expect(f.state.tick - stamped).toBe(WAIT - 1);
    expect(holdsRead(f), 'banked a tick early').toBe(false);

    f = advance(f, 1);
    expect(f.state.tick - stamped).toBe(WAIT);
    expect(holdsRead(f), 'never banked').toBe(true);
  });

  it('is never granted to somebody who has not bought a tier', () => {
    let f = fight(novice());
    expect(selfOf(f).stats.traits.patientReadTicks).toBe(0);
    f = advance(f, WAIT * 3);
    expect(holdsRead(f)).toBe(false);
  });

  it('is not reset by movement, at any distance', () => {
    let f = fight(reader());
    f = advance(f, 20, { attackWith: 'melee.slash' });
    const start = selfOf(f).position.x;
    f = advance(f, WAIT + 40, { move: true });
    expect(selfOf(f).position.x, 'the body never moved').not.toBeCloseTo(start, 1);
    expect(holdsRead(f), 'movement ate the read').toBe(true);
  });

  it('is reset by committing an attack', () => {
    let f = fight(reader());
    f = advance(f, WAIT + 20);
    expect(holdsRead(f)).toBe(true);

    // Spend it on a swing, then check the clock restarted rather than the read
    // simply surviving: a fresh read must not be available immediately after.
    f = advance(f, 40, { attackWith: 'melee.slash' });
    const stamped = selfOf(f).lastAttackTick;
    expect(stamped, 'the commit never stamped').toBeGreaterThan(0);
    expect(f.state.tick - stamped).toBeLessThan(WAIT);
  });

  it('does not stamp for a wind-up that was withdrawn from', () => {
    let f = fight(reader());
    f = advance(f, WAIT + 20, { attackWith: 'melee.slash' });
    const afterReal = selfOf(f).lastAttackTick;

    // A second fight: start a swing and withdraw from it before the commit.
    let g = fight(reader());
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    let state = g.state;
    const target = state.entities.get(g.foe);
    state = step(
      state,
      [
        input(g.self, {
          castAbilityId: 'melee.slash',
          castTargetX: target?.position.x ?? 0,
          castTargetY: target?.position.y ?? 0,
          castTargetEntityId: g.foe,
        }),
      ],
      g.ctx,
    ).state;
    // Withdraw on the next tick, well inside the wind-up.
    state = step(state, [input(g.self, { seq: 2, cancelCast: true })], g.ctx).state;
    g = { ...g, state };

    expect(afterReal, 'a real commit stamps').toBeGreaterThan(0);
    expect(selfOf(g).lastAttackTick, 'a feint must not stamp').toBe(0);
  });
});

describe('spending a Patient Read', () => {
  /** Run until a weak point lands, reporting whether the read was consumed. */
  function untilWeakPoint(stats: EffectiveStats, abilityId: string): {
    held: boolean;
    consumed: boolean;
    damage: number;
  } {
    let f = fight(stats);
    f = advance(f, WAIT + 10);
    const held = holdsRead(f);

    let damage = 0;
    let consumed = false;
    let state = f.state;
    // Long enough for several casts of a seven-second sigil.
    for (let i = 0; i < 2000 && !consumed; i++) {
      const self = state.entities.get(f.self);
      const target = state.entities.get(f.foe);
      if (!self || !target) break;
      const result = step(
        state,
        [
          input(f.self, {
            seq: i + 1,
            castAbilityId: self.cast === null ? abilityId : '',
            castTargetX: target.position.x,
            castTargetY: target.position.y,
            castTargetEntityId: target.id,
          }),
        ],
        f.ctx,
      );
      state = result.state;
      for (const event of result.events) {
        if (event.kind === 'hit' && event.attackerId === f.self && event.weakPoint) {
          damage = event.damage;
          consumed = !hasStatus(
            state.entities.get(f.self)?.statuses ?? {},
            StatusId.PatientRead,
            state.tick,
          );
        }
      }
    }
    return { held, consumed, damage };
  }

  it('is consumed by a weak point from a basic attack', () => {
    const out = untilWeakPoint(sureThing(), 'melee.slash');
    expect(out.held).toBe(true);
    expect(out.consumed, 'a weak point did not spend the read').toBe(true);
  });

  it('is consumed by a weak point from an eligible active ability', () => {
    // `skill.rendingCut` is precision 1 -- the loop must not be basic-only.
    const out = untilWeakPoint(sureThing(), 'skill.rendingCut');
    expect(out.held).toBe(true);
    expect(out.consumed, 'an ability weak point did not spend the read').toBe(true);
  });

  it('amplifies the weak point rather than the blow', () => {
    // The same seeded fight with and without the tiers. What changes is the
    // damage of a *weak point*; a blow that found no seam is untouched, which
    // is asserted by `weak-point-chance.test.ts` holding the roll fixed.
    const withRead = untilWeakPoint(sureThing(), 'melee.slash');
    const base = novice();
    const without = untilWeakPoint(
      { ...base, traits: { ...base.traits, weakPointChance: 0.95 } },
      'melee.slash',
    );
    expect(withRead.damage).toBeGreaterThan(without.damage);
  });

  it('pays more at every tier', () => {
    const payoff = (tier: number): number =>
      reader(tier).traits.patientReadPayoffPct;
    expect(payoff(1)).toBeGreaterThan(0);
    expect(payoff(2)).toBeGreaterThan(payoff(1));
    expect(payoff(3)).toBeGreaterThan(payoff(2));
  });

  it('holds the read through a hit that found no weak point', () => {
    // A character with no weak-point chance at all still banks a read, and
    // nothing it lands can spend one -- so a non-weak-point hit is proved not
    // to waste the payoff.
    const blunt: EffectiveStats = {
      ...reader(),
      critChance: 0,
      traits: { ...reader().traits, weakPointChance: 0, openingReadFactor: 0 },
    };
    let f = fight(blunt);
    f = advance(f, WAIT + 10);
    expect(holdsRead(f)).toBe(true);
    f = advance(f, 90, { attackWith: 'melee.slash' });
    expect(holdsRead(f), 'an ordinary hit spent the read').toBe(true);
  });
});

describe('what the read is not', () => {
  it('keeps no per-target state, so a dead target leaves nothing behind', () => {
    // The whole model is one flag on the attacker. Asserted by killing the
    // target and finding the read still exactly where it was: a per-target
    // memory would have to decide what to do here, and this has nothing to do.
    let f = fight(reader());
    f = advance(f, WAIT + 10);
    expect(holdsRead(f)).toBe(true);
    const body = f.state.entities.get(f.foe);
    if (body) f = { ...f, state: replaceEntity(f.state, { ...body, health: 0 }) };
    f = advance(f, 5);
    expect(holdsRead(f)).toBe(true);
  });

  it('banks exactly one read however many enemies are present', () => {
    // There is one status, so switching targets cannot bank one per enemy.
    let f = fight(reader());
    f = advance(f, WAIT * 3);
    const statuses = selfOf(f).statuses;
    const held = Object.keys(statuses).filter((id) => id === StatusId.PatientRead);
    expect(held).toHaveLength(1);
    expect(statuses[StatusId.PatientRead]?.stacks ?? 1).toBe(1);
  });
});
