/**
 * What a monster does when nobody is fighting it (spec 213).
 *
 * `aggro.ts` owns acquiring, holding and dropping a target; `world.ts` owns
 * walking to one. This is the third of those and the one that was missing: what
 * a body does with the other ninety-nine percent of its life. Before it, a
 * monster with no target stood on the exact coordinate its spawner put it on
 * forever, and a monster dragged off its anchor walked back to it still carrying
 * whatever damage had been done on the way out -- which is the pull-and-reset
 * exploit, wide open, with the leash itself doing the work.
 *
 * One function, {@link idle}, and one call site. Everything a body does out of
 * combat is one answer rather than three: come home, healing on the way, then
 * mill about or walk your beat.
 *
 * **Nothing here draws from the `Rng`.** Where a body is *milling about* is a
 * pure function of `(its id, the tick)` through
 * `shared/hash.ts` -- the precedent `crowd.ts`'s `symmetryBreak` set, and for
 * the reason stated there: the sim's draw *count* is load-bearing, so a field of
 * monsters sampling the PRNG sixty times a second would move every combat roll
 * in the world. Hashing buys the second property for free -- a goal that is
 * derived is a goal that cannot be persisted wrong, expire wrong, or be
 * forgotten to be cleared when a fight starts. The one thing that is *not*
 * derived is a walk home (spec 248): `ServerEntity.returnStart` is a snapshot,
 * because both ends of "regenerate to full along the route" are gone the moment
 * the body takes its first step.
 *
 * **And recovery is measured on the clock rather than in ticks** (spec 261).
 * `world.ts` steps nothing outside `activeChunks`, so a body nobody is near is
 * not slowed but frozen -- which made {@link restore} a counter of how long
 * somebody was *watching* rather than of how long the body was left alone, and
 * left the exploit wide open through the one door that opens it fastest: dying,
 * which teleports the player away and freezes the monster on whatever sliver
 * was left of it. What a body is owed is read off a clock stamped when it was
 * last in a fight, so the ticks nobody watched count too. See {@link restore}.
 */

import { hash2i, hashUnit2 } from '../../shared/hash.js';
import type { Vec2 } from '../../sim/types.js';
import { idlePlanOf, type Idle } from '../data/monsters.js';
import { RESTORATION } from '../data/restoration.js';
import { arriveHome } from './aggro.js';
import { recoveryRemaining } from './restoration.js';
import { hasStatus, StatusId } from './statuses.js';
import { EntityKindValue, type ReturnStart, type ServerEntity } from './types.js';

const TAU = Math.PI * 2;

/**
 * How fast a body moves about its own business, as a fraction of its speed.
 *
 * An amble is not a charge, and this is the difference between a field that
 * looks alive and a field of monsters sprinting between random points. It is a
 * *magnitude* on the intent vector rather than a second speed stat, because
 * `clampDirection` already honours a short vector and a monster asking to walk
 * slowly is exactly what a short vector means.
 */
export const IDLE_PACE = 0.45;

/**
 * And how fast it comes home. Full speed, deliberately: a body walking back to
 * its post has given up on you, and dawdling through the distance a leash just
 * measured would leave it catchable for the whole return trip -- which is the
 * exploit {@link restore} exists to close, arriving by the other door.
 */
export const RETURN_PACE = 1;

/**
 * How far outside its own ground a body may drift before it is *returning*
 * rather than milling about.
 *
 * Hysteresis, and about a body's length of it. Without the margin a wanderer
 * that picked a spot on the edge of its ring would be reclassified as
 * "away from home" the moment it arrived, and would walk straight back -- a
 * body that can never be anywhere but its own anchor, by way of a rule meant to
 * let it leave.
 */
export const HOME_MARGIN = 24;

/**
 * Ticks of recovery to go from nothing to full. Linear throughout.
 *
 * `RESTORATION.rest.recoveryTicks` rather than a number of its own, because
 * `enterCombat` sizes the clock this ramps along -- see that function and
 * {@link restore}. Two files, one width.
 */
export const RECOVERY_TICKS = RESTORATION.rest.recoveryTicks;

/**
 * Whether this body has been dragged further from its spawn point than it will
 * go (specs 076, 222).
 *
 * Here rather than in `world.ts` since spec 248, because the leash is no longer
 * only a reason to drop a target: it is the one thing that starts a walk home,
 * and the walk home is this file's. `world.ts` still asks it, at the one line
 * where a chase ends.
 *
 * Off the body's own radius rather than the constant, because a spawner may
 * author a tighter one. Still gated by `anchor`, so a player and a monster an
 * admin conjured are untouched -- they have no home to be dragged away from,
 * and `leashRadius` on either is a number nothing reads.
 */
export function beyondLeash(monster: ServerEntity): boolean {
  const anchor = monster.anchor;
  if (!anchor) return false;
  const dx = monster.position.x - anchor.x;
  const dy = monster.position.y - anchor.y;
  return dx * dx + dy * dy > monster.leashRadius * monster.leashRadius;
}

// Distinct seeds so the three questions a wander asks of one `(id, epoch)` --
// which way, how far, and when did this body's cycle start -- are independent
// rather than three views of one hash.
const WANDER_PHASE_SEED = 0x1d1e0001;
const WANDER_ANGLE_SEED = 0x1d1e0002;
const WANDER_REACH_SEED = 0x1d1e0003;
const PATROL_PHASE_SEED = 0x1d1e0011;
const PATROL_START_SEED = 0x1d1e0012;
const PATROL_TURN_SEED = 0x1d1e0013;

/** Where a body with nobody to fight is going, and how fast. */
export interface IdleGoal {
  readonly at: Vec2;
  /** Fraction of the body's own move speed to travel at. */
  readonly pace: number;
}

export interface IdleStep {
  /** The body, with this tick's recovery already applied. */
  readonly entity: ServerEntity;
  /** Where to walk, or null to stand where it is. */
  readonly goal: IdleGoal | null;
}

/**
 * One tick of a monster's life out of combat.
 *
 * The order is the priority: a body that gave up out past its leash is walking
 * home and nothing else, then a body merely off its own ground comes back to it,
 * and only a body that is *on* it has any business milling about. Recovery is
 * not part of that order because it is not a place -- it applies either way, so
 * "a monster nobody is fighting recovers" stays one sentence rather than a
 * special case bolted to the leash.
 *
 * Answers `goal: null` for anything that is not a monster and for a monster with
 * no anchor. The second is not an omission: a body with no home has no ground to
 * wander over, and it is what keeps a conjured or test-seeded monster behaving
 * exactly as it did before this spec.
 */
export function idle(monster: ServerEntity, tick: number): IdleStep {
  if (monster.kind !== EntityKindValue.Monster) return { entity: monster, goal: null };

  const anchor = monster.anchor;
  const plan = idlePlanOf(monster.typeId);
  const arrival = homeRadiusOf(plan) + HOME_MARGIN;
  const drift = anchor
    ? Math.hypot(monster.position.x - anchor.x, monster.position.y - anchor.y)
    : 0;

  // The walk home (spec 248), which outranks the rest because it is a claim on
  // the body rather than something it happens to be doing: it started at a
  // leash it broke and it ends at its own ground, and nothing in between --
  // being shot at, a player standing in its notice range, a neighbour shouting
  // -- moves it. Everything that enforces that lives in `aggro.ts` and
  // `isHostile`; what is here is where it goes, and what it is owed on the way.
  //
  // `restore` is deliberately skipped for the duration. The ramp below is a
  // second, faster answer to the same question and running both would heal
  // twice; and `restore`'s `InCombat` gate is exactly what a retreating body
  // cannot satisfy while somebody keeps hitting it, which is the hole this
  // closes.
  if (anchor && monster.returnStart) {
    if (drift > arrival) {
      return {
        entity: healHomeward(monster, monster.returnStart, drift, arrival),
        goal: { at: anchor, pace: RETURN_PACE },
      };
    }
    // Home. Full health rather than whatever the ramp had reached, because the
    // ramp is a *presentation* of a promise the arrival is the point of -- and
    // a body left one point short by a rounding error is a body somebody can
    // still open a fight against at a discount. It stands this tick and picks a
    // post on the next, which is what any other body that has just arrived
    // somewhere does.
    return { entity: { ...arriveHome(monster), health: monster.stats.maxHealth }, goal: null };
  }

  const entity = restore(monster, tick);
  if (!anchor) return { entity, goal: null };

  if (drift > arrival) return { entity, goal: { at: anchor, pace: RETURN_PACE } };

  const post = postAt(plan, monster.id, anchor, tick);
  return { entity, goal: post === null ? null : { at: post, pace: IDLE_PACE } };
}

/**
 * One tick of a returning body's ramp back to full health (spec 248).
 *
 * Linear in **ground closed**, not in time: the promise is "full when it gets
 * there", so the two ends of the ramp are where the body gave up and where the
 * walk stops -- which is `arrival`, not the anchor. Measured to the anchor and
 * the last stretch would be a jump; measured to `arrival`, the ramp reaches
 * full exactly as the walk ends and the snap above has nothing left to snap.
 *
 * **It never runs downhill.** `drift` is the straight line home and the route
 * is not: a body going round a rock, or shoved outward by the crowd, closes
 * less ground this tick than last, and a bare `lerp` would take health back off
 * a body that cannot be hurt. So the ramp is a floor rather than a value, and
 * what a detour costs is a pause rather than a reversal.
 *
 * A span that is zero or negative -- a spawner authoring a leash tighter than
 * its monster's own wander radius -- lands the body on full immediately, which
 * is the honest reading of "it broke its leash and is already home".
 */
function healHomeward(
  monster: ServerEntity,
  start: ReturnStart,
  drift: number,
  arrival: number,
): ServerEntity {
  const max = monster.stats.maxHealth;
  if (monster.health >= max) return monster;
  const span = start.distance - arrival;
  const progress = span > 0 ? clamp01((start.distance - drift) / span) : 1;
  const owed = start.health + (max - start.health) * progress;
  const health = Math.min(max, Math.max(monster.health, owed));
  return health === monster.health ? monster : { ...monster, health };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * A step back toward full health, for a body nobody is fighting.
 *
 * Exploit avoidance and nothing more ambitious: without it, "hit it, walk past
 * the leash, come back" is a free four fifths of a kill, repeatable, and the
 * monster's own leash does the work. Linear rather than a percentage of what is
 * missing, because a curve that approaches full without reaching it leaves the
 * exploit intact at the tail -- {@link RECOVERY_TICKS} from empty, and full is
 * full.
 *
 * Gated on `InCombat` rather than on arriving home, which is what makes it one
 * rule instead of a leash special case. That status is the same one
 * `advanceRest` refuses to rest through, and it is stamped by every blow and
 * every affliction pulse -- so a body still burning does not heal through the
 * burn, and a body that merely lost sight of you waits out the same window a
 * player does. It is a *wide* window on purpose (`RESTORATION.rest.combatTicks`
 * says why), and it has to be: a player chasing a body that fled, or closing
 * again after being knocked back, is still fighting it, and a monster that
 * healed in those gaps would be a monster you cannot finish.
 *
 * **Recovery is measured on the clock, not in ticks somebody was near enough to
 * watch** (spec 261), and that is what the floor below is for. `world.ts` steps
 * nothing outside `activeChunks`, so a body nobody is near is not slowed but
 * *frozen* -- and dying is the fastest way there is to make one unwatched,
 * since a respawn teleports the player away. The one situation this function
 * exists for was the one it did not run in: the body was still on its sliver
 * when the player walked back, however long they took.
 *
 * So there are two answers and the larger wins:
 *
 *  - the **step**, one tick's worth from wherever the body is now. This is what
 *    a watched body has always got, and it is unchanged.
 *  - the **floor**, read off `StatusId.Recovering`, whose expiry *is* the tick
 *    this body is due back to full. Being a comparison against an absolute tick
 *    -- the register `statusOf`'s expiry, the loot reveal and the stun swirl are
 *    all already in -- it counts the ticks a body spent unwatched exactly as it
 *    counts the ticks it spent watched, so a body away past its due tick is
 *    simply full on the first tick it is stepped again.
 *
 * The floor **never binds for a body that was watched throughout**, which is
 * what makes the ramp's shape provably the one it was rather than approximately
 * so: both reach full at the due tick, and the step runs from the body's own
 * health where the floor runs from empty. It is pure catch-up.
 *
 * Nothing owed -- a body that has never been in a fight, or one whose clock has
 * been pruned because it ran out -- gets no floor at all. See
 * {@link recoveryRemaining} for why one answer is right for both.
 */
export function restore(monster: ServerEntity, tick: number): ServerEntity {
  const max = monster.stats.maxHealth;
  // A corpse does not recover. Unreachable from `monsterIntent`, which skips the
  // dead before it decides anything, and stated here because this is the
  // function that would be wrong rather than the caller.
  if (monster.health <= 0 || monster.health >= max) return monster;
  if (hasStatus(monster.statuses, StatusId.InCombat, tick)) return monster;

  const stepped = monster.health + max / RECOVERY_TICKS;
  const remaining = recoveryRemaining(monster.statuses, tick);
  const owed = remaining === null ? 0 : max * (1 - remaining / RECOVERY_TICKS);
  const health = Math.min(max, Math.max(stepped, owed));
  return health === monster.health ? monster : { ...monster, health };
}

/** How far from its anchor a body of this plan is still on its own ground. */
export function homeRadiusOf(plan: Idle): number {
  return plan.kind === 'sentinel' ? 0 : plan.radius;
}

/**
 * The spot this body is making for right now, or null for one that stands.
 *
 * Both moving plans are the same arithmetic: cut the body's life into equal
 * spans, hash a per-body offset so a herd does not step off together, and read
 * the span's index. What differs is only what an index means -- a fresh draw
 * inside a disc for a wanderer, the next post of a fixed circuit for a sentry.
 */
function postAt(plan: Idle, id: number, anchor: Vec2, tick: number): Vec2 | null {
  if (plan.kind === 'sentinel') return null;

  if (plan.kind === 'wander') {
    const cycle = Math.max(1, Math.trunc(plan.cycleTicks));
    const epoch = Math.floor((tick + hash2i(id, 0, WANDER_PHASE_SEED) % cycle) / cycle);
    const angle = hashUnit2(id, epoch, WANDER_ANGLE_SEED) * TAU;
    // Square-rooted so the draw is uniform over the *disc* rather than over the
    // radius: without it a body spends most of its life near its own anchor,
    // which is the standing-still this exists to replace.
    const reach = Math.sqrt(hashUnit2(id, epoch, WANDER_REACH_SEED)) * plan.radius;
    return { x: anchor.x + Math.cos(angle) * reach, y: anchor.y + Math.sin(angle) * reach };
  }

  const posts = Math.max(2, Math.trunc(plan.points));
  const leg = Math.max(1, Math.trunc(plan.legTicks));
  const circuit = posts * leg;
  const step = Math.floor((tick + hash2i(id, 0, PATROL_PHASE_SEED) % circuit) / leg);
  // Which way round, so two sentries sharing a post count do not orbit in step.
  const turn = (hash2i(id, 0, PATROL_TURN_SEED) & 1) === 0 ? 1 : -1;
  const index = (((step * turn) % posts) + posts) % posts;
  // And where the circuit starts, so they do not share their posts either.
  const angle = hashUnit2(id, 0, PATROL_START_SEED) * TAU + (index * TAU) / posts;
  return { x: anchor.x + Math.cos(angle) * plan.radius, y: anchor.y + Math.sin(angle) * plan.radius };
}
