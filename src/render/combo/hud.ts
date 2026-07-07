import { cardLabel, HAND_SIZE, type PlayingCard, type StandardHand } from '../../cards/standard.js';
import { evaluateHand, POKER_LABELS } from '../../cards/poker.js';
import { actionVerb, cardAction, handStance, type StanceGrant } from '../../cards/stance.js';
import type { ComboGameState } from '../../game/combo-session.js';
import { WAVE_BASE_COUNT } from '../../sim/constants.js';
import { TICK_RATE } from '../../sim/constants.js';
import type { ComboInputCapture } from './input.js';

/**
 * DOM heads-up display for the prototype (spec 014). Renders the five held
 * cards as real playing cards, a live poker readout of what the hand is worth
 * as a combo, and the Activate / Spawn Wave buttons. Its whole job is to make
 * the "play this card now vs. hold it for the combo" trade-off legible at a
 * glance -- the readout always shows both what a card does *and* what the hand
 * would grant if held. No game rules here; it only reads state and reports clicks.
 */

const SUIT_GLYPH = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' } as const;

const STYLE = `
.td-hud { font-family: 'Segoe UI', system-ui, sans-serif; color: #d8dae6; width: 900px; }
.td-status { display: flex; gap: 22px; align-items: baseline; margin: 8px 2px; font-size: 14px; }
.td-status b { color: #fff; font-size: 16px; }
.td-banner { min-width: 260px; font-weight: 700; }
.td-hand { display: flex; gap: 12px; align-items: flex-end; }
.td-card { width: 92px; height: 130px; border-radius: 10px; background: #f5f1e6; color: #1b1b22;
  box-shadow: 0 3px 8px rgba(0,0,0,.4); cursor: pointer; position: relative; user-select: none;
  border: 2px solid #cbb47a; transition: transform .08s ease; display: flex; flex-direction: column; }
.td-card:hover { transform: translateY(-8px); border-color: #ffd76a; }
.td-card .corner { position: absolute; font-weight: 800; font-size: 18px; line-height: 1; }
.td-card .tl { top: 7px; left: 8px; }
.td-card .br { bottom: 26px; right: 8px; transform: rotate(180deg); }
.td-card .pip { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 40px; }
.td-card .foot { text-align: center; font-size: 11px; font-weight: 700; padding: 3px 2px 6px; color: #4a4436; }
.td-card.red { color: #c0392b; } .td-card.red .foot { color: #9a3325; }
.td-card .key { position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
  background: #2a2a38; color: #ffd76a; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 6px; }
.td-controls { display: flex; gap: 12px; align-items: stretch; margin-top: 14px; }
.td-btn { border: none; border-radius: 10px; padding: 10px 16px; cursor: pointer; color: #fff;
  font-size: 14px; font-weight: 700; text-align: left; line-height: 1.35; }
.td-btn small { font-weight: 400; opacity: .85; }
.td-activate { background: #b9862a; }
.td-activate:hover { background: #cf9a34; }
.td-activate:disabled { background: #4a4534; cursor: default; opacity: .7; }
.td-wave { background: #7a3a6a; } .td-wave:hover { background: #8f458a; }
.td-hint { color: #8a8a9a; font-size: 12px; margin-top: 10px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function actionLabel(card: PlayingCard): string {
  const action = cardAction(card);
  switch (action.kind) {
    case 'damage':
      return `${actionVerb(card.suit)} ${action.amount}`;
    case 'heal':
      return `${actionVerb(card.suit)} ${action.amount}`;
    case 'guard':
      return `${actionVerb(card.suit)} ${Math.round(action.reductionPct * 100)}%`;
    case 'slow':
      return `${actionVerb(card.suit)} ${Math.round((1 - action.multiplier) * 100)}%`;
  }
}

/** Compact "what would this stance give me" summary; only non-empty stats. */
export function stanceSummary(grant: StanceGrant): string {
  const parts: string[] = [];
  if (grant.attackBonus >= 0.5) parts.push(`+${Math.round(grant.attackBonus)} atk`);
  if (grant.reductionPct >= 0.01) parts.push(`${Math.round(grant.reductionPct * 100)}% block`);
  if (grant.regenPerSecond >= 0.1) parts.push(`+${Math.round(grant.regenPerSecond)} hp/s`);
  if (grant.slowMultiplier <= 0.99) parts.push(`${Math.round((1 - grant.slowMultiplier) * 100)}% slow`);
  return parts.length > 0 ? parts.join(' · ') : 'no bonus';
}

export class ComboHud {
  private readonly banner: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly waveText: HTMLElement;
  private readonly stanceText: HTMLElement;
  private readonly cards: HTMLElement[] = [];
  private readonly activateBtn: HTMLButtonElement;
  private readonly waveBtn: HTMLButtonElement;
  private lastHandKey = '';

  constructor(root: HTMLElement, input: ComboInputCapture) {
    const style = el('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    root.classList.add('td-hud');

    const status = el('div', 'td-status');
    this.hp = el('span');
    this.waveText = el('span');
    this.stanceText = el('span');
    this.banner = el('span', 'td-banner');
    status.append(this.hp, this.waveText, this.stanceText, this.banner);
    root.appendChild(status);

    const hand = el('div', 'td-hand');
    for (let i = 0; i < HAND_SIZE; i++) {
      const card = el('div', 'td-card');
      card.addEventListener('click', () => input.queuePlay(i as 0 | 1 | 2 | 3 | 4));
      const key = el('span', 'key');
      key.textContent = String(i + 1);
      card.appendChild(key);
      this.cards.push(card);
      hand.appendChild(card);
    }
    root.appendChild(hand);

    const controls = el('div', 'td-controls');
    this.activateBtn = el('button', 'td-btn td-activate');
    this.activateBtn.addEventListener('click', () => input.queueActivate());
    this.waveBtn = el('button', 'td-btn td-wave');
    this.waveBtn.addEventListener('click', () => input.queueWave());
    controls.append(this.activateBtn, this.waveBtn);
    root.appendChild(controls);

    const hint = el('div', 'td-hint');
    hint.textContent =
      'move: WASD  ·  aim: mouse  ·  attack: click / space  ·  parry: K  ·  dodge: L  ·  play card: 1–5 / click  ·  activate combo: E  ·  spawn wave: Q';
    root.appendChild(hint);
  }

  render(state: ComboGameState): void {
    const combat = state.combat;
    const player = combat.player;

    this.hp.innerHTML = `<b>HP</b> ${Math.ceil(player.health)}/${player.maxHealth}`;
    this.waveText.innerHTML = `<b>Wave</b> ${combat.waveNumber}`;

    const stanceLeft = (player.stanceExpiresAtTick - combat.tick) / TICK_RATE;
    this.stanceText.innerHTML =
      stanceLeft > 0 ? `<b>Stance</b> ${stanceLeft.toFixed(1)}s` : `<b>Stance</b> —`;

    this.renderBanner(combat.enemies, combat.tick, combat.over);
    this.renderHand(state.deck.hand);
    this.renderControls(state, combat.tick);
  }

  private renderBanner(enemies: ComboGameState['combat']['enemies'], tick: number, over: boolean): void {
    if (over) {
      this.banner.textContent = '☠ DEFEATED — reload to retry';
      this.banner.style.color = '#ff5a5a';
      return;
    }
    let soonest = Infinity;
    for (const e of enemies) if (e.behavior === 'hunting' && e.phase === 'windup') soonest = Math.min(soonest, e.phaseEndsAtTick - tick);
    const hunting = enemies.some((e) => e.behavior === 'hunting');
    if (soonest !== Infinity) {
      this.banner.textContent = soonest <= 4 ? '⚠ PARRY NOW (K)!' : `⚠ slam in ${Math.max(0, soonest / TICK_RATE).toFixed(1)}s`;
      this.banner.style.color = soonest <= 4 ? '#7affc0' : '#ff8c1a';
    } else if (hunting) {
      this.banner.textContent = 'enemies closing — punish the recovery';
      this.banner.style.color = '#ffd76a';
    } else if (enemies.length === 0) {
      this.banner.textContent = 'arena clear — spawn a wave (Q)';
      this.banner.style.color = '#9a9ab0';
    } else {
      this.banner.textContent = 'the herd grazes';
      this.banner.style.color = '#9a9ab0';
    }
  }

  private renderHand(hand: StandardHand): void {
    const key = hand.map((c) => (c ? c.instanceId : 'x')).join(',');
    if (key === this.lastHandKey) return; // faces only change when the hand changes
    this.lastHandKey = key;

    hand.forEach((card, i) => {
      const node = this.cards[i];
      if (!node) return;
      node.querySelectorAll('.corner,.pip,.foot').forEach((n) => n.remove());
      node.classList.toggle('red', card?.suit === 'hearts' || card?.suit === 'diamonds');
      node.style.visibility = card ? 'visible' : 'hidden';
      if (!card) return;
      const glyph = SUIT_GLYPH[card.suit];
      const label = cardLabel(card).slice(0, -1);
      const tl = el('span', 'corner tl');
      tl.textContent = `${label}${glyph}`;
      const pip = el('div', 'pip');
      pip.textContent = glyph;
      const br = el('span', 'corner br');
      br.textContent = `${label}${glyph}`;
      const foot = el('div', 'foot');
      foot.textContent = actionLabel(card);
      node.append(tl, pip, br, foot);
    });
  }

  private renderControls(state: ComboGameState, tick: number): void {
    const cards = state.deck.hand.filter((c): c is PlayingCard => c !== null);
    const lockLeft = (state.combat.player.activateLockUntil - tick) / TICK_RATE;

    if (lockLeft > 0) {
      this.activateBtn.disabled = true;
      this.activateBtn.innerHTML = `LOCKED ${lockLeft.toFixed(1)}s<br><small>stance cooling down</small>`;
    } else if (cards.length > 0) {
      this.activateBtn.disabled = false;
      const category = POKER_LABELS[evaluateHand(cards).category];
      const summary = stanceSummary(handStance(cards));
      this.activateBtn.innerHTML = `ACTIVATE — ${category}<br><small>${summary}</small>`;
    } else {
      this.activateBtn.disabled = true;
      this.activateBtn.innerHTML = 'ACTIVATE<br><small>empty hand</small>';
    }

    const next = state.combat.waveNumber + 1;
    this.waveBtn.innerHTML = `SPAWN WAVE ${next}<br><small>${WAVE_BASE_COUNT + next} enemies, tougher</small>`;
  }
}
