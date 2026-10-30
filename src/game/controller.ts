import type {
  Difficulty,
  GameResult,
  GameState,
  GameView,
  PlayerId,
  Request,
  Response,
} from '../engine/types';
import { createGame, viewFor, type CreateGameOptions } from '../engine/state';
import { runGame } from '../engine/engine';
import { createAiMemory, decide, type AiMemory } from '../ai/policy';
import type { RngState } from '../engine/rng';

/**
 * 遊戲驅動器：把 generator 引擎與 UI 連接起來。
 *
 * 安全設計：
 * - 人類只能看到自己的視角（除非開啟除錯用的上帝視角）。
 * - 回應必須帶有 request id，過期或偽造的回應會被拒絕。
 * - AI 只能取得自己的視角，不會讀到其他玩家的隱藏資訊。
 */
export class GameController {
  readonly humanId: PlayerId;
  readonly state: GameState;
  private readonly generator: Generator<Request, GameResult, Response>;
  private readonly aiRng: RngState;
  private readonly listeners = new Set<() => void>();
  private godMode = false;
  private result: GameResult | null = null;
  private snapshot: GameView;
  private lastHumanRequestId: number | null = null;
  private difficulty: Difficulty;
  private readonly aiMemory = new Map<PlayerId, AiMemory>();

  constructor(
    options: CreateGameOptions & { humanId?: PlayerId; godMode?: boolean; difficulty?: Difficulty } = {},
  ) {
    this.state = createGame(options);
    this.humanId = options.humanId ?? 0;
    if (!this.state.players[this.humanId]) {
      throw new Error(`Invalid human player id: ${this.humanId}`);
    }
    this.godMode = options.godMode ?? false;
    this.difficulty = options.difficulty ?? 'normal';
    this.aiRng = { rngState: (this.state.seed ^ 0x9e3779b9) >>> 0 || 1 };
    this.generator = runGame(this.state);
    this.snapshot = this.makeView();
    this.start();
  }

  getView(): GameView {
    return this.snapshot;
  }

  getResult(): GameResult | null {
    return this.result;
  }

  isGodMode(): boolean {
    return this.godMode;
  }

  getDifficulty(): Difficulty {
    return this.difficulty;
  }

  setDifficulty(difficulty: Difficulty): void {
    if (this.difficulty === difficulty) return;
    this.difficulty = difficulty;
    this.emit();
  }

  private memoryFor(player: PlayerId): AiMemory {
    let memory = this.aiMemory.get(player);
    if (!memory) {
      memory = createAiMemory();
      this.aiMemory.set(player, memory);
    }
    return memory;
  }

  setGodMode(enabled: boolean): void {
    if (this.godMode === enabled) return;
    this.godMode = enabled;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 人類玩家送出回應；必須符合目前等待中的請求。 */
  respond(requestId: number, response: Response): void {
    const pending = this.state.pending;
    if (
      !pending ||
      pending.id !== requestId ||
      pending.player !== this.humanId ||
      this.lastHumanRequestId !== requestId
    ) {
      throw new Error('拒絕過期或未授權的回應');
    }
    this.lastHumanRequestId = null;
    this.advance(response);
  }

  private start(): void {
    this.advance(undefined);
  }

  private advance(response: Response | undefined): void {
    const step = response === undefined ? this.generator.next() : this.generator.next(response);
    if (step.done) {
      this.result = step.value;
      this.snapshot = this.makeView();
      this.emit();
      return;
    }

    // 由 AI 接手，直到需要人類操作或遊戲結束。
    let request: Request | undefined = step.value;
    while (request) {
      if (request.player === this.humanId) {
        this.lastHumanRequestId = request.id;
        this.snapshot = this.makeView();
        this.emit();
        return;
      }

      const aiView = viewFor(this.state, request.player);
      let aiResponse: Response;
      try {
        aiResponse = decide(aiView, request, this.aiRng, this.memoryFor(request.player), this.difficulty);
      } catch {
        // AI 不應讓整局崩潰；遇到非預期狀態時採保守合法回應。
        aiResponse = fallbackResponse(request);
      }
      const next = this.generator.next(aiResponse);
      if (next.done) {
        this.result = next.value;
        this.snapshot = this.makeView();
        this.emit();
        return;
      }
      request = next.value;
    }
  }

  private makeView(): GameView {
    return viewFor(this.state, this.humanId, this.godMode);
  }

  private emit(): void {
    this.snapshot = this.makeView();
    for (const listener of this.listeners) listener();
  }
}

function fallbackResponse(request: Request): Response {
  switch (request.kind) {
    case 'action':
    case 'response': {
      const pass = request.options.find((option) => option.kind === 'pass') ?? request.options[0];
      return pass ? { type: 'option', optionId: pass.id } : { type: 'pass' };
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
