# Developer-facing chrome in the Play tab (`src/render/iso3d/world/view.ts` + neighbours)

Written for: building a "production client" mode that hides dev/debug UI.
See also `.claude/notes/play-tab-input.md` (input handling) and
`.claude/notes/world-terrain-network.md`.

## 1. The eight settings-corner buttons

All built/appended in one block: `world/view.ts:1547-1611`.

- Gate: `const showsTuningMenus = hudLayout(isHandheldDevice()).showsTuningMenus;`
  (`view.ts:1558`), then `if (showsTuningMenus) { ... }` (`view.ts:1569-1611`).
  **The only existing condition is device-based** (`isHandheldDevice()`,
  `device.ts`) — there is no separate dev/prod flag. `showsTuningMenus` is
  `true` in `DESKTOP` and `false` in `COMPACT` (`hud-layout.ts:148-233`).
  Handheld-ness can be forced with `?frame=phone` / `?frame=desktop`
  (`device.ts:119-126`, `frameOverride`).
- 5 of the 8 buttons come from one call: `scene.controls = createViewControls()`
  at `world/scene.ts:805`. `ViewControls.element` is a flex row containing, in
  order (`view-controls.ts:707-769`):
  1. ⚙ "View settings" (`view-controls.ts:707`) — camera orbit/height/zoom/
     follow-lag, unwalkable-terrain overlay, spawner-timer overlay.
  2. ☀ "Day and night"/"Light" (`view-controls.ts:716`) — day/night clock,
     manual sun direction/elevation.
  3. ✦ "Player lights" (`view-controls.ts:729`, only when `opts.lighting`,
     default true) — torch + magic light.
  4. ▦ "Retro filter" (`view-controls.ts:743`) — the dither/quantize pass +
     colour grade.
  5. ❖ "Hike look" (`view-controls.ts:749`) — ~30 rows of the stylised-render
     pipeline (normals, buffers/outlines, distance ink, surface detail, etc).
- 3 more buttons, each built and appended separately in `view.ts`:
  6. ≋ "Weather" — `createWeatherControls({ group: scene.controls.menus })`
     (`view.ts:1570`), from `weather-controls.ts`.
  7. ✦ "Effects" — `createVfxControls({ group: scene.controls.menus, onChange
     })` (`view.ts:1574-1581`), from `vfx-controls.ts`. Feeds
     `scene.setVfxIntensity`/`scene.setGore` and the local `gore` used by
     blow VFX.
  8. ⌇ "Wire" — `createWireControls({ group: scene.controls.menus, initial:
     wireConditions })` (`view.ts:1585-1588`), from `wire-controls.ts`.
     Simulates packet delay/jitter/loss/dup on the channel.
- All 8 share one `MenuGroup` (`scene.controls.menus`, from
  `menu-group.ts:createMenuGroup()`), so only one popover is open at a time.
  `createSettingsMenu` (`settings-menu.ts:79`) is the shared button+popover
  builder (glyph, tooltip, `aria-expanded`, Reset button).
- DOM mount: a `<div data-hud-right="settings">` positioned
  `top:calc(8px + safe-area-inset-top); right:calc(10px + safe-area-inset-right)`
  (`view.ts:1590-1601`), `buttons.append(scene.controls.element, weather.element,
  vfxControls.element, wireControls.element)` (`view.ts:1601`), then
  `root.append(buttons)` (`view.ts:1610`) — only reached inside the
  `showsTuningMenus` branch, so on a phone none of these 8 buttons exist in
  the DOM at all (not just hidden).
- Note: the "View settings" panel's `showUnwalkable`/`showSpawners` toggles
  and the whole hike-look/retro-filter panels are legitimate *player-visible
  render-tuning* features, not just internal debug — worth deciding
  per-button rather than assuming "hide all 8" is correct for prod.

## 2. Developer text readouts

### 2a. The visible "developer readout" (top-left, monospace box)

- Built in `createHud()`, `world/hud.ts:525-569`: `status` div,
  `position:absolute;left:12px;top:52px;font:12px ui-monospace,...`
  (`hud.ts:534-537`).
- `let readoutWanted = true` (`hud.ts:544`) — **on by default**, not
  persisted (comment: "the binding outlives a session, where the switch does
  not").
- Visibility = `readoutShown(layout, readoutWanted)` = `layout.showsReadout &&
  readoutWanted` (`hud-layout.ts:537-539`). `showsReadout` is `true` on
  `DESKTOP`, `false` on `COMPACT` (`hud-layout.ts:148-233`) — same
  `isHandheldDevice()` gate as the settings buttons, nothing independent.
- **It is hidden via `display:none`, never removed, and its text is still
  written every frame regardless** (`hud.ts:546-569` comment: "Hidden, not
  removed, and still written every frame" — `scripts/preview-touch.ts` reads
  it out of `document.body.textContent` even while hidden). So a "production"
  mode that only sets `display:none` still ships the tick/hp/target/aim text
  in the DOM.
- Toggle key: `F3` → action id `debug.toggleStats`
  (`src/ui/input/bindings.json:286-293`) → `decision.toggleStats` →
  `hud.toggleReadout()` at `view.ts:2688-2691` → `hud.ts:2028-2031`.
- Text content assembled at `hud.ts:1812-1837`: tick/delta/seed, hp/guard,
  level/xp, restoration motes/flask charges, monster count, prediction
  correction count, connection status, current target line, current aim line.
- A companion dead binding lives in the same "Debug" keybinding category:
  `debug.reloadMap` (Ctrl+F5, `bindings.json:294-303`) — reaches **nothing**
  in the code (confirmed only by spec `specs/183-a-binding-that-toggled-nothing.md:89`,
  no reader anywhere in `src/`). Both rows are visible/rebindable in every
  player's Options → Keybindings → **Debug** tab
  (`ACTION_CATEGORIES` in `src/ui/input/actions.ts:18-42` always includes
  `'debug'`; `CATEGORY_LABELS.debug = 'Debug'` in
  `src/ui/screens/keybindings.ts:376`) — not device-gated at all.

### 2b. The FPS/perf overlay — separate from the readout, NOT device-gated, on by default

- `world/fps-overlay.ts` — a small canvas + text lines drawn top-right,
  `top:52px;right:8px` (i.e. *under* the settings-cog row) with
  `display:none` until first `.set()` with non-null stats
  (`fps-overlay.ts:75-138`). Shows fps/avg/1%-low/worst ms, streaming-stage
  cost, draw calls + triangle count, sim ms (mean/worst/ticks-per-frame),
  render prepare/draw ms, and a scrolling frame-time graph.
- Built unconditionally in `mountWorld`: `const fpsOverlay =
  createFpsOverlay(root)` at `view.ts:875` — **outside** the
  `showsTuningMenus`/`isHandheldDevice()` gate, so it exists on phones too.
- `let showFps = DEFAULT_SHOW_FPS` (`view.ts:876`); `DEFAULT_SHOW_FPS = true`
  (`src/ui/input/display-store.ts:22`). Re-read from storage at
  `view.ts:1874` (`loadShowFps(bindingStorage)`), which also defaults to
  `true` if nothing is stored. Called every frame at `view.ts:4048-4056`:
  `fpsOverlay.set(showFps ? frames.stats() : null, ...)`.
- Player-facing toggle: Options window → Display tab → "Show frame rate"
  checkbox (`src/ui/screens/display.ts:102-111`), which is **on for every
  new session on every device** unless a player explicitly turns it off.
- This is the single most exposed piece of "developer chrome": no key, no
  query param, no device check — just a checkbox defaulting to on.

### 2c. Invisible `data-*` attributes — not visible chrome, but exist unconditionally

Written on `root` (the Play tab's outer `<div>`) and a few `hud.ts` elements,
for headless `scripts/probe-*.ts` harnesses to read via `element.dataset`;
never rendered as text, never gated by device or any flag:
- `view.ts:1241-1252` — `chunksHeld`, `chunksDrawn`, `chunksPending`,
  `propRegions`, `propDirty`, `propRefused`, `auras`, `worldLights`, `nav`.
- `view.ts:1282-1285` — `authoredUnits`, `authoredBones`, `authoredStates`,
  `heldWeapons`.
- `view.ts:1340-1344` — `vfxIntensity`, `vfxGore`, `vfxParticles`,
  `vfxDecals`, `vfxStarted`.
- `view.ts:1382-1383` — `orders`, `selfAt`.
- `view.ts:4068-4069` — `cameraOrbit`, `cameraZoom`.
- `hud.ts:662,1998,2006` — `crosshair`; `hud.ts:712/1071/1094` —
  `hudBottom` (`pools`/`account`/`weapons`); `hud.ts:566` — `statsReadout`
  (`'on'`/`'off'`, mirrors 2a above).
These are safe to leave alone for a "hide visible chrome" pass — they cost a
few attribute writes and are invisible in the rendered page — but note them
if "production" is meant to also strip probe hooks.

## 3. Query-parameter switches (Play tab + shared)

| Param | Parser (file:line) | Read in `view.ts` | Notes |
|---|---|---|---|
| `?server=`, `?id=`, `?name=` | `world/connection.ts:158-182,220-239` (`identify`, `planConnection`) | `view.ts:394-403` | Which server to dial / player identity. `import.meta.env?.VITE_SERVER_URL` is the only baked-in default (`view.ts:402`). |
| `?seed=` | `seed.ts:13-17` (`viewSeed`) | `view.ts:376` | World/PRNG seed; falls back to `Date.now()`. |
| `?units=` | `world/unit-catalog.ts:100-119` (`unitsFromQuery`) | `view.ts:383` | Overrides which authored `.glb` a monster type id draws as. |
| `?frame=phone\|desktop` | `device.ts:119-126` (`frameOverride`) | via `isHandheldDevice()` (`device.ts:144-147`), called `view.ts:1558`, `hud.ts:529`, and `main.ts:29,82` | Forces the handheld/desktop layout decision — the one flag everything in §1/§2a already keys off. |
| `?wire=delay:N,jitter:N,loss:F,dup:F` | `src/server/net/wire-query.ts:36` (`parseWire`) | `view.ts:643` | Always active (not loopback-gated); also seeds the "Wire" popover's sliders when built (`view.ts:1585-1588`). |
| `?afflict=name,name\|all` | `world/affliction-vfx.ts:535-554` (`afflictionsFromQuery`) | `view.ts:621`, applied `view.ts:3751-3762` | **Loopback-only**: `server === null ? [] : afflictionsFromQuery(...)` — `server` is the in-tab `GameServer`, null when connected to a real remote server. Inert in a real deployment already. |
| `?field=1\|true\|all\|<fieldId>` | `world/aura-vfx.ts:185-193` (`fieldsWantedByQuery`) | `view.ts:641`, applied `view.ts:3767-3774` | Same loopback-only gate as `?afflict=`. |
| `?perf=noshadow,noprops,noterrain,noworker` | `world/perf-flags.ts:71-85` (`parsePerfFlags`) | `view.ts:704-705` | Measuring switch; `scene.setPerfFlags(...)`. |
| `?props=<size>` | `world/perf-flags.ts:64-69` (`parsePropRegionSize`) | `view.ts:709` | Prop-field batching region size override. |
| `?slots=id,,id` | `world/action-bar.ts:129-133` (`actionBarFromQuery`) | `view.ts:1511` | **Not loopback-gated** — overrides the drawn action bar even against a real server; harmless server-side since `startCast` still requires the ability be equipped, but it lets a URL show abilities the player hasn't earned/equipped in the bar UI. |
| `?map=generated\|shipped` | `editor/map-source.ts:65` | **not read anywhere in `world/view.ts`** | Editor-tab-only; irrelevant to the Play tab despite being in the same query-param "register". |

## 4. `mountWorld` / `ViewHandle`

- Signature: `export async function mountWorld(container: HTMLElement):
  Promise<ViewHandle>` (`world/view.ts:349`). **No options parameter at
  all.** `main.ts`'s `Tab.mount` type is `(container: HTMLElement) =>
  ViewHandle | Promise<ViewHandle>` (`main.ts:40`) — also no room for options
  without changing the shell's `Tab` interface too.
- `ViewHandle` (`view-handle.ts:8-12`): `{ readonly element: HTMLElement;
  start(): void; stop(): void; }` — 3 members, nothing else. `start()`
  (`view.ts:4110-4169`) wires listeners + connects; `stop()`
  (`view.ts:4170-4216`) tears them down.
- Anything gating dev chrome today reads either `isHandheldDevice()`
  (module-level, cached, reads `window.location.search`/`matchMedia`
  directly — `device.ts:143-147`) or a `URLSearchParams(location.search)`
  read inline in `mountWorld`. There is no injected options object anywhere
  in this call path — a "production mode" flag would need either a new
  query param/env check added inline (matching the existing style) or a new
  parameter threaded through `mountWorld`/`Tab.mount`/`main.ts`.

## 5. Existing production/dev distinctions

- **No `import.meta.env.DEV`/`PROD`/`MODE` anywhere in the tree.**
  `tsconfig.json` deliberately does **not** reference `"vite/client"` (not in
  `compilerOptions.types`, not in a triple-slash directive anywhere), so
  Vite's default `ImportMetaEnv` (which has `DEV`/`PROD`/`MODE`) is not even
  typed. `src/vite-env.d.ts:22-55` hand-declares a narrow `ImportMeta.env`
  with exactly two fields: `VITE_SERVER_URL` and `BASE_URL`
  (`vite-env.d.ts:32-40`) — `import.meta.env.DEV` would be a type error
  today.
- `vite.config.ts` has exactly two `apply: 'serve'` plugins —
  `mapWritePlugin()` (`scripts/dev-map-write.ts:154`) and
  `sfxWritePlugin()` (`scripts/dev-sfx-write.ts:181`) — both editor/SFX-tab
  write endpoints, unrelated to the Play tab's chrome. No other
  `build`/`mode`-conditional branching exists in `vite.config.ts`.
- The only "does the environment differ" switches touching the Play tab
  today are: (a) `isHandheldDevice()` (device-based, overridable via
  `?frame=`), and (b) `import.meta.env?.VITE_SERVER_URL` (which server a
  *built* page dials with no `?server=` — a deploy-time constant, not a
  dev/prod code-path split).
- Net: **there is no existing "production build differs from dev build" concept
  for the Play tab.** A "production client" mode is new surface, not a
  toggle that's already half-wired — closest existing precedent to build on
  is the `isHandheldDevice()` / `hudLayout()` gate (§1/§2a), which already
  hides 8 buttons + the readout, but does **not** touch the FPS overlay
  (§2b) or the `?afflict=`/`?field=`/`?slots=`/`?wire=`/`?units=`/`?perf=`
  query surface (§3), which are all separate, independent checks.
