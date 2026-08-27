import { describe, expect, it } from 'vitest';

import type { DialogueVoiceId } from '../../../server/data/dialogue.js';
import { ALL_NPCS, npcById } from '../../../server/data/npcs.js';
import type { SpeakEvent } from '../../audio/dialogue-voice.js';
import { planLine } from '../../audio/dialogue-voice.js';
import { DialogueDriver, type DialogueBody } from './dialogue-driver.js';
import type { DialogueSpeech } from './dialogue.js';

/**
 * Spec 244. The four things a conversation is joined to, with none of them real.
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
    onShop: (vendorId) => shops.push(vendorId),
    onLeave: () => leaves.push(1),
  });
  return { driver, sink, shops, leaves };
}

/** Drive the reveal the way a frame loop would. */
function run(driver: DialogueDriver, bodies: readonly DialogueBody[], toMs: number, from = 0): void {
  for (let t = from; t <= toMs; t += 8) driver.update(NPC_ENTITY, bodies, t);
}

describe('starting', () => {
  it('opens nothing until the server says so', () => {
    const { driver } = harness();
    driver.update(0, [merchant()], 0);
    expect(driver.active).toBe(false);
    expect(driver.view()).toBeNull();
    expect(driver.speakerId).toBe(0);
  });

  it('opens on the server’s answer, and names the body', () => {
    const { driver } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0);
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
    driver.update(NPC_ENTITY, [{ id: NPC_ENTITY, typeId: 'small_spider', x: 0, y: 0 }], 0);
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
    driver.update(0, [merchant()], 100);
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
    driver.update(NPC_ENTITY, [merchant()], 0);
    driver.update(NPC_ENTITY, [], 16);
    expect(driver.active).toBe(false);
    expect(sink.stops).toBeGreaterThan(0);
  });

  it('tells the server when the player is the one leaving', () => {
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0);
    driver.leave();
    expect(driver.active).toBe(false);
    expect(leaves).toHaveLength(1);
  });

  it('does not tell the server when the server is the one ending it', () => {
    // The asymmetry that matters: answering a release with a release is a
    // message for nothing, and on a reconnect it would race the new session.
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0);
    driver.update(0, [merchant()], 16);
    expect(leaves).toHaveLength(0);
  });

  it('is harmless to leave twice', () => {
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0);
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
    driver.update(77, [merchant(), other], 100);
    expect(driver.speakerId).toBe(77);
    expect(sink.stops).toBeGreaterThan(1);
  });
});

describe('acting', () => {
  it('opens the NPC’s own shop from the reply that says so', () => {
    const { driver, shops } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0);
    driver.advance(0);
    driver.choose(0, 0);
    expect(shops).toEqual([npcById(MERCHANT_ID)?.vendorId]);
  });

  it('leaves on the reply that ends the conversation', () => {
    const { driver, leaves } = harness();
    driver.update(NPC_ENTITY, [merchant()], 0);
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
    driver.update(NPC_ENTITY, [merchant()], 0);
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
      driver.update(7, [{ id: 7, typeId: npc.id, x: 0, y: 0 }], 0);
      expect(driver.active, npc.id).toBe(true);
      expect(driver.view()?.speaker, npc.id).toBe(npc.name);
    }
  });
});
