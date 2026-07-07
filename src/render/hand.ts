import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { ActiveEffect, CardDef, CardInstance, Catalog, PassiveEffect } from '../cards/types.js';
import { TICK_RATE } from '../sim/constants.js';
import { dealTransform, idleTransform, playTransform, type CardTransform } from './card-anim.js';

/**
 * Balatro-style card hand (spec 013). A thin, render-only view: it reads the
 * deck's `hand` / `bonusSlot` each frame and draws them as cards with an idle
 * bob, dealing new cards in and flying spent cards out. It holds no game rules
 * — it diffs `CardInstance.instanceId` purely to know when to animate.
 */

export const CARD_W = 128;
export const CARD_H = 176;

const PLAY_MS = 420; // spent-card fly-out
const DEAL_MS = 380; // drawn-card deal-in

const CREAM = '#efe6cf';
const INK = '#332d20';
const INK_SOFT = '#6a6048';

interface TypeStyle {
  readonly border: string;
  readonly header: string;
  readonly headerInk: string;
}

const ACTIVE_STYLE: TypeStyle = { border: '#3b6ea5', header: '#3b6ea5', headerInk: '#eaf3ff' };
const PASSIVE_STYLE: TypeStyle = { border: '#3a9d5a', header: '#2f7d47', headerInk: '#eafff0' };
const BONUS_STYLE: TypeStyle = { border: '#d9a534', header: '#b9862a', headerInk: '#fff6e0' };

// Flavor tag -> art-box color. Falls back to a neutral slate.
const TAG_COLORS: Readonly<Record<string, string>> = {
  fire: '#c0472b',
  ice: '#3d84c6',
  holy: '#c8b24a',
  fury: '#c76a2b',
  melee: '#8a6a4a',
  utility: '#4a8a7a',
  offense: '#a5453b',
  sustain: '#4a9d6a',
  arcane: '#6a5ac0',
  curse: '#7a3a6a',
};

interface CardLayout {
  readonly x: number;
  readonly y: number;
}

interface Layout {
  readonly handCenters: readonly [CardLayout, CardLayout, CardLayout];
  readonly bonusCenter: CardLayout;
}

interface FlyingCard {
  readonly container: Container;
  readonly x: number;
  readonly y: number;
  progress: number;
}

interface SlotView {
  readonly container: Container; // pivot at card center, positioned at rest center
  readonly rest: CardLayout;
  readonly isBonus: boolean;
  face: Container | null;
  defId: string | null;
  instanceId: number | null;
  dealProgress: number; // 1 = settled
}

/** The flavor of a card for art purposes: the first non-"passive" tag. */
function flavorTag(def: CardDef): string {
  return def.tags.find((t) => t !== 'passive') ?? def.tags[0] ?? '';
}

function activeDescriptor(effect: ActiveEffect): string {
  switch (effect.kind) {
    case 'damage':
      return `Deal ${effect.amount} damage`;
    case 'heal':
      return `Restore ${effect.amount} HP`;
    case 'buffDamage':
      return `+${effect.amount} strike dmg\nfor ${(effect.durationTicks / TICK_RATE).toFixed(0)}s`;
  }
}

function passiveDescriptor(p: PassiveEffect): string {
  switch (p.kind) {
    case 'attackDamage':
      return `While held:\n+${p.amount} strike dmg`;
    case 'nthStrikeDamage':
      return `While held: every\n${p.everyN} strikes +${Math.round(p.bonusFraction * 100)}%`;
    case 'healthRegen':
      return `While held:\n+${p.perSecond} HP/s`;
    case 'manaRegen':
      return `While held:\n+${p.perSecond} mana/s`;
    case 'healOnHurt':
      return `While held: heal\n${p.amount} when hit`;
    case 'enemyTempo':
      return `While held: enemy\n${p.speedMultiplier < 1 ? 'slower' : 'faster'} & weaker`;
  }
}

function descriptorFor(def: CardDef): string {
  return def.kind === 'active' ? activeDescriptor(def.effect) : passiveDescriptor(def.passive);
}

function textNode(text: string, size: number, fill: string, weight: 'normal' | 'bold', wrapWidth?: number): Text {
  const style = new TextStyle({
    fontFamily: 'monospace',
    fontSize: size,
    fill,
    fontWeight: weight,
    align: 'center',
    ...(wrapWidth ? { wordWrap: true, wordWrapWidth: wrapWidth } : {}),
  });
  const node = new Text({ text, style });
  node.anchor.set(0.5, 0.5);
  return node;
}

/** Uniformly shrink a single-line label so it fits within maxWidth (never enlarges). */
function fitWidth(node: Text, maxWidth: number): Text {
  if (node.width > maxWidth) node.scale.set(maxWidth / node.width);
  return node;
}

/** Build a fresh card container in local card coordinates (0..W, 0..H). */
function buildCardFace(def: CardDef | null, isBonus: boolean, slotHint: string): Container {
  const c = new Container();

  if (!def) {
    // Empty slot: faint dashed placeholder.
    const ph = new Graphics();
    ph.roundRect(2, 2, CARD_W - 4, CARD_H - 4, 12).fill({ color: '#141420', alpha: 0.55 });
    ph.roundRect(8, 8, CARD_W - 16, CARD_H - 16, 9).stroke({ color: '#3a3a52', width: 2, alpha: 0.8 });
    c.addChild(ph);
    const hint = textNode(slotHint, 15, '#4a4a66', 'bold');
    hint.position.set(CARD_W / 2, CARD_H / 2);
    c.addChild(hint);
    return c;
  }

  const style = isBonus ? BONUS_STYLE : def.kind === 'passive' ? PASSIVE_STYLE : ACTIVE_STYLE;
  const artColor = TAG_COLORS[flavorTag(def)] ?? '#556070';

  const g = new Graphics();
  // Drop shadow, then border, then cream face.
  g.roundRect(5, 8, CARD_W - 8, CARD_H - 8, 12).fill({ color: '#000000', alpha: 0.32 });
  g.roundRect(0, 0, CARD_W, CARD_H, 12).fill({ color: style.border });
  g.roundRect(4, 4, CARD_W - 8, CARD_H - 8, 9).fill({ color: CREAM });
  // Title band.
  g.roundRect(9, 9, CARD_W - 18, 26, 6).fill({ color: style.header });
  // Art box.
  g.roundRect(14, 44, CARD_W - 28, 66, 8).fill({ color: artColor });
  g.roundRect(14, 44, CARD_W - 28, 66, 8).stroke({ color: '#000000', width: 1, alpha: 0.25 });
  c.addChild(g);

  // Cost pip (top-left): mana cost for actives, "P" for passives, "★" for bonus.
  const pip = new Graphics();
  pip.circle(19, 20, 11).fill({ color: isBonus ? BONUS_STYLE.header : def.kind === 'passive' ? PASSIVE_STYLE.header : '#2f6fb0' });
  pip.circle(19, 20, 11).stroke({ color: CREAM, width: 2 });
  c.addChild(pip);
  const pipLabel = isBonus ? '★' : def.kind === 'passive' ? 'P' : String(def.cost);
  const pipText = textNode(pipLabel, 13, '#ffffff', 'bold');
  pipText.position.set(19, 20);
  c.addChild(pipText);

  // Name in the title band, nudged clear of the pip and shrunk to fit if long.
  const name = fitWidth(textNode(def.name, 12, style.headerInk, 'bold'), CARD_W - 46);
  name.position.set(CARD_W / 2 + 8, 21);
  c.addChild(name);

  // Big flavor glyph in the art box.
  const glyph = (flavorTag(def)[0] ?? '?').toUpperCase();
  const glyphText = textNode(glyph, 40, '#ffffff', 'bold');
  glyphText.alpha = 0.9;
  glyphText.position.set(CARD_W / 2, 77);
  c.addChild(glyphText);

  // Description.
  const desc = textNode(descriptorFor(def), 11, INK, 'normal', CARD_W - 26);
  desc.position.set(CARD_W / 2, 136);
  c.addChild(desc);

  // Footer: slot hint + tag.
  const footer = textNode(`${slotHint}   ${flavorTag(def)}`, 9, INK_SOFT, 'bold');
  footer.position.set(CARD_W / 2, CARD_H - 12);
  c.addChild(footer);

  return c;
}

function combine(a: CardTransform, b: CardTransform): CardTransform {
  return {
    offsetX: a.offsetX + b.offsetX,
    offsetY: a.offsetY + b.offsetY,
    rotation: a.rotation + b.rotation,
    scale: a.scale * b.scale,
    alpha: a.alpha * b.alpha,
  };
}

function applyTransform(container: Container, rest: CardLayout, tf: CardTransform): void {
  container.position.set(rest.x + tf.offsetX, rest.y + tf.offsetY);
  container.rotation = tf.rotation;
  container.scale.set(tf.scale);
  container.alpha = tf.alpha;
}

export class HandView {
  private readonly handLayer = new Container();
  private readonly flyLayer = new Container();
  private readonly slots: SlotView[] = [];
  private readonly flying: FlyingCard[] = [];
  private lastNow: number | undefined;

  constructor(stage: Container, layout: Layout) {
    stage.addChild(this.handLayer, this.flyLayer);
    const rests: readonly (readonly [CardLayout, boolean])[] = [
      [layout.handCenters[0], false],
      [layout.handCenters[1], false],
      [layout.handCenters[2], false],
      [layout.bonusCenter, true],
    ];
    for (const [rest, isBonus] of rests) {
      const container = new Container();
      container.pivot.set(CARD_W / 2, CARD_H / 2);
      container.position.set(rest.x, rest.y);
      this.handLayer.addChild(container);
      this.slots.push({ container, rest, isBonus, face: null, defId: null, instanceId: null, dealProgress: 1 });
    }
  }

  render(hand: readonly (CardInstance | null)[], bonusSlot: CardInstance | null, catalog: Catalog): void {
    const now = performance.now();
    const dt = this.lastNow === undefined ? 0 : now - this.lastNow;
    this.lastNow = now;

    const occupants: (CardInstance | null)[] = [hand[0] ?? null, hand[1] ?? null, hand[2] ?? null, bonusSlot];

    this.slots.forEach((slot, i) => {
      const card = occupants[i] ?? null;
      const instanceId = card ? card.instanceId : null;

      if (instanceId !== slot.instanceId) {
        // The occupant changed. Fly out the old card (if any) and deal in the new.
        if (slot.defId !== null) this.spawnFlying(slot);
        const def = card ? catalog.get(card.defId) ?? null : null;
        this.setFace(slot, def, card ? card.defId : null, i);
        slot.instanceId = instanceId;
        slot.dealProgress = card ? 0 : 1;
      }

      // Compose the resting idle bob with an in-progress deal-in.
      let tf = idleTransform(i, now);
      if (slot.dealProgress < 1) {
        slot.dealProgress = Math.min(1, slot.dealProgress + dt / DEAL_MS);
        tf = combine(dealTransform(slot.dealProgress), tf);
      }
      applyTransform(slot.container, slot.rest, tf);
    });

    // Advance flying cards; retire the finished ones.
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const fly = this.flying[i];
      if (!fly) continue;
      fly.progress = Math.min(1, fly.progress + dt / PLAY_MS);
      applyTransform(fly.container, { x: fly.x, y: fly.y }, playTransform(fly.progress));
      if (fly.progress >= 1) {
        fly.container.destroy({ children: true });
        this.flying.splice(i, 1);
      }
    }
  }

  private setFace(slot: SlotView, def: CardDef | null, defId: string | null, index: number): void {
    if (slot.face) slot.face.destroy({ children: true });
    const face = buildCardFace(def, slot.isBonus, slot.isBonus ? 'B' : `[${index + 1}]`);
    slot.face = face;
    slot.defId = defId;
    slot.container.addChild(face);
  }

  /** Reparent the slot's current face into a detached container that flies out. */
  private spawnFlying(slot: SlotView): void {
    const outgoing = slot.face;
    if (!outgoing || slot.defId === null) return;
    const container = new Container();
    container.pivot.set(CARD_W / 2, CARD_H / 2);
    slot.container.removeChild(outgoing);
    container.addChild(outgoing);
    slot.face = null;
    this.flyLayer.addChild(container);
    this.flying.push({ container, x: slot.rest.x, y: slot.rest.y, progress: 0 });
  }
}
