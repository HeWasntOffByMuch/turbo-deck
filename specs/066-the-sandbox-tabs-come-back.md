# 066 — The sandbox tabs come back, and the flat one goes

## Problem

Two tabs were collateral damage. The **movement sandbox** (spec 032/033/046) and
the **rig debug viewport** (spec 035) were deleted in 062 along with the card
game, not because anything was wrong with them but because they drove
`src/sim/combat.ts`, and that file went. Neither tab had anything to do with
cards: they exist to drive one unit around, alone, and watch its legs, its cloth
and its gait — and the rig debugger is how the cloth was tuned in the first
place. `rigs.ts`, `robe.ts`, `critter.ts`, `robe-debug.ts` and every tuning panel
they bind to are all still here, drawn by nothing.

The **flat (debug) tab** was the opposite case: a stopgap 062 stood up so
wind-ups and projectiles were watchable before the art path caught up. Spec 063
gave the isometric Play tab back, which is what it was standing in for. Two
views over one `GameClient` was cheap, but it is a tab that costs a maintenance
surface and answers a question nothing is asking any more.

So: delete `src/render/play/`, and give the two sandboxes back.

## The part that is not just restoring a file

The sandboxes cannot come back the way they left. They drove `initCombat` /
`step`, a whole second simulation, and CLAUDE.md's one rule is now that
`src/server/` is the only one. Reviving `src/sim/combat.ts` to move a spider
around a tuning viewport would be the single worst reason to have two sims.

What those tabs actually needed from a sim is small enough to name: a position, a
heading, and a standing move order. No health, no enemies, no abilities, no
network. That is a **mover**, not a sim, and it belongs to the sandbox:

- `src/render/iso3d/sandbox-mover.ts` — pure and headlessly tested, listed in
  `PURE_RENDER` in `eslint.config.js` so the linter holds it to the core's rules
  (no wall clock, no DOM, no three.js, no ambient randomness).
- It reuses rather than reimplements: `turnToward` from `src/server/sim/movement.ts`
  (there is one turn rule and it lives there), `slideCircle` / `segmentClear` from
  `src/sim/collision.ts`, `findPath` / `navGridFor` from `src/sim/pathfinding.ts`,
  and the MOBA movement constants from `src/sim/constants.ts`.

Nothing it decides is a game outcome — no server ever sees it, and no other
player exists in these tabs. It is a fixed-timestep driver for a rig under a
tuning panel, which is exactly what makes it safe to keep in `src/render/`.

## Shape

```ts
// src/render/iso3d/sandbox-mover.ts
export interface MoverState {
  readonly position: Vec2;
  readonly facing: number;              // radians
  readonly moveTarget: Vec2 | null;     // the standing order, cleared on arrival
  readonly path: readonly Vec2[];       // the route around walls, if one was needed
  readonly characterIndex: number;      // which archetype (src/sim/characters.ts)
}

export interface MoverInput {
  readonly moveTarget?: Vec2;           // a right-click: a fresh order
  readonly cycleCharacter?: boolean;    // C
  readonly moveSpeed?: number;          // live panel override, world units/second
  readonly turnRate?: number;           // live panel override, degrees/second
}

export function initMover(position: Vec2, characterIndex?: number): MoverState;
export function stepMover(state: MoverState, input: MoverInput, world?: WorldColliders): MoverState;
```

The two views on top of it are the deleted ones, restored against this instead of
against the combat sim:

- `src/render/iso3d/movement.ts` — `mountMovement(container): ViewHandle`, plus
  `buildPanel(opts): SandboxPanel`, the unit picker and tuning column both tabs share.
- `src/render/iso3d/debug-view.ts` — `mountDebug(container): ViewHandle`: top +
  side viewports, slow-mo and single-step, leg/cloth overlays, numeric readout.
- `src/render/iso3d/sandbox-input.ts` — `SandboxInput`: right-click move order,
  C to cycle the archetype, J to hop. All that survives of the deleted
  `input.ts`, which was mostly card-playing keys.

The tab bar becomes: Play · Movement sandbox · Rig debug · Map editor.

## Invariants tested

`sandbox-mover.test.ts`, headless:

- A move order rotates the body **in place** until the heading is within
  `MOVE_FACING_THRESHOLD_DEG` of the destination, and only then translates.
- A body walks to its destination and the order clears within
  `MOVE_ARRIVE_EPS`; with no order it holds both position and heading (it does
  not turn to follow the cursor).
- Speed and turn rate come from the active archetype, and a panel override
  replaces them; speed is clamped to `[MOVE_SPEED_HARD_MIN, MOVE_SPEED_HARD_MAX]`.
- `cycleCharacter` walks the archetype list and wraps.
- A destination behind a wall is routed (`path` non-empty) and the body never
  ends a tick overlapping a collider; a destination in plain sight is not routed.
- **Replay**: the same start state and the same input sequence produce a
  bit-identical `MoverState`, every run.

## Out of scope

- Any combat in the sandboxes. There is no health, no enemy and no ability; the
  server is the only place a blow lands.
- Queued (shift-click) move orders — spec 040's stacking belonged to the game,
  and one destination is all a tuning viewport needs.
- Multiplayer, prediction or the wire. These tabs open no transport.
- The Play tab and the map editor, which change only by their neighbours in the
  tab bar changing.
