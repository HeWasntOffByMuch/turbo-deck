/**
 * Switches that take one contributor out of the frame, for measuring
 * (spec 165 follow-up 9).
 *
 * The frame submits ~625 draw calls and is CPU-bound rather than fill-bound --
 * halving the shaded pixels bought nothing. So the question is which objects
 * those draws belong to, and the honest way to answer it is the way the `ink`
 * measurement was answered: take one thing out, read the counter, put it back.
 * A profiler would say the same thing less directly and only on one machine.
 *
 * `?perf=noshadow,noprops` in the same register as `?seed=`, `?wire=` and
 * `?slots=` -- a harness affordance, off unless asked for, and never a game
 * rule. Nothing here changes what the sim does; it changes what is drawn, which
 * is why it is a measuring tool and not a setting.
 *
 * Pure: a string in, four booleans out.
 */

export interface PerfFlags {
  /** The sun stops casting, which removes the shadow map's geometry pass. */
  readonly noShadow: boolean;
  /** The prop field is hidden -- every tree, bush and fence. */
  readonly noProps: boolean;
  /** The terrain surface and its walls are hidden. */
  readonly noTerrain: boolean;
  /**
   * The shadow maps are redrawn every frame, as they were before follow-up 10.
   *
   * The one flag here that puts work *back*: it is how the change-driven rebuild
   * is measured against what it replaced, on the same machine, in the same
   * scene, without checking out the old code.
   */
  readonly eagerShadow: boolean;
  /** Whether any flag is set, so the readout can say the frame is not the real one. */
  readonly any: boolean;
}

const NONE: PerfFlags = {
  noShadow: false,
  noProps: false,
  noTerrain: false,
  eagerShadow: false,
  any: false,
};

/**
 * Read `?perf=` as a comma-separated list.
 *
 * Unknown names are ignored rather than refused: this is a measuring tool driven
 * by hand and by a probe, and a typo that silently measures the baseline is a
 * better failure than one that refuses to load the page.
 */
export function parsePerfFlags(search: string): PerfFlags {
  const raw = new URLSearchParams(search).get('perf');
  if (raw === null || raw === '') return NONE;
  const names = new Set(raw.split(',').map((name) => name.trim().toLowerCase()));
  const flags = {
    noShadow: names.has('noshadow'),
    noProps: names.has('noprops'),
    noTerrain: names.has('noterrain'),
    eagerShadow: names.has('eagershadow'),
  };
  return {
    ...flags,
    any: flags.noShadow || flags.noProps || flags.noTerrain || flags.eagerShadow,
  };
}
