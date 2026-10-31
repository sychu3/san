import { useEffect, useRef } from 'react';
import type { LogEntry, PlayerView } from '../engine/types';

interface Props {
  entries: LogEntry[];
  players?: PlayerView[];
}

const KIND_CLASS: Record<string, string> = {
  system: 'log__line--system',
  phase: 'log__line--phase',
  damage: 'log__line--damage',
  heal: 'log__line--heal',
  death: 'log__line--death',
  win: 'log__line--win',
  judge: 'log__line--judge',
};

const KINGDOM_CLASS: Record<string, string> = {
  wei: 'log__line--wei',
  shu: 'log__line--shu',
  wu: 'log__line--wu',
  qun: 'log__line--qun',
};

export function LogPanel({ entries, players = [] }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries]);

  return (
    <section className="panel log" aria-label="對局紀錄">
      <div className="panel__title">對局紀錄</div>
      <div className="log__body" ref={ref} role="log" aria-live="polite" aria-relevant="additions">
        {entries.map((entry) => {
          const isTurnHeader = entry.kind === 'phase' && entry.text.startsWith('──');
          const actor = players.find((player) => entry.text.startsWith(player.generalName));
          const kingdomClass = actor ? KINGDOM_CLASS[actor.kingdom] ?? '' : '';
          return (
            <p
              key={entry.seq}
              className={[
                'log__line',
                KIND_CLASS[entry.kind] ?? '',
                isTurnHeader ? 'log__line--turn' : '',
                kingdomClass,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {entry.text}
            </p>
          );
        })}
      </div>
    </section>
  );
}
