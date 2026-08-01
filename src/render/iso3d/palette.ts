import type { TerrainMaterial } from '../../terrain/types.js';

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
  // The hooded robe character (spec 046): a muted indigo wool over near-black.
  // `robeVoid` is the shadow inside the hood where a face would be -- the figure
  // deliberately has none.
  robeCloth: 0x615a8c,
  robeDeep: 0x453f68,
  robeLining: 0x8d81bd,
  robeVoid: 0x181523,
  // Bright pip dropped at the click-to-move destination.
  marker: 0xffe08a,
  // Heading arrow (unit facing) and the charging attack cone telegraph.
  heading: 0xffe08a,
  attack: 0xffd27a,
  // Pale dust puff kicked up under the hero's feet while walking.
  poof: 0xf2efe4,
  // Warning red marking an unwalkable terrain footprint (toggleable overlay).
  blocked: 0xd6483f,
  // The arena's walls (spec 037): grey stone, with a lighter lit cap on top.
  wall: 0x6b6b78,
  wallTop: 0x84848f,
} as const;

/**
 * Terrain material colours (spec 043), two tones each. A cell takes one of the
 * pair from a smooth noise field, so a wide expanse of one material is mottled
 * into soft organic patches -- break-up without a texture, and without softening
 * the boundary *between* materials, which stays hard.
 *
 * Tuned warm: a sunlit yellow-green meadow, orange trodden earth, weathered
 * limestone. Cool greens and grey slate read as overcast; these read as a place
 * you would want to walk around in.
 */
export const TERRAIN_COLORS: Record<TerrainMaterial, readonly [number, number]> = {
  water: [0x4ec3d4, 0x3bacc0],
  sand: [0xe8d49c, 0xdcc487],
  // Sunlit meadow: yellow-olive rather than a cool lawn green.
  grass: [0x9dbd4e, 0x86a740],
  // Warm trodden earth -- the orange of a worn path, not brown mud.
  dirt: [0xc8823f, 0xb37034],
  // Warm pale stone, closer to weathered limestone than to grey slate.
  rock: [0xc6bda9, 0xafa693],
  snow: [0xf5f5f0, 0xe3e9e5],
};

/**
 * The stratified stone of a terrain edge: the wall dropped wherever solid ground
 * meets open air, so a coastline or a floating island reads as a solid mass and
 * not a paper cut-out.
 */
export const TERRAIN_CLIFF_COLORS: readonly [number, number] = [0xa89a84, 0x8f8371];

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
