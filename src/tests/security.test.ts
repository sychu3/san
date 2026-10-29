import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'tests') continue;
      files.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('安全回歸測試', () => {
  it('原始碼不使用危險的 HTML／執行動態字串 API', () => {
    const files = sourceFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('dangerouslySetInnerHTML');
      expect(text, file).not.toContain('.innerHTML');
      expect(text, file).not.toMatch(/\beval\s*\(/);
      expect(text, file).not.toMatch(/\bnew\s+Function\s*\(/);
      expect(text, file).not.toMatch(/https?:\/\//);
    }
  });

  it('package.json 使用精確版本，沒有 ^ 或 ~', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('部署標頭包含 CSP 與點擊劫持防護', () => {
    const headers = read('public/_headers');
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("connect-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toContain('Referrer-Policy: no-referrer');
  });

  it('production build 會注入嚴格 CSP', () => {
    const config = read('vite.config.ts');
    expect(config).toContain("script-src 'self'");
    expect(config).toContain("style-src 'self'");
    expect(config).toContain("connect-src 'none'");
    expect(config).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('不使用外部網路資源', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/https?:\/\//);
    const headers = read('vercel.json');
    expect(headers).toContain("default-src 'self'");
  });
});
