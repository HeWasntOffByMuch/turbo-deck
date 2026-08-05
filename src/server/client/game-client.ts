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
import {
  decodeServerMessage,
  encodeClientMessage,
  type CastEndedMessage,
  type CastStateMessage,
  type CombatResultMessage,
  type EffectMessage,
  type ServerChatMessage,
} from '../net/messages.js';
import { ClientMessageType, CorrectionReason, ServerMessageType } from '../net/protocol.js';
import { PROTOCOL_VERSION } from '../config.js';
import { abilityById } from '../data/abilities.js';
import type { EffectiveStats } from '../state/types.js';
import { createFlatPredictor, PredictionBuffer, type PredictedInput, type PredictStep } from './prediction.js';
import { ReplicatedWorld } from './replica.js';

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
   * Local movement used for prediction. Defaults to the open-ground walk, which
   * matches the server exactly away from walls, water and cliffs. Stage 3 can
   * pass the server's own movement instead for a closer match.
   */
  readonly predictor?: (stats: EffectiveStats, tickRate: number) => PredictStep;
}

/** What the renderer reads. Read-only, and free of anything derived. */
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
  readonly entities: readonly import('./replica.js').ReplicatedEntity[];
  /** The local player's predicted position -- what to draw them at. */
  readonly self: { readonly x: number; readonly y: number } | null;
  readonly selfEntityId: number;
  /**
   * The world the server is running, or null before the welcome lands. A
   * renderer builds its terrain from this and from nothing else.
   */
  readonly worldSeed: number | null;
  readonly stats: EffectiveStats | null;
  readonly level: number;
  readonly experience: number;
  readonly unspentSkillPoints: number;
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
   * Ability id -> the tick it may next be used (spec 065). Straight from the
   * server; the client subtracts the tick it is drawing to get the sweep, and
   * never works out how long a cooldown is for itself.
   */
  readonly cooldowns: Readonly<Record<string, number>>;
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
  readonly abilityId: string;
  readonly aim: { readonly x: number; readonly y: number };
  /** The input this request was stamped after; the server commits on it. */
  readonly requestedAtSeq: number;
  /** Given up on past this tick, so a lost reply cannot root a player forever. */
  readonly expiresAtTick: number;
  /**
   * Whether this request roots us while we wait. False when our own copy of the
   * server's cooldowns says it will be refused -- the request still goes, and
   * still takes its turn in the queue, but the legs keep working.
   */
  readonly roots: boolean;
  /**
   * The cooldown this request wrote into {@link GameClient.predictedCooldowns},
   * or null if it wrote none. Carried so a refusal can take back its own guess
   * and only its own: every press here is the same ability, so "drop the guess
   * for melee.slash" would have a stale refusal cancel a live commit's cooldown.
   */
  readonly stampedCooldown: number | null;
}

/**
 * How long the client will hold a predicted root waiting for an answer. Two
 * seconds is far past any round trip worth playing on; past it the request is
 * assumed lost and the player gets their legs back.
 */
const PREDICTED_CAST_TIMEOUT_TICKS = 120;

/** How often the client measures the round trip. Twice a second is plenty. */
const PING_EVERY_TICKS = 30;

/** How many round-trip samples to keep. The minimum of these is the estimate. */
const ROUND_TRIP_SAMPLES = 8;

/** A cast the client knows about, as it is drawn. */
export interface KnownCast {
  readonly entityId: number;
  readonly abilityId: string;
  readonly phase: number;
  readonly releaseTick: number;
  readonly endTick: number;
  readonly targetX: number;
  readonly targetY: number;
}

export class GameClient {
  private readonly world = new ReplicatedWorld();
  private prediction: PredictionBuffer | null = null;
  private welcome: WelcomeInfo | null = null;
  private stats: EffectiveStats | null = null;
  private level = 1;
  private experience = 0;
  private unspentSkillPoints = 0;
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
   */
  private readonly predictedCooldowns = new Map<string, number>();
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
  useAbility(abilityId: string, targetX = 0, targetY = 0): void {
    if (!this.connected) return;
    this.requestedAbilityId = abilityId;
    // Both of the numbers below lean the same way, and deliberately.
    //
    // The two ways of being wrong do not cost the same. Predicting a root the
    // server refuses stands the player still until the refusal arrives -- a
    // stutter. Failing to predict one it accepts is a whole wind-up of walking
    // the server discarded: divergence, and a correction. So the horizon for
    // "will this be ready" is the *whole* round trip rather than the half it
    // strictly needs, and the cooldown a commit is expected to spend is stamped
    // from now rather than from when the server will see it. The first
    // over-predicts roots, the second under-holds them, and both err toward the
    // cheaper mistake.
    const roots = this.readyAt(abilityId) <= this.estimated + this.measuredRoundTrip();
    let stampedCooldown: number | null = null;
    if (roots) {
      stampedCooldown = this.estimated + (abilityById(abilityId)?.cooldownTicks ?? 0);
      this.predictedCooldowns.set(abilityId, stampedCooldown);
    }
    this.outstandingCasts.push({
      abilityId,
      aim: { x: targetX, y: targetY },
      requestedAtSeq: this.seq,
      expiresAtTick: this.estimated + PREDICTED_CAST_TIMEOUT_TICKS,
      roots,
      stampedCooldown,
    });
    this.channel.send(
      encodeClientMessage({
        type: ClientMessageType.UseAbility,
        abilityId,
        targetX,
        targetY,
        afterInputSeq: this.seq,
      }),
    );
  }

  cancelCast(): void {
    if (!this.connected) return;
    // Withdrawing frees the legs on the server, so the predicted roots go with
    // it -- keeping them would root a player who has just asked not to be. The
    // requests themselves stay outstanding: they will still be answered.
    for (let index = 0; index < this.outstandingCasts.length; index += 1) {
      const request = this.outstandingCasts[index];
      if (request) this.outstandingCasts[index] = { ...request, roots: false };
    }
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
   * When this ability is next usable, in estimated server ticks: the later of
   * what the server last said and what this client has spent since.
   */
  private readyAt(abilityId: string): number {
    return Math.max(this.cooldowns[abilityId] ?? 0, this.predictedCooldowns.get(abilityId) ?? 0);
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
    // One tick of easing off the last drift correction, and one tick closer to
    // giving up on an ability request nobody answered.
    this.prediction?.decay();
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
      entities: this.world.all(),
      self: this.prediction?.drawn ?? null,
      selfEntityId: this.welcome?.entityId ?? -1,
      worldSeed: this.welcome?.worldSeed ?? null,
      stats: this.stats,
      level: this.level,
      experience: this.experience,
      unspentSkillPoints: this.unspentSkillPoints,
      connected: this.connected,
      casts: [...this.casts.values()],
      requestedAbilityId: this.requestedAbilityId,
      cooldowns: this.cooldowns,
      selfRoot: this.selfRoot(),
    };
  }

  /**
   * The aim to hold while rooted: the confirmed cast's if the server has spoken,
   * the predicted one's until then, and null when free to walk.
   */
  private selfRoot(): { readonly x: number; readonly y: number } | null {
    const confirmed = this.welcome ? this.casts.get(this.welcome.entityId) : undefined;
    if (confirmed) return { x: confirmed.targetX, y: confirmed.targetY };
    // The most recent request that roots us: the last thing aimed at is the one
    // the body should be coming round to.
    for (let index = this.outstandingCasts.length - 1; index >= 0; index -= 1) {
      const request = this.outstandingCasts[index];
      if (request?.roots) return request.aim;
    }
    return null;
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

      case ServerMessageType.Stats:
        this.stats = message.stats;
        this.level = message.level;
        this.experience = message.experience;
        this.unspentSkillPoints = message.unspentSkillPoints;
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
        this.prediction?.acknowledge(message.ackInputSeq);
        this.startPredictingIfReady();
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
          releaseTick: message.releaseTick,
          endTick: message.endTick,
          targetX: message.targetX,
          targetY: message.targetY,
        });
        if (message.entityId === this.welcome?.entityId) {
          this.requestedAbilityId = null;
          // The real thing has arrived, and it answers the oldest request. The
          // confirmed cast roots us from here; the guess has done its job.
          this.answerOldestCast();
        }
        for (const listener of this.castListeners) listener(message);
        break;

      case ServerMessageType.CastEnded:
        this.casts.delete(message.entityId);
        // Deliberately does not retire a request: a cast ending is not an answer
        // to anything, and a request made *during* it is still waiting for one.
        if (message.entityId === this.welcome?.entityId) this.requestedAbilityId = null;
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
            this.predictedCooldowns.get(refused.abilityId) === refused.stampedCooldown
          ) {
            this.predictedCooldowns.delete(refused.abilityId);
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
        // A guess is retired only once the server's own number has caught up
        // with it. Dropping it on any cooldown message at all was worse than
        // not guessing: the message that arrives while a request is in flight
        // is the state from *before* it, so the guess was wiped by the very
        // staleness it exists to cover, and the next press predicted a root the
        // server was always going to refuse.
        for (const entry of message.entries) {
          const predicted = this.predictedCooldowns.get(entry.abilityId);
          if (predicted !== undefined && entry.readyAtTick >= predicted) {
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
    const build = this.options.predictor ?? ((stats, rate) => createFlatPredictor(stats.moveSpeed, rate));
    this.prediction = new PredictionBuffer(
      { x: self.x, y: self.y },
      build(this.stats, this.welcome.tickRate),
    );
  }
}
