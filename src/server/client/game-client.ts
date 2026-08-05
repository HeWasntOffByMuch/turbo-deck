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
import { ClientMessageType, ServerMessageType } from '../net/protocol.js';
import { PROTOCOL_VERSION } from '../config.js';
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
   * re-synced to every delta, never backwards.
   */
  readonly estimatedTick: number;
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
   * Asks to commit to an ability. Deliberately not predicted: the local state
   * is "requested", and only the server's CastState makes it real. Predicting
   * damage is a much larger commitment than predicting a walk, and guessing
   * wrong about a hit is far more visible than guessing wrong about a step.
   */
  useAbility(abilityId: string, targetX = 0, targetY = 0): void {
    if (!this.connected) return;
    this.requestedAbilityId = abilityId;
    this.channel.send(
      encodeClientMessage({ type: ClientMessageType.UseAbility, abilityId, targetX, targetY }),
    );
  }

  cancelCast(): void {
    if (!this.connected) return;
    this.channel.send(encodeClientMessage({ type: ClientMessageType.CancelCast }));
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
  }

  view(): ClientView {
    return {
      tick: this.world.tick,
      estimatedTick: this.estimated,
      entities: this.world.all(),
      self: this.prediction?.position ?? null,
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
    };
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
        // backwards is worse than letting it run slightly fast.
        this.estimated = Math.max(this.estimated, message.tick);
        this.world.apply(message.tick, message.removed, message.upserts);
        for (const id of message.removed) this.casts.delete(id);
        this.prediction?.acknowledge(message.ackInputSeq);
        this.startPredictingIfReady();
        break;
      }

      case ServerMessageType.Correction:
        this.prediction?.reconcile(message.inputSeq, message.position);
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
        if (message.entityId === this.welcome?.entityId) this.requestedAbilityId = null;
        for (const listener of this.castListeners) listener(message);
        break;

      case ServerMessageType.CastEnded:
        this.casts.delete(message.entityId);
        if (message.entityId === this.welcome?.entityId) this.requestedAbilityId = null;
        for (const listener of this.castEndListeners) listener(message);
        break;

      case ServerMessageType.Effect:
        for (const listener of this.effectListeners) listener(message);
        break;

      case ServerMessageType.CastRejected:
        this.requestedAbilityId = null;
        for (const listener of this.castRejectedListeners) {
          listener(message.abilityId, message.reason);
        }
        break;

      case ServerMessageType.Cooldowns:
        this.cooldowns = Object.fromEntries(
          message.entries.map((entry) => [entry.abilityId, entry.readyAtTick]),
        );
        break;

      case ServerMessageType.Pong:
        break;
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
