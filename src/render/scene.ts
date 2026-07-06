import { Application, Graphics, Text, TextStyle } from 'pixi.js';
import { CARD_CATALOG } from '../cards/catalog.js';
import type { CardInstance, PassiveEffect } from '../cards/types.js';
import type { GameEvent, GameState } from '../game/session.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ENEMY_ATTACK_RADIUS,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_WINDUP_TICKS,
  NORMAL_WINDOW_TICKS,
  PERFECT_WINDOW_TICKS,
  PLAYER_ATTACK_COOLDOWN_TICKS,
  PLAYER_ATTACK_RANGE,
  PLAYER_RADIUS,
  TICK_RATE,
} from '../sim/constants.js';
import type { Vec2 } from '../sim/types.js';

const ARENA_OFFSET_X = 40;
const ARENA_OFFSET_Y = 56;
const ARENA_SCALE = 1.2; // zoomed in so the action reads clearly
const ARENA_PX_W = ARENA_WIDTH * ARENA_SCALE;
const ARENA_PX_H = ARENA_HEIGHT * ARENA_SCALE;
const SCREEN_WIDTH = ARENA_OFFSET_X * 2 + ARENA_PX_W + 320;
const SCREEN_HEIGHT = ARENA_OFFSET_Y + ARENA_PX_H + 190;
const HAND_Y = ARENA_OFFSET_Y + ARENA_PX_H + 34;
const MAX_LOG_LINES = 6;
const TWO_PI = Math.PI * 2;
const FLASH_FRAMES = 9;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

function eventToLogLine(event: GameEvent): string | undefined {
  switch (event.kind) {
    case 'perfectDefense':
      return `PERFECT ${event.defenseType.toUpperCase()}! (+bonus card)`;
    case 'normalDefense':
      return `${event.defenseType} (partial block)`;
    case 'enemyAttackAvoided':
      return 'dodged the slam by moving!';
    case 'playerHit':
      return `you took ${event.damage} damage`;
    case 'playerHealed':
      return `+${event.amount} healed`;
    case 'passiveRetired':
      return `retired ${CARD_CATALOG.get(event.defId)?.name ?? event.defId}`;
    case 'enemyHit':
      return `enemy took ${event.damage} damage`;
    case 'attackMissed':
      return 'attack missed';
    case 'cardPlayed':
      return `played ${CARD_CATALOG.get(event.defId)?.name ?? event.defId}`;
    case 'bonusCardPlayed':
      return `played bonus: ${CARD_CATALOG.get(event.defId)?.name ?? event.defId}`;
    case 'bonusCardDrawn':
      return 'bonus card drawn!';
    case 'enemyDefeated':
      return 'enemy defeated!';
    case 'playerDefeated':
      return 'you were defeated...';
    default:
      return undefined;
  }
}

function textStyle(fontSize: number, fill: string, weight: 'normal' | 'bold' = 'normal'): TextStyle {
  return new TextStyle({ fontFamily: 'monospace', fontSize, fill, fontWeight: weight });
}

/** Short human-readable description of a passive's mechanic, for the hand + held list. */
function passiveDescriptor(p: PassiveEffect): string {
  switch (p.kind) {
    case 'attackDamage':
      return `+${p.amount} strike dmg`;
    case 'nthStrikeDamage':
      return `every ${p.everyN}${p.everyN === 2 ? 'nd' : 'th'} strike +${Math.round(p.bonusFraction * 100)}%`;
    case 'healthRegen':
      return `+${p.perSecond} HP/s`;
    case 'manaRegen':
      return `+${p.perSecond} mana/s`;
    case 'healOnHurt':
      return `heal ${p.amount} when hit`;
    case 'enemyTempo':
      return `enemy ${p.speedMultiplier < 1 ? 'faster' : 'slower'}, ${Math.round((1 - p.damageMultiplier) * 100)}% weaker`;
  }
}

/** Names of the passive cards currently held (hand + bonus slot). */
function heldPassiveNames(cards: readonly (CardInstance | null)[]): string[] {
  const names: string[] = [];
  for (const card of cards) {
    if (!card) continue;
    const def = CARD_CATALOG.get(card.defId);
    if (def && def.kind === 'passive') names.push(def.name);
  }
  return names;
}

export class Scene {
  private readonly arena = new Graphics();
  private readonly telegraphGfx = new Graphics();
  private readonly swingGfx = new Graphics();
  private readonly enemyGfx = new Graphics();
  private readonly playerGfx = new Graphics();
  private readonly cooldownGfx = new Graphics();
  private readonly playerLabel: Text;
  private readonly enemyLabel: Text;
  private readonly banner: Text;
  private readonly prompt: Text;
  private readonly handSlots: { box: Graphics; text: Text }[] = [];
  private readonly bonusText: Text;
  private readonly passivesText: Text;
  private readonly logText: Text;
  private readonly logLines: string[] = [];
  private playerFlash = 0;
  private enemyFlash = 0;
  private healFlash = 0;

  private constructor(readonly app: Application) {
    const stage = app.stage;
    stage.addChild(this.arena, this.telegraphGfx, this.swingGfx, this.enemyGfx, this.playerGfx, this.cooldownGfx);

    this.playerLabel = new Text({ text: 'YOU', style: textStyle(11, '#bfe0ff', 'bold') });
    this.enemyLabel = new Text({ text: 'ENEMY', style: textStyle(11, '#ff9a9a', 'bold') });
    this.playerLabel.anchor.set(0.5, 1);
    this.enemyLabel.anchor.set(0.5, 1);
    stage.addChild(this.playerLabel, this.enemyLabel);

    this.banner = new Text({ text: '', style: textStyle(18, '#ffb347', 'bold') });
    this.banner.anchor.set(0.5, 0);
    this.banner.position.set(ARENA_OFFSET_X + ARENA_PX_W / 2, 18);
    stage.addChild(this.banner);

    this.prompt = new Text({ text: '', style: textStyle(20, '#ffd76a', 'bold') });
    this.prompt.anchor.set(0.5, 1);
    stage.addChild(this.prompt);

    const panelX = ARENA_OFFSET_X + ARENA_PX_W + 40;
    this.bonusText = new Text({ text: '', style: textStyle(14, '#ffd76a', 'bold') });
    this.bonusText.position.set(panelX, ARENA_OFFSET_Y + 6);
    stage.addChild(this.bonusText);

    this.passivesText = new Text({ text: '', style: textStyle(14, '#7affc0') });
    this.passivesText.position.set(panelX, ARENA_OFFSET_Y + 44);
    stage.addChild(this.passivesText);

    this.logText = new Text({ text: '', style: textStyle(13, '#c8c8d8') });
    this.logText.position.set(panelX, ARENA_OFFSET_Y + 92);
    stage.addChild(this.logText);

    for (let i = 0; i < 3; i++) {
      const box = new Graphics();
      const text = new Text({ text: '', style: textStyle(13, '#e8e8f0') });
      const x = ARENA_OFFSET_X + i * 236;
      box.position.set(x, HAND_Y);
      text.position.set(x + 12, HAND_Y + 10);
      stage.addChild(box, text);
      this.handSlots.push({ box, text });
    }

    this.drawArena();
  }

  static async create(container: HTMLElement): Promise<Scene> {
    const app = new Application();
    await app.init({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, background: '#101018', antialias: true });
    container.appendChild(app.canvas);
    return new Scene(app);
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /** Uniform, non-flipping world->screen transform. */
  worldToScreen(v: Vec2): ScreenPoint {
    return { x: ARENA_OFFSET_X + v.x * ARENA_SCALE, y: ARENA_OFFSET_Y + v.y * ARENA_SCALE };
  }

  private drawArena(): void {
    this.arena.clear();
    this.arena
      .rect(ARENA_OFFSET_X, ARENA_OFFSET_Y, ARENA_PX_W, ARENA_PX_H)
      .fill({ color: '#16161f' })
      .stroke({ color: '#33334a', width: 2 });
  }

  render(state: GameState, events: readonly GameEvent[], aim: ScreenPoint): void {
    for (const event of events) {
      const line = eventToLogLine(event);
      if (line) this.logLines.push(line);
      if (event.kind === 'playerHit') this.playerFlash = FLASH_FRAMES;
      if (event.kind === 'enemyHit') this.enemyFlash = FLASH_FRAMES;
      if (event.kind === 'playerHealed') this.healFlash = FLASH_FRAMES;
    }
    while (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    this.logText.text = this.logLines.join('\n');

    this.drawTelegraph(state);
    this.drawEnemy(state);
    this.drawSwing(state, aim);
    this.drawPlayer(state, aim);
    this.drawCooldowns(state);
    this.drawBannerAndPrompt(state);
    this.drawHand(state);

    const held = heldPassiveNames([...state.deck.hand, state.deck.bonusSlot]);
    this.passivesText.text = held.length > 0 ? `Passives active:\n  ${held.join('\n  ')}` : 'Passives active: none';

    this.bonusText.text = state.deck.bonusSlot
      ? `BONUS: ${CARD_CATALOG.get(state.deck.bonusSlot.defId)?.name ?? state.deck.bonusSlot.defId} (press B)`
      : '';

    if (this.playerFlash > 0) this.playerFlash--;
    if (this.enemyFlash > 0) this.enemyFlash--;
    if (this.healFlash > 0) this.healFlash--;
  }

  private drawTelegraph(state: GameState): void {
    this.telegraphGfx.clear();
    const enemy = state.combat.enemy;
    if (enemy.phase !== 'windup' || !enemy.attackZoneCenter) return;
    const c = this.worldToScreen(enemy.attackZoneCenter);
    const r = ENEMY_ATTACK_RADIUS * ARENA_SCALE;
    const ticksUntilHit = enemy.phaseEndsAtTick - state.combat.tick;
    const progress = 1 - Math.max(0, ticksUntilHit) / ENEMY_WINDUP_TICKS;
    this.telegraphGfx.circle(c.x, c.y, r).fill({ color: '#ff8c1a', alpha: 0.14 + 0.4 * progress });
    this.telegraphGfx.circle(c.x, c.y, r).stroke({ color: '#ffb347', width: 3, alpha: 0.6 + 0.4 * progress });
    // Inner ring collapses toward the centre as a "time to impact" cue.
    this.telegraphGfx.circle(c.x, c.y, r * (1 - progress)).stroke({ color: '#ffe08a', width: 2, alpha: 0.85 });
  }

  private drawEnemy(state: GameState): void {
    const e = state.combat.enemy;
    const p = this.worldToScreen(e.position);
    const color = this.enemyFlash > 0 ? '#ffffff' : '#ff5a5a';
    this.enemyGfx.clear();
    this.enemyGfx.circle(p.x, p.y, ENEMY_RADIUS * ARENA_SCALE).fill({ color });
    this.drawBar(this.enemyGfx, p.x - 30, p.y - ENEMY_RADIUS * ARENA_SCALE - 16, 60, 7, e.health / e.maxHealth, '#ff5a5a');
    this.enemyLabel.position.set(p.x, p.y - ENEMY_RADIUS * ARENA_SCALE - 20);
  }

  private drawSwing(state: GameState, aim: ScreenPoint): void {
    this.swingGfx.clear();
    const pl = state.combat.player;
    const tick = state.combat.tick;
    if (tick >= pl.moveLockUntil) return; // only while committed to a swing
    const p = this.worldToScreen(pl.position);
    const ang = Math.atan2(aim.y, aim.x);
    const reach = PLAYER_ATTACK_RANGE * ARENA_SCALE;
    // Filled 90-degree wedge in the aim direction, fading as the swing settles.
    this.swingGfx
      .moveTo(p.x, p.y)
      .arc(p.x, p.y, reach, ang - Math.PI / 4, ang + Math.PI / 4)
      .lineTo(p.x, p.y)
      .fill({ color: '#bfe0ff', alpha: 0.28 });
  }

  private drawPlayer(state: GameState, aim: ScreenPoint): void {
    const pl = state.combat.player;
    const p = this.worldToScreen(pl.position);
    const color = this.healFlash > 0 ? '#7affc0' : this.playerFlash > 0 ? '#ffffff' : '#4ea1ff';
    this.playerGfx.clear();
    this.playerGfx.circle(p.x, p.y, PLAYER_RADIUS * ARENA_SCALE).fill({ color });

    const len = Math.hypot(aim.x, aim.y);
    if (len > 0.0001) {
      const ux = aim.x / len;
      const uy = aim.y / len;
      const r = PLAYER_RADIUS * ARENA_SCALE;
      this.playerGfx
        .moveTo(p.x, p.y)
        .lineTo(p.x + ux * (r + 16), p.y + uy * (r + 16))
        .stroke({ color: '#eaf3ff', width: 3 });
    }

    const r = PLAYER_RADIUS * ARENA_SCALE;
    this.drawBar(this.playerGfx, p.x - 30, p.y - r - 24, 60, 7, pl.health / pl.maxHealth, '#5ad65a');
    this.drawBar(this.playerGfx, p.x - 30, p.y - r - 14, 60, 5, pl.mana / pl.maxMana, '#4ea1ff');
    this.playerLabel.position.set(p.x, p.y - r - 28);
  }

  private drawCooldowns(state: GameState): void {
    this.cooldownGfx.clear();
    const tick = state.combat.tick;

    const pl = state.combat.player;
    const p = this.worldToScreen(pl.position);
    const cdRemaining = Math.max(0, pl.attackCooldownUntil - tick);
    const readiness = 1 - cdRemaining / PLAYER_ATTACK_COOLDOWN_TICKS;
    this.drawRadial(p.x, p.y, PLAYER_RADIUS * ARENA_SCALE + 7, readiness, readiness >= 1 ? '#7affc0' : '#4ea1ff');

    const e = state.combat.enemy;
    const ep = this.worldToScreen(e.position);
    const phaseTotal =
      e.phase === 'idle' ? ENEMY_IDLE_TICKS : e.phase === 'windup' ? ENEMY_WINDUP_TICKS : ENEMY_RECOVERY_TICKS;
    const phaseProgress = 1 - Math.max(0, e.phaseEndsAtTick - tick) / phaseTotal;
    const ringColor = e.phase === 'windup' ? '#ff8c1a' : e.phase === 'recovery' ? '#7a5a5a' : '#c05050';
    this.drawRadial(ep.x, ep.y, ENEMY_RADIUS * ARENA_SCALE + 7, phaseProgress, ringColor);
  }

  private drawBannerAndPrompt(state: GameState): void {
    const e = state.combat.enemy;
    const tick = state.combat.tick;

    if (e.phase === 'windup') {
      const remaining = Math.max(0, e.phaseEndsAtTick - tick);
      this.banner.text = `⚠ SLAM INCOMING  —  ${(remaining / TICK_RATE).toFixed(1)}s`;
      this.banner.style.fill = '#ff8c1a';
    } else if (e.phase === 'recovery') {
      this.banner.text = 'enemy recovering — punish!';
      this.banner.style.fill = '#7affc0';
    } else {
      this.banner.text = 'enemy approaching';
      this.banner.style.fill = '#9a9ab0';
    }

    // Parry/dodge timing prompt over the player: appears in the reactable window,
    // turns bright green in the frame-tight perfect window.
    const pScreen = this.worldToScreen(state.combat.player.position);
    this.prompt.position.set(pScreen.x, pScreen.y - PLAYER_RADIUS * ARENA_SCALE - 46);
    if (e.phase === 'windup') {
      const remaining = e.phaseEndsAtTick - tick;
      if (remaining <= PERFECT_WINDOW_TICKS) {
        this.prompt.text = 'PARRY NOW!';
        this.prompt.style.fill = '#7affc0';
      } else if (remaining <= NORMAL_WINDOW_TICKS) {
        this.prompt.text = 'parry (K) / dodge (L)';
        this.prompt.style.fill = '#ffd76a';
      } else {
        this.prompt.text = '';
      }
    } else {
      this.prompt.text = '';
    }
  }

  /** Draw a radial "loader" arc from the top, clockwise, filling to `progress` (0..1). */
  private drawRadial(cx: number, cy: number, radius: number, progress: number, color: string): void {
    const clamped = Math.max(0, Math.min(1, progress));
    const start = -Math.PI / 2;
    this.cooldownGfx.circle(cx, cy, radius).stroke({ color: '#000000', width: 3, alpha: 0.25 });
    if (clamped <= 0) return;
    // moveTo the arc's start point first, else arc() streaks a line from the pen origin (0,0).
    this.cooldownGfx
      .moveTo(cx + radius * Math.cos(start), cy + radius * Math.sin(start))
      .arc(cx, cy, radius, start, start + clamped * TWO_PI)
      .stroke({ color, width: 3 });
  }

  private drawBar(gfx: Graphics, x: number, y: number, width: number, height: number, fraction: number, color: string): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    gfx.rect(x, y, width, height).fill({ color: '#2a2a3a' });
    gfx.rect(x, y, width * clamped, height).fill({ color });
  }

  private drawHand(state: GameState): void {
    state.deck.hand.forEach((card, i) => {
      const slot = this.handSlots[i];
      if (!slot) return;
      slot.box.clear();
      const def = card ? CARD_CATALOG.get(card.defId) : undefined;
      // Passive cards get a green border so held modifiers are distinguishable at a glance.
      const border = def?.kind === 'passive' ? '#7affc0' : '#5a5a7a';
      slot.box.roundRect(0, 0, 214, 76, 6).fill({ color: '#1b1b26' }).stroke({ color: border, width: 2 });
      if (card && def) {
        if (def.kind === 'passive') {
          slot.text.text = `[${i + 1}] ${def.name}  (PASSIVE)\nwhile held: ${passiveDescriptor(def.passive)}\nplay to retire`;
        } else {
          slot.text.text = `[${i + 1}] ${def.name}  (cost ${def.cost})\n${def.tags.join(', ')}\nplay to use`;
        }
      } else if (card) {
        slot.text.text = card.defId;
      } else {
        slot.text.text = `[${i + 1}] (empty)`;
      }
    });
  }
}
