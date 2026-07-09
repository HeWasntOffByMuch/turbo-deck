import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ENEMY_ATTACK_ARC_COS_SQ,
  ENEMY_ATTACK_RANGE,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_WINDUP_TICKS,
  NORMAL_WINDOW_TICKS,
  PERFECT_WINDOW_TICKS,
  PLAYER_ATTACK_RANGE,
  PLAYER_ATTACK_WINDUP_TICKS,
  PLAYER_RADIUS,
} from '../../sim/constants.js';
import type { ComboEvent, ComboGameState } from '../../game/combo-session.js';
import type { EnemyState, PlayerState, Vec2 } from '../../sim/types.js';

/**
 * Canvas2D arena for the poker-combo prototype (spec 014). Deliberately a thin,
 * shape-based view: the whole arena is fit into the canvas with no camera, so
 * every enemy and every telegraph is on screen at once. It reads sim state and
 * draws it -- no game rules live here. The card economy is rendered by the DOM
 * HUD; this module only paints the fight.
 */

export const SCALE = 0.75;
export const CANVAS_W = Math.round(ARENA_WIDTH * SCALE);
export const CANVAS_H = Math.round(ARENA_HEIGHT * SCALE);

const ENEMY_COLORS: Readonly<Record<string, string>> = {
  brawler: '#c9683f',
  skitter: '#5fb4d6',
  brute: '#9a5ad0',
};

interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  vy: number;
}

const POPUP_LIFE = 42;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class ArenaView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly popups: Popup[] = [];
  private frame = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
  }

  worldToScreen(v: Vec2): ScreenPoint {
    return { x: v.x * SCALE, y: v.y * SCALE };
  }

  render(state: ComboGameState, events: readonly ComboEvent[], aim: ScreenPoint): void {
    this.frame++;
    const { ctx } = this;
    const combat = state.combat;

    this.ingestEvents(combat.player, events);

    this.drawField();
    for (const enemy of combat.enemies) this.drawTelegraph(enemy, combat.tick);
    for (const enemy of combat.enemies) this.drawEnemy(enemy, combat.tick, combat.player.position);
    this.drawPlayer(combat.player, combat.tick, aim);
    this.drawSlowVeil(combat.tick, combat.enemySlowExpiresAtTick);
    this.updateAndDrawPopups();

    void ctx; // ctx used throughout via helpers
  }

  private ingestEvents(player: PlayerState, events: readonly ComboEvent[]): void {
    for (const e of events) {
      if (e.kind === 'enemyHit') this.spawn(this.worldToScreen(e.at), `${e.damage}`, '#ffe08a', -0.9);
      else if (e.kind === 'playerHit') this.spawn(this.worldToScreen(player.position), `-${e.damage}`, '#ff6b6b', -1.0);
      else if (e.kind === 'playerHealed') this.spawn(this.worldToScreen(player.position), `+${e.amount}`, '#7affc0', -1.0);
      else if (e.kind === 'perfectDefense') this.spawn(this.worldToScreen(player.position), 'PERFECT', '#7affc0', -1.2);
      else if (e.kind === 'stanceApplied') this.spawn(this.worldToScreen(player.position), 'STANCE!', '#ffd76a', -1.2);
    }
  }

  private spawn(at: ScreenPoint, text: string, color: string, vy: number): void {
    this.popups.push({ x: at.x + (this.frame % 7) - 3, y: at.y - 20, text, color, life: POPUP_LIFE, vy });
  }

  private drawField(): void {
    const { ctx } = this;
    ctx.fillStyle = '#26361f';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    // Subtle mowed-lawn checker.
    const cell = 64 * SCALE;
    for (let y = 0; y < CANVAS_H; y += cell) {
      for (let x = 0; x < CANVAS_W; x += cell) {
        const even = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
        ctx.fillStyle = even ? '#2c3d23' : '#2f4226';
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.strokeStyle = '#18240f';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);
  }

  private drawTelegraph(enemy: EnemyState, tick: number): void {
    if (enemy.behavior !== 'hunting' || enemy.phase !== 'windup' || !enemy.attackAim) return;
    const { ctx } = this;
    const apex = this.worldToScreen(enemy.position);
    const range = ENEMY_ATTACK_RANGE * SCALE;
    const ang = Math.atan2(enemy.attackAim.y, enemy.attackAim.x);
    const half = Math.acos(Math.sqrt(ENEMY_ATTACK_ARC_COS_SQ));
    const remaining = Math.max(0, enemy.phaseEndsAtTick - tick);
    const progress = 1 - remaining / ENEMY_WINDUP_TICKS;
    ctx.fillStyle = `rgba(255,140,26,${0.12 + 0.35 * progress})`;
    ctx.beginPath();
    ctx.moveTo(apex.x, apex.y);
    ctx.arc(apex.x, apex.y, range, ang - half, ang + half);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(apex.x, apex.y);
    ctx.arc(apex.x, apex.y, range * (1 - progress), ang - half, ang + half); // shrinking = time to slam
    ctx.closePath();
    ctx.stroke();
  }

  private drawEnemy(enemy: EnemyState, tick: number, playerPos: Vec2): void {
    const { ctx } = this;
    const p = this.worldToScreen(enemy.position);
    const r = ENEMY_RADIUS * SCALE;
    const color = ENEMY_COLORS[enemy.type] ?? '#c07070';

    // Body, dimmed while grazing.
    ctx.globalAlpha = enemy.behavior === 'grazing' ? 0.75 : 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Facing pip toward the player.
    const dir = norm({ x: playerPos.x - enemy.position.x, y: playerPos.y - enemy.position.y });
    ctx.fillStyle = '#1a1208';
    ctx.beginPath();
    ctx.arc(p.x + dir.x * r * 0.5, p.y + dir.y * r * 0.5, r * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Phase ring (hunting cadence).
    if (enemy.behavior === 'hunting') {
      const total = enemy.phase === 'idle' ? ENEMY_IDLE_TICKS : enemy.phase === 'windup' ? ENEMY_WINDUP_TICKS : ENEMY_RECOVERY_TICKS;
      const prog = 1 - Math.max(0, enemy.phaseEndsAtTick - tick) / total;
      const ring = enemy.phase === 'windup' ? '#ff8c1a' : enemy.phase === 'recovery' ? '#7a5a5a' : '#d0605a';
      strokeArc(ctx, p.x, p.y, r + 5, prog, ring);
    }

    this.healthBar(p.x - r, p.y - r - 12, r * 2, enemy.health / enemy.maxHealth, enemy.behavior === 'hunting' ? '#ff5a5a' : '#8fbf6a');
  }

  private drawPlayer(player: PlayerState, tick: number, aim: ScreenPoint): void {
    const { ctx } = this;
    const p = this.worldToScreen(player.position);
    const r = PLAYER_RADIUS * SCALE;
    const ang = Math.atan2(aim.y, aim.x);

    // Stance aura ring, colored by the dominant active stat.
    if (tick < player.stanceExpiresAtTick) {
      const c = dominantStanceColor(player);
      ctx.strokeStyle = c;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this.frame * 0.2);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Guard flash.
    if (tick < player.guardExpiresAtTick) {
      ctx.strokeStyle = '#7fd6ff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Swing arc during windup / follow-through.
    if (player.attackReleaseTick !== 0) {
      const charge = 1 - Math.max(0, player.attackReleaseTick - tick) / PLAYER_ATTACK_WINDUP_TICKS;
      const reach = PLAYER_ATTACK_RANGE * SCALE * (0.5 + 0.5 * charge);
      const half = (Math.PI / 4) * (0.6 + 0.4 * charge);
      const swingAng = Math.atan2(player.attackAimY, player.attackAimX);
      ctx.fillStyle = `rgba(191,224,255,${0.15 + 0.25 * charge})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.arc(p.x, p.y, reach, swingAng - half, swingAng + half);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = '#e8eef7';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Aim indicator.
    ctx.strokeStyle = '#9fb7d4';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(ang) * r * 1.6, p.y + Math.sin(ang) * r * 1.6);
    ctx.stroke();

    this.healthBar(p.x - r - 4, p.y - r - 14, r * 2 + 8, player.health / player.maxHealth, '#5ad65a');

    // Parry prompt near the player when a slam is imminent.
    // (drawn by the HUD's banner too, but the in-arena cue helps timing.)
  }

  private drawSlowVeil(tick: number, slowUntil: number): void {
    if (tick >= slowUntil) return;
    const { ctx } = this;
    ctx.fillStyle = 'rgba(120,90,200,0.10)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  private healthBar(x: number, y: number, w: number, frac: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = '#0c0c14';
    ctx.fillRect(x, y, w, 5);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), 5);
  }

  private updateAndDrawPopups(): void {
    const { ctx } = this;
    ctx.font = 'bold 15px monospace';
    ctx.textAlign = 'center';
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const pop = this.popups[i];
      if (!pop) continue;
      pop.life -= 1;
      pop.y += pop.vy;
      if (pop.life <= 0) {
        this.popups.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(0, pop.life / POPUP_LIFE);
      ctx.fillStyle = pop.color;
      ctx.fillText(pop.text, pop.x, pop.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}

/** Which stance stat is strongest right now, for the aura color. */
function dominantStanceColor(player: PlayerState): string {
  const stats: readonly [number, string][] = [
    [player.stanceAttackBonus / 20, '#ff6b6b'],
    [player.stanceReductionPct / 0.7, '#7fd6ff'],
    [player.stanceRegenPerTick, '#7affc0'],
  ];
  let best = stats[0] as [number, string];
  for (const s of stats) if (s[0] > best[0]) best = s;
  return best[1];
}

function norm(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-4 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len };
}

function strokeArc(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, progress: number, color: string): void {
  const clamped = Math.max(0, Math.min(1, progress));
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2);
  ctx.stroke();
}

/** Timing windows exposed so the HUD can show a matching parry prompt. */
export const DEFENSE_WINDOWS = { perfect: PERFECT_WINDOW_TICKS, normal: NORMAL_WINDOW_TICKS };
