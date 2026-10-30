import type { Card, CardName, Rank, Suit } from '../engine/types';
import { CARD_META } from './cardMeta';

type Entry = readonly [Suit, Rank, ...CardName[]];

/**
 * 標準版 104 張（不含 EX）。
 * 來源：三國殺官方規則集 3.0 / 三國殺 Wiki 標準包卡牌表。
 */
const STANDARD_ENTRIES: readonly Entry[] = [
  // ♥ 紅桃
  ['heart', 1, 'peach_garden', 'arrows'],
  ['heart', 2, 'dodge', 'dodge'],
  ['heart', 3, 'peach', 'harvest'],
  ['heart', 4, 'peach', 'harvest'],
  ['heart', 5, 'qilin_bow', 'chitu'],
  ['heart', 6, 'peach', 'indulgence'],
  ['heart', 7, 'peach', 'ex_nihilo'],
  ['heart', 8, 'peach', 'ex_nihilo'],
  ['heart', 9, 'peach', 'ex_nihilo'],
  ['heart', 10, 'slash', 'slash'],
  ['heart', 11, 'slash', 'ex_nihilo'],
  ['heart', 12, 'peach', 'dismantle'],
  ['heart', 13, 'dodge', 'zhuahuang'],

  // ♠ 黑桃
  ['spade', 1, 'duel', 'lightning'],
  ['spade', 2, 'double_sword', 'eight_diagram'],
  ['spade', 3, 'dismantle', 'snatch'],
  ['spade', 4, 'dismantle', 'snatch'],
  ['spade', 5, 'green_dragon', 'jueying'],
  ['spade', 6, 'indulgence', 'qinggang'],
  ['spade', 7, 'slash', 'barbarian'],
  ['spade', 8, 'slash', 'slash'],
  ['spade', 9, 'slash', 'slash'],
  ['spade', 10, 'slash', 'slash'],
  ['spade', 11, 'snatch', 'nullification'],
  ['spade', 12, 'dismantle', 'serpent_spear'],
  ['spade', 13, 'barbarian', 'dawan'],

  // ♦ 方塊
  ['diamond', 1, 'crossbow', 'duel'],
  ['diamond', 2, 'dodge', 'dodge'],
  ['diamond', 3, 'dodge', 'snatch'],
  ['diamond', 4, 'dodge', 'snatch'],
  ['diamond', 5, 'dodge', 'rock_axe'],
  ['diamond', 6, 'slash', 'dodge'],
  ['diamond', 7, 'slash', 'dodge'],
  ['diamond', 8, 'slash', 'dodge'],
  ['diamond', 9, 'slash', 'dodge'],
  ['diamond', 10, 'slash', 'dodge'],
  ['diamond', 11, 'dodge', 'dodge'],
  ['diamond', 12, 'peach', 'halberd'],
  ['diamond', 13, 'slash', 'zixing'],

  // ♣ 梅花
  ['club', 1, 'duel', 'crossbow'],
  ['club', 2, 'slash', 'eight_diagram'],
  ['club', 3, 'slash', 'dismantle'],
  ['club', 4, 'slash', 'dismantle'],
  ['club', 5, 'slash', 'dilu'],
  ['club', 6, 'slash', 'indulgence'],
  ['club', 7, 'slash', 'barbarian'],
  ['club', 8, 'slash', 'slash'],
  ['club', 9, 'slash', 'slash'],
  ['club', 10, 'slash', 'slash'],
  ['club', 11, 'slash', 'slash'],
  ['club', 12, 'collateral', 'nullification'],
  ['club', 13, 'collateral', 'nullification'],
];

/** EX 4 張：寒冰劍、仁王盾、閃電、無懈可擊。 */
const EX_ENTRIES: readonly Entry[] = [
  ['spade', 2, 'ice_sword'],
  ['club', 2, 'renwang'],
  ['heart', 12, 'lightning'],
  ['diamond', 12, 'nullification'],
];

/** 軍爭篇 52 張。 */
const JUNZHENG_ENTRIES: readonly Entry[] = [
  // ♥ 紅桃
  ['heart', 1, 'nullification'],
  ['heart', 2, 'fire_attack'],
  ['heart', 3, 'fire_attack'],
  ['heart', 4, 'fire_slash'],
  ['heart', 5, 'peach'],
  ['heart', 6, 'peach'],
  ['heart', 7, 'fire_slash'],
  ['heart', 8, 'dodge'],
  ['heart', 9, 'dodge'],
  ['heart', 10, 'fire_slash'],
  ['heart', 11, 'dodge'],
  ['heart', 12, 'dodge'],
  ['heart', 13, 'nullification'],

  // ♦ 方塊
  ['diamond', 1, 'fan'],
  ['diamond', 2, 'peach'],
  ['diamond', 3, 'peach'],
  ['diamond', 4, 'fire_slash'],
  ['diamond', 5, 'fire_slash'],
  ['diamond', 6, 'dodge'],
  ['diamond', 7, 'dodge'],
  ['diamond', 8, 'dodge'],
  ['diamond', 9, 'wine'],
  ['diamond', 10, 'dodge'],
  ['diamond', 11, 'dodge'],
  ['diamond', 12, 'fire_attack'],
  ['diamond', 13, 'hualiu'],

  // ♣ 梅花
  ['club', 1, 'silver_lion'],
  ['club', 2, 'vine_armor'],
  ['club', 3, 'wine'],
  ['club', 4, 'supply_shortage'],
  ['club', 5, 'thunder_slash'],
  ['club', 6, 'thunder_slash'],
  ['club', 7, 'thunder_slash'],
  ['club', 8, 'thunder_slash'],
  ['club', 9, 'wine'],
  ['club', 10, 'iron_chain'],
  ['club', 11, 'iron_chain'],
  ['club', 12, 'iron_chain'],
  ['club', 13, 'iron_chain'],

  // ♠ 黑桃
  ['spade', 1, 'ancient_scimitar'],
  ['spade', 2, 'vine_armor'],
  ['spade', 3, 'wine'],
  ['spade', 4, 'thunder_slash'],
  ['spade', 5, 'thunder_slash'],
  ['spade', 6, 'thunder_slash'],
  ['spade', 7, 'thunder_slash'],
  ['spade', 8, 'thunder_slash'],
  ['spade', 9, 'wine'],
  ['spade', 10, 'supply_shortage'],
  ['spade', 11, 'iron_chain'],
  ['spade', 12, 'iron_chain'],
  ['spade', 13, 'nullification'],
];

let nextCardId = 1;

function buildCards(entries: readonly Entry[]): Card[] {
  const cards: Card[] = [];
  for (const [suit, rank, ...names] of entries) {
    for (const name of names) {
      cards.push({ id: nextCardId++, name, suit, rank });
    }
  }
  return cards;
}

/** 完整 160 張牌（標準 104 + EX 4 + 軍爭 52）。 */
export const FULL_DECK: readonly Card[] = Object.freeze([
  ...buildCards(STANDARD_ENTRIES),
  ...buildCards(EX_ENTRIES),
  ...buildCards(JUNZHENG_ENTRIES),
]);

export const CARD_INDEX: ReadonlyMap<number, Card> = new Map(FULL_DECK.map((card) => [card.id, card]));

export function getCard(id: number): Card {
  const card = CARD_INDEX.get(id);
  if (!card) throw new Error(`Unknown card id: ${id}`);
  return card;
}

/**
 * 牌堆。M2 起所有牌都已實作，`m1` 與 `full` 等價；
 * 保留 `m1` 僅為舊測試與舊存檔相容。
 */
export function createDeck(pool: 'm1' | 'full' = 'full'): Card[] {
  if (pool === 'full') return [...FULL_DECK];
  return FULL_DECK.filter((card) => CARD_META[card.name].implemented);
}

export function countCardsByName(cards: readonly Card[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const card of cards) {
    counts[card.name] = (counts[card.name] ?? 0) + 1;
  }
  return counts;
}

export const CARD_DATA_VERSION = '1.0.0';
