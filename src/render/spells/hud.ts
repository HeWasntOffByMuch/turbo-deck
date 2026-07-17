import { HAND_SIZE, SPELL_CARDS, type CardSet, type SpellCard, type SpellHand } from '../../cards/spells.js';
import { spellCardCost, type RewardOffer, type SpellGameState } from '../../game/spell-session.js';
import { characterAt } from '../../sim/characters.js';
import { ADRENALINE_SPEED_PER_POINT, MAX_ADRENALINE, TICK_RATE, TURN_RATE_PER_AGILITY, WAVE_BASE_COUNT } from '../../sim/constants.js';
import type { SpellInputCapture } from './input.js';

/**
 * DOM heads-up display for the spell game. All controls (status, RPG stats, wave
 * spawn, character swap, mute, wave rewards) live in a panel to the RIGHT of the
 * canvas; the four held cards sit in a row BELOW it (spec 029). No game rules: it
 * reads state and reports clicks.
 */

const SET_COLOR: Record<CardSet, { bg: string; edge: string }> = {
  regular: { bg: '#e7e3d6', edge: '#b9b09a' },
  fire: { bg: '#f4c9a6', edge: '#d8703a' },
  earth: { bg: '#c7d3a8', edge: '#7a9a4a' },
};

const STAT_INFO: Record<'strength' | 'agility' | 'intelligence', { label: string; effect: string; color: string }> = {
  strength: { label: 'STR', effect: 'max HP', color: '#e8756a' },
  agility: { label: 'AGI', effect: 'armor · atk speed · turn', color: '#6ad0a0' },
  intelligence: { label: 'INT', effect: 'spell damage', color: '#7fb0ff' },
};

const STYLE = `
.sp-side { font-family: 'Segoe UI', system-ui, sans-serif; color: #d8dae6; width: 300px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 10px; }
.sp-hand-wrap { font-family: 'Segoe UI', system-ui, sans-serif; }
.sp-status { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline; font-size: 13px; }
.sp-status b { color: #fff; font-size: 15px; }
.sp-banner { flex-basis: 100%; font-weight: 700; }
.sp-panel { background: #1a1a24; border: 1px solid #2c2c3c; border-radius: 10px; padding: 10px 12px; }
.sp-panel h4 { margin: 0 0 8px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #9a9ab0; font-weight: 700; }
.sp-lvl { color: #ffd76a; font-weight: 800; }
.sp-stat { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.sp-stat .tag { width: 34px; font-weight: 800; font-size: 13px; }
.sp-stat .val { width: 22px; text-align: right; font-weight: 800; color: #fff; font-size: 15px; }
.sp-stat .eff { flex: 1; font-size: 10.5px; color: #8a8a9a; line-height: 1.1; }
.sp-plus { width: 26px; height: 26px; border-radius: 7px; border: none; cursor: pointer; color: #10101a;
  font-size: 17px; font-weight: 900; line-height: 1; background: #ffd76a; }
.sp-plus:disabled { background: #33333f; color: #55556a; cursor: default; }
.sp-hand { display: flex; gap: 12px; align-items: flex-end; margin-top: 12px; }
.sp-card { box-sizing: border-box; width: 100px; height: 136px; border-radius: 10px; background: #e7e3d6; color: #1b1b22;
  box-shadow: 0 3px 8px rgba(0,0,0,.4); cursor: pointer; position: relative; user-select: none;
  border: 2px solid #b9b09a; transition: transform .08s ease; display: flex; flex-direction: column; overflow: hidden; padding: 8px; }
.sp-card:hover { transform: translateY(-8px); }
.sp-card .name { font-weight: 800; font-size: 13px; line-height: 1.12; overflow-wrap: anywhere; }
.sp-card .set { font-size: 9px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; margin-top: 2px; }
.sp-card .blurb { margin-top: auto; font-size: 10.5px; line-height: 1.18; color: #3c3830; overflow-wrap: anywhere; }
.sp-card.empty { background: #20202c; border-style: dashed; border-color: #3a3a4e; cursor: default; box-shadow: none; color: #6b6f8a; }
.sp-card.empty:hover { transform: none; }
.sp-card .cool { margin: auto; text-align: center; color: #7f8bd0; font-weight: 800; font-size: 15px; }
.sp-card .cool span { display: block; font-size: 10px; font-weight: 600; color: #5a5f80; margin-top: 3px; }
.sp-card .key { position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
  background: #2a2a38; color: #ffd76a; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 6px; }
.sp-card .lv { position: absolute; top: 5px; right: 5px; background: #b9862a; color: #fff;
  font-size: 10px; font-weight: 800; padding: 1px 5px; border-radius: 6px; }
.sp-card .cost { position: absolute; bottom: 5px; right: 5px; background: #8a2f28; color: #ffd8cc;
  font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 6px; box-shadow: 0 0 5px rgba(255,80,50,.5); }
.sp-card.unafford { filter: grayscale(.65) brightness(.7); }
.sp-card.unafford:hover { transform: none; }
.sp-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.sp-btn { border: none; border-radius: 10px; padding: 9px 14px; cursor: pointer; color: #fff;
  font-size: 13px; font-weight: 700; text-align: left; line-height: 1.3; }
.sp-btn:disabled { filter: grayscale(.6) brightness(.6); cursor: default; }
.sp-btn small { font-weight: 400; opacity: .85; }
.sp-wave { background: #7a3a6a; flex: 1; } .sp-wave:hover:not(:disabled) { background: #8f458a; }
.sp-alt { background: #364a6b; } .sp-alt:hover { background: #40587f; }
.sp-reward { background: #2c6b4a; } .sp-reward:hover { background: #348055; }
.sp-reward-title { color: #7affc0; font-weight: 700; font-size: 13px; margin: 2px; }
.sp-window { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #3a3a4e; vertical-align: middle; }
.sp-window.open { background: #ffd76a; box-shadow: 0 0 8px #ffd76a; }
.sp-adr { display: inline-flex; gap: 4px; align-items: center; }
.sp-adr .pip { width: 13px; height: 13px; border-radius: 3px; background: #37232a; border: 1px solid #52333a; transform: skewX(-12deg); }
.sp-adr .pip.on { background: linear-gradient(#ff8a3a, #ff4d3d); border-color: #ffb066; box-shadow: 0 0 7px rgba(255,90,50,.7); }
.sp-adr .bonus { color: #ff8a5a; font-weight: 800; font-size: 12px; margin-left: 4px; }
.sp-hint { color: #8a8a9a; font-size: 11.5px; line-height: 1.4; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** A fixed-width row label (e.g. "Speed") for the character stats panel. */
function makeLabel(text: string): HTMLElement {
  const span = el('span', 'tag');
  span.textContent = text;
  span.style.width = '52px';
  span.style.color = '#c9c9d8';
  return span;
}

/** A dim descriptor cell for a stat row. */
function makeEff(text: string): HTMLElement {
  const span = el('span', 'eff');
  span.textContent = text;
  return span;
}

type Stat = 'strength' | 'agility' | 'intelligence';

export class SpellHud {
  private readonly banner: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly waveText: HTMLElement;
  private readonly windowPip: HTMLElement;
  private readonly adrPips: HTMLElement[] = [];
  private readonly adrBonus: HTMLElement;
  private readonly cards: HTMLElement[] = [];
  private readonly waveBtn: HTMLButtonElement;
  private readonly charName: HTMLElement;
  private readonly charSpeed: HTMLElement;
  private readonly charTurn: HTMLElement;
  private readonly levelText: HTMLElement;
  private readonly statVals: Record<Stat, HTMLElement>;
  private readonly statPlus: Record<Stat, HTMLButtonElement>;
  private readonly rewardTitle: HTMLElement;
  private readonly rewardRow: HTMLElement;
  private readonly rewardBtns: HTMLButtonElement[] = [];
  private readonly pickTitle: HTMLElement;
  private readonly pickRow: HTMLElement;
  private readonly input: SpellInputCapture;
  private lastHandKey = '';
  private lastPickKey = '';

  constructor(sideRoot: HTMLElement, handRoot: HTMLElement, input: SpellInputCapture, onToggleMute: () => void) {
    this.input = input;
    const style = el('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    sideRoot.classList.add('sp-side');
    handRoot.classList.add('sp-hand-wrap');

    // --- Status line ---
    const status = el('div', 'sp-status');
    this.hp = el('span');
    this.waveText = el('span');
    const windowWrap = el('span');
    this.windowPip = el('span', 'sp-window');
    windowWrap.append(document.createTextNode('Window '), this.windowPip);
    const adrWrap = el('span', 'sp-adr');
    const adrLabel = el('b');
    adrLabel.textContent = 'ADR';
    adrWrap.appendChild(adrLabel);
    for (let i = 0; i < MAX_ADRENALINE; i++) {
      const pip = el('span', 'pip');
      this.adrPips.push(pip);
      adrWrap.appendChild(pip);
    }
    this.adrBonus = el('span', 'bonus');
    adrWrap.appendChild(this.adrBonus);
    this.banner = el('span', 'sp-banner');
    status.append(this.hp, this.waveText, adrWrap, windowWrap, this.banner);
    sideRoot.appendChild(status);

    // --- RPG stats panel (spec 029) ---
    const stats = el('div', 'sp-panel');
    const statsHead = el('h4');
    statsHead.append(document.createTextNode('Stats · '), (this.levelText = el('span', 'sp-lvl')));
    stats.appendChild(statsHead);
    this.statVals = {} as Record<Stat, HTMLElement>;
    this.statPlus = {} as Record<Stat, HTMLButtonElement>;
    (['strength', 'agility', 'intelligence'] as Stat[]).forEach((stat) => {
      const info = STAT_INFO[stat];
      const row = el('div', 'sp-stat');
      const tag = el('span', 'tag');
      tag.textContent = info.label;
      tag.style.color = info.color;
      const val = el('span', 'val');
      const eff = el('span', 'eff');
      eff.textContent = info.effect;
      const plus = el('button', 'sp-plus');
      plus.textContent = '+';
      plus.title = `Spend a point on ${info.label}`;
      plus.addEventListener('click', () => input.queueAllocate(stat));
      row.append(tag, val, eff, plus);
      stats.appendChild(row);
      this.statVals[stat] = val;
      this.statPlus[stat] = plus;
    });
    sideRoot.appendChild(stats);

    // --- Character panel: the movement archetype's stats (spec 029) ---
    const charPanel = el('div', 'sp-panel');
    const charHead = el('h4');
    charHead.append(document.createTextNode('Character · '), (this.charName = el('span', 'sp-lvl')));
    charPanel.appendChild(charHead);
    const speedRow = el('div', 'sp-stat');
    speedRow.append(makeLabel('Speed'), (this.charSpeed = el('span', 'val')), makeEff('world units / sec'));
    const turnRow = el('div', 'sp-stat');
    turnRow.append(makeLabel('Turn'), (this.charTurn = el('span', 'val')), makeEff('deg / sec (base + AGI)'));
    const swapBtn = el('button', 'sp-btn sp-alt');
    swapBtn.style.marginTop = '6px';
    swapBtn.textContent = 'SWAP CHARACTER (C)';
    swapBtn.addEventListener('click', () => input.queueCycleCharacter());
    charPanel.append(speedRow, turnRow, swapBtn);
    sideRoot.appendChild(charPanel);

    // --- Buttons: spawn wave, mute ---
    const controls = el('div', 'sp-controls');
    this.waveBtn = el('button', 'sp-btn sp-wave');
    this.waveBtn.addEventListener('click', () => input.queueWave());
    const muteBtn = el('button', 'sp-btn sp-alt');
    muteBtn.textContent = 'Mute (M)';
    muteBtn.addEventListener('click', onToggleMute);
    controls.append(this.waveBtn, muteBtn);
    sideRoot.appendChild(controls);

    // --- Wave-reward panel + card picker (choices = controls, so on the side) ---
    this.rewardTitle = el('div', 'sp-reward-title');
    this.rewardTitle.textContent = 'Wave cleared — choose a reward:';
    this.rewardRow = el('div', 'sp-controls');
    for (let i = 0; i < 3; i++) {
      const btn = el('button', 'sp-btn sp-reward');
      btn.addEventListener('click', () => input.queueReward(i as 0 | 1 | 2));
      this.rewardBtns.push(btn);
      this.rewardRow.appendChild(btn);
    }
    this.rewardTitle.style.display = 'none';
    this.rewardRow.style.display = 'none';
    sideRoot.append(this.rewardTitle, this.rewardRow);

    this.pickTitle = el('div', 'sp-reward-title');
    this.pickRow = el('div', 'sp-controls');
    this.pickTitle.style.display = 'none';
    this.pickRow.style.display = 'none';
    sideRoot.append(this.pickTitle, this.pickRow);

    const hint = el('div', 'sp-hint');
    hint.textContent =
      'move: right-click · aim: mouse · attack/cast: 1–4 or click a card · wave: Q · character: C · Attack banks ADR (spell cards cost ◆ADR)';
    sideRoot.appendChild(hint);

    // --- Hand: below the canvas ---
    const hand = el('div', 'sp-hand');
    for (let i = 0; i < HAND_SIZE; i++) {
      const card = el('div', 'sp-card');
      card.addEventListener('click', () => input.queuePlay(i as 0 | 1 | 2 | 3));
      const key = el('span', 'key');
      key.textContent = String(i + 1);
      card.appendChild(key);
      this.cards.push(card);
      hand.appendChild(card);
    }
    handRoot.appendChild(hand);
  }

  render(state: SpellGameState): void {
    const combat = state.combat;
    const player = combat.player;

    this.hp.innerHTML = `<b>HP</b> ${Math.ceil(player.health)}/${player.maxHealth}`;
    this.waveText.innerHTML = `<b>Wave</b> ${combat.waveNumber}`;
    this.windowPip.classList.toggle('open', state.windowClosesAtTick !== null);
    this.renderAdrenaline(player.adrenaline);
    this.renderStats(player.level, player.statPoints, player.strength, player.agility, player.intelligence);

    const slowed = combat.tick < player.moveSlowUntilTick;
    this.renderBanner(combat.enemies, combat.over, slowed);
    this.renderHand(state.deck.hand, state.refillAtTick, combat.tick, player.adrenaline);
    this.renderReward(state.pendingReward);
    this.renderPick(state.pendingPick);

    // A new wave can't be summoned mid-wave (no stacking) or while a reward is open.
    const waveInProgress = combat.enemies.length > 0;
    this.waveBtn.disabled = state.pendingReward !== null || state.pendingPick !== null || waveInProgress;
    const next = combat.waveNumber + 1;
    this.waveBtn.innerHTML = waveInProgress
      ? 'WAVE IN PROGRESS<br><small>clear the arena first</small>'
      : `SPAWN WAVE ${next}<br><small>${WAVE_BASE_COUNT + next} enemies, tougher</small>`;

    // Character stats (spec 029): the base preset speed and the AGILITY-boosted turn rate.
    const ch = characterAt(player.characterIndex);
    this.charName.textContent = ch.name;
    this.charSpeed.textContent = String(ch.moveSpeed);
    this.charTurn.textContent = String(ch.turnRate + player.agility * TURN_RATE_PER_AGILITY);
  }

  private renderStats(level: number, points: number, str: number, agi: number, int: number): void {
    this.levelText.textContent = `Level ${level}` + (points > 0 ? ` · ${points} point${points > 1 ? 's' : ''}` : '');
    this.statVals.strength.textContent = String(str);
    this.statVals.agility.textContent = String(agi);
    this.statVals.intelligence.textContent = String(int);
    const canSpend = points > 0;
    this.statPlus.strength.disabled = !canSpend;
    this.statPlus.agility.disabled = !canSpend;
    this.statPlus.intelligence.disabled = !canSpend;
  }

  private renderAdrenaline(adrenaline: number): void {
    this.adrPips.forEach((pip, i) => pip.classList.toggle('on', i < adrenaline));
    const bonus = Math.round(ADRENALINE_SPEED_PER_POINT * adrenaline * 100);
    this.adrBonus.textContent = bonus > 0 ? `+${bonus}% SPD` : '';
  }

  private renderReward(offers: SpellGameState['pendingReward']): void {
    const show = offers !== null;
    this.rewardTitle.style.display = show ? '' : 'none';
    this.rewardRow.style.display = show ? '' : 'none';
    if (!offers) return;
    offers.forEach((offer: RewardOffer, i) => {
      const btn = this.rewardBtns[i];
      if (!btn) return;
      if (offer.kind === 'addFire' && offer.cardId) {
        btn.innerHTML = `ADD: ${SPELL_CARDS[offer.cardId].name}<br><small>a fresh fire card</small>`;
      } else if (offer.kind === 'remove') {
        btn.innerHTML = 'REMOVE A CARD<br><small>choose any to thin</small>';
      } else {
        btn.innerHTML = 'UPGRADE A CARD<br><small>choose one (not attack/dash)</small>';
      }
    });
  }

  private renderPick(pick: SpellGameState['pendingPick']): void {
    const show = pick !== null;
    this.pickTitle.style.display = show ? '' : 'none';
    this.pickRow.style.display = show ? '' : 'none';
    if (!pick) {
      this.lastPickKey = '';
      return;
    }
    this.pickTitle.textContent = pick.kind === 'remove' ? 'Remove which card?' : 'Upgrade which card?';
    const key = `${pick.kind}|${pick.candidates.join(',')}`;
    if (key === this.lastPickKey) return;
    this.lastPickKey = key;
    this.pickRow.replaceChildren();
    pick.candidates.forEach((id, i) => {
      const btn = el('button', 'sp-btn sp-reward');
      btn.textContent = SPELL_CARDS[id].name;
      btn.addEventListener('click', () => this.input.queuePick(i));
      this.pickRow.appendChild(btn);
    });
  }

  private renderBanner(enemies: SpellGameState['combat']['enemies'], over: boolean, slowed: boolean): void {
    if (over) {
      this.banner.textContent = '☠ DEFEATED — reload to retry';
      this.banner.style.color = '#ff5a5a';
      return;
    }
    if (slowed) {
      this.banner.textContent = 'fumbled combo — slowed!';
      this.banner.style.color = '#b49be0';
      return;
    }
    if (enemies.length === 0) {
      this.banner.textContent = 'arena clear — spawn a wave (Q)';
      this.banner.style.color = '#9a9ab0';
    } else if (enemies.some((e) => e.behavior === 'hunting')) {
      this.banner.textContent = 'enemies closing — cast!';
      this.banner.style.color = '#ffd76a';
    } else {
      this.banner.textContent = 'the herd grazes';
      this.banner.style.color = '#9a9ab0';
    }
  }

  private renderHand(hand: SpellHand, refillAtTick: readonly (number | null)[], tick: number, adrenaline: number): void {
    const key = hand.map((c) => (c ? `${c.instanceId}:${c.level}` : 'x')).join(',');
    if (key !== this.lastHandKey) {
      this.lastHandKey = key;
      hand.forEach((card, i) => this.buildFace(this.cards[i], card));
    }
    hand.forEach((card, i) => {
      const node = this.cards[i];
      if (!node) return;
      const cost = card ? spellCardCost(card.id) : 0;
      node.classList.toggle('unafford', card !== null && cost > adrenaline);
      if (card) return;
      const label = node.querySelector('.cool')?.firstChild;
      if (!label) return;
      const at = refillAtTick[i];
      label.textContent = at !== null && at !== undefined ? `↻ ${Math.max(0, (at - tick) / TICK_RATE).toFixed(1)}s` : '—';
    });
  }

  private buildFace(node: HTMLElement | undefined, card: SpellCard | null): void {
    if (!node) return;
    node.querySelectorAll('.name,.set,.blurb,.cool,.lv,.cost').forEach((n) => n.remove());
    node.classList.toggle('empty', !card);
    if (!card) node.classList.remove('unafford');

    if (!card) {
      node.style.background = '';
      node.style.borderColor = '';
      const cool = el('div', 'cool');
      cool.appendChild(document.createTextNode('↻'));
      const caption = el('span');
      caption.textContent = 'drawing';
      cool.appendChild(caption);
      node.appendChild(cool);
      return;
    }

    const def = SPELL_CARDS[card.id];
    const palette = SET_COLOR[def.set];
    node.style.background = palette.bg;
    node.style.borderColor = palette.edge;
    const name = el('div', 'name');
    name.textContent = def.name;
    const set = el('div', 'set');
    set.textContent = def.set;
    const blurb = el('div', 'blurb');
    blurb.textContent = def.blurb;
    node.append(name, set, blurb);
    if (card.level > 1) {
      const lv = el('span', 'lv');
      lv.textContent = `Lv${card.level}`;
      node.appendChild(lv);
    }
    const cost = spellCardCost(card.id);
    if (cost > 0) {
      const badge = el('span', 'cost');
      badge.textContent = `◆${cost}`;
      badge.title = `${cost} adrenaline to play`;
      node.appendChild(badge);
    }
  }
}
