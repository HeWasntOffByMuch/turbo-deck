/**
 * The client session (spec 057): everything a player needs that is not drawing.
 *
 * Transport-agnostic by construction -- it is handed a {@link Channel}, so the
 * same class is a multiplayer client over a socket and a single-player client
 * over a loopback into a server in the same tab. No DOM, no three.js, no
 * PixiJS, which is what lets it be tested headlessly like the rest of the sim.
 *
 * It owns three things and refuses to own a fourth:
 *
 *  - the **replicated world**, applied from deltas
 *  - the **prediction buffer** for the local player, so input feels immediate
 *  - the **derived stats** the server last sent, which are read and never
 *    recomputed -- the client has no opinion about how much damage it does
 *
 * The fourth is game rules. There are none here. When stage 3 of spec 057
 * repoints the renderer, it reads `view()` and draws it; anything that looks
 * like a rule appearing in this file means it belongs in `src/server/sim/`.
 */

import type { Channel } from '../net/transport.js';
import { MapChunkCache, type HeldChunk } from './map-cache.js';
import {
  decodeServerMessage,
  encodeClientMessage,
  type CastEndedMessage,
  type CastStateMessage,
  type CombatResultMessage,
  type EffectMessage,
  type MapInfoMessage,
  type ServerChatMessage,
  type SpawnerStatus,
  type TradeSideView,
} from '../net/messages.js';
import {
  CastEndReasonValue,
  CastPhaseValue,
  ChunkDeniedReason,
  ClientMessageType,
  CorrectionReason,
  ServerMessageType,
  TradeStageValue,
} from '../net/protocol.js';
import { MAP_CHUNK_REQUEST_RADIUS, PROTOCOL_VERSION } from '../config.js';

/**
 * How many chunks one pass may ask for (spec 072).
 *
 * Comfortably under the server's `MAP_CHUNK_BURST`, so the throttle is a guard
 * against a misbehaving client rather than something that shapes the stream in
 * normal play -- a cold start should be paced by this number, not by a refusal.
 */
const CHUNK_REQUESTS_PER_PASS = 8;

/**
 * How often the backstop pump runs, in client ticks. One broadcast period: often
 * enough that a stalled window recovers within a frame or two, rare enough that
 * it costs nothing when there is nothing to ask for.
 */
const CHUNK_REQUEST_INTERVAL_TICKS = 3;

/**
 * How long to stop asking after a `Throttled` refusal, in client ticks.
 *
 * A quarter second: long enough that the server's bucket has refilled several
 * tokens, short enough that a player walking into new ground does not notice.
 * The alternative -- retrying immediately -- is a refusal storm that makes the
 * throttle worse rather than respecting it.
 */
const CHUNK_THROTTLE_BACKOFF_TICKS = 15;
import { abilityById } from '../data/abilities.js';
import {
  EMPTY_EQUIPMENT,
  type EffectiveStats,
  type Equipment,
  type Inventory,
  type SkillAllocation,
  type SlotAddress,
} from '../state/types.js';
import { applyMove, type MoveRequest } from '../player/inventory.js';
import { createFlatPredictor, PredictionBuffer, type PredictedInput, type PredictStep } from './prediction.js';
import { ReplicatedWorld } from './replica.js';
import {
  advanceCast as advancePredictedCast,
  mayCast,
  modelledResource,
  steerFacing,
  type Mirror,
} from './combat.js';
import { attackTimingFor } from '../sim/abilities.js';
import { NO_ATTACK_SPEED, resolveAttackTiming } from '../sim/attack-timing.js';
import type { CastState } from '../sim/types.js';

export interface WelcomeInfo {
  readonly playerId: string;
  readonly entityId: number;
  readonly tickRate: number;
  readonly chunkSize: number;
  readonly interestRadius: number;
  readonly correctionThreshold: number;
  /** The seed the server's world was built from; build the same one (spec 063). */
  readonly worldSeed: number;
}

export interface GameClientOptions {
  readonly playerId: string;
  readonly displayName?: string;
  readonly token?: string;
  /**
   * The asset manifest hash this build was made against (spec 113).
   *
   * Omitted means "I have no manifest", which the server allows and logs. A
   * hash that is present and differs from the server's is a refused connection:
   * a client on stale assets draws a fight that is not the one being played, and
   * nothing about that is visible until somebody notices a hit landing on the
   * wrong frame.
   */
  readonly assetManifest?: string;
  /**
   * Local movement used for prediction. Defaults to the open-ground walk, which
   * matches the server exactly away from walls, water and cliffs. Stage 3 can
   * pass the server's own movement instead for a closer match.
   */
  readonly predictor?: (stats: EffectiveStats, tickRate: number) => PredictStep;
}

/** What the renderer reads. Read-only, and free of anything derived. */
/** The map, as a renderer sees it (spec 072). */
/** A shop as the client sees it (spec 129). Prices are the server's, always. */
export interface VendorView {
  readonly id: string;
  readonly name: string;
  readonly stock: readonly { readonly defId: string; readonly price: number }[];
  readonly buyback: readonly {
    readonly defId: string;
    readonly count: number;
    readonly price: number;
  }[];
}

/** A trade as the client sees it (spec 132). Replaced whole, never derived. */
export interface TradeView {
  readonly id: number;
  /** One of `TradeStageValue`. */
  readonly stage: number;
  /** What an acceptance has to name. A stale one is not an acceptance. */
  readonly revision: number;
  readonly you: TradeSideView;
  readonly them: TradeSideView;
  readonly reason: string;
}

export interface ClientMapView {
  readonly info: MapInfoMessage;
  readonly chunks: readonly HeldChunk[];
  /**
   * Bumped on every chunk that arrives. A view watches this rather than diffing
   * `chunks`: remeshing is the expensive half and it only needs to know that
   * something landed.
   */
  readonly revision: number;
}

export interface ClientView {
  /**
   * The tick the last delta described. Advances in steps of
   * `BROADCAST_EVERY_N_TICKS`, and **stops entirely** when the server has
   * nothing to say -- deltas are suppressed when nothing changed. Use it to
   * order authoritative samples (interpolation does), never as a clock.
   */
  readonly tick: number;
  /**
   * The client's estimate of the server's current tick.
   *
   * A clock, which `tick` is not. A rooted caster alone in a field changes
   * nothing, so no delta is sent, so `tick` freezes -- and anything drawn
   * against it freezes too. That is exactly what happened to the cast bar: it
   * stopped partway and sat there while the wind-up ran on without it.
   *
   * Advanced by {@link GameClient.advanceTick} once per simulated tick and
   * re-synced to every delta, never backwards. The re-sync adds half the
   * measured round trip (spec 067): a delta describes a tick that is already
   * one-way-latency old, and a clock that believes otherwise is behind by
   * exactly the ping -- which is how a cooldown the server considered ready was
   * still greyed out here, and why the root prediction used to refuse to fire.
   */
  readonly estimatedTick: number;
  /**
   * The measured round trip, in ticks. Diagnostics, and the thing every latency
   * decision on this client is made from.
   */
  readonly roundTripTicks: number;
  /**
   * Ticks until the server acts on the input being sent now: the depth of its
   * input queue (spec 069). Diagnostics, and what a predicted cast is stamped
   * against -- a commit lands when its input is dequeued, not when it arrives.
   */
  readonly commitDelayTicks: number;
  readonly entities: readonly import('./replica.js').ReplicatedEntity[];
  /** The local player's predicted position -- what to draw them at. */
  readonly self: { readonly x: number; readonly y: number } | null;
  readonly selfEntityId: number;
  /**
   * The world the server is running, or null before the welcome lands. A
   * renderer builds its terrain from this and from nothing else.
   */
  readonly worldSeed: number | null;
  /**
   * The map the server is serving, and the pieces of it that have arrived
   * (spec 072). Null until `MapInfo` lands.
   *
   * This -- not {@link worldSeed} -- is where a renderer's terrain comes from
   * now. The seed stays for provenance and for the fight's RNG; it stopped
   * describing the ground the moment the ground became a document somebody
   * could edit by hand.
   */
  readonly map: ClientMapView | null;
  /**
   * What every map spawner is doing (spec 076). Empty unless the client asked
   * for it with {@link GameClient.watchSpawners} -- it is a debug readout, and
   * one nobody is drawing costs nothing.
   */
  readonly spawners: readonly SpawnerStatus[];
  readonly stats: EffectiveStats | null;
  /**
   * What the player is carrying and wearing (spec 126), with any move still in
   * flight already drawn in. Empty until the first `Inventory` message lands.
   *
   * This is where a paperdoll comes from. It is *not* derivable from
   * {@link stats}: two swords with the same numbers are the same stat block and
   * different pictures, which is why the HUD's weapon switch used to click
   * "Hunting Bow" and light "Worn Sword".
   */
  readonly inventory: Inventory;
  readonly equipment: Equipment;
  /** What the player can spend (spec 129). */
  readonly coins: number;
  /**
   * The shop that is open, or null.
   *
   * Whole, and replaced by whatever the server last said -- including an empty
   * one, which is how walking out of range closes it. A client never decides for
   * itself that a shop is shut.
   */
  readonly vendor: VendorView | null;
  /**
   * Bumped by every answer the server gives about a shop, including an empty
   * one. What tells "not asked yet" apart from "asked, and the answer was no".
   */
  readonly vendorRevision: number;
  /**
   * The trade in progress, or null (spec 132).
   *
   * Whole, and replaced by whatever the server last said. A client never decides
   * for itself that a trade has ended -- the same rule the shop follows, and for
   * a stronger reason: a window that closed itself would be a window that thinks
   * an exchange happened when it may not have.
   */
  readonly trade: TradeView | null;
  readonly level: number;
  readonly experience: number;
  readonly unspentSkillPoints: number;
  /**
   * Every point this character has spent (spec 128).
   *
   * Where a skill tree's "you have three of five in this" comes from. Not
   * derivable from {@link stats}: two different builds can add up to the same
   * numbers, which is the same reason equipment had to be replicated rather
   * than inferred.
   */
  readonly skills: readonly SkillAllocation[];
  readonly connected: boolean;
  /** Casts in progress, keyed by caster -- what to draw a wind-up bar over. */
  readonly casts: readonly KnownCast[];
  /**
   * The ability this client asked for and has not heard back about. Purely a
   * local "the button was pressed" hint: the server decides, and clears it.
   */
  readonly requestedAbilityId: string | null;
  /**
   * The point this client is rooted facing, or null when it may walk (spec 067).
   *
   * The server roots a caster outright and only says so a round trip later, so a
   * client that waited to be told kept predicting a walk through its own
   * wind-up -- a few ticks of movement the server discarded, banked as error, on
   * every single blow. This is set the moment an ability is *asked for* and
   * confirmed (or withdrawn) when the server answers.
   *
   * Predicting the root costs nothing when the guess is wrong, which is what
   * makes it safe to predict at all: being rooted means sending `moveX = 0`, and
   * a server that refused the cast honours that zero exactly as it would honour
   * a player choosing to stand still.
   */
  readonly selfRoot: { readonly x: number; readonly y: number } | null;
  /**
   * True while a request of ours has been sent and not yet answered (spec 080).
   *
   * The other half of "am I committed", and the half nothing outside this class
   * could see. {@link selfRoot} is the *cast*, so that it can end on the tick the
   * blow does (spec 069); a request that is still in flight has no cast yet and
   * therefore does not show up there at all. A standing attack order that only
   * watched the root asked again on every tick of that window, and each repeat
   * was a refusal the player got told about.
   *
   * Cleared by whichever answer arrives -- the `CastState` that roots us, the
   * `CastRejected` that does not -- or by the timeout spec 067 carries, so a
   * reply that never comes cannot wedge an order shut.
   */
  readonly awaitingCast: boolean;
  /**
   * Ability id -> the tick it may next be used (spec 065). Straight from the
   * server; the client subtracts the tick it is drawing to get the sweep, and
   * never works out how long a cooldown is for itself.
   */
  readonly cooldowns: Readonly<Record<string, number>>;
  /**
   * The ability pool this client believes it has (spec 069): the server's last
   * word, regenerated forward, minus what it has spent on commits not yet
   * answered. The number a button is greyed out against.
   */
  readonly resource: number;
}

type CombatListener = (result: CombatResultMessage) => void;
type ChatListener = (message: ServerChatMessage) => void;
type ErrorListener = (code: number, message: string) => void;
type CastListener = (cast: CastStateMessage) => void;
type CastEndListener = (end: CastEndedMessage) => void;
type EffectListener = (effect: EffectMessage) => void;
type CastRejectedListener = (abilityId: string, reason: string) => void;

/**
 * A cast this client has asked for and has not heard back about (spec 067).
 *
 * Deliberately *not* a {@link KnownCast}: it is not drawn, it has no phase and
 * no release tick, and nothing reads it but the root. The client still assumes
 * nothing about damage, cost or cooldown -- only that a body which has committed
 * to a blow does not walk, which is the one part of a commit that is expressible
 * as input and therefore the one part worth predicting.
 */
interface PredictedCast {
  /** Distinguishes this request from every other; the predicted cast names it. */
  readonly id: number;
  readonly abilityId: string;
  readonly aim: { readonly x: number; readonly y: number };
  /** The input this request was stamped after; the server commits on it. */
  readonly requestedAtSeq: number;
  /** Given up on past this tick, so a lost reply cannot root a player forever. */
  readonly expiresAtTick: number;
  /**
   * The cooldown this request wrote into {@link GameClient.predictedCooldowns},
   * or null if it wrote none. Carried so a refusal can take back its own guess
   * and only its own: every press here is the same ability, so "drop the guess
   * for melee.slash" would have a stale refusal cancel a live commit's cooldown.
   */
  readonly stampedCooldown: number | null;
  /**
   * The resource this request expects to have spent, still subtracted from the
   * modelled pool because the server has not confirmed it (spec 069). Released
   * on any answer: a commit is reflected in the resource that arrives with it,
   * and a refusal spent nothing.
   */
  readonly spentResource: number;
}

/**
 * How long the client will hold a predicted root waiting for an answer. Two
 * seconds is far past any round trip worth playing on; past it the request is
 * assumed lost and the player gets their legs back.
 */
const PREDICTED_CAST_TIMEOUT_TICKS = 120;

/**
 * How long past its stamped end a cast is held before the client drops it
 * (spec 069).
 *
 * `estimatedTick` is deliberately a forward-biased ratchet -- it is `max`ed
 * upward, never walked back, and carries half a round trip -- so it can lead the
 * server's real tick by a couple. Expiring a cast exactly on `endTick` therefore
 * un-roots slightly early, and the two errors are not worth the same: a tick
 * late is a tick of stillness nobody notices, while a tick early is movement the
 * server discards and later corrects. So it leans late, by the smallest amount
 * that covers the bias.
 */
const CAST_EXPIRY_SLACK_TICKS = 2;

/** How often the client measures the round trip. Twice a second is plenty. */
const PING_EVERY_TICKS = 30;

/** How many round-trip samples to keep. The minimum of these is the estimate. */
const ROUND_TRIP_SAMPLES = 8;

/**
 * The timing a confirmed cast is dressed with before this client knows its own
 * stats -- one tick of everything, and nothing draws from it.
 *
 * Reachable only in the window between the first `CastState` and the first
 * `Stats`, which the server sends inside the welcome, so it exists to keep the
 * type honest rather than because anything reads it.
 */
const DEAD_RECKONED_TIMING = resolveAttackTiming(
  { baseAttackTimeTicks: 1, baseAttackPointTicks: 1, baseAttackBackswingTicks: 0 },
  NO_ATTACK_SPEED,
  60,
);

/** A cast the client knows about, as it is drawn. */
export interface KnownCast {
  readonly entityId: number;
  readonly abilityId: string;
  readonly phase: number;
  /** The tick the wind-up began, so a scaled bar has an origin (spec 144). */
  readonly startTick: number;
  readonly releaseTick: number;
  readonly endTick: number;
  readonly targetX: number;
  readonly targetY: number;
  /** The body it was aimed at, or 0 for a point aim (spec 070). */
  readonly targetEntityId: number;
}

export class GameClient {
  private readonly world = new ReplicatedWorld();
  private prediction: PredictionBuffer | null = null;
  private welcome: WelcomeInfo | null = null;
  /** The map and the chunks of it that have arrived (spec 072). */
  private mapCache: MapChunkCache | null = null;
  /** Ticks to wait before asking for chunks again, after being throttled. */
  private chunkBackoffTicks = 0;
  /** The spawner readout, when it has been asked for (spec 076). */
  private spawners: readonly SpawnerStatus[] = [];
  private stats: EffectiveStats | null = null;
  /**
   * The containers as the server last described them, and the guess drawn on top
   * (spec 126).
   *
   * Two copies on purpose, and the same shape prediction has for movement: the
   * server's word is what a replay starts from, and the predicted pair is what a
   * view reads. Keeping only the guess would leave nothing to roll back *to*.
   */
  private serverInventory: Inventory = [];
  private serverEquipment: Equipment = EMPTY_EQUIPMENT;
  private inventory: Inventory = [];
  private coins = 0;
  private vendorView: VendorView | null = null;
  /**
   * How many answers about a shop this client has had (spec 131).
   *
   * A count rather than a flag, because the question it answers is "has the
   * server replied *since I asked*" -- and a caller that only watched
   * {@link vendorView} cannot tell "no answer yet" from "answered, and there is
   * no shop". Which is exactly how the shop window used to open and shut itself
   * on the same frame, forever.
   */
  private vendorReplies = 0;
  /** The trade this client is in, or null (spec 132). Replaced whole. */
  private tradeView: TradeView | null = null;
  private equipment: Equipment = EMPTY_EQUIPMENT;
  /** Moves sent and not yet answered, oldest first. */
  private readonly pendingMoves: { readonly requestId: number; readonly request: MoveRequest }[] = [];
  private moveRequests = 0;
  private shopRequests = 0;
  private level = 1;
  private experience = 0;
  private unspentSkillPoints = 0;
  private skills: readonly SkillAllocation[] = [];
  private seq = 0;
  private connected = false;
  private resolveWelcome: ((info: WelcomeInfo) => void) | null = null;
  private rejectWelcome: ((error: Error) => void) | null = null;
  private readonly combatListeners: CombatListener[] = [];
  private readonly chatListeners: ChatListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];
  private readonly castListeners: CastListener[] = [];
  private readonly castEndListeners: CastEndListener[] = [];
  private readonly effectListeners: EffectListener[] = [];
  private readonly castRejectedListeners: CastRejectedListener[] = [];
  private readonly casts = new Map<number, KnownCast>();
  private requestedAbilityId: string | null = null;
  private cooldowns: Readonly<Record<string, number>> = {};
  private estimated = 0;
  /**
   * Ability requests sent and not yet answered, oldest first (spec 067).
   *
   * A queue rather than a slot, because the answers are what identify them: the
   * server handles requests in the order they arrive and answers each exactly
   * once -- `CastState` if it took it, `CastRejected` if it did not -- so the
   * n-th reply belongs to the n-th request. Matching them up matters as soon as
   * there is any latency at all: with a single slot, the refusal of a request
   * made half a second ago cleared the root of one made since, and the client
   * walked through a wind-up the server had already committed to.
   */
  private readonly outstandingCasts: PredictedCast[] = [];
  /**
   * Cooldowns this client has spent and not yet been told about (spec 067).
   *
   * The server stamps a cooldown the moment it commits, and says so -- but that
   * message is a round trip away, and a player spamming a button presses it
   * several times inside one. Without this the client's copy still reads
   * "ready", so it predicts a root for every press, and a spam-clicker at 200ms
   * is rooted by their own refused requests and never walks again.
   *
   * The same table the server uses, read from the same row, overwritten by the
   * server's own value the moment it lands. Predicting a cooldown decides
   * nothing -- the server refuses or does not -- it only decides whether this
   * client expects to be rooted.
   *
   * `fromTick` is when the server will stamp it: the release, not the press
   * (spec 091). The guess is made at the press because that is when there is
   * something to guess, but it is not *shown* until the blow has gone off --
   * a sweep that starts during the wind-up would be drawing a cooldown the
   * withdrawal is about to make untrue. {@link mirror} takes it from the press
   * regardless, because that half asks "may I start another one", where being
   * early is the safe direction.
   */
  private readonly predictedCooldowns = new Map<
    string,
    { readonly readyAtTick: number; readonly fromTick: number }
  >();
  /**
   * The cast this client has committed to locally and is drawing (spec 069).
   *
   * Put on the view as an ordinary cast for the local entity, so `scene.ts` and
   * `hud.ts` draw the bar, the sweep and the rooted body without knowing that
   * any of it was predicted -- which is the sim/render split doing the work
   * rather than a convenience.
   *
   * Superseded by the server's own `CastState` the moment it lands, and dropped
   * outright if the request that made it is refused.
   */
  private predictedCast: CastState | null = null;
  /** Which request {@link predictedCast} came from, so only that one clears it. */
  private predictedCastRequestId = -1;
  private nextCastRequestId = 1;
  /**
   * This client's own facing, stepped the way the server steps it (spec 069).
   *
   * The renderer keeps a facing for drawing; this is a separate one, kept here,
   * because the *gate* depends on it: whether a press begins winding up or first
   * spends ticks turning is decided by where the body is pointing, and a client
   * that assumed it was always aligned would predict a wind-up that had not
   * started. Seeded from the first authoritative position and stepped by
   * `steerFacing`, which mirrors `resolveFacing` in the sim.
   */
  private facing = 0;
  private facingSeeded = false;
  /** The last facing this client asked for, which is what it steers toward. */
  private wantedFacing = 0;
  /**
   * The last resource the server reported, and the tick it was true on (spec
   * 068). Regenerated forward locally between messages; `-1` until the first
   * `Cooldowns` message, before which nothing is predicted that costs anything.
   */
  /** The last input the server said it had applied; the queue is everything since. */
  private lastAckedSeq = 0;
  /** Recent input-queue depths, sampled at each delta; the minimum is used. */
  private readonly queueDepths: number[] = [];
  private serverResource = -1;
  private serverResourceTick = 0;
  /** Ticks since this client started, which is the only clock it has. */
  private localTick = 0;
  private nextPingNonce = 1;
  /** Nonce -> the local tick it went out on, so a pong measures a round trip. */
  private readonly pingsInFlight = new Map<number, number>();
  /** Recent round trips in ticks; the minimum is the estimate that is used. */
  private readonly roundTrips: number[] = [];

  constructor(
    private readonly channel: Channel,
    private readonly options: GameClientOptions,
  ) {
    channel.onMessage((bytes) => this.receive(bytes));
    channel.onClose(() => {
      this.connected = false;
    });
  }

  /** Sends the hello and resolves once the server has welcomed us. */
  connect(): Promise<WelcomeInfo> {
    const pending = new Promise<WelcomeInfo>((resolve, reject) => {
      this.resolveWelcome = resolve;
      this.rejectWelcome = reject;
    });
    this.channel.send(
      encodeClientMessage({
        type: ClientMessageType.Hello,
        protocolVersion: PROTOCOL_VERSION,
        playerId: this.options.playerId,
        displayName: this.options.displayName ?? this.options.playerId,
        token: this.options.token ?? '',
        // What this build's assets hash to, or empty when the caller has no
        // manifest -- the in-tab server and the bot harness share a process
        // with the thing they are connecting to (spec 113).
        assetManifest: this.options.assetManifest ?? '',
      }),
    );
    return pending;
  }

  /**
   * Applies an input locally and sends it. Returns the predicted position, so a
   * caller can draw this frame without waiting for a round trip.
   *
   * Silently does nothing before the first delta places us: predicting from a
   * position the server has not confirmed is how a client ends up claiming an
   * impossible distance travelled and being corrected on every single tick.
   */
  sendInput(intent: Omit<PredictedInput, 'seq'>): { readonly x: number; readonly y: number } | null {
    if (!this.prediction || !this.connected) return null;
    this.seq += 1;
    // Remembered so the local body can be steered the way the server steers it
    // (spec 069): this is what it will turn toward on every tick until the next
    // input, and whether it has arrived decides whether the next press winds up
    // or spends ticks turning first.
    if (Number.isFinite(intent.facing)) this.wantedFacing = intent.facing;
    // Asking to move withdraws from a cast (spec 079), and the server settles
    // that on the very tick this input lands. Predicting the walk without also
    // predicting the withdrawal would keep the legs locked locally while the
    // server moved them -- a correction on every tick of the step away, and a
    // bar still draining for a blow that has been called off.
    if (Math.hypot(intent.moveX, intent.moveY) > 1e-6) this.withdrawLocally();
    const input: PredictedInput = { ...intent, seq: this.seq };
    const predicted = this.prediction.apply(input);
    this.channel.send(
      encodeClientMessage({
        type: ClientMessageType.Input,
        ...input,
        predictedX: predicted.x,
        predictedY: predicted.y,
      }),
    );
    return predicted;
  }

  equip(slot: string, itemId: string): void {
    this.channel.send(encodeClientMessage({ type: ClientMessageType.Equip, slot, itemId }));
  }

  unequip(slot: string): void {
    this.channel.send(encodeClientMessage({ type: ClientMessageType.Unequip, slot }));
  }

  /**
   * Ask to move an item, and draw the result immediately (spec 126).
   *
   * Predicted, unlike a cast: the rules are pure and this client has the same
   * copy of them the server runs, so guessing costs nothing when it is right and
   * is undone by the answer when it is wrong. `count` of 0 means the whole stack.
   *
   * Returns the request id, so a caller can tell its own move from a resend.
   */
  moveItem(from: SlotAddress, to: SlotAddress, count = 0): number {
    if (!this.connected) return 0;
    this.moveRequests += 1;
    const requestId = this.moveRequests;
    const request: MoveRequest = { from, to, ...(count === 0 ? {} : { count }) };
    this.pendingMoves.push({ requestId, request });
    this.replayMoves();
    this.channel.send(
      encodeClientMessage({ type: ClientMessageType.MoveItem, requestId, from, to, count }),
    );
    return requestId;
  }

  /**
   * Rebuild the predicted containers from the server's last word plus every
   * move still in flight.
   *
   * The same shape as movement reconciliation, and for the same reason: with two
   * drags in flight, the answer to the first one describes a world where the
   * second has not happened, and adopting it wholesale would make the second
   * drag flicker back for a round trip. A refused move simply is not in this
   * list any more, so the rollback is this function finding one fewer.
   */
  private replayMoves(): void {
    let bag = this.serverInventory;
    let worn = this.serverEquipment;
    for (const pending of this.pendingMoves) {
      const outcome = applyMove(bag, worn, pending.request, this.level);
      // A guess the local rules refuse is simply not drawn. The server is about
      // to refuse it too, and predicting an illegal move is worse than lagging.
      if (!outcome.ok) continue;
      bag = outcome.inventory;
      worn = outcome.equipment;
    }
    this.inventory = bag;
    this.equipment = worn;
  }

  /**
   * Ask what a vendor has, or close whatever is open with an empty id.
   *
   * Nothing about a shop is predicted. A purchase is not a drag -- there is no
   * ghost to draw and no gesture to keep up with -- and the money is the one
   * number nobody wants to watch flicker and settle.
   */
  /**
   * The last trade to end, and how (spec 132).
   *
   * Kept because the ending is the one message a player most needs and the
   * trade itself is gone by then: "cancelled -- you walked too far apart" has to
   * outlive the trade it describes.
   */
  private lastTrade: TradeView | null = null;

  get endedTrade(): TradeView | null {
    return this.lastTrade;
  }

  inviteToTrade(entityId: number): void {
    if (!this.connected) return;
    this.channel.send(encodeClientMessage({ type: ClientMessageType.TradeInvite, entityId }));
  }

  respondToTrade(accept: boolean): void {
    if (!this.connected) return;
    this.channel.send(encodeClientMessage({ type: ClientMessageType.TradeRespond, accept }));
  }

  offerInTrade(slots: readonly { readonly index: number; readonly count: number }[], coins: number): void {
    if (!this.connected) return;
    this.channel.send(encodeClientMessage({ type: ClientMessageType.TradeOffer, slots, coins }));
  }

  acceptTrade(revision: number): void {
    if (!this.connected) return;
    this.channel.send(encodeClientMessage({ type: ClientMessageType.TradeAccept, revision }));
  }

  cancelTrade(): void {
    if (!this.connected) return;
    this.channel.send(encodeClientMessage({ type: ClientMessageType.TradeCancel }));
  }

  openVendor(vendorId: string): void {
    if (!this.connected) return;
    if (vendorId === '') this.vendorView = null;
    this.channel.send(encodeClientMessage({ type: ClientMessageType.OpenVendor, vendorId }));
  }

  buyItem(vendorId: string, defId: string, count = 1): number {
    if (!this.connected) return 0;
    this.shopRequests += 1;
    this.channel.send(
      encodeClientMessage({
        type: ClientMessageType.BuyItem,
        requestId: this.shopRequests,
        vendorId,
        defId,
        count,
      }),
    );
    return this.shopRequests;
  }

  sellItem(vendorId: string, index: number, count = 1): number {
    if (!this.connected) return 0;
    this.shopRequests += 1;
    this.channel.send(
      encodeClientMessage({
        type: ClientMessageType.SellItem,
        requestId: this.shopRequests,
        vendorId,
        index,
        count,
      }),
    );
    return this.shopRequests;
  }

  buyBack(vendorId: string, index: number): number {
    if (!this.connected) return 0;
    this.shopRequests += 1;
    this.channel.send(
      encodeClientMessage({
        type: ClientMessageType.BuyBack,
        requestId: this.shopRequests,
        vendorId,
        index,
      }),
    );
    return this.shopRequests;
  }

  spendSkillPoint(skillId: string): void {
    this.channel.send(encodeClientMessage({ type: ClientMessageType.SpendSkillPoint, skillId }));
  }

  /**
   * Asks to commit to an ability. The *effect* is still not predicted -- the
   * local state is "requested", and only the server's CastState makes a cast
   * real. Predicting damage is a much larger commitment than predicting a walk,
   * and guessing wrong about a hit is far more visible than guessing wrong about
   * a step.
   *
   * What is predicted, since spec 067, is the root: from here until the server
   * answers, this client asks for no movement. The request carries the last
   * input seq so the server commits at the same point in the stream.
   */
  /**
   * Ask the server to keep {@link ClientView.spawners} up to date, or to stop
   * (spec 076).
   *
   * The one request that asks for a readout rather than an action, which is why
   * it is off by default: a view that is not drawing the overlay should not be
   * paying twenty messages a second for it.
   */
  watchSpawners(on: boolean): void {
    if (!this.connected) return;
    if (!on) this.spawners = [];
    this.channel.send(encodeClientMessage({ type: ClientMessageType.WatchSpawners, on }));
  }

  useAbility(
    abilityId: string,
    targetX = 0,
    targetY = 0,
    targetEntityId = 0,
    /**
     * The named body's radius, so the gate below is the server's gate (spec
     * 080). Reach to a body is measured to its edge; a client that measured to
     * its centre refused to predict every attack in the band between the two
     * and the server took them all.
     */
    targetRadius = 0,
  ): void {
    if (!this.connected) return;
    this.requestedAbilityId = abilityId;
    const aim = { x: targetX, y: targetY };
    // The server's own gate, asked of a mirror of this entity (spec 069). What
    // it decides is what the server will decide, given the same entity -- so a
    // wrong guess here means a field of the mirror was stale, never that the
    // client and the server disagree about the rules.
    //
    // The horizon still leans, as it did in 067: "will this be ready" is asked a
    // whole round trip ahead rather than the half it strictly needs, because the
    // two ways of being wrong do not cost the same. Predicting a commit the
    // server refuses shows a bar that vanishes; failing to predict one it takes
    // is a whole wind-up of walking the server discarded, and a correction.
    // The cast is stamped for the tick the *server* will start it on, which is
    // one one-way trip from now: the request has to get there before it can be
    // committed to. Stamping it at "now" instead runs the whole cast early --
    // the harness draws it as three ticks of bar before the server has one, at
    // loopback, and one full trip at 200ms -- and a bar that finishes before the
    // blow does is a body that stops being rooted while the server still is.
    //
    // The root is *not* deferred with it: it applies from the press, because a
    // client that walks while its own request is in flight is a client the
    // server will discard movement from. Standing still costs nothing when the
    // guess is wrong (spec 067); walking through a commit costs a correction.
    const commitAt = this.estimated + this.commitDelayTicks();
    const mirror = this.mirror(commitAt);
    // Readiness is judged at the tick the server will *commit* on -- the same
    // tick the cast is stamped for. One number, asked once (spec 070).
    //
    // 069 judged it at `estimated + roundTrip` and leaned deliberately forward,
    // on the argument that failing to predict a commit costs more than
    // predicting one that is refused. The lean was measuring the wrong gap: a
    // request waits on the input *queue*, not on the wire, and on a loopback
    // that is three ticks while the round trip is zero. Every cooldown this
    // client stamps already runs from `commitAt`, so asking "is it ready now"
    // against a number stamped for later made the client pessimistic by exactly
    // the queue depth, and drew no bar at all for a swing the server took.
    //
    // Leaning *past* `commitAt` is worse than either, and the harness says so
    // plainly: the extra requests are refused, and a refusal stamps a cooldown
    // of its own that outlives the press it came from and blocks the next real
    // one. Judging at the commit tick is not a compromise between the two -- it
    // is the only tick about which there is anything true to say.
    const decision = mirror
      ? mayCast(mirror, abilityId, aim, commitAt, commitAt, targetEntityId, targetRadius)
      : null;
    const id = this.nextCastRequestId;
    this.nextCastRequestId += 1;

    let stampedCooldown: number | null = null;
    let spentResource = 0;
    if (decision?.ok) {
      stampedCooldown = decision.readyAtTick;
      spentResource = decision.cost;
      this.predictedCooldowns.set(abilityId, {
        readyAtTick: stampedCooldown,
        fromTick: decision.cast.releaseTick,
      });
      // Stamped against the estimated clock rather than the lookahead one: the
      // bar the player is about to watch is drawn against `estimatedTick`, and a
      // cast stamped a round trip into the future would start empty and stay
      // that way until the clock caught up with it.
      this.predictedCast = decision.cast;
      this.predictedCastRequestId = id;
    }


    this.outstandingCasts.push({
      id,
      abilityId,
      aim,
      requestedAtSeq: this.seq,
      expiresAtTick: this.estimated + PREDICTED_CAST_TIMEOUT_TICKS,
      stampedCooldown,
      spentResource,
    });
    this.channel.send(
      encodeClientMessage({
        type: ClientMessageType.UseAbility,
        abilityId,
        targetX,
        targetY,
        targetEntityId,
        afterInputSeq: this.seq,
      }),
    );
  }

  cancelCast(): void {
    if (!this.connected) return;
    // Withdrawing frees the legs on the server, so the predicted cast goes with
    // it -- keeping it would root a player who has just asked not to be, and
    // draw a bar for a blow they have withdrawn from. The request itself stays
    // outstanding: it will still be answered, and that answer still has a
    // cooldown and a cost to give back.
    this.withdrawLocally();
    this.channel.send(
      encodeClientMessage({ type: ClientMessageType.CancelCast, afterInputSeq: this.seq }),
    );
  }

  /**
   * Whether asking for this ability is likely enough to succeed to be worth
   * predicting a root for.
   *
   * Not a rule -- the server decides, and refuses for reasons this cannot see
   * (resource, range, being dead). It is the cheap half of the same question,
   * asked of numbers the server itself sent, so that spamming a button on
   * cooldown does not stutter the player's own legs once per press.
   */
  /**
   * This client's own entity as it believes it to be, or null before it knows
   * enough to have a belief (spec 069).
   *
   * Assembled from the most authoritative source for each field: position from
   * the prediction buffer's *truth* rather than its drawn value -- the drawn one
   * lags deliberately while a correction eases, and range is not a presentation
   * question -- facing from the locally stepped copy, health from the replica,
   * resource from the server's last word carried forward, cooldowns from the
   * server's table plus what this client has spent and not been told about.
   */
  private mirror(atTick: number): Mirror | null {
    const self = this.welcome ? this.world.get(this.welcome.entityId) : null;
    if (!self || !this.stats || !this.prediction) return null;
    const cooldowns: Record<string, number> = { ...this.cooldowns };
    for (const [abilityId, guess] of this.predictedCooldowns) {
      cooldowns[abilityId] = Math.max(cooldowns[abilityId] ?? 0, guess.readyAtTick);
    }
    return {
      position: this.prediction.position,
      facing: this.facing,
      health: self.health,
      resource: this.modelledResource(),
      cooldowns,
      // The cast as it will stand *when the server gets there*, not as it stands
      // now. A blow that ends before this request is dequeued does not make the
      // request `alreadyCasting`, and treating it as if it did was worth a
      // missed prediction on every press that landed in the tail of the
      // previous swing -- the client drew nothing, and the server cast anyway.
      cast: this.castAsOf(atTick),
      stats: this.stats,
    };
  }

  /** The cast this client will still be in at `tick`, or null if it is over. */
  private castAsOf(tick: number): CastState | null {
    const cast = this.selfCast();
    if (!cast) return null;
    return tick < cast.endTick ? cast : null;
  }

  /**
   * The pool this client believes it has. Full until the server has said
   * otherwise: refusing to predict anything before the first `Cooldowns` message
   * would make the very first blow of a session the one that feels worst.
   */
  private modelledResource(): number {
    if (!this.stats) return 0;
    const unconfirmed = this.outstandingCasts.reduce((sum, cast) => sum + cast.spentResource, 0);
    if (this.serverResource < 0) return Math.max(0, this.stats.maxResource - unconfirmed);
    return modelledResource(
      this.serverResource,
      this.serverResourceTick,
      unconfirmed,
      this.stats,
      this.estimated,
    );
  }

  /**
   * Drops the local body's cast, however it was come by: the one this client
   * only predicted, and the one the server confirmed.
   *
   * Both halves, because {@link selfCast} prefers the confirmed one and it is
   * what roots the legs -- clearing only the guess would leave a body that has
   * withdrawn standing still until `CastEnded` came back a round trip later. The
   * server's own message still arrives and is still what makes it final; this
   * only stops the wait from being visible.
   *
   * The guessed cooldown goes with it (spec 091). Since the server stamps at the
   * release, a wind-up that is withdrawn from is never announced at all, so
   * there is no later message for the ordinary retirement rule to catch: a guess
   * left behind here would grey the button out until its own number expired, for
   * a swing that never happened.
   */
  private withdrawLocally(): void {
    const live = this.predictedCast ?? (this.welcome ? this.casts.get(this.welcome.entityId) : null);
    if (live) this.predictedCooldowns.delete(live.abilityId);
    this.predictedCast = null;
    this.predictedCastRequestId = -1;
    if (this.welcome) this.casts.delete(this.welcome.entityId);
  }

  /** The cast the local entity is in: the server's if it has one, else the guess. */
  private selfCast(): CastState | null {
    const confirmed = this.welcome ? this.casts.get(this.welcome.entityId) : undefined;
    if (confirmed) {
      const ability = abilityById(confirmed.abilityId);
      return {
        abilityId: confirmed.abilityId,
        startedTick: confirmed.startTick,
        windupStartTick: confirmed.startTick,
        releaseTick: confirmed.releaseTick,
        endTick: confirmed.endTick,
        phase: confirmed.phase,
        // Past the attack point, and so past the point of taking anything back
        // (spec 144). Read off the phase rather than off the clock because the
        // server is the one that decides, and the phase is what it sent.
        committed:
          confirmed.phase === CastPhaseValue.Backswing ||
          confirmed.phase === CastPhaseValue.Channel,
        // Rebuilt rather than replicated: the timing is a pure function of the
        // ability and this client's own stats, and both ends have both.
        timing:
          ability && this.stats
            ? attackTimingFor(ability, { stats: this.stats })
            : DEAD_RECKONED_TIMING,
        targetX: confirmed.targetX,
        targetY: confirmed.targetY,
        targetEntityId: confirmed.targetEntityId,
        nextPulseTick: 0,
      };
    }
    return this.predictedCast;
  }

  /** Retires the oldest unanswered request; every reply answers exactly one. */
  private answerOldestCast(): PredictedCast | null {
    return this.outstandingCasts.shift() ?? null;
  }

  /** The cast this entity is in the middle of, or null. */
  castOf(entityId: number): KnownCast | null {
    return this.casts.get(entityId) ?? null;
  }

  onCastStarted(listener: CastListener): void {
    this.castListeners.push(listener);
  }

  onCastEnded(listener: CastEndListener): void {
    this.castEndListeners.push(listener);
  }

  onEffect(listener: EffectListener): void {
    this.effectListeners.push(listener);
  }

  onCastRejected(listener: CastRejectedListener): void {
    this.castRejectedListeners.push(listener);
  }

  say(text: string): void {
    this.channel.send(encodeClientMessage({ type: ClientMessageType.Chat, text }));
  }

  onCombatResult(listener: CombatListener): void {
    this.combatListeners.push(listener);
  }

  onChat(listener: ChatListener): void {
    this.chatListeners.push(listener);
  }

  onError(listener: ErrorListener): void {
    this.errorListeners.push(listener);
  }

  /**
   * Advances the estimated clock by one tick. The caller drives this from the
   * same fixed-timestep loop it sends input on, so the estimate keeps time with
   * the server whether or not the server has anything to report.
   */
  advanceTick(): void {
    this.estimated += 1;
    this.localTick += 1;
    // Chunk requests cannot ride on deltas alone: a delta is suppressed when
    // nothing in the world changed, so a player standing still in an empty
    // field would stop asking and sit on a half-loaded map. This is the pump
    // that does not depend on anything happening.
    if (this.chunkBackoffTicks > 0) this.chunkBackoffTicks--;
    if (this.localTick % CHUNK_REQUEST_INTERVAL_TICKS === 0) this.requestChunks();
    // One tick of easing off the last drift correction, and one tick closer to
    // giving up on an ability request nobody answered.
    this.prediction?.decay();
    this.stepPredictedCast();
    // A reply that never came. Dropping the request rather than only its root,
    // because a queue that never drains would mismatch every later answer.
    while (
      this.outstandingCasts.length > 0 &&
      this.estimated > (this.outstandingCasts[0]?.expiresAtTick ?? 0)
    ) {
      this.outstandingCasts.shift();
    }
    if (this.connected && this.localTick % PING_EVERY_TICKS === 0) this.ping();
  }

  /**
   * One tick of the local body: where it is looking, and how far through its
   * own predicted cast it is (spec 069).
   *
   * The facing is stepped whether or not a cast is running, because the gate for
   * the *next* press reads it. The predicted cast retires itself at its own
   * `endTick` -- which is the whole point, and what 067 could not do: it held a
   * guess with no duration, so it had to wait to be told the blow was over and
   * stood the player still for a round trip past the end of it.
   */
  private stepPredictedCast(): void {
    if (!this.prediction || !this.stats) return;
    const position = this.prediction.position;
    this.facing = steerFacing(
      this.facing,
      this.selfCast(),
      position,
      this.wantedFacing,
      this.stats.turnRate,
      this.welcome?.tickRate ?? 60,
    );
    // A confirmed cast is over when the server's own `endTick` says it is, not
    // when `CastEnded` gets here (spec 069).
    //
    // 067 waited to be told, and called that caution: "guessing the end of a
    // cast injects exactly the error this spec removes from the start of one".
    // The difference now is that this is not a guess -- `endTick` is the
    // server's number, sent by the server, and re-sent whenever a turn re-stamps
    // it. Waiting for the message that follows it just adds a one-way trip of
    // standing still to the end of every blow, which is exactly the `over-root`
    // the harness was reporting.
    for (const [entityId, cast] of this.casts) {
      // A cast still *turning* has no end to expire against: the server stamps
      // `endTick` provisionally at the commit and re-stamps it at alignment,
      // because the wind-up clock only starts once the body is pointing at what
      // it committed to (spec 065). A turn of unknown length cannot be timed out
      // against a number that is explicitly a placeholder, so a turning cast is
      // ended only by the server -- by the re-stamp, or by `CastEnded`.
      if (cast.phase === CastPhaseValue.Turning) continue;
      if (this.estimated > cast.endTick + CAST_EXPIRY_SLACK_TICKS) this.casts.delete(entityId);
    }

    if (!this.predictedCast) return;
    this.predictedCast = advancePredictedCast(
      this.predictedCast,
      this.facing,
      position,
      this.estimated,
      abilityById(this.predictedCast.abilityId),
    );
    if (!this.predictedCast) this.predictedCastRequestId = -1;
  }

  /**
   * Measures the round trip, in ticks, using the only clock this class is
   * allowed: its own tick counter. No `Date.now`, no `performance` -- the
   * renderer drives `advanceTick` from a fixed timestep, so counting ticks
   * between a ping and its pong measures the same thing a stopwatch would and
   * keeps this file runnable in Node.
   */
  private ping(): void {
    const nonce = this.nextPingNonce;
    this.nextPingNonce = (this.nextPingNonce % 0xffffffff) + 1;
    this.pingsInFlight.set(nonce, this.localTick);
    // A pong that never comes must not leak; the map holds a couple of seconds
    // of them at most.
    for (const [old, sentAt] of this.pingsInFlight) {
      if (this.localTick - sentAt > PING_EVERY_TICKS * 4) this.pingsInFlight.delete(old);
    }
    this.channel.send(encodeClientMessage({ type: ClientMessageType.Ping, nonce }));
  }

  /** Half the round trip: how old a delta is by the time it lands. */
  private oneWayTicks(): number {
    return Math.round(this.measuredRoundTrip() / 2);
  }

  /**
   * How many ticks until the server acts on the input being sent now (spec 069).
   *
   * An ability request is stamped with an input seq and held until the server
   * dequeues *that* input (spec 067), and the server dequeues exactly one per
   * tick. So the wait is the depth of that queue -- not the latency, which is a
   * different quantity that happens to be zero on a loopback while the queue is
   * still three deep, because a renderer sends a frame's worth of inputs at once
   * and the server spends them one at a time.
   *
   * Measured, not assumed: `ackInputSeq` says which input the server had reached,
   * and everything sent since is still queued. That ack is one one-way trip old,
   * so the server has since worked through roughly that many more.
   */
  private commitDelayTicks(): number {
    if (this.queueDepths.length === 0) return 0;
    // The minimum, and sampled only when a delta lands, for the same reason the
    // round trip uses the minimum: `seq - ack` climbs between deltas simply
    // because inputs keep being sent while the ack stands still, so read
    // continuously it is a sawtooth from three to eight rather than a depth. The
    // ack is itself one trip old, so the server has since worked through that
    // many more of them.
    return Math.max(0, Math.min(...this.queueDepths) - this.oneWayTicks());
  }

  /** The best round trip seen lately, in ticks. */
  private measuredRoundTrip(): number {
    if (this.roundTrips.length === 0) return 0;
    // The *minimum* rather than the average. A round trip can only be inflated
    // by queueing -- at the socket, in the tick loop, behind a slow frame -- so
    // the smallest sample is the closest to the connection's real latency, and
    // an average would track congestion instead of distance.
    return Math.min(...this.roundTrips);
  }

  view(): ClientView {
    return {
      tick: this.world.tick,
      estimatedTick: this.estimated,
      roundTripTicks: this.roundTrips.length === 0 ? 0 : Math.min(...this.roundTrips),
      commitDelayTicks: this.commitDelayTicks(),
      entities: this.world.all(),
      self: this.prediction?.drawn ?? null,
      selfEntityId: this.welcome?.entityId ?? -1,
      worldSeed: this.welcome?.worldSeed ?? null,
      map: this.mapView(),
      spawners: this.spawners,
      stats: this.stats,
      inventory: this.inventory,
      equipment: this.equipment,
      coins: this.coins,
      vendor: this.vendorView,
      vendorRevision: this.vendorReplies,
      trade: this.tradeView,
      level: this.level,
      experience: this.experience,
      unspentSkillPoints: this.unspentSkillPoints,
      skills: this.skills,
      connected: this.connected,
      casts: this.visibleCasts(),
      requestedAbilityId: this.requestedAbilityId,
      cooldowns: this.visibleCooldowns(),
      selfRoot: this.selfRoot(),
      awaitingCast: this.outstandingCasts.length > 0,
      resource: this.modelledResource(),
    };
  }

  private mapView(): ClientMapView | null {
    const cache = this.mapCache;
    if (!cache) return null;
    return { info: cache.info, chunks: cache.held(), revision: cache.revision };
  }

  /**
   * Ask for the chunks under and around the player that are not held yet.
   *
   * Driven from the delta rather than from a timer: a delta is when this client
   * learns where it actually is, and asking on any other schedule would be
   * asking about a position the server has not confirmed. The per-pass budget
   * keeps a cold start from firing eighty requests into one frame, and it is
   * sized under the server's burst so the throttle is never what shapes the
   * stream in normal play.
   */
  private requestChunks(): void {
    const cache = this.mapCache;
    const at = this.prediction?.drawn ?? this.selfAuthoritative();
    if (!cache || !at || this.chunkBackoffTicks > 0) return;
    for (const req of cache.wanted(at.x, at.y, MAP_CHUNK_REQUEST_RADIUS, CHUNK_REQUESTS_PER_PASS)) {
      cache.markRequested(req);
      this.channel.send(
        encodeClientMessage({
          type: ClientMessageType.RequestChunk,
          layer: req.layer,
          cx: req.cx,
          cz: req.cz,
        }),
      );
    }
  }

  /** The server's own position for this client, before any prediction. */
  private selfAuthoritative(): { x: number; y: number } | null {
    const id = this.welcome?.entityId ?? -1;
    if (id < 0) return null;
    const entity = this.world.all().find((e) => e.id === id);
    return entity ? { x: entity.x, y: entity.y } : null;
  }

  /**
   * Every cast worth drawing: the server's, plus this client's own predicted one
   * when the server has not confirmed a cast for us yet (spec 069).
   *
   * The predicted cast is put on the view as an ordinary cast, indistinguishable
   * from a real one, so the renderer needs no notion of prediction at all -- it
   * draws `view.casts` and always did. A confirmed cast for the local entity
   * wins outright: the server's ticks are the true ones even when they disagree
   * with the guess.
   */
  private visibleCasts(): readonly KnownCast[] {
    const casts = [...this.casts.values()];
    const selfId = this.welcome?.entityId ?? -1;
    if (this.predictedCast && !this.casts.has(selfId) && selfId >= 0) {
      casts.push({
        entityId: selfId,
        abilityId: this.predictedCast.abilityId,
        phase: this.predictedCast.phase,
        startTick: this.predictedCast.windupStartTick,
        releaseTick: this.predictedCast.releaseTick,
        endTick: this.predictedCast.endTick,
        targetX: this.predictedCast.targetX,
        targetY: this.predictedCast.targetY,
        targetEntityId: this.predictedCast.targetEntityId,
      });
    }
    return casts;
  }

  /**
   * The server's cooldown table, raised by what this client has spent and not
   * been told about, so the sweep starts on the press rather than a round trip
   * later (spec 069). The overlay can only ever push a cooldown *later*: it may
   * grey a button out early, never light one up early.
   */
  private visibleCooldowns(): Readonly<Record<string, number>> {
    if (this.predictedCooldowns.size === 0) return this.cooldowns;
    const merged: Record<string, number> = { ...this.cooldowns };
    for (const [abilityId, guess] of this.predictedCooldowns) {
      if (this.estimated < guess.fromTick) continue;
      merged[abilityId] = Math.max(merged[abilityId] ?? 0, guess.readyAtTick);
    }
    return merged;
  }

  /**
   * The aim to hold while rooted: the confirmed cast's if the server has spoken,
   * the predicted one's until then, and null when free to walk.
   *
   * Since spec 069 this is the *cast* rather than the request behind it, which
   * is what lets it end on time: a cast knows its `endTick`, so the legs come
   * back the tick the blow finishes instead of a round trip after it.
   */
  private selfRoot(): { readonly x: number; readonly y: number } | null {
    const cast = this.selfCast();
    return cast ? { x: cast.targetX, y: cast.targetY } : null;
  }

  /** How many times the server has had to correct us. Diagnostics, not a rule. */
  get correctionCount(): number {
    return this.prediction?.correctionCount ?? 0;
  }

  disconnect(): void {
    this.channel.close();
    this.connected = false;
  }

  private receive(bytes: Uint8Array): void {
    const message = decodeServerMessage(bytes);
    switch (message.type) {
      case ServerMessageType.Welcome: {
        this.welcome = {
          playerId: message.playerId,
          entityId: message.entityId,
          tickRate: message.tickRate,
          chunkSize: message.chunkSize,
          interestRadius: message.interestRadius,
          correctionThreshold: message.correctionThreshold,
          worldSeed: message.worldSeed,
        };
        this.estimated = message.tick;
        this.connected = true;
        // Measure at once: everything timed on this client -- a cast bar, a
        // cooldown sweep, whether a root is worth predicting -- reads the clock
        // this sets, and the first half-second is when a player is most likely
        // to press something.
        this.ping();
        this.resolveWelcome?.(this.welcome);
        this.resolveWelcome = null;
        this.rejectWelcome = null;
        break;
      }

      case ServerMessageType.MapInfo:
        // A fresh cache rather than a merge: `mapId` changing means the world
        // changed under this session, and chunks from the old one describe
        // ground that is no longer there.
        this.mapCache = new MapChunkCache(message);
        this.requestChunks();
        break;

      case ServerMessageType.MapChunk:
        // Each arrival frees a slot, so ask again straight away. This is what
        // actually paces a cold start: the window fills as fast as the link
        // carries it, and the pipeline stops on its own once `wanted` is empty.
        if (this.mapCache?.accept(message) === true) this.requestChunks();
        break;

      case ServerMessageType.SpawnerStates:
        this.spawners = message.spawners;
        break;

      case ServerMessageType.ChunkDenied:
        this.mapCache?.deny(message.layer, message.cx, message.cz, message.reason);
        // A throttled chunk goes straight back on the wanted list, so without a
        // pause the next pump re-asks it and is refused again -- twenty rounds
        // of that a second, achieving nothing. Backing off is also the polite
        // reading of the message: the server said "not now", not "not ever".
        if (message.reason === ChunkDeniedReason.Throttled) {
          this.chunkBackoffTicks = CHUNK_THROTTLE_BACKOFF_TICKS;
        }
        break;

      case ServerMessageType.Inventory:
        this.serverInventory = message.inventory;
        this.serverEquipment = message.equipment;
        this.coins = message.coins;
        // Everything up to and including the answered request has been settled,
        // whether it was taken or refused -- the containers that arrived are the
        // truth about both. What is left is what is still in flight.
        while ((this.pendingMoves[0]?.requestId ?? Infinity) <= message.requestId) {
          this.pendingMoves.shift();
        }
        this.replayMoves();
        break;

      case ServerMessageType.TradeState:
        // Replaced whole, and a `tradeId` of 0 means "you are not in one" --
        // which is how a window is closed. A client never decides for itself
        // that a trade has ended, exactly as it never decides a shop has shut.
        this.tradeView =
          message.tradeId === 0
            ? null
            : {
                id: message.tradeId,
                stage: message.stage,
                revision: message.revision,
                you: message.you,
                them: message.them,
                reason: message.reason,
              };
        // A finished trade is told once and then forgotten, so what is left is
        // the inventory the server has already sent alongside it.
        if (message.stage === TradeStageValue.Done || message.stage === TradeStageValue.Cancelled) {
          this.lastTrade = this.tradeView;
          this.tradeView = null;
        }
        break;

      case ServerMessageType.VendorState:
        this.vendorReplies += 1;
        this.vendorView =
          message.vendorId === ''
            ? null
            : {
                id: message.vendorId,
                name: message.name,
                stock: message.stock,
                buyback: message.buyback,
              };
        break;

      case ServerMessageType.Stats:
        this.stats = message.stats;
        this.level = message.level;
        this.experience = message.experience;
        this.unspentSkillPoints = message.unspentSkillPoints;
        this.skills = message.skills;
        break;

      case ServerMessageType.Delta: {
        // Never backwards: the estimate may legitimately be a tick or two ahead
        // of the delta describing an older frame, and yanking a cast bar
        // backwards is worse than letting it run slightly fast. The delta itself
        // is one-way-latency old, so the clock it re-syncs to is its tick plus
        // that -- otherwise every client is behind by its own ping.
        this.estimated = Math.max(this.estimated, message.tick + this.oneWayTicks());
        this.world.apply(message.tick, message.removed, message.upserts);
        for (const id of message.removed) this.casts.delete(id);
        this.lastAckedSeq = Math.max(this.lastAckedSeq, message.ackInputSeq);
        if (message.ackInputSeq > 0) {
          this.queueDepths.push(Math.max(0, this.seq - message.ackInputSeq));
          if (this.queueDepths.length > ROUND_TRIP_SAMPLES) this.queueDepths.shift();
        }
        this.prediction?.acknowledge(message.ackInputSeq);
        this.startPredictingIfReady();
        this.requestChunks();
        break;
      }

      case ServerMessageType.Correction:
        // Drift is eased, everything else snaps. The state adopted is the same
        // either way -- the difference is whether the player watches it happen
        // or is moved (spec 067).
        this.prediction?.reconcile(message.inputSeq, message.position, {
          eased: message.reason === CorrectionReason.Drift,
        });
        break;

      case ServerMessageType.CombatResult:
        for (const listener of this.combatListeners) listener(message);
        break;

      case ServerMessageType.Chat:
        for (const listener of this.chatListeners) listener(message);
        break;

      case ServerMessageType.Error:
        for (const listener of this.errorListeners) listener(message.code, message.message);
        this.rejectWelcome?.(new Error(`server refused connection: ${message.message}`));
        this.rejectWelcome = null;
        this.resolveWelcome = null;
        break;

      case ServerMessageType.Disconnect:
        this.connected = false;
        break;

      case ServerMessageType.CastState:
        this.casts.set(message.entityId, {
          entityId: message.entityId,
          abilityId: message.abilityId,
          phase: message.phase,
          startTick: message.startTick,
          releaseTick: message.releaseTick,
          endTick: message.endTick,
          targetX: message.targetX,
          targetY: message.targetY,
          targetEntityId: message.targetEntityId,
        });
        if (message.entityId === this.welcome?.entityId) {
          this.requestedAbilityId = null;
          // The real thing has arrived, and it answers the oldest request. The
          // confirmed cast roots us from here; the guess has done its job, and
          // is dropped so that nothing is drawn from it -- `visibleCasts` would
          // prefer the confirmed one anyway, but a guess left running would
          // outlive it and re-root us the moment the real cast ended.
          this.answerOldestCast();
          this.predictedCast = null;
          this.predictedCastRequestId = -1;
        }
        for (const listener of this.castListeners) listener(message);
        break;

      case ServerMessageType.CastEnded:
        this.casts.delete(message.entityId);
        // Deliberately does not retire a request: a cast ending is not an answer
        // to anything, and a request made *during* it is still waiting for one.
        if (message.entityId === this.welcome?.entityId) {
          this.requestedAbilityId = null;
          // A blow that did not go off never stamps a cooldown (spec 091), so
          // the guess made at the press has nothing to be retired by. This is
          // the half `withdrawLocally` cannot cover: an interrupt is the
          // server's decision, and the first this client hears of it is here.
          if (message.reason !== CastEndReasonValue.Released) {
            this.predictedCooldowns.delete(message.abilityId);
          }
        }
        for (const listener of this.castEndListeners) listener(message);
        break;

      case ServerMessageType.Effect:
        for (const listener of this.effectListeners) listener(message);
        break;

      case ServerMessageType.CastRejected:
        this.requestedAbilityId = null;
        // Refused, so this request roots us no longer -- but only *this* one --
        // and it spent nothing, so the cooldown it guessed goes back too.
        {
          const refused = this.answerOldestCast();
          if (
            refused?.stampedCooldown !== null &&
            refused !== null &&
            this.predictedCooldowns.get(refused.abilityId)?.readyAtTick === refused.stampedCooldown
          ) {
            this.predictedCooldowns.delete(refused.abilityId);
          }
          // The bar goes with it, but only if it was *this* request's bar. A
          // refusal is a round trip old, so a stale one must not tear down a
          // commit the player has since made and is watching.
          if (refused && refused.id === this.predictedCastRequestId) {
            this.predictedCast = null;
            this.predictedCastRequestId = -1;
          }
        }
        for (const listener of this.castRejectedListeners) {
          listener(message.abilityId, message.reason);
        }
        break;

      case ServerMessageType.Cooldowns:
        this.cooldowns = Object.fromEntries(
          message.entries.map((entry) => [entry.abilityId, entry.readyAtTick]),
        );
        // The pool, and the tick it was true on (spec 069). Carried forward
        // locally from here by the sim's own regen curve, so this message is
        // needed only when that model would be wrong -- which is when something
        // was spent.
        this.serverResource = message.resource;
        this.serverResourceTick = message.atTick;
        // A guess is retired only once the server's own number has caught up
        // with it. Dropping it on any cooldown message at all was worse than
        // not guessing: the message that arrives while a request is in flight
        // is the state from *before* it, so the guess was wiped by the very
        // staleness it exists to cover, and the next press predicted a root the
        // server was always going to refuse.
        for (const entry of message.entries) {
          const predicted = this.predictedCooldowns.get(entry.abilityId);
          if (predicted !== undefined && entry.readyAtTick >= predicted.readyAtTick) {
            this.predictedCooldowns.delete(entry.abilityId);
          }
        }
        break;

      case ServerMessageType.Pong: {
        const sentAt = this.pingsInFlight.get(message.nonce);
        if (sentAt === undefined) break;
        this.pingsInFlight.delete(message.nonce);
        this.roundTrips.push(Math.max(0, this.localTick - sentAt));
        if (this.roundTrips.length > ROUND_TRIP_SAMPLES) this.roundTrips.shift();
        // The pong says which tick the server was on when it answered, so this
        // is a direct reading of the clock rather than an extrapolation.
        this.estimated = Math.max(this.estimated, message.serverTick + this.oneWayTicks());
        break;
      }
    }
  }

  /**
   * Starts prediction once we know both where the server put us and how fast it
   * thinks we walk. Both arrive asynchronously and in no guaranteed order, so
   * this is checked on every delta rather than assumed at any one message.
   */
  private startPredictingIfReady(): void {
    if (this.prediction || !this.welcome || !this.stats) return;
    const self = this.world.get(this.welcome.entityId);
    if (!self) return;
    // Seed the local facing from the first authoritative one, so the very first
    // press is judged against where the body actually is rather than east.
    if (!this.facingSeeded) {
      this.facing = self.facing;
      this.wantedFacing = self.facing;
      this.facingSeeded = true;
    }
    const build = this.options.predictor ?? ((stats, rate) => createFlatPredictor(stats.moveSpeed, rate));
    this.prediction = new PredictionBuffer(
      { x: self.x, y: self.y },
      build(this.stats, this.welcome.tickRate),
    );
  }
}
