/**
 * A shop over the wire (spec 129): a real client, a real server, real frames.
 *
 * Two things are only true end to end. A purchase changes the bag and the purse
 * at the same instant, and the client is told both without asking. And a shop is
 * *closed by the server* -- walking out of range takes the price list away,
 * rather than leaving a client holding one it can still click.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { buyPrice, sellPrice, vendorById, type VendorDefinition } from '../data/vendors.js';
import { STARTING_COINS } from '../player/player-manager.js';
import type { Inventory } from '../state/types.js';

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
const QUARTERMASTER = vendorById('vendor.quartermaster') as VendorDefinition;

interface Harness {
  readonly server: GameServer;
  readonly client: GameClient;
}

async function harness(): Promise<Harness> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const client = new GameClient(transport.connect(), { playerId: 'p1', displayName: 'p1' });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  await settle();
  // Standing at the counter. The spawn is (600, 450) and the quartermaster is
  // twenty-odd units away, so this is where a fresh character already is -- but
  // it is set explicitly rather than relied upon.
  server.playerManager.syncFromEntity('p1', { x: QUARTERMASTER.x, y: QUARTERMASTER.y, z: 0 }, 0, 100);
  return { server, client };
}

function indexOf(inventory: Inventory, defId: string): number {
  return inventory.findIndex((stack) => stack?.defId === defId);
}

describe('a shop over the wire', () => {
  it('lists what it stocks, at the prices the server sets', async () => {
    const { client } = await harness();
    client.openVendor(QUARTERMASTER.id);
    await settle();

    const shop = client.view().vendor;
    expect(shop?.name).toBe('Quartermaster');
    expect(shop?.stock.map((entry) => entry.defId)).toEqual([...QUARTERMASTER.stock]);
    expect(shop?.stock.find((entry) => entry.defId === 'potion.minor')?.price).toBe(
      buyPrice('potion.minor', QUARTERMASTER),
    );
  });

  it('starts a character with a purse and tells them what is in it', async () => {
    const { client } = await harness();
    expect(client.view().coins).toBe(STARTING_COINS);
  });

  it('moves the coins and the goods together', async () => {
    const { server, client } = await harness();
    client.openVendor(QUARTERMASTER.id);
    await settle();

    const price = buyPrice('potion.minor', QUARTERMASTER);
    const before = client.view();
    const heldBefore = before.inventory.filter((stack) => stack?.defId === 'potion.minor').length;
    client.buyItem(QUARTERMASTER.id, 'potion.minor', 2);
    await settle();

    const after = client.view();
    expect(after.coins).toBe(before.coins - price * 2);
    expect(after.inventory.filter((stack) => stack?.defId === 'potion.minor').length).toBeGreaterThanOrEqual(
      heldBefore,
    );
    expect(after.coins).toBe(server.playerManager.get('p1')?.record.coins);
    expect(after.inventory).toEqual(server.playerManager.get('p1')?.record.inventory);
  });

  it('refuses a purchase it cannot pay for, and changes nothing', async () => {
    const { client } = await harness();
    client.openVendor(QUARTERMASTER.id);
    await settle();

    const rejections: string[] = [];
    client.onError((_code, message) => rejections.push(message));
    const before = client.view();
    // Forty salves is far more than a starting purse.
    client.buyItem(QUARTERMASTER.id, 'potion.minor', 40);
    await settle();

    expect(rejections.join(' ')).toMatch(/coins|carry|bag/);
    expect(client.view().coins).toBe(before.coins);
    expect(client.view().inventory).toEqual(before.inventory);
  });

  it('pays for a sale and offers it back at the same price', async () => {
    const { client } = await harness();
    client.openVendor(QUARTERMASTER.id);
    await settle();

    const index = indexOf(client.view().inventory, 'bow.hunting');
    expect(index).toBeGreaterThanOrEqual(0);
    const paid = sellPrice('bow.hunting', QUARTERMASTER);
    const before = client.view().coins;

    client.sellItem(QUARTERMASTER.id, index, 1);
    await settle();
    expect(client.view().coins).toBe(before + paid);
    expect(client.view().vendor?.buyback[0]).toEqual({ defId: 'bow.hunting', count: 1, price: paid });

    // ...and undoing it is free, which is the whole reason the list exists.
    client.buyBack(QUARTERMASTER.id, 0);
    await settle();
    expect(client.view().coins).toBe(before);
    expect(indexOf(client.view().inventory, 'bow.hunting')).toBeGreaterThanOrEqual(0);
    expect(client.view().vendor?.buyback).toEqual([]);
  });

  /**
   * The check that makes a shop a place rather than a menu. It is also the one
   * the pure rules deliberately do not make: where a player is standing is
   * session state.
   */
  it('refuses everything from across the map, and says the shop is shut', async () => {
    const { server, client } = await harness();
    client.openVendor(QUARTERMASTER.id);
    await settle();
    expect(client.view().vendor).not.toBeNull();

    server.playerManager.syncFromEntity('p1', { x: 40, y: 40, z: 0 }, 0, 100);
    const rejections: string[] = [];
    client.onError((_code, message) => rejections.push(message));

    client.buyItem(QUARTERMASTER.id, 'potion.minor', 1);
    await settle();
    expect(rejections.join(' ')).toContain('too far');
    // Closed by the server, not merely refused: a stale price list is a list a
    // player can keep clicking.
    expect(client.view().vendor).toBeNull();

    client.openVendor(QUARTERMASTER.id);
    await settle();
    expect(client.view().vendor).toBeNull();
  });

  it('closes when the client asks it to', async () => {
    const { client } = await harness();
    client.openVendor(QUARTERMASTER.id);
    await settle();
    expect(client.view().vendor).not.toBeNull();

    client.openVendor('');
    await settle();
    expect(client.view().vendor).toBeNull();
  });

  it('refuses a vendor that does not exist rather than answering with one', async () => {
    const { client } = await harness();
    client.openVendor('vendor.imaginary');
    await settle();
    expect(client.view().vendor).toBeNull();
  });
});
