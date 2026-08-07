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
   * Which shot to draw, or null for a body that is not one (spec 081).
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
/** The look every shot had before spec 081, and what an unknown one still gets. */
const DEFAULT_PROJECTILE_LOOK: ProjectileLook = 'orb';
/** Matches `SERVER_PLAYER_RADIUS`; a player's look is not a content-table entry. */
const PLAYER_RADIUS = 16;

export interface AppearanceInput {
  readonly kind: number;
  readonly typeId: string;
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

/** The name to show over a body, or in a target readout. */
export function displayName(entity: AppearanceInput): string {
  if (entity.kind === EntityKind.Player) return 'Player';
  if (entity.kind === EntityKind.Projectile) return abilityById(entity.typeId)?.name ?? entity.typeId;
  return monsterById(entity.typeId)?.name ?? entity.typeId;
}
