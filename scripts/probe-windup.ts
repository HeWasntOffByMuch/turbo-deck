/**
 * What the wind-up bar actually does while a body shoots as fast as it can.
 *
 * The report is "attacking fast -- especially with throwing stars -- makes the
 * wind-up bar start going really fast". A bar is a number per frame, so this
 * plays the real session (loopback transport, real wire format, real server
 * tick) with the same gate `target.ts` uses for an auto-attack, and prints the
 * number the renderer would draw on every tick: `castBar(cast, drawnTick,
 * ability).progress`, against the same `estimatedTick` the play view passes.
 *
 * Nothing here is part of the game. It exists to be run, read and argued with:
 *
 *   npx tsx scripts/probe-windup.ts [--ability=id] [--ticks=n] [--delay=n]
 *                                   [--dex=n] [--fast] [--quiet]
 *
 * `--dex` and `--fast` are how "attacking fast" is reached: they seed the store
 * with a character carrying dexterity, the finesse skills and a set of weighted
 * stars, so the attack interval comes out of the real stat derivation rather
 * than being poked in. Past a point that interval is *shorter than the
 * wind-up*, which is the regime the report is about.
 */

import { castBar } from '../src/render/iso3d/world/cast.js';
import { abilityById } from '../src/server/data/abilities.js';
import { GameClient } from '../src/server/client/game-client.js';
import { createWorldPredictor } from '../src/server/client/prediction.js';
import { SERVER_PLAYER_RADIUS } from '../src/server/config.js';
import { LoopbackTransport } from '../src/server/net/transport-loop.js';
import { CastPhaseValue } from '../src/server/net/protocol.js';
import type { Channel } from '../src/server/net/transport.js';
import { GameServer } from '../src/server/server.js';
import { createWorldColliders } from '../src/sim/collision.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { MemoryDataStore } from '../src/server/state/memory-store.js';
import { DEFAULT_SPAWN } from '../src/server/player/player-manager.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { EMPTY_EQUIPMENT, emptyInventory } from '../src/server/state/types.js';
import type { PersistedPlayer } from '../src/server/state/types.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Holds every frame, in both directions, for a fixed number of ticks. */
class DelayLine implements Channel {
  private readonly outbound: { at: number; bytes: Uint8Array }[] = [];
  private readonly inbound: { at: number; bytes: Uint8Array }[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private tick = 0;

  constructor(
    private readonly inner: Channel,
    private readonly delayTicks: number,
  ) {
    inner.onMessage((bytes) => {
      this.inbound.push({ at: this.tick + this.delayTicks, bytes });
    });
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  send(bytes: Uint8Array): void {
    this.outbound.push({ at: this.tick + this.delayTicks, bytes: new Uint8Array(bytes) });
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.inner.onClose(handler);
  }

  close(): void {
    this.inner.close();
  }

  deliver(tick: number): void {
    this.tick = tick;
    while (this.outbound.length > 0 && (this.outbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.outbound.shift();
      if (frame) this.inner.send(frame.bytes);
    }
    while (this.inbound.length > 0 && (this.inbound[0]?.at ?? Infinity) <= tick) {
      const frame = this.inbound.shift();
      if (!frame) break;
      this.handler?.(frame.bytes);
    }
  }
}

const PHASE_NAME: Record<number, string> = {
  [CastPhaseValue.Turning]: 'turning',
  [CastPhaseValue.Windup]: 'windup',
  [CastPhaseValue.Channel]: 'channel',
};

function flag(name: string, fallback: string): string {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

/**
 * A character built to attack fast, through the real derivation: dexterity
 * feeds `attackSpeed`, the finesse skills shorten the interval flatly, and the
 * weighted stars carry both a haste modifier and the star as its basic attack.
 */
function fastCharacter(dexterity: number, skilled: boolean): PersistedPlayer {
  return {
    id: 'probe',
    displayName: 'probe',
    baseStats: { strength: 5, dexterity, intelligence: 5, vitality: 5 },
    skills: skilled
      ? [
          { skillId: 'finesse.precision', level: 5 },
          { skillId: 'finesse.footwork', level: 1 },
          { skillId: 'finesse.slipstream', level: 1 },
          { skillId: 'finesse.flurry', level: 1 },
        ]
      : [],
    equipment: { ...EMPTY_EQUIPMENT, mainHand: 'stars.weighted' },
    inventory: emptyInventory(),
    position: { ...DEFAULT_SPAWN },
    facing: 0,
    currentZone: 'hub',
    level: 20,
    experience: 0,
    unspentSkillPoints: 0,
    health: 100,
    resource: 10,
  };
}

async function main(): Promise<void> {
  const abilityId = flag('ability', 'ranged.star');
  const ticks = Number(flag('ticks', '240'));
  const delayTicks = Number(flag('delay', '0'));
  const quiet = process.argv.includes('--quiet');
  const fast = process.argv.includes('--fast');
  const turn = process.argv.includes('--turn');
  const dexterity = Number(flag('dex', fast ? '20' : '5'));
  const ability = abilityById(abilityId);
  if (!ability) throw new Error(`no such ability: ${abilityId}`);

  // Always seeded, so the numbers in the header are the ones the server is
  // actually deriving. Leaving the store empty gives the default starter
  // character instead, and then the reported interval describes a build nobody
  // in this run is playing.
  const store = new MemoryDataStore();
  const character = fastCharacter(dexterity, fast);
  await store.savePlayer(character);
  const stats = computeEffectiveStats(character);

  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 7,
    transport,
    store,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  // No monsters: this is about the bar, and a grazer wandering into the line
  // would only add noise to it.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const line = new DelayLine(transport.connect(), delayTicks);
  const client = new GameClient(line, {
    playerId: 'probe',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: createWorldColliders([], []),
        terrain: FLAT_TERRAIN,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  void client.connect();

  // A basic attack's cadence comes from the caster's stats, never from the
  // ability's own `cooldownTicks` -- `cooldownTicksFor` says so. So this, not
  // the table, is the number that decides whether two casts touch.
  const interval = ability.basicAttack ? stats.attackDelayTicks : ability.cooldownTicks;
  console.log(
    `# ${ability.name} (${ability.id}): windup ${ability.windupTicks}t, ` +
      `interval ${interval}t (attack delay ${stats.attackDelayTicks}t), ` +
      `delay ${delayTicks}t`,
  );
  if (interval <= ability.windupTicks) {
    console.log(
      `# the interval is not longer than the wind-up: casts are back to back, ` +
        `with no gap between one release and the next commit`,
    );
  }
  if (!quiet) console.log('# tick  est  phase    release  progress  bar');

  let previous: { progress: number; releaseTick: number; phase: number } | null = null;
  let shots = 0;
  const jumps: string[] = [];
  const regressions: string[] = [];

  /**
   * One press's worth of bar, so the summary can talk about *a wind-up* rather
   * than about ticks. Segmented on the press, because the gate lets exactly one
   * through per cast -- there is no need to guess where one ends from the
   * numbers, which is the guess that would make the report circular.
   */
  interface Segment {
    readonly pressedAt: number;
    readonly samples: number[];
  }
  const segments: Segment[] = [];
  let segment: Segment | null = null;

  for (let tick = 1; tick <= ticks; tick++) {
    line.deliver(tick);
    await settle();
    line.deliver(tick);
    await settle();

    server.tick();
    client.advanceTick();

    const view = client.view();
    const me = view.self;
    if (!me) continue;

    // The auto-attack gate from `target.ts`, with a fixed point for an aim: not
    // rooted, nothing in flight, cooldown up. Standing still and shooting a spot
    // a hundred units away, as fast as the ability allows.
    const ready = view.estimatedTick >= (view.cooldowns[abilityId] ?? 0);
    if (!view.selfRoot && !view.awaitingCast && ready) {
      // `--turn` swings the aim round between shots, which is what a target that
      // moves does: the body is no longer facing where the next blow is going,
      // so every cast opens in the turning phase and has its wind-up re-stamped
      // at alignment rather than starting on the commit tick.
      const angle = turn ? shots * 1.1 : 0;
      client.useAbility(abilityId, me.x + Math.cos(angle) * 100, me.y + Math.sin(angle) * 100);
      shots += 1;
      segment = { pressedAt: tick, samples: [] };
      segments.push(segment);
    }
    client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });

    const after = client.view();
    const cast = after.casts.find((c) => c.entityId === after.selfEntityId);
    if (!cast) {
      previous = null;
      continue;
    }

    // Looked up off the cast exactly as `hud.ts` does, rather than using the
    // ability this probe asked for: a miss there would silently divide by one
    // tick instead of twelve, and a bar that fills in a single frame is the
    // first thing worth ruling out.
    const drawn = abilityById(cast.abilityId);
    if (!drawn) console.log(`# !! no ability for cast id ${JSON.stringify(cast.abilityId)}`);
    const bar = castBar(cast, after.estimatedTick, drawn);
    if (segment && cast.phase === CastPhaseValue.Windup) segment.samples.push(bar.progress);
    const filled = Math.round(bar.progress * 20);
    const row =
      `${String(tick).padStart(5)} ${String(after.estimatedTick).padStart(5)} ` +
      `${(PHASE_NAME[cast.phase] ?? String(cast.phase)).padEnd(8)} ` +
      `${String(cast.releaseTick).padStart(7)} ${bar.progress.toFixed(3).padStart(8)}  ` +
      `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}]`;

    // A wind-up is `windupTicks` long, so one tick of it is 1/windupTicks of the
    // bar. Anything appreciably past that is the bar moving faster than the
    // clock -- the thing being complained about.
    const step = 1 / Math.max(1, ability.windupTicks);
    let note = '';
    // Only compared within one wind-up. A press starts a fresh bar at zero, and
    // calling that "went backwards" would report the normal case as the bug.
    const sameCast = segment !== null && segment.pressedAt !== tick;
    if (
      sameCast &&
      previous &&
      cast.phase === CastPhaseValue.Windup &&
      previous.phase === CastPhaseValue.Windup
    ) {
      const delta = bar.progress - previous.progress;
      if (delta > step * 1.5 && previous.progress < 1) {
        note = `  <-- jumped ${(delta / step).toFixed(1)}x one tick's worth`;
        jumps.push(row + note);
      }
      if (delta < -1e-9) {
        note = `  <-- went backwards ${(-delta).toFixed(3)}`;
        regressions.push(row + note);
      }
      if (cast.releaseTick !== previous.releaseTick) {
        note += `  <-- release re-stamped ${previous.releaseTick} -> ${cast.releaseTick}`;
      }
    }

    if (!quiet) console.log(row + note);
    previous = { progress: bar.progress, releaseTick: cast.releaseTick, phase: cast.phase };
  }

  // One line per wind-up. `held` is ticks the bar sat at 0 before it started
  // moving, `pinned` is ticks it sat full before the blow, and `moving` is what
  // is left -- the ticks it was actually filling. A wind-up is `windupTicks`
  // long, so `moving` short of that is the bar covering the whole range in less
  // time than the wind-up takes: the rate the player is complaining about.
  const step = 1 / Math.max(1, ability.windupTicks);
  console.log(
    `\n# per wind-up, ${segments.length} of them. The wind-up is ${ability.windupTicks}t long, so`,
  );
  console.log(
    `# a bar that is honest fills over ${ability.windupTicks} ticks at 1.00x and is gone at the release.`,
  );
  console.log('#   press  drawn  held@0  moving  pinned@1  fastest step  rate vs clock');
  const rates: number[] = [];
  for (const seg of segments) {
    const s = seg.samples;
    if (s.length === 0) continue;
    let held = 0;
    while (held < s.length && (s[held] ?? 0) <= 0) held += 1;
    let pinned = 0;
    while (pinned < s.length - held && (s[s.length - 1 - pinned] ?? 0) >= 1) pinned += 1;
    const moving = s.length - held - pinned;
    // The span the bar covered while it was moving, over the ticks it took.
    const covered = (s[s.length - pinned - 1] ?? 0) - (s[Math.max(0, held - 1)] ?? 0);
    const rate = moving > 0 ? covered / moving / step : 0;
    let fastest = 0;
    for (let i = 1; i < s.length; i++) fastest = Math.max(fastest, (s[i] ?? 0) - (s[i - 1] ?? 0));
    if (moving > 0) rates.push(rate);
    console.log(
      `# ${String(seg.pressedAt).padStart(7)} ${String(s.length).padStart(6)} ` +
        `${String(held).padStart(7)} ${String(moving).padStart(7)} ${String(pinned).padStart(9)} ` +
        `${(fastest / step).toFixed(2).padStart(13)}x ${rate.toFixed(2).padStart(14)}x`,
    );
  }
  const worst = rates.length > 0 ? Math.max(...rates) : 0;
  const mean = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

  // How often a blow actually goes off, against how often it could. The floor is
  // the wind-up when the interval is shorter than it: a cast is over at its
  // release, so the next one may commit on the very next tick.
  const spacings: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    spacings.push((segments[i]?.pressedAt ?? 0) - (segments[i - 1]?.pressedAt ?? 0));
  }
  const floor = Math.max(interval, ability.windupTicks);
  if (spacings.length > 0) {
    const sorted = [...spacings].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    console.log(
      `\n# cadence: ${median}t between commits, against a floor of ${floor}t ` +
        `(interval ${interval}t, wind-up ${ability.windupTicks}t)` +
        (median > floor ? ` -- ${median - floor}t slower than the stats allow` : ''),
    );
  }

  console.log(`\n# ${shots} requests over ${ticks} ticks`);
  console.log(`# ${jumps.length} ticks where the bar ran faster than the clock`);
  console.log(`# ${regressions.length} ticks where the bar ran backwards`);
  console.log(`# fill rate while moving: mean ${mean.toFixed(2)}x, worst ${worst.toFixed(2)}x`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
