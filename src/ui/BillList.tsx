import { SAMPLE_PREFIX } from '../sample';
import { tr } from '../i18n';
import { tap } from '../native/platform';
import { useEffect, useRef, useState } from 'react';

export type GroupMode = 'date' | 'merchant';
const GM_KEY = 'zq.groupMode';
/** 记住用户选的归类方式（按日期 / 按商家） */
export function useGroupMode(): [GroupMode, (m: GroupMode) => void] {
  const [m, setM] = useState<GroupMode>(() => {
    try {
      return localStorage.getItem(GM_KEY) === 'merchant' ? 'merchant' : 'date';
    } catch {
      return 'date';
    }
  });
  return [
    m,
    (v) => {
      setM(v);
      try {
        localStorage.setItem(GM_KEY, v);
      } catch {}
    },
  ];
}

export function GroupModeSeg({ mode, onChange }: { mode: GroupMode; onChange: (m: GroupMode) => void }) {
  return (
    <div className="seg seg-sm" role="group" aria-label={tr('归类方式')}>
      <button aria-pressed={mode === 'date'} onClick={() => onChange('date')}>
        {tr('按日期')}
      </button>
      <button aria-pressed={mode === 'merchant'} onClick={() => onChange('merchant')}>
        {tr('按商家')}
      </button>
    </div>
  );
}
import type { Bill } from '../lib/types';
import type { BillGroup } from '../lib/groups';
import { billStatus, statusLabel } from '../lib/status';
import { formatBR, relativeDue, todayISO } from '../lib/dates';
import { formatBRL } from '../lib/money';
import { billTitle, categoryOf, isExpense, isReceivable } from '../lib/expense';
import { describeRepeat } from '../lib/recurrence';
import { useStore } from '../store';
import { useActions } from '../actions';
import { Modal } from './feedback';
import { BillCard } from './BillCard';
import { ICheck, IRepeat, IChevron, ICopy, ITrash, IUndo } from './icons';
import { colorSlot } from '../lib/colors';
import { isPartial, openCents, paidPct } from '../lib/payments';
import { amountOf } from '../lib/groups';
import type { Merchant } from '../lib/types';

/** 商家名首个字母或汉字（跳过「示例 ·」和数字） */
export function initialOf(name: string): string {
  const m = name.replace(SAMPLE_PREFIX, '').match(/[A-Za-zÀ-ÿ\u4e00-\u9fff]/);
  return (m?.[0] ?? name.slice(0, 1) ?? '?').toUpperCase();
}

/** 商家头像：圆形 + 商家识别色（与行内的方形日期块区分） */
export function MerchantAvatar({ merchant, name, bill, size = 'md' }: { merchant?: Merchant | null; name: string; bill?: Bill; size?: 'sm' | 'md' | 'lg' }) {
  const slot = colorSlot(merchant, merchant?.id ?? bill?.merchantId ?? name);
  const text = bill && isExpense(bill) ? categoryOf(bill.category)?.mark ?? tr('缴') : initialOf(name);
  return (
    <span className={`mav mav-${size} mc-${slot}`} aria-hidden="true">
      {text}
    </span>
  );
}

function useMerchantOf() {
  const { merchants } = useStore();
  return (b: Bill) => (b.merchantId ? merchants.find((m) => m.id === b.merchantId) ?? null : null);
}

const SWIPE_W = 204; // 左滑露出的操作区宽度（3 个按钮）
const SWIPE_EVT = 'zq-swipe-open';

/** 卡片里的一行账单：点开看详情，右侧一键标记已付；手机上左滑露出「已付 / 复制 / 删除」 */
export function BillRow({ bill, onOpen, selectable, selected, onToggle, sameTitle, amount, sub: subOverride, readOnly }: { bill: Bill; onOpen: (b: Bill) => void; selectable?: boolean; selected?: boolean; onToggle?: () => void; sameTitle?: boolean; amount?: number; sub?: string; readOnly?: boolean }) {
  const { today, settings, go } = useStore();
  const { markPaid, markUnpaid, removeBill } = useActions();
  const merchantOf = useMerchantOf();
  const st = billStatus(bill, today, settings.dueSoonDays);
  const title = billTitle(bill);
  const recv = isReceivable(bill);
  const [leaving, setLeaving] = useState(false);
  // 左滑：dx 为当前位移（0 ~ -SWIPE_W）
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touch = useRef<{ x: number; y: number; base: number; dir: 'h' | 'v' | null } | null>(null);
  const swiped = useRef(false);
  const cur = useRef(0);
  const canSwipe = !selectable && !readOnly;
  const open = dx < 0;
  useEffect(() => {
    // 同一时间只开一行
    const close = (e: Event) => (e as CustomEvent<string>).detail !== bill.id && setDx(0);
    window.addEventListener(SWIPE_EVT, close);
    return () => window.removeEventListener(SWIPE_EVT, close);
  }, [bill.id]);
  const pay = () => {
    void tap();
    setDx(0);
    setLeaving(true);
    setTimeout(() => {
      void markPaid(bill).finally(() => setLeaving(false));
    }, 160);
  };
  const onTouchStart = (e: React.TouchEvent) => {
    if (!canSwipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, base: dx, dir: null };
    cur.current = dx;
    swiped.current = false;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches[0];
    const mx = t.clientX - s.x;
    const my = t.clientY - s.y;
    if (!s.dir) {
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.2) {
        s.dir = 'h';
        setDragging(true);
        window.dispatchEvent(new CustomEvent(SWIPE_EVT, { detail: bill.id }));
      } else if (Math.abs(my) > 10) s.dir = 'v';
    }
    if (s.dir === 'h') {
      swiped.current = true;
      cur.current = Math.max(-SWIPE_W - 24, Math.min(0, s.base + mx));
      setDx(cur.current);
    }
  };
  const onTouchEnd = () => {
    const s = touch.current;
    touch.current = null;
    setDragging(false);
    if (s?.dir !== 'h') return;
    const x = cur.current;
    const opened = x < -SWIPE_W / 3 && !(s.base < 0 && x > s.base + 40);
    cur.current = opened ? -SWIPE_W : 0;
    setDx(cur.current);
    if (opened && s.base === 0) void tap();
  };
  const shortDate = (iso: string) => (iso.slice(0, 4) === today.slice(0, 4) ? formatBR(iso).slice(0, 5) : formatBR(iso));
  const paidText = bill.paidAt ? (recv ? tr('{0} 已收', formatBR(todayISO(new Date(bill.paidAt))).slice(0, 5)) : tr('{0} 已付', formatBR(todayISO(new Date(bill.paidAt))).slice(0, 5))) : '';
  const when = bill.paidAt ? paidText : relativeDue(bill.dueDate, today);
  const order = bill.orderNumber ? `#${bill.orderNumber}` : null;
  // 商家卡片：左边日期块就是到期日；标题写距离到期多久，下面写开单日（不再重复商家名和到期日）
  const main = sameTitle ? when : title;
  const sub = (sameTitle ? [tr('开单 {0}', shortDate(bill.billDate)), order] : [bill.paidAt ? paidText : `${shortDate(bill.dueDate)} · ${when}`, order]).filter(Boolean);
  const doneLabel = recv ? tr('已收款') : tr('已付款');
  const markLabel = recv ? tr('标记已收') : tr('标记已付');
  return (
    <div
      className={`brow st-${st} mc-${colorSlot(merchantOf(bill), merchantOf(bill)?.id ?? bill.merchantId ?? title)}${selected ? ' selected' : ''}${leaving ? ' leaving' : ''}${open ? ' swiping' : ''}${dragging ? ' dragging' : ''}`}
      style={open ? ({ '--sx': `${dx}px` } as React.CSSProperties) : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {selectable && <input type="checkbox" className="brow-check" checked={!!selected} onChange={onToggle} aria-label={tr('选择 {0}', title)} />}
      <button
        type="button"
        className="brow-main"
        onClick={() => {
          if (swiped.current) return void (swiped.current = false);
          if (open) return setDx(0);
          if (selectable) onToggle?.();
          else onOpen(bill);
        }}
        aria-label={tr('{0}，{1}{2}，{3}，到期 {4}', title, formatBRL(amount ?? amountOf(bill)), isPartial(bill) ? tr('（还差，账单共 {0}）', formatBRL(bill.totalCents)) : '', statusLabel(st, bill), formatBR(bill.dueDate))}
      >
        {sameTitle ? (
          <span className={`brow-day st-${st}`} aria-hidden="true">
            <b>{bill.dueDate.slice(8, 10)}</b>
            <i>{Number(bill.dueDate.slice(5, 7))}{tr('月')}</i>
          </span>
        ) : (
          <MerchantAvatar merchant={merchantOf(bill)} name={title} bill={bill} />
        )}
        <span className="brow-text">
          <span className={`brow-title${sameTitle ? ` when st-${st}` : ''}`}>
            {main}
            {bill.installment && <span className="tag">{tr('{0}/{1}期', bill.installment.index, bill.installment.count)}</span>}
            {bill.recurrence && (
              <span className="tag" title={describeRepeat(bill.recurrence)}>
                <IRepeat width={11} height={11} />
                {describeRepeat(bill.recurrence).split('，')[0]}
              </span>
            )}
            {bill.estimated && !bill.paidAt && <span className="tag warn">{tr('待确认')}</span>}
            {isPartial(bill) && <span className="tag warn">{recv ? tr('已收') : tr('已付')} {paidPct(bill)}%</span>}
          </span>
          <span className={`brow-sub${!sameTitle && st === 'overdue' ? ' err' : ''}`}>{subOverride ?? sub.join(' · ')}</span>
        </span>
        <span className="brow-amt num" title={isPartial(bill) ? tr('账单 {0}，还差 {1}', formatBRL(bill.totalCents), formatBRL(openCents(bill))) : undefined}>
          {formatBRL(amount ?? amountOf(bill))}
        </span>
      </button>
      {!selectable && !readOnly &&
        (bill.paidAt ? (
          <span className="brow-done" aria-label={doneLabel}>
            <ICheck />
          </span>
        ) : (
          <button type="button" className="brow-pay" aria-label={tr('{0}：{1}', markLabel, title)} title={markLabel} disabled={leaving} onClick={pay}>
            <ICheck />
          </button>
        ))}
      {open && (
        <div className="brow-tray" role="group" aria-label={tr('快捷操作')}>
          {bill.paidAt ? (
            <button type="button" className="tray-undo" onClick={() => { setDx(0); void markUnpaid(bill); }}>
              <IUndo />
              {recv ? tr('未收') : tr('未付')}
            </button>
          ) : (
            <button type="button" className="tray-pay" onClick={pay}>
              <ICheck />
              {recv ? tr('已收') : tr('已付')}
            </button>
          )}
          <button type="button" className="tray-copy" onClick={() => { setDx(0); go({ name: 'copy', id: bill.id }); }}>
            <ICopy />
            {tr('复制')}
          </button>
          <button type="button" className="tray-del" onClick={() => { setDx(0); void removeBill(bill); }}>
            <ITrash />
            {tr('删除')}
          </button>
        </div>
      )}
    </div>
  );
}

function GroupCard({ g, rowLimit, onOpen, selectable, selected, onToggle, onHead }: { g: BillGroup; rowLimit: number; onOpen: (b: Bill) => void; selectable?: boolean; selected?: Set<string>; onToggle?: (id: string) => void; onHead?: (g: BillGroup) => void }) {
  const { today } = useStore();
  const merchantOf = useMerchantOf();
  const [all, setAll] = useState(false);
  const shown = all ? g.bills : g.bills.slice(0, rowLimit);
  const hidden = g.bills.length - shown.length;
  const allSel = selectable && g.bills.every((b) => selected?.has(b.id));
  const first = g.bills[0];
  const m = g.sameTitle ? merchantOf(first) : null;
  const slot = g.sameTitle ? colorSlot(m, m?.id ?? first.merchantId ?? g.label) : null;
  const overdueN = g.bills.filter((b) => !b.paidAt && b.dueDate < today).length;
  return (
    <section className={`gcard tone-${g.tone}${slot != null ? ` by-merchant mc-${slot}` : ''}`} aria-label={tr('{0}，{1} 笔，{2}', g.label, g.bills.length, formatBRL(g.total))}>
      <div className={`gc-head${onHead && !selectable ? ' clickable' : ''}`} onClick={onHead && !selectable ? () => onHead(g) : undefined} role={onHead && !selectable ? 'button' : undefined} tabIndex={onHead && !selectable ? 0 : undefined} onKeyDown={onHead && !selectable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onHead(g)) : undefined}>
        {g.sameTitle && <MerchantAvatar merchant={m} name={g.label} bill={first} size="lg" />}
        <div className="gc-title">
          <span className="glabel">
            {g.label}
            <span className="gc-count num" title={tr('{0} 笔', g.bills.length)}>
              {g.bills.length}
            </span>
          </span>
          {g.sameTitle ? overdueN > 0 && <span className="gc-flag">{tr('逾期')} {overdueN}</span> : g.sub && <span className="gc-sub">{g.sub}</span>}
        </div>
        <span className="gc-total num">{formatBRL(g.total)}</span>
        {selectable && (
          <input
            type="checkbox"
            className="brow-check"
            aria-label={tr('全选 {0}', g.label)}
            checked={!!allSel}
            onChange={() => g.bills.forEach((b) => (allSel ? selected?.has(b.id) : !selected?.has(b.id)) && onToggle?.(b.id))}
          />
        )}
      </div>
      <div className="gc-body">
        {shown.map((b) => (
          <BillRow key={b.id} bill={b} sameTitle={g.sameTitle} onOpen={onOpen} selectable={selectable} selected={selected?.has(b.id)} onToggle={() => onToggle?.(b.id)} />
        ))}
      </div>
      {g.bills.length > rowLimit && (
        <button type="button" className={`gc-more${all ? ' open' : ''}`} onClick={() => setAll((v) => !v)}>
          {all ? tr('收起') : tr('还有 {0} 笔', hidden)}
          <IChevron width={14} height={14} />
        </button>
      )}
    </section>
  );
}

/** 卡片网格：每张卡片是一组（日期段或商家），卡片内是账单列表 */
export function GroupedBills({ groups, maxCards, rowLimit = 4, selectable, selected, onToggle, emptyNode, onHead }: { groups: BillGroup[]; maxCards?: number; rowLimit?: number; selectable?: boolean; selected?: Set<string>; onToggle?: (id: string) => void; emptyNode?: React.ReactNode; onHead?: (g: BillGroup) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const { bills, receivables } = useStore();
  const current = open ? bills.find((b) => b.id === open) ?? receivables.find((b) => b.id === open) ?? null : null;
  if (!groups.length) return <>{emptyNode ?? null}</>;
  const shown = maxCards ? groups.slice(0, maxCards) : groups;
  return (
    <>
      <div className="gcards">
        {shown.map((g) => (
          <GroupCard key={g.key} g={g} rowLimit={selectable ? Infinity : rowLimit} onOpen={(x) => setOpen(x.id)} selectable={selectable} selected={selected} onToggle={onToggle} onHead={onHead} />
        ))}
      </div>
      {current && (
        <Modal title={billTitle(current)} onClose={() => setOpen(null)}>
          <BillCard bill={current} inSheet onDone={() => setOpen(null)} />
        </Modal>
      )}
    </>
  );
}
