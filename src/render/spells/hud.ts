import { HAND_SIZE, SPELL_CARDS, type CardSet, type SpellCard, type SpellHand } from '../../cards/spells.js';
import type { SpellGameState } from '../../game/spell-session.js';
import { TICK_RATE, WAVE_BASE_COUNT } from '../../sim/constants.js';
import type { SpellInputCapture } from './input.js';

/**
 * DOM heads-up display for the spell game (spec 018). Renders the four held
 * cards (coloured by their set), a live draw-delay countdown on spent slots, the
 * HP/wave readout and a Spawn Wave button, plus a synergy-window pip so you can
 * see the follow-up window is open. No game rules: it reads state and reports clicks.
 */

const SET_COLOR: Record<CardSet, { bg: string; edge: string }> = {
  regular: { bg: '#e7e3d6', edge: '#b9b09a' },
  fire: { bg: '#f4c9a6', edge: '#d8703a' },
  earth: { bg: '#c7d3a8', edge: '#7a9a4a' },
};

const STYLE = `
.sp-hud { font-family: 'Segoe UI', system-ui, sans-serif; color: #d8dae6; width: 900px; }
.sp-status { display: flex; gap: 22px; align-items: baseline; margin: 8px 2px; font-size: 14px; }
.sp-status b { color: #fff; font-size: 16px; }
.sp-banner { min-width: 260px; font-weight: 700; }
.sp-hand { display: flex; gap: 12px; align-items: flex-end; }
.sp-card { width: 96px; height: 132px; border-radius: 10px; background: #e7e3d6; color: #1b1b22;
  box-shadow: 0 3px 8px rgba(0,0,0,.4); cursor: pointer; position: relative; user-select: none;
  border: 2px solid #b9b09a; transition: transform .08s ease; display: flex; flex-direction: column; overflow: hidden; }
.sp-card:hover { transform: translateY(-8px); }
.sp-card .name { font-weight: 800; font-size: 14px; padding: 8px 8px 2px; }
.sp-card .set { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; padding: 0 8px; opacity: .7; }
.sp-card .blurb { margin-top: auto; font-size: 11px; padding: 6px 8px 10px; color: #3c3830; }
.sp-card.empty { background: #20202c; border-style: dashed; border-color: #3a3a4e; cursor: default; box-shadow: none; color: #6b6f8a; }
.sp-card.empty:hover { transform: none; }
.sp-card .cool { margin: auto; text-align: center; color: #7f8bd0; font-weight: 800; font-size: 15px; }
.sp-card .cool span { display: block; font-size: 10px; font-weight: 600; color: #5a5f80; margin-top: 3px; }
.sp-card .key { position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
  background: #2a2a38; color: #ffd76a; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 6px; }
.sp-controls { display: flex; gap: 12px; align-items: stretch; margin-top: 14px; }
.sp-btn { border: none; border-radius: 10px; padding: 10px 16px; cursor: pointer; color: #fff;
  font-size: 14px; font-weight: 700; text-align: left; line-height: 1.35; }
.sp-btn small { font-weight: 400; opacity: .85; }
.sp-wave { background: #7a3a6a; } .sp-wave:hover { background: #8f458a; }
.sp-window { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #3a3a4e; }
.sp-window.open { background: #ffd76a; box-shadow: 0 0 8px #ffd76a; }
.sp-hint { color: #8a8a9a; font-size: 12px; margin-top: 10px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export class SpellHud {
  private readonly banner: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly waveText: HTMLElement;
  private readonly windowPip: HTMLElement;
  private readonly cards: HTMLElement[] = [];
  private readonly waveBtn: HTMLButtonElement;
  private lastHandKey = '';

  constructor(root: HTMLElement, input: SpellInputCapture) {
    const style = el('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    root.classList.add('sp-hud');

    const status = el('div', 'sp-status');
    this.hp = el('span');
    this.waveText = el('span');
    const windowWrap = el('span');
    this.windowPip = el('span', 'sp-window');
    windowWrap.append(document.createTextNode('Window '), this.windowPip);
    this.banner = el('span', 'sp-banner');
    status.append(this.hp, this.waveText, windowWrap, this.banner);
    root.appendChild(status);

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
    root.appendChild(hand);

    const controls = el('div', 'sp-controls');
    this.waveBtn = el('button', 'sp-btn sp-wave');
    this.waveBtn.addEventListener('click', () => input.queueWave());
    controls.append(this.waveBtn);
    root.appendChild(controls);

    const hint = el('div', 'sp-hint');
    hint.textContent =
      'move: WASD · aim: mouse · play card: 1–4 / click · spawn wave: Q · play two of a kind fast for a synergy';
    root.appendChild(hint);
  }

  render(state: SpellGameState): void {
    const combat = state.combat;
    const player = combat.player;

    this.hp.innerHTML = `<b>HP</b> ${Math.ceil(player.health)}/${player.maxHealth}`;
    this.waveText.innerHTML = `<b>Wave</b> ${combat.waveNumber}`;
    this.windowPip.classList.toggle('open', state.windowClosesAtTick !== null);

    this.renderBanner(combat.enemies, combat.over);
    this.renderHand(state.deck.hand, state.refillAtTick, combat.tick);

    const next = combat.waveNumber + 1;
    this.waveBtn.innerHTML = `SPAWN WAVE ${next}<br><small>${WAVE_BASE_COUNT + next} enemies, tougher</small>`;
  }

  private renderBanner(enemies: SpellGameState['combat']['enemies'], over: boolean): void {
    if (over) {
      this.banner.textContent = '☠ DEFEATED — reload to retry';
      this.banner.style.color = '#ff5a5a';
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

  private renderHand(hand: SpellHand, refillAtTick: readonly (number | null)[], tick: number): void {
    const key = hand.map((c) => (c ? c.instanceId : 'x')).join(',');
    if (key !== this.lastHandKey) {
      this.lastHandKey = key;
      hand.forEach((card, i) => this.buildFace(this.cards[i], card));
    }
    hand.forEach((card, i) => {
      if (card) return;
      const label = this.cards[i]?.querySelector('.cool')?.firstChild;
      if (!label) return;
      const at = refillAtTick[i];
      label.textContent = at !== null && at !== undefined ? `↻ ${Math.max(0, (at - tick) / TICK_RATE).toFixed(1)}s` : '—';
    });
  }

  private buildFace(node: HTMLElement | undefined, card: SpellCard | null): void {
    if (!node) return;
    node.querySelectorAll('.name,.set,.blurb,.cool').forEach((n) => n.remove());
    node.classList.toggle('empty', !card);

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
  }
}
