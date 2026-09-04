/**
 * What the active-resource economy actually is, measured (spec 276).
 *
 * `npm run balance` fights twelve presets for thirty seconds and prints damage;
 * `npm run audit:progression` asks whether a purchase moves a trait. Neither can
 * answer the question this one is for, and the reason is duration as much as
 * subject: **resource is the one quantity in this game whose interesting
 * behaviour is slower than a fight.** A build with a 104-point magazine and a
 * 0.4/s reload looks identical to one with an infinite pool for the first
 * twenty seconds, and the whole design question is what happens at ninety.
 *
 * So every sheet here is driven through the real `step()` for two to three
 * minutes, and the numbers are read off the real entity rather than off the
 * formulas -- which is the point of a probe rather than a spreadsheet: a
 * spreadsheet cannot see that a body is rooted through its own casts, that a
 * cooldown came back while the pool was empty, or that a weak point paid for
 * the swing that found it.
 *
 * Six sheets.
 *
 *  1. **The static economy.** Pool, regeneration, cost scale and cooldown scale
 *     for each build, plus every resource-costing ability as a *drain rate* --
 *     cost over its own cooldown -- because an ability costing 3 every 2s is a
 *     harder economy than one costing 8 every 15s and the authored numbers say
 *     the opposite.
 *  2. **The bars.** Six representative loadouts with their theoretical ceiling,
 *     so that "maximum legal drain" is a measured property of the content table
 *     rather than a worst case somebody chose.
 *  3. **Sustained casting against a durable target.** The core sheet, and
 *     deliberately no-kill: it isolates capacity, regeneration and efficiency
 *     from every on-kill source, which is the only way to know what the *global*
 *     economy is.
 *  4. **Kill-rich.** The same builds against a stream of dying bodies, which is
 *     where Strength's Brutal Reserve and Perception's Resource Sense live. Run
 *     separately rather than folded in, because a build whose sustain comes
 *     entirely from killing trash is a different design object from one that
 *     regenerates.
 *  5. **Recovery from zero.** Time to the cheapest cast, to a medium one, to
 *     half a pool and to a full one -- the numbers that decide whether running
 *     out is a decision or a punishment.
 *  6. **Sensitivity.** The candidate curves either side of the shipped one, so a
 *     retune is a comparison rather than a guess.
 *
 * The classification in sheet 3 is the output worth reading. A build is
 * `DRAINS` (goes to zero and stays there), `OSCILLATES` (spends into the low
 * pool and climbs back out), `STABLE` (settles at an equilibrium above zero) or
 * `FULL` (never meaningfully spends what it has) -- and both extremes are
 * failures.
 *
 * Nothing here is part of a build. It exists to be run and read.
 *
 *   npx tsx scripts/probe-resource.ts             # all sheets
 *   npx tsx scripts/probe-resource.ts --seconds=180
 *   npx tsx scripts/probe-resource.ts --sheet=fight
 */

import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { ATTRIBUTE_KEYS } from '../src/server/data/attributes.js';
import {
  ALL_ABILITIES,
  abilityById,
  type AbilityDefinition,
} from '../src/server/data/abilities.js';
import { ITEMS } from '../src/server/data/items.js';
import { monsterById } from '../src/server/data/monsters.js';
import { SCALING, softCap } from '../src/server/data/scaling.js';
import {
  computeEffectiveStats,
  RESOURCE_REGEN_PER_SECOND,
} from '../src/server/player/stats.js';
import { STARTER_EQUIPMENT } from '../src/server/player/player-manager.js';
import { attackTimingFor, resourceCostFor } from '../src/server/sim/abilities.js';
import {
  NO_STATUSES,
  StatusId,
  applyStatus,
  masteryKey,
  type Statuses,
} from '../src/server/sim/statuses.js';
import { regenerated } from '../src/server/sim/resource.js';
import {
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from '../src/server/sim/types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import {
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type Equipment,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { DEFAULT_WORLD } from '../src/sim/collision.js';

const CHUNK = 100;
const ORIGIN = { x: 600, y: 450 };

/** The balance harness's own world: flat, zoned, and with nothing else in it. */
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

const arg = (name: string, fallback: number): number => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = found ? Number(found.slice(name.length + 3)) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const SECONDS = arg('seconds', 150);
const TICKS = Math.round(SECONDS * SERVER_TICK_RATE);
const ONLY_SHEET = process.argv.find((a) => a.startsWith('--sheet='))?.slice(8) ?? '';
const wants = (sheet: string): boolean => ONLY_SHEET === '' || ONLY_SHEET === sheet;

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}
function rpad(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}
function num(value: number, places = 1): string {
  return Number.isFinite(value) ? value.toFixed(places) : '-';
}

// ---------------------------------------------------------------------------
// Builds and bars

interface Build {
  readonly name: string;
  readonly attributes: Partial<Record<(typeof ATTRIBUTE_KEYS)[number], number>>;
  readonly tiers?: readonly SpecializationAllocation[];
  /** What this row is here to answer. Printed beside it. */
  readonly premise: string;
}

const tier = (id: string, t: number): SpecializationAllocation => ({ specializationId: id, tier: t });

/**
 * The representative builds (spec 276's task list, section 36).
 *
 * Attribute values are *reachable*: a level-20 character holds 82 points, so a
 * single attribute at 40 plus a second at 25 is affordable and 60/60 is not.
 * The two-attribute rows are therefore deliberately short of the hard cap --
 * measuring a build nobody can make is the failure `fullSpreadOf` records.
 */
const BUILDS: readonly Build[] = [
  { name: 'baseline', attributes: {}, premise: 'nothing spent: the floor of the economy' },
  { name: 'INT 25', attributes: { intelligence: 25 }, premise: 'a moderate magazine' },
  { name: 'INT 40', attributes: { intelligence: 40 }, premise: 'a large magazine, no reload' },
  { name: 'INT 60', attributes: { intelligence: 60 }, premise: 'the largest magazine legal' },
  { name: 'WIS 15', attributes: { wisdom: 15 }, premise: 'low investment' },
  { name: 'WIS 25', attributes: { wisdom: 25 }, premise: 'moderate investment' },
  { name: 'WIS 40', attributes: { wisdom: 40 }, premise: 'high investment, no specialization' },
  { name: 'WIS 60', attributes: { wisdom: 60 }, premise: 'the deepest reload legal' },
  {
    name: 'WIS 40 +Cons',
    attributes: { wisdom: 40 },
    tiers: [tier('wis.conservation', 3)],
    premise: 'Conservation and Attuned: conditional efficiency',
  },
  {
    name: 'WIS 40 +CD',
    attributes: { wisdom: 40 },
    tiers: [tier('wis.composure', 3), tier('wis.mastery', 3)],
    premise: 'Composure + Mastery: cooldowns as resource demand',
  },
  {
    name: 'WIS 40 +all',
    attributes: { wisdom: 40 },
    tiers: [tier('wis.conservation', 3), tier('wis.composure', 3), tier('wis.mastery', 3)],
    premise: 'the whole sustain tree',
  },
  { name: 'INT 30/WIS 30', attributes: { intelligence: 30, wisdom: 30 }, premise: 'the hybrid' },
  {
    name: 'INT 30/WIS 30 +all',
    attributes: { intelligence: 30, wisdom: 30 },
    tiers: [tier('wis.conservation', 3), tier('wis.composure', 3), tier('wis.mastery', 3)],
    premise: 'the extreme sustained caster',
  },
  {
    name: 'STR 40 +reserve',
    attributes: { strength: 40 },
    tiers: [tier('str.overkill', 3)],
    premise: 'Brutal Reserve: violence as fuel',
  },
  {
    name: 'PER 40 +sense',
    attributes: { perception: 40 },
    tiers: [tier('per.resourceSense', 1), tier('per.weakPointStudy', 3)],
    premise: 'Resource Sense: precision as fuel',
  },
  {
    name: 'AGI 40/WIS 20',
    attributes: { agility: 40, wisdom: 20 },
    tiers: [tier('agi.mobileOffense', 3)],
    premise: 'cooldown access against a small reload',
  },
];

const sigilFor = (abilityId: string): string => `sigil.${abilityId.slice('skill.'.length)}`;

/** Every sigil in the table, by the ability it grants. */
const SIGIL_BY_ABILITY = new Map<string, string>(
  [...ITEMS.values()]
    .filter((item) => item.slot === 'skill' && item.activeSkillId !== undefined)
    .map((item) => [item.activeSkillId as string, item.id]),
);

interface Bar {
  readonly name: string;
  readonly abilities: readonly string[];
  readonly premise: string;
}

/**
 * Six loadouts, and the last of them is *derived* rather than chosen.
 *
 * A tuning pass against one hand-picked worst case is a tuning pass against
 * whoever picked it, so `maxDrain` is the four equippable abilities with the
 * highest cost-per-cooldown in the content table -- which makes the ceiling a
 * property of `data/abilities.ts` and moves with it.
 */
const BARS: readonly Bar[] = [
  {
    name: 'spam',
    abilities: ['skill.poisonDart', 'skill.rendingCut', 'skill.guardBreak', 'skill.cripplingStrike'],
    premise: 'cheap, short cooldowns',
  },
  {
    name: 'mixed',
    abilities: ['skill.rendingCut', 'skill.cripplingStrike', 'skill.emberToss', 'skill.stunningBlow'],
    premise: 'a representative damage/control mix',
  },
  {
    name: 'burst',
    abilities: ['skill.whirlwind', 'skill.scorchedEarth', 'skill.stunningBlow', 'skill.blight'],
    premise: 'expensive, impactful, slow',
  },
  {
    name: 'artillery',
    abilities: ['skill.emberToss', 'skill.acidSpray', 'skill.arcLash', 'skill.scorchedEarth'],
    premise: 'shaped INT abilities: the premium should be felt',
  },
  {
    name: 'support',
    abilities: ['skill.conjureLight', 'skill.rimeTouch', 'skill.cripplingStrike', 'skill.guardBreak'],
    premise: 'utility and control, the Wisdom case',
  },
  { name: 'maxDrain', abilities: [], premise: 'the greediest legal bar, derived from the table' },
];

/** The four equippable abilities with the highest authored cost/cooldown. */
function greediestBar(): readonly string[] {
  const stats = statsOf(BUILDS[0] as Build);
  const body = { stats, statuses: NO_STATUSES };
  return [...ALL_ABILITIES]
    .filter((a) => a.cost > 0 && a.skill === true && SIGIL_BY_ABILITY.has(a.id))
    .map((a) => ({ id: a.id, drain: resourceCostFor(a, body, 0) / cycleSeconds(a, body) }))
    .sort((x, y) => y.drain - x.drain || (x.id < y.id ? -1 : 1))
    .slice(0, 4)
    .map((row) => row.id);
}

function barAbilities(bar: Bar): readonly string[] {
  return bar.abilities.length > 0 ? bar.abilities : greediestBar();
}

// ---------------------------------------------------------------------------
// Records

function recordFor(build: Build, bar: Bar): PersistedPlayer {
  const baseStats = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [key, build.attributes[key] ?? SCALING.startingAttribute]),
  ) as unknown as BaseStats;
  const ids = barAbilities(bar);
  const equipment: Equipment = {
    ...STARTER_EQUIPMENT,
    skill1: SIGIL_BY_ABILITY.get(ids[0] ?? '') ?? sigilFor(ids[0] ?? ''),
    skill2: SIGIL_BY_ABILITY.get(ids[1] ?? '') ?? sigilFor(ids[1] ?? ''),
    skill3: SIGIL_BY_ABILITY.get(ids[2] ?? '') ?? sigilFor(ids[2] ?? ''),
    skill4: SIGIL_BY_ABILITY.get(ids[3] ?? '') ?? sigilFor(ids[3] ?? ''),
  };
  return {
    id: `res-${build.name}`,
    displayName: build.name,
    baseStats,
    specializations: [...(build.tiers ?? [])],
    equipment,
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
}

function statsOf(build: Build, bar: Bar = BARS[1] as Bar): EffectiveStats {
  return computeEffectiveStats(recordFor(build, bar));
}

// ---------------------------------------------------------------------------
// Sheet 1: the static economy

function sheetStatic(): void {
  console.log('=== 1. the static economy ==========================================\n');
  console.log(
    `${pad('build', 20)} ${rpad('pool', 6)} ${rpad('regen/s', 8)} ${rpad('cost x', 7)} ` +
      `${rpad('cd x', 6)} ${rpad('attuned', 8)} ${rpad('mastery', 8)}  premise`,
  );
  for (const build of BUILDS) {
    const s = statsOf(build);
    const t = s.traits;
    console.log(
      `${pad(build.name, 20)} ${rpad(num(s.maxResource, 0), 6)} ` +
        `${rpad(num(s.resourceRegen * SERVER_TICK_RATE, 2), 8)} ` +
        `${rpad(num(t.resourceCostScale, 3), 7)} ${rpad(num(t.cooldownScale, 3), 6)} ` +
        `${rpad(t.attunedCostPct > 0 ? `${num(t.attunedCostPct * 100, 0)}%x${String(t.attunedMaxStacks)}` : '-', 8)} ` +
        `${rpad(t.masteryCooldownPct > 0 ? `${num(t.masteryCooldownPct * 100, 0)}%x${String(t.masteryMaxStacks)}` : '-', 8)}` +
        `  ${build.premise}`,
    );
  }

  console.log('\n--- every resource-costing ability, as a drain rate ---\n');
  const base = statsOf(BUILDS[0] as Build);
  const body = { stats: base, statuses: NO_STATUSES };
  const rows = ALL_ABILITIES.filter((a) => a.cost > 0)
    .map((a) => {
      const timing = attackTimingFor(a, body, 0);
      const cd = timing.intervalTicks / SERVER_TICK_RATE;
      const commit = (timing.attackPointTicks + timing.backswingTicks) / SERVER_TICK_RATE;
      return {
        id: a.id,
        equippable: SIGIL_BY_ABILITY.has(a.id),
        cost: resourceCostFor(a, body, 0),
        cd,
        commit,
        drain: resourceCostFor(a, body, 0) / cd,
        duty: commit / cd,
      };
    })
    .sort((x, y) => y.drain - x.drain);
  console.log(
    `${pad('ability', 24)} ${rpad('own?', 5)} ${rpad('cost', 6)} ${rpad('cd(s)', 7)} ` +
      `${rpad('commit', 7)} ${rpad('drain/s', 8)} ${rpad('duty%', 6)}`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.id, 24)} ${rpad(r.equippable ? 'yes' : '-', 5)} ${rpad(num(r.cost, 1), 6)} ` +
        `${rpad(num(r.cd, 2), 7)} ${rpad(num(r.commit, 2), 7)} ${rpad(num(r.drain, 3), 8)} ` +
        `${rpad(num(r.duty * 100, 0), 6)}`,
    );
  }
  console.log(
    '\n  duty% is what fraction of the cooldown the body is rooted for. A bar whose\n' +
      '  duty cycles sum past 100% cannot reach its own theoretical drain.',
  );
}

// ---------------------------------------------------------------------------
// Sheet 2: the bars

/**
 * Theoretical ceiling: every ability re-cast the instant it comes back.
 *
 * The denominator is **wind-up plus cooldown**, not the cooldown alone, and
 * that is not a detail: `advanceCast` stamps `nextReadyTick` at the *release*
 * (`sim/abilities.ts`), so the clock does not start until the blow lands. A
 * ceiling computed off `intervalTicks` alone over-states every row in the table
 * by its own wind-up -- 12% on the greediest bar -- which is exactly the sort of
 * headroom a tuning pass would then spend.
 */
function cycleSeconds(a: AbilityDefinition, body: { stats: EffectiveStats; statuses: Statuses }): number {
  const timing = attackTimingFor(a, body, 0);
  return (timing.attackPointTicks + timing.intervalTicks) / SERVER_TICK_RATE;
}

function theoreticalDrain(stats: EffectiveStats, ids: readonly string[], attuned: number, mastery: number): number {
  let total = 0;
  for (const id of ids) {
    const a = abilityById(id);
    if (!a) continue;
    const body = { stats, statuses: stackedStatuses(stats, id, attuned, mastery) };
    total += resourceCostFor(a, body, 0) / cycleSeconds(a, body);
  }
  return total;
}

/** A statuses map holding `attuned` Attuned stacks and `mastery` of one ability's. */
function stackedStatuses(
  stats: EffectiveStats,
  abilityId: string,
  attuned: number,
  mastery: number,
): Statuses {
  let statuses: Statuses = NO_STATUSES;
  const HELD = 1_000_000;
  if (attuned > 0 && stats.traits.attunedCostPct > 0) {
    for (let i = 0; i < Math.min(attuned, stats.traits.attunedMaxStacks); i++) {
      statuses = applyStatus(statuses, StatusId.Attuned, 0, HELD, {
        maxStacks: stats.traits.attunedMaxStacks,
      });
    }
  }
  if (mastery > 0 && stats.traits.masteryCooldownPct > 0) {
    for (let i = 0; i < Math.min(mastery, stats.traits.masteryMaxStacks); i++) {
      statuses = applyStatus(statuses, masteryKey(abilityId), 0, HELD, {
        maxStacks: stats.traits.masteryMaxStacks,
      });
    }
  }
  return statuses;
}

function sheetBars(): void {
  console.log('\n=== 2. the bars ====================================================\n');
  const base = statsOf(BUILDS[0] as Build);
  console.log(`${pad('bar', 12)} ${rpad('drain/s', 8)} ${rpad('duty%', 6)}  abilities`);
  for (const bar of BARS) {
    const ids = barAbilities(bar);
    const drain = theoreticalDrain(base, ids, 0, 0);
    let duty = 0;
    for (const id of ids) {
      const a = abilityById(id);
      if (!a) continue;
      const t = attackTimingFor(a, { stats: base, statuses: NO_STATUSES }, 0);
      duty += (t.attackPointTicks + t.backswingTicks) / t.intervalTicks;
    }
    console.log(
      `${pad(bar.name, 12)} ${rpad(num(drain, 2), 8)} ${rpad(num(duty * 100, 0), 6)}  ` +
        `${ids.map((i) => i.replace('skill.', '')).join(', ')}`,
    );
    console.log(`${pad('', 12)} ${pad('', 15)}  ${bar.premise}`);
  }
}

// ---------------------------------------------------------------------------
// The fight

type Verdict = 'FULL' | 'STABLE' | 'OSCILLATES' | 'DRAINS' | 'EMPTY';

interface Run {
  readonly maxResource: number;
  readonly regenPerSecond: number;
  readonly theoretical: number;
  readonly spent: number;
  readonly passive: number;
  readonly weakPoint: number;
  readonly overkill: number;
  readonly other: number;
  readonly minResource: number;
  readonly endResource: number;
  readonly firstEmptyAt: number;
  readonly ticksAtZero: number;
  readonly ticksStarved: number;
  readonly ticksUnaffordable: number;
  readonly ticksFull: number;
  readonly meanFraction: number;
  readonly casts: number;
  readonly skillCasts: number;
  readonly blockedByCost: number;
  readonly overdraws: number;
  readonly overdrawHealth: number;
  readonly basicAttacks: number;
  readonly damage: number;
  readonly kills: number;
  readonly ticks: number;
  readonly verdict: Verdict;
}

/**
 * How hard the body presses.
 *
 * `greedy` is the ceiling and is what every sheet defaults to: press the most
 * expensive thing that is ready, always. `paced` is the control the design's own
 * question needs -- *a conservative player should be capable of pacing
 * expenditure* -- and is the cheapest honest expression of it: hold anything
 * that would take the pool below a reserve, and fall back to the weapon.
 *
 * Two policies rather than a smarter one, because the pair brackets the answer.
 * A build that starves under both has an economy problem; one that starves only
 * under `greedy` has a *decision*, which is the thing this whole spec is for.
 */
type Policy = 'greedy' | 'paced';

/** What a pacing body keeps in reserve, as a fraction of its own pool. */
const PACED_RESERVE = 0.5;

interface Scenario {
  /** How many opponents to keep alive. */
  readonly foes: number;
  /** A durable target never dies, so no on-kill source can fire. */
  readonly durable: boolean;
  readonly policy?: Policy;
}

const DURABLE: Scenario = { foes: 1, durable: true };
const PACED: Scenario = { foes: 1, durable: true, policy: 'paced' };
const STREAM: Scenario = { foes: 3, durable: false };

/**
 * The greedy policy: the highest-drain ability that is ready and affordable.
 *
 * Highest **drain** rather than highest damage, which is the one place this
 * differs from `balance-builds.ts`'s `bestReady` and the reason it does: that
 * harness is measuring damage and picks the heaviest thing; this one is
 * measuring the economy and has to press the most expensive thing, or a build
 * would look sustainable because the policy was thrifty on its behalf.
 */
function greedyChoice(
  self: ServerEntity,
  ids: readonly string[],
  tick: number,
  policy: Policy,
): { cast: string | null; readyUnaffordable: boolean } {
  const body = { stats: self.stats, statuses: self.statuses };
  const reserve = policy === 'paced' ? self.stats.maxResource * PACED_RESERVE : 0;
  let best: { id: string; drain: number } | null = null;
  let readyUnaffordable = false;
  for (const id of ids) {
    const a = abilityById(id);
    if (!a) continue;
    if (tick < (self.cooldowns[id] ?? 0)) continue;
    const cost = resourceCostFor(a, body, tick);
    const cd = cycleSeconds(a, body);
    // A pacing body holds anything that would spend into its reserve. It is not
    // *unable* to pay, so this is deliberately not counted as unaffordable.
    if (policy === 'paced' && self.resource - cost < reserve) continue;
    if (self.resource + 1e-9 < cost) {
      // Off cooldown and unpayable. Overdraw is still a legal answer, so this is
      // only *unaffordable* for a body that cannot force the cast.
      if (self.stats.traits.overflowHealthPerResource <= 0) readyUnaffordable = true;
      else if (best === null || cost / cd > best.drain) best = { id, drain: cost / cd };
      continue;
    }
    if (best === null || cost / cd > best.drain) best = { id, drain: cost / cd };
  }
  return { cast: best?.id ?? null, readyUnaffordable };
}

function fight(build: Build, bar: Bar, scenario: Scenario, ticks = TICKS): Run {
  const record = recordFor(build, bar);
  const stats = computeEffectiveStats(record);
  const ids = barAbilities(bar);
  const monster = monsterById(scenario.durable ? 'dummy' : 'ravager');
  if (!monster) throw new Error('no monster');

  let state: ServerWorldState = createWorldState(1);
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

  const foeIds: number[] = [];
  /** Each live foe's health at the top of this tick, for the overkill test. */
  const foeHealth = new Map<number, number>();
  const spawnFoe = (slot: number): void => {
    const angle = (slot / Math.max(1, scenario.foes)) * Math.PI * 2;
    const health = scenario.durable ? 1_000_000_000 : monster.stats.maxHealth;
    const next = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: monster.id,
      position: { x: ORIGIN.x + Math.cos(angle) * 60, y: ORIGIN.y + Math.sin(angle) * 60, z: 0 },
      stats: { ...monster.stats, maxHealth: health },
      radius: monster.radius,
      zoneId: 'greenmarch',
      targetId: selfId,
    });
    state = next.state;
    foeIds[slot] = next.entity.id;
    state = replaceEntity(state, {
      ...next.entity,
      health,
      spawnerId: `probe-${String(next.entity.id)}`,
    });
  };

  const regenPerTick = stats.resourceRegen;
  let spent = 0;
  let passive = 0;
  let weakPointGain = 0;
  let overkillGain = 0;
  let other = 0;
  let minResource = stats.maxResource;
  let firstEmptyAt = -1;
  let ticksAtZero = 0;
  let ticksStarved = 0;
  let ticksUnaffordable = 0;
  let ticksFull = 0;
  let poolSum = 0;
  let casts = 0;
  let skillCasts = 0;
  let blockedByCost = 0;
  let overdraws = 0;
  let overdrawHealth = 0;
  let basicAttacks = 0;
  let damage = 0;
  let kills = 0;
  let seq = 0;
  let ran = ticks;

  const cheapest = Math.min(
    ...ids.map((id) => {
      const a = abilityById(id);
      return a ? a.cost * stats.traits.resourceCostScale : Infinity;
    }),
  );

  for (let tick = 1; tick <= ticks; tick++) {
    const self = state.entities.get(selfId);
    if (!self) {
      ran = tick;
      break;
    }
    // The probe's subject must not die -- a body that fell over stops spending,
    // which reads as a sustainable economy. Health is restored every tick, and
    // that is the one thing here that is not the real sim: what is being
    // measured is the resource loop, not survival.
    if (self.health < stats.maxHealth) state = replaceEntity(state, { ...self, health: stats.maxHealth });
    const live = state.entities.get(selfId) as ServerEntity;

    for (let slot = 0; slot < scenario.foes; slot++) {
      const held = foeIds[slot];
      const body = held === undefined ? undefined : state.entities.get(held);
      if (body && body.health > 0) continue;
      if (held !== undefined) kills += 1;
      spawnFoe(slot);
    }
    const target = foeIds[0] === undefined ? undefined : state.entities.get(foeIds[0]);
    foeHealth.clear();
    for (const id of foeIds) {
      const body = id === undefined ? undefined : state.entities.get(id);
      if (body) foeHealth.set(body.id, body.health);
    }

    const free = live.cast === null && live.activity !== 3; /* not stunned */
    const choice = free
      ? greedyChoice(live, ids, state.tick, scenario.policy ?? 'greedy')
      : { cast: null, readyUnaffordable: false };
    // Nothing on the bar is castable -- the basic attack is the zero-resource
    // fallback, and whether it stays usable is one of the design's own rules.
    const castId = choice.cast ?? (free ? stats.basicAttackId : '');
    if (free && choice.readyUnaffordable && choice.cast === null) ticksUnaffordable += 1;
    if (free && choice.cast === null) blockedByCost += 1;

    const wantedAbility = castId === '' ? null : abilityById(castId);
    const priceIfCast =
      wantedAbility === null
        ? 0
        : resourceCostFor(wantedAbility, { stats: live.stats, statuses: live.statuses }, state.tick);

    seq += 1;
    const input: ServerInput = {
      entityId: selfId,
      seq,
      moveX: 0,
      moveY: 0,
      facing: 0,
      buttons: 0,
      predictedX: live.position.x,
      predictedY: live.position.y,
      hasPrediction: false,
      seqSpan: 1,
      castAbilityId: castId,
      castTargetX: target?.position.x ?? ORIGIN.x + 40,
      castTargetY: target?.position.y ?? ORIGIN.y,
      castTargetEntityId: target?.id ?? 0,
      cancelCast: false,
    };

    const before = live;
    const result = step(state, [input], CONTEXT);
    state = result.state;
    const after = state.entities.get(selfId);
    if (!after) {
      ran = tick;
      break;
    }

    // --- decompose the tick's resource movement -----------------------------
    const started = before.cast === null && after.cast !== null;
    const paid = started ? priceIfCast : 0;
    if (started) {
      casts += 1;
      if (wantedAbility?.basicAttack === true) basicAttacks += 1;
      else skillCasts += 1;
      if (before.resource + 1e-9 < paid) {
        overdraws += 1;
        overdrawHealth += Math.max(0, before.health - after.health);
      }
    }
    spent += Math.min(paid, before.resource);
    const afterSpend = Math.max(0, before.resource - paid);
    const regenGain = regenerated(afterSpend, regenPerTick, stats.maxResource, 1) - afterSpend;
    passive += regenGain;
    const residual = after.resource - (afterSpend + regenGain);

    // Restoration, split by source rather than folded into one number -- which
    // is the whole of why this probe exists beside `foldResource`, whose
    // `resourceRestored` is every direction at once. A player should be able to
    // understand where resource came from, and so should a balance pass.
    //
    // Two of the three sources can be named from the tick's own events. What is
    // left in `other` is the restoration meter's Focus motes and Wisdom's
    // Conversion, which raise the pool from outside `resolveBlow` entirely.
    let weakPointsThisTick = 0;
    let overkillsThisTick = 0;
    for (const event of result.events as readonly ServerSimEvent[]) {
      if (event.kind !== 'hit') continue;
      if (event.attackerId !== selfId) continue;
      damage += Math.max(0, event.damage);
      if (event.weakPoint) weakPointsThisTick += 1;
      // `blow.ts` calls it an overkill when the blow was at least
      // `overkillFraction` more than the body had left. It cannot be
      // reconstructed from the event alone -- `targetHealth` is clamped at zero,
      // so `targetHealth + damage` is exactly `damage` on any killing blow and
      // the comparison is `d >= d * 1.25`, which is never true. Read off the
      // foe's health at the top of this tick instead, which is the quantity
      // `blow.ts` actually compares against.
      const had = foeHealth.get(event.targetId);
      if (event.killed && had !== undefined && event.damage >= had * (1 + SCALING.combat.overkillFraction)) {
        overkillsThisTick += 1;
      }
    }
    let unattributed = Math.max(0, residual);
    const fromWeakPoints = Math.min(unattributed, weakPointsThisTick * stats.traits.weakPointResource);
    weakPointGain += fromWeakPoints;
    unattributed -= fromWeakPoints;
    const fromOverkill = Math.min(unattributed, overkillsThisTick * stats.traits.overkillResource);
    overkillGain += fromOverkill;
    other += unattributed - fromOverkill;

    // --- the shape of the pool ----------------------------------------------
    if (after.resource < minResource) minResource = after.resource;
    if (after.resource <= 1e-6) {
      ticksAtZero += 1;
      if (firstEmptyAt < 0) firstEmptyAt = tick;
    }
    if (after.resource + 1e-9 < cheapest) ticksStarved += 1;
    if (after.resource >= stats.maxResource * 0.9) ticksFull += 1;
    poolSum += stats.maxResource > 0 ? after.resource / stats.maxResource : 0;
  }

  const seconds = ran / SERVER_TICK_RATE;
  const end = state.entities.get(selfId)?.resource ?? 0;
  // The classification, and the two thresholds that make it worth printing.
  //
  // `FULL` is read off how much time the pool spends in its top tenth rather
  // than off the minimum: a body that dips to 80% once in three minutes and
  // sits at the ceiling either side of it is a body for which resource does not
  // exist, and a minimum-based rule would call that `OSCILLATES`.
  //
  // `EMPTY` is read off starvation rather than off zero, because the pool
  // stopping just short of zero and staying there -- unable to pay for anything
  // on the bar -- is the same experience with a friendlier number on it.
  const fullFraction = ticksFull / ran;
  const starvedFraction = ticksStarved / ran;
  const verdict: Verdict =
    fullFraction > 0.85
      ? 'FULL'
      : starvedFraction > 0.85
        ? 'EMPTY'
        : starvedFraction > 0.3
          ? 'DRAINS'
          : minResource < stats.maxResource * 0.35
            ? 'OSCILLATES'
            : 'STABLE';

  return {
    maxResource: stats.maxResource,
    regenPerSecond: regenPerTick * SERVER_TICK_RATE,
    theoretical: theoreticalDrain(stats, ids, stats.traits.attunedMaxStacks, stats.traits.masteryMaxStacks),
    spent: spent / seconds,
    passive: passive / seconds,
    weakPoint: weakPointGain / seconds,
    overkill: overkillGain / seconds,
    other: other / seconds,
    minResource,
    endResource: end,
    firstEmptyAt: firstEmptyAt < 0 ? -1 : firstEmptyAt / SERVER_TICK_RATE,
    ticksAtZero,
    ticksStarved,
    ticksUnaffordable,
    ticksFull,
    meanFraction: poolSum / ran,
    casts,
    skillCasts,
    blockedByCost,
    overdraws,
    overdrawHealth,
    basicAttacks,
    damage,
    kills,
    ticks: ran,
    verdict,
  };
}

function fightHeader(): string {
  return (
    `${pad('build', 20)} ${rpad('pool', 5)} ${rpad('regen', 6)} ${rpad('theo', 6)} ${rpad('spend', 6)} ` +
    `${rpad('regen', 6)} ${rpad('wkpt', 5)} ${rpad('kill', 5)} ${rpad('mote', 5)} ${rpad('net', 6)} ` +
    `${rpad('min', 5)} ` +
    `${rpad('empty', 6)} ${rpad('mean%', 6)} ${rpad('full%', 6)} ${rpad('starv%', 6)} ${rpad('rdy!$', 5)} ` +
    `${rpad('skill', 6)} ${rpad('s/min', 6)} ${rpad('basic', 6)} ${rpad('ovr', 4)} ${rpad('ovrHP/s', 7)}  verdict`
  );
}

function fightRow(name: string, r: Run): string {
  const net = r.passive + r.weakPoint + r.overkill + r.other - r.spent;
  return (
    `${pad(name, 20)} ${rpad(num(r.maxResource, 0), 5)} ${rpad(num(r.regenPerSecond, 2), 6)} ` +
    `${rpad(num(r.theoretical, 2), 6)} ${rpad(num(r.spent, 2), 6)} ${rpad(num(r.passive, 2), 6)} ` +
    `${rpad(num(r.weakPoint, 2), 5)} ${rpad(num(r.overkill, 2), 5)} ${rpad(num(r.other, 2), 5)} ` +
    `${rpad(num(net, 2), 6)} ` +
    `${rpad(num(r.minResource, 0), 5)} ${rpad(r.firstEmptyAt < 0 ? '-' : num(r.firstEmptyAt, 0), 6)} ` +
    `${rpad(num(r.meanFraction * 100, 0), 6)} ${rpad(num((r.ticksFull / r.ticks) * 100, 0), 6)} ` +
    `${rpad(num((r.ticksStarved / r.ticks) * 100, 0), 6)} ` +
    `${rpad(num((r.ticksUnaffordable / r.ticks) * 100, 0), 5)} ${rpad(String(r.skillCasts), 6)} ` +
    `${rpad(num((r.skillCasts / r.ticks) * SERVER_TICK_RATE * 60, 0), 6)} ${rpad(String(r.basicAttacks), 6)} ` +
    `${rpad(String(r.overdraws), 4)} ` +
    `${rpad(r.overdraws > 0 ? num((r.overdrawHealth / r.ticks) * SERVER_TICK_RATE, 2) : '-', 7)}  ${r.verdict}`
  );
}

function sheetFight(scenario: Scenario, title: string, bars: readonly Bar[]): void {
  console.log(`\n=== ${title} (${String(SECONDS)}s) ====================\n`);
  console.log(
    '  theo = theoretical drain/s at full stacks. Every other rate is measured.\n' +
      '  Restoration is split by source: wkpt = Resource Sense, kill = Brutal Reserve,\n' +
      '  mote = the restoration meter and Wisdom Conversion.\n' +
      '  rdy!$ = % of free ticks with an ability off cooldown and unpayable.\n',
  );
  for (const bar of bars) {
    console.log(`--- bar: ${bar.name} (${bar.premise}) ---`);
    console.log(fightHeader());
    for (const build of BUILDS) {
      console.log(fightRow(build.name, fight(build, bar, scenario)));
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Sheet 5: recovery from zero

function sheetRecovery(): void {
  console.log('\n=== 5. recovery from zero ==========================================\n');
  const cheap = abilityById('skill.poisonDart');
  const medium = abilityById('skill.emberToss');
  const heavy = abilityById('skill.whirlwind');
  console.log(
    `${pad('build', 20)} ${rpad('pool', 5)} ${rpad('regen', 6)} ${rpad('->dart', 7)} ` +
      `${rpad('->ember', 8)} ${rpad('->whirl', 8)} ${rpad('->50%', 7)} ${rpad('->full', 7)}`,
  );
  for (const build of BUILDS) {
    const s = statsOf(build);
    const body = { stats: s, statuses: NO_STATUSES };
    const perSecond = s.resourceRegen * SERVER_TICK_RATE;
    const to = (cost: number): string => (perSecond > 0 ? num(cost / perSecond, 1) : 'never');
    console.log(
      `${pad(build.name, 20)} ${rpad(num(s.maxResource, 0), 5)} ${rpad(num(perSecond, 2), 6)} ` +
        `${rpad(cheap ? to(resourceCostFor(cheap, body, 0)) : '-', 7)} ` +
        `${rpad(medium ? to(resourceCostFor(medium, body, 0)) : '-', 8)} ` +
        `${rpad(heavy ? to(resourceCostFor(heavy, body, 0)) : '-', 8)} ` +
        `${rpad(to(s.maxResource / 2), 7)} ${rpad(to(s.maxResource), 7)}`,
    );
  }
  console.log(
    '\n  Seconds from an empty pool. INT should be slower to full and no slower to\n' +
      '  a first cast; WIS should be faster at both.',
  );
}

// ---------------------------------------------------------------------------
// Sheet 6: sensitivity

/**
 * Candidate regeneration curves against the *measured* demand.
 *
 * The supply side is arithmetic -- a curve is four numbers -- and the demand
 * side is not: it is `maximumDrain` resolved through the real `resourceCostFor`
 * and `attackTimingFor` at each Wisdom value, so it already accounts for Wisdom
 * making its own bar cheaper and returning it sooner. That asymmetry is the
 * whole reason this sheet is worth printing: every candidate is judged against
 * the same measured ceiling rather than against a number somebody typed.
 *
 * The two failures it is looking for are the two the shipped economy had, one at
 * each end -- a floor so low the game is unplayable without Wisdom, and a
 * ceiling that passes the most the game can spend.
 */
function sheetSensitivity(): void {
  console.log('\n=== 6. sensitivity: candidate reload curves ==========================\n');
  const S = SCALING.wisdom;
  const candidates: { name: string; base: number; per: number; knee: number; falloff: number }[] = [
    { name: 'shipped before 276', base: 0.4, per: 0.2, knee: Infinity, falloff: 1 },
    { name: 'flat base only', base: 1.0, per: 0, knee: 0, falloff: 0 },
    { name: 'linear, gentler', base: 1.0, per: 0.02, knee: Infinity, falloff: 1 },
    { name: 'SHIPPED', base: RESOURCE_REGEN_PER_SECOND, per: S.regenPer, knee: S.regenKnee, falloff: S.regenFalloff },
    { name: 'higher floor', base: 1.4, per: S.regenPer, knee: S.regenKnee, falloff: S.regenFalloff },
    { name: 'steeper curve', base: RESOURCE_REGEN_PER_SECOND, per: 0.04, knee: S.regenKnee, falloff: S.regenFalloff },
    { name: 'later knee', base: RESOURCE_REGEN_PER_SECOND, per: S.regenPer, knee: 40, falloff: S.regenFalloff },
  ];
  const at = [5, 15, 25, 40, 60];
  // Demand: the greediest legal bar, resolved for a Wisdom character at each
  // value. Measured, not assumed.
  const demand = new Map<number, number>();
  for (const wisdom of at) {
    const stats = statsOf({ name: '', attributes: { wisdom }, premise: '' });
    demand.set(wisdom, theoreticalDrain(stats, greediestBar(), stats.traits.attunedMaxStacks, 0));
  }
  console.log(
    `  demand (greediest legal bar, measured): ` +
      at.map((w) => `WIS${String(w)} ${num(demand.get(w) ?? 0, 2)}`).join('  '),
  );
  console.log(
    `\n${pad('curve', 20)} ` +
      at.map((w) => rpad(`WIS${String(w)}`, 12)).join(' ') +
      '  verdict',
  );
  for (const c of candidates) {
    const cells = at.map((w) => {
      const above = Math.max(0, w - SCALING.startingAttribute);
      const wisdomTerm =
        c.knee === Infinity ? above * c.per : softCap(above, c.per, c.knee, c.falloff);
      const supply = c.base + wisdomTerm;
      const ratio = supply / (demand.get(w) ?? 1);
      return { supply, ratio };
    });
    const floor = cells[0]?.ratio ?? 0;
    const ceiling = cells[cells.length - 1]?.ratio ?? 0;
    const verdict =
      ceiling >= 1
        ? 'FAILS: supply passes the ceiling'
        : floor < 0.2
          ? 'FAILS: unplayable without Wisdom'
          : ceiling < floor * 1.8
            ? 'FAILS: Wisdom barely worth buying'
            : 'ok';
    console.log(
      `${pad(c.name, 20)} ` +
        cells.map((cell) => rpad(`${num(cell.supply, 2)} (${num(cell.ratio * 100, 0)}%)`, 12)).join(' ') +
        `  ${verdict}`,
    );
  }
  console.log(
    '\n  Each cell is regeneration/s and what fraction of that build\'s own greediest\n' +
      '  bar it pays for. Four candidates clear both hard failures, and what\n' +
      '  separates them is headroom: the shipped curve leaves the widest gap at the\n' +
      '  cap (80%) for Conservation to close, which is where the design wants the\n' +
      '  last stretch bought rather than accrued. `linear, gentler` is the nearest\n' +
      '  alternative and differs by two points anywhere a player would notice; the\n' +
      '  reason it is not the shipped one is structural rather than numeric --\n' +
      '  a soft cap cannot be made to run away by a future source of Wisdom.',
  );
}

// ---------------------------------------------------------------------------

const maxBar = BARS[BARS.length - 1] as Bar;
const mixedBar = BARS[1] as Bar;

if (wants('static')) sheetStatic();
if (wants('bars')) sheetBars();
if (wants('fight')) sheetFight(DURABLE, '3. sustained casting, durable target (no kills)', [mixedBar, maxBar]);
if (wants('kills')) sheetFight(STREAM, '4. kill-rich', [maxBar]);
if (wants('recovery')) sheetRecovery();
if (wants('sensitivity')) sheetSensitivity();
if (wants('paced')) sheetFight(PACED, '3c. the same fight, paced (half the pool held in reserve)', [maxBar]);
if (wants('all-bars')) sheetFight(DURABLE, '3b. every bar, durable target', BARS);

console.log('');
console.log(
  `  ${String(BUILDS.length)} builds x ${String(BARS.length)} bars, ${String(SECONDS)}s each.\n` +
    '  --seconds=N to change the duration, --sheet=static|bars|fight|paced|kills|recovery|sensitivity|all-bars.',
);
