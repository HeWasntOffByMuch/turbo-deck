# 014 — Retro-arcade audio: melodic synth music + attack SFX

## Problem

The game is silent. It wants the feel of a 70s/80s arcade cabinet: a melodic,
looping electronic theme plus punchy synthesized sound effects on attacks and
combat beats. Audio is pure presentation — it reads sim/game events and drives
the speakers — so like `src/render/effects.ts` it lives in `src/render/` and
holds no game rules. None of it may touch the sim, and it must not perturb
determinism (the sim never learns audio exists).

## Shape

Three modules, split so the musical/design decisions are pure and unit-testable
in Node while the browser-only Web Audio glue stays thin:

- `src/render/music.ts` (pure, no DOM): describes the looping theme as timed
  notes. An anthemic i–VI–III–VII minor progression (Am–F–C–G) with four
  voices — octave-pulse `bass`, fast 16th-note `arp`, a written `lead` melody,
  and a sustained `pad`.
  ```ts
  type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';
  type MusicVoice = 'bass' | 'arp' | 'lead' | 'pad';
  interface MusicNote { beat: number; duration: number; midi: number;
                        wave: Waveform; gain: number; voice: MusicVoice; }
  interface Song { bpm: number; lengthBeats: number; notes: readonly MusicNote[]; }
  function midiToFreq(midi: number): number;
  function buildSong(): Song; // deterministic, returns notes sorted by beat
  ```

- `src/render/sfx.ts` (pure, no DOM): synthesized effect recipes as frequency
  sweeps, plus the event→effect routing so attacks are audible.
  ```ts
  interface SfxSegment { wave: Waveform | 'noise'; startFreq: number;
                         endFreq: number; duration: number; gain: number;
                         delay?: number; }
  interface SfxSpec { segments: readonly SfxSegment[]; }
  const SFX: Record<string, SfxSpec>;
  function sfxForEvent(event: GameEvent): string | undefined; // e.g. enemyHit->'hit'
  ```

- `src/render/audio.ts` (browser-only glue): a `GameAudio` facade wrapping a
  Web Audio `AudioContext`. `resume()` (from a user gesture, since browsers
  block autoplay), `handleEvents(events)` → plays the routed SFX, `update()` →
  look-ahead schedules the next slice of the music loop, `toggleMute()`. Wired
  in `main.ts`: resumed on first input, `handleEvents`/`update` called each
  render tick.

## Invariants tested

- `midiToFreq(69) === 440`, and +12 semitones doubles the frequency.
- `buildSong()` is deterministic (two calls deep-equal) and its notes are
  sorted by `beat`, every note falls within `[0, lengthBeats)`, and all four
  voices are present.
- Every note's `[beat, beat+duration)` lies within the loop, and gains are in
  `(0, 1]`.
- `sfxForEvent` routes attack/combat events (`enemyHit`, `attackMissed`,
  `cardPlayed`, `bonusCardPlayed`, `perfectDefense`, `playerHit`,
  `playerHealed`, `enemyDefeated`, `playerDefeated`) to a `SFX` key that
  exists, and returns `undefined` for purely cosmetic events.
- Every active card id in the catalog has an SFX routing when played.
- Every `SFX` spec has ≥1 segment and all segment durations/gains are positive.

## Out of scope

- No audio assets/files: everything is synthesized live via oscillators, so
  nothing is fetched or bundled.
- No mixing UI beyond a mute toggle; no per-voice volume controls.
- The Web Audio engine in `audio.ts` is browser-only and not unit-tested (it
  has no headless surface); its behaviour is covered by the pure modules it
  reads from.
