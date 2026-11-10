import { describe, it, expect } from 'vitest';
import { scrub, cleanStack, buildReport, configureErrorReports, reportError } from '../src/lib/errorReport';

describe('错误报告不带账单内容', () => {
  it('抹掉金额、单号、日期、邮箱和引号里的文字', () => {
    const s = scrub('Cannot read "Brás Peças" of R$ 1.234,56 order 0258 due 24/10/2026 ana@ex.com');
    expect(s).not.toMatch(/Brás|1\.234|0258|2026|ana@/);
    expect(s).toContain('<money>');
    expect(s).toContain('<email>');
  });
  it('调用栈只留文件名和行号', () => {
    const st = cleanStack('TypeError: x\n    at go (https://ecoflasky-studio.github.io/payment-assistant/assets/Editor-abc.js?v=1:12:345)\n    at capacitor://localhost/assets/index-x.js:1:2');
    expect(st).toBe('TypeError: x\nat go Editor-abc.js:12:345\nat index-x.js:1:2');
  });
  it('同一错误只报一次；关闭后不报', async () => {
    const got: any[] = [];
    configureErrorReports({ send: async (r) => got.push(r), enabled: true, where: () => 'edit', platform: 'web' });
    const e = new TypeError('boom 123456');
    reportError(e);
    reportError(e);
    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({ where: 'edit', platform: 'web', message: 'TypeError: boom #' });
    configureErrorReports({ send: async (r) => got.push(r), enabled: false, where: () => '', platform: 'web' });
    reportError(new Error('other'));
    expect(got.length).toBe(1);
    expect(buildReport('str', 'x', 'ios').message).toBe('Error: str');
  });
});
