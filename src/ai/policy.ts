import type {
  Card,
  CardName,
  Difficulty,
  GameView,
  PlayerId,
  PlayerView,
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

/**
 * AI 的跨回合記憶：只由公開事件（`GameView.events`）更新。
 * 不保存任何手牌、牌堆順序或未公開身份。
 */
export interface AiMemory {
  lastEventSeq: number;
  /** 由公開事件推得的「疑似反賊」分數（越高越像反賊）。 */
  rebelScore: Map<PlayerId, number>;
  /** 死亡時已公開的身份。 */
  knownRole: Map<PlayerId, Role>;
  /** 公開打出過的【閃】／【桃】次數（高手難度的手牌推測）。 */
  playedDodge: Map<PlayerId, number>;
  playedPeach: Map<PlayerId, number>;
  /** 同一回合內自己的【仁德】已給出張數，避免一次把手牌給光。 */
  rendeTurn: number;
  rendeGiven: number;
  /** 公開的【仁德】事件對各來源的信念影響總量（每回合上限）。 */
  giveTurn: number;
  giveDelta: Map<PlayerId, number>;
}

export function createAiMemory(): AiMemory {
  return {
    lastEventSeq: 0,
    rebelScore: new Map(),
    knownRole: new Map(),
    playedDodge: new Map(),
    playedPeach: new Map(),
    rendeTurn: -1,
    rendeGiven: 0,
    giveTurn: -1,
    giveDelta: new Map(),
  };
}

function bump(
  map: Map<number, number>,
  id: number,
  delta: number,
  min = -20,
  max = 20,
): void {
  const next = Math.max(min, Math.min(max, (map.get(id) ?? 0) + delta));
  map.set(id, next);
}

function applyEvent(view: GameView, memory: AiMemory, event: PublicEvent): void {
  const lordId = view.players.find((player) => player.role === 'lord')?.id ?? null;

  if (event.kind === 'death' && event.target !== null && event.role) {
    memory.knownRole.set(event.target, event.role);
    memory.rebelScore.set(
      event.target,
      event.role === 'rebel' ? 20 : event.role === 'spy' ? 8 : -20,
    );
    // 死亡時公開的身份，也能反推兇手的陣營：殺了忠臣／主公＝反賊，
    // 殺了反賊＝不是反賊（這是真正的新資訊，不像「主公打誰」只是雜訊）。
    if (event.source !== null && event.source !== event.target && event.source !== lordId) {
      if (event.role === 'loyal' || event.role === 'lord') {
        bump(memory.rebelScore, event.source, 5);
      } else if (event.role === 'rebel') {
        bump(memory.rebelScore, event.source, -3);
      }
    }
    return;
  }

  if (event.kind === 'damage' && event.source !== null && event.target !== null) {
    // 傷害主公＝敵意證據。目標一定是活人（身份未公開），所以不必考慮「已知身份」。
    if (event.target === lordId) bump(memory.rebelScore, event.source, 4);
    // 被主公打不算證據：主公沒有任何其他人拿不到的資訊（也用同一套公開事件推理），
    // 開局更是見誰打誰，把他的目標當嫌疑只是雜訊。
    return;
  }

  if (event.kind === 'give' && event.source !== null && event.target !== null) {
    const selfId = view.pending?.player ?? null;
    // 自己的給牌不拿來更新自己的信念，避免自我強化。
    if (event.source === selfId) return;
    // 主公的給牌可能是戰術或誤判，和「主公打誰」一樣不當陣營證據。
    if (event.source === lordId) return;

    if (memory.giveTurn !== view.turnCount) {
      memory.giveTurn = view.turnCount;
      memory.giveDelta = new Map();
    }

    const target = view.players[event.target] ?? null;
    const targetScore = memory.rebelScore.get(event.target) ?? 0;
    const known = target?.role ?? memory.knownRole.get(event.target) ?? null;
    const targetLooksRebel = known === 'rebel' || (known === null && targetScore >= TEAMMATE_EVIDENCE);
    const targetLooksLord = event.target === lordId;
    let delta = 0;
    if (event.brokeKongcheng) {
      // 破壞空城是敵意行為，方向與一般送牌相反。
      if (targetLooksLord) delta = 2;
      else if (targetLooksRebel) delta = -1;
    } else if (targetLooksLord) {
      delta = -2;
    } else if (targetLooksRebel) {
      delta = 2;
    }

    if (delta !== 0) {
      const used = memory.giveDelta.get(event.source) ?? 0;
      const remaining = Math.max(0, 4 - Math.abs(used));
      const applied = Math.sign(delta) * Math.min(Math.abs(delta), remaining);
      if (applied !== 0) {
        bump(memory.rebelScore, event.source, applied);
        memory.giveDelta.set(event.source, used + applied);
      }
    }
    return;
  }

  if (event.kind === 'use' && event.cardName && event.source !== null) {
    if (event.cardName === 'dodge') bump(memory.playedDodge, event.source, 1, 0, 20);
    if (event.cardName === 'peach') bump(memory.playedPeach, event.source, 1, 0, 20);
    if (event.target === lordId) {
      // 直接朝主公出【殺】、拆牌、決鬥等，即使被【閃】掉也是明確的敵意行為。
      if (HOSTILE_DIRECTED.has(event.cardName)) bump(memory.rebelScore, event.source, 4);
      // 南蠻入侵／萬箭齊發會掃到全場，證據力弱得多。
      else if (HOSTILE_GROUP.has(event.cardName)) bump(memory.rebelScore, event.source, 1);
      else if (BENEFICIAL_TRICKS.has(event.cardName)) bump(memory.rebelScore, event.source, -1);
    }
    return;
  }

  if (event.kind === 'save' && event.target === lordId && event.source !== null) {
    bump(memory.rebelScore, event.source, -4);
  }
}

/** 用公開事件更新 AI 記憶（增量，只處理新事件）。 */
export function updateMemory(view: GameView, memory: AiMemory): void {
  for (const event of view.events) {
    if (event.seq <= memory.lastEventSeq) continue;
    memory.lastEventSeq = event.seq;
    applyEvent(view, memory, event);
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

/**
 * 公開行為已明顯偏向某個陣營的分數門檻。
 * 分數本身是加減累積（見 `applyEvent`），達到門檻就不再只是「稍微調整敵意」，
 * 而是直接改判敵我：反賊不需要攻擊明顯的同夥，主公／忠臣也沒必要打救過自己的人。
 */
const TEAMMATE_EVIDENCE = 6;
const ALLY_EVIDENCE = -6;

/** 由身份信念對敵意分數做調整；新手難度完全忽略。 */
function beliefAdjust(self: PlayerView, target: PlayerView): number {
  if (activeDifficulty === 'easy' || !activeMemory) return 0;
  const score = activeMemory.rebelScore.get(target.id) ?? 0;
  if (score === 0) return 0;
  const weight = activeDifficulty === 'hard' ? 0.6 : 0.4;
  if (self.role === 'rebel') {
    // 反賊只要主公死；公開行為明顯像反賊的人就當隊友，不再攻擊（可能是另一名反賊）。
    if (score >= TEAMMATE_EVIDENCE) return -80;
    return -score * weight;
  }
  if (self.role === 'spy') return score * weight * 0.5;
  // 忠臣／主公：明顯救援過主公的人視為隊友，不再攻擊。
  if (score <= ALLY_EVIDENCE) return -80;
  return score * weight;
}

/** 由公開身份與行為信念得到的敵我三態；未知不當隊友，也不當確定的敵人。 */
export type Relation = 'ally' | 'enemy' | 'unknown';

function isRoleEnemy(selfRole: Role, otherRole: Role): boolean {
  if (selfRole === 'rebel') return otherRole === 'lord' || otherRole === 'loyal' || otherRole === 'spy';
  if (selfRole === 'loyal' || selfRole === 'lord') return otherRole === 'rebel' || otherRole === 'spy';
  // 內奸沒有同伴；除了「主公在後期是敵人」以外，其餘都先當敵人。
  return otherRole !== 'spy';
}

function relationOf(view: GameView, self: PlayerView, target: PlayerView): Relation {
  if (self.role === null) return 'unknown';
  if (target.id === self.id) return 'ally';
  if (!target.alive) return 'unknown';
  const known = target.role ?? activeMemory?.knownRole.get(target.id) ?? null;
  if (known !== null) {
    if (self.role === 'spy' && known === 'lord') {
      const alive = view.players.filter((player) => player.alive).length;
      return alive <= 2 ? 'enemy' : 'ally';
    }
    return isRoleEnemy(self.role, known) ? 'enemy' : 'ally';
  }
  const score = activeMemory?.rebelScore.get(target.id) ?? 0;
  if (self.role === 'spy') return 'unknown';
  if (score >= TEAMMATE_EVIDENCE) return self.role === 'rebel' ? 'ally' : 'enemy';
  if (score <= ALLY_EVIDENCE) return self.role === 'rebel' ? 'enemy' : 'ally';
  return 'unknown';
}

function roleEnemyScore(view: GameView, self: PlayerView, target: PlayerView): number {
  if (target.id === self.id || !target.alive) return -1;
  let base: number;
  if (self.role === 'rebel') {
    if (target.role === 'lord') return 100;
    // 已能推斷是反賊隊友時，不攻擊（例如只剩自己、另一名反賊與主公）。
    if (deducedRebelAlly(self, view, target)) return -60;
    base = 15;
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
  return base + beliefAdjust(self, target);
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
      roleEnemyScore(view, self, player) > 0,
  );
}

/** 回應別人的請求時，判斷某個玩家是否為敵人。 */
function isEnemyOf(view: GameView, self: PlayerView, id: PlayerId | undefined): boolean {
  if (id === undefined) return false;
  const player = view.players[id];
  if (!player) return false;
  return player.id !== self.id && roleEnemyScore(view, self, player) > 0;
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
  const base = amount ?? (activeDifficulty === 'easy' ? 14 : activeDifficulty === 'hard' ? 3 : 6);
  return nextFloat(rng) * base;
}

function isSlashName(name: CardName): boolean {
  return name === 'slash' || name === 'fire_slash' || name === 'thunder_slash';
}

/** 放在判定區的延時錦囊：移掉會讓持有者變好，拆敵人時反而是幫對方。 */
const JUDGE_TIME_TRICKS = new Set<CardName>(['indulgence', 'supply_shortage', 'lightning']);

function chooseAction(view: GameView, request: Request & { kind: 'action' }, rng: RngState): Response {
  const self = selfOf(view);
  const options = request.options;
  let best: { id: string; score: number } | null = null;

  const slashOptions = options.filter(
    (option) => option.asCard === 'slash' || option.asCard === 'fire_slash' || option.asCard === 'thunder_slash',
  );
  const hasHealTarget = options.some(
    (option) => option.asCard === 'peach' && option.targets[0] !== self.id,
  );

  for (const option of options) {
    let score = 0;
    const target = option.targets[0] === undefined ? null : view.players[option.targets[0]] ?? null;

    switch (option.kind) {
      case 'pass': {
        // 有明確敵人時，空過有一點成本；只有未知或隊友時，保留手牌較好。
        const hasEnemy = view.players.some(
          (player) =>
            player.alive &&
            player.id !== self.id &&
            relationOf(view, self, player) === 'enemy',
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
        // 【酒】只有在本回合真的能接上【殺】時才用；而且要排在【殺】前面，
        // 否則【殺】先打出去之後，酒就完全沒有價值了。
        const canFollow = slashOptions.some((option) =>
          option.targets.some((id) => {
            const player = view.players[id];
            return Boolean(player) && relationOf(view, self, player) !== 'ally';
          }),
        );
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
          score += base > 0 ? 35 + base * 0.3 : -160;
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
            base > 0 &&
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
          score += enemy > 0 ? 45 + enemy * 0.3 + shaCount * 6 : -160;
        }
      }
      if (name === 'barbarian' || name === 'arrows') {
        const allies = option.targets.filter(
          (id) => id !== self.id && relationOf(view, self, view.players[id]!) === 'ally',
        );
        score += 42 + option.targets.length * 5 - allies.length * 160;
      }
      if (name === 'peach_garden') {
        const net = option.targets.reduce((sum, id) => {
          const player = view.players[id];
          if (!player || player.hp >= player.maxHp) return sum;
          const relation = relationOf(view, self, player);
          if (relation === 'enemy') return sum - 18;
          if (relation === 'ally') {
            // 內奸不把主公治療到中低血量之上。
            if (
              self.role === 'spy' &&
              player.role === 'lord' &&
              player.hp >= Math.max(2, Math.ceil(player.maxHp / 2))
            ) {
              return sum;
            }
            return sum + 18;
          }
          return sum;
        }, 0);
        score += 30 + net;
      }
      if (name === 'harvest') score += 55;
      if (name === 'collateral') {
        const user = view.players[option.targets[0]!];
        const victim = view.players[option.targets[1]!];
        if (user && victim) {
          const a = roleEnemyScore(view, self, user);
          const b = roleEnemyScore(view, self, victim);
          // 讓敵人打敵人最好；逼敵人打自己／隊友、或讓隊友挨刀都是幫倒忙。
          if (a > 0 && b > 0) score += 55;
          else if (a > 0) score -= 160;
          else if (b > 0) score += 30;
          else score -= 160;
        }
      }
      if (name === 'fire_attack') {
        if (target) {
          const enemy = roleEnemyScore(view, self, target);
          score += enemy > 0 ? 45 + enemy * 0.25 : -160;
          if (target.handCount > 0) score += 8;
        }
      }
      if (name === 'indulgence') {
        if (target) score += roleEnemyScore(view, self, target) > 0 ? 55 : -160;
      }
      if (name === 'supply_shortage') {
        if (target) score += roleEnemyScore(view, self, target) > 0 ? 50 : -160;
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
            const enemy = roleEnemyScore(view, self, player);
            if (enemy > 0) score += player.chained ? -6 : 16;
            else score -= 160;
          }
        }
      }
      if (name === 'slash' || name === 'fire_slash' || name === 'thunder_slash') {
        // 方天畫戟等可指定多個目標：逐一檢查，打到隊友要重罰。
        let hostileTargets = 0;
        let friendlyTargets = 0;
        for (const id of option.targets) {
          const player = view.players[id];
          if (!player) continue;
          const enemy = roleEnemyScore(view, self, player);
          if (player.id === self.id || enemy <= 0) {
            friendlyTargets += 1;
            continue;
          }
          hostileTargets += 1;
          const damage = 1 + (self.wine ? 1 : 0);
          score += 40 + enemy * 0.25;
          if (player.hp <= damage) score += 70;
          if (player.handCount === 0) score += 12;
          if (player.equips.armor?.name === 'vine_armor') {
            score += name === 'fire_slash' ? 25 : name === 'slash' ? -30 : 0;
          }
          if (player.equips.armor?.name === 'renwang') score -= 15;
          // 高手：對手已公開打出多張【閃】，推測其手上【閃】變少。
          if (activeDifficulty === 'hard') {
            score += (activeMemory?.playedDodge.get(player.id) ?? 0) * 3;
          }
        }
        if (hostileTargets === 0) score -= 80;
        score -= friendlyTargets * 300;
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
        const secondEnemy = second ? roleEnemyScore(view, self, second) : 0;
        score += firstEnemy >= 0 && secondEnemy >= 0 && (firstEnemy > 0 || secondEnemy > 0) ? 35 : -20;
      } else if (option.skill === 'fanjian') {
        score += firstEnemy > 0 ? 40 : -30;
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

    score += jitter(rng);
    if (!best || score > best.score) best = { id: option.id, score };
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

/**
 * 【仁德】是否值得：隊友給牌、敵人空城破防、內奸控制主公血量。
 * 只使用公開資訊；未知目標預設不給。
 */
function rendePlan(view: GameView, self: PlayerView, target: PlayerView): RendePlan {
  if (!target.alive || target.id === self.id) return { score: -50, count: 0 };
  const budget = rendeBudget(view);
  const maxGive = Math.max(0, self.handCount - 1);
  if (budget <= 0 || maxGive <= 0) return { score: -50, count: 0 };

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
    const count = Math.min(2, budget, maxGive);
    if (count <= 0) return { score: -50, count: 0 };
    let score = 30;
    if (self.hp < self.maxHp) score += 18; // 仁德回復的是自己
    if (target.handCount <= 1) score += 8;
    if (self.role === 'loyal' && target.role === 'lord') score += 8;
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
    if (dyingId === self.id || savesLord || savesAlly) {
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
    // 激將：蜀勢力角色代主公打出【殺】。若借用者或被打的目標對自己不利，拒絕。
    if (isEnemyOf(view, self, request.source)) {
      return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
    }
    // 【借刀殺人】等情況會指定受害者：被逼著打自己或隊友時寧可放棄（棄武器）。
    const victim = request.targets?.[0];
    if (victim !== undefined && (victim === self.id || !isEnemyOf(view, self, victim))) {
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
      }

      const chance = affectsSelf ? 0.9 : affectsAlly ? 0.5 : affectsEnemy ? 0.4 : 0.05;
      if (nextFloat(rng) < chance) return { type: 'option', optionId: wuxie.id };
      return { type: 'pass' };
    }
  }

  if (request.need === 'choice') {
    const skills = options.filter((option) => option.kind === 'skill');
    const discard = skills.find((option) => option.skill === 'discard');
    const draw = skills.find((option) => option.skill === 'draw');
    if (discard || draw) {
      // 雌雄雙股劍：手牌少就讓對方摸，手牌多就棄一張。
      return { type: 'option', optionId: (self.handCount <= 2 && draw ? draw : discard ?? draw)!.id };
    }
    const skill = skills[0];
    if (skill) {
      const id = skill.skill;
      // 鬼才、流離預設不發動；裸衣沒有【殺】時也不發動。
      if (id === 'guicai' || id === 'liuli') {
        return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
      }
      // 突襲會拿走別人的手牌：沒有敵人可拿時（例如只剩主公）改為正常摸兩張。
      if (id === 'tuxi' && !hasTuxiTarget(view, self)) {
        return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
      }
      if (id === 'luoyi' && !(self.hand ?? []).some((card) => isSlashName(card.name))) {
        return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
      }
      if (id === 'rock_axe' && self.handCount < 2 && pass) {
        return { type: 'option', optionId: pass.id };
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
    const maxGive = Math.max(0, self.handCount - 1);
    let desired = Math.min(2, budget, maxGive, maxAvailable);
    if (target) {
      const hasKongcheng = target.skills.includes('kongcheng') && target.handCount === 0;
      if ((self.role === 'spy' && target.role === 'lord') || hasKongcheng) {
        desired = Math.min(1, maxAvailable);
      }
    }
    const count = Math.max(min, Math.min(maxAvailable, desired));
    if (activeMemory) {
      if (activeMemory.rendeTurn !== view.turnCount) {
        activeMemory.rendeTurn = view.turnCount;
        activeMemory.rendeGiven = 0;
      }
      activeMemory.rendeGiven += count;
    }
    return { type: 'cards', cards: sorted.slice(0, count) };
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
    .map((card) => ({ card, score: removalScore(card, enemy) }))
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
function removalScore(card: Card, enemy: number): number {
  const meta = CARD_META[card.name];
  if (meta.type === 'equip') {
    // 拆敵人的裝備是好事，拆隊友的裝備是壞事。
    return equipPriority(card) + (enemy > 0 ? 4 : -6);
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
          },
        ];
      });
      const enemies = scored
        .filter((item) => item.enemy > 0)
        .sort((a, b) => b.enemy - a.enemy || b.handCount - a.handCount);
      const rest = scored
        .filter((item) => item.enemy <= 0)
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
      // 觀星等：預設保留牌堆頂順序（不移動）。
      return { type: 'cards', cards: request.cards.slice(0, request.min).map((card) => card.id) };
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
