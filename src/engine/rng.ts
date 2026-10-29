/** 可重現的偽隨機數（mulberry32）。遊戲邏輯不使用 Math.random。 */

export interface RngState {
  rngState: number;
}

export function nextUint32(state: RngState): number {
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  return (t ^ (t >>> 14)) >>> 0;
}

export function nextFloat(state: RngState): number {
  return nextUint32(state) / 0x1_0000_0000;
}

export function shuffle<T>(items: T[], state: RngState): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = nextUint32(state) % (i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

export function randomSeed(): number {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    c.getRandomValues(buffer);
    return buffer[0] || 1;
  }
  return ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0) || 1;
}
