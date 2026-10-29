import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 生產環境 CSP。開發環境不注入，避免阻擋 Vite HMR 的 inline script。
 * 部署時另外由 public/_headers、vercel.json 提供完整的安全標頭。
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ');

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'sanguosha-inject-csp',
      apply: 'build',
      transformIndexHtml(html) {
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: PRODUCTION_CSP,
              },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
