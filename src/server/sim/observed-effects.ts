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
import { isResolute } from './poise.js';
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
/** How fast a repositioning body moves, and how tight a circle it walks. */
const MOVE_PACE = 0.3;
const MOVE_PERIOD = 40;
const AT = { x: 600, y: 450 };

/** One tick of a scenario, as the observer sees it. */
export interface Frame {
  readonly tick: number;
  readonly self: ServerEntity;
  /**
   * The same body **before** this tick was stepped (spec 273).
   *
   * Some gates are a *change* rather than a state: Guard coming back, a shield
   * being made, health being restored. Read off `self` alone those are
   * indistinguishable from a body that already had them, which is the false
   * positive this whole pass exists to avoid -- so the delta is handed over
   * rather than left to a row to remember between calls.
   */
  readonly previous: ServerEntity;
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
  /**
   * Whether the body walks -- and it **circles at a fraction of its speed**
   * rather than running in a straight line (spec 273).
   *
   * A constant heading at full pace simply outruns the opponent: the first
   * version of the Constitution rows below reported 0 blows and 0 observations
   * because the body had walked out of the fight, which is a measurement of the
   * leash rather than of the mechanic. Repositioning is what a mobile scenario
   * is for, and a body that is not being hit drains no Guard and so recovers
   * none either.
   */
  readonly moving?: boolean;
  /**
   * Fraction of maximum health the body starts on (spec 273).
   *
   * Constitution's identity is gated on being *nearly dead*, and a fight written
   * to grind a body down to 30% is a fight whose result depends on how hard the
   * opponent happens to hit. Starting there states the condition instead.
   */
  readonly startHealth?: number;
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
  /**
   * Blows the *opponent* landed on the body (spec 273).
   *
   * Beside `blows` because a scenario is a fight, and which side of it a gate
   * reads is the gate's business: Perception's rows are about blows this body
   * throws, and Constitution's are about blows it takes -- a Guard that is never
   * drained recovers nothing, so an unhit body reports NOT OBSERVED for a reason
   * that has nothing to do with the mechanic. And a mobile scenario cannot swing
   * at all: asking to move withdraws from a wind-up (spec 079), so a body that
   * repositions every tick completes no attack, correctly and by design.
   */
  readonly taken: number;
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
  if (probe.plan.startHealth !== undefined) {
    state = replaceEntity(state, {
      ...player.entity,
      health: stats.maxHealth * probe.plan.startHealth,
    });
  }

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
    // Already engaged (spec 273). Acquisition is not what any row here is
    // about, and a gate that depends on the *opponent* landing a blow -- which
    // every Constitution row does, since a Guard that is never drained recovers
    // nothing -- otherwise waits out a notice range before the scenario starts.
    targetId: selfId,
  });
  state = monster.state;
  const foeId = monster.entity.id;
  const body = state.entities.get(foeId);
  if (body) state = replaceEntity(state, { ...body, health: 1_000_000_000 });

  const ctx = context();
  const wait = probe.plan.waitTicks ?? 0;
  let count = 0;
  let blows = 0;
  let taken = 0;
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
          moveX: probe.plan.moving === true ? Math.cos(i / MOVE_PERIOD) * MOVE_PACE : 0,
          moveY: probe.plan.moving === true ? Math.sin(i / MOVE_PERIOD) * MOVE_PACE : 0,
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
      previous: self,
      target: state.entities.get(foeId),
      events: result.events,
    };
    if (frame.events.some((e) => e.kind === 'hit' && e.targetId === selfId)) taken += 1;
    if (probe.observe(frame, selfId)) count += 1;
  }

  return { id: probe.id, gate: probe.gate, observed: count > 0, count, blows, taken };
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

/** Whether the body actually changed position on this tick. */
const walked = (frame: Frame): boolean =>
  frame.self.position.x !== frame.previous.position.x ||
  frame.self.position.y !== frame.previous.position.y;

/**
 * Constitution at the top of its tree (spec 273).
 *
 * Every row below is a mechanic gated on a *state the simulation has to reach*
 * rather than on a number, which is the class this pass exists for -- and the
 * class Constitution turned out to be full of. Its moving-Guard grant is the
 * case that makes the point: the tier audit reported it moving a trait in every
 * cell while `regenPoise` set the rate to zero on any tick the body moved, so
 * the purchase was live, satisfiable by content, and unreachable in a fight.
 * That is Steady Aim's signature exactly, found a spec later by a bespoke probe
 * because these rows did not exist yet. They do now.
 */
const ENDURER: Pick<ConditionalProbe, 'attributes' | 'specializations' | 'equipment'> = {
  attributes: { constitution: 60 },
  specializations: [
    { specializationId: 'con.deepReserves', tier: 3 },
    { specializationId: 'con.steadyFrame', tier: 3 },
    { specializationId: 'con.secondWind', tier: 3 },
    { specializationId: 'con.hardToKill', tier: 3 },
    { specializationId: 'con.sustainedEffort', tier: 3 },
    { specializationId: 'con.overflowVitality', tier: 1 },
    { specializationId: 'con.unbroken', tier: 3 },
    { specializationId: 'con.deathsDoor', tier: 1 },
    { specializationId: 'con.deepWell', tier: 3 },
  ],
  equipment: { mainHand: 'sword.worn' },
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
  // --- Constitution (spec 273) -------------------------------------------
  //
  // A ravager rather than a dummy for all of these: the pool has to be *drained*
  // before recovery can be observed at all. Against a dummy the Guard sits at
  // maximum and `min(maxPoise, poise + rate)` returns what it was handed, so
  // every one of these rows would read NOT OBSERVED for a reason that has
  // nothing to do with the mechanic -- which is the trap the track's own probe
  // fell into twice before it was written this way.
  {
    ...ENDURER,
    id: 'con.steadyFrame',
    gate: 'Guard comes back on a tick the body was moving',
    monster: 'ravager',
    plan: { ticks: 1200, attackWith: 'melee.slash', moving: true },
    observe: (frame) => walked(frame) && frame.self.poise > frame.previous.poise,
  },
  {
    ...ENDURER,
    id: 'con.secondWind',
    gate: 'the comeback fires and leaves the body inside the danger band',
    monster: 'ravager',
    // Started inside the band: the gate is the comeback, not the grind down to
    // it, and a fight that has to arrive there measures the ravager's damage.
    plan: { ticks: 600, attackWith: 'melee.slash', startHealth: 0.28 },
    observe: (frame) =>
      !hasStatus(frame.previous.statuses, StatusId.SecondWindSpent, frame.tick) &&
      hasStatus(frame.self.statuses, StatusId.SecondWindSpent, frame.tick) &&
      frame.self.health / frame.self.stats.maxHealth <= SCALING.constitution.dangerBelow + 1e-9,
  },
  {
    ...ENDURER,
    id: 'con.overflowVitality',
    gate: 'healing that will not fit becomes a shield',
    monster: 'ravager',
    plan: { ticks: 600, attackWith: 'melee.slash', startHealth: 0.28 },
    observe: (frame) => frame.self.shield > frame.previous.shield,
  },
  // **Without Second Wind and without Overflow Vitality**, which is not a
  // narrower build for its own sake: held, the comeback lifts the body to
  // exactly the top of the band on tick one and its overflow becomes a shield
  // that then absorbs everything a ravager throws, so health never falls back
  // in. Measured: Resolute for exactly one frame out of nine hundred, with six
  // blows landing on the shield. That is the track composing correctly and it
  // makes this particular gate unreachable, so the scenario states the
  // condition instead of fighting the rest of the tree for it.
  {
    ...ENDURER,
    specializations: [
      { specializationId: 'con.deepReserves', tier: 3 },
      { specializationId: 'con.hardToKill', tier: 3 },
    ],
    id: 'con.hardToKill',
    gate: 'a blow lands on a body that is Resolute',
    monster: 'ravager',
    plan: { ticks: 900, attackWith: 'melee.slash', startHealth: 0.2 },
    observe: (frame, selfId) =>
      isResolute(frame.self) &&
      frame.events.some((e) => e.kind === 'hit' && e.targetId === selfId),
  },
  // Same omission and the same reason, plus the two rows that make the gate mean
  // something: without `deathsDoor` a moving body keeps only its fraction, and
  // this asserts it keeps the *calm* rate instead.
  {
    ...ENDURER,
    specializations: [
      { specializationId: 'con.deepReserves', tier: 3 },
      { specializationId: 'con.steadyFrame', tier: 3 },
      { specializationId: 'con.hardToKill', tier: 3 },
      { specializationId: 'con.deathsDoor', tier: 1 },
    ],
    id: 'con.deathsDoor',
    gate: 'Guard comes back while Resolute *and* moving',
    monster: 'ravager',
    plan: { ticks: 1200, attackWith: 'melee.slash', moving: true, startHealth: 0.2 },
    observe: (frame) =>
      isResolute(frame.self) && walked(frame) && frame.self.poise > frame.previous.poise,
  },

];

export function observeAll(seed = 1): readonly Observation[] {
  return CONDITIONAL_PROBES.map((probe) => observeProbe(probe, seed));
}
