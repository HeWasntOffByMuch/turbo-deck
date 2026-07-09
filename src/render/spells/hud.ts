import { HAND_SIZE, SPELL_CARDS, type CardSet, type SpellCard, type SpellHand } from '../../cards/spells.js';
import type { RewardOffer, SpellGameState } from '../../game/spell-session.js';
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
.sp-controls { display: flex; gap: 12px; align-items: stretch; margin-top: 14px; flex-wrap: wrap; }
.sp-btn { border: none; border-radius: 10px; padding: 10px 16px; cursor: pointer; color: #fff;
  font-size: 14px; font-weight: 700; text-align: left; line-height: 1.35; }
.sp-btn small { font-weight: 400; opacity: .85; }
.sp-wave { background: #7a3a6a; } .sp-wave:hover { background: #8f458a; }
.sp-reward { background: #2c6b4a; min-width: 150px; } .sp-reward:hover { background: #348055; }
.sp-reward-title { color: #7affc0; font-weight: 700; font-size: 13px; margin: 12px 2px 2px; }
.sp-window { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #3a3a4e; vertical-align: middle; }
.sp-window.open { background: #ffd76a; box-shadow: 0 0 8px #ffd76a; }
.sp-hint { color: #8a8a9a; font-size: 12px; margin-top: 10px; }
`;

const REWARD_VERB: Record<string, string> = { remove: 'Remove', upgrade: 'Upgrade', addFire: 'Add' };

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
  private readonly rewardTitle: HTMLElement;
  private readonly rewardRow: HTMLElement;
  private readonly rewardBtns: HTMLButtonElement[] = [];
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

    // Wave-reward panel: hidden until a wave clears, then three offer buttons.
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
    root.append(this.rewardTitle, this.rewardRow);

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

    const slowed = combat.tick < player.moveSlowUntilTick;
    this.renderBanner(combat.enemies, combat.over, slowed);
    this.renderHand(state.deck.hand, state.refillAtTick, combat.tick);
    this.renderReward(state.pendingReward);

    const next = combat.waveNumber + 1;
    this.waveBtn.innerHTML = `SPAWN WAVE ${next}<br><small>${WAVE_BASE_COUNT + next} enemies, tougher</small>`;
  }

  private renderReward(offers: SpellGameState['pendingReward']): void {
    const show = offers !== null;
    this.rewardTitle.style.display = show ? '' : 'none';
    this.rewardRow.style.display = show ? '' : 'none';
    this.waveBtn.disabled = show;
    if (!offers) return;
    offers.forEach((offer: RewardOffer, i) => {
      const btn = this.rewardBtns[i];
      if (!btn) return;
      const name = SPELL_CARDS[offer.cardId].name;
      const verb = REWARD_VERB[offer.kind] ?? offer.kind;
      const sub =
        offer.kind === 'remove' ? 'thin your deck' : offer.kind === 'upgrade' ? '+1 level, more damage' : 'a fresh fire card';
      btn.innerHTML = `${verb.toUpperCase()}: ${name}<br><small>${sub}</small>`;
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

  private renderHand(hand: SpellHand, refillAtTick: readonly (number | null)[], tick: number): void {
    // Include level so an upgraded card's badge refreshes even though its id is stable.
    const key = hand.map((c) => (c ? `${c.instanceId}:${c.level}` : 'x')).join(',');
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
    node.querySelectorAll('.name,.set,.blurb,.cool,.lv').forEach((n) => n.remove());
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
    if (card.level > 1) {
      const lv = el('span', 'lv');
      lv.textContent = `Lv${card.level}`;
      node.appendChild(lv);
    }
  }
}
