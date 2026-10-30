import { describe, expect, it } from 'vitest';
import { autoPlayGame } from '../game/autoplay';
import type { GameResult } from '../engine/types';

function usedCards(result: GameResult): string[] {
  const names: string[] = [];
  for (const entry of result.log) {
    const used = entry.text.match(/(?:使用|重鑄)【([^】]+)】/);
    if (used?.[1]) names.push(used[1]);
  }
  return names;
}

describe('AI 對局模擬', () => {
  it('單局可以正常結束', () => {
    const result = autoPlayGame({ seed: 1 });
    expect(result.winner.roles.length).toBeGreaterThan(0);
    expect(result.turns).toBeGreaterThan(0);
  });

  it('完整牌堆 1,000 局不同 seed 都能結束、不出現死循環，且會用到 M2 新牌', () => {
    const winners = new Set<string>();
    const used = new Map<string, number>();
    let totalTurns = 0;

    for (let seed = 1; seed <= 1000; seed += 1) {
      const result = autoPlayGame({ seed, maxRequests: 800_000 });
      expect(result.winner.roles.length).toBeGreaterThan(0);
      expect(result.winner.reason).not.toContain('死循環');
      expect(result.winner.reason).not.toContain('請求過多');
      totalTurns += result.turns;
      winners.add([...result.winner.roles].sort().join(','));
      for (const name of usedCards(result)) {
        used.set(name, (used.get(name) ?? 0) + 1);
      }
    }

    // 至少出現過兩種不同結果，代表不是永遠同一方獲勝。
    expect(winners.size).toBeGreaterThan(1);
    // 平均回合數不應失控。
    expect(totalTurns / 1000).toBeLessThan(100);

    // 全牌池模擬必須真的用到軍爭／EX 新牌，而不是只存在於牌表。
    for (const name of [
      '決鬥',
      '南蠻入侵',
      '萬箭齊發',
      '桃園結義',
      '五穀豐登',
      '借刀殺人',
      '火攻',
      '無懈可擊',
      '鐵索連環',
      '樂不思蜀',
      '兵糧寸斷',
      '閃電',
    ]) {
      expect(used.get(name) ?? 0).toBeGreaterThan(0);
    }
  });

  it('同一 seed 會產生相同的對局結果', () => {
    const first = autoPlayGame({ seed: 42 });
    const second = autoPlayGame({ seed: 42 });
    expect(second.winner).toEqual(first.winner);
    expect(second.turns).toBe(first.turns);
    expect(second.log.map((entry) => entry.text)).toEqual(first.log.map((entry) => entry.text));
  });
});
