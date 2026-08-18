# 176 — What an item says about itself

## Problem

Hovering a bag cell says three things: the item's name, `x6` when it stacks, and
`Requires level 9` when it does not. Everything else a player would want before
deciding whether to wear, sell or throw away what they just picked up -- what it
does to their numbers, how unusual it is, what it is worth -- is in
`data/items.ts` and reaches the interface nowhere.

Rarity is the sharper half of that gap, because it is already *drawn* -- spec 158
gave every tier a colour and a drop in the grass wears it -- and the moment the
item is picked up that colour is thrown away. A player watches a blue thing land,
walks over, takes it, and it is grey in the bag like everything else. The tier
they were shown is not a fact they can look up again anywhere.

So: the tooltip says what the item does, and the item is drawn in its tier's own
colour -- the *same* colour, from the same numbers, rather than a second set that
would drift the first time either was retuned.

## Shape

**One colour table, in the theme.** `theme.json`'s palette gains `rarityCommon`,
`rarityRare` and `rarityExceptional`, at exactly the values `drop-rig.ts` has
been drawing drops in (`#b9c2cc`, `#6fb4ff`, `#ffc861`), and `TIER_COLOR` in
`drop-rig.ts` is derived from them instead of authored beside them. The palette
cap goes from 16 to 19 in `schemas/ui-theme.schema.json` and its test: the cap is
against *invented* colour and palette drift, and these three are not new art --
they are the world's own, brought inside so both ends name one thing.

```ts
// src/ui/widgets/item-slot.ts -- a name table, never a colour
export function rarityToken(rarity: string): string;   // unknown -> common
```

**Rarity and the described lines reach the interface on the `ItemView`**, which
is assembled in `render/iso3d/world/inventory-model.ts` as everything else the
screens read is. `src/ui/` may not import `server/state`, so the item table is
read out here and handed over as plain rows.

```ts
// src/ui/widgets/item-slot.ts
export type DetailTone = 'rarity' | 'good' | 'bad' | 'dim' | 'normal';
export interface ItemDetail { readonly text: string; readonly tone: DetailTone; }

export interface ItemView {
  // ...as before...
  /** The tier id, `'common'` for anything the table does not place. */
  readonly rarity: string;
  /** The tooltip's body, tier line and stats included, in display order. */
  readonly details: readonly ItemDetail[];
}
```

A *tone* rather than a palette token, because the model is in `src/render/` and
whether a drawback is red is a fact about the theme. `inventory.ts` maps tone to
token, which is what `Label.colorToken` already does everywhere else.

**The tooltip takes lines.** It has drawn one wrapped run of text since spec 124,
and prose still works exactly that way -- the character sheet passes a string and
nothing about it changes.

```ts
// src/ui/widgets/tooltip.ts
export interface TooltipLine { readonly text: string; readonly colorToken?: string; }
export type TooltipContent = string | readonly TooltipLine[];
point(content: TooltipContent | null, at: Point, now: number): void;
get label(): string;   // the lines joined by newlines, for tests and probes
```

Each line wraps on its own and every fragment keeps its line's colour, so a long
name folds without taking the stat under it with it.

**What a tooltip says**, in order, omitting any line with nothing to report:

```
Keen Longsword          <- the name, in the tier's colour
Rare  Main Hand         <- tier and where it is worn, in the tier's colour
+8 Damage               <- good
+6 Range                <- good
+15% Attack Speed       <- good
Requires level 5        <- bad, and only when the character cannot meet it
Worth 90 coins          <- dim ("Cannot be sold" at value 0, which is not free)
```

Stat lines come from `StatModifier` through one table in `inventory-model.ts`,
beside `ICONS` and the slot names, for the reason stated there: this is art
direction and `data/items.ts` is game rules. Each row carries a display name, how
the number is written (flat or percentage) and whether higher is better -- one
field, so a stat where less is more cannot be coloured as a benefit by accident.

## Invariants tested

- Every `RarityId` has a palette token, and `rarityToken` answers `common` for an
  id it has never heard of -- the same totality `rarityFromByte` has, and for the
  same reason: a client a build behind draws a quiet item rather than throwing.
- `drop-rig.ts`'s tier colours equal the theme's rarity palette exactly, so the
  bag and the grass cannot drift.
- The palette stays within its (raised) cap, and every rarity token resolves.
- A tooltip built from lines draws each in its own colour, and a plain string
  still produces exactly what it produced before.
- Wrapping is per line: a name too long to fit does not merge with the line under
  it, and each wrapped fragment keeps its line's colour.
- Same text, cursor moved: the delay still does not restart -- including for
  line content, where "same" is text *and* colour.
- An item's tooltip names its tier, its slot, each modifier it carries and its
  worth; a drawback is toned `bad` and a benefit `good`; `Requires level N`
  appears only when the character is below it.
- A modifier field with no row in the label table draws no line at all, rather
  than a raw key -- an unknown stat is a missing description, not a crash.
- `itemViewOf` puts the row's rarity on the view, and `common` for an id the
  table no longer defines.
- The golden images: a bag holding one item of each tier, and its tooltip.

## Out of scope

- **Trait grants.** `TraitModifier` is ~100 fields and no item in the table
  grants one. The tooltip describes the classic half; a trait line waits for an
  item that has one.
- **Comparison against what is worn.** "+3 damage over your current sword" is the
  obvious next thing and it needs the paperdoll's numbers threaded into every
  cell's tooltip; it is a spec of its own.
- **The shop and the ground.** Shop rows draw no icon today and a drop on the
  ground already has spec 158's presentation. This is the bag, the paperdoll and
  the trade table -- everywhere an `ItemSlot` is drawn.
- **Per-drop rarity.** Unchanged from spec 158: rarity is a property of the row,
  so two copies of a sword are the same tier forever.
