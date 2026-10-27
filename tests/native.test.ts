import { describe, it, expect } from 'vitest';
import { planReminders } from '../src/native/reminders';
import { planOfProduct, bestSub, STORE } from '../shared/plans.mjs';
import type { Bill } from '../src/lib/types';

const bill = (o: Partial<Bill>): Bill => ({ id: 'b', merchantId: null, merchantNameSnapshot: 'Loja', orderNumber: '12', billDate: '2026-10-01', dueDate: '2026-11-05', accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: [], totalCents: 15000, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1, ...o } as Bill);

describe('原生 App：本地到期提醒', () => {
  const now = Date.parse('2026-10-27T15:00:00Z');
  it('提醒日 09:00 + 到期当天 09:00（圣保罗）；已付、示例、已过时间的不排', () => {
    const plan = planReminders([bill({ id: 'a' }), bill({ id: 'paid', paidAt: '2026-10-20T00:00:00Z' }), bill({ id: 'sample-x' }), bill({ id: 'old', dueDate: '2026-10-27', reminderDays: 0 })], '2026-10-27', now);
    expect(plan.map((n) => [n.billId, n.at])).toEqual([
      ['a', '2026-11-02T12:00:00.000Z'],
      ['a', '2026-11-05T12:00:00.000Z'],
    ]);
    expect(plan[0].title).toBe('3 天后到期：Loja');
    expect(plan[1].body).toMatch(/R\$\s?150,00 · #12/);
    expect(new Set(plan.map((n) => n.id)).size).toBe(2);
  });
  it('最多 60 条（iOS 限制 64 条待发通知），按时间先后', () => {
    const many = Array.from({ length: 50 }, (_, i) => bill({ id: `b${i}`, dueDate: `2026-12-${String((i % 28) + 1).padStart(2, '0')}` }));
    const plan = planReminders(many, '2026-10-27', now);
    expect(plan).toHaveLength(60);
    expect([...plan].sort((a, b) => a.at.localeCompare(b.at))).toEqual(plan);
  });
});

describe('商店商品对应套餐', () => {
  it('Apple / Google 商品 ID → 套餐与周期', () => {
    expect(planOfProduct('apple', STORE.apple['t2.year'])).toEqual({ plan: 't2', period: 'year' });
    expect(planOfProduct('apple', STORE.apple.ai_pack)).toBeNull();
    expect(planOfProduct('google', 'zq_t1', 'yearly')).toEqual({ plan: 't1', period: 'year' });
    expect(planOfProduct('google', 'zq_t2', 'monthly')).toEqual({ plan: 't2', period: 'month' });
    expect(planOfProduct('google', 'zq_x')).toBeNull();
  });
  it('多来源取最好：T2 优先，其次到期最晚；过期 / 撤销 / 待支付不算', () => {
    const now = new Date('2026-10-27T00:00:00Z');
    const subs = [
      { id: 'a', plan: 't1', until: '2027-10-01T00:00:00Z', status: 'active' },
      { id: 'b', plan: 't2', until: '2026-11-01T00:00:00Z', status: 'canceled' },
      { id: 'c', plan: 't2', until: '2027-01-01T00:00:00Z', status: 'revoked' },
      { id: 'd', plan: 't2', until: null, status: 'pending' },
    ];
    expect(bestSub(subs, now)!.id).toBe('b');
    expect(bestSub(subs.filter((s) => s.id !== 'b'), now)!.id).toBe('a');
    expect(bestSub([], now)).toBeNull();
  });
});
