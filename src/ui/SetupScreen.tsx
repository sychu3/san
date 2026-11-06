import { useMemo, useState } from 'react';
import { ALL_GENERAL_IDS, getGeneral, KINGDOM_LABELS, ROLE_GOALS, ROLE_LABELS } from '../data/generals';
import { SKILL_META } from '../engine/skills';
import type { GeneralDef, Role } from '../engine/types';
import type { GameSetup } from '../game/setup';

interface Props {
  setup: GameSetup;
  onPick: (generalId: string) => void;
  /** 自訂模式：指定身份與任意武將後開始對局。 */
  onPickCustom?: (role: Role, generalId: string) => void;
  /** 自訂模式切換身份時重新產生預覽（主公座位／主公武將）。 */
  onPickRole?: (role: Role) => void;
  onLoadReplay?: () => void;
  onShowRules?: () => void;
}

const ROLES: readonly Role[] = ['lord', 'loyal', 'rebel', 'spy'];

const KINGDOM_CLASS: Record<string, string> = {
  wei: 'setup__general--wei',
  shu: 'setup__general--shu',
  wu: 'setup__general--wu',
  qun: 'setup__general--qun',
};

const SEAT_COUNT = 5;

/** 武將的公開資訊：勢力、名字、性別、體力上限、技能。 */
function GeneralFacts({ general, hpBonus = 0 }: { general: GeneralDef; hpBonus?: number }) {
  const maxHp = general.maxHp + hpBonus;
  return (
    <>
      <span className="setup__general-head">
        <span className="setup__kingdom">{KINGDOM_LABELS[general.kingdom] ?? general.kingdom}</span>
        <span className="setup__name">{general.name}</span>
      </span>
      <span className="setup__meta">
        <span>{general.gender === 'male' ? '男' : '女'}</span>
        <span className="setup__hp" aria-label={`體力上限 ${maxHp}`}>
          {Array.from({ length: maxHp }, (_, index) => (
            <span key={index} className="setup__hp-cell">
              ♥
            </span>
          ))}
          {hpBonus > 0 && <span className="setup__hp-bonus">主公 +1</span>}
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
    </>
  );
}

/**
 * 開局選將：身份已決定，玩家從三個隨機武將中選一個。
 * 比照原版，同時顯示主公的武將、主公與自己的座位，以及彼此距離。
 * 只顯示公開的武將資料，不涉及任何手牌或隱藏身份。
 */
export function SetupScreen({ setup, onPick, onPickCustom, onPickRole, onLoadReplay, onShowRules }: Props) {
  const roleLabel = ROLE_LABELS[setup.role] ?? setup.role;
  const isLord = setup.role === 'lord';
  const lordBonus = 1;
  const lordGeneral = setup.lordGeneralId ? getGeneral(setup.lordGeneralId) : null;
  const [customMode, setCustomMode] = useState(false);
  const [customRole, setCustomRole] = useState<Role>('lord');
  const [customGeneral, setCustomGeneral] = useState<string | null>(null);

  const selectableGenerals = useMemo(
    () => ALL_GENERAL_IDS.filter((id) => id !== setup.lordGeneralId),
    [setup.lordGeneralId],
  );
  const chosenGeneral =
    customGeneral && selectableGenerals.includes(customGeneral) ? customGeneral : null;

  const enterCustom = () => {
    setCustomMode(true);
    setCustomGeneral(null);
    setCustomRole('lord');
    onPickRole?.('lord');
  };
  const exitCustom = () => {
    setCustomMode(false);
    setCustomGeneral(null);
  };
  const chooseRole = (role: Role) => {
    setCustomRole(role);
    onPickRole?.(role);
  };

  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup__card">
        <p className="setup__eyebrow">你的身份</p>
        <h2 id="setup-title" className={`setup__role setup__role--${setup.role}`}>
          {roleLabel}
        </h2>
        <p className="setup__goal">{ROLE_GOALS[setup.role] ?? ''}</p>

        <div className="setup__board">
          <div className="setup__seats" aria-label="座位順序">
            {Array.from({ length: SEAT_COUNT }, (_, seat) => {
              const marks: string[] = [];
              if (seat === setup.lordSeat) marks.push('主公');
              if (seat === setup.humanSeat) marks.push('你');
              const classes = [
                'setup__seat',
                seat === setup.humanSeat ? 'setup__seat--self' : '',
                seat === setup.lordSeat ? 'setup__seat--lord' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <span key={seat} className={classes}>
                  <span className="setup__seat-num">{seat + 1}</span>
                  {marks.length > 0 && <span className="setup__seat-marks">{marks.join('・')}</span>}
                </span>
              );
            })}
          </div>
          <p className="setup__position">
            {isLord
              ? `你是主公（${setup.humanSeat + 1} 號位），由你先選武將；其他角色之後才會看到你的武將。`
              : `你是 ${setup.humanSeat + 1} 號位，主公在 ${setup.lordSeat + 1} 號位，彼此距離 ${setup.lordDistance}。`}
          </p>
        </div>

        {lordGeneral ? (
          <div className="setup__lord">
            <div className={`setup__general setup__general--static ${KINGDOM_CLASS[lordGeneral.kingdom] ?? ''}`}>
              <span className="setup__lord-tag">主公武將</span>
              <GeneralFacts general={lordGeneral} hpBonus={lordBonus} />
            </div>
            <p className="setup__lord-note">
              主公（{setup.lordSeat + 1} 號位）已先選定武將，你的候選不會與他重複。
            </p>
          </div>
        ) : (
          <p className="setup__lord-note setup__lord-note--self">你就是主公，先為自己選一位武將。</p>
        )}

        {customMode ? (
          <>
            <p className="setup__hint">自訂模式（測試用）：指定身份並從全部武將中任選一位</p>
            <div className="setup__roles">
              {ROLES.map((role) => (
                <button
                  key={role}
                  type="button"
                  className={`setup__role-btn ${customRole === role ? 'setup__role-btn--active' : ''}`}
                  onClick={() => chooseRole(role)}
                >
                  {ROLE_LABELS[role]}
                </button>
              ))}
            </div>
            <p className="setup__hint">選擇武將（{selectableGenerals.length} 名可選）</p>
            <div className="setup__generals setup__generals--all">
              {selectableGenerals.map((id) => {
                const general = getGeneral(id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={`setup__general ${KINGDOM_CLASS[general.kingdom] ?? ''} ${
                      chosenGeneral === id ? 'setup__general--chosen' : ''
                    }`}
                    onClick={() => setCustomGeneral(id)}
                  >
                    <GeneralFacts general={general} hpBonus={customRole === 'lord' ? lordBonus : 0} />
                    <span className="setup__pick">
                      {chosenGeneral === id ? '已選擇' : '選擇'} {general.name}
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="primary-btn setup__start"
              disabled={!chosenGeneral}
              onClick={() => chosenGeneral && onPickCustom?.(customRole, chosenGeneral)}
            >
              以「{ROLE_LABELS[customRole]}・{chosenGeneral ? getGeneral(chosenGeneral).name : '未選武將'}」開始
            </button>
          </>
        ) : (
          <>
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
                    <GeneralFacts general={general} hpBonus={isLord ? lordBonus : 0} />
                    <span className="setup__pick">選擇 {general.name}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <p className="setup__seed">seed {setup.seed}</p>

        <div className="setup__actions">
          {onShowRules && (
            <button type="button" className="ghost-btn" onClick={onShowRules}>
              規則
            </button>
          )}
          {onPickCustom &&
            (customMode ? (
              <button type="button" className="ghost-btn" onClick={exitCustom}>
                返回一般選將
              </button>
            ) : (
              <button type="button" className="ghost-btn" onClick={enterCustom}>
                自訂模式（測試主公技）
              </button>
            ))}
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
