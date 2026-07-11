import {
  ENEMY_ATTACK_ARC_COS_SQ,
  ENEMY_ATTACK_RANGE,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_WINDUP_TICKS,
  MAX_ADRENALINE,
  PLAYER_RADIUS,
} from '../../sim/constants.js';
import { TILE, tileAt, roomCenterWorld, type Dungeon, type Room } from '../../sim/dungeon.js';
import type { DungeonGameEvent, DungeonGameState } from '../../game/dungeon-session.js';
import type { EnemyState, PlayerState, Vec2 } from '../../sim/types.js';
import { DudeSkins, PLAYER_SKIN } from '../spells/dudes.js';
import { DIRT, DOOR_PLATE, FLOOR_THEMES, pickVariant, themeForSeed, VOID, WALL, type FloorTheme } from './atlas-map.js';
import { DungeonTileset } from './tileset.js';

export const CANVAS_W = 960;
export const CANVAS_H = 672;
/** World units map 1:1 to screen px; the camera follows and clamps to bounds. */
const SCALE = 1;
const CAMERA_LAG = 0.12;

interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}
interface Flash {
  x: number;
  y: number;
  radius: number;
  life: number;
  max: number;
}
// Transient shapes for instant spell casts (cone/rect), in world space.
type CastFx =
  | { kind: 'cone'; x: number; y: number; ang: number; range: number; half: number; life: number; max: number }
  | { kind: 'rect'; x: number; y: number; ang: number; length: number; halfWidth: number; life: number; max: number };

const POPUP_LIFE = 42;
const FLASH_LIFE = 18;
const CAST_LIFE = 12;

// Flat-colour fallbacks used until the tileset PNG finishes loading.
const FALLBACK = {
  void: '#0c0c14',
  wall: '#3a3a52',
  floorRoom: '#6f7fa0',
  floorCorridor: '#6b4a34',
  door: '#9fb0c8',
} as const;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class DungeonView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tileset = new DungeonTileset();
  private readonly dudes = new DudeSkins();
  private readonly popups: Popup[] = [];
  private readonly flashes: Flash[] = [];
  private readonly casts: CastFx[] = [];
  private cam: Vec2 = { x: 0, y: 0 };
  private frame = 0;
  private theme: FloorTheme = 'blue';
  private cols = 0;
  private readonly roomCells = new Set<number>();
  private initialized = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
  }

  private ensureInit(d: Dungeon): void {
    if (this.initialized) return;
    this.theme = themeForSeed(d.seed);
    this.cols = d.cols;
    for (const room of d.rooms) {
      for (let cy = room.y; cy < room.y + room.h; cy++) {
        for (let cx = room.x; cx < room.x + room.w; cx++) this.roomCells.add(cy * d.cols + cx);
      }
    }
    const entry = d.rooms[d.entryRoomId];
    if (entry) this.cam = roomCenterWorld(entry);
    this.initialized = true;
  }

  private isRoomCell(cx: number, cy: number): boolean {
    return this.roomCells.has(cy * this.cols + cx);
  }

  worldToScreen(v: Vec2): ScreenPoint {
    return { x: (v.x - this.cam.x) * SCALE + CANVAS_W / 2, y: (v.y - this.cam.y) * SCALE + CANVAS_H / 2 };
  }

  /** The world point under a screen point (for aimed spell targets). */
  screenToWorld(s: ScreenPoint): Vec2 {
    return { x: (s.x - CANVAS_W / 2) / SCALE + this.cam.x, y: (s.y - CANVAS_H / 2) / SCALE + this.cam.y };
  }

  render(state: DungeonGameState, events: readonly DungeonGameEvent[], aim: ScreenPoint): void {
    this.frame++;
    const d = state.dungeon;
    this.ensureInit(d);
    const combat = state.spell.combat;
    this.ingestEvents(combat.player, events);

    const p = combat.player.position;
    this.cam = { x: this.cam.x + (p.x - this.cam.x) * CAMERA_LAG, y: this.cam.y + (p.y - this.cam.y) * CAMERA_LAG };
    this.clampCamera(d);

    this.drawTiles(state);
    this.drawGroundFires(combat.player);
    this.drawPendingAoes(combat.player, combat.tick);
    for (const enemy of combat.enemies) this.drawTelegraph(enemy);
    for (const enemy of combat.enemies) this.drawEnemy(enemy, combat.tick);
    this.drawAuras(combat.player, combat.tick);
    this.updateAndDrawCasts();
    this.drawPlayer(combat.player, combat.tick, aim);
    this.updateAndDrawFlashes();
    this.updateAndDrawPopups();
    this.drawHud(state);
  }

  private clampCamera(d: Dungeon): void {
    const worldW = d.cols * TILE;
    const worldH = d.rows * TILE;
    const halfW = CANVAS_W / 2 / SCALE;
    const halfH = CANVAS_H / 2 / SCALE;
    this.cam = {
      x: worldW < halfW * 2 ? worldW / 2 : Math.max(halfW, Math.min(worldW - halfW, this.cam.x)),
      y: worldH < halfH * 2 ? worldH / 2 : Math.max(halfH, Math.min(worldH - halfH, this.cam.y)),
    };
  }

  private ingestEvents(player: PlayerState, events: readonly DungeonGameEvent[]): void {
    for (const e of events) {
      if (e.kind === 'enemyHit') this.spawnPopup(e.at, `${e.damage}`, '#ffe08a');
      else if (e.kind === 'playerHit') this.spawnPopup(player.position, `-${e.damage}`, '#ff6b6b');
      else if (e.kind === 'playerHealed') this.spawnPopup(player.position, `+${e.amount}`, '#7affc0');
      else if (e.kind === 'roomEntered') this.spawnPopup(player.position, 'SEALED!', '#ff9b3a');
      else if (e.kind === 'roomCleared') this.spawnPopup(player.position, 'CLEARED!', '#7affc0');
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
        if (e.ids.length >= 2) this.spawnPopup(player.position, 'SYNERGY!', '#ffd76a');
      } else if (e.kind === 'adrenalineChanged') {
        this.spawnPopup(player.position, e.delta > 0 ? '+ADR' : 'ADRENALINE!', e.delta > 0 ? '#ff8a5a' : '#ff5a3a');
      } else if (e.kind === 'playRejectedNoAdrenaline') {
        this.spawnPopup(player.position, 'NEED ADR', '#ff6b6b');
      }
    }
  }

  private spawnPopup(world: Vec2, text: string, color: string): void {
    this.popups.push({ x: world.x + (this.frame % 7) - 3, y: world.y - 24, text, color, life: POPUP_LIFE });
  }

  private drawTiles(state: DungeonGameState): void {
    const { ctx } = this;
    const d = state.dungeon;
    ctx.fillStyle = FALLBACK.void;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const activeRoom = state.activeRoomId === null ? null : d.rooms[state.activeRoomId] ?? null;
    const sealed = new Set<number>();
    if (activeRoom) for (const dr of activeRoom.doors) sealed.add(dr.cy * d.cols + dr.cx);

    const minCx = Math.floor((this.cam.x - CANVAS_W / 2 / SCALE) / TILE) - 1;
    const maxCx = Math.floor((this.cam.x + CANVAS_W / 2 / SCALE) / TILE) + 1;
    const minCy = Math.floor((this.cam.y - CANVAS_H / 2 / SCALE) / TILE) - 1;
    const maxCy = Math.floor((this.cam.y + CANVAS_H / 2 / SCALE) / TILE) + 1;
    const size = TILE * SCALE + 1; // +1 avoids seams between tiles

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const kind = tileAt(d, cx, cy);
        const screen = this.worldToScreen({ x: cx * TILE, y: cy * TILE });
        const isSealed = kind === 'door' && sealed.has(cy * d.cols + cx);
        this.drawCell(kind, cx, cy, screen.x, screen.y, size, isSealed);
      }
    }

    this.tintRoom(d.rooms[d.entryRoomId], 80, 220, 120);
    this.tintRoom(d.rooms[d.exitRoomId], 240, 200, 70);
  }

  private drawCell(kind: string, cx: number, cy: number, dx: number, dy: number, size: number, sealed: boolean): void {
    const { ctx } = this;
    if (!this.tileset.ready) {
      let color: string = FALLBACK.void;
      if (kind === 'wall') color = FALLBACK.wall;
      else if (kind === 'door') color = sealed ? FALLBACK.wall : FALLBACK.door;
      else if (kind === 'floor') color = this.isRoomCell(cx, cy) ? FALLBACK.floorRoom : FALLBACK.floorCorridor;
      ctx.fillStyle = color;
      ctx.fillRect(dx, dy, size, size);
      if (kind === 'door' && sealed) this.barDoor(dx, dy, size);
      return;
    }
    if (kind === 'void') this.tileset.draw(ctx, VOID, dx, dy, size);
    else if (kind === 'wall') this.tileset.draw(ctx, pickVariant(WALL, cx, cy), dx, dy, size);
    else if (kind === 'door') {
      if (sealed) {
        this.tileset.draw(ctx, pickVariant(WALL, cx, cy), dx, dy, size);
        this.barDoor(dx, dy, size);
      } else {
        this.tileset.draw(ctx, DOOR_PLATE, dx, dy, size);
      }
    } else {
      const list = this.isRoomCell(cx, cy) ? FLOOR_THEMES[this.theme] : DIRT;
      this.tileset.draw(ctx, pickVariant(list, cx, cy), dx, dy, size);
    }
  }

  private barDoor(dx: number, dy: number, size: number): void {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(220,60,50,0.28)';
    ctx.fillRect(dx, dy, size, size);
    ctx.strokeStyle = 'rgba(255,90,70,0.85)';
    ctx.lineWidth = 3;
    for (let i = 1; i <= 3; i++) {
      const x = dx + (size * i) / 4;
      ctx.beginPath();
      ctx.moveTo(x, dy + 3);
      ctx.lineTo(x, dy + size - 3);
      ctx.stroke();
    }
  }

  private tintRoom(room: Room | undefined, r: number, g: number, b: number): void {
    if (!room) return;
    const { ctx } = this;
    const tl = this.worldToScreen({ x: room.x * TILE, y: room.y * TILE });
    ctx.fillStyle = `rgba(${r},${g},${b},0.16)`;
    ctx.fillRect(tl.x, tl.y, room.w * TILE * SCALE, room.h * TILE * SCALE);
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

  private drawPendingAoes(player: PlayerState, tick: number): void {
    const { ctx } = this;
    for (const aoe of player.pendingAoes) {
      const c = this.worldToScreen({ x: aoe.x, y: aoe.y });
      const r = aoe.radius * SCALE;
      const remaining = Math.max(0, aoe.impactTick - tick);
      const progress = 1 - remaining / 30;
      const warm = aoe.stunTicks > 0 ? '120,180,255' : '255,120,40';
      ctx.fillStyle = `rgba(${warm},${0.08 + 0.2 * progress})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${warm},0.9)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * (0.15 + 0.85 * Math.max(0, Math.min(1, progress))), 0, Math.PI * 2);
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

  private drawTelegraph(enemy: EnemyState): void {
    if (enemy.behavior !== 'hunting' || enemy.phase !== 'windup' || !enemy.attackAim) return;
    const { ctx } = this;
    const apex = this.worldToScreen(enemy.position);
    const range = ENEMY_ATTACK_RANGE * SCALE;
    const ang = Math.atan2(enemy.attackAim.y, enemy.attackAim.x);
    const half = Math.acos(Math.sqrt(ENEMY_ATTACK_ARC_COS_SQ));
    ctx.fillStyle = 'rgba(255,140,26,0.28)';
    ctx.beginPath();
    ctx.moveTo(apex.x, apex.y);
    ctx.arc(apex.x, apex.y, range, ang - half, ang + half);
    ctx.closePath();
    ctx.fill();
  }

  private drawEnemy(enemy: EnemyState, tick: number): void {
    const { ctx } = this;
    const p = this.worldToScreen(enemy.position);
    const r = ENEMY_RADIUS * SCALE;
    const size = r * 2.4;
    const half = size / 2;
    const feet = p.y + half;
    const headTop = p.y - half;
    const stunned = (enemy.stunnedUntilTick ?? 0) > tick;
    const frame = enemy.phase === 'windup' ? 'windup' : 'idle';

    this.groundShadow(p.x, feet - r * 0.1, r * 0.95);
    if (!stunned && enemy.behavior === 'hunting') {
      const total = enemy.phase === 'idle' ? ENEMY_IDLE_TICKS : enemy.phase === 'windup' ? ENEMY_WINDUP_TICKS : ENEMY_RECOVERY_TICKS;
      const prog = 1 - Math.max(0, enemy.phaseEndsAtTick - tick) / total;
      const ring = enemy.phase === 'windup' ? '#ff8c1a' : enemy.phase === 'recovery' ? '#7a5a5a' : '#d0605a';
      this.groundRing(p.x, feet - r * 0.1, r * 0.95, prog, ring);
    }
    this.dudes.draw(ctx, enemy.type, frame, p.x, p.y, size, false, stunned ? 0.6 : 1);
    if ((enemy.burningUntilTick ?? 0) > tick) {
      ctx.fillStyle = `rgba(255,110,40,${0.45 + 0.4 * Math.sin(this.frame * 0.4 + enemy.id)})`;
      ctx.beginPath();
      ctx.arc(p.x, headTop - 5, 3 + Math.sin(this.frame * 0.5 + enemy.id), 0, Math.PI * 2);
      ctx.fill();
    }
    this.healthBar(p.x - r, headTop - 8, r * 2, enemy.health / enemy.maxHealth, '#ff5a5a');
  }

  private drawPlayer(player: PlayerState, tick: number, aim: ScreenPoint): void {
    const { ctx } = this;
    const p = this.worldToScreen(player.position);
    const r = PLAYER_RADIUS * SCALE;
    const size = r * 2.7;
    const half = size / 2;
    const feet = p.y + half;
    const headTop = p.y - half;
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
    // Mis-timed slow ring.
    if (tick < player.moveSlowUntilTick) {
      ctx.strokeStyle = 'rgba(150,120,210,0.7)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Burning Speed haste ring + self-burn embers.
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
    // Adrenaline heat glow + ember pips.
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
        ctx.arc(p.x - (player.adrenaline - 1) * 3.5 + i * 7, headTop - 15, 2.6, 0, Math.PI * 2);
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

    this.groundShadow(p.x, feet - r * 0.1, r);
    this.dudes.draw(ctx, PLAYER_SKIN, 'idle', p.x, p.y, size, aim.x < 0);

    ctx.strokeStyle = 'rgba(159,183,212,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(ang) * r * 1.1, p.y + Math.sin(ang) * r * 1.1);
    ctx.lineTo(p.x + Math.cos(ang) * r * 2.1, p.y + Math.sin(ang) * r * 2.1);
    ctx.stroke();

    this.healthBar(p.x - r - 4, headTop - 9, r * 2 + 8, player.health / player.maxHealth, '#5ad65a');

    // Conjure Flame charges.
    if (player.attackFlameCharges > 0) {
      ctx.fillStyle = '#ff9b3a';
      for (let i = 0; i < player.attackFlameCharges; i++) {
        ctx.beginPath();
        ctx.arc(p.x - (player.attackFlameCharges - 1) * 3 + i * 6, headTop - 22, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private groundShadow(cx: number, cy: number, rx: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, rx * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private groundRing(cx: number, cy: number, rx: number, progress: number, color: string): void {
    const { ctx } = this;
    const clamped = Math.max(0, Math.min(1, progress));
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, rx * 0.4, 0, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2);
    ctx.stroke();
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
      pop.y -= 0.9;
      if (pop.life <= 0) {
        this.popups.splice(i, 1);
        continue;
      }
      const s = this.worldToScreen({ x: pop.x, y: pop.y });
      ctx.globalAlpha = Math.max(0, pop.life / POPUP_LIFE);
      ctx.fillStyle = pop.color;
      ctx.fillText(pop.text, s.x, s.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  private drawHud(state: DungeonGameState): void {
    const { ctx } = this;
    const combatRooms = state.dungeon.rooms.filter((r) => r.kind === 'combat');
    const cleared = combatRooms.filter((r) => state.roomStatus[r.id] === 'cleared').length;

    ctx.font = 'bold 14px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(10, 10, 208, 30);
    ctx.fillStyle = '#e6e6f0';
    ctx.fillText(`Rooms cleared  ${cleared} / ${combatRooms.length}`, 20, 30);

    if (state.spell.combat.over) this.banner('YOU DIED', '#ff6b6b');
    else if (state.complete) this.banner('DUNGEON COMPLETE', '#ffd76a');
    else if (state.activeRoomId !== null) {
      ctx.textAlign = 'center';
      ctx.font = 'bold 16px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#ff9b3a';
      ctx.fillText('ROOM SEALED — defeat every enemy', CANVAS_W / 2, 32);
      ctx.textAlign = 'left';
    }
  }

  private banner(text: string, color: string): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.font = 'bold 40px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, CANVAS_H / 2 - 34, CANVAS_W, 68);
    ctx.fillStyle = color;
    ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2 + 14);
    ctx.textAlign = 'left';
  }
}
