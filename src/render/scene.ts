import { Application, Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
import { CARD_CATALOG } from '../cards/catalog.js';
import type { CardInstance } from '../cards/types.js';
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
import type { EnemyState, Vec2 } from '../sim/types.js';
import { CARD_H, CARD_W, HandView } from './hand.js';
import { buildDudeTextures, dudeTexturesFor, SPRITE_NATIVE_HEIGHT, type DudeTextures, type DudeIdentity } from './sprites.js';
import {
  ACTIVE_VFX,
  PASSIVE_VFX,
  AoeEffect,
  ProjectileEffect,
  OverheadSymbolEffect,
  drawGlow,
  drawUnderglow,
  drawRotatingShapes,
  drawOverheadSymbol,
  type ActiveEffect,
  type PassiveVfx,
  type Project,
} from './effects.js';

// The world view is a fixed window into the (larger) arena; the camera scrolls
// the world under it while the HUD panel/hand sit to the right and below.
const ARENA_OFFSET_X = 40;
const ARENA_OFFSET_Y = 56;
const ARENA_SCALE = 1.2;
const VIEW_W = 720;
const VIEW_H = 560;
const VIEW_CENTER_X = ARENA_OFFSET_X + VIEW_W / 2;
const VIEW_CENTER_Y = ARENA_OFFSET_Y + VIEW_H / 2;
const HALF_VIEW_W = VIEW_W / (2 * ARENA_SCALE);
const HALF_VIEW_H = VIEW_H / (2 * ARENA_SCALE);
// Camera clamp so the view never leaves the arena (arena is larger than the view).
const CAM_MIN_X = Math.min(HALF_VIEW_W, ARENA_WIDTH / 2);
const CAM_MAX_X = Math.max(ARENA_WIDTH - HALF_VIEW_W, ARENA_WIDTH / 2);
const CAM_MIN_Y = Math.min(HALF_VIEW_H, ARENA_HEIGHT / 2);
const CAM_MAX_Y = Math.max(ARENA_HEIGHT - HALF_VIEW_H, ARENA_HEIGHT / 2);
const CAMERA_LAG = 0.08; // fraction of the gap to the player closed each frame

const SCREEN_WIDTH = ARENA_OFFSET_X * 2 + VIEW_W + 320;
// Room below the arena view for a row of portrait Balatro-style cards.
const HAND_TOP = ARENA_OFFSET_Y + VIEW_H + 24;
const HAND_CENTER_Y = HAND_TOP + CARD_H / 2;
const HAND_PITCH = 160;
const SCREEN_HEIGHT = HAND_TOP + CARD_H + 24;
const PANEL_X = ARENA_OFFSET_X + VIEW_W + 40;
const BONUS_CENTER = { x: PANEL_X + CARD_W / 2 + 18, y: HAND_CENTER_Y };
const MAX_LOG_LINES = 6;
const TWO_PI = Math.PI * 2;
const FLASH_FRAMES = 9;
const POPUP_LIFE_FRAMES = 42;
const POPUP_RISE_PER_FRAME = -0.9;
const SPRITE_SCALE = 2.2;
const SPRITE_ANCHOR_Y = 0.7; // feet roughly at the actor's position
const SPRITE_TOP_OFFSET = SPRITE_NATIVE_HEIGHT * SPRITE_SCALE * SPRITE_ANCHOR_Y;

// Grassy field palette.
const GRASS_BASE = '#3f7a3a';
const GRASS_LIGHT = '#478541';
const GRASS_DARK = '#376b33';
const GRASS_TUFT = '#2f5f2c';
const GRASS_CELL = 64;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const hash2 = (x: number, y: number): number => (((x * 73856093) ^ (y * 19349663)) >>> 0);

interface Popup {
  readonly text: Text;
  readonly vx: number;
  life: number;
}

interface EnemyVisual {
  readonly sprite: Sprite;
  readonly label: Text;
  readonly tex: DudeTextures;
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
      return `${event.enemyType} defeated!`;
    case 'playerDefeated':
      return 'you were defeated...';
    default:
      return undefined;
  }
}

function textStyle(fontSize: number, fill: string, weight: 'normal' | 'bold' = 'normal'): TextStyle {
  return new TextStyle({ fontFamily: 'monospace', fontSize, fill, fontWeight: weight });
}

function heldPassiveNames(cards: readonly (CardInstance | null)[]): string[] {
  const names: string[] = [];
  for (const card of cards) {
    if (!card) continue;
    const def = CARD_CATALOG.get(card.defId);
    if (def && def.kind === 'passive') names.push(def.name);
  }
  return names;
}

/** The hunting enemy whose wind-up resolves soonest, if any. */
function mostImminentWindup(enemies: readonly EnemyState[]): EnemyState | null {
  let soonest: EnemyState | null = null;
  for (const e of enemies) {
    if (e.behavior !== 'hunting' || e.phase !== 'windup') continue;
    if (soonest === null || e.phaseEndsAtTick < soonest.phaseEndsAtTick) soonest = e;
  }
  return soonest;
}

export class Scene {
  private readonly world = new Container();
  private readonly spriteLayer = new Container();
  private readonly labelLayer = new Container();
  private readonly popupLayer = new Container();
  private readonly mapGfx = new Graphics();
  private readonly telegraphGfx = new Graphics();
  private readonly auraFloorGfx = new Graphics();
  private readonly auraTopGfx = new Graphics();
  private readonly swingGfx = new Graphics();
  private readonly enemyGfx = new Graphics();
  private readonly playerGfx = new Graphics();
  private readonly cooldownGfx = new Graphics();
  private readonly playerSprite: Sprite;
  private readonly playerTex: DudeTextures;
  private readonly playerLabel: Text;
  private readonly banner: Text;
  private readonly prompt: Text;
  private readonly hand: HandView;
  private readonly passivesText: Text;
  private readonly logText: Text;
  private readonly logLines: string[] = [];
  private readonly enemyVisuals = new Map<number, EnemyVisual>();
  private readonly enemyTexCache = new Map<string, DudeTextures>();
  private readonly enemyFlash = new Map<number, number>();
  private playerFlash = 0;
  private healFlash = 0;
  private cam: Vec2 = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
  private readonly popups: Popup[] = [];
  private readonly activeEffects: ActiveEffect[] = [];
  private frame = 0;

  private constructor(readonly app: Application, textures: { player: DudeTextures }, identity: DudeIdentity) {
    const stage = app.stage;
    this.playerTex = textures.player;
    this.playerSprite = new Sprite(textures.player.idle);
    this.playerSprite.anchor.set(0.5, SPRITE_ANCHOR_Y);

    // World view: everything in-arena, clipped to the viewport rectangle.
    const mask = new Graphics().rect(ARENA_OFFSET_X, ARENA_OFFSET_Y, VIEW_W, VIEW_H).fill({ color: '#ffffff' });
    this.world.mask = mask;
    this.spriteLayer.addChild(this.playerSprite);
    this.world.addChild(
      this.mapGfx,
      this.telegraphGfx,
      this.auraFloorGfx,
      this.spriteLayer,
      this.swingGfx,
      this.enemyGfx,
      this.playerGfx,
      this.auraTopGfx,
      this.cooldownGfx,
      this.labelLayer,
      this.popupLayer,
    );
    stage.addChild(mask, this.world);

    this.playerLabel = new Text({ text: identity.playerName.toUpperCase(), style: textStyle(11, '#bfe0ff', 'bold') });
    this.playerLabel.anchor.set(0.5, 1);
    this.labelLayer.addChild(this.playerLabel);

    this.prompt = new Text({ text: '', style: textStyle(20, '#ffd76a', 'bold') });
    this.prompt.anchor.set(0.5, 1);
    this.labelLayer.addChild(this.prompt);

    // HUD (screen-fixed, outside the world view).
    this.banner = new Text({ text: '', style: textStyle(18, '#ffb347', 'bold') });
    this.banner.anchor.set(0.5, 0);
    this.banner.position.set(VIEW_CENTER_X, 18);
    stage.addChild(this.banner);

    const panelX = PANEL_X;
    this.passivesText = new Text({ text: '', style: textStyle(14, '#7affc0') });
    this.passivesText.position.set(panelX, ARENA_OFFSET_Y + 6);
    stage.addChild(this.passivesText);

    this.logText = new Text({ text: '', style: textStyle(13, '#c8c8d8') });
    this.logText.position.set(panelX, ARENA_OFFSET_Y + 54);
    stage.addChild(this.logText);

    const bonusLabel = new Text({ text: 'BONUS  (press B)', style: textStyle(12, '#ffd76a', 'bold') });
    bonusLabel.anchor.set(0.5, 1);
    bonusLabel.position.set(BONUS_CENTER.x, BONUS_CENTER.y - CARD_H / 2 - 8);
    stage.addChild(bonusLabel);

    // The card hand and its play animation live in their own view (spec 013).
    this.hand = new HandView(stage, {
      handCenters: [
        { x: VIEW_CENTER_X - HAND_PITCH, y: HAND_CENTER_Y },
        { x: VIEW_CENTER_X, y: HAND_CENTER_Y },
        { x: VIEW_CENTER_X + HAND_PITCH, y: HAND_CENTER_Y },
      ],
      bonusCenter: BONUS_CENTER,
    });
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

  /** Camera-relative world->screen transform; the player sits near the view centre. */
  worldToScreen(v: Vec2): ScreenPoint {
    return { x: VIEW_CENTER_X + (v.x - this.cam.x) * ARENA_SCALE, y: VIEW_CENTER_Y + (v.y - this.cam.y) * ARENA_SCALE };
  }

  private texFor(type: string): DudeTextures {
    let tex = this.enemyTexCache.get(type);
    if (!tex) {
      tex = dudeTexturesFor(type);
      this.enemyTexCache.set(type, tex);
    }
    return tex;
  }

  render(state: GameState, events: readonly GameEvent[], aim: ScreenPoint): void {
    this.frame++;
    // Ease the camera toward the player (with lag), clamped inside the arena.
    this.cam = {
      x: clamp(this.cam.x + (state.combat.player.position.x - this.cam.x) * CAMERA_LAG, CAM_MIN_X, CAM_MAX_X),
      y: clamp(this.cam.y + (state.combat.player.position.y - this.cam.y) * CAMERA_LAG, CAM_MIN_Y, CAM_MAX_Y),
    };

    for (const event of events) {
      const line = eventToLogLine(event);
      if (line) this.logLines.push(line);
      if (event.kind === 'playerHit') {
        this.playerFlash = FLASH_FRAMES;
        const p = this.worldToScreen(state.combat.player.position);
        this.spawnPopup(p.x, p.y, `-${event.damage}`, '#ff6b6b', 20);
      }
      if (event.kind === 'enemyHit') {
        this.enemyFlash.set(event.enemyId, FLASH_FRAMES);
        const e = this.worldToScreen(event.at);
        this.spawnPopup(e.x, e.y, `${event.damage}`, '#ffe08a', 22);
      }
      if (event.kind === 'playerHealed') {
        this.healFlash = FLASH_FRAMES;
        const p = this.worldToScreen(state.combat.player.position);
        this.spawnPopup(p.x, p.y, `+${event.amount}`, '#7affc0', 20);
      }
    }
    this.updatePopups();
    this.spawnActiveEffects(state, events, aim);
    while (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    this.logText.text = this.logLines.join('\n');

    this.drawMap();
    this.drawTelegraph(state);
    this.drawEnemies(state);
    this.drawSwing(state);
    this.drawPlayer(state, aim);
    this.drawEffectsAndAuras(state);
    this.drawCooldowns(state);
    this.drawBannerAndPrompt(state);
    this.hand.render(state.deck.hand, state.deck.bonusSlot, CARD_CATALOG);

    const held = heldPassiveNames([...state.deck.hand, state.deck.bonusSlot]);
    this.passivesText.text = held.length > 0 ? `Passives active:\n  ${held.join('\n  ')}` : 'Passives active: none';

    if (this.playerFlash > 0) this.playerFlash--;
    if (this.healFlash > 0) this.healFlash--;
    for (const [id, f] of this.enemyFlash) {
      if (f <= 1) this.enemyFlash.delete(id);
      else this.enemyFlash.set(id, f - 1);
    }
  }

  /** Grassy field: a mowed-lawn checker of two greens with occasional tufts, scrolling with the camera. */
  private drawMap(): void {
    this.mapGfx.clear();
    this.mapGfx.rect(ARENA_OFFSET_X, ARENA_OFFSET_Y, VIEW_W, VIEW_H).fill({ color: GRASS_BASE });

    const cx0 = Math.floor(Math.max(0, this.cam.x - HALF_VIEW_W) / GRASS_CELL);
    const cx1 = Math.ceil(Math.min(ARENA_WIDTH, this.cam.x + HALF_VIEW_W) / GRASS_CELL);
    const cy0 = Math.floor(Math.max(0, this.cam.y - HALF_VIEW_H) / GRASS_CELL);
    const cy1 = Math.ceil(Math.min(ARENA_HEIGHT, this.cam.y + HALF_VIEW_H) / GRASS_CELL);
    const size = GRASS_CELL * ARENA_SCALE + 1;
    for (let cy = cy0; cy < cy1; cy++) {
      for (let cx = cx0; cx < cx1; cx++) {
        const s = this.worldToScreen({ x: cx * GRASS_CELL, y: cy * GRASS_CELL });
        this.mapGfx.rect(s.x, s.y, size, size).fill({ color: (cx + cy) % 2 === 0 ? GRASS_LIGHT : GRASS_DARK });
        const h = hash2(cx, cy);
        if (h % 4 === 0) {
          const ox = (h % GRASS_CELL) * ARENA_SCALE;
          const oy = ((h >> 8) % GRASS_CELL) * ARENA_SCALE;
          this.mapGfx.circle(s.x + ox, s.y + oy, 2.5).fill({ color: GRASS_TUFT });
        }
      }
    }

    // Arena boundary.
    const tl = this.worldToScreen({ x: 0, y: 0 });
    const br = this.worldToScreen({ x: ARENA_WIDTH, y: ARENA_HEIGHT });
    this.mapGfx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y).stroke({ color: '#274d24', width: 5 });
  }

  private drawTelegraph(state: GameState): void {
    this.telegraphGfx.clear();
    const r = ENEMY_ATTACK_RADIUS * ARENA_SCALE;
    for (const enemy of state.combat.enemies) {
      if (enemy.behavior !== 'hunting' || enemy.phase !== 'windup' || !enemy.attackZoneCenter) continue;
      const c = this.worldToScreen(enemy.attackZoneCenter);
      const progress = 1 - Math.max(0, enemy.phaseEndsAtTick - state.combat.tick) / ENEMY_WINDUP_TICKS;
      this.telegraphGfx.circle(c.x, c.y, r).fill({ color: '#ff8c1a', alpha: 0.14 + 0.4 * progress });
      this.telegraphGfx.circle(c.x, c.y, r).stroke({ color: '#ffb347', width: 3, alpha: 0.6 + 0.4 * progress });
      this.telegraphGfx.circle(c.x, c.y, r * (1 - progress)).stroke({ color: '#ffe08a', width: 2, alpha: 0.85 });
    }
  }

  private drawEnemies(state: GameState): void {
    this.enemyGfx.clear();
    const seen = new Set<number>();
    for (const e of state.combat.enemies) {
      seen.add(e.id);
      let vis = this.enemyVisuals.get(e.id);
      if (!vis) {
        const tex = this.texFor(e.type);
        const sprite = new Sprite(tex.idle);
        sprite.anchor.set(0.5, SPRITE_ANCHOR_Y);
        const label = new Text({ text: e.type.toUpperCase(), style: textStyle(10, '#ff9a9a', 'bold') });
        label.anchor.set(0.5, 1);
        this.spriteLayer.addChild(sprite);
        this.labelLayer.addChild(label);
        vis = { sprite, label, tex };
        this.enemyVisuals.set(e.id, vis);
      }
      const p = this.worldToScreen(e.position);
      vis.sprite.texture = e.behavior === 'hunting' && e.phase === 'windup' ? vis.tex.windup : vis.tex.idle;
      const faceRight = state.combat.player.position.x >= e.position.x;
      const pop = 1 + 0.22 * ((this.enemyFlash.get(e.id) ?? 0) / FLASH_FRAMES);
      vis.sprite.position.set(p.x, p.y);
      vis.sprite.scale.set((faceRight ? 1 : -1) * SPRITE_SCALE * pop, SPRITE_SCALE * pop);
      // Grazers read as calm (dim), hunters as alert (bright red flash on hit).
      vis.sprite.tint = (this.enemyFlash.get(e.id) ?? 0) > 0 ? 0xffb0b0 : e.behavior === 'grazing' ? 0xdfe6df : 0xffffff;

      const barTop = p.y - SPRITE_TOP_OFFSET - 12;
      this.drawBar(this.enemyGfx, p.x - 26, barTop, 52, 6, e.health / e.maxHealth, e.behavior === 'hunting' ? '#ff5a5a' : '#8fbf6a');
      vis.label.position.set(p.x, barTop - 4);
    }

    // Retire visuals for enemies that died or despawned.
    for (const [id, vis] of this.enemyVisuals) {
      if (seen.has(id)) continue;
      vis.sprite.destroy();
      vis.label.destroy();
      this.enemyVisuals.delete(id);
    }
  }

  private drawSwing(state: GameState): void {
    this.swingGfx.clear();
    const pl = state.combat.player;
    const tick = state.combat.tick;
    const p = this.worldToScreen(pl.position);
    const ang = Math.atan2(pl.attackAimY, pl.attackAimX);
    const reach = PLAYER_ATTACK_RANGE * ARENA_SCALE;

    if (pl.attackReleaseTick !== 0) {
      const charge = 1 - Math.max(0, pl.attackReleaseTick - tick) / PLAYER_ATTACK_WINDUP_TICKS;
      const half = (Math.PI / 4) * (0.5 + 0.5 * charge);
      this.swingGfx.moveTo(p.x, p.y).arc(p.x, p.y, reach * (0.5 + 0.5 * charge), ang - half, ang + half).lineTo(p.x, p.y);
      this.swingGfx.stroke({ color: '#bfe0ff', width: 2, alpha: 0.4 + 0.4 * charge });
    } else if (tick < pl.moveLockUntil) {
      this.swingGfx.moveTo(p.x, p.y).arc(p.x, p.y, reach, ang - Math.PI / 4, ang + Math.PI / 4).lineTo(p.x, p.y).fill({ color: '#eaf3ff', alpha: 0.34 });
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

    for (const e of state.combat.enemies) {
      if (e.behavior !== 'hunting') continue;
      const ep = this.worldToScreen(e.position);
      const phaseTotal =
        e.phase === 'idle' ? ENEMY_IDLE_TICKS : e.phase === 'windup' ? ENEMY_WINDUP_TICKS : ENEMY_RECOVERY_TICKS;
      const phaseProgress = 1 - Math.max(0, e.phaseEndsAtTick - tick) / phaseTotal;
      const ringColor = e.phase === 'windup' ? '#ff8c1a' : e.phase === 'recovery' ? '#7a5a5a' : '#c05050';
      this.drawRadial(ep.x, ep.y, ENEMY_RADIUS * ARENA_SCALE + 7, phaseProgress, ringColor);
    }
  }

  private drawBannerAndPrompt(state: GameState): void {
    const tick = state.combat.tick;
    const windup = mostImminentWindup(state.combat.enemies);
    const hunting = state.combat.enemies.some((e) => e.behavior === 'hunting');

    if (state.combat.over) {
      this.banner.text = 'YOU WERE DEFEATED';
      this.banner.style.fill = '#ff5a5a';
    } else if (windup) {
      const remaining = Math.max(0, windup.phaseEndsAtTick - tick);
      this.banner.text = `⚠ SLAM INCOMING  —  ${(remaining / TICK_RATE).toFixed(1)}s`;
      this.banner.style.fill = '#ff8c1a';
    } else if (hunting) {
      this.banner.text = 'enemy engaged — punish the recovery!';
      this.banner.style.fill = '#7affc0';
    } else {
      this.banner.text = 'the herd grazes peacefully';
      this.banner.style.fill = '#9a9ab0';
    }

    const pScreen = this.worldToScreen(state.combat.player.position);
    this.prompt.position.set(pScreen.x, pScreen.y - PLAYER_RADIUS * ARENA_SCALE - 46);
    if (windup && !state.combat.over) {
      const remaining = windup.phaseEndsAtTick - tick;
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

  /**
   * Turn each active card played this frame into a cosmetic effect: a
   * projectile flying at the enemy the sim actually struck (or off along the
   * aim on a miss), or a ground AOE that winds up on the caster / forward point.
   */
  private spawnActiveEffects(state: GameState, events: readonly GameEvent[], aim: ScreenPoint): void {
    const player = state.combat.player.position;
    const norm = Math.hypot(aim.x, aim.y);
    const dir = norm > 1e-3 ? { x: aim.x / norm, y: aim.y / norm } : { x: 1, y: 0 };
    const hits = events.filter((e): e is Extract<GameEvent, { kind: 'enemyHit' }> => e.kind === 'enemyHit');

    for (const ev of events) {
      if (ev.kind !== 'cardPlayed' && ev.kind !== 'bonusCardPlayed') continue;
      const vfx = ACTIVE_VFX[ev.defId];
      if (!vfx) continue;
      const def = CARD_CATALOG.get(ev.defId);
      const amount = def?.kind === 'active' && def.effect.kind === 'damage' ? def.effect.amount : undefined;

      if (vfx.kind === 'projectile') {
        const hit = (amount !== undefined ? hits.find((h) => h.damage === amount) : undefined) ?? hits[0];
        const target: Vec2 = hit ? hit.at : { x: player.x + dir.x * 400, y: player.y + dir.y * 400 };
        this.activeEffects.push(new ProjectileEffect(player, target, vfx));
      } else {
        const center: Vec2 = vfx.forward
          ? { x: player.x + dir.x * vfx.radius * 0.5, y: player.y + dir.y * vfx.radius * 0.5 }
          : player;
        this.activeEffects.push(new AoeEffect(center, vfx));
        if (vfx.symbol) {
          for (const h of hits) {
            this.activeEffects.push(new OverheadSymbolEffect(h.at, SPRITE_TOP_OFFSET + 14, vfx.symbol, vfx.glow, vfx.castTicks));
          }
        }
      }
    }
  }

  /** Advance and draw live active effects, then paint the held passives' auras. */
  private drawEffectsAndAuras(state: GameState): void {
    this.auraFloorGfx.clear();
    this.auraTopGfx.clear();
    const project: Project = (v) => this.worldToScreen(v);

    this.drawPassiveAuras(state, project);

    for (let i = this.activeEffects.length - 1; i >= 0; i--) {
      const fx = this.activeEffects[i];
      if (!fx) continue;
      if (!fx.update()) {
        this.activeEffects.splice(i, 1);
        continue;
      }
      fx.drawFloor(this.auraFloorGfx, project, ARENA_SCALE);
      fx.drawTop(this.auraTopGfx, project, ARENA_SCALE);
    }
  }

  private drawPassiveAuras(state: GameState, project: Project): void {
    const playerVfx: PassiveVfx[] = [];
    let enemyVfx: PassiveVfx | undefined;
    const seen = new Set<string>();
    for (const card of [...state.deck.hand, state.deck.bonusSlot]) {
      if (!card) continue;
      const def = CARD_CATALOG.get(card.defId);
      if (!def || def.kind !== 'passive' || seen.has(def.passive.kind)) continue;
      seen.add(def.passive.kind);
      const vfx = PASSIVE_VFX[def.passive.kind];
      if (vfx.target === 'player') playerVfx.push(vfx);
      else enemyVfx = vfx;
    }

    if (playerVfx.length > 0) {
      const p = project(state.combat.player.position);
      const baseR = PLAYER_RADIUS * ARENA_SCALE;
      playerVfx.forEach((vfx, idx) => this.paintAura(vfx, p.x, p.y, p.y - baseR * 0.5, baseR, idx, p.y - SPRITE_TOP_OFFSET - 20));
    }

    if (enemyVfx) {
      const baseR = ENEMY_RADIUS * ARENA_SCALE;
      for (const e of state.combat.enemies) {
        const ep = project(e.position);
        this.paintAura(enemyVfx, ep.x, ep.y, ep.y - baseR * 0.5, baseR, 0, ep.y - SPRITE_TOP_OFFSET - 22);
      }
    }
  }

  private paintAura(vfx: PassiveVfx, cx: number, feetY: number, bodyY: number, baseR: number, idx: number, symbolY: number): void {
    for (const prim of vfx.primitives) {
      switch (prim) {
        case 'underglow':
          drawUnderglow(this.auraFloorGfx, cx, feetY, baseR, vfx.color, 1, this.frame);
          break;
        case 'glow':
          drawGlow(this.auraTopGfx, cx, bodyY, baseR, vfx.color, 1, this.frame + idx * 20);
          break;
        case 'rotatingShapes':
          drawRotatingShapes(
            this.auraTopGfx,
            cx,
            bodyY,
            baseR + 14 + idx * 6,
            4,
            vfx.color,
            vfx.sides ?? 3,
            vfx.count ?? 3,
            this.frame * (vfx.spin ?? 0.05),
            0.7,
          );
          break;
        case 'overheadSymbol':
          if (vfx.symbol) drawOverheadSymbol(this.auraTopGfx, cx, symbolY, vfx.color, vfx.symbol, 0.85);
          break;
      }
    }
  }

  private spawnPopup(x: number, y: number, label: string, color: string, fontSize: number): void {
    const text = new Text({ text: label, style: textStyle(fontSize, color, 'bold') });
    text.anchor.set(0.5, 1);
    text.position.set(x + (Math.random() * 20 - 10), y - 24);
    this.popupLayer.addChild(text);
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
        popup.text.destroy();
        this.popups.splice(i, 1);
      }
    }
  }

  private drawRadial(cx: number, cy: number, radius: number, progress: number, color: string): void {
    const clamped = Math.max(0, Math.min(1, progress));
    const start = -Math.PI / 2;
    this.cooldownGfx.circle(cx, cy, radius).stroke({ color: '#000000', width: 3, alpha: 0.25 });
    if (clamped <= 0) return;
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

}
