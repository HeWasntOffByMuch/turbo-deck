import { beforeEach, describe, expect, it } from 'vitest';

import { scriptProblems, type DialogueScript, type DialogueVoiceId } from '../../../server/data/dialogue.js';
import { ALL_NPCS, npcById, type NpcDefinition } from '../../../server/data/npcs.js';
import type { SpeakEvent } from '../../audio/dialogue-voice.js';
import { planLine } from '../../audio/dialogue-voice.js';
import { DialogueSession, type DialogueSpeech } from './dialogue.js';

/**
 * A conversation in progress (spec 244).
 *
 * The whole feature driven with no `AudioContext` and no canvas: the sink is a
 * recorder, so "what was spoken" is a list and "nothing survived the bubble" is
 * an assertion rather than something somebody has to notice not hearing.
 */

class Recorder implements DialogueSpeech {
  readonly spoken: { voice: DialogueVoiceId; char: string; index: number }[] = [];
  stops = 0;

  speak(voice: DialogueVoiceId, event: SpeakEvent, index: number): void {
    this.spoken.push({ voice, char: event.char, index });
  }

  stop(): void {
    this.stops += 1;
  }
}

const SCRIPT: DialogueScript = {
  start: 'greet',
  lines: [
    {
      id: 'greet',
      text: 'Hello there?',
      choices: [
        { text: 'Shop.', go: 'browse', opens: 'shop' },
        { text: 'Who?', go: 'who' },
        { text: 'Bye.', go: null },
        { text: 'Shop and leave.', go: null, opens: 'shop' },
      ],
    },
    { id: 'who', text: 'Rell.', choices: [{ text: 'Ah.', go: null }] },
    { id: 'browse', text: 'Take your time.', choices: [] },
  ],
};

const NPC: NpcDefinition = {
  id: 'test.npc',
  name: 'Tester',
  talkRadius: 100,
  voice: { voice: 'soft' },
  vendorId: 'vendor.test',
  dialogue: SCRIPT,
};

/** How long the opening line takes, so a test can land exactly past its end. */
const GREET_MS = planLine('Hello there?', NPC.voice, `${NPC.id}:greet`).durationMs;

let sink: Recorder;
function session(npc: NpcDefinition = NPC): DialogueSession {
  sink = new Recorder();
  return new DialogueSession(npc, 7, sink, 0);
}

/** Drive the reveal in small steps, the way a frame loop would. */
function run(dialogue: DialogueSession, toMs: number, stepMs = 8): void {
  for (let t = 0; t <= toMs; t += stepMs) dialogue.update(t);
}

beforeEach(() => {
  sink = new Recorder();
});

describe('reveal', () => {
  it('starts empty and typing', () => {
    const dialogue = session();
    expect(dialogue.view.text).toBe('');
    expect(dialogue.view.typing).toBe(true);
    expect(dialogue.view.speaker).toBe('Tester');
  });

  it('reveals progressively rather than all at once', () => {
    const dialogue = session();
    run(dialogue, GREET_MS / 2);
    const half = dialogue.view.text;
    expect(half.length).toBeGreaterThan(0);
    expect(half.length).toBeLessThan('Hello there?'.length);
    expect('Hello there?').toContain(half);
  });

  it('finishes the line, and only then offers the replies', () => {
    const dialogue = session();
    run(dialogue, GREET_MS / 2);
    // The rule the requirement states: a reply a player could press before the
    // question had finished being asked is a reply to something unread.
    expect(dialogue.view.choices).toEqual([]);
    run(dialogue, GREET_MS + 50);
    expect(dialogue.view.text).toBe('Hello there?');
    expect(dialogue.view.typing).toBe(false);
    expect(dialogue.view.choices).toEqual(['Shop.', 'Who?', 'Bye.', 'Shop and leave.']);
  });

  it('crosses several characters in one long frame', () => {
    // A frame is many milliseconds and this environment paints a real page at
    // about five a second. Revealing one character per call would make the line
    // take as long as the frame rate says rather than as long as it should.
    const dialogue = session();
    dialogue.update(GREET_MS / 2);
    expect(dialogue.view.text.length).toBeGreaterThan(1);
  });

  it('speaks while revealing, and not on every character', () => {
    const dialogue = session();
    run(dialogue, GREET_MS + 50);
    expect(sink.spoken.length).toBeGreaterThan(0);
    expect(sink.spoken.length).toBeLessThan('Hello there?'.length);
    for (const spoken of sink.spoken) expect(spoken.voice).toBe('soft');
  });

  it('speaks a character only once however often it is updated', () => {
    const dialogue = session();
    for (let i = 0; i < 8; i++) run(dialogue, GREET_MS + 50);
    const indices = sink.spoken.map((spoken) => spoken.index);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('does not go backwards when handed a stale clock', () => {
    const dialogue = session();
    run(dialogue, GREET_MS + 50);
    const settled = dialogue.view.text;
    dialogue.update(0);
    expect(dialogue.view.text).toBe(settled);
  });
});

describe('skipping', () => {
  it('reveals the whole line and keeps the bubble open', () => {
    const dialogue = session();
    run(dialogue, 60);
    const outcome = dialogue.advance(60);
    expect(outcome).toEqual({ kind: 'revealed' });
    expect(dialogue.view.text).toBe('Hello there?');
    expect(dialogue.closed).toBe(false);
    expect(dialogue.view.choices).toHaveLength(4);
  });

  it('does not play a burst of the sounds it skipped', () => {
    // The handoff spec's third skip rule, and the one a scheduled design gets
    // wrong: nothing here is ever scheduled ahead, so skipping cannot release
    // anything. Asserted by counting: the sounds after a skip are the ones that
    // had already been spoken before it.
    const dialogue = session();
    run(dialogue, 60);
    const before = sink.spoken.length;
    dialogue.advance(60);
    expect(sink.spoken).toHaveLength(before);
    // And still nothing once the clock passes where the rest would have been.
    run(dialogue, GREET_MS + 200);
    expect(sink.spoken).toHaveLength(before);
  });

  it('advances on the second press once the line is whole', () => {
    const dialogue = session(withScript({ start: 'only', lines: [{ id: 'only', text: 'Hi.', choices: [] }] }));
    run(dialogue, 20);
    expect(dialogue.advance(20)).toEqual({ kind: 'revealed' });
    expect(dialogue.advance(30)).toEqual({ kind: 'closed' });
  });

  it('does nothing on a press while a line is waiting for a reply', () => {
    // Advancing past a question would be choosing on the player's behalf.
    const dialogue = session();
    run(dialogue, GREET_MS + 50);
    expect(dialogue.advance(GREET_MS + 50)).toEqual({ kind: 'none' });
    expect(dialogue.closed).toBe(false);
  });

  it('is harmless to press repeatedly', () => {
    const dialogue = session();
    for (let i = 0; i < 5; i++) dialogue.advance(10);
    expect(dialogue.view.text).toBe('Hello there?');
    expect(dialogue.closed).toBe(false);
  });
});

describe('choices', () => {
  it('follows a reply to its line and starts revealing again', () => {
    const dialogue = session();
    dialogue.advance(0);
    expect(dialogue.choose(1, 0)).toEqual({ kind: 'none' });
    expect(dialogue.view.typing).toBe(true);
    expect(dialogue.view.text).toBe('');
    run(dialogue, 400);
    expect(dialogue.view.text).toBe('Rell.');
  });

  it('opens the shop from the reply that says so, and keeps talking', () => {
    const dialogue = session();
    dialogue.advance(0);
    expect(dialogue.choose(0, 0)).toEqual({ kind: 'shop', vendorId: 'vendor.test' });
    expect(dialogue.closed).toBe(false);
    run(dialogue, 900);
    expect(dialogue.view.text).toBe('Take your time.');
  });

  it('opens the shop from a reply that also ends the conversation', () => {
    const dialogue = session();
    dialogue.advance(0);
    expect(dialogue.choose(3, 0)).toEqual({ kind: 'shop', vendorId: 'vendor.test' });
    expect(dialogue.closed).toBe(true);
  });

  it('closes on the reply that leads nowhere', () => {
    const dialogue = session();
    dialogue.advance(0);
    expect(dialogue.choose(2, 0)).toEqual({ kind: 'closed' });
    expect(dialogue.closed).toBe(true);
  });

  it('ends naturally on a line with no replies', () => {
    const dialogue = session();
    dialogue.advance(0);
    dialogue.choose(0, 0);
    dialogue.advance(0);
    expect(dialogue.view.choices).toEqual([]);
    expect(dialogue.advance(0)).toEqual({ kind: 'closed' });
  });

  it('refuses a reply while the line is still typing', () => {
    const dialogue = session();
    run(dialogue, 40);
    expect(dialogue.view.typing).toBe(true);
    expect(dialogue.choose(2, 40)).toEqual({ kind: 'none' });
    expect(dialogue.closed).toBe(false);
  });

  it('refuses a reply that does not exist', () => {
    const dialogue = session();
    dialogue.advance(0);
    expect(dialogue.choose(99, 0)).toEqual({ kind: 'none' });
    expect(dialogue.choose(-1, 0)).toEqual({ kind: 'none' });
    expect(dialogue.closed).toBe(false);
  });

  it('offers no shop for an NPC that has none', () => {
    const dialogue = session({ ...NPC, vendorId: null });
    dialogue.advance(0);
    expect(dialogue.choose(0, 0)).toEqual({ kind: 'none' });
  });

  it('can come back to a line it has already been through', () => {
    // The whole reason `go` is an id rather than a nested line: asking who
    // somebody is must not cost the chance to shop, and nothing remembers that
    // the question was asked.
    const dialogue = session();
    dialogue.advance(0);
    dialogue.choose(1, 0);
    run(dialogue, 400);
    expect(dialogue.view.choices).toEqual(['Ah.']);
  });
});

describe('cancellation', () => {
  it('stops the voice and reveals nothing more when it ends mid-word', () => {
    const dialogue = session();
    run(dialogue, 60);
    const before = sink.spoken.length;
    expect(sink.stops).toBe(1); // the one from starting the first line
    dialogue.end();
    expect(sink.stops).toBe(2);
    run(dialogue, GREET_MS + 500);
    expect(sink.spoken).toHaveLength(before);
    expect(dialogue.view.text).toBe('');
  });

  it('stops the previous line before the next one begins', () => {
    // Two lines must never overlap in the ear, even where the second begins
    // mid-syllable of the first.
    const dialogue = session();
    dialogue.advance(0);
    const before = sink.stops;
    dialogue.choose(1, 0);
    expect(sink.stops).toBe(before + 1);
  });

  it('is idempotent, because more than one thing can end a conversation', () => {
    // A despawn and a range check on the same frame; a close from the screen
    // and the server's own release.
    const dialogue = session();
    dialogue.end();
    const stops = sink.stops;
    expect(dialogue.end()).toEqual({ kind: 'closed' });
    expect(dialogue.end()).toEqual({ kind: 'closed' });
    expect(sink.stops).toBe(stops);
  });

  it('refuses everything once closed', () => {
    const dialogue = session();
    dialogue.end();
    expect(dialogue.advance(0)).toEqual({ kind: 'closed' });
    expect(dialogue.choose(0, 0)).toEqual({ kind: 'none' });
    expect(dialogue.view.choices).toEqual([]);
    expect(dialogue.view.typing).toBe(false);
  });

  it('bumps the generation on every line change and on the end', () => {
    const dialogue = session();
    const first = dialogue.generation;
    dialogue.advance(0);
    dialogue.choose(1, 0);
    expect(dialogue.generation).toBeGreaterThan(first);
    const second = dialogue.generation;
    dialogue.end();
    expect(dialogue.generation).toBeGreaterThan(second);
  });

  it('ends rather than hanging on a reply that names no line', () => {
    const broken = withScript({
      start: 'a',
      lines: [{ id: 'a', text: 'Hm.', choices: [{ text: 'go', go: 'nowhere' }] }],
    });
    const dialogue = session(broken);
    dialogue.advance(0);
    expect(dialogue.choose(0, 0)).toEqual({ kind: 'none' });
    expect(dialogue.closed).toBe(true);
  });
});

describe('the shipped NPCs', () => {
  it('has at least one', () => {
    expect(ALL_NPCS.length).toBeGreaterThan(0);
  });

  it('gives every NPC a script with no dead replies', () => {
    // A dead `go` is invisible from inside the data: the reply renders, the
    // player presses it, and the conversation ends as though they had chosen to
    // leave.
    for (const npc of ALL_NPCS) {
      expect(scriptProblems(npc.dialogue), npc.id).toEqual([]);
    }
  });

  it('lets the merchant reach its shop and its own answer, and leave', () => {
    const merchant = npcById('npc.merchant');
    if (merchant === null) throw new Error('the merchant has no row');
    const opened = (): DialogueSession => {
      const started = new DialogueSession(merchant, 1, new Recorder(), 0);
      started.advance(0);
      return started;
    };

    // The three replies the requirement names.
    expect(opened().view.choices.length).toBeGreaterThanOrEqual(3);

    // "Show me what you've got." opens the shop.
    expect(opened().choose(0, 0)).toEqual({ kind: 'shop', vendorId: merchant.vendorId });

    // "Who are you?" answers and comes back to a set of replies.
    const who = opened();
    expect(who.choose(1, 0)).toEqual({ kind: 'none' });
    who.advance(0);
    expect(who.view.choices.length).toBeGreaterThan(0);
    expect(who.closed).toBe(false);

    // "Never mind." closes it.
    expect(opened().choose(2, 0)).toEqual({ kind: 'closed' });
  });

  it('gives every NPC a voice the synthesiser has', () => {
    const voices: readonly DialogueVoiceId[] = ['soft', 'chirpy', 'warm', 'nasal'];
    for (const npc of ALL_NPCS) expect(voices, npc.id).toContain(npc.voice.voice);
  });
});

function withScript(script: DialogueScript): NpcDefinition {
  return { ...NPC, dialogue: script };
}
