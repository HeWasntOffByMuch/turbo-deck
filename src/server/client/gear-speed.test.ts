/**
 * Gear that changes how fast you walk, over the wire.
 *
 * The predicted step closes over the derived move speed, and the derived move
 * speed is not a constant of a session: `legs.traveller` is +6 and
 * `trinket.swiftband` is +8%, so putting a piece on or taking it off moves it
 * mid-session. Built once at the first delta and kept, the local body walks at
 * whatever the player happened to be wearing when prediction started -- so a
 * player who logs in wearing the greaves and takes them off keeps running at
 * the greaves' speed, visibly, since the local body is drawn from the
 * prediction and not from the wire. What the server does about that is a
 * correction on every tick of every step from then on, which is the one thing
 * spec 067's drift nudges are not for.
 *
 * Which is why half of this is played through a *second* login: the direction
 * that was reported is the one where prediction starts with the gear already on,
 * and a client that equips it mid-session has a predictor built before it.
 *
 * The world here is open ground and flat, so the flat predictor the client
 * defaults to agrees with `resolveMovement` exactly. That is what lets the last
 * test assert *no* corrections at all: with the speed right there is nothing
 * left to disagree about, and any correction it sees is the bug.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../sim/collision.js';
import { SERVER_TICK_RATE } from '../config.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { equipmentAddress } from '../player/inventory.js';
import { GameServer } from '../server.js';
import { type Inventory } from '../state/types.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The item under test: +6 move speed, and in the starting kit. */
const GREAVES = 'legs.traveller';
const PLAYER = 'p1';

class Harness {
  private constructor(
    readonly server: GameServer,
    private readonly transport: LoopbackTransport,
    public client: GameClient,
  ) {}

  static async open(): Promise<Harness> {
    const transport = new LoopbackTransport();
    const server = new GameServer({
      seed: 5,
      transport,
      world: createWorldColliders([], []),
      terrain: FLAT_TERRAIN,
    });
    server.liveConfig.set('spawnRateMultiplier', 0);
    transport.onConnection((channel) => server.accept(channel));
    const harness = new Harness(server, transport, null as unknown as GameClient);
    harness.client = await harness.login();
    return harness;
  }

  /**
   * Logs in again on a fresh connection, which is what a page reload is: the
   * record and its equipment are the server's, and the new client's predictor
   * is built from the stats that record derives.
   */
  async logInAgain(): Promise<void> {
    this.client = await this.login();
  }

  private async login(): Promise<GameClient> {
    const client = new GameClient(this.transport.connect(), {
      playerId: PLAYER,
      displayName: PLAYER,
    });
    const welcomed = client.connect();
    await settle();
    await welcomed;
    await settle();
    // Enough ticks for the first delta to place the body, which is what starts
    // prediction: there is no local step to measure before it.
    await this.ticks(10, client);
    return client;
  }

  async ticks(count: number, client = this.client): Promise<void> {
    for (let i = 0; i < count; i++) {
      this.server.tick();
      await settle();
      client.advanceTick();
    }
  }

  /** How far one tick of held east actually moves the predicted body. */
  predictedStep(): number {
    const before = this.client.view().self;
    const after = this.client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
    if (!before || !after) throw new Error('not predicting yet');
    return Math.hypot(after.x - before.x, after.y - before.y);
  }

  /** What the sheet says one tick should be. */
  statedStep(): number {
    const stats = this.client.view().stats;
    if (!stats) throw new Error('no stats yet');
    return stats.moveSpeed / SERVER_TICK_RATE;
  }

  async wear(): Promise<void> {
    const at = indexOf(this.client.view().inventory, GREAVES);
    expect(at).toBeGreaterThanOrEqual(0);
    this.client.moveItem({ container: 'inventory', index: at }, equipmentAddress('legs'));
    await settle();
    await this.ticks(4);
  }

  async takeOff(): Promise<void> {
    const free = this.client.view().inventory.findIndex((stack) => stack === null);
    expect(free).toBeGreaterThanOrEqual(0);
    this.client.moveItem(equipmentAddress('legs'), { container: 'inventory', index: free });
    await settle();
    await this.ticks(4);
  }
}

function indexOf(inventory: Inventory, defId: string): number {
  return inventory.findIndex((stack) => stack?.defId === defId);
}

describe('gear that changes move speed', () => {
  it('predicts at the base speed with nothing on', async () => {
    const it = await Harness.open();
    expect(it.predictedStep()).toBeCloseTo(it.statedStep(), 6);
  });

  it('predicts faster the moment the greaves go on', async () => {
    const it = await Harness.open();
    const bare = it.statedStep();
    await it.wear();
    expect(it.statedStep()).toBeGreaterThan(bare);
    expect(it.predictedStep()).toBeCloseTo(it.statedStep(), 6);
  });

  /**
   * The reported bug: log in wearing them, take them off, and the local body
   * used to keep the speed they granted for the rest of the session.
   */
  it('predicts at the base speed again the moment they come off', async () => {
    const it = await Harness.open();
    const bare = it.statedStep();
    await it.wear();
    await it.logInAgain();
    expect(it.statedStep()).toBeGreaterThan(bare);
    expect(it.predictedStep()).toBeCloseTo(it.statedStep(), 6);

    await it.takeOff();
    expect(it.statedStep()).toBeCloseTo(bare, 6);
    expect(it.predictedStep()).toBeCloseTo(bare, 6);
  });

  /** What a player actually sees when the two speeds disagree. */
  it('walks without being corrected after they come off', async () => {
    const it = await Harness.open();
    await it.wear();
    await it.logInAgain();
    await it.takeOff();
    const before = it.client.correctionCount;
    for (let tick = 0; tick < 60; tick++) {
      it.client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      await it.ticks(1);
    }
    expect(it.client.correctionCount).toBe(before);
  });
});
