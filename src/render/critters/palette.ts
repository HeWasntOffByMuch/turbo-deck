/**
 * Player coat colours and the derivation from one picked colour to a full
 * critter colour scheme (spec 055).
 *
 * The player picks **one** colour. Everything else -- the shaded underside, the
 * lit belly, the snout, the patches, the hooves -- is derived from it, which is
 * what keeps customisation to a single click and still guarantees the result is
 * legible. A per-part colour picker would let a player build a pig that is one
 * flat blob at 64 px; this cannot.
 */

import { contrastRatio, ensureContrast, mix, shade, tint } from './color.js';
import { COAT_ROLES, type CoatColors, type CoatRole, type CritterSpecies } from './types.js';

/** One entry in the coat picker. */
export interface CoatSwatch {
  readonly id: string;
  readonly name: string;
  readonly hex: number;
}

/**
 * The twelve player coats: warm, desaturated, cozy. They are close enough in
 * value to sit in one illustration and far enough apart in hue to name across a
 * lobby ("the sage one"), which is what a team colour has to do.
 *
 * Deliberately *all* mid-value. A near-black or near-white coat would break the
 * derived scheme at one end -- there would be no room left to shade or to tint
 * -- and would swamp the species accents that carry the animal's identity.
 */
export const PLAYER_COATS: readonly CoatSwatch[] = [
  { id: 'rose', name: 'Rose', hex: 0xd98f91 },
  { id: 'peach', name: 'Peach', hex: 0xe3a181 },
  { id: 'coral', name: 'Coral', hex: 0xd87872 },
  { id: 'dusty', name: 'Dusty Pink', hex: 0xc9878c },
  { id: 'salmon', name: 'Salmon', hex: 0xd99278 },
  { id: 'mauve', name: 'Mauve', hex: 0xb77e88 },
  { id: 'lavender', name: 'Lavender', hex: 0xa58ca8 },
  { id: 'plum', name: 'Plum', hex: 0x9b7180 },
  { id: 'cream', name: 'Cream', hex: 0xd8b69a },
  { id: 'honey', name: 'Honey', hex: 0xc99a6b },
  { id: 'sage', name: 'Sage', hex: 0x9ba58a },
  { id: 'blue', name: 'Blue', hex: 0x849ba8 },
];

/** How far `coatShade` sits below the coat, and `coatLight` above it. */
const SHADE_AMOUNT = 0.3;
const LIGHT_AMOUNT = 0.22;
/**
 * How far skin (snout, ear lining, udder) is pulled toward the coat. Enough that
 * a sage-green pig has a sage-tinged snout rather than a pink one glued on; not
 * so far that the snout stops being a snout.
 */
const SKIN_TOWARD_COAT = 0.45;

/**
 * Minimum WCAG contrast an accent must hold against the coat it sits on. 1.6 is
 * low by text standards and about right for adjacent flat fills: it is the point
 * at which two blocks of colour stop merging into one shape at 64 px, without
 * forcing every marking to black.
 */
export const MIN_ACCENT_CONTRAST = 1.6;

/** The fallback accents, used for any role a species does not pin itself. */
const DEFAULT_ACCENTS: Record<Exclude<CoatRole, 'coat' | 'coatShade' | 'coatLight'>, number> = {
  skin: 0xe0a49b,
  skinDeep: 0x9a5f5e,
  marking: 0x4a4048,
  horn: 0xd8c9a6,
  hoof: 0x4a4048,
  eye: 0x14121a,
};

/**
 * Resolve a species and a chosen coat into every colour the rig draws.
 *
 * Total by construction: every role in {@link COAT_ROLES} gets a value, so a
 * part can name any role and never fall back to magenta.
 */
export function deriveCoat(species: CritterSpecies, coat: number): CoatColors {
  const colors = {
    coat,
    coatShade: shade(coat, SHADE_AMOUNT),
    coatLight: tint(coat, LIGHT_AMOUNT),
  } as Record<CoatRole, number>;

  for (const role of COAT_ROLES) {
    if (role === 'coat' || role === 'coatShade' || role === 'coatLight') continue;
    const base = species.accents[role] ?? DEFAULT_ACCENTS[role as keyof typeof DEFAULT_ACCENTS];
    // Skin belongs to the same animal as the coat, so it follows it partway;
    // markings, horn, hoof and eye are the animal's own and stay put.
    const toned = role === 'skin' || role === 'skinDeep' ? mix(base, coat, SKIN_TOWARD_COAT) : base;
    colors[role] = ensureContrast(toned, coat, MIN_ACCENT_CONTRAST);
  }
  return colors;
}

/** The swatch matching `hex`, if it is one of the player coats. */
export function swatchFor(hex: number): CoatSwatch | undefined {
  return PLAYER_COATS.find((c) => c.hex === hex);
}

/** Re-exported so callers testing a scheme do not also import `color.js`. */
export { contrastRatio };
