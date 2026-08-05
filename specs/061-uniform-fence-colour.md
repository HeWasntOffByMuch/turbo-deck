# 061 — Colour variety as a fence option

## Problem

Every fence style mottles itself: boards are drawn from four timber tones,
rubble from three stone tones, brick from three fired-clay bands, and every part
drifts a little further with the tile's own tint. That is right for a hedgerow
fence or a field wall, and wrong when a run is meant to read as one built thing
— a courtyard wall in a single batch of brick, a painted fence — where the
mottling reads as dirt rather than as material.

It is not a renderer-wide preference. Two runs in the same map can reasonably
want different answers, so the choice belongs to the fence, is made when it is
painted, and has to survive a save.

## Shape

A per-prop flag, exactly like `alignToNormal` (spec 051) — the *intent*, stored
on the prop, resolved by the renderer:

```ts
// terrain/vegetation.ts
export interface Prop {
  // ...
  /** Draw this prop in one colour per material instead of its varied tones. */
  readonly uniform?: boolean;
}

// terrain/map.ts — the document's side of it, alongside `align`
export interface MapProp {
  // ...
  readonly uniform?: boolean;
}
```

Absent means varied, so nothing already saved changes and the generated forest
is untouched.

The renderer resolves it against a new per-part fallback:

```ts
interface PropPart {
  // ...
  /** The colour this part takes when its prop asked for one flat tone. */
  readonly uniformColor?: number;
}
```

A uniform prop draws `uniformColor ?? color` and skips both colour drifts
(`tintAmount` and `jitterTint`). What it does *not* skip is colour that is
structural rather than decorative: a picket fence's posts stay darker than its
rails, because that is two materials and not one material varying.

The tool side is one checkbox in the Fence folder, on by default:

```ts
export interface FenceSettings {
  readonly style: FenceStyle;
  readonly fenceScale: number;
  /** Off lays tiles that are one flat colour per material. */
  readonly variedColor: boolean;
}
```

## Invariants tested

- A tile painted with variety off carries `uniform: true`; with it on, the flag
  is absent rather than `false` — the document does not grow a field per prop
  for the default.
- The flag survives the document round trip, in both directions, and a document
  written before this existed still parses and still draws varied.
- A uniform tile builds with strictly fewer distinct colours than a varied one
  of the same style, and more than zero.
- Two uniform tiles at different positions and tints draw the *same* colours —
  which is the whole point, and is what neither the per-part bands nor the
  per-instance drift would allow.
- Uniform changes colour only: instance positions of a uniform tile match those
  of a varied one exactly, so the flag cannot quietly reshape a wall.
- Structural colour survives: a uniform picket tile still has more than one
  colour, because its posts are not its rails.

## Out of scope

- Choosing *which* colour a uniform run takes. It is the style's base tone; a
  colour picker is a different feature and a much wider one (it would have to be
  stored per prop as a value rather than a flag).
- Applying the flag to trees and bushes. Nothing in the editor paints them with
  a variety choice, and foliage's autumn turn is a different mechanism.
- Retroactively flattening an existing run: the flag is set when a tile is laid,
  so changing a painted run means erasing and re-painting it.
