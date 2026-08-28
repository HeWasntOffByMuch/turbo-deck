/**
 * Game events to effect ids (spec 120).
 *
 * Pure -- no three.js, no DOM, no `GameClient`. It is handed plain facts and
 * returns what to play, which is the same discipline `unit-driver.ts` follows so
 * that animation has nothing it *could* call.
 *
 * ## The one rule
 *
 * This module may read game state and may not change it. No `if` in here affects
 * a game outcome; every one of them affects only which effect is drawn. That is
 * the standing rule for `src/render/`, and here it is the whole contract -- the
 * decision the server already made arrives as a `CombatResult`, and this decides
 * what it looks like.
 *
 * ## Why a table and not a switch at the call site
 *
 * The call site says `vfx.play(request.id, request)` and knows nothing else.
 * Adding an effect for a new damage type is an entry in {@link DAMAGE_EFFECTS};
 * adding one for a new ability is a row in the ability table. Neither is a change
 * here, which is the acceptance criterion the whole arc is built around.
 */

import type { DamageElement } from '../../../server/data/abilities.js';
import type { GoreLevel } from '../vfx/decals.js';

/**
 * How much blood a blow may draw, re-exported from the field that keeps the
 * stains (spec 182).
 *
 * One declaration rather than three. It arrives *here* because what a blow looks
 * like is this module's whole job, and blood is a thing a blow looks like -- the
 * setting used to reach only `DecalField`, which owns the ground, so turning
 * blood off left every red brush mark exactly where it was and only swept up
 * after them.
 */
export type { GoreLevel };

/**
 * The damage-type language from `docs/vfx-plan.md` section 6.
 *
 * An alias for the content table's {@link DamageElement} rather than a second
 * union (spec 232), which is what keeps this module's job to *one* decision:
 * `abilities.ts` says a blow is fire, and {@link DAMAGE_EFFECTS} below is the
 * only place that says what fire looks like. Two unions here would be two lists
 * to keep in step, and the failure would be a `Record` that still compiles
 * because both happen to have the same members today.
 */
export type DamageType = DamageElement;

/** What one blow asks to be drawn. */
export interface PlayRequest {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians about Y: the direction the blow travelled. */
  readonly rotation: number;
  readonly scale: number;
  readonly seed: number;
}

/** Everything this needs to know about a blow. Facts, not objects. */
export interface CombatFacts {
  readonly attackerId: number;
  readonly targetId: number;
  readonly damage: number;
  readonly killed: boolean;
  readonly critical: boolean;
  readonly blocked: boolean;
  /**
   * What the blow was made of, off `CombatResultMessage.element` (spec 232).
   *
   * It rides the wire rather than being derived client-side the way
   * `ProjectileLook` is, and the difference is worth knowing because the first
   * cut of this tried the derivation and it does not work: a `CombatResult`
   * names an attacker and a target and no ability, and the one join available --
   * against the attacker's live cast -- is wrong for exactly the abilities that
   * needed it most, since a projectile's blow lands seconds after its cast ended.
   */
  readonly damageType: DamageType;
  /** Where the blow landed. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Where it came from, so the spray is thrown away from the attacker. */
  readonly fromX: number;
  readonly fromZ: number;
  /** Whether this target bleeds. A construct throws sparks instead. */
  readonly bleeds: boolean;
  /**
   * This damage came from an affliction rather than from a blow (spec 219).
   *
   * `CombatFlag.Periodic`, which the sim has carried since spec 190 and kept to
   * itself until it turned out that the *number* is the only thing a pulse and
   * a blow have in common.
   */
  readonly periodic: boolean;
}

/**
 * The impact effect for each damage type (spec 121).
 *
 * The table is the seam the whole arc is built around: a new damage type is a
 * row here and an entry in the library, and nothing at any call site changes.
 * Every id is asserted to exist in the registry, because a stub table is exactly
 * where a typo survives -- it looks filled in and silently plays nothing.
 */
export const DAMAGE_EFFECTS: Record<DamageType, string> = {
  physical: 'hit_physical',
  fire: 'hit_fire',
  poison: 'hit_poison',
  ice: 'hit_ice',
  lightning: 'hit_lightning',
  arcane: 'hit_arcane',
  corrosion: 'hit_corrosion',
  decay: 'hit_decay',
};

/** The secondary an impact plays alongside its flash, or null. */
export const DAMAGE_DEBRIS: Record<DamageType, string | null> = {
  // Only a physical blow throws chips and dust. Fire and arcane leave nothing
  // solid behind, and giving them debris is what makes every damage type read
  // the same.
  physical: 'impact_physical',
  fire: null,
  poison: null,
  ice: 'impact_physical',
  lightning: null,
  arcane: null,
  // Acid eats what it lands on rather than breaking pieces off it, and rot even
  // less so. Both null for `hit_fire`'s reason rather than by omission.
  corrosion: null,
  decay: null,
};

/**
 * What restoring health looks like (spec 157).
 *
 * Healing travels on the blow message: every heal in the game is reported as a
 * hit against yourself with negative damage, which `world.ts` and `abilities.ts`
 * both say in as many words, so that a client has one code path for "a number
 * floated off somebody". This is the other half of honouring that -- the number
 * has read the sign since spec 096, and until now the *effect* did not, so a
 * mote picked up threw a red spatter off your own chest.
 */
export const HEAL_EFFECT = 'heal_restore';

/**
 * Server effect ids the blow already draws, so nothing draws them twice.
 *
 * Both self-heal abilities send an `Effect` message *and* the negative-damage
 * hit above. The registry has no entry under an ability's own id, so the effect
 * message fell through to `scene.addEffect`'s debug disc -- a flat orange circle
 * at the caster's feet, underneath the green heal, for half a second.
 *
 * A set rather than a branch at the call site, and named for the *reason* rather
 * than for the abilities: an ability whose picture is already drawn by the blow
 * it reports belongs here, and one that needs a picture of its own belongs in
 * the registry under its own id, which is the seam `addEffect` already checks.
 */
export const REDUNDANT_SERVER_EFFECTS: ReadonlySet<string> = new Set([
  // One entry rather than two since spec 232: `self.mend` was spec 062's
  // demo heal, granted by nothing and removed with the rest of that set. The
  // flask is the self-heal the game still has.
  'self.hearthdraught.self',
  // A projectile that struck a body (spec 232). `world.ts` sends this from the
  // same branch that raises the `hit`, at the same instant and the same point,
  // so the blow's own picture is already the impact -- which is this set's
  // stated rule rather than a third exception to it.
  //
  // A *bursting* projectile is not in here and must not be: its `.impact` is
  // sent whether or not anything was struck, and a blast that caught nobody
  // still happened.
  'skill.poisonDart.impact',
]);

/**
 * How many requests one blow may spend.
 *
 * The budget is spent per-blow by the people fighting, so an impact that fans
 * out into six is one that starves the next five. Named rather than spelled
 * since spec 232 gave the last slot two possible occupants and therefore a
 * precedence worth stating in one place.
 */
export const MAX_BLOW_EFFECTS = 3;

/**
 * How far back along the blow a hit is drawn, in world units.
 *
 * About the radius of a body. The capsule the player is drawn as is ten units of
 * radius; a little more puts the burst clear of the surface rather than half
 * inside it, which is what stops a small hit disappearing when the target is
 * between it and the camera.
 */
export const CONTACT_RADIUS = 12;

/** And how far up it: a blow lands on a chest, not on a pair of boots. */
export const CONTACT_LIFT = 6;

/**
 * A seed that is a function of *where and when*, not of the client.
 *
 * Two players watching the same blow see the same spatter, which matters more
 * than it sounds: the stains it leaves persist, so a seed drawn locally would
 * give two people permanently different ground.
 */
export function blowSeed(facts: CombatFacts, tick: number): number {
  const x = Math.round(facts.x) | 0;
  const z = Math.round(facts.z) | 0;
  return (Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ Math.imul(tick, 83492791) ^ facts.targetId) | 0;
}

/**
 * What to play for one blow. Between zero and {@link MAX_BLOW_EFFECTS} requests.
 *
 * Capped at three deliberately. The budget is spent per-blow by the people
 * fighting, and an impact that fans out into six effects is one that starves the
 * next five impacts -- which is worse than any of the six looked good.
 *
 * `gore` is required rather than defaulted (spec 182), because a default is
 * exactly how the one caller that matters goes on not passing it: this argument
 * exists because the setting reached the ground and not the blow for fifty-five
 * specs, with a green test either side of it.
 */
export function effectsForBlow(facts: CombatFacts, tick: number, gore: GoreLevel): readonly PlayRequest[] {
  const out: PlayRequest[] = [];
  const seed = blowSeed(facts, tick);

  // An affliction's beat, which is not a blow and must not be drawn as one
  // (spec 219).
  //
  // Nothing at all, and that is the whole of it: no blood, no flash, no crit,
  // no debris, no pool on a pulse that kills. Everything below aims a picture
  // *along* the blow, from the attacker to the target -- and a pulse's attacker
  // is whoever applied the affliction, who is by now wherever they have walked
  // to. So a Poison ticking eight times threw eight brush hits down eight
  // bearings that described nothing, at a body nobody was touching.
  //
  // What draws an affliction is `affliction-vfx.ts` (spec 215): the cling that
  // stays on the body and the beat that lands on the frame the number does. The
  // picture already exists; this is the blow's one being taken back off it.
  if (facts.periodic) return out;

  // A heal, which arrives on this message with the sign flipped (spec 157).
  //
  // Answered *before* the contact point, and that is the substance of it rather
  // than an optimisation: everything below aims a picture along the blow, and a
  // heal has no blow to aim along. So it is drawn on the body itself and at
  // ground level -- `playEffect` adds the terrain height, so a lift of zero is
  // the feet -- and none of the blow's vocabulary reaches it. A heal is not a
  // hit read quietly; it is a different event travelling on the hit's message,
  // and a killed/critical/blocked flag on one means nothing.
  //
  // The test is the **sign**, and `-0` is negative -- which `damage < 0` says it
  // is testing and does not (spec 219). A heal that restored nothing arrives as
  // exactly that, so under the magnitude test it fell straight through into the
  // blow path and painted a brush hit on the person who drank the flask. A blow
  // that did nothing is `+0` and is still a blow, which is the rule spec 157
  // stated and the one the sign test finally keeps.
  if (facts.damage < 0 || Object.is(facts.damage, -0)) {
    // Nothing restored, nothing drawn. The server stopped sending this at all
    // (`landSelf`); the refusal stays here because the sign is the only thing
    // that tells a heal of nothing from a blow that did nothing, and this is
    // the module that knows the difference.
    if (facts.damage === 0) return out;
    out.push({ id: HEAL_EFFECT, x: facts.x, y: 0, z: facts.z, rotation: 0, scale: 1, seed });
    return out;
  }

  // Away from the attacker: a hit from the left throws to the right. Falls back
  // to a fixed bearing when the two are stacked, which happens at point-blank.
  const dx = facts.x - facts.fromX;
  const dz = facts.z - facts.fromZ;
  const far = dx * dx + dz * dz;
  const aimed = far > 1e-3;
  const rotation = aimed ? Math.atan2(dz, dx) : 0;

  // The contact point, which is not the target's own position (spec 125).
  //
  // A blow lands on the *face* the attacker is on, and a burst played at the
  // middle of a body is a burst inside a body -- twenty units of capsule in front
  // of it, which is why a small hit could be invisible from the near side. So
  // step back along the incoming blow by about a body radius, and lift it to
  // chest height rather than the feet.
  const length = aimed ? Math.sqrt(far) : 1;
  const backX = aimed ? (-dx / length) * CONTACT_RADIUS : 0;
  const backZ = aimed ? (-dz / length) * CONTACT_RADIUS : 0;

  // A crit is the same language, louder -- never a different one.
  const scale = facts.critical ? 1.45 : 1;

  // Every request of one blow gets its own seed, or the flash and the spray draw
  // the same numbers and land in the same pattern -- which reads as one effect
  // drawn twice rather than as two things happening.
  const at = (id: string, salt: number, sizeScale = 1): PlayRequest => ({
    id,
    x: facts.x + backX,
    y: facts.y + CONTACT_LIFT,
    z: facts.z + backZ,
    rotation,
    scale: scale * sizeScale,
    seed: (seed ^ Math.imul(salt, 0x9e3779b1)) | 0,
  });

  if (facts.blocked) {
    // A blow that was stopped opened nothing, so there is no blood and no
    // debris -- just the guard taking it.
    out.push(at('hit_block', 1, 0.85));
    return out;
  }

  // How much a body bleeds *as far as the setting is concerned* (spec 182).
  //
  // One predicate rather than a branch per consequence, because everything below
  // has to agree about it: at `Off` a body that would have bled draws precisely
  // what a construct draws -- the damage type's own flash and its debris -- so
  // the blow is still legible. Dropping the blood and putting nothing in its
  // place would make a fight harder to read, which is a worse setting than the
  // one being fixed.
  const bleeds = facts.bleeds && gore > 0;

  // Blood is painted since spec 158: `blood_hit_brush` throws brush marks along
  // the blow rather than a spray of ribbons. At `Full` a killing blow gets the
  // loud variant, and then `death_blood` as well -- the two are doing different
  // jobs and always were. The brush hit is the *moment*, over inside half a
  // second and leaving nothing; `death_blood` is the pool, and the stain it puts
  // on the ground outlives every particle either of them owns (spec 120).
  //
  // `Less` is where the two part company: the wound stays and the pool goes. It
  // is the loud one, it is the one that lasts, and it is the one that lays a
  // 96-unit stain on the floor, so a setting that means "less of this" and left
  // it in place would be reducing the only part nobody minds.
  if (bleeds) {
    const loud = gore === 2 && facts.killed;
    out.push(at(loud ? 'blood_hit_brush_heavy' : 'blood_hit_brush', 2));
    if (loud) out.push(at('death_blood', 6));
  } else {
    out.push(at(DAMAGE_EFFECTS[facts.damageType], 3));
  }

  if (facts.critical) out.push(at('hit_critical', 4));

  // The last slot, and which of two things goes in it depends on whether the
  // body bled (spec 232).
  //
  // Blood says *that* something landed and the element says *what*, and both are
  // true of an Ember Toss on flesh -- so a bleeding body wants its blood and its
  // fire. What makes that affordable is that these two were never both wanted:
  // `DAMAGE_DEBRIS` has always been skipped for a body that bleeds, so the
  // elemental flash takes a slot that was already going spare and the cap of
  // three stands untouched.
  //
  // A *physical* blow on flesh adds nothing, which is the other half of the same
  // rule: `hit_physical` beside a blood spatter is the spatter drawn twice in
  // two colours, where fire beside it is a second fact. So the flash goes on
  // only where the type is something the blood is not already saying.
  const debris = DAMAGE_DEBRIS[facts.damageType];
  if (!bleeds) {
    if (debris) out.push(at(debris, 5));
  } else if (facts.damageType !== 'physical' && out.length < MAX_BLOW_EFFECTS) {
    // The room check is not defensive, it is the precedence (spec 232).
    //
    // A killing blow at `Full` has already spent two of the three on
    // `blood_hit_brush_heavy` and `death_blood`, and a crit spends the third --
    // so the element is the one that yields, and it is the right one to yield.
    // The other three are all saying something this blow *did*: it killed, it
    // opened them up, it crit. The element is saying what the blow was, which is
    // the same on every cast of the skill and the thing a player already knows
    // from the button they pressed.
    out.push(at(DAMAGE_EFFECTS[facts.damageType], 5));
  }

  return out;
}
