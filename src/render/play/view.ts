/**
 * The play view (spec 062): a deliberately plain top-down canvas, driven
 * entirely by {@link GameClient}.
 *
 * This is not the iso3d renderer. Repointing that at the server is spec 057's
 * stage 3 and a much larger job; this exists so the new combat is *playable and
 * testable now* -- you can watch a wind-up, cancel it, and see a projectile arc
 * land -- without waiting for the art path.
 *
 * It holds the sim/render line the same way the old renderer did: every number
 * it draws came off the wire, and there is no `if` in here that changes a game
 * outcome. It asks for abilities and draws what the server says happened.
 *
 * By default it boots a server *in this tab* over a loopback transport, which
 * is what spec 057 says single-player is. Point it at a real socket instead and
 * nothing about the code below changes -- that is the whole reason the transport
 * is an interface.
 */

import { GameClient } from '../../server/client/game-client.js';
import { LoopbackTransport } from '../../server/net/transport-loop.js';
import { GameServer } from '../../server/server.js';
import { SERVER_TICK_RATE } from '../../server/config.js';
import { ALL_ABILITIES, abilityById } from '../../server/data/abilities.js';
import { CastPhaseValue, EntityKind } from '../../server/net/protocol.js';
import type { ViewHandle } from '../iso3d/view-handle.js';

/** Which abilities the hotbar offers, in order. Keys 1..n. */
const HOTBAR: readonly string[] = [
  'melee.slash',
  'melee.heavy',
  'bolt.arcane',
  'bolt.lob',
  'ground.quake',
  'self.mend',
  'channel.drain',
];

/** World units per screen pixel at rest. */
const ZOOM = 0.55;

interface FloatingNumber {
  x: number;
  y: number;
  text: string;
  age: number;
  crit: boolean;
  heal: boolean;
}

interface LiveEffect {
  x: number;
  y: number;
  radius: number;
  age: number;
  ttl: number;
}

export function mountPlay(container: HTMLElement): ViewHandle {
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:#0d1014';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair';
  root.append(canvas);

  const hud = document.createElement('div');
  hud.style.cssText =
    'position:absolute;left:12px;top:52px;font:12px ui-monospace,Menlo,monospace;color:#cfd6e0;' +
    'background:rgba(10,14,20,.72);padding:8px 10px;border-radius:6px;pointer-events:none;line-height:1.6';
  root.append(hud);

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:6px;' +
    'font:11px ui-monospace,Menlo,monospace';
  root.append(bar);

  const slots = HOTBAR.map((abilityId, index) => {
    const button = document.createElement('button');
    button.style.cssText =
      'width:96px;padding:6px 4px;border-radius:6px;border:1px solid #33405a;background:#182130;' +
      'color:#cfd6e0;cursor:pointer;font:inherit;text-align:center';
    button.innerHTML = `<b>${index + 1}</b><br>${abilityById(abilityId)?.name ?? abilityId}`;
    bar.append(button);
    return { abilityId, button };
  });

  // --- the server this view talks to ----------------------------------
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 7, transport });
  // Wired by hand rather than through `server.start()`: that would also spin up
  // the server's own clock, and this view already drives the tick from its
  // animation frame. Registering the handler is the half we want.
  transport.onConnection((channel) => server.accept(channel));
  // A calmer field than the default: this view exists to read one wind-up and
  // one projectile clearly, and the ambient spawner at full rate buries both.
  server.liveConfig.set('spawnRateMultiplier', 0.15);
  const client = new GameClient(transport.connect(), { playerId: 'you', displayName: 'You' });

  const numbers: FloatingNumber[] = [];
  const effects: LiveEffect[] = [];
  let notice = '';
  let noticeAge = 0;

  client.onCombatResult((result) => {
    const target = client.view().entities.find((entity) => entity.id === result.targetId);
    if (!target) return;
    const heal = result.damage < 0;
    numbers.push({
      x: target.x,
      y: target.y,
      text: (heal ? '+' : '') + Math.round(Math.abs(result.damage)).toString(),
      age: 0,
      crit: (result.flags & 2) !== 0,
      heal,
    });
  });

  client.onEffect((effect) => {
    effects.push({ x: effect.x, y: effect.y, radius: effect.radius, age: 0, ttl: effect.durationTicks });
  });

  client.onCastRejected((abilityId, reason) => {
    notice = `${abilityById(abilityId)?.name ?? abilityId}: ${reason}`;
    noticeAge = 0;
  });

  // --- input ------------------------------------------------------------
  const held = new Set<string>();
  let cursorX = 0;
  let cursorY = 0;

  const onKeyDown = (event: KeyboardEvent): void => {
    held.add(event.code);
    const slot = HOTBAR[Number(event.key) - 1];
    if (slot) {
      client.useAbility(slot, worldCursor().x, worldCursor().y);
      event.preventDefault();
    }
    if (event.code === 'Escape') client.cancelCast();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    held.delete(event.code);
  };
  const onMove = (event: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    cursorX = event.clientX - rect.left;
    cursorY = event.clientY - rect.top;
  };
  const onClick = (event: MouseEvent): void => {
    const first = HOTBAR[0];
    if (event.button === 0 && first) client.useAbility(first, worldCursor().x, worldCursor().y);
    if (event.button === 2) client.cancelCast();
  };
  const onContext = (event: Event): void => event.preventDefault();

  function selfPosition(): { x: number; y: number } {
    return client.view().self ?? { x: 0, y: 0 };
  }

  /** Screen pixels to world units, around whatever the player is standing on. */
  function worldCursor(): { x: number; y: number } {
    const me = selfPosition();
    return {
      x: me.x + (cursorX - canvas.width / 2) / ZOOM,
      y: me.y + (cursorY - canvas.height / 2) / ZOOM,
    };
  }

  // --- loop -------------------------------------------------------------
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  const tickMs = 1000 / SERVER_TICK_RATE;

  function sendInput(): void {
    let moveX = 0;
    let moveY = 0;
    if (held.has('KeyW')) moveY -= 1;
    if (held.has('KeyS')) moveY += 1;
    if (held.has('KeyA')) moveX -= 1;
    if (held.has('KeyD')) moveX += 1;
    const aim = worldCursor();
    const me = selfPosition();
    client.sendInput({
      moveX,
      moveY,
      facing: Math.atan2(aim.y - me.y, aim.x - me.x),
      buttons: 0,
    });
  }

  function frame(now: number): void {
    if (last !== 0) accumulator = Math.min(accumulator + (now - last), tickMs * 10);
    last = now;
    while (accumulator >= tickMs) {
      accumulator -= tickMs;
      // The in-tab server advances on the same fixed step it would over a wire;
      // this view just happens to be the thing driving its clock.
      server.tick();
      sendInput();
    }
    draw();
    raf = requestAnimationFrame(frame);
  }

  function draw(): void {
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const view = client.view();
    const me = selfPosition();
    context.fillStyle = '#0d1014';
    context.fillRect(0, 0, width, height);

    const toScreenX = (x: number): number => width / 2 + (x - me.x) * ZOOM;
    const toScreenY = (y: number): number => height / 2 + (y - me.y) * ZOOM;

    // A grid, so movement is legible without any art.
    context.strokeStyle = '#161c26';
    context.lineWidth = 1;
    const grid = 100;
    for (let gx = Math.floor((me.x - width / ZOOM) / grid) * grid; gx < me.x + width / ZOOM; gx += grid) {
      context.beginPath();
      context.moveTo(toScreenX(gx), 0);
      context.lineTo(toScreenX(gx), height);
      context.stroke();
    }
    for (let gy = Math.floor((me.y - height / ZOOM) / grid) * grid; gy < me.y + height / ZOOM; gy += grid) {
      context.beginPath();
      context.moveTo(0, toScreenY(gy));
      context.lineTo(width, toScreenY(gy));
      context.stroke();
    }

    // Effects fade out under everything else.
    for (const effect of effects) {
      const life = 1 - effect.age / Math.max(1, effect.ttl);
      if (life <= 0) continue;
      context.beginPath();
      context.arc(toScreenX(effect.x), toScreenY(effect.y), effect.radius * ZOOM, 0, Math.PI * 2);
      context.fillStyle = `rgba(255,170,90,${0.35 * life})`;
      context.fill();
    }

    // Telegraphs: where a wind-up is aimed, and how far through it is.
    for (const cast of view.casts) {
      const caster = view.entities.find((entity) => entity.id === cast.entityId);
      if (!caster) continue;
      const ability = abilityById(cast.abilityId);
      const total = Math.max(1, cast.releaseTick - (cast.releaseTick - (ability?.windupTicks ?? 1)));
      const progress = Math.min(1, 1 - (cast.releaseTick - view.tick) / total);
      if (ability?.radius && ability.kind === 'ground') {
        context.beginPath();
        context.arc(toScreenX(cast.targetX), toScreenY(cast.targetY), ability.radius * ZOOM, 0, Math.PI * 2);
        context.strokeStyle = 'rgba(255,120,90,.9)';
        context.lineWidth = 2;
        context.stroke();
        context.fillStyle = `rgba(255,120,90,${0.12 + 0.25 * progress})`;
        context.fill();
      }
      // A bar over the caster's head: the commitment made visible.
      const barX = toScreenX(caster.x) - 22;
      const barY = toScreenY(caster.y) - 30;
      context.fillStyle = 'rgba(0,0,0,.6)';
      context.fillRect(barX, barY, 44, 5);
      context.fillStyle = cast.phase === CastPhaseValue.Channel ? '#7fd0ff' : '#ffcf6b';
      context.fillRect(barX, barY, 44 * Math.max(0, Math.min(1, progress)), 5);
    }

    // Bodies.
    for (const entity of view.entities) {
      const screenX = toScreenX(entity.x);
      const screenY = toScreenY(entity.y);
      if (entity.kind === EntityKind.Projectile) {
        // z carries the arc, so a lobbed pot visibly rises and falls.
        context.beginPath();
        context.arc(screenX, screenY - entity.z * ZOOM, 5, 0, Math.PI * 2);
        context.fillStyle = '#ffd98a';
        context.fill();
        // Its shadow stays on the ground, which is what sells the height.
        context.beginPath();
        context.ellipse(screenX, screenY, 4, 2, 0, 0, Math.PI * 2);
        context.fillStyle = 'rgba(0,0,0,.45)';
        context.fill();
        continue;
      }

      const isMe = entity.id === view.selfEntityId;
      const dead = entity.health <= 0;
      context.beginPath();
      context.arc(screenX, screenY, (isMe ? 16 : 14) * ZOOM * 1.6, 0, Math.PI * 2);
      context.fillStyle = dead ? '#3a3f46' : isMe ? '#7fd08a' : '#d0796f';
      context.fill();

      if (!dead && entity.maxHealth > 0) {
        const fraction = Math.max(0, Math.min(1, entity.health / entity.maxHealth));
        context.fillStyle = 'rgba(0,0,0,.6)';
        context.fillRect(screenX - 18, screenY - 20, 36, 4);
        context.fillStyle = isMe ? '#7fd08a' : '#d0796f';
        context.fillRect(screenX - 18, screenY - 20, 36 * fraction, 4);
      }
    }

    // Damage numbers.
    for (const number of numbers) {
      const life = 1 - number.age / 45;
      if (life <= 0) continue;
      context.fillStyle = number.heal
        ? `rgba(140,230,150,${life})`
        : number.crit
          ? `rgba(255,220,120,${life})`
          : `rgba(240,240,240,${life})`;
      context.font = `${number.crit ? 16 : 13}px ui-monospace, Menlo, monospace`;
      context.fillText(number.text, toScreenX(number.x) - 8, toScreenY(number.y) - 34 - (1 - life) * 26);
    }

    // Age everything that fades. Presentation only -- none of it is state.
    for (const number of numbers) number.age += 1;
    for (const effect of effects) effect.age += 1;
    if (numbers.length > 64) numbers.splice(0, numbers.length - 64);
    while (effects.length > 0 && (effects[0]?.age ?? 0) > (effects[0]?.ttl ?? 0)) effects.shift();
    noticeAge += 1;

    const stats = view.stats;
    const self = view.entities.find((entity) => entity.id === view.selfEntityId);
    hud.innerHTML =
      `tick ${view.tick} &nbsp; entities ${view.entities.length}<br>` +
      `hp ${Math.round(self?.health ?? 0)}/${Math.round(stats?.maxHealth ?? 0)}<br>` +
      `corrections ${client.correctionCount}<br>` +
      `<span style="opacity:.65">WASD move &middot; mouse aim &middot; 1-${HOTBAR.length} abilities</span><br>` +
      `<span style="opacity:.65">left click = Slash &middot; Esc / right click = cancel</span>` +
      (noticeAge < 120 && notice ? `<br><span style="color:#ffa07a">${notice}</span>` : '');

    for (const slot of slots) {
      const requested = view.requestedAbilityId === slot.abilityId;
      const casting = view.casts.some(
        (cast) => cast.entityId === view.selfEntityId && cast.abilityId === slot.abilityId,
      );
      slot.button.style.borderColor = casting ? '#ffcf6b' : requested ? '#5c7ba6' : '#33405a';
    }
  }

  container.append(root);

  return {
    element: root,
    start(): void {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('mousemove', onMove);
      canvas.addEventListener('mousedown', onClick);
      canvas.addEventListener('contextmenu', onContext);
      for (const slot of slots) {
        slot.button.onclick = (): void =>
          client.useAbility(slot.abilityId, worldCursor().x, worldCursor().y);
      }

      // Something to fight, so the view is not an empty field.
      void client.connect().then(() => {
        const me = selfPosition();
        server.spawnEntities('grazer', me.x + 220, me.y - 60, 3);
        server.spawnEntities('stalker', me.x - 260, me.y + 120, 2);
      });

      last = 0;
      accumulator = 0;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onClick);
      canvas.removeEventListener('contextmenu', onContext);
    },
  };
}

/** Every ability the hotbar can show, for a panel that wants to list them. */
export const PLAYABLE_ABILITIES = ALL_ABILITIES;
