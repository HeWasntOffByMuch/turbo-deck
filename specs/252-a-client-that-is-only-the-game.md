# 252 — A client that is only the game

## Problem

The page deployed to GitHub Pages is the workbench. A player who opens it gets
seven tab buttons across the top of the world (six of which lead to a map
editor, two sandboxes and three authoring tools), eight tuning popovers stacked
down the opposite corner, a diagnostic readout written in the browser's own type
over the grass, and a frame-time graph with a draw-call counter under it. None
of that is the game, and all of it is on before the first frame is drawn.

Spec 140 already answered this question once, for a phone: a coarse pointer is
offered the game and nothing else, because the benches cannot be driven with a
finger. The rules it wrote are exactly the rules wanted here — `ShellTab.game`,
`HudLayout.showsTuningMenus`, `HudLayout.showsReadout` — and every one of them
is reached only through `isHandheldDevice()`. So the machinery exists and there
is no way to ask for it: the frame a *build* offers is a different question from
the frame a *device* can drive, and only the second one can be asked.

## Shape

```ts
// src/render/iso3d/client-build.ts — beside device.ts, and the same three parts.

/**
 * `'game'` is the shipped client; `'workbench'` also carries the benches and
 * the instrumentation.
 */
export type ClientBuild = 'game' | 'workbench';

/** What the URL asked for, or null when it asked for nothing. */
export function buildOverride(search: string): ClientBuild | null;

/** What a build is when nothing asked: a bundle ships the game, a dev server the bench. */
export function buildDefault(prod: boolean): ClientBuild;

/** What every caller actually wants. Asked once and remembered. */
export function showsWorkbenches(): boolean;
```

`showsWorkbenches()` is `buildOverride(location.search) ?? buildDefault(import.meta.env?.PROD === true)`
mapped to a boolean, and it is `isHandheldDevice()`'s shape for
`isHandheldDevice()`'s reason: three separate surfaces have to get the same
answer or the client is a third of each, and asking once is what makes that a
property rather than a habit.

`import.meta.env.PROD` rather than a `VITE_*` variable set in the workflow, so
that the thing CI builds *is* the thing that ships — a variable is a thing to
forget, and a deploy that differs from `npm run build` is a deploy nothing
tests. `?client=workbench` is the way back on a built page, in the register
`?frame=`, `?perf=` and `?seed=` are already in, and `?client=game` goes the
other way so the shipped frame can be looked at without building. An
unrecognised value defers to the build, exactly as `?frame=` defers to the
measurement.

Three consequences, each at the one line that already decides it:

- **The benches.** `visibleTabs(tabs, gameOnly)` — the parameter renamed from
  `compact`, because it now has two reasons and the filter must stay one. `main.ts`
  passes `isHandheldDevice() || !showsWorkbenches()`. `showsTabButtons` then
  draws no strip, since one tab is not a choice.
- **The tuning popovers.** `tuningMenusShown(layout, workbenches)` in
  `hud-layout.ts`, beside `readoutShown` and for its stated reason: both halves
  are rules, and the first one is already written down in that file.
- **The readout.** `readoutWanted` starts at `showsWorkbenches()` rather than
  `true`. Started rather than forbidden: `debug.toggleStats` still reaches it,
  so a player who is asked for numbers can produce them, and the compact rule
  above it is untouched.

The frame-time meter is the fourth thing on screen and is not part of that
answer, because it is a **persisted preference** rather than a frame: a build
that decided it would either be overridden by `writeField`, which stamps the
default into every profile that changes any other display setting, or would have
to refuse a setting the player had explicitly ticked. So `DEFAULT_SHOW_FPS`
becomes `false` — what an unwritten profile means, in both builds. The Display
page's *Show frame rate* keeps working and keeps persisting, which is the whole
of what a shipped game owes a frame counter.

That is only safe because the meter stops being the thing that publishes its own
numbers conditionally: `fps-overlay.ts` **always writes its `data-fps-*`
attributes and only ever hides the pixels**, which is the rule `hud.ts` has
followed for the diagnostic readout since spec 094 (*"it is always written"*).
Today three probes read those attributes and work only because the preference
happens to default on — so a developer who unticked the box broke
`probe-frame-cost`, `probe-sim-cost` and `probe-world-lights` silently. Making
the write unconditional fixes that as well as making the default safe to move.

## Invariants tested

- `?client=game` answers `'game'` and `?client=workbench` answers `'workbench'`,
  whichever way the build was compiled.
- An absent, empty or unrecognised `client` is `null`, so a misspelling costs the
  override and not the frame; `?client=` and `?client=prod` both defer.
- The value is read case-insensitively and trimmed, like `?frame=` and `?perf=`.
- Other parameters are not disturbed: `?seed=4&client=game` still answers
  `'game'`, and `?seed=4` alone answers `null`.
- `buildDefault(true)` is `'game'` and `buildDefault(false)` is `'workbench'`.
- `visibleTabs(tabs, true)` leaves exactly the tabs marked `game`, and the
  existing phone rules are unchanged — including that a list with no game in it
  is returned whole rather than emptied.
- `showsTabButtons(visibleTabs(TABS, true))` is false, so the game build draws
  no tab strip.
- `tuningMenusShown` is false in the game build on a desktop layout, false on a
  compact layout whatever the build, and true only for a workbench build on a
  desktop layout.
- `readoutShown` is unchanged, and the compact layout still hides the readout
  whatever the toggle says.
- `DEFAULT_SHOW_FPS` is false, and a profile that explicitly stored `true` still
  reads back `true`.
- The overlay publishes `data-fps-value`, `data-fps-draw-calls` and
  `data-fps-triangles` on a frame it was told not to show.

## Out of scope

- **Removing the benches from the bundle.** The tabs are hidden, not code-split:
  `mount` already accepts a promise (spec 203) so a dynamic import would work,
  but `check:bundle` sums every emitted chunk rather than the entry, so it would
  measure exactly the same bytes and buy nothing the ceiling can see. A separate
  spec, with a measurement in front of it.
- **The `?perf=`, `?seed=`, `?slots=`, `?units=`, `?map=`, `?wire=` and
  `?field=` switches.** They are things a person types, not things the frame
  offers, and none of them is visible until somebody does.
- **The options window.** Every row in it is a player setting and stays; only
  the *default* of one of them moves.
- **The workflow.** `deploy-pages.yml` runs `npm run build`, which is now the
  game client, so there is nothing to add — which is the point of deciding this
  on `import.meta.env.PROD` rather than on a variable.
