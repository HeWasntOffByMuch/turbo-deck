import { describe, expect, it } from 'vitest';

import type { DialogueVoiceId } from '../../../server/data/dialogue.js';
import { ALL_NPCS, npcById } from '../../../server/data/npcs.js';
import type { SpeakEvent } from '../../audio/dialogue-voice.js';
import { planLine } from '../../audio/dialogue-voice.js';
import { DialogueDriver, type DialogueBody } from './dialogue-driver.js';
import type { DialogueSpeech } from './dialogue.js';
import { SIGN_BUBBLE_LIFT, SIGN_READ_RADIUS, signMarks, type SignMark } from './sign.js';
import type { Prop } from '../../../terrain/index.js';

/**
 * Spec 246. The four things a conversation is joined to, with none of them real.
 *
 * The claim this file makes is the one no unit test of `dialogue.ts` can: that
 * the *server* decides whether a conversation exists, and that every way one can
 * end arrives here as the same event. `conversationEntityId` going back to 0 is
 * a player who walked away, a merchant that died, a socket that dropped and
 * somebody else getting there first, and none of them has a case of its own --
 * so what has to be asserted is that the single case covers all of them.
 */

class Recorder implements DialogueSpeech {
  readonly spoken: string[] = [];
  stops = 0;

  speak(_voice: DialogueVoiceId, event: SpeakEvent): void {
    this.spoken.push(event.char);
  }

  stop(): void {
    this.stops += 1;
  }
}

const MERCHANT_ID = 'npc.merchant';
const NPC_ENTITY = 42;

function merchant(): DialogueBody {
  return { id: NPC_ENTITY, typeId: MERCHANT_ID, x: 650, y: 520 };
}

/** How long the merchant's opening line takes, so a test can land past its end. */
function greetMs(): number {
  const npc = npcById(MERCHANT_ID);
  if (npc === null) throw new Error('no merchant');
  const first = npc.dialogue.lines.find((line) => line.id === npc.dialogue.start);
  if (first === undefined) throw new Error('the merchant has no opening line');
  return planLine(first.text, npc.voice, `${npc.id}:${first.id}`).durationMs;
}

/** Any lift will do; what is asserted is that a body's is not a sign's. */
const BODY_LIFT = 96;

/**
 * Where the player is standing, for the range release (spec 259).
 *
 * On top of the sign in every test but the one that walks away, because the
 * release is the *only* thing that ends a sign's bubble and a reader parked
 * out of range would close every one of them before it had said anything.
 * Ignored entirely by a conversation with a body, whose release is the
 * server's.
 */
const READER = { x: 300, y: -140 } as const;

interface Harness {
  readonly driver: DialogueDriver;
  readonly sink: Recorder;
  readonly shops: string[];
  readonly leaves: number[];
}

function harness(): Harness {
  const sink = new Recorder();
  const shops: string[] = [];
  const leaves: number[] = [];
  const driver = new DialogueDriver({
    speech: sink,
    bodyLift: BODY_LIFT,
    onShop: (vendorId) => shops.push(vendorId),
    onLeave: () => leaves.push(1),
  });
  return { driver, sink, shops, leaves };
}

/** Drive the reveal the way a frame loop would. */
function run(driver: DialogueDriver, bodies: readonly DialogueBody[], toMs: number, from = 0): void {
  for (let t = from; t <= toMs; t += 8) driver.update(NPC_ENTITY, bodies, t, READER);
}

describe('starting', () => {
  it('opens nothing until the server says so', () => {
    const { driver } = harness();
    driver.update(0, [merchant()], 0, READER);
    expect(driver.active).toBe(false);
    expect(driver.view()).toBeNull();
    expect(driver.speakerId).toBe(0);
  });

  it('opens on the server’s answer, and names the body', () => {
    const { driver } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    expect(driver.active).toBe(true);
    expect(driver.speakerId).toBe(NPC_ENTITY);
    expect(driver.view()?.speaker).toBe(npcById(MERCHANT_ID)?.name);
  });

  it('reveals and speaks as the clock runs', () => {
    const { driver, sink } = harness();
    run(driver, [merchant()], greetMs() + 50);
    const view = driver.view();
    expect(view?.typing).toBe(false);
    expect(view?.text.length).toBeGreaterThan(0);
    expect(sink.spoken.length).toBeGreaterThan(0);
  });

  it('says nothing for a body this build has no row for, and leaves', () => {
    // A `Conversation` naming something the table does not describe. Leaving is
    // the honest answer: the merchant would otherwise stand still forever in
    // front of a client drawing no bubble.
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [{ id: NPC_ENTITY, typeId: 'small_spider', x: 0, y: 0 }], 0, READER);
    expect(driver.active).toBe(false);
    expect(leaves).toHaveLength(1);
  });
});

describe('ending', () => {
  it('ends when the server says it has, and silences the voice', () => {
    // The one case that covers walking away, either body dying, the NPC
    // despawning and somebody else claiming it: all four arrive as this.
    const { driver, sink } = harness();
    run(driver, [merchant()], 60);
    const before = sink.spoken.length;
    driver.update(0, [merchant()], 100, READER);
    expect(driver.active).toBe(false);
    expect(driver.view()).toBeNull();
    expect(sink.stops).toBeGreaterThan(0);
    run(driver, [merchant()], greetMs() + 400, 100);
    // Nothing more was said. `run` re-offers the id, so this also asserts the
    // reveal did not simply resume where it left off.
    expect(sink.spoken.length).toBeGreaterThan(before);
  });

  it('ends when the body leaves the replicated set', () => {
    // Belt and braces beside the server's own release, and the one that closes
    // the gap where a body streams out of interest range while its
    // `Conversation` message is still in flight.
    const { driver, sink } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    driver.update(NPC_ENTITY, [], 16, READER);
    expect(driver.active).toBe(false);
    expect(sink.stops).toBeGreaterThan(0);
  });

  it('tells the server when the player is the one leaving', () => {
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    driver.leave();
    expect(driver.active).toBe(false);
    expect(leaves).toHaveLength(1);
  });

  it('does not tell the server when the server is the one ending it', () => {
    // The asymmetry that matters: answering a release with a release is a
    // message for nothing, and on a reconnect it would race the new session.
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    driver.update(0, [merchant()], 16, READER);
    expect(leaves).toHaveLength(0);
  });

  it('is harmless to leave twice', () => {
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    driver.leave();
    driver.leave();
    driver.leave();
    expect(leaves).toHaveLength(1);
  });

  it('is harmless to leave when nothing is open', () => {
    const { driver, leaves } = harness();
    driver.leave();
    expect(leaves).toHaveLength(0);
  });

  it('swaps cleanly to a second body without leaving the first sounding', () => {
    const { driver, sink } = harness();
    run(driver, [merchant()], 60);
    const other: DialogueBody = { id: 77, typeId: MERCHANT_ID, x: 0, y: 0 };
    driver.update(77, [merchant(), other], 100, READER);
    expect(driver.speakerId).toBe(77);
    expect(sink.stops).toBeGreaterThan(1);
  });
});

describe('acting', () => {
  it('opens the NPC’s own shop from the reply that says so', () => {
    const { driver, shops } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    driver.advance(0);
    driver.choose(0, 0);
    expect(shops).toEqual([npcById(MERCHANT_ID)?.vendorId]);
  });

  it('leaves on the reply that ends the conversation', () => {
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    driver.advance(0);
    driver.choose(2, 0);
    expect(driver.active).toBe(false);
    expect(leaves).toHaveLength(1);
  });

  it('skips the line on the first press and holds on the second', () => {
    const { driver, sink } = harness();
    run(driver, [merchant()], 60);
    driver.advance(60);
    const spoken = sink.spoken.length;
    const view = driver.view();
    expect(view?.typing).toBe(false);
    expect(view?.choices.length).toBeGreaterThan(0);
    // A press on a line waiting for a reply chooses nothing on the player's
    // behalf, and the conversation is still open.
    driver.advance(70);
    expect(driver.active).toBe(true);
    expect(sink.spoken).toHaveLength(spoken);
  });

  it('ignores a press and a reply when nothing is open', () => {
    const { driver, shops, leaves } = harness();
    driver.advance(0);
    driver.choose(0, 0);
    expect(shops).toEqual([]);
    expect(leaves).toEqual([]);
  });

  it('leaves after a line that runs out with no replies', () => {
    // The merchant's `browse` line ends naturally: the last reply leads nowhere,
    // and the conversation should close rather than sit on a bubble with no way
    // out of it.
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    driver.advance(0);
    driver.choose(0, 0);
    driver.advance(0);
    driver.choose(0, 0);
    expect(driver.active).toBe(false);
    expect(leaves.length).toBeGreaterThan(0);
  });
});

describe('the shipped NPCs', () => {
  it('can each be talked to, from the table alone', () => {
    for (const npc of ALL_NPCS) {
      const { driver } = harness();
      driver.update(7, [{ id: 7, typeId: npc.id, x: 0, y: 0 }], 0, READER);
      expect(driver.active, npc.id).toBe(true);
      expect(driver.view()?.speaker, npc.id).toBe(npc.name);
    }
  });
});

/**
 * Spec 259. A sign goes through the whole of the conversation above with two
 * things different, and both are asserted here rather than by reading the code:
 * **the server is never told**, and **nothing sounds**.
 */
describe('reading a sign', () => {
  const SIGN_AT = { x: 300, y: -140 } as const;

  function post(text = 'Beware the bridge.'): SignMark {
    const prop: Prop = {
      kind: 'sign',
      x: SIGN_AT.x,
      y: SIGN_AT.y,
      scale: 1,
      rotation: 0,
      tint: 0,
      text,
    };
    const mark = signMarks([prop])[0];
    if (mark === undefined) throw new Error('a sign with a message makes a mark');
    return mark;
  }

  /** Reveal the way a frame loop would, with no server conversation anywhere. */
  function reveal(driver: DialogueDriver, toMs: number, from = 0): void {
    for (let t = from; t <= toMs; t += 8) driver.update(0, [], t, READER);
  }

  it('opens on this client\'s own say-so, with the server saying nothing', () => {
    // The one place the rule at the top of this file bends, and it does not
    // contradict it: a sign is not a conversation -- there is no body to claim,
    // nothing to be refused and nobody else to be talking to it.
    const { driver } = harness();
    driver.readSign(post(), 0);
    expect(driver.active).toBe(true);
    reveal(driver, 20_000);
    expect(driver.view()?.text).toBe('Beware the bridge.');
    expect(driver.view()?.choices).toEqual([]);
  });

  it('stays open while the server keeps saying there is no conversation', () => {
    // The failure this is written against: `update(0, ...)` is what ends an
    // NPC's conversation, and it arrives on every frame of a sign's.
    const { driver } = harness();
    driver.readSign(post(), 0);
    reveal(driver, 4000);
    expect(driver.active).toBe(true);
  });

  it('speaks nothing and never asks the injected sink for anything', () => {
    const { driver, sink } = harness();
    driver.readSign(post('Beware the bridge, traveller. It has taken carts.'), 0);
    reveal(driver, 20_000);
    expect(sink.spoken).toEqual([]);
    // Not even a stop: the sign's session holds `SILENT_SPEECH`, so the sink
    // this driver was constructed with is never reached at all.
    expect(sink.stops).toBe(0);
  });

  it('tells the server nothing when it is put down', () => {
    // A release for a conversation nobody is having would drop a claim
    // somebody else may be holding on a merchant across the square.
    const { driver, leaves } = harness();
    driver.readSign(post(), 0);
    driver.leave();
    expect(driver.active).toBe(false);
    expect(leaves).toEqual([]);
  });

  it('closes on the confirm press, since a sign has no replies', () => {
    const { driver, leaves } = harness();
    driver.readSign(post(), 0);
    reveal(driver, 20_000);
    driver.advance(20_000);
    expect(driver.active).toBe(false);
    expect(leaves).toEqual([]);
  });

  it('reveals first and closes second, so a press does not skip the line', () => {
    const { driver } = harness();
    driver.readSign(post('Beware the bridge, traveller. It has taken carts.'), 0);
    driver.update(0, [], 0, READER);
    expect(driver.view()?.typing).toBe(true);
    driver.advance(0);
    expect(driver.active).toBe(true);
    expect(driver.view()?.typing).toBe(false);
    driver.advance(0);
    expect(driver.active).toBe(false);
  });

  it('points the bubble at the board, with no body to be found', () => {
    const { driver } = harness();
    driver.readSign(post(), 0);
    driver.update(0, [], 0, READER);
    // `speakerId` is what the *server* has a claim on, and it has none.
    expect(driver.speakerId).toBe(0);
    const focus = driver.focus([]);
    expect(focus).toMatchObject({ entityId: 0, x: SIGN_AT.x, y: SIGN_AT.y, lift: SIGN_BUBBLE_LIFT });
    // And a body's focus uses the body's own lift, so the two cannot be
    // confused by a caller that only reads the point.
    expect(focus?.lift).not.toBe(BODY_LIFT);
  });

  it('is put down by a conversation with a body, rather than opening two bubbles', () => {
    const { driver, leaves } = harness();
    driver.readSign(post(), 0);
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    expect(driver.speakerId).toBe(NPC_ENTITY);
    expect(driver.focus([merchant()])).toMatchObject({ entityId: NPC_ENTITY, lift: BODY_LIFT });
    // The sign was never the server's, so putting it down says nothing.
    expect(leaves).toEqual([]);
  });

  it('puts down a live conversation, and tells the server, when a sign is read', () => {
    // The mirror of the case above: walking off to read a sign mid-sentence is
    // leaving the conversation, and a merchant left holding a claim stands
    // still forever.
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0, READER);
    expect(driver.speakerId).toBe(NPC_ENTITY);
    driver.readSign(post(), 0);
    expect(leaves).toEqual([1]);
    expect(driver.speakerId).toBe(0);
    expect(driver.focus([merchant()])).toMatchObject({ x: SIGN_AT.x, y: SIGN_AT.y });
  });

  it('is put down when the reader walks out of range', () => {
    // The mirror of `sweepConversations` on the server: an NPC's bubble goes
    // when the player leaves `talkRadius`, and a sign's must too or it follows
    // them across the map. Nothing else ends one -- there is no server here.
    const { driver, leaves } = harness();
    driver.readSign(post(), 0);
    driver.update(0, [], 0, READER);
    expect(driver.active).toBe(true);
    driver.update(0, [], 16, { x: READER.x + SIGN_READ_RADIUS + 1, y: READER.y });
    expect(driver.active).toBe(false);
    // And still says nothing to the server, which never knew about it.
    expect(leaves).toEqual([]);
  });

  it('stays open right up to the reach that opened it', () => {
    // One radius for both, spec 246's rule: "close enough to read" should be a
    // single fact a player can learn rather than two with a gap between them.
    const { driver } = harness();
    driver.readSign(post(), 0);
    driver.update(0, [], 0, { x: READER.x + SIGN_READ_RADIUS - 1, y: READER.y });
    expect(driver.active).toBe(true);
  });

  it('has no focus at all once it is closed', () => {
    const { driver } = harness();
    driver.readSign(post(), 0);
    driver.leave();
    expect(driver.focus([])).toBeNull();
  });
});
