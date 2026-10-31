import { describe, expect, it } from 'vitest';
import { GameController } from '../game/controller';
import { CARD_DESCRIPTIONS, CARD_NAMES, cardDescription, cardLabel } from '../data/cardMeta';
import type { Request, Response } from '../engine/types';

function autoResponse(request: Request): Response {
  switch (request.kind) {
    case 'action': {
      const pass = request.options.find((item) => item.kind === 'pass');
      return { type: 'option', optionId: (pass ?? request.options[0]!).id };
    }
    case 'response': {
      const first = request.options.find((item) => item.kind !== 'pass');
      return first ? { type: 'option', optionId: first.id } : { type: 'pass' };
    }
    case 'chooseCards':
      return { type: 'cards', cards: request.cards.slice(0, request.min) };
    case 'choosePlayers':
      return { type: 'players', players: request.candidates.slice(0, request.min) };
    case 'chooseCard':
      return { type: 'card', card: request.allowRandomHand ? -1 : (request.cards[0] ?? -1) };
    case 'chooseRevealed':
      return { type: 'card', card: request.cards[0]?.id ?? -1 };
    case 'chooseFrom':
      return { type: 'cards', cards: request.cards.slice(0, request.min).map((card) => card.id) };
    default:
      return { type: 'pass' };
  }
}

describe('UX 改善：逐步模式', () => {
  it('逐步模式會在 AI 行動前暫停，繼續後才會前進', () => {
    const controller = new GameController({ seed: 1, humanId: 0, stepMode: true });
    let resumptions = 0;
    let guard = 0;
    while (!controller.getResult() && guard < 20_000) {
      guard += 1;
      if (controller.isWaitingStep()) {
        resumptions += 1;
        controller.resumeStep();
        continue;
      }
      const pending = controller.getView().pending;
      if (!pending) break;
      controller.respond(pending.id, autoResponse(pending));
    }

    expect(resumptions).toBeGreaterThan(0);
    expect(controller.getResult()).not.toBeNull();
  });

  it('關閉逐步模式時不會停在 AI 行動前', () => {
    const controller = new GameController({ seed: 2, humanId: 0, stepMode: false });
    // 建立後應直接停在人類請求，或已結束；不會是「等待逐步」。
    expect(controller.isWaitingStep()).toBe(false);
  });

  it('中途關閉逐步模式會立刻繼續', () => {
    const controller = new GameController({ seed: 1, humanId: 0, stepMode: true });
    // 讓局面推進到一次 AI 暫停（若一開始就是人類行動，先回應一次）。
    let guard = 0;
    while (!controller.isWaitingStep() && !controller.getResult() && guard < 20_000) {
      guard += 1;
      const pending = controller.getView().pending;
      if (!pending) break;
      controller.respond(pending.id, autoResponse(pending));
    }
    if (controller.isWaitingStep()) {
      controller.setStepMode(false);
      expect(controller.isWaitingStep()).toBe(false);
    }
  });
});

describe('UX 改善：卡牌與坐騎提示', () => {
  it('坐騎名稱會標示 (+1)／(-1)', () => {
    expect(cardLabel('jueying')).toContain('+1');
    expect(cardLabel('dilu')).toContain('+1');
    expect(cardLabel('chitu')).toContain('-1');
    expect(cardLabel('zixing')).toContain('-1');
  });

  it('每張牌都有非空的說明文字', () => {
    for (const name of CARD_NAMES) {
      expect(cardDescription(name).length).toBeGreaterThan(0);
      expect(CARD_DESCRIPTIONS[name]).toBeDefined();
    }
  });
});
