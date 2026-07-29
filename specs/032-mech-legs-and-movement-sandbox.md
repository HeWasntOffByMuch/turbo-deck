# 032 — Mech spider legs + movement sandbox

## Problem

The iso3d `MechRig` is a rigid-chassis quadruped whose legs only swing
cosmetically — the feet never touch a fixed spot on the ground, so the walk
slides. We want the mech to read as a real walker: a small cube body carried on
four two-jointed spider legs whose feet lock to the ground and only lift to
re-plant ahead when the body has carried them too far. And we want a place to
actually watch it move: a second, game-free tab that drives one controllable
mech through the sim's MOBA movement (turn-rate, right-click move order) with no
enemies, cards, or attacks.

The architectural rule is unchanged: the leg mechanics are **cosmetic** — the
ground-lock IK is derived entirely from the rig's observed world position and
heading and never reads or writes sim state. The movement tab reuses the
existing deterministic combat sim for all movement rules; the renderer only
reads the resulting state.

## Shape

`rigs.ts` — redesign `MechRig`:
- A small **cube** body (was a wide chassis) with a small head/eye for facing.
- Four legs, each a two-bone `MechLeg` with a hip joint (at a body corner) and a
  mid-leg knee. The **thigh** rises out sideways-up from the hip to a raised
  knee (a spider's bent knee); the **shin** drops from the knee down to a foot
  planted on the ground. Segment poses come from a 2-bone IK solve with an
  up-pointing pole, so the knee always bends upward.
- Feet are **ground-locked**: each foot stores a world position and stays put
  while the body moves over it. When a foot is stretched past its allowed radius
  from the leg's rest point under the body, the leg **detaches** and steps to a
  fresh plant point led in the current movement direction; the foot arcs up and
  back down over a short step. A cap on how many legs may be mid-step at once
  keeps the body supported (a diagonal-pair gait).
- New pose signature: `update(dt, worldPos: Vec2, heading: number)` (was
  `update(dt, distanceMoved)`), since ground-lock IK needs the world transform,
  not just a scalar distance. An optional body-colour override lets the sandbox
  render an ally-coloured mech; enemies still key colour off their type.

`scene.ts` — call the new `MechRig.update(dt, worldPos, heading)` from the enemy
sync, passing each enemy's world position and its computed facing.

`movement.ts` (new) — a game-free movement sandbox view:
- Its own minimal three.js scene (ground + scenery + a single controllable
  `MechRig` + move marker + heading arrow), reusing the mesh factories and the
  same fixed iso follow-camera.
- Drives the deterministic combat sim directly (`initCombat` with no enemies /
  no ambient spawner, `step`), feeding only movement inputs: a right-click move
  order to the ground point under the cursor and **C** to cycle the movement
  character (turn-rate/speed archetype). No attacks, cards, waves, or enemies.
- Exposes a `start()/stop()` handle so the tab shell can pause it when hidden.

`main.ts` — a small tab shell with two tabs, **Combat (isometric 3D)** and
**Movement sandbox**. Each tab mounts a view exposing `start()/stop()`;
switching stops the hidden view's loop and input and starts the shown one. The
existing combat wiring moves behind a `mountCombat` handle unchanged.

`input.ts` — add `detach(target)` mirroring `attach`, so a hidden view releases
its window/canvas listeners.

The sim, cards, and game layers are untouched. No new determinism surface is
added: the leg IK is cosmetic and the sandbox replays the same combat sim.

## Invariants tested

- `computeMoveSpeed` and the existing sim movement tests still hold — the
  movement sandbox adds no sim behavior, so the sim suite is unchanged and green.
- (Rig/scene/tab code is renderer-only three.js and has no headless test surface,
  matching the rest of `iso3d/`; correctness is covered by typecheck + lint.)

## Out of scope

- Any change to sim/cards/game logic or to movement rules themselves.
- A headless test for the leg IK or the tab shell (renderer-only, like the rest
  of `iso3d/`); the pure/tested surfaces (`scatter`, `projection`) are unchanged.
- Physics-accurate IK, foot collision with scenery, or terrain height — the
  ground is flat at `y = 0` and feet plant on it.
- Reworking `PlayerRig` (the bird) or the 2D `spells` renderer.
