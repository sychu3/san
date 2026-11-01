import { describe, expect, it } from 'vitest';
import { createGame, viewFor } from '../engine/state';
import { runGame } from '../engine/engine';
import type { GameView, PlayOption, PlayerId, PlayerView, Request } from '../engine/types';
import { createAiMemory, decide, updateMemory, type AiMemory } from '../ai/policy';
import { autoPlayGame } from '../game/autoplay';

function player(id: number, role: PlayerView['role'], alive = true): PlayerView {
  return { id, role, alive } as PlayerView;
}

function actionRequest(playerId: number, options: PlayOption[]): Request {
  return {
    id: 1,
    player: playerId,
    prompt: '出牌階段：請選擇行動',
    kind: 'action',
    options,
    context: '出牌階段',
  };
}

describe('M4 公開事件與身份信念', () => {
  it('對局會產生公開事件（使用、傷害）', () => {
    const state = createGame({ seed: 7 });
    const generator = runGame(state);
    const rng = { rngState: 12345 };
    const memories = new Map<PlayerId, AiMemory>();
    let step = generator.next();
    while (!step.done) {
      const request: Request = step.value;
      let memory = memories.get(request.player);
      if (!memory) {
        memory = createAiMemory();
        memories.set(request.player, memory);
      }
      step = generator.next(decide(viewFor(state, request.player), request, rng, memory, 'normal'));
    }
    const kinds = new Set(state.publicEvents.map((event) => event.kind));
    expect(kinds.has('use')).toBe(true);
    expect(kinds.has('damage')).toBe(true);
    // 公開事件不得包含手牌內容。
    for (const event of state.publicEvents) {
      expect(Object.keys(event)).not.toContain('hand');
      expect(Object.keys(event)).not.toContain('cards');
    }
  });

  it('updateMemory 依公開事件更新疑似反賊分數', () => {
    const memory = createAiMemory();
    const view = {
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null), player(3, null)],
      events: [
        { seq: 1, kind: 'damage', source: 2, target: 1, amount: 1 },
        { seq: 2, kind: 'damage', source: 2, target: 1, amount: 1 },
        { seq: 3, kind: 'save', source: 3, target: 1, cardName: 'peach' },
      ],
    } as unknown as GameView;

    updateMemory(view, memory);
    expect(memory.rebelScore.get(2) ?? 0).toBeGreaterThanOrEqual(8);
    expect(memory.rebelScore.get(3) ?? 0).toBeLessThan(0);
  });

  it('仁德公開事件以弱證據更新隊友判斷，破空城則反向計分', () => {
    const memory = createAiMemory();
    const view = {
      turnCount: 1,
      pending: null,
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null), player(3, null), player(4, null)],
      events: [
        { seq: 1, kind: 'give', source: 2, target: 1, amount: 2 },
        { seq: 2, kind: 'give', source: 3, target: 4, amount: 1 },
      ],
    } as unknown as GameView;
    memory.rebelScore.set(4, 8);

    updateMemory(view, memory);
    expect(memory.rebelScore.get(2)).toBe(-2);
    expect(memory.rebelScore.get(3)).toBe(2);

    const brokeMemory = createAiMemory();
    const brokeView = {
      turnCount: 2,
      pending: null,
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null), player(3, null), player(4, null)],
      events: [
        { seq: 1, kind: 'give', source: 2, target: 1, amount: 1, brokeKongcheng: true },
        { seq: 2, kind: 'give', source: 3, target: 4, amount: 1, brokeKongcheng: true },
      ],
    } as unknown as GameView;
    brokeMemory.rebelScore.set(4, 8);

    updateMemory(brokeView, brokeMemory);
    expect(brokeMemory.rebelScore.get(2)).toBe(2);
    expect(brokeMemory.rebelScore.get(3)).toBe(-1);
  });

  it('仁德事件不因自己的給牌自我強化，且同回合有上限', () => {
    const memory = createAiMemory();
    const selfRequest: Request = {
      id: 1,
      player: 2,
      prompt: '出牌階段：請選擇行動',
      kind: 'action',
      options: [],
      context: '出牌階段',
    };
    const view = {
      turnCount: 3,
      pending: selfRequest,
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null)],
      events: [{ seq: 1, kind: 'give', source: 2, target: 1, amount: 2 }],
    } as unknown as GameView;
    updateMemory(view, memory);
    expect(memory.rebelScore.get(2)).toBeUndefined();

    const capMemory = createAiMemory();
    const capView = {
      turnCount: 4,
      pending: null,
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null)],
      events: Array.from({ length: 5 }, (_, index) => ({
        seq: index + 1,
        kind: 'give' as const,
        source: 2,
        target: 1,
        amount: 2,
      })),
    } as unknown as GameView;
    updateMemory(capView, capMemory);
    expect(capMemory.rebelScore.get(2)).toBe(-4);
  });

  it('高手難度會用信念選擇高嫌疑目標，新手忽略信念', () => {
    const state = createGame({ seed: 3 });
    const roles = ['loyal', 'lord', 'rebel', 'rebel', 'rebel'] as const;
    state.players.forEach((item, index) => {
      item.role = roles[index]!;
      item.alive = true;
      item.hand = [];
      item.hp = 4;
      item.maxHp = 4;
      item.equips = { weapon: null, armor: null, horsePlus: null, horseMinus: null };
      item.judgeZone = [];
    });

    const slash = (id: string, target: number): PlayOption => ({
      id,
      label: `殺 → ${target}`,
      kind: 'play',
      cards: [9000],
      targets: [target],
      asCard: 'slash',
    });
    const pass: PlayOption = { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] };
    const request = actionRequest(0, [slash('to2', 2), slash('to3', 3), pass]);
    state.pending = request;
    const view = viewFor(state, 0);

    const memory = createAiMemory();
    memory.rebelScore.set(3, 20);

    let hardPicksSuspicious = 0;
    let easyPicksSuspicious = 0;
    for (let rngState = 1; rngState <= 30; rngState += 1) {
      const hard = decide(view, request, { rngState }, memory, 'hard');
      if (hard.type === 'option' && hard.optionId === 'to3') hardPicksSuspicious += 1;
      const easy = decide(view, request, { rngState }, createAiMemory(), 'easy');
      if (easy.type === 'option' && easy.optionId === 'to3') easyPicksSuspicious += 1;
    }

    // 高手一定打高嫌疑目標；新手兩者分數相同，較不集中。
    expect(hardPicksSuspicious).toBe(30);
    expect(easyPicksSuspicious).toBeLessThan(30);
  });

  it('決策延遲在一般範圍內', () => {
    const state = createGame({ seed: 9 });
    const options: PlayOption[] = [
      { id: 'pass', label: '結束出牌階段', kind: 'pass', cards: [], targets: [] },
    ];
    const request = actionRequest(0, options);
    state.pending = request;
    const view = viewFor(state, 0);

    const memory = createAiMemory();
    const start = performance.now();
    for (let index = 0; index < 500; index += 1) {
      decide(view, request, { rngState: index + 1 }, memory, 'hard');
    }
    const perCall = (performance.now() - start) / 500;
    expect(perCall).toBeLessThan(50);
  });

  it('AI 視角不含其他玩家的手牌', () => {
    const state = createGame({ seed: 11 });
    const view = viewFor(state, 0);
    expect(view.players[0]!.hand).not.toBeNull();
    for (const other of view.players.slice(1)) {
      expect(other.hand).toBeNull();
    }
  });

  it('高手座位對新手座位有可測量的勝率優勢', () => {
    const layout = ['hard', 'hard', 'hard', 'easy', 'easy'] as const;
    let hardWins = 0;
    let hardTotal = 0;
    let easyWins = 0;
    let easyTotal = 0;

    for (let seed = 1; seed <= 2000; seed += 1) {
      const state = createGame({ seed });
      const generator = runGame(state);
      const rng = { rngState: (state.seed ^ 0x85ebca6b) >>> 0 || 1 };
      const memories = new Map<PlayerId, AiMemory>();
      let step = generator.next();
      while (!step.done) {
        const request: Request = step.value;
        let memory = memories.get(request.player);
        if (!memory) {
          memory = createAiMemory();
          memories.set(request.player, memory);
        }
        step = generator.next(
          decide(viewFor(state, request.player), request, rng, memory, layout[request.player]!),
        );
      }
      const winnerRoles = new Set(state.winner?.roles ?? []);
      if (winnerRoles.size === 0) continue;
      state.players.forEach((item, index) => {
        const won = winnerRoles.has(item.role);
        if (layout[index] === 'hard') {
          hardTotal += 1;
          if (won) hardWins += 1;
        } else {
          easyTotal += 1;
          if (won) easyWins += 1;
        }
      });
    }

    expect(hardWins / hardTotal).toBeGreaterThan(easyWins / easyTotal);
  }, 30_000);

  it('三個難度都能完成對局且不崩潰', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const result = autoPlayGame({ seed, difficulty, maxRequests: 400_000 });
        expect(result.winner.roles.length).toBeGreaterThan(0);
      }
    }
  });
});
