import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from '../App';
import { Seat } from '../ui/Seat';
import { PromptPanel } from '../ui/PromptPanel';
import { LogPanel } from '../ui/LogPanel';
import { CardView } from '../ui/CardView';
import { SetupScreen } from '../ui/SetupScreen';
import { createGame, viewFor } from '../engine/state';
import { createSetup } from '../game/setup';
import type { Card, Request } from '../engine/types';

describe('UI 渲染煙霧測試', () => {
  it('App 可以在伺服器端渲染，包含標題與手牌區', () => {
    const html = renderToString(<App />);
    expect(html).toContain('三國殺');
    expect(html).toContain('你的手牌');
    expect(html).toContain('對局紀錄');
    expect(html).toContain('設定');
    expect(html).toContain('存檔');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('App 開局會顯示身份、座位與三名候選武將', () => {
    const html = renderToString(<App />);
    expect(html).toContain('你的身份');
    expect(html).toContain('3 選 1');
    expect(html).toContain('setup__general');
    expect(html).toContain('setup__seats');
    expect(html).toContain('號位');
  });

  it('SetupScreen 提供自訂模式入口（自由選身份與武將）', () => {
    const setup = createSetup(0, 777);
    const html = renderToString(
      <SetupScreen
        setup={setup}
        onPick={() => undefined}
        onPickCustom={() => undefined}
        onPickRole={() => undefined}
      />,
    );
    expect(html).toContain('自訂模式');
  });

  it('App 頂欄提供主題切換', () => {
    const html = renderToString(<App />);
    expect(html).toContain('主題：');
    expect(html).toContain('深色');
  });

  it('App 會顯示非官方聲明與隱私說明', () => {
    const html = renderToString(<App />);
    expect(html).toContain('非官方');
    expect(html).toContain('非商業');
    expect(html).toContain('不連線伺服器');
    expect(html).toContain('footer');
  });

  it('LogPanel 會把回合分隔列標成醒目樣式', () => {
    const entries = [
      { seq: 1, kind: 'phase' as const, text: '── 曹操 的回合 ──' },
      { seq: 2, kind: 'play' as const, text: '曹操 使用【殺】→ 劉備。' },
    ];
    const html = renderToString(<LogPanel entries={entries} />);
    expect(html).toContain('log__line--turn');
    expect(html).toContain('曹操 的回合');
  });

  it('CardView 的提示包含卡牌說明與坐騎標示', () => {
    const html = renderToString(<CardView card={{ id: 1, name: 'jueying', suit: 'spade', rank: 5 }} />);
    expect(html).toContain('+1');
    expect(html).toContain('距離');
  });

  it('Seat 受到傷害時會加上閃動 class', () => {
    const state = createGame({ seed: 1 });
    const view = viewFor(state, 0);
    const html = renderToString(
      <Seat player={view.players[0]!} isTurn isSelf waiting={false} hit />,
    );
    expect(html).toContain('seat--hit');
  });

  it('Seat 會顯示判定區的延時錦囊', () => {
    const state = createGame({ seed: 1 });
    const view = viewFor(state, 0);
    const lightning: Card = { id: 9001, name: 'lightning', suit: 'spade', rank: 1 };
    view.players[0]!.judgeZone.push(lightning);
    const html = renderToString(
      <Seat player={view.players[0]!} isTurn isSelf waiting={false} />,
    );
    expect(html).toContain('判定');
    expect(html).toContain('閃電');
  });

  it('Seat 會顯示武將技能名稱', () => {
    const state = createGame({ seed: 1 });
    const view = viewFor(state, 0);
    view.players[0]!.skills = ['wusheng', 'paoxiao'];
    const html = renderToString(
      <Seat player={view.players[0]!} isTurn isSelf waiting={false} />,
    );
    expect(html).toContain('武聖');
    expect(html).toContain('咆哮');
  });

  it('其他玩家的 compact 座位也會顯示裝備與判定區', () => {
    const state = createGame({ seed: 1 });
    const view = viewFor(state, 0);
    view.players[1]!.equips.weapon = { id: 9005, name: 'crossbow', suit: 'club', rank: 1 };
    view.players[1]!.judgeZone.push({ id: 9006, name: 'lightning', suit: 'spade', rank: 1 });
    const html = renderToString(
      <Seat player={view.players[1]!} isTurn={false} isSelf={false} waiting={false} compact />,
    );
    expect(html).toContain('諸葛連弩');
    expect(html).toContain('閃電');
  });

  it('PromptPanel 會顯示觀星的排序選項', () => {
    const state = createGame({ seed: 1 });
    const view = viewFor(state, 0);
    const cards: Card[] = [
      { id: 9010, name: 'peach', suit: 'heart', rank: 3 },
      { id: 9011, name: 'dodge', suit: 'diamond', rank: 5 },
    ];
    const request: Request = {
      id: 10,
      player: 0,
      prompt: '觀星：安排牌堆頂的順序（由上到下）',
      kind: 'orderCards',
      cards,
      reason: '觀星',
      allowBottom: true,
    };
    const html = renderToString(
      <PromptPanel
        view={view}
        request={request}
        humanId={0}
        selectedCards={[]}
        selectedPlayers={[]}
        onTogglePlayer={() => undefined}
        onToggleCard={() => undefined}
        onRespond={() => undefined}
      />,
    );
    expect(html).toContain('確認順序');
    expect(html).toContain('到堆底');
    expect(html).toContain('桃');
    expect(html).toContain('閃');
  });

  it('PromptPanel 會顯示五穀豐登的翻開牌選項', () => {
    const state = createGame({ seed: 1 });
    const view = viewFor(state, 0);
    const cards: Card[] = [
      { id: 9002, name: 'peach', suit: 'heart', rank: 3 },
      { id: 9003, name: 'dodge', suit: 'diamond', rank: 5 },
    ];
    const request: Request = {
      id: 1,
      player: 0,
      prompt: '五穀豐登：選擇一張牌',
      kind: 'chooseRevealed',
      cards,
      reason: 'chooseRevealed',
    };
    const html = renderToString(
      <PromptPanel
        view={view}
        request={request}
        humanId={0}
        selectedCards={[]}
        selectedPlayers={[]}
        onTogglePlayer={() => undefined}
        onToggleCard={() => undefined}
        onRespond={() => undefined}
      />,
    );
    expect(html).toContain('五穀豐登');
    expect(html).toContain('桃');
    expect(html).toContain('閃');
  });
});
