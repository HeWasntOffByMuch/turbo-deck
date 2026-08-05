# turbo-deck wire protocol v1

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
`str abilityId` · `f32 targetX` · `f32 targetY`

Asks to commit to an ability (spec 062). The server decides: cooldown, cost,
range, and whether something is already winding up. It answers with `CastState`
or `CastRejected`, and the client assumes nothing in between.

`targetX/Y` is a world point. A `direction`-targeted ability treats it as where
to aim; a `point`-targeted one as where to land, and refuses it past its range;
a `self` one ignores it.

### `0x09 CancelCast` — no payload
Withdraws from whatever is winding up. Legal only during the wind-up (and for
the duration of a channel); past the release tick the effect has happened and
there is nothing to call off. A cancelled cast refunds its cost and clears its
cooldown, so the only thing it spent is time.

### `0x03 Ping` — `u32 nonce`
### `0x04 Equip` — `str slot` · `str itemId`
### `0x05 Unequip` — `str slot`
### `0x06 SpendSkillPoint` — `str skillId`
### `0x07 Chat` — `str text` (truncated to 240 chars; refused while muted)

Equip, unequip and skill spends each trigger a full server-side stat
recalculation and are answered with a fresh `Stats` message, or with `Error`
(`RejectedAction`) and no state change.

## Server → client

### `0x40 Welcome`
`u16 protocolVersion` · `str playerId` · `varuint entityId` · `u32 tick` ·
`u8 tickRate` · `u16 chunkSize` · `u8 interestRadius` · `f32 correctionThreshold`

Chunk size and interest radius are announced rather than compiled into the
client, so retuning them needs no client release.

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

### `0x42 Correction`
`varuint inputSeq` · `f32 x` · `f32 y` · `f32 z` · `f32 facing` · `u8 reason`

Sent only when the client's prediction is wrong enough to matter. The client
should snap to this position and replay every input after `inputSeq`.

`reason`: `0` divergence past the threshold, `1` speed violation, `2` collision
or terrain, `3` admin teleport.

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
`f32 attackRange` · `u16 attackCooldownTicks` · `f32 armor` · `f32 spellPower` ·
`f32 critChance`

Every one of these is derived server-side from base stats, skill levels and
equipped item ids. None is ever persisted, and none is ever accepted from a
client.

### `0x45 Chat` — `u8 channel` · `str from` · `str text`
`channel`: `0` say, `1` system, `2` admin broadcast.

### `0x46 Pong` — `u32 nonce` · `u32 serverTick`
### `0x47 Error` — `u16 code` · `str message`
`code`: `1` bad protocol version, `2` malformed frame, `3` not authenticated,
`4` not authorized, `5` banned, `6` muted, `7` rejected action, `8` unknown message.

### `0x48 Disconnect` — `str reason`

### `0x49 CastState`
`varuint entityId` · `str abilityId` · `u8 phase` · `u32 releaseTick` ·
`u32 endTick` · `f32 targetX` · `f32 targetY`

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
3. If a `Correction` arrives, the client snaps its own entity to the given
   position and **replays** every buffered input after `inputSeq` through the
   same local movement code.
4. If no `Correction` arrives, the prediction was within
   `correctionThreshold` and the client keeps its own position untouched — no
   snap, no bandwidth. That silence is the point.

Other entities are not predicted; they are interpolated between deltas.
