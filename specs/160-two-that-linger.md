# 160 — Two that linger

## Problem

Two variants are wanted, and both are the same request made of different
material: **something that outstays the thing that made it.**

- an explosion whose smoke arrives almost at once and is still there long after
  the fire has gone;
- a blood hit whose spatter never lands — it hangs, comes apart and fizzles out
  in the air.

Neither can be written today, and the reasons are worth separating from the
numbers.

**The explosion's two halves share one clock.** `brushExplosion` derives every
lifetime from `lifetimeTicks`, and the smoke's delay is a literal 16 inside the
builder. So the fire and the smoke can only be moved together: shortening the
blaze shortens the mass with it, and there is no way to say "start the smoke on
tick 3" at all. A smoulder is precisely the case where the two halves have to
move in *opposite* directions.

**The blood has no way to not fall.** `gravity` is a parameter, so `0` is
sayable — and on its own it produces a spatter that hangs perfectly still in a
rigid formation, which reads as the whole effect being winched sideways rather
than as anything dissipating. What is missing is the rest of the behaviour:
something to lift it, something to push its pieces apart from each other, and an
ending that thins rather than dries. The size and alpha curves are written out
per layer with the endings hard-coded near 1, because paint dries where it
lands.

And one thing that was not obvious until it was measured: **shrinking a mark
does nothing if the mark is already dead.** The three layers are authored to die
in order — the flick first, the medium marks next, the dabs last — which is
right for a hit, where the gesture lands and the debris outlives it. It is wrong
for a fizzle, where the fizzling *is* the effect and there has to be something in
the air while it happens. The first cut had the primary living less than two
thirds of the window and was over before anybody could watch it go.

## Shape

Four parameters on `bloodHit` and two on `brushExplosion`. No new geometry, no
new shapes, no new orientation — this is what the builders were for.

```ts
interface BloodHitParams {
  /** Upward acceleration. 0 for paint. */
  readonly drift?: number;
  /** How much the marks wander, so a rising set stops being a formation. */
  readonly turbulence?: number;
  /** The fraction of its peak size a mark ends at. Near 1 for paint. */
  readonly shrinkTo?: number;
  /** When the fade begins, as a fraction of life. Late for paint. */
  readonly fadeFrom?: number;
  /** How much the shorter-lived layers are held toward the full span, 0..1. */
  readonly linger?: number;
}

interface BrushExplosionParams {
  /** Ticks before the smoke starts. */
  readonly smokeDelayTicks?: number;
  /** Ticks the smoke lives. Decoupled from the fire's `lifetimeTicks`. */
  readonly smokeLifeTicks?: readonly [min: number, max: number];
}
```

`lifetimeTicks` on the explosion now governs the **fire alone**, which is what
makes the two halves separable at all.

Two shared helpers inside `bloodHit` — `sizeCurve` and `alphaCurve` — replace
three hand-written curves per layer. They were three copies of the same two
decisions, and a variant that changes how a mark *ends* has to change all three
or it changes none of them.

### The presets

`explosion_brush_smoulder` — the same seven layers in the same order, with the
fire cut to a little over half its usual life and the smoke starting on tick 3,
while the major strokes are still arriving, and living four to six times as long
as any of them. About two seconds rather than one and a quarter.

`blood_hit_brush_mist` — no gravity at all, a gentle upward drift, turbulence
pushing the pieces apart, all three layers held near the full span, shrinking to
under a third of peak and fading from 60% of life. Slower off the mark and much
draggier, because something that is going to hang has to stop first.

### Reaching them

`dissipates?: boolean` on `BloodHitInput` and `smoulder?: boolean` on
`BrushExplosionInput`. Each selects its preset *instead of* the existing choice
rather than beside it — one mist, not a light and a heavy one, because a harder
blow on something that does not bleed is a bigger mist and `scale` already says
that.

## Invariants tested

**The smoulder.** Its smoke starts before the major strokes have finished
arriving and at under a third of the standard delay; it outlives its own fire by
more than 2.5×, and by a larger ratio than the standard blast's smoke outlives
its fire; its fire is shorter than the standard blast's; and it is still the same
seven layers in the same order.

**The mist.** Every layer has *zero* gravity — not "a little" — and a positive
upward acceleration and a positive turbulence amplitude; every layer ends under
40% of its peak size where the standard hit ends above 75%; every layer starts
fading before 65% of life where the standard starts after 70%; its shortest-lived
layer covers more than 65% of its window where the standard's covers under 55%;
and it is still one aimed gesture through three `fan` emitters with one primary.

**Both.** Exempt from the standard duration windows, in the two tests that assert
them, each with the exemption stated: lingering past the window is the request,
and a variant that had to fit inside it would not be one.

The picture: `npx tsx scripts/preview-brush-vfx.ts` gains a lifecycle row for
each, sampled across the variant's own longer window rather than the standard's.
The scene page gains a **Blood mist** and a **Boom smoulder** button.

## Out of scope

- Wiring either into combat. `effectsForBlow` still plays the standard hit off
  anything that bleeds; what a non-bleeding target draws is a separate decision
  and belongs with whoever authors that monster.
- A heavy mist, or a smoulder at three sizes. `scale` covers both.
