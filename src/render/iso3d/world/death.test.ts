import { describe, expect, it } from 'vitest';
import type { ClientView } from '../../../server/client/game-client.js';
import { DEATH_TEXT, deathOverlay } from './death.js';

function viewFixture(overrides: Partial<ClientView> = {}): ClientView {
  return {
    selfEntityId: 7,
    entities: [{ id: 7, health: 80, maxHealth: 100 }],
    ...overrides,
  } as unknown as ClientView;
}

describe('the death overlay', () => {
  it('says nothing over a living body', () => {
    expect(deathOverlay(viewFixture())).toBeNull();
  });

  it('says so at zero health', () => {
    const view = viewFixture({
      entities: [{ id: 7, health: 0, maxHealth: 100 }],
    } as unknown as Partial<ClientView>);
    expect(deathOverlay(view)?.text).toBe(DEATH_TEXT);
  });

  it('says nothing before the client knows which body is its own', () => {
    // A welcome that has not landed. An overlay here would put "YOU ARE DEAD"
    // across the loading frames of every session.
    expect(deathOverlay(viewFixture({ selfEntityId: -1 }))).toBeNull();
  });

  it('says nothing when our own body is not in the replicated set', () => {
    // What a reconnect looks like for a frame or two: the id is known and the
    // entity has not arrived. Silence is the only honest answer -- guessing
    // "dead" is how a live player gets a respawn button.
    expect(deathOverlay(viewFixture({ entities: [] }))).toBeNull();
  });
});
