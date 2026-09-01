/**
 * Where `alreadyCasting` actually comes from in an ordinary fight.
 *
 * A real server, a real `GameClient` over a wire with a delay, and `view.ts`'s
 * own loop: `autoAttack` decides the swings, `startAim` decides the presses, and
 * every refusal the server sends back is counted by reason -- with the phase the
 * caster's *own* cast was in at the moment the press was made.
 *
 * The two halves are the point, and they have to be run together. The standing
 * attack order is gated on `rooted`, `pending` and `staggered`, so on its own it
 * is clean and `auto-attack-wire.test.ts` asserts as much. `startAim` is gated on
 * the cooldown and on nothing else, so a self-cast pressed during a swing goes
 * out and is refused -- which is invisible to a harness that only swings.
 *
 *   npx tsx scripts/probe-already-casting.ts             # both halves
 *   npx tsx scripts/probe-already-casting.ts --no-press  # swings only
 *
 * The flask is the press because it is the one self-cast every character
 * carries: `self.hearthdraught` is `targeting: 'self'`, so `aimGesture` is
 * `'none'` and the press *is* the commitment.
 */
import { createWorldColliders } from '../src/sim/collision.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../src/server/config.js';
import { abilityById } from '../src/server/data/abilities.js';
import { LoopbackTransport } from '../src/server/net/transport-loop.js';
import { UnreliableChannel, PERFECT_WIRE } from '../src/server/net/unreliable.js';
import { Rng } from '../src/shared/prng.js';
import { GameServer } from '../src/server/server.js';
import { turnToward } from '../src/server/sim/movement.js';
import { facesAim } from '../src/server/sim/abilities.js';
import { CastPhase, type ServerEntity } from '../src/server/sim/types.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { GameClient } from '../src/server/client/game-client.js';
import { createWorldPredictor } from '../src/server/client/prediction.js';
import { moveIntent } from '../src/render/iso3d/world/intent.js';
import { autoAttack } from '../src/render/iso3d/world/target.js';
import { startAim } from '../src/render/iso3d/world/aim.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The ability a press asks for. Everyone has it, and it casts on the press. */
const FLASK = 'self.hearthdraught';

/** Ticks between presses. Slower than the flask's own cooldown, so the ones it
 *  refuses locally are the honest refusals rather than the interesting ones. */
const PRESS_EVERY = 90;

/** Long enough to hold a dozen swings at every cadence in the table. */
const RUN_TICKS = 1200;

const PHASE_NAMES: Readonly<Record<number, string>> = {
  [CastPhase.Windup]: 'windup',
  [CastPhase.Channel]: 'channel',
  [CastPhase.Backswing]: 'backswing',
  [CastPhase.Turning]: 'turning',
};

interface Fought {
  /** Swings the standing order asked for. */
  readonly asks: number;
  /** Presses that reached the wire. */
  readonly presses: number;
  /** Presses `startAim` refused here, which cost nothing. */
  readonly refusedLocally: number;
  /** What the body's own cast was doing as each press was made. */
  readonly pressedDuring: Record<string, number>;
  /** Everything the server sent back, by reason. */
  readonly rejects: Record<string, number>;
}

async function play(options: {
  readonly weapon: string | null;
  readonly delayTicks: number;
  readonly press: boolean;
}): Promise<Fought> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 11,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const line = new UnreliableChannel(
    transport.connect(),
    () => ({ ...PERFECT_WIRE, delayTicks: options.delayTicks }),
    Rng.fromSeed(1),
  );
  const client = new GameClient(line, {
    playerId: 'you',
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

  const rejects: Record<string, number> = {};
  client.onCastRejected((_id, reason) => {
    rejects[reason] = (rejects[reason] ?? 0) + 1;
  });

  const pressedDuring: Record<string, number> = {};
  let targetId: number | null = null;
  let facing = 0;
  let asks = 0;
  let presses = 0;
  let refusedLocally = 0;

  for (let ticks = 1; ticks <= RUN_TICKS; ticks++) {
    line.deliver(ticks);
    server.tick();
    client.advanceTick();

    const view = client.view();
    if (view.self && view.stats) {
      const live = server.world.entities as Map<number, ServerEntity>;

      if (targetId === null) {
        // The equip is a round trip: wait for the stat block to name the swing
        // the switch was clicked for, or the body is fought bare-handed.
        if (options.weapon) client.equip('mainHand', options.weapon);
        const self = live.get(view.selfEntityId);
        const armed =
          view.stats.basicAttackId !== '' &&
          (!options.weapon || view.stats.basicAttackId !== 'melee.slash');
        if (self && armed) {
          server.spawnEntities('stalker', self.position.x + 300, self.position.y, 1);
          targetId = [...live.values()].find((e) => e.id !== view.selfEntityId)?.id ?? null;
        }
      } else {
        // Both sides immortal: this is about the cadence, not about dying.
        const me = live.get(view.selfEntityId);
        if (me) live.set(view.selfEntityId, { ...me, health: me.stats.maxHealth });
        const mob = live.get(targetId);
        if (mob) live.set(targetId, { ...mob, health: mob.stats.maxHealth });

        const swingId = view.stats.basicAttackId || 'melee.slash';
        const swing = abilityById(swingId);
        const entity = view.entities.find((e) => e.id === targetId);
        const radius = mob?.radius ?? 22;
        const decision = autoAttack({
          self: view.self,
          selfHealth: view.entities.find((e) => e.id === view.selfEntityId)?.health ?? 1,
          target: entity
            ? { id: entity.id, x: entity.x, y: entity.y, radius, health: entity.health }
            : null,
          range: swing?.range ?? 0,
          rooted: view.selfRoot !== null,
          staggered: view.selfStaggered,
          pending: view.awaitingCast,
          readyAtTick: view.cooldowns[swingId] ?? 0,
          aligned: !entity ? true : facesAim(view.self, facing, { x: entity.x, y: entity.y }),
          tick: view.estimatedTick,
        });
        if (decision.attack && entity) {
          asks += 1;
          client.useAbility(swingId, entity.x, entity.y, entity.id, radius);
        }

        // `pressAbility` verbatim: `startAim` gates on the cooldown and on
        // nothing else, and a `'none'` gesture goes straight to `castNow`.
        const flask = abilityById(FLASK);
        if (options.press && flask && ticks % PRESS_EVERY === 0) {
          const start = startAim(flask, {
            readyAtTick: view.cooldowns[flask.id] ?? 0,
            tick: view.estimatedTick,
          });
          if (start.kind === 'cast') {
            presses += 1;
            const own = live.get(view.selfEntityId)?.cast ?? null;
            const during = own ? (PHASE_NAMES[own.phase] ?? String(own.phase)) : 'idle';
            pressedDuring[during] = (pressedDuring[during] ?? 0) + 1;
            client.useAbility(flask.id, view.self.x, view.self.y, 0);
          } else {
            refusedLocally += 1;
          }
        }

        const intent = moveIntent({
          held: new Set<string>(),
          self: view.self,
          destination: decision.chaseTo,
          route: null,
          facing,
          castAim: view.selfRoot,
          targetAim: entity ? { x: entity.x, y: entity.y } : null,
        });
        facing = turnToward(facing, intent.facing, view.stats.turnRate, SERVER_TICK_RATE);
        client.sendInput({
          moveX: intent.moveX,
          moveY: intent.moveY,
          facing: intent.facing,
          buttons: 0,
        });
      }
    }
    await settle();
  }

  client.disconnect();
  return { asks, presses, refusedLocally, pressedDuring, rejects };
}

/** The three basic attacks a starter bag can actually hold. */
const WEAPONS: readonly (string | null)[] = [null, 'bow.hunting', 'stars.weighted'];

/** Nothing, a broadcast interval, a fair connection, a bad one. */
const DELAYS: readonly number[] = [0, 3, 6, 12];

const press = !process.argv.includes('--no-press');
console.log(press ? 'swinging and pressing the flask' : 'swinging only');
for (const weapon of WEAPONS) {
  for (const delayTicks of DELAYS) {
    const out = await play({ weapon, delayTicks, press });
    const label = `${weapon ?? 'bare hands'} @ ${delayTicks}t`;
    console.log(
      `${label.padEnd(24)} swings=${String(out.asks).padStart(2)}` +
        ` presses=${String(out.presses).padStart(2)}` +
        ` refusedHere=${String(out.refusedLocally).padStart(2)}` +
        ` pressedDuring=${JSON.stringify(out.pressedDuring).padEnd(46)}` +
        ` rejects=${JSON.stringify(out.rejects)}`,
    );
  }
}
