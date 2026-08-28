# 227 — A character that keeps your name

## Problem

Three gaps, and they are the same gap seen from three sides: registering is a
feature nobody can find, and when they do find it their name does not stick.

**A claim does not rename the character.** `AuthService.register` with a
`guestToken` attaches the guest player to the new account and issues a session
carrying the chosen display name — and never writes that name onto the
**player**. Measured: register as `Ada Lovelace` while playing a guest, and the
session says `Ada Lovelace`, the account row says `Ada Lovelace`, and
`players.display_name` still says `Wanderer`. So does the name over the body,
which is `session.record.displayName`. The fresh-registration path is correct,
because `newCharacter(playerId, displayName, …)` writes it; the claim path — the
one the whole feature exists for — has no writer at all.

The half that a database-only fix silently loses: **the player is logged in
while they register.** That is what claiming means. `PlayerManager` holds the
authoritative in-memory record, so the next autosave flush writes `Wanderer`
back over any row this touches. The rename has to reach the live session or it
is undone within twenty-five seconds.

**The window has no button.** Spec 226 built the account screen and bound it to
`ui.account`, and a keybinding is not discoverable — the same finding spec 140
recorded about `I` and `C` before the window buttons existed. A guest's
character is claimable by one press and nothing on screen says so.

**The window has never been looked at.** Every other screen in the gallery has
golden frames; the account screen has none, so "it matches the other windows"
has been a claim rather than a check. Its Register/Sign in header is two
`Button`s in a `Row` — the framework has `TabStrip`/`Tab`, which is what the
character sheet and the options window draw, and two buttons that grey
themselves out are a different-looking answer to the same question.

## Shape

```ts
// src/server/persistence/player-repository.ts
rename(id: string, displayName: string): boolean;

// src/server/auth/auth-service.ts — an injected capability, like `adminVerifier`
interface AuthServiceOptions {
  readonly onPlayerRenamed?: (playerId: string, displayName: string) => void;
}

// src/server/player/player-manager.ts
rename(playerId: string, displayName: string): boolean;

// src/server/server.ts
renamePlayer(playerId: string, displayName: string): boolean;

// src/render/iso3d/world/hud.ts
setAccount(state: { readonly signedInAs: string | null }): void;
onAccount(handler: () => void): void;

// src/ui/screens/account.ts — the header, in the framework's own tabs
private readonly modes = new TabStrip();
```

The rename is **two writers and both are required**: `PlayerRepository.rename`
inside the claim's own transaction, and the live `PlayerManager` session through
the injected callback, fired **after** the transaction returns so a rolled-back
registration renames nobody in memory. The record is **replaced, not mutated**,
because `clearDirtyIfUnchanged` compares identity — a mutated record would let a
flush that started before the rename clear the dirty mark the rename set.

Nothing new crosses the wire. The name over a body is already the `Identity`
field derived from `session.record.displayName`, so every other client sees the
new name on the next delta.

The button is bottom-left above the weapon switch, built from the same
`layout.systemButton` box, border, background and caption face as the three
window buttons in the opposite corner — so it *is* that button, in the corner
the request asked for. Its label is the state rather than a fixed word:
`REGISTER` while a guest, the account's own name once signed in, because the
reason it exists is that a guest cannot find the claim, and after the claim its
job is to be the way back. It carries `data-hud-bottom`, which is free: the chat
log's clearance is already the topmost of everything marked.

## Invariants tested

- Registering with a guest token renames that player: the row, the record the
  manager holds, and the `Identity` a second client is sent.
- Registering with a guest token who is **logged in** survives a flush — an
  autosave after the claim writes the new name, not the old one.
- A registration that fails (login taken, already claimed) renames nobody, in
  the row or in memory, and leaves the guest playable.
- Registering with no guest token still names the fresh character, unchanged.
- Logging into an existing account renames nothing: that account's player keeps
  its own name, and the guest left behind keeps its own.
- Registering with a blank display name falls back to the login, which is
  `displayNameFrom`'s existing rule and is asserted through the claim path.
- `rename` on a player who is not logged in is a no-op in memory and still
  correct on disk.
- The button opens the account window, and only the account window.
- The button's label is `REGISTER` for a guest and the account name when signed
  in.
- Every caption the button can draw fits inside its box, as a sum, like every
  other caption along that edge.
- The chat log clears the button: `data-hud-bottom` includes it.
- Golden frames for the account window: guest/register, guest/sign-in, signed
  in, and a refused draft — rendered through both backends, byte for byte.

## Out of scope

- **Naming a guest.** Every guest is `Wanderer`, because the client posts
  `/api/auth/guest` with no display name. That is a separate gap with a separate
  answer (a name field before the first connection, or `?name=`), and this spec
  is about the name surviving *registration*.
- **Renaming without registering.** There is no "change my display name"
  anywhere, and adding one means deciding whether names are unique, which they
  are deliberately not today (the *login* is unique; the display name is not).
- **A second character per account.** Untouched.
- **Merging a guest into an existing account on login.** Spec 226 declined this
  deliberately and it stays declined.
