# 093 — A wind-up long enough to withdraw from, and the commit that rides a step

## Problem

Two halves of the same investigation, which is why they are one spec.

1. **The wind-ups are too short to be the decision the game is built on.** A
   basic swing is `seconds(0.2)` — twelve ticks, 200ms. The README says the
   wind-up is "long enough to be read, and short enough to matter"; at twelve
   ticks it is neither read nor withdrawn from, it is simply the delay before a
   blow. Everything spec 079 built — the feint, the step out, the refund — needs
   a window a person can act inside, and on a real connection 200ms is most of a
   round trip. Making the wind-up **deliberately long** is the point of the
   mechanic, not a tuning nicety.

2. **A commit that arrives on the same input as a step starts anyway.** Spec 079's
   rule is that *asking to move withdraws*. Spec 092 wrote down the same
   asymmetry for the `Esc` withdrawal — a cancel and a commit riding one input
   must resolve as "not that one", because swallowing the withdrawal throws a
   blow the player called off while swallowing the commit costs a press — and
   fixed it for `cancelCast`. It was never applied to the *move vector*, which
   is spec 079's other withdrawal and the one a player actually uses.

   So `step` today, given one input that both asks to walk and asks to commit,
   walks the body **and** starts the wind-up. Measured, not read:

   ```
   move+commit  ->  cast: melee.heavy at { x: 597.4, y: 450 }   <- both happened
                    events: [castStarted ...]
   ```

   The movement pass settles the withdrawal *before* the cast pass runs, so at
   that moment there is nothing on the body to withdraw from; the cast pass then
   puts a fresh wind-up on a body that asked, on that very tick, to be somewhere
   else. It survives only until the next input carrying a vector calls it off —
   which is why it usually looks like a one-tick stutter and not a bug. When no
   such input follows, the wind-up runs to the end and the blow lands.

   Nothing exotic is needed to produce one. `view.ts`'s `castNow` clears the
   move order and the attack order before asking, but it does not clear the
   **held keys** — so a hotbar press while walking is exactly this input, and so
   is a confirmed aim (spec 080) with a key still down.

## What was ruled out first

The reported scenario — in range, facing, targeted, wind-up part-way through,
walked out of — was driven through the real `GameServer`, the real wire and
`view.ts`'s own loop (`autoAttack` decides, `moveIntent` steers, one input frame
goes out), with the wind-up lengthened so the window is wide. 72 combinations:
withdrawing by ground-click with the explicit cancel, by ground-click without it
(the move vector alone), by held keys and by a tapped key; at 0/5/12 ticks of
latency each way; 1 and 3 ticks a frame; pressed at 30/50/80% of the wind-up.
**All 72 withdrew** — no shot, `CastEnded(Cancelled)` every time.

That is the same negative result spec 092 recorded, now also covering the attack
order, latency and a long wind-up, and it is what pushed the search onto the
tick the commit *begins* rather than the ticks it runs for.

## Shape

### 1. Wind-ups, deliberately long

`data/abilities.ts` only. Roughly doubled, and every basic attack stays under
`BASE_ATTACK_DELAY_TICKS` (72) so the swing cadence is still the stat's to
decide and not the wind-up's:

| ability | was | now |
|---|---|---|
| `melee.slash` | 0.2s | 0.5s |
| `melee.heavy` | 0.65s | 1.1s |
| `ranged.shot` | 0.35s | 0.8s |
| `ranged.star` | 0.2s | 0.45s |
| `bolt.arcane` | 0.3s | 0.6s |
| `bolt.lob` | 0.5s | 1.0s |
| `bolt.seek` | 0.45s | 0.9s |
| `ground.quake` | 0.9s | 1.4s |
| `self.mend` | 0.8s | 1.2s |
| `channel.drain` | 0.25s | 0.5s |

Content is data (spec 062), so this is a table edit and nothing else reads a
number off it at build time.

### 2. A step outranks a commit, exactly as a cancel does

One line in `step`'s cast pass, replacing the `intent?.cancelCast` gate:

```ts
// world.ts
const withdrawing = intent?.cancelCast === true || asksToMove(intent);
```

The body of the branch is unchanged: the cast is withdrawn from if there is one,
and a request riding the same input is **answered** with `castRejected` /
`'withdrawn'` rather than dropped, because the client pairs the n-th reply with
the n-th request (spec 080).

No new rejection reason, no protocol change, no client change. A player who
presses an ability while walking is refused and told why, instead of being
rooted for a tick and refunded — and, on the tick where nothing follows to call
it off, instead of throwing the blow.

The rule is safe for monsters by construction: `monsterIntent` only sets
`castAbilityId` when `!closing`, and only steers when `closing`, so it never
emits both.

### 3. …and `server.ts` stops building the ambiguous input

The rule above cannot be the whole of it, because `step` sees one struct and
cannot tell *when* the vector on it was asked for. Two very different gestures
arrive looking identical:

- The player was walking and pressed an ability. The step is the newer word, or
  at least a standing one — refuse.
- The player's chase **arrived**, and they asked to swing on the frame after it.
  `useAbility` stamps `afterInputSeq` with the last input already sent, so the
  commit is stamped to ride the final frame of the approach — which still
  carries a vector. Refusing that refuses the ordinary end of every chase, and
  spec 080's own suite says so: 3 of 23 swings came back `withdrawn`.

`server.ts` is where the answer lives, because it is the half that knows arrival
order — the same place, and the same argument, as spec 092's `arrivedAt`:

```ts
// server.ts
const stepsFirst =
  nextCast !== undefined && next !== undefined &&
  asksToMove(next) && next.seq <= nextCast.afterInputSeq;
```

A frame the request was stamped *after* is older than the request, so it goes out
alone and the commit follows a tick behind it — by which time the client's own
next frame says whether it is still walking. A frame *newer* than the request
carries a step the player asked for after pressing, and is folded as before for
`step` to refuse. Both readings are preserved because both are real, which is the
sentence spec 092 already wrote about the other withdrawal.

## Invariants tested

- **In `step`, one input carrying both a move and a commit** starts no cast,
  moves the body, and answers the request with `withdrawn` — charging neither
  cost nor cooldown. Pinned to fail without the fix.
- **The same over the real server and wire**: a client that asks for an ability
  on a frame it is also walking gets no shot in the world, even when it stops
  walking immediately afterwards so nothing arrives later to call the cast off.
- **A commit on an input that does not ask to move is untouched** — the ordinary
  case, and the one a "cancels always win" reading would break.
- **A commit stamped after a walking frame still commits**, one tick behind that
  frame and with no refusal — the end of a chase, and spec 080's suite over a
  real session is the guard that it stayed that way.
- **The reported scenario stays fixed**: attack order, in range, facing, mark
  named, wind-up part-way through, walked out of — nothing thrown, cast ended
  `Cancelled`, body actually moved. Run at 30/50/80% of the wind-up and at 1 and
  3 ticks a frame, through the real server, the real wire and `view.ts`'s loop.
- The existing suites still hold with the longer wind-ups, in particular spec
  080's "asks once a swing, withdraws from nothing" over a real session.

## Out of scope

- **`castNow` dropping the held keys.** The client could clear `held` when it
  asks, which would make the collision unreachable from the Play tab. The server
  rule has to hold anyway — bots and tests call `step` directly, and
  `mergeInputs` folds a batch of client frames into one input — and a client
  change on top would only hide whether the rule works.
- **Un-throwing a shot already loosed.** Spec 079 stands: a withdrawal that
  genuinely arrives after the release is refused.
- **Retuning cooldowns, costs or damage** to sit against the longer wind-ups.
  The wind-up is the readable half of the commitment; what a blow is worth is a
  balance pass, and this is not one.
