/**
 * 套餐与权限（前端与服务端共用，唯一来源）
 *  - 试用：注册后 30 天，基础功能全开 + AI 识别共 10 次
 *  - T1：R$ 7,99/月 或 R$ 79,90/年（年付约送 2 个月）—— 基础功能 + 关屏推送 + AI 识别 20 次/月
 *  - T2：R$ 19,90/月 或 R$ 199,00/年（年付约送 2 个月）—— T1 全部 + 导出记录（CSV/Excel）+ AI 识别 50 次/月
 *  - AI 加量包：R$ 4,90 = 20 次，不过期；月度额度用完后自动使用
 *  - 网页版：Mercado Pago 自动续费（卡），或 PIX 一次付清一年；App 版：App Store / Google Play 内购
 *  - 试用结束且没有订阅：只读（能看账单、标记已付；不能新增、编辑、识别）
 */
export const TRIAL = { days: 30, ai: 10 };
export const PLANS = {
  t1: { name: 'T1', month: 7.99, year: 79.9, ai: 20, push: true, export: false },
  t2: { name: 'T2', month: 19.9, year: 199.0, ai: 50, push: true, export: true },
};
/** AI 加量包（一次性购买，不过期） */
export const AI_PACK = { qty: 20, price: 4.9 };

/**
 * 商店商品 ID（App Store Connect / Google Play Console 里按这个创建）
 *  - App Store：一个订阅群组「账期助手」，4 个自动续期订阅 + 1 个消耗型商品
 *  - Google Play：2 个订阅（各有 monthly / yearly 两个基础方案）+ 1 个消耗型商品
 */
export const STORE = {
  apple: {
    't1.month': 'zq.t1.monthly',
    't1.year': 'zq.t1.yearly',
    't2.month': 'zq.t2.monthly',
    't2.year': 'zq.t2.yearly',
    ai_pack: 'zq.ai20',
  },
  google: {
    t1: 'zq_t1',
    t2: 'zq_t2',
    basePlan: { month: 'monthly', year: 'yearly' },
    ai_pack: 'zq_ai20',
  },
};

/** 商店商品 ID → 套餐（未知商品返回 null） */
export function planOfProduct(store, productId, basePlanId = null) {
  if (store === 'apple') {
    for (const [k, v] of Object.entries(STORE.apple)) {
      if (v !== productId || k === 'ai_pack') continue;
      const [plan, period] = k.split('.');
      return { plan, period };
    }
    return null;
  }
  const plan = productId === STORE.google.t1 ? 't1' : productId === STORE.google.t2 ? 't2' : null;
  if (!plan) return null;
  const period = basePlanId === STORE.google.basePlan.year ? 'year' : 'month';
  return { plan, period };
}

/** 多个来源的订阅里取最好的一条：T2 优先，同档取到期最晚 */
export function bestSub(subs, now = new Date()) {
  const t = now.getTime();
  const live = (subs || []).filter((s) => (s.plan === 't1' || s.plan === 't2') && ['active', 'grace', 'canceled'].includes(s.status) && s.until && Date.parse(s.until) > t);
  live.sort((a, b) => (a.plan === b.plan ? Date.parse(b.until) - Date.parse(a.until) : a.plan === 't2' ? -1 : 1));
  return live[0] ?? null;
}
export const PLAN_LABEL = { trial: '试用', t1: 'T1', t2: 'T2', owner: '管理员', expired: '已到期' };

/** 圣保罗时间的年月（AI 月度额度的周期） */
export function monthKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * 根据账号资料算出当前权限。
 * profile: { plan: 't1'|'t2'|'owner'|null, period, plan_until, trial_until }
 */
export function entitlement(profile, { email = '', owners = [], now = new Date(), plans = PLANS, trial = TRIAL } = {}) {
  const t = now.getTime();
  const trialUntil = profile?.trial_until ?? null;
  const planUntil = profile?.plan_until ?? null;
  const rawPlan = profile?.plan === 'pro' ? 't2' : profile?.plan;
  let plan;
  if (profile?.plan === 'owner' || (email && owners.includes(String(email).toLowerCase()))) plan = 'owner';
  else if ((rawPlan === 't1' || rawPlan === 't2') && ms(planUntil) > t) plan = rawPlan;
  else if (ms(trialUntil) > t) plan = 'trial';
  else plan = 'expired';
  const p = plan === 't1' || plan === 't2' ? plans[plan] : null;
  const features = {
    edit: plan !== 'expired',
    push: plan === 'owner' || !!p?.push,
    export: plan === 'owner' || !!p?.export,
  };
  const ai = plan === 'owner' ? { key: monthKey(now), limit: -1 } : p ? { key: monthKey(now), limit: p.ai } : plan === 'trial' ? { key: 'trial', limit: trial.ai } : { key: null, limit: 0 };
  const until = plan === 'trial' ? trialUntil : p ? planUntil : null;
  const daysLeft = until ? Math.max(0, Math.ceil((ms(until) - t) / 86400000)) : null;
  return { plan, period: p ? profile?.period ?? 'month' : null, trialUntil, planUntil, features, ai, daysLeft };
}

export function priceOf(plan, period, plans = PLANS) {
  const p = plans[plan];
  if (!p || (period !== 'month' && period !== 'year')) return null;
  return p[period];
}
