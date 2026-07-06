import { describe, expect, it } from 'vitest';

describe('pipeline sanity', () => {
  it('runs a trivial assertion to prove test → typecheck → lint → CI wiring works', () => {
    expect(1 + 1).toBe(2);
  });
});
