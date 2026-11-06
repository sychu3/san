import { describe, expect, it } from 'vitest';
import { createGame } from '../engine/state';
import { CANDIDATE_COUNT, createSetup, generalCandidates, type GameSetup } from '../game/setup';
import { getGeneral } from '../data/generals';

/** 找一個符合條件的人類身份（最多掃 300 個 seed）。 */
function setupWith(check: (setup: GameSetup) => boolean): GameSetup | null {
  for (let seed = 1; seed <= 300; seed += 1) {
    const setup = createSetup(0, seed);
    if (check(setup)) return setup;
  }
  return null;
}

describe('開局選將', () => {
  it('候選武將為 3 名不重複，且同一 seed 固定', () => {
    const a = generalCandidates(12345);
    const b = generalCandidates(12345);
    expect(a).toHaveLength(CANDIDATE_COUNT);
    expect(new Set(a).size).toBe(CANDIDATE_COUNT);
    expect(a).toEqual(b);
    for (const id of a) expect(() => getGeneral(id)).not.toThrow();
  });

  it('不同 seed 會給出不同候選（取樣驗證）', () => {
    const sets = new Set<string>();
    for (let seed = 1; seed <= 50; seed += 1) {
      sets.add(generalCandidates(seed).join(','));
    }
    expect(sets.size).toBeGreaterThan(1);
  });

  it('createSetup 的身份、座位與正式對局一致', () => {
    const setup = createSetup(0, 777);
    const state = createGame({ seed: 777, humanId: 0 });
    const lord = state.players.find((player) => player.role === 'lord')!;
    expect(setup.role).toBe(state.players[0]!.role);
    expect(setup.humanSeat).toBe(0);
    expect(setup.lordSeat).toBe(lord.id);
    expect(setup.candidates).toHaveLength(CANDIDATE_COUNT);
    expect(new Set(setup.candidates).size).toBe(CANDIDATE_COUNT);
  });

  it('人類不是主公時：看得到主公武將、候選不重複，且選將不會換掉主公武將', () => {
    const setup = setupWith((item) => item.role !== 'lord');
    expect(setup).not.toBeNull();
    if (!setup) return;

    expect(setup.lordGeneralId).not.toBeNull();
    expect(setup.candidates).not.toContain(setup.lordGeneralId);
    expect(setup.lordDistance).toBeGreaterThanOrEqual(1);
    expect(setup.lordDistance).toBeLessThanOrEqual(2);

    const target = setup.candidates[0]!;
    const chosen = createGame({ seed: setup.seed, humanId: 0, humanGeneralId: target });
    expect(chosen.players[0]!.generalId).toBe(target);
    const lord = chosen.players.find((player) => player.role === 'lord')!;
    expect(lord.generalId).toBe(setup.lordGeneralId);
    expect(new Set(chosen.players.map((player) => player.generalId)).size).toBe(5);
  });

  it('人類是主公時：沒有主公武將，由自己先選，距離為 0', () => {
    const setup = setupWith((item) => item.role === 'lord');
    expect(setup).not.toBeNull();
    if (!setup) return;

    expect(setup.lordGeneralId).toBeNull();
    expect(setup.lordSeat).toBe(setup.humanSeat);
    expect(setup.lordDistance).toBe(0);

    const target = setup.candidates[0]!;
    const chosen = createGame({ seed: setup.seed, humanId: 0, humanGeneralId: target });
    expect(chosen.players[0]!.generalId).toBe(target);
    expect(chosen.players[0]!.role).toBe('lord');
    // 主公體力上限 +1。
    expect(chosen.players[0]!.maxHp).toBe(getGeneral(target).maxHp + 1);
  });

  it('指定 humanRole 會換上該身份，且不影響牌堆與身份總數', () => {
    const base = createGame({ seed: 4243 });
    const chosen = createGame({ seed: 4243, humanId: 0, humanRole: 'lord' });

    expect(chosen.players[0]!.role).toBe('lord');
    expect(chosen.players[0]!.maxHp).toBe(getGeneral(chosen.players[0]!.generalId).maxHp + 1);
    expect([...chosen.players.map((player) => player.role)].sort()).toEqual(
      [...base.players.map((player) => player.role)].sort(),
    );
    expect(chosen.deck.map((card) => card.id)).toEqual(base.deck.map((card) => card.id));
  });

  it('createSetup 指定身份時，預覽與正式對局一致', () => {
    const setup = createSetup(0, 4243, 'lord');
    expect(setup.role).toBe('lord');
    expect(setup.lordSeat).toBe(0);
    expect(setup.lordGeneralId).toBeNull();

    const state = createGame({ seed: 4243, humanId: 0, humanRole: 'lord' });
    expect(state.players[0]!.role).toBe('lord');
  });

  it('humanRole 需要合法的座位與身份', () => {
    expect(() => createGame({ seed: 1, humanRole: 'lord' })).toThrow();
    expect(() => createGame({ seed: 1, humanId: 0, humanRole: 'emperor' as never })).toThrow();
  });

  it('指定 humanGeneralId 會換上該武將，且不影響身份與牌堆', () => {
    const base = createGame({ seed: 4242 });
    const target = generalCandidates(4242)[0]!;
    const chosen = createGame({ seed: 4242, humanId: 0, humanGeneralId: target });

    expect(chosen.players[0]!.generalId).toBe(target);
    expect(new Set(chosen.players.map((player) => player.generalId)).size).toBe(5);
    expect(chosen.players.map((player) => player.role)).toEqual(base.players.map((player) => player.role));
    expect(chosen.deck.map((card) => card.id)).toEqual(base.deck.map((card) => card.id));

    for (const player of chosen.players) {
      const general = getGeneral(player.generalId);
      expect(player.maxHp).toBe(general.maxHp + (player.role === 'lord' ? 1 : 0));
      expect(player.hp).toBe(player.maxHp);
    }
  });

  it('同 seed 同選擇會產生完全相同的對局', () => {
    const target = generalCandidates(99)[1]!;
    const a = createGame({ seed: 99, humanId: 0, humanGeneralId: target });
    const b = createGame({ seed: 99, humanId: 0, humanGeneralId: target });
    expect(a.players.map((player) => player.generalId)).toEqual(b.players.map((player) => player.generalId));
    expect(a.deck.map((card) => card.id)).toEqual(b.deck.map((card) => card.id));
  });

  it('未知武將或非法座位會被拒絕', () => {
    expect(() => createGame({ seed: 1, humanId: 0, humanGeneralId: 'not_a_general' })).toThrow();
    expect(() => createGame({ seed: 1, humanId: 9, humanGeneralId: 'cao_cao' })).toThrow();
  });
});
