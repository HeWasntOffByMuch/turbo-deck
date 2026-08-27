/**
 * A conversation in progress (spec 244).
 *
 * The controller the handoff spec recommends: *"the actual implementation may
 * instead let one central dialogue controller own both text reveal and sound
 * triggering. That is often cleaner."* It is also the only arrangement the
 * fences here allow -- `src/ui/` may not import `render/audio/`, so a bubble
 * cannot be the thing scheduling sounds, and a sound layer that owned the
 * reveal would be deciding what a screen displays.
 *
 * Pure. **Time is an argument** (`update(nowMs)`), the rule every other pure
 * module in this directory lives by, and it is what makes the acceptance
 * criteria assertable: that punctuation lengthens a pause, that skipping emits
 * no backlog, that closing mid-word speaks nothing further, are all statements
 * about a function of `nowMs` rather than about something that has to be
 * listened to. The sound sink is injected for the same reason -- driven against
 * a recorder, the whole feature runs in Node with no `AudioContext` anywhere.
 *
 * ## Cancellation
 *
 * The handoff spec asks for a monotonically increasing playback token, and
 * there is one ({@link DialogueSession.generation}), but it is not what makes
 * cancellation correct here. **Nothing is ever scheduled ahead**: a voice starts
 * at the instant the reveal reaches its character, so at any moment there are no
 * pending sounds to cancel and skipping a line cannot produce a burst. That is
 * a property of the loop rather than a check inside it. The token exists for the
 * thing that genuinely is asynchronous -- a sound already *started* -- and for a
 * caller that wants to know the line changed under it.
 */

import type { SpeakEvent, LinePlan } from '../../audio/dialogue-voice.js';
import { planLine } from '../../audio/dialogue-voice.js';
import { lineOf, type DialogueVoiceId, type DialogueLine } from '../../../server/data/dialogue.js';
import type { NpcDefinition } from '../../../server/data/npcs.js';

/**
 * Where a vocal event goes.
 *
 * An interface rather than a callback because there are two operations and the
 * second is the one that is easy to forget: **a sink that can start a sound
 * owes a way to stop one.** See `render/audio/dialogue-sound.ts` for the live
 * implementation and `dialogue.test.ts` for the recorder.
 */
export interface DialogueSpeech {
  speak(voice: DialogueVoiceId, event: SpeakEvent, index: number): void;
  /** Silence anything still sounding. Called on every line change and on close. */
  stop(): void;
}

/** What the bubble draws. Plain rows: `src/ui/` never sees anything else. */
export interface DialogueView {
  readonly speaker: string;
  /** Revealed so far. The bubble shows exactly this. */
  readonly text: string;
  /** Still revealing, so a confirm skips rather than advances. */
  readonly typing: boolean;
  /**
   * The replies, or empty.
   *
   * Empty while typing, which is the whole of "choices should only become
   * interactive when it makes sense for the current line": a reply that could be
   * clicked before its question had finished being asked is a reply to something
   * the player has not read.
   */
  readonly choices: readonly string[];
}

/** What a press amounted to. The caller acts on it; this module never does. */
export type DialogueOutcome =
  /** Nothing happened, and nothing should. A press on a line awaiting a choice. */
  | { readonly kind: 'none' }
  /** The line was skipped to its end. The bubble stays open. */
  | { readonly kind: 'revealed' }
  /** The conversation is over. The caller tells the server and puts the camera back. */
  | { readonly kind: 'closed' }
  /** Open this vendor's shop, and keep talking. */
  | { readonly kind: 'shop'; readonly vendorId: string };

const NONE: DialogueOutcome = { kind: 'none' };
const CLOSED: DialogueOutcome = { kind: 'closed' };

export class DialogueSession {
  private line: DialogueLine | null = null;
  private plan: LinePlan | null = null;
  /** Steps emitted so far. The reveal cursor and the audio cursor are the same one. */
  private cursor = 0;
  private startedAtMs = 0;
  private ended = false;
  private token = 0;

  /**
   * @param npc     what is being talked to: its name, its voice, its script.
   * @param entityId the body, so the caller can check it is still there.
   * @param speech  where vocal events go.
   * @param nowMs   the clock the first line starts against.
   */
  constructor(
    readonly npc: NpcDefinition,
    readonly entityId: number,
    private readonly speech: DialogueSpeech,
    nowMs: number,
  ) {
    this.start(npc.dialogue.start, nowMs);
  }

  /**
   * Bumped whenever the line changes or the conversation ends.
   *
   * The handoff spec's playback token. Read by anything holding a reference to
   * a line's playback across a frame, so it can tell "still the line I was
   * given" from "a line that happens to be at the same index".
   */
  get generation(): number {
    return this.token;
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Still revealing characters. */
  get typing(): boolean {
    return this.plan !== null && this.cursor < this.plan.steps.length;
  }

  get view(): DialogueView {
    const plan = this.plan;
    if (this.ended || plan === null || this.line === null) {
      return { speaker: this.npc.name, text: '', typing: false, choices: [] };
    }
    const typing = this.typing;
    return {
      speaker: this.npc.name,
      text: plan.text.slice(0, this.cursor),
      typing,
      choices: typing ? [] : this.line.choices.map((choice) => choice.text),
    };
  }

  /**
   * Reveal up to `nowMs`, speaking whatever the letters ask for.
   *
   * A `while` rather than an `if`, because a frame is many milliseconds and can
   * cross several characters -- the same reason `affliction-vfx.ts` counts
   * pulses that have landed rather than asking whether this tick is one. What it
   * deliberately does **not** do is collapse them: each character revealed in a
   * long frame still gets its own vocal event, because the cap and the density
   * rule are what bound the sound, not the frame rate.
   */
  update(nowMs: number): void {
    const plan = this.plan;
    if (this.ended || plan === null) return;
    const elapsed = nowMs - this.startedAtMs;
    while (this.cursor < plan.steps.length) {
      const step = plan.steps[this.cursor];
      if (step === undefined || step.atMs > elapsed) break;
      if (step.speak) this.speech.speak(this.npc.voice.voice, step.speak, step.index);
      this.cursor += 1;
    }
  }

  /**
   * The confirm press. Two-stage, as the handoff spec recommends.
   *
   * While typing it reveals the rest of the line and stops there -- the bubble
   * stays open, and the characters it skipped past **do not speak**, because the
   * cursor moves without going through {@link update}. Once the line is whole it
   * either ends the conversation, if the line has no replies, or does nothing,
   * because a line with replies is waiting for one and advancing past it would
   * be choosing on the player's behalf.
   */
  advance(nowMs: number): DialogueOutcome {
    if (this.ended || this.plan === null || this.line === null) return CLOSED;
    if (this.typing) {
      this.skip();
      return { kind: 'revealed' };
    }
    if (this.line.choices.length === 0) return this.end();
    void nowMs;
    return NONE;
  }

  /**
   * Take the reply at `index`.
   *
   * Refused while typing, and that is the same rule the empty `choices` in the
   * view states -- said twice on purpose, because the view is what a screen
   * *draws* and this is what it may *do*, and a caller that kept its own copy of
   * the choices for a frame would otherwise be able to act on a stale one.
   */
  choose(index: number, nowMs: number): DialogueOutcome {
    if (this.ended || this.line === null || this.typing) return NONE;
    const choice = this.line.choices[index];
    if (choice === undefined) return NONE;

    // Read before the line moves: `start` replaces `this.line`, and the vendor
    // this reply opens is a property of the reply rather than of where it goes.
    const opens = choice.opens;
    if (choice.go === null) {
      const outcome = this.end();
      return opens === 'shop' && this.npc.vendorId !== null
        ? { kind: 'shop', vendorId: this.npc.vendorId }
        : outcome;
    }
    this.start(choice.go, nowMs);
    if (opens === 'shop' && this.npc.vendorId !== null) {
      return { kind: 'shop', vendorId: this.npc.vendorId };
    }
    return NONE;
  }

  /**
   * End it, from outside: the player walked away, the body died, the tab closed.
   *
   * Idempotent, because every one of those can happen twice -- a despawn and a
   * range check on the same frame, a close from the screen and one from the
   * server's own release.
   */
  end(): DialogueOutcome {
    if (this.ended) return CLOSED;
    this.ended = true;
    this.line = null;
    this.plan = null;
    this.token += 1;
    // The one thing that must happen on every exit, which is why it is here
    // rather than at each of the callers that can cause one.
    this.speech.stop();
    return CLOSED;
  }

  /** Whole line visible, nothing spoken for what was skipped. */
  private skip(): void {
    if (this.plan === null) return;
    this.cursor = this.plan.steps.length;
  }

  private start(lineId: string, nowMs: number): void {
    const line = lineOf(this.npc.dialogue, lineId);
    if (line === null) {
      // A `go` naming nothing. `scriptProblems` catches this in a test; if one
      // ever reaches a player, ending is the honest failure -- better a
      // conversation that stops than a bubble with nothing in it and no way out.
      this.end();
      return;
    }
    // Before the new line's first character, so two lines never overlap in the
    // ear even when the second begins mid-syllable of the first.
    this.speech.stop();
    this.line = line;
    this.plan = planLine(line.text, this.npc.voice, `${this.npc.id}:${line.id}`);
    this.cursor = 0;
    this.startedAtMs = nowMs;
    this.token += 1;
  }
}
