import type {
  Card,
  EquipState,
  GameResult,
  GameState,
  PlayOption,
  PlayerId,
  PlayerState,
  Request,
  Response,
  ResponseOption,
  ResponseNeed,
} from './types';
import { CARD_META, cardLabel, cardMeta, isSlashCard } from '../data/cardMeta';
import { getCard } from '../data/cards';
import { ROLE_LABELS } from '../data/generals';
import {
  advanceTurn,
  allCardsOf,
  checkWinner,
  currentPlayer,
  discardAllCards,
  discardFromHand,
  drawCards,
  heal,
  log,
  hasAnyCard,
  nameOf,
  pushDiscard,
  removeCardFromPlayer,
  setWinner,
} from './state';
import {
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

const MAX_TURNS = 500;

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

function* askResponse(
  state: GameState,
  player: PlayerState,
  need: ResponseNeed,
  options: ResponseOption[],
  prompt: string,
  context: string,
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
  };
  const response = yield* ask(state, request);
  if (response.type === 'pass') return null;
  if (response.type !== 'option') throw new Error(`${context}: expected option response`);
  const option = all.find((item) => item.id === response.optionId);
  if (!option) throw new Error(`${context}: unknown response option`);
  if (option.kind === 'pass') return null;
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

/* ------------------------------------------------------------------ */
/* 出牌階段選項                                                        */
/* ------------------------------------------------------------------ */

export function getPlayOptions(state: GameState, player: PlayerState): PlayOption[] {
  const options: PlayOption[] = [];
  const add = (option: PlayOption) => {
    if (!options.some((item) => item.id === option.id)) options.push(option);
  };

  for (const card of player.hand) {
    const meta = CARD_META[card.name];
    const ref = `${cardLabel(card.name)} ${suitSymbol(card.suit)}${rankLabel(card.rank)}`;

    if (isSlashCard(card.name)) {
      if (slashLimitReached(player)) continue;
      const nature = cardMeta(card.name).nature ?? 'normal';
      for (const target of state.players) {
        if (target.id === player.id || !target.alive) continue;
        if (!inAttackRange(state, player.id, target.id)) continue;
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
      for (const target of state.players) {
        if (target.id === player.id || !target.alive || !hasAnyCard(target)) continue;
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
      for (const target of state.players) {
        if (target.id === player.id || !target.alive || !hasAnyCard(target)) continue;
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
  if (option.kind !== 'play') {
    // M1 未有主動技能。
    return;
  }

  const cards: Card[] = [];
  for (const id of option.cards) {
    const index = player.hand.findIndex((card) => card.id === id);
    if (index < 0) throw new Error(`Card ${id} is not in hand`);
    cards.push(player.hand.splice(index, 1)[0]!);
  }
  const primary = cards[0];
  if (!primary) throw new Error('No card selected');

  if (CARD_META[primary.name].type === 'equip') {
    equipCard(state, player, primary);
    return;
  }

  const virtualName = option.asCard ?? primary.name;
  const targets = option.targets
    .map((id) => state.players[id])
    .filter((target): target is PlayerState => Boolean(target));

  log(
    state,
    'play',
    `${nameOf(state, player.id)} 使用【${cardLabel(virtualName)}】${
      targets.length > 0
        ? `→ ${targets.map((target) => nameOf(state, target.id)).join('、')}`
        : ''
    }。`,
  );
  pushDiscard(state, cards);

  switch (virtualName) {
    case 'slash':
    case 'fire_slash':
    case 'thunder_slash': {
      const nature = option.nature ?? CARD_META[virtualName].nature ?? 'normal';
      let bonus = 0;
      if (player.wine) {
        bonus = 1;
        player.wine = false;
        log(state, 'play', `${nameOf(state, player.id)} 的酒意令此【殺】傷害 +1。`);
      }
      player.slashUsed += 1;
      for (const target of targets) {
        yield* resolveSlashTarget(state, player, target, primary, nature, bonus);
        if (state.winner) return;
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
        // 從手牌取得的牌只有獲得者知道；日誌不可洩漏給其他玩家。
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

    default: {
      log(state, 'system', `【${cardLabel(virtualName)}】尚未實作，牌已進入棄牌堆。`);
      break;
    }
  }
}

function* resolveSlashTarget(
  state: GameState,
  source: PlayerState,
  target: PlayerState,
  card: Card,
  nature: 'normal' | 'fire' | 'thunder',
  bonus: number,
): Generator<Request, void, Response> {
  if (!target.alive) return;

  if (target.equips.armor?.name === 'renwang' && isBlack(card)) {
    log(state, 'play', `${nameOf(state, target.id)} 的【仁王盾】令黑色【殺】無效。`);
    return;
  }

  if (target.equips.armor?.name === 'vine_armor' && nature === 'normal' && isSlashCard(card.name)) {
    log(state, 'play', `${nameOf(state, target.id)} 的【藤甲】令普通【殺】無效。`);
    return;
  }

  const dodged = yield* askForShan(state, target, `【${cardLabel(card.name)}】`);
  if (dodged) {
    log(state, 'play', `${nameOf(state, target.id)} 抵消了【${cardLabel(card.name)}】。`);
    return;
  }

  yield* dealDamage(state, source.id, target.id, 1 + bonus, nature, card, '殺');
}

function* askForShan(
  state: GameState,
  target: PlayerState,
  context: string,
  allowBagua = true,
): Generator<Request, boolean, Response> {
  const options: ResponseOption[] = [];
  for (const card of target.hand) {
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
  if (allowBagua && target.equips.armor?.name === 'eight_diagram') {
    options.push({
      id: 'bagua',
      label: '八卦陣（判定，紅色視為【閃】）',
      kind: 'skill',
      cards: [],
      skill: 'bagua',
    });
  }

  const chosen = yield* askResponse(
    state,
    target,
    'shan',
    options,
    `是否使用【閃】？`,
    context,
  );
  if (!chosen) return false;

  if (chosen.skill === 'bagua') {
    const judged = judge(state, target, '八卦陣');
    if (judged && isRed(judged)) {
      log(state, 'play', `${nameOf(state, target.id)} 的【八卦陣】判定成功，視為打出【閃】。`);
      return true;
    }
    log(state, 'play', `${nameOf(state, target.id)} 的【八卦陣】判定失敗。`);
    return yield* askForShan(state, target, context, false);
  }

  const card = getCard(chosen.cards[0]!);
  removeCardFromPlayer(state, target, card.id, false);
  pushDiscard(state, [card]);
  log(state, 'play', `${nameOf(state, target.id)} 打出【閃】。`);
  return true;
}

function judge(state: GameState, player: PlayerState, reason: string): Card | null {
  if (state.deck.length === 0) {
    if (state.discard.length === 0) {
      setWinner(state, [], '牌堆與棄牌堆耗盡，無法判定，平局');
      return null;
    }
    state.deck = shuffle(state.discard.splice(0), state);
    log(state, 'system', '棄牌堆已洗回牌堆。');
  }
  const card = state.deck.pop();
  if (!card) return null;
  log(
    state,
    'judge',
    `${nameOf(state, player.id)} 判定（${reason}）：${cardLabel(card.name)} ${suitSymbol(card.suit)}${rankLabel(card.rank)}。`,
  );
  pushDiscard(state, [card]);
  return card;
}

/* ------------------------------------------------------------------ */
/* 傷害、瀕死、死亡                                                    */
/* ------------------------------------------------------------------ */

function* dealDamage(
  state: GameState,
  sourceId: PlayerId | null,
  targetId: PlayerId,
  baseAmount: number,
  nature: 'normal' | 'fire' | 'thunder',
  card: Card | null,
  reason: string,
): Generator<Request, void, Response> {
  const target = state.players[targetId];
  if (!target || !target.alive) return;
  const source = sourceId === null ? null : state.players[sourceId];

  let amount = baseAmount;

  if (
    source &&
    card &&
    isSlashCard(card.name) &&
    source.equips.weapon?.name === 'ancient_scimitar' &&
    target.hand.length === 0
  ) {
    amount += 1;
    log(state, 'damage', `${nameOf(state, source.id)} 的【古錠刀】令傷害 +1。`);
  }

  if (target.equips.armor?.name === 'vine_armor' && nature === 'fire') {
    amount += 1;
    log(state, 'damage', `${nameOf(state, target.id)} 的【藤甲】令火焰傷害 +1。`);
  }

  if (target.equips.armor?.name === 'silver_lion' && amount > 1) {
    amount = 1;
    log(state, 'damage', `${nameOf(state, target.id)} 的【白銀獅子】將傷害限制為 1。`);
  }

  if (amount <= 0) return;

  target.hp -= amount;
  const sourceName = source ? nameOf(state, source.id) : '未知來源';
  log(
    state,
    'damage',
    `${sourceName} 對 ${nameOf(state, target.id)} 造成 ${amount} 點${natureLabel(nature)}傷害（${reason}）。`,
  );

  if (target.hp <= 0) {
    const saved = yield* runDying(state, target);
    if (!saved) {
      yield* killPlayer(state, target, sourceId);
      return;
    }
  }

  // 奸雄、反饋、剛烈、遺計等「受到傷害後」技能：M3 接入。
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

      const card = getCard(chosen.cards[0]!);
      removeCardFromPlayer(state, responder, card.id, false);
      pushDiscard(state, [card]);
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
  while (!state.winner && player.alive) {
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

  log(state, 'phase', `── ${nameOf(state, player.id)} 的回合 ──`);

  state.phase = 'judge';
  // M1 未有延時錦囊，判定階段直接略過。
  if (state.winner || !player.alive) return;

  state.phase = 'draw';
  drawCards(state, player, 2);
  if (state.winner || !player.alive) return;

  state.phase = 'play';
  yield* runPlayPhase(state, player);
  if (state.winner || !player.alive) return;

  state.phase = 'discard';
  yield* runDiscardPhase(state, player);
  if (state.winner || !player.alive) return;

  state.phase = 'end';
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

function natureLabel(nature: 'normal' | 'fire' | 'thunder'): string {
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
