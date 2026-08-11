/**
 * What a character has taken, over the wire (spec 128).
 *
 * One assertion carries this file: a client that spends a point is told what it
 * now holds, without asking. Before this, `Stats` said how many points were
 * *left* and never what they had been spent on -- so a skill tree could not be
 * drawn at all, the same way a paperdoll could not be drawn from a stat block.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function connect(): Promise<{ server: GameServer; client: GameClient }> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const client = new GameClient(transport.connect(), { playerId: 'p1', displayName: 'p1' });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  await settle();
  return { server, client };
}

describe('skill allocations over the wire', () => {
  it('starts empty, with a point to spend', async () => {
    const { client } = await connect();
    expect(client.view().skills).toEqual([]);
    expect(client.view().unspentSkillPoints).toBe(1);
  });

  it('tells a client what it now holds when it spends a point', async () => {
    const { server, client } = await connect();
    client.spendSkillPoint('might.toughness');
    await settle();

    expect(client.view().skills).toEqual([{ skillId: 'might.toughness', level: 1 }]);
    expect(client.view().unspentSkillPoints).toBe(0);
    // ...and it is the server's list, not a guess assembled from the requests.
    expect(client.view().skills).toEqual(server.playerManager.get('p1')?.record.skills);
  });

  it('says nothing new when the server refuses the spend', async () => {
    const { client } = await connect();
    const rejections: string[] = [];
    client.onError((_code, message) => rejections.push(message));
    // Nothing left to spend after the first point.
    client.spendSkillPoint('might.toughness');
    await settle();
    client.spendSkillPoint('might.toughness');
    await settle();

    expect(rejections).toHaveLength(1);
    expect(client.view().skills).toEqual([{ skillId: 'might.toughness', level: 1 }]);
  });

  it('carries a level past one, rather than repeating the id', async () => {
    const { server, client } = await connect();
    // Levelling is where the points come from, so this is also the path a real
    // character takes to a second point.
    await server.playerManager.grantExperience('p1', 5000);
    client.spendSkillPoint('might.toughness');
    await settle();
    client.spendSkillPoint('might.toughness');
    await settle();

    expect(client.view().skills).toEqual([{ skillId: 'might.toughness', level: 2 }]);
  });
});
