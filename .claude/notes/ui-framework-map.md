# UI construction map (for designing a reusable GUI framework)

Everything under `src/render/` is hand-rolled DOM (`document.createElement` +
inline `style.cssText`). There is exactly **one** lil-gui usage in the whole
repo. There is no CSS file anywhere in `src/` except the one `<style>` block in
`src/render/index.html:8-12`. No component framework, no templating, no
virtual DOM.

## 1. Tab shell — `src/render/iso3d/main.ts` (120 lines)

- `main()` reads `#app` from `src/render/index.html`, builds a floating button
  bar (`bar`, `position:fixed;top:0;left:0;z-index:50`) and a `container`
  (`position:absolute;inset:0;overflow:auto`), appended to `#app`.
- `Tab = { label, mount: (container) => ViewHandle, fullscreen? }`. Five tabs:
  Play (`mountWorld`, fullscreen), Movement sandbox (`mountMovement`), Rig
  debug (`mountDebug`), Map editor (`mountEditor`, fullscreen), Studio
  (`mountStudio`).
- `ViewHandle` (`src/render/iso3d/view-handle.ts`, 13 lines) is the entire
  contract: `{ element: HTMLElement; start(): void; stop(): void }`.
- `activate(i)` (`main.ts:79-100`): `stop()`s + hides (`display:none`) the
  previous handle's `.element`; lazily calls `tab.mount(container)` on first
  visit and caches it in `handles[]` forever (views are never remounted, only
  started/stopped); non-fullscreen views get `padding:'44px 16px 16px'` so
  they clear the floating tab bar; sets `display:block`; calls `start()`.
- `fullscreen` on a `Tab` means "owns the whole `#app` viewport with its own
  floating UI", a CSS-layout concept only — **not** the browser Fullscreen
  API. That's a separate button: `createFullscreenButton` in
  `src/render/iso3d/fullscreen.ts`, added to the tab bar only when
  `canGoFullscreen() && isCoarsePointer()` (phone only; desktop uses F11).
- Button styling: `styleButton(btn, on)` (`main.ts:72-77`) — literal inline
  CSS string, monospace font, on/off background swap. This exact pattern
  (a `style(on: boolean)` closure toggling `cssText`) recurs in
  `settings-menu.ts` and `fullscreen.ts`.

## 2. Play tab HUD — `src/render/iso3d/world/hud.ts` (669 lines)

**DOM overlay, not canvas/three.js.** `createHud(project: Projector): HudHandle`
builds a `root` div (`position:absolute;inset:0;pointer-events:none;overflow:hidden`)
appended alongside the three.js `<canvas>` in `view.ts:231`
(`root.append(hud.element, buttons)`), full-viewport regardless of the
retro-pass letterbox rect.

Why DOM and not drawn into the 3D scene: the world renders at a low internal
resolution and goes through the dither/quantize pass (`RetroPass`); text
through that filter comes out as "chewed pixels". Floating DOM over the canvas
keeps the world chunky and the HUD crisp — **the HUD does not go through the
retro pass at all.**

Elements built once and mutated per frame in `update()`:
- `status` — the dev readout (tick/hp/target/aim line), hidden (`display:none`,
  not removed) when `!layout.showsReadout` — kept alive because
  `scripts/preview-touch.ts` reads it out of `document.body.textContent`.
- `notices`, `spawnerLayer` (spawner marks, one div per spawner id, keyed by
  `dataset['spawner']`), `bar` (hotbar), `aimHint` (compact-only), `weapons`
  (weapon switch), per-entity health/cast `Bar`s (`barFor(id)`, keyed by
  `dataset['entity']`), and damage-number elements (`popupElements`, keyed by
  `dataset['damageId']`).
- Every hotbar/weapon button is a plain `<button>` with a `click` listener
  calling `useHandler`/`equipHandler` set via `hud.onUse`/`hud.onEquip`. No
  drag, no keyboard handling in this file.
- `update(view, anchors, tick, corrections, targetId, aiming)` is called once
  per frame **after** the scene has drawn (needs current `ScreenAnchor[]` from
  `WorldScene.screenAnchors`). It is a pure "read replicated state → set
  styles" pass — the module's own doc comment states "No `if` in this file
  changes an outcome."
- `HudHandle.addDamage(entityId, at: WorldAnchor, damage, crit)` — event-driven
  (not per-frame): spawns a `pixelTextSvg(...)` element, hidden until the next
  `update()` places it (there's no camera to project against at spawn time).
  Positioning of damage numbers is delegated to the pure `DamagePopups` field
  in `src/render/iso3d/world/damage-popup.ts` (`NUMBER_LIFE=48`,
  `NUMBER_RISE=46`, `NUMBER_LANES`, class `DamagePopups` with `.add()`/`.step(project)`),
  which tracks a world point + age and a `Projector = (x,y,lift) => {x,y,onScreen}`
  is handed in once at construction (`WorldScene.projectPoint`).

### `hud-layout.ts` (119 lines) — pure sizing table, no DOM

- `hudLayout(compact: boolean): HudLayout` returns one of two **hand-authored
  constant objects**, `DESKTOP` or `COMPACT` — not responsive CSS, not media
  queries computed live each frame. The one live signal is
  `isCoarsePointer()` (from `fullscreen.ts`), read once at HUD construction.
- `HudLayout` fields are all plain numbers/booleans in **CSS px**: `slot:
  BoxSize`, `slotGap`, `slotFontPx`, `slotCountdownPx`, `weapon: BoxSize`,
  `weaponGap`, `weaponDirection: 'row'|'column'`, `edge` (HUD-to-frame-edge
  gap, combined with `env(safe-area-inset-*)` in the DOM code).
  `MIN_TAP_PX = 44`.
- Pure helper arithmetic consumed by tests, not by the HUD itself:
  `stripWidth(box, gap, count)`, `centredClearance(layout, slots, frameWidth)`.
  This is the "whether eight buttons fit on a phone" check done in Node.

### `icons.ts` (76 lines) — inline SVG strings, no atlas/texture

- `WEAPON_ICONS: Record<string,string>` — hand-authored SVG path data in a
  24x24 box, keyed by ability id (`melee.slash`, `ranged.shot`, `ranged.star`).
  `weaponIconSvg(abilityId, {size, color}): string` wraps the body in an
  `<svg>` with `fill="none" stroke="currentColor"`, so a button's own CSS
  `color` drives the icon (`button.style.color` lit/unlit already set
  elsewhere colors the icon for free). No sprite sheet, nothing fetched
  (emoji explicitly rejected as non-deterministic across fonts/platforms).

### `pixel-font.ts` (153 lines) — pure, draws into an SVG string (not canvas2d)

- 5x7 bitmap glyph table `GLYPHS: Record<string, string[]>` (digits, `+ - !
  space`), `GLYPH_WIDTH=5 GLYPH_HEIGHT=7 GLYPH_SPACING=1`.
- `glyphRects(text): PixelRect[]` → one unmerged rect per lit pixel;
  `glyphPath(text): string` → one SVG path `d` of axis-aligned rect commands;
  `pixelTextSvg(text, {scale=3, fill, outline}): string` returns a
  self-contained `<svg>` string with `shape-rendering:crispEdges`, outline
  drawn as 8 offset copies of the same path (not a stroke, to avoid rounding).
- Used only by `hud.ts` for damage numbers (`element.innerHTML =
  pixelTextSvg(...)`). This is the only "custom font" mechanism in the repo.

### `touch.ts` (152 lines) — pure gesture recognizer, no DOM

- `class TouchGestures` — `down/move/up/cancel/clear(sample: TouchSample)`.
  Emits `TouchGesture = {kind:'tap',x,y} | {kind:'pinch',ratio}`.
- Tap is bounded **only by distance** (`TAP_SLOP_PX = 16`), deliberately not
  by time — measured reasoning documented inline (a busy main thread delays
  event *creation*, so a time budget punishes exactly the slow devices this
  exists for).
- Wired into DOM listeners by `world/view.ts` (not shown in touch.ts itself);
  `view.ts` translates raw `pointerdown/move/up` into `TouchSample`s and feeds
  this class, then interprets the returned `TouchGesture` as a move/attack
  order or a `ViewControls.pinchZoom(ratio)` call.

## 3. Input capture and routing

No centralized keybinding/action-mapping layer anywhere — every module reads
raw `KeyboardEvent.key` / `MouseEvent.button` / `PointerEvent` directly and
switches on the string/number itself.

- **Play tab** (`src/render/iso3d/world/view.ts`, `mountWorld`) owns *every*
  listener itself — no separate input module (unlike the editor). Listeners
  attached in `start()` (`view.ts:780-787`), torn down in `stop()`
  (`view.ts:795-802`): `keydown`/`keyup`/`blur` on `window`;
  `mousemove`/`mouseleave`/`mousedown` on `canvas`; `contextmenu` on
  `document.documentElement`.
  - `onKeyDown`/`onKeyUp` (`view.ts:351-384`): WASD/arrows into a `held` Set,
    digit keys `1..8` → `HOTBAR[Number(event.key)-1]` → `pressAbility`,
    `Escape` → cancel cast/aim/target. Raw `event.key` string comparisons.
  - `onMouseDown` (`view.ts:392-446`): `event.button === 0` → `confirmAim()`;
    `event.button === 2` → cancel pending aim, or set `targetId` (attack) /
    `destination` (move) via raycasts.
  - `onContextMenu` — `event.preventDefault()` only, keeps right-click free
    for game input.
- **Pure decision modules** the DOM handlers call into (no DOM/clock inside
  these): `world/intent.ts` (`moveIntent`, `RoutePlanner`), `world/target.ts`
  (`autoAttack`), `world/aim.ts` (`startAim`, `aimShape`, `castOrder`).
- **Editor** (`src/render/iso3d/editor/input.ts`, tested in `input.test.ts`):
  the one place with a real input-capture class — `PointerEvent`-based,
  tracks `pointerId`s, non-passive listeners, multi-button camera drag. Not
  reused by the Play tab.
- **Sandboxes** (`src/render/iso3d/sandbox-input.ts`): another
  `PointerEvent`-based capture class for the two tuning sandboxes
  (`movement.ts`, `debug-view.ts`), independent of both the editor's and the
  Play tab's.
- **Camera zoom** (wheel): `attachWheelZoom(canvas)` in `view-controls.ts:488-497`
  — non-passive `wheel` listener, `preventDefault()`, calls
  `zoomViewHalfWidth` (pure, `view-settings.ts:128`, delegates to `zoomSpan`).
- **Touch**: `TouchGestures` (above) is the only pure recognizer; raw
  `pointerdown/move/up/cancel` are read directly in `view.ts` (not in
  `touch.ts` itself) and translated into `TouchSample`s.
- No `.css`, no `touch-action`, no `user-select` anywhere in the repo (per
  `.claude/notes/play-tab-input.md`, confirmed by grep). The canvas is styled
  only `position:absolute;inset:0`.

## 4. Settings menus — two independent, differently-built systems

See also `.claude/notes/render-settings-toggles.md` (fuller worked example).

1. **Play tab**: `src/render/iso3d/view-controls.ts` (769 lines) — hand-rolled
   DOM (`<label>`/`<input type=range|checkbox>`/`<select>`), **not** lil-gui.
   No `localStorage`; every session opens at hardcoded defaults.
   - `createViewControls(opts): ViewControls` builds six buttons (View
     settings / Day-night / Player lights / Retro filter / Hike look /
     Weather), each its own popover, sharing one `MenuGroup`
     (`opts` → `ViewControlOptions.lighting` drops 2 of them for the tuning
     sandboxes).
   - Widget builders, all private to this file, each returning a small handle
     `{row, value()/checked(), reset()}`: `makeSlider(label,min,max,step,initial,unit,tip,format?)`
     (`view-controls.ts:174`), `makeCheckbox(label,initial,tip)` (`:233`),
     `makeChoice(label,options,initial,tip)` (numeric `<select>`, `:260`),
     `makeTextChoice(...)` (string `<select>`, `:304`).
   - `fill(panel, tip, rows)` appends headings + widget `.row`s in order and
     wires a popover's Reset from exactly the widgets it was given.
   - The `ViewControls` interface (`:73`) is a set of **getter functions**
     polled every frame by `scene.ts` (`cameraOffset()`, `viewHalfWidth()`,
     `retro(): RetroSettings`, `hike(): HikeSettings`, `showUnwalkable()`,
     etc.) — the DOM *is* the state, no separate settings object.
   - Glyphs are plain Unicode symbols (⚙ ☀ ✦ ▦ ❖ ≋), never emoji — headless
     Chromium / sparse font stacks draw tofu for emoji.
2. **Map editor**: `src/render/iso3d/editor/panel.ts` (see §5) — actually
   `lil-gui`, plus `localStorage` via `editor/persistence.ts`.

### Shared popover chrome — `menu-group.ts` + `settings-menu.ts`

- `menu-group.ts` (72 lines, pure, tested): `createMenuGroup(): MenuGroup`
  is the one-open-popover-at-a-time state machine. `.add(apply: (open:bool)=>void): MenuHandle`
  (`{isOpen,toggle,open,close}`); outgoing menu is applied `false` **before**
  the incoming is applied `true`. No DOM, no styling — purely a callback
  registry, which is what makes it Node-testable while the panels it governs
  aren't.
- `settings-menu.ts` (118 lines) is the DOM half:
  `createSettingsMenu({glyph,label,group,fontSize}): SettingsMenu` returns
  `{element, panel, handle}`. Popover positioning is **hardcoded**:
  `position:absolute;top:38px;right:0` anchored to the button's own wrapper
  (`position:relative` on `element`), so it always opens inward/left because
  the buttons sit top-right. `max-height:calc(100vh - 90px);overflow-y:auto`.
  Also exports `section(text)` (uppercase heading) and
  `resetButton(tip, widgets: Resettable[])`.
- `weather-controls.ts` (not read in depth) reuses this same
  `createSettingsMenu`/`MenuGroup` shape as its third instance, which is why
  `settings-menu.ts` was extracted (comment: "built once, copied once, third
  time is the moment to lift the shape out").

## 5. lil-gui — exactly one file in the whole repo

`grep -rn "import GUI from 'lil-gui'"` → only
`src/render/iso3d/editor/panel.ts:1`. `buildEditorPanel(opts: EditorPanelOptions): EditorPanel`
(`panel.ts:148`) is the map editor's entire control surface: "no custom UI
framework, no dockable panels" per its own doc comment — binds straight to
one mutable settings object so the frame loop reads live values with nothing
pushed back. Two custom additions on top of bare lil-gui, both raw DOM mounted
*inside* lil-gui's own contents container (to inherit its width/spacing/dark
theme): **button strips** (`buttonStrip<T>()`, `panel.ts:66`, a grid of
buttons for a tool choice, filled in the tool's own cursor colour when armed)
and **visible-groups** (only the armed tool's settings section is shown,
`visibleGroups` from `tools.ts`).

The tuning sandboxes' `buildPanel()` (`src/render/iso3d/movement.ts:655`,
reused unchanged by `debug-view.ts:815`) is **not** lil-gui — another
hand-rolled DOM panel (unit-picker chips + sliders), same style as
`view-controls.ts`.

Studio tab (`src/render/iso3d/studio/view.ts`, 1335 lines) is also plain DOM —
a form (file inputs, buttons, generated cards), no lil-gui, not fullscreen
(scrolls under the tab bar like the sandboxes).

## 6. Retro/pixelation render path — virtual resolution + integer scaling

- **Virtual resolution is real and explicit.** `src/render/iso3d/hike.ts`
  exports `VIRTUAL_SIZES` (`320x180`/`384x216`/`480x270`/`640x360`, all
  16:9), `DEFAULT_VIRTUAL_SIZE = '480x270'`, `virtualSizeById(id)`. The scene
  actually renders three.js into a buffer at this resolution
  (`HikeSettings.virtualWidth/virtualHeight`, read in `scene.ts` around
  line 1477).
- **Integer scaling**: `pixelFrame(cssWidth, cssHeight, devicePixelRatio,
  virtualWidth, virtualHeight): PixelFrame` in
  `src/render/iso3d/view-frame.ts:103` — pure, tested. Computes
  `scale = floor(min(deviceWidth/vw, deviceHeight/vh))` (device pixels per
  virtual pixel, always a whole number ≥ 1), then the shown CSS box
  (`shownWidth/Height = vw*scale/dpr`) and centring `offsetX/offsetY`
  (floored onto the device pixel grid). The canvas is CSS-letterboxed to this
  box; the `<canvas>` element itself has `image-rendering: pixelated`
  (`scene.ts:407`).
- **Separately**, `src/render/iso3d/retro-pass.ts`'s `RetroPass` class draws
  the *already-rendered* scene through a **second**, independently-sized
  low-res render target (`resizeTarget()`, divisor = `pixelSize` setting) and
  a dither/quantize fragment shader (`retro.ts` holds the pure Bayer-matrix
  math this shader mirrors) — this is the "chunky pixel" look, layered on top
  of (not the same mechanism as) the virtual-resolution/integer-scale system.
  `RetroPass.render()` short-circuits to a plain `renderer.render(scene,
  camera)` when filter+grade+palette+ink are all off/identity.
- **HUD does not go through either.** It's DOM, `position:absolute;inset:0`
  over the *full container*, independent of the letterboxed canvas rect —
  confirmed by `hud.ts`'s own doc comment (§2 above). So HUD sizing is not
  virtual-pixel-snapped; it's ordinary CSS px, sized off `hud-layout.ts`'s
  device-class table, not off the render resolution.

## 7. Palette-as-data (spec 102)

- `src/render/iso3d/palette.ts` — `PALETTE` and `TERRAIN_COLORS`: the
  **albedo** colours objects are literally painted, a flat TS `const` object
  of `0xRRGGBB` numbers, imported wherever a mesh material is built. Not
  data-driven at runtime — a source-level constant.
- **Runtime-selectable** palettes (spec 102, "a palette is data") are a
  *different* table: `HIKE_PALETTES` in `hike.ts:99` — `[{id:'none',colors:null},
  {id:'world', colors:[...16 hex ints]}, {id:'eight', colors:[...8 hex ints]}]`,
  each entry a few hue families across a few *lighting values* (not the raw
  albedo — that was tried and destroyed the picture, since lighting sits
  mostly below the albedo range; see the long comment at `hike.ts:76-97`).
  `paletteById(id): readonly number[] | null` (`hike.ts:125`),
  `DEFAULT_PALETTE_ID = 'none'`.
- Format: flat array of `0xRRGGBB` numbers, max 16 entries (GLSL ES 1.00 loop
  bound `MAX_PALETTE=16` in `retro-pass.ts`). Converted to GPU form by pure
  fns in `retro.ts`: `paletteChannels(palette): Float32Array` (0..1 triples)
  and `paletteTextureData(palette): Uint8Array` (RGBA bytes) — uploaded as a
  **one-row `THREE.DataTexture`** (`makePaletteTexture` in `retro-pass.ts`),
  never compiled into GLSL source. `nearestPaletteColor(r,g,b,palette)` and
  `paletteSpacing(palette)` are the pure reference the shader's
  `nearestPaletteColor()` GLSL function mirrors term-for-term.
- Selected via `RetroPass.setPalette(palette | null)`, driven by
  `scene.ts:844: this.retro.setPalette(hike.palette)`, itself read from the
  hike-look popover's dropdown (a `makeTextChoice` in `view-controls.ts`).

## 8. Text rendering — every mechanism, all of them

1. **Ordinary DOM text** — the overwhelming majority: `textContent`/`innerHTML`
   on `<div>`/`<span>`/`<button>`, styled with the browser's system font
   stack (`ui-monospace,Menlo,monospace` or `'Courier New',ui-monospace,monospace`
   or `'Segoe UI',system-ui,sans-serif` depending on file — no single font
   stack constant is shared). Used for: HUD status/notices/hotbar/weapon
   labels, all settings panels, editor panel, studio form, tab bar buttons.
2. **Pixel font, as SVG** — `src/render/iso3d/world/pixel-font.ts`,
   `pixelTextSvg()`. The **only** place this is used is damage numbers in
   `hud.ts:addDamage()` (spec 096) — chosen specifically because system text
   over the posterized/low-res world "read like a debug overlay left
   switched on". Pure data → SVG string → `element.innerHTML`. Not canvas2d,
   not a bitmap/webfont, no fetch.
3. **Inline SVG icons** (not text but adjacent) — `icons.ts` weapon icons,
   same `innerHTML` mechanism, `currentColor` strokes.
4. **Nothing is drawn into the three.js scene or canvas2d as text anywhere**
   in `src/render/` — no `CanvasTexture` + `fillText`, no `TextGeometry`, no
   sprite-sheet font. (Damage numbers *look* like part of the 3D world
   because they're world-anchored/projected DOM, per `damage-popup.ts`, but
   the glyphs themselves are SVG.)

## Open questions for a new framework

- No shared widget layer between `view-controls.ts` (frame-polled getters),
  `weather-controls.ts` (push-on-change into uniforms), `editor/panel.ts`
  (lil-gui bound to a mutable object) and `movement.ts`'s `buildPanel`
  (another bespoke DOM panel) — four different data-binding idioms coexist
  today; a reusable framework would need to pick one (or formalize the
  "widget handle" shape `{row/element, value()/checked(), reset()}` that
  `view-controls.ts` and `settings-menu.ts` already informally share).
- No shared button/panel CSS constants — every file inlines its own hex
  colours (`#1c1c26`, `#182130`, etc.); a design-token layer doesn't exist.
- `hud-layout.ts` is the only place with a device-class abstraction
  (`compact` vs desktop); nothing generalizes it to arbitrary breakpoints.
