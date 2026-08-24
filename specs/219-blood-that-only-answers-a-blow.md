# 219 — Blood that only answers a blow

## Problem

Three things draw a blood spatter that should not, and all three are the same
mistake seen from different sides: **the picture of a blow is being played for
things that are not blows.**

- **A heal that restored nothing throws blood at the healer.** `landSelf`
  reports every restoration as a hit against yourself with negative damage
  (spec 157), and it emits that event whether or not anything was restored --
  so drinking a flask at full health sends `damage: -0`. `effectsForBlow` tests
  `damage < 0`, and `-0 < 0` is **false** in JavaScript, so the heal falls
  through into the blow path and paints `blood_hit_brush` on the drinker's
  chest, with a `0` floating off them. `collectMote` two files over already
  guards this with `if (restored > 0)`; `landSelf` never did.
- **Every affliction pulse draws a full impact.** A pulse is a `hit` event
  (spec 190) and `dispatchEvents` broadcasts every one of them, so eight beats
  of Poison are eight brush hits, eight crit flashes if the row ever asks for
  one, and eight lots of debris -- from an attacker who walked away seconds
  ago, aimed along a bearing that is now meaningless. Spec 215 painted the
  afflictions properly; nothing took the *blow's* picture back off them.
- **The mark itself is too big.** `blood_hit_brush` is authored at `scale: 26`,
  and the dominant stroke is `scale * 3.1` world units long -- **80 units**
  against a body of 10 units' radius. Four body-widths of paint per ordinary
  swing.

## Shape

`CombatFlag.Periodic = 1 << 3`, a fourth bit in the byte
`CombatResultMessage.flags` already carries. `ServerSimEvent`'s `periodic` stops
being sim-only; `dispatchEvents` writes it into the flags and `view.ts` reads it
back.

```ts
// src/render/iso3d/world/vfx-wire.ts
export interface CombatFacts {
  // ...
  /** This damage came from an affliction rather than from a blow (spec 190). */
  readonly periodic: boolean;
}
```

`effectsForBlow` gains two refusals before anything else, both returning no
requests at all:

- `facts.periodic` — the affliction's own paint (spec 215) is the picture.
- a heal that restored nothing — `Object.is(facts.damage, -0)`, which is the
  sign test the module's own comment claims to be making.

And on the server, `landSelf` emits its `hit` event only when the health bar
actually moved, which is what `collectMote` has always done.

`blood_hit_brush` drops to `BLOOD_HIT_SCALE = 17`, and `blood_hit_brush_heavy`
is derived from it by `HEAVY_HIT_SCALE = 1.4` rather than authored beside it, so
a killing blow stays the same language read louder rather than becoming a
different effect the next time one of them moves.

How small was **measured, not judged**. `preview-brush-vfx.ts` photographs the
same hit from six camera bearings and requires the thinnest to keep 40% of the
fattest one's ink, which is the check that says a mark seen edge-on is still
readable. That ratio falls faster than the mark does -- a pixel counts as ink
only past a fixed difference from the ground, so shrinking deletes the
already-marginal edge-on view rather than thinning it: 26 keeps 57%, 20 keeps
53%, 17 keeps 46%, and 15 keeps **36%** and fails, along with the
seed-variation check. 17 is the smallest size that stays green, at 40% of the
painted area of 26.

## Invariants tested

- A `hit` event whose `periodic` is set arrives with `CombatFlag.Periodic` set,
  and one without it does not; the flag round-trips the codec.
- `effectsForBlow` returns **nothing** for a periodic blow — no blood, no
  damage-type flash, no crit, no debris, no `death_blood` — at every gore level
  and for every combination of killed/critical/blocked.
- A heal that restored nothing (`-0`) returns nothing, at every gore level.
- A heal that restored something still draws `heal_restore`, unchanged.
- A blow that did nothing (`+0`) is still a blow and still draws blood — the
  rule spec 157 stated, preserved by the sign test rather than by accident.
- `landSelf` emits no `hit` event when the target was already at full health,
  and still emits one when it was not.
- The blood hit stays inside the 0.25–0.8s window, stays one dominant mark with
  company, and `blood_hit_brush_heavy` stays louder than `blood_hit_brush` in
  the same shapes — all of spec 159's composition assertions hold at the smaller
  size, because they are ratios.
- The dominant mark is under 60 world units and over 24: small enough not to be
  laid across the body, large enough still to be a gesture rather than a fleck.
- `preview-brush-vfx.ts` passes every check it had — no stipple, mass in a few
  big pieces, readable from six bearings, six seeds that differ and differ by
  similar amounts.

## Out of scope

- **The floating number stays.** A pulse still reports its damage and still
  moves the health bar; what it loses is the blow's *picture*. A number that
  vanished would make an affliction invisible except as a health bar falling on
  its own.
- **The health bar still reacts, kick included.** `HealthFlashes` reads
  replicated health per frame and has no idea what took it, which is what makes
  the white chunk a *measurement* rather than an event — and a pulse genuinely
  took the health. The kick beside it is described as a contact (spec 146) and a
  pulse is not one, so there is an argument for suppressing it; taking it would
  mean threading "what caused this drop" into a class deliberately built to read
  only the bar, and leaving the bar inert under a Poison is worse than a bar
  that twitches. Named here rather than left as an omission.
- **Kill credit stays.** A periodic blow that kills is still a kill, still
  awards experience and still lands the reward number where the damage number
  went (spec 184).
- **The skill resolver's `heal` effect still reports nothing at all.** It emits
  no `hit` event, so no number floats off a skill's heal; that is a gap spec 188
  left and closing it is its own change.
- **`blood_hit_brush_mist` keeps its own size.** It is the variant that never
  lands, reachable only through `VfxLayer.bloodHit` -- a seam with no caller in
  the game -- and its velocity is written against its own scale. Shrinking a
  thing nothing plays is an unasked change.
- **The blood hit is not re-expressed in body radii.** `affliction-vfx.ts`
  scales its paint by the body it clings to; a hit is played at a request scale
  of 1 and would need the target's radius on the client to do the same. The
  authored number moves; the way it is authored does not.
