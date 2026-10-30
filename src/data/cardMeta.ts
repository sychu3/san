import type { CardMeta, CardName } from '../engine/types';

/**
 * 卡牌靜態資料。
 *
 * `implemented` 代表引擎是否已支援該牌的效果。
 * M2 起 160 張牌全部已接入，完整牌堆即為預設牌堆。
 */
export const CARD_META = {
  slash: { name: 'slash', label: '殺', type: 'basic', nature: 'normal', implemented: true },
  fire_slash: { name: 'fire_slash', label: '火殺', type: 'basic', nature: 'fire', implemented: true },
  thunder_slash: {
    name: 'thunder_slash',
    label: '雷殺',
    type: 'basic',
    nature: 'thunder',
    implemented: true,
  },
  dodge: { name: 'dodge', label: '閃', type: 'basic', implemented: true },
  peach: { name: 'peach', label: '桃', type: 'basic', implemented: true },
  wine: { name: 'wine', label: '酒', type: 'basic', implemented: true },

  dismantle: { name: 'dismantle', label: '過河拆橋', type: 'trick', implemented: true },
  snatch: { name: 'snatch', label: '順手牽羊', type: 'trick', implemented: true },
  duel: { name: 'duel', label: '決鬥', type: 'trick', implemented: true },
  collateral: { name: 'collateral', label: '借刀殺人', type: 'trick', implemented: true },
  ex_nihilo: { name: 'ex_nihilo', label: '無中生有', type: 'trick', implemented: true },
  nullification: {
    name: 'nullification',
    label: '無懈可擊',
    type: 'trick',
    implemented: true,
  },
  barbarian: { name: 'barbarian', label: '南蠻入侵', type: 'trick', implemented: true },
  arrows: { name: 'arrows', label: '萬箭齊發', type: 'trick', implemented: true },
  peach_garden: { name: 'peach_garden', label: '桃園結義', type: 'trick', implemented: true },
  harvest: { name: 'harvest', label: '五穀豐登', type: 'trick', implemented: true },

  lightning: { name: 'lightning', label: '閃電', type: 'delayed', implemented: true },
  indulgence: { name: 'indulgence', label: '樂不思蜀', type: 'delayed', implemented: true },
  iron_chain: { name: 'iron_chain', label: '鐵索連環', type: 'trick', implemented: true },
  fire_attack: { name: 'fire_attack', label: '火攻', type: 'trick', implemented: true },
  supply_shortage: {
    name: 'supply_shortage',
    label: '兵糧寸斷',
    type: 'delayed',
    implemented: true,
  },

  crossbow: {
    name: 'crossbow',
    label: '諸葛連弩',
    type: 'equip',
    subtype: 'weapon',
    range: 1,
    implemented: true,
  },
  double_sword: {
    name: 'double_sword',
    label: '雌雄雙股劍',
    type: 'equip',
    subtype: 'weapon',
    range: 2,
    implemented: true,
  },
  qinggang: {
    name: 'qinggang',
    label: '青釭劍',
    type: 'equip',
    subtype: 'weapon',
    range: 2,
    implemented: true,
  },
  ice_sword: {
    name: 'ice_sword',
    label: '寒冰劍',
    type: 'equip',
    subtype: 'weapon',
    range: 2,
    implemented: true,
  },
  ancient_scimitar: {
    name: 'ancient_scimitar',
    label: '古錠刀',
    type: 'equip',
    subtype: 'weapon',
    range: 2,
    implemented: true,
  },
  serpent_spear: {
    name: 'serpent_spear',
    label: '丈八蛇矛',
    type: 'equip',
    subtype: 'weapon',
    range: 3,
    implemented: true,
  },
  green_dragon: {
    name: 'green_dragon',
    label: '青龍偃月刀',
    type: 'equip',
    subtype: 'weapon',
    range: 3,
    implemented: true,
  },
  rock_axe: {
    name: 'rock_axe',
    label: '貫石斧',
    type: 'equip',
    subtype: 'weapon',
    range: 3,
    implemented: true,
  },
  fan: {
    name: 'fan',
    label: '朱雀羽扇',
    type: 'equip',
    subtype: 'weapon',
    range: 4,
    implemented: true,
  },
  halberd: {
    name: 'halberd',
    label: '方天畫戟',
    type: 'equip',
    subtype: 'weapon',
    range: 4,
    implemented: true,
  },
  qilin_bow: {
    name: 'qilin_bow',
    label: '麒麟弓',
    type: 'equip',
    subtype: 'weapon',
    range: 5,
    implemented: true,
  },

  eight_diagram: {
    name: 'eight_diagram',
    label: '八卦陣',
    type: 'equip',
    subtype: 'armor',
    implemented: true,
  },
  renwang: { name: 'renwang', label: '仁王盾', type: 'equip', subtype: 'armor', implemented: true },
  vine_armor: {
    name: 'vine_armor',
    label: '藤甲',
    type: 'equip',
    subtype: 'armor',
    implemented: true,
  },
  silver_lion: {
    name: 'silver_lion',
    label: '白銀獅子',
    type: 'equip',
    subtype: 'armor',
    implemented: true,
  },

  jueying: {
    name: 'jueying',
    label: '絕影',
    type: 'equip',
    subtype: 'horse_plus',
    implemented: true,
  },
  zhuahuang: {
    name: 'zhuahuang',
    label: '爪黃飛電',
    type: 'equip',
    subtype: 'horse_plus',
    implemented: true,
  },
  dilu: { name: 'dilu', label: '的盧', type: 'equip', subtype: 'horse_plus', implemented: true },
  hualiu: { name: 'hualiu', label: '驊騮', type: 'equip', subtype: 'horse_plus', implemented: true },
  chitu: { name: 'chitu', label: '赤兔', type: 'equip', subtype: 'horse_minus', implemented: true },
  dawan: { name: 'dawan', label: '大宛', type: 'equip', subtype: 'horse_minus', implemented: true },
  zixing: { name: 'zixing', label: '紫騂', type: 'equip', subtype: 'horse_minus', implemented: true },
} satisfies Record<CardName, CardMeta>;

export function cardLabel(name: CardName): string {
  return CARD_META[name].label;
}

export function cardMeta(name: CardName): CardMeta {
  return CARD_META[name];
}

export function isSlashCard(name: CardName): boolean {
  return name === 'slash' || name === 'fire_slash' || name === 'thunder_slash';
}

export const CARD_NAMES = Object.keys(CARD_META) as CardName[];
