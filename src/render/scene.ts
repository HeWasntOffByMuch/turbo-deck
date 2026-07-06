import { Application, Graphics, Text, TextStyle } from 'pixi.js';
import { CARD_CATALOG, SYNERGY_DEFS } from '../cards/catalog.js';
import { getActiveSynergies } from '../cards/synergy.js';
import type { GameEvent, GameState } from '../game/session.js';
import { ARENA_MAX, ARENA_MIN, ENEMY_WINDUP_TICKS } from '../sim/constants.js';

const SCREEN_WIDTH = 900;
const SCREEN_HEIGHT = 520;
const ARENA_MARGIN = 60;
const FLOOR_Y = 300;
const ACTOR_RADIUS = 22;
const MAX_LOG_LINES = 7;

const ARENA_SPAN = ARENA_MAX - ARENA_MIN;
const ARENA_SCALE = (SCREEN_WIDTH - 2 * ARENA_MARGIN) / ARENA_SPAN;

function toScreenX(position: number): number {
  return ARENA_MARGIN + (position - ARENA_MIN) * ARENA_SCALE;
}

function eventToLogLine(event: GameEvent): string | undefined {
  switch (event.kind) {
    case 'perfectDefense':
      return `PERFECT ${event.defenseType.toUpperCase()}!`;
    case 'normalDefense':
      return `${event.defenseType} (partial)`;
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
  private readonly floor = new Graphics();
  private readonly playerGfx = new Graphics();
  private readonly enemyGfx = new Graphics();
  private readonly telegraphGfx = new Graphics();
  private readonly handSlots: { box: Graphics; text: Text }[] = [];
  private readonly bonusText: Text;
  private readonly synergyText: Text;
  private readonly logText: Text;
  private readonly logLines: string[] = [];

  private constructor(readonly app: Application) {
    const stage = app.stage;
    stage.addChild(this.floor, this.telegraphGfx, this.enemyGfx, this.playerGfx);

    for (let i = 0; i < 3; i++) {
      const box = new Graphics();
      const text = new Text({ text: '', style: textStyle(13, '#e8e8f0') });
      const x = SCREEN_WIDTH / 2 - 220 + i * 220;
      box.position.set(x, 420);
      text.position.set(x + 10, 428);
      stage.addChild(box, text);
      this.handSlots.push({ box, text });
    }

    this.bonusText = new Text({ text: '', style: textStyle(14, '#ffd76a', 'bold') });
    this.bonusText.position.set(SCREEN_WIDTH - 220, 20);
    stage.addChild(this.bonusText);

    this.synergyText = new Text({ text: '', style: textStyle(14, '#7affc0', 'bold') });
    this.synergyText.position.set(20, 380);
    stage.addChild(this.synergyText);

    this.logText = new Text({ text: '', style: textStyle(12, '#c8c8d8') });
    this.logText.position.set(20, 20);
    stage.addChild(this.logText);

    this.drawFloor();
  }

  static async create(container: HTMLElement): Promise<Scene> {
    const app = new Application();
    await app.init({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, background: '#101018', antialias: true });
    container.appendChild(app.canvas);
    return new Scene(app);
  }

  private drawFloor(): void {
    this.floor.clear();
    this.floor.moveTo(ARENA_MARGIN, FLOOR_Y + ACTOR_RADIUS + 10);
    this.floor.lineTo(SCREEN_WIDTH - ARENA_MARGIN, FLOOR_Y + ACTOR_RADIUS + 10);
    this.floor.stroke({ color: '#33334a', width: 2 });
  }

  render(state: GameState, events: readonly GameEvent[]): void {
    for (const event of events) {
      const line = eventToLogLine(event);
      if (line) this.logLines.push(line);
    }
    while (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    this.logText.text = this.logLines.join('\n');

    this.drawActor(this.playerGfx, state.combat.player.position, '#4ea1ff');
    this.drawHealthAndMana(state);
    this.drawActor(this.enemyGfx, state.combat.enemy.position, '#ff5a5a');
    this.drawTelegraph(state);
    this.drawHand(state);

    const activeSynergies = getActiveSynergies(state.deck.hand, SYNERGY_DEFS, CARD_CATALOG);
    this.synergyText.text = activeSynergies.length > 0 ? `Synergy: ${activeSynergies.map((s) => s.id).join(', ')}!` : '';

    this.bonusText.text = state.deck.bonusSlot
      ? `BONUS: ${CARD_CATALOG.get(state.deck.bonusSlot.defId)?.name ?? state.deck.bonusSlot.defId} (B)`
      : '';
  }

  private drawActor(gfx: Graphics, position: number, color: string): void {
    gfx.clear();
    gfx.circle(toScreenX(position), FLOOR_Y, ACTOR_RADIUS);
    gfx.fill({ color });
  }

  private drawHealthAndMana(state: GameState): void {
    const p = state.combat.player;
    const e = state.combat.enemy;
    this.floor.clear();
    this.drawFloor();
    this.drawBar(toScreenX(p.position) - 30, FLOOR_Y - 45, 60, 6, p.health / p.maxHealth, '#5ad65a');
    this.drawBar(toScreenX(p.position) - 30, FLOOR_Y - 36, 60, 4, p.mana / p.maxMana, '#4ea1ff');
    this.drawBar(toScreenX(e.position) - 30, FLOOR_Y - 45, 60, 6, e.health / e.maxHealth, '#ff5a5a');
  }

  private drawBar(x: number, y: number, width: number, height: number, fraction: number, color: string): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    this.floor.rect(x, y, width, height).fill({ color: '#2a2a3a' });
    this.floor.rect(x, y, width * clamped, height).fill({ color });
  }

  private drawTelegraph(state: GameState): void {
    this.telegraphGfx.clear();
    const enemy = state.combat.enemy;
    if (enemy.phase !== 'windup') return;
    const ticksUntilHit = enemy.phaseEndsAtTick - state.combat.tick;
    const progress = 1 - Math.max(0, ticksUntilHit) / ENEMY_WINDUP_TICKS;
    const x = toScreenX(enemy.position);
    this.telegraphGfx.rect(x - 30, FLOOR_Y - 60, 60, 5).fill({ color: '#2a2a3a' });
    this.telegraphGfx.rect(x - 30, FLOOR_Y - 60, 60 * progress, 5).fill({ color: '#ffb347' });
  }

  private drawHand(state: GameState): void {
    state.deck.hand.forEach((card, i) => {
      const slot = this.handSlots[i];
      if (!slot) return;
      slot.box.clear();
      slot.box.roundRect(0, 0, 200, 70, 6).stroke({ color: '#5a5a7a', width: 2 });
      if (card) {
        const def = CARD_CATALOG.get(card.defId);
        slot.text.text = def ? `[${i + 1}] ${def.name}\ncost ${def.cost}  ${def.tags.join(',')}` : card.defId;
      } else {
        slot.text.text = `[${i + 1}] (empty)`;
      }
    });
  }
}
