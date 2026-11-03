import type {
  Card,
  GameState,
  GameView,
  GeneralDef,
  LogKind,
  PlayerId,
  PlayerState,
  PlayerView,
  Request,
  Role,
  Winner,
} from './types';
import { createDeck } from '../data/cards';
import { cardLabel } from '../data/cardMeta';
import { ALL_GENERAL_IDS, getGeneral, ROLE_LABELS } from '../data/generals';
import { randomSeed, shuffle } from './rng';
import { nextAliveId } from './rules';
import { hasSkill, skillsOf } from './skills';

export const GAME_VERSION = '0.6.0-m5';

export interface CreateGameOptions {
  seed?: number;
  pool?: 'm1' | 'full';
  generalIds?: readonly string[];
  /** 人類玩家的座位；搭配 `humanGeneralId` 使用。 */
  humanId?: PlayerId;
  /**
   * 人類玩家在開局前選定的武將，必須在 `generalIds` 內。
   * 只把該武將換到人類座位，不消耗任何隨機數，
   * 因此同一 seed 的身份與牌堆順序不受選擇影響。
   */
  humanGeneralId?: string;
}

const FIVE_PLAYER_ROLES: readonly Role[] = ['lord', 'loyal', 'rebel', 'rebel', 'spy'];
const STARTING_HAND = 4;
const LOG_LIMIT = 500;

export function nameOf(state: GameState, id: PlayerId): string {
  const player = state.players[id];
  if (!player) return `玩家${id + 1}`;
  return getGeneral(player.generalId).name;
}

export function currentPlayer(state: GameState): PlayerState {
  const player = state.players[state.turn];
  if (!player) throw new Error(`Invalid turn: ${state.turn}`);
  return player;
}

export function log(state: GameState, kind: LogKind, text: string): void {
  state.logSeq += 1;
  state.log.push({ seq: state.logSeq, kind, text });
  if (state.log.length > LOG_LIMIT) {
    state.log.splice(0, state.log.length - LOG_LIMIT);
  }
}

export function createGame(options: CreateGameOptions = {}): GameState {
  const seed = (options.seed ?? randomSeed()) >>> 0;
  const rng = { rngState: seed || 1 };
  const generalIds = options.generalIds ?? ALL_GENERAL_IDS;
  if (generalIds.length < 5) {
    throw new Error('至少需要 5 名武將');
  }

  const roles = shuffle([...FIVE_PLAYER_ROLES], rng);
  const generals = shuffle([...generalIds], rng);
  const deck = shuffle(createDeck(options.pool ?? 'full'), rng);

  // 人類選將：只交換座位上的武將，不動隨機數，讓身份與牌堆和預覽一致。
  if (options.humanId !== undefined && options.humanGeneralId !== undefined) {
    const humanId = options.humanId;
    if (!Number.isInteger(humanId) || humanId < 0 || humanId >= 5) {
      throw new Error(`不合法的人類座位：${humanId}`);
    }
    const chosenIndex = generals.indexOf(options.humanGeneralId);
    if (chosenIndex < 0) throw new Error(`未知的武將：${options.humanGeneralId}`);
    const displaced = generals[humanId]!;
    generals[humanId] = options.humanGeneralId;
    generals[chosenIndex] = displaced;
  }

  const players: PlayerState[] = [];
  for (let id = 0; id < 5; id += 1) {
    const role = roles[id]!;
    const general = getGeneral(generals[id]!);
    const maxHp = general.maxHp + (role === 'lord' ? 1 : 0);
    players.push({
      id,
      seat: id,
      generalId: general.id,
      role,
      hp: maxHp,
      maxHp,
      hand: [],
      equips: {
        weapon: null,
        armor: null,
        horsePlus: null,
        horseMinus: null,
      },
      judgeZone: [],
      chained: false,
      alive: true,
      wine: false,
      wineUsed: false,
      slashUsed: 0,
      marks: {},
    });
  }

  const lord = players.find((player) => player.role === 'lord');
  if (!lord) throw new Error('無法分配主公');

  const state: GameState = {
    version: GAME_VERSION,
    seed,
    rngState: rng.rngState,
    players,
    deck,
    discard: [],
    turn: lord.id,
    phase: 'prepare',
    turnCount: 1,
    winner: null,
    delayedNames: {},
    publicEvents: [],
    eventSeq: 0,
    log: [],
    logSeq: 0,
    requestSeq: 0,
    useSeq: 0,
    pending: null,
  };

  log(state, 'system', `遊戲開始。主公是 ${generalOf(lord).name}（玩家 ${lord.id + 1}）。`);
  log(state, 'system', `身份局 5 人：主公、忠臣、2 名反賊、內奸。主公體力上限 +1。`);

  for (const player of players) {
    const drawn = drawCards(state, player, STARTING_HAND, false);
    log(state, 'system', `${generalOf(player).name} 獲得 ${drawn.length} 張起始手牌。`);
  }

  log(state, 'system', `由主公 ${generalOf(lord).name} 先手。`);
  return state;
}

export function generalOf(player: PlayerState): GeneralDef {
  return getGeneral(player.generalId);
}

export function drawCards(
  state: GameState,
  player: PlayerState,
  count: number,
  announce = true,
): Card[] {
  const drawn: Card[] = [];
  for (let i = 0; i < count; i += 1) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) {
        state.winner = { roles: [], reason: '牌堆與棄牌堆耗盡，平局' };
        log(state, 'win', '牌堆與棄牌堆耗盡，遊戲平局。');
        break;
      }
      state.deck = shuffle(state.discard.splice(0), state);
      log(state, 'system', '棄牌堆已洗回牌堆。');
    }
    const card = state.deck.pop();
    if (!card) break;
    player.hand.push(card);
    drawn.push(card);
  }
  if (announce && drawn.length > 0) {
    log(state, 'draw', `${generalOf(player).name} 摸了 ${drawn.length} 張牌。`);
  }
  return drawn;
}

export function heal(
  state: GameState,
  player: PlayerState,
  amount: number,
  reason: string,
): void {
  if (!player.alive || amount <= 0) return;
  const before = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + amount);
  const healed = player.hp - before;
  if (healed > 0) {
    log(state, 'heal', `${generalOf(player).name} 回復 ${healed} 點體力（${reason}）。`);
  }
}

export function removeCardFromPlayer(
  state: GameState,
  player: PlayerState,
  cardId: number,
  triggerLoss = true,
): Card {
  const handIndex = player.hand.findIndex((card) => card.id === cardId);
  if (handIndex >= 0) {
    return player.hand.splice(handIndex, 1)[0]!;
  }

  const slots: Array<keyof PlayerState['equips']> = [
    'weapon',
    'armor',
    'horsePlus',
    'horseMinus',
  ];
  for (const slot of slots) {
    const card = player.equips[slot];
    if (card && card.id === cardId) {
      player.equips[slot] = null;
      if (triggerLoss && card.name === 'silver_lion' && player.alive) {
        heal(state, player, 1, '失去白銀獅子');
      }
      // 梟姬：失去裝備區的一張牌時摸兩張。
      if (triggerLoss && player.alive && hasSkill(player, 'xiaogi')) {
        drawCards(state, player, 2);
        log(state, 'draw', `${generalOf(player).name} 的【梟姬】摸 2 張牌。`);
      }
      return card;
    }
  }

  const judgeIndex = player.judgeZone.findIndex((card) => card.id === cardId);
  if (judgeIndex >= 0) {
    return player.judgeZone.splice(judgeIndex, 1)[0]!;
  }

  throw new Error(`Card ${cardId} not found on player ${player.id}`);
}

export function pushDiscard(state: GameState, cards: readonly Card[]): void {
  state.discard.push(...cards);
}

export function discardCards(state: GameState, cards: readonly Card[], reason: string): void {
  if (cards.length === 0) return;
  pushDiscard(state, cards);
  log(
    state,
    'play',
    `${reason}：${cards.map((card) => cardLabelOf(card)).join('、')} 進入棄牌堆。`,
  );
}

/** 棄置角色所有區域的牌；可選擇是否觸發「失去裝備」效果。 */
export function discardAllCards(
  state: GameState,
  player: PlayerState,
  reason: string,
  triggerLoss = true,
): void {
  const ids = allCardsOf(player).map((card) => card.id);
  const removed: Card[] = [];
  for (const id of ids) {
    removed.push(removeCardFromPlayer(state, player, id, triggerLoss));
  }
  discardCards(state, removed, reason);
}

export function discardFromHand(
  state: GameState,
  player: PlayerState,
  cardIds: readonly number[],
  reason: string,
): Card[] {
  const cards: Card[] = [];
  for (const cardId of cardIds) {
    const index = player.hand.findIndex((card) => card.id === cardId);
    if (index < 0) throw new Error(`Card ${cardId} is not in ${player.id}'s hand`);
    cards.push(player.hand.splice(index, 1)[0]!);
  }
  discardCards(state, cards, reason);
  return cards;
}

export function cardLabelOf(card: Card): string {
  return cardLabel(card.name);
}

export function setWinner(state: GameState, roles: Role[], reason: string): void {
  if (state.winner) return;
  state.winner = { roles, reason };
  const label = roles.length === 0 ? '平局' : roles.map((role) => ROLE_LABELS[role]).join('、');
  log(state, 'win', `遊戲結束：${label}勝。${reason}`);
}

export function checkWinner(state: GameState): void {
  if (state.winner) return;
  const lord = state.players.find((player) => player.role === 'lord');
  const alive = state.players.filter((player) => player.alive);
  if (!lord) return;

  if (!lord.alive) {
    const spyAlive = alive.length === 1 && alive[0]!.role === 'spy';
    if (spyAlive) {
      setWinner(state, ['spy'], '主公死亡，場上只剩內奸。');
    } else {
      setWinner(state, ['rebel'], '主公死亡。');
    }
    return;
  }

  const threatsAlive = alive.some(
    (player) => player.role === 'rebel' || player.role === 'spy',
  );
  if (!threatsAlive) {
    setWinner(state, ['lord', 'loyal'], '所有反賊與內奸均已死亡。');
  }
}

export function advanceTurn(state: GameState): void {
  const previous = state.players[state.turn];
  if (previous) {
    previous.wine = false;
    previous.wineUsed = false;
    previous.slashUsed = 0;
  }
  state.turn = nextAliveId(state, state.turn);
  state.turnCount += 1;
}

export function hasAnyCard(player: PlayerState): boolean {
  return (
    player.hand.length > 0 ||
    player.judgeZone.length > 0 ||
    Object.values(player.equips).some((card) => card !== null)
  );
}

export function allCardsOf(player: PlayerState): Card[] {
  return [
    ...player.hand,
    ...player.judgeZone,
    ...Object.values(player.equips).filter((card): card is Card => card !== null),
  ];
}

/** 手牌區與裝備區的牌（不含判定區）；供只能操作手牌／裝備的效果使用。 */
export function handAndEquips(player: PlayerState): Card[] {
  return [
    ...player.hand,
    ...Object.values(player.equips).filter((card): card is Card => card !== null),
  ];
}

function cloneRequest(request: Request): Request {
  if (request.kind === 'action') {
    return {
      ...request,
      options: request.options.map((option) => ({
        ...option,
        cards: [...option.cards],
        targets: [...option.targets],
      })),
    };
  }
  if (request.kind === 'response') {
    return {
      ...request,
      targets: request.targets ? [...request.targets] : undefined,
      options: request.options.map((option) => ({
        ...option,
        cards: [...option.cards],
        targets: option.targets ? [...option.targets] : undefined,
      })),
    };
  }
  if (request.kind === 'chooseCards') {
    return { ...request, cards: [...request.cards] };
  }
  if (request.kind === 'choosePlayers') {
    return { ...request, candidates: [...request.candidates] };
  }
  if (request.kind === 'chooseRevealed' || request.kind === 'chooseFrom') {
    return { ...request, cards: request.cards.map(snapshotCard) };
  }
  return { ...request };
}

function snapshotCard(card: Card): Card {
  return { ...card };
}

export function viewFor(state: GameState, viewerId: PlayerId, godMode = false): GameView {
  const players: PlayerView[] = state.players.map((player) => {
    const general = generalOf(player);
    // 對局結束後公開所有人的身份，方便復盤。
    const revealRole =
      godMode ||
      state.winner !== null ||
      player.id === viewerId ||
      player.role === 'lord' ||
      !player.alive;
    const isSelf = player.id === viewerId;
    return {
      id: player.id,
      seat: player.seat,
      name: general.name,
      generalName: general.name,
      skills: skillsOf(player).map((skill) => skill.id),
      kingdom: general.kingdom,
      gender: general.gender,
      maxHp: player.maxHp,
      hp: player.hp,
      role: revealRole ? player.role : null,
      alive: player.alive,
      handCount: player.hand.length,
      hand: isSelf || godMode ? player.hand.map(snapshotCard) : null,
      equips: {
        weapon: player.equips.weapon ? snapshotCard(player.equips.weapon) : null,
        armor: player.equips.armor ? snapshotCard(player.equips.armor) : null,
        horsePlus: player.equips.horsePlus ? snapshotCard(player.equips.horsePlus) : null,
        horseMinus: player.equips.horseMinus ? snapshotCard(player.equips.horseMinus) : null,
      },
      judgeZone: player.judgeZone.map((card) => ({
        ...card,
        name: state.delayedNames[card.id] ?? card.name,
      })),
      chained: player.chained,
      wine: player.wine,
      slashUsed: player.slashUsed,
    };
  });

  const pending =
    state.pending && (godMode || state.pending.player === viewerId)
      ? cloneRequest(state.pending)
      : null;

  return {
    seed: state.seed,
    turn: state.turn,
    phase: state.phase,
    turnCount: state.turnCount,
    players,
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    discardTop: state.discard.at(-1) ? snapshotCard(state.discard.at(-1)!) : null,
    events: state.publicEvents.slice(-200).map((event) => ({ ...event })),
    log: state.log.slice(-200).map((entry) => ({ ...entry })),
    pending,
    waitingFor: state.pending ? state.pending.player : null,
    winner: state.winner
      ? { roles: [...state.winner.roles], reason: state.winner.reason }
      : null,
    godMode,
  };
}

export function winnerText(winner: Winner | null): string {
  if (!winner) return '';
  if (winner.roles.length === 0) return '平局';
  return `${winner.roles.map((role) => ROLE_LABELS[role]).join('、')}勝`;
}
