# 039 — Camera follow lag

## Problem

The isometric follow camera (spec 031/033) is pinned exactly to the player: its
look-at point is set to the unit's position every frame, so the unit is nailed to
the centre of the screen and the *world* is what appears to move. That reads as
stiff, and it throws away the cue that makes movement feel like movement — the
unit pulling ahead of the frame when it starts, and settling back when it stops.

Let the camera trail the unit by a small, constant delay instead.

## Shape

Exponential smoothing of the camera's look-at point toward the unit, with the
smoothing factor derived per frame so the lag is measured in *time*, not in
frames — a 30 fps machine and a 144 fps machine must trail by the same distance.
New pure helper alongside the existing framing maths in `view-settings.ts`:

```ts
export const DEFAULT_FOLLOW_LAG_MS = 130;

/** Fraction of the remaining gap to close in a frame of `dtSeconds`. */
export function followAlpha(dtSeconds: number, lagMs: number): number;
```

It is `1 - exp(-dt / lag)`: the time constant `lagMs` is how long the camera takes
to close ~63% of a gap. `scene.ts` uses it to ease its `target` toward the player
rather than assigning it, and snaps on the very first frame so the camera does not
glide in from the arena centre on load. `view-controls.ts` exposes it as a
**Follow lag** slider in the Camera section (`followLagMs()`), with 0 meaning the
old hard-pinned behaviour.

The camera is still follow-only — it never rotates the world — so `screenToWorld`
stays a plain projection and the sim is untouched.

## Invariants tested

- `followAlpha` returns a fraction in `[0, 1]`; `dt = 0` gives 0 (no movement),
  and a zero or negative lag gives 1 (snap, the old behaviour).
- It is frame-rate independent: two half-length steps leave exactly the same gap
  remaining as one full step, so the trailing distance does not depend on frame
  rate.
- A longer lag closes less of the gap for the same `dt`; a longer `dt` closes
  more for the same lag.
- Pure: same arguments → same result.

## Out of scope

- Look-ahead (biasing the camera toward where the unit is heading), deadzones,
  and snapping on teleports/dashes.
- The movement sandbox (spec 032) and rig debug (spec 035) viewports.
- The existing per-frame easing of the camera *offset* and zoom, which is
  unchanged.
