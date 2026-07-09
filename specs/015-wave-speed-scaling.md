# 015 — Wave speed & attack-speed scaling

## Problem

Waves already scale enemy health and attack damage (spec 014), but movement
speed and attack cadence stay fixed forever. Combined with the shorter
time-to-kill enemies now have, later waves feel no more urgent than the first:
enemies close in and swing at the same rate whether it's wave 1 or wave 10.
Add two more per-wave escalation dimensions so deep waves apply real pressure —
enemies that chase faster and attack more often — without touching the base
(wave-1) values, which stay exactly as they are today.

## Shape

Mirrors the existing `healthMult` / `damageMult` wave machinery in
`src/sim/combat.ts`, baked per-enemy at spawn so it is deterministic and does
not recompute from wave number after the fact.

- `constants.ts`: `WAVE_SPEED_GROWTH`, `WAVE_ATTACK_SPEED_GROWTH` — per-wave
  compounding fractions, wave 1 = ×1 (same convention as the health/damage
  growth constants).
- `SpawnOpts`: add `speedMult` and `attackSpeedMult` (both default 1 for the
  ambient grazer spawn).
- `EnemyState`: optional `speedMult?` / `attackSpeedMult?` overrides, baked at
  spawn from the wave opts; both fall back to 1 when absent (same pattern as the
  existing optional `attackDamage`), so hand-built test enemies are unaffected.
- Wave spawner sets `speedMult: 1 + WAVE_SPEED_GROWTH * (waveNumber - 1)` and
  `attackSpeedMult: 1 + WAVE_ATTACK_SPEED_GROWTH * (waveNumber - 1)`.
- Application: hunting homing speed is multiplied by `speedMult`; the
  idle/windup/recovery phase durations are divided by `attackSpeedMult` (a
  higher multiplier = shorter phases = faster attacks), stacking with the
  existing `enemySpeedMultiplier` mod and global slow.

## Invariants tested

- Wave 1 enemies keep base move speed and base phase durations (no scaling at
  ×1), so existing timing-dependent tests stay green.
- A later-wave enemy homes toward the player faster than a wave-1 enemy of the
  same type over the same number of ticks.
- A later-wave enemy completes its idle→windup→recovery cycle in fewer ticks
  than a wave-1 enemy of the same type.
- Determinism: replaying `(seed, inputs)` that spawns waves yields identical
  state every run.

## Out of scope

- Retuning health/damage growth or the base per-type stats.
- Scaling the ambient grazer spawner or graze wander speed — only hunting wave
  enemies escalate.
- Renderer telegraph timing already reads the fixed `ENEMY_WINDUP_TICKS`
  constant and does not account for per-enemy scaling; tightening that cosmetic
  readout is left for later.
