/**
 * The fire burning in a campfire (spec 250).
 *
 * Everything here is bookkeeping, because that is the whole of what this driver
 * is: which fixtures burn is a table, and the only way this file can be wrong is
 * by starting a fire twice, stopping one late, or believing a handle that names
 * nothing.
 *
 * The three handle rules are `affliction-vfx.ts`'s and each has a matching bug in
 * this game's history -- `play` returns 0 on refusal, a full pool *evicts*
 * rather than refusing, and nothing in the particle system stops itself. What is
 * new here is the *fourth* thing, and it is the one this driver exists for: a
 * fire stops because the ground it stands on stopped being drawn, and there is
 * no event for that, so the whole list is reconciled every frame.
 *
 * Driven against a recording `VfxPlayer`: no three.js, no DOM.
 */

import { describe, expect, it } from 'vitest';
import type { VfxPlayer } from './affliction-vfx.js';
import { FireVfx, FIRE_SCALE, FIXTURE_ART, type FireSite } from './fire-vfx.js';
import { FIXTURE_KINDS, FIXTURE_LIGHTS } from '../../../terrain/vegetation.js';

interface PlayCall {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly seed: number;
  readonly scale: number | undefined;
  readonly handle: number;
}

class Recorder implements VfxPlayer {
  readonly played: PlayCall[] = [];
  readonly stopped: number[] = [];
  refusals = 0;
  readonly evicted = new Set<number>();
  private readonly known: ReadonlySet<string> | null;
  private next = 1;

  constructor(known?: readonly string[]) {
    this.known = known ? new Set(known) : null;
  }

  has(id: string): boolean {
    return this.known === null ? true : this.known.has(id);
  }

  play(id: string, options: Parameters<VfxPlayer['play']>[1]): number {
    let handle = 0;
    if (this.refusals > 0) this.refusals -= 1;
    else {
      handle = this.next;
      this.next += 1;
    }
    this.played.push({ id, x: options.x, y: options.y, z: options.z, seed: options.seed, scale: options.scale, handle });
    return handle;
  }

  isLive(handle: number): boolean {
    return handle !== 0 && !this.evicted.has(handle) && !this.stopped.includes(handle);
  }

  stop(handle: number): void {
    this.stopped.push(handle);
  }

  get ids(): readonly string[] {
    return this.played.map((call) => call.id);
  }
}

function site(over: Partial<FireSite> = {}): FireSite {
  return {
    key: 'a',
    kind: 'campfire',
    x: 120,
    groundY: 30,
    lightY: 30 + FIXTURE_LIGHTS.campfire.height,
    z: -40,
    footprint: 34,
    ...over,
  };
}

/** A torch standing on the same ground, at the height its own light hangs. */
function torch(over: Partial<FireSite> = {}): FireSite {
  return site({
    key: 't',
    kind: 'torch-stand',
    lightY: 30 + FIXTURE_LIGHTS['torch-stand'].height,
    footprint: 10,
    ...over,
  });
}

const FIRE = FIXTURE_ART.campfire?.id ?? '';
const TORCH = FIXTURE_ART['torch-stand']?.id ?? '';

describe('which fixtures burn (specs 250, 263)', () => {
  it('plays a fire for a campfire and a smaller one for a torch', () => {
    const player = new Recorder();
    const fires = new FireVfx(player);
    fires.step([site(), site({ key: 'b', kind: 'lamp-post' }), torch()]);
    expect(player.ids).toEqual([FIRE, TORCH]);
    expect(fires.keys()).toEqual(['a', 't']);
  });

  /**
   * A lamp post is the row that is deliberately absent: what is in its lantern is
   * a mantle, and a mantle says it is lit by glowing rather than by burning.
   */
  it('plays nothing for a lamp post', () => {
    const player = new Recorder();
    const fires = new FireVfx(player);
    fires.step([site({ key: 'b', kind: 'lamp-post' })]);
    expect(player.played).toHaveLength(0);
    expect(fires.keys()).toEqual([]);
  });

  /**
   * The one thing `props.ts` says nobody would think to check: a lamp whose flame
   * is not inside its own lantern. A light hangs *in* a flame, so a root above it
   * is a fire burning off the top of the fixture holding it.
   */
  it('roots every fire at or under the light hung in it', () => {
    for (const kind of FIXTURE_KINDS) {
      const art = FIXTURE_ART[kind];
      if (!art) continue;
      expect(art.root, kind).toBeGreaterThanOrEqual(0);
      expect(art.root, kind).toBeLessThanOrEqual(1);
      expect(art.scale, kind).toBeGreaterThan(0);
    }
  });

  it('starts nothing for an effect the registry has not got', () => {
    // A build whose library is missing the row. Silence rather than a throw: the
    // frame is worth more than the paint.
    const player = new Recorder([]);
    const fires = new FireVfx(player);
    fires.step([site()]);
    expect(player.played).toHaveLength(0);
  });
});

describe('where a fire is played (specs 250, 263)', () => {
  it('puts a campfire on the ground, not at the flame the light hangs at', () => {
    const player = new Recorder();
    new FireVfx(player).step([site({ x: 40, groundY: 12, lightY: 46, z: 80 })]);
    const call = player.played[0];
    expect(call?.x).toBe(40);
    expect(call?.y).toBe(12);
    expect(call?.z).toBe(80);
  });

  /** A torch's fire is in its bowl, which is most of the way up its own stake. */
  it('puts a torch at its head rather than at its feet', () => {
    const player = new Recorder();
    new FireVfx(player).step([torch({ groundY: 100, lightY: 178 })]);
    const y = player.played[0]?.y ?? 0;
    expect(y).toBeGreaterThan(160);
    expect(y).toBeLessThanOrEqual(178);
  });

  /**
   * The reason the root is a *fraction* rather than a height: a prop placed at
   * twice the size is twice as tall, and its light is already hung to match.
   */
  it('carries the flame up with a torch placed larger', () => {
    const player = new Recorder();
    const ground = 30;
    const single = 30 + FIXTURE_LIGHTS['torch-stand'].height;
    new FireVfx(player).step([
      torch({ key: 'one', groundY: ground, lightY: single, footprint: 10 }),
      torch({ key: 'two', groundY: ground, lightY: ground + (single - ground) * 2, footprint: 20 }),
    ]);
    const [small, large] = player.played;
    expect((large?.y ?? 0) - ground).toBeCloseTo(((small?.y ?? 0) - ground) * 2, 5);
    expect(large?.scale).toBeCloseTo((small?.scale ?? 0) * 2, 5);
  });

  it('sizes a campfire inside the ring of stones rather than across it', () => {
    const player = new Recorder();
    new FireVfx(player).step([site({ footprint: 34 })]);
    expect(player.played[0]?.scale).toBeCloseTo(34 * FIRE_SCALE);
    expect(FIRE_SCALE).toBeLessThan(1);
  });

  /**
   * The other way round for a torch, and on purpose: its footprint is the
   * *pole's* collider, and the bowl the fire sits in is wider than the pole.
   */
  it('draws a torch a little wider than the pole a body walks round', () => {
    const player = new Recorder();
    new FireVfx(player).step([torch({ footprint: 10 })]);
    const scale = player.played[0]?.scale ?? 0;
    expect(scale).toBeGreaterThan(10);
    // And still much smaller than the campfire beside it: a torch is a torch.
    expect(scale).toBeLessThan(34 * FIRE_SCALE);
  });

  it('seeds off where it stands, so two clients watch the same fire', () => {
    const here = new Recorder();
    const there = new Recorder();
    new FireVfx(here).step([site({ key: 'left', x: 400, z: 900 })]);
    new FireVfx(there).step([site({ key: 'right', x: 400, z: 900 })]);
    expect(there.played[0]?.seed).toBe(here.played[0]?.seed);
    // And two fires in different places are two fires.
    const apart = new Recorder();
    new FireVfx(apart).step([site({ key: 'a', x: 0, z: 0 }), site({ key: 'b', x: 500, z: 0 })]);
    expect(apart.played[0]?.seed).not.toBe(apart.played[1]?.seed);
  });
});

describe('starting and stopping (spec 250)', () => {
  it('is idempotent: the same sites again start nothing', () => {
    const player = new Recorder();
    const fires = new FireVfx(player);
    fires.step([site()]);
    fires.step([site()]);
    fires.step([site()]);
    expect(player.played).toHaveLength(1);
    expect(player.stopped).toHaveLength(0);
  });

  /**
   * The rule this driver exists for. A fixture leaves the list because the
   * region it stands in stopped being drawn -- there is no event for that, so
   * the absence *is* the signal.
   */
  it('stops a fire whose ground is no longer drawn', () => {
    const player = new Recorder();
    const fires = new FireVfx(player);
    fires.step([site()]);
    const handle = player.played[0]?.handle ?? 0;
    fires.step([]);
    expect(player.stopped).toEqual([handle]);
    expect(fires.keys()).toEqual([]);
    // And it comes back when the ground does, rather than being remembered as
    // already burning.
    fires.step([site()]);
    expect(player.played).toHaveLength(2);
  });

  it('leaves the fires that stayed alone when one goes', () => {
    const player = new Recorder();
    const fires = new FireVfx(player);
    fires.step([site({ key: 'a' }), site({ key: 'b', x: 900 })]);
    const kept = player.played[0]?.handle ?? 0;
    fires.step([site({ key: 'a' })]);
    expect(player.stopped).not.toContain(kept);
    expect(fires.keys()).toEqual(['a']);
  });

  it('stops everything on a teardown, where there is no next frame', () => {
    const player = new Recorder();
    const fires = new FireVfx(player);
    fires.step([site({ key: 'a' }), site({ key: 'b', x: 900 })]);
    fires.forgetAll();
    expect(player.stopped).toHaveLength(2);
    expect(fires.keys()).toEqual([]);
  });
});

describe('the handle rules (spec 250)', () => {
  /**
   * `play` returns 0 when the budget or the cull refuses. A driver that recorded
   * *ids* would commit a fire that was never drawn, and that campfire would be
   * cold for the rest of the session.
   */
  it('asks again after a refusal rather than believing it started', () => {
    const player = new Recorder();
    player.refusals = 1;
    const fires = new FireVfx(player);
    fires.step([site()]);
    expect(player.played[0]?.handle).toBe(0);
    fires.step([site()]);
    expect(player.played).toHaveLength(2);
    expect(player.played[1]?.handle).not.toBe(0);
    // And once it has started, it stops asking.
    fires.step([site()]);
    expect(player.played).toHaveLength(2);
  });

  /** A full pool evicts and bumps the slot's generation; the handle goes stale. */
  it('restarts a fire the pool took back', () => {
    const player = new Recorder();
    const fires = new FireVfx(player);
    fires.step([site()]);
    const handle = player.played[0]?.handle ?? 0;
    player.evicted.add(handle);
    fires.step([site()]);
    expect(player.played).toHaveLength(2);
  });

  it('never asks the player to stop a handle it never got', () => {
    const player = new Recorder();
    player.refusals = 1;
    const fires = new FireVfx(player);
    fires.step([site()]);
    fires.step([]);
    expect(player.stopped).toHaveLength(0);
  });
});
