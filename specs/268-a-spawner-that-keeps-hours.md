# 268 — A spawner that keeps hours

## Problem

Spec 264 built a world clock the server keeps and the client re-derives, and
closed with the sentence this spec is about: *no game rule reads any of it yet*.
Every spawner on the map refills whenever its timer is up, so the world holds
exactly the same bodies at midnight as at noon, and "come back after dark"
is not something a level designer can say.

The other half is a decision rather than a gap. What happens to a night body at
dawn has three possible answers -- leave it, sweep it, or walk it home -- and
this spec takes the first: **the sun coming up stops the spawner, not the
monster.** A body that is already standing there goes on wandering, is fought
and killed like anything else, and simply is not replaced until the sun is down
again. That is the whole feature, and it needs no despawn path, no rule for a
body somebody is mid-swing against, and no new state on an entity.

## Shape

**The document.** One optional field on the block spec 222 already added, and
a closed union rather than a number, the rule `Temperament` and `Idle` are
unions for -- a window names no quantity, so there is none to author.

```ts
// src/terrain/map.ts
export type SpawnWindow = 'night' | 'day';

export interface MapSpawnerSettings {
  readonly respawnSeconds?: number;
  readonly leashRadius?: number;
  /** When this point may fill. Absent = whenever its timer is up, as before. */
  readonly when?: SpawnWindow;
}
```

Absent rather than a written-in `'always'`, for the reason the two numbers
beside it are absent: a committed map carries only what somebody chose, so no
region file's bytes move and no `mapId` does. `parseSpawnerSettings` refuses an
unknown string the way `parseMarker` already refuses an unknown kind -- a
spawner that silently never fills and one that fills always are indistinguishable
from inside the game, and only one of them is worth an afternoon.

**The predicate.** One sentence in one place, because "night" has two plausible
readings and the sim, the readout and any test must not each pick one.

```ts
// src/server/world/spawners.ts
export function spawnWindowOpen(when: SpawnWindow | null, clock: WorldClock): boolean;
```

Night is **`!clock.sunUp`**, not `phase === Night`. The named phase begins at
19:48 where the sun sets at 18:00, so the phase reading leaves about twenty real
seconds of visible darkness with nothing arriving in it -- a player who watches
the sun go down and waits is watching the rule be wrong. By the horizon the
window is 2m47s of the cycle's 13m30s; by the phase it would be 2m00s.

**The gate.** `runSpawners` samples `worldClockAt(tick)` once per tick and
refuses a shut point beside the population cap it already refuses at
(`sim/world.ts`), leaving `entityId: null` and trying again next tick. Nothing
else in the pass moves: a kill still stamps the respawn clock when the body is
removed, so a monster killed at night whose timer expires after dawn waits out
the day and returns on the next one.

**The readout.** `SpawnerStateValue.Holding = 2`, appended -- the overlay
exists to answer *is that camp about to come back*, and a spawner held shut by
daylight currently answers `due`, forever, which is the one thing spec 076 says
that number must never say. The server reports it for an empty point whose
window is shut whatever its timer reads, with `ticks: 0`, and `spawnerLabels`
draws `<monster> · holding`.

**The editor.** A `When` dropdown in the *Selected marker* folder beside
Respawn and Leash, live only for a spawner, with `always` as the value that
writes no key -- `SPAWNER_UNSET`'s idiom in string form. The placement tool is
untouched: it has never written a settings block, and correcting one is what the
select tool is for (spec 222).

## Invariants tested

- A document round-trips `when` through `serializeMap`/`parseMap`; a spawner
  block holding only `when` survives, and one holding nothing normalizes to
  absent.
- `parseMap` refuses an unknown `when`, and refuses a `spawner` block on any
  other marker kind exactly as it already does.
- No committed map file changes: `maps/arena.json` re-serializes byte-identical
  and its `mapId` does not move.
- `spawnWindowOpen` is true for a point that authors nothing at every tick of
  the cycle; a `night` point is open exactly when `sunUp` is false, and a `day`
  point exactly when it is true, and the two partition the cycle.
- A night spawner is empty through Day and fills on the first tick the sun is
  down; a day spawner is the mirror.
- **A body already standing survives dawn**: stepped across the sunrise it is
  still in the world, still owns its spawner, and still wanders.
- A night monster killed in daylight is not replaced that day, and is replaced
  once the sun is down and its own respawn interval has passed -- whichever is
  later.
- The gate draws nothing from the `Rng`: the stream after a cycle with night
  spawners on the map is identical to one with none, and a replay across a
  phase boundary is bit-identical.
- `sendSpawnerStates` reports `Holding` for an empty point whose window is shut
  and `Waiting` for one merely counting down, and `spawnerLabels` never prints
  `due` for a held point.

## Out of scope

- **Anything that removes a body.** No dawn sweep, no walk home, no
  `Returning`-flavoured retreat. That is the decision above, not an omission.
- **A monster-row field.** *When* stays a property of the point, so one species
  can be nocturnal in the woods and permanent in a pen; a row-level default is a
  later spec if the same answer is ever wanted everywhere.
- **A phase-aware density or a different monster by day.** One point, one
  monster, one window.
- **A server-side clock lever.** Both ends derive the hour from the tick, so
  there is no way to jump a live server to nightfall without replicating an
  offset -- which is exactly the state spec 264 avoided. `?clock=` still pins
  the *sky* on one client and deliberately does not move the spawners. Testing
  is headless, stepping across `ticksUntilPhase`.
