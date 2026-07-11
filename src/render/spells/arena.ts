import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ENEMY_ATTACK_ARC_COS_SQ,
  ENEMY_ATTACK_RANGE,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_WINDUP_TICKS,
  MAX_ADRENALINE,
  PLAYER_RADIUS,
} from '../../sim/constants.js';
import type { SpellGameEvent, SpellGameState } from '../../game/spell-session.js';
import type { EnemyState, PlayerState, Vec2 } from '../../sim/types.js';

/**
 * Canvas2D arena for the spell game (spec 018). A thin, shape-based view: the
 * whole arena fits the canvas with no camera, so every enemy, telegraph and
 * spell effect is on screen at once. It reads sim state and draws it -- carrying
 * auras, telegraphed AOEs, shields, stuns and dashes straight from the sim's
 * player/enemy fields. No game rules here.
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

interface Flash {
  x: number;
  y: number;
  radius: number;
  life: number;
  max: number;
}

// Transient shapes for instant casts (cone/rect), so a swing reads on screen.
type CastFx =
  | { kind: 'cone'; x: number; y: number; ang: number; range: number; half: number; life: number; max: number }
  | { kind: 'rect'; x: number; y: number; ang: number; length: number; halfWidth: number; life: number; max: number };

const POPUP_LIFE = 42;
const FLASH_LIFE = 18;
const CAST_LIFE = 12;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class SpellArenaView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly popups: Popup[] = [];
  private readonly flashes: Flash[] = [];
  private readonly casts: CastFx[] = [];
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

  render(state: SpellGameState, events: readonly SpellGameEvent[], aim: ScreenPoint): void {
    this.frame++;
    const combat = state.combat;
    this.ingestEvents(combat.player, events);

    this.drawField();
    this.drawGroundFires(combat.player);
    this.drawPendingAoes(combat.player, combat.tick);
    for (const enemy of combat.enemies) this.drawTelegraph(enemy, combat.tick);
    for (const enemy of combat.enemies) this.drawEnemy(enemy, combat.tick, combat.player.position);
    this.drawAuras(combat.player, combat.tick);
    this.updateAndDrawCasts();
    this.drawPlayer(combat.player, combat.tick, aim);
    this.updateAndDrawFlashes();
    this.updateAndDrawPopups();
  }

  private ingestEvents(player: PlayerState, events: readonly SpellGameEvent[]): void {
    for (const e of events) {
      if (e.kind === 'enemyHit') this.spawn(this.worldToScreen(e.at), `${e.damage}`, '#ffe08a', -0.9);
      else if (e.kind === 'playerHit') this.spawn(this.worldToScreen(player.position), `-${e.damage}`, '#ff6b6b', -1.0);
      else if (e.kind === 'playerHealed') this.spawn(this.worldToScreen(player.position), `+${e.amount}`, '#7affc0', -1.0);
      else if (e.kind === 'aoeImpact') {
        const at = this.worldToScreen(e.at);
        this.flashes.push({ x: at.x, y: at.y, radius: e.radius * SCALE, life: FLASH_LIFE, max: FLASH_LIFE });
      } else if (e.kind === 'spellsResolved') {
        const origin = this.worldToScreen(player.position);
        const ang = Math.atan2(e.aimY, e.aimX);
        for (const spec of e.specs) {
          if (spec.kind === 'cone') {
            this.casts.push({ kind: 'cone', x: origin.x, y: origin.y, ang, range: spec.range * SCALE, half: Math.acos(Math.sqrt(spec.arcCosSq)), life: CAST_LIFE, max: CAST_LIFE });
          } else if (spec.kind === 'rect') {
            this.casts.push({ kind: 'rect', x: origin.x, y: origin.y, ang, length: spec.length * SCALE, halfWidth: spec.halfWidth * SCALE, life: CAST_LIFE, max: CAST_LIFE });
          }
        }
        if (e.ids.length >= 2) this.spawn(origin, 'SYNERGY!', '#ffd76a', -1.3);
      } else if (e.kind === 'adrenalineChanged') {
        const at = this.worldToScreen(player.position);
        if (e.delta > 0) this.spawn(at, '+ADR', '#ff8a5a', -1.1);
        else this.spawn(at, 'ADRENALINE!', '#ff5a3a', -1.4);
      } else if (e.kind === 'playRejectedNoAdrenaline') {
        this.spawn(this.worldToScreen(player.position), 'NEED ADR', '#ff6b6b', -1.0);
      }
    }
  }

  private spawn(at: ScreenPoint, text: string, color: string, vy: number): void {
    this.popups.push({ x: at.x + (this.frame % 7) - 3, y: at.y - 20, text, color, life: POPUP_LIFE, vy });
  }

  private drawField(): void {
    const { ctx } = this;
    const cell = 64 * SCALE;
    for (let y = 0; y < CANVAS_H; y += cell) {
      for (let x = 0; x < CANVAS_W; x += cell) {
        const even = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
        ctx.fillStyle = even ? '#242433' : '#28283a';
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.strokeStyle = '#12121c';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);
  }

  private drawPendingAoes(player: PlayerState, tick: number): void {
    const { ctx } = this;
    for (const aoe of player.pendingAoes) {
      const c = this.worldToScreen({ x: aoe.x, y: aoe.y });
      const r = aoe.radius * SCALE;
      const remaining = Math.max(0, aoe.impactTick - tick);
      const total = Math.max(1, aoe.impactTick - (aoe.impactTick - 30)); // ~telegraph length
      const progress = 1 - remaining / total;
      const warm = aoe.stunTicks > 0 ? '120,180,255' : '255,120,40';
      ctx.fillStyle = `rgba(${warm},${0.08 + 0.2 * progress})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${warm},0.9)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * (0.15 + 0.85 * progress), 0, Math.PI * 2); // closing ring = time to impact
      ctx.stroke();
    }
  }

  private drawAuras(player: PlayerState, tick: number): void {
    const { ctx } = this;
    const p = this.worldToScreen(player.position);
    for (const aura of player.auras) {
      if (tick >= aura.expiresAtTick) continue;
      const r = aura.radius * SCALE;
      const pulse = 0.5 + 0.5 * Math.sin(this.frame * 0.35);
      ctx.fillStyle = `rgba(255,110,40,${0.06 + 0.06 * pulse})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,150,60,${0.35 + 0.25 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawGroundFires(player: PlayerState): void {
    const { ctx } = this;
    for (const f of player.groundFires) {
      const c = this.worldToScreen({ x: f.x, y: f.y });
      const r = f.radius * SCALE;
      const flick = 0.5 + 0.5 * Math.sin(this.frame * 0.4 + f.x * 0.05);
      ctx.fillStyle = `rgba(230,90,30,${0.14 + 0.1 * flick})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,160,60,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * (0.7 + 0.2 * flick), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private updateAndDrawCasts(): void {
    const { ctx } = this;
    for (let i = this.casts.length - 1; i >= 0; i--) {
      const fx = this.casts[i];
      if (!fx) continue;
      fx.life -= 1;
      if (fx.life <= 0) {
        this.casts.splice(i, 1);
        continue;
      }
      const t = fx.life / fx.max;
      ctx.globalAlpha = t * 0.55;
      ctx.fillStyle = '#ffe6b0';
      if (fx.kind === 'cone') {
        ctx.beginPath();
        ctx.moveTo(fx.x, fx.y);
        ctx.arc(fx.x, fx.y, fx.range, fx.ang - fx.half, fx.ang + fx.half);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(fx.x, fx.y);
        ctx.rotate(fx.ang);
        ctx.fillRect(0, -fx.halfWidth, fx.length, fx.halfWidth * 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
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
  }

  private drawEnemy(enemy: EnemyState, tick: number, playerPos: Vec2): void {
    const { ctx } = this;
    const p = this.worldToScreen(enemy.position);
    const r = ENEMY_RADIUS * SCALE;
    const color = ENEMY_COLORS[enemy.type] ?? '#c07070';
    const stunned = (enemy.stunnedUntilTick ?? 0) > tick;

    ctx.globalAlpha = enemy.behavior === 'grazing' ? 0.75 : 1;
    ctx.fillStyle = stunned ? '#6f7590' : color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    const dir = norm({ x: playerPos.x - enemy.position.x, y: playerPos.y - enemy.position.y });
    ctx.fillStyle = '#1a1208';
    ctx.beginPath();
    ctx.arc(p.x + dir.x * r * 0.5, p.y + dir.y * r * 0.5, r * 0.22, 0, Math.PI * 2);
    ctx.fill();

    if (stunned) {
      // Little orbiting "stars" to read the stun at a glance.
      ctx.fillStyle = '#ffe08a';
      for (let i = 0; i < 3; i++) {
        const a = this.frame * 0.15 + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(a) * (r + 6), p.y - r - 4 + Math.sin(a) * 3, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (enemy.behavior === 'hunting') {
      const total = enemy.phase === 'idle' ? ENEMY_IDLE_TICKS : enemy.phase === 'windup' ? ENEMY_WINDUP_TICKS : ENEMY_RECOVERY_TICKS;
      const prog = 1 - Math.max(0, enemy.phaseEndsAtTick - tick) / total;
      const ring = enemy.phase === 'windup' ? '#ff8c1a' : enemy.phase === 'recovery' ? '#7a5a5a' : '#d0605a';
      strokeArc(ctx, p.x, p.y, r + 5, prog, ring);
    }

    // Burning condition: a licking ember over the body.
    if ((enemy.burningUntilTick ?? 0) > tick) {
      ctx.fillStyle = `rgba(255,110,40,${0.45 + 0.4 * Math.sin(this.frame * 0.4 + enemy.id)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y - r - 2, 3 + Math.sin(this.frame * 0.5 + enemy.id), 0, Math.PI * 2);
      ctx.fill();
    }

    this.healthBar(p.x - r, p.y - r - 12, r * 2, enemy.health / enemy.maxHealth, enemy.behavior === 'hunting' ? '#ff5a5a' : '#8fbf6a');
  }

  private drawPlayer(player: PlayerState, tick: number, aim: ScreenPoint): void {
    const { ctx } = this;
    const p = this.worldToScreen(player.position);
    const r = PLAYER_RADIUS * SCALE;
    const ang = Math.atan2(aim.y, aim.x);

    // Dash streak.
    if (tick < player.dashExpiresAtTick) {
      ctx.strokeStyle = 'rgba(180,220,255,0.55)';
      ctx.lineWidth = r * 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - player.dashDx * SCALE * 3, p.y - player.dashDy * SCALE * 3);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Mis-timed window slow: a sluggish violet drag ring with sinking motes.
    if (tick < player.moveSlowUntilTick) {
      ctx.strokeStyle = 'rgba(150,120,210,0.7)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(150,120,210,0.8)';
      for (let i = 0; i < 3; i++) {
        const t = ((this.frame * 0.04 + i / 3) % 1);
        ctx.globalAlpha = 1 - t;
        ctx.beginPath();
        ctx.arc(p.x - r + i * r, p.y - r + t * (r * 2.4), 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Burning Speed: a warm haste ring and flickering self-burn embers.
    if (tick < player.moveHasteUntilTick) {
      ctx.strokeStyle = 'rgba(255,150,60,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (tick < player.burningUntilTick) {
      ctx.fillStyle = `rgba(255,120,40,${0.5 + 0.4 * Math.sin(this.frame * 0.5)})`;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(p.x - r + i * r, p.y - r - 3, 2.4 + Math.sin(this.frame * 0.3 + i), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Adrenaline: a heat glow around the player that grows with the banked charge,
    // plus a small ember pip per point over the head, so the resource reads in-arena.
    if (player.adrenaline > 0) {
      const frac = player.adrenaline / MAX_ADRENALINE;
      const pulse = 0.5 + 0.5 * Math.sin(this.frame * 0.22);
      ctx.strokeStyle = `rgba(255,${Math.round(120 - 60 * frac)},50,${0.35 + 0.4 * frac * pulse})`;
      ctx.lineWidth = 2 + 3 * frac;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5 + 3 * frac, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ff6a3a';
      for (let i = 0; i < player.adrenaline; i++) {
        ctx.beginPath();
        ctx.arc(p.x - (player.adrenaline - 1) * 3.5 + i * 7, p.y - r - 26, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Shield ring.
    if (tick < player.shieldExpiresAtTick && player.shieldAmount > 0) {
      ctx.strokeStyle = '#8fd0ff';
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this.frame * 0.18);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = '#e8eef7';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#9fb7d4';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(ang) * r * 1.6, p.y + Math.sin(ang) * r * 1.6);
    ctx.stroke();

    this.healthBar(p.x - r - 4, p.y - r - 14, r * 2 + 8, player.health / player.maxHealth, '#5ad65a');

    // Conjure Flame charges: a small orange pip per remaining buffed attack.
    if (player.attackFlameCharges > 0) {
      ctx.fillStyle = '#ff9b3a';
      for (let i = 0; i < player.attackFlameCharges; i++) {
        ctx.beginPath();
        ctx.arc(p.x - (player.attackFlameCharges - 1) * 3 + i * 6, p.y - r - 20, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private healthBar(x: number, y: number, w: number, frac: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = '#0c0c14';
    ctx.fillRect(x, y, w, 5);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), 5);
  }

  private updateAndDrawFlashes(): void {
    const { ctx } = this;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      if (!f) continue;
      f.life -= 1;
      if (f.life <= 0) {
        this.flashes.splice(i, 1);
        continue;
      }
      const t = f.life / f.max;
      ctx.globalAlpha = t * 0.8;
      ctx.fillStyle = '#ffd27a';
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.radius * (1.1 - t * 0.3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
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
