import type { Card, CardUse, GameState, PlayerId } from './types';

/**
 * M2 的時機系統。
 *
 * 引擎在固定位置發出事件；M2 只有內部記錄與測試 hook，M3 的武將技能會
 * 透過同一組時機註冊。事件 hook 不可直接改動其他角色的隱藏手牌。
 */
export type Timing =
  | 'beforeUseCard'
  | 'afterUseCard'
  | 'beforePlayCard'
  | 'afterPlayCard'
  | 'beforeDamage'
  | 'afterDamage'
  | 'beforeJudge'
  | 'afterJudge'
  | 'phaseStart'
  | 'phaseEnd'
  | 'dying'
  | 'death';

export interface EventContext {
  state: GameState;
  use?: CardUse;
  source?: PlayerId | null;
  target?: PlayerId;
  card?: Card | null;
  amount?: number;
  phase?: string;
}

export type Hook = (context: EventContext) => void;

const hooks: Record<Timing, Hook[]> = {
  beforeUseCard: [],
  afterUseCard: [],
  beforePlayCard: [],
  afterPlayCard: [],
  beforeDamage: [],
  afterDamage: [],
  beforeJudge: [],
  afterJudge: [],
  phaseStart: [],
  phaseEnd: [],
  dying: [],
  death: [],
};

/** 註冊 hook；回傳取消函式。M3 技能會使用這個入口。 */
export function onTiming(timing: Timing, hook: Hook): () => void {
  hooks[timing].push(hook);
  return () => {
    const index = hooks[timing].indexOf(hook);
    if (index >= 0) hooks[timing].splice(index, 1);
  };
}

export function emitTiming(timing: Timing, context: EventContext): void {
  for (const hook of hooks[timing]) hook(context);
}

export function clearTimingHooks(): void {
  for (const list of Object.values(hooks)) list.length = 0;
}
