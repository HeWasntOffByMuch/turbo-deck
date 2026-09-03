/**
 * Mobile Offense, as a player actually reaches it (spec 254).
 *
 * `sim/mobile-offense.test.ts` drives the mechanic through `step`, which is the
 * right instrument for what it pays and what it must not touch. This asks the
 * different question a bug report asks: **buy it the way a player buys it, use
 * it the way a player uses it, and does the number they are looking at move?**
 * A real `GameClient` against a real `GameServer` over a real loopback, so the
 * purchase, the equip, the cast, the cancel and the readout all cross the wire.
 *
 * It exists because the answer to "I cancel my follow-through and see nothing"
 * has three candidate causes and only one of them is a bug -- the trait can be
 * zero because nothing was bought, the withdrawal can be a *turn* rather than a
 * walk, or the reduction can be masked by the client's own cooldown prediction.
 * The last one is the only one worth a test, and the other two are the controls
 * that make it mean something.
 */

import { describe, expect, it } from 'vitest';

import { SERVER_TICK_RATE } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { SKILL_SWAP } from '../data/skill-effects.js';
import { AdminProgressMode } from '../net/protocol.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { PERFECT_WIRE, UnreliableChannel } from '../net/unreliable.js';
import { Rng } from '../../shared/prng.js';
import { equipmentAddress } from '../player/inventory.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';

/**
 * Yield the event loop, so anything the loopback queued is delivered.
 *
 * `setImmediate` rather than `setTimeout(resolve, 0)` (spec 274). Node clamps a
 * zero timeout to one millisecond, so a settle awaited twice per simulated tick
 * cost 1.12ms of doing nothing against this call's 0.004ms -- 147 of the suite's
 * 330 CPU-seconds, and 39.6s of `rate-match.test.ts` alone. It is also the
 * stronger barrier: the check phase runs after the poll phase, where a timer
 * fires at the top of the next loop iteration.
 */
/**
 * Yield the event loop, so anything the loopback queued is delivered.
 *
 * `setImmediate` rather than `setTimeout(resolve, 0)` (spec 274). Node clamps a
 * zero timeout to one millisecond, so a settle awaited twice per simulated tick
 * cost 1.12ms of doing nothing against this call's 0.004ms -- 147 of the suite's
 * 330 CPU-seconds, and 39.6s of `rate-match.test.ts` alone. It is also the
 * stronger barrier: the check phase runs after the poll phase, where a timer
 * fires at the top of the next loop iteration.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A sigil with a cooldown long enough that a 1.2s cut is unambiguous. */
const SIGIL = 'sigil.arcLash';
const SKILL = 'skill.arcLash';
/** Enough to wear it, and enough points to buy Agility 10 plus three tiers. */
const LEVEL = 10;

interface Session {
  readonly server: GameServer;
  readonly client: GameClient;
  readonly selfId: number;
  /** One tick, with whatever the body is currently asking for. */
  advance(): Promise<void>;
  /** What the body asks for each tick from now on. */
  intent(next: { moveX: number; moveY: number; facing: number }): void;
}

/**
 * A connected player at {@link LEVEL} with `tiers` of Mobile Offense bought and
 * a sigil in `skill1`.
 *
 * Every step of that goes through the client: the attributes and the tiers are
 * `SpendProgressionPoint` messages and the equip is a `MoveItem`, because the
 * point of this file is that the path a player takes works. A direct call to
 * `playerManager` would set the record and leave the client's own derived stats
 * behind -- `session.test.ts` records that trap for the equip, and it is the
 * same trap for a purchase.
 */
async function session(tiers: number, delayTicks = 0): Promise<Session> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  // Over a *delayable* line rather than the bare loopback, because the bug this
  // file exists to pin is a function of how far the client's lookahead is from
  // the tick the server actually commits on -- and a harness that cannot vary
  // that measures one arbitrary point of it. At `delayTicks: 0` this is the
  // loopback, one explicit delivery at a time.
  const line = new UnreliableChannel(
    transport.connect(),
    () => ({ ...PERFECT_WIRE, delayTicks }),
    Rng.fromSeed(1),
    () => undefined,
  );
  const client = new GameClient(line, { playerId: 'alice', displayName: 'alice' });
  const welcomed = client.connect();
  await settle();
  line.deliver(0);
  await settle();

  let tick = 0;
  let asking = { moveX: 0, moveY: 0, facing: 0 };
  const advance = async (): Promise<void> => {
    tick += 1;
    line.deliver(tick);
    await settle();
    server.tick();
    client.advanceTick();
    if (client.view().self) client.sendInput({ ...asking, buttons: 0 });
    line.deliver(tick);
    await settle();
  };
  for (let i = 0; i < 40 + delayTicks * 4; i++) await advance();
  await welcomed;

  const manager = server.playerManager;
  const levelled = await manager.setProgress('alice', AdminProgressMode.SetLevel, LEVEL);
  if (!levelled.ok) throw new Error(`could not level: ${levelled.reason}`);
  for (let i = 0; i < 3; i++) await advance();

  // Agility 10 is `SPECIALIZATION_THRESHOLDS[0]` and is what unlocks the row at
  // all -- five points from a starting 5, which is most of a fresh character's
  // whole budget and the reason a default character has none of this.
  for (let i = 0; i < 5; i++) {
    client.spendOnAttribute('agility');
    await advance();
  }
  for (let i = 0; i < tiers; i++) {
    client.spendOnSpecialization('agi.mobileOffense');
    await advance();
  }

  const given = await manager.giveItem('alice', SIGIL, 1);
  if (!given.ok) throw new Error(`could not give ${SIGIL}: ${given.reason}`);
  const index = manager.get('alice')?.record.inventory.findIndex((s) => s?.defId === SIGIL) ?? -1;
  if (index < 0) throw new Error(`${SIGIL} did not land in the bag`);
  client.moveItem({ container: 'inventory', index }, equipmentAddress('skill1'), 1);
  await settle();
  for (let i = 0; i <= SKILL_SWAP.durationTicks + delayTicks * 3; i++) await advance();
  if (manager.get('alice')?.record.equipment.skill1 !== SIGIL) throw new Error('sigil never equipped');

  return {
    server,
    client,
    selfId: client.view().selfEntityId,
    advance,
    intent: (next) => {
      asking = next;
    },
  };
}

/**
 * Put the skill on cooldown, swing the weapon, and leave the follow-through the
 * way `withdraw` says.
 *
 * Returns the skill's ready tick either side of the withdrawal, from the server
 * *and* from what the client is drawing -- because "the server reduced it" and
 * "the player can see it" are two claims, and only the second is what a bug
 * report is about.
 */
async function cancelAfterAttack(
  test: Session,
  withdraw: 'walk' | 'turn',
): Promise<{ before: number; after: number; shownBefore: number; shown: number }> {
  const arc = abilityById(SKILL);
  const me = test.client.view().self;
  if (!arc || !me) throw new Error('no ability or no body');

  test.client.useAbility(SKILL, me.x + arc.range * 0.5, me.y);
  for (let i = 0; i < 90; i++) await test.advance();
  if ((test.server.world.entities.get(test.selfId)?.cooldowns[SKILL] ?? 0) <= 0) {
    throw new Error('the skill never went on cooldown');
  }

  test.client.useAbility('melee.slash', me.x + 40, me.y);
  let before = 0;
  let shownBefore = 0;
  let done = false;
  for (let i = 0; i < 90; i++) {
    const body = test.server.world.entities.get(test.selfId);
    // The follow-through: the blow has landed and the body is still rooted.
    if (!done && body?.cast?.committed === true) {
      before = body.cooldowns[SKILL] ?? 0;
      shownBefore = test.client.view().cooldowns[SKILL] ?? 0;
      // A **walk** is a withdrawal and a **turn** is not: `asksToMove` reads the
      // move vector, so spinning on the spot is not leaving anything.
      test.intent(
        withdraw === 'walk'
          ? { moveX: 0, moveY: 1, facing: Math.PI / 2 }
          : { moveX: 0, moveY: 0, facing: Math.PI },
      );
      done = true;
    }
    await test.advance();
    // **Held rather than pressed once** (spec 258). A follow-through is
    // committed until its cancel point, so one tick of walking at the attack
    // point is refused and never retried -- and the client will not even send
    // the vector until its own estimate reaches that tick. Let go once the cast
    // is actually gone, which is what both rewards hang off.
    if (done && test.server.world.entities.get(test.selfId)?.cast === null) {
      test.intent({ moveX: 0, moveY: 0, facing: 0 });
    }
  }
  if (!done) throw new Error('the swing never reached its follow-through');

  return {
    before,
    shownBefore,
    after: test.server.world.entities.get(test.selfId)?.cooldowns[SKILL] ?? 0,
    shown: test.client.view().cooldowns[SKILL] ?? 0,
  };
}

const PER_TIER = Math.round(0.4 * SERVER_TICK_RATE);

describe('Mobile Offense, bought and used through the wire', () => {
  it('takes 1.2s off the cooling skill at three tiers, and the client sees it', async () => {
    const test = await session(3);
    expect(test.server.world.entities.get(test.selfId)?.stats.traits.mobileOffenseCooldownTicks).toBe(
      3 * PER_TIER,
    );

    const { before, after, shownBefore, shown } = await cancelAfterAttack(test, 'walk');
    expect(before - after).toBe(3 * PER_TIER);
    // The half a sim test cannot reach, and the claim has to be about what the
    // number **moved by**, not about it matching the server's exactly.
    // `visibleCooldowns` raises the server's table by this client's own guess,
    // which is deliberately `oneWayTicks()` ahead -- that lead is what stops
    // every "am I off cooldown" comparing a server tick against a clock running
    // in front of it and asking early. So the bar legitimately sits a tick above
    // the truth; what it must not do is fail to come down.
    expect(shownBefore - shown).toBe(3 * PER_TIER);
    expect(shown).toBeGreaterThanOrEqual(after);
  });

  /**
   * The control that makes the symptom legible: a default character has 5 in
   * every attribute and six points, and Mobile Offense costs Agility 10 plus a
   * tier. Nothing bought, nothing happens -- which is exactly what "I cancel and
   * see no deduction" looks like from the outside.
   */
  it('does nothing at all with no tiers bought', async () => {
    const test = await session(0);
    const { before, after } = await cancelAfterAttack(test, 'walk');
    expect(before - after).toBe(0);
  });

  /**
   * And the other control. Turning is not withdrawing and never has been -- the
   * Flow grant this replaced read the same `asksToMove`. A player who turns away
   * after an attack has not left the follow-through; they have stood in it,
   * facing elsewhere.
   */
  it('does nothing when the body turns without walking', async () => {
    const test = await session(3);
    const { before, after } = await cancelAfterAttack(test, 'turn');
    expect(before - after).toBe(0);
  });

  /**
   * The feedback the mechanic shipped without (spec 254).
   *
   * Cooldown coming off a *different* button from the one that earned it is the
   * least visible reward this game hands out -- the reward it replaced was a
   * Flow stack, which has a row in `data/status-visuals.ts` and therefore put a
   * mark over the player's head. This is the wire half of putting one back: the
   * client works the refund out for itself, from two of the server's own
   * cooldown tables, with nothing added to the protocol.
   */
  it('tells the client a cooldown got shorter, and by how much', async () => {
    const test = await session(3);
    const heard: { abilityId: string; ticks: number }[] = [];
    test.client.onCooldownRefund((refunds) => heard.push(...refunds));

    await cancelAfterAttack(test, 'walk');
    expect(heard).toEqual([{ abilityId: SKILL, ticks: 3 * PER_TIER }]);
  });

  /**
   * **The bar has to follow the refund, at every latency.**
   *
   * `visibleCooldowns` raises the server's table by what this client has spent
   * and not been told about, and a guess is retired when the server has stamped
   * a cooldown for the cast it was guessing at. That test used to compare the
   * two *values*, which is wrong by a tick whenever the client's lookahead and
   * the tick the server committed on differ at all -- and a guess one tick above
   * the truth is never retired, so it goes on being returned and masks
   * everything the server says afterwards.
   *
   * Measured over a **zero-latency** loopback, which is the case that broke and
   * the last one anybody would have thought to check: the refund landed
   * correctly on the server, the mark was drawn, and the number on the button
   * sat 1.22s behind the truth for the rest of the cooldown. Latency is swept
   * because the offset is a function of it, and one point of the sweep is not
   * evidence about the others -- the version that shipped passed at 3, 6 and 12
   * ticks and failed only at 0.
   */
  it.each([0, 1, 3, 6, 12])('shows the reduced cooldown at %i ticks of latency', async (delay) => {
    const test = await session(3, delay);
    const { before, after, shownBefore, shown } = await cancelAfterAttack(test, 'walk');
    expect(before - after).toBe(3 * PER_TIER);
    // Moved by the refund, and never *below* the server's own number: the
    // overlay may push a cooldown later and must never light a button early.
    expect(shownBefore - shown).toBe(3 * PER_TIER);
    expect(shown).toBeGreaterThanOrEqual(after);
  });

  it('tells it nothing when nothing was refunded', async () => {
    const test = await session(0);
    const heard: { abilityId: string; ticks: number }[] = [];
    test.client.onCooldownRefund((refunds) => heard.push(...refunds));

    await cancelAfterAttack(test, 'walk');
    expect(heard).toEqual([]);
  });
});
