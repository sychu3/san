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
import { AI_RNG_XOR, createSaveFile, type SaveFile, type SavedResponse } from './save';

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
  private readonly responses: SavedResponse[] = [];
  private stepMode: boolean;
  private pausedRequest: Request | null = null;

  constructor(
    options: CreateGameOptions & {
      humanId?: PlayerId;
      godMode?: boolean;
      difficulty?: Difficulty;
      /** 逐步模式：AI 每次出牌前暫停，等玩家確認。 */
      stepMode?: boolean;
    } = {},
  ) {
    this.humanId = options.humanId ?? 0;
    this.state = createGame({ ...options, humanId: this.humanId });
    if (!this.state.players[this.humanId]) {
      throw new Error(`Invalid human player id: ${this.humanId}`);
    }
    this.godMode = options.godMode ?? false;
    this.difficulty = options.difficulty ?? 'normal';
    this.stepMode = options.stepMode ?? false;
    this.aiRng = { rngState: (this.state.seed ^ AI_RNG_XOR) >>> 0 || 1 };
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

  isStepMode(): boolean {
    return this.stepMode;
  }

  setStepMode(enabled: boolean): void {
    if (this.stepMode === enabled) return;
    this.stepMode = enabled;
    if (!enabled && this.pausedRequest) {
      this.resumeStep();
      return;
    }
    this.emit();
  }

  /** 是否正停在 AI 行動前，等待玩家按「繼續」。 */
  isWaitingStep(): boolean {
    return this.pausedRequest !== null;
  }

  /**
   * 等待確認時的公開資訊（誰要行動、要做什麼）。
   * 只回傳提示文字，不含該 AI 的手牌或選項內容。
   */
  getWaitingStepInfo(): { player: PlayerId; prompt: string } | null {
    if (!this.pausedRequest) return null;
    return { player: this.pausedRequest.player, prompt: this.pausedRequest.prompt };
  }

  /** 繼續逐步模式：讓目前等待中的 AI 進行一次行動。 */
  resumeStep(): void {
    const request = this.pausedRequest;
    if (!request) return;
    this.pausedRequest = null;
    const next = this.generator.next(this.aiResponseFor(request));
    this.pump(next);
  }

  private aiResponseFor(request: Request): Response {
    try {
      return decide(
        viewFor(this.state, request.player),
        request,
        this.aiRng,
        this.memoryFor(request.player),
        this.difficulty,
      );
    } catch {
      // AI 不應讓整局崩潰；遇到非預期狀態時採保守合法回應。
      return fallbackResponse(request);
    }
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
    this.responses.push({ requestId, response });
    this.advance(response);
  }

  /** 目前為止的人類回應；可序列化為存檔。 */
  getResponses(): readonly SavedResponse[] {
    return this.responses;
  }

  getSaveFile(): SaveFile {
    return createSaveFile({
      seed: this.state.seed,
      humanId: this.humanId,
      difficulty: this.difficulty,
      responses: [...this.responses],
      humanGeneralId: this.state.players[this.humanId]?.generalId,
    });
  }

  private start(): void {
    this.pump(this.generator.next());
  }

  private advance(response: Response | undefined): void {
    this.pump(response === undefined ? this.generator.next() : this.generator.next(response));
  }

  /** 由 AI 接手，直到需要人類操作、逐步模式暫停，或遊戲結束。 */
  private pump(initial: IteratorResult<Request, GameResult>): void {
    if (initial.done) {
      this.result = initial.value;
      this.snapshot = this.makeView();
      this.emit();
      return;
    }

    let request: Request | undefined = initial.value;
    while (request) {
      if (request.player === this.humanId) {
        this.lastHumanRequestId = request.id;
        this.snapshot = this.makeView();
        this.emit();
        return;
      }

      // 逐步模式：AI 每次選擇行動前暫停。
      if (this.stepMode && request.kind === 'action') {
        this.pausedRequest = request;
        this.snapshot = this.makeView();
        this.emit();
        return;
      }

      const next = this.generator.next(this.aiResponseFor(request));
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
