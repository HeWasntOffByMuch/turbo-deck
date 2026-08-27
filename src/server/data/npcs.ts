/**
 * The NPC table (spec 244): which bodies can be talked to, and what happens when
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
    // Soft Mumble, the handoff spec's own recommendation for a default NPC --
    // "gentle, rounded, neutral, friendly ... probably the safest default". A
    // touch above the preset's pitch and a touch under its pace, which is the
    // whole of what makes this a particular person rather than the engine.
    voice: { voice: 'soft', pitchMultiplier: 1.04, speed: 0.95 },
    vendorId: 'vendor.rell',
    dialogue: MERCHANT_DIALOGUE,
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
