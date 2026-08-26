/**
 * Every sound this game can ask for, as a closed vocabulary (spec 229).
 *
 * The one decision the whole framework rests on: **the event set is code and the
 * assignment of files to events is data.** Gameplay says `audio.play('combat.hit.flesh', at)`
 * and a typo is a build error; which `.ogg` that turns into is
 * `assets/audio/sfx.json`, which the SFX tab writes and nothing in gameplay
 * reads. So adding a sound to a skill is an edit in a tool, and adding a *kind*
 * of moment to the game is a row here plus one call site -- which is the same
 * seam `vfx-wire.ts`'s `DAMAGE_EFFECTS` is, one layer up.
 *
 * Pure. No DOM, no Web Audio, no clock -- this is a table.
 *
 * ## What is in the table and what is not
 *
 * Every row is a moment that **already happens** in this game: an ability in
 * `server/data/abilities.ts`, an affliction in `server/data/damage-over-time.ts`,
 * a status the sim writes, or a gesture the interface already answers. There is
 * no `player.jump` because nothing jumps, no `combat.parry` because nothing
 * parries, and no per-monster voice because the roster is seven rows and a
 * per-row event would be seven ways to say "something died".
 *
 * A row with no files assigned is **silence**, not a fallback and not a warning
 * beep: an unassigned event is the normal state of a game being built, and a
 * placeholder tone would be a sound nobody chose playing in front of a
 * playtester. `npm run audio:report` (and the SFX tab's own header) is where the
 * gaps are counted.
 *
 * ## Why `bus` is declared here and not in the catalog
 *
 * A sound's category is a fact about the moment, not a preference: a footstep is
 * player audio wherever its file came from. Putting it in the editable document
 * would make "the footstep is on the UI bus" a reachable state, and the only
 * thing it would buy is a dropdown nobody should touch. What the catalog owns is
 * everything a person tuning by ear needs -- the files, the level, the pitch
 * spread, the spatial range -- and the mix per bus is a *player* setting, in the
 * options window.
 */

/** The buses, coarsest first. Master is not a row: it multiplies all of them. */
export const BUSES = ['player', 'combat', 'elemental', 'ambience', 'ui'] as const;
export type BusId = (typeof BUSES)[number];

/** What a bus is called where a player sees it. */
export const BUS_LABELS: Record<BusId, string> = {
  player: 'Player',
  combat: 'Combat',
  elemental: 'Elemental',
  ambience: 'Ambience',
  ui: 'UI',
};

/**
 * How a sound is placed in the world.
 *
 * - `world` -- it happened somewhere, and gets a panner. The usual case.
 * - `flat`  -- it happened to *you*, and is heard at full volume wherever you
 *   are: your own level-up, the interface, the ambient bed. Not the same thing
 *   as a spatial sound played at the listener, because that one still pans as
 *   the camera turns, and a menu click that swings left when you orbit is a bug
 *   nobody can describe.
 */
export type Placement = 'world' | 'flat';

/**
 * How the SFX tab files a row.
 *
 * Two levels rather than one flat list, and rather than three: the tab is a
 * left-hand tree, and at three levels the leaves are four indents in on a panel
 * that also has to hold a variant list. Group is the bus's own name (so the tree
 * and the mixer agree without a mapping) and section is the mechanic.
 */
interface SoundEventShape {
  readonly id: string;
  /** What it is called in the tab. Sentence case, no group prefix. */
  readonly label: string;
  readonly bus: BusId;
  readonly section: string;
  /** The default placement, overridable per catalog entry. */
  readonly placement: Placement;
  /**
   * Whether this one repeats until something stops it (a travelling projectile,
   * an ambient bed, an aura's field). Not a preference: a looping sound is
   * started and stopped by a driver that holds a handle, and a one-shot is fired
   * and forgotten, and those are two different call sites.
   */
  readonly loop?: true;
  /** What fires it. Shown in the tab, because "when do I hear this" is the first question. */
  readonly note: string;
}

/**
 * The vocabulary.
 *
 * Ordered as the tab draws it, so the table is the outline and there is no
 * second list deciding what comes before what.
 */
export const SOUND_EVENTS = [
  // ---------------------------------------------------------------- player --
  {
    id: 'player.footstep',
    label: 'Footstep',
    bus: 'player',
    section: 'Movement',
    placement: 'world',
    note: 'Every body that walks, on a stride measured from the distance it covered.',
  },
  {
    id: 'player.hurt',
    label: 'Player hurt',
    bus: 'player',
    section: 'Vitals',
    placement: 'flat',
    note: 'A blow lands on you. Flat, because it happened to you rather than near you.',
  },
  {
    id: 'player.death',
    label: 'Player death',
    bus: 'player',
    section: 'Vitals',
    placement: 'flat',
    note: 'You fall (CombatFlag.Killed on your own body).',
  },
  {
    id: 'player.respawn',
    label: 'Respawn',
    bus: 'player',
    section: 'Vitals',
    placement: 'flat',
    note: 'You get back up -- the revive that spec 168 made a command.',
  },
  {
    id: 'player.levelUp',
    label: 'Level up',
    bus: 'player',
    section: 'Progression',
    placement: 'flat',
    note: 'The level on a Stats message goes up.',
  },
  {
    id: 'player.attributeUp',
    label: 'Attribute spent',
    bus: 'player',
    section: 'Progression',
    placement: 'flat',
    note: 'A point goes into an attribute on the character sheet and the server agrees.',
  },
  {
    id: 'player.skillUp',
    label: 'Skill learned',
    bus: 'player',
    section: 'Progression',
    placement: 'flat',
    note: 'A node in the attuned tree is taken.',
  },
  {
    id: 'player.pickUp',
    label: 'Loot taken',
    bus: 'player',
    section: 'Items',
    placement: 'world',
    note: 'A drop is picked up off the ground (spec 158).',
  },
  {
    id: 'player.dropItem',
    label: 'Item thrown down',
    bus: 'player',
    section: 'Items',
    placement: 'world',
    note: 'An item leaves the bag onto the ground (spec 172).',
  },

  // The four loot cues, and these ids are not ours to choose: they are the
  // strings in `RARITIES[].cues` (server/data/loot.ts), which spec 158 wrote as
  // **names** with "the renderer decides what a name sounds and looks like" and
  // then had nothing to hand them to but the effect registry. `playCue` in
  // scene.ts is the socket; this is the plug. So the row ids match that table
  // character for character, and a tier that adds a cue name is simply silent
  // here until somebody adds a row -- which is exactly what `vfx.system.has(cue)`
  // already does on the picture half.
  //
  // Spec 158's rule travels with them: **only `reveal` names a tier**, because
  // the other two fire before the identity is known and a tier in either name is
  // the rarity leaking out through the audio channel.
  {
    id: 'loot.spawn',
    label: 'Drop lands',
    bus: 'player',
    section: 'Loot',
    placement: 'world',
    note: 'Any drop hits the ground. One name for every tier, on purpose.',
  },
  {
    id: 'loot.anticipation',
    label: 'Something is happening',
    bus: 'player',
    section: 'Loot',
    placement: 'world',
    note: 'A rare-or-better drop begins its reveal. Must not name a tier.',
  },
  {
    id: 'loot.reveal.rare',
    label: 'Reveal: rare',
    bus: 'player',
    section: 'Loot',
    placement: 'world',
    note: 'The moment a rare drop becomes what it is.',
  },
  {
    id: 'loot.reveal.exceptional',
    label: 'Reveal: exceptional',
    bus: 'player',
    section: 'Loot',
    placement: 'world',
    note: 'The moment an exceptional drop becomes what it is.',
  },

  // ---------------------------------------------------------------- combat --
  {
    id: 'combat.swing.light',
    label: 'Light swing',
    bus: 'combat',
    section: 'Swings',
    placement: 'world',
    note: 'A `melee.slash` wind-up begins. Fired at the wind-up, not the contact.',
  },
  {
    id: 'combat.swing.heavy',
    label: 'Heavy swing',
    bus: 'combat',
    section: 'Swings',
    placement: 'world',
    note: 'A `melee.heavy` or a heavy melee skill winds up.',
  },
  {
    id: 'combat.bow.draw',
    label: 'Bow drawn',
    bus: 'combat',
    section: 'Swings',
    placement: 'world',
    note: 'A `ranged.shot` wind-up begins -- the draw, not the loose.',
  },
  {
    id: 'combat.throw',
    label: 'Throw',
    bus: 'combat',
    section: 'Swings',
    placement: 'world',
    note: 'A `ranged.star` wind-up begins.',
  },
  {
    id: 'combat.hit.flesh',
    label: 'Hit (flesh)',
    bus: 'combat',
    section: 'Contact',
    placement: 'world',
    note: 'A blow lands on a body that bleeds.',
  },
  {
    id: 'combat.hit.armored',
    label: 'Hit (construct)',
    bus: 'combat',
    section: 'Contact',
    placement: 'world',
    note: 'A blow lands on something that throws sparks instead of blood.',
  },
  {
    id: 'combat.hit.critical',
    label: 'Critical hit',
    bus: 'combat',
    section: 'Contact',
    placement: 'world',
    note: 'CombatFlag.Critical. Played *beside* the ordinary hit, never instead of it.',
  },
  {
    id: 'combat.hit.blocked',
    label: 'Blocked',
    bus: 'combat',
    section: 'Contact',
    placement: 'world',
    note: 'CombatFlag.Blocked -- the guard took it and nothing opened.',
  },
  {
    id: 'combat.stagger',
    label: 'Guard broken',
    bus: 'combat',
    section: 'Contact',
    placement: 'world',
    note: 'A poise break: the body enters ActivityValue.Stunned (spec 173).',
  },
  {
    id: 'combat.death',
    label: 'Enemy death',
    bus: 'combat',
    section: 'Contact',
    placement: 'world',
    note: 'A body other than yours is killed.',
  },
  {
    id: 'combat.projectile.launch',
    label: 'Projectile away',
    bus: 'combat',
    section: 'Projectiles',
    placement: 'world',
    note: 'A physical projectile (arrow, star) appears. The elemental looks have their own rows.',
  },
  {
    id: 'combat.projectile.impact',
    label: 'Projectile impact',
    bus: 'combat',
    section: 'Projectiles',
    placement: 'world',
    note: 'A physical projectile stops travelling.',
  },

  // ------------------------------------------------------------- elemental --
  {
    id: 'elemental.fire.cast',
    label: 'Fire cast',
    bus: 'elemental',
    section: 'Fire',
    placement: 'world',
    note: 'A fire ability commits -- `ranged.ember`, `skill.emberToss`, `skill.scorchedEarth`.',
  },
  {
    id: 'elemental.fire.travel',
    label: 'Fire in flight',
    bus: 'elemental',
    section: 'Fire',
    placement: 'world',
    loop: true,
    note: 'Held for as long as an `ember` projectile is in the air, and stopped when it is not.',
  },
  {
    id: 'elemental.fire.impact',
    label: 'Fire impact',
    bus: 'elemental',
    section: 'Fire',
    placement: 'world',
    note: 'Fire damage lands.',
  },
  {
    id: 'elemental.fire.field',
    label: 'Burning ground',
    bus: 'elemental',
    section: 'Fire',
    placement: 'world',
    loop: true,
    note: "Held while a body carries an aura field -- Scorched Earth's ring (spec 223).",
  },
  {
    id: 'elemental.ice.cast',
    label: 'Ice cast',
    bus: 'elemental',
    section: 'Ice',
    placement: 'world',
    note: 'An ice ability commits -- `skill.rimeTouch`.',
  },
  {
    id: 'elemental.ice.impact',
    label: 'Ice impact',
    bus: 'elemental',
    section: 'Ice',
    placement: 'world',
    note: 'Ice damage lands.',
  },
  {
    id: 'elemental.lightning.cast',
    label: 'Lightning cast',
    bus: 'elemental',
    section: 'Lightning',
    placement: 'world',
    note: 'A lightning ability commits -- `skill.arcLash`.',
  },
  {
    id: 'elemental.lightning.impact',
    label: 'Lightning impact',
    bus: 'elemental',
    section: 'Lightning',
    placement: 'world',
    note: 'Lightning damage lands.',
  },
  {
    id: 'elemental.arcane.cast',
    label: 'Arcane cast',
    bus: 'elemental',
    section: 'Arcane',
    placement: 'world',
    note: 'An arcane ability commits -- `bolt.arcane`, `bolt.lob`, `bolt.seek`, `ground.quake`.',
  },
  {
    id: 'elemental.arcane.impact',
    label: 'Arcane impact',
    bus: 'elemental',
    section: 'Arcane',
    placement: 'world',
    note: 'Arcane damage lands.',
  },
  {
    id: 'elemental.poison.impact',
    label: 'Poison impact',
    bus: 'elemental',
    section: 'Other',
    placement: 'world',
    note: 'Poison damage lands -- `skill.poisonDart`, `skill.acidSpray`.',
  },
  {
    id: 'elemental.heal',
    label: 'Heal',
    bus: 'elemental',
    section: 'Other',
    placement: 'world',
    note: 'Health is restored: the negative-damage blow spec 157 reports a heal as.',
  },

  // The seven afflictions (spec 190), one beat each. Distinct rows because
  // spec 215 gave each one a distinct picture, and a shared tick would put one
  // sound under seven different things happening to a body.
  {
    id: 'affliction.burn.tick',
    label: 'Burn',
    bus: 'elemental',
    section: 'Afflictions',
    placement: 'world',
    note: 'One pulse of Burn.',
  },
  {
    id: 'affliction.bleed.tick',
    label: 'Bleed',
    bus: 'elemental',
    section: 'Afflictions',
    placement: 'world',
    note: 'One pulse of Bleed.',
  },
  {
    id: 'affliction.poison.tick',
    label: 'Poison',
    bus: 'elemental',
    section: 'Afflictions',
    placement: 'world',
    note: 'One pulse of Poison.',
  },
  {
    id: 'affliction.corrosion.tick',
    label: 'Corrosion',
    bus: 'elemental',
    section: 'Afflictions',
    placement: 'world',
    note: 'One pulse of Corrosion.',
  },
  {
    id: 'affliction.shock.tick',
    label: 'Shock',
    bus: 'elemental',
    section: 'Afflictions',
    placement: 'world',
    note: 'One pulse of Shock.',
  },
  {
    id: 'affliction.frostbite.tick',
    label: 'Frostbite',
    bus: 'elemental',
    section: 'Afflictions',
    placement: 'world',
    note: 'One pulse of Frostbite.',
  },
  {
    id: 'affliction.decay.tick',
    label: 'Decay',
    bus: 'elemental',
    section: 'Afflictions',
    placement: 'world',
    note: 'One pulse of Decay.',
  },

  // -------------------------------------------------------------- ambience --
  //
  // Two rows and an emitter API, and no assets: this library ships none, and
  // inventing an ambient bed out of a combat library would be worse than silence.
  // What is built is the *seam* -- `AudioEngine.hold` keeps a positioned loop
  // alive and `ambience.ts` places them -- so wiring a bed later is a file
  // assignment rather than a feature.
  {
    id: 'ambience.world',
    label: 'World bed',
    bus: 'ambience',
    section: 'Environment',
    placement: 'flat',
    loop: true,
    note: 'The map’s own bed. Flat: it is everywhere, so panning it would be a lie.',
  },
  {
    id: 'ambience.water',
    label: 'Water',
    bus: 'ambience',
    section: 'Emitters',
    placement: 'world',
    loop: true,
    note: 'A positioned loop at the nearest water. Placed by the ambience driver.',
  },

  // -------------------------------------------------------------------- ui --
  //
  // The first seven are `UiSoundId` (src/ui/core/sound.ts) exactly: that file is
  // the *widget* vocabulary and this is the game's, and the ids are shared so the
  // bridge is a cast rather than a mapping table. The rest are moments the
  // interface reports that are not widget feedback -- a trade completing is a
  // thing that happened, not a button acknowledging a press.
  { id: 'ui.press', label: 'Press', bus: 'ui', section: 'Widgets', placement: 'flat', note: 'Any button, tab or checkbox took a press.' },
  { id: 'ui.open', label: 'Window opened', bus: 'ui', section: 'Widgets', placement: 'flat', note: 'A window is shown.' },
  { id: 'ui.close', label: 'Window closed', bus: 'ui', section: 'Widgets', placement: 'flat', note: 'A window is dismissed.' },
  { id: 'ui.error', label: 'Refused', bus: 'ui', section: 'Widgets', placement: 'flat', note: 'A rule or the server said no. Anything that reaches the refusal stack.' },
  { id: 'ui.drop', label: 'Item placed', bus: 'ui', section: 'Bag', placement: 'flat', note: 'A carried item is let go over a slot that took it.' },
  { id: 'ui.pickUp', label: 'Item lifted', bus: 'ui', section: 'Bag', placement: 'flat', note: 'A stack is picked up out of a cell.' },
  { id: 'ui.coin', label: 'Coin', bus: 'ui', section: 'Bag', placement: 'flat', note: 'Money changes hands at the shop.' },
  { id: 'ui.equip', label: 'Equipped', bus: 'ui', section: 'Bag', placement: 'flat', note: 'Something is worn, or a sigil goes into a skill slot.' },
  { id: 'ui.equipCancelled', label: 'Swap cancelled', bus: 'ui', section: 'Bag', placement: 'flat', note: 'A pending skill swap is given up (spec 188).' },
  { id: 'ui.tradeRequest', label: 'Trade offered', bus: 'ui', section: 'Trade', placement: 'flat', note: 'Somebody asks to trade with you.' },
  { id: 'ui.tradeComplete', label: 'Trade done', bus: 'ui', section: 'Trade', placement: 'flat', note: 'A trade goes through.' },
] as const satisfies readonly SoundEventShape[];

/**
 * Every id, as a union.
 *
 * Derived from the table rather than declared beside it, so adding an event is
 * one edit and cannot produce a union and a table that disagree.
 */
export type SoundEventId = (typeof SOUND_EVENTS)[number]['id'];

/**
 * One row, with its id narrowed to the union.
 *
 * Two names for one shape, and the split is what makes the union derivable at
 * all: `SOUND_EVENTS` is checked against {@link SoundEventShape}, whose `id` is
 * a plain `string`, because a table checked against a type derived *from that
 * table* is a circular reference TypeScript refuses. Consumers get this one, so
 * a row taken out of the table can be handed straight back to `resolveSound`
 * without a cast at each call site.
 */
export type SoundEventDefinition = SoundEventShape & { readonly id: SoundEventId };

const BY_ID = new Map<string, SoundEventDefinition>(SOUND_EVENTS.map((event) => [event.id, event]));

/** The definition for an id, or null. Takes a `string` so a parser can ask. */
export function soundEvent(id: string): SoundEventDefinition | null {
  return BY_ID.get(id) ?? null;
}

/** Whether a string names an event this build knows. */
export function isSoundEventId(id: string): id is SoundEventId {
  return BY_ID.has(id);
}

export const SOUND_EVENT_IDS: readonly SoundEventId[] = SOUND_EVENTS.map((event) => event.id);

/** One section of the SFX tab's tree: a bus, a section, and the rows in it. */
export interface SoundEventSection {
  readonly bus: BusId;
  readonly section: string;
  readonly events: readonly SoundEventDefinition[];
}

/**
 * The table as the tab draws it: bus order, then first-appearance section order.
 *
 * Grouped here rather than in the view, because "what the outline is" is a fact
 * about the vocabulary and the tab is one of three things that wants it (the
 * others being the gap report and its test).
 */
export function soundEventSections(): readonly SoundEventSection[] {
  const out: SoundEventSection[] = [];
  const index = new Map<string, SoundEventSection & { events: SoundEventDefinition[] }>();
  for (const bus of BUSES) {
    for (const event of SOUND_EVENTS) {
      if (event.bus !== bus) continue;
      const key = `${bus}/${event.section}`;
      let group = index.get(key);
      if (!group) {
        group = { bus, section: event.section, events: [] };
        index.set(key, group);
        out.push(group);
      }
      group.events.push(event);
    }
  }
  return out;
}
