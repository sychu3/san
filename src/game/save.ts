import type { Difficulty, PlayerId, Response, Role } from '../engine/types';
import { GENERAL_INDEX } from '../data/generals';
import { GAME_VERSION } from '../engine/state';

/**
 * 存檔格式：只保存種子、人類座位、難度與人類回應，不保存完整狀態。
 * 重播時以相同引擎與種子重建，AI 由種子決定，因此結果一致。
 */
export interface SavedResponse {
  requestId: number;
  response: Response;
}

export interface SaveFile {
  version: string;
  seed: number;
  humanId: PlayerId;
  difficulty: Difficulty;
  responses: SavedResponse[];
  /** 人類選擇的武將；舊存檔沒有此欄位時沿用 seed 預設武將。 */
  humanGeneralId?: string;
  /** 人類的身份（自訂對局）；重播時需強制同一身份。 */
  humanRole?: Role;
}

export const SAVE_KEY = 'sgs:save';
export const SETTINGS_KEY = 'sgs:settings';

/** 控制器與重播共用的 AI 隨機種子位移；兩邊必須一致才能重現。 */
export const AI_RNG_XOR = 0x9e3779b9;

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const ROLES: readonly Role[] = ['lord', 'loyal', 'rebel', 'spy'];

function isResponse(value: unknown): value is Response {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as { type?: unknown };
  switch (response.type) {
    case 'option':
      return typeof (value as { optionId?: unknown }).optionId === 'string';
    case 'cards': {
      const cards = (value as { cards?: unknown }).cards;
      if (!Array.isArray(cards) || !cards.every((card) => typeof card === 'number')) return false;
      const bottom = (value as { bottom?: unknown }).bottom;
      if (bottom === undefined) return true;
      return Array.isArray(bottom) && bottom.every((card) => typeof card === 'number');
    }
    case 'players': {
      const players = (value as { players?: unknown }).players;
      return Array.isArray(players) && players.every((player) => typeof player === 'number');
    }
    case 'card':
      return typeof (value as { card?: unknown }).card === 'number';
    case 'pass':
      return true;
    default:
      return false;
  }
}

/** 驗證任意值是否為合法存檔；版本不相容或格式錯誤都回傳 false。 */
export function isValidSave(value: unknown): value is SaveFile {
  if (typeof value !== 'object' || value === null) return false;
  const save = value as Partial<SaveFile>;
  if (save.version !== GAME_VERSION) return false;
  if (typeof save.seed !== 'number' || !Number.isFinite(save.seed)) return false;
  if (typeof save.humanId !== 'number' || save.humanId < 0 || save.humanId > 4) return false;
  if (!DIFFICULTIES.includes(save.difficulty as Difficulty)) return false;
  if (save.humanGeneralId !== undefined) {
    if (typeof save.humanGeneralId !== 'string' || !GENERAL_INDEX.has(save.humanGeneralId)) return false;
  }
  if (save.humanRole !== undefined) {
    if (!ROLES.includes(save.humanRole)) return false;
  }
  if (!Array.isArray(save.responses)) return false;
  return save.responses.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as SavedResponse).requestId === 'number' &&
      isResponse((entry as SavedResponse).response),
  );
}

export function serializeSave(save: SaveFile): string {
  return JSON.stringify(save);
}

/** 解析存檔字串；損壞或版本不相容時回傳 null，不拋錯。 */
export function parseSave(raw: string | null): SaveFile | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSave(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createSaveFile(options: {
  seed: number;
  humanId: PlayerId;
  difficulty: Difficulty;
  responses: SavedResponse[];
  humanGeneralId?: string;
  humanRole?: Role;
}): SaveFile {
  return {
    version: GAME_VERSION,
    seed: options.seed,
    humanId: options.humanId,
    difficulty: options.difficulty,
    responses: options.responses.map((entry) => ({ requestId: entry.requestId, response: entry.response })),
    ...(options.humanGeneralId ? { humanGeneralId: options.humanGeneralId } : {}),
    ...(options.humanRole ? { humanRole: options.humanRole } : {}),
  };
}
