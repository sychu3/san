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
  checkWinner,
  currentPlayer,
  discardAllCards,
  discardFromHand,
  drawCards,
  generalOf,
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

const MAX_TURNS = 500;
const MAX_NULLIFICATION_CHAIN = 16;
const MAX_REQUESTS_PER_TURN = 4000;

/* ------------------------------------------------------------------ */
/* 請求工具                                                            */
/* ------------------------------------------------------------------ */

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
): Generator<Request, Card | null, Response> {
  const visible: Card[] = [];
  for (const slot of ['weapon', 'armor', 'horsePlus', 'horseMinus'] as const) {
    const card = target.equips[slot];
    if (card) visible.push(card);
  }
  visible.push(...target.judgeZone);

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

function takeFromHand(_state: GameState, player: PlayerState, ids: readonly number[]): Card[] {
  const cards: Card[] = [];
  for (const id of ids) {
    const index = player.hand.findIndex((card) => card.id === id);
    if (index < 0) throw new Error(`Card ${id} is not in hand`);
    cards.push(player.hand.splice(index, 1)[0]!);
  }
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
        (target) => target.id !== player.id && inAttackRange(state, player.id, target.id),
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
        if (distance(state, player.id, target.id) > 1) continue;
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
        if (target.id === player.id) continue;
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
        if (target.id === player.id) continue;
        if (target.judgeZone.some((item) => item.name === 'indulgence')) continue;
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
        if (distance(state, player.id, target.id) > 1) continue;
        if (target.judgeZone.some((item) => item.name === 'supply_shortage')) continue;
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
      if (player.judgeZone.some((item) => item.name === 'lightning')) continue;
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

  // 丈八蛇矛：任意兩張手牌可當【殺】使用。
  // 選項只列目標；實際的兩張牌在選定目標後才詢問，避免手牌多時選項平方成長。
  if (player.equips.weapon?.name === 'serpent_spear' && !slashLimitReached(player) && player.hand.length >= 2) {
    for (const target of alive) {
      if (target.id === player.id || !inAttackRange(state, player.id, target.id)) continue;
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
    );
    cards = takeFromHand(state, player, ids);
  } else {
    cards = takeFromHand(state, player, option.cards);
  }
  const primary = cards[0];
  if (!primary) throw new Error('No card selected');

  if (CARD_META[primary.name].type === 'equip') {
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

  const meta = CARD_META[virtualName];

  // 延時錦囊進入判定區，不是棄牌堆。
  if (meta.type === 'delayed') {
    const target = targets[0] ?? player;
    target.judgeZone.push(primary);
    log(state, 'judge', `【${cardLabel(virtualName)}】置入 ${nameOf(state, target.id)} 的判定區。`);
    for (const card of cards.slice(1)) pushDiscard(state, [card]);
    emitTiming('afterUseCard', { state, use, source: player.id });
    return;
  }

  pushDiscard(state, cards);

  // 錦囊結算前開啟無懈可擊窗口。
  if (meta.type === 'trick') {
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
      let current = target;
      let other = player;
      while (current.alive && other.alive && !state.winner) {
        const played = yield* askForSha(state, current, '【決鬥】');
        if (!played) {
          yield* dealDamage(state, {
            sourceId: other.id,
            targetId: current.id,
            amount: 1,
            nature: 'normal',
            card: use.card,
            reason: '決鬥',
          });
          break;
        }
        const next = other;
        other = current;
        current = next;
      }
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
        if (target.alive) heal(state, target, 1, '桃園結義');
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
        ), { bonus: 0 });
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
/* 殺、閃、無懈                                                        */
/* ------------------------------------------------------------------ */

interface ShaPlay {
  card: Card;
  cards: Card[];
  name: CardName;
  skill?: string;
}

function getShaOptions(
  state: GameState,
  player: PlayerState,
  target?: PlayerState,
): ResponseOption[] {
  const options: ResponseOption[] = [];
  if (target && !inAttackRange(state, player.id, target.id)) return options;
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
  return options;
}

function* askForSha(
  state: GameState,
  player: PlayerState,
  context: string,
  target?: PlayerState,
): Generator<Request, ShaPlay | null, Response> {
  const options = getShaOptions(state, player, target);
  if (options.length === 0) return null;
  const chosen = yield* askResponse(
    state,
    player,
    'sha',
    options,
    '是否打出【殺】？',
    context,
  );
  if (!chosen) return null;
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
    );
    cards = takeFromHand(state, player, ids);
  } else {
    cards = takeFromHand(state, player, chosen.cards);
  }
  if (cards.length === 0) return null;
  pushDiscard(state, cards);
  const name = chosen.asCard ?? cards[0]!.name;
  log(
    state,
    'play',
    `${nameOf(state, player.id)} 打出【${cardLabel(name)}】${chosen.skill === 'serpent_spear' ? '（丈八蛇矛）' : ''}。`,
  );
  return { card: cards[0]!, cards, name, skill: chosen.skill };
}

function getShanOptions(player: PlayerState, allowBagua: boolean): ResponseOption[] {
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
  if (allowBagua && player.equips.armor?.name === 'eight_diagram') {
    options.push({
      id: 'bagua',
      label: '八卦陣（判定，紅色視為【閃】）',
      kind: 'skill',
      cards: [],
      skill: 'bagua',
    });
  }
  return options;
}

function* askForShan(
  state: GameState,
  target: PlayerState,
  context: string,
  allowBagua = true,
): Generator<Request, boolean, Response> {
  const options = getShanOptions(target, allowBagua);
  const chosen = yield* askResponse(
    state,
    target,
    'shan',
    options,
    '是否打出【閃】？',
    context,
  );
  if (!chosen) return false;

  if (chosen.skill === 'bagua') {
    const judged = judgeCard(state, target, '八卦陣');
    if (judged && isRed(judged)) {
      log(state, 'play', `${nameOf(state, target.id)} 的【八卦陣】判定成功，視為打出【閃】。`);
      return true;
    }
    log(state, 'play', `${nameOf(state, target.id)} 的【八卦陣】判定失敗。`);
    return yield* askForShan(state, target, context, false);
  }

  const cards = takeFromHand(state, target, chosen.cards);
  const card = cards[0];
  if (!card) return false;
  pushDiscard(state, cards);
  log(state, 'play', `${nameOf(state, target.id)} 打出【${cardLabel(card.name)}】。`);
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
 */
function* askNullification(
  state: GameState,
  use: CardUse,
): Generator<Request, boolean, Response> {
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
        `是否對【${useLabel(use)}】使用【無懈可擊】？`,
        '無懈可擊',
        {
          cardName: use.name,
          source: use.source,
          targets: use.targets,
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
          `${nameOf(state, responder.id)} 對【${useLabel(use)}】使用【無懈可擊】（連鎖 ${count}）。`,
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
  let bonus = extra.bonus ?? 0;
  let noDodge = extra.noDodge ?? false;
  const ignoreArmor = extra.ignoreArmor ?? weapon === 'qinggang';

  // 貫石斧：使用【殺】時可棄兩張手牌，令此【殺】不可被【閃】抵消且傷害 +1。
  if (!extra.fromWeapon && weapon === 'rock_axe' && source.hand.length >= 2) {
    const chosen = yield* askResponse(
      state,
      source,
      'choice',
      [{
        id: 'rock_axe',
        label: '貫石斧：棄置 2 張手牌，令此【殺】不可被【閃】抵消且傷害 +1',
        kind: 'skill',
        cards: [],
        skill: 'rock_axe',
        targets: [target.id],
      }],
      '是否發動【貫石斧】？',
      '貫石斧',
    );
    if (chosen) {
      const discarded = yield* askCards(
        state,
        source,
        source.hand.map((card) => card.id),
        2,
        2,
        '貫石斧',
        '棄置 2 張手牌',
      );
      discardFromHand(state, source, discarded, '貫石斧');
      bonus += 1;
      noDodge = true;
      log(state, 'play', `${nameOf(state, source.id)} 發動【貫石斧】，此【殺】不可被【閃】抵消且傷害 +1。`);
    }
  }

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

  if (!noDodge) {
    const dodged = yield* askForShan(
      state,
      target,
      `【${cardLabel(use.name)}】`,
      !ignoreArmor,
    );
    if (dodged) {
      log(state, 'play', `${nameOf(state, target.id)} 抵消了【${cardLabel(use.name)}】。`);

      // 青龍偃月刀：被【閃】抵消時，可再使用一張【殺】。
      if (!extra.fromWeapon && weapon === 'green_dragon') {
        const slashOptions = getShaOptions(state, source, target);
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
      }
      return;
    }
  }

  // 寒冰劍：造成傷害時，可防止傷害並棄置目標兩張牌。
  if (!extra.fromWeapon && weapon === 'ice_sword' && hasAnyCard(target)) {
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
    );
    if (chosen) {
      const count = Math.min(2, allCardsOf(target).length);
      const discarded: Card[] = [];
      for (let i = 0; i < count; i += 1) {
        const card = yield* askCardFrom(
          state,
          source,
          target,
          '寒冰劍',
          `選擇要棄置 ${nameOf(state, target.id)} 的第 ${i + 1} 張牌`,
        );
        if (!card) break;
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
    cardName: use.name,
    reason: cardLabel(use.name),
    ignoreArmor,
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

function judgeCard(state: GameState, player: PlayerState, reason: string): Card | null {
  emitTiming('beforeJudge', { state, target: player.id });
  const [card] = takeFromDeck(state, 1);
  if (!card) return null;
  log(
    state,
    'judge',
    `${nameOf(state, player.id)} 判定（${reason}）：${cardLabel(card.name)} ${suitSymbol(card.suit)}${rankLabel(card.rank)}。`,
  );
  pushDiscard(state, [card]);
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
    const use = makeUse(state, player, [delayed], delayed.name, [player.id], 'judge');

    const negated = yield* askNullification(state, use);
    if (negated) {
      removeCardFromPlayer(state, player, delayed.id, false);
      pushDiscard(state, [delayed]);
      log(
        state,
        'judge',
        `${nameOf(state, player.id)} 判定區的【${cardLabel(delayed.name)}】被【無懈可擊】抵消。`,
      );
      continue;
    }

    const judged = judgeCard(state, player, cardLabel(delayed.name));
    if (!judged) break;

    removeCardFromPlayer(state, player, delayed.id, false);

    if (delayed.name === 'indulgence') {
      if (judged.suit !== 'heart') {
        outcome.skipPlay = true;
        log(state, 'judge', `【樂不思蜀】判定失敗，${nameOf(state, player.id)} 跳過出牌階段。`);
      } else {
        log(state, 'judge', `【樂不思蜀】判定成功，${nameOf(state, player.id)} 不受影響。`);
      }
      pushDiscard(state, [delayed]);
      continue;
    }

    if (delayed.name === 'supply_shortage') {
      if (judged.suit !== 'club') {
        outcome.skipDraw = true;
        log(state, 'judge', `【兵糧寸斷】判定失敗，${nameOf(state, player.id)} 跳過摸牌階段。`);
      } else {
        log(state, 'judge', `【兵糧寸斷】判定成功，${nameOf(state, player.id)} 不受影響。`);
      }
      pushDiscard(state, [delayed]);
      continue;
    }

    if (delayed.name === 'lightning') {
      const hit = judged.suit === 'spade' && judged.rank >= 2 && judged.rank <= 9;
      if (hit) {
        log(state, 'judge', `【閃電】命中，${nameOf(state, player.id)} 受到 3 點雷電傷害。`);
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
          pushDiscard(state, [delayed]);
          log(state, 'judge', '【閃電】未命中，且沒有其他角色可放置，進入棄牌堆。');
        }
      }
      continue;
    }

    // 未知延時錦囊：安全地棄置。
    pushDiscard(state, [delayed]);
  }

  return outcome;
}

function nextLightningHost(state: GameState, from: PlayerId): PlayerState | null {
  const order = turnOrderFrom(state, from).slice(1);
  for (const player of order) {
    if (!player.alive) continue;
    if (player.judgeZone.some((card) => card.name === 'lightning')) continue;
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
  /** 虛擬牌名；丈八蛇矛等轉化牌需要靠這個欄位判斷是否為【殺】。 */
  cardName?: CardName;
  reason: string;
  ignoreArmor?: boolean;
  fromChain?: boolean;
  chainSet?: Set<PlayerId>;
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

  let amount = options.amount;
  const damageCardName = options.cardName ?? card?.name;

  if (
    source &&
    damageCardName &&
    isSlashCard(damageCardName) &&
    source.equips.weapon?.name === 'ancient_scimitar' &&
    target.hand.length === 0 &&
    !options.fromChain
  ) {
    amount += 1;
    log(state, 'damage', `${nameOf(state, source.id)} 的【古錠刀】令傷害 +1。`);
  }

  if (!options.ignoreArmor && target.equips.armor?.name === 'vine_armor' && nature === 'fire') {
    amount += 1;
    log(state, 'damage', `${nameOf(state, target.id)} 的【藤甲】令火焰傷害 +1。`);
  }

  if (!options.ignoreArmor && target.equips.armor?.name === 'silver_lion' && amount > 1) {
    amount = 1;
    log(state, 'damage', `${nameOf(state, target.id)} 的【白銀獅子】將傷害限制為 1。`);
  }

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

  const wasChained = target.chained;
  if (wasChained && nature !== 'normal') target.chained = false;

  if (target.hp <= 0) {
    emitTiming('dying', { state, source: sourceId, target: target.id });
    const saved = yield* runDying(state, target);
    if (!saved) {
      yield* killPlayer(state, target, sourceId);
    }
  }

  // 鐵索連環：屬性傷害傳導。同一條連鎖中每個角色只傳導一次。
  if (wasChained && nature !== 'normal') {
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

  const order = turnOrderFrom(state, dying.id);
  for (const responder of order) {
    if (!responder.alive) continue;
    while (dying.hp <= 0) {
      const options = getSaveOptions(responder, dying);
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
      log(
        state,
        'play',
        `${nameOf(state, responder.id)} 對 ${nameOf(state, dying.id)} 使用【${cardLabel(card.name)}】。`,
      );
      heal(state, dying, 1, cardLabel(card.name));
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

  discardAllCards(state, victim, `${nameOf(state, victim.id)} 死亡棄牌`, false);

  if (killerId !== null && killerId !== victim.id) {
    const killer = state.players[killerId];
    if (killer?.alive) {
      if (victim.role === 'rebel') {
        log(state, 'system', `${nameOf(state, killer.id)} 擊殺反賊，摸 3 張牌。`);
        drawCards(state, killer, 3);
      }
      if (victim.role === 'loyal' && killer.role === 'lord') {
        log(state, 'system', `主公 ${nameOf(state, killer.id)} 誤殺忠臣，棄置所有牌。`);
        discardAllCards(state, killer, '主公誤殺忠臣', true);
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
  emitTiming('phaseStart', { state, phase: 'prepare', target: player.id });

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
    drawCards(state, player, 2);
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
