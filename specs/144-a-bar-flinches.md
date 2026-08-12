# 144 — A bar flinches

## Problem

Spec 143 gave a bar a memory of the blow that just landed, but the bar itself
still hangs perfectly still while it takes one. The white chunk answers "how
much" and answers it over the next half-second; what is missing is the instant
of contact — the bar should be *knocked*, so a hit registers in the frame it
lands rather than only in the band it leaves behind.

This is the opposite decision to the white chunk's throttle, and deliberately
so. The chunk is a *measurement*, and measurements merge: three quick hits are
one number. A flinch is a *contact*, and contacts do not merge: three quick hits
are three kicks, and a bar under sustained fire should rattle. So every blow
restarts the kick, while the same three blows still grow one white chunk.

## Shape

`BarFill` grows an offset, in CSS pixels, from the same `HealthFlashes.read`:

```ts
export const SHAKE_MS = 200;        // how long a kick lasts
export const SHAKE_PIXELS = 2.6;    // how far the biggest blow throws the bar
export const SHAKE_HZ = 15;         // how fast it rattles

export interface BarFill {
  readonly health: number;
  readonly ghost: number;
  readonly shakeX: number;  // CSS px, added to where the bar is placed
  readonly shakeY: number;
}
```

A decaying oscillation off the time since the last blow: `cos` on x and `sin` on
y over one envelope, so the bar jumps at contact rather than easing into a
swing. The envelope is quadratic rather than exponential so that it reaches zero
*at* `SHAKE_MS` rather than approaching it, and the bar settles onto its anchor
instead of snapping back. Amplitude scales with the size of the blow relative to the body's
own `maxHealth`, floored so a scratch still registers, capped so a killing blow
does not throw the bar off the head it belongs to.

`hud.ts` adds the offset to the pixel it already writes each frame. Nothing else
moves: the body, the cast bar under it and the damage numbers are all placed as
before.

## Invariants tested

- No blow, no offset: `shakeX` and `shakeY` are exactly 0 for an untouched bar
  and for one whose kick has expired.
- A blow displaces the bar in the *frame it lands*, not a fraction of a cycle
  later.
- The envelope decays monotonically per cycle and is exactly 0 at `SHAKE_MS`.
- Every blow restarts the kick, including one inside an open white-chunk
  window — the two rules are independent, and the same burst that grows one
  chunk produces one kick per blow.
- Amplitude never exceeds `SHAKE_PIXELS`, whatever the blow, including overkill
  and a `maxHealth` of zero.
- A bigger blow kicks harder than a smaller one on the same body.
- The offset is a pure function of the same `(id, health, maxHealth, nowMs)`
  reads, and a heal never kicks.

## Out of scope

- Shaking the body, the camera, or the damage number. This is the bar.
- A different kick per damage type or per crit; the size of the blow is the
  only thing that scales it.
- Any change to the white chunk's timing, its throttle, or the colours.
