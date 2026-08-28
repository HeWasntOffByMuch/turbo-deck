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
  type AdminItemRow,
  type AdminPlayerRow,
  type AdminReply,
  type AdminRequest,
} from '../net/admin-messages.js';
import {
  AdminMessageType,
  AdminProgressMode,
  AdminReplyType,
  messageTypeName,
  type AdminProgressModeValue,
} from '../net/protocol.js';
import type { AuditEntry } from '../state/types.js';
import type { AuditLog } from './audit.js';

/**
 * Checks a token and names who presented it (spec 057).
 *
 * Injected rather than imported so the router -- and through it the whole
 * server -- carries no dependency on `node:crypto`, which is what lets the
 * server be bundled into a browser tab for single-player. The Node entry point
 * supplies the HMAC implementation from `auth.ts`; an in-tab server supplies
 * nothing and gets {@link DENY_ALL_ADMIN}, because a server running inside a
 * player's own browser has no business having an admin channel at all.
 */
export type AdminTokenVerifier = (
  token: string,
  nowMs: number,
) =>
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false; readonly reason: string };

export const DENY_ALL_ADMIN: AdminTokenVerifier = () => ({
  ok: false,
  reason: 'the admin namespace is not enabled on this server',
});

/**
 * An action's result, with the reason it was refused (spec 154).
 *
 * The actions that came before this return `boolean`, or -- in `triggerEvent`'s
 * case -- a description where `''` means refused. Rather than adding a third
 * convention, the player actions added by spec 154 share one type, so "their bag
 * is full" and "no such item: sord.worn" reach the operator instead of being
 * flattened into "could not give item".
 */
export interface AdminOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * What the server must be able to do for an admin. Implemented by `GameServer`;
 * a fake implementation is all a test needs.
 */
export interface AdminHost {
  listPlayers(): readonly AdminPlayerRow[];
  /** The item table, so the console offers a list rather than remembered ids. */
  listItems(): readonly AdminItemRow[];
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

  // --- spec 154: the character edits an operator actually reaches for --------

  setProgress(
    playerId: string,
    mode: AdminProgressModeValue,
    amount: number,
  ): Promise<AdminOutcome>;
  giveItem(playerId: string, defId: string, count: number): Promise<AdminOutcome>;
  /** Zeroes a player's health and lets the world's own death path run. */
  kill(playerId: string): AdminOutcome;
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

/** The mode spelled out, so an audit entry reads without the protocol beside it. */
function progressModeName(mode: AdminProgressModeValue): string {
  switch (mode) {
    case AdminProgressMode.AddLevels:
      return 'addLevels';
    case AdminProgressMode.SetLevel:
      return 'setLevel';
    case AdminProgressMode.AddExperience:
      return 'addExperience';
    case AdminProgressMode.SetExperience:
      return 'setExperience';
  }
}

export class AdminRouter {
  constructor(
    private readonly host: AdminHost,
    private readonly audit: AuditLog,
    private readonly verify: AdminTokenVerifier,
    private readonly now: Clock = () => Date.now(),
  ) {}

  async handle(
    connection: AdminConnectionState,
    request: AdminRequest,
  ): Promise<AdminReply> {
    const actionName = messageTypeName(request.type);

    // Auth is the one message that may arrive unauthenticated.
    if (request.type === AdminMessageType.Auth) {
      const verified = this.verify(request.token, this.now());
      if (!verified.ok) {
        connection.token = null;
        await this.audit.record('anonymous', actionName, '-', verified.reason, false);
        return this.error(request.type, `authentication failed: ${verified.reason}`);
      }
      connection.token = request.token;
      connection.lastKnownActor = verified.subject;
      await this.audit.record(verified.subject, actionName, '-', 'authenticated', true);
      return this.ok(request.type, `authenticated as ${verified.subject}`);
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
    const verified = this.verify(connection.token, this.now());
    if (!verified.ok) {
      connection.token = null;
      return { ok: false, reason: verified.reason };
    }
    connection.lastKnownActor = verified.subject;
    return { ok: true, subject: verified.subject };
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

      case AdminMessageType.ListPlayers:
        // Not audited (spec 154). The log records what an admin *did*, and asking
        // who is online is not something done to anybody -- its read siblings
        // `getConfig` and `getAudit` never recorded one either. It is also what
        // makes a live count possible: the console polls this once a second, and
        // an entry per poll would bury every real decision under "3 online".
        return { type: AdminReplyType.PlayerList, players: this.host.listPlayers() };

      case AdminMessageType.GetItems:
        return { type: AdminReplyType.ItemList, items: this.host.listItems() };

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

      case AdminMessageType.SetProgress: {
        const outcome = await this.host.setProgress(request.playerId, request.mode, request.amount);
        await this.audit.record(
          actor,
          actionName,
          request.playerId,
          `${progressModeName(request.mode)} ${request.amount}: ${outcome.detail}`,
          outcome.ok,
        );
        return outcome.ok
          ? this.ok(request.type, `${request.playerId}: ${outcome.detail}`)
          : this.error(request.type, outcome.detail);
      }

      case AdminMessageType.GiveItem: {
        const outcome = await this.host.giveItem(request.playerId, request.defId, request.count);
        await this.audit.record(
          actor,
          actionName,
          request.playerId,
          `${request.count} x ${request.defId}`,
          outcome.ok,
        );
        return outcome.ok
          ? this.ok(request.type, outcome.detail)
          : this.error(request.type, outcome.detail);
      }

      case AdminMessageType.Kill: {
        const outcome = this.host.kill(request.playerId);
        await this.audit.record(actor, actionName, request.playerId, outcome.detail, outcome.ok);
        return outcome.ok
          ? this.ok(request.type, outcome.detail)
          : this.error(request.type, outcome.detail);
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
