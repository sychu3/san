import { describe, expect, it } from 'vitest';
import { createAiMemory, decide } from '../ai/policy';
import { createGame, viewFor } from '../engine/state';
import type {
  Card,
  CardName,
  GameState,
  PlayOption,
  PlayerId,
  Request,
  Response,
  ResponseOption,
} from '../engine/types';

function card(
  id: number,
  name: Card['name'],
  suit: Card['suit'] = 'spade',
  rank: Card['rank'] = 7,
): Card {
  return { id, name, suit, rank };
}

/** 玩家 0 是反賊，玩家 1 是主公（身份公開，AI 可直接判斷敵我）。 */
function fresh(seed = 3): GameState {
  const state = createGame({ seed });
  state.players.forEach((player, index) => {
    player.hand = [];
    player.judgeZone = [];
    player.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
    player.alive = true;
    player.hp = 4;
    player.maxHp = 4;
    player.role = index === 0 ? 'rebel' : index === 1 ? 'lord' : 'loyal';
  });
  return state;
}

describe('AI 拆牌判斷', () => {
  it('不會拆敵人判定區的兵糧寸斷，改為盲選對手手牌', () => {
    const state = fresh();
    state.players[1]!.judgeZone = [card(9001, 'supply_shortage', 'club', 4)];
    state.players[1]!.hand = [card(9002, 'peach'), card(9003, 'dodge')];

    const request: Request = {
      id: 1,
      player: 0,
      prompt: '選擇要棄置 劉備 的一張牌',
      kind: 'chooseCard',
      target: 1,
      cards: [9001],
      allowRandomHand: true,
      handCount: 2,
      reason: '過河拆橋',
    };
    state.pending = request;
    const view = viewFor(state, 0);

    const response = decide(view, request, { rngState: 1 });
    expect(response).toEqual({ type: 'card', card: -1 });
  });

  it('不會拆敵人判定區的樂不思蜀，但會拆敵人的裝備', () => {
    const state = fresh();
    state.players[1]!.judgeZone = [card(9004, 'indulgence', 'heart', 6)];
    state.players[1]!.equips.weapon = card(9005, 'crossbow', 'club', 1);
    state.players[1]!.hand = [card(9006, 'peach')];

    const request: Request = {
      id: 2,
      player: 0,
      prompt: '選擇要棄置 劉備 的一張牌',
      kind: 'chooseCard',
      target: 1,
      cards: [9004, 9005],
      allowRandomHand: true,
      handCount: 1,
      reason: '過河拆橋',
    };
    state.pending = request;
    const view = viewFor(state, 0);

    const response = decide(view, request, { rngState: 1 });
    expect(response).toEqual({ type: 'card', card: 9005 });
  });

  function wuxieRequest(
    source: PlayerId,
    targets: PlayerId[],
    cardName: CardName,
    nullificationCount: number,
  ): Request {
    const wuxie: ResponseOption = {
      id: 'wuxie',
      label: '無懈可擊',
      kind: 'respond',
      cards: [9900],
      asCard: 'nullification',
    };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    return {
      id: 9,
      player: 0,
      prompt: '是否使用【無懈可擊】？',
      kind: 'response',
      need: 'wuxie',
      options: [wuxie, pass],
      context: '無懈可擊',
      cardName,
      source,
      targets,
      nullificationCount,
    };
  }

  function countPlays(view: ReturnType<typeof viewFor>, request: Request): number {
    let played = 0;
    for (let rngState = 1; rngState <= 80; rngState += 1) {
      const response: Response = decide(view, request, { rngState });
      if (response.type === 'option') played += 1;
    }
    return played;
  }

  it('不會用無懈可擊抵消自己剛使用的五穀豐登', () => {
    const state = fresh();
    const request = wuxieRequest(0, [0, 1, 2], 'harvest', 0);
    state.pending = request;
    const view = viewFor(state, 0);

    expect(countPlays(view, request)).toBe(0);
  });

  it('不會用無懈可擊抵消自己放下的閃電', () => {
    const state = fresh();
    const request = wuxieRequest(0, [0], 'lightning', 0);
    state.pending = request;
    const view = viewFor(state, 0);

    expect(countPlays(view, request)).toBe(0);
  });

  it('自己的五穀豐登被敵方無懈可擊後，會反制', () => {
    const state = fresh();
    const request = wuxieRequest(0, [0, 1, 2], 'harvest', 1);
    state.pending = request;
    const view = viewFor(state, 0);

    expect(countPlays(view, request)).toBeGreaterThan(0);
  });

  it('敵人使用無中生有時會考慮抵消', () => {
    const state = fresh();
    const request = wuxieRequest(1, [1], 'ex_nihilo', 0);
    state.pending = request;
    const view = viewFor(state, 0);

    expect(countPlays(view, request)).toBeGreaterThan(0);
  });

  function actionRequest(player: number, options: PlayOption[]): Request {
    return {
      id: 20,
      player,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options,
      context: '出牌階段',
    };
  }

  it('不會用鐵索連環連結自己，會連結敵人', () => {
    const state = fresh();
    state.players[0]!.hand = [card(9200, 'iron_chain', 'club', 10)];

    const selfOption: PlayOption = {
      id: 'chain:self',
      label: '鐵索連環 → 自己',
      kind: 'play',
      cards: [9200],
      targets: [0],
      asCard: 'iron_chain',
    };
    const enemyOption: PlayOption = {
      id: 'chain:enemy',
      label: '鐵索連環 → 劉備',
      kind: 'play',
      cards: [9200],
      targets: [1],
      asCard: 'iron_chain',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };

    const selfRequest = actionRequest(0, [selfOption, pass]);
    state.pending = selfRequest;
    let selfView = viewFor(state, 0);
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(selfView, selfRequest, { rngState })).toEqual({ type: 'option', optionId: 'pass' });
    }

    const enemyRequest = actionRequest(0, [enemyOption, pass]);
    state.pending = enemyRequest;
    selfView = viewFor(state, 0);
    expect(decide(selfView, enemyRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'chain:enemy',
    });
  });

  it('反賊可推斷剩餘非主公角色是隊友（例如主公諸葛亮空城時不決鬥隊友）', () => {
    const state = fresh();
    state.players.forEach((item, index) => {
      item.role = index === 0 ? 'rebel' : index === 1 ? 'lord' : index === 2 ? 'rebel' : index === 3 ? 'loyal' : 'spy';
      item.alive = index < 3;
      item.hand = [];
    });
    state.players[1]!.generalId = 'zhuge_liang';
    state.players[0]!.hand = [card(9400, 'duel', 'club', 1)];

    const duel: PlayOption = {
      id: 'duel:ally',
      label: '決鬥 → 另一名反賊',
      kind: 'play',
      cards: [9400],
      targets: [2],
      asCard: 'duel',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };
    const request = actionRequest(0, [duel, pass]);
    state.pending = request;
    const view = viewFor(state, 0);

    // 沒有死亡資訊時，反賊無法確定對方是隊友，仍可能決鬥。
    expect(decide(view, request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'duel:ally',
    });

    // 忠臣與內奸都已公開死亡 → 其他存活非主公角色必為反賊，不攻擊。
    const memory = createAiMemory();
    memory.knownRole.set(3, 'loyal');
    memory.knownRole.set(4, 'spy');
    expect(decide(view, request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('內奸在還有其他人時不會攻擊主公，先打其他角色', () => {
    const state = fresh();
    state.players[0]!.role = 'spy';
    state.players[0]!.hand = [card(9300, 'slash', 'spade', 7)];

    const lordOption: PlayOption = {
      id: 'slash:lord',
      label: '殺 → 劉備',
      kind: 'play',
      cards: [9300],
      targets: [1],
      asCard: 'slash',
    };
    const otherOption: PlayOption = {
      id: 'slash:other',
      label: '殺 → 忠臣',
      kind: 'play',
      cards: [9300],
      targets: [2],
      asCard: 'slash',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };

    const request = actionRequest(0, [lordOption, otherOption, pass]);
    state.pending = request;
    const view = viewFor(state, 0);

    expect(decide(view, request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'slash:other',
    });
  });

  it('敵人只剩判定區延時錦囊時，放棄使用過河拆橋', () => {
    const state = fresh();
    state.players[0]!.hand = [card(9100, 'dismantle', 'club', 3)];
    state.players[1]!.judgeZone = [card(9101, 'supply_shortage', 'club', 4)];

    const dismantle: PlayOption = {
      id: 'play:dismantle:1',
      label: '過河拆橋 → 劉備',
      kind: 'play',
      cards: [9100],
      targets: [1],
      asCard: 'dismantle',
    };
    const pass: PlayOption = {
      id: 'pass',
      label: '結束出牌階段',
      kind: 'pass',
      cards: [],
      targets: [],
    };
    const request: Request = {
      id: 3,
      player: 0,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options: [dismantle, pass],
      context: '出牌階段',
    };
    state.pending = request;
    const view = viewFor(state, 0);

    const response = decide(view, request, { rngState: 1 });
    expect(response).toEqual({ type: 'option', optionId: 'pass' });
  });
});
