# 145 — Two players, one world

## Problem

Spec 144 gave two tabs one server, and what they found there was a world built
for one. Both spawn on the identical `DEFAULT_SPAWN {600, 450}` and nothing
collides body against body, so two players start inside each other. Another
player replicates as an anonymous shape: the entity delta has no name field, so
`appearance.ts` returns the literal string `'Player'` for everybody, and
`turn-limits.ts` has to guess a remote player's turn rate from the fastest base
in `CHARACTERS` because the real one is only ever sent to its owner. This spec
is the difference between two clients being connected and two people playing.

## Assumptions

- **The server is already genuinely multi-player.** `accept()` allocates
  per-connection state, `broadcastDeltas` builds a separate interest set per
  connection, and `trade-wire.test.ts` already drives two real clients through a
  full trade. Nothing here is about making the server handle two people; it is
  about what those two people can see of each other.
- **Death is already readable.** `EntityActivity.Dead` exists and `scene.ts`
  already draws `health <= 0` differently (`:1220`, `:1277`). Respawn keeps the
  entity id. So this spec *verifies* another player's death and respawn rather
  than building it — and the verification is worth having, because nothing has
  ever watched a body that was not its own die.

## Shape

### Identity on the wire

A seventh field on the entity bitmask:

```ts
EntityField.Identity = 1 << 6;   // str name · f32 turnRate
```

Set alongside `Spawn` when an entity enters interest, and again whenever the
turn rate changes. **Players only.** A monster's name and turn rate are in
`MONSTERS`, which the client already has, and putting a content table on the
wire is precisely what "an entity only ever stores an id" exists to prevent. A
player's name is the one thing on an entity that a human typed and no table can
answer.

`ReplicatedEntity` gains `name: string` and `turnRate: number`; both default to
`''` and `0`, which is what "not told" means and what the two consumers below
already have a fallback for.

`PROTOCOL_VERSION` 11 → 12, with the row added to `PROTOCOL.md`.

### Spawns that are not one point

```ts
// src/server/world/spawn-around.ts — pure
export function spawnAround(
  base: Vec3,
  occupied: readonly Vec2[],
  spacing: number,
  fits: (x: number, y: number) => boolean,
): Vec2;
```

Walks a fixed ring pattern outward from `base` — the centre, then six points at
`spacing`, then twelve at `2 * spacing` — and returns the first that is `fits`
and at least `spacing` from everything in `occupied`. Deterministic by
construction, with no PRNG to thread anywhere: the candidate order is a
constant, so the same set of occupied points always yields the same answer.
Falls back to `base` when the rings are exhausted, because refusing to spawn is
worse than spawning close.

Used at login and at respawn. `occupied` is the other *players*' positions —
monsters move and a spawn ring that dodged them would drift.

### Names over heads

`appearanceOf().displayName` stops returning `'Player'` and returns the
replicated name (falling back to `'Player'` when it has not arrived). `hud.ts`
draws a nameplate above every player body **except our own** — you know who you
are, and a label on your own head is one more thing between you and the fight.
Drawn with the existing pixel font, which has had capitals since spec 143.

### `turn-limits.ts` stops guessing

`turnRateFor` reads the replicated rate when it is non-zero, and keeps
`REMOTE_PLAYER_TURN_RATE` as the fallback for the frames before `Identity`
lands. The docstring at `turn-limits.ts:29-36` that explains the guess becomes
a note about the fallback.

### PvP means the ground you are standing on

`isHostile` currently reads the **attacker's** zone alone
(`sim/world.ts:246`), so a player standing in the wilderness can legally strike
a player standing inside Hearthstead. That is not what a safe zone means to the
person standing in one. It becomes:

```ts
// both, not either: a blow needs hostile ground at both ends
return zoneAt(attacker).pvp && zoneAt(target).pvp;
```

The trade is explicit and worth stating: you also cannot strike *out* of a safe
zone, so nobody can stand on the hub's edge and farm the road. The alternative
— the target's zone alone — would let somebody retreat into safety mid-swing,
which is the same exploit wearing the other hat. Requiring both ends is the
only reading where "I am safe here" is a fact rather than a hope.

### `SpawnerStates` bounded by interest

Spec 076 named this and it is now two clients' worth. `sendSpawnerStates` maps
over `this.spawnPoints` unfiltered; it grows a filter against
`this.chunks.interestChunks(connection.entityId)`, mirroring what
`broadcastDeltas` does one method away. Still opt-in and debug-only.

## Invariants tested

A new `src/server/client/two-players.test.ts` — one real `GameServer`, two real
`GameClient`s, no browser. This is the test the brief asked for:

- **They see each other.** Ana's replica contains Ben's entity id and vice
  versa, with Ben's `name` equal to what Ben logged in as.
- **They do not start inside each other.** Two logins at the same base are at
  least `spacing` apart, and a third is too. `spawnAround` itself is unit
  tested: deterministic for the same occupied set, respects `fits`, falls back
  to base when boxed in.
- **They fight the same monster.** Both attack one monster; its health as seen
  by each client decreases, and it is the same entity id in both replicas.
- **PvP is the zone's decision.** Ana attacking Ben inside `hearth` does no
  damage; walked out into the wilderness, the identical attack does. And the
  asymmetry closes: an attacker in the wilderness striking a target inside
  `hearth` does nothing. Asserted at the `isHostile` level too, as a table over
  (attacker zone, target zone).
- **A death is readable from outside.** Ben dies; Ana's replica shows Ben's
  entity at `health 0` and activity `Dead`, then after the respawn delay shows
  it alive at full health with the **same entity id** and a position back at the
  hub.
- **A trade completes between two sockets.** The `trade-wire.test.ts` flow, run
  over the wire rather than the loopback, with the both-bags item count asserted
  before and after — spec 132's rule that a duplication bug leaves each bag
  individually plausible.
- **Identity costs nothing after the first sight.** A delta for a player who
  has not levelled and has not moved carries no `Identity` field.

Beside them: `npx tsx scripts/preview-multiplayer.ts` gains a second assertion —
each tab reads the *other's* name off the nameplate.

## Out of scope

- **Body-against-body collision.** `resolveMovement` collides against the world
  and not against entities, and it is the server's rule for monsters too;
  changing it is a movement spec, not a networking one. Separated spawns are
  what this spec owes; players can still walk through each other afterwards.
- **Collider paging** — spec 146, next.
- **A name anybody chose in the game.** `?name=` is where a name comes from.
  There is no name entry, no uniqueness check and no profanity filter; two
  players may both be called Ana and the server will not care, because identity
  is the playerId and the name is a label.
- **Anything about what a name may contain.** Bounds-checking and rate-limiting
  every string the protocol accepts is spec 151, and until then a name is
  trusted exactly as much as every other client-supplied string already is.
- **PvP rewards, flagging, or opting in.** The zone decides, as it does today.
