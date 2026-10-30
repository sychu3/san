import { describe, expect, it } from 'vitest';
import { createGame } from '../engine/state';
import { getPlayOptions, runGame } from '../engine/engine';
import { distance } from '../engine/rules';
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

function makeState(generals: string[], roles: Role[] = DEFAULT_ROLES, seed = 21): GameState {
  const state = createGame({ seed });
  state.deck = Array.from({ length: 80 }, (_, index) => card(7000 + index, 'dodge', 'heart', 2));
  state.discard = [];
  state.winner = null;
  state.turnCount = 1;
  state.delayedNames = {};
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

const option = (id: string): Response => ({ type: 'option', optionId: id });

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
      return { type: 'card', card: request.allowRandomHand ? -1 : (request.cards[0] ?? -1) };
    case 'chooseRevealed':
      return { type: 'card', card: request.cards[0]?.id ?? -1 };
    case 'chooseFrom':
      return { type: 'cards', cards: request.cards.slice(0, request.min).map((item) => item.id) };
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

describe('M3 第二批武將技能（判定與傷害）', () => {
  it('反饋：受到傷害後獲得來源的一張牌', () => {
    const state = makeState(['sima_yi', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(101, 'slash', 'spade', 7)];

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        return baseline(request, current);
      },
      (current) => logged(current, '反饋'),
      4000,
    );
    expect(state.players[0]!.hand.length).toBe(1);
    expect(logged(state, '反饋')).toBe(true);
  });

  it('鬼才：以手牌代替判定牌', () => {
    const state = makeState(['guan_yu', 'zhang_fei', 'sima_yi', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(110, 'slash', 'spade', 7)];
    state.players[0]!.equips.armor = card(111, 'eight_diagram', 'spade', 2);
    state.players[2]!.hand = [card(112, 'peach', 'heart', 3)];
    // 判定牌：黑桃（八卦陣失敗），鬼才換成紅桃（成功）。
    state.deck[state.deck.length - 3] = card(113, 'dodge', 'spade', 5);

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'shan') {
          const bagua = request.options.find((item) => item.skill === 'bagua');
          if (bagua) return option(bagua.id);
        }
        if (request.kind === 'response' && request.need === 'choice') {
          const guicai = request.options.find((item) => item.skill === 'guicai');
          if (guicai) return option(guicai.id);
        }
        if (request.kind === 'chooseCards' && request.reason === '鬼才') {
          return { type: 'cards', cards: request.cards.slice(0, 1) };
        }
        return baseline(request, current);
      },
      (current) => logged(current, '鬼才'),
    );

    expect(state.players[0]!.hp).toBe(state.players[0]!.maxHp);
    expect(logged(state, '鬼才')).toBe(true);
  });

  it('剛烈：判定非紅桃時來源受到 1 點傷害', () => {
    const state = makeState(['xiahou_dun', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(120, 'slash', 'spade', 7)];
    // 張飛摸 2 張後，剛烈判定會抽到這張黑桃。
    state.deck[state.deck.length - 3] = card(121, 'dodge', 'spade', 5);

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'choice') {
          const ganglie = request.options.find((item) => item.skill === 'ganglie');
          if (ganglie) return option(ganglie.id);
          const damage = request.options.find((item) => item.skill === 'damage');
          if (damage) return option(damage.id);
        }
        return baseline(request, current);
      },
      (current) => current.players[1]!.hp < current.players[1]!.maxHp,
    );

    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp - 1);
  });

  it('遺計：受到傷害後摸兩張', () => {
    const state = makeState(['guo_jia', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(130, 'slash', 'spade', 7)];

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        return baseline(request, current);
      },
      (current) => logged(current, '遺計'),
      4000,
    );
    expect(state.players[0]!.hand.length).toBe(2);
  });

  it('天妒：判定後可獲得判定牌', () => {
    const state = makeState(['guo_jia', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(140, 'slash', 'spade', 7)];
    state.players[0]!.equips.armor = card(141, 'eight_diagram', 'spade', 2);

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'shan') {
          const bagua = request.options.find((item) => item.skill === 'bagua');
          if (bagua) return option(bagua.id);
        }
        return baseline(request, current);
      },
      (current) => logged(current, '天妒'),
    );

    // 天妒拿到的判定牌會進入手牌。
    expect(state.players[0]!.hand).toHaveLength(1);
    expect(logged(state, '天妒')).toBe(true);
  });
});

describe('M3 第二批武將技能（出牌與轉化）', () => {
  it('突襲：放棄摸牌改為獲得其他角色手牌', () => {
    const state = makeState(['zhang_liao', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[1]!.hand = [card(150, 'peach', 'heart', 3)];

    drive(state, baseline, (_current, request) => request.kind === 'action' && request.player === 0);

    expect(state.players[1]!.hand).toHaveLength(0);
    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it('裸衣：少摸一張，本回合【殺】傷害 +1', () => {
    const state = makeState(['xu_chu', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(160, 'slash', 'spade', 7)];

    useOption(state, 0, (item) => item.asCard === 'slash' && item.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp - 2);
    expect(logged(state, '裸衣')).toBe(true);
  });

  it('苦肉：失去 1 點體力摸兩張', () => {
    const state = makeState(['huang_gai', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    useOption(state, 0, (item) => item.skill === 'kurou');
    expect(state.players[0]!.hp).toBe(state.players[0]!.maxHp - 1);
    // 摸牌階段 2 張 + 苦肉 2 張
    expect(state.players[0]!.hand).toHaveLength(4);
  });

  it('克己：未出【殺】則跳過棄牌階段', () => {
    const state = makeState(['lv_meng', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = Array.from({ length: 6 }, (_, index) => card(170 + index, 'peach', 'heart', 3));

    drive(state, baseline, (current) => logged(current, '克己'), 4000);
    // 起手 6 + 摸牌 2，未棄牌
    expect(state.players[0]!.hand).toHaveLength(8);
  });

  it('英姿：摸牌階段多摸一張', () => {
    const state = makeState(['zhou_yu', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    drive(state, baseline, (_current, request) => request.kind === 'action' && request.player === 0);
    expect(state.players[0]!.hand).toHaveLength(3);
  });

  it('反間：目標猜錯花色受到 1 點傷害', () => {
    const state = makeState(['zhou_yu', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(180, 'peach', 'heart', 3)];

    useOption(state, 0, (item) => item.skill === 'fanjian' && item.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp - 1);
    expect(logged(state, '反間')).toBe(true);
  });

  it('奇襲：黑色牌當【過河拆橋】', () => {
    const state = makeState(['gan_ning', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(190, 'peach', 'spade', 3)];
    state.players[1]!.equips.weapon = card(191, 'crossbow', 'club', 1);

    expect(
      getPlayOptions(state, state.players[0]!).some(
        (item) => item.skill === 'qixi' && item.targets[0] === 1,
      ),
    ).toBe(true);

    useOption(state, 0, (item) => item.skill === 'qixi' && item.targets[0] === 1);
    expect(state.players[1]!.equips.weapon).toBeNull();
  });

  it('國色：方塊牌當【樂不思蜀】放入判定區', () => {
    const state = makeState(['da_qiao', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(200, 'dodge', 'diamond', 2)];

    expect(
      getPlayOptions(state, state.players[0]!).some(
        (item) => item.skill === 'guose' && item.targets[0] === 1,
      ),
    ).toBe(true);

    useOption(state, 0, (item) => item.skill === 'guose' && item.targets[0] === 1);
    expect(state.players[1]!.judgeZone).toHaveLength(1);
    expect(Object.values(state.delayedNames)).toContain('indulgence');
  });

  it('結姻：棄兩張手牌，自己與目標各回復 1 點', () => {
    const state = makeState(['sun_shangxiang', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(210, 'peach', 'heart', 3), card(211, 'dodge', 'diamond', 2)];
    state.players[0]!.hp = 1;
    state.players[1]!.hp = 2;

    useOption(state, 0, (item) => item.skill === 'jieyin' && item.targets[0] === 1);
    expect(state.players[0]!.hp).toBe(2);
    expect(state.players[1]!.hp).toBe(3);
    expect(logged(state, '結姻')).toBe(true);
  });
});

describe('M3 第二批武將技能（鎖定與時機）', () => {
  it('空城：沒有手牌時不能成為【殺】或【決鬥】的目標', () => {
    const state = makeState(['guan_yu', 'zhuge_liang', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(220, 'slash', 'spade', 7), card(221, 'duel', 'club', 1)];
    state.players[1]!.hand = [];

    const options = getPlayOptions(state, state.players[0]!);
    expect(options.some((item) => item.asCard === 'slash' && item.targets[0] === 1)).toBe(false);
    expect(options.some((item) => item.asCard === 'duel' && item.targets[0] === 1)).toBe(false);
  });

  it('謙遜：不能成為【順手牽羊】或【樂不思蜀】的目標', () => {
    const state = makeState(['guan_yu', 'lu_xun', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(230, 'snatch', 'diamond', 3), card(231, 'indulgence', 'heart', 6)];
    state.players[1]!.hand = [card(232, 'peach', 'heart', 3)];

    const options = getPlayOptions(state, state.players[0]!);
    expect(options.some((item) => item.asCard === 'snatch' && item.targets[0] === 1)).toBe(false);
    expect(options.some((item) => item.asCard === 'indulgence' && item.targets[0] === 1)).toBe(false);
  });

  it('馬術：與其他角色的距離 -1', () => {
    const state = makeState(['ma_chao', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    expect(distance(state, 0, 2)).toBe(1);
  });

  it('鐵騎：判定紅色時目標不能使用【閃】', () => {
    const state = makeState(['ma_chao', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(240, 'slash', 'spade', 7)];
    state.players[1]!.hand = [card(241, 'dodge', 'diamond', 2)];

    useOption(state, 0, (item) => item.asCard === 'slash' && item.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp - 1);
    expect(state.players[1]!.hand.some((item) => item.name === 'dodge')).toBe(true);
  });

  it('流離：棄一張牌將【殺】轉移給其他角色', () => {
    const state = makeState(['guan_yu', 'da_qiao', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.players[0]!.hand = [card(250, 'slash', 'spade', 7)];
    state.players[1]!.hand = [card(251, 'dodge', 'diamond', 2)];

    useOption(state, 0, (item) => item.asCard === 'slash' && item.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(state.players[1]!.maxHp);
    expect(state.players[2]!.hp).toBe(state.players[2]!.maxHp - 1);
    expect(logged(state, '流離')).toBe(true);
  });

  it('傾國：黑色手牌當【閃】', () => {
    const state = makeState(['zhen_ji', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(260, 'slash', 'spade', 7)];
    state.players[0]!.hand = [card(261, 'peach', 'spade', 3)];

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'response' && request.need === 'shan') {
          const qingguo = request.options.find((item) => item.skill === 'qingguo');
          if (qingguo) return option(qingguo.id);
        }
        return baseline(request, current);
      },
      (current, request) => request.kind === 'action' && request.player === 1 && current.players[0]!.hand.length === 0,
    );

    expect(state.players[0]!.hp).toBe(state.players[0]!.maxHp);
  });

  it('觀星：將選定的牌移到牌堆底', () => {
    const state = makeState(['zhuge_liang', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.deck = Array.from({ length: 5 }, (_, index) =>
      card(8000 + index, 'dodge', 'heart', (index + 1) as Card['rank']),
    );

    drive(
      state,
      (request, current) => {
        if (request.kind === 'chooseFrom' && request.reason === '觀星') {
          return { type: 'cards', cards: [8004] };
        }
        return baseline(request, current);
      },
      (_current, request) => request.kind === 'action' && request.player === 0,
    );

    // 8004 被移到牌堆底（陣列前端）。
    expect(state.deck[0]!.id).toBe(8004);
    expect(logged(state, '觀星')).toBe(true);
  });

  it('洛神：黑色判定牌入手並可重複，紅色置於牌堆頂', () => {
    const state = makeState(['zhen_ji', 'guan_yu', 'zhao_yun', 'lv_bu', 'diao_chan']);
    state.deck = [
      card(8102, 'dodge', 'heart', 2),
      card(8101, 'dodge', 'heart', 3),
      card(8100, 'dodge', 'club', 4),
    ];

    drive(state, baseline, (_current, request) => request.kind === 'action' && request.player === 0);

    expect(state.players[0]!.hand.some((item) => item.id === 8100)).toBe(true);
    expect(logged(state, '洛神')).toBe(true);
  });

  it('連營：失去最後一張手牌時摸一張', () => {
    const state = makeState(['lu_xun', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(270, 'duel', 'club', 1)];
    state.players[0]!.hand = [card(271, 'slash', 'spade', 7)];

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'duel' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        return baseline(request, current);
      },
      (current) => logged(current, '連營'),
      4000,
    );
    expect(state.players[0]!.hand.length).toBeGreaterThanOrEqual(1);
    expect(logged(state, '連營')).toBe(true);
  });

  it('梟姬：失去裝備區的牌時摸兩張', () => {
    const state = makeState(['sun_shangxiang', 'zhang_fei', 'guan_yu', 'zhao_yun', 'lv_bu']);
    state.turn = 1;
    state.players[1]!.hand = [card(280, 'dismantle', 'club', 3)];
    state.players[0]!.equips.weapon = card(281, 'crossbow', 'club', 1);

    drive(
      state,
      (request, current) => {
        if (request.kind === 'action' && request.player === 1) {
          const found = request.options.find(
            (item) => item.asCard === 'dismantle' && item.targets[0] === 0,
          );
          if (found) return option(found.id);
        }
        if (request.kind === 'chooseCard') {
          const weapon = request.cards.find((id) => id === 281);
          if (weapon !== undefined) return { type: 'card', card: weapon };
        }
        return baseline(request, current);
      },
      (current) => logged(current, '梟姬'),
    );

    expect(state.players[0]!.hand).toHaveLength(2);
    expect(logged(state, '梟姬')).toBe(true);
  });
});
