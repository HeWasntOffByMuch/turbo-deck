# 133 — motion, sound, and the right to refuse both

## Problem

The interface moves in exactly two places and neither of them was designed. A
text caret blinks on a hard-coded period, and a tooltip appears after a delay.
Everything else cuts: a window opens at full size on the frame it is asked for,
a modal appears, a dialog vanishes. That is not a style — it is the absence of
one, and it makes the interface read as a series of jump cuts over a game whose
whole subject is the readable wind-up.

It also has no sound at all, and cannot get any without a decision. `src/ui/`
may not read a clock, may not reach the sim, and may not touch the platform;
an `AudioContext` in a widget breaks all three at once.

And both of those are accessibility problems the moment they exist. A player who
has asked their system for less motion has asked for a reason, and an interface
that animates anyway is worse than one that never animated.

The three are one spec because they are one mechanism: **something that varies
over the time it is handed, decided in `src/ui/`, performed outside it.**

## Shape

### A tween is a pure function of elapsed time

```ts
// src/ui/core/motion.ts -- pure, headlessly tested
export type Easing = 'linear' | 'outQuad' | 'outBack' | 'step';

/** 0..1, how far through. `step` is what reduce-motion turns everything into. */
export function ease(kind: Easing, t: number): number;

export interface Tween {
  readonly from: number;
  readonly to: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly easing: Easing;
}

/** The value at `nowMs`. Clamped at both ends; a zero duration is `to`. */
export function valueAt(tween: Tween, nowMs: number): number;
export function isDone(tween: Tween, nowMs: number): boolean;
```

**Not a scheduler, not an animator, not a list of running things.** A widget
holds a `Tween` and asks it what its value is while painting, exactly as
`TextField` already asks whether the caret is visible at `now`. That keeps the
whole feature inside the rule that makes this framework testable: `update(nowMs)`
takes the time, so a script of `[time, event]` pairs replays to the same pixels
every run, and an animation is not an exception to that.

**Animation is paint-time, never layout-time.** A tween that changed a measured
size would relayout every frame, which is the cost the whole dirty-flag design
exists to avoid — and it is why the animations this spec adds are *opacity-free
and size-free*: they move things and they reveal them, and the pixel-art
constraint means they do it in whole pixels.

### What actually animates

Two, and no more:

1. **A window opening** — wipes into view from its own top edge. `outQuad`,
   ~120ms. Its *layout* is final from the first frame; only how much of it is
   drawn changes.
2. **A meter changing** — the fill chases the value rather than jumping, so a
   health bar reads as a hit rather than as a different number. `outQuad`,
   ~180ms.

**A modal is not one of them, and the reason is worth writing down.** It uses the
same mechanism the moment somebody hands it a time — and nobody can. A dialog is
opened from a `Button`'s press handler deep inside `ShopScreen`, which knows what
was clicked and not what o'clock it is; the time only exists at
`UiRoot.update(nowMs)`, four frames of call stack away. Threading it down would
mean every screen callback taking a timestamp it has no other use for, which is a
worse trade than a modal that cuts. `MOTION.modal` is defined and unused, and
that is the honest state of it.

**A wipe rather than a slide, and that is forced rather than chosen.** The draw
list has six operations and none of them is a transform, so there is no way to
move a painted subtree. Sliding would mean re-arranging every frame, which
relayouts — and, worse, moves the hit-test rects, so a click during the
animation lands somewhere other than where it looked. A clip has neither
problem, and it is the one thing the backend already does.

Everything else keeps cutting. A hover, a press, a focus ring and a tab change
are all *feedback*, and feedback that arrives late is worse than feedback that
arrives hard.

### Sound is a name, not a sound

```ts
// src/ui/core/sound.ts -- pure
export type UiSoundId =
  | 'ui.press' | 'ui.open' | 'ui.close' | 'ui.error'
  | 'ui.drop' | 'ui.pickUp' | 'ui.coin';

export interface SoundSink {
  play(id: UiSoundId): void;
}
```

A widget emits an **id** into a sink it was handed. `src/ui/` never learns what a
sound is, never allocates an audio context, and never reads a clock to schedule
one — which is the only way this stays portable to an engine that has its own
audio, and the only way the golden tests keep passing in Node.

The sink the game passes is in `src/render/`, where the platform lives. **This
spec does not ship one that makes noise**: it ships the sink, the ids, the
emission points, and a recording sink for tests. There are no sound files in this
repo and adding some is a different argument (they are binary assets, and
`docs/ui/00-architecture.md` §2.1 has strong opinions about those).

### Reduce-motion is one switch, read once, at the edge

```ts
export interface MotionPreference {
  /** Every tween becomes `step`: it lands on its final value immediately. */
  readonly reduced: boolean;
}
```

Carried on `PaintContext` beside `now`, because it is exactly the same kind of
thing: an input to what a frame looks like, handed in rather than sensed.
`ui-layer.ts` reads `matchMedia('(prefers-reduced-motion: reduce)')` once per
re-frame — the same place and the same cadence it already reads
`(pointer: coarse)` — and nothing under `src/ui/` asks.

`reduced` also silences nothing. Motion and sound are different preferences and a
player who asked for one has not asked for the other.

## Invariants tested

Pure, in Node:

- `valueAt` is clamped at both ends, monotonic within a tween, and exactly `to`
  at and after the end. A zero-length tween is `to`, not a division by zero.
- **`reduced` makes every tween a step function**: for any tween and any time
  past its start, the value is `to`. Asserted over the easing table with
  `fast-check`, because "we remembered to check the flag" is per-call and a
  property is not.
- A widget that is animating does **not** invalidate layout:
  `UiRoot.layoutPasses` is unchanged across a hundred painted frames of a window
  wiping in. This is the assertion that stops a tween becoming a per-frame
  relayout later.
- Sounds are emitted at the intent, not the outcome: a `Button` press plays
  `ui.press` before `onPress` runs and whether or not anything is listening to
  it, and a recording sink says so.

In pixels:

- Two new goldens: a window part-way through its wipe, and the same frame with
  `reduced` set, which must be identical to the settled one. The second is the
  interesting one — it is the assertion that reduce-motion is not "a faster
  animation" but *no* animation.
- The existing twenty-eight goldens are unchanged, because they are all taken at
  a settled time. Any diff there is this spec having animated something it said
  it would not.

## Out of scope

- **Audio files, an audio backend, or a mixer.** Named above, with the reason.
- **Animating a layout property.** Size, padding and text are not tweenable here
  and this spec does not add the machinery to make them so.
- **Easing curves as theme data.** Three named easings in code; a theme that can
  describe arbitrary curves is a feature nobody has asked for.
- **A motion setting in the game's own UI.** The system preference is the input.
  A per-game override is a preferences spec, and preferences are deliberately not
  persisted yet (spec 107).
- **Animating the DOM HUD.** It is not this framework's.

Tested by `src/ui/core/motion.test.ts`, `src/ui/core/sound.test.ts`,
`src/ui/gallery/goldens.test.ts`, and `src/ui/gallery/budget.test.ts`.
