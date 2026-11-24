import { tr } from '../i18n';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { GroupedBills } from '../ui/BillList';
import { groupByMerchant, groupUnpaidCards, type BillGroup } from '../lib/groups';
import { formatBRL } from '../lib/money';
import { addDays, monthLabel, todayISO } from '../lib/dates';
import { billTitle } from '../lib/expense';
import { openCents } from '../lib/payments';
import { IPlus, ISearch, IWallet } from '../ui/icons';

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 应收款：客户欠我的钱（企业订单、批发客户的账期） */
export function ReceivablesPage({ initialFilter }: { initialFilter?: string }) {
  const { receivables, today, settings, go } = useStore();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [mode, setMode] = useState<'date' | 'customer'>('date');
  const [q, setQ] = useState(initialFilter?.startsWith('q=') ? safeDecode(initialFilter.slice(2)) : '');
  const live = receivables.filter((b) => !b.deletedAt);
  const open = live.filter((b) => !b.paidAt);
  const overdue = open.filter((b) => b.dueDate < today);
  const next30 = open.filter((b) => b.dueDate >= today && b.dueDate <= addDays(today, 30));
  const month = today.slice(0, 7);
  const gotThisMonth = live.reduce((s, b) => s + (b.payments ?? []).filter((p) => p.date.slice(0, 7) === month).reduce((a, p) => a + p.cents, 0), 0);
  const sum = (list: typeof open) => list.reduce((s, b) => s + openCents(b), 0);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return live.filter((b) => (tab === 'open' ? !b.paidAt : !!b.paidAt) && (!k || [billTitle(b), b.orderNumber, b.notes, ...(b.tags ?? [])].some((x) => (x ?? '').toLowerCase().includes(k))));
  }, [live, tab, q]);

  const groups: BillGroup[] = useMemo(() => {
    if (tab === 'done') {
      // 已收：按收款月份倒序
      const map = new Map<string, BillGroup>();
      for (const b of [...list].sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''))) {
        const m = b.paidAt ? todayISO(new Date(b.paidAt)).slice(0, 7) : b.dueDate.slice(0, 7);
        const g = map.get(m) ?? { key: `r-${m}`, label: tr('{0} 收款', monthLabel(m)), tone: 'paid' as const, bills: [], total: 0 };
        g.bills.push(b);
        g.total += b.totalCents;
        map.set(m, g);
      }
      return [...map.values()];
    }
    return mode === 'customer' ? groupByMerchant(list, today, settings.dueSoonDays) : groupUnpaidCards(list, today, settings.dueSoonDays);
  }, [list, tab, mode, today, settings.dueSoonDays]);

  return (
    <div className="stack">
      <section className="card recv-sum" aria-label={tr('应收汇总')}>
        <div className="row between" style={{ alignItems: 'baseline' }}>
          <span className="ov-label">{tr('待收合计 ·')} {open.length} {tr('笔')}</span>
          <button className="btn btn-primary btn-sm" onClick={() => go({ name: 'new', kind: 'receivable' })}>
            <IPlus />
            {tr('记一笔应收')}
          </button>
        </div>
        <span className="au-total num">{formatBRL(sum(open))}</span>
        <div className="recv-kpis">
          <div className={overdue.length ? 'bad' : ''}>
            <span className="xs muted">{tr('已逾期')}</span>
            <b className="num">{formatBRL(sum(overdue))}</b>
            <span className="xs muted">{tr('{0} 笔', overdue.length)}</span>
          </div>
          <div>
            <span className="xs muted">{tr('30 天内到期')}</span>
            <b className="num">{formatBRL(sum(next30))}</b>
            <span className="xs muted">{tr('{0} 笔', next30.length)}</span>
          </div>
          <div className="good">
            <span className="xs muted">{tr('本月已收')}</span>
            <b className="num">{formatBRL(gotThisMonth)}</b>
          </div>
        </div>
      </section>

      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="seg seg-sm" role="group" aria-label={tr('应收状态')}>
          <button aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
            {tr('待收')} {open.length}
          </button>
          <button aria-pressed={tab === 'done'} onClick={() => setTab('done')}>
            {tr('已收')}
          </button>
        </div>
        {tab === 'open' && (
          <div className="seg seg-sm" role="group" aria-label={tr('归类方式')}>
            <button aria-pressed={mode === 'date'} onClick={() => setMode('date')}>
              {tr('按日期')}
            </button>
            <button aria-pressed={mode === 'customer'} onClick={() => setMode('customer')}>
              {tr('按客户')}
            </button>
          </div>
        )}
      </div>
      {live.length > 3 && (
        <label className="searchbox">
          <ISearch width={16} height={16} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索客户、单号、备注')} aria-label={tr('搜索应收款')} />
        </label>
      )}

      <GroupedBills
        groups={groups}
        rowLimit={8}
        emptyNode={
          <div className="card empty">
            <div className="art">
              <IWallet />
            </div>
            <h3>{live.length ? (tab === 'open' ? tr('应收款都收齐了') : tr('还没有收过款')) : tr('还没有应收款')}</h3>
            <p>{live.length ? (q ? tr('换个关键词试试。') : '') : tr('企业定制、批发客户先发货后付款时，在这里记下谁欠多少、哪天该收；逾期没收的会在首页提示你去催款。')}</p>
            {!live.length && (
              <div className="row" style={{ justifyContent: 'center' }}>
                <button className="btn btn-primary" onClick={() => go({ name: 'new', kind: 'receivable' })}>
                  <IPlus />
                  {tr('记一笔应收')}
                </button>
              </div>
            )}
          </div>
        }
      />
    </div>
  );
}
