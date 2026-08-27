/**
 * What a line of dialogue *is*, as a schedule (spec 244).
 *
 * The pure half of the procedural voice: given the text and a character's
 * voice, it answers when every letter appears, which of them make a noise, and
 * what that noise is. `dialogue-sound.ts` beside it takes those answers and
 * builds oscillators; nothing here has ever heard of an `AudioContext`.
 *
 * That split is why the handoff spec's acceptance criteria are testable at all.
 * "Not every letter makes a sound", "different text produces different
 * rhythms", "questions rise toward the end", "punctuation creates natural
 * pauses" are all claims about this function, and every one of them is a
 * property somebody would otherwise have to check by listening.
 *
 * **Time and randomness are arguments**, the same rule the sim lives by and for
 * a weaker but real reason. Nothing here can change a game outcome. But "a
 * character's pitch wobbles a little" is exactly the kind of claim that is true
 * in the three cases somebody tried and false in the fourth -- and a plan built
 * from `Math.random` cannot be asserted at all. So the wobble is *hashed* off
 * the line and the character index, which the handoff spec itself suggests
 * ("seeding the dialogue sound generator from speaker ID + dialogue line ID ...
 * makes repeated lines sound consistent"), and gets a whole test instead of a
 * shrug.
 */

import { REVEAL_TIMING, type DialogueVoice, type DialogueVoiceId } from '../../server/data/dialogue.js';
import { hashText, hashUnit2 } from '../../shared/hash.js';

/**
 * A vowel-ish resonance, as two formants and a pitch tilt.
 *
 * The handoff spec's table, and its own caveat holds: *"These values are
 * aesthetic starting points, not acoustic requirements."* What they are for is
 * making two sentences sound different from each other, not making either of
 * them sound like words.
 */
export interface FormantProfile {
  readonly f1: number;
  readonly f2: number;
  /** Multiplies the engine's base pitch. */
  readonly mul: number;
}

/**
 * The resonance a letter asks for.
 *
 * Consonants modify the resonance and **never** add a percussive attack, which
 * is the one instruction in the handoff spec written from experience: *"the
 * earlier sampled experiment demonstrated that excessive hard attacks quickly
 * turn into repetitive `tsk` sounds."* So `t`, `k`, `c`, `p`, `s` are not
 * special-cased into clicks -- they fall through to the generic voiced profile
 * like every other consonant, and what makes them different from a vowel is
 * where the filters sit rather than how hard the envelope opens.
 */
export function vowelProfile(ch: string): FormantProfile {
  const c = ch.toLowerCase();
  if (c === 'a') return { f1: 850, f2: 1250, mul: 1.0 };
  if (c === 'e') return { f1: 650, f2: 1850, mul: 1.08 };
  if (c === 'i' || c === 'y') return { f1: 420, f2: 2200, mul: 1.15 };
  if (c === 'o') return { f1: 600, f2: 950, mul: 0.92 };
  if (c === 'u') return { f1: 430, f2: 800, mul: 0.86 };
  if (c === 'm' || c === 'n') return { f1: 350, f2: 900, mul: 0.88 };
  if (c === 'l' || c === 'r' || c === 'w') return { f1: 520, f2: 1350, mul: 0.98 };
  return { f1: 560, f2: 1550, mul: 1.02 };
}

/** One of the four engines, as the numbers that are not synthesis topology. */
export interface VoicePreset {
  /** Hz, before the profile's tilt and the character's multiplier. */
  readonly basePitch: number;
  /** Milliseconds a plain character holds the reveal. */
  readonly baseDelayMs: number;
  /**
   * Added to the character's density. Negative is chattier.
   *
   * Here rather than in the character's row because it is a property of the
   * *engine*: a chirp is short so it can afford to be frequent, and a murmur is
   * long so two of them close together overlap into mud.
   */
  readonly densityBias: number;
  /** Fraction the pitch rises approaching a `?`. */
  readonly questionLift: number;
  /** Fraction of hashed pitch wobble, either way. */
  readonly pitchVariation: number;
  /** The engine's own gain, before the character's volume and the bus. */
  readonly level: number;
  /** How long one vocal event lasts, seconds. Drives the envelope. */
  readonly durationSec: number;
}

/**
 * The four voices from the handoff spec.
 *
 * Numbers taken from `procedural_mumble_4voices.html`, which is the audible
 * reference: the base pitches, the per-character delays, the density biases and
 * the question lifts are that file's, so a voice tuned by ear there arrives
 * here sounding the same. What is *not* taken from it is the structure -- that
 * file plays straight from a loop with `Math.random` inline, and this is a
 * table a plan is built from.
 */
export const VOICE_PRESETS: Readonly<Record<DialogueVoiceId, VoicePreset>> = {
  // Gentle, rounded, neutral. The handoff spec's own recommended default.
  soft: {
    basePitch: 175,
    baseDelayMs: 42,
    densityBias: 0,
    questionLift: 0.07,
    pitchVariation: 0.045,
    level: 0.085,
    durationSec: 0.095,
  },
  // Small, energetic, playful. Noticeably faster than the others, which is the
  // spec's explicit requirement for it rather than a side effect.
  chirpy: {
    basePitch: 285,
    baseDelayMs: 32,
    densityBias: -1,
    questionLift: 0.12,
    pitchVariation: 0.035,
    level: 0.065,
    durationSec: 0.052,
  },
  // Low, relaxed, sleepy. Its events are long enough to overlap, which is
  // deliberate: that overlap is what makes it read as continuous murmuring
  // rather than as a row of individual noises.
  warm: {
    basePitch: 112,
    baseDelayMs: 51,
    densityBias: 1,
    questionLift: 0.05,
    pitchVariation: 0.035,
    level: 0.075,
    durationSec: 0.16,
  },
  // Cartoonish and odd. Intentionally artificial, and still vocal.
  nasal: {
    basePitch: 205,
    baseDelayMs: 38,
    densityBias: 0,
    questionLift: 0.1,
    pitchVariation: 0.055,
    level: 0.055,
    durationSec: 0.1,
  },
};

/** How far ahead a `?` starts lifting the pitch, in characters. */
export const QUESTION_LOOKAHEAD = 9;

/** What a row that does not say gets. The spec's recommended default. */
export const DEFAULT_DENSITY = 3;

/** One vocal event: everything `dialogue-sound.ts` needs to build a voice. */
export interface SpeakEvent {
  /** The letter that asked for it, for the resonance. */
  readonly char: string;
  /** Hz, with the profile, the character's multiplier, the wobble and any question lift already in it. */
  readonly pitch: number;
  /** 0..1, the engine's level times the character's volume. */
  readonly gain: number;
  readonly durationSec: number;
  readonly profile: FormantProfile;
}

/** One revealed character, and the sound it did or did not make. */
export interface RevealStep {
  /** Index into the line. `text.slice(0, index + 1)` is what is now visible. */
  readonly index: number;
  /** Milliseconds from the start of the line at which this character appears. */
  readonly atMs: number;
  readonly speak: SpeakEvent | null;
}

/** A whole line, planned. */
export interface LinePlan {
  readonly text: string;
  readonly steps: readonly RevealStep[];
  /** When the last character has appeared and its pause has run out. */
  readonly durationMs: number;
}

const LETTER = /[a-z]/i;
const VOWEL = /[aeiouy]/i;

/**
 * How long the reveal holds after revealing `ch`.
 *
 * The base is the voice's, divided by its speed; the punctuation extra is
 * divided by the same, so a fast talker's pauses shorten with their speech
 * rather than becoming proportionally longer.
 */
function holdAfter(ch: string, baseMs: number, speed: number): number {
  let hold = baseMs;
  if (ch === ',') hold += REVEAL_TIMING.comma;
  else if (ch === '.' || ch === '!' || ch === '?') hold += REVEAL_TIMING.sentence;
  else if (ch === ';' || ch === ':') hold += REVEAL_TIMING.clause;
  else if (ch === ' ') hold += REVEAL_TIMING.space;
  return hold / speed;
}

/**
 * How far the pitch is lifted at `index` by the next question mark.
 *
 * Returns 1 where there is none in range. The lift *grows* as the mark
 * approaches, which is what makes a question rise rather than simply sit
 * higher -- and it is measured to the next `?` at or after this character, so a
 * line with two questions in it rises twice.
 */
export function questionLiftAt(text: string, index: number, lift: number): number {
  const mark = text.indexOf('?', index);
  if (mark < 0) return 1;
  const distance = mark - index;
  if (distance >= QUESTION_LOOKAHEAD) return 1;
  return 1 + ((QUESTION_LOOKAHEAD - distance) / QUESTION_LOOKAHEAD) * lift;
}

/**
 * Whether this character gets a vocal event.
 *
 * The handoff spec's rule verbatim, and the reason it is a rule rather than
 * "every letter" is stated there too: one sound per letter is machine-gun
 * chatter. A word start always speaks, so the *rhythm* follows the words; a
 * long enough gap speaks, so a long word is not one syllable; and a vowel
 * speaks on a shorter gap, so what carries the melody is the part of a word
 * that carries it in speech.
 */
export function shouldSpeak(
  isWordStart: boolean,
  isVowel: boolean,
  sinceLast: number,
  density: number,
): boolean {
  return isWordStart || sinceLast >= density || (isVowel && sinceLast >= 2);
}

/**
 * Plan a line: when each character appears, and what it sounds like.
 *
 * `seedText` is what the wobble is hashed off -- the speaker and the line id,
 * so the same line spoken twice sounds identical and two lines never sound like
 * each other. Pure: same arguments, same plan, forever.
 */
export function planLine(text: string, voice: DialogueVoice, seedText: string): LinePlan {
  const preset = VOICE_PRESETS[voice.voice];
  const speed = Math.max(0.05, voice.speed ?? 1);
  const volume = Math.max(0, voice.volume ?? 1);
  const pitchMultiplier = Math.max(0.05, voice.pitchMultiplier ?? 1);
  const variation = Math.max(0, voice.pitchVariation ?? preset.pitchVariation);
  const lift = voice.questionLift ?? preset.questionLift;
  // Never below 1: a density of zero would make `sinceLast >= density` true for
  // the character immediately after a sound, which is one sound per letter --
  // the exact thing the density rule exists to prevent.
  const density = Math.max(1, (voice.density ?? DEFAULT_DENSITY) + preset.densityBias);
  // `hashText` answers 8 hex digits; `hash2i` takes the low 32 bits of whatever
  // it is handed, so the whole word survives the trip.
  const seed = parseInt(hashText(seedText), 16);

  const steps: RevealStep[] = [];
  let atMs = 0;
  // Far enough back that the first letter always passes the gap rule, so a line
  // opening on a consonant still speaks its first character.
  let lastSpoken = -999;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    const isLetter = LETTER.test(ch);
    const isVowel = VOWEL.test(ch);
    const isWordStart = isLetter && (i === 0 || text[i - 1] === ' ');
    let speak: SpeakEvent | null = null;

    if (isLetter && shouldSpeak(isWordStart, isVowel, i - lastSpoken, density)) {
      const profile = vowelProfile(ch);
      // Hashed rather than drawn, so the same line is the same performance.
      const wobble = (hashUnit2(i, 0, seed) * 2 - 1) * variation;
      // A capital gets a touch more push: it is a sentence opening or a name,
      // and both are things a speaker leans on very slightly.
      const emphasis = ch !== ch.toLowerCase() ? 1.025 : 1;
      speak = {
        char: ch,
        pitch:
          preset.basePitch *
          profile.mul *
          pitchMultiplier *
          questionLiftAt(text, i, lift) *
          emphasis *
          (1 + wobble),
        gain: preset.level * volume,
        durationSec: preset.durationSec,
        profile,
      };
      lastSpoken = i;
    }

    steps.push({ index: i, atMs, speak });
    atMs += holdAfter(ch, preset.baseDelayMs, speed);
  }

  return { text, steps, durationMs: atMs };
}
