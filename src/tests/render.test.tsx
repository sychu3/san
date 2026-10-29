import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from '../App';

describe('UI 渲染煙霧測試', () => {
  it('App 可以在伺服器端渲染，包含標題與手牌區', () => {
    const html = renderToString(<App />);
    expect(html).toContain('三國殺');
    expect(html).toContain('你的手牌');
    expect(html).toContain('對局紀錄');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });
});
