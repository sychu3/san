import { describe, expect, it } from 'vitest';
import { GameController } from '../game/controller';
import { buildReplay } from '../game/replay';
import { createSaveFile, isValidSave, parseSave, serializeSave } from '../game/save';
import { getGeneral } from '../data/generals';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  persistSettings,
  resolveTheme,
  sanitizeSettings,
  SETTINGS_STORAGE_KEY,
} from '../game/settings';
import { decide } from '../ai/policy';
import { playSound } from '../audio/sounds';

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    store,
  };
}

/** 用 AI 代替人類完成一局，回傳控制器（含人類回應紀錄）。 */
function playRecorded(seed: number): GameController {
  const controller = new GameController({ seed, humanId: 0, difficulty: 'normal' });
  const rng = { rngState: 424242 };
  let guard = 0;
  while (!controller.getResult() && guard < 200_000) {
    guard += 1;
    const view = controller.getView();
    const pending = view.pending;
    if (!pending) break;
    controller.respond(pending.id, decide(view, pending, rng));
  }
  return controller;
}

describe('M5 存檔與重播', () => {
  it('存檔可序列化、解析並通過驗證', () => {
    const controller = playRecorded(101);
    const save = controller.getSaveFile();
    expect(save.responses.length).toBeGreaterThan(0);
    expect(isValidSave(save)).toBe(true);

    const parsed = parseSave(serializeSave(save));
    expect(parsed).toEqual(save);
  });

  it('損壞或版本不相容的存檔會被拒絕', () => {
    expect(parseSave(null)).toBeNull();
    expect(parseSave('not json')).toBeNull();
    expect(parseSave(JSON.stringify({ version: 'x', seed: 1, humanId: 0, difficulty: 'normal', responses: [] }))).toBeNull();

    const base = createSaveFile({ seed: 1, humanId: 0, difficulty: 'normal', responses: [] });
    const badResponse = { ...base, responses: [{ requestId: 1, response: { type: 'option' } }] };
    expect(isValidSave(badResponse)).toBe(false);
    const badHuman = { ...base, humanId: 9 };
    expect(isValidSave(badHuman)).toBe(false);
    const badGeneral = { ...base, humanGeneralId: 'not_a_general' };
    expect(isValidSave(badGeneral)).toBe(false);
    expect(isValidSave({ ...base, humanGeneralId: 'cao_cao' })).toBe(true);
    expect(isValidSave({ ...base, humanRole: 'emperor' })).toBe(false);
    expect(isValidSave({ ...base, humanRole: 'lord' })).toBe(true);
  });

  it('自訂身份存檔會記下身份，重播能重現同一身份', () => {
    const controller = new GameController({
      seed: 606,
      humanId: 0,
      humanGeneralId: 'liu_bei',
      humanRole: 'lord',
    });
    const save = controller.getSaveFile();
    expect(save.humanRole).toBe('lord');

    const replay = buildReplay(save);
    expect(replay.views[0]!.players[0]!.role).toBe('lord');
    expect(replay.views[0]!.players[0]!.generalName).toBe(getGeneral('liu_bei').name);
  });

  it('存檔會記下選擇的武將，重播能重現同一位武將', () => {
    const controller = new GameController({
      seed: 505,
      humanId: 0,
      humanGeneralId: 'cao_cao',
    });
    const save = controller.getSaveFile();
    expect(save.humanGeneralId).toBe('cao_cao');

    const replay = buildReplay(save);
    expect(replay.views[0]!.players[0]!.generalName).toBe(getGeneral('cao_cao').name);
  });

  it('重播同一存檔會得到完全相同的結果與日誌', () => {
    const controller = playRecorded(202);
    const save = controller.getSaveFile();
    const replay = buildReplay(save);

    const liveResult = controller.getResult();
    expect(liveResult).not.toBeNull();
    expect(replay.result).not.toBeNull();
    expect(replay.result!.winner).toEqual(liveResult!.winner);
    expect(replay.result!.turns).toBe(liveResult!.turns);

    const finalLive = controller.getView();
    const finalReplay = replay.views[replay.views.length - 1]!;
    expect(finalReplay.log.map((entry) => entry.text)).toEqual(
      finalLive.log.map((entry) => entry.text),
    );
    expect(finalReplay.players.map((player) => [player.hp, player.handCount, player.alive])).toEqual(
      finalLive.players.map((player) => [player.hp, player.handCount, player.alive]),
    );
  });

  it('中途存檔（回應用完）會安全停在該點，不拋錯', () => {
    const save = createSaveFile({
      seed: 303,
      humanId: 0,
      difficulty: 'normal',
      responses: [],
    });
    const replay = buildReplay(save);
    expect(replay.result).toBeNull();
    expect(replay.views.length).toBeGreaterThanOrEqual(1);
  });

  it('回應與流程不符（偽造 requestId）時會拋錯', () => {
    const controller = playRecorded(404);
    const save = controller.getSaveFile();
    const tampered = {
      ...save,
      responses: save.responses.map((entry, index) =>
        index === 0 ? { ...entry, requestId: 999_999 } : entry,
      ),
    };
    expect(() => buildReplay(tampered)).toThrow();
  });
});

describe('M5 設定', () => {
  it('設定可寫入與讀回，損壞時回到預設（含高手難度）', () => {
    const storage = fakeStorage();
    persistSettings({ sound: true, animation: 'fast', theme: 'light', difficulty: 'easy' }, storage);
    expect(loadSettings(storage)).toEqual({
      sound: true,
      animation: 'fast',
      theme: 'light',
      difficulty: 'easy',
    });

    storage.store.set(SETTINGS_STORAGE_KEY, '{壞掉');
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.difficulty).toBe('hard');
  });

  it('sanitizeSettings 會過濾非法值', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ sound: 'yes', animation: 'zzz', theme: 'neon' })).toEqual({
      sound: false,
      animation: 'full',
      theme: 'dark',
      difficulty: 'hard',
    });
    expect(
      sanitizeSettings({ sound: true, animation: 'off', theme: 'light', difficulty: 'normal' }),
    ).toEqual({
      sound: true,
      animation: 'off',
      theme: 'light',
      difficulty: 'normal',
    });
    expect(sanitizeSettings({ theme: 'system' }).theme).toBe('system');
    expect(sanitizeSettings({ difficulty: 'impossible' }).difficulty).toBe('hard');
  });

  it('resolveTheme 會把 system 依系統偏好解析成深色或淺色', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('沒有 AudioContext 時播放音效不會拋錯', () => {
    expect(() => playSound('damage', true)).not.toThrow();
    expect(() => playSound('win', false)).not.toThrow();
  });
});
