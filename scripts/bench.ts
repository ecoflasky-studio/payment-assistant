/** 性能基准：生成大量账单，测各页面用到的计算（npx vite-node scripts/bench.ts） */
import type { Bill, Merchant } from '../src/lib/types';
import { searchAll, buildReport, cashPlan, merchantOverview, aging, tagStats } from '../src/lib/insights';
import { dailyTotals, monthSummary } from '../src/lib/monthly';
import { monthFlow, flowSeries, forecast } from '../src/lib/flow';
import { billStatus } from '../src/lib/status';

const N = Number(process.env.N || 5000);
const today = '2026-10-28';
const merchants: Merchant[] = Array.from({ length: 60 }, (_, i) => ({ id: 'm' + i, name: `Fornecedor ${i}`, type: i % 5 ? 'supplier' : 'payee', aliases: [], active: true, defaultAccountId: null }) as any);
const iso = (d: number) => new Date(Date.UTC(2024, 0, 1) + d * 86400000).toISOString().slice(0, 10);
const bills: Bill[] = Array.from({ length: N }, (_, i) => {
  const d = (i * 7) % 1100;
  const total = 1000 + ((i * 7919) % 500000);
  const paid = d < 1000 && i % 4;
  return {
    id: 'b' + i, merchantId: 'm' + (i % 60), merchantNameSnapshot: `Fornecedor ${i % 60}`, orderNumber: String(100000 + i), billDate: iso(d), dueDate: iso(d + 28),
    accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: paid ? iso(d + 25) + 'T12:00:00Z' : null, notes: i % 9 ? '' : 'nota fiscal pendente',
    items: Array.from({ length: 3 }, (_, k) => ({ id: `${i}-${k}`, description: `MOD-${(i + k) % 300}`, quantity: 1 + k, unitPriceCents: Math.round(total / 6), subtotalCents: Math.round(total / 6) * (1 + k) })),
    totalCents: total, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1, tags: i % 11 ? [] : ['loja-a'],
  } as any;
});

function time(name: string, fn: () => unknown, runs = 5) {
  fn();
  const t = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = (performance.now() - t) / runs;
  console.log(`${ms.toFixed(1).padStart(8)} ms  ${name}`);
  return ms;
}
console.log(`账单 ${N} 张`);
time('billStatus × N', () => bills.map((b) => billStatus(b, today)));
time('monthSummary', () => monthSummary(bills, '2026-10', today));
time('dailyTotals', () => dailyTotals(bills));
time('searchAll "290"', () => searchAll('290', bills, merchants, today));
time('searchAll "mod-12"', () => searchAll('mod-12', bills, merchants, today));
time('searchAll "#loja-a"', () => searchAll('#loja-a', bills, merchants, today));
time('buildReport 年', () => buildReport(bills, { kind: 'year', y: '2026' }));
time('buildReport 月', () => buildReport(bills, { kind: 'month', ym: '2026-10' }));
time('cashPlan', () => cashPlan(bills, today, 12, 100000));
time('merchantOverview', () => merchantOverview(bills, merchants, today));
time('aging', () => aging(bills, today));
time('tagStats', () => tagStats(bills, today));
time('monthFlow', () => monthFlow(bills, '2026-10'));
time('flowSeries 12', () => flowSeries(bills, '2026-10', 12));
time('forecast', () => forecast(bills, today));
