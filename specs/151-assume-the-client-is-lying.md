# 151 — Assume the client is lying

## Problem

The server already refuses most of what a hostile client can *say*. What it has
no answer to is how **often** it says it. Only chunk requests are budgeted
(`ChunkBudget`); every other verb is processed as fast as it arrives, and the
expensive ones — a trade invite that walks the registry, an inventory write, a
chat line that fans out to every connection — are exactly the ones with no limit
on them. One client can spend the whole server's tick, on everybody else's
behalf.

## What is already true, and stays true

Worth writing down, because a hardening spec that re-litigates settled ground
is how a real gap gets missed:

- **Ownership is structural, not checked.** `moveItem`, `buyItem`, `sellItem`
  and the trade verbs are all keyed on `connection.playerId`, which the server
  set at `Hello` and the client cannot name. There is no message anywhere that
  says "do this to *that* player's bag", so there is no ownership check to
  forget — a client can only ever address its own containers. A slot index is
  bounds-checked against the bag it indexes, and a trade offer names slots that
  are resolved against the bag *at swap time* (spec 132), so a bag that changed
  underneath refuses the whole trade.
- **Malformed frames already survive.** `receive` catches `CodecError` and
  answers with an `Error` rather than dying; `varuint` refuses past eight bytes;
  `str` calls `need(length)` before reading, so a declared length of four
  billion is a thrown `CodecError` and not an allocation.
- **Numbers are already guarded where they reach the sim.** `resolveMovement`
  refuses a non-finite `moveX`/`moveY`/`facing`/`predicted*`; the shop demands
  whole counts of at least one and refuses more than a bag could hold; chat is
  truncated to 240 characters; `playerId` is bounded to 64.
- **The two client-supplied numbers this run added are clamped where they
  land.** `renderLagTicks` (149) is clamped inside `noteLag`, and `resumeToken`
  (150) is matched rather than trusted. Neither needs a special case here,
  which was the point of designing them that way.

## Shape

### A budget per connection, per class of verb

Reusing `ChunkBudget` rather than inventing a bucket: it is a token bucket with
a burst, a refill and a tick, and that is exactly what this wants.

| Bucket | Burst | Refill/s | Covers |
|---|---|---|---|
| `verbs` | 120 | 60 | every client message except the three below |
| `chat` | 5 | 1 | `Chat` |
| `heartbeat` | 8 | 4 | `Ping` |
| — | — | — | `Input` (already `MAX_BUFFERED_INPUTS`), `RequestChunk` (already `ChunkBudget`) |

`verbs` at one a tick is far more than a hand produces and far less than a loop
does. `Chat` gets its own, tighter, because it is the only verb that **fans out
to every other connection** — the one place where one client's message costs
everybody, which is what makes it worth a separate number rather than a
different cost against the same one. `Ping` gets its own because starving the
clock sync to punish a flood would break rate matching (148) on a connection
that is merely noisy.

Over budget, the frame is **dropped silently** — no `Error` reply, because
answering a flood is participating in it. A connection that goes over
`FLOOD_STRIKES` (60) times is dropped outright: past that, the decode cost
alone is worth refusing.

### A frame is bounded before it is decoded

`MAX_FRAME_BYTES` (16384). Anything larger is dropped without being parsed. The
largest thing a client legitimately sends is a trade offer naming 24 slots, and
that is under a hundred bytes; the cap is three orders of magnitude of headroom
and still a bound.

### `displayName`

Bounded to 64, like `playerId`, and for a reason that is new since spec 145:
it now rides on the entity delta to **every client in interest**. An unbounded
name was a string nobody read; it is now a broadcast amplifier.

### Fuzzing

Two properties, both with `fast-check`, which is already a dev dependency:

- **The codec.** For arbitrary bytes, `decodeClientMessage` either returns a
  message or throws `CodecError`. Never any other error, never a hang, never a
  value that is not a message. Same for `decodeServerMessage`.
- **The server.** Arbitrary frames fed into a real `GameServer.receive()` never
  throw, and the world afterwards is still coherent — every entity finite, no
  duplicate ids, the tick still advancing.

### The trade property, extended

Spec 132's rule is that a duplication bug leaves each bag individually
plausible, so you count **both together**. This extends it from a fixed script
to a fuzzed one: two real clients, a random sequence drawn from the five trade
verbs plus disconnects and walks, and after every step the total item count
across both bags plus the table equals what it was at the start. The sequence is
seeded, so a failure is a replay rather than a story.

## Invariants tested

- **A flood is throttled, and a human is not.** A client sending one verb per
  tick indefinitely is never throttled; one sending a hundred per tick has most
  of them dropped, and is disconnected once it has been over budget
  `FLOOD_STRIKES` times.
- **The buckets are independent.** A chat flood does not stop the flooder
  casting, and neither stops it pinging — otherwise a noisy client would lose
  its clock sync and rate matching would fight a problem it did not cause.
- **Chat is the tightest.** Asserted directly, with the reason: it is the only
  verb whose cost is paid by everybody.
- **An oversized frame is dropped unparsed**, and the connection survives it.
- **A long `displayName` cannot be broadcast.** A name of ten thousand
  characters arrives at other clients truncated, and the delta stays small.
- **The codec fuzz holds.** Thousands of arbitrary byte strings, no crash, no
  hang, only `CodecError`.
- **The server fuzz holds.** Arbitrary frames, no throw, world still coherent,
  and a legitimate client connected to the same server is unaffected.
- **Both bags still balance.** The fuzzed trade property above.
- **Nothing already true was broken.** The existing suites — inventory, shop,
  trade, combat, the two-player and resume tests — are unmodified and pass.

## What writing the tests found

The fuzzed trade property **passed while doing nothing**. Random sequences drawn
from the five verbs never complete a trade — the protocol needs an invite
answered before anything else means anything — so "the totals are unchanged" was
being asserted over sixteen runs in which no swap ever happened. A property
about conservation is trivially true of a world where nothing moved.

The fix is a fixed prologue and a random tail, and the guard against it
happening again is a counter: the test asserts that at least one sequence
reached a completed swap. Five of sixteen do, at the committed seed. That
assertion is worth more than the property it protects, because the property
cannot fail loudly and this can.

## Out of scope

- **Authentication.** Anybody who knows a `playerId` can still log in as it.
  Accounts and passwords are out of scope for the whole run, and this spec
  narrows nothing about it: the session token (150) authenticates a *session*,
  not a person.
- **Speed and cheat detection beyond what exists.** The claim check and the
  sequence-gap allowance already refuse impossible movement; deciding that a
  *possible* sequence of inputs is inhuman is a different discipline.
- **Denial of service at the socket layer.** Connection floods, slowloris, and
  anything above the frame — that is a proxy's job, and the brief puts
  deployment out of scope.
- **Encrypting anything.** TLS is out of scope for the run; a resume token on a
  plaintext socket is a token anybody on the path can read, and on localhost
  that is nobody.
