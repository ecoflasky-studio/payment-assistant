import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from './package.json';
import type { Plugin } from 'vite';

/**
 * 给 Service Worker 写入本次构建的版本号和要预缓存的文件：离线时所有页面都能打开，
 * 新版本上线后旧缓存自动清掉。PDF 解析（约 1.7 MB）不预缓存，第一次用到时再缓存。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  'connect-src * data: blob:',
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
].join('; ');

function swManifest(): Plugin {
  let files: string[] = [];
  return {
    name: 'zq-sw-manifest',
    apply: 'build',
    // 网页版加内容安全策略：只允许本站脚本（OCR 内核来自 jsdelivr），挡住注入的脚本
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    generateBundle(_, bundle) {
      // 部署脚本原文（?raw，只在自建设置里复制时用）也不预缓存
      const rawOnly = (f: string) => {
        const c = bundle[f];
        return c.type === 'chunk' && c.moduleIds.length > 0 && c.moduleIds.every((m) => m.includes('?raw'));
      };
      files = Object.keys(bundle)
        .filter((f) => f.startsWith('assets/') && /\.(js|css|woff2)$/.test(f) && !/pdf/i.test(f) && !rawOnly(f))
        .sort();
    },
    writeBundle(opts) {
      const file = join(opts.dir ?? 'dist', 'sw.js');
      if (!existsSync(file)) return;
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 10);
      const src = readFileSync(file, 'utf8')
        .replace("'__BUILD__'", JSON.stringify(version))
        .replace('[] /*__ASSETS__*/', JSON.stringify(files.map((f) => './' + f)));
      writeFileSync(file, src);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : mode === 'artifact' || mode === 'app' ? [react()] : [react(), swManifest()],
  // artifact：发布为 Claude 页面（多文件、不注册 Service Worker）
  // app：打包进 iOS / Android 安装包（Capacitor，见 capacitor.config.ts）
  define: {
    __SINGLE__: JSON.stringify(mode === 'single' || mode === 'artifact'),
    // 设置页显示的版本号：App 打包时用 CI 的版本 / 构建号，网页用 package.json 版本 + 日期
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkg.version),
    __BUILD_ID__: JSON.stringify(process.env.APP_BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || new Date().toISOString().slice(0, 10).replace(/-/g, '')),
  },
  build: mode === 'single' ? { outDir: 'dist-single', assetsInlineLimit: 100000000 } : mode === 'artifact' ? { outDir: 'dist-artifact' } : mode === 'app' ? { outDir: 'dist-app' } : { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000 },
}));
