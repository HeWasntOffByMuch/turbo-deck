# 005 — Minimal renderer + input

## Problem

Everything so far runs headlessly. This spec adds the thin layer a person
actually plays: a PixiJS scene that draws player/enemy/hand/bonus-slot from
`GameState`, and keyboard capture that turns held/pressed keys into
`GameInput` once per fixed tick. Per the architectural rule, nothing here
decides outcomes — it only reads `session.ts` state and calls `stepGame`.

## Shape

`src/render/input.ts` — `InputCapture`: attaches `keydown`/`keyup`
listeners, tracks held keys, and exposes `sample(): GameInput`:
- `moveDir`: -1/0/1 from held `ArrowLeft`/`A` vs `ArrowRight`/`D`.
- `attack`/`parry`/`dodge`: level-triggered from held `Space`/`KeyK`/`KeyL`
  (safe to hold — the sim's own cooldown/defense-lock gates repeats).
- `playHandIndex`/`playBonusCard`: edge-triggered from `Digit1`/`Digit2`/
  `Digit3`/`KeyB` — consumed (cleared) the tick after they're sampled, so
  holding a card key doesn't replay it every tick.

`src/render/loop.ts` — `GameLoop`: a `requestAnimationFrame`-driven fixed
timestep accumulator. Real elapsed time accumulates; while it holds at
least one 1/60s slice, it samples input, calls `stepGame`, and drains the
slice — decoupling "how often the browser paints" from "how often the sim
ticks." Exposes `onTick(state, events)` for the scene to redraw after each
batch of ticks.

`src/render/scene.ts` — `Scene`: owns the PixiJS `Application` and draws,
from `GameState` alone: player/enemy position + health bars, a mana bar, an
enemy windup telegraph, the hand of 3 card slots (name/cost/tags or
"empty"), the bonus slot, currently-active synergies (via
`getActiveSynergies`, read-only), and a short scrolling log of recent
`GameEvent`s (perfect parries, hits, cards played) for feedback.

`src/render/main.ts` — wires `InputCapture` + `GameLoop` + `Scene` +
`initGame` together; the only file that constructs the initial seed.

## Invariants tested

This layer has no automated test suite (it's DOM/canvas-dependent and the
architectural rule already guarantees the rules it depends on are covered
headlessly). It is verified manually: `npm run dev`, then in a browser —
move, land a normal attack, get hit without defending, perfect-parry an
attack and see the bonus slot fill, play a hand card and see it refill,
and see two synergistic cards in hand light up as an active synergy.

## Out of scope

- Any decision logic — range checks, damage numbers, defense timing, deck
  refill rules all already exist in `src/sim`/`src/cards`/`src/game`.
- Art, animation polish, sound. Rectangles and text are enough for a PoC.
- Gamepad/touch input.
