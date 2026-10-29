import { describe, expect, it } from 'vitest';
import { nextUint32, randomSeed, shuffle } from '../engine/rng';

describe('可重現隨機數', () => {
  it('相同 seed 產生相同序列', () => {
    const a = { rngState: 12345 };
    const b = { rngState: 12345 };
    const seqA = Array.from({ length: 20 }, () => nextUint32(a));
    const seqB = Array.from({ length: 20 }, () => nextUint32(b));
    expect(seqA).toEqual(seqB);
  });

  it('不同 seed 產生不同序列', () => {
    const a = { rngState: 1 };
    const b = { rngState: 2 };
    expect(nextUint32(a)).not.toBe(nextUint32(b));
  });

  it('洗牌是排列且可重現', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const shuffledA = shuffle([...items], { rngState: 777 });
    const shuffledB = shuffle([...items], { rngState: 777 });
    expect(shuffledA).toEqual(shuffledB);
    expect([...shuffledA].sort((x, y) => x - y)).toEqual(items);
  });

  it('randomSeed 回傳非零 32 位整數', () => {
    const seed = randomSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});
