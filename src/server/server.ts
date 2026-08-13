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
import type { Vec2, WorldColliders } from '../sim/types.js';
import { AuditLog } from './admin/audit.js';
import {
  AdminRouter,
  createAdminConnectionState,
  DENY_ALL_ADMIN,
  type AdminConnectionState,
  type AdminHost,
  type AdminOutcome,
  type AdminTokenVerifier,
} from './admin/router.js';
import {
  BROADCAST_EVERY_N_TICKS,
  CHUNK_SIZE,
  INTEREST_CHUNK_RADIUS,
  MAP_CHUNK_BURST,
  MAP_CHUNK_REFILL_PER_SECOND,
  MAP_CHUNK_REQUEST_RADIUS,
  LIVE_CONFIG_KEYS,
  LiveConfigStore,
  MAX_BUFFERED_INPUTS,
  RESUME_GRACE_TICKS,
  CONNECTION_TIMEOUT_TICKS,
  PROTOCOL_VERSION,
  RESOURCE_EPSILON,
  RESPAWN_DELAY_TICKS,
  SERVER_TICK_MS,
  SERVER_TICK_RATE,
} from './config.js';
import { TickLoop } from './loop.js';
import { regenerated } from './sim/resource.js';
import { monsterById } from './data/monsters.js';
import { ALL_ITEMS, maxStackOf, rarityFromByte, rarityToByte } from './data/items.js';
import { isRevealed, makeDrop, type DropState } from './sim/loot.js';
import { compareManifest, mismatchMessage, refusesConnection } from '../units/manifest.js';
import {
  decodeAdminRequest,
  encodeAdminReply,
  type AdminItemRow,
  type AdminPlayerRow,
} from './net/admin-messages.js';
import { CodecError } from './net/codec.js';
import { DeltaTracker } from './net/delta.js';
import {
  decodeClientMessage,
  encodeServerMessage,
  type LootDropMessage,
  type RequestChunkMessage,
  type ServerMessage,
  type SpawnerStatus,
} from './net/messages.js';
import {
  ChatChannel,
  ChunkDeniedReason,
  ClientMessageType,
  CorrectionReason,
  EntityField,
  ErrorCode,
  isAdminRequest,
  ServerMessageType,
  SpawnerStateValue,
  type AdminProgressModeValue,
} from './net/protocol.js';
import { attributeByOrdinal } from './data/attributes.js';
import { resolveProgression } from './player/progression.js';
import { DEFAULT_SPAWN, experienceForLevel, PlayerManager } from './player/player-manager.js';
import {
  inTradeRange,
  isSwappable,
  partiesOf,
  TradeRegistry,
  type Trade,
} from './player/trades.js';
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
  asksToMove,
  createWorldState,
  PICKUP_RANGE,
  PLAYER_BODY_RADIUS,
  removeEntity,
  replaceEntity,
  spawnDrop,
  spawnEntity,
  step,
} from './sim/world.js';
import { NullTransport, type Channel, type ServerTransport } from './net/transport.js';
import { ChunkManager } from './world/chunk-manager.js';
import { PositionHistory } from './world/position-history.js';
import { spawnAround } from './world/spawn-around.js';
import { circleBlocked } from '../sim/collision.js';
import { WALKABLE_MIN_HEIGHT } from '../sim/constants.js';
import type { BuiltMapWorld, BuiltWorld } from './world/build.js';
import type { SpawnPoint } from './world/spawners.js';
import type { MapIndex } from './world/map-index.js';
import { ChunkBudget, decideChunkRequest } from './world/map-request.js';
import { MAX_FRAME_BYTES, MAX_NAME_LENGTH, RateLimiter } from './net/rate-limit.js';
import { FLAT_TERRAIN, type TerrainSampler } from './world/terrain.js';
import { ZoneManager } from './world/zone-manager.js';
import { buyPrice } from './data/vendors.js';
import { TradeStageValue } from './net/protocol.js';

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
  /**
   * The asset manifest hash this server serves (spec 113).
   *
   * Omit and every client is let through, whatever it claims -- which is right
   * for a server inside a player's own tab, for the bot harness, and for every
   * test here. `src/server/index.ts` reads the real one off disk.
   */
  readonly assetManifestHash?: string;
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
   * The smallest this connection's input queue has been since the last pong
   * (spec 148). Reset when reported; see the field on `PongMessage`.
   */
  queueFloor: number;
  /** The token this session may be resumed with (spec 150). */
  sessionToken: string;
  /** The last tick anything was heard from this connection (spec 150). */
  lastSeenTick: number;
  /**
   * Set before the socket is closed on purpose (spec 150).
   *
   * A flag rather than only an argument to `disconnect`, because closing the
   * channel fires its own close handler -- which reaches `disconnect` first and
   * would linger a body the server had just decided to remove.
   */
  leaving: boolean;
  /**
   * The cooldown map last sent to this client. Compared by *identity*: entities
   * are immutable and the map is only rebuilt when it actually changes, so this
   * is a pointer compare per connection per tick rather than a walk.
   */
  sentCooldowns: Readonly<Record<string, number>> | null;
  /**
   * The last resource this connection was told about, and when (spec 069).
   *
   * Kept so the server can model what the client now believes and send only
   * when that belief has gone wrong. Starts negative so the first comparison
   * always disagrees: a client that has never been told cannot model anything,
   * and must be given a number before it can predict a cost against it.
   */
  sentResource: number;
  sentResourceTick: number;
  /** Token bucket on map chunk sends (spec 072). */
  readonly chunkBudget: ChunkBudget;
  /** How often this connection may say a thing (spec 151). */
  readonly limiter: RateLimiter;
  /** Whether this client asked for the spawner readout (spec 076). */
  watchingSpawners: boolean;
  /**
   * Abilities asked for and not yet committed, each stamped with the input it
   * was asked after (spec 067). Held here rather than on the input frame
   * because a client sends them as their own messages, and they must not be
   * lost if no movement input happens to arrive in the same tick.
   *
   * A queue rather than a single slot: two requests can arrive between ticks on
   * a connection that is buffering, and the second is a real decision the player
   * made rather than something to overwrite the first with.
   */
  readonly pendingCasts: PendingCast[];
  /** Cancels, stamped the same way. */
  readonly pendingCancels: PendingCancel[];
  /** The shop this connection has open, or '' (spec 129). */
  openVendorId: string;
  /** Bumped by every cast or cancel, so the two queues can be put back in order. */
  asks: number;
  /** The last input seq handed to the sim, so a gap in the stream is visible. */
  appliedSeq: number;
  /**
   * The tick a drift correction was last sent on, so nudges ride the broadcast
   * cadence instead of going out sixty times a second (spec 067). Hard
   * corrections are not throttled -- they are rare and the point of them is that
   * they are immediate.
   */
  lastDriftTick: number;
}

interface PendingCast {
  readonly abilityId: string;
  readonly targetX: number;
  readonly targetY: number;
  /** The entity asked for by id, or 0 for a point aim (spec 070). */
  readonly targetEntityId: number;
  /** Commit on the tick this input seq is applied, not on the tick it arrived. */
  readonly afterInputSeq: number;
  /**
   * Where this sat in the connection's own stream of asks (spec 092). Casts and
   * cancels queue separately, so the order *between* the two queues is lost
   * unless it is written down -- and it is the whole question when both come
   * due on the same tick: a cancel that arrived after a request means "not that
   * one", and one that arrived before it means "not the last one, and now this".
   */
  readonly arrivedAt: number;
}

/** A withdrawal waiting for its place in the input stream, stamped like a cast. */
interface PendingCancel {
  readonly afterInputSeq: number;
  readonly arrivedAt: number;
}

export class GameServer implements AdminHost {
  private readonly zones: ZoneManager;
  /** Where bodies were, for lag compensation (spec 149). Bounded by the cap. */
  private readonly history = new PositionHistory();
  /**
   * Sessions whose socket has gone but whose body is still standing (spec 150).
   * Keyed by playerId, because that is what a returning `Hello` names.
   */
  private readonly lingering = new Map<
    string,
    { readonly token: string; readonly entityId: number; readonly expiresAtTick: number }
  >();
  private readonly terrain: TerrainSampler;
  private readonly colliders: WorldColliders;
  /** Announced in the welcome so a client can build the same ground (spec 063). */
  private readonly worldSeed: number;
  private readonly store: DataStore;
  /**
   * The asset manifest hash this server is serving, or '' when it has none.
   *
   * Injected rather than read from disk here, because `server.ts` is the
   * portable half and reading `assets/units/manifest.json` is a Node concern.
   * An empty hash lets every client through, which is what keeps a repo with no
   * manifest yet -- and every test in this suite -- runnable.
   */
  private readonly assetManifestHash: string;
  private readonly config = new LiveConfigStore();
  private readonly chunks: ChunkManager;
  private readonly players: PlayerManager;
  /** Open trades, and the one-trade-per-player rule (spec 132). */
  private readonly trades = new TradeRegistry();
  private readonly audit: AuditLog;
  private readonly admin: AdminRouter;
  private readonly loop: TickLoop;
  private readonly connections = new Set<Connection>();
  private readonly transport: ServerTransport;
  /**
   * The map this server serves, or null when it was built from a bare seed
   * (spec 072). Null means chunk requests are refused as `Unknown` and no
   * `MapInfo` is sent -- which is what a flat-plane unit test wants.
   */
  private readonly mapIndex: MapIndex | null;
  /**
   * The enemy spawn points the map places (spec 076). Empty for a server built
   * from a bare seed, which then has no monsters in it at all -- the map is the
   * only thing that puts one anywhere.
   */
  private readonly spawnPoints: readonly SpawnPoint[];
  private state: ServerWorldState;

  constructor(options: GameServerOptions = {}) {
    this.zones = options.zones ?? new ZoneManager();
    this.terrain = options.terrain ?? options.built?.sampler ?? FLAT_TERRAIN;
    this.colliders = options.world ?? options.built?.colliders ?? DEFAULT_WORLD;
    this.worldSeed = options.seed ?? options.built?.seed ?? 1;
    const built = options.built;
    this.mapIndex = built && 'index' in built ? (built as BuiltMapWorld).index : null;
    this.spawnPoints = built && 'spawnPoints' in built ? (built as BuiltMapWorld).spawnPoints : [];
    this.store = options.store ?? new MemoryDataStore();
    this.assetManifestHash = options.assetManifestHash ?? '';
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

  /**
   * How many of a player's inputs are sitting unconsumed (spec 148).
   *
   * The number the pong carries, readable from this end too -- a rate-matching
   * test wants the truth every tick rather than the 2Hz sample the client sees,
   * and the admin console has an obvious use for it.
   */
  inputQueueDepth(playerId: string): number {
    for (const connection of this.connections) {
      if (connection.playerId === playerId) return connection.inputs.length;
    }
    return 0;
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
      pendingCasts: [],
      pendingCancels: [],
      openVendorId: '',
      asks: 0,
      appliedSeq: 0,
      lastDriftTick: 0,
      sentCooldowns: null,
      sentResource: -1,
      sentResourceTick: 0,
      chunkBudget: new ChunkBudget(
        MAP_CHUNK_BURST,
        MAP_CHUNK_REFILL_PER_SECOND,
        SERVER_TICK_RATE,
        this.state.tick,
      ),
      limiter: new RateLimiter(this.state.tick),
      watchingSpawners: false,
      queueFloor: Number.POSITIVE_INFINITY,
      sessionToken: '',
      lastSeenTick: this.state.tick,
      leaving: false,
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
    // Bounded before it is decoded (spec 151): the size is checked rather than
    // discovered. The largest legitimate frame is under a hundred bytes.
    if (frame.length > MAX_FRAME_BYTES) return;
    // Anything at all counts as a heartbeat (spec 150). The client pings twice
    // a second on its own, so silence really is silence.
    connection.lastSeenTick = this.state.tick;

    // Silently, because answering a flood is participating in it (spec 151).
    if (!connection.limiter.allow(frame[0] ?? 0, this.state.tick)) {
      if (connection.limiter.flooding) this.drop(connection, 'flooding');
      return;
    }
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
        await this.hello(
          connection,
          message.protocolVersion,
          message.playerId,
          // Bounded because it is now broadcast to every client in interest
          // (spec 145): an unbounded name went from a string nobody read to a
          // way to make the server send everybody a megabyte.
          message.displayName.slice(0, MAX_NAME_LENGTH),
          message.assetManifest,
          message.resumeToken,
        );
        break;

      case ClientMessageType.Input: {
        if (connection.playerId === null || connection.entityId < 0) return;
        // Out-of-order and replayed inputs are dropped: the sequence number is
        // the client's own, and only ever moving forward is the contract.
        if (message.seq <= connection.lastSeq) return;
        connection.lastSeq = message.seq;
        // How far behind the server's clock this client is drawing (spec 149).
        // Clamped inside `noteLag`, because it is a number a client chose.
        this.history.noteLag(connection.entityId, message.renderLagTicks);
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
          seqSpan: 1,
          castAbilityId: '',
          castTargetX: 0,
          castTargetY: 0,
          castTargetEntityId: 0,
          cancelCast: false,
        });
        break;
      }

      case ClientMessageType.Goodbye:
        // Meant it. No lingering body (spec 150).
        connection.leaving = true;
        await this.disconnect(connection, { intentional: true });
        break;

      case ClientMessageType.Ping:
        this.send(connection, {
          type: ServerMessageType.Pong,
          nonce: message.nonce,
          serverTick: this.state.tick,
          // The floor since the last pong, not the depth right now (spec 148).
          // Only this end knows it, and the instant would not be the quantity
          // that matters even if the client could infer it.
          inputQueueFloor: Math.min(connection.queueFloor, connection.inputs.length),
        });
        connection.queueFloor = Number.POSITIVE_INFINITY;
        break;

      case ClientMessageType.Equip: {
        if (connection.playerId === null) return;
        const result = await this.players.equip(connection.playerId, message.slot, message.itemId);
        this.reportAction(connection, result.ok ? null : result.reason);
        this.sendInventory(connection, 0);
        break;
      }

      case ClientMessageType.Unequip: {
        if (connection.playerId === null) return;
        const result = await this.players.unequip(connection.playerId, message.slot);
        this.reportAction(connection, result.ok ? null : result.reason);
        this.sendInventory(connection, 0);
        break;
      }

      case ClientMessageType.MoveItem: {
        if (connection.playerId === null) return;
        const result = await this.players.moveItem(connection.playerId, {
          from: message.from,
          to: message.to,
          // 0 on the wire means "the whole stack", which is `undefined` to the
          // rules -- the wire has no way to say "absent" and the rules have no
          // use for a zero.
          ...(message.count === 0 ? {} : { count: message.count }),
        });
        this.reportAction(connection, result.ok ? null : result.reason);
        // Answered either way, at the id that was asked. A refusal that said
        // nothing but "no" would leave the client's guess standing.
        this.sendInventory(connection, message.requestId);
        break;
      }

      case ClientMessageType.PickUpItem: {
        if (connection.playerId === null) return;
        const reason = await this.pickUpDrop(connection, message.entityId);
        this.reportAction(connection, reason);
        // Answered at the request id either way, exactly as `MoveItem` is: the
        // refusal is what takes a client's optimistic guess back, so it has to
        // arrive on the same channel as the acceptance.
        this.sendInventory(connection, message.requestId);
        break;
      }

      case ClientMessageType.OpenVendor:
        if (connection.playerId === null) return;
        this.sendVendorState(connection, message.vendorId);
        break;

      case ClientMessageType.BuyItem: {
        if (connection.playerId === null) return;
        const result = await this.players.buyItem(
          connection.playerId,
          message.vendorId,
          message.defId,
          message.count,
        );
        this.reportAction(connection, result.ok ? null : result.reason);
        this.sendInventory(connection, message.requestId);
        // The stock list itself never changes, but the buyback half of it does,
        // and a shop that answered a sale with a stale undo list would offer to
        // undo something twice.
        this.sendVendorState(connection, connection.openVendorId);
        break;
      }

      case ClientMessageType.SellItem: {
        if (connection.playerId === null) return;
        const result = await this.players.sellItem(
          connection.playerId,
          message.vendorId,
          message.index,
          message.count,
        );
        this.reportAction(connection, result.ok ? null : result.reason);
        this.sendInventory(connection, message.requestId);
        this.sendVendorState(connection, connection.openVendorId);
        break;
      }

      case ClientMessageType.BuyBack: {
        if (connection.playerId === null) return;
        const result = await this.players.buyBackItem(
          connection.playerId,
          message.vendorId,
          message.index,
        );
        this.reportAction(connection, result.ok ? null : result.reason);
        this.sendInventory(connection, message.requestId);
        this.sendVendorState(connection, connection.openVendorId);
        break;
      }

      case ClientMessageType.TradeInvite: {
        if (connection.playerId === null) return;
        const them = this.players.byEntityId(message.entityId);
        if (!them) {
          this.reportAction(connection, 'there is nobody there to trade with');
          break;
        }
        const result = this.trades.invite(connection.playerId, them.playerId);
        if (!result.ok) this.reportAction(connection, result.reason);
        else this.publishTrade(result.trade);
        break;
      }

      case ClientMessageType.TradeRespond: {
        if (connection.playerId === null) return;
        const result = this.trades.respond(connection.playerId, message.accept);
        if (!result.ok) this.reportAction(connection, result.reason);
        else this.publishTrade(result.trade);
        break;
      }

      case ClientMessageType.TradeOffer: {
        if (connection.playerId === null) return;
        const holdings = this.players.holdingsOf(connection.playerId);
        if (!holdings) return;
        const result = this.trades.setOffer(connection.playerId, message.slots, message.coins, holdings);
        if (!result.ok) this.reportAction(connection, result.reason);
        else this.publishTrade(result.trade);
        break;
      }

      case ClientMessageType.TradeAccept: {
        if (connection.playerId === null) return;
        const result = this.trades.accept(connection.playerId, message.revision);
        if (!result.ok) {
          this.reportAction(connection, result.reason);
          break;
        }
        // Published before the swap runs, so both clients see the acceptance
        // even when the exchange is then refused -- and then see why.
        this.publishTrade(result.trade);
        // Only once *both* sides have agreed. Settling on every acceptance runs
        // the swap against a table one side has not answered, which refuses --
        // and a refused settle cancels the trade, so the first player to say yes
        // was ending it.
        if (isSwappable(result.trade)) await this.settleTrade(result.trade);
        break;
      }

      case ClientMessageType.TradeCancel: {
        if (connection.playerId === null) return;
        const ended = this.trades.cancelFor(connection.playerId, 'cancelled');
        if (ended) this.endTrade(ended);
        break;
      }


      // The three progression writes (spec 147). Each is the same three lines
      // for the same reason: the client says which button was pressed, the
      // manager decides, and `reportAction` sends the refusal or the fresh
      // `Stats`. There is no path here that reads a number off the message.
      case ClientMessageType.AllocateAttribute: {
        if (connection.playerId === null) return;
        const attribute = attributeByOrdinal(message.attribute);
        const result = attribute
          ? await this.players.allocateAttribute(connection.playerId, attribute.key)
          : { ok: false as const, reason: `no such attribute: ${message.attribute}` };
        this.reportAction(connection, result.ok ? null : result.reason);
        break;
      }

      case ClientMessageType.RespecAttributes: {
        if (connection.playerId === null) return;
        const result = await this.players.respec(connection.playerId);
        this.reportAction(connection, result.ok ? null : result.reason);
        // The purse changed, so the bag view has to be resent -- coins ride on
        // the inventory message (spec 129).
        if (result.ok) this.sendInventory(connection, 0);
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
        connection.asks += 1;
        connection.pendingCasts.push({
          abilityId: message.abilityId,
          targetX: message.targetX,
          targetY: message.targetY,
          targetEntityId: message.targetEntityId,
          afterInputSeq: message.afterInputSeq,
          arrivedAt: connection.asks,
        });
        break;

      case ClientMessageType.RequestChunk:
        this.handleChunkRequest(connection, message);
        break;
      // A subscription to a readout, not an action: it changes nothing about
      // the world, so it needs no player and no entity (spec 076).
      case ClientMessageType.WatchSpawners:
        connection.watchingSpawners = message.on;
        if (message.on) this.sendSpawnerStates(connection);
        break;
      case ClientMessageType.CancelCast:
        if (connection.playerId === null || connection.entityId < 0) return;
        connection.asks += 1;
        connection.pendingCancels.push({
          afterInputSeq: message.afterInputSeq,
          arrivedAt: connection.asks,
        });
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
    assetManifest = '',
    resumeToken = '',
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

    // Checked after the version and before anything else (spec 113). A client
    // built against different assets is drawing a fight that is not the one
    // being played -- different clip lengths, different action timings, a hit
    // landing on a frame that is not the frame the server used. Nothing about
    // that is visible until somebody notices, which is why it is a refused
    // connection rather than a warning.
    const verdict = compareManifest(assetManifest, this.assetManifestHash);
    if (refusesConnection(verdict)) {
      const message = mismatchMessage(assetManifest, this.assetManifestHash);
      this.send(connection, { type: ServerMessageType.Error, code: ErrorCode.BadProtocolVersion, message });
      this.drop(connection, 'asset manifest mismatch');
      return;
    }
    // One Hello per connection (spec 145). A second one used to log in again on
    // the same socket, spawn a second body, and overwrite `connection.entityId`
    // with it -- so the first entity belonged to nobody, was reaped by nothing,
    // and stood in the world until the server restarted. A client that says
    // hello twice is broken or lying, and either way the answer is the same.
    if (connection.playerId !== null) {
      this.send(connection, {
        type: ServerMessageType.Error,
        code: ErrorCode.RejectedAction,
        message: 'already connected',
      });
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

    // Coming back to the body that is still standing there (spec 150).
    //
    // A token that does not match is simply a new login rather than an error:
    // one that has aged out is the ordinary case, not an attack, and refusing
    // the connection would turn a slow reconnect into a lockout.
    const waiting = this.lingering.get(playerId);
    if (waiting && resumeToken !== '' && resumeToken === waiting.token) {
      const body = this.state.entities.get(waiting.entityId);
      if (body) {
        this.lingering.delete(playerId);
        connection.playerId = playerId;
        connection.entityId = waiting.entityId;
        connection.sessionToken = this.mintSessionToken();
        this.players.attachEntity(playerId, waiting.entityId);
        this.chunks.place(waiting.entityId, body.position.x, body.position.y, true);
        this.welcome(connection, playerId, waiting.entityId);
        // Everything a fresh login is pushed, because *the client resuming is
        // not the client that left*. What survives a resume is the body, on the
        // server; the page is new, its `GameClient` was constructed a moment
        // ago and holds nothing. This branch used to send `Welcome` and return,
        // so a reconnected player got no MapInfo -- no chunk list, so no ground
        // -- no Stats, so `maxHealth` and `maxPoise` read 0 and the character
        // sheet had nothing to draw, and no Inventory, so an empty bag. Every
        // reload after the first one looked like a broken world.
        this.sendMapInfo(connection);
        this.sendStats(connection);
        this.sendInventory(connection, 0);
        return;
      }
      this.lingering.delete(playerId);
    }

    const session = await this.players.login(playerId, displayName);
    // Not on top of whoever is already standing there (spec 145). A saved
    // position that is clear comes back unchanged, so this only ever moves
    // somebody who would have logged in inside another body.
    const at = this.clearSpawnNear(session.record.position);
    const position: Vec3 = { x: at.x, y: at.y, z: this.terrain.heightAt(at.x, at.y) };
    const spawned = spawnEntity(this.state, {
      kind: EntityKindValue.Player,
      typeId: 'player',
      ownerPlayerId: playerId,
      position,
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
    connection.sessionToken = this.mintSessionToken();
    this.chunks.place(spawned.entity.id, position.x, position.y, true);

    this.welcome(connection, playerId, spawned.entity.id);
    this.sendMapInfo(connection);
    this.sendStats(connection);
    // Unprompted, because nothing asked: a client cannot draw a bag it was
    // never told about, and login is the one moment it has no guess to settle.
    this.sendInventory(connection, 0);
  }

  /**
   * Everything about the map that is not per-chunk, unprompted (spec 072).
   *
   * Pushed rather than requested because a client can ask for nothing until it
   * has it: the chunk list in here is what tells it which chunks exist, and the
   * layer scalars are what let it rebuild corner jitter for the ones it gets.
   */
  private sendMapInfo(connection: Connection): void {
    const index = this.mapIndex;
    if (!index) return;
    this.send(connection, {
      type: ServerMessageType.MapInfo,
      mapId: index.mapId,
      seed: index.seed,
      cellSize: index.cellSize,
      chunkCells: index.chunkCells,
      arena: index.arena,
      species: index.species,
      layers: index.layers.map((layer) => ({
        id: layer.id,
        seed: layer.seed,
        origin: layer.origin,
        bounds: layer.bounds,
        baseY: layer.baseY,
        waterLevel: layer.waterLevel,
        coords: layer.coords,
      })),
    });
  }

  /**
   * One chunk, if this player is standing near enough to be told about it.
   *
   * The position fed to the check is the **entity's**, straight out of the sim.
   * A client's own `predictedX/Y` never reaches here: it is a hint the sim
   * measures for corrections, and trusting it would let a client read the whole
   * map by claiming to stand anywhere.
   */
  private handleChunkRequest(connection: Connection, req: RequestChunkMessage): void {
    const index = this.mapIndex;
    const deny = (reason: number): void => {
      this.send(connection, {
        type: ServerMessageType.ChunkDenied,
        layer: req.layer,
        cx: req.cx,
        cz: req.cz,
        reason,
      });
    };
    if (!index) {
      deny(ChunkDeniedReason.Unknown);
      return;
    }
    const entity = this.state.entities.get(connection.entityId);
    if (!entity) {
      deny(ChunkDeniedReason.OutOfRange);
      return;
    }
    const decision = decideChunkRequest(
      index,
      req,
      entity.position.x,
      entity.position.y,
      MAP_CHUNK_REQUEST_RADIUS,
      connection.chunkBudget,
      this.state.tick,
    );
    if (!decision.ok) {
      deny(decision.reason);
      return;
    }
    this.send(connection, {
      type: ServerMessageType.MapChunk,
      mapId: index.mapId,
      layer: req.layer,
      chunk: decision.chunk,
    });
  }

  /**
   * A connection has gone (spec 150).
   *
   * Unless it said goodbye, the *body stays* for `RESUME_GRACE_TICKS` so the
   * session can be resumed onto it -- which is what stops pulling the plug
   * being an escape from a fight, and what a reconnecting client comes back to.
   *
   * The trade does not get that grace and neither does the vendor. "Your body
   * is still standing there" and "your half of a trade is still live" are very
   * different promises, and the second one strands somebody who is still at
   * their keyboard on somebody who may never come back.
   */
  private async disconnect(
    connection: Connection,
    options: { readonly intentional?: boolean } = {},
  ): Promise<void> {
    if (!this.connections.has(connection)) return;
    // Before the connection leaves the set, so the *other* side is still told
    // (spec 132). A trade that outlived a disconnect would be a trade nobody
    // can cancel and an item nobody can get back.
    if (connection.playerId !== null) {
      const ended = this.trades.cancelFor(connection.playerId, 'they disconnected');
      if (ended) this.endTrade(ended);
    }
    connection.openVendorId = '';
    this.connections.delete(connection);

    const resumable =
      options.intentional !== true &&
      !connection.leaving &&
      connection.playerId !== null &&
      connection.entityId >= 0 &&
      connection.sessionToken !== '';
    if (resumable && connection.playerId !== null) {
      this.lingering.set(connection.playerId, {
        token: connection.sessionToken,
        entityId: connection.entityId,
        expiresAtTick: this.state.tick + RESUME_GRACE_TICKS,
      });
      return;
    }

    await this.reap(connection.playerId, connection.entityId);
  }

  /** Take the body out of the world and save the record. The end of a session. */
  private async reap(playerId: string | null, entityId: number): Promise<void> {
    if (entityId >= 0) {
      this.chunks.remove(entityId);
      this.history.forget(entityId);
      this.state = removeEntity(this.state, entityId);
    }
    if (playerId !== null) {
      this.lingering.delete(playerId);
      await this.players.logout(playerId);
    }
  }

  /**
   * Reap the bodies whose grace has run out, and cut off connections that have
   * gone quiet (spec 150).
   *
   * The timeout is the half a `close` event cannot cover: a socket killed by a
   * dead router or a suspended phone never delivers one, and before this its
   * entity stayed in the world forever.
   */
  private sweepConnections(): void {
    for (const [playerId, session] of [...this.lingering]) {
      if (this.state.tick < session.expiresAtTick) continue;
      void this.reap(playerId, session.entityId);
    }
    for (const connection of [...this.connections]) {
      if (connection.playerId === null) continue;
      if (this.state.tick - connection.lastSeenTick < CONNECTION_TIMEOUT_TICKS) continue;
      connection.channel.close();
      void this.disconnect(connection);
    }
  }

  private drop(connection: Connection, reason: string): void {
    this.send(connection, { type: ServerMessageType.Disconnect, reason });
    // Before the close, which fires a handler that reaches `disconnect` first.
    connection.leaving = true;
    connection.channel.close();
    // Intentional, so no body is left standing (spec 150). A kick, a refused
    // protocol version and a banned login are all decisions rather than
    // accidents, and a kicked player who stayed in the world for thirty
    // seconds would be a kick that did not work.
    void this.disconnect(connection, { intentional: true });
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
          // Poise is a live resource like health (spec 147), so it is held
          // under the *fresh* ceiling for the same reason: a respec that
          // shrinks the pool must not leave a body carrying a guard bigger than
          // it now has. The sim's own reads clamp too, so this is belt and
          // braces -- but a body that is briefly over its own maximum is the
          // sort of thing that shows up as a bar past the end of its track.
          poise: Math.min(entity.poise, session.stats.traits.maxPoise),
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

    // The client models regen forward from the last number it was given, so it
    // needs telling only when that model has gone wrong -- which is when it has
    // spent something, or when anything moved the pool that regen does not
    // explain. Modelling what the client believes and comparing is the same
    // trick the drift correction plays with position (spec 067): silence is a
    // statement that the prediction is right, and idling back to full is one
    // message rather than one per tick.
    const believed = regenerated(
      connection.sentResource,
      entity.stats.resourceRegen,
      entity.stats.maxResource,
      tick - connection.sentResourceTick,
    );
    const resourceStale = Math.abs(believed - entity.resource) > RESOURCE_EPSILON;
    if (entity.cooldowns === connection.sentCooldowns && !resourceStale) return;
    connection.sentCooldowns = entity.cooldowns;
    connection.sentResource = entity.resource;
    connection.sentResourceTick = tick;

    this.send(connection, {
      type: ServerMessageType.Cooldowns,
      entries: Object.entries(entity.cooldowns)
        .filter(([, readyAtTick]) => readyAtTick > tick)
        .map(([abilityId, readyAtTick]) => ({ abilityId, readyAtTick })),
      resource: entity.resource,
      atTick: tick,
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
      // What has actually been spent (specs 128, 147), not just what is left to
      // spend: a client told only the remainder cannot draw a tree.
      skills: session.record.skills,
      // Allocated and total, both (spec 147). The sheet spends against the
      // first and reads thresholds off the second, and a client sent only one
      // of them has to guess at the other.
      baseStats: session.record.baseStats,
      attributes: resolveProgression(session.record).attributes,
      unspentAttributePoints: session.record.unspentAttributePoints,
      stats: session.stats,
    });
  }

  /**
   * The player's containers, whole (spec 126).
   *
   * `requestId` is the move this answers, or 0 for an unprompted resend. Sent
   * after a refusal as well as after an acceptance, which is the whole rollback
   * mechanism: the client replaces its guess with this, so a refused move undoes
   * itself through the same code path an accepted one confirms itself through.
   */
  /**
   * Take a drop, or say why not (spec 156). Returns null when it was taken.
   *
   * Every check here is the server's and none of them is asked of the client.
   * The order matters in exactly one place: **the entity is removed before the
   * grant is awaited**, because `giveItem` writes to the store asynchronously
   * and two requests for the same drop would otherwise both find it lying there.
   * Removing first makes the second one's lookup fail, which is what makes "a
   * drop can be picked up once" a property of the code rather than of the
   * timing. If the bag turns out to be full the entity goes back, at the same
   * id, holding the same item -- a refusal must not destroy loot.
   *
   * Nothing in here reads the reveal. A drop mid-anticipation is picked up now;
   * the presentation that was pending simply never happens.
   */
  private async pickUpDrop(connection: Connection, entityId: number): Promise<string | null> {
    if (connection.playerId === null) return 'not logged in';
    const entity = this.state.entities.get(entityId);
    const drop = entity?.drop ?? null;
    if (!entity || drop === null) return 'there is nothing there';

    const body = this.state.entities.get(connection.entityId);
    if (!body || body.health <= 0) return 'you cannot pick that up right now';
    if (drop.ownerPlayerId !== null && drop.ownerPlayerId !== connection.playerId) {
      return 'that is not yours';
    }
    const reach = PICKUP_RANGE + body.radius;
    if (Math.hypot(body.position.x - entity.position.x, body.position.y - entity.position.y) > reach) {
      return 'that is too far away';
    }

    this.state = removeEntity(this.state, entityId);
    this.chunks.remove(entityId);
    const result = await this.players.giveItem(connection.playerId, drop.defId, drop.count);
    if (!result.ok) {
      // Put it back exactly as it was, clock included: a bag that was full is a
      // refusal, and a refusal that ate the drop would be the worst bug this
      // whole feature could have.
      this.state = replaceEntity(this.state, entity);
      this.chunks.place(entityId, entity.position.x, entity.position.y, false);
      return result.reason;
    }
    return null;
  }

  /** One `LootDrop`, saying only as much as `tick` permits (spec 156). */
  private lootDropMessage(entityId: number, drop: DropState, tick: number): LootDropMessage {
    const revealed = isRevealed(drop, tick);
    return {
      type: ServerMessageType.LootDrop,
      entityId,
      rarity: rarityToByte(drop.rarity),
      spawnTick: drop.spawnTick,
      revealTick: drop.revealTick,
      // Both ends of the throw. Not withheld with the identity: where a thing
      // was thrown from says nothing about what it is.
      originX: drop.origin.x,
      originY: drop.origin.y,
      originZ: drop.origin.z,
      // Absent rather than flagged. There is no branch on the client that could
      // draw an unrevealed item early, because it was never sent one.
      defId: revealed ? drop.defId : '',
      count: revealed ? drop.count : 0,
    };
  }

  private sendInventory(connection: Connection, requestId: number): void {
    if (connection.playerId === null) return;
    const session = this.players.get(connection.playerId);
    if (!session) return;
    this.send(connection, {
      type: ServerMessageType.Inventory,
      requestId,
      inventory: session.record.inventory,
      equipment: session.record.equipment,
      coins: session.record.coins,
    });
  }

  /**
   * What the vendor this player has open is offering (spec 129).
   *
   * An empty id closes the shop, and is also the answer to a request the server
   * will not serve -- a client that walked out of range is *told*, rather than
   * being left with a stale price list it can click.
   */
  private sendVendorState(connection: Connection, vendorId: string): void {
    if (connection.playerId === null) return;
    const vendor = vendorId === '' ? null : this.players.vendorFor(connection.playerId, vendorId);
    if (!vendor) {
      connection.openVendorId = '';
      this.send(connection, { type: ServerMessageType.VendorState, vendorId: '', name: '', stock: [], buyback: [] });
      return;
    }
    connection.openVendorId = vendor.id;
    this.send(connection, {
      type: ServerMessageType.VendorState,
      vendorId: vendor.id,
      name: vendor.name,
      stock: vendor.stock.map((defId) => ({ defId, price: buyPrice(defId, vendor) })),
      buyback: this.players.buybackFor(connection.playerId, vendor.id).map((entry) => ({
        defId: entry.defId,
        count: entry.count,
        price: entry.price,
      })),
    });
  }

  // --- trade (spec 132) --------------------------------------------------

  /** The stage byte the wire carries, from the stage the rules use. */
  private static readonly TRADE_STAGES: Readonly<Record<Trade['stage'], number>> = {
    offered: TradeStageValue.Offered,
    open: TradeStageValue.Open,
    confirmed: TradeStageValue.Confirmed,
    done: TradeStageValue.Done,
    cancelled: TradeStageValue.Cancelled,
  };

  /**
   * Tell both sides where the trade now stands.
   *
   * Both, on every change, and each from their own point of view -- `you` is
   * always the player being sent to. A client never derives what the other
   * player is offering; it is told, and what it draws is what the server would
   * swap.
   */
  private publishTrade(trade: Trade): void {
    for (const playerId of partiesOf(trade)) {
      const connection = this.connectionForPlayer(playerId);
      if (!connection) continue;
      const mine = trade.a.playerId === playerId;
      this.send(connection, {
        type: ServerMessageType.TradeState,
        tradeId: trade.id,
        stage: GameServer.TRADE_STAGES[trade.stage],
        revision: trade.revision,
        you: this.tradeSideView(mine ? trade.a : trade.b, trade.revision),
        them: this.tradeSideView(mine ? trade.b : trade.a, trade.revision),
        reason: trade.reason,
      });
    }
  }

  /**
   * One side, resolved to items.
   *
   * Resolved here rather than sent as slot indices, because the other player
   * cannot see into your bag and a bare index would mean nothing to them. A slot
   * that has since emptied resolves to nothing, which is honest: it is exactly
   * what the swap will refuse over.
   */
  private tradeSideView(
    side: Trade['a'],
    revision: number,
  ): { playerId: string; displayName: string; offer: { defId: string; count: number }[]; coins: number; accepted: boolean } {
    const session = this.players.get(side.playerId);
    const bag = session?.record.inventory ?? [];
    const offer: { defId: string; count: number }[] = [];
    for (const entry of side.offer) {
      const stack = bag[entry.index];
      if (stack) offer.push({ defId: stack.defId, count: Math.min(entry.count, stack.count) });
    }
    return {
      playerId: side.playerId,
      displayName: session?.displayName ?? side.playerId,
      offer,
      coins: side.coins,
      accepted: side.acceptedRevision === revision,
    };
  }

  /**
   * Run the exchange if both sides have agreed, and tell everyone either way.
   *
   * The order is the safety argument. The swap is computed from both players'
   * current holdings; only if it succeeds are both written, in one call that
   * assigns both before awaiting anything. A refusal cancels the trade with the
   * reason attached, because a confirmed trade that silently did not happen is
   * the worst of the three outcomes.
   */
  private async settleTrade(trade: Trade): Promise<void> {
    const [aId, bId] = partiesOf(trade);
    const a = this.players.holdingsOf(aId);
    const b = this.players.holdingsOf(bId);
    if (!a || !b) {
      const ended = this.trades.cancelById(trade.id, 'one of you left');
      if (ended) this.endTrade(ended);
      return;
    }

    const result = this.trades.settle(trade, a, b);
    if (!result.ok) {
      const ended = this.trades.cancelById(trade.id, result.reason);
      if (ended) this.endTrade(ended);
      return;
    }

    const written = await this.players.applyTrade(aId, bId, result.a, result.b);
    if (!written.ok) {
      const ended = this.trades.cancelById(trade.id, written.reason);
      if (ended) this.endTrade(ended);
      return;
    }

    this.endTrade(this.trades.finish(trade));
    for (const playerId of [aId, bId]) {
      const connection = this.connectionForPlayer(playerId);
      if (!connection) continue;
      this.sendInventory(connection, 0);
      this.sendStats(connection);
    }
  }

  /** Tell both sides a trade is over, then stop holding it. */
  private endTrade(trade: Trade): void {
    this.publishTrade(trade);
    this.trades.forget(trade.id);
  }

  /**
   * The per-tick check: a trade ends when the players walk apart.
   *
   * On the tick rather than on a timer, because "how far apart are they" is a
   * question about the simulation and the simulation is what advances in ticks.
   * A player who has logged out has no session, which ends it too.
   */
  private sweepTrades(): void {
    for (const trade of this.trades.live()) {
      const [aId, bId] = partiesOf(trade);
      const a = this.players.get(aId);
      const b = this.players.get(bId);
      if (!a || !b) {
        const ended = this.trades.cancelById(trade.id, 'one of you left');
        if (ended) this.endTrade(ended);
        continue;
      }
      if (inTradeRange(a.record.position, b.record.position)) continue;
      const ended = this.trades.cancelById(trade.id, 'you walked too far apart');
      if (ended) this.endTrade(ended);
    }
  }

  // --- the tick ----------------------------------------------------------

  /** One authoritative step. Public so tests can drive it without a clock. */
  tick(): void {
    const inputs: ServerInput[] = [];
    for (const connection of this.connections) {
      // Sampled every tick at the same point -- before this tick's input is
      // taken -- so the floor the pong reports is measured against a consistent
      // instant rather than against wherever a 2Hz sample happened to land.
      connection.queueFloor = Math.min(connection.queueFloor, connection.inputs.length);
      const next = connection.inputs.shift();
      // The stream has reached `applied`, so anything asked for at or before it
      // is due now. A request stamped ahead of the queue waits for its input --
      // unless there is no queue left to wait for, in which case the client is
      // acting between input frames and holding it would simply lose the press.
      const applied = next ? next.seq : connection.lastSeq;
      const starved = connection.inputs.length === 0;
      const due = (afterSeq: number): boolean => afterSeq <= applied || starved;
      // At most one of each per tick, and never both in the same input (spec
      // 092). A cast request and a withdrawal riding one input is a question
      // with no good answer -- the sim has to guess which the player meant
      // first, and guessing wrong either throws a blow they called off or eats a
      // press. They queue separately and `due` turns true for a whole backlog at
      // once (any tick the input queue empties, `starved` makes everything due),
      // so the collision is ordinary rather than exotic.
      //
      // So they go out in the order the player asked for them, a tick apart. The
      // one held back is still first in its queue and comes due next tick,
      // costing a tick of wind-up that is refunded either way.
      const nextCast = connection.pendingCasts.find((pending) => due(pending.afterInputSeq));
      const nextCancel = connection.pendingCancels.find((pending) => due(pending.afterInputSeq));
      // A step is a withdrawal too (spec 079), so an input that asks to walk
      // must not carry a commit either -- `step` reads the pair as "not that
      // one" and refuses it (spec 094). Which is right when the step is the
      // newer ask, and wrong when it is older: a request stamped *after* this
      // frame was sent is a press made once the walking had stopped, and the
      // stale vector on the frame it would ride is not the player changing
      // their mind. That is exactly a chase arriving -- the last frame of the
      // approach still carries a vector, and the swing is asked for on the one
      // after it.
      //
      // So the same answer as above: the older ask goes out now and the commit
      // waits a tick, by when the client's own next frame says whether it is
      // still walking. A commit riding a frame *newer* than itself is left to
      // `step` to refuse, because there the step really is the later word.
      const stepsFirst =
        nextCast !== undefined &&
        next !== undefined &&
        asksToMove(next) &&
        next.seq <= nextCast.afterInputSeq;
      const castFirst =
        nextCast !== undefined &&
        !stepsFirst &&
        (nextCancel === undefined || nextCast.arrivedAt < nextCancel.arrivedAt);
      const cast = castFirst
        ? takeWhere(connection.pendingCasts, (pending) => pending === nextCast)
        : null;
      const cancel =
        !castFirst &&
        nextCancel !== undefined &&
        takeWhere(connection.pendingCancels, (pending) => pending === nextCancel) !== null;

      if (next) {
        if (connection.playerId !== null) {
          this.players.noteInputSeq(connection.playerId, next.seq);
        }
        inputs.push({
          ...next,
          // How many of the client's inputs this frame stands for. One in the
          // healthy case; more when the queue overflowed or the connection lost
          // frames, which is the difference between a speed check that survives
          // a bad connection and one that punishes it.
          seqSpan: Math.max(1, next.seq - connection.appliedSeq),
          castAbilityId: cast?.abilityId ?? '',
          castTargetX: cast?.targetX ?? 0,
          castTargetY: cast?.targetY ?? 0,
          castTargetEntityId: cast?.targetEntityId ?? 0,
          cancelCast: cancel,
        });
        connection.appliedSeq = next.seq;
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
          seqSpan: 1,
          castAbilityId: cast?.abilityId ?? '',
          castTargetX: cast?.targetX ?? 0,
          castTargetY: cast?.targetY ?? 0,
          castTargetEntityId: cast?.targetEntityId ?? 0,
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
      spawnPoints: this.spawnPoints,
      // Where bodies were, so a blow lands on what its attacker saw (spec 149).
      rewind: this.history,
    });
    this.state = result.state;
    // Recorded after the step, so the newest frame is the world this tick ended
    // on -- the same instant the next tick's landings will count back from.
    this.history.record(this.state.tick, this.state.entities.values());
    // Bodies whose grace has run out, and sockets that have gone quiet.
    this.sweepConnections();

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
    // Positions have just been mirrored back into the records, so this is the
    // one moment in the tick where "how far apart are they" is answerable from
    // the same numbers the sim used (spec 132).
    this.sweepTrades();

    // Corrections and combat results go out the tick they happen -- they are
    // rare and latency is the whole point of them. Deltas are the bulk traffic
    // and ride the broadcast divisor instead (spec 057): the world advances at
    // 60Hz, clients hear about it at 20.
    this.dispatchEvents(result.events);
    // Cooldowns ride the same reasoning as corrections: rare, owner-only, and
    // the point of them is that the button greys out the moment it is spent.
    for (const connection of this.connections) this.sendCooldowns(connection, this.state.tick);
    if (this.state.tick % BROADCAST_EVERY_N_TICKS === 0) {
      this.broadcastDeltas();
      for (const connection of this.connections) {
        if (connection.watchingSpawners) this.sendSpawnerStates(connection);
      }
    }
  }

  /**
   * The one number in this server that must not come from the seeded `Rng`
   * (spec 150).
   *
   * That generator is reproducible on purpose -- it is what makes a replay a
   * replay -- which is exactly what a resume token must not be: anybody who
   * knew the seed and the tick could mint somebody else's. `crypto` rather than
   * `node:crypto`, because this file is bundled into the browser tab for
   * single-player and may not import Node.
   */
  private mintSessionToken(): string {
    return crypto.randomUUID();
  }

  private welcome(connection: Connection, playerId: string, entityId: number): void {
    this.send(connection, {
      type: ServerMessageType.Welcome,
      protocolVersion: PROTOCOL_VERSION,
      playerId,
      entityId,
      tick: this.state.tick,
      tickRate: SERVER_TICK_RATE,
      chunkSize: CHUNK_SIZE,
      interestRadius: INTEREST_CHUNK_RADIUS,
      correctionThreshold: this.config.get().correctionThreshold,
      worldSeed: this.worldSeed,
      sessionToken: connection.sessionToken,
    });
  }

  /**
   * What a body is called, for the `Identity` field (spec 145). Null for
   * anything a content table already answers for -- every monster, prop and
   * projectile -- so only players cost the bytes.
   */
  private nameOf(entity: ServerEntity): string | null {
    if (entity.kind !== EntityKindValue.Player) return null;
    if (entity.ownerPlayerId === null) return null;
    return this.players.get(entity.ownerPlayerId)?.record.displayName ?? null;
  }

  /**
   * `base`, or the nearest ring point clear of every other player (spec 145).
   *
   * `except` is the entity being respawned, which is standing where it fell and
   * must not be asked to dodge itself.
   */
  private clearSpawnNear(base: Vec3, except = -1): Vec2 {
    const occupied: Vec2[] = [];
    for (const entity of this.state.entities.values()) {
      if (entity.kind !== EntityKindValue.Player) continue;
      if (entity.id === except) continue;
      if (entity.health <= 0) continue;
      occupied.push({ x: entity.position.x, y: entity.position.y });
    }
    return spawnAround(base, occupied, PLAYER_BODY_RADIUS * 2.5, (x, y) => {
      if (this.terrain.heightAt(x, y) <= WALKABLE_MIN_HEIGHT) return false;
      return !circleBlocked({ x, y }, PLAYER_BODY_RADIUS, this.colliders);
    });
  }

  /**
   * What every spawner is doing, for a client drawing the overlay (spec 076).
   *
   * Built from the map's spawn points rather than from the state map, so a
   * spawner that has never been filled still appears -- an empty marker with a
   * timer at zero is exactly the thing you turned the overlay on to look at.
   */
  private sendSpawnerStates(connection: Connection): void {
    const tick = this.state.tick;
    // Bounded by interest (spec 076's out-of-scope, closed in spec 145). The
    // whole map's markers went to every watcher, which was fine for one client
    // on a map with tens of them and is the wrong shape for either number
    // growing. Same interest window the entity deltas use, one method away.
    const near = new Set(this.chunks.interestChunks(connection.entityId));
    const visible = this.spawnPoints.filter((point) =>
      near.has(this.chunks.keyAt(point.x, point.y)),
    );
    const spawners: SpawnerStatus[] = visible.map((point) => {
      const live = this.state.spawners.get(point.id);
      const occupied = live?.entityId != null && this.state.entities.has(live.entityId);
      return {
        id: point.id,
        monsterId: point.monsterId,
        x: point.x,
        y: point.y,
        state: occupied ? SpawnerStateValue.Occupied : SpawnerStateValue.Waiting,
        ticks: occupied ? 0 : Math.max(0, (live?.readyAtTick ?? 0) - tick),
      };
    });
    this.send(connection, { type: ServerMessageType.SpawnerStates, tick, spawners });
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
      const at = this.clearSpawnNear(DEFAULT_SPAWN, entity.id);
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
        claimedSeq: 0,
        // The teleport home is pardoned the same way a correction is: the client
        // is told to be here, so its next claim starting here is not a hack.
        pardon: { x: position.x, y: position.y, seq: connection.lastSeq },
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
          // A nudge rides the broadcast cadence. The sim measures drift on every
          // tick, and every tick's worth of it describes the same disagreement:
          // sending one per delta converges the client just as fast and costs a
          // twentieth of the traffic. Anything more serious goes out at once.
          if (event.reason === CorrectionReason.Drift) {
            if (this.state.tick - connection.lastDriftTick < BROADCAST_EVERY_N_TICKS) break;
            connection.lastDriftTick = this.state.tick;
          }
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
          // A dead player is not at the table (spec 132). Before the experience
          // award below, and before the `killerId` guard, because a player who
          // died to a fall or to something with no killer is just as dead.
          const dying = this.players.byEntityId(event.entityId);
          if (dying) {
            const ended = this.trades.cancelFor(dying.playerId, 'they were killed');
            if (ended) this.endTrade(ended);
          }
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
            startTick: event.startTick,
            releaseTick: event.releaseTick,
            endTick: event.endTick,
            targetX: event.targetX,
            targetY: event.targetY,
            targetEntityId: event.targetEntityId,
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
        case 'lootRevealed': {
          const drop = this.state.entities.get(event.entityId)?.drop;
          if (!drop) break;
          // To everyone who can see it, not just to the owner: the flare is in
          // the world, so a second player watching it resolve sees the same
          // thing at the same instant.
          this.sendToWatchersOf(
            event.entityId,
            encodeServerMessage(this.lootDropMessage(event.entityId, drop, this.state.tick)),
          );
          break;
        }
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
        (entity) => this.nameOf(entity),
      );
      // Silence is meaningful: a client whose world did not change gets nothing.
      if (DeltaTracker.isEmpty(delta)) continue;
      this.send(connection, delta);

      // A drop's identity does not ride the delta (spec 156), so first sight of
      // one is where its `LootDrop` goes. The `Spawn` bit already means "this
      // client had never heard of it", so there is no second visibility system
      // to keep in step -- and a client walking up to a drop that revealed
      // before it arrived is told the identity here, which is the same code
      // path as a reconnect and needs no case of its own.
      for (const record of delta.upserts) {
        if ((record.fields & EntityField.Spawn) === 0) continue;
        const drop = this.state.entities.get(record.id)?.drop;
        if (!drop) continue;
        this.send(connection, this.lootDropMessage(record.id, drop, this.state.tick));
      }
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
        experience: session.record.experience,
        experienceToNextLevel: experienceForLevel(session.record.level + 1),
        unspentSkillPoints: session.record.unspentSkillPoints,
        unspentAttributePoints: session.record.unspentAttributePoints,
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

  listItems(): readonly AdminItemRow[] {
    return ALL_ITEMS.map((item) => ({
      id: item.id,
      name: item.name,
      slot: item.slot ?? '-',
      levelRequirement: item.levelRequirement,
      // Through `maxStackOf` rather than off the field, which is optional and
      // means 1 when absent -- the console divides by it.
      maxStack: maxStackOf(item.id),
    }));
  }

  kick(playerId: string, reason: string): boolean {
    const connection = this.connectionForPlayer(playerId);
    if (!connection) return false;
    this.drop(connection, `kicked: ${reason}`);
    return true;
  }

  /**
   * A level or experience edit (spec 154), pushed to the player it happened to.
   *
   * The push is the half that would be easy to leave out and impossible to
   * notice from the console: the record and the derived stats are correct
   * immediately, but the client draws its sheet from the last `Stats` message it
   * was sent, so without this an operator sees level 9 in the table while the
   * player sees level 4 until something else happens to send them one.
   */
  async setProgress(
    playerId: string,
    mode: AdminProgressModeValue,
    amount: number,
  ): Promise<AdminOutcome> {
    const result = await this.players.setProgress(playerId, mode, amount);
    if (!result.ok) return { ok: false, detail: result.reason };

    const connection = this.connectionForPlayer(playerId);
    if (connection) {
      this.sendStats(connection);
      // The tree may have been cleared to pay for a lowered level, and the sheet
      // draws the tree from the same message; the bag is untouched, so it is not
      // resent.
      this.send(connection, {
        type: ServerMessageType.Chat,
        channel: ChatChannel.System,
        from: 'World',
        text: `An admin changed your progression: ${result.detail}.`,
      });
    }
    return { ok: true, detail: result.detail };
  }

  async giveItem(playerId: string, defId: string, count: number): Promise<AdminOutcome> {
    const result = await this.players.giveItem(playerId, defId, count);
    if (!result.ok) return { ok: false, detail: result.reason };

    const connection = this.connectionForPlayer(playerId);
    if (connection) {
      // 0 is "unprompted resend" -- there is no client request this answers.
      this.sendInventory(connection, 0);
      this.send(connection, {
        type: ServerMessageType.Chat,
        channel: ChatChannel.System,
        from: 'World',
        text: `You have been given ${count} x ${defId}.`,
      });
    }
    return { ok: true, detail: `gave ${playerId} ${count} x ${defId}` };
  }

  /**
   * Kills a player outright (spec 154).
   *
   * Health to zero and nothing else invented: the sim's own sweep marks a
   * zero-health player `Dead` and leaves the body in the world, and
   * `handleRespawns` already says "You have fallen" and puts them back on their
   * feet after `RESPAWN_DELAY_TICKS`. So an admin kill and a monster's kill end
   * the same way.
   *
   * The one thing the sweep does not do is cancel a trade -- only the `'died'`
   * event does that, and it is emitted by `abilities.ts` when a blow lands, not
   * by the sweep. So this cancels it, exactly as the `'died'` handler does.
   * Without it, killing somebody mid-trade is the one way to be dead and still
   * at the table.
   */
  kill(playerId: string): AdminOutcome {
    const session = this.players.get(playerId);
    if (!session || session.entityId < 0) return { ok: false, detail: `${playerId} is not in the world` };
    const entity = this.state.entities.get(session.entityId);
    if (!entity) return { ok: false, detail: `${playerId} has no body in the world` };
    if (entity.health <= 0) return { ok: false, detail: `${playerId} is already dead` };

    this.state = replaceEntity(this.state, { ...entity, health: 0 });
    this.players.syncFromEntity(playerId, entity.position, entity.facing, 0);

    const ended = this.trades.cancelFor(playerId, 'they were killed');
    if (ended) this.endTrade(ended);

    return { ok: true, detail: `killed ${playerId}` };
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

  /**
   * How far the admin drop throws, in world units (spec 156). Inside the
   * scatter band the real one draws from, so the arc it exercises is the arc a
   * kill produces.
   */
  private static readonly ADMIN_DROP_THROW = 24;

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
      case 'drop': {
        // The developer path (spec 156): a drop of a chosen tier, at a chosen
        // point, with no monster and no luck involved. `magnitude` is the tier's
        // ordinal, and the item is the first row in the table at that tier so
        // that the tiers can be put side by side and compared.
        const rarity = rarityFromByte(Math.max(0, Math.round(magnitude)));
        const definition = ALL_ITEMS.find((item) => (item.rarity ?? 'common') === rarity);
        if (!definition) return `no item is authored at rarity ${rarity}`;
        // A fixed throw rather than the sim's seeded scatter: an admin action
        // must not draw from `state.rng`, or triggering one would shift every
        // roll in the world after it and a replay would stop reproducing.
        const origin: Vec3 = { x, y, z: this.terrain.heightAt(x, y) };
        const lx = x + GameServer.ADMIN_DROP_THROW;
        const position: Vec3 = { x: lx, y, z: this.terrain.heightAt(lx, y) };
        const drop = makeDrop(
          definition.id,
          1,
          rarity,
          // Unowned, so whoever is testing can walk up to it. A rolled drop is
          // always owned; this one is not a roll.
          null,
          origin,
          this.state.tick,
          this.config.get().lootRevealScale,
        );
        const spawned = spawnDrop(this.state, drop, position, this.zones.zoneIdAt(x, y));
        this.state = spawned.state;
        this.chunks.place(spawned.entity.id, position.x, position.y, false);
        return `dropped ${definition.name} (${rarity}) at ${Math.round(position.x)}, ${Math.round(position.y)}`;
      }
      case 'reveal': {
        // The other half of the developer path (spec 156): pull every drop
        // within `magnitude` to its reveal now, so a presentation can be
        // stepped through without waiting for it or restarting the server.
        //
        // The one thing allowed to move a clock that is otherwise snapshotted
        // for life -- and it is an audited admin action for exactly that reason.
        // Note what it still cannot do: **it does not change what the item is.**
        // There is nothing here that could, which is the whole design.
        let revealed = 0;
        for (const entity of [...this.state.entities.values()]) {
          const drop = entity.drop;
          if (!drop || isRevealed(drop, this.state.tick)) continue;
          if (Math.hypot(entity.position.x - x, entity.position.y - y) > magnitude) continue;
          this.state = replaceEntity(this.state, {
            ...entity,
            drop: { ...drop, anticipationTick: this.state.tick, revealTick: this.state.tick },
          });
          // The sim's own crossing test wants `tick === revealTick`, and the
          // tick this ran on is already past its own sweep -- so the notice goes
          // out from here rather than being waited for.
          this.sendToWatchersOf(
            entity.id,
            encodeServerMessage(
              this.lootDropMessage(entity.id, { ...drop, revealTick: this.state.tick }, this.state.tick),
            ),
          );
          revealed += 1;
        }
        return `revealed ${revealed} drop(s) within ${magnitude} units`;
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



/**
 * Removes and returns the first entry a predicate accepts, leaving the rest in
 * order. The pending-cast queues are drained by *due date* rather than by
 * arrival, so this is a shift with a condition on it.
 */
function takeWhere<T>(queue: T[], accepts: (item: T) => boolean): T | null {
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (item !== undefined && accepts(item)) {
      queue.splice(index, 1);
      return item;
    }
  }
  return null;
}
