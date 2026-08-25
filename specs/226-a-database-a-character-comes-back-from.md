# 226 — A database a character comes back from

## Problem

Nothing survives a restart. `DataStore` has been the persistence seam since
spec 056 and its only implementation is `MemoryDataStore`, so every character,
ban and audit line lives exactly as long as the process. A playtest that
restarts the server is a playtest where everybody starts again.

Two things behind that are also wrong, and both are hidden by the Map.

**Every mutation writes the whole record.** `PlayerManager.recalculate` ends in
`store.savePlayer`, and it is what an equip, an unequip, a purchase and a spent
skill point all funnel through. Against a Map that is free. Against a database
it is a synchronous disk write on the tick path. Meanwhile the fastest-changing
persistent field there is -- position -- is written *only* at logout, because
`syncFromEntity` correctly refuses to save on every broadcast.

**And a client says who it is.** `Hello` carries a `playerId` and the server
believes it. Knowing somebody's id is enough to play as them, and there is no
account, no password and no session anywhere in the tree.

## Shape

Four modules, and the existing seam is what they hang off:

```
auth/          identifiers, passwords (scrypt), tokens, AuthService, HTTP
persistence/   sqlite, migrations, repositories, SqliteDataStore, autosave
players/       PlayerManager, unchanged except for dirty tracking
game/          server.ts and below, which learns one new type
```

`node:sqlite` rather than a native dependency, so `npm install && npm run
server` opens a database with nothing to compile. Floor of Node 22.5, stated in
`engines`.

```ts
// state/store.ts -- two additions to the seam, both about atomicity
savePlayers(players: readonly PersistedPlayer[]): Promise<void>;
transaction<T>(body: () => T): T;

// net/auth-gate.ts -- all server.ts learns. No login, no password.
interface AuthGate { resolve(token: string): AuthenticatedIdentity | null }
interface AuthenticatedIdentity {
  playerId: string; accountId: string | null;
  displayName: string; sessionId: string; kind: 'guest' | 'account';
}

// player-manager.ts -- dirty tracking, no clock (it is deterministic core)
markDirty(id): void; dirtyIds(): readonly string[];
clearDirtyIfUnchanged(id, written: PersistedPlayer): boolean;
persistNow(ids: readonly string[]): Promise<{ok: true} | {ok: false, error}>;
```

Schema: `accounts`, `players`, `sessions`, `schema_migrations`, plus the four
tables `DataStore` already promised (`bans`, `mutes`, `audit`, `chunks`).
`players.account_id` is `UNIQUE` and nullable -- NULL is a guest, and the
uniqueness is what makes a double claim impossible rather than merely unlikely.
Currency, level and experience are columns; the rest of `PersistedPlayer` is one
JSON document, because none of it is queried across players and all of it is
written together.

Three decisions worth arguing over, stated so they can be:

- **Persist, then commit.** `applyTrade` writes both records in one transaction
  and only assigns them to memory if it lands. The opposite order leaves a
  failed write with the exchange true in memory and false on disk.
- **The gate is injected, like `adminVerifier`.** Supplied, a `Hello` must carry
  a session token and the frame's `playerId` is discarded. Omitted, the client
  names itself -- which is right for the in-tab server, the bot harness and
  every test here, none of which have anybody to authenticate against.
- **No merging.** Registering a new account claims the guest player. Logging
  into an existing one loads *that account's* player and reports the guest as
  retained, so the UI can say what will not be coming with them.

## Invariants tested

- An empty database migrates; migrating again applies nothing; the version is
  reached; a failing migration rolls back and leaves the version where it was;
  a database from a newer build is refused rather than downgraded.
- A player saved, the database closed, and a *fresh* connection opened over the
  same file loads the same character -- bag, gear, skills, purse and position.
- A dirty player is flushed by the autosave; a successful save clears the mark;
  a failed save does not; a player edited during their own save stays dirty;
  two passes never write one player at once.
- A trade moves an item and both sides survive a restart. A trade whose second
  write aborts leaves **neither** side changed, in memory or on disk -- checked
  against a real `RAISE(ABORT)` trigger, and confirmed by putting the bug back.
- Register, login, wrong password, unknown account (same message as a wrong
  password), case-folded uniqueness, logout, and a session that resolves after a
  restart.
- A guest plays without registering, reconnects, survives a restart, and cannot
  be claimed by anybody holding only their player id.
- Claiming: progression byte-identical afterwards, old credentials revoked, a
  second claim refused, and a failed registration leaving the guest intact.
- Logging into an existing account does not overwrite its player.
- A dirty player, `server.stop()`, a reopened database, latest state present.
- The account form's button is live exactly when the server would take the
  request -- asserted by running both against the same drafts, not by trusting
  that two copies of a bound agree.
- Registering emits and changes nothing; the screen says "account" only when it
  is told. A password is masked on screen and unmasked to its owner.
- In a real browser: the binding opens the window, the window reports that its
  buttons reach a server rather than nothing, and a claim lands on the character
  being played rather than making a second one beside it.

## The account window

Added after the rest of it, because the rest of it was a feature nobody could
reach: a guest's character is claimable by one `POST` and there was no way to
press that from inside the game, so every playtester stayed anonymous and one
cleared browser away from losing everything.

`src/ui/screens/account.ts` is the form and it is pure like every other screen.
Two departures, both stated rather than assumed. It **holds the draft**, because
what somebody is half way through typing is not something a server knows. And
its **validation is injected** -- `world/account-model.ts` runs the server's own
`validateLogin`/`validatePassword`, so the greyed-out button and the refused
request cannot come to different answers, which is the rule
`inventory-model.ts` already follows.

The window opens on `KeyU`, and the mount takes an optional `AccountCapability`
-- absent for the in-tab server, which has nobody to sign into, exactly as
`authGate` is absent on that server's own side.

The line the screen exists to get right is the warning under Sign in. The server
never merges and never deletes, so the guest character is genuinely still there;
but the *browser* holds one token and signing in replaces it, so from where the
player is sitting that character stops being reachable. The warning says so and
names the alternative, which is why Register is the tab that opens first.

## Out of scope

- Typing into the form from a browser probe. The fields are on a canvas with no
  published boxes, and every rule they apply is asserted against the real
  widgets in Node; what a browser is for here is the wiring.
- Password reset. There is none, which is why the form asks for the password
  twice.
- Persisting the world: ground drops, monsters and spawner clocks are still
  per-process. Only players, moderation and the audit log outlive a boot.
- Password reset, email, rate limiting on `/api/auth/*`, and multiple characters
  per account. `players.account_id UNIQUE` is the assumption to revisit for the
  last of those.
- Merging a guest's progression into an existing account's. Deliberately not
  invented; the API reports what is retained and the decision is the player's.
