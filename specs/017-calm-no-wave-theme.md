# 017 — Calm "no-wave" theme + adaptive music

## Problem

In the wave-mode combo prototype the arena starts empty and stays quiet
between waves, but the same driving combat loop (`buildSong`, spec 014) plays
the whole time — the lull before/after a wave sounds identical to the fight.
The game wants a second, calmer track that plays while no wave is on screen,
in the same melodic retro-arcade voice as the combat theme, and the music
should cross over to the combat theme the instant a wave is present. The new
tune is a transcription of an original fingerstyle guitar recording (D natural
minor: theme `F D F G F | D F E G F | D D F E | E D E D`, over a
Dm–F–C–Gm loop), rebuilt with the same oscillator palette. Like all audio it
is pure presentation: it reads render state and never touches the sim or
determinism.

## Shape

`src/render/music.ts` stays pure (no DOM/Web Audio) and grows a second song
plus the phase decision, sharing one parameterized assembler with the combat
theme:

```ts
type MusicPhase = 'combat' | 'calm';
function buildSong(): Song;      // combat theme, unchanged (Am–F–C–G, 116bpm)
function buildCalmSong(): Song;  // guitar-derived calm theme (Dm–F–C–Gm, ~96bpm)
// Pure rule: calm while the arena is empty, combat once any enemy is present.
function musicPhaseForEnemyCount(enemyCount: number): MusicPhase;
```

`src/render/audio.ts` (browser-only glue) holds both songs, each on its own
look-ahead loop cursor and its own music sub-bus, and cross-fades between the
two buses:

```ts
class GameAudio {
  setMusicPhase(phase: MusicPhase): void; // ramps the two music buses over ~0.7s
}
```

`src/render/combo/main.ts` derives the phase each frame from
`state.combat.enemies.length` via `musicPhaseForEnemyCount` and calls
`setMusicPhase`; both loops are always scheduled so switching is a gain
cross-fade with no seam or cursor reset.

## Invariants tested

- `buildCalmSong()` is deterministic (two calls deep-equal), notes are sorted
  ascending by `beat`, every note's `[beat, beat+duration)` lies within
  `[0, lengthBeats)`, gains are in `(0, 1]`, and all four voices
  (`bass`, `arp`, `lead`, `pad`) are present.
- The calm theme is a distinct song from the combat theme: different `bpm`
  and a different lead melody (not deep-equal to `buildSong()`).
- The calm lead is in D minor — every `lead` note's pitch class lies in the
  D natural-minor scale {D, E, F, G, A, A#/Bb, C}.
- `musicPhaseForEnemyCount(0) === 'calm'` and any positive count is `'combat'`.

## Out of scope

- No new audio assets/files: the calm theme is synthesized live from note
  data, exactly like the combat theme (the guitar take is the source of the
  transcription, not a bundled sample).
- The Web Audio cross-fade in `audio.ts` remains browser-only and unit-tested
  only through the pure modules it reads (spec 014's boundary is unchanged).
- No mixing UI beyond the existing mute toggle; the phase is driven purely by
  wave presence, not by any player control.
