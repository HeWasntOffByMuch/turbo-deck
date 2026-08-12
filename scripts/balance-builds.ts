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
 *   npx tsx scripts/balance-builds.ts [--seconds=n] [--monster=id] [--seed=n]
 *                                     [--preset=id]
 *
 * Nothing here is part of a build. It exists to be run and read.
 */

import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { abilityById, STARTING_ABILITIES } from '../src/server/data/abilities.js';
import { BUILD_PRESETS, fullSpreadOf, presetById, type BuildPreset } from '../src/server/data/presets.js';
import { monsterById } from '../src/server/data/monsters.js';
import { startingBaseStats } from '../src/server/player/attributes.js';
import { milestoneProgress, resolveProgression } from '../src/server/player/progression.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
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
import { createWorldState, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
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
};

function recordFor(preset: BuildPreset): PersistedPlayer {
  return {
    id: preset.id,
    displayName: preset.name,
    baseStats: fullSpreadOf(preset).attributes as unknown as BaseStats,
    skills: [],
    // Deliberately no stat skills. The comparison is between *attribute
    // spreads*; adding a hand-picked tree to each build would make the table a
    // comparison between whoever picked the trees.
    statSkills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: preset.level,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 0,
    resource: 0,
    coins: 0,
  };
}

interface Row {
  readonly preset: BuildPreset;
  readonly metrics: BuildMetrics;
  readonly survived: boolean;
  readonly maxHealth: number;
}

/**
 * One build against a stream of monsters.
 *
 * A stream rather than one, because a single kill measures burst and the thing
 * being compared is *sustainability*: whether a build can keep going is the
 * question, and it only has an answer once the pool has run out at least once.
 * A fresh monster appears the tick after the last one dies.
 */
function run(preset: BuildPreset): Row {
  const record = recordFor(preset);
  const stats = computeEffectiveStats(record);
  const monster = monsterById(monsterId);
  if (!monster) throw new Error(`no such monster: ${monsterId}`);

  let state: ServerWorldState = createWorldState(seed);
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: preset.id,
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = spawned.state;
  const selfId = spawned.entity.id;

  const basicDamage = abilityById(stats.basicAttackId)?.damage ?? 0;
  let metrics = EMPTY_METRICS;
  let seq = 0;
  let foeId = 0;

  for (let tick = 1; tick <= Math.round(seconds * SERVER_TICK_RATE); tick++) {
    const self = state.entities.get(selfId);
    if (!self || self.health <= 0) break;

    // Keep exactly one live opponent in front of the build.
    const foe = foeId > 0 ? state.entities.get(foeId) : undefined;
    if (!foe || foe.health <= 0) {
      const next = spawnEntity(state, {
        kind: EntityKindValue.Monster,
        typeId: monster.id,
        position: { x: ORIGIN.x + 60, y: ORIGIN.y, z: 0 },
        stats: monster.stats,
        radius: monster.radius,
        zoneId: 'greenmarch',
        targetId: selfId,
      });
      state = next.state;
      foeId = next.entity.id;
    }

    const target = state.entities.get(foeId);
    seq += 1;
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
      moveY: 0,
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

    metrics = foldMetrics(metrics, selfId, tick, result.events, REASONS);
    metrics = foldPosture(metrics, (after?.cast ?? null) !== null);
    if (before && after) {
      metrics = foldResource(
        metrics,
        { resource: before.resource, shield: before.shield },
        { resource: after.resource, shield: after.shield },
      );
    }
  }

  const survivor = state.entities.get(selfId);
  return {
    preset,
    metrics,
    survived: (survivor?.health ?? 0) > 0,
    maxHealth: stats.maxHealth,
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
const CASTABLE = STARTING_ABILITIES.map((id) => abilityById(id))
  .filter((ability): ability is NonNullable<typeof ability> => ability !== null)
  .filter((ability) => !ability.basicAttack && ability.kind !== 'self')
  .sort((a, b) => b.damage - a.damage);

function bestReady(
  self: { readonly cooldowns: Readonly<Record<string, number>>; readonly resource: number; readonly stats: { readonly traits: { readonly resourceCostScale: number } } },
  tick: number,
  basicDamage: number,
): string | null {
  for (const ability of CASTABLE) {
    if (ability.damage < basicDamage * PUNCTUATION_RATIO) continue;
    if (tick < (self.cooldowns[ability.id] ?? 0)) continue;
    if (self.resource < ability.cost * self.stats.traits.resourceCostScale) continue;
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

console.log('\n  What each build reached:\n');
for (const row of rows) {
  const record = recordFor(row.preset);
  const progression = resolveProgression(record);
  const reached = progression.milestones.map((m) => m.name);
  const pairs = progression.synergies.map((s) => s.name);
  console.log(`  ${pad(row.preset.name, 16)}${[...reached, ...pairs].join(', ') || '(nothing)'}`);
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

// The line the table exists to make checkable. A build that cannot kill the
// thing in front of it is not a build, whatever its other numbers say.
const broken = rows.filter((row) => row.metrics.kills === 0);
console.log('');
if (broken.length > 0) {
  console.log(`  !! ${broken.map((row) => row.preset.name).join(', ')} killed nothing.\n`);
  process.exitCode = 1;
} else {
  console.log(`  every build won at least once. Baseline: ${startingBaseStats().strength} in each.\n`);
}
