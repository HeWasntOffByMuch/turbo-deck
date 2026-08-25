# 227 — A ring that is not a lattice

## Problem

Spec 187 cut a target's surroundings into a fixed number of evenly spaced
slots and handed one to each attacker. The lattice is what makes it wrong in
three measurable ways, and an earlier abandoned branch
(`claude/unit-herd-navigation-gi38l9`, its spec 186) had already written down
the alternative.

  - **The ring is cut once, for the widest body and the tightest reach, so one
    large attacker coarsens it for everybody.** Twelve `small_spider`s round a
    player get 17 slots and every one of them a place to stand. Add a single
    `ravager` and the count drops to 6 — `floor(π / asin(30/68.8))` — so **7 of
    the 13 attackers get `-1`**, fall back to aiming at the target's centre,
    and stack on exactly the ground the ring exists to keep them off. Twenty
    `stalker`s are 10 slots and **10 denied**. `SlotBoard.note` says this cost
    out loud and calls it "the right way round"; the numbers say it is the
    common case, not the corner.
  - **The lattice is in the world frame, so every attacker is snapped to an
    absolute angle it had no reason to want.** A body approaching from the west
    is pushed up to `π / count` off its own bearing — 30° when a ravager is in
    the fight, 18° for a pack of stalkers — *including when it is the only
    attacker there is*. A lone monster chasing a player sidles.
  - **Past the slot count there is no answer at all.** `take` returns `-1` and
    the caller aims at the target itself, which is the pile-up, not a queue.

## Shape

`src/server/sim/attack-slots.ts` is replaced. The mechanism is **angular
separation** rather than a lattice: each attacker keeps the bearing it already
holds on its target, and bearings are moved only where two of them are closer
together than the two bodies can actually stand.

```ts
export interface Approach {
  readonly attackerId: number;
  /** Where the attacker is now: what fixes the bearing it already holds. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** How far out this body wants to stand, from its own ability. */
  readonly standoff: number;
  /** It has stopped inside its own reach: it holds its ground and is never moved. */
  readonly pinned: boolean;
}

/** Where each attacker still walking should aim, keyed by attacker id. */
export function approachPoints(
  target: Vec2,
  attackers: readonly Approach[],
): ReadonlyMap<number, Vec2>;

/** The smallest bearing difference at which two bodies on their own rings clear. */
export function requiredGap(
  ringA: number, radiusA: number,
  ringB: number, radiusB: number,
): number;
```

Four things this has that the lattice did not.

**The pair rule is exact, and it is measured between the two rings the bodies
are actually on.** Two centres at `(ringA, θA)` and `(ringB, θB)` are
`√(ringA² + ringB² − 2·ringA·ringB·cos Δθ)` apart, so the bearing gap they need
is `acos((ringA² + ringB² − d²) / (2·ringA·ringB))` for `d = (radiusA +
radiusB)·SLACK`. When the cosine comes out `≥ 1` there is **no constraint at
all** — which is the honest answer for a `slinger` standing at 252 units and a
`stalker` at 68, and the case both the lattice and the abandoned branch's
sum-of-half-angles got wrong by over-separating a ranged attacker that was
never in anyone's way. Equal rings reduce to the chord formula spec 187's
`slotCount` used, so nothing about a homogeneous pack is re-derived.

**Nobody is snapped.** Below the crowding threshold the relaxation is the
identity, so one attacker — and two arriving from opposite sides, and any pack
that is already spread — walks exactly the line it walked before this spec.
`approachPoints` returns an empty map for fewer than two attackers as a
contract rather than as an optimisation.

**A body that has stopped is pinned.** It holds its true bearing at its true
distance and takes none of the correction; the closer walking at it takes all
of it. That is spec 187's "somebody else's reservation is as good as a claim"
in the new geometry, and pinning at the *actual* distance is what lets the
exact pair rule tell a body standing in reach from one loitering 300 units out.

**A ring too small for its pack is shared out** rather than answered with
`-1` and the target's centre: every gap shrinks by the same factor, so the pack
still arrives spread evenly round its quarry — tighter than it would like — and
`crowd.ts` resolves the density that leaves.

There is deliberately **no second ring further out**, and the version with one
was written and measured before it was dropped. It puts the surplus at
`standoff + k · step`, which is past `monsterIntent`'s `closing` test — that
asks whether the body is inside *its own reach*, not whether it has arrived
where it was sent. So an outer-ring body walks to a point it can never register
as reached, and stands there twitching at an aim it is already on: `converge`
went from 18 of 20 bodies ending within reach to **9 of 20**, with the other
eleven parked outside the fight, and `gate`'s jitter p95 from 0.025 to 0.193.
Standing a pack back so it never shoves is the abandoned branch's premise, not
this game's — this one has avoidance for exactly this.

`ServerEntity.attackSlot` is deleted. The hysteresis it existed for is
structural now — the bearing a body is assigned is the bearing it already has
— so there is nothing to carry between ticks. It was never on the wire.

`world.ts` replaces `openSlotBoard` with `planApproaches`, in the same slot at
the top of the movement pass and reading the same start-of-tick positions. Each
entry records the target it was computed against, and `monsterIntent` uses its
aim only while it is still fighting that target — which is exactly the
condition `attackSlot` was offered back under.

## Invariants tested

  - `requiredGap` is symmetric; on equal rings it is `2·asin(d / 2r)`; it is
    `0` when the rings are far enough apart that no bearing can make the bodies
    touch; it is `π` when they overlap even diametrically opposite; and it is
    finite for a zero ring, a zero radius and a body standing on the target.
  - Fewer than two attackers yields an empty map, so a lone monster's approach
    is unchanged.
  - Two attackers already further apart than they need are both left on their
    exact bearings.
  - Two attackers on the same bearing end at least `requiredGap` apart, and
    symmetrically about where they started.
  - No pair of assigned bearings on a ring is closer than that pair needs.
  - A pinned body's bearing is never moved, and a body closing onto it is moved
    the whole way instead.
  - Adding a body of any size never reduces the number of attackers that get a
    place to stand: 12 spiders + 1 ravager places all 13, where spec 187 placed
    6.
  - Every attacker gets a bearing, even when more of them want the ring than
    fit: 20 stalkers round one player are placed evenly on their own reach,
    with no gap wider than twice an even share, where spec 187 sent 10 of them
    at the quarry's centre.
  - The result depends only on the attackers, not on the order they are offered
    in, and is bit-identical across runs.
  - Bearings do not cross: the assignment preserves the circular order the
    bodies arrived in.
  - `converge` keeps its spec 187 acceptance: 20 bodies onto one quarry ends
    with no wider empty arc and no worse overlap than the lattice produced.

## Measured

Through the real `step`, over spec 187's own five scenarios
(`npx tsx scripts/preview-crowd.ts`), against the lattice it replaces:

| | spec 187 | spec 227 |
|---|---|---|
| `converge` widest empty arc | 35° | **18°** |
| `converge` bodies ending in reach | 18 of 20 | **20 of 20** |
| `converge` body-frames touching | 19.7% | **0.0%** |
| `herd` worst overlap | 3.4% | **2.1%** |
| `herd` body-frames touching | 34.0% | **31.4%** |
| `overtake` worst overlap | 1.2% | **0.0%** |
| `gate` all bodies past the wall | tick 1029 | **942** |
| `cross` body-frames touching | 3.7% | **3.3%** |

Jitter is unmoved where it matters — `gate` p95 0.025 → 0.024, `herd` p95 0.007
→ 0.008 — which is the number to read, since the metrics module says a maximum
is one tick of one body and a crowd feature is about what a crowd does for
seconds at a time.

## Out of scope

  - `crowd.ts`, `avoidance.ts` and `neighbours.ts` are untouched. This is about
    where a body is *sent*; how two bodies get past each other on the way is
    spec 187's and stays as it is.
  - There is one ring per target and no queue. A pack too big for it stands
    shoulder to shoulder rather than waiting its turn further out, and the
    overlap that leaves is `crowd.ts`'s to resolve.
  - No formations, no groups. A crowd is still bodies that happen to share a
    target.
  - Nothing new crosses the wire, and no client behaviour changes.
