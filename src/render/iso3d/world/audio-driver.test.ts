/**
 * What the Play tab hears, frame by frame (spec 229).
 *
 * Every rule in `audio-driver.ts` is about *when* a sound happens rather than
 * which one, and each of them fails in a way nothing else in this repo can
 * catch. A guard break sounded once per tick of its window instead of once on
 * its edge is a machine gun; the same edge taken on first sight replays, at the
 * moment somebody reconnects mid-fight, every contact nobody watched. A held
 * loop started twice is one fireball with a comb filter on it and a loop never
 * stopped is a voice that plays until the tab closes. A refusal committed as
 * "started" leaves the shot that caused the pressure silent for the rest of its
 * life, and an eviction gone unnoticed does the same thing without even leaving
 * a refusal to look at.
 *
 * None of that shows in a screenshot and none of it is audible in a headless
 * run, which is the whole reason the engine is an interface: this drives the
 * real driver against a recorder, so "one break, one sound" is an assertion
 * rather than something judged by ear in a browser.
 */

import { describe, expect, it } from 'vitest';
import { EntityActivity } from '../../../server/net/protocol.js';
import { RARITIES } from '../../../server/data/loot.js';
import {
  NO_HANDLE,
  type Audio,
  type AudioHandle,
  type AudioStats,
  type ListenerPose,
  type PlayOptions,
} from '../../audio/sink.js';
import type { SoundEventId } from '../../audio/events.js';
import { AudioDriver, BODY_SOUND_HEIGHT, type AudioBody } from './audio-driver.js';
import { soundsForBlow, type BlowFacts } from './audio-wire.js';
import { STRIDE_UNITS } from './footsteps.js';

/**
 * An engine that records rather than plays. Structurally an {@link Audio}.
 *
 * `hold` hands out its own handles so a test can watch one particular loop, and
 * the two ways a real engine says no are both reachable: {@link refuse} is the
 * voice cap or an undecoded row (`hold` answers `NO_HANDLE`), and
 * {@link evicted} is the pool handing a live slot to somebody louder, which
 * leaves the handle naming nothing where it sits.
 */
class RecordingAudio implements Audio {
  readonly played: { id: SoundEventId; options: PlayOptions | undefined }[] = [];
  readonly holds: { id: SoundEventId; options: PlayOptions | undefined }[] = [];
  readonly moves: { handle: AudioHandle; options: PlayOptions }[] = [];
  readonly stopped: AudioHandle[] = [];
  readonly listeners: ListenerPose[] = [];
  readonly evicted = new Set<AudioHandle>();
  refuse = false;
  stopAllCalls = 0;
  private next = 1;

  play(id: SoundEventId, options?: PlayOptions): void {
    this.played.push({ id, options });
  }
  hold(id: SoundEventId, options?: PlayOptions): AudioHandle {
    this.holds.push({ id, options });
    return this.refuse ? NO_HANDLE : this.next++;
  }
  move(handle: AudioHandle, options: PlayOptions): void {
    this.moves.push({ handle, options });
  }
  isLive(handle: AudioHandle): boolean {
    return handle !== NO_HANDLE && !this.evicted.has(handle);
  }
  stop(handle: AudioHandle): void {
    this.stopped.push(handle);
  }
  setListener(pose: ListenerPose): void {
    this.listeners.push(pose);
  }
  setMix(): void {
    /* nothing */
  }
  setCatalog(): void {
    /* nothing */
  }
  warm(): void {
    /* nothing */
  }
  resume(): void {
    /* nothing */
  }
  suspend(): void {
    /* nothing */
  }
  stats(): AudioStats {
    return { state: 'idle', voices: 0, held: 0, buffers: 0, loading: 0, refused: 0, missing: 0, started: {} };
  }
  stopAll(): void {
    this.stopAllCalls++;
  }
  preview(): void {
    // The SFX tab's, and nothing this driver does reaches it.
  }

  /** Every id played, in order. What most assertions here are actually about. */
  ids(): readonly string[] {
    return this.played.map((entry) => entry.id);
  }
  countOf(id: string): number {
    return this.played.filter((entry) => entry.id === id).length;
  }
  heldIds(): readonly string[] {
    return this.holds.map((entry) => entry.id);
  }
}

/** A body, somewhere plausible, carrying nothing and doing nothing. */
function aBody(over: Partial<AudioBody> = {}): AudioBody {
  return {
    entityId: 7,
    x: 100,
    z: -40,
    ground: 12,
    activity: EntityActivity.Idle,
    activityUntilTick: 0,
    walks: false,
    projectileLook: null,
    field: false,
    ...over,
  };
}

/** A body inside a guard break that has not run out at `until`. */
function broken(until: number, over: Partial<AudioBody> = {}): AudioBody {
  return aBody({ activity: EntityActivity.Stunned, activityUntilTick: until, ...over });
}

/** An ember in flight -- the one projectile look that carries a sound. */
function ember(over: Partial<AudioBody> = {}): AudioBody {
  return aBody({ projectileLook: 'ember', ...over });
}

/** An arrow in flight -- a physical shot, which has a loose and a landing. */
function arrow(over: Partial<AudioBody> = {}): AudioBody {
  return aBody({ entityId: 31, projectileLook: 'arrow', ...over });
}

function blowFacts(over: Partial<BlowFacts> = {}): BlowFacts {
  return {
    damage: 12,
    killed: false,
    critical: false,
    blocked: false,
    periodic: false,
    bleeds: true,
    x: 40,
    y: 26,
    z: -12,
    onSelf: false,
    ...over,
  };
}

const SOMEWHERE: PlayOptions = { x: 5, y: 30, z: 9 };

describe('the edge a guard break is', () => {
  it('sounds once for a break, not once for every tick of its window', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    // `poiseBroken` never reaches the wire, so the only knowable fact is
    // "stunned, and the clock has not run out" -- which is true on every frame
    // of a window two seconds long.
    driver.body(aBody(), 0);
    for (let tick = 1; tick <= 30; tick++) driver.body(broken(200), tick);
    expect(audio.countOf('combat.stagger')).toBe(1);
  });

  it('makes no sound for a body first seen already broken', () => {
    // The reconnect case, and the same rule `StaggerFlinches` states: a body
    // that walks into view mid-stagger is not a contact anybody watched land,
    // and a client joining a fight must not replay the last ten seconds of it.
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (let tick = 0; tick < 30; tick++) driver.body(broken(200), tick);
    expect(audio.countOf('combat.stagger')).toBe(0);
  });

  it('sounds exactly once per break, for any number of breaks', () => {
    for (const breaks of [1, 2, 3, 5]) {
      const audio = new RecordingAudio();
      const driver = new AudioDriver(audio);
      let tick = 0;
      // A clear frame first, or the run opens inside a window and measures the
      // first-sight rule instead of this one.
      driver.body(aBody(), tick++);
      for (let n = 0; n < breaks; n++) {
        const until = tick + 7;
        while (tick < until) driver.body(broken(until), tick++);
        // Out the far side. At `tick === activityUntilTick` the window is over,
        // which is the only thing that lets the next break be an edge at all.
        for (let clear = 0; clear < 3; clear++) driver.body(aBody(), tick++);
      }
      expect(audio.countOf('combat.stagger'), `${breaks} breaks`).toBe(breaks);
    }
  });

  it('reads a break off the protocol’s own Stunned and nothing else', () => {
    // The driver copies `EntityActivity.Stunned` as a bare 3 rather than
    // importing it. This is the guard a copy owes: renumber the enum and the
    // stagger sound silently moves to whichever activity inherited the number.
    for (const [name, activity] of Object.entries(EntityActivity)) {
      const audio = new RecordingAudio();
      const driver = new AudioDriver(audio);
      driver.body(aBody(), 0);
      driver.body(aBody({ activity, activityUntilTick: 100 }), 1);
      expect(audio.countOf('combat.stagger'), name).toBe(activity === EntityActivity.Stunned ? 1 : 0);
    }
  });

  it('places a sound about a body at ear height above the ground it stands on', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(aBody(), 0);
    driver.body(broken(50, { x: 11, z: 22, ground: -6 }), 1);
    expect(audio.played[0]?.options).toStrictEqual({ x: 11, y: -6 + BODY_SOUND_HEIGHT, z: 22 });
  });
});

describe('the handle a held loop is', () => {
  it('starts a shot’s loop once and moves it thereafter', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (let frame = 0; frame < 50; frame++) {
      driver.body(ember({ x: frame * 4 }), frame);
      driver.sweep();
    }
    expect(audio.heldIds()).toEqual(['elemental.fire.travel']);
    expect(audio.moves).toHaveLength(49);
    expect(audio.stopped).toHaveLength(0);
    // And it follows the shot. A fireball heard where it was launched from is
    // a fireball the ear cannot track.
    expect(audio.moves.at(-1)?.options.x).toBe(49 * 4);
  });

  it('holds nothing for a body that is carrying nothing', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    // An arrow and a star ARE their mesh and an orb is lit from within, which
    // is the same judgement `shot-vfx.ts` makes about their paint. A *held*
    // voice is the claim here: a physical shot fires a one-shot as it leaves,
    // which is a different thing from carrying a sound across the arena.
    for (const look of ['arrow', 'shuriken', 'orb', null]) {
      driver.body(aBody({ entityId: 40 + (look?.length ?? 0), projectileLook: look }), 0);
    }
    expect(audio.holds).toHaveLength(0);
    expect(audio.ids()).toEqual(['combat.projectile.launch', 'combat.projectile.launch']);
  });

  it('stops a loop whose body has left, on the sweep, exactly once', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (let frame = 0; frame < 5; frame++) {
      driver.body(ember(), frame);
      driver.sweep();
    }
    // The shot has landed: no `body()` this frame, and the sweep is the only
    // thing that notices. Nothing in the engine stops a loop on its own.
    driver.sweep();
    expect(audio.stopped).toEqual([1]);
    expect(driver.tracked).toBe(0);

    // A despawn callback arriving after the sweep already collected the body is
    // not a second stop -- handle 1 may belong to somebody else by now.
    driver.forget(7);
    expect(audio.stopped).toEqual([1]);
  });

  it('stops what a body was carrying when the despawn sweep names it', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(ember(), 0);
    driver.forget(7);
    expect(audio.stopped).toEqual([1]);
    expect(driver.tracked).toBe(0);
    driver.forget(7);
    expect(audio.stopped).toEqual([1]);
  });

  it('re-holds a loop the pool evicted, and leaves the slot that took it alone', () => {
    // A full pool does not refuse: it hands the lowest-priority furthest slot
    // over and bumps its generation, so the held handle names nothing where it
    // sits. A driver holding an *id* could not tell that had happened.
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(ember(), 0);
    expect(audio.holds).toHaveLength(1);

    audio.evicted.add(1);
    driver.body(ember(), 1);
    expect(audio.holds).toHaveLength(2);
    // Stopping the evicted handle would take down whatever took the slot.
    expect(audio.stopped).toHaveLength(0);
    // ...and the new handle is the one moved from here on.
    driver.body(ember(), 2);
    expect(audio.moves.at(-1)?.handle).toBe(2);
  });

  it('retries a refused hold every frame rather than committing the refusal', () => {
    // `hold` answers `NO_HANDLE` for an unassigned row, a context that does not
    // exist yet, or a voice cap under pressure. Recording that as "started"
    // would leave the shot that caused the pressure silent for its whole life.
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    audio.refuse = true;
    for (let frame = 0; frame < 6; frame++) driver.body(ember(), frame);
    expect(audio.holds).toHaveLength(6);
    expect(audio.moves).toHaveLength(0);

    audio.refuse = false;
    driver.body(ember(), 6);
    expect(audio.holds).toHaveLength(7);
    // ...and then settles, rather than restarting every frame from here on.
    driver.body(ember(), 7);
    expect(audio.holds).toHaveLength(7);
    expect(audio.moves).toHaveLength(1);
  });

  it('has nothing to stop when the hold was refused', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    audio.refuse = true;
    driver.body(ember(), 0);
    driver.forget(7);
    // Handle 0 names no loop, and stopping it is a stop on whatever slot 0
    // happens to be.
    expect(audio.stopped).toHaveLength(0);
  });

  it('swaps the loop when a body changes what it is carrying', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(ember(), 0);
    driver.body(aBody({ field: true }), 1);
    // One loop per body: two held sounds on one entity is a mix nobody
    // authored, so the old one goes before the new one starts.
    expect(audio.heldIds()).toEqual(['elemental.fire.travel', 'elemental.fire.field']);
    expect(audio.stopped).toEqual([1]);

    // And dropping to nothing lets go rather than leaving the field burning.
    driver.body(aBody(), 2);
    expect(audio.stopped).toEqual([1, 2]);
    expect(audio.holds).toHaveLength(2);
  });

  it('is a projectile before it is a field, for a body that is both', () => {
    // A burning projectile is a projectile: what a body *is* outranks what it
    // *has*.
    const audio = new RecordingAudio();
    new AudioDriver(audio).body(ember({ field: true }), 0);
    expect(audio.heldIds()).toEqual(['elemental.fire.travel']);
  });

  it('lets go of every loop it holds when the tab does', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (const entityId of [1, 2, 3, 4]) driver.body(ember({ entityId }), 0);
    expect(driver.tracked).toBe(4);

    driver.stopAll();
    expect(audio.stopped).toEqual([1, 2, 3, 4]);
    expect(audio.stopAllCalls).toBe(1);
    // The tracks go with them, or the next session inherits four bodies that
    // are not in the world and four handles that name nothing.
    expect(driver.tracked).toBe(0);
    driver.stopAll();
    expect(audio.stopped).toEqual([1, 2, 3, 4]);
  });
});

describe('the accumulator legs are', () => {
  it('steps at a cadence set by ground covered, not by frame rate', () => {
    const ground = STRIDE_UNITS * 20;
    const counts = [8, 12, 24].map((perFrame) => {
      const audio = new RecordingAudio();
      const driver = new AudioDriver(audio);
      const frames = ground / perFrame;
      // Frame 0 only establishes where the body is; every frame after it covers
      // exactly `perFrame` units, so all three walks cover the same ground.
      for (let frame = 0; frame <= frames; frame++) {
        driver.body(aBody({ walks: true, x: frame * perFrame }), frame);
      }
      return audio.countOf('player.footstep');
    });
    // A frame is three ticks at 20fps and one at 60. A gait that stepped per
    // frame would be a different gait on a different machine.
    expect(new Set(counts).size).toBe(1);
    // The head start a body sets off with buys no extra step over whole strides.
    expect(counts[0]).toBe(ground / STRIDE_UNITS);
  });

  it('never steps for a body with no legs, however far it travels', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (let frame = 0; frame <= 200; frame++) {
      driver.body(aBody({ walks: false, projectileLook: 'arrow', x: frame * 20 }), frame);
    }
    expect(audio.countOf('player.footstep')).toBe(0);
  });

  it('banks nothing for a body being shoved rather than walking', () => {
    // `resolveCrowding` displaces a stunned or dead body, which covers ground
    // under nobody's own power. A corpse with footsteps is worse than a silent
    // one.
    for (const activity of [EntityActivity.Stunned, EntityActivity.Dead]) {
      const audio = new RecordingAudio();
      const driver = new AudioDriver(audio);
      for (let frame = 0; frame <= 200; frame++) {
        // `activityUntilTick` 0 so the stagger edge stays out of this.
        driver.body(aBody({ walks: true, activity, x: frame * 20 }), frame);
      }
      expect(audio.countOf('player.footstep'), String(activity)).toBe(0);
    }
  });

  it('puts a footstep on the floor rather than at ear height', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (let frame = 0; frame <= 20; frame++) {
      driver.body(aBody({ walks: true, ground: -6, x: frame * STRIDE_UNITS }), frame);
    }
    const step = audio.played.find((entry) => entry.id === 'player.footstep');
    expect(step).toBeDefined();
    expect(step?.options?.y).toBe(-6);
  });
});

describe('the edges that arrive as callbacks', () => {
  it('plays exactly what the wire answers for a blow, and places it where the blow was', () => {
    const cases: readonly BlowFacts[] = [
      blowFacts(),
      blowFacts({ bleeds: false }),
      blowFacts({ critical: true }),
      blowFacts({ blocked: true }),
      blowFacts({ killed: true }),
      blowFacts({ killed: true, critical: true, onSelf: true }),
      blowFacts({ damage: -30 }),
      blowFacts({ damage: -0 }),
      blowFacts({ periodic: true }),
    ];
    for (const facts of cases) {
      const audio = new RecordingAudio();
      new AudioDriver(audio).blow(facts);
      // The driver forwards and decides nothing: a second opinion about what a
      // critical sounds like is the failure this shape exists to prevent.
      expect(audio.ids()).toEqual(soundsForBlow(facts).map((request) => request.id));
      for (const entry of audio.played) {
        // `toStrictEqual` rather than `toEqual` on purpose: under
        // `exactOptionalPropertyTypes` an absent gain has to be absent, not a
        // `gain: undefined` key that a real engine would read as silence.
        expect(entry.options).toStrictEqual({ x: facts.x, y: facts.y, z: facts.z });
      }
    }
  });

  it('says nothing at all for an affliction’s beat arriving as a blow', () => {
    // Spec 219's rule in the ear: a pulse is not a contact, and eight beats of
    // a Poison heard as eight sword hits is the picture that spec took back out.
    const audio = new RecordingAudio();
    new AudioDriver(audio).blow(blowFacts({ periodic: true, critical: true, killed: true }));
    expect(audio.played).toHaveLength(0);
  });

  it('answers a wind-up, an impact and an affliction beat it has rows for, and is silent otherwise', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.windup('melee.slash', false, SOMEWHERE);
    driver.serverEffect('ranged.ember.impact', SOMEWHERE);
    // A `.self` cue is the cast, and the cast was already heard at the wind-up.
    driver.serverEffect('ranged.ember.self', SOMEWHERE);
    driver.afflictionTick('burn', SOMEWHERE);
    driver.afflictionTick('nonesuch', SOMEWHERE);
    expect(audio.ids()).toEqual(['combat.swing.light', 'elemental.fire.impact', 'affliction.burn.tick']);
  });

  it('plays a cue only when the name is a row this build holds', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.cue('loot.reveal.rare', SOMEWHERE);
    // A name from a table that is not ours. Silence, exactly as an unauthored
    // cue draws nothing -- never a fallback, which would be a debug ring under
    // every drop in the world.
    driver.cue('loot.reveal.legendary', SOMEWHERE);
    driver.cue('', SOMEWHERE);
    expect(audio.ids()).toEqual(['loot.reveal.rare']);
  });

  it('answers every cue the loot table actually emits', () => {
    // The other direction, and the one that makes the seam safe rather than
    // merely typed: a cue string authored in `data/loot.ts` that names no row
    // here is silence nobody would ever report.
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    const named: string[] = [];
    for (const rarity of RARITIES.values()) {
      for (const cue of Object.values(rarity.cues)) {
        if (cue === '') continue;
        named.push(cue);
        driver.cue(cue, SOMEWHERE);
      }
    }
    expect(named.length).toBeGreaterThan(0);
    expect(audio.ids()).toEqual(named);
  });

  it('places an interface sound nowhere at all', () => {
    // Not "at the listener": a spatial sound played at the listener still pans
    // as the camera turns, and a menu click that swings left when you orbit is
    // a bug nobody can describe.
    const audio = new RecordingAudio();
    new AudioDriver(audio).flat('ui.press');
    expect(audio.played).toHaveLength(1);
    expect(audio.played[0]?.options).toBeUndefined();
  });

  it('hands the listener pose straight through', () => {
    const audio = new RecordingAudio();
    const pose: ListenerPose = {
      x: 1,
      y: 2,
      z: 3,
      forward: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
    };
    new AudioDriver(audio).listener(pose);
    expect(audio.listeners).toEqual([pose]);
  });
});

describe('what the driver holds between frames', () => {
  it('tracks one entry per body it has been offered, and drops it on the sweep', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (let entityId = 1; entityId <= 6; entityId++) driver.body(aBody({ entityId }), 0);
    driver.sweep();
    expect(driver.tracked).toBe(6);

    // A map keyed on entity id and never pruned grows by one entry for every
    // monster that has ever spawned, for the life of the session.
    driver.body(aBody({ entityId: 1 }), 1);
    driver.sweep();
    expect(driver.tracked).toBe(1);
  });

  it('treats a body seen again after a sweep as first sight', () => {
    // A body that left the interest set and came back mid-stagger is not a
    // contact this client watched land either.
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(aBody(), 0);
    driver.sweep();
    driver.sweep();
    expect(driver.tracked).toBe(0);
    for (let tick = 1; tick < 10; tick++) driver.body(broken(200), tick);
    expect(audio.countOf('combat.stagger')).toBe(0);
  });
});

describe('the three moments a shot has', () => {
  /**
   * First sight *is* the release: the server creates the entity on the tick the
   * arrow leaves, so there is no separate message to wait for and no way for a
   * client to see one before it was loosed.
   */
  it('looses once, on the frame the arrow appears', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    for (let frame = 0; frame < 5; frame += 1) {
      driver.body(arrow({ x: 100 + frame * 30 }), frame);
      driver.sweep();
    }
    expect(audio.countOf('combat.projectile.launch')).toBe(1);
  });

  it('lands where it was last seen, once, when it stops existing', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(arrow({ x: 100 }), 0);
    driver.sweep();
    driver.body(arrow({ x: 400, z: 55, ground: 20 }), 1);
    driver.sweep();
    // Gone: not offered this frame.
    driver.sweep();
    expect(audio.countOf('combat.projectile.impact')).toBe(1);
    const landed = audio.played.find((entry) => entry.id === 'combat.projectile.impact');
    expect(landed?.options?.x).toBe(400);
    expect(landed?.options?.z).toBe(55);
  });

  /**
   * Two doors out, one sound.
   *
   * The despawn sweep calls `forget` and the frame sweep drops anything it did
   * not see, and an arrow that made a noise through only one of them would land
   * audibly or silently depending on which pass noticed first. Neither can fire
   * twice, because both delete the track.
   */
  it('lands exactly once whichever way the body leaves', () => {
    for (const leave of ['forget', 'sweep'] as const) {
      const audio = new RecordingAudio();
      const driver = new AudioDriver(audio);
      driver.body(arrow(), 0);
      driver.sweep();
      if (leave === 'forget') driver.forget(31);
      driver.sweep();
      driver.sweep();
      expect(audio.countOf('combat.projectile.impact'), leave).toBe(1);
    }
  });

  it('holds no loop for one, and loops the ember without landing it', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(arrow(), 0);
    driver.body(ember({ entityId: 32 }), 0);
    driver.sweep();
    // The arrow is its own mesh and needs no whistle; the ember is the one that
    // carries a voice across the arena.
    expect(audio.heldIds()).toEqual(['elemental.fire.travel']);
    driver.sweep();
    driver.sweep();
    // ...and the ember's landing is the server's own `.impact` message, so it
    // must not also get the physical one.
    expect(audio.countOf('combat.projectile.impact')).toBe(1);
  });

  /**
   * Leaving the tab is not a dozen arrows landing at once.
   *
   * An owed impact is owed to a body that stopped travelling; `stopAll` is the
   * listener stopping instead, and firing every owed landing into the last
   * frame before a tab goes away would be a burst of noise on the way out.
   */
  it('fires nothing owed when the listener leaves', () => {
    const audio = new RecordingAudio();
    const driver = new AudioDriver(audio);
    driver.body(arrow({ entityId: 1 }), 0);
    driver.body(arrow({ entityId: 2 }), 0);
    driver.body(arrow({ entityId: 3 }), 0);
    driver.stopAll();
    expect(audio.countOf('combat.projectile.impact')).toBe(0);
  });
});
