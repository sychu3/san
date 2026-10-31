import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerId, Response } from './engine/types';
import { winnerText } from './engine/state';
import { randomSeed } from './engine/rng';
import { ROLE_LABELS } from './data/generals';
import { GameController } from './game/controller';
import { buildReplay, type ReplayData } from './game/replay';
import { parseSave, SAVE_KEY, serializeSave } from './game/save';
import {
  loadSettings,
  persistSettings,
  type AnimationMode,
  type Settings,
} from './game/settings';
import { playSound } from './audio/sounds';
import { GameTable } from './ui/GameTable';
import { PromptPanel } from './ui/PromptPanel';
import { LogPanel } from './ui/LogPanel';
import { CardView } from './ui/CardView';

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: '新手',
  normal: '進階',
  hard: '高手',
};

const DIFFICULTY_ORDER = ['easy', 'normal', 'hard'] as const;

const ROLE_GOAL: Record<string, string> = {
  lord: '消滅所有反賊與內奸。誤殺忠臣會棄置所有牌。',
  loyal: '保護主公，協助主公消滅反賊與內奸。',
  rebel: '擊殺主公。主公死亡且場上仍有反賊時，反賊勝。',
  spy: '先協助主公清除反賊，最後成為場上唯一存活者。',
};

export default function App() {
  const [controller, setController] = useState(() => new GameController({ stepMode: true }));
  const [liveView, setLiveView] = useState(() => controller.getView());
  const [selectedCards, setSelectedCards] = useState<number[]>([]);
  const [selectedPlayers, setSelectedPlayers] = useState<PlayerId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [hitId, setHitId] = useState<PlayerId | null>(null);
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const lastLogSeq = useRef(0);
  const prevHp = useRef<number[]>([]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setLiveView(controller.getView()));
    return unsubscribe;
  }, [controller]);

  useEffect(() => {
    persistSettings(settings);
  }, [settings]);

  const view = replay ? replay.views[Math.min(replayIndex, replay.views.length - 1)]! : liveView;
  const pending = view.pending;
  const pendingId = pending?.id ?? null;
  const stepInfo = replay ? null : controller.getWaitingStepInfo();

  // 音效：依新出現的日誌種類播放合成音。
  useEffect(() => {
    if (replay) return;
    const entries = view.log.filter((entry) => entry.seq > lastLogSeq.current);
    for (const entry of entries) {
      if (entry.kind === 'damage') playSound('damage', settings.sound);
      else if (entry.kind === 'death') playSound('death', settings.sound);
      else if (entry.kind === 'win') playSound('win', settings.sound);
      else if (entry.kind === 'play') playSound('play', settings.sound);
    }
    lastLogSeq.current = view.log.length > 0 ? view.log[view.log.length - 1]!.seq : 0;
  }, [view.log, settings.sound, replay]);

  // 受傷閃動：比對體力變化。
  useEffect(() => {
    if (replay) return;
    const currentHp = view.players.map((player) => player.hp);
    const prev = prevHp.current;
    const damaged = view.players.find(
      (player) => prev[player.id] !== undefined && currentHp[player.id]! < prev[player.id]!,
    );
    prevHp.current = currentHp;
    if (damaged && settings.animation !== 'off') {
      setHitId(damaged.id);
      const timer = window.setTimeout(() => setHitId(null), 700);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [view.players, settings.animation, replay]);

  // Esc 關閉彈窗。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowHelp(false);
      setShowSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 重播播放。
  useEffect(() => {
    if (!replay || !playing) return undefined;
    const timer = window.setInterval(() => {
      setReplayIndex((index) => {
        if (index >= replay.views.length - 1) {
          setPlaying(false);
          return index;
        }
        return index + 1;
      });
    }, settings.animation === 'off' ? 150 : 700);
    return () => window.clearInterval(timer);
  }, [replay, playing, settings.animation]);

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
      if (replay) return;
      const current = controller.getView().pending;
      if (!current) return;
      playSound('click', settings.sound);
      try {
        controller.respond(current.id, response);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失敗');
      }
    },
    [controller, replay, settings.sound],
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
    const next = new GameController({
      seed: randomSeed(),
      difficulty: controller.getDifficulty(),
      stepMode: controller.isStepMode(),
    });
    setController(next);
    setLiveView(next.getView());
    setSelectedCards([]);
    setSelectedPlayers([]);
    setError(null);
    setReplay(null);
    setPlaying(false);
    lastLogSeq.current = 0;
    prevHp.current = [];
  };

  const saveGame = () => {
    try {
      localStorage.setItem(SAVE_KEY, serializeSave(controller.getSaveFile()));
      setNotice(`已存檔（seed ${controller.state.seed}）。讀檔後可重播這局。`);
    } catch {
      setNotice('無法寫入瀏覽器儲存空間。');
    }
  };

  const loadReplay = () => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch {
      raw = null;
    }
    const save = parseSave(raw);
    if (!save) {
      setNotice('沒有可用存檔，或存檔版本不相容。');
      return;
    }
    try {
      const data = buildReplay(save);
      setReplay(data);
      setReplayIndex(0);
      setPlaying(false);
      setNotice(null);
    } catch {
      setNotice('存檔與本局流程不符，無法重播。');
    }
  };

  const exitReplay = () => {
    setReplay(null);
    setPlaying(false);
    setReplayIndex(0);
  };

  const setAnimation = (animation: AnimationMode) => {
    setSettings((current) => ({ ...current, animation }));
  };

  const animationClass =
    settings.animation === 'off' ? 'app--anim-off' : settings.animation === 'fast' ? 'app--anim-fast' : '';

  return (
    <div className={`app ${animationClass}`}>
      <header className="topbar">
        <div className="topbar__brand">
          <h1>三國殺</h1>
          <span className="topbar__subtitle">軍爭篇・五人身份局</span>
          <span className="topbar__unofficial">非官方・非商業同人實作</span>
        </div>
        <div className="topbar__actions">
          <span className="topbar__seed" title="本局隨機種子">
            seed {view.seed}
          </span>
          <button
            type="button"
            className="ghost-btn"
            title="切換 AI 難度（新手／進階／高手）"
            onClick={() => {
              const current = DIFFICULTY_ORDER.indexOf(controller.getDifficulty());
              const next = DIFFICULTY_ORDER[(current + 1) % DIFFICULTY_ORDER.length]!;
              controller.setDifficulty(next);
            }}
          >
            AI：{DIFFICULTY_LABELS[controller.getDifficulty()] ?? controller.getDifficulty()}
          </button>
          <button
            type="button"
            className={`ghost-btn ${controller.isStepMode() ? 'ghost-btn--on' : ''}`}
            onClick={() => controller.setStepMode(!controller.isStepMode())}
            title="逐步模式：每個 AI 行動前停下來，等你確認"
          >
            逐步：{controller.isStepMode() ? '開' : '關'}
          </button>
          <button
            type="button"
            className={`ghost-btn ${view.godMode ? 'ghost-btn--on' : ''}`}
            onClick={() => controller.setGodMode(!view.godMode)}
            title="除錯用：顯示所有身份"
          >
            上帝視角
          </button>
          <button type="button" className="ghost-btn" onClick={saveGame} disabled={Boolean(replay)}>
            存檔
          </button>
          <button type="button" className="ghost-btn" onClick={loadReplay}>
            讀檔重播
          </button>
          <button type="button" className="ghost-btn" onClick={() => setShowSettings(true)}>
            設定
          </button>
          <button type="button" className="ghost-btn" onClick={() => setShowHelp(true)}>
            規則
          </button>
          <button type="button" className="primary-btn" onClick={restart} disabled={Boolean(replay)}>
            新局
          </button>
        </div>
      </header>

      {replay && (
        <div className="replaybar" role="region" aria-label="重播控制">
          <span className="replaybar__label">
            重播 seed {view.seed}（第 {replayIndex + 1}／{replay.views.length} 步）
          </span>
          <div className="replaybar__actions">
            <button type="button" className="ghost-btn" onClick={() => setReplayIndex((i) => Math.max(0, i - 1))}>
              上一步
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setPlaying((value) => !value)}
              disabled={replayIndex >= replay.views.length - 1}
            >
              {playing ? '暫停' : '播放'}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setReplayIndex((i) => Math.min(replay.views.length - 1, i + 1))}
            >
              下一步
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setReplayIndex(replay.views.length - 1)}
            >
              跳到最後
            </button>
            <button type="button" className="primary-btn" onClick={exitReplay}>
              離開重播
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" className="ghost-btn" onClick={() => setNotice(null)}>
            關閉
          </button>
        </div>
      )}

      <main className="layout">
        <div className="board">
          <GameTable view={view} humanId={controller.humanId} hitId={hitId} />

          {pending?.kind === 'response' && pending.need === 'peach' && (
            <div className="dying-banner" role="alert">
              瀕死！請決定是否救助
            </div>
          )}

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
          {replay ? (
            <section className="panel prompt">
              <div className="panel__title">重播</div>
              <p className="prompt__hint">重播模式：使用上方控制列前進／後退，不會影響實際對局。</p>
            </section>
          ) : stepInfo ? (
            <section className="panel prompt">
              <div className="panel__title">等待確認</div>
              <p className="prompt__hint">
                輪到 {view.players[stepInfo.player]?.generalName ?? `玩家${stepInfo.player + 1}`} 行動
              </p>
              <p className="prompt__small">{stepInfo.prompt}</p>
              <button type="button" className="primary-btn" onClick={() => controller.resumeStep()}>
                繼續（讓 AI 行動）
              </button>
            </section>
          ) : pending && pending.player === controller.humanId ? (
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

          <LogPanel entries={view.log} players={view.players} />
        </aside>
      </main>

      <footer className="footer">
        <p className="footer__line">
          非官方、非商業的規則學習用粉絲作品；不使用官方卡圖、Logo 或商標，三國殺及相關權利屬於其權利人。
        </p>
        <p className="footer__line">
          對局完全在你的瀏覽器內執行：不連線伺服器、不上傳任何內容、不使用 cookie 或分析腳本；存檔只留在本機。
        </p>
      </footer>

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
                <li>右上角「AI」可切換難度：新手（不推理、較隨機）、進階（用公開事件推理）、高手（推理更強並推測手牌）。AI 只讀自己的視角。</li>
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

      {showSettings && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="設定"
          onClick={() => setShowSettings(false)}
        >
          <div className="modal__card" onClick={(event) => event.stopPropagation()}>
            <div className="modal__head">
              <h2>設定</h2>
              <button type="button" className="ghost-btn" onClick={() => setShowSettings(false)} aria-label="關閉">
                關閉
              </button>
            </div>
            <div className="modal__body">
              <h3>音效</h3>
              <p>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.sound}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, sound: event.target.checked }))
                    }
                  />{' '}
                  播放合成音效（預設關閉；開啟後才建立 AudioContext）
                </label>
              </p>
              <h3>動畫</h3>
              <div className="settings__row">
                {(['full', 'fast', 'off'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`ghost-btn ${settings.animation === mode ? 'ghost-btn--on' : ''}`}
                    onClick={() => setAnimation(mode)}
                  >
                    {mode === 'full' ? '完整' : mode === 'fast' ? '快速' : '關閉'}
                  </button>
                ))}
              </div>
              <p className="modal__note">
                若系統開啟「減少動態效果」，可將動畫設為關閉。設定只存在本機瀏覽器。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
