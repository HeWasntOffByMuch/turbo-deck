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
} as const;

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
  Recovering: 5,
} as const;

/** Mirrors `sim/types.ts`; the client animates from this. */
export const CastPhaseValue = {
  Windup: 0,
  Channel: 1,
  Recovery: 2,
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
  /** Knocked back by a combat result. */
  Knockback: 4,
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
