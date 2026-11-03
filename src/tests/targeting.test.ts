import { describe, expect, it } from 'vitest';
import { createGame, viewFor } from '../engine/state';
import { runGame } from '../engine/engine';
import { createAiMemory, decide, type AiMemory } from '../ai/policy';
import type { CardName, PlayerId, Request, Response, Role } from '../engine/types';

/**
 * 逐局掃描 AI 的決策，確認「已能由公開資訊判斷為隊友」的角色不會被技能或牌當成目標。
 * 主公身份公開，因此忠臣打主公、內奸在有其他人時打主公都是可判定錯誤。
 */

/** 只影響單一目標（或一組指定目標）的敵意牌；群體牌（南蠻、萬箭）另計。 */
const HOSTILE_CARDS = new Set<CardName>([
  'slash',
  'fire_slash',
  'thunder_slash',
  'duel',
  'dismantle',
  'snatch',
  'fire_attack',
  'indulgence',
  'supply_shortage',
  'collateral',
  'iron_chain',
  'barbarian',
  'arrows',
]);

const HOSTILE_SKILLS = new Set(['tuxi', 'fanjian', 'lijian']);

/** 主公第一回合不可用來打未知目標的高成本敵意牌。 */
const LORD_FIRST_TURN_HIGH_COST = new Set<CardName>([
  'duel',
  'dismantle',
  'snatch',
  'fire_attack',
  'indulgence',
  'supply_shortage',
  'collateral',
]);
const LORD_FIRST_TURN_HIGH_COST_SKILLS = new Set(['fanjian', 'lijian']);

interface Violation {
  seed: number;
  what: string;
}

function scan(seeds: number): Violation[] {
  const violations: Violation[] = [];

  for (let seed = 1; seed <= seeds; seed += 1) {
    const state = createGame({ seed });
    const generator = runGame(state);
    const rng = { rngState: (state.seed ^ 0x85ebca6b) >>> 0 || 1 };
    const memories = new Map<PlayerId, AiMemory>();
    const roleOf = (id: PlayerId): Role => state.players[id]!.role!;
    const aliveCount = (): number => state.players.filter((player) => player.alive).length;
    const lordId = state.players.find((player) => player.role === 'lord')!.id;

    const check = (actor: PlayerId, targets: readonly PlayerId[], what: string): void => {
      const actorRole = roleOf(actor);
      for (const target of targets) {
        if (target === actor) {
          violations.push({ seed, what: `${what}：自己打自己` });
          continue;
        }
        const targetRole = roleOf(target);
        if (actorRole === 'loyal' && targetRole === 'lord') {
          violations.push({ seed, what: `${what}：忠臣打主公` });
        }
        if (actorRole === 'spy' && targetRole === 'lord' && aliveCount() > 2) {
          violations.push({ seed, what: `${what}：內奸在有其他人時打主公` });
        }
      }
    };

    const isTeammate = (actor: Role, target: Role): boolean => {
      if (actor === 'loyal') return target === 'lord';
      if (actor === 'rebel') return target === 'rebel';
      if (actor === 'spy') return target === 'lord' && aliveCount() > 2;
      if (actor === 'lord') return target === 'loyal';
      return false;
    };

    let wineUser: PlayerId | null = null;
    let step = generator.next();
    let guard = 0;
    while (!step.done && guard < 200_000) {
      guard += 1;
      const request: Request = step.value;
      let memory = memories.get(request.player);
      if (!memory) {
        memory = createAiMemory();
        memories.set(request.player, memory);
      }
      const response: Response = decide(
        viewFor(state, request.player),
        request,
        rng,
        memory,
        'normal',
      );

      if (response.type === 'option' && (request.kind === 'action' || request.kind === 'response')) {
        const option = request.options.find((item) => item.id === response.optionId);
        if (option && option.kind !== 'pass') {
          // 代打請求（激將、護駕）：借用者一定是主公，反賊不該代打；
          // 被要求打的對象若是隊友（或被逼打自己）也不該出牌。
          if (
            request.kind === 'response' &&
            (request.need === 'sha' || request.need === 'shan') &&
            request.source !== undefined
          ) {
            const responder = roleOf(request.player);
            if (responder === 'rebel' && roleOf(request.source) === 'lord') {
              violations.push({ seed, what: `代打（${request.need}）：反賊替主公出牌` });
            }
            const victim = request.targets?.[0];
            if (victim !== undefined) {
              const victimRole = roleOf(victim);
              if (responder === 'rebel' && victimRole === 'rebel') {
                violations.push({ seed, what: `代打（${request.need}）：反賊打隊友` });
              }
              if (responder === 'loyal' && (victimRole === 'lord' || victim === request.player)) {
                violations.push({ seed, what: `代打（${request.need}）：忠臣打主公或自己` });
              }
            }
          }
          if (request.kind === 'action') {
            const targets = option.targets ?? [];
            if (option.asCard && HOSTILE_CARDS.has(option.asCard)) {
              check(request.player, option.asCard === 'collateral' ? targets.slice(1) : targets, `使用【${option.asCard}】`);
            } else if (option.skill && HOSTILE_SKILLS.has(option.skill)) {
              check(request.player, targets, `發動【${option.skill}】`);
            }
            // 主公第一回合（主公先手，turnCount 1）只准試探與群體錦囊，不可用酒或高成本單體敵意牌。
            if (request.player === lordId && state.turnCount === 1) {
              if (option.asCard === 'wine') {
                violations.push({ seed, what: '主公第一回合使用【酒】' });
              }
              if (option.asCard && LORD_FIRST_TURN_HIGH_COST.has(option.asCard)) {
                violations.push({ seed, what: `主公第一回合使用高成本【${option.asCard}】` });
              }
              if (option.skill && LORD_FIRST_TURN_HIGH_COST_SKILLS.has(option.skill)) {
                violations.push({ seed, what: `主公第一回合發動【${option.skill}】` });
              }
            }

            // 【酒】只可接在打向敵人的【殺】上，不可用來誤傷隊友。
            if (option.asCard === 'wine') {
              wineUser = request.player;
            } else if (
              wineUser === request.player &&
              option.asCard !== undefined &&
              (option.asCard === 'slash' ||
                option.asCard === 'fire_slash' ||
                option.asCard === 'thunder_slash')
            ) {
              for (const target of targets) {
                if (target !== request.player && isTeammate(roleOf(request.player), roleOf(target))) {
                  violations.push({
                    seed,
                    what: `酒加在隊友【殺】上（${roleOf(request.player)} -> ${roleOf(target)}）`,
                  });
                }
              }
              wineUser = null;
            } else if (wineUser === request.player) {
              wineUser = null;
            }
          }
        }
      }

      if (request.kind === 'choosePlayers' && response.type === 'players' && request.reason === '突襲') {
        check(request.player, response.players, '突襲選目標');
      }

      step = generator.next(response);
    }
    expect(step.done, `seed ${seed} 未正常結束`).toBe(true);
  }

  return violations;
}

describe('AI 不會把技能與牌指向可判定的隊友', () => {
  it('200 局掃描：忠臣不打主公、內奸在有其他人時不打主公、沒人打自己', () => {
    const violations = scan(200);
    const summary = violations
      .slice(0, 10)
      .map((item) => `seed ${item.seed} ${item.what}`)
      .join('\n');
    expect(violations, summary).toEqual([]);
  }, 30_000);
});

/** 友軍互相傷害：這些組合只有在被敵方【離間】／【借刀殺人】強迫時才可接受。 */
const FRIENDLY_PAIRS = new Set<string>(['lord->loyal', 'loyal->lord', 'rebel->rebel']);

/**
 * 掃描指定 seed，找出「非被強迫」的主動友軍死亡。
 * 強迫判斷沿用公開日誌：死亡前的近期紀錄出現【離間】或【借刀殺人】。
 */
function scanProactiveFriendlyKills(seeds: readonly number[]): Violation[] {
  const violations: Violation[] = [];
  for (const seed of seeds) {
    const state = createGame({ seed });
    const generator = runGame(state);
    const rng = { rngState: (state.seed ^ 0x85ebca6b) >>> 0 || 1 };
    const memories = new Map<PlayerId, AiMemory>();
    let seen = 0;
    let step = generator.next();
    let guard = 0;
    while (!step.done && guard < 400_000) {
      guard += 1;
      const request: Request = step.value;
      let memory = memories.get(request.player);
      if (!memory) {
        memory = createAiMemory();
        memories.set(request.player, memory);
      }
      const response: Response = decide(
        viewFor(state, request.player),
        request,
        rng,
        memory,
        'normal',
      );
      step = generator.next(response);

      const newEvents = state.publicEvents.slice(-(state.eventSeq - seen));
      for (const event of newEvents) {
        if (event.seq <= seen) continue;
        seen = event.seq;
        if (
          event.kind !== 'death' ||
          event.source === null ||
          event.target === null ||
          event.source === event.target
        ) {
          continue;
        }
        const key = `${state.players[event.source]!.role}->${state.players[event.target]!.role}`;
        if (!FRIENDLY_PAIRS.has(key)) continue;
        const recent = state.log.slice(-16).map((entry) => entry.text).join('\n');
        const forced = recent.includes('離間') || recent.includes('借刀');
        if (!forced) violations.push({ seed, what: `主動誤殺（${key}）` });
      }
    }
  }
  return violations;
}

describe('AI 不會主動誤殺隊友（致命／高成本閘）', () => {
  it('1–150 局與指定回歸 seed：主動友軍死亡為 0', () => {
    const seeds = [
      ...Array.from({ length: 150 }, (_, index) => index + 1),
      21,
      22,
      24,
      1391137374,
      3668092673,
    ];
    const violations = scanProactiveFriendlyKills(seeds);
    const summary = violations
      .slice(0, 10)
      .map((item) => `seed ${item.seed} ${item.what}`)
      .join('\n');
    expect(violations, summary).toEqual([]);
  }, 60_000);
});
