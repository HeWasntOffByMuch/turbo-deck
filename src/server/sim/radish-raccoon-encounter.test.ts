/**
 * What the radish raccoon is to fight (spec 277).
 *
 * The brief was three sentences -- non-aggressive, low damage, low health,
 * something a starting character can handle -- and every one of them is a claim
 * about a *fight* rather than about a table. So this measures the fight: a
 * fresh character with the kit every fresh character starts with, swinging the
 * real `resolveBlow` at a body built from the real row, and the raccoon
 * swinging back.
 *
 * That distinction is not pedantry here. `attackDamage` on a monster row
 * reached nothing at all until spec 217 -- every melee body in the game hit for
 * exactly 14 whatever its row said -- which is the exact failure a test reading
 * the table cannot see and a test landing a blow cannot miss.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { SERVER_TICK_RATE } from '../config.js';
import { abilityById, type AbilityDefinition } from '../data/abilities.js';
import { ALL_MONSTERS, monsterById, isFriendlyMonster, noticeRangeOf } from '../data/monsters.js';
import { startingBaseStats } from '../player/attributes.js';
import { STARTER_EQUIPMENT } from '../player/player-manager.js';
import { computeEffectiveStats } from '../player/stats.js';
import { emptyInventory, type EffectiveStats, type PersistedPlayer } from '../state/types.js';
import { attackTimingFor } from './abilities.js';
import { resolveBlow } from './blow.js';
import { ActivityValue, AggroValue, EntityKindValue, type ServerEntity } from './types.js';
import { blankProgression } from './world.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleErrorText, loadUnitBundle } from '../../units/bundle.js';
import { UnitMachine } from '../../units/machine.js';
import { ATTACK_CONTACT_MS, ATTACK_MS } from '../../units/radish-raccoon-clips.js';

const UNITS = join(process.cwd(), 'assets', 'units');
const UNIT_DEF = join(UNITS, 'radish_raccoon_2', 'radish_raccoon_2.unitdef.json');
const CLIP_LIB = join(UNITS, 'radish_raccoon.core.cliplib.json');

const MOB_ID = 'radish_raccoon';
const SLASH = ((): AbilityDefinition => {
  const ability = abilityById('melee.slash');
  if (!ability) throw new Error('melee.slash is the basic attack and has to exist');
  return ability;
})();

function freshCharacter(): EffectiveStats {
  const record: PersistedPlayer = {
    id: 'fresh',
    displayName: 'fresh',
    baseStats: startingBaseStats(),
    specializations: [],
    // The kit everybody starts holding. Bare hands would be measuring a
    // character punching, which nobody does (spec 217).
    equipment: STARTER_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 1000,
    resource: 100,
    coins: 0,
  };
  return computeEffectiveStats(record);
}

function body(stats: EffectiveStats, overrides: Partial<ServerEntity> = {}): ServerEntity {
  return {
    id: 1,
    kind: EntityKindValue.Player,
    typeId: 'p',
    ownerPlayerId: null,
    spawnTick: 0,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    health: stats.maxHealth,
    level: 1,
    zoneId: 'wilds',
    stats,
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    radius: 16,
    targetId: null,
    aggro: AggroValue.Calm,
    aggroUntilTick: 0,
    velocity: { x: 0, y: 0 },
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
    leashRadius: 0,
    conversationWith: null,
    fleeGoal: null,
    returnStart: null,
    resource: stats.maxResource,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    ...blankProgression(),
    poise: stats.traits.maxPoise,
    ...overrides,
  };
}

/** How many blows `attacker` needs to put `victim` down, over a seeded run. */
function swingsToKill(attacker: ServerEntity, victim: ServerEntity, seed: number): number {
  let current = victim;
  let rng = Rng.fromSeed(seed);
  for (let swing = 1; swing <= 200; swing += 1) {
    const result = resolveBlow(SLASH, attacker, current, swing, rng);
    rng = result.rng;
    current = result.target;
    if (current.health <= 0) return swing;
  }
  return Number.POSITIVE_INFINITY;
}

describe('the radish raccoon is placeable', () => {
  it('is in the roster, so it is in the map editor', () => {
    // `editor/tools.ts` builds `SPAWNER_MONSTER_CHOICES` off `ALL_MONSTERS`,
    // so being here is the whole of being in the dropdown a `spawner` marker
    // picks from. There is no second list to add it to and no map to edit --
    // where one stands is a marker somebody places.
    expect(ALL_MONSTERS.map((row) => row.id)).toContain(MOB_ID);
    expect(monsterById(MOB_ID)).not.toBeNull();
  });
});

describe('the radish raccoon is non-aggressive', () => {
  const row = monsterById(MOB_ID);

  it('has no notice range at all, so nothing it does can start a fight', () => {
    // `notice` is the only path by which a body acquires a target on its own,
    // and it needs a range. `defensive` has none -- `noticeRangeOf` answers 0 --
    // which is stronger than a short one: there is no distance at which walking
    // past this thing provokes it.
    expect(row?.temperament.kind).toBe('defensive');
    expect(noticeRangeOf(row?.temperament ?? { kind: 'defensive' })).toBe(0);
  });

  it('is still something you can fight, unlike the shopkeepers', () => {
    // The other way to be non-aggressive in this table is `friendly`, and it is
    // a different thing: `isHostile` refuses a friendly body outright, so it
    // cannot be hit at all. This one can.
    expect(isFriendlyMonster(MOB_ID)).toBe(false);
  });

  it('wanders rather than standing still', () => {
    expect(row?.idle.kind).toBe('wander');
  });
});

describe('a starting character can handle one', () => {
  const row = monsterById(MOB_ID);
  const mine = freshCharacter();

  it('goes down in a handful of swings of the starter sword', () => {
    // Measured over ten seeds, because the Worn Sword rolls 1-3 and a single
    // seed would be reporting one roll rather than the encounter.
    const player = body(mine);
    const counts: number[] = [];
    for (let seed = 1; seed <= 10; seed += 1) {
      counts.push(swingsToKill(player, body(row?.stats as EffectiveStats, { id: 2, kind: EntityKindValue.Monster, typeId: MOB_ID }), seed));
    }
    const worst = Math.max(...counts);
    expect(Math.min(...counts)).toBeGreaterThan(1);
    expect(worst).toBeLessThanOrEqual(8);
  });

  it('costs almost nothing to kill', () => {
    // The other half of "a starting player can handle them", and the half a
    // health total alone does not answer: what matters is the damage taken over
    // the time the fight takes. Both sides swing on their own interval, so the
    // count of the raccoon's blows is the fight's length over its own cadence.
    const player = body(mine);
    const mob = body(row?.stats as EffectiveStats, { id: 2, kind: EntityKindValue.Monster, typeId: MOB_ID });
    const swings = swingsToKill(player, mob, 7);
    const mySwing = attackTimingFor(SLASH, player).intervalTicks;
    const itsSwing = attackTimingFor(SLASH, mob).intervalTicks;
    const fightTicks = swings * mySwing;
    const blowsTaken = Math.floor(fightTicks / itsSwing);

    let hurt = player;
    let rng = Rng.fromSeed(11);
    for (let blow = 0; blow < blowsTaken; blow += 1) {
      const result = resolveBlow(SLASH, mob, hurt, blow, rng);
      rng = result.rng;
      hurt = result.target;
    }
    const lost = mine.maxHealth - hurt.health;
    // Under a tenth of a fresh character's health for the whole encounter.
    expect(lost).toBeGreaterThan(0);
    expect(lost / mine.maxHealth).toBeLessThan(0.1);
    // And it is slow enough that standing in front of one is survivable for a
    // very long time -- which is what makes it safe to put near a spawn point.
    const secondsToKillAFreshCharacter = (mine.maxHealth / (row?.stats.attackDamage ?? 1)) * (itsSwing / SERVER_TICK_RATE);
    expect(secondsToKillAFreshCharacter).toBeGreaterThan(60);
  });

  it('is the gentlest thing in the roster that fights back', () => {
    // Ordering rather than an absolute: what makes this the starter encounter
    // is that nothing else which answers a blow hits softer or dies faster.
    const fighters = ALL_MONSTERS.filter(
      (other) => other.id !== MOB_ID && !isFriendlyMonster(other.id) && other.temperament.kind !== 'skittish',
    );
    for (const other of fighters) {
      expect(
        other.stats.attackDamage,
        `${other.id} hits softer than the starter mob`,
      ).toBeGreaterThanOrEqual(row?.stats.attackDamage ?? 0);
    }
  });
});

describe('the body knows how to swing it', () => {
  /**
   * The state machine, driven the way `driveUnit` drives one.
   *
   * Everything above this asserts the *fight*, and all of it would hold beside a
   * unit document whose attack reached nothing: the sim swings and the renderer
   * draws whatever state its machine happens to be in. `driveUnit` raises the
   * `attack` trigger and no more, so what has to be true is that raising it
   * lands in a state playing the attack clip, that the state refuses to be left
   * while the blow is committed, and that it comes back on its own.
   */
  const machine = (): UnitMachine => {
    const unitDoc = JSON.parse(readFileSync(UNIT_DEF, 'utf8')) as unknown;
    const libDoc = JSON.parse(readFileSync(CLIP_LIB, 'utf8')) as unknown;
    const bundle = loadUnitBundle(unitDoc, libDoc);
    expect(bundle.value, bundleErrorText(bundle)).not.toBeNull();
    if (!bundle.value) throw new Error('no bundle');
    return new UnitMachine({ unit: bundle.value.unit, clipLib: bundle.value.clipLib });
  };

  it('enters the swing on the trigger and comes back on its own', () => {
    const driven = machine();
    expect(driven.stateId).toBe('idle');
    driven.trigger('attack');
    driven.step(1);
    expect(driven.stateId, 'the attack trigger reaches nothing').toBe('swing');

    // Locking: a body committed to a blow does not walk out of it, whatever the
    // parameters say. That is the whole reason the state is that category.
    driven.setParameter('speed', 200);
    driven.step(Math.round(ATTACK_MS / 2 / (1000 / SERVER_TICK_RATE)));
    expect(driven.stateId, 'the swing was interrupted mid-blow').toBe('swing');

    // And it finishes without anybody telling it to.
    driven.setParameter('speed', 0);
    driven.step(Math.round((ATTACK_MS + 400) / (1000 / SERVER_TICK_RATE)));
    expect(driven.stateId).toBe('idle');
  });

  it('fires the impact on the frame the blow lands', () => {
    const driven = machine();
    driven.trigger('attack');
    const perTick = 1000 / SERVER_TICK_RATE;
    let impactAt: number | null = null;
    for (let tick = 1; tick <= Math.round(ATTACK_MS / perTick) + 4; tick += 1) {
      for (const event of driven.step(1)) {
        if (event.name === 'swing.impact') impactAt = tick * perTick;
      }
    }
    expect(impactAt, 'swing.impact never fired').not.toBeNull();
    // Within a tick of the contact the clip was authored around, which is
    // `melee.slash`'s own wind-up -- the frame the picture lands and the frame
    // the damage lands being the same frame is what the whole timing is for.
    expect(Math.abs((impactAt ?? 0) - ATTACK_CONTACT_MS)).toBeLessThanOrEqual(perTick + 1);
  });
});
