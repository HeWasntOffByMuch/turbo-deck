# 190 — An active set that is not rebuilt every tick

## Problem

`ChunkManager.refreshActive()` runs once per tick and rebuilds the active set
from scratch: for every player, `chunkKeysInRadius` allocates 289 coordinate
objects and 289 template-literal strings, inserts them into a fresh `Set`, and
then diffs that against the previous set both ways. `GameServer.tick` then copies
the result again — `activeChunks: new Set(this.chunks.activeChunks())` builds an
array and a second `Set` on top. All of it is thrown away and rebuilt next tick.

With the collider walk gone (spec 189) that bookkeeping is now **25.2% of the
tick** — the single most expensive thing in it, and most of the 9.7% the garbage
collector takes beside it.

None of the work is needed. The active set is a function of **where the players
are**, and `CHUNK_SIZE` is 400: a player crosses a chunk boundary every few
seconds at walking speed, so the set is identical on something like 99.6% of
ticks. `place()` already knows when an entity changed chunk and already returns
it.

Worth being explicit about what this is *not*, because a previous reading of this
file got it wrong: **activation is not dead code and the sim does use it.**
`isSimulated` in `sim/world.ts` gates the decide and move passes and the attack
slot board on `activeChunks`, so a body outside every player's window already
costs nothing but a `Map` entry. What is dead is narrower — `isActive()` has no
caller, and `refreshActive()`'s `ChunkTransition[]` return value is discarded by
the one place that calls it. The docstring's talk of "load/unload" describes a
caller that does not exist.

## Shape

```ts
export class ChunkManager {
  /** The live active set. Handed to the sim as a ReadonlySet, never copied. */
  activeChunks(): ReadonlySet<ChunkKey>;

  /**
   * Recompute the active set, if a player has moved between chunks since the
   * last call. Returns nothing: the set is what is consumed.
   */
  refreshActive(): void;
}
```

Three changes, and each deletes something rather than adding to it.

**A dirty flag, set where the truth changes.** `place()` already computes whether
an entity changed chunk; it raises the flag when that entity is a player, and
`remove()` raises it when the entity removed was one. Nothing else can move the
active set, so the flag is exact rather than conservative — the rebuild happens
on precisely the ticks that need it.

**The set is handed over, not copied.** `StepContext.activeChunks` is already a
`ReadonlySet<ChunkKey>`, so `activeChunks()` returning the live set removes an
array and a `Set` per tick and changes nothing the sim can see. It is aliasing,
and that is safe here for a stated reason rather than by luck: `refreshActive()`
runs after `step()` returns, so no tick ever observes the set changing under it.

**The transitions go.** `refreshActive` built a `ChunkTransition[]` describing
what opened and closed, and its one caller has always thrown it away. Returning
it would now be a lie as well as a cost, since a call that finds the flag clean
does no diff. `ChunkTransition` and `isActive` go with it.

## Invariants tested

- The active set after a `refreshActive()` is the same set the old always-rebuild
  produced, for the same sequence of placements — asserted over a walk that
  crosses chunk boundaries in both directions, not just one.
- A player standing still for many ticks leaves the set identical, and the
  rebuild does not run.
- A monster moving — including into and out of chunks far from any player —
  never changes the active set.
- Removing a player shrinks the set on the next refresh; removing a monster does
  not change it.
- Two players, one moving and one still, keep both windows: the flag is about
  *any* player having moved, never about the last one placed.
- The sim's own behaviour is unchanged: same seed and inputs, same authoritative
  state.

## Out of scope

- **`interestSet`**, which walks the same 289 keys per player per broadcast and
  is 3.6% of the tick. It is live code doing real work — it decides what each
  client is told about — and making it cheap is a different change with a
  different risk. Noted here so the next person measuring finds it named.
- **Widening or narrowing the interest window.** `INTEREST_CHUNK_RADIUS` is sized
  against what the camera frames and `interest.test.ts` asserts that
  relationship. This is about the cost of maintaining the set, not its size.
- **What an inactive body should do.** Bodies outside the window already freeze;
  whether their statuses should expire, their respawn timers run, or a leashed
  body still walk home are design questions this does not touch.
