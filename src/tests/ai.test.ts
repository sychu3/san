import { describe, expect, it } from 'vitest';
import { beliefProbs, beliefsFor, createAiMemory, decide, seedBeliefScore, updateMemory } from '../ai/policy';
import { createGame, viewFor } from '../engine/state';
import { getPlayOptions, runGame } from '../engine/engine';
import type {
  Card,
  CardName,
  GameState,
  PlayOption,
  PlayerId,
  Request,
  Response,
  ResponseOption,
  Role,
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

  it('有害牌已被無懈時，不為了讓敵人多吃傷害而反制（連鎖 2）', () => {
    const state = fresh();
    // 主公的【南蠻入侵】目前被無懈（連鎖 1），受影響者只有主公（觀察者的敵人）。
    const request = wuxieRequest(1, [1], 'barbarian', 1);
    state.pending = request;
    const view = viewFor(state, 0);

    expect(countPlays(view, request)).toBe(0);
  });

  it('有害牌波及自己且尚未被無懈時，仍會考慮抵消', () => {
    const state = fresh();
    const request = wuxieRequest(1, [0, 1], 'barbarian', 0);
    state.pending = request;
    const view = viewFor(state, 0);

    expect(countPlays(view, request)).toBeGreaterThan(0);
  });

  it('反間：展示牌會歸目標，手牌貴重時不使用、低價值時使用', () => {
    const state = fresh();
    state.players[1]!.hp = 4;
    const fanjian: PlayOption = {
      id: 'fanjian:1',
      label: '反間：令 主公 猜花色',
      kind: 'play',
      cards: [],
      targets: [1],
      skill: 'fanjian',
    };
    const passOption: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };
    const request = actionRequest(0, [fanjian, passOption]);
    state.pending = request;

    // 手牌低價值（兩張【殺】）→ 反間值得。
    state.players[0]!.hand = [card(9400, 'slash', 'spade'), card(9401, 'thunder_slash', 'club')];
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'fanjian:1',
    });

    // 手牌貴重（【桃】【閃】【無懈】）→ 不為了 1 點傷害送牌給對手。
    state.players[0]!.hand = [
      card(9402, 'peach', 'heart'),
      card(9403, 'dodge', 'diamond'),
      card(9404, 'nullification', 'club'),
    ];
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('反間猜花色：避開自己手上最多的花色', () => {
    const state = fresh();
    state.players[0]!.hand = [
      card(9300, 'slash', 'spade'),
      card(9301, 'dodge', 'spade'),
      card(9302, 'peach', 'spade'),
      card(9303, 'dodge', 'heart'),
    ];
    const options: ResponseOption[] = [
      { id: 'suit:spade', label: '猜 黑桃', kind: 'skill', cards: [], skill: 'suit_spade' },
      { id: 'suit:heart', label: '猜 紅桃', kind: 'skill', cards: [], skill: 'suit_heart' },
      { id: 'suit:club', label: '猜 梅花', kind: 'skill', cards: [], skill: 'suit_club' },
      { id: 'suit:diamond', label: '猜 方塊', kind: 'skill', cards: [], skill: 'suit_diamond' },
      { id: 'pass', label: '不出', kind: 'pass', cards: [] },
    ];
    const request: Request = {
      id: 30,
      player: 0,
      prompt: '反間：請猜一張花色',
      kind: 'response',
      need: 'choice',
      options,
      context: '反間',
      source: 1,
      targets: [0],
    };
    state.pending = request;
    const view = viewFor(state, 0);

    for (let rngState = 1; rngState <= 20; rngState += 1) {
      const response = decide(view, request, { rngState });
      expect(response.type).toBe('option');
      if (response.type === 'option') expect(response.optionId).not.toBe('suit:spade');
    }
  });

  it('遺計分配：優先給自己或隊友，不會主動送牌給敵人', () => {
    const state = fresh();
    const request: Request = {
      id: 31,
      player: 0,
      prompt: '遺計：選擇獲得牌的角色',
      kind: 'choosePlayers',
      candidates: [0, 1, 2],
      min: 1,
      max: 1,
      reason: '遺計',
    };
    state.pending = request;
    const view = viewFor(state, 0);

    expect(decide(view, request, { rngState: 1 })).toEqual({
      type: 'players',
      players: [0],
    });
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

    // 未知目標不再當敵人：未有死亡資訊時，反賊也不會用【決鬥】賭隊友。
    expect(decide(view, request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
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

  it('只有一名確認敵人有牌時不值得突襲，改為正常摸兩張（DESIGN 7.3.18）', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.generalId = 'zhang_liao';
    state.players[2]!.hand = [card(9304, 'dodge', 'spade', 10)];

    const request = skillChoice(0, 'tuxi');
    state.pending = request;
    // 單一目標多半拿到場上用剩的雜牌，失去摸兩張的牌差還暴露身份。
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({ type: 'option', optionId: 'pass' });
    }
  });

  it('兩名確認敵人有牌時仍會發動突襲', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.generalId = 'zhang_liao';
    state.players[2]!.hand = [card(9301, 'peach', 'heart', 3)];
    state.players[3]!.hand = [card(9305, 'dodge', 'club', 8)];

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

  it('激將／護駕：主公沒有自己的牌時會選擇發動主公技', () => {
    const state = fresh();

    const shaRequest: Request = {
      id: 9500,
      player: 1,
      prompt: '是否打出【殺】？',
      kind: 'response',
      need: 'sha',
      context: '決鬥',
      options: [
        { id: 'jijiang', label: '激將', kind: 'respond', cards: [], asCard: 'slash', skill: 'jijiang' },
        { id: 'pass', label: '不出', kind: 'pass', cards: [] },
      ],
    };
    state.pending = shaRequest;
    expect(decide(viewFor(state, 1), shaRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'jijiang',
    });

    const shanRequest: Request = {
      id: 9501,
      player: 1,
      prompt: '是否打出【閃】？',
      kind: 'response',
      need: 'shan',
      context: '【殺】',
      options: [
        { id: 'hujia', label: '護駕', kind: 'respond', cards: [], asCard: 'dodge', skill: 'hujia' },
        { id: 'pass', label: '不出', kind: 'pass', cards: [] },
      ],
    };
    state.pending = shanRequest;
    expect(decide(viewFor(state, 1), shanRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'hujia',
    });
  });

  it('激將：主公手上有【殺】時優先使用自己的牌', () => {
    const state = fresh();
    state.players[1]!.hand = [card(9510, 'slash', 'spade', 7)];
    const request: Request = {
      id: 9511,
      player: 1,
      prompt: '是否打出【殺】？',
      kind: 'response',
      need: 'sha',
      context: '決鬥',
      options: [
        { id: 'sha:9510', label: '打出【殺】', kind: 'respond', cards: [9510], asCard: 'slash' },
        { id: 'jijiang', label: '激將', kind: 'respond', cards: [], asCard: 'slash', skill: 'jijiang' },
        { id: 'pass', label: '不出', kind: 'pass', cards: [] },
      ],
    };
    state.pending = request;
    expect(decide(viewFor(state, 1), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'sha:9510',
    });
  });

  it('公開事件：朝主公出【殺】（即使被閃掉）也算敵意證據', () => {
    const state = fresh();
    state.publicEvents = [
      { seq: 1, kind: 'use', source: 3, target: 1, cardName: 'snatch' },
      { seq: 2, kind: 'use', source: 3, target: 1, cardName: 'slash' },
    ];
    const memory = createAiMemory();
    const v1 = viewFor(state, 0);
    updateMemory(v1, memory);
    const p3 = beliefProbs(v1, v1.players[0]!, memory, v1.players[3]!);
    expect(p3.rebel).toBeGreaterThan(0.8);

    // 南蠻入侵只是掃到主公，證據力弱得多（但仍高於先驗）。
    state.publicEvents = [{ seq: 3, kind: 'use', source: 4, target: 1, cardName: 'barbarian' }];
    const groupMemory = createAiMemory();
    const v2 = viewFor(state, 0);
    updateMemory(v2, groupMemory);
    const p4 = beliefProbs(v2, v2.players[0]!, groupMemory, v2.players[4]!);
    expect(p4.rebel).toBeLessThan(p3.rebel);
    expect(p4.rebel).toBeGreaterThan(0.3);
  });

  it('主公打誰不算證據（主公沒有其他人拿不到的資訊）', () => {
    const state = fresh();
    state.publicEvents = [
      { seq: 1, kind: 'damage', source: 1, target: 2, amount: 1 },
      { seq: 2, kind: 'damage', source: 1, target: 3, amount: 1 },
    ];
    const memory = createAiMemory();
    updateMemory(viewFor(state, 0), memory);
    expect(memory.belief.get(2)).toBeUndefined();
    expect(memory.belief.get(3)).toBeUndefined();
  });

  it('死亡公開身份可反推兇手：殺忠臣提高嫌疑、殺反賊降低嫌疑', () => {
    const state = fresh();

    state.publicEvents = [{ seq: 1, kind: 'death', source: 2, target: 3, role: 'loyal' }];
    const loyalMemory = createAiMemory();
    const v1 = viewFor(state, 1); // 主公視角
    updateMemory(v1, loyalMemory);
    // 擊殺忠臣 → 忠臣機率歸零、幾乎確定是敵人。
    expect(beliefProbs(v1, v1.players[1]!, loyalMemory, v1.players[2]!).loyal).toBeLessThan(0.05);

    state.publicEvents = [{ seq: 2, kind: 'death', source: 4, target: 3, role: 'rebel' }];
    const rebelMemory = createAiMemory();
    const v2 = viewFor(state, 1);
    updateMemory(v2, rebelMemory);
    // 擊殺反賊只是弱證據（反賊、內奸都可能會做），仍略微降低反賊機率。
    const p4 = beliefProbs(v2, v2.players[1]!, rebelMemory, v2.players[4]!);
    expect(p4.rebel).toBeLessThan(0.33);
    expect(p4.loyal).toBeLessThan(0.5);
  });

  it('顯示性偏好：主公是合法目標卻選別人 → spareLord 弱忠誠證據', () => {
    const state = fresh();
    state.players[1]!.hand = [card(9800, 'peach')];
    state.publicEvents = [{ seq: 1, kind: 'use', source: 2, target: 3, cardName: 'indulgence' }];
    const memory = createAiMemory();
    updateMemory(viewFor(state, 0), memory);

    expect(memory.beliefAcc.get(2)?.get('spareLord')).toBeDefined();
    // 三個假設的似然都小於 1，但反賊的似然最低 → 相對更像忠臣／內奸。
    const ev = memory.belief.get(2)!;
    expect(ev.rebel).toBeLessThan(ev.loyal);
    expect(ev.rebel).toBeLessThan(ev.spy);
    expect(memory.rebelScore.get(2)).toBeLessThan(0);
  });

  it('spareLord：主公非合法目標、來源 1 血或目標是公開忠臣時都不計', () => {
    const state = fresh();
    // 火攻需要目標有手牌；主公 0 手牌 → 不是合法目標。
    state.players[1]!.hand = [];
    state.publicEvents = [{ seq: 1, kind: 'use', source: 2, target: 3, cardName: 'fire_attack' }];
    const noHand = createAiMemory();
    updateMemory(viewFor(state, 0), noHand);
    expect(noHand.beliefAcc.get(2)?.get('spareLord')).toBeUndefined();

    // 1 血來源有自保理由，不構成忠誠證據。
    state.players[1]!.hand = [card(9801, 'peach')];
    state.players[2]!.hp = 1;
    state.publicEvents = [{ seq: 1, kind: 'use', source: 2, target: 3, cardName: 'indulgence' }];
    const lowHp = createAiMemory();
    updateMemory(viewFor(state, 0), lowHp);
    expect(lowHp.beliefAcc.get(2)?.get('spareLord')).toBeUndefined();

    // 打公開忠臣不是「放過主公」的忠誠訊號。
    state.players[2]!.hp = 4;
    const knownLoyal = createAiMemory();
    knownLoyal.knownRole.set(3, 'loyal');
    state.publicEvents = [{ seq: 1, kind: 'use', source: 2, target: 3, cardName: 'indulgence' }];
    updateMemory(viewFor(state, 0), knownLoyal);
    expect(knownLoyal.beliefAcc.get(2)?.get('spareLord')).toBeUndefined();
  });

  it('spareLord：目標已被觀察者懷疑是忠臣時，打他不算忠心', () => {
    const state = fresh();
    state.publicEvents = [{ seq: 1, kind: 'use', source: 2, target: 3, cardName: 'indulgence' }];
    const memory = createAiMemory();
    // 忠臣專屬證據（例如治療過主公）；seedBeliefScore 會把忠／奸一起提高，不適用。
    memory.belief.set(3, { rebel: -4, loyal: 4, spy: -4 });
    memory.beliefVersion += 1;
    updateMemory(viewFor(state, 0), memory, 0);
    expect(memory.beliefAcc.get(2)?.get('spareLord')).toBeUndefined();
  });

  it('spareLord：目標已被觀察者懷疑是反賊時，用較強的忠誠表', () => {
    const state = fresh();
    state.publicEvents = [{ seq: 1, kind: 'use', source: 2, target: 3, cardName: 'indulgence' }];
    const memory = createAiMemory();
    seedBeliefScore(memory, 3, 8); // 觀察者已懷疑 3 是反賊
    updateMemory(viewFor(state, 0), memory, 0);
    const ev = memory.beliefAcc.get(2)?.get('spareLord');
    expect(ev).toBeDefined();
    expect(ev!.rebel).toBeCloseTo(Math.log(0.2), 5);
    expect(ev!.loyal).toBeCloseTo(Math.log(1.1), 5);
    expect(ev!.spy).toBeCloseTo(Math.log(0.9), 5);
  });

  it('反賊靠聯合後驗保護隊友：忠臣名額被佔後不再攻擊另一名未知者', () => {
    const state = fresh();
    state.players[2]!.generalId = 'cao_cao';
    state.players[3]!.generalId = 'liu_bei';
    state.players[2]!.role = 'loyal';
    state.players[3]!.role = 'rebel';
    state.players[4]!.role = 'spy';
    state.players[4]!.alive = false;
    state.players[4]!.hp = 0;
    state.players[0]!.hand = [card(9700, 'slash', 'spade', 7)];

    const atLoyalLooking: PlayOption = {
      id: 'slash:2',
      label: '殺 → 像忠臣的人',
      kind: 'play',
      cards: [9700],
      targets: [2],
      asCard: 'slash',
    };
    const atAlly: PlayOption = {
      id: 'slash:3',
      label: '殺 → 像另一名反賊的人',
      kind: 'play',
      cards: [9700],
      targets: [3],
      asCard: 'slash',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };
    const request: Request = {
      id: 1,
      player: 0,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options: [atLoyalLooking, atAlly, pass],
      context: '出牌階段',
    };
    state.pending = request;

    const memory = createAiMemory();
    seedBeliefScore(memory, 2, -6); // 玩家 2 有忠臣行為證據
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:2',
    });
  });

  it('seed 3226659290 情境：忠臣「有機會卻不打主公」讓反賊認出隊友', () => {
    const state = createGame({ seed: 3226659290, humanId: 0, humanGeneralId: 'gan_ning' });
    // 0 主公甘寧、1 忠臣張遼、2 內奸呂布、3 反賊孫權、4 反賊孫尚香。
    expect(state.players.map((item) => item.role)).toEqual(['lord', 'loyal', 'spy', 'rebel', 'rebel']);
    state.players[2]!.alive = false;
    state.players[2]!.hp = 0;
    state.players[0]!.hand = [card(9900, 'peach')];
    // 張遼在主公是合法目標時，選擇對孫尚香用【樂不思蜀】。
    state.publicEvents = [{ seq: 1, kind: 'use', source: 1, target: 4, cardName: 'indulgence' }];

    const memory = createAiMemory();
    const view = viewFor(state, 3); // 孫權視角
    updateMemory(view, memory, 3);
    const self = view.players[3]!;
    const zhangLiao = beliefProbs(view, self, memory, view.players[1]!);
    const sunShangxiang = beliefProbs(view, self, memory, view.players[4]!);
    expect(zhangLiao.loyal).toBeGreaterThan(zhangLiao.rebel);
    // 內奸已死且忠臣名額被張遼佔走 → 孫尚香被推為隊友。
    expect(sunShangxiang.rebel).toBeGreaterThan(0.6);

    // 孫權不會再把孫尚香當目標；若張遼在範圍內，應改打張遼。
    state.players[3]!.equips.weapon = card(9901, 'qinggang', 'spade', 1);
    state.players[3]!.hand = [card(9902, 'slash', 'spade', 7)];
    const atZhangLiao: PlayOption = {
      id: 'slash:1',
      label: '殺 → 張遼',
      kind: 'play',
      cards: [9902],
      targets: [1],
      asCard: 'slash',
    };
    const atSunShangxiang: PlayOption = {
      id: 'slash:4',
      label: '殺 → 孫尚香',
      kind: 'play',
      cards: [9902],
      targets: [4],
      asCard: 'slash',
    };
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };
    const request: Request = {
      id: 1,
      player: 3,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options: [atZhangLiao, atSunShangxiang, pass],
      context: '出牌階段',
    };
    state.pending = request;
    expect(decide(viewFor(state, 3), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:1',
    });
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
    seedBeliefScore(memory, 3, 8);

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

  it('主公不會攻擊明顯救援過主公的人；忠臣則仍依人數推理保留警戒', () => {
    const state = fresh();
    state.players[0]!.role = 'lord';
    state.players[1]!.role = 'loyal';
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
    seedBeliefScore(memory, 2, -8);
    // 主公還有一個忠臣名額，行為上救過主公的人可被視為隊友。
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 忠臣知道自己不可能是另一名忠臣：即使對方救過主公，仍會在有嫌疑時出手。
    const loyalState = fresh();
    loyalState.players[0]!.role = 'loyal';
    loyalState.players[0]!.hand = [card(9711, 'slash', 'spade', 7)];
    const loyalRequest = actionRequest(0, [helper, pass]);
    loyalState.pending = loyalRequest;
    const loyalMemory = createAiMemory();
    seedBeliefScore(loyalMemory, 2, -8);
    expect(decide(viewFor(loyalState, 0), loyalRequest, { rngState: 1 }, loyalMemory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:helper',
    });

    // 沒有行為線索時仍會試探未知目標；主公需要攻擊範圍，補一把青釭劍。
    state.players[0]!.equips.weapon = card(9712, 'qinggang', 'spade', 1);
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
  }, 30_000);

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

  it('仁德：低血且只有兩張手牌時，給兩張湊到第 2 張回血', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hp = 2;
    state.players[0]!.hand = [card(8831, 'slash', 'spade', 7), card(8832, 'wine', 'spade', 9)];
    state.players[1]!.hand = [];

    const request: Request = {
      id: 883,
      player: 0,
      prompt: '選擇要交給 玩家2 的手牌（可多選）',
      kind: 'chooseCards',
      cards: [8831, 8832],
      min: 1,
      max: 2,
      reason: '仁德',
      skill: 'rende',
      target: 1,
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 3 });
    if (response.type !== 'cards') throw new Error('expected cards');
    expect(response.cards).toHaveLength(2);
  });

  it('仁德：一般情況不送【閃】、【桃】等高價值牌', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [
      card(8841, 'slash', 'spade', 7),
      card(8842, 'dodge', 'heart', 2),
      card(8843, 'peach', 'heart', 3),
    ];
    state.players[1]!.hand = [card(8844, 'dodge'), card(8845, 'dodge')];

    const request: Request = {
      id: 884,
      player: 0,
      prompt: '選擇要交給 玩家2 的手牌（可多選）',
      kind: 'chooseCards',
      cards: [8841, 8842, 8843],
      min: 1,
      max: 3,
      reason: '仁德',
      skill: 'rende',
      target: 1,
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 3 });
    if (response.type !== 'cards') throw new Error('expected cards');
    // 只有【殺】是可送出的低價值牌，【閃】與【桃】留在手上。
    expect(response.cards).toEqual([8841]);
  });

  it('觀星：AI 把高價值牌排在牌堆頂', () => {
    const state = fresh();
    const request: Request = {
      id: 885,
      player: 0,
      prompt: '觀星：安排牌堆頂的順序',
      kind: 'orderCards',
      reason: '觀星',
      cards: [card(8851, 'slash', 'spade', 7), card(8852, 'peach', 'heart', 3), card(8853, 'wine', 'spade', 9)],
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 1 });
    // 桃 100 > 殺 40 > 酒 35。
    expect(response).toEqual({ type: 'cards', cards: [8852, 8851, 8853] });
  });

  it('觀星：有【閃電】時優先避免黑桃 2–9', () => {
    const state = fresh();
    state.players[0]!.generalId = 'zhuge_liang';
    state.players[0]!.judgeZone = [card(8871, 'lightning', 'spade', 1)];
    const request: Request = {
      id: 887,
      player: 0,
      prompt: '觀星：安排牌堆頂的順序',
      kind: 'orderCards',
      reason: '觀星',
      allowBottom: true,
      cards: [card(8872, 'slash', 'spade', 7), card(8873, 'peach', 'heart', 3)],
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 1 });
    // 黑桃 7 會觸發閃電；紅桃桃不會 → 桃必須是第一張判定牌。
    expect(response).toEqual({ type: 'cards', cards: [8873, 8872] });
  });

  it('觀星：整疊都會觸發【閃電】時全部移堆底賭未知牌', () => {
    const state = fresh();
    state.players[0]!.generalId = 'zhuge_liang';
    state.players[0]!.judgeZone = [card(8881, 'lightning', 'spade', 1)];
    const request: Request = {
      id: 888,
      player: 0,
      prompt: '觀星：安排牌堆頂的順序',
      kind: 'orderCards',
      reason: '觀星',
      allowBottom: true,
      cards: [card(8882, 'slash', 'spade', 2), card(8883, 'dodge', 'spade', 7)],
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 1 });
    expect(response).toEqual({ type: 'cards', cards: [], bottom: [8882, 8883] });
  });

  it('觀星：有【樂不思蜀】時把紅桃留在牌堆頂', () => {
    const state = fresh();
    state.players[0]!.generalId = 'zhuge_liang';
    state.players[0]!.judgeZone = [card(8891, 'indulgence', 'spade', 6)];
    const request: Request = {
      id: 889,
      player: 0,
      prompt: '觀星：安排牌堆頂的順序',
      kind: 'orderCards',
      reason: '觀星',
      allowBottom: true,
      cards: [card(8892, 'slash', 'club', 7), card(8893, 'dodge', 'heart', 2)],
    };
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 1 });
    // 紅桃【閃】排在牌堆頂第一張，樂不思蜀判定成功（不跳過出牌階段）。
    expect(response).toEqual({ type: 'cards', cards: [8893, 8892] });
  });

  it('剛烈：手牌少且血量安全時寧可受傷保牌', () => {
    const state = fresh();
    state.players[0]!.hp = 4;
    state.players[0]!.hand = [card(8861, 'slash', 'spade', 7), card(8862, 'dodge', 'heart', 2)];
    const request: Request = {
      id: 886,
      player: 0,
      prompt: '剛烈：請選擇一項',
      kind: 'response',
      need: 'choice',
      context: '剛烈',
      options: [
        { id: 'discard', label: '棄置兩張手牌', kind: 'skill', cards: [], skill: 'discard' },
        { id: 'damage', label: '受到 1 點傷害', kind: 'skill', cards: [], skill: 'damage' },
      ],
    };
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'damage',
    });

    // 手牌 3 張 → 棄牌較划算。
    state.players[0]!.hand.push(card(8863, 'wine', 'spade', 9));
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'discard',
    });
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
    seedBeliefScore(enemyMemory, 2, 8);
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

  it('即使隊友裝備很好，也不會對已知隊友使用【順手牽羊】', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(8890, 'snatch', 'spade', 3)];
    state.players[1]!.equips.weapon = card(8891, 'qilin_bow', 'spade', 5);
    state.players[1]!.equips.armor = card(8892, 'vine_armor', 'club', 2);
    state.players[1]!.hand = [card(8893, 'peach', 'heart', 3)];
    const request = actionRequest(0, getPlayOptions(state, state.players[0]!));
    state.pending = request;
    for (let rngState = 1; rngState <= 100; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({
        type: 'option',
        optionId: 'pass',
      });
    }
  });

  it('【酒】會先於同回合的【殺】使用，沒有後續【殺】時不喝', () => {
    const state = fresh();
    state.players[0]!.hand = [card(8901, 'wine', 'spade', 9), card(8902, 'slash', 'spade', 7)];
    const options = getPlayOptions(state, state.players[0]!);
    const request = actionRequest(0, options);
    state.pending = request;
    for (let rngState = 1; rngState <= 40; rngState += 1) {
      const response = decide(viewFor(state, 0), request, { rngState });
      expect(response.type).toBe('option');
      if (response.type !== 'option') throw new Error('expected option');
      expect(response.optionId.startsWith('wine:')).toBe(true);
    }

    // 只有【酒】而沒有【殺】：保留【酒】等下一回合或瀕死時用。
    state.players[0]!.hand = [card(8903, 'wine', 'spade', 9), card(8904, 'peach', 'heart', 3)];
    const noSlashOptions = getPlayOptions(state, state.players[0]!);
    const noSlashRequest = actionRequest(0, noSlashOptions);
    state.pending = noSlashRequest;
    for (let rngState = 1; rngState <= 20; rngState += 1) {
      const response = decide(viewFor(state, 0), noSlashRequest, { rngState });
      expect(response).toEqual({ type: 'option', optionId: 'pass' });
    }
  });

  it('不會用較差的武器蓋掉現有武器', () => {
    const state = fresh();
    state.players[0]!.hand = [card(8910, 'crossbow', 'club', 1)];
    state.players[0]!.equips.weapon = card(8911, 'qilin_bow', 'spade', 5);
    const request = actionRequest(0, getPlayOptions(state, state.players[0]!));
    state.pending = request;
    for (let rngState = 1; rngState <= 20; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({
        type: 'option',
        optionId: 'pass',
      });
    }
  });

  it('新武器能解鎖本回合攻擊時，先裝備再出【殺】', () => {
    const state = fresh();
    // 主公移到距離 2，起始武器（範圍 1）打不到。
    state.players[3]!.role = 'lord';
    state.players[1]!.role = 'loyal';
    state.players[0]!.hand = [
      card(8920, 'slash', 'spade', 7),
      card(8921, 'double_sword', 'spade', 5),
    ];
    const request = actionRequest(0, getPlayOptions(state, state.players[0]!));
    state.pending = request;
    const response = decide(viewFor(state, 0), request, { rngState: 1 });
    expect(response).toEqual({ type: 'option', optionId: 'equip:8921' });

    // 裝備後，主公進入範圍，且下一輪出現可攻擊主公的【殺】。
    state.players[0]!.equips.weapon = card(8921, 'double_sword', 'spade', 5);
    state.players[0]!.hand = [card(8920, 'slash', 'spade', 7)];
    const options = getPlayOptions(state, state.players[0]!);
    expect(
      options.some((option) => option.asCard === 'slash' && option.targets[0] === 3),
    ).toBe(true);
  });

  it('(-1) 馬能解鎖本回合攻擊時，先裝備再出【殺】', () => {
    const state = fresh();
    state.players[3]!.role = 'lord';
    state.players[1]!.role = 'loyal';
    state.players[0]!.hand = [card(8930, 'slash', 'spade', 7), card(8931, 'chitu', 'heart', 5)];
    const request = actionRequest(0, getPlayOptions(state, state.players[0]!));
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'equip:8931',
    });

    state.players[0]!.equips.horseMinus = card(8931, 'chitu', 'heart', 5);
    state.players[0]!.hand = [card(8930, 'slash', 'spade', 7)];
    const options = getPlayOptions(state, state.players[0]!);
    expect(
      options.some((option) => option.asCard === 'slash' && option.targets[0] === 3),
    ).toBe(true);
  });

  it('能強化本回合【殺】的武器會先裝備（青釭劍對有防具的敵人）', () => {
    const state = fresh();
    state.players[0]!.hand = [card(8940, 'slash', 'spade', 7), card(8941, 'qinggang', 'spade', 6)];
    state.players[1]!.equips.armor = card(8942, 'eight_diagram', 'spade', 2);
    const request = actionRequest(0, getPlayOptions(state, state.players[0]!));
    state.pending = request;
    for (let rngState = 1; rngState <= 20; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).toEqual({
        type: 'option',
        optionId: 'equip:8941',
      });
    }
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

describe('未知目標與酒／裸衣的高置信限制', () => {
  function actionRequest(player: number, options: PlayOption[]): Request {
    return {
      id: 200,
      player,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options,
      context: '出牌階段',
    };
  }

  function choiceRequest(player: number, skill: string): Request {
    const option: ResponseOption = {
      id: skill,
      label: `${skill}：發動`,
      kind: 'skill',
      cards: [],
      skill,
    };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    return {
      id: 201,
      player,
      prompt: '是否發動技能？',
      kind: 'response',
      need: 'choice',
      options: [option, pass],
      context: skill,
    };
  }

  const passOption: PlayOption = {
    id: 'pass',
    label: '結束出牌階段',
    kind: 'pass',
    cards: [],
    targets: [],
  };

  it('【酒】不會加在打向未知目標的【殺】上', () => {
    const state = fresh();
    state.players[0]!.role = 'lord';
    state.players[1]!.role = 'rebel';
    state.players[0]!.hand = [card(10001, 'slash', 'spade', 7)];
    state.turn = 0;
    state.turnCount = 2; // 非第一回合，單獨測酒的高置信判斷

    const slash: PlayOption = {
      id: 'slash',
      label: '殺 → 未知目標',
      kind: 'play',
      cards: [10001],
      targets: [1],
      asCard: 'slash',
    };
    const wine: PlayOption = {
      id: 'wine',
      label: '酒',
      kind: 'play',
      cards: [],
      targets: [0],
      asCard: 'wine',
    };
    const request = actionRequest(0, [wine, slash, passOption]);
    state.pending = request;
    const view = viewFor(state, 0);
    for (let rngState = 1; rngState <= 30; rngState += 1) {
      expect(decide(view, request, { rngState })).not.toEqual({
        type: 'option',
        optionId: 'wine',
      });
    }
  });

  it('【酒】會加在打向已確認敵人的有效【殺】上', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(10002, 'slash', 'heart', 7)];
    state.players[1]!.role = 'lord';
    state.players[4]!.role = 'rebel';
    state.turnCount = 2;

    const slash: PlayOption = {
      id: 'slash',
      label: '殺 → 已確認敵人',
      kind: 'play',
      cards: [10002],
      targets: [4],
      asCard: 'slash',
    };
    const wine: PlayOption = {
      id: 'wine',
      label: '酒',
      kind: 'play',
      cards: [],
      targets: [0],
      asCard: 'wine',
    };
    const request = actionRequest(0, [wine, slash, passOption]);
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'wine',
    });
  });

  it('【酒】不會加在白銀獅子封頂的敵人上', () => {
    const state = fresh();
    state.players[0]!.role = 'loyal';
    state.players[0]!.hand = [card(10003, 'slash', 'heart', 7)];
    state.players[1]!.role = 'lord';
    state.players[4]!.role = 'rebel';
    state.players[4]!.equips.armor = card(10004, 'silver_lion', 'spade', 2);
    state.turnCount = 2;

    const slash: PlayOption = {
      id: 'slash',
      label: '殺 → 白銀獅子敵人',
      kind: 'play',
      cards: [10003],
      targets: [4],
      asCard: 'slash',
    };
    const wine: PlayOption = {
      id: 'wine',
      label: '酒',
      kind: 'play',
      cards: [],
      targets: [0],
      asCard: 'wine',
    };
    const request = actionRequest(0, [wine, slash, passOption]);
    state.pending = request;
    for (let rngState = 1; rngState <= 30; rngState += 1) {
      expect(decide(viewFor(state, 0), request, { rngState })).not.toEqual({
        type: 'option',
        optionId: 'wine',
      });
    }
  });

  it('【裸衣】不會對未知目標發動，但會在已確認敵人在範圍內時發動', () => {
    const unknownState = fresh();
    unknownState.players[0]!.role = 'lord';
    unknownState.players[1]!.role = 'rebel';
    unknownState.players[0]!.generalId = 'xu_chu';
    unknownState.players[0]!.hand = [card(10005, 'slash', 'spade', 7)];
    unknownState.turn = 0;
    unknownState.turnCount = 1;
    const unknownRequest = choiceRequest(0, 'luoyi');
    unknownState.pending = unknownRequest;
    expect(decide(viewFor(unknownState, 0), unknownRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const enemyState = fresh();
    enemyState.players[0]!.role = 'loyal';
    enemyState.players[0]!.generalId = 'xu_chu';
    enemyState.players[0]!.hand = [card(10006, 'slash', 'spade', 7)];
    enemyState.players[1]!.role = 'lord';
    enemyState.players[4]!.role = 'rebel';
    enemyState.turnCount = 2;
    const enemyRequest = choiceRequest(0, 'luoyi');
    enemyState.pending = enemyRequest;
    expect(decide(viewFor(enemyState, 0), enemyRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'luoyi',
    });
  });

  it('主公第一回合只試探一張普通【殺】，不用高成本敵意牌', () => {
    const state = fresh();
    state.players[0]!.role = 'lord';
    state.players[1]!.role = 'rebel';
    state.players[0]!.hand = [card(10007, 'slash', 'spade', 7)];
    state.turn = 0;
    state.turnCount = 1;

    const slash: PlayOption = {
      id: 'slash',
      label: '殺 → 未知目標',
      kind: 'play',
      cards: [10007],
      targets: [1],
      asCard: 'slash',
    };
    const duel: PlayOption = {
      id: 'duel',
      label: '決鬥 → 未知目標',
      kind: 'play',
      cards: [],
      targets: [1],
      asCard: 'duel',
    };
    const dismantle: PlayOption = {
      id: 'dismantle',
      label: '拆 → 未知目標',
      kind: 'play',
      cards: [],
      targets: [1],
      asCard: 'dismantle',
    };
    const request = actionRequest(0, [duel, dismantle, slash, passOption]);
    state.pending = request;
    const view = viewFor(state, 0);
    const memory = createAiMemory();

    expect(decide(view, request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash',
    });
    // 同一回合第二張未知目標【殺】會被擋掉，只能 pass。
    expect(decide(view, request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('群體錦囊可能令忠臣死亡時不使用；開局期望值為正時使用', () => {
    const lethalState = fresh();
    lethalState.players[0]!.role = 'lord';
    lethalState.players[1]!.role = 'loyal';
    lethalState.players[1]!.hp = 1;
    lethalState.turn = 0;
    lethalState.turnCount = 1;
    const lethalAoe: PlayOption = {
      id: 'barbarian',
      label: '南蠻入侵',
      kind: 'play',
      cards: [],
      targets: [1, 2, 3, 4],
      asCard: 'barbarian',
    };
    const lethalRequest = actionRequest(0, [lethalAoe, passOption]);
    lethalState.pending = lethalRequest;
    expect(decide(viewFor(lethalState, 0), lethalRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const openState = fresh();
    openState.players[0]!.role = 'lord';
    openState.players[1]!.role = 'loyal';
    openState.turn = 0;
    openState.turnCount = 1;
    const openAoe: PlayOption = {
      id: 'barbarian',
      label: '南蠻入侵',
      kind: 'play',
      cards: [],
      targets: [1, 2, 3, 4],
      asCard: 'barbarian',
    };
    const openRequest = actionRequest(0, [openAoe, passOption]);
    openState.pending = openRequest;
    expect(decide(viewFor(openState, 0), openRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'barbarian',
    });
  });

  it('被【借刀殺人】時，不會對藤甲敵人打出無效【殺】', () => {
    const state = fresh();
    state.players[0]!.role = 'rebel';
    state.players[0]!.hand = [card(10008, 'slash', 'spade', 7)];
    state.players[1]!.role = 'lord';
    state.players[1]!.equips.armor = card(10009, 'vine_armor', 'spade', 2);

    const play: ResponseOption = {
      id: 'play',
      label: '打出',
      kind: 'respond',
      cards: [10008],
      asCard: 'slash',
    };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    const request: Request = {
      id: 202,
      player: 0,
      prompt: '是否打出【殺】？',
      kind: 'response',
      need: 'sha',
      options: [play, pass],
      context: '借刀殺人',
      targets: [1],
    };
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('決鬥：自己 1 血且無法打出【殺】時不發動', () => {
    const state = fresh();
    state.players[0]!.role = 'rebel';
    state.players[1]!.role = 'lord';
    state.players[0]!.hp = 1;
    state.players[0]!.hand = [card(10021, 'duel', 'club', 1)];
    state.turnCount = 3;

    const duel: PlayOption = {
      id: 'duel',
      label: '決鬥 → 主公',
      kind: 'play',
      cards: [10021],
      targets: [1],
      asCard: 'duel',
    };
    const request = actionRequest(0, [duel, passOption]);
    state.pending = request;

    // 沒有【殺】時，對手只要打出一張【殺】就會直接送命 → 不賭。
    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('偏友：可攻擊目標只有偏友時，應選擇結束出牌階段', () => {
    const state = fresh();
    state.players.forEach((player, index) => {
      player.role = index === 0 ? 'lord' : index === 1 ? 'rebel' : index === 2 ? 'loyal' : index === 3 ? 'spy' : 'rebel';
      player.hand = [];
    });
    // 內奸與一名反賊已公開死亡，讓玩家 3 的忠誠證據能成為「偏友」。
    state.players[3]!.alive = false;
    state.players[4]!.alive = false;
    state.players[0]!.hand = [card(10022, 'slash', 'spade', 7)];
    state.turnCount = 3;

    const memory = createAiMemory();
    seedBeliefScore(memory, 2, -2);

    const slash: PlayOption = {
      id: 'slash',
      label: '殺 → 偏友',
      kind: 'play',
      cards: [10022],
      targets: [2],
      asCard: 'slash',
    };
    const request = actionRequest(0, [slash, passOption]);
    state.pending = request;
    const view = viewFor(state, 0);
    // 前提：玩家 3 在這個局面下確實是「偏友」。
    expect(beliefsFor(view, memory, 0).cells.find((cell) => cell.target === 2)!.relation).toBe('ally');

    expect(decide(view, request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });
});

describe('反賊焦點與主公保護', () => {
  const passOption: PlayOption = {
    id: 'pass',
    label: '結束出牌階段',
    kind: 'pass',
    cards: [],
    targets: [],
  };

  function actionRequest(player: number, options: PlayOption[]): Request {
    return {
      id: 300,
      player,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options,
      context: '出牌階段',
    };
  }

  it('第一個反賊死亡後，剩餘反賊會把其他非主公當成確定敵人', () => {
    const state = fresh();
    state.players.forEach((player, index) => {
      player.hand = [];
      player.hp = 4;
      player.maxHp = 4;
      player.alive = index !== 4;
      player.role = index === 0 ? 'rebel' : index === 1 ? 'lord' : index === 4 ? 'rebel' : 'loyal';
    });
    const duel: PlayOption = {
      id: 'duel:unknown',
      label: '決鬥 → 未知目標',
      kind: 'play',
      cards: [],
      targets: [2],
      asCard: 'duel',
    };
    const request = actionRequest(0, [duel, passOption]);
    state.pending = request;

    // 未有死亡資訊時，未知目標不是確定敵人，不用【決鬥】賭隊友。
    state.publicEvents = [];
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory())).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 一名反賊公開死亡後，自己就是唯一反賊，其他非主公必為敵人。
    state.publicEvents = [{ seq: 1, kind: 'death', source: null, target: 4, role: 'rebel' }];
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory())).toEqual({
      type: 'option',
      optionId: 'duel:unknown',
    });
  });

  it('反賊會用【桃】救公開可辨認的隊友，但不會救未知目標', () => {
    const state = fresh();
    state.players[0]!.role = 'rebel';
    state.players[2]!.role = 'rebel';
    state.players[2]!.alive = true;
    state.players[2]!.hp = 0;
    state.players[0]!.hand = [card(9500, 'peach', 'heart', 3)];

    const play: ResponseOption = {
      id: 'peach',
      label: '桃',
      kind: 'respond',
      cards: [9500],
      asCard: 'peach',
    };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    const request: Request = {
      id: 301,
      player: 0,
      prompt: '是否使用【桃】？',
      kind: 'response',
      need: 'peach',
      options: [play, pass],
      context: '瀕死',
    };
    state.pending = request;

    const memory = createAiMemory();
    memory.knownRole.set(2, 'rebel');
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory)).toEqual({
      type: 'option',
      optionId: 'peach',
    });
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory())).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('忠臣與內奸在還有其他人時，不會用群體錦囊傷害主公', () => {
    const aoe: PlayOption = {
      id: 'barbarian',
      label: '南蠻入侵',
      kind: 'play',
      cards: [],
      targets: [1, 2, 3, 4],
      asCard: 'barbarian',
    };

    const spyState = fresh();
    spyState.players[0]!.role = 'spy';
    spyState.players[1]!.role = 'lord';
    const spyRequest = actionRequest(0, [aoe, passOption]);
    spyState.pending = spyRequest;
    expect(decide(viewFor(spyState, 0), spyRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const loyalState = fresh();
    loyalState.players[0]!.role = 'loyal';
    loyalState.players[1]!.role = 'lord';
    const loyalRequest = actionRequest(0, [aoe, passOption]);
    loyalState.pending = loyalRequest;
    expect(decide(viewFor(loyalState, 0), loyalRequest, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });
});

describe('致命閘與高成本閘（各身份）', () => {
  function actionRequest(player: number, options: PlayOption[]): Request {
    return {
      id: 900,
      player,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options,
      context: '出牌階段',
    };
  }

  const passOption: PlayOption = {
    id: 'pass',
    label: '結束出牌階段',
    kind: 'pass',
    cards: [],
    targets: [],
  };

  /** 建立一局乾淨的測試狀態，並指定各座位身份。 */
  function setup(roles: Array<'lord' | 'loyal' | 'rebel' | 'spy'>): GameState {
    const state = fresh();
    state.turnCount = 2;
    state.publicEvents = [];
    state.players.forEach((player, index) => {
      player.role = roles[index] ?? 'loyal';
      player.hp = 4;
      player.maxHp = 4;
      player.alive = true;
      player.chained = false;
      player.wine = false;
      player.hand = [];
      player.judgeZone = [];
      player.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
    });
    return state;
  }

  function slashOption(id: string, targets: number[], extra: Partial<PlayOption> = {}): PlayOption {
    return { id, label: id, kind: 'play', cards: [9901], targets, asCard: 'slash', ...extra };
  }

  it('反賊：行為盟友佔住反賊名額後，其餘未知非主公視為已確認敵人', () => {
    const state = setup(['rebel', 'lord', 'loyal', 'loyal', 'loyal']);
    state.players[3]!.hp = 1;
    state.players[1]!.hp = 2; // 主公剩 2 血：收頭例外（7.3.17）不啟動，套用 L1 致命閘
    const option = slashOption('slash:3', [3]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    // 沒有行為盟友時，未知目標不是已確認敵人，致命【殺】被閘門擋下。
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 玩家 2 行為上像另一名反賊（分數 8），佔住反賊名額 → 玩家 3 不再可能是反賊。
    const memory = createAiMemory();
    seedBeliefScore(memory, 2, 8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:3',
    });
  });

  it('反賊：主公很健康時，1 血未知目標的致命【殺】不再空過（收頭例外 7.3.17）', () => {
    const state = setup(['rebel', 'lord', 'loyal', 'loyal', 'loyal']);
    state.players[3]!.hp = 1; // 主公 4/4 健康
    const option = slashOption('slash:3', [3]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:3',
    });
  });

  it('反賊不會對行為盟友（佔位的另一名反賊）使用致命【殺】', () => {
    const state = setup(['rebel', 'lord', 'loyal', 'loyal', 'loyal']);
    state.players[2]!.hp = 1;
    const option = slashOption('slash:2', [2]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    const memory = createAiMemory();
    seedBeliefScore(memory, 2, 8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('主公：曾公開擊殺忠臣的目標直接視為已確認敵人', () => {
    const state = setup(['lord', 'loyal', 'rebel', 'rebel', 'spy']);
    state.players[3]!.hp = 1;
    const option = slashOption('slash:3', [3]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    // 沒有紀錄時，hp1 的未知目標不是已確認敵人，致命【殺】被擋下。
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const memory = createAiMemory();
    memory.publicKilledLoyal.add(3);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:3',
    });
  });

  it('主公：忠臣已公開死亡後，其餘未知非主公皆視為已確認敵人', () => {
    const state = setup(['lord', 'loyal', 'loyal', 'rebel', 'spy']);
    state.players[3]!.hp = 1;
    state.publicEvents = [{ seq: 1, kind: 'death', source: null, target: 1, role: 'loyal' }];
    const option = slashOption('slash:3', [3]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:3',
    });
  });

  it('致命閘：屬性【殺】經鐵索傳導可能誤殺非敵人時不使用', () => {
    const state = setup(['lord', 'loyal', 'loyal', 'rebel', 'spy']);
    state.players[2]!.hp = 1;
    state.players[2]!.chained = true;
    state.players[3]!.hp = 4;
    state.players[3]!.chained = true;
    const option = slashOption('fire:3', [3], { asCard: 'fire_slash', nature: 'fire' });
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    const memory = createAiMemory();
    seedBeliefScore(memory, 3, 8); // 玩家 3 是已確認敵人，但玩家 2 未知且會被連環帶走。

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 解除玩家的連環狀態後，不再有非敵人會被傳導傷害帶走。
    state.players[2]!.chained = false;
    const safeMemory = createAiMemory();
    seedBeliefScore(safeMemory, 3, 8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, safeMemory, 'normal')).toEqual({
      type: 'option',
      optionId: 'fire:3',
    });
  });

  it('致命閘：火【殺】對藤甲目標 +1，未確認的 hp2 目標不放行', () => {
    const state = setup(['lord', 'loyal', 'loyal', 'rebel', 'spy']);
    state.players[3]!.hp = 2;
    state.players[3]!.equips.armor = card(9902, 'vine_armor', 'spade', 2);
    const option = slashOption('fire:3', [3], { asCard: 'fire_slash', nature: 'fire' });
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    // 火【殺】1 + 藤甲 1 = 2 ≥ hp2 → 視為致命，未知目標不放行。
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // hp3 時同一下不會致命，回復成可試探的低成本【殺】。
    state.players[3]!.hp = 3;
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'fire:3',
    });
  });

  it('致命閘：白銀獅子封頂加傷，避免把非致命誤判為致命', () => {
    const state = setup(['lord', 'loyal', 'loyal', 'rebel', 'spy']);
    state.players[0]!.equips.weapon = card(9903, 'ancient_scimitar', 'spade', 1);
    state.players[3]!.hp = 2;
    state.players[3]!.equips.armor = card(9904, 'silver_lion', 'spade', 2);
    const option = slashOption('slash:3', [3]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    // 古錠刀 +1 但白銀獅子封頂回 1，hp2 不致命 → 可試探。
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:3',
    });

    // 沒有白銀獅子：古錠刀令傷害變 2，hp2 會被帶走 → 擋下。
    state.players[3]!.equips.armor = null;
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('酒／裸衣加持的【殺】只打已確認敵人', () => {
    const state = setup(['lord', 'loyal', 'loyal', 'rebel', 'spy']);
    state.players[3]!.hp = 3;
    state.players[0]!.wine = true;
    const option = slashOption('slash:3', [3]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    const memory = createAiMemory();
    seedBeliefScore(memory, 3, 8); // 已確認敵人時才可用酒殺。
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:3',
    });

    // 【裸衣】同理：加傷當回合只打已確認敵人。
    state.players[0]!.wine = false;
    const luoyiMemory = createAiMemory();
    luoyiMemory.luoyiTurn = state.turnCount;
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, luoyiMemory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('方天畫戟多目標：其中一名非敵人會被致命時不使用', () => {
    const state = setup(['lord', 'loyal', 'loyal', 'rebel', 'spy']);
    state.players[2]!.hp = 1;
    state.players[3]!.hp = 4;
    const option = slashOption('slash:2+3', [2, 3]);
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    const memory = createAiMemory();
    seedBeliefScore(memory, 3, 8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    state.players[2]!.hp = 4;
    const safeMemory = createAiMemory();
    seedBeliefScore(safeMemory, 3, 8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, safeMemory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash:2+3',
    });
  });

  it('高成本閘推廣到反賊：只打已確認敵人，不在未知身上浪費【火攻】', () => {
    const state = setup(['rebel', 'lord', 'loyal', 'loyal', 'loyal']);
    const option: PlayOption = {
      id: 'fire_attack:3',
      label: '火攻',
      kind: 'play',
      cards: [9905],
      targets: [3],
      asCard: 'fire_attack',
    };
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    // 分數 −1：稍微不像反賊，但反賊機率仍高於已確認門檻，高成本【火攻】被擋。
    const memory = createAiMemory();
    seedBeliefScore(memory, 3, -1);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 分數 −8：公開行為足以斷定不是反賊 → 已確認敵人，可用高成本牌。
    const confirmed = createAiMemory();
    seedBeliefScore(confirmed, 3, -8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, confirmed, 'normal')).toEqual({
      type: 'option',
      optionId: 'fire_attack:3',
    });
  });

  it('高成本【離間】要求兩名目標都是已確認敵人', () => {
    const state = setup(['lord', 'loyal', 'rebel', 'rebel', 'spy']);
    const option: PlayOption = {
      id: 'lijian:2:3',
      label: '離間',
      kind: 'play',
      cards: [],
      targets: [2, 3],
      skill: 'lijian',
    };
    const request = actionRequest(0, [option, passOption]);
    state.pending = request;

    // 只有玩家 2 是已確認敵人時不使用。
    const half = createAiMemory();
    seedBeliefScore(half, 2, 8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, half, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    // 兩名都是已確認敵人時可用。
    const both = createAiMemory();
    seedBeliefScore(both, 2, 8);
    seedBeliefScore(both, 3, 8);
    expect(decide(viewFor(state, 0), request, { rngState: 1 }, both, 'normal')).toEqual({
      type: 'option',
      optionId: 'lijian:2:3',
    });
  });
});

describe('AI 寒冰劍判斷', () => {
  const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };

  function choiceRequest(player: number, target: number, damage: number): Request {
    const ice: ResponseOption = {
      id: 'ice_sword',
      label: '寒冰劍：防止此傷害，改為棄置目標兩張牌',
      kind: 'skill',
      cards: [],
      skill: 'ice_sword',
      targets: [target],
    };
    return {
      id: 901,
      player,
      prompt: '是否發動【寒冰劍】？',
      kind: 'response',
      need: 'choice',
      options: [ice, pass],
      context: '寒冰劍',
      targets: [target],
      damage,
    };
  }

  function stateWith(roles: Role[]): GameState {
    const state = fresh();
    state.turnCount = 2;
    state.publicEvents = [];
    state.players.forEach((player, index) => {
      player.role = roles[index]!;
      player.hp = 4;
      player.maxHp = 4;
      player.alive = true;
      player.hand = [];
      player.judgeZone = [];
      player.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
    });
    return state;
  }

  it('足以致命時不發動，直接造成傷害收頭', () => {
    const state = stateWith(['rebel', 'lord', 'loyal', 'rebel', 'spy']);
    state.players[1]!.hp = 1;
    state.players[1]!.hand = [card(9101, 'peach'), card(9102, 'dodge')];
    const request = choiceRequest(0, 1, 1);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('敵人尚不致命且有多張牌時會發動拆牌', () => {
    const state = stateWith(['rebel', 'lord', 'loyal', 'rebel', 'spy']);
    state.players[1]!.hp = 4;
    state.players[1]!.hand = [card(9103, 'peach'), card(9104, 'dodge')];
    const request = choiceRequest(0, 1, 1);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'ice_sword',
    });
  });

  it('敵人只剩一張未知手牌時不發動，保留傷害', () => {
    const state = stateWith(['rebel', 'lord', 'loyal', 'rebel', 'spy']);
    state.players[1]!.hp = 3;
    state.players[1]!.hand = [card(9105, 'peach')];
    const request = choiceRequest(0, 1, 1);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('目標不是已確認敵人時不發動，避免拆到可能的隊友', () => {
    // 主公對未知非主公：忠臣仍在，未知不當敵人。
    const state = stateWith(['lord', 'loyal', 'rebel', 'rebel', 'spy']);
    state.players[1]!.hp = 4;
    state.players[1]!.hand = [card(9106, 'peach'), card(9107, 'dodge')];
    const request = choiceRequest(0, 1, 1);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 })).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });
});

describe('內奸：反賊佔優時避免幫反賊', () => {
  function spyState(): GameState {
    const state = fresh();
    state.players.forEach((player, index) => {
      player.role = index === 0 ? 'spy' : index === 1 ? 'lord' : index === 2 ? 'loyal' : 'rebel';
      player.hand = [];
    });
    state.players[1]!.hp = 1; // 主公 1 血 → 反賊明顯佔優
    state.turnCount = 3;
    return state;
  }

  const passOption: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };

  function action(player: number, options: PlayOption[]): Request {
    return { id: 210, player, prompt: '出牌階段：請選擇行動', kind: 'action', options, context: '出牌階段' };
  }

  it('不對偏忠目標使用高成本敵意牌', () => {
    const state = spyState();
    state.players[0]!.hand = [card(11001, 'dismantle', 'club', 3), card(11002, 'duel', 'club', 1)];
    const memory = createAiMemory();
    seedBeliefScore(memory, 2, -2); // 玩家 3 偏忠

    const dismantle: PlayOption = { id: 'dismantle', label: '拆→偏忠', kind: 'play', cards: [11001], targets: [2], asCard: 'dismantle' };
    const duel: PlayOption = { id: 'duel', label: '決鬥→偏忠', kind: 'play', cards: [11002], targets: [2], asCard: 'duel' };
    const request = action(0, [dismantle, duel, passOption]);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });

  it('反賊未佔優時行為不變，仍可攻擊偏忠目標', () => {
    const state = spyState();
    state.players[1]!.hp = 4; // 主公健康
    state.players[3]!.alive = false; // 一名反賊死亡 → 反賊不再佔優
    state.players[0]!.hand = [card(11003, 'dismantle', 'club', 3)];
    const memory = createAiMemory();
    seedBeliefScore(memory, 2, -6);

    const dismantle: PlayOption = { id: 'dismantle', label: '拆→偏忠', kind: 'play', cards: [11003], targets: [2], asCard: 'dismantle' };
    const request = action(0, [dismantle, passOption]);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'dismantle',
    });
  });

  it('偏忠目標剩 2 血時不再補刀；3 血仍可施壓', () => {
    const state = spyState();
    state.players[0]!.hand = [card(11004, 'slash', 'spade', 7)];
    const memory = createAiMemory();
    seedBeliefScore(memory, 2, -2);

    const slash: PlayOption = { id: 'slash', label: '殺→偏忠', kind: 'play', cards: [11004], targets: [2], asCard: 'slash' };
    state.pending = action(0, [slash, passOption]);

    state.players[2]!.hp = 2;
    expect(decide(viewFor(state, 0), state.pending, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });

    state.players[2]!.hp = 3;
    expect(decide(viewFor(state, 0), state.pending, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'slash',
    });
  });

  it('反賊佔優時優先改打偏反目標', () => {
    const state = spyState();
    state.players[0]!.hand = [card(11005, 'dismantle', 'club', 3)];
    const memory = createAiMemory();
    seedBeliefScore(memory, 2, -2); // 偏忠
    seedBeliefScore(memory, 3, 6); // 偏反

    const atLoyal: PlayOption = { id: 'dismantle:loyal', label: '拆→偏忠', kind: 'play', cards: [11005], targets: [2], asCard: 'dismantle' };
    const atRebel: PlayOption = { id: 'dismantle:rebel', label: '拆→偏反', kind: 'play', cards: [11005], targets: [3], asCard: 'dismantle' };
    const request = action(0, [atLoyal, atRebel, passOption]);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'dismantle:rebel',
    });
  });

  it('被【借刀殺人】逼著打偏忠目標時拒絕', () => {
    const state = spyState();
    state.players[0]!.hand = [card(11006, 'slash', 'spade', 7)];
    const memory = createAiMemory();
    seedBeliefScore(memory, 2, -2);

    const play: ResponseOption = { id: 'play', label: '打出【殺】', kind: 'respond', cards: [11006], asCard: 'slash' };
    const pass: ResponseOption = { id: 'pass', label: '不出', kind: 'pass', cards: [] };
    const request: Request = {
      id: 211,
      player: 0,
      prompt: '是否打出【殺】？',
      kind: 'response',
      need: 'sha',
      options: [play, pass],
      context: '借刀殺人',
      targets: [2],
    };
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 'pass',
    });
  });
});

describe('反賊：王健康時優先收頭 1 血目標', () => {
  function rebelState(): GameState {
    const state = fresh();
    state.players.forEach((player, index) => {
      player.role = index === 0 ? 'rebel' : index === 1 ? 'lord' : index === 2 ? 'loyal' : 'rebel';
      player.hand = [];
      player.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
      player.judgeZone = [];
      player.alive = true;
      player.hp = 4;
      player.maxHp = 4;
    });
    state.turnCount = 3;
    return state;
  }

  const passOption: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };

  function action(player = 0, options: PlayOption[] = []): Request {
    return { id: 220, player, prompt: '出牌階段：請選擇行動', kind: 'action', options, context: '出牌階段' };
  }

  it('主公得很健康時，1 血隱藏目標的一刀收頭優先於打主公', () => {
    const state = rebelState();
    state.players[2]!.hp = 1; // 忠臣僅剩 1 血
    state.players[0]!.hand = [card(13001, 'slash', 'club', 7)];
    const atLoyal: PlayOption = { id: 's@loyal', label: '殺→目標2', kind: 'play', cards: [13001], targets: [2], asCard: 'slash' };
    const atLord: PlayOption = { id: 's@lord', label: '殺→主公', kind: 'play', cards: [13001], targets: [1], asCard: 'slash' };
    const request = action(0, [atLord, atLoyal, passOption]);
    state.pending = request;
    const memory = createAiMemory();

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 's@loyal',
    });
  });

  it('主公只差 2 血以上時行為不變（收頭例外不啟動）', () => {
    const state = rebelState();
    state.players[2]!.hp = 1;
    state.players[1]!.hp = 2; // 主公剩 2/4：不符合「非常健康」
    state.turnCount = 3;
    state.players[0]!.hand = [card(13002, 'slash', 'club', 7)];
    const atLoyal: PlayOption = { id: 's@loyal', label: '殺→目標2', kind: 'play', cards: [13002], targets: [2], asCard: 'slash' };
    const atLord: PlayOption = { id: 's@lord', label: '殺→主公', kind: 'play', cards: [13002], targets: [1], asCard: 'slash' };
    const request = action(0, [atLord, atLoyal, passOption]);
    state.pending = request;

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, createAiMemory(), 'normal')).toEqual({
      type: 'option',
      optionId: 's@lord',
    });
  });

  it('已相信是行為上的反賊隊友時不搶收頭', () => {
    const state = rebelState();
    state.players[2]!.hp = 1;
    state.players[0]!.hand = [card(13003, 'slash', 'club', 7)];
    const atLoyal: PlayOption = { id: 's@loyal', label: '殺→疑似隊友', kind: 'play', cards: [13003], targets: [2], asCard: 'slash' };
    const atLord: PlayOption = { id: 's@lord', label: '殺→主公', kind: 'play', cards: [13003], targets: [1], asCard: 'slash' };
    const request = action(0, [atLord, atLoyal, passOption]);
    state.pending = request;
    // 強烈的敵意證據讓玩家 2 幾乎肯定像反賊：仍不得收頭。
    const memory = createAiMemory();
    seedBeliefScore(memory, 2, 12);

    expect(decide(viewFor(state, 0), request, { rngState: 1 }, memory, 'normal')).toEqual({
      type: 'option',
      optionId: 's@lord',
    });
  });
});
