# 234 — The landings that were a debug ring

## Problem

Five skills draw `scene.addEffect`'s fallback: a flat `CircleGeometry` in
`PALETTE.torchCore` at opacity 0.4, laid on the ground for half a second. Ember
Toss, Rime Touch, Blight, Arc Lash and Scorched Earth — a level-4 rare, three
level-5s and a level-6 exceptional — all land as the same orange disc.

It is not a gap so much as an accident of naming. The server has sent
`${ability.id}.impact` and `.self` since spec 062, and `addEffect` has always
checked `system.has(effectId)` before falling back. Until spec 218 the registry
held **none** of the 46 ids it can send, so every ability in the game took the
fallback; spec 233 authored the first one (`skill.whirlwind.impact`) and proved
the seam works. This is the other five.

## Shape

**No call-site change, anywhere.** The whole of this spec is five entries in
`vfx/library.ts` under ids that are already being sent.

Four are `brushExplosion` recoloured, and that is a rule rather than a shortcut.
`docs/vfx-plan.md` asks for a critical to be *louder in the same language rather
than a new one*, and `burst()` already draws eight damage types as one crystal
in eight ramps. A frost skill arriving in its own private vocabulary would read
as a different game's effect. Every ramp is the one spec 215 authored for that
element's affliction, so a body catching fire from an Ember Toss and the toss
itself are the same orange.

| Id | Built from | Reads as |
|---|---|---|
| `skill.emberToss.impact` | `brushExplosion`, default palette, r70 | the reference blast |
| `skill.rimeTouch.impact` | ice ramp, no smoke, thin shards, r96 | frost |
| `skill.blight.impact` | decay ramp, no smoke, wide and slow, r110 | rot |
| `skill.arcLash.impact` | bolt ramp, violet, r82, 22 ticks | lightning |
| `skill.scorchedEarth.self` | fire, `SCORCHED_EARTH.radius` | the ground catching |

Two of those numbers are not art decisions:

**Scorched Earth's radius is imported**, the way `aura_scorched`'s already is.
It is not decoration around the mechanic — it is where the fire is about to be,
and a burst reaching past the field would promise ground that is safe.

**Arc Lash is a burst, not the lane it should be.** The effect message carries
no rotation (`sim/types.ts`), and `landArea` sends a line shape's cue at the
caster's own feet — so there is no bearing to lay 300 units of lane along. A
lane pointing the wrong way is worse than a burst pointing nowhere. Spec 235
puts a rotation on that message and this grows a lane.

## What the sheet decided, three times over

Every number below came off `preview-brush-vfx.ts` rather than out of a head,
and each was wrong first. This is recorded because the failure mode is specific:
all five passed every headless assertion in every version.

**A stroke's length is a fraction of the radius, so reach and picture are not
the same number.** Arc Lash at the ability's own 150 with `strokeLength` to 1.9
made marks **285 units long** — a cream splash the height of the frame. Rime
Touch at 140 read as a wave rather than as frost. Both are authored well inside
their ability's reach now.

**Spec 215's ramps were authored to be a thin cling on a body, and at blast
scale the dark end is mud.** Blight with `smokeDark` soot and ten masses grew a
near-black shape that swallowed the rot underneath; recolouring the soot and
halving the smoke was not enough, because the problem was the ramp at that size
rather than the amount. It carries on its pale end now with no smoke at all —
which is also the honest picture, since `landBlast` resolves Blight once and
nothing lingers there.

**Two skills in the same colour are two skills a player cannot tell apart.** Arc
Lash's second version put `boltPale` on the two layers that carry the mass and
came out the same pale blue as Rime Touch, two rows up the same sheet. White
core, violet body now; nothing else in the table is violet.

## Invariants tested

- Every id in the landing table exists in the compiled registry, so
  `scene.addEffect` takes the authored branch rather than the fallback.
- Each names an ability that exists, and the suffix matches how that ability
  lands: `.impact` for a row whose landing sends one (`area`, `ground`, a
  bursting `projectile`), `.self` for a `self` row.
- `skill.scorchedEarth.self` is **not** in `REDUNDANT_SERVER_EFFECTS` — the set
  that would drop it before it reached the registry, and where the two self-heals
  correctly sit because their blow already draws them.
- Scorched Earth's burst is authored at `SCORCHED_EARTH.radius` and follows it,
  asserted against the imported constant rather than against 130.
- No two landings share a palette, which is the sheet's own finding turned into
  a check: the failure was two effects in one blue, and it is not visible in any
  other assertion.

## Out of scope

- **A lane for Arc Lash, and a cone for Acid Spray.** Both need a rotation on
  the effect message. Spec 235.
- **Acid Spray at all.** `landCone` emits no effect event, so unlike these five
  there is no id being sent to author under; it needs the server change first.
- **A long-lived Blight cloud.** It would draw a standing hazard over ground
  that stopped being dangerous the instant it landed. If Blight becomes a
  point-anchored field — the fourth shape `sim/aura-field.ts`'s header names and
  the game does not have — this grows a variant that is honest about it.
- **The remaining ~40 ids the server can send.** Every non-skill ability still
  takes the fallback ring. They are content decisions one at a time, and this
  spec covers the skills a player equips.
