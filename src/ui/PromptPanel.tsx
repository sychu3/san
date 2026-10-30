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
