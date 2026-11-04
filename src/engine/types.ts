/** 共用型別：卡牌、玩家、遊戲狀態、請求／回應、視角。 */

export type PlayerId = number;

export type Suit = 'spade' | 'heart' | 'club' | 'diamond';
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export type Nature = 'normal' | 'fire' | 'thunder';
export type CardType = 'basic' | 'trick' | 'delayed' | 'equip';
export type EquipSlot = 'weapon' | 'armor' | 'horse_plus' | 'horse_minus';

export type CardName =
  | 'slash'
  | 'fire_slash'
  | 'thunder_slash'
  | 'dodge'
  | 'peach'
  | 'wine'
  | 'dismantle'
  | 'snatch'
  | 'duel'
  | 'collateral'
  | 'ex_nihilo'
  | 'nullification'
  | 'barbarian'
  | 'arrows'
  | 'peach_garden'
  | 'harvest'
  | 'lightning'
  | 'indulgence'
  | 'iron_chain'
  | 'fire_attack'
  | 'supply_shortage'
  | 'crossbow'
  | 'double_sword'
  | 'qinggang'
  | 'ice_sword'
  | 'ancient_scimitar'
  | 'serpent_spear'
  | 'green_dragon'
  | 'rock_axe'
  | 'fan'
  | 'halberd'
  | 'qilin_bow'
  | 'eight_diagram'
  | 'renwang'
  | 'vine_armor'
  | 'silver_lion'
  | 'jueying'
  | 'zhuahuang'
  | 'dilu'
  | 'hualiu'
  | 'chitu'
  | 'dawan'
  | 'zixing';

export interface CardMeta {
  name: CardName;
  label: string;
  type: CardType;
  subtype?: EquipSlot;
  nature?: Nature;
  range?: number;
  /** M1 是否已實作。false 的牌仍然存在於完整牌堆，但不會進入 M1 牌堆。 */
  implemented: boolean;
}

export interface Card {
  id: number;
  name: CardName;
  suit: Suit;
  rank: Rank;
}

/**
 * 一次「使用牌」的完整脈絡。
 *
 * `card` / `cards` 是實際消耗的實體牌；`name` / `suit` / `rank` / `nature`
 * 是本次使用「視為」的牌。丈八蛇矛、武聖等轉化牌都走同一個結構。
 */
export interface CardUse {
  id: number;
  source: PlayerId;
  card: Card;
  cards: Card[];
  name: CardName;
  suit: Suit;
  rank: Rank;
  nature: Nature;
  targets: PlayerId[];
  skill?: string;
}

export type Role = 'lord' | 'loyal' | 'rebel' | 'spy';
export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * 公開事件：只包含全桌都看得到的資訊，供 AI 更新身份信念。
 * AI 不得從中取得手牌、未公開身份或牌堆順序。
 */
export interface PublicEvent {
  seq: number;
  kind: 'use' | 'damage' | 'death' | 'save' | 'give' | 'heal';
  source: PlayerId | null;
  target: PlayerId | null;
  cardName?: CardName;
  /** 由技能造成的公開效果（例如 jieyin、qingnang、yiji）。 */
  skill?: string;
  amount?: number;
  /** 只有 kind === 'death' 且身份公開時才有。 */
  role?: Role;
  /** 只有 kind === 'give' 才有：給牌前目標是否處於 0 手牌【空城】。 */
  brokeKongcheng?: boolean;
}
export type Kingdom = 'wei' | 'shu' | 'wu' | 'qun';
export type Gender = 'male' | 'female';

export interface GeneralDef {
  id: string;
  name: string;
  kingdom: Kingdom;
  gender: Gender;
  maxHp: number;
  skills: string[];
}

export interface EquipState {
  weapon: Card | null;
  armor: Card | null;
  horsePlus: Card | null;
  horseMinus: Card | null;
}

export interface PlayerState {
  id: PlayerId;
  seat: number;
  generalId: string;
  role: Role;
  hp: number;
  maxHp: number;
  hand: Card[];
  equips: EquipState;
  judgeZone: Card[];
  chained: boolean;
  alive: boolean;
  wine: boolean;
  wineUsed: boolean;
  slashUsed: number;
  marks: Record<string, number | boolean>;
}

export type Phase = 'prepare' | 'judge' | 'draw' | 'play' | 'discard' | 'end';

export type LogKind =
  | 'system'
  | 'phase'
  | 'draw'
  | 'play'
  | 'damage'
  | 'heal'
  | 'judge'
  | 'equip'
  | 'death'
  | 'win';

export interface LogEntry {
  seq: number;
  kind: LogKind;
  text: string;
}

export interface Winner {
  roles: Role[];
  reason: string;
}

export interface GameResult {
  winner: Winner;
  turns: number;
  log: LogEntry[];
}

export interface GameState {
  version: string;
  seed: number;
  rngState: number;
  players: PlayerState[];
  deck: Card[];
  discard: Card[];
  turn: PlayerId;
  phase: Phase;
  turnCount: number;
  winner: Winner | null;
  /** 判定區延時錦囊的「視為牌名」；轉化牌（如【國色】）需要靠這個對照。 */
  delayedNames: Record<number, CardName>;
  /** 公開事件串流；供 AI 以公開資訊做身份推理。 */
  publicEvents: PublicEvent[];
  eventSeq: number;
  log: LogEntry[];
  logSeq: number;
  requestSeq: number;
  useSeq: number;
  pending: Request | null;
}

/* ------------------------------------------------------------------ */
/* 請求與回應                                                          */
/* ------------------------------------------------------------------ */

export type OptionKind = 'play' | 'respond' | 'skill' | 'pass';

export interface PlayOption {
  id: string;
  label: string;
  kind: OptionKind;
  cards: number[];
  targets: PlayerId[];
  asCard?: CardName;
  nature?: Nature;
  skill?: string;
}

export interface ResponseOption {
  id: string;
  label: string;
  kind: Exclude<OptionKind, 'play'>;
  cards: number[];
  asCard?: CardName;
  skill?: string;
  targets?: PlayerId[];
}

export type ResponseNeed = 'shan' | 'peach' | 'sha' | 'wuxie' | 'choice' | 'card';

interface RequestBase {
  id: number;
  player: PlayerId;
  prompt: string;
}

export type Request =
  | (RequestBase & {
      kind: 'action';
      options: PlayOption[];
      context: string;
    })
  | (RequestBase & {
      kind: 'response';
      options: ResponseOption[];
      need: ResponseNeed;
      context: string;
      /** 無懈可擊等回應需要的被抵消牌資訊。 */
      cardName?: CardName;
      source?: PlayerId;
      targets?: PlayerId[];
      /** 目前已打出的【無懈可擊】張數；奇數代表原錦囊目前被抵消。 */
      nullificationCount?: number;
      /**
       * 寒冰劍等「防止傷害」的技能需要知道這張傷害牌最終會造成多少傷害，
       * 才能判斷是否足以致命（足以致命時應直接收頭，不防止傷害）。
       */
      damage?: number;
    })
  | (RequestBase & {
      kind: 'chooseCards';
      cards: number[];
      min: number;
      max: number;
      reason: string;
      /** 需要自行挑牌的主動技能（例如仁德、制衡），供 AI 決定張數。 */
      skill?: string;
      /** 技能指定的目標（例如仁德的收牌者）。 */
      target?: PlayerId;
    })
  | (RequestBase & {
      kind: 'choosePlayers';
      candidates: PlayerId[];
      min: number;
      max: number;
      reason: string;
    })
  | (RequestBase & {
      kind: 'chooseCard';
      target: PlayerId;
      cards: number[];
      allowRandomHand: boolean;
      handCount: number;
      reason: string;
    })
  | (RequestBase & {
      kind: 'chooseRevealed';
      cards: Card[];
      reason: string;
    })
  | (RequestBase & {
      /** 從指定的牌中選取（不限定手牌，例如【觀星】看牌堆頂）。 */
      kind: 'chooseFrom';
      cards: Card[];
      min: number;
      max: number;
      reason: string;
    });

export type Response =
  | { type: 'option'; optionId: string }
  | { type: 'cards'; cards: number[] }
  | { type: 'players'; players: PlayerId[] }
  | { type: 'card'; card: number }
  | { type: 'pass' };

/* ------------------------------------------------------------------ */
/* 視角（隱藏資訊）                                                     */
/* ------------------------------------------------------------------ */

export interface PlayerView {
  id: PlayerId;
  seat: number;
  name: string;
  generalName: string;
  /** 技能 id 清單；主公技只在該角色是主公時出現。 */
  skills: string[];
  kingdom: Kingdom;
  gender: Gender;
  maxHp: number;
  hp: number;
  role: Role | null;
  alive: boolean;
  handCount: number;
  hand: Card[] | null;
  equips: EquipState;
  judgeZone: Card[];
  chained: boolean;
  wine: boolean;
  slashUsed: number;
}

export interface GameView {
  seed: number;
  turn: number;
  phase: Phase;
  turnCount: number;
  players: PlayerView[];
  deckCount: number;
  discardCount: number;
  discardTop: Card | null;
  /** 最近的公開事件（最多 200 筆），供 AI 身份推理。 */
  events: PublicEvent[];
  log: LogEntry[];
  pending: Request | null;
  waitingFor: PlayerId | null;
  winner: Winner | null;
  godMode: boolean;
}
