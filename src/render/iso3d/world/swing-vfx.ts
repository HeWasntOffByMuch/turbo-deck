/**
 * The sweep a melee swing paints (spec 233).
 *
 * Pure -- no three.js, no DOM, no `GameClient`. It is handed replicated facts
 * and answers what to play, which is the discipline `vfx-wire.ts`,
 * `shot-vfx.ts`, `affliction-vfx.ts` and `unit-driver.ts` all keep so that
 * presentation has nothing it *could* call. Every `if` in here decides which
 * effect is drawn and none of them decides a game outcome.
 *
 * ## Why this is not in `effectsForBlow`
 *
 * That was the obvious home and it is the wrong one, for a reason that is about
 * the game rather than about the code: **a swing happens whether or not it
 * connects.** `effectsForBlow` runs off a `CombatResult`, so a Rending Cut that
 * missed would draw nothing while one that landed drew a sweep -- and the whole
 * reason this game's wind-ups are long enough to read is that a whiff is a
 * thing that happens to people. The blade goes past either way.
 *
 * The budget says the same thing from the other side. `effectsForBlow` is at
 * its `MAX_BLOW_EFFECTS` of three on a bleeding body -- blood, the crit, the
 * element -- and a sweep is not what should evict any of them, because those
 * three are about the body that was hit and this one is about the attacker.
 *
 * ## A contact, not a state
 *
 * `auras.ts` draws the line -- *"a hit happens; a poison lasts"* -- and this is
 * emphatically the first. So it fires on an **edge**, the release tick being
 * crossed, and that makes it `stagger-flinch.ts`'s kind of thing rather than
 * `stun-icon.ts`'s: a body that walks into view mid-swing has no release this
 * client watched, and drawing one would paint a blade that already fell.
 *
 * ## It holds no handle, and that is the difference from `shot-vfx.ts`
 *
 * A shot is a persistent attached effect and owes a stop; a sweep is a one-shot
 * with a duration of its own that the particle system retires by itself. So the
 * three rules spec 215 and 218 are built on -- hold a handle because `play`
 * returns 0 on refusal, ask `isLive` because a full pool evicts, owe a stop
 * because nothing stops itself -- do not apply here, and pretending they did
 * would be bookkeeping guarding nothing. What this holds instead is one number
 * per body: the last release it drew, so a cast that runs on for its backswing
 * cannot paint a second sweep.
 */

import { abilityById } from '../../../server/data/abilities.js';

/**
 * A body that is mid-cast, and the swing it is committed to.
 *
 * The facing rather than the aim point, because a swing sweeps across where the
 * body is *pointing*: spec 065 turns a body before its wind-up begins and holds
 * the aim live to the commit, so by the release those two agree -- and the
 * facing is the one of them every client already has for every body.
 */
export interface SwingBody {
  readonly entityId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians about Y. What the sweep is centred on. */
  readonly facing: number;
  readonly abilityId: string;
  /** The tick the blow lands, which is the tick the blade goes past. */
  readonly releaseTick: number;
}

/** The two calls this needs from the particle system. */
export interface SwingVfxPlayer {
  play(
    id: string,
    options: { x: number; y: number; z: number; rotation: number; seed: number },
  ): number;
  has(id: string): boolean;
}

/**
 * Which abilities paint a sweep.
 *
 * A **table**, not a naming convention, for the reason `SHOT_ART` is one and
 * `naming.ts` is one: a built id is a second invisible answer every boundary has
 * to re-derive, a typo in it survives as an effect that silently plays nothing,
 * and it has nowhere to say that an ability deliberately paints none.
 *
 * Whirlwind is **not** here, and that absence is the design rather than an
 * omission: `landArea` already sends `skill.whirlwind.impact` at the caster's
 * feet before its target loop, so it is drawn by the registry entry under that
 * id with no driver at all. A row here as well would paint the turn twice.
 *
 * The basic attacks are not here either, yet. `melee.slash` is every monster's
 * blow as well as a player's, and putting a sweep under every bite and claw on
 * the map is a look decision with a crowd behind it -- so the skills that had no
 * picture at all go first, and that stays a one-line change when somebody wants
 * to see it.
 */
export const SWING_ART: Readonly<Record<string, string>> = {
  'skill.guardBreak': 'swing_arc',
  'skill.stunningBlow': 'swing_arc_heavy',
  'skill.cripplingStrike': 'swing_arc',
  'skill.rendingCut': 'swing_arc',
  'skill.testStatuses': 'swing_arc',
};

/** The sweep this ability paints, or null for one that paints none. */
export function swingArtFor(abilityId: string | null | undefined): string | null {
  if (abilityId === null || abilityId === undefined) return null;
  return SWING_ART[abilityId] ?? null;
}

/** A seed that is a function of where and when, so every client paints alike. */
export function swingSeed(body: SwingBody): number {
  return (
    (Math.imul(Math.round(body.x) | 0, 73856093) ^
      Math.imul(Math.round(body.z) | 0, 19349663) ^
      Math.imul(body.releaseTick, 83492791) ^
      body.entityId) |
    0
  );
}

/**
 * Paints one sweep per swing, on the tick the blade goes past.
 *
 * Idempotent within a cast: the same body still casting on the next frame paints
 * nothing more.
 */
export class SwingVfx {
  private readonly drawn = new Map<number, number>();

  constructor(private readonly player: SwingVfxPlayer) {}

  step(bodies: readonly SwingBody[], tick: number): void {
    for (const body of bodies) {
      const effect = swingArtFor(body.abilityId);
      if (effect === null || !this.player.has(effect)) continue;
      // Not yet. The release is the tick the blow lands, so this is the whole of
      // "the blade goes past now" rather than "a cast is happening".
      if (tick < body.releaseTick) continue;
      // Already painted. Keyed on the release tick rather than on a boolean,
      // because a body swings again: a flag would need clearing and the moment
      // to clear it is exactly the moment this has no event for.
      if (this.drawn.get(body.entityId) === body.releaseTick) continue;
      this.drawn.set(body.entityId, body.releaseTick);
      this.player.play(effect, {
        x: body.x,
        y: body.y,
        z: body.z,
        rotation: body.facing,
        seed: swingSeed(body),
      });
    }
  }

  /**
   * A body has gone.
   *
   * Called from the despawn sweep that already knows, never inferred from an
   * absence -- a body simply missing from one frame's list is a body outside
   * interest range, and forgetting it there would repaint its swing when it came
   * back. What this prevents is the opposite leak from `shot-vfx.ts`'s: no
   * instance is held, but the map would grow one entry per body the client ever
   * saw swing.
   */
  forget(entityId: number): void {
    this.drawn.delete(entityId);
  }
}

/** Every ability named in {@link SWING_ART}, for a test to check the table with. */
export function swingAbilityIds(): readonly string[] {
  return Object.keys(SWING_ART).sort();
}

/** Whether an ability id names a melee row. A sweep on a shot is a blade at nothing. */
export function isMeleeAbility(abilityId: string): boolean {
  return abilityById(abilityId)?.kind === 'melee';
}
