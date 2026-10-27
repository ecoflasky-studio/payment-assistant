/**
 * 付费：套餐选择、AI 加量包。
 *  - 网页版：Mercado Pago（信用卡自动续费，或 PIX 一次付清一年；加量包 PIX / 卡）
 *  - App 版：App Store / Google Play 内购（苹果和谷歌规定 App 内只能用商店付款）
 * 同一个账号在哪里买的都通用；以服务端核实后的结果为准。
 */
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { buyOnce, startCheckout, verifyPurchases, ApiError, type AccountInfo } from '../cloud/api';
import { AuthError } from '../cloud/auth';
import { PLANS, AI_PACK, type PlanId, type Period } from '../../shared/plans.mjs';
import { formatBRL } from '../lib/money';
import { isNative, platform, openExternal, storeName } from '../native/platform';
import { loadProducts, purchase, restore, manageSubscriptions, PurchaseCancelled, type ProductKey, type StoreProduct } from '../native/iap';
import { ICheck, IBolt } from '../ui/icons';

const brl = (v: number) => formatBRL(Math.round(v * 100));
const SOURCE_LABEL: Record<string, string> = { mp: '网页（Mercado Pago 自动续费）', pix: '网页（PIX 年付）', apple: 'App Store', google: 'Google Play' };
export const sourceLabel = (s?: string | null) => (s ? SOURCE_LABEL[s] ?? s : '');

const FEATURE_ROWS: { label: string; t1: boolean | string; t2: boolean | string }[] = [
  { label: '账期、缴费、对账、报表、提醒、多设备同步', t1: true, t2: true },
  { label: 'PDF 直读、本机 OCR、日历提醒', t1: true, t2: true },
  { label: '到期推送提醒（锁屏也能收到）', t1: true, t2: true },
  { label: 'AI 识别（每月）', t1: `${PLANS.t1.ai} 次`, t2: `${PLANS.t2.ai} 次` },
  { label: '导出记录（CSV / Excel）', t1: false, t2: true },
];

/** 隐私政策 / 使用条款网址（App 里需要绝对网址） */
export function legalUrl(kind: 'privacy' | 'terms', site?: string) {
  const file = `legal/${kind}.html`;
  if (site) return site + file;
  if (typeof location !== 'undefined' && /^https?:/.test(location.protocol)) return new URL(file, location.href).toString();
  return `https://ecoflasky-studio.github.io/payment-assistant/${file}`;
}

function useBuy() {
  const { cloud, getToken, auth, setAccount } = useStore();
  const fb = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, fn: (token: string) => Promise<void>) => {
    if (!cloud) return fb.toast('没有连接账号服务', { bad: true });
    setBusy(label);
    try {
      const token = await getToken();
      if (!token || !auth.session) throw new ApiError(401, '请先登录账号');
      await fn(token);
    } catch (e) {
      if (!(e instanceof PurchaseCancelled)) fb.toast(e instanceof ApiError || e instanceof AuthError ? e.message : (e as Error).message, { bad: true });
    } finally {
      setBusy(null);
    }
  };
  /** 原生内购：买完交给服务端核实 */
  const buyNative = (key: ProductKey) =>
    run(key, async (token) => {
      const p = await purchase(key, auth.session!.user.id);
      const r = await verifyPurchases(cloud!, token, p.store, [p]);
      setAccount(r.me);
      celebrate(r.me, key);
    });
  const celebrate = (a: AccountInfo, key: ProductKey) => {
    fb.celebrate();
    fb.toast(key === 'ai_pack' ? `已加 ${AI_PACK.qty} 次 AI 识别（共剩 ${a.usage.bonus ?? 0} 次加量）` : `已开通 ${a.plan === 't2' ? 'T2' : 'T1'}，感谢支持！`);
  };
  return { busy, run, buyNative };
}

export function Pricing({ compact = false }: { compact?: boolean }) {
  const { cloud, ent, auth, publicConfig, setAccount } = useStore();
  const fb = useFeedback();
  const native = isNative();
  const acc = auth.account;
  const [period, setPeriod] = useState<Period>('year');
  const [prices, setPrices] = useState<Record<ProductKey, StoreProduct> | null>(null);
  const { busy, run, buyNative } = useBuy();
  const storeOn = native ? !!acc?.billing?.stores?.[platform() === 'ios' ? 'apple' : 'google'] : false;
  const webOn = !native && !!acc?.billing?.web;
  useEffect(() => {
    if (native) void loadProducts().then(setPrices);
  }, [native]);
  const priceText = (p: PlanId) => (native && prices ? prices[`${p}.${period}`].price : brl(PLANS[p][period]));
  const months = (p: PlanId) => Math.round((PLANS[p].month * 12 - PLANS[p].year) / PLANS[p].month);
  const returnUrl = () => `${location.origin}${location.pathname}?mp=1`;

  const webSubscribe = (plan: PlanId) =>
    run(`web ${plan}`, async (token) => {
      const { url } = await startCheckout(cloud!, token, plan, period, returnUrl());
      location.href = url;
    });
  const webPix = (plan: PlanId) =>
    run(`pix ${plan}`, async (token) => {
      const { url } = await buyOnce(cloud!, token, 'pix_year', returnUrl(), plan);
      location.href = url;
    });
  const doRestore = () =>
    run('restore', async (token) => {
      const list = await restore(auth.session!.user.id);
      if (!list.length) {
        fb.toast(`这个 ${storeName()} 账号没有找到购买记录`);
        return;
      }
      const r = await verifyPurchases(cloud!, token, list[0].store, list);
      setAccount(r.me);
      fb.toast(r.me.plan === 't1' || r.me.plan === 't2' ? `已恢复 ${r.me.plan.toUpperCase()}` : '已检查购买记录，没有有效订阅');
    });

  const current = (p: PlanId) => ent?.plan === p;
  const sameAuto = (p: PlanId) => current(p) && ent?.period === period && !!acc?.autoRenew;
  const otherSource = native && acc?.source && (acc.source === 'mp' || acc.source === 'pix' || (platform() === 'ios' ? acc.source === 'google' : acc.source === 'apple'));

  return (
    <div className="stack">
      <div className="seg seg-sm" role="group" aria-label="付款周期" style={{ alignSelf: 'center' }}>
        <button aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>
          月付
        </button>
        <button aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>
          年付 · 送 2 个月
        </button>
      </div>
      <div className="plans">
        {(['t1', 't2'] as PlanId[]).map((p) => (
          <div key={p} className={`plan${p === 't2' ? ' hot' : ''}${current(p) ? ' current' : ''}`}>
            <div className="row between">
              <b className="plan-name">{PLANS[p].name}</b>
              {p === 't2' && !current(p) && <span className="pill brand">最划算</span>}
              {current(p) && <span className="pill paid">当前</span>}
            </div>
            <div className="plan-price">
              <b className="num">{priceText(p)}</b>
              <span className="small muted">/{period === 'year' ? '年' : '月'}</span>
            </div>
            {period === 'year' && <span className="xs muted">相当于 {brl(PLANS[p].year / 12)}/月，比月付省 {months(p)} 个月</span>}
            {!compact && (
              <ul className="plan-feats small">
                {FEATURE_ROWS.map((f) => {
                  const v = f[p];
                  return (
                    <li key={f.label} className={v ? '' : 'off'}>
                      {v ? <ICheck width={14} height={14} /> : <span aria-hidden="true">—</span>} {f.label}
                      {typeof v === 'string' ? <b> {v}</b> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {native ? (
              <button className={`btn ${p === 't2' ? 'btn-primary' : ''}`} disabled={!!busy || !storeOn || sameAuto(p)} onClick={() => buyNative(`${p}.${period}`)}>
                {busy === `${p}.${period}` ? <span className="spin" /> : null}
                {sameAuto(p) ? '已订阅' : current(p) ? `改为${period === 'year' ? '年付' : '月付'}` : ent?.plan === 't1' && p === 't2' ? '升级到 T2' : `订阅 ${PLANS[p].name}`}
              </button>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <button className={`btn ${p === 't2' ? 'btn-primary' : ''}`} disabled={!!busy || !webOn || (sameAuto(p) && acc?.source === 'mp')} onClick={() => webSubscribe(p)}>
                  {busy === `web ${p}` ? <span className="spin" /> : null}
                  {sameAuto(p) && acc?.source === 'mp' ? '已订阅' : ent?.plan === 't1' && p === 't2' ? '升级到 T2（卡，自动续费）' : `订阅 ${PLANS[p].name}（卡，自动续费）`}
                </button>
                {period === 'year' && (
                  <button className="btn btn-soft" disabled={!!busy || !webOn} onClick={() => webPix(p)}>
                    {busy === `pix ${p}` ? <span className="spin" /> : null}
                    PIX 一次付清 1 年
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {otherSource && <p className="xs muted" style={{ textAlign: 'center', margin: 0 }}>你的套餐已在其他平台开通，在这里可以直接使用。</p>}
      {native ? (
        <StoreTerms site={publicConfig?.site} onRestore={doRestore} busy={busy === 'restore'} storeOn={storeOn} />
      ) : (
        <span className="xs muted" style={{ textAlign: 'center' }}>
          {webOn ? '卡付款自动续费，可随时取消，已付期间照常可用；PIX 年付一次付清，不会自动续费。也可以在 iPhone / 安卓 App 里订阅，同一账号通用。' : '订阅收款暂未开放，请联系管理员。'}
        </span>
      )}
    </div>
  );
}

/** 商店规定：订阅说明 + 恢复购买 + 条款链接（App 内必须展示） */
function StoreTerms({ site, onRestore, busy, storeOn }: { site?: string; onRestore: () => void; busy: boolean; storeOn: boolean }) {
  const ios = platform() === 'ios';
  return (
    <div className="stack storeterms" style={{ gap: 6 }}>
      {!storeOn && <div className="banner warn small">商店付款还没开通，请稍后再试。</div>}
      <p className="xs muted" style={{ margin: 0 }}>
        订阅通过 {ios ? '你的 Apple 账户' : 'Google Play'} 付款，到期自动续订同样的周期和价格，除非在当前周期结束前至少 24 小时关闭自动续订。可随时在{ios ? '「设置 → Apple 账户 → 订阅」' : ' Google Play 的「付款和订阅」'}里管理或取消。
      </p>
      <div className="row" style={{ justifyContent: 'center', gap: 4, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onRestore}>
          {busy ? <span className="spin" /> : null}
          恢复购买
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void manageSubscriptions().catch(() => {})}>
          管理订阅
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void openExternal(legalUrl('terms', site))}>
          使用条款
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void openExternal(legalUrl('privacy', site))}>
          隐私政策
        </button>
      </div>
    </div>
  );
}

/** AI 加量包 */
export function PackCard() {
  const { cloud, auth, ent } = useStore();
  const native = isNative();
  const [price, setPrice] = useState(brl(AI_PACK.price));
  const { busy, run, buyNative } = useBuy();
  const acc = auth.account;
  const on = native ? !!acc?.billing?.stores?.[platform() === 'ios' ? 'apple' : 'google'] : !!acc?.billing?.web;
  useEffect(() => {
    if (native) void loadProducts().then((p) => setPrice(p.ai_pack.price));
  }, [native]);
  if (!acc?.billing || ent?.plan === 'owner') return null;
  const bonus = acc.usage.bonus ?? 0;
  return (
    <section className="card row packcard" aria-labelledby="h-pack">
      <span className="packicon" aria-hidden="true">
        <IBolt />
      </span>
      <span className="grow stack" style={{ gap: 2 }}>
        <b id="h-pack">AI 加量包 · {AI_PACK.qty} 次</b>
        <span className="xs muted">月度次数用完后自动使用，不过期{bonus ? ` · 现在还剩 ${bonus} 次` : ''}</span>
      </span>
      <button
        className="btn btn-primary btn-sm"
        disabled={!!busy || !on || ent?.plan === 'expired'}
        onClick={() =>
          native
            ? buyNative('ai_pack')
            : run('pack', async (token) => {
                const { url } = await buyOnce(cloud!, token, 'ai_pack', `${location.origin}${location.pathname}?mp=1`);
                location.href = url;
              })
        }
      >
        {busy ? <span className="spin" /> : null}
        {price}
      </button>
    </section>
  );
}
