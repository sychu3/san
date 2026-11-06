import { useEffect, useState } from 'react';
import type { Card, GameView, PlayerId, Request, Response } from '../engine/types';
import { cardLabel, isSlashCard } from '../data/cardMeta';
import { rankLabel, suitSymbol } from '../engine/engine';
import { CardView } from './CardView';

interface Props {
  view: GameView;
  request: Request;
  humanId: PlayerId;
  selectedCards: number[];
  selectedPlayers: PlayerId[];
  onTogglePlayer: (id: PlayerId) => void;
  onToggleCard: (id: number) => void;
  onRespond: (response: Response) => void;
}

function findVisibleCard(view: GameView, targetId: PlayerId, cardId: number): Card | null {
  const target = view.players[targetId];
  if (!target) return null;
  const equips = [target.equips.weapon, target.equips.armor, target.equips.horsePlus, target.equips.horseMinus];
  for (const card of equips) {
    if (card && card.id === cardId) return card;
  }
  return target.judgeZone.find((card) => card.id === cardId) ?? null;
}

export function PromptPanel({
  view,
  request,
  humanId,
  selectedCards,
  selectedPlayers,
  onTogglePlayer,
  onToggleCard,
  onRespond,
}: Props) {
  const self = view.players[humanId];
  const orderRequestId = request.kind === 'orderCards' ? request.id : null;
  const allowBottom = request.kind === 'orderCards' && request.allowBottom === true;
  const [topOrder, setTopOrder] = useState<number[]>(() =>
    request.kind === 'orderCards' ? request.cards.map((card) => card.id) : [],
  );
  const [bottomOrder, setBottomOrder] = useState<number[]>([]);

  useEffect(() => {
    if (orderRequestId === null) return;
    if (request.kind === 'orderCards') {
      setTopOrder(request.cards.map((card) => card.id));
      setBottomOrder([]);
    }
    // 只在請求 id 改變時重置順序。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderRequestId]);

  const moveWithin = (index: number, delta: number, toBottom: boolean) => {
    const move = (current: number[]) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    };
    if (toBottom) setBottomOrder(move);
    else setTopOrder(move);
  };

  const sendToBottom = (id: number) => {
    setTopOrder((current) => current.filter((item) => item !== id));
    setBottomOrder((current) => [...current, id]);
  };

  const sendToTop = (id: number) => {
    setBottomOrder((current) => current.filter((item) => item !== id));
    setTopOrder((current) => [...current, id]);
  };

  const actionOptions = request.kind === 'action' ? request.options.filter((option) => option.kind !== 'pass') : [];
  const passOption = request.kind === 'action' ? request.options.find((option) => option.kind === 'pass') : undefined;
  const slashHeld = self?.hand?.some((card) => isSlashCard(card.name)) ?? false;
  const slashLocked =
    request.kind === 'action' &&
    Boolean(self) &&
    slashHeld &&
    self!.slashUsed >= 1 &&
    self!.equips.weapon?.name !== 'crossbow' &&
    !self!.skills.includes('paoxiao');

  return (
    <section className="panel prompt" aria-live="polite">
      <div className="prompt__head">
        <span className="panel__title">行動</span>
        <span className="prompt__context">{request.kind === 'action' ? request.context : request.prompt}</span>
      </div>

      {request.kind === 'action' && (
        <>
          <p className="prompt__hint">{request.prompt}</p>
          {slashLocked && (
            <p className="prompt__warn">
              本回合已使用【殺】，每回合限一次；裝備【諸葛連弩】或擁有【咆哮】可解除限制。仍可使用其他牌或結束出牌階段。
            </p>
          )}
          {actionOptions.length > 6 && (
            <p className="prompt__small prompt__small--scroll">行動較多，可捲動清單查看全部選項。</p>
          )}
          <div className="option-grid option-grid--actions">
            {actionOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className="option"
                onClick={() => onRespond({ type: 'option', optionId: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
          {passOption && (
            <button
              type="button"
              className="option option--pass option--endturn"
              onClick={() => onRespond({ type: 'option', optionId: passOption.id })}
            >
              {passOption.label}
            </button>
          )}
        </>
      )}

      {request.kind === 'response' && (
        <>
          <p className="prompt__hint">{request.prompt}</p>
          <div className="option-grid">
            {request.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`option ${option.kind === 'pass' ? 'option--pass' : ''}`}
                onClick={() => onRespond({ type: 'option', optionId: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}

      {request.kind === 'chooseCards' && (
        <>
          <p className="prompt__hint">
            {request.prompt}（已選 {selectedCards.length}／{request.max} 張）
          </p>
          <p className="prompt__small">
            請從下方手牌中點選，需選 {request.min}
            {request.max !== request.min ? `–${request.max}` : ''} 張。
          </p>
          <button
            type="button"
            className="option option--confirm"
            disabled={selectedCards.length < request.min || selectedCards.length > request.max}
            onClick={() => onRespond({ type: 'cards', cards: selectedCards })}
          >
            確認選擇
          </button>
        </>
      )}

      {request.kind === 'chooseCard' && (
        <>
          <p className="prompt__hint">{request.prompt}</p>
          <div className="option-grid">
            {request.cards.map((cardId) => {
              const card = findVisibleCard(view, request.target, cardId);
              if (!card) return null;
              return (
                <button
                  key={cardId}
                  type="button"
                  className="option option--card"
                  onClick={() => onRespond({ type: 'card', card: cardId })}
                >
                  <CardView card={card} compact />
                  <span>{cardLabel(card.name)}</span>
                </button>
              );
            })}
            {request.allowRandomHand && (
              <button
                type="button"
                className="option option--random"
                onClick={() => onRespond({ type: 'card', card: -1 })}
              >
                盲選手牌（{request.handCount} 張）
              </button>
            )}
          </div>
        </>
      )}

      {request.kind === 'chooseRevealed' && (
        <>
          <p className="prompt__hint">{request.prompt}</p>
          <div className="option-grid">
            {request.cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="option option--card"
                onClick={() => onRespond({ type: 'card', card: card.id })}
              >
                <CardView card={card} compact />
                <span>
                  {cardLabel(card.name)} {suitSymbol(card.suit)}
                  {rankLabel(card.rank)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {request.kind === 'chooseFrom' && (
        <>
          <p className="prompt__hint">
            {request.prompt}（已選 {selectedCards.length}／{request.max} 張）
          </p>
          <div className="option-grid">
            {request.cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className={`option option--card ${selectedCards.includes(card.id) ? 'option--selected' : ''}`}
                onClick={() => onToggleCard(card.id)}
              >
                <CardView card={card} compact />
                <span>
                  {cardLabel(card.name)} {suitSymbol(card.suit)}
                  {rankLabel(card.rank)}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="option option--confirm"
              disabled={selectedCards.length < request.min || selectedCards.length > request.max}
              onClick={() => onRespond({ type: 'cards', cards: selectedCards })}
            >
              確認選擇
            </button>
          </div>
        </>
      )}

      {request.kind === 'orderCards' && (
        <>
          <p className="prompt__hint">{request.prompt}</p>
          <p className="prompt__small">
            牌堆頂由上到下＝先摸到後摸；判定階段會先抽最上面的牌。用箭頭調整順序。
          </p>
          <div className="option-grid option-grid--orders">
            {topOrder.map((id, index) => {
              const card = request.cards.find((item) => item.id === id);
              if (!card) return null;
              return (
                <div key={id} className="option option--card option--order">
                  <CardView card={card} compact />
                  <span>
                    {index + 1}. {cardLabel(card.name)} {suitSymbol(card.suit)}
                    {rankLabel(card.rank)}
                  </span>
                  <span className="order-buttons">
                    <button
                      type="button"
                      className="option option--order-move"
                      disabled={index === 0}
                      onClick={() => moveWithin(index, -1, false)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="option option--order-move"
                      disabled={index === topOrder.length - 1}
                      onClick={() => moveWithin(index, 1, false)}
                    >
                      ↓
                    </button>
                    {allowBottom && (
                      <button
                        type="button"
                        className="option option--order-move"
                        onClick={() => sendToBottom(id)}
                      >
                        到堆底
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {allowBottom && bottomOrder.length > 0 && (
            <>
              <p className="prompt__small">牌堆底（最後才會再摸到；不會進入判定）。</p>
              <div className="option-grid option-grid--orders">
                {bottomOrder.map((id, index) => {
                  const card = request.cards.find((item) => item.id === id);
                  if (!card) return null;
                  return (
                    <div key={id} className="option option--card option--order">
                      <CardView card={card} compact />
                      <span>
                        {cardLabel(card.name)} {suitSymbol(card.suit)}
                        {rankLabel(card.rank)}
                      </span>
                      <span className="order-buttons">
                        <button
                          type="button"
                          className="option option--order-move"
                          disabled={index === 0}
                          onClick={() => moveWithin(index, -1, true)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="option option--order-move"
                          disabled={index === bottomOrder.length - 1}
                          onClick={() => moveWithin(index, 1, true)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="option option--order-move"
                          onClick={() => sendToTop(id)}
                        >
                          放回堆頂
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <button
            type="button"
            className="option option--confirm"
            onClick={() =>
              onRespond({
                type: 'cards',
                cards: topOrder,
                ...(bottomOrder.length > 0 ? { bottom: bottomOrder } : {}),
              })
            }
          >
            確認順序
          </button>
        </>
      )}

      {request.kind === 'choosePlayers' && (
        <>
          <p className="prompt__hint">
            {request.prompt}（已選 {selectedPlayers.length}／{request.max} 名）
          </p>
          <div className="option-grid">
            {request.candidates.map((id) => {
              const player = view.players[id];
              if (!player) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className={`option ${selectedPlayers.includes(id) ? 'option--selected' : ''}`}
                  onClick={() => onTogglePlayer(id)}
                >
                  {player.generalName}
                </button>
              );
            })}
            <button
              type="button"
              className="option option--confirm"
              disabled={selectedPlayers.length < request.min || selectedPlayers.length > request.max}
              onClick={() => onRespond({ type: 'players', players: selectedPlayers })}
            >
              確認選擇
            </button>
          </div>
        </>
      )}

      {self && (
        <p className="prompt__small">
          你的身份：{self.role === 'lord' ? '主公' : self.role === 'loyal' ? '忠臣' : self.role === 'rebel' ? '反賊' : '內奸'}
        </p>
      )}
    </section>
  );
}
