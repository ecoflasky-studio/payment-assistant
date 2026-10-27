/** 月度账期统计 */
import type { Bill } from './types';
import { billStatus } from './status';
import { sumCents } from './money';
import { openCents, paidCents as paidOf } from './payments';

export interface MonthSummary {
  month: string; // YYYY-MM
  totalCents: number;
  count: number;
  paidCents: number;
  paidCount: number;
  unpaidCents: number;
  unpaidCount: number;
  overdueCents: number;
  overdueCount: number;
}

/** 以到期日所在月份统计（本月要付的钱） */
export function monthSummary(bills: Bill[], month: string, today: string): MonthSummary {
  const list = bills.filter((b) => b.dueDate.slice(0, 7) === month);
  const paid = list.filter((b) => b.paidAt);
  const unpaid = list.filter((b) => !b.paidAt);
  const overdue = unpaid.filter((b) => billStatus(b, today) === 'overdue');
  return {
    month,
    totalCents: sumCents(list.map((b) => b.totalCents)),
    count: list.length,
    paidCents: sumCents([...paid.map((b) => b.totalCents), ...unpaid.map(paidOf)]),
    paidCount: paid.length,
    unpaidCents: sumCents(unpaid.map(openCents)),
    unpaidCount: unpaid.length,
    overdueCents: sumCents(overdue.map(openCents)),
    overdueCount: overdue.length,
  };
}

export interface DayPart {
  /** 商家识别色序号（mc-N） */
  slot: number;
  cents: number;
  paid: boolean;
}

export interface DayTotal {
  cents: number;
  unpaidCents: number;
  count: number;
  unpaidCount: number;
  /** 按商家颜色拆开的金额（未付在前，金额大的在前） */
  parts: DayPart[];
}

/** 按到期日汇总（用于月历与日期选择器上的提示） */
export function dailyTotals(bills: Bill[], opts: { excludeId?: string; slotOf?: (b: Bill) => number } = {}): Map<string, DayTotal> {
  const m = new Map<string, DayTotal>();
  for (const b of bills) {
    if (b.id === opts.excludeId) continue;
    const e = m.get(b.dueDate) ?? { cents: 0, unpaidCents: 0, count: 0, unpaidCount: 0, parts: [] };
    e.cents += b.totalCents;
    e.count++;
    const paid = !!b.paidAt;
    const amt = paid ? b.totalCents : openCents(b);
    if (!paid) {
      e.unpaidCents += amt;
      e.unpaidCount++;
    }
    const slot = opts.slotOf ? opts.slotOf(b) : -1;
    const part = e.parts.find((p) => p.slot === slot && p.paid === paid);
    if (part) part.cents += amt;
    else e.parts.push({ slot, cents: amt, paid });
    m.set(b.dueDate, e);
  }
  for (const e of m.values()) e.parts.sort((a, b) => Number(a.paid) - Number(b.paid) || b.cents - a.cents);
  return m;
}

/** 月历角标：按付款时限 红=逾期 黄=即将到期 绿=时间充裕；当天全部已付 = paid */
export type DayUrgency = 'late' | 'soon' | 'fine' | 'paid';
export function dayUrgency(day: string, t: Pick<DayTotal, 'count' | 'unpaidCount'>, today: string, dueSoonDays = 7): DayUrgency | null {
  if (!t.count) return null;
  if (!t.unpaidCount) return 'paid';
  const st = billStatus({ dueDate: day, paidAt: null }, today, dueSoonDays);
  return st === 'overdue' ? 'late' : st === 'dueSoon' ? 'soon' : 'fine';
}

export function compactBRL(cents: number): string {
  const v = cents / 100;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace('.', ',')}k`;
  return String(Math.round(v));
}
