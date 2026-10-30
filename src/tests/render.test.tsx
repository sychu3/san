import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from '../App';
import { Seat } from '../ui/Seat';
import { PromptPanel } from '../ui/PromptPanel';
import { createGame, viewFor } from '../engine/state';
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
