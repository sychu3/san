import { describe, expect, it } from 'vitest';
import { createGame } from '../engine/state';
import { CANDIDATE_COUNT, createSetup, generalCandidates } from '../game/setup';
import { getGeneral } from '../data/generals';

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

  it('createSetup 的身份與正式對局一致', () => {
    const setup = createSetup(0, 777);
    const state = createGame({ seed: 777, humanId: 0 });
    expect(setup.role).toBe(state.players[0]!.role);
    expect(setup.candidates).toEqual(generalCandidates(777));
  });

  it('指定 humanGeneralId 會換上該武將，且五人武將仍不重複', () => {
    const base = createGame({ seed: 4242 });
    const target = generalCandidates(4242)[0]!;
    const chosen = createGame({ seed: 4242, humanId: 0, humanGeneralId: target });

    expect(chosen.players[0]!.generalId).toBe(target);
    expect(new Set(chosen.players.map((player) => player.generalId)).size).toBe(5);

    // 選將不影響身份與牌堆：同一 seed 的身份、摸牌順序都一樣。
    expect(chosen.players.map((player) => player.role)).toEqual(base.players.map((player) => player.role));
    expect(chosen.deck.map((card) => card.id)).toEqual(base.deck.map((card) => card.id));

    // 體力上限依最終武將與身份重算（主公 +1）。
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
