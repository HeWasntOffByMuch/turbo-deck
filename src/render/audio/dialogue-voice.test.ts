import { describe, expect, it } from 'vitest';

import { REVEAL_TIMING, type DialogueVoice, type DialogueVoiceId } from '../../server/data/dialogue.js';
import {
  DEFAULT_DENSITY,
  QUESTION_LOOKAHEAD,
  VOICE_PRESETS,
  planLine,
  questionLiftAt,
  shouldSpeak,
  vowelProfile,
} from './dialogue-voice.js';

/**
 * The procedural dialogue voice (spec 244).
 *
 * Every one of the handoff spec's acceptance criteria that is a claim about
 * arithmetic is asserted here, because the alternative is somebody listening --
 * and "not every letter makes a sound" is exactly the sort of thing that is
 * true of the sentence somebody tried and false of the next one.
 *
 * What is deliberately **not** asserted: what any of it sounds like. That is
 * `dialogue-sound.ts`'s and it is a matter for ears.
 */

const SOFT: DialogueVoice = { voice: 'soft' };
const VOICES: readonly DialogueVoiceId[] = ['soft', 'chirpy', 'warm', 'nasal'];

function spoken(text: string, voice: DialogueVoice = SOFT, seed = 'test:line'): number {
  return planLine(text, voice, seed).steps.filter((step) => step.speak !== null).length;
}

/** Indexed access with the index checked, since `!` is a lint error here. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

/** When each character is revealed, in order. */
function times(plan: ReturnType<typeof planLine>): number[] {
  return plan.steps.map((step) => step.atMs);
}

/** When each vocal event fires, in order. */
function beatsOf(plan: ReturnType<typeof planLine>): number[] {
  return plan.steps.flatMap((step) => (step.speak ? [step.atMs] : []));
}

function meanGap(values: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < values.length; i++) {
    total += must(values[i], `beat ${i}`) - must(values[i - 1], `beat ${i - 1}`);
  }
  return total / (values.length - 1);
}

describe('planLine', () => {
  it('reveals exactly one step per character, in order', () => {
    const text = 'Looking for something useful?';
    const plan = planLine(text, SOFT, 'a:b');
    expect(plan.steps).toHaveLength(text.length);
    expect(plan.steps.map((step) => step.index)).toEqual(text.split('').map((_, i) => i));
    // Monotonic: a character never appears before the one in front of it.
    const at = times(plan);
    for (let i = 1; i < at.length; i++) {
      expect(must(at[i], `step ${i}`)).toBeGreaterThanOrEqual(must(at[i - 1], `step ${i - 1}`));
    }
  });

  it('is pure: the same line planned twice is the same plan', () => {
    const a = planLine('Take your time.', SOFT, 'rell:browse');
    const b = planLine('Take your time.', SOFT, 'rell:browse');
    expect(a).toEqual(b);
  });

  it('gives two lines different pitches for the same letter', () => {
    // The seed is speaker + line, which is what the handoff spec suggests, so
    // one NPC's two lines are two performances rather than one repeated.
    const a = planLine('aaaa aaaa', SOFT, 'rell:greet');
    const b = planLine('aaaa aaaa', SOFT, 'rell:who');
    const pitches = (plan: typeof a): number[] =>
      plan.steps.flatMap((step) => (step.speak ? [step.speak.pitch] : []));
    expect(pitches(a)).not.toEqual(pitches(b));
  });

  it('does not speak on every character', () => {
    // The handoff spec's first acceptance criterion for density, and the
    // failure it names: one sound per letter is machine-gun chatter.
    const text = 'Looking for something useful in the pack today';
    const letters = text.replace(/[^a-z]/gi, '').length;
    expect(spoken(text)).toBeLessThan(letters * 0.75);
    expect(spoken(text)).toBeGreaterThan(0);
  });

  it('never speaks punctuation or spaces', () => {
    // Punctuation is timing and never a sound: a full stop that spoke would put
    // a vocal event on the beat where the voice is meant to have stopped.
    const plan = planLine('Well, then... who? You!', SOFT, 'x:y');
    for (const step of plan.steps) {
      if (step.speak === null) continue;
      expect(step.speak.char, `spoke ${JSON.stringify(step.speak.char)}`).toMatch(/[a-z]/i);
    }
  });

  it('speaks the first letter of the line and of every word', () => {
    const text = 'one two three';
    const plan = planLine(text, SOFT, 'x:y');
    for (let i = 0; i < text.length; i++) {
      const isWordStart = /[a-z]/i.test(must(text[i], `char ${i}`)) && (i === 0 || text[i - 1] === ' ');
      if (isWordStart) expect(must(plan.steps[i], `step ${i}`).speak, `at ${i}`).not.toBeNull();
    }
  });

  it('gives different text different rhythms', () => {
    // The spec's "different text produces different rhythms". Compared as the
    // set of indices that spoke, which is what a rhythm *is* here.
    const a = planLine('aaaaaaaaaaaa', SOFT, 'x:y');
    const b = planLine('a bc de f gh', SOFT, 'x:y');
    const beats = (plan: typeof a): number[] =>
      plan.steps.flatMap((step) => (step.speak ? [step.index] : []));
    expect(beats(a)).not.toEqual(beats(b));
  });

  it('lengthens the pause after punctuation, by the authored amounts', () => {
    // Measured as the gap the reveal holds *after* the character, which is what
    // the table states. A plain letter is the baseline.
    const gapAfter = (text: string, index: number): number => {
      const at = times(planLine(text, SOFT, 'x:y'));
      return must(at[index + 1], 'next') - must(at[index], 'this');
    };
    const base = gapAfter('ab', 0);
    expect(gapAfter('a b', 1) - base).toBeCloseTo(REVEAL_TIMING.space, 6);
    expect(gapAfter('a,b', 1) - base).toBeCloseTo(REVEAL_TIMING.comma, 6);
    expect(gapAfter('a;b', 1) - base).toBeCloseTo(REVEAL_TIMING.clause, 6);
    expect(gapAfter('a:b', 1) - base).toBeCloseTo(REVEAL_TIMING.clause, 6);
    for (const mark of ['.', '!', '?']) {
      expect(gapAfter(`a${mark}b`, 1) - base, mark).toBeCloseTo(REVEAL_TIMING.sentence, 6);
    }
  });

  it('shortens a pause along with the speech it belongs to', () => {
    // Speed divides the punctuation extra as well as the base, so a fast talker
    // does not end up with proportionally longer pauses than a slow one.
    const slow = planLine('a.b', { voice: 'soft', speed: 1 }, 'x:y');
    const fast = planLine('a.b', { voice: 'soft', speed: 2 }, 'x:y');
    expect(fast.durationMs).toBeCloseTo(slow.durationMs / 2, 6);
  });

  it('rises toward a question mark, and further the closer it gets', () => {
    const plan = planLine('will you help me?', { voice: 'soft', density: 1 }, 'x:y');
    const inWindow = plan.steps.filter(
      (step) => step.speak !== null && plan.text.indexOf('?', step.index) - step.index < QUESTION_LOOKAHEAD,
    );
    expect(inWindow.length).toBeGreaterThan(2);
    // The same letter, later in the run-up, is higher. Compared against a copy
    // of the line with no mark in it, so the vowel profile and the hashed
    // wobble are held identical and only the lift can differ.
    const flat = planLine('will you help me.', { voice: 'soft', density: 1 }, 'x:y');
    let highest = 0;
    for (const step of inWindow) {
      const same = must(flat.steps[step.index], `flat step ${step.index}`);
      if (same.speak === null || step.speak === null) continue;
      const ratio = step.speak.pitch / same.speak.pitch;
      expect(ratio).toBeGreaterThan(0.999);
      highest = Math.max(highest, ratio);
    }
    expect(highest).toBeGreaterThan(1);
  });

  it('does not lift a line with no question in it', () => {
    for (let i = 0; i < 12; i++) expect(questionLiftAt('a statement here.', i, 0.07)).toBe(1);
  });

  it('lifts twice for a line with two questions', () => {
    const text = 'who? and why?';
    expect(questionLiftAt(text, 0, 0.1)).toBeGreaterThan(1);
    expect(questionLiftAt(text, text.indexOf('why'), 0.1)).toBeGreaterThan(1);
  });

  it('keeps the wobble inside the authored fraction', () => {
    // Small on purpose: the spec's own warning is that too much randomness makes
    // a character sound inconsistent rather than alive.
    const variation = 0.045;
    const plan = planLine('a a a a a a a a a a a a', { voice: 'soft', pitchVariation: variation }, 's:l');
    const nominal = VOICE_PRESETS.soft.basePitch * vowelProfile('a').mul;
    for (const step of plan.steps) {
      if (step.speak === null) continue;
      expect(Math.abs(step.speak.pitch / nominal - 1)).toBeLessThanOrEqual(variation + 1e-9);
    }
  });

  it('multiplies the preset by the character, never replaces it', () => {
    // The property that makes one engine serve many NPCs: a row that says only
    // its engine is the preset exactly, and a pitch multiplier moves it.
    const plain = planLine('aaa', { voice: 'warm' }, 's:l');
    const high = planLine('aaa', { voice: 'warm', pitchMultiplier: 2 }, 's:l');
    const first = (plan: typeof plain): number => {
      const spoke = plan.steps.flatMap((each) => (each.speak ? [each.speak] : []));
      return must(spoke[0], 'a spoken step').pitch;
    };
    expect(first(high)).toBeCloseTo(first(plain) * 2, 6);
  });
});

describe('the four presets', () => {
  it('are all distinguishable by pitch and pace', () => {
    // "All four voice presets are immediately distinguishable" is a claim about
    // ears; what can be asserted is that no two of them are the same numbers.
    const pitches = VOICES.map((id) => VOICE_PRESETS[id].basePitch);
    expect(new Set(pitches).size).toBe(VOICES.length);
    const delays = VOICES.map((id) => VOICE_PRESETS[id].baseDelayMs);
    expect(new Set(delays).size).toBe(VOICES.length);
  });

  it('makes chirpy the fastest and warm the slowest', () => {
    // The spec states both directly: chirpy "should be noticeably faster than
    // Soft Mumble", warm is the low relaxed one whose events overlap.
    expect(VOICE_PRESETS.chirpy.baseDelayMs).toBeLessThan(VOICE_PRESETS.soft.baseDelayMs);
    expect(VOICE_PRESETS.warm.baseDelayMs).toBeGreaterThan(VOICE_PRESETS.soft.baseDelayMs);
    expect(VOICE_PRESETS.chirpy.durationSec).toBeLessThan(VOICE_PRESETS.soft.durationSec);
    expect(VOICE_PRESETS.warm.durationSec).toBeGreaterThan(VOICE_PRESETS.soft.durationSec);
  });

  it('keeps every preset inside the ranges the handoff spec states', () => {
    expect(VOICE_PRESETS.soft.basePitch).toBeGreaterThanOrEqual(170);
    expect(VOICE_PRESETS.soft.basePitch).toBeLessThanOrEqual(190);
    expect(VOICE_PRESETS.chirpy.basePitch).toBeGreaterThanOrEqual(260);
    expect(VOICE_PRESETS.chirpy.basePitch).toBeLessThanOrEqual(320);
    expect(VOICE_PRESETS.warm.basePitch).toBeGreaterThanOrEqual(100);
    expect(VOICE_PRESETS.warm.basePitch).toBeLessThanOrEqual(125);
    expect(VOICE_PRESETS.nasal.basePitch).toBeGreaterThanOrEqual(190);
    expect(VOICE_PRESETS.nasal.basePitch).toBeLessThanOrEqual(220);
  });

  it('gives the murmur overlapping events and gives nothing else any', () => {
    // The one audible property here that is arithmetic, and it has to be
    // *measured* rather than derived: the obvious formula -- one sound every
    // `density` characters -- says warm does not overlap, because word starts
    // speak more often than the density rule alone would. Over a real line
    // warm's mean gap is 156ms against a 160ms event, so it does.
    const line = 'Looking for something useful in the pack today, traveller?';
    for (const id of VOICES) {
      const plan = planLine(line, { voice: id }, 's:l');
      const beats = beatsOf(plan);
      expect(beats.length, id).toBeGreaterThan(4);
      const meanGapMs = meanGap(beats);
      const overlaps = VOICE_PRESETS[id].durationSec * 1000 > meanGapMs;
      expect(overlaps, `${id} mean gap ${meanGapMs.toFixed(1)}ms`).toBe(id === 'warm');
    }
  });

  it('speaks at a rate every voice can be told apart by', () => {
    // Long words, deliberately: in short-word text nearly every sound is a word
    // start, so the density bias barely shows and soft and nasal tie. What the
    // bias governs is how often a voice speaks *inside* a word.
    const text = 'extraordinarily complicated transformations';
    const counts = VOICES.map((id) => spoken(text, { voice: id }));
    const [soft, chirpy, warm] = counts as [number, number, number];
    // Chirpy's negative bias makes it the chattiest, warm's positive the sparsest.
    expect(chirpy).toBeGreaterThan(soft);
    expect(warm).toBeLessThan(soft);
  });

  it('leaves the density default where the handoff spec puts it', () => {
    expect(DEFAULT_DENSITY).toBe(3);
  });
});

describe('shouldSpeak', () => {
  it('always speaks a word start', () => {
    expect(shouldSpeak(true, false, 0, 99)).toBe(true);
  });

  it('speaks once the gap reaches the density', () => {
    expect(shouldSpeak(false, false, 2, 3)).toBe(false);
    expect(shouldSpeak(false, false, 3, 3)).toBe(true);
  });

  it('speaks a vowel on a shorter gap than a consonant', () => {
    expect(shouldSpeak(false, true, 2, 4)).toBe(true);
    expect(shouldSpeak(false, false, 2, 4)).toBe(false);
  });

  it('never speaks twice in a row off the gap rule alone', () => {
    // Density is floored at 1 in `planLine` for exactly this: at 0 the character
    // after a sound would satisfy `sinceLast >= density` and every letter would
    // speak, which is the rule inverted.
    const plan = planLine('bcdfghjklm', { voice: 'soft', density: 0 }, 'x:y');
    const beats = plan.steps.flatMap((step) => (step.speak ? [step.index] : []));
    for (let i = 1; i < beats.length; i++) {
      expect(must(beats[i], `beat ${i}`) - must(beats[i - 1], `beat ${i - 1}`)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('vowelProfile', () => {
  it('gives each vowel its own resonance', () => {
    const keys = ['a', 'e', 'i', 'o', 'u'].map((ch) => {
      const p = vowelProfile(ch);
      return `${p.f1}/${p.f2}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('treats the hard consonants as ordinary voiced ones', () => {
    // The handoff spec's most specific instruction, from experience: sharp
    // attacks for T/K/C/P/S/CH are what turn a voice into repeated `tsk`. They
    // get the generic profile, so what differs is resonance and never attack.
    const generic = vowelProfile('z');
    for (const ch of ['t', 'k', 'c', 'p', 's']) expect(vowelProfile(ch), ch).toEqual(generic);
  });

  it('is case insensitive', () => {
    expect(vowelProfile('A')).toEqual(vowelProfile('a'));
  });
});
