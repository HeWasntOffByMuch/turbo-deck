// The background theme, described as data. This module is pure: it contains no
// Web Audio, no DOM, and no game rules — it only produces a timed list of notes
// that the audio engine (audio.ts) schedules onto oscillators. Keeping the song
// as data means the musical decisions are unit-testable in Node, exactly like
// the card VFX recipes in effects.ts.
//
// The vibe is 70s/80s arcade: an anthemic natural-minor loop (Am–F–C–G, the
// i–VI–III–VII progression behind a hundred synth anthems) carried by an
// octave-pulse bass, a fast 16th-note arpeggio, a written lead melody, and a
// sustained pad.

export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';
export type MusicVoice = 'bass' | 'arp' | 'lead' | 'pad';

export interface MusicNote {
  /** Onset in beats from the start of the loop. */
  readonly beat: number;
  /** Length in beats. */
  readonly duration: number;
  /** MIDI note number; A4 = 69 = 440Hz. */
  readonly midi: number;
  readonly wave: Waveform;
  /** Peak gain for this note, 0..1, before the master/music mix. */
  readonly gain: number;
  /** Which layer this note belongs to (for mixing and testing). */
  readonly voice: MusicVoice;
}

export interface Song {
  readonly bpm: number;
  readonly lengthBeats: number;
  /** All notes across every voice, sorted ascending by `beat`. */
  readonly notes: readonly MusicNote[];
}

/** Equal-tempered MIDI -> frequency in Hz (A4 = 69 = 440Hz). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const BEATS_PER_BAR = 4;

interface Chord {
  /** Bass root (low octave). */
  readonly root: number;
  /** Triad tones the arp and pad cycle through (mid octave). */
  readonly tones: readonly [number, number, number];
}

// Am – F – C – G, one bar each. Roots sit in octave 2, triad tones in octave
// 3/4 so the arp sparkles above the bass.
const PROGRESSION: readonly Chord[] = [
  { root: 45, tones: [57, 60, 64] }, // Am : A2 / A3 C4 E4
  { root: 41, tones: [53, 57, 60] }, // F  : F2 / F3 A3 C4
  { root: 48, tones: [55, 60, 64] }, // C  : C3 / G3 C4 E4
  { root: 43, tones: [55, 59, 62] }, // G  : G2 / G3 B3 D4
];

// Octave-pulse bass: driving eighth notes that pop up an octave and brush the
// fifth — the unmistakable arcade "runner" bass.
const BASS_PATTERN: readonly number[] = [0, 0, 7, 0, 12, 0, 7, 0];

// A written lead melody, one entry per bar: [beatWithinBar, duration, midi].
// Scale tones of A minor phrased to lean into each chord and loop back cleanly.
const LEAD_BARS: readonly (readonly [number, number, number][])[] = [
  // Am
  [[0, 1, 64], [1, 0.5, 67], [1.5, 0.5, 64], [2, 1, 62], [3, 1, 60]],
  // F
  [[0, 1, 65], [1, 1, 64], [2, 2, 60]],
  // C
  [[0, 1, 64], [1, 0.5, 65], [1.5, 0.5, 64], [2, 1, 62], [3, 1, 60]],
  // G — resolve upward (D->E) to pull the ear back to the Am downbeat.
  [[0, 1, 62], [1, 1, 59], [2, 1, 62], [3, 1, 64]],
];

function bassNotes(chord: Chord, barStart: number): MusicNote[] {
  return BASS_PATTERN.map((offset, i) => ({
    beat: barStart + i * 0.5,
    duration: 0.45,
    midi: chord.root + offset,
    wave: 'square' as const,
    gain: 0.28,
    voice: 'bass' as const,
  }));
}

function arpNotes(chord: Chord, barStart: number): MusicNote[] {
  // Six-note ascending cycle (triad, then the triad an octave up) played as
  // 16th notes — 16 hits per bar for that shimmering arcade arpeggio.
  const cycle = [chord.tones[0], chord.tones[1], chord.tones[2], chord.tones[0] + 12, chord.tones[1] + 12, chord.tones[2] + 12];
  const notes: MusicNote[] = [];
  for (let i = 0; i < BEATS_PER_BAR * 4; i++) {
    const midi = cycle[i % cycle.length];
    if (midi === undefined) continue;
    notes.push({
      beat: barStart + i * 0.25,
      duration: 0.22,
      midi,
      wave: 'triangle',
      gain: 0.14,
      voice: 'arp',
    });
  }
  return notes;
}

function leadNotes(barIndex: number, barStart: number): MusicNote[] {
  const bar = LEAD_BARS[barIndex];
  if (!bar) return [];
  return bar.map(([beat, duration, midi]) => ({
    beat: barStart + beat,
    duration: duration * 0.92,
    midi,
    wave: 'sawtooth' as const,
    gain: 0.2,
    voice: 'lead' as const,
  }));
}

function padNotes(chord: Chord, barStart: number): MusicNote[] {
  // A soft sustained triad under everything, filling the harmony.
  return chord.tones.map((midi) => ({
    beat: barStart,
    duration: BEATS_PER_BAR * 0.98,
    midi: midi - 12,
    wave: 'sine' as const,
    gain: 0.08,
    voice: 'pad' as const,
  }));
}

/**
 * Assemble the looping theme. Deterministic: no randomness, no clock — the same
 * Song every call, sorted by onset so the engine can schedule with a single
 * forward-moving cursor.
 */
export function buildSong(): Song {
  const notes: MusicNote[] = [];
  PROGRESSION.forEach((chord, bar) => {
    const barStart = bar * BEATS_PER_BAR;
    notes.push(
      ...bassNotes(chord, barStart),
      ...arpNotes(chord, barStart),
      ...leadNotes(bar, barStart),
      ...padNotes(chord, barStart),
    );
  });
  notes.sort((a, b) => a.beat - b.beat);
  return { bpm: 116, lengthBeats: PROGRESSION.length * BEATS_PER_BAR, notes };
}
