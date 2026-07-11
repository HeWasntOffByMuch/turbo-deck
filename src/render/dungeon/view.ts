import {
  ENEMY_ATTACK_ARC_COS_SQ,
  ENEMY_ATTACK_RANGE,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_WINDUP_TICKS,
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

const POPUP_LIFE = 42;

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

  /** Precompute room-cell lookups + theme the first time we see a dungeon. */
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

  render(state: DungeonGameState, events: readonly DungeonGameEvent[], aim: ScreenPoint): void {
    this.frame++;
    const d = state.dungeon;
    this.ensureInit(d);
    this.ingestEvents(state.combat.player, events);

    const p = state.combat.player.position;
    this.cam = { x: this.cam.x + (p.x - this.cam.x) * CAMERA_LAG, y: this.cam.y + (p.y - this.cam.y) * CAMERA_LAG };
    this.clampCamera(d);

    this.drawTiles(state);
    for (const enemy of state.combat.enemies) this.drawTelegraph(enemy);
    for (const enemy of state.combat.enemies) this.drawEnemy(enemy, state.combat.tick);
    this.drawPlayer(state.combat.player, aim);
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
      else if (e.kind === 'perfectDefense') this.spawnPopup(player.position, 'PERFECT', '#8fd0ff');
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

    // The active (sealed) room's door cells are drawn barred.
    const activeRoom = state.activeRoomId === null ? null : d.rooms[state.activeRoomId] ?? null;
    const sealed = new Set<number>();
    if (activeRoom) for (const dr of activeRoom.doors) sealed.add(dr.cy * d.cols + dr.cx);

    // Iterate only cells inside the viewport.
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
    const frame = enemy.phase === 'windup' ? 'windup' : 'idle';

    this.groundShadow(p.x, feet - r * 0.1, r * 0.95);
    if (enemy.behavior === 'hunting') {
      const total = enemy.phase === 'idle' ? ENEMY_IDLE_TICKS : enemy.phase === 'windup' ? ENEMY_WINDUP_TICKS : ENEMY_RECOVERY_TICKS;
      const prog = 1 - Math.max(0, enemy.phaseEndsAtTick - tick) / total;
      const ring = enemy.phase === 'windup' ? '#ff8c1a' : enemy.phase === 'recovery' ? '#7a5a5a' : '#d0605a';
      this.groundRing(p.x, feet - r * 0.1, r * 0.95, prog, ring);
    }
    this.dudes.draw(ctx, enemy.type, frame, p.x, p.y, size, false);
    this.healthBar(p.x - r, headTop - 8, r * 2, enemy.health / enemy.maxHealth, '#ff5a5a');
  }

  private drawPlayer(player: PlayerState, aim: ScreenPoint): void {
    const { ctx } = this;
    const p = this.worldToScreen(player.position);
    const r = PLAYER_RADIUS * SCALE;
    const size = r * 2.7;
    const half = size / 2;
    const feet = p.y + half;
    const headTop = p.y - half;
    const ang = Math.atan2(aim.y, aim.x);

    this.groundShadow(p.x, feet - r * 0.1, r);
    this.dudes.draw(ctx, PLAYER_SKIN, 'idle', p.x, p.y, size, aim.x < 0);

    ctx.strokeStyle = 'rgba(159,183,212,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(ang) * r * 1.1, p.y + Math.sin(ang) * r * 1.1);
    ctx.lineTo(p.x + Math.cos(ang) * r * 2.1, p.y + Math.sin(ang) * r * 2.1);
    ctx.stroke();

    this.healthBar(p.x - r - 4, headTop - 9, r * 2 + 8, player.health / player.maxHealth, '#5ad65a');
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

    if (state.combat.over) this.banner('YOU DIED', '#ff6b6b');
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
