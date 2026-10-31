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
]);

const HOSTILE_SKILLS = new Set(['tuxi', 'fanjian', 'lijian']);

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
  });
});
