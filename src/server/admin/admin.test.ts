import { describe, expect, it } from 'vitest';
import { LiveConfigStore } from '../config.js';
import type { AdminPlayerRow } from '../net/admin-messages.js';
import { AdminMessageType, AdminReplyType } from '../net/protocol.js';
import { MemoryDataStore } from '../state/memory-store.js';
import { AuditLog } from './audit.js';
import { DEFAULT_TOKEN_TTL_SECONDS, signToken, verifyAdminToken, verifyToken } from './auth.js';
import {
  AdminRouter,
  createAdminConnectionState,
  type AdminHost,
  type AdminConnectionState,
} from './router.js';

const SECRET = 'test-secret-not-a-real-key';
const T0 = 1_700_000_000_000;

class FakeHost implements AdminHost {
  readonly calls: string[] = [];
  readonly config = new LiveConfigStore();
  connectedPlayers = new Set(['bob']);
  entities = new Set([41]);

  listPlayers(): readonly AdminPlayerRow[] {
    this.calls.push('listPlayers');
    return [...this.connectedPlayers].map((playerId) => ({
      playerId,
      displayName: playerId,
      entityId: 1,
      x: 0,
      y: 0,
      z: 0,
      zone: 'Greenmarch',
      chunk: '0,0',
      health: 100,
      maxHealth: 100,
      level: 1,
      attackDamage: 10,
      moveSpeed: 147.5,
      muted: false,
    }));
  }

  kick(playerId: string): boolean {
    this.calls.push(`kick:${playerId}`);
    return this.connectedPlayers.delete(playerId);
  }

  ban(playerId: string): Promise<boolean> {
    this.calls.push(`ban:${playerId}`);
    return Promise.resolve(true);
  }

  mute(playerId: string): Promise<boolean> {
    this.calls.push(`mute:${playerId}`);
    return Promise.resolve(true);
  }

  teleport(playerId: string): boolean {
    this.calls.push(`teleport:${playerId}`);
    return this.connectedPlayers.has(playerId);
  }

  spawnEntities(entityType: string, _x: number, _y: number, count: number): number {
    this.calls.push(`spawn:${entityType}`);
    return entityType === 'ravager' ? count : 0;
  }

  despawnEntity(entityId: number): boolean {
    this.calls.push(`despawn:${entityId}`);
    return this.entities.delete(entityId);
  }

  triggerEvent(eventName: string): string {
    this.calls.push(`event:${eventName}`);
    return eventName === 'raid' ? 'raid spawned' : '';
  }

  broadcast(text: string): number {
    this.calls.push(`broadcast:${text}`);
    return 3;
  }

  setConfig(key: string, value: number): number | null {
    this.calls.push(`setConfig:${key}`);
    return this.config.set(key, value);
  }

  getConfig(): readonly (readonly [string, number])[] {
    return [['spawnRateMultiplier', this.config.get().spawnRateMultiplier] as const];
  }
}

interface Harness {
  readonly router: AdminRouter;
  readonly host: FakeHost;
  readonly audit: AuditLog;
  readonly store: MemoryDataStore;
  readonly connection: AdminConnectionState;
  now: number;
}

function harness(): Harness {
  const store = new MemoryDataStore();
  const state = { now: T0 };
  const audit = new AuditLog(store, () => state.now);
  const host = new FakeHost();
  const router = new AdminRouter(host, audit, SECRET, () => state.now);
  return {
    router,
    host,
    audit,
    store,
    connection: createAdminConnectionState(),
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
  };
}

function adminToken(nowMs = T0): string {
  return signToken({ sub: 'root', role: 'admin' }, SECRET, nowMs);
}

describe('token verification', () => {
  it('accepts a token it signed itself', () => {
    const result = verifyAdminToken(adminToken(), SECRET, T0);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.claims.sub).toBe('root');
  });

  it('refuses a token signed with a different secret', () => {
    const forged = signToken({ sub: 'root', role: 'admin' }, 'other-secret', T0);
    expect(verifyAdminToken(forged, SECRET, T0)).toMatchObject({ ok: false, reason: 'bad signature' });
  });

  it('refuses a tampered payload, even with the claims rewritten to admin', () => {
    const token = signToken({ sub: 'nobody', role: 'player' }, SECRET, T0);
    const [header, , signature] = token.split('.') as [string, string, string];
    const forgedBody = Buffer.from(
      JSON.stringify({ sub: 'nobody', role: 'admin', iat: T0 / 1000, exp: T0 / 1000 + 999 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyAdminToken(`${header}.${forgedBody}.${signature}`, SECRET, T0)).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
  });

  it('refuses a valid token that is not an admin', () => {
    const player = signToken({ sub: 'bob', role: 'player' }, SECRET, T0);
    expect(verifyToken(player, SECRET, T0)).toMatchObject({ ok: true });
    expect(verifyAdminToken(player, SECRET, T0)).toMatchObject({ ok: false });
  });

  it('refuses an expired token', () => {
    const token = adminToken();
    const afterExpiry = T0 + (DEFAULT_TOKEN_TTL_SECONDS + 1) * 1000;
    expect(verifyAdminToken(token, SECRET, afterExpiry)).toMatchObject({
      ok: false,
      reason: 'token expired',
    });
  });

  it('refuses garbage rather than throwing', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '...']) {
      expect(verifyAdminToken(bad, SECRET, T0).ok).toBe(false);
    }
  });
});

describe('admin routing', () => {
  it('refuses every action until the connection has authenticated', async () => {
    const test = harness();
    const reply = await test.router.handle(test.connection, {
      type: AdminMessageType.Kick,
      playerId: 'bob',
      reason: 'because',
    });
    expect(reply.type).toBe(AdminReplyType.Error);
    expect(test.host.calls).toEqual([]);
    expect(test.host.connectedPlayers.has('bob')).toBe(true);

    // And the attempt is on the record.
    const log = await test.audit.recent(10);
    expect(log[0]).toMatchObject({ action: 'admin:kick', accepted: false });
  });

  it('refuses a non-admin token at the auth step', async () => {
    const test = harness();
    const reply = await test.router.handle(test.connection, {
      type: AdminMessageType.Auth,
      token: signToken({ sub: 'bob', role: 'player' }, SECRET, T0),
    });
    expect(reply.type).toBe(AdminReplyType.Error);
    expect(test.connection.token).toBeNull();
  });

  it('accepts an admin token and then performs actions', async () => {
    const test = harness();
    const authed = await test.router.handle(test.connection, {
      type: AdminMessageType.Auth,
      token: adminToken(),
    });
    expect(authed.type).toBe(AdminReplyType.Ok);

    const kicked = await test.router.handle(test.connection, {
      type: AdminMessageType.Kick,
      playerId: 'bob',
      reason: 'afk',
    });
    expect(kicked.type).toBe(AdminReplyType.Ok);
    expect(test.host.calls).toContain('kick:bob');
  });

  it('re-checks the token on every message, so expiry bites mid-session', async () => {
    const test = harness();
    await test.router.handle(test.connection, { type: AdminMessageType.Auth, token: adminToken() });
    expect(
      (await test.router.handle(test.connection, { type: AdminMessageType.ListPlayers })).type,
    ).toBe(AdminReplyType.PlayerList);

    // Same connection, same stored token -- the clock has simply moved on.
    test.now = T0 + (DEFAULT_TOKEN_TTL_SECONDS + 1) * 1000;
    const reply = await test.router.handle(test.connection, { type: AdminMessageType.ListPlayers });
    expect(reply.type).toBe(AdminReplyType.Error);
    expect(test.connection.token).toBeNull();
  });

  it('reports a failure honestly instead of claiming success', async () => {
    const test = harness();
    await test.router.handle(test.connection, { type: AdminMessageType.Auth, token: adminToken() });

    const reply = await test.router.handle(test.connection, {
      type: AdminMessageType.Kick,
      playerId: 'nobody',
      reason: 'x',
    });
    expect(reply.type).toBe(AdminReplyType.Error);

    const log = await test.audit.recent(1);
    expect(log[0]).toMatchObject({ action: 'admin:kick', target: 'nobody', accepted: false });
  });

  it('clamps a live config value rather than putting nonsense into the sim', async () => {
    const test = harness();
    await test.router.handle(test.connection, { type: AdminMessageType.Auth, token: adminToken() });

    await test.router.handle(test.connection, {
      type: AdminMessageType.SetConfig,
      key: 'spawnRateMultiplier',
      value: -5,
    });
    expect(test.host.config.get().spawnRateMultiplier).toBe(0);

    const rejected = await test.router.handle(test.connection, {
      type: AdminMessageType.SetConfig,
      key: 'notAKey',
      value: 1,
    });
    expect(rejected.type).toBe(AdminReplyType.Error);

    const nan = await test.router.handle(test.connection, {
      type: AdminMessageType.SetConfig,
      key: 'spawnRateMultiplier',
      value: Number.NaN,
    });
    expect(nan.type).toBe(AdminReplyType.Error);
  });

  it('refuses an unknown world event', async () => {
    const test = harness();
    await test.router.handle(test.connection, { type: AdminMessageType.Auth, token: adminToken() });
    const reply = await test.router.handle(test.connection, {
      type: AdminMessageType.TriggerEvent,
      eventName: 'apocalypse',
      x: 0,
      y: 0,
      magnitude: 1,
    });
    expect(reply.type).toBe(AdminReplyType.Error);
  });

  it('records who did what and when, for every accepted action', async () => {
    const test = harness();
    await test.router.handle(test.connection, { type: AdminMessageType.Auth, token: adminToken() });
    await test.router.handle(test.connection, {
      type: AdminMessageType.Ban,
      playerId: 'bob',
      seconds: 600,
      reason: 'cheating',
    });
    await test.router.handle(test.connection, {
      type: AdminMessageType.Broadcast,
      text: 'server restarting',
    });

    const log = await test.audit.recent(10);
    // Most recent first.
    expect(log[0]).toMatchObject({ actor: 'root', action: 'admin:broadcast', accepted: true });
    expect(log[1]).toMatchObject({
      actor: 'root',
      action: 'admin:ban',
      target: 'bob',
      detail: '600s: cheating',
      accepted: true,
    });
    expect(log[2]).toMatchObject({ action: 'admin:auth', accepted: true });
    for (const entry of log) expect(entry.at).toBe(T0);
  });

  it('names the actor from the token, not from anything the client said', async () => {
    const test = harness();
    await test.router.handle(test.connection, {
      type: AdminMessageType.Auth,
      token: signToken({ sub: 'alice-the-gm', role: 'admin' }, SECRET, T0),
    });
    await test.router.handle(test.connection, { type: AdminMessageType.ListPlayers });
    const log = await test.audit.recent(1);
    expect(log[0]?.actor).toBe('alice-the-gm');
  });
});
