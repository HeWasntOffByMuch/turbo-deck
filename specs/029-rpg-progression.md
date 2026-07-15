# 029 — RPG progression: three stats, levels, and a right-side control panel

## Problem

The spell game has no character growth: every run plays the same regardless of
how far you get. Add a simple RPG spine — three stats you raise by levelling —
and move the controls out of the way so the growth (and everything else) reads.

## Shape

Three stats on `PlayerState` (all start at 0), plus `level` (starts 1) and
`statPoints` (unspent):

- **Strength** → maximum health (`HP_PER_STRENGTH` per point).
- **Agility** → armor (incoming-damage reduction, `ARMOR_PER_AGILITY` per point),
  attack speed (a shorter attack animation, `ATTACK_SPEED_PER_AGILITY`), and turn
  rate (`TURN_RATE_PER_AGILITY` deg/s per point).
- **Intelligence** → all spell damage (`SPELL_DAMAGE_PER_INTELLIGENCE` per point).

Levelling: **one wave is one level** — clearing a wave (its last enemy dies)
grants a level and `STAT_POINTS_PER_LEVEL` point, and emits a `leveledUp` sim
event. (The existing heal-to-full on wave clear is kept.)

Allocation flows through input, deterministically: `InputFrame.allocateStat`
(and `SpellInput.allocateStat`) = `'strength' | 'agility' | 'intelligence'`.
While a point is banked, the sim spends one on that stat this tick; a Strength
point also heals for the new HP. The sim applies the effects directly from the
stored stats — max health on allocation, turn rate + attack-anim length + armor
reduction per tick, and a spell-damage multiplier at cast resolution.

UI: all **controls move to a panel on the right of the canvas** — status line,
a Stats panel (level, unspent points, STR/AGI/INT with `+` buttons that describe
what each scales), Spawn Wave / Character / Mute buttons, wave-reward choices,
and the hint. The **card hand stays in a row below the canvas**.

## Invariants tested

- `allocateStat` spends exactly one banked point and raises the chosen stat;
  it is a no-op with no points banked.
- Strength raises `maxHealth` by `HP_PER_STRENGTH` and heals for the gain.
- Intelligence scales spell damage (a cone hits for
  `round(base * (1 + int * SPELL_DAMAGE_PER_INTELLIGENCE))`).
- Agility armor reduces incoming slam damage; Agility attack speed makes an
  aligned attack fire sooner.
- Clearing a wave increments `level`, adds a stat point, and emits `leveledUp`;
  the whole thing replays deterministically from `(seed, inputs)`.

## Out of scope

- Persisting progression across runs / a save system.
- Re-speccing or refunding spent points.
- Base stat values above 0, or per-character starting stats.
- Balancing the per-point scalars — the constants are first-pass values.
- Stat effects beyond the four listed (e.g. Strength melee damage, crit, etc.).
