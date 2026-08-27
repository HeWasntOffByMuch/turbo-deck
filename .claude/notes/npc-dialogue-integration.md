# Tracing for NPC interaction / camera reframe / dialogue (2026-08-27)

Scope: client-side Play tab only (`src/render/iso3d/world/`, `src/render/iso3d/`,
`src/ui/input/`, `src/render/audio/`), plus `src/server/client/GameClient` and
enough of `src/server/net`+`server.ts` to show the wire pattern. Not a sim trace.

**Load-bearing finding first**: there is no NPC entity in this game today.
`EntityKindValue` (`src/server/sim/types.ts:19`) is `Player/Monster/Prop/
Projectile/Mote/...` — no `Npc`. A "vendor" is a plain content row
(`src/server/data/vendors.ts`: `id,name,x,y,radius,stock,buyMarkup,
sellFraction`) with **no mesh, no rig, no entity, no click target** — the shop
opens via `nearestVendorTo(x,y)` (`world/shop-model.ts`, called from
`view.ts:2141-2143`) triggered by the `ui.shop` keybind/button, matched purely
by proximity against a hardcoded table. There is no world-click-on-an-NPC path
anywhere in the tree. Building "NPC interaction" is greenfield: decide whether
an NPC is (a) a client-only decorative rig at a fixed point + a click check
added beside `attackable`/`collectable` in `view.ts`, using `scene.pickUnitAt`
against a hover target you register yourself (see `hover.ts`), with dialogue
driven by content only (no server round trip needed) — or (b) a real
`ServerEntity` (new `EntityKind`), which buys replication/multiplayer-visible
health-bar-style presentation for free via the existing `Bar`/`screenAnchors`
machinery but is a sim change (out of this trace's scope, would want its own
spec per CLAUDE.md's spec-first workflow).

## 1. Input / control map / right-click order

- `src/ui/input/actions.ts`: `BindingContext = 'gameplay'|'ui'` (:51);
  `Chord {code, shift?, ctrl?, alt?, meta?}` (:65); `ActionDefinition
  {id, category, label, context, primary, secondary?}` (:73); `ACTIONS`
  read from `bindings.json` (:89); `skillbarIndex(actionId): number` (:112,
  `'skillbar.3'` -> 2, or -1); `POINTER_CODES` table (:141, `MouseLeft/
  MouseMiddle/MouseRight/Mouse4/Mouse5/WheelUp/WheelDown`); `pointerCode
  (button: number): string | null` (:166).
- `src/ui/input/input-map.ts`: `class InputMap` (:69) — `resolve(code,
  mods, context): readonly string[]` (:94, action ids a chord fires),
  `actionsForCode(code, context): readonly string[]` (:106, used on
  *release*, ignores modifiers so a stranded Shift can't strand the key),
  `bind`/`reset`/`isUnbound`/`isModified`/`toOverrides`/`applyOverrides`.
  `chordOf(code, mods): Chord` (:59).
- `src/render/iso3d/world/control-actions.ts` — pure, Play-tab-specific
  decision layer, no DOM/client/sim:
  - `ControlDecision` (:60): `{move, skillbar, cancel, stop, windows,
    toggleStats, chat, confirmAim, order, trade, zoom}`.
  - `decideControlDown(map: InputMap, code: string, mods: Modifiers):
    ControlDecision` (:189) — the one function every key/mouse/wheel press
    goes through; branches only on *action ids*, never on `code`.
  - `decideControlUp(map, code): readonly string[]` (:244) — release path.
  - Action-id constants: `CANCEL_ACTION='combat.cancel'` (:126),
    `STOP_ACTION='combat.stop'` (:142), `CHAT_ACTION='ui.chat'` (:154),
    `CONFIRM_AIM_ACTION='world.confirmAim'`, `ORDER_ACTION='world.order'`,
    `TRADE_ACTION='world.trade'` (:164-166), `ZOOM_IN_ACTION=
    'camera.zoomIn'`, `ZOOM_OUT_ACTION='camera.zoomOut'` (:167-168),
    `TOGGLE_STATS_ACTION='debug.toggleStats'` (:179).
  - `UI_WINDOWS` table (:43): action id -> `WindowId` (`inventory/
    character/shop/trade/options/account`); `ui.keybindings` also maps to
    `'options'` (its keys tab).
  - Default chords (`src/ui/input/bindings.json`): `world.confirmAim` =
    `MouseLeft` (:71-78), `world.order` = `MouseRight` (:79-87),
    `world.trade` = `Shift+MouseRight` (:88-97), `combat.stop` = `Space`
    (:61-69), `combat.cancel` = `Escape` (:52-60).
- `src/render/iso3d/world/view.ts` — DOM edge + decision application:
  - `const inputMap = new InputMap()` (:1822); loaded from storage (:1833).
  - `onKeyDown` (:2512): interface offered first (`ui.handleKey`, :2521,
    clears `held`/`heldKeys`/`disarmed` if consumed); else
    `applyDecision(decideControlDown(inputMap, event.code, modifiersOf
    (event)))` (:2547).
  - `onMouseDown` (:2751): `offerPress(...)` first; else stores `cursor`,
    resolves `pointerCode(event.button)`, `applyDecision(decideControlDown
    (inputMap, code, mouseModifiers(event)))` (:2764).
  - `onMouseUp`/`onKeyUp` (:2704, :2738): interface offered, then
    `decideControlUp` clears `held` unconditionally (stranded-key fix).
  - `applyDecision(decision: ControlDecision): boolean` (:2565) — the
    single applier for keyboard+mouse+wheel. Order: windows -> move (drops
    `destination`/`targetId`/`order` — taking keys is taking control,
    pending aim survives) -> toggleStats -> chat -> skillbar (via
    `abilityForSlot(actionBar, slot)` + `pressAbility`) -> cancel (Escape:
    reaches for the options menu only if *nothing* is committed --
    `pendingAim/order/targetId/client.view().selfRoot`) -> stop (spec 199,
    `stopEverything()`) -> confirmAim (`if (pendingAim) confirmAim(); else
    selectAtCursor()`, :2669-2672) -> trade (`offerTradeAtCursor()`) ->
    order (`if (pendingAim) pendingAim = null; else issueOrder()`, :2676-2683).
  - `issueOrder(): void` (:2775) — **the** right-click-becomes-an-order
    function (not in `target.ts`; that file is the pure per-tick chase/
    swing decision, `autoAttack()`). Refuses on `client.view().selfDead`
    (:2784); resolves `scene.pickUnitAt(cursor.x, cursor.y)` (:2791) then
    branches: `collectable(picked)` -> `pickupId = picked.id` (:2796-2802);
    `attackable(picked, selfEntityId)` -> `client.cancelCast()` (withdraws
    from a standing blow, guarded on `picked.id !== targetId`) + `targetId
    = picked.id` (:2803-2825); else empty ground -> `destination =
    scene.screenToWorld(...)`, `scene.playMoveOrder(...)`, `client.
    cancelCast()` (:2828-2845).
  - `attackable(entity: {id,kind,health}, selfId): boolean` (:2467) —
    deliberately thin/not-a-rule: `entity.id !== selfId && entity.health >
    0 && (kind === Monster || kind === Player)`. The server re-validates
    everything (hostility/range/pvp) on every swing. **This is the
    predicate a "talkable NPC" click would sit beside**, alongside...
  - `collectable(entity: {kind}): boolean` (:2482) — `kind ===
    EntityKind.Drop`.
  - `confirmAim()` (:2347), `selectAtCursor()` (:2385, mini-HUD selection —
    "a camera decision rather than a game one", nothing sent to the
    server), `pressAbility(abilityId)` (:2299), `dropCommitments()` (:2408),
    `dropOrders()` (:2428), `stopEverything()` (:2451, spec 199 — drops
    orders + `held.clear()` + disarms held keys so OS key-repeat can't
    resume a walk).
  - Cursor/hover: `onMove`/`onLeave` (:2729/:2735) track `cursor` in
    canvas-local CSS px, set to `null` while over UI (`ui.handlePointer
    ('move', ...)` returns true) or off-canvas. `applyCursor()` (:2925) —
    called from the frame *and* from every pointer/key event's end — reads
    `scene.hoveredEntityId`, builds `{aiming, overEnemy, overDrop}`, sets
    `canvas.style.cursor = worldCursor(pointer)` and `hud.setCrosshair
    (worldMark(pointer), cursor)` (:2942-2943).
- `src/render/iso3d/world/scene.ts` — the only impure geometry:
  `screenToWorld(cssX, cssY): Vec2` (:1200, raycasts `terrainMesh
  .pickTargets`, falls back to the y=0 plane); `pickUnitAt(cssX, cssY):
  number | null` (:1238, fresh per-click raycast, not the cached hover —
  handles a click landing in the same task as its `mousemove`); `get
  hoveredEntityId(): number | null` (:1234, this frame's `syncHover`
  result). `pickHoveredUnit` lives in `src/render/iso3d/hover.ts:81` —
  `(raycaster, targets: readonly HoverTarget[], groundCursor): number |
  null`, checks body meshes/volume first then footprint radius.
- `src/render/iso3d/world/target.ts` — pure, NOT the click router. Exports
  `autoAttack(input: AutoAttackInput): AutoAttack` (:132) — the **standing**
  attack order's per-tick chase/swing decision (`chaseTo`, `attack`,
  `drop`), consumed by `driveAutoAttack` in `view.ts:3116`. `STANDOFF_
  FRACTION=0.8`, `HOLD_FRACTION=0.9` (:113,128).

## 2. Camera

- Orthographic, "parked 6000 units back" is literal:
  `src/render/iso3d/view-settings.ts:41-45` `DEFAULT_CAMERA_ORBIT =
  {azimuth: 45deg, elevation: 27deg, distance: 6000}`; `DEFAULT_CAMERA_
  OFFSET = orbitToOffset(DEFAULT_CAMERA_ORBIT)` (:68). `CAMERA_ELEVATION_
  MIN_DEG=10, MAX_DEG=85` (:53-54, the Height slider's band). `CAMERA_NEAR
  =1, CAMERA_FAR=12000` (:64-65). `DEFAULT_VIEW_HALF_WIDTH=320`,
  `MIN_VIEW_HALF_WIDTH=200`, `MAX_VIEW_HALF_WIDTH=1400` (:96,103-104) — the
  **span**, not the distance, is what "zoom" means with an ortho camera.
  `orbitToOffset(orbit): Vec3` / `offsetToOrbit(vec3): Orbit` (:257,267) —
  pure round-trip helpers. `cameraFrustum(zoomHalfWidth, aspect): {halfWidth,
  halfHeight}` in `view-frame.ts:47` (`halfHeight = zoomHalfWidth /
  REFERENCE_ASPECT`, `halfWidth = halfHeight * aspect`).
- `src/render/iso3d/view-controls.ts` — `createViewControls(opts):
  ViewControls` (:436). All camera state is **DOM slider values read every
  frame**, no separate settings object: `cameraOffset(): Vec3` (:84),
  `viewHalfWidth(): number` (:86), `orbitBy(degrees): void` (:146, writes
  the Orbit slider: `camAz.setValue(wrapTurn(camAz.value()+degrees))`,
  body at :813), `orbitDegrees(): number` (:155, `camAz.value()`, body
  :814), `followLagMs()`, `attachWheelZoom(target)` (:97, non-passive wheel
  listener), `zoomNotch(direction, magnitude, deltaMode)` (:107, spec-189
  binding-driven zoom), `pinchZoom(ratio)` (:116), `restoreMaxZoom
  (ceiling)`/`chooseMaxZoom(ceiling)` (:125,135). Sliders built at
  `:448-451`: `camAz = makeSlider('Orbit', 0, 360, ...)`, `camEl =
  makeSlider('Height', CAMERA_ELEVATION_MIN_DEG, CAMERA_ELEVATION_MAX_DEG, ...)`.
  `cameraOffset()`'s actual body (:816) is `orbitToOffset({azimuth: camAz
  .value()*DEG, elevation: camEl.value()*DEG, distance: camOrbit.distance})`
  — **note the orbit distance itself is never re-derived from the sliders,
  only azimuth/elevation are live-editable; distance is fixed at 6000 for
  the whole session.**
- `src/render/iso3d/world/scene.ts` — `class WorldScene` (:447):
  - Fields: `private readonly camera: THREE.OrthographicCamera` (:477);
    `camOffsetCurrent = new THREE.Vector3(DEFAULT_CAMERA_OFFSET...)`
    (:639); `camOffsetTarget = new THREE.Vector3()` (:644); `target = new
    THREE.Vector3()` (:645, the look-at point == the followed player,
    smoothed); `halfWidth = DEFAULT_VIEW_HALF_WIDTH` (:647); `CAMERA_SMOOTH
    = 0.15` module constant (:165) — the one easing rate used for *both*
    offset-lerp and halfWidth-lerp.
  - `render(view: ClientView, frame: FrameInfo): void` (:1495) — call
    order relevant to camera, inside one frame:
    1. `const me = view.self ?? {x: target.x, z: target.z}` (:1533) — **the
       predicted self, always** — "the one body that must never lag its
       own input".
    2. `const groundY = this.ground(me.x, me.y)` (:1534).
    3. `this.followSelf(me, groundY, dt)` (:1542) — eases `this.target`
       toward `(me.x, groundY, me.y)` by `followAlpha(dt, followLagMs())`
       (snaps on first frame, :2927-2937).
    4. `this.applyControls()` (:1543) — reads `controls.cameraOffset()`
       into `camOffsetTarget`, lerps `camOffsetCurrent` toward it by
       `CAMERA_SMOOTH`, sets `camera.position = target + camOffsetCurrent`
       (:2939-2943); lerps `halfWidth` toward `controls.viewHalfWidth()`
       by `CAMERA_SMOOTH` and rebuilds the frustum via `cameraFrustum` when
       it moved >0.05 (:2945-2955).
    5. `this.applyPlayerLights(me, groundY)` (:1544).
    6. `this.camera.lookAt(this.target)` (:1545).
    7. `this.camera.updateMatrixWorld()` (:1547), hover/pick against the
       **unsnapped** camera (:1560, so picking never sees the pixel-snap).
    8. `this.applyPixelSnap(hike)` (:1576, `private applyPixelSnap
       (hike: HikeSettings): (() => void) | null` at :2904 — snaps
       `camera.position` onto the virtual-pixel lattice for the draw only
       and returns an unsnap closure, called after the frame is drawn
       further down `render()`).
  - **No existing hook for "look at something other than the followed
    player" or "temporarily widen the frame to include two points".**
    `me` in step 1 is hardcoded to `view.self`; `applyControls()`'s
    `halfWidth` target comes only from `controls.viewHalfWidth()`. Adding a
    reframe/two-point-zoom means new surface on `WorldScene`, e.g. an
    override consulted before step 1/2 (a `cameraOverride: {target: Vec2,
    halfWidth: number} | null` field with setter/clear methods, blended
    with the *same* `CAMERA_SMOOTH` lerp already driving both `target` and
    `halfWidth` so "smoothly" falls out of the existing mechanism rather
    than a new one) — or, if the reframe should coexist with the live
    `ViewControls` sliders rather than fight them, a second lerp target
    that `followSelf`/`applyControls` blend toward when set, restoring by
    clearing it (the existing lerp naturally eases back). A halfWidth that
    "includes two points" wants the *world-space* distance between them
    projected onto the frustum's `halfWidth`/`halfHeight` axes (accounting
    for `orbitDegrees()`'s azimuth) plus margin — `cameraFrustum` is the
    reference for the halfWidth/halfHeight relationship to invert.
  - Camera readout: `view.ts:3889` `` `${scene.controls.orbitDegrees()
    .toFixed(2)}|${scene.controls.viewHalfWidth().toFixed(2)}` `` written to
    `root.dataset['cameraOrbit']`/`root.dataset['cameraZoom']` (:3893-3894)
    only on change — this is what `probe-*.ts` scripts read on a phone
    where the settings panel isn't built (spec 140).
  - Orbit-by-keys (bracket keys, spec 129/140): `orbitStep(heldKeys,
    elapsed/1000)` in `view.ts:3616`, `scene.controls.orbitBy(swing)` if
    nonzero (:3617) — driven off `heldKeys` (raw codes), not the rebindable
    `held` (action ids) — reads as a known asymmetry versus the rest of the
    control system, not something this trace needed to resolve further.

## 3. `view.ts` frame loop

- `function frame(now: number): void` (:3535), looped via
  `raf = requestAnimationFrame(frame)` at the very end (:3926) and first
  armed near `:3991`/wherever `start()` calls it.
- Structure, in order:
  1. Compute `elapsed`, push to `frames` (fps meter), compute `tickMs =
     TICK_MS * (client.view().tickScale || 1)` (:3546), accumulate.
  2. **Fixed-step sim loop** `while (accumulator >= tickMs)` (:3556-3604):
     per iteration — `wire.deliver(wireTick)`, `server?.tick()` (only
     non-null for the in-tab/loopback server), forced-affliction/field
     debug triggers, `client.advanceTick()` (:3602), **`sendInput()`**
     (:3603) — this is where `moveIntent`/`driveAutoAttack`/`driveCastOrder`
     /`drivePickup` all run, once per simulated tick, not once per drawn
     frame.
  3. Camera orbit-by-keys (`orbitStep`, see \S2).
  4. `const view = client.view()` (:3619) — **the** `ClientView` obtained
     each frame (also re-obtained at :3646/:3679/etc. inside the same frame
     — it's cheap, a plain getter over already-updated fields, not a fresh
     computation).
  5. `ingestChunks(view, now)`, `updateLoading(view)`, `seedTheField(view)`.
  6. Interpolation alpha bookkeeping (`alpha` for body positions vs 20Hz
     deltas; `drawnTick` for anything with a duration — cast bars, cooldown
     sweeps — computed from `estimatedTick + accumulator fraction`).
  7. `scene.render(view, {dt, ticks, alpha, tick: drawnTick, selfFacing:
     facing, cursor, targetEntityId: targetId, aim: aimIndicator(view,
     view.self ?? {x:0,y:0})})` (:3649-3662) — **this is the one call that
     draws everything and moves the camera** (\S2).
  8. Audio: `audioDriver.listener(scene.listenerPose())` (:3675, *after*
     render, since the listener reads the camera that frame moved),
     `audioDriver.ambience()`, then per-entity `audioDriver.body({...},
     drawnTick)` (:3679-3739), `audioDriver.sweep()` (:3743).
  9. Perf readouts, HUD viewport sync (`hudBox` <- `scene.viewport()`,
     :3760-3769), xp-gain popup dispatch (:3778-3788), level-up/trade sound
     transitions (:3789-3818), action-bar sync (:3828-3838), `hud.update
     (...)` (:3845-3858), `applyCursor()` (:3859), window-button lit state
     (:3862), account button (:3866).
  10. FPS overlay, camera dataset readout (\S2), spawner-watch subscription
      toggle (:3901-3905), diagnostic-readout publishers (:3915-3918).
  11. **`ui.update(view, now, drawnTick)`** (:3923) — "Last, over
      everything... nothing under `src/ui/` may touch a clock". This is
      where the interface (windows, chat, action bar, mini-HUD) is drawn
      for the frame.
  12. `raf = requestAnimationFrame(frame)` (:3926).
- `sendInput(): void` (:3391): `withdrawIfMarkGone` -> dead-transition
  `dropOrders()` -> `driveCastOrder(view, me)` (:3411) -> `driveAutoAttack
  (view, me)` (:3412) -> `drivePickup(view, me)` (:3413) -> `moveIntent
  ({held, self, destination, route, facing, castAim: view.selfRoot,
  dropAim: view.dropAim, targetAim: aimedMark(view), staggered:
  view.selfStaggered, dead: deadNow})` (:3414-3448) -> `facing =
  turnToward(...)` -> `client.sendInput({moveX, moveY, facing, buttons:0})`
  (:3457). This is the **only** place `client.sendInput` is called.
- Pointer tracking: `cursor: {x,y} | null` is a closure variable in
  `mountWorld`, canvas-local CSS px, updated by `onMove`/`onLeave`/
  `onMouseDown` (see \S1) and consumed by `worldAim()` (:2285,
  `scene.screenToWorld(cursor.x, cursor.y)`), `applyCursor()` (\S1),
  `issueOrder()`, `confirmAim()`. `worldCursor`/`worldMark` are pure
  functions imported from `src/render/iso3d/world/crosshair.ts` (:166) —
  given `{aiming, overEnemy, overDrop}`, return which of the two drawn
  crosshair marks (or the browser's own arrow, `cursor: 'none'`) applies;
  actually drawn by `hud.setCrosshair(mark, at)` (`hud.ts:1992`), which
  positions a DOM layer at the pointer (`hud.ts:2013`,
  `crosshairLayer.style.transform = translate(...)`), **not** a CSS
  `cursor:` image (spec 200 found real hotspot drift doing that).

## 4. `GameClient` (`src/server/client/game-client.ts`, 2572 lines)

- `interface ClientView` (:277) — the read-only per-frame snapshot;
  `view(): ClientView` (:1897). Selected fields relevant here: `self`
  (predicted position, :319), `selfEntityId` (:327), `entities: readonly
  ReplicatedEntity[]` (:317), `drops` (:358), `casts` (:448), `selfRoot`
  (:468), `selfStaggered`/`selfDead` (:479/:494), `awaitingCast`/
  `awaitingPickup` (:509/:518), `cooldowns` (:524), `vendor`/`vendorRevision`
  (:395/:400), `trade`/`endedTrade` (:409/:420), `stats`/`inventory`/
  `equipment`/`coins`, `level`/`experience`/`skills`/`baseStats`/
  `attributes`, `tick`/`estimatedTick`/`roundTripTicks`/`tickScale`/
  `commitDelayTicks`, `worldSeed`/`map`, `spawners`, `restoration`.
- **Three send patterns**, exact examples:
  1. **Fire-and-forget, server-queued** — `cancelCast(): void` (:1449):
     `this.withdrawLocally()` (local prediction rollback) then
     `this.channel.send(encodeClientMessage({type: ClientMessageType
     .CancelCast, afterInputSeq: this.seq}))` (:1457-1459). No reply is
     awaited by the client; the server pushes the *result* separately via
     `CastEnded`/`Delta` on the normal replication path. Server side:
     `server.ts:1057-1064` — pushes onto `connection.pendingCancels`,
     drained inside the sim tick (not handled synchronously).
  2. **Predicted** — `useAbility(abilityId, targetX, targetY,
     targetEntityId, targetRadius): void` (:1342) — runs the same gate
     locally (`mayCast` against a mirrored entity, :1398-1400) to predict a
     root/cooldown/cast bar *before* the server answers, then sends
     `ClientMessageType.UseAbility` (:1437-1446). Server: `server.ts:1035-
     1046`, queued onto `connection.pendingCasts`.
  3. **Immediate request/response, no prediction** — the shop, and the
     closest existing template for "open dialogue with an NPC":
     - Client sends: `openVendor(vendorId: string): void` (game-client.ts
       :1241) — `if (vendorId === '') this.vendorView = null;` then
       `channel.send(encodeClientMessage({type: ClientMessageType
       .OpenVendor, vendorId}))` (:1244).
     - Wire: `ClientMessageType.OpenVendor = 0x0d` (protocol.ts:48);
       `OpenVendorMessage {type, vendorId}` (messages.ts:171-174), encode
       case (:536), decode case (:658-659).
     - Server handles **synchronously, not queued**: `server.ts:898-900`
       `case ClientMessageType.OpenVendor: ... this.sendVendorState
       (connection, message.vendorId);`. `private sendVendorState
       (connection, vendorId): void` (server.ts:2343-2363) — resolves
       `this.players.vendorFor(connection.playerId, vendorId)` (proximity
       check lives in `player-manager.ts:617-629` `vendorInReach`), then
       `this.send(connection, {type: ServerMessageType.VendorState,
       vendorId, name, stock, buyback})` — or an empty one if out of
       reach/no such vendor.
     - Wire back: `ServerMessageType.VendorState = 0x53` (protocol.ts:196);
       `VendorStateMessage` (messages.ts:972-975), encode (:1748), decode
       (:1941-1952).
     - Client receives: `game-client.ts:2166` `switch (message.type)` (the
       one incoming-message dispatch, fed by `channel.onMessage((bytes) =>
       this.receive(bytes))` at :917) -> `case ServerMessageType
       .VendorState:` (:2303-2314) — `this.vendorReplies += 1;
       this.vendorView = message.vendorId === '' ? null : {...}`.
     - Exposed: `view():1924` `vendor: this.vendorView, vendorRevision:
       this.vendorReplies`.
  - **To add a new request/response pair** (e.g. `openDialogue(npcId)` /
    `DialogueState`): add `OpenDialogue`/`DialogueState` entries to
    `ClientMessageType`/`ServerMessageType` (protocol.ts:17+/138+, next
    free byte in each range — see the `0x01-0x3F` client-game / `0x40-0x7F`
    server-game comment at protocol.ts:9-10), a message interface + encode
    + decode case in messages.ts (mirror `OpenVendorMessage`/
    `VendorStateMessage`'s four touch points each), a `case` in
    `server.ts`'s big switch (~:756-1086) calling a new private
    `sendDialogueState`-shaped method (mirror `sendVendorState`,
    server.ts:2343), a public method + a case in `game-client.ts`'s
    `receive` switch (mirror `openVendor`/`case VendorState`), and a new
    field on `ClientView` (mirror `vendor`/`vendorRevision`). Document the
    new bytes in `src/server/net/PROTOCOL.md`.
  - For a per-entity replicated field instead (e.g. "this monster/NPC is
    currently talking", broadcast to everyone nearby) the pattern is
    different — see `.claude/notes/monsters-npcs.md` \S7 for the exact
    `EntityField`/`EntityDelta`/`DeltaTracker` touch points; not repeated
    here since dialogue content itself is almost certainly request/response
    per-player rather than a delta field.

## 5. `ui-screens.ts` / `ui-layer.ts` mount, and input suppression

- `src/render/iso3d/world/ui-layer.ts` — `class UiLayer` (:125), the
  **impure** half: owns a second `<canvas>` (`position:absolute;z-index:40;
  pointer-events:none`, :170, appended to `host` at construction, :174),
  the UI scale (`measureFrame()`, :208), and the CSS-px -> UI-px conversion
  `private toUi(at: Point): Point` (:560) — `floor(at.x * dpr / this.frame
  .scale)`. Wraps `UiScreens` (`readonly screens: UiScreens`, :127) and
  forwards: `handlePointer(phase, at, button, mods): boolean` (:425, calls
  `this.screens.handlePointer(phase, this.toUi(at), button, mods)`),
  `handleKey(code, phase, mods, text?): boolean` (:433), `toggle(id)`
  (:420), `opened()` (:405), `moveFocus(step)` (:437), `update(view, nowMs,
  drawnTick)` (:296), plus action-bar/aim/select passthroughs.
- `src/render/iso3d/world/ui-screens.ts` — `class UiScreens` (:322), pure
  (no DOM/three.js, drives `mount-presentation.test.ts`'s twin-run
  determinism check). Constructed at `view.ts:1953` with an options object
  full of callbacks (`onMove`, `onBuy`, `onVendor: (vendorId) =>
  client.openVendor(vendorId)` at :2031, `onTradeOffer`, etc. — this is
  where a `onOpenDialogue`-shaped callback would be added).
  - `handlePointer(phase, pos, button, mods): boolean` (:1803) — order:
    (1) an in-progress keybinding capture owns every press (:1822); (2) on
    `down`, `this.focusOnPress(pos)` (:1827, gives the keyboard to whatever
    was hit *if* `hit?.focusOnPress`, else clears focus, :1879-1883) and
    closes the chat if the click landed off its field (:1833); (3) a press
    with something carried and a null hit-test (`this.layers.hitTest(pos)
    === null`) drops it on the world (:1842, `dropOnWorld`); (4) otherwise
    routes through `this.root.handle({kind:'pointer',...})` (:1843); (5)
    returns `!reachesGameplay(this.routingOf(consumed, 'pointer'))` (:1853)
    — **true means "gameplay must not act on this event"**.
  - `handleKey(code, phase, mods, text?): boolean` (:1908) — capture owns
    every key first (:1922); `Escape` runs `escapeTaken([cancelDrag, shop
    .dismiss, escapeChat, closeTopmost])` (:1926-1936, `ui-routing.ts:54`);
    chat recall on Up/Down while chat is open (:1943); else routes through
    `this.root.handle({kind:'key',...})` + `{kind:'text',...}` (:1948-1950);
    same `!reachesGameplay(...)` return (:1952).
  - `private routingOf(consumed, kind): Routing` (:1998) — `{consumed,
    blocked: !this.root.reachesGameplay(kind)}`.
  - `src/render/iso3d/world/ui-routing.ts` (59 lines, pure, standalone):
    `interface Routing {consumed, blocked}` (:21); `reachesGameplay
    (routing): boolean` (:34, `!consumed && !blocked`); `escapeTaken
    (steps: readonly (()=>boolean)[]): boolean` (:54, first truthy step
    wins) — the doc comment spells out *why* two booleans and not one:
    "a player clicks just beside a confirmation dialog... the character
    walks across the map while a question... is still on screen."
  - **The actual gameplay-suppression mechanism** lives one layer under
    `UiScreens`, in `src/ui/core/`:
    - `src/ui/core/events.ts:151-156` `CONTEXTS = {gameplay: {blocksBelow:
      false, swallowsKeys:false}, ui: {false,false}, modal: {true,true},
      textEntry: {true,true}}`. `class ContextStack` (:158) — a stack
      seeded with `gameplay` (:159); `push(id)`/`pop(id)` (:161/:166,
      `pop` removes the *topmost* matching entry, not necessarily the
      last pushed); `reachesGameplay(kind): boolean` (:188) — `top.id ===
      'gameplay'` -> true; for `key`/`text` events -> `!top.swallowsKeys`;
      otherwise -> `!top.blocksBelow`.
    - `src/ui/core/root.ts:64` `class UiRoot` — `reachesGameplay(kind)`
      (:183) delegates to `this.contexts.reachesGameplay(kind)`;
      `pushContext(id: InputContextId)`/`popContext(id)` (:187/:191).
    - `src/ui/core/widget.ts:98` `Widget.focusOnPress = false` — a plain
      field; only `TextField` sets it true, which is the entirety of
      spec 137's rule ("a press hands the keyboard only to something that
      types"). `UiScreens.focusOnPress(pos)` (:1879) is what reads it.
    - Textbox push/pop example: `ui-screens.ts:1600-1608`
      `chatFocus = {focus: (w) => root.focus.focus(w), push: (id) =>
      root.pushContext(id), pop: (id) => root.popContext(id)}` handed to
      the chat field; `TextField` calls `push('textEntry')` on focus and
      `pop('textEntry')` on blur (per `sound.ts`-style doc comments in
      `ui-screens.ts` around :1829-1832, :1920).
  - `stopEverything()`/`world.stop` (spec 199) is **not** in ui-screens.ts
    at all — it's `view.ts:2451` (see \S1), reached via
    `ControlDecision.stop` from `control-actions.ts`. It is unconditional
    and does not go through the UI-blocking machinery above (it fires only
    when the interface did *not* already consume the key, same as any
    other gameplay action).

## 6. World-space-anchored UI (existing precedent for a dialogue bubble)

- `src/render/iso3d/world/scene.ts`:
  - `export interface ScreenAnchor {id, x, y, onScreen}` (:438) — CSS
    pixels within the canvas box.
  - `private collectAnchors(): void` (:3104) — rebuilt every frame from
    `this.bodies` (every drawn rig, keyed by entity id): projects
    `body.group.position + headroom` through `this.camera`, converts NDC
    to CSS px against `canvas.clientWidth/clientHeight`, marks `onScreen`
    with an **80px margin** (off-canvas rendering still counts as
    "on-screen enough" so a bar doesn't pop at the exact edge).
  - `screenAnchors(): readonly ScreenAnchor[]` (:1246) — the public read of
    the above, consumed once per frame by `hud.update(...)`.
  - `projectPoint(x: number, y: number, lift = 30): {x, y, onScreen}`
    (:1297) — the general-purpose version for a **static world point**
    (not tied to a live body/entity): samples `this.ground(x,y) + lift`,
    projects, converts to CSS px the same way. This is the function bound
    into `Projector` and handed to `createHud`.
  - `bodyAnchor(id): WorldAnchor | null` (:1263) — a body's *drawn*
    ground position + headroom, read once (e.g. at the instant a blow
    lands) rather than re-resolved by id every frame — survives the body
    despawning the same frame (a killing blow).
- `src/render/iso3d/world/damage-popup.ts` — pure, no DOM/three.js:
  - `interface WorldAnchor {x, y, lift}` (:30) — a world point + height
    above ground.
  - `type Projector = (x, y, lift) => {x, y, onScreen}` (:41) — "
    `WorldScene.projectPoint` is the one implementation; a test passes its
    own camera."
  - `class DamagePopups` (:167) — `add(group: number, at: WorldAnchor,
    trail?: 'damage'|'xp'): {id, expired}` (:187) spawns a fixed-lifetime
    number at a world point (never re-resolved from an entity); `step
    (project: Projector): PopupStep` (:244) re-projects every live one
    each frame and reports newly-expired ids. Good precedent for *transient*
    world-anchored text but **not** for persistent dialogue (fixed
    `NUMBER_LIFE`/`XP_LIFE`, no "stays until dismissed" mode).
- `src/render/iso3d/world/hud.ts` (2095 lines) — `createHud(project:
  Projector): HudHandle` (:525), constructed at `view.ts:1476` as
  `createHud((x, y, lift) => scene.projectPoint(x, y, lift))`.
  - **Two anchoring patterns already live in this file, both directly
    reusable for a dialogue bubble**:
    1. **Per-entity persistent holder, keyed by id, positioned from
       `screenAnchors()`** — `interface Bar` (:189: `root, name, health,
       ghost, guard, guardFill, cast, castFill, swap, swapFill, stun,
       statusRow, statusSlots`); `const bars = new Map<number, Bar>()`
       (:1206); `function barFor(id: number): Bar` (:1216) — builds once,
       memoized, `holder.style.cssText = 'position:absolute;transform:
       translate(-50%,-100%);width:52px;'` (:1221, anchored by its
       *bottom-centre* so growing content pushes upward without moving the
       health bar), `holder.dataset['entity'] = String(id)` (:1225, what a
       probe/preview script finds a body by, without re-deriving the
       camera projection). Positioned every frame inside `update(...)`
       (:1476) by iterating `for (const anchor of anchors)` (:1491, the
       `screenAnchors()` array passed in) and writing `element.root.style
       .left = anchor.x + shakeX; .top = anchor.y + shakeY` (:1601-1602).
       Visibility/liveness: a `live: Set<number>` is built each pass
       (:1489, `.add(anchor.id)` at :1499 only when `wantsBar &&
       anchor.onScreen`); after the loop, `for (const [id, element] of
       bars) { if (live.has(id)) continue; ...; bars.delete(id); }`
       (:1634-1637, full body at ~:1634-1645) removes/hides holders for
       ids that stopped qualifying **this frame** — the exact lifecycle a
       dialogue bubble tied to "NPC is in view and currently talking"
       would want. Sub-elements toggle via `style.display` (structural,
       affects the bottom-anchor math) or `style.visibility` (cosmetic,
       stays in flow) depending on whether they may resize the holder —
       see the long comment at hud.ts:1263-1276 on why the guard bar uses
       `visibility` and the cast bar is pulled `position:absolute` out of
       flow instead.
    2. **Single persistent element, positioned from `projectPoint`
       directly (not tied to `screenAnchors`'s body list)** —
       `showDropLabel(view, byId, hoveredId)` (:1442) is the closest
       template for a one-off floating label: `const at = project
       (entity.x, entity.y, DROP_LABEL_LIFT)` (:1455); `if (!at.onScreen)
       { dropLabel.style.display = 'none'; return; }` (:1456-1459); else
       `dropLabel.style.left/top = at.x/at.y` px, set `textContent`/
       `color`. `dropLabel` itself is created once at hud.ts:601-602 as a
       plain absolutely-positioned div. This pattern is simpler than the
       `Bar` holder and is the right shape for a single dialogue bubble
       that doesn't need the health-bar sub-widget stack.
  - `addDamage(entityId, at: WorldAnchor, damage, crit): void` (:381) /
    `addExperience(group, at: WorldAnchor, amount): void` (:395) — the
    event-driven (not per-frame) spawn API into `DamagePopups`, for
    reference on the "spawn once, let per-frame `update()` place it"
    shape.
  - HUD element mounting order in `view.ts`: three.js `canvas` appended
    first (:357/:929... `root.append(canvas)` at :357), `UiLayer`
    constructed at :1953 (appends its own canvas to `root` inside its
    constructor, ui-layer.ts:174, `z-index:40`), then `root.append(hud
    .element)` (:1575) for the DOM HUD div (`position:absolute;inset:0;
    pointer-events:none;overflow:hidden` per the class doc comment), then
    `container.append(root)` (:3929). A dialogue bubble built as a plain
    DOM div (the `showDropLabel` pattern) would live inside `hud.element`'s
    tree, same as every other HUD widget.

## 7. Audio (`src/render/audio/`, `src/ui/core/sound.ts`)

- `src/render/audio/sink.ts` — the **closed** interface everything above
  the engine talks to, pure (no Web Audio types leak upward except as
  parameter shapes): `interface Audio` (:97) — `play(id: SoundEventId,
  options?: PlayOptions)`, `hold(id, options?): AudioHandle`, `move
  (handle, options)`, `isLive(handle): boolean`, `stop(handle)`,
  `setListener(pose: ListenerPose)`, `setMix(mix)`, `setCatalog(catalog)`,
  `warm(buses)`, `has(id): boolean`, `resume()`, `suspend()`, `stats():
  AudioStats`, `stopAll()`, `preview(url, gain?, rate?)` (SFX-tab-only
  direct file playback, bypasses the catalog). `SILENT_AUDIO: Audio`
  (:150) — every method a no-op; what `npm test` runs against, and what a
  browser with no Web Audio gets.
  - `interface ListenerPose {x,y,z, forward: Vec3, up: Vec3}` (:31) — world
    space, **not** the camera position (documented reason: this ortho
    camera parks 6000 units back, a camera-mounted listener would give
    every source identical distance/direction). `orientation` is the
    camera bearing flattened onto the ground plane.
  - `interface PlayOptions {x?, y?, z?, gain?, rate?}` (:49) — `y` is
    height (three.js convention), sim `Vec2{x,y}` must be remapped to
    `{x, z}` or every sound mirrors across the diagonal.
- `src/render/audio/engine.ts` (652 lines) — `class AudioEngine implements
  Audio` (:118). `private context: AudioContext | null = null` (:119),
  `private buses: Record<BusId, GainNode> | null = null` (:120) — **both
  genuinely private, no accessor anywhere in the file or interface.**
  - `resume(): void` (:175) — the *only* place a context is created:
    `if (this.context === null) { created = this.makeContext(); ...
    this.context = created; this.buses = buildBuses(created, this.mix); }`
    (:176-191, wrapped in try/catch — "No Web Audio, or the browser
    refused" falls through silently forever, :180-184); then `if (this
    .context.state === 'suspended') void this.context.resume()` (:194).
    Must be called from a user gesture; called on *every* input in
    `view.ts` via `armAudio()` (:3531) and `onVisible()` (:3512), not just
    once, because a browser can suspend a running context on its own.
  - `buildBuses(context, mix): Record<BusId, GainNode>` (:610) — one
    `GainNode` per bus, `node.connect(context.destination)` (:615). This
    is the graph a procedural synth would want to tap into (`buses[someId]`
    instead of `context.destination` directly, so it respects the mix
    sliders) — **but `buses` is private and there is no method to fetch a
    bus node or the raw context.**
  - `createAudioEngine(options: Partial<AudioEngineOptions> = {}): Audio`
    (:641) — factory; returns `SILENT_AUDIO` if no `AudioContext`
    constructor exists globally (:643); otherwise `new AudioEngine({...
    options, context: factory})`. **Return type is the `Audio` interface,
    not `AudioEngine`** — so even importing this module gives no path to
    the concrete class's private fields from outside the file.
  - **Finding: procedural synthesis has no supported entry point today.**
    The whole design of spec 229 (per CLAUDE.md and this file's own header,
    ":2" "The one module in this repo that owns an `AudioContext`") is
    built around a closed, file-backed catalog (`SoundEventId` from
    `events.ts`, resolved to recorded `.ogg` variants by `catalog.ts`) so
    that `npm test` can run the whole layer against `SILENT_AUDIO` in Node
    with no Web Audio at all. Getting a raw `AudioContext` or a bus
    `GainNode` out for a synthesized dialogue "blip" sound means adding new
    surface: either (a) a new method on the `Audio` interface (e.g.
    `rawContext(): AudioContext | null` / `busNode(id): AudioNode | null`),
    implemented as a no-op returning `null` in `SILENT_AUDIO` so every
    existing call site and the Node test suite stay intact, or (b) a
    second, separate small module that constructs its own `AudioContext`
    the same lazy/gesture-gated way `resume()` does (duplicating that
    logic) rather than sharing the engine's. (a) keeps one context/one set
    of bus gains for the whole game; (b) is more contained but forks the
    "must be created from a user gesture" bookkeeping. Either way this is
    a design decision for you/the architect agent, not something already
    wired.
  - `src/render/iso3d/world/audio-driver.ts` — `class AudioDriver`, pure
    (constructed with an `Audio`), constructed at `view.ts:1856` as `new
    AudioDriver(audioEngine)`. Exposes the higher-level per-frame calls
    seen in the frame loop (\S3): `listener(pose)`, `ambience()`,
    `body({entityId,x,z,ground,activity,...}, tick)`, `sweep()`, plus a
    one-shot `flat(id: SoundEventId)` used throughout `view.ts` for UI/
    event stingers (e.g. `audioDriver.flat('player.pickUp')` at :3358,
    `audioDriver.flat('ui.tradeRequest')` at :3808) — this is the thing to
    call for "a dialogue line started" or "no more lines" stingers, not
    the raw engine.
- `src/ui/core/sound.ts` (95 lines, pure, no Web Audio) — the **separate,
  narrower** vocabulary for `src/ui/` widgets (which may not import
  anything render-side): `type UiSoundId = 'ui.press'|'ui.open'|'ui.close'|
  'ui.error'|'ui.drop'|'ui.pickUp'|'ui.coin'|'ui.equip'` (:28-50, a closed
  union — "an eighth should have to argue for itself"). `interface
  SoundSink {play(id: UiSoundId): void}` (:63). `SILENT: SoundSink` (:74,
  the default everywhere so a widget never needs `?.`). `class
  RecordingSink implements SoundSink` (:81) — test-only, records what was
  asked for.
  - Wiring: `Widget.sounds` is set on **one** node, `UiRoot`'s content
    (per CLAUDE.md); every descendant finds it by walking `parent`.
    `view.ts:1914` `const uiSounds = {play: (id: UiSoundId): void => {
    audioEngine.play(id); }}` — passed into `new UiLayer(root, {sounds:
    uiSounds, ...})` (:1958). **`UiSoundId` string values (`'ui.press'`
    etc.) are literally a subset of `SoundEventId`** — confirmed in
    `src/render/audio/events.ts:597-600`, rows `ui.press`/`ui.open`/
    `ui.close`/`ui.error` exist verbatim in the 57-row `SOUND_EVENTS` table
    (`bus: 'ui'`) — so `uiSounds.play` passing a `UiSoundId` straight into
    `audioEngine.play(id: SoundEventId)` type-checks by construction rather
    than by coincidence: the two vocabularies are deliberately kept in
    lockstep by sharing string literals, not by a translation table.

## Invariants worth not breaking

- No `if` in `src/render/` may change a game outcome (CLAUDE.md's own
  rule) — `attackable`/`collectable`/`selectAtCursor` in `view.ts` are all
  presentation-side "what would this click *mean*" guesses; the server
  re-validates hostility/range/reach/proximity independently on every
  request (`vendorInReach`, `startCast`, etc.). A dialogue-open predicate
  should follow the same shape: a thin client guess for cursor/UI
  purposes, with the server (or a pure content lookup, if dialogue text is
  not secret/gated) as the actual authority if it matters who can see it.
- `src/ui/` may not import `server/sim`, `world`, `player` or `state`
  (lint-enforced) — any dialogue *screen* built as a `src/ui/screens/*`
  widget must receive dialogue content as plain data through a view-model
  (mirroring `inventory-model.ts`/`shop-model.ts`), never reach into
  `GameClient` internals directly.
- `src/render/` (and the render-adjacent pure subtrees) still may not
  import `Date`/`performance`/DOM globals inside the deterministic core,
  but note that `view.ts`/`scene.ts`/`hud.ts`/`ui-layer.ts` are **not**
  part of that core (they're the impure render layer) and already use
  `performance.now()` freely — a dialogue typewriter-effect timer belongs
  here, timed off the frame's own `now`/`dt`, not a new ambient clock.
- The sim's fixed 60Hz tick and the wire's 20Hz broadcast are independent
  of anything drawn; nothing about dialogue *presentation* (typewriter
  speed, bubble fade) needs to be tick-quantized the way combat state does
  — but if dialogue *availability* (e.g. "NPC has more to say") is
  server-driven, model it as a request/response (\S4 pattern 3) or a
  replicated field, not as client-only state, for the same reason vendor
  stock isn't trusted client-side.
- `stopEverything()`/Escape do not currently know about dialogue; if a
  dialogue window should be dismissed by Escape, it needs a step added to
  `escapeTaken([...])` in `ui-screens.ts:1926-1936`, ahead of
  `closeTopmost()` in priority if it should behave like the chat
  (dismissed before a window behind it), and `combat.stop`/`world.stop`
  would want to close it too if a fight can interrupt a conversation.

## Open questions

- Whether a dialogue NPC should be a real sim entity (multiplayer-visible,
  pickable via the existing `pickUnitAt`/`Bar`/`screenAnchors` machinery,
  but a sim change requiring a spec per CLAUDE.md) or a client-side-only
  decoration (faster to build, reuses `showDropLabel`'s single-element
  anchoring, but invisible to other players and to `attackable`-style
  click routing unless you add a parallel hit-test) is not decided
  anywhere in the codebase today — see the "load-bearing finding" at the
  top.
- Whether "camera reframe to include two points" should coexist with the
  live `ViewControls` orbit/zoom sliders (so a player can still nudge the
  view during a conversation) or should suspend them entirely: `scene.ts`
  has no precedent for suspending `applyControls()`'s slider-reads, only
  for adding a value that competes with them in the same lerp.
- Whether dialogue needs any protocol change at all: if the text is fixed
  content keyed by an id the client already knows (map marker id, NPC
  def id), a client-only content lookup with **no** new message pair may
  be sufficient, and only a "this player is now in a conversation" state
  (if it should block movement/combat, mirroring `selfRoot`/`dropAim`)
  would need the wire.
