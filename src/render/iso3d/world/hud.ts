/**
 * The overlay over the world view (spec 063): health bars, cast bars, damage
 * numbers, the hotbar and a status line.
 *
 * DOM rather than geometry, and positioned by projecting each body to a canvas
 * pixel (`WorldScene.screenAnchors`) -- except the damage numbers, which are
 * projected from a world point of their own (spec 096), because they belong to
 * the ground a blow landed on rather than to a body that may be walking away
 * from it or gone.
 *
 * The scene renders into a low-resolution buffer and puts the result through
 * the dither pass (spec 038), which is exactly right for the world and exactly
 * wrong for a number you are supposed to read -- text through that filter comes
 * out as chewed pixels. Floating it over the canvas keeps the world chunky and
 * the readout crisp.
 *
 * Everything here is a function of what the server said. The bars are drawn from
 * replicated health and from `CastState`; the hotbar's lit/unlit is whether a
 * cast is in progress, not whether a key is down. No `if` in this file changes
 * an outcome -- the buttons ask, and the server answers.
 */

import type { ClientView } from '../../../server/client/game-client.js';
import type { ScreenAnchor } from './scene.js';
import {
  abilityById,
  BASIC_ATTACK_ID,
  type AbilityDefinition,
} from '../../../server/data/abilities.js';
import { ALL_ITEMS } from '../../../server/data/items.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { castBar } from './cast.js';
import { aimGesture } from './aim.js';
import { appearanceOf, displayName } from './appearance.js';
import { pixelTextSvg } from './pixel-font.js';
import { isCoarsePointer } from '../fullscreen.js';
import { DamagePopups, type Projector, type WorldAnchor } from './damage-popup.js';
import { hudLayout } from './hud-layout.js';
import { weaponIconSvg } from './icons.js';

/** The slot being aimed (spec 080). The aim indicator's colour, in the DOM. */
const AIM_HIGHLIGHT = '#7fd4ff';

/** Which abilities the hotbar offers, in order. Keys 1..n. */
export const HOTBAR: readonly string[] = [
  'melee.slash',
  'melee.heavy',
  'bolt.arcane',
  'bolt.lob',
  'bolt.seek',
  'ground.quake',
  'self.mend',
  'channel.drain',
];

/**
 * One main-hand weapon per distinct auto-attack (spec 079).
 *
 * Derived from the item table rather than listed, so a crossbow added there
 * turns up here without this file being told. The *attack* is what the switch
 * is really choosing -- two swords that both slash are one entry, because
 * picking between them would change numbers and not the motion.
 */
export const WEAPON_SWITCH: readonly {
  readonly itemId: string;
  readonly name: string;
  readonly abilityId: string;
}[] = (() => {
  const byAttack = new Map<string, { itemId: string; name: string; abilityId: string }>();
  for (const item of ALL_ITEMS) {
    if (item.slot !== 'mainHand') continue;
    const abilityId = item.basicAttackId ?? BASIC_ATTACK_ID;
    if (byAttack.has(abilityId)) continue;
    byAttack.set(abilityId, { itemId: item.id, name: item.name, abilityId });
  }
  return [...byAttack.values()];
})();

interface Bar {
  readonly root: HTMLElement;
  readonly health: HTMLElement;
  readonly cast: HTMLElement;
  readonly castFill: HTMLElement;
}

export interface HudHandle {
  readonly element: HTMLElement;
  /** Called once per frame, after the scene has drawn and anchors are current. */
  update(
    view: ClientView,
    anchors: readonly ScreenAnchor[],
    tick: number,
    corrections: number,
    /** The body being attacked, or null (spec 070). Shown as a one-line readout. */
    targetId: number | null,
    /**
     * The skill being aimed and whether it is still a question (spec 080).
     * Lights the slot it came from and says what the next click will do.
     */
    aiming: { readonly abilityId: string | null; readonly pending: boolean },
  ): void;
  /**
   * A hit landed on `entityId`, at the world point `at` (spec 096).
   * Presentation of something already resolved.
   *
   * The point is taken once and kept: the number marks the ground the blow
   * landed on, so it neither walks off with a victim that survived nor follows
   * the camera once one that did not has despawned. `entityId` is only there to
   * fan a burst out into lanes.
   */
  addDamage(entityId: number, at: WorldAnchor, damage: number, crit: boolean): void;
  /** The server refused a cast, and said why. */
  notice(text: string): void;
  /**
   * Draw the spawner overlay, or clear it (spec 076).
   *
   * Handed already-projected pixels and already-worded strings: what a spawner
   * is called and where it is on screen are both decided elsewhere, so this is
   * placement and nothing else.
   */
  showSpawners(
    marks: readonly {
      readonly id: string;
      readonly text: string;
      readonly waiting: boolean;
      readonly x: number;
      readonly y: number;
      readonly onScreen: boolean;
    }[],
  ): void;
  /** What to call when a hotbar button is clicked. */
  onUse(handler: (abilityId: string) => void): void;
  /**
   * What to call when a weapon is picked out of the switch (spec 079). It hands
   * back an item id and nothing else: the server equips it, recomputes the stat
   * block and sends it back, and the lit button follows *that* rather than the
   * click.
   */
  onEquip(handler: (itemId: string) => void): void;
}

/**
 * @param project How to turn a world point into a canvas pixel --
 * `WorldScene.projectPoint`. Taken once at construction rather than per frame,
 * because it is the same function every frame; it reads the camera as it stands
 * when it is called, which is why `update` must run after the scene has drawn.
 */
export function createHud(project: Projector): HudHandle {
  // The one device question, asked once (spec 094). Everything below reads sizes
  // out of the table rather than deciding them, so what "compact" means is
  // asserted in Node instead of measured on a phone.
  const layout = hudLayout(isCoarsePointer());

  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';

  const status = document.createElement('div');
  status.style.cssText =
    'position:absolute;left:12px;top:52px;font:12px ui-monospace,Menlo,monospace;color:#cfd6e0;' +
    'background:rgba(10,14,20,.72);padding:8px 10px;border-radius:6px;line-height:1.6;white-space:pre;';
  if (!layout.showsReadout) {
    // Hidden, not removed, and still written every frame. It is developer
    // instrumentation and has no business on a 390px frame -- but it is also the
    // only clock `scripts/preview-touch.ts` has: it reads the tick and the target
    // line out of `document.body.textContent`, which includes a `display:none`
    // subtree. Deleting it would leave the touch harness unable to tell "the tap
    // did nothing" from "the frame had not run yet", which is the confusion
    // spec 093 was debugged out of.
    status.style.display = 'none';
    status.setAttribute('aria-hidden', 'true');
  }
  root.append(status);

  const notices = document.createElement('div');
  notices.style.cssText =
    'position:absolute;left:50%;transform:translateX(-50%);font:13px ui-monospace,Menlo,monospace;' +
    `color:#ffa07a;text-shadow:0 1px 2px #000;top:${layout.showsReadout ? 86 : 12}px;`;
  root.append(notices);

  // The spawner overlay lives in its own layer so clearing it is one truncation
  // rather than a walk looking for which children were spawners.
  const spawnerLayer = document.createElement('div');
  spawnerLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  root.append(spawnerLayer);
  const spawnerMarks = new Map<string, HTMLElement>();

  // Bottom edge insets are `env()` rather than a number: in landscape the home
  // indicator runs along the bottom and the notch along a side, which is exactly
  // where the hotbar and the weapon switch sit (spec 093).
  const bottom = `calc(${layout.edge}px + env(safe-area-inset-bottom))`;

  const bar = document.createElement('div');
  bar.style.cssText =
    `position:absolute;left:50%;bottom:${bottom};transform:translateX(-50%);display:flex;` +
    `gap:${layout.slotGap}px;font:${layout.slotFontPx}px ui-monospace,Menlo,monospace;pointer-events:auto;`;
  root.append(bar);

  /**
   * What the next tap does, while a skill is aimed (spec 080).
   *
   * Only built on the compact HUD, and only ever shows the aim: that line used
   * to ride along at the bottom of the readout, and the readout is the one thing
   * spec 094 takes away. It is not debug output -- it is the question on screen
   * -- so it gets its own place above the hotbar rather than going with the
   * panel. Idle, it says nothing; the world is the hint.
   */
  const aimHint = document.createElement('div');
  if (layout.compact) {
    aimHint.style.cssText =
      `position:absolute;left:50%;transform:translateX(-50%);white-space:nowrap;` +
      `bottom:calc(${layout.edge + layout.slot.height + 6}px + env(safe-area-inset-bottom));` +
      'font:11px ui-monospace,Menlo,monospace;color:#dbe3ee;background:rgba(10,14,20,.72);' +
      'padding:3px 8px;border-radius:5px;pointer-events:none;';
    root.append(aimHint);
  }

  let useHandler: (abilityId: string) => void = () => undefined;

  const slots = HOTBAR.map((abilityId, index) => {
    const ability = abilityById(abilityId);
    const button = document.createElement('button');
    button.style.cssText =
      `width:${layout.slot.width}px;border-radius:6px;border:1px solid #33405a;background:#182130;` +
      'color:#cfd6e0;cursor:pointer;font:inherit;text-align:center;' +
      // Square and centred on a finger: the label is whatever fits inside the
      // target rather than the target being whatever the label needs.
      (layout.compact
        ? `height:${layout.slot.height}px;padding:2px;line-height:1.15;display:flex;` +
          'align-items:center;justify-content:center;'
        : 'padding:6px 4px;line-height:1.5;');
    button.style.position = 'relative';
    button.style.overflow = 'hidden';
    // The number is the key that casts it, so it goes where there are keys. A
    // phone has none, and the digit was taking a third of the button to say so.
    button.innerHTML = layout.showsKeyNumber
      ? `<b>${index + 1}</b><br>${ability?.name ?? abilityId}`
      : (ability?.name ?? abilityId);
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
      `font:700 ${layout.slotCountdownPx}px ui-monospace,Menlo,monospace;color:#e8eef6;` +
      'text-shadow:0 1px 2px #000;pointer-events:none;';
    button.append(remaining);

    bar.append(button);
    return { abilityId, ability, button, sweep, remaining };
  });

  // The weapon switch (spec 079), bottom left and out of the hotbar's way.
  // Which one is lit is read back off `stats.basicAttackId` -- the server's
  // answer -- so a refused equip simply leaves the old one lit.
  const weapons = document.createElement('div');
  weapons.style.cssText =
    `position:absolute;left:calc(${layout.edge}px + env(safe-area-inset-left));bottom:${bottom};` +
    `display:flex;flex-direction:${layout.weaponDirection};gap:${layout.weaponGap}px;` +
    'font:11px ui-monospace,Menlo,monospace;pointer-events:auto;' +
    // Backed like the status readout: the caption is small grey text and the
    // world behind it is a bright green field, so unbacked it disappears over
    // half the map. Icons carry their own backing, so the compact row drops the
    // panel and the padding with the caption.
    (layout.weaponIconOnly ? '' : 'background:rgba(10,14,20,.72);padding:8px;border-radius:6px;');
  root.append(weapons);

  if (!layout.weaponIconOnly) {
    const weaponCaption = document.createElement('div');
    weaponCaption.style.cssText = 'color:#8b97a8;letter-spacing:.08em;padding-left:2px;';
    weaponCaption.textContent = 'WEAPON';
    weapons.append(weaponCaption);
  }

  let equipHandler: (itemId: string) => void = () => undefined;

  const weaponSlots = WEAPON_SWITCH.map((weapon) => {
    const ability = abilityById(weapon.abilityId);
    const button = document.createElement('button');
    button.style.cssText =
      // Fixed height on a finger, because the target is the point; a floor on
      // desktop, because a long name that wraps should push the button open
      // rather than spill out of it.
      `width:${layout.weapon.width}px;border-radius:6px;` +
      `${layout.weaponIconOnly ? 'height' : 'min-height'}:${layout.weapon.height}px;` +
      'border:1px solid #33405a;background:#182130;color:#cfd6e0;cursor:pointer;font:inherit;' +
      `display:flex;align-items:center;gap:6px;line-height:1.4;` +
      (layout.weaponIconOnly ? 'justify-content:center;padding:0;' : 'padding:5px 8px;');
    // The icon is the whole button on a phone, so the name has to survive as a
    // label rather than as text: it is what a screen reader reads out, and what
    // the harness reports when it says which weapon is lit.
    button.innerHTML = weaponIconSvg(weapon.abilityId, { size: layout.weaponIconPx });
    button.setAttribute('aria-label', weapon.name);
    // Says which weapon this button is, for the same reason a health bar says
    // which body it belongs to: `scripts/preview-world.ts` has to find the lit
    // one, and it used to find it by `text-align:left` -- a style, which stopped
    // being true the moment the compact switch centred its icons. A named handle
    // is the honest version of that, and it survives the button having no text.
    button.dataset['weapon'] = weapon.itemId;
    if (!layout.weaponIconOnly) {
      const name = document.createElement('span');
      name.textContent = weapon.name;
      button.append(name);
    }
    button.title = ability ? `${ability.name} -- ${ability.description}` : weapon.itemId;
    button.addEventListener('click', () => equipHandler(weapon.itemId));
    weapons.append(button);
    return { ...weapon, button };
  });

  const bars = new Map<number, Bar>();
  /** The numbers' whole life lives in the pure field; this holds their elements. */
  const popups = new DamagePopups();
  const popupElements = new Map<number, HTMLElement>();
  let notice = '';
  let noticeAge = 999;

  function barFor(id: number): Bar {
    const existing = bars.get(id);
    if (existing) return existing;

    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;transform:translate(-50%,-100%);width:52px;';
    // Says which body this bar belongs to. Nothing in the game reads it; it is
    // how `scripts/preview-world.ts` finds a real unit on screen to click,
    // instead of re-deriving the camera projection and testing its own copy.
    holder.dataset['entity'] = String(id);

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

  function dropPopup(id: number): void {
    popupElements.get(id)?.remove();
    popupElements.delete(id);
  }

  function update(
    view: ClientView,
    anchors: readonly ScreenAnchor[],
    tick: number,
    corrections: number,
    targetId: number | null,
    aiming: { readonly abilityId: string | null; readonly pending: boolean },
  ): void {
    const byId = new Map(view.entities.map((entity) => [entity.id, entity]));
    const casts = new Map(view.casts.map((cast) => [cast.entityId, cast]));
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
      // Says whether this bar is the local player's. Nothing in the game reads
      // it either; it is how `scripts/preview-world.ts` avoids aiming a click at
      // a monster its own body is standing in front of, which since spec 095 is
      // a miss rather than a forgiven near-miss.
      if (anchor.id === view.selfEntityId) element.root.dataset['self'] = '';
      else delete element.root.dataset['self'];
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

    // Damage numbers stay on the ground the blow landed on (spec 096): the
    // field holds a world point each and re-projects it, so nothing here needs
    // the body -- or needs it to still exist.
    const step = popups.step(project);
    for (const id of step.expired) dropPopup(id);
    for (const placement of step.live) {
      const element = popupElements.get(placement.id);
      if (!element) continue;
      element.style.display = placement.onScreen ? 'block' : 'none';
      element.style.left = `${placement.left}px`;
      element.style.top = `${placement.top}px`;
      element.style.opacity = placement.opacity.toFixed(3);
    }

    noticeAge += 1;
    notices.textContent = noticeAge < 120 ? notice : '';

    // Lit from the stat block, never from the last click: the server decides
    // what is in this character's hand, and a refused equip leaves the old one
    // lit rather than a button that lies.
    const held = view.stats?.basicAttackId ?? BASIC_ATTACK_ID;
    for (const weapon of weaponSlots) {
      const current = weapon.abilityId === held;
      weapon.button.style.borderColor = current ? '#ffcf6b' : '#33405a';
      weapon.button.style.background = current ? '#243044' : '#182130';
      weapon.button.style.color = current ? '#f2f6fb' : '#98a4b4';
    }

    for (const slot of slots) {
      const casting = view.casts.some(
        (cast) => cast.entityId === view.selfEntityId && cast.abilityId === slot.abilityId,
      );
      const requested = view.requestedAbilityId === slot.abilityId;
      slot.button.style.borderColor = casting ? '#ffcf6b' : requested ? '#5c7ba6' : '#33405a';
      slot.button.style.opacity = affordable(view, slot.ability) ? '1' : '0.45';

      // The slot being aimed, lit in the aim's own colour (spec 080), so the
      // question on the ground and the button it came from are one thing.
      const aimed = slot.abilityId === aiming.abilityId;
      slot.button.style.borderColor = aimed ? AIM_HIGHLIGHT : '#33405a';
      slot.button.style.background = aimed ? '#1d2c3d' : '#182130';

      // The sweep is the server's cooldown, played back (spec 065). Its *length*
      // comes from the ability table so the shade shrinks proportionally; the
      // client never decides when something is ready.
      const readyAt = view.cooldowns[slot.abilityId] ?? 0;
      const left = readyAt - tick;
      // The sweep's length is the cadence the cooldown was stamped with, which
      // for the basic attack is the player's own (spec 070) -- against the
      // table's number the shade would start part-drained and finish early.
      const total = Math.max(
        1,
        slot.ability?.basicAttack && view.stats
          ? view.stats.attackDelayTicks
          : (slot.ability?.cooldownTicks ?? 1),
      );
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
      // The client's own clock first, and the last delta beside it. They used to
      // be one number -- `view.tick` -- which was fine only because something was
      // always moving: deltas are suppressed when nothing changed, and since
      // spec 076 a field of monsters that nobody has hit is genuinely still, so
      // the readout sat at 3 while the game ran perfectly well underneath it.
      `tick ${Math.floor(tick)}   delta ${view.tick}   seed ${view.worldSeed ?? '-'}\n` +
      `hp ${Math.round(self?.health ?? 0)}/${Math.round(stats?.maxHealth ?? 0)}   ` +
      `lvl ${view.level}   xp ${view.experience}\n` +
      `monsters ${monsters}   corrections ${corrections}` +
      (view.connected ? '' : '   (disconnected)') +
      `\n${targetLine(view, targetId)}` +
      `\n${aimLine(aiming)}`;

    // The compact HUD shows the aim line and nothing else from that block, and
    // only while there is an aim to answer -- an empty box floating over the
    // grass would be the panel back by another name.
    if (layout.compact) {
      const hint = aiming.abilityId === null ? '' : aimLine(aiming);
      aimHint.textContent = hint;
      aimHint.style.display = hint === '' ? 'none' : 'block';
    }
  }

  return {
    element: root,
    update,
    showSpawners(marks) {
      const seen = new Set<string>();
      for (const mark of marks) {
        if (!mark.onScreen) continue;
        seen.add(mark.id);
        let element = spawnerMarks.get(mark.id);
        if (!element) {
          element = document.createElement('div');
          element.style.cssText =
            'position:absolute;transform:translate(-50%,-100%);white-space:nowrap;' +
            'font:11px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:5px;' +
            'background:rgba(10,14,20,.72);border:1px solid rgba(224,96,92,.7);';
          // Which spawner this is, for the same reason a bar says which body it
          // belongs to: `scripts/preview-world.ts` needs a handful of *fixed*
          // world points on screen to measure a damage number against, and a
          // spawner is the only thing in the overlay that never moves.
          element.dataset['spawner'] = mark.id;
          spawnerLayer.append(element);
          spawnerMarks.set(mark.id, element);
        }
        element.textContent = mark.text;
        // Dimmed while the ground is empty, lit while something is standing on
        // it: the two states are readable without reading the text.
        element.style.color = mark.waiting ? '#9aa3b0' : '#f0a09c';
        element.style.left = `${Math.round(mark.x)}px`;
        element.style.top = `${Math.round(mark.y)}px`;
      }
      for (const [id, element] of spawnerMarks) {
        if (seen.has(id)) continue;
        element.remove();
        spawnerMarks.delete(id);
      }
    },
    addDamage(entityId, at, damage, crit) {
      const heal = damage < 0;
      const text = (heal ? '+' : '') + Math.round(Math.abs(damage)).toString();
      const element = document.createElement('div');
      // Hidden until the first `update` places it: a number is spawned from a
      // message, which is not a frame, so until one has been drawn there is no
      // camera to ask and the only honest position is nowhere.
      element.style.cssText = 'position:absolute;transform:translate(-50%,-100%);display:none;';
      // The pixel font (spec 065) rather than the browser's UI face: these float
      // over a posterized, low-resolution world, and system text over it read
      // like a debug overlay that had been left switched on.
      element.innerHTML = pixelTextSvg(text, {
        scale: crit ? 4 : 3,
        fill: heal ? '#8ce696' : crit ? '#ffdc78' : '#f4f4f4',
        outline: '#0a0d14',
      });
      root.append(element);
      const added = popups.add(entityId, at);
      // Stamped so one number can be followed across frames from outside, the
      // way `data-entity` lets a bar be. `preview-world.ts` reads it to check
      // that a number pans with the ground rather than with the camera, which
      // is a fact only a real browser with a real camera can settle.
      element.dataset['damageId'] = String(added.id);
      popupElements.set(added.id, element);
      // The field caps how many float at once; whatever it dropped to make room
      // is an element nobody will place again.
      for (const id of added.expired) dropPopup(id);
    },
    notice(text) {
      notice = text;
      noticeAge = 0;
    },
    onUse(handler) {
      useHandler = handler;
    },
    onEquip(handler) {
      equipHandler = handler;
    },
  };
}

/**
 * The one line of target readout (spec 070). Deliberately one line: knowing
 * what you are hitting and how much of it is left is the whole job, and a
 * target frame is a different change.
 */
function targetLine(view: ClientView, targetId: number | null): string {
  const target = targetId === null
    ? undefined
    : view.entities.find((entity) => entity.id === targetId);
  if (!target) return 'no target';
  return `target ${displayName(target)} ${Math.round(target.health)}/${Math.round(target.maxHealth)}`;
}

/**
 * The bottom line: what the next click does (spec 080).
 *
 * It replaces the fixed key list, which said the same six things whatever the
 * player was in the middle of. While a skill is aimed there is exactly one
 * question on screen, and this is it.
 */
/**
 * Whether the hint line should name gestures rather than mouse buttons.
 *
 * Answered once and remembered: `aimLine` runs every frame, and this is a media
 * query about the hardware rather than about the window.
 */
let touchHintsCache: boolean | null = null;
function touchHints(): boolean {
  touchHintsCache ??= isCoarsePointer();
  return touchHintsCache;
}

function aimLine(aiming: { readonly abilityId: string | null; readonly pending: boolean }): string {
  const ability = aiming.abilityId === null ? null : abilityById(aiming.abilityId);
  // A phone has no right button and no Escape key, so naming them would be
  // instructions for a machine the player is not holding (spec 093).
  const touch = touchHints();
  if (!ability) {
    return touch
      // No key numbers to name on a phone since spec 094 -- the bar is tapped.
      ? 'tap ground to move, a unit to attack · pinch to zoom · tap a skill to cast it'
      : 'right-click ground to move, a unit to attack · WASD · 1-8 abilities · Esc cancel';
  }
  if (!aiming.pending) {
    return touch
      ? `${ability.name}: moving into range`
      : `${ability.name}: moving into range · right-click to call it off`;
  }
  if (touch) {
    // The unit case is the one place the two disagree, and it is worth saying
    // out loud: on touch, tapping anywhere but a body is how you back out.
    return aimGesture(ability) === 'unit'
      ? `aiming ${ability.name} — tap a unit, tap the ground to cancel`
      : `aiming ${ability.name} — tap to place`;
  }
  const pick = aimGesture(ability) === 'unit' ? 'left-click a unit' : 'left-click to place';
  return `aiming ${ability.name} — ${pick}, right-click to cancel`;
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
