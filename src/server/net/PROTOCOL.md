# turbo-deck wire protocol v17

Binary, not JSON. Every frame is a WebSocket **binary** message whose first byte
is the message type; the rest is a type-specific payload. All multi-byte numbers
are **little-endian**.

Implemented by `protocol.ts` (type bytes), `codec.ts` (primitives),
`messages.ts` (game messages) and `admin-messages.ts` (the `admin:*` namespace).

## Where the socket is

The server shares one port with the admin console (`PORT`, default 8787) and
accepts the upgrade on **any path** — `WebSocketTransport` passes no `path` to
`WebSocketServer`. Clients nevertheless agree on `/ws` (spec 144,
`connection.ts`'s `WS_PATH`), because the dev proxy has to route on something
and it cannot be `/`, where vite's own HMR socket lives. So:

| Client | Dials |
|---|---|
| Browser, `npm run dev` | `ws://localhost:5173/ws`, proxied to `:8787` by vite |
| Browser, direct | `ws://<host>:8787/ws` |
| Node bots (`server:bots`) | `ws://localhost:8787` — the bare origin, still accepted |

Three transports implement `Channel`: `transport-loop.ts` (in-tab
single-player), `transport-ws.ts` (the server's accept side and a Node client),
and `transport-browser.ts` (the DOM `WebSocket`). A browser client must set
`binaryType = 'arraybuffer'`; the frames are binary in both directions and a
text frame is dropped rather than parsed.

## Primitives

| Notation | Bytes | Meaning |
|---|---|---|
| `u8` `u16` `u32` | 1, 2, 4 | unsigned little-endian |
| `i16` `i32` | 2, 4 | signed little-endian |
| `f32` `f64` | 4, 8 | IEEE-754 little-endian |
| `bool` | 1 | `0` false, non-zero true |
| `varuint` | 1–8 | LEB128 unsigned. Ids and counts are small, so they usually cost one byte |
| `varint` | 1–8 | zigzag then LEB128, so small negatives stay one byte |
| `str` | 1+n | `varuint` byte length, then UTF-8 |

## Type-byte ranges

The range **is** the namespace — there is no string tag on the wire, so routing
is one byte and one comparison. A client that never obtains an admin token
cannot address an admin handler at all.

| Range | Direction | Namespace |
|---|---|---|
| `0x01`–`0x3F` | client → server | game |
| `0x40`–`0x7F` | server → client | game |
| `0x80`–`0x9F` | client → server | `admin:*` |
| `0xA0`–`0xBF` | server → client | `admin:*` replies |

## Client → server

### `0x01 Hello`
`u16 protocolVersion` · `str playerId` · `str displayName` · `str token` ·
`str assetManifest` · `str resumeToken`

First message on a connection, and **only** the first: a second one on the same
socket is refused, because obeying it used to spawn a second body and orphan the
first (spec 145). A version mismatch is refused with `Error` and a disconnect.
`token` is empty for a plain player; `displayName` is bounded to 64 characters,
because since spec 145 it is broadcast to every client in interest.

`resumeToken` is empty for a fresh login. One that matches a lingering session
for this `playerId` re-attaches to that body instead of spawning a new one
(spec 150); one that does not match is simply a new login rather than an error,
because a token that has aged out is the ordinary case.

### `0x02 Input`
`varuint seq` · `f32 moveX` · `f32 moveY` · `f32 facing` · `u8 buttons` ·
`f32 predictedX` · `f32 predictedY` · `varuint renderLagTicks`

`renderLagTicks` is how far behind the server's clock the world this input was
made against is being drawn (spec 149) — one-way latency plus up to a broadcast
interval. It is what a blow is resolved against, so that a swing lands on what
its attacker was looking at. Client-reported and clamped to `MAX_REWIND_TICKS`
(12) the moment it arrives: the most a liar achieves is the compensation an
honest player on a 200ms connection already gets.

The only message that drives the sim. Note what a client may say: a **direction**
(clamped server-side to at most unit length), where it is aiming, which buttons
are down, and — as a hint only — where its own prediction landed.

`seq` is monotonic per connection. A repeated or out-of-order `seq` is dropped.
The server applies **one input per tick**, so sending faster buys nothing.

`buttons` bits: `1` attack, `2` parry, `4` dodge, `8` sprint.

`predictedX/Y` is never adopted as position — it is only measured, to decide
whether a `Correction` is owed.

### `0x08 UseAbility`
`str abilityId` · `f32 targetX` · `f32 targetY` · `varuint targetEntityId` ·
`varuint afterInputSeq`

Asks to commit to an ability (spec 062). The server decides: cooldown, cost,
range, and whether something is already winding up. It answers with `CastState`
or `CastRejected` — exactly one of them, per request, in the order the requests
arrived, which is how a client with several in flight tells the answers apart.

`afterInputSeq` is the last input `seq` the client had sent when it asked
(spec 067). The server holds the request until it applies *that* input, rather
than acting on the tick the frame arrived: inputs are queued, so those are
different ticks, and committing on the stamped one is what makes the client's
own predicted root land in the same place as the server's.

`targetX/Y` is a world point. A `direction`-targeted ability treats it as where
to aim; a `point`-targeted one as where to land, and refuses it past its range;
a `self` one ignores it.

`targetEntityId` names a body, or is `0` for an aim at the point alone
(spec 070). A melee cast that names one is single-target: it resolves against
that entity and nothing else, and only if it is hostile, alive and still within
reach *at the release* — so a target that walked out during the wind-up is a
miss rather than a free hit. It is a request like everything else on this side
of the wire; the server checks it and lands nothing if it does not hold.

### `0x09 CancelCast` — `varuint afterInputSeq`
Withdraws from whatever is winding up. Legal only during the wind-up (and for
the duration of a channel); past the release tick the effect has happened and
there is nothing to call off. A cancelled cast refunds its cost and clears its
cooldown, so the only thing it spent is time.

### `0x0a RequestChunk`
`varuint layer` · `varint cx` · `varint cz`

Asks for one chunk of the map (spec 072). Answered with exactly one `MapChunk`
or one `ChunkDenied`.

The server serves it only if **its own** position for that player is within
`MAP_CHUNK_REQUEST_RADIUS` map chunks (Chebyshev) of the one asked for. The
client's `predictedX/Y` is never consulted: it is a hint the sim measures for
corrections, and honouring it here would let anyone read the whole map by
claiming to stand anywhere. A per-connection token bucket bounds the rate on top
of that, because every chunk under a standing player is permanently in range.

Note the grid: map chunks are the document's own `cellSize * chunkCells` buckets
(616 units today), *not* the `chunkSize` the welcome announces, which is the
400-unit entity-interest grid. Three grids, deliberately independent.

### `0x16 Goodbye` — no payload
Says the disconnection was meant (spec 150). A dropped socket leaves the body
standing for `RESUME_GRACE_TICKS` so the session can be resumed onto it; this
reaps it at once. Pulling the plug and choosing to leave should not look the
same to the world.

### `0x03 Ping` — `u32 nonce`
Answered with `Pong` carrying the same nonce and the server's tick. The client
sends one every half second and counts its own ticks until the answer: that is
the only clock it has, and half of it is how far behind the server a delta is by
the time it lands (spec 067).
### `0x04 Equip` — `str slot` · `str itemId`
### `0x05 Unequip` — `str slot`
### `0x06 SpendSkillPoint` — `str skillId`
### `0x07 Chat` — `str text` (truncated to 240 chars; refused while muted)

Equip, unequip and skill spends each trigger a full server-side stat
recalculation and are answered with a fresh `Stats` message, or with `Error`
(`RejectedAction`) and no state change. Since spec 126 equip and unequip are
`MoveItem` underneath -- they name an item id rather than a slot index, and they
are refused unless the player is carrying the item. Both also answer with an
unprompted `Inventory`, and both should go away once nothing sends them.

### `0x0c MoveItem`
`varuint requestId` · `u8 fromContainer` · `varint fromIndex` ·
`u8 toContainer` · `varint toIndex` · `varuint count`

Move one item from one slot to another (spec 126). `container` is `0` inventory
and `1` equipment; `index` is a bag slot or the ordinal of an `EquipSlot`, and it
is **signed** because an out-of-range index is a rule refusal with a reason
attached, not a malformed frame. `count` of `0` means the whole stack; any other
value splits.

The only container write there is: equip, unequip, swap, merge and split are all
this message with different addresses, which is what keeps the conservation rule
in one place. Answered with an `Inventory` at the same `requestId` whether it was
taken or refused, plus an `Error(RejectedAction)` when it was refused.

### `0x19 PickUpItem`
`varuint requestId` · `varuint entityId`

Take a drop off the ground (spec 158). The drop's **entity id** is the only
address it has — it is not in a container until it is in the bag.

The server checks all five: the entity is a drop, the asker is alive, the drop
is theirs, they are within `PICKUP_RANGE` of it, and the bag has room. Answered
with an `Inventory` at this `requestId` whether it was taken or refused, plus
`Error(RejectedAction)` when it was refused — the same shape `MoveItem` uses,
and for the same reason: the refusal is what a client's optimistic guess is
rolled back by.

**A drop may be taken before its reveal has finished**, and is served
immediately when it is. The pending presentation simply never happens.
Anticipation is never a lock on the player's hands.

### `0x1c Talk`
`varuint entityId`

Start or end a conversation with a friendly NPC (spec 246). `entityId` of `0`
ends whatever is in progress rather than naming a body — one message rather
than two, the same convention `OpenVendor`'s empty id already uses, so a client
leaving cannot be a client that forgot to say it was leaving.

No request id, because nothing about a conversation is predicted: the answer
decides whether a body stops walking, and a client that opened a bubble on the
press would draw a conversation with something still ambling away.

Answered with a `Conversation` **either way**, so a refusal is distinguishable
from a dropped message. The server refuses a body that is not an NPC, is dead,
is outside its own `talkRadius`, or is already claimed by another player —
silently, with a `Conversation 0`, because every one of those is something the
player can see and a refusal line for standing slightly too far away is noise.

What the NPC *says* is not on this wire at any point. The script, the name and
the voice are a content table both ends were built from, so sending them would
be replicating a file the client already has.

### `0x1b DropItem`
`varuint requestId` · `u8 container` · `varint index` · `varint count` ·
`f32 aimX` · `f32 aimY`

Put a stack down in the world (spec 172). The address and the count read exactly
as `MoveItem`'s do — `0` is the whole stack — because a drop *is* a move whose
target is the ground, and the ground has no slot to name.

`aim` is the world point the cursor was over, and it is an **aim rather than a
landing**. The body turns to face it first, at its own `turnRate` and under the
server's own `resolveFacing`, and the item is then thrown a constant reach along
that line — so a point on the horizon and a point two paces away are the same
request in every respect but direction. A client naming where an item lands is a
client throwing one across the map.

The turn is not a cast: no cost, no cooldown, no wind-up, no backswing, nothing
rooted and no `CastState` on the wire. What the other clients see is the body's
replicated `facing` coming round, which they already draw.

The server checks the asker is alive and that the slot holds that many, at the
moment the drop actually happens rather than when it was asked for. Answered with
an `Inventory` at this `requestId` either way, plus `Error(RejectedAction)` on a
refusal — the same channel `MoveItem` uses, since this edit is predicted and a
refusal is what takes the guess back. A drop that never gets its turn — the body
died, the queue overflowed, or the heading did not arrive inside the timeout —
is one of those refusals, and the item never left the bag.

What appears is an ordinary drop entity with two differences from a kill's: it is
**unowned**, so anybody who reaches it may take it, and it is **revealed on its
spawn tick** at every tier, because the reveal withholds an identity from
somebody who does not know it and the person who emptied their own bag does.

### `0x1a Respawn`
*(no payload)*

"Put me back on my feet" (spec 164). Honoured only from a connection whose body
is at zero health, and honoured at once when it is: full health, the flask
restored and the restoration meter cleared (spec 156's reset), placed at
`DEFAULT_SPAWN` through the same `clearSpawnNear` the login path uses, and
answered with a `Correction(Teleport)` that pardons the jump.

From a living body it is ignored silently — a respawn is a free full heal and a
free trip home, so "only when dead" is the whole of its validation, and a client
that pressed the button twice inside one round trip has not done anything worth
a refusal for.

There is no respawn timer. A dead player lies there until they ask.

### `0x0b WatchSpawners`
`bool on`

Turns the `SpawnerStates` readout on or off (spec 076). The only client message
that changes nothing about the world: it subscribes to a debug readout, so a
client that never sends it is never sent one, and the overlay costs nothing
while it is switched off. Needs no player and no entity.

## Server → client

### `0x40 Welcome`
`u16 protocolVersion` · `str playerId` · `varuint entityId` · `u32 tick` ·
`u8 tickRate` · `u16 chunkSize` · `u8 interestRadius` · `f32 correctionThreshold` ·
`u32 worldSeed` · `str sessionToken`

Chunk size and interest radius are announced rather than compiled into the
client, so retuning them needs no client release.

`sessionToken` is presented in a later `Hello` to come back to this same body
after a dropped socket, or after a page reload (spec 150). It comes from
`crypto.randomUUID`, never from the world's seeded `Rng`: that generator is
reproducible on purpose, which is precisely what a resume token must not be.

`worldSeed` used to be the client's whole terrain source (spec 063). Since
spec 072 it is provenance and the fight's randomness only — the ground arrives
as `MapInfo` and `MapChunk`.

### `0x41 Delta`
`u32 tick` · `varuint ackInputSeq` ·
`varuint removedCount` · `varuint removedId × removedCount` ·
`varuint upsertCount` · `entityRecord × upsertCount`

`ackInputSeq` is the highest input this client sent that the server has applied
— the anchor a client replays its unacknowledged inputs from.

`removed` are entities that left this client's interest set or despawned.

**Entity record**: `varuint id` · `u8 fields` · then only the flagged members:

| Bit | Field | Payload |
|---|---|---|
| `0x01` | Spawn | `u8 kind` · `str typeId` |
| `0x02` | Position | `f32 x` · `f32 y` · `f32 z` |
| `0x04` | Facing | `f32 facing` |
| `0x08` | Health | `f32 health` · `f32 maxHealth` |
| `0x10` | Activity | `u8 activity` · `u32 activityUntilTick` |
| `0x20` | Level | `varuint level` |
| `0x40` | Identity | `str name` · `f32 turnRate` |

`Identity` is sent for **players only** (spec 145), alongside `Spawn` on first
sight and again whenever the turn rate changes. A monster's name and turn rate
are in `MONSTERS`, which the client already has, and putting a content table on
the wire is what "an entity only ever stores an id" exists to prevent. A
player's name is the one field on an entity that a human typed.

The bitmask *is* the delta: an entity that did not move contributes no position
bytes, and an entity that did not change at all is not in the frame. A frame
with no upserts and no removals is not sent.

`Spawn` is set the first time an entity enters this client's interest set, and
carries identity so a client never has to infer a field it was not told.

`kind`: `0` player, `1` monster, `2` prop, `3` projectile, `4` mote, `5` drop.

A **mote** (spec 156) is a restorative pickup and is replicated to exactly one
client: the player it belongs to. The filter is server-side, in
`broadcastDeltas`, so there is no ownership field on the wire and nothing for
another client to reason about — a mote a teammate cannot see is a mote they
cannot take. Its `typeId` says what it restores: `mote.vitality` or
`mote.focus`.

A **drop**'s `typeId` is **empty and stays empty** (spec 158). What the item is
travels on `LootDrop`, never here: this record goes to every client in interest
range on first sight, and what an unrevealed drop is must not. Unlike a mote it
*is* replicated to everyone in range — two players watching the same kill watch
the same throw — and ownership is a server-side check on `PickUpItem` rather
than anything on the wire — and is absent entirely on a drop a player put down
(spec 172), which belongs to whoever gets there.
`activity`: `0` idle, `1` moving, `2` casting, `3` stunned, `4` dead, `5` recovering.

A projectile in flight is an ordinary entity (spec 062), so it replicates
through this same delta rather than through a parallel system. Its `z` carries
the arc height, which is what lets a client draw a lobbed shot rising and
falling with a shadow underneath it.

Since spec 079 a shot can be *tracking* a body, so its position changes on a
curve the client was never told about. Nothing new is sent for it: the position
is authoritative every tick and the client interpolates between the samples it
gets, exactly as it does for anything else that walks.

### `0x42 Correction`
`varuint inputSeq` · `f32 x` · `f32 y` · `f32 z` · `f32 facing` · `u8 reason`

Sent when the client's prediction disagrees with the server. The client adopts
this position as of `inputSeq` and **replays** every input after it.

`reason`: `0` divergence past the threshold, `1` speed violation, `2` collision
or terrain, `3` admin teleport, `4` drift.

`4` is the ordinary one and the others are not (spec 067). Drift means the
prediction is merely a little wrong: adopt it exactly, but *ease* the difference
into the drawn position over a few ticks rather than snapping the body. It is
throttled to the broadcast cadence, so a wrong client costs at most one small
message per delta and a right one costs nothing at all. Every other reason is a
client that cannot be believed, and snaps.

### `0x43 CombatResult`
`varuint attackerId` · `varuint targetId` · `f32 damage` · `f32 targetHealth` ·
`u8 flags`

The authoritative outcome of one hit: what was taken off, and what is left. The
client plays the numbers back rather than recomputing them, which is what keeps
two clients watching the same fight agreeing about it.

Protocol 3 (spec 065) removed `hitstopTicks`, `knockbackX`, `knockbackY` and
`knockbackTicks` along with the mechanics behind them. Nothing is displaced by a
hit, so nothing about displacement is described here.

`flags` bits: `1` killing blow, `2` critical, `4` mitigated by armour.

Sent to every connection whose interest set contains the attacker or the target.

### `0x44 Stats`
`varuint entityId` · `varuint level` · `varuint experience` ·
`varuint unspentSkillPoints` · then the effective stat block:
`f32 maxHealth` · `f32 moveSpeed` · `f32 turnRate` · `f32 attackDamage` ·
`f32 attackRange` · `u16 attackCooldownTicks` · `f32 attackSpeed` · `f32 armor` ·
`f32 spellPower` · `f32 critChance` · `f32 maxResource` · `f32 resourceRegen` ·
`str basicAttackId`

`basicAttackId` is the ability this character's auto-attack uses (spec 079),
derived from the main hand. The client needs it to know what its right-click
reaches with, which cooldown the sweep is drawn against, and which ability to
ask for; a body that never attacks carries `''`.

`attackCooldownTicks` is the *base* interval between basic attacks and
`attackSpeed` is the multiplier on it (spec 070); the swing cadence is
`attackCooldownTicks / attackSpeed`, floored at one tick.

Every one of these is derived server-side from base stats, skill levels and
equipped item ids. None is ever persisted, and none is ever accepted from a
client.

### `0x4d Cooldowns`
`varuint count` · then per entry: `str abilityId` · `u32 readyAtTick`

The owner's live cooldowns (spec 065). Sent only to the connection they belong
to, and only when the map changes — a cooldown nobody else can act on is nobody
else's business.

Whole rather than as a diff: it is a handful of entries, and a diff would need
its own removal encoding to express a refund, which is precisely the case that
matters since cancelling a wind-up clears a cooldown.

Entries already expired when the frame is built are omitted. One that expires
later, with no cast in between, is simply left with the client: `readyAtTick` is
in the past, so the client's own `readyAtTick - tick` is negative and it draws
nothing.

### `0x55 Restoration`
`u8 meter` · `u8 charges` · `u8 maxCharges` · `u32 atTick`

The health economy's two live numbers (spec 156), owner-only and sent when
either changes — the same reasoning as `Cooldowns`, with one difference: there
is nothing here for a client to model forward. The meter moves on kills and the
flask on casts and rests, so "has it changed" is a comparison against what was
last sent rather than against what the client would have believed.

`meter` is a **fraction** of the restoration threshold, quantised to a byte —
not the absolute progress the sim keeps. A bar only asks how full it is; the
threshold is tuning that may move between builds; and a client told its raw
progress could work out exactly which kill produces the next mote, which is a
thing to farm rather than a thing to feel. The dirty check is made on the
quantised value, so a meter drifting by a thousandth does not turn this into a
per-tick broadcast.

`maxCharges` rides along because Constitution decides it, so the client can draw
the empty pips as well as the full ones.

### `0x45 Chat` — `u8 channel` · `str from` · `str text`
`channel`: `0` say, `1` system, `2` admin broadcast.

### `0x46 Pong` — `u32 nonce` · `u32 serverTick` · `varuint inputQueueFloor`

`inputQueueFloor` is the **smallest** this connection's input queue got since
the last pong, sampled every tick and reset when reported. A floor rather than
an instantaneous reading because pongs arrive at 2Hz and the queue oscillates at
60Hz: sampled at an instant, a starving connection reads 1 about as often as 0
and the client's rate controller cannot see the starvation at all (spec 148).
It rides here rather than on `Delta` because a delta is suppressed when nothing
moved, which would blind the controller in exactly the quiet moments drift
accumulates through.
### `0x47 Error` — `u16 code` · `str message`
`code`: `1` bad protocol version, `2` malformed frame, `3` not authenticated,
`4` not authorized, `5` banned, `6` muted, `7` rejected action, `8` unknown message.

### `0x48 Disconnect` — `str reason`

### `0x49 CastState`
`varuint entityId` · `str abilityId` · `u8 phase` · `u32 startTick` ·
`u32 releaseTick` · `u32 endTick` · `f32 targetX` · `f32 targetY` ·
`varuint targetEntityId`

Someone committed to an ability, or moved between its phases. `phase`: `0`
wind-up, `1` channel, `2` backswing, `3` turning.

`releaseTick` is the **attack point** — when the effect lands, and the boundary
past which the cast can no longer be withdrawn from. `startTick` is when the
wind-up began, and it is on the wire rather than derived because attack speed
scales the wind-up (spec 144): a bar drawn against the ability table's
`windupTicks` runs at the wrong rate for exactly the bodies attacking fastest.
`endTick` is when the caster is free — the release for most abilities, the end
of the backswing for a basic attack, the end of the pulses for a channel.

Sent to everyone whose interest set contains the caster, so other players see a
telegraph too, and re-sent on every phase change: a `phase: 2` message is the
"this attack has committed" notice.

### `0x4A CastEnded`
`varuint entityId` · `str abilityId` · `u8 reason`

`reason`: `0` released, `1` cancelled, `2` interrupted, `3` backswing cancelled.

`1` means the attack **did not happen** — withdrawn from before the attack
point, cost refunded, no interval started. `3` means it **already happened** and
only the remaining animation was skipped: nothing is refunded and the attack
interval runs on untouched (spec 144). A client that treats the two alike hands
back a cooldown the server is still holding.

### `0x4B Effect`
`str effectId` · `f32 x` · `f32 y` · `f32 z` · `f32 radius` · `u16 durationTicks`

A point cue to draw: an impact, a blast, a heal. Deliberately not tied to an
entity — an impact outlives the projectile that caused it, and a blast never had
a body at all. Delivered on proximity to the point rather than by entity
interest, for the same reason.

### `0x4C CastRejected`
`str abilityId` · `str reason`

Why the server would not start an ability. Sent only to the client that asked:
`onCooldown`, `notEnoughResource`, `alreadyCasting`, `outOfRange`,
`unknownAbility`, `stunned`, `dead`.

### `0x4e MapInfo`
`str mapId` · `u32 seed` · `varint cellSize` · `varuint chunkCells` · `rect arena` ·
`varuint speciesCount` · `str × speciesCount` ·
`varuint layerCount`, then per layer: `str id` · `u32 seed` ·
`varint originX` · `varint originZ` · `rect bounds` ·
`varint baseY` · `bool hasWater` · `varint waterLevel` ·
`varuint coordCount` · (`varint cx` · `varint cz`) × coordCount

Sent unprompted straight after `Welcome`, because a client can ask for nothing
until it has it. The coord list is which chunks were actually baked, so a client
never asks for one that does not exist. The species list is advisory — for
building one instanced mesh per species up front — since each chunk carries its
own table.

`origin` is the world point of the layer's chunk `(0, 0)`, and every `cx`/`cz`
below is measured from it (spec 083). It is sent rather than inferred from
`bounds.min` because a map that has grown west or north has chunks at negative
coordinates and an origin that no longer sits at its corner — a client that
assumed the two were the same would place every streamed chunk at an offset.

`bounds` is what the layer *declares*, which on a partially streamed map is
wider than the chunks in hand. The client's world edge comes from it, so the
wall does not move as chunks arrive.

A `rect` is four `varint`s: `minX` · `minZ` · `maxX` · `maxZ`. `cx` and `cz` are
zigzag varints throughout, so a negative chunk coordinate still costs one byte.

### `0x4f MapChunk`
`str mapId` · `varuint layer` · `varint cx` · `varint cz` · `varuint cols` · `varuint rows` ·
`varuint heightCount` · `varint × heightCount` (delta-encoded) ·
`runs solid` · `runs materials` · `runs tones` ·
`bool hasNav` · `runs nav` (only when `hasNav`) ·
`varuint speciesCount` · `str × speciesCount` ·
`varuint propCount`, then per prop: `varuint speciesIndex` · `varint x` · `varint z` ·
`varint rotation` · `varint scale` · `varint tint` · `u8 flags` ·
`varuint markerCount`, then per marker: `u8 kind` · `str id` · `varint x` · `varint z` · `str label`

A `runs` is `varuint pairCount` then that many `varuint`s — the document's own
run-length `value, count` pairs, passed through rather than expanded.

`flags`: `1` align, `2` uniform. `kind`: `0` spawn, `1` objective, `2` campfire,
`3` trigger. An empty `label` string means the marker had none.

**Every coordinate in this message is an integer of thousandths, not an `f32`.**
The document is quantized to three decimals and most such values have no exact
`f32`; a client decoding floats would sample a heightfield a few ulps from the
server's and get corrected on ground that looks flat. Heights are additionally
delta-encoded against the previous corner, which roughly halves the largest
array at no cost in fidelity since it is integer arithmetic throughout.

Note `tint` is a quantized *tone*, not a packed colour — encoding it as a `u32`
rounds every prop's tint to zero.

The species table is chunk-local, duplicating a few short strings per chunk, so
that decoding needs no earlier frame. `decodeServerMessage` is stateless and a
frame readable only after another frame would break that quietly.

### `0x50 ChunkDenied`
`varuint layer` · `varint cx` · `varint cz` · `u8 reason`

`reason`: `0` out of range, `1` unknown chunk, `2` throttled. It exists so a
client can retire the request from its in-flight set rather than waiting
forever. `unknown` is permanent and the client stops asking; the other two are
temporary and the chunk goes back on the wanted list.

### `0x51 SpawnerStates`
`u32 tick` · `varuint count` · per spawner: `str id` · `str monsterId` ·
`varint x` · `varint z` · `u8 state` · `varuint ticks`

What every spawn point the map places is doing (spec 076). `state` is `0`
occupied and `1` counting down; `ticks` is what is left of the timer, and `0`
while occupied. Coordinates are thousandths, like every other coordinate since
spec 072 — they come out of the document and an `f32` cannot hold most of them.

Sent on the broadcast cadence, and **only to a connection that sent
`WatchSpawners(true)`**. It carries the whole map rather than the player's
interest set: these are markers a level designer placed, so there are tens of
them, and an overlay that faded out at the interest radius would be worst at
exactly the question it exists to answer.

### `0x0d OpenVendor` — `str vendorId`
### `0x0e BuyItem` — `varuint requestId` · `str vendorId` · `str defId` · `varint count`
### `0x0f SellItem` — `varuint requestId` · `str vendorId` · `varint index` · `varint count`
### `0x10 BuyBack` — `varuint requestId` · `str vendorId` · `varint index`

Trading with a vendor (spec 129). `OpenVendor` with an empty id closes whatever
is open. Counts and indices are **signed** for the same reason a slot address is:
a nonsensical value is a rule refusal carrying a reason, not a corrupt frame and
a dropped connection.

All three transactions are answered with an `Inventory` at the request id — which
now carries the purse as well as the bag, because a purchase changes both at the
same instant — plus a fresh `VendorState`, since a sale changes what can be
bought back. A refusal also gets `Error(RejectedAction)`.

Nothing here is predicted by the client. A purchase is not a drag: there is no
ghost to draw and no gesture to keep up with, and the money is the one number
nobody wants to watch flicker and settle.

### `0x11 TradeInvite` — `varuint entityId`
### `0x12 TradeRespond` — `u8 accept`
### `0x13 TradeOffer` — `varuint slotCount` · per slot: `varint index` · `varint count` · `varint coins`
### `0x14 TradeAccept` — `varint revision`
### `0x15 TradeCancel` — no payload

Trading with another player (spec 132). **None of them carries a trade id**: a
player is in at most one trade, so an id would be a field a client could get
wrong for no benefit, and the server resolves it from who is asking -- the one
answer that cannot be spoofed.

`TradeOffer` sets a side's offer **whole**, replacing what was there, for the
reason `MoveItem` is one message: a protocol with `add` and `remove` has two
handlers that can disagree about what is on the table, and the thing on the table
is exactly what must not be ambiguous. Indices and counts are signed, like every
other slot on this wire.

`TradeAccept` names the revision it is accepting, and a stale one is refused
rather than upgraded. Every edit to either offer bumps the revision and clears
**both** acceptances, which is what makes the swap-it-at-the-last-instant scam a
mechanical impossibility rather than a race worth timing.

Each of the five is answered with a `TradeState` to *both* sides. A refusal also
gets `Error(RejectedAction)`, to the side that asked.

### `0x54 TradeState`
`varuint tradeId` · `u8 stage` · `varuint revision` · `you` · `them` · `str reason`,
where each side is `str playerId` · `str displayName` · `varuint offerCount` ·
per entry: `str defId` · `varuint count` · `varuint coins` · `u8 accepted`

The whole trade, to both sides, on every change (spec 132). `you` is always the
player being sent to. `stage` is one of `TradeStageValue`; `done` and `cancelled`
are the last message a trade sends, and `reason` says why it ended badly.

An offer is **resolved to items** rather than sent as slot indices: the other
player cannot see into your bag, and a bare index would mean nothing to them. The
offering side gets the same view, so both players are looking at the same
description of the same table.

A trade ends on a cancel from either side, a disconnect, either player dying,
the two of them walking further apart than `TRADE_RANGE`, or the swap being
refused -- and the reason is carried in all five cases. There is no timeout.

### `0x53 VendorState`
`str vendorId` · `str name` · `varuint stockCount` · per entry: `str defId` ·
`varuint price` · `varuint buybackCount` · per entry: `str defId` ·
`varuint count` · `varuint price`

What a vendor offers and what can be undone (spec 129). **An empty `vendorId`
means the shop is closed** — the answer to walking away, to a vendor that does
not exist, and to standing too far off. A client is told rather than left holding
a stale price list it can keep clicking.

Prices are the server's, computed from `value` in `data/items.ts` times the
vendor's rate at the moment of the answer. Buying rounds up and selling rounds
down, so a round trip never profits.

### `0x52 Inventory`
`varuint requestId` · `varuint slots` · per slot: `str defId` (empty = the slot
is empty) · `varuint count` (absent for an empty slot) · then one `str` per
`EquipSlot`, in `EQUIP_SLOTS` order (empty = nothing worn) · `varuint coins`

What the player is carrying and wearing (spec 126). `requestId` is the `MoveItem`
this answers, or `0` for an unprompted resend — login, and the equip/unequip
messages that predate this one.

**The whole container, never a delta.** Twenty-four slots of an id and a count is
a few hundred bytes, where a delta would be a second description of the same
state that can drift from it. The client's optimistic guess is *replaced* by what
arrives, so rollback is not a code path — it is what happens when the resend
disagrees, and it therefore cannot rot from disuse. That is also why a **refused**
move is answered with this message too: the refusal is exactly when the client's
guess needs taking away.

Equipment slot order is the wire contract: a new slot is appended to
`EQUIP_SLOTS` and never reordered, because there are no names on the wire.

### `0x57 Conversation`
`varuint entityId`

Which NPC this client is talking to, or `0` for none (spec 246). The answer to a
`Talk`, and also what arrives **unasked** when the server ends one: the player
walked past `talkRadius`, either body died, the NPC despawned, or the connection
dropped and came back. So a client never has to infer the end of a conversation
from the absence of something.

Sent to the player in the conversation and to nobody else. What every other
client sees is a body that has stopped walking and turned to face somebody, and
both of those already replicate on the delta — there is no "is talking" bit,
because standing still and facing you *is* the tell.

The claim itself lives on the NPC's entity in the sim (`conversationWith`),
which is what stops it wandering off mid-sentence and what a replay reproduces.
This message is the client's copy of that fact, reconciled once per broadcast:
the server asks whether the conversation is still holdable rather than raising
an event when it is not, so a release path added later cannot forget to fire one.

### `0x56 LootDrop`
`varuint entityId` · `u8 rarity` · `u32 spawnTick` · `u32 revealTick` ·
`f32 originX` · `f32 originY` · `f32 originZ` · `str defId` · `varuint count`

An item lying in the world, and how much of it this client is allowed to know
yet (spec 158). Sent when the drop first enters this connection's interest set —
the same first-sight the delta's `Spawn` bit computes, so there is no second
visibility system — and again on the tick it reveals.

**`defId` is `''` and `count` is `0` until the reveal.** The identity is absent
from the wire rather than flagged on it, so there is no path by which a client
could draw it early. A client whose first sight is *after* the reveal gets the
filled version straight away, which makes the late observer and the reconnecting
one the same case with no code of their own.

`rarity` is the tier's index in `RARITY_IDS` (`0` common, `1` rare, `2`
exceptional) and *is* sent up front, deliberately: the anticipation cue is
tier-shaped, so playing it needs the tier. That is the "notice" step. What is
withheld is the payoff.

`origin` is where the body fell — the point the item was thrown *from*. The
entity's own replicated position is where it **landed**, scattered server-side
from a seeded draw, so the two are the ends of an arc the client draws over
`TOSS_TICKS` and nothing simulates. It is authoritative for one reason: every
player has to see the same throw, and a scatter picked client-side would put the
same sword in a different place on every screen. A client whose first sight is
after the toss computes "already landed" from the same two numbers, with no case
of its own.

`spawnTick` and `revealTick` are both sent because the client draws the run-up
against the whole span. Its own "when did I first see this" is not the answer —
it would restart the anticipation for somebody who walked up halfway through.
`revealTick === spawnTick` means there was never anything to wait for, which is
every `common` drop.

The server sends this to everyone whose interest set contains the drop, not only
to its owner: the flare is in the world, so two players watching it resolve see
the same thing at the same instant. **Ownership is not on the wire** — it is a
server-side check on `PickUpItem` and nothing a client is told.

## `admin:*` — client → server

Every one of these is refused unless the connection's stored token verifies **on
that message**, with a `role: admin` claim. Authentication is not a flag set once
at connect: the token is re-verified per request, so expiry takes effect
immediately. Every **decision**, accepted or refused, appends an audit entry;
the reads — `listPlayers`, `getConfig`, `getItems`, `getAudit` — do not, because
asking who is online is not something done to anybody and the console polls the
list once a second for its live count (spec 154).

| Byte | Message | Payload |
|---|---|---|
| `0x80` | `admin:auth` | `str token` (HS256 JWT) |
| `0x81` | `admin:listPlayers` | — |
| `0x82` | `admin:kick` | `str playerId` · `str reason` |
| `0x83` | `admin:ban` | `str playerId` · `u32 seconds` (0 = permanent) · `str reason` |
| `0x84` | `admin:mute` | `str playerId` · `u32 seconds` (0 = unmute) |
| `0x85` | `admin:teleport` | `str playerId` · `f32 x` · `f32 y` |
| `0x86` | `admin:spawnEntity` | `str entityType` · `f32 x` · `f32 y` · `u16 count` |
| `0x87` | `admin:despawnEntity` | `varuint entityId` |
| `0x88` | `admin:triggerEvent` | `str eventName` · `f32 x` · `f32 y` · `f32 magnitude` |
| `0x89` | `admin:broadcast` | `str text` |
| `0x8A` | `admin:setConfig` | `str key` · `f64 value` |
| `0x8B` | `admin:getConfig` | — |
| `0x8C` | `admin:getAudit` | `u16 limit` |
| `0x8D` | `admin:setProgress` | `str playerId` · `u8 mode` · `u32 amount` |
| `0x8E` | `admin:giveItem` | `str playerId` · `str defId` · `u16 count` |
| `0x8F` | `admin:getItems` | — |
| `0x90` | `admin:kill` | `str playerId` |

Events currently understood by `triggerEvent`: `raid` (magnitude = how many),
`clear` (magnitude = radius), `heal`, `drop` (magnitude = the rarity ordinal —
an unowned drop of that tier) and `reveal` (magnitude = radius — pulls every
unrevealed drop in range to its reveal now).

Those two plus `lootRevealScale` are the whole developer path for spec 158:
spawn a chosen tier, stretch or collapse its run-up, and force one that is
already lying there. **None of them can change what the item is** — there is
nothing in any of them that could, which is the design rather than a promise.

`setProgress` modes (spec 154): `0` addLevels, `1` setLevel, `2` addExperience,
`3` setExperience. An unknown mode is a `CodecError` rather than a no-op, because
the mode selects arithmetic. `amount` is a `u32`, so an `Add` cannot be negative
by construction — a decrease is a `Set`, and so is a reset (`setLevel 1`,
`setExperience 0`). Levels are clamped to `MAX_PLAYER_LEVEL`, experience is
clamped into its own level's band, and skill points are re-derived from the
resulting level rather than adjusted; a level too low to pay for the tree it
inherits clears the tree and refunds every earned point.

Live config keys: `spawnRateMultiplier`, `dropRateMultiplier`,
`lootRevealScale`, `maxEntitiesPerChunk`, `correctionThreshold`,
`speedTolerance`, `spawnIntervalTicks`. Values are clamped to per-key bounds; an unknown key or a
non-finite value is refused rather than silently ignored.

## `admin:*` — server → client

| Byte | Reply | Payload |
|---|---|---|
| `0xA0` | Ok | `u8 requestType` · `str message` |
| `0xA1` | Error | `u8 requestType` · `str message` |
| `0xA2` | PlayerList | `varuint count`, then per row: `str playerId` · `str displayName` · `varuint entityId` · `f32 x` · `f32 y` · `f32 z` · `str zone` · `str chunk` · `f32 health` · `f32 maxHealth` · `varuint level` · `f32 attackDamage` · `f32 moveSpeed` · `bool muted` · `varuint experience` · `varuint experienceToNextLevel` · `varuint unspentSkillPoints` · `varuint unspentAttributePoints` |
| `0xA3` | Config | `varuint count`, then per entry: `str key` · `f64 value` |
| `0xA4` | Audit | `varuint count`, then per entry: `f64 at` (epoch ms) · `str actor` · `str action` · `str target` · `str detail` · `bool accepted` |
| `0xA5` | ItemList | `varuint count`, then per row: `str id` · `str name` · `str slot` (`-` when it is not worn) · `varuint levelRequirement` · `varuint maxStack` |

`ItemList`'s count is decoded through `BufferReader.count()` (spec 152), so a
declared length larger than the frame can hold is a `CodecError` rather than an
allocation. The three replies above it predate that primitive.

## Client-side prediction contract

1. The client simulates its own movement locally the instant an input is
   produced, and keeps every unacknowledged input in a buffer keyed by `seq`.
2. Each `Delta` carries `ackInputSeq`. The client discards buffered inputs at or
   below it.
3. If a `Correction` arrives, the client adopts the given position as of
   `inputSeq` and **replays** every buffered input after it through the same
   local movement code. A `drift` correction is adopted the same way but drawn
   with a decaying offset, so the state is right at once and the picture catches
   up without a snap.
4. If no `Correction` arrives, the prediction agreed with the server to within
   a quarter of a unit and the client keeps its own position untouched — no
   snap, no bandwidth. That silence is the point.
5. A client also predicts the *root* a commit puts on it: from the moment it
   asks for an ability until the server answers, it sends no movement
   (spec 067). This costs nothing when the guess is wrong, because being rooted
   is expressed as `moveX = moveY = 0` in the input, and a server that refused
   the cast honours that zero like any other.

Other entities are not predicted; they are interpolated between deltas.

## Map streaming contract

1. The server sends `MapInfo` unprompted after `Welcome`. Until it arrives the
   client knows of no chunks and asks for nothing.
2. The client asks for chunks within `MAP_CHUNK_REQUEST_RADIUS` of itself,
   **nearest first** and budgeted per pass, so a cold start draws the ground
   under the player's feet before the ground at the edge of the frame.
3. It asks again on each arrival — which is what actually paces a cold start,
   since the pipeline runs as fast as the link carries it and stops on its own
   when nothing is wanted — and on its own tick as a backstop. It cannot rely on
   deltas: a delta is suppressed when nothing in the world changed, so a player
   standing still would stop asking and sit on a half-loaded map.
4. A chunk is asked for once. Held and in-flight chunks are never re-requested;
   a `ChunkDenied(unknown)` is remembered as absent.
5. A `MapChunk` whose `mapId` is not the announced one is dropped rather than
   drawn — an edited map served to a session holding the old one.
