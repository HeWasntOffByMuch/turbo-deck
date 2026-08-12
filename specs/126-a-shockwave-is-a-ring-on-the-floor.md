# 126 — A shockwave is a ring on the floor, and counts are tunable

## Problem

Two things, both about how much of an effect there is.

**The counts are not editable.** `EMITTER_FIELDS` generates the whole parameter
panel from a table, and `emission` is in `UNEDITED_KEYS` — declared deliberately
unedited because it is a tagged union whose shape changes with its kind. The
consequence is that the one number a person most wants to move while tuning, *how
many particles*, is the one number the tool will not let them move. Every other
knob is there.

**The shockwave is a sprite.** `shockwave_ring` is a single dithered ground quad
that grows. The reference is a **combined shockwave and explosion**: a crystal
star at the centre, streaks laid flat along the ground radiating out of it, a
crater of scattered rock, and a bright ring on the floor expanding past all of
it with a softer halo behind. Spec 125 built four of those five; the ring is
missing, and it is the part that says *shockwave* rather than *explosion*.

## Shape

**One more mesh** (`vfx/meshes.ts`, pure): `ringMesh(width, segments)` — a plain
flat annulus in the XZ plane at unit outer radius, lying on the ground and
oriented exactly, like the sigil. Not `rune-ring`: that one has bands and marks,
which is a symbol; this is a wavefront.

**`burst({ ring: true })`** adds two of them — a bright leading edge and a wider,
fainter half-step behind it — expanding past the fan and outliving it. Additive,
because a wavefront is light rather than an object.

**`shockwave_ring` is re-authored** as `burst({ flat: true, ring: true, … })` in
the reference's frost colours: the same crystal, the same thrown rock, the same
flat streaks, plus the wave. The id does not change.

**Emission becomes editable**: `emission.kind`, `emission.count`,
`emission.perSecond`, `emission.delayTicks` and `emission.overTicks` join the
field table, and `emission` leaves `UNEDITED_KEYS`. A row that does not apply to
the current kind is inert rather than hidden — the panel is generated from a flat
table and a conditional row is a second mechanism for one saved click.

**And the library gets denser.** The shipped bursts were authored conservatively
against a budget that turned out to have room; spike, shard and chunk counts go
up across the family.

## Invariants tested

- **The ring is flat and lies on the ground**: every vertex at y = 0, normals
  +Y, outer radius exactly 1, and a hole in the middle — an annulus, not a disc.
- **The wave outlives and outgrows the fan**: in a burst with `ring`, the wave's
  lifetime and its peak size both exceed the spikes'.
- **`ring` is opt-in**: a burst without it has no wave emitter.
- **The shockwave is the combined thing**: `shockwave_ring` has the crystal, the
  flat streaks, the rock and the wave, and its streaks emit in the ground plane.
- **Every emission field is reachable**: the panel's coverage test now passes
  with `emission` removed from `UNEDITED_KEYS`, and each emission key a shipped
  emitter uses has a row.
- **Editing a count round-trips**: `effectFromJson(effectToJson(edited))` is
  unchanged for an effect whose emission was edited.

## Out of scope

- A global "more particles" multiplier. The budget already scales counts down
  under pressure (`INTENSITY_SCALE`), and a second global that scales them *up*
  would fight it. Density is per-effect config, which is the rule the whole arc
  is built on.
- Conditional rows in the parameter panel.
- Scorch decals, still.
