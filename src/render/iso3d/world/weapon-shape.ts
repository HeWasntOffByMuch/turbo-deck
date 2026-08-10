/**
 * What each weapon is shaped like (spec 121).
 *
 * Pure -- no three.js, no DOM -- for the same reason `projectile-shape.ts` is:
 * at the size a body crosses the frame at, the silhouette is the whole
 * difference between "that one has a bow" and "that one has something", and a
 * silhouette carrying that much should be checkable in Node rather than by
 * squinting at a frame. What lives here is where the vertices go; `scene.ts`
 * turns a profile into buffers.
 *
 * Sizes are fractions of the body that holds the weapon, resolved against a
 * height the caller *measured*, never against a constant. A sword is a
 * sword-sized fraction of the person swinging it, and the number that makes
 * that true is the height the body is actually drawn at -- which is not the
 * canonical height in the skeleton document. The pig is authored at 55.65 and
 * drawn 17.9 units tall, so a weapon built against the constant comes out
 * longer than the animal carrying it. Measured, this is right either way.
 */

/** The five silhouettes the item table currently needs. */
export type WeaponKind = 'sword' | 'maul' | 'staff' | 'bow' | 'thrown';

/**
 * Which silhouette an item id draws as, or null to draw nothing.
 *
 * A table with a row per item, in the style of `unit-catalog.ts`, rather than a
 * rule that reads the id's prefix. `sword.keen` parsing as `sword` is right
 * until something is called `greatsword` or `sword_of_dawn`, and a naming rule
 * that breaks silently puts an empty hand on screen with nothing to grep for.
 * An item with no row here is drawn empty-handed, which is visible and is one
 * line to fix.
 */
const KINDS: Readonly<Record<string, WeaponKind>> = {
  'sword.worn': 'sword',
  'sword.keen': 'sword',
  'maul.iron': 'maul',
  'staff.emberwood': 'staff',
  'bow.hunting': 'bow',
  'stars.weighted': 'thrown',
};

export function weaponKindFor(itemId: string): WeaponKind | null {
  return KINDS[itemId] ?? null;
}

/** Every item id that draws something, for a test that checks the table's coverage. */
export function drawableItemIds(): readonly string[] {
  return Object.keys(KINDS);
}

/**
 * One weapon's dimensions, along its own length with the grip at the origin.
 *
 * `+y` runs from the hand towards the business end, so a profile can be built
 * once and pointed wherever the socket points. `gripOffset` is how far *back*
 * from the origin the butt sits: a hand closes around a hilt, not around a
 * blade's midpoint, and getting this wrong is what makes a sword look skewered
 * through the palm.
 */
export interface WeaponProfile {
  readonly kind: WeaponKind;
  /** Hand to tip, not counting whatever hangs below the grip. */
  readonly length: number;
  /** How far the butt of the grip sits below the hand. */
  readonly gripOffset: number;
  /** Half-width of the main shaft/blade, across the swing. */
  readonly shaftRadius: number;
  /**
   * The head: a maul's block, a sword's widening near the guard, a bow's limb
   * span. Zero for a weapon whose silhouette is its shaft alone.
   */
  readonly headLength: number;
  readonly headRadius: number;
  /** Where the head starts, as a fraction of `length` from the grip. */
  readonly headAt: number;
  /**
   * A crossguard's half-span, across the blade. Zero for anything without one.
   *
   * Small and still worth having: it is the one detail that reads as "sword"
   * rather than "stick" at the size this is drawn.
   */
  readonly guardSpan: number;
}

/**
 * Proportions as fractions of the holder's height, which is what keeps them honest.
 *
 * A sword a person can swing is a bit over a third of their height; a staff is
 * most of it; a bow about two thirds. Real proportions for the *lengths*, kept
 * as ratios so any body gets a weapon that looks like it belongs to it.
 *
 * The thicknesses are deliberately not real, for the reason `projectile-shape.ts`
 * gives about arrows: a real blade is a few millimetres thick, which at this
 * camera is under a pixel and disappears entirely once the retro pass has
 * downsampled it. The arrow there is flattened to roughly a 10:1 length-to-width
 * shaft; these are on the same order. Built at honest thickness they were
 * present, correctly placed, correctly sized -- and invisible, which is the one
 * outcome indistinguishable from not having built them at all.
 */
interface WeaponRatios {
  readonly length: number;
  readonly gripOffset: number;
  readonly shaftRadius: number;
  readonly headLength: number;
  readonly headRadius: number;
  readonly headAt: number;
  readonly guardSpan: number;
}

const RATIOS: Readonly<Record<WeaponKind, WeaponRatios>> = {
  sword: {
    length: 0.38,
    gripOffset: 0.05,
    shaftRadius: 0.026,
    headLength: 0,
    headRadius: 0,
    headAt: 1,
    guardSpan: 0.07,
  },
  maul: {
    length: 0.42,
    gripOffset: 0.06,
    shaftRadius: 0.024,
    // The whole point of a maul is the weight at the end, so the head is short
    // and fat rather than long -- a long head reads as an axe.
    headLength: 0.075,
    headRadius: 0.078,
    headAt: 0.82,
    guardSpan: 0,
  },
  staff: {
    length: 0.62,
    gripOffset: 0.22,
    shaftRadius: 0.022,
    headLength: 0.035,
    headRadius: 0.04,
    headAt: 0.93,
    guardSpan: 0,
  },
  bow: {
    length: 0.6,
    // Held at the middle: a bow's grip is its centre, so half of it hangs below
    // the hand. This is the profile where `gripOffset` earns its place.
    gripOffset: 0.3,
    shaftRadius: 0.02,
    headLength: 0,
    headRadius: 0,
    headAt: 1,
    guardSpan: 0,
  },
  thrown: {
    length: 0.06,
    gripOffset: 0.03,
    shaftRadius: 0.045,
    headLength: 0,
    headRadius: 0,
    headAt: 1,
    guardSpan: 0,
  },
};

/**
 * A weapon sized for a body `bodyHeight` units tall.
 *
 * The height is required rather than defaulted, because every default available
 * here is a constant and a constant is the thing that was wrong: the caller has
 * the rig and can measure it.
 */
export function weaponProfile(kind: WeaponKind, bodyHeight: number): WeaponProfile {
  const ratios = RATIOS[kind];
  return {
    kind,
    length: ratios.length * bodyHeight,
    gripOffset: ratios.gripOffset * bodyHeight,
    shaftRadius: ratios.shaftRadius * bodyHeight,
    headLength: ratios.headLength * bodyHeight,
    headRadius: ratios.headRadius * bodyHeight,
    // A fraction of the weapon, not of the body: it stays as authored.
    headAt: ratios.headAt,
    guardSpan: ratios.guardSpan * bodyHeight,
  };
}

export function weaponExtent(profile: WeaponProfile): number {
  return profile.length + profile.gripOffset;
}
