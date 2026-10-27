/**
 * 整合信息：全局搜索、标签、账龄、商家对账总览、月报/年报、现金流预测。
 * 全部是纯函数（金额为整数分），页面只负责展示。
 */
import type { Bill, Merchant } from './types';
import { addDays, diffDays, shiftMonth } from './dates';
import { billTitle, categoryLabel, isExpense } from './expense';
import { openCents, paidCents, paymentEvents, paymentsOf } from './payments';
import { nextDueDate } from './recurrence';
import { parseBRL } from './money';

const live = (bills: Bill[]) => bills.filter((b) => !b.deletedAt);
const sum = (l: number[]) => l.reduce((a, x) => a + x, 0);

/* ------------------------------------------------------------------ 标签 */

/** 标签规范化：去掉 #、首尾空白，多个空白合并；最长 24 字 */
export function normTag(t: string): string {
  return t.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

/** 解析输入的标签（逗号、空格、# 分隔都可以），去重 */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,，;；#\n]+/)) {
    const t = normTag(raw);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, 12);
}

export interface TagStat {
  tag: string;
  count: number;
  totalCents: number;
  openCents: number;
  overdueCount: number;
  lastDue: string;
}

export function tagStats(bills: Bill[], today: string): TagStat[] {
  const m = new Map<string, TagStat>();
  for (const b of live(bills)) {
    for (const t of b.tags ?? []) {
      const k = t.toLowerCase();
      const s = m.get(k) ?? { tag: t, count: 0, totalCents: 0, openCents: 0, overdueCount: 0, lastDue: '' };
      s.count++;
      s.totalCents += b.totalCents;
      s.openCents += openCents(b);
      if (!b.paidAt && b.dueDate < today) s.overdueCount++;
      if (b.dueDate > s.lastDue) s.lastDue = b.dueDate;
      m.set(k, s);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/* ------------------------------------------------------------------ 全局搜索 */

export interface SearchResult {
  bills: { bill: Bill; score: number; why: string }[];
  merchants: { merchant: Merchant; openCents: number; count: number }[];
  tags: TagStat[];
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * 一个搜索框搜所有东西：商家名/别名、单号、金额（"290"、"290,00"、"1.234,56"）、
 * 明细型号、备注、标签、付款码。多个词之间是「并且」。
 */
export function searchAll(query: string, bills: Bill[], merchants: Merchant[], today: string, limit = 30): SearchResult {
  const q = query.trim();
  const empty: SearchResult = { bills: [], merchants: [], tags: [] };
  if (!q) return empty;
  const words = fold(q).split(/\s+/).filter(Boolean);
  const tagQuery = q.startsWith('#') ? fold(normTag(q)) : null;
  // 整个输入像金额时按金额精确匹配（总额、还差多少、某一行小计）
  const money = /^r?\$?\s*[\d.,]+$/i.test(q) ? parseBRL(q.replace(/^r?\$?\s*/i, '')).cents : null;
  const mName = new Map(merchants.map((m) => [m.id, m]));

  const scored: SearchResult['bills'] = [];
  for (const b of live(bills)) {
    const m = b.merchantId ? mName.get(b.merchantId) : undefined;
    const tags = b.tags ?? [];
    if (tagQuery !== null) {
      if (tags.some((t) => fold(t) === tagQuery)) scored.push({ bill: b, score: 100, why: `#${tags.find((t) => fold(t) === tagQuery)}` });
      continue;
    }
    if (money !== null && money > 0) {
      const amounts = [b.totalCents, openCents(b), ...b.items.map((i) => i.subtotalCents), ...paymentsOf(b).map((p) => p.cents)];
      if (amounts.includes(money)) {
        scored.push({ bill: b, score: b.totalCents === money ? 90 : 70, why: b.totalCents === money ? '金额相同' : '包含这个金额' });
        continue;
      }
      // 只输入整数时，也匹配整数部分（"290" → 290,00 / 290,50）
      if (/^\d+$/.test(q) && amounts.some((a) => Math.floor(a / 100) === Number(q))) {
        scored.push({ bill: b, score: 60, why: '金额接近' });
        continue;
      }
    }
    const fields: [string, string, number][] = [
      ['商家', fold([billTitle(b), b.merchantNameSnapshot, ...(m ? [m.name, ...m.aliases] : [])].join(' ')), 40],
      ['单号', fold(b.orderNumber ?? ''), 50],
      ['标签', fold(tags.join(' ')), 45],
      ['型号', fold(b.items.map((i) => i.description).join(' ')), 25],
      ['备注', fold(b.notes ?? ''), 20],
      ['分类', fold(isExpense(b) ? categoryLabel(b.category ?? '') : ''), 15],
      ['付款码', (b.paymentCode ?? '').replace(/\D/g, ''), 10],
    ];
    let score = 0;
    let why = '';
    let all = true;
    for (const w of words) {
      const hit = fields.find(([, text]) => text && text.includes(w.replace(/^#/, '')));
      if (!hit) {
        all = false;
        break;
      }
      score += hit[2] + (hit[1].startsWith(w) ? 5 : 0);
      if (!why) why = hit[0];
    }
    if (all && score) scored.push({ bill: b, score: score + (b.paidAt ? 0 : 3), why });
  }
  scored.sort((a, b) => b.score - a.score || (a.bill.paidAt ? 1 : 0) - (b.bill.paidAt ? 1 : 0) || b.bill.dueDate.localeCompare(a.bill.dueDate));

  const ms = tagQuery !== null || money !== null
    ? []
    : merchants
        .filter((m) => m.active && words.every((w) => fold([m.name, ...m.aliases].join(' ')).includes(w)))
        .map((merchant) => {
          const own = live(bills).filter((b) => b.merchantId === merchant.id);
          return { merchant, openCents: sum(own.map(openCents)), count: own.length };
        })
        .sort((a, b) => b.openCents - a.openCents)
        .slice(0, 6);
  const tags = tagStats(bills, today).filter((t) => words.every((w) => fold(t.tag).includes(w.replace(/^#/, '')))).slice(0, 6);
  return { bills: scored.slice(0, limit), merchants: ms, tags };
}

/* ------------------------------------------------------------------ 账龄 */

export interface Aging {
  /** 未到期 */
  current: number;
  /** 逾期 1–30 天 */
  d30: number;
  /** 逾期 31–60 天 */
  d60: number;
  /** 逾期 60 天以上 */
  d60plus: number;
  total: number;
  /** 7 天内到期（未到期里的一部分） */
  soon: number;
}

export function aging(bills: Bill[], today: string, soonDays = 7): Aging {
  const a: Aging = { current: 0, d30: 0, d60: 0, d60plus: 0, total: 0, soon: 0 };
  for (const b of live(bills)) {
    const o = openCents(b);
    if (!o) continue;
    a.total += o;
    const late = diffDays(b.dueDate, today);
    if (late <= 0) {
      a.current += o;
      if (-late <= soonDays) a.soon += o;
    } else if (late <= 30) a.d30 += o;
    else if (late <= 60) a.d60 += o;
    else a.d60plus += o;
  }
  return a;
}

/* ------------------------------------------------------------------ 商家对账总览 */

export interface MerchantRow {
  merchant: Merchant;
  openCents: number;
  openCount: number;
  overdueCents: number;
  aging: Aging;
  /** 近 6 个月每月采购额（开单金额），最早的在前 */
  trend: number[];
  /** 平均实际付款天数（开单 → 付清） */
  avgPayDays: number | null;
  /** 按时付清比例 0–100 */
  onTimePct: number | null;
  lastBillDate: string | null;
  nextDue: string | null;
  count: number;
}

export function merchantOverview(bills: Bill[], merchants: Merchant[], today: string, type: 'supplier' | 'payee' | 'all' = 'supplier'): MerchantRow[] {
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(today.slice(0, 7), i - 5));
  return merchants
    .filter((m) => type === 'all' || (m.type ?? 'supplier') === type)
    .map((merchant) => {
      const own = live(bills).filter((b) => b.merchantId === merchant.id);
      const open = own.filter((b) => !b.paidAt);
      const settled = own.filter((b) => b.paidAt);
      const pay = settled.map((b) => paymentsOf(b).slice(-1)[0]).filter(Boolean);
      const payDays = settled.map((b, i) => (pay[i] ? diffDays(b.billDate, pay[i].date) : -1)).filter((d) => d >= 0);
      return {
        merchant,
        openCents: sum(open.map(openCents)),
        openCount: open.length,
        overdueCents: sum(open.filter((b) => b.dueDate < today).map(openCents)),
        aging: aging(open, today),
        trend: months.map((ym) => sum(own.filter((b) => b.billDate.slice(0, 7) === ym).map((b) => b.totalCents))),
        avgPayDays: payDays.length ? Math.round(sum(payDays) / payDays.length) : null,
        onTimePct: settled.length ? Math.round((settled.filter((b) => (paymentsOf(b).slice(-1)[0]?.date ?? '9') <= b.dueDate).length / settled.length) * 100) : null,
        lastBillDate: own.reduce<string | null>((a, b) => (!a || b.billDate > a ? b.billDate : a), null),
        nextDue: open.reduce<string | null>((a, b) => (!a || b.dueDate < a ? b.dueDate : a), null),
        count: own.length,
      };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.overdueCents - a.overdueCents || b.openCents - a.openCents || (b.lastBillDate ?? '').localeCompare(a.lastBillDate ?? ''));
}

/* ------------------------------------------------------------------ 月报 / 年报 */

export type Period = { kind: 'month'; ym: string } | { kind: 'year'; y: string };

export const periodLabel = (p: Period) => (p.kind === 'month' ? `${p.ym.slice(0, 4)} 年 ${Number(p.ym.slice(5))} 月` : `${p.y} 年`);
const inPeriod = (iso: string, p: Period) => (p.kind === 'month' ? iso.slice(0, 7) === p.ym : iso.slice(0, 4) === p.y);
export const prevPeriod = (p: Period): Period => (p.kind === 'month' ? { kind: 'month', ym: shiftMonth(p.ym, -1) } : { kind: 'year', y: String(Number(p.y) - 1) });
/** 去年同期 */
export const lastYearPeriod = (p: Period): Period => (p.kind === 'month' ? { kind: 'month', ym: shiftMonth(p.ym, -12) } : { kind: 'year', y: String(Number(p.y) - 1) });

export interface RankRow {
  key: string;
  label: string;
  cents: number;
  count: number;
  merchantId?: string | null;
}

export interface Report {
  period: Period;
  /** 实际付出去的钱（按付款日） */
  paidCents: number;
  payCount: number;
  supplierPaid: number;
  expensePaid: number;
  /** 新开账期（按开单日） */
  billedCents: number;
  billedCount: number;
  /** 本期到期的账单 */
  dueCount: number;
  dueCents: number;
  /** 本期到期且按时付清 */
  onTimeCount: number;
  /** 本期到期、到今天还没付清 */
  stillOpenCents: number;
  /** 平均实际付款天数 */
  avgPayDays: number | null;
  /** 付款排行（商家 / 缴费分类） */
  byMerchant: RankRow[];
  byCategory: RankRow[];
  byTag: RankRow[];
  /** 采购最多的型号（按开单日、商家货款明细） */
  topItems: { desc: string; qty: number; cents: number; merchant: string }[];
  /** 年报：每月实付；月报：每天实付 */
  series: { key: string; label: string; cents: number }[];
  prevPaidCents: number;
  lastYearPaidCents: number;
  /** 最大的一笔付款 */
  biggest: { title: string; cents: number; date: string } | null;
}

export function buildReport(bills: Bill[], p: Period): Report {
  const all = live(bills);
  const events = paymentEvents(all);
  const ev = events.filter((e) => inPeriod(e.date, p));
  const billed = all.filter((b) => inPeriod(b.billDate, p));
  const due = all.filter((b) => inPeriod(b.dueDate, p));
  const settledIn = all.filter((b) => b.paidAt && inPeriod(paymentsOf(b).slice(-1)[0]?.date ?? '', p));
  const payDays = settledIn.map((b) => diffDays(b.billDate, paymentsOf(b).slice(-1)[0].date)).filter((d) => d >= 0);

  const rank = (keyOf: (b: Bill) => { key: string; label: string; merchantId?: string | null } | null): RankRow[] => {
    const m = new Map<string, RankRow>();
    for (const e of ev) {
      const k = keyOf(e.bill);
      if (!k) continue;
      const r = m.get(k.key) ?? { ...k, cents: 0, count: 0 };
      r.cents += e.cents;
      r.count++;
      m.set(k.key, r);
    }
    return [...m.values()].sort((a, b) => b.cents - a.cents);
  };
  const byTag: RankRow[] = [];
  {
    const m = new Map<string, RankRow>();
    for (const e of ev) for (const t of e.bill.tags ?? []) {
      const r = m.get(t.toLowerCase()) ?? { key: t.toLowerCase(), label: `#${t}`, cents: 0, count: 0 };
      r.cents += e.cents;
      r.count++;
      m.set(t.toLowerCase(), r);
    }
    byTag.push(...[...m.values()].sort((a, b) => b.cents - a.cents));
  }
  const items = new Map<string, { desc: string; qty: number; cents: number; merchant: string }>();
  for (const b of billed) {
    if (isExpense(b) || b.amountMode === 'total') continue;
    for (const i of b.items) {
      const desc = i.description.trim();
      if (!desc) continue;
      const k = `${b.merchantId ?? b.merchantNameSnapshot}|${desc.toUpperCase()}`;
      const r = items.get(k) ?? { desc, qty: 0, cents: 0, merchant: billTitle(b) };
      r.qty += i.quantity;
      r.cents += i.subtotalCents;
      items.set(k, r);
    }
  }
  let series: Report['series'];
  if (p.kind === 'year') {
    series = Array.from({ length: 12 }, (_, i) => {
      const ym = `${p.y}-${String(i + 1).padStart(2, '0')}`;
      return { key: ym, label: `${i + 1}月`, cents: sum(events.filter((e) => e.date.slice(0, 7) === ym).map((e) => e.cents)) };
    });
  } else {
    const days = new Date(Date.UTC(Number(p.ym.slice(0, 4)), Number(p.ym.slice(5)), 0)).getUTCDate();
    series = Array.from({ length: days }, (_, i) => {
      const d = `${p.ym}-${String(i + 1).padStart(2, '0')}`;
      return { key: d, label: String(i + 1), cents: sum(ev.filter((e) => e.date === d).map((e) => e.cents)) };
    });
  }
  const paidIn = (pp: Period) => sum(events.filter((e) => inPeriod(e.date, pp)).map((e) => e.cents));
  const big = ev.reduce<(typeof ev)[number] | null>((a, e) => (!a || e.cents > a.cents ? e : a), null);
  return {
    period: p,
    paidCents: sum(ev.map((e) => e.cents)),
    payCount: ev.length,
    supplierPaid: sum(ev.filter((e) => !isExpense(e.bill)).map((e) => e.cents)),
    expensePaid: sum(ev.filter((e) => isExpense(e.bill)).map((e) => e.cents)),
    billedCents: sum(billed.map((b) => b.totalCents)),
    billedCount: billed.length,
    dueCount: due.length,
    dueCents: sum(due.map((b) => b.totalCents)),
    onTimeCount: due.filter((b) => b.paidAt && (paymentsOf(b).slice(-1)[0]?.date ?? '9') <= b.dueDate).length,
    stillOpenCents: sum(due.filter((b) => !b.paidAt).map(openCents)),
    avgPayDays: payDays.length ? Math.round(sum(payDays) / payDays.length) : null,
    byMerchant: rank((b) => (isExpense(b) ? null : { key: b.merchantId ?? `n:${b.merchantNameSnapshot}`, label: billTitle(b), merchantId: b.merchantId })),
    byCategory: rank((b) => (isExpense(b) ? { key: b.category ?? 'other', label: categoryLabel(b.category ?? 'other') } : { key: '__supplier', label: '商家货款' })),
    byTag,
    topItems: [...items.values()].sort((a, b) => b.cents - a.cents).slice(0, 8),
    series,
    prevPaidCents: paidIn(prevPeriod(p)),
    lastYearPaidCents: paidIn(lastYearPeriod(p)),
    biggest: big ? { title: billTitle(big.bill), cents: big.cents, date: big.date } : null,
  };
}

/** 报表的文字摘要（复制 / 分享给会计或合伙人） */
export function reportText(r: Report, fmt: (c: number) => string): string {
  const pct = (a: number, b: number) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%` : '—');
  const lines = [
    `账期助手 · ${periodLabel(r.period)}${r.period.kind === 'month' ? '月报' : '年报'}`,
    `实付 ${fmt(r.paidCents)}（${r.payCount} 笔；比上期 ${pct(r.paidCents, r.prevPaidCents)}，比去年同期 ${pct(r.paidCents, r.lastYearPaidCents)}）`,
    `  商家货款 ${fmt(r.supplierPaid)} · 日常缴费 ${fmt(r.expensePaid)}`,
    `新开账期 ${fmt(r.billedCents)}（${r.billedCount} 笔）`,
    `到期 ${r.dueCount} 笔，按时付清 ${r.onTimeCount} 笔${r.stillOpenCents ? `，仍未付 ${fmt(r.stillOpenCents)}` : ''}`,
  ];
  if (r.avgPayDays !== null) lines.push(`平均开单后 ${r.avgPayDays} 天付清`);
  if (r.byMerchant.length) lines.push('', '付款最多的商家：', ...r.byMerchant.slice(0, 5).map((x, i) => `${i + 1}. ${x.label} ${fmt(x.cents)}`));
  const cats = r.byCategory.filter((x) => x.key !== '__supplier');
  if (cats.length) lines.push('', '日常缴费：', ...cats.slice(0, 6).map((x) => `- ${x.label} ${fmt(x.cents)}`));
  if (r.byTag.length) lines.push('', '按标签：', ...r.byTag.slice(0, 6).map((x) => `- ${x.label} ${fmt(x.cents)}`));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ 现金流预测 */

export interface CashWeek {
  from: string;
  to: string;
  /** 已有账单要付的钱 */
  cents: number;
  /** 重复账单推算出来、还没生成的（预估） */
  projected: number;
  count: number;
  /** 期末余额（设置了可用资金时） */
  balance: number | null;
  items: { title: string; due: string; cents: number; projected: boolean; billId: string | null; merchantId: string | null }[];
}

export interface CashPlan {
  overdueCents: number;
  overdueCount: number;
  weeks: CashWeek[];
  totalCents: number;
  /** 第一次余额不够的那一周 */
  shortWeek: number | null;
  /** 最低余额 */
  lowest: number | null;
}

/**
 * 未来 n 周要付的钱：
 *  - 已有的未付账单（还差多少）；逾期的放在「现在就要付」
 *  - 重复账单（每月水电、房租…）按周期推算后面几期（预估，标记出来）
 *  - 填了可用资金时，逐周扣减算出余额，提示哪一周不够
 */
export function cashPlan(bills: Bill[], today: string, weeks = 12, startBalance: number | null = null): CashPlan {
  const all = live(bills);
  const unpaid = all.filter((b) => !b.paidAt && openCents(b) > 0);
  const overdue = unpaid.filter((b) => b.dueDate < today);
  const end = addDays(today, weeks * 7 - 1);
  // 每个重复系列：取最晚的一期，往后推算到期日
  const series = new Map<string, Bill>();
  for (const b of all) {
    const sid = b.recurrence?.seriesId;
    if (!sid) continue;
    const cur = series.get(sid);
    if (!cur || b.dueDate > cur.dueDate) series.set(sid, b);
  }
  const projected: CashWeek['items'] = [];
  for (const b of series.values()) {
    let due = b.dueDate;
    for (let n = 0; n < 60; n++) {
      due = nextDueDate(due, b.recurrence!);
      if (due > end || (b.recurrence!.until && due > b.recurrence!.until)) break;
      if (due < today) continue;
      projected.push({ title: billTitle(b), due, cents: b.totalCents, projected: true, billId: null, merchantId: b.merchantId });
    }
  }
  const out: CashPlan = { overdueCents: sum(overdue.map(openCents)), overdueCount: overdue.length, weeks: [], totalCents: 0, shortWeek: null, lowest: null };
  let bal = startBalance === null ? null : startBalance - out.overdueCents;
  if (bal !== null) out.lowest = bal;
  if (bal !== null && bal < 0) out.shortWeek = -1;
  for (let i = 0; i < weeks; i++) {
    const from = addDays(today, i * 7);
    const to = addDays(today, i * 7 + 6);
    const real = unpaid
      .filter((b) => b.dueDate >= from && b.dueDate <= to)
      .map((b) => ({ title: billTitle(b), due: b.dueDate, cents: openCents(b), projected: false, billId: b.id, merchantId: b.merchantId }));
    const proj = projected.filter((x) => x.due >= from && x.due <= to);
    const items = [...real, ...proj].sort((a, b) => a.due.localeCompare(b.due) || b.cents - a.cents);
    const cents = sum(real.map((x) => x.cents));
    const pc = sum(proj.map((x) => x.cents));
    if (bal !== null) {
      bal -= cents + pc;
      if (out.lowest === null || bal < out.lowest) out.lowest = bal;
      if (bal < 0 && out.shortWeek === null) out.shortWeek = i;
    }
    out.weeks.push({ from, to, cents, projected: pc, count: items.length, balance: bal, items });
    out.totalCents += cents + pc;
  }
  return out;
}

/** 单个商家的对账文字（发给对方核对）：未付账单逐笔 + 合计 + 最近付款 */
export function reconcileText(merchantName: string, bills: Bill[], merchantId: string, today: string, fmt: (c: number) => string, br: (iso: string) => string): string {
  const own = live(bills).filter((b) => b.merchantId === merchantId);
  const open = own.filter((b) => !b.paidAt).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const recent = own.flatMap((b) => paymentsOf(b).map((p) => ({ p, b }))).sort((a, b) => b.p.date.localeCompare(a.p.date)).slice(0, 5);
  const lines = [`${merchantName} 对账（截至 ${br(today)}）`, ''];
  if (open.length) {
    lines.push('未付：');
    for (const b of open) lines.push(`- ${br(b.billDate)} 开单${b.orderNumber ? ` #${b.orderNumber}` : ''}，${br(b.dueDate)} 到期：${fmt(openCents(b))}${paidCents(b) ? `（已付 ${fmt(paidCents(b))}）` : ''}${b.dueDate < today ? ' · 已逾期' : ''}`);
    lines.push(`合计未付：${fmt(sum(open.map(openCents)))}（${open.length} 笔）`);
  } else lines.push('目前没有未付账单。');
  if (recent.length) {
    lines.push('', '最近付款：');
    for (const { p, b } of recent) lines.push(`- ${br(p.date)} ${fmt(p.cents)}${b.orderNumber ? `（#${b.orderNumber}）` : ''}`);
  }
  return lines.join('\n');
}
