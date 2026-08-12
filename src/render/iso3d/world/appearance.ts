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

import { monsterById } from '../../../server/data/monsters.js';
import { abilityById, type ProjectileLook } from '../../../server/data/abilities.js';
import { EntityKind } from '../../../server/net/protocol.js';
import type { FigureTuning } from '../../cloth/params.js';
import type { CritterId } from '../../critters/index.js';

export type RigKind = 'player' | 'monster' | 'projectile' | 'prop';

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
}

/** Fallbacks, sized so an unknown body reads as a body rather than as a speck. */
const DEFAULT_MONSTER_RADIUS = 20;
const DEFAULT_PROJECTILE_RADIUS = 6;
/** The look every shot had before spec 087, and what an unknown one still gets. */
const DEFAULT_PROJECTILE_LOOK: ProjectileLook = 'orb';
/** Matches `SERVER_PLAYER_RADIUS`; a player's look is not a content-table entry. */
const PLAYER_RADIUS = 16;

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

    case EntityKind.Prop:
      return { rig: 'prop', typeId: entity.typeId || 'prop', radius: DEFAULT_MONSTER_RADIUS, showsHealth: false, look: null };

    default: {
      const monster = monsterById(entity.typeId);
      return {
        rig: 'monster',
        typeId: entity.typeId || 'monster',
        radius: monster?.radius ?? DEFAULT_MONSTER_RADIUS,
        showsHealth: true,
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
export function displayName(entity: AppearanceInput): string {
  if (entity.kind === EntityKind.Player) return entity.name ? entity.name : 'Player';
  if (entity.kind === EntityKind.Projectile) return abilityById(entity.typeId)?.name ?? entity.typeId;
  return monsterById(entity.typeId)?.name ?? entity.typeId;
}
