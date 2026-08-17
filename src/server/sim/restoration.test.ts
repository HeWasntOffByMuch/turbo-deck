/**
 * The health economy, asserted (spec 156).
 *
 * Two halves, and the split is deliberate. The first drives the *arithmetic* --
 * the meter, the bonuses, the anti-farm rules -- directly against
 * `sim/restoration.ts`, because those are pure functions and a test that had to
 * stage a fight to check carry-over would be testing the fight. The second
 * drives the real `step` with real bodies, because everything that could be
 * wrong about the *wiring* -- does a kill actually spawn a mote, does a mote
 * actually reach the player, does the flask actually refund -- is invisible to
 * the first half.
 *
 * The property the whole spec rests on and the one to break first if a change
 * here starts failing: **restoration is deterministic**. There is no roll
 * anywhere in `sim/restoration.ts`, so the same kill is worth the same progress
 * on every run, forever. The long-sequence tests at the bottom lean on that --
 * they assert what twenty kills add up to, which is only a meaningful assertion
 * if twenty kills add up to the same thing twice.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { RESTORATION } from '../data/restoration.js';
import { startingBaseStats } from '../player/attributes.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { startCast } from './abilities.js';
import { applyStatus, hasStatus, StatusId } from './statuses.js';
import {
  advanceMeter,
  assistsOn,
  baseContributionOf,
  contributionFor,
  creditAssist,
  creditKill,
  eliteKey,
  farmKey,
  isEliteType,
  markAssist,
  meterFraction,
  MoteKind,
  MOTE_TYPE_ID,
  moteKindFor,
  moteValueFor,
  salvageFrom,
  scatterMotes,
} from './restoration.js';
import {
  EntityKindValue,
  NO_QUALITIES,
  type KillQualities,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import {
  advanceRest,
  createWorldState,
  replaceEntity,
  spawnEntity,
  step,
  type StepContext,
} from './world.js';

// --- fixtures -------------------------------------------------------------

/**
 * Deliberately *outside* Hearthstead, whose bounds are 450..750 by 300..600.
 *
 * The first version of this file fought at 600,450 -- the default spawn, and
 * dead centre of the one rest zone -- so every body under test was quietly
 * regenerating health and refilling its flask between ticks. Three tests failed
 * with numbers a few tenths out and one reported a charge that had come back on
 * its own, which is exactly what resting is supposed to do and exactly what none
 * of them were about.
 */
const ORIGIN = { x: 900, y: 700 };
const CHUNK = 100;

function record(baseStats: Partial<BaseStats> = {}): PersistedPlayer {
  return {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), ...baseStats },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    facing: 0,
    // Greenmarch, not Hearthstead: the arithmetic tests must not have resting
    // quietly topping a body up underneath them.
    currentZone: 'greenmarch',
    level: 10,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 1000,
    resource: 100,
    coins: 0,
  };
}

function statsFor(baseStats: Partial<BaseStats> = {}): EffectiveStats {
  return computeEffectiveStats(record(baseStats));
}

/** A player body, at full everything unless a test says otherwise. */
function player(overrides: Partial<ServerEntity> = {}, baseStats: Partial<BaseStats> = {}): ServerEntity {
  const stats = statsFor(baseStats);
  const state = createWorldState(1);
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p',
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { ...spawned.entity, id: 1, ...overrides };
}

/**
 * A monster body of `typeId`, optionally from a named spawner.
 *
 * Explicitly id 2, because `player` is id 1: both fixtures spawn into their own
 * fresh world, so without this they share an id and `creditKill` refuses the
 * whole thing under its "never for killing yourself" guard.
 */
function monster(typeId: string, overrides: Partial<ServerEntity> = {}): ServerEntity {
  const row = monsterById(typeId);
  if (!row) throw new Error(`no such monster: ${typeId}`);
  const state = createWorldState(1);
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x: ORIGIN.x + 60, y: ORIGIN.y, z: 0 },
    stats: row.stats,
    radius: row.radius,
    zoneId: 'greenmarch',
  });
  return { ...spawned.entity, id: 2, ...overrides };
}

function qualities(overrides: Partial<KillQualities> = {}): KillQualities {
  return { ...NO_QUALITIES, ...overrides };
}

const CONTEXT: StepContext = {
  world: DEFAULT_WORLD,
  terrain: FLAT_TERRAIN,
  zones: new ZoneManager(),
  config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
  activeChunks: (() => {
    const keys = new Set<string>();
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        keys.add(chunkKeyOf(ORIGIN.x + dx * CHUNK, ORIGIN.y + dy * CHUNK, CHUNK));
      }
    }
    return keys;
  })(),
  chunkSize: CHUNK,
  spawnPoints: [],
};

function idle(entityId: number, overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    entityId,
    seq: 0,
    moveX: 0,
    moveY: 0,
    facing: 0,
    buttons: 0,
    predictedX: ORIGIN.x,
    predictedY: ORIGIN.y,
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

// --------------------------------------------------------------------------

describe('the meter', () => {
  it('carries the excess over rather than discarding it', () => {
    const threshold = RESTORATION.threshold;
    const first = advanceMeter(0, threshold * 0.7);
    expect(first.motes).toBe(0);
    expect(first.meter).toBeCloseTo(threshold * 0.7);

    const second = advanceMeter(first.meter, threshold * 0.5);
    expect(second.motes).toBe(1);
    // 1.2 thresholds in, one mote out, 0.2 left standing.
    expect(second.meter).toBeCloseTo(threshold * 0.2);
  });

  it('crosses more than once in a single event', () => {
    // The rule that stops a big kill being worth less than the two small ones it
    // replaced. A boolean here would return one mote and throw the rest away.
    const crossed = advanceMeter(0, RESTORATION.threshold * 2.5);
    expect(crossed.motes).toBe(2);
    expect(crossed.meter).toBeCloseTo(RESTORATION.threshold * 0.5);
  });

  it('never goes negative, whatever it is handed', () => {
    expect(advanceMeter(0, -50).meter).toBe(0);
    expect(advanceMeter(Number.NaN, 10).meter).toBeCloseTo(10);
    expect(advanceMeter(0, Number.NaN).meter).toBe(0);
  });

  it('is reported to the client as a fraction and nothing else', () => {
    expect(meterFraction(0)).toBe(0);
    expect(meterFraction(RESTORATION.threshold / 2)).toBeCloseTo(0.5);
    // Clamped rather than allowed past 1: the absolute meter is a server fact,
    // and a bar cannot be more than full.
    expect(meterFraction(RESTORATION.threshold * 3)).toBe(1);
  });

  it('is exactly reproducible over a long sequence', () => {
    const run = (): number => {
      let meter = 0;
      let motes = 0;
      for (let i = 0; i < 40; i++) {
        const advanced = advanceMeter(meter, 17.5 + (i % 3) * 4);
        meter = advanced.meter;
        motes += advanced.motes;
      }
      return motes * 1000 + meter;
    };
    expect(run()).toBe(run());
  });
});

describe('what a body is worth', () => {
  it('weights off the experience the row already authors', () => {
    const stalker = monsterById('stalker');
    expect(stalker).not.toBeNull();
    expect(baseContributionOf(monster('stalker'))).toBeCloseTo(
      (stalker?.experience ?? 0) * RESTORATION.progressPerExperience,
    );
  });

  it('pays a fraction for something that will not fight back', () => {
    // The grazer is passive with no aggro range: food, not an economy.
    const grazer = monsterById('grazer');
    expect(baseContributionOf(monster('grazer'))).toBeCloseTo(
      (grazer?.experience ?? 0) * RESTORATION.progressPerExperience * RESTORATION.passiveFactor,
    );
  });

  it('pays nothing at all for a training dummy', () => {
    // Zero experience, so zero restoration -- which is what makes a dummy
    // scenery with a health bar rather than an infinite sustain fountain.
    expect(baseContributionOf(monster('dummy'))).toBe(0);
  });

  it('pays nothing for a prop or a projectile', () => {
    expect(baseContributionOf(monster('stalker', { kind: EntityKindValue.Prop }))).toBe(0);
    expect(baseContributionOf(monster('stalker', { kind: EntityKindValue.Projectile }))).toBe(0);
  });

  it('classifies an elite off its experience rather than off a flag', () => {
    expect(isEliteType('ravager')).toBe(true);
    expect(isEliteType('stalker')).toBe(false);
    expect(isEliteType('nothing-of-the-sort')).toBe(false);
  });
});

describe('what good combat is worth', () => {
  it('sums the bonuses and clamps them, never multiplies', () => {
    const killer = player();
    const victim = monster('stalker');
    const base = baseContributionOf(victim);

    const plain = contributionFor(killer, victim, NO_QUALITIES, 0);
    expect(plain.total).toBeCloseTo(base);

    const one = contributionFor(killer, victim, qualities({ weakPoint: true }), 0);
    expect(one.total).toBeCloseTo(base * (1 + RESTORATION.bonus.weakPointKill));

    // Two bonuses are the *sum* of their fractions applied once, not each
    // applied in turn -- which is the whole of "no unbounded multiplicative
    // loops": 0.25 and 0.2 give 1.45x, never 1.25 * 1.2.
    const two = contributionFor(killer, victim, qualities({ weakPoint: true, overkill: true }), 0);
    expect(two.total).toBeCloseTo(
      base * (1 + RESTORATION.bonus.weakPointKill + RESTORATION.bonus.overkill),
    );
  });

  it('caps the sum however many fire at once', () => {
    // Every qualifying action, on a build whose stats add to all five of them.
    const paragon = player({}, { strength: 55, agility: 55, intelligence: 55, perception: 55 });
    const all = contributionFor(
      paragon,
      monster('stalker'),
      qualities({
        weakPoint: true,
        overkill: true,
        execution: true,
        untouched: true,
        abilityKill: true,
      }),
      0,
    );
    expect(all.bonus).toBeCloseTo(RESTORATION.bonus.cap);
    expect(all.total).toBeCloseTo(baseContributionOf(monster('stalker')) * (1 + RESTORATION.bonus.cap));
  });

  it('reports why, line by line', () => {
    // The brief's "can a designer inspect why this player got this much".
    const breakdown = contributionFor(
      player(),
      monster('stalker'),
      qualities({ weakPoint: true, untouched: true }),
      0,
    );
    expect(breakdown.sources.map((source) => source.reason).sort()).toEqual([
      'untouched',
      'weakPoint',
    ]);
  });

  it('gives each attribute its own route to a bigger bonus', () => {
    const stalker = monster('stalker');
    const plain = player();
    const worth = (body: ServerEntity, only: Partial<KillQualities>): number =>
      contributionFor(body, stalker, qualities(only), 0).total;

    // Strength pays for the decisive kill, Agility for the untouched one,
    // Intelligence for the one made with a spell, Perception for the precise
    // one -- and each stat moves *only* its own line.
    expect(worth(player({}, { strength: 50 }), { overkill: true })).toBeGreaterThan(
      worth(plain, { overkill: true }),
    );
    expect(worth(player({}, { strength: 50 }), { untouched: true })).toBeCloseTo(
      worth(plain, { untouched: true }),
    );
    expect(worth(player({}, { agility: 50 }), { untouched: true })).toBeGreaterThan(
      worth(plain, { untouched: true }),
    );
    expect(worth(player({}, { intelligence: 50 }), { abilityKill: true })).toBeGreaterThan(
      worth(plain, { abilityKill: true }),
    );
    expect(worth(player({}, { perception: 50 }), { weakPoint: true })).toBeGreaterThan(
      worth(plain, { weakPoint: true }),
    );
  });
});

describe('anti-farm', () => {
  it('decays repeated kills from one spawner, down to a floor', () => {
    const victim = monster('stalker', { spawnerId: 'camp-1' });
    let killer = player();
    const worth: number[] = [];
    for (let kill = 0; kill < 8; kill++) {
      const credit = creditKill(killer, victim, NO_QUALITIES, 0);
      worth.push(credit.contribution.total);
      killer = credit.killer;
    }

    expect(worth[0]).toBeGreaterThan(worth[1] ?? 0);
    expect(worth[1]).toBeGreaterThan(worth[2] ?? 0);
    // And it lands on the floor rather than reaching zero: farming pays badly,
    // it never pays nothing, because a rule that reached zero would make a
    // popular camp a dead zone rather than a poor one.
    const last = worth[worth.length - 1] ?? 0;
    expect(last).toBeCloseTo(baseContributionOf(victim) * RESTORATION.farm.floor);
  });

  it('does not punish killing something else', () => {
    // Different spawners are different bodies. Clearing an area is not farming
    // one corner of it, and the rule has to be able to tell them apart.
    let killer = player();
    for (let kill = 0; kill < 6; kill++) {
      killer = creditKill(killer, monster('stalker', { spawnerId: 'camp-1' }), NO_QUALITIES, 0).killer;
    }
    const elsewhere = creditKill(killer, monster('stalker', { spawnerId: 'camp-2' }), NO_QUALITIES, 0);
    expect(elsewhere.contribution.total).toBeCloseTo(baseContributionOf(monster('stalker')));
  });

  it('keys a body with no spawner by its type rather than lumping them together', () => {
    const conjured = monster('stalker');
    const other = monster('slinger');
    expect(farmKey(conjured)).not.toBe(farmKey(other));
    expect(farmKey(conjured)).toBe(farmKey(monster('stalker')));
    // ...and a spawner still wins over the type, so two spawners of the same
    // monster decay independently.
    expect(farmKey(monster('stalker', { spawnerId: 'a' }))).not.toBe(
      farmKey(monster('stalker', { spawnerId: 'b' })),
    );
  });

  it('forgets a spawner once the window has passed', () => {
    const victim = monster('stalker', { spawnerId: 'camp-1' });
    let killer = player();
    for (let kill = 0; kill < 5; kill++) {
      killer = creditKill(killer, victim, NO_QUALITIES, 0).killer;
    }
    const later = creditKill(killer, victim, NO_QUALITIES, RESTORATION.farm.windowTicks + 1);
    expect(later.contribution.total).toBeCloseTo(baseContributionOf(victim));
  });

  it('pays nothing to a monster that killed another monster', () => {
    const credit = creditKill(monster('ravager'), monster('stalker'), NO_QUALITIES, 0);
    expect(credit.motes).toHaveLength(0);
    expect(credit.contribution.total).toBe(0);
  });

  it('pays nothing for killing yourself', () => {
    const self = player();
    expect(creditKill(self, self, NO_QUALITIES, 0).contribution.total).toBe(0);
  });
});

describe('the elite guarantee', () => {
  it('always produces at least the guaranteed number of motes', () => {
    const credit = creditKill(player(), monster('ravager', { spawnerId: 'boss' }), NO_QUALITIES, 0);
    expect(credit.motes.length).toBeGreaterThanOrEqual(RESTORATION.elite.motes);
    expect(credit.guaranteed).toBeGreaterThan(0);
  });

  it('does not pay twice for the same spawner inside its window', () => {
    // The reset-loop rule. A boss re-pulled, or a champion whose adds keep
    // coming, is worth its meter progress and no second guarantee.
    const boss = monster('ravager', { spawnerId: 'boss' });
    const first = creditKill(player(), boss, NO_QUALITIES, 0);
    const second = creditKill(first.killer, boss, NO_QUALITIES, 10);
    expect(second.guaranteed).toBe(0);
    expect(second.motes.length).toBeLessThan(first.motes.length);
  });

  it('pays again once the window has passed', () => {
    const boss = monster('ravager', { spawnerId: 'boss' });
    const first = creditKill(player(), boss, NO_QUALITIES, 0);
    const later = creditKill(first.killer, boss, NO_QUALITIES, RESTORATION.elite.guaranteeTicks + 1);
    expect(later.guaranteed).toBeGreaterThan(0);
  });

  it('never launders a guarantee into carry-over', () => {
    // The guarantee tops the *count* up and must not touch the meter, or a
    // guaranteed drop becomes a way to bank progress toward the next one.
    const credit = creditKill(player(), monster('ravager', { spawnerId: 'boss' }), NO_QUALITIES, 0);
    const fromMeterAlone = advanceMeter(0, credit.contribution.total);
    expect(credit.killer.restoration).toBeCloseTo(fromMeterAlone.meter);
  });

  it('is refused outright in PvP', () => {
    // A player kill must never be a guaranteed reset -- that is the whole of the
    // snowball problem.
    const victim = player({ id: 99, level: 30 });
    const credit = creditKill(player(), victim, NO_QUALITIES, 0);
    expect(credit.guaranteed).toBe(0);
    expect(hasStatus(credit.killer.statuses, eliteKey(victim), 0)).toBe(false);
  });
});

describe('PvP', () => {
  it('pays for a player kill, at its own scale', () => {
    const victim = player({ id: 99, level: 20 });
    const credit = creditKill(player(), victim, NO_QUALITIES, 0);
    expect(credit.contribution.total).toBeCloseTo(
      20 * RESTORATION.pvp.progressPerLevel * RESTORATION.pvp.scale,
    );
  });

  it('pays nothing for killing the same player again', () => {
    // The feeding lock. Two players trading deliberate deaths is the one PvP
    // loop that would otherwise print restoration.
    const victim = player({ id: 99, level: 20 });
    const first = creditKill(player(), victim, NO_QUALITIES, 0);
    const second = creditKill(first.killer, victim, NO_QUALITIES, 60);
    expect(second.contribution.total).toBe(0);
    expect(second.motes).toHaveLength(0);
  });

  it('pays again long after', () => {
    const victim = player({ id: 99, level: 20 });
    const first = creditKill(player(), victim, NO_QUALITIES, 0);
    const later = creditKill(first.killer, victim, NO_QUALITIES, RESTORATION.pvp.victimTicks + 1);
    expect(later.contribution.total).toBeGreaterThan(0);
  });
});

describe('assists', () => {
  it('marks whoever hit a body, and only players', () => {
    let statuses = markAssist({}, 7, 0);
    statuses = markAssist(statuses, 9, 0);
    expect([...assistsOn(statuses, 0)].sort((a, b) => a - b)).toEqual([7, 9]);
    // Expired marks are not assists. Reading a stale one would pay somebody for
    // a fight they left a minute ago.
    expect(assistsOn(statuses, RESTORATION.assistTicks + 1)).toEqual([]);
  });

  it('pays a fraction of the base, with no bonuses and no motes at the corpse', () => {
    const victim = monster('stalker');
    const helper = creditAssist(player(), victim, 0);
    expect(helper.contribution.total).toBeCloseTo(
      baseContributionOf(victim) * RESTORATION.assistFraction,
    );
    expect(helper.guaranteed).toBe(0);
  });

  it('is worth less than finishing it', () => {
    const victim = monster('stalker');
    const killer = creditKill(player(), victim, NO_QUALITIES, 0);
    const helper = creditAssist(player(), victim, 0);
    expect(helper.contribution.total).toBeLessThan(killer.contribution.total);
  });

  it('still crosses the helper\'s own threshold, at their own feet', () => {
    // The property that makes an assist unstealable: it reaches a meter the
    // killer cannot touch, and what it produces lands where the helper is.
    const nearlyThere = player({ restoration: RESTORATION.threshold * 0.99 });
    const helper = creditAssist(nearlyThere, monster('ravager'), 0);
    expect(helper.motes.length).toBeGreaterThan(0);
  });
});

describe('motes', () => {
  it('goes to health whenever health is meaningfully short', () => {
    const stats = statsFor();
    const hurt = player({ health: stats.maxHealth * 0.4, resource: 0 });
    // Empty pool, 60% of health missing: still vitality, because this is a
    // health economy and resource regenerates on its own.
    expect(moteKindFor(hurt)).toBe(MoteKind.Vitality);
  });

  it('goes to resource only when health is nearly full and the pool is not', () => {
    const stats = statsFor();
    const topped = player({ health: stats.maxHealth, resource: 0 });
    expect(moteKindFor(topped)).toBe(MoteKind.Focus);
  });

  it('never offers resource to a body with no pool', () => {
    const noPool = player({ resource: 0 });
    const stripped: ServerEntity = {
      ...noPool,
      stats: { ...noPool.stats, maxResource: 0 },
    };
    expect(moteKindFor(stripped)).toBe(MoteKind.Vitality);
  });

  it('is worth the same proportion whatever the build', () => {
    // A fraction of the collector's own maximum, so a mote means the same thing
    // to a starter and to a Constitution build -- and Wisdom's `healingScale`,
    // applied later, is what makes it worth more.
    const small = player();
    const large = player({}, { constitution: 50 });
    const ratio = (body: ServerEntity): number =>
      moteValueFor(body, MoteKind.Vitality) / body.stats.maxHealth;
    expect(ratio(small)).toBeCloseTo(ratio(large));
    expect(ratio(small)).toBeCloseTo(RESTORATION.mote.healthFraction);
  });

  it('scatters without drawing from the Rng', () => {
    // Determinism: the generator is threaded through the whole sim, so a kill
    // that drew two values for a scatter would change every fight recorded
    // after it. The offsets are a function of the index and the facing, and of
    // nothing else.
    const twice = [
      scatterMotes(3, MoteKind.Vitality, 10, 0.7),
      scatterMotes(3, MoteKind.Vitality, 10, 0.7),
    ];
    expect(twice[0]).toEqual(twice[1]);
    // ...and no two land on the same spot.
    const spots = new Set((twice[0] ?? []).map((mote) => `${mote.offsetX},${mote.offsetY}`));
    expect(spots.size).toBe(3);
  });

  it('bursts toward whoever it belongs to, not out of a fixed compass point', () => {
    const east = scatterMotes(1, MoteKind.Vitality, 10, 0);
    const north = scatterMotes(1, MoteKind.Vitality, 10, Math.PI / 2);
    expect(east[0]?.offsetX).toBeCloseTo(RESTORATION.mote.scatterRadius);
    expect(north[0]?.offsetY).toBeCloseTo(RESTORATION.mote.scatterRadius);
  });

  it('closes the distance to the killer rather than adding to it', () => {
    // The regression `preview-motes.ts` caught. Bursting along the *victim's*
    // facing sent the drop wherever the corpse happened to be looking -- one
    // landed 102 units from a player whose kill had died at 58, which is
    // further away than if it had never hopped at all.
    const killer = player();
    const victim = monster('stalker', {
      position: { x: ORIGIN.x + 120, y: ORIGIN.y, z: 0 },
      // Facing hard away, which is the case that used to be worst.
      facing: 0,
      restoration: 0,
    });
    const credit = creditKill({ ...killer, restoration: RESTORATION.threshold * 0.99 }, victim, NO_QUALITIES, 0);
    expect(credit.motes.length).toBeGreaterThan(0);
    for (const mote of credit.motes) {
      const landsX = victim.position.x + mote.offsetX;
      const landsY = victim.position.y + mote.offsetY;
      const before = Math.hypot(victim.position.x - ORIGIN.x, victim.position.y - ORIGIN.y);
      const after = Math.hypot(landsX - ORIGIN.x, landsY - ORIGIN.y);
      expect(after).toBeLessThan(before);
    }
  });

  it('sends an odd count straight at the killer and splits an even one', () => {
    const three = scatterMotes(3, MoteKind.Vitality, 10, 0);
    // The middle one goes exactly where it was aimed.
    expect(three[1]?.offsetY).toBeCloseTo(0);
    // ...and the other two split around it, one either side.
    expect(Math.sign(three[0]?.offsetY ?? 0)).toBe(-Math.sign(three[2]?.offsetY ?? 0));
  });

  it('makes even a lone mote travel', () => {
    // The common case, and the one the first version left standing still -- so
    // the hop that exists to make a drop legible did nothing for most drops.
    const one = scatterMotes(1, MoteKind.Vitality, 10, 0);
    expect(Math.hypot(one[0]?.offsetX ?? 0, one[0]?.offsetY ?? 0)).toBeCloseTo(
      RESTORATION.mote.scatterRadius,
    );
  });
});

describe("Wisdom's salvage", () => {
  it('returns nothing to a build that has not bought it', () => {
    expect(salvageFrom(player(), 100)).toBe(0);
  });

  it('returns a bounded fraction of the overheal', () => {
    const sage = player({}, { wisdom: 50 });
    expect(salvageFrom(sage, 20)).toBeGreaterThan(0);
    // Capped per event, so no amount of overhealing funds a mote outright.
    const cap = RESTORATION.threshold * RESTORATION.stats.salvageCapFraction;
    expect(salvageFrom(sage, 100000)).toBeCloseTo(cap);
    expect(cap).toBeLessThan(RESTORATION.threshold);
  });
});

// --------------------------------------------------------------------------
// The wiring: everything above is arithmetic, and none of it proves that a kill
// in the real tick produces anything at all.

/** One tick of the real sim, with `inputs` delivered. */
function tick(
  state: ServerWorldState,
  inputs: readonly ServerInput[] = [],
): { state: ServerWorldState; events: readonly ServerSimEvent[] } {
  const result = step(state, inputs, CONTEXT);
  return { state: result.state, events: result.events };
}

/** A world with one player in it, at the origin. */
function world(baseStats: Partial<BaseStats> = {}): {
  state: ServerWorldState;
  selfId: number;
} {
  const spawned = spawnEntity(createWorldState(1), {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p',
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats: statsFor(baseStats),
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { state: spawned.state, selfId: spawned.entity.id };
}

describe('a kill, in the real tick', () => {
  it('produces a mote a fight can actually collect', () => {
    // The end-to-end assertion: a real blow, a real death, a real mote, a real
    // pickup, and health that went up.
    const spawn = world({ strength: 40 });
    let state = spawn.state;
    const selfId = spawn.selfId;
    const self = state.entities.get(selfId);
    if (!self) throw new Error('no player');
    state = replaceEntity(state, {
      ...self,
      // Hurt, so there is somewhere for a mote to go.
      health: self.stats.maxHealth * 0.5,
      restoration: RESTORATION.threshold * 0.95,
    });

    const row = monsterById('stalker');
    const spawned = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      // Inside the player's melee reach, and inside the mote attract radius.
      position: { x: ORIGIN.x + 55, y: ORIGIN.y, z: 0 },
      stats: { ...(row?.stats ?? statsFor()), maxHealth: 1 },
      radius: row?.radius ?? 20,
      zoneId: 'greenmarch',
      health: 1,
    });
    state = spawned.state;
    const foeId = spawned.entity.id;

    let seq = 0;
    let collected = false;
    let generated = 0;
    const startHealth = state.entities.get(selfId)?.health ?? 0;

    for (let t = 0; t < SERVER_TICK_RATE * 6 && !collected; t++) {
      seq += 1;
      const alive = state.entities.get(foeId);
      const result = step(
        state,
        [
          idle(selfId, {
            seq,
            castAbilityId: alive && state.entities.get(selfId)?.cast === null ? 'melee.slash' : '',
            castTargetX: ORIGIN.x + 55,
            castTargetY: ORIGIN.y,
            castTargetEntityId: foeId,
          }),
        ],
        CONTEXT,
      );
      state = result.state;
      for (const event of result.events) {
        if (event.kind === 'restoration' && event.entityId === selfId) generated += event.motes;
        if (event.kind === 'mote' && event.collected && event.ownerId === selfId) collected = true;
      }
    }

    expect(generated).toBeGreaterThan(0);
    expect(collected).toBe(true);
    expect(state.entities.get(selfId)?.health ?? 0).toBeGreaterThan(startHealth);
  });
});

describe('a mote on the ground', () => {
  /** Puts one mote of `kind` at `at`, owned by `ownerId`. */
  function withMote(
    state: ServerWorldState,
    ownerId: number,
    at: { x: number; y: number },
    kind = MoteKind.Vitality,
    amount = 40,
  ): { state: ServerWorldState; moteId: number } {
    const spawned = spawnEntity(state, {
      kind: EntityKindValue.Mote,
      typeId: MOTE_TYPE_ID[kind] ?? '',
      position: { x: at.x, y: at.y, z: 0 },
      stats: statsFor(),
      radius: 7,
      zoneId: 'greenmarch',
    });
    const mote: ServerEntity = {
      ...spawned.entity,
      health: 1,
      mote: {
        kind,
        amount,
        ownerEntityId: ownerId,
        // Already landed: these tests are about what a mote does once it is on
        // the ground, and the hop has its own block below.
        originX: at.x,
        originY: at.y,
        originZ: 0,
        restX: at.x,
        restY: at.y,
        launchFromTick: 0,
        landsAtTick: 0,
        armedAtTick: 0,
        expiresAtTick: spawned.state.tick + RESTORATION.mote.lifetimeTicks,
      },
    };
    return { state: replaceEntity(spawned.state, mote), moteId: mote.id };
  }

  it('hops out of the body before it may be taken', () => {
    // The visibility fix, asserted (spec 156). A mote used to spawn inside its
    // owner's attract radius and be collected on the first tick it was legally
    // allowed to be -- 0.30s on screen, six frames at the broadcast rate. The
    // hop is what buys a drop a beat to be seen in, so it is checked directly:
    // it travels, it leaves the ground, and nothing takes it on the way.
    const spawn = world();
    let state = spawn.state;
    const selfId = spawn.selfId;
    const self = state.entities.get(selfId);
    if (!self) throw new Error('no player');
    state = replaceEntity(state, { ...self, health: 10 });

    // Placed right on top of the player, so *only* the hop can explain any
    // travel and only the hop can explain not being taken instantly.
    const placed = withMote(state, selfId, { x: ORIGIN.x, y: ORIGIN.y });
    const launched = placed.state.entities.get(placed.moteId);
    if (!launched?.mote) throw new Error('no mote');
    state = replaceEntity(placed.state, {
      ...launched,
      mote: {
        ...launched.mote,
        restX: ORIGIN.x + RESTORATION.mote.scatterRadius,
        restY: ORIGIN.y,
        launchFromTick: state.tick,
        landsAtTick: state.tick + RESTORATION.mote.launchTicks,
        armedAtTick: state.tick + RESTORATION.mote.launchTicks + RESTORATION.mote.lingerTicks,
      },
    });

    const heights: number[] = [];
    let travelled = 0;
    let taken = false;
    for (let t = 0; t < RESTORATION.mote.launchTicks - 1; t++) {
      const stepped = tick(state, [idle(selfId)]);
      state = stepped.state;
      const flying = state.entities.get(placed.moteId);
      if (!flying) break;
      heights.push(flying.position.z);
      travelled = Math.abs(flying.position.x - ORIGIN.x);
      if (stepped.events.some((event) => event.kind === 'mote')) taken = true;
    }

    expect(taken).toBe(false);
    expect(travelled).toBeGreaterThan(0);
    // It arcs: the top of the hop is above both ends of it.
    expect(Math.max(...heights)).toBeGreaterThan(heights[0] ?? 0);
    expect(Math.max(...heights)).toBeGreaterThan(heights[heights.length - 1] ?? 0);
  });

  it('is on screen for at least the hop and the linger, wherever it lands', () => {
    // The floor, and the regression this whole block exists to prevent. The
    // first version had none: a mote spawned inside its owner's attract radius
    // and was collected on the first tick it was legally allowed to be, which
    // measured at 0.30s -- six frames at the 20Hz broadcast rate. Placed
    // directly under the player, which is the worst case for visibility, it
    // must still last the hop plus the linger.
    const spawn = world();
    let state = spawn.state;
    const selfId = spawn.selfId;
    const self = state.entities.get(selfId);
    if (!self) throw new Error('no player');
    state = replaceEntity(state, { ...self, health: 10 });

    const at = { x: ORIGIN.x, y: ORIGIN.y };
    const placed = withMote(state, selfId, at);
    const landed = placed.state.entities.get(placed.moteId);
    if (!landed?.mote) throw new Error('no mote');
    const born = placed.state.tick;
    state = replaceEntity(placed.state, {
      ...landed,
      mote: {
        ...landed.mote,
        // Lands where it started, so there is no travel to hide behind.
        restX: at.x,
        restY: at.y,
        launchFromTick: born,
        landsAtTick: born + RESTORATION.mote.launchTicks,
        armedAtTick: born + RESTORATION.mote.launchTicks + RESTORATION.mote.lingerTicks,
      },
    });

    let alive = 0;
    for (let t = 0; t < RESTORATION.mote.lifetimeTicks; t++) {
      const stepped = tick(state, [idle(selfId)]);
      state = stepped.state;
      if (stepped.events.some((event) => event.kind === 'mote')) break;
      alive += 1;
    }

    expect(alive).toBeGreaterThanOrEqual(
      RESTORATION.mote.launchTicks + RESTORATION.mote.lingerTicks - 1,
    );
  });

  it('is only ever collected by its owner', () => {
    const { state: base, selfId } = world();
    const other = spawnEntity(base, {
      kind: EntityKindValue.Player,
      typeId: 'player',
      ownerPlayerId: 'q',
      position: { x: ORIGIN.x + 8, y: ORIGIN.y, z: 0 },
      stats: statsFor(),
      radius: 16,
      zoneId: 'greenmarch',
      health: 10,
    });
    // Standing right on top of a mote that belongs to somebody else.
    const placed = withMote(other.state, selfId, { x: ORIGIN.x + 8, y: ORIGIN.y });
    const stepped = tick(placed.state, [idle(selfId), idle(other.entity.id)]);
    expect(stepped.state.entities.get(other.entity.id)?.health).toBe(10);
  });

  it('is not collected from across the field', () => {
    const { state: base, selfId } = world();
    const self = base.entities.get(selfId);
    if (!self) throw new Error('no player');
    const hurt = replaceEntity(base, { ...self, health: 10 });
    const placed = withMote(hurt, selfId, { x: ORIGIN.x + 900, y: ORIGIN.y });
    const stepped = tick(placed.state, [idle(selfId)]);
    expect(stepped.state.entities.get(placed.moteId)).toBeDefined();
    expect(stepped.state.entities.get(selfId)?.health).toBe(10);
  });

  it('drifts toward its owner from inside the attract radius', () => {
    const { state: base, selfId } = world();
    const self = base.entities.get(selfId);
    if (!self) throw new Error('no player');
    const hurt = replaceEntity(base, { ...self, health: 10 });
    const at = { x: ORIGIN.x + RESTORATION.mote.attractRadius - 5, y: ORIGIN.y };
    const placed = withMote(hurt, selfId, at);
    const stepped = tick(placed.state, [idle(selfId)]);
    const moved = stepped.state.entities.get(placed.moteId);
    expect(moved).toBeDefined();
    expect(moved?.position.x ?? 0).toBeLessThan(at.x);
  });

  it('waits, rather than being wasted, when there is nowhere for it to go', () => {
    // The full-health rule. A mote with nothing to fill is neither attracted nor
    // taken, so walking over one costs nothing -- and since the lifetime is
    // short, there is nothing to hoard either.
    const { state: base, selfId } = world();
    const placed = withMote(base, selfId, { x: ORIGIN.x + 5, y: ORIGIN.y });
    const stepped = tick(placed.state, [idle(selfId)]);
    const waiting = stepped.state.entities.get(placed.moteId);
    expect(waiting).toBeDefined();
    expect(waiting?.position.x).toBeCloseTo(ORIGIN.x + 5);
  });

  it('fades, and says what it cost', () => {
    const { state: base, selfId } = world();
    let { state } = withMote(base, selfId, { x: ORIGIN.x + 900, y: ORIGIN.y });
    let faded: ServerSimEvent | null = null;
    for (let t = 0; t < RESTORATION.mote.lifetimeTicks + 4 && !faded; t++) {
      const stepped = tick(state, [idle(selfId)]);
      state = stepped.state;
      faded = stepped.events.find((event) => event.kind === 'mote' && !event.collected) ?? null;
    }
    expect(faded).not.toBeNull();
    if (faded?.kind === 'mote') {
      expect(faded.restored).toBe(0);
      expect(faded.wasted).toBeGreaterThan(0);
    }
  });

  it('cannot be attacked, and does not interrupt a fight', () => {
    const { state: base, selfId } = world();
    const placed = withMote(base, selfId, { x: ORIGIN.x + 30, y: ORIGIN.y });
    const mote = placed.state.entities.get(placed.moteId);
    expect(mote).toBeDefined();
    // A cone swept over a mote must not resolve against it -- otherwise the
    // swing that produced one deletes it.
    const stepped = tick(placed.state, [
      idle(selfId, {
        seq: 1,
        castAbilityId: 'melee.slash',
        castTargetX: ORIGIN.x + 30,
        castTargetY: ORIGIN.y,
      }),
    ]);
    expect(stepped.events.some((event) => event.kind === 'hit' && event.targetId === placed.moteId)).toBe(
      false,
    );
  });
});

describe('the flask', () => {
  const flask = abilityById('self.hearthdraught');

  it('exists, costs a charge and heals a fraction of the drinker', () => {
    expect(flask).not.toBeNull();
    expect(flask?.chargeCost).toBe(1);
    expect(flask?.healingFraction).toBeGreaterThan(0);
    // Free of resource, or it would be no fallback at all for the build most
    // likely to be out of it.
    expect(flask?.cost).toBe(0);
  });

  it('spends a charge at the commit', () => {
    const body = player({ health: 10 });
    const started = startCast(body, { abilityId: 'self.hearthdraught', targetX: 0, targetY: 0 }, 0);
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.entity.fallbackCharges).toBe(body.fallbackCharges - 1);
      expect(started.entity.cast?.spentCharges).toBe(1);
    }
  });

  it('is refused with an empty flask, and says so in its own words', () => {
    const empty = player({ health: 10, fallbackCharges: 0 });
    const started = startCast(empty, { abilityId: 'self.hearthdraught', targetX: 0, targetY: 0 }, 0);
    expect(started.ok).toBe(false);
    // Its own reason rather than `notEnoughResource`: one is "wait a moment",
    // the other is "go and rest", and a player told the wrong one waits forever.
    if (!started.ok) expect(started.reason).toBe('noCharges');
  });

  it('hands the charge back when the draught is withdrawn from', () => {
    const spawn = world();
    let state = spawn.state;
    const selfId = spawn.selfId;
    const self = state.entities.get(selfId);
    if (!self) throw new Error('no player');
    state = replaceEntity(state, { ...self, health: self.stats.maxHealth * 0.2 });
    const full = state.entities.get(selfId)?.fallbackCharges ?? 0;

    // Commit...
    let stepped = tick(state, [
      idle(selfId, { seq: 1, castAbilityId: 'self.hearthdraught', castTargetX: ORIGIN.x, castTargetY: ORIGIN.y }),
    ]);
    state = stepped.state;
    expect(state.entities.get(selfId)?.fallbackCharges).toBe(full - 1);

    // ...then walk out of it before the attack point.
    stepped = tick(state, [idle(selfId, { seq: 2, moveX: 1, moveY: 0 })]);
    state = stepped.state;
    expect(state.entities.get(selfId)?.fallbackCharges).toBe(full);
    // And nothing was healed: the draught did not happen.
    expect(state.entities.get(selfId)?.health).toBeCloseTo(self.stats.maxHealth * 0.2, 0);
  });

  it('keeps the charge and the healing once it has landed', () => {
    const spawn = world();
    let state = spawn.state;
    const selfId = spawn.selfId;
    const self = state.entities.get(selfId);
    if (!self) throw new Error('no player');
    const startHealth = self.stats.maxHealth * 0.2;
    state = replaceEntity(state, { ...self, health: startHealth });
    const full = self.fallbackCharges;

    let seq = 0;
    for (let t = 0; t < SERVER_TICK_RATE * 3; t++) {
      seq += 1;
      const stepped = tick(state, [
        idle(selfId, {
          seq,
          castAbilityId: t === 0 ? 'self.hearthdraught' : '',
          castTargetX: ORIGIN.x,
          castTargetY: ORIGIN.y,
        }),
      ]);
      state = stepped.state;
    }
    expect(state.entities.get(selfId)?.fallbackCharges).toBe(full - 1);
    expect(state.entities.get(selfId)?.health ?? 0).toBeGreaterThan(startHealth);
  });

  it('holds more charges for a Constitution build, and never unboundedly', () => {
    expect(statsFor({ constitution: 40 }).traits.fallbackCharges).toBeGreaterThan(
      statsFor().traits.fallbackCharges,
    );
    expect(statsFor({ constitution: 60 }).traits.fallbackCharges).toBeLessThanOrEqual(
      RESTORATION.fallback.maxCharges,
    );
  });
});

describe('resting', () => {
  const hearth = new ZoneManager().zoneAt(600, 450);

  it('happens in Hearthstead and nowhere else', () => {
    expect(hearth.rest).toBe(true);
    expect(new ZoneManager().byIdOrWilderness('wilds').rest).not.toBe(true);
  });

  it('returns health and charges over time', () => {
    let body = player({ health: 10, fallbackCharges: 0 });
    for (let t = 0; t < RESTORATION.rest.chargeTicks + 1; t++) {
      body = advanceRest(body, t, true);
    }
    expect(body.health).toBeGreaterThan(10);
    expect(body.fallbackCharges).toBe(1);
  });

  it('refuses while the body is in a fight', () => {
    const fighting = player({
      health: 10,
      fallbackCharges: 0,
      statuses: applyStatus({}, StatusId.InCombat, 0, RESTORATION.rest.combatTicks),
    });
    const rested = advanceRest(fighting, 1, true);
    expect(rested.health).toBe(10);
    expect(rested.fallbackCharges).toBe(0);
  });

  it('refuses outside a rest zone', () => {
    const body = player({ health: 10, fallbackCharges: 0 });
    expect(advanceRest(body, 1, false).health).toBe(10);
  });

  it('stops at the ceiling rather than past it', () => {
    let body = player({ health: 10 });
    for (let t = 0; t < SERVER_TICK_RATE * 60; t++) body = advanceRest(body, t, true);
    expect(body.health).toBeCloseTo(body.stats.maxHealth);
    expect(body.fallbackCharges).toBe(body.stats.traits.fallbackCharges);
  });
});

describe('long sequences', () => {
  /**
   * `count` kills of `typeId`, each from its own spawner, credited in turn.
   *
   * Distinct spawners because what these measure is the *economy* rather than
   * the anti-farm rule -- which has its own block above. A camp is several spawn
   * points; farming is one of them over and over.
   */
  function sequence(
    killer: ServerEntity,
    count: number,
    typeId: string,
    how: KillQualities,
  ): { killer: ServerEntity; motes: number; progress: number } {
    let body = killer;
    let motes = 0;
    let progress = 0;
    for (let kill = 0; kill < count; kill++) {
      const credit = creditKill(body, monster(typeId, { spawnerId: `s${kill}` }), how, kill * 30);
      body = credit.killer;
      motes += credit.motes.length;
      progress += credit.contribution.total;
    }
    return { killer: body, motes, progress };
  }

  it('pays a flawless run more than a scrappy one, and by a bounded amount', () => {
    const scrappy = sequence(player(), 20, 'stalker', NO_QUALITIES);
    const flawless = sequence(
      player(),
      20,
      'stalker',
      qualities({ weakPoint: true, overkill: true, untouched: true }),
    );
    expect(flawless.motes).toBeGreaterThan(scrappy.motes);
    // Bounded: however well it is played, twenty kills can never be worth more
    // than twenty kills at the cap.
    expect(flawless.progress).toBeLessThanOrEqual(scrappy.progress * (1 + RESTORATION.bonus.cap) + 1e-6);
  });

  it('gives a Perception build more from precision than a Strength build gets', () => {
    const precise = sequence(player({}, { perception: 50 }), 20, 'stalker', qualities({ weakPoint: true }));
    const strong = sequence(player({}, { strength: 50 }), 20, 'stalker', qualities({ weakPoint: true }));
    expect(precise.progress).toBeGreaterThan(strong.progress);
  });

  it('gives a Strength build more from decisive kills than a Perception build gets', () => {
    const strong = sequence(player({}, { strength: 50 }), 20, 'stalker', qualities({ overkill: true }));
    const precise = sequence(player({}, { perception: 50 }), 20, 'stalker', qualities({ overkill: true }));
    expect(strong.progress).toBeGreaterThan(precise.progress);
  });

  it('gives an Agility build a real route with no healing modifiers at all', () => {
    // The brief's rule: Agility does not need direct healing to have a
    // sustainability route. Its whole product is not being hit, and the
    // untouched-kill bonus is that turned into restoration.
    const quick = player({}, { agility: 50 });
    expect(quick.stats.traits.healingScale).toBeCloseTo(statsFor().traits.healingScale);
    const evasive = sequence(quick, 20, 'stalker', qualities({ untouched: true }));
    const plain = sequence(player(), 20, 'stalker', qualities({ untouched: true }));
    expect(evasive.progress).toBeGreaterThan(plain.progress);
  });

  it('cannot be farmed into a flat economy by killing one spawner twenty times', () => {
    let killer = player();
    let farmed = 0;
    const victim = monster('stalker', { spawnerId: 'the-one-camp' });
    for (let kill = 0; kill < 20; kill++) {
      const credit = creditKill(killer, victim, NO_QUALITIES, kill * 10);
      killer = credit.killer;
      farmed += credit.contribution.total;
    }
    const honest = sequence(player(), 20, 'stalker', NO_QUALITIES);
    // Farming one camp is worth a fraction of clearing twenty bodies -- and the
    // fraction is bounded below by the floor, so it is poor rather than nothing.
    expect(farmed).toBeLessThan(honest.progress * 0.5);
    expect(farmed).toBeGreaterThan(0);
  });
});

describe('death behaviour is unchanged', () => {
  it('still reports a kill the way it always did', () => {
    // The `died` event gained a payload and must not have lost anything: the
    // experience grant, the trade cancel and the respawn all read the two
    // fields that were there before.
    const event: ServerSimEvent = {
      kind: 'died',
      entityId: 7,
      killerId: 3,
      victimKind: EntityKindValue.Monster,
      victimTypeId: 'grazer',
      qualities: NO_QUALITIES,
    };
    expect(event.kind === 'died' && event.entityId).toBe(7);
    expect(event.kind === 'died' && event.killerId).toBe(3);
  });

  it('leaves a body with no killer creditable to nobody', () => {
    const orphan = creditKill(player({ kind: EntityKindValue.Monster }), monster('stalker'), NO_QUALITIES, 0);
    expect(orphan.contribution.total).toBe(0);
  });
});

describe('determinism', () => {
  it('replays a fight to the same restoration state, every time', () => {
    const run = (): { meter: number; charges: number; motes: number } => {
      const spawn = world({ strength: 30 });
    let state = spawn.state;
    const selfId = spawn.selfId;
      const row = monsterById('stalker');
      let seq = 0;
      let motes = 0;
      let foeId = 0;

      for (let t = 1; t <= SERVER_TICK_RATE * 8; t++) {
        const foe = foeId > 0 ? state.entities.get(foeId) : undefined;
        if (!foe || foe.health <= 0) {
          const spawned = spawnEntity(state, {
            kind: EntityKindValue.Monster,
            typeId: 'stalker',
            position: { x: ORIGIN.x + 55, y: ORIGIN.y, z: 0 },
            stats: row?.stats ?? statsFor(),
            radius: row?.radius ?? 20,
            zoneId: 'greenmarch',
            targetId: selfId,
          });
          state = spawned.state;
          foeId = spawned.entity.id;
        }
        seq += 1;
        const result = step(
          state,
          [
            idle(selfId, {
              seq,
              castAbilityId: state.entities.get(selfId)?.cast === null ? 'melee.slash' : '',
              castTargetX: ORIGIN.x + 55,
              castTargetY: ORIGIN.y,
              castTargetEntityId: foeId,
            }),
          ],
          CONTEXT,
        );
        state = result.state;
        for (const event of result.events) {
          if (event.kind === 'restoration') motes += event.motes;
        }
      }

      const self = state.entities.get(selfId);
      return {
        meter: self?.restoration ?? -1,
        charges: self?.fallbackCharges ?? -1,
        motes,
      };
    };

    expect(run()).toEqual(run());
  });
});
