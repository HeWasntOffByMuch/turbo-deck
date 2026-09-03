/**
 * Twelve builds, fought against the same problem, measured (spec 147).
 *
 * The brief's balance instrumentation, standing up. Every preset in
 * `data/presets.ts` is built through the *real* `computeEffectiveStats`, put in
 * the *real* `step`, and told to fight the same monster until it wins or dies.
 * Nothing here is a model of the game: if a number is wrong on this table, it is
 * wrong in the game.
 *
 * **The goal is not equal DPS.** A table where six builds have the same
 * damage-per-second is not evidence of balance, it is evidence that five of them
 * have been tuned into the sixth. What to read instead:
 *
 *   - every build **wins** -- a row with no kills is a build that does not work;
 *   - the *shape* of each row differs -- Strength high on staggers, Constitution
 *     high on damage taken and long on seconds, Agility lowest on health-per-kill,
 *     Perception highest on weak-point rate, Wisdom highest on resource ratio;
 *   - a row that looks like somebody else's row is the finding.
 *
 * **What this harness cannot see.** Both bodies stand still and one monster is
 * in front at a time, so it measures a duel and not an encounter. Three of the
 * six routes are therefore under-reported on purpose rather than by accident:
 * Agility's repositioning shows only as ROOT%, Intelligence's radius and range
 * are worth nothing against a single adjacent target, and Constitution's
 * forgiveness never gets tested by a mistake nobody makes. A stationary duel
 * against one melee monster is the *most* favourable test there is for a
 * glass-cannon build, so read Intelligence's DPS with that in mind rather than
 * tuning it down to match this table.
 *
 * Since spec 156 there is a second table under it, and one more thing it cannot
 * see. Each opponent is given its own spawner id, so the sustain numbers are the
 * *un-farmed* economy -- which is what a tuning table wants, and which means the
 * elite guarantee fires on every elite kill instead of once per spawner per
 * ninety seconds. The default `ravager` is an elite, so its MOTES/K pins at the
 * guarantee and its NET/K reads far kinder than a real one:
 *
 *   npx tsx scripts/balance-builds.ts --monster=stalker --seconds=180
 *
 * is the ordinary economy, and the row to tune against.
 *
 *   npx tsx scripts/balance-builds.ts [--seconds=n] [--monster=id] [--seed=n]
 *                                     [--preset=id]
 *
 * Nothing here is part of a build. It exists to be run and read.
 */

import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { abilityById, type AbilityDefinition } from '../src/server/data/abilities.js';
import { abilityAttributeBonus, abilityGradesOf } from '../src/server/data/ability-scaling.js';
import { ITEMS } from '../src/server/data/items.js';
import { BUILD_PRESETS, fullSpreadOf, presetById, type BuildPreset } from '../src/server/data/presets.js';
import { monsterById } from '../src/server/data/monsters.js';
import { startingBaseStats } from '../src/server/player/attributes.js';
import { milestoneProgress, resolveProgression } from '../src/server/player/progression.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { mayCancelBackswing } from '../src/server/sim/abilities.js';
import { hasStatus, statusOf, StatusId } from '../src/server/sim/statuses.js';
import {
  EMPTY_METRICS,
  foldMetrics,
  foldPosture,
  foldResource,
  summarise,
  type BuildMetrics,
} from '../src/server/sim/metrics.js';
import {
  CastEndReason,
  CastPhase,
  EntityKindValue,
  type ServerInput,
  type ServerWorldState,
} from '../src/server/sim/types.js';
import {
  createWorldState,
  replaceEntity,
  spawnEntity,
  step,
  type StepContext,
} from '../src/server/sim/world.js';
import { STARTER_EQUIPMENT } from '../src/server/player/player-manager.js';
import {
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
} from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { DEFAULT_WORLD } from '../src/sim/collision.js';

function flag(name: string, fallback: string): string {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const seconds = Number(flag('seconds', '30'));
const monsterId = flag('monster', 'ravager');
// How many opponents are kept alive in front of the build at once (specs 270,
// 271, which arrived at this independently and wanted it for opposite reasons).
//
// One is the attribute comparison this table has always been, and it measures
// two things badly. **Reach and radius**, because a stationary duel is the worst
// possible test of an attribute whose identity is catching several bodies at
// once -- spec 270. And **whether a commitment survives**, because hyper-armour
// is worth nothing until something is trying to knock you out of a swing, and
// one opponent on an attack cadence lands too few blows to interrupt anybody --
// spec 271. The columns that read them are the INT table's damage ratio and
// INTR/HELD respectively.
const foes = Math.max(1, Math.round(Number(flag('foes', '1'))));

/**
 * How far around the build those opponents are spread, in degrees.
 *
 * **The two scenarios genuinely want different answers**, which is why this is a
 * number rather than a constant either spec could have kept. Spec 270 needs them
 * in a lane: `skill.arcLash` is a `line` and `skill.acidSpray` is directional, so
 * a build that surrounds itself is measuring one target per cast whatever its
 * radius says. Spec 271 needs the opposite -- a body pressed from every side is
 * what actually interrupts a swing, and against a frontal arc the attack-slot
 * ring and the crowd pass queue the attackers up so politely that every build in
 * the table holds 100% of its commitments and the column says nothing.
 *
 * 180 is spec 270's own placement and stays the default, so its table is
 * untouched. `--arc=360` surrounds, which is what the commitment table wants.
 */
const ARC_DEGREES = Math.max(1, Number(flag('arc', '180')));
const ARC = (ARC_DEGREES * Math.PI) / 180;
const seed = Number(flag('seed', '1'));
const only = flag('preset', '');

const CHUNK = 100;
const ORIGIN = { x: 600, y: 450 };

const context: StepContext = {
  world: DEFAULT_WORLD,
  terrain: FLAT_TERRAIN,
  zones: new ZoneManager(),
  // No spawners: the fight is the two bodies put there on purpose, and a third
  // wandering in would make two runs of the same seed different fights.
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

const REASONS = {
  cancelled: CastEndReason.Cancelled,
  backswingCancelled: CastEndReason.BackswingCancelled,
  backswingPhase: CastPhase.Backswing,
  interrupted: CastEndReason.Interrupted,
};

/**
 * A preset's record, with the four sigils its own spread hits hardest with.
 *
 * Two passes, and the second is the loadout: {@link harnessSigilsFor} ranks
 * against the record built by the first, which carries no skills at all. Exact
 * rather than approximate, because a sigil's `modifiers` are empty in every row
 * -- see that function for why the ranking is per build rather than a list.
 */
function recordFor(preset: BuildPreset): PersistedPlayer {
  const bare = bareRecordFor(preset);
  const [skill1, skill2, skill3, skill4] = harnessSigilsFor(bare);
  return {
    ...bare,
    // An empty slot is `null` rather than absent, and there are always four
    // sigils in the table to fill them -- but a slot is typed as nullable, so
    // the fallback is stated rather than asserted away.
    equipment: {
      ...bare.equipment,
      skill1: skill1 ?? null,
      skill2: skill2 ?? null,
      skill3: skill3 ?? null,
      skill4: skill4 ?? null,
    },
  };
}

function bareRecordFor(preset: BuildPreset): PersistedPlayer {
  return {
    id: preset.id,
    displayName: preset.name,
    baseStats: fullSpreadOf(preset).attributes as unknown as BaseStats,
    // Whatever the preset's `tierShare` bought out of the same pool (spec 244).
    // Twelve of the presets spend nothing here and are the *attribute*
    // comparison, unchanged; the four `spend.*` rows are the new axis. Which
    // tiers a spending preset takes is derived from the tables -- lowest
    // threshold first -- rather than hand-picked, so the table stays a
    // comparison between policies and not between whoever picked the trees.
    specializations: fullSpreadOf(preset).specializations,
    // The starter kit rather than bare hands (spec 217). Every character in the
    // game begins holding `sword.worn`, and since a weapon now carries the
    // damage a swing does, an empty-handed preset measures a build punching --
    // which nobody does, and which is 1-2 damage against an ability's several.
    // The same weapon for all twelve, so it stays a control rather than a
    // variable.
    equipment: STARTER_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: preset.level,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 0,
    resource: 0,
    coins: 0,
  };
}

interface Fight {
  readonly metrics: BuildMetrics;
  readonly survived: boolean;
  readonly maxHealth: number;
  readonly watch: IntWatch;
}

/**
 * What the Intelligence track does over a fight (spec 270).
 *
 * Sampled here rather than folded into {@link BuildMetrics}, and that is a scope
 * decision rather than laziness: every one of these is a question about *this*
 * attribute -- how long a caster held a stance, how much health a spell ate,
 * how deep a weave got -- and widening the shared metrics record would put six
 * Intelligence fields in front of every other build's row forever.
 *
 * All of it is read off the body each tick. Nothing new crosses the wire and
 * nothing in the sim was changed to make it measurable, which is the property
 * that keeps a harness honest: it watches the game rather than a version of the
 * game instrumented for it.
 */
interface IntWatch {
  /** Ticks holding `Prepared` -- a banked stance, waiting to be spent. */
  preparedTicks: number;
  /** Ticks holding `Preparing` -- planted, and visibly so. */
  preparingTicks: number;
  /** Times the stance actually paid out. */
  primes: number;
  /** Times a cast was paid for with health, and how much it cost. */
  overdraws: number;
  overdrawHealth: number;
  /** Weave stacks summed per tick, and the deepest chain reached. */
  weaveTickStacks: number;
  weavePeak: number;
  /** Resource spent, and how much of it was the shaping premium. */
  resourceSpent: number;
  premiumPaid: number;
}

const emptyWatch = (): IntWatch => ({
  preparedTicks: 0,
  preparingTicks: 0,
  primes: 0,
  overdraws: 0,
  overdrawHealth: 0,
  weaveTickStacks: 0,
  weavePeak: 0,
  resourceSpent: 0,
  premiumPaid: 0,
});

interface Row extends Fight {
  readonly preset: BuildPreset;
}

/**
 * How the body behaves between casts.
 *
 * `still` is what every row of the twelve-build table does and has always done:
 * stand there and swing. `cancelling` walks out of each follow-through the tick
 * after the attack point, which is the *only* way Mobile Offense fires at all
 * (spec 254) -- a body that never asks to move never reaches `cancelBackswing`,
 * so the table above this one measures the mechanic at exactly zero whatever
 * tiers are held.
 */
type Policy = 'still' | 'cancelling';

/**
 * One build against a stream of monsters.
 *
 * A stream rather than one, because a single kill measures burst and the thing
 * being compared is *sustainability*: whether a build can keep going is the
 * question, and it only has an answer once the pool has run out at least once.
 * A fresh monster appears the tick after the last one dies.
 */
function run(preset: BuildPreset): Row {
  // `foes` explicitly, and it is the one line that makes `--foes` mean anything
  // for this table. Spec 270 made it a *parameter* defaulting to 1 so its own
  // Intelligence table could ask for four without moving the comparison above
  // it; spec 271 added the flag. Merged, the flag set a module constant that the
  // parameter shadowed -- so `--foes=8` printed "8 opponent(s)" over a table
  // fought one at a time, which is worse than the flag not existing.
  return { preset, ...fight(recordFor(preset), 'still', foes) };
}

/**
 * One record against a stream of monsters, under one behaviour policy.
 *
 * Split out of `run` so the Mobile Offense comparison below fights the *same*
 * fight rather than a second harness written beside this one -- the whole value
 * of comparing rank 0 with rank 3 is that nothing else about the run differs.
 */
function fight(
  record: PersistedPlayer,
  policy: Policy,
  foes = 1,
  against = monsterId,
  duration = seconds,
): Fight {
  const stats = computeEffectiveStats(record);
  const monster = monsterById(against);
  if (!monster) throw new Error(`no such monster: ${against}`);

  let state: ServerWorldState = createWorldState(seed);
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: record.id,
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = spawned.state;
  const selfId = spawned.entity.id;

  // What a swing is worth, which since spec 217 is the **weapon's** resolved
  // range rather than a field on the ability row. Read off the row it used to
  // be, this is now 0 for every build -- so `bestReady` preferred any ability
  // over swinging, every build stopped making basic attacks, and the weak-point
  // column of this table went to zero across the board while the harness
  // measured a rotation nobody plays.
  const basicDamage = stats.attackDamage;
  let metrics = EMPTY_METRICS;
  const watch = emptyWatch();
  let seq = 0;
  let foeIds: number[] = [];
  let cancels = 0;

  for (let tick = 1; tick <= Math.round(duration * SERVER_TICK_RATE); tick++) {
    const self = state.entities.get(selfId);
    if (!self || self.health <= 0) break;

    // Keep exactly `foes` live opponents in front of the build.
    //
    // More than one is spec 270's addition and it is the scenario Intelligence
    // was never measured in: a stationary duel is the worst possible test of an
    // attribute whose identity is reach and radius, and every row above this
    // one had been fought against a single body since the harness was written.
    // They are placed on an arc rather than in a line, close enough that one
    // Arc Lash or one Rime Touch can catch several -- which is the thing being
    // measured, not a courtesy.
    foeIds = foeIds.filter((id) => (state.entities.get(id)?.health ?? 0) > 0);
    while (foeIds.length < foes) {
      const index = foeIds.length;
      const angle = foes === 1 ? 0 : (index / foes) * ARC - ARC / 2;
      const next = spawnEntity(state, {
        kind: EntityKindValue.Monster,
        typeId: monster.id,
        position: {
          x: ORIGIN.x + Math.cos(angle) * 60,
          y: ORIGIN.y + Math.sin(angle) * 60,
          z: 0,
        },
        stats: monster.stats,
        radius: monster.radius,
        zoneId: 'greenmarch',
        targetId: selfId,
      });
      state = next.state;
      foeIds.push(next.entity.id);
      // Each opponent gets its own spawner id (spec 156). Without one they all
      // share a per-type farm key, and this harness -- which is a stream of the
      // same monster at the same spot -- decays to the floor within seconds and
      // measures the anti-farm rule instead of the economy. That rule has its
      // own tests; what this table is for is what an ordinary fight pays, which
      // is a camp of distinct spawn points rather than one corner farmed.
      state = replaceEntity(state, { ...next.entity, spawnerId: `bench-${next.entity.id}` });
    }

    const target = state.entities.get(foeIds[0] ?? 0);
    seq += 1;
    // Asking to move is how a body walks out of a follow-through (spec 079),
    // and one tick of it is the whole gesture -- but only from the **cancel
    // point** on (spec 258), because before that the sim refuses and the swing
    // runs to its end. Alternating, so a fight that cancels forty swings ends
    // where a fight that cancels none does -- a constant direction would walk
    // the build out of its own duel and measure the leash rather than the
    // mechanic.
    const leaving =
      policy === 'cancelling' && self.cast !== null && mayCancelBackswing(self.cast, tick);
    if (leaving) cancels += 1;
    // **One policy, for every build.** Throw the heaviest thing that is ready
    // and affordable, and fall back to the weapon. The differences in the table
    // are then the *stats* rather than a rotation somebody wrote per build --
    // and it is what lets Intelligence and Wisdom show at all, since a harness
    // that only auto-attacks measures neither a spell nor a resource pool.
    const chosen = bestReady(self, tick, basicDamage) ?? (target ? stats.basicAttackId : '');
    const input: ServerInput = {
      entityId: selfId,
      seq,
      moveX: 0,
      moveY: leaving ? (cancels % 2 === 0 ? 1 : -1) : 0,
      facing: 0,
      buttons: 0,
      predictedX: self.position.x,
      predictedY: self.position.y,
      hasPrediction: false,
      seqSpan: 1,
      // Attack whenever free. Every build fights the same way -- the differences
      // in the table are the *stats*, not a policy somebody wrote per build.
      castAbilityId: self.cast === null && target ? chosen : '',
      castTargetX: target?.position.x ?? ORIGIN.x,
      castTargetY: target?.position.y ?? ORIGIN.y,
      castTargetEntityId: target?.id ?? 0,
      cancelCast: false,
    };

    const before = state.entities.get(selfId);
    const result = step(state, [input], context);
    state = result.state;
    const after = state.entities.get(selfId);

    // --- the Intelligence watch (spec 270) -------------------------------
    //
    // Charged on the tick a cast **starts**, not on every tick the policy names
    // one. The first cut did the latter and reported 989 resource spent from a
    // 109-point pool over thirty seconds, because `bestReady` names an ability
    // on nearly every idle tick and most of those are refused for cooldown.
    if (before?.cast === null && after?.cast) {
      const row = abilityById(after.cast.abilityId);
      if (row) {
        const paid = after.cast.spentResource + after.cast.spentHealth;
        watch.resourceSpent += after.cast.spentResource;
        // What shaping charged, as the difference between the price paid and the
        // price without the premium -- rather than `cost * shapingCostPct`,
        // which would double-count Wisdom's discount on the way past.
        const premium = before.stats.traits.shapingCostPct;
        if (premium > 0 && paid > 0) watch.premiumPaid += paid - paid / (1 + premium);
      }
    }
    if (after) {
      const now = state.tick;
      if (hasStatus(after.statuses, StatusId.Prepared, now)) watch.preparedTicks += 1;
      if (hasStatus(after.statuses, StatusId.Preparing, now)) watch.preparingTicks += 1;
      // Counted on the *edge*, so holding a banked stance for a hundred ticks is
      // one prime rather than a hundred.
      if (
        before &&
        !hasStatus(before.statuses, StatusId.Prepared, tick) &&
        hasStatus(after.statuses, StatusId.Prepared, now)
      ) {
        watch.primes += 1;
      }
      if (
        before &&
        !hasStatus(before.statuses, StatusId.Overdrawn, tick) &&
        hasStatus(after.statuses, StatusId.Overdrawn, now)
      ) {
        watch.overdraws += 1;
        watch.overdrawHealth += Math.max(0, before.health - after.health);
      }
      const stacks = statusOf(after.statuses, StatusId.Weave, now)?.stacks ?? 0;
      watch.weaveTickStacks += stacks;
      watch.weavePeak = Math.max(watch.weavePeak, stacks);
    }

    metrics = foldMetrics(metrics, selfId, tick, result.events, REASONS);
    metrics = foldPosture(metrics, (after?.cast ?? null) !== null);
    if (before && after) {
      metrics = foldResource(
        metrics,
        { resource: before.resource, shield: before.shield, fallbackCharges: before.fallbackCharges },
        { resource: after.resource, shield: after.shield, fallbackCharges: after.fallbackCharges },
      );
    }
  }

  const survivor = state.entities.get(selfId);
  return {
    metrics,
    survived: (survivor?.health ?? 0) > 0,
    maxHealth: stats.maxHealth,
    watch,
  };
}

/**
 * The heaviest ability this body could throw right now, or null.
 *
 * Ready, affordable *through the caster's own cost* -- so a Wisdom build can
 * afford what a Strength build cannot -- and self-targeted rows excluded,
 * because a heal aimed at a monster is not a rotation, it is a bug in the
 * harness. Sorted by damage, so "heaviest" is a fact about the table rather
 * than an order somebody typed.
 *
 * The threshold is what makes the table representative rather than merely
 * deterministic. Without it the cheapest bolt is off cooldown almost every tick
 * and the *weapon never swings at all*: the first version of this harness had
 * every build casting `bolt.arcane` on repeat, which meant zero staggers and
 * zero weak points on every row, because both are basic-attack mechanics. A
 * punctuation ability has to be worth interrupting the backbone for, and twice
 * the weapon's damage is the line.
 */
const PUNCTUATION_RATIO = 2;
/**
 * What a build has to punctuate with, read off the **sigils** (spec 232).
 *
 * It used to be `STARTING_ABILITIES`, which was spec 062's demo set -- one row
 * per `AbilityKind`, granted by nothing and castable by anybody. Those rows are
 * gone, and the abilities a character can actually cast now come from the four
 * skill slots, so the list comes from the same place: every `activeSkillId` in
 * the item table. Derived rather than typed out, so a thirteenth sigil is in
 * the harness the moment it is in the game.
 *
 * {@link castable} is the one filter, and it is applied in both places that
 * ask: the loadout, which must not spend a slot on something the harness will
 * never throw, and {@link bestReady}, which must not offer one. A `self`-kind
 * ability is excluded because this is a stationary duel and an aura the harness
 * never walks anybody into measures nothing; `skill.testStatuses` because it is
 * the debug row, and it is named rather than inferred, since "costs 0 and does
 * 1 damage" is a shape a real skill could have.
 */
function castable(ability: AbilityDefinition): boolean {
  return !ability.basicAttack && ability.kind !== 'self' && ability.id !== 'skill.testStatuses';
}

/** Every sigil the harness could throw, paired with the ability it grants. */
const SIGILS = [...ITEMS.values()]
  .filter((item) => item.slot === 'skill' && item.activeSkillId !== undefined)
  .map((item) => ({ itemId: item.id, ability: abilityById(item.activeSkillId as string) }))
  .filter((row): row is { itemId: string; ability: AbilityDefinition } => row.ability !== null)
  .filter((row) => castable(row.ability));

/**
 * The four sigils a preset wears, so `startCast` will let it cast one.
 *
 * A skill is refused unless it is in a slot (spec 188), so a harness carrying
 * none would measure twelve builds auto-attacking.
 *
 * **The same rule for all twelve, not the same four sigils** -- and that is a
 * correction rather than a preference. This was a hardcoded list of the four
 * highest-`damage` sigils, on the argument that all twelve carrying one set is
 * a control the way all twelve carrying one sword is. That argument held only
 * while every ability in the game scaled with Intelligence: the four could be
 * handed to anybody because the row's flat `damage` really was what each build
 * got out of them.
 *
 * Since spec 238 an ability scales with what its own row declares, and the four
 * highest-`damage` sigils are all Strength or Agility. Handed to everybody they
 * stopped being a control and became a martial loadout: Pure Intelligence and
 * INT/WIS wore four skills their spread bought nothing from, never cleared
 * {@link PUNCTUATION_RATIO}, never cast, and killed **nothing** in thirty
 * seconds. That is a fact about the list, not about the build.
 *
 * So the *rule* is the control: the four sigils this spread hits hardest with,
 * ranked by {@link resolvedDamage} -- the same function `bestReady` picks with,
 * so the loadout and the selection heuristic cannot disagree about what a build
 * is holding. Nobody hand-picks anything, and a thirteenth sigil is in the
 * harness the moment it is in the game.
 *
 * Ranked against a **skill-less** record, which is exact rather than
 * approximate: a sigil's `modifiers` are empty in every row, so wearing one
 * cannot move the attributes the ranking reads.
 */
function harnessSigilsFor(record: PersistedPlayer): readonly string[] {
  const stats = computeEffectiveStats(record);
  return [...SIGILS]
    .sort((a, b) => {
      const byDamage = resolvedDamage(b.ability, stats) - resolvedDamage(a.ability, stats);
      // Ties broken on id, or the loadout depends on the item table's order.
      return byDamage !== 0 ? byDamage : a.itemId.localeCompare(b.itemId);
    })
    .slice(0, 4)
    .map((row) => row.itemId);
}

/**
 * What an ability actually hits this body's targets for (spec 238).
 *
 * **Not `ability.damage`.** That is the row's flat number, and since spec 238 an
 * ability's damage is that plus its declared attribute scaling -- so a caster's
 * Ember Toss is several times its authored 2 and a Strength character's
 * Whirlwind is more than double its authored 4. Comparing the authored number
 * against a resolved weapon damage is comparing two different quantities, which
 * is exactly the fault spec 217 recorded fixing in this same function when a
 * basic attack's damage moved onto the weapon.
 *
 * The weapon term is deliberately absent: no production ability declares one,
 * and a roll has no place in a selection heuristic.
 */
function resolvedDamage(ability: AbilityDefinition, stats: EffectiveStats): number {
  return (
    ability.damage +
    abilityAttributeBonus(
      stats.scalingAttributes,
      abilityGradesOf(ability.scaling),
      stats.spellPower,
    )
  );
}

/**
 * The heaviest thing this body could throw right now, or null for the weapon.
 *
 * Two things about the candidate list, and each was a silent zero before it was
 * fixed.
 *
 * **It is what the body is carrying**, off `skillAbilityIds` -- the server's own
 * derivation from the four slots -- rather than every sigil in the item table.
 * `startCast` refuses a skill that is not in a slot (spec 188), so a global list
 * hands a build an id it does not own, the cast is refused, and the fallback to
 * the weapon never happens because a choice was made. Pure Intelligence went to
 * **0.0 DPS** that way: offered Whirlwind, which it was not wearing, on every
 * tick it was free.
 *
 * **And it is ranked by {@link resolvedDamage}**, not by the row's flat
 * `damage`. Since spec 238 those are different orders for every build -- flat
 * damage is what an ability is worth to nobody in particular.
 */
function bestReady(
  self: {
    readonly cooldowns: Readonly<Record<string, number>>;
    readonly resource: number;
    readonly stats: EffectiveStats;
  },
  tick: number,
  basicDamage: number,
): string | null {
  const carried = self.stats.skillAbilityIds
    .map((id) => abilityById(id))
    .filter((ability): ability is AbilityDefinition => ability !== null)
    .filter(castable)
    .sort((a, b) => resolvedDamage(b, self.stats) - resolvedDamage(a, self.stats));
  for (const ability of carried) {
    if (resolvedDamage(ability, self.stats) < basicDamage * PUNCTUATION_RATIO) continue;
    if (tick < (self.cooldowns[ability.id] ?? 0)) continue;
    // Affordable, **or overdrawable** (spec 270). The affordability line alone
    // made Arcane Overflow unmeasurable by construction: the capstone exists for
    // the moment a caster cannot pay, and a policy that refuses to try one it
    // cannot pay for never reaches it. A build holding the capstone throws the
    // spell and lets the sim decide whether health covers the gap -- which is
    // what a player who bought it would do, and what `startCast` is there to
    // refuse if the bill is too big.
    const price = ability.cost * self.stats.traits.resourceCostScale;
    const overdrawable = self.stats.traits.overflowHealthPerResource > 0;
    if (self.resource < price && !overdrawable) continue;
    return ability.id;
  }
  return null;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function num(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

const presets = only ? [presetById(only)].filter((p): p is BuildPreset => p !== null) : BUILD_PRESETS;
if (presets.length === 0) {
  console.error(`no such preset: ${only}`);
  process.exit(1);
}

console.log(`\n  ${presets.length} builds x ${seconds}s vs ${monsterId}, seed ${seed}\n`);

const rows = presets.map(run);

console.log(
  `  ${pad('BUILD', 16)}${pad('KILLS', 6)}${pad('DPS', 7)}${pad('HP/KILL', 9)}${pad('STAG/K', 8)}` +
    `${pad('WEAK%', 7)}${pad('ABSORB%', 9)}${pad('RES x', 7)}${pad('ROOT%', 7)}${pad('CC%', 6)}${pad('ALIVE', 6)}`,
);
console.log(`  ${'-'.repeat(88)}`);

for (const row of rows) {
  const s = summarise(row.metrics, SERVER_TICK_RATE);
  console.log(
    `  ${pad(row.preset.name, 16)}${pad(String(s.kills), 6)}${pad(num(s.dps), 7)}` +
      `${pad(num(s.healthPerKill), 9)}${pad(num(s.staggersPerKill, 2), 8)}` +
      `${pad(num(s.weakPointRate * 100), 7)}${pad(num(s.absorbFraction * 100), 9)}` +
      `${pad(num(s.resourceRatio, 2), 7)}${pad(num(s.rootedFraction * 100), 7)}` +
      `${pad(num(s.controlledFraction * 100), 6)}` +
      `${pad(row.survived ? 'yes' : 'NO', 6)}`,
  );
}

// --- the commitment table (spec 271) --------------------------------------
// What the table above cannot see. Strength's defensive half is entirely about
// a swing *surviving*, and against one opponent nothing interrupts anybody, so
// every hyper-armour tier in the tree reads as a flat row. Run with `--foes 4`
// and these columns move.
//
// BREAKS is Guard breaks caused, TTB the seconds of fight per break, INTR the
// casts taken away by something other than the player's own decision, and HELD
// the fraction of committed casts that survived to land. HELD is the one to
// read: it is what Committed Swing and Unstoppable are bought for.
console.log('');
console.log(`  Commitment and Guard pressure -- ${String(foes)} opponent(s):`);
console.log('');
console.log(
  `  ${pad('BUILD', 16)}${pad('BREAKS', 8)}${pad('TTB s', 8)}${pad('COMMIT', 8)}` +
    `${pad('INTR', 6)}${pad('HELD%', 7)}${pad('STAG TAKEN', 12)}${pad('TAKEN', 8)}${pad('KILLS', 6)}`,
);
console.log(`  ${'-'.repeat(80)}`);
for (const row of rows) {
  const m = row.metrics;
  const secondsFought = m.ticks / SERVER_TICK_RATE;
  const breaks = m.staggersCaused;
  const committed = m.castsCommitted;
  // A cast that committed and was not taken away. `castsInterrupted` counts the
  // ones a break or a death removed; a withdrawal is the player's own choice and
  // is deliberately not counted against them here.
  const held = committed > 0 ? (committed - m.castsInterrupted) / committed : 1;
  console.log(
    `  ${pad(row.preset.name, 16)}${pad(String(breaks), 8)}` +
      `${pad(breaks > 0 ? num(secondsFought / breaks, 2) : '-', 8)}` +
      `${pad(String(committed), 8)}${pad(String(m.castsInterrupted), 6)}` +
      `${pad(num(held * 100), 7)}${pad(String(m.staggersTaken), 12)}` +
      `${pad(num(m.damageTaken), 8)}${pad(String(m.kills), 6)}`,
  );
}

// --- the health economy (spec 156) ---------------------------------------
// A second table rather than ten more columns, because it answers a different
// question. The one above asks whether the six builds *fight* differently; this
// one asks whether they *sustain* differently, and the column that matters is
// NET/K -- health restored minus health lost, per kill.
//
// What a healthy table looks like: every row negative but not steeply so,
// Agility nearest zero because it spends least, Wisdom highest on MOTE% because
// it wastes least, Strength and Perception highest on RESTORE/K because their
// bonuses fire, and FLASK/K near zero on all of them. A row at or above zero on
// NET/K is a build that never has to leave, which is the failure this whole
// spec exists to prevent.
console.log('\n  Sustain -- net health per kill is the number this is tuned against:\n');
console.log(
  `  ${pad('BUILD', 16)}${pad('NET/K', 9)}${pad('REST/K', 9)}${pad('MOTES/K', 9)}` +
    `${pad('TAKEN/K', 9)}${pad('HEALED/K', 10)}${pad('MOTE%', 8)}${pad('FLASK/K', 9)}`,
);
console.log(`  ${'-'.repeat(73)}`);

for (const row of rows) {
  const s = summarise(row.metrics, SERVER_TICK_RATE);
  const kills = Math.max(1, row.metrics.kills);
  console.log(
    `  ${pad(row.preset.name, 16)}${pad(num(s.netHealthPerKill), 9)}` +
      `${pad(num(row.metrics.restorationEarned / kills), 9)}` +
      `${pad(num(s.motesPerKill, 2), 9)}${pad(num(s.healthPerKill), 9)}` +
      `${pad(num(row.metrics.healingReceived / kills), 10)}` +
      `${pad(num(s.moteEfficiency * 100), 8)}${pad(num(s.fallbackPerKill, 2), 9)}`,
  );
}

// Why each build got what it got. The brief's quality bar asks whether a
// designer can inspect the derivation rather than only the total, and a route
// that is not firing shows up here as a missing line rather than as a number
// that is merely lower than somebody else's.
console.log('\n  Where the restoration came from:\n');
for (const row of rows) {
  const sources = Object.entries(row.metrics.restorationSources)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, amount]) => `${reason} ${Math.round(amount)}`);
  console.log(`  ${pad(row.preset.name, 16)}${sources.join(', ') || '(base only)'}`);
}

console.log('\n  What each build reached:\n');
for (const row of rows) {
  const record = recordFor(row.preset);
  const progression = resolveProgression(record);
  const reached = progression.milestones.map((m) => m.name);
  console.log(`  ${pad(row.preset.name, 16)}${reached.join(', ') || '(nothing)'}`);
}

console.log('\n  Nearest unreached milestone, per build:\n');
for (const row of rows) {
  const { attributes } = resolveProgression(recordFor(row.preset));
  const next = milestoneProgress(attributes)
    .filter((entry) => entry.next !== null)
    .sort((a, b) => a.remaining - b.remaining)[0];
  console.log(
    `  ${pad(row.preset.name, 16)}${next?.next ? `${next.remaining} more ${next.attribute} -> ${next.next.name}` : '(all reached)'}`,
  );
}

// --- Mobile Offense, ranks 0 to 3 (spec 254) -------------------------------
//
// A section of its own rather than four more presets, because it is the only
// thing in this file that measures a *behaviour* rather than a spread: the
// twelve rows above stand perfectly still, and a body that never asks to move
// never walks out of a follow-through, so Mobile Offense fires zero times on
// every one of them however many tiers it holds.
//
// One spread, four tier counts, everything else identical -- the same monster,
// the same seed, the same seconds, the same four sigils (ranked off a spread
// that does not move between the rows). Agility is 25 deliberately: above the
// 20 milestone, so Flow exists and the fight is the real one, and below the 35
// milestone, which *also* grants `mobileOffenseCooldownTicks` and would quietly
// make the rank-0 row a rank-1 row.
//
// What to read: TRIGGER/K against CANCELS is whether the mechanic is being
// *collected* or merely fired, and USES/MIN is the only column that says
// whether the reduction turned into anything. Seconds refunded is the loudest
// number and the least meaningful on its own -- time taken off a cooldown that
// was going to expire before the next opening is worth nothing.
// Intelligence-heavy, and that is forced rather than chosen: `bestReady` only
// throws an ability worth {@link PUNCTUATION_RATIO} times the weapon, and since
// spec 217 a build with any Strength in it swings harder than any sigil it owns
// -- eleven of the sixteen presets above clear that bar with nothing at all and
// spend the whole fight auto-attacking. A build that never casts has no cooling
// active ability, and a mechanic that reduces cooling active abilities cannot be
// measured on one. Agility 25 is the constant across all four rows; the rest is
// whatever makes four sigils castable.
const MOBILE_OFFENSE_SPREAD = {
  strength: 5,
  agility: 25,
  intelligence: 45,
  constitution: 20,
  perception: 5,
  wisdom: 10,
} as unknown as BaseStats;

function mobileOffenseRecord(tiers: number): PersistedPlayer {
  const bare: PersistedPlayer = {
    id: `mobile-${String(tiers)}`,
    displayName: `Mobile Offense x${String(tiers)}`,
    baseStats: MOBILE_OFFENSE_SPREAD,
    specializations:
      tiers > 0 ? [{ specializationId: 'agi.mobileOffense', tier: tiers }] : [],
    equipment: STARTER_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 0,
    resource: 0,
    coins: 0,
  };
  const [skill1, skill2, skill3, skill4] = harnessSigilsFor(bare);
  return {
    ...bare,
    equipment: {
      ...bare.equipment,
      skill1: skill1 ?? null,
      skill2: skill2 ?? null,
      skill3: skill3 ?? null,
      skill4: skill4 ?? null,
    },
  };
}

const RANKS = [0, 1, 2, 3];
const mobileRows = RANKS.map((tiers) => ({
  tiers,
  fight: fight(mobileOffenseRecord(tiers), 'cancelling'),
}));

console.log('\n  Mobile Offense, walking out of every follow-through:\n');
console.log(
  `  ${pad('RANK', 7)}${pad('PER CX', 8)}${pad('CANCELS', 9)}${pad('TRIGGERS', 10)}` +
    `${pad('CD SEC', 8)}${pad('USES/MIN', 10)}${pad('KILLS', 7)}${pad('DPS', 7)}${pad('ROOT%', 7)}`,
);
console.log(`  ${'-'.repeat(73)}`);
for (const row of mobileRows) {
  const s = summarise(row.fight.metrics, SERVER_TICK_RATE);
  const perTrigger =
    row.fight.metrics.mobileOffenseTriggers > 0
      ? s.cooldownSecondsRefunded / row.fight.metrics.mobileOffenseTriggers
      : 0;
  console.log(
    `  ${pad(`x${String(row.tiers)}`, 7)}${pad(num(perTrigger, 2), 8)}` +
      `${pad(String(row.fight.metrics.backswingsCancelled), 9)}` +
      `${pad(String(row.fight.metrics.mobileOffenseTriggers), 10)}` +
      `${pad(num(s.cooldownSecondsRefunded), 8)}` +
      `${pad(num(s.activeAbilityUsesPerMinute, 2), 10)}` +
      `${pad(String(s.kills), 7)}${pad(num(s.dps), 7)}${pad(num(s.rootedFraction * 100), 7)}`,
  );
}

// Which abilities the time actually went to. One trigger reduces every cooling
// active ability at once, so the total above cannot say whether a rank bought a
// second poison dart or took a third off a 24-second Scorched Earth -- and only
// the second of those is a balance problem.
console.log('\n  Where the cooldown went:\n');
for (const row of mobileRows) {
  const byAbility = Object.entries(row.fight.metrics.cooldownRefundedByAbility)
    .sort((a, b) => b[1] - a[1])
    .map(([abilityId, ticks]) => `${abilityId} ${num(ticks / SERVER_TICK_RATE)}s`);
  console.log(`  ${pad(`x${String(row.tiers)}`, 7)}${byAbility.join(', ') || '(nothing)'}`);
}

// The acceleration, stated rather than left to be worked out from two columns:
// how much faster rank 3 gets to press an active ability than rank 0 does, on
// the same spread against the same monster.
const base = mobileRows[0];
const top = mobileRows[RANKS.length - 1];
if (base && top) {
  const from = summarise(base.fight.metrics, SERVER_TICK_RATE).activeAbilityUsesPerMinute;
  const to = summarise(top.fight.metrics, SERVER_TICK_RATE).activeAbilityUsesPerMinute;
  const factor = from > 0 ? to / from : 0;
  console.log(
    `\n  x3 presses an active ability ${num(factor, 2)}x as often as x0 ` +
      `(${num(from, 2)} -> ${num(to, 2)} per minute).`,
  );
}

// The line the table exists to make checkable. A build that cannot kill the
// thing in front of it is not a build, whatever its other numbers say.
// --- the Intelligence track (spec 270) -------------------------------------
//
// Its own table, and a *second fight*, because the one above cannot answer the
// question. Every row up there is a stationary duel against one body, which is
// the worst possible test of the attribute whose identity is reach and radius --
// and until this spec every Intelligence preset also spent nothing on its own
// specializations, so the tree with the most tier-gated capabilities in the game
// had never been measured with any of them bought.
const INT_PRESETS = ['pure.intelligence', 'spend.intCaster', 'pair.intWis', 'pair.agiInt'];
const FOES = 4;
/**
 * How long the Intelligence fight runs, against the table's thirty.
 *
 * Long enough for the magazine to matter, which is the whole point of spec 270:
 * a pure-Intelligence pool takes about a minute of sustained casting to empty,
 * so a thirty-second fight measures a caster who never ran out and reports the
 * capstone -- which only fires on an empty pool -- as never firing.
 */
const INT_SECONDS = 90;

const intRows = INT_PRESETS.map((id) => presetById(id))
  .filter((preset): preset is BuildPreset => preset !== null)
  .map((preset) => ({
    preset,
    solo: fight(recordFor(preset), 'still', 1, monsterId, INT_SECONDS),
    group: fight(recordFor(preset), 'still', FOES, monsterId, INT_SECONDS),
    // The same build against something that does not hit back.
    //
    // Not a courtesy row: `blow.ts` stamps the stance clock on every blow that
    // lands, so a caster stood in melee range of a ravager can never finish a
    // two-second stance -- which is the counterplay working, and is also why the
    // contested rows below read `0` primes. This one is the other half of the
    // claim: given the range an artillery build is supposed to fight at, does
    // the cadence actually rebuild?
    quiet: fight(recordFor(preset), 'still', 1, 'dummy', INT_SECONDS),
  }));

if (intRows.length > 0) {
  const ticks = Math.round(INT_SECONDS * SERVER_TICK_RATE);
  console.log(
    `\n  Intelligence over ${String(INT_SECONDS)}s, alone and against ${String(FOES)} at once:\n`,
  );
  console.log(
    `  ${pad('BUILD', 16)}${pad('KILLS', 6)}${pad('DPS', 7)}${pad('GRP KILLS', 10)}${pad('GRP DPS', 9)}` +
      `${pad('RES SPENT', 10)}${pad('PREMIUM', 9)}${pad('PRIMES', 8)}${pad('PREPARED%', 10)}` +
      `${pad('PLANT%', 8)}${pad('WEAVE', 7)}${pad('OVERDRAW', 9)}${pad('GRP ALIVE', 9)}`,
  );
  console.log(`  ${'-'.repeat(116)}`);
  for (const row of intRows) {
    const solo = summarise(row.solo.metrics, SERVER_TICK_RATE);
    const group = summarise(row.group.metrics, SERVER_TICK_RATE);
    const w = row.group.watch;
    const q = row.quiet.watch;
    console.log(
      `  ${pad(row.preset.name, 16)}${pad(String(solo.kills), 6)}${pad(num(solo.dps), 7)}` +
        `${pad(String(group.kills), 10)}${pad(num(group.dps), 9)}` +
        `${pad(num(w.resourceSpent), 10)}${pad(num(w.premiumPaid), 9)}` +
        `${pad(String(q.primes), 8)}${pad(num((q.preparedTicks / ticks) * 100), 10)}` +
        `${pad(num((w.preparingTicks / ticks) * 100), 8)}` +
        `${pad(num(w.weaveTickStacks / ticks, 2), 7)}` +
        `${pad(w.overdraws > 0 ? `${String(w.overdraws)}/${num(w.overdrawHealth)}hp` : '-', 9)}` +
        `${pad(row.group.survived ? 'yes' : 'NO', 9)}`,
    );
  }
  console.log(
    `\n  PRIMES and PREPARED% are measured **unhit** -- against a training dummy --` +
      `\n  because a blow stamps the stance clock, so a caster held in melee range` +
      `\n  never finishes one. PLANT% is time visibly taking a stance in the group` +
      `\n  fight, which is the tell an opponent reads. WEAVE is the mean stacks held.` +
      `\n  OVERDRAW reads '-' here because the magazine outlasts the fight: the spend` +
      `\n  rate is bounded by cooldowns, not by the pool, so a caster runs out in a` +
      `\n  long sustained rotation (see intelligence.test.ts) rather than in this one.`,
  );

  // What the group fight is *for*: the same build, measured against one body and
  // against four, so the AoE the duel cannot see shows up as a ratio.
  console.log('\n  What a second target is worth:\n');
  for (const row of intRows) {
    const solo = summarise(row.solo.metrics, SERVER_TICK_RATE);
    const group = summarise(row.group.metrics, SERVER_TICK_RATE);
    const ratio = solo.dps > 0 ? group.dps / solo.dps : 0;
    console.log(
      `  ${pad(row.preset.name, 16)}${num(ratio, 2)}x damage against ${String(FOES)}` +
        `${row.group.survived ? '' : '  (and died doing it)'}`,
    );
  }
}

//
// **Only in the one-opponent scenario** (spec 271). `--foes` is a stress test,
// and a build failing to win against four ravagers at once is a fact about the
// scenario rather than a broken row -- three of the six pure builds kill nothing
// at `--foes=4`, which is the scenario doing its job. Failing the run there
// would make the flag unusable, so the guard states its scope instead.
const broken = rows.filter((row) => row.metrics.kills === 0);
console.log('');
if (broken.length > 0 && foes === 1) {
  console.log(`  !! ${broken.map((row) => row.preset.name).join(', ')} killed nothing.\n`);
  process.exitCode = 1;
} else if (broken.length > 0) {
  console.log(
    `  ${broken.map((row) => row.preset.name).join(', ')} killed nothing` +
      ` -- expected against ${String(foes)} at once, not a failure.\n`,
  );
} else {
  console.log(`  every build won at least once. Baseline: ${startingBaseStats().strength} in each.\n`);
}
