/**
 * The numbers the VFX probe's two halves have to agree on (spec 118).
 *
 * A file of its own because the page (`probe.ts`) mounts itself on import -- it
 * is an entry point, and touching `document` at module scope is the point of it
 * -- so a Node script that imported a constant from there would run the page and
 * crash. Which is exactly what happened.
 *
 * The alternative was to copy the palette into the script. That is the version
 * where the two drift, the script starts checking membership against a list the
 * page no longer uses, and it keeps passing.
 */

/** The virtual buffer the probe renders into. */
export const PROBE_VIRTUAL_W = 240;
export const PROBE_VIRTUAL_H = 150;

/** Device pixels per virtual pixel, applied by CSS. */
export const PROBE_SCALE = 4;

/**
 * A deliberately tiny palette, so "is this pixel on the palette" is a sharp
 * question. The game's own palettes are wider; a wide one would let a stray
 * colour land near an entry by luck and pass.
 */
export const PROBE_PALETTE = [0x101018, 0x2f3540, 0x8a4a2a, 0xffb347, 0xfff6df, 0x5f8f33];

/** The sky and the ground, so the script can tell "the effect" from the scene. */
export const PROBE_BACKGROUND = 0x101018;
export const PROBE_GROUND = 0x2f3540;
