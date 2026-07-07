# 013 — Balatro-style card hand: card shapes + play animation

## Problem

The hand is drawn as three flat, static text boxes (`Scene.drawHand`) that read
as a debug HUD, not as cards. There is no motion when a card is played — it just
silently swaps text. This spec restyles the hand as Balatro-style **cards**
(cream face, colored border by type, cost pip, title band, art box, wrapped
description) that gently idle-bob in place, and gives every play a satisfying
animation: the spent card lifts, spins, enlarges and fades out while the drawn
replacement deals in from below.

This is a **render-only** change. No sim/card rules, events, or state shapes
move; the renderer reads the same `state.deck.hand` / `state.deck.bonusSlot` it
already reads. Determinism of the sim is untouched — animation is driven by
cosmetic wall-clock frame timing, exactly like the existing damage popups.

## Shape

`src/render/card-anim.ts` — a **pure, DOM/Pixi-free** module holding the
animation math, so the curves are unit-testable (the Pixi drawing that consumes
them stays untested, matching the existing render convention):

```ts
export interface CardTransform {
  readonly offsetX: number;   // px, relative to the resting slot position
  readonly offsetY: number;   // px, negative = up
  readonly rotation: number;  // radians
  readonly scale: number;     // 1 = resting size
  readonly alpha: number;     // 0..1
}

export const REST_TRANSFORM: CardTransform; // {0,0,0,1,1}

// Gentle idle "breathing": bob + tilt on a sine, phase-offset per slot.
export function idleTransform(slotIndex: number, timeMs: number): CardTransform;

// Card being played: lifts, spins, scales up, fades. progress 0..1.
export function playTransform(progress: number): CardTransform;

// Drawn replacement dealing into an empty slot: rises from below with an
// ease-out-back overshoot, fading in. progress 0..1.
export function dealTransform(progress: number): CardTransform;

// Easing helpers used above (exported for tests).
export function easeOutBack(t: number): number;
export function easeInCubic(t: number): number;
```

`src/render/hand.ts` — a stateful `HandView` (Pixi) that owns the card
containers and the transient "flying" (played) cards:

- Builds a rounded-rect card face from a `CardDef` (border color keyed to
  `active` / `passive` / bonus, cost pip, name band, tag art box, wrapped
  description, `[n]` slot hint). Empty slots render a faint dashed placeholder.
- Each frame it composes `idleTransform` onto the resting slot pose.
- It detects a **play** by diffing each slot's `CardInstance.instanceId`
  against the previous frame (robust for actives, passive-retires and bonus
  plays alike, none of which need to change the event stream): the old card is
  snapshotted into a detached "flying" container animated by `playTransform`
  then destroyed, and the new occupant deals in via `dealTransform`.
- The bonus slot renders as the same card with a golden border and a soft
  pulsing glow; it flies out the same way when consumed.

`src/render/scene.ts` — delegates the hand region to `HandView` (replacing
`drawHand`, `handSlots`, and the `bonusText` string), forwarding the per-frame
wall-clock time it already has access to. The hand area's vertical budget grows
so portrait cards fit (`SCREEN_HEIGHT` / `HAND_Y` constants only).

## Invariants tested (`card-anim.test.ts`)

- `idleTransform` is bounded (`|offsetY| ≤ IDLE_BOB_PX`, `|rotation| ≤ tilt`)
  for all times, and different slots are out of phase (differ at t=0).
- `playTransform(0)` equals `REST_TRANSFORM`; `playTransform(1)` is fully faded
  (`alpha === 0`), lifted (`offsetY < 0`) and enlarged (`scale > 1`); `alpha`
  is monotonically non-increasing across the range.
- `dealTransform(0)` starts below (`offsetY > 0`), shrunk (`scale < 1`) and
  transparent (`alpha === 0`); `dealTransform(1)` equals `REST_TRANSFORM`.
- `easeOutBack` overshoots (exceeds 1 somewhere in (0,1)); `easeInCubic` and
  `easeOutBack` fix the endpoints (`f(0)=0`, `f(1)=1`).

## Out of scope

- Any change to sim, cards, events, or the draw/discard rules.
- Card **art** beyond procedural shapes (no illustrations or sprite-sheet card
  faces); the tag "art box" is a colored glyph, swappable later.
- Mouse hover/drag selection of cards — cards are still played via `1/2/3`/`B`.
- Sound.
