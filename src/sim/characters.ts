/**
 * Selectable movement archetypes (spec 028). A character is nothing but a pair
 * of movement stats — how fast it walks and how fast it can turn — so the two
 * presets feel distinct: one that ambles but pivots slowly, one that is a touch
 * slower in a straight line but whips around almost instantly. The player's
 * `characterIndex` picks the active one; cycling it swaps the feel live.
 */
export interface Character {
  readonly name: string;
  /** Base movement speed in world units/second (before the HoN speed clamp). */
  readonly moveSpeed: number;
  /** Turn rate in degrees/second. */
  readonly turnRate: number;
}

// Speeds are half the original HoN-tuned values (spec 028): the faster pace read
// as too twitchy for the isometric view, so both walk and turn rates were halved.
export const CHARACTERS: readonly Character[] = [
  { name: 'Warden', moveSpeed: 147.5, turnRate: 180 },
  { name: 'Zephyr', moveSpeed: 137.5, turnRate: 450 },
];

export const DEFAULT_CHARACTER_INDEX = 0;

/** The character at `index`, wrapping/falling back to the first for out-of-range. */
export function characterAt(index: number): Character {
  return CHARACTERS[((index % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length] ?? (CHARACTERS[0] as Character);
}
