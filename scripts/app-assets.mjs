/**
 * 生成 App 图标与启动图：assets/icon.svg → PNG → @capacitor/assets 生成 iOS / Android 全部尺寸。
 * 只在改了图标时运行（需要本机有 Playwright + Chromium）：npm run assets
 */
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const svg = await readFile('assets/icon.svg', 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const exe = process.env.CHROMIUM || undefined;
const b = await chromium.launch(exe ? { executablePath: exe } : {});
const p = await b.newPage();
async function render(file, size, html) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
  await p.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
// 完整图标（iOS 会自动裁圆角）
await render('assets/icon-only.png', 1024, svg.replace('<svg ', '<svg width="1024" height="1024" '));
// 安卓自适应图标：前景（票据缩到安全区 66%）+ 背景（渐变）
const fg = inner.replace(/<rect width="1024" height="1024" fill="url\(#bg\)"\/>/, '').replace(/<circle cx="860"[^>]*\/>/, '');
await render('assets/icon-foreground.png', 1024, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-170 -150 1364 1364">${fg}</svg>`);
await render('assets/icon-background.png', 1024, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6a4bff"/><stop offset="1" stop-color="#9a5cf6"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#bg)"/></svg>`);
// 启动图：浅紫底 + 居中图标
const splash = (bg) => `<div style="width:2732px;height:2732px;background:${bg};display:grid;place-items:center"><div style="width:560px;height:560px;border-radius:124px;overflow:hidden;box-shadow:0 30px 80px rgba(40,20,120,.25)">${svg.replace('<svg ', '<svg width="560" height="560" ')}</div></div>`;
await render('assets/splash.png', 2732, splash('#efeafe'));
await render('assets/splash-dark.png', 2732, splash('#171030'));
await b.close();
execSync('npx @capacitor/assets generate --ios --android --iconBackgroundColor "#6a4bff" --iconBackgroundColorDark "#6a4bff" --splashBackgroundColor "#efeafe" --splashBackgroundColorDark "#171030"', { stdio: 'inherit' });
// 网页 / PWA 图标也换成同一个
await writeFile('public/icon.svg', svg);
console.log('done');
