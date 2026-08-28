/**
 * What the animation does *between* two shots (spec 167).
 *
 *   npx tsx scripts/probe-shot-loop.ts [--ability=ranged.shot] [--ticks=260]
 *
 * A report of a jerk between repeated bow shots, and nothing in the suite could
 * see it: every test about the draw asks what happens *inside* one shot. The
 * seam is between them, and it only exists when a body attacks again straight
 * away -- which is the ordinary case and the one nothing drove.
 *
 * So this drives a real server and a real `GameClient`, shoots on a loop, and
 * builds `UnitFacts` per tick exactly the way `scene.ts` does -- then prints the
 * clips the machine is actually blending, tick by tick. A detour through a state
 * nobody asked for shows up as a third clip appearing in the mix for a few ticks
 * and going again.
 *
 * It reports two things. The clips and weights, which is what
 * `UnitRig.applyPoses` is handed and where this class of fault lives; and the
 * **pose itself**, blended off the real committed `.glb`s the same way the
 * mixer blends it, as the largest angle any one bone turned between two ticks.
 * The second is the one that settles an argument: a mix that looks tidy can
 * still jerk if the clip time under it jumps, and a body's worst per-tick bone
 * movement is exactly what "a jerk frame" means.
 */

import { SERVER_PLAYER_RADIUS } from '../src/server/config.js';
import { GameClient } from '../src/server/client/game-client.js';
import { createWorldPredictor } from '../src/server/client/prediction.js';
import { LoopbackTransport } from '../src/server/net/transport-loop.js';
import { GameServer } from '../src/server/server.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { createWorldColliders } from '../src/sim/collision.js';
import { loadUnitBundle } from '../src/units/bundle.js';
import { UnitMachine } from '../src/units/machine.js';
import { driveUnit, type UnitFacts } from '../src/render/iso3d/world/unit-driver.js';
import { clipDurationOf, clipPoseAt } from '../src/units/clip-sample.js';
import { readNodeTree, splitGlb, type GlbBinary, type GlbReadNode } from '../src/units/glb-read.js';
import type { PoseRotations } from '../src/units/skin.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');
const FAMILY_DIR = join(repoRoot, 'assets', 'units');

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function flag(name: string, fallback: string): string {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const ABILITY = flag('ability', 'ranged.shot');
const WEAPON = flag('weapon', ABILITY === 'ranged.shot' ? 'bow.hunting' : 'sword.worn');
const TICKS = Number(flag('ticks', '260'));

interface Frame {
  readonly tick: number;
  readonly phase: string;
  readonly left: number | null;
  readonly state: string;
  readonly from: string | null;
  readonly blend: number;
  /** The clips being sampled, weight-sorted, as `clip:weight`. */
  readonly mix: string;
  /** The largest angle any bone turned since the tick before, in degrees. */
  readonly jerk: number;
}

type Quat = [number, number, number, number];

/** The committed clips, decoded once, so a pose can be sampled off the bytes. */
function loadClips(ids: readonly string[]): Map<string, { glb: GlbBinary; nodes: readonly GlbReadNode[]; seconds: number }> {
  const out = new Map<string, { glb: GlbBinary; nodes: readonly GlbReadNode[]; seconds: number }>();
  for (const id of ids) {
    const glb = splitGlb(new Uint8Array(readFileSync(join(FAMILY_DIR, 'clips', `${id}.glb`))));
    out.set(id, { glb, nodes: readNodeTree(glb), seconds: clipDurationOf(glb) });
  }
  return out;
}

/**
 * The blended pose, the way a mixer blends it: a weighted average per bone.
 *
 * Nlerp rather than a chain of slerps, with the signs aligned against the
 * heaviest sample first, because that is what three's additive weighting
 * amounts to for small blends and this is measuring a *difference* rather than
 * reproducing a frame exactly.
 */
function blendedPose(
  samples: readonly { clipId: string; normalizedTime: number; weight: number }[],
  clips: ReturnType<typeof loadClips>,
): Map<string, Quat> {
  const sums = new Map<string, Quat>();
  const ordered = [...samples].sort((a, b) => b.weight - a.weight);
  for (const sample of ordered) {
    const clip = clips.get(sample.clipId);
    if (!clip) continue;
    const pose: PoseRotations = clipPoseAt(clip.glb, clip.nodes, sample.normalizedTime * clip.seconds);
    for (const [bone, quat] of pose) {
      const found = sums.get(bone);
      if (!found) {
        sums.set(bone, [quat[0] * sample.weight, quat[1] * sample.weight, quat[2] * sample.weight, quat[3] * sample.weight]);
        continue;
      }
      // Shortest arc: a quaternion and its negation are the same rotation, and
      // averaging them without aligning cancels the pose to nothing.
      const sign = found[0] * quat[0] + found[1] * quat[1] + found[2] * quat[2] + found[3] * quat[3] < 0 ? -1 : 1;
      found[0] += quat[0] * sample.weight * sign;
      found[1] += quat[1] * sample.weight * sign;
      found[2] += quat[2] * sample.weight * sign;
      found[3] += quat[3] * sample.weight * sign;
    }
  }
  for (const [bone, quat] of sums) {
    const length = Math.hypot(...quat) || 1;
    sums.set(bone, [quat[0] / length, quat[1] / length, quat[2] / length, quat[3] / length]);
  }
  return sums;
}

/** The largest angle any bone turned between two poses, in degrees. */
function worstTurn(a: Map<string, Quat>, b: Map<string, Quat>): number {
  let worst = 0;
  for (const [bone, from] of a) {
    const to = b.get(bone);
    if (!to) continue;
    const dot = Math.abs(from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3]);
    worst = Math.max(worst, (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
  }
  return worst;
}

async function main(): Promise<void> {
  const bundle = loadUnitBundle(
    JSON.parse(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.unitdef.json'), 'utf8')),
    JSON.parse(readFileSync(join(FAMILY_DIR, 'biped.core.cliplib.json'), 'utf8')),
  );
  if (!bundle.value) throw new Error('the pig unit does not validate');
  const machine = new UnitMachine({ unit: bundle.value.unit, clipLib: bundle.value.clipLib, entryStateId: 'idle' });

  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 11,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), {
    playerId: 'archer',
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

  const clips = loadClips(['idle', 'walk', 'run', 'shoot', 'slash']);
  const frames: Frame[] = [];
  let previous: UnitFacts | null = null;
  let equipped = false;
  let lastPose: Map<string, Quat> | null = null;

  for (let tick = 0; tick < TICKS; tick += 1) {
    server.tick();
    client.advanceTick();
    await settle();

    const view = client.view();
    if (!view.self || !view.stats) continue;
    if (!equipped) {
      client.equip('mainHand', WEAPON);
      equipped = true;
      continue;
    }

    // Shoot again the moment there is nothing live, which is what a standing
    // attack order does. Aimed at a fixed point so nothing about this depends
    // on a body being alive to shoot at.
    const live = view.casts.find((cast) => cast.entityId === view.selfEntityId);
    if (!live) client.useAbility(ABILITY, view.self.x + 200, view.self.y);

    const cast = client.view().casts.find((entry) => entry.entityId === client.view().selfEntityId);
    const facts: UnitFacts = {
      speed: 0,
      activity: client.view().entities.find((entity) => entity.id === client.view().selfEntityId)?.activity ?? 0,
      castPhase: cast?.phase ?? null,
      attackRate: 1,
      abilityId: cast?.abilityId ?? null,
      castTicksLeft: cast === undefined ? null : cast.endTick - client.view().tick,
      dead: false,
    };
    driveUnit(machine, facts, previous, 1);
    previous = facts;

    const snapshot = machine.snapshot();
    const mix = [...machine.poses()]
      .sort((a, b) => b.weight - a.weight)
      .map((sample) => `${sample.clipId}:${sample.weight.toFixed(2)}`)
      .join(' ');
    const pose = blendedPose(machine.poses(), clips);
    const jerk = lastPose === null ? 0 : worstTurn(lastPose, pose);
    lastPose = pose;
    frames.push({
      tick,
      phase: cast === undefined ? '-' : String(cast.phase),
      left: cast === undefined ? null : cast.endTick - client.view().tick,
      state: snapshot.stateId,
      from: snapshot.previousStateId,
      blend: snapshot.blend,
      mix,
      jerk,
    });
  }

  console.log(`\n  ${ABILITY} with ${WEAPON}, ${frames.length} ticks driven\n`);
  console.log('   tick  phase  left   state       <- from        blend   jerk  clips being blended');
  let lastMix = '';
  for (const frame of frames) {
    // Only the ticks where the mix *changes*, or this is 260 lines of the same
    // clip at weight 1 and the seam is buried in it.
    if (frame.mix === lastMix) continue;
    lastMix = frame.mix;
    console.log(
      `  ${String(frame.tick).padStart(5)}  ${frame.phase.padStart(5)}  ${String(frame.left ?? '-').padStart(4)}  ` +
        `${frame.state.padEnd(11)} ${(frame.from ?? '').padEnd(13)} ${frame.blend.toFixed(2)}  ${frame.jerk.toFixed(1).padStart(5)}  ${frame.mix}`,
    );
  }

  // The finding, stated as a count rather than left to the reader: how many
  // times the machine visited a state that is not the attack, between attacks.
  const visits: string[] = [];
  let last = '';
  for (const frame of frames) {
    if (frame.state !== last) {
      visits.push(frame.state);
      last = frame.state;
    }
  }
  console.log(`\n  states, in order: ${visits.join(' -> ')}`);

  // The number the whole probe is for. A steady clip turns a bone a few degrees
  // a tick; a seam turns one a lot in one tick, and that is the frame a player
  // reports as a jerk.
  const ranked = [...frames].sort((a, b) => b.jerk - a.jerk).slice(0, 6);
  const median = [...frames].map((frame) => frame.jerk).sort((a, b) => a - b)[Math.floor(frames.length / 2)] ?? 0;
  console.log(`\n  worst per-tick bone turn: ${ranked[0]?.jerk.toFixed(1) ?? '-'} degrees (median ${median.toFixed(1)})`);
  for (const frame of ranked) {
    console.log(`    tick ${String(frame.tick).padStart(4)}  ${frame.jerk.toFixed(1).padStart(6)} deg   ${frame.mix}`);
  }
}

void main();
