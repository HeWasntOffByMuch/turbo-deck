/**
 * When a body takes a step (spec 229).
 *
 * Pure -- no Web Audio, no three.js, no clock. It is handed where each body is
 * this frame and answers which of them just put a foot down, which makes "does
 * a body walking in a circle step at an even cadence" a thing `npm test` can
 * assert rather than something judged by ear.
 *
 * ## Why distance and not an animation event
 *
 * The clip format already has events, resolved to integer ticks and fired on
 * frame crossing by `units/machine.ts`, and it is the *right* answer -- a step
 * lands when the foot lands. It is not the answer available: `walk` and `run` in
 * `assets/units/biped.core.cliplib.json` are retargeted clips with `events: []`,
 * and authoring foot-plant markers into bought animation is a job of its own.
 * Worse, only some monsters are drawn from an authored unit at all -- the player
 * and the mechs are procedural rigs with no clip library behind them, so an
 * animation-driven footstep would be a footstep for four bodies in the game.
 *
 * Distance covered works for every body, needs no authored content, and scales
 * with speed for free: a slowed body (`StatusId.Slowed` is a 0.6 multiplier)
 * steps more slowly because it covers less ground, with nothing here reading the
 * status. It also cannot drift, and the event route would: locomotion clips do
 * **not** scale their playback rate with speed (`setActionRate` is one-shots
 * only), so a stride cycle is a fixed 1.19s at the walk threshold and 1.30s at
 * the run one -- about 40 units of ground per footfall at one end and 100 at the
 * other. An event-driven step would slide against the ground exactly as the pace
 * changed.
 *
 * The extension point, if the clips ever get markers: this class keeps the
 * accumulator and the driver prefers a real event where one exists, exactly as
 * `unit-driver.ts` prefers an authored `shoot` trigger and falls back. The
 * machinery is entirely built and has no consumer -- `driveUnit` returns
 * `readonly FiredEvent[]` and `scene.ts` calls it as a bare statement -- and the
 * dev mannequin's library already declares `footstep.l` / `footstep.r` on its
 * walk and run.
 *
 * ## And why there is one footstep sound rather than one per surface
 *
 * The ground's material **is** reachable on a streaming client, and precisely:
 * `StreamedMap.meshLayers` is public and `MeshLayer.materialAt(col, row)`
 * returns the *baked* index, with `null` meaning "that chunk has not arrived"
 * rather than "no material" -- which is the distinction a surface-varied
 * footstep needs and would have to treat as "use the default", never as silence.
 * (What must **not** be used is `worldMaterialAt` in `classify.ts`: it re-derives
 * a material from height and slope with `region: 'default'`, so it reports a
 * hand-painted dirt path as grass and painted snow as rock.)
 *
 * What is missing is not the signal, it is the recordings: the library ships one
 * boot set and one sandal set, which are two kinds of *shoe* and not two kinds
 * of *ground*. Splitting `player.footstep` into five surface rows with one of
 * them assigned would be five events to look at and one sound to hear. When the
 * takes exist, the change is a row per surface in `events.ts` and a material
 * lookup handed into the driver -- not a change here.
 *
 * ## Two things it has to refuse
 *
 * **A teleport is not a walk.** A respawn arrives as a `Teleport` correction
 * which spec 067 snaps, and a body crossing the arena in one frame would
 * otherwise bank thirty strides and fire a machine-gun of footsteps. Anything
 * over {@link MAX_FRAME_UNITS} in a frame resets the accumulator instead.
 *
 * **Being shoved is not walking.** `resolveCrowding` displaces bodies that are
 * not moving under their own power, and a stagger roots the legs while the body
 * is still being pushed around -- so a stunned or dead body banks nothing.
 * Everything else is honest: standing still covers no ground and so needs no
 * check of its own, which is what makes this immune to the one thing an
 * activity-driven version cannot be, namely that the local player's replicated
 * `activity` is a round trip behind the legs the player is watching.
 */

/**
 * How far a body travels between footfalls, in world units.
 *
 * **48, because that is what the rigs already use.** `rigs.ts`'s `STRIDE_LEN`
 * is "world distance per gait half-cycle" and is 48; `humanoid.ts` runs a gait
 * over `STRIDE_WALK` 58 to `STRIDE_RUN` 112 per *full* cycle, so 29 to 56 units
 * per footfall. Matching the drawn gait is the whole reason to prefer distance
 * over time, so the number is taken from the neighbours rather than invented.
 *
 * It cannot be *exactly* right for every body, and that is worth stating rather
 * than hiding. The player is drawn from an authored clip whose true stride is
 * unknowable here -- `unit-rig.ts` strips root motion, which is precisely the
 * translation a stride length would be measured from -- and a mech's gait
 * lengthens with speed where this is constant. So the sound and the foot stay in
 * step at a walk and drift at a sprint, which is the same compromise
 * `rigs.ts`'s single constant already makes for the bob.
 *
 * At a fresh character's 155 units a second that is 3.2 steps a second, which
 * for a body covering 2.8 of its own heights a second is a jog, and is what it
 * should sound like.
 */
export const STRIDE_UNITS = 48;

/**
 * How far a body may move in one frame and still be walking.
 *
 * `MOVE_SPEED_HARD_MAX` is 550 units a second, so a 60Hz frame is at most about
 * 9 units and a badly hitching 4Hz frame about 138. 200 leaves room for a very
 * slow frame and still refuses the smallest correction snap worth refusing.
 */
export const MAX_FRAME_UNITS = 200;

/**
 * How much of a stride a body starts with when it sets off.
 *
 * Not zero, because a full stride of silence at the start of every walk is the
 * difference between legs that make noise and legs that make noise *eventually*
 * -- and the first step is the one that tells a player the sound exists. Not one
 * either: a body that steps on the very first frame it moves would step again on
 * the frame after a one-frame twitch.
 */
const FIRST_STEP_FRACTION = 0.7;

/** What this needs to know about a body. Facts, not objects. */
export interface WalkingBody {
  readonly entityId: number;
  readonly x: number;
  /** The world's second horizontal axis -- the sim's `y`. */
  readonly z: number;
  /** False for a stunned or dead body: see the header. */
  readonly walks: boolean;
}

interface Tracked {
  x: number;
  z: number;
  banked: number;
  /** Whether this body has been seen since the last sweep. */
  seen: boolean;
}

export class Footsteps {
  private readonly tracked = new Map<number, Tracked>();

  /**
   * Whether `body` just put a foot down.
   *
   * At most one step per frame per body, deliberately: a frame that drained
   * three ticks covered three ticks of ground, and a body that banked two
   * strides in it took two steps *at the same instant*, which is one step with
   * a comb filter on it rather than two footfalls. The remainder is kept, so the
   * cadence over a long walk is exact and only the sub-frame timing is lost --
   * and a frame long enough to hold two strides is a frame at 8fps, where the
   * footsteps are not the problem. This is the rule `affliction-vfx.ts` states
   * about a beat: fire once for a frame that drained three, because a beat is a
   * beat and not a quantity.
   */
  step(body: WalkingBody): boolean {
    const previous = this.tracked.get(body.entityId);
    if (!previous) {
      this.tracked.set(body.entityId, {
        x: body.x,
        z: body.z,
        banked: STRIDE_UNITS * FIRST_STEP_FRACTION,
        seen: true,
      });
      return false;
    }
    previous.seen = true;
    const dx = body.x - previous.x;
    const dz = body.z - previous.z;
    previous.x = body.x;
    previous.z = body.z;

    const moved = Math.hypot(dx, dz);
    // A snap, not a walk. The accumulator is reset rather than merely skipped:
    // a body that arrived somewhere else is a body whose stride phase means
    // nothing, and carrying the old remainder across would put the first step
    // after a respawn at an arbitrary point.
    if (moved > MAX_FRAME_UNITS) {
      previous.banked = STRIDE_UNITS * FIRST_STEP_FRACTION;
      return false;
    }
    if (!body.walks) return false;

    previous.banked += moved;
    if (previous.banked < STRIDE_UNITS) return false;
    previous.banked -= STRIDE_UNITS;
    // See above: one step per frame, remainder kept, and a body that banked two
    // strides does not fire twice.
    if (previous.banked > STRIDE_UNITS) previous.banked = STRIDE_UNITS * FIRST_STEP_FRACTION;
    return true;
  }

  /**
   * Drop everything not seen since the last sweep.
   *
   * Called once a frame after every body has been offered, which is the same
   * shape `ShotVfx`'s despawn sweep has and is here for the smaller version of
   * the same reason: a map keyed on entity id and never pruned grows by one
   * entry per monster that has ever spawned, for the life of the session.
   */
  sweep(): void {
    for (const [id, entry] of this.tracked) {
      if (!entry.seen) this.tracked.delete(id);
      else entry.seen = false;
    }
  }

  forget(entityId: number): void {
    this.tracked.delete(entityId);
  }

  clear(): void {
    this.tracked.clear();
  }

  /** How many bodies are being tracked. For the readout, and for a test. */
  get size(): number {
    return this.tracked.size;
  }
}
