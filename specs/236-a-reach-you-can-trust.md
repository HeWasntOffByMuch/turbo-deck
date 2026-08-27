# 236 — A reach you can trust

## Problem

Three reports, and two of them are the same mistake in different places: **the
number a player is shown and the number the game acts on were not the same
number.**

**Clicking inside a skill's own range ring walked the body forward first.**
`castOrder` decided "throw it now or walk" on `HOLD_FRACTION`, which is 0.9 — so
the outer tenth of every skill's range was ground a player could stand on, click
within their own drawn ring, and be walked forward from. On Blight's 380 that is
38 units.

**Hovering Whirlwind drew no ring at all.** The preview used `ability.range`,
and a caster-centred area states `range: 0` — there is nothing to be out of
range of. Its reach is the 160 in `area.radius`. So the skill whose whole
question is "is that thing close enough" was the one that answered nothing.

**Frostbite's paint was the largest in the table.** Its base `clingSize` of 0.66
was wider than poison's, bleed's and corrosion's *heavy* tiers, and its heavy at
0.82 was above everything — so a body carrying frostbite read as carrying more
affliction than a body carrying any other, which is a claim about severity that
no rule here makes.

## Shape

**A placed cast and a named one want different margins.**

```ts
// world/aim.ts
interface CastOrderInput { readonly castLead: number }
const hold = named ? reach * HOLD_FRACTION : Math.max(0, reach - input.castLead);
```

`HOLD_FRACTION` is a *chase* constant and its own doc says so: it exists because
a chase stops within `ARRIVE_EPS` of its destination, so a body whose cast
threshold equalled that destination parks a few units short and stands there —
and because a target that shuffles must not flip the decision every tick.

Neither is true of a patch of ground. It does not move, and the destination a
chase heads for is `STANDOFF_FRACTION` of the reach, comfortably inside the full
one, so nothing parks. What is left is the only real reason a placed cast needs
any margin: the client asks from its **prediction** and the server checks against
the last input it **applied**, so a request sent from exactly the edge can be
refused for drift the player cannot see.

That is `pickupLead`'s problem exactly, and it takes `pickupLead`'s answer — a
distance a body travels in a round trip, floored at a broadcast interval — rather
than a fraction of the range. A named order keeps `HOLD_FRACTION`, because its
mark really does move.

**A reach is not always a range.**

```ts
// world/aim.ts
export function effectiveReach(ability: AbilityDefinition): number {
  return Math.max(ability.range, ability.area ? areaReachOf(ability.area) : 0);
}
```

`areaReachOf` is the server's own answer to what `spellRangePct` scales,
imported rather than restated so the ring and the landing cannot drift. The
larger of the two, because a shaped skill can have both — Arc Lash is a 300-unit
lane thrown from a body with a 300-unit range, and Blight is a 110-radius blast
placed anywhere inside 380.

Only the **hover** uses it. A live aim keeps `range`, because there the ring
means "the confirm will be a walk first" and walking is measured against exactly
the number `startCast` gates on.

**Frostbite sized back into the band.** `clingSize` 0.66 → 0.58 (between shock's
0.54 and burn's 0.6) and heavy 0.82 → 0.68 (between bleed's 0.66 and corrosion's
0.7); heavy `cling` 34 → 28, which is bleed's step exactly.

What is deliberately **not** changed is that its tier crosses on *elapsed* rather
than on stacks. That looks like escalation because it is one: frostbite is the
only row in `data/damage-over-time.ts` with a real ramp — `rampPerSecond: 0.35`,
`rampCap: 3`, so it triples over its 481-tick life — and the paint saying so is
that row's whole design (spec 215). The report was about the size, and the size
is what moved.

## Invariants tested

- A placed cast at 95% of its range casts, and does not walk.
- One genuinely out of range still walks.
- The margin is the lead it was given and no more: a point one unit inside
  `reach - lead` casts and one unit outside does not.
- A **named** order at 95% of reach still walks, because its mark moves.
- `effectiveReach` answers a caster-centred area with its radius, and a ranged
  skill with its range.
- No skill that reaches anywhere answers zero — asserted over the whole table, so
  a future row that states its reach only in `area` cannot go back to drawing
  nothing.
- No affliction's **base** tier out-sizes every **heavy** tier, and frostbite is
  off the top of the table at both. Its step up is no larger than the largest of
  its siblings'.

## Out of scope

- **The hold band for a named order.** It is defensible where it is — the mark
  moves — but 0.9 of reach is a wide place to stop, and whether a chase should
  close further is a feel question with `STANDOFF_FRACTION` beside it.
- **Drawing the shape on hover.** Still reach only; a hover has no aim point.
- **Frostbite's ramp itself.** Whether tripling over eight seconds is the right
  curve is a balance question for `npm run balance`, not a paint one.
