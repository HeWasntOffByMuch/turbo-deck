import { describe, expect, it } from 'vitest';
import { matchPath } from './http.js';

describe('matchPath', () => {
  it('matches a literal path', () => {
    expect(matchPath('/api/studio/jobs', '/api/studio/jobs')).toEqual({});
    expect(matchPath('/api/studio/jobs', '/api/studio/credits')).toBeNull();
  });

  it('captures a named segment', () => {
    expect(matchPath('/api/studio/jobs/:id', '/api/studio/jobs/abc-123')).toEqual({ id: 'abc-123' });
  });

  it('captures more than one segment', () => {
    expect(matchPath('/api/studio/jobs/:id/cancel', '/api/studio/jobs/abc/cancel')).toEqual({ id: 'abc' });
    expect(matchPath('/api/studio/jobs/:id/cancel', '/api/studio/jobs/abc/restart')).toBeNull();
  });

  it('will not match a different number of segments', () => {
    // Otherwise `/jobs/:id` would answer for `/jobs/abc/cancel` and a cancel
    // would silently read as a fetch.
    expect(matchPath('/api/studio/jobs/:id', '/api/studio/jobs/abc/cancel')).toBeNull();
    expect(matchPath('/api/studio/jobs/:id', '/api/studio/jobs')).toBeNull();
  });

  it('will not match an empty segment', () => {
    expect(matchPath('/api/studio/jobs/:id', '/api/studio/jobs/')).toBeNull();
  });

  it('decodes a percent-encoded segment', () => {
    expect(matchPath('/api/studio/jobs/:id', '/api/studio/jobs/a%2Fb')).toEqual({ id: 'a/b' });
  });
});
