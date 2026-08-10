/**
 * The chrome, as text (spec 121).
 *
 * There is no `ui-atlas.png` and there is not going to be one. Nothing in this
 * client is fetched, and a painted texture is a binary blob that reviews as
 * "changed" and nothing else. So the 9-slice frames and the icons are grids of
 * characters, each character naming a palette slot, and `ui/render/atlas.ts`
 * bakes them into one RGBA buffer at startup.
 *
 * Two consequences worth knowing. Retuning the whole interface is a palette edit
 * in `theme.json` rather than a repaint, because the art stores slot names and
 * not colours. And a frame is *hollow*: the middle character is `.` throughout,
 * so a widget draws its fill with `drawSolid` and its frame over the top. That
 * is what lets one `raised` patch serve a button in five states instead of five
 * near-identical patches, and it is why the atlas is small enough to hand-author
 * at all.
 *
 * Pure. No DOM, no clock, no colours -- only names.
 */

/**
 * A 9-slice patch.
 *
 * `rows` are the art; `border` says how many pixels on each side are corner and
 * must not stretch. The middle row and column are what get repeated to fill,
 * so they must be uniform along the axis they stretch on -- one pixel each is
 * both the simplest and the crispest, and every patch here uses one.
 */
export interface PatchSource {
  readonly rows: readonly string[];
  readonly border: number;
}

/** `.` is transparent. Every other character is an index into this. */
export const PATCH_PALETTE: Readonly<Record<string, string>> = {
  L: 'edgeLight',
  D: 'edgeDark',
  S: 'shadow',
  I: 'ink',
  P: 'panel',
  R: 'panelRaised',
  U: 'panelSunken',
  A: 'accent',
  F: 'focus',
  T: 'text',
  W: 'textDim',
};

/**
 * The frames. Three by three plus a one-pixel stretchable middle, so each is 3x3
 * of corner and one row/column of edge: nine characters wide is a 3px border on
 * both sides and 3 of middle, which no patch needs. One pixel of middle it is.
 */
export const PATCHES: Readonly<Record<string, PatchSource>> = {
  /** A plain 1px outline, hollow. The quietest thing that reads as an edge. */
  frame: {
    rows: [
      'LLL',
      'L.L',
      'LLL',
    ],
    border: 1,
  },
  /**
   * Lit from the top left. A button that has not been pressed.
   *
   * The bevel is two colours rather than one because a single-colour outline
   * reads as a box and a two-colour one reads as a *surface* -- which is the
   * whole vocabulary a flat pixel UI has for "this is pressable".
   */
  raised: {
    rows: [
      'LLD',
      'L.D',
      'DDD',
    ],
    border: 1,
  },
  /** The same bevel inverted: pressed, or a field you type into. */
  sunken: {
    rows: [
      'DDL',
      'D.L',
      'LLL',
    ],
    border: 1,
  },
  /**
   * Two pixels thick, in the accent: the one place the visual direction spends
   * its boldness (window title bars, the active tab). Five by five, because a
   * 2px border on both sides plus one stretchable pixel is exactly that.
   */
  heavy: {
    rows: [
      'AAAAA',
      'ADDDA',
      'AD.DA',
      'ADDDA',
      'AAAAA',
    ],
    border: 2,
  },
  /** The focus ring. Drawn outside a widget's own frame, never instead of it. */
  focusRing: {
    rows: [
      'FFF',
      'F.F',
      'FFF',
    ],
    border: 1,
  },
};

/**
 * Icons, as fixed-size sprites rather than patches.
 *
 * Deliberately few: the brief's visual direction is "legibility beats ornament",
 * and every icon here earns its place by being a thing a widget cannot draw with
 * a rect. A checkbox's tick is one; a scrollbar's thumb is not.
 */
export const ICON_SIZE = 7;

export const ICONS: Readonly<Record<string, readonly string[]>> = {
  check: [
    '.......',
    '......T',
    '.....T.',
    'T...T..',
    '.T.T...',
    '..T....',
    '.......',
  ],
  close: [
    '.......',
    '.T...T.',
    '..T.T..',
    '...T...',
    '..T.T..',
    '.T...T.',
    '.......',
  ],
  chevronDown: [
    '.......',
    '.......',
    '.......',
    'T.....T',
    '.T...T.',
    '..T.T..',
    '...T...',
  ],
  chevronUp: [
    '...T...',
    '..T.T..',
    '.T...T.',
    'T.....T',
    '.......',
    '.......',
    '.......',
  ],
  /** The resize corner. Three steps, reading as a diagonal without a diagonal. */
  grip: [
    '.......',
    '......T',
    '.....T.',
    '....T.T',
    '...T.T.',
    '..T.T.T',
    '.......',
  ],
  dot: [
    '.......',
    '.......',
    '..TTT..',
    '..TTT..',
    '..TTT..',
    '.......',
    '.......',
  ],
};
