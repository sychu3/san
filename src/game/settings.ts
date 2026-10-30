export type AnimationMode = 'full' | 'fast' | 'off';

export interface Settings {
  /** 是否播放合成音效（預設關閉）。 */
  sound: boolean;
  /** 動畫速度；`off` 完全停用非必要動畫。 */
  animation: AnimationMode;
}

export const DEFAULT_SETTINGS: Settings = { sound: false, animation: 'full' };

export const SETTINGS_STORAGE_KEY = 'sgs:settings';

const ANIMATION_MODES: readonly AnimationMode[] = ['full', 'fast', 'off'];

export function sanitizeSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const raw = value as Partial<Settings>;
  const animation = ANIMATION_MODES.includes(raw.animation as AnimationMode)
    ? (raw.animation as AnimationMode)
    : DEFAULT_SETTINGS.animation;
  return { sound: raw.sound === true, animation };
}

interface ReadableStorage {
  getItem(key: string): string | null;
}

interface WritableStorage {
  setItem(key: string, value: string): void;
}

function defaultStorage(): (ReadableStorage & WritableStorage) | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(storage: ReadableStorage | null = defaultStorage()): Settings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function persistSettings(
  settings: Settings,
  storage: WritableStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 私密瀏覽或額度不足時忽略；設定非必要功能。
  }
}
