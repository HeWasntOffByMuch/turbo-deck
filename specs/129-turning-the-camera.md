# 129 — Turning the camera

## Problem

Spec 123 put 60-to-200 units of solid rock in a world drawn from a fixed
isometric angle, and the two do not get along: a unit walks behind a tier and
disappears, and no amount of care about *where* the camera sits fixes it,
because the occluder is authored content that can be anywhere.

The previous answer — specs 126 and 128, now deleted — cut a hole in the rock
around the player. It went through four rounds and was wrong in a different way
each time: it cut through the floor, then it hid the wall the player was about
to walk into, then it fired when nothing was obstructing anything, and at the
end the hole read as a sphere sitting in the world. Every fix was a better
guess at what the player wanted to see.

The player already knows what they want to see. Let them turn the camera.

## Shape

```ts
// src/render/iso3d/world/orbit-keys.ts — pure.

export const ORBIT_LEFT_KEY = 'BracketLeft';
export const ORBIT_RIGHT_KEY = 'BracketRight';
export const ORBIT_DEG_PER_SECOND = 90;

/** Degrees to turn this frame. Positive is clockwise. */
export function orbitStep(held: ReadonlySet<string>, dt: number): number;
```

`[` and `]` swing the view anticlockwise and clockwise. Hard-coded rather than
configurable: there is no key binding surface in the game yet, and inventing one
for two keys would be the larger change. When one arrives these two constants
are what it rebinds.

### Continuous, not stepped

The rotation is a rate — degrees per second, multiplied by the frame's own
duration — so holding a key *is* the easing. There is no separate animation to
start, to interrupt, or to fight with the input, and a tap is a small nudge
because the frame was short rather than because anything special was done about
taps. Four seconds for a full turn.

Two guards, both about frames that are not the length they claim to be:

- The step is clamped to 100ms, because a tab restored after a minute away
  arrives with an enormous elapsed time and would otherwise spin the view
  through several turns in one frame.
- Both keys held cancel to zero. A player who has rolled a finger across both
  wants the view to stop, not to have it pick whichever was pressed last.

### It writes the control that already exists

```ts
// ViewControls
orbitBy(degrees: number): void;
```

The Play tab's view popover already has an Orbit slider, and the camera already
reads it. `orbitBy` adds the delta to that slider's value and writes it back,
wrapped to a turn — so the keys, the slider and its Reset are one piece of state
rather than two that can disagree, and turning with the keyboard moves the
slider under the player's eyes.

Play's frame loop calls it from the `held` key set it already keeps for
movement. No new listener, no key state of its own.

The Orbit slider becomes continuous (`step: 'any'`), for the same reason the
zoom did in spec 042. A range input snaps whatever is written to it to its step,
and a frame's share of the swing is a fraction of a degree — on a step of 1 that
rounding *is* the rotation, so the view turns 60°/s at 60fps rather than 90, and
above about 180fps it does not turn at all, because half a degree rounds back to
where it started. The readout still shows whole degrees.

### It is checked in a browser

`createViewControls` builds DOM and the suite runs on `environment: 'node'`, so
neither `orbitBy` nor the frame loop that calls it is reachable from Vitest —
which is where both of this feature's real bugs lived. `npx tsx
scripts/probe-orbit.ts` drives the built page: it holds each key for a second,
reads the slider back, and photographs the frame either side.

The assertion that earns its keep is the *ceiling* on how far a second of
holding turns. "It moved, and clockwise" passes happily when degrees have been
handed to a helper that wanted radians and multiplied by 57.3.

## Invariants tested

- Neither key held is exactly zero degrees, not a rounding error.
- Each key turns its own way, and they are opposite.
- Both held cancel.
- Frame-rate independent: one 100ms step and ten 10ms steps turn the same
  amount.
- A monstrous frame is clamped rather than trusted.
- A negative `dt` never turns the view backwards.

In a browser, because they cannot be asserted anywhere else:

- Each key turns the view, in its own direction, and by no more than the rate it
  claims.
- The frame really is drawn from somewhere else afterwards — the widget moving
  is not the camera moving.
- The angle stays on the slider's 0–360 track rather than piling up at a stop.

## Out of scope

- **Rebinding.** Two exported key codes, and whatever binding surface arrives
  later reads them.
- **Camera pitch.** The view popover's Pitch slider still exists and is still
  mouse-only. Rotation is what a rock occludes against; height is not.
- **Snapping to 45°.** The camera is free, and a player who wants the default
  angle back has Reset.
- **Anything the rock does.** Cutaway, ghosting, dithering and edge outlines are
  all gone, and this spec is the reason they are not coming back.
