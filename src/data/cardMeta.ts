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
    label: '絕影(+1)',
    type: 'equip',
    subtype: 'horse_plus',
    implemented: true,
  },
  zhuahuang: {
    name: 'zhuahuang',
    label: '爪黃飛電(+1)',
    type: 'equip',
    subtype: 'horse_plus',
    implemented: true,
  },
  dilu: { name: 'dilu', label: '的盧(+1)', type: 'equip', subtype: 'horse_plus', implemented: true },
  hualiu: { name: 'hualiu', label: '驊騮(+1)', type: 'equip', subtype: 'horse_plus', implemented: true },
  chitu: { name: 'chitu', label: '赤兔(-1)', type: 'equip', subtype: 'horse_minus', implemented: true },
  dawan: { name: 'dawan', label: '大宛(-1)', type: 'equip', subtype: 'horse_minus', implemented: true },
  zixing: { name: 'zixing', label: '紫騂(-1)', type: 'equip', subtype: 'horse_minus', implemented: true },
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

/**
 * 卡牌說明（滑鼠停留時顯示）。用語盡量與 RULES.md 一致。
 */
export const CARD_DESCRIPTIONS: Record<CardName, string> = {
  slash: '出牌階段對攻擊範圍內一名角色使用；目標需打出【閃】，否則受到 1 點傷害。每回合限一張。',
  fire_slash: '同【殺】，但傷害屬性為火焰。',
  thunder_slash: '同【殺】，但傷害屬性為雷電。',
  dodge: '被【殺】指定或需要打出【閃】時使用，抵消該【殺】。',
  peach: '出牌階段對自己使用回復 1 點體力；或於角色瀕死時對其使用，回復 1 點。',
  wine: '出牌階段對自己使用，本回合下一張【殺】傷害 +1；瀕死時可對自己使用回復 1 點。每回合限一次。',
  dismantle: '棄置一名其他角色區域內的一張牌（手牌為盲選）。',
  snatch: '獲得距離 1 的一名其他角色區域內的一張牌（手牌為盲選）。',
  duel: '目標先打出【殺】，雙方輪流；先無法或不願打出者受到 1 點傷害。',
  collateral: '令一名有武器的角色對其攻擊範圍內的另一名角色使用【殺】；若不出，你獲得其武器。',
  ex_nihilo: '摸兩張牌。',
  nullification: '在錦囊結算前使用，抵消該錦囊；可被另一張【無懈可擊】連環抵消。',
  barbarian: '所有其他角色需打出【殺】，未打出者受到 1 點傷害。',
  arrows: '所有其他角色需打出【閃】，未打出者受到 1 點傷害。',
  peach_garden: '所有存活角色回復 1 點體力。',
  harvest: '翻開等同存活人數的牌，由使用者開始輪流選一張加入手牌。',
  lightning: '放入自己判定區；判定為黑桃 2–9 時受到 3 點雷電傷害，否則移到下一位。',
  indulgence: '放入一名其他角色判定區；其判定非紅桃時跳過出牌階段。',
  iron_chain: '橫置或重置 1–2 名角色；也可重鑄（棄置並摸一張）。橫置角色受屬性傷害時會傳導。',
  fire_attack: '目標展示一張手牌；你棄一張同花色手牌，對其造成 1 點火焰傷害。',
  supply_shortage: '放入距離 1 的一名其他角色判定區；其判定非梅花時跳過摸牌階段。',
  crossbow: '武器，範圍 1。使用【殺】不受每回合一次限制。',
  double_sword: '武器，範圍 2。使用【殺】指定異性目標後，可令其棄一張手牌或讓你摸一張。',
  qinggang: '武器，範圍 2。使用【殺】時無視目標防具。',
  ice_sword: '武器，範圍 2。使用【殺】造成傷害時，可防止傷害並改為棄置目標至多兩張牌。',
  ancient_scimitar: '武器，範圍 2。使用【殺】造成傷害時，若目標沒有手牌，傷害 +1。',
  serpent_spear: '武器，範圍 3。可將兩張手牌當【殺】使用或打出。',
  green_dragon: '武器，範圍 3。使用【殺】被【閃】抵消時，可再對同一目標使用一張【殺】。',
  rock_axe: '武器，範圍 3。使用【殺】時可棄兩張手牌，令此【殺】不可被【閃】抵消且傷害 +1。',
  fan: '武器，範圍 4。可將普通【殺】當火【殺】使用。',
  halberd: '武器，範圍 4。使用【殺】時若此牌為最後手牌，可額外指定至多兩名目標。',
  qilin_bow: '武器，範圍 5。使用【殺】造成傷害後，可棄置目標的一匹馬。',
  eight_diagram: '防具。需要打出【閃】時可判定；紅色視為打出【閃】（每次【殺】限一次）。',
  renwang: '防具。黑色【殺】對你無效。',
  vine_armor: '防具。普通【殺】、南蠻入侵、萬箭齊發對你無效；你受到的火焰傷害 +1。',
  silver_lion: '防具。你受到的傷害大於 1 時只受 1 點；失去此裝備時回復 1 點體力。',
  jueying: '坐騎(+1)。其他角色計算與你的距離 +1。',
  zhuahuang: '坐騎(+1)。其他角色計算與你的距離 +1。',
  dilu: '坐騎(+1)。其他角色計算與你的距離 +1。',
  hualiu: '坐騎(+1)。其他角色計算與你的距離 +1。',
  chitu: '坐騎(-1)。你計算與其他角色的距離 -1。',
  dawan: '坐騎(-1)。你計算與其他角色的距離 -1。',
  zixing: '坐騎(-1)。你計算與其他角色的距離 -1。',
};

export function cardDescription(name: CardName): string {
  return CARD_DESCRIPTIONS[name];
}
