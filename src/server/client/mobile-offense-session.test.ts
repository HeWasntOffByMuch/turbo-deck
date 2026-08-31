/**
 * Mobile Offense, as a player actually reaches it (spec 253).
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
import { equipmentAddress } from '../player/inventory.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
async function session(tiers: number): Promise<Session> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const client = new GameClient(transport.connect(), { playerId: 'alice', displayName: 'alice' });
  const welcomed = client.connect();
  await settle();
  await welcomed;

  let asking = { moveX: 0, moveY: 0, facing: 0 };
  const advance = async (): Promise<void> => {
    await settle();
    server.tick();
    client.advanceTick();
    if (client.view().self) client.sendInput({ ...asking, buttons: 0 });
    await settle();
  };
  for (let i = 0; i < 20; i++) await advance();

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
  for (let i = 0; i <= SKILL_SWAP.durationTicks; i++) await advance();
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
): Promise<{ before: number; after: number; shown: number }> {
  const arc = abilityById(SKILL);
  const me = test.client.view().self;
  if (!arc || !me) throw new Error('no ability or no body');

  test.client.useAbility(SKILL, me.x + arc.range * 0.5, me.y);
  for (let i = 0; i < 60; i++) await test.advance();
  if ((test.server.world.entities.get(test.selfId)?.cooldowns[SKILL] ?? 0) <= 0) {
    throw new Error('the skill never went on cooldown');
  }

  test.client.useAbility('melee.slash', me.x + 40, me.y);
  let before = 0;
  let done = false;
  for (let i = 0; i < 90; i++) {
    const body = test.server.world.entities.get(test.selfId);
    // The follow-through: the blow has landed and the body is still rooted.
    if (!done && body?.cast?.committed === true) {
      before = body.cooldowns[SKILL] ?? 0;
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
    if (done) test.intent({ moveX: 0, moveY: 0, facing: 0 });
  }
  if (!done) throw new Error('the swing never reached its follow-through');

  return {
    before,
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

    const { before, after, shown } = await cancelAfterAttack(test, 'walk');
    expect(before - after).toBe(3 * PER_TIER);
    // The half a sim test cannot reach. The client raises the server's table by
    // what it has spent and not yet been told about (`visibleCooldowns`), which
    // can only ever push a cooldown *later* -- so a reduction arriving under a
    // live guess would be invisible on the bar with the server perfectly right.
    expect(shown).toBe(after);
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
});
