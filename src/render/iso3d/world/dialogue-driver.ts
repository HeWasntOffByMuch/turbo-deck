/**
 * What holds a conversation together in the Play tab (spec 246).
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
import { SIGN_BUBBLE_LIFT, SIGN_READ_RADIUS, SILENT_SPEECH, signSpeaker, type SignMark } from './sign.js';

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
 * Where the conversation is, for the camera and the bubble (spec 259).
 *
 * Answered by the driver rather than looked up again by the mount, because
 * there are two kinds of speaker now and only this file knows which one is
 * live: an NPC is a body in the replicated set and a sign is a prop the server
 * has never heard of, and a mount that searched `view.entities` for either
 * would find one of them and silently draw nothing for the other.
 */
export interface DialogueFocus {
  /**
   * The body being spoken to, or **0** for a speaker that is not one.
   *
   * Kept as a separate field from {@link DialogueFocus.key} because the two
   * answer different questions: this is what the server has a claim on, and the
   * key is only ever compared against itself.
   */
  readonly entityId: number;
  /**
   * Identity, for a caller watching for the speaker to *change*.
   *
   * A string so a body and a sign can share one field without either having to
   * pretend to be the other -- `view.ts` turns the player to face whoever they
   * have just addressed, on the edge, and "addressed something else" is the
   * whole of what it needs to know.
   */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  /** How far above the ground the bubble's tail points, in world units. */
  readonly lift: number;
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
  /** How far above a *body's* feet its bubble points, in world units. */
  readonly bodyLift: number;
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
  /**
   * The sign being read, or null while the session is a body's (spec 259).
   *
   * Held beside the session rather than inferred from `session.entityId === 0`,
   * because those are two different claims: a sign has no entity id *and* the
   * server must not be told anything when one is put down. Reading the second
   * off the first would make a future speaker with no body silently send a
   * release for a conversation nobody is having.
   */
  private sign: SignMark | null = null;

  constructor(private readonly options: DialogueDriverOptions) {}

  /** The body being talked to, or 0. What the server has a claim on. */
  get speakerId(): number {
    return this.sign === null ? (this.session?.entityId ?? 0) : 0;
  }

  get active(): boolean {
    return this.session !== null;
  }

  /**
   * Where the live conversation is, or null.
   *
   * Recomputed from `bodies` on each call rather than stored, because a body
   * walks: a focus point remembered at the start of a line would leave the
   * camera framing where a merchant used to be. A sign does not walk, so its
   * half is the mark itself.
   */
  focus(bodies: readonly DialogueBody[]): DialogueFocus | null {
    if (this.session === null) return null;
    const sign = this.sign;
    if (sign !== null) {
      return { entityId: 0, key: `sign:${sign.key}`, x: sign.x, y: sign.y, lift: SIGN_BUBBLE_LIFT };
    }
    const id = this.session.entityId;
    const body = bodies.find((each) => each.id === id);
    if (body === undefined) return null;
    return { entityId: id, key: `body:${id}`, x: body.x, y: body.y, lift: this.options.bodyLift };
  }

  /**
   * Read a sign (spec 259).
   *
   * The one way a conversation starts without the server saying so, and it does
   * not contradict the rule above it: **the server decides whether a
   * conversation exists**, and a sign is not one -- there is no body to claim,
   * nothing to be refused and nobody else to be talking to it. What it borrows
   * is everything downstream of that decision.
   *
   * Whatever was live is ended first, and told to the server if it was a body's
   * -- walking off to read a sign mid-sentence is leaving the conversation, and
   * a merchant left holding a claim stands still forever.
   */
  readSign(mark: SignMark, nowMs: number): void {
    this.leave();
    this.sign = mark;
    // `SILENT_SPEECH` rather than the injected sink, and that is the whole of
    // "a sign makes no sound": the reveal, the skip, the bubble and the camera
    // are the NPC's exactly, and the voice is the one thing that is not.
    this.session = new DialogueSession(signSpeaker(mark), 0, SILENT_SPEECH, nowMs);
  }

  /**
   * Reconcile against the server's answer, then reveal up to `nowMs`.
   *
   * `bodies` is looked at only to find the speaker, and a speaker that has left
   * the replicated set ends the conversation -- which is belt and braces beside
   * the server's own release, and the one that closes the gap where a body
   * streams out of interest range while its `Conversation` message is still in
   * flight.
   *
   * `reader` is where the player is standing, and it is a **required**
   * parameter rather than an optional one even though a body conversation never
   * reads it: a sign has no server to release it, so this is the only thing
   * that does, and an argument a caller can leave out is one a caller will.
   */
  update(
    conversationEntityId: number,
    bodies: readonly DialogueBody[],
    nowMs: number,
    reader: { readonly x: number; readonly y: number },
  ): void {
    // A sign is read on this client's own say-so, so the server's answer is not
    // what keeps one open (spec 259). What it still is, is what *closes* one:
    // a conversation with a body outranks a board, so walking up to a merchant
    // while a sign is open puts the sign down rather than opening two bubbles.
    if (this.sign !== null) {
      if (conversationEntityId === 0) {
        // Released by range, the mirror of `sweepConversations` on the server:
        // an NPC's bubble goes when the player walks out of `talkRadius`, and a
        // sign's must too or it follows them across the map. **Reconciled every
        // frame rather than announced**, for that function's reason -- every
        // way a reader can stop reading is the same check rather than an event
        // some later path can forget to raise.
        //
        // The *same* radius that opened it, which is spec 246's rule stated in
        // as many words: "close enough to read" should be a single fact a
        // player can learn rather than two with a gap between them. It cannot
        // flicker, because nothing reopens a bubble on its own -- an order ends
        // when it opens one -- and the walk stops comfortably inside the reach
        // anyway, `approachOrderFor` measuring against it less the lead.
        if (Math.hypot(this.sign.x - reader.x, this.sign.y - reader.y) > SIGN_READ_RADIUS) {
          this.end();
          return;
        }
        this.session?.update(nowMs);
        if (this.session?.closed ?? false) this.end();
        return;
      }
      this.end();
    }
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
    // Read before `end` clears it: a sign is nothing the server was ever told
    // about, so telling it the conversation is over would release a claim
    // somebody *else* may be holding on a merchant across the square.
    const wasSign = this.sign !== null;
    this.end();
    if (!wasSign) this.options.onLeave();
  }

  /**
   * Drop the session and silence it, without telling the server.
   *
   * The half that runs when the server is the one that ended it. Always goes
   * through `DialogueSession.end`, which is where the `speech.stop()` is, so
   * there is no path that forgets the sound.
   */
  private end(): void {
    this.sign = null;
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
