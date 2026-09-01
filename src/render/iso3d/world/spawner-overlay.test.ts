import { describe, expect, it } from 'vitest';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import type { SpawnerStatus } from '../../../server/net/messages.js';
import { SpawnerStateValue } from '../../../server/net/protocol.js';
import { spawnerLabels } from './spawner-overlay.js';

const status = (overrides: Partial<SpawnerStatus> = {}): SpawnerStatus => ({
  id: 'spawner-1',
  monsterId: 'grazer',
  x: 100,
  y: 200,
  state: SpawnerStateValue.Occupied,
  ticks: 0,
  ...overrides,
});

describe('the spawner overlay', () => {
  it('names what stands there while it is alive, with no timer', () => {
    const [label] = spawnerLabels([status()], SERVER_TICK_RATE);
    expect(label?.text).toBe('grazer');
    expect(label?.waiting).toBe(false);
  });

  it('counts down in seconds while it is empty', () => {
    const [label] = spawnerLabels(
      [status({ state: SpawnerStateValue.Waiting, ticks: SERVER_TICK_RATE * 3 })],
      SERVER_TICK_RATE,
    );
    expect(label?.text).toBe('grazer · 3.0s');
    expect(label?.waiting).toBe(true);
  });

  it('rounds up, so it never reads zero while the ground is still empty', () => {
    const [label] = spawnerLabels(
      [status({ state: SpawnerStateValue.Waiting, ticks: 1 })],
      SERVER_TICK_RATE,
    );
    expect(label?.text).toBe('grazer · 0.1s');
  });

  it('says "due" rather than counting when the timer has run out', () => {
    const [label] = spawnerLabels(
      [status({ state: SpawnerStateValue.Waiting, ticks: 0 })],
      SERVER_TICK_RATE,
    );
    expect(label?.text).toBe('grazer · due');
  });

  /**
   * Spec 268. `due` is the one thing a held spawner must not say: it means "any
   * tick now" and the answer for a point whose window is shut is "not today".
   * The two are the same `ticks: 0` on the wire, which is why the state is its
   * own value rather than something inferred from the number.
   */
  it('says "holding" for a spawner whose window is shut', () => {
    const [label] = spawnerLabels(
      [status({ state: SpawnerStateValue.Holding, ticks: 0 })],
      SERVER_TICK_RATE,
    );
    expect(label?.text).toBe('grazer · holding');
    expect(label?.waiting).toBe(true);
  });

  it('holds regardless of any timer that came with it', () => {
    const [label] = spawnerLabels(
      [status({ state: SpawnerStateValue.Holding, ticks: SERVER_TICK_RATE * 3 })],
      SERVER_TICK_RATE,
    );
    expect(label?.text).toBe('grazer · holding');
  });

  it('carries the world position through, and keeps the server order', () => {
    const labels = spawnerLabels(
      [status({ id: 'spawner-2', x: 10, y: 20 }), status({ id: 'spawner-1', x: 30, y: 40 })],
      SERVER_TICK_RATE,
    );
    expect(labels.map((l) => l.id)).toEqual(['spawner-2', 'spawner-1']);
    expect(labels[0]).toMatchObject({ x: 10, y: 20 });
  });

  it('survives a nonsense tick rate rather than dividing by zero', () => {
    const [label] = spawnerLabels([status({ state: SpawnerStateValue.Waiting, ticks: 5 })], 0);
    expect(label?.text).toBe('grazer · 5.0s');
  });
});
