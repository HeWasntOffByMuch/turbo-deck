import { footprintRadius, signText, SIGN_PLAN, type Prop } from '../../../terrain/index.js';
import type { Vec2 } from '../../../sim/types.js';
import type { DialogueSpeaker, DialogueSpeech } from './dialogue.js';
import { rayBodyDistance, type RayLike } from '../hover.js';
import { PLAYER_RADIUS } from '../../../sim/constants.js';

/**
 * What a sign is to the client that reads it (spec 259).
 *
 * Pure: no three.js, no DOM, no clock, and -- the part that matters -- **no
 * server**. A sign is the first thing in this
 * game a click acts on that the sim has never heard of, and that is what a sign
 * *is* rather than a shortcut. Spec 246 put a conversation on the server because
 * it is a claim on a body that would otherwise wander off mid-sentence; a board
 * nailed to a post is not going anywhere, holds nothing and sells nothing, so
 * there is no state to arbitrate and nobody for a second reader to be refused
 * by. Two players read the same sign at the same time and neither notices.
 *
 * Nothing here changes a game outcome, which is the rule `src/render/` lives
 * under: reading a sign deals no damage, moves no item and writes nothing the
 * server can see. The *walk* to it goes out as ordinary movement input, exactly
 * as click-to-move already does.
 */

/** The words on one sign, and the shape a cursor can name it by. */
export interface SignMark {
  /**
   * Identity, for an order that has to survive the frames between the click and
   * the arrival.
   *
   * Derived from where the sign stands rather than stored, because **a prop has
   * no id**: a `Prop` is an anonymous record in a chunk's list, and the client
   * rebuilds its list from the streamed store every time it is asked. Position
   * is the one thing about a sign that does not change -- nothing in this game
   * moves a prop -- so keying on it is stable for exactly as long as the sign
   * exists, which is longer than any order.
   */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  /** What it says. Never blank: {@link signMarks} drops a sign with no message. */
  readonly text: string;
  /** The post, as the sim collides with it. */
  readonly radius: number;
  /** How far the top of the board stands above the ground it is filed at. */
  readonly height: number;
}

/** The key {@link SignMark.key} takes, so a caller can build one to compare. */
function keyOf(prop: Prop): string {
  // Rounded, so a coordinate that went through the wire's thousandths and back
  // is the same key as the one the document holds. Whole units, because two
  // signs a unit apart are two signs occupying the same post.
  return `${Math.round(prop.x)}:${Math.round(prop.y)}`;
}

/**
 * The signs among these props that have anything to say.
 *
 * A sign with a blank message is dropped here rather than marked unreadable
 * further along, and that is one decision in one place: `signText` is what
 * decides, so a sign nobody typed a message into is a post the cursor slides
 * over and a click walks past -- the same answer the editor gives when it
 * refuses to place one.
 */
export function signMarks(props: readonly Prop[]): readonly SignMark[] {
  const marks: SignMark[] = [];
  for (const prop of props) {
    const text = signText(prop);
    if (text === null) continue;
    const scale = Number.isFinite(prop.scale) && prop.scale > 0 ? prop.scale : 1;
    marks.push({
      key: keyOf(prop),
      x: prop.x,
      y: prop.y,
      text,
      radius: footprintRadius(prop),
      height: (SIGN_PLAN.postHeight + SIGN_PLAN.height) * scale,
    });
  }
  return marks;
}

/**
 * The sign the cursor is asking for, or null.
 *
 * `hover.ts`'s two tests with the meshes left out. The board first, through the
 * volume test that file already exports, then the ground footprint -- and both
 * are needed for the reason the editor's marker tool records: **a sign's board
 * is not where a sign is filed.** The board stands a body's height up, so at
 * this camera's pitch the ground under a cursor aimed squarely at it is metres
 * from the post, and how many metres depends on the elevation the player has
 * the Height slider at. Aiming at the picture is exact at every angle; the
 * footprint is what catches a click that landed by the post instead.
 *
 * There are no meshes to test because a sign's are instanced into a shared
 * batch with every other sign in the region -- a raycast against that object
 * answers "some sign", which is not the question. The volume is a better
 * description of a signpost than its own geometry is anyway: what a player is
 * pointing at is the board, and the board fills its volume.
 */
export function pickSign(
  ray: RayLike,
  marks: readonly SignMark[],
  ground: Vec2 | null,
): SignMark | null {
  return pickBoard(ray, marks) ?? pickFootprint(ground, marks);
}

/**
 * How wide the *pick* volume is, against how wide the collider is.
 *
 * Half the board rather than half the post, and stated as its own function
 * because the two answer different questions and the difference is the whole
 * reason a sign is clickable at all: the collider is what a body walks into,
 * and the pick is what a cursor can name. A pick at the collider's radius is a
 * six-unit stick to hit at a hundred units of camera distance.
 */
export function pickRadius(mark: SignMark): number {
  return (mark.radius / (SIGN_PLAN.postWidth / 2)) * (SIGN_PLAN.width / 2);
}

/** The nearest sign whose board the ray enters. */
function pickBoard(ray: RayLike, marks: readonly SignMark[]): SignMark | null {
  let best: SignMark | null = null;
  let bestDistance = Infinity;
  for (const mark of marks) {
    const distance = rayBodyDistance(ray, {
      position: { x: mark.x, y: mark.y },
      // The *pick* volume is the board, not the post: a signpost the cursor
      // could only name by its stick is a signpost nobody clicks.
      radius: pickRadius(mark),
      // The whole post-and-board column, from the ground it is filed at. A
      // volume that started at the board would refuse a cursor on the post,
      // which is a perfectly ordinary place to point at a signpost.
      base: groundOf(mark),
      height: mark.height,
    });
    if (distance === null || distance >= bestDistance) continue;
    best = mark;
    bestDistance = distance;
  }
  return best;
}

/**
 * The ground a sign's column stands on.
 *
 * Zero, and that is a stated approximation rather than an oversight: a
 * `SignMark` carries no height because nothing that builds one has sampled the
 * terrain, and the alternative -- threading `scene.ground` into a pure module --
 * would buy accuracy in the one case it cannot matter. The column is 96 units
 * tall against ground that moves by a few between one prop and the next, so a
 * ray aimed at the board enters the column either way; what an unsampled base
 * costs is a cursor on the very bottom of the post over steep ground, which the
 * footprint test below answers anyway.
 */
function groundOf(_mark: SignMark): number {
  return 0;
}

/** The nearest sign whose footprint holds the ground cursor. */
function pickFootprint(cursor: Vec2 | null, marks: readonly SignMark[]): SignMark | null {
  if (!cursor) return null;
  let best: SignMark | null = null;
  let bestDistSq = Infinity;
  for (const mark of marks) {
    const dx = mark.x - cursor.x;
    const dy = mark.y - cursor.y;
    const distSq = dx * dx + dy * dy;
    const reach = pickRadius(mark);
    if (distSq > reach * reach || distSq >= bestDistSq) continue;
    best = mark;
    bestDistSq = distSq;
  }
  return best;
}

/**
 * The signs this client is holding ground for, rebuilt only when that changes.
 *
 * `StreamedMap.props()` walks every chunk in the store on every call -- which is
 * right for the caller it was written for, since the prop field is rebuilt from
 * the whole list anyway, and wrong for a question the pointer asks on every
 * mouse move. So it is memoized on the store's **revision**, which is spec 215's
 * number and the only honest key: `size` is bounded by the keep window and so
 * cannot tell "nothing changed" from "one chunk arrived as another was dropped",
 * where `revision` counts inserts *and* removals and only ever grows.
 *
 * The props are passed as a thunk rather than an array for exactly that reason:
 * the walk is what is being avoided, so a caller that had to produce the list
 * before finding out it was not needed would have paid for it anyway.
 */
export class SignIndex {
  private marks: readonly SignMark[] = [];
  private revision = -1;

  /** The signs, rebuilding first if the store has moved on. */
  update(revision: number, props: () => readonly Prop[]): readonly SignMark[] {
    if (revision !== this.revision) {
      this.revision = revision;
      this.marks = signMarks(props());
    }
    return this.marks;
  }

  /** What the last {@link update} answered, without asking again. */
  get all(): readonly SignMark[] {
    return this.marks;
  }

  /**
   * The sign with this key, or null.
   *
   * How an order survives the walk: it holds a key rather than a mark, so a
   * sign whose chunk was evicted and streamed back is the same sign, and one
   * that was erased from the map under a live order is simply gone -- which is
   * the rule spec 222 states for the editor's marker selection, one system over.
   */
  find(key: string | null): SignMark | null {
    if (key === null) return null;
    return this.marks.find((mark) => mark.key === key) ?? null;
  }
}

/**
 * How high above a sign's foot the bubble points.
 *
 * Derived from the plan rather than shared with the body's lift, because the
 * two are different heights: a sign's board tops out where it tops out, and a
 * bubble hung at a body's headroom would float well clear of a post that is
 * shorter than a player. Clear of the board by a little, so the tail points at
 * the thing being read rather than into it.
 */
export const SIGN_BUBBLE_LIFT = SIGN_PLAN.postHeight + SIGN_PLAN.height + 18;

/**
 * How close a player has to be standing to read one.
 *
 * The client's own number, because there is nobody to agree with: no server
 * checks this, so it is not a prediction of anything the way `talkRadius` is.
 * What it has to clear is the post plus a body, or the reach would be *inside*
 * the thing being read and the walk would never end -- and then enough on top
 * that a player who stopped in front of a sign is reading it rather than
 * standing on it.
 */
export const SIGN_READ_RADIUS = SIGN_PLAN.postWidth / 2 + PLAYER_RADIUS + 56;

/**
 * A sign as something the dialogue can be handed (spec 259).
 *
 * One line, no replies, no vendor. `DialogueSession` reads exactly these five
 * fields, so a sign goes through the whole of spec 246's conversation -- the
 * reveal, the skip, the bubble, the camera leaning in -- with nothing about it
 * special-cased. What it is not is an `NpcDefinition`: it has no monster row, no
 * `talkRadius` the server enforces and no body, and a synthetic one would be
 * three lies to buy a type.
 *
 * The voice is authored and never sounds, because {@link SILENT_SPEECH} is what
 * the session is built with. A row is still needed: `planLine` reads it to work
 * out *when* each character appears, which is the reveal a player watches.
 */
export function signSpeaker(mark: SignMark): DialogueSpeaker {
  return {
    // Namespaced so it can never collide with a monster row id, which is what
    // seeds `planLine`'s per-line hash: two signs saying the same thing should
    // reveal identically, and a sign and an NPC saying it should not have to.
    id: `sign:${mark.key}`,
    name: SIGN_SPEAKER_NAME,
    // Any row would do while nothing sounds. `soft` is chosen rather than
    // arbitrary: its speed is what sets the reveal rate, and a sign is read at
    // an unhurried pace.
    voice: { voice: 'soft' },
    vendorId: null,
    dialogue: {
      start: 'text',
      lines: [{ id: 'text', text: mark.text, choices: [] }],
    },
  };
}

/**
 * What the bubble calls a sign.
 *
 * It has to be *something*: `DialogueScreen` hides itself on an empty speaker,
 * which is the right rule for a conversation and would make a sign invisible.
 * A word rather than the sign's own text repeated, because the header is what
 * says where the words came from and "Sign" is the whole answer.
 */
export const SIGN_SPEAKER_NAME = 'Sign';

/**
 * A sink that starts nothing and so owes no stop (spec 259).
 *
 * The whole of "a sign makes no sound", and it is a sink rather than a voice at
 * zero volume for the reason `dialogue.ts` gives for `DialogueSpeech` having a
 * `stop` at all: a sink that can start a sound owes a way to end one, and the
 * cheapest thing that cannot go wrong is one that never starts.
 */
export const SILENT_SPEECH: DialogueSpeech = {
  speak(): void {
    // Deliberately nothing. See the note above.
  },
  stop(): void {
    // Nothing was started, so there is nothing to stop.
  },
};
