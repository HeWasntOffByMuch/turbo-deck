# 264 — A press that waits for the swing

## Problem

Pressing a skill during your own swing does nothing and says something false
about why. Measured through the shipped loop against a real server -- the
standing attack order swinging, a self-cast pressed on a beat -- **thirteen
presses, thirteen refusals**, every one of them `alreadyCasting`:

```
swinging only            rejects={"staggered":1..4}          every weapon, every delay
swinging + flask presses rejects={"alreadyCasting":13}
                         pressedDuring={"windup":9,"backswing":3,"idle":1}
```

`scripts/probe-already-casting.ts` is that measurement. Three things in it are
worth reading twice.

**The refusal is a lie about a third of the time.** `pressedDuring` counts the
phase the caster's own cast was in when the press was made, and `backswing` is
a large share of it: the blow has landed, the damage is dealt, the cooldown is
already running, and the body is finishing an animation it is explicitly
allowed to walk out of (spec 258). `entity.cast` is still non-null, so
`startCast` answers `alreadyCasting` about a swing that is over. From where the
player is sitting nothing is casting, which is exactly the report.

**It does not self-limit.** A refusal stamps no cooldown, so the client's own
gate never closes and the next press goes out and is refused too. The rows
where the flask never once got onto cooldown are the rows where every single
press was thrown away.

**And it costs the fight.** `castNow` clears `targetId` and `destination`
*before* sending, so a press the server discards also drops the standing attack
order. The player gets a false message and stops attacking.

Underneath it is one gap. Of the four things that can ask for a cast, three
hold while the body is committed -- `autoAttack` and `castOrder` both take
`rooted`, `staggered` and `pending`, and the aim-then-confirm path holds a
confirmed aim as an `AimOrder` until the swing ends. The fourth does not:

```ts
// aim.ts
export function startAim(ability, input): AimStart {
  if (input.tick < input.readyAtTick) return { kind: 'refused', reason: 'onCooldown' };
  const gesture = aimGesture(ability);
  return gesture === 'none' ? { kind: 'cast' } : { kind: 'aim', gesture };
}
```

The cooldown and nothing else. A `'none'` gesture is `targeting: 'self'`, so
the press *is* the commitment and goes straight out. Five rows are self-cast
and one of them is `self.hearthdraught` -- **the flask, in everyone's fifth
slot** -- with Whirlwind, Rime Touch, Scorched Earth and Conjure Light beside
it. While bare-handed, a body is inside a cast for 54 of every 72 ticks, so
about three presses in four land in one.

So a press made during a swing is **held and asked for on the first tick the
body is free**, which is what an aimed skill has done since spec 080 and what
the self-casts were left out of.

## Shape

`src/render/iso3d/world/press-queue.ts`, pure:

```ts
/** A press waiting for the body to be free. */
export interface QueuedPress {
  readonly abilityId: string;
  /** The directions that were down when it was made. See below. */
  readonly held: ReadonlySet<string>;
}

export interface PressQueueInput {
  readonly queued: QueuedPress | null;
  /** A cast -- confirmed or only asked for -- is live. */
  readonly rooted: boolean;
  /** A poise break holds this body (spec 173). */
  readonly staggered: boolean;
  /** A request of ours is still unanswered (spec 080). */
  readonly pending: boolean;
  /** Off cooldown, judged as `startAim` judges it at the press. */
  readonly ready: boolean;
}

export interface PressQueueStep {
  /** Ask for this now, and raise the swing hold with its own `held`. */
  readonly send: QueuedPress | null;
  /** What is still waiting. */
  readonly queued: QueuedPress | null;
}

export function drainPress(input: PressQueueInput): PressQueueStep;
```

**One slot, and the last press wins.** There is one thing the player reached
for and it is whichever one they reached for last -- `pendingAim` already says
so in as many words, and a depth of two would be a rotation somebody types in
advance rather than a press that was a few frames early.

**The three gates are `autoAttack`'s three, verbatim.** Not a new rule: they
are already the answer to "is asking worth the round trip", and `pending` is
the one that closes the race in the measurement above, where a press made in
the *gap* was still refused because a swing committed ahead of it.

**There is no expiry, and that is derived rather than skipped.** Each of the
three gates is already bounded by machinery that exists: `rooted` by the cast's
own `endTick` (the client expires a stale cast against it, leaning late by
`CAST_EXPIRY_SLACK_TICKS`), `staggered` by the replicated `activityUntilTick`,
and `pending` by `PREDICTED_CAST_TIMEOUT_TICKS`. A fourth bound over three that
already hold would be a number to keep in step with all of them. What ends a
press early is what already ends every other order -- the stop key, Escape,
death, and the next press -- so the queue joins `dropCommitments`' one list of
what an order is rather than growing a timer of its own.

**Ready is re-asked at the send, and a press that is no longer ready is
dropped.** This is the one rule that was not in the first cut and was put there
by the measurement: with the queue in and nothing else, `alreadyCasting`
disappeared and `onCooldown` took its place. A *second* press made during the
first one's wind-up is still ready by `startAim`'s reading -- the client hides a
predicted cooldown until the release -- so it was queued, waited out that whole
cast, and was refused at the end of it. Dropped instead, and silently, which is
`castOrder`'s rule for the same situation in as many words: *"in reach, and not
ready: the order is dropped rather than parked"*. **What a press waits for is
the body, never the timer.** It is asked last, so a press is only dropped on a
tick it would otherwise have been sent -- while the body is busy the answer can
still change.

**Starvation is prevented by ordering, not by a timeout.** The drain runs
*before* `driveCastOrder` and `driveAutoAttack` in the frame loop, so on the
tick the body comes free the held press is asked for first and the attack
order's own `pending` gate then closes behind it. Without that ordering a
queued press could wait out one swing only to be beaten to the next.

That ordering needs one more thing, and it is the second rule the measurement
found: **the drivers all read one `view`, taken at the top of the frame**, so a
request sent by the one that runs first is not in the `awaitingCast` the ones
after it read. Two requests on one frame is the server taking the first and
refusing the second, and with the drain firing on exactly the tick the body
frees -- which for a bow is one tick off the tick the next swing is due -- the
two collide. `askedThisFrame` is `pending` for the rest of the frame.

### The swing hold moves to the send

`castNow` raises `castPressed` -- spec 258's edge, which takes the directions
already down out of the player's hands so that asking to move does not withdraw
from the blow before it starts. Left at the *press*, a queued cast loses it: the
edge is consumed on that frame, and `swingHold` carries it forward only while
`casting && !committed`, which is the **previous** swing. The hold would be gone
before the cast it belongs to had started, and a player walking on WASD would be
back to spec 258's measurement -- every press refused as `withdrawn`.

So the edge is raised where the request is sent, and it carries the set it was
made with. `swingHold`'s `pressed` stops being a boolean:

```ts
/** The directions that were down when the press was made, or null for none. */
readonly pressed: ReadonlySet<string> | null;
```

still intersected with what is *still* held, which is the existing
release-drops-out rule reused rather than restated. This is the difference
between two right answers and one:

- a direction held **at the press** is suppressed, because the press means
  "stop and do this" -- spec 258 unchanged;
- a direction pressed **after** it withdraws, because asking to move is how a
  body withdraws (spec 079) and that is what the player just asked for.

Taking the set at the send instead would suppress the second one for the whole
wind-up: press the flask, decide to run, and be unable to for most of a second.

Only the *explicit* press raises it. `driveCastOrder` and `driveAutoAttack`
still do not, which is spec 258's rule and unchanged: there a held key means
what it has always meant, and grabbing WASD is how manual control comes back.

### What `view.ts` does

`castNow` goes -- its only caller was the branch this spec replaces -- and its
three lines of "give up everything that would fight it" move to the press,
because clearing the walk and the attack order is about the player having taken
control back, not about when the request happens to leave.

## Invariants tested

- **The press lands.** A self-cast pressed during a swing is asked for and
  accepted, over a real loopback, with no `alreadyCasting` anywhere in the run
  -- at every weapon and at four wire delays. This is `probe-already-casting.ts`'s
  measurement as a test.
- A press with the body free is sent on the same frame, exactly as it is today.
- A press is held while `rooted`, while `staggered`, and while `pending`, and
  sent on the first tick all three are clear.
- One slot: a second press replaces the first, and only one request is sent.
- A press whose ability went on cooldown while it waited is dropped rather than
  sent -- and only on a tick it would otherwise have been sent.
- The stop key, Escape and death each drop a queued press, and nothing is sent.
- A queued press is not starved by the standing attack order: it is asked for
  before the order's next swing, not after it.
- `swingHold` suppresses a direction held at the press and does **not**
  suppress one pressed after it, with the queued cast's own set.
- A queued press made while walking on WASD is accepted rather than refused as
  `withdrawn`.
- Presentation is unmoved: a queued press draws no aim indicator and no armed
  crosshair, because it is a press and not an aim.

Measured through `probe-already-casting.ts`, twelve configurations (three
weapons, four wire delays), swinging and pressing throughout:

```
sent on the press   alreadyCasting up to 13 a run, in every configuration
queued              alreadyCasting 0, onCooldown 0, in every configuration
```

What is left is `staggered` -- the refusal no client-side rule can predict
(spec 173), and present in the swings-only control too -- and `withdrawn`, which
is a player who asked to move.

## Out of scope

- **Withdrawing.** A press during a wind-up waits for it; it does not call it
  off. Calling a blow off is what moving and the stop key are for, and making a
  press do it would hand every skill a free cancel -- which is a balance change
  and the opposite of the commitment this game is built on.
- **Queuing on cooldown.** `startAim` still refuses a press whose ability is not
  ready, which is a rule with its own argument (`aim.ts`: *"a place to park a
  press until the timer comes back, which is a queue"*). What is being waited on
  here is the body, not the timer: the ability is ready and the animation is
  not.
- **The aimed skills.** They already queue, through `AimOrder` and `castOrder`.
  Routing a self-cast through the same order is deliberately not done: a
  self-cast has no range, and `castOrder` would measure the distance back to the
  point the press was made and walk the body to it.
- **The server.** Nothing crosses the wire that did not before, and
  `startCast`'s `alreadyCasting` is unchanged -- it is still the right answer to
  a client that asks anyway.
- **Rewording `alreadyCasting` for a follow-through.** A refusal during a
  backswing is still worded as though a cast were in progress. With the press
  queued nothing honest reaches it any more, so the wording is left alone rather
  than changed twice.
