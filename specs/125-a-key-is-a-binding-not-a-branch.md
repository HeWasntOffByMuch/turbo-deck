# 125 — a key is a binding, not a branch

> **The number is shared.** `specs/125-an-explosion-is-a-crystal.md` carries it too: the VFX arc and
> the GUI arc were written on parallel branches and both had taken it by the time
> they met. Renumbering either would have rewritten a couple of hundred references
> in files that are otherwise finished, so the number stays ambiguous and the
> filename is what identifies this one. `main` already carries duplicate 118s for
> the same reason.


## Problem

The Play tab reads `event.code` and `event.key` directly and decides what they
mean inline (`world/view.ts:403-436`): `Number(event.key) - 1` indexes the hotbar,
`event.code === 'Escape'` cancels a cast, and `MOVE_KEYS[event.code]` drops a
standing order. Nothing can be rebound, nothing can be listed, and the same
physical key cannot mean two things in two contexts.

`intent.ts` carries the duplication into a pure module: `MOVE_KEYS` has eight
entries for four directions, because WASD and the arrows are listed separately.
That is two bindings of one action, spelled as two actions.

Spec 122 gave us windows and tabs to build a keybinding screen in. This spec gives
the game a vocabulary of *actions*, a map from physical keys to them, and the
window that edits it.

## Shape

### An action is an id in a category

```ts
// src/ui/input/actions.ts
export type ActionCategory = 'movement' | 'combat' | 'skillbar' | 'ui' | 'debug';

export interface ActionDefinition {
  readonly id: string;              // 'move.north', 'skillbar.3', 'ui.cancel'
  readonly category: ActionCategory;
  readonly label: string;           // what the keybinding window shows
  /** Which context this action is resolved in. */
  readonly context: BindingContext;
}
export const ACTIONS: readonly ActionDefinition[] = …;
```

Data, not code: the ids and their default keys come from
`src/ui/input/bindings.json`, validated against a committed schema like the theme.
"Defaults ship as data" is the brief's phrasing and it is also what lets the
keybinding window offer *reset* without a build step.

### A binding is a chord, and there are two per action

```ts
export interface Chord {
  readonly code: PhysicalKey;       // 'KeyW', 'Digit1' -- layout independent
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}
export type BindingContext = 'gameplay' | 'ui';

export class InputMap {
  resolve(code: PhysicalKey, mods: Modifiers, context: BindingContext): readonly string[];
  bindingsFor(actionId: string): { primary: Chord | null; secondary: Chord | null };
  /** What else already uses this chord in this context. */
  conflicts(chord: Chord, context: BindingContext, exceptAction?: string): readonly string[];
  bind(actionId: string, slot: 'primary' | 'secondary', chord: Chord | null): void;
  reset(actionId?: string): void;
}
```

Two things worth being explicit about. A chord's `code` is
`KeyboardEvent.code`, so a binding is to a *position* on the keyboard and survives
a layout change -- the alternative binds to whatever letter a Dvorak user's `W`
produces. And `context` is why the same key can mean two things: `Digit1` casts an
ability in `gameplay` and does nothing in `ui`, so a keybinding row can capture it
without the game firing an ability at the same time.

Conflict detection *reports* rather than refuses: `bind` always succeeds, and the
window asks "already bound to X -- replace?" before calling it. A map that silently
refuses an edit is a map the player fights.

### The four move actions replace eight key entries

`intent.ts` stops speaking key codes. `MOVE_KEYS` becomes `MOVE_ACTIONS`, keyed by
`move.north|south|east|west`, and WASD and the arrows become the primary and
secondary bindings of those four actions. This is a simplification, not a rename:
the "arrows do the same as WASD" case moves from a table to a binding, which is
where a player can change it.

### The window

`src/ui/screens/keybindings.ts`, built on spec 124's `TabPanel` -- one tab per
category, and a `TextField` that filters rows by label. Each row is the action's
name, its two chords as buttons, and a reset. Clicking a chord button enters
*capture*: the row swallows the next key event and binds it. An unbound action is
visibly flagged rather than blank, because blank reads as "no name" and not as
"nothing will happen".

Capture pushes the `textEntry` context, for exactly the reason a text field does:
while capturing, `Digit1` must not also cast.

### Persistence, beside the layout

```ts
export interface StoredBindings {
  readonly version: number;
  /** Only what differs from the defaults, so a new default reaches old profiles. */
  readonly overrides: readonly { readonly actionId: string; readonly primary: Chord | null; readonly secondary: Chord | null }[];
}
```

Diffs rather than a full dump, and that is the load-bearing decision: storing every
binding means a player who saved a profile before an action existed never gets its
default, and a rebalance of the default keys never reaches anybody. Same
`StorageLike` injection and the same "return null rather than throw" rule as spec
122's layout.

## Invariants tested

- Every action in `ACTIONS` has a unique id, a category, a label, and at least a
  primary default -- asserted over the committed document, so a new action cannot
  be added half-way.
- `resolve` returns the actions bound to a chord in that context, and **only** in
  that context: the same code in another context returns nothing.
- Modifiers are part of the match: `Shift+KeyA` does not fire an action bound to
  bare `KeyA`, and bare `KeyA` does not fire one bound to `Shift+KeyA`.
- `conflicts` names every other action using a chord, excludes the action being
  rebound, and is empty for a free chord.
- `bind` then `resolve` returns the new action; the old chord resolves to nothing.
- Unbinding leaves the action with no chord and `resolve` returns nothing for it.
- `reset(id)` restores one action's defaults; `reset()` restores all of them.
- Round trip: only overrides are stored, an unmodified map stores none, and
  loading a document that mentions an unknown action ignores it rather than
  throwing.
- A stored profile that predates an action still yields that action's default.
- `intent.ts` gives the same movement for `move.north` that it used to give for
  `KeyW`, and arrows still work -- through the binding rather than the table.
- The keybinding window: filtering hides non-matching rows, capture binds the next
  key, capture pushes and pops `textEntry`, an unbound row is flagged, and reset
  restores.
- No file outside `src/ui/input/` and the one adapter reads `KeyboardEvent.key` or
  branches on a raw `code` for gameplay. Asserted by a lint rule, not by reading.

## Out of scope

- **The editor and the sandboxes.** They keep their own pointer handling; they are
  dev surfaces and not player-facing input (settled in
  `docs/ui/00-architecture.md` §12).
- **Mouse buttons as bindable actions.** Right-click-to-move is wired directly and
  stays that way this phase; the chord type has no button field yet.
- **Gamepad.** The chord type would need a second kind; nothing here forecloses it.
- **Touch.** Spec 093's gestures are not bindings and do not become them.
- **Drag and drop, inventories, shops** -- phases 4 and 6.

Tested by `src/ui/input/*.test.ts`, `src/ui/screens/keybindings.test.ts` and new
goldens over the keybinding window; `npx tsx scripts/preview-world.ts` is what
confirms the Play tab still plays after the adapter lands.
