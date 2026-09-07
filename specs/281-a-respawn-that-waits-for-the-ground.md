# 281 — A respawn that waits for the ground

## Problem

Pressing RESPAWN puts the player somewhere they have never been. The server
answers with a `Correction` carrying `CorrectionReason.Teleport`, spec 067 snaps
it, and the body is standing at `DEFAULT_SPAWN` on the same frame — several
hundred units and a whole request window away from every chunk this client
holds. The ground it is standing on has not been asked for yet.

So a respawn is a cut to an empty void with a player in it. `requestChunks` is
driven off the next delta, the server serves within one `MAP_CHUNK_BURST`, and
then 25 chunks insert, mesh and compose their prop regions **into frames that
are being drawn** — which is the exact fifteen-seconds-of-stutter failure spec
165 follow-up 7 widened `READY_CHUNK_RADIUS` to close, arriving through the one
door that spec left open.

Everything needed to know when the world is ready already exists and is already
being computed every frame:

| fact | where it lives today |
|---|---|
| ground declared vs. held around the player | `StreamedMap.coverage` |
| arrivals not yet meshed | `ChunkIngest.pending` |
| regions owed and in flight | `ingest.dirtyRegionCount`, `propsInFlight` |
| how far off the load is | `LoadGate.progress` |

What is missing is a caller. `LoadGate` **latches** — deliberately, and the
reason is stated in its own header: *"walking into unstreamed ground is an
ordinary streaming problem and covering the screen for it would be far worse
than the hole it hides. This is a loading screen, not a fog."*

That rule is right and does not move. **A respawn is not walking.** It is a
discrete jump, asked for by a button press, to a place chosen by the server, and
it is the one moment in this game where the client knows in advance that the
ground under the player is about to be wrong. So the answer is not to loosen the
boot gate's latch — which would make it a fog the first time somebody walked
briskly — but a second gate armed by the *press*, which is an event and can
never fire on its own.

## Shape

**Presentation only, and nothing crosses the wire.** No protocol version, no
server change, no new field: the respawn already sends nothing and is already
answered by a `Correction` and a delta. What this adds is a client that declines
to *show* the world until the ground has arrived.

### `src/render/iso3d/world/respawn-gate.ts` — pure, time is an argument

```ts
export type RespawnPhase = 'asking' | 'arriving';

export interface RespawnGateInput {
  readonly nowMs: number;
  /** Straight off `ClientView.selfDead`. */
  readonly dead: boolean;
  /** Ground the map declares within `READY_CHUNK_RADIUS` of where the body stands. */
  readonly needed: number;
  /** How many of those are held. */
  readonly held: number;
  /** Arrivals not yet drawn: mesh replies in flight plus prop regions owed. */
  readonly meshPending: number;
}

export interface RespawnCover {
  readonly phase: RespawnPhase;
  /** What the banner shouts. Constant across the return. */
  readonly label: string;
  /** One line under the bar saying what is being waited for. */
  readonly detail: string;
  /** 0..1, and never smaller than it was within one return. */
  readonly fraction: number;
  /** Whole seconds until the gate gives up and shows the world anyway. */
  readonly secondsLeft: number;
}

export class RespawnGate {
  ask(nowMs: number): void;
  /** Null when there is nothing to cover — the same shape `deathOverlay` returns. */
  read(input: RespawnGateInput): RespawnCover | null;
}
```

Two methods and no way to disarm it. A cover a caller could take down is a
cover with two answers to when the world comes back, and the one case that
looks like it wants an exit — the socket dropping mid-return — wants the cover
to *stay*: the body is still standing on ground that has not arrived, and the
reconnect banner is at `z-index:60` over everything anyway. What bounds every
one of those cases is the deadline, which is one rule that always fires rather
than a list of exits somebody has to keep complete.

`ask` is called from `hud.onRespawn`, beside `client.respawn()`. Nothing else
arms it: a gate that armed itself off *thin ground* would be the fog the boot
gate refuses to be, and a gate armed by a button cannot fire while nobody has
pressed one.

### The rules, in the order they are asked

1. **Not armed → null.** Idle costs one boolean read a frame.
2. **Dead → `asking`.** The request is out and the server has not answered.
   Coverage is not consulted, and must not be: while the body is still dead it
   is standing at the death site, whose ground is fully held, so a gate that
   read coverage first would lift on the frame before the teleport.
3. **Alive → `arriving`** while `held < needed` or `meshPending > 0`.
4. **Complete → disarm and return null.** Dying next to the spawn is a return
   with nothing to wait for, and it lifts on the first frame.
5. **`nowMs` past the deadline → disarm and return null.** The world is never
   permanently covered, whatever the stream does.
6. **Dead again after having been alive → disarm.** That is a second death, and
   what belongs on screen is the death banner, not a return that is not
   happening.

The lift in rule 3 rests on one ordering the server already guarantees:
`respawn()` sends the `Correction` synchronously inside the message handler and
the health rides the next 20Hz delta, over the same ordered channel — so the
teleport is *never* seen after the heal. Asserted in
`server/client/respawn-order.test.ts` rather than assumed, because it is the one
thing that would make the cover lift a frame early.

### `RESPAWN_COVER_TIMEOUT_MS` and the countdown

12 seconds, and it is a bail-out rather than a wait: on the shipped map the
whole request window is one `MAP_CHUNK_BURST` (25 chunks, served in a single
burst) and the return settles in well under a second. What the deadline covers
is the cases the stream cannot: a refused respawn, a lost chunk reply, ground
the map declares outside the serve radius.

The countdown is shown only in the last `COUNTDOWN_VISIBLE_MS`, and that is a
message rather than a threshold. A number counting down from twelve reads as
*you must wait twelve seconds to respawn* — a punishment nobody wrote — where
`SHOWING THE WORLD IN 3` appearing only when something has gone slowly reads as
what it is. Under it the detail line is the boot loader's own vocabulary:
`12 / 25 CHUNKS`, which the player has already read once on this screen.

### The cover itself

The death layer, which is already an `inset:0` element with `pointer-events`
over the whole frame, already sits above the world canvas and below the
interface canvas, and is already the thing on screen at the moment RESPAWN is
pressed. So a return is that layer with the button swapped for a bar — one
element, one z-index, and the transition from *YOU ARE DEAD* to *RESPAWNING*
happens in place.

Two things about it are not the death overlay's:

- **It is opaque.** Death is `rgba(20,2,4,.42)` so the player can see their own
  corpse, and 42% of an empty void is an empty void.
- **The words are the game's own 5x7 face** at a status scale rather than the
  banner's, and every string it can produce is drawn from the glyphs that face
  has — asserted, since a missing glyph draws as a solid block.

`hud.ts` keeps its stated division: this file owns the elements, and what the
cover *says* is decided in the pure module.

### What it also buys

`ingestChunks` picks its per-frame budgets off `gate.open` —
`ADOPT_BUDGET_LOADING` (64 against 8) and `PROP_REGIONS_LOADING` (8 against 1)
— on the stated grounds that *"nothing is on screen but a bar, and the load's
length is what the player is waiting on"*. That argument is true word for word
while the respawn cover is up, so both reads become `gate.open && cover === null`
and the wait pays the loading budget rather than the playing one.

## Invariants tested

`respawn-gate.test.ts`:

- Idle before `ask`, whatever the coverage says.
- `asking` while dead, **even when coverage is complete** — the death-site case,
  which is what would lift the cover a frame early.
- `arriving` while ground is short, and while `meshPending > 0` with the ground
  complete.
- Lifts on the frame everything is in, and stays lifted without a second `ask`.
- Lifts immediately when the return has nothing to wait for (died at the spawn).
- Lifts at the deadline with the ground still short, and stays lifted on the
  frame after it — a bail-out that re-covered would be worse than none.
- Lifts at the deadline on a respawn the server never answered, which is the
  half of the timeout the `asking` phase owns.
- `secondsLeft` counts whole seconds down and reaches 1 on the last frame.
- The countdown reaches `detail` only inside `COUNTDOWN_VISIBLE_MS`.
- `fraction` is monotone within a return and resets on the next `ask`.
- A second death while armed disarms rather than covering, and does not come
  back when the ground finally arrives.
- Every string the module can produce is drawable by `pixel-font`.

`server/client/respawn-order.test.ts`:

- Over a real loopback: the `Correction` carrying the teleport is received
  strictly before the delta that restores health.

`hud-layout.test.ts`:

- The widest label and the widest detail the gate can produce fit the compact
  frame at their scales, and the label is drawn under the death banner's own
  size — the one thing that scale was chosen against.

`scripts/probe-bottom-hud.ts` — the half no headless test can see, over spec
164's rig, driven through the **real** gate so a driver posting its own
`RespawnCover` cannot flatter the boxes:

- The layer stays up across the press, with the banner and the button gone.
- Its ground is **opaque**, read back off the browser's own computed style.
  That is the whole feature in one check: 42% of an empty void is an empty void.
- The label, the bar and the detail are on screen, inside the frame, in order.
- The bar fills as chunks land, and the detail counts them.
- The countdown appears near the deadline and not before it.
- The cover lifts, and what is under it is the death screen it was drawn over
  rather than a layer nobody can dismiss.

That rig could not show a death screen at all when this was written: `baseView`
has never carried `selfDead`, which spec 229 made the test `deathOverlay` reads,
so five of `probe-bottom-hud.ts`'s checks had been failing since. It derives it
the way `GameClient.deadNow` does now.

## Out of scope

- **Pre-warming the spawn.** The server serves only within
  `MAP_CHUNK_SERVE_RADIUS` of the entity, so asking for the spawn's ground
  before being moved there is refused — pre-warming means a serve rule that
  reads something other than where the body is, which is a change to the one
  guard that keeps a client from streaming the whole map.
- **Any other teleport.** An admin `setPosition` gets the same empty ground and
  the same fix would work; it is not armed here because nothing on this client
  observes a teleport as a teleport, and adding that observable is a change to
  `ClientView` for a developer tool.
- **Waiting for the nav grid.** It is ~5s on the remote path, it is on the
  worker, and `RoutePlanner` reads a null world as "walk straight at it" — which
  is the same fail-safe the flat predictor is. Covering the screen for it would
  make every respawn five seconds long to fix nothing the player can see.
- **Pausing the sim.** The frames keep running behind the cover, exactly as they
  do behind the boot gate and for its stated reason: the world that appears is a
  settled one rather than one that starts warming up at that moment.
