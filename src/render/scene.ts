import { Application, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
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
  PLAYER_ATTACK_WINDUP_TICKS,
  PLAYER_RADIUS,
  TICK_RATE,
} from '../sim/constants.js';
import type { Vec2 } from '../sim/types.js';
import { buildDudeTextures, SPRITE_NATIVE_HEIGHT, type DudeTextures, type DudeIdentity } from './sprites.js';

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
const POPUP_LIFE_FRAMES = 42;
const POPUP_RISE_PER_FRAME = -0.9;
const SPRITE_SCALE = 2.2;
const SPRITE_ANCHOR_Y = 0.7; // feet roughly at the actor's position
const SPRITE_TOP_OFFSET = SPRITE_NATIVE_HEIGHT * SPRITE_SCALE * SPRITE_ANCHOR_Y; // px from position up to sprite top

interface Popup {
  readonly text: Text;
  readonly vx: number;
  life: number;
}

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
  private readonly playerSprite: Sprite;
  private readonly enemySprite: Sprite;
  private readonly playerTex: DudeTextures;
  private readonly enemyTex: DudeTextures;
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
  private readonly popups: Popup[] = [];

  private constructor(
    readonly app: Application,
    textures: { player: DudeTextures; enemy: DudeTextures },
    identity: DudeIdentity,
  ) {
    const stage = app.stage;
    this.playerTex = textures.player;
    this.enemyTex = textures.enemy;
    this.playerSprite = new Sprite(textures.player.idle);
    this.enemySprite = new Sprite(textures.enemy.idle);
    for (const s of [this.playerSprite, this.enemySprite]) s.anchor.set(0.5, SPRITE_ANCHOR_Y);
    // Order: arena, telegraph zone, actor sprites, swing wedge, bars/rings on top.
    stage.addChild(this.arena, this.telegraphGfx, this.enemySprite, this.playerSprite, this.swingGfx, this.enemyGfx, this.playerGfx, this.cooldownGfx);

    this.playerLabel = new Text({ text: identity.playerName.toUpperCase(), style: textStyle(11, '#bfe0ff', 'bold') });
    this.enemyLabel = new Text({ text: identity.enemyType.toUpperCase(), style: textStyle(11, '#ff9a9a', 'bold') });
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

  static async create(container: HTMLElement, identity: DudeIdentity): Promise<Scene> {
    const app = new Application();
    await app.init({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, background: '#101018', antialias: true });
    container.appendChild(app.canvas);
    return new Scene(app, buildDudeTextures(identity), identity);
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
      if (event.kind === 'playerHit') {
        this.playerFlash = FLASH_FRAMES;
        const p = this.worldToScreen(state.combat.player.position);
        this.spawnPopup(p.x, p.y, `-${event.damage}`, '#ff6b6b', 20);
      }
      if (event.kind === 'enemyHit') {
        this.enemyFlash = FLASH_FRAMES;
        const e = this.worldToScreen(state.combat.enemy.position);
        this.spawnPopup(e.x, e.y, `${event.damage}`, '#ffe08a', 22);
      }
      if (event.kind === 'playerHealed') {
        this.healFlash = FLASH_FRAMES;
        const p = this.worldToScreen(state.combat.player.position);
        this.spawnPopup(p.x, p.y, `+${event.amount}`, '#7affc0', 20);
      }
    }
    this.updatePopups();
    while (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    this.logText.text = this.logLines.join('\n');

    this.drawTelegraph(state);
    this.drawEnemy(state);
    this.drawSwing(state);
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

    this.enemySprite.texture = e.phase === 'windup' ? this.enemyTex.windup : this.enemyTex.idle;
    const faceRight = state.combat.player.position.x >= e.position.x;
    const pop = 1 + 0.22 * (this.enemyFlash / FLASH_FRAMES);
    this.enemySprite.position.set(p.x, p.y);
    this.enemySprite.scale.set((faceRight ? 1 : -1) * SPRITE_SCALE * pop, SPRITE_SCALE * pop);

    const barTop = p.y - SPRITE_TOP_OFFSET - 12;
    this.enemyGfx.clear();
    this.drawBar(this.enemyGfx, p.x - 30, barTop, 60, 7, e.health / e.maxHealth, '#ff5a5a');
    this.enemyLabel.position.set(p.x, barTop - 4);
  }

  private drawSwing(state: GameState): void {
    this.swingGfx.clear();
    const pl = state.combat.player;
    const tick = state.combat.tick;
    const p = this.worldToScreen(pl.position);
    const ang = Math.atan2(pl.attackAimY, pl.attackAimX); // aim captured at wind-up start
    const reach = PLAYER_ATTACK_RANGE * ARENA_SCALE;
    const arc = (a0: number, a1: number): Graphics =>
      this.swingGfx.moveTo(p.x, p.y).arc(p.x, p.y, reach, a0, a1).lineTo(p.x, p.y);

    if (pl.attackReleaseTick !== 0) {
      // Winding up: a growing outline wedge telegraphs the incoming strike.
      const charge = 1 - Math.max(0, pl.attackReleaseTick - tick) / PLAYER_ATTACK_WINDUP_TICKS;
      const half = (Math.PI / 4) * (0.5 + 0.5 * charge);
      this.swingGfx.moveTo(p.x, p.y).arc(p.x, p.y, reach * (0.5 + 0.5 * charge), ang - half, ang + half).lineTo(p.x, p.y);
      this.swingGfx.stroke({ color: '#bfe0ff', width: 2, alpha: 0.4 + 0.4 * charge });
    } else if (tick < pl.moveLockUntil) {
      // The strike: a bright filled wedge during the brief recovery.
      arc(ang - Math.PI / 4, ang + Math.PI / 4).fill({ color: '#eaf3ff', alpha: 0.34 });
    }
  }

  private drawPlayer(state: GameState, aim: ScreenPoint): void {
    const pl = state.combat.player;
    const tick = state.combat.tick;
    const p = this.worldToScreen(pl.position);

    const attacking = pl.attackReleaseTick !== 0 || tick < pl.moveLockUntil;
    this.playerSprite.texture = attacking ? this.playerTex.windup : this.playerTex.idle;
    const faceRight = aim.x >= 0;
    const pop = 1 + 0.22 * (this.playerFlash / FLASH_FRAMES);
    this.playerSprite.position.set(p.x, p.y);
    this.playerSprite.scale.set((faceRight ? 1 : -1) * SPRITE_SCALE * pop, SPRITE_SCALE * pop);
    this.playerSprite.tint = this.healFlash > 0 ? 0x7affc0 : this.playerFlash > 0 ? 0xffb0b0 : 0xffffff;

    const barTop = p.y - SPRITE_TOP_OFFSET - 20;
    this.playerGfx.clear();
    this.drawBar(this.playerGfx, p.x - 30, barTop, 60, 7, pl.health / pl.maxHealth, '#5ad65a');
    this.drawBar(this.playerGfx, p.x - 30, barTop + 10, 60, 5, pl.mana / pl.maxMana, '#4ea1ff');
    this.playerLabel.position.set(p.x, barTop - 4);
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

  /** Spawn a floating combat number that drifts up and fades (cosmetic only). */
  private spawnPopup(x: number, y: number, label: string, color: string, fontSize: number): void {
    const text = new Text({ text: label, style: textStyle(fontSize, color, 'bold') });
    text.anchor.set(0.5, 1);
    text.position.set(x + (Math.random() * 20 - 10), y - 24);
    this.app.stage.addChild(text);
    this.popups.push({ text, vx: Math.random() * 0.6 - 0.3, life: POPUP_LIFE_FRAMES });
  }

  private updatePopups(): void {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const popup = this.popups[i];
      if (!popup) continue;
      popup.life -= 1;
      popup.text.position.x += popup.vx;
      popup.text.position.y += POPUP_RISE_PER_FRAME;
      popup.text.alpha = Math.max(0, popup.life / POPUP_LIFE_FRAMES);
      if (popup.life <= 0) {
        this.app.stage.removeChild(popup.text);
        popup.text.destroy();
        this.popups.splice(i, 1);
      }
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
