import { ALL_GENERAL_IDS } from '../data/generals';
import type { PlayerId, Role } from '../engine/types';
import { randomSeed, shuffle, type RngState } from '../engine/rng';
import { distance } from '../engine/rules';
import { createGame } from '../engine/state';

/**
 * 開局前置：先決定身份，再讓人類玩家從候選武將中選一個。
 *
 * 候選武將與身份都由 seed 決定，且候選名單使用獨立的隨機數流，
 * 不會影響正式對局的隨機數消耗，因此存檔只要記下 seed 與選擇即可重現。
 *
 * 比照原版，選將前會提供：主公已選定的武將（人類不是主公時）、
 * 主公與自己的座位位置，以及彼此距離。
 */
export interface GameSetup {
  seed: number;
  /** 人類玩家在這一局的身份（身份決定後才選將）。 */
  role: Role;
  /** 人類玩家的座位（0 起算）。 */
  humanSeat: PlayerId;
  /** 主公的座位（0 起算）。 */
  lordSeat: PlayerId;
  /** 主公已公開的武將；人類自己就是主公時為 null（由自己選）。 */
  lordGeneralId: string | null;
  /** 人類與主公的座位距離；自己就是主公時為 0。 */
  lordDistance: number;
  /** 候選武將 id（不含重複，也不含主公已選的武將）。 */
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

/** 建立開局資訊（身份、主公武將、座位與候選名單）；不啟動引擎。 */
export function createSetup(humanId: PlayerId = 0, seed: number = randomSeed()): GameSetup {
  // 用一個預覽牌局取得身份與初始配將；身份與 seed 的對應和正式對局完全一致。
  const preview = createGame({ seed, humanId });
  const role = preview.players[humanId]?.role;
  if (!role) throw new Error(`不合法的人類座位：${humanId}`);
  const lord = preview.players.find((player) => player.role === 'lord');
  if (!lord) throw new Error('無法找到主公');

  const isLord = lord.id === humanId;
  // 主公先選：人類不是主公時，看到主公的武將，且候選不重複主公的武將。
  const lordGeneralId = isLord ? null : lord.generalId;
  const pool = lordGeneralId
    ? ALL_GENERAL_IDS.filter((id) => id !== lordGeneralId)
    : ALL_GENERAL_IDS;

  return {
    seed,
    role,
    humanSeat: humanId,
    lordSeat: lord.id,
    lordGeneralId,
    lordDistance: isLord ? 0 : distance(preview, humanId, lord.id),
    candidates: generalCandidates(seed, CANDIDATE_COUNT, pool),
  };
}
