import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlayerId, Response } from './engine/types';
import { winnerText } from './engine/state';
import { randomSeed } from './engine/rng';
import { ROLE_LABELS } from './data/generals';
import { GameController } from './game/controller';
import { GameTable } from './ui/GameTable';
import { PromptPanel } from './ui/PromptPanel';
import { LogPanel } from './ui/LogPanel';
import { CardView } from './ui/CardView';

const ROLE_GOAL: Record<string, string> = {
  lord: '消滅所有反賊與內奸。誤殺忠臣會棄置所有牌。',
  loyal: '保護主公，協助主公消滅反賊與內奸。',
  rebel: '擊殺主公。主公死亡且場上仍有反賊時，反賊勝。',
  spy: '先協助主公清除反賊，最後成為場上唯一存活者。',
};

export default function App() {
  const [controller, setController] = useState(() => new GameController());
  const [view, setView] = useState(() => controller.getView());
  const [selectedCards, setSelectedCards] = useState<number[]>([]);
  const [selectedPlayers, setSelectedPlayers] = useState<PlayerId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setView(controller.getView()));
    return unsubscribe;
  }, [controller]);

  const pending = view.pending;
  const pendingId = pending?.id ?? null;

  useEffect(() => {
    setSelectedCards([]);
    setSelectedPlayers([]);
  }, [pendingId]);

  const human = view.players[controller.humanId];
  const hand = human?.hand ?? [];
  const selectableCards = useMemo(() => {
    if (pending?.kind === 'chooseCards') return new Set(pending.cards);
    if (pending?.kind === 'chooseFrom') return new Set(pending.cards.map((card) => card.id));
    return new Set<number>();
  }, [pending]);

  const send = useCallback(
    (response: Response) => {
      const current = controller.getView().pending;
      if (!current) return;
      try {
        controller.respond(current.id, response);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失敗');
      }
    },
    [controller],
  );

  const toggleCard = (id: number) => {
    if ((pending?.kind !== 'chooseCards' && pending?.kind !== 'chooseFrom') || !selectableCards.has(id)) {
      return;
    }
    setSelectedCards((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= pending.max) return current;
      return [...current, id];
    });
  };

  const togglePlayer = (id: PlayerId) => {
    if (pending?.kind !== 'choosePlayers') return;
    setSelectedPlayers((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= pending.max) return current;
      return [...current, id];
    });
  };

  const restart = () => {
    const next = new GameController({ seed: randomSeed() });
    setController(next);
    setView(next.getView());
    setSelectedCards([]);
    setSelectedPlayers([]);
    setError(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>三國殺</h1>
          <span className="topbar__subtitle">軍爭篇・五人身份局</span>
          <span className="topbar__unofficial">非官方同人實作</span>
        </div>
        <div className="topbar__actions">
          <span className="topbar__seed" title="本局隨機種子">
            seed {view.seed}
          </span>
          <button
            type="button"
            className={`ghost-btn ${view.godMode ? 'ghost-btn--on' : ''}`}
            onClick={() => controller.setGodMode(!view.godMode)}
            title="除錯用：顯示所有身份"
          >
            上帝視角
          </button>
          <button type="button" className="ghost-btn" onClick={() => setShowHelp(true)}>
            規則
          </button>
          <button type="button" className="primary-btn" onClick={restart}>
            新局
          </button>
        </div>
      </header>

      <main className="layout">
        <div className="board">
          <GameTable view={view} humanId={controller.humanId} />

          <section className="hand" aria-label="你的手牌">
            <div className="hand__head">
              <span className="hand__title">你的手牌</span>
              <span className="hand__role">
                {human?.role ? ROLE_LABELS[human.role] : '身份未知'}
                {human && ROLE_GOAL[human.role ?? ''] ? `：${ROLE_GOAL[human.role ?? '']}` : ''}
              </span>
            </div>
            <div className="hand__cards">
              {hand.length === 0 && <span className="hand__empty">沒有手牌</span>}
              {hand.map((card) => (
                <CardView
                  key={card.id}
                  card={card}
                  selected={selectedCards.includes(card.id)}
                  disabled={!selectableCards.has(card.id)}
                  onClick={selectableCards.has(card.id) ? () => toggleCard(card.id) : undefined}
                />
              ))}
            </div>
          </section>

          {view.winner && (
            <div className="result" role="dialog" aria-modal="true" aria-label="對局結果">
              <div className="result__card">
                <p className="result__eyebrow">對局結束</p>
                <h2>{winnerText(view.winner)}</h2>
                <p>{view.winner.reason}</p>
                <p className="result__turns">共 {view.turnCount} 回合</p>
                <ul className="result__roles">
                  {view.players.map((player) => (
                    <li key={player.id}>
                      <span className={`seat__role ${player.role ? `seat__role--${player.role}` : ''}`}>
                        {player.role ? ROLE_LABELS[player.role] : '身份未知'}
                      </span>
                      <span className="result__roles-name">
                        {player.generalName}
                        {player.alive ? '' : '（陣亡）'}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="result__actions">
                  <button type="button" className="primary-btn" onClick={restart}>
                    再來一局
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => setShowHelp(true)}>
                    查看規則
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="sidebar">
          {pending ? (
            <PromptPanel
              view={view}
              request={pending}
              humanId={controller.humanId}
              selectedCards={selectedCards}
              selectedPlayers={selectedPlayers}
              onTogglePlayer={togglePlayer}
              onToggleCard={toggleCard}
              onRespond={send}
            />
          ) : (
            <section className="panel prompt">
              <div className="panel__title">行動</div>
              <p className="prompt__hint">{view.winner ? '對局已結束。' : '等待其他角色行動……'}</p>
            </section>
          )}

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}

          <LogPanel entries={view.log} />
        </aside>
      </main>

      {showHelp && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="規則說明" onClick={() => setShowHelp(false)}>
          <div className="modal__card" onClick={(event) => event.stopPropagation()}>
            <div className="modal__head">
              <h2>五人身份局規則摘要</h2>
              <button type="button" className="ghost-btn" onClick={() => setShowHelp(false)} aria-label="關閉">
                關閉
              </button>
            </div>
            <div className="modal__body">
              <h3>身份與勝利條件</h3>
              <ul>
                <li>主公：擊殺所有反賊與內奸。主公體力上限 +1。</li>
                <li>忠臣：保護主公。主公死亡時，忠臣與主公一起失敗。</li>
                <li>反賊：擊殺主公。主公死亡且場上仍有反賊時，反賊勝利。</li>
                <li>內奸：先除掉反賊與忠臣，最後在單挑中擊敗主公。</li>
              </ul>
              <h3>回合流程</h3>
              <p>準備 → 判定 → 摸牌（2 張）→ 出牌 → 棄牌（手牌上限＝體力）→ 結束。</p>
              <h3>本版已實作</h3>
              <ul>
                <li>基本牌：殺、火殺、雷殺、閃、桃、酒。</li>
                <li>每回合只能使用一張【殺】（【酒】不佔次數）；裝備【諸葛連弩】可解除此限制。</li>
                <li>即時錦囊：無中生有、過河拆橋、順手牽羊、決鬥、南蠻入侵、萬箭齊發、桃園結義、五穀豐登、借刀殺人、火攻、鐵索連環、無懈可擊。</li>
                <li>延時錦囊：樂不思蜀、兵糧寸斷、閃電；判定前可使用【無懈可擊】。</li>
                <li>裝備：11 把武器、八卦陣／仁王盾／藤甲／白銀獅子、各類 ±1 馬。</li>
                <li>結算：距離、攻擊範圍、鐵索傳導、瀕死求桃、死亡獎懲、勝負判定。</li>
                <li>標準 25 名武將技能全部啟用，第二批包含：反饋、鬼才、剛烈、突襲、裸衣、天妒、遺計、傾國、洛神、觀星、空城、鐵騎、馬術、奇襲、克己、苦肉、英姿、反間、國色、流離、謙遜、連營、結姻、梟姬。</li>
                <li>需要選牌或選目標的技能（仁德、制衡、青囊、離間、龍膽、武聖等）會先按行動選項，再依提示選牌。</li>
              </ul>
              <h3>操作</h3>
              <p>出牌階段按右側行動按鈕。需要選牌時，點擊下方手牌後確認。</p>
              <h3>安全與隱私</h3>
              <p>
                本遊戲完全在瀏覽器本機執行，不連線伺服器、不收集資料。其他角色的手牌與身份只會在你的畫面上以遮蔽後的視角呈現；AI
                也只取得自己的視角。
              </p>
              <p className="modal__note">此為非官方、非商業的規則學習用實作。三國殺為其權利人所有。</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
