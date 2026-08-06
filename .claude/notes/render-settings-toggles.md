# Client settings/toggle system in src/render/

There are **two independent, differently-built** settings panels — do not
conflate them:

1. **Play tab (game view)**: `src/render/iso3d/view-controls.ts` —
   a hand-rolled DOM panel (plain `<label>`/`<input type=range|checkbox>`/`<select>`
   elements built with `document.createElement`), *not* lil-gui. No `localStorage`
   persistence — every session opens at hardcoded defaults; a "Reset" button
   restores each widget's `initial` value.
2. **Map editor tab**: `src/render/iso3d/editor/panel.ts` — actually uses
   `lil-gui` (`import GUI from 'lil-gui'`) and does use `localStorage` via
   `src/render/iso3d/editor/persistence.ts`.

## Play tab panel: `view-controls.ts`

- `createViewControls(opts): ViewControls` builds the cog-button + popover and
  returns getter functions (`cameraOffset()`, `showUnwalkable()`,
  `playerLights()`, `retro()`, `grade()`, `sky()`, etc.) that read the live DOM
  widget state on each call — no separate settings object, the DOM *is* the
  state.
- Widget builders: `makeSlider(label, min, max, step, initial, unit, tip, format?)`,
  `makeCheckbox(label, initial, tip)`, `makeChoice(...)` (numeric `<select>`),
  `makeTextChoice(...)` (string `<select>`). Each returns a small handle object
  (`{ row, value()/checked(), reset() }`) so the panel and the "Reset" button
  can treat every widget uniformly.
- `ViewControlOptions.lighting` (default true) hides the day/night, player-light
  and colour-grade sections in the two tuning sandboxes (`movement.ts`,
  `debug-view.ts`), which pass `lighting: false`.

## End-to-end example: the "Unwalkable terrain" toggle

1. **Declared** — `view-controls.ts:382-383`:
   ```ts
   const unwalkable = makeCheckbox('Unwalkable terrain', false,
     "Toggle the overlay marking tree and bush footprints the unit can't walk onto.");
   ```
   added to the panel under a `Terrain` section (`panel.append(section('Terrain'), unwalkable.row, ...)`).
2. **Exposed** on the `ViewControls` interface: `showUnwalkable(): boolean`,
   implemented as `() => unwalkable.checked()`.
3. **Read** every frame in `src/render/iso3d/world/scene.ts:831`:
   ```ts
   this.unwalkable.visible = this.controls.showUnwalkable();
   ```
   where `this.controls: ViewControls` was constructed via
   `createViewControls(...)` and `this.unwalkable` is a `THREE.Group`
   (`scene.ts:168`) populated by `makeUnwalkableField(vegetationColliders(props), heightAt)`
   (`scene.ts:332-333`, from `../meshes.js`) whenever the world's props change.
4. **Effect on rendering**: purely visibility of a pre-built debug-overlay mesh
   group — no game-outcome branching, consistent with the sim/render split
   (the overlay just visualizes collider data the sim already computed).

Other toggles follow the identical pattern: `torchOn`/`torchShadows`/`magicOn`
(read in `scene.ts` ~900-925 to drive `this.torch`/`this.orb` three.js lights),
`dayNightEnabled()`/`sky()` (drives `applyCycleSun()` vs `applyManualSun()`,
`scene.ts:835`), `retro()` (feeds a post-process pass, `scene.ts:444-445`).

## Related pure modules feeding the panel
- `src/render/iso3d/view-settings.ts` — pure orbit/offset math and
  clamp/zoom helpers (`DEFAULT_CAMERA_ORBIT`, `clampViewHalfWidth`,
  `zoomViewHalfWidth`, `orbitToOffset`/`offsetToOrbit`, `followAlpha`). No DOM,
  headlessly tested (`view-settings.test.ts`).
- `src/render/iso3d/daynight.ts`, `grade.ts`, `player-lights.ts`, `retro.ts` —
  pure settings/state shapes (`SkyState`, `GradeSettings`, `RetroSettings`,
  `TORCH_DEFAULTS`/`MAGIC_DEFAULTS`) the panel's getters assemble from widget
  values; these are the things `scene.ts` actually consumes.

## HUD (`src/render/iso3d/world/hud.ts`)
- Separate from the settings panel: `createHud(): HudHandle` (390 lines) draws
  in-game text/bars (health, cast bars, etc.) reading sim state — not a
  toggle/settings surface itself.
