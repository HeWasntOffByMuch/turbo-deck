/**
 * Predicting the blow (spec 069).
 *
 * Two halves, and the split is deliberate. The pure half exercises the timeline
 * and the gate directly, because they are functions and a function is cheaper to
 * pin down than a session. The wired half drives a real `GameClient` against a
 * real `GameServer` over a real loopback, because the thing being claimed is
 * about *what the player sees* and that only exists once a view is being read.
 *
 * What is not asserted anywhere: that the prediction is right. It is not always,
 * and it is not supposed to be -- the server decides. What is asserted is that
 * the guess appears immediately, that the server always wins, and that a refused
 * guess gives back exactly what it took and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { BROADCAST_EVERY_N_TICKS, SERVER_TICK_RATE } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { CastPhase, type CastState } from '../sim/types.js';
import type { EffectiveStats } from '../state/types.js';
import { advanceCast, mayCast, modelledResource, steerFacing, type Mirror } from './combat.js';
import { GameClient } from './game-client.js';
import { NO_ATTACK_SPEED } from '../sim/attack-timing.js';
import { NO_WEAPON } from '../data/weapon-scaling.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import { EntityActivity } from '../net/protocol.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const STATS: EffectiveStats = {
  maxHealth: 100,
  moveSpeed: 250,
  turnRate: 540,
  attackDamage: 10,
  attackRange: 60,
  baseAttackTimeTicks: 24,
  ...NO_ATTACK_SPEED,
  armor: 0,
  spellPower: 1,
  critChance: 0,
  maxResource: 20,
  resourceRegen: 0.1,
  basicAttackId: 'melee.slash',
  skillAbilityIds: [],
  ...NO_WEAPON,
  traits: NEUTRAL_TRAITS,
};

function mirror(overrides: Partial<Mirror> = {}): Mirror {
  return {
    position: { x: 0, y: 0 },
    // A full flask, so a test that does not care about the health economy is
    // never refused for the reason it was not testing (spec 156).
    fallbackCharges: NEUTRAL_TRAITS.fallbackCharges,
    // Pointing east, which is where every aim below is, so a cast starts winding
    // up rather than turning unless a test asks for a turn.
    facing: 0,
    health: 100,
    resource: 20,
    cooldowns: {},
    cast: null,
    stats: STATS,
    poise: 0,
    shield: 0,
    // Not staggered, which is what every test here that is not about the
    // stagger assumes (spec 173).
    activity: 0,
    activityUntilTick: 0,
    ...overrides,
  };
}

const EAST = { x: 100, y: 0 };

describe('the gate, asked of a mirror', () => {
  it('accepts a ready ability and hands back the cast the server would', () => {
    const decision = mayCast(mirror(), 'melee.slash', EAST, 100, 100);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const ability = abilityById('melee.slash');
    expect(decision.cast.phase).toBe(CastPhase.Windup);
    expect(decision.cast.releaseTick).toBe(100 + (ability?.windupTicks ?? 0));
    expect(decision.cast.targetX).toBe(EAST.x);
  });

  it('refuses what the server would refuse, by the server’s own reasons', () => {
    // On cooldown, and the ability's own table decides when that ends.
    const onCooldown = mayCast(mirror({ cooldowns: { 'melee.slash': 200 } }), 'melee.slash', EAST, 100, 100);
    expect(onCooldown).toEqual({ ok: false, reason: 'onCooldown' });

    // Already committed to something.
    const busy = mayCast(
      mirror({ cast: { ...(mayCast(mirror(), 'melee.slash', EAST, 0, 0) as { cast: CastState }).cast } }),
      'melee.slash',
      EAST,
      100,
      100,
    );
    expect(busy).toEqual({ ok: false, reason: 'alreadyCasting' });

    // Dead men swing at nothing.
    expect(mayCast(mirror({ health: 0 }), 'melee.slash', EAST, 100, 100)).toEqual({
      ok: false,
      reason: 'dead',
    });
  });

  it('will not predict an ability the mirror cannot afford, and will one it can', () => {
    const bolt = abilityById('bolt.arcane');
    expect(bolt?.cost).toBeGreaterThan(0);
    const cost = bolt?.cost ?? 0;

    expect(mayCast(mirror({ resource: cost - 0.5 }), 'bolt.arcane', EAST, 100, 100)).toEqual({
      ok: false,
      reason: 'notEnoughResource',
    });
    const afforded = mayCast(mirror({ resource: cost }), 'bolt.arcane', EAST, 100, 100);
    expect(afforded.ok).toBe(true);
    if (afforded.ok) expect(afforded.cost).toBe(cost);
  });

  it('decides on one tick and stamps on another', () => {
    // The cooldown is up at 110. Deciding at 110 takes it; the cast it hands
    // back is stamped for 100, which is when the bar has to be drawn from.
    const decision = mayCast(mirror({ cooldowns: { 'melee.slash': 110 } }), 'melee.slash', EAST, 110, 100);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.cast.startedTick).toBe(100);
    expect(decision.cast.releaseTick).toBe(100 + (abilityById('melee.slash')?.windupTicks ?? 0));
    // And the cooldown it expects to have spent runs from the stamp, not the
    // lookahead, or every press would push the next one further out. Its
    // *length* is the caster's own Base Attack Time rather than the ability
    // table's number, because slash is the basic attack (spec 070) -- a client
    // that read the table would grey the button for the wrong span.
    //
    // It runs from the *wind-up's start* rather than from the release
    // (spec 144), which is the one place 144 overrules 091: the interval covers
    // the swing rather than beginning after it. What 091 was protecting is
    // still here in `withdrawLocally`, which takes this guess back when a
    // wind-up is withdrawn from, so the button never greys out for a swing that
    // never happened.
    expect(decision.readyAtTick).toBe(100 + STATS.baseAttackTimeTicks);
    expect(STATS.baseAttackTimeTicks).not.toBe(abilityById('melee.slash')?.cooldownTicks);
  });

  it('starts a cast turning when the body is not yet facing the aim', () => {
    const decision = mayCast(mirror({ facing: Math.PI }), 'melee.slash', EAST, 100, 100);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.cast.phase).toBe(CastPhase.Turning);
  });

  /**
   * Spec 080. Reach to a *body* is measured to its edge on the server, and this
   * is the same `startCast` -- but it was never handed the radius, so it asked a
   * stricter question than the one the server would ask, and refused to predict
   * every attack in the band between the two. Silent on today's content and
   * wrong in principle: the whole reason this calls the sim's own gate is so
   * that a disagreement can only ever come from an input, never from a rule.
   */
  it('measures reach to a named body’s edge, exactly as the server does', () => {
    const star = abilityById('ranged.star');
    if (!star) throw new Error('no ranged.star');
    const radius = 40;
    // Past the range from the centre, inside it from the edge.
    const aim = { x: star.range + radius / 2, y: 0 };

    expect(mayCast(mirror(), 'ranged.star', aim, 100, 100, 7, radius).ok).toBe(true);
    // Named, but with no edge to reach for: the centre check, refused.
    expect(mayCast(mirror(), 'ranged.star', aim, 100, 100, 7, 0)).toEqual({
      ok: false,
      reason: 'outOfRange',
    });
    // A patch of ground has no edge at all, and a radius cannot buy it one.
    expect(mayCast(mirror(), 'ranged.star', aim, 100, 100, 0, radius)).toEqual({
      ok: false,
      reason: 'outOfRange',
    });
  });
});

describe('the predicted timeline', () => {
  const ability = abilityById('melee.slash');
  const start = (tick: number): CastState => {
    const decision = mayCast(mirror(), 'melee.slash', EAST, tick, tick);
    if (!decision.ok) throw new Error('expected the gate to accept');
    return decision.cast;
  };

  it('winds up, and is over on the tick the blow lands', () => {
    let cast: CastState | null = start(0);
    const seen: number[] = [];
    let endedAt = -1;
    for (let tick = 0; tick <= 60 && cast; tick++) {
      cast = advanceCast(cast, 0, { x: 0, y: 0 }, tick, ability);
      if (cast) seen.push(cast.phase);
      else endedAt = tick;
    }
    expect(seen).toContain(CastPhase.Windup);
    // It ended by itself, with nothing from the server at all -- and it ended on
    // the release rather than sitting through a recovery, which is the rule main
    // changed underneath this: once the swing has gone off the body is free.
    expect(cast).toBeNull();
    expect(endedAt).toBe(start(0).releaseTick);
  });

  it('holds a turn until the body has come round, then restarts the wind-up', () => {
    const turning = mayCast(mirror({ facing: Math.PI }), 'melee.slash', EAST, 0, 0);
    expect(turning.ok).toBe(true);
    if (!turning.ok) return;

    // Still facing away: the cast does not advance, and the wind-up has not run.
    const held = advanceCast(turning.cast, Math.PI, { x: 0, y: 0 }, 5, ability);
    expect(held?.phase).toBe(CastPhase.Turning);

    // Aligned at tick 5: the wind-up clock starts *now*, not at the commit, so
    // the turn costs time rather than eating the wind-up.
    const aligned = advanceCast(turning.cast, 0, { x: 0, y: 0 }, 5, ability);
    expect(aligned?.phase).toBe(CastPhase.Windup);
    expect(aligned?.releaseTick).toBe(5 + (ability?.windupTicks ?? 0));
  });
});

describe('the modelled pool', () => {
  it('regenerates toward the cap and never past it', () => {
    expect(modelledResource(10, 0, 0, STATS, 10)).toBeCloseTo(11);
    expect(modelledResource(10, 0, 0, STATS, 100_000)).toBe(STATS.maxResource);
  });

  it('subtracts what is spent and not yet confirmed, and never goes negative', () => {
    expect(modelledResource(10, 0, 3, STATS, 0)).toBeCloseTo(7);
    expect(modelledResource(1, 0, 50, STATS, 0)).toBe(0);
  });
});

describe('the local facing', () => {
  it('turns toward the input when free, and toward the aim while casting', () => {
    const free = steerFacing(0, null, { x: 0, y: 0 }, Math.PI / 2, 540, SERVER_TICK_RATE);
    expect(free).toBeGreaterThan(0);

    // A cast outranks the input: the aim was captured at the commit, so the body
    // comes round to the blow rather than to whatever the mouse is doing now.
    const cast = { targetX: 0, targetY: -100 } as CastState;
    const committed = steerFacing(0, cast, { x: 0, y: 0 }, Math.PI / 2, 540, SERVER_TICK_RATE);
    expect(committed).toBeLessThan(0);
  });

  /**
   * The same order `resolveFacing` reads them in on the server (spec 172), which
   * is the whole requirement: this client never adopts the server's facing after
   * the first seed, so a rule that differed here would leave the local player
   * watching a body that turns at a different time from everybody else's copy of
   * it.
   */
  it('turns toward a pending drop, under a cast and over the input', () => {
    const aim = { x: 0, y: -100 };
    const dropping = steerFacing(0, null, { x: 0, y: 0 }, Math.PI / 2, 540, SERVER_TICK_RATE, aim);
    expect(dropping).toBeLessThan(0);

    // A committed blow still owns the body.
    const cast = { targetX: 0, targetY: 100 } as CastState;
    const casting = steerFacing(0, cast, { x: 0, y: 0 }, 0, 540, SERVER_TICK_RATE, aim);
    expect(casting).toBeGreaterThan(0);

    // And an aim on top of the body is not a direction: the heading stands.
    const here = steerFacing(1.25, null, { x: 4, y: 4 }, 1.25, 540, SERVER_TICK_RATE, { x: 4, y: 4 });
    expect(here).toBeCloseTo(1.25, 9);
  });
});

// --- wired, against a real server -------------------------------------------

interface Wired {
  readonly server: GameServer;
  readonly client: GameClient;
}

async function wire(): Promise<Wired> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const client = new GameClient(transport.connect(), { playerId: 'you' });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  // Enough ticks for a delta to place us and stats to arrive, which is what
  // prediction waits for.
  for (let i = 0; i < BROADCAST_EVERY_N_TICKS * 3; i++) {
    server.tick();
    client.advanceTick();
  }
  await settle();
  return { server, client };
}

function selfCast(client: GameClient): { readonly endTick: number } | undefined {
  const view = client.view();
  return view.casts.find((cast) => cast.entityId === view.selfEntityId);
}

describe('what the player sees, the moment they press', () => {
  it('draws a bar on the very tick of the press, before the server has spoken', async () => {
    const { client } = await wire();
    expect(selfCast(client)).toBeUndefined();

    client.useAbility('melee.slash', 1000, 0);

    // No tick, no settle, no message: the bar is there because the press is.
    expect(selfCast(client)).toBeDefined();
  });

  /**
   * Spec 069 started the sweep on the press, because the server stamped the
   * cooldown on the press. Spec 091 moved the stamp to the release, and this
   * moves with it: a sweep drawn during the wind-up is a promise the withdrawal
   * is about to break, and the button greying out for a swing that never
   * happened is the report this came from.
   */
  it('starts the cooldown sweep at the release, not at the press', async () => {
    const { server, client } = await wire();
    const slash = abilityById('melee.slash');
    expect(slash).toBeDefined();
    if (!slash) return;

    const before = client.view();
    expect(before.cooldowns['melee.slash'] ?? 0).toBeLessThanOrEqual(before.estimatedTick);

    client.useAbility('melee.slash', 1000, 0);

    // The bar is up -- the press is predicted -- but nothing is sweeping yet.
    expect(selfCast(client)).toBeDefined();
    const pressed = client.view();
    expect(pressed.cooldowns['melee.slash'] ?? 0).toBeLessThanOrEqual(pressed.estimatedTick);

    for (let i = 0; i < slash.windupTicks + BROADCAST_EVERY_N_TICKS * 2; i++) {
      server.tick();
      client.advanceTick();
      client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      await settle();
    }

    const after = client.view();
    expect(after.cooldowns['melee.slash'] ?? 0).toBeGreaterThan(after.estimatedTick);
  });

  it('roots the body on the press, and lets it go when the blow is over', async () => {
    const { server, client } = await wire();
    client.useAbility('melee.slash', 1000, 0);
    expect(client.view().selfRoot).not.toBeNull();

    // Long enough for the whole cast, and then some.
    for (let i = 0; i < SERVER_TICK_RATE * 2; i++) {
      server.tick();
      client.advanceTick();
      client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      await settle();
    }
    expect(client.view().selfRoot).toBeNull();
    expect(selfCast(client)).toBeUndefined();
  });

  it('predicts nothing for a second press during a cast, and leaves the first alone', async () => {
    const { client } = await wire();
    client.useAbility('melee.slash', 1000, 0);
    const first = selfCast(client);
    expect(first).toBeDefined();

    client.useAbility('melee.slash', 0, 1000);

    const second = selfCast(client);
    // Same cast, same clock, same aim: the second press was not predicted, and
    // did not re-point or extend the blow already committed to.
    expect(second?.endTick).toBe(first?.endTick);
    expect(client.view().casts.filter((c) => c.entityId === client.view().selfEntityId)).toHaveLength(1);
  });

  it('predicts nothing at all for an ability that does not exist', () => {
    // The local gate refuses it for the same reason the server will, so there is
    // never a bar to take back down.
    expect(mayCast(mirror(), 'nonsense.spell', EAST, 100, 100)).toEqual({
      ok: false,
      reason: 'unknownAbility',
    });
  });

  it('takes the bar back down when the server refuses, and stamps no cooldown', async () => {
    const { server, client } = await wire();

    // Put the ability on cooldown *behind the client's back*, which is the only
    // way to make a prediction that is genuinely wrong: the mirror is built from
    // what the server has said, so it agrees with the server unless something it
    // has not been told about has happened. This is that something.
    const entities = server.world.entities as Map<number, NonNullable<ReturnType<typeof server.world.entities.get>>>;
    const selfId = client.view().selfEntityId;
    const before = entities.get(selfId);
    expect(before).toBeDefined();
    if (!before) return;
    entities.set(selfId, {
      ...before,
      cooldowns: { ...before.cooldowns, 'melee.slash': server.world.tick + SERVER_TICK_RATE * 5 },
    });

    client.useAbility('melee.slash', 1000, 0);
    // The client does not know, so it guesses yes: a bar and a root. Not a
    // sweep -- since spec 091 that waits for the release, which this cast is
    // never going to reach.
    expect(selfCast(client)).toBeDefined();
    expect(client.view().selfRoot).not.toBeNull();
    expect(client.view().cooldowns['melee.slash'] ?? 0).toBeLessThanOrEqual(
      client.view().estimatedTick,
    );

    for (let i = 0; i < BROADCAST_EVERY_N_TICKS * 6; i++) {
      server.tick();
      client.advanceTick();
      client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      await settle();
    }

    // The refusal arrived, and it took back everything the guess took: the bar,
    // the root, and the cooldown it stamped.
    expect(selfCast(client)).toBeUndefined();
    expect(client.view().selfRoot).toBeNull();
    expect(server.world.entities.get(selfId)?.cast ?? null).toBeNull();
  });

  it('lets the server’s own cast supersede the guess', async () => {
    const { server, client } = await wire();
    client.useAbility('melee.slash', 1000, 0);
    const guessed = selfCast(client)?.endTick;
    expect(guessed).toBeDefined();

    // Long enough for the commit and its confirmation, short enough that the
    // cast is still running when we look -- otherwise there is nothing to
    // compare and the assertion passes by saying nothing.
    for (let i = 0; i < BROADCAST_EVERY_N_TICKS * 2; i++) {
      server.tick();
      client.advanceTick();
      client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      await settle();
    }

    const entity = server.world.entities.get(client.view().selfEntityId);
    expect(entity?.cast).toBeTruthy();
    // What the client is drawing is the server's numbers, not its own.
    expect(selfCast(client)?.endTick).toBe(entity?.cast?.endTick);
  });

  it('tells the client what it has left to spend', async () => {
    const { server, client } = await wire();
    const bolt = abilityById('bolt.arcane');
    const before = client.view().resource;
    expect(before).toBeGreaterThan(0);

    client.useAbility('bolt.arcane', 1000, 0);
    // Predicted immediately: the pool drops by the cost without a round trip.
    expect(client.view().resource).toBeCloseTo(before - (bolt?.cost ?? 0), 5);

    for (let i = 0; i < BROADCAST_EVERY_N_TICKS * 4; i++) {
      server.tick();
      client.advanceTick();
      client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      await settle();
    }
    const entity = server.world.entities.get(client.view().selfEntityId);
    // And the server's own number is what it settles on.
    expect(client.view().resource).toBeCloseTo(entity?.resource ?? -1, 1);
  });
});

describe('a staggered mirror refuses the same thing the server does (spec 173)', () => {
  it('refuses a cast while the break holds', () => {
    // The mirror used to hardcode `activity: 0`, which would light a button the
    // server is about to refuse -- and a stagger is the one refusal the player
    // did not cause, so it is the one they are least ready for.
    const decision = mayCast(
      mirror({ activity: EntityActivity.Stunned, activityUntilTick: 40 }),
      'melee.slash',
      EAST,
      10,
      10,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('staggered');
  });

  it('takes it again on the tick the window ends', () => {
    // The gate is `tick < activityUntilTick`, the same comparison the sim's own
    // `expireActivity` uses, so the two cannot disagree about the last tick.
    const staggered = mirror({ activity: EntityActivity.Stunned, activityUntilTick: 40 });
    const inside = mayCast(staggered, 'melee.slash', EAST, 39, 39);
    const outside = mayCast(staggered, 'melee.slash', EAST, 40, 40);
    expect(inside.ok).toBe(false);
    expect(outside.ok).toBe(true);
  });

  it('is not fooled by a stale window on an idle body', () => {
    const decision = mayCast(
      mirror({ activity: EntityActivity.Idle, activityUntilTick: 999 }),
      'melee.slash',
      EAST,
      10,
      10,
    );
    expect(decision.ok).toBe(true);
  });
});
