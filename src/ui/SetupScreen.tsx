import { getGeneral, KINGDOM_LABELS, ROLE_GOALS, ROLE_LABELS } from '../data/generals';
import { SKILL_META } from '../engine/skills';
import type { GameSetup } from '../game/setup';

interface Props {
  setup: GameSetup;
  onPick: (generalId: string) => void;
  onLoadReplay?: () => void;
  onShowRules?: () => void;
}

const KINGDOM_CLASS: Record<string, string> = {
  wei: 'setup__general--wei',
  shu: 'setup__general--shu',
  wu: 'setup__general--wu',
  qun: 'setup__general--qun',
};

function hpCells(maxHp: number): string[] {
  return Array.from({ length: maxHp }, () => '♥');
}

/**
 * 開局選將：身份已決定，玩家從三個隨機武將中選一個。
 * 只顯示公開的武將資料，不涉及任何手牌或隱藏資訊。
 */
export function SetupScreen({ setup, onPick, onLoadReplay, onShowRules }: Props) {
  const roleLabel = ROLE_LABELS[setup.role] ?? setup.role;

  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup__card">
        <p className="setup__eyebrow">你的身份</p>
        <h2 id="setup-title" className={`setup__role setup__role--${setup.role}`}>
          {roleLabel}
        </h2>
        <p className="setup__goal">{ROLE_GOALS[setup.role] ?? ''}</p>

        <p className="setup__hint">從以下三名武將中選擇一位（3 選 1）</p>

        <div className="setup__generals">
          {setup.candidates.map((id, index) => {
            const general = getGeneral(id);
            return (
              <button
                key={id}
                type="button"
                className={`setup__general ${KINGDOM_CLASS[general.kingdom] ?? ''}`}
                onClick={() => onPick(id)}
                autoFocus={index === 0}
              >
                <span className="setup__general-head">
                  <span className="setup__kingdom">{KINGDOM_LABELS[general.kingdom] ?? general.kingdom}</span>
                  <span className="setup__name">{general.name}</span>
                </span>
                <span className="setup__meta">
                  <span>{general.gender === 'male' ? '男' : '女'}</span>
                  <span className="setup__hp" aria-label={`體力上限 ${general.maxHp}`}>
                    {hpCells(general.maxHp).map((cell, cellIndex) => (
                      <span key={cellIndex} className="setup__hp-cell">
                        {cell}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="setup__skills">
                  {general.skills.length === 0 && <span className="setup__skill setup__skill--none">無技能</span>}
                  {general.skills.map((skillId) => (
                    <span
                      key={skillId}
                      className="setup__skill"
                      title={`${SKILL_META[skillId]?.name ?? skillId}：${SKILL_META[skillId]?.description ?? ''}`}
                    >
                      {SKILL_META[skillId]?.name ?? skillId}
                    </span>
                  ))}
                </span>
                <span className="setup__pick">選擇 {general.name}</span>
              </button>
            );
          })}
        </div>

        <p className="setup__seed">seed {setup.seed}</p>

        <div className="setup__actions">
          {onShowRules && (
            <button type="button" className="ghost-btn" onClick={onShowRules}>
              規則
            </button>
          )}
          {onLoadReplay && (
            <button type="button" className="ghost-btn" onClick={onLoadReplay}>
              讀檔重播
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
