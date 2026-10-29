import type { Card } from '../engine/types';
import { cardLabel } from '../data/cardMeta';
import { rankLabel, suitSymbol } from '../engine/engine';

interface Props {
  card: Card;
  selected?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onClick?: () => void;
  title?: string;
}

const SUIT_COLOR: Record<Card['suit'], 'red' | 'black'> = {
  heart: 'red',
  diamond: 'red',
  spade: 'black',
  club: 'black',
};

export function CardView({ card, selected = false, disabled = false, compact = false, onClick, title }: Props) {
  const color = SUIT_COLOR[card.suit];
  const className = [
    'card',
    compact ? 'card--compact' : '',
    selected ? 'card--selected' : '',
    disabled ? 'card--disabled' : '',
    `card--${color}`,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <span className="card__corner">
        <span className="card__rank">{rankLabel(card.rank)}</span>
        <span className="card__suit">{suitSymbol(card.suit)}</span>
      </span>
      <span className="card__label">{cardLabel(card.name)}</span>
      <span className="card__suit card__suit--large">{suitSymbol(card.suit)}</span>
    </>
  );

  if (!onClick) {
    return (
      <span className={className} title={title ?? cardLabel(card.name)}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      title={title ?? cardLabel(card.name)}
      aria-pressed={selected}
    >
      {content}
    </button>
  );
}
