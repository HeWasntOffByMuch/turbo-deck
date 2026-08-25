/**
 * Player persistence and restart durability (spec 224).
 *
 * The claim this file exists to make is the one the whole feature rests on:
 * **a character written before a restart is the same character after it.** So
 * the tests do not check that a save "worked" against the object still in
 * memory -- they close the database, open a fresh one over the same file, and
 * read the character back through a repository that has never seen it.
 */

import { describe, expect, it } from 'vitest';
import { newCharacter } from '../player/player-manager.js';
import { INVENTORY_SLOTS, type PersistedPlayer } from '../state/types.js';
import { CorruptPlayerData } from './player-record.js';
import { managerFor, must, openTestStack } from './testing.js';

function character(id: string, patch: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return { ...newCharacter(id, id, 'hub'), ...patch };
}

describe('player persistence', () => {
  it('creates a player and loads it again', async () => {
    const stack = openTestStack();
    try {
      const original = character('p_alice', { coins: 250, level: 4, experience: 900 });
      await stack.current.store.savePlayer(original);

      const loaded = await stack.current.store.loadPlayer('p_alice');
      expect(loaded).not.toBeNull();
      expect(loaded?.coins).toBe(250);
      expect(loaded?.level).toBe(4);
      expect(loaded?.experience).toBe(900);
      expect(loaded?.equipment.mainHand).toBe(original.equipment.mainHand);
      expect(loaded?.inventory).toHaveLength(INVENTORY_SLOTS);
    } finally {
      stack.dispose();
    }
  });

  it('answers null for a player that was never saved', async () => {
    const stack = openTestStack();
    try {
      expect(await stack.current.store.loadPlayer('p_nobody')).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('survives the database being closed and a fresh one opened over the file', async () => {
    const stack = openTestStack();
    try {
      // create -> modify -> save -> close -> fresh connection -> reload.
      await stack.current.store.savePlayer(character('p_bob'));
      const mid = must(await stack.current.store.loadPlayer('p_bob'), 'p_bob');
      await stack.current.store.savePlayer({
        ...mid,
        coins: 1234,
        level: 11,
        experience: 5555,
        position: { x: 42, y: -17, z: 3 },
        facing: 1.25,
        unspentSkillPoints: 6,
      });

      const reopened = stack.reopen();
      const loaded = await reopened.store.loadPlayer('p_bob');
      expect(loaded?.coins).toBe(1234);
      expect(loaded?.level).toBe(11);
      expect(loaded?.experience).toBe(5555);
      expect(loaded?.position).toEqual({ x: 42, y: -17, z: 3 });
      expect(loaded?.facing).toBeCloseTo(1.25, 6);
      expect(loaded?.unspentSkillPoints).toBe(6);
    } finally {
      stack.dispose();
    }
  });

  it('round-trips a bag, worn gear and a skill allocation exactly', async () => {
    const stack = openTestStack();
    try {
      const base = character('p_carol');
      // An explicitly empty bag rather than the starter kit's, so "slot 1 is
      // empty" is a claim about what was written rather than about what a new
      // character happens to be carrying.
      const bag: (typeof base.inventory)[number][] = new Array(INVENTORY_SLOTS).fill(null);
      bag[0] = { defId: 'potion.minor', count: 5 };
      bag[7] = { defId: 'sword.worn', count: 1 };
      await stack.current.store.savePlayer({
        ...base,
        inventory: bag,
        equipment: { ...base.equipment, trinket: 'ring.plain' },
        skills: [{ skillId: 'might.cleave', level: 2 }],
        fallbackCharges: 2,
      });

      const loaded = must(await stack.reopen().store.loadPlayer('p_carol'), 'p_carol');
      expect(loaded.inventory[0]).toEqual({ defId: 'potion.minor', count: 5 });
      expect(loaded.inventory[7]).toEqual({ defId: 'sword.worn', count: 1 });
      expect(loaded.inventory[1]).toBeNull();
      expect(loaded.equipment.trinket).toBe('ring.plain');
      expect(loaded.skills).toEqual([{ skillId: 'might.cleave', level: 2 }]);
      expect(loaded.fallbackCharges).toBe(2);
    } finally {
      stack.dispose();
    }
  });

  it('leaves fallbackCharges absent when it was never stored, rather than zero', async () => {
    // Spec 156's rule: an upgrade must not strand a character with no flask,
    // and `undefined` is what "load it full" is expressed as.
    const stack = openTestStack();
    try {
      const withoutFlask: PersistedPlayer = character('p_dana');
      delete (withoutFlask as { fallbackCharges?: number }).fallbackCharges;
      await stack.current.store.savePlayer(withoutFlask);
      const loaded = must(await stack.reopen().store.loadPlayer('p_dana'), 'p_dana');
      expect('fallbackCharges' in loaded).toBe(false);
    } finally {
      stack.dispose();
    }
  });

  it('reports unreadable save data rather than silently replacing the character', async () => {
    const stack = openTestStack();
    try {
      await stack.current.store.savePlayer(character('p_erin'));
      stack.current.db.run("UPDATE players SET data = ? WHERE id = ?", '{not json', 'p_erin');
      await expect(stack.current.store.loadPlayer('p_erin')).rejects.toThrow(CorruptPlayerData);
    } finally {
      stack.dispose();
    }
  });

  it('a save overwrites rather than duplicating, and keeps created_at', async () => {
    const stack = openTestStack();
    try {
      await stack.current.store.savePlayer(character('p_fred', { coins: 1 }));
      const created = stack.current.db.get<{ created_at: number }>(
        'SELECT created_at FROM players WHERE id = ?',
        'p_fred',
      );
      await stack.current.store.savePlayer(character('p_fred', { coins: 2 }));

      const count = stack.current.db.get<{ n: number }>('SELECT count(*) AS n FROM players');
      expect(count?.n).toBe(1);
      const after = stack.current.db.get<{ created_at: number; coins: number }>(
        'SELECT created_at, coins FROM players WHERE id = ?',
        'p_fred',
      );
      expect(after?.coins).toBe(2);
      expect(after?.created_at).toBe(created?.created_at);
    } finally {
      stack.dispose();
    }
  });

  it('a PlayerManager login writes the character straight away, so a crash cannot lose a new one', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      const session = await players.login('p_gil', 'Gil');
      expect(session.record.id).toBe('p_gil');
      // Not dirty: it was just written.
      expect(players.isDirty('p_gil')).toBe(false);

      const loaded = await stack.reopen().store.loadPlayer('p_gil');
      expect(loaded?.displayName).toBe('Gil');
    } finally {
      stack.dispose();
    }
  });

  it('listPlayerIds sees every saved character', async () => {
    const stack = openTestStack();
    try {
      await stack.current.store.savePlayer(character('p_1'));
      await stack.current.store.savePlayer(character('p_2'));
      expect([...(await stack.current.store.listPlayerIds())].sort()).toEqual(['p_1', 'p_2']);
    } finally {
      stack.dispose();
    }
  });

  it('keeps bans, mutes and the audit log across a restart', async () => {
    const stack = openTestStack();
    try {
      await stack.current.store.putBan({
        playerId: 'p_villain',
        reason: 'griefing',
        until: Number.POSITIVE_INFINITY,
        issuedBy: 'dev',
      });
      await stack.current.store.putMute({ playerId: 'p_loud', until: 5_000, issuedBy: 'dev' });
      await stack.current.store.appendAudit({
        at: 1,
        actor: 'dev',
        action: 'ban',
        target: 'p_villain',
        detail: 'griefing',
        accepted: true,
      });

      const reopened = stack.reopen();
      const ban = await reopened.store.getBan('p_villain');
      // Infinity is what a permanent ban is; it has to come back as Infinity.
      expect(ban?.until).toBe(Number.POSITIVE_INFINITY);
      expect(ban?.reason).toBe('griefing');
      expect((await reopened.store.getMute('p_loud'))?.until).toBe(5_000);
      const audit = await reopened.store.listAudit(10);
      expect(audit[0]?.action).toBe('ban');
      expect(audit[0]?.accepted).toBe(true);
    } finally {
      stack.dispose();
    }
  });
});
