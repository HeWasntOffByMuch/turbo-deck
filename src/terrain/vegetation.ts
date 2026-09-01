import { Rng } from '../shared/prng.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../shared/world.js';
import { PLAYER_RADIUS } from '../sim/constants.js';
import type { Circle, Vec2 } from '../sim/types.js';
import { worldMaterialAt } from './classify.js';
import type { TerrainWorld } from './types.js';
import { arenaBounds } from './world.js';

/**
 * Where the world's trees and bushes stand (spec 018/043/044).
 *
 * This used to be renderer-side decoration. It is world data now: since spec 044
 * a trunk blocks a unit and turns a hunter's path, so the sim and the renderer
 * have to be looking at the *same* list -- a tree that is drawn but not blocked
 * (or blocked but not drawn) is a bug either way. It lives here, beside the
 * terrain it grows on, and stays pure: seeded PRNG only, no DOM and no three.js,
 * so the same (seed, world) always yields the same arrangement and the whole
 * thing is unit-testable in Node.
 */

/**
 * What a prop is. Trees and bushes are scattered over an area; the two fences
 * are laid along a path, one tile per prop (spec 058); the two structures are
 * put down one at a time, where somebody pointed (spec 224).
 */
export type PropKind =
  | 'tree'
  | 'bush'
  | 'fence-wood'
  | 'fence-boards'
  | 'fence-brick'
  | 'fence-rubble'
  | 'house'
  | 'well'
  | 'campfire'
  | 'lamp-post'
  | 'torch-stand'
  | 'sign'
  | 'grave';

/**
 * The kinds that are a length of fence rather than a plant: a regular one and a
 * rough one in each material -- picket and boards in timber, brick and rubble in
 * stone (spec 058, 059, 060).
 */
export const FENCE_KINDS = ['fence-wood', 'fence-boards', 'fence-brick', 'fence-rubble'] as const;
export type FenceKind = (typeof FENCE_KINDS)[number];

export function isFenceKind(kind: PropKind): kind is FenceKind {
  return (FENCE_KINDS as readonly string[]).includes(kind);
}

/**
 * The kinds that are a building rather than a plant or a boundary (spec 224).
 *
 * A hut to make a village out of and a well to put in the middle of it. They are
 * grouped for one reason: neither is *painted*. A tree is scattered by density
 * and a fence is laid along a path, and a building goes in one spot, turned to
 * face a square -- so the editor gives them a press-to-place tool of their own
 * and this is the list it offers.
 *
 * A sign is the third (spec 260), and it belongs here rather than beside the
 * fixtures for the same one reason: it goes in **one spot somebody chose**,
 * turned to face the road it is read from. That is the whole membership test of
 * this list, and it is why a thing that emits no light and holds nobody's roof
 * up is still grouped with a hut.
 *
 * A grave is the fourth (spec 263), and it is the first member that is not
 * something a village *built* -- which changes nothing about how it is placed,
 * and that is the point. It passes the same membership test: a plot goes in one
 * spot somebody chose, turned to face the path it is walked up to from, so it
 * takes the press-to-place tool rather than the scatter's density brush. A
 * graveyard is a layout, not a distribution.
 *
 * Appended, never inserted. `PROP_GROUPS` enumerates this list and
 * {@link FIXTURE_KINDS} in order across a thread boundary, so a kind inserted
 * ahead of another would hand the worker's matrices to the wrong geometry --
 * both halves come out of one build, so what this really forbids is a *stored*
 * index, and there is none: a document names a species by string.
 */
export const STRUCTURE_KINDS = ['house', 'well', 'sign', 'grave'] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

export function isStructureKind(kind: PropKind): kind is StructureKind {
  return (STRUCTURE_KINDS as readonly string[]).includes(kind);
}

/**
 * The kinds that emit light (spec 250).
 *
 * A fire on the ground, a lamp on a stake, and a torch in a stand. They are
 * `PropKind`s and nothing else, which is the whole design: a fixture is written
 * into the map document, streamed, collided against, batched per region and
 * taken out by the eraser without one line of any of those asking what kind a
 * prop is. That is spec 224's sentence about the hut and the well, one system
 * further along.
 *
 * They are grouped for the reason the buildings are: neither is *painted*. A
 * tree is scattered by density and a fence laid along a path, and a lamp goes in
 * one spot somebody chose -- so they share the buildings' press-to-place tool
 * rather than getting one of their own.
 *
 * Appended, never inserted. `PROP_GROUPS` enumerates this list across a thread
 * boundary, so a kind that moved would hand the worker's matrices to the wrong
 * geometry.
 */
export const FIXTURE_KINDS = ['campfire', 'lamp-post', 'torch-stand'] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export function isFixtureKind(kind: PropKind): kind is FixtureKind {
  return (FIXTURE_KINDS as readonly string[]).includes(kind);
}

/**
 * What the press-to-place tool offers: a building or a fixture.
 *
 * One list rather than two, because the editor asks one question -- *what am I
 * putting down here* -- and a second dropdown beside the first would be the
 * panel describing this file's type hierarchy instead of the choice a person is
 * making.
 */
export const PLACED_KINDS = [...STRUCTURE_KINDS, ...FIXTURE_KINDS] as const;
export type PlacedKind = (typeof PLACED_KINDS)[number];

export function isPlacedKind(kind: string): kind is PlacedKind {
  return (PLACED_KINDS as readonly string[]).includes(kind);
}

/**
 * The hut's plan at scale 1, in world units, along its own local axes: the
 * ridge runs down `width`, and the front wall faces `depth`.
 *
 * Here beside the kinds rather than in either of the two modules that want it,
 * for the reason {@link FENCE_TILE_LENGTH} is: the renderer builds the walls
 * from it and `FOOTPRINT_BASE` derives the collider from it, and if those two
 * ever disagree the game gets a building you can stand inside or an invisible
 * wall around one.
 *
 * Sized against the body it has to look right next to -- a unit is about 56 tall
 * and 32 across -- so this is roughly four and a half bodies wide and a little
 * under two tall to the eaves. Small enough that a handful make a village rather
 * than a city block.
 */
export const HOUSE_PLAN = { width: 148, depth: 124 } as const;

/**
 * The well's kerb radius at scale 1: what you cannot walk through, and what the
 * renderer builds the stonework out of.
 *
 * A little over half a hut across. Smaller and it reads as a bucket from the
 * height this camera sits at, which is where the first cut of it landed.
 */
export const WELL_RADIUS = 44;

/**
 * The sign's board and the post under it, at scale 1, in world units (spec 260).
 *
 * Here beside the kinds rather than in the renderer, for {@link HOUSE_PLAN}'s
 * reason: `FOOTPRINT_BASE` derives the collider from `postWidth` and the
 * renderer builds the board from the other three, and the client's pick volume
 * is `postHeight + height` tall. Four numbers in three files that have to agree
 * about one object.
 *
 * Sized against the body that reads it -- a unit is about 56 tall -- so the
 * board's underside sits at chest height and its top a little over head height:
 * high enough to be a sign rather than a stump, low enough that it does not
 * read as a gallows at this camera's bearing.
 */
export const SIGN_PLAN = {
  /** The board, across the face somebody reads it from. */
  width: 84,
  /** The board, top to bottom. */
  height: 34,
  /** How far the post carries the board's *underside* off the ground. */
  postHeight: 62,
  /** The post, square in plan. Also what a body cannot walk through. */
  postWidth: 12,
} as const;

/**
 * The grave's plan at scale 1, in world units, along its own local axes: the
 * headstone stands across `stoneWidth` and the plot runs away down `moundLength`
 * (spec 263).
 *
 * Here beside the kinds rather than in the renderer, for {@link HOUSE_PLAN}'s
 * and {@link SIGN_PLAN}'s reason: `FOOTPRINT_BASE` derives the collider from the
 * stone's two plan dimensions and the renderer builds all three parts from the
 * six, and two files disagreeing about a grave is a headstone somebody can stand
 * inside or an invisible wall around a patch of earth.
 *
 * Sized against the body that walks up to it -- a unit is about 56 tall -- so
 * the stone comes to roughly chest height on somebody standing over it. That
 * bound is the design and not a preference: a marker taller than the person
 * reading it stops being a grave and becomes a monument, which is a different
 * prop with a different reason to exist.
 */
export const GRAVE_PLAN = {
  /** The headstone, across the face it is read from. */
  stoneWidth: 40,
  /** The headstone, ground to top. Chest height on a body, and no more. */
  stoneHeight: 44,
  /** The headstone, front to back. Also what a body cannot walk through. */
  stoneThickness: 10,
  /** The mound, from the foot of the stone out along the plot. */
  moundLength: 88,
  /** The mound, across the plot. Wider than the stone, so the plot reads as
   *  something the stone was put at the head of rather than as a path up to it. */
  moundWidth: 52,
  /** How far the mound stands proud of the ground it was dug out of. */
  moundHeight: 17,
} as const;

/**
 * The longest message a sign may carry, in characters (spec 260).
 *
 * A bound rather than a style guide, and it is enforced by the parser: a `str`
 * on the wire is length-prefixed and a map is a file somebody may hand-edit, so
 * "how much text can one prop put on the wire" has to have an answer that is not
 * *whatever was typed*. 240 is about four lines in the bubble at
 * `BUBBLE_WIDTH`, which is as much as anybody is going to read standing in a
 * field.
 */
export const MAX_SIGN_TEXT = 240;

/**
 * The words on this prop, or **null** for a sign with nothing on it.
 *
 * One answer with three callers -- the editor deciding whether it has anything
 * to place, the client deciding whether a sign is worth offering to read, and
 * the parser deciding what to store -- for the reason {@link footprintRadius} is
 * one: a blank-but-present string and an absent one are the same sign, and three
 * files each deciding that separately agree until one is edited.
 *
 * Trimmed and bounded rather than trusted, because it arrives from a document
 * somebody may have hand-edited. A kind that is not a sign never has a message,
 * whatever its record says: an intent a kind does not read is inert rather than
 * an error, which is the rule `light` on a hut already follows.
 */
export function signText(prop: Prop): string | null {
  if (prop.kind !== 'sign') return null;
  const raw = prop.text;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_SIGN_TEXT ? trimmed.slice(0, MAX_SIGN_TEXT) : trimmed;
}

/**
 * How long one fence tile runs, in world units at scale 1.
 *
 * The load-bearing number of the whole fence design, which is why it lives here
 * beside the kinds rather than in either of the two modules that need it. A tile
 * is drawn spanning exactly this much along its own +X, and the fence tool lays
 * tiles exactly this far apart -- so a run butts up seamlessly and the renderer
 * never has to know that a tile has neighbours. If the geometry and the spacing
 * ever disagree, a fence grows either gaps or overlaps at every junction.
 */
export const FENCE_TILE_LENGTH = 48;

export interface Prop {
  readonly kind: PropKind;
  /** Position on the sim ground plane, in world units. */
  readonly x: number;
  readonly y: number;
  /** Uniform size multiplier applied to the base mesh. */
  readonly scale: number;
  /** Y-axis spin (radians) so identical meshes don't look stamped. */
  readonly rotation: number;
  /** Small per-instance foliage tint offset, in [-1, 1]. */
  readonly tint: number;
  /**
   * Lie the prop along the ground instead of standing it upright (spec 051).
   *
   * The *intent*, not the resulting tilt. A stored normal would go stale the
   * moment the ground under the prop is sculpted, so the renderer re-resolves
   * this against the terrain every time it builds the field -- exactly as a
   * prop's height already is. Absent means upright, so the generated forest is
   * unaffected.
   */
  readonly alignToNormal?: boolean;
  /**
   * Draw this prop in one flat colour per material instead of its varied tones
   * (spec 061).
   *
   * The *intent*, like `alignToNormal` beside it: which tone a part ends up
   * with is the renderer's business, and this only says whether it may vary at
   * all. Absent means varied, so nothing already saved changes and the
   * generated forest is untouched.
   */
  readonly uniform?: boolean;
  /**
   * What this fixture burns at, overriding its kind's authored row (spec 250).
   *
   * Absent is {@link FIXTURE_LIGHTS}, so a fixture placed at the defaults stores
   * nothing extra and a retune of the table reaches every one already standing
   * on every map. Ignored by a kind that emits nothing, exactly as `align` is
   * ignored by a kind that cannot lie down: an intent a kind does not read is
   * inert rather than an error, which is what keeps `Prop` one shape.
   */
  readonly light?: PropLight;
  /**
   * What this sign says (spec 260).
   *
   * Absent by default, so no committed map gains a key, no region file's bytes
   * move and no `mapId` does either -- `light` beside it for the same reason.
   * Ignored by every kind but `sign`, exactly as `light` is ignored by a kind
   * that emits nothing: reading it goes through {@link signText}, which answers
   * null for anything else whatever the record holds.
   *
   * The words are here, on the prop, rather than in a table keyed by something:
   * a sign's whole content *is* its position plus its sentence, so a table would
   * be a second file to keep in step with a map for no gain. It is also why a
   * sign is the one prop whose interesting field a person can honestly edit in
   * `maps/arena.json` by hand.
   */
  readonly text?: string;
}

/** What a fixture burns at. Two numbers, and the two the editor sets. */
export interface PropLight {
  /**
   * Illuminance at half {@link radius}.
   *
   * The unit `pointIntensity` already means, so the two controls stay
   * independent: without that definition a reach slider is a second brightness
   * slider, because intensity for a given apparent brightness goes as the
   * *square* of the range.
   */
  readonly brightness: number;
  /** Reach, in world units. */
  readonly radius: number;
}

/** A fixture's light, resolved: its kind's row with any instance override on top. */
export interface ResolvedLight extends PropLight {
  /** Packed RGB. A fixture's colour is its kind's and is not per instance. */
  readonly color: number;
  /** How far above the ground the flame sits, at scale 1. */
  readonly height: number;
}

/**
 * The bounds a fixture's two numbers are held within (spec 250).
 *
 * Shared by the editor's sliders and by `parseMap`, so a document cannot carry a
 * light nobody could have set and the panel cannot offer one the document would
 * refuse. The reach band is `player-lights.ts`'s own -- the same span the tuning
 * panel spends its torch over -- because a fixture and a carried flame are the
 * same kind of light and having two answers to "how far does a light reach"
 * would be two answers to one question.
 */
export const MIN_FIXTURE_BRIGHTNESS = 0;
export const MAX_FIXTURE_BRIGHTNESS = 6;
export const MIN_FIXTURE_RADIUS = 80;
export const MAX_FIXTURE_RADIUS = 900;

/**
 * What each fixture burns at, before anybody drags a slider.
 *
 * Authored per kind rather than per instance because a campfire is a campfire:
 * the *point* of a table is that placing forty of them and then deciding they
 * are all too dim is one edit here rather than forty in a map document.
 *
 * The colours are the two `player-lights.ts` already burns at plus one: a fire
 * is the torch's flame, and a street lamp is a shade paler and cooler, because a
 * lamp is a made thing with a mantle in it and reading identically to an open
 * fire is what would make the two fixtures indistinguishable at this camera's
 * distance.
 *
 * **None of them casts a shadow**, and that is a look decision rather than a
 * budget one -- which is worth saying because the budget went the other way.
 * A fixture's shadow map is affordable: `world-lights.ts` baked it on the frame
 * the light was assigned a slot and never again, so it cost a `samplerCube` and
 * one lookup per lit fragment and nothing per frame, and the probe measured the
 * draw count flat with four of them lit.
 *
 * It was cut because of what it *looked* like. A point light a body's height off
 * the ground throws every trunk, fence post and body near it outward in a hard
 * radial fan -- `BasicShadowMap`, so each edge is a step rather than a gradient
 * -- and four fixtures in a square throw four of those fans across each other.
 * The light is what says a fire is there; the shadows said something nobody
 * wanted.
 *
 * There is no `shadow` field any more, and the whole bake path went with it:
 * the pool's casting prefix, the cube-map setup, the one-bake-a-frame queue, the
 * revision stamp that re-took a map when its ground arrived late, and the mask
 * that kept moving bodies out of a frozen one. A socket with nothing plugged
 * into it is the thing this repo keeps finding a hundred specs later, and
 * putting it back is one revert.
 */
/**
 * The one thing about `height` that is not obvious, and it decides more than
 * `brightness` does: **the ground is not facing the light.**
 *
 * `brightness` is illuminance at half reach *on a surface facing the flame*,
 * which is what `pointIntensity` means and what makes the reach slider
 * independent of the brightness one. Ground is horizontal, so what lands on it
 * at distance `d` is scaled by the grazing angle `height / hypot(height, d)` --
 * a tenth for a flame a body's-height up seen from two hundred units, half for
 * one carried twice as high. So two fixtures at the same brightness light the
 * ground quite differently, and the pool a designer sees is always smaller than
 * the reach they set.
 *
 * `npx tsx scripts/preview-fixtures.ts` prints exactly this, per kind, at four
 * distances and against both the day and the night ambient -- because a pool
 * dimmer than the ambient is a light nobody can see is on, and that threshold is
 * three times further out at midnight than at noon.
 */
export const FIXTURE_LIGHTS: Readonly<Record<FixtureKind, ResolvedLight>> = {
  // Wide and warm and low.
  //
  // The light sits in the *middle of the flame* rather than in the embers: 22 is
  // where the cone starts and 34 is halfway up it, and the difference is not
  // presentation -- at 22 the grazing angle costs a campfire a third of the pool
  // it is authored to throw, which reads as a fire that does not light the
  // ground it is standing on.
  campfire: { color: 0xffa542, brightness: 2.2, radius: 420, height: 34 },
  // Higher than a body and reaching further than either of the others, which is
  // what a street lamp is for: it lights a path rather than a spot.
  'lamp-post': { color: 0xffd9a0, brightness: 1.5, radius: 520, height: 122 },
  // The carried torch, standing still: the same colour and the same reach, so a
  // player who plants one and one who holds one get the same light.
  'torch-stand': { color: 0xffa542, brightness: 1.6, radius: 300, height: 78 },
};

/** A number held inside the fixture bounds, total by construction. */
function clampLight(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * The light a prop emits, or **null** for one that emits none.
 *
 * The one answer to "does this thing glow, and how", with three callers: the
 * worker composing a region, the editor drawing its ghost, and the panel
 * offering the sliders. One description, for the reason `footprintRadius` is
 * one: a ring the editor draws and a light the renderer hangs are the same
 * fixture, and two files deriving it separately agree until one is edited.
 *
 * The override is clamped rather than trusted, because it arrives from a
 * document somebody may have hand-edited, and a NaN radius is a light that
 * paints nothing anywhere with no error to go looking for.
 */
export function fixtureLight(prop: Prop): ResolvedLight | null {
  if (!isFixtureKind(prop.kind)) return null;
  const base = FIXTURE_LIGHTS[prop.kind];
  const override = prop.light;
  if (!override) return base;
  return {
    ...base,
    brightness: clampLight(
      override.brightness,
      MIN_FIXTURE_BRIGHTNESS,
      MAX_FIXTURE_BRIGHTNESS,
      base.brightness,
    ),
    radius: clampLight(override.radius, MIN_FIXTURE_RADIUS, MAX_FIXTURE_RADIUS, base.radius),
  };
}

export interface ScatterOptions {
  /** How many trees to place. */
  readonly trees: number;
  /** How many bushes to place. */
  readonly bushes: number;
  /** No prop is placed within this radius of any keep-out point. */
  readonly keepOutRadius: number;
  /** No prop is placed within this radius of any already-placed prop. */
  readonly spacing: number;
  /** Inset from the arena edge so nothing clips the border. */
  readonly margin: number;
}

/** The size band a scattered prop is drawn from: `MIN + u * SPAN`. */
const MIN_PROP_SCALE = 0.75;
const PROP_SCALE_SPAN = 0.75;
const MAX_PROP_SCALE = MIN_PROP_SCALE + PROP_SCALE_SPAN;

const DEFAULTS: ScatterOptions = {
  trees: 14,
  bushes: 20,
  keepOutRadius: 160,
  spacing: 70,
  margin: 60,
};

const UNIT = 1 << 24;

/** Draw a float in [0, 1) from the immutable Rng, returning the advanced Rng. */
function nextUnit(rng: Rng): [number, Rng] {
  const [n, next] = rng.nextInt(0, UNIT - 1);
  return [n / UNIT, next];
}

function farEnough(x: number, y: number, points: readonly Vec2[], minDist: number): boolean {
  const min2 = minDist * minDist;
  for (const p of points) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy < min2) return false;
  }
  return true;
}

/**
 * Place trees then bushes across the `width` x `height` ground plane, avoiding
 * every `keepOut` point (e.g. the player spawn) and crowding onto each other.
 * Rejection sampling with a bounded attempt budget: deterministic, and it
 * simply stops early rather than looping forever on a dense arena.
 */
export function scatterProps(
  seed: number,
  width: number,
  height: number,
  keepOut: readonly Vec2[],
  options: Partial<ScatterOptions> = {},
): Prop[] {
  const opt = { ...DEFAULTS, ...options };
  let rng = Rng.fromSeed(seed);
  const props: Prop[] = [];
  const placed: Vec2[] = [];

  const place = (kind: PropKind, count: number): void => {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 24; attempt++) {
        let ux: number, uy: number, us: number, ur: number, ut: number;
        [ux, rng] = nextUnit(rng);
        [uy, rng] = nextUnit(rng);
        [us, rng] = nextUnit(rng);
        [ur, rng] = nextUnit(rng);
        [ut, rng] = nextUnit(rng);
        const x = opt.margin + ux * (width - 2 * opt.margin);
        const y = opt.margin + uy * (height - 2 * opt.margin);
        if (!farEnough(x, y, keepOut, opt.keepOutRadius)) continue;
        if (!farEnough(x, y, placed, opt.spacing)) continue;
        props.push({
          kind,
          x,
          y,
          scale: 0.8 + us * 0.6,
          rotation: ur * Math.PI * 2,
          tint: ut * 2 - 1,
        });
        placed.push({ x, y });
        break;
      }
    }
  };

  place('tree', opt.trees);
  place('bush', opt.bushes);
  return props;
}

/**
 * Ground-footprint radius a prop blocks: what the unwalkable overlay draws
 * (spec 034) and, since spec 044, what the sim collides against.
 */
const FOOTPRINT_BASE: Record<PropKind, number> = {
  tree: 24,
  bush: 16,
  // Half a tile, so the circles of a run overlap into one continuous barrier
  // rather than leaving a walkable gap between every pair of posts. A fence is
  // thinner than it is long and a circle cannot say so; erring wide is the side
  // that keeps a wall a wall.
  'fence-wood': FENCE_TILE_LENGTH / 2,
  'fence-boards': FENCE_TILE_LENGTH / 2,
  'fence-brick': FENCE_TILE_LENGTH / 2,
  'fence-rubble': FENCE_TILE_LENGTH / 2,
  // The plan's **circumradius**, so every corner of the building is inside the
  // circle and there is no way to stand in one (spec 224). That is the fence's
  // own rule -- a rectangle is not a circle and erring wide is the side that
  // keeps a wall a wall -- and the cost is stated rather than hidden: the circle
  // reaches about 30 units past the middle of each flat face, so a body stops
  // roughly two of its own radii short of the wall there. A building somebody
  // can stand in the corner of is the worse of the two.
  house: Math.hypot(HOUSE_PLAN.width, HOUSE_PLAN.depth) / 2,
  // A well *is* a circle, so this one is exact.
  well: WELL_RADIUS,
  // The fixtures (spec 250). A fire is a ring of stones you walk round rather
  // than through, and the two poles are poles: wide enough that a body cannot
  // stand inside the thing it is looking at, and no wider, because a lamp with a
  // hut's collider is an invisible wall down a street.
  campfire: 34,
  'lamp-post': 11,
  'torch-stand': 10,
  // The post, and the post only (spec 260). The board is a metre of air at
  // chest height that a body walks under without noticing -- blocking its whole
  // span would be an invisible wall either side of a stick, and would put the
  // reach a player has to get inside *behind* the thing they are reading.
  sign: SIGN_PLAN.postWidth / 2,
  // The headstone, and only the headstone (spec 263) -- the sign's rule applied
  // to the other half of an object. The mound is loose earth a stride high, and
  // a circle wide enough to cover the plot would take a body and a half of
  // walkable ground out of the world around every grave, which in a graveyard is
  // most of the graveyard. It would also put the reach a player has to get
  // inside *behind* the thing they came to look at.
  //
  // The stone's own circumradius, which is the hut's rule: a rectangle is not a
  // circle and erring wide is the side that keeps a wall a wall. It costs almost
  // nothing here, a slab being thin enough that its corner is barely past its
  // own face.
  grave: Math.hypot(GRAVE_PLAN.stoneWidth, GRAVE_PLAN.stoneThickness) / 2,
};
/**
 * Fallback for a kind this build has no footprint for -- a map written by a
 * newer build, or a half-updated module graph in a dev server.
 *
 * The number matters less than it not being `undefined`: unguarded, the lookup
 * makes the radius **NaN**, and NaN spreads. A NaN footprint disc gives the
 * walkability overlay NaN vertices, which takes the whole overlay off screen; a
 * NaN collider radius makes every distance test against it false. Both fail by
 * showing nothing, which reads as "the prop was never placed" and sends you
 * looking in the wrong place entirely.
 */
const FALLBACK_FOOTPRINT = 16;

export function footprintRadius(prop: Prop): number {
  return (FOOTPRINT_BASE[prop.kind] ?? FALLBACK_FOOTPRINT) * (Number.isFinite(prop.scale) ? prop.scale : 1);
}

/** The props as sim obstacles: one circle per footprint (spec 044). */
export function vegetationColliders(props: readonly Prop[]): Circle[] {
  return props.map((prop) => ({ x: prop.x, y: prop.y, r: footprintRadius(prop) }));
}

export interface BoundsScatterOptions {
  readonly trees: number;
  readonly bushes: number;
  /**
   * Clear ground left between two props' footprints. The rejection rule is
   * `distance >= footprint(a) + footprint(b) + walkGap`, so it scales with the
   * props being placed rather than being one flat number for all of them.
   */
  readonly walkGap: number;
  /** How many grove centres the props are drawn toward. */
  readonly clusters: number;
  /** How far from its centre a grove's members land. */
  readonly clusterRadius: number;
  /** Fraction of props placed anywhere at all, as lone trees between the groves. */
  readonly strays: number;
  /** Placement attempts per prop before giving up on it. */
  readonly attempts: number;
}

/**
 * Trees enough to make a forest rather than an orchard (spec 045). The old 460
 * over a 4400x4100 world was one tree per ~39,000 square units -- an average
 * spacing near 200 against a crown radius of 34, so no two crowns ever met.
 *
 * `walkGap` is a body's width: two trunks are never left closer together than a
 * unit can walk between. That is *stricter* than the flat 76 it replaces, which
 * let two full-grown trees (footprint 36 apiece) stand 4 units apart and wall
 * the ground off. Scaling to the props being placed is what lets a grove of
 * saplings pack in tight while the big ones keep their room.
 */
const BOUNDS_DEFAULTS: BoundsScatterOptions = {
  trees: 2200,
  bushes: 600,
  walkGap: 2 * PLAYER_RADIUS,
  clusters: 150,
  clusterRadius: 260,
  strays: 0.2,
  attempts: 40,
};

/** A prop already standing: where it is and how much ground it takes. */
interface Placed {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

/**
 * The props placed so far, bucketed into square cells so a candidate only has
 * to be tested against its neighbours.
 *
 * Worth the machinery at this density: the old scatter compared each of 800
 * candidates against every prop already down, and at 2100 props with 16
 * attempts apiece that quadratic sweep is tens of millions of distance tests
 * every time a scene is built. The cell is sized to the largest separation any
 * pair can demand, so a 3x3 neighbourhood is guaranteed to hold every prop that
 * could possibly conflict.
 */
class PlacementGrid {
  private readonly cells = new Map<number, Placed[]>();

  constructor(private readonly cellSize: number) {}

  private key(col: number, row: number): number {
    // Both coordinates fit a signed 16-bit cell index over any plausible world.
    return ((col & 0xffff) << 16) | (row & 0xffff);
  }

  /** True when nothing nearby is closer than the two footprints plus `gap`. */
  clearFor(x: number, z: number, radius: number, gap: number): boolean {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(z / this.cellSize);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const bucket = this.cells.get(this.key(col + dc, row + dr));
        if (!bucket) continue;
        for (const p of bucket) {
          const need = radius + p.r + gap;
          const dx = x - p.x;
          const dz = z - p.z;
          if (dx * dx + dz * dz < need * need) return false;
        }
      }
    }
    return true;
  }

  add(x: number, z: number, radius: number): void {
    const key = this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
    const bucket = this.cells.get(key);
    if (bucket) bucket.push({ x, z, r: radius });
    else this.cells.set(key, [{ x, z, r: radius }]);
  }
}

/**
 * Cell size for the placement grid: the widest separation the rejection rule
 * can ask for, so a candidate never conflicts with a prop more than one cell
 * away. Two of the largest trees the scatter can grow, plus the gap.
 */
function placementCellSize(walkGap: number): number {
  const widest = Math.max(...Object.values(FOOTPRINT_BASE)) * MAX_PROP_SCALE;
  return 2 * widest + Math.max(0, walkGap);
}

/**
 * Scatter decoration over an arbitrary rectangle, keeping only the points a
 * caller-supplied predicate accepts -- which is how vegetation ends up on the
 * meadows and the low slopes and stays off cliffs, water and the arena floor,
 * without this module knowing anything about terrain.
 *
 * Placement is **clustered**, not uniform. Uniform rejection sampling over an
 * area this large is the reason the world reads as an orchard: every prop is
 * about the same distance from its neighbours, so there are no groves and no
 * clearings, just an even sprinkle. Instead, grove centres are drawn across the
 * bounds and each prop picks one and lands near it, with a minority scattered
 * anywhere at all so single trees still stand in the open.
 *
 * A prop redraws its grove on every attempt, so a centre that landed in the sea
 * or on a cliff costs that prop a try rather than swallowing it -- the predicate
 * and the clustering stay independent, and this module still knows nothing
 * about terrain. The attempt budget is what bounds the work: a hostile
 * predicate makes it place fewer props, never loop forever.
 *
 * Pure and deterministic: seeded PRNG only, so the same (seed, bounds,
 * predicate) always yields the same arrangement.
 */
export function scatterInBounds(
  seed: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  canPlace: (x: number, z: number) => boolean,
  options: Partial<BoundsScatterOptions> = {},
): Prop[] {
  const opt = { ...BOUNDS_DEFAULTS, ...options };
  let rng = Rng.fromSeed(seed);
  const props: Prop[] = [];
  const placed = new PlacementGrid(placementCellSize(opt.walkGap));
  const width = maxX - minX;
  const depth = maxZ - minZ;

  // Grove centres, drawn up front so every prop is choosing from the same set
  // and the groves come out shared between trees and bushes -- undergrowth
  // belongs under the canopy, not in the gaps between stands.
  const centres: Vec2[] = [];
  for (let i = 0; i < Math.max(1, opt.clusters); i++) {
    let cx: number, cz: number;
    [cx, rng] = nextUnit(rng);
    [cz, rng] = nextUnit(rng);
    centres.push({ x: minX + cx * width, y: minZ + cz * depth });
  }

  const place = (kind: PropKind, count: number): void => {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < opt.attempts; attempt++) {
        let uc: number, ua: number, ud: number, us: number, ur: number, ut: number, ustray: number;
        [uc, rng] = nextUnit(rng);
        [ua, rng] = nextUnit(rng);
        [ud, rng] = nextUnit(rng);
        [us, rng] = nextUnit(rng);
        [ur, rng] = nextUnit(rng);
        [ut, rng] = nextUnit(rng);
        [ustray, rng] = nextUnit(rng);

        let x: number;
        let z: number;
        if (ustray < opt.strays) {
          x = minX + uc * width;
          z = minZ + ua * depth;
        } else {
          const centre = centres[Math.min(centres.length - 1, Math.floor(uc * centres.length))] as Vec2;
          // `ud * ud` rather than `sqrt(ud)`: a disc sampled uniformly by area
          // puts most points near its rim, which draws rings rather than
          // groves. Squaring pulls the mass into the middle instead.
          const distance = ud * ud * opt.clusterRadius;
          const angle = ua * Math.PI * 2;
          x = centre.x + Math.cos(angle) * distance;
          z = centre.y + Math.sin(angle) * distance;
          if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
        }

        const prop: Prop = {
          kind,
          x,
          y: z,
          scale: MIN_PROP_SCALE + us * PROP_SCALE_SPAN,
          rotation: ur * Math.PI * 2,
          tint: ut * 2 - 1,
        };
        // Grid first, predicate second: the grid is a handful of distance tests
        // against one 3x3 neighbourhood, while the predicate samples the
        // terrain, and inside a saturated grove most candidates fail the grid.
        const radius = footprintRadius(prop);
        if (!placed.clearFor(x, z, radius, opt.walkGap)) continue;
        if (!canPlace(x, z)) continue;
        props.push(prop);
        placed.add(x, z, radius);
        break;
      }
    }
  };

  // Interleaved rather than all the trees and then all the bushes. Placed in
  // sequence the trees saturate every grove first and the undergrowth has
  // nowhere left to stand -- it ends up only in the clearings, which is exactly
  // backwards. Alternating in proportion lets both claim room in the same pass.
  const total = opt.trees + opt.bushes;
  let treesLeft = opt.trees;
  let bushesLeft = opt.bushes;
  for (let i = 0; i < total; i++) {
    const wantsTree = treesLeft > 0 && (bushesLeft <= 0 || treesLeft * opt.bushes >= bushesLeft * opt.trees);
    if (wantsTree) {
      treesLeft--;
      place('tree', 1);
    } else {
      bushesLeft--;
      place('bush', 1);
    }
  }
  return props;
}

/**
 * How far vegetation stays clear of the play area. The world's dense scatter
 * would otherwise crowd right up to the fight; the play area keeps its own,
 * much sparser one.
 */
export const PLANT_PLAY_AREA_MARGIN = 90;

/**
 * Every tree and bush in the world, for a seed and the terrain they grow on.
 *
 * Two scatters, for two jobs: the play area's own sparse stand, kept clear of
 * the spawn at its centre, and a much denser spread across the surrounding
 * world, filtered to ground that would actually grow something -- meadow and
 * worn earth, never a cliff face, a snowfield or open water.
 *
 * One function, because there is now one answer: the renderer batches this list
 * into its instanced field and the sim takes the same list as obstacles.
 */
export function worldVegetation(seed: number, world: TerrainWorld): Prop[] {
  const playArea = scatterProps(seed, PLAY_WIDTH, PLAY_HEIGHT, [{ x: PLAY_WIDTH / 2, y: PLAY_HEIGHT / 2 }]);
  const bounds = arenaBounds();
  const surrounding = scatterInBounds(
    seed ^ 0x9e3779b1,
    bounds.minX,
    bounds.minZ,
    bounds.maxX,
    bounds.maxZ,
    (x, z) => {
      if (
        x > -PLANT_PLAY_AREA_MARGIN &&
        x < PLAY_WIDTH + PLANT_PLAY_AREA_MARGIN &&
        z > -PLANT_PLAY_AREA_MARGIN &&
        z < PLAY_HEIGHT + PLANT_PLAY_AREA_MARGIN
      ) {
        return false;
      }
      const material = worldMaterialAt(world, x, z);
      return material === 'grass' || material === 'dirt';
    },
  );
  return [...playArea, ...surrounding];
}
