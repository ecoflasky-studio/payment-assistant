/**
 * 原生 App 的到期提醒：用系统「本地通知」，在手机上按账单直接排好时间（不需要服务器、离线也会响）。
 *  - 每笔未付账单：提醒日（到期前 N 天）09:00 一条，到期当天 09:00 一条
 *  - iOS 最多保留 64 条待发通知，这里只排最近的 60 条
 */
import type { Bill } from '../lib/types';
import { addDays } from '../lib/dates';
import { formatBRL } from '../lib/money';
import { openCents } from '../lib/payments';
import { billTitle } from '../lib/expense';
import { isNative } from './platform';

export interface PlannedNote {
  id: number;
  at: string; // ISO（圣保罗 09:00）
  title: string;
  body: string;
  billId: string;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h) % 2_000_000_000;
};
/** 圣保罗时间某天 09:00（UTC-3，巴西已取消夏令时） */
const at9 = (iso: string) => `${iso}T12:00:00.000Z`;

export function planReminders(bills: Bill[], today: string, nowMs: number, max = 60): PlannedNote[] {
  const out: PlannedNote[] = [];
  for (const b of bills) {
    if (b.paidAt || b.deletedAt || b.id.startsWith('sample') || openCents(b) <= 0) continue;
    const amt = formatBRL(openCents(b));
    const title = billTitle(b);
    const days = Math.max(0, b.reminderDays ?? 3);
    const pre = addDays(b.dueDate, -days);
    if (days > 0 && pre >= today) out.push({ id: hash(`${b.id}|pre`), at: at9(pre), title: `${days} 天后到期：${title}`, body: `${amt} · ${b.dueDate.split('-').reverse().join('/')} 到期`, billId: b.id });
    if (b.dueDate >= today) out.push({ id: hash(`${b.id}|due`), at: at9(b.dueDate), title: `今天到期：${title}`, body: `${amt}${b.orderNumber ? ` · #${b.orderNumber}` : ''}，付完记得在账期助手里标记已付`, billId: b.id });
  }
  return out.filter((n) => Date.parse(n.at) > nowMs).sort((a, b) => a.at.localeCompare(b.at)).slice(0, max);
}

let lastSig = '';
/** 重新排定所有提醒（账单变化后调用；内容没变就跳过） */
export async function syncReminders(bills: Bill[], today: string, enabled: boolean): Promise<'off' | 'denied' | number> {
  if (!isNative()) return 'off';
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const plan = enabled ? planReminders(bills, today, Date.now()) : [];
  const sig = JSON.stringify(plan.map((n) => [n.id, n.at, n.title, n.body]));
  if (sig === lastSig) return plan.length;
  if (enabled) {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return 'denied';
    }
  }
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
  if (plan.length)
    await LocalNotifications.schedule({
      notifications: plan.map((n) => ({ id: n.id, title: n.title, body: n.body, schedule: { at: new Date(n.at), allowWhileIdle: true }, extra: { url: '#/bills/unpaid', billId: n.billId } })),
    });
  lastSig = sig;
  return plan.length;
}

/** 点通知打开账单页 */
export async function onReminderTap(open: (hash: string) => void) {
  if (!isNative()) return;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  LocalNotifications.addListener('localNotificationActionPerformed', (e) => open(String(e.notification.extra?.url || '#/bills/unpaid')));
}
