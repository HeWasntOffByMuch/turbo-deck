# 261 — A monster left alone comes back whole

## Problem

A player fights a monster down to a sliver, dies, respawns, walks back and kills
it with one blow. Spec 213 wrote `restore` to close exactly that, and it is
never reached.

`restore` is called from `idle`, `idle` from `idleDecision`, and that whole
branch hangs off `monsterIntent` — which `world.ts` skips for any body outside
`activeChunks`:

```ts
if (!isSimulated(current)) continue;
```

So a monster nobody is near is not slowed, it is **frozen**: no idle plan, no
poise regeneration, no status expiry and no recovery. Dying is the fastest way
there is to make a monster unwatched — a respawn teleports the player to
`DEFAULT_SPAWN` — so the one situation recovery exists for is the one situation
it does not run in. The body is still on its sliver when the player walks back,
however long they took.

The rule is written as a **counter advanced once per simulated tick**, where
what it means is time.

## Shape

Recovery becomes a comparison against an absolute tick — the register
`statusOf`'s expiry, the loot reveal, the stun swirl and `healHomeward` are all
already in. What it compares against is a second clock started by the same blow
that starts the combat window, and whose **expiry is the fact**: the tick the
body is due back to full.

```ts
StatusId.Recovering = 'recovering';   // stamped for combatTicks + recoveryTicks

// sim/restoration.ts -- the health economy's own module, already imported by
// all three sites that stamp the window.
export function enterCombat(statuses: Statuses, tick: number): Statuses;
export function recoveryRemaining(statuses: Statuses, tick: number): number | null;
```

`enterCombat` is the single writer of both stamps, replacing the same
`applyStatus` spelled out at three call sites (two in `blow.ts`, one in
`damage-over-time.ts`). `RESTORATION.rest.recoveryTicks` moves the ramp's width
next to `combatTicks`, because those two sites and `idle.ts` now all need it.

`restore` keeps its gate and its step exactly as they are, and takes the larger
of the step and a floor:

```ts
if (hasStatus(monster.statuses, StatusId.InCombat, tick)) return monster;
const stepped   = monster.health + max / RECOVERY_TICKS;
const remaining = recoveryRemaining(monster.statuses, tick);
const owed      = remaining === null ? 0 : max * (1 - remaining / RECOVERY_TICKS);
```

`recoveryRemaining` reads the entry **whether or not it is still live**, and is
the one place in the sim that wants a lapsed status. That is the whole fix:
nothing prunes a frozen body's statuses, because `advanceProgression` runs only
for bodies the tick actually stepped, so the record of when its last fight ended
is still on it whenever somebody finally comes back.

Two things make that safe, and each was learned by building the version without
it.

**The clock's lifetime is exactly the ramp's.** So `null` — an entry pruned, or
one that never existed — is not "long ago", it is **no floor**. Pruning happens
on the tick the body is due, by which point the step has already carried a
watched body to full, so there is nothing to owe it; and a body that has never
been in a fight must not be handed full health for a wound it got some other
way. The first cut read an absent entry as "the fight ended long ago" and healed
any hurt body with no combat record, which broke a test that sets `health: 1` on
a fresh body to check a stagger-immunity threshold — the body was at full health
by the time the blow landed.

**The gate is not shortened.** The first cut also gave recovery its own
two-second delay, on the argument that eight seconds is the *player's* rest
window borrowed. It is borrowed, and it is also right: a player chasing a body
that fled, or closing again after a knockback, is still fighting it, and at two
seconds a grazer out-healed a real chase — `loot-wire`'s kill loop stopped being
able to kill anything. `RESTORATION.rest.combatTicks` is wide because a fight
has gaps in it. The frozen case is the bug; the window is not.

## Invariants tested

- `enterCombat` starts both clocks from the same blow: `InCombat` for
  `combatTicks`, `Recovering` for `combatTicks + recoveryTicks`.
- `recoveryRemaining` answers `null` for a body that has never been in a fight,
  and `restore` gives such a body the step alone.
- `recoveryRemaining` reads the entry after it has lapsed, and `restore` brings
  a body long past its due tick to full.
- The clock is pruned exactly when there is nothing left to owe: a watched body
  is at full health on the tick `expireStatuses` drops it.
- The ramp's shape is unchanged for a body watched throughout, from four
  starting healths: the floor never binds, so recovery is the same per-tick step
  it was.
- A gap taken part way through the ramp is credited, not lost.
- Driven through the real `step`, with the body's chunk absent from
  `activeChunks`: the monster is frozen on its sliver for the whole gap, and is
  at full health on the first tick it is stepped again.
- Recovery still refuses while `InCombat` is live, still never revives a corpse,
  and still never runs for a body holding a target.
- The `Rng` is untouched: the draw count after a gap equals the draw count
  without one.

## Out of scope

- **Everything else a frozen body does not do.** Poise, statuses and the idle
  plan all still stand still while nobody is near. Health is what is
  exploitable; the rest is a body standing where it was, which is what it would
  have been doing anyway.
- **The pop at the boundary.** `step` runs against the previous tick's active
  set (`refreshActive` runs after it, spec 193), so a monster can be broadcast
  once at its stale health before its first step. That is at most one delta,
  ~66ms, on a body at the edge of the frame; closing it means recovering bodies
  the sim is deliberately not stepping.
- **Any mark saying a monster reset.** A body that healed while unwatched is
  indistinguishable from one that was never fought, which is the point.
- **Retuning the recovery window.** Twelve seconds from the last blow to full is
  what spec 213 chose and what this keeps; all that changes is that those
  seconds now pass whether or not anybody is watching.
- `healHomeward` and the walk home (spec 248) are untouched.
