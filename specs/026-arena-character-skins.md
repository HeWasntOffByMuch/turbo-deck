# 026 — Character skins in the arena

## Problem

The spell arena drew the player and every enemy as flat coloured circles. The
repo already ships a deterministic pixel-art sprite baker (`dude-baker`, spec
011) used by the legacy Pixi renderer. Reuse it to skin the actors in the
Canvas2D arena: the player gets a hero sprite and each enemy type its own
distinct look, keyed by type so all mobs of a type match.

## Shape

Render-only; no sim, cards, or game-layer changes.

- `src/render/spells/dudes.ts`: `DudeSkins` rasterises `bakeDude(seedFromName(id))`
  into small nearest-neighbour offscreen canvases (idle + wind-up frames) and
  blits them onto the arena Canvas2D, scaled to a target height, mirrored to
  face a direction, and faded for grazing/stunned. `PLAYER_SKIN = 'turbo-hero'`.
- `src/render/spells/arena.ts`: the player and enemies draw their baked sprite
  (feet on the ground point) with a soft ground shadow instead of a circle. The
  enemy attack-charge progress becomes a flattened ground ring; health bars,
  stun stars, burning ember and adrenaline/flame pips move above the sprite's
  head. Enemies use their type `key` as the seed; the player uses `PLAYER_SKIN`.
  The wind-up frame shows while an enemy is winding up; sprites face the player
  (enemies) or the aim (player).

## Invariants tested

- The hero and all three enemy type keys bake to **pairwise-distinct** sprites
  (guards against two identities colliding on one look).
- Existing `dude-baker` guarantees still hold (determinism, well-formed RGBA).

## Out of scope

- No animation beyond the idle/wind-up frame swap the baker already provides.
- No new art assets — only the vendored atlases the baker already uses.
- The sim/gameplay is untouched; this is purely how the arena looks.
