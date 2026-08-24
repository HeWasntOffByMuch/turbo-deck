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
  BASE_STAT_KEYS,
  EQUIP_SLOTS,
  TRAIT_WIRE_ORDER,
  type BaseStats,
  type EffectiveStats,
  type Equipment,
  type EquipSlot,
  type Inventory,
  type ItemStack,
  type SkillAllocation,
  type SlotAddress,
  type TraitStats,
  type Vec3,
} from '../state/types.js';
import {
  MAX_GRADE,
  MIN_GRADE,
  ScalingGrade,
  type WeaponScaling,
} from '../data/weapon-scaling.js';
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
  /**
   * A session token from an earlier `Welcome`, to come back to the same body
   * (spec 150). Empty for a fresh login, which is every first connection.
   *
   * Matched against the lingering sessions for this `playerId`; anything that
   * does not match is simply a new login rather than an error, because a token
   * that has aged out is the ordinary case rather than an attack.
   */
  readonly resumeToken: string;
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
  /**
   * How far behind the server's clock the world this input was made against is
   * being drawn, in ticks (spec 149).
   *
   * Client-reported, and clamped to `MAX_REWIND_TICKS` the moment it lands.
   * That clamp is the whole security argument: the most a client achieves by
   * lying is the compensation an honest player on a 200ms connection already
   * gets.
   */
  readonly renderLagTicks: number;
}

export interface PingMessage {
  readonly type: typeof ClientMessageType.Ping;
  readonly nonce: number;
}

/** "I meant to leave" (spec 150). See {@link ClientMessageType.Goodbye}. */
export interface GoodbyeMessage {
  readonly type: typeof ClientMessageType.Goodbye;
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

/**
 * Ask a vendor what they have (spec 129).
 *
 * Answered with a `VendorState`, or with one carrying an empty id when the
 * player is not close enough -- which is also how a shop is closed.
 */
export interface OpenVendorMessage {
  readonly type: typeof ClientMessageType.OpenVendor;
  /** Empty closes whatever is open. */
  readonly vendorId: string;
}

/**
 * The five trade messages (spec 132).
 *
 * There is no `tradeId` on any of them, and that is deliberate: a player is in
 * at most one trade, so the id would be a field a client could get wrong for no
 * benefit. The server looks it up from who is asking, which is the one answer
 * that cannot be spoofed.
 */
export interface TradeInviteMessage {
  readonly type: typeof ClientMessageType.TradeInvite;
  /** Who to ask, by the entity they are driving. */
  readonly entityId: number;
}

export interface TradeRespondMessage {
  readonly type: typeof ClientMessageType.TradeRespond;
  readonly accept: boolean;
}

/** One side's whole offer, replacing whatever was on the table. */
export interface TradeOfferMessage {
  readonly type: typeof ClientMessageType.TradeOffer;
  readonly slots: readonly { readonly index: number; readonly count: number }[];
  readonly coins: number;
}

export interface TradeAcceptMessage {
  readonly type: typeof ClientMessageType.TradeAccept;
  /** Which revision is being accepted. A stale one is not an acceptance. */
  readonly revision: number;
}

export interface TradeCancelMessage {
  readonly type: typeof ClientMessageType.TradeCancel;
}

export interface BuyItemMessage {
  readonly type: typeof ClientMessageType.BuyItem;
  readonly requestId: number;
  readonly vendorId: string;
  readonly defId: string;
  readonly count: number;
}

export interface SellItemMessage {
  readonly type: typeof ClientMessageType.SellItem;
  readonly requestId: number;
  readonly vendorId: string;
  /** An inventory slot. Equipment is never sold off the body (spec 129). */
  readonly index: number;
  readonly count: number;
}

export interface BuyBackMessage {
  readonly type: typeof ClientMessageType.BuyBack;
  readonly requestId: number;
  readonly vendorId: string;
  /** An index into the buyback list the server last sent. */
  readonly index: number;
}

/**
 * Put one attribute point somewhere (spec 147).
 *
 * The whole payload is one ordinal into `BASE_STAT_KEYS`. There is no amount and
 * no derived value -- the client says *which button was pressed*, and reads the
 * consequences back off the `Stats` message that follows.
 */
export interface AllocateAttributeMessage {
  readonly type: typeof ClientMessageType.AllocateAttribute;
  readonly attribute: number;
}

export interface RespecAttributesMessage {
  readonly type: typeof ClientMessageType.RespecAttributes;
}

/** Rank up one attribute-attuned skill (spec 147). */
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

/**
 * Take a drop off the ground (spec 158).
 *
 * A request like every other on this side of the wire: the server checks that
 * the entity is a drop, that it belongs to the asker, that they are alive and
 * close enough, and that the bag has room -- and answers with an `Inventory` at
 * this `requestId` either way, so a refusal takes the client's guess back the
 * same way an acceptance replaces it.
 *
 * There is no "and reveal it first". A drop mid-reveal is picked up now.
 */
export interface PickUpItemMessage {
  readonly type: typeof ClientMessageType.PickUpItem;
  readonly requestId: number;
  /** The drop's entity id. A drop has no slot address until it is in a bag. */
  readonly entityId: number;
}

/**
 * Put a stack down in the world (spec 172).
 *
 * The same shape as a move minus its target, because the target is the ground
 * and the ground has no address. Where it lands is the server's: the body's
 * facing and a constant reach, neither of which a client may name.
 *
 * Answered with an `Inventory` at this `requestId` either way, like every other
 * container edit.
 */
export interface DropItemMessage {
  readonly type: typeof ClientMessageType.DropItem;
  readonly requestId: number;
  readonly at: SlotAddress;
  /** How many to put down, or 0 for the whole stack. */
  readonly count: number;
  /**
   * The world point the cursor was over: what the body turns to face, and the
   * line the throw runs along (spec 172).
   *
   * An aim rather than a destination. How far the item goes is the server's
   * constant, so a point on the horizon and a point two paces away are the same
   * request in every respect but direction -- and a point on top of the body has
   * no direction in it, which leaves the body's own heading standing.
   */
  readonly aimX: number;
  readonly aimY: number;
}

/**
 * "Put me back on my feet" (spec 164). See {@link ClientMessageType.Respawn}.
 *
 * Payloadless, like {@link GoodbyeMessage}: where a respawn puts you and what it
 * restores are the server's to decide, so there is nothing here for a client to
 * name.
 */
export interface RespawnMessage {
  readonly type: typeof ClientMessageType.Respawn;
}

export type ClientMessage =
  | HelloMessage
  | InputMessage
  | PingMessage
  | GoodbyeMessage
  | EquipMessage
  | UnequipMessage
  | MoveItemMessage
  | OpenVendorMessage
  | BuyItemMessage
  | SellItemMessage
  | BuyBackMessage
  | TradeInviteMessage
  | TradeRespondMessage
  | TradeOfferMessage
  | TradeAcceptMessage
  | TradeCancelMessage
  | SpendSkillPointMessage
  | AllocateAttributeMessage
  | RespecAttributesMessage
  | ChatMessage
  | UseAbilityMessage
  | CancelCastMessage
  | RequestChunkMessage
  | WatchSpawnersMessage
  | PickUpItemMessage
  | DropItemMessage
  | RespawnMessage;

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

/** One side of a trade, as the wire carries it (spec 132). */
function writeTradeSide(writer: BufferWriter, side: TradeSideView): void {
  writer.str(side.playerId).str(side.displayName).varuint(side.offer.length);
  for (const entry of side.offer) writer.str(entry.defId).varuint(entry.count);
  writer.varuint(side.coins).u8(side.accepted ? 1 : 0);
}

function readTradeSide(reader: BufferReader): TradeSideView {
  const playerId = reader.str();
  const displayName = reader.str();
  const count = reader.count();
  const offer: { defId: string; count: number }[] = [];
  for (let i = 0; i < count; i++) offer.push({ defId: reader.str(), count: reader.varuint() });
  return { playerId, displayName, offer, coins: reader.varuint(), accepted: reader.u8() !== 0 };
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
  const count = reader.count();
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
        .str(message.assetManifest)
        .str(message.resumeToken);
      break;
    case ClientMessageType.Input:
      writer
        .varuint(message.seq)
        .f32(message.moveX)
        .f32(message.moveY)
        .f32(message.facing)
        .u8(message.buttons)
        .f32(message.predictedX)
        .f32(message.predictedY)
        .varuint(message.renderLagTicks);
      break;
    case ClientMessageType.Ping:
      writer.u32(message.nonce);
      break;
    case ClientMessageType.Goodbye:
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
    case ClientMessageType.PickUpItem:
      writer.varuint(message.requestId).varuint(message.entityId);
      break;
    case ClientMessageType.DropItem:
      writer.varuint(message.requestId);
      writeAddress(writer, message.at);
      writer.varint(message.count).f32(message.aimX).f32(message.aimY);
      break;
    case ClientMessageType.Respawn:
      break;
    case ClientMessageType.OpenVendor:
      writer.str(message.vendorId);
      break;
    case ClientMessageType.BuyItem:
      writer.varuint(message.requestId).str(message.vendorId).str(message.defId).varint(message.count);
      break;
    case ClientMessageType.SellItem:
      writer.varuint(message.requestId).str(message.vendorId).varint(message.index).varint(message.count);
      break;
    case ClientMessageType.BuyBack:
      writer.varuint(message.requestId).str(message.vendorId).varint(message.index);
      break;
    case ClientMessageType.TradeInvite:
      writer.varuint(message.entityId);
      break;
    case ClientMessageType.TradeRespond:
      writer.u8(message.accept ? 1 : 0);
      break;
    case ClientMessageType.TradeOffer:
      writer.varuint(message.slots.length);
      // Signed, like every other slot index on this wire (spec 126): a
      // nonsensical offer is a rule refusal with a reason, not a corrupt frame.
      for (const slot of message.slots) writer.varint(slot.index).varint(slot.count);
      writer.varint(message.coins);
      break;
    case ClientMessageType.TradeAccept:
      writer.varint(message.revision);
      break;
    case ClientMessageType.TradeCancel:
      break;
    case ClientMessageType.SpendSkillPoint:
      writer.str(message.skillId);
      break;
    case ClientMessageType.AllocateAttribute:
      writer.u8(message.attribute);
      break;
    case ClientMessageType.RespecAttributes:
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
        resumeToken: reader.str(),
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
        renderLagTicks: reader.varuint(),
      };
    case ClientMessageType.Ping:
      return { type: ClientMessageType.Ping, nonce: reader.u32() };
    case ClientMessageType.Goodbye:
      return { type: ClientMessageType.Goodbye };
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
    case ClientMessageType.PickUpItem:
      return {
        type: ClientMessageType.PickUpItem,
        requestId: reader.varuint(),
        entityId: reader.varuint(),
      };
    case ClientMessageType.DropItem:
      return {
        type: ClientMessageType.DropItem,
        requestId: reader.varuint(),
        at: readAddress(reader),
        count: reader.varint(),
        aimX: reader.f32(),
        aimY: reader.f32(),
      };
    case ClientMessageType.Respawn:
      return { type: ClientMessageType.Respawn };
    case ClientMessageType.OpenVendor:
      return { type: ClientMessageType.OpenVendor, vendorId: reader.str() };
    case ClientMessageType.BuyItem:
      return {
        type: ClientMessageType.BuyItem,
        requestId: reader.varuint(),
        vendorId: reader.str(),
        defId: reader.str(),
        // Signed, like a slot index (spec 126): a nonsensical count is a rule
        // refusal with a reason, not a corrupt frame and a dropped connection.
        count: reader.varint(),
      };
    case ClientMessageType.SellItem:
      return {
        type: ClientMessageType.SellItem,
        requestId: reader.varuint(),
        vendorId: reader.str(),
        index: reader.varint(),
        count: reader.varint(),
      };
    case ClientMessageType.BuyBack:
      return {
        type: ClientMessageType.BuyBack,
        requestId: reader.varuint(),
        vendorId: reader.str(),
        index: reader.varint(),
      };
    case ClientMessageType.TradeInvite:
      return { type: ClientMessageType.TradeInvite, entityId: reader.varuint() };
    case ClientMessageType.TradeRespond:
      return { type: ClientMessageType.TradeRespond, accept: reader.u8() !== 0 };
    case ClientMessageType.TradeOffer: {
      const count = reader.count();
      const slots: { index: number; count: number }[] = [];
      for (let i = 0; i < count; i++) slots.push({ index: reader.varint(), count: reader.varint() });
      return { type: ClientMessageType.TradeOffer, slots, coins: reader.varint() };
    }
    case ClientMessageType.TradeAccept:
      return { type: ClientMessageType.TradeAccept, revision: reader.varint() };
    case ClientMessageType.TradeCancel:
      return { type: ClientMessageType.TradeCancel };
    case ClientMessageType.SpendSkillPoint:
      return { type: ClientMessageType.SpendSkillPoint, skillId: reader.str() };
    case ClientMessageType.AllocateAttribute:
      return { type: ClientMessageType.AllocateAttribute, attribute: reader.u8() };
    case ClientMessageType.RespecAttributes:
      return { type: ClientMessageType.RespecAttributes };
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
   * Present this in a later `Hello` to resume this session (spec 150).
   *
   * From `crypto.randomUUID`, never from the world's seeded `Rng`: that one is
   * reproducible on purpose, which is exactly what a resume token must not be.
   */
  readonly sessionToken: string;
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
  /** Spec 145, players only. See {@link EntityField.Identity}. */
  readonly name?: string;
  readonly turnRate?: number;
  /** Guard left, 0..1 (spec 147). Quantised to a byte on the wire. */
  readonly poise?: number;
  /**
   * How fast this body may move, as a fraction of its own speed (spec 188).
   * Absent means unchanged; 1 is not slowed.
   */
  readonly moveScale?: number;
  /** Absorb left in health units, and the tick the whole thing falls off. */
  readonly shield?: number;
  readonly shieldUntilTick?: number;
  /** What this body is visibly carrying (spec 186). See {@link EntityField.Statuses}. */
  readonly statuses?: readonly WireStatus[];
}

/**
 * One status as it crosses the wire (spec 186).
 *
 * A table index rather than a string id, and an **absolute** expiry rather than
 * a remaining count -- the two choices that let the client's mark be a pure
 * function of this record and the tick being drawn. `magnitude` deliberately
 * does not ride: the picture says *that* a body is Exposed, not by how much, on
 * the same argument that made poise a fraction.
 */
export interface WireStatus {
  /** `StatusVisual.wire`. */
  readonly wire: number;
  readonly stacks: number;
  readonly expiresAtTick: number;
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
  /**
   * Every point this character has spent (spec 128). Whole, never a delta.
   *
   * On this message rather than one of its own because it changes at exactly the
   * moments `Stats` is already sent -- login, equip, unequip, spend, level -- and
   * a second message on the same trigger is a second thing to keep in step.
   *
   * Without it a client can spend a point and is never told what it owns, so a
   * skill tree cannot be drawn at all; the same hole spec 126 closed for
   * equipment, and with the same answer.
   */
  /** Every point spent in the attuned tree (spec 147). Whole, never a delta. */
  readonly skills: readonly SkillAllocation[];
  /**
   * The six attributes as *allocated* (spec 147), plus what is left to place.
   *
   * Allocated rather than total, deliberately: the sheet's "+" button spends
   * against this number and a respec returns it, so it has to be the thing the
   * server's own validator reads. What items push it to is `attributes`, where
   * nothing tries to spend it -- and both are sent because neither is derivable
   * from the other once anything grants an attribute.
   */
  readonly baseStats: BaseStats;
  readonly attributes: BaseStats;
  readonly unspentAttributePoints: number;
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
  /**
   * What the player can spend (spec 129).
   *
   * On this message because a purchase changes the bag and the purse at the same
   * instant, and two messages for one event is two things to keep in step.
   */
  readonly coins: number;
  /**
   * A skill-slot change in flight, or absent (spec 188).
   *
   * On this message rather than on one of its own, for the reason the coins are
   * on it: a swap being asked for, landing, or being given up are all container
   * events, and two messages for one event is two things to keep in step.
   *
   * It rides only on the messages that bracket the change -- one when it is
   * asked for, one when it ends -- because the client needs no ticking: the two
   * ticks are enough to draw a bar from, which is the same trick the loot
   * reveal uses. A resend for any other reason simply carries whatever is true
   * at the time.
   */
  readonly pendingSwap?: PendingSkillSwap;
}

/**
 * A skill-slot change the server has committed the player to (spec 188).
 *
 * Both addresses, both ticks, and which of the three kinds it is -- everything
 * the interface needs to say *what* is happening to *which* slot and how far
 * through it is. Nothing here is a client's claim: the server derived the kind
 * from its own containers and stamped both ticks off its own clock.
 */
export interface PendingSkillSwap {
  /** A {@link SkillSwapKind}. */
  readonly kind: number;
  readonly from: SlotAddress;
  readonly to: SlotAddress;
  readonly startedTick: number;
  readonly readyAtTick: number;
}

/** What a vendor is offering, and what can be undone (spec 129). */
export interface VendorStateMessage {
  readonly type: typeof ServerMessageType.VendorState;
  /** Empty means the shop is closed -- see `ServerMessageType.VendorState`. */
  readonly vendorId: string;
  readonly name: string;
  readonly stock: readonly { readonly defId: string; readonly price: number }[];
  readonly buyback: readonly {
    readonly defId: string;
    readonly count: number;
    readonly price: number;
  }[];
}

/** One side of a trade, as the other side is allowed to see it (spec 132). */
export interface TradeSideView {
  readonly playerId: string;
  readonly displayName: string;
  /**
   * What is on the table, resolved to items.
   *
   * Resolved rather than sent as slot indices, because the *other* side cannot
   * see into your bag and a bare index would mean nothing to them. The offering
   * side gets the same view, which is deliberate: both players are then looking
   * at the same description of the same table.
   */
  readonly offer: readonly { readonly defId: string; readonly count: number }[];
  readonly coins: number;
  readonly accepted: boolean;
}

export interface TradeStateMessage {
  readonly type: typeof ServerMessageType.TradeState;
  /** 0 means "you are not in a trade", which is how a window is closed. */
  readonly tradeId: number;
  /** One of `TradeStageValue`. */
  readonly stage: number;
  readonly revision: number;
  /** Always the side of the player being sent to; `them` is the other. */
  readonly you: TradeSideView;
  readonly them: TradeSideView;
  /** Why it ended, when it ended badly. Empty otherwise. */
  readonly reason: string;
  /**
   * You are the side being asked (spec 170). Only meaningful while `stage` is
   * offered.
   *
   * On the wire because it cannot be derived: `you` and `them` are symmetric by
   * construction, so nothing in this message says which of the two opened the
   * trade -- which left the sender being shown "Accept invitation" for their
   * own invitation.
   */
  readonly invited: boolean;
  /**
   * What would stop this trade going through right now, from *your* point of
   * view. Empty when nothing would.
   *
   * Per player, because "your bag is full" and "their bag is full" are
   * different sentences and a single shared string is wrong for one of the two
   * people reading it.
   */
  readonly warning: string;
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
  /**
   * The **smallest** this connection's input queue got since the last pong
   * (spec 148).
   *
   * A floor rather than an instantaneous reading, because the instant is not
   * the quantity that matters and cannot even see the failure. Pongs arrive at
   * 2Hz; the queue oscillates at 60Hz between "the input that just arrived" and
   * "nothing". Sampled, a starving connection reads 1 about as often as 0 and
   * the controller sits in its deadband while the server ticks on empty. The
   * floor over the interval says exactly what is wanted: if it ever reached
   * zero the server starved, and if it never dropped below forty the queue is
   * forty deep.
   *
   * On `Pong` rather than `Delta` because a delta is suppressed when the world
   * did not change, and the controller must not go blind in exactly the quiet
   * moments drift accumulates through.
   */
  readonly inputQueueFloor: number;
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
  /**
   * The tick the wind-up began (spec 144).
   *
   * On the wire because the client can no longer derive it: the wind-up's
   * length used to be `ability.windupTicks`, read off the shared table, and
   * attack speed now scales that. A bar drawn against the table's number would
   * run at the wrong rate for exactly the bodies attacking fastest.
   */
  readonly startTick: number;
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

/**
 * The health economy, as the owner sees it (spec 156).
 *
 * Two numbers and a tick. It rides the same reasoning as {@link
 * CooldownsMessage}: owner-only, sent when it changes, and never on the entity
 * delta -- what somebody else has left to drink changes nothing this client
 * draws, and the delta is the message that is paid for per entity.
 *
 * `meter` is a **fraction**, and that is the interesting decision. The
 * absolute progress and the threshold it is measured against are both server
 * tuning; a bar asks only how full it is; and a client told its raw progress is
 * a client that could work out exactly which kill produces the next mote, which
 * is a thing to farm rather than a thing to feel.
 *
 * `atTick` is not decoration, for the reason it is not on the cooldowns: the
 * number is a round trip old when it lands, and a client easing a bar toward it
 * has to know how far behind it is.
 */
export interface RestorationMessage {
  readonly type: typeof ServerMessageType.Restoration;
  /** Progress toward the next mote, 0..1. */
  readonly meter: number;
  readonly charges: number;
  /** What this build's Constitution allows, so the pips can be drawn empty. */
  readonly maxCharges: number;
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

/**
 * A drop in the world, and how much of it this client may know yet (spec 158).
 *
 * The one place an item's identity crosses the wire for something lying on the
 * ground, and the reason the drop's entity record carries no `typeId`: the
 * delta goes to everyone in range on first sight, and *what* an unrevealed drop
 * is must not.
 *
 * `defId` empty (and `count` zero) is the wire form of "not revealed yet". Not a
 * flag beside the real value -- the value is genuinely absent, so there is no
 * path by which a client could draw it early, honest or otherwise.
 *
 * `spawnTick` and `revealTick` are both sent because a client needs the whole
 * span to draw the run-up, and because a late observer's own "when did I first
 * see this" is not the answer -- it would restart the anticipation for somebody
 * who walked up halfway through it.
 */
export interface LootDropMessage {
  readonly type: typeof ServerMessageType.LootDrop;
  readonly entityId: number;
  /** One of `RARITY_IDS`, as its index. Drives the cue, never the identity. */
  readonly rarity: number;
  readonly spawnTick: number;
  /** Equal to `spawnTick` for a drop that was never going to wait. */
  readonly revealTick: number;
  /**
   * Where the body fell -- the point the item was thrown from (spec 158).
   *
   * The entity's replicated position is where it *lands*, so these two are the
   * ends of an arc the client draws over `TOSS_TICKS` from `spawnTick`. Sent
   * rather than guessed because the throw has to be the same throw on every
   * screen, and because a client arriving after the toss computes "already
   * landed" from the same two numbers with no special case.
   */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  /** The item, or `''` while it is still being withheld. */
  readonly defId: string;
  /** How many, or `0` while the identity is withheld. */
  readonly count: number;
}

export type ServerMessage =
  | WelcomeMessage
  | DeltaMessage
  | CorrectionMessage
  | CombatResultMessage
  | StatsMessage
  | InventoryMessage
  | VendorStateMessage
  | TradeStateMessage
  | ServerChatMessage
  | PongMessage
  | ErrorMessage
  | DisconnectMessage
  | CastStateMessage
  | CastEndedMessage
  | EffectMessage
  | CastRejectedMessage
  | CooldownsMessage
  | RestorationMessage
  | MapInfoMessage
  | MapChunkMessage
  | ChunkDeniedMessage
  | SpawnerStatesMessage
  | LootDropMessage;

// Field bits, duplicated here as plain numbers so the hot encode path is a
// bitmask test rather than a property lookup. Kept in sync with protocol.ts.
const FIELD_SPAWN = 1 << 0;
const FIELD_POSITION = 1 << 1;
const FIELD_FACING = 1 << 2;
const FIELD_HEALTH = 1 << 3;
const FIELD_ACTIVITY = 1 << 4;
const FIELD_LEVEL = 1 << 5;
const FIELD_IDENTITY = 1 << 6;
const FIELD_POISE = 1 << 7;
const FIELD_SHIELD = 1 << 8;
const FIELD_STATUSES = 1 << 9;
const FIELD_MOVE_SCALE = 1 << 10;

function writeEntityDelta(writer: BufferWriter, entity: EntityDelta): void {
  // A varuint rather than a byte since spec 147: `Identity` took the eighth bit
  // and poise and shields need two more. The common delta -- position and
  // facing, mask 6 -- is still one byte.
  writer.varuint(entity.id).varuint(entity.fields);
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
  if (entity.fields & FIELD_IDENTITY) {
    writer.str(entity.name ?? '').f32(entity.turnRate ?? 0);
  }
  // A fraction in one byte (spec 147). 255 is a full guard; the rounding error
  // is a fifth of a percent, invisible on a bar three pixels tall.
  if (entity.fields & FIELD_POISE) {
    writer.u8(Math.max(0, Math.min(255, Math.round((entity.poise ?? 1) * 255))));
  }
  if (entity.fields & FIELD_SHIELD) {
    writer.f32(entity.shield ?? 0).u32(entity.shieldUntilTick ?? 0);
  }
  // Six bytes each behind a count (spec 186). The count is written even when the
  // list is empty, because an empty list is the message "everything you were
  // told about is gone" -- without it a status could only ever be added.
  if (entity.fields & FIELD_STATUSES) {
    const held = entity.statuses ?? [];
    writer.u8(Math.min(255, held.length));
    for (const status of held) {
      writer
        .u8(Math.max(0, Math.min(255, status.wire)))
        .u8(Math.max(0, Math.min(255, status.stacks)))
        .u32(Math.max(0, status.expiresAtTick));
    }
  }
  // A fraction in one byte, like the guard above (spec 188). 255 is "not
  // slowed", which is what an absent field has always meant and what a body
  // carrying nothing is.
  if (entity.fields & FIELD_MOVE_SCALE) {
    writer.u8(Math.max(0, Math.min(255, Math.round((entity.moveScale ?? 1) * 255))));
  }
}

function readEntityDelta(reader: BufferReader): EntityDelta {
  const id = reader.varuint();
  const fields = reader.varuint();
  let kind: number | undefined;
  let typeId: string | undefined;
  let position: Vec3 | undefined;
  let facing: number | undefined;
  let health: number | undefined;
  let maxHealth: number | undefined;
  let activity: number | undefined;
  let activityUntilTick: number | undefined;
  let level: number | undefined;
  let name: string | undefined;
  let turnRate: number | undefined;
  let poise: number | undefined;
  let shield: number | undefined;
  let shieldUntilTick: number | undefined;
  let statuses: WireStatus[] | undefined;
  let moveScale: number | undefined;
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
  if (fields & FIELD_IDENTITY) {
    name = reader.str();
    turnRate = reader.f32();
  }
  if (fields & FIELD_POISE) poise = reader.u8() / 255;
  if (fields & FIELD_SHIELD) {
    shield = reader.f32();
    shieldUntilTick = reader.u32();
  }
  if (fields & FIELD_STATUSES) {
    const count = reader.u8();
    const read: WireStatus[] = [];
    // Every entry is read whatever this build makes of it. A `wire` index with
    // no row here is a client talking to a newer server, and skipping the bytes
    // rather than reading them would desync the whole frame -- so the unknown
    // one is carried and dropped where it is drawn, not where it is decoded.
    for (let index = 0; index < count; index += 1) {
      read.push({ wire: reader.u8(), stacks: reader.u8(), expiresAtTick: reader.u32() });
    }
    statuses = read;
  }
  if (fields & FIELD_MOVE_SCALE) moveScale = reader.u8() / 255;
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
    ...(name === undefined ? {} : { name }),
    ...(turnRate === undefined ? {} : { turnRate }),
    ...(poise === undefined ? {} : { poise }),
    ...(shield === undefined ? {} : { shield, shieldUntilTick: shieldUntilTick ?? 0 }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(moveScale === undefined ? {} : { moveScale }),
  };
}

function writeSkills(writer: BufferWriter, skills: readonly SkillAllocation[]): void {
  writer.varuint(skills.length);
  for (const allocation of skills) writer.str(allocation.skillId).varuint(allocation.level);
}

/**
 * The six attributes, in {@link BASE_STAT_KEYS} order (spec 147).
 *
 * By position rather than by name, which is the same decision
 * `ClientMessageType.AllocateAttribute` makes about its ordinal and for the same
 * reason: the order is already canonical and already load-bearing, so spelling
 * the names out would be six strings restating a constant both ends import.
 */
function writeAttributes(writer: BufferWriter, attributes: BaseStats): void {
  for (const key of BASE_STAT_KEYS) writer.varuint(Math.max(0, Math.round(attributes[key])));
}

function readAttributes(reader: BufferReader): BaseStats {
  const values: Record<string, number> = {};
  for (const key of BASE_STAT_KEYS) values[key] = reader.varuint();
  return values as unknown as BaseStats;
}

function readStringList(reader: BufferReader): readonly string[] {
  const count = reader.count();
  const ids: string[] = new Array<string>(count);
  for (let i = 0; i < count; i++) ids[i] = reader.str();
  return ids;
}

function readSkills(reader: BufferReader): readonly SkillAllocation[] {
  const count = reader.count();
  const skills: SkillAllocation[] = new Array<SkillAllocation>(count);
  for (let i = 0; i < count; i++) skills[i] = { skillId: reader.str(), level: reader.varuint() };
  return skills;
}

function writeStats(writer: BufferWriter, stats: EffectiveStats): void {
  writer
    .f32(stats.maxHealth)
    .f32(stats.moveSpeed)
    .f32(stats.turnRate)
    .f32(stats.attackDamage)
    .f32(stats.attackRange)
    .u16(stats.baseAttackTimeTicks)
    .f32(stats.attackSpeed)
    .f32(stats.attackSpeedMultiplier)
    .f32(stats.attackSpeedSlowMultiplier)
    .f32(stats.armor)
    .f32(stats.spellPower)
    .f32(stats.critChance)
    .f32(stats.maxResource)
    .f32(stats.resourceRegen)
    .str(stats.basicAttackId);
  // The four skill slots' abilities (spec 188), count-prefixed like every other
  // list on this wire. Owner-only already -- `Stats` is sent to the player it
  // is about -- and sent because the client needs it for the same two reasons
  // it needs `basicAttackId`: to know what its bar may ask for, and to grey out
  // what it may not. It is still never *read* from a client: the server derives
  // its own copy from equipment on every recalculation.
  writer.varuint(stats.skillAbilityIds.length);
  for (const id of stats.skillAbilityIds) writer.str(id);
  // Weapon scaling (spec 216): the three resolved grades, then the three steps
  // that produced them. Both, because they answer different questions -- the
  // grades are what the held weapon scales with, and the steps are what the bag
  // needs to resolve a weapon it is only hovering over.
  //
  // `u8` for a grade, which is `0..6`; `i16` for a step, which is small but
  // signed and has no narrower signed writer here. Owner-only and sent on login
  // and on equipment changes rather than per tick, like the rest of this block.
  writeScaling(writer, stats.weaponScaling);
  writer.i16(clampStep(stats.scalingModifiers.strength));
  writer.i16(clampStep(stats.scalingModifiers.agility));
  writer.i16(clampStep(stats.scalingModifiers.intelligence));
  writeTraits(writer, stats.traits);
}

/**
 * The trait block (spec 147).
 *
 * Written by walking {@link TRAIT_WIRE_ORDER} rather than field by field, and
 * that is the whole point: a trait added to the interface and forgotten in one
 * of two hand-written functions is a field that reads as somebody else's value
 * for the rest of the message. One list, walked twice, cannot desynchronise --
 * and a test asserts the list covers the interface, so a trait added and
 * forgotten *there* fails CI.
 *
 * All f32. Several are logically integers and a few are logically flags, but a
 * uniform block is one loop rather than a schema, and the message is sent on
 * login and on allocation rather than per tick, so the width is free.
 */
/**
 * A grade triple, one byte each (spec 216).
 *
 * Clamped on the way out as well as on the way in, because a grade that came
 * off a hand-edited row outside `0..6` would otherwise be written as a wrapped
 * byte and read back as a *different, valid* grade -- which is worse than the
 * refusal, since nothing downstream could tell it had happened.
 */
function writeScaling(writer: BufferWriter, scaling: WeaponScaling): void {
  writer.u8(clampGrade(scaling.strength)).u8(clampGrade(scaling.agility)).u8(clampGrade(scaling.intelligence));
}

function readScaling(reader: BufferReader): WeaponScaling {
  return {
    strength: clampGrade(reader.u8()),
    agility: clampGrade(reader.u8()),
    intelligence: clampGrade(reader.u8()),
  };
}

function clampGrade(value: number): ScalingGrade {
  if (!Number.isFinite(value)) return ScalingGrade.None;
  return Math.min(MAX_GRADE, Math.max(MIN_GRADE, Math.round(value))) as ScalingGrade;
}

/**
 * A step, held inside the signed short it is written as.
 *
 * Whole, because the ladder has no half grades and `scaleModifier` multiplies
 * every numeric field by a skill's level -- so a passive granting half a step
 * per level is a thing somebody can author. Rounded here as well as in
 * `shiftGrade`, so what crosses the wire is what was resolved from.
 */
function clampStep(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(32767, Math.max(-32768, Math.round(value)));
}

function writeTraits(writer: BufferWriter, traits: TraitStats): void {
  for (const key of TRAIT_WIRE_ORDER) writer.f32(traits[key]);
}

function readTraits(reader: BufferReader): TraitStats {
  const traits: Record<string, number> = {};
  for (const key of TRAIT_WIRE_ORDER) traits[key] = reader.f32();
  return traits as unknown as TraitStats;
}

function readStats(reader: BufferReader): EffectiveStats {
  return {
    maxHealth: reader.f32(),
    moveSpeed: reader.f32(),
    turnRate: reader.f32(),
    attackDamage: reader.f32(),
    attackRange: reader.f32(),
    baseAttackTimeTicks: reader.u16(),
    attackSpeed: reader.f32(),
    attackSpeedMultiplier: reader.f32(),
    attackSpeedSlowMultiplier: reader.f32(),
    armor: reader.f32(),
    spellPower: reader.f32(),
    critChance: reader.f32(),
    maxResource: reader.f32(),
    resourceRegen: reader.f32(),
    basicAttackId: reader.str(),
    skillAbilityIds: readStringList(reader),
    weaponScaling: readScaling(reader),
    scalingModifiers: {
      strength: reader.i16(),
      agility: reader.i16(),
      intelligence: reader.i16(),
    },
    traits: readTraits(reader),
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
        .u32(message.worldSeed)
        .str(message.sessionToken);
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
    case ServerMessageType.Restoration:
      // The meter in one byte, like poise on the delta and for the same reason:
      // it draws a bar, and a 255th of a bar is a fifth of a percent.
      writer
        .u8(Math.max(0, Math.min(255, Math.round(message.meter * 255))))
        .u8(Math.max(0, Math.min(255, Math.round(message.charges))))
        .u8(Math.max(0, Math.min(255, Math.round(message.maxCharges))))
        .u32(message.atTick);
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
      writeSkills(writer, message.skills);
      writeAttributes(writer, message.baseStats);
      writeAttributes(writer, message.attributes);
      writer.varuint(message.unspentAttributePoints);
      writeStats(writer, message.stats);
      break;
    case ServerMessageType.Inventory: {
      writer.varuint(message.requestId);
      writeInventory(writer, message.inventory);
      writeEquipment(writer, message.equipment);
      writer.varuint(message.coins);
      // A presence byte then the block, which is how every optional payload on
      // this wire is written: absent is one byte and the common case.
      const swap = message.pendingSwap;
      writer.u8(swap ? 1 : 0);
      if (swap) {
        writer.u8(swap.kind);
        writeAddress(writer, swap.from);
        writeAddress(writer, swap.to);
        writer.u32(swap.startedTick).u32(swap.readyAtTick);
      }
      break;
    }
    case ServerMessageType.LootDrop:
      writer
        .varuint(message.entityId)
        .u8(message.rarity)
        .u32(message.spawnTick)
        .u32(message.revealTick)
        .f32(message.originX)
        .f32(message.originY)
        .f32(message.originZ)
        .str(message.defId)
        .varuint(message.count);
      break;
    case ServerMessageType.VendorState:
      writer.str(message.vendorId).str(message.name).varuint(message.stock.length);
      for (const entry of message.stock) writer.str(entry.defId).varuint(entry.price);
      writer.varuint(message.buyback.length);
      for (const entry of message.buyback) {
        writer.str(entry.defId).varuint(entry.count).varuint(entry.price);
      }
      break;
    case ServerMessageType.TradeState:
      writer.varuint(message.tradeId).u8(message.stage).varuint(message.revision);
      writeTradeSide(writer, message.you);
      writeTradeSide(writer, message.them);
      writer.str(message.reason).u8(message.invited ? 1 : 0).str(message.warning);
      break;
    case ServerMessageType.Chat:
      writer.u8(message.channel).str(message.from).str(message.text);
      break;
    case ServerMessageType.Pong:
      writer.u32(message.nonce).u32(message.serverTick).varuint(message.inputQueueFloor);
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
        .u32(message.startTick)
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
        sessionToken: reader.str(),
      };
    case ServerMessageType.SpawnerStates: {
      const tick = reader.u32();
      const count = reader.count();
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
      const count = reader.count();
      const entries: { abilityId: string; readyAtTick: number }[] = [];
      for (let i = 0; i < count; i++) {
        entries.push({ abilityId: reader.str(), readyAtTick: reader.u32() });
      }
      const resource = reader.f32();
      const atTick = reader.u32();
      return { type: ServerMessageType.Cooldowns, entries, resource, atTick };
    }
    case ServerMessageType.Restoration: {
      const meter = reader.u8() / 255;
      const charges = reader.u8();
      const maxCharges = reader.u8();
      return { type: ServerMessageType.Restoration, meter, charges, maxCharges, atTick: reader.u32() };
    }
    case ServerMessageType.Delta: {
      const tick = reader.u32();
      const ackInputSeq = reader.varuint();
      const removedCount = reader.count();
      const removed: number[] = [];
      for (let i = 0; i < removedCount; i++) removed.push(reader.varuint());
      const upsertCount = reader.count();
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
        skills: readSkills(reader),
        baseStats: readAttributes(reader),
        attributes: readAttributes(reader),
        unspentAttributePoints: reader.varuint(),
        stats: readStats(reader),
      };
    case ServerMessageType.Inventory: {
      const requestId = reader.varuint();
      const inventory = readInventory(reader);
      const equipment = readEquipment(reader);
      const coins = reader.varuint();
      const hasSwap = reader.u8() === 1;
      const pendingSwap = hasSwap
        ? {
            kind: reader.u8(),
            from: readAddress(reader),
            to: readAddress(reader),
            startedTick: reader.u32(),
            readyAtTick: reader.u32(),
          }
        : undefined;
      return {
        type: ServerMessageType.Inventory,
        requestId,
        inventory,
        equipment,
        coins,
        ...(pendingSwap === undefined ? {} : { pendingSwap }),
      };
    }
    case ServerMessageType.LootDrop:
      return {
        type: ServerMessageType.LootDrop,
        entityId: reader.varuint(),
        rarity: reader.u8(),
        spawnTick: reader.u32(),
        revealTick: reader.u32(),
        originX: reader.f32(),
        originY: reader.f32(),
        originZ: reader.f32(),
        defId: reader.str(),
        count: reader.varuint(),
      };
    case ServerMessageType.VendorState: {
      const vendorId = reader.str();
      const name = reader.str();
      const stockCount = reader.count();
      const stock: { defId: string; price: number }[] = [];
      for (let i = 0; i < stockCount; i++) stock.push({ defId: reader.str(), price: reader.varuint() });
      const buybackCount = reader.count();
      const buyback: { defId: string; count: number; price: number }[] = [];
      for (let i = 0; i < buybackCount; i++) {
        buyback.push({ defId: reader.str(), count: reader.varuint(), price: reader.varuint() });
      }
      return { type: ServerMessageType.VendorState, vendorId, name, stock, buyback };
    }
    case ServerMessageType.TradeState: {
      const tradeId = reader.varuint();
      const stage = reader.u8();
      const revision = reader.varuint();
      const you = readTradeSide(reader);
      const them = readTradeSide(reader);
      const reason = reader.str();
      return {
        type: ServerMessageType.TradeState,
        tradeId,
        stage,
        revision,
        you,
        them,
        reason,
        invited: reader.u8() !== 0,
        warning: reader.str(),
      };
    }
    case ServerMessageType.Chat:
      return {
        type: ServerMessageType.Chat,
        channel: reader.u8(),
        from: reader.str(),
        text: reader.str(),
      };
    case ServerMessageType.Pong:
      return {
        type: ServerMessageType.Pong,
        nonce: reader.u32(),
        serverTick: reader.u32(),
        inputQueueFloor: reader.varuint(),
      };
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
        startTick: reader.u32(),
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
