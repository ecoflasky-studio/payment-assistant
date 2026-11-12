import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tr, tx, setDict, systemLang, monthShort } from '../src/i18n';
import pt from '../src/locales/pt.json';
import en from '../src/locales/en.json';
// @ts-expect-error 服务端 .mjs 没有类型声明
import { createSaas } from '../supabase/saas.mjs';

afterEach(() => setDict('zh', null));

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) ? [join(d, f)] : []));
const used = new Set<string>();
for (const f of walk('src')) for (const m of readFileSync(f, 'utf8').matchAll(/\btr\('((?:[^'\\]|\\.)*)'/g)) used.add(JSON.parse(`"${m[1].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`));

describe('三语词典', () => {
  it('源码里每条界面文字在葡语、英文词典里都有，占位符一致、不为空', () => {
    const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
    for (const [name, d] of [['pt', pt], ['en', en]] as const) {
      const D = d as Record<string, string>;
      const missing = [...used].filter((k) => !(k in D));
      expect(missing, name).toEqual([]);
      for (const [k, v] of Object.entries(D)) {
        expect(v.trim() || v === ' ', `${name}: ${k}`).toBeTruthy();
        expect(ph(v), `${name}: ${k}`).toBe(ph(k));
      }
    }
    // 葡语、英文里不应残留中文（示例中的商家写法除外）
    const cjk = Object.entries(pt as Record<string, string>).filter(([, v]) => /[一-鿿]/.test(v) && !/黄筹|商家|单号|开单|到期|金额|语言/.test(v)).map(([k]) => k);
    expect(cjk).toEqual([]);
  });
  it('tr：中文原样，其他语言查词典并填入参数；tx 能按模式翻译运行时文字', () => {
    expect(tr('已付清 {0}', 'R$ 1,00')).toBe('已付清 R$ 1,00');
    setDict('pt', pt as Record<string, string>);
    expect(tr('已付清 {0}', 'R$ 1,00')).toBe('R$ 1,00 quitado');
    expect(tx('第 3 行单价为空')).toBe('Preço da linha 3 vazio');
    expect(tx('没有这个词条')).toBe('没有这个词条');
    expect(monthShort(10)).toBe('out');
    setDict('en', en as Record<string, string>);
    expect(tx('本月 20 次 AI 识别已用完：升级 T2 每月 50 次，或买 AI 加量包（20 次）')).toBe("This month's 20 AI scans are used up: T2 has 50 per month, or buy an AI pack (20 scans)");
  });
  it('跟随系统语言：中文、葡语、其他都用英文', () => {
    expect(systemLang(['zh-CN'])).toBe('zh');
    expect(systemLang(['pt-BR', 'en'])).toBe('pt');
    expect(systemLang(['es-ES'])).toBe('en');
    expect(systemLang(['fr', 'zh-TW'])).toBe('zh');
  });
  it('服务端推送按设备语言写', () => {
    const { digest } = createSaas();
    const b = { id: 'b1', merchantNameSnapshot: 'Loja', dueDate: '2026-11-12', billDate: '2026-10-01', totalCents: 15000, reminderDays: 3, paidAt: null, items: [] };
    expect(digest([b], '2026-11-10', 'pt')).toMatchObject({ title: 'Lembrete de pagamento: 1 conta, total R$ 150,00', body: 'Loja · R$ 150,00 · vence em 2 dias' });
    expect(digest([b], '2026-11-14', 'en')?.title).toBe('1 overdue · 1 bill to handle');
    expect(digest([b], '2026-11-12')?.title).toContain('付款提醒');
  });
});
