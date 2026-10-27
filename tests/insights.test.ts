import { describe, it, expect } from 'vitest';
import { parseTags, tagStats, searchAll, aging, merchantOverview, buildReport, reportText, cashPlan, reconcileText } from '../src/lib/insights';
import type { Bill, Merchant } from '../src/lib/types';

const T = '2026-10-27';
let n = 0;
const bill = (o: Partial<Bill>): Bill => ({
  id: `b${++n}`, merchantId: 'm1', merchantNameSnapshot: 'Brás 配件', orderNumber: '', billDate: '2026-10-01', dueDate: '2026-10-29', accountId: null, accountLabelSnapshot: '', reminderDays: 3,
  paidAt: null, notes: '', items: [], totalCents: 10000, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1, ...o,
} as Bill);
const pay = (date: string, cents: number) => ({ paidAt: `${date}T15:00:00Z`, payments: [{ id: `p${++n}`, date, cents }] });
const M = (id: string, name: string, extra: Partial<Merchant> = {}): Merchant => ({ id, name, aliases: [], defaultAccountId: null, active: true, ...extra } as Merchant);
const merchants = [M('m1', 'Brás 配件', { aliases: ['BRAS ACESSORIOS'] }), M('m2', '25 de Março 包装'), M('p1', 'Sabesp', { type: 'payee' })];

const bills: Bill[] = [
  bill({ orderNumber: '0231', dueDate: '2026-10-19', totalCents: 29000, tags: ['店铺A'], items: [{ id: 'i1', quantity: 10, description: 'FN-A78', unitPriceCents: 2900, subtotalCents: 29000 }] }),
  bill({ orderNumber: '0264', dueDate: '2026-10-28', totalCents: 24840, tags: ['店铺A', '年货'] }),
  bill({ merchantId: 'm2', merchantNameSnapshot: '25 de Março 包装', billDate: '2026-09-20', dueDate: '2026-10-05', totalCents: 17800, ...pay('2026-10-04', 17800), items: [{ id: 'i2', quantity: 100, description: 'Caixa P', unitPriceCents: 178, subtotalCents: 17800 }] }),
  bill({ merchantId: 'p1', merchantNameSnapshot: 'Sabesp', kind: 'expense', category: 'water', billDate: '2026-10-01', dueDate: '2026-10-26', totalCents: 18790, ...pay('2026-10-26', 18790), recurrence: { seriesId: 's1', unit: 'month', every: 1 } }),
  bill({ merchantId: 'm1', billDate: '2026-07-01', dueDate: '2026-08-01', totalCents: 5000 }), // 逾期 87 天
  bill({ merchantId: 'm1', dueDate: '2026-09-10', totalCents: 7000, deletedAt: '2026-10-01T00:00:00Z' }),
];

describe('标签', () => {
  it('解析：逗号/空格/# 分隔，去重，最多 12 个', () => {
    expect(parseTags('#店铺A, 年货，店铺a;  待报销')).toEqual(['店铺A', '年货', '待报销']);
  });
  it('统计每个标签的笔数、金额、未付', () => {
    const s = tagStats(bills, T);
    expect(s[0]).toMatchObject({ tag: '店铺A', count: 2, totalCents: 53840, openCents: 53840, overdueCount: 1 });
    expect(s.find((x) => x.tag === '年货')).toMatchObject({ count: 1 });
  });
});

describe('全局搜索', () => {
  it('按商家名、别名（忽略重音）、单号', () => {
    expect(searchAll('bras', bills, merchants, T).bills.length).toBe(3);
    expect(searchAll('acessorios', bills, merchants, T).merchants[0].merchant.id).toBe('m1');
    expect(searchAll('0264', bills, merchants, T).bills.map((x) => x.bill.orderNumber)).toEqual(['0264']);
  });
  it('按金额：完整金额精确匹配，整数匹配整数部分', () => {
    expect(searchAll('248,40', bills, merchants, T).bills.map((x) => x.bill.totalCents)).toEqual([24840]);
    expect(searchAll('R$ 290,00', bills, merchants, T).bills[0].why).toBe('金额相同');
    expect(searchAll('248', bills, merchants, T).bills.map((x) => x.bill.totalCents)).toEqual([24840]);
  });
  it('按型号、#标签；多个词都要有；已删除的不出现', () => {
    expect(searchAll('fn-a78', bills, merchants, T).bills[0].why).toBe('型号');
    expect(searchAll('#年货', bills, merchants, T).bills.map((x) => x.bill.orderNumber)).toEqual(['0264']);
    expect(searchAll('bras 年货', bills, merchants, T).bills.length).toBe(1);
    expect(searchAll('70,00', bills, merchants, T).bills).toEqual([]);
    expect(searchAll('', bills, merchants, T).bills).toEqual([]);
  });
});

describe('账龄与商家对账', () => {
  it('按逾期天数分段', () => {
    expect(aging(bills, T)).toEqual({ current: 24840, soon: 24840, d30: 29000, d60: 0, d60plus: 5000, total: 58840 });
  });
  it('商家总览：欠款、逾期优先排序、近 6 个月采购、付款天数', () => {
    const rows = merchantOverview(bills, merchants, T);
    expect(rows.map((r) => r.merchant.id)).toEqual(['m1', 'm2']);
    expect(rows[0]).toMatchObject({ openCents: 58840, openCount: 3, overdueCents: 34000 });
    expect(rows[0].trend).toEqual([0, 0, 5000, 0, 0, 53840]);
    expect(rows[1]).toMatchObject({ openCents: 0, avgPayDays: 14, onTimePct: 100 });
    expect(merchantOverview(bills, merchants, T, 'payee').map((r) => r.merchant.id)).toEqual(['p1']);
  });
  it('对账文字：逐笔未付 + 合计', () => {
    const t = reconcileText('Brás 配件', bills, 'm1', T, (c) => `R$ ${(c / 100).toFixed(2)}`, (d) => d.split('-').reverse().join('/'));
    expect(t).toMatch(/#0231，19\/10\/2026 到期：R\$ 290\.00 · 已逾期/);
    expect(t).toMatch(/合计未付：R\$ 588\.40（3 笔）/);
  });
});

describe('月报 / 年报', () => {
  it('实付、构成、排行、型号、按时率', () => {
    const r = buildReport(bills, { kind: 'month', ym: '2026-10' });
    expect(r).toMatchObject({ paidCents: 36590, payCount: 2, supplierPaid: 17800, expensePaid: 18790, dueCount: 4, onTimeCount: 2, stillOpenCents: 53840 });
    expect(r.byMerchant.map((x) => [x.label, x.cents])).toEqual([['25 de Março 包装', 17800]]);
    expect(r.byCategory.map((x) => x.cents)).toEqual([18790, 17800]);
    expect(r.topItems[0]).toMatchObject({ desc: 'FN-A78', qty: 10, cents: 29000 });
    expect(r.series).toHaveLength(31);
    expect(r.series[3].cents).toBe(17800);
    expect(r.biggest).toMatchObject({ cents: 18790 });
    expect(reportText(r, (c) => String(c / 100))).toMatch(/2026 年 10 月月报/);
  });
  it('年报 12 个月', () => {
    const r = buildReport(bills, { kind: 'year', y: '2026' });
    expect(r.series.map((x) => x.cents)[9]).toBe(36590);
    expect(r.lastYearPaidCents).toBe(0);
  });
});

describe('现金流预测', () => {
  it('逾期单列；按周汇总；重复账单推算下几期（预估）', () => {
    const p = cashPlan(bills, T, 6);
    expect(p.overdueCents).toBe(34000);
    expect(p.weeks[0]).toMatchObject({ cents: 24840, projected: 0 });
    // Sabesp 每月 26 号 → 11/26 落在第 5 周（11/24–11/30）
    const w = p.weeks.findIndex((x) => x.projected > 0);
    expect(p.weeks[w].from <= '2026-11-26' && p.weeks[w].to >= '2026-11-26').toBe(true);
    expect(p.weeks[w].items[0]).toMatchObject({ projected: true, cents: 18790 });
    expect(p.shortWeek).toBeNull();
  });
  it('填了可用资金：逐周算余额，提示哪周不够', () => {
    const p = cashPlan(bills, T, 6, 50000);
    expect(p.weeks[0].balance).toBe(50000 - 34000 - 24840);
    expect(p.shortWeek).toBe(0);
    expect(p.lowest).toBe(50000 - 34000 - 24840 - 18790);
    expect(cashPlan(bills, T, 6, 20000).shortWeek).toBe(-1);
  });
});
