# 235 — An aimed landing, and a reach you can see

## Problem

Four things, and the first three are one thing: **a cue that cannot be aimed
cannot be the shape it is a cue for.**

The effect message carried no bearing. So `landArea` sent a lane's cue at the
caster's own feet with nothing to lay it along, and `landCone` — which has
computed `dirX/dirY` since spec 062 — raised no event at all. Arc Lash, a
300×60 lane, was drawn as a violet ball at the caster; Acid Spray, the one
ability in the table that *is* a shape, had no picture of any kind, not even the
debug ring, because there was no id being sent to fall back from.

Two more the sheet was wrong about in spec 234 and only the game showed:
Scorched Earth's smoke was a column taller than the body that lit it, and Rime
Touch read as a **water splash**. That last one is a fact about the composition
rather than the ramp: `brushExplosion` makes a few *dominant* strokes into
lobes, and a few big pale sheets is what a splash looks like.

And the fourth: **hovering a skill showed nothing**. The range ring exists but is
laid only for a live aim, and only when the placement is out of range — so the
one question a player asks before committing, *how far does this reach*, had no
answer anywhere in the interface.

## Shape

**A bearing on the cue.**

```ts
// sim/types.ts  -- optional: absent is the "no bearing" a radial cue has always had
{ kind: 'effect'; /* … */ readonly rotation?: number }
// net/messages.ts -- zero for a radial cue, so no existing picture moved
interface EffectMessage { readonly rotation: number }
// scene.ts
addEffect(id, x, y, radius, durationTicks, rotation = 0): void
```

`landArea` sends one for any shape that is not a circle, measured to
`cast.targetX/Y` rather than to `caster.facing`: spec 065 turns a body before its
wind-up and holds the aim live to the commit, so by the landing they agree — and
the aim is the one of them still right when the turn was interrupted.
`landCone` sends one unconditionally, because a spray that hit nothing still
happened.

**Two builders**, and each exists because an existing one gets a specific thing
wrong.

`brushLane` — marks strung *along* a bearing. Both other compositions are
**centred** on where they are played (`brushExplosion` throws from a point,
`brushSwing` lays around an arc), and a lane is not: it starts at the caster and
runs away from them. Nodes are offset down +X, alternate ones pushed to opposite
sides of the centre line — a *kink*, which cannot come from a sampler because it
has to alternate; a random offset per node is a wobble, and a wobble reads as an
effect that could not decide where to go. Each node fires a tick after the last,
so the run arrives end to end.

Its `cone` mode turns the node offsets out from the origin instead of pushing
them sideways. One builder rather than two, because a cone and a lane differ in
exactly that: *where the nodes are*. What is thrown at each is identical.

`brushShards` — many small marks, radially even, that **fall**. It has no lobe,
and that is the point: `brushExplosion`'s "asymmetry has to be composed" argument
is right about a blast and wrong about a shatter, because ice breaking has no
side it favours. Real gravity, where a blast's is nearly off — fire goes up and
burns off, shards go out and come down.

**The hover.** `ActionBarScreen` records which slot the cursor rests on and
announces *changes*, not levels: `pointerMoved` fires on every mouse move, and a
callback per move would re-lay a ground decal several times a frame while the
cursor sat still. It reports an **index**, and the mount turns it into an ability
through the same `abilityForSlot` the press uses — so a hover and a click cannot
disagree about what is in slot 3.

`AimIndicator.preview` is what the scene reads, and the rule it adds is the
*opposite* of the live one: a preview draws the reach **always**, where a live
aim draws it only when out of range. Both follow from what the ring means. On a
live aim it is a warning — the confirm will be a walk before it is a blow — and
drawing it the rest of the time would be a permanent ring under the player. On a
hover it is the entire question. A preview draws no shape and no unit ring: the
cursor is over the interface, not the world, so there is no aim point, and a
wedge laid along wherever the mouse last was in the world answers a question
nobody asked.

A hover ranks below a pending aim and a standing order, because those are
decisions and this is a look.

## Invariants tested

- An `Effect` message round-trips its bearing at a non-zero, non-round value.
  This message had **no codec fixture at all** before this spec, which is how a
  field added to it could have gone untested.
- `skill.acidSpray.impact` is in the registry — the cue this ability has never
  had.
- The lane's nodes are all ahead of the origin, reach most of the row's own 300,
  and sit on **both** sides of the centre line. A ruled line is a laser.
- The cone's nodes point in different directions and the lane's all point one
  way, which is the whole difference between the two modes.
- Frost shards are longer than 20 units — the correction from "water" went
  straight past "shards" into a scatter of specks the sheet could barely show.
- Every shard emitter is a `circle`, never a `fan`: no lobe.
- Shards fall, asserted as gravity below −500, where a blast's is near zero.
- The bar reports entering and leaving a slot **once each**, and reports the slot
  it entered.
- Hovering emits **no request**: `mount-presentation.test.ts` keeps hovers in
  their own sink, and asserts that sink non-empty — so the emptiness of
  `requests` is evidence about a driven interface rather than an untouched one.

## Out of scope

- **A lane that follows the terrain.** `brushLane`'s nodes are placed at a fixed
  lift, so a 300-unit run across a hillside sits above the ground at one end.
  The honest fix is `ground-decal.ts`'s, which is a different vocabulary from
  paint in the air, and no skill in the table runs far enough for it to show yet.
- **A preview for the shape as well as the reach.** It needs an aim point, and a
  hover has none. If it is ever wanted, the caster-centred circles (Whirlwind,
  Rime Touch) are the ones where it would mean something, and `aimShape`
  deliberately returns `none` for them today.
- **The remaining ~40 non-skill `.impact` ids**, which still take the fallback
  ring. Content decisions one at a time.
