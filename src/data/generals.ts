import type { GeneralDef } from '../engine/types';

/**
 * 標準包 25 名武將。
 *
 * M1 只使用 MVP_GENERAL_IDS；技能資料已預留，引擎會逐步接入。
 */
export const GENERALS = [
  // 魏
  { id: 'cao_cao', name: '曹操', kingdom: 'wei', gender: 'male', maxHp: 4, skills: ['jianxiong', 'hujia'] },
  { id: 'sima_yi', name: '司馬懿', kingdom: 'wei', gender: 'male', maxHp: 3, skills: ['fankui', 'guicai'] },
  { id: 'xiahou_dun', name: '夏侯惇', kingdom: 'wei', gender: 'male', maxHp: 4, skills: ['ganglie'] },
  { id: 'zhang_liao', name: '張遼', kingdom: 'wei', gender: 'male', maxHp: 4, skills: ['tuxi'] },
  { id: 'xu_chu', name: '許褚', kingdom: 'wei', gender: 'male', maxHp: 4, skills: ['luoyi'] },
  { id: 'guo_jia', name: '郭嘉', kingdom: 'wei', gender: 'male', maxHp: 3, skills: ['tiandu', 'yiji'] },
  { id: 'zhen_ji', name: '甄姬', kingdom: 'wei', gender: 'female', maxHp: 3, skills: ['qingguo', 'luoshen'] },

  // 蜀
  { id: 'liu_bei', name: '劉備', kingdom: 'shu', gender: 'male', maxHp: 4, skills: ['rende', 'jijiang'] },
  { id: 'guan_yu', name: '關羽', kingdom: 'shu', gender: 'male', maxHp: 4, skills: ['wusheng'] },
  { id: 'zhang_fei', name: '張飛', kingdom: 'shu', gender: 'male', maxHp: 4, skills: ['paoxiao'] },
  { id: 'zhuge_liang', name: '諸葛亮', kingdom: 'shu', gender: 'male', maxHp: 3, skills: ['guanxing', 'kongcheng'] },
  { id: 'zhao_yun', name: '趙雲', kingdom: 'shu', gender: 'male', maxHp: 4, skills: ['longdan'] },
  { id: 'ma_chao', name: '馬超', kingdom: 'shu', gender: 'male', maxHp: 4, skills: ['mashu', 'tieqi'] },
  { id: 'huang_yueying', name: '黃月英', kingdom: 'shu', gender: 'female', maxHp: 3, skills: ['jizhi', 'qicai'] },

  // 吳
  { id: 'sun_quan', name: '孫權', kingdom: 'wu', gender: 'male', maxHp: 4, skills: ['zhiheng', 'jiuyuan'] },
  { id: 'gan_ning', name: '甘寧', kingdom: 'wu', gender: 'male', maxHp: 4, skills: ['qixi'] },
  { id: 'lv_meng', name: '呂蒙', kingdom: 'wu', gender: 'male', maxHp: 4, skills: ['keji'] },
  { id: 'huang_gai', name: '黃蓋', kingdom: 'wu', gender: 'male', maxHp: 4, skills: ['kurou'] },
  { id: 'zhou_yu', name: '周瑜', kingdom: 'wu', gender: 'male', maxHp: 3, skills: ['yingzi', 'fanjian'] },
  { id: 'da_qiao', name: '大喬', kingdom: 'wu', gender: 'female', maxHp: 3, skills: ['guose', 'liuli'] },
  { id: 'lu_xun', name: '陸遜', kingdom: 'wu', gender: 'male', maxHp: 3, skills: ['qianxun', 'lianying'] },
  { id: 'sun_shangxiang', name: '孫尚香', kingdom: 'wu', gender: 'female', maxHp: 3, skills: ['jieyin', 'xiaogi'] },

  // 群
  { id: 'hua_tuo', name: '華佗', kingdom: 'qun', gender: 'male', maxHp: 3, skills: ['jijiu', 'qingnang'] },
  { id: 'lv_bu', name: '呂布', kingdom: 'qun', gender: 'male', maxHp: 4, skills: ['wushuang'] },
  { id: 'diao_chan', name: '貂蟬', kingdom: 'qun', gender: 'female', maxHp: 3, skills: ['lijian', 'biyue'] },
] satisfies readonly GeneralDef[];

export const GENERAL_INDEX: ReadonlyMap<string, GeneralDef> = new Map(
  GENERALS.map((general) => [general.id, general]),
);

export function getGeneral(id: string): GeneralDef {
  const general = GENERAL_INDEX.get(id);
  if (!general) throw new Error(`Unknown general id: ${id}`);
  return general;
}

/** 全部標準包武將 id（25 名）。 */
export const ALL_GENERAL_IDS: readonly string[] = GENERALS.map((general) => general.id);

/** M1 首批 10 名武將。 */
export const MVP_GENERAL_IDS = [
  'cao_cao',
  'liu_bei',
  'sun_quan',
  'guan_yu',
  'zhang_fei',
  'zhao_yun',
  'huang_yueying',
  'lv_bu',
  'diao_chan',
  'hua_tuo',
] as const;

export const SKILL_LABELS: Record<string, string> = {
  jianxiong: '奸雄',
  hujia: '護駕',
  fankui: '反饋',
  guicai: '鬼才',
  ganglie: '剛烈',
  tuxi: '突襲',
  luoyi: '裸衣',
  tiandu: '天妒',
  yiji: '遺計',
  qingguo: '傾國',
  luoshen: '洛神',
  rende: '仁德',
  jijiang: '激將',
  wusheng: '武聖',
  paoxiao: '咆哮',
  guanxing: '觀星',
  kongcheng: '空城',
  longdan: '龍膽',
  mashu: '馬術',
  tieqi: '鐵騎',
  jizhi: '集智',
  qicai: '奇才',
  zhiheng: '制衡',
  jiuyuan: '救援',
  qixi: '奇襲',
  keji: '克己',
  kurou: '苦肉',
  yingzi: '英姿',
  fanjian: '反間',
  guose: '國色',
  liuli: '流離',
  qianxun: '謙遜',
  lianying: '連營',
  jieyin: '結姻',
  xiaogi: '梟姬',
  jijiu: '急救',
  qingnang: '青囊',
  wushuang: '無雙',
  lijian: '離間',
  biyue: '閉月',
};

export const KINGDOM_LABELS: Record<string, string> = {
  wei: '魏',
  shu: '蜀',
  wu: '吳',
  qun: '群',
};

export const ROLE_LABELS: Record<string, string> = {
  lord: '主公',
  loyal: '忠臣',
  rebel: '反賊',
  spy: '內奸',
};

export const ROLE_GOALS: Record<string, string> = {
  lord: '消滅所有反賊與內奸。誤殺忠臣會棄置所有牌。',
  loyal: '保護主公，協助主公消滅反賊與內奸。',
  rebel: '擊殺主公。主公死亡且場上仍有反賊時，反賊勝。',
  spy: '先協助主公清除反賊，最後成為場上唯一存活者。',
};
