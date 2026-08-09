# 110 — A preview you can tune against

## Problem

Timing is the game. A wind-up long enough to read and short enough to matter is
not a number anyone gets right in a text editor — it is judged by watching a
blow land. So this is the screen the roster actually gets tuned on, and the bar
it has to clear is that **what it shows is what the game will show.** A preview
that flatters is worse than none: it moves numbers in the wrong direction and
does it convincingly.

There is a blocker in front of all of it. The repository has no `.glb` and
cannot get one here — the API key is unset and this environment's egress policy
blocks the host. A preview with nothing to preview cannot be reviewed, tuned, or
regression-tested, and every piece of it would be written blind.

## Shape

### First: a reference unit, generated offline

`npx tsx scripts/make-reference-unit.ts` writes a complete unit into
`assets/units/dev/` — a skinned `.glb` on the 25-bone mixamo contract, four
animation-only clip `.glb`s, and the three JSON documents. No dependency: glTF
2.0 is JSON plus a binary chunk, and a writer for the subset we emit is smaller
than the argument for pulling in a library.

Three things make it worth committing rather than mocking:

- **It is authored at ~1.8 units tall**, the height a mixamo rig actually
  arrives at, so `import.scale` is a *measured* ~31 and the scale normalization
  that will otherwise put the first real unit through the floor is exercised
  from the start.
- **Its skeleton is a separate document**, `biped-dev.skeleton.json`, with a
  real measured `bindPose`. The canonical `biped.skeleton.json` stays
  provisional until a Tripo rig is measured against it — filling it in from a
  rig we drew ourselves would defeat the check it exists to make. Two skeletons
  also proves the format never assumed one.
- **It is the fixture the deformation and screenshot checks need**, which is
  the half of the validation checklist that has had nothing to run against.

### The viewport

Renders through the game's own path: the same `WorldScene`-style retro pass,
the same palette, and **the same `HikeSettings` object the Play tab's cog
writes** — not a copy, not a preset. A switch thrown in Play is thrown here.
That is the mechanism that stops the two drifting, and it means the preview
cannot look better than the game because there is nothing in it that could.

Camera: an isometric preset matching gameplay, free orbit, and a turntable.
A ground plane at gameplay scale with a size-reference silhouette at the
player's real drawn height, so a unit that is subtly wrong is wrong next to
something.

Full-res inspection is a toggle, default off — which is just `lowRes: false` on
the shared settings, since the low-resolution buffer is one of those switches.

### The panels

- **Clip player** — play/pause, scrub, loop, per-frame stepping at the sim's
  60Hz, playback speed, and a timeline whose event markers are draggable
  handles that write back to `cliplib.json`.
- **State machine** — the states and transitions as a graph, laid out by rank
  from the entry state. Clicking a transition edits its blend duration and
  interruptibility. The live current state is highlighted while it runs.
- **Parameters** — a slider per declared parameter, driving the blend trees in
  real time.
- **Action timings** — wind-up, active and recovery as a stacked bar with
  numeric inputs, showing the resulting clip time-scale and turning red past
  the unit's `maxTimeScale`. A trigger button fires the action from idle.
- **A/B** — two viewports on one clock: the same clip on two units, or two
  timing configurations on one unit.

Everything editable writes back to the JSON through the server, and every write
goes through the spec 107 validator first. Nothing lives only in the tab.

### The state machine is the game's, not the tool's

`src/units/machine.ts`, pure and tick-driven, is written here and consumed by
spec 111 unchanged. The brief's rule — the Studio tab and the game read the
same files through the same parser — is not a promise anybody keeps by being
careful; it is true because there is one machine and both call it.

It advances on **whole 60Hz ticks**, never on a frame delta, and fires events on
**frame-index crossing** rather than by comparing times, so a step that
overshoots several frames still fires each event exactly once and in order.

## Invariants tested

The reference unit:
- The written `.glb` parses, and its bone names and hierarchy match the
  skeleton document exactly.
- Every vertex's weights sum to 1, and no vertex is bound to more than 4 bones.
- No clip carries root translation channels.
- The generated documents pass `npm run validate:units` with no errors.

The machine (pure, headless):
- Events fire once and only once per pass, at 30, 60 and 144 Hz steps, and in
  ascending time order within an overshooting step.
- A looping clip's events fire again on the next lap, and a one-shot's do not.
- `loop` states crossfade; `oneshot` returns to its source; `locking` refuses
  every transition until recovery ends, then releases; `terminal` has no exit.
- A blend tree picks the pair either side of the parameter and weights them,
  clamping outside the threshold range rather than extrapolating.
- Advancing by N single ticks and by one N-tick step produce identical state.
- An action's event lands on the same tick whatever the step size.

The panels (pure, headless):
- Timeline: time ↔ pixel round-trips; a drag lands on the clamped 0..1 value;
  marker hit-testing picks the nearest within a radius and nothing outside it.
- Timing bar: the three spans sum to the full width; the time-scale factor
  matches `timeScaleFor`; over the limit is flagged.
- Graph layout: every state gets a rank, no two nodes overlap, an `'*'`
  transition is drawn once rather than once per source.

Write-back:
- A document that fails validation is rejected and the file on disk is
  unchanged.
- A written document round-trips: read it back and it parses to what was sent.
- The write is atomic — an interrupted write leaves the previous file intact.

## Out of scope

- Anything in the running game. Spec 111 wires the machine to entities, adds the
  distance LOD, strips root motion at import and asserts that animation state
  cannot feed back into gameplay.
- The bake: decimation, meshopt, KTX2, the content-hash manifest (spec 112).
- 2D blend trees, IK, and additive layers.
- Filling in the canonical skeleton's bind pose. That waits for a real rig.
