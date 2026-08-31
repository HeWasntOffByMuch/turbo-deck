/**
 * Which client this page is (spec 254).
 *
 * The page deployed to GitHub Pages is the workbench: seven tab buttons across
 * the top of the world, eight tuning popovers down the opposite corner, a
 * diagnostic readout over the grass and a frame-time graph beside it. None of
 * that is the game, and all of it is on before the first frame is drawn.
 *
 * Spec 140 already answered this question once, for a phone -- `ShellTab.game`,
 * `HudLayout.showsTuningMenus` and `HudLayout.showsReadout` are exactly the
 * rules wanted here. What was missing is a way to ask for them: every one of
 * them is reached only through `isHandheldDevice()`, and the frame a *build*
 * offers is a different question from the frame a *device* can drive.
 *
 * So this is `device.ts`'s shape, deliberately: two pure rules and one cached
 * reader over them, because three separate surfaces have to get the same answer
 * or the client is a third of each.
 */

/**
 * What a page carries.
 *
 * `'game'` is the shipped client and nothing else; `'workbench'` also carries
 * the five benches, the tuning popovers and the instrumentation.
 */
export type ClientBuild = 'game' | 'workbench';

/**
 * The build a URL asked for, or null when it asked for nothing.
 *
 * `?client=workbench` is the way back on a built page -- which is what every
 * harness driving `dist/` uses, and what a developer poking at their own build
 * types -- and `?client=game` goes the other way, so the shipped frame can be
 * looked at on a dev server without building. Both directions for spec 230's
 * reason: an override that only argues one way leaves the other frame reachable
 * only by rebuilding.
 *
 * An unrecognised value defers rather than picking a side, exactly as `?frame=`
 * defers to the measurement -- a misspelling costs the override and not the
 * frame.
 */
export function buildOverride(search: string): ClientBuild | null {
  const raw = new URLSearchParams(search).get('client');
  if (raw === null) return null;
  const name = raw.trim().toLowerCase();
  if (name === 'game') return 'game';
  if (name === 'workbench') return 'workbench';
  return null;
}

/**
 * What a build is when nothing asked: a bundle ships the game, a dev server
 * carries the bench.
 *
 * Keyed on whether this is a production bundle rather than on a `VITE_*`
 * variable set in the deploy workflow, so that **the thing CI builds is the
 * thing that ships**. A variable is a thing to forget, and a deploy that
 * differs from `npm run build` is a deploy nothing in the tree ever exercises.
 */
export function buildDefault(prod: boolean): ClientBuild {
  return prod ? 'game' : 'workbench';
}

/**
 * Which client this is. What every caller actually wants.
 *
 * Asked once and remembered, for `isHandheldDevice`'s reason: the tab shell,
 * the settings corner and the HUD have to agree, or the page is a workbench in
 * one corner and a game in another.
 *
 * `import.meta.env` is optional because these modules are also loaded by Node
 * in a test, where a bundler never replaced anything -- absent reads as not a
 * bundle, which is the right answer for a test and for a plain `tsx` run.
 */
let cached: ClientBuild | null = null;
export function clientBuild(): ClientBuild {
  cached ??=
    buildOverride(window.location?.search ?? '') ?? buildDefault(import.meta.env?.PROD === true);
  return cached;
}

/**
 * Whether this page carries the benches and the instrumentation.
 *
 * The one question the three call sites ask, so none of them has to know that a
 * `ClientBuild` has two spellings.
 */
export function showsWorkbenches(): boolean {
  return clientBuild() === 'workbench';
}
