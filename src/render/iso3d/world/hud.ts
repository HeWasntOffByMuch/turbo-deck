/**
 * The overlay over the world view (spec 063): health bars, cast bars, damage
 * numbers, the hotbar and a status line.
 *
 * DOM rather than geometry, and positioned by projecting each body to a canvas
 * pixel (`WorldScene.screenAnchors`). The scene renders into a low-resolution
 * buffer and puts the result through the dither pass (spec 038), which is
 * exactly right for the world and exactly wrong for a number you are supposed to
 * read -- text through that filter comes out as chewed pixels. Floating it over
 * the canvas keeps the world chunky and the readout crisp.
 *
 * Everything here is a function of what the server said. The bars are drawn from
 * replicated health and from `CastState`; the hotbar's lit/unlit is whether a
 * cast is in progress, not whether a key is down. No `if` in this file changes
 * an outcome -- the buttons ask, and the server answers.
 */

import type { ClientView } from '../../../server/client/game-client.js';
import type { ScreenAnchor } from './scene.js';
import { abilityById, type AbilityDefinition } from '../../../server/data/abilities.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { castBar } from './cast.js';
import { appearanceOf } from './appearance.js';
import { pixelTextSvg } from './pixel-font.js';

/** How long a damage number floats, in frames. */
const NUMBER_LIFE = 48;
/** How far one rises over its life, in CSS pixels. */
const NUMBER_RISE = 46;
/**
 * Sideways lanes for numbers landing on the same body in quick succession.
 *
 * Without this they stack on one anchor, and once each carries a hard outline
 * the pile reads as a solid dark block with a couple of legible digits at the
 * bottom -- which is exactly what it looked like. Cycling lanes fans them out so
 * three hits in half a second are three numbers.
 */
const NUMBER_LANES: readonly { readonly x: number; readonly y: number }[] = [
  { x: 0, y: 0 },
  { x: -46, y: -12 },
  { x: 46, y: -12 },
  { x: -24, y: -26 },
  { x: 24, y: -26 },
];

/** Which abilities the hotbar offers, in order. Keys 1..n. */
export const HOTBAR: readonly string[] = [
  'melee.slash',
  'melee.heavy',
  'bolt.arcane',
  'bolt.lob',
  'ground.quake',
  'self.mend',
  'channel.drain',
];

interface FloatingNumber {
  readonly entityId: number;
  readonly text: string;
  readonly crit: boolean;
  readonly heal: boolean;
  age: number;
  /**
   * Offset from the body's anchor. Wider than a number is, so two in the same
   * lane cycle never touch, and stepped upward so a burst separates on the frame
   * it lands rather than after it has drifted.
   */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly element: HTMLElement;
}

interface Bar {
  readonly root: HTMLElement;
  readonly health: HTMLElement;
  readonly cast: HTMLElement;
  readonly castFill: HTMLElement;
}

export interface HudHandle {
  readonly element: HTMLElement;
  /** Called once per frame, after the scene has drawn and anchors are current. */
  update(view: ClientView, anchors: readonly ScreenAnchor[], tick: number, corrections: number): void;
  /** A hit landed on `entityId`. Presentation of something already resolved. */
  addDamage(entityId: number, damage: number, crit: boolean): void;
  /** The server refused a cast, and said why. */
  notice(text: string): void;
  /** What to call when a hotbar button is clicked. */
  onUse(handler: (abilityId: string) => void): void;
}

export function createHud(): HudHandle {
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';

  const status = document.createElement('div');
  status.style.cssText =
    'position:absolute;left:12px;top:52px;font:12px ui-monospace,Menlo,monospace;color:#cfd6e0;' +
    'background:rgba(10,14,20,.72);padding:8px 10px;border-radius:6px;line-height:1.6;white-space:pre;';
  root.append(status);

  const notices = document.createElement('div');
  notices.style.cssText =
    'position:absolute;left:50%;top:86px;transform:translateX(-50%);font:13px ui-monospace,Menlo,monospace;' +
    'color:#ffa07a;text-shadow:0 1px 2px #000;';
  root.append(notices);

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:6px;' +
    'font:11px ui-monospace,Menlo,monospace;pointer-events:auto;';
  root.append(bar);

  let useHandler: (abilityId: string) => void = () => undefined;

  const slots = HOTBAR.map((abilityId, index) => {
    const ability = abilityById(abilityId);
    const button = document.createElement('button');
    button.style.cssText =
      'width:92px;padding:6px 4px;border-radius:6px;border:1px solid #33405a;background:#182130;' +
      'color:#cfd6e0;cursor:pointer;font:inherit;text-align:center;line-height:1.5;';
    button.style.position = 'relative';
    button.style.overflow = 'hidden';
    button.innerHTML = `<b>${index + 1}</b><br>${ability?.name ?? abilityId}`;
    button.title = ability?.description ?? '';
    button.addEventListener('click', () => useHandler(abilityId));

    // The cooldown sweep: a shade that drains off the bottom as the ability
    // comes back. Drawn under the label rather than over it, so a greyed button
    // is still readable.
    const sweep = document.createElement('div');
    sweep.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;height:0;background:rgba(8,12,20,.72);' +
      'pointer-events:none;';
    button.append(sweep);

    const remaining = document.createElement('span');
    remaining.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'font:700 15px ui-monospace,Menlo,monospace;color:#e8eef6;text-shadow:0 1px 2px #000;' +
      'pointer-events:none;';
    button.append(remaining);

    bar.append(button);
    return { abilityId, ability, button, sweep, remaining };
  });

  const bars = new Map<number, Bar>();
  const numbers: FloatingNumber[] = [];
  /** How many numbers each body has been given, for lane assignment. */
  const numberCount = new Map<number, number>();
  let notice = '';
  let noticeAge = 999;

  function barFor(id: number): Bar {
    const existing = bars.get(id);
    if (existing) return existing;

    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;transform:translate(-50%,-100%);width:52px;';

    const healthTrack = document.createElement('div');
    healthTrack.style.cssText = 'height:4px;background:rgba(0,0,0,.65);border-radius:2px;overflow:hidden;';
    const health = document.createElement('div');
    health.style.cssText = 'height:100%;width:100%;background:#d0796f;';
    healthTrack.append(health);

    const cast = document.createElement('div');
    cast.style.cssText =
      'height:4px;margin-top:2px;background:rgba(0,0,0,.65);border-radius:2px;overflow:hidden;display:none;';
    const castFill = document.createElement('div');
    castFill.style.cssText = 'height:100%;width:0;background:#ffcf6b;';
    cast.append(castFill);

    holder.append(healthTrack, cast);
    root.append(holder);
    const made: Bar = { root: holder, health, cast, castFill };
    bars.set(id, made);
    return made;
  }

  function update(
    view: ClientView,
    anchors: readonly ScreenAnchor[],
    tick: number,
    corrections: number,
  ): void {
    const byId = new Map(view.entities.map((entity) => [entity.id, entity]));
    const casts = new Map(view.casts.map((cast) => [cast.entityId, cast]));
    const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
    const live = new Set<number>();

    for (const anchor of anchors) {
      const entity = byId.get(anchor.id);
      if (!entity) continue;
      const look = appearanceOf(entity);
      const cast = casts.get(anchor.id);
      const wantsBar = (look.showsHealth && entity.health > 0) || cast !== undefined;
      if (!wantsBar || !anchor.onScreen) continue;

      live.add(anchor.id);
      const element = barFor(anchor.id);
      element.root.style.left = `${anchor.x}px`;
      element.root.style.top = `${anchor.y}px`;

      const fraction = entity.maxHealth > 0 ? Math.max(0, Math.min(1, entity.health / entity.maxHealth)) : 0;
      element.health.style.width = `${fraction * 100}%`;
      element.health.style.background = entity.id === view.selfEntityId ? '#7fd08a' : '#d0796f';
      element.root.style.display = look.showsHealth ? 'block' : 'none';

      if (cast) {
        const progress = castBar(cast, tick, abilityById(cast.abilityId));
        element.cast.style.display = 'block';
        element.castFill.style.width = `${progress.progress * 100}%`;
        // Amber while it can still be called off, blue once it cannot -- the
        // one distinction the whole wind-up design rests on. A turn shows as an
        // empty track in its own colour: committed, but not yet swinging.
        element.cast.style.background = progress.turning
          ? 'rgba(120,170,220,.55)'
          : 'rgba(0,0,0,.65)';
        element.castFill.style.background = progress.cancellable ? '#ffcf6b' : '#7fd0ff';
        element.root.style.display = 'block';
      } else {
        element.cast.style.display = 'none';
      }
    }

    for (const [id, element] of bars) {
      if (live.has(id)) continue;
      element.root.remove();
      bars.delete(id);
    }

    // Damage numbers ride the body they belong to until it despawns, then hold
    // where they were rather than snapping to the origin.
    for (let i = numbers.length - 1; i >= 0; i--) {
      const number = numbers[i];
      if (!number) continue;
      number.age += 1;
      const life = 1 - number.age / NUMBER_LIFE;
      if (life <= 0) {
        number.element.remove();
        numbers.splice(i, 1);
        continue;
      }
      const anchor = anchorById.get(number.entityId);
      if (anchor) {
        number.element.style.left = `${anchor.x + number.offsetX}px`;
        number.element.style.top = `${anchor.y + number.offsetY - (1 - life) * NUMBER_RISE}px`;
      }
      number.element.style.opacity = life.toFixed(3);
    }

    noticeAge += 1;
    notices.textContent = noticeAge < 120 ? notice : '';

    for (const slot of slots) {
      const casting = view.casts.some(
        (cast) => cast.entityId === view.selfEntityId && cast.abilityId === slot.abilityId,
      );
      const requested = view.requestedAbilityId === slot.abilityId;
      slot.button.style.borderColor = casting ? '#ffcf6b' : requested ? '#5c7ba6' : '#33405a';
      slot.button.style.opacity = affordable(view, slot.ability) ? '1' : '0.45';

      // The sweep is the server's cooldown, played back (spec 065). Its *length*
      // comes from the ability table so the shade shrinks proportionally; the
      // client never decides when something is ready.
      const readyAt = view.cooldowns[slot.abilityId] ?? 0;
      const left = readyAt - tick;
      const total = Math.max(1, slot.ability?.cooldownTicks ?? 1);
      if (left > 0) {
        slot.sweep.style.height = `${Math.min(1, left / total) * 100}%`;
        slot.remaining.textContent = formatSeconds(left / SERVER_TICK_RATE);
      } else {
        slot.sweep.style.height = '0';
        slot.remaining.textContent = '';
      }
    }

    const self = view.entities.find((entity) => entity.id === view.selfEntityId);
    const stats = view.stats;
    const monsters = view.entities.filter((entity) => entity.kind === EntityKind.Monster).length;
    status.textContent =
      `tick ${view.tick}   seed ${view.worldSeed ?? '-'}\n` +
      `hp ${Math.round(self?.health ?? 0)}/${Math.round(stats?.maxHealth ?? 0)}   ` +
      `lvl ${view.level}   xp ${view.experience}\n` +
      `monsters ${monsters}   corrections ${corrections}` +
      (view.connected ? '' : '   (disconnected)') +
      '\nright-click move · left-click swing · WASD · 1-7 abilities · Esc cancel';
  }

  return {
    element: root,
    update,
    addDamage(entityId, damage, crit) {
      const heal = damage < 0;
      const text = (heal ? '+' : '') + Math.round(Math.abs(damage)).toString();
      const element = document.createElement('div');
      element.style.cssText = 'position:absolute;transform:translate(-50%,-100%);';
      // The pixel font (spec 065) rather than the browser's UI face: these float
      // over a posterized, low-resolution world, and system text over it read
      // like a debug overlay that had been left switched on.
      element.innerHTML = pixelTextSvg(text, {
        scale: crit ? 4 : 3,
        fill: heal ? '#8ce696' : crit ? '#ffdc78' : '#f4f4f4',
        outline: '#0a0d14',
      });
      root.append(element);
      const index = numberCount.get(entityId) ?? 0;
      numberCount.set(entityId, index + 1);
      const lane = NUMBER_LANES[index % NUMBER_LANES.length] ?? { x: 0, y: 0 };
      numbers.push({
        entityId,
        text,
        crit,
        heal,
        age: 0,
        offsetX: lane.x,
        offsetY: lane.y,
        element,
      });
      // A long fight should not grow the DOM without bound.
      while (numbers.length > 40) numbers.shift()?.element.remove();
    },
    notice(text) {
      notice = text;
      noticeAge = 0;
    },
    onUse(handler) {
      useHandler = handler;
    },
  };
}

/** A cooldown countdown: whole seconds while there are several, tenths at the end. */
function formatSeconds(seconds: number): string {
  if (seconds >= 10) return String(Math.ceil(seconds));
  if (seconds >= 1) return seconds.toFixed(1);
  return seconds.toFixed(1);
}

/**
 * Whether the player could pay for an ability right now. Cosmetic dimming only:
 * the server decides, and refuses a cast it will not fund whatever this said.
 *
 * Against the live pool since spec 069. It used to compare with `maxResource`,
 * which only ever answered "could this *ever* be afforded" -- the live number
 * was on the entity and had never been on the wire, so a button for a bolt the
 * player could not currently pay for looked exactly like one they could.
 */
function affordable(view: ClientView, ability: AbilityDefinition | null): boolean {
  if (!ability || !view.stats) return true;
  return ability.cost <= view.resource;
}
