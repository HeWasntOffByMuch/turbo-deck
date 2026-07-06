# 007 — Top-down 2D combat

## Problem

The combat sim (spec 003) modelled position as a single scalar on a line and
resolved the enemy attack with no spatial component: the enemy hit the player
regardless of where they stood, and the player's attack connected on 1D
distance alone. That is fine for proving the parry/dodge timing loop but it
does not read as an action game. This spec turns combat top-down and 2D
without touching the sim/render split or the determinism guarantees:

- Movement is directional in a rectangular arena (`moveX`/`moveY`), not
  left/right on a line.
- The player's attack is **aimed** (toward the mouse in the renderer); it
  only connects if the enemy is within reach *and* inside a cone around the
  aim direction.
- The enemy's attack becomes **positional**: during windup it telegraphs a
  circular danger zone snapshotted at the player's location, drawn as an
  orange area by the renderer. At resolution the hit only lands if the player
  is still inside that zone — so moving out of the area avoids the hit by
  position, while a frame-tight parry/dodge still negates it *and* draws a
  bonus card (the mechanic from specs 003/004 is unchanged).
- The enemy homes toward the player and holds at a standoff so that attack
  range is meaningful.
- The renderer gains a top-down view, the orange telegraph area, and radial
  cooldown rings over the player (attack cooldown) and enemy (attack cycle).

All new geometry uses integer/float vector arithmetic and dot products only —
no `Math.random`, no wall-clock, no trig in the hot path — so the sim stays
bit-deterministic under the existing replay property.

## Shape

`src/sim/types.ts` — `Vec2 = { x: number; y: number }`. `PlayerState.position`
and `EnemyState.position` become `Vec2`. `EnemyState` gains
`attackZoneCenter: Vec2 | null` (set at windup start, null otherwise).

```ts
interface InputFrame {
  moveX: -1 | 0 | 1;
  moveY: -1 | 0 | 1;
  attack: boolean;
  aimX: number;            // aim direction, need not be normalized
  aimY: number;
  parry: boolean;
  dodge: boolean;
  externalEffect?: ExternalEffect;
}
```

New `SimEvent`: `{ kind: 'enemyAttackAvoided'; tick }` — emitted when a
telegraphed attack resolves for zero damage because the player was outside the
zone (and did not perfect/normal defend).

`src/sim/constants.ts` — 2D arena (`ARENA_WIDTH`, `ARENA_HEIGHT`), actor radii,
player/enemy move speeds, `PLAYER_ATTACK_RANGE`, `ATTACK_ARC_COS_SQ` (= 0.5, a
90° cone), `ENEMY_ATTACK_RADIUS`, `ENEMY_STANDOFF`. Damage/cooldown/window/mana
tuning from spec 003 is unchanged.

`src/sim/combat.ts` — `step` advances one tick:
1. Apply `(moveX, moveY)` to the player, normalizing diagonals, clamped to the
   arena inset by the player radius.
2. Enemy homes toward the player during idle/recovery (not windup), stopping
   at `ENEMY_STANDOFF`, clamped to the arena.
3. Attack (aimed): off cooldown and `attack` set → connects iff
   `|enemy − player|² ≤ (PLAYER_ATTACK_RANGE + ENEMY_RADIUS)²` **and** the enemy
   lies within the aim cone (`dot > 0 && dot² ≥ ATTACK_ARC_COS_SQ · |d|² · |aim|²`).
   Otherwise `attackMissed`.
4. Defense registration is unchanged (timer vs. the enemy's fixed hit tick →
   perfect/normal/whiffed), and still fires `perfectDefense` for the bonus card.
5. Enemy state machine: idle→windup snapshots `attackZoneCenter` at the player's
   current position; windup→recovery resolves the hit — damage applies only if
   the player is inside `ENEMY_ATTACK_RADIUS` of the zone center, then scaled by
   the registered defense outcome (0 perfect, halved normal, full otherwise);
   zero-damage-by-position emits `enemyAttackAvoided`.
6. External effect, mana regen, buff expiry, defeat events — unchanged.

## Invariants tested

- Replay determinism (spec 003's property) holds under the 2D input shape.
- Player position stays within the arena rectangle (inset by its radius)
  regardless of how long any direction is held.
- Standing still in the zone with no defense takes full damage; a perfect/normal
  defend still zeroes/halves it (timing tests from spec 003 preserved).
- Moving fully out of the telegraph zone during windup takes zero damage and
  emits `enemyAttackAvoided`, with no `playerHit`.
- An aimed attack connects on an enemy in range and in the aim cone, and misses
  an in-range enemy aimed away from (behind) the player.
- Card conservation, hand ≤ 3, health/mana bounds (spec 004 fuzz) hold under
  the 2D input shape.

## Out of scope

- Enemy variety or multiple enemies; the dummy still has one telegraphed slam.
- Leading the telegraph (it snapshots the player's position, it does not
  predict movement).
- Gamepad/analog movement; movement input stays 8-directional.
