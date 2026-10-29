import { describe, expect, it } from 'vitest';
import {
  CARD_DATA_VERSION,
  FULL_DECK,
  countCardsByName,
  createDeck,
  getCard,
} from '../data/cards';
import { CARD_META } from '../data/cardMeta';

describe('完整牌庫', () => {
  it('標準 104 + EX 4 + 軍爭 52 = 160 張', () => {
    expect(FULL_DECK).toHaveLength(160);
    expect(CARD_DATA_VERSION).toBe('1.0.0');
  });

  it('card id 唯一', () => {
    const ids = new Set(FULL_DECK.map((card) => card.id));
    expect(ids.size).toBe(FULL_DECK.length);
  });

  it('每張牌都有 metadata 與合法點數', () => {
    for (const card of FULL_DECK) {
      expect(CARD_META[card.name]).toBeDefined();
      expect(card.rank).toBeGreaterThanOrEqual(1);
      expect(card.rank).toBeLessThanOrEqual(13);
      expect(getCard(card.id)).toBe(card);
    }
  });

  it('花色點數可重複（EX 與軍爭會與標準牌重疊），但牌名總數固定', () => {
    const suitRank = new Set(FULL_DECK.map((card) => `${card.suit}:${card.rank}`));
    expect(suitRank.size).toBeLessThan(FULL_DECK.length);
  });

  it('軍爭牌張數符合資料表', () => {
    const counts = countCardsByName(FULL_DECK);
    expect(counts.fire_slash).toBe(5);
    expect(counts.thunder_slash).toBe(9);
    expect(counts.wine).toBe(5);
    expect(counts.iron_chain).toBe(6);
    expect(counts.nullification).toBe(7);
  });

  it('M1 牌堆只包含已實作的牌', () => {
    const deck = createDeck('m1');
    expect(deck.length).toBeGreaterThan(100);
    expect(deck.length).toBeLessThan(FULL_DECK.length);
    for (const card of deck) {
      expect(CARD_META[card.name].implemented).toBe(true);
    }
  });

  it('完整牌堆包含未實作的牌', () => {
    const deck = createDeck('full');
    expect(deck).toHaveLength(160);
    expect(deck.some((card) => !CARD_META[card.name].implemented)).toBe(true);
  });
});
