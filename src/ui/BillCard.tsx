import { tr } from '../i18n';
import { useRef, useState } from 'react';
import type { Bill } from '../lib/types';
import { billStatus, STATUS_ICON, STATUS_LABEL } from '../lib/status';
import { formatBR, relativeDue, addDays, todayISO } from '../lib/dates';
import { formatBRL, formatQuantity } from '../lib/money';
import { useStore } from '../store';
import { useActions } from '../actions';
import { ICal, ICheck, IEdit, IUndo, IWallet, IReceipt, ICopy, IRepeat } from './icons';
import { googleCalendarUrl } from '../lib/platform';
import { billTitle, categoryOf, describePaymentCode, isExpense } from '../lib/expense';
import { TOTAL_ONLY_DESC } from '../lib/ocr/protocol';
import { describeRepeat } from '../lib/recurrence';
import { isPartial, openCents, paymentsOf } from '../lib/payments';
import { nonBusinessReason, nextBusinessDay } from '../lib/holidays';
import { PayModal } from './PayModal';
import { ITrash, IImage } from './icons';
import { ReceiptViewer } from './ReceiptViewer';

export function StatusPill({ bill, today, days }: { bill: Bill; today: string; days: number }) {
  const s = billStatus(bill, today, days);
  return (
    <span className={`pill ${s}`}>
      <i aria-hidden="true">{STATUS_ICON[s]}</i>
      {STATUS_LABEL[s]}
    </span>
  );
}

export function BillCard({
  bill,
  compact = false,
  selectable = false,
  selected = false,
  onToggle,
  inSheet = false,
  onDone,
}: {
  bill: Bill;
  compact?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  /** 在详情抽屉里显示：不重复标题，操作按钮平铺 */
  inSheet?: boolean;
  onDone?: () => void;
}) {
  const { today, settings, go, accounts } = useStore();
  const { markPaid, markUnpaid, exportICS, copySummary, copyCode, removeBill, generateNext, addPayment, removePayment, copyBillCode } = useActions();
  const [payOpen, setPayOpen] = useState(false);
  const [viewReceipt, setViewReceipt] = useState<string | null>(null);
  const pays = paymentsOf(bill);
  const left = openCents(bill);
  const partial = isPartial(bill);
  const [more, setMore] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const st = billStatus(bill, today, settings.dueSoonDays);
  const expense = isExpense(bill);
  const cat = categoryOf(bill.category);
  const title = billTitle(bill);
  const totalOnly = bill.amountMode === 'total' && !bill.installment;
  const shownItems = bill.items.slice(0, 3);
  const pix = accounts.find((a) => a.id === bill.accountId)?.optionalPixHint;
  return (
    <article
      className={`bill${inSheet ? ' in-sheet' : ''}${st === 'paid' ? ' is-paid' : ''}${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}`}
      aria-label={`${title} ${formatBRL(bill.totalCents)} ${STATUS_LABEL[st]}`}
      onClick={selectable ? onToggle : undefined}
    >
      {selectable && <input type="checkbox" className="selbox" checked={selected} onChange={onToggle} onClick={(e) => e.stopPropagation()} aria-label={tr('选择 {0}', title)} />}
      <div className="top">
        {expense && (
          <span className="catmark" aria-hidden="true">
            {cat?.mark ?? tr('缴')}
          </span>
        )}
        <div className="grow">
          {!inSheet && <div className="merchant">{title}</div>}
          <div className="meta">
            {bill.orderNumber && <span className="mono">#{bill.orderNumber}</span>}
            {bill.installment && (
              <span className="pill brand">
                {tr('分期')} {bill.installment.index}/{bill.installment.count}
              </span>
            )}
            {bill.recurrence && (
              <span title={tr('重复账单')}>
                <IRepeat width={13} height={13} />
                {describeRepeat(bill.recurrence)}
              </span>
            )}
            {partial && <span className="pill dueSoon">{tr('已付')} {Math.round(((bill.totalCents - left) / bill.totalCents) * 100)}%</span>}
            {bill.estimated && <span className="pill dueSoon">{tr('金额待确认')}</span>}
            {bill.ocrReview && (
              <span title={tr('来自票据识别')}>
                <IReceipt width={14} height={14} />
                {tr('识别')}
              </span>
            )}
          </div>
        </div>
        <div className="amount num">{formatBRL(bill.totalCents)}</div>
      </div>
      <div className="row between">
        <StatusPill bill={bill} today={today} days={settings.dueSoonDays} />
        <span className={`small num ${st === 'overdue' ? 'err' : 'muted'}`} style={{ fontWeight: 700 }}>
          {st === 'paid' ? tr('到期 {0}', formatBR(bill.dueDate)) : `${formatBR(bill.dueDate)} · ${relativeDue(bill.dueDate, today)}`}
        </span>
      </div>
      {!bill.paidAt && nonBusinessReason(bill.dueDate) && (
        <span className="xs muted">
          {tr('到期日是')}{nonBusinessReason(bill.dueDate)}{tr('，银行顺延到')} {formatBR(nextBusinessDay(bill.dueDate)).slice(0, 5)}
        </span>
      )}
      <div className="meta">
        <span>
          <IWallet width={14} height={14} />
          {bill.accountLabelSnapshot || tr('未指定账号')}
        </span>
        <span className="num">{tr('开单')} {formatBR(bill.billDate)}</span>
        {bill.paidAt ? <span className="num">{tr('付款')} {formatBR(todayISO(new Date(bill.paidAt)))}</span> : <span>{tr('提前')} {bill.reminderDays} {tr('天提醒')}</span>}
      </div>
      {!!bill.tags?.length && (
        <div className="tagline" aria-label={tr('标签')}>
          {bill.tags.map((t) => (
            <button key={t} type="button" className="tagchip" style={{ border: 0, cursor: 'pointer' }} onClick={() => go({ name: 'bills', filter: `q=${encodeURIComponent('#' + t)}` })}>
              #{t}
            </button>
          ))}
        </div>
      )}
      {!compact && inSheet && bill.notes && <p className="small muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{tr('备注：')}{bill.notes}</p>}
      {!compact && !selectable && !bill.paidAt && (bill.paymentCode || pix) && (
        <div className="stack" style={{ gap: 4 }}>
          {bill.paymentCode && (
            <div className="codebox">
              <span className="mono" title={bill.paymentCode}>
                {describePaymentCode(bill.paymentCode)}{tr('：')}{bill.paymentCode}
              </span>
              <button className="btn btn-sm btn-soft" onClick={() => copyBillCode(bill)}>
                <ICopy />
                {tr('复制')}
              </button>
            </div>
          )}
          {!bill.paymentCode && pix && (
            <div className="codebox">
              <span className="mono">{tr('PIX：')}{bill.accountLabelSnapshot}</span>
              <button className="btn btn-sm btn-soft" onClick={() => copyCode(pix, 'PIX')}>
                <ICopy />
                {tr('复制 PIX')}
              </button>
            </div>
          )}
        </div>
      )}
      {!compact && !totalOnly && (bill.items.length > 1 || bill.items[0]?.description !== TOTAL_ONLY_DESC) && (
        <div className="items">
          {(more ? bill.items : shownItems).map((i) => (
            <div key={i.id} className="row between num" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <span style={{ overflowWrap: 'anywhere' }}>
                {bill.installment ? i.description : (
                  <>
                    {formatQuantity(i.quantity)} × <b>{i.description}</b> × {formatBRL(i.unitPriceCents, false)}
                  </>
                )}
              </span>
              <span>{formatBRL(i.subtotalCents, false)}</span>
            </div>
          ))}
          {bill.items.length > 3 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setMore((m) => !m)} style={{ paddingLeft: 0 }}>
              {more ? tr('收起') : tr('还有 {0} 行', bill.items.length - 3)}
            </button>
          )}
        </div>
      )}
      {!compact && totalOnly && bill.items[0]?.description !== TOTAL_ONLY_DESC && <div className="items">{bill.items[0]?.description}</div>}
      {inSheet && pays.length > 0 && (
        <div className="paylist">
          <div className="row between">
            <span className="xs muted" style={{ fontWeight: 700 }}>{tr('付款记录')}</span>
            {partial && (
              <span className="xs" style={{ fontWeight: 800, color: 'var(--soon)' }}>
                {tr('已付')} {formatBRL(bill.totalCents - left)} {tr('· 还差')} {formatBRL(left)}
              </span>
            )}
          </div>
          {pays.map((p) => (
            <div key={p.id} className="payrow">
              <span className="num">{formatBR(p.date)}</span>
              <span className="grow small muted">{p.note || (p.cents >= bill.totalCents ? tr('一次付清') : tr('分次付款'))}</span>
              {p.receiptImageId && (
                <button className="btn btn-sm btn-ghost iconbtn" aria-label={tr('查看 {0} 的付款凭证', formatBR(p.date))} onClick={() => setViewReceipt(p.receiptImageId!)}>
                  <IImage width={15} height={15} />
                </button>
              )}
              <span className="num" style={{ fontWeight: 800 }}>
                {formatBRL(p.cents)}
              </span>
              <button className="btn btn-sm btn-ghost iconbtn" aria-label={tr('删除 {0} 的付款记录', formatBR(p.date))} onClick={() => removePayment(bill, p.id)}>
                <ITrash width={15} height={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      {inSheet && (
        <div className="sheet-actions">
          {bill.paidAt ? (
            <button className="btn" onClick={() => markUnpaid(bill)}>
              <IUndo />
              {tr('恢复未付')}
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await markPaid(bill);
                  onDone?.();
                }}
              >
                <ICheck />
                {partial ? tr('付清尾款 {0}', formatBRL(left)) : tr('标记已付')}
              </button>
              <button className="btn" onClick={() => setPayOpen(true)}>
                <IWallet />
                {tr('记一笔付款')}
              </button>
            </>
          )}
          <button
            className="btn"
            onClick={() => {
              onDone?.();
              go({ name: 'edit', id: bill.id });
            }}
          >
            <IEdit />
            {bill.estimated ? tr('确认金额') : tr('编辑')}
          </button>
          <button
            className="btn"
            onClick={() => {
              onDone?.();
              go({ name: 'copy', id: bill.id });
            }}
          >
            <ICopy />
            {tr('复制为新账单')}
          </button>
          <button className="btn" onClick={() => copySummary(bill)}>
            {tr('复制账单文字')}
          </button>
          {bill.recurrence && (
            <button className="btn" onClick={() => generateNext(bill)}>
              <IRepeat />
              {tr('现在生成下一期')}
            </button>
          )}
          {!bill.paidAt && (
            <>
              <button className="btn" onClick={() => exportICS([bill], tr('账期-{0}-{1}.ics', title, bill.dueDate))}>
                <ICal />
                {tr('导出到日历')}
              </button>
              <a
                className="btn"
                target="_blank"
                rel="noopener noreferrer"
                href={googleCalendarUrl(tr('{0}：{1} {2}', expense ? tr('缴费') : tr('付款'), title, formatBRL(bill.totalCents)), bill.dueDate, addDays(bill.dueDate, 1), tr('单号 {0}\n账号：{1}{2}', bill.orderNumber || '—', bill.accountLabelSnapshot || tr('未指定'), bill.paymentCode ? tr('\n付款码：{0}', bill.paymentCode) : ''))}
              >
                {tr('Google 日历')}
              </a>
            </>
          )}
          <button
            className="btn btn-danger-text"
            onClick={async () => {
              if (await removeBill(bill)) onDone?.();
            }}
          >
            <ITrash />
            {tr('删除')}
          </button>
        </div>
      )}
      {payOpen && <PayModal bill={bill} onClose={() => setPayOpen(false)} onSave={async (cents, date, note, receipt) => { await addPayment(bill, cents, date, note, receipt); setPayOpen(false); if (cents >= left) onDone?.(); }} />}
      {viewReceipt && <ReceiptViewer id={viewReceipt} onClose={() => setViewReceipt(null)} />}
      {!selectable && !inSheet && (
        <div className="actions">
          {bill.paidAt ? (
            <button className="btn btn-sm" onClick={() => markUnpaid(bill)}>
              <IUndo />
              {tr('恢复未付')}
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => markPaid(bill)}>
              <ICheck />
              {tr('标记已付')}
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => go({ name: 'edit', id: bill.id })}>
            <IEdit />
            {bill.estimated ? tr('确认金额') : tr('编辑')}
          </button>
          <details className="more" style={{ marginLeft: 'auto' }} ref={menuRef}>
            <summary className="btn btn-sm btn-ghost" aria-label={tr('更多操作')}>
              ···
            </summary>
            <div className="stack menu" style={{ gap: 4, paddingTop: 6 }} onClick={() => setTimeout(() => menuRef.current?.removeAttribute('open'), 0)}>
              <button className="btn btn-sm" onClick={() => go({ name: 'copy', id: bill.id })}>
                <ICopy />
                {tr('复制为新账单')}
              </button>
              <button className="btn btn-sm" onClick={() => copySummary(bill)}>
                {tr('复制账单文字')}
              </button>
              {!bill.paidAt && (
                <>
                  <button className="btn btn-sm" onClick={() => exportICS([bill], tr('账期-{0}-{1}.ics', title, bill.dueDate))}>
                    <ICal />
                    {tr('导出 .ics 日历')}
                  </button>
                  <a
                    className="btn btn-sm"
                    target="_blank"
                    rel="noopener noreferrer"
                    href={googleCalendarUrl(tr('{0}：{1} {2}', expense ? tr('缴费') : tr('付款'), title, formatBRL(bill.totalCents)), bill.dueDate, addDays(bill.dueDate, 1), tr('单号 {0}\n账号：{1}{2}', bill.orderNumber || '—', bill.accountLabelSnapshot || tr('未指定'), bill.paymentCode ? tr('\n付款码：{0}', bill.paymentCode) : ''))}
                  >
                    {tr('添加到 Google 日历')}
                  </a>
                </>
              )}
            </div>
          </details>
        </div>
      )}
    </article>
  );
}
