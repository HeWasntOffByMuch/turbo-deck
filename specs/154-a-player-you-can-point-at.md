# 154 — A player you can point at

## Problem

The admin console's wire works. Driven against a live server with three bots
attached, `admin:auth`, `admin:listPlayers`, `admin:getConfig` and
`admin:getAudit` all answer correctly, and the page renders every table it is
sent. Nothing in the transport, the token or the codec is broken.

What is broken is that it cannot be *operated*:

- **The player list is a button.** There is no live count, and nothing refreshes
  — an operator watching for somebody to log in clicks "list connected players"
  over and over.
- **Every action wants a player id typed in**, into one of three unlinked text
  boxes (`#modPlayer`, `#tpPlayer`, and none at all for the rest). The list and
  the actions are two unconnected halves of the page: you read an id off a table
  and retype it, per action, correctly, or you moderate the wrong person.
- **The routine operator actions do not exist.** Levels, experience, items and
  kill are the things somebody testing a build actually needs, and the console
  offers ban, mute, teleport, spawn and a raid.
- **A read is audited like a decision.** `admin:listPlayers` writes an audit
  entry; its read siblings `getConfig` and `getAudit` do not. So the log
  disagrees with itself about what an audit is for, and polling the list at 1Hz
  — which is what a live count is — would bury every real decision under
  "3 online" once a second.

## Assumptions

- **The wire is fine and this spec does not rewrite it.** New message types are
  appended to the `admin:*` range; no existing code, field or order moves.
- **`grantExperience` already exists** on `PlayerManager`, with the level-up
  loop and the skill-point award, because monsters award experience through it.
  The experience half of this is that method reached from a second caller, not
  new arithmetic.
- **`AdminHost` is the seam.** Everything new is a method on it, so every action
  stays testable by calling `AdminRouter.handle` against a fake host, which is
  how the existing ones are covered.

## Shape

### Four progression edits, one message

The operator's four asks — give levels, give experience, reset levels, reset
experience — are two verbs over two fields, so they are one message with a mode
rather than four type bytes:

```ts
export const AdminProgressMode = {
  AddLevels: 0,
  SetLevel: 1,
  AddExperience: 2,
  SetExperience: 3,
} as const;

export interface AdminSetProgressRequest {
  readonly type: typeof AdminMessageType.SetProgress;   // 0x8d
  readonly playerId: string;
  readonly mode: AdminProgressModeValue;
  /** u32. Adds are non-negative by construction; a decrease is a `Set`. */
  readonly amount: number;
}
```

"Reset levels" is `SetLevel 1` and "reset experience" is `SetExperience 0`, so
the reset buttons are not a third code path that could disagree with the grant
ones about what a consistent record looks like.

### The arithmetic is pure, and lives in `player/levels.ts`

```ts
export const MAX_PLAYER_LEVEL = 60;
export function earnedSkillPoints(level: number): number;
export function applyLevelEdit(
  player: PersistedPlayer,
  mode: AdminProgressModeValue,
  amount: number,
): { readonly player: PersistedPlayer; readonly detail: string; ... };
```

Named `levels.ts` rather than `progress.ts` so it sits beside spec 147's
`progression.ts` without either name suggesting it does the other's job: this
file is a level and what a level hands out, that one is what an attribute
allocation amounts to.

Pure, so the rules below are tested without a store, a session or a socket.
`PlayerManager.setProgress` commits what it returns and calls `recalculate`,
which is the existing single funnel every stat change already passes through.

Three rules, and each closes a way the record could be left saying something
impossible:

- **Both point budgets are re-derived from the level, never adjusted.**
  `earnedSkillPoints(level) = 1 + (level - 1) * SKILL_POINTS_PER_LEVEL` — the 1
  is the point `createCharacter` starts a character with — and the attribute
  budget defers to `attributes.ts`'s own `pointsEarned`, one place per currency.
  Unspent becomes `earned - spent` for each. Adding a delta instead would let an
  operator who granted 5 levels and then reset the level to 1 keep the points.

- **A level reset that cannot pay for what it holds gives it back.** You cannot
  hold twelve points of skills, or a level-40 attribute spread, at level 1. Each
  currency is checked independently: the tree is cleared, the attributes go back
  to their starting spread, every point is handed back, and the reply says so —
  an operator who reset a level and silently lost a build would find out from
  the player.

  This rule points the *opposite* way to the one `reconcileAttributePoints`
  applies on login, which keeps an over-budget allocation and hands back zero.
  Deliberately, because the causes differ. An over-budget *save* is somebody
  else's bug — a table edit, a schema change — and the character is innocent, so
  the generous reading is right. An over-budget *edit* is what the operator just
  asked for on purpose, and keeping the allocation would mean "reset level"
  leaves a level-1 character wearing a level-40 spread for good — the reset only
  looked like it worked.

- **Experience is clamped into its own level's band.** After any mode,
  `experience = min(experience, experienceForLevel(level + 1) - 1)`, so no
  record ever sits at a level while already holding enough experience for the
  next one. This is what stops `SetLevel 1` on a level-20 character from being
  a character who re-levels to 20 on their next kill.

`MAX_PLAYER_LEVEL` is the first level cap this game has stated, and it is stated
here for one narrow reason: `HP_PER_LEVEL` and the rest of `computeEffectiveStats`
are linear in the level, so an unclamped `AddLevels 1000000` from a typo is a
body with ten million health. It bounds an admin edit; nothing in the sim reads
it, and it is not a claim about where the game ends.

### Giving an item, and knowing what to give

```ts
export interface AdminGiveItemRequest {
  readonly type: typeof AdminMessageType.GiveItem;      // 0x8e
  readonly playerId: string;
  readonly defId: string;
  readonly count: number;   // u16
}
```

`PlayerManager.giveItem` goes through `addToInventory`, which is all-or-nothing:
a bag that cannot hold the whole stack takes none of it and the operator is told
"their bag is full" rather than being left guessing how many of six landed.

The console cannot know the item ids — it is a hand-written page with no
bundler, so it cannot import `ITEMS` — and an operator should not have to
remember `chest.leather`. So the catalog is asked for:

```ts
{ type: AdminMessageType.GetItems }                     // 0x8f
{ type: AdminReplyType.ItemList, items: AdminItemRow[] }// 0xa5
// AdminItemRow: { id, name, slot, levelRequirement, maxStack }
```

It is read once on authenticate and fills a `<select>`. Its counted collection
is decoded with `reader.count()`, spec 152's primitive, which the existing three
admin replies predate.

### Kill

```ts
{ type: AdminMessageType.Kill, playerId: string }       // 0x90
```

A kill is the entity's health set to zero and nothing else invented: the sim's
own sweep marks a zero-health player `Dead` and leaves the body in the world,
and `handleRespawns` already sends "You have fallen" and puts them back on their
feet after `RESPAWN_DELAY_TICKS`. So the whole death path runs, and an admin
kill and a monster's kill end the same way.

One thing the sim's sweep does *not* do is cancel a trade — only the `'died'`
event does, and that event is emitted by `abilities.ts` when a blow lands, not
by the sweep. So `GameServer.kill` cancels the victim's trade itself, exactly as
the `'died'` handler does. Without it, "kill the player who is mid-trade" is the
one way to be dead and still at the table.

### The row grows what an operator is about to change

`AdminPlayerRow` gains four fields, appended: `experience`,
`experienceToNextLevel`, `unspentSkillPoints` and `unspentAttributePoints`.
Experience alone is not readable without the threshold, and the threshold's
formula lives on the server, so the row carries both and the console renders
`340 / 670`. Both point budgets are there because a level grant moves both, and a
console that showed one of them would make half of what the button did invisible.

### A read is not a decision

`admin:listPlayers` stops writing an audit entry, joining `getConfig` and
`getAudit`. The audit log records what an admin *did*, and asking who is online
is not something done to anybody. This is what makes a 1Hz live count possible:
the console polls the list while connected, and the log still holds only
decisions.

### Three outcomes with a reason, not three conventions

`kick` returns `boolean`, `triggerEvent` returns a description where `''` means
refused. Rather than adding a third convention, the three new player actions
return one type:

```ts
export interface AdminOutcome { readonly ok: boolean; readonly detail: string }
```

so "their bag is full" and "no such item: sord.worn" reach the operator instead
of being flattened into "could not give item".

### The console

Rewritten as one page with a selection, not a form per action:

- A **live player table**, polled at 1Hz while connected, with the count in the
  header. One row is selected; the selection is held by `playerId` so a poll
  cannot move it.
- One **action panel bound to that selection**, with no id fields in it at all:
  progression (level and experience readout, give / reset), items (catalog
  dropdown, count, give), and presence (kick, kill, teleport, mute, ban).
- The **world tools below** it, unchanged in capability: spawn, despawn, event,
  broadcast, live config, audit.
- The **token is remembered** in `localStorage` and reconnects on load, because
  a throwaway secret per boot means pasting a JWT is the first thing an operator
  does every single time.
- Every action is refused client-side when nothing is selected, so a stray
  click cannot send a request with an empty player id.

## Invariants tested

- **Progression arithmetic** (`levels.test.ts`, pure): `AddLevels` grants both
  budgets; `SetLevel 1` on a level-20 character with a spent tree clears the tree
  and returns exactly the earned points; the same on a level-40 attribute spread
  returns it to the starting spread; the two refunds fire **independently**, so a
  level low enough to give back the tree and high enough to keep the spread does
  exactly that; `SetLevel` upward and downward both leave
  `unspent = earned - spent` for each currency; experience never survives above
  its own level's threshold; `AddExperience` levels up as far as it carries and
  `MAX_PLAYER_LEVEL` is never exceeded from either mode.
- **The four operator asks reach the right arithmetic** (`admin.test.ts`, via
  `AdminRouter.handle` and a fake host): give levels, give experience, reset
  level and reset experience each dispatch with the mode and amount they were
  sent, and an unauthenticated connection does none of them.
- **Give item**: an unknown id is refused with the id in the message; a full bag
  is refused and the bag is unchanged; a legal give lands the whole count.
- **Kill**: zeroes the target's health, and a player killed mid-trade is no
  longer in a trade.
- **Every new message round-trips** through `encodeAdminRequest`/`decode`, and
  the item-list reply through `encodeAdminReply`/`decode`, in `codec.test.ts`
  beside the existing thirteen.
- **A list is not audited**: `admin:listPlayers` leaves the audit log's length
  unchanged, and every action that *is* a decision still writes one entry with
  the token's subject as the actor.
- **The row's new fields survive the wire**, so the console's `340 / 670` is the
  server's numbers.

## Out of scope

- **Converting the existing three admin replies to `reader.count()`.** Spec 152
  scoped the admin namespace out deliberately; the new reply uses the primitive
  and the old ones are left for whoever revisits them.
- **Giving coins, editing base stats, or spending skill points for somebody.**
  Levels, experience and items are what was asked for; a full character editor
  is a bigger surface and every field in it is a new way to write an inconsistent
  record.
- **Persisting an item grant to an offline character.** Every new action needs a
  logged-in session, because that is where the record and the entity both are.
  An offline edit is a store-level feature and belongs with one.
- **A second admin transport, or a login page.** The token stays a pasted JWT
  over the same socket.
- **Replacing the audit table, config panel or world tools.** They work; they
  move down the page and keep their behaviour.
