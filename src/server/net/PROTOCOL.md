# turbo-deck wire protocol v9

Binary, not JSON. Every frame is a WebSocket **binary** message whose first byte
is the message type; the rest is a type-specific payload. All multi-byte numbers
are **little-endian**.

Implemented by `protocol.ts` (type bytes), `codec.ts` (primitives),
`messages.ts` (game messages) and `admin-messages.ts` (the `admin:*` namespace).

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
`u16 protocolVersion` · `str playerId` · `str displayName` · `str token`

First message on a connection. A version mismatch is refused with `Error` and a
disconnect. `token` is empty for a plain player.

### `0x02 Input`
`varuint seq` · `f32 moveX` · `f32 moveY` · `f32 facing` · `u8 buttons` ·
`f32 predictedX` · `f32 predictedY`

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
(`RejectedAction`) and no state change.

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
`u32 worldSeed`

Chunk size and interest radius are announced rather than compiled into the
client, so retuning them needs no client release.

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

The bitmask *is* the delta: an entity that did not move contributes no position
bytes, and an entity that did not change at all is not in the frame. A frame
with no upserts and no removals is not sent.

`Spawn` is set the first time an entity enters this client's interest set, and
carries identity so a client never has to infer a field it was not told.

`kind`: `0` player, `1` monster, `2` prop, `3` projectile.
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

### `0x45 Chat` — `u8 channel` · `str from` · `str text`
`channel`: `0` say, `1` system, `2` admin broadcast.

### `0x46 Pong` — `u32 nonce` · `u32 serverTick`
### `0x47 Error` — `u16 code` · `str message`
`code`: `1` bad protocol version, `2` malformed frame, `3` not authenticated,
`4` not authorized, `5` banned, `6` muted, `7` rejected action, `8` unknown message.

### `0x48 Disconnect` — `str reason`

### `0x49 CastState`
`varuint entityId` · `str abilityId` · `u8 phase` · `u32 releaseTick` ·
`u32 endTick` · `f32 targetX` · `f32 targetY` · `varuint targetEntityId`

Someone committed to an ability. `phase`: `0` wind-up, `1` channel, `2` recovery.
`releaseTick` is when the effect lands, which is all a client needs to draw a
wind-up bar that finishes at the right moment. Sent to everyone whose interest
set contains the caster, so other players see a telegraph too.

### `0x4A CastEnded`
`varuint entityId` · `str abilityId` · `u8 reason`

`reason`: `0` released, `1` cancelled, `2` interrupted.

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
`varuint layerCount`, then per layer: `str id` · `u32 seed` · `rect bounds` ·
`varint baseY` · `bool hasWater` · `varint waterLevel` ·
`varuint coordCount` · (`varint cx` · `varint cz`) × coordCount

Sent unprompted straight after `Welcome`, because a client can ask for nothing
until it has it. The coord list is which chunks were actually baked, so a client
never asks for one that does not exist. The species list is advisory — for
building one instanced mesh per species up front — since each chunk carries its
own table.

A `rect` is four `varint`s: `minX` · `minZ` · `maxX` · `maxZ`.

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

## `admin:*` — client → server

Every one of these is refused unless the connection's stored token verifies **on
that message**, with a `role: admin` claim. Authentication is not a flag set once
at connect: the token is re-verified per request, so expiry takes effect
immediately. Every decision, accepted or refused, appends an audit entry.

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

Events currently understood by `triggerEvent`: `raid` (magnitude = how many),
`clear` (magnitude = radius), `heal`.

Live config keys: `spawnRateMultiplier`, `dropRateMultiplier`,
`maxEntitiesPerChunk`, `correctionThreshold`, `speedTolerance`,
`spawnIntervalTicks`. Values are clamped to per-key bounds; an unknown key or a
non-finite value is refused rather than silently ignored.

## `admin:*` — server → client

| Byte | Reply | Payload |
|---|---|---|
| `0xA0` | Ok | `u8 requestType` · `str message` |
| `0xA1` | Error | `u8 requestType` · `str message` |
| `0xA2` | PlayerList | `varuint count`, then per row: `str playerId` · `str displayName` · `varuint entityId` · `f32 x` · `f32 y` · `f32 z` · `str zone` · `str chunk` · `f32 health` · `f32 maxHealth` · `varuint level` · `f32 attackDamage` · `f32 moveSpeed` · `bool muted` |
| `0xA3` | Config | `varuint count`, then per entry: `str key` · `f64 value` |
| `0xA4` | Audit | `varuint count`, then per entry: `f64 at` (epoch ms) · `str actor` · `str action` · `str target` · `str detail` · `bool accepted` |

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
