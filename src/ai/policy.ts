import type {
  Card,
  CardName,
  GameView,
  PlayerId,
  PlayerView,
  Request,
  Response,
} from '../engine/types';
import { CARD_META } from '../data/cardMeta';
import type { RngState } from '../engine/rng';
import { nextFloat } from '../engine/rng';

/**
 * M1 AI：只讀取「該 AI 自己的視角」，不偷看其他人的手牌與身份。
 * 目標評分依角色與公開資訊（主公已知、自己身份已知）決定。
 */

function selfOf(view: GameView): PlayerView {
  const self = view.players.find((player) => player.id === view.pending?.player);
  if (!self) throw new Error('AI view has no pending player');
  return self;
}

function roleEnemyScore(view: GameView, self: PlayerView, target: PlayerView): number {
  if (target.id === self.id || !target.alive) return -1;
  if (self.role === 'rebel') {
    if (target.role === 'lord') return 100;
    return 15;
  }
  if (self.role === 'loyal') {
    if (target.role === 'lord') return -100;
    return 40;
  }
  if (self.role === 'spy') {
    const alive = view.players.filter((player) => player.alive).length;
    if (target.role === 'lord') return alive <= 2 ? 120 : 10;
    return 35;
  }
  // 主公：其他人都可能是反賊或內奸。
  return target.role === 'loyal' ? -30 : 45;
}

function cardValue(name: CardName): number {
  switch (name) {
    case 'peach':
      return 100;
    case 'ex_nihilo':
      return 85;
    case 'dodge':
      return 70;
    case 'wine':
      return 35;
    case 'dismantle':
    case 'snatch':
      return 55;
    case 'slash':
    case 'fire_slash':
    case 'thunder_slash':
      return 40;
    default:
      return CARD_META[name].type === 'equip' ? 45 : 30;
  }
}

function jitter(rng: RngState, amount = 6): number {
  return nextFloat(rng) * amount;
}

function chooseAction(view: GameView, request: Request & { kind: 'action' }, rng: RngState): Response {
  const self = selfOf(view);
  const options = request.options;
  let best: { id: string; score: number } | null = null;

  const slashOptions = options.filter(
    (option) => option.asCard === 'slash' || option.asCard === 'fire_slash' || option.asCard === 'thunder_slash',
  );
  const hasHealTarget = options.some(
    (option) => option.asCard === 'peach' && option.targets[0] !== self.id,
  );

  for (const option of options) {
    let score = 0;
    const target = option.targets[0] === undefined ? null : view.players[option.targets[0]] ?? null;

    switch (option.kind) {
      case 'pass':
        score = 0;
        break;
      case 'play':
        break;
      default:
        score = -10;
        break;
    }

    if (option.asCard) {
      const name = option.asCard;
      score += cardValue(name) * 0.2;

      if (name === 'ex_nihilo') score += 80;
      if (name === 'wine') {
        score += slashOptions.length > 0 ? 18 : -20;
      }
      if (name === 'peach') {
        if (option.targets[0] === self.id) {
          const missing = self.maxHp - self.hp;
          score += missing > 0 ? 60 + missing * 15 : -50;
        } else if (self.role === 'loyal' && target?.role === 'lord') {
          score += 40;
        } else if (self.role === 'lord' && target?.role === 'loyal') {
          score += 20;
        } else {
          score -= 25;
        }
      }
      if (name === 'dismantle' || name === 'snatch') {
        if (target) {
          const base = roleEnemyScore(view, self, target);
          score += base > 0 ? 35 + base * 0.3 : -40;
          if (target.equips.armor?.name === 'vine_armor' || target.equips.armor?.name === 'eight_diagram') {
            score += 10;
          }
          if (target.equips.weapon) score += 8;
        }
      }
      if (name === 'slash' || name === 'fire_slash' || name === 'thunder_slash') {
        if (target) {
          const enemy = roleEnemyScore(view, self, target);
          if (enemy <= 0) {
            score -= 80;
          } else {
            const damage = 1 + (self.wine ? 1 : 0);
            score += 40 + enemy * 0.25;
            if (target.hp <= damage) score += 70;
            if (target.handCount === 0) score += 12;
            if (target.equips.armor?.name === 'vine_armor') {
              score += name === 'fire_slash' ? 25 : name === 'slash' ? -30 : 0;
            }
            if (target.equips.armor?.name === 'renwang') score -= 15;
          }
        }
      }
      if (CARD_META[name].type === 'equip') {
        score += 45;
        if (option.cards.length > 0 && self.hand) {
          // 已有同類裝備時略為降低優先度。
          const card = self.hand.find((item) => item.id === option.cards[0]);
          if (card && isSlotOccupied(self, card)) score -= 20;
        }
      }
    }

    if (hasHealTarget && option.asCard === 'peach' && option.targets[0] !== self.id) {
      score -= 15;
    }

    score += jitter(rng);
    if (!best || score > best.score) best = { id: option.id, score };
  }

  if (!best || best.score <= 0) {
    const pass = options.find((option) => option.kind === 'pass');
    if (pass) return { type: 'option', optionId: pass.id };
  }
  return { type: 'option', optionId: best!.id };
}

function isSlotOccupied(self: PlayerView, card: Card): boolean {
  const meta = CARD_META[card.name];
  if (meta.type !== 'equip' || !meta.subtype) return false;
  switch (meta.subtype) {
    case 'weapon':
      return self.equips.weapon !== null;
    case 'armor':
      return self.equips.armor !== null;
    case 'horse_plus':
      return self.equips.horsePlus !== null;
    case 'horse_minus':
      return self.equips.horseMinus !== null;
    default:
      return false;
  }
}

function chooseResponse(
  view: GameView,
  request: Request & { kind: 'response' },
  rng: RngState,
): Response {
  const self = selfOf(view);
  const options = request.options.filter((option) => option.kind !== 'pass');
  const pass = request.options.find((option) => option.kind === 'pass');
  if (options.length === 0) {
    return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
  }

  if (request.need === 'shan') {
    // 八卦陣是免費判定，先試。
    const bagua = options.find((option) => option.skill === 'bagua');
    if (bagua) return { type: 'option', optionId: bagua.id };
    const dodge = options.find((option) => option.asCard === 'dodge');
    if (dodge) return { type: 'option', optionId: dodge.id };
  }

  if (request.need === 'peach') {
    const dyingId = findDyingId(view);
    const dying = dyingId === null ? null : view.players[dyingId] ?? null;
    const savesLord = self.role === 'loyal' && dying?.role === 'lord';
    const savesAlly = self.role === 'lord' && dying?.role === 'loyal';
    if (dyingId === self.id || savesLord || savesAlly) {
      const heal = options.find((option) => option.asCard === 'peach' || option.asCard === 'wine');
      if (heal) return { type: 'option', optionId: heal.id };
    }
    // 內奸在最後單挑時救主公，避免反賊勝利。
    if (self.role === 'spy' && dying?.role === 'lord') {
      const alive = view.players.filter((player) => player.alive).length;
      if (alive <= 2) {
        const heal = options.find((option) => option.asCard === 'peach');
        if (heal) return { type: 'option', optionId: heal.id };
      }
    }
  }

  if (request.need === 'sha') {
    const slash = options.find(
      (option) =>
        option.asCard === 'slash' || option.asCard === 'fire_slash' || option.asCard === 'thunder_slash',
    );
    if (slash) return { type: 'option', optionId: slash.id };
  }

  if (request.need === 'wuxie') {
    const wuxie = options.find((option) => option.asCard === 'nullification');
    if (wuxie && nextFloat(rng) < 0.6) return { type: 'option', optionId: wuxie.id };
  }

  // 未知需求時，保留手牌。
  if (pass) return { type: 'option', optionId: pass.id };
  return { type: 'option', optionId: options[0]!.id };
}

function findDyingId(view: GameView): PlayerId | null {
  const pending = view.pending;
  if (!pending || pending.kind !== 'response' || pending.need !== 'peach') return null;
  // 請求本身沒有 dying 欄位；由 prompt/context 無法可靠解析，改用所有 0 血存活者。
  const dying = view.players.filter((player) => player.alive && player.hp <= 0);
  if (dying.length === 0) return null;
  return dying[0]!.id;
}

function chooseCards(
  request: Request & { kind: 'chooseCards' },
  view: GameView,
  rng: RngState,
): Response {
  const self = selfOf(view);
  const hand = self.hand ?? [];
  const values = new Map<number, number>();
  for (const card of hand) {
    values.set(card.id, cardValue(card.name) + jitter(rng, 3));
  }
  const sorted = [...request.cards].sort((a, b) => (values.get(a) ?? 0) - (values.get(b) ?? 0));
  const count = Math.max(request.min, Math.min(request.max, request.cards.length));
  return { type: 'cards', cards: sorted.slice(0, count) };
}

function chooseCard(
  request: Request & { kind: 'chooseCard' },
  view: GameView,
  rng: RngState,
): Response {
  const target = view.players[request.target];
  if (!target) return { type: 'card', card: -1 };

  const visible: Card[] = [];
  for (const slot of ['weapon', 'armor', 'horsePlus', 'horseMinus'] as const) {
    const card = target.equips[slot];
    if (card) visible.push(card);
  }
  visible.push(...target.judgeZone);

  const preferred = visible.filter((card) => request.cards.includes(card.id));
  if (preferred.length > 0) {
    // 優先拆／拿防具與武器。
    preferred.sort((a, b) => equipPriority(b) - equipPriority(a));
    const pick = preferred.find(() => nextFloat(rng) < 0.85) ?? preferred[0]!;
    return { type: 'card', card: pick.id };
  }
  if (request.allowRandomHand) return { type: 'card', card: -1 };

  const fallback = request.cards[0];
  return { type: 'card', card: fallback ?? -1 };
}

function equipPriority(card: Card): number {
  switch (card.name) {
    case 'vine_armor':
    case 'eight_diagram':
    case 'renwang':
    case 'silver_lion':
      return 5;
    case 'crossbow':
    case 'ancient_scimitar':
    case 'fan':
      return 4;
    case 'jueying':
    case 'zhuahuang':
    case 'dilu':
    case 'hualiu':
      return 3;
    case 'chitu':
    case 'dawan':
    case 'zixing':
      return 3;
    default:
      return 2;
  }
}

export function decide(view: GameView, request: Request, rng: RngState): Response {
  switch (request.kind) {
    case 'action':
      return chooseAction(view, request, rng);
    case 'response':
      return chooseResponse(view, request, rng);
    case 'chooseCards':
      return chooseCards(request, view, rng);
    case 'chooseCard':
      return chooseCard(request, view, rng);
    case 'choosePlayers': {
      const count = Math.max(request.min, Math.min(request.max, request.candidates.length));
      return { type: 'players', players: request.candidates.slice(0, count) };
    }
    default:
      return { type: 'pass' };
  }
}

/** 供 UI／除錯顯示：回傳簡單的一行決策說明。 */
export function describeResponse(response: Response): string {
  switch (response.type) {
    case 'option':
      return `選項 ${response.optionId}`;
    case 'cards':
      return `選 ${response.cards.length} 張牌`;
    case 'players':
      return `選 ${response.players.length} 名角色`;
    case 'card':
      return response.card === -1 ? '隨機手牌' : `牌 ${response.card}`;
    default:
      return '不出';
  }
}
