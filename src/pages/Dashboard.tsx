import { SAMPLE_PREFIX } from '../sample';
import { tr, lang, monthShort } from '../i18n';
import { useEffect, useMemo, useState } from 'react';
import { PlanBanner } from './Account';
import { useStore } from '../store';
import { formatBRL } from '../lib/money';
import { endOfMonth, formatBR, monthLabel, shiftMonth, weekdayCN } from '../lib/dates';
import { ICamera, IEdit, IReceipt, IBolt, IChevron } from '../ui/icons';
import { monthSummary } from '../lib/monthly';
import { cameraSupported } from '../ui/Camera';
import { billTitle } from '../lib/expense';
import { setPendingCamera, setPendingFile } from '../pending';
import { amountOf, groupByMerchant, groupUnpaidCards } from '../lib/groups';
import { GroupedBills, GroupModeSeg, MerchantAvatar, useGroupMode } from '../ui/BillList';
import { colorSlot } from '../lib/colors';
import type { Bill } from '../lib/types';
import type { Draft } from '../db/repo';
import { useCountUp } from '../ui/CountUp';

function CountUpBRL({ cents }: { cents: number }) {
  const v = useCountUp(cents);
  return <span aria-label={formatBRL(cents, false)}>{formatBRL(v, false)}</span>;
}

export function PickImageButton({ capture, children, className }: { capture?: boolean; children: React.ReactNode; className?: string }) {
  const { go, gate, requireFeature } = useStore();
  if (!gate.canEdit) {
    return (
      <button type="button" className={className} onClick={() => requireFeature('edit')}>
        {children}
      </button>
    );
  }
  if (capture && cameraSupported()) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          setPendingCamera();
          go({ name: 'capture' });
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <label className={className} style={{ position: 'relative' }}>
      {children}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf"
        {...(capture ? { capture: 'environment' } : {})}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) {
            setPendingFile(f);
            go({ name: 'capture' });
          }
        }}
      />
    </label>
  );
}

interface Seg {
  key: string;
  label: string;
  cents: number;
  count: number;
  cls: string;
  onClick?: () => void;
  avatar?: React.ReactNode;
}

/** 分段条 + 图例（图例同时是标签，颜色不单独承担含义） */
function SegBar({ segs, total, label }: { segs: Seg[]; total: number; label: string }) {
  const shown = segs.filter((x) => x.cents > 0);
  return (
    <div className="segwrap">
      <div className="segbar" role="img" aria-label={tr('{0}：{1}', label, shown.map((x) => `${x.label} ${formatBRL(x.cents)}`).join(tr('，')))}>
        {shown.map((x) => (
          <span key={x.key} className={`seg-part ${x.cls}`} style={{ flexGrow: x.cents }} title={tr('{0}：{1}（{2} 笔，{3}%）', x.label, formatBRL(x.cents), x.count, Math.round((x.cents / total) * 100))} />
        ))}
      </div>
      <ul className="seglegend">
        {shown.map((x) => (
          <li key={x.key}>
            <button type="button" onClick={x.onClick} disabled={!x.onClick}>
              {x.avatar ?? <i className={`dot ${x.cls}`} aria-hidden="true" />}
              <span className="sl-name">{x.label}</span>
              <span className="sl-n num">{x.count}</span>
              <span className="sl-amt num">{formatBRL(x.cents)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Dashboard() {
  const { bills, merchants, today, settings, go, hasSample, clearSample, repo } = useStore();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [mode, setMode] = useGroupMode();
  const month = today.slice(0, 7);
  const monthEnd = endOfMonth(today);
  const nextMonth = shiftMonth(month, 1);
  const ms = useMemo(() => monthSummary(bills, month, today), [bills, month, today]);
  const unpaid = useMemo(() => bills.filter((b) => !b.paidAt), [bills]);
  // 本月要付：本月到期未付 + 之前逾期未付
  const toPay = useMemo(() => unpaid.filter((b) => b.dueDate <= monthEnd), [unpaid, monthEnd]);
  const toPayCents = toPay.reduce((a, b) => a + amountOf(b), 0);
  const carry = toPay.filter((b) => b.dueDate < `${month}-01`);
  const carryCents = carry.reduce((a, b) => a + amountOf(b), 0);
  const groups = useMemo(() => (mode === 'merchant' ? groupByMerchant(toPay, today, settings.dueSoonDays) : groupUnpaidCards(toPay, today, settings.dueSoonDays)), [toPay, today, mode, settings.dueSoonDays]);
  const estimated = unpaid.filter((b) => b.estimated);
  useEffect(() => {
    repo.getDraft().then(setDraft).catch(() => {});
  }, [repo]);
  const paidPct = ms.totalCents ? Math.round((ms.paidCents / ms.totalCents) * 100) : 0;

  // 本月账期按商家分色
  const merchantSegs = useMemo(() => {
    const map = new Map<string, Seg & { slot: number; first: Bill }>();
    for (const b of bills.filter((x) => x.dueDate.slice(0, 7) === month)) {
      const m = b.merchantId ? merchants.find((x) => x.id === b.merchantId) ?? null : null;
      const key = b.merchantId ?? `n-${billTitle(b)}`;
      const slot = colorSlot(m, key);
      const title = billTitle(b);
      const e = map.get(key) ?? { key, label: title.replace(SAMPLE_PREFIX, ''), cents: 0, count: 0, cls: `mc-${slot}`, slot, first: b, onClick: () => go({ name: 'bills', filter: `q=${encodeURIComponent(title)}` }) };
      e.cents += b.totalCents;
      e.count++;
      e.avatar = <MerchantAvatar merchant={m} name={billTitle(b)} bill={b} size="sm" />;
      map.set(key, e);
    }
    const arr = [...map.values()].sort((a, b) => b.cents - a.cents);
    if (arr.length <= 5) return arr;
    const rest = arr.slice(4);
    return [...arr.slice(0, 4), { key: 'other', label: tr('其他 {0} 家', rest.length), cents: rest.reduce((a, x) => a + x.cents, 0), count: rest.reduce((a, x) => a + x.count, 0), cls: 'mc-other', slot: -1, first: rest[0].first } as Seg & { slot: number; first: Bill }];
  }, [bills, merchants, month, go]);

  // 全部待付：按时间段分色
  const allSegs = useMemo(() => {
    const add = (list: Bill[], key: string, label: string, cls: string, filter?: string): Seg => ({ key, label, cls, cents: list.reduce((a, b) => a + amountOf(b), 0), count: list.length, onClick: () => go({ name: 'bills', filter }) });
    const overdue = unpaid.filter((b) => b.dueDate < today);
    const thisMonth = unpaid.filter((b) => b.dueDate >= today && b.dueDate <= monthEnd);
    const nextM = unpaid.filter((b) => b.dueDate.slice(0, 7) === nextMonth);
    const later = unpaid.filter((b) => b.dueDate.slice(0, 7) > nextMonth);
    return [add(overdue, 'o', tr('已逾期'), 'tb-overdue', 'overdue'), add(thisMonth, 'm', tr('本月内'), 'tb-month', `month-${month}`), add(nextM, 'n', monthLabel(nextMonth).slice(5), 'tb-next', `month-${nextMonth}`), add(later, 'l', tr('更晚'), 'tb-later', 'unpaid')];
  }, [unpaid, today, monthEnd, nextMonth, month, go]);
  const allCents = unpaid.reduce((a, b) => a + amountOf(b), 0);

  return (
    <>
      <PlanBanner />
      {(hasSample || draft || estimated.length > 0) && (
        <div className="notices">
          {draft && (
            <div className="banner warn">
              <span className="grow small">
                {tr('有一张')}<b>{tr('未完成的识别核对')}</b>
              </span>
              <button className="btn btn-sm btn-primary" onClick={() => go({ name: 'review' })}>
                {tr('继续核对')}
              </button>
            </div>
          )}
          {estimated.length > 0 && (
            <div className="banner warn">
              <span className="grow small">
                <b>{estimated.length}</b> {tr('笔重复账单金额待确认（')}{estimated.slice(0, 2).map(billTitle).join(tr('、'))}
                {estimated.length > 2 ? '…' : ''}{tr('）')}
              </span>
              <button className="btn btn-sm" onClick={() => go({ name: 'edit', id: estimated[0].id })}>
                {tr('去确认')}
              </button>
            </div>
          )}
          {hasSample && (
            <div className="banner info">
              <span className="grow small">
                {tr('正在看')}<b>{tr('示例数据')}</b>{tr('，熟悉后可一键清除')}
              </span>
              <button className="btn btn-sm" onClick={clearSample}>
                {tr('清除示例')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="home-grid">
        <section className="card overview month-plan" aria-label={tr('本月应付')}>
          <div className="hero-band">
          <div className="ov-top">
            <div className="stack" style={{ gap: 2 }}>
              <span className="ov-label">
                {tr('{0}月还要付 · {1} 笔', lang() === 'zh' ? Number(month.slice(5)) : monthShort(Number(month.slice(5))), toPay.length)}
              </span>
              <span className="ov-total num">
                <small>R$</small>
                <CountUpBRL cents={toPayCents} />
              </span>
            </div>
            <span className="xs muted num" style={{ textAlign: 'right' }}>
              {formatBR(today)} {weekdayCN(today)}
            </span>
          </div>
          <button className="mprog" onClick={() => go({ name: 'bills', filter: `month-${month}` })} aria-label={tr('本月账期总额 {0}，已付 {1}%，打开月历', formatBRL(ms.totalCents), paidPct)}>
            <span className="row between small" style={{ width: '100%' }}>
              <span>
                {tr('本月账期')} <b className="num">{formatBRL(ms.totalCents)}</b> {tr('· 已付')} <b className="num paid-ink">{formatBRL(ms.paidCents)}</b>
              </span>
              <span className="muted num" style={{ display: 'inline-flex', alignItems: 'center' }}>
                {paidPct}% <IChevron width={14} height={14} />
              </span>
            </span>
            <span className="bar" aria-hidden="true" style={{ width: '100%' }}>
              <span className="bar-fill" style={{ width: `${paidPct}%` }} />
            </span>
          </button>
          {carry.length > 0 && (
            <p className="carry">
              {tr('含之前月份逾期 {0} 笔 · {1}', carry.length, formatBRL(carryCents))}
            </p>
          )}
          </div>
          {merchantSegs.length > 0 && (
            <>
              <span className="ov-sub">{tr('本月各商家账期')}</span>
              <SegBar segs={merchantSegs} total={ms.totalCents} label={tr('本月各商家账期')} />
            </>
          )}
        </section>

        <section className="quick3" data-tour="capture" aria-label={tr('新增账单')}>
          <PickImageButton capture className="btn qa qa-cam">
            <ICamera />
            {tr('拍照识别')}
          </PickImageButton>
          <button className="btn qa qa-sup" onClick={() => go({ name: 'new' })}>
            <IEdit />
            {tr('商家账单')}
          </button>
          <button className="btn qa qa-exp" onClick={() => go({ name: 'new', kind: 'expense' })}>
            <IBolt />
            {tr('日常缴费')}
          </button>
        </section>

        <section className="stack home-list" aria-labelledby="h-todo">
          <div className="section-head">
            <h2 id="h-todo">{tr('本月待付')}</h2>
            {toPay.length > 0 && <GroupModeSeg mode={mode} onChange={setMode} />}
          </div>
          <GroupedBills
            groups={groups}
            rowLimit={4}
            onHead={(g) => go({ name: 'bills', filter: g.sameTitle ? `q=${encodeURIComponent(g.label)}` : g.key === 'overdue' ? 'overdue' : `month-${month}` })}
            emptyNode={
              <div className="card empty">
                <div className="art">
                  <IReceipt />
                </div>
                <h3>{bills.length ? tr('本月都付清了') : tr('还没有账单')}</h3>
                <p>{bills.length ? (unpaid.length ? tr('下一笔在 {0} 到期。', formatBR([...unpaid].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0].dueDate)) : tr('没有未付账单。')) : tr('拍一张订单照片，或手工录入第一笔账期。')}</p>
              </div>
            }
          />
        </section>

        <section className="card all-unpaid" aria-label={tr('全部待付')}>
          <div className="row between" style={{ alignItems: 'baseline' }}>
            <span className="ov-label">{tr('全部待付 ·')} {unpaid.length} {tr('笔')}</span>
            <button className="linkbtn" onClick={() => go({ name: 'bills' })}>
              {tr('查看全部 ›')}
            </button>
          </div>
          <span className="au-total num">{formatBRL(allCents)}</span>
          {allCents > 0 && <SegBar segs={allSegs} total={allCents} label={tr('全部待付按时间')} />}
        </section>
      </div>
    </>
  );
}
