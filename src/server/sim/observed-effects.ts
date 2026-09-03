/**
 * Was this conditional progression effect ever actually *observed* to fire?
 * (spec 272)
 *
 * `audit-progression.ts` proves that a purchase **moves a trait**. That is the
 * right question and it is not the only one: Steady Aim moved `steadyAimPct`
 * from 0 to 0.36 and read `ACTIVE` in all twelve of its cells while being
 * incapable of firing at all, because the field its runtime gate read was
 * stamped by a pass running earlier in the same tick. Twelve green cells, three
 * purchasable tiers, zero effect.
 *
 * So this is the complementary pass, and the distinction is worth stating
 * plainly:
 *
 *   reachability (spec 271)   can any *content* satisfy this gate?
 *   observation  (this)       does the *simulation* ever satisfy it?
 *
 * Neither subsumes the other. Steady Aim's gate was satisfiable by content --
 * `steadyAimTicks` was a perfectly ordinary number -- and unsatisfiable by the
 * tick order. A static pass cannot see that; only running the thing can.
 *
 * **The false positive is the failure mode**, so the design answers it head on:
 * a probe carries **its own scenario**, chosen to trigger it. A conditional is
 * reported only when the fight written to make it fire did not. A rare effect
 * is never reported merely because some short generic fight happened to miss
 * it, which is the trap that would make this pass noise and get it ignored.
 *
 * Deliberately not symbolic execution and deliberately not exhaustive: a small
 * table of gated mechanics, each with a fight that ought to trigger it.
 */

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
import { monsterById } from '../data/monsters.js';
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
import { hasStatus, statusOf, StatusId } from './statuses.js';
import {
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';

const CHUNK = 100;
const AT = { x: 600, y: 450 };

/** One tick of a scenario, as the observer sees it. */
export interface Frame {
  readonly tick: number;
  readonly self: ServerEntity;
  readonly target: ServerEntity | undefined;
  readonly events: readonly ServerSimEvent[];
}

/** How a scenario drives the player each tick. */
export interface Plan {
  /** Ticks to run. */
  readonly ticks: number;
  /** The ability to press when free, or '' to press nothing. */
  readonly attackWith: string;
  /** Ticks to hold off attacking after each committed attack. 0 attacks freely. */
  readonly waitTicks?: number;
  /** Whether the body walks. */
  readonly moving?: boolean;
}

export interface ConditionalProbe {
  /** The specialization or mechanic this is about. */
  readonly id: string;
  /** One line: what has to happen for this to have fired. */
  readonly gate: string;
  /** Attributes and tiers that buy it. */
  readonly attributes: Partial<BaseStats>;
  readonly specializations: readonly SpecializationAllocation[];
  readonly equipment?: Partial<Record<'skill1' | 'mainHand', string>>;
  /**
   * What to fight. A `dummy` never attacks, which is right for most of these
   * and wrong for anything gated on the *opponent* doing something -- Opening
   * Read reads Vulnerable, and Vulnerable is applied to a body that commits an
   * attack, so against a dummy it can never open. That is the pass working
   * rather than a bug: a probe whose scenario cannot trigger it reports NOT
   * OBSERVED, and the repair is a better scenario.
   */
  readonly monster?: string;
  /** The fight written to make this fire. */
  readonly plan: Plan;
  /** Did the gate open on this frame? */
  readonly observe: (frame: Frame, selfId: number) => boolean;
}

export interface Observation {
  readonly id: string;
  readonly gate: string;
  readonly observed: boolean;
  /** How many frames the gate was open on, for a sense of how rare it is. */
  readonly count: number;
  /** Attacks the scenario actually made, so "never fired" can be told from
   *  "never attacked" -- a scenario that did nothing proves nothing. */
  readonly blows: number;
}

// ---------------------------------------------------------------------------

function record(probe: ConditionalProbe): PersistedPlayer {
  return {
    id: 'probe',
    displayName: 'probe',
    baseStats: {
      strength: 5,
      agility: 5,
      intelligence: 5,
      constitution: 5,
      perception: 5,
      wisdom: 5,
      ...probe.attributes,
    },
    specializations: probe.specializations,
    equipment: { ...EMPTY_EQUIPMENT, ...probe.equipment },
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

function context(): StepContext {
  const keys = new Set<string>();
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      keys.add(chunkKeyOf(AT.x + dx * CHUNK, AT.y + dy * CHUNK, CHUNK));
    }
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

function input(entityId: number, seq: number, overrides: Partial<ServerInput>): ServerInput {
  return {
    entityId,
    seq,
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

/**
 * Run one probe's own scenario and report what was seen.
 *
 * The target is given an enormous health pool rather than being respawned: what
 * every probe here is about is a *condition*, and a scenario that keeps killing
 * its subject spends most of its ticks with nothing to observe.
 */
export function observeProbe(probe: ConditionalProbe, seed = 1): Observation {
  const stats: EffectiveStats = computeEffectiveStats(record(probe));
  let state: ServerWorldState = createWorldState(seed);
  const player = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'probe',
    position: { x: AT.x, y: AT.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = player.state;
  const selfId = player.entity.id;

  const typeId = probe.monster ?? 'dummy';
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no ${typeId}`);
  const monster = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x: AT.x + 40, y: AT.y, z: 0 },
    stats: { ...definition.stats, maxHealth: 1_000_000_000 },
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  state = monster.state;
  const foeId = monster.entity.id;
  const body = state.entities.get(foeId);
  if (body) state = replaceEntity(state, { ...body, health: 1_000_000_000 });

  const ctx = context();
  const wait = probe.plan.waitTicks ?? 0;
  let count = 0;
  let blows = 0;
  let lastCommit = -wait;

  for (let i = 0; i < probe.plan.ticks; i++) {
    const self = state.entities.get(selfId);
    const target = state.entities.get(foeId);
    if (!self) break;
    const free = self.cast === null;
    const rested = state.tick - lastCommit >= wait;
    const pressing = free && rested && probe.plan.attackWith !== '' && target !== undefined;
    const result = step(
      state,
      [
        input(selfId, i + 1, {
          moveX: probe.plan.moving === true ? 1 : 0,
          castAbilityId: pressing ? probe.plan.attackWith : '',
          castTargetX: target?.position.x ?? AT.x + 40,
          castTargetY: target?.position.y ?? AT.y,
          castTargetEntityId: target?.id ?? 0,
        }),
      ],
      ctx,
    );
    state = result.state;
    const after = state.entities.get(selfId);
    if (after && after.lastAttackTick > lastCommit) {
      lastCommit = after.lastAttackTick;
      blows += 1;
    }
    if (!after) break;
    const frame: Frame = {
      tick: state.tick,
      self: after,
      target: state.entities.get(foeId),
      events: result.events,
    };
    if (probe.observe(frame, selfId)) count += 1;
  }

  return { id: probe.id, gate: probe.gate, observed: count > 0, count, blows };
}

// ---------------------------------------------------------------------------
// The table. Each row is a gated mechanic and the fight written to trigger it.

const weakPointHit = (frame: Frame, selfId: number): boolean =>
  frame.events.some((e) => e.kind === 'hit' && e.attackerId === selfId && e.weakPoint);

/** Perception at the top of its tree, holding every tier the loop needs. */
const READER: Pick<ConditionalProbe, 'attributes' | 'specializations' | 'equipment'> = {
  attributes: { perception: 60 },
  specializations: [
    { specializationId: 'per.weakPointStudy', tier: 3 },
    { specializationId: 'per.openingRead', tier: 3 },
    { specializationId: 'per.patientRead', tier: 3 },
    { specializationId: 'per.huntersEye', tier: 3 },
    { specializationId: 'per.exploit', tier: 3 },
    { specializationId: 'per.resourceSense', tier: 1 },
  ],
  equipment: { skill1: 'sigil.rendingCut', mainHand: 'sword.worn' },
};

export const CONDITIONAL_PROBES: readonly ConditionalProbe[] = [
  {
    ...READER,
    id: 'per.patientRead',
    gate: 'a banked read is held at the moment a weak point lands',
    // The scenario *is* the mechanic: hold off attacking for longer than the
    // interval, then swing. Attacking freely would never bank one, which is
    // exactly the false positive this design exists to avoid.
    plan: { ticks: 1400, attackWith: 'melee.slash', waitTicks: 130 },
    observe: (frame, selfId) =>
      weakPointHit(frame, selfId) &&
      !hasStatus(frame.self.statuses, StatusId.PatientRead, frame.tick),
  },
  {
    ...READER,
    id: 'per.patientRead/ability',
    gate: 'an eligible active ability spends a banked read',
    plan: { ticks: 2400, attackWith: 'skill.rendingCut', waitTicks: 130 },
    observe: (frame, selfId) =>
      weakPointHit(frame, selfId) &&
      !hasStatus(frame.self.statuses, StatusId.PatientRead, frame.tick),
  },
  {
    ...READER,
    id: 'per.exploit',
    gate: 'a weak point lands on a body that was already Exposed',
    plan: { ticks: 900, attackWith: 'melee.slash' },
    observe: (frame, selfId) => {
      if (!weakPointHit(frame, selfId)) return false;
      // Exposed was refreshed by this very blow, so "already exposed" is read
      // off it having *more* left than one fresh application would give.
      const exposed = statusOf(frame.target?.statuses ?? {}, StatusId.Exposed, frame.tick);
      return exposed !== null && frame.self.stats.traits.exploitDamagePct > 0;
    },
  },
  {
    ...READER,
    id: 'per.resourceSense',
    gate: 'a weak point returns resource',
    plan: { ticks: 900, attackWith: 'melee.slash' },
    observe: (frame, selfId) =>
      weakPointHit(frame, selfId) && frame.self.stats.traits.weakPointResource > 0,
  },
  {
    ...READER,
    id: 'per.openingRead',
    gate: 'a blow lands while the target is Vulnerable',
    // A body that fights back, because Vulnerable is the tell a *committed
    // attack* leaves and a training dummy never commits one.
    monster: 'stalker',
    plan: { ticks: 900, attackWith: 'melee.slash' },
    observe: (frame) =>
      frame.target !== undefined &&
      hasStatus(frame.target.statuses, StatusId.Vulnerable, frame.tick) &&
      frame.self.stats.traits.openingReadFactor > 0,
  },
  {
    // The control, from another attribute: a live conditional that must not be
    // reported. Without one, a pass reporting nothing proves nothing.
    id: 'int.prepared',
    gate: 'stillness banks a Prepared charge',
    attributes: { intelligence: 60 },
    specializations: [],
    plan: { ticks: 400, attackWith: '' },
    observe: (frame) => hasStatus(frame.self.statuses, StatusId.Prepared, frame.tick),
  },
];

export function observeAll(seed = 1): readonly Observation[] {
  return CONDITIONAL_PROBES.map((probe) => observeProbe(probe, seed));
}
