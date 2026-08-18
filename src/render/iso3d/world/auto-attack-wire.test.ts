/**
 * The standing attack order as a player sees it (spec 080).
 *
 * `auto-attack-loop.test.ts` drives the same two pure functions against the same
 * real tick, and every fault spec 080 exists for was invisible to it -- because
 * its client reads the *server's* own entity and therefore never disagrees with
 * it. Everything here is about that disagreement, so it needs the real
 * `GameClient`: its predicted cast, its request queue, its replica of the world.
 *
 * Frames, not ticks. The loopback delivers on a microtask, so a frame that runs
 * two ticks runs both of them before a single message lands -- and the Play tab
 * runs an accumulator, so multi-tick frames are ordinary and a slow machine
 * makes them long. A harness that drained the wire between every tick would be
 * measuring a connection nobody has.
 *
 * The quarry is mortal, which is the whole point. Held at full health this loop
 * looks perfect; it is dying that produces the fault, because a shot's damage
 * lands when the *shot* arrives and by then the next wind-up is most of the way
 * along.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../../sim/collision.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../../../server/config.js';
import { abilityById } from '../../../server/data/abilities.js';
import { CastPhaseValue } from '../../../server/net/protocol.js';
import { castBar } from './cast.js';
import { attackTimingFor, facesAim } from '../../../server/sim/abilities.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { turnToward } from '../../../server/sim/movement.js';
import { CastEndReason, type ServerEntity } from '../../../server/sim/types.js';
import { FLAT_TERRAIN } from '../../../server/world/terrain.js';
import { GameClient } from '../../../server/client/game-client.js';
import { computeEffectiveStats } from '../../../server/player/stats.js';
import { EMPTY_EQUIPMENT, emptyInventory } from '../../../server/state/types.js';
import { createWorldPredictor } from '../../../server/client/prediction.js';
import { moveIntent } from './intent.js';
import { autoAttack } from './target.js';
import { windupLostItsMarkIn } from './withdraw.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Fought {
  /** Ticks the order asked to swing. */
  readonly asks: number;
  /** Casts the server actually began, counted off its own entity. */
  readonly commits: number;
  /** Refusals the server sent back, by reason. */
  readonly rejects: readonly string[];
  /** Wind-ups of ours the server withdrew from: spec 080's headline. */
  readonly cancels: number;
  /**
   * Blows this client called off itself, because the mark had left the world
   * (spec 155).
   *
   * The pair is what spec 080's headline became. That number was zero and the
   * property under it was "the order does not throw a wind-up away"; a client
   * that now calls one off on purpose when its mark dies cannot claim that, but
   * it can claim the sharper thing: every withdrawal in the run is one this
   * client made, and every one it made had a body that had left the world
   * behind it.
   */
  readonly withdrawals: number;
  /** Bodies put down, so "nothing was withdrawn from" is not vacuous. */
  readonly kills: number;
  /** Ticks the server was casting and the client drew no bar. */
  readonly missing: number;
  /** Ticks the client walked while the server held it rooted. */
  readonly unrooted: number;
  readonly ticks: number;
}

/**
 * Runs a standing attack order exactly as `view.ts` runs it -- decide, steer,
 * send one input frame -- against a real server over a real loopback, putting a
 * fresh body up whenever the last one goes down.
 */
async function play(options: {
  readonly ticks: number;
  readonly weapon: string | null;
  readonly monster: string;
  /** Ticks per frame, cycled. `[1]` is a perfect 60Hz; `[10]` is a bad day. */
  readonly cadence: readonly number[];
}): Promise<Fought> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 11,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), {
    playerId: 'you',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: createWorldColliders([], []),
        terrain: FLAT_TERRAIN,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  void client.connect();

  const rejects: string[] = [];
  client.onCastRejected((_abilityId, reason) => rejects.push(reason));
  let cancels = 0;
  client.onCastEnded((end) => {
    if (end.reason === CastEndReason.Cancelled && end.entityId === client.view().selfEntityId) {
      cancels += 1;
    }
  });

  let targetId: number | null = null;
  /** The last body we were told to attack, so a replacement can score the kill. */
  let previous: number | null = null;
  let facing = 0;
  let asks = 0;
  /** The marks a wind-up of ours was called off over (spec 155). */
  const withdrawnMarks = new Set<number>();
  let commits = 0;
  let kills = 0;
  let missing = 0;
  let unrooted = 0;
  let sampled = 0;
  let ticks = 0;
  let lastServerCastKey: string | null = null;

  for (let frame = 0; ticks < options.ticks; frame++) {
    const perFrame = options.cadence[frame % options.cadence.length] ?? 1;
    // A frame's worth of ticks with nothing delivered between them, and then
    // the wire, which is the shape the Play tab's accumulator actually has.
    for (let n = 0; n < perFrame; n++) {
      ticks += 1;
      server.tick();
      client.advanceTick();

      // The first thing `sendInput` does, off its own read of the view
      // (spec 155): a blow whose mark has left the world is called off rather
      // than loosed at the ground it left.
      if (windupLostItsMarkIn(client.view())) {
        const withdrawn = client.view();
        const blow = withdrawn.casts.find((known) => known.entityId === withdrawn.selfEntityId);
        // The *mark*, not the firing. The rule can fire twice over one blow: the
        // withdrawal clears the client's copy of the cast at once, and a
        // `CastState` for it can still arrive before the server has dequeued
        // the cancel, putting the cast back in a view whose mark is still gone.
        // The repeat is a no-op on the server -- there is nothing left to
        // cancel -- so what pairs with the count below is the blow, not the ask.
        if (blow) withdrawnMarks.add(blow.targetEntityId);
        client.cancelCast();
      }

      const view = client.view();
      if (!view.self || !view.stats) continue;
      const live = server.world.entities as Map<number, ServerEntity>;

      if (targetId === null) {
        // Whatever ended the last order, the server is the one who says whether
        // the body is down: the view drops a target on the replica's word, and
        // the replica is up to three ticks behind.
        if (previous !== null) {
          const gone = live.get(previous);
          if (!gone || gone.health <= 0) kills += 1;
          if (gone) server.despawnEntity(previous);
          previous = null;
        }
        if (options.weapon) client.equip('mainHand', options.weapon);
        const self = live.get(view.selfEntityId);
        // The equip is a round trip: wait for the stat block to name the swing
        // the switch was clicked for, or the first body is fought bare-handed.
        if (!self || view.stats.basicAttackId === '') continue;
        if (options.weapon && view.stats.basicAttackId === 'melee.slash') continue;
        server.spawnEntities(options.monster, self.position.x + 300, self.position.y, 1);
        targetId = [...live.values()].find((e) => e.id !== view.selfEntityId)?.id ?? null;
        previous = targetId;
        continue;
      }

      const mob = live.get(targetId);
      // Immortal on our side only: a stalker's blows must not end the run.
      const me = live.get(view.selfEntityId);
      if (me) live.set(view.selfEntityId, { ...me, health: me.stats.maxHealth });

      // --- view.ts's own loop, in its own order --------------------------
      const swingId = view.stats.basicAttackId || 'melee.slash';
      const swing = abilityById(swingId);
      const entity = view.entities.find((e) => e.id === targetId);
      const radius = mob?.radius ?? 22;
      const decision = autoAttack({
        self: view.self,
        selfHealth: view.entities.find((e) => e.id === view.selfEntityId)?.health ?? 1,
        target: entity
          ? { id: entity.id, x: entity.x, y: entity.y, radius, health: entity.health }
          : null,
        range: swing?.range ?? 0,
        rooted: view.selfRoot !== null,
        staggered: view.selfStaggered,
        pending: view.awaitingCast,
        readyAtTick: view.cooldowns[swingId] ?? 0,
        // The local heading, as the shipped client asks it (spec 090).
        aligned: !entity ? true : facesAim(view.self, facing, { x: entity.x, y: entity.y }),
        tick: view.estimatedTick,
      });
      if (decision.drop || !entity) {
        targetId = null;
      } else if (decision.attack) {
        asks += 1;
        client.useAbility(swingId, entity.x, entity.y, entity.id, radius);
      }
      const intent = moveIntent({
        held: new Set<string>(),
        self: view.self,
        destination: decision.chaseTo,
        route: null,
        facing,
        castAim: view.selfRoot,
        // What the shipped client passes (spec 090): the mark is faced while the
        // swing is on cooldown, so the body is aligned by the time it asks. A
        // harness that left this out would be exercising a client nobody runs --
        // and it is the half that makes `aligned` above reachable at all.
        targetAim: entity ? { x: entity.x, y: entity.y } : null,
      });
      facing = turnToward(facing, intent.facing, view.stats.turnRate, SERVER_TICK_RATE);
      client.sendInput({
        moveX: intent.moveX,
        moveY: intent.moveY,
        facing: intent.facing,
        buttons: 0,
      });

      // --- what the player is looking at ---------------------------------
      const after = client.view();
      const cast = live.get(after.selfEntityId)?.cast ?? null;
      const key = cast ? `${cast.abilityId}@${cast.startedTick}` : null;
      if (key && key !== lastServerCastKey) commits += 1;
      lastServerCastKey = key;

      sampled += 1;
      if (key && !after.casts.some((drawn) => drawn.entityId === after.selfEntityId)) missing += 1;
      if (key && !after.selfRoot) unrooted += 1;
    }
    await settle();
  }

  // Let the answers land before the socket goes (spec 155). A withdrawal asked
  // for on one of the last ticks is still in flight, and an unanswered one
  // would read as a cancel the client did not make -- which is precisely the
  // thing the assertion below exists to rule out. The input is held at a
  // standstill through the drain, because asking to walk is itself a
  // withdrawal (spec 079) and would put a cancel nobody asked for on the end
  // of every run.
  for (let n = 0; n < 20; n++) {
    client.sendInput({ moveX: 0, moveY: 0, facing, buttons: 0 });
    server.tick();
    client.advanceTick();
    await settle();
  }

  client.disconnect();
  return {
    asks,
    withdrawals: withdrawnMarks.size,
    commits,
    rejects,
    cancels,
    kills,
    missing,
    unrooted,
    ticks: sampled,
  };
}

/** Every basic attack in the game, and the one a bare hand falls back to. */
const WEAPONS: readonly (string | null)[] = [null, 'bow.hunting', 'stars.weighted'];

/** How many swings a run has to contain for the guards below to mean anything. */
const SWINGS = 30;

/**
 * Long enough for this weapon to take {@link SWINGS} swings, asked rather than
 * written down.
 *
 * Since spec 088 the cadence is `attackDelayTicks` -- 1.2 seconds bare, and
 * moved by whatever the weapon says -- so a fixed tick budget silently becomes
 * a different number of swings every time that constant moves. This run has to
 * be a *fight*; how many ticks that takes is the stat's business.
 */
function ticksFor(weapon: string | null): number {
  const stats = computeEffectiveStats({
    id: 'p',
    displayName: 'P',
    baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    skills: [],
    equipment: { ...EMPTY_EQUIPMENT, ...(weapon ? { mainHand: weapon } : {}) },
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 100,
    resource: 20,
  });
  return stats.baseAttackTimeTicks * SWINGS;
}

/**
 * One tick a frame is a machine keeping up; ten is one that is not, and it is
 * where the seam opens widest -- ten ticks of deciding and sending go by with
 * nothing delivered between them, so the replica the order reads is ten ticks
 * stale by the end of every frame.
 */
const CADENCES: readonly (readonly number[])[] = [[1], [2, 1, 1, 0, 3], [10]];

describe('a standing attack order, over a real session (spec 080)', () => {
  for (const cadence of CADENCES) {
    for (const weapon of WEAPONS) {
      const name = `${weapon ?? 'empty hands'} at ${cadence.join('/')} ticks a frame`;

      it(`withdraws from nothing but a corpse and asks once a swing: ${name}`, async () => {
        const result = await play({ ticks: ticksFor(weapon), weapon, monster: 'grazer', cadence });
        const seen = JSON.stringify(result);

        // The run has to have been a fight, or everything below is vacuous.
        expect(result.kills, seen).toBeGreaterThan(2);
        expect(result.commits, seen).toBeGreaterThan(8);

        // The headline, in the form that survives spec 155.
        //
        // It used to read `cancels === 0`: before spec 080 a ranged auto-attack
        // threw a wind-up away once per kill -- a bar that filled
        // three-quarters of the way and vanished, with another starting
        // immediately behind it -- and melee never did, because a swing
        // resolves on its own release while a shot resolves when it arrives.
        //
        // 155 puts a withdrawal back on that same beat, and it is a different
        // animal: the client asks for it, the order ends with it, and nothing
        // starts behind it. So the two clauses. **Every withdrawal in the run
        // is one this client made** -- the server never withdrew anything on
        // its own, which is the stutter 080 removed -- and **every one it made
        // had a body that had left the world behind it**, which bounds them by
        // the kills.
        expect(result.cancels, seen).toBe(result.withdrawals);
        expect(result.withdrawals, seen).toBeLessThanOrEqual(result.kills);
        // And melee still withdraws from nothing at all, which is the half of
        // 080's reading that 155 does not touch: a swing resolves on its own
        // release, so the client knows the body is down before it commits
        // again and never has a wind-up left over to call off.
        if (weapon === null) expect(result.withdrawals, seen).toBe(0);

        // One ask per swing, and nothing refused. Over a loopback the client's
        // mirror agrees with the server about nearly everything, so this is a
        // guard rather than a reproduction -- the `pending` gate that makes it
        // hold when they *disagree* is pinned directly in `target.test.ts`.
        // What it does catch is the loop asking twice for one commit, which is
        // what any future brake on the ask would break first.
        expect(result.asks - result.commits, seen).toBeLessThanOrEqual(1);
        expect(result.rejects, seen).toEqual([]);
      }, 30_000);
    }
  }

  /**
   * The one that has to hold at speed as well: a body that closes on the player
   * mid-fight moves the aim between swings, which is what puts a turn in front
   * of a wind-up and what makes the reach decision live.
   */
  it('holds up against something that fights back', async () => {
    for (const weapon of WEAPONS) {
      const result = await play({
        ticks: ticksFor(weapon),
        weapon,
        monster: 'stalker',
        cadence: [2, 1, 1, 0, 3],
      });
      const seen = `${weapon ?? 'empty hands'}: ${JSON.stringify(result)}`;
      expect(result.kills, seen).toBeGreaterThan(2);
      expect(result.cancels, seen).toBe(result.withdrawals);
      expect(result.withdrawals, seen).toBeLessThanOrEqual(result.kills);
      // Nothing refused except the one refusal that cannot be predicted
      // (spec 173).
      //
      // The grazer runs above still assert `rejects` is empty outright, and
      // this one cannot, because a stalker breaks your poise: a stagger is
      // something done *to* this body, so the client learns about it when the
      // next delta arrives and may ask inside that window. The gate in
      // `target.ts` closes the window it can see -- 146 refusals per fight
      // before it existed, a couple after -- and what is left is the broadcast
      // interval itself, which no client-side rule can shorten.
      //
      // Asserted as a *reason* rather than relaxed to a count, because the
      // property worth keeping is the original one: no ask of this loop is ever
      // refused for a reason the client could have worked out for itself.
      // `alreadyCasting`, `onCooldown` or `outOfRange` appearing here would be
      // the mirror going stale, which is exactly what this guard is for.
      expect([...new Set(result.rejects)], seen).toEqual(
        result.rejects.length > 0 ? ['staggered'] : [],
      );
      // And bounded by the breaks themselves: one leaked ask per stagger is the
      // round trip, many would mean the gate is not being consulted.
      expect(result.rejects.length, seen).toBeLessThan(result.commits);
      // A bar for every blow, and no walking through one.
      expect(result.missing / result.ticks, seen).toBeLessThan(0.01);
      expect(result.unrooted / result.ticks, seen).toBeLessThan(0.01);
    }
  }, 60_000);
});

/**
 * Two shots from a body that had to turn 180 degrees first (spec 090).
 *
 * The measurement that would have caught all four of spec 090's defects, because
 * it times the *gap* rather than any one moment. The mark is placed behind the
 * body, so the first shot pays for a half-turn and the second pays for nothing:
 *
 *   order ──turn──windup──> shot 1 ────attack delay────windup──> shot 2
 *
 * So the first shot is late by the turn and no more -- a dead pause in front of
 * it is the "click, wait, turn, shoot" report -- and the interval between the
 * two is exactly `attackDelayTicks`, because the cooldown is stamped at the
 * commit and the body is already facing its mark by then. Anything that makes
 * the second shot wait -- a turn it should not need, an alignment gate reading a
 * stale replica, a phase both ends disagree about -- shows up as that interval
 * growing.
 */
async function twoShots(): Promise<{
  readonly turnTicks: number;
  readonly windupTicks: number;
  readonly delayTicks: number;
  readonly orderedAt: number;
  readonly firstAt: number;
  readonly secondAt: number;
  /**
   * True if a cast the client was already drawing as winding up went back to
   * turning -- the "two bars" report, which is not a timing fault and so is
   * invisible to the intervals above.
   */
  readonly reverted: boolean;
  /** How full the bar was drawn, the last tick before each shot appeared. */
  readonly barAtShot: readonly number[];
}> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 11,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), {
    playerId: 'you',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: createWorldColliders([], []),
        terrain: FLAT_TERRAIN,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  void client.connect();

  let targetId: number | null = null;
  let facing = 0;
  let orderedAt = 0;
  let turnTicks = 0;
  let windupTicks = 0;
  let delayTicks = 0;
  const shots: number[] = [];
  /** Projectile entity ids already counted, so each shot is timed once. */
  const seenShots = new Set<number>();
  let ticks = 0;
  let reverted = false;
  let windingUp = false;
  let lastProgress = 0;
  const atShot: number[] = [];

  while (ticks < 400 && shots.length < 2) {
    ticks += 1;
    server.tick();
    client.advanceTick();
    // Every tick, before anything reads the view: the loopback delivers on a
    // microtask, and the equip that picks the bow is a round trip.
    await settle();

    const view = client.view();
    if (!view.self || !view.stats) continue;

    // A bar that has begun filling must not go back to empty. `castBar` draws a
    // turning cast as empty and a winding-up one as filling, so `Windup` giving
    // way to `Turning` inside one cast *is* the fill-then-vanish the player sees
    // as a second bar.
    const drawn = view.casts.find((cast) => cast.entityId === view.selfEntityId);
    if (drawn) {
      lastProgress = castBar(drawn, view.estimatedTick).progress;
    }
    if (!drawn) windingUp = false;
    else if (drawn.phase === CastPhaseValue.Windup) windingUp = true;
    else if (windingUp && drawn.phase === CastPhaseValue.Turning) reverted = true;

    const live = server.world.entities as Map<number, ServerEntity>;

    // The tick each of our shots appeared, once each. Keyed by entity id: the
    // timestamp has to be *now*, not anything carried on the projectile, or the
    // measurement picks up the flight rather than the wait in front of it.
    for (const entity of live.values()) {
      if (!entity.projectile || entity.projectile.ownerId !== view.selfEntityId) continue;
      if (seenShots.has(entity.id)) continue;
      seenShots.add(entity.id);
      shots.push(ticks);
      atShot.push(lastProgress);
    }

    if (targetId === null) {
      client.equip('mainHand', 'bow.hunting');
      const self = live.get(view.selfEntityId);
      if (!self || view.stats.basicAttackId !== 'ranged.shot') continue;
      // The body spawns facing +x. The mark goes *behind* it, well inside reach,
      // so the only thing between the order and the first shot is a half-turn --
      // no chase, no approach.
      server.spawnEntities('dummy', self.position.x - 200, self.position.y, 1);
      targetId = [...live.values()].find((e) => e.id !== view.selfEntityId)?.id ?? null;
      orderedAt = ticks;
      facing = self.facing;
      // Both budgets come from the *resolved* timing rather than from the
      // ability's authored wind-up and the bare BAT (spec 173). The bow says
      // `attackSpeedPct: -0.1` and that now reaches the factor, which divides
      // the interval and the attack point alike -- so reading either number raw
      // is measuring the body against a clock it is not running on. Through
      // `attackTimingFor`, so this asks the same function the sim answers with.
      const shot = abilityById('ranged.shot');
      const timing = shot ? attackTimingFor(shot, { stats: view.stats }) : null;
      windupTicks = timing?.attackPointTicks ?? 0;
      delayTicks = timing?.intervalTicks ?? view.stats.baseAttackTimeTicks;
      // Half a revolution at this body's own rate, in ticks.
      turnTicks = Math.ceil(180 / (view.stats.turnRate / SERVER_TICK_RATE));
      continue;
    }

    const mob = live.get(targetId);
    const me = live.get(view.selfEntityId);
    // Immortal on both sides: the dummy must survive to be shot at twice.
    if (me) live.set(view.selfEntityId, { ...me, health: me.stats.maxHealth });
    if (mob) live.set(targetId, { ...mob, health: mob.stats.maxHealth });

    const entity = view.entities.find((e) => e.id === targetId);
    const swing = abilityById(view.stats.basicAttackId || 'melee.slash');
    const decision = autoAttack({
      self: view.self,
      selfHealth: view.entities.find((e) => e.id === view.selfEntityId)?.health ?? 1,
      target: entity
        ? { id: entity.id, x: entity.x, y: entity.y, radius: 22, health: entity.health }
        : null,
      range: swing?.range ?? 0,
      rooted: view.selfRoot !== null,
      staggered: view.selfStaggered,
      pending: view.awaitingCast,
      readyAtTick: view.cooldowns[view.stats.basicAttackId] ?? 0,
      aligned: !entity ? true : facesAim(view.self, facing, { x: entity.x, y: entity.y }),
      tick: view.estimatedTick,
    });

    const intent = moveIntent({
      held: new Set<string>(),
      self: view.self,
      destination: decision.chaseTo,
      route: null,
      facing,
      castAim: view.selfRoot,
      targetAim: entity ? { x: entity.x, y: entity.y } : null,
    });
    facing = turnToward(facing, intent.facing, view.stats.turnRate, SERVER_TICK_RATE);
    client.sendInput({ moveX: intent.moveX, moveY: intent.moveY, facing, buttons: 0 });
    if (decision.attack && entity) {
      client.useAbility(view.stats.basicAttackId, entity.x, entity.y, entity.id);
    }
    await settle();
  }

  client.disconnect();
  return {
    turnTicks,
    windupTicks,
    delayTicks,
    orderedAt,
    firstAt: shots[0] ?? -1,
    secondAt: shots[1] ?? -1,
    reverted,
    barAtShot: atShot,
  };
}

describe('two shots, from a body that had to turn right round (spec 090)', () => {
  it('pays for the turn once, and then only for the attack delay', async () => {
    const run = await twoShots();
    const seen = JSON.stringify(run);

    // One bar per cast, filling once (spec 090). Not a timing property, so
    // neither interval below covers it -- it is the same run asked a second
    // question, because the same turn provokes both faults.
    //
    // Honest about its reach: this loopback has no latency, and the two clocks
    // only disagree about the phase when they are a tick or two apart. Reverting
    // the commit tolerance does *not* trip this here -- it needs the delay line
    // `cancel-latency.test.ts` has. Kept because the invariant is right and the
    // check is free, not because it is currently load-bearing.
    expect(run.reverted, `a wind-up went back to turning: ${seen}`).toBe(false);

    expect(run.firstAt, seen).toBeGreaterThan(0);
    expect(run.secondAt, seen).toBeGreaterThan(run.firstAt);

    // The request rides the input queue and the server dequeues one input per
    // tick, so a couple of ticks of overhead is real. Measured, and bit-stable
    // across runs because nothing here reads a clock: the first shot lands two
    // ticks over turn-plus-wind-up, the second exactly one tick over the
    // cadence. The budgets sit just above that on purpose. A slack wide enough
    // to absorb a turn paid twice (16 ticks) or a dead pause in front of one (a
    // whole attack delay) is a test that cannot fail for the reasons it exists.
    //
    // It is not tight enough to catch everything: judging alignment off the
    // *replica* rather than the local heading costs two ticks here, and lands
    // inside `SLACK`. That regression is a fifth of a second in the real client,
    // where the delta interval and the interpolator add what a loopback does
    // not -- so this is the wrong instrument for it, rather than a budget to
    // shave until it happens to bite.
    const SLACK = 3;
    const INTERVAL_SLACK = 4;

    // The first shot pays for the half-turn and the wind-up, and nothing else.
    // A dead pause in front of the turn -- the "click, wait, turn, shoot" report
    // -- lands here.
    expect(run.firstAt - run.orderedAt, `first shot: ${seen}`).toBeLessThanOrEqual(
      run.turnTicks + run.windupTicks + SLACK,
    );

    // And the second pays for the attack delay and one wind-up, and nothing
    // else. This is the headline: the body is already facing its mark, so
    // nothing may be spent turning, waiting for a stale replica to agree, or
    // restarting a wind-up both ends disagreed about.
    //
    // The interval *contains* the wind-up since spec 144: it is measured from
    // the tick the draw begins, not from the tick the arrow leaves. So the gap
    // between two loosed shots is one Base Attack Time and nothing more -- the
    // second draw starts while the first shot's interval is still running, and
    // finishes exactly as it expires.
    //
    // This is the line spec 091 got wrong and 144 corrects: `delay + windup`
    // was one wind-up too long, which is why two bodies on the same BAT with
    // different weapons used to attack at different rates.
    const cadence = run.delayTicks;
    expect(run.secondAt - run.firstAt, `interval: ${seen}`).toBeLessThanOrEqual(
      cadence + INTERVAL_SLACK,
    );
    // Nor may it be *shorter* than that: the delay is a floor, and a second shot
    // that beat it would mean the cooldown was not being served.
    expect(run.secondAt - run.firstAt, `interval: ${seen}`).toBeGreaterThanOrEqual(cadence);
  }, 30_000);
});
