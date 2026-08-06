/**
 * The auto-attack, end to end: the client's two decisions against the real tick.
 *
 * `target.test.ts` and `intent.test.ts` each pin one pure function, and both
 * passed while a player walked into range and stood there for good. The bug
 * lived in the *seam*: `autoAttack` said "keep chasing" at a distance
 * `moveIntent` had already called arrived, so the body stopped walking and never
 * swung. Nothing that tests one function at a time can see that.
 *
 * So this drives the loop the view drives -- decide, steer, feed the input to
 * `step` -- and asks the only question that matters: does the order close the
 * gap and kill the thing. It is still headless and still deterministic; the
 * renderer contributes nothing but the two pure functions being exercised.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../../../server/config.js';
import { abilityById } from '../../../server/data/abilities.js';
import { monsterById } from '../../../server/data/monsters.js';
import { computeEffectiveStats } from '../../../server/player/stats.js';
import { EMPTY_EQUIPMENT, type PersistedPlayer } from '../../../server/state/types.js';
import { chunkKeyOf } from '../../../server/world/chunks.js';
import { FLAT_TERRAIN } from '../../../server/world/terrain.js';
import { ZoneManager } from '../../../server/world/zone-manager.js';
import { EntityKindValue, type ServerWorldState } from '../../../server/sim/types.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../../../server/sim/world.js';
import { autoAttack } from './target.js';
import { moveIntent } from './intent.js';

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, dexterity: 5, intelligence: 5, vitality: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  position: { x: 0, y: 0, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  health: 200,
  resource: 100,
};

function context(): StepContext {
  const activeChunks = new Set<string>();
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) activeChunks.add(chunkKeyOf(dx * 100, dy * 100, 100));
  }
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    // The ambient spawner off: this counts events, and a wandering stalker's
    // blows are indistinguishable from the ones being measured.
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks,
    chunkSize: 100,
    spawnPoints: [],
  };
}

interface Tally {
  /** Ticks the client asked to swing. */
  readonly asks: number;
  readonly commits: number;
  readonly cancels: number;
  readonly releases: number;
  readonly hits: number;
  readonly rejects: readonly string[];
  /** True once the target is dead or swept away. */
  readonly killed: boolean;
  /** How far apart the two bodies ended up. */
  readonly finalDistance: number;
}

/**
 * Runs a standing attack order for `ticks`, exactly as `view.ts` runs it: ask
 * `autoAttack` what to do, hand its chase to `moveIntent` as a destination, and
 * send the result as one input frame.
 */
function fight(mainHand: string | null, monsterId: string, startX: number, ticks = 600): Tally {
  const stats = computeEffectiveStats({
    ...RECORD,
    equipment: { ...EMPTY_EQUIPMENT, mainHand },
  });
  const swing = abilityById(stats.basicAttackId);
  if (!swing) throw new Error(`no ability ${stats.basicAttackId}`);
  const definition = monsterById(monsterId);
  if (!definition) throw new Error(`no monster ${monsterId}`);

  let state: ServerWorldState = createWorldState(3);
  const player = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: 0, y: 0, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = player.state;
  const mob = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: monsterId,
    position: { x: startX, y: 0, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  state = mob.state;

  const ctx = context();
  let facing = 0;
  let asks = 0;
  let commits = 0;
  let cancels = 0;
  let releases = 0;
  let hits = 0;
  const rejects: string[] = [];
  let killed = false;
  let finalDistance = startX;

  for (let i = 0; i < ticks; i++) {
    const me = state.entities.get(player.entity.id);
    if (!me) break;
    const target = state.entities.get(mob.entity.id);
    if (!target || target.health <= 0) {
      killed = true;
      break;
    }
    finalDistance = Math.hypot(target.position.x - me.position.x, target.position.y - me.position.y);

    const decision = autoAttack({
      self: { x: me.position.x, y: me.position.y },
      target: {
        id: target.id,
        x: target.position.x,
        y: target.position.y,
        radius: target.radius,
        health: target.health,
      },
      range: swing.range,
      rooted: me.cast !== null,
      readyAtTick: me.cooldowns[swing.id] ?? 0,
      tick: state.tick,
    });
    const intent = moveIntent({
      held: new Set(),
      self: { x: me.position.x, y: me.position.y },
      destination: decision.chaseTo,
      route: null,
      facing,
      castAim: me.cast ? { x: me.cast.targetX, y: me.cast.targetY } : null,
    });
    facing = intent.facing;
    if (decision.attack) asks += 1;

    const result = step(
      state,
      [
        {
          entityId: me.id,
          seq: i + 1,
          moveX: intent.moveX,
          moveY: intent.moveY,
          facing: intent.facing,
          buttons: 0,
          predictedX: me.position.x,
          predictedY: me.position.y,
          hasPrediction: false,
          seqSpan: 1,
          castAbilityId: decision.attack ? swing.id : '',
          castTargetX: target.position.x,
          castTargetY: target.position.y,
          castTargetEntityId: target.id,
          cancelCast: false,
        },
      ],
      ctx,
    );
    state = result.state;
    for (const event of result.events) {
      if (event.kind === 'castStarted' && event.entityId === me.id) commits += 1;
      if (event.kind === 'castEnded' && event.entityId === me.id) {
        if (event.reason === 1) cancels += 1;
        if (event.reason === 0) releases += 1;
      }
      if (event.kind === 'castRejected' && event.entityId === me.id) rejects.push(event.reason);
      if (event.kind === 'hit' && event.attackerId === me.id) hits += 1;
    }
  }

  return { asks, commits, cancels, releases, hits, rejects, killed, finalDistance };
}

describe('a standing attack order, end to end', () => {
  /**
   * One case per weapon, because the bug that prompted this was invisible on
   * melee -- a direction-targeted swing has no range gate, so only the two
   * ranged attacks ever stood and did nothing.
   */
  for (const weapon of [null, 'sword.worn', 'bow.hunting', 'stars.weighted']) {
    it(`closes the gap and kills a grazer with ${weapon ?? 'empty hands'}`, () => {
      const result = fight(weapon, 'grazer', 600);
      expect(result.killed, JSON.stringify(result)).toBe(true);
      expect(result.hits).toBeGreaterThan(0);
      // Nothing was refused, and nothing was withdrawn from: the order walks in
      // and swings, and neither end argues about where "in range" is.
      expect(result.rejects).toEqual([]);
      expect(result.cancels).toBe(0);
    });
  }

  /**
   * The failure itself, stated as a property: a body that has stopped walking
   * has to be a body that is swinging. Standing between the two is the bug.
   */
  it('never comes to rest without attacking', () => {
    for (const weapon of [null, 'bow.hunting', 'stars.weighted']) {
      const result = fight(weapon, 'grazer', 600, 240);
      expect(result.asks, `${weapon ?? 'empty hands'} never asked to swing`).toBeGreaterThan(0);
    }
  });

  /**
   * A ranged attack should not have to walk into melee to use its range. The
   * grazer is passive and never closes, so where the player stops is entirely
   * the order's own decision.
   */
  it('opens at the weapon\'s range rather than closing to a sword length', () => {
    const melee = fight('sword.worn', 'grazer', 600, 240);
    const bow = fight('bow.hunting', 'grazer', 600, 30);
    expect(bow.finalDistance).toBeGreaterThan(melee.finalDistance * 2);
  });
});
