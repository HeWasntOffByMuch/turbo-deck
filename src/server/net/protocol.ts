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
} as const;

export const AdminReplyType = {
  Ok: 0xa0,
  Error: 0xa1,
  PlayerList: 0xa2,
  Config: 0xa3,
  Audit: 0xa4,
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
export const EntityField = {
  /** Identity, sent once when the entity enters this client's interest set. */
  Spawn: 1 << 0,
  Position: 1 << 1,
  Facing: 1 << 2,
  Health: 1 << 3,
  Activity: 1 << 4,
  Level: 1 << 5,
  /** What the body is holding in its main hand (spec 121). */
  MainHand: 1 << 6,
} as const;

export const EntityKind = {
  Player: 0,
  Monster: 1,
  Prop: 2,
  Projectile: 3,
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
  /** Turning to face the aim before the wind-up starts (spec 065). */
  Turning: 3,
} as const;

export const CastEndReasonValue = {
  Released: 0,
  Cancelled: 1,
  Interrupted: 2,
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
