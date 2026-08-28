import type { WireStatus } from '../../../server/net/messages.js';
import { StatusId } from '../../../server/sim/statuses.js';
import { visualByWire } from '../../../server/data/status-visuals.js';
import { MAGIC_DEFAULTS, TORCH_DEFAULTS } from '../player-lights.js';
// Type-only, and it has to stay that way: `view-controls.ts` builds DOM, and
// this module is driven in Node. An `import type` is erased at compile time,
// so nothing here loads a panel.
import type { PlayerLightSettings } from '../view-controls.js';

/**
 * What the player is carrying, and what that means for the two lights the scene
 * already owns (spec 248).
 *
 * Pure: it decides, and `scene.ts` copies the answer onto a `PointLight`. The
 * split every view-model in this directory keeps, and worth keeping here for a
 * specific reason -- **two things now decide one light**, and until this module
 * existed only one did.
 *
 * ## The rule
 *
 * **The tuning panel wins where it is asking for something, and the game decides
 * where it is not.** Both switches are off by default (`view-controls.ts`), so
 * for anybody who has not opened the panel the game has the whole say; and for
 * anybody who has, every existing panel behaviour is byte-identical -- same
 * numbers, same flicker, same shadows, same everything spec 047 tuned.
 *
 * The alternative, letting the game write over a switch somebody had just
 * thrown, would make the panel useless for exactly the thing it is for: looking
 * at a light on purpose.
 *
 * ## Why a carried torch casts no shadows
 *
 * The panel's torch does, and that is its whole reason to exist -- the swinging,
 * guttering shadows are what says "flame". The *carried* one does not, and that
 * is not a shortcut: a shadow-casting point light re-renders the scene into six
 * cube faces every frame, and this one moves every frame, so it is the one light
 * in the game that could never be baked the way `world-lights.ts` bakes a
 * fixture. A player walking around with one would be paying that bill for their
 * whole session.
 *
 * The player's own body is lit either way, and lit *well*: spec 118's shader
 * patch measures a carried light from `apparentLightDistance` -- half its own
 * reach, the distance `pointIntensity` is defined at -- so a flame held at the
 * hip lights the figure evenly instead of blowing out its chest and fanning a
 * hundred degrees from head to foot. That rule was written for this and this is
 * the first thing in the game to reach it.
 */

/**
 * Which items are a light held in the hand.
 *
 * Here rather than as a field on the item row, for `weapon-look.ts`'s reason:
 * which model a sword is drawn with is art direction and lives beside the art,
 * and so is which flame a torch burns with. `data/items.ts` says what a thing
 * *is* and what wearing it does to your numbers.
 *
 * A set rather than a boolean on one id, because a second torch -- a lantern, a
 * miner's lamp -- is a row here and nothing else.
 */
export const CARRIED_TORCH_ITEMS: ReadonlySet<string> = new Set(['torch.hand']);

/** True when this off-hand item is a light. */
export function carriesTorch(offHandItemId: string | null | undefined): boolean {
  return offHandItemId !== null && offHandItemId !== undefined && CARRIED_TORCH_ITEMS.has(offHandItemId);
}

/**
 * Whether this body is carrying a conjured light, from its replicated statuses.
 *
 * Off the wire index rather than the id, because that is what crosses:
 * `visualByWire` answers null for an index this build has no row for, which is a
 * client reading a newer server and is the case that table is append-only to
 * survive.
 *
 * Live ones only, on the same comparison the sim makes -- `status-marks.ts`'s
 * rule, and for its reason: correctness must not depend on whether the delta
 * saying "it went out" has arrived yet.
 */
export function hasConjuredLight(statuses: readonly WireStatus[], tick: number): boolean {
  for (const status of statuses) {
    if (tick >= status.expiresAtTick) continue;
    if (visualByWire(status.wire)?.id === StatusId.MagicLight) return true;
  }
  return false;
}

/** What the player is carrying, as the resolver reads it. */
export interface CarriedLightFacts {
  /** The local player's off-hand item id, or null. */
  readonly offHand: string | null;
  /** Whether the local player is carrying a conjured light right now. */
  readonly conjured: boolean;
}

/** One carried light, resolved: what the scene writes onto a `PointLight`. */
export interface CarriedLight {
  readonly on: boolean;
  readonly range: number;
  readonly brightness: number;
  /** Depth of the flame's flicker. 0 is a steady lamp; the orb never flickers. */
  readonly flicker: number;
  readonly shadows: boolean;
}

export interface CarriedLights {
  readonly torch: CarriedLight;
  readonly orb: CarriedLight;
  /** Whether the player is drawn into point-light shadow maps (spec 118). */
  readonly playerShadow: boolean;
}

/**
 * The two lights the player is carrying, from the panel and from the game.
 *
 * When the panel is asking for a light, its numbers are used unchanged, down to
 * the shadow switches -- so this function is the identity on every state the
 * panel can be in. When it is not, and the game says there is a light, the
 * *item's* numbers apply: the same reach and brightness spec 047 tuned, and no
 * shadows.
 */
export function resolveCarriedLights(
  settings: PlayerLightSettings,
  facts: CarriedLightFacts,
): CarriedLights {
  const torchFromItem = carriesTorch(facts.offHand);
  const torch: CarriedLight = settings.torchOn
    ? {
        on: true,
        range: settings.torchRange,
        brightness: settings.torchBrightness,
        flicker: settings.torchFlicker,
        shadows: settings.torchShadows,
      }
    : {
        on: torchFromItem,
        range: TORCH_DEFAULTS.range,
        brightness: TORCH_DEFAULTS.brightness,
        flicker: TORCH_DEFAULTS.flicker,
        shadows: false,
      };

  const orb: CarriedLight = settings.magicOn
    ? {
        on: true,
        range: settings.magicRange,
        brightness: settings.magicBrightness,
        flicker: 0,
        shadows: false,
      }
    : {
        on: facts.conjured,
        range: MAGIC_DEFAULTS.range,
        brightness: MAGIC_DEFAULTS.brightness,
        flicker: 0,
        // Never, at either end. A conjured light *is* the thing that casts none
        // -- that is what separates it from a lantern in spec 047's own words --
        // so unlike the torch above this is not a cost decision.
        shadows: false,
      };

  return { torch, orb, playerShadow: settings.torchPlayerShadow };
}
