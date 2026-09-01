import { footprintRadius, signText, SIGN_PLAN, type Prop } from '../../../terrain/index.js';
import type { Vec2 } from '../../../sim/types.js';
import type { DialogueSpeaker, DialogueSpeech } from './dialogue.js';
import { rayBodyDistance, type RayLike, type RayVolume } from '../hover.js';
import { PLAYER_RADIUS } from '../../../sim/constants.js';

/**
 * What a sign is to the client that reads it (spec 260).
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

/**
 * How far a body's ground height is sampled from, when a sign's own is not
 * known yet.
 *
 * There is no such case today -- a sign's chunk carries the ground it stands on,
 * so a mark only exists once that ground is held -- and the fallback exists
 * because {@link SignMark.base} being *wrong* is the failure this whole shape
 * was rebuilt for and a silent zero is exactly how it looked.
 */
const UNKNOWN_GROUND = 0;

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
  /** Half the board's span. What the cursor can name the *board* by. */
  readonly boardRadius: number;
  /**
   * World Y of the ground the post stands on.
   *
   * **Sampled, not assumed.** The first cut of this took it as zero and called
   * that a stated approximation, which was wrong in the one way that mattered:
   * the arena's ground is hundreds of units up, so the pick column sat entirely
   * below the sign -- the board answered nothing at all, and a swathe of ground
   * near the post answered `sign`, which is exactly what a ray passing through
   * an underground column looks like from a camera pitched down at it.
   */
  readonly base: number;
  /** World Y where the post ends and the board begins. */
  readonly boardBase: number;
  /** World Y of the top of the board. */
  readonly top: number;
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
export function signMarks(props: readonly Prop[], groundAt?: GroundAt): readonly SignMark[] {
  const marks: SignMark[] = [];
  for (const prop of props) {
    const text = signText(prop);
    if (text === null) continue;
    const scale = Number.isFinite(prop.scale) && prop.scale > 0 ? prop.scale : 1;
    const sampled = groundAt?.(prop.x, prop.y);
    const base = Number.isFinite(sampled) ? (sampled as number) : UNKNOWN_GROUND;
    marks.push({
      key: keyOf(prop),
      x: prop.x,
      y: prop.y,
      text,
      radius: footprintRadius(prop),
      boardRadius: (SIGN_PLAN.width / 2) * scale,
      base,
      boardBase: base + SIGN_PLAN.postHeight * scale,
      top: base + (SIGN_PLAN.postHeight + SIGN_PLAN.height) * scale,
    });
  }
  return marks;
}

/**
 * Where the ground is under a world point.
 *
 * The renderer's own `WorldScene.groundAt`, handed in rather than sampled here:
 * it is the same answer the bubble's anchor is projected through, so the volume
 * a cursor names and the point a bubble hangs over cannot disagree about where
 * a sign is standing.
 */
export type GroundAt = (x: number, z: number) => number;

/**
 * The sign the cursor is asking for, or null.
 *
 * `hover.ts`'s two tests with the meshes left out, and with the volume in
 * **two bands rather than one**: the board, then the post, then the ground
 * footprint. All three are needed and the split is not fussiness --
 *
 *  - the **board** is what a player aims at, and it is seven times wider than
 *    the stick holding it up, so one cylinder sized for the board would claim a
 *    column of empty air either side of the post from the ground up;
 *  - the **post** is what is under the cursor when somebody aims at the bottom
 *    of a signpost, which is an ordinary thing to do;
 *  - the **footprint** catches a click that landed on the patch of earth the
 *    post occupies, exactly as it does for a unit.
 *
 * Every band is measured from {@link SignMark.base}, the sampled ground, and
 * that is the whole of what this got wrong first: with the base assumed to be
 * zero the column sat hundreds of units underneath the sign on real terrain, so
 * the board answered nothing and a ray that passed through the buried column on
 * its way down answered `sign` over open ground.
 *
 * There are no meshes to test because a sign's are instanced into a shared
 * batch with every other sign in the region -- a raycast against that object
 * answers "some sign", which is not the question. The bands are a better
 * description of a signpost than its own geometry is anyway.
 */
export function pickSign(
  ray: RayLike,
  marks: readonly SignMark[],
  ground: Vec2 | null,
): SignMark | null {
  return pickBand(ray, marks, board) ?? pickBand(ray, marks, post) ?? pickFootprint(ground, marks);
}

/** One band of a sign's pick volume, as {@link rayBodyDistance} wants it. */
type Band = (mark: SignMark) => RayVolume;

/** The board: wide, and only over its own height. */
const board: Band = (mark) => ({
  position: { x: mark.x, y: mark.y },
  radius: mark.boardRadius,
  base: mark.boardBase,
  height: Math.max(0, mark.top - mark.boardBase),
});

/** The post: the stick, from the ground to the underside of the board. */
const post: Band = (mark) => ({
  position: { x: mark.x, y: mark.y },
  // The collider, and no wider. Forgiveness here is not free: `issueOrder`
  // reads a sign before it reads the ground, so every unit of slack is ground
  // the player can no longer click to walk to -- which is the price `hover.ts`
  // records paying once already and reversing.
  radius: mark.radius,
  base: mark.base,
  height: Math.max(0, mark.boardBase - mark.base),
});

/** The nearest sign whose band the ray enters. */
function pickBand(ray: RayLike, marks: readonly SignMark[], band: Band): SignMark | null {
  let best: SignMark | null = null;
  let bestDistance = Infinity;
  for (const mark of marks) {
    const distance = rayBodyDistance(ray, band(mark));
    if (distance === null || distance >= bestDistance) continue;
    best = mark;
    bestDistance = distance;
  }
  return best;
}

/**
 * The nearest sign whose ground footprint holds the cursor.
 *
 * At the **post's** radius rather than the board's: the patch of earth a sign
 * occupies is the patch its post stands on, and the board is a metre of air a
 * body walks under. Claiming the ground the board overhangs would take a stride
 * of walkable earth out of the game around every signpost on the map.
 */
function pickFootprint(cursor: Vec2 | null, marks: readonly SignMark[]): SignMark | null {
  if (!cursor) return null;
  let best: SignMark | null = null;
  let bestDistSq = Infinity;
  for (const mark of marks) {
    const dx = mark.x - cursor.x;
    const dy = mark.y - cursor.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > mark.radius * mark.radius || distSq >= bestDistSq) continue;
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

  /**
   * The signs, rebuilding first if the store has moved on.
   *
   * The ground is sampled at that rebuild rather than per query, and the
   * revision is the right moment for both: a chunk arriving is what brings a
   * sign *and* the ground it stands on, and the two land together because they
   * are the same chunk.
   */
  update(revision: number, props: () => readonly Prop[], groundAt: GroundAt): readonly SignMark[] {
    if (revision !== this.revision) {
      this.revision = revision;
      this.marks = signMarks(props(), groundAt);
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
 * A sign as something the dialogue can be handed (spec 260).
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
 * A sink that starts nothing and so owes no stop (spec 260).
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
