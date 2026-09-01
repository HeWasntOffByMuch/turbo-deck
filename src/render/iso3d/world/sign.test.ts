import { describe, expect, it } from 'vitest';
import { MAX_SIGN_TEXT, SIGN_PLAN, signText, type Prop } from '../../../terrain/index.js';
import { PLAYER_RADIUS } from '../../../sim/constants.js';
import { DialogueSession } from './dialogue.js';
import type { SpeakEvent } from '../../audio/dialogue-voice.js';
import type { DialogueVoiceId } from '../../../server/data/dialogue.js';
import type { RayLike } from '../hover.js';
import {
  pickSign,
  SIGN_BUBBLE_LIFT,
  SIGN_READ_RADIUS,
  SignIndex,
  signMarks,
  signSpeaker,
  SILENT_SPEECH,
  type SignMark,
} from './sign.js';

/**
 * Spec 260. A sign is the first thing in this game a click acts on that the sim
 * has never heard of, so everything asserted here is a *client* rule: which
 * post the cursor named, how close the body has to get, and what the bubble is
 * handed. Nothing below sends anything.
 */

const sign = (over: Partial<Prop> = {}): Prop => ({
  kind: 'sign',
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  tint: 0,
  text: 'Hearthstead, two miles',
  ...over,
});

describe('what a sign says', () => {
  it('is null for a message that is blank, absent, or only spaces', () => {
    // One decision in one place: the editor refuses to place one, `signMarks`
    // drops it, and the crosshair never offers it -- all three off this.
    // Built without the key rather than with it set to `undefined`: under
    // `exactOptionalPropertyTypes` those are two different types, and the
    // document produces the first.
    const noText: Prop = { kind: 'sign', x: 0, y: 0, scale: 1, rotation: 0, tint: 0 };
    expect(signText(noText)).toBeNull();
    expect(signText(sign({ text: '' }))).toBeNull();
    expect(signText(sign({ text: '   \n\t ' }))).toBeNull();
  });

  it('is null on a kind that cannot read one, whatever the record holds', () => {
    // An intent a kind does not read is inert rather than an error, which is
    // the rule `light` on a hut already follows.
    expect(signText({ ...sign(), kind: 'house' })).toBeNull();
    expect(signText({ ...sign(), kind: 'campfire' })).toBeNull();
  });

  it('trims and bounds what it does answer', () => {
    expect(signText(sign({ text: '  Beware the bridge.  ' }))).toBe('Beware the bridge.');
    expect(signText(sign({ text: 'x'.repeat(MAX_SIGN_TEXT + 10) }))).toHaveLength(MAX_SIGN_TEXT);
  });
});

describe('the marks a client can read', () => {
  it('drops a sign with nothing on it, and every prop that is not one', () => {
    const marks = signMarks([
      sign({ x: 10, y: 20 }),
      sign({ x: 40, y: 0, text: '  ' }),
      { ...sign({ x: 80, y: 0 }), kind: 'well' },
    ]);
    expect(marks.map((mark) => [mark.x, mark.y])).toEqual([[10, 20]]);
    expect(marks[0]?.text).toBe('Hearthstead, two miles');
  });

  it('keys on the post, so the same sign across a stream is the same sign', () => {
    // A prop has no id, and the client rebuilds its list from the store every
    // time a chunk arrives or is dropped. Position is the one thing about a
    // sign that does not change, and the wire's thousandths round back to it.
    const [before] = signMarks([sign({ x: 1234, y: -567 })]);
    const [after] = signMarks([sign({ x: 1234.0004, y: -566.9996 })]);
    expect(before?.key).toBe(after?.key);
  });

  it('scales its bands with the prop, so a big sign has a big pick volume', () => {
    const [one] = signMarks([sign()]);
    const [two] = signMarks([sign({ scale: 2 })]);
    expect((one?.top ?? 0) - (one?.base ?? 0)).toBeCloseTo(SIGN_PLAN.postHeight + SIGN_PLAN.height, 6);
    expect((two?.top ?? 0) - (two?.base ?? 0)).toBeCloseTo((SIGN_PLAN.postHeight + SIGN_PLAN.height) * 2, 6);
    expect(two?.boardRadius).toBeCloseTo((one?.boardRadius ?? 0) * 2, 6);
  });

  it('names the board wider than it blocks, and the post no wider', () => {
    // The two answer different questions: the collider is what a body walks
    // into, and the board is what a cursor can name. A pick at the collider's
    // radius alone is a six-unit stick to hit at a hundred units of camera
    // distance, and the whole feature is a click.
    const [mark] = signMarks([sign()]);
    expect(mark).toBeDefined();
    expect(mark?.boardRadius).toBeGreaterThan((mark?.radius ?? 0) * 3);
    expect(mark?.radius).toBeCloseTo(SIGN_PLAN.postWidth / 2, 6);
  });

  it('stands its bands on the ground it was sampled at, not on zero', () => {
    // The bug this shape was rebuilt for. The arena's ground is hundreds of
    // units up, so a column assumed to start at zero sits entirely underneath
    // the sign: the board answers nothing at all, and a ray that passes through
    // the buried column on its way down answers `sign` over open ground.
    const [flat] = signMarks([sign()], () => 0);
    const [high] = signMarks([sign()], () => 240);
    expect(flat?.base).toBe(0);
    expect(high?.base).toBe(240);
    expect((high?.top ?? 0) - (flat?.top ?? 0)).toBeCloseTo(240, 6);
    expect((high?.boardBase ?? 0) - (flat?.boardBase ?? 0)).toBeCloseTo(240, 6);
  });

  it('falls back to zero for ground it cannot sample, rather than to NaN', () => {
    // A NaN base makes every comparison in the volume test false, so the sign
    // silently stops being clickable -- which is the same failure as the one
    // above with nothing to see. There is no such case today, and that is why
    // the guard is here rather than in the caller.
    const [none] = signMarks([sign()]);
    const [broken] = signMarks([sign()], () => Number.NaN);
    expect(none?.base).toBe(0);
    expect(broken?.base).toBe(0);
  });
});

describe('which sign the cursor named', () => {
  /**
   * The ground these signs stand on.
   *
   * **Not zero**, and that is the whole point of this suite as it stands: the
   * arena's ground is hundreds of units up, and a pick that assumed a base of
   * zero passed every test written against flat ground while answering nothing
   * at all in the game. Every ray below is aimed relative to `GROUND`, so a
   * volume that ignored the sampled base misses all of them.
   */
  const GROUND = 240;
  const groundAt = (): number => GROUND;
  const marks = (props: readonly Prop[]): readonly SignMark[] => signMarks(props, groundAt);

  /**
   * The bearing this camera looks down.
   *
   * Steep and off-axis, which is the only property that matters here: it is
   * what makes the ground point under a cursor aimed at a board differ from the
   * post the board stands on, and so what makes the volume test worth having.
   * Written out rather than taken from `THREE` because this module runs
   * headlessly -- `pickSign` takes a `RayLike`, so a plain object is a ray.
   */
  const DIR = ((): { x: number; y: number; z: number } => {
    const [x, y, z] = [-0.6, -0.55, -0.58];
    const length = Math.hypot(x, y, z);
    return { x: x / length, y: y / length, z: z / length };
  })();

  /** How far back the camera sits. Orthographic, so any large number will do. */
  const BACK = 3000;

  /** A ray aimed at a world point, from where this camera actually sits. */
  function aimAt(x: number, y: number, z: number): RayLike {
    return {
      origin: { x: x - DIR.x * BACK, y: y - DIR.y * BACK, z: z - DIR.z * BACK },
      direction: DIR,
    };
  }

  /** The point `t` along a ray. */
  function at(ray: RayLike, t: number): { x: number; y: number; z: number } {
    return {
      x: ray.origin.x + ray.direction.x * t,
      y: ray.origin.y + ray.direction.y * t,
      z: ray.origin.z + ray.direction.z * t,
    };
  }

  /** Where that ray meets the ground, which is what the scene hands in. */
  function groundOf(ray: RayLike): { x: number; y: number } {
    const hit = at(ray, (GROUND - ray.origin.y) / ray.direction.y);
    return { x: hit.x, y: hit.z };
  }

  /** World Y at the middle of a sign's board, above ground. */
  const BOARD_Y = GROUND + SIGN_PLAN.postHeight + SIGN_PLAN.height / 2;
  /** World Y half way up a sign's post. */
  const POST_Y = GROUND + SIGN_PLAN.postHeight / 2;

  it('answers the sign whose board the ray enters', () => {
    const all = marks([sign({ x: 200, y: -120 })]);
    const ray = aimAt(200, BOARD_Y, -120);
    expect(pickSign(ray, all, groundOf(ray))?.key).toBe(all[0]?.key);
  });

  it('answers one whose post the ray enters, which is the other half of it', () => {
    const all = marks([sign({ x: 200, y: -120 })]);
    const ray = aimAt(200, POST_Y, -120);
    expect(pickSign(ray, all, groundOf(ray))?.key).toBe(all[0]?.key);
  });

  it('does not claim the air beside the post that the board hangs over', () => {
    // One cylinder sized for the board would: it is seven times wider than the
    // stick holding it up, so from the ground to the eaves there would be a
    // column of nothing answering `sign` either side of every post on the map.
    // Every unit of that is ground a click can no longer walk to, which is the
    // price `hover.ts` records paying once and reversing.
    const all = marks([sign({ x: 0, y: 0 })]);
    const beside = SIGN_PLAN.postWidth / 2 + (SIGN_PLAN.width / 2 - SIGN_PLAN.postWidth / 2) / 2;
    const ray = aimAt(beside, POST_Y, 0);
    expect(pickSign(ray, all, null)).toBeNull();
    // And the same offset at the board's own height is a hit, or the test above
    // is passing because nothing is being found anywhere.
    expect(pickSign(aimAt(beside, BOARD_Y, 0), all, null)).not.toBeNull();
  });

  it('answers nothing where the column would be if the ground were zero', () => {
    // The failure exactly: with a base of zero the volume sits `GROUND` units
    // underneath the sign, so a ray aimed at the board misses and one aimed
    // through open ground hits. Both halves are checked, because a pick that
    // simply never answered would pass the second on its own.
    const all = marks([sign({ x: 0, y: 0 })]);
    const buried = aimAt(0, SIGN_PLAN.postHeight + SIGN_PLAN.height / 2, 0);
    expect(pickSign(buried, all, null)).toBeNull();
    expect(pickSign(aimAt(0, BOARD_Y, 0), all, null)).not.toBeNull();
  });

  it('answers a board even though the ground under the cursor is nowhere near it', () => {
    // The reason the board is tested at all rather than only the footprint: at
    // this pitch the ground under a cursor aimed at the board is metres from
    // the post, and how many metres depends on the camera's elevation.
    const all = marks([sign({ x: 0, y: 0 })]);
    const ray = aimAt(0, BOARD_Y, 0);
    const ground = groundOf(ray);
    expect(Math.hypot(ground.x, ground.y)).toBeGreaterThan(SIGN_PLAN.width);
    expect(pickSign(ray, all, ground)).not.toBeNull();
  });

  it('answers the nearer of two boards the same ray enters', () => {
    // The far sign has to be *genuinely occluded* for this to mean anything,
    // and where that is is not somewhere to guess: the camera looks steeply
    // down, so a second sign on the same ray is one the ray reaches near the
    // ground after passing through the first at board height. Placed by
    // walking the ray rather than by a coordinate, so it cannot quietly stop
    // being on it -- the first cut of this put the far sign at a plausible
    // distance that the ray missed altogether, and passed while proving
    // nothing.
    const ray = aimAt(0, BOARD_Y, 0);
    // Further along the same ray, at the height it has come down to by the time
    // it is near the ground -- which is where a *second* signpost's post band
    // can still be crossed.
    const beyond = at(ray, BACK + (BOARD_Y - (GROUND + 10)) / -ray.direction.y);
    const far = sign({ x: beyond.x, y: beyond.z, text: 'far' });
    // The control: on its own, the far sign *is* under the cursor.
    expect(pickSign(ray, marks([far]), null)?.text).toBe('far');
    // Behind a nearer one, it is not -- whichever order the list is in, since
    // the answer is depth and not iteration.
    const near = sign({ x: 0, y: 0 });
    expect(pickSign(ray, marks([near, far]), null)?.text).toBe(near.text);
    expect(pickSign(ray, marks([far, near]), null)?.text).toBe(near.text);
  });

  it('falls back to the footprint for a click that landed by the post', () => {
    const all = marks([sign({ x: 500, y: 500 })]);
    // Aimed at the ground rather than at the board, which is what a click just
    // beside a signpost is. Inside the **post's** own footprint, since that is
    // the patch of earth a sign occupies -- the board is a metre of air a body
    // walks under, and claiming the ground it overhangs would take a stride of
    // walkable earth out of the game around every signpost on the map.
    const ray = aimAt(500, GROUND, 500);
    expect(pickSign(ray, all, { x: 503, y: 498 })?.key).toBe(all[0]?.key);
    // And a cursor on the ground the board overhangs is *not* the sign: it is
    // ground, and a click there is a walk. Aimed with its own ray, or this is
    // the assertion above asked twice -- a ray pointed at the post's base
    // enters the post band whatever ground point is handed in beside it.
    const aside = { x: 500 + SIGN_PLAN.width / 3, y: 500 };
    expect(pickSign(aimAt(aside.x, GROUND, aside.y), all, aside)).toBeNull();
  });

  it('answers null over bare ground, and over a sign with nothing on it', () => {
    const all = marks([sign({ x: 0, y: 0 })]);
    const ray = aimAt(4000, 0, 4000);
    expect(pickSign(ray, all, { x: 4000, y: 4000 })).toBeNull();
    expect(pickSign(ray, marks([sign({ text: '' })]), { x: 0, y: 0 })).toBeNull();
  });
});

describe('the index a pointer asks sixty times a second', () => {
  /** Ground at zero. What each of these is about is the memo, not the terrain. */
  const FLAT = (): number => 0;

  it('walks the store only when the store has moved on', () => {
    const index = new SignIndex();
    let walks = 0;
    const props = (): readonly Prop[] => {
      walks += 1;
      return [sign()];
    };
    index.update(7, props, FLAT);
    index.update(7, props, FLAT);
    index.update(7, props, FLAT);
    expect(walks).toBe(1);
    index.update(8, props, FLAT);
    expect(walks).toBe(2);
  });

  it('rebuilds on any revision change, not only a bigger one', () => {
    // `revision` only ever grows in the real store, but the index must not be
    // the thing that assumes so: a driver that ignored a smaller number would
    // hold a stale list for the rest of a session against a store that reset.
    const index = new SignIndex();
    index.update(9, () => [sign({ x: 0 })], FLAT);
    index.update(1, () => [sign({ x: 300 })], FLAT);
    expect(index.all.map((mark) => mark.x)).toEqual([300]);
  });

  it('finds a sign by key, and answers null for one that has gone', () => {
    // What a standing order holds. A sign whose ground was evicted mid-walk is
    // gone, and comes back with the same key when the chunk does.
    const index = new SignIndex();
    const [mark] = index.update(1, () => [sign({ x: 120, y: 40 })], FLAT);
    expect(index.find(mark?.key ?? null)?.x).toBe(120);
    index.update(2, () => [], FLAT);
    expect(index.find(mark?.key ?? null)).toBeNull();
    expect(index.find(null)).toBeNull();
  });
});

describe('reading one', () => {
  /** Every vocal event a session emitted. */
  class Recorder {
    readonly spoke: SpeakEvent[] = [];
    stops = 0;
    speak(_voice: DialogueVoiceId, event: SpeakEvent): void {
      this.spoke.push(event);
    }
    stop(): void {
      this.stops += 1;
    }
  }

  const markOf = (text: string): SignMark => signMarks([sign({ text })])[0] as SignMark;

  it('is one line with no replies, so the confirm press closes it', () => {
    const mark = markOf('Beware the bridge.');
    const session = new DialogueSession(signSpeaker(mark), 0, SILENT_SPEECH, 0);
    // Revealed by running the clock well past the line, exactly as a frame loop
    // would.
    for (let t = 0; t <= 20_000; t += 16) session.update(t);
    expect(session.typing).toBe(false);
    expect(session.view.text).toBe('Beware the bridge.');
    expect(session.view.choices).toEqual([]);
    expect(session.view.speaker).not.toBe('');
    expect(session.advance(20_000).kind).toBe('closed');
    expect(session.closed).toBe(true);
  });

  it('reveals over time rather than all at once', () => {
    const mark = markOf('Beware the bridge.');
    const session = new DialogueSession(signSpeaker(mark), 0, SILENT_SPEECH, 0);
    session.update(0);
    const early = session.view.text.length;
    for (let t = 0; t <= 20_000; t += 16) session.update(t);
    expect(early).toBeLessThan(session.view.text.length);
  });

  it('speaks nothing, at any point (spec 260)', () => {
    // The whole of "no sound", and it is asserted through the *sink the driver
    // uses* rather than by reading the code: a recorder in `SILENT_SPEECH`'s
    // place proves the plan has vocal events in it to suppress.
    const heard = new Recorder();
    const mark = markOf('Beware the bridge, traveller. It has taken carts.');
    const loud = new DialogueSession(signSpeaker(mark), 0, heard, 0);
    for (let t = 0; t <= 20_000; t += 16) loud.update(t);
    expect(heard.spoke.length).toBeGreaterThan(0);

    // And the same line through the sink a sign is actually built with.
    const quiet = new DialogueSession(signSpeaker(mark), 0, SILENT_SPEECH, 0);
    for (let t = 0; t <= 20_000; t += 16) quiet.update(t);
    quiet.advance(20_000);
    expect(quiet.view.text).toBe('');
  });

  it('has no body and no vendor, so nothing downstream mistakes it for one', () => {
    const speaker = signSpeaker(markOf('x'));
    expect(speaker.vendorId).toBeNull();
    // Namespaced, so a sign and a monster row can never seed the same reveal.
    expect(speaker.id.startsWith('sign:')).toBe(true);
  });
});

describe('the numbers a sign is reached and drawn by', () => {
  it('puts the reach outside the post, by more than a body', () => {
    // Or the walk would end inside the thing being read and never arrive.
    expect(SIGN_READ_RADIUS).toBeGreaterThan(SIGN_PLAN.postWidth / 2 + PLAYER_RADIUS);
  });

  it('points the bubble above the board rather than into it', () => {
    expect(SIGN_BUBBLE_LIFT).toBeGreaterThan(SIGN_PLAN.postHeight + SIGN_PLAN.height);
  });
});
