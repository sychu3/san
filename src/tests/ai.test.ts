import { describe, expect, it } from 'vitest';
import { createAiMemory, decide, updateMemory } from '../ai/policy';
import { createGame, viewFor } from '../engine/state';
import { runGame } from '../engine/engine';
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

  it('結姻不會幫敵人回體力，只在自己或隊友受傷時使用', () => {
    const state = fresh();
    state.players[0]!.generalId = 'sun_shangxiang';
    state.players[0]!.hand = [card(9500, 'peach', 'heart', 3), card(9501, 'dodge', 'diamond', 2)];
    state.players[0]!.hand.length = 2;
    // 自己滿血、目標是敵人：不應發動。
    const toEnemy: PlayOption = {
      id: 'jieyin:enemy',
      label: '結姻 → 劉備',
      kind: 'play',
      cards: [],
      targets: [1],
      skill: 'jieyin',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };
    const request = actionRequest(0, [toEnemy, pass]);
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 自己受傷時，可對自己使用。
    state.players[0]!.hp = state.players[0]!.maxHp - 1;
    const toSelf: PlayOption = {
      id: 'jieyin:self',
      label: '結姻 → 自己',
      kind: 'play',
      cards: [],
      targets: [0],
      skill: 'jieyin',
    };
    const request2 = actionRequest(0, [toSelf, pass]);
    state.pending = request2;
    expect(decide(viewFor(state, 0), request2, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'jieyin:self',
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

describe('技能與牌只對合理目標使用', () => {
  function actionRequest(player: number, options: PlayOption[]): Request {
    return {
      id: 40,
      player,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options,
      context: '出牌階段',
    };
  }

  function skillChoice(player: number, skill: string): Request {
    const option: ResponseOption = {
      id: skill,
      label: `${skill}：發動`,
      kind: 'skill',
      cards: [],
      skill,
    };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    return {
      id: 41,
      player,
      prompt: '是否發動技能？',
      kind: 'response',
      need: 'choice',
      options: [option, pass],
      context: skill,
    };
  }

  function respond(
    player: number,
    need: 'sha' | 'shan',
    cardId: number,
    asCard: 'slash' | 'dodge',
    extra: { source?: PlayerId; targets?: PlayerId[] } = {},
  ): Request {
    const play: ResponseOption = {
      id: 'play',
      label: '打出',
      kind: 'respond',
      cards: [cardId],
      asCard,
    };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    return {
      id: 42,
      player,
      prompt: '是否打出？',
      kind: 'response',
      need,
      options: [play, pass],
      context: '測試',
      ...extra,
    };
  }

  const passOption: PlayOption = {
    id: 'pass',
    label: '結束出牌階段',
    kind: 'pass',
    cards: [],
    targets: [],
  };

  it('忠臣（張遼）不會突襲主公：只有主公手上有牌時改為正常摸兩張', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.generalId = 'zhang_liao';
    state.players[1]!.hand = [card(9300, 'peach', 'heart', 3)];

    const request = skillChoice(0, 'tuxi');
    state.pending = request;
    const view = viewFor(state, 0);
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(view, request, { rngState })).toEqual({ type: 'option', optionId: 'pass' });
    }
  });

  it('張遼有敵人可偷時仍會發動突襲', () => {
    const state = fresh();
    state.players[0]!.generalId = 'zhang_liao';
    state.players[1]!.hand = [card(9301, 'peach', 'heart', 3)];

    const request = skillChoice(0, 'tuxi');
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'tuxi',
    });
  });

  it('突襲選目標時只挑敵人，不會拿隊友（主公）的牌', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[1]!.hand = [card(9302, 'peach', 'heart', 3)];
    state.players[2]!.hand = [card(9303, 'slash')];

    const request: Request = {
      id: 43,
      player: 0,
      prompt: '選擇至多兩名角色',
      kind: 'choosePlayers',
      candidates: [1, 2],
      min: 1,
      max: 2,
      reason: '突襲',
    };
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'players',
      players: [2],
    });
  });

  it('多目標【殺】（方天畫戟）不會把主公一起掃進去', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(9310, 'slash', 'spade', 7)];
    state.players[2]!.hand = [card(9311, 'dodge')];

    const both: PlayOption = {
      id: 'slash:both',
      label: '殺 → 主公與敵人',
      kind: 'play',
      cards: [9310],
      targets: [1, 2],
      asCard: 'slash',
    };
    const enemyOnly: PlayOption = {
      id: 'slash:enemy',
      label: '殺 → 敵人',
      kind: 'play',
      cards: [9310],
      targets: [2],
      asCard: 'slash',
    };
    const request = actionRequest(0, [both, enemyOnly, passOption]);
    state.pending = request;
    const view = viewFor(state, 0);
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(view, request, { rngState })).toEqual({
        type: 'option',
        optionId: 'slash:enemy',
      });
    }
  });

  it('被【借刀殺人】逼著打主公時放棄，打敵人才出【殺】', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(9320, 'slash', 'spade', 7)];

    const atLord = respond(0, 'sha', 9320, 'slash', { targets: [1] });
    state.pending = atLord;
    expect(decide(viewFor(state, 0), atLord, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const atEnemy = respond(0, 'sha', 9320, 'slash', { targets: [2] });
    state.pending = atEnemy;
    expect(decide(viewFor(state, 0), atEnemy, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'play',
    });
  });

  it('護駕：替主公出【閃】，但不替敵人擋刀', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(9330, 'dodge', 'diamond', 2)];

    const forLord = respond(0, 'shan', 9330, 'dodge', { source: 1 });
    state.pending = forLord;
    expect(decide(viewFor(state, 0), forLord, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'play',
    });

    const forEnemy = respond(0, 'shan', 9330, 'dodge', { source: 2 });
    state.pending = forEnemy;
    expect(decide(viewFor(state, 0), forEnemy, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('激將：幫主公打敵人會出【殺】，敵人借用或要打隊友則拒絕', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(9340, 'slash', 'spade', 7)];

    const lordAsks = respond(0, 'sha', 9340, 'slash', { source: 1, targets: [2] });
    state.pending = lordAsks;
    expect(decide(viewFor(state, 0), lordAsks, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'play',
    });

    const enemyAsks = respond(0, 'sha', 9340, 'slash', { source: 2, targets: [3] });
    state.pending = enemyAsks;
    expect(decide(viewFor(state, 0), enemyAsks, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const lordAsksToHitLord = respond(0, 'sha', 9340, 'slash', { source: 1, targets: [1] });
    state.pending = lordAsksToHitLord;
    expect(decide(viewFor(state, 0), lordAsksToHitLord, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('公開事件：朝主公出【殺】（即使被閃掉）也算敵意證據', () => {
    const state = fresh();
    state.publicEvents = [
      { seq: 1, kind: 'use', source: 3, target: 1, cardName: 'snatch' },
      { seq: 2, kind: 'use', source: 3, target: 1, cardName: 'slash' },
    ];
    const memory = createAiMemory();
    updateMemory(viewFor(state, 0), memory);
    expect(memory.rebelScore.get(3)).toBe(8);

    // 南蠻入侵只是掃到主公，證據力弱得多。
    state.publicEvents = [{ seq: 3, kind: 'use', source: 4, target: 1, cardName: 'barbarian' }];
    const groupMemory = createAiMemory();
    updateMemory(viewFor(state, 0), groupMemory);
    expect(groupMemory.rebelScore.get(4)).toBe(1);
  });

  it('主公打誰不算證據（主公沒有其他人拿不到的資訊）', () => {
    const state = fresh();
    state.publicEvents = [
      { seq: 1, kind: 'damage', source: 1, target: 2, amount: 1 },
      { seq: 2, kind: 'damage', source: 1, target: 3, amount: 1 },
    ];
    const memory = createAiMemory();
    updateMemory(viewFor(state, 0), memory);
    expect(memory.rebelScore.get(2)).toBeUndefined();
    expect(memory.rebelScore.get(3)).toBeUndefined();
  });

  it('死亡公開身份可反推兇手：殺忠臣提高嫌疑、殺反賊降低嫌疑', () => {
    const state = fresh();

    state.publicEvents = [{ seq: 1, kind: 'death', source: 2, target: 3, role: 'loyal' }];
    const loyalMemory = createAiMemory();
    updateMemory(viewFor(state, 0), loyalMemory);
    expect(loyalMemory.rebelScore.get(2)).toBe(5);

    state.publicEvents = [{ seq: 2, kind: 'death', source: 4, target: 3, role: 'rebel' }];
    const rebelMemory = createAiMemory();
    updateMemory(viewFor(state, 0), rebelMemory);
    expect(rebelMemory.rebelScore.get(4)).toBe(-3);
  });

  it('反賊不會攻擊已明顯曝露的同夥，但仍會打沒有線索的目標', () => {
    const state = fresh();
    state.players[0]!.hand = [card(9700, 'slash', 'spade', 7)];

    const atSuspect: PlayOption = {
      id: 'slash:suspect',
      label: '殺 → 曾兩度攻擊主公的人',
      kind: 'play',
      cards: [9700],
      targets: [3],
      asCard: 'slash',
    };
    const atUnknown: PlayOption = {
      id: 'slash:unknown',
      label: '殺 → 沒有線索的人',
      kind: 'play',
      cards: [9700],
      targets: [2],
      asCard: 'slash',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };

    const memory = createAiMemory();
    memory.rebelScore.set(3, 8);

    const onlySuspect = actionRequest(0, [atSuspect, pass]);
    state.pending = onlySuspect;
    expect(decide(viewFor(state, 0), onlySuspect, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const both = actionRequest(0, [atSuspect, atUnknown, pass]);
    state.pending = both;
    expect(decide(viewFor(state, 0), both, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:unknown',
    });

    // 沒有線索時仍會攻擊未知目標（不知道對方是敵是友）。
    state.pending = onlySuspect;
    expect(decide(viewFor(state, 0), onlySuspect, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:suspect',
    });
  });

  it('忠臣不會攻擊明顯救援過主公的人', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(9710, 'slash', 'spade', 7)];

    const helper: PlayOption = {
      id: 'slash:helper',
      label: '殺 → 救過主公的人',
      kind: 'play',
      cards: [9710],
      targets: [2],
      asCard: 'slash',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };
    const request = actionRequest(0, [helper, pass]);
    state.pending = request;

    const memory = createAiMemory();
    memory.rebelScore.set(2, -8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:helper',
    });
  });

  it('苦肉：滿血且缺牌才發動，不會把自己用到剩 1 點體力', () => {
    const state = fresh();
    state.players[0]!.generalId = 'huang_gai';

    const kurou: PlayOption = {
      id: 'kurou',
      label: '苦肉：失去 1 點體力，摸 2 張牌',
      kind: 'play',
      cards: [],
      targets: [],
      skill: 'kurou',
    };
    const request = actionRequest(0, [kurou, passOption]);
    state.pending = request;

    // 4 點體力、手牌少 → 值得發動（用完仍有 3 點）。
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({
        type: 'option',
        optionId: 'kurou',
      });
    }

    // 只剩 3 點體力 → 不用（用下去會剩 2 點）。
    state.players[0]!.hp = 3;
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({
        type: 'option',
        optionId: 'pass',
      });
    }

    // 新手難度也一樣不會把自己用到 1 點體力。
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState }, createAiMemory(), 'easy')).toEqual({
        type: 'option',
        optionId: 'pass',
      });
    }

    // 體力足夠但手牌已經很多 → 不需要再換牌。
    state.players[0]!.hp = 4;
    state.players[0]!.hand = Array.from({ length: 5 }, (_, index) => card(9600 + index, 'peach', 'heart', 3));
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({
        type: 'option',
        optionId: 'pass',
      });
    }
  });

  it('苦肉：200 局掃描都不會在體力 3 以下或缺牌以外時發動', () => {
    const unsafe: string[] = [];
    let uses = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const state = createGame({ seed });
      const generator = runGame(state);
      const rng = { rngState: (state.seed ^ 0x85ebca6b) >>> 0 || 1 };
      const memories = new Map<number, ReturnType<typeof createAiMemory>>();
      let step = generator.next();
      let guard = 0;
      while (!step.done && guard < 200_000) {
        guard += 1;
        const request: Request = step.value;
        let memory = memories.get(request.player);
        if (!memory) {
          memory = createAiMemory();
          memories.set(request.player, memory);
        }
        const response = decide(viewFor(state, request.player), request, rng, memory, 'normal');
        if (request.kind === 'action' && response.type === 'option') {
          const option = request.options.find((item) => item.id === response.optionId);
          if (option?.skill === 'kurou') {
            uses += 1;
            const player = state.players[request.player]!;
            if (player.hp - 1 < 3 || player.hand.length > 3) {
              unsafe.push(`seed ${seed} hp=${player.hp} hand=${player.hand.length}`);
            }
          }
        }
        step = generator.next(response);
      }
    }
    expect(uses).toBeGreaterThan(0);
    expect(unsafe).toEqual([]);
  });

  it('仁德：AI 不會一次把手牌給光，一般隊友只給 2 張', () => {
    const state = fresh();
    state.players[0]!.role = 'rebel';
    state.players[0]!.hand = [
      card(8801, 'slash', 'spade', 7),
      card(8802, 'dodge', 'heart', 2),
      card(8803, 'peach', 'heart', 3),
      card(8804, 'wine', 'spade', 9),
    ];
    const request: Request = {
      id: 880,
      player: 0,
      prompt: '選擇要交給 玩家3 的手牌（可多選）',
      kind: 'chooseCards',
      cards: [8801, 8802, 8803, 8804],
      min: 1,
      max: 4,
      reason: '仁德',
      skill: 'rende',
      target: 2,
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 3 });
    if (response.type !== 'cards') throw new Error('expected cards');
    expect(response.cards.length).toBe(2);
  });

  it('仁德：破敵人 0 手牌的【空城】時只給 1 張', () => {
    const state = fresh();
    state.players[0]!.role = 'rebel';
    state.players[0]!.hand = [
      card(8811, 'slash', 'spade', 7),
      card(8812, 'wine', 'spade', 9),
      card(8813, 'peach', 'heart', 3),
    ];
    state.players[2]!.generalId = 'zhuge_liang';
    state.players[2]!.hand = [];

    const request: Request = {
      id: 881,
      player: 0,
      prompt: '選擇要交給 玩家3 的手牌（可多選）',
      kind: 'chooseCards',
      cards: [8811, 8812, 8813],
      min: 1,
      max: 3,
      reason: '仁德',
      skill: 'rende',
      target: 2,
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 3 });
    if (response.type !== 'cards') throw new Error('expected cards');
    expect(response.cards.length).toBe(1);
  });

  it('仁德：不會破壞隊友【空城】，但會破敵人的空城以接上【殺】', () => {
    // 隊友諸葛亮 0 手牌：保留空城。
    const allyState = fresh();
    allyState.players[0]!.role = 'rebel';
    allyState.players[0]!.hand = [card(8821, 'slash', 'spade', 7), card(8822, 'wine', 'spade', 9)];
    allyState.players[2]!.generalId = 'zhuge_liang';
    allyState.players[2]!.hand = [];
    const allyRequest = actionRequest(0, [
      { id: 'rende:2', label: '仁德', kind: 'play', cards: [], targets: [2], skill: 'rende' },
      passOption,
    ]);
    allyState.pending = allyRequest;
    const allyMemory = createAiMemory();
    allyMemory.knownRole.set(2, 'rebel');
    expect(
      decide(viewFor(allyState, 0), allyRequest, { rngState: 1 }, allyMemory),
    ).toEqual({ type: 'option', optionId: 'pass' });

    // 敵人諸葛亮 0 手牌，且自己手上有【殺】在範圍內：給 1 張破空城。
    const enemyState = fresh();
    enemyState.players[0]!.role = 'loyal';
    enemyState.players[0]!.hand = [card(8823, 'slash', 'spade', 7), card(8824, 'wine', 'spade', 9)];
    enemyState.players[0]!.equips.weapon = card(8825, 'double_sword', 'spade', 5);
    enemyState.players[2]!.generalId = 'zhuge_liang';
    enemyState.players[2]!.hand = [];
    const enemyRequest = actionRequest(0, [
      { id: 'rende:2', label: '仁德', kind: 'play', cards: [], targets: [2], skill: 'rende' },
      passOption,
    ]);
    enemyState.pending = enemyRequest;
    const enemyMemory = createAiMemory();
    enemyMemory.rebelScore.set(2, 8);
    for (let rngState = 1; rngState <= 20; rngState += 1) {
      expect(
        decide(viewFor(enemyState, 0), enemyRequest, { rngState }, enemyMemory),
      ).toEqual({ type: 'option', optionId: 'rende:2' });
    }
  });

  it('內奸仁德：只在中低血量且缺牌時給主公 1 張，最後單挑不給', () => {
    const state = fresh();
    state.players[0]!.role = 'spy';
    state.players[0]!.hand = [card(8831, 'wine', 'spade', 9), card(8832, 'slash', 'spade', 7)];
    state.players[1]!.hand = [];
    state.players[1]!.maxHp = 4;
    const request = actionRequest(0, [
      { id: 'rende:1', label: '仁德', kind: 'play', cards: [], targets: [1], skill: 'rende' },
      passOption,
    ]);
    state.pending = request;

    // 主公滿血：不給。
    state.players[1]!.hp = 4;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 主公中低血量且缺牌：給 1 張。
    state.players[1]!.hp = 2;
    for (let rngState = 1; rngState <= 20; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({
        type: 'option',
        optionId: 'rende:1',
      });
    }

    // 只剩內奸與主公：不給，準備單挑。
    state.players[2]!.alive = false;
    state.players[3]!.alive = false;
    state.players[4]!.alive = false;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('內奸瀕死救援：還有其他人時救主公，只剩兩人時讓主公死亡以取勝', () => {
    const state = fresh();
    state.players[0]!.role = 'spy';
    state.players[1]!.hp = 0;
    const peach: ResponseOption = {
      id: 'peach',
      label: '使用【桃】',
      kind: 'respond',
      cards: [8840],
      asCard: 'peach',
    };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    const request: Request = {
      id: 884,
      player: 0,
      prompt: '是否救助 主公？',
      kind: 'response',
      need: 'peach',
      options: [peach, pass],
      context: '瀕死',
    };
    state.pending = request;

    // 還有反賊／忠臣在場：救主公，避免反賊勝利。
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'peach',
    });

    // 只剩內奸與主公：主公死亡直接讓內奸成為唯一存活者。
    state.players[2]!.alive = false;
    state.players[3]!.alive = false;
    state.players[4]!.alive = false;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('【借刀殺人】不會被用來逼敵人打自己的隊友', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(9350, 'collateral', 'club', 7)];
    state.players[1]!.equips.weapon = card(9351, 'crossbow', 'club', 1);

    // 敵人（玩家 2）有武器；用借刀逼他打主公（隊友）是幫倒忙。
    const atLord: PlayOption = {
      id: 'collateral:2:1',
      label: '借刀殺人 → 敵人 對 主公 出【殺】',
      kind: 'play',
      cards: [9350],
      targets: [2, 1],
      asCard: 'collateral',
    };
    const atEnemy: PlayOption = {
      id: 'collateral:2:3',
      label: '借刀殺人 → 敵人 對 敵人 出【殺】',
      kind: 'play',
      cards: [9350],
      targets: [2, 3],
      asCard: 'collateral',
    };
    const request = actionRequest(0, [atLord, atEnemy, passOption]);
    state.pending = request;
    const view = viewFor(state, 0);
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(view, request, { rngState })).toEqual({
        type: 'option',
        optionId: 'collateral:2:3',
      });
    }
  });
});
