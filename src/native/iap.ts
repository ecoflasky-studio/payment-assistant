/**
 * App 内购（App Store / Google Play），用 @capgo/native-purchases（StoreKit 2 / Play Billing）。
 * 购买成功后把交易 ID / 购买令牌交给服务端，服务端去苹果 / 谷歌官方 API 核实后才开通（客户端结果不作数）。
 * appAccountToken 用账号的用户 ID（随机 UUID，不含个人信息），这样同一账号在网页、iPhone、安卓上通用，
 * 服务器通知来时也能找到是谁买的。
 */
import { STORE, PLANS, AI_PACK, type PlanId, type Period } from '../../shared/plans.mjs';
import { platform } from './platform';

export type ProductKey = `${PlanId}.${Period}` | 'ai_pack';
export interface StoreProduct {
  key: ProductKey;
  /** 商店里显示的本地价格（如 R$ 7,90）；拿不到时用我们的标价 */
  price: string;
}
export interface StorePurchase {
  store: 'apple' | 'google';
  productId: string;
  transactionId?: string;
  purchaseToken?: string;
}

const fallbackPrice = (k: ProductKey) => {
  const v = k === 'ai_pack' ? AI_PACK.price : PLANS[k.split('.')[0] as PlanId][k.split('.')[1] as Period];
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
};

async function plugin() {
  const m = await import('@capgo/native-purchases');
  return m;
}

const appleId = (k: ProductKey) => STORE.apple[k as keyof typeof STORE.apple];
const googleSub = (k: ProductKey) => (k === 'ai_pack' ? STORE.google.ai_pack : STORE.google[k.split('.')[0] as PlanId]);
const googlePlan = (k: ProductKey) => (k === 'ai_pack' ? undefined : STORE.google.basePlan[k.split('.')[1] as Period]);

export const ALL_KEYS: ProductKey[] = ['t1.month', 't1.year', 't2.month', 't2.year', 'ai_pack'];

/** 商店价格（失败时返回标价，不影响购买按钮显示） */
export async function loadProducts(): Promise<Record<ProductKey, StoreProduct>> {
  const out = Object.fromEntries(ALL_KEYS.map((k) => [k, { key: k, price: fallbackPrice(k) }])) as Record<ProductKey, StoreProduct>;
  try {
    const { NativePurchases, PURCHASE_TYPE } = await plugin();
    const ios = platform() === 'ios';
    const subIds = ios ? ALL_KEYS.filter((k) => k !== 'ai_pack').map(appleId) : [STORE.google.t1, STORE.google.t2];
    const [subs, inapp] = await Promise.all([
      NativePurchases.getProducts({ productIdentifiers: subIds, productType: PURCHASE_TYPE.SUBS }).catch(() => ({ products: [] })),
      NativePurchases.getProducts({ productIdentifiers: [ios ? STORE.apple.ai_pack : STORE.google.ai_pack], productType: PURCHASE_TYPE.INAPP }).catch(() => ({ products: [] })),
    ]);
    for (const p of [...(subs.products ?? []), ...(inapp.products ?? [])] as any[]) {
      if (ios) {
        const k = ALL_KEYS.find((x) => appleId(x) === p.identifier);
        if (k && p.priceString) out[k].price = p.priceString;
      } else if (p.identifier === STORE.google.ai_pack && p.priceString) out.ai_pack.price = p.priceString;
      // 安卓订阅的两个基础方案价格不同，插件只给一个；这里保留标价，购买页由 Google 显示实际价格
    }
  } catch {}
  return out;
}

export class PurchaseCancelled extends Error {}

/** 购买；返回给服务端核实用的凭证 */
export async function purchase(key: ProductKey, userId: string): Promise<StorePurchase> {
  const { NativePurchases, PURCHASE_TYPE } = await plugin();
  const ios = platform() === 'ios';
  const isPack = key === 'ai_pack';
  try {
    const r: any = await NativePurchases.purchaseProduct({
      productIdentifier: ios ? appleId(key) : googleSub(key),
      planIdentifier: ios ? undefined : googlePlan(key),
      productType: isPack ? PURCHASE_TYPE.INAPP : PURCHASE_TYPE.SUBS,
      quantity: 1,
      appAccountToken: userId,
      isConsumable: isPack && !ios ? false : undefined, // 安卓消耗型由服务端入账后再 consume，避免入账前就被消耗
    });
    return ios ? { store: 'apple', productId: appleId(key), transactionId: String(r.transactionId) } : { store: 'google', productId: googleSub(key), purchaseToken: String(r.purchaseToken ?? r.transactionId) };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/cancel|取消|USER_CANCELED|userCancelled/i.test(msg) || e?.code === 'USER_CANCELLED') throw new PurchaseCancelled('已取消');
    throw new Error(`购买没有完成：${msg}`);
  }
}

/** 恢复购买：列出这个商店账号的购买记录，交给服务端逐笔核实 */
export async function restore(userId: string): Promise<StorePurchase[]> {
  const { NativePurchases } = await plugin();
  const ios = platform() === 'ios';
  await NativePurchases.restorePurchases().catch(() => {});
  const { purchases } = (await NativePurchases.getPurchases({ appAccountToken: userId }).catch(() => NativePurchases.getPurchases({}))) as any;
  const list: StorePurchase[] = [];
  for (const p of purchases ?? []) {
    if (ios) {
      if (p.transactionId) list.push({ store: 'apple', productId: p.productIdentifier, transactionId: String(p.transactionId) });
    } else if (p.purchaseToken) list.push({ store: 'google', productId: p.productIdentifier, purchaseToken: String(p.purchaseToken) });
  }
  return list;
}

/** 打开系统的订阅管理（取消 / 更换套餐都在这里） */
export async function manageSubscriptions() {
  const { NativePurchases } = await plugin();
  await NativePurchases.manageSubscriptions();
}
