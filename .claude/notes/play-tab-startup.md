# Play tab startup/lifecycle, and where a title screen would go

Traced for: adding a title screen (Start/Options) before the world, plus a
dismissable controls overlay, gated to the "game" build (spec 252).

## 1. `mountWorld` sequence — `src/render/iso3d/world/view.ts`

- `export async function mountWorld(container): Promise<ViewHandle>` — line 350.
- `await loadShippedMap()` — line 364. The **only** top-level await before the
  synchronous remote-plan branch; comment: "Awaited here and nowhere deeper:
  everything below is synchronous from `buildWorldFromMap` through
  `warmRouting`, `fillGround` and the transport."
- `planConnection(...)` — line 395: decides loopback vs remote from
  `location.search` / `VITE_SERVER_URL`.
- Remote only: `await ensureAuthToken(...)` — line 439, a `POST
  /api/auth/guest` (or resumes a stored token). **Runs during mount**, before
  any button is pressed — a guest character is minted just by mounting.
- Loopback only: `buildWorldFromMap(...)` — line 543 (sync), `GameServer`
  constructed — line 592 — but wired by hand (`transport.onConnection`), not
  `server.start()`: no wall-clock loop, it only ticks when the render loop
  calls `server.tick()` inside `frame()`.
- Remote only, **line ~583**: `reconnecting = new ReconnectingChannel({ open:
  () => connectChannel(plan.url, {...}), onReopen: ... })`. `ReconnectingChannel`'s
  constructor (`src/server/net/reconnecting.ts:63-64`) calls `this.inner =
  this.openInner()` **immediately**, which calls `options.open()` →
  `connectChannel` → `new BrowserSocketChannel(url)` →
  `new WebSocket(target)` (`src/server/net/transport-browser.ts:63-64`).
  **The real WebSocket opens here, synchronously, during mount — well before
  `start()` is ever called.**
- `GameClient` constructed — line 647. Does **not** send `Hello` itself;
  `Hello` is sent only by `client.connect()`.
- `WorldScene`, `ChunkIngest`, `mapWorker` — lines 702-748.
- `LoadGate` + `createLoadingOverlay(root)` — lines 769-770 (see §2).
- `hud = createHud(...)` — line 1514; `root.append(hud.element)` — line 1618.
- `ui = new UiLayer(root, {...})` — line 2029 (builds `UiScreens`, including
  the **options window** — see §5. Fully synchronous, no network.)
- `container.append(root)` — line 4117.
- Returns `{ element: root, start(), stop() }` — lines 4119-4229.

### `start()` / `stop()` — lines 4121-4227

`start()` is where almost everything actually begins:
- DOM listeners attached (pointer/key/wheel/blur/visibility/contextmenu).
- `if (plan.mode === 'remote')`: registers `client.onWelcome(...)`, arms
  `keepAlive = window.setInterval(() => pump(...), KEEPALIVE_MS)` (500ms,
  `keepalive.ts:43`), then `void client.connect()` — **this is where `Hello`
  is actually sent** (line 4169-4174).
- Else (loopback): `void client.connect()` directly.
- `raf = requestAnimationFrame(frame)` — line 4179. **The render loop
  (`frame()`, defined at line 3716) does not run at all until `start()` is
  called.** Nothing ticks the sim, nothing draws, nothing calls `ui.update()`.

`stop()` cancels the raf, stops audio/dialogue, clears `keepAlive`, removes
every listener added in `start()`. It is what the tab shell (`main.ts`) calls
when a tab is hidden — a `ViewHandle` is designed to be started/stopped
repeatedly without being remounted.

**`main.ts`** (`activate()`, lines 129-178) mounts a tab lazily on first
press (`tabs.map(() => null)`), then `show()` (line 180) calls `handle.start()`
immediately once the mount promise resolves. For the production build there
is exactly one tab (Play) and `activate(0)` runs unconditionally at the end
of `main()` (line 213) — so today the world mounts *and* starts the instant
the page loads, with no gap to put a title screen in.

## 2. The loading gate

- `src/render/iso3d/world/loading.ts` — `LoadGate` (pure, class at line 75).
  Phases: `connecting → locating → streaming → meshing → ready`, latches once
  `ready` and never regresses (`fraction` is `Math.max`-clamped). `progress()`
  is fed `haveMap`, `located` (self position known), `held`/`needed` chunk
  counts, `meshPending` — computed each frame in `updateLoading()` (view.ts
  line 1156-1268), called from `frame()` at line 3808.
- `src/render/iso3d/world/loading-overlay.ts` — `createLoadingOverlay(root)`
  (line 27) is the **DOM overlay pattern**: `position:absolute;inset:0`,
  `z-index:50`, opaque `#0b0b12` background, a label + a thin progress bar,
  fades over `FADE_MS=260` and then **removes itself from the DOM** (not just
  hidden) once `phase==='ready'`, "or a finished loading screen silently
  swallows the first click" (comment, loading-overlay.ts:92-95).
- While the gate is closed, `canvas.style.visibility = 'hidden'` (view.ts:1267)
  — the world still renders every frame underneath (so it's "settled" when
  revealed), only the canvas pixels are hidden.
- **Z-index stack, established across the mount** (all appended into the
  same `root`):
  - connection banner (`connection-banner.ts:52`) — `z-index:60` (highest;
    must be visible through a "Connecting" hang).
  - loading overlay (`loading-overlay.ts:50`) — `z-index:50`.
  - `ui` canvas / `UiLayer.element` (`ui-layer.ts:174`) — `z-index:40`,
    `pointer-events:none` (browser never hit-tests it; events are offered
    programmatically — see §4).
  - death overlay (inside `hud.element`, DOM, no z-index of its own but
    `z-index:5` *among hud's own children*) — `hud.ts:992-1018`,
    `pointer-events:auto`, `background:rgba(20,2,4,.42)`.
  - world canvas — plain, no z-index (bottom of the stack).

## 3. Where a title screen sits

**Today the connection begins at mount, not at start.** For the remote
("game"/production) plan, the raw WebSocket opens synchronously inside
`ReconnectingChannel`'s constructor during `mountWorld()` (view.ts ~583); only
the `Hello` handshake (`client.connect()`) and the render loop
(`requestAnimationFrame(frame)`) are deferred to `start()`. For loopback
(single-player, no `?server=`), nothing ticks until `start()` — `GameServer`
sits idle.

**Two viable seams**, in order of how much they change:

- **(a) Defer the whole `mountWorld()` call** until "Start" is pressed (title
  screen replaces `main.ts`'s unconditional `activate(0)` for the game
  build). Zero risk: no fetch, no auth POST, no socket, nothing until intent.
  Cost: pressing Start pays the full mount latency, but the existing loading
  gate/overlay already covers exactly that experience gracefully. Downside:
  the title screen cannot reach the *same* `options` window instance (it
  doesn't exist yet) — see §5.
- **(b) Mount eagerly, defer only `start()`.** Builds `UiScreens`/options
  window immediately (so Options can open it), but opens the remote socket
  early and idle. Checked whether this can time out:
  - Server sweep `sweepConnections()` (`src/server/server.ts:1591-1602`)
    only closes connections with `connection.playerId !== null`
    (line 1597) — a connection only gets a `playerId` once its `Hello` is
    processed. **An idle pre-`Hello` socket is exempt from the game server's
    own `CONNECTION_TIMEOUT_TICKS` (600 ticks / 10s) sweep entirely.**
  - The server also pings every socket every `SERVER_PING_MS` (3000ms,
    `src/server/net/transport-ws.ts:111-116`); the browser's network stack
    answers the pong automatically with no page JS running
    (`transport-ws.ts:42-53`), so even where a proxy cares about idle
    frames, this keeps the TCP connection warm.
  - `ReconnectingChannel`'s own backoff clock (`retryAtTick`) only advances
    via `deliver(tick)`, which is only called from `pump()`
    (view.ts:3623-3629), which is only driven once `start()` arms
    `keepAlive` / calls `pump` on `visibilitychange`. So if the idle socket
    *does* get closed by something outside this repo (a reverse proxy's own
    idle timeout — not checked here, deployment-specific), the reconnect
    ladder is frozen until `start()` runs; the first `pump()` after Start
    will pick it up promptly (banner already shows the phase change live,
    since `onPhase` fires straight from `BrowserSocketChannel`/
    `ReconnectingChannel`, independent of `start()`).
  - Side effect either way under (b): the guest-auth POST
    (`ensureAuthToken`, view.ts:439) fires at mount too, so a visit to the
    title screen alone creates a guest character server-side even if Start
    is never pressed.

Recommendation written up for the caller: (a) is simplest and safest: build
the title screen as a small standalone `ViewHandle`-shaped mount with no
network calls, shown first for the game build; call the *real* `mountWorld`
only on Start, and let the existing loading overlay carry the wait. If the
title screen's Options must reuse the exact live `OptionsScreen`/window
instance rather than a second copy, (b) is required instead — the socket-idle
risk is judged low but is not proven against a real deployment's proxy.

## 4. Input routing

- `src/render/iso3d/world/ui-routing.ts` — pure, no DOM. `Routing =
  { consumed, blocked }`; `reachesGameplay(routing)` = `!consumed && !blocked`
  (lines 21-37). `escapeTaken(steps)` runs a list of thunks in order and stops
  at the first that reports it acted (lines 54-59) — this is how Escape's
  priority list (drag → dialog → topmost window → gameplay cancel) is
  expressed.
- DOM → `view.ts`: every raw listener offers the event to `ui` **first** and
  only does gameplay work if it returns `false`/wasn't consumed:
  - `onKeyDown` (view.ts:2614): `if (ui.handleKey(...)) { held.clear(); ...;
    return; }` then falls through to `decideControlDown` (control-actions.ts).
  - `onMouseDown` (view.ts:2853): `if (offerPress(...)) return;` before any
    order/cast logic. `offerPress` wraps `ui.handlePointer('down', ...)`.
  - `onMove`/`onMouseUp`/wheel: same shape (lines 2831-2852, 3150).
- `ui.handleKey/handlePointer/handleWheel` (`ui-layer.ts:451-461`) forward to
  `UiScreens` (`ui-screens.ts:1956-2112`), which returns
  `!reachesGameplay(this.routingOf(consumed, kind))` — i.e. `true` means
  "gameplay must not act on this."
- **How an open window swallows input today**: mostly through `consumed` —
  `UiRoot.handle(event)` walks the widget tree (layers → windows →
  focus) and a widget that handles the event reports so; a window just being
  open makes its buttons/fields hit-testable and "in front of" the world for
  pointer purposes (`layers.ts` stacking, `blocksBelow` per layer). This is
  **not** modal by default — clicking *beside* an ordinary window still
  reaches gameplay.
- **The actual modal mechanism** — `src/ui/core/events.ts:135-198`:
  `InputContextId = 'gameplay' | 'ui' | 'modal' | 'textEntry'`. Each has
  `blocksBelow` (pointer/wheel) and `swallowsKeys` (key/text) flags; `modal`
  and `textEntry` both block everything below them regardless of whether
  anything "consumed" the specific event. `ContextStack.reachesGameplay(kind)`
  (line 188) is what `routingOf`'s `blocked` field reads
  (`ui-screens.ts:2157-2158`).
- **The exact precedent for "take all input"**: `src/ui/widgets/dialog.ts`
  (`Dialog`, the shop's confirm-sell dialog, the only real user in production
  — `ui-screens.ts:618`, `this.layers.place('modal', this.shop.dialog)`).
  `show(contexts, focus, nowMs)` (dialog.ts:130-141): `contexts.push('modal')`
  + `focus?.focus(this.confirmButton)`. `hide(contexts, focus)`
  (dialog.ts:166-175): `contexts.pop('modal')` + clears focus if it was on
  its own buttons. `onEvent` (dialog.ts:228-240) handles Enter/Escape itself
  and calls `context.stopPropagation()`. Layer placement
  (`layers.ts:20,38-56`): `modal` layer has `blocksBelow: true`, sits above
  `windows`/`dragGhost`, below `tooltip`/`notification` — `LayerStack.hitTest`
  stops at a blocking layer with a visible child, so a click beside the modal
  reaches nothing underneath.
- A title screen (or controls overlay) built the same way — a widget placed
  in the `modal` layer, pushing `'modal'` on show / popping on hide — would
  automatically block every pointer/key/wheel event from reaching gameplay
  while it's up, with no changes needed to `view.ts`'s dispatch order.

## 5. The options window

- `WindowId` (`control-actions.ts:34`) includes `'options'`.
- Opened by: Escape when nothing is committed (view.ts:2739-2742,
  `ui.toggle('options')`); the `ui.keybindings` action mapped to `'options'`
  (`control-actions.ts:52`); the HUD's Options button
  (`SYSTEM_BUTTONS`, `hud.ts:180-188`) via `hud.onOpen((id) => ui.toggle(id))`
  (view.ts:1546).
- Registered in `UiScreens` constructor: `this.registerWindow('options',
  this.optionsScreen, { scrolled: false })` (ui-screens.ts:812).
- `this.optionsScreen = new OptionsScreen({ theme, keys: this.keybindings,
  display: this.display, ...(audio) })` (ui-screens.ts:695-700) — built from
  `KeybindingsScreen`/`DisplayScreen`/optional `AudioScreen`, all constructed
  earlier in the same constructor purely from `UiScreensOptions` (an
  `InputMap` plus callbacks) — **no `ClientView`, no live game session
  required.** `UiScreens.update(view, ...)` (which does need a `ClientView`)
  is only called per-frame from `ui.update()` in the render loop
  (view.ts:4111), which doesn't run until `start()`.
- **Conclusion**: the options window is fully decoupled from game state —
  it can be opened the instant `UiLayer`/`UiScreens` exist, whether or not
  `start()` has ever been called. The only coupling is that `UiScreens` is
  built inside `mountWorld()`, so a title screen wanting the *same* window
  instance must exist after `mountWorld()` has run (see §3's option (b)), or
  be handed its own `openHandler`-style callback the way `hud.onOpen` is
  (view.ts:1546) if `mountWorld` is deferred entirely (§3 option (a), in
  which case a second/lighter options window would have to be built for the
  title screen, or Start would need to run before Options can be honoured).

## 6. Versioned preference stores — the pattern

Three existing documents, all following the same shape. `src/ui/input/` per
CLAUDE.md holds bindings + display; layout actually lives in `src/ui/core/`,
and there is a fourth (audio mix) outside `src/ui/` entirely because its type
(`BusId`) isn't reachable from the pure `src/ui/` layer:

- `src/ui/input/binding-store.ts`: `BINDINGS_VERSION = 1` (line 20),
  `BINDINGS_KEY = 'turbo-deck.ui.bindings'` (line 21).
  `interface StoredBindings { version, overrides }`.
  `migrateBindings(raw): StoredBindings | null` (line 55) — never throws,
  refuses `version > BINDINGS_VERSION`.
  `parseBindings(text: string | null): StoredBindings | null` (line 72).
  `loadBindings(storage: StorageLike, map: InputMap, key = BINDINGS_KEY):
  boolean` (line 96).
  `saveBindings(storage: StorageLike, map: InputMap, key = BINDINGS_KEY):
  void` (line 85).
- `src/ui/input/display-store.ts`: `DISPLAY_VERSION = 3` (line 66),
  `DISPLAY_KEY = 'turbo-deck.ui.display'` (line 67). `StoredDisplay { version,
  scale, showFps, maxZoom }`. `migrateDisplay`/`parseDisplay` same shape.
  `DISPLAY_DEFAULTS` constant (line 137) is what an unwritten profile means.
  `loadDisplay(storage, key = DISPLAY_KEY): StoredDisplay` (never null —
  falls back to defaults, line 145). Per-field savers via a shared
  read-modify-write `patch()` (line 158): `saveScale`, `saveShowFps`,
  `saveMaxZoom` (lines 163-173), plus per-field loaders (`loadScale`,
  `loadShowFps`, `loadMaxZoom`).
- `src/ui/core/layout-store.ts`: `LAYOUT_VERSION = 2` (line 26),
  `LAYOUT_KEY = 'turbo-deck.ui.layout'` (line 53). Also defines
  `StorageLike` itself (lines 47-51: `getItem`/`setItem`/`removeItem`,
  "injected, never reached for"). `migrateLayout`/`parseLayout`/
  `loadLayout`/`saveLayout` (`saveLayout` returns `boolean`, never throws —
  line 220-227, since it's called from inside the frame loop).
- `src/render/audio/mix.ts`: `AUDIO_VERSION = 1` (line 29), `AUDIO_KEY =
  'turbo-deck.audio.mix'` (line 30) — same shape again, but deliberately
  lives outside `src/ui/input/` because `AudioMix` depends on `BusId` from
  `render/audio/events.ts`, and `src/ui/` may not import the renderer
  (mix.ts:19-23 explains this explicitly).

All are loaded/saved at the DOM edge in `mountWorld`, off one shared
`bindingStorage` object (`globalThis.localStorage` with a never-throwing
fallback — view.ts:1871-1875), keyed by their own distinct string keys:
`loadBindings(bindingStorage, inputMap)` (1876), `loadShowFps(bindingStorage)`
(1880), `loadMaxZoom(bindingStorage)` (2026), `loadScale(bindingStorage)`
(2206), `loadLayout(bindingStorage)` (2213), each saved back through a
callback threaded into `UiScreensOptions` (e.g.
`onBindingsChanged: () => saveBindings(bindingStorage, inputMap)`, line 2118).

**A fourth store for "controls overlay dismissed"** fits directly beside
`binding-store.ts`/`display-store.ts` in `src/ui/input/` (no renderer-only
type is needed — a plain boolean), e.g.:

```ts
export const CONTROLS_OVERLAY_VERSION = 1;
export const CONTROLS_OVERLAY_KEY = 'turbo-deck.ui.controlsOverlay';
export interface StoredControlsOverlay { readonly version: number; readonly dismissed: boolean; }
export function migrateControlsOverlay(raw: unknown): StoredControlsOverlay | null { ... }
export function parseControlsOverlay(text: string | null): StoredControlsOverlay | null { ... }
export function loadControlsOverlayDismissed(storage: StorageLike, key = CONTROLS_OVERLAY_KEY): boolean { ... }
export function saveControlsOverlayDismissed(storage: StorageLike, dismissed: boolean, key = CONTROLS_OVERLAY_KEY): void { ... }
```

wired into `mountWorld` the same way (`loadControlsOverlayDismissed(bindingStorage)`
near the other `loadX(bindingStorage)` calls around view.ts:1876-2213).
