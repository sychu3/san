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
}

export function createAiMemory(): AiMemory {
  return {
    lastEventSeq: 0,
    rebelScore: new Map(),
    knownRole: new Map(),
    playedDodge: new Map(),
    playedPeach: new Map(),
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
    return;
  }

  if (event.kind === 'damage' && event.source !== null && event.target !== null) {
    if (event.target === lordId) bump(memory.rebelScore, event.source, 4);
    const known = memory.knownRole.get(event.target);
    if (known === 'loyal') bump(memory.rebelScore, event.source, 3);
    if (known === 'rebel') bump(memory.rebelScore, event.source, -2);
    if (event.source === lordId) bump(memory.rebelScore, event.target, 3);
    return;
  }

  if (event.kind === 'use' && event.cardName && event.source !== null) {
    if (event.cardName === 'dodge') bump(memory.playedDodge, event.source, 1, 0, 20);
    if (event.cardName === 'peach') bump(memory.playedPeach, event.source, 1, 0, 20);
    if (event.target === lordId && HARMFUL_TRICKS.has(event.cardName)) {
      bump(memory.rebelScore, event.source, 2);
    }
    if (event.target === lordId && BENEFICIAL_TRICKS.has(event.cardName)) {
      bump(memory.rebelScore, event.source, -1);
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

/** 由身份信念對敵意分數做調整；新手難度完全忽略。 */
function beliefAdjust(self: PlayerView, target: PlayerView): number {
  if (activeDifficulty === 'easy' || !activeMemory) return 0;
  const score = activeMemory.rebelScore.get(target.id) ?? 0;
  if (score === 0) return 0;
  const weight = activeDifficulty === 'hard' ? 0.6 : 0.4;
  if (self.role === 'rebel') return -score * weight;
  if (self.role === 'spy') return score * weight * 0.5;
  return score * weight;
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
      case 'pass':
        score = 0;
        break;
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
        score += slashOptions.length > 0 ? 18 : -20;
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
          score += base > 0 ? 35 + base * 0.3 : -40;
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
          score += enemy > 0 ? 45 + enemy * 0.3 + shaCount * 6 : -60;
        }
      }
      if (name === 'barbarian' || name === 'arrows') {
        const allies = option.targets.filter((id) => id !== self.id && roleEnemyScore(view, self, view.players[id]!) <= 0);
        score += 42 + option.targets.length * 5 - allies.length * 30;
      }
      if (name === 'peach_garden') {
        const net = option.targets.reduce((sum, id) => {
          const player = view.players[id];
          if (!player || player.hp >= player.maxHp) return sum;
          const enemy = roleEnemyScore(view, self, player);
          return sum + (enemy > 0 ? -18 : 18);
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
          else if (a > 0) score -= 45;
          else if (b > 0) score += 30;
          else score -= 50;
        }
      }
      if (name === 'fire_attack') {
        if (target) {
          const enemy = roleEnemyScore(view, self, target);
          score += enemy > 0 ? 45 + enemy * 0.25 : -40;
          if (target.handCount > 0) score += 8;
        }
      }
      if (name === 'indulgence') {
        if (target) score += roleEnemyScore(view, self, target) > 0 ? 55 : -45;
      }
      if (name === 'supply_shortage') {
        if (target) score += roleEnemyScore(view, self, target) > 0 ? 50 : -45;
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
            else score -= 25;
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
        score -= friendlyTargets * 90;
        // 有實體【殺】時優先使用，不要把兩張手牌浪費在丈八蛇矛上。
        if (option.skill === 'serpent_spear' && (self.hand ?? []).some((card) => isSlashName(card.name))) {
          score -= 45;
        }
      }
      if (CARD_META[name].type === 'equip') {
        score += 45;
        if (option.cards.length > 0 && self.hand) {
          // 已有同類裝備時略為降低優先度。
          const card = self.hand.find((item) => item.id === option.cards[0]);
          if (card && isSlotOccupied(self, card)) score -= 20;
        }
      }
    }

    // 主動技能的評分；新手難度傾向不使用技能。
    if (option.kind === 'play' && option.skill && activeDifficulty !== 'easy') {
      const firstId = option.targets[0];
      const first = firstId === undefined ? null : view.players[firstId] ?? null;
      const firstEnemy = first ? roleEnemyScore(view, self, first) : 0;
      if (option.skill === 'rende') {
        score += firstEnemy <= 0 && self.handCount > self.hp ? 30 : -25;
      } else if (option.skill === 'zhiheng') {
        score += self.handCount >= 3 ? 28 : 5;
      } else if (option.skill === 'qingnang') {
        score += first && first.hp < first.maxHp && firstEnemy <= 0 ? 40 : -30;
      } else if (option.skill === 'lijian') {
        const secondId = option.targets[1];
        const second = secondId === undefined ? null : view.players[secondId] ?? null;
        const secondEnemy = second ? roleEnemyScore(view, self, second) : 0;
        score += firstEnemy >= 0 && secondEnemy >= 0 && (firstEnemy > 0 || secondEnemy > 0) ? 35 : -20;
      } else if (option.skill === 'kurou') {
        score += self.hp >= 2 ? 20 : -40;
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

function isSlotOccupied(self: PlayerView, card: Card): boolean {
  const meta = CARD_META[card.name];
  if (meta.type !== 'equip' || !meta.subtype) return false;
  switch (meta.subtype) {
    case 'weapon':
      return self.equips.weapon !== null;
    case 'armor':
      return self.equips.armor !== null;
    case 'horse_plus':
      return self.equips.horsePlus !== null;
    case 'horse_minus':
      return self.equips.horseMinus !== null;
    default:
      return false;
  }
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
    // 內奸在最後單挑時救主公，避免反賊勝利。
    if (self.role === 'spy' && dying?.role === 'lord') {
      const alive = view.players.filter((player) => player.alive).length;
      if (alive <= 2) {
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
        return Boolean(player) && player.id !== self.id && roleEnemyScore(view, self, player) <= 0 && gains(player);
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
  for (const card of hand) {
    values.set(card.id, cardValue(card.name) + jitter(rng, 3));
  }
  const sorted = [...request.cards].sort((a, b) => (values.get(a) ?? 0) - (values.get(b) ?? 0));
  const count = Math.max(request.min, Math.min(request.max, request.cards.length));
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
      const scored = [...new Set(request.candidates)].flatMap((id) => {
        const player = view.players[id];
        if (!player) return [];
        return [{ id, enemy: roleEnemyScore(view, self, player), handCount: player.handCount }];
      });
      const enemies = scored
        .filter((item) => item.enemy > 0)
        .sort((a, b) => b.enemy - a.enemy || b.handCount - a.handCount);
      const rest = scored
        .filter((item) => item.enemy <= 0)
        .sort((a, b) => b.handCount - a.handCount);
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
