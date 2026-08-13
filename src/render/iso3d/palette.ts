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
  // The small spider (spec 152), body and legs the same colour. A dark slate
  // violet rather than 0x000000, for two reasons: every material here is a
  // Lambert, so a pure black body multiplies the sun out and loses its own
  // facets -- it becomes a hole rather than a round thing -- and the violet in
  // it is what stops a near-black body on dark ground from reading as a gap in
  // the world. Tuned in the movement sandbox against the real grass.
  enemySpider: 0x3d3846,
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
  // The two lights the player carries (spec 047). Warm flame against cool
  // conjured light, so which one is lit reads at a glance; the `core` tones are
  // the unlit meshes at each light's centre, near-white so they hold their glow
  // against a night sky the rest of the palette has gone dim against.
  torchFlame: 0xffa542,
  torchCore: 0xffe9a8,
  magicOrb: 0x9fd8ff,
  magicCore: 0xe8f6ff,
  // Thrown weapons (spec 087). A conjured shot stays the pale magic core above;
  // these are objects, so they are wood, steel and a dyed feather -- the point
  // being that an arrow crossing the frame reads as a *thing* and not as light.
  arrowShaft: 0x9a7442,
  arrowHead: 0xd3d9df,
  arrowFletch: 0xbc4a3c,
  shurikenSteel: 0xb4bfca,
  // The streak a shuriken leaves. Cooler and paler than the plate, so the trace
  // reads as air rather than as more metal.
  shurikenTrace: 0xdce8f4,
  // Warning red marking an unwalkable terrain footprint (toggleable overlay).
  blocked: 0xd6483f,
  // The arena's walls (spec 037): grey stone, with a lighter lit cap on top.
  wall: 0x6b6b78,
  wallTop: 0x84848f,
  // Fences (spec 058). Sawn timber sits a shade lighter and greyer than a living
  // trunk, so a paddock rail reads as built rather than grown; the drystone
  // courses borrow the terrain's warm limestone so a wall belongs to its ground.
  post: 0x8f6438,
  plank: 0xb0854c,
  // Two more timber tones, for the palisade whose boards are meant to look
  // gathered rather than milled: one sun-bleached, one weathered grey.
  plankPale: 0xc49f68,
  plankGrey: 0x8d7a5a,
  drystone: 0xbdb4a1,
  // A cooler and a warmer stone, so a rubble wall is not one grey.
  drystonePale: 0xcfc7b4,
  drystoneWarm: 0xb3a58c,
  // Fired brick in three tones and the mortar behind it (spec 060). A real wall
  // is never one colour -- the batch variation is most of what says "brick"
  // before any single brick is big enough on screen to be read as one.
  brick: 0xa8543c,
  brickDark: 0x8c4331,
  brickPale: 0xc06a4a,
  // Darker than the brick around it, so a joint reads as a shadow between
  // bricks rather than as a pale line drawn over them.
  mortar: 0x8e857a,
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
 *
 * Keyed on the material of the ground *above* the wall (spec 123), because one
 * pair cannot serve both jobs a skirt now does. The single warm pair this used
 * to be was authored for a coastline, where the ground above is sand and the
 * cut below it should read as the same beach in shadow. A rock formation's tier
 * is the same geometry doing something else entirely: a slab of stone standing
 * out of a meadow, which wants cool grey and not weathered limestone.
 *
 * Doing it by material rather than by a field on the layer is what keeps the
 * document out of it -- no `MAP_VERSION` bump, no migration, no protocol
 * change -- and it is the more honest answer anyway. What a cut edge looks like
 * is a fact about what the ground is made of.
 */
export const TERRAIN_CLIFF_COLORS: Record<TerrainMaterial, readonly [number, number]> = {
  // A cut through water is the lake bed, not the water.
  water: [0x6f6a5a, 0x5d594c],
  sand: [0xa89a84, 0x8f8371],
  // Earth under turf: the dark of a cut bank, with the meadow's warmth in it.
  grass: [0x7a6a4e, 0x685a43],
  dirt: [0x8a6338, 0x76542f],
  // Cool grey slate. The `rock` surface above it is deliberately warm pale
  // stone; a tier's face is the freshly broken side of the same mass and reads
  // colder, which is most of what makes a formation look like rock and not
  // like a plateau of sand.
  rock: [0x8d949c, 0x767d86],
  snow: [0xbcc2c8, 0xa6adb5],
};

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
