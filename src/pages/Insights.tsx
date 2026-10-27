/**
 * 报表中心：月报 / 年报、现金流预测、商家对账总览，以及全局搜索。
 * 计算都在 lib/insights.ts（纯函数），这里只负责展示。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type Route } from '../store';
import { useFeedback, Modal } from '../ui/feedback';
import { formatBRL, centsToInput, parseBRL } from '../lib/money';
import { formatBR, shiftMonth, weekdayCN } from '../lib/dates';
import { colorSlot } from '../lib/colors';
import { compactBRL } from '../lib/monthly';
import { copyText } from '../lib/platform';
import { billTitle } from '../lib/expense';
import { aging, buildReport, cashPlan, merchantOverview, periodLabel, reconcileText, reportText, searchAll, tagStats, type Aging, type MerchantRow, type Period, type RankRow } from '../lib/insights';
import { BillRow, MerchantAvatar } from '../ui/BillList';
import { BillCard } from '../ui/BillCard';
import { ICopy, ISearch, IChart, IX } from '../ui/icons';
import type { Bill, Merchant } from '../lib/types';

/* ------------------------------------------------------------------ 顶部分区 */

const TABS: { r: Route['name']; label: string }[] = [
  { r: 'flow', label: '流水' },
  { r: 'report', label: '月报 / 年报' },
  { r: 'cashflow', label: '现金流' },
  { r: 'reconcile', label: '商家对账' },
];

export function ReportTabs({ current }: { current: Route['name'] }) {
  const { go } = useStore();
  return (
    <nav className="rtabs no-print" aria-label="报表">
      {TABS.map((t) => (
        <button key={t.r} type="button" aria-current={t.r === current ? 'page' : undefined} onClick={() => go({ name: t.r } as Route, true)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
function Delta({ cur, prev, label }: { cur: number; prev: number; label: string }) {
  const p = pct(cur, prev);
  if (p === null) return <span className="delta">— <small>{label}无数据</small></span>;
  return (
    <span className={`delta ${p > 0 ? 'up' : p < 0 ? 'down' : ''}`} title={`${label} ${formatBRL(prev)}`}>
      {p > 0 ? '▲' : p < 0 ? '▼' : '='} {Math.abs(p)}% <small>{label}</small>
    </span>
  );
}

/** 横向排行条 */
function RankList({ rows, total, merchants, max = 8 }: { rows: RankRow[]; total: number; merchants?: Merchant[]; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, max);
  return (
    <div className="rank">
      {shown.map((r) => {
        const m = r.merchantId ? merchants?.find((x) => x.id === r.merchantId) ?? null : null;
        const slot = colorSlot(m, m?.id ?? r.key);
        return (
          <div key={r.key} className={`rank-row mc-${slot}`}>
            <span className="rank-l">
              <b>{r.label}</b>
              <small>{r.count} 笔</small>
            </span>
            <span className="rank-bar" aria-hidden="true">
              <i style={{ width: `${total ? Math.max(2, (r.cents / total) * 100) : 0}%` }} />
            </span>
            <span className="rank-v num">
              {formatBRL(r.cents, false)}
              <small>{total ? Math.round((r.cents / total) * 100) : 0}%</small>
            </span>
          </div>
        );
      })}
      {rows.length > max && (
        <button type="button" className="linkbtn small" onClick={() => setAll((v) => !v)}>
          {all ? '收起' : `还有 ${rows.length - max} 项`}
        </button>
      )}
    </div>
  );
}

/** 小走势线 */
function Spark({ values, slot, label }: { values: number[]; slot: number; label: string }) {
  const max = Math.max(1, ...values);
  const w = 84;
  const h = 26;
  const pts = values.map((v, i) => [2 + (i * (w - 4)) / Math.max(1, values.length - 1), h - 3 - (v / max) * (h - 6)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return (
    <svg className={`spark mc-${slot}`} viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={label}>
      <path d={`${d} L ${pts.at(-1)![0]} ${h} L ${pts[0][0]} ${h} Z`} className="spark-a" />
      <path d={d} className="spark-l" />
      <circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r={2.6} className="spark-p" />
    </svg>
  );
}

function AgingBar({ a, big = false }: { a: Aging; big?: boolean }) {
  const parts: [string, number, string][] = [
    ['未到期', a.current, 'ok'],
    ['逾期 1–30 天', a.d30, 'w1'],
    ['逾期 31–60 天', a.d60, 'w2'],
    ['逾期 60 天以上', a.d60plus, 'w3'],
  ];
  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className={`agebar${big ? ' big' : ''}`} role="img" aria-label={parts.map(([l, v]) => `${l} ${formatBRL(v)}`).join('，')}>
        {parts.map(([l, v, c]) => v > 0 && <i key={l} className={`ag-${c}`} style={{ flexGrow: v }} />)}
      </span>
      {big && (
        <ul className="agelegend">
          {parts.map(([l, v, c]) => (
            <li key={l}>
              <i className={`ag-${c}`} />
              <span>{l}</span>
              <b className="num">{formatBRL(v)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 月报 / 年报 */

export function ReportPage({ period: initial }: { period?: string }) {
  const { bills, merchants, today, go } = useStore();
  const fb = useFeedback();
  const parse = (s?: string): Period => (s && /^\d{4}$/.test(s) ? { kind: 'year', y: s } : { kind: 'month', ym: s && /^\d{4}-\d{2}$/.test(s) ? s : shiftMonth(today.slice(0, 7), today.slice(8) < '05' ? -1 : 0) });
  const [p, setP] = useState<Period>(() => parse(initial));
  const key = p.kind === 'month' ? p.ym : p.y;
  useEffect(() => go({ name: 'report', period: key }, true), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = useMemo(() => buildReport(bills, p), [bills, p]);
  const shift = (n: number) => setP(p.kind === 'month' ? { kind: 'month', ym: shiftMonth(p.ym, n) } : { kind: 'year', y: String(Number(p.y) + n) });
  const isFuture = p.kind === 'month' ? p.ym > today.slice(0, 7) : p.y > today.slice(0, 4);
  const max = Math.max(1, ...r.series.map((x) => x.cents));
  const cats = r.byCategory;
  const text = reportText(r, (c) => formatBRL(c));
  const word = p.kind === 'month' ? '月报' : '年报';

  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: `${periodLabel(p)}${word}`, text });
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
    const ok = await copyText(text);
    fb.toast(ok ? `${word}摘要已复制，可以粘贴给会计或合伙人` : '复制失败', { bad: !ok });
  };

  return (
    <>
      <ReportTabs current="report" />
      <section className="card stack report-head">
        <div className="row between no-print">
          <div className="seg2" role="group" aria-label="报表周期" style={{ minWidth: 200 }}>
            <button type="button" aria-pressed={p.kind === 'month'} onClick={() => setP({ kind: 'month', ym: p.kind === 'year' ? `${p.y}-${today.slice(5, 7)}` : p.ym })}>
              月报
            </button>
            <button type="button" aria-pressed={p.kind === 'year'} onClick={() => setP({ kind: 'year', y: p.kind === 'month' ? p.ym.slice(0, 4) : p.y })}>
              年报
            </button>
          </div>
          <div className="mnav" style={{ margin: 0 }}>
            <button type="button" className="btn btn-ghost iconbtn" aria-label="上一期" onClick={() => shift(-1)}>
              ‹
            </button>
            <span className="mnav-t">{periodLabel(p)}</span>
            <button type="button" className="btn btn-ghost iconbtn" aria-label="下一期" onClick={() => shift(1)}>
              ›
            </button>
          </div>
        </div>
        <h2 className="print-only">账期助手 · {periodLabel(p)}{word}</h2>
        <div className="ov-top">
          <div className="stack" style={{ gap: 2 }}>
            <span className="ov-label">
              {periodLabel(p)}实付 · {r.payCount} 笔
            </span>
            <span className="ov-total num">
              <small>R$</small>
              {formatBRL(r.paidCents, false)}
            </span>
          </div>
          <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
            <Delta cur={r.paidCents} prev={r.prevPaidCents} label={p.kind === 'month' ? '比上月' : '比上年'} />
            {p.kind === 'month' && <Delta cur={r.paidCents} prev={r.lastYearPaidCents} label="比去年同月" />}
          </div>
        </div>
        <div className="kpis4">
          <div>
            <small>商家货款</small>
            <b className="num">{formatBRL(r.supplierPaid, false)}</b>
          </div>
          <div>
            <small>日常缴费</small>
            <b className="num">{formatBRL(r.expensePaid, false)}</b>
          </div>
          <div>
            <small>新开账期 · {r.billedCount}</small>
            <b className="num">{formatBRL(r.billedCents, false)}</b>
          </div>
          <div>
            <small>按时付清</small>
            <b className="num">{r.dueCount ? `${r.onTimeCount}/${r.dueCount}` : '—'}</b>
          </div>
        </div>
        <p className="xs muted" style={{ margin: 0 }}>
          {r.avgPayDays !== null ? `平均开单后 ${r.avgPayDays} 天付清。` : ''}
          {r.stillOpenCents ? `本期到期还有 ${formatBRL(r.stillOpenCents)} 没付。` : r.dueCount ? '本期到期的都已付清。' : ''}
          {r.biggest ? `最大一笔：${r.biggest.title} ${formatBRL(r.biggest.cents)}（${formatBR(r.biggest.date)}）。` : ''}
        </p>
        {isFuture && <div className="banner info small">这是未来的周期，只统计已经付出去的钱；要看将来要付多少请看「现金流」。</div>}
        <div className="row no-print">
          <button className="btn btn-sm btn-primary" onClick={share}>
            <ICopy />
            分享摘要
          </button>
          <button className="btn btn-sm" onClick={() => window.print()}>
            打印 / 存为 PDF
          </button>
        </div>
      </section>

      <section className="card stack">
        <h2 className="row">
          <IChart width={18} height={18} /> {p.kind === 'month' ? '每天付款' : '每月付款'}
        </h2>
        {r.paidCents ? (
          <div className={`rchart ${p.kind}`} role="img" aria-label={r.series.filter((x) => x.cents).map((x) => `${x.label}${p.kind === 'month' ? '日' : ''} ${formatBRL(x.cents)}`).join('，')}>
            {r.series.map((x) => (
              <span key={x.key} className="rbar" title={`${x.label}${p.kind === 'month' ? '日' : ''}：${formatBRL(x.cents)}`}>
                <span className="rcol">
                  <i style={{ height: `${(x.cents / max) * 100}%` }} />
                </span>
                <small>{p.kind === 'year' || Number(x.label) % 5 === 1 ? x.label : ''}</small>
              </span>
            ))}
          </div>
        ) : (
          <p className="muted small">这个周期还没有付款记录。</p>
        )}
      </section>

      {r.byMerchant.length > 0 && (
        <section className="card stack">
          <h2>付款最多的商家</h2>
          <RankList rows={r.byMerchant} total={r.supplierPaid} merchants={merchants} />
        </section>
      )}
      {cats.length > 1 && (
        <section className="card stack">
          <h2>支出构成</h2>
          <RankList rows={cats} total={r.paidCents} />
        </section>
      )}
      {r.byTag.length > 0 && (
        <section className="card stack">
          <h2>按标签</h2>
          <RankList rows={r.byTag} total={r.paidCents} />
          <p className="xs muted" style={{ margin: 0 }}>一笔账单可以有多个标签，所以合计可能超过 100%。</p>
        </section>
      )}
      {r.topItems.length > 0 && (
        <section className="card stack">
          <h2>进货最多的型号</h2>
          <div className="tablewrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th>型号 · 商家</th>
                  <th className="num">数量</th>
                  <th className="num">金额</th>
                </tr>
              </thead>
              <tbody>
                {r.topItems.map((i) => (
                  <tr key={i.merchant + i.desc}>
                    <td>
                      <b>{i.desc}</b>
                      <br />
                      <small className="muted">{i.merchant}</small>
                    </td>
                    <td className="num">{i.qty.toLocaleString('pt-BR')}</td>
                    <td className="num">{formatBRL(i.cents, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="xs muted" style={{ margin: 0 }}>按开单日期统计本期新开的商家账单明细。</p>
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ 现金流 */

export function CashflowPage() {
  const { bills, today, settings, saveSettings, merchants } = useStore();
  const fb = useFeedback();
  const [weeks, setWeeks] = useState(12);
  const cash = settings.cashOnHandCents ?? null;
  const [cashText, setCashText] = useState(cash !== null ? centsToInput(cash) : '');
  const plan = useMemo(() => cashPlan(bills, today, weeks, cash), [bills, today, weeks, cash]);
  const [openWeek, setOpenWeek] = useState<number | null>(0);
  const [bill, setBill] = useState<Bill | null>(null);
  const max = Math.max(1, ...plan.weeks.map((w) => w.cents + w.projected));
  const next4 = plan.weeks.slice(0, 4).reduce((a, w) => a + w.cents + w.projected, 0);
  // 未来 4 周按付款账号
  const byAccount = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of plan.weeks.slice(0, 4))
      for (const it of w.items) {
        const b = it.billId ? bills.find((x) => x.id === it.billId) : null;
        const k = b?.accountLabelSnapshot || '未指定账号';
        m.set(k, (m.get(k) ?? 0) + it.cents);
      }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [plan, bills]);

  const saveCash = () => {
    const t = cashText.trim();
    if (!t) {
      void saveSettings({ cashOnHandCents: null });
      fb.toast('已清除可用资金');
      return;
    }
    const p = parseBRL(t);
    if (p.cents === null || p.ambiguous) return fb.toast(p.error ?? '金额格式不对，例如 5.000,00', { bad: true });
    void saveSettings({ cashOnHandCents: p.cents });
    fb.toast(`可用资金：${formatBRL(p.cents)}`);
  };

  return (
    <>
      <ReportTabs current="cashflow" />
      <section className="card stack">
        <div className="ov-top">
          <div className="stack" style={{ gap: 2 }}>
            <span className="ov-label">未来 4 周要付</span>
            <span className="ov-total num">
              <small>R$</small>
              {formatBRL(next4, false)}
            </span>
          </div>
          <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
            <span className="xs muted">已逾期 · {plan.overdueCount} 笔</span>
            <b className={`num ${plan.overdueCents ? 'err' : ''}`}>{formatBRL(plan.overdueCents)}</b>
          </div>
        </div>
        <div className="field">
          <label htmlFor="cash">可用资金（选填，用来算每周余额）</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input id="cash" className="input num" inputMode="decimal" placeholder="例如 8.000,00" value={cashText} onChange={(e) => setCashText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveCash()} />
            <button className="btn" onClick={saveCash}>
              保存
            </button>
          </div>
        </div>
        {cash !== null && plan.shortWeek !== null && (
          <div className="banner bad" role="alert">
            <span className="grow">
              {plan.shortWeek < 0 ? '现有资金不够付清已逾期的账单' : `第 ${plan.shortWeek + 1} 周（${formatBR(plan.weeks[plan.shortWeek].from).slice(0, 5)} 起）资金不够`}，{(plan.lowest ?? 0) < 0 ? <>最多差 <b className="num">{formatBRL(-(plan.lowest ?? 0))}</b>。</> : null}可以和商家商量顺延，或提前准备资金。
            </span>
          </div>
        )}
        {cash !== null && plan.shortWeek === null && (
          <div className="banner ok small">
            <span className="grow">
              按现有资金，未来 {weeks} 周都够付，最低余额 <b className="num">{formatBRL(plan.lowest ?? cash)}</b>。
            </span>
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="row between">
          <h2>每周要付</h2>
          <div className="seg2" role="group" aria-label="预测范围" style={{ minWidth: 170 }}>
            {[6, 12].map((n) => (
              <button key={n} type="button" aria-pressed={weeks === n} onClick={() => setWeeks(n)}>
                {n} 周
              </button>
            ))}
          </div>
        </div>
        <div className="cweeks">
          {plan.weeks.map((w, i) => (
            <div key={w.from} className={`cweek${openWeek === i ? ' open' : ''}${w.balance !== null && w.balance < 0 ? ' short' : ''}`}>
              <button type="button" className="cweek-h" aria-expanded={openWeek === i} onClick={() => setOpenWeek(openWeek === i ? null : i)} disabled={!w.count}>
                <span className="cw-l">
                  <b>{i === 0 ? '本周' : `${formatBR(w.from).slice(0, 5)} – ${formatBR(w.to).slice(0, 5)}`}</b>
                  <small>{w.count ? `${w.count} 笔` : '没有'}</small>
                </span>
                <span className="cw-bar" aria-hidden="true">
                  <i className="real" style={{ width: `${(w.cents / max) * 100}%` }} />
                  <i className="proj" style={{ width: `${(w.projected / max) * 100}%` }} />
                </span>
                <span className="cw-v num">
                  {w.count ? formatBRL(w.cents + w.projected, false) : '—'}
                  {w.balance !== null && <small className={w.balance < 0 ? 'err' : ''}>余 {compactBRL(w.balance)}</small>}
                </span>
              </button>
              {openWeek === i && w.count > 0 && (
                <ul className="cw-items">
                  {w.items.map((it, k) => {
                    const m = it.merchantId ? merchants.find((x) => x.id === it.merchantId) ?? null : null;
                    return (
                      <li key={k}>
                        <button type="button" disabled={!it.billId} onClick={() => it.billId && setBill(bills.find((b) => b.id === it.billId) ?? null)}>
                          <span className={`mdot mc-${colorSlot(m, m?.id ?? it.title)}`} aria-hidden="true" />
                          <span className="grow">
                            {it.title}
                            {it.projected && <span className="tag warn">预估</span>}
                          </span>
                          <span className="xs muted num">
                            {formatBR(it.due).slice(0, 5)} {weekdayCN(it.due)}
                          </span>
                          <b className="num">{formatBRL(it.cents, false)}</b>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
        <p className="xs muted" style={{ margin: 0 }}>
          <i className="legend-sq real" /> 已有账单（按还差多少） <i className="legend-sq proj" /> 重复账单推算的下几期（预估，金额按上一期）
        </p>
      </section>

      {byAccount.length > 1 && (
        <section className="card stack">
          <h2>未来 4 周 · 按付款账号</h2>
          <RankList rows={byAccount.map(([k, v]) => ({ key: k, label: k, cents: v, count: 0 }))} total={byAccount.reduce((a, x) => a + x[1], 0)} />
        </section>
      )}
      {bill && (
        <Modal title={billTitle(bill)} onClose={() => setBill(null)}>
          <BillCard bill={bill} inSheet onDone={() => setBill(null)} />
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ 商家对账总览 */

export function ReconcilePage() {
  const { bills, merchants, today } = useStore();
  const [type, setType] = useState<'supplier' | 'payee'>('supplier');
  const rows = useMemo(() => merchantOverview(bills, merchants, today, type), [bills, merchants, today, type]);
  const all = useMemo(() => aging(bills.filter((b) => rows.some((r) => r.merchant.id === b.merchantId)), today), [bills, rows, today]);
  const [open, setOpen] = useState<Merchant | null>(null);
  return (
    <>
      <ReportTabs current="reconcile" />
      <section className="card stack">
        <div className="row between">
          <div className="seg2" role="group" aria-label="类型" style={{ minWidth: 200 }}>
            <button type="button" aria-pressed={type === 'supplier'} onClick={() => setType('supplier')}>
              商家
            </button>
            <button type="button" aria-pressed={type === 'payee'} onClick={() => setType('payee')}>
              缴费单位
            </button>
          </div>
        </div>
        <div className="ov-top">
          <div className="stack" style={{ gap: 2 }}>
            <span className="ov-label">一共欠 · {rows.filter((r) => r.openCents).length} 家</span>
            <span className="ov-total num">
              <small>R$</small>
              {formatBRL(all.total, false)}
            </span>
          </div>
          {all.total > 0 && (
            <span className="xs muted" style={{ textAlign: 'right' }}>
              逾期 <b className="err num">{formatBRL(all.d30 + all.d60 + all.d60plus)}</b>
            </span>
          )}
        </div>
        <AgingBar a={all} big />
      </section>

      {rows.length === 0 ? (
        <div className="card empty">
          <p>还没有{type === 'supplier' ? '商家' : '缴费单位'}的账单。</p>
        </div>
      ) : (
        <section className="card mlist" aria-label="对账列表">
          {rows.map((r) => (
            <MerchantLine key={r.merchant.id} r={r} onOpen={() => setOpen(r.merchant)} />
          ))}
        </section>
      )}
      {open && <MerchantDetail merchant={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function MerchantLine({ r, onOpen }: { r: MerchantRow; onOpen: () => void }) {
  const slot = colorSlot(r.merchant, r.merchant.id);
  return (
    <button type="button" className="mline" onClick={onOpen}>
      <MerchantAvatar merchant={r.merchant} name={r.merchant.name} />
      <span className="ml-main">
        <b>{r.merchant.name}</b>
        <small>
          {r.openCount ? `${r.openCount} 笔未付` : '已结清'}
          {r.avgPayDays !== null ? ` · 平均 ${r.avgPayDays} 天付清` : ''}
          {r.onTimePct !== null ? ` · 按时 ${r.onTimePct}%` : ''}
        </small>
        {r.openCents > 0 && <AgingBar a={r.aging} />}
      </span>
      <Spark values={r.trend} slot={slot} label={`近 6 个月采购 ${r.trend.map((v) => compactBRL(v)).join('、')}`} />
      <span className="ml-v num">
        {formatBRL(r.openCents, false)}
        {r.overdueCents > 0 && <small className="err">逾期 {compactBRL(r.overdueCents)}</small>}
      </span>
    </button>
  );
}

export function MerchantDetail({ merchant, onClose }: { merchant: Merchant; onClose: () => void }) {
  const { bills, merchants, today, go } = useStore();
  const fb = useFeedback();
  const r = useMemo(() => merchantOverview(bills, merchants, today, 'all').find((x) => x.merchant.id === merchant.id), [bills, merchants, today, merchant.id]);
  const own = useMemo(() => bills.filter((b) => b.merchantId === merchant.id && !b.paidAt).sort((a, b) => a.dueDate.localeCompare(b.dueDate)), [bills, merchant.id]);
  const [bill, setBill] = useState<Bill | null>(null);
  const slot = colorSlot(merchant, merchant.id);
  if (bill) {
    return (
      <Modal title={billTitle(bill)} onClose={() => setBill(null)}>
        <BillCard bill={bill} inSheet onDone={() => setBill(null)} />
      </Modal>
    );
  }
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(today.slice(0, 7), i - 5));
  const max = Math.max(1, ...(r?.trend ?? [0]));
  return (
    <Modal title={merchant.name} onClose={onClose}>
      {r ? (
        <div className="stack">
          <div className="kpis4 three">
            <div>
              <small>欠款</small>
              <b className={`num ${r.overdueCents ? 'err' : ''}`}>{formatBRL(r.openCents, false)}</b>
            </div>
            <div>
              <small>平均付款</small>
              <b className="num">{r.avgPayDays === null ? '—' : `${r.avgPayDays} 天`}</b>
            </div>
            <div>
              <small>按时率</small>
              <b className="num">{r.onTimePct === null ? '—' : `${r.onTimePct}%`}</b>
            </div>
          </div>
          {r.openCents > 0 && <AgingBar a={r.aging} big />}
          <div className="stack" style={{ gap: 6 }}>
            <span className="xs muted" style={{ fontWeight: 700 }}>近 6 个月采购（按开单日）</span>
            <div className="rchart year small" role="img" aria-label={months.map((m, i) => `${Number(m.slice(5))}月 ${formatBRL(r.trend[i])}`).join('，')}>
              {months.map((m, i) => (
                <span key={m} className="rbar" title={`${Number(m.slice(5))}月：${formatBRL(r.trend[i])}`}>
                  <span className="rcol">
                    <i className={`mc-${slot}`} style={{ height: `${(r.trend[i] / max) * 100}%`, background: 'var(--mc)' }} />
                  </span>
                  <small>{Number(m.slice(5))}月</small>
                </span>
              ))}
            </div>
          </div>
          {own.length > 0 && (
            <div className="gcard" style={{ boxShadow: 'none', border: '1px solid var(--line)' }}>
              <div className="gc-body">
                {own.slice(0, 8).map((b) => (
                  <BillRow key={b.id} bill={b} sameTitle onOpen={(x) => setBill(x)} />
                ))}
              </div>
            </div>
          )}
          <div className="row">
            <button
              className="btn btn-primary"
              onClick={async () => {
                const ok = await copyText(reconcileText(merchant.name, bills, merchant.id, today, (c) => formatBRL(c), formatBR));
                fb.toast(ok ? '对账文字已复制，可以直接发给对方核对' : '复制失败', { bad: !ok });
              }}
            >
              <ICopy />
              复制对账单
            </button>
            <button className="btn" onClick={() => go({ name: 'bills', filter: `q=${encodeURIComponent(merchant.name)}` })}>
              查看全部账单
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">还没有账单。</p>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ 全局搜索 */

const RECENT = 'zq.search.recent';
const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]').slice(0, 6);
  } catch {
    return [];
  }
};

export function SearchSheet({ onClose }: { onClose: () => void }) {
  const { bills, merchants, today, go } = useStore();
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const [bill, setBill] = useState<Bill | null>(null);
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const res = useMemo(() => searchAll(q, bills, merchants, today), [q, bills, merchants, today]);
  const tags = useMemo(() => tagStats(bills, today).slice(0, 8), [bills, today]);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  const remember = () => {
    const v = q.trim();
    if (!v) return;
    const next = [v, ...recent.filter((x) => x !== v)].slice(0, 6);
    setRecent(next);
    try {
      localStorage.setItem(RECENT, JSON.stringify(next));
    } catch {}
  };
  if (bill) {
    return (
      <Modal title={billTitle(bill)} onClose={() => setBill(null)}>
        <BillCard bill={bill} inSheet onDone={() => setBill(null)} />
      </Modal>
    );
  }
  if (merchant) return <MerchantDetail merchant={merchant} onClose={() => setMerchant(null)} />;
  const total = res.bills.length + res.merchants.length + res.tags.length;
  return (
    <Modal title="搜索" onClose={onClose}>
      <div className="stack">
        <div className="searchbox">
          <ISearch width={18} height={18} />
          <input
            ref={input}
            id="gsearch"
            type="text"
            inputMode="search"
            enterKeyHint="search"
            placeholder="商家、单号、金额、型号、备注、#标签"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && remember()}
            aria-label="搜索全部账单"
          />
          {q && (
            <button type="button" className="iconbtn btn btn-ghost" aria-label="清空" onClick={() => setQ('')}>
              <IX width={16} height={16} />
            </button>
          )}
        </div>
        {!q && (
          <>
            {recent.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="xs muted" style={{ fontWeight: 700 }}>最近搜索</span>
                <div className="tagsugg">
                  {recent.map((r) => (
                    <button key={r} type="button" onClick={() => setQ(r)}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {tags.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="xs muted" style={{ fontWeight: 700 }}>标签</span>
                <div className="tagline">
                  {tags.map((t) => (
                    <button key={t.tag} type="button" className="tagchip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setQ(`#${t.tag}`)}>
                      #{t.tag} · {t.count}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="xs muted" style={{ margin: 0 }}>例：<b>Brás</b>、<b>0231</b>、<b>290,00</b>、<b>FN-A78</b>、<b>#年货</b>。多个词用空格隔开表示「都要有」。</p>
          </>
        )}
        {q && total === 0 && <p className="muted small">没有找到「{q}」。</p>}
        {res.tags.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="xs muted" style={{ fontWeight: 700 }}>标签</span>
            {res.tags.map((t) => (
              <button key={t.tag} type="button" className="sres" onClick={() => (remember(), onClose(), go({ name: 'bills', filter: `q=${encodeURIComponent('#' + t.tag)}` }))}>
                <span className="tagchip">#{t.tag}</span>
                <span className="grow xs muted">
                  {t.count} 笔 · 合计 {formatBRL(t.totalCents)}
                  {t.openCents ? ` · 未付 ${formatBRL(t.openCents)}` : ''}
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        )}
        {res.merchants.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="xs muted" style={{ fontWeight: 700 }}>商家</span>
            {res.merchants.map(({ merchant: m, openCents, count }) => (
              <button key={m.id} type="button" className="sres" onClick={() => (remember(), setMerchant(m))}>
                <MerchantAvatar merchant={m} name={m.name} size="sm" />
                <span className="grow">
                  <b>{m.name}</b>
                  <span className="xs muted"> · {count} 笔{openCents ? ` · 未付 ${formatBRL(openCents)}` : ''}</span>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        )}
        {res.bills.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="xs muted" style={{ fontWeight: 700 }}>账单 · {res.bills.length}{res.bills.length >= 30 ? '+' : ''}</span>
            <div className="gcard" style={{ boxShadow: 'none', border: '1px solid var(--line)' }}>
              <div className="gc-body">
                {res.bills.map(({ bill: b, why }) => (
                  <BillRow key={b.id} bill={b} readOnly onOpen={(x) => (remember(), setBill(x))} sub={`${formatBR(b.dueDate)} · ${b.paidAt ? '已付' : '未付'}${b.orderNumber ? ` · #${b.orderNumber}` : ''}${why && why !== '商家' ? ` · ${why}` : ''}`} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
