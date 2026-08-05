/**
 * Game message encode/decode (spec 056). Transport only: this module knows the
 * byte layout of a frame and nothing about game rules, and it depends on no
 * other server module but the shared type vocabulary.
 *
 * Every encoder returns the finished frame; every decoder throws
 * {@link CodecError} on a malformed one, which the router turns into a dropped
 * frame rather than a crash.
 */

import type { EffectiveStats, Vec3 } from '../state/types.js';
import { BufferReader, BufferWriter, CodecError } from './codec.js';
import { ClientMessageType, ServerMessageType } from './protocol.js';

// --- client -> server ---------------------------------------------------

export interface HelloMessage {
  readonly type: typeof ClientMessageType.Hello;
  readonly protocolVersion: number;
  readonly playerId: string;
  readonly displayName: string;
  /** Empty for a plain player; an admin token promotes the connection. */
  readonly token: string;
}

/**
 * One tick of intent. Note what a client may say: a *direction* it wants to
 * move, where it aims, which buttons are down, and -- purely as a hint for
 * reconciliation -- where its own prediction thinks it ended up. The server
 * never adopts `predicted*`; it only measures divergence against it.
 */
export interface InputMessage {
  readonly type: typeof ClientMessageType.Input;
  /** Monotonic per-connection; echoed back so the client can replay from it. */
  readonly seq: number;
  readonly moveX: number;
  readonly moveY: number;
  readonly facing: number;
  readonly buttons: number;
  readonly predictedX: number;
  readonly predictedY: number;
}

export interface PingMessage {
  readonly type: typeof ClientMessageType.Ping;
  readonly nonce: number;
}

export interface EquipMessage {
  readonly type: typeof ClientMessageType.Equip;
  readonly slot: string;
  readonly itemId: string;
}

export interface UnequipMessage {
  readonly type: typeof ClientMessageType.Unequip;
  readonly slot: string;
}

export interface SpendSkillPointMessage {
  readonly type: typeof ClientMessageType.SpendSkillPoint;
  readonly skillId: string;
}

export interface ChatMessage {
  readonly type: typeof ClientMessageType.Chat;
  readonly text: string;
}

/**
 * A request to commit to an ability (spec 062). The server decides whether it
 * may start -- cooldown, cost, range, and whether something is already winding
 * up -- and answers with a CastState or a CastRejected. The client never
 * assumes it worked.
 */
export interface UseAbilityMessage {
  readonly type: typeof ClientMessageType.UseAbility;
  readonly abilityId: string;
  readonly targetX: number;
  readonly targetY: number;
}

export interface CancelCastMessage {
  readonly type: typeof ClientMessageType.CancelCast;
}

export type ClientMessage =
  | HelloMessage
  | InputMessage
  | PingMessage
  | EquipMessage
  | UnequipMessage
  | SpendSkillPointMessage
  | ChatMessage
  | UseAbilityMessage
  | CancelCastMessage;

export function encodeClientMessage(message: ClientMessage): Uint8Array {
  const writer = new BufferWriter(64);
  writer.u8(message.type);
  switch (message.type) {
    case ClientMessageType.Hello:
      writer.u16(message.protocolVersion).str(message.playerId).str(message.displayName).str(message.token);
      break;
    case ClientMessageType.Input:
      writer
        .varuint(message.seq)
        .f32(message.moveX)
        .f32(message.moveY)
        .f32(message.facing)
        .u8(message.buttons)
        .f32(message.predictedX)
        .f32(message.predictedY);
      break;
    case ClientMessageType.Ping:
      writer.u32(message.nonce);
      break;
    case ClientMessageType.Equip:
      writer.str(message.slot).str(message.itemId);
      break;
    case ClientMessageType.Unequip:
      writer.str(message.slot);
      break;
    case ClientMessageType.SpendSkillPoint:
      writer.str(message.skillId);
      break;
    case ClientMessageType.Chat:
      writer.str(message.text);
      break;
    case ClientMessageType.UseAbility:
      writer.str(message.abilityId).f32(message.targetX).f32(message.targetY);
      break;
    case ClientMessageType.CancelCast:
      break;
  }
  return writer.toBytes();
}

export function decodeClientMessage(frame: Uint8Array): ClientMessage {
  const reader = new BufferReader(frame);
  const type = reader.u8();
  switch (type) {
    case ClientMessageType.Hello:
      return {
        type: ClientMessageType.Hello,
        protocolVersion: reader.u16(),
        playerId: reader.str(),
        displayName: reader.str(),
        token: reader.str(),
      };
    case ClientMessageType.Input:
      return {
        type: ClientMessageType.Input,
        seq: reader.varuint(),
        moveX: reader.f32(),
        moveY: reader.f32(),
        facing: reader.f32(),
        buttons: reader.u8(),
        predictedX: reader.f32(),
        predictedY: reader.f32(),
      };
    case ClientMessageType.Ping:
      return { type: ClientMessageType.Ping, nonce: reader.u32() };
    case ClientMessageType.Equip:
      return { type: ClientMessageType.Equip, slot: reader.str(), itemId: reader.str() };
    case ClientMessageType.Unequip:
      return { type: ClientMessageType.Unequip, slot: reader.str() };
    case ClientMessageType.SpendSkillPoint:
      return { type: ClientMessageType.SpendSkillPoint, skillId: reader.str() };
    case ClientMessageType.Chat:
      return { type: ClientMessageType.Chat, text: reader.str() };
    case ClientMessageType.UseAbility:
      return {
        type: ClientMessageType.UseAbility,
        abilityId: reader.str(),
        targetX: reader.f32(),
        targetY: reader.f32(),
      };
    case ClientMessageType.CancelCast:
      return { type: ClientMessageType.CancelCast };
    default:
      throw new CodecError(`unknown client message type 0x${type.toString(16)}`);
  }
}

// --- server -> client ---------------------------------------------------

export interface WelcomeMessage {
  readonly type: typeof ServerMessageType.Welcome;
  readonly protocolVersion: number;
  readonly playerId: string;
  /** The entity the client controls, so it can pick itself out of a delta. */
  readonly entityId: number;
  readonly tick: number;
  readonly tickRate: number;
  readonly chunkSize: number;
  readonly interestRadius: number;
  /** Divergence past which the client should expect a hard correction. */
  readonly correctionThreshold: number;
  /**
   * The seed the server's world was built from (spec 063).
   *
   * The client needs it to build the same ground and the same trees, and being
   * told is the only honest way it can have it -- a client that assumed a seed
   * would draw a forest the server does not collide against, and every trunk
   * would become a correction the player cannot account for.
   */
  readonly worldSeed: number;
}

/**
 * One entity's changed fields. `fields` is an {@link EntityField} bitmask and
 * only the flagged members are on the wire -- that bitmask *is* the delta.
 */
export interface EntityDelta {
  readonly id: number;
  readonly fields: number;
  readonly kind?: number;
  readonly typeId?: string;
  readonly position?: Vec3;
  readonly facing?: number;
  readonly health?: number;
  readonly maxHealth?: number;
  readonly activity?: number;
  readonly activityUntilTick?: number;
  readonly level?: number;
}

export interface DeltaMessage {
  readonly type: typeof ServerMessageType.Delta;
  readonly tick: number;
  /** Highest input seq from this client the server has applied. */
  readonly ackInputSeq: number;
  /** Entities that left this client's interest set (or died). */
  readonly removed: readonly number[];
  readonly upserts: readonly EntityDelta[];
}

export interface CorrectionMessage {
  readonly type: typeof ServerMessageType.Correction;
  /** The input seq this correction is authoritative as of; replay after it. */
  readonly inputSeq: number;
  readonly position: Vec3;
  readonly facing: number;
  readonly reason: number;
}

/**
 * The authoritative outcome of one hit: what was taken off, and what is left.
 *
 * Spec 065 removed the presentation fields this used to carry as well
 * (`hitstopTicks`, `knockbackX/Y`, `knockbackTicks`) along with the mechanics
 * behind them. A client plays back the damage; nothing is displaced.
 */
export interface CombatResultMessage {
  readonly type: typeof ServerMessageType.CombatResult;
  readonly attackerId: number;
  readonly targetId: number;
  readonly damage: number;
  readonly targetHealth: number;
  /** bit 0 = killing blow, bit 1 = critical, bit 2 = blocked. */
  readonly flags: number;
}

export const CombatFlag = {
  Killed: 1 << 0,
  Critical: 1 << 1,
  Blocked: 1 << 2,
} as const;

export interface StatsMessage {
  readonly type: typeof ServerMessageType.Stats;
  readonly entityId: number;
  readonly level: number;
  readonly experience: number;
  readonly unspentSkillPoints: number;
  readonly stats: EffectiveStats;
}

export interface ServerChatMessage {
  readonly type: typeof ServerMessageType.Chat;
  readonly channel: number;
  readonly from: string;
  readonly text: string;
}

export interface PongMessage {
  readonly type: typeof ServerMessageType.Pong;
  readonly nonce: number;
  readonly serverTick: number;
}

export interface ErrorMessage {
  readonly type: typeof ServerMessageType.Error;
  readonly code: number;
  readonly message: string;
}

export interface DisconnectMessage {
  readonly type: typeof ServerMessageType.Disconnect;
  readonly reason: string;
}

/** Someone committed to an ability, and how long it runs (spec 062). */
export interface CastStateMessage {
  readonly type: typeof ServerMessageType.CastState;
  readonly entityId: number;
  readonly abilityId: string;
  readonly phase: number;
  readonly releaseTick: number;
  readonly endTick: number;
  readonly targetX: number;
  readonly targetY: number;
}

export interface CastEndedMessage {
  readonly type: typeof ServerMessageType.CastEnded;
  readonly entityId: number;
  readonly abilityId: string;
  /** {@link CastEndReasonValue}: released, cancelled, or interrupted. */
  readonly reason: number;
}

/**
 * A point cue for the client to draw. Deliberately not tied to an entity: an
 * impact outlives the projectile that caused it and a blast has no body at all.
 */
export interface EffectMessage {
  readonly type: typeof ServerMessageType.Effect;
  readonly effectId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly durationTicks: number;
}

/** Why the server would not start an ability the client asked for. */
export interface CastRejectedMessage {
  readonly type: typeof ServerMessageType.CastRejected;
  readonly abilityId: string;
  readonly reason: string;
}

export type ServerMessage =
  | WelcomeMessage
  | DeltaMessage
  | CorrectionMessage
  | CombatResultMessage
  | StatsMessage
  | ServerChatMessage
  | PongMessage
  | ErrorMessage
  | DisconnectMessage
  | CastStateMessage
  | CastEndedMessage
  | EffectMessage
  | CastRejectedMessage;

// Field bits, duplicated here as plain numbers so the hot encode path is a
// bitmask test rather than a property lookup. Kept in sync with protocol.ts.
const FIELD_SPAWN = 1 << 0;
const FIELD_POSITION = 1 << 1;
const FIELD_FACING = 1 << 2;
const FIELD_HEALTH = 1 << 3;
const FIELD_ACTIVITY = 1 << 4;
const FIELD_LEVEL = 1 << 5;

function writeEntityDelta(writer: BufferWriter, entity: EntityDelta): void {
  writer.varuint(entity.id).u8(entity.fields);
  if (entity.fields & FIELD_SPAWN) {
    writer.u8(entity.kind ?? 0).str(entity.typeId ?? '');
  }
  if (entity.fields & FIELD_POSITION) {
    const at = entity.position ?? { x: 0, y: 0, z: 0 };
    writer.f32(at.x).f32(at.y).f32(at.z);
  }
  if (entity.fields & FIELD_FACING) writer.f32(entity.facing ?? 0);
  if (entity.fields & FIELD_HEALTH) writer.f32(entity.health ?? 0).f32(entity.maxHealth ?? 0);
  if (entity.fields & FIELD_ACTIVITY) {
    writer.u8(entity.activity ?? 0).u32(entity.activityUntilTick ?? 0);
  }
  if (entity.fields & FIELD_LEVEL) writer.varuint(entity.level ?? 1);
}

function readEntityDelta(reader: BufferReader): EntityDelta {
  const id = reader.varuint();
  const fields = reader.u8();
  let kind: number | undefined;
  let typeId: string | undefined;
  let position: Vec3 | undefined;
  let facing: number | undefined;
  let health: number | undefined;
  let maxHealth: number | undefined;
  let activity: number | undefined;
  let activityUntilTick: number | undefined;
  let level: number | undefined;
  if (fields & FIELD_SPAWN) {
    kind = reader.u8();
    typeId = reader.str();
  }
  if (fields & FIELD_POSITION) {
    position = { x: reader.f32(), y: reader.f32(), z: reader.f32() };
  }
  if (fields & FIELD_FACING) facing = reader.f32();
  if (fields & FIELD_HEALTH) {
    health = reader.f32();
    maxHealth = reader.f32();
  }
  if (fields & FIELD_ACTIVITY) {
    activity = reader.u8();
    activityUntilTick = reader.u32();
  }
  if (fields & FIELD_LEVEL) level = reader.varuint();
  return {
    id,
    fields,
    ...(kind === undefined ? {} : { kind }),
    ...(typeId === undefined ? {} : { typeId }),
    ...(position === undefined ? {} : { position }),
    ...(facing === undefined ? {} : { facing }),
    ...(health === undefined ? {} : { health }),
    ...(maxHealth === undefined ? {} : { maxHealth }),
    ...(activity === undefined ? {} : { activity }),
    ...(activityUntilTick === undefined ? {} : { activityUntilTick }),
    ...(level === undefined ? {} : { level }),
  };
}

function writeStats(writer: BufferWriter, stats: EffectiveStats): void {
  writer
    .f32(stats.maxHealth)
    .f32(stats.moveSpeed)
    .f32(stats.turnRate)
    .f32(stats.attackDamage)
    .f32(stats.attackRange)
    .u16(stats.attackCooldownTicks)
    .f32(stats.armor)
    .f32(stats.spellPower)
    .f32(stats.critChance)
    .f32(stats.maxResource)
    .f32(stats.resourceRegen);
}

function readStats(reader: BufferReader): EffectiveStats {
  return {
    maxHealth: reader.f32(),
    moveSpeed: reader.f32(),
    turnRate: reader.f32(),
    attackDamage: reader.f32(),
    attackRange: reader.f32(),
    attackCooldownTicks: reader.u16(),
    armor: reader.f32(),
    spellPower: reader.f32(),
    critChance: reader.f32(),
    maxResource: reader.f32(),
    resourceRegen: reader.f32(),
  };
}

export function encodeServerMessage(message: ServerMessage): Uint8Array {
  const writer = new BufferWriter(message.type === ServerMessageType.Delta ? 512 : 64);
  writer.u8(message.type);
  switch (message.type) {
    case ServerMessageType.Welcome:
      writer
        .u16(message.protocolVersion)
        .str(message.playerId)
        .varuint(message.entityId)
        .u32(message.tick)
        .u8(message.tickRate)
        .u16(message.chunkSize)
        .u8(message.interestRadius)
        .f32(message.correctionThreshold)
        .u32(message.worldSeed);
      break;
    case ServerMessageType.Delta:
      writer.u32(message.tick).varuint(message.ackInputSeq).varuint(message.removed.length);
      for (const id of message.removed) writer.varuint(id);
      writer.varuint(message.upserts.length);
      for (const entity of message.upserts) writeEntityDelta(writer, entity);
      break;
    case ServerMessageType.Correction:
      writer
        .varuint(message.inputSeq)
        .f32(message.position.x)
        .f32(message.position.y)
        .f32(message.position.z)
        .f32(message.facing)
        .u8(message.reason);
      break;
    case ServerMessageType.CombatResult:
      writer
        .varuint(message.attackerId)
        .varuint(message.targetId)
        .f32(message.damage)
        .f32(message.targetHealth)
        .u8(message.flags);
      break;
    case ServerMessageType.Stats:
      writer
        .varuint(message.entityId)
        .varuint(message.level)
        .varuint(message.experience)
        .varuint(message.unspentSkillPoints);
      writeStats(writer, message.stats);
      break;
    case ServerMessageType.Chat:
      writer.u8(message.channel).str(message.from).str(message.text);
      break;
    case ServerMessageType.Pong:
      writer.u32(message.nonce).u32(message.serverTick);
      break;
    case ServerMessageType.Error:
      writer.u16(message.code).str(message.message);
      break;
    case ServerMessageType.Disconnect:
      writer.str(message.reason);
      break;
    case ServerMessageType.CastState:
      writer
        .varuint(message.entityId)
        .str(message.abilityId)
        .u8(message.phase)
        .u32(message.releaseTick)
        .u32(message.endTick)
        .f32(message.targetX)
        .f32(message.targetY);
      break;
    case ServerMessageType.CastEnded:
      writer.varuint(message.entityId).str(message.abilityId).u8(message.reason);
      break;
    case ServerMessageType.Effect:
      writer
        .str(message.effectId)
        .f32(message.x)
        .f32(message.y)
        .f32(message.z)
        .f32(message.radius)
        .u16(message.durationTicks);
      break;
    case ServerMessageType.CastRejected:
      writer.str(message.abilityId).str(message.reason);
      break;
  }
  return writer.toBytes();
}

export function decodeServerMessage(frame: Uint8Array): ServerMessage {
  const reader = new BufferReader(frame);
  const type = reader.u8();
  switch (type) {
    case ServerMessageType.Welcome:
      return {
        type: ServerMessageType.Welcome,
        protocolVersion: reader.u16(),
        playerId: reader.str(),
        entityId: reader.varuint(),
        tick: reader.u32(),
        tickRate: reader.u8(),
        chunkSize: reader.u16(),
        interestRadius: reader.u8(),
        correctionThreshold: reader.f32(),
        worldSeed: reader.u32(),
      };
    case ServerMessageType.Delta: {
      const tick = reader.u32();
      const ackInputSeq = reader.varuint();
      const removedCount = reader.varuint();
      const removed: number[] = [];
      for (let i = 0; i < removedCount; i++) removed.push(reader.varuint());
      const upsertCount = reader.varuint();
      const upserts: EntityDelta[] = [];
      for (let i = 0; i < upsertCount; i++) upserts.push(readEntityDelta(reader));
      return { type: ServerMessageType.Delta, tick, ackInputSeq, removed, upserts };
    }
    case ServerMessageType.Correction:
      return {
        type: ServerMessageType.Correction,
        inputSeq: reader.varuint(),
        position: { x: reader.f32(), y: reader.f32(), z: reader.f32() },
        facing: reader.f32(),
        reason: reader.u8(),
      };
    case ServerMessageType.CombatResult:
      return {
        type: ServerMessageType.CombatResult,
        attackerId: reader.varuint(),
        targetId: reader.varuint(),
        damage: reader.f32(),
        targetHealth: reader.f32(),
        flags: reader.u8(),
      };
    case ServerMessageType.Stats:
      return {
        type: ServerMessageType.Stats,
        entityId: reader.varuint(),
        level: reader.varuint(),
        experience: reader.varuint(),
        unspentSkillPoints: reader.varuint(),
        stats: readStats(reader),
      };
    case ServerMessageType.Chat:
      return {
        type: ServerMessageType.Chat,
        channel: reader.u8(),
        from: reader.str(),
        text: reader.str(),
      };
    case ServerMessageType.Pong:
      return { type: ServerMessageType.Pong, nonce: reader.u32(), serverTick: reader.u32() };
    case ServerMessageType.Error:
      return { type: ServerMessageType.Error, code: reader.u16(), message: reader.str() };
    case ServerMessageType.Disconnect:
      return { type: ServerMessageType.Disconnect, reason: reader.str() };
    case ServerMessageType.CastState:
      return {
        type: ServerMessageType.CastState,
        entityId: reader.varuint(),
        abilityId: reader.str(),
        phase: reader.u8(),
        releaseTick: reader.u32(),
        endTick: reader.u32(),
        targetX: reader.f32(),
        targetY: reader.f32(),
      };
    case ServerMessageType.CastEnded:
      return {
        type: ServerMessageType.CastEnded,
        entityId: reader.varuint(),
        abilityId: reader.str(),
        reason: reader.u8(),
      };
    case ServerMessageType.Effect:
      return {
        type: ServerMessageType.Effect,
        effectId: reader.str(),
        x: reader.f32(),
        y: reader.f32(),
        z: reader.f32(),
        radius: reader.f32(),
        durationTicks: reader.u16(),
      };
    case ServerMessageType.CastRejected:
      return {
        type: ServerMessageType.CastRejected,
        abilityId: reader.str(),
        reason: reader.str(),
      };
    default:
      throw new CodecError(`unknown server message type 0x${type.toString(16)}`);
  }
}
