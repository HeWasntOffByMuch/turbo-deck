/**
 * The container over the wire (spec 126): a real client, a real server, real
 * encoded frames.
 *
 * What is worth testing here and nowhere else is the *rollback*. The client
 * guesses the outcome of a move and draws it immediately; the server's resend is
 * what makes that guess true or takes it away. A rollback that only runs on rare
 * failures is a rollback that has quietly stopped working by the time it is
 * needed, which is why the refusal below is asserted as directly as the success.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { EQUIP_SLOTS, INVENTORY_SLOTS, type Inventory } from '../state/types.js';
import { equipmentAddress } from '../player/inventory.js';
import { STARTING_KIT } from '../data/items.js';

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

describe('the container over the wire', () => {
  it('replicates the bag on login, unprompted', async () => {
    const { client } = await harness();
    const view = client.view();
    expect(view.inventory).toHaveLength(INVENTORY_SLOTS);
    // The starting kit, minus what the character is already wearing (spec 126).
    expect(indexOf(view.inventory, 'bow.hunting')).toBeGreaterThanOrEqual(0);
    expect(view.equipment.mainHand).toBe('sword.worn');
  });

  /**
   * The reason equipment is on the wire at all: a paperdoll cannot be drawn from
   * a stat block, and the HUD used to infer the held weapon from one.
   */
  it('says what is worn, not what the numbers imply', async () => {
    const { client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'bow.hunting'));
    client.moveItem(from, equipmentAddress('mainHand'));
    await settle();
    expect(client.view().equipment.mainHand).toBe('bow.hunting');
  });

  it('draws an accepted move before the server has answered', async () => {
    const { client } = await harness();
    const from = inv(indexOf(client.view().inventory, 'helm.leather'));
    client.moveItem(from, equipmentAddress('head'));
    // No settle: nothing has crossed the wire yet.
    expect(client.view().equipment.head).toBe('helm.leather');
    await settle();
    expect(client.view().equipment.head).toBe('helm.leather');
  });

  /**
   * The rollback, asserted directly. The client is told to make a move its own
   * copy of the rules would allow but the server's state does not, and its view
   * must end up equal to the server's rather than to its guess.
   */
  it('rolls a refused move back to what the server holds', async () => {
    const { server, client } = await harness();
    const session = server.playerManager.get('p1');
    expect(session).not.toBeNull();
    if (!session) return;

    // A bow into the head slot: refused by the rules at both ends. The client
    // does not draw it either, and the resend proves nothing moved.
    const from = inv(indexOf(client.view().inventory, 'bow.hunting'));
    const rejections: string[] = [];
    client.onError((code, message) => rejections.push(`${code}:${message}`));
    client.moveItem(from, equipmentAddress('head'));
    await settle();

    expect(rejections).toHaveLength(1);
    expect(client.view().equipment.head).toBeNull();
    expect(client.view().inventory).toEqual(server.playerManager.get('p1')?.record.inventory);
  });

  /**
   * The rollback proper: a guess that is legal by the client's own rules and
   * wrong about the world.
   *
   * Both ends run the same `applyMove`, so a client can only be wrong by being
   * *stale* -- which is the ordinary case the moment anything but this client
   * moves an item, and the case loot will make routine. Here the server empties
   * the slot without telling anyone, the client predicts from what it last
   * heard, draws it, and is put back by the resend.
   */
  it("replaces a stale guess with the server's answer", async () => {
    const { server, client } = await harness();
    const bowAt = indexOf(client.view().inventory, 'bow.hunting');
    const free = client.view().inventory.findIndex((stack) => stack === null);

    // Behind the client's back: nothing is sent, because nothing asked.
    await server.playerManager.moveItem('p1', { from: inv(bowAt), to: inv(free) });
    expect(client.view().inventory[bowAt]?.defId).toBe('bow.hunting');

    client.moveItem(inv(bowAt), equipmentAddress('mainHand'));
    // Drawn immediately, and wrong -- which is the point of predicting.
    expect(client.view().equipment.mainHand).toBe('bow.hunting');

    await settle();
    const record = server.playerManager.get('p1')?.record;
    expect(record?.equipment.mainHand).toBe('sword.worn');
    expect(client.view().equipment).toEqual(record?.equipment);
    expect(client.view().inventory).toEqual(record?.inventory);
  });

  /**
   * A settled move stops being a guess.
   *
   * Predictions are replayed on top of whatever the server last said, so one
   * that is never retired would be re-applied to every resend forever -- the
   * client would keep "helpfully" re-doing a move that has already happened, and
   * drift further from the truth with each unprompted message.
   */
  it('stops replaying a move once it has been answered', async () => {
    const { server, client } = await harness();
    const bowAt = indexOf(client.view().inventory, 'bow.hunting');
    const free = client.view().inventory.findIndex((stack) => stack === null);

    client.moveItem(inv(bowAt), inv(free));
    await settle();
    expect(client.view().inventory[free]?.defId).toBe('bow.hunting');

    // The server puts it back without saying so, then something else prompts an
    // unprompted resend -- a refused unequip will do, and costs nothing.
    await server.playerManager.moveItem('p1', { from: inv(free), to: inv(bowAt) });
    client.unequip('trinket');
    await settle();

    expect(client.view().inventory).toEqual(server.playerManager.get('p1')?.record.inventory);
    expect(client.view().inventory[bowAt]?.defId).toBe('bow.hunting');
  });

  it('refuses to equip something the player is not carrying', async () => {
    const { server, client } = await harness();
    const rejections: string[] = [];
    client.onError((_code, message) => rejections.push(message));
    // `sword.keen` is in the table and in nobody's bag: this is the exact hole
    // spec 126 exists to close.
    client.equip('mainHand', 'sword.keen');
    await settle();
    expect(rejections.join(' ')).toContain('not carrying');
    expect(server.playerManager.get('p1')?.record.equipment.mainHand).toBe('sword.worn');
  });

  it('puts what was worn back in the bag when it is taken off', async () => {
    const { server, client } = await harness();
    client.unequip('chest');
    await settle();
    const record = server.playerManager.get('p1')?.record;
    expect(record?.equipment.chest).toBeNull();
    expect(indexOf(record?.inventory ?? [], 'chest.leather')).toBeGreaterThanOrEqual(0);
    expect(client.view().equipment.chest).toBeNull();
  });

  it('grants a starting kit a fresh character can actually equip', async () => {
    const { client } = await harness();
    const held = new Set(
      client
        .view()
        .inventory.filter((stack) => stack !== null)
        .map((stack) => stack.defId),
    );
    const worn = new Set(EQUIP_SLOTS.map((slot) => client.view().equipment[slot]));
    for (const entry of STARTING_KIT) {
      expect(held.has(entry.defId) || worn.has(entry.defId)).toBe(true);
    }
  });
});
