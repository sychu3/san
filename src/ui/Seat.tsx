import type { Card, PlayerView } from '../engine/types';
import { KINGDOM_LABELS, ROLE_LABELS } from '../data/generals';
import { CardView } from './CardView';

interface Props {
  player: PlayerView;
  isTurn: boolean;
  isSelf: boolean;
  waiting: boolean;
  compact?: boolean;
}

const KINGDOM_CLASS: Record<string, string> = {
  wei: 'seat--wei',
  shu: 'seat--shu',
  wu: 'seat--wu',
  qun: 'seat--qun',
};

function equipsOf(player: PlayerView): Card[] {
  return [player.equips.weapon, player.equips.armor, player.equips.horsePlus, player.equips.horseMinus].filter(
    (card): card is Card => card !== null,
  );
}

export function Seat({ player, isTurn, isSelf, waiting, compact = false }: Props) {
  const roleText = player.role ? ROLE_LABELS[player.role] ?? player.role : '身份未知';
  const hpCells = Array.from({ length: player.maxHp }, (_, index) => index < player.hp);
  const equips = equipsOf(player);

  return (
    <div
      className={[
        'seat',
        KINGDOM_CLASS[player.kingdom] ?? '',
        isTurn ? 'seat--turn' : '',
        waiting ? 'seat--waiting' : '',
        !player.alive ? 'seat--dead' : '',
        isSelf ? 'seat--self' : '',
        compact ? 'seat--compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="seat__head">
        <span className="seat__kingdom">{KINGDOM_LABELS[player.kingdom] ?? player.kingdom}</span>
        <span className="seat__name">{player.generalName}</span>
        {isSelf && <span className="seat__you">你</span>}
        {player.role === 'lord' && <span className="seat__lord">主公</span>}
      </div>

      <div className="seat__meta">
        <span className={`seat__role ${player.role ? `seat__role--${player.role}` : ''}`}>{roleText}</span>
        <span className="seat__handcount" title="手牌數">
          🂠 {player.handCount}
        </span>
      </div>

      <div className="seat__hp" aria-label={`體力 ${player.hp}／${player.maxHp}`}>
        {hpCells.map((filled, index) => (
          <span key={index} className={filled ? 'hp hp--full' : 'hp hp--empty'} />
        ))}
        {player.maxHp === 0 && <span className="seat__hpnum">—</span>}
      </div>

      <div className="seat__state">
        {player.chained && <span className="tag tag--chain">鐵索</span>}
        {player.wine && <span className="tag tag--wine">酒意</span>}
        {player.slashUsed > 0 && <span className="tag">殺×{player.slashUsed}</span>}
        {!player.alive && <span className="tag tag--dead">陣亡</span>}
      </div>

      {!compact && equips.length > 0 && (
        <div className="seat__equips">
          {equips.map((card) => (
            <CardView key={card.id} card={card} compact />
          ))}
        </div>
      )}
    </div>
  );
}
