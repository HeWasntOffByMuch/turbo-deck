/**
 * The ring under a body carrying a field (spec 222).
 *
 * Everything here is about the *bookkeeping*, because that is the whole of what
 * this driver is: `aurasFor` decides which rings are wanted, and the only way
 * this file can be wrong is by starting one twice, stopping one late, or
 * believing a handle that names nothing.
 *
 * Three of the tests below exist because the handle rules are not obvious and
 * each has a matching bug in the game's history:
 *
 *  - `play` returns `0` on refusal, so a driver that records *ids* commits a
 *    ring that was never drawn and the body wears nothing for the rest of its
 *    life (which is why `AuraTracker` cannot be used here);
 *  - a full instance pool **evicts** rather than refusing and bumps the slot's
 *    generation, so a handle goes stale where it sits;
 *  - nothing in the particle system stops itself, and an aura particle lives ten
 *    minutes, so a ring left on a despawned body holds a slot for the session.
 *
 * Driven against a recording `VfxPlayer`: no three.js, no DOM.
 */

import { describe, expect, it } from 'vitest';
import { SCORCHED_EARTH } from '../../../server/data/aura-fields.js';
import { visualFor } from '../../../server/data/status-visuals.js';
import { StatusId } from '../../../server/sim/statuses.js';
import type { WireStatus } from '../../../server/net/messages.js';
import type { VfxPlayer } from './affliction-vfx.js';
import { AuraVfx, fieldStatusesOn, type AuraBody } from './aura-vfx.js';
import type { AuraFacts } from './auras.js';

interface PlayCall {
  readonly id: string;
  readonly entityId: number;
  readonly seed: number;
  readonly handle: number;
  readonly scale: number | undefined;
}

/** A {@link VfxPlayer} that writes down what it was asked for. */
class Recorder implements VfxPlayer {
  readonly played: PlayCall[] = [];
  readonly stopped: number[] = [];
  /** How many more `play` calls answer `0` -- over budget, or out of range. */
  refusals = 0;
  /** Handles the pool has taken back, standing in for eviction. */
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
    this.played.push({
      id,
      entityId: options.attach?.entityId ?? 0,
      seed: options.seed,
      scale: options.scale,
      handle,
    });
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

const BODY: AuraBody = { entityId: 7, x: 120, y: 30, z: -40 };
const RING = SCORCHED_EARTH.auraEffectId;

function facts(overrides: Partial<AuraFacts> = {}): AuraFacts {
  return {
    entityId: BODY.entityId,
    casting: false,
    channelling: false,
    selected: false,
    telegraphing: false,
    healthFraction: 1,
    ...overrides,
  };
}

const CARRYING = facts({ fields: [StatusId.ScorchedEarth] });
const NOTHING = facts();

function wire(id: string, expiresAtTick: number, stacks = 1): WireStatus {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visual row for ${id}`);
  return { wire: visual.wire, stacks, expiresAtTick };
}

describe('reading the fields off a replicated status list', () => {
  it('finds a field the body is carrying', () => {
    expect(fieldStatusesOn([wire(StatusId.ScorchedEarth, 100)], 50)).toEqual([
      StatusId.ScorchedEarth,
    ]);
  });

  it('ignores a status that is not a field', () => {
    expect(fieldStatusesOn([wire(StatusId.Burn, 100), wire(StatusId.Flow, 100)], 50)).toEqual([]);
  });

  it('refuses a stale entry on read, rather than waiting to be told', () => {
    // `status-marks.ts`'s rule, and for its reason: correctness must not depend
    // on whether the delta saying "it fell off" has arrived. Here that matters
    // more than for a mark -- a ring left up is a hazard drawn where there is
    // none.
    expect(fieldStatusesOn([wire(StatusId.ScorchedEarth, 100)], 100)).toEqual([]);
    expect(fieldStatusesOn([wire(StatusId.ScorchedEarth, 100)], 101)).toEqual([]);
  });

  it('draws nothing for a wire index this build has no row for', () => {
    // A client reading a newer server. Null rather than a throw, so an unknown
    // status costs one ring rather than the frame.
    expect(fieldStatusesOn([{ wire: 200, stacks: 1, expiresAtTick: 100 }], 50)).toEqual([]);
  });
});

describe('starting and stopping a ring', () => {
  it('starts one ring, once, for a body that is carrying a field', () => {
    const recorder = new Recorder();
    const driver = new AuraVfx(recorder);
    for (let i = 0; i < 5; i++) driver.step(BODY, CARRYING);
    expect(recorder.ids).toEqual([RING]);
    expect(recorder.stopped).toEqual([]);
  });

  it('attaches it to the body, so it follows them', () => {
    // The whole difference between an aura and a patch of burning ground: this
    // one goes where its carrier goes, which is `attach` and nothing else.
    const recorder = new Recorder();
    new AuraVfx(recorder).step(BODY, CARRYING);
    expect(recorder.played[0]?.entityId).toBe(BODY.entityId);
  });

  it('plays it at no scale at all', () => {
    // An aura is authored at the radius it is drawn at, because that radius is
    // the field's own reach -- and `system.ts` multiplies an instance scale into
    // offsets and absolute sizes as well as into the shape, so a ring scaled to
    // fit would take its shafts' height and their standing height with it.
    const recorder = new Recorder();
    new AuraVfx(recorder).step(BODY, CARRYING);
    expect(recorder.played[0]?.scale).toBeUndefined();
  });

  it('seeds from facts every client shares', () => {
    // So two people watching one body see the sigil at the same angle. No clock
    // and no `Math.random`.
    const one = new Recorder();
    const two = new Recorder();
    new AuraVfx(one).step(BODY, CARRYING);
    new AuraVfx(two).step(BODY, CARRYING);
    expect(one.played[0]?.seed).toBe(two.played[0]?.seed);
  });

  it('stops it once when the field ends', () => {
    const recorder = new Recorder();
    const driver = new AuraVfx(recorder);
    driver.step(BODY, CARRYING);
    driver.step(BODY, NOTHING);
    driver.step(BODY, NOTHING);
    expect(recorder.stopped).toEqual([1]);
    expect(driver.entities()).toEqual([]);
  });

  it('never plays an id the registry has not got', () => {
    // `playCue`'s rule rather than `addEffect`'s, and for this driver it is
    // sharper than usual: the fallback would be a ring at a radius that is not
    // the field's, which is worse than no ring at all.
    const recorder = new Recorder([]);
    new AuraVfx(recorder).step(BODY, CARRYING);
    expect(recorder.played).toEqual([]);
  });
});

describe('the two obligations a handle carries', () => {
  it('asks again after a refusal, rather than committing one that never started', () => {
    // The reason `AuraTracker` cannot be used here: it records ids, so a refused
    // `play` would be committed and the body would wear nothing for good.
    const recorder = new Recorder();
    recorder.refusals = 2;
    const driver = new AuraVfx(recorder);
    driver.step(BODY, CARRYING);
    driver.step(BODY, CARRYING);
    driver.step(BODY, CARRYING);
    expect(recorder.played.map((call) => call.handle)).toEqual([0, 0, 1]);
    // And then it settles: the fourth frame asks for nothing more.
    driver.step(BODY, CARRYING);
    expect(recorder.played).toHaveLength(3);
  });

  it('restarts a ring the instance pool evicted out from under it', () => {
    // A full pool does not refuse -- it takes the slot and bumps its generation,
    // so the handle names nothing where it sits. Without `isLive` the ring is
    // gone permanently, silently, and only in the crowded fight that caused it.
    const recorder = new Recorder();
    const driver = new AuraVfx(recorder);
    driver.step(BODY, CARRYING);
    recorder.evicted.add(1);
    driver.step(BODY, CARRYING);
    expect(recorder.played.map((call) => call.handle)).toEqual([1, 2]);
    // The evicted handle is not stopped: the slot already belongs to somebody
    // else, and stopping it would take *their* effect down.
    expect(recorder.stopped).toEqual([]);
  });

  it('leaves nothing running on a body that despawned', () => {
    // Nothing in the particle system stops itself, and an aura particle lives
    // `HELD` ticks -- ten minutes. The stop is owed, and it is made from the
    // sweep that knows the body has left.
    const recorder = new Recorder();
    const driver = new AuraVfx(recorder);
    driver.step(BODY, CARRYING);
    driver.forget(BODY.entityId);
    expect(recorder.stopped).toEqual([1]);
    expect(driver.entities()).toEqual([]);
    // And forgetting twice is not a double stop.
    driver.forget(BODY.entityId);
    expect(recorder.stopped).toEqual([1]);
  });

  it('clears every body it is holding', () => {
    const recorder = new Recorder();
    const driver = new AuraVfx(recorder);
    driver.step(BODY, CARRYING);
    driver.step({ ...BODY, entityId: 8 }, facts({ entityId: 8, fields: [StatusId.ScorchedEarth] }));
    driver.clear();
    expect(recorder.stopped).toHaveLength(2);
    expect(driver.entities()).toEqual([]);
  });

  it('keeps one body’s ring separate from another’s', () => {
    const recorder = new Recorder();
    const driver = new AuraVfx(recorder);
    const other = { ...BODY, entityId: 8 };
    driver.step(BODY, CARRYING);
    driver.step(other, facts({ entityId: 8, fields: [StatusId.ScorchedEarth] }));
    driver.step(BODY, NOTHING);
    expect(recorder.stopped).toEqual([1]);
    expect(driver.entities()).toEqual([8]);
  });
});
