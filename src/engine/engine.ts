import type {
  Card,
  CardName,
  CardUse,
  EquipState,
  GameResult,
  GameState,
  Nature,
  PlayOption,
  PlayerId,
  PlayerState,
  PublicEvent,
  Request,
  Response,
  ResponseOption,
  ResponseNeed,
} from './types';
import { CARD_META, cardLabel, isSlashCard } from '../data/cardMeta';
import { ROLE_LABELS } from '../data/generals';
import {
  advanceTurn,
  allCardsOf,
  checkLianying,
  checkWinner,
  currentPlayer,
  discardAllCards,
  discardFromHand,
  discardHandAndEquips,
  drawCards,
  generalOf,
  handAndEquips,
  heal,
  log,
  hasAnyCard,
  nameOf,
  pushDiscard,
  removeCardFromPlayer,
  setWinner,
} from './state';
import {
  aliveInSeatOrder,
  attackRange,
  distance,
  handLimit,
  inAttackRange,
  isBlack,
  isRed,
  isWounded,
  slashLimitReached,
  turnOrderFrom,
} from './rules';
import { nextUint32, shuffle } from './rng';
import { emitTiming } from './events';
import { hasSkill } from './skills';

const MAX_TURNS = 500;
const MAX_NULLIFICATION_CHAIN = 16;
const MAX_REQUESTS_PER_TURN = 4000;

/** 群體錦囊：官方對每個目標分別開啟【無懈可擊】窗口。 */
const PER_TARGET_NULLIFICATION: ReadonlySet<CardName> = new Set([
  'barbarian',
  'arrows',
  'peach_garden',
  'harvest',
]);

/* ------------------------------------------------------------------ */
/* 請求工具                                                            */
/* ------------------------------------------------------------------ */

const MAX_PUBLIC_EVENTS = 200;

/** 記錄一筆公開事件；只放全桌可見的資訊，供 AI 身份推理。 */
function recordEvent(state: GameState, event: Omit<PublicEvent, 'seq'>): void {
  state.eventSeq += 1;
  state.publicEvents.push({ seq: state.eventSeq, ...event });
  if (state.publicEvents.length > MAX_PUBLIC_EVENTS) {
    state.publicEvents.splice(0, state.publicEvents.length - MAX_PUBLIC_EVENTS);
  }
}

function baseRequest(state: GameState, player: PlayerId, prompt: string) {
  state.requestSeq += 1;
  return { id: state.requestSeq, player, prompt };
}

function* ask(state: GameState, request: Request): Generator<Request, Response, Response> {
  state.pending = request;
  const response = yield request;
  state.pending = null;
  return response;
}

function pickOption<T extends { id: string; kind: string }>(
  response: Response,
  options: readonly T[],
  label: string,
): T {
  if (response.type === 'pass') {
    const pass = options.find((option) => option.kind === 'pass');
    if (pass) return pass;
    throw new Error(`${label}: pass is not allowed`);
  }
  if (response.type !== 'option') {
    throw new Error(`${label}: expected option response`);
  }
  const option = options.find((item) => item.id === response.optionId);
  if (!option) throw new Error(`${label}: unknown option ${response.optionId}`);
  return option;
}

function* askAction(
  state: GameState,
  player: PlayerState,
): Generator<Request, PlayOption, Response> {
  const options = getPlayOptions(state, player);
  const request: Request = {
    ...baseRequest(state, player.id, '出牌階段：請選擇行動'),
    kind: 'action',
    options,
    context: '出牌階段',
  };
  const response = yield* ask(state, request);
  return pickOption(response, options, '出牌階段');
}

interface ResponseExtra {
  cardName?: CardName;
  source?: PlayerId;
  targets?: PlayerId[];
  nullificationCount?: number;
  /** 防止傷害類技能（如寒冰劍）所需的預期傷害值。 */
  damage?: number;
}

function* askResponse(
  state: GameState,
  player: PlayerState,
  need: ResponseNeed,
  options: ResponseOption[],
  prompt: string,
  context: string,
  extra: ResponseExtra = {},
): Generator<Request, ResponseOption | null, Response> {
  if (options.length === 0) return null;
  const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
  const all = [...options, pass];
  const request: Request = {
    ...baseRequest(state, player.id, prompt),
    kind: 'response',
    options: all,
    need,
    context,
    ...extra,
  };
  const response = yield* ask(state, request);
  if (response.type === 'pass') return null;
  if (response.type !== 'option') throw new Error(`${context}: expected option response`);
  const option = all.find((item) => item.id === response.optionId);
  if (!option) throw new Error(`${context}: unknown response option`);
  if (option.kind === 'pass') return null;
  return option;
}

/** 強制從選項中選一個，不提供「不出」。 */
function* askRequiredOption(
  state: GameState,
  player: PlayerState,
  need: ResponseNeed,
  options: ResponseOption[],
  prompt: string,
  context: string,
): Generator<Request, ResponseOption, Response> {
  if (options.length === 0) throw new Error(`${context}: no option available`);
  const request: Request = {
    ...baseRequest(state, player.id, prompt),
    kind: 'response',
    options,
    need,
    context,
  };
  const response = yield* ask(state, request);
  if (response.type !== 'option') throw new Error(`${context}: expected option response`);
  const option = options.find((item) => item.id === response.optionId);
  if (!option) throw new Error(`${context}: unknown option`);
  return option;
}

function* askCards(
  state: GameState,
  player: PlayerState,
  cardIds: readonly number[],
  min: number,
  max: number,
  reason: string,
  prompt: string,
  extra: { skill?: string; target?: PlayerId } = {},
): Generator<Request, number[], Response> {
  const allowed = [...new Set(cardIds)];
  if (allowed.length === 0 || max <= 0) return [];
  const request: Request = {
    ...baseRequest(state, player.id, prompt),
    kind: 'chooseCards',
    cards: allowed,
    min,
    max,
    reason,
    ...(extra.skill !== undefined ? { skill: extra.skill } : {}),
    ...(extra.target !== undefined ? { target: extra.target } : {}),
  };
  const response = yield* ask(state, request);
  if (response.type !== 'cards') throw new Error(`${reason}: expected cards response`);
  const chosen = [...new Set(response.cards)];
  if (chosen.length < min || chosen.length > max) {
    throw new Error(`${reason}: invalid card count`);
  }
  if (!chosen.every((id) => allowed.includes(id))) {
    throw new Error(`${reason}: invalid card id`);
  }
  return chosen;
}

function* askCardFrom(
  state: GameState,
  chooser: PlayerState,
  target: PlayerState,
  reason: string,
  prompt: string,
  includeJudge = true,
): Generator<Request, Card | null, Response> {
  const visible: Card[] = [];
  for (const slot of ['weapon', 'armor', 'horsePlus', 'horseMinus'] as const) {
    const card = target.equips[slot];
    if (card) visible.push(card);
  }
  if (includeJudge) visible.push(...target.judgeZone);

  const allowRandomHand = target.hand.length > 0;
  if (visible.length === 0 && !allowRandomHand) return null;

  const request: Request = {
    ...baseRequest(state, chooser.id, prompt),
    kind: 'chooseCard',
    target: target.id,
    cards: visible.map((card) => card.id),
    allowRandomHand,
    handCount: target.hand.length,
    reason,
  };
  const response = yield* ask(state, request);
  if (response.type !== 'card') throw new Error(`${reason}: expected card response`);

  if (response.card === -1) {
    if (!allowRandomHand) throw new Error(`${reason}: random hand is not allowed`);
    const index = nextUint32(state) % target.hand.length;
    return target.hand[index] ?? null;
  }

  const card = visible.find((item) => item.id === response.card);
  if (!card) throw new Error(`${reason}: invalid target card`);
  return card;
}

/** 從指定的牌中選取（不限手牌）；用於【觀星】等需要檢視牌堆頂的技能。 */
function* askFrom(
  state: GameState,
  player: PlayerState,
  cards: readonly Card[],
  min: number,
  max: number,
  reason: string,
  prompt: string,
): Generator<Request, number[], Response> {
  if (cards.length === 0 || max <= 0) return [];
  const request: Request = {
    ...baseRequest(state, player.id, prompt),
    kind: 'chooseFrom',
    cards: cards.map((card) => ({ ...card })),
    min,
    max,
    reason,
  };
  const response = yield* ask(state, request);
  if (response.type !== 'cards') throw new Error(`${reason}: expected cards response`);
  const chosen = [...new Set(response.cards)];
  if (chosen.length < min || chosen.length > max) throw new Error(`${reason}: invalid card count`);
  const allowed = new Set(cards.map((card) => card.id));
  if (!chosen.every((id) => allowed.has(id))) throw new Error(`${reason}: invalid card id`);
  return chosen;
}

function* askRevealed(
  state: GameState,
  player: PlayerState,
  cards: readonly Card[],
  prompt: string,
): Generator<Request, Card | null, Response> {
  if (cards.length === 0) return null;
  const request: Request = {
    ...baseRequest(state, player.id, prompt),
    kind: 'chooseRevealed',
    cards: cards.map((card) => ({ ...card })),
    reason: 'chooseRevealed',
  };
  const response = yield* ask(state, request);
  if (response.type !== 'card') throw new Error('chooseRevealed: expected card response');
  const card = cards.find((item) => item.id === response.card);
  if (!card) throw new Error('chooseRevealed: invalid card');
  return card;
}

/* ------------------------------------------------------------------ */
/* 牌與使用脈絡                                                        */
/* ------------------------------------------------------------------ */

function natureOf(name: CardName): Nature {
  const meta = CARD_META[name] as { nature?: Nature };
  return meta.nature ?? 'normal';
}

function makeUse(
  state: GameState,
  source: PlayerState,
  cards: Card[],
  name: CardName,
  targets: PlayerId[],
  skill?: string,
): CardUse {
  const primary = cards[0];
  if (!primary) throw new Error('CardUse requires at least one physical card');
  state.useSeq += 1;
  return {
    id: state.useSeq,
    source: source.id,
    card: primary,
    cards,
    name,
    suit: primary.suit,
    rank: primary.rank,
    nature: natureOf(name),
    targets: [...targets],
    skill,
  };
}

function takeFromHand(state: GameState, player: PlayerState, ids: readonly number[]): Card[] {
  const cards: Card[] = [];
  for (const id of ids) {
    const index = player.hand.findIndex((card) => card.id === id);
    if (index < 0) throw new Error(`Card ${id} is not in hand`);
    cards.push(player.hand.splice(index, 1)[0]!);
  }
  // 連營：以任何方式失去最後一張手牌都要立即檢查（使用、打出、支付代價、被拿走等）。
  if (cards.length > 0) checkLianying(state, player);
  return cards;
}

function cardRef(card: Card): string {
  return `${cardLabel(card.name)} ${suitSymbol(card.suit)}${rankLabel(card.rank)}`;
}

function useLabel(use: CardUse): string {
  return cardLabel(use.name);
}

function combinations(ids: readonly number[], min: number, max: number): number[][] {
  const result: number[][] = [];
  const walk = (start: number, picked: number[]) => {
    if (picked.length >= min && picked.length <= max) result.push([...picked]);
    if (picked.length === max) return;
    for (let index = start; index < ids.length; index += 1) {
      picked.push(ids[index]!);
      walk(index + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return result;
}

/* ------------------------------------------------------------------ */
/* 出牌階段選項                                                        */
/* ------------------------------------------------------------------ */

/** 判定區一張牌的「視為牌名」；轉化延時錦囊（【國色】）需要靠這張對照表。 */
function delayedNameOf(state: GameState, card: Card): CardName {
  return state.delayedNames[card.id] ?? card.name;
}

/** 角色判定區是否已有某張延時錦囊（含轉化牌）。 */
function hasDelayed(state: GameState, player: PlayerState, name: CardName): boolean {
  return player.judgeZone.some((card) => delayedNameOf(state, card) === name);
}

/** 鎖定技造成的非法目標：【空城】擋【殺】／【決鬥】，【謙遜】擋【順手牽羊】／【樂不思蜀】。 */
function targetBlocked(target: PlayerState, cardName: CardName): boolean {
  if (!target.alive) return true;
  if (
    hasSkill(target, 'kongcheng') &&
    target.hand.length === 0 &&
    (cardName === 'slash' || cardName === 'fire_slash' || cardName === 'thunder_slash' || cardName === 'duel')
  ) {
    return true;
  }
  if (hasSkill(target, 'qianxun') && (cardName === 'snatch' || cardName === 'indulgence')) return true;
  return false;
}

export function getPlayOptions(state: GameState, player: PlayerState): PlayOption[] {
  const options: PlayOption[] = [];
  const add = (option: PlayOption) => {
    if (!options.some((item) => item.id === option.id)) options.push(option);
  };

  const alive = state.players.filter((target) => target.alive);

  for (const card of player.hand) {
    const meta = CARD_META[card.name];
    const ref = cardRef(card);

    if (isSlashCard(card.name)) {
      if (slashLimitReached(player)) continue;
      const nature = natureOf(card.name);
      const rangeTargets = alive.filter(
        (target) =>
          target.id !== player.id &&
          inAttackRange(state, player.id, target.id) &&
          !targetBlocked(target, card.name),
      );
      for (const target of rangeTargets) {
        const dist = distance(state, player.id, target.id);
        const wineNote = player.wine ? '［酒 +1］' : '';
        add({
          id: `slash:${card.id}:${target.id}:${nature}`,
          label: `${ref} → ${nameOf(state, target.id)}（距離 ${dist}／範圍 ${attackRange(player)}）${wineNote}`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: card.name,
          nature,
        });

        if (player.equips.weapon?.name === 'fan' && card.name === 'slash') {
          add({
            id: `slash:${card.id}:${target.id}:fire`,
            label: `朱雀羽扇：火殺（${suitSymbol(card.suit)}${rankLabel(card.rank)}）→ ${nameOf(state, target.id)}（距離 ${dist}／範圍 ${attackRange(player)}）${wineNote}`,
            kind: 'play',
            cards: [card.id],
            targets: [target.id],
            asCard: 'fire_slash',
            nature: 'fire',
            skill: 'fan',
          });
        }
      }

      // 方天畫戟：此【殺】為最後手牌時，可額外指定至多兩名目標。
      if (player.equips.weapon?.name === 'halberd' && player.hand.length === 1) {
        const candidates = rangeTargets.map((target) => target.id);
        for (const targets of combinations(candidates, 2, 3)) {
          add({
            id: `slash:${card.id}:${targets.join('+')}:${nature}:halberd`,
            label: `${ref} → ${targets.map((id) => nameOf(state, id)).join('、')}（方天畫戟）${player.wine ? '［酒 +1］' : ''}`,
            kind: 'play',
            cards: [card.id],
            targets,
            asCard: card.name,
            nature,
            skill: 'halberd',
          });
        }
      }
      continue;
    }

    if (card.name === 'peach') {
      if (isWounded(player)) {
        add({
          id: `peach:${card.id}:${player.id}`,
          label: `${ref} → 自己（回復 1 點）`,
          kind: 'play',
          cards: [card.id],
          targets: [player.id],
          asCard: 'peach',
        });
      }
      continue;
    }

    if (card.name === 'wine') {
      if (!player.wineUsed) {
        add({
          id: `wine:${card.id}`,
          label: `${ref}（下一張殺傷害 +1）`,
          kind: 'play',
          cards: [card.id],
          targets: [player.id],
          asCard: 'wine',
        });
      }
      continue;
    }

    if (meta.type === 'equip') {
      add({
        id: `equip:${card.id}`,
        label: `裝備 ${ref}`,
        kind: 'play',
        cards: [card.id],
        targets: [player.id],
        asCard: card.name,
      });
      continue;
    }

    if (card.name === 'ex_nihilo') {
      add({
        id: `ex_nihilo:${card.id}`,
        label: `${ref}（摸 2 張）`,
        kind: 'play',
        cards: [card.id],
        targets: [player.id],
        asCard: 'ex_nihilo',
      });
      continue;
    }

    if (card.name === 'dismantle') {
      for (const target of alive) {
        if (target.id === player.id || !hasAnyCard(target)) continue;
        add({
          id: `dismantle:${card.id}:${target.id}`,
          label: `${ref} → ${nameOf(state, target.id)}`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'dismantle',
        });
      }
      continue;
    }

    if (card.name === 'snatch') {
      for (const target of alive) {
        if (target.id === player.id || !hasAnyCard(target)) continue;
        if (targetBlocked(target, 'snatch')) continue;
        if (!hasSkill(player, 'qicai') && distance(state, player.id, target.id) > 1) continue;
        add({
          id: `snatch:${card.id}:${target.id}`,
          label: `${ref} → ${nameOf(state, target.id)}（距離 1）`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'snatch',
        });
      }
      continue;
    }

    if (card.name === 'duel') {
      for (const target of alive) {
        if (target.id === player.id || targetBlocked(target, 'duel')) continue;
        add({
          id: `duel:${card.id}:${target.id}`,
          label: `${ref} → ${nameOf(state, target.id)}（輪流打出【殺】）`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'duel',
        });
      }
      continue;
    }

    if (card.name === 'collateral') {
      for (const user of alive) {
        if (user.id === player.id || !user.equips.weapon) continue;
        for (const target of alive) {
          if (target.id === user.id) continue;
          if (!inAttackRange(state, user.id, target.id)) continue;
          add({
            id: `collateral:${card.id}:${user.id}:${target.id}`,
            label: `${ref} → ${nameOf(state, user.id)} 對 ${nameOf(state, target.id)} 出【殺】`,
            kind: 'play',
            cards: [card.id],
            targets: [user.id, target.id],
            asCard: 'collateral',
          });
        }
      }
      continue;
    }

    if (card.name === 'barbarian') {
      const targets = alive.filter((target) => target.id !== player.id).map((target) => target.id);
      add({
        id: `barbarian:${card.id}`,
        label: `${ref}（其他角色需打出【殺】）`,
        kind: 'play',
        cards: [card.id],
        targets,
        asCard: 'barbarian',
      });
      continue;
    }

    if (card.name === 'arrows') {
      const targets = alive.filter((target) => target.id !== player.id).map((target) => target.id);
      add({
        id: `arrows:${card.id}`,
        label: `${ref}（其他角色需打出【閃】）`,
        kind: 'play',
        cards: [card.id],
        targets,
        asCard: 'arrows',
      });
      continue;
    }

    if (card.name === 'peach_garden') {
      add({
        id: `peach_garden:${card.id}`,
        label: `${ref}（所有存活角色回復 1 點）`,
        kind: 'play',
        cards: [card.id],
        targets: alive.map((target) => target.id),
        asCard: 'peach_garden',
      });
      continue;
    }

    if (card.name === 'harvest') {
      add({
        id: `harvest:${card.id}`,
        label: `${ref}（翻開存活人數的牌，輪流選一張）`,
        kind: 'play',
        cards: [card.id],
        targets: alive.map((target) => target.id),
        asCard: 'harvest',
      });
      continue;
    }

    if (card.name === 'fire_attack') {
      for (const target of alive) {
        if (target.id === player.id || target.hand.length === 0) continue;
        add({
          id: `fire_attack:${card.id}:${target.id}`,
          label: `${ref} → ${nameOf(state, target.id)}（展示手牌，同花色可造成火焰傷害）`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'fire_attack',
        });
      }
      continue;
    }

    if (card.name === 'iron_chain') {
      add({
        id: `recast:${card.id}`,
        label: `重鑄 ${ref}（棄置並摸 1 張）`,
        kind: 'play',
        cards: [card.id],
        targets: [],
        asCard: 'iron_chain',
        skill: 'recast',
      });
      for (const target of alive) {
        add({
          id: `iron_chain:${card.id}:${target.id}`,
          label: `${ref} → ${nameOf(state, target.id)}${target.chained ? '（重置）' : '（橫置）'}`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'iron_chain',
        });
      }
      const ids = alive.map((target) => target.id).sort((a, b) => a - b);
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const targets = [ids[i]!, ids[j]!];
          add({
            id: `iron_chain:${card.id}:${targets.join('+')}`,
            label: `${ref} → ${targets.map((id) => nameOf(state, id)).join('、')}`,
            kind: 'play',
            cards: [card.id],
            targets,
            asCard: 'iron_chain',
          });
        }
      }
      continue;
    }

    if (card.name === 'indulgence') {
      for (const target of alive) {
        if (target.id === player.id || targetBlocked(target, 'indulgence')) continue;
        if (hasDelayed(state, target, 'indulgence')) continue;
        add({
          id: `indulgence:${card.id}:${target.id}`,
          label: `${ref} → ${nameOf(state, target.id)} 的判定區`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'indulgence',
        });
      }
      continue;
    }

    if (card.name === 'supply_shortage') {
      for (const target of alive) {
        if (target.id === player.id) continue;
        if (!hasSkill(player, 'qicai') && distance(state, player.id, target.id) > 1) continue;
        if (hasDelayed(state, target, 'supply_shortage')) continue;
        add({
          id: `supply_shortage:${card.id}:${target.id}`,
          label: `${ref} → ${nameOf(state, target.id)} 的判定區（距離 1）`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'supply_shortage',
        });
      }
      continue;
    }

    if (card.name === 'lightning') {
      if (hasDelayed(state, player, 'lightning')) continue;
      add({
        id: `lightning:${card.id}`,
        label: `${ref} → 自己的判定區`,
        kind: 'play',
        cards: [card.id],
        targets: [player.id],
        asCard: 'lightning',
      });
      continue;
    }

    // 無懈可擊只能在其他錦囊結算時作為回應使用。
  }

  // 武聖：紅色牌當【殺】使用。
  if (hasSkill(player, 'wusheng') && !slashLimitReached(player)) {
    for (const card of player.hand) {
      if (isSlashCard(card.name) || !isRed(card)) continue;
      const ref = cardRef(card);
      for (const target of alive) {
        if (
          target.id === player.id ||
          !inAttackRange(state, player.id, target.id) ||
          targetBlocked(target, 'slash')
        ) {
          continue;
        }
        add({
          id: `wusheng:${card.id}:${target.id}`,
          label: `武聖：${ref} 當【殺】→ ${nameOf(state, target.id)}${player.wine ? '［酒 +1］' : ''}`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'slash',
          nature: 'normal',
          skill: 'wusheng',
        });
      }
    }
  }

  // 龍膽：【閃】當【殺】使用。
  if (hasSkill(player, 'longdan') && !slashLimitReached(player)) {
    for (const card of player.hand) {
      if (card.name !== 'dodge') continue;
      for (const target of alive) {
        if (
          target.id === player.id ||
          !inAttackRange(state, player.id, target.id) ||
          targetBlocked(target, 'slash')
        ) {
          continue;
        }
        add({
          id: `longdan:${card.id}:${target.id}`,
          label: `龍膽：${cardRef(card)} 當【殺】→ ${nameOf(state, target.id)}${player.wine ? '［酒 +1］' : ''}`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'slash',
          nature: 'normal',
          skill: 'longdan',
        });
      }
    }
  }

  // 仁德：交出任意張手牌。
  if (hasSkill(player, 'rende') && player.hand.length > 0) {
    for (const target of alive) {
      if (target.id === player.id) continue;
      add({
        id: `rende:${target.id}`,
        label: `仁德：將手牌交給 ${nameOf(state, target.id)}`,
        kind: 'play',
        cards: [],
        targets: [target.id],
        skill: 'rende',
      });
    }
  }

  // 制衡：棄置任意張手牌並補回等量，每回合一次。
  if (hasSkill(player, 'zhiheng') && !player.marks.zhiheng_used && player.hand.length > 0) {
    add({
      id: 'zhiheng',
      label: '制衡：棄置任意張手牌並摸等量的牌',
      kind: 'play',
      cards: [],
      targets: [],
      skill: 'zhiheng',
    });
  }

  // 青囊：棄一張手牌，令一名角色回復 1 點，每回合一次。
  if (hasSkill(player, 'qingnang') && !player.marks.qingnang_used && player.hand.length > 0) {
    for (const target of alive) {
      add({
        id: `qingnang:${target.id}`,
        label: `青囊：棄一張手牌，令 ${nameOf(state, target.id)} 回復 1 點`,
        kind: 'play',
        cards: [],
        targets: [target.id],
        skill: 'qingnang',
      });
    }
  }

  // 離間：棄一張牌，令兩名男性角色決鬥，每回合一次。
  if (hasSkill(player, 'lijian') && !player.marks.lijian_used && player.hand.length > 0) {
    const males = alive.filter((target) => generalOf(target).gender === 'male');
    for (const first of males) {
      if (first.id === player.id) continue;
      for (const second of males) {
        if (second.id === player.id || second.id === first.id) continue;
        add({
          id: `lijian:${first.id}:${second.id}`,
          label: `離間：棄一張牌，令 ${nameOf(state, first.id)} 對 ${nameOf(state, second.id)} 使用【決鬥】`,
          kind: 'play',
          cards: [],
          targets: [first.id, second.id],
          skill: 'lijian',
        });
      }
    }
  }

  // 奇襲：黑色牌當【過河拆橋】使用。
  if (hasSkill(player, 'qixi')) {
    for (const card of player.hand) {
      if (card.name === 'dismantle' || !isBlack(card)) continue;
      for (const target of alive) {
        if (target.id === player.id || !hasAnyCard(target)) continue;
        add({
          id: `qixi:${card.id}:${target.id}`,
          label: `奇襲：${cardRef(card)} 當【過河拆橋】→ ${nameOf(state, target.id)}`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'dismantle',
          skill: 'qixi',
        });
      }
    }
  }

  // 國色：方塊牌當【樂不思蜀】使用。
  if (hasSkill(player, 'guose')) {
    for (const card of player.hand) {
      if (card.name === 'indulgence' || card.suit !== 'diamond') continue;
      for (const target of alive) {
        if (target.id === player.id || targetBlocked(target, 'indulgence')) continue;
        if (hasDelayed(state, target, 'indulgence')) continue;
        add({
          id: `guose:${card.id}:${target.id}`,
          label: `國色：${cardRef(card)} 當【樂不思蜀】→ ${nameOf(state, target.id)}`,
          kind: 'play',
          cards: [card.id],
          targets: [target.id],
          asCard: 'indulgence',
          skill: 'guose',
        });
      }
    }
  }

  // 苦肉：失去 1 點體力摸兩張，可重複使用。
  if (hasSkill(player, 'kurou')) {
    add({
      id: 'kurou',
      label: '苦肉：失去 1 點體力，摸 2 張牌',
      kind: 'play',
      cards: [],
      targets: [],
      skill: 'kurou',
    });
  }

  // 反間：每回合一次，令一名其他角色猜花色。
  if (hasSkill(player, 'fanjian') && !player.marks.fanjian_used && player.hand.length > 0) {
    for (const target of alive) {
      if (target.id === player.id) continue;
      add({
        id: `fanjian:${target.id}`,
        label: `反間：令 ${nameOf(state, target.id)} 猜花色`,
        kind: 'play',
        cards: [],
        targets: [target.id],
        skill: 'fanjian',
      });
    }
  }

  // 結姻：每回合一次，棄兩張手牌與一名角色各回復 1 點。
  if (hasSkill(player, 'jieyin') && !player.marks.jieyin_used && player.hand.length >= 2) {
    for (const target of alive) {
      add({
        id: `jieyin:${target.id}`,
        label:
          target.id === player.id
            ? '結姻：棄 2 張手牌，回復 1 點體力'
            : `結姻：棄 2 張手牌，令 ${nameOf(state, target.id)} 與自己各回復 1 點`,
        kind: 'play',
        cards: [],
        targets: [target.id],
        skill: 'jieyin',
      });
    }
  }

  // 激將：出牌階段，主公可令蜀勢力角色代打【殺】，再以自己為來源使用。
  // 盟友全拒絕時記 jijiang_failed，避免同回合無限重試。
  if (
    hasSkill(player, 'jijiang') &&
    !player.marks.jijiang_failed &&
    !slashLimitReached(player) &&
    hasJijiangAlly(state, player)
  ) {
    for (const target of alive) {
      if (
        target.id === player.id ||
        !inAttackRange(state, player.id, target.id) ||
        targetBlocked(target, 'slash')
      ) {
        continue;
      }
      add({
        id: `jijiang:${target.id}`,
        label: `激將：令蜀勢力角色代打【殺】→ ${nameOf(state, target.id)}${player.wine ? '［酒 +1］' : ''}`,
        kind: 'play',
        cards: [],
        targets: [target.id],
        asCard: 'slash',
        skill: 'jijiang',
      });
    }
  }

  // 丈八蛇矛：任意兩張手牌可當【殺】使用。
  // 選項只列目標；實際的兩張牌在選定目標後才詢問，避免手牌多時選項平方成長。
  if (player.equips.weapon?.name === 'serpent_spear' && !slashLimitReached(player) && player.hand.length >= 2) {
    for (const target of alive) {
      if (
        target.id === player.id ||
        !inAttackRange(state, player.id, target.id) ||
        targetBlocked(target, 'slash')
      ) {
        continue;
      }
      add({
        id: `slash:serpent_spear:${target.id}:normal`,
        label: `丈八蛇矛：選擇兩張手牌當【殺】→ ${nameOf(state, target.id)}${player.wine ? '［酒 +1］' : ''}`,
        kind: 'play',
        cards: [],
        targets: [target.id],
        asCard: 'slash',
        nature: 'normal',
        skill: 'serpent_spear',
      });
    }
  }

  add({ id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] });
  return options;
}

/* ------------------------------------------------------------------ */
/* 出牌結算                                                            */
/* ------------------------------------------------------------------ */

function* resolvePlayOption(
  state: GameState,
  player: PlayerState,
  option: PlayOption,
): Generator<Request, void, Response> {
  if (option.kind === 'pass') return;
  if (option.kind !== 'play') return;

  // 需要自行挑牌的主動技能，先結算再走一般牌流程。
  if (option.skill === 'rende') {
    yield* resolveRende(state, player, option);
    return;
  }
  if (option.skill === 'zhiheng') {
    yield* resolveZhiheng(state, player);
    return;
  }
  if (option.skill === 'qingnang') {
    yield* resolveQingnang(state, player, option);
    return;
  }
  if (option.skill === 'lijian') {
    yield* resolveLijian(state, player, option);
    return;
  }
  if (option.skill === 'jijiang') {
    yield* resolveJijiang(state, player, option);
    return;
  }
  if (option.skill === 'kurou') {
    yield* resolveKurou(state, player);
    return;
  }
  if (option.skill === 'fanjian') {
    yield* resolveFanjian(state, player, option);
    return;
  }
  if (option.skill === 'jieyin') {
    yield* resolveJieyin(state, player, option);
    return;
  }

  let cards: Card[];
  if (option.skill === 'serpent_spear' && option.cards.length === 0) {
    const ids = yield* askCards(
      state,
      player,
      player.hand.map((card) => card.id),
      2,
      2,
      '丈八蛇矛',
      '請選擇兩張手牌當【殺】',
      { target: option.targets[0] },
    );
    cards = takeFromHand(state, player, ids);
  } else {
    cards = takeFromHand(state, player, option.cards);
  }
  const primary = cards[0];
  if (!primary) throw new Error('No card selected');

  // 只有「使用實體裝備」才進入裝備流程；武聖、龍膽等轉化牌不在此列。
  if (
    (option.asCard === undefined || option.asCard === primary.name) &&
    CARD_META[primary.name].type === 'equip'
  ) {
    equipCard(state, player, primary);
    return;
  }

  // 鐵索連環重鑄：不是使用錦囊，直接棄置並摸一張。
  if (option.skill === 'recast') {
    pushDiscard(state, cards);
    log(state, 'play', `${nameOf(state, player.id)} 重鑄【鐵索連環】。`);
    drawCards(state, player, 1);
    return;
  }

  const virtualName = option.asCard ?? primary.name;
  const nature = option.nature ?? natureOf(virtualName);
  const targets = option.targets
    .map((id) => state.players[id])
    .filter((target): target is PlayerState => Boolean(target));
  const use = makeUse(
    state,
    player,
    cards,
    virtualName,
    targets.map((target) => target.id),
    option.skill,
  );
  use.nature = nature;

  emitTiming('beforeUseCard', { state, use, source: player.id });

  log(
    state,
    'play',
    `${nameOf(state, player.id)} 使用【${useLabel(use)}】${
      targets.length > 0 ? `→ ${targets.map((target) => nameOf(state, target.id)).join('、')}` : ''
    }。`,
  );
  if (virtualName === 'collateral') {
    // 借刀殺人：公開事件記在真正被打的受害者身上，而不是被強迫出【殺】的人。
    const victim = targets[1] ?? targets[0] ?? null;
    recordEvent(state, {
      kind: 'use',
      source: player.id,
      target: victim?.id ?? null,
      cardName: 'collateral',
      skill: 'collateral',
      targets: targets.map((target) => target.id),
    });
  } else {
    for (const target of targets.length > 0 ? targets : [null]) {
      recordEvent(state, { kind: 'use', source: player.id, target: target?.id ?? null, cardName: virtualName });
    }
  }

  const meta = CARD_META[virtualName];

  // 集智：使用非延時錦囊時摸一張。
  if (meta.type === 'trick' && hasSkill(player, 'jizhi')) {
    drawCards(state, player, 1);
    log(state, 'draw', `${nameOf(state, player.id)} 的【集智】摸 1 張牌。`);
  }

  // 延時錦囊進入判定區，不是棄牌堆。
  if (meta.type === 'delayed') {
    const target = targets[0] ?? player;
    target.judgeZone.push(primary);
    state.delayedNames[primary.id] = virtualName;
    log(state, 'judge', `【${cardLabel(virtualName)}】置入 ${nameOf(state, target.id)} 的判定區。`);
    for (const card of cards.slice(1)) pushDiscard(state, [card]);
    emitTiming('afterUseCard', { state, use, source: player.id });
    return;
  }

  pushDiscard(state, cards);

  // 錦囊結算前開啟無懈可擊窗口；群體錦囊改在每個目標結算前分別詢問。
  if (meta.type === 'trick' && !PER_TARGET_NULLIFICATION.has(virtualName)) {
    const negated = yield* askNullification(state, use);
    if (negated) {
      log(state, 'play', `${useLabel(use)} 被【無懈可擊】抵消。`);
      emitTiming('afterUseCard', { state, use, source: player.id });
      return;
    }
  }

  switch (virtualName) {
    case 'slash':
    case 'fire_slash':
    case 'thunder_slash': {
      let bonus = 0;
      if (player.wine) {
        bonus = 1;
        player.wine = false;
        log(state, 'play', `${nameOf(state, player.id)} 的酒意令此【殺】傷害 +1。`);
      }
      player.slashUsed += 1;
      player.marks.slash_played = true;
      for (const target of targets) {
        if (state.winner) return;
        yield* resolveSlashTarget(state, player, target, use, { bonus });
      }
      break;
    }

    case 'peach': {
      const target = targets[0];
      if (target) heal(state, target, 1, '桃');
      break;
    }

    case 'wine': {
      player.wine = true;
      player.wineUsed = true;
      log(state, 'play', `${nameOf(state, player.id)} 使用【酒】，下一張【殺】傷害 +1。`);
      break;
    }

    case 'ex_nihilo': {
      drawCards(state, player, 2);
      break;
    }

    case 'dismantle': {
      const target = targets[0];
      if (!target) break;
      const card = yield* askCardFrom(
        state,
        player,
        target,
        '過河拆橋',
        `選擇要棄置 ${nameOf(state, target.id)} 的一張牌`,
      );
      if (card) {
        const removed = removeCardFromPlayer(state, target, card.id, true);
        pushDiscard(state, [removed]);
        log(
          state,
          'play',
          `${nameOf(state, player.id)} 棄置了 ${nameOf(state, target.id)} 的【${cardLabel(removed.name)}】。`,
        );
      }
      break;
    }

    case 'snatch': {
      const target = targets[0];
      if (!target) break;
      const card = yield* askCardFrom(
        state,
        player,
        target,
        '順手牽羊',
        `選擇要獲得 ${nameOf(state, target.id)} 的一張牌`,
      );
      if (card) {
        const fromHand = target.hand.some((item) => item.id === card.id);
        const removed = removeCardFromPlayer(state, target, card.id, true);
        player.hand.push(removed);
        log(
          state,
          'play',
          fromHand
            ? `${nameOf(state, player.id)} 獲得了 ${nameOf(state, target.id)} 的一張手牌。`
            : `${nameOf(state, player.id)} 獲得了 ${nameOf(state, target.id)} 的【${cardLabel(removed.name)}】。`,
        );
      }
      break;
    }

    case 'duel': {
      const target = targets[0];
      if (!target) break;
      yield* resolveDuel(state, player, target, use.card);
      break;
    }

    case 'barbarian':
    case 'arrows': {
      const requireSha = virtualName === 'barbarian';
      for (const target of turnOrderFrom(state, player.id)) {
        if (!target.alive || target.id === player.id || state.winner) continue;
        if (target.equips.armor?.name === 'vine_armor') {
          log(
            state,
            'play',
            `${nameOf(state, target.id)} 的【藤甲】令【${cardLabel(virtualName)}】無效。`,
          );
          continue;
        }
        if (yield* askNullification(state, use, target.id)) {
          log(
            state,
            'play',
            `【${cardLabel(virtualName)}】對 ${nameOf(state, target.id)} 的效果被【無懈可擊】抵消。`,
          );
          continue;
        }
        const played = requireSha
          ? Boolean(yield* askForSha(state, target, `【${cardLabel(virtualName)}】`))
          : yield* askForShan(state, target, `【${cardLabel(virtualName)}】`);
        if (!played) {
          yield* dealDamage(state, {
            sourceId: player.id,
            targetId: target.id,
            amount: 1,
            nature: 'normal',
            card: use.card,
            reason: cardLabel(virtualName),
          });
        }
      }
      break;
    }

    case 'peach_garden': {
      for (const target of turnOrderFrom(state, player.id)) {
        if (!target.alive) continue;
        if (yield* askNullification(state, use, target.id)) {
          log(
            state,
            'play',
            `【桃園結義】對 ${nameOf(state, target.id)} 的效果被【無懈可擊】抵消。`,
          );
          continue;
        }
        heal(state, target, 1, '桃園結義');
      }
      break;
    }

    case 'harvest': {
      const count = state.players.filter((target) => target.alive).length;
      const revealed = takeFromDeck(state, count);
      if (revealed.length === 0) break;
      log(
        state,
        'draw',
        `【五穀豐登】翻開：${revealed.map((card) => cardRef(card)).join('、')}。`,
      );
      for (const target of turnOrderFrom(state, player.id)) {
        if (!target.alive || revealed.length === 0) continue;
        if (yield* askNullification(state, use, target.id)) {
          log(
            state,
            'play',
            `【五穀豐登】對 ${nameOf(state, target.id)} 的效果被【無懈可擊】抵消。`,
          );
          continue;
        }
        const picked = yield* askRevealed(
          state,
          target,
          revealed,
          `五穀豐登：選擇一張牌（剩餘 ${revealed.length} 張）`,
        );
        if (!picked) continue;
        const index = revealed.findIndex((card) => card.id === picked.id);
        if (index >= 0) revealed.splice(index, 1);
        target.hand.push(picked);
        log(state, 'draw', `${nameOf(state, target.id)} 獲得【${cardLabel(picked.name)}】。`);
      }
      pushDiscard(state, revealed);
      break;
    }

    case 'collateral': {
      const user = targets[0];
      const victim = targets[1];
      if (!user || !victim) break;
      const weapon = user.equips.weapon;
      if (!weapon) break;
      const played = yield* askForSha(
        state,
        user,
        `【借刀殺人】→ ${nameOf(state, victim.id)}`,
        victim,
      );
      if (played) {
        log(
          state,
          'play',
          `${nameOf(state, user.id)} 受【借刀殺人】影響，對 ${nameOf(state, victim.id)} 使用【${cardLabel(played.name)}】。`,
        );
        yield* resolveSlashTarget(state, user, victim, makeUse(
          state,
          user,
          played.cards,
          played.name,
          [victim.id],
        ), { bonus: 0, forcedBy: player.id });
      } else {
        const removed = removeCardFromPlayer(state, user, weapon.id, true);
        player.hand.push(removed);
        log(
          state,
          'play',
          `${nameOf(state, user.id)} 未出【殺】，${nameOf(state, player.id)} 獲得其【${cardLabel(removed.name)}】。`,
        );
      }
      break;
    }

    case 'fire_attack': {
      const target = targets[0];
      if (!target || target.hand.length === 0) break;
      const revealedIds = yield* askCards(
        state,
        target,
        target.hand.map((card) => card.id),
        1,
        1,
        '火攻展示',
        `火攻：選擇一張手牌展示給 ${nameOf(state, player.id)}`,
      );
      const shown = target.hand.find((card) => card.id === revealedIds[0]);
      if (!shown) break;
      log(
        state,
        'play',
        `${nameOf(state, target.id)} 展示【${cardRef(shown)}】。`,
      );
      const sameSuit = player.hand.filter((card) => card.suit === shown.suit);
      if (sameSuit.length === 0) {
        log(state, 'play', `${nameOf(state, player.id)} 沒有同花色手牌，火攻未造成傷害。`);
        break;
      }
      const options: ResponseOption[] = sameSuit.map((card) => ({
        id: `fire_attack:${card.id}`,
        label: `棄置 ${cardRef(card)}，造成 1 點火焰傷害`,
        kind: 'respond',
        cards: [card.id],
        asCard: card.name,
      }));
      const chosen = yield* askResponse(
        state,
        player,
        'card',
        options,
        `是否棄置一張${suitLabel(shown.suit)}手牌造成火焰傷害？`,
        '火攻',
      );
      if (chosen) {
        const [discarded] = takeFromHand(state, player, chosen.cards);
        if (discarded) pushDiscard(state, [discarded]);
        yield* dealDamage(state, {
          sourceId: player.id,
          targetId: target.id,
          amount: 1,
          nature: 'fire',
          card: use.card,
          reason: '火攻',
        });
      }
      break;
    }

    case 'iron_chain': {
      for (const target of targets) {
        if (!target.alive) continue;
        target.chained = !target.chained;
        log(
          state,
          'play',
          `${nameOf(state, target.id)} ${target.chained ? '橫置（連環狀態）' : '重置（解除連環）'}。`,
        );
      }
      break;
    }

    default: {
      log(state, 'system', `【${cardLabel(virtualName)}】沒有可執行效果。`);
      break;
    }
  }

  emitTiming('afterUseCard', { state, use, source: player.id });
}

/* ------------------------------------------------------------------ */
/* 武將技能結算                                                        */
/* ------------------------------------------------------------------ */

/** 決鬥：目標先打出【殺】，雙方輪流；先無法或不願打出者受到 1 點傷害。 */
function* resolveDuel(
  state: GameState,
  source: PlayerState,
  target: PlayerState,
  card: Card,
  reason = '決鬥',
  forcedBy?: PlayerId,
): Generator<Request, void, Response> {
  let current = target;
  let other = source;
  while (current.alive && other.alive && !state.winner) {
    // 無雙：對手每次需連續打出兩張【殺】。
    const required = hasSkill(other, 'wushuang') ? 2 : 1;
    let passed = false;
    for (let index = 0; index < required; index += 1) {
      const played = yield* askForSha(state, current, `【${reason}】`);
      if (!played) {
        passed = true;
        break;
      }
    }
    if (passed) {
      yield* dealDamage(state, {
        sourceId: other.id,
        targetId: current.id,
        amount: 1,
        nature: 'normal',
        card,
        cardName: 'duel',
        reason,
        forcedBy,
      });
      break;
    }
    const next = other;
    other = current;
    current = next;
  }
}

/** 仁德：將任意張手牌交給一名角色；累計給出第二張時回復 1 點。 */
function* resolveRende(
  state: GameState,
  player: PlayerState,
  option: PlayOption,
): Generator<Request, void, Response> {
  const target = option.targets[0] === undefined ? null : state.players[option.targets[0]] ?? null;
  if (!target || !target.alive || target.id === player.id || player.hand.length === 0) return;

  // 【空城】在給牌前仍有效時，這張牌會破壞空城；這是公開可觀察的資訊。
  const brokeKongcheng = hasSkill(target, 'kongcheng') && target.hand.length === 0;
  const ids = yield* askCards(
    state,
    player,
    player.hand.map((card) => card.id),
    1,
    player.hand.length,
    '仁德',
    `選擇要交給 ${nameOf(state, target.id)} 的手牌（可多選）`,
    { skill: 'rende', target: target.id },
  );
  const cards = takeFromHand(state, player, ids);
  target.hand.push(...cards);
  const given = Number(player.marks.rende_given ?? 0) + cards.length;
  player.marks.rende_given = given;
  log(
    state,
    'play',
    `${nameOf(state, player.id)} 發動【仁德】，交給 ${nameOf(state, target.id)} ${cards.length} 張牌。`,
  );
  recordEvent(state, {
    kind: 'give',
    source: player.id,
    target: target.id,
    amount: cards.length,
    brokeKongcheng,
  });
  if (given >= 2 && !player.marks.rende_healed) {
    player.marks.rende_healed = true;
    heal(state, player, 1, '仁德');
  }
}

/** 制衡：棄置任意張手牌，摸等量的牌。 */
function* resolveZhiheng(state: GameState, player: PlayerState): Generator<Request, void, Response> {
  const ids = yield* askCards(
    state,
    player,
    player.hand.map((card) => card.id),
    1,
    player.hand.length,
    '制衡',
    '選擇要棄置的手牌（可多選）',
    { skill: 'zhiheng' },
  );
  const cards = takeFromHand(state, player, ids);
  pushDiscard(state, cards);
  player.marks.zhiheng_used = true;
  drawCards(state, player, cards.length);
  log(
    state,
    'play',
    `${nameOf(state, player.id)} 發動【制衡】，棄置 ${cards.length} 張並摸 ${cards.length} 張。`,
  );
}

/** 青囊：棄一張手牌，令一名角色回復 1 點。 */
function* resolveQingnang(
  state: GameState,
  player: PlayerState,
  option: PlayOption,
): Generator<Request, void, Response> {
  const target = option.targets[0] === undefined ? null : state.players[option.targets[0]] ?? null;
  if (!target || !target.alive || player.hand.length === 0) return;

  const ids = yield* askCards(
    state,
    player,
    player.hand.map((card) => card.id),
    1,
    1,
    '青囊',
    '選擇一張手牌棄置',
  );
  const cards = takeFromHand(state, player, ids);
  pushDiscard(state, cards);
  player.marks.qingnang_used = true;
  log(
    state,
    'play',
    `${nameOf(state, player.id)} 發動【青囊】，令 ${nameOf(state, target.id)} 回復 1 點體力。`,
  );
  const healed = heal(state, target, 1, '青囊');
  if (target.id !== player.id && healed > 0) {
    recordEvent(state, {
      kind: 'heal',
      source: player.id,
      target: target.id,
      skill: 'qingnang',
      amount: healed,
    });
  }
}

/** 離間：棄一張牌，令兩名男性角色視為其中一名對另一名使用【決鬥】。 */
function* resolveLijian(
  state: GameState,
  player: PlayerState,
  option: PlayOption,
): Generator<Request, void, Response> {
  const first = option.targets[0] === undefined ? null : state.players[option.targets[0]] ?? null;
  const second = option.targets[1] === undefined ? null : state.players[option.targets[1]] ?? null;
  if (!first || !second || !first.alive || !second.alive || player.hand.length === 0) return;

  const ids = yield* askCards(
    state,
    player,
    player.hand.map((card) => card.id),
    1,
    1,
    '離間',
    '選擇一張牌棄置',
  );
  const cards = takeFromHand(state, player, ids);
  pushDiscard(state, cards);
  player.marks.lijian_used = true;
  log(
    state,
    'play',
    `${nameOf(state, player.id)} 發動【離間】，${nameOf(state, first.id)} 對 ${nameOf(state, second.id)} 使用【決鬥】。`,
  );
  // 公開事件：離間使用者才是主動方；後續被迫的【決鬥】傷害帶 forcedBy，
  // 避免 AI 把被迫角力的角色誤記成對主公的主動敵意。
  recordEvent(state, {
    kind: 'use',
    source: player.id,
    target: second.id,
    skill: 'lijian',
    targets: [first.id, second.id],
  });
  yield* resolveDuel(state, first, second, cards[0]!, '決鬥', player.id);
}

/** 激將（出牌階段）：由蜀勢力角色代打【殺】，再以主公為來源使用。 */
function* resolveJijiang(
  state: GameState,
  player: PlayerState,
  option: PlayOption,
): Generator<Request, void, Response> {
  const target = option.targets[0] === undefined ? null : state.players[option.targets[0]] ?? null;
  if (!target || !target.alive) return;

  const played = yield* askJijiangAllies(state, player, target);
  if (!played) {
    // 沒有盟友回應：不消耗行動，但本回合不再重複提供，避免死循環。
    player.marks.jijiang_failed = true;
    return;
  }

  let bonus = 0;
  if (player.wine) {
    bonus = 1;
    player.wine = false;
    log(state, 'play', `${nameOf(state, player.id)} 的酒意令此【殺】傷害 +1。`);
  }
  player.slashUsed += 1;
  player.marks.slash_played = true;
  const use = makeUse(state, player, played.cards, played.name, [target.id], 'jijiang');
  yield* resolveSlashTarget(state, player, target, use, { bonus });
}

/** 苦肉：失去 1 點體力，摸兩張牌；可重複使用。 */
function* resolveKurou(state: GameState, player: PlayerState): Generator<Request, void, Response> {
  player.hp -= 1;
  log(state, 'system', `${nameOf(state, player.id)} 發動【苦肉】，失去 1 點體力。`);
  if (player.hp <= 0) {
    emitTiming('dying', { state, source: null, target: player.id });
    const saved = yield* runDying(state, player);
    if (!saved) {
      yield* killPlayer(state, player, null);
      return;
    }
  }
  drawCards(state, player, 2);
}

/** 反間：令目標猜花色；猜錯則受到 1 點傷害。 */
function* resolveFanjian(
  state: GameState,
  player: PlayerState,
  option: PlayOption,
): Generator<Request, void, Response> {
  const target = option.targets[0] === undefined ? null : state.players[option.targets[0]] ?? null;
  if (!target || !target.alive || player.hand.length === 0) return;

  const suits = ['spade', 'heart', 'club', 'diamond'] as const;
  const guess = yield* askRequiredOption(
    state,
    target,
    'choice',
    suits.map((suit) => ({
      id: `suit_${suit}`,
      label: `猜 ${suitLabel(suit)}`,
      kind: 'skill' as const,
      cards: [],
      skill: `suit_${suit}`,
    })),
    '反間：請猜一張花色',
    '反間',
  );

  const index = nextUint32(state) % player.hand.length;
  const shown = player.hand[index]!;
  const guessedSuit = String(guess.skill ?? '').replace('suit_', '') as Card['suit'];
  player.marks.fanjian_used = true;
  log(
    state,
    'play',
    `${nameOf(state, player.id)} 發動【反間】，${nameOf(state, target.id)} 猜 ${suitLabel(guessedSuit)}；展示【${cardRef(shown)}】。`,
  );
  if (shown.suit !== guessedSuit) {
    yield* dealDamage(state, {
      sourceId: player.id,
      targetId: target.id,
      amount: 1,
      nature: 'normal',
      card: shown,
      cards: [shown],
      reason: '反間',
    });
  }

  // 官方：無論猜對與否，目標在【反間】全部結算完畢後獲得這張展示牌。
  const holderIndex = player.hand.findIndex((card) => card.id === shown.id);
  if (holderIndex >= 0) {
    const [card] = takeFromHand(state, player, [shown.id]);
    if (!card) return;
    if (target.alive) {
      target.hand.push(card);
      log(state, 'play', `${nameOf(state, target.id)} 獲得【反間】展示的牌。`);
    } else {
      // 目標已死亡時，展示牌進入棄牌堆（官方各版本對死亡時歸屬不同，此為簡化）。
      pushDiscard(state, [card]);
    }
  }
}

/** 結姻：棄兩張手牌，自己與目標各回復 1 點。 */
function* resolveJieyin(
  state: GameState,
  player: PlayerState,
  option: PlayOption,
): Generator<Request, void, Response> {
  if (player.hand.length < 2) return;
  const target = option.targets[0] === undefined ? null : state.players[option.targets[0]] ?? null;
  if (!target || !target.alive) return;

  const ids = yield* askCards(
    state,
    player,
    player.hand.map((card) => card.id),
    2,
    2,
    '結姻',
    '選擇兩張手牌棄置',
  );
  discardFromHand(state, player, ids, '結姻');
  player.marks.jieyin_used = true;
  log(state, 'play', `${nameOf(state, player.id)} 發動【結姻】。`);
  heal(state, player, 1, '結姻');
  if (target.id !== player.id) {
    const healed = heal(state, target, 1, '結姻');
    if (healed > 0) {
      recordEvent(state, {
        kind: 'heal',
        source: player.id,
        target: target.id,
        skill: 'jieyin',
        amount: healed,
      });
    }
  }
}

function* askPlayers(
  state: GameState,
  player: PlayerState,
  candidates: readonly PlayerId[],
  min: number,
  max: number,
  reason: string,
  prompt: string,
): Generator<Request, PlayerId[], Response> {
  const allowed = [...new Set(candidates)];
  if (allowed.length === 0 || max <= 0) return [];
  const request: Request = {
    ...baseRequest(state, player.id, prompt),
    kind: 'choosePlayers',
    candidates: allowed,
    min,
    max,
    reason,
  };
  const response = yield* ask(state, request);
  if (response.type !== 'players') throw new Error(`${reason}: expected players response`);
  const chosen = [...new Set(response.players)];
  if (chosen.length < min || chosen.length > max) throw new Error(`${reason}: invalid player count`);
  if (!chosen.every((id) => allowed.includes(id))) throw new Error(`${reason}: invalid player`);
  return chosen;
}

/** 突襲：放棄摸牌，改為獲得至多兩名其他角色各一張手牌（隨機）。 */
function* resolveTuxi(state: GameState, player: PlayerState): Generator<Request, void, Response> {
  const candidates = state.players.filter(
    (target) => target.alive && target.id !== player.id && target.hand.length > 0,
  );
  if (candidates.length === 0) {
    drawCards(state, player, 2);
    return;
  }
  const ids = yield* askPlayers(
    state,
    player,
    candidates.map((target) => target.id),
    1,
    Math.min(2, candidates.length),
    '突襲',
    '選擇至多兩名角色，各獲得其一張手牌',
  );
  for (const id of ids) {
    const target = state.players[id];
    if (!target || !target.alive || target.hand.length === 0) continue;
    const index = nextUint32(state) % target.hand.length;
    const candidate = target.hand[index];
    if (!candidate) continue;
    const card = removeCardFromPlayer(state, target, candidate.id, true);
    player.hand.push(card);
    log(state, 'draw', `${nameOf(state, player.id)} 發動【突襲】，獲得 ${nameOf(state, target.id)} 的一張手牌。`);
    recordEvent(state, { kind: 'use', source: player.id, target: target.id, skill: 'tuxi' });
  }
}

/** 觀星：觀看牌堆頂的牌，可重新排序，也可將任意張數移到牌堆底。 */
function* resolveGuanxing(state: GameState, player: PlayerState): Generator<Request, void, Response> {
  const aliveCount = state.players.filter((target) => target.alive).length;
  const count = Math.min(aliveCount, state.deck.length);
  if (count <= 0) return;
  // `top` 的尾端是下一張摸到的牌；反轉後 `viewed[0]` 才是牌堆頂。
  const top = state.deck.slice(state.deck.length - count);
  const viewed = [...top].reverse();
  const request: Request = {
    ...baseRequest(
      state,
      player.id,
      `觀星：安排牌堆頂 ${count} 張的順序（由上到下），可將任意張數移到牌堆底`,
    ),
    kind: 'orderCards',
    cards: viewed.map((card) => ({ ...card })),
    reason: '觀星',
    allowBottom: true,
  };
  const response = yield* ask(state, request);
  const plan = response.type === 'cards' ? validateGuanxing(response, viewed) : null;
  if (!plan) {
    log(state, 'draw', `${nameOf(state, player.id)} 發動【觀星】，保留牌堆頂不變。`);
    return;
  }
  // 移除原本的牌堆頂區塊，再依序放回：bottom 在牌堆最底、top 在牌堆頂。
  // 陣列尾端才是下一張摸到的牌，所以 top 放回時要反轉。
  state.deck.splice(state.deck.length - count, count);
  state.deck.push(...[...plan.top].reverse());
  state.deck.unshift(...plan.bottom);
  log(
    state,
    'draw',
    `${nameOf(state, player.id)} 發動【觀星】，保留 ${plan.top.length} 張在牌堆頂，將 ${plan.bottom.length} 張移到牌堆底。`,
  );
}

/** 觀星回傳的 top／bottom 是否恰好包含原牌且不重複；是則回傳對應的 Card。 */
function validateGuanxing(
  response: { cards: number[]; bottom?: number[] },
  cards: readonly Card[],
): { top: Card[]; bottom: Card[] } | null {
  const bottomIds = response.bottom ?? [];
  const all = [...response.cards, ...bottomIds];
  if (all.length !== cards.length) return null;
  if (new Set(all).size !== all.length) return null;
  const byId = new Map(cards.map((card) => [card.id, card]));
  const top: Card[] = [];
  const bottom: Card[] = [];
  for (const id of response.cards) {
    const card = byId.get(id);
    if (!card) return null;
    top.push(card);
  }
  for (const id of bottomIds) {
    const card = byId.get(id);
    if (!card) return null;
    bottom.push(card);
  }
  return { top, bottom };
}

/** 洛神：重複判定，黑色獲得並可繼續，紅色置於牌堆頂。 */
function* resolveLuoshen(state: GameState, player: PlayerState): Generator<Request, void, Response> {
  let count = 0;
  while (count < 10 && player.alive && !state.winner) {
    const chosen = yield* askResponse(
      state,
      player,
      'choice',
      [{
        id: 'luoshen',
        label: '洛神：進行判定',
        kind: 'skill',
        cards: [],
        skill: 'luoshen',
      }],
      '是否發動【洛神】？',
      '洛神',
    );
    if (!chosen) break;
    count += 1;
    const judged = yield* judge(state, player, '洛神', { keep: true });
    if (!judged) break;
    if (isBlack(judged)) {
      player.hand.push(judged);
      log(state, 'judge', `${nameOf(state, player.id)} 的【洛神】獲得黑色判定牌【${cardLabel(judged.name)}】。`);
    } else {
      state.deck.push(judged);
      log(state, 'judge', `${nameOf(state, player.id)} 的【洛神】將紅色判定牌置於牌堆頂。`);
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 殺、閃、無懈                                                        */
/* ------------------------------------------------------------------ */

interface ShaPlay {
  card: Card;
  cards: Card[];
  name: CardName;
  skill?: string;
}

/** 是否還有其他存活的蜀勢力角色可響應【激將】。 */
function hasJijiangAlly(state: GameState, player: PlayerState): boolean {
  if (!hasSkill(player, 'jijiang')) return false;
  return state.players.some(
    (other) => other.alive && other.id !== player.id && generalOf(other).kingdom === 'shu',
  );
}

/** 是否還有其他存活的魏勢力角色可響應【護駕】。 */
function hasHujiaAlly(state: GameState, player: PlayerState): boolean {
  if (!hasSkill(player, 'hujia')) return false;
  return state.players.some(
    (other) => other.alive && other.id !== player.id && generalOf(other).kingdom === 'wei',
  );
}

function getShaOptions(
  state: GameState,
  player: PlayerState,
  target?: PlayerState,
  offerLordSkill = false,
): ResponseOption[] {
  const options: ResponseOption[] = [];
  if (target && (!inAttackRange(state, player.id, target.id) || targetBlocked(target, 'slash'))) {
    return options;
  }
  for (const card of player.hand) {
    if (isSlashCard(card.name)) {
      options.push({
        id: `sha:${card.id}`,
        label: `打出【${cardLabel(card.name)}】`,
        kind: 'respond',
        cards: [card.id],
        asCard: card.name,
      });
    }
  }
  if (hasSkill(player, 'wusheng')) {
    for (const card of player.hand) {
      if (isSlashCard(card.name) || !isRed(card)) continue;
      options.push({
        id: `wusheng:${card.id}`,
        label: `武聖：將 ${cardRef(card)} 當【殺】`,
        kind: 'respond',
        cards: [card.id],
        asCard: 'slash',
        skill: 'wusheng',
      });
    }
  }
  if (hasSkill(player, 'longdan')) {
    for (const card of player.hand) {
      if (card.name !== 'dodge') continue;
      options.push({
        id: `longdan:${card.id}`,
        label: `龍膽：將 ${cardRef(card)} 當【殺】`,
        kind: 'respond',
        cards: [card.id],
        asCard: 'slash',
        skill: 'longdan',
      });
    }
  }
  if (player.equips.weapon?.name === 'serpent_spear' && player.hand.length >= 2) {
    // 只在回應時提供一個選項；實際的兩張牌在選定後才詢問。
    options.push({
      id: 'sha_spear',
      label: '丈八蛇矛：選擇兩張手牌當【殺】',
      kind: 'respond',
      cards: [],
      asCard: 'slash',
      skill: 'serpent_spear',
    });
  }
  // 激將：即使主公自己有【殺】，也讓玩家可以選擇發動主公技。
  if (offerLordSkill && hasJijiangAlly(state, player)) {
    options.push({
      id: 'jijiang',
      label: '激將：令蜀勢力角色代打【殺】',
      kind: 'respond',
      cards: [],
      asCard: 'slash',
      skill: 'jijiang',
    });
  }
  return options;
}

/** 技「激將」的借用入口：先問本人（可選自己的牌或發動激將），再問蜀勢力角色。 */
function* askForSha(
  state: GameState,
  player: PlayerState,
  context: string,
  target?: PlayerState,
): Generator<Request, ShaPlay | null, Response> {
  let offerLordSkill = hasJijiangAlly(state, player);
  while (true) {
    // 把目標帶進請求，讓被要求的角色能判斷這一刀值不值得打（例如被【借刀殺人】逼著打隊友）。
    const own = yield* askForShaSelf(
      state,
      player,
      context,
      target,
      { targets: target ? [target.id] : undefined },
      offerLordSkill,
    );
    if (own === 'jijiang') {
      offerLordSkill = false;
      const borrowed = yield* askJijiangAllies(state, player, target);
      if (borrowed) return borrowed;
      // 盟友全拒絕：回到本人選牌（若還有牌）；已用過的激將不再重複詢問。
      continue;
    }
    return own;
  }
}

/** 依序詢問蜀勢力角色是否替主公打出【殺】。 */
function* askJijiangAllies(
  state: GameState,
  lord: PlayerState,
  target?: PlayerState,
): Generator<Request, ShaPlay | null, Response> {
  if (!hasSkill(lord, 'jijiang')) return null;
  for (const ally of turnOrderFrom(state, lord.id).slice(1)) {
    if (!ally.alive || generalOf(ally).kingdom !== 'shu') continue;
    // 標明借用者與被打的目標，讓代打的角色能判斷值不值得（不幫敵人）。
    const borrowed = yield* askForShaSelf(
      state,
      ally,
      `激將：為 ${nameOf(state, lord.id)} 打出`,
      undefined,
      { source: lord.id, targets: target ? [target.id] : undefined },
      false,
    );
    if (borrowed && borrowed !== 'jijiang') {
      log(state, 'play', `${nameOf(state, lord.id)} 的【激將】由 ${nameOf(state, ally.id)} 打出【殺】。`);
      recordEvent(state, { kind: 'use', source: ally.id, target: lord.id, skill: 'jijiang' });
      return borrowed;
    }
    // 公開日誌只說「未響應」，不洩漏該角色手上有沒有【殺】。
    log(state, 'play', `${nameOf(state, ally.id)} 未響應【激將】。`);
  }
  log(state, 'play', `${nameOf(state, lord.id)} 的【激將】沒有蜀勢力角色回應。`);
  return null;
}

function* askForShaSelf(
  state: GameState,
  player: PlayerState,
  context: string,
  target?: PlayerState,
  extra: ResponseExtra = {},
  offerLordSkill = false,
): Generator<Request, ShaPlay | 'jijiang' | null, Response> {
  const options = getShaOptions(state, player, target, offerLordSkill);
  if (options.length === 0) return null;
  const chosen = yield* askResponse(
    state,
    player,
    'sha',
    options,
    '是否打出【殺】？',
    context,
    extra,
  );
  if (!chosen) return null;
  if (chosen.skill === 'jijiang') return 'jijiang';
  let cards: Card[];
  if (chosen.skill === 'serpent_spear' && chosen.cards.length === 0) {
    const ids = yield* askCards(
      state,
      player,
      player.hand.map((card) => card.id),
      2,
      2,
      '丈八蛇矛',
      '請選擇兩張手牌當【殺】打出',
      { target: target?.id },
    );
    cards = takeFromHand(state, player, ids);
  } else {
    cards = takeFromHand(state, player, chosen.cards);
  }
  if (cards.length === 0) return null;
  pushDiscard(state, cards);
  player.marks.slash_played = true;
  const name = chosen.asCard ?? cards[0]!.name;
  recordEvent(state, { kind: 'use', source: player.id, target: target?.id ?? null, cardName: name });
  log(
    state,
    'play',
    `${nameOf(state, player.id)} 打出【${cardLabel(name)}】${chosen.skill === 'serpent_spear' ? '（丈八蛇矛）' : ''}。`,
  );
  return { card: cards[0]!, cards, name, skill: chosen.skill };
}

function getShanOptions(
  state: GameState,
  player: PlayerState,
  allowBagua: boolean,
  offerLordSkill = false,
): ResponseOption[] {
  const options: ResponseOption[] = [];
  for (const card of player.hand) {
    if (card.name === 'dodge') {
      options.push({
        id: `dodge:${card.id}`,
        label: '打出【閃】',
        kind: 'respond',
        cards: [card.id],
        asCard: 'dodge',
      });
    }
  }
  if (hasSkill(player, 'longdan')) {
    for (const card of player.hand) {
      if (!isSlashCard(card.name)) continue;
      options.push({
        id: `longdan_shan:${card.id}`,
        label: `龍膽：將 ${cardRef(card)} 當【閃】`,
        kind: 'respond',
        cards: [card.id],
        asCard: 'dodge',
        skill: 'longdan',
      });
    }
  }
  if (hasSkill(player, 'qingguo')) {
    for (const card of player.hand) {
      if (!isBlack(card)) continue;
      options.push({
        id: `qingguo:${card.id}`,
        label: `傾國：將 ${cardRef(card)} 當【閃】`,
        kind: 'respond',
        cards: [card.id],
        asCard: 'dodge',
        skill: 'qingguo',
      });
    }
  }
  if (allowBagua && player.equips.armor?.name === 'eight_diagram') {
    options.push({
      id: 'bagua',
      label: '八卦陣（判定，紅色視為【閃】）',
      kind: 'skill',
      cards: [],
      skill: 'bagua',
    });
  }
  // 護駕：即使主公自己有【閃】，也讓玩家可以選擇發動主公技。
  if (offerLordSkill && hasHujiaAlly(state, player)) {
    options.push({
      id: 'hujia',
      label: '護駕：令魏勢力角色代打【閃】',
      kind: 'respond',
      cards: [],
      asCard: 'dodge',
      skill: 'hujia',
    });
  }
  return options;
}

/** 技「護駕」的借用入口：先問本人（可選自己的牌或發動護駕），再問魏勢力角色。 */
function* askForShan(
  state: GameState,
  target: PlayerState,
  context: string,
  allowBagua = true,
): Generator<Request, boolean, Response> {
  let offerLordSkill = hasHujiaAlly(state, target);
  while (true) {
    const own = yield* askForShanSelf(
      state,
      target,
      context,
      allowBagua,
      {},
      offerLordSkill,
    );
    if (own === 'hujia') {
      offerLordSkill = false;
      const borrowed = yield* askHujiaAllies(state, target);
      if (borrowed) return true;
      // 盟友全拒絕：回到本人選牌（若還有牌）；已用過的護駕不再重複詢問。
      continue;
    }
    return own === true;
  }
}

/** 依序詢問魏勢力角色是否替主公打出【閃】。 */
function* askHujiaAllies(
  state: GameState,
  lord: PlayerState,
): Generator<Request, boolean, Response> {
  if (!hasSkill(lord, 'hujia')) return false;
  for (const ally of turnOrderFrom(state, lord.id).slice(1)) {
    if (!ally.alive || generalOf(ally).kingdom !== 'wei') continue;
    const borrowed = yield* askForShanSelf(
      state,
      ally,
      `護駕：為 ${nameOf(state, lord.id)}`,
      false,
      { source: lord.id },
      false,
    );
    if (borrowed === true) {
      log(state, 'play', `${nameOf(state, lord.id)} 的【護駕】由 ${nameOf(state, ally.id)} 打出【閃】。`);
      recordEvent(state, { kind: 'use', source: ally.id, target: lord.id, skill: 'hujia' });
      return true;
    }
    // 公開日誌只說「未響應」，不洩漏該角色手上有沒有【閃】。
    log(state, 'play', `${nameOf(state, ally.id)} 未響應【護駕】。`);
  }
  log(state, 'play', `${nameOf(state, lord.id)} 的【護駕】沒有魏勢力角色回應。`);
  return false;
}

function* askForShanSelf(
  state: GameState,
  target: PlayerState,
  context: string,
  allowBagua = true,
  extra: ResponseExtra = {},
  offerLordSkill = false,
): Generator<Request, boolean | 'hujia', Response> {
  const options = getShanOptions(state, target, allowBagua, offerLordSkill);
  const chosen = yield* askResponse(
    state,
    target,
    'shan',
    options,
    '是否打出【閃】？',
    context,
    extra,
  );
  if (!chosen) return false;
  if (chosen.skill === 'hujia') return 'hujia';

  if (chosen.skill === 'bagua') {
    const judged = yield* judge(state, target, '八卦陣');
    if (judged && isRed(judged)) {
      log(state, 'play', `${nameOf(state, target.id)} 的【八卦陣】判定成功，視為打出【閃】。`);
      return true;
    }
    log(state, 'play', `${nameOf(state, target.id)} 的【八卦陣】判定失敗。`);
    return yield* askForShanSelf(state, target, context, false, extra, offerLordSkill);
  }

  const cards = takeFromHand(state, target, chosen.cards);
  const card = cards[0];
  if (!card) return false;
  pushDiscard(state, cards);
  log(state, 'play', `${nameOf(state, target.id)} 打出【${cardLabel(chosen.asCard ?? card.name)}】。`);
  recordEvent(state, {
    kind: 'use',
    source: target.id,
    target: null,
    cardName: chosen.asCard ?? card.name,
  });
  return true;
}

function getNullificationOptions(player: PlayerState): ResponseOption[] {
  return player.hand
    .filter((card) => card.name === 'nullification')
    .map((card) => ({
      id: `wuxie:${card.id}`,
      label: '打出【無懈可擊】',
      kind: 'respond' as const,
      cards: [card.id],
      asCard: 'nullification' as const,
    }));
}

/**
 * 無懈可擊連鎖。
 *
 * 回傳 true 表示目標錦囊最終被抵消。每打出一張無懈就從頭重新詢問，
 * 以 LIFO 語意處理「無懈無懈可擊」。最大深度 16。
 *
 * 傳入 `targetId` 時只針對該目標開啟窗口（群體錦囊逐目標結算），
 * 請求中的 `targets` 也會縮成該目標，讓 AI 只評估這名角色的得失。
 */
function* askNullification(
  state: GameState,
  use: CardUse,
  targetId?: PlayerId,
): Generator<Request, boolean, Response> {
  const targetName = targetId === undefined ? null : nameOf(state, targetId);
  const scopedTargets = targetId === undefined ? use.targets : [targetId];
  const prompt =
    targetName === null
      ? `是否對【${useLabel(use)}】使用【無懈可擊】？`
      : `是否對【${useLabel(use)}】→ ${targetName} 使用【無懈可擊】？`;
  let count = 0;
  while (count < MAX_NULLIFICATION_CHAIN) {
    let played = false;
    for (const responder of turnOrderFrom(state, use.source)) {
      if (!responder.alive) continue;
      const options = getNullificationOptions(responder);
      if (options.length === 0) continue;
      const chosen = yield* askResponse(
        state,
        responder,
        'wuxie',
        options,
        prompt,
        '無懈可擊',
        {
          cardName: use.name,
          source: use.source,
          targets: scopedTargets,
          nullificationCount: count,
        },
      );
      if (chosen) {
        const cards = takeFromHand(state, responder, chosen.cards);
        pushDiscard(state, cards);
        count += 1;
        played = true;
        log(
          state,
          'play',
          `${nameOf(state, responder.id)} 對【${useLabel(use)}】${
            targetName === null ? '' : `（${targetName}）`
          }使用【無懈可擊】（連鎖 ${count}）。`,
        );
        break;
      }
    }
    if (!played) break;
  }
  if (count >= MAX_NULLIFICATION_CHAIN) {
    log(state, 'system', `無懈可擊連鎖達到上限 ${MAX_NULLIFICATION_CHAIN}，停止詢問。`);
  }
  return count % 2 === 1;
}

/* ------------------------------------------------------------------ */
/* 武器與殺的結算                                                      */
/* ------------------------------------------------------------------ */

interface SlashOptions {
  bonus?: number;
  ignoreArmor?: boolean;
  noDodge?: boolean;
  fromWeapon?: boolean;
  /** 已被【流離】轉移過，避免再次轉移。 */
  redirected?: boolean;
  /** 此【殺】被【借刀殺人】等效果強迫；公開事件用來避免誤記被強迫者。 */
  forcedBy?: PlayerId;
  /** 此【殺】被【流離】轉移；公開事件把責任記在轉移者身上。 */
  redirectedBy?: PlayerId;
}

function* resolveSlashTarget(
  state: GameState,
  source: PlayerState,
  target: PlayerState,
  use: CardUse,
  extra: SlashOptions = {},
): Generator<Request, void, Response> {
  if (!target.alive || !source.alive) return;

  const weapon = source.equips.weapon?.name;
  const bonus = extra.bonus ?? 0;
  let noDodge = extra.noDodge ?? false;
  const ignoreArmor = extra.ignoreArmor ?? weapon === 'qinggang';

  // 雌雄雙股劍：指定異性目標時，令其選擇棄一張手牌或讓來源摸一張。
  if (
    !extra.fromWeapon &&
    weapon === 'double_sword' &&
    generalOf(source).gender !== generalOf(target).gender
  ) {
    const chosen = yield* askResponse(
      state,
      source,
      'choice',
      [{
        id: 'double_sword',
        label: '雌雄雙股劍：令目標棄一張手牌，或讓你摸一張牌',
        kind: 'skill',
        cards: [],
        skill: 'double_sword',
        targets: [target.id],
      }],
      '是否發動【雌雄雙股劍】？',
      '雌雄雙股劍',
    );
    if (chosen) {
      if (target.hand.length === 0) {
        drawCards(state, source, 1);
        log(state, 'play', `${nameOf(state, target.id)} 沒有手牌，${nameOf(state, source.id)} 摸 1 張牌。`);
      } else {
        const choice = yield* askRequiredOption(
          state,
          target,
          'choice',
          [
            {
              id: 'discard',
              label: '棄置一張手牌',
              kind: 'skill',
              cards: [],
              skill: 'discard',
            },
            {
              id: 'draw',
              label: `讓 ${nameOf(state, source.id)} 摸一張牌`,
              kind: 'skill',
              cards: [],
              skill: 'draw',
            },
          ],
          '雌雄雙股劍：請選擇一項',
          '雌雄雙股劍',
        );
        if (choice.skill === 'discard') {
          const ids = yield* askCards(
            state,
            target,
            target.hand.map((card) => card.id),
            1,
            1,
            '雌雄雙股劍',
            '選擇一張手牌棄置',
          );
          discardFromHand(state, target, ids, '雌雄雙股劍');
        } else {
          drawCards(state, source, 1);
          log(state, 'play', `${nameOf(state, source.id)} 因【雌雄雙股劍】摸 1 張牌。`);
        }
      }
    }
  }

  if (!ignoreArmor) {
    if (target.equips.armor?.name === 'renwang' && isBlack(use.card)) {
      log(state, 'play', `${nameOf(state, target.id)} 的【仁王盾】令黑色【殺】無效。`);
      return;
    }
    if (target.equips.armor?.name === 'vine_armor' && use.nature === 'normal') {
      log(state, 'play', `${nameOf(state, target.id)} 的【藤甲】令普通【殺】無效。`);
      return;
    }
  }

  // 流離：成為【殺】目標時，可棄一張牌（手牌或裝備）轉移給攻擊範圍內的一名其他角色。
  // 官方：棄牌後才重算攻擊範圍，且不可轉移給來源、不可棄判定區的牌。
  if (
    !extra.redirected &&
    !extra.fromWeapon &&
    hasSkill(target, 'liuli') &&
    handAndEquips(target).length > 0
  ) {
    const canOffer = state.players.some(
      (other) =>
        other.alive &&
        other.id !== target.id &&
        other.id !== source.id &&
        inAttackRange(state, target.id, other.id),
    );
    if (canOffer) {
      const chosen = yield* askResponse(
        state,
        target,
        'choice',
        [{
          id: 'liuli',
          label: '流離：棄一張牌，將此【殺】轉移給攻擊範圍內的一名其他角色',
          kind: 'skill',
          cards: [],
          skill: 'liuli',
        }],
        '是否發動【流離】？',
        '流離',
      );
      if (chosen) {
        const ids = yield* askFrom(
          state,
          target,
          handAndEquips(target),
          1,
          1,
          '流離',
          '選擇一張牌棄置（手牌或裝備）',
        );
        const paid = ids[0];
        if (paid !== undefined) {
          const removed = removeCardFromPlayer(state, target, paid, true);
          pushDiscard(state, [removed]);
          log(
            state,
            'play',
            `${nameOf(state, target.id)} 發動【流離】，棄置【${cardLabel(removed.name)}】。`,
          );
        }
        // 棄牌後重新計算攻擊範圍（失去武器或坐騎可能縮短範圍）。
        const candidates = state.players.filter(
          (other) =>
            other.alive &&
            other.id !== target.id &&
            other.id !== source.id &&
            inAttackRange(state, target.id, other.id),
        );
        if (candidates.length > 0) {
          const picked = yield* askPlayers(
            state,
            target,
            candidates.map((other) => other.id),
            1,
            1,
            '流離',
            '選擇【殺】轉移的目標',
          );
          const newTarget = picked[0] === undefined ? null : state.players[picked[0]] ?? null;
          if (newTarget && newTarget.alive) {
            log(
              state,
              'play',
              `${nameOf(state, target.id)} 發動【流離】，將【殺】轉移給 ${nameOf(state, newTarget.id)}。`,
            );
            // 公開事件：轉移目標是流離使用者的決定；原攻擊者不該為新目標的傷害負責。
            recordEvent(state, {
              kind: 'use',
              source: target.id,
              target: newTarget.id,
              skill: 'liuli',
              targets: [target.id, newTarget.id],
            });
            yield* resolveSlashTarget(state, source, newTarget, use, {
              ...extra,
              redirected: true,
              fromWeapon: true,
              bonus,
              noDodge,
              redirectedBy: target.id,
            });
            return;
          }
        } else {
          log(
            state,
            'play',
            `${nameOf(state, target.id)} 的【流離】在棄牌後已無合法目標，【殺】仍以其為目標。`,
          );
        }
      }
    }
  }

  // 鐵騎：使用【殺】指定目標後可判定，紅色則此【殺】不可被【閃】抵消。
  if (!extra.fromWeapon && !noDodge && hasSkill(source, 'tieqi')) {
    const chosen = yield* askResponse(
      state,
      source,
      'choice',
      [{
        id: 'tieqi',
        label: '鐵騎：判定，紅色則此【殺】不可被【閃】抵消',
        kind: 'skill',
        cards: [],
        skill: 'tieqi',
        targets: [target.id],
      }],
      '是否發動【鐵騎】？',
      '鐵騎',
    );
    if (chosen) {
      const judged = yield* judge(state, source, '鐵騎');
      if (judged && isRed(judged)) {
        noDodge = true;
        log(state, 'play', `${nameOf(state, source.id)} 的【鐵騎】判定為紅色，此【殺】不可被【閃】抵消。`);
      } else {
        log(state, 'play', `${nameOf(state, source.id)} 的【鐵騎】判定為黑色，未生效。`);
      }
    }
  }

  if (!noDodge) {
    // 無雙：來源使用【殺】時，目標需連續打出兩張【閃】。
    const required = hasSkill(source, 'wushuang') ? 2 : 1;
    let dodged = true;
    for (let index = 0; index < required; index += 1) {
      const ok = yield* askForShan(state, target, `【${cardLabel(use.name)}】`, !ignoreArmor);
      if (!ok) {
        dodged = false;
        break;
      }
    }
    if (required > 1 && dodged) {
      log(state, 'play', `${nameOf(state, target.id)} 因【無雙】連續打出兩張【閃】。`);
    }
    if (dodged) {
      log(state, 'play', `${nameOf(state, target.id)} 抵消了【${cardLabel(use.name)}】。`);

      // 青龍偃月刀：被【閃】抵消時，可再使用一張【殺】。
      if (!extra.fromWeapon && weapon === 'green_dragon') {
        const slashOptions = getShaOptions(state, source, target, true);
        if (slashOptions.length > 0) {
          const chosen = yield* askResponse(
            state,
            source,
            'choice',
            [{
              id: 'green_dragon',
              label: '青龍偃月刀：再使用一張【殺】',
              kind: 'skill',
              cards: [],
              skill: 'green_dragon',
              targets: [target.id],
            }],
            '是否發動【青龍偃月刀】？',
            '青龍偃月刀',
          );
          if (chosen) {
            const extraSlash = yield* askForSha(state, source, '青龍偃月刀', target);
            if (extraSlash) {
              log(state, 'play', `${nameOf(state, source.id)} 發動【青龍偃月刀】再使用【殺】。`);
              const nextUse = makeUse(
                state,
                source,
                extraSlash.cards,
                extraSlash.name,
                [target.id],
                'green_dragon',
              );
              yield* resolveSlashTarget(state, source, target, nextUse, { fromWeapon: true });
            }
          }
        }
        return;
      }

      // 貫石斧：被【閃】抵消時，可棄兩張牌（手牌或裝備，不含貫石斧本身），
      // 令此【殺】依然造成傷害。
      if (!extra.fromWeapon && weapon === 'rock_axe') {
        const discardable = handAndEquips(source).filter(
          (card) => card.id !== source.equips.weapon?.id,
        );
        if (discardable.length >= 2) {
          const chosen = yield* askResponse(
            state,
            source,
            'choice',
            [{
              id: 'rock_axe',
              label: '貫石斧：棄置 2 張牌，令此【殺】依然造成傷害',
              kind: 'skill',
              cards: [],
              skill: 'rock_axe',
              targets: [target.id],
            }],
            '是否發動【貫石斧】？',
            '貫石斧',
          );
          if (chosen) {
            const ids = yield* askFrom(
              state,
              source,
              discardable,
              2,
              2,
              '貫石斧',
              '選擇兩張牌棄置（手牌或裝備，不含貫石斧）',
            );
            const removed: Card[] = [];
            for (const id of ids) removed.push(removeCardFromPlayer(state, source, id, true));
            pushDiscard(state, removed);
            log(
              state,
              'play',
              `${nameOf(state, source.id)} 發動【貫石斧】，棄置 ${removed.length} 張牌，此【殺】依然造成傷害。`,
            );
            // 繼續往下結算傷害。
          } else {
            return;
          }
        } else {
          return;
        }
      } else {
        return;
      }
    }
  }

  // 寒冰劍：造成傷害時，可防止傷害並棄置目標兩張牌。
  // 官方：只能棄置目標的手牌與裝備牌，不可棄判定區的牌；目標有 2 張以上
  // 必須棄 2 張，只有 1 張時可發動並棄 1 張，沒有牌時不能發動。
  // 棄牌後若因【連營】、【梟姬】等獲得新牌，仍可繼續棄到第 2 張。
  if (!extra.fromWeapon && weapon === 'ice_sword' && handAndEquips(target).length > 0) {
    const preview = previewDamageAmount(
      state,
      source,
      target,
      1 + bonus,
      use.name,
      use.nature,
      ignoreArmor,
      false,
    );
    const chosen = yield* askResponse(
      state,
      source,
      'choice',
      [{
        id: 'ice_sword',
        label: '寒冰劍：防止此傷害，改為棄置目標兩張牌',
        kind: 'skill',
        cards: [],
        skill: 'ice_sword',
        targets: [target.id],
      }],
      '是否發動【寒冰劍】？',
      '寒冰劍',
      { targets: [target.id], damage: preview.amount },
    );
    if (chosen) {
      const discarded: Card[] = [];
      for (let i = 0; i < 2; i += 1) {
        if (handAndEquips(target).length === 0) break;
        const card = yield* askCardFrom(
          state,
          source,
          target,
          '寒冰劍',
          `選擇要棄置 ${nameOf(state, target.id)} 的第 ${i + 1} 張牌`,
          false,
        );
        if (!card) break;
        // removeCardFromPlayer 會在失去最後一張手牌時立即結算【連營】，
        // 才能決定是否還要棄第二張。
        discarded.push(removeCardFromPlayer(state, target, card.id, true));
      }
      pushDiscard(state, discarded);
      log(
        state,
        'play',
        `${nameOf(state, source.id)} 的【寒冰劍】防止傷害，棄置 ${nameOf(state, target.id)} 的 ${discarded.length} 張牌。`,
      );
      return;
    }
  }

  yield* dealDamage(state, {
    sourceId: source.id,
    targetId: target.id,
    amount: 1 + bonus,
    nature: use.nature,
    card: use.card,
    cards: use.cards,
    cardName: use.name,
    reason: cardLabel(use.name),
    ignoreArmor,
    forcedBy: extra.forcedBy,
    redirectedBy: extra.redirectedBy,
  });

  // 麒麟弓：造成傷害時，可棄置目標的一匹馬。
  if (
    !extra.fromWeapon &&
    weapon === 'qilin_bow' &&
    target.alive &&
    (target.equips.horsePlus || target.equips.horseMinus)
  ) {
    const horses = [target.equips.horsePlus, target.equips.horseMinus].filter(
      (card): card is Card => card !== null,
    );
    const chosen = yield* askResponse(
      state,
      source,
      'choice',
      horses.map((card) => ({
        id: `qilin:${card.id}`,
        label: `麒麟弓：棄置 ${nameOf(state, target.id)} 的【${cardLabel(card.name)}】`,
        kind: 'skill' as const,
        cards: [card.id],
        skill: 'qilin_bow',
        targets: [target.id],
      })),
      '是否發動【麒麟弓】？',
      '麒麟弓',
    );
    if (chosen) {
      const card = horses.find((item) => item.id === chosen.cards[0]);
      if (card) {
        const removed = removeCardFromPlayer(state, target, card.id, true);
        pushDiscard(state, [removed]);
        log(
          state,
          'play',
          `${nameOf(state, source.id)} 的【麒麟弓】棄置 ${nameOf(state, target.id)} 的【${cardLabel(removed.name)}】。`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

function takeFromDeck(state: GameState, count: number): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < count; i += 1) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) {
        setWinner(state, [], '牌堆與棄牌堆耗盡，平局');
        break;
      }
      state.deck = shuffle(state.discard.splice(0), state);
      log(state, 'system', '棄牌堆已洗回牌堆。');
    }
    const card = state.deck.pop();
    if (!card) break;
    cards.push(card);
  }
  return cards;
}

/**
 * 判定：抽一張判定牌，先處理【鬼才】替換，再公布結果，最後處理【天妒】取得。
 */
interface JudgeOptions {
  /** 是否開放【鬼才】／【天妒】等判定相關技能。 */
  skills?: boolean;
  /** true 時不自動棄置判定牌，由呼叫者自行處理（例如【洛神】）。 */
  keep?: boolean;
}

function* judge(
  state: GameState,
  player: PlayerState,
  reason: string,
  options: JudgeOptions = {},
): Generator<Request, Card | null, Response> {
  const { skills = true, keep = false } = options;
  emitTiming('beforeJudge', { state, target: player.id });
  const [drawn] = takeFromDeck(state, 1);
  if (!drawn) return null;
  let card = drawn;

  // 鬼才：任一擁有者可在判定牌生效前，用一張手牌代替之。
  if (skills) {
    for (const owner of turnOrderFrom(state, player.id)) {
      if (!owner.alive || !hasSkill(owner, 'guicai') || owner.hand.length === 0) continue;
      const chosen = yield* askResponse(
        state,
        owner,
        'choice',
        [{
          id: 'guicai',
          label: `鬼才：打出一張手牌代替 ${nameOf(state, player.id)} 的判定牌`,
          kind: 'skill',
          cards: [],
          skill: 'guicai',
          targets: [player.id],
        }],
        '是否發動【鬼才】？',
        '鬼才',
      );
      if (!chosen) continue;
      const ids = yield* askCards(
        state,
        owner,
        owner.hand.map((item) => item.id),
        1,
        1,
        '鬼才',
        '選擇一張手牌作為判定牌',
      );
      const [replacement] = takeFromHand(state, owner, ids);
      if (!replacement) continue;
      pushDiscard(state, [card]);
      log(
        state,
        'judge',
        `${nameOf(state, owner.id)} 發動【鬼才】，以【${cardLabel(replacement.name)}】代替判定牌。`,
      );
      card = replacement;
    }
  }

  log(
    state,
    'judge',
    `${nameOf(state, player.id)} 判定（${reason}）：${cardLabel(card.name)} ${suitSymbol(card.suit)}${rankLabel(card.rank)}。`,
  );

  // 天妒：判定牌生效後，擁有者可以獲得此判定牌（keep 模式由呼叫者處理）。
  let taken = keep;
  if (!keep && skills && hasSkill(player, 'tiandu')) {
    const chosen = yield* askResponse(
      state,
      player,
      'choice',
      [{
        id: 'tiandu',
        label: `天妒：獲得判定牌【${cardLabel(card.name)}】`,
        kind: 'skill',
        cards: [card.id],
        skill: 'tiandu',
      }],
      '是否發動【天妒】？',
      '天妒',
    );
    if (chosen) {
      player.hand.push(card);
      taken = true;
      log(state, 'judge', `${nameOf(state, player.id)} 的【天妒】獲得了判定牌。`);
    }
  }
  if (!taken) pushDiscard(state, [card]);

  emitTiming('afterJudge', { state, target: player.id, card });
  return card;
}

interface JudgeOutcome {
  skipDraw: boolean;
  skipPlay: boolean;
}

function* runJudgePhase(
  state: GameState,
  player: PlayerState,
): Generator<Request, JudgeOutcome, Response> {
  const outcome: JudgeOutcome = { skipDraw: false, skipPlay: false };

  while (player.judgeZone.length > 0 && player.alive && !state.winner) {
    const delayed = player.judgeZone[player.judgeZone.length - 1];
    if (!delayed) break;
    const delayedName = delayedNameOf(state, delayed);
    const use = makeUse(state, player, [delayed], delayedName, [player.id], 'judge');

    const negated = yield* askNullification(state, use);
    if (negated) {
      removeCardFromPlayer(state, player, delayed.id, false);
      delete state.delayedNames[delayed.id];
      pushDiscard(state, [delayed]);
      log(
        state,
        'judge',
        `${nameOf(state, player.id)} 判定區的【${cardLabel(delayedName)}】被【無懈可擊】抵消。`,
      );
      continue;
    }

    const judged = yield* judge(state, player, cardLabel(delayedName));
    if (!judged) break;

    removeCardFromPlayer(state, player, delayed.id, false);

    if (delayedName === 'indulgence') {
      if (judged.suit !== 'heart') {
        outcome.skipPlay = true;
        log(state, 'judge', `【樂不思蜀】判定失敗，${nameOf(state, player.id)} 跳過出牌階段。`);
      } else {
        log(state, 'judge', `【樂不思蜀】判定成功，${nameOf(state, player.id)} 不受影響。`);
      }
      delete state.delayedNames[delayed.id];
      pushDiscard(state, [delayed]);
      continue;
    }

    if (delayedName === 'supply_shortage') {
      if (judged.suit !== 'club') {
        outcome.skipDraw = true;
        log(state, 'judge', `【兵糧寸斷】判定失敗，${nameOf(state, player.id)} 跳過摸牌階段。`);
      } else {
        log(state, 'judge', `【兵糧寸斷】判定成功，${nameOf(state, player.id)} 不受影響。`);
      }
      delete state.delayedNames[delayed.id];
      pushDiscard(state, [delayed]);
      continue;
    }

    if (delayedName === 'lightning') {
      const hit = judged.suit === 'spade' && judged.rank >= 2 && judged.rank <= 9;
      if (hit) {
        log(state, 'judge', `【閃電】命中，${nameOf(state, player.id)} 受到 3 點雷電傷害。`);
        delete state.delayedNames[delayed.id];
        pushDiscard(state, [delayed]);
        yield* dealDamage(state, {
          sourceId: null,
          targetId: player.id,
          amount: 3,
          nature: 'thunder',
          card: delayed,
          reason: '閃電',
        });
      } else {
        const next = nextLightningHost(state, player.id);
        if (next) {
          next.judgeZone.push(delayed);
          log(
            state,
            'judge',
            `【閃電】未命中，移動到 ${nameOf(state, next.id)} 的判定區。`,
          );
        } else {
          delete state.delayedNames[delayed.id];
          pushDiscard(state, [delayed]);
          log(state, 'judge', '【閃電】未命中，且沒有其他角色可放置，進入棄牌堆。');
        }
      }
      continue;
    }

    // 未知延時錦囊：安全地棄置。
    delete state.delayedNames[delayed.id];
    pushDiscard(state, [delayed]);
  }

  return outcome;
}

function nextLightningHost(state: GameState, from: PlayerId): PlayerState | null {
  const order = turnOrderFrom(state, from).slice(1);
  for (const player of order) {
    if (!player.alive) continue;
    if (hasDelayed(state, player, 'lightning')) continue;
    return player;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 傷害、瀕死、死亡                                                    */
/* ------------------------------------------------------------------ */

interface DamageOptions {
  sourceId: PlayerId | null;
  targetId: PlayerId;
  amount: number;
  nature: Nature;
  card: Card | null;
  /** 造成傷害的所有實體牌（供【奸雄】取得；未提供時退回 `card`）。 */
  cards?: Card[];
  /** 虛擬牌名；丈八蛇矛等轉化牌需要靠這個欄位判斷是否為【殺】。 */
  cardName?: CardName;
  reason: string;
  ignoreArmor?: boolean;
  fromChain?: boolean;
  chainSet?: Set<PlayerId>;
  /** 被【離間】／【借刀殺人】強迫造成此傷害；公開事件用來避免誤記被強迫者。 */
  forcedBy?: PlayerId;
  /** 此【殺】被【流離】轉移；公開事件把責任記在轉移者身上。 */
  redirectedBy?: PlayerId;
}

/**
 * 一張傷害牌在計入古錠刀、裸衣、藤甲與白銀獅子後的最終傷害值。
 * 寒冰劍要先知道「這刀是否足以致命」才能決定要不要防止傷害，因此與
 * `dealDamage` 共用同一套計算與日誌，避免 AI 為了棄牌而放過收頭。
 */
function previewDamageAmount(
  state: GameState,
  source: PlayerState | null,
  target: PlayerState,
  base: number,
  cardName: CardName | undefined,
  nature: Nature,
  ignoreArmor: boolean,
  fromChain: boolean,
): { amount: number; notes: string[] } {
  let amount = base;
  const notes: string[] = [];
  if (
    source &&
    cardName &&
    isSlashCard(cardName) &&
    source.equips.weapon?.name === 'ancient_scimitar' &&
    target.hand.length === 0 &&
    !fromChain
  ) {
    amount += 1;
    notes.push(`${nameOf(state, source.id)} 的【古錠刀】令傷害 +1。`);
  }
  // 裸衣：本回合【殺】與【決鬥】傷害 +1。
  if (
    source &&
    source.marks.luoyi &&
    cardName &&
    (isSlashCard(cardName) || cardName === 'duel') &&
    !fromChain
  ) {
    amount += 1;
    notes.push(`${nameOf(state, source.id)} 的【裸衣】令傷害 +1。`);
  }
  if (!ignoreArmor && target.equips.armor?.name === 'vine_armor' && nature === 'fire') {
    amount += 1;
    notes.push(`${nameOf(state, target.id)} 的【藤甲】令火焰傷害 +1。`);
  }
  if (!ignoreArmor && target.equips.armor?.name === 'silver_lion' && amount > 1) {
    amount = 1;
    notes.push(`${nameOf(state, target.id)} 的【白銀獅子】將傷害限制為 1。`);
  }
  return { amount, notes };
}

function* dealDamage(
  state: GameState,
  options: DamageOptions,
): Generator<Request, void, Response> {
  const { sourceId, targetId, nature, card, reason } = options;
  const target = state.players[targetId];
  if (!target || !target.alive) return;
  const source = sourceId === null ? null : state.players[sourceId];

  emitTiming('beforeDamage', {
    state,
    source: sourceId,
    target: targetId,
    card,
    amount: options.amount,
  });

  const damageCardName = options.cardName ?? card?.name;
  const preview = previewDamageAmount(
    state,
    source,
    target,
    options.amount,
    damageCardName,
    nature,
    options.ignoreArmor ?? false,
    options.fromChain ?? false,
  );
  const amount = preview.amount;
  for (const note of preview.notes) log(state, 'damage', note);

  if (amount <= 0) {
    emitTiming('afterDamage', { state, source: sourceId, target: targetId, card, amount: 0 });
    return;
  }

  target.hp -= amount;
  const sourceName = source ? nameOf(state, source.id) : '未知來源';
  log(
    state,
    'damage',
    `${sourceName} 對 ${nameOf(state, target.id)} 造成 ${amount} 點${natureLabel(nature)}傷害（${reason}）。`,
  );
  recordEvent(state, {
    kind: 'damage',
    source: sourceId,
    target: target.id,
    cardName: damageCardName,
    amount,
    fromChain: options.fromChain,
    forcedBy: options.forcedBy,
    redirectedBy: options.redirectedBy,
  });

  // 奸雄：受到傷害後，可獲得造成此傷害的牌。
  if (hasSkill(target, 'jianxiong')) {
    const causes = options.cards ?? (card ? [card] : []);
    const available = causes.filter((item) =>
      state.discard.some((entry) => entry.id === item.id),
    );
    if (available.length > 0) {
      const chosen = yield* askResponse(
        state,
        target,
        'choice',
        [{
          id: 'jianxiong',
          label: `奸雄：獲得 ${available.map((item) => `【${cardLabel(item.name)}】`).join('')}`,
          kind: 'skill',
          cards: available.map((item) => item.id),
          skill: 'jianxiong',
        }],
        '是否發動【奸雄】？',
        '奸雄',
      );
      if (chosen) {
        const taken: Card[] = [];
        for (const item of available) {
          const index = state.discard.findIndex((entry) => entry.id === item.id);
          if (index >= 0) taken.push(...state.discard.splice(index, 1));
        }
        target.hand.push(...taken);
        log(
          state,
          'damage',
          `${nameOf(state, target.id)} 的【奸雄】獲得了 ${taken.map((item) => `【${cardLabel(item.name)}】`).join('')}。`,
        );
      }
    }
  }

  // 遺計：每受到 1 點傷害後，觀看牌堆頂兩張並分配給任意角色。
  if (hasSkill(target, 'yiji')) {
    for (let point = 0; point < amount; point += 1) {
      const chosen = yield* askResponse(
        state,
        target,
        'choice',
        [{ id: 'yiji', label: '遺計：觀看牌堆頂兩張並分配', kind: 'skill', cards: [], skill: 'yiji' }],
        '是否發動【遺計】？',
        '遺計',
      );
      if (!chosen) continue;

      const revealed = takeFromDeck(state, 2);
      if (revealed.length === 0) break;
      log(
        state,
        'draw',
        `${nameOf(state, target.id)} 發動【遺計】，觀看牌堆頂 ${revealed.length} 張並分配。`,
      );

      const remaining = [...revealed];
      while (remaining.length > 0) {
        const picked = yield* askRevealed(
          state,
          target,
          remaining,
          `遺計：選擇要交出的牌（剩餘 ${remaining.length} 張）`,
        );
        if (!picked) break;
        const index = remaining.findIndex((card) => card.id === picked.id);
        if (index >= 0) remaining.splice(index, 1);

        const candidates = state.players.filter((player) => player.alive).map((player) => player.id);
        const recipients = yield* askPlayers(
          state,
          target,
          candidates,
          1,
          1,
          '遺計',
          `遺計：選擇獲得【${cardLabel(picked.name)}】的角色`,
        );
        const recipient = recipients[0] === undefined ? null : state.players[recipients[0]] ?? null;
        if (!recipient) {
          remaining.splice(index, 0, picked);
          break;
        }
        const brokeKongcheng =
          recipient.id !== target.id &&
          hasSkill(recipient, 'kongcheng') &&
          recipient.hand.length === 0;
        recipient.hand.push(picked);
        if (recipient.id !== target.id) {
          recordEvent(state, {
            kind: 'give',
            source: target.id,
            target: recipient.id,
            skill: 'yiji',
            amount: 1,
            brokeKongcheng,
          });
        }
        log(
          state,
          'draw',
          `${nameOf(state, target.id)} 的【遺計】將一張牌交給 ${nameOf(state, recipient.id)}。`,
        );
      }
      // 未被分配的牌進入棄牌堆。
      pushDiscard(state, remaining);
    }
  }

  // 反饋：受到傷害後，可獲得來源的一張牌。
  if (hasSkill(target, 'fankui') && source && source.alive && hasAnyCard(source)) {
    const chosen = yield* askResponse(
      state,
      target,
      'choice',
      [{ id: 'fankui', label: `反饋：獲得 ${nameOf(state, source.id)} 的一張牌`, kind: 'skill', cards: [], skill: 'fankui', targets: [source.id] }],
      '是否發動【反饋】？',
      '反饋',
    );
    if (chosen) {
      const card = yield* askCardFrom(
        state,
        target,
        source,
        '反饋',
        `選擇要獲得 ${nameOf(state, source.id)} 的一張牌`,
      );
      if (card) {
        const removed = removeCardFromPlayer(state, source, card.id, true);
        target.hand.push(removed);
        log(state, 'damage', `${nameOf(state, target.id)} 的【反饋】獲得了 ${nameOf(state, source.id)} 的一張牌。`);
      }
    }
  }

  // 剛烈：受到傷害後可判定，非紅桃則來源棄兩張手牌或受 1 點傷害。
  if (hasSkill(target, 'ganglie') && source && source.alive && source.id !== target.id) {
    const chosen = yield* askResponse(
      state,
      target,
      'choice',
      [{ id: 'ganglie', label: `剛烈：判定並反擊 ${nameOf(state, source.id)}`, kind: 'skill', cards: [], skill: 'ganglie', targets: [source.id] }],
      '是否發動【剛烈】？',
      '剛烈',
    );
    if (chosen) {
      const judged = yield* judge(state, target, '剛烈');
      if (judged && judged.suit !== 'heart') {
        const attacker = source;
        if (attacker.hand.length >= 2) {
          const pick = yield* askRequiredOption(
            state,
            attacker,
            'choice',
            [
              { id: 'discard', label: '棄置兩張手牌', kind: 'skill', cards: [], skill: 'discard' },
              { id: 'damage', label: '受到 1 點傷害', kind: 'skill', cards: [], skill: 'damage' },
            ],
            `剛烈：請選擇一項`,
            '剛烈',
          );
          if (pick.skill === 'damage') {
            yield* dealDamage(state, {
              sourceId: target.id,
              targetId: attacker.id,
              amount: 1,
              nature: 'normal',
              card: null,
              reason: '剛烈',
            });
          } else {
            const ids = yield* askCards(
              state,
              attacker,
              attacker.hand.map((card) => card.id),
              2,
              2,
              '剛烈',
              '選擇兩張手牌棄置',
            );
            discardFromHand(state, attacker, ids, '剛烈');
          }
        } else {
          yield* dealDamage(state, {
            sourceId: target.id,
            targetId: attacker.id,
            amount: 1,
            nature: 'normal',
            card: null,
            reason: '剛烈',
          });
        }
      } else {
        log(state, 'judge', `【剛烈】判定為紅桃，未生效。`);
      }
    }
  }

  const wasChained = target.chained;
  if (wasChained && nature !== 'normal') target.chained = false;

  if (target.hp <= 0) {
    emitTiming('dying', { state, source: sourceId, target: target.id });
    const saved = yield* runDying(state, target);
    if (!saved) {
      yield* killPlayer(state, target, sourceId, {
        forcedBy: options.forcedBy,
        redirectedBy: options.redirectedBy,
      });
    }
  }

  // 鐵索連環：屬性傷害傳導。同一條連鎖中每個角色只傳導一次，
  // 且傳導造成的傷害不再往外傳導（避免 A→B→C 的連鎖串接）。
  if (wasChained && nature !== 'normal' && !options.fromChain) {
    const chainSet = options.chainSet ?? new Set<PlayerId>();
    chainSet.add(target.id);
    log(state, 'damage', `${nameOf(state, target.id)} 的鐵索連環被觸發。`);
    for (const other of aliveInSeatOrder(state)) {
      if (other.id === target.id || !other.chained || chainSet.has(other.id)) continue;
      other.chained = false;
      chainSet.add(other.id);
      log(
        state,
        'damage',
        `鐵索連環傳導至 ${nameOf(state, other.id)}（${amount} 點${natureLabel(nature)}傷害）。`,
      );
      yield* dealDamage(state, {
        sourceId,
        targetId: other.id,
        amount,
        nature,
        card,
        reason: `${reason}（鐵索傳導）`,
        ignoreArmor: options.ignoreArmor,
        fromChain: true,
        chainSet,
        forcedBy: options.forcedBy,
        redirectedBy: options.redirectedBy,
      });
    }
  }

  emitTiming('afterDamage', {
    state,
    source: sourceId,
    target: targetId,
    card,
    amount,
  });
}

function getSaveOptions(
  state: GameState,
  responder: PlayerState,
  dying: PlayerState,
): ResponseOption[] {
  const options: ResponseOption[] = [];
  for (const card of responder.hand) {
    if (card.name === 'peach') {
      options.push({
        id: `peach:${card.id}`,
        label: '使用【桃】',
        kind: 'respond',
        cards: [card.id],
        asCard: 'peach',
      });
    } else if (
      hasSkill(responder, 'jijiu') &&
      responder.id !== state.turn &&
      isRed(card)
    ) {
      options.push({
        id: `jijiu:${card.id}`,
        label: `急救：將 ${cardRef(card)} 當【桃】`,
        kind: 'respond',
        cards: [card.id],
        asCard: 'peach',
        skill: 'jijiu',
      });
    } else if (card.name === 'wine' && responder.id === dying.id) {
      options.push({
        id: `wine:${card.id}`,
        label: '使用【酒】自救',
        kind: 'respond',
        cards: [card.id],
        asCard: 'wine',
      });
    }
  }
  return options;
}

function* runDying(
  state: GameState,
  dying: PlayerState,
): Generator<Request, boolean, Response> {
  if (dying.hp > 0) return true;
  log(state, 'system', `${nameOf(state, dying.id)} 進入瀕死狀態（體力 ${dying.hp}）。`);

  // 官方：瀕死求桃從當前回合角色開始，逆時針依序詢問；若當前回合角色已不存在則退回瀕死者。
  const turnOrder = turnOrderFrom(state, state.turn);
  const order = turnOrder.length > 0 ? turnOrder : turnOrderFrom(state, dying.id);
  for (const responder of order) {
    if (!responder.alive) continue;
    while (dying.hp <= 0) {
      const options = getSaveOptions(state, responder, dying);
      if (options.length === 0) break;
      const chosen = yield* askResponse(
        state,
        responder,
        'peach',
        options,
        `是否救助 ${nameOf(state, dying.id)}？`,
        '瀕死',
      );
      if (!chosen) break;

      const cards = takeFromHand(state, responder, chosen.cards);
      const card = cards[0];
      if (!card) break;
      pushDiscard(state, cards);
      const virtualName = chosen.asCard ?? card.name;
      log(
        state,
        'play',
        `${nameOf(state, responder.id)} ${chosen.skill === 'jijiu' ? '發動【急救】，' : ''}對 ${nameOf(state, dying.id)} 使用【${cardLabel(virtualName)}】。`,
      );
      const isPeach = virtualName === 'peach';
      const rescueBonus =
        isPeach &&
        dying.role === 'lord' &&
        hasSkill(dying, 'jiuyuan') &&
        generalOf(responder).kingdom === 'wu'
          ? 1
          : 0;
      if (rescueBonus > 0) {
        log(state, 'heal', `${nameOf(state, dying.id)} 的【救援】令此【桃】回復值 +1。`);
      }
      heal(state, dying, 1 + rescueBonus, cardLabel(virtualName));
      recordEvent(state, {
        kind: 'save',
        source: responder.id,
        target: dying.id,
        cardName: virtualName,
      });
      if (dying.hp > 0) return true;
    }
    if (dying.hp > 0) return true;
  }
  return false;
}

function* killPlayer(
  state: GameState,
  victim: PlayerState,
  killerId: PlayerId | null,
  cause: { forcedBy?: PlayerId; redirectedBy?: PlayerId } = {},
): Generator<Request, void, Response> {
  if (!victim.alive) return;

  victim.alive = false;
  victim.hp = 0;
  emitTiming('death', { state, source: killerId, target: victim.id });
  log(
    state,
    'death',
    `${nameOf(state, victim.id)} 死亡，身份是${ROLE_LABELS[victim.role] ?? victim.role}。`,
  );
  recordEvent(state, {
    kind: 'death',
    source: killerId,
    target: victim.id,
    role: victim.role,
    forcedBy: cause.forcedBy,
    redirectedBy: cause.redirectedBy,
  });

  discardAllCards(state, victim, `${nameOf(state, victim.id)} 死亡棄牌`, false);

  if (killerId !== null && killerId !== victim.id) {
    const killer = state.players[killerId];
    if (killer?.alive) {
      if (victim.role === 'rebel') {
        log(state, 'system', `${nameOf(state, killer.id)} 擊殺反賊，摸 3 張牌。`);
        drawCards(state, killer, 3);
      }
      if (victim.role === 'loyal' && killer.role === 'lord') {
        log(state, 'system', `主公 ${nameOf(state, killer.id)} 誤殺忠臣，棄置所有手牌與裝備牌。`);
        // 官方規則：只棄手牌與裝備，判定區的延時錦囊不受影響。
        discardHandAndEquips(state, killer, '主公誤殺忠臣', true);
      }
    }
  }

  checkWinner(state);
  log(state, 'system', `${nameOf(state, victim.id)} 退出遊戲。`);
}

/* ------------------------------------------------------------------ */
/* 棄牌、裝備                                                          */
/* ------------------------------------------------------------------ */

function* runDiscardPhase(
  state: GameState,
  player: PlayerState,
): Generator<Request, void, Response> {
  // 克己：出牌階段未使用或打出【殺】，可跳過棄牌階段。
  if (hasSkill(player, 'keji') && !player.marks.slash_played) {
    log(state, 'phase', `${nameOf(state, player.id)} 的【克己】跳過棄牌階段。`);
    return;
  }
  const excess = player.hand.length - handLimit(player);
  if (excess <= 0) return;
  const chosen = yield* askCards(
    state,
    player,
    player.hand.map((card) => card.id),
    excess,
    excess,
    '棄牌階段',
    `請棄置 ${excess} 張手牌`,
  );
  discardFromHand(state, player, chosen, '棄牌階段');
}

function equipCard(state: GameState, player: PlayerState, card: Card): void {
  const meta = CARD_META[card.name];
  if (meta.type !== 'equip' || !meta.subtype) {
    throw new Error(`Not an equipment card: ${card.name}`);
  }

  const key: keyof EquipState =
    meta.subtype === 'horse_plus'
      ? 'horsePlus'
      : meta.subtype === 'horse_minus'
        ? 'horseMinus'
        : meta.subtype;

  const old = player.equips[key];
  if (old) {
    const removed = removeCardFromPlayer(state, player, old.id, true);
    pushDiscard(state, [removed]);
    log(state, 'equip', `${nameOf(state, player.id)} 棄置舊裝備【${cardLabel(removed.name)}】。`);
  }

  player.equips[key] = card;
  log(state, 'equip', `${nameOf(state, player.id)} 裝備【${cardLabel(card.name)}】。`);
}

/* ------------------------------------------------------------------ */
/* 回合流程                                                            */
/* ------------------------------------------------------------------ */

function* runPlayPhase(
  state: GameState,
  player: PlayerState,
): Generator<Request, void, Response> {
  let requests = 0;
  while (!state.winner && player.alive) {
    requests += 1;
    if (requests > MAX_REQUESTS_PER_TURN) {
      setWinner(state, [], '單一階段請求過多，判定為死循環');
      return;
    }
    const option = yield* askAction(state, player);
    if (option.kind === 'pass') break;
    yield* resolvePlayOption(state, player, option);
  }
}

function* runTurn(state: GameState, player: PlayerState): Generator<Request, void, Response> {
  state.turn = player.id;
  state.phase = 'prepare';
  player.slashUsed = 0;
  player.wineUsed = false;
  player.wine = false;
  // 技能標記皆為單回合有效（仁德、制衡、離間、青囊）。
  player.marks = {};
  emitTiming('phaseStart', { state, phase: 'prepare', target: player.id });

  // 準備階段技能：觀星、洛神。
  if (hasSkill(player, 'guanxing')) yield* resolveGuanxing(state, player);
  if (hasSkill(player, 'luoshen')) yield* resolveLuoshen(state, player);
  if (state.winner || !player.alive) return;

  log(state, 'phase', `── ${nameOf(state, player.id)} 的回合 ──`);

  state.phase = 'judge';
  emitTiming('phaseStart', { state, phase: 'judge', target: player.id });
  const outcome = yield* runJudgePhase(state, player);
  emitTiming('phaseEnd', { state, phase: 'judge', target: player.id });
  if (state.winner || !player.alive) return;

  state.phase = 'draw';
  emitTiming('phaseStart', { state, phase: 'draw', target: player.id });
  if (outcome.skipDraw) {
    log(state, 'phase', `${nameOf(state, player.id)} 跳過摸牌階段。`);
  } else {
    let replaced = false;
    // 突襲：放棄摸牌，改為獲得至多兩名角色各一張手牌。
    if (hasSkill(player, 'tuxi')) {
      const chosen = yield* askResponse(
        state,
        player,
        'choice',
        [{
          id: 'tuxi',
          label: '突襲：放棄摸牌，改為獲得至多兩名角色各一張手牌',
          kind: 'skill',
          cards: [],
          skill: 'tuxi',
        }],
        '是否發動【突襲】？',
        '突襲',
      );
      if (chosen) {
        yield* resolveTuxi(state, player);
        replaced = true;
      }
    }
    let drawCount = 2 + (hasSkill(player, 'yingzi') ? 1 : 0);
    // 裸衣：少摸一張，本回合【殺】與【決鬥】傷害 +1。
    if (!replaced && hasSkill(player, 'luoyi')) {
      const chosen = yield* askResponse(
        state,
        player,
        'choice',
        [{
          id: 'luoyi',
          label: '裸衣：少摸一張牌，本回合【殺】與【決鬥】傷害 +1',
          kind: 'skill',
          cards: [],
          skill: 'luoyi',
        }],
        '是否發動【裸衣】？',
        '裸衣',
      );
      if (chosen) {
        drawCount -= 1;
        player.marks.luoyi = true;
        log(state, 'draw', `${nameOf(state, player.id)} 發動【裸衣】。`);
      }
    }
    if (!replaced) drawCards(state, player, Math.max(0, drawCount));
  }
  emitTiming('phaseEnd', { state, phase: 'draw', target: player.id });
  if (state.winner || !player.alive) return;

  state.phase = 'play';
  emitTiming('phaseStart', { state, phase: 'play', target: player.id });
  if (outcome.skipPlay) {
    log(state, 'phase', `${nameOf(state, player.id)} 跳過出牌階段。`);
  } else {
    yield* runPlayPhase(state, player);
  }
  emitTiming('phaseEnd', { state, phase: 'play', target: player.id });
  if (state.winner || !player.alive) return;

  state.phase = 'discard';
  emitTiming('phaseStart', { state, phase: 'discard', target: player.id });
  yield* runDiscardPhase(state, player);
  emitTiming('phaseEnd', { state, phase: 'discard', target: player.id });
  if (state.winner || !player.alive) return;

  state.phase = 'end';
  emitTiming('phaseStart', { state, phase: 'end', target: player.id });
  // 閉月：結束階段開始時摸一張。
  if (hasSkill(player, 'biyue')) {
    drawCards(state, player, 1);
    log(state, 'draw', `${nameOf(state, player.id)} 的【閉月】摸 1 張牌。`);
  }
  emitTiming('phaseEnd', { state, phase: 'end', target: player.id });
  log(state, 'phase', `${nameOf(state, player.id)} 的回合結束。`);
}

export function* runGame(state: GameState): Generator<Request, GameResult, Response> {
  while (!state.winner) {
    const player = currentPlayer(state);
    if (!player.alive) {
      advanceTurn(state);
      continue;
    }

    yield* runTurn(state, player);
    if (state.winner) break;

    advanceTurn(state);
    if (state.turnCount > MAX_TURNS) {
      setWinner(state, [], '超過最大回合數，平局');
      break;
    }
  }

  return {
    winner: state.winner ?? { roles: [], reason: '未知結果' },
    turns: state.turnCount,
    log: state.log,
  };
}

/* ------------------------------------------------------------------ */
/* 顯示工具                                                            */
/* ------------------------------------------------------------------ */

export function suitSymbol(suit: Card['suit']): string {
  switch (suit) {
    case 'spade':
      return '♠';
    case 'heart':
      return '♥';
    case 'club':
      return '♣';
    case 'diamond':
      return '♦';
    default:
      return '?';
  }
}

export function suitLabel(suit: Card['suit']): string {
  switch (suit) {
    case 'spade':
      return '黑桃';
    case 'heart':
      return '紅桃';
    case 'club':
      return '梅花';
    case 'diamond':
      return '方塊';
    default:
      return '未知';
  }
}

export function rankLabel(rank: Card['rank']): string {
  switch (rank) {
    case 1:
      return 'A';
    case 11:
      return 'J';
    case 12:
      return 'Q';
    case 13:
      return 'K';
    default:
      return String(rank);
  }
}

function natureLabel(nature: Nature): string {
  switch (nature) {
    case 'fire':
      return '火焰';
    case 'thunder':
      return '雷電';
    default:
      return '';
  }
}

export function allCardsInPlay(state: GameState): Card[] {
  return [...state.deck, ...state.discard, ...state.players.flatMap((player) => allCardsOf(player))];
}
