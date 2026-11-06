import type { GameResult, GameView, PlayerId, Request, Response } from '../engine/types';
import { createGame, viewFor } from '../engine/state';
import { runGame } from '../engine/engine';
import { createAiMemory, decide, type AiMemory } from '../ai/policy';
import { AI_RNG_XOR, type SaveFile } from './save';

export interface ReplayData {
  /** 存檔玩到對局結束才有結果；中途存檔為 null。 */
  result: GameResult | null;
  /** 每個人類決策點與最後的視角快照。 */
  views: GameView[];
}

const MAX_REPLAY_REQUESTS = 500_000;

/**
 * 由存檔重建整局：人類回應照存檔套用，AI 由種子與難度重新決策。
 * 只要控制器與這裡使用相同的 AI 隨機種子與呼叫順序，結果就會完全一致。
 */
export function buildReplay(save: SaveFile): ReplayData {
  const state = createGame({
    seed: save.seed,
    humanId: save.humanId,
    ...(save.humanGeneralId ? { humanGeneralId: save.humanGeneralId } : {}),
    ...(save.humanRole ? { humanRole: save.humanRole } : {}),
  });
  const generator = runGame(state);
  const aiRng = { rngState: (state.seed ^ AI_RNG_XOR) >>> 0 || 1 };
  const memories = new Map<PlayerId, AiMemory>();
  const views: GameView[] = [];

  let recordedIndex = 0;
  let step = generator.next();
  let guard = 0;
  while (!step.done) {
    guard += 1;
    if (guard > MAX_REPLAY_REQUESTS) throw new Error('重播超過請求上限');
    const request: Request = step.value;

    let response: Response;
    if (request.player === save.humanId) {
      const recorded = save.responses[recordedIndex];
      if (!recorded) {
        // 中途存檔：記錄的人類回應用完，重播到此為止。
        break;
      }
      if (recorded.requestId !== request.id) {
        throw new Error('重播存檔與本局流程不符');
      }
      recordedIndex += 1;
      response = recorded.response;
      views.push(viewFor(state, save.humanId));
    } else {
      let memory = memories.get(request.player);
      if (!memory) {
        memory = createAiMemory();
        memories.set(request.player, memory);
      }
      response = decide(viewFor(state, request.player), request, aiRng, memory, save.difficulty);
    }

    step = generator.next(response);
  }

  views.push(viewFor(state, save.humanId));
  return { result: step.done ? step.value : null, views };
}
