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
  /**
   * Spend one progression point (spec 244).
   *
   * One message for one economy. It replaced `SpendSkillPoint` at this opcode and
   * `AllocateAttribute` at 0x17, which were two requests for two currencies; with
   * one pool, two requests would be the split surviving in the one place a client
   * can see it. The payload names a *target*, never a result -- see
   * `SpendProgressionPointMessage`.
   */
  SpendProgressionPoint: 0x06,
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
   *
   * 0x17 is retired rather than reused (spec 244): it carried `AllocateAttribute`,
   * and an old client sending one would otherwise be answered by whatever took its
   * number.
   */
  /** Hand the whole build back, for coins. Priced and checked server-side. */
  RespecProgression: 0x18,
  /**
   * Take a drop off the ground (spec 158).
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
  /**
   * "Put me back on my feet" (spec 164). No payload.
   *
   * Honoured only from a connection whose body is at zero health, and honoured
   * at once when it is. Before this the server put a dead player back on a
   * timer, which meant death was a three-second pause rather than a state
   * somebody leaves on purpose -- and left the respawn button with nothing to be
   * the button *for*, since the wait would have ended either way.
   *
   * Nothing rides on it: a respawn is a fixed destination and a full heal, so a
   * payload would only be a client asking to arrive somewhere it chose.
   */
  Respawn: 0x1a,
  /**
   * Put a stack down in the world (spec 172).
   *
   * Names a slot address and a count, exactly as `MoveItem` does -- a drop is a
   * move whose target is the ground, and the ground has no slot to name. `0`
   * means the whole stack, the same convention and for the same reason: the wire
   * has no way to say "absent" and the rules have no use for a zero.
   *
   * Answered with an `Inventory` at the request id whether it was taken or
   * refused, which is what rolls a client's optimistic guess back.
   *
   * It also carries the point the cursor was over, and that is an *aim* rather
   * than a landing (spec 172): the body turns to face it first, at its own turn
   * rate, and the item is thrown a constant reach along that line whether the
   * point clicked was two paces away or on the horizon. A client naming where an
   * item lands is a client throwing one across the map.
   */
  DropItem: 0x1b,
  /**
   * Start or end a conversation with a friendly NPC (spec 246).
   *
   * An entity id of 0 ends whatever is in progress, the same convention
   * `OpenVendor`'s empty id already uses -- so there is one message rather than
   * two, and a client leaving cannot be a client that forgot to say it was
   * leaving.
   *
   * Refused, silently and with a `Conversation` naming 0, for a body that is
   * not an NPC, is out of its own `talkRadius`, is dead, or is already talking
   * to somebody else. The claim is what stops the body wandering; what it
   * *says* is a table both ends already have, so none of that is on the wire.
   */
  Talk: 0x1c,
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
   * (spec 158).
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
  LootDrop: 0x56,
  /**
   * Which NPC this client is talking to, or 0 for none (spec 246).
   *
   * The answer to a `Talk`, and also what arrives unasked when the server ends
   * one: walking out of range, either body dying, the NPC despawning. So a
   * client never has to infer that a conversation is over from the absence of
   * something, which is the same reason `VendorState` answers a refusal rather
   * than staying quiet.
   *
   * Sent only to the player in the conversation. Everybody else sees a body
   * that has stopped walking and turned, which is already replicated.
   */
  Conversation: 0x57,
  /**
   * The health economy's own two numbers (spec 156): how full the restoration
   * meter is, and how many flask charges are left.
   *
   * Owner-only and change-driven, exactly like `Cooldowns` and for the same
   * reasons. What another player has left to drink changes nothing this client
   * draws, and the entity delta is the one message that is paid for per entity.
   *
   * The meter rides as a *fraction*, never as the absolute number the sim keeps.
   * A bar only asks how full, the threshold is a tuning value that may move
   * between builds, and a client that knew its absolute progress would be a
   * client that could be asked to compute the next mote.
   */
  Restoration: 0x55,
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
  /**
   * Empty, and not coming back until its window opens (spec 268).
   *
   * Appended rather than slotted in, because a renumbering silently re-labels
   * every spawner on a client that has not been rebuilt. It is its own value
   * rather than a `Waiting` with a large `ticks` on it, because the overlay
   * exists to answer *is that camp about to come back* and the honest answer
   * here is "no" rather than a number -- what it is waiting for is the sun,
   * which is not a countdown this message has any business carrying.
   */
  Holding: 2,
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
  /**
   * This prop carries a light override, and two quantized numbers follow
   * (spec 250).
   *
   * A flag rather than two always-present fields, because almost no prop is a
   * fixture and almost no fixture overrides its kind's row -- so the common case
   * pays the bit it was already paying and nothing else. The same shape `align`
   * and `uniform` are in, one step further: those two *are* their own value,
   * this one says whether a value follows.
   */
  Light: 1 << 2,
  /**
   * This prop carries a message, and a `str` follows the light block if there
   * is one (spec 260).
   *
   * {@link MapPropFlag.Light}'s shape rather than {@link MapPropFlag.Align}'s,
   * and for its reason: almost no prop is a sign, so the common case pays the
   * bit it was already paying and nothing else. What follows is a `str` because
   * a message has no fixed length -- which is also why it is bounded before it
   * ever reaches here, by `MAX_SIGN_TEXT` in the parser.
   */
  Text: 1 << 3,
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
/**
 * What a progression point is being spent on (spec 244).
 *
 * The two things one pool buys, and the distinction the whole model rests on:
 * `Attribute` raises the attribute and advances the track, `Specialization`
 * deepens a mechanic a milestone unlocked and leaves the attribute where it is.
 */
export const ProgressionTarget = {
  Attribute: 0,
  Specialization: 1,
} as const;

export type ProgressionTargetValue = (typeof ProgressionTarget)[keyof typeof ProgressionTarget];

export function isProgressionTarget(value: number): value is ProgressionTargetValue {
  return (Object.values(ProgressionTarget) as readonly number[]).includes(value);
}

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
  /**
   * The timed states this body is carrying, as far as anybody may see them
   * (spec 186).
   *
   * `u8 count`, then per status `u8 wire`, `u8 stacks`, `u32 expiresAtTick`.
   * The index is `StatusVisual.wire` rather than the string id -- a content id
   * per status per body per delta is what "an entity only ever stores an id"
   * exists to prevent, and the table is shared code.
   *
   * An **absolute** expiry, like `activityUntilTick` and `shieldUntilTick` above
   * it, and for the same reason: it is what lets a client draw the mark as a
   * pure function of what it was told and the tick it is drawing, with nothing
   * observed and nothing kept. A late delta cannot leave a mark up, because the
   * drawing refuses a passed window the way `statusOf` refuses a stale entry.
   *
   * Bounded by `MAX_VISIBLE_STATUSES`, and set only in the deltas where the set
   * actually changed -- which for most bodies is never.
   */
  Statuses: 1 << 9,
  /**
   * How fast this body may move right now, as a fraction of its own speed
   * (spec 188).
   *
   * On the wire because a slow the owner's client does not know about is a
   * client predicting full speed against a server walking at 60% -- which the
   * correction machinery would dutifully fix, once a tick, for the whole
   * duration. Spec 173 accepted one round trip of that for a stagger *because*
   * `Activity` is replicated and the client stops the moment it sees it; a slow
   * has no such tell, so it gets one.
   *
   * A byte fraction, exactly like {@link Poise}, and sent to everyone rather
   * than only to the owner: a remote body being slowed changes how far the
   * interpolator should expect it to have travelled, and it is one byte.
   */
  MoveScale: 1 << 10,
} as const;

export const EntityKind = {
  Player: 0,
  Monster: 1,
  Prop: 2,
  Projectile: 3,
  /**
   * A restorative mote (spec 156). Mirrors `EntityKindValue.Mote`.
   *
   * Replicated to exactly one client -- its owner -- which is filtered in
   * `server.ts` rather than expressed on the wire: a mote nobody else is told
   * about cannot be stolen, cannot be raced for, and needs no ownership field
   * for a client to check.
   */
  Mote: 4,
  /**
   * An item on the ground (spec 158). Its `typeId` is **empty** and stays empty:
   * what the item is travels on `LootDrop`, not on the entity record every
   * client in range is handed.
   */
  Drop: 5,
} as const;

export const EntityActivity = {
  Idle: 0,
  Moving: 1,
  Casting: 2,
  Stunned: 3,
  Dead: 4,
  /** Changing an active skill (spec 188). Mirrors `ActivityValue.Swapping`. */
  Swapping: 5,
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
