// The background themes, described as data. This module is pure: it contains no
// Web Audio, no DOM, and no game rules — it only produces a timed list of notes
// that the audio engine (audio.ts) schedules onto oscillators. Keeping the songs
// as data means the musical decisions are unit-testable in Node, exactly like
// the card VFX recipes in effects.ts.
//
// Two themes share one assembler:
//   - The combat theme (`buildSong`) is 70s/80s arcade: an anthemic natural-minor
//     loop (Am–F–C–G, the i–VI–III–VII progression behind a hundred synth
//     anthems) carried by an octave-pulse bass, a fast 16th-note arpeggio, a
//     written sawtooth lead, and a sustained pad.
//   - The calm theme (`buildCalmSong`) is the same arcade voice at rest: it plays
//     during the between-wave lull. Its lead is a transcription of an original
//     fingerstyle guitar recording in D natural minor (F D F G F | D F E G F |
//     D D F E | E D E D over a Dm–F–C–Gm loop), taken slower and warmer — a
//     triangle lead over a gentle alternating bass and an eighth-note arpeggio.
//   - The death theme (`buildDeathSong`) is that same guitar in mourning: it
//     plays once the player is defeated. It keeps the D-minor center but bends
//     it sinister — a slow descending Andalusian cadence (Dm–C–B♭–A, the drop
//     onto an A-major dominant lending a C♯ leading tone), a Phrygian ♭2 (E♭) in
//     the lead, a sawtooth lead over a low triangle toll and a sawtooth drone.

export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';
export type MusicVoice = 'bass' | 'arp' | 'lead' | 'pad';
/** Which soundtrack is playing: the fight, the between-wave lull, or the death dirge. */
export type MusicPhase = 'combat' | 'calm' | 'death';

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

/**
 * The music adapts to combat: while the arena is empty we play the calm theme,
 * and the moment any enemy (i.e. a spawned wave) is present we switch to the
 * combat theme. Pure so the rule is testable without Web Audio.
 */
export function musicPhaseForEnemyCount(enemyCount: number): MusicPhase {
  return enemyCount > 0 ? 'combat' : 'calm';
}

/**
 * The full music rule including defeat: once the player is down the death dirge
 * takes over everything, otherwise combat/calm follows the enemy count. Pure.
 */
export function musicPhaseFor(enemyCount: number, over: boolean): MusicPhase {
  return over ? 'death' : musicPhaseForEnemyCount(enemyCount);
}

const BEATS_PER_BAR = 4;

interface Chord {
  /** Bass root (low octave). */
  readonly root: number;
  /** Triad tones the arp and pad cycle through (mid octave). */
  readonly tones: readonly [number, number, number];
}

/** One entry per bar: [beatWithinBar, duration, midi]. */
type LeadBar = readonly (readonly [number, number, number])[];

/** Every tuning knob that distinguishes one arcade theme from another. */
interface SongSpec {
  readonly bpm: number;
  readonly progression: readonly Chord[];
  /** Semitone offsets from the chord root, one per eighth-note in the bar. */
  readonly bassPattern: readonly number[];
  readonly bassWave: Waveform;
  readonly bassGain: number;
  /** Arp hits per beat (4 = 16ths for a shimmer, 2 = 8ths for a gentle roll). */
  readonly arpPerBeat: number;
  readonly arpWave: Waveform;
  readonly arpGain: number;
  readonly leadBars: readonly LeadBar[];
  readonly leadWave: Waveform;
  readonly leadGain: number;
  readonly padWave: Waveform;
  readonly padGain: number;
}

function bassNotes(spec: SongSpec, chord: Chord, barStart: number): MusicNote[] {
  return spec.bassPattern.map((offset, i) => ({
    beat: barStart + i * 0.5,
    duration: 0.45,
    midi: chord.root + offset,
    wave: spec.bassWave,
    gain: spec.bassGain,
    voice: 'bass' as const,
  }));
}

function arpNotes(spec: SongSpec, chord: Chord, barStart: number): MusicNote[] {
  // Ascending cycle of the triad, then the triad an octave up, stepped out at
  // the spec's subdivision — 16ths sparkle (combat), 8ths roll gently (calm).
  const cycle = [chord.tones[0], chord.tones[1], chord.tones[2], chord.tones[0] + 12, chord.tones[1] + 12, chord.tones[2] + 12];
  const hits = BEATS_PER_BAR * spec.arpPerBeat;
  const step = 1 / spec.arpPerBeat;
  const notes: MusicNote[] = [];
  for (let i = 0; i < hits; i++) {
    const midi = cycle[i % cycle.length];
    if (midi === undefined) continue;
    notes.push({
      beat: barStart + i * step,
      duration: step * 0.88,
      midi,
      wave: spec.arpWave,
      gain: spec.arpGain,
      voice: 'arp',
    });
  }
  return notes;
}

function leadNotes(spec: SongSpec, barIndex: number, barStart: number): MusicNote[] {
  const bar = spec.leadBars[barIndex];
  if (!bar) return [];
  return bar.map(([beat, duration, midi]) => ({
    beat: barStart + beat,
    duration: duration * 0.92,
    midi,
    wave: spec.leadWave,
    gain: spec.leadGain,
    voice: 'lead' as const,
  }));
}

function padNotes(spec: SongSpec, chord: Chord, barStart: number): MusicNote[] {
  // A soft sustained triad under everything, filling the harmony.
  return chord.tones.map((midi) => ({
    beat: barStart,
    duration: BEATS_PER_BAR * 0.98,
    midi: midi - 12,
    wave: spec.padWave,
    gain: spec.padGain,
    voice: 'pad' as const,
  }));
}

/**
 * Assemble a looping theme from its spec. Deterministic: no randomness, no
 * clock — the same Song every call, sorted by onset so the engine can schedule
 * with a single forward-moving cursor.
 */
function assemble(spec: SongSpec): Song {
  const notes: MusicNote[] = [];
  spec.progression.forEach((chord, bar) => {
    const barStart = bar * BEATS_PER_BAR;
    notes.push(
      ...bassNotes(spec, chord, barStart),
      ...arpNotes(spec, chord, barStart),
      ...leadNotes(spec, bar, barStart),
      ...padNotes(spec, chord, barStart),
    );
  });
  notes.sort((a, b) => a.beat - b.beat);
  return { bpm: spec.bpm, lengthBeats: spec.progression.length * BEATS_PER_BAR, notes };
}

// --- Combat theme (spec 014) ---------------------------------------------

// Am – F – C – G, one bar each. Roots sit in octave 2, triad tones in octave
// 3/4 so the arp sparkles above the bass.
const COMBAT_PROGRESSION: readonly Chord[] = [
  { root: 45, tones: [57, 60, 64] }, // Am : A2 / A3 C4 E4
  { root: 41, tones: [53, 57, 60] }, // F  : F2 / F3 A3 C4
  { root: 48, tones: [55, 60, 64] }, // C  : C3 / G3 C4 E4
  { root: 43, tones: [55, 59, 62] }, // G  : G2 / G3 B3 D4
];

// Octave-pulse bass: driving eighth notes that pop up an octave and brush the
// fifth — the unmistakable arcade "runner" bass.
const COMBAT_BASS_PATTERN: readonly number[] = [0, 0, 7, 0, 12, 0, 7, 0];

// A written lead melody, one entry per bar: [beatWithinBar, duration, midi].
// Scale tones of A minor phrased to lean into each chord and loop back cleanly.
const COMBAT_LEAD_BARS: readonly LeadBar[] = [
  // Am
  [[0, 1, 64], [1, 0.5, 67], [1.5, 0.5, 64], [2, 1, 62], [3, 1, 60]],
  // F
  [[0, 1, 65], [1, 1, 64], [2, 2, 60]],
  // C
  [[0, 1, 64], [1, 0.5, 65], [1.5, 0.5, 64], [2, 1, 62], [3, 1, 60]],
  // G — resolve upward (D->E) to pull the ear back to the Am downbeat.
  [[0, 1, 62], [1, 1, 59], [2, 1, 62], [3, 1, 64]],
];

const COMBAT_SPEC: SongSpec = {
  bpm: 116,
  progression: COMBAT_PROGRESSION,
  bassPattern: COMBAT_BASS_PATTERN,
  bassWave: 'square',
  bassGain: 0.28,
  arpPerBeat: 4,
  arpWave: 'triangle',
  arpGain: 0.14,
  leadBars: COMBAT_LEAD_BARS,
  leadWave: 'sawtooth',
  leadGain: 0.2,
  padWave: 'sine',
  padGain: 0.08,
};

// --- Calm "no-wave" theme (spec 017) -------------------------------------

// Dm – F – C – Gm (i–III–VII–iv of D natural minor), one bar each. This is the
// harmony under the transcribed guitar loop; roots follow the recording's
// alternating fingerstyle bass (D, F, C, G).
const CALM_PROGRESSION: readonly Chord[] = [
  { root: 38, tones: [50, 53, 57] }, // Dm : D2 / D3 F3 A3
  { root: 41, tones: [53, 57, 60] }, // F  : F2 / F3 A3 C4
  { root: 48, tones: [55, 60, 64] }, // C  : C3 / G3 C4 E4
  { root: 43, tones: [55, 58, 62] }, // Gm : G2 / G3 A#3 D4
];

// Gentle alternating bass — root, up a fifth, up an octave, back to the fifth —
// the rocking motion of the fingerpicked take rather than a driving pulse.
const CALM_BASS_PATTERN: readonly number[] = [0, 7, 12, 7, 0, 7, 12, 7];

// The transcribed guitar melody, one phrase per bar, in D minor. This is the
// recording's top line: F D F G F | D F E G F | D D F E | E D E D, phrased to
// step E->F back into the Dm downbeat on the loop.
const CALM_LEAD_BARS: readonly LeadBar[] = [
  // Dm : F D F G F
  [[0, 1, 53], [1, 0.5, 50], [1.5, 0.5, 53], [2, 1, 55], [3, 1, 53]],
  // F  : D F E G F
  [[0, 1, 50], [1, 0.5, 53], [1.5, 0.5, 52], [2, 1, 55], [3, 1, 53]],
  // C  : D D F E
  [[0, 1, 50], [1, 1, 50], [2, 1, 53], [3, 1, 52]],
  // Gm : E D E D — lands on D, a step below the F that reopens the loop.
  [[0, 1, 52], [1, 1, 50], [2, 1, 52], [3, 1, 50]],
];

const CALM_SPEC: SongSpec = {
  bpm: 96,
  progression: CALM_PROGRESSION,
  bassPattern: CALM_BASS_PATTERN,
  bassWave: 'triangle',
  bassGain: 0.22,
  arpPerBeat: 2,
  arpWave: 'sine',
  arpGain: 0.1,
  leadBars: CALM_LEAD_BARS,
  leadWave: 'triangle',
  leadGain: 0.19,
  padWave: 'sine',
  padGain: 0.09,
};

// --- Death dirge (spec 020) ----------------------------------------------

// Dm – C – B♭ – A, one bar each: the Andalusian cadence, roots stepping *down*
// (D–C–B♭–A) for a sense of collapse. The final chord is A **major** — its C♯
// is the raised leading tone that never resolves back up here, the sinister pull
// that keeps the dirge circling. Roots sit an octave below the calm theme.
const DEATH_PROGRESSION: readonly Chord[] = [
  { root: 38, tones: [50, 53, 57] }, // Dm : D2 / D3 F3 A3
  { root: 36, tones: [48, 52, 55] }, // C  : C2 / C3 E3 G3
  { root: 34, tones: [46, 50, 53] }, // B♭ : A#1 / A#2 D3 F3
  { root: 33, tones: [45, 49, 52] }, // A  : A1 / A2 C#3 E3  (major: the leading tone)
];

// A slow toll rather than a runner: the low root with an occasional fifth,
// re-struck to drone. Heavy and deliberate under the dirge.
const DEATH_BASS_PATTERN: readonly number[] = [0, 0, 0, 7, 0, 0, 7, 0];

// The guitar in mourning: a slow descending lament. Bar 1 falls F–E♭–D, the E♭
// the Phrygian ♭2 that darkens the tonic; the line sinks through the cadence and
// bar 4 circles the A-major C♯, ending unresolved on A so the loop keeps looming.
const DEATH_LEAD_BARS: readonly LeadBar[] = [
  // Dm : F  E♭ D
  [[0, 1, 65], [1, 1, 63], [2, 2, 62]],
  // C  : D  C  B♭
  [[0, 1, 62], [1, 1, 60], [2, 2, 58]],
  // B♭ : A  B♭ A   (a sighing half-step)
  [[0, 1.5, 57], [1.5, 0.5, 58], [2, 2, 57]],
  // A  : C# D  C# A — the leading tone circling, left hanging on the dominant.
  [[0, 1, 61], [1, 1, 62], [2, 1, 61], [3, 1, 57]],
];

const DEATH_SPEC: SongSpec = {
  bpm: 72,
  progression: DEATH_PROGRESSION,
  bassPattern: DEATH_BASS_PATTERN,
  bassWave: 'triangle',
  bassGain: 0.26,
  arpPerBeat: 2,
  arpWave: 'sine',
  arpGain: 0.08,
  leadBars: DEATH_LEAD_BARS,
  leadWave: 'sawtooth',
  leadGain: 0.18,
  padWave: 'sawtooth',
  padGain: 0.06,
};

/** The combat theme (spec 014). Deterministic; notes sorted by onset. */
export function buildSong(): Song {
  return assemble(COMBAT_SPEC);
}

/** The calm between-wave theme (spec 017). Deterministic; notes sorted by onset. */
export function buildCalmSong(): Song {
  return assemble(CALM_SPEC);
}

/** The sinister death dirge (spec 020), played once the player is defeated. */
export function buildDeathSong(): Song {
  return assemble(DEATH_SPEC);
}
