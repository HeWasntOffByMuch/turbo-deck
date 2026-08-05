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
  type CombatResultMessage,
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
  readonly tick: number;
  readonly entities: readonly import('./replica.js').ReplicatedEntity[];
  /** The local player's predicted position -- what to draw them at. */
  readonly self: { readonly x: number; readonly y: number } | null;
  readonly selfEntityId: number;
  readonly stats: EffectiveStats | null;
  readonly level: number;
  readonly experience: number;
  readonly unspentSkillPoints: number;
  readonly connected: boolean;
}

type CombatListener = (result: CombatResultMessage) => void;
type ChatListener = (message: ServerChatMessage) => void;
type ErrorListener = (code: number, message: string) => void;

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

  view(): ClientView {
    return {
      tick: this.world.tick,
      entities: this.world.all(),
      self: this.prediction?.position ?? null,
      selfEntityId: this.welcome?.entityId ?? -1,
      stats: this.stats,
      level: this.level,
      experience: this.experience,
      unspentSkillPoints: this.unspentSkillPoints,
      connected: this.connected,
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
        };
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
        this.world.apply(message.tick, message.removed, message.upserts);
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
