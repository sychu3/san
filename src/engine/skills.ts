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
