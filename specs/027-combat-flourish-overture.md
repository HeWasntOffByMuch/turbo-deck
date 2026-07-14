# 027 — Combat flourish overture (delayed fast melody)

## Problem

The combat "wave" theme (`buildSong`, spec 014) plays at one intensity for the
whole fight — it opens at full tilt and never builds. We want the wave song to
grow: after the fight has been running for a short stretch (~10s), a faster,
brighter melodic line joins in over the existing loop — quick 16th-note runs in
the same A-minor voice, in the spirit of a jazzy piano overture — so a sustained
wave feels like it's escalating rather than looping flat. Like all audio this is
pure presentation: it reads render state, never the sim, and never touches
determinism.

## Shape

`src/render/music.ts` (pure, no DOM/Web Audio) grows a fifth voice on the combat
theme only, plus the arrangement constant for how long the engine holds it back:

```ts
type MusicVoice = 'bass' | 'arp' | 'lead' | 'pad' | 'flourish';
// Seconds of continuous combat before the flourish voice enters.
const FLOURISH_ONSET_SECONDS = 10;
```

The combat `SongSpec` gains optional `flourishBars` / `flourishWave` /
`flourishGain`; the shared assembler emits `flourish`-voice notes when they are
present. The calm and death themes leave them unset, so they have no flourish.
The flourish notes live in the combat `Song` at their natural onsets like every
other voice — the *delay* is an engine concern, not baked into the note data.

`src/render/audio.ts` (browser-only glue) records when the combat phase last
became active and, when topping up the combat loop's look-ahead queue, skips
`flourish` notes whose scheduled time is less than `FLOURISH_ONSET_SECONDS`
after that moment. Leaving combat resets the timer, so each fresh wave earns its
build-up again. No new bus, no cross-fade change: the flourish rides the
existing combat sub-bus.

## Invariants tested

- The combat theme carries a `flourish` voice; the calm and death themes carry
  none.
- The flourish is faster than the lead: its shortest note is shorter than the
  lead's shortest note.
- The combat song stays well-formed with the extra voice: notes still sorted by
  onset, every `[beat, beat+duration)` inside `[0, lengthBeats)`, gains in
  `(0, 1]`, and the four core voices (`bass`, `arp`, `lead`, `pad`) all present.
- `FLOURISH_ONSET_SECONDS` is a positive number of seconds.

## Out of scope

- No new audio assets: the flourish is synthesized from note data like every
  other voice.
- The 10s hold-back lives in `audio.ts` (real-time gating) and stays
  browser-only, unit-tested only through the pure `music.ts` values it reads —
  spec 014's audio boundary is unchanged.
- No player control over the flourish; it is driven purely by combat elapsed
  time. No change to the calm/combat/death cross-fade from specs 017/020.
