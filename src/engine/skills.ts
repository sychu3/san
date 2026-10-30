import type { PlayerState } from './types';
import { getGeneral, SKILL_LABELS } from '../data/generals';

/**
 * M3 武將技能宣告。
 *
 * 這裡只宣告技能的識別、類型與說明；實際結算仍寫在 `engine.ts`，
 * 因為技能需要向玩家發出請求（generator），無法用同步 hook 完成。
 * `events.ts` 的時機 hook 保留給不需要請求的內部觀察。
 */
export type SkillType = 'triggered' | 'active' | 'locked' | 'lord' | 'conversion';

export interface SkillMeta {
  id: string;
  name: string;
  type: SkillType;
  description: string;
}

export const SKILL_META: Record<string, SkillMeta> = {
  jianxiong: {
    id: 'jianxiong',
    name: '奸雄',
    type: 'triggered',
    description: '當你受到傷害後，你可以獲得造成此傷害的牌。',
  },
  hujia: {
    id: 'hujia',
    name: '護駕',
    type: 'lord',
    description: '主公技。當你需要使用或打出【閃】時，你可以令其他魏勢力角色代替你打出。',
  },
  rende: {
    id: 'rende',
    name: '仁德',
    type: 'active',
    description: '出牌階段，你可以將任意張手牌交給其他角色；每回合累計給出第二張時，回復 1 點體力。',
  },
  jijiang: {
    id: 'jijiang',
    name: '激將',
    type: 'lord',
    description: '主公技。當你需要使用或打出【殺】時，你可以令其他蜀勢力角色代替你打出。',
  },
  zhiheng: {
    id: 'zhiheng',
    name: '制衡',
    type: 'active',
    description: '出牌階段限一次，你可以棄置任意張手牌，然後摸等量的牌。',
  },
  jiuyuan: {
    id: 'jiuyuan',
    name: '救援',
    type: 'lord',
    description: '主公技。其他吳勢力角色對你使用【桃】時，回復值 +1。',
  },
  wusheng: {
    id: 'wusheng',
    name: '武聖',
    type: 'conversion',
    description: '你可以將一張紅色牌當【殺】使用或打出。',
  },
  paoxiao: {
    id: 'paoxiao',
    name: '咆哮',
    type: 'locked',
    description: '鎖定技。你使用【殺】不受每回合一次的限制。',
  },
  longdan: {
    id: 'longdan',
    name: '龍膽',
    type: 'conversion',
    description: '你可以將【殺】當【閃】、將【閃】當【殺】使用或打出。',
  },
  jizhi: {
    id: 'jizhi',
    name: '集智',
    type: 'triggered',
    description: '當你使用一張非延時錦囊牌時，你可以摸一張牌。',
  },
  qicai: {
    id: 'qicai',
    name: '奇才',
    type: 'locked',
    description: '鎖定技。你使用錦囊牌沒有距離限制。',
  },
  wushuang: {
    id: 'wushuang',
    name: '無雙',
    type: 'locked',
    description: '鎖定技。你使用【殺】時，目標需連續打出兩張【閃】；你使用【決鬥】時，對手每次需連續打出兩張【殺】。',
  },
  lijian: {
    id: 'lijian',
    name: '離間',
    type: 'active',
    description: '出牌階段限一次，你可以棄置一張牌，令兩名男性角色視為由其中一名對另一名使用【決鬥】。',
  },
  biyue: {
    id: 'biyue',
    name: '閉月',
    type: 'triggered',
    description: '結束階段開始時，你可以摸一張牌。',
  },
  jijiu: {
    id: 'jijiu',
    name: '急救',
    type: 'conversion',
    description: '你的回合外，你可以將一張紅色牌當【桃】使用。',
  },
  qingnang: {
    id: 'qingnang',
    name: '青囊',
    type: 'active',
    description: '出牌階段限一次，你可以棄置一張手牌，令一名角色回復 1 點體力。',
  },
  fankui: {
    id: 'fankui',
    name: '反饋',
    type: 'triggered',
    description: '當你受到傷害後，你可以獲得傷害來源的一張牌。',
  },
  guicai: {
    id: 'guicai',
    name: '鬼才',
    type: 'triggered',
    description: '在任一角色的判定牌生效前，你可以打出一張手牌代替之。',
  },
  ganglie: {
    id: 'ganglie',
    name: '剛烈',
    type: 'triggered',
    description: '當你受到傷害後，你可以判定；若非紅桃，來源棄置一張手牌或受到 1 點傷害。',
  },
  tuxi: {
    id: 'tuxi',
    name: '突襲',
    type: 'triggered',
    description: '摸牌階段，你可以放棄摸牌，改為獲得至多兩名其他角色各一張手牌。',
  },
  luoyi: {
    id: 'luoyi',
    name: '裸衣',
    type: 'triggered',
    description: '摸牌階段，你可以少摸一張牌；本回合你的【殺】與【決鬥】傷害 +1。',
  },
  tiandu: {
    id: 'tiandu',
    name: '天妒',
    type: 'triggered',
    description: '當你的判定牌生效後，你可以獲得之。',
  },
  yiji: {
    id: 'yiji',
    name: '遺計',
    type: 'triggered',
    description: '當你受到傷害後，你可以摸兩張牌。',
  },
  qingguo: {
    id: 'qingguo',
    name: '傾國',
    type: 'conversion',
    description: '你可以將一張黑色手牌當【閃】使用或打出。',
  },
  luoshen: {
    id: 'luoshen',
    name: '洛神',
    type: 'triggered',
    description: '準備階段開始時，你可以判定：黑色則獲得該牌並可重複，紅色則置於牌堆頂。',
  },
  guanxing: {
    id: 'guanxing',
    name: '觀星',
    type: 'triggered',
    description: '準備階段開始時，你可以觀看牌堆頂的牌，並將任意張數移到牌堆底。',
  },
  kongcheng: {
    id: 'kongcheng',
    name: '空城',
    type: 'locked',
    description: '鎖定技。你沒有手牌時，不能成為【殺】或【決鬥】的目標。',
  },
  tieqi: {
    id: 'tieqi',
    name: '鐵騎',
    type: 'triggered',
    description: '當你使用【殺】指定目標後，你可以判定：紅色則此【殺】不可被【閃】抵消。',
  },
  mashu: {
    id: 'mashu',
    name: '馬術',
    type: 'locked',
    description: '鎖定技。你與其他角色的距離 -1。',
  },
  qixi: {
    id: 'qixi',
    name: '奇襲',
    type: 'conversion',
    description: '你可以將一張黑色牌當【過河拆橋】使用。',
  },
  keji: {
    id: 'keji',
    name: '克己',
    type: 'locked',
    description: '鎖定技。若你於出牌階段未使用或打出【殺】，你可以跳過棄牌階段。',
  },
  kurou: {
    id: 'kurou',
    name: '苦肉',
    type: 'active',
    description: '出牌階段，你可以失去 1 點體力，然後摸兩張牌。',
  },
  yingzi: {
    id: 'yingzi',
    name: '英姿',
    type: 'locked',
    description: '鎖定技。摸牌階段你多摸一張牌。',
  },
  fanjian: {
    id: 'fanjian',
    name: '反間',
    type: 'active',
    description: '出牌階段限一次，令一名其他角色猜花色；猜錯則受到 1 點傷害。',
  },
  guose: {
    id: 'guose',
    name: '國色',
    type: 'conversion',
    description: '你可以將一張方塊牌當【樂不思蜀】使用。',
  },
  liuli: {
    id: 'liuli',
    name: '流離',
    type: 'triggered',
    description: '當你成為【殺】的目標時，你可以棄置一張牌，將此【殺】轉移給你攻擊範圍內的一名其他角色。',
  },
  qianxun: {
    id: 'qianxun',
    name: '謙遜',
    type: 'locked',
    description: '鎖定技。你不能成為【順手牽羊】或【樂不思蜀】的目標。',
  },
  lianying: {
    id: 'lianying',
    name: '連營',
    type: 'triggered',
    description: '當你失去最後一張手牌時，你可以摸一張牌。',
  },
  jieyin: {
    id: 'jieyin',
    name: '結姻',
    type: 'active',
    description: '出牌階段限一次，你可以棄置兩張手牌，令自己與一名已受傷角色各回復 1 點體力。',
  },
  xiaogi: {
    id: 'xiaogi',
    name: '梟姬',
    type: 'triggered',
    description: '當你失去裝備區的一張牌時，你可以摸兩張牌。',
  },
};

/** 這個角色是否擁有指定技能；主公技額外要求角色身份為主公。 */
export function hasSkill(player: PlayerState, id: string): boolean {
  const skill = SKILL_META[id];
  if (!skill) return false;
  if (skill.type === 'lord' && player.role !== 'lord') return false;
  return getGeneral(player.generalId).skills.includes(id);
}

/** 角色目前的技能（含名稱），供 UI 顯示。 */
export function skillsOf(player: PlayerState): SkillMeta[] {
  return getGeneral(player.generalId)
    .skills.map((id) => SKILL_META[id])
    .filter((skill): skill is SkillMeta => Boolean(skill))
    .map((skill) => ({ ...skill, name: skill.name || SKILL_LABELS[skill.id] || skill.id }));
}
