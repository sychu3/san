import { useEffect, useRef } from 'react';
import type { LogEntry } from '../engine/types';

interface Props {
  entries: LogEntry[];
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

export function LogPanel({ entries }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries]);

  return (
    <section className="panel log" aria-label="對局紀錄">
      <div className="panel__title">對局紀錄</div>
      <div className="log__body" ref={ref} role="log" aria-live="polite" aria-relevant="additions">
        {entries.map((entry) => (
          <p key={entry.seq} className={`log__line ${KIND_CLASS[entry.kind] ?? ''}`}>
            {entry.text}
          </p>
        ))}
      </div>
    </section>
  );
}
