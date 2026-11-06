import { describe, expect, it } from 'vitest';
import { createGame, viewFor } from '../engine/state';
import { getPlayOptions, runGame } from '../engine/engine';
import { getGeneral } from '../data/generals';
import type { Card, GameState, Request, Response, Role } from '../engine/types';

function card(
  id: number,
  name: Card['name'],
  suit: Card['suit'] = 'spade',
  rank: Card['rank'] = 7,
): Card {
  return { id, name, suit, rank };
}

const DEFAULT_ROLES: Role[] = ['rebel', 'lord', 'loyal', 'rebel', 'spy'];

/** 建立固定武將／身份、手牌可控的對局。 */
function makeState(generals: string[], roles: Role[] = DEFAULT_ROLES, seed = 11): GameState {
  const state = createGame({ seed });
  state.deck = Array.from({ length: 80 }, (_, index) => card(7000 + index, 'dodge', 'heart', 2));
  state.discard = [];
  state.winner = null;
  state.turnCount = 1;
  state.players.forEach((player, index) => {
    const generalId = generals[index]!;
    const role = roles[index]!;
    const general = getGeneral(generalId);
    player.generalId = generalId;
    player.role = role;
    player.maxHp = general.maxHp + (role === 'lord' ? 1 : 0);
    player.hp = player.maxHp;
    player.hand = [];
    player.judgeZone = [];
    player.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
    player.chained = false;
    player.alive = true;
    player.wine = false;
    player.wineUsed = false;
    player.slashUsed = 0;
    player.marks = {};
  });
  state.turn = 0;
  return state;
}

type Handler = (request: Request, state: GameState) => Response;

function option(id: string): Response {
  return { type: 'option', optionId: id };
}

function baseline(request: Request, state: GameState): Response {
  void state;
  switch (request.kind) {
    case 'action': {
      const pass = request.options.find((item) => item.kind === 'pass');
      return pass ? option(pass.id) : option(request.options[0]!.id);
    }
    case 'response': {
      const first = request.options.find((item) => item.kind !== 'pass');
      return first ? option(first.id) : { type: 'pass' };
    }
    case 'chooseCards':
      return { type: 'cards', cards: request.cards.slice(0, request.min) };
    case 'choosePlayers':
      return { type: 'players', players: request.candidates.slice(0, request.min) };
    case 'chooseCard':
      return {
        type: 'card',
        card: request.allowRandomHand ? -1 : (request.cards[0] ?? -1),
      };
    case 'chooseRevealed':
      return { type: 'card', card: request.cards[0]?.id ?? -1 };
    default:
      return { type: 'pass' };
  }
}

function drive(
  state: GameState,
  handler: Handler,
  stop: (state: GameState, request: Request) => boolean,
  maxRequests = 4000,
): Request | null {
  const generator = runGame(state);
  let step = generator.next();
  let count = 0;
  while (!step.done) {
    if (stop(state, step.value)) return step.value;
    count += 1;
    if (count > maxRequests) throw new Error('drive exceeded budget');
    step = generator.next(handler(step.value, state));
  }
  return null;
}

/** 使用一張符合條件的行動牌，直到回到該玩家的下一個出牌請求。 */
function useOption(
  state: GameState,
  player: number,
  matcher: (option: {
    id: string;
    asCard?: string;
    skill?: string;
    targets: number[];
    cards: number[];
  }) => boolean,
  handler: Handler = baseline,
): Request | null {
  let used = false;
  return drive(
    state,
    (request, current) => {
      if (!used && request.kind === 'action' && request.player === player) {
        const found = request.options.find((item) => matcher(item));
        if (found) {
          used = true;
          return option(found.id);
        }
      }
      return handler(request, current);
    },
    (_current, request) => used && request.kind === 'action' && request.player === player,
  );
}

function logged(state: GameState, text: string): boolean {
  return state.log.some((entry) => entry.text.includes(text));
}

describe('M3 首批武將技能', () => {
  it('奸雄：受到傷害後可獲得造成傷害的牌', () => {
    const state = makeState(['cao_cao', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(101, 'slash', 'spade', 7)];
    const slash = state.players[1]!.hand[0]!;

    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'choice') {
          const found = request.options.find((item) => item.skill === 'jianxiong');
          if (found) return option(found.id);
        }
        return baseline(request, state);
      },
      (current) => logged(current, '奸雄'),
    );

    expect(state.players[0]!.hp).toBe(3);
    expect(state.players[0]!.hand.some((item) => item.id === slash.id)).toBe(true);
  });

  it('護駕：主公曹操可令魏勢力角色代打【閃】', () => {
    const state = makeState(['zhang_fei', 'cao_cao', 'xiahou_dun', 'zhao_yun', 'lv_bu']);
    state.turn = 0;
    state.players[0]!.hand = [card(102, 'slash', 'spade', 7)];
    state.players[2]!.hand = [card(103, 'dodge', 'diamond', 2)];

    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 0) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 1,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'shan') {
          const dodge = request.options.find((item) => item.asCard === 'dodge');
          if (dodge) return option(dodge.id);
        }
        return baseline(request, state);
      },
      (current) => logged(current, '護駕'),
    );

    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp);
    expect(logged(state, '護駕')).toBe(true);
  });

  it('護駕：主公手上有【閃】時仍可選擇發動護駕', () => {
    const state = makeState(['zhang_fei', 'cao_cao', 'xiahou_dun', 'zhao_yun', 'lv_bu']);
    state.turn = 0;
    state.players[0]!.hand = [card(104, 'slash', 'spade', 7)];
    state.players[1]!.hand = [card(105, 'dodge', 'heart', 2)];
    state.players[2]!.hand = [card(106, 'dodge', 'diamond', 2)];

    let sawHujia = false;
    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 0) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 1,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'shan' && request.player === 1) {
          const hujia = request.options.find((item) => item.skill === 'hujia');
          if (hujia) {
            sawHujia = true;
            return option(hujia.id);
          }
        }
        return baseline(request, state);
      },
      (current) => logged(current, '護駕'),
    );

    expect(sawHujia).toBe(true);
    expect(logged(state, '護駕')).toBe(true);
    // 曹操自己的【閃】保留。
    expect(state.players[1]!.hand.map((item) => item.id)).toContain(105);
  });

  it('激將：出牌階段可令蜀勢力角色代打【殺】', () => {
    const state = makeState(
      ['liu_bei', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu'],
      ['lord', 'rebel', 'loyal', 'rebel', 'spy'],
    );
    state.turn = 0;
    state.players[2]!.hand = [card(107, 'slash', 'spade', 7)];

    let usedJijiang = false;
    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 0) {
          const jijiang = request.options.find(
            (item) => item.skill === 'jijiang' && item.targets[0] === 1,
          );
          if (jijiang) {
            usedJijiang = true;
            return option(jijiang.id);
          }
        }
        return baseline(request, state);
      },
      (current) => current.players[1]!.hp < current.players[1]!.maxHp,
    );

    expect(usedJijiang).toBe(true);
    expect(logged(state, '激將')).toBe(true);
    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp - 1);
    expect(state.players[0]!.slashUsed).toBe(1);
  });

  it('激將：盟友沒有【殺】時回到本人出牌', () => {
    const state = makeState(['zhang_fei', 'liu_bei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 0;
    state.players[0]!.hand = [card(108, 'duel', 'club', 1)];
    state.players[1]!.hand = [card(109, 'slash', 'spade', 7)];

    let pickedJijiang = false;
    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 0) {
          const found = request.options.find(
            (item) => item.asCard === 'duel' && item.targets[0] === 1,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'sha' && request.player === 1) {
          const jijiang = request.options.find((item) => item.skill === 'jijiang');
          if (jijiang && !pickedJijiang) {
            pickedJijiang = true;
            return option(jijiang.id);
          }
        }
        return baseline(request, state);
      },
      (current) =>
        logged(current, '沒有蜀勢力角色回應') &&
        current.players[0]!.hp < current.players[0]!.maxHp,
      4000,
    );

    expect(pickedJijiang).toBe(true);
    // 劉備最後用自己的【殺】贏得決鬥。
    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp);
  });

  it('仁德：交給兩張牌後回復 1 點體力', () => {
    const state = makeState(['liu_bei', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.players[0]!.hp = 2;
    state.players[0]!.hand = [card(110, 'peach', 'heart', 3), card(111, 'dodge', 'diamond', 2)];

    useOption(
      state,
      0,
      (item) => item.skill === 'rende' && item.targets[0] === 1,
      (request, current) => {
        if (request.kind === 'chooseCards' && request.reason === '仁德') {
          return { type: 'cards', cards: request.cards.slice(0, 2) };
        }
        return baseline(request, current);
      },
    );

    expect(state.players[0]!.hp).toBe(3);
    expect(logged(state, '仁德')).toBe(true);
  });

  it('仁德：記錄公開 give 事件，並標記是否破壞空城', () => {
    const state = makeState(['liu_bei', 'zhuge_liang', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.players[0]!.hand = [card(112, 'slash', 'spade', 7), card(113, 'wine', 'spade', 9)];
    state.players[1]!.hand = [];

    useOption(
      state,
      0,
      (item) => item.skill === 'rende' && item.targets[0] === 1,
      (request, current) => {
        if (request.kind === 'chooseCards' && request.reason === '仁德') {
          expect(request.skill).toBe('rende');
          expect(request.target).toBe(1);
          return { type: 'cards', cards: request.cards.slice(0, 1) };
        }
        return baseline(request, current);
      },
    );

    const give = state.publicEvents.find((event) => event.kind === 'give');
    expect(give).toMatchObject({
      kind: 'give',
      source: 0,
      target: 1,
      amount: 1,
      brokeKongcheng: true,
    });
  });

  it('激將：主公劉備可令蜀勢力角色代打【殺】', () => {
    const state = makeState(['zhang_fei', 'liu_bei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 0;
    state.players[0]!.hand = [card(120, 'duel', 'club', 1)];
    state.players[2]!.hand = [card(121, 'slash', 'spade', 7)];

    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 0) {
          const found = request.options.find(
            (item) => item.asCard === 'duel' && item.targets[0] === 1,
          );
          if (found) return option(found.id);
        }
        return baseline(request, state);
      },
      (current) => logged(current, '激將'),
    );

    expect(logged(state, '激將')).toBe(true);
  });

  it('制衡：棄置任意張手牌並摸等量，每回合一次', () => {
    const state = makeState(['sun_quan', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.players[0]!.hand = [card(130, 'wine', 'spade', 9)];

    useOption(
      state,
      0,
      (item) => item.skill === 'zhiheng',
      (request, current) => {
        if (request.kind === 'chooseCards' && request.reason === '制衡') {
          return { type: 'cards', cards: request.cards.slice(0, 2) };
        }
        return baseline(request, current);
      },
    );

    expect(state.players[0]!.marks.zhiheng_used).toBe(true);
    expect(state.players[0]!.hand.length).toBe(3);
    expect(logged(state, '制衡')).toBe(true);
  });

  it('救援：吳勢力角色救主公孫權時，桃的回復值 +1', () => {
    const state = makeState(['zhang_fei', 'sun_quan', 'gan_ning', 'zhao_yun', 'lv_bu']);
    state.turn = 0;
    state.players[0]!.hand = [card(140, 'slash', 'spade', 7)];
    state.players[1]!.hp = 1;
    state.players[2]!.hand = [card(141, 'peach', 'heart', 3)];

    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 0) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 1,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'peach') {
          const peach = request.options.find((item) => item.asCard === 'peach');
          if (peach) return option(peach.id);
        }
        return baseline(request, state);
      },
      (current) => logged(current, '救援'),
    );

    expect(state.players[1]!.hp).toBe(2);
    expect(logged(state, '救援')).toBe(true);
  });

  it('武聖：紅色牌當【殺】使用', () => {
    const state = makeState(['guan_yu', 'zhang_fei', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(150, 'peach', 'heart', 3)];

    const option = getPlayOptions(state, state.players[0]!).find(
      (item) => item.skill === 'wusheng' && item.targets[0] === 1,
    );
    expect(option).toBeDefined();

    useOption(state, 0, (item) => item.skill === 'wusheng' && item.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp - 1);
  });

  it('咆哮：張飛使用【殺】不受每回合一次限制', () => {
    const paoxiao = makeState(['zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    paoxiao.players[0]!.hand = [card(160, 'slash', 'spade', 7)];
    paoxiao.players[0]!.slashUsed = 1;
    expect(getPlayOptions(paoxiao, paoxiao.players[0]!).some((item) => item.asCard === 'slash')).toBe(true);

    const normal = makeState(['lv_bu', 'guan_yu', 'zhao_yun', 'zhang_fei', 'diao_chan']);
    normal.players[0]!.hand = [card(161, 'slash', 'spade', 7)];
    normal.players[0]!.slashUsed = 1;
    expect(getPlayOptions(normal, normal.players[0]!).some((item) => item.asCard === 'slash')).toBe(false);
  });

  it('龍膽：【閃】當【殺】、【殺】當【閃】', () => {
    const attack = makeState(['zhao_yun', 'zhang_fei', 'guan_yu', 'lv_bu', 'diao_chan']);
    attack.players[0]!.hand = [card(170, 'dodge', 'diamond', 2)];
    expect(
      getPlayOptions(attack, attack.players[0]!).some(
        (item) => item.skill === 'longdan' && item.targets[0] === 1,
      ),
    ).toBe(true);
    useOption(attack, 0, (item) => item.skill === 'longdan' && item.targets[0] === 1);
    expect(attack.players[1]!.hp).toBe(attack.players[1]!.maxHp - 1);

    const defend = makeState(['zhang_fei', 'zhao_yun', 'guan_yu', 'lv_bu', 'diao_chan']);
    defend.turn = 0;
    defend.players[0]!.hand = [card(171, 'slash', 'spade', 7)];
    defend.players[1]!.hand = [card(172, 'slash', 'club', 8)];

    drive(
      defend,
      (request, current) => {
        if (request.kind === 'action' && request.player === 0) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 1,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'shan') {
          const longdan = request.options.find((item) => item.skill === 'longdan');
          if (longdan) return option(longdan.id);
        }
        return baseline(request, current);
      },
      (current, request) =>
        request.kind === 'action' &&
        request.player === 0 &&
        current.players[0]!.slashUsed > 0,
    );

    expect(defend.players[1]!.hp).toBe(defend.players[1]!.maxHp);
  });

  it('集智：使用非延時錦囊時摸一張', () => {
    const state = makeState(['huang_yueying', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.players[0]!.hand = [card(180, 'ex_nihilo', 'heart', 7)];

    useOption(state, 0, (item) => item.asCard === 'ex_nihilo');
    expect(logged(state, '集智')).toBe(true);
    // 起手 1 + 摸牌階段 2 - 使用 1 + 無中生有 2 + 集智 1 = 5
    expect(state.players[0]!.hand.length).toBe(5);
  });

  it('奇才：使用錦囊不受距離限制', () => {
    const qicai = makeState(['huang_yueying', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    qicai.players[0]!.hand = [card(190, 'snatch', 'diamond', 3)];
    qicai.players[2]!.hand = [card(191, 'peach', 'heart', 3)];
    expect(
      getPlayOptions(qicai, qicai.players[0]!).some(
        (item) => item.asCard === 'snatch' && item.targets[0] === 2,
      ),
    ).toBe(true);

    const normal = makeState(['guan_yu', 'zhang_fei', 'zhao_yun', 'lv_bu', 'diao_chan']);
    normal.players[0]!.hand = [card(192, 'snatch', 'diamond', 3)];
    normal.players[2]!.hand = [card(193, 'peach', 'heart', 3)];
    expect(
      getPlayOptions(normal, normal.players[0]!).some(
        (item) => item.asCard === 'snatch' && item.targets[0] === 2,
      ),
    ).toBe(false);
  });

  it('無雙：呂布使用【殺】時，目標需連續打出兩張【閃】', () => {
    const oneDodge = makeState(['lv_bu', 'zhang_fei', 'guan_yu', 'zhao_yun', 'diao_chan']);
    oneDodge.players[0]!.hand = [card(200, 'slash', 'spade', 7)];
    oneDodge.players[1]!.hand = [card(201, 'dodge', 'diamond', 2)];
    useOption(
      oneDodge,
      0,
      (item) => item.asCard === 'slash' && item.targets[0] === 1,
      (request, current) => {
        if (request.kind === 'response' && request.need === 'shan') {
          const dodge = request.options.find((item) => item.asCard === 'dodge');
          if (dodge) return option(dodge.id);
        }
        return baseline(request, current);
      },
    );
    expect(oneDodge.players[1]!.hp).toBe(oneDodge.players[1]!.maxHp - 1);

    const twoDodge = makeState(['lv_bu', 'zhang_fei', 'guan_yu', 'zhao_yun', 'diao_chan']);
    twoDodge.players[0]!.hand = [card(202, 'slash', 'spade', 7)];
    twoDodge.players[1]!.hand = [card(203, 'dodge', 'diamond', 2), card(204, 'dodge', 'heart', 3)];
    useOption(
      twoDodge,
      0,
      (item) => item.asCard === 'slash' && item.targets[0] === 1,
      (request, current) => {
        if (request.kind === 'response' && request.need === 'shan') {
          const dodge = request.options.find((item) => item.asCard === 'dodge');
          if (dodge) return option(dodge.id);
        }
        return baseline(request, current);
      },
    );
    expect(twoDodge.players[1]!.hp).toBe(twoDodge.players[1]!.maxHp);
    expect(logged(twoDodge, '無雙')).toBe(true);
  });

  it('離間：令兩名男性角色決鬥', () => {
    const state = makeState(['diao_chan', 'zhang_fei', 'lv_bu', 'guan_yu', 'zhao_yun']);
    state.players[0]!.hand = [card(210, 'peach', 'heart', 3)];

    useOption(
      state,
      0,
      (item) => item.skill === 'lijian' && item.targets[0] === 1 && item.targets[1] === 2,
      (request, current) => {
        if (request.kind === 'chooseCards' && request.reason === '離間') {
          return { type: 'cards', cards: request.cards.slice(0, 1) };
        }
        return baseline(request, current);
      },
    );

    // 由第一人對第二人使用【決鬥】，因此第二人先被打出【殺】。
    expect(state.players[2]!.hp).toBe(state.players[2]!.maxHp - 1);
    expect(logged(state, '離間')).toBe(true);
  });

  it('閉月：結束階段摸一張', () => {
    const state = makeState(['diao_chan', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    const before = state.players[0]!.hand.length;
    drive(state, baseline, (current) => logged(current, '閉月'), 4000);
    expect(logged(state, '閉月')).toBe(true);
    expect(state.players[0]!.hand.length).toBe(before + 2 + 1);
  });

  it('急救：華佗在回合外將紅色牌當【桃】救人', () => {
    const state = makeState(['hua_tuo', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(220, 'slash', 'spade', 7)];
    state.players[2]!.hp = 1;
    state.players[0]!.hand = [card(221, 'dodge', 'heart', 2)];

    drive(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 2,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'peach') {
          const jijiu = request.options.find((item) => item.skill === 'jijiu');
          if (jijiu) return option(jijiu.id);
        }
        return baseline(request, state);
      },
      (current) => logged(current, '急救'),
    );

    expect(state.players[2]!.hp).toBe(1);
    expect(logged(state, '急救')).toBe(true);
  });

  it('青囊：棄一張手牌，令一名角色回復 1 點，每回合一次', () => {
    const state = makeState(['hua_tuo', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.players[0]!.hand = [card(230, 'wine', 'spade', 9)];
    state.players[1]!.hp = 2;

    useOption(
      state,
      0,
      (item) => item.skill === 'qingnang' && item.targets[0] === 1,
      (request, current) => {
        if (request.kind === 'chooseCards' && request.reason === '青囊') {
          return { type: 'cards', cards: request.cards.slice(0, 1) };
        }
        return baseline(request, current);
      },
    );

    expect(state.players[1]!.hp).toBe(3);
    expect(state.players[0]!.marks.qingnang_used).toBe(true);
    expect(logged(state, '青囊')).toBe(true);
  });

  it('對局結束後公開所有玩家的身份', () => {
    const state = createGame({ seed: 5 });
    state.winner = { roles: ['lord'], reason: '測試' };
    const view = viewFor(state, 0);
    expect(view.players.every((player) => player.role !== null)).toBe(true);
  });
});
