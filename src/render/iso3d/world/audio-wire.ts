/**
 * Game events to sound events (spec 229).
 *
 * Pure -- no Web Audio, no three.js, no DOM, no `GameClient`. It is handed plain
 * facts and returns what to play, which is exactly the discipline `vfx-wire.ts`
 * follows one file over, and for the same stated reason: **no `if` in here
 * affects a game outcome**; every one of them affects only what is heard. The
 * server already resolved the blow and this reads the answer.
 *
 * ## Why a table and not a switch at the call site
 *
 * `view.ts` says `for (const request of soundsForBlow(facts)) audio.play(...)`
 * and knows nothing else. A new element is a row in {@link ABILITY_ELEMENTS} and
 * an entry in the catalog; a new *kind* of moment is a row in `events.ts` and
 * one call site. Neither is a change here.
 *
 * ## The one thing that is genuinely harder than the picture
 *
 * A blow's wire message carries **no ability id and no damage type** -- only
 * `attackerId, targetId, damage, targetHealth, flags` -- which is why
 * `view.ts:1547` hardcodes `damageType: 'physical'` for the picture and five of
 * the six `DAMAGE_EFFECTS` rows have been unreachable since spec 121. Audio has
 * the same problem and solves it from the other end: the *element* comes from
 * `onEffect`, whose `effectId` is `${ability.id}.impact` and is the only place
 * an ability id reaches the client at impact time. So a blow makes the sound of
 * a blow, and an elemental ability makes its element's sound on its own message,
 * a fraction of a tick apart. The alternative -- widening the combat frame by a
 * byte -- is a protocol change for a presentation problem.
 */

import type { SoundEventId } from '../../audio/events.js';
import type { WeaponType } from './weapon-look.js';

/**
 * Everything this needs to know about a blow. Facts, not objects.
 *
 * Deliberately assignable from `vfx-wire.ts`'s `CombatFacts`, so `view.ts` builds
 * the fact set once and hands the same object to both. Two fact sets recovered
 * from one message by two callers is two chances to recover it differently.
 */
export interface BlowFacts {
  readonly damage: number;
  readonly killed: boolean;
  readonly critical: boolean;
  readonly blocked: boolean;
  readonly periodic: boolean;
  /** Whether the target bleeds. A construct is struck, not cut. */
  readonly bleeds: boolean;
  /** The contact point. `y` is a lift above the ground, `z` is the world's second horizontal axis. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Whether the body taking this is the one the player is. */
  readonly onSelf: boolean;
}

/** One sound to play, and where. */
export interface SoundRequest {
  readonly id: SoundEventId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Multiplied into the catalog's volume. */
  readonly gain?: number;
}

/**
 * What one blow sounds like. Between zero and three requests.
 *
 * Capped at three for the reason `effectsForBlow` is capped at three: a voice
 * budget is spent by the people fighting, and one blow that fans out into six
 * sounds is one that starves the next five blows -- which is worse than any of
 * the six was good.
 */
export function soundsForBlow(facts: BlowFacts): readonly SoundRequest[] {
  const out: SoundRequest[] = [];

  // An affliction's beat, which is not a blow and must not be *heard* as one
  // (the audio half of spec 219). Everything below is the sound of contact, and
  // a pulse has no contact in it -- whoever applied the Poison walked off five
  // seconds ago. Eight beats of a Poison being eight sword hits is the same
  // mistake in the ear that spec 219 took back out of the eye.
  //
  // What a pulse *does* have is its own row (`affliction.*.tick`), fired by the
  // driver that already derives the beat, not from here.
  if (facts.periodic) return out;

  const at = { x: facts.x, y: facts.y, z: facts.z };

  // A heal, which arrives on this message with the sign flipped (spec 157).
  // Answered before anything else for the reason `effectsForBlow` answers it
  // first: none of the blow's vocabulary means anything about a heal, and a
  // `killed` or `critical` flag on one is noise.
  //
  // The `-0` case is spec 219's: `damage < 0` is false for `-0`, which is
  // exactly what a heal that restored nothing arrives as, and without the
  // `Object.is` it falls through and plays a sword hitting the person who drank
  // the flask.
  if (facts.damage < 0 || Object.is(facts.damage, -0)) {
    if (facts.damage === 0) return out;
    out.push({ id: 'elemental.heal', ...at });
    return out;
  }

  if (facts.blocked) {
    out.push({ id: 'combat.hit.blocked', ...at });
    return out;
  }

  // The contact itself. Flesh or construct, never both -- and never neither,
  // which is the failure mode a `bleeds` check without an else branch has.
  out.push({ id: facts.bleeds ? 'combat.hit.flesh' : 'combat.hit.armored', ...at });

  // A crit is the same language, louder -- played *beside* the hit rather than
  // instead of it, the rule `vfx-wire.ts` states about `hit_critical`. Replacing
  // the hit would make a critical blow sound like a different weapon.
  if (facts.critical) out.push({ id: 'combat.hit.critical', ...at });

  // Taking one yourself. Flat placement is the event's own declaration, so the
  // position is passed and ignored -- handed over anyway so that turning the row
  // spatial in the SFX tab is a decision that works rather than one that
  // silently plays at the origin.
  if (facts.onSelf) out.push({ id: facts.killed ? 'player.death' : 'player.hurt', ...at });
  else if (facts.killed) out.push({ id: 'combat.death', ...at });

  return out;
}

/**
 * What element an ability is, for the two moments a table can answer.
 *
 * Presentation, not mechanics -- which is why it lives here and not in
 * `server/data/abilities.ts`. What an ability *does* is its `effects`; what it
 * sounds like is a decision about the sound library, and putting it in the
 * content table would put a renderer concern in the deterministic core.
 *
 * Derived by reading `abilities.ts` rather than invented: every row that applies
 * an affliction takes that affliction's element, and the rest fall to the
 * default. `skill.testStatuses` applies all seven and is deliberately absent --
 * it is a test instrument, and an element for it would be a lie about which one.
 */
export type Element = 'physical' | 'fire' | 'ice' | 'lightning' | 'poison' | 'arcane';

export const ABILITY_ELEMENTS: Readonly<Record<string, Element>> = {
  // Fire: the ember staff's shot, the toss, and the ground it leaves burning.
  'ranged.ember': 'fire',
  'skill.emberToss': 'fire',
  'skill.scorchedEarth': 'fire',
  // Ice.
  'skill.rimeTouch': 'ice',
  // Lightning.
  'skill.arcLash': 'lightning',
  // Poison, and Corrosion beside it -- one library covers both, and a separate
  // acid row would be a sound nobody has recorded.
  'skill.poisonDart': 'poison',
  'skill.acidSpray': 'poison',
  'skill.blight': 'poison',
  // Arcane: the three bolts, the quake, and the drain channel.
  'bolt.arcane': 'arcane',
  'bolt.lob': 'arcane',
  'bolt.seek': 'arcane',
  'ground.quake': 'arcane',
  'channel.drain': 'arcane',
};

/** The element an ability is, defaulting to physical. */
export function elementOf(abilityId: string): Element {
  return ABILITY_ELEMENTS[abilityId] ?? 'physical';
}

const ELEMENT_CASTS: Readonly<Record<Element, SoundEventId | null>> = {
  physical: null,
  fire: 'elemental.fire.cast',
  ice: 'elemental.ice.cast',
  lightning: 'elemental.lightning.cast',
  poison: 'elemental.arcane.cast',
  arcane: 'elemental.arcane.cast',
};

const ELEMENT_IMPACTS: Readonly<Record<Element, SoundEventId | null>> = {
  physical: null,
  fire: 'elemental.fire.impact',
  ice: 'elemental.ice.impact',
  lightning: 'elemental.lightning.impact',
  poison: 'elemental.poison.impact',
  arcane: 'elemental.arcane.impact',
};

/**
 * The sound a wind-up makes, if any.
 *
 * **At the wind-up, not at the contact**, which is the rule `src/ui/core/sound.ts`
 * states for a press and is more load-bearing here: a swing is legible because
 * it takes half a second you can read and withdraw from (the decision this whole
 * game is built on), and a sword that makes no noise until it lands is a swing
 * with no tell. The contact has its own sound, on its own message.
 *
 * A physical melee row gets a swing; an elemental row gets its element's cast.
 * The two are exclusive on purpose -- a fire staff that whooshed *and* ignited
 * on one press is two attacks' worth of sound for one attack.
 */
export function soundForWindup(
  abilityId: string,
  isHeavy: boolean,
  projectileLook: string | null = null,
  weaponType: WeaponType | null = null,
): SoundEventId | null {
  // **The look decides before the element does**, and before the ability id.
  // What a wind-up sounds like has to agree with what the body is drawn doing,
  // and `unit-driver.ts` already picks the animation the same way -- an ability
  // whose projectile look is an arrow is drawn with a bow. Keyed on the id
  // instead, `skill.poisonDart` is `look: 'arrow'`, drawn drawing a bow, and
  // heard as an arcane cast; and any future arrow ability is silently a swing,
  // because the physical branch below falls through to one. A list of ids to
  // keep in step with the content table is the thing `shot-vfx.ts` refused for
  // the same reason.
  const shot = PROJECTILE_WINDUPS[projectileLook ?? ''];
  if (shot !== undefined) return shot;

  const element = elementOf(abilityId);
  if (element !== 'physical') return ELEMENT_CASTS[element];

  // **The weapon, when we know what it is.** A maul and a sword were one sound
  // chosen by the *ability's* damage, so the heaviest thing in the game and the
  // starting blade wound up identically and what a player was holding changed
  // nothing they could hear.
  //
  // Which is only ever their own weapon, and that is a fact about the wire
  // rather than a shortcut: equipment is replicated to its owner alone, so a
  // monster has no weapon at all and another player's is not knowable. They keep
  // the light/heavy pair, which is what those two rows are for now.
  const swing = weaponType === null ? undefined : WEAPON_WINDUPS[weaponType];
  if (swing !== undefined) return swing;

  return isHeavy ? 'combat.swing.heavy' : 'combat.swing.light';
}

/**
 * What each kind of weapon sounds like winding up.
 *
 * `bow` and `thrown` are absent, and that is the tables agreeing rather than a
 * gap: both are reached by `PROJECTILE_WINDUPS` above, off the look, which fires
 * first and is the better key -- it is what the body is *drawn* doing, so an
 * arrow ability draws a bow whether or not a bow is what is equipped.
 */
const WEAPON_WINDUPS: Readonly<Record<WeaponType, SoundEventId | undefined>> = {
  sword: 'combat.swing.sword',
  maul: 'combat.swing.maul',
  staff: 'combat.swing.staff',
  bow: undefined,
  thrown: undefined,
};

/**
 * The tell a thrown weapon makes, by what it throws.
 *
 * `ember` is deliberately absent: it is a staff, its wind-up is
 * `elemental.fire.cast`, and it reaches that through the element branch. Absent
 * rather than null so that "this look has no wind-up of its own" and "this look
 * is silent" stay different answers.
 */
const PROJECTILE_WINDUPS: Readonly<Record<string, SoundEventId>> = {
  arrow: 'combat.bow.draw',
  shuriken: 'combat.throw',
};

/**
 * The looks that are a physical object in flight, and what they sound like
 * leaving and landing.
 *
 * The other two thirds of a shot. Spec 229 wrote both rows and fired neither,
 * so a bow had a draw and then nothing at all: no loose, and an arrow landing
 * heard only as whatever the blow it caused sounded like. Three moments is what
 * a shot actually is, and the draw alone is the least useful one of them to a
 * player, because it is the only one they already knew about -- they pressed the
 * button.
 *
 * Absent for `ember`: it is not silent, it has *more* than this -- a held travel
 * loop and the server's own `${ability}.impact` -- and giving it these as well
 * would be two impacts on one landing. Which is the rule `soundForProjectile`
 * states from the other side, and the reason both tables are keyed on the look.
 */
const PROJECTILE_LIFE: Readonly<Record<string, { launch: SoundEventId; impact: SoundEventId }>> = {
  arrow: { launch: 'combat.projectile.launch', impact: 'combat.projectile.impact' },
  shuriken: { launch: 'combat.projectile.launch', impact: 'combat.projectile.impact' },
};

/** The loose. Played when a physical projectile is first seen. */
export function soundForProjectileLaunch(look: string): SoundEventId | null {
  return PROJECTILE_LIFE[look]?.launch ?? null;
}

/**
 * The landing. Played when a physical projectile stops existing.
 *
 * Every way a shot ends is "it stopped travelling" -- it hit a body, it hit the
 * ground, or it outlived `lifetimeTicks` -- and the event's own note says
 * exactly that, so this deliberately does not try to tell them apart. It has no
 * way to: an arrow that expires and one that lands both reach the client as an
 * entity that is no longer in the replicated set.
 */
export function soundForProjectileImpact(look: string): SoundEventId | null {
  return PROJECTILE_LIFE[look]?.impact ?? null;
}

/**
 * How the server's own effect id becomes a sound.
 *
 * `effectId` is `${ability.id}.impact` or `${ability.id}.self` (spec 062), and
 * it is the only place an ability id reaches the client at impact time -- see
 * the header. Anything that is not an impact answers null, because a `.self`
 * cue is the cast, and the cast has already been heard at the wind-up.
 */
export function soundForEffect(effectId: string): SoundEventId | null {
  if (!effectId.endsWith('.impact')) return null;
  const abilityId = effectId.slice(0, -'.impact'.length);
  return ELEMENT_IMPACTS[elementOf(abilityId)];
}

/**
 * The beat of one affliction.
 *
 * Keyed on the affliction's own id (`StatusId.Burn` is the string `'burn'`), so
 * a row added to `data/damage-over-time.ts` is a row here and in the catalog and
 * nothing else. Absent rather than defaulted: an affliction with no sound of its
 * own should be silent rather than borrow another one's.
 */
export const AFFLICTION_TICKS: Readonly<Record<string, SoundEventId>> = {
  burn: 'affliction.burn.tick',
  bleed: 'affliction.bleed.tick',
  poison: 'affliction.poison.tick',
  corrosion: 'affliction.corrosion.tick',
  shock: 'affliction.shock.tick',
  frostbite: 'affliction.frostbite.tick',
  decay: 'affliction.decay.tick',
};

export function soundForAfflictionTick(dotId: string): SoundEventId | null {
  return AFFLICTION_TICKS[dotId] ?? null;
}

/**
 * Which projectile looks carry a sound of their own in flight.
 *
 * Only the ember. An arrow and a star **are** their mesh -- shot-vfx.ts says the
 * same thing about their paint, and for the same reason: a whistle that followed
 * every arrow across the arena would be a sound per projectile per frame for
 * something the eye is already tracking. An orb is lit from within and reads
 * without one.
 */
export function soundForProjectile(look: string): SoundEventId | null {
  return look === 'ember' ? 'elemental.fire.travel' : null;
}
