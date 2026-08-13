import { describe, expect, it } from 'vitest';
import { LiveConfigStore } from '../config.js';
import type { AdminItemRow, AdminPlayerRow } from '../net/admin-messages.js';
import { AdminMessageType, AdminProgressMode, AdminReplyType } from '../net/protocol.js';
import { MemoryDataStore } from '../state/memory-store.js';
import { AuditLog } from './audit.js';
import {
  createHmacAdminVerifier,
  DEFAULT_TOKEN_TTL_SECONDS,
  signToken,
  verifyAdminToken,
  verifyToken,
} from './auth.js';
import {
  AdminRouter,
  createAdminConnectionState,
  DENY_ALL_ADMIN,
  type AdminHost,
  type AdminConnectionState,
  type AdminOutcome,
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
      experience: 0,
      experienceToNextLevel: 50,
      unspentSkillPoints: 1,
      unspentAttributePoints: 5,
    }));
  }

  listItems(): readonly AdminItemRow[] {
    this.calls.push('listItems');
    return [{ id: 'potion.minor', name: 'Minor Potion', slot: '-', levelRequirement: 1, maxStack: 10 }];
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

  // --- spec 154 -------------------------------------------------------------

  setProgress(playerId: string, mode: number, amount: number): Promise<AdminOutcome> {
    this.calls.push(`setProgress:${playerId}:${mode}:${amount}`);
    return Promise.resolve(
      this.connectedPlayers.has(playerId)
        ? { ok: true, detail: `mode ${mode} by ${amount}` }
        : { ok: false, detail: 'not logged in' },
    );
  }

  giveItem(playerId: string, defId: string, count: number): Promise<AdminOutcome> {
    this.calls.push(`giveItem:${playerId}:${defId}:${count}`);
    return Promise.resolve(
      defId === 'potion.minor'
        ? { ok: true, detail: `gave ${playerId} ${count} x ${defId}` }
        : { ok: false, detail: `no such item: ${defId}` },
    );
  }

  kill(playerId: string): AdminOutcome {
    this.calls.push(`kill:${playerId}`);
    return this.connectedPlayers.has(playerId)
      ? { ok: true, detail: `killed ${playerId}` }
      : { ok: false, detail: `${playerId} is not in the world` };
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
  const router = new AdminRouter(host, audit, createHmacAdminVerifier(SECRET), () => state.now);
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

  it('refuses everything, auth included, when no verifier is configured', async () => {
    // What an in-tab single-player server gets (spec 057): no admin channel at
    // all, rather than one guarded by a secret that would have to live in the
    // browser bundle.
    const store = new MemoryDataStore();
    const audit = new AuditLog(store, () => T0);
    const router = new AdminRouter(new FakeHost(), audit, DENY_ALL_ADMIN, () => T0);
    const connection = createAdminConnectionState();

    const authed = await router.handle(connection, {
      type: AdminMessageType.Auth,
      token: adminToken(),
    });
    expect(authed.type).toBe(AdminReplyType.Error);
    expect(connection.token).toBeNull();

    const listed = await router.handle(connection, { type: AdminMessageType.ListPlayers });
    expect(listed.type).toBe(AdminReplyType.Error);
    // Refusals are still on the record.
    expect((await audit.recent(10)).length).toBeGreaterThan(0);
  });

  it('names the actor from the token, not from anything the client said', async () => {
    const test = harness();
    await test.router.handle(test.connection, {
      type: AdminMessageType.Auth,
      token: signToken({ sub: 'alice-the-gm', role: 'admin' }, SECRET, T0),
    });
    await test.router.handle(test.connection, {
      type: AdminMessageType.Kick,
      playerId: 'bob',
      reason: 'afk',
    });
    const log = await test.audit.recent(1);
    expect(log[0]?.actor).toBe('alice-the-gm');
  });

  it('does not audit a read (spec 154)', async () => {
    // A live player count polls the list once a second. The log holds decisions,
    // and one entry per poll would bury every one of them.
    const test = harness();
    await test.router.handle(test.connection, { type: AdminMessageType.Auth, token: adminToken() });
    const before = (await test.audit.recent(50)).length;

    for (let i = 0; i < 5; i++) {
      await test.router.handle(test.connection, { type: AdminMessageType.ListPlayers });
      await test.router.handle(test.connection, { type: AdminMessageType.GetItems });
      await test.router.handle(test.connection, { type: AdminMessageType.GetConfig });
    }

    expect((await test.audit.recent(50)).length).toBe(before);
    // Still authenticated, and a decision still lands.
    await test.router.handle(test.connection, {
      type: AdminMessageType.Kick,
      playerId: 'bob',
      reason: 'afk',
    });
    expect((await test.audit.recent(50)).length).toBe(before + 1);
  });
});

describe('character edits (spec 154)', () => {
  async function authed(): Promise<Harness> {
    const test = harness();
    await test.router.handle(test.connection, { type: AdminMessageType.Auth, token: adminToken() });
    return test;
  }

  const modes = [
    ['give levels', AdminProgressMode.AddLevels, 5],
    ['reset levels', AdminProgressMode.SetLevel, 1],
    ['give experience', AdminProgressMode.AddExperience, 1200],
    ['reset experience', AdminProgressMode.SetExperience, 0],
  ] as const;

  it.each(modes)('%s reaches the host with its own mode and amount', async (_label, mode, amount) => {
    const test = await authed();
    const reply = await test.router.handle(test.connection, {
      type: AdminMessageType.SetProgress,
      playerId: 'bob',
      mode,
      amount,
    });
    expect(reply.type).toBe(AdminReplyType.Ok);
    expect(test.host.calls).toContain(`setProgress:bob:${mode}:${amount}`);
  });

  it('names the mode in the audit entry rather than its byte', async () => {
    const test = await authed();
    await test.router.handle(test.connection, {
      type: AdminMessageType.SetProgress,
      playerId: 'bob',
      mode: AdminProgressMode.SetLevel,
      amount: 1,
    });
    const log = await test.audit.recent(1);
    expect(log[0]).toMatchObject({ actor: 'root', action: 'admin:setProgress', target: 'bob' });
    expect(log[0]?.detail).toContain('setLevel 1');
  });

  it('carries a refusal reason back rather than flattening it', async () => {
    const test = await authed();
    const reply = await test.router.handle(test.connection, {
      type: AdminMessageType.GiveItem,
      playerId: 'bob',
      defId: 'sord.worn',
      count: 1,
    });
    expect(reply.type).toBe(AdminReplyType.Error);
    if (reply.type === AdminReplyType.Error) expect(reply.message).toContain('sord.worn');
    expect((await test.audit.recent(1))[0]).toMatchObject({
      action: 'admin:giveItem',
      accepted: false,
    });
  });

  it('gives an item and audits what was given', async () => {
    const test = await authed();
    const reply = await test.router.handle(test.connection, {
      type: AdminMessageType.GiveItem,
      playerId: 'bob',
      defId: 'potion.minor',
      count: 3,
    });
    expect(reply.type).toBe(AdminReplyType.Ok);
    expect(test.host.calls).toContain('giveItem:bob:potion.minor:3');
    expect((await test.audit.recent(1))[0]?.detail).toBe('3 x potion.minor');
  });

  it('kills a connected player and refuses one who is not there', async () => {
    const test = await authed();
    const killed = await test.router.handle(test.connection, {
      type: AdminMessageType.Kill,
      playerId: 'bob',
    });
    expect(killed.type).toBe(AdminReplyType.Ok);

    const missing = await test.router.handle(test.connection, {
      type: AdminMessageType.Kill,
      playerId: 'nobody',
    });
    expect(missing.type).toBe(AdminReplyType.Error);
  });

  it('answers the item catalog so the console need not know any ids', async () => {
    const test = await authed();
    const reply = await test.router.handle(test.connection, { type: AdminMessageType.GetItems });
    expect(reply.type).toBe(AdminReplyType.ItemList);
    if (reply.type === AdminReplyType.ItemList) {
      expect(reply.items[0]?.id).toBe('potion.minor');
    }
  });

  it('does none of it unauthenticated', async () => {
    const test = harness();
    const requests = [
      { type: AdminMessageType.SetProgress, playerId: 'bob', mode: AdminProgressMode.AddLevels, amount: 9 },
      { type: AdminMessageType.GiveItem, playerId: 'bob', defId: 'potion.minor', count: 1 },
      { type: AdminMessageType.GetItems },
      { type: AdminMessageType.Kill, playerId: 'bob' },
    ] as const;

    for (const request of requests) {
      const reply = await test.router.handle(test.connection, request);
      expect(reply.type).toBe(AdminReplyType.Error);
    }
    expect(test.host.calls).toEqual([]);
  });
});
