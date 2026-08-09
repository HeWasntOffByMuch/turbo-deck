# 111 — The same machine, in the game

## Problem

Spec 110 built a state machine and a preview to tune it in. The machine is
driven by the Studio tab and by nothing else, so everything the brief promises
about "what you tuned is what ships" is currently a promise rather than a fact:
there is no code path in which a unitdef affects the game.

This spec is that path. It is deliberately *additive* — the Play tab keeps
working exactly as it does, procedural critter and mech rigs and all — because
one authored unit exists today (the dev mannequin) and a roster of one is not a
reason to tear out the rigs that are drawing everything else.

## The seven rules, and where each one lives

The brief's step 6 is seven sentences. Each maps to a module, and the mapping is
the design:

**1. The tool and the game read the same files through the same parser.**
`loadUnitBundle` in `src/units/index.ts` is the single entry point: it takes the
two JSON documents and returns a validated `{ unit, clipLib }` or the issues
that stopped it. The Studio tab used to cast its imports with
`as unknown as UnitDef`, which is the same thing as having no parser at all;
both callers now go through the validator. There is no authoring-side format
and no runtime-side format, and no second reader that could disagree with the
first.

**2. Mixer time advances on the fixed simulation step, not render delta.**
`scene.render` gains a `ticks` field — how many whole 60Hz steps the frame's
accumulator actually drained — and the machine is stepped by exactly that. It
was already the case that `UnitMachine.step` takes integers; what was missing was
a caller in the game handing it the right one. `dt` continues to drive the
procedural rigs, which are frame-rate toys and always were.

**3. Events fire on frame index crossing, exactly once.** Already true and
already tested (spec 110): the machine walks one tick at a time and compares
integers. Nothing here weakens it — in particular the distance LOD below
throttles the *mixer*, never the machine, precisely so a distant unit's events
still land on the frames they were authored on.

**4. State categories behave as declared.** Already true and already tested
(spec 110): loop crossfades, oneshot overrides and returns, locking refuses
until recovery ends, terminal has no exit.

**5. Animation state is presentation only.** The wire carries position, facing
and an activity enum; the client picks the animation. This is enforced three
ways, in increasing order of how much it would take to defeat:

- `unit-driver.ts` is a pure function from *replicated facts* to *machine
  commands*. It is handed a plain snapshot, not the `GameClient`, so it has
  nothing to call and no way to send an input even if somebody wanted it to.
- The dependency arrow already runs one way (`src/render/` may read
  `src/server/`, never the reverse), so a machine's output cannot reach the sim
  by import either.
- `presentation-only.test.ts` runs a headless session twice over the same seed
  and the same input sequence — once with the animation layer driven and every
  event fired, once with it absent — and asserts the authoritative state is
  identical. That is the assertion the brief asks for, and it is the one that
  would actually catch somebody wiring `swing.impact` into a hit.

**6. Root motion is stripped at import, and says so.** `rootMotionChannels` in
`src/units/root-motion.ts` is pure: given a clip's glTF JSON and the rig's root
bone, it names every translation channel on the root. It is used twice. At load
time the tracks are stripped and each one is reported — the Studio panel shows
them and the console gets an error naming unit, clip and track. In
`npm run validate:units` the same check reads the clip `.glb` files beside a
unitdef and **fails CI**, which is the loud part: a clip that walks away from
the server's idea of where the body is should not be something you find out
about by watching it.

**7. Distance LOD.** `unit-lod.ts` is pure: a distance and a frustum flag in,
a mixer cadence out. Past the near threshold the pose is applied every second
tick, past the far one every fourth, and outside the frustum not at all. The
machine steps regardless. Skinning is what is being saved here — the mixer's
bone matrix writes and the skeleton's world-matrix walk — and that cost is
per-unit-per-application, not per-pixel.

## Data and API shape

```ts
// src/units/root-motion.ts — pure
rootMotionChannels(gltf: unknown, rootBone: string): readonly RootMotionChannel[]
rootMotionTrackNames(trackNames: readonly string[], rootBone: string): readonly string[]

// src/units/index.ts — the one parser
loadUnitBundle(unitDoc: unknown, clipLibDoc: unknown): UnitBundleResult

// src/render/iso3d/world/unit-catalog.ts — pure
authoredUnitFor(look: Appearance): AuthoredUnitId | null

// src/render/iso3d/world/unit-driver.ts — pure
driveUnit(machine: UnitMachine, facts: UnitFacts): readonly FiredEvent[]

// src/render/iso3d/world/unit-lod.ts — pure
mixerCadence(distance: number, inFrustum: boolean): number   // 0 = do not apply
shouldApply(cadence: number, tick: number): boolean

// src/render/iso3d/unit-rig.ts — three.js
class UnitRig { applyPoses(poses); readonly rootMotion: readonly string[] }
```

`UnitFacts` is exactly what the wire already carries plus what the renderer
already computes for its own drawing: `speed`, `activity`, `castPhase`, `dead`.
Nothing in it is derived from an animation.

## Invariants to test

- The game and the Studio tab resolve a unitdef through the same function, and
  a document that fails validation is refused by both.
- The machine advances by whole sim ticks: a frame that drains three ticks steps
  the machine three times, and a frame that drains none steps it not at all.
- An event authored at a given normalized time fires on the same machine tick
  whether the frames were 16ms or 100ms.
- The authoritative server state after N ticks is byte-identical with the
  animation layer driven and with it absent.
- A clip with a translation channel on the root bone is named — not silently
  dropped — and fails `npm run validate:units`.
- A translation channel on a *non-root* bone is left alone; that is a rig doing
  something unusual, not root motion.
- LOD: cadence is 1 near, coarser past each threshold, and 0 outside the
  frustum; the machine's tick count is unaffected by any of it.
- An entity with no authored unit draws exactly as it does today.

## Out of scope

- Replacing the critter and mech rigs. One authored unit exists; the roster
  moves over when there is a roster.
- Streaming or content-hashing unit assets. That is step 7, and it is where the
  manifest and `PROTOCOL_VERSION` 10 → 11 belong.
- Server-side knowledge of animation. The server does not know a clip exists
  and this spec does not teach it.
- Blending between *units*, footstep audio, or IK. The event stream is emitted
  and currently has one consumer, the Studio panel; wiring sound to it is a
  later, smaller change.
