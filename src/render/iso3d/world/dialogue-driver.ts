/**
 * What holds a conversation together in the Play tab (spec 244).
 *
 * The impure half of the dialogue: `dialogue.ts` is the conversation and knows
 * nothing about anything, and this is the four things it has to be joined to --
 * the server's authoritative answer about who is talking, the audio context, the
 * bubble, and the camera. It exists as a module rather than as forty lines in
 * `view.ts` for the reason `audio-driver.ts` and `shot-vfx.ts` do: it holds
 * state across frames and owes a cleanup, and both of those are easier to get
 * wrong inline than to read.
 *
 * The rule it is built around is that **the server decides whether a
 * conversation exists.** `ClientView.conversationEntityId` is the whole trigger:
 * a session starts when it becomes non-zero and ends when it becomes zero, so
 * every way a conversation can end -- the player walked away, the merchant died,
 * the socket dropped, somebody else got there first -- arrives here as the same
 * event and needs no case of its own. The client never opens a bubble on the
 * press, because the answer decides whether the body stops walking and a bubble
 * over something still ambling away is worse than a moment's wait.
 *
 * The audio sink is built to the three rules `affliction-vfx.ts` and
 * `shot-vfx.ts` learned, because the failure modes are the same: **the stop is
 * owed** (nothing in the synth stops itself, so a conversation that ends
 * mid-word has to be silenced from the one place that knows it ended), the
 * output is **re-asked every time** rather than cached (the context does not
 * exist until the first user gesture, and a null cached at mount would be a
 * merchant that never speaks for the session), and a refusal is *not* an error
 * -- no Web Audio means the text still reveals.
 */

import { npcById } from '../../../server/data/npcs.js';
import type { DialogueVoiceId } from '../../../server/data/dialogue.js';
import { SpeechVoices } from '../../audio/dialogue-sound.js';
import type { SpeakEvent } from '../../audio/dialogue-voice.js';
import type { Audio, SpeechOutput } from '../../audio/sink.js';
import { DialogueSession, type DialogueOutcome, type DialogueSpeech } from './dialogue.js';

/** Which bus a mumble plays on. See `sink.ts` for why it is not one of its own. */
const SPEECH_BUS = 'ui' as const;

/** The replicated facts the driver needs about a body. */
export interface DialogueBody {
  readonly id: number;
  readonly typeId: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The Web Audio side of a conversation.
 *
 * Separate from the driver so the driver can be handed a recorder, which is what
 * `dialogue-driver.test.ts` does -- and so the one place that owes a `stop` is a
 * class with a `stop` on it rather than a closure somebody has to remember to
 * call.
 */
export class SpeechSink implements DialogueSpeech {
  private readonly voices = new SpeechVoices();

  constructor(private readonly audio: Audio) {}

  speak(voice: DialogueVoiceId, event: SpeakEvent, index: number): void {
    const out = this.output();
    // Dropped rather than queued: a mumble is a request for a sound *now*, and
    // one that arrived after the letter that wanted it would be worse than
    // silence. The same rule `engine.ts` applies to a cache miss.
    if (out === null) return;
    this.voices.speak(out, voice, event, index);
  }

  stop(): void {
    this.voices.stopAll(this.output());
  }

  /**
   * Re-asked every call rather than cached at construction.
   *
   * A browser refuses to let a page make noise before an interaction, so at
   * mount there is no context and `speech` answers null -- and a null cached
   * there would be an NPC that is silent for the rest of the session however
   * many times the player clicks.
   */
  private output(): SpeechOutput | null {
    return this.audio.speech(SPEECH_BUS);
  }
}

export interface DialogueDriverOptions {
  /** Where vocal events go. Injected so the driver runs against a recorder. */
  readonly speech: DialogueSpeech;
  /** Open this vendor's shop. The dialogue names it; the mount opens it. */
  readonly onShop: (vendorId: string) => void;
  /** Tell the server the conversation is over. */
  readonly onLeave: () => void;
}

/**
 * One conversation at a time, driven from the replicated answer.
 *
 * Pure of three.js and of the DOM: it is handed the bodies and answers what to
 * draw, so the whole of it runs in Node.
 */
export class DialogueDriver {
  private session: DialogueSession | null = null;

  constructor(private readonly options: DialogueDriverOptions) {}

  /** The body being talked to, or 0. What the camera frames and the bubble points at. */
  get speakerId(): number {
    return this.session?.entityId ?? 0;
  }

  get active(): boolean {
    return this.session !== null;
  }

  /**
   * Reconcile against the server's answer, then reveal up to `nowMs`.
   *
   * `bodies` is looked at only to find the speaker, and a speaker that has left
   * the replicated set ends the conversation -- which is belt and braces beside
   * the server's own release, and the one that closes the gap where a body
   * streams out of interest range while its `Conversation` message is still in
   * flight.
   */
  update(conversationEntityId: number, bodies: readonly DialogueBody[], nowMs: number): void {
    if (conversationEntityId === 0) {
      this.end();
      return;
    }
    const body = bodies.find((each) => each.id === conversationEntityId);
    if (body === undefined) {
      this.end();
      return;
    }
    if (this.session !== null && this.session.entityId !== conversationEntityId) {
      // Talking to a second body without the first having ended. The server
      // releases the old claim itself, so this is only the client catching up --
      // but starting a session without ending the old one would leave the old
      // one's voice sounding under the new one's first word.
      this.end();
    }
    if (this.session === null) {
      const npc = npcById(body.typeId);
      // A body the server says we are talking to and this build has no row for.
      // Nothing to say, so nothing is shown -- and the server is told, or the
      // merchant stands still forever in front of a client drawing no bubble.
      if (npc === null) {
        this.options.onLeave();
        return;
      }
      this.session = new DialogueSession(npc, body.id, this.options.speech, nowMs);
    }
    this.session.update(nowMs);
    // A line that ran itself out and closed -- the last reply led nowhere.
    if (this.session.closed) this.end();
  }

  /** What the bubble shows, or null. */
  view(): { speaker: string; text: string; typing: boolean; choices: readonly string[] } | null {
    if (this.session === null) return null;
    return this.session.view;
  }

  /** The confirm press, or a click on the bubble: skip, or move on. */
  advance(nowMs: number): void {
    this.act(this.session?.advance(nowMs));
  }

  /** A reply was pressed. */
  choose(index: number, nowMs: number): void {
    this.act(this.session?.choose(index, nowMs));
  }

  /**
   * End it from this side: Escape, a stop, the tab going away.
   *
   * Tells the server as well as dropping the session, which is what makes the
   * merchant start wandering again. Idempotent, because more than one thing can
   * ask -- Escape and the click that closed the shop, on the same frame.
   */
  leave(): void {
    if (this.session === null) return;
    this.end();
    this.options.onLeave();
  }

  /**
   * Drop the session and silence it, without telling the server.
   *
   * The half that runs when the server is the one that ended it. Always goes
   * through `DialogueSession.end`, which is where the `speech.stop()` is, so
   * there is no path that forgets the sound.
   */
  private end(): void {
    if (this.session === null) return;
    this.session.end();
    this.session = null;
  }

  private act(outcome: DialogueOutcome | undefined): void {
    if (outcome === undefined) return;
    if (outcome.kind === 'shop') {
      this.options.onShop(outcome.vendorId);
      // A shop reply may also have ended the line, so the closed check below
      // still has to run -- which is why this is not an early return.
    }
    if (this.session?.closed ?? false) this.leave();
  }
}
