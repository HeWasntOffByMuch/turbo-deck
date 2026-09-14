/**
 * The NPC table (spec 246): which bodies can be talked to, and what happens when
 * they are.
 *
 * Keyed by the MONSTERS row id, so a body and the thing it says are one lookup
 * apart and `npcById(entity.typeId)` is the only question anybody asks. One
 * table rather than two, even though the two ends read disjoint halves of it:
 * the server reads `talkRadius` and `vendorId` and nothing else, the client
 * reads the name, the voice and the script. A name authored in two places is a
 * name that disagrees with itself, and the alternative -- a server table and a
 * client table -- is exactly that.
 *
 * The same trade `data/vendors.ts` states applies here and is worth restating,
 * because this table is the other half of it: **where an NPC stands is not
 * here.** A body comes off a `spawner` marker in the map document like every
 * other body, so moving the merchant is a map edit rather than a code change.
 * What is here is what it *is*.
 */

import type { DialogueScript, DialogueVoice } from './dialogue.js';

export interface NpcDefinition {
  /** The `MONSTERS` row this is. Its temperament must be `friendly`. */
  readonly id: string;
  /**
   * What the bubble calls them.
   *
   * Deliberately duplicated from the monster row's `name` rather than read from
   * it: that one is what a health bar and a target readout say about a body,
   * and this is what a speaker is called. They are the same string today and
   * there is no reason they must stay so -- a body labelled "Merchant" that
   * introduces itself as "Rell" is a normal thing to want.
   */
  readonly name: string;
  /**
   * How close a player must be to start a conversation, and to keep one.
   *
   * One radius for both, so "close enough to talk to" is a single fact a player
   * can learn rather than two with a gap between them. Walking past it is what
   * ends the conversation, and the server checks it every tick.
   */
  readonly talkRadius: number;
  readonly voice: DialogueVoice;
  /**
   * The `VENDORS` row a `'shop'` reply opens, or null for an NPC with no shop.
   *
   * Named here rather than derived from proximity, which is how the shop window
   * has found its vendor since spec 129 (`nearestVendorTo`). Proximity is the
   * right answer for a key press with no context; it is the wrong one for "this
   * NPC's stock", and with two shops already standing within 100 units of each
   * other it would visibly pick the wrong one.
   */
  readonly vendorId: string | null;
  readonly dialogue: DialogueScript;
}

/**
 * The merchant's script.
 *
 * Four lines and it is deliberately that small. What it has to exercise is the
 * shape rather than the writing: a line with replies, a reply that opens a
 * window, a reply that leads to another line and comes back, and a reply that
 * leaves. Everything a longer conversation needs is more rows of this.
 */
const MERCHANT_DIALOGUE: DialogueScript = {
  start: 'greet',
  lines: [
    {
      id: 'greet',
      text: 'Looking for something useful?',
      choices: [
        { text: "Show me what you've got.", go: 'browse', opens: 'shop' },
        { text: 'Who are you?', go: 'who' },
        { text: 'Never mind.', go: null },
      ],
    },
    {
      id: 'who',
      // One short answer, and it returns to the same replies -- which is the
      // whole reason `go` is an id rather than a nested line. A player who asks
      // can still shop afterwards, and nothing had to remember that they asked.
      text: "Rell. I walk the road between here and the coast, and I carry what people forget to pack.",
      choices: [
        { text: "Show me what you've got.", go: 'browse', opens: 'shop' },
        { text: 'Safe travels, then.', go: null },
      ],
    },
    {
      id: 'browse',
      // What is said *while* the shop window is open. Short on purpose: the
      // player is reading a stock list, not this.
      text: 'Take your time. Everything on it is honest.',
      choices: [
        { text: 'Thanks.', go: null },
        { text: 'Actually, who are you again?', go: 'who' },
      ],
    },
  ],
};

/**
 * The quartermaster's script.
 *
 * Same three-line shape as Rell's, and that is the point rather than a lack of
 * imagination: what a second NPC costs is a row, and a row is a script this
 * size. What makes them different characters is the voice, the stock and four
 * sentences -- not a second dialogue system.
 */
const QUARTERMASTER_DIALOGUE: DialogueScript = {
  start: 'greet',
  lines: [
    {
      id: 'greet',
      text: 'Kit and provisions. What do you need?',
      choices: [
        { text: 'Let me see the kit.', go: 'browse', opens: 'shop' },
        { text: 'What is this place?', go: 'who' },
        { text: 'Nothing today.', go: null },
      ],
    },
    {
      id: 'who',
      text: 'Hearthstead. The last stores before the road stops being a road.',
      choices: [
        { text: 'Let me see the kit.', go: 'browse', opens: 'shop' },
        { text: 'Good to know.', go: null },
      ],
    },
    {
      id: 'browse',
      text: 'Standard issue. It will not impress anyone, and it will not fail you.',
      choices: [
        { text: 'That will do.', go: null },
        { text: 'Where am I again?', go: 'who' },
      ],
    },
  ],
};

/** The armourer's. Better goods, worse rates -- and it says so. */
const ARMOURER_DIALOGUE: DialogueScript = {
  start: 'greet',
  lines: [
    {
      id: 'greet',
      text: 'Steel, then. Mind, I do not sell cheap.',
      choices: [
        { text: 'Show me the steel.', go: 'browse', opens: 'shop' },
        { text: 'Why so dear?', go: 'who' },
        { text: 'Another time.', go: null },
      ],
    },
    {
      id: 'who',
      // The one line in either script that says something mechanical, because
      // the two shops' markups *are* the choice they exist to offer and a
      // player who never opens both would otherwise never find out.
      text: 'Because it is better. Buy a blade off the quartermaster and you will be back here for a real one.',
      choices: [
        { text: 'Show me the steel.', go: 'browse', opens: 'shop' },
        { text: 'We will see.', go: null },
      ],
    },
    {
      id: 'browse',
      text: 'Take your time. It will outlast the argument.',
      choices: [
        { text: 'Fair enough.', go: null },
        { text: 'Remind me why it costs so much.', go: 'who' },
      ],
    },
  ],
};

/**
 * The trainer's script (spec 283).
 *
 * The first NPC here with nothing to sell, and the first whose replies are
 * about the *game* rather than about the world. What it is for is the gap spec
 * 283 opens with: the first node on every track is at 10, a fresh character can
 * reach one before its first level-up, and until this there was nobody to ask.
 *
 * Three rules it is written to, and the first two are
 * `docs/mechanics-vocabulary.md`'s.
 *
 * **The controlled vocabulary, exactly.** Guard, wind-up, follow-through, weak
 * point. A synonym is a second concept whether or not anybody meant it to be,
 * and a trainer that said "stamina" or "stun bar" would be teaching a word the
 * rest of the game does not use.
 *
 * **No numbers.** Not one line here states a quantity, and that is the same
 * rule this file's own `description` fields are held to: a number authored in
 * prose is a second copy of a table with nothing keeping it true, and the sheet
 * and the tooltips already say how much. These lines say what a mechanic *is*
 * and what the player *does*.
 *
 * And **it points rather than explains**: the last reply opens the character
 * sheet, which is where the numbers actually are. A trainer that recited the
 * tree would be a worse character sheet.
 *
 * What it cannot do is react to what you have built -- `DialogueScript` has no
 * conditions and no flags -- so it offers a menu. That is written down in spec
 * 283's Out of scope rather than worked around, because a condition language
 * would be the first stateful content in this tree.
 */
const TRAINER_DIALOGUE: DialogueScript = {
  start: 'greet',
  lines: [
    {
      id: 'greet',
      text: 'You have the look of someone still finding out what they can do. Ask.',
      choices: [
        { text: 'How does an attack work?', go: 'swing' },
        { text: 'What is Guard?', go: 'guard' },
        { text: 'What am I supposed to spend points on?', go: 'points' },
        { text: 'Nothing for now.', go: null },
      ],
    },
    {
      id: 'swing',
      // The wind-up and the follow-through, which is the decision this whole
      // game is built on -- and the one thing a new player is never told.
      text: 'Every blow winds up before it lands. Move, and you withdraw from it and keep what it cost you. After it lands you are still committed for a moment, and walking out of that moment costs nothing at all.',
      choices: [
        { text: 'And a weak point?', go: 'weak' },
        { text: 'What is Guard?', go: 'guard' },
        { text: 'That helps.', go: null },
      ],
    },
    {
      id: 'guard',
      text: 'Guard is what keeps a body on its feet. Wear it down and the next blow staggers them. Stand still and yours comes back; keep swinging and it does not.',
      choices: [
        { text: 'How does an attack work?', go: 'swing' },
        { text: 'And a weak point?', go: 'weak' },
        { text: 'Understood.', go: null },
      ],
    },
    {
      id: 'weak',
      text: 'Some blows find a seam. You will know one when you see it -- it bites deeper, and against a body already opened up it is worse still. Read what is in front of you and you will find more of them.',
      choices: [
        { text: 'What am I supposed to spend points on?', go: 'points' },
        { text: 'Good.', go: null },
      ],
    },
    {
      id: 'points',
      // The one reply in the tree that opens a window, and it opens the sheet
      // rather than describing it. Everything a player wants next -- what a
      // track holds, what a tier costs, what they already have -- is drawn
      // there properly, and saying it here would be a worse copy of it.
      text: 'Whatever you mean to do more of. Every track opens something the moment you reach far enough into it, and it will say so when you do. Look for yourself.',
      choices: [
        { text: 'Show me.', go: 'greet', opens: 'character' },
        { text: 'Later.', go: null },
      ],
    },
  ],
};

const DEFINITIONS: readonly NpcDefinition[] = [
  {
    id: 'npc.merchant',
    name: 'Rell',
    // Comfortably more than a body's reach and less than a shout. Its shop's
    // reach is *derived* from this plus the wander radius, since `withinReach`
    // measures from the vendor row's fixed point and the body moves -- see
    // `reachFor` in `data/vendors.ts`, and the test in
    // `world/npc-placement.test.ts` that measures the worst case off the
    // shipped map.
    talkRadius: 130,
    // Nasal Babble: "cartoonish, quirky, odd, exaggerated", and the one of the
    // four with the strongest question intonation -- which the opening line
    // ("Looking for something useful?") is built around. A touch under the
    // preset's pitch and a touch under its pace, so it reads as a person
    // talking rather than as the engine demonstrating itself.
    voice: { voice: 'nasal', pitchMultiplier: 0.96, speed: 0.95 },
    vendorId: 'vendor.rell',
    dialogue: MERCHANT_DIALOGUE,
  },
  {
    id: 'npc.quartermaster',
    name: 'Quartermaster',
    talkRadius: 130,
    // Warm Murmur: "friendly, calm, grounded, mature". The steady one of the
    // four, which is what a person handing out standard issue sounds like --
    // and the deliberate opposite of Rell's nasal patter standing two hundred
    // units away, since the first thing that tells two shopkeepers apart at a
    // distance is the noise they make.
    voice: { voice: 'warm', pitchMultiplier: 1.02 },
    vendorId: 'vendor.quartermaster',
    dialogue: QUARTERMASTER_DIALOGUE,
  },
  {
    id: 'npc.armourer',
    name: 'Armourer',
    talkRadius: 130,
    // Soft Mumble at a lower pitch and a slower pace: the handoff spec's
    // default engine, which is the right one for the character with the least
    // to prove. Three NPCs, three engines -- the fourth is unspoken for, which
    // is the honest state of a roster this size rather than a gap.
    voice: { voice: 'soft', pitchMultiplier: 0.88, speed: 0.92 },
    vendorId: 'vendor.armourer',
    dialogue: ARMOURER_DIALOGUE,
  },
  {
    id: 'npc.trainer',
    name: 'Trainer',
    talkRadius: 130,
    // The fourth engine, which spec 246 left unspoken for and said so --
    // *"the honest state of a roster this size rather than a gap"*. This is the
    // row that collects it, so the four bodies in the village are four voices,
    // which is the first thing that tells them apart at a distance.
    //
    // Pitched and paced down, hard: the preset's own character is bright and a
    // bright teacher is a squeak, where the same engine slowed reads as brisk.
    voice: { voice: 'chirpy', pitchMultiplier: 0.86, speed: 0.9 },
    // Nothing to sell, and the first row here to say so. `'shop'` on a reply
    // would be inert rather than an error, which is why no reply has one.
    vendorId: null,
    dialogue: TRAINER_DIALOGUE,
  },
];

export const NPCS: ReadonlyMap<string, NpcDefinition> = new Map(
  DEFINITIONS.map((npc) => [npc.id, npc]),
);

export const ALL_NPCS: readonly NpcDefinition[] = DEFINITIONS;

/** The NPC this type id is, or null for a body nobody can talk to. */
export function npcById(id: string): NpcDefinition | null {
  return NPCS.get(id) ?? null;
}
