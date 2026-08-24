import { describe, expect, it } from 'vitest';
import { GameClient } from '../client/game-client.js';
import { LiveConfigStore } from '../config.js';
import { ALL_DOTS, dotDurationTicks, type DotDefinition } from '../data/damage-over-time.js';
import type { AdminItemRow, AdminPlayerRow } from '../net/admin-messages.js';
import { AdminMessageType, AdminProgressMode, AdminReplyType } from '../net/protocol.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { StatusId, statusOf, type StatusState } from '../sim/statuses.js';
import { EntityKindValue, type ServerEntity } from '../sim/types.js';
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

/**
 * `admin:triggerEvent 'affliction'` (spec 215).
 *
 * Everything above this point is the **router**, driven against a `FakeHost`:
 * the claim being made there is that a frame reaches a method carrying its
 * arguments, that a refusal comes back as a refusal, and that a decision leaves
 * an audit entry behind. None of that needs a world.
 *
 * This block is the other half of the same feature and does. What
 * `'affliction'` is *for* is the state it leaves on the bodies in front of the
 * operator -- one named affliction, at full severity, for its own authored
 * length -- and a host that answers a string has no bodies to leave it on. So
 * the server here is the real one and the bodies are real too: the player is
 * logged in over the real loopback, because the operator's own character is the
 * most likely thing this is ever pointed at and the kind filter has two arms,
 * and the monsters arrive through `spawnEntities`, which is what an admin
 * conjuring a fight already does.
 */
describe("admin:triggerEvent 'affliction' (spec 215)", () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Comfortably inside any reach worth having. */
  const NEAR = 40;
  /**
   * Far enough to bracket the reach without reading it.
   *
   * `AFFLICTION_DEMO_REACH` is private on purpose, and a test that imported it
   * would be asserting that a number equals itself. The claim worth making is
   * the weaker, more useful one: a body eight hundred units away is across the
   * field, and this trigger does not reach across the field.
   */
  const FAR = 800;

  interface Fight {
    readonly server: GameServer;
    /** Where the operator is standing, which is where the trigger is aimed. */
    readonly at: { readonly x: number; readonly y: number };
    readonly player: number;
    readonly near: number;
    readonly far: number;
  }

  function entityOf(server: GameServer, id: number): ServerEntity {
    const entity = server.world.entities.get(id);
    if (!entity) throw new Error(`no entity ${id}`);
    return entity;
  }

  /** The body standing at an x, which is how a spawn is found without ids. */
  function idAtX(server: GameServer, x: number): number {
    for (const entity of server.world.entities.values()) {
      if (Math.abs(entity.position.x - x) < 0.001) return entity.id;
    }
    throw new Error(`no body at x ${x}`);
  }

  function heldOn(server: GameServer, id: number, dotId: string): StatusState | null {
    return statusOf(entityOf(server, id).statuses, dotId, server.world.tick);
  }

  function rowAt(index: number): DotDefinition {
    const row = ALL_DOTS[index];
    if (!row) throw new Error(`no affliction at ordinal ${index}`);
    return row;
  }

  /** The ordinal an operator would type for a named affliction. */
  function ordinalOf(dotId: string): number {
    const index = ALL_DOTS.findIndex((row) => row.id === dotId);
    if (index < 0) throw new Error(`${dotId} is not an affliction`);
    return index;
  }

  async function fight(): Promise<Fight> {
    const transport = new LoopbackTransport();
    const server = new GameServer({ seed: 7, transport });
    // No ambient spawning: this wants the bodies it put there and no others, so
    // that the count in the reply is a number the test can name outright.
    server.liveConfig.set('spawnRateMultiplier', 0);
    transport.onConnection((channel) => server.accept(channel));
    const client = new GameClient(transport.connect(), { playerId: 'root', displayName: 'root' });
    const welcome = client.connect();
    await settle();
    await welcome;
    await settle();
    server.tick();
    await settle();

    const player = [...server.world.entities.values()].find(
      (entity) => entity.kind === EntityKindValue.Player,
    );
    if (!player) throw new Error('the player never reached the world');
    const at = { x: player.position.x, y: player.position.y };
    server.spawnEntities('grazer', at.x + NEAR, at.y, 1);
    server.spawnEntities('grazer', at.x + FAR, at.y, 1);
    return {
      server,
      at,
      player: player.id,
      near: idAtX(server, at.x + NEAR),
      far: idAtX(server, at.x + FAR),
    };
  }

  it('marks the bodies in front of you and not the one across the field', async () => {
    const test = await fight();
    const row = rowAt(ordinalOf(StatusId.Corrosion));

    const said = test.server.triggerEvent(
      'affliction',
      test.at.x,
      test.at.y,
      ordinalOf(StatusId.Corrosion),
    );
    // The reply names the affliction, the severity and the length, because
    // `magnitude` is an ordinal and nobody typing one into a console box has the
    // table in front of them. Matched by shape rather than by its exact seconds:
    // the tuning belongs to `data/damage-over-time.ts` and a retune there should
    // not fail a test about the admin channel.
    expect(said).toMatch(/^marked 2 bodies with Corrosion x3 for \d+\.\d+s$/);

    // The player and the monster beside them, which is both arms of the kind
    // filter. The expiry is the row's own, which is the substantive claim: this
    // is the real affliction on its real clock, not a demo window with a mark
    // over it.
    for (const id of [test.player, test.near]) {
      const held = heldOn(test.server, id, StatusId.Corrosion);
      expect(held?.stacks).toBe(row.maxStacks);
      expect(held?.expiresAtTick).toBe(test.server.world.tick + dotDurationTicks(row));
      // A neutral caster's spell power, and nobody responsible for it: a kill by
      // a conjured poison pays no restoration, no assist and no loot roll.
      expect(held?.magnitude).toBe(1);
      expect(held?.sourceId).toBe(0);
    }
    expect(heldOn(test.server, test.far, StatusId.Corrosion)).toBeNull();
    expect(Object.keys(entityOf(test.server, test.far).statuses)).toEqual([]);
  });

  it.each(ALL_DOTS.map((row) => [row.name, row.id] as const))(
    '%s lands alone, at its own full stack count and its own length',
    async (_name, dotId) => {
      const test = await fight();
      const row = rowAt(ordinalOf(dotId));

      test.server.triggerEvent('affliction', test.at.x, test.at.y, ordinalOf(dotId));

      // Full severity rather than one stack, because severity is precisely what
      // spec 215's paint draws differently and one stack of Poison is the tier
      // a single dart already produces.
      const held = heldOn(test.server, test.near, dotId);
      expect(held?.stacks).toBe(row.maxStacks);
      expect(held?.expiresAtTick).toBe(test.server.world.tick + dotDurationTicks(row));
      // **Alone**, which is the entire difference from `'status'`: that one puts
      // all sixteen visible statuses on at once, which is right for reading the
      // mark row and useless for looking at one effect.
      expect(Object.keys(entityOf(test.server, test.near).statuses)).toEqual([dotId]);
    },
  );

  it.each([
    ['an ordinal below the table', -4, rowAt(0)],
    ['one exactly past its end', ALL_DOTS.length, rowAt(ALL_DOTS.length - 1)],
    ['one a long way past it', 9_999, rowAt(ALL_DOTS.length - 1)],
    ['something that is not a number at all', Number.NaN, rowAt(0)],
  ] as const)('clamps %s rather than throwing', async (_label, magnitude, expected) => {
    const test = await fight();

    const said = test.server.triggerEvent('affliction', test.at.x, test.at.y, magnitude);

    // Clamped rather than refused: an operator has no list in front of them, and
    // the failure mode of a refusal is a button that appears to do nothing. The
    // reply says which row it settled on, so a wrong number is visible there.
    expect(said).toContain(`with ${expected.name} x${expected.maxStacks} `);
    // And it actually landed. A clamp that returned a sentence and marked nobody
    // reads identically in the console, which is the version worth ruling out.
    expect(heldOn(test.server, test.near, expected.id)?.stacks).toBe(expected.maxStacks);
  });

  it('marks bodies and nothing else, so a drop at your feet is left lying there', async () => {
    const test = await fight();
    // The other admin trigger that puts an entity in the world, used as the
    // negative arm of the kind filter: a drop is in reach, is an entity, and is
    // not something an affliction can be on.
    test.server.triggerEvent('drop', test.at.x, test.at.y, 0);
    const drop = [...test.server.world.entities.values()].find((entity) => entity.drop);
    if (!drop) throw new Error('the admin drop never landed');

    test.server.triggerEvent('affliction', test.at.x, test.at.y, ordinalOf(StatusId.Burn));

    expect(Object.keys(entityOf(test.server, drop.id).statuses)).toEqual([]);
    expect(heldOn(test.server, test.player, StatusId.Burn)).not.toBeNull();
  });

  it('draws nothing from the Rng, so triggering one cannot move a roll', async () => {
    const test = await fight();
    // The guarantee the `'status'` case above it makes and this one inherits: it
    // writes only into `statuses`, so it can no more change an outcome than the
    // real thing can.
    //
    // `Rng` is immutable -- every draw returns a *new* one -- so the sharpest
    // statement available is that the world is holding the same object
    // afterwards. `getState()` is copied and compared beside it because identity
    // alone would also hold for a replacement that happened to be equal, and
    // what is being claimed is that no draw was taken at all.
    const before = test.server.world.rng;
    const state = [...before.getState()];
    const bodies = test.server.world.entities.size;

    test.server.triggerEvent('affliction', test.at.x, test.at.y, ordinalOf(StatusId.Poison));

    expect(test.server.world.rng).toBe(before);
    expect([...test.server.world.rng.getState()]).toEqual(state);
    // Nothing spawned and nothing despawned either -- the other way an admin
    // action reaches past the body it was aimed at.
    expect(test.server.world.entities.size).toBe(bodies);
  });
});
