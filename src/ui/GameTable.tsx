import type { GameView, PlayerId } from '../engine/types';
import { CardView } from './CardView';
import { Seat } from './Seat';

interface Props {
  view: GameView;
  humanId: PlayerId;
  /** 最近受到傷害的玩家；用於閃動提示。 */
  hitId?: PlayerId | null;
}

const PHASE_LABELS: Record<string, string> = {
  prepare: '準備階段',
  judge: '判定階段',
  draw: '摸牌階段',
  play: '出牌階段',
  discard: '棄牌階段',
  end: '結束階段',
};

const REL_CLASS = ['self', 'next', 'top-right', 'top-left', 'prev'] as const;

export function GameTable({ view, humanId, hitId = null }: Props) {
  const turnPlayer = view.players[view.turn];
  const waitingFor = view.waitingFor;

  return (
    <section className={`table ${view.winner ? 'table--over' : ''}`} aria-label="牌桌">
      <div className="table__felt" />

      {view.players.map((player) => {
        const relative = (player.id - humanId + view.players.length) % view.players.length;
        return (
          <div key={player.id} className={`table__seat table__seat--${REL_CLASS[relative]}`}>
            <Seat
              player={player}
              isTurn={view.turn === player.id && !view.winner}
              isSelf={player.id === humanId}
              waiting={waitingFor === player.id}
              compact={relative !== 0}
              hit={hitId === player.id}
            />
          </div>
        );
      })}

      <div className="table__center">
        <div className="table__turn">
          {view.winner ? '對局結束' : turnPlayer ? `${turnPlayer.generalName} 的回合` : ''}
        </div>
        <div className="table__phase">{PHASE_LABELS[view.phase] ?? view.phase}</div>
        <div className="table__piles">
          <span className="table__pile">牌堆 {view.deckCount}</span>
          <span className="table__pile">棄牌 {view.discardCount}</span>
        </div>
        {view.discardTop && (
          <div className="table__discard">
            <span className="table__discard-label">棄牌堆頂</span>
            <CardView card={view.discardTop} compact />
          </div>
        )}
      </div>
    </section>
  );
}
