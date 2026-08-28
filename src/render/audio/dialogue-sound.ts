/**
 * The four voices, as Web Audio (spec 246).
 *
 * The impure half. Everything that *decides* -- which letter speaks, at what
 * pitch, after what pause -- happened in `dialogue-voice.ts` and arrives here as
 * a {@link SpeakEvent}; this file's whole job is to turn one of those into
 * oscillators and filters and let them go.
 *
 * Transcribed from `procedural_mumble_4voices.html` rather than reinvented, in
 * the register `src/sim/avoidance.ts` transcribes RVO2: the reference is what
 * the four voices are *defined* by, it was tuned by ear, and a version written
 * from the prose description would be a fifth voice that sounds like none of
 * them. What changed on the way in is structure, not sound -- levels come from
 * the plan instead of being read off a slider mid-loop, and every voice lands on
 * a bus instead of `context.destination`.
 *
 * Three rules from the handoff spec's performance section are properties of this
 * file rather than intentions:
 *
 * - **One context, no files.** Nodes are built from the `SpeechOutput` the
 *   engine already made. Nothing here fetches or decodes anything.
 * - **Nodes stop promptly.** Every source is given an explicit stop time when it
 *   starts, and disconnects itself on `ended`, so a line that was cancelled
 *   leaves nothing running and nothing referenced.
 * - **A cap, not a pool.** `AudioBufferSourceNode` and `OscillatorNode` are
 *   single-use by specification and cheap to allocate for that reason, which is
 *   what `engine.ts` already says about voices. What actually goes wrong is
 *   many at once, so what exists is a ceiling.
 */

import type { SpeakEvent } from './dialogue-voice.js';
import type { DialogueVoiceId } from '../../server/data/dialogue.js';
import type { SpeechOutput } from './sink.js';

/**
 * How many dialogue voices may sound at once.
 *
 * The handoff spec's own figure is "rarely more than 2-4 active vocal events",
 * and the density rule keeps normal speech under that on its own. This is the
 * ceiling for the case the rule cannot cover -- a very fast voice on a long
 * word, or a `warm` murmur whose events are long enough to overlap several
 * deep -- and it is a small number on purpose: what a dozen simultaneous
 * mumbles sound like is not a dozen mumbles, it is a chord.
 */
export const MAX_SPEECH_VOICES = 4;

/** A tiny non-zero, since an exponential ramp cannot reach or leave zero. */
const SILENCE = 0.0001;

/**
 * The shared envelope: soft in, hold, soft out.
 *
 * Exponential ramps rather than linear, because loudness is perceived that way
 * and a linear fade on a short event reads as a click at its end -- which is
 * the failure mode the whole design is trying to avoid.
 */
function envelope(
  context: BaseAudioContext,
  source: AudioNode,
  into: AudioNode,
  start: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): GainNode {
  const gain = context.createGain();
  const top = Math.max(SILENCE * 10, peak);
  gain.gain.setValueAtTime(SILENCE, start);
  gain.gain.exponentialRampToValueAtTime(top, start + attack);
  gain.gain.setValueAtTime(top, start + attack + hold);
  gain.gain.exponentialRampToValueAtTime(SILENCE, start + attack + hold + release);
  source.connect(gain);
  gain.connect(into);
  return gain;
}

/** Stop and disconnect the whole chain when the source ends. */
function release(source: OscillatorNode | AudioBufferSourceNode, ...nodes: AudioNode[]): void {
  source.onended = (): void => {
    source.disconnect();
    for (const node of nodes) node.disconnect();
  };
}

/**
 * 1. Soft Mumble -- triangle through two broad formants, plus a breath.
 *
 * The safest default, and the one that most needs its attack kept gentle: a
 * sharp one here is the "tak"/"cha" syllable the spec warns about. The noise is
 * very quiet and low-passed; it is breath, not consonants.
 */
function playSoft(out: SpeechOutput, event: SpeakEvent, at: number): GainNode {
  const { context, into } = out;
  const osc = context.createOscillator();
  const f1 = context.createBiquadFilter();
  const f2 = context.createBiquadFilter();
  const mix = context.createGain();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(event.pitch, at);
  // A slight fall over the event: a held vowel sags, and a perfectly steady
  // tone reads as a tone rather than as a voice.
  osc.frequency.exponentialRampToValueAtTime(event.pitch * 0.98, at + 0.075);

  f1.type = 'bandpass';
  f1.frequency.value = event.profile.f1;
  f1.Q.value = 1.6;
  f2.type = 'bandpass';
  f2.frequency.value = event.profile.f2;
  f2.Q.value = 1.4;

  osc.connect(f1).connect(mix);
  osc.connect(f2).connect(mix);
  mix.gain.value = 0.8;
  const gain = envelope(context, mix, into, at, event.gain, 0.012, 0.025, 0.045);
  osc.start(at);
  osc.stop(at + event.durationSec);
  release(osc, f1, f2, mix, gain);

  const breath = context.createBufferSource();
  const low = context.createBiquadFilter();
  const level = context.createGain();
  breath.buffer = noise(context, 0.06);
  low.type = 'lowpass';
  low.frequency.value = 2500;
  level.gain.setValueAtTime(SILENCE, at);
  level.gain.exponentialRampToValueAtTime(Math.max(SILENCE * 10, event.gain * 0.12), at + 0.01);
  level.gain.exponentialRampToValueAtTime(SILENCE, at + 0.045);
  breath.connect(low).connect(level).connect(into);
  breath.start(at);
  breath.stop(at + 0.06);
  release(breath, low, level);
  return gain;
}

/**
 * 2. Chirpy Chatter -- sine with a quiet square harmonic, and a pitch scoop.
 *
 * The melodic steps are what stop it being one repeated beep: each event lands
 * on one of four intervals, so a sentence has a shape. Staccato, and much
 * shorter than the others.
 */
function playChirpy(out: SpeechOutput, event: SpeakEvent, at: number, step: number): GainNode {
  const { context, into } = out;
  const base = event.pitch * step;
  const o1 = context.createOscillator();
  const o2 = context.createOscillator();
  const mix = context.createGain();
  const low = context.createBiquadFilter();

  o1.type = 'sine';
  // Up into the note rather than onto it: the scoop is most of the character.
  o1.frequency.setValueAtTime(base * 0.86, at);
  o1.frequency.exponentialRampToValueAtTime(base, at + 0.022);
  o2.type = 'square';
  o2.frequency.setValueAtTime(base * 2.01, at);

  mix.gain.value = 0.7;
  o1.connect(mix);
  o2.connect(mix);
  low.type = 'lowpass';
  low.frequency.value = 3300;
  low.Q.value = 0.7;
  mix.connect(low);
  const gain = envelope(context, low, into, at, event.gain, 0.004, 0.01, 0.028);
  o1.start(at);
  o2.start(at);
  o1.stop(at + event.durationSec);
  o2.stop(at + event.durationSec);
  release(o1, mix, low, gain);
  o2.onended = (): void => o2.disconnect();
  return gain;
}

/**
 * 3. Warm Murmur -- two detuned low oscillators through low formants.
 *
 * Its envelope is long enough that the next event usually begins before this
 * one has finished, and that overlap is the design rather than a mistake: it is
 * what makes this voice read as continuous murmuring instead of a row of
 * separate noises.
 */
function playWarm(out: SpeechOutput, event: SpeakEvent, at: number): GainNode {
  const { context, into } = out;
  const o1 = context.createOscillator();
  const o2 = context.createOscillator();
  const f1 = context.createBiquadFilter();
  const f2 = context.createBiquadFilter();
  const mix = context.createGain();

  o1.type = 'triangle';
  o2.type = 'sawtooth';
  o1.frequency.setValueAtTime(event.pitch, at);
  // Barely detuned: enough to beat slowly against its twin, not enough to be
  // heard as two notes.
  o2.frequency.setValueAtTime(event.pitch * 1.005, at);
  o1.frequency.exponentialRampToValueAtTime(event.pitch * 0.965, at + 0.13);
  o2.frequency.exponentialRampToValueAtTime(event.pitch * 0.97, at + 0.13);

  f1.type = 'bandpass';
  f1.frequency.value = Math.max(280, event.profile.f1 * 0.72);
  f1.Q.value = 1.2;
  f2.type = 'bandpass';
  f2.frequency.value = Math.max(650, event.profile.f2 * 0.7);
  f2.Q.value = 1.1;

  o1.connect(f1).connect(mix);
  o2.connect(f2).connect(mix);
  mix.gain.value = 0.65;
  const gain = envelope(context, mix, into, at, event.gain, 0.018, 0.06, 0.065);
  o1.start(at);
  o2.start(at);
  o1.stop(at + event.durationSec);
  o2.stop(at + event.durationSec);
  release(o1, f1, f2, mix, gain);
  o2.onended = (): void => o2.disconnect();
  return gain;
}

/**
 * 4. Nasal Babble -- sawtooth through a narrow high-Q resonance.
 *
 * The elastic pitch -- up hard, then settling back -- is what makes it read as
 * cartoonish rather than merely buzzy, and the high Q on the nasal filter is
 * what makes it nasal rather than bright.
 */
function playNasal(out: SpeechOutput, event: SpeakEvent, at: number): GainNode {
  const { context, into } = out;
  const osc = context.createOscillator();
  const nasal = context.createBiquadFilter();
  const body = context.createBiquadFilter();
  const mix = context.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(event.pitch * 0.92, at);
  osc.frequency.exponentialRampToValueAtTime(event.pitch * 1.06, at + 0.035);
  osc.frequency.exponentialRampToValueAtTime(event.pitch * 0.99, at + 0.09);

  nasal.type = 'bandpass';
  nasal.frequency.value = 1050 + event.profile.f2 * 0.18;
  nasal.Q.value = 6.5;
  body.type = 'bandpass';
  body.frequency.value = 500 + event.profile.f1 * 0.3;
  body.Q.value = 2.4;

  osc.connect(nasal).connect(mix);
  osc.connect(body).connect(mix);
  mix.gain.value = 0.72;
  const gain = envelope(context, mix, into, at, event.gain, 0.008, 0.032, 0.045);
  osc.start(at);
  osc.stop(at + event.durationSec);
  release(osc, nasal, body, mix, gain);
  return gain;
}

/**
 * A short noise burst, for the soft voice's breath.
 *
 * Allocated per event and deliberately tiny -- 60ms at 48kHz is under 12KB, and
 * the alternative (one shared buffer) would make every breath the identical
 * waveform, which at this density is audible as a repeating texture.
 */
function noise(context: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // The one place in this feature that draws from `Math.random`, and it is safe
  // where the pitch wobble was not: this is the *contents of a noise buffer*,
  // which has no perceptible identity to keep stable between two playings of
  // the same line. Nothing about it is asserted anywhere, and nothing could be.
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Chirpy's melodic steps. Small intervals: a scale, not an arpeggio. */
const CHIRP_STEPS = [0.9, 1.0, 1.12, 1.25] as const;

/**
 * How long a cut-off voice takes to fade, seconds.
 *
 * Not zero, because setting a gain to silence instantly is a step in the
 * waveform and a step is a click -- which would make closing a bubble mid-word
 * *louder* than letting it finish. Short enough that "no leftover dialogue
 * audio continues after the conversation closes" is true to any ear.
 */
const CUT_SEC = 0.015;

/**
 * The live voices, and the two rules about them.
 *
 * A class rather than a bare `speak` function because both rules need somewhere
 * to live: the **cap**, which needs to know how many are sounding, and the
 * **cut**, which needs to be able to reach them. The handoff spec asks for both
 * -- "cap simultaneous vocal events", and "audio events must never survive the
 * dialogue bubble they belong to" -- and neither is expressible without a
 * holder.
 *
 * Note what is *not* here: a queue, and a schedule. Every voice starts at
 * `currentTime` the moment the reveal reaches its character, so there is never
 * a pending sound to cancel -- which is a stronger guarantee than the token the
 * handoff spec suggests, and the reason skipping a line cannot produce a burst.
 * {@link stopAll} exists for the voices that have already *started*.
 */
export class SpeechVoices {
  private readonly live = new Set<GainNode>();

  /** How many are sounding. Exposed for the test that asserts the cap. */
  get count(): number {
    return this.live.size;
  }

  /**
   * Speak one event, now.
   *
   * `stepIndex` picks the chirpy voice's interval and is the plan's character
   * index, so its melody is a function of the text rather than of a draw -- the
   * same reason the pitch wobble is hashed. Every other voice ignores it.
   *
   * Refused over the cap rather than queued, because a mumble is a request for
   * a sound *now* or not at all: `engine.ts` makes the same choice for the same
   * reason, and a queued syllable arrives after the letter that wanted it.
   */
  speak(out: SpeechOutput, voice: DialogueVoiceId, event: SpeakEvent, stepIndex: number): boolean {
    if (this.live.size >= MAX_SPEECH_VOICES) return false;
    const at = out.context.currentTime;
    const gain = this.start(out, voice, event, stepIndex, at);
    this.live.add(gain);
    // Held until the envelope has run out rather than until the source ends,
    // because `warm`'s release is deliberately longer than its oscillators and
    // the slot should free when the sound does.
    const seconds = event.durationSec + CUT_SEC;
    globalThis.setTimeout(() => this.live.delete(gain), Math.ceil(seconds * 1000) + 50);
    return true;
  }

  private start(
    out: SpeechOutput,
    voice: DialogueVoiceId,
    event: SpeakEvent,
    stepIndex: number,
    at: number,
  ): GainNode {
    switch (voice) {
      case 'soft':
        return playSoft(out, event, at);
      case 'chirpy':
        return playChirpy(out, event, at, CHIRP_STEPS[stepIndex % CHIRP_STEPS.length] ?? 1);
      case 'warm':
        return playWarm(out, event, at);
      case 'nasal':
        return playNasal(out, event, at);
    }
  }

  /**
   * Silence everything sounding. What closing a bubble does.
   *
   * The scheduled envelope is cancelled first, or the ramp below would be
   * overwritten by the values already queued on the parameter -- which is the
   * whole failure this method exists to avoid, and it is silent: the sound
   * simply plays on to its natural end as though nothing had been asked.
   */
  stopAll(out: SpeechOutput | null): void {
    if (out !== null) {
      const now = out.context.currentTime;
      for (const gain of this.live) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(Math.max(SILENCE, gain.gain.value), now);
        gain.gain.exponentialRampToValueAtTime(SILENCE, now + CUT_SEC);
      }
    }
    this.live.clear();
  }
}
