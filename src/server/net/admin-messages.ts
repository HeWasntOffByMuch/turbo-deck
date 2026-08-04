/**
 * The `admin:*` namespace on the wire (spec 056). Same connection, same frame
 * shape as a game message -- only the type byte differs, which is what makes
 * routing a single range check rather than a second listening socket.
 */

import type { AuditEntry } from '../state/types.js';
import { BufferReader, BufferWriter, CodecError } from './codec.js';
import { AdminMessageType, AdminReplyType } from './protocol.js';

export interface AdminAuthRequest {
  readonly type: typeof AdminMessageType.Auth;
  readonly token: string;
}

export interface AdminListPlayersRequest {
  readonly type: typeof AdminMessageType.ListPlayers;
}

export interface AdminKickRequest {
  readonly type: typeof AdminMessageType.Kick;
  readonly playerId: string;
  readonly reason: string;
}

export interface AdminBanRequest {
  readonly type: typeof AdminMessageType.Ban;
  readonly playerId: string;
  /** Seconds; 0 means permanent. */
  readonly seconds: number;
  readonly reason: string;
}

export interface AdminMuteRequest {
  readonly type: typeof AdminMessageType.Mute;
  readonly playerId: string;
  readonly seconds: number;
}

export interface AdminTeleportRequest {
  readonly type: typeof AdminMessageType.Teleport;
  readonly playerId: string;
  readonly x: number;
  readonly y: number;
}

export interface AdminSpawnRequest {
  readonly type: typeof AdminMessageType.SpawnEntity;
  readonly entityType: string;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

export interface AdminDespawnRequest {
  readonly type: typeof AdminMessageType.DespawnEntity;
  readonly entityId: number;
}

/** A named world event at a point -- "spawn a raid here", and its siblings. */
export interface AdminEventRequest {
  readonly type: typeof AdminMessageType.TriggerEvent;
  readonly eventName: string;
  readonly x: number;
  readonly y: number;
  readonly magnitude: number;
}

export interface AdminBroadcastRequest {
  readonly type: typeof AdminMessageType.Broadcast;
  readonly text: string;
}

export interface AdminSetConfigRequest {
  readonly type: typeof AdminMessageType.SetConfig;
  readonly key: string;
  readonly value: number;
}

export interface AdminGetConfigRequest {
  readonly type: typeof AdminMessageType.GetConfig;
}

export interface AdminGetAuditRequest {
  readonly type: typeof AdminMessageType.GetAudit;
  readonly limit: number;
}

export type AdminRequest =
  | AdminAuthRequest
  | AdminListPlayersRequest
  | AdminKickRequest
  | AdminBanRequest
  | AdminMuteRequest
  | AdminTeleportRequest
  | AdminSpawnRequest
  | AdminDespawnRequest
  | AdminEventRequest
  | AdminBroadcastRequest
  | AdminSetConfigRequest
  | AdminGetConfigRequest
  | AdminGetAuditRequest;

export function encodeAdminRequest(request: AdminRequest): Uint8Array {
  const writer = new BufferWriter(64);
  writer.u8(request.type);
  switch (request.type) {
    case AdminMessageType.Auth:
      writer.str(request.token);
      break;
    case AdminMessageType.ListPlayers:
    case AdminMessageType.GetConfig:
      break;
    case AdminMessageType.Kick:
      writer.str(request.playerId).str(request.reason);
      break;
    case AdminMessageType.Ban:
      writer.str(request.playerId).u32(request.seconds).str(request.reason);
      break;
    case AdminMessageType.Mute:
      writer.str(request.playerId).u32(request.seconds);
      break;
    case AdminMessageType.Teleport:
      writer.str(request.playerId).f32(request.x).f32(request.y);
      break;
    case AdminMessageType.SpawnEntity:
      writer.str(request.entityType).f32(request.x).f32(request.y).u16(request.count);
      break;
    case AdminMessageType.DespawnEntity:
      writer.varuint(request.entityId);
      break;
    case AdminMessageType.TriggerEvent:
      writer.str(request.eventName).f32(request.x).f32(request.y).f32(request.magnitude);
      break;
    case AdminMessageType.Broadcast:
      writer.str(request.text);
      break;
    case AdminMessageType.SetConfig:
      writer.str(request.key).f64(request.value);
      break;
    case AdminMessageType.GetAudit:
      writer.u16(request.limit);
      break;
  }
  return writer.toBytes();
}

export function decodeAdminRequest(frame: Uint8Array): AdminRequest {
  const reader = new BufferReader(frame);
  const type = reader.u8();
  switch (type) {
    case AdminMessageType.Auth:
      return { type: AdminMessageType.Auth, token: reader.str() };
    case AdminMessageType.ListPlayers:
      return { type: AdminMessageType.ListPlayers };
    case AdminMessageType.GetConfig:
      return { type: AdminMessageType.GetConfig };
    case AdminMessageType.Kick:
      return { type: AdminMessageType.Kick, playerId: reader.str(), reason: reader.str() };
    case AdminMessageType.Ban:
      return {
        type: AdminMessageType.Ban,
        playerId: reader.str(),
        seconds: reader.u32(),
        reason: reader.str(),
      };
    case AdminMessageType.Mute:
      return { type: AdminMessageType.Mute, playerId: reader.str(), seconds: reader.u32() };
    case AdminMessageType.Teleport:
      return {
        type: AdminMessageType.Teleport,
        playerId: reader.str(),
        x: reader.f32(),
        y: reader.f32(),
      };
    case AdminMessageType.SpawnEntity:
      return {
        type: AdminMessageType.SpawnEntity,
        entityType: reader.str(),
        x: reader.f32(),
        y: reader.f32(),
        count: reader.u16(),
      };
    case AdminMessageType.DespawnEntity:
      return { type: AdminMessageType.DespawnEntity, entityId: reader.varuint() };
    case AdminMessageType.TriggerEvent:
      return {
        type: AdminMessageType.TriggerEvent,
        eventName: reader.str(),
        x: reader.f32(),
        y: reader.f32(),
        magnitude: reader.f32(),
      };
    case AdminMessageType.Broadcast:
      return { type: AdminMessageType.Broadcast, text: reader.str() };
    case AdminMessageType.SetConfig:
      return { type: AdminMessageType.SetConfig, key: reader.str(), value: reader.f64() };
    case AdminMessageType.GetAudit:
      return { type: AdminMessageType.GetAudit, limit: reader.u16() };
    default:
      throw new CodecError(`unknown admin request type 0x${type.toString(16)}`);
  }
}

// --- replies ------------------------------------------------------------

/** One row of the connected-player table the admin console renders. */
export interface AdminPlayerRow {
  readonly playerId: string;
  readonly displayName: string;
  readonly entityId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly zone: string;
  readonly chunk: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly level: number;
  readonly attackDamage: number;
  readonly moveSpeed: number;
  readonly muted: boolean;
}

export interface AdminOkReply {
  readonly type: typeof AdminReplyType.Ok;
  readonly requestType: number;
  readonly message: string;
}

export interface AdminErrorReply {
  readonly type: typeof AdminReplyType.Error;
  readonly requestType: number;
  readonly message: string;
}

export interface AdminPlayerListReply {
  readonly type: typeof AdminReplyType.PlayerList;
  readonly players: readonly AdminPlayerRow[];
}

export interface AdminConfigReply {
  readonly type: typeof AdminReplyType.Config;
  readonly entries: readonly (readonly [string, number])[];
}

export interface AdminAuditReply {
  readonly type: typeof AdminReplyType.Audit;
  readonly entries: readonly AuditEntry[];
}

export type AdminReply =
  | AdminOkReply
  | AdminErrorReply
  | AdminPlayerListReply
  | AdminConfigReply
  | AdminAuditReply;

export function encodeAdminReply(reply: AdminReply): Uint8Array {
  const writer = new BufferWriter(256);
  writer.u8(reply.type);
  switch (reply.type) {
    case AdminReplyType.Ok:
    case AdminReplyType.Error:
      writer.u8(reply.requestType).str(reply.message);
      break;
    case AdminReplyType.PlayerList:
      writer.varuint(reply.players.length);
      for (const row of reply.players) {
        writer
          .str(row.playerId)
          .str(row.displayName)
          .varuint(row.entityId)
          .f32(row.x)
          .f32(row.y)
          .f32(row.z)
          .str(row.zone)
          .str(row.chunk)
          .f32(row.health)
          .f32(row.maxHealth)
          .varuint(row.level)
          .f32(row.attackDamage)
          .f32(row.moveSpeed)
          .bool(row.muted);
      }
      break;
    case AdminReplyType.Config:
      writer.varuint(reply.entries.length);
      for (const [key, value] of reply.entries) writer.str(key).f64(value);
      break;
    case AdminReplyType.Audit:
      writer.varuint(reply.entries.length);
      for (const entry of reply.entries) {
        writer
          .f64(entry.at)
          .str(entry.actor)
          .str(entry.action)
          .str(entry.target)
          .str(entry.detail)
          .bool(entry.accepted);
      }
      break;
  }
  return writer.toBytes();
}

export function decodeAdminReply(frame: Uint8Array): AdminReply {
  const reader = new BufferReader(frame);
  const type = reader.u8();
  switch (type) {
    case AdminReplyType.Ok:
      return { type: AdminReplyType.Ok, requestType: reader.u8(), message: reader.str() };
    case AdminReplyType.Error:
      return { type: AdminReplyType.Error, requestType: reader.u8(), message: reader.str() };
    case AdminReplyType.PlayerList: {
      const count = reader.varuint();
      const players: AdminPlayerRow[] = [];
      for (let i = 0; i < count; i++) {
        players.push({
          playerId: reader.str(),
          displayName: reader.str(),
          entityId: reader.varuint(),
          x: reader.f32(),
          y: reader.f32(),
          z: reader.f32(),
          zone: reader.str(),
          chunk: reader.str(),
          health: reader.f32(),
          maxHealth: reader.f32(),
          level: reader.varuint(),
          attackDamage: reader.f32(),
          moveSpeed: reader.f32(),
          muted: reader.bool(),
        });
      }
      return { type: AdminReplyType.PlayerList, players };
    }
    case AdminReplyType.Config: {
      const count = reader.varuint();
      const entries: (readonly [string, number])[] = [];
      for (let i = 0; i < count; i++) entries.push([reader.str(), reader.f64()] as const);
      return { type: AdminReplyType.Config, entries };
    }
    case AdminReplyType.Audit: {
      const count = reader.varuint();
      const entries: AuditEntry[] = [];
      for (let i = 0; i < count; i++) {
        entries.push({
          at: reader.f64(),
          actor: reader.str(),
          action: reader.str(),
          target: reader.str(),
          detail: reader.str(),
          accepted: reader.bool(),
        });
      }
      return { type: AdminReplyType.Audit, entries };
    }
    default:
      throw new CodecError(`unknown admin reply type 0x${type.toString(16)}`);
  }
}
