import { HAND_SIZE, SPELL_CARDS, type CardSet, type SpellCard, type SpellId } from '../../cards/spells.js';
import { spellCardCost, type SpellGameState } from '../../game/spell-session.js';
import { characterAt } from '../../sim/characters.js';
import { MAX_ADRENALINE, TICK_RATE, WAVE_BASE_COUNT } from '../../sim/constants.js';
import type { IsoInputCapture } from './input.js';

/**
 * The heads-up display for the fullscreen iso game window (spec 039). Every
 * piece of it floats *over* the canvas: the game window is the whole viewport,
 * and status, hand, wave controls and reward pickers are overlays on top of it.
 *
 * The hand is icons only -- one glyph per card, tinted by set, with its key cap
 * and cost pip -- so it reads at a glance without covering the fight; the card's
 * name and blurb live in a hover tooltip instead. Styling is deliberately retro:
 * monospace, hard 2px borders, hard offset shadows, no rounding or blur.
 *
 * No game rules here. It reads `SpellGameState` and reports clicks into the same
 * input capture the keyboard feeds.
 */

/**
 * Card icons as 8x8 pixel art -- `#` is a lit pixel -- drawn as crisp SVG rects.
 * Hand-drawn rather than typeset because a glyph font is a gamble (the symbols
 * that read best are exactly the ones a system font is most likely to be missing,
 * and a tofu box in the hand is unreadable), and because pixels are the look.
 */
type PixelIcon = readonly string[];

const ICON_ATTACK: PixelIcon = ['...##...', '...##...', '...##...', '...##...', '.######.', '...##...', '...##...', '..#..#..'];
const ICON_DASH: PixelIcon = ['........', '#...#...', '.#...#..', '..#...#.', '..#...#.', '.#...#..', '#...#...', '........'];
const ICON_FLAME: PixelIcon = ['...##...', '..###...', '..####..', '.#.####.', '##..###.', '##...##.', '.##.##..', '..###...'];
const ICON_AURA: PixelIcon = ['#..##..#', '..###...', '.#####..', '#.####.#', '..####..', '.#####..', '..###...', '#..##..#'];
const ICON_METEOR: PixelIcon = ['#.......', '.#..#...', '..#.....', '...###..', '..#####.', '..#####.', '...###..', '........'];
const ICON_TRAIL: PixelIcon = ['........', '#...#...', '.#...#..', '..#...#.', '.#...#..', '#...#...', '..##.##.', '..##.##.'];
const ICON_CONJURE: PixelIcon = ['......#.', '...#.###', '..##..#.', '..####..', '.#####..', '##.###..', '##.###..', '.#####..'];
const ICON_STORM: PixelIcon = ['.#####..', '#######.', '########', '........', '.#..#..#', '.#..#..#', '..#..#..', '..#..#..'];
const ICON_BOLT: PixelIcon = ['...###..', '..###...', '.###....', '######..', '..####..', '..###...', '.###....', '.##.....'];
const ICON_STOMP: PixelIcon = ['..####..', '..####..', '########', '.######.', '..####..', '...##...', '........', '########'];
const ICON_SHIELD: PixelIcon = ['.######.', '########', '########', '########', '.######.', '..####..', '...##...', '........'];
const ICON_BURY: PixelIcon = ['.##..##.', '.##..##.', '.##..##.', '########', '#.#..#.#', '#.#..#.#', '........', '........'];
/** Reward-picker icons: thin the deck, and level a card up. */
const ICON_REMOVE: PixelIcon = ['........', '........', '........', '########', '########', '........', '........', '........'];
const ICON_UPGRADE: PixelIcon = ['...##...', '..####..', '.######.', '########', '...##...', '...##...', '...##...', '........'];

const CARD_ICON: Record<SpellId, PixelIcon> = {
  attack: ICON_ATTACK,
  dash: ICON_DASH,
  fireBlast: ICON_FLAME,
  blazeAura: ICON_AURA,
  meteorStrike: ICON_METEOR,
  baskingPath: ICON_TRAIL,
  conjureFlame: ICON_CONJURE,
  fireStorm: ICON_STORM,
  burningSpeed: ICON_BOLT,
  groundStomp: ICON_STOMP,
  rockyRaise: ICON_SHIELD,
  buryFeet: ICON_BURY,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Render a pixel icon as a crisp, colour-inheriting SVG sized by CSS. */
function pixelIcon(icon: PixelIcon, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', className);
  icon.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      svg.appendChild(rect);
    }
  });
  return svg;
}

/** Set tinting for a card tile: face, border, glyph. */
const SET_COLOR: Record<CardSet, { bg: string; edge: string; ink: string }> = {
  regular: { bg: '#2a2a34', edge: '#c8c4b4', ink: '#efeade' },
  fire: { bg: '#3a2018', edge: '#e0793c', ink: '#ffb066' },
  earth: { bg: '#22301c', edge: '#7a9a4a', ink: '#b8d488' },
};

const KEY_CAPS = ['Q', 'W', 'E', 'R'] as const;

type Stat = 'strength' | 'agility' | 'intelligence';
const STATS: readonly { key: Stat; tag: string; tip: string }[] = [
  { key: 'strength', tag: 'STR', tip: 'Strength — more max HP' },
  { key: 'agility', tag: 'AGI', tip: 'Agility — armor, attack speed, turn rate' },
  { key: 'intelligence', tag: 'INT', tip: 'Intelligence — spell damage' },
];

const STYLE_ID = 'iso-hud-style';
const STYLE = `
.iso-hud { position: absolute; inset: 0; pointer-events: none; z-index: 20;
  font-family: 'Courier New', ui-monospace, monospace; color: #e6e4d8; -webkit-font-smoothing: none; }
.iso-hud button { pointer-events: auto; font: inherit; cursor: pointer; }
.iso-panel { background: rgba(12,12,18,.82); border: 2px solid #4a4a5e; box-shadow: 3px 3px 0 rgba(0,0,0,.55);
  padding: 8px 10px; }

/* --- top-left status --- */
.iso-status { position: absolute; top: 46px; left: 10px; width: 210px; display: flex; flex-direction: column; gap: 6px; }
.iso-row { display: flex; align-items: center; gap: 6px; font-size: 12px; letter-spacing: .06em; }
.iso-row .lbl { color: #9a9ab0; width: 34px; }
.iso-bar { flex: 1; height: 10px; background: #2a1a1e; border: 2px solid #5a3a40; position: relative; }
.iso-bar i { display: block; height: 100%; background: #d9484a; }
.iso-pips { display: flex; gap: 3px; }
.iso-pips span { width: 9px; height: 12px; background: #33232a; border: 1px solid #52333a; }
.iso-pips span.on { background: #ff7a3a; border-color: #ffc48a; }
.iso-stat { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.iso-stat .tag { width: 30px; font-weight: 700; }
.iso-stat .val { width: 18px; text-align: right; color: #fff; }
.iso-plus { width: 20px; height: 18px; line-height: 1; padding: 0; background: #ffd76a; color: #14141c;
  border: 2px solid #8a7130; font-weight: 700; }
.iso-plus:disabled { background: #33333f; color: #5a5a6a; border-color: #3d3d4c; cursor: default; }

/* --- centre banner --- */
.iso-banner { position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
  font-size: 13px; letter-spacing: .12em; text-transform: uppercase; text-shadow: 2px 2px 0 #000; }

/* --- hand --- */
.iso-hand { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; }
.iso-card { pointer-events: auto; position: relative; width: 58px; height: 58px; background: #2a2a34;
  border: 2px solid #4a4a5e; box-shadow: 3px 3px 0 rgba(0,0,0,.55); display: flex; align-items: center;
  justify-content: center; font-size: 26px; line-height: 1; padding: 0; color: #efeade; }
.iso-card:hover { transform: translateY(-3px); }
.iso-card .cap { position: absolute; top: -11px; left: -2px; background: #14141c; border: 2px solid #4a4a5e;
  color: #ffd76a; font-size: 10px; line-height: 1; padding: 1px 4px; }
.iso-card .cost { position: absolute; bottom: 3px; right: 3px; display: flex; gap: 2px; }
.iso-card .cost b { width: 5px; height: 5px; background: #ff8a3a; box-shadow: 0 0 4px rgba(255,120,60,.9); }
.iso-card .lv { position: absolute; top: 1px; right: 2px; color: #ffd76a; font-size: 10px; }
.iso-card.empty { color: #6a6a80; border-style: dashed; font-size: 12px; letter-spacing: .04em; cursor: default; }
.iso-card.empty:hover { transform: none; }
.iso-card.unafford { filter: grayscale(.7) brightness(.65); }
.iso-card .glyph { width: 30px; height: 30px; display: block; }

/* --- bottom-right controls --- */
.iso-controls { position: absolute; right: 14px; bottom: 14px; display: flex; flex-direction: column;
  align-items: flex-end; gap: 6px; }
.iso-btn { background: #2b1b33; color: #f0d8ff; border: 2px solid #7a3a6a; box-shadow: 3px 3px 0 rgba(0,0,0,.55);
  padding: 6px 10px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.iso-btn:hover:not(:disabled) { background: #3a2444; }
.iso-btn:disabled { filter: grayscale(.7) brightness(.6); cursor: default; }
.iso-hint { color: #b0b0c0; font-size: 10.5px; line-height: 1.5; letter-spacing: .04em; text-align: right;
  max-width: 240px; padding: 5px 7px; }

/* --- reward / picker overlay --- */
.iso-modal { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); display: none;
  flex-direction: column; gap: 8px; align-items: center; min-width: 260px; }
.iso-modal.open { display: flex; }
.iso-modal h5 { margin: 0; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #7affc0; }
.iso-modal .opts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.iso-modal .opt { background: #16301f; color: #cfeedd; border: 2px solid #2c6b4a; box-shadow: 3px 3px 0 rgba(0,0,0,.55);
  padding: 7px 10px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.iso-modal .opt:hover { background: #1e4530; }
.iso-modal .opt .glyph { width: 20px; height: 20px; display: block; margin: 0 auto 3px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Inject the HUD stylesheet once, however many views mount a HUD. */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = el('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export class IsoHud {
  private readonly hpBar: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly waveText: HTMLElement;
  private readonly levelText: HTMLElement;
  private readonly charText: HTMLElement;
  private readonly adrPips: HTMLElement[] = [];
  private readonly statVals: Record<Stat, HTMLElement> = {} as Record<Stat, HTMLElement>;
  private readonly statPlus: Record<Stat, HTMLButtonElement> = {} as Record<Stat, HTMLButtonElement>;
  private readonly banner: HTMLElement;
  private readonly cards: HTMLButtonElement[] = [];
  private readonly waveBtn: HTMLButtonElement;
  private readonly modal: HTMLElement;
  private readonly modalTitle: HTMLElement;
  private readonly modalOpts: HTMLElement;
  private readonly input: IsoInputCapture;
  /** Last rendered hand signature, so tiles are rebuilt only when the hand changes. */
  private lastHandKey = '';
  /** Last rendered modal signature, so its buttons are rebuilt only on change. */
  private lastModalKey = '';

  /** The overlay root; mount it inside the (positioned) game window element. */
  readonly element: HTMLElement;

  constructor(input: IsoInputCapture) {
    ensureStyle();
    this.input = input;
    this.element = el('div', 'iso-hud');

    // --- Status: health, wave, adrenaline, level and stat spending ---
    const status = el('div', 'iso-status iso-panel');
    const hpRow = el('div', 'iso-row');
    const hpLabel = el('span', 'lbl');
    hpLabel.textContent = 'HP';
    this.hpBar = el('i');
    const barWrap = el('div', 'iso-bar');
    barWrap.appendChild(this.hpBar);
    this.hpText = el('span');
    hpRow.append(hpLabel, barWrap, this.hpText);

    const adrRow = el('div', 'iso-row');
    const adrLabel = el('span', 'lbl');
    adrLabel.textContent = 'ADR';
    const pips = el('div', 'iso-pips');
    pips.title = 'Adrenaline — banked by basic attacks, spent to cast spell cards';
    for (let i = 0; i < MAX_ADRENALINE; i++) {
      const pip = el('span');
      this.adrPips.push(pip);
      pips.appendChild(pip);
    }
    adrRow.append(adrLabel, pips);

    const waveRow = el('div', 'iso-row');
    this.waveText = el('span');
    this.levelText = el('span');
    this.levelText.style.marginLeft = 'auto';
    waveRow.append(this.waveText, this.levelText);

    // The movement archetype (spec 028), swapped with C.
    const charRow = el('div', 'iso-row');
    charRow.title = 'Movement character — press C to swap (changes walk speed and turn rate)';
    const charLabel = el('span', 'lbl');
    charLabel.textContent = 'CHR';
    this.charText = el('span');
    charRow.append(charLabel, this.charText);

    status.append(hpRow, adrRow, waveRow, charRow);
    for (const { key, tag, tip } of STATS) {
      const row = el('div', 'iso-stat');
      row.title = tip;
      const name = el('span', 'tag');
      name.textContent = tag;
      const val = el('span', 'val');
      const plus = el('button', 'iso-plus');
      plus.textContent = '+';
      plus.title = `Spend a stat point on ${tag}`;
      plus.addEventListener('click', () => input.queueAllocate(key));
      row.append(name, val, plus);
      status.appendChild(row);
      this.statVals[key] = val;
      this.statPlus[key] = plus;
    }
    this.element.appendChild(status);

    this.banner = el('div', 'iso-banner');
    this.element.appendChild(this.banner);

    // --- Hand: four icon tiles, keyed Q W E R ---
    const hand = el('div', 'iso-hand');
    for (let i = 0; i < HAND_SIZE; i++) {
      const tile = el('button', 'iso-card');
      tile.addEventListener('click', () => input.queuePlay(i as 0 | 1 | 2 | 3));
      const cap = el('span', 'cap');
      cap.textContent = KEY_CAPS[i] ?? String(i + 1);
      tile.appendChild(cap);
      this.cards.push(tile);
      hand.appendChild(tile);
    }
    this.element.appendChild(hand);

    // --- Wave control + the controls reminder ---
    const controls = el('div', 'iso-controls');
    this.waveBtn = el('button', 'iso-btn');
    this.waveBtn.addEventListener('click', () => input.queueWave());
    const hint = el('div', 'iso-hint iso-panel');
    hint.textContent =
      'right-click move · shift+right-click queues the next move · left-click attack · Q W E R cards · SPACE wave · C character';
    controls.append(this.waveBtn, hint);
    this.element.appendChild(controls);

    // --- Wave rewards and their card picker ---
    this.modal = el('div', 'iso-modal iso-panel');
    this.modalTitle = el('h5');
    this.modalOpts = el('div', 'opts');
    this.modal.append(this.modalTitle, this.modalOpts);
    this.element.appendChild(this.modal);
  }

  render(state: SpellGameState): void {
    const combat = state.combat;
    const player = combat.player;

    const hpFraction = player.maxHealth > 0 ? Math.max(0, player.health) / player.maxHealth : 0;
    this.hpBar.style.width = `${Math.round(hpFraction * 100)}%`;
    this.hpText.textContent = `${Math.ceil(Math.max(0, player.health))}`;
    this.waveText.textContent = `WAVE ${combat.waveNumber}`;
    this.levelText.textContent = `LV${player.level}` + (player.statPoints > 0 ? ` +${player.statPoints}` : '');
    this.adrPips.forEach((pip, i) => pip.classList.toggle('on', i < player.adrenaline));
    this.charText.textContent = characterAt(player.characterIndex).name.toLowerCase();

    for (const { key } of STATS) {
      const val = this.statVals[key];
      if (val) val.textContent = String(player[key]);
      const plus = this.statPlus[key];
      if (plus) plus.disabled = player.statPoints <= 0;
    }

    this.renderBanner(state);
    this.renderHand(state);

    const waveInProgress = combat.enemies.length > 0;
    const blocked = state.pendingReward !== null || state.pendingPick !== null;
    this.waveBtn.disabled = waveInProgress || blocked;
    this.waveBtn.textContent = waveInProgress
      ? 'wave in progress'
      : `spawn wave ${combat.waveNumber + 1} · ${WAVE_BASE_COUNT + combat.waveNumber + 1} foes`;

    this.renderModal(state);
  }

  private renderBanner(state: SpellGameState): void {
    const combat = state.combat;
    if (combat.over) {
      this.banner.textContent = 'defeated — reload to retry';
      this.banner.style.color = '#ff5a5a';
      return;
    }
    if (combat.tick < combat.player.moveSlowUntilTick) {
      this.banner.textContent = 'fumbled combo — slowed';
      this.banner.style.color = '#b49be0';
      return;
    }
    if (combat.enemies.length === 0) {
      this.banner.textContent = 'arena clear — spawn a wave (space)';
      this.banner.style.color = '#9a9ab0';
      return;
    }
    const hunting = combat.enemies.some((e) => e.behavior === 'hunting');
    this.banner.textContent = hunting ? 'enemies closing — cast!' : 'the herd grazes';
    this.banner.style.color = hunting ? '#ffd76a' : '#9a9ab0';
  }

  /**
   * Faces are rebuilt only when the hand's identities change; the per-frame pass
   * just refreshes the refill countdown and the can-I-afford-it dimming.
   */
  private renderHand(state: SpellGameState): void {
    const hand = state.deck.hand;
    const key = hand.map((c) => (c ? `${c.instanceId}:${c.level}` : 'x')).join(',');
    if (key !== this.lastHandKey) {
      this.lastHandKey = key;
      hand.forEach((card, i) => this.buildTile(this.cards[i], card, i));
    }
    hand.forEach((card, i) => {
      const tile = this.cards[i];
      if (!tile) return;
      if (card) {
        tile.classList.toggle('unafford', spellCardCost(card.id) > state.combat.player.adrenaline);
        return;
      }
      const at = state.refillAtTick[i];
      const countdown = tile.querySelector('.wait');
      if (countdown) {
        countdown.textContent =
          at !== null && at !== undefined ? `${Math.max(0, (at - state.combat.tick) / TICK_RATE).toFixed(1)}s` : '--';
      }
    });
  }

  private buildTile(tile: HTMLButtonElement | undefined, card: SpellCard | null, index: number): void {
    if (!tile) return;
    tile.querySelectorAll('.glyph,.wait,.cost,.lv').forEach((n) => n.remove());
    tile.classList.toggle('empty', card === null);
    if (!card) {
      tile.classList.remove('unafford');
      tile.style.background = '';
      tile.style.borderColor = '';
      tile.style.color = '';
      tile.title = 'refilling';
      tile.appendChild(el('span', 'wait'));
      return;
    }

    const def = SPELL_CARDS[card.id];
    const palette = SET_COLOR[def.set];
    tile.style.background = palette.bg;
    tile.style.borderColor = palette.edge;
    tile.style.color = palette.ink;
    const cost = spellCardCost(card.id);
    tile.title =
      `${KEY_CAPS[index] ?? index + 1} · ${def.name}${card.level > 1 ? ` Lv${card.level}` : ''} (${def.set})\n` +
      `${def.blurb}${cost > 0 ? ` · costs ${cost} adrenaline` : ''}`;

    tile.appendChild(pixelIcon(CARD_ICON[card.id], 'glyph'));
    if (card.level > 1) {
      const lv = el('span', 'lv');
      lv.textContent = String(card.level);
      tile.appendChild(lv);
    }
    if (cost > 0) {
      // One lit pip per point of adrenaline the card costs.
      const pips = el('span', 'cost');
      for (let i = 0; i < cost; i++) pips.appendChild(el('b'));
      tile.appendChild(pips);
    }
  }

  /**
   * The wave-clear reward and its follow-up card picker, as one centred overlay.
   * Without it a cleared wave would block every later wave, since the sim will
   * not spawn one while a reward is pending.
   */
  private renderModal(state: SpellGameState): void {
    const offers = state.pendingReward;
    const pick = state.pendingPick;
    const open = offers !== null || pick !== null;
    this.modal.classList.toggle('open', open);
    if (!open) {
      this.lastModalKey = '';
      return;
    }

    const key = pick
      ? `pick:${pick.kind}:${pick.candidates.join(',')}`
      : `reward:${(offers ?? []).map((o) => `${o.kind}${o.cardId ?? ''}`).join(',')}`;
    if (key === this.lastModalKey) return;
    this.lastModalKey = key;
    this.modalOpts.replaceChildren();

    if (pick) {
      this.modalTitle.textContent = pick.kind === 'remove' ? 'remove which card?' : 'upgrade which card?';
      pick.candidates.forEach((id, i) => {
        this.modalOpts.appendChild(this.makeOption(CARD_ICON[id], SPELL_CARDS[id].name, () => this.input.queuePick(i)));
      });
      return;
    }

    this.modalTitle.textContent = 'wave cleared — take a reward';
    (offers ?? []).forEach((offer, i) => {
      const index = i as 0 | 1 | 2;
      if (offer.kind === 'addFire' && offer.cardId) {
        const def = SPELL_CARDS[offer.cardId];
        this.modalOpts.appendChild(
          this.makeOption(CARD_ICON[offer.cardId], `add ${def.name}`, () => this.input.queueReward(index), def.blurb),
        );
      } else if (offer.kind === 'remove') {
        this.modalOpts.appendChild(
          this.makeOption(ICON_REMOVE, 'remove a card', () => this.input.queueReward(index), 'Thin the deck by one card'),
        );
      } else {
        this.modalOpts.appendChild(
          this.makeOption(ICON_UPGRADE, 'upgrade a card', () => this.input.queueReward(index), 'Level up one spell card'),
        );
      }
    });
  }

  private makeOption(icon: PixelIcon, label: string, onClick: () => void, tip?: string): HTMLButtonElement {
    const btn = el('button', 'opt');
    if (tip) btn.title = tip;
    btn.append(pixelIcon(icon, 'glyph'), document.createTextNode(label));
    btn.addEventListener('click', onClick);
    return btn;
  }
}
