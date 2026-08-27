/**
 * The ability system (spec 062), driven through the real `step`.
 *
 * Nothing here calls `startCast` or `advanceCast` directly: an ability is only
 * correct if it behaves correctly *in a tick*, alongside movement, monsters and
 * the spawner. Testing the pieces in isolation would pass while the wiring that
 * actually runs them was wrong.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { abilityById, ALL_ABILITIES, BASIC_ATTACK_ID, totalCastTicks } from '../data/abilities.js';
import { ALL_ITEMS, itemById } from '../data/items.js';
import { ALL_MONSTERS, monsterById } from '../data/monsters.js';
import { BASE_ATTACK_TIME_TICKS, computeEffectiveStats } from '../player/stats.js';
import { EMPTY_EQUIPMENT, emptyInventory, type EffectiveStats, type PersistedPlayer } from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import {
  CastEndReason,
  CastPhase,
  EntityKindValue,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { SHOT_IMPACT_HEIGHT, SHOT_LAUNCH_HEIGHT } from './ballistics.js';
import { COMMIT_ALIGN_TICKS, commitAlignEps, facesAim, TURN_ALIGN_EPS } from './abilities.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';
import { MAX_ATTACK_INTERVAL_SECONDS } from './attack-timing.js';

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  skills: [],
  // Sigils, because since spec 231 every ability that is not the weapon's own
  // swing is `skill: true` and `startCast` refuses one that is not in a slot.
  // The rows these tests used to reach for -- `melee.heavy`, `ground.quake`,
  // `bolt.seek` -- were spec 062's demo set: granted by nothing and castable by
  // anybody. `computeEffectiveStats` derives `skillAbilityIds` from here, which
  // is the same path a real player's stats take.
  equipment: {
    ...EMPTY_EQUIPMENT,
    skill1: 'sigil.acidSpray',
    skill2: 'sigil.blight',
    skill3: 'sigil.poisonDart',
    skill4: 'sigil.emberToss',
  },
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 600, y: 450, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  // Deliberately left at 1. The sigils above are set directly rather than moved
  // through `applyMove`, so nothing here enforces their `levelRequirement` --
  // and a higher level is not free: it buys attribute points, and Wisdom scales
  // an ability's cooldown, which several assertions below read as
  // `windupTicks + cooldownTicks` exactly.
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 100,
};

// Spell power scales ability damage, so a fixture with a known multiplier keeps
// the arithmetic in these tests readable.
const STATS: EffectiveStats = { ...computeEffectiveStats(RECORD), spellPower: 1, critChance: 0 };
const CHUNK = 100;

function activeAround(x: number, y: number): Set<string> {
  const keys = new Set<string>();
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) keys.add(chunkKeyOf(x + dx * CHUNK, y + dy * CHUNK, CHUNK));
  }
  return keys;
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    // The spawner off, so a test's population is exactly what it put there.
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: activeAround(600, 450),
    chunkSize: CHUNK,
    spawnPoints: [],
    ...overrides,
  };
}

function withPlayer(
  state: ServerWorldState,
  x: number,
  y: number,
  stats: EffectiveStats = STATS,
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

function withDummy(
  state: ServerWorldState,
  x: number,
  y: number,
): { state: ServerWorldState; id: number } {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  // A training dummy: it swings at nothing, so every hit in a test is the
  // player's and no retaliation interrupts what is being measured.
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x, y, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
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

/** Runs `ticks` ticks, feeding `frames[i]` on tick i, collecting every event. */
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

const hits = (events: readonly ServerSimEvent[]): Extract<ServerSimEvent, { kind: 'hit' }>[] =>
  events.filter((event): event is Extract<ServerSimEvent, { kind: 'hit' }> => event.kind === 'hit');

/**
 * The blows, without an affliction's beats.
 *
 * A pulse is a `hit` too and carries `periodic` to say so (specs 190, 219). It
 * did not used to matter here: the abilities these tests were written against
 * were spec 062's demo rows, and none of them applied anything. The skills that
 * replaced them do, so a test counting "how many times did this land" has to
 * say which kind of landing it means.
 */
const blows = (events: readonly ServerSimEvent[]): Extract<ServerSimEvent, { kind: 'hit' }>[] =>
  hits(events).filter((event) => event.periodic !== true);

describe('the ability table', () => {
  /**
   * **Every ability is reachable by somebody** (spec 231).
   *
   * The check that would have caught the thing that spec removed: nine of
   * twenty-five rows were castable by naming an id and by no other means, left
   * over from spec 062's demo set after spec 188 moved what a player casts onto
   * sigils. They were priced and tuned against a game that had moved twice, and
   * because two of them out-damaged every real skill they were what
   * `npm run balance` measured the twelve builds with.
   *
   * Three ways in, and they are the only three: an item grants it as an active
   * skill, an item or a monster names it as a basic attack, or it is one of the
   * two constants the game reaches for directly -- the fallback swing and the
   * flask. A row with none of them is a rule nothing can invoke.
   */
  it('is reachable, every row of it, by an item or a monster or a constant', () => {
    // The flask is identified by what it costs rather than by its id, because
    // the id lives in the renderer (`action-bar.ts`'s `VIAL_ABILITY_ID`) and a
    // second copy of it here is the drift this test exists to catch. A
    // `chargeCost` is a flask charge, and nothing else spends one.
    const granted = new Set<string>([
      BASIC_ATTACK_ID,
      ...ALL_ABILITIES.filter((ability) => ability.chargeCost !== undefined).map((a) => a.id),
    ]);
    for (const item of ALL_ITEMS) {
      if (item.activeSkillId) granted.add(item.activeSkillId);
      if (item.basicAttackId) granted.add(item.basicAttackId);
    }
    for (const monster of ALL_MONSTERS) {
      if (monster.stats.basicAttackId) granted.add(monster.stats.basicAttackId);
    }
    const orphans = ALL_ABILITIES.filter((ability) => !granted.has(ability.id)).map((a) => a.id);
    expect(orphans, 'abilities nothing grants').toEqual([]);
  });

  it('gives every ability the parts its kind needs', () => {
    for (const ability of ALL_ABILITIES) {
      expect(ability.windupTicks, ability.id).toBeGreaterThan(0);
      expect(ability.cooldownTicks, ability.id).toBeGreaterThan(0);
      if (ability.kind === 'projectile') expect(ability.projectile, ability.id).toBeDefined();
      if (ability.kind === 'ground') expect(ability.radius, ability.id).toBeGreaterThan(0);
      if (ability.kind === 'channel') {
        expect(ability.channelTicks, ability.id).toBeGreaterThan(0);
        expect(ability.pulseIntervalTicks, ability.id).toBeGreaterThan(0);
      }
      if (ability.kind === 'self') expect(ability.targeting).toBe('self');
    }
  });
});

/**
 * The shot the Emberwood Staff throws (spec 218).
 *
 * Every assertion here is an *ordering* rather than a number, because what the
 * spec was asked for is an ordering: a shot shorter than the bow's, on the
 * weapon that until now was the only main hand whose whole identity was
 * `spellPower` and which changed nothing whatsoever about attacking.
 *
 * Retuning any of the three rows moves all of these together, which is the
 * point -- a test that pinned 330 would fail the day somebody rebalanced the
 * bow and would say nothing about whether the relationship still held.
 */
describe('the ember shot (spec 218)', () => {
  const ember = abilityById('ranged.ember');
  const shot = abilityById('ranged.shot');
  const star = abilityById('ranged.star');

  it('is a basic attack thrown by a weapon', () => {
    expect(ember?.kind).toBe('projectile');
    expect(ember?.basicAttack).toBe(true);
    // Point-targeted, so a throw past the staff's reach is refused rather than
    // loosed at nothing -- the same gate both other weapon shots sit behind.
    expect(ember?.targeting).toBe('point');
  });

  it('reaches less far than the bow and further than the star', () => {
    expect(ember?.range ?? 0).toBeLessThan(shot?.range ?? 0);
    expect(ember?.range ?? 0).toBeGreaterThan(star?.range ?? 0);
  });

  it('flies slower than either weapon that already throws something', () => {
    // A ball of fire is the slowest thing anybody throws here, which is what
    // makes it a shot you can see coming -- spec 094's argument about wind-ups,
    // moved into the flight.
    const speed = ember?.projectile?.speed ?? Number.POSITIVE_INFINITY;
    expect(speed).toBeLessThan(shot?.projectile?.speed ?? 0);
    expect(speed).toBeLessThan(star?.projectile?.speed ?? 0);
  });

  it('leaves the cadence to the attack-speed stat', () => {
    // Wind-up plus backswing has to sit inside the Base Attack Time, or the
    // clip is what decides how often the staff throws rather than the stat
    // (spec 088). The bow sits at 69 of 72 and this at 60.
    expect(totalCastTicks(ember as NonNullable<typeof ember>)).toBeLessThan(BASE_ATTACK_TIME_TICKS);
  });

  it('commits for longer than a thrown star and less than a drawn bow', () => {
    expect(ember?.windupTicks ?? 0).toBeGreaterThan(star?.windupTicks ?? 0);
    expect(ember?.windupTicks ?? 0).toBeLessThan(shot?.windupTicks ?? 0);
  });

  it('leaves what it hits for to the weapon that throws it', () => {
    // Since spec 217 a basic attack's damage is the weapon's own range, so a
    // number here would be a number nothing reads -- the whole table carries a
    // zero for the same reason.
    expect(ember?.damage).toBe(0);
    expect(shot?.damage).toBe(0);
  });

  it('is thrown by a weapon that out-rolls the bow and not the melee rares', () => {
    // The ordering rather than the numbers, so a retune of any of the four
    // moves them together. `{1, 2}` was the staff's range before this spec and
    // was the weakest in the table, chosen when hitting somebody with the staff
    // was explicitly the fallback rather than the plan.
    const rangeOf = (id: string): { min: number; max: number } =>
      itemById(id)?.damage ?? { min: 0, max: 0 };
    const mean = (id: string): number => (rangeOf(id).min + rangeOf(id).max) / 2;
    expect(mean('staff.emberwood')).toBeGreaterThan(mean('bow.hunting'));
    expect(mean('staff.emberwood')).toBeLessThan(mean('sword.keen'));
    expect(mean('staff.emberwood')).toBeLessThan(mean('maul.iron'));
  });

  it('is single-target: the explosion is a picture and not an area', () => {
    // `ability.radius` is what puts a shot on `stepProjectiles`' burst branch.
    // Absent, so the burst it draws on landing damages exactly the body it hit.
    expect(ember?.radius).toBeUndefined();
  });
});

describe('wind-up', () => {
  it('deals no damage before the release tick, and lands exactly once on it', () => {
    const ability = abilityById('skill.acidSpray');
    if (!ability) throw new Error('no skill.acidSpray');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 660, 450).state;

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 660, castTargetY: 450 })],
    });
    expect(hits(commit.events)).toHaveLength(0);

    // Everything up to but not including the release must be silent.
    const during = run(commit.state, ability.windupTicks - 1);
    expect(hits(during.events)).toHaveLength(0);

    const release = run(during.state, 1);
    expect(hits(release.events)).toHaveLength(1);

    // And it does not land a second time once it is over.
    const after = run(release.state, 5);
    expect(hits(after.events)).toHaveLength(0);
  });

  it('roots a caster that asks for nothing', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const startX = state.entities.get(player.id)?.position.x ?? 0;

    const frames: Record<number, ServerInput[]> = {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    };
    // Standing still: nothing asked for, so nothing is withdrawn from either.
    for (let i = 1; i < 20; i++) frames[i] = [input(player.id, {})];

    const result = run(state, 20, frames);
    expect(result.state.entities.get(player.id)?.position.y).toBeCloseTo(450, 3);
    expect(result.state.entities.get(player.id)?.position.x).toBeCloseTo(startX, 3);
  });

  /**
   * Spec 079. Asking to move is the other way out of a commitment, and the one
   * that makes a feint possible: show the wind-up, read the answer, walk out of
   * it. The refund is the one `Esc` gives, so the only thing spent is the time.
   */
  it('withdraws from a wind-up when a move order arrives, and moves that tick', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const startY = state.entities.get(player.id)?.position.y ?? 0;
    const resource = state.entities.get(player.id)?.resource ?? 0;

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    });
    const committed = commit.state.entities.get(player.id);
    expect(committed?.cast).not.toBeNull();
    expect(committed?.resource).toBeLessThan(resource);
    // No cooldown yet: it is the price of the blow, not of the commitment
    // (spec 091).
    expect(committed?.cooldowns['skill.acidSpray']).toBeUndefined();

    const away = run(commit.state, 1, { 0: [input(player.id, { moveX: 0, moveY: 1 })] });
    const withdrawn = away.state.entities.get(player.id);
    expect(withdrawn?.cast).toBeNull();
    // Everything back but the time: cost refunded, no cooldown ever taken.
    expect(withdrawn?.resource).toBeCloseTo(resource, 3);
    expect(withdrawn?.cooldowns['skill.acidSpray']).toBeUndefined();
    // And the step away is the same tick, not the one after it.
    expect(withdrawn?.position.y).toBeGreaterThan(startY);
    expect(
      away.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);
    // Nothing landed: a withdrawn blow is a blow that never happened.
    expect(hits(away.events)).toHaveLength(0);
  });

  it('withdraws from the turn as readily as from the wind-up', () => {
    let state = createWorldState(1);
    // Spawned facing east and committing due west, so the cast is still turning
    // when the move order lands and `releaseTick` is still the provisional one.
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 300, castTargetY: 450 })],
    });
    expect(commit.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Turning);

    const away = run(commit.state, 1, { 0: [input(player.id, { moveX: 0, moveY: 1 })] });
    expect(away.state.entities.get(player.id)?.cast).toBeNull();
    expect(away.state.entities.get(player.id)?.cooldowns['skill.acidSpray']).toBeUndefined();
  });

  /**
   * Spec 092. One input can carry both a commit and a withdrawal -- `server.ts`
   * no longer builds one, but `mergeInputs` folds a batch of client frames into
   * a single frame and or-s `cancelCast` across it, and the bots and these tests
   * call `step` directly. The rule has to live in `step`, which is the lesson
   * spec 090 already paid for once.
   *
   * Two readings, and they do not cost the same: swallowing the cancel throws a
   * blow the player called off, which is the bug the report described.
   * Swallowing the commit costs a press.
   */
  it('lets a withdrawal outrank a commit that shares its tick, and answers both', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const both = run(state, 1, {
      0: [
        input(player.id, {
          castAbilityId: 'skill.acidSpray',
          castTargetX: 700,
          castTargetY: 450,
          cancelCast: true,
        }),
      ],
    });

    // Nothing began, so nothing can go off.
    expect(both.state.entities.get(player.id)?.cast ?? null).toBeNull();
    // And the request was refused rather than dropped in silence: the client
    // pairs the n-th reply with the n-th request (spec 080), so a request thrown
    // away without a word mis-attributes every answer after it.
    expect(
      both.events.filter((event) => event.kind === 'castRejected' && event.reason === 'withdrawn'),
    ).toHaveLength(1);
    // Nothing was charged for it either.
    expect(both.state.entities.get(player.id)?.cooldowns['skill.acidSpray']).toBeUndefined();
  });

  /**
   * Spec 094, and the same rule read through spec 079's other withdrawal.
   *
   * Asking to *move* is how a body calls a blow off; the movement pass settles
   * that before the cast pass runs, so on the tick a commit rides the same input
   * there is nothing on the body to withdraw from -- and the cast pass used to
   * put a fresh wind-up on a body that had asked, that very tick, to be
   * somewhere else. It looked harmless because the next input carrying a vector
   * called it off again; when none followed, the blow landed.
   *
   * Reachable from the shipped client with an ordinary gesture: `castNow` clears
   * the move order and the attack order before asking, but not the held keys, so
   * a hotbar press while walking is exactly this input.
   */
  it('lets a step outrank a commit that shares its tick, and answers it', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const before = state.entities.get(player.id)?.position.x ?? 0;

    const both = run(state, 1, {
      0: [
        input(player.id, {
          moveX: -1,
          moveY: 0,
          castAbilityId: 'skill.acidSpray',
          castTargetX: 700,
          castTargetY: 450,
        }),
      ],
    });

    // The step happened...
    expect(both.state.entities.get(player.id)?.position.x ?? 0).toBeLessThan(before);
    // ...and nothing was committed to, so there is nothing left to go off.
    expect(both.state.entities.get(player.id)?.cast ?? null).toBeNull();
    // Answered, not dropped, for spec 080's pairing.
    expect(
      both.events.filter((event) => event.kind === 'castRejected' && event.reason === 'withdrawn'),
    ).toHaveLength(1);
    // And charged for neither: a withdrawal costs the time it took, and this one
    // took none.
    expect(both.state.entities.get(player.id)?.cooldowns['skill.acidSpray']).toBeUndefined();
    expect(both.state.entities.get(player.id)?.resource ?? 0).toBe(STATS.maxResource);
  });

  /**
   * The other half of it, and the reason this is an ordering rule rather than
   * "movement always wins": an input that asks for nothing but the blow commits
   * to it exactly as it always did.
   */
  it('starts a commit that shares its tick with no step at all', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const commit = run(state, 1, {
      0: [
        input(player.id, {
          moveX: 0,
          moveY: 0,
          castAbilityId: 'skill.acidSpray',
          castTargetX: 700,
          castTargetY: 450,
        }),
      ],
    });

    expect(commit.state.entities.get(player.id)?.cast).not.toBeNull();
    expect(
      commit.events.filter((event) => event.kind === 'castRejected'),
    ).toHaveLength(0);
  });

  it('answers a commit that shares its tick with a cancel for a cast in progress', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    });
    expect(commit.state.entities.get(player.id)?.cast).not.toBeNull();

    const both = run(commit.state, 1, {
      0: [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 700,
          castTargetY: 450,
          cancelCast: true,
        }),
      ],
    });

    // The withdrawal lands, as it always did...
    expect(both.state.entities.get(player.id)?.cast ?? null).toBeNull();
    expect(
      both.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);
    // ...and the second press is answered, which it was not: it used to be
    // dropped between the cancel and the commit with no event of any kind.
    expect(
      both.events.filter((event) => event.kind === 'castRejected' && event.reason === 'withdrawn'),
    ).toHaveLength(1);
  });

  it('cancels only the backswing once the blow has landed (spec 144)', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
    });
    const releaseTick = commit.state.entities.get(player.id)?.cast?.releaseTick ?? 0;

    let during = commit;
    while (during.state.tick < releaseTick) during = run(during.state, 1);
    // The blow has committed: slash has a follow-through, so the cast is now in
    // its backswing rather than over, and the interval has been stamped.
    const committed = during.state.entities.get(player.id);
    expect(committed?.cast?.committed).toBe(true);
    expect(committed?.cast?.phase).toBe(CastPhase.Backswing);
    const stamped = committed?.cooldowns['melee.slash'] ?? 0;
    expect(stamped).toBeGreaterThan(0);

    // Walking now skips the rest of the animation and nothing else. It is
    // reported as its own kind of ending, so a client cannot mistake it for the
    // withdrawal that refunds -- and the interval stamped at the attack point
    // is untouched, to the tick.
    const after = run(during.state, 1, { 0: [input(player.id, { moveX: 0, moveY: 1 })] });
    expect(after.state.entities.get(player.id)?.cast).toBeNull();
    expect(after.state.entities.get(player.id)?.cooldowns['melee.slash']).toBe(stamped);
    expect(
      after.events.some(
        (event) =>
          event.kind === 'castEnded' && event.reason === CastEndReason.BackswingCancelled,
      ),
    ).toBe(true);
    // And emphatically *not* the reason that means the attack never happened.
    expect(
      after.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(false);
  });

  it('captures aim at commit, so turning mid-cast cannot re-point the blow', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Behind the caster relative to the committed aim.
    state = withDummy(state, 540, 450).state;

    const frames: Record<number, ServerInput[]> = {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
    };
    for (let i = 1; i < 30; i++) frames[i] = [input(player.id, { facing: Math.PI })];

    // Aim was +x at commit; spinning to face the dummy afterwards changes nothing.
    expect(hits(run(state, 30, frames).events)).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('refunds the cost and the cooldown, and lands nothing', () => {
    const ability = abilityById('skill.blight');
    if (!ability) throw new Error('no skill.blight');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 640, 450).state;
    const beforeResource = state.entities.get(player.id)?.resource ?? 0;

    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 640, castTargetY: 450 })],
    });
    expect(started.state.entities.get(player.id)?.resource).toBeCloseTo(
      beforeResource - ability.cost,
      6,
    );

    const cancelled = run(started.state, 1, { 0: [input(player.id, { cancelCast: true })] });
    const caster = cancelled.state.entities.get(player.id);
    expect(caster?.cast).toBeNull();
    // At least what was spent is back; regen has also ticked on top of it.
    expect(caster?.resource ?? 0).toBeGreaterThanOrEqual(beforeResource);
    expect(caster?.resource ?? 0).toBeLessThanOrEqual(STATS.maxResource);
    expect(caster?.cooldowns['skill.blight']).toBeUndefined();
    expect(
      cancelled.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);

    // Nothing ever landed.
    expect(hits(run(cancelled.state, 60).events)).toHaveLength(0);
  });

  it('is immediately castable again, because the cooldown never started', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 640, castTargetY: 450 })],
    });
    const cancelled = run(started.state, 1, { 0: [input(player.id, { cancelCast: true })] });
    const again = run(cancelled.state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 640, castTargetY: 450 })],
    });
    expect(again.state.entities.get(player.id)?.cast?.abilityId).toBe('skill.blight');
  });

  it('cannot call back a cast that has already released', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 640, 450).state;

    // Run right through the release, then try to cancel the recovery.
    const released = run(state, ability.windupTicks + 1, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 640, castTargetY: 450 })],
    });
    expect(hits(released.events)).toHaveLength(1);

    const late = run(released.state, 1, { 0: [input(player.id, { cancelCast: true })] });
    expect(
      late.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(false);
  });
});

describe('cost and cooldown gate use', () => {
  it('refuses a second cast while the first is winding up', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const first = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    });
    const second = run(first.state, 1, {
      0: [input(player.id, { castAbilityId: 'ranged.star', castTargetX: 700, castTargetY: 450 })],
    });
    expect(
      second.events.some(
        (event) => event.kind === 'castRejected' && event.reason === 'alreadyCasting',
      ),
    ).toBe(true);
    expect(second.state.entities.get(player.id)?.cast?.abilityId).toBe('skill.acidSpray');
  });

  it('refuses one that is on cooldown', () => {
    const ability = abilityById('skill.acidSpray');
    if (!ability) throw new Error('no skill.acidSpray');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const cast = run(state, totalCastTicks(ability) + 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    });
    const again = run(cast.state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    });
    expect(
      again.events.some((event) => event.kind === 'castRejected' && event.reason === 'onCooldown'),
    ).toBe(true);
  });

  it('refuses one it cannot pay for, and changes nothing', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450, { ...STATS, maxResource: 1, resourceRegen: 0 });
    state = player.state;

    const result = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 640, castTargetY: 450 })],
    });
    expect(
      result.events.some(
        (event) => event.kind === 'castRejected' && event.reason === 'notEnoughResource',
      ),
    ).toBe(true);
    expect(result.state.entities.get(player.id)?.cast).toBeNull();
    expect(result.state.entities.get(player.id)?.resource).toBeLessThanOrEqual(1);
  });

  it('refuses a point-targeted cast beyond its range', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const result = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 6000, castTargetY: 450 })],
    });
    expect(
      result.events.some((event) => event.kind === 'castRejected' && event.reason === 'outOfRange'),
    ).toBe(true);
  });

  it('refuses an ability that is not in the table', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const result = run(state, 1, { 0: [input(player.id, { castAbilityId: 'nope.nope' })] });
    expect(
      result.events.some(
        (event) => event.kind === 'castRejected' && event.reason === 'unknownAbility',
      ),
    ).toBe(true);
  });
});

describe('projectiles', () => {
  it('flies, and damages what it reaches rather than what it was aimed past', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const near = withDummy(state, 800, 450);
    state = near.state;

    const result = run(state, SERVER_TICK_RATE * 2, {
      0: [input(player.id, { castAbilityId: 'ranged.shot', castTargetX: 1000, castTargetY: 450 })],
    });

    const landed = hits(result.events);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.targetId).toBe(near.id);
    // And it is gone once it has connected.
    expect(
      [...result.state.entities.values()].some(
        (entity) => entity.kind === EntityKindValue.Projectile,
      ),
    ).toBe(false);
  });

  it('exists as a replicable entity while it is in the air', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const ability = abilityById('skill.emberToss');
    if (!ability) throw new Error('no skill.emberToss');
    const inFlight = run(state, ability.windupTicks + 3, {
      0: [input(player.id, { castAbilityId: 'skill.emberToss', castTargetX: 950, castTargetY: 450 })],
    });

    const projectiles = [...inFlight.state.entities.values()].filter(
      (entity) => entity.kind === EntityKindValue.Projectile,
    );
    expect(projectiles).toHaveLength(1);
    expect(projectiles[0]?.typeId).toBe('skill.emberToss');
    // A lobbed shot is genuinely off the ground, which is what the client draws.
    expect(projectiles[0]?.position.z).toBeGreaterThan(0);
  });

  it('bursts where it lands, catching everything in the radius', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Three bodies clustered at the landing point.
    const a = withDummy(state, 900, 450);
    state = a.state;
    const b = withDummy(state, 930, 470);
    state = b.state;
    const c = withDummy(state, 880, 420);
    state = c.state;

    const result = run(state, SERVER_TICK_RATE * 4, {
      0: [input(player.id, { castAbilityId: 'skill.emberToss', castTargetX: 900, castTargetY: 450 })],
    });
    const struck = new Set(hits(result.events).map((hit) => hit.targetId));
    expect(struck).toEqual(new Set([a.id, b.id, c.id]));
  });

  it('expires instead of flying forever when it hits nothing', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const result = run(state, SERVER_TICK_RATE * 5, {
      0: [input(player.id, { castAbilityId: 'ranged.star', castTargetX: 880, castTargetY: 450 })],
    });
    expect(
      [...result.state.entities.values()].some(
        (entity) => entity.kind === EntityKindValue.Projectile,
      ),
    ).toBe(false);
    expect(hits(result.events)).toHaveLength(0);
  });

  it('draws a flat bolt flat and a lobbed pot in an arc', () => {
    // The arc is a pure function of progress, which is what lets the client
    // interpolate between 20Hz deltas and land on the same curve.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const flat = abilityById('ranged.star');
    const lob = abilityById('skill.emberToss');
    if (!flat || !lob) throw new Error('missing projectiles');

    /** Every height this ability's shot passes through, over flat ground. */
    function heights(abilityId: string, ticks: number, aimX: number): number[] {
      const seen: number[] = [];
      let current = state;
      for (let tick = 0; tick < ticks; tick++) {
        const result = step(
          current,
          tick === 0
            ? [input(player.id, { castAbilityId: abilityId, castTargetX: aimX, castTargetY: 450 })]
            : [],
          context({ activeChunks: activeAround(850, 450) }),
        );
        current = result.state;
        for (const entity of current.entities.values()) {
          if (entity.projectile) seen.push(entity.position.z);
        }
      }
      return seen;
    }

    // Flat is level between the hand it left and the height it lands at
    // (spec 089) -- not zero, and above all not the ground it is crossing.
    // Each aimed as far as its own row reaches: the arc's height is a function
// of the throw, so a lob aimed inside the flat shot's shorter range would
// not clear the bar below.
    const level = heights('ranged.star', flat.windupTicks + 30, 600 + flat.range);
    expect(level.length).toBeGreaterThan(4);
    for (const z of level) {
      expect(z).toBeLessThanOrEqual(SHOT_LAUNCH_HEIGHT + 1e-6);
      expect(z).toBeGreaterThanOrEqual(SHOT_IMPACT_HEIGHT - 1e-6);
    }
    // And it only ever descends along that chord: no hump anywhere in it.
    for (let i = 1; i < level.length; i++) {
      expect(level[i]).toBeLessThanOrEqual((level[i - 1] as number) + 1e-6);
    }

    // The lob genuinely rises above where it left, which is the difference.
    const arced = heights('skill.emberToss', lob.windupTicks + 30, 600 + lob.range);
    expect(Math.max(...arced)).toBeGreaterThan(SHOT_LAUNCH_HEIGHT + 20);
  });
});

/**
 * `kind: 'channel'` has no shipped row since spec 231, so the sim's channel path
 * has nothing to point at and the test that used to live here -- a cast that
 * pulses while held and stops when cancelled -- cannot be written.
 *
 * `channel.drain` was spec 062's one row of that kind, granted by nothing and
 * castable by anybody, and it went with the rest of that demo set. The
 * mechanism is still live in `abilities.ts` (`endTickFor`, `CastPhase.Channel`,
 * `nextPulseTick`), still on the wire as `CastPhaseValue.Channel`, and still
 * described by `data/description.ts` -- which `data/description.test.ts` covers
 * against a row it constructs. What is gone is any way to drive it through a
 * real tick.
 *
 * Restoring it needs a channel authored behind a sigil; the test to bring back
 * is a cast held past its release whose pulses land on `pulseIntervalTicks` and
 * stop on a `cancelCast`.
 */

describe('self abilities', () => {
  it('heals the caster without exceeding their ceiling', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Hurt them first, so the heal has room to work.
    const hurt = new Map(state.entities);
    const before = hurt.get(player.id);
    if (!before) throw new Error('no player');
    hurt.set(player.id, { ...before, health: 20 });
    state = { ...state, entities: hurt };

    const ability = abilityById('self.hearthdraught');
    if (!ability) throw new Error('no self.hearthdraught');
    const result = run(state, ability.windupTicks + 2, {
      0: [input(player.id, { castAbilityId: 'self.hearthdraught' })],
    });

    const healed = result.state.entities.get(player.id);
    expect(healed?.health).toBeGreaterThan(20);
    expect(healed?.health).toBeLessThanOrEqual(STATS.maxHealth);
    expect(result.events.some((event) => event.kind === 'effect')).toBe(true);
    // And says so, as a hit against itself with the sign flipped (spec 157).
    const reported = result.events.find((event) => event.kind === 'hit');
    expect(reported?.kind === 'hit' && reported.damage).toBeLessThan(0);
  });

  it('reports nothing at all when there was no room for the heal (spec 219)', () => {
    // A flask drunk at full health. `applyHealing` hands the caster back
    // untouched, so the difference is zero -- and an unguarded report sends
    // `-0`, which `effectsForBlow` tests with `damage < 0` and therefore reads
    // as a *blow*: a brush hit painted on the drinker and a `0` floating off
    // them. `collectMote` has always guarded this; this never did.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const full = state.entities.get(player.id);
    if (!full) throw new Error('no player');
    expect(full.health).toBe(full.stats.maxHealth);

    const ability = abilityById('self.hearthdraught');
    if (!ability) throw new Error('no self.hearthdraught');
    const result = run(state, ability.windupTicks + 2, {
      0: [input(player.id, { castAbilityId: 'self.hearthdraught' })],
    });

    // The cast happened -- the ability's own effect went out, so this is a heal
    // that landed and restored nothing rather than a cast that never resolved.
    expect(result.events.some((event) => event.kind === 'effect')).toBe(true);
    expect(result.events.filter((event) => event.kind === 'hit')).toEqual([]);
  });
});

/**
 * Spec 065. Turning is rate-limited (spec 064), and until now a cast ignored
 * that: commit facing north and the blow resolved south on schedule, from a body
 * still halfway round.
 */
describe('turning before the wind-up', () => {
  /**
   * A body committed to `abilityId` while facing the other way.
   *
   * `turnRate` is an override rather than a constant because one test below
   * needs a turn that outlasts the wind-up, and how long a wind-up is moves
   * (spec 094): a body that turns at its ordinary 690 deg/s comes round in 16
   * ticks, so pinning "still turning after the release tick has passed" against
   * the table's numbers is pinning it against a coincidence.
   */
  function committedFacingAway(
    abilityId: string,
    turnRate?: number,
  ): {
    state: ReturnType<typeof createWorldState>;
    playerId: number;
  } {
    let state = createWorldState(1);
    const player = withPlayer(
      state,
      600,
      450,
      turnRate === undefined ? STATS : { ...STATS, turnRate },
    );
    state = player.state;
    state = withDummy(state, 640, 450).state;
    // Face due west, and swing due east: a half turn before anything happens.
    const facing = state.entities.get(player.id);
    if (facing) {
      const entities = state.entities as Map<number, typeof facing>;
      entities.set(player.id, { ...facing, facing: Math.PI });
    }
    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: abilityId, castTargetX: 640, castTargetY: 450 })],
    });
    return { state: started.state, playerId: player.id };
  }

  it('holds a cast in Turning until the body has come round', () => {
    const { state, playerId } = committedFacingAway('melee.slash');
    expect(state.entities.get(playerId)?.cast?.phase).toBe(CastPhase.Turning);

    // Still turning a few ticks later, and nothing has landed.
    const soon = run(state, 5);
    expect(soon.state.entities.get(playerId)?.cast?.phase).toBe(CastPhase.Turning);
    expect(hits(soon.events)).toHaveLength(0);
  });

  it('starts the wind-up when it arrives, and lands a full wind-up later', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const { state, playerId } = committedFacingAway('melee.slash');
    const turnRate = state.entities.get(playerId)?.stats.turnRate ?? 0;
    expect(turnRate).toBeGreaterThan(0);

    // A half turn, then the ability's own wind-up -- not a tick less.
    const turnTicks = Math.ceil((180 / turnRate) * SERVER_TICK_RATE);
    const beforeRelease = run(state, turnTicks + ability.windupTicks - 2);
    expect(hits(beforeRelease.events)).toHaveLength(0);

    const landed = run(beforeRelease.state, 3);
    expect(hits(landed.events).length).toBeGreaterThan(0);
  });

  it('never enters Turning when the body is already facing the aim', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 640, 450).state;

    // withPlayer faces east by default, and the aim is due east.
    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 640, castTargetY: 450 })],
    });
    expect(started.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Windup);
  });

  it('re-stamps the release tick, so the client is never told a stale one', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const { state, playerId } = committedFacingAway('melee.slash');
    const provisional = state.entities.get(playerId)?.cast?.releaseTick ?? 0;

    // Run until the wind-up actually begins.
    let current = state;
    let phase: number = CastPhase.Turning;
    for (let i = 0; i < 200 && phase === CastPhase.Turning; i++) {
      const next = run(current, 1);
      current = next.state;
      phase = current.entities.get(playerId)?.cast?.phase ?? CastPhase.Windup;
    }

    const actual = current.entities.get(playerId)?.cast?.releaseTick ?? 0;
    expect(phase).toBe(CastPhase.Windup);
    // The turn took longer than the wind-up, so the provisional tick is long past.
    expect(actual).toBeGreaterThan(provisional);
  });

  /**
   * The turn is part of the commitment, so calling off during it must cost
   * exactly nothing -- the same deal the wind-up offers.
   */
  it('refunds in full when cancelled mid-turn', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const before = state.entities.get(player.id)?.resource ?? 0;

    const facing = state.entities.get(player.id);
    if (facing) {
      const entities = state.entities as Map<number, typeof facing>;
      entities.set(player.id, { ...facing, facing: Math.PI });
    }

    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 640, castTargetY: 450 })],
    });
    expect(started.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Turning);

    const turning = run(started.state, 4);
    const cancelled = run(turning.state, 1, { 0: [input(player.id, { cancelCast: true })] });

    const caster = cancelled.state.entities.get(player.id);
    expect(caster?.cast).toBeNull();
    expect(caster?.resource ?? 0).toBeGreaterThanOrEqual(before);
    expect(caster?.cooldowns['skill.acidSpray']).toBeUndefined();
  });

  /**
   * The provisional release tick can be *behind* the current tick by the time a
   * slow body finishes turning. Cancelling then must still work -- comparing
   * against it would report a cast that has not begun as already released.
   */
  it('is still cancellable after turning for longer than the wind-up', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    // Slow enough that the half turn outlasts the wind-up whatever the table
    // says it is: 180 degrees at 60 deg/s is three seconds.
    const { state, playerId } = committedFacingAway('melee.slash', 60);

    const wellPast = run(state, ability.windupTicks + 2);
    expect(wellPast.state.entities.get(playerId)?.cast?.phase).toBe(CastPhase.Turning);

    const cancelled = run(wellPast.state, 1, { 0: [input(playerId, { cancelCast: true })] });
    expect(cancelled.state.entities.get(playerId)?.cast).toBeNull();
    expect(
      cancelled.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);
  });
});

describe('a hit does not interrupt a cast (spec 068)', () => {
  it('leaves the wind-up running, and the blow lands on the tick it would have', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // A stalker close enough to start swinging immediately, and already facing
    // its target -- since spec 065 a body turns before it swings, and a monster
    // spawned looking the other way would spend most of this test rotating.
    // That is the turn phase's own test; this one is about interruption.
    const definition = monsterById('stalker');
    if (!definition) throw new Error('no stalker');
    const monster = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: { x: 640, y: 450, z: 0 },
      facing: Math.PI,
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      // Already fighting us: nothing initiates since spec 076.
      targetId: player.id,
    });
    state = monster.state;

    const spell = abilityById('skill.blight');
    if (!spell) throw new Error('no skill.blight');

    // Tick to the last tick of the wind-up, watching for the stalker's blow.
    let current: Run = { state, events: [] };
    let struckWhileWindingUp = false;
    for (let i = 0; i < spell.windupTicks; i++) {
      current = run(current.state, 1, i === 0
        ? { 0: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 640, castTargetY: 450 })] }
        : {});
      if (hits(current.events).some((hit) => hit.targetId === player.id)) {
        struckWhileWindingUp = true;
        // The blow it committed to is still coming: neither the turn nor the
        // wind-up was thrown away by being hit.
        expect(current.state.entities.get(player.id)?.cast).not.toBeNull();
      }
    }
    expect(struckWhileWindingUp, 'the stalker never landed a blow to test with').toBe(true);

    // And it releases, on its own terms, into the monster that was hitting it.
    const release = run(current.state, 1);
    expect(hits(release.events).some((hit) => hit.targetId === monster.entity.id)).toBe(true);
    expect(
      release.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
      ),
    ).toBe(true);
  });

  it('says what died, on an event that outlives the body (spec 164)', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withDummy(state, 640, 450);
    state = dummy.state;
    // One blow's worth of health, so the first slash finishes it -- and one
    // blow's worth of *max* health with it, or the body is a 100000-health
    // dummy that has never been hit, which since spec 213 recovers 417 a tick
    // and is back over twelve thousand before the wind-up lands. A real body at
    // 1 health got there by being struck, which holds `InCombat` open and stops
    // recovery for eight seconds; nothing had struck this one.
    const body = state.entities.get(dummy.id);
    if (!body) throw new Error('no dummy');
    state = replaceEntity(state, {
      ...body,
      health: 1,
      stats: { ...body.stats, maxHealth: 1 },
    });

    const result = run(state, SERVER_TICK_RATE * 2, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 640, castTargetY: 450 })],
    });

    const died = result.events.find((event) => event.kind === 'died');
    expect(died?.kind === 'died' && died.entityId).toBe(dummy.id);
    expect(died?.kind === 'died' && died.victimKind).toBe(EntityKindValue.Monster);
    expect(died?.kind === 'died' && died.victimTypeId).toBe('dummy');
    // The reason those two fields exist: the same step that emitted the event
    // swept the body, so every reader downstream of it resolves the id to
    // nothing. That is what left the experience award unreachable since 062.
    expect(result.state.entities.get(dummy.id)).toBeUndefined();
  });

  it('still drops the cast when the hit is a killing one, and says so', () => {
    let state = createWorldState(1);
    // A caster frail enough that the stalker's first blow finishes it; it spawns
    // on full health, so its maximum is all it has. Two rather than six since
    // spec 217 -- a stalker hits for what its row authors now, which is three.
    const player = withPlayer(state, 600, 450, { ...STATS, maxHealth: 2, armor: 0 });
    state = player.state;

    const definition = monsterById('stalker');
    if (!definition) throw new Error('no stalker');
    const monster = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: { x: 640, y: 450, z: 0 },
      facing: Math.PI,
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      // Already fighting us: nothing initiates since spec 076.
      targetId: player.id,
    });
    state = monster.state;

    const result = run(state, SERVER_TICK_RATE * 3, {
      0: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 640, castTargetY: 450 })],
    });
    expect(result.events.some((event) => event.kind === 'died')).toBe(true);
    expect(result.state.entities.get(player.id)?.cast ?? null).toBeNull();
    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Interrupted,
      ),
    ).toBe(true);
  });
});

/**
 * Spec 080. The client pairs the n-th reply with the n-th request, so a request
 * the server drops on the floor skews that pairing for every answer after it --
 * and the movement pass drops a dead body before the cast pass ever sees it.
 */
describe('every request is answered, even one nobody can act on', () => {
  it('refuses a cast asked for at zero health rather than swallowing it', () => {
    let state = createWorldState(3);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const corpse = state.entities.get(player.id);
    if (!corpse) throw new Error('no player');
    state = replaceEntity(state, { ...corpse, health: 0 });

    const result = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
    });

    expect(
      result.events.filter(
        (event) => event.kind === 'castRejected' && event.entityId === player.id,
      ),
    ).toEqual([
      { kind: 'castRejected', entityId: player.id, abilityId: 'melee.slash', reason: 'dead' },
    ]);
    // Refused, not begun: a corpse still does not swing.
    expect(result.events.some((event) => event.kind === 'castStarted')).toBe(false);
    expect(result.state.entities.get(player.id)?.cast ?? null).toBeNull();
  });

  it('says nothing at all when a dead body sends no request', () => {
    let state = createWorldState(3);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const corpse = state.entities.get(player.id);
    if (!corpse) throw new Error('no player');
    state = replaceEntity(state, { ...corpse, health: 0 });

    const result = run(state, 5, { 0: [input(player.id, { moveX: 1 })] });
    expect(result.events.some((event) => event.kind === 'castRejected')).toBe(false);
  });
});

describe('determinism holds with abilities in play', () => {
  function scripted(): ServerWorldState {
    let state = createWorldState(42);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 780, 450).state;

    const frames: Record<number, ServerInput[]> = {
      0: [input(player.id, { castAbilityId: 'ranged.star', castTargetX: 900, castTargetY: 450 })],
      40: [input(player.id, { castAbilityId: 'skill.emberToss', castTargetX: 800, castTargetY: 460 })],
      // Was `channel.drain` until spec 231; a refused cast is a poor frame for a
      // determinism replay, since it exercises no path the others do not.
      90: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 800, castTargetY: 450 })],
      140: [input(player.id, { cancelCast: true })],
      160: [input(player.id, { castAbilityId: 'skill.blight', castTargetX: 780, castTargetY: 450 })],
    };
    return run(state, 260, frames).state;
  }

  it('replays casts and projectiles to bit-identical state', () => {
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

describe('cast phases reach the client', () => {
  it('reports every phase it passes through, and ends once', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const result = run(state, totalCastTicks(ability) + 2, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
    });

    const phases = result.events
      .filter((event) => event.kind === 'castStarted')
      .map((event) => (event.kind === 'castStarted' ? event.phase : -1));
    // Committed facing the aim, so no turn. The backswing is announced as a
    // phase of its own (spec 144), which is the "this attack has committed"
    // notice: the client's bar has to stop saying "you may still withdraw".
    expect(phases).toEqual([CastPhase.Windup, CastPhase.Backswing]);

    const ended = result.events.filter(
      (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
    );
    expect(ended).toHaveLength(1);
  });

  /**
   * Spec 068. The cast used to go on rooting the caster through a recovery phase
   * after the blow had landed; now the release *is* the end, so the body is free
   * on the next tick and the bar is gone.
   */
  it('ends on the release tick, and the caster walks the tick after', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const startY = state.entities.get(player.id)?.position.y ?? 0;

    const ability = abilityById('skill.acidSpray');
    if (!ability) throw new Error('no skill.acidSpray');

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    });
    const releaseTick = commit.state.entities.get(player.id)?.cast?.releaseTick ?? 0;
    expect(releaseTick).toBeGreaterThan(commit.state.tick);

    // Nothing asked for while it winds up. Walking would withdraw from it now
    // (spec 079), which is a different test; what is being measured here is
    // where the cast *ends*.
    const walk: Record<number, ServerInput[]> = { 0: [input(player.id, { moveX: 0, moveY: 1 })] };

    // Up to the tick before the release: still winding up, still rooted, and
    // nothing has ended.
    let during = commit;
    while (during.state.tick < releaseTick - 1) during = run(during.state, 1);
    expect(during.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Windup);
    expect(during.state.entities.get(player.id)?.position.y).toBeCloseTo(startY, 3);
    expect(during.events.some((event) => event.kind === 'castEnded')).toBe(false);

    // The release tick: the blow lands and the cast is over in the same breath.
    const release = run(during.state, 1);
    expect(release.state.entities.get(player.id)?.cast).toBeNull();
    expect(
      release.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
      ),
    ).toBe(true);

    // And the very next tick the body moves again -- no recovery to sit through.
    const after = run(release.state, 1, walk);
    expect(after.state.entities.get(player.id)?.position.y).toBeGreaterThan(startY);
  });

  // The channel walk that used to sit here is gone with `channel.drain` (spec
  // 231): no shipped row is `kind: 'channel'`, so there is nothing to drive
  // through `CastPhase.Channel` in a real tick. The phase is still on the wire
  // and `world/cast.test.ts` still drives `castBar` through it, because that
  // one reads the phase off the cast rather than the ability's kind.
});

describe('a named target (spec 070)', () => {
  const slash = abilityById('melee.slash');
  if (!slash) throw new Error('no melee.slash');

  /** A player and two dummies standing side by side, both well inside the arc. */
  function twoInTheArc(): {
    state: ServerWorldState;
    player: number;
    named: number;
    bystander: number;
  } {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Both due east, a few units apart: whatever cone slash would sweep, it
    // sweeps over the pair of them.
    const named = withDummy(state, 640, 445);
    state = named.state;
    const bystander = withDummy(state, 640, 455);
    return {
      state: bystander.state,
      player: player.id,
      named: named.id,
      bystander: bystander.id,
    };
  }

  it('damages the body it names and nobody standing beside it', () => {
    const field = twoInTheArc();
    // Long enough to turn onto an aim a few degrees off the current heading and
    // then wind up: the turn comes first, and its length is the body's own.
    const result = run(field.state, slash.windupTicks + 12, {
      0: [
        input(field.player, {
          castAbilityId: 'melee.slash',
          castTargetX: 640,
          castTargetY: 445,
          castTargetEntityId: field.named,
        }),
      ],
    });

    const struck = hits(result.events);
    expect(struck).toHaveLength(1);
    expect(struck[0]?.targetId).toBe(field.named);
    expect(result.state.entities.get(field.bystander)?.health).toBe(
      monsterById('dummy')?.stats.maxHealth,
    );
  });

  it('still sweeps the cone when no target is named, which is what the hotbar uses', () => {
    const field = twoInTheArc();
    const result = run(field.state, slash.windupTicks + 12, {
      0: [
        input(field.player, {
          castAbilityId: 'melee.slash',
          castTargetX: 700,
          castTargetY: 450,
        }),
      ],
    });
    expect(new Set(hits(result.events).map((hit) => hit.targetId))).toEqual(
      new Set([field.named, field.bystander]),
    );
  });

  it('misses a target that is out of reach at the release, rather than reaching it', () => {
    let state = createWorldState(5);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Named from well outside slash's reach: the commit is legal (a direction
    // ability may always be started) and the blow simply finds nothing.
    const far = withDummy(state, 600 + slash.range * 3, 450);
    state = far.state;

    const result = run(state, slash.windupTicks + 12, {
      0: [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 600 + slash.range * 3,
          castTargetY: 450,
          castTargetEntityId: far.id,
        }),
      ],
    });

    expect(hits(result.events)).toHaveLength(0);
    expect(result.events.some((event) => event.kind === 'attackMissed')).toBe(true);
    expect(result.state.entities.get(far.id)?.health).toBe(monsterById('dummy')?.stats.maxHealth);
  });

  /**
   * Spec 080, narrowing 079. The withdrawal for a dead target ends where the
   * commitment begins: while the caster is still *turning* there is nothing to
   * un-commit and it is called off, and past that the blow completes and finds
   * what it finds.
   */
  it('calls the cast off when its target dies while it is still turning', () => {
    const heavy = abilityById('skill.acidSpray');
    if (!heavy) throw new Error('no skill.acidSpray');

    let state = createWorldState(8);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Due south, so a body facing east spends ticks coming round to it and the
    // cast is still in its turn when the victim goes down.
    const victim = withDummy(state, 600, 510);
    state = victim.state;
    const resource = state.entities.get(player.id)?.resource ?? 0;

    const committed = run(state, 1, {
      0: [
        input(player.id, {
          castAbilityId: 'skill.acidSpray',
          castTargetX: 600,
          castTargetY: 510,
          castTargetEntityId: victim.id,
        }),
      ],
    });
    expect(committed.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Turning);

    const corpse = committed.state.entities.get(victim.id);
    if (!corpse) throw new Error('no victim');
    const dead = replaceEntity(committed.state, { ...corpse, health: 0 });

    const result = run(dead, heavy.windupTicks + 2);
    const caster = result.state.entities.get(player.id);
    expect(caster?.cast).toBeNull();
    expect(hits(result.events)).toHaveLength(0);
    // Called off, not swung and missed.
    expect(result.events.some((event) => event.kind === 'attackMissed')).toBe(false);
    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);
    expect(caster?.resource).toBeCloseTo(resource, 3);
    expect(caster?.cooldowns['skill.acidSpray']).toBeUndefined();
  });

  /**
   * Spec 080's headline. 079 ran the withdrawal all the way to the release,
   * which put a one-tick cliff in the middle of every ranged auto-attack: a
   * shot's damage lands when the shot *arrives*, about a wind-up after the
   * loose, so the previous arrow killed the target exactly while the next
   * wind-up ran and deleted it -- once per kill, three-quarters along the bar.
   */
  it('sees a wind-up out when its target dies, and lands it as a miss', () => {
    const heavy = abilityById('skill.acidSpray');
    if (!heavy) throw new Error('no skill.acidSpray');

    let state = createWorldState(8);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const victim = withDummy(state, 660, 450);
    state = victim.state;

    // Committed and already winding up -- due east, so there is no turn.
    const committed = run(state, 2, {
      0: [
        input(player.id, {
          castAbilityId: 'skill.acidSpray',
          castTargetX: 660,
          castTargetY: 450,
          castTargetEntityId: victim.id,
        }),
      ],
    });
    expect(committed.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Windup);

    const corpse = committed.state.entities.get(victim.id);
    if (!corpse) throw new Error('no victim');
    const dead = replaceEntity(committed.state, { ...corpse, health: 0 });

    const result = run(dead, heavy.windupTicks + 2);
    const caster = result.state.entities.get(player.id);
    expect(caster?.cast).toBeNull();
    // Swung and missed, not called off. Nothing was hit either way -- the
    // difference is that the wind-up the player watched meant something.
    expect(hits(result.events)).toHaveLength(0);
    expect(result.events.some((event) => event.kind === 'attackMissed')).toBe(true);
    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(false);
    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
      ),
    ).toBe(true);
  });

  /**
   * The same rule where it actually bit: the shot is loosed at the aim it
   * captured and disjoints in flight, exactly as one loosed a tick later does.
   */
  it('looses a shot whose target died during the wind-up, and it disjoints', () => {
    let state = createWorldState(8);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const victim = withDummy(state, 800, 450);
    state = victim.state;

    const committed = run(state, 2, {
      0: [
        input(player.id, {
          castAbilityId: 'ranged.star',
          castTargetX: 800,
          castTargetY: 450,
          castTargetEntityId: victim.id,
        }),
      ],
    });
    expect(committed.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Windup);

    const corpse = committed.state.entities.get(victim.id);
    if (!corpse) throw new Error('no victim');
    const dead = replaceEntity(committed.state, { ...corpse, health: 0 });

    // Far enough past the release for the star to be spawned and to expire.
    const result = run(dead, 80);
    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(false);
    expect(
      result.events.some((event) => event.kind === 'spawned' && event.typeId === 'ranged.star'),
    ).toBe(true);
    expect(hits(result.events)).toHaveLength(0);
    expect([...result.state.entities.values()].some((e) => e.projectile !== null)).toBe(false);
  });

  it('lets a shot already in the air finish, whatever becomes of its target', () => {
    let state = createWorldState(8);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const victim = withDummy(state, 800, 450);
    state = victim.state;

    // Run until the star is actually in flight -- past the release, so there is
    // nothing left to call off.
    let current = state;
    let flying = false;
    for (let i = 0; i < 60 && !flying; i++) {
      current = run(current, 1, {
        0: [
          input(player.id, {
            castAbilityId: 'ranged.star',
            castTargetX: 800,
            castTargetY: 450,
            castTargetEntityId: victim.id,
          }),
        ],
      }).state;
      flying = [...current.entities.values()].some((e) => e.projectile !== null);
    }
    expect(flying).toBe(true);

    const corpse = current.entities.get(victim.id);
    if (!corpse) throw new Error('no victim');
    current = replaceEntity(current, { ...corpse, health: 0 });

    // The shot is not reached back for: it flies its course and expires. The
    // caster's cast is already over, so nothing is refunded either.
    const after = run(current, 40);
    expect(hits(after.events)).toHaveLength(0);
    expect([...after.state.entities.values()].some((e) => e.projectile !== null)).toBe(false);
  });

  it('does not refuse a shot at a body walked into range of, edge included', () => {
    const star = abilityById('ranged.star');
    if (!star) throw new Error('no ranged.star');

    let state = createWorldState(8);
    const player = withPlayer(state, 0, 0);
    state = player.state;
    // Past the ability's range from the centre, inside it from the edge --
    // exactly the band the client's chase used to come to rest in.
    const radius = monsterById('dummy')?.radius ?? 22;
    const victim = withDummy(state, star.range + radius / 2, 0);
    state = victim.state;

    const asked = run(state, 1, {
      0: [
        input(player.id, {
          castAbilityId: 'ranged.star',
          castTargetX: star.range + radius / 2,
          castTargetY: 0,
          castTargetEntityId: victim.id,
        }),
      ],
    }, context({ activeChunks: activeAround(0, 0) }));

    expect(
      asked.events.some((event) => event.kind === 'castRejected' && event.reason === 'outOfRange'),
    ).toBe(false);
    expect(asked.state.entities.get(player.id)?.cast).not.toBeNull();
  });

  it('stamps a basic attack from the caster, and everything else from the table', () => {
    const quick: EffectiveStats = { ...STATS, baseAttackTimeTicks: 20 };
    const slow: EffectiveStats = { ...STATS, baseAttackTimeTicks: 40 };

    let state = createWorldState(6);
    const fast = withPlayer(state, 600, 450, quick);
    state = fast.state;
    const plodder = withPlayer(state, 600, 470, slow);
    state = plodder.state;

    // Run past the release, because that is where the stamp happens now (spec
    // 091) -- read at the commit, both of these are still undefined.
    const swung = run(state, slash.windupTicks + 2, {
      0: [
        input(fast.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 }),
        input(plodder.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 470 }),
      ],
    });

    const at = (id: number): number => swung.state.entities.get(id)?.cooldowns['melee.slash'] ?? 0;
    // Same weapon, same loose, twice the speed: half the wait. Both are stamped
    // from the same release, so the difference is the stat and nothing else.
    expect(at(fast.id)).toBeGreaterThan(0);
    expect(at(plodder.id) - at(fast.id)).toBe(20);
    // Neither of them is the table's number, which is what the swing used to
    // cost everybody.
    expect(slash.cooldownTicks).not.toBe(20);

    // A non-basic ability ignores the stat entirely.
    //
    // **And its authored cooldown is clamped**, which is a real finding rather
    // than a detail of this fixture. `attackTimingFor` sends a non-basic
    // ability's `cooldownTicks` through `resolveAttackTiming` as if it were a
    // Base Attack Time, and that clamps the interval to
    // `MAX_ATTACK_INTERVAL_SECONDS`. The constant's own comment says "nothing in
    // the content reaches either bound", which is true of BAT and false here:
    // twelve of the fourteen non-basic rows are over 5s, so Scorched Earth's
    // authored 24 seconds is really 5 and Stunning Blow's 14 is really 5.
    //
    // It was invisible while this test used `melee.heavy`, whose cooldown was
    // inside the bound. Asserted as it *is* rather than as the table reads, so
    // the behaviour is written down; fixing it is a balance decision and a
    // change to `attack-timing.ts`, not to this file.
    const spell = abilityById('skill.acidSpray');
    expect(spell).toBeDefined();
    if (!spell) return;
    const cast = run(state, spell.windupTicks + 2, {
      0: [input(fast.id, { castAbilityId: 'skill.acidSpray', castTargetX: 700, castTargetY: 450 })],
    });
    const spellReadyAt = cast.state.entities.get(fast.id)?.cooldowns['skill.acidSpray'] ?? 0;
    const clamped = Math.min(spell.cooldownTicks, MAX_ATTACK_INTERVAL_SECONDS * SERVER_TICK_RATE);
    expect(spellReadyAt).toBe(1 + spell.windupTicks + clamped);
    expect(clamped).toBeLessThan(spell.cooldownTicks);
  });

  it('lets a monster swing at the player it is chasing, by id', () => {
    let state = createWorldState(7);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const definition = monsterById('stalker');
    if (!definition) throw new Error('no stalker');
    const spawned = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: { x: 640, y: 450, z: 0 },
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      // Already fighting us: nothing initiates since spec 076.
      targetId: player.id,
    });

    // A second to close and turn, plus the swing's own wind-up -- asked rather
    // than written down, since how long a wind-up is moves (spec 094).
    const swing = abilityById(definition.stats.basicAttackId);
    const result = run(spawned.state, SERVER_TICK_RATE + (swing?.windupTicks ?? 0));
    const struck = hits(result.events).filter((hit) => hit.attackerId === spawned.entity.id);
    expect(struck.length).toBeGreaterThan(0);
    expect(struck.every((hit) => hit.targetId === player.id)).toBe(true);
  });

  it('replays a targeted fight identically from the same seed', () => {
    const frames = (player: number, target: number): Record<number, ServerInput[]> => ({
      0: [
        input(player, {
          castAbilityId: 'melee.slash',
          castTargetX: 640,
          castTargetY: 445,
          castTargetEntityId: target,
        }),
      ],
      30: [
        input(player, {
          castAbilityId: 'melee.slash',
          castTargetX: 640,
          castTargetY: 445,
          castTargetEntityId: target,
        }),
      ],
    });

    const once = twoInTheArc();
    const again = twoInTheArc();
    const a = run(once.state, 60, frames(once.player, once.named));
    const b = run(again.state, 60, frames(again.player, again.named));
    expect(JSON.stringify([...b.state.entities])).toBe(JSON.stringify([...a.state.entities]));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
  });
});

describe('an ability aimed at a body (spec 080)', () => {
  const seek = abilityById('skill.poisonDart');
  if (!seek) throw new Error('no skill.poisonDart');

  it('refuses a unit-targeted cast that named nothing, and spends nothing doing it', () => {
    let state = createWorldState(9);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 800, 450).state;

    const before = state.entities.get(player.id);
    const result = run(state, 3, {
      0: [input(player.id, { castAbilityId: 'skill.poisonDart', castTargetX: 800, castTargetY: 450 })],
    });

    expect(
      result.events.some((event) => event.kind === 'castRejected' && event.reason === 'noTarget'),
    ).toBe(true);
    const after = result.state.entities.get(player.id);
    expect(after?.cast).toBeNull();
    // A refusal changes no state: nothing spent, and no cooldown stamped on a
    // blow that was never thrown.
    expect(after?.resource).toBe(before?.resource);
    expect(after?.cooldowns['skill.poisonDart']).toBeUndefined();
  });

  it('refuses a mark past its range and commits to one inside it', () => {
    let state = createWorldState(9);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const far = withDummy(state, 600 + seek.range + 200, 450);
    state = far.state;

    const refused = run(state, 2, {
      0: [
        input(player.id, {
          castAbilityId: 'skill.poisonDart',
          castTargetX: 600 + seek.range + 200,
          castTargetY: 450,
          castTargetEntityId: far.id,
        }),
      ],
    });
    expect(
      refused.events.some((event) => event.kind === 'castRejected' && event.reason === 'outOfRange'),
    ).toBe(true);

    let near = createWorldState(9);
    const shooter = withPlayer(near, 600, 450);
    near = shooter.state;
    const mark = withDummy(near, 900, 450);
    near = mark.state;
    const committed = run(near, 2, {
      0: [
        input(shooter.id, {
          castAbilityId: 'skill.poisonDart',
          castTargetX: 900,
          castTargetY: 450,
          castTargetEntityId: mark.id,
        }),
      ],
    });
    expect(committed.state.entities.get(shooter.id)?.cast?.abilityId).toBe('skill.poisonDart');
  });

  it('looses a bolt that follows the body it named, and hits that body', () => {
    let state = createWorldState(9);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const mark = withDummy(state, 900, 450);
    state = mark.state;
    const full = monsterById('dummy')?.stats.maxHealth ?? 0;

    const result = run(state, seek.windupTicks + SERVER_TICK_RATE * 3, {
      0: [
        input(player.id, {
          castAbilityId: 'skill.poisonDart',
          castTargetX: 900,
          castTargetY: 450,
          castTargetEntityId: mark.id,
        }),
      ],
    });

    const struck = blows(result.events);
    expect(struck).toHaveLength(1);
    expect(struck[0]?.targetId).toBe(mark.id);
    expect(result.state.entities.get(mark.id)?.health).toBeLessThan(full);
  });

  it('is single-target however it flew: a body in the line is passed over', () => {
    let state = createWorldState(9);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const between = withDummy(state, 750, 450);
    state = between.state;
    const mark = withDummy(state, 900, 450);
    state = mark.state;
    const full = monsterById('dummy')?.stats.maxHealth ?? 0;

    const result = run(state, seek.windupTicks + SERVER_TICK_RATE * 3, {
      0: [
        input(player.id, {
          castAbilityId: 'skill.poisonDart',
          castTargetX: 900,
          castTargetY: 450,
          castTargetEntityId: mark.id,
        }),
      ],
    });

    expect(blows(result.events).map((hit) => hit.targetId)).toEqual([mark.id]);
    expect(result.state.entities.get(between.id)?.health).toBe(full);
  });

  it('holds the table to what a named blow is: a range, and no cone', () => {
    for (const ability of ALL_ABILITIES) {
      if (ability.targeting !== 'unit') continue;
      expect(ability.range, ability.id).toBeGreaterThan(0);
      // The wedge is not a thing a single-target blow has, and a field that
      // stopped describing the blow is the second name spec 079 removed.
      expect(ability.arcCosSq, ability.id).toBeUndefined();
    }
  });

  it('replays to bit-identical state and events with the same seed', () => {
    const windup = seek.windupTicks;
    function once(): Run {
      let state = createWorldState(21);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const mark = withDummy(state, 880, 470);
      state = mark.state;
      return run(state, windup + 50, {
        0: [
          input(player.id, {
            castAbilityId: 'skill.poisonDart',
            castTargetX: 880,
            castTargetY: 470,
            castTargetEntityId: mark.id,
          }),
        ],
      });
    }

    const a = once();
    const b = once();
    expect(JSON.stringify([...b.state.entities])).toBe(JSON.stringify([...a.state.entities]));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
  });
});

describe('commit alignment (spec 090)', () => {
  it('counts a body within a few ticks of turning as facing its aim', () => {
    const at = { x: 0, y: 0 };
    const aim = { x: 100, y: 0 };
    const turnRate = 540;
    const eps = commitAlignEps(turnRate, SERVER_TICK_RATE);

    // Three ticks of this body's own turn, and no more.
    expect(eps).toBeCloseTo(((turnRate * Math.PI) / 180 / SERVER_TICK_RATE) * COMMIT_ALIGN_TICKS, 9);

    // Strictly: half a degree off is not facing it. At the commit: it is, because
    // the client that asked is exactly this far ahead of the server.
    const off = eps * 0.8;
    expect(facesAim(at, off, aim)).toBe(false);
    expect(facesAim(at, off, aim, eps)).toBe(true);

    // But a body genuinely turned away is still turning, however generous the
    // tolerance -- this widens the last fraction of a turn, not the whole thing.
    expect(facesAim(at, Math.PI / 2, aim, eps)).toBe(false);
    expect(facesAim(at, Math.PI, aim, eps)).toBe(false);
  });

  it('never widens below the strict tolerance, whatever the body', () => {
    // A body that cannot turn gets the plain half-degree rather than zero.
    expect(commitAlignEps(0, SERVER_TICK_RATE)).toBe(TURN_ALIGN_EPS);
    expect(commitAlignEps(-90, SERVER_TICK_RATE)).toBeGreaterThan(0);
    expect(facesAim({ x: 0, y: 0 }, 0, { x: 10, y: 0 }, -5)).toBe(true);
  });
});
