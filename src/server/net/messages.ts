/**
 * Game message encode/decode (spec 056). Transport only: this module knows the
 * byte layout of a frame and nothing about game rules, and it depends on no
 * other server module but the shared type vocabulary.
 *
 * Every encoder returns the finished frame; every decoder throws
 * {@link CodecError} on a malformed one, which the router turns into a dropped
 * frame rather than a crash.
 */

import {
  EQUIP_SLOTS,
  type EffectiveStats,
  type Equipment,
  type EquipSlot,
  type Inventory,
  type ItemStack,
  type SlotAddress,
  type Vec3,
} from '../state/types.js';
import { BufferReader, BufferWriter, CodecError } from './codec.js';
import { ClientMessageType, ServerMessageType } from './protocol.js';
import {
  decodeChunkDenied,
  decodeMapChunk,
  decodeMapInfo,
  encodeChunkDenied,
  encodeMapChunk,
  encodeMapInfo,
  type ChunkDeniedMessage,
  type MapChunkMessage,
  type MapInfoMessage,
  type RequestChunkMessage,
} from './map-messages.js';

export type {
  ChunkDeniedMessage,
  MapChunkMessage,
  MapInfoMessage,
  MapLayerInfoMsg,
  RequestChunkMessage,
} from './map-messages.js';

// --- client -> server ---------------------------------------------------

export interface HelloMessage {
  readonly type: typeof ClientMessageType.Hello;
  readonly protocolVersion: number;
  readonly playerId: string;
  readonly displayName: string;
  /** Empty for a plain player; an admin token promotes the connection. */
  readonly token: string;
  /**
   * The asset manifest hash this client was built against (spec 113).
   *
   * Empty from a client that has none -- the bot harness and the in-tab server
   * share a process with the thing they connect to and cannot be stale with
   * respect to it. A hash that is present and *different* is refused.
   */
  readonly assetManifest: string;
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

/**
 * Move one item between two slots (spec 126).
 *
 * A request like every other: the server decides. The client is expected to
 * guess the outcome and draw it, which is what `requestId` is for -- the answer
 * names the guess it settles, so a client can tell "my move went through" from
 * "an unrelated resend arrived".
 */
export interface MoveItemMessage {
  readonly type: typeof ClientMessageType.MoveItem;
  readonly requestId: number;
  readonly from: SlotAddress;
  readonly to: SlotAddress;
  /** How many to take, or 0 for the whole stack. */
  readonly count: number;
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
  /**
   * The entity being attacked, or 0 to aim at the point alone (spec 070).
   *
   * A request like everything else here: the server checks the id is something
   * this caster may hit and refuses to land on it otherwise. Sent alongside the
   * point rather than instead of it, because the point is what the body turns
   * into and what a client draws while it does.
   */
  readonly targetEntityId: number;
  /**
   * The last input sequence number the client had sent when it asked (spec 067).
   *
   * The server applies one input per tick from a queue, so the tick a request
   * *arrives* on and the tick the input it was made on is *applied* on are
   * different ticks whenever anything is buffered. Committing on the stamped
   * input instead of on arrival is what makes the client's own predicted root
   * line up with the server's exactly, rather than approximately.
   */
  readonly afterInputSeq: number;
}

export interface CancelCastMessage {
  readonly type: typeof ClientMessageType.CancelCast;
  /** As {@link UseAbilityMessage.afterInputSeq}: withdrawing is timed too. */
  readonly afterInputSeq: number;
}

/**
 * Ask to be told what the map's spawners are doing, or to stop being told
 * (spec 076).
 *
 * The only client message that changes nothing about the world. It is a
 * subscription to a readout, so the server may answer it with silence and a
 * client that never sends it is never sent a `SpawnerStates`.
 */
export interface WatchSpawnersMessage {
  readonly type: typeof ClientMessageType.WatchSpawners;
  readonly on: boolean;
}

export type ClientMessage =
  | HelloMessage
  | InputMessage
  | PingMessage
  | EquipMessage
  | UnequipMessage
  | MoveItemMessage
  | SpendSkillPointMessage
  | ChatMessage
  | UseAbilityMessage
  | CancelCastMessage
  | RequestChunkMessage
  | WatchSpawnersMessage;

/**
 * A slot address, as a container byte and a signed index (spec 126).
 *
 * Signed on purpose: an out-of-range index is a *rule* refusal, answered with a
 * reason, and encoding it as a varuint would turn a client's -1 into a corrupt
 * frame and a dropped connection instead.
 */
const CONTAINER_BYTE = { inventory: 0, equipment: 1 } as const;

function writeAddress(writer: BufferWriter, at: SlotAddress): void {
  writer.u8(CONTAINER_BYTE[at.container]).varint(at.index);
}

function readAddress(reader: BufferReader): SlotAddress {
  const container = reader.u8();
  if (container !== CONTAINER_BYTE.inventory && container !== CONTAINER_BYTE.equipment) {
    throw new CodecError(`unknown container ${container}`);
  }
  return {
    container: container === CONTAINER_BYTE.inventory ? 'inventory' : 'equipment',
    index: reader.varint(),
  };
}

/**
 * A whole container. An empty slot is an empty id, which costs one byte -- and
 * keeps the count of slots on the wire equal to the count the server has, so a
 * client never has to guess how long its own bag is.
 */
function writeInventory(writer: BufferWriter, inventory: Inventory): void {
  writer.varuint(inventory.length);
  for (const stack of inventory) {
    if (!stack) {
      writer.str('');
      continue;
    }
    writer.str(stack.defId).varuint(stack.count);
  }
}

function readInventory(reader: BufferReader): Inventory {
  const count = reader.varuint();
  const bag: (ItemStack | null)[] = new Array<ItemStack | null>(count).fill(null);
  for (let i = 0; i < count; i++) {
    const defId = reader.str();
    bag[i] = defId === '' ? null : { defId, count: reader.varuint() };
  }
  return bag;
}

function writeEquipment(writer: BufferWriter, equipment: Equipment): void {
  // Slot order is `EQUIP_SLOTS`, so a new slot is appended there and nowhere
  // else -- the wire has no names on it and cannot survive a reorder.
  for (const slot of EQUIP_SLOTS) writer.str(equipment[slot] ?? '');
}

function readEquipment(reader: BufferReader): Equipment {
  const worn: Partial<Record<EquipSlot, string | null>> = {};
  for (const slot of EQUIP_SLOTS) {
    const id = reader.str();
    worn[slot] = id === '' ? null : id;
  }
  return worn as Equipment;
}

export function encodeClientMessage(message: ClientMessage): Uint8Array {
  const writer = new BufferWriter(64);
  writer.u8(message.type);
  switch (message.type) {
    case ClientMessageType.Hello:
      writer
        .u16(message.protocolVersion)
        .str(message.playerId)
        .str(message.displayName)
        .str(message.token)
        .str(message.assetManifest);
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
    case ClientMessageType.MoveItem:
      writer.varuint(message.requestId);
      writeAddress(writer, message.from);
      writeAddress(writer, message.to);
      writer.varuint(message.count);
      break;
    case ClientMessageType.SpendSkillPoint:
      writer.str(message.skillId);
      break;
    case ClientMessageType.Chat:
      writer.str(message.text);
      break;
    case ClientMessageType.UseAbility:
      writer
        .str(message.abilityId)
        .f32(message.targetX)
        .f32(message.targetY)
        .varuint(message.targetEntityId)
        .varuint(message.afterInputSeq);
      break;
    case ClientMessageType.CancelCast:
      writer.varuint(message.afterInputSeq);
      break;
    case ClientMessageType.RequestChunk:
      writer.varuint(message.layer).varint(message.cx).varint(message.cz);
      break;
    case ClientMessageType.WatchSpawners:
      writer.bool(message.on);
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
        assetManifest: reader.str(),
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
    case ClientMessageType.MoveItem:
      return {
        type: ClientMessageType.MoveItem,
        requestId: reader.varuint(),
        from: readAddress(reader),
        to: readAddress(reader),
        count: reader.varuint(),
      };
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
        targetEntityId: reader.varuint(),
        afterInputSeq: reader.varuint(),
      };
    case ClientMessageType.CancelCast:
      return { type: ClientMessageType.CancelCast, afterInputSeq: reader.varuint() };
    case ClientMessageType.RequestChunk:
      return {
        type: ClientMessageType.RequestChunk,
        layer: reader.varuint(),
        cx: reader.varint(),
        cz: reader.varint(),
      };
    case ClientMessageType.WatchSpawners:
      return { type: ClientMessageType.WatchSpawners, on: reader.bool() };
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

/**
 * What the player is carrying and wearing (spec 126). The whole thing, always.
 *
 * Sent on login, after every accepted move, and after every *refused* one --
 * the refusal is the case that matters, because it is what a client's optimistic
 * guess is rolled back against, and a rollback that only runs on rare failures
 * is a rollback that has stopped working by the time it is needed.
 */
export interface InventoryMessage {
  readonly type: typeof ServerMessageType.Inventory;
  /** The request this answers, or 0 for an unprompted resend. */
  readonly requestId: number;
  readonly inventory: Inventory;
  readonly equipment: Equipment;
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
  /** The entity it was aimed at, or 0 for a point aim (spec 070). */
  readonly targetEntityId: number;
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

/**
 * What the owner may not do yet, and until when (spec 065).
 *
 * Sent to one connection: its own entity's cooldown map, whole, whenever it
 * changes. Whole rather than as a diff because it is a handful of entries and a
 * diff would need its own removal encoding to express a refund -- which is the
 * case that matters, since cancelling clears a cooldown.
 *
 * The client subtracts `readyAtTick` from the tick it is drawing to get the
 * remaining sweep. It never computes a cooldown's *length*; that stays a server
 * fact read from the ability table.
 */
export interface CooldownsMessage {
  readonly type: typeof ServerMessageType.Cooldowns;
  readonly entries: readonly { readonly abilityId: string; readonly readyAtTick: number }[];
  /**
   * The caster's live resource, and the tick it was true on (spec 069).
   *
   * Here rather than on the entity delta because it is nobody else's business:
   * what another player has left to spend changes nothing this client draws,
   * and the delta is the one message that is paid for per entity.
   *
   * It rides on this message because this message is already sent exactly when
   * a cast commits, which is when resource moves by a cost. Between those, the
   * client models regen from `resourceRegen` -- so `atTick` is not decoration:
   * the number is a round trip old on arrival, and modelling forward from it
   * needs to know how far forward.
   */
  readonly resource: number;
  readonly atTick: number;
}

/** One spawner's live state, as the overlay draws it (spec 076). */
export interface SpawnerStatus {
  readonly id: string;
  readonly monsterId: string;
  readonly x: number;
  readonly y: number;
  /** `SpawnerStateValue`: occupied, or counting down. */
  readonly state: number;
  /** Ticks left on the timer; 0 while occupied. */
  readonly ticks: number;
}

/**
 * What every spawner on the map is doing (spec 076).
 *
 * The whole map rather than the player's interest set: these are markers a
 * level designer placed, so there are tens of them, and an overlay that faded
 * out at the edge of the interest radius would be worse at answering the
 * question it exists for -- "is that camp about to come back".
 */
export interface SpawnerStatesMessage {
  readonly type: typeof ServerMessageType.SpawnerStates;
  readonly tick: number;
  readonly spawners: readonly SpawnerStatus[];
}

export type ServerMessage =
  | WelcomeMessage
  | DeltaMessage
  | CorrectionMessage
  | CombatResultMessage
  | StatsMessage
  | InventoryMessage
  | ServerChatMessage
  | PongMessage
  | ErrorMessage
  | DisconnectMessage
  | CastStateMessage
  | CastEndedMessage
  | EffectMessage
  | CastRejectedMessage
  | CooldownsMessage
  | MapInfoMessage
  | MapChunkMessage
  | ChunkDeniedMessage
  | SpawnerStatesMessage;

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
    .u16(stats.attackDelayTicks)
    .f32(stats.armor)
    .f32(stats.spellPower)
    .f32(stats.critChance)
    .f32(stats.maxResource)
    .f32(stats.resourceRegen)
    .str(stats.basicAttackId);
}

function readStats(reader: BufferReader): EffectiveStats {
  return {
    maxHealth: reader.f32(),
    moveSpeed: reader.f32(),
    turnRate: reader.f32(),
    attackDamage: reader.f32(),
    attackRange: reader.f32(),
    attackDelayTicks: reader.u16(),
    armor: reader.f32(),
    spellPower: reader.f32(),
    critChance: reader.f32(),
    maxResource: reader.f32(),
    resourceRegen: reader.f32(),
    basicAttackId: reader.str(),
  };
}

export function encodeServerMessage(message: ServerMessage): Uint8Array {
  // The map messages size and frame themselves -- a chunk is kilobytes where
  // everything below is tens of bytes, and it has its own writer to match.
  switch (message.type) {
    case ServerMessageType.MapInfo:
      return encodeMapInfo(message);
    case ServerMessageType.MapChunk:
      return encodeMapChunk(message);
    case ServerMessageType.ChunkDenied:
      return encodeChunkDenied(message);
    default:
      break;
  }
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
    case ServerMessageType.SpawnerStates:
      writer.u32(message.tick).varuint(message.spawners.length);
      for (const spawner of message.spawners) {
        writer
          .str(spawner.id)
          .str(spawner.monsterId)
          // Thousandths, like every other coordinate since spec 072: these come
          // straight out of the document, and an f32 cannot hold most of them.
          .varint(Math.round(spawner.x * 1000))
          .varint(Math.round(spawner.y * 1000))
          .u8(spawner.state)
          .varuint(spawner.ticks);
      }
      break;
    case ServerMessageType.Cooldowns:
      writer.varuint(message.entries.length);
      for (const entry of message.entries) writer.str(entry.abilityId).u32(entry.readyAtTick);
      writer.f32(message.resource).u32(message.atTick);
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
    case ServerMessageType.Inventory:
      writer.varuint(message.requestId);
      writeInventory(writer, message.inventory);
      writeEquipment(writer, message.equipment);
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
        .f32(message.targetY)
        .varuint(message.targetEntityId);
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
    case ServerMessageType.MapInfo:
      return decodeMapInfo(reader);
    case ServerMessageType.MapChunk:
      return decodeMapChunk(reader);
    case ServerMessageType.ChunkDenied:
      return decodeChunkDenied(reader);
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
    case ServerMessageType.SpawnerStates: {
      const tick = reader.u32();
      const count = reader.varuint();
      const spawners: SpawnerStatus[] = new Array<SpawnerStatus>(count);
      for (let i = 0; i < count; i++) {
        spawners[i] = {
          id: reader.str(),
          monsterId: reader.str(),
          x: reader.varint() / 1000,
          y: reader.varint() / 1000,
          state: reader.u8(),
          ticks: reader.varuint(),
        };
      }
      return { type: ServerMessageType.SpawnerStates, tick, spawners };
    }
    case ServerMessageType.Cooldowns: {
      const count = reader.varuint();
      const entries: { abilityId: string; readyAtTick: number }[] = [];
      for (let i = 0; i < count; i++) {
        entries.push({ abilityId: reader.str(), readyAtTick: reader.u32() });
      }
      const resource = reader.f32();
      const atTick = reader.u32();
      return { type: ServerMessageType.Cooldowns, entries, resource, atTick };
    }
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
    case ServerMessageType.Inventory:
      return {
        type: ServerMessageType.Inventory,
        requestId: reader.varuint(),
        inventory: readInventory(reader),
        equipment: readEquipment(reader),
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
        targetEntityId: reader.varuint(),
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
