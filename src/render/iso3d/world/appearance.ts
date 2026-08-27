/**
 * Which rig draws which entity (spec 063).
 *
 * A replicated entity is a kind and a content id and nothing else -- the wire
 * carries `typeId`, and every number behind it lives in a table on the server.
 * That is the point of spec 062's data tables, and it means the renderer's
 * question is not "what is this" but "what do I build for it".
 *
 * Total by construction. An id this file has never heard of still gets a rig,
 * because the alternative is a frame that throws halfway through drawing and
 * takes the whole view down over a monster somebody added on the server. An
 * unknown body drawing as a generic one is a visible, survivable wrong.
 *
 * Pure: no three.js. It says what to build, not how.
 */

import { isFriendlyMonster, monsterById } from '../../../server/data/monsters.js';
import { abilityById, type ProjectileLook } from '../../../server/data/abilities.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { VFX_PALETTE } from '../vfx/palette.js';
import type { FigureTuning } from '../../cloth/params.js';
import type { CritterId } from '../../critters/index.js';

export type RigKind = 'player' | 'monster' | 'projectile' | 'prop' | 'drop';

export interface Appearance {
  readonly rig: RigKind;
  /** What to key a pooled rig on: two entities with the same look share a build. */
  readonly typeId: string;
  /** Body radius in world units, for the mesh's scale and its shadow. */
  readonly radius: number;
  /** Whether this body has a health bar over it. */
  readonly showsHealth: boolean;
  /**
   * Which shot to draw, or null for a body that is not one (spec 087).
   *
   * Read off the ability the shot was thrown by, the same lookup the radius
   * already came from -- so a new row in the table brings its own silhouette
   * and nothing here has to be told about it.
   */
  readonly look: ProjectileLook | null;
  /**
   * An override colour for the rig, or absent for whatever it draws itself as
   * (spec 156).
   *
   * Only motes use it, and only to tell health from focus. It lives here rather
   * than in the scene because *what colour a thing is* is the same kind of
   * question as *what shape it is*, and this file is where that question is
   * answered without a WebGL context.
   */
  readonly tint?: number;
  /**
   * How many times to subdivide the orb, or absent for the faceted default
   * (spec 156). Motes only -- see {@link MOTE_DETAIL}.
   */
  readonly detail?: number;
  /**
   * A brighter rim around the orb, or absent for none (spec 156).
   *
   * Motes only. A 7-unit ball of deep blood on a green field is a dark dot on a
   * dark field at the size it is actually drawn; the rim is what separates it
   * from the grass without making the whole thing a bright blob.
   */
  readonly outline?: number;
}

/** Fallbacks, sized so an unknown body reads as a body rather than as a speck. */
const DEFAULT_MONSTER_RADIUS = 20;
const DEFAULT_PROJECTILE_RADIUS = 6;
/** The look every shot had before spec 087, and what an unknown one still gets. */
const DEFAULT_PROJECTILE_LOOK: ProjectileLook = 'orb';
/** Matches `SERVER_PLAYER_RADIUS`; a player's look is not a content-table entry. */
const PLAYER_RADIUS = 16;
/** Matches `DROP_RADIUS` on the server: what the cursor picks a drop by. */
const DROP_RADIUS = 10;
/**
 * How big a mote is drawn, and in what (spec 156).
 *
 * The radius matches the one `world.ts` gives the entity. The colours are the
 * only thing that tells a health mote from a focus one, so they are named here
 * beside the shape rather than picked in the scene, where nothing could check
 * them.
 *
 * Vitality is **the game's own blood**, `VFX_PALETTE.bloodFresh`, rather than a
 * red picked to look like blood. The spray a killing blow throws and the stain
 * it leaves are already that colour, so a health mote reads as part of the same
 * event instead of as a pickup that happens to be nearby.
 */
const MOTE_RADIUS = 7;
const MOTE_VITALITY_COLOR = VFX_PALETTE.bloodFresh;
const MOTE_FOCUS_COLOR = 0x2d7fd6;
/**
 * The rim, brighter than the fill it surrounds.
 *
 * Deliberately *much* brighter rather than a shade up. What has to be beaten is
 * the arena's grass, which is a mid green, and a dark red ball on it is one dark
 * dot among the tree shadows. The pair -- deep core, hot rim -- is also what
 * makes a mote read as lit from within rather than as a painted pebble.
 */
const MOTE_VITALITY_RIM = 0xff6a58;
const MOTE_FOCUS_RIM = 0x82d4ff;
/**
 * How round a mote is drawn.
 *
 * An icosahedron at detail 0 is twenty flat faces and reads as a die; one
 * subdivision is eighty and reads as a sphere while staying inside the low-poly
 * look everything else here is built in. The bolt keeps detail 0 -- a conjured
 * shot is *supposed* to look faceted, and it is only on screen for a moment.
 */
const MOTE_DETAIL = 1;

/**
 * The species the play view draws a player as (spec 081).
 *
 * A renderer decision, and only that: the wire says `EntityKind.Player` and
 * carries no species, so this is the whole of "what a player looks like". It
 * lives here rather than in the scene because that keeps it a plain value the
 * tests can check against the critter table without a WebGL context.
 */
export const PLAYER_CRITTER: CritterId = 'cow';

/**
 * Where the player's figure differs from the critter default (spec 081).
 *
 * Two knobs, both cosmetic. `bodyScale` shrinks the cow's ~86-unit standing
 * height to something that sits under the health bar without covering what it
 * is walking toward; `strideScale` gives back the ground coverage that shrinking
 * took away, so the legs still land where the movement speed says they should
 * instead of skating.
 */
export const PLAYER_FIGURE: Pick<FigureTuning, 'bodyScale' | 'strideScale'> = {
  bodyScale: 0.7,
  strideScale: 1.3,
};

export interface AppearanceInput {
  readonly kind: number;
  readonly typeId: string;
  /** A player's replicated name (spec 145). `''` until their Identity lands. */
  readonly name?: string;
}

export function appearanceOf(entity: AppearanceInput): Appearance {
  switch (entity.kind) {
    case EntityKind.Player:
      return { rig: 'player', typeId: 'player', radius: PLAYER_RADIUS, showsHealth: true, look: null };

    case EntityKind.Projectile: {
      // A projectile's typeId is the ability that threw it, so its size and its
      // silhouette come from the same definition the server flew it with.
      const ability = abilityById(entity.typeId);
      return {
        rig: 'projectile',
        typeId: entity.typeId || 'projectile',
        radius: ability?.projectile?.radius ?? DEFAULT_PROJECTILE_RADIUS,
        showsHealth: false,
        look: ability?.projectile?.look ?? DEFAULT_PROJECTILE_LOOK,
      };
    }

    case EntityKind.Mote:
      // A restorative mote (spec 156). It draws through the *shot* rig, which is
      // not a shortcut: a mote is a small bright thing floating in the air, which
      // is exactly what `ShotRig`'s orb already is, and building a second rig to
      // draw the same sphere would be a second thing to keep looking right. What
      // it does need is a colour of its own, which is the `tint` below -- red for
      // health, blue for focus -- because two motes that restore different things
      // must not be the same object.
      return {
        rig: 'projectile',
        typeId: entity.typeId || 'mote',
        radius: MOTE_RADIUS,
        showsHealth: false,
        look: 'orb',
        tint: entity.typeId === 'mote.focus' ? MOTE_FOCUS_COLOR : MOTE_VITALITY_COLOR,
        outline: entity.typeId === 'mote.focus' ? MOTE_FOCUS_RIM : MOTE_VITALITY_RIM,
        detail: MOTE_DETAIL,
      };

    case EntityKind.Prop:
      return { rig: 'prop', typeId: entity.typeId || 'prop', radius: DEFAULT_MONSTER_RADIUS, showsHealth: false, look: null };

    // A drop has no `typeId` and that is deliberate (spec 158): what the item is
    // arrives on `LootDrop`, not on the entity record. So every drop is one look
    // here, and the tier that decides how it is *lit* comes from
    // `ClientView.drops` -- which is also the only place it could come from
    // without the entity record leaking the identity it exists not to carry.
    case EntityKind.Drop:
      return { rig: 'drop', typeId: 'drop', radius: DROP_RADIUS, showsHealth: false, look: null };

    default: {
      const monster = monsterById(entity.typeId);
      return {
        rig: 'monster',
        typeId: entity.typeId || 'monster',
        radius: monster?.radius ?? DEFAULT_MONSTER_RADIUS,
        // A friendly body has no bar (spec 244). Nothing can take its health, so
        // a bar over it would be a full one forever -- and a health bar is the
        // clearest thing this game draws to say "you may fight this".
        showsHealth: !isFriendlyMonster(entity.typeId),
        look: null,
      };
    }
  }
}

/**
 * The name to show over a body, or in a target readout.
 *
 * A player's is replicated (spec 145); everything else's comes from a content
 * table, which is why only the player branch reads a wire field. `'Player'`
 * remains the answer for the frames before a body's `Identity` has landed.
 */
/**
 * Bodies that are struck rather than cut.
 *
 * A presentation table, keyed the way every other one here is, because nothing
 * on the server authors it: `MONSTERS` has no material and should not grow one
 * for a sound. What a thing is made of decides what a blow off it sounds like
 * (`combat.hit.flesh` against `combat.hit.armored`) and what it throws
 * (`vfx-wire.ts`: "a construct throws sparks instead"), and neither is a game
 * outcome.
 *
 * A **deny list**, so the default is that a body bleeds. That is the right way
 * round for a bestiary of animals: a monster added tomorrow is flesh unless
 * somebody says otherwise, and the failure of forgetting a row is a sheep that
 * sounds like a sheep rather than one that clangs.
 */
const BLOODLESS = new Set<string>(['dummy']);

/**
 * The deny list, for the one test that can catch a typo in it.
 *
 * A misspelled id here is a construct that bleeds, and every assertion about
 * the *rule* still passes -- so what has to be checked is that each name is a
 * row `MONSTERS` actually has.
 */
export const BLOODLESS_IDS: readonly string[] = [...BLOODLESS];

/**
 * Whether a blow on this body draws blood.
 *
 * Beside {@link displayName} rather than folded into {@link Appearance} for the
 * reason that one is: it is a question *about* an entity rather than a part of
 * what gets built for it, and both wires ask it without wanting a rig.
 *
 * A projectile, a drop, a prop and a mote answer false and are never asked --
 * nothing lands a blow on one. A player always bleeds, which is not a table
 * because there is one player look and it is a cow.
 */
export function bleedsFor(entity: AppearanceInput): boolean {
  if (entity.kind === EntityKind.Player) return true;
  if (entity.kind !== EntityKind.Monster) return false;
  return !BLOODLESS.has(entity.typeId);
}

export function displayName(entity: AppearanceInput): string {
  if (entity.kind === EntityKind.Player) return entity.name ? entity.name : 'Player';
  // Never the item's name. A drop's label is `DropPresentation.label`, which is
  // null until the reveal; answering here off a `typeId` a drop does not carry
  // would be a second, worse source for the one string this feature exists to
  // withhold.
  if (entity.kind === EntityKind.Drop) return 'Item';
  if (entity.kind === EntityKind.Projectile) return abilityById(entity.typeId)?.name ?? entity.typeId;
  return monsterById(entity.typeId)?.name ?? entity.typeId;
}
