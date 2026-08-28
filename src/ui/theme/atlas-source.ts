/**
 * The chrome, as text (spec 123).
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

/**
 * Item art (spec 127), on its own size.
 *
 * Twelve rather than seven, because these read as *objects* and seven pixels is
 * not enough to tell a sword from a staff -- where `check` and `close` are signs
 * and are perfectly clear at seven. Two sizes is the honest answer; scaling the
 * 7x7 grid up would give a blocky sword and a blurry tick.
 *
 * Authored as text like everything else here, so a new item's art reviews as a
 * diff. `item:unknown` is what an id with no entry draws: a content edit must not
 * be able to crash the interface, and an empty cell where an item is would be a
 * worse lie than a box.
 */
export const ITEM_ICON_SIZE = 12;

export const ITEM_ICONS: Readonly<Record<string, readonly string[]>> = {
  unknown: [
    'WWWWWWWWWWWW',
    'W..........W',
    'W..........W',
    'W...WWWW...W',
    'W...W..W...W',
    'W......W...W',
    'W.....W....W',
    'W.....W....W',
    'W..........W',
    'W.....W....W',
    'W..........W',
    'WWWWWWWWWWWW',
  ],
  sword: [
    '.........TT.',
    '........TTT.',
    '.......TTT..',
    '......TTT...',
    '.....TTT....',
    '....TTT.....',
    '...TTT......',
    '..TTT.......',
    '.ATA........',
    'AAA.........',
    'AA..........',
    '.A..........',
  ],
  // The limb is `T` and the string is `W`, and the string is dead straight.
  // Cost two attempts to get right: an ellipse reads as an egg, and so does an
  // arc whose "string" curves with it -- the eye takes any closed outline as a
  // shape rather than as two objects. A vertical chord is what makes it a bow.
  bow: [
    '......T.....',
    '...TT.W.....',
    '..T...W.....',
    '.T....W.....',
    '.T....W.....',
    'T.....W.....',
    'T.....W.....',
    '.T....W.....',
    '.T....W.....',
    '..T...W.....',
    '...TT.W.....',
    '......T.....',
  ],
  star: [
    '.....TT.....',
    '.....TT.....',
    '....TTTT....',
    '....TTTT....',
    'TTTTTTTTTTTT',
    'TTTTTAATTTTT',
    'TTTTTAATTTTT',
    'TTTTTTTTTTTT',
    '....TTTT....',
    '....TTTT....',
    '.....TT.....',
    '.....TT.....',
  ],
  staff: [
    '.....AA.....',
    '....A..A....',
    '....A..A....',
    '.....AA.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
  ],
  shield: [
    '.TTTTTTTTTT.',
    '.T........T.',
    '.T..TTTT..T.',
    '.T..T..T..T.',
    '.T..TTTT..T.',
    '.T........T.',
    '.T........T.',
    '..T......T..',
    '..T......T..',
    '...T....T...',
    '....T..T....',
    '.....TT.....',
  ],
  focus: [
    '.....TT.....',
    '....TAAT....',
    '...TAAAAT...',
    '..TAAAAAAT..',
    '.TAAAAAAAAT.',
    'TAAAAAAAAAAT',
    'TAAAAAAAAAAT',
    '.TAAAAAAAAT.',
    '..TAAAAAAT..',
    '...TAAAAT...',
    '....TAAT....',
    '.....TT.....',
  ],
  helm: [
    '...TTTTTT...',
    '..TTTTTTTT..',
    '.TTTTTTTTTT.',
    'TTTTTTTTTTTT',
    'TTT......TTT',
    'TT........TT',
    'TT........TT',
    'TTT......TTT',
    'TTTT....TTTT',
    '.TTT....TTT.',
    '.TT......TT.',
    '.TT......TT.',
  ],
  chest: [
    '..TT....TT..',
    '.TTTT..TTTT.',
    'TTTTTTTTTTTT',
    'TTTTTTTTTTTT',
    'TTTT.TT.TTTT',
    'TTTT.TT.TTTT',
    'TTTT.TT.TTTT',
    'TTTT.TT.TTTT',
    'TTTTTTTTTTTT',
    'TTTTTTTTTTTT',
    '.TTTTTTTTTT.',
    '..TTTTTTTT..',
  ],
  legs: [
    '.TTTTTTTTTT.',
    '.TTTTTTTTTT.',
    '.TTTTTTTTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
    '.TTTT..TTTT.',
  ],
  trinket: [
    '....TTTT....',
    '...T....T...',
    '...T....T...',
    '....T..T....',
    '.....TT.....',
    '....TAAT....',
    '...TAAAAT...',
    '..TAAAAAAT..',
    '..TAAAAAAT..',
    '...TAAAAT...',
    '....TAAT....',
    '.....TT.....',
  ],
  /**
   * A sigil (spec 188): a carried skill.
   *
   * A disc with a mark cut through it rather than a scroll or a book, because
   * every other icon in this table is a *thing you hold* and a skill has to
   * read as one too -- and because a rune stamped in metal is the only shape at
   * twelve pixels that says "this does something" without saying which. Which
   * one it is, is the name in the tooltip and the slot it sits in.
   */
  sigil: [
    '....TTTT....',
    '..TTAAAATT..',
    '..TAAAAAAT..',
    '.TAAAWWAAAT.',
    '.TAAWWWWAAT.',
    'TAAAAWWAAAAT',
    'TAAAAWWAAAAT',
    '.TAAWWWWAAT.',
    '.TAAAWWAAAT.',
    '..TAAAAAAT..',
    '..TTAAAATT..',
    '....TTTT....',
  ],
  potion: [
    '....TTTT....',
    '....T..T....',
    '....T..T....',
    '...T....T...',
    '..T......T..',
    '..T.AAAA.T..',
    '..T.AAAA.T..',
    '.T..AAAA..T.',
    '.T.AAAAAA.T.',
    '.T.AAAAAA.T.',
    '..T.AAAA.T..',
    '...TTTTTT...',
  ],
};

/**
 * Ability art (spec 128), on the item size.
 *
 * The same twelve pixels, because a skill slot and an inventory cell are the
 * same box and a player looks at both in the same glance -- two sizes of object
 * art would read as two art styles. Its own namespace so `item:sword` and
 * `ability:slash` can never collide.
 *
 * Each of these has to read at a glance *while something is trying to kill you*,
 * which is a harder bar than an inventory icon and is why they lean on
 * silhouette rather than detail: a wedge, a ring, a crack.
 */
export const ABILITY_ICON_SIZE = ITEM_ICON_SIZE;

export const ABILITY_ICONS: Readonly<Record<string, readonly string[]>> = {
  /** A swing: three strokes of an arc, thickest in the middle. */
  slash: [
    '.........TT.',
    '......TTTT..',
    '....TTTT....',
    '...TTT......',
    '..TTT.......',
    '..TT........',
    '.TT.........',
    '.TT.........',
    '..T.........',
    '..TT........',
    '...TT.......',
    '....TTT.....',
  ],
  /** A heavy blow: a maul head coming down. */
  heavy: [
    '..TTTTTTTT..',
    '.TTTTTTTTTT.',
    '.TTTTTTTTTT.',
    '.TTTTTTTTTT.',
    '..TTTTTTTT..',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '.....TT.....',
    '....AAAA....',
    '....AAAA....',
  ],
  /** An arcane bolt: an orb with a tail. */
  bolt: [
    '.........AA.',
    '........AAAA',
    '.......AAAA.',
    '......AAAA..',
    '.....AAAA...',
    '....AAAA....',
    '...AAAA.....',
    '..AAAA......',
    '.TAAA.......',
    'TTAA........',
    'TT..........',
    'T...........',
  ],
  /** A lobbed pot: a flask with an arc over it. */
  lob: [
    '.....T......',
    '...TT.......',
    '..T.........',
    '.T..........',
    '.T..........',
    '....TTTT....',
    '...T....T...',
    '..T.AAAA.T..',
    '.T.AAAAAA.T.',
    '.T.AAAAAA.T.',
    '..T.AAAA.T..',
    '...TTTTTT...',
  ],
  /** A seeking bolt: a dart that has turned. */
  seek: [
    '.........TTT',
    '.........TTT',
    '........TTT.',
    '.......TTT..',
    '......TTT...',
    '.....TTT....',
    '....TTT.....',
    '...TTT......',
    '..TTT.......',
    '.TTT...AAA..',
    'TTT...AAAAA.',
    'TT....AAAAA.',
  ],
  /** A quake: ground with a crack through it. */
  quake: [
    '............',
    '............',
    '.....T......',
    '....T.......',
    '.....T......',
    '......T.....',
    '.....T......',
    'TTTTTTTTTTTT',
    'TTTT.TT.TTTT',
    'TT..T....T.T',
    'T..........T',
    '............',
  ],
  /** A mend: a cross, the one sign nobody has to learn. */
  mend: [
    '....SSSS....',
    '....SAAS....',
    '....SAAS....',
    'SSSSSAASSSSS',
    'SAAAAAAAAAAS',
    'SAAAAAAAAAAS',
    'SSSSSAASSSSS',
    '....SAAS....',
    '....SAAS....',
    '....SAAS....',
    '....SSSS....',
    '............',
  ],
  /** A drain: a funnel with something falling into it. */
  drain: [
    'TT........TT',
    '.TT......TT.',
    '..TT....TT..',
    '...TT..TT...',
    '....TTTT....',
    '.....TT.....',
    '.....TT.....',
    '....AAAA....',
    '...AAAAAA...',
    '...AAAAAA...',
    '....AAAA....',
    '.....AA.....',
  ],
  /**
   * The four active skills (specs 188, 196).
   *
   * Drawn rather than borrowed, and the reason is what the bar looked like
   * without them: `abilityIconFor` answers `item:unknown` for an id with no row,
   * so every skill a player equipped and the flask beside them came out as the
   * same question mark. A bar of four identical boxes is worse than a bar with
   * no art at all, because it looks like art.
   *
   * Each leans on silhouette rather than detail, for the reason the eight above
   * do: these are read at a glance while something is trying to kill you.
   */
  /** Guard break: a shield with a split down it. */
  guardBreak: [
    '.TTTTTTTTTT.',
    '.T...AA...T.',
    '.T...AA...T.',
    '.T..AA....T.',
    '.T...AA...T.',
    '.T....AA..T.',
    '.T...AA...T.',
    '..T..AA..T..',
    '..T...AA.T..',
    '...T.AA.T...',
    '....T..T....',
    '.....TT.....',
  ],
  /** Stunning blow: an impact, struck out in every direction. */
  stunningBlow: [
    '..T.......T.',
    '...T.AA..T..',
    '.T..AAAA.T..',
    '..T.AAAA..T.',
    '...AAAAAA...',
    'TTAAAAAAAATT',
    'TTAAAAAAAATT',
    '...AAAAAA...',
    '..T.AAAA..T.',
    '.T..AAAA.T..',
    '...T.AA..T..',
    '..T.......T.',
  ],
  /** Whirlwind: a sweep all the way round, open where it began. */
  whirlwind: [
    '...TTTTTT...',
    '..TTTTTTTT..',
    '.TTT....TTT.',
    'TTT......TTT',
    'TT........TT',
    'TT..........',
    'TT..........',
    'TTT......AA.',
    '.TTT....AAAA',
    '..TTTTTAAAAA',
    '...TTTT.AAA.',
    '.........A..',
  ],
  /** Crippling strike: a limb, snapped. */
  cripplingStrike: [
    '.TT.........',
    'TTTT........',
    '.TTTT.......',
    '..TTTT......',
    '...TTT......',
    '....AA......',
    '......AA....',
    '......TTT...',
    '.......TTTT.',
    '........TTTT',
    '........TTTT',
    '.........TT.',
  ],
  /** Poison dart: a needle, and what runs off it. */
  poisonDart: [
    '.........TTT',
    '........TTTT',
    '.......TTTT.',
    '......TTTT..',
    '.....TTTT...',
    '....TTTT....',
    '...TTTT.....',
    '..TTTT......',
    '.TTT........',
    '..A.........',
    '.AAA........',
    '..A.........',
  ],
  /** Rending cut: three gashes, torn the same way. */
  rendingCut: [
    '..T...T...T.',
    '.TT..TT..TT.',
    '.TT..TT..TT.',
    'TT..TT..TT..',
    'TT..TT..TT..',
    'TT..TT..TT..',
    'TT..TT..TT..',
    'AA..AA..AA..',
    '.A...A...A..',
    '.A...A...A..',
    '.A...A...A..',
    '............',
  ],
  /** Acid spray: a spout, and the drops coming off it. */
  acidSpray: [
    'TT..........',
    'TTT.........',
    'TTTT........',
    '.TTTT..AA...',
    '..TTTT.AA...',
    '...TTTT.....',
    '....TTT..AA.',
    '.....TT..AA.',
    '......T.....',
    '.......AA...',
    '.......AA...',
    '............',
  ],
  /** Arc lash: a bolt with a tail behind it. */
  arcLash: [
    '.......TTT..',
    '......TTT...',
    '.....TTT....',
    '....TTT.....',
    '...TTTTTT...',
    '..TTTTTTT...',
    '.....AAA....',
    '....AAA.....',
    '...AAA......',
    '..AAA.......',
    '.AAA........',
    'AA..........',
  ],
  /** Blight: a spreading blot, reaching out. */
  blight: [
    '.T........T.',
    '..T..TT..T..',
    '...TTTTTT...',
    '..TTTTTTTT..',
    '.TTTAATTTTT.',
    'TTTTAATTTTTT',
    'TTTTTTTAATTT',
    '.TTTTTTAATT.',
    '..TTTTTTTT..',
    '...TTTTTT...',
    '..T..TT..T..',
    '.T........T.',
  ],
  /** Ember toss: a flame, thrown along an arc. */
  emberToss: [
    '.......A....',
    '......AAA...',
    '.....AAAAA..',
    '....AAAAAAA.',
    '....AAAAAAA.',
    '.....AAAAA..',
    '......AAA...',
    '...T........',
    '..T.........',
    '.T..........',
    'T...........',
    'T...........',
  ],
  /** Rime touch: frost, out from one point. */
  rimeTouch: [
    '..T..TT..T..',
    '...T.TT.T...',
    '....TTTT....',
    '.T..TAAT..T.',
    '..TTAAAATT..',
    'TTTTAAAATTTT',
    'TTTTAAAATTTT',
    '..TTAAAATT..',
    '.T..TAAT..T.',
    '....TTTT....',
    '...T.TT.T...',
    '..T..TT..T..',
  ],
  /**
   * Scorched earth (spec 223): a ring of ground with fire standing on it.
   *
   * The one skill sprite here that draws a *place* rather than a blow. Which is
   * what it has to do: every other cell on the bar is a thing you do to a body,
   * and this one is somewhere a body cannot be. The ring is `T` so the ground
   * reads at 12px, and the flames are `A` because accent is what the whole set
   * uses for the part that is actually happening.
   */
  scorchedEarth: [
    '......A.....',
    '.....AA.....',
    '..A..AA..A..',
    '.AA.AAAA.AA.',
    '.AA.AAAA.AA.',
    '..A.AAAA..A.',
    '..TTTTTTTT..',
    '.TT......TT.',
    'TT........TT',
    'TT........TT',
    '.TT......TT.',
    '..TTTTTTTT..',
  ],
  /**
   * Conjure Light (spec 250): a lamp, radiating.
   *
   * The one skill glyph in the set that is neither a blow nor a place, and it
   * has to look like neither. The mass is a solid `A` disc in the middle with
   * four `T` rays off the diagonals -- so at 12px the silhouette is a *star*,
   * which nothing else here is: Scorched Earth above it is a bowl, Rime Touch
   * is a cross of frost with a square core, and Ember Toss is a lobbed mass.
   *
   * The rays are on the diagonals rather than on the axes because the axes are
   * where a 12px grid's rays land on the same row as the disc's own edge, which
   * reads as a fat plus sign rather than as light coming off something.
   */
  conjureLight: [
    'T....TT....T',
    '.T...TT...T.',
    '..T..TT..T..',
    '....AAAA....',
    '...AAAAAA...',
    'TTT.AAAA.TTT',
    'TTT.AAAA.TTT',
    '...AAAAAA...',
    '....AAAA....',
    '..T..TT..T..',
    '.T...TT...T.',
    'T....TT....T',
  ],
  /**
   * The test skill (spec 196 on main): a checklist.
   *
   * It is a developer path and it still needs art, because the alternative is
   * the question mark -- and a bar that draws one is a bar that looks broken
   * whether the slot is a real skill or a switch somebody threw.
   */
  testStatuses: [
    'TTTTTTTTTTTT',
    'T..........T',
    'T.AA.TTTTT.T',
    'T.AA.......T',
    'T..........T',
    'T.AA.TTTTT.T',
    'T.AA.......T',
    'T..........T',
    'T.AA.TTTTT.T',
    'T.AA.......T',
    'T..........T',
    'TTTTTTTTTTTT',
  ],
};
