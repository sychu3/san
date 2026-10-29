import { describe, expect, it } from 'vitest';
import { autoPlayGame } from '../game/autoplay';

describe('AI 對局模擬', () => {
  it('單局可以正常結束', () => {
    const result = autoPlayGame({ seed: 1 });
    expect(result.winner.roles.length).toBeGreaterThan(0);
    expect(result.turns).toBeGreaterThan(0);
  });

  it('連續 80 局不同 seed 都能結束且不崩潰', () => {
    const winners = new Set<string>();
    for (let seed = 1; seed <= 80; seed += 1) {
      const result = autoPlayGame({ seed, maxRequests: 400_000 });
      expect(result.winner.roles.length).toBeGreaterThan(0);
      expect(result.winner.reason.length).toBeGreaterThan(0);
      winners.add(result.winner.roles.sort().join(','));
    }
    // 至少出現過兩種不同結果，代表不是永遠同一方獲勝。
    expect(winners.size).toBeGreaterThan(1);
  });

  it('完整牌堆也能完成對局（未實作牌會安全地進入棄牌堆）', () => {
    const result = autoPlayGame({ seed: 42, pool: 'full' });
    expect(result.winner.roles.length).toBeGreaterThan(0);
  });
});
