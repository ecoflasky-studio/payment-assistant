import { tr, monthShort } from '../i18n';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { formatBRL } from '../lib/money';
import { monthLabel, shiftMonth } from '../lib/dates';
import { changePct, flowCSV, flowSeries, forecast, ledgerByDay, monthFlow, shareBy, type Share } from '../lib/flow';
import { Modal } from '../ui/feedback';
import { BillCard } from '../ui/BillCard';
import { BillRow } from '../ui/BillList';
import { compactBRL } from '../lib/monthly';
import { MonthNav } from '../ui/Calendar';
import { ReportTabs } from './Insights';
import { MerchantAvatar } from '../ui/BillList';
import { IDownload, IChart } from '../ui/icons';
import { saveFile, copyText } from '../lib/platform';
import { useFeedback } from '../ui/feedback';
import { billTitle, categoryOf } from '../lib/expense';

type By = 'merchant' | 'account' | 'category';

export function FlowPage({ month: initialMonth }: { month?: string }) {
  const { bills, merchants, today, go, settings, requireFeature } = useStore();
  const fb = useFeedback();
  const [month, setMonthState] = useState(initialMonth ?? today.slice(0, 7));
  const setMonth = (m: string) => {
    setMonthState(m);
    go({ name: 'flow', month: m }, true);
  };
  const [by, setBy] = useState<By>('merchant');
  const f = useMemo(() => monthFlow(bills, month), [bills, month]);
  const prev = useMemo(() => monthFlow(bills, shiftMonth(month, -1)), [bills, month]);
  const endYm = month > today.slice(0, 7) ? month : today.slice(0, 7);
  const series = useMemo(() => flowSeries(bills, endYm, 12), [bills, endYm]);
  const shares = useMemo(() => shareBy(f.events, by), [f.events, by]);
  const days = useMemo(() => ledgerByDay(f.events), [f.events]);
  const fc = useMemo(() => forecast(bills, today, 6), [bills, today]);
  const [open, setOpen] = useState<string | null>(null);
  const current = open ? bills.find((b) => b.id === open) ?? null : null;
  // 当月还没过完：和上月同期（到同一天）比较，避免"比上月少 95%"这种误导
  const isCurrent = month === today.slice(0, 7);
  const prevCmp = isCurrent ? prev.events.filter((e) => Number(e.date.slice(8)) <= Number(today.slice(8))).reduce((a, e) => a + e.cents, 0) : prev.paidCents;
  const pct = changePct(f.paidCents, prevCmp);
  const max = Math.max(1, ...series.map((p) => p.total));
  const avg = series.filter((p) => p.total > 0);
  const avgCents = avg.length ? Math.round(avg.reduce((a, p) => a + p.total, 0) / avg.length) : 0;
  const mLabel = monthShort(Number(month.slice(5)));
  const budget = settings.monthlyBudgetCents || 0;
  const over = budget > 0 && f.paidCents > budget;

  const exportCSV = async () => {
    if (!requireFeature('export')) return;
    if (!f.events.length) return fb.toast(tr('这个月没有付款记录'), { bad: true });
    const csv = flowCSV(f.events);
    const r = await saveFile(tr('流水-{0}.csv', month), csv, 'text/csv;charset=utf-8');
    if (r.outcome === 'saved') fb.toast(tr('已导出 {0} 笔流水', f.events.length));
    else if (r.outcome === 'shared') fb.toast(tr('已打开系统分享'));
    else if (r.outcome !== 'declined') {
      const ok = await copyText(csv);
      fb.toast(ok ? tr('此处不能直接下载，已把表格内容复制到剪贴板') : r.message ?? tr('无法导出'), { bad: !ok });
    }
  };

  return (
    <>
      <ReportTabs current="flow" />
      <section className="card flow-head" aria-label={tr('{0}流水', monthLabel(month))}>
        <MonthNav
          month={month}
          onChange={setMonth}
          right={
            <button className="btn btn-sm iconbtn2" style={{ marginLeft: 'auto' }} onClick={exportCSV} aria-label={tr('导出本月流水表格')} title={tr('导出表格（CSV）')}>
              <IDownload />
            </button>
          }
        />
        <div className="ov-top">
          <div className="stack" style={{ gap: 2 }}>
            <span className="ov-label">
              {tr('{0}实付 · {1} 笔', mLabel, f.events.length)}
            </span>
            <span className="ov-total num">
              <small>R$</small>
              {formatBRL(f.paidCents, false)}
            </span>
          </div>
          {pct !== null && (
            <span className={`delta ${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}`} title={`${isCurrent ? tr('上月同期') : tr('上月')} ${formatBRL(prevCmp)}`}>
              {pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {Math.abs(pct)}% <small>{isCurrent ? tr('比上月同期') : tr('比上月')}</small>
            </span>
          )}
        </div>
        <div className="metrics">
          <div className="metric static">
            <span className="k">
              <i className="dot mc-0" /> {tr('商家货款')}
            </span>
            <span className="v num">{formatBRL(f.supplierCents, false)}</span>
          </div>
          <div className="metric static">
            <span className="k">
              <i className="dot mc-2" /> {tr('日常缴费')}
            </span>
            <span className="v num">{formatBRL(f.expenseCents, false)}</span>
          </div>
          <button className="metric" onClick={() => go({ name: 'bills', filter: `month-${month}` })} title={tr('打开这个月的月历')}>
            <span className="k">{tr('新开账期 ·')} {f.billedCount}</span>
            <span className="v num">{formatBRL(f.billedCents, false)}</span>
          </button>
        </div>
        {budget && isCurrent && (
          <div className="budget">
            <div className="row between small">
              <span>
                {tr('本月预算')} <b className="num">{formatBRL(budget)}</b>
              </span>
              <span className={over ? 'err' : 'muted'} style={{ fontWeight: 800 }}>
                {over ? tr('超出 {0}', formatBRL(f.paidCents - budget)) : tr('还剩 {0}', formatBRL(budget - f.paidCents))}
              </span>
            </div>
            <span className="bar" aria-label={tr('本月已用预算 {0}%', Math.round((f.paidCents / budget) * 100))}>
              <span style={{ width: `${Math.min(100, (f.paidCents / budget) * 100)}%`, background: over ? 'var(--overdue)' : f.paidCents / budget > 0.8 ? 'var(--soon)' : 'var(--paid)' }} />
            </span>
          </div>
        )}
        {f.dueCount > 0 && (
          <p className="xs muted" style={{ margin: 0 }}>
            {tr('{0}到期 {1} 笔（{2}），按时付清', mLabel, f.dueCount, formatBRL(f.dueCents))} <b className="paid-ink">{f.dueOnTimeCount}</b> {tr('笔')}
          </p>
        )}
      </section>

      <section className="card stack" aria-labelledby="h-trend">
        <div className="row between">
          <h2 id="h-trend" className="row">
            <IChart width={18} height={18} /> {tr('近 12 个月付款')}
          </h2>
          <div className="flegend" aria-hidden="true">
            <span>
              <i className="dot mc-0" />
              {tr('货款')}
            </span>
            <span>
              <i className="dot mc-2" />
              {tr('缴费')}
            </span>
          </div>
        </div>
        <div className="fchart" role="group" aria-label={tr('近 12 个月付款，点柱子切换月份')}>
          {avgCents > 0 && (
            <span className="fplot" aria-hidden="true">
              <span className="favg" style={{ bottom: `${(avgCents / max) * 100}%` }} />
            </span>
          )}
          {series.map((p) => {
            const h = (p.total / max) * 100;
            const selected = p.ym === month;
            return (
              <button
                key={p.ym}
                type="button"
                className={`fbar${selected ? ' sel' : ''}`}
                aria-pressed={selected}
                aria-label={tr('{0}：实付 {1}，货款 {2}，缴费 {3}，{4} 笔', monthLabel(p.ym), formatBRL(p.total), formatBRL(p.supplier), formatBRL(p.expense), p.count)}
                onClick={() => setMonth(p.ym)}
              >
                <span className="fcol">
                  <span className="fstack" style={{ height: `${h}%` }}>
                    {selected && p.total > 0 && <span className="fval num">{compactBRL(p.total)}</span>}
                    {p.expense > 0 && <span className="fseg mc-2" style={{ flexGrow: p.expense }} />}
                    {p.supplier > 0 && <span className="fseg mc-0" style={{ flexGrow: p.supplier }} />}
                  </span>
                </span>
                <span className="flab">
                  {Number(p.ym.slice(5))}
                  <span className="fyue">{tr('月')}</span>
                </span>
                <span className="ftip" role="tooltip">
                  <b>{monthLabel(p.ym)}</b>
                  <span className="num">{tr('实付')} {formatBRL(p.total)}</span>
                  <span className="num">{tr('货款')} {formatBRL(p.supplier)}</span>
                  <span className="num">{tr('缴费')} {formatBRL(p.expense)}</span>
                </span>
              </button>
            );
          })}
        </div>
        {avgCents > 0 && <p className="xs muted" style={{ margin: 0 }}>{tr('虚线为有付款月份的月均：')}{formatBRL(avgCents)}</p>}
      </section>

      <section className="card stack" aria-labelledby="h-fc">
        <h2 id="h-fc">{tr('接下来要付')}</h2>
        <div className="metrics">
          <button className={`metric${fc.overdueCents ? ' bad' : ''}`} onClick={() => go({ name: 'bills', filter: 'overdue' })}>
            <span className="k">{tr('已逾期 ·')} {fc.overdueCount}</span>
            <span className="v num">{formatBRL(fc.overdueCents, false)}</span>
          </button>
          <button className="metric warn" onClick={() => go({ name: 'bills', filter: 'dueSoon' })}>
            <span className="k">{tr('未来 7 天')}</span>
            <span className="v num">{formatBRL(fc.next7, false)}</span>
          </button>
          <button className="metric" onClick={() => go({ name: 'bills' })}>
            <span className="k">{tr('未来 30 天')}</span>
            <span className="v num">{formatBRL(fc.next30, false)}</span>
          </button>
        </div>
        <button className="btn btn-soft" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'cashflow' })}>
          {tr('看 12 周现金流预测（含重复账单、资金余额）›')}
        </button>
        <p className="xs muted" style={{ margin: 0 }}>{tr('按「还差多少」计算：分次付过的账单只算剩下的部分。')}</p>
      </section>

      {f.events.length > 0 && (
        <section className="card stack" aria-labelledby="h-share">
          <div className="row between">
            <h2 id="h-share">{tr('{0}钱付给了谁', mLabel)}</h2>
            <div className="seg seg-sm" role="group" aria-label={tr('汇总方式')}>
              {(
                [
                  ['merchant', tr('商家')],
                  ['category', tr('分类')],
                  ['account', tr('账号')],
                ] as [By, string][]
              ).map(([k, l]) => (
                <button key={k} aria-pressed={by === k} onClick={() => setBy(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <ul className="sharelist">
            {shares.map((x) => (
              <ShareRow key={x.key} x={x} by={by} total={f.paidCents} merchant={x.merchantId ? merchants.find((m) => m.id === x.merchantId) ?? null : null} onOpen={by === 'merchant' ? () => go({ name: 'bills', filter: `q=${encodeURIComponent(x.label)}` }) : undefined} />
            ))}
          </ul>
        </section>
      )}

      <section className="stack flow-ledger" aria-labelledby="h-ledger">
        <h2 id="h-ledger">{tr('流水明细')}</h2>
        {days.length === 0 ? (
          <div className="card empty">
            <div className="art">
              <IChart />
            </div>
            <h3>{tr('{0}没有付款记录', mLabel)}</h3>
            <p>{tr('在账单上点 ✓ 标记已付，或在账单详情里「记一笔付款」，就会按付款日期出现在这里。')}</p>
          </div>
        ) : (
          <div className="gcards">
            {days.map((d) => (
              <section key={d.date} className="gcard tone-paid" aria-label={tr('{0} 付款 {1}', d.label, formatBRL(d.total))}>
                <header className="gc-head">
                  <div className="gc-title">
                    <span className="glabel">
                      {d.label}
                      <span className="gc-count num">{d.events.length}</span>
                    </span>
                  </div>
                  <span className="gc-total num">{formatBRL(d.total)}</span>
                </header>
                <div className="gc-body">
                  {d.events.map((e) => (
                    <BillRow
                      key={e.id}
                      bill={e.bill}
                      amount={e.cents}
                      sub={[e.note, e.cents < e.bill.totalCents ? (e.settles ? tr('付清尾款（账单 {0}）', formatBRL(e.bill.totalCents)) : tr('部分付款（账单 {0}）', formatBRL(e.bill.totalCents))) : null, e.bill.orderNumber ? `#${e.bill.orderNumber}` : null, e.bill.accountLabelSnapshot || null].filter(Boolean).join(' · ')}
                      readOnly
                      onOpen={(b) => setOpen(b.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      {current && (
        <Modal title={billTitle(current)} onClose={() => setOpen(null)}>
          <BillCard bill={current} inSheet onDone={() => setOpen(null)} />
        </Modal>
      )}
    </>
  );
}

function ShareRow({ x, by, total, merchant, onOpen }: { x: Share; by: By; total: number; merchant: import('../lib/types').Merchant | null; onOpen?: () => void }) {
  const pct = total ? Math.round((x.cents / total) * 100) : 0;
  const mark = by === 'merchant' && x.sample ? (
    <MerchantAvatar merchant={merchant} name={x.label} bill={x.sample} size="md" />
  ) : (
    <span className={`share-mark ${by === 'category' ? (x.key === 'supplier' ? 'mc-0' : 'mc-2') : 'mc-other'}`} aria-hidden="true">
      {by === 'category' ? (x.key === 'supplier' ? tr('货') : categoryOf(x.key.slice(2))?.mark ?? tr('缴')) : x.label.slice(0, 1)}
    </span>
  );
  return (
    <li className={`share${onOpen ? ' clickable' : ''}`} onClick={onOpen} tabIndex={onOpen ? 0 : undefined} aria-label={onOpen ? tr('{0}：查看账单', x.label) : undefined} onKeyDown={onOpen ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen()) : undefined}>
      {mark}
      <div className="share-main">
        <div className="row between" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <span className="share-name">{x.label}</span>
          <span className="share-amt num">{formatBRL(x.cents)}</span>
        </div>
        <div className="share-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(pct, 1)}%` }} />
        </div>
        <span className="xs muted num">
          {x.count} {tr('笔 ·')} {pct}%
        </span>
      </div>
    </li>
  );
}
