import { useState } from 'react';
import type { GameView, PlayerId } from '../engine/types';
import type { BeliefCell, ObserverBelief } from '../ai/policy';
import { ROLE_LABELS } from '../data/generals';

interface Props {
  view: GameView;
  beliefs: ObserverBelief[];
  humanId: PlayerId;
}

interface Selection {
  observer: PlayerId;
  target: PlayerId;
}

const RELATION_LABELS: Record<string, string> = {
  ally: '友',
  enemy: '敵',
  unknown: '?',
};

function scoreText(score: number): string {
  if (score > 0) return `+${score}`;
  return `${score}`;
}

function notesTitle(observer: string, target: string, cell: BeliefCell): string {
  const lines = [`${observer} → ${target}：${RELATION_LABELS[cell.relation]}（${scoreText(cell.score)}）`];
  if (cell.knownRole) lines.push(`已公開身份：${ROLE_LABELS[cell.knownRole] ?? cell.knownRole}`);
  if (cell.notes.length > 0) {
    lines.push('最近原因：');
    for (const note of cell.notes) {
      lines.push(`　${note.delta > 0 ? `+${note.delta}` : note.delta} ${note.text}`);
    }
  }
  return lines.join('\n');
}

function defaultSelection(
  beliefs: ObserverBelief[],
  humanId: PlayerId,
  lordId: PlayerId | null,
): Selection | null {
  const lordBelief = beliefs.find((item) => item.observer === lordId);
  if (lordBelief?.cells.some((cell) => cell.target === humanId)) {
    return { observer: lordId!, target: humanId };
  }
  const withHuman = beliefs.find((item) => item.cells.some((cell) => cell.target === humanId));
  if (withHuman) return { observer: withHuman.observer, target: humanId };
  const first = beliefs[0];
  if (!first) return null;
  const cell = first.cells.find((item) => item.target !== first.observer);
  return cell ? { observer: first.observer, target: cell.target } : null;
}

export function BeliefPanel({ view, beliefs, humanId }: Props) {
  const lordId = view.players.find((player) => player.role === 'lord')?.id ?? null;
  const fallback = defaultSelection(beliefs, humanId, lordId);
  const [picked, setPicked] = useState<Selection | null>(null);
  const validPicked =
    picked && beliefs.some((item) => item.observer === picked.observer) ? picked : null;
  const selection = validPicked ?? fallback;

  const selectedCell =
    selection === null
      ? null
      : beliefs
          .find((item) => item.observer === selection.observer)
          ?.cells.find((cell) => cell.target === selection.target) ?? null;

  return (
    <section className="beliefs" aria-label="AI 身份推理">
      <div className="beliefs__head">
        <span className="beliefs__title">AI 身份推理</span>
        <span className="beliefs__hint">
          數字＝公開事件推得的「像反賊」程度（−20～+20）；敵／友是各 AI 目前的判斷
        </span>
      </div>

      <div className="beliefs__scroll">
        <table className="beliefs__table">
          <thead>
            <tr>
              <th scope="col">觀察者</th>
              {view.players.map((player) => (
                <th
                  key={player.id}
                  scope="col"
                  className={player.id === humanId ? 'beliefs__col--human' : ''}
                >
                  {player.generalName}
                  {player.id === humanId ? '（你）' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {beliefs.map((observerBelief) => {
              const observer = view.players[observerBelief.observer];
              if (!observer) return null;
              return (
                <tr key={observerBelief.observer}>
                  <th scope="row" className="beliefs__observer">
                    <span className={`seat__role seat__role--${observer.role ?? ''}`}>
                      {observer.role ? ROLE_LABELS[observer.role] ?? observer.role : '?'}
                    </span>
                    <span className="beliefs__observer-name">{observer.generalName}</span>
                  </th>
                  {observerBelief.cells.map((cell) => {
                    const isSelf = cell.target === cell.observer;
                    const isSelected =
                      selection?.observer === cell.observer && selection?.target === cell.target;
                    const target = view.players[cell.target];
                    const classes = [
                      'beliefs__cell',
                      `beliefs__cell--${cell.relation}`,
                      isSelf ? 'beliefs__cell--self' : '',
                      isSelected ? 'beliefs__cell--selected' : '',
                      cell.target === humanId ? 'beliefs__col--human' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <td
                        key={cell.target}
                        className={classes}
                        title={
                          isSelf
                            ? '自己'
                            : notesTitle(observer.generalName, target?.generalName ?? `玩家${cell.target + 1}`, cell)
                        }
                        onClick={
                          isSelf
                            ? undefined
                            : () => setPicked({ observer: cell.observer, target: cell.target })
                        }
                      >
                        {isSelf ? (
                          <span className="beliefs__self">—</span>
                        ) : (
                          <>
                            <span className="beliefs__relation">
                              {RELATION_LABELS[cell.relation] ?? '?'}
                            </span>
                            <span className="beliefs__score">{scoreText(cell.score)}</span>
                            {cell.knownRole && (
                              <span className="beliefs__known">
                                {ROLE_LABELS[cell.knownRole] ?? cell.knownRole}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selection && selectedCell && (
        <div className="beliefs__detail">
          <p className="beliefs__detail-title">
            {view.players[selection.observer]?.generalName ?? `玩家${selection.observer + 1}`} 對{' '}
            {view.players[selection.target]?.generalName ?? `玩家${selection.target + 1}`} 的判斷：
            <strong>
              {RELATION_LABELS[selectedCell.relation] ?? '?'}（{scoreText(selectedCell.score)}）
            </strong>
          </p>
          {selectedCell.notes.length > 0 ? (
            <ul className="beliefs__notes">
              {[...selectedCell.notes].reverse().map((note) => (
                <li key={note.seq}>
                  <span
                    className={
                      note.delta > 0
                        ? 'beliefs__delta beliefs__delta--up'
                        : 'beliefs__delta beliefs__delta--down'
                    }
                  >
                    {note.delta > 0 ? `+${note.delta}` : note.delta}
                  </span>
                  <span>{note.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="beliefs__notes-empty">目前沒有可顯示的公開事件。</p>
          )}
        </div>
      )}
    </section>
  );
}
