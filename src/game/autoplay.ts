import type { GameResult, Request } from '../engine/types';
import { createGame, viewFor, type CreateGameOptions } from '../engine/state';
import { runGame } from '../engine/engine';
import { decide } from '../ai/policy';

/**
 * 讓所有座位都由 AI 操作，用於測試與模擬。
 * 設有請求上限，避免規則 bug 造成無限迴圈。
 */
export function autoPlayGame(options: CreateGameOptions & { maxRequests?: number } = {}): GameResult {
  const state = createGame(options);
  const generator = runGame(state);
  const aiRng = { rngState: (state.seed ^ 0x85ebca6b) >>> 0 || 1 };
  const maxRequests = options.maxRequests ?? 500_000;

  let step = generator.next();
  let requests = 0;
  while (!step.done) {
    requests += 1;
    if (requests > maxRequests) {
      throw new Error(`AI 對局超過 ${maxRequests} 個請求，可能發生死循環`);
    }
    const request: Request = step.value;
    const response = decide(viewFor(state, request.player), request, aiRng);
    step = generator.next(response);
  }

  return step.value;
}
