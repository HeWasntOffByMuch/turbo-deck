# 128 — a bar that drains without a relayout

## Problem

Phase 5 of the GUI brief is the skillbar, the HUD and the character sheet. Every
screen before it was static between clicks: a keybinding row changes when you
rebind, a bag cell changes when the server resends. **These change every frame.**
A health bar drains, a cooldown sweeps, a cast bar fills, and they do it sixty
times a second whether or not anything was clicked.

That is a real risk to the one number the brief asks to be measured. `src/ui/` is
retained-mode precisely so that a still frame does no layout work
(`docs/ui/00-architecture.md` §12, and `budget.test.ts` asserts it). A skillbar
that marked itself dirty on every tick of a cooldown would relayout the whole
screen sixty times a second and hand back exactly the cost retained mode was
chosen to avoid.

There is also a hole of the same shape as the one spec 126 closed. **Skill
allocations are not replicated.** `StatsMessage` carries level, experience,
`unspentSkillPoints` and the derived block; what a character has actually *taken*
is never sent. A client can spend a point and is never told what it owns, so a
skill tree cannot be drawn at all — the same way a paperdoll could not be drawn
from a stat block.

## Shape

### Animation is a paint-time function of the time, never a layout property

The rule the whole phase rests on, and it is the same rule the caret blink
already follows (spec 123): `PaintContext.now` is handed in, and anything that
changes with time is computed *while painting* from a value the widget already
holds. Nothing that changes every frame may call `invalidateMeasure` or
`invalidateArrange`.

```ts
// src/ui/widgets/meter.ts
export class Meter extends StyledWidget {
  /** 0..1. Setting it does NOT invalidate layout -- the rect is unchanged. */
  fraction: number;
  /** Which token the fill is drawn in: health, resource, cast. */
  fillToken: string;
  /** Optional text over the bar, e.g. "84/120". */
  caption: string;
}
```

A meter's *rect* is a function of its parent; only its fill is a function of its
value, and a fill is drawn, not laid out. So `fraction` is a plain field with no
setter and no dirty flag, and a bar that drains costs one solid quad per frame
and no layout at all. `budget.test.ts` gains the assertion that says so: drive a
hundred frames of changing values and assert `layoutPasses` never moves.

The same applies to a cooldown:

```ts
// src/ui/widgets/skill-slot.ts
export class SkillSlot extends StyledWidget {
  readonly index: number;          // its place on the bar, 0-based
  ability: AbilityView | null;
  /** Set once per frame by the screen; read at paint time. */
  sweep: number;                   // 0..1 of the cooldown remaining
  affordable: boolean;
  keyLabel: string;                // "1", "Shift+3" -- from the InputMap
  onActivate: ((index: number) => void) | null;
}
```

The sweep is drawn as a dark wedge over the icon, anticlockwise from the top —
the shape every game uses for this, and legible at 20 pixels because it is a
silhouette rather than a number. The remaining seconds are drawn over it in the
numeric face only while the wedge is showing.

### The HUD screen

```ts
// src/ui/screens/hud.ts
export interface HudView {
  readonly health: { readonly current: number; readonly max: number };
  readonly resource: { readonly current: number; readonly max: number };
  /** Null when nothing is winding up. */
  readonly cast: { readonly name: string; readonly progress: number } | null;
  readonly slots: readonly (AbilityView | null)[];
  /**
   * What each slot's key is called, beside the abilities rather than on them:
   * an *empty* slot still has a key, and "4 fires nothing yet" is worth saying.
   */
  readonly keyLabels: readonly string[];
}

export interface AbilityView {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly cost: number;
  /** 0..1 remaining, already computed against the tick being drawn. */
  readonly sweep: number;
  readonly affordable: boolean;
}

export class HudScreen extends Column {
  setView(view: HudView): void;      // called once per frame; no layout unless a
                                      // slot's *identity* changed
  onUse: ((index: number) => void) | null;
}
```

`setView` is called every frame and must be cheap. It writes fields; it only
invalidates when something structural changed — an ability appearing in a slot
that was empty, a name changing. That distinction is the phase's second
invariant and it is tested directly: the same view twice does no layout, and a
view whose only difference is a number does no layout either.

The HUD is `pointerTransparent` throughout except on the slots, exactly as the
`hud` layer already declares (spec 124): it is always on top and must never eat a
click meant for the world.

### The character sheet

```ts
// src/ui/screens/character.ts
export interface CharacterView {
  readonly name: string;
  readonly level: number;
  readonly experience: { readonly current: number; readonly toNext: number };
  readonly unspentPoints: number;
  /** Label/value pairs, already formatted. The screen does no arithmetic. */
  readonly stats: readonly { readonly label: string; readonly value: string }[];
  readonly branches: readonly BranchView[];
}

export interface BranchView {
  readonly id: string;
  readonly name: string;
  readonly locked: boolean;
  readonly pointsSpent: number;
  readonly skills: readonly SkillView[];
}

export interface SkillView {
  readonly id: string;
  readonly name: string;
  readonly tier: number;
  readonly level: number;
  readonly maxLevel: number;
  readonly description: string;
  /** Whether one more point may go in, and why not if it may not. */
  readonly canSpend: boolean;
  readonly blockedBecause: string;
}
```

`canSpend` and `blockedBecause` arrive already decided. The screen does not know
what a tier gate is: `validateSkillSpend` in `server/player/skills.ts` is the
authority and the adapter asks it, so the button that is greyed out and the
server that would refuse cannot disagree. That is the same rule the inventory
follows about the item table, and it is the reason a "why is this greyed out"
tooltip can say something true.

**Base-stat allocation is not here.** `BaseStats` are documented as chosen at
character creation and never recomputed; there is no allocate message, no respec,
and no server rule to check one against. The sheet shows them, and the skill
half is what can be spent. Adding allocation is a server spec (see Out of scope).

### On the wire: what a character has taken

```ts
export interface StatsMessage {
  // ...as before, plus:
  /** Every point spent, as {skillId, level}. Whole, never a delta. */
  readonly skills: readonly SkillAllocation[];
}
```

Added to the message that already exists rather than getting one of its own,
because it changes at exactly the moments `Stats` is already sent — login, equip,
unequip, spend, level — and a second message on the same trigger is a second
thing to keep in step. It is a handful of entries; the whole list goes every
time, for the reason spec 126 gives about the container.

This is one field on an existing message, so it does not get its own spec. What
it does get is the invariant below: a client that spends a point sees what it
owns without asking.

## Invariants tested

- **A hundred frames of changing bars, sweeps and cast progress cause zero
  layout passes.** The assertion this whole spec exists for.
- A `setView` with an identical view does no layout. A view differing only in
  numbers does no layout. A view where a slot's ability *identity* changed does
  exactly one.
- A meter clamps: a fraction below 0 or above 1 draws empty or full and never
  outside its own rect. A max of 0 draws empty rather than dividing by zero.
- A cooldown sweep of 0 draws no wedge; of 1 covers the icon; the wedge's area
  grows monotonically with the sweep.
- A slot that cannot be afforded draws differently from one on cooldown, because
  they are different problems with different fixes.
- The skillbar's key labels come from the `InputMap` (spec 125), so rebinding
  `skillbar.4` changes what the fourth slot says.
- Clicking a slot emits `onUse(index)` and nothing else; the screen never
  consults an ability's cost, cooldown or range.
- The HUD eats no pointer events except on its slots — asserted by hit-testing
  through it at a point over a bar.
- The character sheet's spend button is enabled exactly when
  `validateSkillSpend` says yes, over every skill in the table and a spread of
  allocations. A disabled one says why.
- A locked branch is drawn as locked and none of its skills can be spent.
- Round trip: a `Stats` message carrying allocations encodes and decodes to
  itself, for an empty list and a full one.
- A client that spends a point is told what it now holds, without asking — the
  end-to-end assertion, against a real server.
- Golden images: the HUD at rest, mid-cast with two cooldowns running, the
  character sheet, a locked branch, and the smallest viewport.
- Both backends agree, via the existing cross-backend comparison, and the
  browser reports the frame cost with the HUD on screen.

## Out of scope

- **Mounting any of this in the Play tab.** Nothing mounts a `UiRoot` over the
  world yet; deciding what happens to the DOM HUD, who owns the pointer, and how
  the UI's scale sits beside the world's own buffer is its own spec. Every phase
  so far has delivered to the gallery and this one does too.
- **Base-stat allocation and respec.** No server rule exists to check either
  against; it is a server spec first, like the container was.
- **Damage numbers, the target readout and anything world-anchored.** Those are
  positioned from the camera, which is `docs/ui/00-architecture.md` §2.4's other
  case — they snap to the *device* grid, not the UI grid, and they belong with
  the world rather than with a screen.
- **Buffs, debuffs and a status tray.** There is no status effect system.
- **Tweening and easing.** Phase 7. A bar here jumps to its value.
- **The weapon switch.** It works, it is DOM, and moving it is part of the
  mounting spec rather than of this one.

Tested by `src/ui/widgets/meter.test.ts`, `src/ui/widgets/skill-slot.test.ts`,
`src/ui/screens/hud.test.ts`, `src/ui/screens/character.test.ts`,
`src/ui/gallery/budget.test.ts`, the golden cases, `src/server/net/codec.test.ts`
for the round trip, `src/server/client/skills-sync.test.ts` for the replication,
and `src/render/iso3d/world/character-model.test.ts` for the adapters.
