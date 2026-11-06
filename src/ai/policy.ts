import type {
  Card,
  CardName,
  Difficulty,
  GameView,
  Nature,
  PlayerId,
  PlayerView,
  PlayOption,
  PublicEvent,
  Request,
  Response,
  Role,
} from '../engine/types';
import { CARD_META } from '../data/cardMeta';
import type { RngState } from '../engine/rng';
import { nextFloat } from '../engine/rng';

/**
 * M1 AI：只讀取「該 AI 自己的視角」，不偷看其他人的手牌與身份。
 * 目標評分依角色與公開資訊（主公已知、自己身份已知）決定。
 */

/** 上帝視角用：單筆公開事件對某個嫌疑分數的影響。 */
export interface BeliefNote {
  seq: number;
  target: PlayerId;
  delta: number;
  text: string;
}

/** 上帝視角用：某個觀察者對某個目標的目前判斷。 */
export interface BeliefCell {
  observer: PlayerId;
  target: PlayerId;
  /** 越高越像反賊；範圍 −20～+20。 */
  score: number;
  relation: Relation;
  /** 已由死亡公開或本來就公開的身份。 */
  knownRole: Role | null;
  /** 最近幾筆造成分數變動的公開事件。 */
  notes: BeliefNote[];
}

/** 上帝視角用：一個觀察者對全桌的判斷。 */
export interface ObserverBelief {
  observer: PlayerId;
  cells: BeliefCell[];
}

/**
 * AI 的跨回合記憶：只由公開事件（`GameView.events`）更新。
 * 不保存任何手牌、牌堆順序或未公開身份。
 */
/** 三假設身份機率的累積對數證據。 */
export interface RoleBelief {
  rebel: number;
  loyal: number;
  spy: number;
}

export interface AiMemory {
  lastEventSeq: number;
  /** 每名未知者對「反賊／忠臣／內奸」的累積對數似然（未含先驗）。 */
  belief: Map<PlayerId, RoleBelief>;
  /** 事件類型 → 已累積的對數貢獻（供上帝視角與上限判斷）。 */
  beliefAcc: Map<PlayerId, Map<string, RoleBelief>>;
  /** 事件類型 → 已計入次數（同類型最多計 N 次，取代舊的軟性地板）。 */
  beliefCnt: Map<PlayerId, Map<string, number>>;
  /** 顯示用：由機率推得的「疑似反賊」分數（越高越像反賊）。 */
  rebelScore: Map<PlayerId, number>;
  /** 死亡時已公開的身份。 */
  knownRole: Map<PlayerId, Role>;
  /**
   * 公開擊殺過忠臣的角色（不含主公自己）。擊殺忠臣是強烈的敵意證據，
   * 但一次只有 +5，未達 6 分門檻，因此另存旗標讓主公能直接斷定其為敵人。
   */
  publicKilledLoyal: Set<PlayerId>;
  /** 最近的身份信念變動；只在上帝視角顯示，不影響決策。 */
  beliefNotes: BeliefNote[];
  /** 公開打出過的【閃】／【桃】次數（高手難度的手牌推測）。 */
  playedDodge: Map<PlayerId, number>;
  playedPeach: Map<PlayerId, number>;
  /** 同一回合內自己的【仁德】已給出張數，避免一次把手牌給光。 */
  rendeTurn: number;
  rendeGiven: number;
  /** 公開的【仁德】事件對各來源的信念影響總量（每回合上限）。 */
  giveTurn: number;
  giveDelta: Map<PlayerId, number>;
  /** 主公第一回合用過的試探【殺】；同回合只准一張。 */
  probeTurn: number;
  probeUsed: boolean;
  /** 本回合是否發動過【裸衣】（自己決定，之後用來估算傷害）。 */
  luoyiTurn: number;
  /** 證據版本號；每次新增／設定證據時遞增，供聯合後驗快取失效。 */
  beliefVersion: number;
  /** 聯合身份後驗的快取（依視圖與證據版本失效）。 */
  beliefCache: { key: string; probs: Map<PlayerId, RoleBelief> } | null;
  /** 主公死亡的公開事件序號；用於回溯「事件發生時主公是否仍存活」。 */
  lordDeathSeq: number;
}

export function createAiMemory(): AiMemory {
  return {
    lastEventSeq: 0,
    belief: new Map(),
    beliefAcc: new Map(),
    beliefCnt: new Map(),
    rebelScore: new Map(),
    knownRole: new Map(),
    publicKilledLoyal: new Set(),
    beliefNotes: [],
    playedDodge: new Map(),
    playedPeach: new Map(),
    rendeTurn: -1,
    rendeGiven: 0,
    giveTurn: -1,
    giveDelta: new Map(),
    probeTurn: -1,
    probeUsed: false,
    luoyiTurn: -1,
    beliefVersion: 0,
    beliefCache: null,
    lordDeathSeq: Number.POSITIVE_INFINITY,
  };
}

/** 加上增減並回傳實際套用的值（受 −20～+20 上限影響）。 */
function bump(
  map: Map<number, number>,
  id: number,
  delta: number,
  min = -20,
  max = 20,
): number {
  const before = map.get(id) ?? 0;
  const next = Math.max(min, Math.min(max, before + delta));
  map.set(id, next);
  return next - before;
}

const SKILL_NOTE_LABELS: Record<string, string> = {
  jieyin: '結姻',
  qingnang: '青囊',
  yiji: '遺計',
  rende: '仁德',
  lijian: '離間',
  collateral: '借刀殺人',
  liuli: '流離',
  tuxi: '突襲',
  jijiang: '激將',
  hujia: '護駕',
};

function eventNoteLabel(event: PublicEvent): string {
  if (event.skill) return SKILL_NOTE_LABELS[event.skill] ?? event.skill;
  if (event.cardName) return CARD_META[event.cardName]?.label ?? event.cardName;
  return '公開行動';
}

/* ================= 機率身份層（三假設） ================= */
type Role3 = 'rebel' | 'loyal' | 'spy';
const ROLE3: Role3[] = ['rebel', 'loyal', 'spy'];
const P_ALLY = 0.6; // 關係視為隊友的機率門檻
const P_SUSPECT_TARGET = 0.6; // spareLord：目標在觀察者眼中已明確偏向某身份時據此分層
const P_NO_ALLY = 0.1; // 反賊：低於此視為非隊友（敵人）
const P_ENEMY_REL = 0.85; // 主公／忠臣：關係視為敵人的敵意機率門檻
const P_CONFIRM_LOYAL = 0.01; // 主公：P(忠) 低於此＝已確認敵人（致命／高成本閘用）
const BELIEF_K = 80; // 機率偏離先驗時對目標分的影響係數
const JOINT_BLEND = 0.5; // 聯合後驗與逐人獨立近似的幾何混合比例；避免弱證據過度重排名額

function rb(rebel: number, loyal: number, spy: number): RoleBelief {
  return { rebel, loyal, spy };
}
function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 每類公開事件在三個假設下的似然（對數）。由 Phase A 實測率擬合並保守化。 */
const EV = {
  hostileOnLord: rb(Math.log(6), Math.log(0.1), Math.log(0.1)),
  hostileGroupLord: rb(Math.log(2.0), Math.log(0.35), Math.log(0.35)),
  damageLord: rb(Math.log(1.8), Math.log(0.6), Math.log(0.6)),
  // 【決鬥】傷害可能被【離間】強迫，只給微弱證據。
  damageLordWeak: rb(Math.log(1.3), Math.log(0.9), Math.log(0.9)),
  saveLord: rb(Math.log(0.02), Math.log(1.7), Math.log(1.7)),
  healLord: rb(Math.log(0.05), Math.log(1.6), Math.log(1.2)),
  giveLord: rb(Math.log(0.05), Math.log(1.6), Math.log(1.2)),
  beneficialLord: rb(Math.log(0.4), Math.log(1.1), Math.log(1.1)),
  killRebel: rb(Math.log(0.7), Math.log(1.15), Math.log(1.15)),
  killSpy: rb(Math.log(0.9), Math.log(1.05), Math.log(1.05)),
  killLoyal: rb(Math.log(1.1), Math.log(0.02), Math.log(1.4)),
  helpRebel: rb(Math.log(1.6), Math.log(0.4), Math.log(0.4)),
  // 顯示性偏好：主公是合法目標卻選擇其他目標（機會經嚴格條件過濾）。
  // 500 局實測率約 反 6.5%／忠 100%／奸 77%，這裡保守取比值約 2.3～3 倍。
  spareLord: rb(Math.log(0.3), Math.log(0.9), Math.log(0.72)),
  // 目標在觀察者眼中已明確偏向反賊時，選擇打他更接近忠臣／內奸行為。
  spareLordVsRebel: rb(Math.log(0.2), Math.log(1.1), Math.log(0.9)),
};
/** 同類型事件最多計入幾次，避免刷同一種行為（取代舊的軟性地板）。 */
const EVIDENCE_COUNT: Record<string, number> = {
  hostileOnLord: 4,
  hostileGroupLord: 3,
  damageLord: 3,
  damageLordWeak: 4,
  saveLord: 3,
  healLord: 5,
  giveLord: 5,
  beneficialLord: 3,
  killRebel: 2,
  killSpy: 2,
  killLoyal: 2,
  helpRebel: 3,
  spareLord: 3,
};

/** 累積一筆對數證據；同類型最多計 N 次（遞減報酬）。 */
function addEvidence(
  memory: AiMemory,
  playerId: PlayerId,
  type: string,
  table: RoleBelief,
  seq: number,
  text: string,
): void {
  let byType = memory.beliefAcc.get(playerId);
  if (!byType) {
    byType = new Map();
    memory.beliefAcc.set(playerId, byType);
  }
  let cnts = memory.beliefCnt.get(playerId);
  if (!cnts) {
    cnts = new Map();
    memory.beliefCnt.set(playerId, cnts);
  }
  const cap = EVIDENCE_COUNT[type] ?? 4;
  const n = cnts.get(type) ?? 0;
  if (n >= cap) return; // 已達同類型上限，之後不再更新
  cnts.set(type, n + 1);
  memory.beliefVersion += 1;
  const cur = byType.get(type) ?? rb(0, 0, 0);
  cur.rebel += table.rebel;
  cur.loyal += table.loyal;
  cur.spy += table.spy;
  byType.set(type, cur);
  const total = rb(0, 0, 0);
  for (const v of byType.values()) {
    total.rebel += v.rebel;
    total.loyal += v.loyal;
    total.spy += v.spy;
  }
  memory.belief.set(playerId, total);
  const score = 20 * Math.tanh((total.rebel - Math.max(total.loyal, total.spy)) / 2);
  memory.rebelScore.set(playerId, Math.round(clampNum(score, -20, 20)));
  memory.beliefNotes.push({ seq, target: playerId, delta: Math.round(table.rebel - table.loyal), text });
  if (memory.beliefNotes.length > 60) {
    memory.beliefNotes.splice(0, memory.beliefNotes.length - 60);
  }
}

/** 這名玩家的公開／已知身份；自己、主公與已公開死者都算已知。 */
function knownRoleOf(self: PlayerView, memory: AiMemory, player: PlayerView): Role | null {
  if (player.id === self.id) return self.role;
  return player.role ?? memory.knownRole.get(player.id) ?? null;
}

/** 已知身份轉成三假設的一點分佈；主公不屬三假設，歸為非敵方（忠）。 */
function oneHot(role: Role): RoleBelief {
  return rb(role === 'rebel' ? 1 : 0, role === 'loyal' || role === 'lord' ? 1 : 0, role === 'spy' ? 1 : 0);
}

/**
 * 舊的逐人獨立近似；作為聯合後驗的混合基準。
 * 單獨使用時對弱證據較保守，但無法傳遞「忠臣名額被佔」的推論。
 */
function independentBeliefs(view: GameView, self: PlayerView, memory: AiMemory): Map<PlayerId, RoleBelief> {
  const result = new Map<PlayerId, RoleBelief>();
  const counts = remainingRoleCounts(view, self, memory);
  const total = counts.rebel + counts.loyal + counts.spy;
  for (const player of view.players) {
    const known = knownRoleOf(self, memory, player);
    if (known !== null) {
      result.set(player.id, oneHot(known));
      continue;
    }
    if (total <= 0) {
      result.set(player.id, rb(0, 0, 0));
      continue;
    }
    const ev = memory.belief.get(player.id) ?? rb(0, 0, 0);
    const w = rb(0, 0, 0);
    let sum = 0;
    for (const r of ROLE3) {
      if (counts[r] <= 0) continue;
      const value = Math.exp(Math.log(counts[r] / total) + clampNum(ev[r], -12, 12));
      w[r] = value;
      sum += value;
    }
    result.set(player.id, sum > 0 ? rb(w.rebel / sum, w.loyal / sum, w.spy / sum) : rb(0, 0, 0));
  }
  return result;
}

/**
 * 聯合身份後驗：對所有未知存活者枚舉剩餘身份的合法組合，
 * 以公開證據的乘積加權，回傳每人三身份邊際機率。
 * 這讓「張遼很可能忠臣」自然推得「孫尚香很可能是另一名反賊」，
 * 補足逐人獨立近似無法傳遞的角色名額約束。
 * 未知者最多 3 人，合法組合最多 6 種，成本極低。
 */
function jointBeliefs(view: GameView, self: PlayerView, memory: AiMemory): Map<PlayerId, RoleBelief> {
  const result = new Map<PlayerId, RoleBelief>();

  for (const player of view.players) {
    const known = knownRoleOf(self, memory, player);
    if (known !== null) result.set(player.id, oneHot(known));
  }

  const unknown = view.players.filter(
    (player) => player.alive && player.id !== self.id && knownRoleOf(self, memory, player) === null,
  );
  if (unknown.length === 0) return result;

  const counts = remainingRoleCounts(view, self, memory);
  const slots = counts.rebel + counts.loyal + counts.spy;
  if (slots !== unknown.length) {
    // 人數不一致（例如測試用的簡化視圖）：退回逐人獨立近似，避免整組歸零。
    const fallback = independentBeliefs(view, self, memory);
    for (const player of unknown) result.set(player.id, fallback.get(player.id) ?? rb(0, 0, 0));
    return result;
  }

  const remaining: Record<Role3, number> = { ...counts };
  const marginals = new Map<PlayerId, RoleBelief>();
  for (const player of unknown) marginals.set(player.id, rb(0, 0, 0));
  const chosen: Role3[] = [];
  let totalWeight = 0;

  const walk = (index: number, weight: number): void => {
    if (index === unknown.length) {
      totalWeight += weight;
      for (let i = 0; i < unknown.length; i += 1) {
        const id = unknown[i]!.id;
        const role = chosen[i]!;
        const marginal = marginals.get(id);
        if (marginal) marginal[role] += weight;
      }
      return;
    }
    const player = unknown[index]!;
    const ev = memory.belief.get(player.id) ?? rb(0, 0, 0);
    for (const role of ROLE3) {
      if (remaining[role] <= 0) continue;
      remaining[role] -= 1;
      chosen.push(role);
      walk(index + 1, weight * Math.exp(clampNum(ev[role], -12, 12)));
      chosen.pop();
      remaining[role] += 1;
    }
  };
  walk(0, 1);

  // 與逐人獨立近似幾何混合：聯合後驗負責傳遞角色名額，獨立近似負責壓抑
  // 弱證據造成的過度重排（例如把安靜的反賊隊友擠成敵人）。
  const independent = independentBeliefs(view, self, memory);
  const blended = new Map<PlayerId, RoleBelief>();
  for (const [id, marginal] of marginals) {
    if (totalWeight <= 0) {
      blended.set(id, rb(0, 0, 0));
      continue;
    }
    const jointP = rb(marginal.rebel / totalWeight, marginal.loyal / totalWeight, marginal.spy / totalWeight);
    const ind = independent.get(id) ?? rb(0, 0, 0);
    const w = rb(0, 0, 0);
    let sum = 0;
    for (const r of ROLE3) {
      const value =
        Math.pow(Math.max(jointP[r], 1e-9), JOINT_BLEND) * Math.pow(Math.max(ind[r], 1e-9), 1 - JOINT_BLEND);
      w[r] = value;
      sum += value;
    }
    blended.set(id, sum > 0 ? rb(w.rebel / sum, w.loyal / sum, w.spy / sum) : rb(0, 0, 0));
  }
  // 混合會破壞「各角色期望人數＝剩餘名額」的守恆；用 IPF 校正回來，
  // 否則 AoE 這類對機率線性的決策會高估敵人數、連帶打傷隊友。
  alignRoleCounts(blended, counts);
  for (const [id, probs] of blended) result.set(id, probs);
  return result;
}

/** 反覆縮放，使未知者的角色機率總和對齊剩餘名額（逐人重新歸一）。 */
function alignRoleCounts(probs: Map<PlayerId, RoleBelief>, counts: Record<Role3, number>): void {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    for (const role of ROLE3) {
      let sum = 0;
      for (const value of probs.values()) sum += value[role];
      const target = counts[role];
      if (sum <= 1e-9) continue;
      const scale = target / sum;
      for (const value of probs.values()) value[role] *= scale;
    }
    for (const value of probs.values()) {
      const sum = value.rebel + value.loyal + value.spy;
      if (sum > 0) {
        value.rebel /= sum;
        value.loyal /= sum;
        value.spy /= sum;
      }
    }
  }
}

/** 先驗 × 公開證據 → 三身份機率（剩餘人數為硬約束，使用聯合後驗）。 */
export function beliefProbs(
  view: GameView,
  self: PlayerView,
  memory: AiMemory,
  target: PlayerView,
): RoleBelief {
  const key = [
    self.id,
    self.role,
    memory.lastEventSeq,
    memory.beliefVersion,
    view.players
      .map((player) => `${player.id}${player.alive ? 'a' : 'd'}${knownRoleOf(self, memory, player) ?? '?'}`)
      .join(','),
  ].join('|');
  if (memory.beliefCache?.key !== key) {
    memory.beliefCache = { key, probs: jointBeliefs(view, self, memory) };
  }
  return memory.beliefCache.probs.get(target.id) ?? rb(0, 0, 0);
}

/** 這名未知者是否「行為上像反賊」（供援助可疑反賊的證據判斷；不需觀察者）。 */
function looksRebel(memory: AiMemory, id: PlayerId): boolean {
  if (memory.knownRole.get(id) === 'rebel') return true;
  const ev = memory.belief.get(id);
  if (!ev) return false;
  return ev.rebel - Math.max(ev.loyal, ev.spy) > 1.0;
}

/**
 * 測試與除錯用：以「嫌疑分數」形式（正＝像反賊、負＝像忠臣，量級約 ±20）
 * 直接設定對某人的信念證據。實際對局一律由公開事件累積。
 */
export function seedBeliefScore(memory: AiMemory, id: PlayerId, score: number): void {
  const v = clampNum(score * 0.4, -8, 8);
  const ev = rb(v, -v, -v);
  memory.belief.set(id, ev);
  memory.beliefAcc.set(id, new Map([['seed', ev]]));
  memory.beliefVersion += 1;
}

/** 顯示性偏好：只有這些「無距離或條件單純」的直接敵意錦囊會產生 spareLord 證據。 */
const SPARE_LORD_CARDS = new Set<CardName>([
  'dismantle',
  'snatch',
  'duel',
  'fire_attack',
  'indulgence',
  'supply_shortage',
]);

/** 目標是否還有任何公開可見的牌（手牌、裝備、判定區）。 */
function hasAnyPublicCard(player: PlayerView): boolean {
  return (
    player.handCount > 0 ||
    player.equips.weapon !== null ||
    player.equips.armor !== null ||
    player.equips.horsePlus !== null ||
    player.equips.horseMinus !== null ||
    player.judgeZone.length > 0
  );
}

/**
 * 「有機會攻擊主公卻選擇其他目標」的機會判定（顯示性偏好）。
 * 只使用公開資訊與觀察者自己的身份機率，並刻意保守：來源 1 血（自保）、
 * 主公空城／謙遜等情況都不算機會。
 * 回傳目標在觀察者眼中的分類：'rebel' 用較強忠誠表、'spy'／'unknown' 用一般表、
 * null 表示不是機會（含「目標已像忠臣」——打疑似忠臣不是忠誠表現）。
 */
function spareLordTargetKind(
  view: GameView,
  memory: AiMemory,
  selfId: PlayerId | null,
  event: PublicEvent,
  lordId: PlayerId,
): 'unknown' | 'rebel' | 'spy' | null {
  if (event.cardName === undefined || !SPARE_LORD_CARDS.has(event.cardName)) return null;
  const lord = view.players.find((player) => player.id === lordId);
  const source = event.source === null ? null : view.players.find((player) => player.id === event.source);
  if (!lord || !source || !source.alive) return null;
  // 事件發生時主公必須還活著；若現在已死，以死亡序號回溯。
  if (!lord.alive && event.seq >= memory.lordDeathSeq) return null;
  // 1 血角色有充分的自保理由，不打主公不構成忠誠證據。
  if (source.hp <= 1) return null;

  const target = event.target === null ? null : view.players.find((player) => player.id === event.target);
  if (!target) return null;
  const self = selfId === null ? null : view.players.find((player) => player.id === selfId) ?? null;

  // 先用公開已知身份；未知者再用觀察者自己的機率（在本事件證據加入前計算）。
  let kind: 'unknown' | 'rebel' | 'spy' = 'unknown';
  const targetRole =
    target.role ?? memory.knownRole.get(target.id) ?? (self && target.id === self.id ? self.role : null);
  if (targetRole === 'loyal') return null;
  if (targetRole === 'rebel') kind = 'rebel';
  else if (targetRole === 'spy') kind = 'spy';
  else if (self) {
    const pr = beliefProbs(view, self, memory, target);
    if (pr.loyal >= P_SUSPECT_TARGET && pr.loyal >= pr.rebel && pr.loyal >= pr.spy) return null;
    if (pr.rebel >= P_SUSPECT_TARGET && pr.rebel >= pr.loyal && pr.rebel >= pr.spy) kind = 'rebel';
    else if (pr.spy >= P_SUSPECT_TARGET && pr.spy >= pr.rebel && pr.spy >= pr.loyal) kind = 'spy';
  }

  switch (event.cardName) {
    case 'dismantle':
      return hasAnyPublicCard(lord) ? kind : null;
    case 'snatch':
      return hasAnyPublicCard(lord) &&
        !lord.skills.includes('qianxun') &&
        (source.skills.includes('qicai') || viewDistance(view, source, lord) <= 1)
        ? kind
        : null;
    case 'duel':
      return !(lord.skills.includes('kongcheng') && lord.handCount === 0) ? kind : null;
    case 'fire_attack':
      return lord.handCount > 0 ? kind : null;
    case 'indulgence':
      return !lord.skills.includes('qianxun') && !lord.judgeZone.some((card) => card.name === 'indulgence')
        ? kind
        : null;
    case 'supply_shortage':
      return (source.skills.includes('qicai') || viewDistance(view, source, lord) <= 1) &&
        !lord.judgeZone.some((card) => card.name === 'supply_shortage')
        ? kind
        : null;
    default:
      return null;
  }
}

function applyEvent(
  view: GameView,
  memory: AiMemory,
  event: PublicEvent,
  selfId: PlayerId | null,
): void {
  const lordId = view.players.find((player) => player.role === 'lord')?.id ?? null;

  if (event.kind === 'use' && event.cardName && event.source !== null) {
    if (event.cardName === 'dodge') bump(memory.playedDodge, event.source, 1, 0, 20);
    if (event.cardName === 'peach') bump(memory.playedPeach, event.source, 1, 0, 20);
  }
  if (event.kind === 'death' && event.target !== null && event.role) {
    memory.knownRole.set(event.target, event.role);
    if (event.target === lordId) memory.lordDeathSeq = Math.min(memory.lordDeathSeq, event.seq);
  }

  const src = event.source;
  // 主公身份公開、自己不更新自己；這兩者不提供「未知者是誰」的資訊。
  if (src === null || src === selfId || src === lordId) return;

  // 多目標技能：責任在發動技能的人，不在被強迫、被轉移或被拿牌的人。
  if (event.kind === 'use' && event.skill && event.target !== null) {
    if (event.skill === 'lijian') {
      // 主公只要是被離間的其中一方（不論先後），都是把主公拖入決鬥。
      const involved = event.targets ?? (event.target === null ? [] : [event.target]);
      if (lordId !== null && involved.includes(lordId)) {
        addEvidence(memory, src, 'hostileOnLord', EV.hostileOnLord, event.seq, '對主公使用【離間】');
      }
      return;
    }
    if (event.skill === 'collateral') {
      if (event.target === lordId) {
        addEvidence(memory, src, 'hostileOnLord', EV.hostileOnLord, event.seq, '【借刀殺人】令他人攻擊主公');
      }
      return;
    }
    if (event.skill === 'liuli') {
      if (event.target === lordId) {
        addEvidence(memory, src, 'hostileOnLord', EV.hostileOnLord, event.seq, '【流離】將【殺】轉移給主公');
      }
      return;
    }
    if (event.skill === 'tuxi') {
      if (event.target === lordId) {
        addEvidence(memory, src, 'damageLordWeak', EV.damageLordWeak, event.seq, '【突襲】拿走主公的手牌');
      }
      return;
    }
    if (event.skill === 'jijiang' || event.skill === 'hujia') {
      if (event.target === lordId) {
        const label = event.skill === 'jijiang' ? '激將' : '護駕';
        addEvidence(memory, src, 'beneficialLord', EV.beneficialLord, event.seq, `響應【${label}】`);
      }
      return;
    }
  }

  if (event.kind === 'death' && event.target !== null && event.role) {
    // 被【離間】／【借刀殺人】強迫或被【流離】轉移的死亡不是主動出手 → 不計。
    if (event.forcedBy !== undefined || event.redirectedBy !== undefined) return;
    if (event.role === 'rebel') addEvidence(memory, src, 'killRebel', EV.killRebel, event.seq, '擊殺反賊');
    else if (event.role === 'spy') addEvidence(memory, src, 'killSpy', EV.killSpy, event.seq, '擊殺內奸');
    else if (event.role === 'loyal') {
      addEvidence(memory, src, 'killLoyal', EV.killLoyal, event.seq, '擊殺忠臣');
      // 擊殺忠臣是主公可直接斷定的敵意旗標（不受機率平滑影響）。
      memory.publicKilledLoyal.add(src);
    }
    return;
  }

  if (event.kind === 'damage' && event.target === lordId) {
    // 被強迫或被流離轉移的傷害：責任已由起始技能事件（離間／借刀／流離）記錄。
    if (event.forcedBy !== undefined || event.redirectedBy !== undefined) return;
    // 鐵索傳導是間接傷害 → 只給弱證據。
    if (event.fromChain) {
      addEvidence(memory, src, 'damageLordWeak', EV.damageLordWeak, event.seq, '鐵索連環傳導傷害');
      return;
    }
    // 沒有牌名的傷害多半是【剛烈】這類反傷技能，不是自願的主動敵意 → 不計。
    if (event.cardName === undefined) return;
    const group = event.cardName === 'barbarian' || event.cardName === 'arrows';
    const weak = event.cardName === 'duel';
    const type = weak ? 'damageLordWeak' : group ? 'hostileGroupLord' : 'damageLord';
    addEvidence(memory, src, type, EV[type], event.seq, group ? '群體錦囊對主公造成傷害' : '對主公造成傷害');
    return;
  }

  if (event.kind === 'heal' && event.target !== null) {
    if (event.target === lordId) {
      addEvidence(memory, src, 'healLord', EV.healLord, event.seq, `${eventNoteLabel(event)}治療主公`);
    } else if (looksRebel(memory, event.target)) {
      addEvidence(memory, src, 'helpRebel', EV.helpRebel, event.seq, `${eventNoteLabel(event)}治療可疑反賊`);
    }
    return;
  }

  if (event.kind === 'give' && event.target !== null) {
    if (event.target === lordId) {
      // 破壞主公空城是敵意行為，方向與給牌相反。
      if (event.brokeKongcheng) {
        addEvidence(memory, src, 'damageLordWeak', EV.damageLordWeak, event.seq, '破壞主公空城');
      } else {
        addEvidence(memory, src, 'giveLord', EV.giveLord, event.seq, `${eventNoteLabel(event)}交給主公`);
      }
    } else if (event.brokeKongcheng) {
      // 破壞可疑反賊的空城是反賊內部的敵意，不當成幫助反賊。
    } else if (looksRebel(memory, event.target)) {
      addEvidence(memory, src, 'helpRebel', EV.helpRebel, event.seq, `${eventNoteLabel(event)}交給可疑反賊`);
    }
    return;
  }

  if (event.kind === 'use' && event.cardName && event.target !== null) {
    if (event.target === lordId) {
      if (HOSTILE_DIRECTED.has(event.cardName)) {
        addEvidence(memory, src, 'hostileOnLord', EV.hostileOnLord, event.seq, `對主公使用【${eventNoteLabel(event)}】`);
      } else if (HOSTILE_GROUP.has(event.cardName)) {
        addEvidence(memory, src, 'hostileGroupLord', EV.hostileGroupLord, event.seq, `【${eventNoteLabel(event)}】波及主公`);
      }
      // 有益錦囊（【桃園結義】【五穀豐登】）是全場效果，反賊也會用；不當作「幫助主公」證據。
    } else {
      const spareKind = lordId === null ? null : spareLordTargetKind(view, memory, selfId, event, lordId);
      if (spareKind !== null) {
        // 目標疑似反賊時用較強表；未知／疑似內奸維持一般表。
        // 疑似忠臣已由 spareLordTargetKind 回傳 null（不記）。
        const spareTable = spareKind === 'rebel' ? EV.spareLordVsRebel : EV.spareLord;
        addEvidence(memory, src, 'spareLord', spareTable, event.seq, '能攻擊主公卻選擇其他目標');
      }
      if (HOSTILE_GROUP.has(event.cardName) && looksRebel(memory, event.target)) {
        addEvidence(memory, src, 'helpRebel', EV.helpRebel, event.seq, `【${eventNoteLabel(event)}】波及可疑反賊`);
      }
    }
    return;
  }

  if (event.kind === 'save' && event.target !== null) {
    if (event.target === lordId) {
      addEvidence(memory, src, 'saveLord', EV.saveLord, event.seq, '瀕死時救助主公');
    } else if (looksRebel(memory, event.target)) {
      addEvidence(memory, src, 'helpRebel', EV.helpRebel, event.seq, '瀕死時救助可疑反賊');
    }
  }
}

/** 用公開事件更新 AI 記憶（增量，只處理新事件）。 */
export function updateMemory(
  view: GameView,
  memory: AiMemory,
  selfId: PlayerId | null = view.pending?.player ?? null,
): void {
  for (const event of view.events) {
    if (event.seq <= memory.lastEventSeq) continue;
    memory.lastEventSeq = event.seq;
    applyEvent(view, memory, event, selfId);
  }
}

function selfOf(view: GameView): PlayerView {
  const self = view.players.find((player) => player.id === view.pending?.player);
  if (!self) throw new Error('AI view has no pending player');
  return self;
}

/**
 * 目前這一次決策使用的記憶與難度。
 * `decide()` 是同步且不可重入，因此在入口設定一次即可。
 */
let activeMemory: AiMemory | undefined;
let activeDifficulty: Difficulty = 'normal';

/**
 * 反賊可由公開的死亡身份推斷：若忠臣與內奸都已死亡（或已死的反賊數已滿），
 * 則其他存活的非主公角色必定是反賊隊友。只用公開資訊，不偷看隱藏身份。
 * 標準局固定為 1 主公、1 忠臣、2 反賊、1 內奸。
 */
function deducedRebelAlly(self: PlayerView, view: GameView, target: PlayerView): boolean {
  if (self.role !== 'rebel' || !activeMemory) return false;
  const revealed = activeMemory.knownRole;
  const known = revealed.get(target.id);
  if (known === 'rebel') return true;
  if (known !== undefined) return false;
  const revealedRoles = [...revealed.values()];
  const deadRebels = revealedRoles.filter((role) => role === 'rebel').length;
  const loyalDead = revealedRoles.includes('loyal');
  const spyDead = revealedRoles.includes('spy');
  // 只有在忠臣與內奸都已公開死亡後，才能斷定其他存活非主公角色必為反賊。
  if (!(loyalDead && spyDead)) return false;
  const otherRebels = 2 - 1 - deadRebels; // 自己算一名反賊
  const aliveOtherNonLord = view.players.filter(
    (player) => player.alive && player.id !== self.id && player.role !== 'lord',
  ).length;
  return otherRebels > 0 && aliveOtherNonLord <= otherRebels;
}

/** 敵意機率：主公 P(反)+P(奸)、忠臣 P(反)+0.4P(奸)、反賊 1−P(反)。 */
export function enemyProb(
  view: GameView,
  self: PlayerView,
  target: PlayerView,
  memory: AiMemory | undefined = activeMemory,
): number {
  if (!memory) return 0;
  const pr = beliefProbs(view, self, memory, target);
  if (self.role === 'rebel') return 1 - pr.rebel;
  if (self.role === 'loyal') return pr.rebel + 0.4 * pr.spy;
  return pr.rebel + pr.spy; // 主公
}

/** 由先驗與證據得到對目標分的敵意增量（等於先驗時為 0）。 */
function beliefTerm(view: GameView, self: PlayerView, target: PlayerView): number {
  if (activeDifficulty === 'easy' || !activeMemory) return 0;
  if (self.role === 'spy') return 0; // 內奸的目標邏輯另計，先不混入
  const counts = remainingRoleCounts(view, self, activeMemory);
  const total = counts.rebel + counts.loyal + counts.spy;
  if (total <= 0) return 0;
  const pr = beliefProbs(view, self, activeMemory, target);
  if (self.role === 'rebel') return BELIEF_K * (counts.rebel / total - pr.rebel);
  if (self.role === 'loyal') {
    return BELIEF_K * (pr.rebel - counts.rebel / total) + BELIEF_K * 0.4 * pr.spy;
  }
  const priorEnemy = (counts.rebel + counts.spy) / total;
  return BELIEF_K * (pr.rebel + pr.spy - priorEnemy);
}

/** 由公開身份與行為信念得到的敵我三態；未知不當隊友，也不當確定的敵人。 */
export type Relation = 'ally' | 'enemy' | 'unknown';

function isRoleEnemy(selfRole: Role, otherRole: Role): boolean {
  if (selfRole === 'rebel') return otherRole === 'lord' || otherRole === 'loyal' || otherRole === 'spy';
  if (selfRole === 'loyal' || selfRole === 'lord') return otherRole === 'rebel' || otherRole === 'spy';
  // 內奸沒有同伴；除了「主公在後期是敵人」以外，其餘都先當敵人。
  return otherRole !== 'spy';
}

/**
 * 行為上的隊友只能佔用身份人數容許的名額；候選以機率排序。
 */
function behaviorAllyAllowed(
  view: GameView,
  self: PlayerView,
  memory: AiMemory | undefined,
  targetId: PlayerId,
  mode: 'trust' | 'rebel',
  slots: number,
): boolean {
  if (slots <= 0 || !memory) return false;
  const candidates = view.players.filter(
    (player) =>
      player.alive &&
      player.id !== self.id &&
      player.role === null &&
      (memory.knownRole.get(player.id) ?? null) === null,
  );
  const key = (p: PlayerView) => {
    const pr = beliefProbs(view, self, memory, p);
    return mode === 'rebel' ? pr.rebel : pr.loyal;
  };
  candidates.sort((a, b) => key(b) - key(a));
  const index = candidates.findIndex((player) => player.id === targetId);
  return index >= 0 && index < slots;
}

/** 由指定記憶推得的敵我三態；供 AI 決策與上帝視角共用。 */
export function relationFor(
  view: GameView,
  self: PlayerView,
  target: PlayerView,
  memory: AiMemory | undefined,
): Relation {
  if (self.role === null) return 'unknown';
  if (target.id === self.id) return 'ally';
  if (!target.alive) return 'unknown';
  const known = target.role ?? memory?.knownRole.get(target.id) ?? null;
  if (known !== null) {
    if (self.role === 'spy' && known === 'lord') {
      const alive = view.players.filter((player) => player.alive).length;
      return alive <= 2 ? 'enemy' : 'ally';
    }
    return isRoleEnemy(self.role, known) ? 'enemy' : 'ally';
  }
  if (self.role === 'spy') return 'unknown';
  if (!memory) return 'unknown';
  const pr = beliefProbs(view, self, memory, target);
  const counts = remainingRoleCounts(view, self, memory);
  if (self.role === 'rebel') {
    if (pr.rebel >= P_ALLY && behaviorAllyAllowed(view, self, memory, target.id, 'rebel', counts.rebel)) {
      return 'ally';
    }
    if (pr.rebel <= P_NO_ALLY) return 'enemy';
    return 'unknown';
  }
  if (pr.rebel + pr.spy >= P_ENEMY_REL) return 'enemy';
  if (pr.loyal >= P_ALLY && behaviorAllyAllowed(view, self, memory, target.id, 'trust', counts.loyal)) {
    return 'ally';
  }
  return 'unknown';
}

function relationOf(view: GameView, self: PlayerView, target: PlayerView): Relation {
  return relationFor(view, self, target, activeMemory);
}

/** 上帝視角用：把某個觀察者目前的身份判斷整理成可顯示的資料。 */
export function beliefsFor(
  view: GameView,
  memory: AiMemory,
  observerId: PlayerId,
): ObserverBelief {
  const self = view.players[observerId];
  if (!self) return { observer: observerId, cells: [] };
  const cells: BeliefCell[] = view.players.map((target) => {
    const isSelf = target.id === observerId;
    return {
      observer: observerId,
      target: target.id,
      score: isSelf ? 0 : memory.rebelScore.get(target.id) ?? 0,
      relation: isSelf ? 'ally' : relationFor(view, self, target, memory),
      knownRole: isSelf ? self.role : target.role ?? memory.knownRole.get(target.id) ?? null,
      notes: isSelf ? [] : memory.beliefNotes.filter((note) => note.target === target.id).slice(-5),
    };
  });
  return { observer: observerId, cells };
}

/**
 * 公開資訊是否足以斷定目標是「已確認敵人」——致命牌與高成本敵意牌只准打這種目標，
 * 確保不會為了一時收頭或省牌而誤殺可能的隊友。未知不當敵人，也不當隊友；
 * 但固定 5 人標準局下，各身份都能由公開資訊縮小範圍：
 * - 忠臣：除主公外全部都是敵人。
 * - 內奸：除主公（人數 >2 時還要保護）外全部都是敵人。
 * - 主公：公開敵意分數 ≥6、曾公開擊殺忠臣，或忠臣已死後的所有未知非主公。
 * - 反賊：主公、公開已知的忠臣／內奸、自己是唯一反賊、公開分數顯示不像反賊，
 *   或「行為上的另一名反賊隊友已佔住名額」時，其餘不太像反賊的未知非主公。
 */
function isConfirmedEnemy(view: GameView, self: PlayerView, target: PlayerView): boolean {
  if (target.id === self.id || !target.alive) return false;
  const relation = relationOf(view, self, target);
  if (relation === 'ally') return false;

  if (self.role === 'loyal') return target.role !== 'lord';
  if (self.role === 'spy') return true;

  if (self.role === 'lord') {
    if (target.role === 'lord') return false;
    if (!activeMemory) return false;
    if (activeMemory.publicKilledLoyal.has(target.id)) return true;
    // 主公的致命閘只看 P(忠)：附帶的傷害／借刀等弱證據不足以放行致命牌。
    return beliefProbs(view, self, activeMemory, target).loyal <= P_CONFIRM_LOYAL;
  }

  if (relation === 'enemy') return true;

  if (self.role === 'rebel') {
    if (target.role === 'lord') return true;
    const counts = remainingRoleCounts(view, self);
    // 另一名反賊已公開死亡：自己就是唯一反賊，其餘非主公必為忠臣／內奸。
    if (counts.rebel === 0) return true;
    if (!activeMemory) return false;
    const pr = beliefProbs(view, self, activeMemory, target);
    if (pr.rebel <= P_NO_ALLY) return true;
    if (pr.rebel >= P_ALLY) return false;
    // 行為上的隊友只能佔一個反賊名額。若已有一名行為盟友佔住名額，
    // 其餘不太像反賊的未知非主公就不再可能是反賊，可視為敵人。
    return view.players.some(
      (player) =>
        player.alive &&
        player.id !== self.id &&
        player.id !== target.id &&
        player.role !== 'lord' &&
        relationOf(view, self, player) === 'ally',
    );
  }

  return false;
}

function isBlackCard(card: Card): boolean {
  return card.suit === 'spade' || card.suit === 'club';
}

function isRedCard(card: Card): boolean {
  return card.suit === 'heart' || card.suit === 'diamond';
}

function slashNature(name: CardName): Nature {
  if (name === 'fire_slash') return 'fire';
  if (name === 'thunder_slash') return 'thunder';
  return 'normal';
}

function isSlashOption(option: { asCard?: CardName }): boolean {
  return option.asCard === 'slash' || option.asCard === 'fire_slash' || option.asCard === 'thunder_slash';
}

function handCardById(self: PlayerView, id: number): Card | null {
  return (self.hand ?? []).find((card) => card.id === id) ?? null;
}

/** 【殺】是否會被目標的防具或【空城】直接無效。 */
function slashIsEffective(
  self: PlayerView,
  target: PlayerView,
  option: { asCard?: CardName; nature?: Nature; cards?: number[]; skill?: string },
): boolean {
  if (!target.alive || target.id === self.id) return false;
  if (target.skills.includes('kongcheng') && target.handCount === 0) return false;
  const name = option.asCard ?? 'slash';
  const nature = option.nature ?? slashNature(name);
  const ignoreArmor = self.equips.weapon?.name === 'qinggang';
  if (ignoreArmor) return true;
  const armor = target.equips.armor?.name;
  if (armor === 'renwang') {
    if (option.skill === 'serpent_spear') {
      const hand = self.hand ?? [];
      return hand.length >= 2 && hand.some(isRedCard);
    }
    const physical = (option.cards ?? [])
      .map((id) => handCardById(self, id))
      .find((card): card is Card => Boolean(card));
    return physical !== undefined && !isBlackCard(physical);
  }
  if (armor === 'vine_armor') return nature === 'fire';
  return true;
}

/** 【殺】的基礎傷害（未計酒／裸衣）。 */
function slashBaseDamage(self: PlayerView, target: PlayerView, option: { asCard?: CardName }): number {
  let damage = 1;
  const ignoreArmor = self.equips.weapon?.name === 'qinggang';
  if (!ignoreArmor && option.asCard === 'fire_slash' && target.equips.armor?.name === 'vine_armor') {
    damage += 1;
  }
  return damage;
}

/** 連同酒／裸衣與白銀獅子封頂後的實際傷害。 */
function slashDamageWith(
  self: PlayerView,
  target: PlayerView,
  option: { asCard?: CardName },
  bonus: { wine: boolean; luoyi: boolean },
): number {
  let damage = slashBaseDamage(self, target, option);
  if (bonus.wine) damage += 1;
  if (bonus.luoyi) damage += 1;
  const ignoreArmor = self.equips.weapon?.name === 'qinggang';
  if (!ignoreArmor && target.equips.armor?.name === 'silver_lion' && damage > 1) damage = 1;
  return damage;
}

/** 加酒／裸衣是否真的令傷害提升（白銀獅子封頂時不會）。 */
function slashBonusMatters(
  self: PlayerView,
  target: PlayerView,
  option: { asCard?: CardName; nature?: Nature; cards?: number[]; skill?: string },
  bonus: { wine: boolean; luoyi: boolean },
): boolean {
  if (!slashIsEffective(self, target, option)) return false;
  const base = slashDamageWith(self, target, option, { wine: false, luoyi: false });
  const boosted = slashDamageWith(self, target, option, bonus);
  // 加傷要真的提升傷害，而且目標不是本來就會被基礎傷害帶走。
  return boosted > base && target.hp > base;
}

/** 本回合是否已發動【裸衣】（傷害 +1）。 */
function luoyiActive(view: GameView): boolean {
  return Boolean(activeMemory && activeMemory.luoyiTurn === view.turnCount);
}

/**
 * 一張主動牌對目標可能造成的「直接」傷害；null 表示打不中或本身不造成傷害。
 * 這只是傷害上限估計：真實在【閃】、【決鬥】角力後可能更低，但用來避免誤殺足夠。
 */
function directDamageEstimate(
  self: PlayerView,
  target: PlayerView,
  option: { asCard?: CardName; nature?: Nature; cards?: number[]; skill?: string },
  luoyi: boolean,
): number | null {
  const name = option.asCard;
  const ignoreArmor = self.equips.weapon?.name === 'qinggang';
  if (isSlashOption(option)) {
    if (!slashIsEffective(self, target, option)) return null;
    let damage = 1;
    // 藤甲遇火【殺】額外 +1（朱雀羽扇把普通【殺】轉成火【殺】時已是 fire_slash）。
    if (!ignoreArmor && option.asCard === 'fire_slash' && target.equips.armor?.name === 'vine_armor') {
      damage += 1;
    }
    if (self.wine) damage += 1;
    if (luoyi) damage += 1;
    // 古錠刀：目標沒有手牌時 +1。
    if (self.equips.weapon?.name === 'ancient_scimitar' && target.handCount === 0) damage += 1;
    if (!ignoreArmor && target.equips.armor?.name === 'silver_lion' && damage > 1) damage = 1;
    return damage;
  }
  if (name === 'duel') {
    if (target.skills.includes('kongcheng') && target.handCount === 0) return null;
    let damage = 1 + (luoyi ? 1 : 0);
    if (target.equips.armor?.name === 'silver_lion' && damage > 1) damage = 1;
    return damage;
  }
  if (name === 'fire_attack') {
    let damage = 1;
    if (target.equips.armor?.name === 'vine_armor') damage += 1;
    if (target.equips.armor?.name === 'silver_lion' && damage > 1) damage = 1;
    return damage;
  }
  if (name === 'barbarian' || name === 'arrows') {
    if (target.equips.armor?.name === 'vine_armor') return null;
    return 1;
  }
  return null;
}

/**
 * 這張主動牌可能直接、或因【鐵索連環】傳導而擊殺的角色清單。
 * 涵蓋單體傷害、群體錦囊、屬性傷害傳導、藤甲、白銀獅子、酒、裸衣、古錠刀、
 * 朱雀羽扇（轉火殺）與方天畫戟（多目標已列在 option.targets）。
 */
function lethalVictims(view: GameView, self: PlayerView, option: PlayOption): PlayerView[] {
  const victims: PlayerView[] = [];
  if (option.kind !== 'play') return victims;
  const luoyi = luoyiActive(view);
  const name = option.asCard;
  const nature: Nature =
    option.nature ?? (name === 'fire_attack' ? 'fire' : name ? slashNature(name) : 'normal');
  const canChain = (isSlashOption(option) || name === 'fire_attack') && nature !== 'normal';
  const ignoreArmor = self.equips.weapon?.name === 'qinggang';

  const add = (player: PlayerView): void => {
    if (!victims.includes(player)) victims.push(player);
  };

  for (const id of option.targets) {
    const target = view.players[id];
    if (!target || target.id === self.id || !target.alive) continue;
    const damage = directDamageEstimate(self, target, option, luoyi);
    if (damage === null || damage <= 0) continue;
    if (target.hp <= damage) add(target);
    if (!canChain || !target.chained) continue;
    // 鐵索連環：同一連鎖中的橫置角色會受到同樣的屬性傷害。
    for (const other of view.players) {
      if (other.id === target.id || !other.alive || !other.chained) continue;
      let otherDamage = damage;
      if (!ignoreArmor && nature === 'fire' && other.equips.armor?.name === 'vine_armor') otherDamage += 1;
      if (!ignoreArmor && other.equips.armor?.name === 'silver_lion' && otherDamage > 1) otherDamage = 1;
      if (other.hp <= otherDamage) add(other);
    }
  }
  return victims;
}

/** 這張主動牌是否可能令某名「非已確認敵人」死亡。 */
function hasUnconfirmedLethalVictim(view: GameView, self: PlayerView, option: PlayOption): boolean {
  return lethalVictims(view, self, option).some(
    (victim) => !isConfirmedEnemy(view, self, victim),
  );
}

/** 【酒】／【裸衣】加持下的【殺】：屬於高成本打擊，只准打已確認敵人。 */
function isBoostedSlash(view: GameView, self: PlayerView, option: PlayOption): boolean {
  return isSlashOption(option) && (self.wine || luoyiActive(view));
}

/** 目標是否全部都是公開資訊足以斷定的敵人。 */
function targetsAllConfirmed(
  view: GameView,
  self: PlayerView,
  option: { targets: PlayerId[] },
): boolean {
  if (option.targets.length === 0) return false;
  return option.targets.every((id) => {
    const player = view.players[id];
    return Boolean(player) && player!.id !== self.id && isConfirmedEnemy(view, self, player!);
  });
}

/** 回應請求（借刀、激將）時，判斷一個【殺】回應選項是否對目標有效。 */
function responseSlashEffective(
  self: PlayerView,
  target: PlayerView,
  option: { asCard?: CardName; nature?: Nature; cards: number[]; skill?: string },
): boolean {
  if (option.skill === 'serpent_spear') {
    return slashIsEffective(self, target, {
      asCard: 'slash',
      nature: 'normal',
      cards: [],
      skill: 'serpent_spear',
    });
  }
  const asCard = option.asCard;
  if (asCard !== 'slash' && asCard !== 'fire_slash' && asCard !== 'thunder_slash') return false;
  return slashIsEffective(self, target, {
    asCard,
    nature: option.nature ?? slashNature(asCard),
    cards: option.cards,
    skill: option.skill,
  });
}

function roleEnemyScore(view: GameView, self: PlayerView, target: PlayerView): number {
  if (target.id === self.id || !target.alive) return -1;
  let base: number;
  if (self.role === 'rebel') {
    if (target.role === 'lord') return 100;
    // 已能推斷是反賊隊友時，不攻擊（例如只剩自己、另一名反賊與主公）。
    if (deducedRebelAlly(self, view, target)) return -60;
    // 第一個反賊死亡後，自己就是唯一反賊，其他非主公必為忠臣／內奸；
    // 這是公開資訊可斷定的敵人，可以放心加壓，不會再誤傷隊友。
    const revealed = activeMemory?.knownRole;
    const deadRebels = revealed
      ? [...revealed.values()].filter((role) => role === 'rebel').length
      : 0;
    if (deadRebels >= 1) return 80;
    // 前期未知目標可能是另一名反賊；未知不當敵人，先保留手牌集中打主公。
    base = 0;
  } else if (self.role === 'loyal') {
    if (target.role === 'lord') return -100;
    base = 40;
  } else if (self.role === 'spy') {
    const alive = view.players.filter((player) => player.alive).length;
    // 只要還有其他人，殺主公等於讓反賊獲勝；先清除其他人，最後才單挑主公。
    if (target.role === 'lord') return alive <= 2 ? 120 : -40;
    base = 45;
  } else {
    // 主公：其他人都可能是反賊或內奸。
    base = target.role === 'loyal' ? -30 : 45;
  }
  return base + beliefTerm(view, self, target);
}

/**
 * 【突襲】是否值得發動：需要至少一名「手上有牌、且不是隊友」的目標。
 * 只看公開資訊（已知身份、手牌張數），不偷看手牌或隱藏身份。
 * 對忠臣／內奸而言主公是隊友，拿走主公的牌是幫倒忙。
 */
function hasTuxiTarget(view: GameView, self: PlayerView): boolean {
  return view.players.some(
    (player) =>
      player.alive &&
      player.id !== self.id &&
      player.handCount > 0 &&
      isConfirmedEnemy(view, self, player),
  );
}

/** 回應別人的請求時，判斷某個玩家是否為敵人。 */
function isEnemyOf(view: GameView, self: PlayerView, id: PlayerId | undefined): boolean {
  if (id === undefined) return false;
  const player = view.players[id];
  if (!player) return false;
  return player.id !== self.id && roleEnemyScore(view, self, player) > 0;
}

/**
 * 敵意行動可接受的目標：AI 眼中的偏友（行為上的隊友）不可攻擊。
 * `roleEnemyScore` 仍可能因為基礎值與機率項相抵而對偏友給出正分，
 * 因此這裡額外用 `relationOf` 擋掉。
 */
function isAttackable(view: GameView, self: PlayerView, target: PlayerView): boolean {
  if (target.id === self.id || !target.alive) return false;
  if (relationOf(view, self, target) === 'ally') return false;
  return roleEnemyScore(view, self, target) > 0;
}

/** 是否至少有一種方式能在【決鬥】中打出【殺】（含武聖、龍膽、丈八蛇矛）。 */
function canRespondSlash(self: PlayerView): boolean {
  const hand = self.hand ?? [];
  if (hand.some((card) => isSlashName(card.name))) return true;
  if (self.skills.includes('wusheng') && hand.some((card) => isRedCard(card))) return true;
  if (self.skills.includes('longdan') && hand.some((card) => card.name === 'dodge')) return true;
  if (self.equips.weapon?.name === 'serpent_spear' && hand.length >= 2) return true;
  return false;
}

/** 內奸：反賊是否明顯佔優（只用公開的剩餘人數與主公血量）。 */
function spyRebelsAhead(view: GameView, self: PlayerView): boolean {
  if (self.role !== 'spy') return false;
  const counts = remainingRoleCounts(view, self);
  const lord = view.players.find((player) => player.role === 'lord');
  if (!lord) return false;
  const lordSide = 1 + counts.loyal;
  const rebelSide = counts.rebel;
  return (
    rebelSide > lordSide ||
    (rebelSide >= lordSide && lord.hp <= 2) ||
    (rebelSide >= 1 && lord.hp <= 1)
  );
}

/** 內奸專用：目標在內奸自己眼中的忠誠機率（內奸的 relation 永遠是 unknown）。 */
function spyLoyalProbability(view: GameView, self: PlayerView, target: PlayerView): number {
  if (target.id === self.id || !target.alive || target.role !== null) return 0;
  if (!activeMemory) return 0;
  return beliefProbs(view, self, activeMemory, target).loyal;
}

function isStronglyLoyalTarget(view: GameView, self: PlayerView, target: PlayerView): boolean {
  return spyLoyalProbability(view, self, target) >= P_ALLY;
}

function isStronglyRebelTarget(view: GameView, self: PlayerView, target: PlayerView): boolean {
  if (target.id === self.id || !target.alive || target.role !== null) return false;
  if (!activeMemory) return false;
  return beliefProbs(view, self, activeMemory, target).rebel >= P_ALLY;
}

/** 內奸在反賊佔優時要保留子彈的高成本敵意行動（含技能與貫石斧）。 */
const SPY_GUARDED_SKILLS = new Set(['tuxi', 'rock_axe']);

function isSpyGuardedHostile(option: { asCard?: CardName; skill?: string }): boolean {
  if (isHighCostHostile(option)) return true;
  return option.skill !== undefined && SPY_GUARDED_SKILLS.has(option.skill);
}

/** 敵意行動的目標是否含有強烈偏忠者。 */
function optionHasStronglyLoyalTarget(
  view: GameView,
  self: PlayerView,
  option: { targets: PlayerId[] },
): boolean {
  return option.targets.some((id) => {
    const player = view.players[id];
    return Boolean(player) && isStronglyLoyalTarget(view, self, player!);
  });
}

/** 這一刀是否會把強烈偏忠的目標打進 1 血（含直接打死）。 */
function slashLeavesLoyalAtOneHp(view: GameView, self: PlayerView, option: PlayOption): boolean {
  for (const id of option.targets) {
    const player = view.players[id];
    if (!player || !isStronglyLoyalTarget(view, self, player)) continue;
    const damage = slashDamageWith(self, player, option, {
      wine: self.wine,
      luoyi: Boolean(activeMemory && activeMemory.luoyiTurn === view.turnCount),
    });
    if (player.hp - damage <= 1) return true;
  }
  return false;
}

/** 這張牌是否屬於內奸「反賊佔優時改打偏反目標」加分的敵意行動。 */
function isSpyHostilePlay(option: PlayOption): boolean {
  if (isSlashOption(option)) return true;
  if (isHighCostHostile(option)) return true;
  return option.skill !== undefined && SPY_GUARDED_SKILLS.has(option.skill);
}

/** 主公是否仍然很健康（供反賊的收頭例外與評分加分共用）。 */
function lordVeryHealthy(view: GameView): boolean {
  const lord = view.players.find((player) => player.role === 'lord');
  return Boolean(lord && lord.alive && lord.hp >= lord.maxHp - 1);
}

/**
 * 反賊的「王健康收頭」例外（見 DESIGN 7.3.17）：主公血量仍很健康時，
 * 反賊對 1 血隱藏目標的一張單體【殺】，即使還不能由證據斷定敵我，
 * 也放行一刀收頭。開局後場上最多剩「1 名其他反賊、1 名忠臣、1 名內奸」，
 * 收頭有 1/3 機率拆掉主公方戰力，換掉一次保守空過；已相信是行為隊友
 * （偏友或已確認反賊）仍然不可攻擊。回傳適用例外的目標；不成立回傳 null。
 */
function rebelLethalException(view: GameView, self: PlayerView, option: PlayOption): PlayerView | null {
  if (self.role !== 'rebel' || !isSlashOption(option)) return null;
  if (option.targets.length !== 1 || !lordVeryHealthy(view)) return null;
  const victim = view.players[option.targets[0]!];
  if (!victim || !victim.alive || victim.id === self.id || victim.role !== null) return null;
  if (relationOf(view, self, victim) === 'ally') return null;
  // 公開死亡已能斷定「必為反賊隊友」時（忠臣與內奸均已死亡）一樣不可攻擊。
  if (deducedRebelAlly(self, view, victim)) return null;
  const victims = lethalVictims(view, self, option);
  if (victims.length !== 1 || victims[0]!.id !== victim.id) return null;
  return victim;
}

function cardValue(name: CardName): number {
  switch (name) {
    case 'peach':
      return 100;
    case 'ex_nihilo':
      return 85;
    case 'dodge':
      return 70;
    case 'nullification':
      return 65;
    case 'wine':
      return 35;
    case 'dismantle':
    case 'snatch':
      return 55;
    case 'slash':
    case 'fire_slash':
    case 'thunder_slash':
      return 40;
    case 'duel':
    case 'fire_attack':
      return 58;
    case 'barbarian':
    case 'arrows':
      return 52;
    case 'peach_garden':
      return 62;
    case 'harvest':
      return 60;
    case 'collateral':
      return 50;
    case 'iron_chain':
      return 42;
    case 'indulgence':
    case 'supply_shortage':
      return 56;
    case 'lightning':
      return 20;
    default:
      return CARD_META[name].type === 'equip' ? 45 : 30;
  }
}

function jitter(rng: RngState, amount?: number): number {
  // 擾動較小，避免把機率訊號淹沒；新手（easy）仍維持最大擾動。
  const base = amount ?? (activeDifficulty === 'easy' ? 14 : activeDifficulty === 'hard' ? 1.5 : 3);
  return nextFloat(rng) * base;
}

function isSlashName(name: CardName): boolean {
  return name === 'slash' || name === 'fire_slash' || name === 'thunder_slash';
}

/** 放在判定區的延時錦囊：移掉會讓持有者變好，拆敵人時反而是幫對方。 */
const JUDGE_TIME_TRICKS = new Set<CardName>(['indulgence', 'supply_shortage', 'lightning']);

/**
 * 需要投入多張資源或高風險的單體敵意牌。這類牌在目標未確定是敵人時不用，
 * 避免把資源花在潛在隊友身上。
 */
const HIGH_COST_SINGLE = new Set<CardName>([
  'duel',
  'dismantle',
  'snatch',
  'fire_attack',
  'indulgence',
  'supply_shortage',
  'collateral',
]);

const HIGH_COST_SKILLS = new Set(['fanjian', 'lijian']);

function isHighCostHostile(option: { asCard?: CardName; skill?: string }): boolean {
  if (option.asCard && HIGH_COST_SINGLE.has(option.asCard)) return true;
  if (option.skill && HIGH_COST_SKILLS.has(option.skill)) return true;
  return false;
}

function isLordFirstTurn(view: GameView, self: PlayerView): boolean {
  return self.role === 'lord' && view.turnCount === 1;
}

/**
 * 這張牌／技能是否會直接傷害主公（不計算鐵索連環等後續傳導）。
 * 主公身份公開，因此忠臣與內奸都能由公開資訊判斷這樣做是否會傷到自己人
 * 或令反賊直接獲勝。
 */
function optionWouldDamageLord(view: GameView, option: PlayOption): boolean {
  const lord = view.players.find((player) => player.role === 'lord');
  if (!lord || !lord.alive) return false;
  const targetsLord = option.targets.includes(lord.id);
  if (targetsLord) {
    if (
      option.asCard === 'slash' ||
      option.asCard === 'fire_slash' ||
      option.asCard === 'thunder_slash' ||
      option.asCard === 'duel' ||
      option.asCard === 'fire_attack' ||
      option.asCard === 'barbarian' ||
      option.asCard === 'arrows'
    ) {
      return true;
    }
    if (option.skill === 'fanjian' || option.skill === 'lijian') return true;
  }
  return option.asCard === 'collateral' && option.targets[1] === lord.id;
}

/** 主公第一回合只准一張「普通」試探【殺】：單一目標、只用一張手牌。 */
function isPlainSlashOption(option: PlayOption): boolean {
  return isSlashOption(option) && option.cards.length === 1 && option.targets.length === 1;
}

function canLordProbe(view: GameView, self: PlayerView, option: PlayOption): boolean {
  if (!isLordFirstTurn(view, self)) return false;
  if (activeMemory?.probeUsed) return false;
  if (!isPlainSlashOption(option)) return false;
  const targetId = option.targets[0];
  if (targetId === undefined) return false;
  const target = view.players[targetId];
  if (!target || target.id === self.id) return false;
  if (!viewInAttackRange(view, self, target)) return false;
  if (isConfirmedEnemy(view, self, target)) return false;
  return slashIsEffective(self, target, option);
}

/** 固定 5 人標準局的剩餘各身份數。 */
function remainingRoleCounts(
  view: GameView,
  self: PlayerView,
  memory: AiMemory | undefined = activeMemory,
): Record<Role, number> {
  const counts: Record<Role, number> = { lord: 1, loyal: 1, rebel: 2, spy: 1 };
  for (const player of view.players) {
    const known =
      player.id === self.id
        ? self.role
        : player.role ?? memory?.knownRole.get(player.id) ?? null;
    if (known) counts[known] = Math.max(0, counts[known] - 1);
  }
  return counts;
}

/** 對未知目標估算「是隊友」的機率；已知身份直接用 0 或 1。 */
function unknownAllyProbability(view: GameView, self: PlayerView, target: PlayerView): number {
  const relation = relationOf(view, self, target);
  if (relation === 'ally') return 1;
  if (relation === 'enemy') return 0;
  if (!activeMemory) return 0;
  const pr = beliefProbs(view, self, activeMemory, target);
  if (self.role === 'lord') return pr.loyal;
  if (self.role === 'rebel') return pr.rebel;
  return 0;
}

/**
 * 群體錦囊的期望值：對敵人造成傷害為正，對潛在隊友造成傷害為負；
 * 若可能直接令忠臣死亡，給極大負值。藤甲對南蠻／萬箭免疫，直接跳過。
 */
function aoeScore(view: GameView, self: PlayerView, option: PlayOption): number {
  let ev = 0;
  let effective = 0;
  for (const id of option.targets) {
    const target = view.players[id];
    if (!target || target.id === self.id || !target.alive) continue;
    if (target.equips.armor?.name === 'vine_armor') continue;
    effective += 1;
    const lethal = target.hp <= 1;
    const ally = unknownAllyProbability(view, self, target);
    const enemy = 1 - ally;
    ev += enemy * (lethal ? 60 : 12) + ally * (lethal ? -400 : -20);
  }
  if (effective === 0) return -100;
  if (ev <= 0) return -80 + ev;
  return 42 + ev * 1.2;
}

function chooseAction(view: GameView, request: Request & { kind: 'action' }, rng: RngState): Response {
  const self = selfOf(view);
  const options = request.options;
  let best: { id: string; score: number } | null = null;

  // 每個回合重置主公第一回合的試探【殺】標記。
  if (activeMemory && activeMemory.probeTurn !== view.turnCount) {
    activeMemory.probeTurn = view.turnCount;
    activeMemory.probeUsed = false;
  }

  const slashOptions = options.filter(
    (option) => option.asCard === 'slash' || option.asCard === 'fire_slash' || option.asCard === 'thunder_slash',
  );
  const hasHealTarget = options.some(
    (option) => option.asCard === 'peach' && option.targets[0] !== self.id,
  );
  // 內奸：反賊明顯佔優時要避免幫反賊拆主公方的牆。
  const spySpareLoyal = self.role === 'spy' && spyRebelsAhead(view, self);

  for (const option of options) {
    let score = 0;
    const target = option.targets[0] === undefined ? null : view.players[option.targets[0]] ?? null;
    // 反賊的「王健康收頭」例外（見上）；同時用於 L1 閘放行與加分。
    const rebelLethal = option.kind === 'play' ? rebelLethalException(view, self, option) : null;

    if (option.kind === 'play') {
      // 忠臣不會傷害主公；內奸在還有其他人時傷害主公會直接讓反賊獲勝。
      if (optionWouldDamageLord(view, option)) {
        const alive = view.players.filter((player) => player.alive).length;
        if (self.role === 'loyal') continue;
        if (self.role === 'spy' && alive > 2) continue;
      }
      // L1 致命閘：任何主動牌只要可能令「非已確認敵人」死亡（含鐵索連環傳導、
      // 群體錦囊、藤甲／白銀獅子、酒、裸衣、古錠刀等）就放棄，避免為收頭誤殺隊友。
      // 反賊的「王健康收頭」例外不在此限（見 rebelLethalException）。
      if (hasUnconfirmedLethalVictim(view, self, option) && !rebelLethal) continue;
      // L2 高成本閘（所有身份）：需要投入多張資源或高風險的敵意牌，
      // 只打公開資訊足以斷定的敵人，不在未知目標身上浪費。
      if (isHighCostHostile(option) && !targetsAllConfirmed(view, self, option)) continue;
      // 酒／裸衣加持的【殺】同屬高成本打擊，只打已確認敵人。
      if (isBoostedSlash(view, self, option) && !targetsAllConfirmed(view, self, option)) continue;
      // 決鬥自殺閘：自己 1 血且無法打出【殺】時，對手只要有一張【殺】就會送命。
      if (option.asCard === 'duel' && self.hp <= 1 && !canRespondSlash(self)) continue;
      // 內奸的偏忠保留：反賊佔優時不用高成本牌拆偏忠目標，
      // 也不把偏忠目標打進 1 血（含直接打死）。
      if (spySpareLoyal) {
        if (isSpyGuardedHostile(option) && optionHasStronglyLoyalTarget(view, self, option)) continue;
        if (isSlashOption(option) && slashLeavesLoyalAtOneHp(view, self, option)) continue;
      }
      // 主公第一回合：普通【殺】最多一張試探；其他敵意牌只打 confirmed。
      if (
        isLordFirstTurn(view, self) &&
        isSlashOption(option) &&
        !targetsAllConfirmed(view, self, option) &&
        !canLordProbe(view, self, option)
      ) {
        continue;
      }
    }

    switch (option.kind) {
      case 'pass': {
        // 有明確敵人時，空過有一點成本；只有未知或隊友時，保留手牌較好。
        const hasEnemy = view.players.some(
          (player) =>
            player.alive &&
            player.id !== self.id &&
            isConfirmedEnemy(view, self, player),
        );
        const hasUnknown = view.players.some(
          (player) =>
            player.alive &&
            player.id !== self.id &&
            relationOf(view, self, player) === 'unknown',
        );
        score = hasEnemy ? -4 : hasUnknown ? 2 : 6;
        if (self.handCount <= self.hp) score += 3;
        break;
      }
      case 'play':
        break;
      default:
        score = -10;
        break;
    }

    if (option.asCard) {
      const name = option.asCard;
      score += cardValue(name) * 0.2;

      if (name === 'ex_nihilo') score += 80;
      if (name === 'wine') {
        // 【酒】只加在「所有目標都是已確認敵人、而且加傷真的有效」的【殺】上，
        // 避免加在未知目標身上誤傷潛在隊友。酒必須排在【殺】前面。
        const canFollow = slashOptions.some((slashOption) => {
          const targets = slashOption.targets
            .map((id) => view.players[id])
            .filter((player): player is PlayerView => Boolean(player));
          if (targets.length === 0) return false;
          if (!targetsAllConfirmed(view, self, slashOption)) return false;
          return targets.some(
            (player) =>
              player.id !== self.id &&
              viewInAttackRange(view, self, player) &&
              slashBonusMatters(self, player, slashOption, { wine: true, luoyi: false }),
          );
        });
        score += canFollow ? 120 : -35;
      }
      if (name === 'peach') {
        if (option.targets[0] === self.id) {
          const missing = self.maxHp - self.hp;
          score += missing > 0 ? 60 + missing * 15 : -50;
        } else if (self.role === 'loyal' && target?.role === 'lord') {
          score += 40;
        } else if (self.role === 'lord' && target?.role === 'loyal') {
          score += 20;
        } else {
          score -= 25;
        }
      }
      if (name === 'dismantle' || name === 'snatch') {
        if (target) {
          const base = roleEnemyScore(view, self, target);
          const attackable = isAttackable(view, self, target);
          score += attackable ? 35 + base * 0.3 : -160;
          if (target.equips.armor?.name === 'vine_armor' || target.equips.armor?.name === 'eight_diagram') {
            score += 10;
          }
          if (target.equips.weapon) score += 8;
          // 敵人只剩判定區的延時錦囊可拆時，拆掉是幫對方解除負面效果，放棄。
          const hasEquip = Boolean(
            target.equips.weapon ||
              target.equips.armor ||
              target.equips.horsePlus ||
              target.equips.horseMinus,
          );
          const onlyJudgeTrick =
            attackable &&
            !hasEquip &&
            target.handCount === 0 &&
            target.judgeZone.some((card) => JUDGE_TIME_TRICKS.has(card.name));
          if (onlyJudgeTrick) score -= 120;
        }
      }
      if (name === 'duel') {
        if (target) {
          const enemy = roleEnemyScore(view, self, target);
          const shaCount = self.hand?.filter((card) => isSlashName(card.name)).length ?? 0;
          if (!isAttackable(view, self, target)) {
            score -= 160;
          } else {
            let value = 45 + enemy * 0.3 + shaCount * 6;
            // 沒有【殺】（含轉化）時，對手只要有一張【殺】就會贏；血量越低越不該賭。
            if (!canRespondSlash(self)) value -= self.hp <= 2 ? 55 : 35;
            score += value;
          }
        }
      }
      if (name === 'barbarian' || name === 'arrows') {
        // 群體錦囊用期望值：對敵人有利、對潛在隊友有害；可能令忠臣死亡時不應使用。
        score += aoeScore(view, self, option);
      }
      if (name === 'peach_garden') {
        let allyHeal = 0;
        let enemyHeal = 0;
        let unknownHeal = 0;
        for (const id of option.targets) {
          const player = view.players[id];
          if (!player || player.hp >= player.maxHp) continue;
          const relation = relationOf(view, self, player);
          if (relation === 'enemy') {
            enemyHeal += 1;
            continue;
          }
          if (relation === 'ally') {
            // 內奸不把主公治療到中低血量之上。
            if (
              self.role === 'spy' &&
              player.role === 'lord' &&
              player.hp >= Math.max(2, Math.ceil(player.maxHp / 2))
            ) {
              continue;
            }
            allyHeal += 1;
            continue;
          }
          unknownHeal += 1;
        }
        // 沒有治療到任何隊友（全滿、只治療敵人／未知）就不要用。
        if (allyHeal === 0) score -= 80;
        else score += 30 + allyHeal * 18 - enemyHeal * 18 - unknownHeal * 6;
      }
      if (name === 'harvest') score += 55;
      if (name === 'collateral') {
        const user = view.players[option.targets[0]!];
        const victim = view.players[option.targets[1]!];
        if (user && victim) {
          const a = isAttackable(view, self, user);
          const b = isAttackable(view, self, victim);
          // 讓敵人打敵人最好；逼敵人打自己／隊友、或讓隊友挨刀都是幫倒忙。
          if (a && b) score += 55;
          else if (a) score -= 160;
          else if (b) score += 30;
          else score -= 160;
        }
      }
      if (name === 'fire_attack') {
        if (target) {
          const enemy = roleEnemyScore(view, self, target);
          score += isAttackable(view, self, target) ? 45 + enemy * 0.25 : -160;
          if (target.handCount > 0) score += 8;
        }
      }
      if (name === 'indulgence') {
        if (target) score += isAttackable(view, self, target) ? 55 : -160;
      }
      if (name === 'supply_shortage') {
        if (target) score += isAttackable(view, self, target) ? 50 : -160;
      }
      if (name === 'lightning') {
        // 閃電是風險牌，血量低時不要放。
        score += self.hp >= 3 ? 12 : -35;
      }
      if (name === 'iron_chain') {
        if (option.skill === 'recast') score += self.handCount <= 2 ? 25 : 8;
        else {
          // 連結敵人是好事（之後屬性傷害會傳導），連結自己或隊友則有害。
          for (const id of option.targets) {
            const player = view.players[id];
            if (!player) continue;
            if (isAttackable(view, self, player)) score += player.chained ? -6 : 16;
            else score -= 160;
          }
        }
      }
      if (isSlashOption(option)) {
        // 方天畫戟等可指定多個目標：逐一檢查，打到隊友或無效目標要重罰。
        let hostileTargets = 0;
        let friendlyTargets = 0;
        let invalidTarget = false;
        for (const id of option.targets) {
          const player = view.players[id];
          if (!player) continue;
          const enemy = roleEnemyScore(view, self, player);
          const relation = relationOf(view, self, player);
          // 反賊前期唔用貴牌打未知，但【殺】是低成本試探：未知目標仍可試刀，
          // 只是價值較低，避免完全不行動令對局拖死。
          const unknownProbe = self.role === 'rebel' && relation === 'unknown';
          // 偏友（行為上的隊友）一律不打，即使分數項仍然是正的。
          if (player.id === self.id || relation === 'ally' || (enemy <= 0 && !unknownProbe)) {
            friendlyTargets += 1;
            continue;
          }
          if (!slashIsEffective(self, player, option)) {
            invalidTarget = true;
            break;
          }
          hostileTargets += 1;
          const damage = slashDamageWith(self, player, option, {
            wine: self.wine,
            luoyi: Boolean(activeMemory && activeMemory.luoyiTurn === view.turnCount),
          });
          score += unknownProbe ? 30 : 40 + enemy * 0.25;
          if (player.hp <= damage) {
            score += 70;
            // 反賊王健康收頭：對隱藏目標的一擊致命額外加分，壓過「打健康主公」
            // 或群體錦囊的一般分數，符合收頭優先的原則。
            if (rebelLethal && rebelLethal.id === player.id) score += 35;
          }
          if (player.handCount === 0) score += 12;
          if (player.equips.armor?.name === 'vine_armor' && name === 'fire_slash') score += 25;
          // 高手：對手已公開打出多張【閃】，推測其手上【閃】變少。
          if (activeDifficulty === 'hard') {
            score += (activeMemory?.playedDodge.get(player.id) ?? 0) * 3;
          }
        }
        // 公開資訊已可判定無效，或打不到任何敵人：不要浪費這張【殺】。
        if (invalidTarget || hostileTargets === 0) score -= 300;
        score -= friendlyTargets * 300;
        // 酒已用時，下一個【殺】只打已確認敵人，避免酒被未知目標搶走。
        if (self.wine) score += targetsAllConfirmed(view, self, option) ? 60 : -400;
        // 有實體【殺】時優先使用，不要把兩張手牌浪費在丈八蛇矛上。
        if (option.skill === 'serpent_spear' && (self.hand ?? []).some((card) => isSlashName(card.name))) {
          score -= 45;
        }
      }
      if (CARD_META[name].type === 'equip') {
        const card =
          option.cards.length > 0
            ? (self.hand ?? []).find((item) => item.id === option.cards[0]) ?? null
            : null;
        score += card ? equipPlan(view, self, card) : 8;
      }
    }

    // 主動技能的評分；新手難度傾向不使用技能。
    if (option.kind === 'play' && option.skill && activeDifficulty !== 'easy') {
      const firstId = option.targets[0];
      const first = firstId === undefined ? null : view.players[firstId] ?? null;
      const firstEnemy = first ? roleEnemyScore(view, self, first) : 0;
      if (option.skill === 'rende') {
        score += first ? rendePlan(view, self, first).score : -50;
      } else if (option.skill === 'zhiheng') {
        const low = lowValueHandCount(self);
        score += self.handCount >= 3 && low > 0 ? 28 : -20;
      } else if (option.skill === 'qingnang') {
        if (first && first.hp < first.maxHp && relationOf(view, self, first) === 'ally') {
          const capped =
            self.role === 'spy' &&
            first.role === 'lord' &&
            first.hp >= Math.max(2, Math.ceil(first.maxHp / 2));
          score += capped ? -30 : 40;
        } else {
          score -= 30;
        }
      } else if (option.skill === 'lijian') {
        const secondId = option.targets[1];
        const second = secondId === undefined ? null : view.players[secondId] ?? null;
        // 離間會令兩人互相決鬥；只可指定兩名已確認敵人，避免隊友受傷。
        score += first && second && isConfirmedEnemy(view, self, first) && isConfirmedEnemy(view, self, second)
          ? 35
          : -20;
      } else if (option.skill === 'fanjian') {
        if (!(first && isConfirmedEnemy(view, self, first))) {
          score -= 30;
        } else {
          // 【反間】展示的牌（隨機手牌）結算後必歸目標，以手牌平均價值估計成本；
          // 目標血少時 1 點傷害更有價值（DESIGN 7.3.13 F2）。
          const hand = self.hand ?? [];
          const avgHandValue =
            hand.length > 0 ? hand.reduce((sum, card) => sum + cardValue(card.name), 0) / hand.length : 0;
          score += 45 + (first.hp <= 2 ? 25 : 0) - avgHandValue;
        }
      } else if (option.skill === 'jieyin') {
        // 結姻會同時回復自己與目標；幫敵人回體力是嚴重錯誤。
        if (firstEnemy > 0 && first && first.id !== self.id) {
          score -= 50;
        } else {
          let value = self.hp < self.maxHp ? 25 : 0;
          if (first && first.id !== self.id && first.hp < first.maxHp) value += 30;
          // 代價：棄兩張手牌。
          value -= self.handCount <= 2 ? 22 : 6;
          score += value > 0 ? value : -18;
        }
      }
    }

    // 【苦肉】可以重複使用，因此獨立於難度之外把關：這招是拿體力換手牌，
    // 用過頭會把自己送到 1 點體力（甚至被一擊帶走），所以只在用後仍安全、
    // 而且真的缺牌時才發動。新手難度也一樣，只是價值低一點（較少主動使用）。
    if (option.kind === 'play' && option.skill === 'kurou') {
      const safeHp = self.hp - 1 >= 3;
      const needsCards = self.handCount <= 3;
      score += safeHp && needsCards ? (activeDifficulty === 'easy' ? 12 : 22) : -60;
    }

    if (hasHealTarget && option.asCard === 'peach' && option.targets[0] !== self.id) {
      score -= 15;
    }

    // 內奸在反賊佔優時改打偏反目標，避免只是消極保留手牌。
    if (spySpareLoyal && option.kind === 'play' && isSpyHostilePlay(option)) {
      const targets = option.targets
        .map((id) => view.players[id])
        .filter((player): player is PlayerView => Boolean(player));
      if (targets.length > 0 && targets.every((player) => isStronglyRebelTarget(view, self, player))) {
        score += 12;
      }
    }

    score += jitter(rng);
    if (!best || score > best.score) best = { id: option.id, score };
  }

  if (best && best.score > 0) {
    const chosen = options.find((option) => option.id === best!.id);
    if (chosen && canLordProbe(view, self, chosen) && activeMemory) {
      activeMemory.probeUsed = true;
    }
  }

  if (!best || best.score <= 0) {
    const pass = options.find((option) => option.kind === 'pass');
    if (pass) return { type: 'option', optionId: pass.id };
  }
  return { type: 'option', optionId: best!.id };
}

const MAX_RENDE_CARDS_PER_TURN = 4;
const LOW_VALUE_CARD = 55;

function lowValueHandCount(self: PlayerView): number {
  return (self.hand ?? []).filter((card) => cardValue(card.name) < LOW_VALUE_CARD).length;
}

function hasLowValueGiveCard(self: PlayerView): boolean {
  return (self.hand ?? []).some(
    (card) => card.name !== 'peach' && card.name !== 'peach_garden' && cardValue(card.name) < LOW_VALUE_CARD,
  );
}

function rendeBudget(view: GameView): number {
  if (!activeMemory) return 0;
  if (activeMemory.rendeTurn !== view.turnCount) return MAX_RENDE_CARDS_PER_TURN;
  return Math.max(0, MAX_RENDE_CARDS_PER_TURN - activeMemory.rendeGiven);
}

function viewSeatDistance(view: GameView, from: PlayerId, to: PlayerId): number {
  if (from === to) return 0;
  const alive = view.players.filter((player) => player.alive).sort((a, b) => a.seat - b.seat);
  const fromIndex = alive.findIndex((player) => player.id === from);
  const toIndex = alive.findIndex((player) => player.id === to);
  if (fromIndex < 0 || toIndex < 0) return Number.POSITIVE_INFINITY;
  const n = alive.length;
  const clockwise = (toIndex - fromIndex + n) % n;
  const counter = (fromIndex - toIndex + n) % n;
  return Math.min(clockwise, counter);
}

function viewDistance(view: GameView, self: PlayerView, target: PlayerView): number {
  let value = viewSeatDistance(view, self.id, target.id);
  if (!Number.isFinite(value)) return value;
  if (target.equips.horsePlus) value += 1;
  if (self.equips.horseMinus) value -= 1;
  if (self.skills.includes('mashu')) value -= 1;
  return Math.max(1, value);
}

function viewAttackRange(self: PlayerView): number {
  const weapon = self.equips.weapon;
  if (!weapon) return 1;
  return (CARD_META[weapon.name] as { range?: number }).range ?? 1;
}

function viewInAttackRange(view: GameView, self: PlayerView, target: PlayerView): boolean {
  if (!self.alive || !target.alive || self.id === target.id) return false;
  return viewDistance(view, self, target) <= viewAttackRange(self);
}

function viewSlashLimitReached(self: PlayerView): boolean {
  if (self.equips.weapon?.name === 'crossbow') return false;
  if (self.skills.includes('paoxiao')) return false;
  return self.slashUsed >= 1;
}

/** 破【空城】後，本回合是否還有【殺】／【決鬥】能立即跟上。 */
function canPunishAfterGift(view: GameView, self: PlayerView, target: PlayerView): boolean {
  const hand = self.hand ?? [];
  const slashCount = hand.filter((card) => isSlashName(card.name)).length;
  if (slashCount > 0 && !viewSlashLimitReached(self) && viewInAttackRange(view, self, target)) {
    return true;
  }
  const hasDuel = hand.some((card) => card.name === 'duel');
  return hasDuel && slashCount > 0;
}

interface RendePlan {
  score: number;
  count: number;
}

/** 仁德不輕易送出的關鍵牌；低血急需回血時才可能動用。 */
const RENDE_PROTECTED = new Set<CardName>([
  'peach',
  'peach_garden',
  'nullification',
  'dodge',
  'ex_nihilo',
]);

/** 本回合已用仁德給出幾張（給滿 2 張即已回血）。 */
function rendeGivenThisTurn(view: GameView): number {
  if (!activeMemory || activeMemory.rendeTurn !== view.turnCount) return 0;
  return activeMemory.rendeGiven;
}

/** 低血且尚未回血時，允許動用保護牌湊到 2 張。 */
function rendeEmergency(self: PlayerView, given: number): boolean {
  return self.hp < self.maxHp && given < 2 && self.hp <= 2;
}

/** 可給出的牌，依價值由低到高排序；保護牌在一般情況排在最後。 */
function rendeGiveable(self: PlayerView, given: number): Card[] {
  const hand = self.hand ?? [];
  const emergency = rendeEmergency(self, given);
  return [...hand]
    .filter((card) => emergency || !RENDE_PROTECTED.has(card.name))
    .sort((a, b) => cardValue(a.name) - cardValue(b.name));
}

/**
 * 【仁德】是否值得：隊友給牌、敵人空城破防、內奸控制主公血量。
 * 同時考慮牌價值與「這回合給出的第 2 張可回血」：2 張手牌且受傷時，
 * 低血允許把手牌給到 0 以換取 1 點體力。
 * 只使用公開資訊；未知目標預設不給。
 */
function rendePlan(view: GameView, self: PlayerView, target: PlayerView): RendePlan {
  if (!target.alive || target.id === self.id) return { score: -50, count: 0 };
  const budget = rendeBudget(view);
  const given = rendeGivenThisTurn(view);
  const maxGive = self.hp <= 2 ? self.handCount : Math.max(0, self.handCount - 1);
  const giveable = rendeGiveable(self, given);
  if (budget <= 0 || maxGive <= 0 || giveable.length === 0) return { score: -50, count: 0 };

  const hasKongcheng = target.skills.includes('kongcheng') && target.handCount === 0;
  const relation = relationOf(view, self, target);

  if (self.role === 'spy') {
    if (target.role !== 'lord') return { score: -35, count: 0 };
    const alive = view.players.filter((player) => player.alive).length;
    if (alive <= 2) {
      // 最後單挑：若主公靠【空城】擋殺，才給 1 張破防並準備攻擊。
      if (hasKongcheng && canPunishAfterGift(view, self, target)) return { score: 55, count: 1 };
      return { score: -35, count: 0 };
    }
    if (hasKongcheng) return { score: -35, count: 0 }; // 保留主公的空城
    const bandMax = Math.max(2, Math.ceil(target.maxHp / 2));
    if (target.hp <= bandMax && target.handCount <= 1 && hasLowValueGiveCard(self)) {
      return { score: 35, count: 1 };
    }
    return { score: -35, count: 0 };
  }

  if (relation === 'ally') {
    // 隊友的【空城】是防禦，不要主動給牌破壞。
    if (hasKongcheng) return { score: -45, count: 0 };
    // 一般隊友給 2 張；已給 1 張且只差 1 張回血時，不必多給。
    const healPending = self.hp < self.maxHp && given < 2;
    const desired = healPending && given === 1 && target.handCount > 1 ? 1 : 2;
    const count = Math.min(desired, budget, maxGive, giveable.length);
    if (count <= 0) return { score: -50, count: 0 };
    const cards = giveable.slice(0, count);
    const reachesHeal = healPending && given + count >= 2;
    const giftValue = cards.reduce((sum, card) => sum + cardValue(card.name), 0);
    let score = 30;
    if (reachesHeal) score += self.hp <= 2 ? 48 : 26;
    if (target.handCount <= 1) score += 8;
    if (self.role === 'loyal' && target.role === 'lord') score += 8;
    score -= giftValue * 0.12;
    if (count === self.handCount) score -= reachesHeal ? 4 : 14;
    return { score, count };
  }

  if (relation === 'enemy') {
    if (!hasKongcheng) return { score: -45, count: 0 };
    if (!canPunishAfterGift(view, self, target)) return { score: -55, count: 0 };
    if (!hasLowValueGiveCard(self)) return { score: -55, count: 0 };
    return { score: 50, count: 1 };
  }

  return { score: -40, count: 0 };
}

type EquipSlot = 'weapon' | 'armor' | 'horsePlus' | 'horseMinus';

function equipSlotOf(card: Card): EquipSlot | null {
  const meta = CARD_META[card.name];
  if (meta.type !== 'equip' || !meta.subtype) return null;
  switch (meta.subtype) {
    case 'weapon':
      return 'weapon';
    case 'armor':
      return 'armor';
    case 'horse_plus':
      return 'horsePlus';
    case 'horse_minus':
      return 'horseMinus';
    default:
      return null;
  }
}

/** 單張裝備的靜態價值；武器已把射程與常見效果一併計入。 */
function equipBaseValue(self: PlayerView, card: Card): number {
  const slashCount = (self.hand ?? []).filter((item) => isSlashName(item.name)).length;
  switch (card.name) {
    case 'crossbow':
      return 10 + Math.min(12, slashCount * 5);
    case 'double_sword':
      return 14;
    case 'qinggang':
    case 'ice_sword':
      return 16;
    case 'ancient_scimitar':
      return 13;
    case 'serpent_spear':
      return 15 + (self.handCount <= 2 ? 4 : 0);
    case 'green_dragon':
      return 18;
    case 'rock_axe':
      return 15 + (self.handCount >= 3 ? 4 : 0);
    case 'fan':
      return 19;
    case 'halberd':
      return 17;
    case 'qilin_bow':
      return 21;
    case 'eight_diagram':
      return 26;
    case 'renwang':
      return 22;
    case 'vine_armor':
    case 'silver_lion':
      return 20;
    case 'jueying':
    case 'zhuahuang':
    case 'dilu':
    case 'hualiu':
      return 18;
    case 'chitu':
    case 'dawan':
    case 'zixing':
      return 16;
    default:
      return 10;
  }
}

/** 這件武器在本回合是否能強化已經能打的【殺】。 */
function weaponSameTurnBonus(self: PlayerView, card: Card, hostiles: PlayerView[]): number {
  const slashCount = (self.hand ?? []).filter((item) => isSlashName(item.name)).length;
  switch (card.name) {
    case 'crossbow':
      return slashCount >= 2 ? 35 : 0;
    case 'qinggang':
      return hostiles.some((player) => player.equips.armor !== null) ? 35 : 0;
    case 'ice_sword':
      return 32;
    case 'green_dragon':
      return 36;
    case 'double_sword':
      return 26;
    case 'ancient_scimitar':
      return hostiles.some((player) => player.handCount === 0) ? 36 : 0;
    case 'rock_axe':
      return self.handCount >= 3 ? 28 : 0;
    case 'fan':
      return hostiles.some((player) => player.equips.armor?.name === 'vine_armor') ? 40 : 8;
    case 'halberd':
      return self.handCount <= 2 && hostiles.length >= 2 ? 38 : 0;
    case 'qilin_bow':
      return hostiles.some((player) => player.equips.horsePlus !== null || player.equips.horseMinus !== null)
        ? 38
        : 0;
    default:
      return 0;
  }
}

/**
 * 裝備的實際行動價值：
 * - 已經有同類裝備時，只換「明顯更好」的，不用較差或相同的裝備蓋掉。
 * - 新武器／(-1) 馬若能解鎖本回合打不到的目標，才大幅提前；
 *   若只是強化已能打到的【殺】，給較小的加分。
 * - 沒有【殺】可接時，裝備回歸一般價值，不再搶在攻擊之前。
 */
function equipPlan(view: GameView, self: PlayerView, card: Card): number {
  const slot = equipSlotOf(card);
  if (!slot) return 0;
  const value = equipBaseValue(self, card);
  const current = self.equips[slot];
  let score = value;
  if (current) {
    const oldValue = equipBaseValue(self, current);
    if (value <= oldValue + 2) return -20;
    // 換裝會失去原本的裝備，仍要付出一點機會成本。
    score = value - oldValue - 4;
  }

  const hand = self.hand ?? [];
  const canSlash = hand.some((item) => isSlashName(item.name)) && !viewSlashLimitReached(self);
  if (!canSlash) return score;

  const hostiles = view.players.filter(
    (player) => player.alive && player.id !== self.id && relationOf(view, self, player) !== 'ally',
  );
  if (hostiles.length === 0) return score;

  if (slot === 'weapon') {
    const currentRange = viewAttackRange(self);
    const nextRange = (CARD_META[card.name] as { range?: number }).range ?? 1;
    if (nextRange > currentRange) {
      const unlocks = hostiles.some((player) => {
        const dist = viewDistance(view, self, player);
        return dist > currentRange && dist <= nextRange;
      });
      if (unlocks) return score + 70;
    }
    return score + weaponSameTurnBonus(self, card, hostiles);
  }

  if (slot === 'horseMinus' && current === null) {
    const range = viewAttackRange(self);
    const unlocks = hostiles.some((player) => {
      const dist = viewDistance(view, self, player);
      return dist > range && dist - 1 <= range;
    });
    if (unlocks) return score + 65;
  }

  return score;
}

/** 用自己手牌／技能建立可能的【殺】候選，供【裸衣】判斷本回合是否打得出有效傷害。 */
function handSlashCandidates(self: PlayerView): PlayOption[] {
  const options: PlayOption[] = [];
  const hand = self.hand ?? [];
  for (const card of hand) {
    if (!isSlashName(card.name)) continue;
    options.push({
      id: `cand:${card.id}`,
      label: '',
      kind: 'play',
      cards: [card.id],
      targets: [],
      asCard: card.name,
      nature: slashNature(card.name),
    });
  }
  if (self.skills.includes('wusheng')) {
    for (const card of hand) {
      if (isSlashName(card.name) || !isRedCard(card)) continue;
      options.push({
        id: `cand:wusheng:${card.id}`,
        label: '',
        kind: 'play',
        cards: [card.id],
        targets: [],
        asCard: 'slash',
        nature: 'normal',
        skill: 'wusheng',
      });
    }
  }
  if (self.skills.includes('longdan')) {
    for (const card of hand) {
      if (card.name !== 'dodge') continue;
      options.push({
        id: `cand:longdan:${card.id}`,
        label: '',
        kind: 'play',
        cards: [card.id],
        targets: [],
        asCard: 'slash',
        nature: 'normal',
        skill: 'longdan',
      });
    }
  }
  if (self.equips.weapon?.name === 'serpent_spear' && hand.length >= 2) {
    options.push({
      id: 'cand:spear',
      label: '',
      kind: 'play',
      cards: [],
      targets: [],
      asCard: 'slash',
      nature: 'normal',
      skill: 'serpent_spear',
    });
  }
  return options;
}

/**
 * 【裸衣】只對已確認敵人發動，而且加傷要真的有效（不是打不中、不是白銀獅子封頂、
 * 不是本來就會被基礎傷害帶走）。有【決鬥】＋【殺】時也可因決鬥增傷而發動。
 */
function luoyiHasValue(view: GameView, self: PlayerView): boolean {
  const enemies = view.players.filter(
    (player) => player.alive && player.id !== self.id && isConfirmedEnemy(view, self, player),
  );
  if (enemies.length === 0) return false;
  const candidates = handSlashCandidates(self);
  if (candidates.length === 0) return false;

  for (const enemy of enemies) {
    if (!viewInAttackRange(view, self, enemy)) continue;
    for (const candidate of candidates) {
      if (slashBonusMatters(self, enemy, candidate, { wine: false, luoyi: true })) return true;
    }
  }

  const hasDuel = (self.hand ?? []).some((card) => card.name === 'duel');
  if (!hasDuel) return false;
  const ignoreArmor = self.equips.weapon?.name === 'qinggang';
  return enemies.some(
    (enemy) =>
      !(enemy.skills.includes('kongcheng') && enemy.handCount === 0) &&
      (ignoreArmor || enemy.equips.armor?.name !== 'silver_lion'),
  );
}

/** 【貫石斧】可棄的牌數：手牌＋裝備，排除貫石斧本身。 */
function rockAxeDiscardableCount(self: PlayerView): number {
  const handCount = self.hand?.length ?? self.handCount;
  const usable = [self.equips.weapon, self.equips.armor, self.equips.horsePlus, self.equips.horseMinus].filter(
    (card): card is Card => card !== null && card.name !== 'rock_axe',
  ).length;
  return handCount + usable;
}

/**
 * 【反間】猜花色：只依自己的手牌推測未見牌的分佈。
 * 自己手上越少的花色，越可能出現在周瑜的未知手牌裡；同分用隨機決定，
 * 避免每次固定猜同一個花色。
 */
function chooseFanjianSuit(
  self: PlayerView,
  options: { id: string; skill?: string }[],
  rng: RngState,
): { id: string; skill?: string } | null {
  const counts = new Map<string, number>([
    ['spade', 0],
    ['heart', 0],
    ['club', 0],
    ['diamond', 0],
  ]);
  for (const card of self.hand ?? []) {
    counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1);
  }
  const scored = options.map((option) => {
    const suit = String(option.skill ?? '').replace('suit_', '');
    return { option, count: counts.get(suit) ?? 0, jitter: nextFloat(rng) };
  });
  scored.sort((a, b) => a.count - b.count || a.jitter - b.jitter);
  return scored[0]?.option ?? null;
}

function chooseResponse(
  view: GameView,
  request: Request & { kind: 'response' },
  rng: RngState,
): Response {
  const self = selfOf(view);
  const options = request.options.filter((option) => option.kind !== 'pass');
  const pass = request.options.find((option) => option.kind === 'pass');
  if (options.length === 0) {
    return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
  }

  if (request.need === 'shan') {
    // 護駕：別人的【閃】由你代打。幫敵人擋刀是幫倒忙，直接拒絕。
    if (isEnemyOf(view, self, request.source)) {
      return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
    }
    // 八卦陣是免費判定，先試。
    const bagua = options.find((option) => option.skill === 'bagua');
    if (bagua) return { type: 'option', optionId: bagua.id };
    const dodge = options.find((option) => option.asCard === 'dodge');
    if (dodge) return { type: 'option', optionId: dodge.id };
  }

  if (request.need === 'peach') {
    const dyingId = findDyingId(view);
    const dying = dyingId === null ? null : view.players[dyingId] ?? null;
    const savesLord = self.role === 'loyal' && dying?.role === 'lord';
    const savesAlly = self.role === 'lord' && dying?.role === 'loyal';
    // 反賊救公開可辨認的隊友；未知目標不救，避免用【桃】救錯人。
    const savesRebel =
      self.role === 'rebel' &&
      dying !== null &&
      dying.id !== self.id &&
      relationOf(view, self, dying) === 'ally';
    if (dyingId === self.id || savesLord || savesAlly || savesRebel) {
      const heal = options.find((option) => option.asCard === 'peach' || option.asCard === 'wine');
      if (heal) return { type: 'option', optionId: heal.id };
    }
    // 內奸要避免反賊因主公死亡而獲勝；但如果只剩自己與主公，
    // 主公死亡反而讓內奸成為唯一存活者而勝利，所以只在還有其他人時救。
    if (self.role === 'spy' && dying?.role === 'lord') {
      const alive = view.players.filter((player) => player.alive).length;
      if (alive > 2) {
        const heal = options.find((option) => option.asCard === 'peach');
        if (heal) return { type: 'option', optionId: heal.id };
      }
    }
  }

  if (request.need === 'sha') {
    // 激將：蜀勢力角色代主公打出【殺】。若借用者對自己不利，拒絕。
    if (isEnemyOf(view, self, request.source)) {
      return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
    }
    // 【借刀殺人】等情況會指定受害者：只打已確認敵人，且沒有有效【殺】時
    // 寧可放棄（把武器交出去），也不要把【殺】打在潛在隊友或無效的防具上。
    const victimId = request.targets?.[0];
    if (victimId !== undefined) {
      const victim = view.players[victimId] ?? null;
      if (victim === null || victimId === self.id || !isConfirmedEnemy(view, self, victim)) {
        return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
      }
      // 內奸：反賊佔優時，被【借刀殺人】等逼著打偏忠目標也拒絕。
      if (self.role === 'spy' && spyRebelsAhead(view, self) && isStronglyLoyalTarget(view, self, victim)) {
        return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
      }
      const effective = options.filter((option) => responseSlashEffective(self, victim, option));
      const slash =
        effective.find(
          (option) =>
            option.asCard === 'slash' ||
            option.asCard === 'fire_slash' ||
            option.asCard === 'thunder_slash',
        ) ?? effective.find((option) => option.skill === 'serpent_spear');
      if (slash) return { type: 'option', optionId: slash.id };
      return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
    }
    const slash =
      options.find(
        (option) =>
          option.asCard === 'slash' ||
          option.asCard === 'fire_slash' ||
          option.asCard === 'thunder_slash',
      ) ?? options.find((option) => option.skill === 'serpent_spear');
    if (slash) return { type: 'option', optionId: slash.id };
  }

  if (request.need === 'wuxie') {
    const wuxie = options.find((option) => option.asCard === 'nullification');
    if (wuxie) {
      const harmful = request.cardName ? HARMFUL_TRICKS.has(request.cardName) : false;
      const beneficial = request.cardName ? BENEFICIAL_TRICKS.has(request.cardName) : false;
      const targets = request.targets ?? [];
      const currentlyNullified = (request.nullificationCount ?? 0) % 2 === 1;

      // 自己剛使用的牌不主動取消；只有被對手無懈可擊後才考慮反制。
      if (request.source === self.id && !currentlyNullified) return { type: 'pass' };

      const gains = (player: PlayerView): boolean => {
        if (request.cardName === 'peach_garden') return player.hp < player.maxHp;
        return true;
      };
      const affectsSelf = targets.includes(self.id) && gains(self);
      const affectsAlly = targets.some((id) => {
        const player = view.players[id];
        return Boolean(player) && player.id !== self.id && relationOf(view, self, player) === 'ally' && gains(player);
      });
      const affectsEnemy = targets.some((id) => {
        const player = view.players[id];
        return Boolean(player) && player.id !== self.id && roleEnemyScore(view, self, player) > 0;
      });

      // 想要的結果：有害牌希望被抵消，有益牌希望生效。
      let wantNullified: boolean;
      if (beneficial) wantNullified = !(affectsSelf || affectsAlly) && affectsEnemy;
      else if (harmful) wantNullified = affectsSelf || affectsAlly;
      else wantNullified = affectsEnemy; // 未知牌種採保守判斷
      if (beneficial || harmful) {
        if (wantNullified === currentlyNullified) return { type: 'pass' };
        // 不為了讓敵人多吃一次有害效果而反制別人的【無懈可擊】（連鎖 2）；
        // 自己的牌被無懈時仍可反制（DESIGN 7.3.13 F1）。
        if (harmful && !wantNullified && request.source !== self.id) return { type: 'pass' };
      }

      const chance = affectsSelf ? 0.9 : affectsAlly ? 0.5 : affectsEnemy ? 0.4 : 0.05;
      if (nextFloat(rng) < chance) return { type: 'option', optionId: wuxie.id };
      return { type: 'pass' };
    }
  }

  if (request.need === 'choice') {
    const skills = options.filter((option) => option.kind === 'skill');
    // 剛烈：棄 2 張手牌或受 1 點傷害。手牌多或再受 1 點就會瀕死時棄牌，
    // 否則寧可吃傷害也要保住手牌。
    if (request.context === '剛烈') {
      const discard = skills.find((option) => option.skill === 'discard');
      const damage = skills.find((option) => option.skill === 'damage');
      const preferDiscard = self.hp <= 1 || self.handCount >= 3;
      const pick = preferDiscard ? discard ?? damage : damage ?? discard;
      if (pick) return { type: 'option', optionId: pick.id };
    }
    const discard = skills.find((option) => option.skill === 'discard');
    const draw = skills.find((option) => option.skill === 'draw');
    if (discard || draw) {
      // 雌雄雙股劍：手牌少就讓對方摸，手牌多就棄一張。
      return { type: 'option', optionId: (self.handCount <= 2 && draw ? draw : discard ?? draw)!.id };
    }
    // 反間猜花色：依未見牌分佈挑最可能的花色。
    const suitOptions = skills.filter(
      (option) => typeof option.skill === 'string' && option.skill.startsWith('suit_'),
    );
    if (suitOptions.length > 0) {
      const best = chooseFanjianSuit(self, suitOptions, rng);
      if (best) return { type: 'option', optionId: best.id };
    }
    const skill = skills[0];
    if (skill) {
      const id = skill.skill;
      if (id === 'ice_sword') {
        const targetId = skill.targets?.[0] ?? request.targets?.[0];
        const target = targetId === undefined ? null : view.players[targetId] ?? null;
        // 只對已確認敵人動用；對未知或可能的隊友，拆牌不如保留傷害。
        if (!target || !target.alive || !isConfirmedEnemy(view, self, target)) {
          return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
        }
        // 這刀足以致命：直接造成傷害收頭，不為了棄牌而防止傷害。
        if (target.hp <= (request.damage ?? 1)) {
          return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
        }
        // 目標只剩一張未知手牌時，棄 1 張不如造成傷害；公開裝備仍值得拆。
        const equipCount = [
          target.equips.weapon,
          target.equips.armor,
          target.equips.horsePlus,
          target.equips.horseMinus,
        ].filter(Boolean).length;
        if (target.handCount + equipCount <= 1 && equipCount === 0) {
          return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
        }
        return { type: 'option', optionId: skill.id };
      }
      // 鬼才、流離預設不發動；裸衣沒有【殺】時也不發動。
      if (id === 'guicai' || id === 'liuli') {
        return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
      }
      // 突襲會拿走別人的手牌：沒有敵人可拿時（例如只剩主公）改為正常摸兩張。
      if (id === 'tuxi' && !hasTuxiTarget(view, self)) {
        return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
      }
      if (id === 'luoyi') {
        if (!luoyiHasValue(view, self)) {
          return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
        }
        if (activeMemory) activeMemory.luoyiTurn = view.turnCount;
        return { type: 'option', optionId: skill.id };
      }
      if (id === 'rock_axe') {
        const axeTargetId = skill.targets?.[0];
        const axeTarget = axeTargetId === undefined ? null : view.players[axeTargetId] ?? null;
        // 官方版：被【閃】抵消後才觸發；只對已確認敵人動用，且要湊得出兩張可棄的牌。
        if (
          !axeTarget ||
          !axeTarget.alive ||
          !isConfirmedEnemy(view, self, axeTarget) ||
          rockAxeDiscardableCount(self) < 2
        ) {
          return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
        }
      }
      return { type: 'option', optionId: skill.id };
    }
  }

  if (request.need === 'card') {
    const first = options[0];
    if (first) return { type: 'option', optionId: first.id };
  }

  // 未知需求時，保留手牌。
  if (pass) return { type: 'option', optionId: pass.id };
  return { type: 'option', optionId: options[0]!.id };
}

/** 直接指向單一目標的敵意行為（可能指向主公）。 */
const HOSTILE_DIRECTED = new Set<CardName>([
  'slash',
  'fire_slash',
  'thunder_slash',
  'duel',
  'dismantle',
  'snatch',
  'fire_attack',
  'indulgence',
  'supply_shortage',
]);

/** 會掃到全場（含主公）的敵意牌：證據力較弱。 */
const HOSTILE_GROUP = new Set<CardName>(['barbarian', 'arrows']);

const HARMFUL_TRICKS = new Set<CardName>([
  'dismantle',
  'snatch',
  'duel',
  'collateral',
  'barbarian',
  'arrows',
  'fire_attack',
  'indulgence',
  'supply_shortage',
  'lightning',
]);

const BENEFICIAL_TRICKS = new Set<CardName>([
  'ex_nihilo',
  'peach_garden',
  'harvest',
]);

function findDyingId(view: GameView): PlayerId | null {
  const pending = view.pending;
  if (!pending || pending.kind !== 'response' || pending.need !== 'peach') return null;
  // 請求本身沒有 dying 欄位；由 prompt/context 無法可靠解析，改用所有 0 血存活者。
  const dying = view.players.filter((player) => player.alive && player.hp <= 0);
  if (dying.length === 0) return null;
  return dying[0]!.id;
}

function chooseCards(
  request: Request & { kind: 'chooseCards' },
  view: GameView,
  rng: RngState,
): Response {
  const self = selfOf(view);
  const hand = self.hand ?? [];
  const values = new Map<number, number>();
  const nameById = new Map<number, CardName>();
  for (const card of hand) {
    values.set(card.id, cardValue(card.name) + jitter(rng, 3));
    nameById.set(card.id, card.name);
  }
  const sorted = [...request.cards].sort((a, b) => (values.get(a) ?? 0) - (values.get(b) ?? 0));
  const maxAvailable = Math.min(request.max, sorted.length);
  const min = Math.max(0, Math.min(request.min, maxAvailable));
  if (maxAvailable <= 0) return { type: 'cards', cards: [] };

  if (request.skill === 'rende') {
    const target = request.target === undefined ? null : view.players[request.target] ?? null;
    const budget = rendeBudget(view);
    const given = rendeGivenThisTurn(view);
    const maxGive = self.hp <= 2 ? self.handCount : Math.max(0, self.handCount - 1);
    const healNeeded = self.hp < self.maxHp && given < 2 ? 2 - given : 0;
    const desiredCount =
      target && healNeeded === 1 && target.handCount > 1 ? 1 : target ? 2 : 1;
    // 保護牌（桃、無懈、閃等）不主動送出；低血急需回血時才解除限制。
    const emergency = rendeEmergency(self, given);
    const giveableCount = emergency
      ? maxAvailable
      : request.cards.filter((id) => {
          const card = hand.find((item) => item.id === id);
          return card !== undefined && !RENDE_PROTECTED.has(card.name);
        }).length;
    const cap = Math.max(min, giveableCount);
    let desired = Math.min(desiredCount, 2, budget, maxGive, maxAvailable, cap);
    if (target) {
      const hasKongcheng = target.skills.includes('kongcheng') && target.handCount === 0;
      if ((self.role === 'spy' && target.role === 'lord') || hasKongcheng) {
        desired = Math.min(1, maxAvailable);
      }
    }
    const count = Math.max(min, Math.min(maxAvailable, desired));
    const rendeSorted = [...request.cards].sort((a, b) => {
      const cardA = hand.find((item) => item.id === a);
      const cardB = hand.find((item) => item.id === b);
      const protA = !emergency && cardA && RENDE_PROTECTED.has(cardA.name) ? 1 : 0;
      const protB = !emergency && cardB && RENDE_PROTECTED.has(cardB.name) ? 1 : 0;
      return protA - protB || (values.get(a) ?? 0) - (values.get(b) ?? 0);
    });
    if (activeMemory) {
      if (activeMemory.rendeTurn !== view.turnCount) {
        activeMemory.rendeTurn = view.turnCount;
        activeMemory.rendeGiven = 0;
      }
      activeMemory.rendeGiven += count;
    }
    return { type: 'cards', cards: rendeSorted.slice(0, count) };
  }

  if (request.skill === 'zhiheng') {
    const low = sorted.filter((id) => {
      const name = nameById.get(id);
      return name !== undefined && cardValue(name) < LOW_VALUE_CARD;
    });
    const desired = Math.min(3, Math.max(1, low.length), maxAvailable);
    const count = Math.max(min, Math.min(maxAvailable, desired));
    return { type: 'cards', cards: sorted.slice(0, count) };
  }

  // 丈八蛇矛：對手有仁王盾時，盡量把紅色牌排在前面（第一張決定顏色）。
  if (request.reason === '丈八蛇矛' && request.target !== undefined) {
    const target = view.players[request.target] ?? null;
    const ignoreArmor = self.equips.weapon?.name === 'qinggang';
    if (target && !ignoreArmor && target.equips.armor?.name === 'renwang') {
      const isRedId = (id: number): boolean => {
        const card = hand.find((item) => item.id === id);
        return card !== undefined && isRedCard(card);
      };
      const reds = sorted.filter(isRedId);
      const blacks = sorted.filter((id) => !isRedId(id));
      const picked = [...reds, ...blacks].slice(0, Math.min(2, maxAvailable));
      return { type: 'cards', cards: picked };
    }
  }

  const count = Math.max(min, Math.min(maxAvailable, request.max));
  return { type: 'cards', cards: sorted.slice(0, count) };
}

function chooseCard(
  request: Request & { kind: 'chooseCard' },
  view: GameView,
  rng: RngState,
): Response {
  const self = selfOf(view);
  const target = view.players[request.target];
  if (!target) return { type: 'card', card: -1 };

  const visible: Card[] = [];
  for (const slot of ['weapon', 'armor', 'horsePlus', 'horseMinus'] as const) {
    const card = target.equips[slot];
    if (card) visible.push(card);
  }
  visible.push(...target.judgeZone);

  const enemy = roleEnemyScore(view, self, target);
  const preferred = visible
    .filter((card) => request.cards.includes(card.id))
    .map((card) => ({ card, score: removalScore(card, enemy, target) }))
    .sort((a, b) => b.score - a.score);

  if (preferred.length > 0) {
    const best = preferred[0]!;
    // 拆敵人判定區的延時錦囊等於幫對方；寧可盲選手牌。
    if (best.score <= 0 && request.allowRandomHand) return { type: 'card', card: -1 };
    const positive = preferred.filter((item) => item.score > 0);
    const pool = positive.length > 0 ? positive : preferred;
    const pick = pool.find(() => nextFloat(rng) < 0.85) ?? pool[0]!;
    return { type: 'card', card: pick.card.id };
  }
  if (request.allowRandomHand) return { type: 'card', card: -1 };

  const fallback = request.cards[0];
  return { type: 'card', card: fallback ?? -1 };
}

/** 拆／拿目標區域內一張牌的價值；負分代表做了反而幫到對方。 */
function removalScore(card: Card, enemy: number, target: PlayerView): number {
  const meta = CARD_META[card.name];
  if (meta.type === 'equip') {
    // 拆敵人的裝備是好事，拆隊友的裝備是壞事。
    let score = equipPriority(card) + (enemy > 0 ? 4 : -6);
    // 白銀獅子被拆掉時持有者會回復 1 點；對方已受傷時，拆它反而治療敵人。
    if (card.name === 'silver_lion' && enemy > 0 && target.hp < target.maxHp) score -= 30;
    return score;
  }
  if (JUDGE_TIME_TRICKS.has(card.name)) {
    // 判定區的延時錦囊移掉會讓持有者變好。
    return enemy > 0 ? -8 : 6;
  }
  return 1;
}

function equipPriority(card: Card): number {
  switch (card.name) {
    case 'vine_armor':
    case 'eight_diagram':
    case 'renwang':
    case 'silver_lion':
      return 5;
    case 'crossbow':
    case 'ancient_scimitar':
    case 'fan':
      return 4;
    case 'jueying':
    case 'zhuahuang':
    case 'dilu':
    case 'hualiu':
      return 3;
    case 'chitu':
    case 'dawan':
    case 'zixing':
      return 3;
    default:
      return 2;
  }
}

/**
 * 觀星：先處理自己的判定（避免【閃電】自殺、【樂不思蜀】／【兵糧寸斷】
 * 被跳過），再依牌價值把好牌留在牌堆頂。
 * 判定階段就在準備階段之後，且判定區由最後放入者先判定。
 */
function guanxingResponse(view: GameView, request: Request & { kind: 'orderCards' }): Response {
  const self = selfOf(view);
  const pool = [...request.cards];
  const top: Card[] = [];
  const bottom: Card[] = [];
  const judgments = [...self.judgeZone].reverse().map((card) => card.name);

  for (const name of judgments) {
    if (name === 'lightning' || name === 'indulgence' || name === 'supply_shortage') {
      const picked = pickJudgmentCard(pool, name);
      if (!picked) {
        // 沒有適合的牌：把剩下的全部放堆底，讓判定抽未知牌
        // （例如【閃電】時整疊都是黑桃 2–9，硬抽必定 3 點傷害）。
        bottom.push(...pool);
        pool.length = 0;
        break;
      }
      top.push(picked);
      pool.splice(pool.indexOf(picked), 1);
      continue;
    }
    // 不確定的判定類型：用最低價值的牌應付，保留好牌。
    const cheapest = [...pool].sort((a, b) => cardValue(a.name) - cardValue(b.name))[0];
    if (cheapest) {
      top.push(cheapest);
      pool.splice(pool.indexOf(cheapest), 1);
    }
  }

  // 剩下的牌：高價值留在牌堆頂（自己先摸），低價值不需要特別移到底。
  pool.sort((a, b) => cardValue(b.name) - cardValue(a.name));
  top.push(...pool);

  const response: Response = { type: 'cards', cards: top.map((card) => card.id) };
  if (bottom.length > 0) response.bottom = bottom.map((card) => card.id);
  return response;
}

/** 哪張牌最適合當這次判定的判定牌；沒有適合的就回傳 null（賭未知牌）。 */
function pickJudgmentCard(pool: readonly Card[], name: CardName): Card | null {
  const safe = pool.filter((card) => {
    if (name === 'lightning') {
      // 黑桃 2–9 會觸發 3 點雷電傷害。
      return !(card.suit === 'spade' && card.rank >= 2 && card.rank <= 9);
    }
    if (name === 'indulgence') return card.suit === 'heart';
    if (name === 'supply_shortage') return card.suit === 'club';
    return true;
  });
  if (safe.length === 0) return null;
  // 用價值最低的牌去判定，把好牌留給摸牌。
  return safe.sort((a, b) => cardValue(a.name) - cardValue(b.name))[0]!;
}

export function decide(
  view: GameView,
  request: Request,
  rng: RngState,
  memory: AiMemory = createAiMemory(),
  difficulty: Difficulty = 'normal',
): Response {
  // `decide` 同步且不可重入；設定本次決策的記憶與難度。
  activeMemory = memory;
  activeDifficulty = difficulty;
  updateMemory(view, memory);

  switch (request.kind) {
    case 'action':
      return chooseAction(view, request, rng);
    case 'response':
      return chooseResponse(view, request, rng);
    case 'chooseCards':
      return chooseCards(request, view, rng);
    case 'chooseCard':
      return chooseCard(request, view, rng);
    case 'choosePlayers': {
      // 遺計是給牌：優先把牌交給自己或隊友（手牌少的優先），不會主動送給敵人。
      if (request.reason === '遺計') {
        const self = selfOf(view);
        const rank: Record<Relation, number> = { ally: 0, unknown: 1, enemy: 2 };
        const picked = [...new Set(request.candidates)]
          .flatMap((id) => {
            const player = view.players[id];
            if (!player) return [];
            return [{ id, relation: relationOf(view, self, player), handCount: player.handCount }];
          })
          .sort((a, b) => rank[a.relation] - rank[b.relation] || a.handCount - b.handCount);
        const count = Math.max(request.min, Math.min(request.max, picked.length));
        return { type: 'players', players: picked.slice(0, count).map((item) => item.id) };
      }
      // 需要指定目標的技能（突襲、流離）只用公開資訊挑人：
      // 先排敵人（仇恨高的優先、手牌多的優先），隊友排最後，
      // 且人數以「值得的目標數」為上限，避免把效果指向隊友。
      const self = selfOf(view);
      const relationRank: Record<Relation, number> = { enemy: 0, unknown: 1, ally: 2 };
      const scored = [...new Set(request.candidates)].flatMap((id) => {
        const player = view.players[id];
        if (!player) return [];
        return [
          {
            id,
            enemy: roleEnemyScore(view, self, player),
            relation: relationOf(view, self, player),
            handCount: player.handCount,
            confirmed: isConfirmedEnemy(view, self, player),
          },
        ];
      });
      const enemies = scored
        .filter((item) => item.confirmed)
        .sort((a, b) => b.enemy - a.enemy || b.handCount - a.handCount);
      const rest = scored
        .filter((item) => !item.confirmed)
        .sort(
          (a, b) =>
            relationRank[a.relation] - relationRank[b.relation] || b.handCount - a.handCount,
        );
      const ranked = [...enemies, ...rest];
      const max = Math.min(request.max, ranked.length);
      const min = Math.max(0, Math.min(request.min, max));
      const count = Math.max(min, Math.min(max, enemies.length));
      return { type: 'players', players: ranked.slice(0, count).map((item) => item.id) };
    }
    case 'chooseRevealed': {
      const best = [...request.cards].sort((a, b) => cardValue(b.name) - cardValue(a.name))[0];
      return best ? { type: 'card', card: best.id } : { type: 'pass' };
    }
    case 'chooseFrom': {
      // 貫石斧：從手牌＋裝備中挑價值最低的牌支付。
      if (request.reason === '貫石斧') {
        const ranked = [...request.cards].sort((a, b) => cardValue(a.name) - cardValue(b.name));
        return { type: 'cards', cards: ranked.slice(0, request.min).map((card) => card.id) };
      }
      // 其他 chooseFrom：保留原順序。
      return { type: 'cards', cards: request.cards.slice(0, request.min).map((card) => card.id) };
    }
    case 'orderCards': {
      return guanxingResponse(view, request);
    }
    default:
      return { type: 'pass' };
  }
}

/** 供 UI／除錯顯示：回傳簡單的一行決策說明。 */
export function describeResponse(response: Response): string {
  switch (response.type) {
    case 'option':
      return `選項 ${response.optionId}`;
    case 'cards':
      return `選 ${response.cards.length} 張牌`;
    case 'players':
      return `選 ${response.players.length} 名角色`;
    case 'card':
      return response.card === -1 ? '隨機手牌' : `牌 ${response.card}`;
    default:
      return '不出';
  }
}
