# What the wind-up bar does while shooting continuously

Measured with `npx tsx scripts/probe-windup.ts`, which plays a real session
(loopback transport, real wire format, real server tick) with the same gate
`target.ts` uses for an auto-attack, and prints `castBar(...).progress` per tick
against the same `estimatedTick` the play view draws with.

## The shape of a wind-up, per cast

Throwing Star, wind-up 12t, fast build (attackSpeed 2.76, interval 7t), no
latency -- `--fast`, which is the single-player / in-tab case:

```
#   press  drawn  held@0  moving  pinned@1  fastest step  rate vs clock
#      32     14       2      10         2          2.00x           1.10x
#      46     14       2      10         2          2.00x           1.10x
#      60     14       2      10         2          2.00x           1.10x
```

A 12-tick wind-up is drawn over 14 ticks, and it is not moving for 4 of them:

- **2 ticks pinned at 0** at the start. The client stamps its predicted cast at
  `commitAt = estimated + commitDelayTicks()` (game-client.ts), so
  `releaseTick` is a couple of ticks further out than the server's will be, and
  `1 - (releaseTick - tick) / windup` is negative and clamps to 0.
- **one 2x step** when the server's `CastState` lands and replaces the predicted
  cast with a `releaseTick` one tick earlier. The bar catches up in a single
  frame.
- **10 ticks of filling** -- the full 0..1 range covered in 10 ticks rather than
  12, so 1.10x clock while it moves.
- **2 ticks pinned at 1** at the end, from `CAST_EXPIRY_SLACK_TICKS`: the cast
  is held past its `endTick` before being dropped.

So the bar stalls, jumps, runs ~10% fast, then sits full. Nothing divides by the
wrong wind-up -- `abilityById(cast.abilityId)` resolves on every sample, checked
explicitly in the probe, so the `?? 1` fallback in `castBar` is never taken.

## Why the throwing star reads worst

The error is a *fixed* ~2 ticks at each end, independent of the ability, so it
distorts a short wind-up by a larger fraction:

| ability | wind-up | drawn | moving | rate |
|---|---|---|---|---|
| `ranged.star` | 12t | 14t | 10t | 1.10x |
| `melee.slash` | 12t | 14t | 10t | 1.10x |
| `ranged.shot` | 21t | 23t | 19t | 1.05x |

The star is the fast basic attack, so it is the one seen back to back.

## Under latency it inverts

At `--delay=6` the same build draws each 12-tick wind-up over 21 ticks: 7 held
at 0 (the commit-delay window is longer), 11 moving at 1.00x, 3 pinned at 1.
The bar is not fast there -- it is early and slow. The fast-looking bar is
specifically the free-connection / in-tab case.

## A second thing the numbers show

Commits land 14 ticks apart when the stats allow 12 (`interval 7t`, wind-up
12t, and a cast is over at its release). The extra 2 ticks are the same
`CAST_EXPIRY_SLACK_TICKS` hold: the client will not ask for the next swing while
it still believes it is casting. At the baseline build it is 16t against a 15t
floor. So a fast build attacks slightly slower than its stats say.
