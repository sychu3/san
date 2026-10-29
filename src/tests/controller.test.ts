import { describe, expect, it } from 'vitest';
import { GameController } from '../game/controller';
import type { Response } from '../engine/types';

function makeController(seed = 5) {
  return new GameController({ seed, humanId: 0 });
}

describe('GameController', () => {
  it('啟動後會停在人類玩家的請求', () => {
    const controller = makeController();
    const pending = controller.getView().pending;
    expect(pending).not.toBeNull();
    expect(pending?.player).toBe(0);
  });

  it('拒絕過期或偽造的 request id', () => {
    const controller = makeController();
    const pending = controller.getView().pending;
    expect(pending).not.toBeNull();
    if (!pending) return;
    expect(() => controller.respond(pending.id + 1, { type: 'pass' })).toThrow();
    // 失敗的回應不能消耗目前請求。
    expect(controller.getView().pending?.id).toBe(pending.id);
  });

  it('接受合法回應並繼續推進', () => {
    const controller = makeController();
    const pending = controller.getView().pending;
    expect(pending).not.toBeNull();
    if (!pending) return;

    let response: Response = { type: 'pass' };
    if (pending.kind === 'action' || pending.kind === 'response') {
      const pass = pending.options.find((option) => option.kind === 'pass');
      if (pass) response = { type: 'option', optionId: pass.id };
    }
    expect(() => controller.respond(pending.id, response)).not.toThrow();
    expect(controller.getView().pending?.id).not.toBe(pending.id);
  });

  it('上帝視角會揭露身份與其他手牌，關閉後恢復遮蔽', () => {
    const controller = makeController();
    controller.setGodMode(true);
    const god = controller.getView();
    expect(god.players.every((player) => player.role !== null)).toBe(true);
    expect(god.players[1]!.hand).not.toBeNull();

    controller.setGodMode(false);
    const normal = controller.getView();
    expect(normal.players[1]!.hand).toBeNull();
  });
});
