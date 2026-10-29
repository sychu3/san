import { describe, expect, it } from 'vitest';
import { createGame, viewFor } from '../engine/state';
import { getPlayOptions, runGame } from '../engine/engine';
import type { Card } from '../engine/types';

function card(id: number, name: Card['name'], suit: Card['suit'] = 'spade', rank: Card['rank'] = 7): Card {
  return { id, name, suit, rank };
}

function fresh(seed = 7) {
  const state = createGame({ seed });
  state.turn = 0;
  state.winner = null;
  for (const player of state.players) {
    player.hand = [];
    player.hp = player.maxHp;
    player.alive = true;
  }
  return state;
}

describe('建立對局', () => {
  it('五人身份為 1 主公、1 忠臣、2 反賊、1 內奸', () => {
    const state = createGame({ seed: 123 });
    const roles = state.players.map((player) => player.role).sort();
    expect(roles).toEqual(['lord', 'loyal', 'rebel', 'rebel', 'spy']);
  });

  it('每人起始 4 張手牌，主公體力上限 +1', () => {
    const state = createGame({ seed: 123 });
    for (const player of state.players) {
      expect(player.hand).toHaveLength(4);
    }
    const lord = state.players.find((player) => player.role === 'lord')!;
    expect(lord.maxHp).toBe(lord.hp);
    expect(lord.hp).toBeGreaterThanOrEqual(4);
  });

  it('同 seed 會產生相同對局', () => {
    const a = createGame({ seed: 99 });
    const b = createGame({ seed: 99 });
    expect(a.players.map((player) => player.generalId)).toEqual(b.players.map((player) => player.generalId));
    expect(a.players.map((player) => player.role)).toEqual(b.players.map((player) => player.role));
    expect(a.deck.map((item) => item.id)).toEqual(b.deck.map((item) => item.id));
  });
});

describe('視角與隱藏資訊', () => {
  it('只看得到自己的手牌，其他人的手牌為 null', () => {
    const state = createGame({ seed: 5 });
    const view = viewFor(state, 0);
    expect(view.players[0]!.hand).toHaveLength(4);
    expect(view.players[1]!.hand).toBeNull();
    expect(view.players[1]!.handCount).toBe(4);
  });

  it('只看得到自己的身份與主公身份', () => {
    const state = createGame({ seed: 5 });
    const lord = state.players.find((player) => player.role === 'lord')!;
    const human = state.players[0]!;
    const view = viewFor(state, 0);
    expect(view.players[0]!.role).toBe(human.role);
    expect(view.players[lord.id]!.role).toBe('lord');
    for (const player of state.players) {
      if (player.id === 0 || player.id === lord.id) continue;
      expect(view.players[player.id]!.role).toBeNull();
    }
  });

  it('死亡角色身份公開', () => {
    const state = createGame({ seed: 5 });
    const other = state.players.find((player) => player.id !== 0 && player.role !== 'lord')!;
    other.alive = false;
    const view = viewFor(state, 0);
    expect(view.players[other.id]!.role).toBe(other.role);
  });

  it('pending 只會提供給等待中的玩家或上帝視角', () => {
    const state = createGame({ seed: 5 });
    state.pending = {
      id: 1,
      player: 2,
      prompt: 'test',
      kind: 'response',
      options: [],
      need: 'shan',
      context: 'test',
    };
    expect(viewFor(state, 0).pending).toBeNull();
    expect(viewFor(state, 2).pending?.id).toBe(1);
    expect(viewFor(state, 0, true).pending?.id).toBe(1);
  });

  it('視角是副本，UI 修改不會回寫遊戲狀態', () => {
    const state = createGame({ seed: 5 });
    state.players[0]!.hand = [{ id: 9001, name: 'slash', suit: 'spade', rank: 7 }];
    const view = viewFor(state, 0);
    const hand = view.players[0]!.hand;
    expect(hand).not.toBeNull();
    if (!hand) return;
    hand[0]!.name = 'peach';
    expect(state.players[0]!.hand[0]!.name).toBe('slash');

    view.players[0]!.equips.weapon = { id: 9002, name: 'fan', suit: 'diamond', rank: 1 };
    expect(state.players[0]!.equips.weapon).toBeNull();
  });
});

describe('出牌選項', () => {
  it('殺只能指向攻擊範圍內的角色', () => {
    const state = fresh();
    state.players[0]!.hand = [card(101, 'slash')];
    const options = getPlayOptions(state, state.players[0]!);
    const slashTargets = options.filter((option) => option.asCard === 'slash').flatMap((option) => option.targets);
    expect(slashTargets.sort()).toEqual([1, 4]);
  });

  it('裝備武器後攻擊範圍增加', () => {
    const state = fresh();
    state.players[0]!.hand = [card(102, 'slash')];
    state.players[0]!.equips.weapon = card(103, 'ancient_scimitar');
    const targets = getPlayOptions(state, state.players[0]!)
      .filter((option) => option.asCard === 'slash')
      .flatMap((option) => option.targets);
    expect(targets.sort()).toEqual([1, 2, 3, 4]);
  });

  it('每回合只能殺一次，諸葛連弩除外', () => {
    const state = fresh();
    const player = state.players[0]!;
    player.hand = [card(104, 'slash')];
    player.slashUsed = 1;
    expect(getPlayOptions(state, player).some((option) => option.asCard === 'slash')).toBe(false);

    player.equips.weapon = card(105, 'crossbow');
    expect(getPlayOptions(state, player).some((option) => option.asCard === 'slash')).toBe(true);
  });

  it('朱雀羽扇可把普通殺當火殺', () => {
    const state = fresh();
    const player = state.players[0]!;
    player.hand = [card(106, 'slash')];
    player.equips.weapon = card(107, 'fan');
    const fire = getPlayOptions(state, player).filter((option) => option.asCard === 'fire_slash');
    expect(fire.length).toBeGreaterThan(0);
    expect(fire.every((option) => option.skill === 'fan')).toBe(true);
  });

  it('順手牽羊只能對距離 1 的角色使用', () => {
    const state = fresh();
    const player = state.players[0]!;
    player.hand = [card(108, 'snatch')];
    state.players[1]!.hand = [card(201, 'peach')];
    state.players[2]!.hand = [card(202, 'peach')];
    state.players[4]!.hand = [card(203, 'peach')];
    const targets = getPlayOptions(state, player)
      .filter((option) => option.asCard === 'snatch')
      .flatMap((option) => option.targets);
    expect(targets.sort()).toEqual([1, 4]);
  });

  it('桃在出牌階段只能對自己使用', () => {
    const state = fresh();
    const player = state.players[0]!;
    player.hand = [card(109, 'peach')];
    expect(getPlayOptions(state, player).some((option) => option.asCard === 'peach')).toBe(false);

    state.players[2]!.hp = state.players[2]!.maxHp - 1;
    expect(getPlayOptions(state, player).some((option) => option.asCard === 'peach')).toBe(false);

    player.hp = player.maxHp - 1;
    const peachTargets = getPlayOptions(state, player)
      .filter((option) => option.asCard === 'peach')
      .flatMap((option) => option.targets);
    expect(peachTargets).toEqual([0]);
  });

  it('酒每回合限一次，且未使用時可作為選項', () => {
    const state = fresh();
    const player = state.players[0]!;
    player.hand = [card(110, 'wine')];
    expect(getPlayOptions(state, player).some((option) => option.asCard === 'wine')).toBe(true);
    player.wineUsed = true;
    expect(getPlayOptions(state, player).some((option) => option.asCard === 'wine')).toBe(false);
  });

  it('一定會有結束出牌階段的選項', () => {
    const state = fresh();
    const options = getPlayOptions(state, state.players[0]!);
    expect(options[options.length - 1]!.kind).toBe('pass');
  });
});

describe('結算與隱藏資訊', () => {
  it('順手牽羊從手牌取得的牌不會在日誌中公開牌名', () => {
    const state = fresh(77);
    state.players[0]!.role = 'rebel';
    state.players[1]!.role = 'lord';
    state.players[2]!.role = 'loyal';
    state.players[3]!.role = 'rebel';
    state.players[4]!.role = 'spy';
    state.players[0]!.hand = [card(301, 'snatch')];
    state.players[1]!.hand = [card(302, 'peach')];
    state.deck = [card(401, 'dodge'), card(402, 'dodge'), card(403, 'dodge')];
    state.discard = [];

    const generator = runGame(state);
    let step = generator.next();
    expect(step.done).toBe(false);
    if (step.done) return;
    expect(step.value.kind).toBe('action');
    if (step.value.kind !== 'action') return;

    const option = step.value.options.find(
      (item) => item.asCard === 'snatch' && item.targets[0] === 1,
    );
    expect(option).toBeDefined();
    if (!option) return;

    step = generator.next({ type: 'option', optionId: option.id });
    expect(step.done).toBe(false);
    if (step.done) return;
    expect(step.value.kind).toBe('chooseCard');
    if (step.value.kind !== 'chooseCard') return;

    generator.next({ type: 'card', card: -1 });

    // 目標的桃已被取得，但日誌只說「一張手牌」。
    expect(state.players[0]!.hand.some((item) => item.name === 'peach')).toBe(true);
    const snatchLog = state.log.find((entry) => entry.text.includes('獲得了'));
    expect(snatchLog?.text).toContain('一張手牌');
    expect(snatchLog?.text).not.toContain('桃');
  });
});
