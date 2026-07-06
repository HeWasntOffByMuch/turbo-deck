# 010 — Juice: damage popups, attack wind-up, character sprites

## Problem

Combat is readable (spec 008) but flat: hits register only as a health-bar
tick and a colour flash, the player's attack lands the instant it is pressed,
and the actors are plain circles. This spec makes hits feel impactful and gives
attacks anticipation, without breaking the sim/render split or determinism.

Three changes:

1. **Player attack wind-up (sim rule).** Pressing attack no longer resolves
   damage immediately. It begins a short **wind-up**; the aim direction is
   captured at that moment, and the strike resolves `PLAYER_ATTACK_WINDUP_TICKS`
   later against the enemy's position then. The player is rooted for the whole
   wind-up (and a brief recovery after). This adds commitment and gives the
   renderer an anticipation pose to show.
2. **Floating damage/heal numbers (render only).** Each `enemyHit` /
   `playerHit` / `playerHealed` spawns a short-lived number that drifts up and
   fades at the actor's position, coloured by kind.
3. **Character sprites (render only).** Player and enemy are drawn as small
   pixel-art "dude" sprites (idle + wind-up frames), facing their target,
   tinted on hit/heal — replacing the circles. Sprites are built from in-repo
   pixel data into textures at load; the module is structured so a real
   exported sprite sheet (e.g. from the pixeldudesmaker generator) can replace
   the placeholder art without touching the scene.

## Shape

`src/sim/constants.ts` — `PLAYER_ATTACK_WINDUP_TICKS` (~12); `ATTACK_ROOT_TICKS`
becomes the post-strike recovery.

`src/sim/types.ts` — `PlayerState` gains `attackReleaseTick` (0 = no swing
pending) and `attackAimX` / `attackAimY` (aim captured at wind-up start).

`src/sim/combat.ts` — `step`:
- If attack is pressed, off cooldown, and no swing is pending: begin a wind-up
  (`attackReleaseTick = tick + PLAYER_ATTACK_WINDUP_TICKS`, store the aim).
- The player is rooted while a swing is pending or within the recovery window.
- When `tick` reaches `attackReleaseTick`: resolve the strike against the
  enemy's current position using the stored aim (same reach + cone test,
  strike counter, and modifier bonuses as before), then start the cooldown and
  recovery and clear the pending swing.
Identity-modifier, non-attacking behaviour (enemy AI, defense timing, cards) is
unchanged.

`src/render/` — a damage-popup layer (pooled `Text`, cosmetic frame timers),
and a `sprites.ts` that turns pixel-row data + palettes into nearest-neighbour
textures for player/enemy idle and wind-up frames. The scene selects the
wind-up frame while an attack is pending (player) or during the enemy windup,
flips the sprite to face the target, and tints it for hit/heal flashes. No game
rules move into the renderer.

## Invariants tested

- Replay determinism (spec 003) holds with the new player fields.
- Pressing attack does not deal damage on the same tick; `enemyHit` (or
  `attackMissed`) fires exactly `PLAYER_ATTACK_WINDUP_TICKS` later, once.
- The player cannot move while a swing is pending or during recovery, and can
  move again afterwards.
- The strike uses the aim captured at wind-up start, not a later aim.
- Modifier bonuses (flat / every-Nth-strike) still apply, now at release.

## Out of scope

- Enemy attack already telegraphs (spec 007); no change to it here.
- Cancelling a wind-up, or aim-tracking during the wind-up.
- Real exported sprite-sheet art and audio; the placeholder sprites and the
  swap seam are provided, sourcing the final art is a follow-up.
