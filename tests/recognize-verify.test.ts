import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../server/core.mjs';
import { arithmeticIssues, acceptVerified, verifyPrompt, RECOGNIZE_SCHEMA } from '../shared/recognize-schema.mjs';
import fixture from './fixtures/ticket-258.model.json';

/** 第 3 行读错：5 × 15,00 写成 75，模型却把单价读成 16 → 算术对不上 */
const wrong = { ...fixture, items: fixture.items.map((it) => (it.row === 3 ? { ...it, unitPriceRaw: '16', unitPriceCents: 1600 } : it)) };

let srv: http.Server;
let base = '';
let calls: any[] = [];
let mode: 'verifyFix' | 'verifyKeep' | 'noSchema' | 'badJsonOnce' = 'verifyFix';
let bad = 0;

beforeAll(async () => {
  srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const body = JSON.parse(raw || '{}');
    calls.push(body);
    const prompt: string = body.contents?.[0]?.parts?.[1]?.text ?? '';
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const text = (o: unknown) => send(200, { candidates: [{ content: { parts: [{ text: typeof o === 'string' ? o : JSON.stringify(o) }] }, finishReason: 'STOP' }] });
    if (mode === 'noSchema' && body.generationConfig?.responseSchema) return send(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "responseSchema"', status: 'INVALID_ARGUMENT' } });
    if (mode === 'badJsonOnce' && bad-- > 0) return text('抱歉，我无法');
    if (prompt.includes('【复核】')) return text(mode === 'verifyKeep' ? { ...wrong, warnings: ['原单据第 3 行算术不符'] } : { ...fixture, warnings: ['复核第 3 行：16 改为 15'] });
    return text(mode === 'badJsonOnce' || mode === 'noSchema' ? fixture : wrong);
  });
  await new Promise<void>((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1beta`;
});
afterAll(() => srv?.close());

const handle = createHandler({ prompt: 'PROMPT' });
const ENV = () => ({ GEMINI_API_KEY: 'k', GEMINI_API_URL: base, GEMINI_MODEL: 'gemini-test', RATE_PER_MIN: '100' });
const post = async () => {
  const r = (await handle(new Request('http://x/api/recognize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mediaType: 'image/jpeg', imageBase64: 'AAAA' }) }), ENV()))!;
  return { status: r.status, body: await r.json() };
};

describe('算术检查', () => {
  it('找出 数量×单价≠小计 的行与 合计≠总额', () => {
    expect(arithmeticIssues(fixture)).toEqual([]);
    const is = arithmeticIssues(wrong);
    expect(is).toEqual([{ row: 3, kind: 'row', calc: 8000, printed: 7500 }]);
    expect(arithmeticIssues({ ...fixture, printedTotalCents: 37000 })).toEqual([{ row: null, kind: 'total', calc: 36800, printed: 37000 }]);
    expect(verifyPrompt('P', wrong, is)).toMatch(/第 3 行：数量×单价 = 80,00，但读到的小计是 75,00/);
  });
  it('复核结果只有在对不上的地方变少、行数没丢时才采用', () => {
    expect(acceptVerified(wrong, fixture)).toBe(true);
    expect(acceptVerified(wrong, wrong)).toBe(false);
    expect(acceptVerified(wrong, { ...fixture, items: fixture.items.slice(0, 2) })).toBe(false);
    expect(acceptVerified(wrong, null)).toBe(false);
  });
  it('Schema 覆盖提示词里的所有顶层字段', () => {
    expect(Object.keys(RECOGNIZE_SCHEMA.properties)).toEqual(expect.arrayContaining(['docType', 'merchant', 'items', 'printedTotalCents', 'statement', 'warnings']));
    expect(RECOGNIZE_SCHEMA.properties.items.items.required).toContain('printedSubtotalCents');
  });
});

describe('识别服务：结构化输出 + 自动复核', () => {
  it('请求带 responseSchema；算术对不上时自动复核并采用改正后的结果', async () => {
    mode = 'verifyFix';
    calls = [];
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].generationConfig.responseSchema.type).toBe('OBJECT');
    expect(body.result.items[2].unitPriceCents).toBe(1500);
    expect(body.verified).toEqual({ before: 1, after: 0 });
    expect(body.result.warnings.join()).toMatch(/已自动复核/);
  });
  it('复核后仍对不上（原单据算错）：保留第一次读数并带上说明', async () => {
    mode = 'verifyKeep';
    calls = [];
    const { body } = await post();
    expect(calls).toHaveLength(2);
    expect(body.result.items[2].unitPriceCents).toBe(1600);
    expect(body.verified).toBeNull();
    expect(body.result.warnings).toContain('原单据第 3 行算术不符');
  });
  it('模型不支持 Schema：自动去掉后重试', async () => {
    mode = 'noSchema';
    calls = [];
    const { status } = await post();
    expect(status).toBe(200);
    expect(calls.map((c) => !!c.generationConfig.responseSchema)).toEqual([true, false]);
  });
  it('第一次返回的不是 JSON：自动再试一次', async () => {
    mode = 'badJsonOnce';
    bad = 1;
    calls = [];
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(body.result.items).toHaveLength(4);
  });
});
