import { describe, expect, it } from 'vitest';
import { createGame } from '../engine/state';
import { getPlayOptions, runGame } from '../engine/engine';
import type { Card, GameState, Request, Response } from '../engine/types';

function card(
  id: number,
  name: Card['name'],
  suit: Card['suit'] = 'spade',
  rank: Card['rank'] = 7,
): Card {
  return { id, name, suit, rank };
}

function fresh(seed = 7): GameState {
  const state = createGame({ seed });
  state.turn = 0;
  state.winner = null;
  state.deck = Array.from({ length: 40 }, (_, index) =>
    card(5000 + index, 'dodge', index % 2 === 0 ? 'heart' : 'diamond', 2),
  );
  state.discard = [];
  state.players.forEach((player, index) => {
    // 固定成不影響牌局選項的武將，避免第二批技能改變選項數量。
    player.generalId = 'zhang_fei';
    player.hand = [];
    player.hp = 5;
    player.maxHp = 5;
    player.alive = true;
    player.chained = false;
    player.wine = false;
    player.wineUsed = false;
    player.slashUsed = 0;
    player.judgeZone = [];
    player.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
    player.role = index === 1 ? 'lord' : index === 0 ? 'rebel' : index === 2 ? 'loyal' : index === 3 ? 'rebel' : 'spy';
  });
  return state;
}

function baseline(request: Request): Response {
  switch (request.kind) {
    case 'action':
    case 'response': {
      const pass = request.options.find((option) => option.kind === 'pass');
      if (pass) return { type: 'option', optionId: pass.id };
      const first = request.options[0];
      return first ? { type: 'option', optionId: first.id } : { type: 'pass' };
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

type Handler = (request: Request, state: GameState) => Response;

function driveUntil(
  state: GameState,
  handler: Handler,
  stop: (request: Request, state: GameState) => boolean,
  maxRequests = 5000,
): Request | null {
  const generator = runGame(state);
  let step = generator.next();
  let count = 0;
  while (!step.done) {
    if (stop(step.value, state)) return step.value;
    count += 1;
    if (count > maxRequests) throw new Error('driveUntil exceeded request budget');
    step = generator.next(handler(step.value, state));
  }
  return null;
}

/**
 * 使用一張指定的牌，並在結算完成、回到使用者下一個出牌請求時停止。
 */
function playAction(
  state: GameState,
  player: number,
  matcher: (option: { id: string; asCard?: string; skill?: string; targets: number[]; cards: number[] }) => boolean,
  handler: Handler = baseline,
): Request | null {
  let used = false;
  return driveUntil(
    state,
    (request, current) => {
      if (!used && request.kind === 'action' && request.player === player) {
        const option = request.options.find((item) => matcher(item));
        if (option) {
          used = true;
          return { type: 'option', optionId: option.id };
        }
      }
      return handler(request, current);
    },
    (request) => used && request.kind === 'action' && request.player === player,
  );
}

function handOf(state: GameState, player: number): Card[] {
  return state.players[player]!.hand;
}

describe('M2 牌堆與虛擬牌', () => {
  it('預設對局使用完整 160 張牌堆', () => {
    const state = createGame({ seed: 1 });
    const inHands = state.players.reduce((sum, player) => sum + player.hand.length, 0);
    expect(state.deck.length + inHands).toBe(160);
  });

  it('丈八蛇矛可用兩張手牌當【殺】', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(9001, 'serpent_spear', 'spade', 12);
    state.players[0]!.hand = [card(1, 'dodge', 'heart', 2), card(2, 'peach', 'heart', 3)];
    const option = getPlayOptions(state, state.players[0]!).find(
      (item) => item.skill === 'serpent_spear' && item.targets[0] === 1,
    );
    expect(option).toBeDefined();

    playAction(state, 0, (item) => item.skill === 'serpent_spear' && item.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(4);
    expect(state.players[0]!.hand).toHaveLength(2);
  });

  it('丈八蛇矛只提供每個目標一個選項，不隨手牌數平方成長', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(9002, 'serpent_spear', 'spade', 12);
    state.players[0]!.hand = Array.from({ length: 20 }, (_, index) =>
      card(9100 + index, 'dodge', 'diamond', 2),
    );
    const options = getPlayOptions(state, state.players[0]!);
    const spearOptions = options.filter((option) => option.skill === 'serpent_spear');
    expect(spearOptions).toHaveLength(4);
    expect(options.length).toBeLessThan(20);
  });

  it('丈八蛇矛不會把【空城】目標列為選項', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(9003, 'serpent_spear', 'spade', 12);
    state.players[0]!.hand = [card(9004, 'dodge', 'heart', 2), card(9005, 'peach', 'heart', 3)];
    state.players[1]!.generalId = 'zhuge_liang';
    state.players[1]!.hand = [];
    const options = getPlayOptions(state, state.players[0]!);
    expect(options.some((option) => option.skill === 'serpent_spear' && option.targets[0] === 1)).toBe(
      false,
    );
  });
});

describe('即時錦囊', () => {
  it('決鬥：目標不出【殺】受到 1 點傷害', () => {
    const state = fresh();
    state.players[0]!.hand = [card(10, 'duel', 'club', 1)];
    state.players[1]!.hand = [];
    playAction(state, 0, (option) => option.asCard === 'duel' && option.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(4);
  });

  it('決鬥：目標出【殺】後，使用者不出【殺】受到傷害', () => {
    const state = fresh();
    state.players[0]!.hand = [card(11, 'duel', 'club', 1)];
    state.players[1]!.hand = [card(12, 'slash', 'spade', 8)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'duel' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'sha' && request.player === 1) {
          const slash = request.options.find((item) => item.asCard === 'slash');
          if (slash) return { type: 'option', optionId: slash.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[0]!.hp).toBe(4);
    expect(state.players[1]!.hp).toBe(5);
  });

  it('南蠻入侵：沒有【殺】的目標受傷，有【殺】的目標不受傷', () => {
    const state = fresh();
    state.players[0]!.hand = [card(20, 'barbarian', 'spade', 7)];
    state.players[1]!.hand = [];
    state.players[2]!.hand = [card(21, 'slash', 'spade', 9)];
    state.players[3]!.hand = [card(22, 'slash', 'spade', 10)];
    state.players[4]!.hand = [card(23, 'slash', 'spade', 11)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'barbarian',
      (request) => {
        if (request.kind === 'response' && request.need === 'sha') {
          const slash = request.options.find((item) => item.asCard === 'slash');
          if (slash) return { type: 'option', optionId: slash.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(4);
    expect(state.players[2]!.hp).toBe(5);
  });

  it('萬箭齊發：沒有【閃】的目標受傷', () => {
    const state = fresh();
    state.players[0]!.hand = [card(30, 'arrows', 'heart', 1)];
    state.players[1]!.hand = [];
    state.players[2]!.hand = [card(31, 'dodge', 'diamond', 2)];
    state.players[3]!.hand = [card(32, 'dodge', 'diamond', 3)];
    state.players[4]!.hand = [card(33, 'dodge', 'diamond', 4)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'arrows',
      (request) => {
        if (request.kind === 'response' && request.need === 'shan') {
          const dodge = request.options.find((item) => item.asCard === 'dodge');
          if (dodge) return { type: 'option', optionId: dodge.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(4);
    expect(state.players[2]!.hp).toBe(5);
  });

  it('桃園結義：所有存活角色回復 1 點', () => {
    const state = fresh();
    state.players[0]!.hand = [card(40, 'peach_garden', 'heart', 1)];
    for (const player of state.players) player.hp = 3;
    playAction(state, 0, (option) => option.asCard === 'peach_garden');
    for (const player of state.players) expect(player.hp).toBe(4);
  });

  it('五穀豐登：翻開存活人數的牌，每人取得一張', () => {
    const state = fresh();
    state.players[0]!.hand = [card(50, 'harvest', 'heart', 3)];
    state.deck = [
      card(51, 'peach', 'heart', 4),
      card(52, 'dodge', 'diamond', 5),
      card(53, 'slash', 'spade', 6),
      card(54, 'wine', 'spade', 3),
      card(55, 'nullification', 'spade', 11),
      card(56, 'dodge', 'heart', 7),
      card(57, 'dodge', 'club', 8),
    ];
    playAction(state, 0, (option) => option.asCard === 'harvest');
    const gained = state.log.filter((entry) => entry.text.includes('獲得【'));
    expect(gained).toHaveLength(5);
    expect(state.players.reduce((sum, player) => sum + player.hand.length, 0)).toBeGreaterThanOrEqual(5);
  });

  it('火攻：展示同花色手牌後可棄牌造成火焰傷害', () => {
    const state = fresh();
    state.players[0]!.hand = [
      card(60, 'fire_attack', 'heart', 2),
      card(61, 'peach', 'heart', 5),
    ];
    state.players[1]!.hand = [card(62, 'dodge', 'heart', 8)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'fire_attack' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'card' && request.player === 0) {
          const discard = request.options.find((item) => item.kind !== 'pass');
          if (discard) return { type: 'option', optionId: discard.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(4);
  });

  it('借刀殺人：目標出【殺】則攻擊，不出則取得武器', () => {
    const state = fresh();
    state.players[0]!.hand = [card(70, 'collateral', 'club', 12)];
    state.players[1]!.hand = [card(71, 'slash', 'spade', 8)];
    state.players[1]!.equips.weapon = card(72, 'qinggang', 'spade', 6);
    state.deck = Array.from({ length: 20 }, (_, index) => card(1000 + index, 'dodge', 'heart', 2));

    playAction(
      state,
      0,
      (option) => option.asCard === 'collateral' && option.targets[0] === 1 && option.targets[1] === 2,
      (request) => {
        if (request.kind === 'response' && request.need === 'sha' && request.player === 1) {
          const slash = request.options.find((item) => item.asCard === 'slash');
          if (slash) return { type: 'option', optionId: slash.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[2]!.hp).toBe(4);
  });

  it('借刀殺人：目標不出【殺】時，使用者獲得其武器', () => {
    const state = fresh();
    state.players[0]!.hand = [card(73, 'collateral', 'club', 13)];
    state.players[1]!.equips.weapon = card(74, 'qinggang', 'spade', 6);
    state.deck = Array.from({ length: 20 }, (_, index) => card(1100 + index, 'dodge', 'heart', 2));
    playAction(state, 0, (option) => option.asCard === 'collateral' && option.targets[0] === 1);
    expect(state.players[1]!.equips.weapon).toBeNull();
    expect(handOf(state, 0).some((item) => item.name === 'qinggang')).toBe(true);
  });
});

describe('無懈可擊與延時錦囊', () => {
  it('一張無懈可擊可抵消錦囊', () => {
    const state = fresh();
    state.players[0]!.hand = [card(80, 'ex_nihilo', 'heart', 7)];
    state.players[1]!.hand = [card(81, 'nullification', 'spade', 11)];
    state.deck = [card(82, 'peach', 'heart', 5), card(83, 'dodge', 'diamond', 2)];

    let used = false;
    driveUntil(
      state,
      (request) => {
        if (!used && request.kind === 'action' && request.player === 0) {
          const option = request.options.find((item) => item.asCard === 'ex_nihilo');
          if (option) {
            used = true;
            return { type: 'option', optionId: option.id };
          }
        }
        if (request.kind === 'response' && request.need === 'wuxie' && request.player === 1) {
          const wuxie = request.options.find((item) => item.asCard === 'nullification');
          if (wuxie) return { type: 'option', optionId: wuxie.id };
        }
        return baseline(request);
      },
      (request) => used && request.kind === 'action' && request.player === 0,
    );
    expect(handOf(state, 0)).toHaveLength(2);
  });

  it('兩張無懈可擊連環抵消後，原錦囊恢復結算', () => {
    const state = fresh();
    state.players[0]!.hand = [card(90, 'ex_nihilo', 'heart', 7)];
    state.players[1]!.hand = [card(91, 'nullification', 'spade', 11)];
    state.players[2]!.hand = [card(92, 'nullification', 'club', 12)];
    state.deck = [card(93, 'peach', 'heart', 5), card(94, 'dodge', 'diamond', 2)];

    let used = false;
    const usedBy = new Set<number>();
    driveUntil(
      state,
      (request) => {
        if (!used && request.kind === 'action' && request.player === 0) {
          const option = request.options.find((item) => item.asCard === 'ex_nihilo');
          if (option) {
            used = true;
            return { type: 'option', optionId: option.id };
          }
        }
        if (
          request.kind === 'response' &&
          request.need === 'wuxie' &&
          (request.player === 1 || request.player === 2) &&
          !usedBy.has(request.player)
        ) {
          const wuxie = request.options.find((item) => item.asCard === 'nullification');
          if (wuxie) {
            usedBy.add(request.player);
            return { type: 'option', optionId: wuxie.id };
          }
        }
        return baseline(request);
      },
      (request) => used && request.kind === 'action' && request.player === 0,
    );
    expect(handOf(state, 0)).toHaveLength(4);
  });

  it('群體錦囊的無懈可擊只抵消其中一名目標', () => {
    const state = fresh();
    state.players[0]!.hand = [card(95, 'barbarian', 'spade', 7)];
    state.players[2]!.hand = [card(96, 'nullification', 'spade', 11)];

    let used = false;
    playAction(
      state,
      0,
      (option) => option.asCard === 'barbarian',
      (request) => {
        if (
          request.kind === 'response' &&
          request.need === 'wuxie' &&
          request.player === 2 &&
          (request.targets ?? []).includes(1)
        ) {
          const wuxie = request.options.find((item) => item.asCard === 'nullification');
          if (wuxie && !used) {
            used = true;
            return { type: 'option', optionId: wuxie.id };
          }
        }
        return baseline(request);
      },
    );
    // 只有玩家 1 被抵消，其餘目標照常受到傷害。
    expect(state.players[1]!.hp).toBe(5);
    expect(state.players[2]!.hp).toBe(4);
    expect(state.players[3]!.hp).toBe(4);
    expect(state.players[4]!.hp).toBe(4);
  });

  it('群體錦囊同一目標可被兩張無懈可擊連環後恢復', () => {
    const state = fresh();
    state.players[0]!.hand = [card(97, 'barbarian', 'spade', 7)];
    state.players[2]!.hand = [card(98, 'nullification', 'spade', 11)];
    state.players[3]!.hand = [card(99, 'nullification', 'club', 12)];

    const usedBy = new Set<number>();
    playAction(
      state,
      0,
      (option) => option.asCard === 'barbarian',
      (request) => {
        if (
          request.kind === 'response' &&
          request.need === 'wuxie' &&
          (request.player === 2 || request.player === 3) &&
          (request.targets ?? []).includes(1) &&
          !usedBy.has(request.player)
        ) {
          const wuxie = request.options.find((item) => item.asCard === 'nullification');
          if (wuxie) {
            usedBy.add(request.player);
            return { type: 'option', optionId: wuxie.id };
          }
        }
        return baseline(request);
      },
    );
    // 兩張無懈連環後，對玩家 1 的效果恢復，玩家 1 仍受到傷害。
    expect(state.players[1]!.hp).toBe(4);
  });

  it('桃園結義逐目標無懈：只取消其中一名角色的回復', () => {
    const state = fresh();
    state.players[0]!.hp = 3;
    state.players[1]!.hp = 3;
    state.players[2]!.hp = 3;
    state.players[0]!.hand = [card(310, 'peach_garden', 'heart', 1)];
    state.players[2]!.hand = [card(311, 'nullification', 'spade', 11)];

    let used = false;
    playAction(
      state,
      0,
      (option) => option.asCard === 'peach_garden',
      (request) => {
        if (
          request.kind === 'response' &&
          request.need === 'wuxie' &&
          request.player === 2 &&
          (request.targets ?? []).includes(1)
        ) {
          const wuxie = request.options.find((item) => item.asCard === 'nullification');
          if (wuxie && !used) {
            used = true;
            return { type: 'option', optionId: wuxie.id };
          }
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(3);
    expect(state.players[0]!.hp).toBe(4);
    expect(state.players[2]!.hp).toBe(4);
  });

  it('瀕死求桃從當前回合角色開始逆時針詢問', () => {
    const state = fresh();
    state.turn = 2;
    state.players[1]!.hp = 1;
    state.players[1]!.hand = [card(320, 'peach', 'heart', 3)];
    state.players[2]!.hand = [card(321, 'slash', 'spade', 7)];
    // 玩家 3 也有桃；依官方順序（從當前回合玩家 2 開始）會先問到玩家 3，
    // 舊行為（從瀕死者玩家 1 開始）則會先問到玩家 1 自救。
    state.players[3]!.hand = [card(322, 'peach', 'heart', 4)];

    let used = false;
    const peachRequest = driveUntil(
      state,
      (request) => {
        if (!used && request.kind === 'action' && request.player === 2) {
          const slash = request.options.find(
            (item) => item.asCard === 'slash' && item.targets[0] === 1,
          );
          if (slash) {
            used = true;
            return { type: 'option', optionId: slash.id };
          }
        }
        return baseline(request);
      },
      (request) => request.kind === 'response' && request.need === 'peach',
    );
    expect(peachRequest?.player).toBe(3);
  });

  it('樂不思蜀判定非紅桃時跳過出牌階段', () => {
    const state = fresh();
    state.players[0]!.judgeZone = [card(100, 'indulgence', 'heart', 6)];
    state.players[0]!.hand = [card(101, 'slash', 'spade', 8)];
    state.deck = [
      card(102, 'dodge', 'heart', 2),
      card(103, 'dodge', 'heart', 3),
      card(104, 'slash', 'spade', 9),
    ];
    let sawPlayPhase = false;
    driveUntil(
      state,
      (request) => {
        if (request.kind === 'action' && request.player === 0) sawPlayPhase = true;
        return baseline(request);
      },
      (request) => request.kind === 'action' && request.player === 1,
    );
    expect(sawPlayPhase).toBe(false);
    expect(state.log.some((entry) => entry.text.includes('跳過出牌階段'))).toBe(true);
  });

  it('兵糧寸斷判定非梅花時跳過摸牌階段', () => {
    const state = fresh();
    state.players[0]!.judgeZone = [card(110, 'supply_shortage', 'club', 4)];
    state.deck = [card(111, 'dodge', 'heart', 2), card(112, 'slash', 'spade', 9)];
    driveUntil(state, baseline, (request) => request.kind === 'action' && request.player === 0);
    expect(handOf(state, 0)).toHaveLength(0);
    expect(state.log.some((entry) => entry.text.includes('跳過摸牌階段'))).toBe(true);
  });

  it('閃電命中時造成 3 點雷電傷害，白銀獅子限制為 1', () => {
    const state = fresh();
    state.players[0]!.judgeZone = [card(120, 'lightning', 'spade', 1)];
    state.players[0]!.equips.armor = card(121, 'silver_lion', 'club', 1);
    state.deck = [card(122, 'slash', 'spade', 5)];
    driveUntil(state, baseline, (request) => request.kind === 'action' && request.player === 0);
    expect(state.players[0]!.hp).toBe(4);
    expect(state.players[0]!.equips.armor?.name).toBe('silver_lion');
  });

  it('閃電未命中時移動到下一位存活角色的判定區', () => {
    const state = fresh();
    state.players[0]!.judgeZone = [card(130, 'lightning', 'spade', 1)];
    state.deck = [card(131, 'dodge', 'heart', 2), card(132, 'dodge', 'heart', 3), card(133, 'dodge', 'heart', 4)];
    driveUntil(state, baseline, (request) => request.kind === 'action' && request.player === 0);
    expect(state.players[0]!.judgeZone).toHaveLength(0);
    expect(state.players[1]!.judgeZone.some((item) => item.name === 'lightning')).toBe(true);
  });

  it('鐵索連環可同時橫置兩名角色，也可重鑄摸牌', () => {
    const state = fresh();
    state.players[0]!.hand = [card(140, 'iron_chain', 'club', 10)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'iron_chain' && option.targets.length === 2,
    );
    expect(state.players[1]!.chained || state.players[2]!.chained || state.players[3]!.chained || state.players[4]!.chained).toBe(true);

    const recast = fresh();
    recast.players[0]!.hand = [card(141, 'iron_chain', 'club', 11)];
    recast.deck = [card(142, 'peach', 'heart', 5), card(143, 'dodge', 'heart', 2), card(144, 'dodge', 'heart', 3)];
    playAction(recast, 0, (option) => option.skill === 'recast');
    expect(handOf(recast, 0)).toHaveLength(3);
    expect(handOf(recast, 0).some((item) => item.name === 'peach')).toBe(true);
  });
});

describe('傷害管線與鐵索傳導', () => {
  it('酒＋火殺＋藤甲＋鐵索傳導的傷害與封頂', () => {
    const manual = fresh();
    manual.players[0]!.hand = [card(160, 'wine', 'spade', 3), card(161, 'fire_slash', 'heart', 4)];
    manual.players[1]!.equips.armor = card(162, 'vine_armor', 'spade', 2);
    manual.players[1]!.chained = true;
    manual.players[2]!.chained = true;
    let actions = 0;
    driveUntil(
      manual,
      (request) => {
        if (request.kind === 'action' && request.player === 0 && actions === 0) {
          const wine = request.options.find((option) => option.asCard === 'wine');
          if (wine) {
            actions = 1;
            return { type: 'option', optionId: wine.id };
          }
        }
        if (request.kind === 'action' && request.player === 0 && actions === 1) {
          const slash = request.options.find(
            (option) => option.asCard === 'fire_slash' && option.targets[0] === 1,
          );
          if (slash) {
            actions = 2;
            return { type: 'option', optionId: slash.id };
          }
        }
        return baseline(request);
      },
      (request) => actions === 2 && request.kind === 'action' && request.player === 0,
    );
    expect(manual.players[1]!.hp).toBe(2);
    expect(manual.players[2]!.hp).toBe(2);
    expect(manual.players[1]!.chained).toBe(false);
    expect(manual.players[2]!.chained).toBe(false);
  });

  it('鐵索傳導不會串接：三名橫置角色各只受到一次傳導', () => {
    const state = fresh();
    state.players[0]!.hand = [card(170, 'fire_slash', 'heart', 4)];
    state.players[1]!.chained = true;
    state.players[2]!.chained = true;
    state.players[3]!.chained = true;

    playAction(state, 0, (option) => option.asCard === 'fire_slash' && option.targets[0] === 1);

    expect(state.players[1]!.hp).toBe(4);
    expect(state.players[2]!.hp).toBe(4);
    expect(state.players[3]!.hp).toBe(4);
    expect(state.players[1]!.chained).toBe(false);
    expect(state.players[2]!.chained).toBe(false);
    expect(state.players[3]!.chained).toBe(false);
    // 只有原始目標會觸發一次；被傳導者不會再往外傳導。
    const triggers = state.log.filter((entry) => entry.text.includes('鐵索連環被觸發'));
    expect(triggers).toHaveLength(1);
  });
});

describe('八把武器', () => {
  it('青釭劍無視仁王盾', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(200, 'qinggang', 'spade', 6);
    state.players[0]!.hand = [card(201, 'slash', 'spade', 8)];
    state.players[1]!.equips.armor = card(202, 'renwang', 'club', 2);
    playAction(state, 0, (option) => option.asCard === 'slash' && option.targets[0] === 1);
    expect(state.players[1]!.hp).toBe(4);
  });

  it('寒冰劍防止傷害並棄置目標兩張牌', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(210, 'ice_sword', 'spade', 2);
    state.players[0]!.hand = [card(211, 'slash', 'spade', 8)];
    state.players[1]!.hand = [card(212, 'peach', 'heart', 5), card(213, 'dodge', 'diamond', 2)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'ice_sword');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(5);
    expect(handOf(state, 1)).toHaveLength(0);
  });

  it('寒冰劍不能棄置判定區的牌，也不能只憑判定牌發動', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(214, 'ice_sword', 'spade', 2);
    state.players[0]!.hand = [card(215, 'slash', 'spade', 8)];
    state.players[1]!.judgeZone = [card(216, 'indulgence', 'spade', 6)];

    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'ice_sword');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(4);
    expect(state.players[1]!.judgeZone).toHaveLength(1);
  });

  it('寒冰劍在目標只有 1 張手牌時可發動並棄 1 張', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(217, 'ice_sword', 'spade', 2);
    state.players[0]!.hand = [card(218, 'slash', 'spade', 8)];
    state.players[1]!.hand = [card(219, 'peach', 'heart', 5)];

    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'ice_sword');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(5);
    expect(handOf(state, 1)).toHaveLength(0);
  });

  it('寒冰劍：目標只有手牌時，棄牌觸發連營後仍要棄第二張', () => {
    const state = fresh();
    state.players[1]!.generalId = 'lu_xun';
    state.players[0]!.equips.weapon = card(224, 'ice_sword', 'spade', 2);
    state.players[0]!.hand = [card(225, 'slash', 'spade', 8)];
    state.players[1]!.hand = [card(226, 'peach', 'heart', 5)];

    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'ice_sword');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(5);
    // 棄掉第一張後連營摸 1 張，寒冰劍再棄這張；失去最後手牌又觸發一次連營，最終留下 1 張。
    expect(handOf(state, 1)).toHaveLength(1);
    expect(
      state.log.some((entry) => entry.text.includes('寒冰劍') && entry.text.includes('2 張牌')),
    ).toBe(true);
    expect(state.log.some((entry) => entry.text.includes('連營'))).toBe(true);
  });

  it('雌雄雙股劍令異性目標棄一張手牌', () => {
    const state = fresh();
    state.players[0]!.generalId = 'cao_cao';
    state.players[1]!.generalId = 'zhen_ji';
    state.players[0]!.equips.weapon = card(220, 'double_sword', 'spade', 2);
    state.players[0]!.hand = [card(221, 'slash', 'spade', 8)];
    state.players[1]!.hand = [card(222, 'peach', 'heart', 5)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'double_sword');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        if (request.kind === 'response' && request.need === 'choice' && request.player === 1) {
          const discard = request.options.find((option) => option.skill === 'discard');
          if (discard) return { type: 'option', optionId: discard.id };
        }
        return baseline(request);
      },
    );
    expect(handOf(state, 1)).toHaveLength(0);
  });

  it('貫石斧棄兩張手牌造成 +1 傷害且不可被閃', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(230, 'rock_axe', 'diamond', 5);
    state.players[0]!.hand = [
      card(231, 'slash', 'spade', 8),
      card(232, 'dodge', 'heart', 2),
      card(233, 'peach', 'heart', 5),
    ];
    state.players[1]!.hand = [card(234, 'dodge', 'diamond', 6)];
    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'rock_axe');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(3);
    expect(handOf(state, 0)).toHaveLength(2);
  });

  it('貫石斧不會對藤甲普通【殺】詢問（避免浪費兩張手牌）', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(235, 'rock_axe', 'diamond', 5);
    state.players[0]!.hand = [
      card(236, 'slash', 'spade', 8),
      card(237, 'dodge', 'heart', 2),
      card(238, 'peach', 'heart', 5),
    ];
    state.players[1]!.equips.armor = card(239, 'vine_armor', 'spade', 2);
    let sawRockAxe = false;
    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (
          request.kind === 'response' &&
          request.need === 'choice' &&
          request.options.some((option) => option.skill === 'rock_axe')
        ) {
          sawRockAxe = true;
        }
        return baseline(request);
      },
    );
    expect(sawRockAxe).toBe(false);
    expect(state.players[1]!.hp).toBe(5); // 普通殺被藤甲無效
  });

  it('青龍偃月刀被閃抵消後可再使用一張殺', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(240, 'green_dragon', 'spade', 5);
    state.players[0]!.hand = [card(241, 'slash', 'spade', 8), card(242, 'slash', 'club', 8)];
    state.players[1]!.hand = [card(243, 'dodge', 'diamond', 2)];
    let dodged = false;
    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1 && option.cards.length === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'shan' && request.player === 1 && !dodged) {
          dodged = true;
          const dodge = request.options.find((item) => item.asCard === 'dodge');
          if (dodge) return { type: 'option', optionId: dodge.id };
        }
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'green_dragon');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        if (request.kind === 'response' && request.need === 'sha' && request.player === 0) {
          const slash = request.options.find((item) => item.asCard === 'slash');
          if (slash) return { type: 'option', optionId: slash.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.hp).toBe(4);
    expect(handOf(state, 0)).toHaveLength(2);
  });

  it('方天畫戟在最後手牌時提供額外目標', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(250, 'halberd', 'diamond', 12);
    state.players[0]!.hand = [card(251, 'slash', 'spade', 8)];
    const options = getPlayOptions(state, state.players[0]!).filter(
      (option) => option.skill === 'halberd',
    );
    expect(options.some((option) => option.targets.length === 3)).toBe(true);
  });

  it('麒麟弓造成傷害後棄置目標的馬', () => {
    const state = fresh();
    state.players[0]!.equips.weapon = card(260, 'qilin_bow', 'heart', 5);
    state.players[0]!.hand = [card(261, 'slash', 'spade', 8)];
    state.players[1]!.equips.horsePlus = card(262, 'jueying', 'spade', 5);
    playAction(
      state,
      0,
      (option) => option.asCard === 'slash' && option.targets[0] === 1,
      (request) => {
        if (request.kind === 'response' && request.need === 'choice' && request.player === 0) {
          const skill = request.options.find((option) => option.skill === 'qilin_bow');
          if (skill) return { type: 'option', optionId: skill.id };
        }
        return baseline(request);
      },
    );
    expect(state.players[1]!.equips.horsePlus).toBeNull();
  });
});
