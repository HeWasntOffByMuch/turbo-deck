/**
 * The composition root (spec 056): transport, the tick loop, and every manager,
 * wired together. This is the only file that knows about sockets *and* about
 * the game; everything it calls is independently testable without either.
 *
 * The shape of a tick, in order:
 *
 *  1. drain one buffered input per connection -- one per tick, never more, so a
 *     client cannot buy extra movement by sending faster
 *  2. step the sim
 *  3. update chunk occupancy, and recompute which chunks are active
 *  4. mirror authoritative positions back into player records
 *  5. send the combat results and corrections that concern each client, and --
 *     every `BROADCAST_EVERY_N_TICKS` -- its delta
 *
 * Since spec 057 it holds no transport of its own: it is handed a
 * `ServerTransport`, which is what lets the same class run behind a socket in
 * Node and inside a browser tab for single-player.
 */

import { DEFAULT_WORLD } from '../sim/collision.js';
import type { WorldColliders } from '../sim/types.js';
import { AuditLog } from './admin/audit.js';
import {
  AdminRouter,
  createAdminConnectionState,
  DENY_ALL_ADMIN,
  type AdminConnectionState,
  type AdminHost,
  type AdminTokenVerifier,
} from './admin/router.js';
import {
  BROADCAST_EVERY_N_TICKS,
  CHUNK_SIZE,
  INTEREST_CHUNK_RADIUS,
  LIVE_CONFIG_KEYS,
  LiveConfigStore,
  MAX_BUFFERED_INPUTS,
  PROTOCOL_VERSION,
  RESPAWN_DELAY_TICKS,
  SERVER_TICK_MS,
  SERVER_TICK_RATE,
} from './config.js';
import { TickLoop } from './loop.js';
import { monsterById } from './data/monsters.js';
import { decodeAdminRequest, encodeAdminReply, type AdminPlayerRow } from './net/admin-messages.js';
import { CodecError } from './net/codec.js';
import { DeltaTracker } from './net/delta.js';
import {
  decodeClientMessage,
  encodeServerMessage,
  type ServerMessage,
} from './net/messages.js';
import {
  ChatChannel,
  ClientMessageType,
  CorrectionReason,
  ErrorCode,
  isAdminRequest,
  ServerMessageType,
} from './net/protocol.js';
import { DEFAULT_SPAWN, PlayerManager } from './player/player-manager.js';
import { MemoryDataStore } from './state/memory-store.js';
import type { DataStore } from './state/store.js';
import type { Vec3 } from './state/types.js';
import {
  ActivityValue,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './sim/types.js';
import {
  createWorldState,
  PLAYER_BODY_RADIUS,
  removeEntity,
  replaceEntity,
  spawnEntity,
  step,
} from './sim/world.js';
import { NullTransport, type Channel, type ServerTransport } from './net/transport.js';
import { ChunkManager } from './world/chunk-manager.js';
import type { BuiltWorld } from './world/build.js';
import { FLAT_TERRAIN, type TerrainSampler } from './world/terrain.js';
import { ZoneManager } from './world/zone-manager.js';

export interface GameServerOptions {
  readonly seed?: number;
  /**
   * How clients reach this server (spec 057). Omit for a server a test drives
   * by calling `tick()`; `WebSocketTransport` for a real one; `LoopbackTransport`
   * for single-player in a browser tab.
   */
  readonly transport?: ServerTransport;
  /**
   * Checks admin tokens. Omit and every `admin:*` message is refused -- which is
   * the right answer for a server running inside a player's own browser.
   */
  readonly adminVerifier?: AdminTokenVerifier;
  readonly store?: DataStore;
  readonly zones?: ZoneManager;
  readonly terrain?: TerrainSampler;
  readonly world?: WorldColliders;
  readonly tickMs?: number;
  /**
   * The generated world this server runs (spec 063). Supplies the seed, the
   * height sampler and the colliders *together*, so a caller cannot wire those
   * three to three different worlds -- which is precisely the bug that shipped
   * when they were three separate options: real terrain, and an empty
   * vegetation list beside it.
   *
   * The granular options above stay for tests, which mostly want a flat plane
   * and nothing to walk into.
   */
  readonly built?: BuiltWorld;
}

interface Connection {
  readonly channel: Channel;
  playerId: string | null;
  entityId: number;
  readonly delta: DeltaTracker;
  readonly admin: AdminConnectionState;
  /** Inputs waiting their turn; one is applied per tick. */
  readonly inputs: ServerInput[];
  lastSeq: number;
  /** Tick this player is put back on their feet; 0 when they are alive. */
  respawnAtTick: number;
  /**
   * The cooldown map last sent to this client. Compared by *identity*: entities
   * are immutable and the map is only rebuilt when it actually changes, so this
   * is a pointer compare per connection per tick rather than a walk.
   */
  sentCooldowns: Readonly<Record<string, number>> | null;
  /**
   * An ability asked for since the last tick, and whether a cancel was asked
   * for. Held here rather than on the input frame because a client sends them
   * as their own messages, and they must not be lost if no movement input
   * happens to arrive in the same tick.
   */
  pendingCast: { readonly abilityId: string; readonly targetX: number; readonly targetY: number } | null;
  pendingCancel: boolean;
}

export class GameServer implements AdminHost {
  private readonly zones: ZoneManager;
  private readonly terrain: TerrainSampler;
  private readonly colliders: WorldColliders;
  /** Announced in the welcome so a client can build the same ground (spec 063). */
  private readonly worldSeed: number;
  private readonly store: DataStore;
  private readonly config = new LiveConfigStore();
  private readonly chunks: ChunkManager;
  private readonly players: PlayerManager;
  private readonly audit: AuditLog;
  private readonly admin: AdminRouter;
  private readonly loop: TickLoop;
  private readonly connections = new Set<Connection>();
  private readonly transport: ServerTransport;
  private state: ServerWorldState;

  constructor(options: GameServerOptions = {}) {
    this.zones = options.zones ?? new ZoneManager();
    this.terrain = options.terrain ?? options.built?.sampler ?? FLAT_TERRAIN;
    this.colliders = options.world ?? options.built?.colliders ?? DEFAULT_WORLD;
    this.worldSeed = options.seed ?? options.built?.seed ?? 1;
    this.store = options.store ?? new MemoryDataStore();
    this.chunks = new ChunkManager(CHUNK_SIZE, INTEREST_CHUNK_RADIUS);
    this.players = new PlayerManager(this.store, this.zones);
    this.audit = new AuditLog(this.store);
    this.transport = options.transport ?? new NullTransport();
    this.admin = new AdminRouter(this, this.audit, options.adminVerifier ?? DENY_ALL_ADMIN);
    this.state = createWorldState(this.worldSeed);
    this.loop = new TickLoop(() => this.tick(), {
      tickMs: options.tickMs ?? SERVER_TICK_MS,
      onLag: (dropped) => {
        console.warn(`[server] dropped ${dropped} tick(s) of backlog`);
      },
    });
  }

  get world(): ServerWorldState {
    return this.state;
  }

  get liveConfig(): LiveConfigStore {
    return this.config;
  }

  get playerManager(): PlayerManager {
    return this.players;
  }

  start(): void {
    this.transport.onConnection((channel) => this.accept(channel));
    this.loop.start();
  }

  async stop(): Promise<void> {
    this.loop.stop();
    for (const connection of [...this.connections]) this.drop(connection, 'server shutting down');
    this.transport.close();
    await this.store.close();
  }

  // --- transport ---------------------------------------------------------

  /** Registers a connected channel. Public so a test can attach one directly. */
  accept(channel: Channel): Connection {
    const connection: Connection = {
      channel,
      playerId: null,
      entityId: -1,
      delta: new DeltaTracker(),
      admin: createAdminConnectionState(),
      inputs: [],
      lastSeq: 0,
      respawnAtTick: 0,
      pendingCast: null,
      pendingCancel: false,
      sentCooldowns: null,
    };
    this.connections.add(connection);
    channel.onMessage((bytes) => {
      void this.receive(connection, bytes);
    });
    channel.onClose(() => {
      void this.disconnect(connection);
    });
    return connection;
  }

  /** Exposed for tests: feed a frame in without a socket. */
  async receive(connection: Connection, frame: Uint8Array): Promise<void> {
    if (frame.length === 0) return;
    const type = frame[0] ?? 0;

    if (isAdminRequest(type)) {
      try {
        const request = decodeAdminRequest(frame);
        const reply = await this.admin.handle(connection.admin, request);
        this.sendRaw(connection, encodeAdminReply(reply));
      } catch (error) {
        if (error instanceof CodecError) {
          this.send(connection, {
            type: ServerMessageType.Error,
            code: ErrorCode.MalformedFrame,
            message: error.message,
          });
          return;
        }
        throw error;
      }
      return;
    }

    let message;
    try {
      message = decodeClientMessage(frame);
    } catch (error) {
      this.send(connection, {
        type: ServerMessageType.Error,
        code: ErrorCode.MalformedFrame,
        message: error instanceof Error ? error.message : 'bad frame',
      });
      return;
    }

    switch (message.type) {
      case ClientMessageType.Hello:
        await this.hello(connection, message.protocolVersion, message.playerId, message.displayName);
        break;

      case ClientMessageType.Input: {
        if (connection.playerId === null || connection.entityId < 0) return;
        // Out-of-order and replayed inputs are dropped: the sequence number is
        // the client's own, and only ever moving forward is the contract.
        if (message.seq <= connection.lastSeq) return;
        connection.lastSeq = message.seq;
        if (connection.inputs.length >= MAX_BUFFERED_INPUTS) connection.inputs.shift();
        connection.inputs.push({
          entityId: connection.entityId,
          seq: message.seq,
          moveX: message.moveX,
          moveY: message.moveY,
          facing: message.facing,
          buttons: message.buttons,
          predictedX: message.predictedX,
          predictedY: message.predictedY,
          hasPrediction: true,
          castAbilityId: '',
          castTargetX: 0,
          castTargetY: 0,
          cancelCast: false,
        });
        break;
      }

      case ClientMessageType.Ping:
        this.send(connection, {
          type: ServerMessageType.Pong,
          nonce: message.nonce,
          serverTick: this.state.tick,
        });
        break;

      case ClientMessageType.Equip: {
        if (connection.playerId === null) return;
        const result = await this.players.equip(connection.playerId, message.slot, message.itemId);
        this.reportAction(connection, result.ok ? null : result.reason);
        break;
      }

      case ClientMessageType.Unequip: {
        if (connection.playerId === null) return;
        const result = await this.players.unequip(connection.playerId, message.slot);
        this.reportAction(connection, result.ok ? null : result.reason);
        break;
      }

      case ClientMessageType.SpendSkillPoint: {
        if (connection.playerId === null) return;
        const result = await this.players.spendSkillPoint(connection.playerId, message.skillId);
        this.reportAction(connection, result.ok ? null : result.reason);
        break;
      }

      case ClientMessageType.UseAbility:
        if (connection.playerId === null || connection.entityId < 0) return;
        connection.pendingCast = {
          abilityId: message.abilityId,
          targetX: message.targetX,
          targetY: message.targetY,
        };
        break;

      case ClientMessageType.CancelCast:
        if (connection.playerId === null || connection.entityId < 0) return;
        connection.pendingCancel = true;
        break;

      case ClientMessageType.Chat: {
        if (connection.playerId === null) return;
        const session = this.players.get(connection.playerId);
        if (!session) return;
        if (session.muted) {
          this.send(connection, {
            type: ServerMessageType.Error,
            code: ErrorCode.Muted,
            message: 'you are muted',
          });
          return;
        }
        this.broadcastMessage({
          type: ServerMessageType.Chat,
          channel: ChatChannel.Say,
          from: session.displayName,
          text: message.text.slice(0, 240),
        });
        break;
      }
    }
  }

  private async hello(
    connection: Connection,
    protocolVersion: number,
    playerId: string,
    displayName: string,
  ): Promise<void> {
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.send(connection, {
        type: ServerMessageType.Error,
        code: ErrorCode.BadProtocolVersion,
        message: `server speaks protocol ${PROTOCOL_VERSION}`,
      });
      this.drop(connection, 'protocol mismatch');
      return;
    }
    if (playerId.length === 0 || playerId.length > 64) {
      this.send(connection, {
        type: ServerMessageType.Error,
        code: ErrorCode.RejectedAction,
        message: 'bad player id',
      });
      return;
    }

    const ban = await this.store.getBan(playerId);
    if (ban && ban.until > Date.now()) {
      this.send(connection, {
        type: ServerMessageType.Error,
        code: ErrorCode.Banned,
        message: `banned: ${ban.reason}`,
      });
      this.drop(connection, 'banned');
      return;
    }

    const session = await this.players.login(playerId, displayName);
    const spawned = spawnEntity(this.state, {
      kind: EntityKindValue.Player,
      typeId: 'player',
      ownerPlayerId: playerId,
      position: session.record.position,
      facing: session.record.facing,
      stats: session.stats,
      radius: PLAYER_BODY_RADIUS,
      level: session.record.level,
      zoneId: session.record.currentZone,
      health: session.record.health,
    });
    this.state = spawned.state;
    this.players.attachEntity(playerId, spawned.entity.id);

    connection.playerId = playerId;
    connection.entityId = spawned.entity.id;
    this.chunks.place(spawned.entity.id, session.record.position.x, session.record.position.y, true);

    this.send(connection, {
      type: ServerMessageType.Welcome,
      protocolVersion: PROTOCOL_VERSION,
      playerId,
      entityId: spawned.entity.id,
      tick: this.state.tick,
      tickRate: SERVER_TICK_RATE,
      chunkSize: CHUNK_SIZE,
      interestRadius: INTEREST_CHUNK_RADIUS,
      correctionThreshold: this.config.get().correctionThreshold,
      worldSeed: this.worldSeed,
    });
    this.sendStats(connection);
  }

  private async disconnect(connection: Connection): Promise<void> {
    if (!this.connections.has(connection)) return;
    this.connections.delete(connection);
    if (connection.entityId >= 0) {
      this.chunks.remove(connection.entityId);
      this.state = removeEntity(this.state, connection.entityId);
    }
    if (connection.playerId !== null) await this.players.logout(connection.playerId);
  }

  private drop(connection: Connection, reason: string): void {
    this.send(connection, { type: ServerMessageType.Disconnect, reason });
    connection.channel.close();
    void this.disconnect(connection);
  }

  private send(connection: Connection, message: ServerMessage): void {
    this.sendRaw(connection, encodeServerMessage(message));
  }

  private sendRaw(connection: Connection, bytes: Uint8Array): void {
    connection.channel.send(bytes);
  }

  private broadcastMessage(message: ServerMessage): number {
    const bytes = encodeServerMessage(message);
    let count = 0;
    for (const connection of this.connections) {
      if (connection.playerId === null) continue;
      this.sendRaw(connection, bytes);
      count += 1;
    }
    return count;
  }

  private reportAction(connection: Connection, rejection: string | null): void {
    if (rejection !== null) {
      this.send(connection, {
        type: ServerMessageType.Error,
        code: ErrorCode.RejectedAction,
        message: rejection,
      });
      return;
    }
    // Accepted: the client is told the *derived* result, never trusted to
    // compute it. This is the recalculation reaching the client.
    this.sendStats(connection);
    if (connection.entityId >= 0) {
      const session = connection.playerId ? this.players.get(connection.playerId) : null;
      const entity = this.state.entities.get(connection.entityId);
      if (session && entity) {
        this.state = replaceEntity(this.state, {
          ...entity,
          stats: session.stats,
          health: Math.min(entity.health, session.stats.maxHealth),
          level: session.record.level,
        });
      }
    }
  }

  /**
   * Tells a client what it may not use yet (spec 065). Only on change, and only
   * to the owner -- a cooldown is not something another player can act on.
   *
   * Entries already expired at send time are stripped -- the sim never prunes
   * its own map, keeping it a pure function of what has been cast rather than of
   * when it was last swept. An entry that expires *later*, with no cast in
   * between, is simply left with the client: its `readyAtTick` is in the past, so
   * the client's own `readyAtTick - tick` is negative and it draws nothing. The
   * map is keyed by ability id, so it is bounded by the ability table either way.
   */
  private sendCooldowns(connection: Connection, tick: number): void {
    if (connection.entityId < 0) return;
    const entity = this.state.entities.get(connection.entityId);
    if (!entity) return;
    if (entity.cooldowns === connection.sentCooldowns) return;
    connection.sentCooldowns = entity.cooldowns;

    this.send(connection, {
      type: ServerMessageType.Cooldowns,
      entries: Object.entries(entity.cooldowns)
        .filter(([, readyAtTick]) => readyAtTick > tick)
        .map(([abilityId, readyAtTick]) => ({ abilityId, readyAtTick })),
    });
  }

  private sendStats(connection: Connection): void {
    if (connection.playerId === null) return;
    const session = this.players.get(connection.playerId);
    if (!session) return;
    this.send(connection, {
      type: ServerMessageType.Stats,
      entityId: session.entityId,
      level: session.record.level,
      experience: session.record.experience,
      unspentSkillPoints: session.record.unspentSkillPoints,
      stats: session.stats,
    });
  }

  // --- the tick ----------------------------------------------------------

  /** One authoritative step. Public so tests can drive it without a clock. */
  tick(): void {
    const inputs: ServerInput[] = [];
    for (const connection of this.connections) {
      const next = connection.inputs.shift();
      const cast = connection.pendingCast;
      const cancel = connection.pendingCancel;
      connection.pendingCast = null;
      connection.pendingCancel = false;

      if (next) {
        if (connection.playerId !== null) {
          this.players.noteInputSeq(connection.playerId, next.seq);
        }
        inputs.push({
          ...next,
          castAbilityId: cast?.abilityId ?? '',
          castTargetX: cast?.targetX ?? 0,
          castTargetY: cast?.targetY ?? 0,
          cancelCast: cancel,
        });
      } else if ((cast || cancel) && connection.entityId >= 0) {
        // An ability asked for on a tick with no movement input still has to
        // reach the sim, or standing still would make you unable to act.
        inputs.push({
          entityId: connection.entityId,
          seq: connection.lastSeq,
          moveX: 0,
          moveY: 0,
          facing: this.state.entities.get(connection.entityId)?.facing ?? 0,
          buttons: 0,
          predictedX: 0,
          predictedY: 0,
          hasPrediction: false,
          castAbilityId: cast?.abilityId ?? '',
          castTargetX: cast?.targetX ?? 0,
          castTargetY: cast?.targetY ?? 0,
          cancelCast: cancel,
        });
      }
    }

    const result = step(this.state, inputs, {
      world: this.colliders,
      terrain: this.terrain,
      zones: this.zones,
      config: this.config.get(),
      activeChunks: new Set(this.chunks.activeChunks()),
      chunkSize: CHUNK_SIZE,
    });
    this.state = result.state;

    // Occupancy first, then activation: a chunk becomes active because a player
    // is already recorded in it, never in the same breath as the move.
    for (const entity of this.state.entities.values()) {
      this.chunks.place(
        entity.id,
        entity.position.x,
        entity.position.y,
        entity.kind === EntityKindValue.Player,
      );
    }
    for (const event of result.events) {
      if (event.kind === 'despawned') this.chunks.remove(event.entityId);
    }
    this.chunks.refreshActive();

    for (const connection of this.connections) {
      if (connection.playerId === null || connection.entityId < 0) continue;
      const entity = this.state.entities.get(connection.entityId);
      if (!entity) continue;
      this.players.syncFromEntity(
        connection.playerId,
        entity.position,
        entity.facing,
        entity.health,
      );
    }

    this.handleRespawns();

    // Corrections and combat results go out the tick they happen -- they are
    // rare and latency is the whole point of them. Deltas are the bulk traffic
    // and ride the broadcast divisor instead (spec 057): the world advances at
    // 60Hz, clients hear about it at 20.
    this.dispatchEvents(result.events);
    // Cooldowns ride the same reasoning as corrections: rare, owner-only, and
    // the point of them is that the button greys out the moment it is spent.
    for (const connection of this.connections) this.sendCooldowns(connection, this.state.tick);
    if (this.state.tick % BROADCAST_EVERY_N_TICKS === 0) this.broadcastDeltas();
  }

  /**
   * Puts dead players back on their feet. Their entity is never swept up (see
   * `sim/world.ts`), so a respawn is a heal and a move rather than a new entity
   * -- the id the client knows itself by survives, which is what stops a death
   * from silently orphaning the client's view of itself.
   */
  private handleRespawns(): void {
    for (const connection of this.connections) {
      if (connection.playerId === null || connection.entityId < 0) continue;
      const entity = this.state.entities.get(connection.entityId);
      if (!entity) continue;

      if (entity.health > 0) {
        connection.respawnAtTick = 0;
        continue;
      }

      if (connection.respawnAtTick === 0) {
        connection.respawnAtTick = this.state.tick + RESPAWN_DELAY_TICKS;
        this.send(connection, {
          type: ServerMessageType.Chat,
          channel: ChatChannel.System,
          from: 'World',
          text: 'You have fallen. Returning to Hearthstead...',
        });
        continue;
      }

      if (this.state.tick < connection.respawnAtTick) continue;

      const session = this.players.get(connection.playerId);
      if (!session) continue;
      const at = DEFAULT_SPAWN;
      const position: Vec3 = { x: at.x, y: at.y, z: this.terrain.heightAt(at.x, at.y) };
      this.state = replaceEntity(this.state, {
        ...entity,
        position,
        health: session.stats.maxHealth,
        activity: ActivityValue.Idle,
        activityUntilTick: 0,
        targetId: null,
        path: null,
        pathIndex: 0,
        repathAtTick: 0,
        pathGoal: null,
        // Cleared, or the first input after respawn is measured against a claim
        // from wherever they died and reads as crossing the map in one tick.
        claimedPosition: null,
      });
      this.chunks.place(entity.id, position.x, position.y, true);
      this.players.syncFromEntity(connection.playerId, position, entity.facing, session.stats.maxHealth);
      connection.respawnAtTick = 0;

      this.send(connection, {
        type: ServerMessageType.Correction,
        inputSeq: connection.lastSeq,
        position,
        facing: entity.facing,
        reason: CorrectionReason.Teleport,
      });
    }
  }

  private dispatchEvents(events: readonly ServerSimEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'correction': {
          const connection = this.connectionForEntity(event.entityId);
          if (!connection) break;
          this.send(connection, {
            type: ServerMessageType.Correction,
            inputSeq: event.inputSeq,
            position: event.position,
            facing: event.facing,
            reason: event.reason,
          });
          break;
        }
        case 'hit': {
          const message: ServerMessage = {
            type: ServerMessageType.CombatResult,
            attackerId: event.attackerId,
            targetId: event.targetId,
            damage: event.damage,
            targetHealth: event.targetHealth,
            flags:
              (event.killed ? 1 : 0) | (event.critical ? 2 : 0) | (event.blocked ? 4 : 0),
          };
          const bytes = encodeServerMessage(message);
          for (const connection of this.connections) {
            if (connection.entityId < 0) continue;
            if (
              this.chunks.isInInterest(connection.entityId, event.attackerId) ||
              this.chunks.isInInterest(connection.entityId, event.targetId)
            ) {
              this.sendRaw(connection, bytes);
            }
          }
          break;
        }
        case 'died': {
          if (event.killerId === null) break;
          const killer = this.players.byEntityId(event.killerId);
          const victim = this.state.entities.get(event.entityId);
          if (!killer || !victim || victim.kind !== EntityKindValue.Monster) break;
          const definition = monsterById(victim.typeId);
          if (!definition) break;
          // Awarded asynchronously; the tick does not wait on the store.
          void this.players
            .grantExperience(killer.playerId, definition.experience)
            .then(() => {
              const connection = this.connectionForEntity(event.killerId ?? -1);
              if (connection) this.sendStats(connection);
            })
            .catch((error: unknown) => {
              console.warn('[server] experience grant failed', error);
            });
          break;
        }
        case 'castStarted': {
          const bytes = encodeServerMessage({
            type: ServerMessageType.CastState,
            entityId: event.entityId,
            abilityId: event.abilityId,
            phase: event.phase,
            releaseTick: event.releaseTick,
            endTick: event.endTick,
            targetX: event.targetX,
            targetY: event.targetY,
          });
          this.sendToWatchersOf(event.entityId, bytes);
          break;
        }
        case 'castEnded': {
          const bytes = encodeServerMessage({
            type: ServerMessageType.CastEnded,
            entityId: event.entityId,
            abilityId: event.abilityId,
            reason: event.reason,
          });
          this.sendToWatchersOf(event.entityId, bytes);
          break;
        }
        case 'castRejected': {
          // Only the asker cares why their own request was refused.
          const connection = this.connectionForEntity(event.entityId);
          if (connection) {
            this.send(connection, {
              type: ServerMessageType.CastRejected,
              abilityId: event.abilityId,
              reason: event.reason,
            });
          }
          break;
        }
        case 'effect': {
          const bytes = encodeServerMessage({
            type: ServerMessageType.Effect,
            effectId: event.effectId,
            x: event.x,
            y: event.y,
            z: event.z,
            radius: event.radius,
            durationTicks: event.durationTicks,
          });
          // An effect has no entity, so interest is judged by the chunk it
          // happens in rather than by whose body it belongs to.
          for (const connection of this.connections) {
            if (connection.entityId < 0) continue;
            const watcher = this.state.entities.get(connection.entityId);
            if (!watcher) continue;
            const reach = CHUNK_SIZE * (INTEREST_CHUNK_RADIUS + 1);
            if (Math.abs(watcher.position.x - event.x) > reach) continue;
            if (Math.abs(watcher.position.y - event.y) > reach) continue;
            this.sendRaw(connection, bytes);
          }
          break;
        }
        case 'despawned':
          // Deliberately *not* `delta.forget` here. The tracker derives its
          // removal list from "what I told you about that I can no longer see",
          // so forgetting an entity is precisely how to stop it ever being
          // withdrawn -- the client would keep drawing a corpse that is gone.
          // Dropping out of `this.state.entities` is all the signal it needs.
          break;
        case 'spawned':
        case 'attackMissed':
          break;
      }
    }
  }

  private broadcastDeltas(): void {
    for (const connection of this.connections) {
      if (connection.playerId === null || connection.entityId < 0) continue;
      const session = this.players.get(connection.playerId);
      const visible: ServerEntity[] = [];
      for (const id of this.chunks.interestSet(connection.entityId)) {
        const entity = this.state.entities.get(id);
        if (entity) visible.push(entity);
      }
      const delta = connection.delta.build(
        this.state.tick,
        session?.lastAppliedInputSeq ?? 0,
        visible,
      );
      // Silence is meaningful: a client whose world did not change gets nothing.
      if (DeltaTracker.isEmpty(delta)) continue;
      this.send(connection, delta);
    }
  }

  /** Everyone whose interest set contains `entityId`, the entity's owner included. */
  private sendToWatchersOf(entityId: number, bytes: Uint8Array): void {
    for (const connection of this.connections) {
      if (connection.entityId < 0) continue;
      if (connection.entityId === entityId || this.chunks.isInInterest(connection.entityId, entityId)) {
        this.sendRaw(connection, bytes);
      }
    }
  }

  private connectionForEntity(entityId: number): Connection | null {
    for (const connection of this.connections) {
      if (connection.entityId === entityId) return connection;
    }
    return null;
  }

  // --- AdminHost ---------------------------------------------------------

  listPlayers(): readonly AdminPlayerRow[] {
    const rows: AdminPlayerRow[] = [];
    for (const session of this.players.all()) {
      const entity = this.state.entities.get(session.entityId);
      const position: Vec3 = entity?.position ?? session.record.position;
      rows.push({
        playerId: session.playerId,
        displayName: session.displayName,
        entityId: session.entityId,
        x: position.x,
        y: position.y,
        z: position.z,
        zone: this.zones.byIdOrWilderness(session.record.currentZone).displayName,
        chunk: this.chunks.chunkOfEntity(session.entityId) ?? this.chunks.keyAt(position.x, position.y),
        health: entity?.health ?? session.record.health,
        maxHealth: session.stats.maxHealth,
        level: session.record.level,
        attackDamage: session.stats.attackDamage,
        moveSpeed: session.stats.moveSpeed,
        muted: session.muted,
      });
    }
    return rows;
  }

  kick(playerId: string, reason: string): boolean {
    const connection = this.connectionForPlayer(playerId);
    if (!connection) return false;
    this.drop(connection, `kicked: ${reason}`);
    return true;
  }

  async ban(playerId: string, seconds: number, reason: string, issuedBy: string): Promise<boolean> {
    await this.store.putBan({
      playerId,
      until: seconds > 0 ? Date.now() + seconds * 1000 : Number.POSITIVE_INFINITY,
      reason,
      issuedBy,
    });
    this.kick(playerId, `banned: ${reason}`);
    return true;
  }

  async mute(playerId: string, seconds: number, issuedBy: string): Promise<boolean> {
    if (seconds <= 0) {
      await this.store.clearMute(playerId);
      this.players.setMuted(playerId, false);
      return true;
    }
    await this.store.putMute({ playerId, until: Date.now() + seconds * 1000, issuedBy });
    this.players.setMuted(playerId, true);
    return true;
  }

  teleport(playerId: string, x: number, y: number): boolean {
    const session = this.players.get(playerId);
    if (!session || session.entityId < 0) return false;
    const entity = this.state.entities.get(session.entityId);
    if (!entity) return false;

    const position: Vec3 = { x, y, z: this.terrain.heightAt(x, y) };
    this.state = replaceEntity(this.state, {
      ...entity,
      position,
      zoneId: this.zones.zoneIdAt(x, y),
    });
    this.chunks.place(entity.id, x, y, true);
    this.players.syncFromEntity(playerId, position, entity.facing, entity.health);

    const connection = this.connectionForPlayer(playerId);
    if (connection) {
      // A teleport is a correction the client cannot have predicted, so it is
      // pushed immediately rather than waiting for divergence to be noticed.
      this.send(connection, {
        type: ServerMessageType.Correction,
        inputSeq: connection.lastSeq,
        position,
        facing: entity.facing,
        reason: CorrectionReason.Teleport,
      });
    }
    return true;
  }

  spawnEntities(entityType: string, x: number, y: number, count: number): number {
    const definition = monsterById(entityType);
    if (!definition) return 0;
    const wanted = Math.max(0, Math.min(200, count));
    let spawned = 0;
    for (let i = 0; i < wanted; i++) {
      // Fanned out on a ring so a raid does not arrive as one stacked pile.
      const angle = (i / Math.max(1, wanted)) * Math.PI * 2;
      const spread = wanted > 1 ? definition.radius * 2.5 : 0;
      const px = x + Math.cos(angle) * spread;
      const py = y + Math.sin(angle) * spread;
      const result = spawnEntity(this.state, {
        kind: EntityKindValue.Monster,
        typeId: definition.id,
        position: { x: px, y: py, z: this.terrain.heightAt(px, py) },
        stats: definition.stats,
        radius: definition.radius,
        zoneId: this.zones.zoneIdAt(px, py),
      });
      this.state = result.state;
      this.chunks.place(result.entity.id, px, py, false);
      spawned += 1;
    }
    return spawned;
  }

  despawnEntity(entityId: number): boolean {
    if (!this.state.entities.has(entityId)) return false;
    this.state = removeEntity(this.state, entityId);
    this.chunks.remove(entityId);
    // No `delta.forget` -- see the 'despawned' case in `dispatchEvents`. The
    // next delta withdraws it because it is gone from the world, and forgetting
    // it here would suppress exactly that.
    return true;
  }

  triggerEvent(eventName: string, x: number, y: number, magnitude: number): string {
    switch (eventName) {
      case 'raid': {
        const count = Math.max(1, Math.min(50, Math.round(magnitude)));
        const spawned = this.spawnEntities('ravager', x, y, count);
        this.broadcastMessage({
          type: ServerMessageType.Chat,
          channel: ChatChannel.System,
          from: 'World',
          text: `A raid of ${spawned} descends near ${Math.round(x)}, ${Math.round(y)}.`,
        });
        return `raid: ${spawned} ravagers at ${Math.round(x)}, ${Math.round(y)}`;
      }
      case 'clear': {
        let removed = 0;
        for (const entity of [...this.state.entities.values()]) {
          if (entity.kind !== EntityKindValue.Monster) continue;
          if (Math.hypot(entity.position.x - x, entity.position.y - y) > magnitude) continue;
          this.despawnEntity(entity.id);
          removed += 1;
        }
        return `cleared ${removed} monsters within ${magnitude} units`;
      }
      case 'heal': {
        let healed = 0;
        for (const session of this.players.all()) {
          const entity = this.state.entities.get(session.entityId);
          if (!entity) continue;
          this.state = replaceEntity(this.state, {
            ...entity,
            health: session.stats.maxHealth,
            activity: ActivityValue.Idle,
          });
          healed += 1;
        }
        return `healed ${healed} player(s)`;
      }
      default:
        return '';
    }
  }

  broadcast(text: string): number {
    return this.broadcastMessage({
      type: ServerMessageType.Chat,
      channel: ChatChannel.AdminBroadcast,
      from: 'Server',
      text,
    });
  }

  setConfig(key: string, value: number): number | null {
    return this.config.set(key, value);
  }

  getConfig(): readonly (readonly [string, number])[] {
    const current = this.config.get();
    return LIVE_CONFIG_KEYS.map((key) => [key, current[key]] as const);
  }

  private connectionForPlayer(playerId: string): Connection | null {
    for (const connection of this.connections) {
      if (connection.playerId === playerId) return connection;
    }
    return null;
  }

  /**
   * Test seam: a connection whose outgoing frames go straight to `sink`, so the
   * login/input/delta round trip can be driven without any transport at all.
   */
  createLocalConnection(sink: (bytes: Uint8Array) => void): Connection {
    let onClose: (() => void) | null = null;
    return this.accept({
      isOpen: true,
      send: (bytes) => sink(new Uint8Array(bytes)),
      close: () => onClose?.(),
      onMessage: () => {
        // Frames are pushed in by the test through `receive`, not pulled.
      },
      onClose: (handler) => {
        onClose = handler;
      },
    });
  }
}


