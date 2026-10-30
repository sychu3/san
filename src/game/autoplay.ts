import type { Difficulty, GameResult, PlayerId, Request } from '../engine/types';
import { createGame, viewFor, type CreateGameOptions } from '../engine/state';
import { runGame } from '../engine/engine';
import { createAiMemory, decide, type AiMemory } from '../ai/policy';

/**
 * 讓所有座位都由 AI 操作，用於測試與模擬。
 * 設有請求上限，避免規則 bug 造成無限迴圈。
 */
export function autoPlayGame(
  options: CreateGameOptions & {
    maxRequests?: number;
    difficulty?: Difficulty;
    /** 指定每個座位的難度；優先於 `difficulty`。 */
    difficultyByPlayer?: readonly Difficulty[];
  } = {},
): GameResult {
  const state = createGame(options);
  const generator = runGame(state);
  const aiRng = { rngState: (state.seed ^ 0x85ebca6b) >>> 0 || 1 };
  const maxRequests = options.maxRequests ?? 500_000;
  const difficulty: Difficulty = options.difficulty ?? 'normal';
  const memories = new Map<PlayerId, AiMemory>();

  let step = generator.next();
  let requests = 0;
  while (!step.done) {
    requests += 1;
    if (requests > maxRequests) {
      throw new Error(`AI 對局超過 ${maxRequests} 個請求，可能發生死循環`);
    }
    const request: Request = step.value;
    let memory = memories.get(request.player);
    if (!memory) {
      memory = createAiMemory();
      memories.set(request.player, memory);
    }
    const playerDifficulty = options.difficultyByPlayer?.[request.player] ?? difficulty;
    const response = decide(viewFor(state, request.player), request, aiRng, memory, playerDifficulty);
    step = generator.next(response);
  }

  return step.value;
}
