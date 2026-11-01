import { ALL_GENERAL_IDS } from '../data/generals';
import type { PlayerId, Role } from '../engine/types';
import { randomSeed, shuffle, type RngState } from '../engine/rng';
import { createGame } from '../engine/state';

/**
 * 開局前置：先決定身份，再讓人類玩家從候選武將中選一個。
 *
 * 候選武將與身份都由 seed 決定，且候選名單使用獨立的隨機數流，
 * 不會影響正式對局的隨機數消耗，因此存檔只要記下 seed 與選擇即可重現。
 */
export interface GameSetup {
  seed: number;
  /** 人類玩家在這一局的身份（身份決定後才選將）。 */
  role: Role;
  /** 三張候選武將 id（不含重複）。 */
  candidates: string[];
}

export const CANDIDATE_COUNT = 3;

/** 候選名單用的隨機數位移，與對局、AI 的位移都不同。 */
const CANDIDATE_XOR = 0x51ed270b;

/** 由 seed 產生 `count` 名不重複的候選武將；同一 seed 結果固定。 */
export function generalCandidates(
  seed: number,
  count = CANDIDATE_COUNT,
  pool: readonly string[] = ALL_GENERAL_IDS,
): string[] {
  const rng: RngState = { rngState: (seed ^ CANDIDATE_XOR) >>> 0 || 1 };
  const shuffled = shuffle([...pool], rng);
  return shuffled.slice(0, Math.max(0, Math.min(count, shuffled.length)));
}

/** 建立開局資訊（身份 + 候選武將）；不啟動引擎、不產生牌局。 */
export function createSetup(humanId: PlayerId = 0, seed: number = randomSeed()): GameSetup {
  // 用一個預覽牌局取得人類身份；身份與 seed 的對應和正式對局完全一致。
  const preview = createGame({ seed, humanId });
  const role = preview.players[humanId]?.role;
  if (!role) throw new Error(`不合法的人類座位：${humanId}`);
  return { seed, role, candidates: generalCandidates(seed) };
}
