/**
 * The fixed, deliberately limited colour palette for the isometric 3D scene
 * (spec 018). Flat blocks of these colours only -- no gradients, no textures.
 * Kept together so the whole look can be retuned in one place.
 */
export const PALETTE = {
  sky: 0x8fd6c8,
  // Ground reads as two mowed-grass greens; foliage stacks a few more.
  grassLight: 0x7fae3f,
  grassDark: 0x5f8f33,
  water: 0x3fb6c8,
  waterDeep: 0x2f8fa8,
  trunk: 0x8a4a2a,
  trunkDark: 0x6f3a20,
  // Layered foliage greens, dark at the base to bright at the crown.
  leafDeep: 0x2f5a2a,
  leafMid: 0x3f7a33,
  leafBright: 0x6fae3f,
  bush: 0x4f8a37,
  bushBright: 0x6fae4a,
  // The little bird-like hero: navy body, red wing, pale beak.
  heroBody: 0x2a2a4a,
  heroWing: 0xc0392b,
  heroBeak: 0xf0e6c8,
  // Enemies, one hue each so types read at a glance.
  enemyBrawler: 0xc9683f,
  enemySkitter: 0x5fb4d6,
  enemyBrute: 0x9a5ad0,
  enemyEye: 0x1a1208,
  // The player-controlled mech in the movement sandbox (a friendly steel blue).
  mechAlly: 0x4a7fb0,
  // The grey metal walker unit in the movement sandbox (a rotating turret on legs).
  walkerBody: 0x969ba4,
  // Bright pip dropped at the click-to-move destination.
  marker: 0xffe08a,
  // Heading arrow (unit facing) and the charging attack cone telegraph.
  heading: 0xffe08a,
  attack: 0xffd27a,
  // Pale dust puff kicked up under the hero's feet while walking.
  poof: 0xf2efe4,
} as const;

/** Enemy body colour by sim type key, falling back to a neutral tone. */
export function enemyColor(type: string): number {
  switch (type) {
    case 'brawler':
      return PALETTE.enemyBrawler;
    case 'skitter':
      return PALETTE.enemySkitter;
    case 'brute':
      return PALETTE.enemyBrute;
    default:
      return 0xc07070;
  }
}
