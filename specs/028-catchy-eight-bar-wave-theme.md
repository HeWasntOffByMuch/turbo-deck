# 028 — Longer, catchier eight-bar wave theme

## Problem

The combat "wave" theme (`buildSong`, spec 014) is a tight four-bar loop
(Am–F–C–G, ~8s) whose lead fills every beat wall-to-wall. It grooves but it
doesn't *hook* — there is no second section to answer the first, and no rests, so
after a few passes it reads as a texture rather than a tune. We want it to feel
like a classic platformer overworld theme: a longer A/B form, a singable
syncopated melody, and deliberate pauses (the melody stops and lets the groove
breathe) that give the line its bounce. This is pure presentation — note data in
`music.ts`, no sim, no determinism impact.

## Shape

`src/render/music.ts` stays pure. Only the combat theme's data grows; the shared
assembler, `SongSpec`, and every other theme are untouched:

- `COMBAT_PROGRESSION` extends from 4 to **8 bars**: an A section (Am–F–C–G) and
  a contrasting B section (Am–F–Dm–E) whose **E major** closes on the raised
  leading tone (G♯), pulling the ear back to the Am downbeat on the loop.
- `COMBAT_LEAD_BARS` is rewritten across all 8 bars as a **syncopated** melody
  (notes onset off the beat, e.g. at .5) with **rests** — at least one bar-window
  where the lead falls silent and the bass/arp/pad carry the groove, including a
  hold-then-stop before the loop restarts.
- `COMBAT_FLOURISH_BARS` extends to 8 bars so the delayed overture (spec 027)
  tracks the new B section too.

The bass, arp, and pad are generated per bar from the chord, so they follow the
longer progression automatically; the loop length (`lengthBeats`) doubles to 32.
No `audio.ts` change — a longer combat `Song` schedules exactly as before.

## Invariants tested

- The combat theme is longer: `lengthBeats === 32` (8 bars), and it is longer
  than both the calm and death themes.
- The combat lead is syncopated: at least one `lead` note onsets off the beat
  (`beat % 1 !== 0`).
- The combat lead breathes: somewhere in the loop there is a gap of at least one
  full beat between consecutive `lead` onsets (a rest/pause).
- All existing combat-theme invariants still hold: well-formed (sorted, in
  bounds, gains in `(0,1]`, four core voices present), a `flourish` voice the
  calm/death themes lack, and the flourish's shortest note shorter than the
  lead's.

## Out of scope

- No change to the calm or death themes, the assembler, or `audio.ts`.
- No new voices, buses, or audio assets; this is a rewrite of existing combat
  note data only.
- No tempo/instrument (waveform) changes — the hook comes from pitch, rhythm,
  and rests, not a new sound.
