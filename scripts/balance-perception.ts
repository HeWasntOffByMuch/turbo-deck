/**
 * The Perception loop, measured (spec 272).
 *
 * `balance-builds.ts` fights twelve attribute presets through the real sim and
 * prints damage, kills and posture. That is the right table for "is an
 * attribute viable" and the wrong one for this question, because Perception's
 * whole identity is a *sequence* -- observe, find the seam, expose it, exploit
 * it, sustain -- and a stationary single-target DPS number says nothing about
 * whether any of it happened.
 *
 * So this counts the loop. Every number below is read off a real `step`: the
 * weak points that landed and what threw them, the reads banked and spent and
 * what waiting for them cost, the Exposed uptime a team would actually get, the
 * Exploits that fired inside it, and what precision paid back.
 *
 *   npx tsx scripts/balance-perception.ts [--seconds=n] [--seed=n] [--monster=id]
 *
 * Four scenarios, because three of the things being measured are invisible in a
 * stationary duel:
 *
 *   duel     one durable target. The control.
 *   mobile   the same fight while repositioning -- Patient Read must survive it,
 *            which is the whole distinction from Intelligence's Prepared.
 *   pack     five bodies at once. Where an AoE reward explosion would show.
 *   team     two attackers, one of them the reader. Exposed is on the *target*,
 *            so the other one benefits with no party system anywhere.
 *   stream   ordinary monsters, replaced as they die. The only one that can
 *            measure Resource Sense's *heal*, which is gated on a weak-point
 *            **kill** -- a durable target never dies, so the other four report
 *            it as zero however well it works.
 *
 * Nothing here is part of a build. It exists to be run and read.
 */

import { DEFAULT_WORLD } from '../src/sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { abilityById, precisionOf } from '../src/server/data/abilities.js';
import { monsterById } from '../src/server/data/monsters.js';
import { SCALING } from '../src/server/data/scaling.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { hasStatus, statusOf, StatusId } from '../src/server/sim/statuses.js';
import {
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
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type Equipment,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';

function flag(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
const SECONDS = Number(flag('seconds', '120'));
const SEED = Number(flag('seed', '1'));
const MONSTER = flag('monster', 'stalker');

const CHUNK = 100;
const AT = { x: 600, y: 450 };
const WAIT = SCALING.perception.patientReadTicks;

// --- builds ----------------------------------------------------------------

interface Build {
  readonly name: string;
  readonly attributes: Partial<BaseStats>;
  readonly tiers: Readonly<Record<string, number>>;
  readonly weapon?: string;
  readonly skill?: string;
  /** Hold off attacking to bank a read, rather than swinging freely. */
  readonly patient?: boolean;
}

const ALL_PER: Record<string, number> = {
  'per.weakPointStudy': 3,
  'per.openingRead': 3,
  'per.patientRead': 3,
  'per.huntersEye': 3,
  'per.exploit': 3,
  'per.resourceSense': 1,
};

const BUILDS: readonly Build[] = [
  { name: 'raw PER', attributes: { perception: 60 }, tiers: {} },
  { name: 'Weak-Point Study', attributes: { perception: 60 }, tiers: { 'per.weakPointStudy': 3, 'per.openingRead': 3 } },
  { name: 'Patient Read', attributes: { perception: 60 }, tiers: { 'per.weakPointStudy': 3, 'per.patientRead': 3 }, patient: true },
  { name: 'Patient Read (impatient)', attributes: { perception: 60 }, tiers: { 'per.weakPointStudy': 3, 'per.patientRead': 3 } },
  { name: "Hunter's Eye", attributes: { perception: 60 }, tiers: { 'per.weakPointStudy': 3, 'per.huntersEye': 3 } },
  { name: 'Exploit', attributes: { perception: 60 }, tiers: { 'per.weakPointStudy': 3, 'per.exploit': 3 } },
  { name: 'Resource Sense', attributes: { perception: 60 }, tiers: { 'per.weakPointStudy': 3, 'per.resourceSense': 1 } },
  { name: 'full PER', attributes: { perception: 60 }, tiers: ALL_PER },
  { name: 'full PER, patient', attributes: { perception: 60 }, tiers: ALL_PER, patient: true },
  { name: 'full PER, bow', attributes: { perception: 60 }, tiers: ALL_PER, weapon: 'bow.hunting' },
  { name: 'full PER, sigil', attributes: { perception: 60 }, tiers: ALL_PER, skill: 'skill.rendingCut' },
  { name: 'STR/PER', attributes: { perception: 60, strength: 60 }, tiers: { ...ALL_PER, 'str.crushingBlows': 3 } },
  { name: 'AGI/PER', attributes: { perception: 60, agility: 60 }, tiers: { ...ALL_PER, 'agi.quickRecovery': 3 } },
  { name: 'pure STR (ref)', attributes: { strength: 60 }, tiers: { 'str.crushingBlows': 3 } },
];

function record(build: Build): PersistedPlayer {
  const equipment: Equipment = {
    ...EMPTY_EQUIPMENT,
    mainHand: build.weapon ?? 'sword.worn',
    ...(build.skill !== undefined ? { skill1: sigilFor(build.skill) } : {}),
  };
  return {
    id: build.name,
    displayName: build.name,
    baseStats: {
      strength: 5,
      agility: 5,
      intelligence: 5,
      constitution: 5,
      perception: 5,
      wisdom: 5,
      ...build.attributes,
    },
    specializations: Object.entries(build.tiers).map(
      ([specializationId, tier]): SpecializationAllocation => ({ specializationId, tier }),
    ),
    equipment,
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

function sigilFor(abilityId: string): string {
  return abilityId.replace('skill.', 'sigil.');
}

function pointsOf(build: Build): number {
  const attrs = Object.values(build.attributes).reduce((s, v) => s + (v - 5), 0);
  const tiers = Object.values(build.tiers).reduce((s, v) => s + v, 0);
  return attrs + tiers;
}

// --- the run ---------------------------------------------------------------

type Scenario = 'duel' | 'mobile' | 'pack' | 'team' | 'stream';

interface Counts {
  seconds: number;
  blows: number;
  weakPoints: number;
  wpBasic: number;
  wpAbility: number;
  casts: number;
  damage: number;
  kills: number;
  taken: number;
  vulnerableHits: number;
  exposedApplied: number;
  exposedTicks: number;
  observedTicks: number;
  exploits: number;
  readsBanked: number;
  readsSpent: number;
  readPayoff: number;
  waitingTicks: number;
  resourceGained: number;
  healthGained: number;
  maxWpInOneTick: number;
  allyBenefited: number;
  /** What Resource Sense credited, before the pool's own ceiling clamped it. */
  resourceCredited: number;
  healthCredited: number;
}

function empty(): Counts {
  return {
    seconds: 0, blows: 0, weakPoints: 0, wpBasic: 0, wpAbility: 0, casts: 0,
    damage: 0, kills: 0, taken: 0, vulnerableHits: 0, exposedApplied: 0,
    exposedTicks: 0, observedTicks: 0, exploits: 0, readsBanked: 0, readsSpent: 0,
    readPayoff: 0, waitingTicks: 0, resourceGained: 0, healthGained: 0,
    maxWpInOneTick: 0, allyBenefited: 0, resourceCredited: 0, healthCredited: 0,
  };
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

function baseInput(entityId: number, seq: number, over: Partial<ServerInput>): ServerInput {
  return {
    entityId, seq, moveX: 0, moveY: 0, facing: 0, buttons: 0,
    predictedX: 0, predictedY: 0, hasPrediction: false, seqSpan: 1,
    castAbilityId: '', castTargetX: 0, castTargetY: 0, castTargetEntityId: 0,
    cancelCast: false, ...over,
  };
}

function run(build: Build, scenario: Scenario): Counts {
  const stats = computeEffectiveStats(record(build));
  const counts = empty();
  counts.seconds = SECONDS;
  const definition = monsterById(MONSTER);
  if (!definition) throw new Error(`no ${MONSTER}`);

  let state: ServerWorldState = createWorldState(SEED);
  const me = spawnEntity(state, {
    kind: EntityKindValue.Player, typeId: 'player', ownerPlayerId: build.name,
    position: { x: AT.x, y: AT.y, z: 0 }, stats, radius: 16, zoneId: 'greenmarch',
  });
  state = me.state;
  const selfId = me.entity.id;

  // The ally, for the team scenario: a plain character with no Perception at
  // all, so any benefit it sees comes from the mark on the target.
  let allyId = 0;
  if (scenario === 'team') {
    const plain = computeEffectiveStats(record({ name: 'ally', attributes: {}, tiers: {} }));
    const ally = spawnEntity(state, {
      kind: EntityKindValue.Player, typeId: 'player', ownerPlayerId: 'ally',
      position: { x: AT.x + 40, y: AT.y + 34, z: 0 }, stats: plain, radius: 16, zoneId: 'greenmarch',
    });
    state = ally.state;
    allyId = ally.entity.id;
  }

  const foes: number[] = [];
  const wanted = scenario === 'pack' ? 5 : 1;
  // Ordinary health in `stream`, so bodies actually die and the kill-gated half
  // of Resource Sense has something to fire on.
  const durability = scenario === 'stream' ? 1 : 40;
  for (let i = 0; i < wanted; i++) {
    const angle = (i / wanted) * Math.PI * 2;
    const spawned = spawnEntity(state, {
      kind: EntityKindValue.Monster, typeId: MONSTER,
      position: { x: AT.x + 45 * Math.cos(angle) + 20, y: AT.y + 45 * Math.sin(angle), z: 0 },
      stats: { ...definition.stats, maxHealth: definition.stats.maxHealth * durability },
      radius: definition.radius, zoneId: 'greenmarch', targetId: selfId,
    });
    state = spawned.state;
    const body = state.entities.get(spawned.entity.id);
    if (body) {
      state = replaceEntity(state, {
        ...body,
        health: definition.stats.maxHealth * durability,
        spawnerId: `bench-${String(spawned.entity.id)}`,
      });
    }
    foes.push(spawned.entity.id);
  }

  const ctx = context();
  const basicId = stats.basicAttackId;
  const skillId = build.skill;
  let lastCommit = -WAIT;
  let heldRead = false;
  let seq = 0;

  for (let tick = 1; tick <= SECONDS * SERVER_TICK_RATE; tick++) {
    const self = state.entities.get(selfId);
    if (!self || self.health <= 0) break;
    let target = foes.map((id) => state.entities.get(id)).find((e) => e && e.health > 0);
    if (!target && scenario === 'stream') {
      const next = spawnEntity(state, {
        kind: EntityKindValue.Monster, typeId: MONSTER,
        position: { x: AT.x + 45, y: AT.y, z: 0 },
        stats: definition.stats, radius: definition.radius,
        zoneId: 'greenmarch', targetId: selfId,
      });
      state = next.state;
      const fresh = state.entities.get(next.entity.id);
      if (fresh) state = replaceEntity(state, { ...fresh, spawnerId: `bench-${String(next.entity.id)}` });
      foes.length = 0;
      foes.push(next.entity.id);
      target = state.entities.get(next.entity.id);
    }
    if (!target) break;

    // Patient policy: hold off until the read is banked, then swing.
    const banked = hasStatus(self.statuses, StatusId.PatientRead, tick);
    if (banked && !heldRead) counts.readsBanked += 1;
    if (build.patient === true && !banked) counts.waitingTicks += 1;
    heldRead = banked;

    const ready = build.patient !== true || banked;
    const readyToSwing = ready;
    // A sigil when it is off cooldown, the weapon otherwise.
    const wantSkill =
      skillId !== undefined && (self.cooldowns[skillId] ?? 0) <= tick && stats.skillAbilityIds.includes(skillId);
    const pressing = self.cast === null && ready ? (wantSkill ? skillId : basicId) : '';
    if (pressing !== '') counts.casts += 1;

    // What is *in flight*, so a weak point is attributed to the ability that
    // threw it rather than to whatever was pressed on the tick it landed -- a
    // blow lands ticks after the press, so the naive reading credited every
    // ability weak point to the basic attack.
    const inFlight = self.cast?.abilityId ?? pressing;
    const hpBefore = self.health;
    const resBefore = self.resource;
    seq += 1;
    const result = step(
      state,
      [
        baseInput(selfId, seq, {
          // Reposition between swings rather than during them: asking to move
          // withdraws from a wind-up (spec 079), so a body that walks every
          // tick never lands a blow -- which is what the first cut measured.
          moveX: scenario === 'mobile' && self.cast === null && !readyToSwing ? (Math.floor(tick / 90) % 2 === 0 ? 1 : -1) : 0,
          castAbilityId: pressing,
          castTargetX: target.position.x,
          castTargetY: target.position.y,
          castTargetEntityId: target.id,
        }),
        ...(allyId > 0
          ? [
              baseInput(allyId, seq, {
                castAbilityId: (state.entities.get(allyId)?.cast ?? null) === null ? 'melee.slash' : '',
                castTargetX: target.position.x,
                castTargetY: target.position.y,
                castTargetEntityId: target.id,
              }),
            ]
          : []),
      ],
      ctx,
    );
    state = result.state;

    const after = state.entities.get(selfId);
    if (after) {
      if (after.health > hpBefore) counts.healthGained += after.health - hpBefore;
      if (after.health < hpBefore) counts.taken += hpBefore - after.health;
      if (after.resource > resBefore) counts.resourceGained += after.resource - resBefore;
      // Spent: held last tick, gone now, and a weak point landed this tick.
      if (heldRead && !hasStatus(after.statuses, StatusId.PatientRead, state.tick)) {
        counts.readsSpent += 1;
      }
    }

    // Exposed uptime is measured on the body being fought.
    const live = state.entities.get(target.id);
    counts.observedTicks += 1;
    if (live && statusOf(live.statuses, StatusId.Exposed, state.tick)) counts.exposedTicks += 1;

    let wpThisTick = 0;
    for (const event of result.events) {
      if (event.kind !== 'hit') continue;
      if (event.attackerId === selfId) {
        // An affliction pulse is not a blow (spec 219's `periodic` flag). A
        // Bleed ticking twenty times would otherwise sink the weak-point rate
        // of every build carrying a damage-over-time sigil -- which is exactly
        // what the first run of this harness reported.
        if (event.periodic === true) continue;
        counts.blows += 1;
        counts.damage += event.damage;
        if (event.killed) counts.kills += 1;
        const victim = state.entities.get(event.targetId);
        const wasVulnerable = victim && hasStatus(victim.statuses, StatusId.Vulnerable, state.tick);
        if (wasVulnerable === true) counts.vulnerableHits += 1;
        if (event.weakPoint) {
          counts.weakPoints += 1;
          wpThisTick += 1;
          if (inFlight === basicId || inFlight === '') counts.wpBasic += 1;
          else counts.wpAbility += 1;
          counts.exposedApplied += 1;
          counts.resourceCredited += stats.traits.weakPointResource;
          if (event.killed) counts.healthCredited += stats.maxHealth * stats.traits.weakPointKillHeal;
          if (heldRead) counts.readPayoff += event.damage;
        }
      } else if (event.attackerId === allyId) {
        const victim = state.entities.get(event.targetId);
        if (victim && statusOf(victim.statuses, StatusId.Exposed, state.tick)) counts.allyBenefited += 1;
      }
    }
    counts.maxWpInOneTick = Math.max(counts.maxWpInOneTick, wpThisTick);
    // Exploit: a weak point on a body that was already marked when it landed.
    if (wpThisTick > 0 && live && statusOf(live.statuses, StatusId.Exposed, state.tick - 1)) {
      counts.exploits += wpThisTick;
    }
    if (after && after.lastAttackTick > lastCommit) lastCommit = after.lastAttackTick;
  }
  return counts;
}

// --- output ----------------------------------------------------------------

const pad = (t: string, w: number): string => (t.length >= w ? t.slice(0, w) : t + ' '.repeat(w - t.length));
const n1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
const pct = (a: number, b: number): string => (b > 0 ? `${n1((a / b) * 100)}%` : '-');

console.log(`\n  Perception loop, ${String(SECONDS)}s vs ${MONSTER}, seed ${String(SEED)}\n`);

console.log('  --- the loop, in a duel ---');
console.log(
  `  ${pad('BUILD', 24)} ${pad('PTS', 4)} ${pad('DPS', 6)} ${pad('WEAK%', 7)} ${pad('WP/min', 7)} ` +
    `${pad('BASIC', 6)} ${pad('ABIL', 5)} ${pad('EXPO%', 7)} ${pad('EXPL', 5)} ${pad('VULN', 5)} ` +
    `${pad('RES', 6)} ${pad('HEAL', 6)} ${pad('TAKEN', 6)}`,
);
console.log('  ' + '-'.repeat(112));
const duels = new Map<string, Counts>();
for (const build of BUILDS) {
  const c = run(build, 'duel');
  duels.set(build.name, c);
  console.log(
    `  ${pad(build.name, 24)} ${pad(String(pointsOf(build)), 4)} ${pad(n1(c.damage / c.seconds), 6)} ` +
      `${pad(pct(c.weakPoints, c.blows), 7)} ${pad(n1((c.weakPoints / c.seconds) * 60), 7)} ` +
      `${pad(String(c.wpBasic), 6)} ${pad(String(c.wpAbility), 5)} ${pad(pct(c.exposedTicks, c.observedTicks), 7)} ` +
      `${pad(String(c.exploits), 5)} ${pad(String(c.vulnerableHits), 5)} ${pad(n1(c.resourceCredited), 6)} ` +
      `${pad(n1(c.healthGained), 6)} ${pad(n1(c.taken), 6)}`,
  );
}

console.log('\n  --- Patient Read: what waiting costs and buys ---');
console.log(
  `  ${pad('BUILD', 24)} ${pad('BANKED', 7)} ${pad('SPENT', 6)} ${pad('WAIT%', 7)} ${pad('CASTS', 6)} ` +
    `${pad('WEAK%', 7)} ${pad('DPS', 6)}`,
);
console.log('  ' + '-'.repeat(70));
for (const build of BUILDS) {
  if (build.tiers['per.patientRead'] === undefined) continue;
  const c = duels.get(build.name);
  if (!c) continue;
  console.log(
    `  ${pad(build.name, 24)} ${pad(String(c.readsBanked), 7)} ${pad(String(c.readsSpent), 6)} ` +
      `${pad(pct(c.waitingTicks, c.observedTicks), 7)} ${pad(String(c.casts), 6)} ` +
      `${pad(pct(c.weakPoints, c.blows), 7)} ${pad(n1(c.damage / c.seconds), 6)}`,
  );
}

console.log('\n  --- the five scenarios (full PER; mobile runs the patient policy) ---');
console.log(
  `  ${pad('SCENARIO', 10)} ${pad('DPS', 6)} ${pad('WEAK%', 7)} ${pad('WP/CAST max', 12)} ${pad('EXPO%', 7)} ` +
    `${pad('RES', 6)} ${pad('HEAL', 6)} ${pad('ALLY-ON-EXPOSED', 16)}`,
);
console.log('  ' + '-'.repeat(76));
const full = BUILDS.find((b) => b.name === 'full PER');
const patient = BUILDS.find((b) => b.name === 'full PER, patient');
for (const scenario of ['duel', 'mobile', 'pack', 'team', 'stream'] as const) {
  const build = scenario === 'mobile' && patient ? patient : full;
  if (!build) continue;
  const c = run(build, scenario);
  console.log(
    `  ${pad(scenario, 10)} ${pad(n1(c.damage / c.seconds), 6)} ${pad(pct(c.weakPoints, c.blows), 7)} ` +
      `${pad(String(c.maxWpInOneTick), 8)} ${pad(pct(c.exposedTicks, c.observedTicks), 7)} ` +
      `${pad(n1(c.resourceCredited), 6)} ${pad(n1(c.healthCredited), 6)} ${pad(String(c.kills), 6)} ${pad(String(c.allyBenefited), 16)}`,
  );
}

console.log('\n  --- what a sigil contributes ---');
const sigil = abilityById('skill.rendingCut');
if (sigil) {
  console.log(`  ${sigil.id} precision ${String(precisionOf(sigil))}`);
  const c = duels.get('full PER, sigil');
  if (c) {
    console.log(
      `  weak points from basics ${String(c.wpBasic)}, from the sigil ${String(c.wpAbility)} ` +
        `(${pct(c.wpAbility, c.weakPoints)} of them)`,
    );
  }
}
console.log('');
