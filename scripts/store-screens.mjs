/**
 * 生成商店截图：用演示数据打开网页版，截 6 个页面，再合成带标题的商店图。
 *   npm run build && npx vite-node scripts/store-data.ts && node scripts/store-screens.mjs
 * 输出：store/screenshots/ios-6.9/*.png（1320×2868）、store/screenshots/android/*.png（1080×2160）、
 *       store/feature-graphic.png（1024×500）、store/icon-512.png
 * 需要 Playwright（PLAYWRIGHT_MODULE 指向 playwright/index.mjs，CHROMIUM 指向浏览器）。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = 9931;
const BASE = `http://localhost:${PORT}/`;
const srv = spawn('node', ['server/index.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));
const exe = process.env.CHROMIUM || undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
await mkdir('store/raw', { recursive: true });
await mkdir('store/screenshots/ios-6.9', { recursive: true });
await mkdir('store/screenshots/android', { recursive: true });

const SHOTS = [
  { id: '1-home', hash: '#/', zh: '拍照记账期\n到期前提醒你', pt: 'Fotografe a nota, receba o lembrete' },
  { id: '2-calendar', hash: '#/bills', zh: '月历一眼看清\n每天要付多少', pt: 'Calendário com valores por fornecedor', act: async (p) => p.getByRole('button', { name: '月历' }).click() },
  { id: '3-reconcile', hash: '#/reconcile', zh: '每个商家欠多少\n逾期多久', pt: 'Quanto você deve a cada fornecedor' },
  { id: '4-report', hash: '#/report', zh: '月报年报\n进货最多的型号', pt: 'Relatórios mensais e anuais' },
  { id: '5-cashflow', hash: '#/cashflow', zh: '未来 12 周\n资金够不够', pt: 'Previsão de caixa por semana' },
  { id: '6-search', hash: '#/', zh: '商家、单号、金额\n一搜就有', pt: 'Busque por fornecedor, número ou valor', act: async (p) => { await p.getByRole('button', { name: /搜索全部账单/ }).click(); await p.fill('#gsearch', 'Brás'); } },
];

for (const dark of [false]) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, locale: 'zh-CN', timezoneId: 'America/Sao_Paulo', isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('zq.tour.done', '1'); } catch {}
  });
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.getByRole('button', { name: '清除示例' }).click();
  await p.getByText('熟悉后可一键清除').waitFor({ state: 'detached' });
  await p.goto(BASE + '#/data');
  await p.setInputFiles('input[type=file]', 'store/demo-backup.json');
  await p.getByRole('button', { name: '确认合并导入' }).click();
  await p.getByRole('button', { name: '合并导入', exact: true }).click().catch(() => {});
  await p.getByText('导入完成').waitFor();
  await p.goto(BASE + '#/cashflow');
  await p.fill('#cash', '3.500,00');
  await p.getByRole('button', { name: '保存', exact: true }).click();
  for (const s of SHOTS) {
    await p.goto(BASE + s.hash);
    await p.reload(); // 清掉上一步的提示条
    await p.waitForTimeout(900);
    if (s.act) await s.act(p);
    await p.waitForTimeout(1100);
    await p.screenshot({ path: `store/raw/${s.id}.png` });
  }
  await ctx.close();
}

const b64 = async (f) => `data:image/png;base64,${(await readFile(f)).toString('base64')}`;
const icon = await b64('assets/icon-only.png');
async function compose(s, w, h, out) {
  const img = await b64(`store/raw/${s.id}.png`);
  const phoneW = Math.round(w * 0.78);
  const phoneH = Math.round(phoneW * (844 / 390));
  const html = `<html><body style="margin:0">
  <div style="width:${w}px;height:${h}px;position:relative;overflow:hidden;background:linear-gradient(160deg,#6a4bff 0%,#8b5cf6 55%,#b46cf2 100%);font-family:'Noto Sans CJK SC','PingFang SC',sans-serif;color:#fff">
    <div style="position:absolute;width:${w * 0.9}px;height:${w * 0.9}px;border-radius:50%;right:-${w * 0.35}px;top:-${w * 0.3}px;background:rgba(255,255,255,.08)"></div>
    <div style="position:absolute;left:0;right:0;top:${h * 0.055}px;text-align:center;padding:0 ${w * 0.06}px">
      <div style="font-size:${w * 0.083}px;font-weight:900;line-height:1.22;white-space:pre-line;letter-spacing:.02em;text-shadow:0 6px 20px rgba(40,10,120,.25)">${s.zh}</div>
      <div style="margin-top:${w * 0.025}px;font-size:${w * 0.036}px;font-weight:700;opacity:.88;font-family:Nunito,'Noto Sans',sans-serif">${s.pt}</div>
    </div>
    <div style="position:absolute;left:${(w - phoneW) / 2 - 14}px;top:${Math.round(h * 0.2)}px;width:${phoneW + 28}px;height:${phoneH + 28}px;border-radius:${w * 0.075}px;background:#140f2b;box-shadow:0 40px 90px rgba(30,10,90,.45)">
      <img src="${img}" style="position:absolute;left:14px;top:14px;width:${phoneW}px;height:${phoneH}px;border-radius:${w * 0.062}px;display:block">
    </div>
  </div></body></html>`;
  const pg = await browser.newPage({ viewport: { width: w, height: h } });
  await pg.setContent(html);
  await pg.waitForTimeout(150);
  await pg.screenshot({ path: out });
  await pg.close();
}
for (const s of SHOTS) {
  await compose(s, 1320, 2868, `store/screenshots/ios-6.9/${s.id}.png`);
  await compose(s, 1080, 2160, `store/screenshots/android/${s.id}.png`);
}
// Google Play 宣传图 1024×500
{
  const shot = await b64('store/raw/1-home.png');
  const pg = await browser.newPage({ viewport: { width: 1024, height: 500 } });
  await pg.setContent(`<html><body style="margin:0"><div style="width:1024px;height:500px;position:relative;overflow:hidden;background:linear-gradient(135deg,#5b3df5,#8b5cf6 60%,#b46cf2);font-family:'Noto Sans CJK SC',sans-serif;color:#fff">
    <img src="${icon}" style="position:absolute;left:64px;top:92px;width:120px;height:120px;border-radius:28px;box-shadow:0 18px 40px rgba(30,10,90,.35)">
    <div style="position:absolute;left:64px;top:236px;font-size:64px;font-weight:900">账期助手</div>
    <div style="position:absolute;left:66px;top:330px;font-size:28px;font-weight:700;opacity:.92">拍照记账期 · 到期前提醒你</div>
    <div style="position:absolute;left:66px;top:378px;font-size:20px;font-weight:700;opacity:.75;font-family:Nunito,sans-serif">Contas a pagar, boletos e lembretes</div>
    <img src="${shot}" style="position:absolute;right:70px;top:46px;width:300px;border-radius:34px;border:10px solid #140f2b;box-shadow:0 30px 70px rgba(30,10,90,.45)">
  </div></body></html>`);
  await pg.waitForTimeout(150);
  await pg.screenshot({ path: 'store/feature-graphic.png' });
  await pg.close();
}
await browser.close();
srv.kill();
const { createRequire } = await import('node:module');
const sharp = createRequire(import.meta.url)('sharp');
await sharp('assets/icon-only.png').resize(512, 512).png().toFile('store/icon-512.png');
console.log('done');
