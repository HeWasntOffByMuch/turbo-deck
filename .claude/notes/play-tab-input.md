# Play tab input handling (src/render/iso3d/world/)

## 1. Pointer/mouse binding — all in `view.ts` (mountWorld), DOM half

- `src/render/iso3d/world/view.ts:70` `mountWorld(container)` builds the DOM (`root` div +
  `canvas`), wires the sim/client, and owns every listener. All handlers are closures over
  local mutable state (`held`, `cursor`, `destination`, `targetId`, `pendingAim`, `order`,
  `facing`) — there is no separate input module for the Play tab the way the editor has
  `editor/input.ts`.
- Listeners are attached in `start()` (`view.ts:780-787`) and torn down in `stop()`
  (`view.ts:795-802`) — `keydown`/`keyup`/`blur` on `window`, `mousemove`/`mouseleave`/
  `mousedown` on `canvas`, `contextmenu` on `document.documentElement` (not just the canvas).
- `onMouseDown` (`view.ts:392-446`) is the one function that does both click orders:
  - `button === 0` (left click): calls `confirmAim()` (`view.ts:307`) and returns. Left click
    does nothing unless a `pendingAim` exists (spec 080) — no left-click move order exists
    today.
  - `button === 2` (right click, `event.button !== 2` early-returns for the middle button):
    if a `pendingAim` is standing, cancels it and returns (no move/attack). Otherwise clears
    any confirmed `order`, raycasts for a unit via `scene.pickUnitAt`, and either sets
    `targetId` (attack order, spec 070) or `destination = scene.screenToWorld(...)` (move
    order) plus `client.cancelCast()`.
  - `onContextMenu` (`view.ts:447`) is a one-line `event.preventDefault()` — this is what
    keeps the right button available as a game input instead of opening the browser menu.
- `onMove`/`onLeave` (`view.ts:385-391`) just track `cursor` in canvas-local CSS pixels
  (`event.clientX - rect.left`, etc.) for hover/aim; no drag state, no `mouseup` handler, no
  pointer capture anywhere in this file. There is **no camera-drag / orbit-by-mouse** in the
  Play tab.
- `onKeyDown`/`onKeyUp` (`view.ts:351-384`) handle WASD/arrows into the `held` set, hotbar
  digit keys (`HOTBAR[Number(event.key)-1]` → `pressAbility`), and Escape (`cancelCast` +
  clear aim/target).

## Pure decision modules the DOM handlers call into

- `intent.ts` (`moveIntent`, `RoutePlanner`) — pure, no DOM/clock. Turns `held` keys + a
  `destination`/`route`/`castAim`/`targetAim` into a per-tick move vector and facing. Also
  pure A*-backed `RoutePlanner.next()` (client-side pathing for move/chase orders, since the
  client predicts the vector it sends).
- `target.ts` (`autoAttack`) — pure. Given self/target snapshots + range/cooldown/alignment,
  returns `{ chaseTo, attack, drop }` per tick; consumed by `driveAutoAttack` in `view.ts:499`.
- `aim.ts` (`startAim`, `aimShape`, `castOrder`) — pure; governs the spec-080 aim/commit
  flow (`pressAbility` → `pendingAim` → `confirmAim` → `order` → `driveCastOrder`).
- `scene.ts` owns the only impure geometry: `screenToWorld` (`scene.ts:443`, raycasts against
  the terrain mesh, falls back to the y=0 ground plane) and `pickUnitAt` (`scene.ts:469`, a
  fresh per-click raycast + `pickHoveredUnit` from `hover.ts`, not the cached per-frame hover,
  precisely so a click in the same task as its `mousemove` still hits something).
- `hud.ts` only has ordinary DOM `click` listeners on hotbar/equip buttons (`hud.ts:203,253`)
  that call `onUse`/`onEquip` callbacks into `view.ts`; no pointer/drag logic.

## 2. Camera zoom — wheel, in `view-controls.ts` + `view-settings.ts`, mutates a slider value

- The Play tab's camera itself has no drag/orbit input; azimuth/elevation are lil-gui-style
  sliders in the settings cog popover (`createViewControls()` in `view-controls.ts`), and zoom
  is the one thing also wired to the mouse wheel.
- `scene.ts:379-380` (constructor): `this.controls = createViewControls(); this.controls.attachWheelZoom(canvas);`
- `attachWheelZoom` (`view-controls.ts:488-497`) adds a **non-passive** `wheel` listener on the
  canvas: `e.preventDefault()` then `zoom.setValue(zoomViewHalfWidth(zoom.value(), e.deltaY, e.deltaMode))`.
  Non-passive is deliberate — the comment notes the wheel must not also scroll the page.
- `zoom` is a `Slider` (`makeSlider`, `view-controls.ts:119`) called "View span"; its value is
  the orthographic half-width. `viewHalfWidth: () => zoom.value()` (`view-controls.ts:500`) is
  what the scene reads each frame to build the camera frustum (`cameraFrustum` in
  `view-frame.ts:47`).
- `zoomViewHalfWidth(current, deltaY, deltaMode)` (`view-settings.ts:128`) delegates to the
  generic `zoomSpan` (`view-settings.ts:138`), which is pure and tested (`view-settings.test.ts`):
  multiplicative step `ZOOM_PER_NOTCH = 1.1` per notch (`view-settings.ts:109`), notch size by
  `WheelEvent.deltaMode` via `DELTA_PER_NOTCH = [100, 3, 1]` (px/lines/pages,
  `view-settings.ts:111`), and always clamped.
- Clamp bounds: `MIN_VIEW_HALF_WIDTH = 200`, `MAX_VIEW_HALF_WIDTH = 1400`
  (`view-settings.ts:103-104`); opening default `DEFAULT_VIEW_HALF_WIDTH = 320`
  (`view-settings.ts:96`). `clampViewHalfWidth` (`view-settings.ts:114`) is the single gate —
  both the slider and the wheel go through `zoomSpan`'s internal `clamp`, so nothing can escape
  the band, and a non-finite value falls back to the default.
- This is a *view span in world units* (orthographic half-width), not a camera distance —
  the camera offset (`cameraOffset()`) is a separate, independently-orbited value from the
  `camAz`/`camEl` sliders and `DEFAULT_CAMERA_OFFSET`.

## 3. Tab shell — `src/render/iso3d/main.ts`

- Single `main()` (`main.ts:38`) reads `#app` (declared in `src/render/index.html:14`, styled
  `position:fixed;inset:0` — the only "CSS" for the shell is the inline `<style>` block in
  `index.html:8-12`, no external CSS files exist anywhere under `src/render/`).
- Four tabs is a plain array of `{ label, mount, fullscreen? }` (`main.ts:42-47`): Play
  (`mountWorld`, fullscreen), Movement sandbox, Rig debug, Map editor (`mountEditor`,
  fullscreen).
- `activate(i)` (`main.ts:70-91`) is the whole tab-switch logic: `stop()`s and hides the
  previously-active view's element, lazily `mount()`s the new one on first visit (cached in
  `handles[]` thereafter — views are never remounted, only started/stopped), sets
  `display:block`, calls `handle.start()`.
- `fullscreen` here means "owns the whole `#app` viewport with floating UI" (CSS layout only)
  — it is **not** the browser Fullscreen API. There is no `requestFullscreen`/`Fullscreen`
  anywhere in the repo (`grep -rn fullscreen` only turns up this CSS-layout sense and the
  `view-frame.ts` framing-maths comment).
- No touch handling anywhere in `src/render` — `grep -rn "touch-action|touchstart|touchmove|
  touchend"` across the tree returns nothing. No `PointerEvent`/`pointerdown` in the Play tab
  either; that pattern exists only in the *editor* (`editor/input.ts`, tested in
  `editor/input.test.ts`) for its multi-button camera-drag tool, and in
  `sandbox-input.ts` for the tuning sandboxes. The Play tab is mouse-only (`MouseEvent`) and
  keyboard-only, no drag anywhere.

## 4. contextmenu + pointer→world conversion

- `contextmenu` is prevented in three independent places, each scoped to its own view:
  - Play tab: `document.documentElement` (`view.ts:786`, `onContextMenu` at `view.ts:447`) —
    broader than the canvas, presumably because HUD DOM elements float over it.
  - Editor: `this.canvas` (`editor/input.ts:152`).
  - Sandboxes: `this.canvas` (`sandbox-input.ts:61`).
- Screen→world conversion for the Play tab is `WorldScene.screenToWorld(cssX, cssY)`
  (`scene.ts:443-456`): CSS pixel → NDC via the pure `cursorToNdc` (`view-frame.ts:53`) → 
  `THREE.Raycaster.setFromCamera` → intersect against `terrainMesh.pickTargets` (real
  terrain height, so aiming at a hillside lands on the hillside) → falls back to intersecting
  the flat `groundPlane` if no terrain mesh has streamed in yet or nothing was hit.
- Unit picking is `WorldScene.pickUnitAt(cssX, cssY)`: same NDC/raycast setup, handed off to
  the pure `pickHoveredUnit` in `hover.ts`. Since spec 095 that is two world-space tests and
  nothing in pixels — the body (the rig's meshes, or the cylinder of `radius` × `height`
  standing on its feet, whichever the ray meets first) and then the footprint at exactly
  `radius`. Spec 071's screen-space box, its 22px snap and its 12-unit footprint apron are
  gone, along with `WorldScene.screenBoxOf`: the view asks for a pick *before* it falls back
  to a move order, so every unit of forgiveness was ground the player could not walk to.
  Picking afresh per click rather than reusing the frame's hover still holds, so a click
  arriving in the same task as its `mousemove` (synthetic clicks, fast flicks, taps) resolves.

## 5. CSS / touch-action / user-select

- No `.css` files exist under `src/render/` (or anywhere in `src/`) — everything is inline
  `style.cssText` on created elements, plus the single `<style>` block in
  `src/render/index.html:8-12` (just `html,body{margin:0;height:100%;...;overflow:hidden}`
  and `#app{position:fixed;inset:0}`).
- No `touch-action` or `user-select` CSS anywhere in the repo. The canvas itself
  (`view.ts:74-76`) is only styled `position:absolute;inset:0;` — no touch-action override,
  so default touch scrolling/pinch-zoom behavior on the canvas is whatever the browser does
  by default (relevant if touch input work is planned: nothing currently suppresses
  pinch-to-zoom or pull-to-refresh over the Play canvas).

## Open questions / things to check before adding touch or camera-drag support

- Because the Play tab's camera has no drag input today, adding pinch-to-zoom or two-finger
  orbit would be new surface, not a port of an existing pattern — the closest existing
  precedent for multi-pointer camera control is `editor/input.ts` (pointer-based, tracks
  `pointerId`s, non-passive listeners), not anything in `world/`.
- `attachWheelZoom`'s `{ passive: false }` + `preventDefault()` (`view-controls.ts:488-496`)
  is the only place player input suppresses a default browser gesture in the Play tab besides
  `contextmenu`; a touch equivalent would need the same non-passive treatment plus explicit
  `touch-action` CSS on the canvas, neither of which exists yet.
