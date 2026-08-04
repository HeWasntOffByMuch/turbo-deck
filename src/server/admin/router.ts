/**
 * The `admin:*` router (spec 056).
 *
 * Deliberately knows nothing about sockets or about the game -- it takes a
 * decoded request and an {@link AdminHost} that can actually do things, and
 * returns a reply. That lets every admin action be tested by calling `handle`
 * with a hand-built request, which is the only practical way to get coverage on
 * "an expired token cannot kick anyone".
 *
 * Two invariants it enforces, in this order:
 *
 *  1. **Every message re-verifies the token.** Authentication is not a flag set
 *     once at connect; the token is stored on the connection and checked again
 *     on each request, so expiry takes effect immediately.
 *  2. **Every decision is audited** -- accepted or refused, with the actor's
 *     name from the token's `sub` claim rather than anything the client said.
 */

import {
  type AdminConfigReply,
  type AdminPlayerRow,
  type AdminReply,
  type AdminRequest,
} from '../net/admin-messages.js';
import { AdminMessageType, AdminReplyType, messageTypeName } from '../net/protocol.js';
import type { AuditEntry } from '../state/types.js';
import type { AuditLog } from './audit.js';
import { verifyAdminToken } from './auth.js';

/**
 * What the server must be able to do for an admin. Implemented by `GameServer`;
 * a fake implementation is all a test needs.
 */
export interface AdminHost {
  listPlayers(): readonly AdminPlayerRow[];
  kick(playerId: string, reason: string): boolean;
  ban(playerId: string, seconds: number, reason: string, issuedBy: string): Promise<boolean>;
  mute(playerId: string, seconds: number, issuedBy: string): Promise<boolean>;
  teleport(playerId: string, x: number, y: number): boolean;
  /** Returns how many were actually spawned. */
  spawnEntities(entityType: string, x: number, y: number, count: number): number;
  despawnEntity(entityId: number): boolean;
  /** Returns a human-readable description of what the event did. */
  triggerEvent(eventName: string, x: number, y: number, magnitude: number): string;
  /** Returns how many connections received it. */
  broadcast(text: string): number;
  /** Returns the stored (possibly clamped) value, or null if the key is unknown. */
  setConfig(key: string, value: number): number | null;
  getConfig(): readonly (readonly [string, number])[];
}

/** Per-connection admin state. Holds the token, never a bare "is admin" boolean. */
export interface AdminConnectionState {
  token: string | null;
  /** Cached from the last successful verify, for logging a rejection's actor. */
  lastKnownActor: string;
}

export function createAdminConnectionState(): AdminConnectionState {
  return { token: null, lastKnownActor: 'anonymous' };
}

export type Clock = () => number;

export class AdminRouter {
  constructor(
    private readonly host: AdminHost,
    private readonly audit: AuditLog,
    private readonly secret: string,
    private readonly now: Clock = () => Date.now(),
  ) {}

  async handle(
    connection: AdminConnectionState,
    request: AdminRequest,
  ): Promise<AdminReply> {
    const actionName = messageTypeName(request.type);

    // Auth is the one message that may arrive unauthenticated.
    if (request.type === AdminMessageType.Auth) {
      const verified = verifyAdminToken(request.token, this.secret, this.now());
      if (!verified.ok) {
        connection.token = null;
        await this.audit.record('anonymous', actionName, '-', verified.reason, false);
        return this.error(request.type, `authentication failed: ${verified.reason}`);
      }
      connection.token = request.token;
      connection.lastKnownActor = verified.claims.sub;
      await this.audit.record(verified.claims.sub, actionName, '-', 'authenticated', true);
      return this.ok(request.type, `authenticated as ${verified.claims.sub}`);
    }

    // Everything else re-checks the stored token, every time.
    const actor = this.authenticate(connection);
    if (!actor.ok) {
      await this.audit.record(connection.lastKnownActor, actionName, '-', actor.reason, false);
      return this.error(request.type, actor.reason);
    }

    return this.dispatch(actor.subject, request, actionName);
  }

  private authenticate(
    connection: AdminConnectionState,
  ): { readonly ok: true; readonly subject: string } | { readonly ok: false; readonly reason: string } {
    if (connection.token === null) return { ok: false, reason: 'not authenticated' };
    const verified = verifyAdminToken(connection.token, this.secret, this.now());
    if (!verified.ok) {
      connection.token = null;
      return { ok: false, reason: verified.reason };
    }
    connection.lastKnownActor = verified.claims.sub;
    return { ok: true, subject: verified.claims.sub };
  }

  private async dispatch(
    actor: string,
    request: AdminRequest,
    actionName: string,
  ): Promise<AdminReply> {
    switch (request.type) {
      case AdminMessageType.Auth:
        // Handled before dispatch; listed so the switch stays exhaustive.
        return this.ok(request.type, 'already authenticated');

      case AdminMessageType.ListPlayers: {
        const players = this.host.listPlayers();
        await this.audit.record(actor, actionName, '-', `${players.length} online`, true);
        return { type: AdminReplyType.PlayerList, players };
      }

      case AdminMessageType.Kick: {
        const done = this.host.kick(request.playerId, request.reason);
        await this.audit.record(actor, actionName, request.playerId, request.reason, done);
        return done
          ? this.ok(request.type, `kicked ${request.playerId}`)
          : this.error(request.type, `${request.playerId} is not connected`);
      }

      case AdminMessageType.Ban: {
        const done = await this.host.ban(request.playerId, request.seconds, request.reason, actor);
        const duration = request.seconds > 0 ? `${request.seconds}s` : 'permanent';
        await this.audit.record(
          actor,
          actionName,
          request.playerId,
          `${duration}: ${request.reason}`,
          done,
        );
        return done
          ? this.ok(request.type, `banned ${request.playerId} (${duration})`)
          : this.error(request.type, `could not ban ${request.playerId}`);
      }

      case AdminMessageType.Mute: {
        const done = await this.host.mute(request.playerId, request.seconds, actor);
        await this.audit.record(actor, actionName, request.playerId, `${request.seconds}s`, done);
        return done
          ? this.ok(request.type, `muted ${request.playerId} for ${request.seconds}s`)
          : this.error(request.type, `could not mute ${request.playerId}`);
      }

      case AdminMessageType.Teleport: {
        const done = this.host.teleport(request.playerId, request.x, request.y);
        await this.audit.record(
          actor,
          actionName,
          request.playerId,
          `to ${request.x.toFixed(1)}, ${request.y.toFixed(1)}`,
          done,
        );
        return done
          ? this.ok(request.type, `teleported ${request.playerId}`)
          : this.error(request.type, `${request.playerId} is not in the world`);
      }

      case AdminMessageType.SpawnEntity: {
        const spawned = this.host.spawnEntities(
          request.entityType,
          request.x,
          request.y,
          request.count,
        );
        await this.audit.record(
          actor,
          actionName,
          request.entityType,
          `${spawned} at ${request.x.toFixed(1)}, ${request.y.toFixed(1)}`,
          spawned > 0,
        );
        return spawned > 0
          ? this.ok(request.type, `spawned ${spawned} x ${request.entityType}`)
          : this.error(request.type, `could not spawn ${request.entityType}`);
      }

      case AdminMessageType.DespawnEntity: {
        const done = this.host.despawnEntity(request.entityId);
        await this.audit.record(actor, actionName, String(request.entityId), '', done);
        return done
          ? this.ok(request.type, `despawned ${request.entityId}`)
          : this.error(request.type, `no entity ${request.entityId}`);
      }

      case AdminMessageType.TriggerEvent: {
        const description = this.host.triggerEvent(
          request.eventName,
          request.x,
          request.y,
          request.magnitude,
        );
        const accepted = description.length > 0;
        await this.audit.record(actor, actionName, request.eventName, description, accepted);
        return accepted
          ? this.ok(request.type, description)
          : this.error(request.type, `unknown event: ${request.eventName}`);
      }

      case AdminMessageType.Broadcast: {
        const recipients = this.host.broadcast(request.text);
        await this.audit.record(actor, actionName, '-', request.text, true);
        return this.ok(request.type, `broadcast to ${recipients} connection(s)`);
      }

      case AdminMessageType.SetConfig: {
        const stored = this.host.setConfig(request.key, request.value);
        const accepted = stored !== null;
        await this.audit.record(
          actor,
          actionName,
          request.key,
          accepted ? `= ${stored}` : `rejected value ${request.value}`,
          accepted,
        );
        return accepted
          ? this.ok(request.type, `${request.key} = ${stored}`)
          : this.error(request.type, `unknown or invalid config key: ${request.key}`);
      }

      case AdminMessageType.GetConfig: {
        const reply: AdminConfigReply = {
          type: AdminReplyType.Config,
          entries: this.host.getConfig(),
        };
        return reply;
      }

      case AdminMessageType.GetAudit: {
        const entries: readonly AuditEntry[] = await this.audit.recent(request.limit);
        return { type: AdminReplyType.Audit, entries };
      }
    }
  }

  private ok(requestType: number, message: string): AdminReply {
    return { type: AdminReplyType.Ok, requestType, message };
  }

  private error(requestType: number, message: string): AdminReply {
    return { type: AdminReplyType.Error, requestType, message };
  }
}
