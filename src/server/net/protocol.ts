/**
 * Wire message type bytes (spec 056). Byte 0 of every frame is one of these.
 *
 * The ranges *are* the namespaces -- there is no string tag on the wire, so
 * `admin:*` is expressed as "type byte in the admin range". Routing reads one
 * byte and dispatches; the admin gate is a range check, which means a client
 * that never learns an admin token cannot even address an admin handler.
 *
 *   0x01-0x3F  client -> server, game
 *   0x40-0x7F  server -> client, game
 *   0x80-0x9F  client -> server, admin:*
 *   0xA0-0xBF  server -> client, admin:*
 *
 * See PROTOCOL.md in this directory for the payload layout of each.
 */

export const ClientMessageType = {
  Hello: 0x01,
  Input: 0x02,
  Ping: 0x03,
  Equip: 0x04,
  Unequip: 0x05,
  SpendSkillPoint: 0x06,
  Chat: 0x07,
  /** Commit to an ability this tick (spec 062). */
  UseAbility: 0x08,
  /** Withdraw from whatever is winding up. */
  CancelCast: 0x09,
  /** Ask for one chunk of the map document (spec 072). */
  RequestChunk: 0x0a,
  /**
   * Turn the spawner readout on or off (spec 076).
   *
   * A debug channel, and opt-in for exactly that reason: a client that is not
   * showing the overlay is sent nothing, so the toggle costs what it draws and
   * nothing when it is off.
   */
  WatchSpawners: 0x0b,
  /**
   * Move one item from one slot to another (spec 126).
   *
   * The only container write there is: equip, unequip, swap, merge and split are
   * all this message with different addresses, which is why there is one
   * handler to keep honest rather than six.
   */
  MoveItem: 0x0c,
  /** Ask what a vendor is offering (spec 129). Refused out of range. */
  OpenVendor: 0x0d,
  BuyItem: 0x0e,
  SellItem: 0x0f,
  /** Undo a sale, at what it paid. */
  BuyBack: 0x10,
  /**
   * Trade, in five messages (spec 132).
   *
   * `TradeOffer` sets a side's offer *whole* rather than adding to it, for the
   * reason `MoveItem` is one message: a protocol with `add` and `remove` has two
   * handlers that can disagree about what is on the table, and the thing on the
   * table is exactly what must not be ambiguous.
   *
   * `TradeAccept` names the revision it is accepting. Every edit bumps that, so
   * an offer swapped in the instant before the exchange resolves invalidates the
   * acceptance instead of being swapped under somebody who never saw it.
   */
  TradeInvite: 0x11,
  TradeRespond: 0x12,
  TradeOffer: 0x13,
  TradeAccept: 0x14,
  TradeCancel: 0x15,
  /**
   * "I meant to leave" (spec 150). No payload.
   *
   * A dropped socket leaves a body standing for the grace period; this says the
   * disconnection was chosen, so the body goes at once. Pulling the plug and
   * logging out should not look the same to the world, and this is the one bit
   * that tells them apart.
   */
  Goodbye: 0x16,
  /**
   * Put one attribute point somewhere (spec 147).
   *
   * Names the attribute by *ordinal* into `BASE_STAT_KEYS` rather than by
   * string: one byte instead of a length-prefixed name, and an ordinal out of
   * range is a rejection with nothing to parse. There is deliberately no "how
   * many" -- one message is one point, so a client cannot ask for a hundred and
   * hope the budget check has an off-by-one in it.
   */
  AllocateAttribute: 0x17,
  /** Hand every allocated point back, for coins. Priced and checked server-side. */
  RespecAttributes: 0x18,
  /**
   * Take a drop off the ground (spec 156).
   *
   * Names the drop's *entity id*, which is the only address it has -- a drop is
   * not in a container until it is in the bag. Answered with an `Inventory` at
   * the request id, exactly as `MoveItem` is, so the client's optimistic guess
   * is rolled back by the same path whether the server took the request or
   * refused it.
   *
   * **Legal before the drop's reveal has finished**, and served immediately when
   * it is. Anticipation is presentation; it is never a lock on the player's
   * hands.
   */
  PickUpItem: 0x19,
} as const;

export const ServerMessageType = {
  Welcome: 0x40,
  Delta: 0x41,
  Correction: 0x42,
  CombatResult: 0x43,
  Stats: 0x44,
  Chat: 0x45,
  Pong: 0x46,
  Error: 0x47,
  Disconnect: 0x48,
  /** Someone started casting: what, which phase, until when (spec 062). */
  CastState: 0x49,
  /** ...and how it finished: released, cancelled or interrupted. */
  CastEnded: 0x4a,
  /** A point cue to draw: an impact, a blast, a heal. */
  Effect: 0x4b,
  /** An ability the server refused, and why. */
  CastRejected: 0x4c,
  /**
   * The owner's live cooldowns (spec 065). Sent only to the player they belong
   * to, and only when they change -- a cooldown nobody can act on is nobody
   * else's business.
   */
  Cooldowns: 0x4d,
  /**
   * Everything about the map that is not per-chunk (spec 072): the grid, the
   * arena, the layer scalars and which chunks exist. Sent once, straight after
   * the welcome, because a client can ask for nothing until it has it.
   */
  MapInfo: 0x4e,
  /** One chunk of one layer, in answer to a `RequestChunk`. */
  MapChunk: 0x4f,
  /** A `RequestChunk` the server will not serve, and why. */
  ChunkDenied: 0x50,
  /**
   * Every map spawner and what its timer is doing (spec 076). Sent on the
   * broadcast cadence, and only to a connection that asked with
   * `WatchSpawners`.
   */
  SpawnerStates: 0x51,
  /**
   * What the player is carrying and wearing, whole (spec 126).
   *
   * Whole rather than as a delta, and deliberately: twenty-four slots of an id
   * and a count is a few hundred bytes, where a delta would be a second
   * description of the same state that can drift from it. The client's
   * optimistic guess is *replaced* by what arrives, so rollback is not a code
   * path -- it is what happens when the resend disagrees, and it therefore
   * cannot rot from disuse.
   */
  Inventory: 0x52,
  /**
   * What a vendor is offering, and what can be bought back from it (spec 129).
   *
   * An empty `vendorId` means "the shop is closed" -- the answer to walking away
   * and to a refusal alike, so a client never has to infer that it has been shut
   * out from the absence of a message.
   */
  VendorState: 0x53,
  /**
   * The whole trade as it now stands, to both sides (spec 132).
   *
   * Whole and to both, on every change, for the reason `Inventory` is whole: a
   * client never derives what the other player is offering, it is told -- and
   * what it draws is exactly what the server would swap. It carries the
   * revision, which is what an acceptance has to name.
   *
   * A `stage` of `done` or `cancelled` is the last one a trade sends, and it
   * carries the reason so a player is told *why* rather than watching a window
   * disappear.
   */
  TradeState: 0x54,
  /**
   * A drop in the world, and how much of it this client is allowed to know
   * (spec 156).
   *
   * Sent when a drop first enters a connection's interest set -- which the delta
   * already computes, so there is no second visibility system -- and again on
   * the tick it reveals.
   *
   * **The item's identity is not on it until the reveal**: `defId` is empty and
   * `count` is zero, so a client that has not been told what the drop is does
   * not have it to leak. What *is* sent up front is the tier, because the
   * anticipation cue is tier-shaped and playing it needs the tier. That is the
   * "notice" step; the payoff is what is being withheld.
   */
  LootDrop: 0x55,
} as const;

/** A trade's stage, as a byte (spec 132). Mirrors `TradeStage` in `trade.ts`. */
export const TradeStageValue = {
  Offered: 0,
  Open: 1,
  Confirmed: 2,
  Done: 3,
  Cancelled: 4,
} as const;

/** What a spawner is doing, as a byte (spec 076). */
export const SpawnerStateValue = {
  /** Its monster is alive; there is no timer running. */
  Occupied: 0,
  /** Empty, and counting down to the next one. */
  Waiting: 1,
} as const;

/** Why a chunk request was refused (spec 072). */
export const ChunkDeniedReason = {
  /** The player is not standing near enough to that chunk to be told about it. */
  OutOfRange: 0,
  /** No such chunk was ever baked. The client remembers this and stops asking. */
  Unknown: 1,
  /** Asking too fast. The client backs off and re-asks. */
  Throttled: 2,
} as const;

/** Bit flags on a wire prop, mirroring `MapProp`'s two optional fields. */
export const MapPropFlag = {
  Align: 1 << 0,
  Uniform: 1 << 1,
} as const;

/**
 * The marker kinds, in wire order: a marker's byte is its index here, so new
 * kinds are appended and none is ever reordered or removed in place.
 */
export const MapMarkerKindValue = ['spawn', 'objective', 'campfire', 'trigger', 'spawner'] as const;

export const AdminMessageType = {
  Auth: 0x80,
  ListPlayers: 0x81,
  Kick: 0x82,
  Ban: 0x83,
  Mute: 0x84,
  Teleport: 0x85,
  SpawnEntity: 0x86,
  DespawnEntity: 0x87,
  TriggerEvent: 0x88,
  Broadcast: 0x89,
  SetConfig: 0x8a,
  GetConfig: 0x8b,
  GetAudit: 0x8c,
  /** Edit a character's level or experience (spec 154). */
  SetProgress: 0x8d,
  GiveItem: 0x8e,
  /** The item table, so the console has a list rather than remembered ids. */
  GetItems: 0x8f,
  Kill: 0x90,
} as const;

/**
 * Which field of a character's progression an `admin:setProgress` edits, and
 * whether it adds to it or replaces it (spec 154).
 *
 * Four operator asks -- give levels, give experience, reset levels, reset
 * experience -- are two verbs over two fields, so they are a mode on one message
 * rather than four type bytes. A reset is `SetLevel 1` or `SetExperience 0`,
 * which is what keeps it from being a third code path with its own idea of what
 * a consistent record looks like.
 */
export const AdminProgressMode = {
  AddLevels: 0,
  SetLevel: 1,
  AddExperience: 2,
  SetExperience: 3,
} as const;

export type AdminProgressModeValue =
  (typeof AdminProgressMode)[keyof typeof AdminProgressMode];

export function isAdminProgressMode(value: number): value is AdminProgressModeValue {
  return (Object.values(AdminProgressMode) as readonly number[]).includes(value);
}

export const AdminReplyType = {
  Ok: 0xa0,
  Error: 0xa1,
  PlayerList: 0xa2,
  Config: 0xa3,
  Audit: 0xa4,
  /** The item table (spec 154). */
  ItemList: 0xa5,
} as const;

export const ADMIN_REQUEST_MIN = 0x80;
export const ADMIN_REQUEST_MAX = 0x9f;

/** True for the `admin:*` namespace -- the one check that gates privileged routing. */
export function isAdminRequest(type: number): boolean {
  return type >= ADMIN_REQUEST_MIN && type <= ADMIN_REQUEST_MAX;
}

/** Human-readable name for a type byte, for logs and audit entries. */
export function messageTypeName(type: number): string {
  for (const [name, value] of Object.entries(ClientMessageType)) {
    if (value === type) return name;
  }
  for (const [name, value] of Object.entries(ServerMessageType)) {
    if (value === type) return `S_${name}`;
  }
  for (const [name, value] of Object.entries(AdminMessageType)) {
    if (value === type) return `admin:${name[0]?.toLowerCase() ?? ''}${name.slice(1)}`;
  }
  for (const [name, value] of Object.entries(AdminReplyType)) {
    if (value === type) return `admin:reply:${name}`;
  }
  return `unknown(0x${type.toString(16)})`;
}

/** Button bits packed into the input frame's single flags byte. */
export const InputButton = {
  Attack: 1 << 0,
  Parry: 1 << 1,
  Dodge: 1 << 2,
  Sprint: 1 << 3,
} as const;

/**
 * Which fields of an entity record are present in a delta. Absent bit = the
 * field did not change since this client's last acknowledged snapshot, so it is
 * simply not on the wire.
 */
/**
 * Which fields an entity delta carries.
 *
 * **A varuint on the wire, not a byte** (spec 147). Spec 145's `Identity` took
 * the eighth and last bit of the byte this used to be, and poise and shields
 * need two more -- so the field is widened rather than the two of them being
 * folded into one flag. Folding would have been cheaper to write and wrong to
 * live with: poise changes on almost every tick of a fight and a shield changes
 * almost never, so one shared bit would put eight bytes of shield on the wire
 * every time a guard ticked. A varuint costs nothing for the common deltas --
 * position and facing is 6, still one byte -- and one extra byte only on the
 * rare frame that carries a shield.
 */
export const EntityField = {
  /** Identity, sent once when the entity enters this client's interest set. */
  Spawn: 1 << 0,
  Position: 1 << 1,
  Facing: 1 << 2,
  Health: 1 << 3,
  Activity: 1 << 4,
  Level: 1 << 5,
  /**
   * Who this is: `str name` and `f32 turnRate` (spec 145). Players only -- a
   * monster's name and turn rate are in `MONSTERS`, which the client already
   * has, and a content table on the wire is what "an entity only ever stores an
   * id" exists to prevent. A player's name is the one field on an entity that a
   * human typed and no table can answer.
   */
  Identity: 1 << 6,
  /**
   * Guard left, as a fraction (spec 147).
   *
   * A fraction rather than a pair of absolutes, and one byte rather than eight:
   * a client draws a bar, and the only question a bar asks is "how full". The
   * absolute pool is a build detail nobody watching a fight needs.
   */
  Poise: 1 << 7,
  /** Absorb left, in health units, and the tick it falls off whole. */
  Shield: 1 << 8,
} as const;

export const EntityKind = {
  Player: 0,
  Monster: 1,
  Prop: 2,
  Projectile: 3,
  /**
   * An item on the ground (spec 156). Its `typeId` is **empty** and stays empty:
   * what the item is travels on `LootDrop`, not on the entity record every
   * client in range is handed.
   */
  Drop: 4,
} as const;

export const EntityActivity = {
  Idle: 0,
  Moving: 1,
  Casting: 2,
  Stunned: 3,
  Dead: 4,
} as const;

/** Mirrors `sim/types.ts`; the client animates from this. */
export const CastPhaseValue = {
  Windup: 0,
  Channel: 1,
  /**
   * The follow-through after the attack point (spec 144). Committed: the blow
   * has landed and walking out of this refunds nothing.
   */
  Backswing: 2,
  /** Turning to face the aim before the wind-up starts (spec 065). */
  Turning: 3,
} as const;

export const CastEndReasonValue = {
  Released: 0,
  /** Withdrawn before the attack point. **The attack did not happen.** */
  Cancelled: 1,
  Interrupted: 2,
  /**
   * Walked out of the follow-through (spec 144). **The attack already
   * happened**: nothing is refunded and the attack interval runs on.
   */
  BackswingCancelled: 3,
} as const;

/** Why the server overrode a client's predicted position. */
export const CorrectionReason = {
  /** Prediction drifted past the divergence threshold. */
  Divergence: 0,
  /** The requested move exceeded what the player's speed allows. */
  SpeedViolation: 1,
  /** The requested position was inside a collider or off the world. */
  Collision: 2,
  /** An admin moved them. */
  Teleport: 3,
  /**
   * The prediction is slightly wrong and the client should ease onto the
   * server's answer rather than snap to it (spec 067). Everything above is a
   * client that cannot be believed; this one is a client that is trying and
   * missing, which is the ordinary case on a real connection.
   */
  Drift: 4,
} as const;

export const ErrorCode = {
  BadProtocolVersion: 1,
  MalformedFrame: 2,
  NotAuthenticated: 3,
  NotAuthorized: 4,
  Banned: 5,
  Muted: 6,
  RejectedAction: 7,
  UnknownMessage: 8,
} as const;

export const ChatChannel = {
  Say: 0,
  System: 1,
  AdminBroadcast: 2,
} as const;
