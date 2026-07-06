import { Application, Graphics, Text, TextStyle } from 'pixi.js';
import { CARD_CATALOG, SYNERGY_DEFS } from '../cards/catalog.js';
import { getActiveSynergies } from '../cards/synergy.js';
import type { GameEvent, GameState } from '../game/session.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ENEMY_ATTACK_RADIUS,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_WINDUP_TICKS,
  PLAYER_ATTACK_COOLDOWN_TICKS,
  PLAYER_RADIUS,
} from '../sim/constants.js';
import type { Vec2 } from '../sim/types.js';

const ARENA_OFFSET_X = 40;
const ARENA_OFFSET_Y = 40;
const ARENA_SCALE = 1; // world units map 1:1 to pixels
const SCREEN_WIDTH = ARENA_OFFSET_X * 2 + ARENA_WIDTH + 340;
const SCREEN_HEIGHT = ARENA_OFFSET_Y + ARENA_HEIGHT + 180;
const HAND_Y = ARENA_OFFSET_Y + ARENA_HEIGHT + 30;
const MAX_LOG_LINES = 7;
const TWO_PI = Math.PI * 2;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

function eventToLogLine(event: GameEvent): string | undefined {
  switch (event.kind) {
    case 'perfectDefense':
      return `PERFECT ${event.defenseType.toUpperCase()}! (+bonus card)`;
    case 'normalDefense':
      return `${event.defenseType} (partial)`;
    case 'enemyAttackAvoided':
      return 'dodged the slam by moving!';
    case 'playerHit':
      return `you took ${event.damage} damage`;
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

export class Scene {
  private readonly arena = new Graphics();
  private readonly telegraphGfx = new Graphics();
  private readonly enemyGfx = new Graphics();
  private readonly playerGfx = new Graphics();
  private readonly cooldownGfx = new Graphics();
  private readonly handSlots: { box: Graphics; text: Text }[] = [];
  private readonly bonusText: Text;
  private readonly synergyText: Text;
  private readonly logText: Text;
  private readonly logLines: string[] = [];

  private constructor(readonly app: Application) {
    const stage = app.stage;
    stage.addChild(this.arena, this.telegraphGfx, this.enemyGfx, this.playerGfx, this.cooldownGfx);

    for (let i = 0; i < 3; i++) {
      const box = new Graphics();
      const text = new Text({ text: '', style: textStyle(13, '#e8e8f0') });
      const x = ARENA_OFFSET_X + i * 230;
      box.position.set(x, HAND_Y);
      text.position.set(x + 10, HAND_Y + 8);
      stage.addChild(box, text);
      this.handSlots.push({ box, text });
    }

    this.bonusText = new Text({ text: '', style: textStyle(14, '#ffd76a', 'bold') });
    this.bonusText.position.set(ARENA_OFFSET_X + ARENA_WIDTH + 40, 60);
    stage.addChild(this.bonusText);

    this.synergyText = new Text({ text: '', style: textStyle(14, '#7affc0', 'bold') });
    this.synergyText.position.set(ARENA_OFFSET_X + ARENA_WIDTH + 40, 100);
    stage.addChild(this.synergyText);

    this.logText = new Text({ text: '', style: textStyle(12, '#c8c8d8') });
    this.logText.position.set(ARENA_OFFSET_X + ARENA_WIDTH + 40, 150);
    stage.addChild(this.logText);

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
      .rect(ARENA_OFFSET_X, ARENA_OFFSET_Y, ARENA_WIDTH * ARENA_SCALE, ARENA_HEIGHT * ARENA_SCALE)
      .fill({ color: '#16161f' })
      .stroke({ color: '#33334a', width: 2 });
  }

  render(state: GameState, events: readonly GameEvent[], aim: ScreenPoint): void {
    for (const event of events) {
      const line = eventToLogLine(event);
      if (line) this.logLines.push(line);
    }
    while (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    this.logText.text = this.logLines.join('\n');

    this.drawTelegraph(state);
    this.drawEnemy(state);
    this.drawPlayer(state, aim);
    this.drawCooldowns(state);
    this.drawHand(state);

    const activeSynergies = getActiveSynergies(state.deck.hand, SYNERGY_DEFS, CARD_CATALOG);
    this.synergyText.text = activeSynergies.length > 0 ? `Synergy: ${activeSynergies.map((s) => s.id).join(', ')}!` : '';

    this.bonusText.text = state.deck.bonusSlot
      ? `BONUS: ${CARD_CATALOG.get(state.deck.bonusSlot.defId)?.name ?? state.deck.bonusSlot.defId} (B)`
      : '';
  }

  private drawTelegraph(state: GameState): void {
    this.telegraphGfx.clear();
    const enemy = state.combat.enemy;
    if (enemy.phase !== 'windup' || !enemy.attackZoneCenter) return;
    const c = this.worldToScreen(enemy.attackZoneCenter);
    const ticksUntilHit = enemy.phaseEndsAtTick - state.combat.tick;
    const progress = 1 - Math.max(0, ticksUntilHit) / ENEMY_WINDUP_TICKS;
    // Filled orange zone that intensifies as the slam approaches, plus a bright rim.
    this.telegraphGfx
      .circle(c.x, c.y, ENEMY_ATTACK_RADIUS * ARENA_SCALE)
      .fill({ color: '#ff8c1a', alpha: 0.12 + 0.35 * progress });
    this.telegraphGfx
      .circle(c.x, c.y, ENEMY_ATTACK_RADIUS * ARENA_SCALE)
      .stroke({ color: '#ffb347', width: 2, alpha: 0.6 + 0.4 * progress });
    // Inner ring that shrinks toward the centre as a "time to impact" cue.
    this.telegraphGfx
      .circle(c.x, c.y, ENEMY_ATTACK_RADIUS * ARENA_SCALE * (1 - progress))
      .stroke({ color: '#ffd76a', width: 2, alpha: 0.8 });
  }

  private drawEnemy(state: GameState): void {
    const e = state.combat.enemy;
    const p = this.worldToScreen(e.position);
    this.enemyGfx.clear();
    this.enemyGfx.circle(p.x, p.y, ENEMY_RADIUS * ARENA_SCALE).fill({ color: '#ff5a5a' });
    this.drawBar(this.enemyGfx, p.x - 26, p.y - ENEMY_RADIUS - 14, 52, 6, e.health / e.maxHealth, '#ff5a5a');
  }

  private drawPlayer(state: GameState, aim: ScreenPoint): void {
    const pl = state.combat.player;
    const p = this.worldToScreen(pl.position);
    this.playerGfx.clear();
    this.playerGfx.circle(p.x, p.y, PLAYER_RADIUS * ARENA_SCALE).fill({ color: '#4ea1ff' });

    // Facing indicator: a short line from the player toward the aim direction.
    const len = Math.hypot(aim.x, aim.y);
    if (len > 0.0001) {
      const ux = aim.x / len;
      const uy = aim.y / len;
      this.playerGfx
        .moveTo(p.x, p.y)
        .lineTo(p.x + ux * (PLAYER_RADIUS + 14), p.y + uy * (PLAYER_RADIUS + 14))
        .stroke({ color: '#bfe0ff', width: 3 });
    }

    this.drawBar(this.playerGfx, p.x - 26, p.y - PLAYER_RADIUS - 20, 52, 6, pl.health / pl.maxHealth, '#5ad65a');
    this.drawBar(this.playerGfx, p.x - 26, p.y - PLAYER_RADIUS - 12, 52, 4, pl.mana / pl.maxMana, '#4ea1ff');
  }

  private drawCooldowns(state: GameState): void {
    this.cooldownGfx.clear();
    const tick = state.combat.tick;

    // Player attack cooldown: a ring that fills back up to a full circle as it recovers.
    const pl = state.combat.player;
    const p = this.worldToScreen(pl.position);
    const cdRemaining = Math.max(0, pl.attackCooldownUntil - tick);
    const readiness = 1 - cdRemaining / PLAYER_ATTACK_COOLDOWN_TICKS;
    this.drawRadial(p.x, p.y, PLAYER_RADIUS + 6, readiness, readiness >= 1 ? '#7affc0' : '#4ea1ff');

    // Enemy attack cadence: a ring tracking progress through its current phase.
    const e = state.combat.enemy;
    const ep = this.worldToScreen(e.position);
    const phaseTotal =
      e.phase === 'idle' ? ENEMY_IDLE_TICKS : e.phase === 'windup' ? ENEMY_WINDUP_TICKS : ENEMY_RECOVERY_TICKS;
    const phaseProgress = 1 - Math.max(0, e.phaseEndsAtTick - tick) / phaseTotal;
    const ringColor = e.phase === 'windup' ? '#ff8c1a' : e.phase === 'recovery' ? '#7a5a5a' : '#c05050';
    this.drawRadial(ep.x, ep.y, ENEMY_RADIUS + 6, phaseProgress, ringColor);
  }

  /** Draw a radial "loader" arc from the top, clockwise, filling to `progress` (0..1). */
  private drawRadial(cx: number, cy: number, radius: number, progress: number, color: string): void {
    const clamped = Math.max(0, Math.min(1, progress));
    const start = -Math.PI / 2;
    this.cooldownGfx.circle(cx, cy, radius).stroke({ color: '#000000', width: 3, alpha: 0.25 });
    if (clamped <= 0) return;
    // moveTo the arc's start point first: otherwise arc() draws a connector line
    // from the pen's origin (0,0) to the start, streaking across the arena.
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
      slot.box.roundRect(0, 0, 210, 74, 6).stroke({ color: '#5a5a7a', width: 2 });
      if (card) {
        const def = CARD_CATALOG.get(card.defId);
        slot.text.text = def ? `[${i + 1}] ${def.name}\ncost ${def.cost}  ${def.tags.join(',')}` : card.defId;
      } else {
        slot.text.text = `[${i + 1}] (empty)`;
      }
    });
  }
}
