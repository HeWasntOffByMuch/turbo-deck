# Delta broadcast cadence + client interpolation (trace, 2026-08-31)

Answers "how variable is the gap between deltas one client receives, and can
an unchanged entity cause a false jump" — see turns for full reasoning.

## Broadcast path (server)
- `server.ts:2852` — every 3rd sim tick (`BROADCAST_EVERY_N_TICKS = 3`,
  `config.ts:32`, 60Hz sim / 20Hz wire) calls `broadcastDeltas()`.
- `broadcastDeltas()` — `server.ts:3233-3277`. Per **connection**:
  - `visible` = `this.chunks.interestSet(connection.entityId)` resolved to
    entities (`server.ts:3239-3253`) — per-entity interest radius, so this is
    per-client, not global.
  - `connection.delta.build(tick, ackInputSeq, visible, nameOf)`
    (`server.ts:3254-3259`) — `connection.delta` is a `DeltaTracker`
    (`net/delta.ts`), one **instance per `Connection`** (`server.ts:248`,
    `interface Connection`), so its `known` map is this client's own
    last-told state, not a global snapshot.
  - `if (DeltaTracker.isEmpty(delta)) continue;` (`server.ts:3261`) — **no
    message is sent at all** to this connection when both `removed` and
    `upserts` are empty (`delta.ts:315-317`). Silence is real suppression,
    not an empty-but-sent frame.
  - Otherwise `this.send(connection, delta)` (`server.ts:3262`), then a
    follow-up `LootDrop` message for any freshly-spawned drop
    (`server.ts:3264-3275`).

## Field-level delta encoding (`src/server/net/delta.ts`)
- `DeltaTracker.build` (`delta.ts:171-312`) compares a fresh `snapshotOf`
  against `this.known.get(id)` **per field**, each with its own epsilon
  (`POSITION_EPSILON` 0.01, `FACING_EPSILON` 0.001, `HEALTH_EPSILON` 0.01,
  `POISE_EPSILON` 1/255) — `delta.ts:231-276`.
- `fields` is a bitmask (`EntityField`, `net/protocol.ts:455+`); if
  `fields === 0` the entity is **not added to `upserts`** at all
  (`delta.ts:278`) — true field/entity-level delta, not "always full state
  for everyone in range."
- First sight of an entity sends everything (`Spawn` bit) — `delta.ts:188-228`.
- `this.known` is only updated for an entity when it was actually included
  (`delta.ts:227`, `delta.ts:302`) — so the comparison baseline for "did this
  change" is always "since I last told THIS client," never "since the last
  broadcast tick," however many broadcasts were skipped in between.

## Client apply (`src/server/client/game-client.ts`, `client/replica.ts`)
- `case ServerMessageType.Delta` (`game-client.ts:2441-2462`) calls
  `this.world.apply(message.tick, message.removed, message.upserts)`
  (`game-client.ts:2448`). Only runs when a Delta message actually arrives —
  never on a synthetic/empty tick.
- `ReplicatedWorld.apply` (`client/replica.ts:94-172`): `this.lastTick = tick`
  is set unconditionally (`replica.ts:95`); the `entities` Map is a
  **persistent** store, mutated only for ids present in `removed`/`upserts`
  (`replica.ts:96-171`). An entity not in `upserts` keeps its old `x/y/z/...`
  untouched — the spread `...existing` pattern means an absent field is
  simply not overwritten (`replica.ts:126-170`).
- `ClientView.tick = this.world.tick` (single scalar, per connection —
  `game-client.ts:278-285` doc, `~1982-1994` assembly).
  `ClientView.entities = this.world.all()` (`replica.ts:84-86`) — the
  **whole** replica Map, not scoped to what the just-applied delta mentioned.
  So yes: an entity untouched by a delta still appears in `view.entities`,
  at its stale position, associated with the new (single, connection-wide)
  `view.tick`. Documented explicitly at `game-client.ts:279-285`: `tick`
  "stops entirely" when nothing changed, i.e. gap between consecutive
  non-suppressed deltas is **unbounded above**; floor is
  `BROADCAST_EVERY_N_TICKS` (3 ticks / 50ms), asserted for a continuously
  active client in `client/session.test.ts:344-368`.

## Does this cause a false interpolation jump? — no, by construction
- `scene.ts:1630` calls `this.observe(view)` on **every** `render()` frame
  (every rAF), not only when `view.tick` changes.
- `scene.observe()` (`scene.ts:1936-1946`) iterates **all** of
  `view.entities` (the full replica) and calls
  `this.motion.observe(entity.id, entity.x, entity.y, entity.z,
  entity.facing, view.tick)` unconditionally — including entities the
  latest delta never mentioned.
- `EntityMotion.observe` (`interpolate.ts:79-93`): if `tick ===
  track.latest.tick` it just overwrites `latest` in place (no-op for a
  frozen `view.tick`, since the values are identical) — that's what makes
  calling it every frame safe. Only when `tick` genuinely advances does it
  do `previous = latest; latest = next`.
- For an entity that was **not** in the delta's `upserts`, `next` (built
  from the still-untouched replica fields) is bit-for-bit the same as the
  `latest` it is replacing, so `previous.x === latest.x` etc. The
  interpolator reports it standing still — correctly, because it genuinely
  is (that's *why* it wasn't in `upserts`: `DeltaTracker` only omits a field
  when it hasn't moved past epsilon since this client was last told).
- So there is **no** false "stood still then teleported" artifact from an
  unmentioned entity. The premise in Q5 is mechanically true (stale
  position + new tick, yes) but it does not desync `previous`/`latest`
  because both are fed the same stale value.
- How that stream is played back changed in **spec 253**; everything above
  this line is about the server and is unaffected.

## Playback, since spec 253

`EntityMotion` (`src/render/iso3d/world/interpolate.ts`) no longer takes an
`alpha`. `FrameInfo.alpha`, `sinceDelta`, `lastDeltaTick` and `DELTA_MS` are
gone from `view.ts`.

- **A ring of samples per entity** (`OBSERVATION_DEPTH`, 6) rather than the
  newest two.
- **One playback head for the whole wire**, in fractional sim ticks, advanced
  once a frame by `EntityMotion.advance(dtMs)` from `WorldScene.render`
  (`scene.ts`, right after `observe(view)` and before anything samples).
- `sample(id)` interpolates over the **tick span** of the pair the head sits
  between, so a gap of nine ticks takes three times as long to play back as a
  gap of three. That is the fix for the artifact described below: a stall that
  delivers several deltas between two frames collapses into a single
  observation, and the old fixed 50ms ramp gave that whole jump one interval.
- The head is steered by the **low-passed** error toward
  `newestTick - PLAYBACK_DELAY_TICKS` (1.5 broadcast intervals), warped at most
  15%. The raw error is a staircase — that sawtooth is the shape of the
  broadcast, and a controller that chases it oscillates.
- It is only ever set **forward**; its lead over the newest sample is bounded;
  and it follows the wire back **down** if a restarted server counts from zero
  (which also clears the rings).

## The artifact this replaced

The old `alpha` was wall-clock time since `view.tick` last changed, divided by
a fixed nominal 50ms. Two things were wrong with it, and both are in spec 253
with measurements: the interval is not a constant, and the phase was reset by
a **packet arriving** rather than by a clock — a delta lands on a socket
callback, so the ramp carried the wire's jitter plus a frame of quantisation
and was restarted from a position it had not finished walking to. Measured on
an ordinary connection, one frame in ten drew a walking body standing still and
one in ten drew it at nearly twice its speed, with the mean perfectly correct
throughout, which is why nothing that measured a *position* ever caught it.
`interpolate-smoothness.test.ts` is that measurement, kept.
