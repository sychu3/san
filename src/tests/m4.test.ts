import { describe, expect, it } from 'vitest';
import { createGame, viewFor } from '../engine/state';
import { runGame } from '../engine/engine';
import type { GameView, PlayOption, PlayerId, PlayerView, Request } from '../engine/types';
import { beliefProbs, beliefsFor, createAiMemory, decide, seedBeliefScore, updateMemory, type AiMemory } from '../ai/policy';
import { autoPlayGame } from '../game/autoplay';
import { GameController } from '../game/controller';

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

  it('updateMemory 依公開事件更新身份信念', () => {
    const memory = createAiMemory();
    const view = {
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null), player(3, null)],
      events: [
        { seq: 1, kind: 'damage', source: 2, target: 1, amount: 1, cardName: 'slash' },
        { seq: 2, kind: 'damage', source: 2, target: 1, amount: 1, cardName: 'slash' },
        { seq: 3, kind: 'save', source: 3, target: 1, cardName: 'peach' },
      ],
    } as unknown as GameView;

    updateMemory(view, memory);
    const self = view.players[0]!;
    // 連兩次對主公出【殺】→ 幾乎確定像反賊。
    expect(beliefProbs(view, self, memory, view.players[2]!).rebel).toBeGreaterThan(0.8);
    // 瀕死救主公 → 更像忠臣／內奸（此視角為忠臣，故落在內奸）。
    const p3 = beliefProbs(view, self, memory, view.players[3]!);
    expect(p3.spy + p3.loyal).toBeGreaterThan(p3.rebel);
  });

  it('仁德公開事件：給主公偏忠臣、給可疑反賊偏反賊、破空城反向', () => {
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
    seedBeliefScore(memory, 4, 8); // 玩家 4 行為上像反賊

    updateMemory(view, memory);
    expect(memory.belief.get(2)!.loyal).toBeGreaterThan(0);
    expect(memory.belief.get(2)!.rebel).toBeLessThan(0);
    expect(memory.belief.get(3)!.rebel).toBeGreaterThan(0);

    const brokeMemory = createAiMemory();
    const brokeView = {
      turnCount: 2,
      pending: null,
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null), player(3, null), player(4, null)],
      events: [{ seq: 1, kind: 'give', source: 2, target: 1, amount: 1, brokeKongcheng: true }],
    } as unknown as GameView;
    updateMemory(brokeView, brokeMemory);
    // 破壞主公空城是敵意，不該被當成給主公的信任證據。
    expect(brokeMemory.belief.get(2)!.loyal).toBeLessThan(0);
  });

  it('仁德事件不因自己的給牌自我強化，且同類證據有計次上限', () => {
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
    expect(memory.belief.get(2)).toBeUndefined();

    const build = (count: number): AiMemory => {
      const m = createAiMemory();
      const capView = {
        turnCount: 4,
        pending: null,
        players: [player(0, 'loyal'), player(1, 'lord'), player(2, null)],
        events: Array.from({ length: count }, (_, index) => ({
          seq: index + 1,
          kind: 'give' as const,
          source: 2,
          target: 1,
          amount: 2,
        })),
      } as unknown as GameView;
      updateMemory(capView, m);
      return m;
    };
    // 給主公牌累積成忠臣證據，但同類事件只計上限次數，之後不再增加。
    expect(build(3).belief.get(2)!.loyal).toBeGreaterThan(0);
    expect(build(12).belief.get(2)!.loyal).toBe(build(5).belief.get(2)!.loyal);
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
    seedBeliefScore(memory, 3, 20);

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

  it('公開事件：群體錦囊與治療主公都會影響信念，且同類證據有計次上限', () => {
    const memory = createAiMemory();
    const view = {
      turnCount: 1,
      pending: null,
      players: [player(0, 'loyal'), player(1, 'lord'), player(2, null), player(3, null), player(4, null)],
      events: [
        { seq: 1, kind: 'use', source: 2, target: 1, cardName: 'barbarian' },
        { seq: 2, kind: 'damage', source: 2, target: 1, cardName: 'arrows', amount: 1 },
        { seq: 3, kind: 'death', source: 2, target: 4, role: 'spy' },
        { seq: 4, kind: 'heal', source: 2, target: 1, skill: 'jieyin', amount: 1 },
        { seq: 5, kind: 'heal', source: 2, target: 1, skill: 'jieyin', amount: 1 },
        { seq: 6, kind: 'heal', source: 2, target: 1, skill: 'jieyin', amount: 1 },
      ],
    } as unknown as GameView;
    updateMemory(view, memory);

    // 各類事件各自累積：治療主公偏忠臣、群體錦囊掃到主公偏反賊。
    const acc = memory.beliefAcc.get(2)!;
    expect(acc.get('healLord')!.loyal).toBeGreaterThan(0);
    expect(acc.get('hostileGroupLord')!.rebel).toBeGreaterThan(0);
  });

  it('上帝視角 beliefsFor 提供每人判斷與最近原因', () => {
    const memory = createAiMemory();
    const view = {
      turnCount: 1,
      pending: null,
      players: [
        player(0, 'lord'),
        player(1, null),
        player(2, null),
        player(3, null),
        player(4, null),
      ],
      events: [
        { seq: 1, kind: 'damage', source: 2, target: 0, amount: 1, cardName: 'slash' },
        { seq: 2, kind: 'damage', source: 2, target: 0, amount: 1, cardName: 'slash' },
        { seq: 3, kind: 'heal', source: 3, target: 0, skill: 'jieyin', amount: 1 },
        { seq: 4, kind: 'heal', source: 3, target: 0, skill: 'jieyin', amount: 1 },
        { seq: 5, kind: 'heal', source: 4, target: 0, skill: 'jieyin', amount: 1 },
        { seq: 6, kind: 'heal', source: 4, target: 0, skill: 'jieyin', amount: 1 },
        { seq: 7, kind: 'save', source: 4, target: 0, cardName: 'peach' },
      ],
    } as unknown as GameView;
    updateMemory(view, memory, 0);

    const belief = beliefsFor(view, memory, 0);
    expect(belief.observer).toBe(0);
    expect(belief.cells).toHaveLength(5);
    expect(belief.cells.find((cell) => cell.target === 0)!.relation).toBe('ally');
    expect(belief.cells.find((cell) => cell.target === 2)!.relation).toBe('enemy');
    // 兩次治療還不足以成為隊友。
    expect(belief.cells.find((cell) => cell.target === 3)!.relation).toBe('unknown');
    // 治療加上瀕死救援累積足夠，可成為隊友。
    const healer = belief.cells.find((cell) => cell.target === 4)!;
    expect(healer.relation).toBe('ally');
    expect(healer.notes.some((note) => note.text.includes('救助主公'))).toBe(true);
  });

  it('只有上帝視角會提供 AI 信念', () => {
    const off = new GameController({ seed: 3, humanId: 0, godMode: false });
    expect(off.getBeliefs()).toEqual([]);

    const on = new GameController({ seed: 3, humanId: 0, godMode: true });
    const beliefs = on.getBeliefs();
    expect(beliefs.length).toBeGreaterThan(0);
    for (const observer of beliefs) {
      expect(observer.cells).toHaveLength(5);
    }
  });
});
