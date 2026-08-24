/**
 * The paint a shot flies with (spec 216).
 *
 * Two halves, and they fail differently. The **table** half is the pair of
 * assertions spec 215 wrote for `AFFLICTION_ART`, restated one system along:
 * checking that every id `SHOT_ART` names is in the registry catches a typo --
 * a name that looks right and silently plays nothing -- and checking the other
 * way catches an effect authored and then reached by nothing, which is the exact
 * state this spec found the painted explosion in after eighty specs.
 *
 * The **driver** half is everything a persistent attached effect owes: a refusal
 * that is retried, an eviction that is noticed, and a stop that is actually
 * made. All three are invisible in a screenshot and all three are why a body
 * ends up permanently unpainted or a slot ends up permanently held.
 */

import { describe, expect, it } from 'vitest';
import { EFFECTS } from '../vfx/registry.js';
import { ALL_ABILITIES, type ProjectileLook } from '../../../server/data/abilities.js';
import { appearanceOf } from './appearance.js';
import { EntityKind } from '../../../server/net/protocol.js';
import {
  SHOT_ART,
  ShotVfx,
  shotArtFor,
  shotSeedFor,
  type ShotBody,
  type ShotVfxPlayer,
} from './shot-vfx.js';

const ids = new Set(EFFECTS.map((effect) => effect.id));

/** A shot, at some plausible place, with whatever look is being asked about. */
function shot(look: ProjectileLook | null, entityId = 7): ShotBody {
  return { entityId, x: 120, y: 30, z: -80, radius: 9, look };
}

/** A player that records rather than draws. Structurally a `VfxLayer`. */
class Recorder implements ShotVfxPlayer {
  readonly played: { id: string; options: Parameters<ShotVfxPlayer['play']>[1] }[] = [];
  readonly stopped: number[] = [];
  /** Handles this will refuse to start. `null` refuses everything. */
  refuse = false;
  /** Handles this reports as no longer running. */
  readonly dead = new Set<number>();
  private next = 1;

  play(id: string, options: Parameters<ShotVfxPlayer['play']>[1]): number {
    this.played.push({ id, options });
    if (this.refuse) return 0;
    return this.next++;
  }
  stop(handle: number): void {
    this.stopped.push(handle);
  }
  has(id: string): boolean {
    return ids.has(id);
  }
  isLive(handle: number): boolean {
    return handle !== 0 && !this.dead.has(handle);
  }
}

describe('which shots carry paint', () => {
  it('names only effects the registry actually holds', () => {
    for (const id of Object.values(SHOT_ART)) expect(ids.has(id), id).toBe(true);
    // And the sweep reached something, or an empty table passes it.
    expect(Object.keys(SHOT_ART).length).toBeGreaterThan(0);
  });

  it('reaches every shot effect the registry holds', () => {
    // The direction that catches an authored effect nothing plays. It costs a
    // batch in the compiled registry, it is photographed by the preview sheet,
    // and it never appears in a game -- which is precisely the state
    // `explosion_brush` and its three siblings were in before this spec.
    const authored = EFFECTS.filter((effect) => effect.id.startsWith('shot_')).map((e) => e.id);
    expect(authored.length).toBeGreaterThan(0);
    const named = new Set(Object.values(SHOT_ART));
    for (const id of authored) {
      expect(named.has(id), `${id} is authored and reached by nothing`).toBe(true);
    }
    expect([...named].sort()).toEqual([...authored].sort());
  });

  it('leaves the three looks that are objects or light bare', () => {
    // Not an omission, and each has its own reason (see `SHOT_ART`): an arrow
    // and a star ARE their mesh, and an orb already reads as lit from within.
    for (const look of ['arrow', 'shuriken', 'orb'] as const) {
      expect(shotArtFor(look), look).toBeNull();
    }
    expect(shotArtFor(null)).toBeNull();
    expect(shotArtFor(undefined)).toBeNull();
  });

  it('paints the shot the staff throws', () => {
    const look = appearanceOf({ kind: EntityKind.Projectile, typeId: 'ranged.ember' }).look;
    expect(look).toBe('ember');
    expect(shotArtFor(look)).toBe('shot_ember');
  });

  it('is reachable from an ability the table actually holds', () => {
    // The third direction, and the one neither of the two above can see: art
    // for a look no row throws is art nothing in the game can produce.
    const thrown = new Set(
      ALL_ABILITIES.map((ability) => ability.projectile?.look).filter((look) => look !== undefined),
    );
    for (const look of Object.keys(SHOT_ART)) {
      expect(thrown.has(look as ProjectileLook), `${look} is painted and thrown by nothing`).toBe(true);
    }
  });
});

describe('the shot paint driver', () => {
  it('starts the paint attached to the shot, at the shot’s own scale', () => {
    const player = new Recorder();
    new ShotVfx(player).step(shot('ember'));

    expect(player.played).toHaveLength(1);
    const [call] = player.played;
    expect(call?.id).toBe('shot_ember');
    // Every length in `brushShot` is authored in shot radii, so this is what
    // makes one definition a fireball at any size.
    expect(call?.options.scale).toBe(9);
    expect(call?.options.attach).toEqual({ kind: 'entity', entityId: 7 });
    expect(call?.options.x).toBe(120);
    expect(call?.options.y).toBe(30);
    expect(call?.options.z).toBe(-80);
  });

  it('is idempotent: the same shot on the next frame starts nothing', () => {
    const player = new Recorder();
    const driver = new ShotVfx(player);
    for (let frame = 0; frame < 30; frame++) driver.step(shot('ember'));
    expect(player.played).toHaveLength(1);
    expect(player.stopped).toHaveLength(0);
  });

  it('plays nothing at all for a look with no art', () => {
    const player = new Recorder();
    const driver = new ShotVfx(player);
    for (const look of ['arrow', 'shuriken', 'orb'] as const) driver.step(shot(look));
    driver.step(shot(null));
    expect(player.played).toHaveLength(0);
    expect(driver.entities()).toHaveLength(0);
  });

  it('retries a refused start on the next frame rather than giving up', () => {
    // `play` returns 0 when the pool is under pressure or the shot is past
    // `cullDistance`. Committing that as "started" would leave the shot
    // unpainted for the rest of its life -- silently, and only in the crowded
    // fight that caused the pressure.
    const player = new Recorder();
    const driver = new ShotVfx(player);
    player.refuse = true;
    driver.step(shot('ember'));
    driver.step(shot('ember'));
    expect(player.played).toHaveLength(2);

    player.refuse = false;
    driver.step(shot('ember'));
    expect(player.played).toHaveLength(3);
    // ...and then settles, rather than restarting every frame.
    driver.step(shot('ember'));
    expect(player.played).toHaveLength(3);
  });

  it('notices an eviction and puts the paint back', () => {
    // A full instance pool does not refuse: it evicts the lowest-priority
    // furthest instance and bumps the slot's generation, so the held handle
    // names nothing where it sits.
    const player = new Recorder();
    const driver = new ShotVfx(player);
    driver.step(shot('ember'));
    const handle = 1;

    player.dead.add(handle);
    driver.step(shot('ember'));
    expect(player.played).toHaveLength(2);
    // The evicted handle is NOT stopped: the slot already belongs to somebody
    // else, and stopping it would take down whatever took it.
    expect(player.stopped).toHaveLength(0);
  });

  it('stops what it holds when the shot leaves the scene', () => {
    const player = new Recorder();
    const driver = new ShotVfx(player);
    driver.step(shot('ember'));
    expect(driver.entities()).toEqual([7]);

    driver.forget(7);
    expect(player.stopped).toEqual([1]);
    expect(driver.entities()).toHaveLength(0);
    // And forgetting twice is not two stops.
    driver.forget(7);
    expect(player.stopped).toEqual([1]);
  });

  it('holds nothing to stop when the start was refused', () => {
    const player = new Recorder();
    const driver = new ShotVfx(player);
    player.refuse = true;
    driver.step(shot('ember'));
    driver.forget(7);
    // Handle 0 names no instance, and stopping it would be a stop on whatever
    // slot 0 happens to be.
    expect(player.stopped).toHaveLength(0);
  });

  it('stops every shot it holds on a clear', () => {
    const player = new Recorder();
    const driver = new ShotVfx(player);
    for (let id = 1; id <= 4; id++) driver.step(shot('ember', id));
    expect(driver.entities()).toHaveLength(4);
    driver.clear();
    expect(player.stopped).toHaveLength(4);
    expect(driver.entities()).toHaveLength(0);
  });

  it('refuses an id the registry does not hold rather than falling back', () => {
    // `playCue`'s rule, not `addEffect`'s. A debug ring under every shot in the
    // air is exactly the noise the restrained-presentation rule exists to stop.
    const player = new Recorder();
    // A look the table knows and the registry does not have art for.
    const driver = new ShotVfx({
      ...player,
      play: (id, options) => player.play(id, options),
      stop: (handle) => player.stop(handle),
      has: () => false,
      isLive: (handle) => player.isLive(handle),
    });
    driver.step(shot('ember'));
    expect(player.played).toHaveLength(0);
  });
});

describe('the seed', () => {
  it('is a pure function of the shot and the effect', () => {
    // Two clients watching one fireball have to see the same marks, which is
    // why `PlayOptions.seed` has no default at all.
    expect(shotSeedFor(11, 'shot_ember')).toBe(shotSeedFor(11, 'shot_ember'));
    expect(shotSeedFor(11, 'shot_ember')).not.toBe(shotSeedFor(12, 'shot_ember'));
    expect(shotSeedFor(11, 'shot_ember')).not.toBe(shotSeedFor(11, 'shot_frost'));
  });

  it('stays inside the range a seed is allowed to be', () => {
    for (let id = 0; id < 500; id++) {
      const seed = shotSeedFor(id, 'shot_ember');
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(0x7fffffff);
    }
  });
});
