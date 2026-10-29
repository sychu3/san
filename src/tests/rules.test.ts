import { describe, expect, it } from 'vitest';
import { createGame } from '../engine/state';
import {
  attackRange,
  distance,
  handLimit,
  inAttackRange,
  isBlack,
  isRed,
  nextAliveId,
  seatDistance,
  slashLimitReached,
} from '../engine/rules';
import type { Card } from '../engine/types';

function card(id: number, name: Card['name']): Card {
  return { id, name, suit: 'spade', rank: 7 };
}

describe('距離與攻擊範圍', () => {
  it('五人局相鄰座位距離為 1，最遠為 2', () => {
    const state = createGame({ seed: 42 });
    expect(seatDistance(state, 0, 1)).toBe(1);
    expect(seatDistance(state, 0, 2)).toBe(2);
    expect(seatDistance(state, 0, 3)).toBe(2);
    expect(seatDistance(state, 0, 4)).toBe(1);
  });

  it('+1 馬增加目標距離，-1 馬減少來源距離，最少為 1', () => {
    const state = createGame({ seed: 42 });
    const source = state.players[0]!;
    const target = state.players[2]!;
    expect(distance(state, 0, 2)).toBe(2);

    target.equips.horsePlus = card(9001, 'jueying');
    expect(distance(state, 0, 2)).toBe(3);

    source.equips.horseMinus = card(9002, 'chitu');
    expect(distance(state, 0, 2)).toBe(2);

    target.equips.horsePlus = null;
    source.equips.horseMinus = null;
    const adjacent = state.players[1]!;
    adjacent.equips.horsePlus = card(9003, 'dilu');
    source.equips.horseMinus = card(9004, 'dawan');
    expect(distance(state, 0, 1)).toBe(1);
  });

  it('武器攻擊範圍', () => {
    const state = createGame({ seed: 42 });
    const player = state.players[0]!;
    expect(attackRange(player)).toBe(1);
    player.equips.weapon = card(9005, 'crossbow');
    expect(attackRange(player)).toBe(1);
    player.equips.weapon = card(9006, 'ancient_scimitar');
    expect(attackRange(player)).toBe(2);
    player.equips.weapon = card(9007, 'fan');
    expect(attackRange(player)).toBe(4);
  });

  it('只能攻擊存活且在範圍內的角色', () => {
    const state = createGame({ seed: 42 });
    expect(inAttackRange(state, 0, 1)).toBe(true);
    expect(inAttackRange(state, 0, 2)).toBe(false);
    state.players[1]!.alive = false;
    expect(inAttackRange(state, 0, 1)).toBe(false);
  });

  it('目前角色死亡後，回合仍正確交棒給下一座位', () => {
    const state = createGame({ seed: 42 });
    state.players[2]!.alive = false;
    expect(nextAliveId(state, 2)).toBe(3);
    state.players[3]!.alive = false;
    state.players[4]!.alive = false;
    expect(nextAliveId(state, 2)).toBe(0);
  });
});

describe('手牌上限與出殺次數', () => {
  it('手牌上限等於體力，最低 0', () => {
    const state = createGame({ seed: 42 });
    const player = state.players[0]!;
    player.hp = 3;
    expect(handLimit(player)).toBe(3);
    player.hp = -1;
    expect(handLimit(player)).toBe(0);
  });

  it('諸葛連弩不受每回合一次殺的限制', () => {
    const state = createGame({ seed: 42 });
    const player = state.players[0]!;
    player.slashUsed = 1;
    expect(slashLimitReached(player)).toBe(true);
    player.equips.weapon = card(9008, 'crossbow');
    expect(slashLimitReached(player)).toBe(false);
  });

  it('紅色與黑色判定', () => {
    expect(isRed({ id: 1, name: 'slash', suit: 'heart', rank: 7 })).toBe(true);
    expect(isRed({ id: 2, name: 'slash', suit: 'diamond', rank: 7 })).toBe(true);
    expect(isBlack({ id: 3, name: 'slash', suit: 'spade', rank: 7 })).toBe(true);
    expect(isBlack({ id: 4, name: 'slash', suit: 'club', rank: 7 })).toBe(true);
    expect(isRed({ id: 5, name: 'slash', suit: 'spade', rank: 7 })).toBe(false);
  });
});
