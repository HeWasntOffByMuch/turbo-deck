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
import { abilityById } from '../src/server/data/abilities.js';
import { ITEMS } from '../src/server/data/items.js';
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
    // Deliberately no skills. The comparison is between *attribute spreads*;
    // adding a hand-picked tree to each build would make the table a comparison
    // between whoever picked the trees.
    skills: [],
    // The starter kit rather than bare hands (spec 217). Every character in the
    // game begins holding `sword.worn`, and since a weapon now carries the
    // damage a swing does, an empty-handed preset measures a build punching --
    // which nobody does, and which is 1-2 damage against an ability's several.
    // The same weapon for all twelve, so it stays a control rather than a
    // variable.
    equipment: {
      ...STARTER_EQUIPMENT,
      skill1: HARNESS_SIGILS[0],
      skill2: HARNESS_SIGILS[1],
      skill3: HARNESS_SIGILS[2],
      skill4: HARNESS_SIGILS[3],
    },
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

  // What a swing is worth, which since spec 217 is the **weapon's** resolved
  // range rather than a field on the ability row. Read off the row it used to
  // be, this is now 0 for every build -- so `bestReady` preferred any ability
  // over swinging, every build stopped making basic attacks, and the weak-point
  // column of this table went to zero across the board while the harness
  // measured a rotation nobody plays.
  const basicDamage = stats.attackDamage;
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
      // Each opponent gets its own spawner id (spec 156). Without one they all
      // share a per-type farm key, and this harness -- which is a stream of the
      // same monster at the same spot -- decays to the floor within seconds and
      // measures the anti-farm rule instead of the economy. That rule has its
      // own tests; what this table is for is what an ordinary fight pays, which
      // is a camp of distinct spawn points rather than one corner farmed.
      state = replaceEntity(state, { ...next.entity, spawnerId: `bench-${next.entity.id}` });
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
        { resource: before.resource, shield: before.shield, fallbackCharges: before.fallbackCharges },
        { resource: after.resource, shield: after.shield, fallbackCharges: after.fallbackCharges },
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
/**
 * What a build has to punctuate with, read off the **sigils** (spec 232).
 *
 * It used to be `STARTING_ABILITIES`, which was spec 062's demo set -- one row
 * per `AbilityKind`, granted by nothing and castable by anybody. Those rows are
 * gone, and the abilities a character can actually cast now come from the four
 * skill slots, so the list comes from the same place: every `activeSkillId` in
 * the item table. Derived rather than typed out, so a thirteenth sigil is in
 * the harness the moment it is in the game.
 */
const CASTABLE = [...ITEMS.values()]
  .map((item) => item.activeSkillId)
  .filter((id): id is string => id !== undefined)
  .map((id) => abilityById(id))
  .filter((ability): ability is NonNullable<typeof ability> => ability !== null)
  .filter((ability) => !ability.basicAttack && ability.kind !== 'self')
  .sort((a, b) => b.damage - a.damage);

/**
 * The sigils every preset wears, so `startCast` will let it cast one.
 *
 * A skill is refused unless it is in a slot (spec 188), so a harness carrying
 * none would measure twelve builds auto-attacking. The **same four for all
 * twelve**, for the reason they all carry the same sword: a hand-picked set per
 * build would make the table a comparison between whoever picked the sets. The
 * four highest-damage sigils, because `bestReady` is looking for something
 * worth interrupting the backbone for and takes them in damage order anyway.
 */
const HARNESS_SIGILS = ['sigil.whirlwind', 'sigil.stunningBlow', 'sigil.guardBreak', 'sigil.rendingCut'] as const;

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
