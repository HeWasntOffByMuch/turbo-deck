/**
 * Changing a skill, over the wire (spec 184).
 *
 * A real client, a real server, real encoded frames -- because everything worth
 * asserting here is about the *seam*: the swap is refused, or delayed, or
 * applied, by the server, and the client is told which by the same `Inventory`
 * resend every other container edit is answered with.
 *
 * The two things that could only be got wrong here rather than in a pure test:
 * that the swap is not instantaneous, and that the client does not draw it as
 * though it were.
 */

import { describe, expect, it } from 'vitest';
import { abilityById } from '../data/abilities.js';
import { AdminProgressMode } from '../net/protocol.js';
import { SKILL_SWAP, SkillSwapKind } from '../data/skill-effects.js';
import { equipmentAddress } from '../player/inventory.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { statusOf } from '../sim/statuses.js';
import { ActivityValue } from '../sim/types.js';
import { type Inventory } from '../state/types.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly server: GameServer;
  readonly client: GameClient;
}

async function harness(playerId = 'p1'): Promise<Harness> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const client = new GameClient(transport.connect(), { playerId, displayName: playerId });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  await settle();
  return { server, client };
}

const inv = (index: number) => ({ container: 'inventory', index }) as const;

function indexOf(inventory: Inventory, defId: string): number {
  return inventory.findIndex((stack) => stack?.defId === defId);
}

/** Runs `ticks` server ticks, letting each one's messages land. */
async function ticks(server: GameServer, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    server.tick();
    await settle();
  }
}

describe('putting a skill in a slot', () => {
  it('starts with a sigil in the bag and four empty slots', async () => {
    const { client } = await harness();
    const view = client.view();
    expect(indexOf(view.inventory, 'sigil.guardBreak')).toBeGreaterThanOrEqual(0);
    expect(view.equipment.skill1).toBeNull();
  });

  /**
   * The heart of it. Every other move in this game is drawn on the frame the
   * player released it and rolled back if the server disagrees; a swap is not
   * drawn at all until it lands, because the server holds it on purpose and a
   * bar that showed the new skill early would offer a button the server refuses.
   */
  it('does not take effect on the tick it is asked for', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    server.tick();
    await settle();
    expect(client.view().equipment.skill1).toBeNull();
  });

  it('lands once its duration has run', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 2);
    expect(client.view().equipment.skill1).toBe('sigil.guardBreak');
  });

  /**
   * The status is the brief's "can apply an existing status effect to the
   * player during or after the swap", and it is an existing one with an
   * existing reader rather than a debuff invented for this.
   */
  it('marks the swapper while the swap is in flight', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    server.tick();
    await settle();
    const body = [...server.world.entities.values()].find((entity) => entity.ownerPlayerId === 'p1');
    expect(body).toBeTruthy();
    expect(statusOf(body?.statuses ?? {}, SKILL_SWAP.statusId, server.world.tick)).toBeTruthy();
  });

  it('puts what it casts on the bar’s ability list once it lands', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 2);
    // Derived on the server from the four slots, replicated on `Stats`, and
    // never read from a client -- so this is the *server's* answer about what
    // this character may cast.
    expect(client.view().stats?.skillAbilityIds).toContain('skill.guardBreak');
  });
});

describe('a skill on cooldown cannot be swapped out', () => {
  it('refuses the move and leaves the slot as it was', async () => {
    const { server, client } = await harness();
    // Whirlwind, because it is the one of the four that needs no target: the
    // cooldown below has to come from a cast the sim really resolved.
    // Levelled first: the Whirlwind sigil is a level-5 item, and an equip
    // refused for that reason would be a different rule failing.
    await server.playerManager.setProgress('p1', AdminProgressMode.SetLevel, 10);
    await server.giveItem('p1', 'sigil.whirlwind', 1);
    await settle();
    const at = indexOf(client.view().inventory, 'sigil.whirlwind');
    expect(at, 'the sigil reached the bag').toBeGreaterThanOrEqual(0);
    const from = inv(at);
    client.moveItem(from, equipmentAddress('skill3'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 2);
    expect(client.view().equipment.skill3).toBe('sigil.whirlwind');

    // Put it on cooldown **the way the game does**: cast it. Nothing here
    // writes a cooldown by hand, so what is being tested is the rule against
    // the state the sim actually produces rather than against a number a test
    // invented.
    const body0 = [...server.world.entities.values()].find((e) => e.ownerPlayerId === 'p1');
    client.useAbility('skill.whirlwind', body0?.position.x ?? 0, body0?.position.y ?? 0);
    await settle();
    const whirlwind = abilityById('skill.whirlwind');
    await ticks(server, (whirlwind?.windupTicks ?? 0) + 3);
    const body = [...server.world.entities.values()].find((entity) => entity.ownerPlayerId === 'p1');
    expect(body?.cooldowns['skill.whirlwind'] ?? 0).toBeGreaterThan(server.world.tick);

    const free = client.view().inventory.findIndex((stack) => stack === null);
    client.moveItem(equipmentAddress('skill3'), inv(free));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 2);
    expect(client.view().equipment.skill3).toBe('sigil.whirlwind');
  });
});

/**
 * The brief's "a client may request activation, but authoritative validation
 * and resolution happen where normal combat resolves".
 *
 * The check this asserts is the first ownership check the ability system has
 * ever had: before spec 184, `STARTING_ABILITIES` was exported and read by
 * nothing, so a client could send any id in the table on its first tick and the
 * server would cast it.
 */
describe('the server decides what a client may cast', () => {
  it('refuses a skill the caster is not carrying, however it is asked for', async () => {
    const { server, client } = await harness();
    const rejections: string[] = [];
    client.onCastRejected((_abilityId, reason) => rejections.push(reason));
    // The sigil is in the bag and in no slot, which is exactly the case a
    // client bypassing its own bar would produce.
    expect(client.view().equipment.skill1).toBeNull();
    client.useAbility('skill.guardBreak', 0, 0);
    await settle();
    await ticks(server, 4);
    expect(rejections).toContain('notEquipped');
  });

  it('lets it through once the sigil is actually worn', async () => {
    const { server, client } = await harness();
    const rejections: string[] = [];
    client.onCastRejected((_abilityId, reason) => rejections.push(reason));
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 2);

    const body = [...server.world.entities.values()].find((entity) => entity.ownerPlayerId === 'p1');
    client.useAbility('skill.guardBreak', body?.position.x ?? 0, body?.position.y ?? 0);
    await settle();
    await ticks(server, 4);
    // Refused for having no target, which is a *different* refusal and the one
    // a unit-targeted skill asked for with nothing named should get.
    expect(rejections).not.toContain('notEquipped');
    expect(rejections).toContain('noTarget');
  });
});

/**
 * Two other ways a slot could have been emptied, both closed (spec 184).
 *
 * The lock has to be on the *state* rather than on one message, or the way
 * round it is a button the interface already has. `Equip`/`Unequip` is the
 * weapon switch's path and is instantaneous by design; `DropItem` throws
 * something on the ground, which is removing it.
 */
describe('a skill slot cannot be emptied by the back door', () => {
  it('refuses the weapon switch’s equip path', async () => {
    const { server, client } = await harness();
    client.equip('skill1', 'sigil.guardBreak');
    await settle();
    await ticks(server, 4);
    expect(client.view().equipment.skill1).toBeNull();
  });

  it('refuses unequipping one', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 2);
    expect(client.view().equipment.skill1).toBe('sigil.guardBreak');

    client.unequip('skill1');
    await settle();
    await ticks(server, 4);
    expect(client.view().equipment.skill1).toBe('sigil.guardBreak');
  });

  it('refuses throwing a skill on cooldown out of its slot', async () => {
    const { server, client } = await harness();
    await server.playerManager.setProgress('p1', AdminProgressMode.SetLevel, 10);
    await server.giveItem('p1', 'sigil.whirlwind', 1);
    await settle();
    const at = indexOf(client.view().inventory, 'sigil.whirlwind');
    client.moveItem(inv(at), equipmentAddress('skill3'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 2);

    const body = [...server.world.entities.values()].find((entity) => entity.ownerPlayerId === 'p1');
    client.useAbility('skill.whirlwind', body?.position.x ?? 0, body?.position.y ?? 0);
    await settle();
    await ticks(server, (abilityById('skill.whirlwind')?.windupTicks ?? 0) + 3);

    client.dropItem(equipmentAddress('skill3'), { x: 1000, y: 1000 });
    await settle();
    await ticks(server, 30);
    expect(client.view().equipment.skill3).toBe('sigil.whirlwind');
  });
});

/**
 * A swap is a **commitment**, not a timer (spec 184).
 *
 * The difference is that a commitment can be given up, and the body carries a
 * state saying it is being made. That state is the claim: `activity` is
 * `Swapping` until the change lands, and anything that takes the body takes the
 * swap with it -- which is one comparison in `serveSwaps` rather than four
 * cancellation paths.
 */
describe('the commitment', () => {
  const bodyOf = (server: GameServer) =>
    [...server.world.entities.values()].find((entity) => entity.ownerPlayerId === 'p1');

  it('puts the body into a visible state for the whole change', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    server.tick();
    await settle();
    const body = bodyOf(server);
    expect(body?.activity).toBe(ActivityValue.Swapping);
    expect(body?.activityUntilTick ?? 0).toBeGreaterThan(server.world.tick);
  });

  it('lets the body go again once the change lands', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 3);
    expect(bodyOf(server)?.activity).not.toBe(ActivityValue.Swapping);
    expect(client.view().equipment.skill1).toBe('sigil.guardBreak');
  });

  /**
   * The whole point of the state. Walking away from a change is how you decline
   * to make it, which is exactly what asking to move already does to a wind-up.
   */
  it('is given up by walking away, and the skill stays where it was', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    await ticks(server, 4);
    expect(bodyOf(server)?.activity).toBe(ActivityValue.Swapping);

    // A held direction, which is what a player pressing a movement key sends.
    for (let i = 0; i < 6; i++) {
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      server.tick();
      await settle();
    }
    expect(bodyOf(server)?.activity).not.toBe(ActivityValue.Swapping);

    // And it never lands, however long the clock is left to run.
    await ticks(server, SKILL_SWAP.durationTicks + 3);
    expect(client.view().equipment.skill1).toBeNull();
  });

  it('tells the client what is in flight, and stops telling it when it ends', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    server.tick();
    await settle();

    const swap = client.view().pendingSwap;
    expect(swap).toBeTruthy();
    // Putting something into an empty slot is an equip, and the server derived
    // that from its own containers -- the client never said which it was.
    expect(swap?.kind).toBe(SkillSwapKind.Equip);
    expect(swap?.to).toEqual(equipmentAddress('skill1'));
    expect(swap?.readyAtTick ?? 0).toBeGreaterThan(swap?.startedTick ?? 0);

    await ticks(server, SKILL_SWAP.durationTicks + 3);
    expect(client.view().pendingSwap).toBeNull();
  });

  it('calls taking one off a removal, and exchanging one a swap', async () => {
    const { server, client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'sigil.guardBreak'));
    client.moveItem(from, equipmentAddress('skill1'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 3);

    const free = client.view().inventory.findIndex((stack) => stack === null);
    client.moveItem(equipmentAddress('skill1'), inv(free));
    await settle();
    server.tick();
    await settle();
    expect(client.view().pendingSwap?.kind).toBe(SkillSwapKind.Unequip);
  });

  it('calls dropping one skill onto another a swap', async () => {
    const { server, client } = await harness();
    await server.playerManager.setProgress('p1', AdminProgressMode.SetLevel, 10);
    await server.giveItem('p1', 'sigil.whirlwind', 1);
    await settle();
    client.moveItem(inv(indexOf(client.view().inventory, 'sigil.guardBreak')), equipmentAddress('skill1'));
    await settle();
    await ticks(server, SKILL_SWAP.durationTicks + 3);

    // A second sigil into the slot the first is in: the slot is occupied, so
    // this is an exchange rather than an equip.
    client.moveItem(inv(indexOf(client.view().inventory, 'sigil.whirlwind')), equipmentAddress('skill1'));
    await settle();
    server.tick();
    await settle();
    expect(client.view().pendingSwap?.kind).toBe(SkillSwapKind.Swap);
  });
});
