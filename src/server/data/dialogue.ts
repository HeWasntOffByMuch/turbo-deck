/**
 * What a body says, and in what voice (spec 244).
 *
 * Content, so it is a table like ABILITIES and ITEMS and MONSTERS, and the same
 * contract holds: a conversation stores line **ids** and every word it shows is
 * read from here. Nothing about a script crosses the wire -- both ends have this
 * file, so replicating it would be sending a client a table it already has.
 *
 * This module is the *shape* and the tuning that is not synthesis. Which letter
 * makes a noise, at what pitch, through which filters is arithmetic and lives in
 * `src/render/audio/dialogue-voice.ts`; what lives here is the half a designer
 * writing an NPC touches -- the words, the replies, and the six knobs that turn
 * one synthesis engine into a different character.
 *
 * Deliberately **not** a graph type. There is no condition language, no flag
 * store, no "seen this before", and no visited set: a line names the lines its
 * replies go to, and that is the whole traversal. A second NPC is a second row
 * rather than a framework, which is the bet this spec is making -- when a third
 * one wants a condition, the condition is a field here and `dialogue.ts` grows
 * one branch.
 */

/**
 * The four engines from the handoff spec.
 *
 * A closed union rather than a string, so a typo in a character's row is a build
 * error -- the same rule `UiSoundId` and the audio event vocabulary already
 * carry, and for the same reason: an unrecognised voice is a silent NPC, and
 * silence is indistinguishable from "nobody has assigned one yet".
 */
export type DialogueVoiceId = 'soft' | 'chirpy' | 'warm' | 'nasal';

/**
 * One character's voice, as an engine plus what makes them *them*.
 *
 * Every field past `voice` is optional and multiplies the preset, so a row that
 * says only `{ voice: 'soft' }` is the preset exactly. That is the property the
 * handoff spec asks for -- "many characters share the same synthesis engine
 * while still sounding different" -- and it is why these are multipliers rather
 * than absolute values: an engine retuned in one place moves every character
 * built on it, instead of moving none of them.
 *
 * Six knobs, and the spec's own advice about the seventh: *"Do not expose dozens
 * of parameters initially. A small number of strong controls is better."*
 */
export interface DialogueVoice {
  readonly voice: DialogueVoiceId;
  /** Multiplies the reveal rate. Above 1 is faster, so pauses shorten too. */
  readonly speed?: number;
  /** Letters between sounds. Higher is sparser; the engines bias it. */
  readonly density?: number;
  /** Multiplies the engine's own level. */
  readonly volume?: number;
  /** Multiplies the engine's base pitch. This is most of a character's identity. */
  readonly pitchMultiplier?: number;
  /** Fraction of random pitch wobble per sound. Small: too much reads as unstable. */
  readonly pitchVariation?: number;
  /** How far pitch rises approaching a `?`. Replaces the engine's own. */
  readonly questionLift?: number;
}

/** A reply, and what pressing it does. */
export interface DialogueChoice {
  readonly text: string;
  /**
   * The line this reply leads to, or null to end the conversation.
   *
   * An id rather than a nested line, so two replies can arrive at one answer and
   * a script is a flat map rather than a tree that can only be read downward.
   */
  readonly go: string | null;
  /**
   * What this reply opens besides moving, or null.
   *
   * `'shop'` is the only member and that is the honest state of it: the shop is
   * the one window an NPC has to offer. A second member is a second window plus
   * one branch where this is read, which is what makes it worth being a union
   * rather than a boolean called `opensShop`.
   */
  readonly opens?: 'shop';
}

export interface DialogueLine {
  readonly id: string;
  readonly text: string;
  /**
   * The replies out of this line.
   *
   * **Empty is a terminal line**: it is read, it is advanced past, and the
   * conversation ends. That is what makes "one short response and then it ends
   * naturally" expressible without a flag saying so -- the absence of a reply
   * *is* the ending.
   */
  readonly choices: readonly DialogueChoice[];
}

export interface DialogueScript {
  /** Where a conversation starts. Must name a line in {@link DialogueScript.lines}. */
  readonly start: string;
  readonly lines: readonly DialogueLine[];
}

/** The line with this id, or null. */
export function lineOf(script: DialogueScript, id: string): DialogueLine | null {
  return script.lines.find((line) => line.id === id) ?? null;
}

/**
 * How long the reveal holds after a character, in milliseconds.
 *
 * The handoff spec's table, stated once and globally as it asks. A *base* per
 * character plus an extra for what was just revealed, so the two halves are
 * independently tunable: the base is how fast this NPC talks and the extras are
 * how English is punctuated, which is not a per-character property.
 *
 * Punctuation is timing and **never** a sound -- the spec is explicit, and the
 * reason is audible: a full stop that spoke would put a vocal event on the beat
 * where the voice is meant to have stopped.
 */
export const REVEAL_TIMING = {
  /** Added after a space. Small: a word gap is a beat, not a pause. */
  space: 10,
  comma: 85,
  /** A colon or a semicolon: a longer breath than a comma, shorter than a stop. */
  clause: 105,
  /** A full stop, a question mark or an exclamation mark. */
  sentence: 155,
} as const;

/**
 * Sanity for a script, for the one test that can catch a typo in an id.
 *
 * A dead `go` is the failure this exists for, and it is invisible from inside
 * the data: the reply renders, the player presses it, and the conversation ends
 * as though they had chosen to leave. Returns every problem rather than the
 * first, so fixing a script is one pass rather than one per typo.
 */
export function scriptProblems(script: DialogueScript): readonly string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const line of script.lines) {
    if (ids.has(line.id)) problems.push(`two lines share the id ${line.id}`);
    ids.add(line.id);
    if (line.text.trim() === '') problems.push(`${line.id} has nothing to say`);
  }
  if (!ids.has(script.start)) problems.push(`start names no line: ${script.start}`);
  for (const line of script.lines) {
    for (const choice of line.choices) {
      if (choice.text.trim() === '') problems.push(`${line.id} has a reply with no text`);
      if (choice.go !== null && !ids.has(choice.go)) {
        problems.push(`${line.id} replies to a line that does not exist: ${choice.go}`);
      }
    }
  }
  return problems;
}
